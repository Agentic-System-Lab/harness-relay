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

/**
 * The image without what it says besides its pixels: the EXIF data (a phone photo's location, the
 * camera, the time), XMP, IPTC and comments of a JPEG; the EXIF, text and time chunks of a PNG; the
 * EXIF and XMP chunks of a WebP. A GIF holds none of those. An image whose structure cannot be read
 * through is given as it is: it was checked to be an image by its first bytes, and its pixels decide.
 */
export function withoutMetadata(data: Buffer, kind: 'png' | 'jpg' | 'gif' | 'webp'): Buffer {
  try {
    if (kind === 'jpg') return jpegWithout(data);
    if (kind === 'png') return pngWithout(data);
    if (kind === 'webp') return webpWithout(data);
  } catch {
    /* not what it should be: as it is */
  }
  return data;
}

/** A JPEG's APP1 (EXIF, XMP), APP13 (IPTC) and COM segments go; the rest, from the scan on, stays as it is. */
function jpegWithout(data: Buffer): Buffer {
  const out: Buffer[] = [data.subarray(0, 2)];
  let at = 2;
  while (at < data.length) {
    if (data[at] !== 0xff) throw new Error('not a marker');
    let marker = data[at + 1]!;
    // Fill bytes before a marker.
    while (marker === 0xff) marker = data[++at + 1]!;
    // Start of scan: the image data, to the end.
    if (marker === 0xda) {
      out.push(data.subarray(at));
      return Buffer.concat(out);
    }
    const length = data.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > data.length) throw new Error('bad segment');
    const end = at + 2 + length;
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) out.push(data.subarray(at, end));
    at = end;
  }
  throw new Error('no scan');
}

const PNG_DROPPED = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

/** A PNG's eXIf, tEXt, zTXt, iTXt and tIME chunks go. */
function pngWithout(data: Buffer): Buffer {
  const out: Buffer[] = [data.subarray(0, 8)];
  let at = 8;
  while (at < data.length) {
    const length = data.readUInt32BE(at);
    const type = data.subarray(at + 4, at + 8).toString('latin1');
    const end = at + 12 + length;
    if (end > data.length) throw new Error('bad chunk');
    if (!PNG_DROPPED.has(type)) out.push(data.subarray(at, end));
    at = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  throw new Error('no IEND');
}

/** A WebP's EXIF and XMP chunks go, with their flags in its VP8X chunk, and its size is set again. */
function webpWithout(data: Buffer): Buffer {
  const out: Buffer[] = [];
  let at = 12;
  while (at < data.length) {
    const type = data.subarray(at, at + 4).toString('latin1');
    const size = data.readUInt32LE(at + 4);
    const end = at + 8 + size + (size % 2);
    if (end > data.length) throw new Error('bad chunk');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = Buffer.from(data.subarray(at, end));
      // VP8X flags: EXIF 0x08, XMP 0x04.
      if (type === 'VP8X') chunk[8] = chunk[8]! & ~0x0c;
      out.push(chunk);
    }
    at = end;
  }
  const body = Buffer.concat(out);
  const head = Buffer.from(data.subarray(0, 12));
  head.writeUInt32LE(4 + body.length, 4);
  return Buffer.concat([head, body]);
}

/** Base64 as a browser's FileReader writes it: nothing else, so nothing is dropped as it is decoded. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The longest base64 text of a screenshot of the largest size allowed. */
const BASE64_MAX = Math.ceil(REPORT_SCREENSHOT_LIMITS.maxBytes / 3) * 4;

/**
 * The screenshots a request sends (`[{ data }]`, each base64), named in their gist by their place and
 * kind (`screenshot-1.png`…): never by the name the file had, which could say more than the image; and
 * for the same reason without their metadata (`withoutMetadata`: a photo's location, say).
 * Throws an HttpError for none, too many, too large, or one that is not a PNG, JPEG, GIF or WebP image.
 */
export function parseScreenshots(v: unknown): GistUpload[] {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, t().reportShotsNone);
  const { maxFiles, maxBytes } = REPORT_SCREENSHOT_LIMITS;
  if (v.length > maxFiles) throw new HttpError(413, t().reportShotsTooMany(maxFiles));
  return v.map((item, i) => {
    const data = (item as { data?: unknown } | null)?.data;
    if (typeof data !== 'string') throw new HttpError(400, t().reportShotNotImage(i + 1));
    // Measured before it is read any further.
    if (data.length > BASE64_MAX) throw new HttpError(413, t().reportShotTooLarge(i + 1, maxBytes / 1024 / 1024));
    if (!BASE64.test(data)) throw new HttpError(400, t().reportShotNotImage(i + 1));
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > maxBytes) throw new HttpError(413, t().reportShotTooLarge(i + 1, maxBytes / 1024 / 1024));
    const kind = imageKind(bytes);
    if (!kind) throw new HttpError(400, t().reportShotNotImage(i + 1));
    return { name: `screenshot-${i + 1}.${kind}`, data: withoutMetadata(bytes, kind) };
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
  // Only the gist's page is linked to: its files' raw URLs are not read back.
  const { gist } = await filesToGist(SCREENSHOTS_DESCRIPTION, files, run, { ...o, readBack: false }, reportWords());
  return { id: gist.id, url: gistPage(gist.id, gist.url) };
}
