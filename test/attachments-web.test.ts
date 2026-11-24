import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '../src/shared/types';
import {
  FOLDER_PICKER_SINCE,
  LEFT_OUT,
  acceptAttachments,
  canPickFolders,
  foldersOfPicked,
  isFolder,
  pickedFromFolderPicker,
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
  folderSameName: (name: string, path: string) => `same ${name} ${path}`,
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
    // Spelled as the disk will name them (spaces of any kind around, dots after, another letter case).
    const [odd] = foldersOfPicked([
      picked('odd/.git\u00a0./config'),
      picked('odd/ .GIT/HEAD'),
      picked('odd/Node_Modules\ufeff/x.js'),
      picked('odd/.g\u200cit/HEAD'),
      picked('odd/keep.md'),
    ]);
    expect(odd!.files.map((f) => f.path)).toEqual(['keep.md']);
    expect(odd!.leftOut).toEqual(['.git', 'node_modules']);
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

describe('what a folder picker gave', () => {
  it('is the folders its files came from, or the files themselves where none came with a folder path', () => {
    const [docs] = pickedFromFolderPicker([picked('docs/a.md', 2), picked('docs/b/c.md', 3)]) as PendingFolder[];
    expect(docs!.name).toBe('docs');
    expect(docs!.files.map((f) => f.path)).toEqual(['a.md', 'b/c.md']);
    // A picker that takes files only (an older phone's): the files picked, attached as files.
    const loose = [new File(['x'], 'photo.jpg'), picked('notes.txt')];
    expect(pickedFromFolderPicker(loose)).toEqual(loose);
    expect(pickedFromFolderPicker(loose).some(isFolder)).toBe(false);
    // An empty folder gives nothing, which the composer says.
    expect(pickedFromFolderPicker([])).toEqual([]);
  });
});

describe('whether a browser can pick a folder', () => {
  const computer = { attribute: true, maxTouchPoints: 0, touchScreen: false };
  const phone = { attribute: true, maxTouchPoints: 5, touchScreen: true };
  const safari = (system: string, version: string, device = 'iPhone; CPU iPhone OS') =>
    `Mozilla/5.0 (${device} ${system} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Mobile/15E148 Safari/604.1`;
  const android = (chrome: number, extra = '') =>
    `Mozilla/5.0 (Linux; Android 14; Pixel 7${extra}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Mobile Safari/537.36`;
  const can = (userAgent: string, b: typeof computer = phone) => canPickFolders({ ...b, userAgent });

  it('on a computer, wherever the attribute is, also on a touch screen with a browser from the versions that pick folders', () => {
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
    for (const ua of [chrome, mac, firefox]) expect(can(ua, computer)).toBe(true);
    expect(canPickFolders({ ...computer, attribute: false, userAgent: chrome })).toBe(false);
    // A tablet running a computer's system (Windows, ChromeOS), or Chrome on an Android tablet asking for
    // desktop sites, which gives Linux.
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
    expect(can(edge)).toBe(true);
    expect(can('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')).toBe(true);
    expect(can('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe(false);
    expect(can(firefox)).toBe(false);
  });

  it('on an iPhone or iPad, from iOS 18.4 on, in Safari, in another browser, and on an iPad asking for desktop sites', () => {
    expect(FOLDER_PICKER_SINCE.ios).toEqual([18, 4]);
    expect(can(safari('18_3_1', '18.3'))).toBe(false);
    expect(can(safari('18_4', '18.4'))).toBe(true);
    expect(can(safari('17_7', '17.7', 'iPad; CPU OS'))).toBe(false);
    expect(can(safari('18_5', '18.5', 'iPad; CPU OS'))).toBe(true);
    // From iOS 26 on Safari gives the system as 18.6 or later, and its own version as it is.
    expect(can(safari('18_6', '26.1'))).toBe(true);
    // Chrome and Firefox there give the system's version only, whatever their own.
    const crios = (system: string) =>
      `Mozilla/5.0 (iPhone; CPU iPhone OS ${system} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1`;
    expect(can(crios('17_5'))).toBe(false);
    expect(can(crios('26_1'))).toBe(true);
    const fxios =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/145.0 Mobile/15E148 Safari/605.1.15';
    expect(can(fxios)).toBe(false);
    // An iPad asking for desktop sites says it is a Mac: its touch points tell, and Safari's version.
    const asMac = (version: string) =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Safari/605.1.15`;
    expect(can(asMac('18.3'))).toBe(false);
    expect(can(asMac('18.4'))).toBe(true);
    expect(can(asMac('18.3'), { ...phone, touchScreen: false })).toBe(false);
    expect(can(asMac('16.0'), computer)).toBe(true);
    expect(can('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe(false);
  });

  it('on Android, from Chrome 132 and Firefox 142 on, in any Chromium browser, never in an app’s WebView', () => {
    expect(can(android(131))).toBe(false);
    expect(can(android(132))).toBe(true);
    expect(can(android(140), computer)).toBe(true);
    expect(can(android(131), computer)).toBe(false);
    const samsung = (chrome: number) =>
      `Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/${chrome}.0.0.0 Mobile Safari/537.36`;
    expect(can(samsung(125))).toBe(false);
    expect(can(samsung(132))).toBe(true);
    expect(can(`${android(133)} EdgA/133.0.0.0`)).toBe(true);
    const firefox = (v: number) => `Mozilla/5.0 (Android 14; Mobile; rv:${v}.0) Gecko/${v}.0 Firefox/${v}.0`;
    expect(can(firefox(141))).toBe(false);
    expect(can(firefox(142))).toBe(true);
    expect(can(android(140, ' Build/UQ1A.240205.004; wv').replace('Chrome/', 'Version/4.0 Chrome/'))).toBe(false);
  });

  it('nowhere else touch comes first', () => {
    expect(can('Mozilla/5.0 (Mobile; LYF/F300B; Android; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5')).toBe(false);
    expect(can('Opera/9.80 (J2ME/MIDP; Opera Mini/9.80; U; en) Presto/2.12.423 Version/12.16')).toBe(false);
    expect(can('')).toBe(false);
    expect(canPickFolders({ ...phone, attribute: false, userAgent: android(140) })).toBe(false);
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
    // Two paths a disk that ignores letter case takes for one, which the server would refuse.
    const clash: PendingFolder = {
      name: 'linux',
      files: [
        { path: 'Makefile', file: sized('Makefile', 1) },
        { path: 'makefile', file: sized('makefile', 1) },
      ],
      size: 2,
      leftOut: [],
    };
    const refused = acceptAttachments([clash], { count: 0, bytes: 0 }, notices, fmt);
    expect(refused).toEqual({ accepted: [], notice: 'same linux makefile' });
  });
});
