import type { FileNameProblem } from './types';
// The names the Files panel gives a new or uploaded file, checked alike by the server and the page.

/** Why a name cannot be a file's name, as `fileNameProblem` tells it. */

/** The most UTF-8 bytes a name may take: what macOS, Linux and Windows file systems all allow. */
export const MAX_FILE_NAME_BYTES = 255;

/**
 * Whether `text` holds half of a UTF-16 surrogate pair alone, which no UTF-8 file can hold (JSON can
 * carry one, as `\ud800`). `String.prototype.isWellFormed` is newer than the libraries this targets.
 */
export function hasLoneSurrogate(text: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
}

/** Names Windows keeps for its devices, with any extension (`nul.txt` too). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i;

/**
 * Why `name` cannot be a file's name in a working directory, or undefined when it can. The same on
 * every system, so that a folder stays usable wherever it is copied or synced: no path separator, not
 * `.` or `..`, no control character, none of the characters Windows refuses (`<>:"|?*`), no trailing dot
 * or space (Windows drops them), no Windows device name (`CON`, `nul.txt`), not `.git` in any letter
 * case, and at most 255 bytes.
 */
export function fileNameProblem(name: string): FileNameProblem | undefined {
  if (!name.trim()) return 'empty';
  if (/[\\/]/.test(name)) return 'separator';
  if (name === '.' || name === '..') return 'dots';
  if (/[\u0000-\u001f\u007f]/.test(name) || hasLoneSurrogate(name)) return 'control';
  if (name.toLowerCase().replace(/[. ]+$/, '') === '.git') return 'git';
  if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name) || WINDOWS_DEVICE.test(name)) return 'reserved';
  if (new TextEncoder().encode(name).length > MAX_FILE_NAME_BYTES) return 'tooLong';
  return undefined;
}

/** Whether `name` is one Windows keeps for a device (`CON`, `nul.txt`), which no file there can have. */
export function isWindowsDevice(name: string): boolean {
  return WINDOWS_DEVICE.test(name);
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/**
 * `name` cut to at most `max` UTF-8 bytes, at the end of a character, keeping its extension (when that
 * takes 16 bytes or fewer): what Linux allows a name, where macOS and Windows count characters.
 */
export function cutName(name: string, max = MAX_FILE_NAME_BYTES): string {
  if (utf8Length(name) <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && utf8Length(name.slice(dot)) <= 16 ? name.slice(dot) : '';
  let stem = '';
  let bytes = utf8Length(ext);
  for (const ch of ext ? name.slice(0, dot) : name) {
    const n = utf8Length(ch);
    if (bytes + n > max) break;
    stem += ch;
    bytes += n;
  }
  return stem + ext;
}

/** A path as a file system that ignores letter case and Unicode form (macOS, Windows) compares it. */
const pathKey = (path: string) => path.normalize('NFC').toLowerCase();

/**
 * The first of `paths` (in a folder, with `/`) that one before it already takes on such a file
 * system: the same path but for letter case or Unicode form, a file where another path has a folder,
 * or a folder where another has a file. Undefined when none does.
 */
export function pathClash(paths: Iterable<string>): string | undefined {
  /** Each file's key, and each folder's with a `/` after it. */
  const taken = new Set<string>();
  for (const path of paths) {
    const key = pathKey(path);
    const folders = key.split('/').slice(0, -1);
    const prefixes = folders.map((_, i) => folders.slice(0, i + 1).join('/'));
    if (taken.has(key) || taken.has(`${key}/`) || prefixes.some((p) => taken.has(p))) return path;
    taken.add(key);
    for (const p of prefixes) taken.add(`${p}/`);
  }
  return undefined;
}
