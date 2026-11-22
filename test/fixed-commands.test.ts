/*
 * Fixed commands' runs and pins (`src/server/fixedCommands.ts`): always in Harness Relay's own sandbox
 * with only the command's hosts, its secrets in a file and never in its environment or command line, a
 * renewed value kept, the output masked, the exit codes; and its pin, which a change to the code in its
 * folder (not to its data) breaks. The sandbox and the process are stand-ins here; `takePin` runs on a
 * real temporary git repository.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FIXED_COMMAND_NEWS, type FixedCommand } from '../src/shared/types';
import {
  PIN_PATTERN,
  pinChanges,
  pinDiff,
  readSecretsFile,
  runFixedCommand,
  secretsFile,
  takePin,
  type FixedCommandDeps,
} from '../src/server/fixedCommands';
import { removeTree } from '../src/server/fsRemove';
import { withLang } from '../src/server/i18n';
import type { SpawnResult } from '../src/server/process';
import type { RelaySandboxSpec } from '../src/server/relaySandbox';
import { ensureRepo } from '../src/server/workspace';
import { relaySandboxDirs } from '../src/server/protect';
import { relaySandboxHostRoot, relaySandboxRoot } from '../src/server/relaySandbox';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-fixed-')));
afterAll(() => removeTree(root, { restore: true }));

const result = (o: Partial<SpawnResult> = {}): SpawnResult => ({
  code: 0,
  signal: null,
  stdout: '',
  stdoutBytes: Buffer.alloc(0),
  stdoutTruncated: false,
  stdoutSize: 0,
  stderr: '',
  aborted: false,
  timedOut: false,
  ...o,
});

let n = 0;
const folder = () => {
  const dir = join(root, `w${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const command = (dir: string, o: Partial<FixedCommand> = {}): FixedCommand => ({
  id: 'c1',
  folder: dir,
  name: 'post',
  run: 'python3 post.py',
  hosts: ['graph.threads.net'],
  secrets: ['TOKEN'],
  createdAt: 1,
  pinnedAt: 1,
  ...o,
});

/** A sandbox and a process that stand in for the real ones; `body` plays the command, with its environment and the run's folder. */
function stand(body: (env: NodeJS.ProcessEnv, stdin: string | undefined) => Partial<SpawnResult>, o: { refused?: string[] } = {}) {
  const runs = join(root, `runs${++n}`);
  const seen: { spec?: RelaySandboxSpec; env?: NodeJS.ProcessEnv; args?: string[]; disposed: boolean } = { disposed: false };
  const deps: FixedCommandDeps = {
    platform: 'darwin',
    env: { PATH: '/usr/bin', HOME: '/home/me', OPENAI_API_KEY: 'sk-server' },
    sandboxAvailable: async () => ({ ok: true }),
    makeRunDirs: () => {
      const tmp = join(runs, 'tmp');
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      return { tmp, hostTmp: join(runs, 'host') };
    },
    sandboxCommand: vi.fn(async (_bin: string, args: string[], env: NodeJS.ProcessEnv, spec: RelaySandboxSpec) => {
      seen.spec = spec;
      seen.env = env;
      seen.args = args;
      return {
        bin: 'host',
        args: [],
        env,
        channel: {} as never,
        failure: () => undefined,
        dispose: async () => void (seen.disposed = true),
        run: { refusedHosts: o.refused ?? [] } as never,
      };
    }) as never,
    runProcess: vi.fn(async (p: { env?: NodeJS.ProcessEnv; stdin?: string | Buffer }) =>
      result(body(p.env ?? {}, typeof p.stdin === 'string' ? p.stdin : undefined)),
    ) as never,
  };
  return { deps, seen };
}

const input = (values: Record<string, string>, o: Partial<Parameters<typeof runFixedCommand>[2]> = {}) => ({
  values,
  protectedPaths: ['/protected'],
  privateRoots: ['/private'],
  ...o,
});

describe('a fixed command run', () => {
  it('runs in the sandbox with its hosts only, its secrets in a file, none in its environment or command line', async () => {
    const dir = folder();
    let file = '';
    const { deps, seen } = stand((env) => {
      file = env.RELAY_SECRETS_FILE!;
      return { code: 0, stdout: `posted with ${readFileSync(file, 'utf8').trim()}` };
    });
    const { run, written } = await runFixedCommand(command(dir), 'try', input({ TOKEN: 'tok-123456', OTHER: 'other-secret' }), deps);
    expect(seen.args).toEqual(['-c', 'exec 2>&1; eval "$RELAY_CHECK_COMMAND"']);
    expect(seen.env!.RELAY_CHECK_COMMAND).toBe('python3 post.py');
    expect(Object.values(seen.env!).join('\n')).not.toContain('tok-123456');
    expect(seen.env!.OPENAI_API_KEY).toBeUndefined();
    expect(seen.spec).toMatchObject({
      permission: 'edit',
      cwd: dir,
      allowedHosts: ['graph.threads.net'],
      protectedPaths: ['/protected'],
      privateRoots: ['/private'],
    });
    expect(file.startsWith(seen.spec!.dirs!.tmp)).toBe(true);
    // Only its own secrets go in the file; every value the folder holds is masked in the output.
    expect(run).toMatchObject({ status: 'passed', exitCode: 0, source: 'try', output: 'posted with TOKEN=••••' });
    expect(written).toEqual({});
    expect(seen.disposed).toBe(true);
  });

  it('keeps a value it renewed in its file, for its own names only, and masks the new one too', async () => {
    const dir = folder();
    const { deps } = stand((env) => {
      writeFileSync(env.RELAY_SECRETS_FILE!, 'TOKEN=tok-renewed-999\nOTHER=planted\n# a note\n');
      return { code: 0, stdout: 'renewed tok-renewed-999' };
    });
    const { run, written } = await runFixedCommand(command(dir), 'schedule', input({ TOKEN: 'tok-123456' }), deps);
    expect(written).toEqual({ TOKEN: 'tok-renewed-999' });
    expect(run.output).toBe('renewed ••••');
  });

  it('says what an exit code means: news, a failure with the hosts the sandbox refused, a missing program', async () => {
    const dir = folder();
    const news = await runFixedCommand(command(dir), 'schedule', input({ TOKEN: 'abcdef' }), stand(() => ({ code: FIXED_COMMAND_NEWS, stdout: 'new item' })).deps);
    expect(news.run).toMatchObject({ status: 'news', exitCode: FIXED_COMMAND_NEWS, output: 'new item' });
    const refused = await withLang('en', () =>
      runFixedCommand(command(dir), 'try', input({ TOKEN: 'abcdef' }), stand(() => ({ code: 1 }), { refused: ['api.other.com'] }).deps),
    );
    expect(refused.run).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(refused.run.reason).toContain('api.other.com');
    const missing = await runFixedCommand(command(dir), 'try', input({ TOKEN: 'abcdef' }), stand(() => ({ code: 127 })).deps);
    expect(missing.run.status).toBe('error');
    const stopped = await runFixedCommand(command(dir), 'try', input({ TOKEN: 'abcdef' }), stand(() => ({ code: null, aborted: true })).deps);
    expect(stopped.run.status).toBe('error');
  });

  it('gives an outbox run its input on its standard input, and a try its extra words on its command line', async () => {
    const dir = folder();
    let got: string | undefined;
    const s = stand((_env, stdin) => {
      got = stdin;
      return { code: 0 };
    });
    await runFixedCommand(command(dir), 'outbox', input({ TOKEN: 'abcdef' }, { stdin: 'Hello, Threads!' }), s.deps);
    expect(got).toBe('Hello, Threads!');
    expect(s.seen.env!.RELAY_CHECK_COMMAND).toBe('python3 post.py');
    const t = stand(() => ({ code: 0 }));
    await runFixedCommand(command(dir), 'try', input({ TOKEN: 'abcdef' }, { extra: ' --dry-run ' }), t.deps);
    expect(t.seen.env!.RELAY_CHECK_COMMAND).toBe('python3 post.py --dry-run');
  });

  it('does not run without its secrets, on Windows, or outside its folder', async () => {
    const dir = folder();
    await withLang('en', async () => {
      const s = stand(() => ({ code: 0 }));
      const missing = await runFixedCommand(command(dir), 'try', input({}), s.deps);
      expect(missing.run).toMatchObject({ status: 'error' });
      expect(missing.run.reason).toContain('TOKEN');
      expect(s.deps.sandboxCommand).not.toHaveBeenCalled();
      const win = await runFixedCommand(command(dir), 'try', input({ TOKEN: 'abcdef' }), { ...s.deps, platform: 'win32' });
      expect(win.run.reason).toMatch(/Windows/);
      const gone = await runFixedCommand(command(dir, { cwd: 'not-there' }), 'try', input({ TOKEN: 'abcdef' }), s.deps);
      expect(gone.run.status).toBe('error');
    });
  });

  it('writes and reads its secrets file as lines of NAME=value, the value as it is', () => {
    const text = secretsFile({ A: 'x=y z', B: "it's" });
    expect(text).toBe("A=x=y z\nB=it's\n");
    expect(readSecretsFile(`${text}bad-name=1\n  C=indented\nD=\n`)).toEqual({ A: 'x=y z', B: "it's", D: '' });
  });
});

describe("a fixed command's pin", () => {
  it('matches code and configuration at any depth, not data', () => {
    for (const p of ['post.py', 'lib/threads_common.py', 'json.pyc', 'a/b/native.so', 'package.json', 'pyproject.toml', '.env', 'run.sh'])
      expect(PIN_PATTERN.regex.test(p), p).toBe(true);
    for (const p of ['queue.csv', 'notes.md', 'out/log.txt']) expect(PIN_PATTERN.regex.test(p), p).toBe(false);
  });

  it('is broken by a changed, added or removed code file, not by its data, and shows git’s diff of it', async () => {
    const dir = folder();
    await ensureRepo(dir);
    writeFileSync(join(dir, 'post.py'), 'print("v1")\n');
    writeFileSync(join(dir, 'queue.csv'), 'id,text\n');
    const pin = await takePin(dir, 'c1');
    expect(Object.keys(pin.manifest)).toEqual(['post.py']);
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await pinChanges(dir, pin)).toEqual([]);
    writeFileSync(join(dir, 'queue.csv'), 'id,text\n1,hello\n');
    expect(await pinChanges(dir, pin)).toEqual([]);
    writeFileSync(join(dir, 'post.py'), 'print("v2")\n');
    writeFileSync(join(dir, 'json.py'), 'planted = True\n');
    expect(await pinChanges(dir, pin)).toEqual(['json.py', 'post.py']);
    const diff = await pinDiff(dir, pin, ['post.py']);
    expect(diff).toContain('-print("v1")');
    expect(diff).toContain('+print("v2")');
    expect(diff).not.toContain('json.py');
  });
});

describe("the relay sandbox's run folders", () => {
  it('are the folders the relay sandbox uses', () => {
    expect(relaySandboxDirs()).toEqual([relaySandboxRoot(), relaySandboxHostRoot()]);
  });
});
