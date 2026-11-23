/*
 * Fixed commands' runs and pins (`src/server/fixedCommands.ts`): always in Harness Relay's own sandbox
 * with only the command's hosts, its secrets in a file and never in its environment or command line, a
 * renewed value kept, the output masked, the exit codes; and its pin, which a change to the code in its
 * folder (not to its data) breaks. The sandbox and the process are stand-ins here; `takePin` runs on a
 * real temporary git repository.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FIXED_COMMAND_NEWS, HANDOFF_LIMITS, type FixedCommand } from '../src/shared/types';
import {
  PIN_PATTERN,
  pinChanges,
  pinDiff,
  readBack,
  readSecretsFile,
  runFixedCommand,
  secretsFile,
  codeView,
  commandFiles,
  manifestDigest,
  pinManifest,
  pinnedCwd,
  manifestChanges,
  dropPin,
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
    const news = await runFixedCommand(
      command(dir),
      'schedule',
      input({ TOKEN: 'abcdef' }),
      stand(() => ({ code: FIXED_COMMAND_NEWS, stdout: 'new item' })).deps,
    );
    expect(news.run).toMatchObject({ status: 'news', exitCode: FIXED_COMMAND_NEWS, output: 'new item' });
    const refused = await withLang('en', () =>
      runFixedCommand(command(dir), 'try', input({ TOKEN: 'abcdef' }), stand(() => ({ code: 1 }), { refused: ['api.other.com'] }).deps),
    );
    expect(refused.run).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(refused.run.reason).toContain('api.other.com');
    const missing = await runFixedCommand(command(dir), 'try', input({ TOKEN: 'abcdef' }), stand(() => ({ code: 127 })).deps);
    expect(missing.run.status).toBe('error');
    const stopped = await runFixedCommand(
      command(dir),
      'try',
      input({ TOKEN: 'abcdef' }),
      stand(() => ({ code: null, aborted: true })).deps,
    );
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

describe('what a fixed command run leaves behind', () => {
  it.skipIf(process.platform === 'win32')(
    'reads its secrets file back without following a link, blocking on a pipe or reading without end',
    async () => {
      const dir = folder();
      const secret = join(dir, 'protected.env');
      writeFileSync(secret, 'TOKEN=from-a-protected-file\n');
      const linked = join(dir, 'linked.env');
      symlinkSync(secret, linked);
      expect(readBack(linked)).toEqual({});
      const { execFileSync } = await import('node:child_process');
      const fifo = join(dir, 'pipe.env');
      execFileSync('mkfifo', [fifo]);
      expect(readBack(fifo)).toEqual({});
      const big = join(dir, 'big.env');
      writeFileSync(big, `TOKEN=${'x'.repeat(200 * 1024)}\nOTHER=late\n`);
      expect(readBack(big)).not.toHaveProperty('OTHER');
      expect(readBack(join(dir, 'missing.env'))).toEqual({});
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not start from a folder that leads, through a link, into a folder of packages',
    async () => {
      const dir = folder();
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
      symlinkSync(join(dir, 'node_modules', 'pkg'), join(dir, 'via'));
      const s = stand(() => ({ code: 0 }));
      const { run } = await withLang('en', () =>
        runFixedCommand(command(dir, { cwd: 'via' }), 'try', input({ TOKEN: 'tok-123456' }), s.deps),
      );
      expect(run).toMatchObject({ status: 'error', reason: expect.stringMatching(/folder of installed packages/) });
      expect(s.seen.spec).toBeUndefined();
    },
  );

  it('removes its secrets file itself, and keeps a renewed value when the sandbox reports a failure', async () => {
    const dir = folder();
    let file = '';
    const s = stand((env) => {
      file = env.RELAY_SECRETS_FILE!;
      writeFileSync(file, 'TOKEN=tok-renewed-999\n');
      return { code: 0 };
    });
    (s.deps.sandboxCommand as unknown as { mockImplementationOnce: (f: unknown) => void }).mockImplementationOnce(
      async (_b: string, _a: string[], env: NodeJS.ProcessEnv, spec: RelaySandboxSpec) => ({
        bin: 'host',
        args: [],
        env,
        channel: {} as never,
        failure: () => 'the sandbox stopped',
        dispose: async () => undefined,
        run: { refusedHosts: [] } as never,
        spec,
      }),
    );
    const { run, written } = await runFixedCommand(command(dir), 'try', input({ TOKEN: 'tok-123456' }), s.deps);
    expect(run.status).toBe('error');
    expect(written).toEqual({ TOKEN: 'tok-renewed-999' });
    expect(existsSync(file)).toBe(false);
  });

  it('masks the hosts the sandbox refused, in its reason', async () => {
    const dir = folder();
    const s = stand(() => ({ code: 1 }), { refused: ['tok-0123456789.example.com'] });
    const { run } = await runFixedCommand(command(dir), 'try', input({ TOKEN: 'tok-0123456789' }), s.deps);
    expect(run.reason).toBeDefined();
    expect(run.reason).not.toContain('tok-0123456789');
  });

  it('masks a value the output limit cut in two', async () => {
    const dir = folder();
    const token = 'tok-0123456789abcdefghijklmnopq';
    // The output kept is its end: put the token across where it is cut.
    const s = stand(() => ({ code: 0, stdout: `${token}${'y'.repeat(HANDOFF_LIMITS.output - 10)}` }));
    const { run } = await runFixedCommand(command(dir), 'try', input({ TOKEN: token }), s.deps);
    expect(run.output).not.toContain(token.slice(-10));
    expect(run.output).not.toContain(token.slice(-6));
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
    // The code (git's configuration as `git init` wrote it says nothing it would run).
    expect(Object.keys(pin.manifest)).toEqual(['post.py']);
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await pinChanges(dir, pin)).toEqual([]);
    writeFileSync(join(dir, 'queue.csv'), 'id,text\n1,hello\n');
    expect(await pinChanges(dir, pin)).toEqual([]);
    writeFileSync(join(dir, 'post.py'), 'print("v2")\n');
    writeFileSync(join(dir, 'json.py'), 'planted = True\n');
    expect(await pinChanges(dir, pin)).toEqual(['json.py', 'post.py']);
    const { diff, missing } = await pinDiff(dir, pin, ['post.py']);
    expect(missing).toEqual([]);
    expect(diff).toContain('-print("v1")');
    expect(diff).toContain('+print("v2")');
    expect(diff).not.toContain('json.py');
  });

  it('sees a same-size edit whose time was put back, a link anywhere, and code in a folder of packages below the top', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'post.py'), 'print("aaa")\n');
    mkdirSync(join(dir, 'lib'), { recursive: true });
    const pin = await takePin(dir, 'c2');
    // The same size, its times put back as they were.
    const before = statSync(join(dir, 'post.py'));
    writeFileSync(join(dir, 'post.py'), 'print("bbb")\n');
    utimesSync(join(dir, 'post.py'), before.atime, before.mtime);
    expect(await pinChanges(dir, pin)).toEqual(['post.py']);
    const again = await takePin(dir, 'c2');
    // A link, whatever its name: one to a folder can put a module in a script's way.
    mkdirSync(join(dir, 'elsewhere', 'evil'), { recursive: true });
    symlinkSync(join(dir, 'elsewhere', 'evil'), join(dir, 'json'));
    expect(await pinChanges(dir, again)).toContain('json');
    const third = await takePin(dir, 'c2');
    // `target` and `node_modules` are passed over at the top only.
    mkdirSync(join(dir, 'lib', 'target'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'target', 'x.py'), 'x = 1\n');
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '1\n');
    expect(await pinChanges(dir, third)).toEqual(['lib/target/x.py']);
  });

  it('gives the same digest for the same code, another once it changes', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'post.py'), 'print(1)\n');
    const a = manifestDigest(await pinManifest(dir));
    expect(manifestDigest(await pinManifest(dir))).toBe(a);
    writeFileSync(join(dir, 'post.py'), 'print(2)\n');
    expect(manifestDigest(await pinManifest(dir))).not.toBe(a);
  });
});

describe("the relay sandbox's run folders", () => {
  it('are the folders the relay sandbox uses', () => {
    expect(relaySandboxDirs()).toEqual([relaySandboxRoot(), relaySandboxHostRoot()]);
  });
});

describe.skipIf(process.platform === 'win32')("a fixed command's pin, against what could change its code unseen", () => {
  const gitIn = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });

  it('refuses a link that leads out of the folder or into .git, and keeps one into a top folder of packages by its target', async () => {
    const dir = folder();
    const outside = folder();
    writeFileSync(join(outside, 'run.py'), 'print(1)\n');
    symlinkSync(join(outside, 'run.py'), join(dir, 'post.py'));
    await withLang('en', () => expect(pinManifest(dir)).rejects.toThrow(/post\.py is a link that leads out of the folder/));
    const other = folder();
    // A link that leads nowhere yet, outside: what appears there later would run.
    symlinkSync(join(outside, 'later.py'), join(other, 'post.py'));
    await expect(pinManifest(other)).rejects.toThrow();
    const pkgs = folder();
    mkdirSync(join(pkgs, 'node_modules', 'x'), { recursive: true });
    symlinkSync(join(pkgs, 'node_modules', 'x'), join(pkgs, 'x'));
    expect((await pinManifest(pkgs)).x).toEqual({ kind: 'link', target: join(pkgs, 'node_modules', 'x') });
  });

  it('pins what a link inside the folder leads to, whatever its name, and every executable file', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'data.txt'), 'print(1)\n');
    symlinkSync('data.txt', join(dir, 'post.py'));
    writeFileSync(join(dir, 'deploy'), '#!/bin/sh\necho 1\n', { mode: 0o755 });
    const before = await pinManifest(dir);
    expect(Object.keys(before).sort()).toEqual(['deploy', 'post.py']);
    writeFileSync(join(dir, 'data.txt'), 'print(2)\n');
    writeFileSync(join(dir, 'deploy'), '#!/bin/sh\necho 2\n', { mode: 0o755 });
    expect(manifestChanges(before, await pinManifest(dir))).toEqual(['deploy', 'post.py']);
  });

  it('pins the files of code its command line names in a folder of packages, through links', async () => {
    const dir = folder();
    mkdirSync(join(dir, 'node_modules', 'tool'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'tool', 'cli.js'), '1\n');
    symlinkSync('../tool/cli.js', join(dir, 'node_modules', '.bin', 'tool.js'));
    const named = commandFiles({ run: 'node node_modules/.bin/tool.js' }, dir);
    const before = await pinManifest(dir, named);
    expect(Object.keys(before)).toEqual(['named:node_modules/.bin/tool.js']);
    writeFileSync(join(dir, 'node_modules', 'tool', 'cli.js'), '2\n');
    expect(manifestChanges(before, await pinManifest(dir, named))).toEqual(['named:node_modules/.bin/tool.js']);
  });

  it("pins git's settings as git reads them, but the everyday ones and what git init writes, and its hooks", async () => {
    const dir = folder();
    writeFileSync(join(dir, 'post.py'), 'print(1)\n');
    // A folder that is not a repository yet: Harness Relay makes one for the team's first turn.
    const before = await pinManifest(dir);
    gitIn(dir, 'init', '-q');
    expect(manifestChanges(before, await pinManifest(dir))).toEqual([]);
    // Everyday work changes nothing pinned.
    gitIn(dir, 'config', 'user.email', 'a@example.com');
    gitIn(dir, 'remote', 'add', 'origin', 'https://example.com/r.git');
    gitIn(dir, 'config', 'branch.main.remote', 'origin');
    gitIn(dir, 'config', 'branch.main.merge', 'refs/heads/main');
    expect(manifestChanges(before, await pinManifest(dir))).toEqual([]);
    const inited = await pinManifest(dir);
    gitIn(dir, 'config', 'core.fsmonitor', './evil.sh');
    writeFileSync(join(dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n', { mode: 0o755 });
    expect(manifestChanges(inited, await pinManifest(dir))).toEqual(['git config core.fsmonitor', 'git hook pre-push']);
    const set = await pinManifest(dir);
    // A setting from an included file (with a comment after its path), and the hooks core.hooksPath names.
    writeFileSync(join(dir, 'extra.cfg'), '[core]\n\tpager = less\n');
    writeFileSync(
      join(dir, '.git', 'config'),
      `${readFileSync(join(dir, '.git', 'config'), 'utf8')}[include]\n\tpath = ../extra.cfg ; note\n`,
    );
    mkdirSync(join(dir, 'hooks'));
    writeFileSync(join(dir, 'hooks', 'pre-commit'), '#!/bin/sh\n');
    gitIn(dir, 'config', 'core.hooksPath', 'hooks');
    const withInclude = await pinManifest(dir);
    expect(manifestChanges(set, withInclude)).toEqual(
      expect.arrayContaining([
        'git config core.pager',
        'git config core.hookspath',
        'git config include.path',
        'git hook pre-commit',
        `git include ${join(dir, 'extra.cfg')}`,
      ]),
    );
    writeFileSync(join(dir, 'extra.cfg'), '[core]\n\tpager = ./evil.sh\n');
    expect(manifestChanges(withInclude, await pinManifest(dir))).toEqual([
      'git config core.pager',
      `git include ${join(dir, 'extra.cfg')}`,
    ]);
  });

  it('pins a remote here (whose hooks git push runs) and a branch whose remote is a path, never a remote on the network', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'post.py'), 'print(1)\n');
    gitIn(dir, 'init', '-q');
    gitIn(dir, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git');
    gitIn(dir, 'remote', 'add', 'web', 'https://example.com/r.git');
    gitIn(dir, 'config', 'branch.main.remote', 'origin');
    const before = await pinManifest(dir);
    expect(Object.keys(before).filter((k) => k.startsWith('git '))).toEqual([]);
    gitIn(dir, 'remote', 'add', 'local', './vendor/.git');
    gitIn(dir, 'config', 'branch.dev.pushremote', '../elsewhere');
    expect(manifestChanges(before, await pinManifest(dir))).toEqual(['git config branch.dev.pushremote', 'git config remote.local.url']);
  });

  it('refuses a pin whose git settings cannot be read, rather than taking them for none', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'post.py'), 'print(1)\n');
    gitIn(dir, 'init', '-q');
    // A driver name git's -c cannot carry: Harness Relay's git refuses the repository.
    writeFileSync(join(dir, '.git', 'config'), `${readFileSync(join(dir, '.git', 'config'), 'utf8')}[filter "a=b"]\n\tclean = evil\n`);
    await withLang('en', () => expect(pinManifest(dir)).rejects.toThrow(/git settings could not be read/));
  });

  it('pins the repositories inside the folder: that they are there, their settings and hooks', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'post.py'), 'print(1)\n');
    mkdirSync(join(dir, 'site'));
    const before = await pinManifest(dir);
    gitIn(join(dir, 'site'), 'init', '-q');
    expect(manifestChanges(before, await pinManifest(dir))).toEqual(['site/.git']);
    const inited = await pinManifest(dir);
    writeFileSync(join(dir, 'site', '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n', { mode: 0o755 });
    expect(manifestChanges(inited, await pinManifest(dir))).toEqual(['site: git hook pre-commit']);
  });

  it('never opens a file Harness Relay keeps to itself, which a hook may lead to', async () => {
    const dir = folder();
    gitIn(dir, 'init', '-q');
    const { openDatabase } = await import('../src/server/db');
    const db = openDatabase(join(folder(), 'kept.db'));
    try {
      symlinkSync(db.location()!, join(dir, '.git', 'hooks', 'pre-push'));
      await withLang('en', () => expect(pinManifest(dir)).rejects.toThrow(/keeps to itself/));
    } finally {
      db.close();
    }
  });

  it('pins a file with no ending beside code of its name, and what make or a build reads', async () => {
    const dir = folder();
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'helper.js'), 'module.exports = 1\n');
    writeFileSync(join(dir, 'lib', 'helper'), 'module.exports = 2\n');
    writeFileSync(join(dir, 'LICENSE'), 'text\n');
    writeFileSync(join(dir, 'GNUmakefile'), 'all:\n');
    writeFileSync(join(dir, 'main.go'), 'package main\n');
    const keys = Object.keys(await pinManifest(dir));
    expect(keys).toEqual(expect.arrayContaining(['lib/helper', 'lib/helper.js', 'GNUmakefile', 'main.go']));
    expect(keys).not.toContain('LICENSE');
  });

  it('shows in the code view what changed since a base, committed or not, a script git calls binary, and names what its length cut', async () => {
    const dir = folder();
    await ensureRepo(dir);
    writeFileSync(join(dir, 'post.py'), 'print("before")\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first');
    const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // An agent's change, committed: compared with the base, it shows.
    writeFileSync(join(dir, 'post.py'), 'print("agent")\x00\n');
    writeFileSync(join(dir, '.gitattributes'), 'post.py -diff\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'agent');
    const manifest = await pinManifest(dir);
    const view = await codeView(dir, manifest, [], { base });
    expect(view.diff).toContain('+print("agent")');
    expect(view.diff).not.toContain('Binary files');
    // Against HEAD alone, it would not.
    expect((await codeView(dir, manifest)).diff).not.toContain('print("agent")');
    // Cut a whole file at a time: the scripts it runs first, what does not fit named.
    writeFileSync(join(dir, 'a-vendor.js'), `// ${'x'.repeat(5000)}\n`);
    const cut = await codeView(dir, await pinManifest(dir), [], { base, named: [join(dir, 'post.py')], max: 2000 });
    expect(cut.diff).toContain('print("agent")');
    expect(cut.missing).toContain('a-vendor.js');
  });

  it('pins a file with no ending beside a file of its name, code or not', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'config.json'), '{}\n');
    writeFileSync(join(dir, 'config'), 'module.exports = "planted"\n');
    expect(Object.keys(await pinManifest(dir))).toContain('config');
  });

  it('pins the script after an interpreter and its options', () => {
    const dir = folder();
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'run'), 'echo 1\n');
    for (const run of ['sh -e ./bin/run', 'bash -eu bin/run', 'python3 -u bin/run', 'node --enable-source-maps bin/run'])
      expect(commandFiles({ run }, dir), run).toEqual([join(dir, 'bin', 'run')]);
  });

  it('shows what a git setting, a hook or a file outside the repository is now, but a value that may be a credential', async () => {
    const dir = folder();
    await ensureRepo(dir);
    writeFileSync(join(dir, 'post.py'), 'print(1)\n');
    const pin = await takePin(dir, 'g1');
    gitIn(dir, 'config', 'core.sshCommand', 'ssh -i /tmp/key');
    gitIn(dir, 'config', 'http.extraHeader', 'Authorization: Bearer tok-abcdef');
    // A program, whatever its section is named, is shown: it is what the user approves.
    gitIn(dir, 'config', 'filter.secret.clean', 'sh -c evil');
    writeFileSync(join(dir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho pushed\n', { mode: 0o755 });
    const changed = await pinChanges(dir, pin);
    const { diff, missing } = await pinDiff(dir, pin, changed);
    expect(diff).toContain('core.sshcommand = ssh -i /tmp/key');
    expect(diff).toContain('http.extraheader = (set; its value is not shown)');
    expect(diff).toContain('filter.secret.clean = sh -c evil');
    expect(diff).not.toContain('tok-abcdef');
    expect(diff).toContain('### git hook pre-push (as it is now)\n#!/bin/sh\necho pushed');
    expect(missing).toEqual([]);
  });

  it('pins the code its command line runs, never a data file it names', async () => {
    const dir = folder();
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'bin', 'post'), 'print(1)\n');
    writeFileSync(join(dir, 'data', 'queue.csv'), 'id\n');
    const files = commandFiles({ run: 'python3 bin/post --queue data/queue.csv > out/log.txt' }, dir);
    expect(files).toEqual([join(dir, 'bin', 'post')]);
  });

  it('refuses a file of code the command line names in a temp folder outside the working directory', async () => {
    const dir = folder();
    const outside = folder();
    writeFileSync(join(outside, 'run.py'), 'print(1)\n');
    await withLang('en', () => expect(pinManifest(dir, [join(outside, 'run.py')])).rejects.toThrow(/in a temp folder/));
  });

  it('lets a top folder of packages that is a link be, and takes a link spelled through another name of the folder', async () => {
    const dir = folder();
    const elsewhere = folder();
    symlinkSync(elsewhere, join(dir, 'node_modules'));
    expect((await pinManifest(dir)).node_modules).toEqual({ kind: 'link', target: elsewhere });
    if (process.platform === 'darwin' && realpathSync(dir) !== dir.replace(/^\/private/, '')) {
      // On macOS /var is /private/var: a link written either way leads inside.
      writeFileSync(join(dir, 'a.py'), '1\n');
      symlinkSync(join(dir, 'a.py').replace(/^\/private/, ''), join(dir, 'b.py'));
      expect((await pinManifest(dir))['b.py']).toMatchObject({ kind: 'link' });
    }
  });

  it("shows the diff of a command's files when its folder is below its repository's top, and says which files have none", async () => {
    const repo = folder();
    await ensureRepo(repo);
    const dir = join(repo, 'pkg', 'post');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'post.py'), 'print("v1")\n');
    writeFileSync(join(repo, '.gitignore'), 'secret.py\n');
    writeFileSync(join(dir, 'secret.py'), 'x = 1\n');
    const pin = await takePin(dir, 'sub');
    writeFileSync(join(dir, 'post.py'), 'print("v2") # tok-123456\n');
    writeFileSync(join(dir, 'secret.py'), 'x = 2\n');
    const changed = await pinChanges(dir, pin);
    expect(changed).toEqual(['post.py', 'secret.py']);
    const { diff, missing } = await pinDiff(dir, pin, changed, ['tok-123456']);
    expect(diff).toContain('+print("v2") # ••••');
    expect(diff).not.toContain('tok-123456');
    // Git ignores it: what it is now, in place of a diff.
    expect(diff).toContain('### secret.py (as it is now)\nx = 2');
    expect(missing).toEqual([]);
  });

  it('keeps one snapshot ref a command: the new one after a re-pin, the old one when an approval is refused', async () => {
    const dir = folder();
    await ensureRepo(dir);
    writeFileSync(join(dir, 'post.py'), 'print(1)\n');
    const refs = () =>
      execFileSync('git', ['-C', dir, 'for-each-ref', '--format=%(refname)', 'refs/harness-relay/commands/r1'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    const first = await takePin(dir, 'r1');
    writeFileSync(join(dir, 'post.py'), 'print(2)\n');
    const second = await takePin(dir, 'r1');
    await dropPin('r1', first, second);
    expect(refs()).toEqual([`refs/harness-relay/commands/r1/${second.commit}`]);
    // A refused approval drops the pin it took, and keeps the old one.
    writeFileSync(join(dir, 'post.py'), 'print(3)\n');
    const refused = await takePin(dir, 'r1');
    await dropPin('r1', refused, second);
    expect(refs()).toEqual([`refs/harness-relay/commands/r1/${second.commit}`]);
    await dropPin('r1', second);
    expect(refs()).toEqual([]);
  });

  it('runs only from a folder that is, through links, in the working directory and not in its packages', () => {
    const dir = folder();
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, 'tools'));
    symlinkSync(join(dir, 'node_modules', 'pkg'), join(dir, 'via'));
    expect(pinnedCwd(dir, join(dir, 'tools'))).toBe(true);
    expect(pinnedCwd(dir, join(dir, 'via'))).toBe(false);
    expect(pinnedCwd(dir, join(dir, 'node_modules', 'pkg'))).toBe(false);
    expect(pinnedCwd(dir, folder())).toBe(false);
  });

  it('drops a value its secrets file cut short at the read-back limit', () => {
    const dir = folder();
    const file = join(dir, 'secrets.env');
    const value = 'v'.repeat(HANDOFF_LIMITS.secretValue);
    const many = Array.from({ length: HANDOFF_LIMITS.commandSecrets + 2 }, (_, i) => `K${i}=${value}`).join('\n');
    writeFileSync(file, `${many}\n`);
    const back = readBack(file);
    // Every value it kept is whole; the one at the cut is left out.
    for (const v of Object.values(back)) expect(v).toBe(value);
    expect(Object.keys(back).length).toBeGreaterThanOrEqual(HANDOFF_LIMITS.commandSecrets);
  });
});
