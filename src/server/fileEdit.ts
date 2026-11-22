import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileNameProblem, hasLoneSurrogate } from '../shared/fileNames';
import { FILE_CHANGED, FILE_EDIT_LIMITS, FILE_EXISTS, type FileRoot, type FileWritten } from '../shared/types';
import { fileKey, withheldFileKeys } from './db';
import { HttpError } from './errors';
import { askedPath, editableText, fileVersion, hiddenNatively, isGit } from './files';
import { t } from './i18n';
import {
  agentFolderOverlap,
  appBrowserDirs,
  browserDataDirs,
  cliFolder,
  codespaceSecretDirs,
  realPath,
  relayDatabaseFiles,
  relayFolderOverlap,
  voiceFolder,
  type AgentFolderOptions,
} from './protect';
import { DATA_DIR } from './settings';

/*
 * Changing files from the Files panel: a text file edited and saved, a new file, a file uploaded into a
 * folder. Only in a conversation's working directories (never an agent's worktree), and only in one
 * where agents could work in edit mode (`rootReadOnly`); only what browsing shows (no `.git`, nothing
 * the server withholds), never through a link, never into what Harness Relay protects. A write replaces
 * the file at once (a temporary file beside it, renamed over it), keeping its permission bits; the
 * route refuses it while a run may be writing in that folder (`Orchestrator.writingIn()`), so that each
 * turn's changes stay its own. Everything here is synchronous: nothing else in the server runs between
 * that check and the write.
 */

const notFound = () => new HttpError(404, t().fileNotFound);

/**
 * Why the Files panel may not change files in `root`, or undefined when it may: an agent's worktree
 * (parallel mode's, or the team's own: what the user applies, not edits), or a working directory where
 * edit mode is refused (it holds Harness Relay, its data or voice input's folder, the home folder, or
 * what decides how the agents run: `relayFolderOverlap`, `agentFolderOverlap`).
 */
export function rootReadOnly(root: FileRoot, agents: AgentFolderOptions): string | undefined {
  if (root.agentId) return t().filesEdit.worktreeReadOnly;
  if (relayFolderOverlap(root.path)) return t().filesEdit.relayFolder;
  const folder = agentFolderOverlap(root.path, agents);
  if (folder) return t().filesEdit.agentFolder(folder);
  return undefined;
}

/**
 * What no write from the Files panel may reach, wherever a working directory is: Harness Relay's data
 * folder (its database, temporary folder and browsers' profiles), the secrets' key wherever it is, voice
 * input's folder and the CLIs it installed, the browsers' own folders and, in a codespace, its token files.
 */
function protectedTargets(): string[] {
  return [
    DATA_DIR,
    ...relayDatabaseFiles(),
    voiceFolder(),
    cliFolder(),
    ...browserDataDirs(),
    ...appBrowserDirs(),
    ...codespaceSecretDirs(),
  ].map(realPath);
}

/** Whether `path` (a real path) is one of `dirs` or inside one. */
function insideAny(path: string, dirs: string[]): boolean {
  return dirs.some((dir) => {
    const rel = relative(dir, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/** The real path of a root to write in; 404 when it is gone. */
function realRootOf(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    throw new HttpError(404, t().fileRootNotFound);
  }
}

/** A folder inside the root, opened for writing: its parts from the root, real path and identity. */
interface Folder {
  parts: string[];
  path: string;
  key: string;
}

/**
 * The folder `parts` name inside `realRoot`, each part a real folder: none a link (403), none `.git`
 * nor missing (404, as browsing has it), and on Windows none with a `:` (a drive or a file's alternate
 * stream) nor a short name for `.git`.
 */
function openFolder(realRoot: string, parts: string[]): Folder {
  let at = realRoot;
  for (const part of parts) {
    if (part === '..' || isGit(part) || (process.platform === 'win32' && part.includes(':'))) throw notFound();
    at = join(at, part);
    let st: BigIntStats;
    try {
      st = lstatSync(at, { bigint: true });
    } catch {
      throw notFound();
    }
    if (st.isSymbolicLink()) throw new HttpError(403, t().filesEdit.link);
    if (!st.isDirectory()) throw notFound();
  }
  if (hiddenNatively(realRoot, at)) throw notFound();
  return { parts, path: at, key: fileKey(lstatSync(at, { bigint: true })) };
}

/** A file to write in a folder: where it goes, and what is there now (a regular file, or nothing). */
interface Target {
  folder: Folder;
  name: string;
  full: string;
  /** The path relative to the root, with `/`. */
  rel: string;
  existing?: BigIntStats;
}

/**
 * The file `name` in `folder`, checked: not a link (403), not a folder or anything else but a file
 * (409 / 404), not a file the server withholds (404), nothing Harness Relay protects (403), not
 * read-only (403).
 */
function targetIn(realRoot: string, folder: Folder, name: string): Target {
  if (isGit(name) || (process.platform === 'win32' && name.includes(':'))) throw notFound();
  const full = join(folder.path, name);
  const rel = [...folder.parts, name].join('/');
  if (insideAny(realPath(full), protectedTargets())) throw new HttpError(403, t().filesEdit.protectedPath);
  let existing: BigIntStats | undefined;
  try {
    existing = lstatSync(full, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw notFound();
  }
  if (existing) {
    if (existing.isSymbolicLink()) throw new HttpError(403, t().filesEdit.link);
    if (existing.isDirectory()) throw new HttpError(409, t().filesEdit.isFolder(name));
    if (!existing.isFile() || withheldFileKeys().has(fileKey(existing)) || hiddenNatively(realRoot, full)) throw notFound();
    if (!(Number(existing.mode) & 0o200)) throw new HttpError(403, t().filesEdit.readOnlyFile(name));
  }
  return { folder, name, full, rel, ...(existing ? { existing } : {}) };
}

/** The folder and the name a path inside the root names: '' and `..` name no file. */
function splitPath(rel: unknown): { parts: string[]; name: string } {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new HttpError(400, t().invalidField('path'));
  const clean = askedPath(rel);
  if (/^[A-Za-z]:/.test(clean)) throw notFound();
  const parts = clean.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name || name === '..') throw notFound();
  return { parts, name };
}

/** What a name's problem is called, for the user. */
function nameRefusal(name: string): HttpError | undefined {
  const problem = fileNameProblem(name);
  return problem ? new HttpError(400, t().filesEdit.badName(name, problem)) : undefined;
}

/**
 * The bytes of a regular file as they are now, read without following a link, when it is no more than
 * an editable text file may be; null when it is larger, or no longer the file `st` describes.
 */
function readCurrent(full: string, st: BigIntStats): Buffer | null {
  if (Number(st.size) > FILE_EDIT_LIMITS.maxEditBytes) return null;
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null; // gone, or a link now
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || fileKey(opened) !== fileKey(st) || Number(opened.size) > FILE_EDIT_LIMITS.maxEditBytes) return null;
    const buf = Buffer.alloc(Number(opened.size));
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) return null;
      read += n;
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * The bytes to save for `text` over a file that holds `current`: its line breaks kept (CRLF, when most
 * of them are and the text has none, as a browser's text box gives every line break as LF) and its
 * byte order mark (which the preview leaves out of its text).
 */
export function keepTextFormat(current: Buffer, text: string): Buffer {
  const old = current.toString('utf8');
  const crlf = old.match(/\r\n/g)?.length ?? 0;
  const lf = old.match(/(?<!\r)\n/g)?.length ?? 0;
  const out = crlf > 0 && crlf >= lf && !text.includes('\r') ? text.replace(/\n/g, '\r\n') : text;
  const bytes = Buffer.from(out, 'utf8');
  return current.subarray(0, 3).equals(BOM) && !out.startsWith('\uFEFF') ? Buffer.concat([BOM, bytes]) : bytes;
}

/**
 * Writes `bytes` as `target`'s file at once: into a temporary file beside it, made new (never an
 * existing file or a link), with the file's permission bits (a new file's as the system makes them),
 * then renamed over it, which replaces a name and never writes through one (a hard link elsewhere keeps
 * the old contents). Refused (409) when the folder moved or became a link meanwhile.
 */
function writeAtomically(realRoot: string, target: Target, bytes: Uint8Array): FileWritten {
  const { folder, existing } = target;
  const tmp = join(folder.path, `.relay-${randomBytes(6).toString('hex')}.tmp`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, flags, existing ? 0o600 : 0o666);
    writeFileSync(fd, bytes);
    if (existing) fchmodSync(fd, Number(existing.mode) & 0o777);
    fsyncSync(fd);
    const written = fileKey(fstatSync(fd, { bigint: true }));
    closeSync(fd);
    fd = undefined;
    // Nothing moved meanwhile: the folder is the one checked, reached through no link, and the
    // temporary file the one written.
    const again = openFolder(realRoot, folder.parts);
    if (again.key !== folder.key || fileKey(lstatSync(tmp, { bigint: true })) !== written) throw new HttpError(409, t().filesEdit.moved);
    renameSync(tmp, target.full);
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* not made, or renamed already */
    }
    if (err instanceof HttpError) throw err;
    // EBUSY or EPERM on Windows: another program has the file open and does not share it.
    throw new HttpError(409, t().filesEdit.cannotWrite(target.name, (err as NodeJS.ErrnoException).code ?? (err as Error).message));
  }
  const st = lstatSync(target.full, { bigint: true });
  return { path: target.rel, size: Number(st.size), mtime: Number(st.mtimeMs), version: fileVersion(bytes) };
}

/**
 * Saves `text` as the file `rel` names in `root`: over the file as it was loaded (`version`, from its
 * preview; 409 `FILE_CHANGED` when it is not the same any more, or gone), or as a new file (`version`
 * null; 409 `FILE_EXISTS` when one is there), keeping its line breaks and byte order mark. Text only: no
 * NUL, no lone surrogate, at most `FILE_EDIT_LIMITS.maxEditBytes` (413).
 */
export function saveText(root: string, rel: unknown, text: unknown, version: unknown): FileWritten {
  if (typeof text !== 'string') throw new HttpError(400, t().invalidField('text'));
  if (version !== null && typeof version !== 'string') throw new HttpError(400, t().invalidField('version'));
  if (text.includes('\0') || hasLoneSurrogate(text)) throw new HttpError(400, t().filesEdit.notText);
  const tooLarge = () => new HttpError(413, t().filesEdit.textTooLarge(FILE_EDIT_LIMITS.maxEditBytes / 1024));
  if (Buffer.byteLength(text, 'utf8') > FILE_EDIT_LIMITS.maxEditBytes) throw tooLarge();
  const { parts, name } = splitPath(rel);
  const bad = version === null && nameRefusal(name);
  if (bad) throw bad;
  const realRoot = realRootOf(root);
  const folder = openFolder(realRoot, parts);
  const target = targetIn(realRoot, folder, name);
  let bytes: Buffer;
  if (version === null) {
    if (target.existing) throw new HttpError(409, t().filesEdit.exists(name), FILE_EXISTS, [target.rel]);
    bytes = Buffer.from(text, 'utf8');
  } else {
    const current = target.existing ? readCurrent(target.full, target.existing) : null;
    if (!current || !editableText(current) || fileVersion(current) !== version) {
      throw new HttpError(409, target.existing ? t().filesEdit.changed(name) : t().filesEdit.gone(name), FILE_CHANGED);
    }
    bytes = keepTextFormat(current, text);
  }
  if (bytes.length > FILE_EDIT_LIMITS.maxEditBytes) throw tooLarge();
  return writeAtomically(realRoot, target, bytes);
}

/**
 * Writes an uploaded file (`data`, base64) into the folder `dir` names in `root`, as `name`: a name
 * any system takes (`fileNameProblem`, 400), at most `FILE_EDIT_LIMITS.maxUploadBytes` (413). A file of
 * that name is replaced only with `replace`, which the user agreed to (409 `FILE_EXISTS` otherwise).
 */
export function uploadFile(root: string, dir: unknown, name: unknown, data: unknown, replace: boolean): FileWritten {
  if (typeof name !== 'string') throw new HttpError(400, t().invalidField('name'));
  if (typeof data !== 'string') throw new HttpError(400, t().invalidField('data'));
  if (typeof dir !== 'string' || dir.includes('\0')) throw new HttpError(400, t().invalidField('dir'));
  const bad = nameRefusal(name);
  if (bad) throw bad;
  const max = FILE_EDIT_LIMITS.maxUploadBytes;
  const tooLarge = () => new HttpError(413, t().filesEdit.uploadTooLarge(name, max / 1024 / 1024));
  // Base64 takes 4 characters for 3 bytes: the length tells before anything is decoded.
  if (data.length > Math.ceil(max / 3) * 4 + 4) throw tooLarge();
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > max) throw tooLarge();
  const clean = askedPath(dir);
  if (/^[A-Za-z]:/.test(clean)) throw notFound();
  const realRoot = realRootOf(root);
  const folder = openFolder(realRoot, clean.split('/').filter(Boolean));
  const target = targetIn(realRoot, folder, name);
  if (target.existing && !replace) throw new HttpError(409, t().filesEdit.exists(name), FILE_EXISTS, [target.rel]);
  return writeAtomically(realRoot, target, bytes);
}
