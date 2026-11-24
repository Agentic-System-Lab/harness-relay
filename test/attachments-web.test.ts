import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '../src/shared/types';
import {
  LEFT_OUT,
  acceptAttachments,
  foldersOfPicked,
  isFolder,
  readDroppedFolder,
  type DroppedEntry,
  type PendingFolder,
} from '../src/web/attachments';

/** A file as a folder picker gives it: with the path it has under the folder picked. */
function picked(relativePath: string, size = 1): File {
  const file = new File([new Uint8Array(size)], relativePath.split('/').pop()!);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

/** A dropped folder's entry, from a tree of names: a string is a file's contents, an object a folder. */
type Tree = { [name: string]: string | Tree };
function entry(name: string, node: string | Tree, batch = 2): DroppedEntry {
  if (typeof node === 'string') return { name, isFile: true, isDirectory: false, file: (ok) => ok(new File([node], name)) };
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      const children = Object.entries(node).map(([n, child]) => entry(n, child, batch));
      let at = 0;
      // A batch at a time, then none, as browsers give them.
      return { readEntries: (ok) => ok(children.slice(at, (at += batch))) };
    },
  };
}

const notices = {
  tooManyFiles: (n: number) => `too many ${n}`,
  fileTooLarge: (name: string, max: string) => `too large ${name} ${max}`,
  totalTooLarge: (max: string) => `total ${max}`,
  folderTooManyFiles: (name: string, n: number) => `folder too many ${name} ${n}`,
  folderEmpty: (name: string) => `empty ${name}`,
};
const fmt = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
/** A file of `size` bytes, without holding them. */
function sized(name: string, size: number): File {
  const f = new File([], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
}
const pending = (name: string, sizes: number[], extra: Partial<PendingFolder> = {}): PendingFolder => ({
  name,
  files: sizes.map((size, i) => ({ path: `f${i}`, file: sized(`f${i}`, size) })),
  size: sizes.reduce((a, b) => a + b, 0),
  leftOut: [],
  ...extra,
});

describe('a picked folder', () => {
  it("groups a folder picker's files by the folder, with their paths in it, leaving out version control, packages and system files", () => {
    const [app] = foldersOfPicked([
      picked('app/package.json', 2),
      picked('app/src/main.ts', 3),
      picked('app/.git/HEAD'),
      picked('app/src/.DS_Store'),
      picked('app/node_modules/x/index.js'),
      picked('app/.env.example'),
    ]);
    expect(app!.name).toBe('app');
    expect(app!.files.map((f) => f.path)).toEqual(['package.json', 'src/main.ts', '.env.example']);
    expect(app!.size).toBe(6);
    expect(app!.leftOut).toEqual(['.git', 'node_modules', '.DS_Store']);
    expect(LEFT_OUT).toEqual(expect.arrayContaining(['.git', 'node_modules']));
  });

  it('leaves out a file without a folder path, and stops counting past the files a folder may hold', () => {
    expect(foldersOfPicked([new File(['x'], 'loose.txt')])).toEqual([]);
    const many = Array.from({ length: ATTACHMENT_LIMITS.maxFolderFiles + 2 }, (_, i) => picked(`big/${i}.txt`));
    const [big] = foldersOfPicked(many);
    expect(big!.files).toHaveLength(ATTACHMENT_LIMITS.maxFolderFiles);
    expect(big!.tooMany).toBe(true);
  });
});

describe('a dropped folder', () => {
  it('reads every batch of every folder in it, not going into what it leaves out', async () => {
    const folder = await readDroppedFolder(
      entry('docs', {
        'a.md': 'aa',
        'b.md': 'b',
        guides: { 'one.md': '1', deeper: { 'two.md': '22' } },
        '.git': { HEAD: 'ref' },
        node_modules: { pkg: { 'index.js': 'x' } },
        'Thumbs.db': '?',
      }),
    );
    expect(folder.name).toBe('docs');
    expect(folder.files.map((f) => f.path)).toEqual(['a.md', 'b.md', 'guides/one.md', 'guides/deeper/two.md']);
    expect(folder.size).toBe(6);
    expect(folder.leftOut).toEqual(['.git', 'node_modules', 'Thumbs.db']);
    expect(folder.tooMany).toBeUndefined();
  });

  it('stops reading once it holds more files than a folder may', async () => {
    const tree: Tree = {};
    for (let i = 0; i < ATTACHMENT_LIMITS.maxFolderFiles + 50; i++) tree[`${i}.txt`] = '';
    const folder = await readDroppedFolder(entry('many', tree, 100));
    expect(folder.tooMany).toBe(true);
    expect(folder.files).toHaveLength(ATTACHMENT_LIMITS.maxFolderFiles);
  });

  it('fails when a file in it cannot be read', async () => {
    const broken: DroppedEntry = { name: 'x', isFile: true, isDirectory: false, file: (_ok, fail) => fail!(new Error('gone')) };
    const dir: DroppedEntry = {
      name: 'd',
      isFile: false,
      isDirectory: true,
      createReader: () => {
        let done = false;
        return { readEntries: (ok) => ok(done ? [] : ((done = true), [broken])) };
      },
    };
    await expect(readDroppedFolder(dir)).rejects.toThrow('gone');
  });
});

describe('what can be attached', () => {
  const file = sized;

  it('takes files and folders together up to the files and folders a message may attach', () => {
    const items = [file('a', 1), pending('dir', [1, 2]), file('b', 1)];
    const { accepted, notice } = acceptAttachments(items, { count: ATTACHMENT_LIMITS.maxFiles - 2, bytes: 0 }, notices, fmt);
    expect(accepted.map((p) => (isFolder(p) ? `${p.name}/` : p.name))).toEqual(['a', 'dir/']);
    expect(notice).toBe(`too many ${ATTACHMENT_LIMITS.maxFiles}`);
  });

  it('leaves out an empty folder, one with too many files, one with a file too large, and what is over the total', () => {
    const MB = 1024 * 1024;
    const { accepted, notice } = acceptAttachments(
      [
        pending('empty', []),
        pending('crowded', [1], { tooMany: true }),
        pending('huge', [1, ATTACHMENT_LIMITS.maxBytes + 1]),
        pending('fine', [10 * MB]),
        file('big.bin', ATTACHMENT_LIMITS.maxBytes + 1),
      ],
      { count: 0, bytes: 0 },
      notices,
      fmt,
    );
    expect(accepted.map((p) => p.name)).toEqual(['fine']);
    expect(notice).toBe('too large big.bin 20 MB');
    // What is attached already counts in the total.
    const over = acceptAttachments([pending('fine', [10 * MB]), file('ok', 1)], { count: 1, bytes: 195 * MB }, notices, fmt);
    expect(over.accepted.map((p) => p.name)).toEqual(['ok']);
    expect(over.notice).toBe('total 200 MB');
    expect(acceptAttachments([pending('empty', [])], { count: 0, bytes: 0 }, notices, fmt).notice).toBe('empty empty');
    expect(acceptAttachments([pending('c', [1], { tooMany: true })], { count: 0, bytes: 0 }, notices, fmt).notice).toBe(
      `folder too many c ${ATTACHMENT_LIMITS.maxFolderFiles}`,
    );
    expect(acceptAttachments([pending('h', [ATTACHMENT_LIMITS.maxBytes + 1])], { count: 0, bytes: 0 }, notices, fmt).notice).toBe(
      'too large h/f0 20 MB',
    );
  });
});
