// The Files panel's editing and uploading in the page (src/web/fileEdit.ts): when it offers to edit,
// what a text box holds, the save key, and what a pick or drop of files sends.
import { describe, expect, it } from 'vitest';
import { canEdit, editorText, isDirty, isSaveKey, newFileProblem, uploadPlan } from '../src/web/fileEdit';
import { FILE_EDIT_LIMITS, type FileEntry, type FilePreview } from '../src/shared/types';

const text = (extra: Partial<FilePreview> = {}): FilePreview => ({
  path: 'a.csv',
  size: 3,
  mtime: 0,
  kind: 'text',
  text: 'a,b',
  version: 'v1',
  ...extra,
});
const entry = (name: string, kind: FileEntry['kind'] = 'file'): FileEntry => ({ name, kind, size: 1, mtime: 0 });

describe('canEdit', () => {
  it('offers editing for a whole text file in a root that takes writes', () => {
    expect(canEdit({ writable: true }, text())).toBe(true);
    expect(canEdit({ writable: false }, text())).toBe(false);
    expect(canEdit({}, text())).toBe(false);
    expect(canEdit(null, text())).toBe(false);
    expect(canEdit({ writable: true }, text({ version: undefined, truncated: true }))).toBe(false);
    expect(canEdit({ writable: true }, text({ kind: 'binary', text: undefined }))).toBe(false);
    expect(canEdit({ writable: true }, null)).toBe(false);
  });
});

describe('the text box', () => {
  it('holds every line break as LF, and tells changes from line breaks alone', () => {
    expect(editorText('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(isDirty('a\r\nb\r\n', 'a\nb\n')).toBe(false);
    expect(isDirty('a\r\nb\r\n', 'a\nb\nc\n')).toBe(true);
    expect(isDirty('', '')).toBe(false);
  });

  it('saves on Ctrl+S or ⌘S only', () => {
    const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    });
    expect(isSaveKey(key('s', { ctrlKey: true }))).toBe(true);
    expect(isSaveKey(key('S', { metaKey: true }))).toBe(true);
    expect(isSaveKey(key('s'))).toBe(false);
    expect(isSaveKey(key('s', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSaveKey(key('s', { metaKey: true, altKey: true }))).toBe(false);
    expect(isSaveKey(key('a', { ctrlKey: true }))).toBe(false);
  });
});

describe('uploadPlan', () => {
  it('sends each file, marking those that replace one listed there', () => {
    const plan = uploadPlan(
      [
        { name: 'photo.jpg', size: 10 },
        { name: 'queue.csv', size: 10 },
      ],
      [entry('queue.csv'), entry('src', 'dir')],
    );
    expect(plan.send).toEqual([
      { index: 0, name: 'photo.jpg', replace: false },
      { index: 1, name: 'queue.csv', replace: true },
    ]);
    expect(plan.replaces).toEqual(['queue.csv']);
    expect(plan.refused).toEqual([]);
  });

  it('refuses folders, bad names, files too large, a name twice and a folder of that name, and past the most a pick takes', () => {
    const limits = { ...FILE_EDIT_LIMITS, maxUploadFiles: 2, maxUploadBytes: 100 };
    const plan = uploadPlan(
      [
        { name: 'album', size: 0, folder: true },
        { name: 'CON', size: 1 },
        { name: 'big.mov', size: 101 },
        { name: 'a.txt', size: 1 },
        { name: 'a.txt', size: 1 },
        { name: 'src', size: 1 },
        { name: 'b.txt', size: 1 },
        { name: 'c.txt', size: 1 },
      ],
      [entry('src', 'dir')],
      limits,
    );
    expect(plan.send.map((s) => s.name)).toEqual(['a.txt', 'b.txt']);
    expect(plan.refused).toEqual([
      { name: 'album', why: 'folder' },
      { name: 'CON', why: 'name', problem: 'reserved' },
      { name: 'big.mov', why: 'size' },
      { name: 'a.txt', why: 'duplicate' },
      { name: 'src', why: 'isFolder' },
      { name: 'c.txt', why: 'tooMany' },
    ]);
  });
});

describe('newFileProblem', () => {
  it("says why a new file's name cannot be used here", () => {
    expect(newFileProblem('notes.md', [entry('queue.csv')])).toBeUndefined();
    expect(newFileProblem('queue.csv', [entry('queue.csv')])).toBe('exists');
    expect(newFileProblem('src', [entry('src', 'dir')])).toBe('exists');
    expect(newFileProblem('a/b.md', [])).toBe('separator');
    expect(newFileProblem('', [])).toBe('empty');
  });
});
