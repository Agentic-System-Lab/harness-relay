import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { lstat, open, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FIXED_COMMAND_NEWS, HANDOFF_LIMITS, SECRET_NAME_RE, type FixedCommand, type FixedCommandRun } from '../shared/types';
import { UNPINNED_TOP, maskEdges, maskValues, secretValueProblem } from '../shared/handoffs';
import type { CompiledPattern } from '../shared/checks';
import { AgentRunError } from './agents/types';
import { CONFIG_FILE, checkEnv, commandCwd, keptOutput, namedFiles, sandboxDenial } from './checkCommands';
import { dirInTemp } from './protect';
import { fileKey, withheldFileKeys } from './db';
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
import {
  changedPaths,
  committedBase,
  diffPaths,
  dropKeptCommits,
  forgetCommits,
  keepCommits,
  repoGitState,
  repoRoot,
  snapshot,
  treePaths,
} from './workspace';

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
  // Sources a command may build and run (`go run`, `cargo run`, `make`).
  'go',
  'rs',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'java',
  'kt',
  'kts',
  'swift',
  'cs',
  'mk',
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
    `(?:^|/)(?:[^/]*\\.(?:${CODE_ENDINGS.join('|')})|${CONFIG_FILE.source.slice(1, -1)}|package\\.json|requirements[^/]*\\.txt|Pipfile(?:\\.lock)?|poetry\\.lock|uv\\.lock|Gemfile(?:\\.lock)?|\\.env[^/]*|\\.python-version|\\.tool-versions|package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb?|deno\\.jsonc?|[Mm]akefile|GNUmakefile|[Jj]ustfile|\\.justfile|Rakefile|Taskfile\\.ya?ml|Cargo\\.(?:toml|lock)|go\\.(?:mod|sum)|\\.cargo/config(?:\\.toml)?|build\\.gradle(?:\\.kts)?|settings\\.gradle(?:\\.kts)?|pom\\.xml|CMakeLists\\.txt)$`,
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
const PIN_WALK = { entries: 200_000, bytes: 1024 * 1024 * 1024, repositories: 50 };

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

/**
 * Whether a file with no ending sits beside a file of its name with one (`lib/helper` beside `lib/helper.js`,
 * `config` beside `config.json`): what `require('./lib/helper')` loads first, as code, so it is pinned.
 */
function shadows(name: string, names: readonly string[]): boolean {
  if (name.includes('.')) return false;
  return names.some((n) => n.startsWith(`${name}.`));
}

/** `p` as the system finds its deepest folder that is there, the rest as it is written. */
async function realish(p: string): Promise<string> {
  let head = p;
  const rest: string[] = [];
  for (;;) {
    const found = await realpath(head).catch(() => undefined);
    if (found) return rest.length ? join(found, ...rest.reverse()) : found;
    const up = dirname(head);
    if (up === head) return p;
    rest.push(basename(head));
    head = up;
  }
}

/** Whether `p` is inside `dir` (or is it). */
const inside = (p: string, dir: string) => {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * The settings of a repository's config that make git run nothing and that git and its users change in
 * everyday work (who commits, remotes and the branches that track them, upkeep, colours): left out of a
 * pin, so that `git remote add`, `push -u` or `git init` ask for no approval. Every other one is pinned:
 * one that names a program (`core.sshCommand`, `credential.helper`, `filter.*`, `alias.*`…) or a
 * protocol (`protocol.*.allow`, `url.*.insteadOf`) changes what a command running git runs.
 */
const BENIGN_GIT_KEY =
  /^(?:user\.[^.]+|core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath)|remote\..+\.(?:url|pushurl|fetch|push|prune|prunetags|tagopt|mirror|skipdefaultupdate|skipfetchall)|branch\..+\.(?:remote|merge|rebase|pushremote|description)|maintenance\..+|gc\.auto|pull\.(?:rebase|ff)|push\.(?:default|autosetupremote|followtags)|init\.defaultbranch|fetch\.(?:prune|prunetags)|color\..+|column\..+|advice\..+|rerere\.(?:enabled|autoupdate)|extensions\.(?:worktreeconfig|objectformat)|submodule\..+\.(?:url|active)|branch\..+\.vscode-merge-base|remote\..+\.gh-resolved|lfs\.repositoryformatversion|lfs\..+\.access)$/;

/** A repository's address on the network (`https://…`, `ssh://…`, `git://…`, scp's `user@host:path`), never a path here, `file:` or a remote helper's `name::…`. */
const NETWORK_REPO = /^(?:(?:https?|ssh|git):\/\/[^/\s]|(?!file:)[\w.-]+(?:@[\w.-]+)?:(?!\/\/))/i;

/**
 * Whether a git setting is one a pin leaves out (`BENIGN_GIT_KEY`): a remote's address only when it is
 * on the network (one here would have `git push` run that repository's hooks), and a branch's remote
 * only when it names one of the remotes (or `.`, the repository itself).
 */
function benignGit(key: string, values: readonly string[], settings: ReadonlyMap<string, string[]>): boolean {
  if (!BENIGN_GIT_KEY.test(key)) return false;
  if (/^(?:remote\..+\.(?:url|pushurl)|submodule\..+\.url)$/.test(key))
    return values.every((v) => NETWORK_REPO.test(v) && !v.includes('::'));
  if (/^branch\..+\.(?:remote|pushremote)$/.test(key))
    return values.every((v) => v === '.' || settings.has(`remote.${v.toLowerCase()}.url`));
  return true;
}

/**
 * The pinned git settings of the repository a folder is in (its keys and values), its hooks (not git's
 * samples) and the files its config includes, as full paths. Nothing outside a repository; any other
 * failure to read them throws, so that a run is refused rather than taken as having none.
 */
async function gitPinned(folder: string): Promise<{ settings: [string, string][]; hooks: [string, string][]; includes: string[] }> {
  let state: Awaited<ReturnType<typeof repoGitState>>;
  try {
    state = await repoGitState(folder);
  } catch (err) {
    throw new AgentRunError(t().handoffs.gitUnreadable((err as Error).message));
  }
  if (!state) return { settings: [], hooks: [], includes: [] };
  const all = state.settings;
  const settings = [...all]
    .filter(([key, values]) => !benignGit(key, values, all))
    .map(([key, values]): [string, string] => [key, values.join('\n')])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const names = (await readdir(state.hooksDir).catch(() => [] as string[])).filter((n) => !n.endsWith('.sample')).sort();
  return {
    settings,
    hooks: names.map((n): [string, string] => [n, join(state.hooksDir, n)]),
    includes: [...new Set(state.includes)].sort(),
  };
}

/** Whether a path leads to one of the files this server keeps to itself (its database, its lock…), which it must never open: closing one drops the locks the server holds on it. */
function withheld(abs: string, keys: ReadonlySet<string>): boolean {
  try {
    return keys.has(fileKey(statSync(abs, { bigint: true })));
  } catch {
    return false;
  }
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
  const kept = withheldFileKeys();
  /** The repositories inside the folder (a `.git` below its top), whose git settings and hooks are pinned too. */
  const nested: string[] = [];
  const add = (key: string, entry: PinEntry) => {
    if (!(key in out) && ++pinned > HANDOFF_LIMITS.pinnedFiles)
      throw new AgentRunError(t().handoffs.tooManyFiles(HANDOFF_LIMITS.pinnedFiles));
    out[key] = entry;
  };
  const hashed = async (abs: string, size: number): Promise<string> => {
    if (withheld(abs, kept)) throw new AgentRunError(t().handoffs.protectedFile(abs));
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
  /**
   * Where a link leads may be pinned: inside the folder, not in `.git`; a top folder of packages is let
   * be (by its name as it is: on Linux `Target` is another folder). A path is taken as the system finds
   * its deepest folder that is there (`/var/…` and `/private/var/…` are one on macOS).
   */
  const leads = async (p: string): Promise<'in' | 'packages' | 'out'> => {
    const found = await realish(p);
    const base = inside(found, real) ? real : inside(found, folder) ? folder : undefined;
    if (base === undefined) return 'out';
    const parts = relative(base, found).split(sep).filter(Boolean);
    if (parts.some((x) => x.toLowerCase() === '.git')) return 'out';
    return parts.length && UNPINNED_TOP.includes(parts[0]!) ? 'packages' : 'in';
  };
  const link = async (rel: string, abs: string): Promise<PinEntry> => {
    const target = await readlink(abs).catch(() => '');
    const to = await realpath(abs).catch(() => undefined);
    const where = [await leads(resolve(dirname(abs), target)), ...(to ? [await leads(to)] : [])];
    if (where.includes('out')) throw new AgentRunError(t().handoffs.linkOutside(rel));
    if (where.includes('packages')) return { kind: 'link', target };
    const file = await followed(abs);
    return file?.kind === 'file' ? { kind: 'link', target, size: file.size, hash: file.hash } : { kind: 'link', target };
  };
  const visit = async (rel: string, abs: string, top: boolean): Promise<void> => {
    const names = await readdir(abs).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (++seen > PIN_WALK.entries) throw new AgentRunError(t().handoffs.tooManyFiles(HANDOFF_LIMITS.pinnedFiles));
      if (name.toLowerCase() === '.git') {
        // A repository inside the folder: that it is there, and what git reads there (below).
        if (rel) {
          if (nested.length >= PIN_WALK.repositories) throw new AgentRunError(t().handoffs.tooManyRepositories(PIN_WALK.repositories));
          nested.push(rel);
          add(`${rel}/.git`, { kind: 'link', target: '(a repository)' });
        }
        continue;
      }
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = join(abs, name);
      const st = await lstat(childAbs).catch(() => undefined);
      if (!st) continue;
      // A top folder of packages is not pinned, a link to one elsewhere neither (but by its target).
      const packages = top && UNPINNED_TOP.includes(name);
      if (st.isSymbolicLink())
        add(childRel, packages ? { kind: 'link', target: await readlink(childAbs).catch(() => '') } : await link(childRel, childAbs));
      else if (st.isDirectory()) {
        if (!packages) await visit(childRel, childAbs, false);
      } else if (st.isFile() && (PIN_PATTERN.regex.test(childRel) || (st.mode & 0o111) !== 0 || shadows(name, names))) {
        add(childRel, { kind: 'file', size: st.size, hash: await hashed(childAbs, st.size) });
      }
    }
  };
  await visit('', folder, true);
  // The files its command line names: those the walk took as they are, the others through links (one in
  // a top folder of packages, or outside the folder).
  for (const abs of [...new Set(named)].sort()) {
    // Inside the folder however it is written (`/tmp/…` for `/private/tmp/…`).
    const found = await realish(abs);
    const rel = inside(abs, folder)
      ? relative(folder, abs).split(sep).join('/')
      : inside(found, real)
        ? relative(real, found).split(sep).join('/')
        : undefined;
    if (rel !== undefined && rel in out) continue;
    // Outside the folder in a temp folder, where agents write, it could change while it runs: refused, as
    // a link out of the folder is.
    if (rel === undefined && dirInTemp(abs)) throw new AgentRunError(t().handoffs.namedInTemp(abs));
    const entry = await followed(abs);
    if (entry) add(`named:${rel ?? abs}`, entry);
  }
  // Git's settings as git itself reads them (includes and all), but the everyday ones, and its hooks.
  for (const [prefix, dir] of [['', folder] as const, ...nested.map((rel) => [`${rel}: `, join(folder, rel)] as const)]) {
    const pinnedGit = await gitPinned(dir);
    for (const [key, value] of pinnedGit.settings)
      add(`${prefix}git config ${key}`, { kind: 'file', size: value.length, hash: createHash('sha256').update(value).digest('hex') });
    for (const [name, abs] of pinnedGit.hooks) {
      const entry = await followed(abs);
      if (entry) add(`${prefix}git hook ${name}`, entry);
    }
    // What the config includes, whether or not its condition holds now.
    for (const abs of pinnedGit.includes) {
      const entry = await followed(abs);
      if (entry) add(`${prefix}git include ${abs}`, entry);
    }
  }
  return out;
}

/** The words of a command line before a file of code it runs: an interpreter, or the shell's `source`. */
const INTERPRETER =
  /^(?:python[\d.]*|pypy[\d.]*|node|nodejs|deno|bun|bash|sh|zsh|dash|ksh|fish|ruby|perl|php|lua|Rscript|tsx|ts-node|source|\.)$/;

/**
 * The files of code a command line names, as full paths from where it runs, for its pin: a word with a
 * folder in it or a script's ending (`namedFiles()`) that is code (`PIN_PATTERN`, or executable), or the
 * word after an interpreter. Never a data file it reads or writes (`--queue data/queue.csv`, `> out/log.txt`),
 * which may change freely.
 */
export function commandFiles(c: { run: string; cwd?: string }, folder: string): string[] {
  const base = c.cwd ? join(folder, c.cwd) : folder;
  const words = c.run.split(/[\s;&|()<>'"`=]+/).filter(Boolean);
  const named = new Set(namedFiles(c.run, base));
  const out: string[] = [];
  words.forEach((w, i) => {
    const abs = resolve(base, w);
    // The first word after an interpreter that is not one of its options (`sh -e ./bin/run`, `python3 -u bin/run`).
    let j = i - 1;
    while (j >= 0 && words[j]!.startsWith('-')) j--;
    const operand = !w.startsWith('-') && j >= 0 && j < i && INTERPRETER.test(basename(words[j]!));
    if (!operand && !named.has(abs)) return;
    if (operand || PIN_PATTERN.regex.test(abs) || executable(abs)) out.push(abs);
  });
  return [...new Set(out)];
}

/** Whether a path leads to a file anyone may run. */
function executable(abs: string): boolean {
  try {
    const st = statSync(abs);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
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

/** A git setting whose value may be a credential: the diff says it is set, never what it is. */
const HIDDEN_GIT_VALUE = /^(?:extraheader|password|passwd|token|accesstoken|cookie|cookiefile|secret)$/i;

/** The path of a section of git's diff (`diff --git a/P b/P`, no renames: both the same). */
function sectionPath(header: string): string | undefined {
  const head = 'diff --git a/';
  if (!header.startsWith(head)) return undefined;
  const both = header.length - head.length - ' b/'.length;
  if (both <= 0 || both % 2) return /^diff --git a\/.* b\/(.*)$/.exec(header)?.[1];
  return header.slice(head.length, head.length + both / 2);
}

/**
 * A file's text as it is now, for an entry git has no diff of; undefined when it is not there, not text,
 * one the server keeps to itself, or outside `within` (a hook or named file that leads elsewhere, whose
 * place alone is said).
 */
async function textNow(abs: string, max: number, within: readonly string[]): Promise<string | undefined> {
  const to = await realpath(abs).catch(() => undefined);
  if (!to || withheld(to, withheldFileKeys())) return undefined;
  if (!within.some((d) => inside(to, d))) return `(outside the working directory: ${to}; its content is not shown)`;
  const handle = await open(to, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(() => undefined);
  if (!handle) return undefined;
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, Math.min(bytesRead, 8192)).includes(0)) return undefined;
    const text = buf.subarray(0, Math.min(bytesRead, max)).toString('utf8');
    return bytesRead > max ? `${text}\n…` : text;
  } finally {
    await handle.close();
  }
}

/**
 * What changed in a command's code since its pin, to show before the user approves it: git's diff of
 * the changed files from its pinned snapshot to one taken now (for those in the repository that git
 * does not ignore), then, for each change git has no diff of (a git setting, a hook, a file outside the
 * repository or ignored), what it is now. `values` are masked before it is cut to at most `max`
 * characters. `missing`: the changes it shows nothing of (gone, or not text).
 */
/**
 * Whether a pin's entry is a file of secrets of the user's own (`.env*`, `.envrc`, `.npmrc`, `.yarnrc*`,
 * `.pypirc`, `.netrc`): shown by its names alone, never its values (`secretsShape()`).
 */
const SECRET_FILE = /^(?:\.env.*|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc)$/i;
const secretEntry = (e: string) => SECRET_FILE.test(basename(e.replace(/^named:/, '')));

/** A file of secrets as a view shows it: each line's name, its value hidden (an agent's edit still shows). */
function secretsShape(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*[#;]/.test(l))
    .map((l) => {
      const m = /^(\s*[^=:\s]+(?:\s*[=:]|\s))/.exec(l);
      return m ? `${m[1]}••••` : '••••';
    })
    .join('\n');
}

/**
 * The view of a fixed command's code (`pinDiff()`, `codeView()`), cut to at most `max` characters a
 * whole file at a time: those that do not fit are named in `missing`, never shown in part.
 */
function cutView(
  pieces: readonly { entry: string; text: string }[],
  values: readonly string[],
  max: number,
): { diff: string; missing: string[] } {
  const kept: string[] = [];
  const missing: string[] = [];
  let size = 0;
  for (const p of pieces) {
    const text = maskValues(p.text, values);
    if (size + text.length > max && kept.length) {
      missing.push(p.entry);
      continue;
    }
    kept.push(text.length > max ? `${text.slice(0, max)}\n…` : text);
    size += Math.min(text.length, max);
  }
  return { diff: kept.join('\n'), missing };
}

/**
 * What changed in a command's code since its pin (or, for `codeView()`, since a base), to show before the
 * user approves it: git's diff of the changed files from the pin's snapshot to one taken now (as text,
 * a file git calls binary too), for those in the repository that git does not ignore; then, for each change
 * git has no diff of (a git setting, a hook, a file outside the repository or ignored), what it is now; a
 * file of secrets by its names alone. `first`: entries shown before the others (the scripts the command
 * line names). `values` are masked, and the view is cut a whole file at a time (`cutView()`). `missing`:
 * the changes it shows nothing of (gone, not readable as text here, outside the folder, or cut).
 */
export async function pinDiff(
  folder: string,
  pin: CommandPin,
  changed: readonly string[],
  values: readonly string[] = [],
  max = 60_000,
  first: readonly string[] = [],
): Promise<{ diff: string; missing: string[] }> {
  if (!changed.length) return { diff: '', missing: [] };
  const order = [...new Set([...first.filter((e) => changed.includes(e)), ...changed])];
  const prefix = pin.root && folder !== pin.root ? `${relative(pin.root, folder).split(sep).join('/')}/` : '';
  // Repository paths of the changed files in the folder (a git setting, a hook, a file outside or of secrets has none).
  const repoPath = (entry: string) => {
    if (entry.startsWith('git config ') || entry.startsWith('git hook ') || secretEntry(entry)) return undefined;
    const p = entry.replace(/^named:/, '');
    return isAbsolute(p) ? undefined : `${prefix}${p}`;
  };
  const sections = new Map<string, string>();
  if (pin.root && pin.commit) {
    const paths = order.map(repoPath).filter((p): p is string => Boolean(p));
    const { commit } = await snapshot(pin.root);
    const full = await diffPaths(pin.root, pin.commit, commit, paths);
    for (const part of full.split(/(?=^diff --git )/m)) {
      const path = sectionPath(part.slice(0, part.indexOf('\n')));
      if (path) sections.set(path, part);
    }
  }
  const git = order.some((e) => e.startsWith('git ')) ? await repoGitState(folder).catch(() => undefined) : undefined;
  const within = [await realpath(folder).catch(() => folder), ...(pin.root ? [pin.root] : [])];
  const pieces: { entry: string; text: string }[] = [];
  const missing: string[] = [];
  for (const entry of order) {
    const path = repoPath(entry);
    if (path && sections.has(path)) {
      pieces.push({ entry, text: sections.get(path)! });
      continue;
    }
    if (entry.startsWith('git config ')) {
      const key = entry.slice('git config '.length);
      const now = git?.settings.get(key);
      pieces.push({
        entry,
        text: `### ${entry}\n${now ? now.map((v) => `${key} = ${HIDDEN_GIT_VALUE.test(key.split('.').pop()!) ? '(set; its value is not shown)' : v}`).join('\n') : '(not set now)'}\n`,
      });
      continue;
    }
    const abs = entry.startsWith('git hook ')
      ? git && join(git.hooksDir, entry.slice('git hook '.length))
      : resolve(folder, entry.replace(/^named:/, ''));
    const now = abs ? await textNow(abs, 20_000, within) : undefined;
    if (now === undefined) {
      missing.push(entry);
      continue;
    }
    // A file of secrets (by its name, or by what a link of it leads to): its names, never its values.
    const to = abs ? await realpath(abs).catch(() => abs) : '';
    const secret = secretEntry(entry) || SECRET_FILE.test(basename(to));
    const text = secret ? secretsShape(now) : now;
    pieces.push({
      entry,
      text: `### ${entry} (${secret ? 'its names; values not shown' : 'as it is now'})\n${text}${text.endsWith('\n') ? '' : '\n'}`,
    });
  }
  const view = cutView(pieces, values, max);
  return { diff: view.diff, missing: [...missing, ...view.missing] };
}

/**
 * What a proposed fixed command would run, for the user to see before its first Save pins it (`manifest`,
 * its pin's): the scripts its command line names, in full; of the other files it pins, those that changed
 * since `base` (the state before the conversation's agents first changed files there, `commandCode()`;
 * else the last commit), commits an agent made included, as git's diff, and those git ignores as they are
 * now; its git settings, hooks and the files its command line names outside the repository, as they are
 * now; files of secrets by their names alone (`pinDiff()`). Values masked; cut a whole file at a time.
 */
export async function codeView(
  folder: string,
  manifest: Record<string, PinEntry>,
  values: readonly string[] = [],
  o: { base?: string; named?: readonly string[]; max?: number } = {},
): Promise<{ diff: string; missing: string[] }> {
  const max = o.max ?? 60_000;
  const entries = Object.keys(manifest);
  // The scripts the command line names, as the pin keys them: shown in full, first, whatever git says.
  const named = new Set(
    (o.named ?? []).map((abs) => {
      const rel = inside(abs, folder) ? relative(folder, abs).split(sep).join('/') : undefined;
      return rel !== undefined && rel in manifest ? rel : `named:${rel ?? abs}`;
    }),
  );
  const outside = (e: string) =>
    e.startsWith('git ') || e.includes(': git ') || e.endsWith('/.git') || (e.startsWith('named:') && isAbsolute(e.slice(6)));
  const root = await repoRoot(folder).catch(() => null);
  if (!root) return pinDiff(folder, { manifest: {} }, entries, values, max, [...named]);
  const base = o.base ?? (await committedBase(root));
  const { commit } = await snapshot(root);
  const prefix = folder === root ? '' : `${relative(root, folder).split(sep).join('/')}/`;
  const repoPath = (e: string) => `${prefix}${e.replace(/^named:/, '')}`;
  const inRepo = entries.filter((e) => !outside(e));
  const changed = new Set(await changedPaths(root, base, commit, inRepo.map(repoPath)));
  const tracked = await treePaths(root, commit);
  const shown = entries.filter((e) => named.has(e) || outside(e) || !tracked.has(repoPath(e)) || changed.has(repoPath(e)));
  // A named script with no change has no diff: shown as it is now (`pinDiff()`'s pieces of the rest).
  return pinDiff(folder, { manifest: {}, root, commit: base }, shown, values, max, [...named]);
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
      ? maskValues(t().handoffs.hostsRefused(refused.join(', ')), masks)
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
