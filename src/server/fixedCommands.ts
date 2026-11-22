import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXED_COMMAND_NEWS, HANDOFF_LIMITS, SECRET_NAME_RE, type FixedCommand, type FixedCommandRun } from '../shared/types';
import { maskValues, secretValueProblem } from '../shared/handoffs';
import type { CompiledPattern } from '../shared/checks';
import { AgentRunError } from './agents/types';
import { diffManifests, takeManifest, TooManyFiles } from './checks';
import { CONFIG_FILE, checkEnv, commandCwd, keptOutput, sandboxDenial } from './checkCommands';
import type { CommandPin } from './handoffs';
import { t } from './i18n';
import { runProcess, type SpawnResult } from './process';
import {
  makeRunDirs,
  removeRunDirs,
  sandboxAvailable,
  sandboxCommand,
  type RelaySandboxRunDirs,
  type SandboxAvailability,
} from './relaySandbox';
import { diffText, keepCommits, dropKeptCommits, repoRoot, snapshot } from './workspace';

/*
 * Fixed commands (docs/architecture.md, "Secrets and fixed commands"): a command line the user saved
 * for a working directory, which Harness Relay runs itself, never an agent:
 *
 * - always in Harness Relay's own sandbox (`sandboxCommand()`, as team checks' commands below full
 *   access), whatever the conversation's permission: writing only in the working directory and the
 *   run's own folder, the protected paths unreadable, the network only to the command's own hosts, and
 *   not at all where that sandbox cannot start (native Windows among them);
 * - through the fixed shell script check commands use, the command line in the environment, with an
 *   environment of its own (`checkEnv()`), never the server's;
 * - its secrets in a file in the run's own folder (`RELAY_SECRETS_FILE`, one `NAME=value` a line), never
 *   in its environment or command line; values it wrote there for its own names are kept after the run
 *   (a token it renewed);
 * - its output, before it goes anywhere, with every value the folder holds replaced by dots;
 * - pinned to the code in its folder (`PIN_PATTERN`): a run whose code changed since the user saved it
 *   (or approved its changes) does not run, and says what changed.
 */

/** The shell script every command runs in: its output and errors together, the command line from the environment (as checks'). */
const SCRIPT = 'exec 2>&1; eval "$RELAY_CHECK_COMMAND"';

/** File endings of code a command may run or load: scripts, compiled modules and native libraries. */
const CODE_ENDINGS = [
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'node',
  'wasm',
  'py',
  'pyw',
  'pyc',
  'pyo',
  'pth',
  'pyd',
  'rb',
  'pl',
  'pm',
  'php',
  'lua',
  'r',
  'jl',
  'tcl',
  'awk',
  'so',
  'dylib',
  'dll',
  'jar',
  'class',
];

/**
 * What a fixed command is pinned to: in its folder, at any depth, every file of code (`CODE_ENDINGS`),
 * the test, lint and build configuration checks watch (`CONFIG_FILE`), `package.json` and the lock files
 * that say what installs. Folders of installed packages (`node_modules`, `.venv`…) are passed over from
 * the top, as snapshots pass over them.
 */
export const PIN_PATTERN: CompiledPattern = {
  source: '(fixed command code)',
  base: '',
  regex: new RegExp(
    `(?:^|/)(?:[^/]*\\.(?:${CODE_ENDINGS.join('|')})|${CONFIG_FILE.source.slice(1, -1)}|package\\.json|requirements[^/]*\\.txt|Pipfile(?:\\.lock)?|poetry\\.lock|uv\\.lock|Gemfile(?:\\.lock)?|\\.env[^/]*|\\.python-version|\\.tool-versions)$`,
    'i',
  ),
};

/** The ref folder a command's pinned snapshot is kept under (`refs/harness-relay/commands/<id>/…`). */
const pinKey = (id: string) => `commands/${id}`;

/** A command's code now: the manifest of its folder, and a snapshot of its repository to show a diff from. */
export async function takePin(folder: string, id: string): Promise<CommandPin> {
  let manifest;
  try {
    manifest = await takeManifest(folder, [PIN_PATTERN], { maxEntries: 200_000 });
  } catch (err) {
    if (err instanceof TooManyFiles) throw new AgentRunError(t().handoffs.tooManyFiles(HANDOFF_LIMITS.pinnedFiles));
    throw err;
  }
  if (Object.keys(manifest).length > HANDOFF_LIMITS.pinnedFiles)
    throw new AgentRunError(t().handoffs.tooManyFiles(HANDOFF_LIMITS.pinnedFiles));
  const root = (await repoRoot(folder).catch(() => null)) ?? undefined;
  if (!root) return { manifest };
  try {
    const { commit } = await snapshot(root);
    await keepCommits(root, pinKey(id), [commit]);
    return { manifest, root, commit };
  } catch {
    return { manifest };
  }
}

/** Drops a pin's kept snapshot (its command was removed, or pinned again). */
export async function dropPin(id: string, pin: CommandPin | undefined): Promise<void> {
  if (!pin?.root) return;
  await dropKeptCommits(pin.root, pinKey(id)).catch(() => undefined);
}

/** The pinned files that changed, were added or went since the pin, relative to the folder; empty when none did. */
export async function pinChanges(folder: string, pin: CommandPin): Promise<string[]> {
  const now = await takeManifest(folder, [PIN_PATTERN], { previous: pin.manifest, maxEntries: 200_000 });
  return diffManifests(pin.manifest, now).map((c) => c.path);
}

/**
 * The diff of a command's changed files since its pin, from its pinned snapshot to one taken now (git's
 * diff, for the files git does not ignore), at most `max` characters; '' when there is none to show.
 */
export async function pinDiff(folder: string, pin: CommandPin, changed: readonly string[], max = 60_000): Promise<string> {
  if (!pin.root || !pin.commit || !changed.length) return '';
  const { commit } = await snapshot(pin.root);
  const rel = folder === pin.root ? undefined : folder;
  const full = await diffText(pin.root, pin.commit, commit, rel);
  // Only the sections of the files that changed.
  const sections = full.split(/(?=^diff --git )/m).filter((s) => changed.some((p) => s.includes(` b/${p}\n`) || s.includes(`/${p}\n`)));
  const text = sections.join('');
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** What `runFixedCommand` needs (swapped in tests). */
export interface FixedCommandDeps {
  platform: NodeJS.Platform;
  sandboxCommand: typeof sandboxCommand;
  runProcess: typeof runProcess;
  env: NodeJS.ProcessEnv;
  makeRunDirs: () => RelaySandboxRunDirs;
  sandboxAvailable: () => Promise<SandboxAvailability>;
}

export const defaultFixedCommandDeps: FixedCommandDeps = {
  platform: process.platform,
  sandboxCommand,
  runProcess,
  env: process.env,
  makeRunDirs: () => makeRunDirs(),
  sandboxAvailable: () => sandboxAvailable(),
};

/** What one run is given. */
export interface FixedRunInput {
  /** The folder's secret values, by name: the run gets those the command names; all of them are masked. */
  values: Record<string, string>;
  /** What the command reads on its standard input (an outbox run). */
  stdin?: string;
  /** Words added to the command line for this run only (Try it). */
  extra?: string;
  /** Neither readable nor writable (`protectedReads()`). */
  protectedPaths: string[];
  /** Other runs' own folders, not readable (`privateRoots()`). */
  privateRoots: string[];
  signal?: AbortSignal;
}

/** A run's outcome, and the values of its own secrets it wrote that differ from what it was given. */
export interface FixedRunResult {
  run: FixedCommandRun;
  written: Record<string, string>;
}

/** A dotenv file's lines as Harness Relay writes them: `NAME=value`, the value as it is after the first `=`. */
export function secretsFile(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${value}\n`)
    .join('');
}

/** The values a run left in its secrets file, by name (lines `NAME=value`; others ignored). */
export function readSecretsFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && SECRET_NAME_RE.test(m[1]!)) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Runs a fixed command once and says how it went (never throws for the command or the sandbox). */
export async function runFixedCommand(
  cmd: FixedCommand,
  source: FixedCommandRun['source'],
  input: FixedRunInput,
  deps: FixedCommandDeps = defaultFixedCommandDeps,
): Promise<FixedRunResult> {
  const at = Date.now();
  const allValues = Object.values(input.values);
  const errorRun = (reason: string): FixedRunResult => ({
    run: { at, source, status: 'error', reason: maskValues(reason, allValues) },
    written: {},
  });
  if (deps.platform === 'win32') return errorRun(t().handoffs.windows);
  const missing = cmd.secrets.filter((n) => input.values[n] === undefined);
  if (missing.length) return errorRun(t().handoffs.missingSecrets(missing.join(', ')));
  const cwd = commandCwd({ ...(cmd.cwd ? { cwd: cmd.cwd } : {}) }, [cmd.folder]);
  if (!cwd) return errorRun(t().checksCommandNoFolder(cmd.cwd ?? cmd.folder));
  if (input.stdin !== undefined && new TextEncoder().encode(input.stdin).length > HANDOFF_LIMITS.input) {
    return errorRun(t().handoffs.inputTooLong(HANDOFF_LIMITS.input));
  }
  const line = input.extra?.trim() ? `${cmd.run} ${input.extra.trim()}` : cmd.run;
  const own = Object.fromEntries(cmd.secrets.map((n) => [n, input.values[n]!]));

  let dirs: RelaySandboxRunDirs | undefined;
  let disposed = false;
  try {
    dirs = deps.makeRunDirs();
    for (const dir of ['npm-cache', 'cache', 'pycache', 'go-build', 'corepack']) mkdirSync(join(dirs.tmp, dir), { recursive: true });
    const file = join(dirs.tmp, 'secrets.env');
    writeFileSync(file, secretsFile(own), { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    const env = { ...checkEnv(deps.env, line, dirs.tmp), RELAY_SECRETS_FILE: file };
    const sandboxed = await deps.sandboxCommand('/bin/sh', ['-c', SCRIPT], env, {
      permission: 'edit',
      cwd,
      extraCwds: [],
      writable: [],
      readOnly: [],
      protectedPaths: input.protectedPaths,
      allowedHosts: [...cmd.hosts],
      privateRoots: input.privateRoots,
      dirs,
      ...(deps.platform === 'darwin' ? { allowUnixSocketsInTmp: true } : {}),
    });
    let res: SpawnResult;
    let left: Record<string, string> = {};
    try {
      res = await deps.runProcess({
        bin: sandboxed.bin,
        args: sandboxed.args,
        env: sandboxed.env,
        channel: sandboxed.channel,
        cwd,
        signal: input.signal,
        timeoutMs: HANDOFF_LIMITS.timeoutMin * 60_000,
        maxCapture: HANDOFF_LIMITS.output * 4,
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      });
      const failure = sandboxed.failure();
      if (failure) return errorRun(failure);
    } finally {
      disposed = true;
      // What it left in its secrets file, read before its folder goes.
      left = existsSync(file) ? readSecretsFile(readFileSync(file, 'utf8')) : {};
      await sandboxed.dispose();
    }
    const written: Record<string, string> = {};
    for (const name of cmd.secrets) {
      const value = left[name]?.trim();
      if (value !== undefined && value !== own[name] && !secretValueProblem(value)) written[name] = value;
    }
    const masks = [...allValues, ...Object.values(written)];
    const output = res.stdout ? maskValues(keptOutput(res.stdout, HANDOFF_LIMITS.output), masks) : '';
    const base: FixedCommandRun = {
      at,
      source,
      status: 'passed',
      exitCode: res.code,
      durationMs: Date.now() - at,
      ...(output ? { output } : {}),
    };
    const refused = sandboxed.run?.refusedHosts ?? [];
    if (res.aborted) return { run: { ...base, status: 'error', reason: t().stoppedNote }, written };
    if (res.timedOut) return { run: { ...base, status: 'error', reason: t().handoffs.timedOut(HANDOFF_LIMITS.timeoutMin) }, written };
    if (res.code === 0) return { run: base, written };
    if (res.code === FIXED_COMMAND_NEWS) return { run: { ...base, status: 'news' }, written };
    if (res.code === 127) return { run: { ...base, status: 'error', reason: t().checksCommandNotFound }, written };
    const denial = sandboxDenial(res.stdout, deps.platform);
    const reason = refused.length
      ? t().handoffs.hostsRefused(refused.join(', '))
      : denial === 'network'
        ? t().handoffs.networkRefused
        : denial
          ? t().handoffs.sandboxRefused
          : undefined;
    return { run: { ...base, status: 'failed', ...(reason ? { reason } : {}) }, written };
  } catch (err) {
    return errorRun(err instanceof AgentRunError ? err.message : (err as Error).message);
  } finally {
    if (dirs && !disposed) removeRunDirs(dirs);
  }
}
