import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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

const CONFIG = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=false'];
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
  const r = await capture('git', [...CONFIG, ...args], env, {
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

/**
 * Commit the current state of the working tree (tracked + untracked, honouring ignores) without
 * changing HEAD, the index or any file: stage into a temporary copy of the index instead.
 */
export async function snapshot(root: string): Promise<{ commit: string; tree: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'relay-index-'));
  const index = join(dir, 'index');
  try {
    const indexPath = out(await git(root, ['rev-parse', '--git-path', 'index']));
    const realIndex = isAbsolute(indexPath) ? indexPath : resolve(root, indexPath);
    // Starting from the real index lets git reuse its stat cache instead of re-hashing every file.
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { GIT_INDEX_FILE: index };
    await git(root, ['add', '-A'], { env });
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

/** Unified diff between two commits, truncated for display. */
export async function diffText(root: string, base: string, head: string): Promise<string> {
  const r = await git(root, ['diff', '--no-color', '--no-renames', base, head], { maxCapture: MAX_DIFF_BYTES, keepStart: true });
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

/**
 * Apply the changes base..head onto the repository's working tree (not the index; nothing is
 * committed). Checks first, so a conflicting patch changes nothing.
 */
export async function applyToWorkingTree(root: string, base: string, head: string): Promise<FileChange[]> {
  const files = await diffFiles(root, base, head);
  if (!files.length) throw new HttpError(400, t().nothingToApply);
  // The patch as bytes: CRLF line endings and non-UTF-8 content must reach `git apply` unchanged.
  const patch = (
    await git(root, ['diff', '--binary', '--no-renames', base, head], { maxCapture: MAX_OUTPUT_BYTES, complete: true })
  ).stdoutBytes;
  const check = await git(root, ['apply', '--check', '--whitespace=nowarn', '-'], { stdin: patch, allowFail: true });
  if (check.code !== 0) {
    throw new HttpError(
      409,
      t().applyConflict(tail(check.stderr, 800)),
    );
  }
  await git(root, ['apply', '--whitespace=nowarn', '-'], { stdin: patch });
  return files;
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
