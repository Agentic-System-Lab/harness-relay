import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyToWorkingTree,
  commitWorktree,
  createWorktree,
  diffFiles,
  diffText,
  dropKeptCommits,
  ensureRepo,
  excludePathspecs,
  keepCommits,
  removeWorktree,
  snapshot,
  worktreeCwd,
} from '../src/server/workspace';

let dir: string;
let repo: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-ws-')));
  repo = join(dir, 'project');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 1;\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ensureRepo', () => {
  it('runs git init in a plain directory, once', async () => {
    expect(await ensureRepo(repo)).toEqual({ root: repo, created: true });
    expect(existsSync(join(repo, '.git'))).toBe(true);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('node_modules/');
    expect(await ensureRepo(join(repo, 'src'))).toEqual({ root: repo, created: false });
  });

  it('refuses to turn the home directory into a repository', async () => {
    await expect(ensureRepo(homedir())).rejects.toThrow(/git repository/);
  });

  it('refuses a repository rooted at the home directory (dotfiles), which every turn would snapshot', async () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, 'code'), { recursive: true });
    git(home, 'init', '-q');
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(ensureRepo(join(home, 'code'))).rejects.toThrow(/範圍太大/);
    } finally {
      process.env.HOME = saved;
    }
  });
});

describe('snapshot', () => {
  it('captures tracked and untracked files without touching HEAD, index or files', async () => {
    await ensureRepo(repo);
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'ignored');
    const statusBefore = git(repo, 'status', '--porcelain');

    const snap = await snapshot(repo);
    const files = git(repo, 'ls-tree', '-r', '--name-only', snap.commit).split('\n');
    expect(files.sort()).toEqual(['README.md', 'src/app.ts']);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(() => git(repo, 'rev-parse', '--verify', '-q', 'HEAD')).toThrow(); // still no commits

    // Same content → same tree; a change → a different tree.
    expect((await snapshot(repo)).tree).toBe(snap.tree);
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    expect((await snapshot(repo)).tree).not.toBe(snap.tree);
  });

  it("leaves out the CLIs' own homes when they lie in the repository, also through a link", async () => {
    await ensureRepo(repo);
    // The CLIs' folder inside the repository (beside the working directory `src`), with a sign-in in it.
    mkdirSync(join(repo, 'agents', 'codex'), { recursive: true });
    writeFileSync(join(repo, 'agents', 'codex', 'auth.json'), '{"token":"secret"}');
    mkdirSync(join(repo, 'agents-notes'));
    writeFileSync(join(repo, 'agents-notes', 'keep.md'), 'not the folder\n');
    const files = async (exclude: string[]) =>
      git(repo, 'ls-tree', '-r', '--name-only', (await snapshot(repo, exclude)).commit).split('\n').sort();

    expect(await files([])).toContain('agents/codex/auth.json');
    expect(await files([join(repo, 'agents')])).toEqual(['README.md', 'agents-notes/keep.md', 'src/app.ts']);
    // Named through a link, it is still found inside the repository.
    symlinkSync(join(repo, 'agents'), join(dir, 'agents-link'));
    expect(await files([join(dir, 'agents-link')])).toEqual(['README.md', 'agents-notes/keep.md', 'src/app.ts']);
    // Outside the repository it needs nothing.
    expect(excludePathspecs(repo, [join(dir, 'elsewhere'), dir, ''])).toEqual([]);
    expect(excludePathspecs(repo, [join(repo, 'agents', 'codex')])).toEqual([':(exclude,literal)agents/codex']);
  });
});

describe('worktrees', () => {
  it('isolates an agent, records its changes, and applies them back', async () => {
    await ensureRepo(repo);
    const base = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt', 'builder');
    await createWorktree(repo, wt, 'relay/test/Builder', base);
    expect(worktreeCwd(repo, join(repo, 'src'), wt)).toBe(join(wt, 'src'));

    writeFileSync(join(wt, 'src', 'app.ts'), 'export const x = 2;\n');
    writeFileSync(join(wt, 'NEW.md'), 'new\n');
    const head = await commitWorktree(wt, 'turn');
    expect(head).toBeTruthy();
    expect(await commitWorktree(wt, 'nothing')).toBeNull();

    expect(await diffFiles(repo, base, head!)).toEqual([
      { path: 'NEW.md', status: 'A', added: 1, deleted: 0 },
      { path: 'src/app.ts', status: 'M', added: 1, deleted: 1 },
    ]);
    // The real working directory is untouched until applied.
    expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1;\n');

    await applyToWorkingTree(repo, base, head!);
    expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const x = 2;\n');
    expect(readFileSync(join(repo, 'NEW.md'), 'utf8')).toBe('new\n');

    await removeWorktree(repo, wt, 'relay/test/Builder');
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', 'relay/*')).toBe('');
  });

  it('refuses to apply over conflicting edits and changes nothing', async () => {
    await ensureRepo(repo);
    const base = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt', 'a');
    await createWorktree(repo, wt, 'relay/test/A', base);
    writeFileSync(join(wt, 'README.md'), 'from agent\n');
    writeFileSync(join(wt, 'OTHER.md'), 'other\n');
    const head = (await commitWorktree(wt, 'turn'))!;

    writeFileSync(join(repo, 'README.md'), 'edited by the user\n');
    await expect(applyToWorkingTree(repo, base, head)).rejects.toThrow(/衝突/);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('edited by the user\n');
    expect(existsSync(join(repo, 'OTHER.md'))).toBe(false);
  });
});

describe('changes that are not plain UTF-8 text with LF line endings', () => {
  /** Run one agent turn in a worktree that writes `files`, then apply the result to the repository. */
  async function applyTurn(files: Record<string, Buffer>) {
    const base = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt', 'agent');
    await createWorktree(repo, wt, 'relay/test/agent', base);
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(wt, name), bytes);
    const head = (await commitWorktree(wt, 'turn'))!;
    await applyToWorkingTree(repo, base, head);
    return { base, head };
  }

  it('applies non-UTF-8, CRLF and lone-CR content byte for byte', async () => {
    await ensureRepo(repo);
    const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 0x0a]); // 「中文」 in Big5
    const crlf = Buffer.from('a\r\nb\r\n');
    const cr = Buffer.from('a\rb\n');
    await applyTurn({ 'big5.txt': big5, 'crlf.txt': crlf, 'cr.txt': cr });
    expect(readFileSync(join(repo, 'big5.txt'))).toEqual(big5);
    expect(readFileSync(join(repo, 'crlf.txt'))).toEqual(crlf);
    expect(readFileSync(join(repo, 'cr.txt'))).toEqual(cr);
  });

  it('applies a change to an existing CRLF file instead of reporting a conflict', async () => {
    writeFileSync(join(repo, 'win.txt'), 'one\r\ntwo\r\n');
    await ensureRepo(repo);
    await applyTurn({ 'win.txt': Buffer.from('one\r\nTWO\r\n') });
    expect(readFileSync(join(repo, 'win.txt'), 'utf8')).toBe('one\r\nTWO\r\n');
  });

  it('shows CRLF content unchanged in the diff viewer', async () => {
    await ensureRepo(repo);
    const { base, head } = await applyTurn({ 'crlf.txt': Buffer.from('a\r\nb\r\n') });
    expect(await diffText(repo, base, head)).toContain('+a\r\n+b\r\n');
  });
});

describe('diffFiles', () => {
  it('lists every changed file, however long the list', async () => {
    await ensureRepo(repo);
    const base = (await snapshot(repo)).commit;
    // Well over 64 KB of `git diff --name-status` output.
    const dirName = 'a-rather-long-directory-name-for-generated-files';
    mkdirSync(join(repo, dirName));
    for (let i = 0; i < 3000; i++) writeFileSync(join(repo, dirName, `generated-file-number-${i}.txt`), `${i}\n`);
    const head = (await snapshot(repo)).commit;
    const files = await diffFiles(repo, base, head);
    expect(files).toHaveLength(3000);
    expect(files.every((f) => f.status === 'A' && f.added === 1 && f.deleted === 0)).toBe(true);
  }, 30_000);

  it('keeps file names with quotes, tabs, backslashes and non-ASCII characters as they are', async () => {
    await ensureRepo(repo);
    const base = (await snapshot(repo)).commit;
    const names = ['say "hi".txt', 'tab\there.txt', 'back\\slash.txt', '中文 檔名.md'];
    for (const name of names) writeFileSync(join(repo, name), 'x\n');
    const head = (await snapshot(repo)).commit;
    const files = await diffFiles(repo, base, head);
    expect(files.map((f) => f.path).sort()).toEqual([...names].sort());
    expect(files.every((f) => f.added === 1)).toBe(true);
  });
});

describe('keepCommits', () => {
  it('keeps snapshot commits through git gc until the conversation drops them', async () => {
    await ensureRepo(repo);
    const snap = (await snapshot(repo)).commit;
    await keepCommits(repo, 'conv-1', [snap]);
    git(repo, 'gc', '-q', '--prune=now');
    expect(git(repo, 'cat-file', '-t', snap)).toBe('commit');

    await dropKeptCommits(repo, 'conv-1');
    expect(git(repo, 'for-each-ref', 'refs/harness-relay/')).toBe('');
    git(repo, 'reflog', 'expire', '--expire=now', '--all');
    git(repo, 'gc', '-q', '--prune=now');
    expect(() => git(repo, 'cat-file', '-t', snap)).toThrow();
  });
});
