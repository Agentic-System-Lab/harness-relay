import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { cutName, isWindowsDevice, pathClash } from '../shared/fileNames';
import type { ChatMessage, MessagePart } from '../shared/types';
import { ATTACHMENT_LIMITS, FOLDER_MIME_TYPE, isFolderAttachment, isInlineImage } from '../shared/types';
import { HttpError } from './errors';
import { t } from './i18n';
import { DATA_DIR } from './settings';

/** A file the user attached, as the browser sends it, or a folder (`files` in place of `data`). */
export interface AttachmentUpload {
  name?: unknown;
  mimeType?: unknown;
  /** Base64 contents. */
  data?: unknown;
  /** A folder's files: each one's path in it (with `/`) and its base64 contents (`data`). */
  files?: unknown;
}

export type AttachmentPart = Extract<MessagePart, { type: 'attachment' }>;

/**
 * Files of one conversation: data/attachments/<conversation>/<attachment id>/<file name>, and a
 * folder's as data/attachments/<conversation>/<attachment id>/<folder name>/<its paths>.
 */
export function attachmentsDir(convId: string): string {
  return join(DATA_DIR, 'attachments', convId);
}

/** A file name that is safe to put on disk (no directories, no control characters). */
export function safeFileName(name: string): string {
  const clean = basename(name.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return clean || 'file';
}

/**
 * The name an attached file or folder is kept under (`AttachmentPart.name`): `safeFileName`'s, without
 * the dots and whitespace (of any kind) it starts or ends with, at most 255 bytes in UTF-8 (`cutName`,
 * its extension kept), never a Windows device name, and one `safeFileName` leaves as it is, so that what
 * `attachmentPath` puts on disk is this very name (`safeFileName` itself stays as it was: names kept
 * before stay where they are). A round only takes characters away (or puts `_` before a device name,
 * once), so it settles in a few.
 */
function uploadName(name: string): string {
  const step = (n: string) => {
    const safe = safeFileName(n).replace(/^[\s.]+|[\s.]+$/gu, '') || 'file';
    return cutName(isWindowsDevice(safe) ? `_${safe}` : safe);
  };
  let current = step(name);
  for (let next = step(current); next !== current; next = step(current)) current = next;
  return current;
}

/**
 * One name on a path inside an attached folder, safe to put on disk on any system: no separator,
 * control or reserved character, nothing a Windows name cannot end with (dots, spaces), so never `.`
 * or `..`; no Windows device name; at most 255 bytes in UTF-8 (`cutName`, its extension kept). A
 * leading dot stays (`.gitignore`), unlike an attached file's own name. Made safe again, it stays as it is.
 */
function safeSegment(name: string): string {
  // Without the whitespace around it (any: `trim()` takes a no-break space too) and the dots and
  // whitespace it ends in, cut: what is left has none of them to lose, so made safe again it is the same.
  const fit = (n: string) =>
    cutName(n.trim())
      .replace(/[\s.]+$/u, '')
      .trim() || '_';
  const safe = fit(name.replace(/[\u0000-\u001f\u007f<>:"|?*\\]/g, '_'));
  // Checked once its trailing dots and spaces are gone (`con .` is `con` on Windows).
  return isWindowsDevice(safe) ? fit(`_${safe}`) : safe;
}

/**
 * Whether a name is git's own folder, in any letter case, without the whitespace around it or the dots
 * after it, and without format characters (zero-width ones, a BOM), which an HFS+ volume leaves out of
 * a name.
 */
const isGitName = (name: string) =>
  name
    .replace(/\p{Cf}/gu, '')
    .trim()
    .replace(/[\s.]+$/u, '')
    .toLowerCase() === '.git';

/** A path inside an attached folder made safe (`/` between its names, none of them empty), or undefined when it has none. */
export function folderFilePath(path: string): string | undefined {
  const names = path.split('/').filter(Boolean);
  return names.length ? names.map(safeSegment).join('/') : undefined;
}

export function attachmentPath(convId: string, a: Pick<AttachmentPart, 'id' | 'name'>): string {
  return join(attachmentsDir(convId), a.id, safeFileName(a.name));
}

/** A file of an attached folder: its path in it, with `/`. */
export interface FolderFileData {
  path: string;
  bytes: Uint8Array;
}

export interface AttachmentData {
  name: string;
  mimeType: string;
  /** A file's contents (none for a folder). */
  bytes: Uint8Array;
  /** A folder's files. */
  files?: FolderFileData[];
}

/** Validate the whole upload before writing any file. */
export function decodeAttachments(uploads: unknown): AttachmentData[] {
  if (uploads === undefined) return [];
  if (!Array.isArray(uploads)) throw new HttpError(400, t().badAttachment);
  if (uploads.length > ATTACHMENT_LIMITS.maxFiles) throw new HttpError(400, t().tooManyAttachments(ATTACHMENT_LIMITS.maxFiles));
  let total = 0;
  const decode = (data: string, name: string): Uint8Array => {
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > ATTACHMENT_LIMITS.maxBytes) throw new HttpError(400, t().attachmentTooLarge(name, ATTACHMENT_LIMITS.maxBytes));
    total += bytes.length;
    if (total > ATTACHMENT_LIMITS.maxTotalBytes) throw new HttpError(400, t().attachmentsTooLarge(ATTACHMENT_LIMITS.maxTotalBytes));
    return bytes;
  };
  return uploads.map((u) => {
    if (u?.files !== undefined && typeof u.name === 'string') return decodeFolder(uploadName(u.name), u.files, decode);
    if (typeof u?.data !== 'string' || typeof u.name !== 'string') throw new HttpError(400, t().badAttachment);
    const name = uploadName(u.name);
    const bytes = decode(u.data, name);
    // A file is never taken for a folder.
    const mimeType =
      typeof u.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(u.mimeType) && u.mimeType !== FOLDER_MIME_TYPE
        ? u.mimeType
        : 'application/octet-stream';
    return { name, mimeType, bytes };
  });
}

/**
 * An attached folder's files: at least one, at most `maxFolderFiles`, each path made safe and none
 * there twice, as the disk would take them (names that differ in letter case or Unicode form only are
 * one name on macOS and Windows: `pathClash`), nor a file where another's path has a folder. A file in
 * a `.git` folder is left out, as the browser leaves it out and a folder's ZIP file does: an agent's
 * git in the folder must not take a config it was sent.
 */
function decodeFolder(name: string, files: unknown, decode: (data: string, name: string) => Uint8Array): AttachmentData {
  if (!Array.isArray(files) || !files.length) throw new HttpError(400, t().badAttachment);
  if (files.length > ATTACHMENT_LIMITS.maxFolderFiles) {
    throw new HttpError(400, t().folderTooManyFiles(name, ATTACHMENT_LIMITS.maxFolderFiles));
  }
  const out: FolderFileData[] = [];
  for (const f of files as { path?: unknown; data?: unknown }[]) {
    if (typeof f?.path !== 'string' || typeof f.data !== 'string') throw new HttpError(400, t().badAttachment);
    const path = folderFilePath(f.path);
    if (!path) throw new HttpError(400, t().badAttachment);
    // As the disk will name it (made safe again, a path stays as it is).
    if (path.split('/').some(isGitName)) continue;
    out.push({ path, bytes: decode(f.data, `${name}/${path}`) });
  }
  if (!out.length) throw new HttpError(400, t().badAttachment);
  const clash = pathClash(out.map((f) => f.path));
  if (clash) throw new HttpError(400, t().folderSameName(name, clash));
  return { name, mimeType: FOLDER_MIME_TYPE, bytes: new Uint8Array(0), files: out };
}

/**
 * Whether this disk takes every name of the folders in `files` (an automation's, which each run writes
 * out later): their paths written as empty files where a run writes them (`attachmentPath()`), in a
 * folder of the attachments named as long as a conversation's (`check-` and 30 hex digits: a UUID's
 * length), then removed. A name or path it refuses (too long for its file system, two it takes for one)
 * is a 400 now, not at each run.
 */
export function checkFolderNames(files: AttachmentData[]): void {
  const folders = files.filter((f) => f.files);
  if (!folders.length) return;
  const check = `check-${randomUUID().replace(/-/g, '').slice(0, 30)}`;
  try {
    for (const f of folders) {
      const part = { id: randomUUID(), name: f.name };
      mkdirSync(join(attachmentsDir(check), part.id), { recursive: true });
      const empty = f.files!.map((file) => ({ path: file.path, bytes: new Uint8Array(0) }));
      writeFolder(attachmentPath(check, part), f.name, empty);
    }
  } finally {
    rmSync(attachmentsDir(check), { recursive: true, force: true });
  }
}

/** Write a folder's files under `root`, which must not be there yet: folders `0700`, files `0600`. */
function writeFolder(root: string, folder: string, files: FolderFileData[]): void {
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (err) {
    // The folder's own name, too long for this disk where it goes.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENAMETOOLONG' || code === 'EINVAL' || code === 'EILSEQ') throw new HttpError(400, t().folderBadName(folder, folder));
    throw err;
  }
  for (const f of files) {
    const path = folderFilePath(f.path);
    if (!path) throw new HttpError(400, t().badAttachment);
    // What is written is checked as written: never a file in a `.git` folder.
    if (path.split('/').some(isGitName)) continue;
    const to = join(root, ...path.split('/'));
    try {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      writeFileSync(to, f.bytes, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Two names this disk takes for one (a letter case or Unicode form the check did not see as one).
      if (code === 'EEXIST' || code === 'ENOTDIR' || code === 'EISDIR') throw new HttpError(400, t().folderSameName(folder, path));
      // A name or path this file system does not take.
      if (code === 'ENAMETOOLONG' || code === 'EINVAL' || code === 'EILSEQ' || code === 'ENOENT') {
        throw new HttpError(400, t().folderBadName(folder, path));
      }
      throw err;
    }
  }
}

/** Give each message its own files, including when several runs use the same automation. */
export function writeAttachments(convId: string, files: Iterable<AttachmentData>): AttachmentPart[] {
  const parts: AttachmentPart[] = [];
  try {
    for (const f of files) {
      const part: AttachmentPart = f.files
        ? {
            type: 'attachment',
            id: randomUUID(),
            name: f.name,
            mimeType: FOLDER_MIME_TYPE,
            size: f.files.reduce((n, file) => n + file.bytes.length, 0),
            files: f.files.length,
          }
        : { type: 'attachment', id: randomUUID(), name: f.name, mimeType: f.mimeType, size: f.bytes.length };
      parts.push(part);
      mkdirSync(join(attachmentsDir(convId), part.id), { recursive: true });
      if (f.files) writeFolder(attachmentPath(convId, part), f.name, f.files);
      else writeFileSync(attachmentPath(convId, part), f.bytes, { mode: 0o600 });
    }
    return parts;
  } catch (err) {
    removeAttachments(convId, parts);
    throw err;
  }
}

export function saveAttachments(convId: string, uploads: AttachmentUpload[] | undefined): AttachmentPart[] {
  return writeAttachments(convId, decodeAttachments(uploads));
}

/**
 * Copy attached files (and folders) of one conversation to another (a branch of it): a copy-on-write
 * clone where the filesystem can make one. A file that is gone is skipped: its link answers "not
 * found", as it did there.
 */
export async function copyAttachments(fromConvId: string, toConvId: string, parts: AttachmentPart[]): Promise<void> {
  for (const p of parts) {
    await mkdir(join(attachmentsDir(toConvId), p.id), { recursive: true });
    const to = attachmentPath(toConvId, p);
    if (isFolderAttachment(p)) {
      try {
        // Its folders and files keep their modes (0700, 0600); a link is copied as a link, never followed.
        await cp(attachmentPath(fromConvId, p), to, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      continue;
    }
    try {
      await copyFile(attachmentPath(fromConvId, p), to, constants.COPYFILE_FICLONE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    await chmod(to, 0o600);
  }
}

/**
 * The files of one conversation's folder its copied replies show by their path there (the browser's
 * screenshots, `browser-<time>.png`, which no attachment part names), copied to the branch's folder; the
 * copied replies' text then names the branch's folder, where its attached files are too
 * (`copyAttachments`), so the branch shows them as the conversation did, and keeps them if that one is
 * deleted.
 */
export async function copyShownFiles(fromConvId: string, toConvId: string, messages: ChatMessage[]): Promise<void> {
  const from = attachmentsDir(fromConvId) + sep;
  const to = attachmentsDir(toConvId) + sep;
  const texts = messages.flatMap((m) => m.parts.filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text'));
  const names = new Set<string>();
  for (const p of texts) {
    for (let i = p.text.indexOf(from); i >= 0; i = p.text.indexOf(from, i + from.length)) {
      const name = /^browser-[A-Za-z0-9-]+\.png/.exec(p.text.slice(i + from.length))?.[0];
      if (name) names.add(name);
    }
  }
  if (names.size) await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of names) {
    try {
      await copyFile(from + name, to + name, constants.COPYFILE_FICLONE);
      await chmod(to + name, 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  for (const p of texts) if (p.text.includes(from)) p.text = p.text.split(from).join(to);
}

export function removeAttachments(convId: string, parts?: AttachmentPart[]): void {
  if (!parts) {
    rmSync(attachmentsDir(convId), { recursive: true, force: true });
    return;
  }
  for (const p of parts) rmSync(join(attachmentsDir(convId), p.id), { recursive: true, force: true });
}

/** Images an agent can be shown directly (in the formats every CLI accepts). */
export function imageInputs(convId: string, parts: AttachmentPart[]): { path: string; mimeType: string }[] {
  return parts.filter((p) => isInlineImage(p.mimeType)).map((p) => ({ path: attachmentPath(convId, p), mimeType: p.mimeType }));
}

export { isInlineImage };
