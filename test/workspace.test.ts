import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyToWorkingTree,
  commitWorktree,
  createWorktree,
  diffFiles,
  ensureRepo,
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
