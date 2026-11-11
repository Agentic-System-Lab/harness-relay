import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataLockFile, lockDataDir, openDatabase } from '../src/server/db';
import { fileInRoot, fileRoots, listFolder, mediaInRoot, previewFile, resolveInRoot, zipPlan } from '../src/server/files';
import { FILE_LIMITS, type Conversation } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-files-')));
const project = join(root, 'project');
const outside = join(root, 'outside');
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(project, 'src', 'deep'), { recursive: true });
mkdirSync(join(project, '.git'), { recursive: true });
mkdirSync(join(project, 'Docs'));
mkdirSync(outside);
writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
// `.git` in another letter case (on macOS and Windows, the same folder as `.git`).
mkdirSync(join(project, 'Docs', '.Git'));
writeFileSync(join(project, 'Docs', '.Git', 'config'), '[remote "origin"]\n\turl = https://token@example.com/r\n');
writeFileSync(join(project, 'src', 'app.ts'), 'export const a = 1;\n');
writeFileSync(join(project, 'file10.txt'), 'ten');
writeFileSync(join(project, 'file2.txt'), 'two');
writeFileSync(join(project, '.env'), 'X=1\n');
writeFileSync(join(project, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
writeFileSync(join(project, 'data.bin'), Buffer.from([1, 2, 0, 3]));
writeFileSync(join(outside, 'secret.txt'), 'secret');
symlinkSync(join(outside, 'secret.txt'), join(project, 'leak.txt'));
symlinkSync(outside, join(project, 'leak-dir'));
symlinkSync(join(project, 'src'), join(project, 'src-link'));

const notFound = /404|找不到|not found/i;

describe('resolveInRoot', () => {
  it('resolves paths inside the folder, whatever their slashes', () => {
    expect(resolveInRoot(project, '').rel).toBe('');
    expect(resolveInRoot(project, 'src/app.ts').rel).toBe('src/app.ts');
    expect(resolveInRoot(project, '/src\\app.ts').rel).toBe('src/app.ts');
    expect(resolveInRoot(project, 'src/../file2.txt').rel).toBe('file2.txt');
  });

  it('refuses anything outside the folder, .git, and missing paths', () => {
    for (const bad of ['..', '../outside/secret.txt', 'src/../../outside', 'leak.txt', 'leak-dir', '.git', '.git/HEAD', '.GIT/HEAD', '.Git', 'src/../.GiT/HEAD', 'Docs/.Git/config', 'Docs/.GIT/config', 'C:/x', 'missing', 'a\0b']) {
      expect(() => resolveInRoot(project, bad), bad).toThrow(notFound);
    }
    expect(() => resolveInRoot(join(root, 'gone'), '')).toThrow();
  });
});

describe('listFolder', () => {
  it('lists folders first, by name with numbers in order, without .git or links that lead outside', () => {
    const { path, entries, truncated } = listFolder(project, '');
    expect(path).toBe('');
    expect(truncated).toBe(false);
    expect(entries.map((e) => `${e.kind}:${e.name}${e.link ? '@' : ''}`)).toEqual([
      'dir:Docs',
      'dir:src',
      'dir:src-link@',
      'file:.env',
      'file:data.bin',
      'file:file2.txt',
      'file:file10.txt',
      'file:logo.png',
    ]);
    expect(entries.find((e) => e.name === 'file2.txt')!.size).toBe(3);
    // A folder reached through a link keeps the path it was asked for (the browser shows that one).
    expect(listFolder(project, 'src-link')).toMatchObject({ path: 'src-link', entries: [{ name: 'deep' }, { name: 'app.ts' }] });
    expect(listFolder(project, './src/').path).toBe('src');
    // `.git` is left out in any letter case.
    expect(listFolder(project, 'Docs').entries).toEqual([]);
  });

  it('refuses files and folders outside', () => {
    expect(() => listFolder(project, 'file2.txt')).toThrow(notFound);
    expect(() => listFolder(project, '..')).toThrow(notFound);
  });

  it('stops at the entry limit', () => {
    const big = join(root, 'big');
    mkdirSync(big);
    for (let i = FILE_LIMITS.maxEntries + 4; i >= 0; i--) writeFileSync(join(big, `f${i}`), '');
    mkdirSync(join(big, 'zz-folder'));
    const listing = listFolder(big, '');
    expect(listing.entries).toHaveLength(FILE_LIMITS.maxEntries);
    expect(listing.truncated).toBe(true);
    // The first ones in the order shown: folders, then names with numbers in order.
    expect(listing.entries.slice(0, 3).map((e) => e.name)).toEqual(['zz-folder', 'f0', 'f1']);
  });
});

describe('previewFile', () => {
  it('returns text, and only marks images, videos and binary files', () => {
    expect(previewFile(project, 'src/app.ts')).toMatchObject({ path: 'src/app.ts', kind: 'text', text: 'export const a = 1;\n', size: 20 });
    expect(previewFile(project, 'logo.png')).toMatchObject({ kind: 'image' });
    expect(previewFile(project, 'logo.png').text).toBeUndefined();
    expect(previewFile(project, 'data.bin')).toMatchObject({ kind: 'binary' });
    expect(() => previewFile(project, 'src')).toThrow(notFound);
    for (const git of ['.GIT/HEAD', '.Git/HEAD', 'Docs/.git/config']) expect(() => previewFile(project, git), git).toThrow(notFound);
  });

  it('cuts a long file at the limit without a broken character', () => {
    const text = '中'.repeat(FILE_LIMITS.maxPreviewBytes / 3 + 10);
    writeFileSync(join(project, 'long.txt'), text);
    const preview = previewFile(project, 'long.txt');
    expect(preview.truncated).toBe(true);
    expect(preview.text!.endsWith('中')).toBe(true);
    expect(preview.text!.includes('\uFFFD')).toBe(false);
    expect(Buffer.byteLength(preview.text!)).toBeLessThanOrEqual(FILE_LIMITS.maxPreviewBytes);
  });
});

describe('mediaInRoot', () => {
  it('serves images and videos only', () => {
    expect(mediaInRoot(project, 'logo.png')).toBe(join(project, 'logo.png'));
    expect(() => mediaInRoot(project, 'src/app.ts')).toThrow(notFound);
  });
});

describe('fileInRoot', () => {
  it('gives any file inside the folder for downloading, never a folder, .git or what a link leads out to', () => {
    expect(fileInRoot(project, 'data.bin')).toBe(join(project, 'data.bin'));
    expect(fileInRoot(project, 'src-link/app.ts')).toBe(join(project, 'src', 'app.ts'));
    for (const bad of ['', 'src', '.git/HEAD', 'Docs/.Git/config', 'leak.txt', 'leak-dir/secret.txt', '../outside/secret.txt', 'missing']) {
      expect(() => fileInRoot(project, bad), bad).toThrow(notFound);
    }
  });
});

describe('fileRoots', () => {
  it('offers the working directory, then worktrees that exist', () => {
    const conv = {
      settings: { cwd: project },
      agents: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      worktrees: {
        a: [{ root: project, path: join(project, 'src'), branch: 'relay/a', base: 'x', needsReset: false }],
        b: [{ root: project, path: join(root, 'gone'), branch: 'relay/b', base: 'x', needsReset: false }],
      },
    } as unknown as Conversation;
    expect(fileRoots(conv)).toEqual([
      { id: 'cwd', path: project },
      { id: 'a', path: join(project, 'src'), agentId: 'a' },
    ]);
  });

  it('offers each working directory, then each worktree of each, the innermost repository\'s for a folder inside another', () => {
    // Folders of their own, outside the project the other tests share.
    const outer = join(root, 'outer-project');
    const docs = join(outer, 'docs');
    const other = join(root, 'other-folder');
    for (const d of [docs, other, join(root, 'wt-a'), join(root, 'wt-a-docs')]) mkdirSync(d, { recursive: true });
    const conv = {
      settings: { cwd: outer, extraCwds: [docs, other] },
      agents: [{ id: 'a', name: 'A' }],
      worktrees: {
        a: [
          { root: outer, path: join(root, 'wt-a'), branch: 'relay/a', base: 'x', needsReset: false },
          { root: docs, path: join(root, 'wt-a-docs'), branch: 'relay/a', base: 'y', needsReset: false },
        ],
      },
    } as unknown as Conversation;
    expect(fileRoots(conv)).toEqual([
      { id: 'cwd', path: outer },
      { id: 'cwd:1', path: docs, cwd: 1 },
      { id: 'cwd:2', path: other, cwd: 2 },
      { id: 'a', path: join(root, 'wt-a'), agentId: 'a' },
      // other-folder is in no repository the agent has a worktree of.
      { id: 'a:1', path: join(root, 'wt-a-docs'), agentId: 'a', cwd: 1 },
    ]);
  });
});

describe('zipPlan', () => {
  // The preview tests above leave a long file behind.
  beforeAll(() => rmSync(join(project, 'long.txt'), { force: true }));
  const names = (plan: Awaited<ReturnType<typeof zipPlan>>) => plan!.entries.map((e) => e.name).sort();

  it('takes what the browser lists, in a folder of its name: no .git, no links outside, each folder once', async () => {
    const plan = await zipPlan(project, '');
    expect(plan!.name).toBe('project');
    expect(names(plan)).toEqual(
      [
        'project/',
        'project/.env',
        'project/Docs/', // only a .Git folder in it: an empty folder
        'project/data.bin',
        'project/file10.txt',
        'project/file2.txt',
        'project/logo.png',
        'project/src/',
        'project/src/app.ts',
        'project/src/deep/',
      ].sort(),
    );
    expect(plan!.files).toBe(6);
    expect(plan!.bytes).toBe(4 + 3 + 3 + 7 + 4 + 20);
    // Folders have no source; files are read from their real path.
    expect(plan!.entries.find((e) => e.name === 'project/src/app.ts')!.source).toBe(join(project, 'src', 'app.ts'));
    expect(plan!.entries.find((e) => e.name === 'project/src/')!.source).toBeUndefined();

    // A folder inside it, by its own name; through a link inside the root too.
    expect(names(await zipPlan(project, 'src'))).toEqual(['src/', 'src/app.ts', 'src/deep/']);
    expect(names(await zipPlan(project, 'src-link'))).toEqual(['src-link/', 'src-link/app.ts', 'src-link/deep/']);
  });

  // Where the filesystem ignores case (macOS, Windows), a folder asked for in another case.
  it.skipIf(!existsSync(project.toUpperCase()))('takes the same, by its own name, when the folder is asked for in another letter case', async () => {
    const plan = await zipPlan(project.toUpperCase(), '');
    expect(plan!.name).toBe('project');
    expect(names(plan)).toEqual(names(await zipPlan(project, '')));
    expect(plan!.files).toBe(6);
  });

  it('refuses a file, anything outside the folder and .git', async () => {
    for (const bad of ['file2.txt', 'leak-dir', '..', '.git', 'Docs/.Git', 'missing']) {
      await expect(zipPlan(project, bad), bad).rejects.toThrow(notFound);
    }
  });

  it('gives up once there are more files and folders, or bytes, than allowed', async () => {
    // The folder itself, 3 folders in it and 6 files.
    expect(await zipPlan(project, '', { limits: { items: 9, bytes: 1e9 } })).toBeNull();
    expect(await zipPlan(project, '', { limits: { items: 10, bytes: 1e9 } })).not.toBeNull();
    expect(await zipPlan(project, '', { limits: { items: 100, bytes: 40 } })).toBeNull();
    // Folders count too: a tree of empty folders cannot go on and on.
    const empty = join(root, 'empty-folders');
    for (let i = 0; i < 30; i++) mkdirSync(join(empty, `d${i}`), { recursive: true });
    expect(await zipPlan(empty, '', { limits: { items: 20, bytes: 1e9 } })).toBeNull();
    expect((await zipPlan(empty, '', { limits: { items: 31, bytes: 1e9 } }))!.files).toBe(0);
  });

  it('keeps permission bits, names a root as asked, and leaves out .git however it is spelled', async () => {
    const tools = join(root, 'tools');
    mkdirSync(join(tools, '.git.'), { recursive: true }); // Windows opens .git for it
    writeFileSync(join(tools, '.git.', 'config'), 'secret');
    writeFileSync(join(tools, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(tools, 'run.sh'), 0o755);
    writeFileSync(join(tools, 'notes.txt'), 'n');
    chmodSync(join(tools, 'notes.txt'), 0o640);
    const plan = (await zipPlan(tools, '', { name: 'project-Alice' }))!;
    expect(plan.name).toBe('project-Alice');
    expect(names(plan)).toEqual(['project-Alice/', 'project-Alice/notes.txt', 'project-Alice/run.sh']);
    const mode = (n: string) => plan.entries.find((e) => e.name.endsWith(n))!.mode! & 0o777;
    // Windows has no permission bits to keep (a file there is 0o666, or 0o444 read-only).
    if (process.platform !== 'win32') expect([mode('run.sh'), mode('notes.txt')]).toEqual([0o755, 0o640]);
    // A folder inside keeps its own name.
    expect((await zipPlan(project, 'src', { name: 'ignored' }))!.name).toBe('src');
    await expect(zipPlan(tools, '.git.')).rejects.toThrow(notFound);
    expect(listFolder(tools, '').entries.map((e) => e.name)).toEqual(['notes.txt', 'run.sh']);
  });

  it('leaves a link that loops back out', async () => {
    const loop = join(root, 'loop');
    mkdirSync(join(loop, 'a'), { recursive: true });
    writeFileSync(join(loop, 'a', 'x.txt'), 'x');
    symlinkSync(loop, join(loop, 'a', 'up'));
    expect(names(await zipPlan(loop, ''))).toEqual(['a/', 'a/x.txt', 'loop/'].map((n) => (n === 'loop/' ? n : `loop/${n}`)).sort());
  });

  it('takes only what git does not ignore, when asked, in a repository', async () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(repo, 'src'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n*.log\n');
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(repo, 'src', 'a.ts'), 'a');
    writeFileSync(join(repo, 'src', 'gone.ts'), 'g');
    writeFileSync(join(repo, 'debug.log'), 'noise');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    unlinkSync(join(repo, 'src', 'gone.ts')); // tracked, but deleted
    writeFileSync(join(repo, 'new.md'), 'untracked, not ignored');

    expect(names(await zipPlan(repo, '', { unignored: true }))).toEqual(['repo/', 'repo/.gitignore', 'repo/new.md', 'repo/src/a.ts']);
    expect(names(await zipPlan(repo, 'src', { unignored: true }))).toEqual(['src/', 'src/a.ts']);
    // Everything, when not asked.
    expect(names(await zipPlan(repo, ''))).toContain('repo/node_modules/pkg/index.js');
    // Inside an ignored folder, nothing is left.
    expect((await zipPlan(repo, 'node_modules', { unignored: true }))!.files).toBe(0);
    // Still limited.
    expect(await zipPlan(repo, '', { unignored: true, limits: { items: 2, bytes: 1e9 } })).toBeNull();
    // Not a repository: everything.
    expect(names(await zipPlan(project, 'src', { unignored: true }))).toEqual(['src/', 'src/app.ts', 'src/deep/']);
  });

  it("takes what nested repositories don't ignore, and no tracked link that leads outside or into .git", async () => {
    const repo = join(root, 'repo2');
    mkdirSync(join(repo, 'nested', 'build'), { recursive: true });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    git(repo, 'init', '-q');
    git(join(repo, 'nested'), 'init', '-q'); // a repository of its own, untracked in the outer one
    writeFileSync(join(repo, 'nested', '.gitignore'), 'build/\n');
    writeFileSync(join(repo, 'nested', 'n.txt'), 'n');
    writeFileSync(join(repo, 'nested', 'build', 'out.bin'), 'o');
    writeFileSync(join(repo, 'top.txt'), 't');
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'leak.txt'));
    symlinkSync(join(repo, '.git', 'config'), join(repo, 'config-link'));
    git(repo, 'add', 'top.txt', 'leak.txt', 'config-link');
    expect(names(await zipPlan(repo, '', { unignored: true }))).toEqual(['repo2/', 'repo2/nested/.gitignore', 'repo2/nested/n.txt', 'repo2/top.txt']);
  });
});

describe('the files the server holds SQLite locks on', () => {
  it('are not listed, read, downloaded or zipped, so that the server never drops its own locks', async () => {
    // A working directory with this server's data folder in it (npm start's default, from a checkout).
    const cwd = join(root, 'with-data');
    const data = join(cwd, 'data');
    mkdirSync(data, { recursive: true });
    const lock = lockDataDir(data)!;
    const db = openDatabase(join(data, 'relay.db'));
    writeFileSync(join(data, 'notes.txt'), 'x');
    symlinkSync(join(data, 'server.lock'), join(cwd, 'lock-link'));
    try {
      expect(listFolder(cwd, 'data').entries.map((e) => e.name)).toEqual(['notes.txt']);
      expect(listFolder(cwd, '').entries.map((e) => e.name)).toEqual(['data']);
      for (const path of ['data/server.lock', 'data/relay.db', 'data/relay.db-wal', 'data/relay.db-shm', 'lock-link']) {
        expect(() => previewFile(cwd, path), path).toThrow(notFound);
        expect(() => fileInRoot(cwd, path), path).toThrow(notFound);
      }
      expect((await zipPlan(cwd, ''))!.entries.map((e) => e.name).sort()).toEqual(['with-data/', 'with-data/data/', 'with-data/data/notes.txt']);
      // Still held after all that: another server is refused.
      const other = spawnSync(
        process.execPath,
        ['--no-warnings', '-e', "const db = new (require('node:sqlite').DatabaseSync)(process.argv[1]); db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');", dataLockFile(data)],
        { encoding: 'utf8' },
      );
      expect(other.stderr).toMatch(/locked|busy/i);
      expect(other.status).not.toBe(0);
    } finally {
      db.close();
      lock.close();
    }
  });
});
