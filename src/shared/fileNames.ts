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
