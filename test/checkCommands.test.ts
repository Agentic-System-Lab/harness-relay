import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkConfigFiles,
  checkEnv,
  commandCwd,
  commandOutcome,
  keptOutput,
  namedFiles,
  runCheckCommand,
  sandboxDenial,
  type CheckCommandDeps,
  type CheckCommandPlace,
} from '../src/server/checkCommands';
import { AgentRunError } from '../src/server/agents/types';
import { withLang } from '../src/server/i18n';
import { runProcess, runShellScript, type SpawnResult } from '../src/server/process';
import type { RelaySandboxSpec } from '../src/server/relaySandbox';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-cmd-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

describe('a check command’s environment', () => {
  it('keeps only the PATH, home, user, shell and locale, never a key or a token', () => {
    const env = checkEnv(
      {
        PATH: '/usr/bin',
        HOME: '/h',
        USER: 'u',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        OPENAI_API_KEY: 'sk-x',
        GITHUB_TOKEN: 'ghp',
        NODE_OPTIONS: '--x',
      },
      'npm test',
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/h',
      USER: 'u',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      TERM: 'dumb',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CI: '1',
      RELAY_CHECK_COMMAND: 'npm test',
    });
  });

  it('puts the tools’ caches in the run’s own folder in the sandbox', () => {
    const env = checkEnv({}, 'x', '/run/tmp');
    expect(env.npm_config_cache).toBe(join('/run/tmp', 'npm-cache'));
    expect(env.XDG_CACHE_HOME).toBe(join('/run/tmp', 'cache'));
    expect(env.PYTHONPYCACHEPREFIX).toBe(join('/run/tmp', 'pycache'));
  });
});

describe('what the sandbox refused, from the output', () => {
  it('tells each refusal apart, by system', () => {
    expect(sandboxDenial('Error: listen EPERM: operation not permitted 127.0.0.1', 'darwin')).toBe('localPorts');
    expect(sandboxDenial('Error: listen EPERM: operation not permitted 127.0.0.1', 'linux')).toBeUndefined();
    expect(sandboxDenial('Error: listen EPERM: operation not permitted /tmp/run/s.sock', 'darwin')).toBe('unixSockets');
    expect(sandboxDenial('Error: listen EPERM: operation not permitted /home/u/x/gw', 'linux')).toBe('unixSockets');
    expect(sandboxDenial("EROFS: read-only file system, open '/tmp/x'", 'linux')).toBe('readOnly');
    expect(sandboxDenial("[error] EACCES: permission denied, open '/work/p/.zshrc'", 'linux')).toBe('phantom');
    expect(sandboxDenial("[error] EACCES: permission denied, open '/work/p/.zshrc'", 'darwin')).toBeUndefined();
    expect(sandboxDenial('browserType.launch: Target page, context or browser has been closed', 'darwin')).toBe('browser');
    expect(sandboxDenial('getaddrinfo EAI_AGAIN registry.npmjs.org', 'linux')).toBe('network');
    expect(sandboxDenial('example.com is not among the hosts this run may reach, and this conversation refuses…', 'darwin')).toBe(
      'network',
    );
    expect(sandboxDenial('cp: /etc/x: Operation not permitted', 'darwin')).toBe('denied');
    expect(sandboxDenial("Error: EPERM: operation not permitted, open '/Users/u/.npmrc'", 'darwin')).toBe('denied');
    expect(sandboxDenial("PermissionError: [Errno 1] Operation not permitted: '/Users/u/x'", 'darwin')).toBe('denied');
    expect(sandboxDenial('open /Users/u/go/x: operation not permitted', 'darwin')).toBe('denied');
    expect(sandboxDenial("expected '/admin/users: operation not permitted' to be 'ok'", 'darwin')).toBeUndefined();
    expect(sandboxDenial('Error: Operation not permitted (os error 1)', 'linux')).toBe('denied');
    expect(sandboxDenial('FAIL src/a.test.ts\nexpected 1 to be 2', 'darwin')).toBeUndefined();
    // A test's own words about a host or a permission are its own failure, not the sandbox's.
    expect(sandboxDenial('getaddrinfo ENOTFOUND no-such-host.invalid', 'linux')).toBeUndefined();
    expect(sandboxDenial("expected 'Operation not permitted for guests' to be 'ok'", 'darwin')).toBeUndefined();
  });

  it('keeps the end of the output, without the noise the sandbox’s proxy makes in Node', () => {
    const out = keptOutput(
      'a\r\n(node:1) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental\n(Use `node --trace-warnings ...`)\nb\n\n',
    );
    expect(out).toBe('a\nb');
    expect(keptOutput('x'.repeat(50), 10)).toBe(`…\n${'x'.repeat(10)}`);
  });
});

describe('where a command runs', () => {
  it('in the first working directory, a folder in it, or a full path inside any of them', () => {
    const other = join(dir, 'other');
    mkdirSync(join(dir, 'app'));
    mkdirSync(other);
    expect(commandCwd({}, [dir, other])).toBe(dir);
    expect(commandCwd({ cwd: 'app' }, [dir, other])).toBe(join(dir, 'app'));
    expect(commandCwd({ cwd: other }, [dir, other])).toBe(other);
    expect(commandCwd({ cwd: 'missing' }, [dir])).toBeUndefined();
    expect(commandCwd({ cwd: tmpdir() }, [dir])).toBeUndefined();
    expect(commandCwd({}, [])).toBeUndefined();
  });
});

describe('how a command went', () => {
  const cmd = { id: 'c1', run: 'npm test' };
  const of = (res: { code: number | null; timedOut?: boolean; output?: string }, sandboxed = true, platform: NodeJS.Platform = 'darwin') =>
    withLang('en', () => commandOutcome(cmd, { timedOut: false, output: '', ...res }, { sandboxed, platform, durationMs: 5 }));

  it('passed on exit 0, failed otherwise, with its output kept', () => {
    expect(of({ code: 0 })).toMatchObject({
      rule: 'command',
      status: 'passed',
      commandId: 'c1',
      command: 'npm test',
      exitCode: 0,
      durationMs: 5,
    });
    expect(of({ code: 1, output: '1 failed' })).toMatchObject({ status: 'failed', exitCode: 1, output: '1 failed' });
    expect(of({ code: 0 }, false)).toMatchObject({ unsandboxed: true });
  });

  it('could not run when the sandbox refused it, its program is missing or it timed out: never failed', () => {
    const denied = of({ code: 1, output: 'listen EPERM: operation not permitted 127.0.0.1' });
    expect(denied.status).toBe('error');
    expect(denied.reason).toContain('Allow every local port');
    expect(of({ code: 127 })).toMatchObject({ status: 'error', reason: expect.stringContaining('exit 127') });
    expect(of({ code: null, timedOut: true })).toMatchObject({ status: 'error', reason: expect.stringContaining('10 minutes') });
    // Outside the sandbox, the same words are the tests' own.
    expect(of({ code: 1, output: 'listen EPERM 127.0.0.1' }, false).status).toBe('failed');
    // A pass is a pass, whatever it printed.
    expect(of({ code: 0, output: 'listen EPERM 127.0.0.1' }).status).toBe('passed');
    // Stopped (Stop, shutdown, a deleted chat): it did not finish, which says nothing of the team's work.
    expect(
      withLang('en', () =>
        commandOutcome(
          cmd,
          { code: null, timedOut: false, aborted: true, output: '1 failed' },
          { sandboxed: true, platform: 'darwin', durationMs: 1 },
        ),
      ),
    ).toMatchObject({
      status: 'error',
      reason: 'Stopped.',
    });
  });
});

describe('the settings checks read', () => {
  it('finds test and lint configuration anywhere, and the files a command names, as full paths', () => {
    const app = join(dir, 'app');
    const named = new Set(namedFiles('./scripts/check.sh && npm test -- --config=ci/vitest.ts', app));
    expect([...named]).toEqual([join(app, 'scripts', 'check.sh'), join(app, 'ci', 'vitest.ts')]);
    const at = (...p: string[]) => join(dir, ...p);
    expect(
      checkConfigFiles(
        [
          at('src', 'app.ts'),
          at('eslint.config.js'),
          at('apps', 'web', 'vitest.config.ts'),
          at('tsconfig.build.json'),
          at('app', 'scripts', 'check.sh'),
          at('scripts', 'check.sh'),
          at('app', 'ci', 'vitest.ts'),
          at('.npmrc'),
          at('jest.config.json'),
          at('src', 'setupTests.ts'),
          at('package.json'),
          at('README.md'),
        ],
        named,
      ),
    ).toEqual([
      at('eslint.config.js'),
      at('apps', 'web', 'vitest.config.ts'),
      at('tsconfig.build.json'),
      at('app', 'scripts', 'check.sh'),
      at('app', 'ci', 'vitest.ts'),
      at('.npmrc'),
      at('jest.config.json'),
      at('src', 'setupTests.ts'),
    ]);
  });
});

describe('running a command', () => {
  const place = (o: Partial<CheckCommandPlace> = {}): CheckCommandPlace => ({
    cwds: [dir],
    unsandboxed: true,
    protectedPaths: [],
    privateRoots: [],
    ...o,
  });
  const deps = (o: Partial<CheckCommandDeps> = {}): CheckCommandDeps => ({
    platform: 'darwin',
    sandboxCommand: vi.fn(),
    runProcess,
    runShellScript,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SECRET_TOKEN: 'shh' },
    sandboxAvailable: async () => ({ ok: true }),
    makeRunDirs: () => {
      const tmp = join(dir, 'run', 'tmp');
      mkdirSync(tmp, { recursive: true });
      return { tmp, hostTmp: join(dir, 'run', 'host') };
    },
    ...o,
  });

  it.skipIf(process.platform === 'win32')(
    'with full access, runs it in a shell of its own, with none of the server’s secrets',
    async () => {
      const passed = await runCheckCommand({ id: 'a', run: 'test -z "$SECRET_TOKEN" && test "$CI" = 1 && pwd' }, place(), deps());
      expect(passed).toMatchObject({ status: 'passed', exitCode: 0, unsandboxed: true, output: dir });
      const failed = await runCheckCommand({ id: 'b', run: 'echo out; echo err >&2; exit 3' }, place(), deps());
      expect(failed).toMatchObject({ status: 'failed', exitCode: 3, output: 'out\nerr' });
    },
  );

  it('below full access, runs it in Harness Relay’s sandbox: no network, the working directories, and only what the command asks for', async () => {
    const dispose = vi.fn(async () => undefined);
    const sandboxCommand = vi.fn(async (bin: string, args: string[], env: NodeJS.ProcessEnv, spec: RelaySandboxSpec) => ({
      bin: 'host',
      args: ['--host'],
      env: { ...env, HOST: '1' },
      channel: {} as never,
      failure: () => undefined,
      dispose,
      run: {} as never,
      seen: { bin, args, spec },
    }));
    const run = vi.fn(async () => result({ code: 0, stdout: 'ok' }));
    const other = join(dir, 'other');
    mkdirSync(other);
    const d = deps({ sandboxCommand: sandboxCommand as never, runProcess: run as never });
    const outcome = await runCheckCommand(
      { id: 'a', run: 'npm test', localPorts: true, unixSockets: true },
      place({ unsandboxed: false, cwds: [dir, other], protectedPaths: ['/p'], privateRoots: ['/r'] }),
      d,
    );
    expect(outcome).toMatchObject({ status: 'passed', output: 'ok' });
    expect(outcome.unsandboxed).toBeUndefined();
    const [bin, args, env, spec] = sandboxCommand.mock.calls[0]!;
    expect(bin).toBe('/bin/sh');
    // A fixed script: the command line is in the environment, never in the arguments.
    expect(args).toEqual(['-c', 'exec 2>&1; eval "$RELAY_CHECK_COMMAND"']);
    expect(env.RELAY_CHECK_COMMAND).toBe('npm test');
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.npm_config_cache).toContain(spec.dirs!.tmp);
    expect(spec).toMatchObject({
      permission: 'edit',
      cwd: dir,
      extraCwds: [other],
      allowedHosts: [],
      protectedPaths: ['/p'],
      privateRoots: ['/r'],
      allowUnixSocketsInTmp: true,
      allowLocalBinding: true,
    });
    // Each opening on its own system only.
    expect(spec.allowAllUnixSockets).toBeUndefined();
    expect(spec.requestApproval).toBeUndefined();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ bin: 'host', args: ['--host'], cwd: dir, timeoutMs: 600_000 }));
    expect(dispose).toHaveBeenCalledOnce();

    await runCheckCommand({ id: 'b', run: 'x', localPorts: true, unixSockets: true }, place({ unsandboxed: false }), {
      ...d,
      platform: 'linux',
    });
    const linux = sandboxCommand.mock.calls[1]![3];
    expect(linux.allowAllUnixSockets).toBe(true);
    expect(linux.allowLocalBinding).toBeUndefined();
    expect(linux.allowUnixSocketsInTmp).toBeUndefined();
  });

  it('cannot run where the sandbox cannot start, when the sandbox stopped it, on Windows, or outside the working directories', async () => {
    const refusing = deps({
      sandboxCommand: vi.fn(async () => {
        throw new AgentRunError('bubblewrap is missing');
      }) as never,
    });
    expect(await runCheckCommand({ id: 'a', run: 'x' }, place({ unsandboxed: false }), refusing)).toMatchObject({
      status: 'error',
      reason: 'bubblewrap is missing',
    });
    const failing = deps({
      sandboxCommand: vi.fn(async () => ({
        bin: 'h',
        args: [],
        env: {},
        channel: {},
        failure: () => 'seatbelt said no',
        dispose: async () => undefined,
      })) as never,
      runProcess: vi.fn(async () => result({ code: 1 })) as never,
    });
    expect(await runCheckCommand({ id: 'a', run: 'x' }, place({ unsandboxed: false }), failing)).toMatchObject({
      status: 'error',
      reason: 'seatbelt said no',
    });
    // A host the sandbox refused says it needed the network, whatever its client printed.
    const offline = deps({
      sandboxCommand: vi.fn(async () => ({
        bin: 'h',
        args: [],
        env: {},
        channel: {},
        failure: () => undefined,
        dispose: async () => undefined,
        run: { refusedHosts: ['registry.npmjs.org'] },
      })) as never,
      runProcess: vi.fn(async () => result({ code: 1, stdout: 'npm error code E403' })) as never,
    });
    expect(await withLang('en', () => runCheckCommand({ id: 'a', run: 'npm ci' }, place({ unsandboxed: false }), offline))).toMatchObject({
      status: 'error',
      reason: expect.stringContaining('registry.npmjs.org'),
    });
    // A host its tooling called (telemetry, say) was refused, but its tests failed for reasons of their own.
    const telemetry = deps({
      sandboxCommand: vi.fn(async () => ({
        bin: 'h',
        args: [],
        env: {},
        channel: {},
        failure: () => undefined,
        dispose: async () => undefined,
        run: { refusedHosts: ['telemetry.example'] },
      })) as never,
      runProcess: vi.fn(async () => result({ code: 1, stdout: 'FAIL src/a.test.ts\nexpected 1 to be 2' })) as never,
    });
    expect(
      await withLang('en', () => runCheckCommand({ id: 'a', run: 'npm test' }, place({ unsandboxed: false }), telemetry)),
    ).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('telemetry.example'),
    });
    await withLang('en', async () => {
      expect(await runCheckCommand({ id: 'a', run: 'x' }, place(), deps({ platform: 'win32' }))).toMatchObject({
        reason: expect.stringContaining('Windows'),
        notRun: 'platform',
      });
      expect((await runCheckCommand({ id: 'a', run: 'x', cwd: 'nope' }, place(), deps())).reason).toContain('"nope"');
    });
  });

  it('says a command that ran past its time limit could not finish', async () => {
    const slow = deps({ runShellScript: vi.fn(async () => result({ code: null, timedOut: true, stdout: 'still going' })) as never });
    const outcome = await withLang('en', () => runCheckCommand({ id: 'a', run: 'sleep 999', timeoutMin: 2 }, place(), slow));
    expect(outcome).toMatchObject({ status: 'error', exitCode: null, output: 'still going', reason: expect.stringContaining('2 minutes') });
    expect(slow.runShellScript).toHaveBeenCalledWith('/bin/sh', [], expect.any(String), expect.objectContaining({ timeoutMs: 120_000 }));
  });
});

describe('the dependencies a check tree is given', () => {
  it.skipIf(process.platform === 'win32')(
    'links each package of every node_modules, and a venv, only where the tree has the folder, its caches left out',
    async () => {
      const { linkDependencies } = await import('../src/server/checkCommands');
      const { lstatSync, readlinkSync, existsSync } = await import('node:fs');
      const real = join(dir, 'real');
      const tree = join(dir, 'tree');
      for (const p of [
        'node_modules/vitest',
        'node_modules/@scope/pkg',
        'node_modules/.vite',
        'packages/a/node_modules/x',
        '.venv/bin',
        'dist/node_modules/y',
        'home/node_modules/z',
      ])
        mkdirSync(join(real, p), { recursive: true });
      // The tree has the project's folders, not the ignored ones (dist), and a node_modules of its own in b.
      mkdirSync(join(tree, 'packages', 'a'), { recursive: true });
      mkdirSync(join(tree, 'packages', 'b', 'node_modules'), { recursive: true });
      mkdirSync(join(real, 'packages', 'b', 'node_modules', 'own'), { recursive: true });
      mkdirSync(join(tree, 'home'), { recursive: true });
      expect(linkDependencies(real, tree, [join(real, 'home')])).toBe(3);
      expect(lstatSync(join(tree, 'node_modules')).isDirectory()).toBe(true);
      expect(readlinkSync(join(tree, 'node_modules', 'vitest'))).toBe(join(real, 'node_modules', 'vitest'));
      // A scope's folder is the tree's own, with a link for each of its packages.
      expect(lstatSync(join(tree, 'node_modules', '@scope')).isDirectory()).toBe(true);
      expect(readlinkSync(join(tree, 'node_modules', '@scope', 'pkg'))).toBe(join(real, 'node_modules', '@scope', 'pkg'));
      expect(existsSync(join(tree, 'node_modules', '.vite'))).toBe(false);
      expect(readlinkSync(join(tree, 'packages', 'a', 'node_modules', 'x'))).toBe(join(real, 'packages', 'a', 'node_modules', 'x'));
      expect(readlinkSync(join(tree, '.venv'))).toBe(join(real, '.venv'));
      // Its own node_modules is left as it is; nothing in folders it has not, nor in the excluded.
      expect(existsSync(join(tree, 'packages', 'b', 'node_modules', 'own'))).toBe(false);
      expect(existsSync(join(tree, 'dist'))).toBe(false);
      expect(existsSync(join(tree, 'home', 'node_modules'))).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'links a workspace’s own packages to the tree, which has the result, and removes leftover trees without following links',
    async () => {
      const { linkDependencies, clearCheckTrees, checkTreesDir } = await import('../src/server/checkCommands');
      const { readlinkSync, symlinkSync, writeFileSync, existsSync } = await import('node:fs');
      const real = join(dir, 'repo');
      const tree = join(dir, 'tree');
      mkdirSync(join(real, 'packages', 'a'), { recursive: true });
      mkdirSync(join(real, 'packages', 'b'), { recursive: true });
      mkdirSync(join(real, 'node_modules', '@scope'), { recursive: true });
      mkdirSync(join(real, 'node_modules', 'dep'), { recursive: true });
      symlinkSync(join('..', 'packages', 'a'), join(real, 'node_modules', 'a'));
      symlinkSync(join('..', '..', 'packages', 'b'), join(real, 'node_modules', '@scope', 'b'));
      mkdirSync(join(tree, 'packages', 'a'), { recursive: true });
      mkdirSync(join(tree, 'packages', 'b'), { recursive: true });
      linkDependencies(real, tree);
      const realRoot = realpathSync(real);
      expect(readlinkSync(join(tree, 'node_modules', 'a'))).toBe(join(tree, 'packages', 'a'));
      expect(readlinkSync(join(tree, 'node_modules', '@scope', 'b'))).toBe(join(tree, 'packages', 'b'));
      expect(readlinkSync(join(tree, 'node_modules', 'dep'))).toBe(join(realRoot, 'node_modules', 'dep'));
      // A link into an ignored folder of the repository (a built package), which the tree has not, keeps the user's.
      mkdirSync(join(real, 'built-lib'), { recursive: true });
      const tree2 = join(dir, 'tree2');
      mkdirSync(tree2, { recursive: true });
      symlinkSync(join('..', 'built-lib'), join(real, 'node_modules', 'built'));
      linkDependencies(real, tree2);
      expect(readlinkSync(join(tree2, 'node_modules', 'built'))).toBe(join(realRoot, 'node_modules', 'built'));
      // A stopped server's trees go, and what they link to stays.
      const data = join(dir, 'data');
      const left = join(checkTreesDir(data), 'x', '0');
      mkdirSync(join(left, 'node_modules'), { recursive: true });
      writeFileSync(join(real, 'node_modules', 'dep', 'keep.txt'), 'keep');
      symlinkSync(join(real, 'node_modules', 'dep'), join(left, 'node_modules', 'dep'));
      clearCheckTrees(data);
      expect(existsSync(checkTreesDir(data))).toBe(false);
      expect(existsSync(join(real, 'node_modules', 'dep', 'keep.txt'))).toBe(true);
    },
  );
});
