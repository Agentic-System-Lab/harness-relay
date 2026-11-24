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
 * around it or the dots after it, which the server takes off too), or undefined.
 */
const leftOutAs = (name: string) => {
  const key = name
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
    const [top, ...rest] = (file.webkitRelativePath || '').split('/').filter(Boolean);
    if (!top || !rest.length) continue;
    let f = folders.get(top);
    if (!f) folders.set(top, (f = folder(top)));
    addTo(f, rest.join('/'), file);
  }
  return [...folders.values()].map(inOrder);
}

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
