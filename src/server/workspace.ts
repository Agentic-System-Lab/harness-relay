import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import type { FileChange } from '../shared/types';
import { HttpError } from './errors';
import { capture, tail } from './process';

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

export class GitError extends Error {}

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  allowFail?: boolean;
  maxCapture?: number;
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
  });
  if (r.code !== 0 && !o.allowFail) {
    throw new GitError(`git ${args[0]} 失敗：${tail(r.stderr || r.stdout, 500)}`);
  }
  return r;
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
  if (existing) return { root: existing, created: false };

  const real = realpathSync(dir);
  if (real === realpathSync(homedir()) || real === parse(real).root) {
    throw new HttpError(400, `不會在 ${real} 自動建立 git repository，請改選一個專案資料夾作為工作目錄。`);
  }
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

export async function treeOf(root: string, commit: string): Promise<string> {
  return out(await git(root, ['rev-parse', `${commit}^{tree}`]));
}

/** Files changed between two commits. */
export async function diffFiles(root: string, base: string, head: string): Promise<FileChange[]> {
  const [names, nums] = await Promise.all([
    git(root, ['diff', '--no-renames', '--name-status', base, head]),
    git(root, ['diff', '--no-renames', '--numstat', base, head]),
  ]);
  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  for (const line of nums.stdout.split('\n')) {
    const [a, d, ...rest] = line.split('\t');
    if (!rest.length) continue;
    counts.set(rest.join('\t'), { added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d) });
  }
  const files: FileChange[] = [];
  for (const line of names.stdout.split('\n')) {
    const [code, ...rest] = line.split('\t');
    if (!code || !rest.length) continue;
    const path = rest.join('\t');
    const status = code[0] === 'A' ? 'A' : code[0] === 'D' ? 'D' : 'M';
    files.push({ path, status, ...(counts.get(path) ?? { added: null, deleted: null }) });
  }
  return files;
}

/** Unified diff between two commits, truncated for display. */
export async function diffText(root: string, base: string, head: string): Promise<string> {
  const r = await git(root, ['diff', '--no-color', '--no-renames', base, head], { maxCapture: 32 * 1024 * 1024 });
  if (r.stdout.length <= MAX_DIFF_BYTES) return r.stdout;
  return `${r.stdout.slice(0, MAX_DIFF_BYTES)}\n\n… diff truncated (${Math.round(r.stdout.length / 1024)} KB total)\n`;
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
  if (!files.length) throw new HttpError(400, '沒有可套用的修改');
  const patch = (await git(root, ['diff', '--binary', '--no-renames', base, head], { maxCapture: 256 * 1024 * 1024 }))
    .stdout;
  const check = await git(root, ['apply', '--check', '--whitespace=nowarn', '-'], { stdin: patch, allowFail: true });
  if (check.code !== 0) {
    throw new HttpError(
      409,
      `工作目錄中的檔案跟這些修改有衝突，沒有套用任何變更：\n${tail(check.stderr, 800)}\n可以請 agent 改成以目前的工作目錄為基礎重做，或手動合併分支。`,
    );
  }
  await git(root, ['apply', '--whitespace=nowarn', '-'], { stdin: patch });
  return files;
}

/** Where the agent should run inside its worktree: the same sub-directory as the conversation's cwd. */
export function worktreeCwd(root: string, cwd: string, worktreePath: string): string {
  const rel = relative(root, realpathSync(cwd));
  const dir = rel && !rel.startsWith('..') ? join(worktreePath, rel) : worktreePath;
  mkdirSync(dir, { recursive: true });
  return dir;
}
