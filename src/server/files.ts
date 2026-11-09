import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { FILE_LIMITS, type Conversation, type FileEntry, type FilePreview, type FileRoot } from '../shared/types';
import { mediaType } from '../shared/media';
import { HttpError } from './errors';
import { t } from './i18n';
import { worktreeDir } from './workspace';

/*
 * Browsing a conversation's files from the UI: the working directory, and in parallel mode each
 * agent's worktree. Only what lies inside the chosen folder (after following symlinks) is listed or
 * read, and `.git` folders are left out.
 */

/** The folders of a conversation that can be browsed: its working directory, then agents' worktrees. */
export function fileRoots(conv: Conversation): FileRoot[] {
  const roots: FileRoot[] = [{ id: 'cwd', path: conv.settings.cwd }];
  for (const a of conv.agents) {
    const wt = conv.worktrees[a.id];
    if (!wt) continue;
    try {
      const dir = worktreeDir(wt.root, conv.settings.cwd, wt.path);
      if (existsSync(dir)) roots.push({ id: a.id, path: dir, agentId: a.id });
    } catch {
      /* not a usable worktree */
    }
  }
  return roots;
}

/** `path` relative to `root` with `/`, or undefined when it is not inside it ('' = the root itself). */
function within(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * Whether a name is `.git`, in any letter case: on a case-insensitive filesystem (macOS, Windows)
 * `.GIT/config` opens `.git/config`, and `realpathSync` keeps the case it was asked with.
 */
const isGit = (name: string) => name.toLowerCase() === '.git';

const hidden = (rel: string) => rel.split('/').some(isGit);

/** A path as the client asked for it, tidied up ('' = the root); a link in it is not followed here. */
function askedPath(rel: string): string {
  const p = posix.normalize(rel.replace(/\\/g, '/').replace(/^\/+/, '') || '.').replace(/\/+$/, '');
  return p === '.' ? '' : p;
}

/** The real path `rel` names inside `root`, and its path relative to the root; 404 otherwise. */
export function resolveInRoot(root: string, rel: string): { real: string; rel: string } {
  const notFound = () => new HttpError(404, t().fileNotFound);
  if (rel.includes('\0')) throw notFound();
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new HttpError(404, t().fileRootNotFound);
  }
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (isAbsolute(clean) || /^[A-Za-z]:/.test(clean)) throw notFound();
  let real: string;
  try {
    real = realpathSync(resolve(realRoot, clean));
  } catch {
    throw notFound();
  }
  const inside = within(realRoot, real);
  if (inside === undefined || hidden(inside)) throw notFound();
  return { real, rel: inside };
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * The entries of a folder inside `root`: folders first, then by name; the first ones when there are
 * too many. Links that lead outside are left out. `path` is the folder as asked for (through a link too).
 */
export function listFolder(root: string, rel: string): { path: string; entries: FileEntry[]; truncated: boolean } {
  const dir = resolveInRoot(root, rel);
  if (!statSync(dir.real).isDirectory()) throw new HttpError(404, t().fileNotFound);
  const realRoot = realpathSync(root);
  // Sort the names first (a link to a folder counts as a file here), so a cut keeps the first ones.
  const all = readdirSync(dir.real, { withFileTypes: true })
    .filter((d) => !isGit(d.name))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? byName(a.name, b.name) : a.isDirectory() ? -1 : 1));
  const truncated = all.length > FILE_LIMITS.maxEntries;
  const entries: FileEntry[] = [];
  for (const d of all.slice(0, FILE_LIMITS.maxEntries)) {
    const full = join(dir.real, d.name);
    try {
      let target = full;
      if (d.isSymbolicLink()) {
        target = realpathSync(full);
        const inside = within(realRoot, target);
        if (inside === undefined || hidden(inside)) continue;
      }
      const st = statSync(target);
      if (!st.isDirectory() && !st.isFile()) continue;
      entries.push({
        name: d.name,
        kind: st.isDirectory() ? 'dir' : 'file',
        size: st.isDirectory() ? 0 : st.size,
        mtime: Math.floor(st.mtimeMs),
        ...(d.isSymbolicLink() ? { link: true } : {}),
      });
    } catch {
      /* gone, or a broken link */
    }
  }
  entries.sort((a, b) => (a.kind === b.kind ? byName(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
  return { path: askedPath(rel), entries, truncated };
}

/** What the UI shows for a file: its text (the beginning of a long one), or that it is an image, a video or binary. */
export function previewFile(root: string, rel: string): FilePreview {
  return readPreview(resolveInRoot(root, rel).real, askedPath(rel));
}

/**
 * The preview of the file at `real`, shown under `path`. The caller has checked that it may be read;
 * a missing file, or anything but a file, is a 404.
 */
export function readPreview(real: string, path: string, notFound = t().fileNotFound): FilePreview {
  let st;
  try {
    st = statSync(real);
  } catch {
    throw new HttpError(404, notFound);
  }
  if (!st.isFile()) throw new HttpError(404, notFound);
  const file = { real };
  const base = { path, size: st.size, mtime: Math.floor(st.mtimeMs) };
  const media = mediaType(file.real);
  if (media) return { ...base, kind: media.startsWith('video/') ? 'video' : 'image' };
  const length = Math.min(st.size, FILE_LIMITS.maxPreviewBytes);
  const buf = Buffer.alloc(length);
  const fd = openSync(file.real, 'r');
  try {
    readSync(fd, buf, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  if (buf.subarray(0, 8000).includes(0)) return { ...base, kind: 'binary' };
  let text = new TextDecoder('utf-8').decode(buf);
  const truncated = st.size > length;
  if (truncated) text = text.replace(/�+$/, ''); // a character cut in half at the end
  return { ...base, kind: 'text', text, ...(truncated ? { truncated: true } : {}) };
}

/** The real path of a file inside `root`, for downloading it; 404 for a folder or anything outside. */
export function fileInRoot(root: string, rel: string): string {
  const file = resolveInRoot(root, rel);
  if (!statSync(file.real).isFile()) throw new HttpError(404, t().fileNotFound);
  return file.real;
}

/** The real path of an image or video inside `root`, for serving it; 404 for anything else. */
export function mediaInRoot(root: string, rel: string): string {
  const file = fileInRoot(root, rel);
  if (!mediaType(file)) throw new HttpError(404, t().fileNotFound);
  return file;
}
