import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, open, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FIXED_COMMAND_NEWS, HANDOFF_LIMITS, SECRET_NAME_RE, type FixedCommand, type FixedCommandRun } from '../shared/types';
import { UNPINNED_TOP, maskEdges, maskValues, secretValueProblem } from '../shared/handoffs';
import type { CompiledPattern } from '../shared/checks';
import { AgentRunError } from './agents/types';
import { CONFIG_FILE, checkEnv, commandCwd, keptOutput, namedFiles, sandboxDenial } from './checkCommands';
import { hooksPathOf } from './interactive';
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
import { diffPaths, dropKeptCommits, forgetCommits, keepCommits, repoRoot, snapshot } from './workspace';

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

/**
 * What a pin holds of one path: a file's size and SHA-256; or a link's target, with the size and SHA-256
 * of the file it leads to when it leads to one (a link inside the folder may lead to a file the pattern
 * does not take).
 */
export type PinEntry = { kind: 'file'; size: number; hash: string } | { kind: 'link'; target: string; size?: number; hash?: string };

/** Most names a pin's walk visits, and most bytes it reads, before it gives up. */
const PIN_WALK = { entries: 200_000, bytes: 1024 * 1024 * 1024 };

/** A file's SHA-256, read without following a link. */
async function hashFile(abs: string): Promise<string> {
  const handle = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) return '';
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

/** Whether `p` is inside `dir` (or is it). */
const inside = (p: string, dir: string) => {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** What `git init` writes in `[core]`, which says nothing git would run: left out of a pin of the config. */
const INIT_CORE_KEYS = new Set([
  'repositoryformatversion',
  'filemode',
  'bare',
  'logallrefupdates',
  'ignorecase',
  'precomposeunicode',
  'symlinks',
]);

/**
 * A git config file as a pin takes it: its lines but blank ones, comments and what `git init` writes
 * (so that a repository Harness Relay makes for a team's first turn changes nothing), and the files it
 * includes (`include.path`, `includeIf.….path`), as full paths.
 */
export function gitConfigPin(text: string, dir: string): { lines: string; includes: string[] } {
  const kept: string[] = [];
  const includes: string[] = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    const head = /^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]/.exec(line);
    if (head) {
      section = head[1]!.toLowerCase();
      kept.push(line);
      continue;
    }
    const key = /^([\w.-]+)/.exec(line)?.[1]?.toLowerCase() ?? '';
    if (section === 'core' && INIT_CORE_KEYS.has(key)) continue;
    kept.push(line);
    const path = (section === 'include' || section === 'includeif') && key === 'path' ? /=\s*"?([^"]*)"?\s*$/.exec(line)?.[1] : undefined;
    if (path) includes.push(path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(dir, path));
  }
  // Sections left with nothing in them say nothing either.
  const lines = kept.filter((l, i) => !(l.startsWith('[') && (i === kept.length - 1 || kept[i + 1]!.startsWith('['))));
  return { lines: lines.join('\n'), includes };
}

/** The files git runs or reads for a command that runs git there: its config, the worktree's, and its hooks (not git's samples). */
async function gitFiles(folder: string): Promise<[string, string][]> {
  const root = await repoRoot(folder).catch(() => null);
  if (!root) return [];
  let gitDir = join(root, '.git');
  try {
    const st = await lstat(gitDir);
    if (st.isFile()) {
      // A worktree's `.git` file names its folder, which names the repository's own (`commondir`).
      const named = /^gitdir:\s*(.+)$/m.exec(await readFile(gitDir, 'utf8'))?.[1]?.trim();
      if (!named) return [];
      gitDir = resolve(root, named);
    } else if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  const common = await readFile(join(gitDir, 'commondir'), 'utf8')
    .then((c) => resolve(gitDir, c.trim()))
    .catch(() => gitDir);
  const out: [string, string][] = [
    ['.git/config', join(common, 'config')],
    ['.git/config.worktree', join(gitDir, 'config.worktree')],
  ];
  const hooks = async (key: string, dir: string) => {
    for (const name of (await readdir(dir).catch(() => [] as string[])).sort()) {
      if (!name.endsWith('.sample')) out.push([`${key}/${name}`, join(dir, name)]);
    }
  };
  await hooks('.git/hooks', join(common, 'hooks'));
  const set = hooksPathOf(await readFile(join(common, 'config'), 'utf8').catch(() => ''));
  if (set) {
    const dir = set.startsWith('~/') ? join(homedir(), set.slice(2)) : resolve(root, set);
    await hooks(`.git/hooksPath:${dir}`, dir);
  }
  return out;
}

/**
 * What a fixed command's code is now, in its folder:
 * - each file `PIN_PATTERN` matches or that may be run (an executable bit), at any depth, hashed in full
 *   (never a size and a time, which a program can put back);
 * - every link, whatever its name, with the file it leads to hashed; a link that leads out of the folder
 *   (or into `.git`) is refused, as what is behind it could change unseen (one into a top folder of
 *   installed packages is kept by its target, as those folders are not pinned);
 * - the files its command line names (`named`, full paths), wherever they are, hashed through links;
 * - git's configuration and hooks, which a command that runs git runs.
 * It passes over `.git` and, at the top only, the folders of installed packages (`UNPINNED_TOP`).
 */
export async function pinManifest(folder: string, named: readonly string[] = []): Promise<Record<string, PinEntry>> {
  const out: Record<string, PinEntry> = {};
  const real = await realpath(folder).catch(() => folder);
  let seen = 0;
  let bytes = 0;
  let pinned = 0;
  const add = (key: string, entry: PinEntry) => {
    if (!(key in out) && ++pinned > HANDOFF_LIMITS.pinnedFiles)
      throw new AgentRunError(t().handoffs.tooManyFiles(HANDOFF_LIMITS.pinnedFiles));
    out[key] = entry;
  };
  const hashed = async (abs: string, size: number): Promise<string> => {
    bytes += size;
    if (bytes > PIN_WALK.bytes) throw new AgentRunError(t().handoffs.pinTooLarge(Math.round(PIN_WALK.bytes / 1024 / 1024)));
    return hashFile(abs).catch(() => '');
  };
  /** The file a path leads to, through links: its size and hash; none for a path that is not one (it appearing later is a change). */
  const followed = async (abs: string): Promise<PinEntry | undefined> => {
    const to = await realpath(abs).catch(() => undefined);
    const st = to ? await stat(to).catch(() => undefined) : undefined;
    if (!to || !st?.isFile()) return undefined;
    return { kind: 'file', size: st.size, hash: await hashed(to, st.size) };
  };
  /** Where a link leads may be pinned: inside the folder, not in `.git`; a top folder of packages is let be. */
  const leads = (p: string): 'in' | 'packages' | 'out' => {
    const base = inside(p, real) ? real : inside(p, folder) ? folder : undefined;
    if (base === undefined) return 'out';
    const parts = relative(base, p).split(sep).filter(Boolean);
    if (parts.some((x) => x.toLowerCase() === '.git')) return 'out';
    return parts.length && UNPINNED_TOP.includes(parts[0]!.toLowerCase()) ? 'packages' : 'in';
  };
  const link = async (rel: string, abs: string): Promise<PinEntry> => {
    const target = await readlink(abs).catch(() => '');
    const to = await realpath(abs).catch(() => undefined);
    const where = [leads(resolve(dirname(abs), target)), ...(to ? [leads(to)] : [])];
    if (where.includes('out')) throw new AgentRunError(t().handoffs.linkOutside(rel));
    if (where.includes('packages')) return { kind: 'link', target };
    const file = await followed(abs);
    return file?.kind === 'file' ? { kind: 'link', target, size: file.size, hash: file.hash } : { kind: 'link', target };
  };
  const visit = async (rel: string, abs: string, top: boolean): Promise<void> => {
    const names = await readdir(abs).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (++seen > PIN_WALK.entries) throw new AgentRunError(t().handoffs.tooManyFiles(HANDOFF_LIMITS.pinnedFiles));
      if (name.toLowerCase() === '.git') continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = join(abs, name);
      const st = await lstat(childAbs).catch(() => undefined);
      if (!st) continue;
      if (st.isSymbolicLink()) add(childRel, await link(childRel, childAbs));
      else if (st.isDirectory()) {
        if (!(top && UNPINNED_TOP.includes(name.toLowerCase()))) await visit(childRel, childAbs, false);
      } else if (st.isFile() && (PIN_PATTERN.regex.test(childRel) || (st.mode & 0o111) !== 0)) {
        add(childRel, { kind: 'file', size: st.size, hash: await hashed(childAbs, st.size) });
      }
    }
  };
  await visit('', folder, true);
  // The files its command line names: those the walk took as they are, the others through links (one in
  // a top folder of packages, or outside the folder).
  for (const abs of [...new Set(named)].sort()) {
    const rel = inside(abs, folder) ? relative(folder, abs).split(sep).join('/') : undefined;
    if (rel !== undefined && rel in out) continue;
    const entry = await followed(abs);
    if (entry) add(`named:${rel ?? abs}`, entry);
  }
  for (const [key, abs] of await gitFiles(folder)) {
    if (key === '.git/config' || key === '.git/config.worktree') {
      const text = await readFile(abs, 'utf8').catch(() => '');
      const { lines, includes } = gitConfigPin(text, dirname(abs));
      if (lines) add(key, { kind: 'file', size: lines.length, hash: createHash('sha256').update(lines).digest('hex') });
      for (const inc of includes) {
        const entry = await followed(inc);
        if (entry) add(`${key}:include:${inc}`, entry);
      }
      continue;
    }
    const entry = await followed(abs);
    if (entry) add(key, entry);
  }
  return out;
}

/** The files a command line names, as full paths from where it runs (`namedFiles()`), for its pin. */
export function commandFiles(c: { run: string; cwd?: string }, folder: string): string[] {
  return namedFiles(c.run, c.cwd ? join(folder, c.cwd) : folder);
}

/** A pin's manifest in a few characters, which the user's Approve sends back: the code they saw the diff of. */
export function manifestDigest(manifest: Record<string, PinEntry>): string {
  const sorted = Object.keys(manifest)
    .sort()
    .map((k) => [k, manifest[k]]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 32);
}

/** What changed between two pins' manifests, by path, in path order. */
export function manifestChanges(before: Record<string, PinEntry>, after: Record<string, PinEntry>): string[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.filter((p) => JSON.stringify(before[p]) !== JSON.stringify(after[p]));
}

/** A command's code now: the manifest of its folder, and a snapshot of its repository to show a diff from. */
export async function takePin(folder: string, id: string, named: readonly string[] = []): Promise<CommandPin> {
  const manifest = await pinManifest(folder, named);
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

/**
 * Lets go of a pin's kept snapshot: all of the command's (it was removed), or only `old`'s once a new
 * pin `kept` took its place (taken first, so a pin that fails leaves the old one whole).
 */
export async function dropPin(id: string, old: CommandPin | undefined, kept?: CommandPin): Promise<void> {
  if (!old?.root) return;
  if (!kept) {
    await dropKeptCommits(old.root, pinKey(id)).catch(() => undefined);
    return;
  }
  if (old.commit && old.commit !== kept.commit) await forgetCommits(old.root, pinKey(id), [old.commit]).catch(() => undefined);
}

/** The pinned files that changed, were added or went since the pin, relative to the folder; empty when none did. */
export async function pinChanges(folder: string, pin: CommandPin, named: readonly string[] = []): Promise<string[]> {
  return manifestChanges(pin.manifest, await pinManifest(folder, named));
}

/**
 * The diff of a command's changed files since its pin, from its pinned snapshot to one taken now (git's
 * diff of those files alone, for those git does not ignore), with `values` masked before it is cut to
 * at most `max` characters; and the changed files it has no diff for (ignored, outside the repository,
 * git's own files).
 */
export async function pinDiff(
  folder: string,
  pin: CommandPin,
  changed: readonly string[],
  values: readonly string[] = [],
  max = 60_000,
): Promise<{ diff: string; missing: string[] }> {
  const files = changed.map((p) => p.replace(/^named:/, ''));
  if (!pin.root || !pin.commit || !files.length) return { diff: '', missing: [...changed] };
  const { commit } = await snapshot(pin.root);
  const prefix = folder === pin.root ? '' : `${relative(pin.root, folder).split(sep).join('/')}/`;
  // Repository paths of the files in it (a path outside the folder, or git's own, has none).
  const paths = files.map((p) => (isAbsolute(p) || p.startsWith('.git/') ? undefined : `${prefix}${p}`));
  const full = await diffPaths(
    pin.root,
    pin.commit,
    commit,
    paths.filter((p): p is string => Boolean(p)),
  );
  const shown = new Set(
    full
      .split(/(?=^diff --git )/m)
      .map((part) => /^diff --git a\/.* b\/(.*)$/m.exec(part.slice(0, part.indexOf('\n')))?.[1])
      .filter(Boolean),
  );
  const missing = changed.filter((_, i) => !paths[i] || !shown.has(paths[i]!));
  const text = maskValues(full, values);
  return { diff: text.length > max ? `${text.slice(0, max)}\n…` : text, missing };
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

/** Most of its secrets file a run's values are read back from: what its secrets can take at most, and some. */
const READ_BACK_BYTES = HANDOFF_LIMITS.commandSecrets * (HANDOFF_LIMITS.secretValue + 64) + 4096;

/**
 * The values a run left in its secrets file, read without trusting it: the command could have put a
 * link there (to a file it may not read), a named pipe (which would block the server) or something
 * endless; so no link is followed, nothing blocks, only a regular file is read, and only its start.
 */
export function readBack(file: string): Record<string, string> {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return {};
    const buf = Buffer.alloc(READ_BACK_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    let text = buf.subarray(0, n).toString('utf8');
    // Cut at the limit: its last line may be a value cut short, never one to keep.
    if (n === buf.length && !text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
    return readSecretsFile(text);
  } catch {
    return {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Whether a command's folder `cwd` is, as the system finds it, inside `folder` and outside its top folders of packages and `.git`. */
export function pinnedCwd(folder: string, cwd: string): boolean {
  let real: string;
  let base: string;
  try {
    real = realpathSync.native(cwd);
    base = realpathSync.native(folder);
  } catch {
    return false;
  }
  if (!inside(real, base)) return false;
  const parts = relative(base, real)
    .split(sep)
    .filter(Boolean)
    .map((x) => x.toLowerCase());
  return !parts.includes('.git') && !(parts.length && UNPINNED_TOP.includes(parts[0]!));
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
  // Where it runs, through links: in the folder, not in a folder of installed packages (`checkProposal()`
  // refuses one by name; this is a link's way there).
  if (cmd.cwd && !pinnedCwd(cmd.folder, cwd)) return errorRun(t().handoffs.cwdOutside(cmd.cwd));
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
    } finally {
      disposed = true;
      // What it left in its secrets file, read before its folder goes; then the file goes, whatever
      // keeps the folder (a process the sweeps could not end).
      left = readBack(file);
      try {
        rmSync(file, { force: true });
      } catch {
        /* its folder goes with the run */
      }
      // What it wrote back is kept even when the sandbox's cleanup fails.
      await sandboxed.dispose().catch(() => undefined);
    }
    const written: Record<string, string> = {};
    for (const name of cmd.secrets) {
      const value = left[name]?.trim();
      if (value !== undefined && value !== own[name] && !secretValueProblem(value)) written[name] = value;
    }
    const failure = sandboxed.failure();
    if (failure) return { run: errorRun(failure).run, written };
    const masks = [...allValues, ...Object.values(written)];
    // Masked whole before it is cut, and at its start after (the output is kept from its end): a value
    // cut in two shows neither part.
    const output = res.stdout
      ? maskEdges(keptOutput(maskValues(res.stdout, masks), HANDOFF_LIMITS.output), masks, res.stdoutTruncated)
      : '';
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
