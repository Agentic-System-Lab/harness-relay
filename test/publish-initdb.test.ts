import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withLang } from '../src/server/i18n';
import { pgUri } from './pgUri';
import type { SpawnResult } from '../src/server/process';
import type { Docker } from '../src/server/previewDocker';
import {
  checkInitScript,
  MAX_SCRIPT,
  PSQL_IMAGE,
  psqlArgs,
  PSQL_SCRIPT,
  runInitScripts,
  scriptKey,
  splitPassword,
} from '../src/server/publish/initdb';

const ok = (o: Partial<SpawnResult> = {}) =>
  ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, ...o }) as SpawnResult;

describe("a compose file's init scripts on Neon", () => {
  it("runs psql from PostgreSQL's official image pinned by digest, never the compose file's, as unprivileged as psql allows", () => {
    expect(PSQL_IMAGE).toMatch(/^docker\.io\/library\/postgres@sha256:[0-9a-f]{64}$/);
    expect(psqlArgs('relay-1', 'harness-relay-init-1')).toEqual([
      'run',
      '--rm',
      '-i',
      '--name',
      'harness-relay-init-1',
      '--label',
      'io.harness-relay.publish.owner=relay-1',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      '65534:65534',
      '--memory',
      '256m',
      '--pids-limit',
      '64',
      '--entrypoint',
      '/bin/sh',
      PSQL_IMAGE,
      '-c',
      PSQL_SCRIPT,
    ]);
  });

  it('hands psql the script as one -c string after a comment, and the password apart from the address', () => {
    // The address without its password, then the password (into PGPASSWORD), from stdin; the script from the rest.
    expect(PSQL_SCRIPT).toMatch(
      /^IFS= read -r PGURI \|\| exit 64; IFS= read -r PGPASSWORD \|\| exit 64; export PGPASSWORD; SQL=\$\(cat\) \|\| exit 65; exec psql "\$PGURI" /,
    );
    expect(PSQL_SCRIPT).toContain('-v ON_ERROR_STOP=1');
    // psql reads a -c string beginning with a backslash as one of its own commands: a comment comes first.
    expect(PSQL_SCRIPT).toMatch(/ -c "-- [^\n"]*\n\$SQL"$/);
    expect(PSQL_SCRIPT).not.toContain(' -f ');
    expect(() => splitPassword(pgUri('bad%zz', 'ep-1.neon.test', '/todo'))).toThrow(expect.objectContaining({ status: 502 }));
    expect(splitPassword(pgUri('p%40ss', 'ep-1.neon.test'))).toEqual({
      uri: 'postgresql://todo@ep-1.neon.test/todo?sslmode=require',
      password: 'p@ss',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'gives psql, run by the real shell, the address without its password, the password in its environment, and the script verbatim after the comment',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'relay-psql-stub-'));
      try {
        // A psql that writes down what it got.
        writeFileSync(
          join(dir, 'psql'),
          `#!/bin/sh\nexec node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), password: process.env.PGPASSWORD }))' "${join(dir, 'got.json')}" "$@"\n`,
          { mode: 0o755 },
        );
        const sql = 'SELECT \'$(id)\', `id`, $$ \\! id $$;\n\\! echo not a command here\n-- "quoted" end';
        const r = spawnSync('/bin/sh', ['-c', PSQL_SCRIPT], {
          input: 'postgresql://todo@ep-1.neon.test/todo?sslmode=require\nhunter2\n' + sql + '\n',
          env: { PATH: dir + ':' + dirname(process.execPath) + ':/usr/bin:/bin' },
        });
        expect(r.status, String(r.stderr)).toBe(0);
        const got = JSON.parse(readFileSync(join(dir, 'got.json'), 'utf8')) as { args: string[]; password: string };
        expect(got.password).toBe('hunter2');
        expect(got.args).toEqual([
          'postgresql://todo@ep-1.neon.test/todo?sslmode=require',
          '-X',
          '-q',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          '-- Harness Relay: an init script\n' + sql,
        ]);
        expect(got.args.join(' ')).not.toContain('hunter2');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('gives each script not yet run, in order, after the address and password; records each that committed; stops at the first that fails, saying which', async () => {
    const runs: { args: string[]; stdin: string }[] = [];
    let n = 0;
    const docker = vi.fn(
      async () =>
        (async (args: string[], o?: { stdin?: string | Buffer }) => {
          runs.push({ args, stdin: String(o?.stdin) });
          return ++n === 2 ? ok({ code: 1, stderr: 'ERROR:  syntax error at or near "CRAETE"' }) : ok();
        }) as Docker,
    );
    const uri = pgUri('pw', 'ep-1.neon.test');
    const scripts = [
      { name: 'db/00.sql', sql: Buffer.from('SELECT 0;') },
      { name: 'db/01.sql', sql: Buffer.from('CREATE TABLE a ();') },
      { name: 'db/02.sql', sql: Buffer.from('CRAETE TABLE b ();') },
      { name: 'db/03.sql', sql: Buffer.from('SELECT 1;') },
    ];
    const done: string[] = [];
    await withLang('en', () =>
      expect(
        runInitScripts(uri, scripts, 'relay', undefined, docker, [scriptKey(scripts[0]!)], (key) => done.push(key)),
      ).rejects.toMatchObject({
        status: 502,
        message: expect.stringMatching(/^Running db\/02\.sql on Neon failed: .*syntax error/),
      }),
    );
    const login = 'postgresql://todo@ep-1.neon.test/todo?sslmode=require\npw\n';
    expect(runs.map((r) => r.stdin)).toEqual([login + 'CREATE TABLE a ();', login + 'CRAETE TABLE b ();']);
    expect(done).toEqual([scriptKey(scripts[1]!)]);
    expect(runs[0]!.args).toContain(PSQL_IMAGE);
    expect(runs[0]!.args.join(' ')).not.toContain(':pw');
    // A script added before those that ran runs too; one changed after it ran is refused.
    runs.length = 0;
    n = 10;
    const added = [{ name: 'db/000.sql', sql: Buffer.from('CREATE EXTENSION x;') }, ...scripts];
    await runInitScripts(uri, added, 'relay', undefined, docker, [scriptKey(scripts[0]!), scriptKey(scripts[1]!)]);
    expect(runs.map((r) => r.stdin.split('\n').pop())).toEqual(['CREATE EXTENSION x;', 'CRAETE TABLE b ();', 'SELECT 1;']);
    const changed = [{ name: 'db/00.sql', sql: Buffer.from('SELECT 42;') }];
    await withLang('en', () =>
      expect(runInitScripts(uri, changed, 'relay', undefined, docker, [scriptKey(scripts[0]!)])).rejects.toThrow(
        'db/00.sql changed after it ran',
      ),
    );
  });

  it('removes the container of a run that was stopped or timed out, so that psql stops too', async () => {
    const calls: string[][] = [];
    const docker = vi.fn(
      async () =>
        (async (args: string[]) => {
          calls.push(args);
          return args[0] === 'run' ? ok({ code: null, timedOut: true }) : ok();
        }) as Docker,
    );
    await expect(
      runInitScripts('postgresql://a:b@h/d', [{ name: 'a.sql', sql: Buffer.from('SELECT pg_sleep(999);') }], 'relay', undefined, docker),
    ).rejects.toMatchObject({ status: 502 });
    const name = calls[0]![calls[0]!.indexOf('--name') + 1]!;
    expect(name).toMatch(/^harness-relay-init-[0-9a-f]{16}$/);
    expect(calls[1]).toEqual(['rm', '-f', name]);
  });

  it('starts no container without scripts left, and refuses an address that could end its first line early', async () => {
    const docker = vi.fn();
    const one = { name: 'a.sql', sql: Buffer.from('SELECT 1;') };
    await runInitScripts('postgresql://x', [], 'relay', undefined, docker);
    await runInitScripts('postgresql://x', [one], 'relay', undefined, docker, [scriptKey(one)]);
    expect(docker).not.toHaveBeenCalled();
    await expect(runInitScripts('postgresql://x\nDROP', [one], 'relay', undefined, docker)).rejects.toMatchObject({ status: 502 });
  });

  it("refuses, before anything is made, a script with psql's own commands, one too long for psql's command line, one with a NUL byte, one that is not one transaction", () => {
    checkInitScript(
      'db/init.sql',
      Buffer.from("CREATE TABLE todos (id serial);\nINSERT INTO todos VALUES (1);\nSELECT E'a\\\\b', '\\\\';"),
    );
    // Text psql would have read a command in, in a file: as a -c string it is only SQL for the server.
    checkInitScript('db/x.sql', Buffer.from("SELECT ñE'\\' \\! wget example.com --'"));
    for (const [sql, command] of [
      ['\\c postgres', '\\c'],
      ['CREATE TABLE a ();\n  \\set x 1', '\\set'],
      ['\\! id', '\\!'],
      ['\t\\copy t FROM stdin', '\\copy'],
    ])
      expect(() => withLang('en', () => checkInitScript('db/bad.sql', Buffer.from(sql!)))).toThrow(
        `db/bad.sql uses psql's own commands (${command})`,
      );
    expect(() => withLang('en', () => checkInitScript('db/big.sql', Buffer.alloc(MAX_SCRIPT + 1, 'a')))).toThrow(
      'db/big.sql is over 100 KB',
    );
    expect(() => withLang('en', () => checkInitScript('db/nul.sql', Buffer.from('SELECT 1;\0\\! id')))).toThrow(
      'db/nul.sql holds a NUL byte',
    );
    // One transaction: a statement that ends it, or cannot run in one, is refused; PL/pgSQL's BEGIN and END; stay.
    checkInitScript(
      'db/fn.sql',
      Buffer.from('CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  PERFORM 1;\nEND;\n$$ LANGUAGE plpgsql;\nCREATE INDEX i ON t (a);'),
    );
    for (const [sql, statement] of [
      ['CREATE TABLE a ();\nCOMMIT;', 'COMMIT'],
      ['BEGIN;\nCREATE TABLE a ();', 'BEGIN'],
      ['start transaction;', 'START TRANSACTION'],
      ['COMMIT WORK;', 'COMMIT WORK'],
      ['begin transaction ;', 'BEGIN TRANSACTION'],
      ['CREATE DATABASE other;', 'CREATE DATABASE'],
      ['VACUUM ANALYZE;', 'VACUUM'],
      ['CREATE UNIQUE INDEX CONCURRENTLY i ON t (a);', 'CREATE UNIQUE INDEX CONCURRENTLY'],
    ])
      expect(() => withLang('en', () => checkInitScript('db/tx.sql', Buffer.from(sql!)))).toThrow(`db/tx.sql has ${statement}.`);
  });
});
