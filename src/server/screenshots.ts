// Screenshots for a problem report (the sidebar's "Report a problem"): a mail link cannot carry files,
// so the images the user added in the dialog go up to GitHub as one secret gist, with the user's own
// GitHub CLI (`gh`), as a shared conversation's files do (share.ts), and the mail links to it. Nothing
// goes up until the user presses Upload in the dialog.

import { REPORT_SCREENSHOT_LIMITS, type ReportScreenshots } from '../shared/types';
import { HttpError } from './errors';
import { t } from './i18n';
import { runProcess, type SpawnOptions, type SpawnResult } from './process';
import { filesToGist, gistPage, type FilesGistWords, type GistUpload, type ShareOptions } from './share';

/** The gist's description (and so its files gist's: filesGistDescription adds a token to find it by). */
export const SCREENSHOTS_DESCRIPTION = 'Harness Relay problem report · screenshots';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An image's kind by its first bytes, as its file extension; undefined for anything else. */
export function imageKind(data: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | undefined {
  if (data.subarray(0, 8).equals(PNG)) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  const head = data.subarray(0, 12).toString('latin1');
  if (/^GIF8[79]a/.test(head)) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  return undefined;
}

/** Base64 as a browser's FileReader writes it: nothing else, so nothing is dropped as it is decoded. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The longest base64 text of a screenshot of the largest size allowed. */
const BASE64_MAX = Math.ceil(REPORT_SCREENSHOT_LIMITS.maxBytes / 3) * 4;

/**
 * The screenshots a request sends (`[{ data }]`, each base64), named in their gist by their place and
 * kind (`screenshot-1.png`…): never by the name the file had, which could say more than the image.
 * Throws an HttpError for none, too many, too large, or one that is not a PNG, JPEG, GIF or WebP image.
 */
export function parseScreenshots(v: unknown): GistUpload[] {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, t().reportShotsNone);
  const { maxFiles, maxBytes } = REPORT_SCREENSHOT_LIMITS;
  if (v.length > maxFiles) throw new HttpError(413, t().reportShotsTooMany(maxFiles));
  return v.map((item, i) => {
    const data = (item as { data?: unknown } | null)?.data;
    if (typeof data !== 'string' || !BASE64.test(data)) throw new HttpError(400, t().reportShotNotImage(i + 1));
    if (data.length > BASE64_MAX) throw new HttpError(413, t().reportShotTooLarge(i + 1, maxBytes / 1024 / 1024));
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > maxBytes) throw new HttpError(413, t().reportShotTooLarge(i + 1, maxBytes / 1024 / 1024));
    const kind = imageKind(bytes);
    if (!kind) throw new HttpError(400, t().reportShotNotImage(i + 1));
    return { name: `screenshot-${i + 1}.${kind}`, data: bytes };
  });
}

/** What the user is told when the screenshots cannot go up (in the request's language, so made per call). */
const reportWords = (): FilesGistWords => ({
  undone: t().reportShotsUndone,
  leftover: t().reportShotsLeftover,
  unknown: t().reportShotsUnknown,
  notGithub: t().reportShotsNotGithub,
});

/**
 * Puts the screenshots on GitHub, one secret gist of them alone (filesToGist), and gives its page there,
 * which shows them: the link the mail carries. `run` spawns `gh` and `git` (fakes in tests).
 */
export async function uploadScreenshots(
  files: GistUpload[],
  run: (o: SpawnOptions) => Promise<SpawnResult> = runProcess,
  o: ShareOptions = {},
): Promise<ReportScreenshots> {
  const { gist } = await filesToGist(SCREENSHOTS_DESCRIPTION, files, run, o, reportWords());
  return { id: gist.id, url: gistPage(gist.id, gist.url) };
}
