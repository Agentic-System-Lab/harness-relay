import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { FileChange } from '../shared/types';
import { HttpError } from './errors';
import { capture, tail } from './process';
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
const CONFIG = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never'];

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
export async function repoDriverGuards(cwd: string, env: NodeJS.ProcessEnv, nested = false, depth = 0): Promise<string[]> {
  const r = await capture('git', ['config', '-z', '--includes', '--show-scope', '--get-regexp', '^(filter|diff|merge)\\.|^core\\.worktree$'], env, {
    cwd,
    timeoutMs: 30_000,
  });
  // 1: none found. Anything else (a git too old for --show-scope, a config it cannot read): refuse,
  // rather than run the command without knowing what the repository would have it run.
  if (r.code !== 0 && r.code !== 1) throw new GitError(t().gitFailed('config', tail(r.stderr || r.stdout, 500)));
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
  if (workTree) await ownWorkTree(cwd, env);
  if (!nested) return out;
  for (const sub of await submoduleRepos(cwd, env)) {
    if (depth >= MAX_NESTED) throw new GitError(t().gitFailed('add', `repositories nested deeper than ${MAX_NESTED}`));
    // As git runs `git status` there: `cd <sub>; unset GIT_INDEX_FILE; GIT_DIR=.git`.
    const subEnv: NodeJS.ProcessEnv = { ...env, GIT_DIR: '.git' };
    delete subEnv.GIT_INDEX_FILE;
    out.push(...(await repoDriverGuards(sub, subEnv, true, depth + 1)));
  }
  return out;
}

/** Refuses a repository whose `core.worktree` is not the folder holding its `.git` (a submodule's points back through its `.git` file). */
async function ownWorkTree(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const r = await capture('git', [...CONFIG, 'rev-parse', '--absolute-git-dir', '--show-toplevel'], env, { cwd, timeoutMs: 30_000 });
  const [gitDir, top] = r.stdout.split('\n');
  let ok = false;
  try {
    const dotGit = join(top!, '.git');
    const held = statSync(dotGit).isDirectory() ? dotGit : resolve(top!, /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1] ?? '\0');
    ok = r.code === 0 && realpathSync(held) === realpathSync(gitDir!);
  } catch {
    // no `.git` there, or none that leads back: refused below
  }
  if (!ok) throw new GitError(t().gitFailed('config', `core.worktree "${top ?? ''}" is not the repository's own folder`));
}

/** The folders of the submodules (gitlinks) in `cwd`'s index that hold a repository (a `.git`). */
async function submoduleRepos(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  // `:/` lists the whole index, as `git add -A` takes it, with paths relative to `cwd`. Reading the
  // index would start its fsmonitor: `CONFIG` turns it off.
  const r = await capture('git', [...CONFIG, 'ls-files', '-z', '--stage', '--', ':/'], env, { cwd, timeoutMs: 120_000, maxCapture: MAX_OUTPUT_BYTES });
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
const DEFAULT_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.DS_Store', '.next/', '.turbo/', 'target/'];

const MAX_DIFF_BYTES = 1024 * 1024;
/** Output limit for file lists and patches; larger output is refused rather than silently cut. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
/** Snapshot commits recorded in the chat are kept reachable under this ref namespace (per conversation). */
const REF_PREFIX = 'refs/harness-relay';

export class GitError extends Error {}

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  allowFail?: boolean;
  maxCapture?: number;
  /** Fail instead of returning output that went over `maxCapture`. */
  complete?: boolean;
  /** Keep the first `maxCapture` bytes instead of the last. */
  keepStart?: boolean;
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
  // no external diff or textconv either.
  const guards = existsSync(cwd) ? await repoDriverGuards(cwd, env, args[0] === 'add') : [];
  const safe = args[0] === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
  const r = await capture('git', [...CONFIG, ...guards, ...safe], env, {
    cwd,
    stdin: o.stdin,
    timeoutMs: 120_000,
    maxCapture: o.maxCapture,
    keepStart: o.keepStart,
  });
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
  await git(real, ['init', '-q']);
  const exclude = join(real, '.git', 'info', 'exclude');
  mkdirSync(join(real, '.git', 'info'), { recursive: true });
  appendFileSync(exclude, `\n# Added by Harness Relay\n${DEFAULT_EXCLUDES.join('\n')}\n`);
  return { root: real, created: true };
}

async function headCommit(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  return r.code === 0 ? out(r) : null;
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
 * changing HEAD, the index or any file: stage into a temporary copy of the index instead.
 * `exclude`: folders never taken in, such as the CLIs' own homes (their sign-ins and transcripts).
 */
export async function snapshot(root: string, exclude: string[] = []): Promise<{ commit: string; tree: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'relay-index-'));
  const index = join(dir, 'index');
  try {
    const indexPath = out(await git(root, ['rev-parse', '--git-path', 'index']));
    const realIndex = isAbsolute(indexPath) ? indexPath : resolve(root, indexPath);
    // Starting from the real index lets git reuse its stat cache instead of re-hashing every file.
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { GIT_INDEX_FILE: index };
    const skip = excludePathspecs(root, exclude);
    await git(root, ['add', '-A', ...(skip.length ? ['--', '.', ...skip] : [])], { env });
    const tree = out(await git(root, ['write-tree'], { env }));
    const parent = await headCommit(root);
    const commit = out(
      await git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Harness Relay snapshot']),
    );
    return { commit, tree };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const refDir = (convId: string) => `${REF_PREFIX}/${convId}`;

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

/** Files changed between two commits. NUL-separated output keeps unusual file names intact. */
export async function diffFiles(root: string, base: string, head: string): Promise<FileChange[]> {
  const opts = { maxCapture: MAX_OUTPUT_BYTES, complete: true };
  const [names, nums] = await Promise.all([
    git(root, ['diff', '--no-renames', '-z', '--name-status', base, head], opts),
    git(root, ['diff', '--no-renames', '-z', '--numstat', base, head], opts),
  ]);
  // --numstat -z: "<added>\t<deleted>\t<path>\0" ("-" for binary files).
  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  for (const entry of nums.stdout.split('\0')) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(entry);
    if (m) counts.set(m[3]!, { added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
  }
  // --name-status -z: "<status>\0<path>\0" pairs.
  const fields = names.stdout.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i]!;
    const path = fields[i + 1]!;
    if (!code) break;
    const status = code[0] === 'A' ? 'A' : code[0] === 'D' ? 'D' : 'M';
    files.push({ path, status, ...(counts.get(path) ?? { added: null, deleted: null }) });
  }
  return files;
}

/**
 * Unified diff between two commits, truncated for display. With `folder`, its paths start with it
 * (`a/<folder>/src/x.ts`), so the diffs of several repositories can be read one after another.
 */
export async function diffText(root: string, base: string, head: string, folder?: string): Promise<string> {
  const prefix = folder ? ['--src-prefix', `a/${folder}/`, '--dst-prefix', `b/${folder}/`] : [];
  const r = await git(root, ['diff', '--no-color', '--no-renames', ...prefix, base, head], { maxCapture: MAX_DIFF_BYTES, keepStart: true });
  if (!r.stdoutTruncated) return r.stdout;
  return `${r.stdout}\n\n… diff truncated (${Math.round(r.stdoutSize / 1024)} KB total)\n`;
}

/** Create (or recreate) a worktree on `branch` starting at `base`. */
export async function createWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
  if (existsSync(path)) await removeWorktree(root, path);
  mkdirSync(join(path, '..'), { recursive: true });
  await git(root, ['worktree', 'add', '-q', '-f', '-B', branch, path, base]);
}

export async function removeWorktree(root: string, path: string, branch?: string): Promise<void> {
  if (existsSync(root)) {
    await git(root, ['worktree', 'remove', '--force', path], { allowFail: true });
    await git(root, ['worktree', 'prune'], { allowFail: true });
    if (branch) await git(root, ['branch', '-D', branch], { allowFail: true });
  }
  rmSync(path, { recursive: true, force: true });
}

export async function worktreeHead(path: string): Promise<string> {
  return out(await git(path, ['rev-parse', 'HEAD']));
}

/** Commit everything in a worktree; returns the new HEAD, or null when nothing changed. */
export async function commitWorktree(path: string, message: string): Promise<string | null> {
  await git(path, ['add', '-A']);
  const staged = await git(path, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (staged.code === 0) return null;
  await git(path, ['commit', '-q', '--no-verify', '-m', message]);
  return worktreeHead(path);
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
  const patch = (
    await git(root, ['diff', '--binary', '--no-renames', base, head], { maxCapture: MAX_OUTPUT_BYTES, complete: true })
  ).stdoutBytes;
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
