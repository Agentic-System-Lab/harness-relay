import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { FILE_LIMITS, cwdsOf, type Conversation, type FileEntry, type FilePreview, type FileRoot, type ZipSize } from '../shared/types';
import { mediaType } from '../shared/media';
import { fileKey, withheldFileKeys } from './db';
import { HttpError } from './errors';
import { t } from './i18n';
import { unignoredFiles, worktreeDir } from './workspace';
import type { ZipEntry } from './zip';

/*
 * Browsing a conversation's files from the UI: the working directory, and in parallel mode each
 * agent's worktree. Only what lies inside the chosen folder (after following symlinks) is listed or
 * read, and `.git` folders are left out, as are the files the server withholds (`withheldFileKeys`):
 * those it holds SQLite locks on (its database and its data folder's lock), which opening would
 * drop, and the key its secrets are encrypted with.
 */

/**
 * The folders of a conversation that can be browsed: its working directories, then each agent's
 * worktrees of them (see `FileRoot.id`).
 */
export function fileRoots(conv: Conversation): FileRoot[] {
  const cwds = cwdsOf(conv.settings);
  const key = (base: string, i: number) => (i ? `${base}:${i}` : base);
  const roots: FileRoot[] = cwds.map((path, i) => ({ id: key('cwd', i), path, ...(i ? { cwd: i } : {}) }));
  for (const a of conv.agents) {
    cwds.forEach((cwd, i) => {
      // The worktree of the repository the folder is in: the innermost, when one is inside another.
      const wt = (conv.worktrees[a.id] ?? [])
        .filter((w) => inRepo(w.root, cwd))
        .sort((x, y) => y.root.length - x.root.length)[0];
      if (!wt) return;
      try {
        const dir = worktreeDir(wt.root, cwd, wt.path);
        if (existsSync(dir)) roots.push({ id: key(a.id, i), path: dir, agentId: a.id, ...(i ? { cwd: i } : {}) });
      } catch {
        /* not a usable worktree */
      }
    });
  }
  return roots;
}

/** `cwd` is in the repository at `root` (the root or inside it, links resolved on both). */
function inRepo(root: string, cwd: string): boolean {
  try {
    return within(realpathSync(root), realpathSync(cwd)) !== undefined;
  } catch {
    return false;
  }
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
 * `.GIT/config` opens `.git/config`, and `realpathSync` keeps the case it was asked with. Windows also
 * drops a trailing dot or space, so `.git.` opens `.git` there.
 */
const isGit = (name: string) => name.toLowerCase().replace(/[. ]+$/, '') === '.git';

const hidden = (rel: string) => rel.split('/').some(isGit);

/**
 * On Windows a short name (`GIT~1`) opens `.git` as well, and `realpathSync` keeps it: the system's own
 * real path spells it out. Whether that path is outside `realRoot`, or in `.git`.
 */
function hiddenNatively(realRoot: string, real: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const rel = within(realpathSync.native(realRoot), realpathSync.native(real));
    return rel === undefined || hidden(rel);
  } catch {
    return true;
  }
}

/** Whether `real` is one of the files this server withholds (`withheldFileKeys`), which it must never open itself. */
function withheldHere(real: string, locked = withheldFileKeys()): boolean {
  try {
    return locked.has(fileKey(statSync(real)));
  } catch {
    return false;
  }
}

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
  if (inside === undefined || hidden(inside) || hiddenNatively(realRoot, real) || withheldHere(real)) throw notFound();
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
  const locked = withheldFileKeys();
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
      if ((!st.isDirectory() && !st.isFile()) || locked.has(fileKey(st))) continue;
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
  if (!st.isFile() || withheldFileKeys().has(fileKey(st))) throw new HttpError(404, notFound);
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

/** A folder to download as a ZIP file: its name, and what goes in it (inside a folder of that name). */
export interface ZipPlan extends ZipSize {
  name: string;
  entries: ZipEntry[];
}

/** How much a ZIP file may hold: files and folders together, and bytes before compression (FILE_LIMITS; smaller in tests). */
export type ZipLimits = { items: number; bytes: number };

/** How deep repositories inside repositories are followed when taking only what git does not ignore. */
const MAX_NESTED_REPOS = 8;

/**
 * What a folder inside `root` holds, to download as a ZIP file: every file and folder under it, as the
 * browser lists them (no `.git`, links only to what is inside `root`, each folder once), or with
 * `unignored` only the files git does not ignore — in repositories inside it and submodules too (the
 * whole folder when it is in no repository). The entries sit in a folder named after it (`name` for a
 * root, which has no name of its own to show). Null as soon as it is more than `limits` allows. Reads
 * the disk without blocking the server.
 */
export async function zipPlan(
  root: string,
  rel: string,
  opts: { unignored?: boolean; limits?: ZipLimits; name?: string } = {},
): Promise<ZipPlan | null> {
  // FILE_LIMITS read on each call, so that a test of the routes can lower them.
  const limits = opts.limits ?? { items: FILE_LIMITS.zipItems, bytes: FILE_LIMITS.zipBytes };
  const dir = resolveInRoot(root, rel);
  const self = await stat(dir.real);
  if (!self.isDirectory()) throw new HttpError(404, t().fileNotFound);
  // Real paths as the entries' below are (`realpath`, the system's own): `realpathSync` keeps the
  // letter case a path was asked with (macOS, Windows) and Windows' short names (`RUNNER~1`), and a
  // folder asked for so would seem to hold nothing of its own.
  const realRoot = await realpath(root);
  const start = await realpath(dir.real);
  const top = askedPath(rel).split('/').pop() || opts.name || basename(realRoot) || 'files';
  const plan: ZipPlan = { name: top, entries: [{ name: `${top}/`, mtime: self.mtimeMs, mode: self.mode }], files: 0, bytes: 0 };
  /** Files and folders so far: what keeps a tree of empty folders from going on and on. */
  let items = 1;
  /** Every folder once: a link to a folder already in the archive (or around it) is left out. */
  const seen = new Set([start]);
  const locked = withheldFileKeys();

  /** The real path of `full` when it may go in (inside the root, not in `.git`), else undefined. */
  const allowed = async (full: string): Promise<string | undefined> => {
    try {
      const real = await realpath(full);
      const inside = within(realRoot, real);
      return inside === undefined || hidden(inside) || hiddenNatively(realRoot, real) ? undefined : real;
    } catch {
      return undefined; // gone, or a broken link
    }
  };
  const statOf = async (path: string): Promise<Stats | undefined> => {
    try {
      return await stat(path);
    } catch {
      return undefined;
    }
  };
  /** Count an entry in; false once that is too much. */
  const add = (name: string, st: Stats, source?: string): boolean => {
    items++;
    if (source) {
      plan.files++;
      plan.bytes += st.size;
    }
    if (items > limits.items || plan.bytes > limits.bytes) return false;
    plan.entries.push({ name, mtime: st.mtimeMs, mode: st.mode, ...(source ? { source } : {}) });
    return true;
  };

  /**
   * What git does not ignore under `real`, into `prefix`: false once it is too much, null when `real`
   * is in no repository. A folder it lists is a repository of its own (untracked) or a submodule.
   */
  const fromGit = async (real: string, prefix: string, depth: number): Promise<boolean | null> => {
    const listed = await unignoredFiles(real);
    if (listed === null) return null;
    if (listed === 'too-many' || listed.length > limits.items) return false;
    for (const path of listed.sort(byName)) {
      const clean = path.replace(/\/+$/, '');
      if (!clean || clean.split('/').some(isGit)) continue;
      const target = await allowed(join(real, ...clean.split('/')));
      const st = target && (await statOf(target));
      if (!target || !st || locked.has(fileKey(st))) continue;
      if (st.isFile()) {
        if (!add(`${prefix}${clean}`, st, target)) return false;
      } else if (st.isDirectory() && depth < MAX_NESTED_REPOS && !seen.has(target) && existsSync(join(target, '.git'))) {
        seen.add(target);
        if ((await fromGit(target, `${prefix}${clean}/`, depth + 1)) === false) return false;
      }
    }
    return true;
  };

  const walk = async (real: string, prefix: string): Promise<boolean> => {
    let names: string[];
    try {
      names = (await readdir(real)).filter((n) => !isGit(n)).sort(byName);
    } catch {
      return true; // not readable: left out
    }
    for (const n of names) {
      const target = await allowed(join(real, n));
      const st = target && (await statOf(target));
      if (!target || !st || locked.has(fileKey(st))) continue;
      const name = `${prefix}${n}`;
      if (st.isDirectory()) {
        if (seen.has(target)) continue;
        seen.add(target);
        if (!add(`${name}/`, st) || !(await walk(target, `${name}/`))) return false;
      } else if (st.isFile() && !add(name, st, target)) {
        return false;
      }
    }
    return true;
  };

  const git = opts.unignored ? await fromGit(start, `${top}/`, 0) : null;
  if (git !== null) return git ? plan : null;
  return (await walk(start, `${top}/`)) ? plan : null;
}
