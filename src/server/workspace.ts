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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { truncatedNote } from '../shared/diff';
import type { FileChange } from '../shared/types';
import { HttpError } from './errors';
import { tail } from './process';
import { captureGit, gitCommand } from './gitProcess';
import { t } from './i18n';

/**
 * Git plumbing for Harness Relay:
 * - make a working directory a repository (auto `git init`);
 * - take snapshots of the working tree (tracked + untracked, honouring .gitignore) as commits,
 *   without touching the user's branch, index or files;
 * - per-agent worktrees for parallel mode, and applying an agent's result back.
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
  // What a repository's config could have git do by itself in a git folder an agent wrote: reuse a
  // recorded resolution (rerere, its folder possibly a link), or clean up after itself (gc, maintenance).
  '-c',
  'rerere.enabled=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
];

/** The keys of a repository's config that name a driver which runs a command (git then runs none when it is empty). */
const DRIVER_KEYS: Record<string, string[]> = {
  filter: ['clean', 'smudge', 'process'],
  diff: ['textconv', 'command'],
  merge: ['driver'],
};

/** How deep `repoDriverGuards` follows repositories inside repositories before it refuses. */
const MAX_NESTED = 8;

/**
 * `-c` settings that keep a repository's own config from making Harness Relay's git commands, which
 * run outside any sandbox, run a command. An agent's sandbox may let it write the repository's
 * `.git/config` (Grok's does): there, or in what it includes or its `config.worktree`, it could set
 * a filter, diff or merge driver that `git add`, a checkout or a diff would run. Each driver the
 * repository's own settings name is emptied (its `fsmonitor` is off in `CONFIG`, its hooks too); the
 * user's own and the system's (git-lfs, say) are left as they are. A driver name git's `-c` cannot
 * carry (with `=`) refuses the command, and so does a `core.worktree` naming a folder other than the
 * one that holds the repository (a snapshot would take that folder's files in, and applying write there).
 * `nested` (for `git add`): also the drivers of the repositories at the index's submodules, which
 * `git add` runs `git status` in, each with its own config (the `-c` settings reach it); an agent
 * can write theirs, and in a worktree make one where a submodule's folder is empty.
 */
/** Most of a repository's config Harness Relay reads, for its guards and a fixed command's pin. */
const GIT_CONFIG_BYTES = 16 * 1024 * 1024;

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
  const subs = await submoduleRepos(cwd, env, bin);
  const gitBin = bin ?? (await gitCommand(env));
  const outer = subs.length ? await askFolders(cwd, env, gitBin, 'add') : undefined;
  for (const sub of subs) {
    if (depth >= MAX_NESTED) throw new GitError(t().gitFailed('add', `repositories nested deeper than ${MAX_NESTED}`));
    refuseForeignSubmodule(outer!, sub, await askFolders(sub, env, gitBin, 'add'));
    // As git runs `git status` there: `cd <sub>; unset GIT_INDEX_FILE; GIT_DIR=.git`.
    const subEnv: NodeJS.ProcessEnv = { ...env, GIT_DIR: '.git' };
    delete subEnv.GIT_INDEX_FILE;
    out.push(...(await repoDriverGuards(sub, subEnv, true, depth + 1, bin)));
  }
  return out;
}

/** Refuses a repository whose `core.worktree` is not the folder holding its `.git` (a submodule's points back through its `.git` file). */
async function ownWorkTree(cwd: string, env: NodeJS.ProcessEnv, bin?: string): Promise<void> {
  const r = await captureGit([...CONFIG, 'rev-parse', '--absolute-git-dir', '--show-toplevel'], env, { cwd, timeoutMs: 30_000 }, bin);
  const [gitDir, top] = r.stdout.split('\n');
  let ok = false;
  try {
    const dotGit = join(top!, '.git');
    const held = statSync(dotGit).isDirectory() ? dotGit : resolve(top!, /^gitdir: (.+)$/m.exec(smallFile(dotGit) ?? '')?.[1] ?? '\0');
    ok = r.code === 0 && realpathSync(held) === realpathSync(gitDir!);
  } catch {
    // no `.git` there, or none that leads back: refused below
  }
  if (!ok) throw new GitError(t().gitFailed('config', `core.worktree "${top ?? ''}" is not the repository's own folder`));
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
  /** The repository's git folders as git found them a moment ago (`rev-parse`), for a command that writes there: else asked. */
  folders?: GitFolders;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  allowFail?: boolean;
  maxCapture?: number;
  /** Fail instead of returning output that went over `maxCapture`. */
  complete?: boolean;
  /** Keep the first `maxCapture` bytes instead of the last. */
  keepStart?: boolean;
}

/**
 * Plumbing that reads and writes only objects and refs: it never reads the working tree (so never
 * `core.worktree`) nor the index, and runs no filter, diff or merge driver, the commands
 * `repoDriverGuards` empties. What else a repository's config could have git run is off for every
 * command (`CONFIG`: hooks, the reference-transaction hook included, fsmonitor, signing;
 * `GIT_NO_LAZY_FETCH`: a promisor's fetch). Each guard is a git process of its own, about half a
 * second on Windows (seconds on a busy one), and a turn takes two snapshots and keeps their commits:
 * so these skip it. Not `write-tree`: it hashes an index entry that is racily clean again, through
 * the path's clean filter; nor `hash-object`, which runs it too.
 */
const OBJECTS_AND_REFS_ONLY = new Set(['commit-tree', 'mktree', 'update-ref', 'for-each-ref', 'show-ref', 'ls-tree']);

/**
 * `rev-parse`'s options that name objects, refs or the repository's own files, never the working
 * tree (`--show-toplevel` reads `core.worktree`, which the guards check is the repository's own folder).
 */
const REV_PARSE_PLUMBING = new Set(['--git-path', '--verify', '-q', '--quiet', '--git-dir', '--git-common-dir']);

/** Whether a git command needs the repository's drivers emptied first (`repoDriverGuards`): all but the plumbing above. */
export function needsDriverGuards(args: readonly string[]): boolean {
  const [command, ...rest] = args;
  if (command === undefined) return true;
  if (OBJECTS_AND_REFS_ONLY.has(command)) return false;
  // `rev-parse --git-path index --verify -q HEAD`: its options from the list, the rest revisions or a
  // path's name, none with a `:` (`:<path>` reads the index, `<rev>:<path>` a tree's file).
  if (command === 'rev-parse') return rest.some((a) => (a.startsWith('-') && !REV_PARSE_PLUMBING.has(a)) || a.includes(':'));
  return true;
}

/**
 * The git commands Harness Relay runs that write into the repository's git folder: objects (`add`,
 * `write-tree`, `commit-tree`, `mktree`), refs and their logs (`update-ref`, `branch`, `worktree
 * add`), a worktree's own folder (`worktree`), and a merge's state (`merge --quit`).
 */
const WRITES_GIT_DIR = new Set(['add', 'write-tree', 'commit-tree', 'mktree', 'update-ref', 'branch', 'commit', 'worktree', 'merge']);

/** The most entries `gitDirLink` looks at in one git folder before it refuses (a folder an agent filled to slow it). */
export const GIT_DIR_ENTRIES_MAX = 200_000;
let gitDirEntriesMax = GIT_DIR_ENTRIES_MAX;

/** For tests: another most entries `gitDirLink` looks at by default (none: GIT_DIR_ENTRIES_MAX again). */
export function setGitDirEntriesMax(max?: number): void {
  gitDirEntriesMax = max ?? GIT_DIR_ENTRIES_MAX;
}

/** The most a pointer file of a repository (`.git`, `commondir`) Harness Relay reads itself may hold. */
const POINTER_MAX = 64 * 1024;

/**
 * The text of a regular file of at most `max` bytes, or undefined: not there, a link, a named pipe or a
 * device, or larger. Opened without following a link and without waiting (a pipe an agent made in its
 * place would block the server's every request), then looked at as opened.
 */
function regularFile(path: string, max = POINTER_MAX): Buffer | undefined {
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

/** A repository's git folders, as git itself finds them from a folder: its own and the common one. */
export interface GitFolders {
  gitDir: string;
  common: string;
}

/**
 * `rev-parse`'s options for a repository's git folders: as git found them, not resolved through a link
 * (so a `.git` that is a link is seen as one), relative to the folder it ran in or absolute.
 */
const FOLDERS_ARGS = ['--git-dir', '--git-common-dir'];

/** The git folders from `rev-parse`'s first two lines (FOLDERS_ARGS), or undefined. Lines as git wrote them: a path may end in a space. */
function foldersFrom(cwd: string, lines: string[]): GitFolders | undefined {
  const [gitDir, common] = lines;
  if (!gitDir || !common) return undefined;
  return { gitDir: resolve(cwd, gitDir), common: resolve(cwd, common) };
}

/** A command's output in lines, as git wrote them (a CR only before each LF, from Git for Windows). */
const linesOf = (stdout: string): string[] => stdout.split(/\r?\n/);

/**
 * The repository's git folders as git itself finds them from `cwd` (one plumbing process, which reads
 * no working tree), never as Harness Relay would guess them: a git command finds its folders in ways
 * a guess can miss (a HEAD written without its space, a bare repository's layout, a path that ends in
 * a space). Refused when git cannot tell: a command that writes there never runs unchecked.
 */
async function askFolders(cwd: string, env: NodeJS.ProcessEnv, bin: string, command: string): Promise<GitFolders> {
  const probe: NodeJS.ProcessEnv = { ...env };
  delete probe.GIT_DIR;
  delete probe.GIT_INDEX_FILE;
  const r = await captureGit([...CONFIG, 'rev-parse', ...FOLDERS_ARGS], probe, { cwd, timeoutMs: 120_000 }, bin);
  const found = r.code === 0 ? foldersFrom(cwd, linesOf(r.stdout)) : undefined;
  if (!found)
    throw new GitError(
      t().gitFailed(command, t().gitGuard.noFolders(cwd, tail(r.stderr || r.stdout, 300).trim() || `exit code ${r.code}`)),
    );
  return found;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Why a git folder could not be looked at whole (too many entries, one that cannot be read): refused as a link would be. */
class GitDirUnchecked extends Error {}

/**
 * The files at the top of a git folder that git rewrites in place through its lock files, which follow
 * a link to what it names (only a ref's lock does not): the index, the config (`git branch -D` drops
 * its section), packed refs, and the state files of a merge or a cherry-pick.
 */
const REWRITTEN = [
  'HEAD',
  'index',
  'config',
  'config.worktree',
  'packed-refs',
  'shallow',
  'ORIG_HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'MERGE_MSG',
  'MERGE_MODE',
  'AUTO_MERGE',
  'CHERRY_PICK_HEAD',
  'COMMIT_EDITMSG',
];

/**
 * The first link (a symbolic link, or a junction on Windows) in what Harness Relay's git writes into in
 * this git folder, relative to it, or undefined. Git follows a link there: a linked folder under
 * `refs`, `reftable` or `logs` gets a ref or its log written (and deleted) where it points, a linked
 * log is appended to, a linked folder of `objects` or `worktrees` gets their files, and a linked file
 * it rewrites through a lock (`REWRITTEN`) gets rewritten where it points. Only a loose ref linked to a
 * file is left alone (its lock does not follow a link: the ref replaces the link), and the folders git
 * only reads (`hooks`, which `CONFIG` turns off, `info`). Looked at without following any link. Throws
 * `GitDirUnchecked` past `max` entries, or for an entry it cannot look at.
 */
export function gitDirLink(gitDir: string, max = gitDirEntriesMax): string | undefined {
  let seen = 0;
  /** Whether a link is one git may write through here: under `refs`, a link to a file is a ref git replaces by a rename. */
  const refused = (path: string, fileLinksOk: boolean) => {
    if (!fileLinksOk) return true;
    try {
      return !statSync(path).isFile();
    } catch {
      return true; // a link to nothing
    }
  };
  const unchecked = (path: string, err: unknown) => new GitDirUnchecked(t().gitGuard.unreadable(path, (err as Error).message));
  /** The first link git would write through in the real folder `path` (`rel`), `depth` folders down. */
  const within = (path: string, rel: string, depth: number, fileLinksOk: boolean): string | undefined => {
    let entries;
    try {
      // The entries' types as the folder lists them: no lstat each (a git folder's objects has 256)...
      entries = readdirSync(path, { withFileTypes: true });
    } catch (err) {
      throw unchecked(path, err);
    }
    for (const entry of entries) {
      if (++seen > max) throw new GitDirUnchecked(t().gitGuard.tooManyEntries(join(gitDir, rel), max));
      const child = join(path, entry.name);
      let link = entry.isSymbolicLink();
      let folder = entry.isDirectory();
      // ...but Windows lists every reparse point as a link (a file OneDrive keeps in the cloud, say):
      // only what lstat says is one (a link or a junction) is.
      if (link) {
        try {
          const st = lstatSync(child);
          link = st.isSymbolicLink();
          folder = st.isDirectory();
        } catch (err) {
          throw unchecked(child, err);
        }
      }
      if (link) {
        if (refused(child, fileLinksOk)) return `${rel}/${entry.name}`;
      } else if (folder && depth > 1) {
        const found = within(child, `${rel}/${entry.name}`, depth - 1, fileLinksOk);
        if (found) return found;
      }
    }
    return undefined;
  };
  /** `rel` when `path` is itself such a link; else the first one inside it. */
  const at = (path: string, rel: string, depth: number, fileLinksOk: boolean): string | undefined => {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return undefined; // not there (yet): git makes it a real folder or file
    }
    if (st.isSymbolicLink()) return refused(path, fileLinksOk) ? rel : undefined;
    return st.isDirectory() && depth > 0 ? within(path, rel, depth, fileLinksOk) : undefined;
  };
  for (const file of REWRITTEN) {
    const found = at(join(gitDir, file), file, 0, false);
    if (found) return found;
  }
  return (
    at(gitDir, '.', 0, false) ??
    // A loose object is written as a temporary file in its folder, then named: the folders alone.
    at(join(gitDir, 'objects'), 'objects', 1, false) ??
    at(join(gitDir, 'refs'), 'refs', Infinity, true) ??
    at(join(gitDir, 'reftable'), 'reftable', Infinity, false) ??
    at(join(gitDir, 'logs'), 'logs', Infinity, false) ??
    at(join(gitDir, 'worktrees'), 'worktrees', Infinity, false) ??
    at(join(gitDir, 'modules'), 'modules', Infinity, false)
  );
}

/**
 * Refuses a git command that writes into a repository's git folders (`folders`, as git found them)
 * when what it writes into there goes through a link (`gitDirLink`), or cannot be looked at whole: an
 * agent whose sandbox lets it write `.git` could have one point outside, where Harness Relay's git,
 * which runs outside any sandbox, would write. Checked just before the command; an agent that makes a
 * link while it runs is not caught (no git option stops git from following one).
 */
function refuseGitDirLinks(folders: GitFolders, command: string): void {
  for (const dir of new Set([folders.gitDir, folders.common])) {
    let rel: string | undefined;
    try {
      rel = gitDirLink(dir);
    } catch (err) {
      if (err instanceof GitDirUnchecked) throw new GitError(t().gitFailed(command, err.message));
      throw err;
    }
    if (rel) throw new GitError(t().gitFailed(command, t().gitGuard.link(rel === '.' ? dir : join(dir, rel))));
  }
}

/** Whether `path` is `folder` or inside it. */
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);

/**
 * Refuses a worktree whose git folder is not this one of `root`'s worktrees': an agent working in it can
 * rewrite its `.git` file (or the `commondir` it names) to name another repository, another member's
 * worktree, or a git folder of its own, where Harness Relay's git would then write (moving another
 * branch, say). As git itself checks a worktree: its folder in the common one's `worktrees`, whose
 * `gitdir` names this worktree's `.git` back.
 */
async function refuseForeignWorktree(root: string, path: string, mine: GitFolders): Promise<void> {
  const own = await gitFolders(root, 'commit');
  const back = smallFile(join(mine.gitDir, 'gitdir'))?.replace(/\r?\n$/, '');
  const ok =
    resolve(mine.gitDir) !== resolve(mine.common) &&
    realOr(mine.common) === realOr(own.common) &&
    dirname(realOr(mine.gitDir)) === join(realOr(own.common), 'worktrees') &&
    back !== undefined &&
    realOr(resolve(mine.gitDir, back)) === realOr(join(path, '.git'));
  if (!ok) throw new GitError(t().gitFailed('commit', t().gitGuard.notOwnWorktree(path, root)));
}

/**
 * Refuses a repository at a submodule (which `git add` runs `git status` in, rewriting its index)
 * whose git folder is outside the repository: its own `.git` folder, or one in the outer repository's
 * `modules` (the worktree's own, for a submodule of a linked worktree, or the common one's). An agent
 * can write a `.git` there naming any repository on the computer. Its git folder is checked for links
 * as the outer one's is.
 */
function refuseForeignSubmodule(outer: GitFolders, sub: string, inner: GitFolders): void {
  const common = realOr(inner.common);
  const allowed = [realOr(sub), join(realOr(outer.gitDir), 'modules'), join(realOr(outer.common), 'modules')];
  if (!allowed.some((folder) => inside(common, folder)))
    throw new GitError(t().gitFailed('add', t().gitGuard.foreignSubmodule(sub, inner.common)));
  refuseGitDirLinks(inner, 'add');
}

async function git(cwd: string, args: string[], o: GitOptions = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...IDENTITY, ...o.env };
  delete env.GIT_DIR; // never inherit a repository from the server's own environment
  delete env.GIT_WORK_TREE;
  if (!o.env?.GIT_INDEX_FILE) delete env.GIT_INDEX_FILE;
  // Never fetch an object that is missing: a partial clone's remote, which the repository's config
  // names, would be reached through a command it names too (`core.sshCommand`, say).
  env.GIT_NO_LAZY_FETCH = '1';
  // What the repository's own config would have git run is off (`repoDriverGuards`); a diff runs
  // no external diff or textconv either. A command that reads only objects and refs needs no guards.
  const bin = await gitCommand(env);
  const guards = existsSync(cwd) && needsDriverGuards(args) ? await repoDriverGuards(cwd, env, args[0] === 'add', 0, bin) : [];
  const command = String(args[0]);
  if (WRITES_GIT_DIR.has(command)) refuseGitDirLinks(o.folders ?? (await askFolders(cwd, env, bin, command)), command);
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
  const r = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return r.code === 0 ? realpathSync(out(r)) : null;
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

/** The repository's git folders as git finds them from `cwd` (`askFolders`), through git()'s own environment. */
async function gitFolders(cwd: string, command: string): Promise<GitFolders> {
  const r = await git(cwd, ['rev-parse', ...FOLDERS_ARGS], { allowFail: true });
  const found = r.code === 0 ? foldersFrom(cwd, linesOf(r.stdout)) : undefined;
  if (!found)
    throw new GitError(
      t().gitFailed(command, t().gitGuard.noFolders(cwd, tail(r.stderr || r.stdout, 300).trim() || `exit code ${r.code}`)),
    );
  return found;
}

/**
 * Commit the current state of the working tree (tracked + untracked, honouring ignores) without
 * changing HEAD, the index or any file: stage into a temporary copy of the index instead.
 * `exclude`: folders never taken in, such as the CLIs' own homes (their sign-ins and transcripts).
 */
export async function snapshot(root: string, exclude: string[] = []): Promise<{ commit: string; tree: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'relay-index-'));
  const index = join(dir, 'index');
  try {
    // The index's path and the commit HEAD names, in one git command (on Windows a git process costs
    // about half a second). `add` and `write-tree` read the repository's config first, for their guards
    // (`needsDriverGuards`), and `add` its index's submodules: seven processes in all, which
    // test/workspace.test.ts counts. A new repository has no commit yet: the path alone, exit code 1.
    // Its git folders too, as git finds them, for the link checks of the commands that write there.
    const where = await git(root, ['rev-parse', ...FOLDERS_ARGS, '--git-path', 'index', '--verify', '-q', 'HEAD'], { allowFail: true });
    const lines = linesOf(where.stdout);
    const folders = foldersFrom(root, lines);
    const [indexPath, head] = lines.slice(2).map((line) => line.trim());
    if (!folders || !indexPath) throw new GitError(t().gitFailed('rev-parse', tail(where.stderr || where.stdout, 500)));
    const parent = where.code === 0 && head ? head : null;
    const realIndex = isAbsolute(indexPath) ? indexPath : resolve(root, indexPath);
    // Starting from the real index lets git reuse its stat cache instead of re-hashing every file. A
    // regular file only, opened without waiting or following a link (`regularFile`): else git hashes all.
    const current = regularFile(realIndex, INDEX_MAX);
    if (current) writeFileSync(index, current);
    const env = { GIT_INDEX_FILE: index };
    const skip = excludePathspecs(root, exclude);
    await git(root, ['add', '-A', ...(skip.length ? ['--', '.', ...skip] : [])], { env, folders });
    const tree = out(await git(root, ['write-tree'], { env, folders }));
    const commit = out(
      await git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Harness Relay snapshot'], { folders }),
    );
    return { commit, tree };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const refDir = (convId: string) => `${REF_PREFIX}/${convId}`;

/** The largest index a snapshot starts from (a larger one, it does without: git hashes every file again). */
const INDEX_MAX = 512 * 1024 * 1024;

/**
 * Keep commits shown in a conversation (snapshots, worktree results) reachable, so `git gc` does
 * not prune them while the conversation still links to their diff.
 */
export async function keepCommits(root: string, convId: string, commits: string[]): Promise<void> {
  const unique = [...new Set(commits)];
  if (!unique.length) return;
  const stdin = unique.map((c) => `update ${refDir(convId)}/${c} ${c}\n`).join('');
  await git(root, ['update-ref', '--stdin'], { stdin });
}

/** Stop keeping some of a conversation's commits (their messages were dropped). */
export async function forgetCommits(root: string, convId: string, commits: string[]): Promise<void> {
  const unique = [...new Set(commits)];
  if (!unique.length || !existsSync(root)) return;
  const stdin = unique.map((c) => `delete ${refDir(convId)}/${c}\n`).join('');
  await git(root, ['update-ref', '--stdin'], { stdin, allowFail: true });
}

/** Drop the refs a conversation kept in this repository (when the conversation is deleted). */
export async function dropKeptCommits(root: string, convId: string): Promise<void> {
  if (!existsSync(root)) return;
  const r = await git(root, ['for-each-ref', '--format=delete %(refname)', `${refDir(convId)}/`], {
    allowFail: true,
    maxCapture: MAX_OUTPUT_BYTES,
  });
  if (r.code !== 0 || !r.stdout.trim()) return;
  await git(root, ['update-ref', '--stdin'], { stdin: r.stdout, allowFail: true });
}

export async function treeOf(root: string, commit: string): Promise<string> {
  return out(await git(root, ['rev-parse', `${commit}^{tree}`]));
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
  const r = await git(root, ['show', `${commit}:${path.split(sep).join('/')}`], { allowFail: true, maxCapture: 4 * 1024 * 1024 });
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
  const r = await git(root, ['diff', '--no-renames', '-z', '--raw', '--numstat', base, head], {
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
  const r = await git(
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
  const r = await git(root, ['diff', '--no-color', '--no-renames', ...prefix, base, head], { maxCapture: MAX_DIFF_BYTES, keepStart: true });
  if (!r.stdoutTruncated) return r.stdout;
  return `${r.stdout}\n\n${truncatedNote(Math.round(r.stdoutSize / 1024))}\n`;
}

/**
 * Git's diff of some files alone between two commits (paths from the repository's top, taken as they
 * are: no glob), with git's own prefixes; '' for none. Cut at `MAX_DIFF_BYTES` as `diffText()` is.
 */
export async function diffPaths(root: string, base: string, head: string, paths: readonly string[]): Promise<string> {
  if (!paths.length) return '';
  const r = await git(
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
  return out(await git(root, ['mktree'], { stdin: '' }));
}

/** Of `paths` (from the repository's top), those that differ between `base` and `head`. */
export async function changedPaths(root: string, base: string, head: string, paths: readonly string[]): Promise<string[]> {
  if (!paths.length) return [];
  const r = await git(root, ['diff', '--name-only', '--no-renames', '-z', base, head, '--', ...paths.map((p) => `:(literal)${p}`)], {
    maxCapture: MAX_DIFF_BYTES,
    keepStart: true,
    complete: true,
  });
  return r.stdout.split('\0').filter(Boolean);
}

/** The paths (from the repository's top) of every file `commit` holds. */
export async function treePaths(root: string, commit: string): Promise<Set<string>> {
  const r = await git(root, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit], {
    maxCapture: MAX_DIFF_BYTES,
    keepStart: true,
    complete: true,
  });
  return new Set(r.stdout.split('\0').filter(Boolean));
}

/** Create (or recreate) a worktree on `branch` starting at `base`. */
export async function createWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
  if (existsSync(path)) await removeWorktree(root, path);
  mkdirSync(join(path, '..'), { recursive: true });
  await git(root, ['worktree', 'add', '-q', '-f', '-B', branch, path, base]);
}

export async function removeWorktree(root: string, path: string, branch?: string): Promise<void> {
  try {
    if (existsSync(root)) {
      await git(root, ['worktree', 'remove', '--force', path], { allowFail: true });
      await git(root, ['worktree', 'prune'], { allowFail: true });
      if (branch) await git(root, ['branch', '-D', branch], { allowFail: true });
    }
  } finally {
    // Harness Relay's own folder (in its data folder): gone even when git refused the repository.
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * A worktree of `commit` with no branch, at `path` (team checks: a parallel result checked on the
 * working directory as it is, before it is applied). Remove it with `removeWorktree()`.
 */
export async function addCheckTree(root: string, path: string, commit: string): Promise<void> {
  // A tree a stopped server left is gone (removed at startup), but still registered: pruned first.
  await git(root, ['worktree', 'prune'], { allowFail: true });
  if (existsSync(path)) await removeWorktree(root, path);
  mkdirSync(join(path, '..'), { recursive: true });
  await git(root, ['worktree', 'add', '-q', '-f', '--detach', path, commit]);
}

/** Applies a checked patch onto another checkout of its repository (a check tree). */
export async function applyPatchIn(dir: string, p: CheckedPatch): Promise<void> {
  await git(dir, ['apply', '--whitespace=nowarn', '-'], { stdin: p.patch });
}

export async function worktreeHead(path: string): Promise<string> {
  return out(await git(path, ['rev-parse', 'HEAD']));
}

/**
 * Whether a worktree holds anything since `base`, the snapshot it was made from: a commit on top of
 * it, or a change not committed yet (a turn the server did not see through).
 */
export async function worktreeChanged(path: string, base: string): Promise<boolean> {
  if ((await worktreeHead(path)) !== base) return true;
  return out(await git(path, ['status', '--porcelain', '--untracked-files=all'])) !== '';
}

/** Commit everything in a worktree; returns the new HEAD, or null when nothing changed. */
export async function commitWorktree(root: string, path: string, message: string): Promise<string | null> {
  // Its git folders and the commit it is on, in one git command (on an unborn branch: exit 1, no commit).
  const where = await git(path, ['rev-parse', ...FOLDERS_ARGS, '--verify', '-q', 'HEAD'], { allowFail: true });
  const lines = linesOf(where.stdout);
  const folders = foldersFrom(path, lines);
  if (!folders) throw new GitError(t().gitFailed('commit', t().gitGuard.noFolders(path, tail(where.stderr || where.stdout, 300).trim())));
  await refuseForeignWorktree(root, path, folders);
  await git(path, ['add', '-A'], { folders });
  const staged = await git(path, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.code === 0) return null;
  // Plumbing, not `git commit`: that also cleans up a cherry-pick's sequencer folder, records rerere's
  // resolutions and writes COMMIT_EDITMSG, each in a git folder the agent could write, through a link.
  // As `git commit` would: a root commit on an unborn branch, and a merge the agent resolved concluded
  // with its other parents (MERGE_HEAD, read as `regularFile` reads: no link, no pipe).
  const parent = where.code === 0 ? lines[2]?.trim() || undefined : undefined;
  const merging = (smallFile(join(folders.gitDir, 'MERGE_HEAD')) ?? '').split(/\s+/).filter((l) => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(l));
  const parents = [...(parent ? [parent] : []), ...merging];
  const tree = out(await git(path, ['write-tree'], { folders }));
  const commit = out(await git(path, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], { folders }));
  // HEAD's branch, only from the commit it was on (or, unborn, only while it still is).
  await git(path, ['update-ref', '-m', `commit: ${message}`, 'HEAD', commit, parent ?? ''], { folders });
  if (merging.length) await git(path, ['merge', '--quit'], { folders, allowFail: true });
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
  const patch = (await git(root, ['diff', '--binary', '--no-renames', base, head], { maxCapture: MAX_OUTPUT_BYTES, complete: true }))
    .stdoutBytes;
  const check = await git(root, ['apply', '--check', '--whitespace=nowarn', '-'], { stdin: patch, allowFail: true });
  if (check.code !== 0) throw new HttpError(409, t().applyConflict(tail(check.stderr, 800)));
  return { root, files, patch };
}

/** Applies a checked patch onto its repository's working tree (not the index; nothing is committed). */
export async function applyPatch(p: CheckedPatch): Promise<void> {
  await git(p.root, ['apply', '--whitespace=nowarn', '-'], { stdin: p.patch });
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
