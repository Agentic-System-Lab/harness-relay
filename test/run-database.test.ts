import { spawn, spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { openRunDatabase, openSqliteFile, plainDatabaseFiles, readRunDatabase, runDatabaseReadsLeft } from '../src/server/db';

/*
 * An open agent's own SQLite database (OpenCode's, Goose's) is in its state folder, which a run's
 * commands may write: reading it must never hold up the server, whatever a command put there.
 */

const dir = mkdtempSync(join(tmpdir(), 'relay-run-db-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

function database(sql: string): string {
  const file = join(dir, `db-${++n}.db`);
  const db = openSqliteFile(file);
  db.exec(sql);
  db.close();
  return file;
}

describe("reading a run's database", () => {
  it('reads the tables that are there, and runs each query only where its tables are', async () => {
    const file = database("CREATE TABLE a (id TEXT, n INTEGER); INSERT INTO a VALUES ('x', 1), ('y', 2);");
    const read = await readRunDatabase(file, ['a', 'b'], [
      { sql: 'SELECT id, n FROM a WHERE n > ? ORDER BY id', params: [0], needs: ['a'] },
      { sql: 'SELECT * FROM b', needs: ['b'] },
      { sql: 'SELECT count(*) AS c FROM a', needs: ['a'], unless: ['b'] },
    ]);
    expect(read).toEqual({
      present: new Set(['a']),
      results: [[{ id: 'x', n: 1 }, { id: 'y', n: 2 }], null, [{ c: 2 }]],
    });
    // Read-only: a write fails, and the read with it.
    expect(await readRunDatabase(file, ['a'], [{ sql: "INSERT INTO a VALUES ('z', 3) RETURNING id" }])).toBeUndefined();
    expect((await readRunDatabase(file, ['a'], [{ sql: 'SELECT count(*) AS c FROM a' }]))!.results[0]).toEqual([{ c: 2 }]);
  });

  it('says nothing for a database it cannot read, or a view in place of a table', async () => {
    expect(await readRunDatabase(join(dir, 'missing.db'), ['a'], [{ sql: 'SELECT 1' }])).toBeUndefined();
    const notOne = join(dir, `db-${++n}.db`);
    writeFileSync(notOne, 'not a database');
    expect(await readRunDatabase(notOne, ['a'], [{ sql: 'SELECT 1' }])).toBeUndefined();
    const viewed = database('CREATE VIEW a AS WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT i FROM r;');
    expect(await readRunDatabase(viewed, ['a'], [{ sql: 'SELECT count(*) FROM a', needs: ['a'] }])).toBeUndefined();
  });

  it('gives up on a read that does not end in time, while the server goes on', async () => {
    // A read that takes seconds (as one of a table a command made very large would).
    const slow = database('CREATE TABLE a (id INTEGER);');
    const long = 'WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 10000000) SELECT count(*) AS c FROM r';
    let ticks = 0;
    const tick = setInterval(() => ticks++, 10);
    const started = Date.now();
    const read = await readRunDatabase(slow, ['a'], [{ sql: long, needs: ['a'] }], 100);
    clearInterval(tick);
    expect(read).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    // The event loop kept running while the worker read.
    expect(ticks).toBeGreaterThan(5);
  });

  it('refuses a generated column in a table it reads, and starts no second read of a database while one has not answered', async () => {
    const generated = database("CREATE TABLE a (id TEXT, v TEXT GENERATED ALWAYS AS (upper(id)) VIRTUAL); INSERT INTO a (id) VALUES ('x');");
    expect(await readRunDatabase(generated, ['a'], [{ sql: 'SELECT id FROM a', needs: ['a'] }])).toBeUndefined();
    const slow = database('CREATE TABLE a (id INTEGER);');
    const long = 'WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 10000000) SELECT count(*) AS c FROM r';
    const first = readRunDatabase(slow, ['a'], [{ sql: long, needs: ['a'] }], 100);
    expect(await readRunDatabase(slow, ['a'], [{ sql: 'SELECT 1 AS one' }])).toBeUndefined();
    expect(await first).toBeUndefined();
    // Given up on, it still holds the database's place until it ends.
    expect(runDatabaseReadsLeft()).toBeGreaterThan(0);
    expect(await readRunDatabase(slow, ['a'], [{ sql: 'SELECT 1 AS one' }])).toBeUndefined();
    // Once it has ended, the database is read again.
    await expect.poll(async () => (await readRunDatabase(slow, ['a'], [{ sql: 'SELECT 1 AS one' }]))?.results[0], { timeout: 60_000, interval: 250 }).toEqual([{ one: 1 }]);
  }, 90_000);

  // Links need a privilege on Windows, and named pipes are made with mkfifo.
  it.skipIf(process.platform === 'win32')('never opens a link or a named pipe, as the database or a journal beside it', async () => {
    const real = database('CREATE TABLE a (id TEXT);');
    const link = join(dir, `db-${++n}.db`);
    symlinkSync(real, link);
    expect(plainDatabaseFiles(link)).toBe(false);
    expect(await readRunDatabase(link, ['a'], [{ sql: 'SELECT 1' }])).toBeUndefined();
    const pipe = join(dir, `db-${++n}.db`);
    spawnSync('mkfifo', [pipe]);
    expect(await readRunDatabase(pipe, ['a'], [{ sql: 'SELECT 1' }], 2_000)).toBeUndefined();
    spawnSync('mkfifo', [`${real}-wal`]);
    expect(plainDatabaseFiles(real)).toBe(false);
    expect(await readRunDatabase(real, ['a'], [{ sql: 'SELECT 1' }], 2_000)).toBeUndefined();
    expect(() => openRunDatabase(real)).toThrow(/not a plain file/);
  });
});

describe('the server leaving with a read that never ends', () => {
  it('ends the process anyway, once its own work is done', async () => {
    // A read that goes on for minutes (as one blocked in SQLite or in opening a named pipe swapped in
    // after the check would, for ever): Node would wait for its worker on the way out.
    const slow = database('CREATE TABLE a (id INTEGER);');
    const long = 'WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 100000000000) SELECT count(*) AS c FROM r';
    const script = join(dir, 'leave.mts');
    const db = pathToFileURL(resolve('src/server/db.ts')).href;
    writeFileSync(
      script,
      `import { exitAfterRunDatabaseReads, readRunDatabase, runDatabaseReadsLeft } from ${JSON.stringify(db)};
       const read = await readRunDatabase(${JSON.stringify(slow)}, ['a'], [{ sql: ${JSON.stringify(long)}, needs: ['a'] }], 200);
       console.log('read', read === undefined, runDatabaseReadsLeft());
       await exitAfterRunDatabaseReads(0, 200);`,
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const ended = await new Promise<{ code: number | null; signal: string | null }>((done) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done({ code: null, signal: 'timeout' });
      }, 20_000);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        done({ code, signal });
      });
    });
    expect(out).toContain('read true 1');
    // On Windows a killed process has no signal, only its exit code.
    expect(ended.signal === 'SIGKILL' || (process.platform === 'win32' && ended.code !== null)).toBe(true);
  }, 30_000);
});

describe("opening a run's database to take things out of it", () => {
  it('refuses a rollback journal left over, and a generated column', () => {
    const hot = database('CREATE TABLE a (id TEXT);');
    expect(plainDatabaseFiles(hot, true)).toBe(true);
    // An empty journal is not played back; one with anything in it would be.
    writeFileSync(`${hot}-journal`, '');
    expect(plainDatabaseFiles(hot, true)).toBe(true);
    writeFileSync(`${hot}-journal`, 'x');
    expect(plainDatabaseFiles(hot)).toBe(true);
    expect(() => openRunDatabase(hot)).toThrow(/left over/);
    const generated = database('CREATE TABLE a (id TEXT, v TEXT GENERATED ALWAYS AS (upper(id)) VIRTUAL);');
    expect(() => openRunDatabase(generated)).toThrow(/generated column/);
    // An index on an expression, or with a condition: run on every write.
    expect(() => openRunDatabase(database('CREATE TABLE a (id TEXT); CREATE INDEX i ON a (upper(id));'))).toThrow(/an index on an expression/);
    expect(() => openRunDatabase(database("CREATE TABLE a (id TEXT); CREATE INDEX i ON a (id) WHERE id > 'm';"))).toThrow(/an index on an expression/);
    // A plain index is fine, and a check is not run on the server's writes.
    const checked = database("CREATE TABLE a (id TEXT CHECK (id IS NOT NULL), p TEXT); CREATE INDEX i ON a (p); INSERT INTO a VALUES ('x', 'y');");
    const c = openRunDatabase(checked);
    c.exec('UPDATE a SET id = NULL');
    expect(c.prepare('SELECT id FROM a').get()).toEqual({ id: null });
    c.close();
    // A write-ahead log larger than the CLIs leave (SQLite reads it all on opening).
    const big = database('CREATE TABLE a (id TEXT);');
    const wal = openSync(`${big}-wal`, 'w');
    ftruncateSync(wal, 1024 * 1024 * 1024 + 1);
    closeSync(wal);
    expect(plainDatabaseFiles(big)).toBe(true);
    expect(() => openRunDatabase(big)).toThrow(/too large/);
    rmSync(`${big}-wal`);
    // Its own planted triggers and views are dropped, as before.
    const planted = database("CREATE TABLE a (id TEXT); CREATE VIEW v AS SELECT * FROM a; CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;");
    const db = openRunDatabase(planted);
    expect(db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type IN ('view', 'trigger')").get()).toEqual({ c: 0 });
    db.close();
  });
});
