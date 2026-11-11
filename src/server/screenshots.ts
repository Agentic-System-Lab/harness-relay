// Screenshots for a problem report (the sidebar's "Report a problem"): a mail link cannot carry files,
// so the images the user added in the dialog go up to GitHub as one secret gist, with the user's own
// GitHub CLI (`gh`), as a shared conversation's files do (share.ts), and the mail links to it. Nothing
// goes up until the user presses Upload in the dialog.

import { crc32 } from 'node:zlib';
import { REPORT_SCREENSHOT_LIMITS, type ReportScreenshots } from '../shared/types';
import { HttpError } from './errors';
import { t } from './i18n';
import { runProcess, type SpawnOptions, type SpawnResult } from './process';
import { filesToGist, gistPage, type FilesGistWords, type GistUpload, type ShareOptions } from './share';

/** The gist's description (and so its files gist's: filesGistDescription adds a token to find it by). */
export const SCREENSHOTS_DESCRIPTION = 'Harness Relay problem report · screenshots';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An image's kind by its first bytes, as its file extension; undefined for anything else. */
export function imageKind(data: Buffer): 'png' | 'jpg' | 'webp' | undefined {
  if (data.subarray(0, 8).equals(PNG)) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  const head = data.subarray(0, 12).toString('latin1');
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  return undefined;
}

/**
 * The image without what it says besides its pixels, or an error when its structure cannot be read
 * through (it is then refused, never uploaded as it is): one cut short after its image began is ended
 * there, as browsers show what there is of it. Only what showing it needs is kept, whatever
 * else a file holds (an allow-list): a photo's location, its camera and time, comments, text, XMP,
 * IPTC, content credentials, thumbnails, a phone's motion-photo video or second image after the image,
 * and bytes after its end, all go. A JPEG or PNG keeps its orientation (a minimal EXIF of that tag
 * alone), so a photo shows the right way up.
 */
export function withoutMetadata(data: Buffer, kind: 'png' | 'jpg' | 'webp'): Buffer {
  if (kind === 'jpg') return jpegWithout(data);
  if (kind === 'png') return pngWithout(data);
  return webpWithout(data);
}

/**
 * What is kept of an image, written as it is found into one buffer about the image's size: ranges of
 * its bytes, and bytes made anew (an end marker, a JFIF header, a minimal EXIF). However many tiny
 * pieces a crafted file is made of, the cost stays one copy of the image, not an object for each.
 */
export class Kept {
  private buf: Buffer;
  private at = 0;

  constructor(private data: Buffer) {
    this.buf = Buffer.allocUnsafe(data.length + 64);
  }

  /** Room for `n` more bytes (what is made anew can, rarely, outgrow what it replaces). */
  private room(n: number): void {
    if (this.at + n <= this.buf.length) return;
    const bigger = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.at + n));
    this.buf.copy(bigger, 0, 0, this.at);
    this.buf = bigger;
  }

  range(start: number, end: number): void {
    if (end <= start) return;
    this.room(end - start);
    this.at += this.data.copy(this.buf, this.at, start, end);
  }

  bytes(made: Buffer): void {
    this.room(made.length);
    this.at += made.copy(this.buf, this.at);
  }

  /** What was kept: only the bytes written (the rest of the buffer is never read). */
  done(): Buffer {
    return this.buf.subarray(0, this.at);
  }
}

/** Reads past the end: the structure is not what it says. */
function need(data: Buffer, end: number): void {
  if (end > data.length) throw new Error('truncated');
}

// --- JPEG ---------------------------------------------------------------------------------

/** Markers a JPEG needs to be shown: frames, tables, restart interval, scan; nothing else. */
const JPEG_KEPT = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xdb, 0xdc, 0xdd, 0xdf]);

/** Whether an APPn segment is one showing the image needs: JFIF (APP0), its ICC profile (APP2), Adobe's colour transform (APP14). */
function jpegAppKept(marker: number, payload: Buffer): boolean {
  const starts = (s: string) => payload.subarray(0, s.length).toString('latin1') === s;
  return (marker === 0xe0 && starts('JFIF\0')) || (marker === 0xe2 && starts('ICC_PROFILE\0')) || (marker === 0xee && starts('Adobe'));
}

/**
 * A JFIF segment of its 14-byte header alone, its thumbnail's size set to 0: a thumbnail can show the
 * image as it was before it was cropped.
 */
function jfifWithoutThumbnail(payload: Buffer): Buffer {
  if (payload.length < 14) throw new Error('short JFIF');
  const header = Buffer.from(payload.subarray(0, 14));
  header[12] = 0; // Xthumbnail
  header[13] = 0; // Ythumbnail
  return Buffer.concat([Buffer.from([0xff, 0xe0, 0, 16]), header]);
}

/** The orientation (1 to 8) in an EXIF TIFF structure's first IFD; undefined when it has none or cannot be read. */
export function tiffOrientation(tiff: Buffer): number | undefined {
  try {
    const order = tiff.subarray(0, 2).toString('latin1');
    if (order !== 'II' && order !== 'MM') return undefined;
    const u16 = (at: number) => (order === 'II' ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
    const u32 = (at: number) => (order === 'II' ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
    const ifd = u32(4);
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      // Orientation: SHORT, one value.
      if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : undefined;
      }
    }
  } catch {
    /* not what it says: no orientation */
  }
  return undefined;
}

/** A JPEG's EXIF orientation (1 to 8), from its APP1 payload; undefined when it has none. */
export function exifOrientation(payload: Buffer): number | undefined {
  if (payload.subarray(0, 6).toString('latin1') !== 'Exif\0\0') return undefined;
  return tiffOrientation(payload.subarray(6));
}

/** A minimal EXIF TIFF structure holding the orientation alone. */
function orientationTiff(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22); // no next IFD
  return tiff;
}

/** An APP1 segment of a minimal EXIF holding the orientation alone. */
function orientationSegment(orientation: number): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), orientationTiff(orientation)]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

const JPEG_EOI = Buffer.from([0xff, 0xd9]);

/**
 * A JPEG from its start to its end marker (EOI), with only the segments showing it needs, its scans
 * as they are. Bytes between segments that are no marker are left out (as decoders skip them). One cut
 * short after its first scan began ends there, with an end marker, as browsers show what there is of it.
 */
function jpegWithout(data: Buffer): Buffer {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('no SOI');
  const out = new Kept(data);
  out.range(0, 2);
  let scanned = false;
  /** Its orientation is kept once: a crafted file of many EXIF segments gets one minimal EXIF, not many. */
  let oriented = false;
  /** Cut short: what there is, ended, once a scan began; nothing to show before. */
  const cutShort = () => {
    if (!scanned) throw new Error('truncated');
    out.bytes(JPEG_EOI);
    return out.done();
  };
  let at = 2;
  for (;;) {
    // To the next marker: stray bytes are skipped, fill bytes (FF FF…) too.
    while (at < data.length && data[at] !== 0xff) at++;
    while (at + 1 < data.length && data[at + 1] === 0xff) at++;
    if (at + 2 > data.length) return cutShort();
    const marker = data[at + 1]!;
    if (marker === 0xd9) {
      out.bytes(JPEG_EOI);
      return out.done(); // what follows the image (a motion photo's video, a second image) goes
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0x00) {
      at += 2; // no segment to keep
      continue;
    }
    if (at + 4 > data.length) return cutShort();
    const length = data.readUInt16BE(at + 2);
    if (length < 2) throw new Error('bad segment');
    const end = at + 2 + length;
    if (end > data.length) return cutShort();
    const payload = data.subarray(at + 4, end);
    if (marker === 0xda) {
      // The scan's header, then its entropy-coded data up to the next marker (FF 00 and restarts are data).
      let next = end;
      while (next < data.length) {
        if (data[next] === 0xff) {
          const after = data[next + 1];
          if (after === 0x00 || (after !== undefined && after >= 0xd0 && after <= 0xd7)) {
            next += 2;
            continue;
          }
          break;
        }
        next++;
      }
      out.range(at, Math.min(next, data.length));
      scanned = true;
      at = next;
      continue;
    }
    if (marker === 0xe0 && jpegAppKept(marker, payload)) {
      out.bytes(jfifWithoutThumbnail(payload));
    } else if (JPEG_KEPT.has(marker) || (marker >= 0xe0 && marker <= 0xef && jpegAppKept(marker, payload))) {
      out.range(at, end);
    } else if (marker === 0xe1 && !oriented) {
      const orientation = exifOrientation(payload);
      if (orientation && orientation !== 1) {
        out.bytes(orientationSegment(orientation));
        oriented = true;
      }
    }
    at = end;
  }
}

// --- PNG ----------------------------------------------------------------------------------

/** Chunks a PNG needs to be shown (critical, colour, transparency, animation, HDR): nothing else. */
const PNG_KEPT = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCV', 'cLLI']);

/** A PNG chunk of `type` and `data`, with its CRC. */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A PNG up to its IEND, with only the chunks showing it needs; its EXIF (eXIf) becomes a minimal one of
 * its orientation alone, when it is turned. One cut short after its image data began ends there, with
 * an IEND, as browsers show what there is of it.
 */
function pngWithout(data: Buffer): Buffer {
  const out = new Kept(data);
  out.range(0, 8);
  let pixels = false;
  /** Its orientation is kept once, as a JPEG's is. */
  let oriented = false;
  let at = 8;
  for (;;) {
    if (at + 12 > data.length || at + 12 + data.readUInt32BE(at) > data.length) {
      // Cut short: what there is, ended, once its image data began; nothing to show before.
      if (!pixels) throw new Error('truncated');
      out.bytes(pngChunk('IEND', Buffer.alloc(0)));
      return out.done();
    }
    const length = data.readUInt32BE(at);
    const type = data.subarray(at + 4, at + 8).toString('latin1');
    const end = at + 12 + length;
    if (PNG_KEPT.has(type)) out.range(at, end);
    else if (type === 'eXIf' && !oriented) {
      const orientation = tiffOrientation(data.subarray(at + 8, end - 4));
      if (orientation && orientation !== 1) {
        out.bytes(pngChunk('eXIf', orientationTiff(orientation)));
        oriented = true;
      }
    }
    if (type === 'IDAT' || type === 'fdAT') pixels = true;
    if (type === 'IEND') return out.done(); // what follows it goes
    at = end;
  }
}

// --- WebP ---------------------------------------------------------------------------------

/** Chunks a WebP needs to be shown: its image (lossy, lossless, alpha), animation, ICC profile. */
const WEBP_KEPT = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

/** What an animation frame (ANMF) holds that showing it needs: its image. */
const WEBP_FRAME_KEPT = new Set(['VP8 ', 'VP8L', 'ALPH']);

/**
 * Keeps in `out` the chunks from `at` to `end` that `kept` names, padded as they are (or as `change`
 * makes them); `end` must fall on a chunk's end.
 */
function webpChunks(data: Buffer, at: number, end: number, kept: Set<string>, out: Kept, change?: (type: string, chunk: Buffer) => Buffer | undefined): void {
  while (at < end) {
    need(data, at + 8);
    const type = data.subarray(at, at + 4).toString('latin1');
    const size = data.readUInt32LE(at + 4);
    const next = at + 8 + size + (size % 2);
    if (next > end) throw new Error('bad chunk');
    if (kept.has(type)) {
      const changed = change?.(type, data.subarray(at, next));
      if (changed) out.bytes(changed);
      else out.range(at, next);
    }
    at = next;
  }
}

/** An animation frame without what its image does not need, its size set again. */
function webpFrame(chunk: Buffer): Buffer {
  const size = chunk.readUInt32LE(4);
  // 16 bytes of frame header (position, size, duration, flags), then its own chunks.
  if (size < 16) throw new Error('short frame');
  const inner = new Kept(chunk);
  webpChunks(chunk, 24, 8 + size, WEBP_FRAME_KEPT, inner);
  const body = inner.done();
  const head = Buffer.from(chunk.subarray(0, 24));
  head.writeUInt32LE(16 + body.length, 4);
  return Buffer.concat([head, body]);
}

/** A WebP within its RIFF size, with only the chunks showing it needs; its VP8X flags and size set again. */
function webpWithout(data: Buffer): Buffer {
  need(data, 12);
  const riffEnd = 8 + data.readUInt32LE(4);
  need(data, riffEnd);
  const out = new Kept(data);
  webpChunks(data, 12, riffEnd, WEBP_KEPT, out, (type, chunk) => {
    if (type === 'ANMF') return webpFrame(chunk);
    if (type !== 'VP8X') return undefined;
    // VP8X flags: EXIF 0x08, XMP 0x04 (their chunks are gone).
    const copy = Buffer.from(chunk);
    copy[8] = copy[8]! & ~0x0c;
    return copy;
  });
  const body = out.done();
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
 * Throws an HttpError for none, too many, too large, or one that is not a PNG, JPEG or WebP image.
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
    let clean: Buffer;
    try {
      clean = withoutMetadata(bytes, kind);
    } catch {
      // Its metadata could not be told from its pixels: refused, never uploaded with them.
      throw new HttpError(400, t().reportShotUnreadable(i + 1));
    }
    return { name: `screenshot-${i + 1}.${kind}`, data: clean };
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
