/**
 * The stills cut from a frame of the demo video: the site's poster (WebP, with its origin in a
 * `.json` sidecar), the README and org screenshot (PNG, its origin in a text chunk) and the social
 * card (its screen, which shows the poster, swapped for the new frame). FFmpeg decodes, scales and
 * encodes; cwebp encodes the poster.
 */
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { ROOT, stamp, type DemoLang } from './common';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG's chunks, in order. */
export function pngChunks(png: Buffer): { type: string; data: Buffer }[] {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG');
  const out: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    out.push({ type: png.toString('latin1', at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

/** The PNG with a `tEXt` chunk (keyword → text) before its image data, replacing one with the same keyword. */
export function withPngText(png: Buffer, keyword: string, text: string): Buffer {
  const own = (c: { type: string; data: Buffer }) => c.type === 'tEXt' && c.data.toString('latin1', 0, c.data.indexOf(0)) === keyword;
  const kept = pngChunks(png).filter((c) => !own(c));
  const textChunk = chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
  const parts: Buffer[] = [PNG_SIGNATURE];
  let added = false;
  for (const c of kept) {
    if (c.type === 'IDAT' && !added) parts.push(textChunk), (added = true);
    parts.push(chunk(c.type, c.data));
  }
  return Buffer.concat(parts);
}

/** The text of a PNG's `tEXt` chunk. */
export function pngText(png: Buffer, keyword: string): string | undefined {
  for (const c of pngChunks(png)) {
    if (c.type !== 'tEXt') continue;
    const zero = c.data.indexOf(0);
    if (c.data.toString('latin1', 0, zero) === keyword) return c.data.toString('latin1', zero + 1);
  }
  return undefined;
}

const ffmpeg = (args: string[], input?: Buffer) =>
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { input, maxBuffer: 1 << 28 });

/** An image's pixels as RGB bytes, scaled to `w`×`h` (Lanczos). */
function rgb(file: string, w: number, h: number): Buffer {
  return ffmpeg(['-i', file, '-vf', `scale=${w}:${h}:flags=lanczos`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
}

/** RGB bytes as a PNG. */
function encodePng(pixels: Buffer, w: number, h: number): Buffer {
  return ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', 'pipe:0', '-pred', 'mixed', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], pixels);
}

/** Whether pixel (x, y) of a w×h screen lies outside its rounded corners (radius r), its centre beyond the arc. */
function outsideCorner(x: number, y: number, w: number, h: number, r: number): boolean {
  const px = x + 0.5;
  const py = y + 0.5;
  const cx = px < r ? r : px > w - r ? w - r : px;
  const cy = py < r ? r : py > h - r ? h - r : py;
  return (px - cx) ** 2 + (py - cy) ** 2 > r * r;
}

/**
 * Draws `next` (an image at the box's size, RGB) into `card` (w×h RGB) inside `box`, all but the
 * screen's rounded corners (radius `radius`), where the frame around it shows. What the screen
 * showed before does not matter. Returns how many pixels were drawn.
 */
export function swapScreen(
  card: Buffer,
  cardWidth: number,
  box: { x: number; y: number; w: number; h: number },
  next: Buffer,
  radius = 0,
): number {
  const cardHeight = card.length / 3 / cardWidth;
  const visW = Math.min(box.w, cardWidth - box.x);
  const visH = Math.min(box.h, cardHeight - box.y);
  let changed = 0;
  for (let y = 0; y < visH; y++) {
    for (let x = 0; x < visW; x++) {
      if (radius > 0 && outsideCorner(x, y, box.w, box.h, radius)) continue;
      const c = ((box.y + y) * cardWidth + box.x + x) * 3;
      const s = (y * box.w + x) * 3;
      for (let k = 0; k < 3; k++) card[c + k] = next[s + k];
      changed++;
    }
  }
  return changed;
}

/**
 * Where the social card shows its screen: 600×375 at (650, 80), cut off by the card's right edge,
 * with corners of a 6-pixel radius inside the frame.
 */
const OG_SCREEN = { x: 650, y: 80, w: 600, h: 375, radius: 6 };
const OG_SIZE = { w: 1200, h: 630 };

/**
 * The social card for `lang` with `screen` (any image file, scaled to the screen) drawn into its
 * screen, and `origin` as its PNG text. Returns how many pixels were drawn.
 */
export function drawCardScreen(lang: DemoLang, screen: string, origin: string): number {
  const ogPath = join(ROOT, `site/assets/media/og-${lang}.png`);
  const card = rgb(ogPath, OG_SIZE.w, OG_SIZE.h);
  const changed = swapScreen(card, OG_SIZE.w, OG_SCREEN, rgb(screen, OG_SCREEN.w, OG_SCREEN.h), OG_SCREEN.radius);
  writeFileSync(ogPath, withPngText(encodePng(card, OG_SIZE.w, OG_SIZE.h), 'impeccable:prompt', origin));
  return changed;
}

/** Re-cuts every still for `lang` from the frame at `at` seconds of docs/media/demo-<lang>.mp4. */
export function cutStills(lang: DemoLang, at: number, workDir: string, log: (...a: unknown[]) => void): void {
  const video = `docs/media/demo-${lang}.mp4`;
  const when = stamp(at);
  const frame = join(workDir, 'still.png');
  ffmpeg(['-ss', at.toFixed(3), '-i', join(ROOT, video), '-frames:v', '1', frame]);

  // The social card's screen.
  const ogText =
    'Origin: social preview card rendered with Playwright from an HTML card using site/assets/site.css; ' +
    `its screen the frame at ${when} of ${video} (the poster's), drawn in by scripts/demo/stills.ts; no generated imagery.\n`;
  log(`og-${lang}.png: ${drawCardScreen(lang, frame, ogText)} screen pixels drawn`);

  // The poster, and where it came from.
  const posterPath = join(ROOT, `site/assets/media/poster-${lang}.webp`);
  execFileSync('cwebp', ['-quiet', '-q', '82', frame, '-o', posterPath]);
  const sidecar = {
    prompt: `Origin: frame at ${when} of ${video} (Harness Relay's own demo recording), extracted with ffmpeg, encoded with cwebp -q 82.\n`,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(`${posterPath}.json`, JSON.stringify(sidecar, null, 2) + '\n');

  // The full-size screenshot for the READMEs and the org's pages.
  const shotText =
    `Origin: frame at ${when} of ${video} (Harness Relay's own demo recording), the same frame as site/assets/media/poster-${lang}.webp, ` +
    'extracted with ffmpeg as PNG; no generated imagery.\n';
  const shot = encodePng(rgb(frame, 1600, 1000), 1600, 1000);
  writeFileSync(join(ROOT, `docs/media/screenshot-${lang}.png`), withPngText(shot, 'impeccable:prompt', shotText));
  rmSync(frame);
  log(`poster-${lang}.webp, screenshot-${lang}.png: frame at ${when}`);
}
