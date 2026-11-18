import { existsSync, mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { CHECK_LIMITS, CHECK_RESULT_LIMITS, type CheckCommand, type CheckOutcome } from '../shared/types';
import { AgentRunError } from './agents/types';
import { t } from './i18n';
import { runProcess, runShellScript, type SpawnResult } from './process';
import {
  PROJECT_AGENT_CONFIG,
  isWithin,
  makeRunDirs,
  removeRunDirs,
  sandboxAvailable,
  sandboxCommand,
  type RelaySandboxRunDirs,
  type SandboxAvailability,
  type RelaySandboxSpec,
} from './relaySandbox';

/*
 * Team checks' commands (`CheckList.commands`): a test suite, a linter, a team script, run once the
 * team has answered. Below full access in Harness Relay's own sandbox (`sandboxCommand()`), with no
 * network, writing only in the working directories and the run's own temporary folder, and with the
 * protected paths unreadable; it fails closed (the check could not run). With full access without one,
 * as the agents ran. Either way with an environment of its own, never the server's (no API key, no
 * token), and through a fixed shell script that reads the command line from the environment.
 *
 * A command that the sandbox stopped looks like one that failed: it exits non-zero with its runner's
 * usual "1 failed". So its output is read for the sandbox's refusals (`sandboxDenial()`): such a check
 * could not run, and says which opening it would need, never that the team's work failed.
 */

/** The shell script every command runs in: its output and errors together, the command line from the environment. */
const SCRIPT = 'exec 2>&1; eval "$RELAY_CHECK_COMMAND"';

/** Variables of the server's environment a command gets (and those that start with `LC_`); everything else stays out. */
const KEPT_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TZ'];

/**
 * The names Linux's sandbox mounts `/dev/null` on at the top of a working directory when they are not
 * there (sandbox-runtime's own, and `PROJECT_AGENT_CONFIG`'s first names): reading one fails with EACCES.
 */
const PHANTOM_NAMES = [
  ...new Set([
    '.gitconfig',
    '.gitmodules',
    '.bashrc',
    '.bash_profile',
    '.zshrc',
    '.zprofile',
    '.profile',
    '.ripgreprc',
    '.mcp.json',
    '.vscode',
    '.idea',
    ...PROJECT_AGENT_CONFIG.map((p) => p.split('/')[0]!),
  ]),
];

/**
 * The environment a command runs with: the server's PATH, home, user, shell and locale, nothing else;
 * `CI=1` (test runners then refuse to write a missing snapshot rather than pass), plain output, and in
 * the sandbox the tools' caches in the run's own temporary folder (the home folder is not writable there).
 */
export function checkEnv(base: NodeJS.ProcessEnv, command: string, tmp?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && (KEPT_ENV.includes(k) || k.startsWith('LC_'))) env[k] = v;
  Object.assign(env, { TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', RELAY_CHECK_COMMAND: command });
  if (tmp) {
    Object.assign(env, {
      npm_config_cache: join(tmp, 'npm-cache'),
      npm_config_update_notifier: 'false',
      XDG_CACHE_HOME: join(tmp, 'cache'),
      PYTHONPYCACHEPREFIX: join(tmp, 'pycache'),
      GOCACHE: join(tmp, 'go-build'),
      COREPACK_HOME: join(tmp, 'corepack'),
    });
  }
  return env;
}

/** What the sandbox refused, as a command's output shows it. */
export type SandboxDenial = 'localPorts' | 'unixSockets' | 'readOnly' | 'phantom' | 'browser' | 'network' | 'denied';

const PHANTOM_RE = new RegExp(
  `EACCES[^\\n]*[/\\\\](?:${PHANTOM_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=['"\\s:)]|$)`,
  'm',
);

/** The first thing in a sandboxed command's output that the sandbox refused, if any. */
export function sandboxDenial(output: string, platform: NodeJS.Platform): SandboxDenial | undefined {
  if (/\b(?:listen|bind|connect) EPERM:?[^\n]*?(?:\/|\\\\)[^\s'"]*(?:\.sock|socket)\b/i.test(output)) return 'unixSockets';
  if (platform === 'linux' && /\b(?:listen|bind) EPERM:?[^\n]*?\s\//.test(output)) return 'unixSockets';
  if (platform === 'darwin' && /\b(?:listen|bind|connect) EPERM:?[^\n]*?(?:127\.0\.0\.1|0\.0\.0\.0|::1|\[::\]|localhost)/.test(output))
    return 'localPorts';
  if (/\bEROFS\b|Read-only file system/.test(output)) return 'readOnly';
  if (platform === 'linux' && PHANTOM_RE.test(output)) return 'phantom';
  if (
    /Failed to launch the browser process|browserType\.launch|Target page, context or browser has been closed|The browser (?:has been )?closed/.test(
      output,
    )
  )
    return 'browser';
  // The sandbox's own words for a host it refused (`DENY_REASONS`), or no name service at all (Linux).
  if (
    /is not among the hosts this run may reach|not reachable from Harness Relay's sandbox|Harness Relay's sandbox does not let programs reach|\bEAI_AGAIN\b/.test(
      output,
    )
  ) {
    return 'network';
  }
  // A file system call refused: Node's words for one, or a shell's (`sh: <path>: Operation not permitted`).
  if (
    /\bEPERM: operation not permitted, (?:open|mkdir|rmdir|unlink|rename|scandir|copyfile|symlink|link|utime|chmod|access|write|lstat|stat)\b/.test(
      output,
    )
  ) {
    return 'denied';
  }
  if (/: Operation not permitted\s*$/m.test(output)) return 'denied';
  // Python's, Go's and Rust's words for the same.
  if (/\[Errno 1\] Operation not permitted|\S\/\S*: operation not permitted\b|Operation not permitted \(os error 1\)/.test(output))
    return 'denied';
  return undefined;
}

/** A command's output as kept: the noise the sandbox's proxy variables make in Node left out, and its end only. */
export function keptOutput(output: string, max: number = CHECK_RESULT_LIMITS.output): string {
  const lines = output
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/\[UNDICI-EHPA\]|EnvHttpProxyAgent is experimental|Use `node --trace-warnings/.test(l));
  const text = lines.join('\n').trimEnd();
  return text.length > max ? `…\n${text.slice(text.length - max)}` : text;
}

/**
 * Where a command runs: its folder relative to the first working directory, or a full path inside one
 * of them; undefined when it is outside them all or not there.
 */
export function commandCwd(cmd: Pick<CheckCommand, 'cwd'>, cwds: readonly string[]): string | undefined {
  const first = cwds[0];
  if (!first) return undefined;
  const dir = cmd.cwd ? (isAbsolute(cmd.cwd) ? normalize(cmd.cwd) : join(first, cmd.cwd)) : first;
  if (!cwds.some((c) => isWithin(dir, c))) return undefined;
  return existsSync(dir) ? dir : undefined;
}

/**
 * How a run of a command went, as a rule's outcome: passed when it exited 0; could not run when it was
 * stopped by its time limit, its program was not found or the sandbox refused something it needed (the
 * opening that would let it, said); failed otherwise.
 */
export function commandOutcome(
  cmd: CheckCommand,
  res: Pick<SpawnResult, 'code' | 'timedOut'> & { output: string; aborted?: boolean },
  o: { sandboxed: boolean; platform: NodeJS.Platform; durationMs: number; refusedHosts?: readonly string[] },
): CheckOutcome {
  const base: CheckOutcome = {
    rule: 'command',
    status: 'passed',
    commandId: cmd.id,
    command: cmd.run,
    exitCode: res.code,
    durationMs: o.durationMs,
    ...(res.output ? { output: keptOutput(res.output) } : {}),
    ...(o.sandboxed ? {} : { unsandboxed: true }),
  };
  // The hosts the sandbox refused it say so better than its output, where a client shows a status at most.
  const refused = o.sandboxed && o.refusedHosts?.length ? o.refusedHosts : undefined;
  const denial = refused ? 'network' : o.sandboxed ? sandboxDenial(res.output, o.platform) : undefined;
  const denialText = refused
    ? t().checksNetworkRefused(refused.join(', '))
    : denial &&
      t().checksSandboxDenial(
        denial,
        Boolean(denial === 'localPorts' ? cmd.localPorts : denial === 'unixSockets' ? cmd.unixSockets : false),
      );
  // Stopped (Stop, the server shutting down, the chat deleted): it did not finish, and says nothing of the team's work.
  if (res.aborted) return { ...base, status: 'error', reason: t().stoppedNote, notRun: 'stopped' };
  if (res.timedOut) {
    const reason = t().checksCommandTimedOut(cmd.timeoutMin ?? CHECK_LIMITS.timeoutMin);
    return { ...base, status: 'error', reason: denialText ? `${reason} ${denialText}` : reason };
  }
  if (res.code === 0) return base;
  if (res.code === 127) return { ...base, status: 'error', reason: t().checksCommandNotFound };
  if (denialText) return { ...base, status: 'error', reason: denialText };
  return { ...base, status: 'failed' };
}

/** What `runCheckCommand` needs (swapped in tests). */
export interface CheckCommandDeps {
  platform: NodeJS.Platform;
  sandboxCommand: typeof sandboxCommand;
  runProcess: typeof runProcess;
  runShellScript: typeof runShellScript;
  /** The server's environment, which a command takes its PATH, home and locale from. */
  env: NodeJS.ProcessEnv;
  /** The sandboxed run's own folders (`makeRunDirs()`, which refuses a data folder whose path is too long). */
  makeRunDirs: () => RelaySandboxRunDirs;
  /** Whether the sandbox can start here (a real one, for a trivial command; kept a while). */
  sandboxAvailable: () => Promise<SandboxAvailability>;
}

export const defaultCheckCommandDeps: CheckCommandDeps = {
  platform: process.platform,
  sandboxCommand,
  runProcess,
  runShellScript,
  env: process.env,
  makeRunDirs: () => makeRunDirs(),
  sandboxAvailable: () => sandboxAvailable(),
};

/**
 * What commands can do on this computer, for the editor: its system, and why the sandbox cannot start
 * here when it cannot (below full access the commands then cannot run). Not on Windows at all yet.
 */
export async function checksEnvironment(deps: CheckCommandDeps = defaultCheckCommandDeps): Promise<{ platform: string; sandbox?: string }> {
  if (deps.platform === 'win32') return { platform: deps.platform, sandbox: t().checksCommandWindows };
  const sandbox = await deps.sandboxAvailable();
  return { platform: deps.platform, ...(sandbox.ok ? {} : { sandbox: sandbox.reason }) };
}

/** Where a command may run and what it may not reach. */
export interface CheckCommandPlace {
  /** The conversation's working directories, the first one first. */
  cwds: string[];
  /** Full access: no sandbox. */
  unsandboxed: boolean;
  /** Below full access: neither readable nor writable (`protectedReads()`). */
  protectedPaths: string[];
  /** Below full access: other runs' own folders (`privateRoots()`), not readable. */
  privateRoots: string[];
  signal?: AbortSignal;
}

/**
 * Run one command and say how it went. Never throws for the command or the sandbox: what kept it from
 * running is its outcome's reason (`error`).
 */
export async function runCheckCommand(
  cmd: CheckCommand,
  place: CheckCommandPlace,
  deps: CheckCommandDeps = defaultCheckCommandDeps,
): Promise<CheckOutcome> {
  const unrun = (reason: string): CheckOutcome => ({ rule: 'command', status: 'error', commandId: cmd.id, command: cmd.run, reason });
  if (deps.platform === 'win32') return { ...unrun(t().checksCommandWindows), notRun: 'platform' };
  const cwd = commandCwd(cmd, place.cwds);
  if (!cwd) return unrun(t().checksCommandNoFolder(cmd.cwd ?? ''));
  const timeoutMs = (cmd.timeoutMin ?? CHECK_LIMITS.timeoutMin) * 60_000;
  const started = Date.now();
  const outcome = (res: SpawnResult, sandboxed: boolean, refusedHosts?: readonly string[]) =>
    commandOutcome(
      cmd,
      { code: res.code, timedOut: res.timedOut, aborted: res.aborted, output: res.stdout },
      { sandboxed, platform: deps.platform, durationMs: Date.now() - started, ...(refusedHosts ? { refusedHosts } : {}) },
    );

  if (place.unsandboxed) {
    try {
      const res = await deps.runShellScript('/bin/sh', [], SCRIPT, {
        cwd,
        env: checkEnv(deps.env, cmd.run),
        signal: place.signal,
        timeoutMs,
        maxCapture: CHECK_RESULT_LIMITS.output * 4,
      });
      return outcome(res, false);
    } catch (err) {
      return unrun((err as Error).message);
    }
  }

  let dirs: RelaySandboxRunDirs | undefined;
  let disposed = false;
  try {
    dirs = deps.makeRunDirs();
    for (const dir of ['npm-cache', 'cache', 'pycache', 'go-build', 'corepack']) mkdirSync(join(dirs.tmp, dir), { recursive: true });
    const spec: RelaySandboxSpec = {
      permission: 'edit',
      cwd,
      extraCwds: place.cwds.filter((c) => c !== cwd),
      writable: [],
      readOnly: [],
      protectedPaths: place.protectedPaths,
      allowedHosts: [],
      privateRoots: place.privateRoots,
      dirs,
      ...(deps.platform === 'darwin' ? { allowUnixSocketsInTmp: true } : {}),
      ...(cmd.localPorts && deps.platform === 'darwin' ? { allowLocalBinding: true } : {}),
      ...(cmd.unixSockets && deps.platform === 'linux' ? { allowAllUnixSockets: true } : {}),
    };
    const sandboxed = await deps.sandboxCommand('/bin/sh', ['-c', SCRIPT], checkEnv(deps.env, cmd.run, dirs.tmp), spec);
    try {
      const res = await deps.runProcess({
        bin: sandboxed.bin,
        args: sandboxed.args,
        env: sandboxed.env,
        channel: sandboxed.channel,
        cwd,
        signal: place.signal,
        timeoutMs,
        maxCapture: CHECK_RESULT_LIMITS.output * 4,
      });
      const failure = sandboxed.failure();
      if (failure) return unrun(failure);
      return outcome(res, true, sandboxed.run?.refusedHosts);
    } finally {
      disposed = true;
      await sandboxed.dispose();
    }
  } catch (err) {
    // The sandbox could not start here (its reason is in the user's language), or the command was not found.
    return unrun(err instanceof AgentRunError ? err.message : (err as Error).message);
  } finally {
    if (dirs && !disposed) removeRunDirs(dirs);
  }
}

/** File names a test or lint run reads its settings from, wherever they are in the working directory. */
const CONFIG_FILE = new RegExp(
  '^(?:' +
    [
      '\\.eslintrc(?:\\..+)?',
      'eslint\\.config\\.[cm]?[jt]s',
      '\\.eslintignore',
      '\\.prettierrc(?:\\..+)?',
      'prettier\\.config\\.[cm]?[jt]s',
      '\\.prettierignore',
      'tsconfig(?:\\..+)?\\.json',
      'jsconfig\\.json',
      '(?:vitest|vite|jest|playwright|babel|karma|mocha|ava)\\.config\\.(?:[cm]?[jt]s|json)',
      'vitest\\.workspace\\.(?:[cm]?[jt]s|json)',
      'karma\\.conf\\.[cm]?js',
      '(?:jest|vitest)\\.setup\\.[cm]?[jt]sx?',
      'setupTests\\.[cm]?[jt]sx?',
      '\\.mocharc(?:\\..+)?',
      '\\.babelrc(?:\\..+)?',
      '\\.c8rc(?:\\..+)?',
      '\\.nycrc(?:\\..+)?',
      // What runs a package's scripts: npm's `script-shell`, Yarn's and Bun's settings.
      '\\.npmrc',
      '\\.yarnrc(?:\\.yml)?',
      'bunfig\\.toml',
      'pytest\\.ini',
      'pyproject\\.toml',
      'setup\\.cfg',
      'tox\\.ini',
      'conftest\\.py',
      '\\.flake8',
      '\\.?ruff\\.toml',
      'mypy\\.ini',
      'Makefile',
      '[Jj]ustfile',
      'Taskfile\\.ya?ml',
      'Cargo\\.toml',
      'go\\.mod',
      '\\.golangci\\.ya?ml',
      'deno\\.jsonc?',
      'biome\\.jsonc?',
    ].join('|') +
    ')$',
);

/** The keys of `package.json` a check reads (its scripts, and test and lint settings kept there). */
export const PACKAGE_JSON_KEYS = ['scripts', 'jest', 'eslintConfig', 'prettier', 'ava', 'mocha', 'c8', 'nyc'];

/**
 * The files a command line names (`./scripts/check.sh`, `--config=ci/vitest.ts`): its words with a
 * folder in them or a script's ending, as full paths from the folder it runs in.
 */
export function namedFiles(run: string, dir: string): string[] {
  return run
    .split(/[\s;&|()<>'"`=]+/)
    .filter((w) => /[/\\]/.test(w) || /\.(?:sh|bash|js|mjs|cjs|ts|mts|cts|py|rb|pl)$/.test(w))
    .map((w) => resolve(dir, w));
}

/**
 * Of the files a run changed (full paths), those its checks read: test and lint configuration anywhere,
 * and the files the command lines name (`named`, full paths). `package.json` is the caller's to judge
 * (only its `PACKAGE_JSON_KEYS` count).
 */
export function checkConfigFiles(changed: readonly string[], named: ReadonlySet<string>): string[] {
  return changed.filter((p) => CONFIG_FILE.test(basename(p)) || named.has(p));
}

/** A path relative to `dir`, `/`-separated, or undefined when it is outside it. */
export function relativeInside(dir: string, path: string): string | undefined {
  const rel = relative(dir, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}
