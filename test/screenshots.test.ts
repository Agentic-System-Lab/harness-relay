import { mkdtempSync, rmSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GH_MISSING, REPORT_SCREENSHOT_LIMITS } from '../src/shared/types';
import { HttpError } from '../src/server/errors';
import { t } from '../src/server/i18n';
import { CommandNotFoundError, type SpawnOptions, type SpawnResult } from '../src/server/process';
import { SCREENSHOTS_DESCRIPTION, exifOrientation, imageKind, parseScreenshots, tiffOrientation, uploadScreenshots, withoutMetadata } from '../src/server/screenshots';
import {
  CREATED_JQ,
  FILES_PLACEHOLDER,
  ShareError,
  createGistArgs,
  deleteGistArgs,
  filesGistDescription,
  findGistArgs,
  gistFilesArgs,
} from '../src/server/share';

function result(o: Partial<SpawnResult> = {}): SpawnResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stdoutBytes: Buffer.alloc(0),
    stdoutTruncated: false,
    stdoutSize: 0,
    stderr: '',
    aborted: false,
    timedOut: false,
    ...o,
  };
}

// Small images whole enough to be read through: each kind's structure, with stand-ins for pixels.
const pngChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = pngChunk('IHDR', Buffer.alloc(13));
const IDAT = pngChunk('IDAT', Buffer.from('pixels'));
const IEND = pngChunk('IEND', Buffer.alloc(0));
const PNG = Buffer.concat([PNG_SIG, IHDR, IDAT, IEND]);
const segment = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
/** A JFIF header: version 1.2, no units, density 1×1, no thumbnail (14 bytes). */
const JFIF = segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 0, 0, 1, 0, 1, 0, 0]));
const DQT = segment(0xdb, Buffer.from([0, 1, 2, 3]));
const SOF = segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]));
const DHT = segment(0xc4, Buffer.from([0, 1, 2]));
/** A scan: its header, then entropy-coded data with a stuffed FF 00 and a restart marker in it. */
const SCAN = Buffer.concat([segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])]);
const JPEG = Buffer.concat([SOI, JFIF, DQT, SOF, DHT, SCAN, EOI]);
const webpChunk = (type: string, data: Buffer) => {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, 'latin1'), size, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const riff = (chunks: Buffer) => {
  const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
  head.writeUInt32LE(4 + chunks.length, 4);
  return Buffer.concat([head, chunks]);
};
const VP8 = webpChunk('VP8 ', Buffer.from('pixels!'));
const WEBP = riff(VP8);
/** A GIF, which is not taken: header, screen descriptor, one image, trailer. */
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x4c\x01\x00\x3b', 'latin1');
const b64 = (b: Buffer) => b.toString('base64');

describe('a screenshot', () => {
  it('is known by its first bytes as a PNG, JPEG or WebP image', () => {
    expect(imageKind(PNG)).toBe('png');
    expect(imageKind(JPEG)).toBe('jpg');
    expect(imageKind(WEBP)).toBe('webp');
  });

  it('is nothing else, whatever it is called', () => {
    for (const b of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      Buffer.from('%PDF-1.7\n'),
      Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'),
      PNG.subarray(0, 7),
      // Not taken: a GIF.
      GIF,
      Buffer.from('GIF87a', 'latin1'),
      Buffer.alloc(0),
    ]) {
      expect(imageKind(b)).toBeUndefined();
    }
  });
});

describe("a screenshot's metadata", () => {
  const gps = Buffer.from('Exif\0\0GPSLatitude 25.03 N GPSLongitude 121.56 E');
  /** An EXIF APP1 payload whose IFD0 holds an orientation (and a stand-in for the rest). */
  const exifWith = (orientation: number, order: 'II' | 'MM' = 'II') => {
    const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4);
    const u16 = (v: number, at: number) => (order === 'II' ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at));
    const u32 = (v: number, at: number) => (order === 'II' ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at));
    tiff.write(order, 0, 'latin1');
    u16(42, 2);
    u32(8, 4);
    u16(2, 8);
    u16(0x010f, 10); // Make: ASCII, a stand-in
    u16(2, 12);
    u32(4, 14);
    tiff.write('GPS', 18, 'latin1');
    u16(0x0112, 22); // Orientation
    u16(3, 24);
    u32(1, 26);
    u16(orientation, 30);
    return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  };

  it("keeps of a JPEG only what showing it needs, its scans as they are, up to its end", () => {
    const icc = segment(0xe2, Buffer.from('ICC_PROFILE\0colors'));
    const adobe = segment(0xee, Buffer.from('Adobe\0\x64'));
    const jpeg = Buffer.concat([
      SOI,
      JFIF,
      segment(0xe1, gps),
      segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')),
      segment(0xed, Buffer.from('Photoshop 3.0 IPTC')),
      segment(0xeb, Buffer.from('JP JUMBF c2pa Exif GPS')), // content credentials
      segment(0xe2, Buffer.from('MPF\0second image')),
      segment(0xe0, Buffer.from('JFXX\0thumbnail')),
      segment(0xfe, Buffer.from('a comment')),
      icc,
      adobe,
      DQT,
      SOF,
      DHT,
      SCAN,
      EOI,
      Buffer.from('ftypmp42 a motion photo, GPS 25.03'), // after the end: gone
    ]);
    const clean = withoutMetadata(jpeg, 'jpg');
    expect(clean).toEqual(Buffer.concat([SOI, JFIF, icc, adobe, DQT, SOF, DHT, SCAN, EOI]));
    expect(clean.toString('latin1')).not.toMatch(/GPS|IPTC|comment|xmpmeta|c2pa|MPF|JFXX|ftyp/);
  });

  it("keeps a JPEG's JFIF header alone, without the thumbnail it may hold (it may show the image before it was cropped)", () => {
    const thumb = Buffer.concat([Buffer.from('SECRETTHUMB!'), Buffer.alloc(0)]); // 2×2 RGB
    const withThumb = segment(0xe0, Buffer.concat([Buffer.from([0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 0, 0, 1, 0, 1, 2, 2]), thumb, Buffer.from('and more')]));
    const clean = withoutMetadata(Buffer.concat([SOI, withThumb, DQT, SOF, DHT, SCAN, EOI]), 'jpg');
    expect(clean).toEqual(Buffer.concat([SOI, JFIF, DQT, SOF, DHT, SCAN, EOI]));
    expect(clean.toString('latin1')).not.toContain('SECRET');
    // A JFIF segment too short for its header is not read through.
    expect(() => withoutMetadata(Buffer.concat([SOI, segment(0xe0, Buffer.from('JFIF\0\x01')), DQT, SOF, DHT, SCAN, EOI]), 'jpg')).toThrow();
  });

  it("keeps a progressive JPEG's scans and the tables between them", () => {
    const second = Buffer.concat([DHT, SCAN]);
    const jpeg = Buffer.concat([SOI, DQT, SOF, DHT, SCAN, segment(0xfe, Buffer.from('between scans')), second, EOI]);
    expect(withoutMetadata(jpeg, 'jpg')).toEqual(Buffer.concat([SOI, DQT, SOF, DHT, SCAN, second, EOI]));
  });

  it("keeps a JPEG's orientation alone, so a photo shows the right way up", () => {
    for (const order of ['II', 'MM'] as const) {
      const jpeg = Buffer.concat([SOI, segment(0xe1, exifWith(6, order)), DQT, SOF, DHT, SCAN, EOI]);
      const clean = withoutMetadata(jpeg, 'jpg');
      expect(clean.toString('latin1')).not.toContain('GPS');
      const app1 = clean.subarray(2, 2 + 4 + clean.readUInt16BE(4) - 2);
      expect(app1[1]).toBe(0xe1);
      expect(exifOrientation(app1.subarray(4))).toBe(6);
    }
    // Upright already: no EXIF at all.
    const upright = Buffer.concat([SOI, segment(0xe1, exifWith(1)), DQT, SOF, DHT, SCAN, EOI]);
    expect(withoutMetadata(upright, 'jpg')).toEqual(Buffer.concat([SOI, DQT, SOF, DHT, SCAN, EOI]));
  });

  it('skips stray bytes between segments, as decoders do, and keeps none of them', () => {
    const jpeg = Buffer.concat([SOI, JFIF, Buffer.from([0x00]), segment(0xe1, gps), DQT, SOF, DHT, SCAN, EOI]);
    expect(withoutMetadata(jpeg, 'jpg')).toEqual(JPEG);
  });

  it("keeps of a PNG only the chunks showing it needs, up to its IEND", () => {
    const srgb = pngChunk('sRGB', Buffer.from([0]));
    const png = Buffer.concat([
      PNG_SIG,
      IHDR,
      srgb,
      pngChunk('eXIf', gps),
      pngChunk('tEXt', Buffer.from('Author\0someone')),
      pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp')),
      pngChunk('tIME', Buffer.alloc(7)),
      pngChunk('caBX', Buffer.from('c2pa GPS')),
      pngChunk('prVt', Buffer.from('a private chunk')),
      IDAT,
      IEND,
      Buffer.from('after the end GPS'),
    ]);
    expect(withoutMetadata(png, 'png')).toEqual(Buffer.concat([PNG_SIG, IHDR, srgb, IDAT, IEND]));
  });

  it("keeps of a WebP only the chunks showing it needs, within its RIFF size, its flags and size set again", () => {
    const vp8x = (flags: number) => webpChunk('VP8X', Buffer.from([flags, 0, 0, 0, 1, 0, 0, 1, 0, 0]));
    const icc = webpChunk('ICCP', Buffer.from('colors'));
    const webp = Buffer.concat([
      riff(Buffer.concat([vp8x(0x2c), icc, VP8, webpChunk('EXIF', gps), webpChunk('XMP ', Buffer.from('<x:xmpmeta/>')), webpChunk('UNKN', Buffer.from('?'))])),
      Buffer.from('GPS'), // past the RIFF size
    ]);
    expect(withoutMetadata(webp, 'webp')).toEqual(riff(Buffer.concat([vp8x(0x20), icc, VP8])));
  });

  it("keeps of a WebP animation's frames only their images, each frame's size set again", () => {
    const header = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0]); // position, size, duration, flags
    const frame = (...inner: Buffer[]) => webpChunk('ANMF', Buffer.concat([header, ...inner]));
    const anim = webpChunk('ANIM', Buffer.from([0, 0, 0, 0, 0, 0]));
    const vp8x = webpChunk('VP8X', Buffer.from([0x02, 0, 0, 0, 1, 0, 0, 1, 0, 0]));
    const webp = riff(Buffer.concat([vp8x, anim, frame(VP8, webpChunk('UNKN', Buffer.from('GPS 25.03'))), frame(webpChunk('ALPH', Buffer.from('a')), VP8)]));
    const clean = withoutMetadata(webp, 'webp');
    expect(clean).toEqual(riff(Buffer.concat([vp8x, anim, frame(VP8), frame(webpChunk('ALPH', Buffer.from('a')), VP8)])));
    expect(clean.toString('latin1')).not.toContain('GPS');
  });

  it("refuses what it cannot read through before its image begins, rather than letting its metadata go along", () => {
    expect(() => withoutMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), 'jpg')).toThrow();
    expect(() => withoutMetadata(Buffer.concat([SOI, JFIF, DQT]), 'jpg')).toThrow(); // no scan
    expect(() => withoutMetadata(Buffer.concat([PNG_SIG, IHDR, pngChunk('eXIf', gps)]), 'png')).toThrow(); // no image data
    expect(() => withoutMetadata(Buffer.concat([riff(VP8).subarray(0, 14)]), 'webp')).toThrow();
  });

  it('ends an image cut short after its image began, as browsers show what there is of it, without its metadata', () => {
    // A JPEG cut in its scan: what there is, and an end marker.
    const cutJpeg = Buffer.concat([SOI, segment(0xe1, gps), DQT, SOF, DHT, SCAN]);
    expect(withoutMetadata(cutJpeg, 'jpg')).toEqual(Buffer.concat([SOI, DQT, SOF, DHT, SCAN, EOI]));
    // Cut in a segment after the scan: that segment goes too.
    expect(withoutMetadata(Buffer.concat([SOI, DQT, SOF, DHT, SCAN, DHT.subarray(0, 4)]), 'jpg')).toEqual(Buffer.concat([SOI, DQT, SOF, DHT, SCAN, EOI]));
    // A PNG cut in its image data: its whole chunks, then a real IEND (its CRC as PNG has it).
    const realIend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const cutPng = Buffer.concat([PNG_SIG, IHDR, IDAT, pngChunk('tEXt', Buffer.from('GPS')), IDAT.subarray(0, 9)]);
    expect(withoutMetadata(cutPng, 'png')).toEqual(Buffer.concat([PNG_SIG, IHDR, IDAT, realIend]));
    // A WebP cut short is not read through: refused.
    expect(() => withoutMetadata(riff(VP8).subarray(0, 18), 'webp')).toThrow();
  });

  it("keeps a PNG's orientation alone, in a minimal EXIF chunk with its CRC", () => {
    const exif = exifWith(8, 'MM').subarray(6); // a PNG's eXIf holds the TIFF structure alone
    const clean = withoutMetadata(Buffer.concat([PNG_SIG, IHDR, pngChunk('eXIf', exif), IDAT, IEND]), 'png');
    expect(clean.toString('latin1')).not.toContain('GPS');
    const at = clean.indexOf('eXIf', 0, 'latin1') - 4;
    const length = clean.readUInt32BE(at);
    expect(tiffOrientation(clean.subarray(at + 8, at + 8 + length))).toBe(8);
    expect(clean.readUInt32BE(at + 8 + length)).toBe(crc32(clean.subarray(at + 4, at + 8 + length)) >>> 0);
    // Upright already, or no orientation: no EXIF at all.
    expect(withoutMetadata(Buffer.concat([PNG_SIG, IHDR, pngChunk('eXIf', exifWith(1).subarray(6)), IDAT, IEND]), 'png')).toEqual(PNG);
    expect(withoutMetadata(Buffer.concat([PNG_SIG, IHDR, pngChunk('eXIf', gps), IDAT, IEND]), 'png')).toEqual(PNG);
  });

  it('makes one piece of the many tiny segments a crafted file may hold, quickly', () => {
    // 1 MB of empty tables (a crafted JPEG): kept as they are, without a piece for each.
    const tables = Buffer.concat(Array.from({ length: 250_000 }, () => Buffer.from([0xff, 0xdb, 0x00, 0x02])));
    const jpeg = Buffer.concat([SOI, tables, SOF, DHT, SCAN, EOI]);
    const started = performance.now();
    expect(withoutMetadata(jpeg, 'jpg')).toEqual(jpeg);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('reads no orientation from an EXIF structure that is not what it says', () => {
    expect(tiffOrientation(Buffer.from('MM\0\x2a\xff\xff\xff\xff', 'latin1'))).toBeUndefined();
    expect(tiffOrientation(Buffer.from('XX'))).toBeUndefined();
    expect(tiffOrientation(Buffer.alloc(0))).toBeUndefined();
  });

});

describe('the screenshots a request sends', () => {
  const refused = (v: unknown) => {
    try {
      parseScreenshots(v);
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      return { status: (err as HttpError).status, message: (err as HttpError).message };
    }
    throw new Error('taken');
  };

  it('are named by their place and kind, never by the name the file had, and go without their metadata', () => {
    const tagged = Buffer.concat([SOI, segment(0xe1, Buffer.from('Exif\0\0GPS 25.03')), DQT, SOF, DHT, SCAN, EOI]);
    const files = parseScreenshots([{ data: b64(PNG), name: 'secret-project.png' }, { data: b64(tagged) }, { data: b64(WEBP) }]);
    expect(files.map((f) => f.name)).toEqual(['screenshot-1.png', 'screenshot-2.jpg', 'screenshot-3.webp']);
    expect(files[0]!.data.equals(PNG)).toBe(true);
    expect(files[1]!.data.toString('latin1')).not.toContain('GPS');
  });

  it('refuses one it cannot read through, saying which, instead of uploading it with its metadata', () => {
    expect(refused([{ data: b64(PNG) }, { data: b64(Buffer.concat([PNG_SIG, IHDR, pngChunk('eXIf', Buffer.from('GPS'))])) }])).toEqual({
      status: 400,
      message: t().reportShotUnreadable(2),
    });
  });

  it('must be some, and not too many', () => {
    expect(refused(undefined)).toEqual({ status: 400, message: t().reportShotsNone });
    expect(refused([])).toEqual({ status: 400, message: t().reportShotsNone });
    const many = Array.from({ length: REPORT_SCREENSHOT_LIMITS.maxFiles + 1 }, () => ({ data: b64(PNG) }));
    expect(refused(many)).toEqual({ status: 413, message: t().reportShotsTooMany(REPORT_SCREENSHOT_LIMITS.maxFiles) });
  });

  it('must each be an image, in base64 as a browser writes it, saying which one is not', () => {
    expect(refused([{ data: b64(PNG) }, { data: b64(Buffer.from('<svg/>')) }])).toEqual({ status: 400, message: t().reportShotNotImage(2) });
    // Only the usual kinds for screenshots and photos: not a GIF.
    expect(refused([{ data: b64(GIF) }])).toEqual({ status: 400, message: t().reportShotNotImage(1) });
    expect(refused([{ data: 'not base64!' }])).toEqual({ status: 400, message: t().reportShotNotImage(1) });
    expect(refused([{ data: 42 }])).toEqual({ status: 400, message: t().reportShotNotImage(1) });
    expect(refused([null])).toEqual({ status: 400, message: t().reportShotNotImage(1) });
  });

  it('must each be no larger than the limit, refused before it is decoded', () => {
    const mb = REPORT_SCREENSHOT_LIMITS.maxBytes / 1024 / 1024;
    const big = Buffer.concat([PNG, Buffer.alloc(REPORT_SCREENSHOT_LIMITS.maxBytes)]);
    expect(refused([{ data: b64(big) }])).toEqual({ status: 413, message: t().reportShotTooLarge(1, mb) });
    // Measured before it is matched as base64.
    expect(refused([{ data: '!'.repeat(REPORT_SCREENSHOT_LIMITS.maxBytes * 2) }])).toEqual({ status: 413, message: t().reportShotTooLarge(1, mb) });
    const fits = Buffer.concat([PNG, Buffer.alloc(REPORT_SCREENSHOT_LIMITS.maxBytes - PNG.length)]);
    expect(parseScreenshots([{ data: b64(fits) }])).toHaveLength(1);
  });
});

describe('uploading the screenshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-shots-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const ID = 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
  const TOKEN = 'relay-0123456789abcdef';
  const opts = { token: TOKEN, wait: async () => {}, tmpRoot: join(dir, 'tmp') };
  const files = parseScreenshots([{ data: b64(PNG) }, { data: b64(JPEG) }]);
  const created = (names: string[], html = `https://gist.github.com/someone/${ID}`) =>
    JSON.stringify({
      id: ID,
      html_url: html,
      files: names.map((filename) => ({ filename, raw_url: `https://gist.githubusercontent.com/someone/${ID}/raw/abc/${filename}` })),
    }) + '\n';

  const gitCommand = (args: string[]) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '--git-dir') i++;
      else return args[i]!;
    }
    return '';
  };
  const oid = (n: number) => n.toString(16).padStart(40, '0');
  const fakeGit = (o: SpawnOptions) =>
    result({ stdout: { 'symbolic-ref': 'refs/heads/main\n', 'hash-object': `${oid(1)}\n`, mktree: `${oid(2)}\n`, 'commit-tree': `${oid(3)}\n` }[gitCommand(o.args)] ?? '' });

  /** gh's calls answered in turn by `answers`, git's by `git`; gh's calls recorded. */
  function fake(answers: (() => SpawnResult)[], git: (o: SpawnOptions) => SpawnResult = fakeGit) {
    const gh: SpawnOptions[] = [];
    const pushed: Buffer[] = [];
    let n = 0;
    const run = async (o: SpawnOptions) => {
      if (o.bin === 'git') {
        if (gitCommand(o.args) === 'hash-object') pushed.push(o.stdin as Buffer);
        return git(o);
      }
      gh.push(o);
      const answer = answers[n++];
      if (!answer) throw new Error(`unexpected gh ${o.args.join(' ')}`);
      return answer();
    };
    return { run, gh, pushed, args: () => gh.map((c) => c.args) };
  }
  const ok = (stdout = '') => () => result({ stdout });

  it('puts them in one secret gist, pushed with git, and gives its page on GitHub', async () => {
    const f = fake([ok(created([FILES_PLACEHOLDER]))]);
    expect(await uploadScreenshots(files, f.run, opts)).toEqual({ id: ID, url: `https://gist.github.com/someone/${ID}` });
    // The files' raw URLs are not read back (the mail links to the gist's page): GitHub slow to list them fails nothing.
    expect(f.args()).toEqual([createGistArgs()]);
    expect(f.args()).not.toContainEqual(gistFilesArgs(ID));
    expect(gistFilesArgs(ID)).toEqual(['api', `gists/${ID}`, '--jq', CREATED_JQ]);
    expect(JSON.parse(String(f.gh[0]!.stdin))).toMatchObject({ description: filesGistDescription(SCREENSHOTS_DESCRIPTION, TOKEN), public: false });
    expect(f.pushed).toEqual(files.map((x) => x.data));
  });

  it('says how to install gh when it is missing, with the code the dialog explains', async () => {
    const run = async () => {
      throw new CommandNotFoundError('gh');
    };
    const err = (await uploadScreenshots(files, run, opts).catch((e: unknown) => e)) as ShareError;
    expect(err).toBeInstanceOf(ShareError);
    expect(err.code).toBe(GH_MISSING);
  });

  it('deletes the gist again when the screenshots could not go up, and says so of the screenshots', async () => {
    const failPush = (o: SpawnOptions) => (gitCommand(o.args) === 'push' ? result({ code: 1, stderr: 'fatal: unable to access\n' }) : fakeGit(o));
    const f = fake([ok(created([FILES_PLACEHOLDER])), ok()], failPush);
    const err = (await uploadScreenshots(files, f.run, opts).catch((e: unknown) => e)) as ShareError;
    expect(err.message).toBe(t().reportShotsUndone(t().shareFilesFailed('fatal: unable to access')));
    expect(f.args()).toEqual([createGistArgs(), deleteGistArgs(ID)]);

    // Nor deleted: the message says where it is, to delete it on GitHub.
    const stuck = fake([ok(created([FILES_PLACEHOLDER])), () => result({ code: 1, stderr: 'HTTP 500' })], failPush);
    const left = (await uploadScreenshots(files, stuck.run, opts).catch((e: unknown) => e)) as ShareError;
    expect(left.message).toBe(t().reportShotsLeftover(t().shareFilesFailed('fatal: unable to access'), `https://gist.github.com/someone/${ID}`));
  });

  it('looks for the gist by its token when gh could not say it made it, and names the token when it cannot', async () => {
    const f = fake([() => result({ code: null, timedOut: true }), () => result({ code: 1, stderr: 'HTTP 502' })]);
    const err = (await uploadScreenshots(files, f.run, opts).catch((e: unknown) => e)) as ShareError;
    expect(f.args()).toEqual([createGistArgs(), findGistArgs(TOKEN)]);
    expect(err.message).toBe(t().reportShotsUnknown(t().shareFailed(t().timedOut), TOKEN));
  });

  it('pushes nothing to a gist elsewhere than github.com, and deletes it again', async () => {
    const f = fake([ok(created([FILES_PLACEHOLDER], `https://github.example.com/gist/${ID}`)), ok()]);
    const err = (await uploadScreenshots(files, f.run, opts).catch((e: unknown) => e)) as ShareError;
    expect(err.message).toBe(t().reportShotsUndone(t().reportShotsNotGithub));
    expect(f.pushed).toEqual([]);
  });
});
