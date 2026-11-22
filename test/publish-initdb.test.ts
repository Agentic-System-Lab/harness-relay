import { describe, expect, it, vi } from 'vitest';
import { withLang } from '../src/server/i18n';
import type { SpawnResult } from '../src/server/process';
import type { Docker } from '../src/server/previewDocker';
import { psqlArgs, PSQL_SCRIPT, runInitScripts } from '../src/server/publish/initdb';

const ok = (o: Partial<SpawnResult> = {}) =>
  ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, ...o }) as SpawnResult;

describe("a compose file's init scripts on Neon", () => {
  it('runs psql from the compose file’s image in a container of Relay’s own, as unprivileged as psql allows', () => {
    const args = psqlArgs('postgres:16-alpine', 'relay-1');
    expect(args).toEqual([
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
      'postgres:16-alpine',
      '-c',
      PSQL_SCRIPT,
    ]);
    // The address is read from stdin, never put on a command line.
    expect(PSQL_SCRIPT).toContain('read -r PGURI');
    expect(PSQL_SCRIPT).toContain('ON_ERROR_STOP=1');
    for (const bad of ['--privileged', 'a b', 'x;y', '']) expect(() => psqlArgs(bad, 'o')).toThrow();
  });

  it('gives each script, in order, after the address on its first line; stops at the first that fails, saying which', async () => {
    const runs: string[] = [];
    let n = 0;
    const docker = vi.fn(
      async () =>
        (async (_args: string[], o?: { stdin?: string | Buffer }) => {
          runs.push(String(o?.stdin));
          return ++n === 2 ? ok({ code: 3, stderr: 'psql:<stdin>:1: ERROR:  syntax error at or near "CRAETE"' }) : ok();
        }) as Docker,
    );
    const uri = 'postgresql://todo:pw@ep-1.neon.tech/todo?sslmode=require';
    await withLang('en', () =>
      expect(
        runInitScripts(
          'postgres:16',
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
    expect(runs).toEqual([uri + '\nCREATE TABLE a ();', uri + '\nCRAETE TABLE b ();']);
  });

  it('starts no container without scripts, and refuses an address that could end its first line early', async () => {
    const docker = vi.fn();
    await runInitScripts('postgres:16', 'postgresql://x', [], 'relay', undefined, docker);
    expect(docker).not.toHaveBeenCalled();
    await expect(
      runInitScripts('postgres:16', 'postgresql://x\nDROP', [{ name: 'a.sql', sql: Buffer.from('') }], 'relay', undefined, docker),
    ).rejects.toMatchObject({ status: 502 });
  });
});
