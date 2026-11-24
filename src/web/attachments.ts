import { pathClash } from '../shared/fileNames';
import { ATTACHMENT_LIMITS } from '../shared/types';

/*
 * Attaching folders: what a folder the user picked or dropped holds, and whether what they attach fits
 * the limits (`ATTACHMENT_LIMITS`), before anything is read. No DOM here: a dropped folder is read
 * through the few parts of its entry this needs, which a test can stand in for.
 */

/**
 * Names an attached folder leaves out, wherever they are in it: version control's folders, installed
 * packages (which a project's own files can bring back) and the system's own files.
 */
export const LEFT_OUT = ['.git', '.hg', '.svn', 'node_modules', '.DS_Store', 'Thumbs.db', 'desktop.ini'];

/**
 * The name of `LEFT_OUT` a name is, as a disk would name it (in any letter case, without the spaces
 * around it or the dots after it, which the server takes off too, nor format characters, which an HFS+
 * volume leaves out), or undefined.
 */
const leftOutAs = (name: string) => {
  const key = name
    .replace(/\p{Cf}/gu, '')
    .trim()
    .replace(/[\s.]+$/u, '')
    .toLowerCase();
  return LEFT_OUT.find((n) => n.toLowerCase() === key);
};

/** The names left out, in `LEFT_OUT`'s order, whichever order the browser gave the files in. */
function inOrder(f: PendingFolder): PendingFolder {
  f.leftOut.sort((a, b) => LEFT_OUT.indexOf(a) - LEFT_OUT.indexOf(b));
  return f;
}

/** A file of a folder being attached: its path in the folder, with `/`. */
export interface FolderFile {
  path: string;
  file: File;
}

/** A folder being attached: its files, their size together, and which of `LEFT_OUT` it had. */
export interface PendingFolder {
  name: string;
  files: FolderFile[];
  size: number;
  leftOut: string[];
  /** More files than a folder may hold: reading it stopped there. */
  tooMany?: boolean;
}

/** A file or a folder the user picked, dropped or pasted. */
export type Picked = File | PendingFolder;

export const isFolder = (p: Picked): p is PendingFolder => !(p instanceof Blob);

/** The name of `LEFT_OUT` a path in a folder goes through, if any. */
function leftOutName(path: string): string | undefined {
  for (const name of path.split('/')) {
    const as = leftOutAs(name);
    if (as) return as;
  }
  return undefined;
}

function folder(name: string): PendingFolder {
  return { name, files: [], size: 0, leftOut: [] };
}

function addTo(f: PendingFolder, path: string, file: File): void {
  const skip = leftOutName(path);
  if (skip) {
    if (!f.leftOut.includes(skip)) f.leftOut.push(skip);
    return;
  }
  if (f.files.length >= ATTACHMENT_LIMITS.maxFolderFiles) {
    f.tooMany = true;
    return;
  }
  f.files.push({ path, file });
  f.size += file.size;
}

/**
 * The folders a folder picker's files came from (`<input webkitdirectory>`, each file's
 * `webkitRelativePath` "<folder>/<path in it>"), in the order they came, without what `LEFT_OUT` names.
 * A file without such a path is left out.
 */
export function foldersOfPicked(files: Iterable<File>): PendingFolder[] {
  const folders = new Map<string, PendingFolder>();
  for (const file of files) {
    const [top, ...rest] = folderPath(file);
    if (!top || !rest.length) continue;
    let f = folders.get(top);
    if (!f) folders.set(top, (f = folder(top)));
    addTo(f, rest.join('/'), file);
  }
  return [...folders.values()].map(inOrder);
}

/** A picked file's path under the folder picked, by its names, the folder's own first (none for a loose file). */
const folderPath = (file: File) => (file.webkitRelativePath || '').split('/').filter(Boolean);

/**
 * What a folder picker gave, to attach: the folders its files came from (`foldersOfPicked`), or, when
 * none of them came with a path under a folder, the files themselves, since a browser whose picker
 * takes files only let the user pick them one by one (`canPickFolders` offers no such picker that it
 * knows of). Nothing for an empty folder.
 */
export function pickedFromFolderPicker(files: Iterable<File>): Picked[] {
  const all = [...files];
  return all.some((f) => folderPath(f).length > 1) ? foldersOfPicked(all) : all;
}

/** What says whether this browser's folder picker picks a folder. */
export interface FolderPickerBrowser {
  /** Whether an `<input>` has `webkitdirectory` at all. */
  attribute: boolean;
  /** `navigator.userAgent`. */
  userAgent: string;
  /** `navigator.maxTouchPoints`: an iPad asking for desktop sites says it is a Mac, but has some. */
  maxTouchPoints: number;
  /** Touch is the main input and nothing hovers (`isTouchScreen()` in `chat.ts`). */
  touchScreen: boolean;
  /**
   * Whether `Iterator.prototype.map` is there, which WebKit has from Safari 18.4 on (MDN): the system's
   * version on an iPad whose user agent gives none (its home-screen web app, a web view in an app).
   */
  iteratorHelpers: boolean;
}

/**
 * The first version of each phone and tablet browser whose folder picker picks a folder, as MDN's
 * compatibility data has them. Before them `webkitdirectory` is there all the same, but the picker
 * takes files only (Safari on iOS and iPadOS before 18.4, Chrome for Android before 131), picking a
 * folder crashes the browser (Chrome for Android 131) or its files come with no path in it (Firefox
 * for Android 141): so where touch comes first, a browser is told by its version, never by the
 * attribute. A browser on iOS and iPadOS goes by the system's version: it gives the picker of the
 * system's WebKit.
 */
export const FOLDER_PICKER_SINCE = { ios: [18, 4], chrome: 132, firefox: 142 } as const;

/**
 * Whether this browser can pick a folder. A computer's can wherever `webkitdirectory` is. A phone's or
 * a tablet's (an iPhone, an iPad, also one asking for desktop sites, anything on Android, anything else
 * with a touch screen and no mouse, such as a Windows tablet) only from the versions in
 * `FOLDER_PICKER_SINCE` on, and never in an app's Android WebView, where the app itself gives the
 * picker, and may take files only. A browser it cannot tell stays without one.
 */
export function canPickFolders(b: FolderPickerBrowser): boolean {
  if (!b.attribute) return false;
  const ua = b.userAgent;
  const iPhoneOrIPad = /\b(?:iPhone|iPad|iPod)\b/.test(ua);
  const iPadAsMac = !iPhoneOrIPad && /\bMacintosh\b/.test(ua) && b.maxTouchPoints > 1;
  if (iPhoneOrIPad || iPadAsMac) {
    // Safari's version is the system's, which the system's own token may put lower: from iOS 26 on Safari
    // gives it as 18.6 or later, and an iPad asking for desktop sites as a Mac's. Another browser there
    // gives the system's only, and an iPad's home-screen web app neither.
    const system = iPhoneOrIPad ? versionIn(/\bOS (\d+)_(\d+)/, ua) : undefined;
    const safari = versionIn(/\bVersion\/(\d+)\.(\d+)/, ua);
    if (!system && !safari) return b.iteratorHelpers;
    return [system, safari].some((v) => v && atLeast(v, FOLDER_PICKER_SINCE.ios));
  }
  const android = /\bAndroid\b/.test(ua);
  if (!android && !b.touchScreen) return true;
  // A WebView says so (`wv`), or gives its `Version/4.0` beside Chrome's, which an app may keep alone.
  if (android && (/;\s*wv\)/.test(ua) || /\bVersion\/4\.0\b/.test(ua))) return false;
  // Firefox's before Chrome's: Chrome's name is in every Chromium browser's (Edge, Samsung Internet, Opera).
  const firefox = versionIn(/\bFirefox\/(\d+)/, ua);
  if (firefox) return atLeast(firefox, [FOLDER_PICKER_SINCE.firefox, 0]);
  const chrome = versionIn(/\bChrome\/(\d+)/, ua);
  return !!chrome && atLeast(chrome, [FOLDER_PICKER_SINCE.chrome, 0]);
}

/** The version a user agent's pattern finds, as numbers (a minor one 0 when it has none). */
function versionIn(pattern: RegExp, ua: string): readonly [number, number] | undefined {
  const m = pattern.exec(ua);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : undefined;
}

const atLeast = ([major, minor]: readonly [number, number], [since, sinceMinor]: readonly [number, number]) =>
  major > since || (major === since && minor >= sinceMinor);

/** The parts of a dropped item's `FileSystemEntry` reading a folder needs. */
export interface DroppedEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?(ok: (file: File) => void, fail?: (err: unknown) => void): void;
  createReader?(): { readEntries(ok: (entries: DroppedEntry[]) => void, fail?: (err: unknown) => void): void };
}

/**
 * What a dropped folder holds, read from its entry: every file in it and its folders, not going into
 * what `LEFT_OUT` names, and stopping once it holds more than a folder may (`tooMany`). A link the
 * browser cannot read is an error, as a file that cannot be read.
 */
export async function readDroppedFolder(entry: DroppedEntry): Promise<PendingFolder> {
  const f = folder(entry.name);
  const walk = async (dir: DroppedEntry, prefix: string): Promise<void> => {
    const reader = dir.createReader!();
    // A reader gives a folder's entries a batch at a time (100 in Chrome), then none.
    for (;;) {
      const batch = await new Promise<DroppedEntry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) return;
      for (const child of batch) {
        if (f.tooMany) return;
        const path = prefix + child.name;
        const skip = leftOutAs(child.name);
        if (skip) {
          if (!f.leftOut.includes(skip)) f.leftOut.push(skip);
        } else if (child.isDirectory) {
          await walk(child, `${path}/`);
        } else if (child.isFile) {
          addTo(f, path, await new Promise<File>((ok, fail) => child.file!(ok, fail)));
        }
      }
    }
  };
  await walk(entry, '');
  return inOrder(f);
}

/** The words a refusal is said in (the composer's). */
export interface AttachNotices {
  tooManyFiles: (n: number) => string;
  fileTooLarge: (name: string, max: string) => string;
  totalTooLarge: (max: string) => string;
  folderTooManyFiles: (name: string, n: number) => string;
  folderEmpty: (name: string) => string;
  folderSameName: (name: string, path: string) => string;
}

/**
 * Which of what the user picked can be attached beside what is attached already (`count` files and
 * folders, `bytes` in all), in order: at most `maxFiles` in all, no file over `maxBytes` (in a folder
 * neither), no folder without files or over `maxFolderFiles`, nor with two paths a disk that ignores
 * letter case takes for one (`pathClash`, which the server refuses), and `maxTotalBytes` together. What
 * does not fit is left out, and the last reason why is the notice.
 */
export function acceptAttachments(
  picked: Picked[],
  attached: { count: number; bytes: number },
  notices: AttachNotices,
  formatBytes: (n: number) => string,
): { accepted: Picked[]; notice: string } {
  const L = ATTACHMENT_LIMITS;
  const accepted: Picked[] = [];
  let notice = '';
  let bytes = attached.bytes;
  for (const item of picked) {
    if (attached.count + accepted.length >= L.maxFiles) {
      notice = notices.tooManyFiles(L.maxFiles);
      break;
    }
    if (isFolder(item)) {
      const big = item.files.find((f) => f.file.size > L.maxBytes);
      const clash = item.files.length <= L.maxFolderFiles ? pathClash(item.files.map((f) => f.path)) : undefined;
      if (item.tooMany) notice = notices.folderTooManyFiles(item.name, L.maxFolderFiles);
      else if (!item.files.length) notice = notices.folderEmpty(item.name);
      else if (big) notice = notices.fileTooLarge(`${item.name}/${big.path}`, formatBytes(L.maxBytes));
      else if (clash) notice = notices.folderSameName(item.name, clash);
      else if (bytes + item.size > L.maxTotalBytes) notice = notices.totalTooLarge(formatBytes(L.maxTotalBytes));
      else {
        accepted.push(item);
        bytes += item.size;
      }
      continue;
    }
    if (item.size > L.maxBytes) notice = notices.fileTooLarge(item.name, formatBytes(L.maxBytes));
    else if (bytes + item.size > L.maxTotalBytes) notice = notices.totalTooLarge(formatBytes(L.maxTotalBytes));
    else {
      accepted.push(item);
      bytes += item.size;
    }
  }
  return { accepted, notice };
}
