/*
 * Changing files from the Files panel (src/server/fileEdit.ts): saving a text file over the version it
 * was loaded at, a new file, an upload; what each refuses (links, `.git`, what the server withholds or
 * protects, a changed file, names no system takes, too much); and the preview's version
 * (src/server/files.ts). Real temporary folders.
 */
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileNameProblem, hasLoneSurrogate } from '../src/shared/fileNames';
import { FILE_CHANGED, FILE_EDIT_LIMITS, FILE_EXISTS, FILE_LIMITS } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-file-edit-')));
// Harness Relay's data folder inside one of the folders below, to see that no write reaches it.
const holder = join(root, 'holder');
process.env.RELAY_DATA_DIR = join(holder, 'data');

const { keepTextFormat, rootReadOnly, saveText, uploadFile } = await import('../src/server/fileEdit');
const { fileVersion, previewFile } = await import('../src/server/files');
const { withholdFile } = await import('../src/server/db');
const { HttpError } = await import('../src/server/errors');

afterAll(() => rmSync(root, { recursive: true, force: true }));

let project: string;
let n = 0;
beforeEach(() => {
  project = join(root, `project-${++n}`);
  mkdirSync(join(project, 'notes'), { recursive: true });
  writeFileSync(join(project, 'queue.csv'), 'date,text\n2026-11-23,Hello\n');
});

/** The HTTP status and code `fn` is refused with. */
function refusal(fn: () => unknown): { status: number; code?: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, ...(err.code ? { code: err.code } : {}) };
    throw err;
  }
  throw new Error('not refused');
}

const versionOf = (path: string) => fileVersion(readFileSync(path));
const base64 = (text: string) => Buffer.from(text).toString('base64');
/** What a folder holds besides what a test made: a temporary file left behind would show here. */
const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('.relay-'));

describe('saving a text file', () => {
  it('saves over the version it was loaded at, and gives the new one', () => {
    const file = join(project, 'queue.csv');
    const loaded = previewFile(project, 'queue.csv');
    expect(loaded.version).toBe(versionOf(file));
    const text = 'date,text\n2026-11-23,Hello\n2026-11-24,Again\n';
    const saved = saveText(project, 'queue.csv', text, loaded.version!);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(saved).toMatchObject({ path: 'queue.csv', size: Buffer.byteLength(text), version: versionOf(file) });
    expect(previewFile(project, 'queue.csv').version).toBe(saved.version);
    expect(leftovers(project)).toEqual([]);
  });

  it('refuses a save once the file changed, or is gone, since it was loaded', () => {
    const loaded = previewFile(project, 'queue.csv');
    writeFileSync(join(project, 'queue.csv'), 'date,text\n2026-11-23,Changed by an agent\n');
    expect(refusal(() => saveText(project, 'queue.csv', 'mine', loaded.version!))).toEqual({ status: 409, code: FILE_CHANGED });
    expect(readFileSync(join(project, 'queue.csv'), 'utf8')).toContain('Changed by an agent');
    rmSync(join(project, 'queue.csv'));
    expect(refusal(() => saveText(project, 'queue.csv', 'mine', loaded.version!))).toEqual({ status: 409, code: FILE_CHANGED });
    expect(existsSync(join(project, 'queue.csv'))).toBe(false);
  });

  it('makes a new file, and refuses one where a file is', () => {
    const saved = saveText(project, 'notes/today.md', '# Today\n', null);
    expect(saved.path).toBe('notes/today.md');
    expect(readFileSync(join(project, 'notes', 'today.md'), 'utf8')).toBe('# Today\n');
    expect(refusal(() => saveText(project, 'notes/today.md', 'again', null))).toEqual({ status: 409, code: FILE_EXISTS });
    // Its folder must be there.
    expect(refusal(() => saveText(project, 'missing/today.md', '', null)).status).toBe(404);
  });

  it.skipIf(process.platform === 'win32')("keeps the file's permission bits, and a new file gets the system's", () => {
    const script = join(project, 'post.sh');
    writeFileSync(script, '#!/bin/sh\necho hi\n');
    chmodSync(script, 0o750);
    saveText(project, 'post.sh', '#!/bin/sh\necho bye\n', versionOf(script));
    expect(statSync(script).mode & 0o777).toBe(0o750);
    saveText(project, 'new.txt', 'x', null);
    expect(statSync(join(project, 'new.txt')).mode & 0o111).toBe(0);
  });

  it("keeps the file's CRLF line breaks and byte order mark, which a text box drops", () => {
    const file = join(project, 'windows.csv');
    writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\r\n1,2\r\n')]));
    const loaded = previewFile(project, 'windows.csv');
    expect(loaded.text).toBe('a,b\r\n1,2\r\n');
    saveText(project, 'windows.csv', 'a,b\n1,2\n3,4\n', loaded.version!);
    expect(readFileSync(file)).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\r\n1,2\r\n3,4\r\n')]));
  });

  it('replaces the name it saves, never what a hard link elsewhere holds', () => {
    const outside = join(root, `outside-${n}.txt`);
    writeFileSync(outside, 'keep\n');
    linkSync(outside, join(project, 'linked.txt'));
    saveText(project, 'linked.txt', 'mine\n', versionOf(outside));
    expect(readFileSync(join(project, 'linked.txt'), 'utf8')).toBe('mine\n');
    expect(readFileSync(outside, 'utf8')).toBe('keep\n');
  });

  it('saves text only, no larger than an editable file', () => {
    const v = versionOf(join(project, 'queue.csv'));
    expect(refusal(() => saveText(project, 'queue.csv', 'a\0b', v)).status).toBe(400);
    expect(refusal(() => saveText(project, 'queue.csv', 'broken \ud800', v)).status).toBe(400);
    expect(refusal(() => saveText(project, 'queue.csv', 42, v)).status).toBe(400);
    expect(refusal(() => saveText(project, 'queue.csv', 'x', 7)).status).toBe(400);
    expect(refusal(() => saveText(project, 'queue.csv', 'x'.repeat(FILE_EDIT_LIMITS.maxEditBytes + 1), v)).status).toBe(413);
    expect(readFileSync(join(project, 'queue.csv'), 'utf8')).toBe('date,text\n2026-11-23,Hello\n');
  });

  it('writes nothing in .git, outside the folder, in a folder or a file reached through a link', () => {
    mkdirSync(join(project, '.git'));
    writeFileSync(join(project, '.git', 'config'), '[core]\n');
    const outside = join(root, `outside-${n}`);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(outside, join(project, 'out'), 'dir');
    symlinkSync(join(outside, 'secret.txt'), join(project, 'secret.txt'));
    const v = versionOf(join(outside, 'secret.txt'));
    for (const path of ['.git/config', '.GIT/config', '../outside/secret.txt', '..', '', 'notes/../../x', 'C:/x']) {
      expect(refusal(() => saveText(project, path, 'x', null)).status, path).toBe(404);
      expect(refusal(() => saveText(project, path, 'x', 'v1')).status, path).toBe(404);
    }
    // `.git` is no name for a new file, nor a file to save over.
    expect(refusal(() => saveText(project, '.git', 'x', null)).status).toBe(400);
    expect(refusal(() => saveText(project, '.git', 'x', 'v1')).status).toBe(404);
    expect(refusal(() => saveText(project, 'out/secret.txt', 'x', v)).status).toBe(403);
    expect(refusal(() => saveText(project, 'out/new.txt', 'x', null)).status).toBe(403);
    expect(refusal(() => saveText(project, 'secret.txt', 'x', v)).status).toBe(403);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret\n');
    expect(readdirSync(outside)).toEqual(['secret.txt']);
    expect(readFileSync(join(project, '.git', 'config'), 'utf8')).toBe('[core]\n');
    // Links inside the folder are browsed, but have no version in their preview: the panel offers no
    // editing there, and a save through one is refused.
    writeFileSync(join(project, 'notes', 'a.md'), '# A\n');
    symlinkSync(join(project, 'notes'), join(project, 'inner'), 'dir');
    symlinkSync(join(project, 'queue.csv'), join(project, 'alias.csv'));
    expect(previewFile(project, 'notes/a.md').version).toBeDefined();
    expect(previewFile(project, 'inner/a.md')).toMatchObject({ kind: 'text', text: '# A\n' });
    expect(previewFile(project, 'inner/a.md').version).toBeUndefined();
    expect(previewFile(project, 'alias.csv').version).toBeUndefined();
    expect(refusal(() => saveText(project, 'inner/a.md', 'x', versionOf(join(project, 'notes', 'a.md')))).status).toBe(403);
    expect(refusal(() => saveText(project, 'alias.csv', 'x', versionOf(join(project, 'queue.csv')))).status).toBe(403);
    expect(readFileSync(join(project, 'notes', 'a.md'), 'utf8')).toBe('# A\n');
  });

  it('refuses a folder, a read-only file and a file the server withholds', () => {
    expect(refusal(() => saveText(project, 'notes', 'x', null)).status).toBe(409);
    const locked = join(project, 'secrets.key');
    writeFileSync(locked, 'key');
    withholdFile(locked);
    expect(refusal(() => saveText(project, 'secrets.key', 'x', versionOf(locked))).status).toBe(404);
    expect(refusal(() => uploadFile(project, '', 'secrets.key', base64('x'), true)).status).toBe(404);
    expect(readFileSync(locked, 'utf8')).toBe('key');
    const frozen = join(project, 'frozen.txt');
    writeFileSync(frozen, 'frozen');
    chmodSync(frozen, 0o444);
    expect(refusal(() => saveText(project, 'frozen.txt', 'x', versionOf(frozen))).status).toBe(403);
    chmodSync(frozen, 0o644);
  });

  it('refuses what Harness Relay protects: its data folder, wherever the working directory is', () => {
    mkdirSync(join(holder, 'data', 'tmp'), { recursive: true });
    expect(refusal(() => saveText(holder, 'data/tmp/settings.json', '{}', null)).status).toBe(403);
    expect(refusal(() => uploadFile(holder, 'data', 'relay.db', base64('x'), true)).status).toBe(403);
    expect(readdirSync(join(holder, 'data'))).toEqual(['tmp']);
  });
});

describe('uploading a file', () => {
  it('writes the file into the folder, and replaces one only when asked', () => {
    const written = uploadFile(project, 'notes', 'photo.jpg', Buffer.from([0xff, 0xd8, 0, 1]).toString('base64'), false);
    expect(written).toMatchObject({ path: 'notes/photo.jpg', size: 4 });
    expect(readFileSync(join(project, 'notes', 'photo.jpg'))).toEqual(Buffer.from([0xff, 0xd8, 0, 1]));
    expect(refusal(() => uploadFile(project, 'notes', 'photo.jpg', base64('new'), false))).toEqual({ status: 409, code: FILE_EXISTS });
    expect(readFileSync(join(project, 'notes', 'photo.jpg'))).toEqual(Buffer.from([0xff, 0xd8, 0, 1]));
    uploadFile(project, 'notes', 'photo.jpg', base64('new'), true);
    expect(readFileSync(join(project, 'notes', 'photo.jpg'), 'utf8')).toBe('new');
    expect(leftovers(join(project, 'notes'))).toEqual([]);
  });

  it('refuses names no system takes, and writes nothing', () => {
    for (const name of [
      '',
      ' ',
      'a/b',
      'a\\b',
      '.',
      '..',
      '.git',
      '.GIT.',
      'CON',
      'nul.txt',
      'COM1',
      'what?',
      'a:b',
      'x.',
      'x ',
      'tab\there',
      'é'.repeat(128),
    ]) {
      expect(refusal(() => uploadFile(project, '', name, base64('x'), true)).status, name).toBe(400);
    }
    expect(readdirSync(project).sort()).toEqual(['notes', 'queue.csv']);
  });

  it('refuses a file over the limit before decoding it, and a folder it cannot write in', () => {
    const max = FILE_EDIT_LIMITS.maxUploadBytes;
    FILE_EDIT_LIMITS.maxUploadBytes = 8;
    try {
      expect(refusal(() => uploadFile(project, '', 'big.bin', base64('123456789'), false)).status).toBe(413);
      expect(uploadFile(project, '', 'small.bin', base64('12345678'), false).size).toBe(8);
    } finally {
      FILE_EDIT_LIMITS.maxUploadBytes = max;
    }
    mkdirSync(join(project, '.git'));
    const outside = join(root, `outside-up-${n}`);
    mkdirSync(outside);
    symlinkSync(outside, join(project, 'out'), 'dir');
    expect(refusal(() => uploadFile(project, '.git', 'config', base64('x'), true)).status).toBe(404);
    expect(refusal(() => uploadFile(project, 'out', 'x.txt', base64('x'), true)).status).toBe(403);
    expect(refusal(() => uploadFile(project, 'missing', 'x.txt', base64('x'), true)).status).toBe(404);
    expect(refusal(() => uploadFile(project, '../..', 'x.txt', base64('x'), true)).status).toBe(404);
    expect(refusal(() => uploadFile(project, '', 'notes', base64('x'), true)).status).toBe(409);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('the roots the Files panel writes in', () => {
  it("is never an agent's worktree, nor a folder where edit mode is refused", () => {
    expect(rootReadOnly({ id: 'cwd', path: project }, { home: join(root, 'home') })).toBeUndefined();
    expect(rootReadOnly({ id: 'a1', path: project, agentId: 'a1' }, {})).toMatch(/worktree/);
    expect(rootReadOnly({ id: 'cwd', path: holder }, {})).toMatch(/Harness Relay/);
    // The home folder, or one that holds a CLI's own folder.
    expect(rootReadOnly({ id: 'cwd', path: project }, { home: project })).toContain(project);
  });
});

describe('keepTextFormat', () => {
  it("puts CRLF back when most of the file's line breaks are, and keeps a byte order mark", () => {
    expect(keepTextFormat(Buffer.from('a\r\nb\r\n'), 'a\nb\nc').toString()).toBe('a\r\nb\r\nc');
    expect(keepTextFormat(Buffer.from('a\nb\r\nc\n'), 'x\ny').toString()).toBe('x\ny');
    expect(keepTextFormat(Buffer.from('a\r\nb'), 'x\r\ny\nz').toString()).toBe('x\r\ny\nz');
    expect(keepTextFormat(Buffer.from('\ufeffa'), 'b')).toEqual(Buffer.from('\ufeffb'));
    expect(keepTextFormat(Buffer.from('\ufeffa'), '\ufeffb')).toEqual(Buffer.from('\ufeffb'));
    expect(keepTextFormat(Buffer.from('a'), 'b')).toEqual(Buffer.from('b'));
  });
});

describe("the preview's version", () => {
  it('is given for whole UTF-8 text only', () => {
    writeFileSync(join(project, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // café in Latin-1
    writeFileSync(join(project, 'late-nul.txt'), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
    writeFileSync(join(project, 'long.txt'), 'x'.repeat(FILE_LIMITS.maxPreviewBytes + 1));
    writeFileSync(join(project, 'empty.txt'), '');
    expect(previewFile(project, 'latin1.txt').version).toBeUndefined();
    expect(previewFile(project, 'late-nul.txt').version).toBeUndefined();
    expect(previewFile(project, 'long.txt')).toMatchObject({ truncated: true });
    expect(previewFile(project, 'long.txt').version).toBeUndefined();
    expect(previewFile(project, 'empty.txt').version).toBe(fileVersion(Buffer.alloc(0)));
  });
});

describe('file names', () => {
  it('takes names every system takes', () => {
    for (const name of ['queue.csv', '.env', 'Report 2026.md', '報告.txt', 'a..b', 'console.log', 'COM10', '...x']) {
      expect(fileNameProblem(name), name).toBeUndefined();
    }
  });

  it('says why a name cannot be one', () => {
    expect(fileNameProblem('  ')).toBe('empty');
    expect(fileNameProblem('a/b')).toBe('separator');
    expect(fileNameProblem('a\\b')).toBe('separator');
    expect(fileNameProblem('..')).toBe('dots');
    expect(fileNameProblem('a\u0007')).toBe('control');
    expect(fileNameProblem('a\udc00')).toBe('control');
    expect(fileNameProblem('.Git')).toBe('git');
    expect(fileNameProblem('.git. ')).toBe('git');
    expect(fileNameProblem('LPT1.log')).toBe('reserved');
    expect(fileNameProblem('a|b')).toBe('reserved');
    expect(fileNameProblem('end.')).toBe('reserved');
    expect(fileNameProblem('x'.repeat(256))).toBe('tooLong');
    expect(fileNameProblem('字'.repeat(85))).toBe(undefined);
    expect(fileNameProblem('字'.repeat(86))).toBe('tooLong');
  });

  it('tells a lone surrogate from a pair', () => {
    expect(hasLoneSurrogate('😀')).toBe(false);
    expect(hasLoneSurrogate('\ud83d')).toBe(true);
    expect(hasLoneSurrogate('a\ude00b')).toBe(true);
  });
});
