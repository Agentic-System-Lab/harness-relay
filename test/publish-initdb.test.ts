import { describe, expect, it, vi } from 'vitest';
import { withLang } from '../src/server/i18n';
import type { SpawnResult } from '../src/server/process';
import type { Docker } from '../src/server/previewDocker';
import { checkInitScript, metaCommands, PSQL_IMAGE, psqlArgs, PSQL_SCRIPT, runInitScripts } from '../src/server/publish/initdb';

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
    // The address is read from stdin, never put on a command line.
    expect(PSQL_SCRIPT).toContain('read -r PGURI');
    expect(PSQL_SCRIPT).toContain('ON_ERROR_STOP=1');
  });

  it('gives each script, in order, after the address on its first line; stops at the first that fails, saying which', async () => {
    const runs: { args: string[]; stdin: string }[] = [];
    let n = 0;
    const docker = vi.fn(
      async () =>
        (async (args: string[], o?: { stdin?: string | Buffer }) => {
          runs.push({ args, stdin: String(o?.stdin) });
          return ++n === 2 ? ok({ code: 3, stderr: 'psql:<stdin>:1: ERROR:  syntax error at or near "CRAETE"' }) : ok();
        }) as Docker,
    );
    const uri = 'postgresql://todo:pw@ep-1.neon.test/todo?sslmode=require';
    await withLang('en', () =>
      expect(
        runInitScripts(
          uri,
          [
            { name: 'db/01.sql', sql: Buffer.from('CREATE TABLE a ();') },
            { name: 'db/02.sql', sql: Buffer.from('CRAETE TABLE b ();') },
            { name: 'db/03.sql', sql: Buffer.from('SELECT 1;') },
          ],
          'relay',
          undefined,
          docker,
        ),
      ).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/^Running db\/02\.sql on Neon failed: .*syntax error/) }),
    );
    expect(runs.map((r) => r.stdin)).toEqual([uri + '\nCREATE TABLE a ();', uri + '\nCRAETE TABLE b ();']);
    expect(runs[0]!.args).toContain(PSQL_IMAGE);
    expect(runs[0]!.args.join(' ')).not.toContain('pw@');
  });

  it('starts no container without scripts, and refuses an address that could end its first line early', async () => {
    const docker = vi.fn();
    await runInitScripts('postgresql://x', [], 'relay', undefined, docker);
    expect(docker).not.toHaveBeenCalled();
    await expect(
      runInitScripts('postgresql://x\nDROP', [{ name: 'a.sql', sql: Buffer.from('') }], 'relay', undefined, docker),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("finds psql's own commands as psql does: not in strings, quoted names, dollar quotes or comments", () => {
    const sql = [
      "INSERT INTO t VALUES ('a \\! not a command', E'it\\'s \\! still a string', \"col\\!name\");",
      "CREATE FUNCTION f() RETURNS text AS $body$ SELECT '\\! inside' $body$ LANGUAGE sql;",
      'SELECT $$ \\! also inside $$;',
      '-- \\! a comment',
      '/* \\! a comment /* nested */ \\! still */',
      '\\set ON_ERROR_STOP 1',
      "\\echo 'done' \\\\ \\! after the separator, psql goes on: another command",
      'SELECT 1; \\! id',
      "\\echo 'quoted \\! is text' x \\! y",
    ].join('\n');
    expect(metaCommands(sql)).toEqual([
      { name: 'set', args: ' ON_ERROR_STOP 1' },
      { name: 'echo', args: " 'done' " },
      { name: '!', args: ' after the separator, psql goes on: another command' },
      { name: '!', args: ' id' },
      { name: 'echo', args: " 'quoted \\! is text' x " },
      { name: '!', args: ' y' },
    ]);
  });

  it('refuses a script that could run a program, read or write a file here, or connect elsewhere, naming the command', () => {
    const allowed = Buffer.from('\\set ON_ERROR_STOP on\n\\echo creating\nCREATE TABLE todos (id serial);\n\\unset x\n\\qecho ok');
    checkInitScript('db/init.sql', allowed);
    for (const [sql, command] of [
      ['\\! curl https://example.com', '\\!'],
      ["\\copy t FROM PROGRAM 'id'", '\\copy'],
      ['\\o | sh', '\\o'],
      ['SELECT 1 \\g | sh', '\\g'],
      ['\\i /etc/passwd', '\\i'],
      ['\\connect other 10.0.0.2', '\\connect'],
      ['\\c postgres', '\\c'],
      ['\\setenv PAGER x', '\\setenv'],
      ['\\lo_import /etc/hosts', '\\lo'],
      ['\\set x `id`', '\\set'],
      ['\\echo `id`', '\\echo'],
      ['\\echo fine \\\\ \\! id', '\\!'],
      ['\\echo fine \\! id', '\\!'],
    ])
      expect(() => withLang('en', () => checkInitScript('db/bad.sql', Buffer.from(sql!)))).toThrow(
        `db/bad.sql uses psql's ${command} command`,
      );
  });
});
