import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cutName, isWindowsDevice, pathClash } from '../src/shared/fileNames';
import { ATTACHMENT_LIMITS, FOLDER_MIME_TYPE } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-attachments-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const {
  attachmentPath,
  attachmentsDir,
  checkFolderNames,
  copyAttachments,
  decodeAttachments,
  folderFilePath,
  imageInputs,
  removeAttachments,
  writeAttachments,
} = await import('../src/server/attachments');
const { HttpError } = await import('../src/server/errors');

afterAll(() => rmSync(root, { recursive: true, force: true }));

const b64 = (s: string) => Buffer.from(s).toString('base64');
const folder = (files: { path: string; data: string }[], name = 'project') => [{ name, mimeType: FOLDER_MIME_TYPE, files }];

/** The HTTP status of what `fn` throws. */
function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
  return undefined;
}

describe('attached folders', () => {
  it('makes each path in a folder safe, keeping dot files and leaving no way out of it', () => {
    expect(folderFilePath('src/a.ts')).toBe('src/a.ts');
    expect(folderFilePath('/src//a.ts/')).toBe('src/a.ts');
    expect(folderFilePath('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
    expect(folderFilePath('../../etc/passwd')).toBe('_/_/etc/passwd');
    expect(folderFilePath('./a')).toBe('_/a');
    expect(folderFilePath('a\\..\\b')).toBe('a_.._b');
    expect(folderFilePath('C:/x')).toBe('C_/x');
    expect(folderFilePath('name. /trailing.')).toBe('name/trailing');
    expect(folderFilePath('bad\u0000name')).toBe('bad_name');
    expect(folderFilePath('')).toBeUndefined();
    expect(folderFilePath('///')).toBeUndefined();
  });

  it('cuts a name to 255 bytes, keeping its extension, and never takes a Windows device name', () => {
    const bytes = (n: string) => Buffer.byteLength(n);
    const long = '報'.repeat(100) + '.pdf';
    expect(bytes(cutName(long))).toBeLessThanOrEqual(255);
    expect(cutName(long)).toBe('報'.repeat(83) + '.pdf');
    expect(cutName('a'.repeat(300))).toBe('a'.repeat(255));
    expect(cutName('short.md')).toBe('short.md');
    expect(cutName('😀'.repeat(70))).toBe('😀'.repeat(63));
    expect(isWindowsDevice('CON')).toBe(true);
    expect(isWindowsDevice('nul.txt')).toBe(true);
    expect(isWindowsDevice('console.log')).toBe(false);
    expect(folderFilePath('src/con.ts')).toBe('src/_con.ts');
    expect(folderFilePath(`a/${'長'.repeat(100)}.txt`)).toBe(`a/${'長'.repeat(83)}.txt`);
    // Made safe twice, a path stays as it was.
    for (const p of ['src/con.ts', `x/${'長'.repeat(100)}.txt`, 'a. /b  ', '../..']) {
      const once = folderFilePath(p)!;
      expect(folderFilePath(once), p).toBe(once);
    }
    // An attached file's or folder's own name too, and it is written so.
    const [file, dir] = decodeAttachments([
      { name: `${'名'.repeat(100)}.pdf`, data: b64('x') },
      ...folder([{ path: 'a', data: '' }], 'aux'),
    ]);
    expect(file!.name).toBe(`${'名'.repeat(83)}.pdf`);
    expect(dir!.name).toBe('_aux');
    const [part] = writeAttachments('conv-names', [file!]);
    expect(readFileSync(attachmentPath('conv-names', part!), 'utf8')).toBe('x');
  });

  it('finds paths a file system that ignores letter case or Unicode form takes for one', () => {
    expect(pathClash(['a.md', 'b.md', 'sub/c.md'])).toBeUndefined();
    expect(pathClash(['Readme.md', 'README.md'])).toBe('README.md');
    expect(pathClash(['caf\u00e9', 'cafe\u0301'])).toBe('cafe\u0301');
    expect(pathClash(['x', 'x/y'])).toBe('x/y');
    expect(pathClash(['x/y', 'X'])).toBe('X');
  });

  it('takes a Windows device name only as it ends up on disk, and never a name over 255 bytes for one', () => {
    // `con .` is `con` once its trailing dot and space are gone.
    expect(folderFilePath('con .')).toBe('_con');
    expect(folderFilePath(folderFilePath('con .')!)).toBe('_con');
    expect(folderFilePath('a/NUL. ')).toBe('a/_NUL');
    // Prefixed, a name already 255 bytes long is cut again, its extension kept.
    const long = `nul.${'長'.repeat(100)}`;
    const [file] = decodeAttachments([{ name: long, data: b64('x') }]);
    expect(Buffer.byteLength(file!.name)).toBeLessThanOrEqual(255);
    expect(file!.name.startsWith('_nul')).toBe(true);
    const seg = folderFilePath(long)!;
    expect(Buffer.byteLength(seg)).toBeLessThanOrEqual(255);
    expect(folderFilePath(seg)).toBe(seg);
  });

  it('leaves out what is in a .git folder, however it is spelled, and refuses a folder that holds nothing else', () => {
    const [dir] = decodeAttachments(
      folder([
        { path: 'a.md', data: b64('a') },
        { path: '.git/config', data: b64('[core]') },
        { path: 'sub/.GIT/hooks/post-checkout', data: b64('#!/bin/sh') },
        { path: '.github/workflows/ci.yml', data: b64('on: push') },
        // Spaces around it, a dot after it: still `.git` on disk.
        { path: ' .git/config', data: b64('[core]') },
        { path: '\u00a0.git/config', data: b64('[core]') },
        { path: '.git\u00a0/config', data: b64('[core]') },
        { path: '\ufeff.GIT/hooks/x', data: b64('#!/bin/sh') },
        { path: 'sub/.git./x', data: b64('x') },
      ]),
    );
    expect(dir!.files!.map((f) => f.path)).toEqual(['a.md', '.github/workflows/ci.yml']);
    expect(statusOf(() => decodeAttachments(folder([{ path: '.git/HEAD', data: b64('ref') }])))).toBe(400);
  });

  it.skipIf(process.platform === 'win32')(
    "checks an automation's paths where a run writes them, so one too long for this disk is refused when it is saved",
    () => {
      // Twenty names of 250 bytes: longer than macOS's (1,024) or Linux's (4,096) longest path.
      const deep = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, '0')}${'d'.repeat(248)}`).join('/');
      expect(statusOf(() => checkFolderNames(decodeAttachments(folder([{ path: `${deep}/x.md`, data: b64('x') }]))))).toBe(400);
      expect(readdirSync(join(root, 'data', 'attachments')).filter((n) => n.startsWith('check-'))).toEqual([]);
    },
  );

  it("checks an automation's folder names on this disk before it is saved, leaving nothing behind", () => {
    checkFolderNames(decodeAttachments(folder([{ path: 'a/b.md', data: b64('x') }])));
    const dup = [
      {
        name: 'dup',
        mimeType: FOLDER_MIME_TYPE,
        bytes: new Uint8Array(0),
        files: [
          { path: 'a', bytes: Buffer.from('1') },
          { path: 'a', bytes: Buffer.from('2') },
        ],
      },
    ];
    expect(statusOf(() => checkFolderNames(dup))).toBe(400);
    expect(readdirSync(join(root, 'data', 'attachments')).filter((n) => n.startsWith('check-'))).toEqual([]);
  });

  it('decodes a folder of files beside a file, and never takes a file for a folder', () => {
    const [file, dir] = decodeAttachments([
      { name: 'a.txt', mimeType: FOLDER_MIME_TYPE, data: b64('x') },
      ...folder([
        { path: 'README.md', data: b64('# hi') },
        { path: 'src/main.ts', data: b64('code') },
      ]),
    ]);
    expect(file).toMatchObject({ name: 'a.txt', mimeType: 'application/octet-stream' });
    expect(file!.files).toBeUndefined();
    expect(dir).toMatchObject({ name: 'project', mimeType: FOLDER_MIME_TYPE });
    expect(dir!.files!.map((f) => [f.path, Buffer.from(f.bytes).toString()])).toEqual([
      ['README.md', '# hi'],
      ['src/main.ts', 'code'],
    ]);
  });

  it('refuses a malformed folder, an empty one, one with too many files and two files of one name', () => {
    expect(statusOf(() => decodeAttachments(folder([])))).toBe(400);
    expect(statusOf(() => decodeAttachments([{ name: 'x', files: 'nope' }]))).toBe(400);
    expect(statusOf(() => decodeAttachments(folder([{ path: 'a', data: 1 as unknown as string }])))).toBe(400);
    expect(statusOf(() => decodeAttachments(folder([{ path: '//', data: b64('a') }])))).toBe(400);
    const many = Array.from({ length: ATTACHMENT_LIMITS.maxFolderFiles + 1 }, (_, i) => ({ path: `f${i}`, data: '' }));
    expect(statusOf(() => decodeAttachments(folder(many)))).toBe(400);
    expect(statusOf(() => decodeAttachments(folder(many.slice(1))))).toBeUndefined();
    // Names the disk takes for one: letter case, Unicode form, a name made safe into another's.
    for (const [a, b] of [
      ['Readme.md', 'README.md'],
      ['caf\u00e9.txt', 'cafe\u0301.txt'],
      ['a?b', 'a_b'],
      ['x', 'x/y'],
      ['x/y', 'x'],
      ['d/e/f', 'D/E'],
    ]) {
      const err = (() => {
        try {
          decodeAttachments(
            folder([
              { path: a!, data: '' },
              { path: b!, data: '' },
            ]),
          );
        } catch (e) {
          return e as InstanceType<typeof HttpError>;
        }
      })();
      expect(err?.status, `${a} and ${b}`).toBe(400);
    }
  });

  it('counts a folder in the files a message may attach, each of its files in the size limits', () => {
    const files = Array.from({ length: ATTACHMENT_LIMITS.maxFiles }, (_, i) => ({ name: `f${i}`, data: '' }));
    expect(statusOf(() => decodeAttachments([...files.slice(1), ...folder([{ path: 'a', data: '' }])]))).toBeUndefined();
    expect(statusOf(() => decodeAttachments([...files, ...folder([{ path: 'a', data: '' }])]))).toBe(400);
    const big = Buffer.alloc(ATTACHMENT_LIMITS.maxBytes + 1).toString('base64');
    expect(statusOf(() => decodeAttachments(folder([{ path: 'big.bin', data: big }])))).toBe(400);
    // 11 files of 19 MB in two folders: more than 200 MB together.
    const part = Buffer.alloc(19 * 1024 * 1024).toString('base64');
    const half = Array.from({ length: 6 }, (_, i) => ({ path: `p${i}`, data: part }));
    expect(statusOf(() => decodeAttachments([...folder(half, 'one'), ...folder(half.slice(1), 'two')]))).toBe(400);
    expect(statusOf(() => decodeAttachments([...folder(half, 'one'), ...folder(half.slice(2), 'two')]))).toBeUndefined();
  });

  it('writes a folder as it was, its folders 0700 and its files 0600, and lists it as one attachment', () => {
    const conv = 'conv-write';
    const [part] = writeAttachments(
      conv,
      decodeAttachments(
        folder([
          { path: 'README.md', data: b64('# hi') },
          { path: 'src/deep/main.ts', data: b64('code') },
          { path: '.env.example', data: b64('A=1') },
        ]),
      ),
    );
    expect(part).toMatchObject({ type: 'attachment', name: 'project', mimeType: FOLDER_MIME_TYPE, size: 11, files: 3 });
    const dir = attachmentPath(conv, part!);
    expect(dir).toBe(join(attachmentsDir(conv), part!.id, 'project'));
    expect(readFileSync(join(dir, 'src', 'deep', 'main.ts'), 'utf8')).toBe('code');
    expect(readdirSync(dir).sort()).toEqual(['.env.example', 'README.md', 'src']);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'src', 'deep')).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'README.md')).mode & 0o777).toBe(0o600);
    }
    // Never shown to an agent as an image.
    expect(imageInputs(conv, [part!])).toEqual([]);
  });

  it('removes what it wrote when a later file cannot be written', () => {
    const conv = 'conv-fail';
    // As an automation's stored files would come, past the checks above: two of one name.
    const data = [
      { name: 'ok.txt', mimeType: 'text/plain', bytes: Buffer.from('ok') },
      {
        name: 'dup',
        mimeType: FOLDER_MIME_TYPE,
        bytes: new Uint8Array(0),
        files: [
          { path: 'a', bytes: Buffer.from('1') },
          { path: 'a', bytes: Buffer.from('2') },
        ],
      },
    ];
    expect(statusOf(() => writeAttachments(conv, data))).toBe(400);
    expect(existsSync(attachmentsDir(conv)) ? readdirSync(attachmentsDir(conv)) : []).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('copies a link an agent left in a folder as a link, never what it leads to', async () => {
    const [part] = writeAttachments('conv-link', decodeAttachments(folder([{ path: 'a.txt', data: b64('a') }])));
    const outside = join(root, 'outside-secret.txt');
    rmSync(outside, { force: true });
    symlinkSync(join(root, 'outside-target'), join(attachmentPath('conv-link', part!), 'link'));
    await copyAttachments('conv-link', 'conv-link-branch', [part!]);
    const copied = join(attachmentPath('conv-link-branch', part!), 'link');
    expect(lstatSync(copied).isSymbolicLink()).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });

  it('copies a folder to a branch, and skips one that is gone', async () => {
    const [part] = writeAttachments('conv-from', decodeAttachments(folder([{ path: 'sub/a.txt', data: b64('a') }])));
    await copyAttachments('conv-from', 'conv-to', [part!]);
    expect(readFileSync(join(attachmentPath('conv-to', part!), 'sub', 'a.txt'), 'utf8')).toBe('a');
    if (process.platform !== 'win32') expect(statSync(join(attachmentPath('conv-to', part!), 'sub', 'a.txt')).mode & 0o777).toBe(0o600);
    removeAttachments('conv-from', [part!]);
    expect(existsSync(join(attachmentsDir('conv-from'), part!.id))).toBe(false);
    await copyAttachments('conv-from', 'conv-gone', [part!]);
    expect(existsSync(attachmentPath('conv-gone', part!))).toBe(false);
  });
});
