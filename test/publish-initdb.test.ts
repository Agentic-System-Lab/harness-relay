import { describe, expect, it, vi } from 'vitest';
import { withLang } from '../src/server/i18n';
import type { SpawnResult } from '../src/server/process';
import type { Docker } from '../src/server/previewDocker';
import { checkInitScript, MAX_SCRIPT, PSQL_IMAGE, psqlArgs, PSQL_SCRIPT, runInitScripts } from '../src/server/publish/initdb';

const ok = (o: Partial<SpawnResult> = {}) =>
  ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, ...o }) as SpawnResult;

describe("a compose file's init scripts on Neon", () => {
  it("runs psql from PostgreSQL's official image pinned by digest, never the compose file's, as unprivileged as psql allows", () => {
    expect(PSQL_IMAGE).toMatch(/^docker\.io\/library\/postgres@sha256:[0-9a-f]{64}$/);
    expect(psqlArgs('relay-1')).toEqual([
      'run',
      '--rm',
      '-i',
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

  it('hands psql the script as one -c string after a comment, never as a file psql would read its own commands in', () => {
    // The address from stdin's first line, never a command line; the script from the rest.
    expect(PSQL_SCRIPT).toMatch(/^IFS= read -r PGURI \|\| exit 64; SQL=\$\(cat\) \|\| exit 65; exec psql "\$PGURI" /);
    expect(PSQL_SCRIPT).toContain('-v ON_ERROR_STOP=1');
    // psql reads a -c string beginning with a backslash as one of its own commands: a comment comes first.
    expect(PSQL_SCRIPT).toMatch(/ -c "-- [^\n"]*\n\$SQL"$/);
    expect(PSQL_SCRIPT).not.toContain(' -f ');
  });

  it('gives each script, in order from the one given, after the address on its first line; counts each that committed; stops at the first that fails, saying which', async () => {
    const runs: { args: string[]; stdin: string }[] = [];
    let n = 0;
    const docker = vi.fn(
      async () =>
        (async (args: string[], o?: { stdin?: string | Buffer }) => {
          runs.push({ args, stdin: String(o?.stdin) });
          return ++n === 2 ? ok({ code: 1, stderr: 'ERROR:  syntax error at or near "CRAETE"' }) : ok();
        }) as Docker,
    );
    const uri = 'postgresql://todo:pw@ep-1.neon.test/todo?sslmode=require';
    const scripts = [
      { name: 'db/00.sql', sql: Buffer.from('SELECT 0;') },
      { name: 'db/01.sql', sql: Buffer.from('CREATE TABLE a ();') },
      { name: 'db/02.sql', sql: Buffer.from('CRAETE TABLE b ();') },
      { name: 'db/03.sql', sql: Buffer.from('SELECT 1;') },
    ];
    const done: number[] = [];
    await withLang('en', () =>
      expect(runInitScripts(uri, scripts, 'relay', undefined, docker, 1, (count) => done.push(count))).rejects.toMatchObject({
        status: 502,
        message: expect.stringMatching(/^Running db\/02\.sql on Neon failed: .*syntax error/),
      }),
    );
    expect(runs.map((r) => r.stdin)).toEqual([uri + '\nCREATE TABLE a ();', uri + '\nCRAETE TABLE b ();']);
    expect(done).toEqual([2]);
    expect(runs[0]!.args).toContain(PSQL_IMAGE);
    expect(runs[0]!.args.join(' ')).not.toContain('pw@');
  });

  it('starts no container without scripts left, and refuses an address that could end its first line early', async () => {
    const docker = vi.fn();
    await runInitScripts('postgresql://x', [], 'relay', undefined, docker);
    await runInitScripts('postgresql://x', [{ name: 'a.sql', sql: Buffer.from('SELECT 1;') }], 'relay', undefined, docker, 1);
    expect(docker).not.toHaveBeenCalled();
    await expect(
      runInitScripts('postgresql://x\nDROP', [{ name: 'a.sql', sql: Buffer.from('') }], 'relay', undefined, docker),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("refuses, before anything is made, a script with psql's own commands, one too long for psql's command line, one with a NUL byte", () => {
    checkInitScript(
      'db/init.sql',
      Buffer.from("CREATE TABLE todos (id serial);\nINSERT INTO todos VALUES (1);\nSELECT E'a\\\\b', '\\\\';"),
    );
    // Text psql would have read its own commands in, in a file: as a -c string it is only SQL for the server.
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
  });
});
