import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileInRoot, fileRoots, listFolder, mediaInRoot, previewFile, resolveInRoot } from '../src/server/files';
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
        a: { root: project, path: join(project, 'src'), branch: 'relay/a', base: 'x', needsReset: false },
        b: { root: project, path: join(root, 'gone'), branch: 'relay/b', base: 'x', needsReset: false },
      },
    } as unknown as Conversation;
    expect(fileRoots(conv)).toEqual([
      { id: 'cwd', path: project },
      { id: 'a', path: join(project, 'src'), agentId: 'a' },
    ]);
  });
});
