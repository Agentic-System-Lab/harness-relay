import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { truncatedNote } from '../shared/diff';
import type { FileChange } from '../shared/types';
import { HttpError } from './errors';
import { tail } from './process';
import { captureGit, gitCommand } from './gitProcess';
import { t } from './i18n';
import { DATA_DIR } from './settings';

/**
 * Git plumbing for Harness Relay:
 * - make a working directory a repository (auto `git init`);
 * - take snapshots of the working tree (tracked + untracked, honouring .gitignore) as commits,
 *   without touching the user's branch, index or files;
 * - per-agent worktrees for parallel mode, and applying an agent's result back.
 *
 * Harness Relay's git runs outside any sandbox, and an agent may write a working repository's `.git`
 * (some sandboxes let it), where a link would have git write wherever it points. So Harness Relay
 * writes nothing there. Each working repository has a repository of Harness Relay's own in its data
 * folder (`repoStore()`: `data/repos/<key>.git`, which no agent's sandbox lets it write), which holds
 * every object of its snapshots and results itself, the refs that keep them and each parallel
 * worktree's branch. Every command that writes names it (`GIT_DIR`) and the folder it works on
 * (`GIT_WORK_TREE`), never a git folder found in a folder an agent writes, and none of them looks at
 * the working repository's objects (`inStore()` reads them only for a commit an older Harness Relay
 * kept there). The working repository is only read: its HEAD (a snapshot's parent), its `info/exclude`,
 * and for the team checks its branches and commits; its index is not read at all (an agent could make
 * it claim any content for a file). A parallel worktree or a check tree is a repository of its own for
 * whoever works there (`checkout()`), never written by Harness Relay once made: its result is its files.
 */

// `protocol.allow=never`: these commands never need a remote, so none (ssh, ext::, a lazy fetch of a
// partial clone's objects) can run a command that a repository's config names, also on a git older
// than 2.44, which does not know `GIT_NO_LAZY_FETCH`.
// `core.autocrlf=false`: snapshots, worktrees, diffs and applying keep a file's bytes as they are.
// Git for Windows turns it on by default (in its system config): a file an agent wrote with LF would
// come back to the user's folder with CRLF, and the diff viewer would not show a CRLF file's CRs.
const CONFIG = [
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'protocol.allow=never',
  // Nothing git does by itself: reuse a recorded resolution (rerere), or clean up after itself (gc, maintenance).
  '-c',
  'rerere.enabled=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  // An index Harness Relay copies into a checkout of its own is whole (no shared part in another folder),
  // and no command goes into a submodule's own checkout.
  '-c',
  'core.splitIndex=false',
  // Its own index trusted for a file only while all of it is as it was (its change time and inode
  // too, which no program can put back), whatever the user's config says.
  '-c',
  'core.trustctime=true',
  '-c',
  'core.checkStat=default',
  '-c',
  'submodule.recurse=false',
];

/** The keys of a repository's config that name a driver which runs a command (git then runs none when it is empty). */
const DRIVER_KEYS: Record<string, string[]> = {
  filter: ['clean', 'smudge', 'process'],
  diff: ['textconv', 'command'],
  merge: ['driver'],
};

/** How deep `repoDriverGuards` follows repositories inside repositories before it refuses. */
const MAX_NESTED = 8;

/** Most of a repository's config Harness Relay reads, for its guards and a fixed command's pin. */
const GIT_CONFIG_BYTES = 16 * 1024 * 1024;

/**
 * `-c` settings that keep a repository's own config from making Harness Relay's git commands, which
 * run outside any sandbox, run a command: for the repositories at a working tree's submodules, which
 * `git add` runs `git status` in, each with its own config (the `-c` settings reach it), which an
 * agent can write (and in a worktree make one where a submodule's folder is empty). Each driver the
 * repository's own settings name is emptied (its `fsmonitor` is off in `CONFIG`, its hooks too); the
 * user's own and the system's (git-lfs, say) are left as they are. A driver name git's `-c` cannot
 * carry (with `=`) refuses the command, and so does a `core.worktree` naming a folder other than the
 * one that holds the repository. `nested`: also those of the repositories at its own submodules.
 * (The working repository's own config is never read by a command that writes: those run on Harness
 * Relay's own repository, `storeOf()`.)
 */
export async function repoDriverGuards(cwd: string, env: NodeJS.ProcessEnv, nested = false, depth = 0, bin?: string): Promise<string[]> {
  const r = await captureGit(
    ['config', '-z', '--includes', '--show-scope', '--get-regexp', '^(filter|diff|merge)\\.|^core\\.worktree$'],
    env,
    {
      cwd,
      timeoutMs: 30_000,
      // All of it, from its start: a config padded past the limit must not hide a driver at its start.
      maxCapture: GIT_CONFIG_BYTES,
      keepStart: true,
    },
    bin,
  );
  // 1: none found. Anything else (a git too old for --show-scope, a config it cannot read), or more than
  // it could read: refuse, rather than run the command without knowing what the repository would have it run.
  if (r.code !== 0 && r.code !== 1) throw new GitError(t().gitFailed('config', tail(r.stderr || r.stdout, 500)));
  if (r.stdoutTruncated) throw new GitError(t().outputTooLarge('config'));
  const out: string[] = [];
  const seen = new Set<string>();
  let workTree = false;
  // `-z` with `--show-scope`: `<scope>\0<key>\n<value>\0` for each.
  const fields = r.stdout.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const scope = fields[i]!;
    const entry = fields[i + 1]!;
    if (scope !== 'local' && scope !== 'worktree') continue;
    const nl = entry.indexOf('\n');
    const key = nl < 0 ? entry : entry.slice(0, nl);
    if (key === 'core.worktree') {
      workTree = true;
      continue;
    }
    const section = key.slice(0, key.indexOf('.')).toLowerCase();
    const name = key.slice(key.indexOf('.') + 1, key.lastIndexOf('.'));
    const vars = DRIVER_KEYS[section];
    if (!vars || key.indexOf('.') === key.lastIndexOf('.') || seen.has(`${section}.${name}`)) continue;
    if (name.includes('=') || name.includes('\n')) throw new GitError(t().gitFailed('config', `unsafe ${section} name "${name}"`));
    seen.add(`${section}.${name}`);
    for (const v of vars) out.push('-c', `${section}.${name}.${v}=`);
    if (section === 'filter') out.push('-c', `filter.${name}.required=false`);
  }
  if (workTree) await ownWorkTree(cwd, env, bin);
  if (!nested) return out;
  for (const sub of await submoduleRepos(cwd, env, bin)) {
    if (depth >= MAX_NESTED) throw new GitError(t().gitFailed('add', `repositories nested deeper than ${MAX_NESTED}`));
    out.push(...(await repoDriverGuards(sub, submoduleEnv(env), true, depth + 1, bin)));
  }
  return out;
}

/** As git runs `git status` in a submodule: `cd <sub>; GIT_DIR=.git`, no index or working tree of the outer one's. */
function submoduleEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sub: NodeJS.ProcessEnv = { ...env, GIT_DIR: '.git' };
  delete sub.GIT_INDEX_FILE;
  delete sub.GIT_WORK_TREE;
  return sub;
}

/**
 * The guards of a `git add` on a working tree (`env` names Harness Relay's own repository, the working
 * tree and the index): those of the repositories at its index's submodules, which it runs `git status`
 * in. The store's own config names no driver.
 */
async function submoduleGuards(cwd: string, env: NodeJS.ProcessEnv, bin: string): Promise<string[]> {
  const out: string[] = [];
  for (const sub of await submoduleRepos(cwd, env, bin)) out.push(...(await repoDriverGuards(sub, submoduleEnv(env), true, 1, bin)));
  return out;
}

/** Refuses a repository whose `core.worktree` is not the folder holding its `.git` (a submodule's points back through its `.git` file). */
async function ownWorkTree(cwd: string, env: NodeJS.ProcessEnv, bin?: string): Promise<void> {
  const r = await captureGit([...CONFIG, 'rev-parse', '--absolute-git-dir', '--show-toplevel'], env, { cwd, timeoutMs: 30_000 }, bin);
  const [gitDir, top] = r.stdout.split('\n');
  if (!ownsWorkTree(r.code === 0 ? gitDir : undefined, top))
    throw new GitError(t().gitFailed('config', `core.worktree "${top ?? ''}" is not the repository's own folder`));
}

/** Whether `top` holds the `.git` (a folder, or a file naming it) that leads to the git folder `gitDir`. */
function ownsWorkTree(gitDir: string | undefined, top: string | undefined): boolean {
  if (!gitDir || !top) return false;
  try {
    const dotGit = join(top, '.git');
    const held = statSync(dotGit).isDirectory() ? dotGit : resolve(top, /^gitdir: (.+)$/m.exec(smallFile(dotGit) ?? '')?.[1] ?? '\0');
    return realpathSync(held) === realpathSync(gitDir);
  } catch {
    return false; // no `.git` there, or none that leads back
  }
}

/** The folders of the submodules (gitlinks) in `cwd`'s index that hold a repository (a `.git`). */
async function submoduleRepos(cwd: string, env: NodeJS.ProcessEnv, bin?: string): Promise<string[]> {
  // `:/` lists the whole index, as `git add -A` takes it, with paths relative to `cwd`. Reading the
  // index would start its fsmonitor: `CONFIG` turns it off.
  const r = await captureGit(
    [...CONFIG, 'ls-files', '-z', '--stage', '--', ':/'],
    env,
    {
      cwd,
      timeoutMs: 120_000,
      maxCapture: MAX_OUTPUT_BYTES,
    },
    bin,
  );
  if (r.code !== 0) return []; // not a repository: `git add` fails by itself
  if (r.stdoutTruncated) throw new GitError(t().outputTooLarge('ls-files'));
  const out: string[] = [];
  // `<mode> <object> <stage>\t<path>\0`; a submodule's mode is 160000.
  for (const entry of r.stdout.split('\0')) {
    if (!entry.startsWith('160000 ')) continue;
    const sub = resolve(cwd, entry.slice(entry.indexOf('\t') + 1));
    if (existsSync(join(sub, '.git'))) out.push(sub);
  }
  return out;
}
const IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Harness Relay',
  GIT_AUTHOR_EMAIL: 'harness-relay@localhost',
  GIT_COMMITTER_NAME: 'Harness Relay',
  GIT_COMMITTER_EMAIL: 'harness-relay@localhost',
};

/** Added to .git/info/exclude of repositories we create, so snapshots skip bulky generated folders. */
export const DEFAULT_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.DS_Store', '.next/', '.turbo/', 'target/'];

const MAX_DIFF_BYTES = 1024 * 1024;
/** Output limit for file lists and patches; larger output is refused rather than silently cut. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
/** Snapshot commits recorded in the chat are kept reachable under this ref namespace (per conversation). */
const REF_PREFIX = 'refs/harness-relay';

export class GitError extends Error {}

interface GitOptions {
  /**
   * The git folder (`GIT_DIR`): Harness Relay's own repository (`storeOf()`) for every command that
   * writes (or a checkout's own, which Harness Relay has just made, `checkout()`); else found from
   * `cwd`, for one that reads.
   */
  gitDir?: string;
  /** The folder it works on (`GIT_WORK_TREE`), with `gitDir`. */
  workTree?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  allowFail?: boolean;
  maxCapture?: number;
  /** Fail instead of returning output that went over `maxCapture`. */
  complete?: boolean;
  /** Keep the first `maxCapture` bytes instead of the last. */
  keepStart?: boolean;
}

/** The most a small file Harness Relay reads itself (a `.git` file, `info/exclude`, a worktree's `gitdir`) may hold. */
const SMALL_MAX = 1024 * 1024;

/**
 * The bytes of a regular file of at most `max` bytes, or undefined: not there, a link, a named pipe or
 * a device, or larger. Opened without following a link and without waiting (a pipe an agent made in
 * its place would block the server's every request), then looked at as opened.
 */
function regularFile(path: string, max = SMALL_MAX): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    return readFileSync(fd);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const smallFile = (path: string): string | undefined => regularFile(path)?.toString('utf8');

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * A command's output as exactly `count` lines, or undefined when it has any other number (a path with
 * a line break in it, say). Each line as git wrote it: git ends lines with LF alone; on Windows, where a
 * file's name can hold no CR or LF, a CR before each is dropped too.
 */
function linesOf(stdout: string, count: number): string[] | undefined {
  const lines = (process.platform === 'win32' ? stdout.replace(/\r\n/g, '\n') : stdout).split('\n');
  // Each line ends with LF: one empty string after the last.
  return lines.length === count + 1 && lines[count] === '' ? lines.slice(0, count) : undefined;
}

/** Where Harness Relay's own repositories are, for tests (none: `repos` in its data folder). */
let storesDir: string | undefined;

/** For tests: keep Harness Relay's own repositories in `dir` (none: the data folder's `repos` again). */
export function setRepoStore(dir?: string): void {
  storesDir = dir;
  stores.clear();
}

/**
 * Harness Relay's own repository for the working repository at `root`: in its data folder, named after
 * the root's real path (`data/repos/<key>.git`).
 */
export function repoStore(root: string): string {
  const key = createHash('sha256').update(realOr(root)).digest('hex').slice(0, 24);
  return join(storesDir ?? join(DATA_DIR, 'repos'), `${key}.git`);
}

/** Each store this server made or found, ready (one making at a time). */
const stores = new Map<string, Promise<string>>();

/** Harness Relay's own repository for `root` (`repoStore()`), made at first use. */
async function storeOf(root: string): Promise<string> {
  const store = repoStore(root);
  let ready = stores.get(store);
  if (!ready) {
    ready = makeStore(root, store).catch((err: unknown) => {
      stores.delete(store);
      throw err;
    });
    stores.set(store, ready);
  }
  return ready;
}

/**
 * A bare repository of Harness Relay's own, with the working repository's object format. It holds every
 * object of its snapshots and results itself: no git command that writes one looks at the working
 * repository's objects (finding one there, git would only touch it, through a link an agent put in its
 * place, and take it as written). Those are read only for a commit an older Harness Relay kept there
 * (`inStore()`).
 */
async function makeStore(root: string, store: string): Promise<string> {
  // Its common git folder (whose objects are read for older commits), and its object format (a git that
  // does not know `--show-object-format` prints it as it is: SHA-1 then).
  const r = await git(root, ['rev-parse', '--git-common-dir', '--show-object-format'], { allowFail: true });
  const [common, format] = (r.code === 0 ? linesOf(r.stdout, 2) : undefined) ?? [];
  if (common) noteObjects(store, root, common);
  if (!existsSync(join(store, 'HEAD'))) {
    mkdirSync(dirname(store), { recursive: true });
    await git(dirname(store), ['init', '-q', '--bare', '--template=', store], {
      env: { GIT_DEFAULT_HASH: format === 'sha256' ? 'sha256' : 'sha1' },
    });
  }
  return store;
}

/** The working repository's objects folder, for each of Harness Relay's repositories (`noteObjects()`). */
const workObjects = new Map<string, string>();

/** Remembers where the working repository's objects are (from its common git folder). */
function noteObjects(store: string, root: string, common: string): void {
  workObjects.set(store, realOr(join(resolve(root, common), 'objects')));
}

/** A folder as a line of git's alternates (its file, or `GIT_ALTERNATE_OBJECT_DIRECTORIES`): quoted as C quotes when it has to be. */
function alternateEntry(dir: string, sep: string): string {
  return dir.includes(sep) || /^"|[\n\r]/.test(dir)
    ? `"${dir.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
    : dir;
}

/** What git says when an object it needs is not there (in Harness Relay's repository: one of an older version's commits). */
const MISSING_OBJECT =
  /bad object|bad revision|unknown revision|not a valid object|unable to read|invalid object|could not read|does not point to a valid object|missing (blob|tree|commit|object)/i;

/**
 * Runs a git command on Harness Relay's own repository for `root`. Its own objects alone; only when one
 * is not there (a commit an older Harness Relay kept in the working repository), again with the working
 * repository's objects to read from too.
 */
async function inStore(root: string, args: string[], o: GitOptions = {}) {
  const store = await storeOf(root);
  const r = await git(store, args, { ...o, gitDir: store, allowFail: true });
  const theirs = workObjects.get(store);
  if (r.code === 0 || !theirs || !MISSING_OBJECT.test(r.stderr)) {
    if (r.code !== 0 && !o.allowFail) throw new GitError(t().gitFailed(String(args[0]), tail(r.stderr || r.stdout, 500)));
    return r;
  }
  const env = { ...o.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateEntry(theirs, process.platform === 'win32' ? ';' : ':') };
  return git(store, args, { ...o, env, gitDir: store });
}

/** The largest index of its own Harness Relay keeps for a folder (a larger one, it does without: git hashes every file again). */
const INDEX_MAX = 512 * 1024 * 1024;

/**
 * The tree of `workTree`'s files (tracked and untracked, honouring the repository's ignores) as `add`
 * stages them in Harness Relay's own repository, from `cache`, its own index of that folder (what it
 * hashed there last: a file whose size, times and inode are as they were is not hashed again). A copy of
 * it for each command, put back after, so that two at once each start from a whole one. Every object is
 * written in Harness Relay's repository.
 */
async function stagedTree(store: string, workTree: string, cache: string, add: string[], seed?: string): Promise<string> {
  mkdirSync(dirname(cache), { recursive: true });
  const index = `${cache}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    const cached = regularFile(cache, INDEX_MAX);
    if (cached) writeFileSync(index, cached);
    const at = { gitDir: store, workTree, env: { GIT_INDEX_FILE: index } };
    // A new one starts from the files `seed` holds (the working repository's HEAD, read from its
    // objects): git keeps a file it tracks even where an ignore rule matches it. Their names alone: with
    // no times of their own, every one of them is hashed again from the folder.
    const theirs = workObjects.get(store);
    if (!cached && seed && theirs) {
      const env = { ...at.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateEntry(theirs, process.platform === 'win32' ? ';' : ':') };
      const read = await git(workTree, ['read-tree', seed], { ...at, env, allowFail: true });
      if (read.code !== 0) rmSync(index, { force: true });
    }
    const added = await git(workTree, add, { ...at, allowFail: existsSync(index) });
    // One it cannot take (cut short when the server stopped, say): again from nothing.
    if (added.code !== 0) {
      rmSync(index, { force: true });
      await git(workTree, add, at);
    }
    const tree = out(await git(workTree, ['write-tree'], at));
    renameSync(index, cache);
    return tree;
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * A commit of `tree` in Harness Relay's repository, written as `git commit-tree` writes one, but without
 * reading its parents (a snapshot's is the working repository's HEAD, whose objects it does not hold).
 */
async function makeCommit(store: string, tree: string, parents: string[], message: string): Promise<string> {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const abs = Math.abs(offset);
  const zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  const who = `${IDENTITY.GIT_COMMITTER_NAME} <${IDENTITY.GIT_COMMITTER_EMAIL}> ${Math.floor(now.getTime() / 1000)} ${zone}`;
  const text = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${who}\ncommitter ${who}\n\n${message}\n`;
  return out(await git(store, ['hash-object', '-t', 'commit', '-w', '--stdin'], { gitDir: store, stdin: text }));
}

/**
 * Packs Harness Relay's repository now and then, as `git gc --auto` would (past about 6,700 loose
 * objects, which it guesses from one of their folders, as git does), dropping after two weeks what no
 * kept ref reaches. It runs in that repository alone, in this process (never detached).
 */
async function tidyStore(store: string): Promise<void> {
  let loose: number;
  try {
    loose = readdirSync(join(store, 'objects', '17')).length;
  } catch {
    return;
  }
  if (loose <= 27) return;
  await git(store, ['-c', 'gc.auto=6700', '-c', 'gc.autoDetach=false', 'gc', '--auto', '--quiet'], { gitDir: store, allowFail: true });
}

async function git(cwd: string, args: string[], o: GitOptions = {}) {
  // Never a repository from the server's own environment: the one named here, or the one found from `cwd`.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_INDEX_FILE',
  ])
    delete env[k];
  Object.assign(env, IDENTITY, o.env);
  if (o.gitDir) env.GIT_DIR = o.gitDir;
  if (o.workTree) env.GIT_WORK_TREE = o.workTree;
  // Never fetch an object that is missing: a partial clone's remote, which the repository's config
  // names, would be reached through a command it names too (`core.sshCommand`, say).
  env.GIT_NO_LAZY_FETCH = '1';
  // Nor rewrite an index it only reads (`git status` refreshes one when it can).
  env.GIT_OPTIONAL_LOCKS = '0';
  const bin = await gitCommand(env);
  // `git add` on a working tree runs `git status` in its submodules: their drivers emptied first. A diff
  // runs no external diff or textconv either.
  const guards = args[0] === 'add' && o.workTree ? await submoduleGuards(cwd, env, bin) : [];
  const safe = args[0] === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
  const r = await captureGit(
    [...CONFIG, ...guards, ...safe],
    env,
    {
      cwd,
      stdin: o.stdin,
      timeoutMs: 120_000,
      maxCapture: o.maxCapture,
      keepStart: o.keepStart,
    },
    bin,
  );
  if (r.code !== 0 && !o.allowFail) {
    throw new GitError(t().gitFailed(String(args[0]), tail(r.stderr || r.stdout, 500)));
  }
  if (o.complete && r.stdoutTruncated) throw new GitError(t().outputTooLarge(String(args[0])));
  return r;
}

/** A repository too broad to snapshot on every turn: one rooted at the home directory or a file-system root. */
function tooBroadRepo(root: string): boolean {
  return root === realpathSync(homedir()) || root === parse(root).root;
}

/** Where not to create a repository: also a volume root or a folder above the home directory. */
function tooBroadForInit(dir: string): boolean {
  const home = realpathSync(homedir());
  return tooBroadRepo(dir) || home.startsWith(dir.endsWith(sep) ? dir : dir + sep) || /^\/Volumes\/[^/]+$/.test(dir);
}

const out = (r: { stdout: string }) => r.stdout.trim();

/** Repository root containing `dir`, or null when it is not inside a repository. */
export async function repoRoot(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const r = await git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], { allowFail: true });
  const lines = r.code === 0 ? linesOf(r.stdout, 2) : undefined;
  if (!lines) return null;
  const [top, gitDir] = lines;
  // A `core.worktree` naming another folder than the one holding the repository: a snapshot would take
  // that folder's files in, and applying a result would write there. Refused.
  if (!ownsWorkTree(gitDir, top))
    throw new GitError(t().gitFailed('config', `core.worktree "${top ?? ''}" is not the repository's own folder`));
  return realpathSync(top!);
}

/**
 * The files under `dir` that git does not ignore (tracked, or untracked and not ignored), relative to
 * `dir` with `/`; null when `dir` is not in a repository, 'too-many' when the list is huge (16 MB).
 */
export async function unignoredFiles(dir: string): Promise<string[] | 'too-many' | null> {
  const r = await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    allowFail: true,
    maxCapture: 16 * 1024 * 1024,
    keepStart: true,
  });
  if (r.code !== 0) return null;
  if (r.stdoutTruncated) return 'too-many';
  // A tracked file deleted from the working tree is listed too: the caller skips what is not there.
  return [...new Set(r.stdout.split('\0').filter(Boolean))];
}

/** Make sure `dir` is inside a git repository, running `git init` when it is not. */
export async function ensureRepo(dir: string): Promise<{ root: string; created: boolean }> {
  const existing = await repoRoot(dir);
  // e.g. a dotfiles repository in the home directory: every turn would snapshot all of it.
  if (existing && tooBroadRepo(existing)) throw new HttpError(400, t().repoTooBroad(existing));
  if (existing) return { root: existing, created: false };

  const real = realpathSync(dir);
  if (tooBroadForInit(real)) throw new HttpError(400, t().noAutoRepo(real));
  // A `.git` that is there but is no repository (a link an agent made, to a folder elsewhere say): git
  // init would make that folder a repository, wherever it is. Left as it is.
  const dotGit = join(real, '.git');
  if (existsSync(dotGit) || isLink(dotGit)) throw new GitError(t().gitFailed('init', t().gitGuard.notRepository(dotGit)));
  await git(real, ['init', '-q']);
  const info = join(dotGit, 'info');
  mkdirSync(info, { recursive: true });
  if (isLink(info)) throw new GitError(t().gitFailed('init', t().gitGuard.link(info)));
  // Not through a link either (O_NOFOLLOW where the system has it).
  const fd = openSync(join(info, 'exclude'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0));
  try {
    appendFileSync(fd, `\n# Added by Harness Relay\n${DEFAULT_EXCLUDES.join('\n')}\n`);
  } finally {
    closeSync(fd);
  }
  return { root: real, created: true };
}

/** A folder's real path (links resolved), or the path itself when it does not exist. */
function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Pathspecs that leave `folders` out of `git add`, for those inside `root` (links resolved, so a
 * folder reached through a link is still found). Paths outside it need nothing.
 */
export function excludePathspecs(root: string, folders: string[]): string[] {
  const top = realOr(root);
  const specs: string[] = [];
  for (const folder of folders) {
    if (!folder) continue;
    const rel = relative(top, realOr(folder));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    specs.push(`:(exclude,literal)${rel.split(sep).join('/')}`);
  }
  return specs;
}

/**
 * Commit the current state of the working tree (tracked + untracked, honouring ignores) without
 * changing HEAD, the index or any file: into Harness Relay's own repository (`storeOf()`), staged in its
 * own index of the folder (`stagedTree()`). Nothing is written in the working repository's `.git`, and
 * nothing there is taken as written: neither its index (an agent could make it name any content for a
 * file it changed) nor its objects. Its parent is the working repository's HEAD.
 * `exclude`: folders never taken in, such as the CLIs' own homes (their sign-ins and transcripts).
 */
export async function snapshot(root: string, exclude: string[] = []): Promise<{ commit: string; tree: string }> {
  const store = await storeOf(root);
  // What it reads of the working repository, in one git command (on Windows a git process costs about
  // half a second): its common git folder (its `info/exclude`) and the commit HEAD names. Two lines, or
  // one on an unborn branch (exit code 1). Five processes in all, which test/workspace.test.ts counts.
  const where = await git(root, ['rev-parse', '--git-common-dir', '--verify', '-q', 'HEAD'], { allowFail: true });
  const lines = linesOf(where.stdout, where.code === 0 ? 2 : 1);
  if (!lines) throw new GitError(t().gitFailed('rev-parse', tail(where.stderr || where.stdout, 500) || `exit code ${where.code}`));
  const [common, head] = lines;
  noteObjects(store, root, common!);
  // Its excludes (Harness Relay's DEFAULT_EXCLUDES among them), as the store's: read as a small regular
  // file (never through a link, never waiting on a pipe), never written.
  const excludes = regularFile(join(resolve(root, common!), 'info', 'exclude')) ?? Buffer.alloc(0);
  const ownExclude = join(store, 'info', 'exclude');
  mkdirSync(dirname(ownExclude), { recursive: true });
  writeFileSync(ownExclude, excludes);
  const skip = excludePathspecs(root, exclude);
  // Its own index of the folder, one for each set of folders left out and of the repository's top
  // ignore rules (its `info/exclude` and `.gitignore`): what it holds stays in it while it is there, so
  // a folder left out since, or a file ignored since, would stay in the snapshots. A rule changed in a
  // `.gitignore` deeper in is seen once one of those changes. The others for the same folders go.
  const leftOut = createHash('sha256').update(skip.join('\0')).digest('hex').slice(0, 12);
  const rules = createHash('sha256')
    .update(excludes)
    .update('\0')
    .update(regularFile(join(root, '.gitignore')) ?? '')
    .digest('hex')
    .slice(0, 12);
  const caches = join(store, 'relay-index');
  const cache = join(caches, `work-${leftOut}-${rules}`);
  const add = ['add', '-A', ...(skip.length ? ['--', '.', ...skip] : [])];
  const tree = await stagedTree(store, root, cache, add, where.code === 0 ? head : undefined);
  for (const name of readdirSync(caches))
    if (name.startsWith(`work-${leftOut}-`) && name !== basename(cache) && !name.includes('.')) rmSync(join(caches, name), { force: true });
  const parent = where.code === 0 && head ? head : undefined;
  const commit = await makeCommit(store, tree, parent ? [parent] : [], 'Harness Relay snapshot');
  return { commit, tree };
}

const refDir = (convId: string) => `${REF_PREFIX}/${convId}`;

/**
 * Keep commits shown in a conversation (snapshots, worktree results) reachable, so `git gc` does
 * not prune them while the conversation still links to their diff.
 */
export async function keepCommits(root: string, convId: string, commits: string[]): Promise<void> {
  const unique = [...new Set(commits)];
  if (!unique.length) return;
  const store = await storeOf(root);
  const stdin = unique.map((c) => `update ${refDir(convId)}/${c} ${c}\n`).join('');
  await inStore(root, ['update-ref', '--stdin'], { stdin });
  await tidyStore(store);
}

/** Stop keeping some of a conversation's commits (their messages were dropped). */
export async function forgetCommits(root: string, convId: string, commits: string[]): Promise<void> {
  const unique = [...new Set(commits)];
  if (!unique.length || !existsSync(root)) return;
  const store = await storeOf(root);
  const stdin = unique.map((c) => `delete ${refDir(convId)}/${c}\n`).join('');
  await inStore(root, ['update-ref', '--stdin'], { stdin, allowFail: true });
}

/** Drop the refs a conversation kept in this repository (when the conversation is deleted). */
export async function dropKeptCommits(root: string, convId: string): Promise<void> {
  if (!existsSync(root)) return;
  const store = await storeOf(root);
  const r = await git(store, ['for-each-ref', '--format=delete %(refname)', `${refDir(convId)}/`], {
    gitDir: store,
    allowFail: true,
    maxCapture: MAX_OUTPUT_BYTES,
  });
  if (r.code !== 0 || !r.stdout.trim()) return;
  await git(store, ['update-ref', '--stdin'], { gitDir: store, stdin: r.stdout, allowFail: true });
}

export async function treeOf(root: string, commit: string): Promise<string> {
  return out(await inStore(root, ['rev-parse', `${commit}^{tree}`]));
}

/**
 * The commits a repository's branches and HEAD point at (team checks: where its history stood), without
 * Harness Relay's own: the parallel-mode branches (`relay/*`; its snapshots are not on branches). Empty
 * for a repository with no commit yet.
 */
export async function branchTips(root: string): Promise<string[]> {
  const r = await git(root, ['show-ref', '--head', '--heads'], { allowFail: true });
  const tips = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(' ');
    if (!sha || !ref || ref.startsWith('refs/heads/relay/')) continue;
    tips.add(sha);
  }
  return [...tips];
}

/** A file's content at a commit (team checks: `package.json` before and after a run), or undefined when it is not there. */
export async function fileAt(root: string, commit: string, path: string): Promise<string | undefined> {
  const r = await inStore(root, ['show', `${commit}:${path.split(sep).join('/')}`], { allowFail: true, maxCapture: 4 * 1024 * 1024 });
  return r.code === 0 ? r.stdout : undefined;
}

/** A commit the team made (team checks), with its subject. */
export interface MadeCommit {
  sha: string;
  subject: string;
  /** Committer time, in milliseconds. */
  at: number;
}

/**
 * Commits on the repository's branches and HEAD now (`branchTips`) that were on none of `before`, made
 * since `since` (milliseconds; a branch switched to brings older commits, which the team did not make),
 * newest first, merges left out; at most `limit`, and whether there were more.
 */
export async function commitsSince(
  root: string,
  before: readonly string[],
  since: number,
  limit: number,
): Promise<{ commits: MadeCommit[]; more: boolean }> {
  const now = await branchTips(root);
  if (!now.length) return { commits: [], more: false };
  const r = await git(root, [
    'log',
    '--no-merges',
    '--format=%H%x00%ct%x00%s',
    `--since=${Math.floor(since / 1000)}`,
    `--max-count=${limit + 1}`,
    ...now,
    ...(before.length ? ['--not', ...before] : []),
    '--',
  ]);
  const commits = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', at = '0', ...subject] = line.split('\0');
      return { sha, at: Number(at) * 1000, subject: subject.join('\0') };
    })
    .filter((c) => c.sha && c.at >= since);
  return { commits: commits.slice(0, limit), more: commits.length > limit };
}

/** Files changed between two commits. NUL-separated output keeps unusual file names intact. */
export async function diffFiles(root: string, base: string, head: string): Promise<FileChange[]> {
  // One git command for the statuses (`--raw`) and the line counts (`--numstat`): each one also reads
  // the repository's config first (`repoDriverGuards`), and on Windows a git process costs about half a
  // second. Twice the output limit, as the two commands this was had one each.
  const r = await inStore(root, ['diff', '--no-renames', '-z', '--raw', '--numstat', base, head], {
    maxCapture: 2 * MAX_OUTPUT_BYTES,
    complete: true,
  });
  return parseDiffFiles(r.stdout);
}

/**
 * Of `paths` (the repository's, as git names them), those added or changed between two commits whose
 * added or removed lines hold `word` (git's `-G`; a binary file has no such lines), in one git command:
 * the scripts a turn changed where they read a variable, say. `word` is letters, digits and `_` only;
 * each path is taken literally, never as a pattern.
 */
export async function changedWithWord(root: string, base: string, head: string, word: string, paths: readonly string[]): Promise<string[]> {
  if (!/^\w+$/.test(word)) throw new Error(`Not a word: ${word}`);
  if (!paths.length) return [];
  const r = await inStore(
    root,
    ['diff', '--no-renames', '-z', '--name-only', '--diff-filter=AM', `-G${word}`, base, head, '--', ...paths.map((p) => `:(literal)${p}`)],
    { maxCapture: MAX_OUTPUT_BYTES },
  );
  return r.stdout.split('\0').filter(Boolean);
}

/**
 * `git diff --no-renames -z --raw --numstat`'s output: first each file's raw entry,
 * ":<mode> <mode> <object> <object> <status>\0<path>\0", then each one's counts,
 * "<added>\t<deleted>\t<path>\0" ("-" for a binary file).
 */
export function parseDiffFiles(output: string): FileChange[] {
  const fields = output.split('\0');
  const changed: { path: string; status: FileChange['status'] }[] = [];
  let i = 0;
  // A raw entry's path is the field after its header, whatever it holds (even a leading ':').
  for (; i + 1 < fields.length && fields[i]!.startsWith(':'); i += 2) {
    const code = fields[i]!.slice(fields[i]!.lastIndexOf(' ') + 1);
    changed.push({ path: fields[i + 1]!, status: code[0] === 'A' ? 'A' : code[0] === 'D' ? 'D' : 'M' });
  }
  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  for (; i < fields.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(fields[i]!);
    if (m) counts.set(m[3]!, { added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
  }
  return changed.map((c) => ({ ...c, ...(counts.get(c.path) ?? { added: null, deleted: null }) }));
}

/**
 * Unified diff between two commits, truncated for display. With `folder`, its paths start with it
 * (`a/<folder>/src/x.ts`), so the diffs of several repositories can be read one after another.
 */
export async function diffText(root: string, base: string, head: string, folder?: string): Promise<string> {
  // Git's own prefixes always, whatever the user's config says (`diff.noprefix`, `diff.srcPrefix`…):
  // the diff dialog reads each file's path after them (`src/web/diff.ts`).
  const sub = folder ? `${folder}/` : '';
  const prefix = ['--src-prefix', `a/${sub}`, '--dst-prefix', `b/${sub}`];
  const r = await inStore(root, ['diff', '--no-color', '--no-renames', ...prefix, base, head], {
    maxCapture: MAX_DIFF_BYTES,
    keepStart: true,
  });
  if (!r.stdoutTruncated) return r.stdout;
  return `${r.stdout}\n\n${truncatedNote(Math.round(r.stdoutSize / 1024))}\n`;
}

/**
 * Git's diff of some files alone between two commits (paths from the repository's top, taken as they
 * are: no glob), with git's own prefixes; '' for none. Cut at `MAX_DIFF_BYTES` as `diffText()` is.
 */
export async function diffPaths(root: string, base: string, head: string, paths: readonly string[]): Promise<string> {
  if (!paths.length) return '';
  const r = await inStore(
    root,
    [
      'diff',
      '--no-color',
      '--no-renames',
      // As text, a file git calls binary too (a NUL in a comment, `-diff` in .gitattributes): a script still shows.
      '--text',
      '--src-prefix',
      'a/',
      '--dst-prefix',
      'b/',
      base,
      head,
      '--',
      ...paths.map((p) => `:(literal)${p}`),
    ],
    { maxCapture: MAX_DIFF_BYTES, keepStart: true },
  );
  if (!r.stdoutTruncated) return r.stdout;
  return `${r.stdout}\n\n${truncatedNote(Math.round(r.stdoutSize / 1024))}\n`;
}

/**
 * What git itself reads for a repository: the settings of its own config (the local and worktree scopes,
 * with the files they include, each key's values in order), and the folder its hooks run from
 * (`core.hooksPath` from any scope, else the repository's `hooks`). For a fixed command's pin, which
 * pins what a command running git there would have git run. Undefined outside a repository.
 */
export async function repoGitState(
  dir: string,
): Promise<{ settings: Map<string, string[]>; hooksDir: string; includes: string[] } | undefined> {
  if (!existsSync(dir)) return undefined;
  // Not in a repository: nothing. Any other failure throws: a pin must never take "unreadable" for "none".
  const top = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true, env: { LC_ALL: 'C', LANGUAGE: '' } });
  if (top.code !== 0) {
    if (/not a git repository/i.test(top.stderr)) return undefined;
    throw new GitError(t().gitFailed('rev-parse', tail(top.stderr || top.stdout, 500)));
  }
  const root = realpathSync(out(top));
  // Read whole, or refused: a config padded past the limit would hide what follows.
  const list = await git(root, ['config', '--list', '--includes', '--show-origin', '--show-scope', '-z'], {
    maxCapture: GIT_CONFIG_BYTES,
    keepStart: true,
    complete: true,
  });
  const settings = new Map<string, string[]>();
  const includes: string[] = [];
  let hooksPath: string | undefined;
  const parts = list.stdout.split('\0');
  // `<scope>\0<origin>\0<key>\n<value>\0` for each: three fields and the empty one after the last.
  if (list.stdout && parts.length % 3 !== 1) throw new GitError(t().gitFailed('config', 'unexpected output'));
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const scope = parts[i]!;
    const origin = parts[i + 1]!;
    const entry = parts[i + 2]!;
    const at = entry.indexOf('\n');
    const key = (at === -1 ? entry : entry.slice(0, at)).toLowerCase();
    const value = at === -1 ? '' : entry.slice(at + 1);
    // Harness Relay's own `-c` settings are the command's, never the repository's.
    if (scope === 'command') continue;
    if (key === 'core.hookspath') hooksPath = value;
    if (scope !== 'local' && scope !== 'worktree') continue;
    settings.set(key, [...(settings.get(key) ?? []), value]);
    // A file it includes, whether or not its condition holds now (an `includeIf` on a branch may later).
    if (key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))) {
      const from = origin.startsWith('file:') ? dirname(resolve(root, origin.slice(5))) : root;
      includes.push(value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(from, value));
    }
  }
  const common = (await git(root, ['rev-parse', '--git-common-dir'], { allowFail: true })).stdout.trim();
  const hooksDir = hooksPath
    ? hooksPath.startsWith('~/')
      ? join(homedir(), hooksPath.slice(2))
      : resolve(root, hooksPath)
    : join(resolve(root, common || '.git'), 'hooks');
  return { settings, hooksDir, includes };
}

/**
 * What a fixed command's first Save compares its code with: the repository's HEAD commit, or its empty
 * tree when it has none yet (every file is new then).
 */
export async function committedBase(root: string): Promise<string> {
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFail: true });
  if (head.code === 0 && out(head)) return out(head);
  const store = await storeOf(root);
  return out(await git(store, ['mktree'], { gitDir: store, stdin: '' }));
}

/** Of `paths` (from the repository's top), those that differ between `base` and `head`. */
export async function changedPaths(root: string, base: string, head: string, paths: readonly string[]): Promise<string[]> {
  if (!paths.length) return [];
  const r = await inStore(root, ['diff', '--name-only', '--no-renames', '-z', base, head, '--', ...paths.map((p) => `:(literal)${p}`)], {
    maxCapture: MAX_DIFF_BYTES,
    keepStart: true,
    complete: true,
  });
  return r.stdout.split('\0').filter(Boolean);
}

/** The paths (from the repository's top) of every file `commit` holds. */
export async function treePaths(root: string, commit: string): Promise<Set<string>> {
  const r = await inStore(root, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit], {
    maxCapture: MAX_DIFF_BYTES,
    keepStart: true,
    complete: true,
  });
  return new Set(r.stdout.split('\0').filter(Boolean));
}

/** Harness Relay's own index of a worktree (what it last recorded there: a cache of each file's hash), in its repository. */
function worktreeIndex(store: string, path: string): string {
  return join(store, 'relay-index', createHash('sha256').update(resolve(path)).digest('hex').slice(0, 24));
}

/**
 * A checkout of `commit` at `path`, made anew: the files, and a repository of its own for whoever works
 * there (an agent's git, a check's command), made by Harness Relay before anyone else writes in the
 * folder: its objects read from Harness Relay's repository and the working repository's (alternates, so nothing is copied), its HEAD
 * on `branch` at `commit`, or detached there. Harness Relay never writes in that `.git` again: what is
 * done in the folder is read from its files (`commitWorktree()`). `index`: Harness Relay's own index of
 * the files it wrote, kept (else a temporary one).
 */
async function checkout(root: string, path: string, commit: string, o: { branch?: string; index?: string } = {}): Promise<void> {
  const store = await storeOf(root);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  const tmp = o.index ? undefined : mkdtempSync(join(tmpdir(), 'relay-index-'));
  const index = o.index ?? join(tmp!, 'index');
  try {
    mkdirSync(dirname(index), { recursive: true });
    rmSync(index, { force: true });
    await git(path, ['read-tree', '-u', '--reset', commit], { gitDir: store, workTree: path, env: { GIT_INDEX_FILE: index } });
    const own = join(path, '.git');
    // Its branch's name (git 2.31 and later: an older one names it `master`).
    const branch = o.branch ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'init.defaultBranch', GIT_CONFIG_VALUE_0: o.branch } : {};
    await git(path, ['init', '-q', '--template=', path], { env: { ...branch, GIT_DEFAULT_HASH: storeFormat(store) } });
    // Its objects: Harness Relay's (the snapshot and the results), and the working repository's (its history).
    const alternates = join(own, 'objects', 'info', 'alternates');
    mkdirSync(dirname(alternates), { recursive: true });
    const theirs = workObjects.get(store);
    writeFileSync(alternates, [join(store, 'objects'), ...(theirs ? [theirs] : [])].map((d) => `${alternateEntry(d, '\n')}\n`).join(''));
    await git(path, ['update-ref', ...(o.branch ? [] : ['--no-deref']), 'HEAD', commit], { gitDir: own, workTree: path });
    // The index of the files just written, so that its git finds them as they are (`git status` clean).
    writeFileSync(join(own, 'index'), readFileSync(index));
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** The object format of Harness Relay's repository (its working repository's), for a repository made to read its objects. */
function storeFormat(store: string): string {
  return /^\s*objectformat\s*=\s*sha256\s*$/im.test(smallFile(join(store, 'config')) ?? '') ? 'sha256' : 'sha1';
}

/**
 * Create (or recreate) an agent's worktree at `path`, at `base`: a checkout of its own (`checkout()`),
 * and its branch in Harness Relay's repository, where each turn's result is recorded (`commitWorktree()`).
 */
export async function createWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
  const store = await storeOf(root);
  await checkout(root, path, base, { branch, index: worktreeIndex(store, path) });
  await git(store, ['update-ref', `refs/heads/${branch}`, base], { gitDir: store });
}

/** Removes a worktree or a check tree: its folder, Harness Relay's index of it, and its branch in Harness Relay's repository. */
export async function removeWorktree(root: string, path: string, branch?: string): Promise<void> {
  try {
    rmSync(worktreeIndex(repoStore(root), path), { force: true });
    if (branch && existsSync(join(repoStore(root), 'HEAD')))
      await inStore(root, ['update-ref', '-d', `refs/heads/${branch}`], { allowFail: true });
  } finally {
    // Harness Relay's own folder (in its data folder): gone even when git could not remove it.
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * A checkout of `commit` with no branch, at `path` (team checks: a parallel result checked on the
 * working directory as it is, before it is applied). Remove it with `removeWorktree()`.
 */
export async function addCheckTree(root: string, path: string, commit: string): Promise<void> {
  await checkout(root, path, commit);
}

/** Applies a checked patch onto another checkout of its repository (a check tree). */
export async function applyPatchIn(dir: string, p: CheckedPatch): Promise<void> {
  await git(dir, ['apply', '--whitespace=nowarn', '-'], { gitDir: await storeOf(p.root), workTree: dir, stdin: p.patch });
}

/**
 * Where a worktree's branch is: its commit and tree, in Harness Relay's repository, or for a worktree an
 * older Harness Relay made (its branch in the working repository), there, read only.
 */
async function worktreeTip(root: string, branch: string): Promise<{ commit: string; tree: string; own: boolean }> {
  const ref = `refs/heads/${branch}`;
  for (const own of [true, false]) {
    const args = ['rev-parse', ref, `${ref}^{tree}`];
    const r = own ? await inStore(root, args, { allowFail: true }) : await git(root, args, { allowFail: true });
    const lines = r.code === 0 ? linesOf(r.stdout, 2) : undefined;
    if (lines) return { commit: lines[0]!, tree: lines[1]!, own };
  }
  throw new GitError(t().gitFailed('rev-parse', t().gitGuard.noWorktreeBranch(branch)));
}

/** The commit a worktree's result is at: its branch in Harness Relay's repository. */
export async function worktreeHead(root: string, branch: string): Promise<string> {
  return (await worktreeTip(root, branch)).commit;
}

/**
 * The tree of a worktree's files as they are, staged in Harness Relay's own index of it, with its
 * repository's excludes (the working repository's, `snapshot()`): never the worktree's own `.git`,
 * which whoever works there writes, and git never takes in.
 */
async function folderTree(root: string, path: string): Promise<string> {
  const store = await storeOf(root);
  return stagedTree(store, path, worktreeIndex(store, path), ['add', '-A']);
}

/**
 * Whether a worktree holds anything since `base`, the snapshot it was made from: a result recorded on
 * top of it, or files changed since (a turn the server did not see through).
 */
export async function worktreeChanged(root: string, path: string, branch: string, base: string): Promise<boolean> {
  const tip = await worktreeTip(root, branch);
  if (tip.commit !== base) return true;
  return (await folderTree(root, path)) !== tip.tree;
}

/**
 * Record a worktree's files as they are on its branch, in Harness Relay's repository; returns the new
 * commit, or null when nothing changed. Whatever the agent did with git there (commits, a merge, another
 * branch) is in its own repository: its result is its files.
 */
export async function commitWorktree(root: string, path: string, branch: string, message: string): Promise<string | null> {
  const tip = await worktreeTip(root, branch);
  const tree = await folderTree(root, path);
  if (tree === tip.tree) return null;
  const store = await storeOf(root);
  const commit = await makeCommit(store, tree, [tip.commit], message);
  // Its branch, only from the commit it was on (made, for a worktree an older Harness Relay made).
  await git(store, ['update-ref', '-m', `commit: ${message}`, `refs/heads/${branch}`, commit, tip.own ? tip.commit : ''], {
    gitDir: store,
  });
  return commit;
}

/** Changes base..head checked against the repository's working tree, ready to apply (`applyPatch`). */
export interface CheckedPatch {
  root: string;
  files: FileChange[];
  patch: Buffer;
}

/**
 * The changes base..head as a patch, checked against the repository's working tree: a conflicting
 * one is a 409, with git's reason. Nothing is changed. `null` when base..head changes nothing.
 */
export async function checkPatch(root: string, base: string, head: string): Promise<CheckedPatch | null> {
  const files = await diffFiles(root, base, head);
  if (!files.length) return null;
  // The patch as bytes: CRLF line endings and non-UTF-8 content must reach `git apply` unchanged.
  const patch = (await inStore(root, ['diff', '--binary', '--no-renames', base, head], { maxCapture: MAX_OUTPUT_BYTES, complete: true }))
    .stdoutBytes;
  // Checked on the working tree with Harness Relay's own repository: `git apply` writes only the files it changes.
  const check = await git(root, ['apply', '--check', '--whitespace=nowarn', '-'], {
    gitDir: await storeOf(root),
    workTree: root,
    stdin: patch,
    allowFail: true,
  });
  if (check.code !== 0) throw new HttpError(409, t().applyConflict(tail(check.stderr, 800)));
  return { root, files, patch };
}

/** Applies a checked patch onto its repository's working tree (not the index; nothing is committed). */
export async function applyPatch(p: CheckedPatch): Promise<void> {
  await git(p.root, ['apply', '--whitespace=nowarn', '-'], { gitDir: await storeOf(p.root), workTree: p.root, stdin: p.patch });
}

/**
 * Apply the changes base..head onto the repository's working tree (not the index; nothing is
 * committed). Checks first, so a conflicting patch changes nothing.
 */
export async function applyToWorkingTree(root: string, base: string, head: string): Promise<FileChange[]> {
  const checked = await checkPatch(root, base, head);
  if (!checked) throw new HttpError(400, t().nothingToApply);
  await applyPatch(checked);
  return checked.files;
}

/** The same sub-directory of the worktree as the conversation's cwd is of the repository. */
export function worktreeDir(root: string, cwd: string, worktreePath: string): string {
  const rel = relative(root, realpathSync(cwd));
  return rel && !rel.startsWith('..') ? join(worktreePath, rel) : worktreePath;
}

/** Where the agent should run inside its worktree (created if missing). */
export function worktreeCwd(root: string, cwd: string, worktreePath: string): string {
  const dir = worktreeDir(root, cwd, worktreePath);
  mkdirSync(dir, { recursive: true });
  return dir;
}
