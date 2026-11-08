/**
 * Draws the app's home-screen icons and writes the web app manifest (`npm run icons`).
 *
 * The icons are the Harness Relay mark (the three circles of the favicon and `Logo.tsx`) on an
 * opaque white square, written to `src/web/public/`, which Vite copies into the build as it is.
 * They are drawn here, without an image library, so they can be redrawn the same way whenever the
 * mark changes; `test/app-icons.test.ts` checks that the files match this script.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

type Rgb = readonly [number, number, number];

/** The mark in its 32×32 viewBox, as in `src/web/components/Logo.tsx` and the favicon. */
export const MARK: readonly { cx: number; cy: number; r: number; color: Rgb }[] = [
  { cx: 9, cy: 16, r: 6, color: [0xd9, 0x77, 0x57] }, // Claude Code
  { cx: 23, cy: 10, r: 5, color: [0x10, 0xa3, 0x7f] }, // Codex
  { cx: 23, cy: 23, r: 5, color: [0x7c, 0x5c, 0xff] }, // Grok
];

/** The app's light background (`--bg` in styles.css). Icons are opaque: iOS turns transparency black. */
export const BACKGROUND = '#ffffff';
const BACKGROUND_RGB: Rgb = [0xff, 0xff, 0xff];

export interface IconSpec {
  /** Path under `src/web/public/`, which is also the path the browser asks for. */
  file: string;
  size: number;
  /** Width of the mark as a share of the icon's width. */
  markWidth: number;
  /** Listed in the manifest with this purpose; the Apple touch icon is linked from index.html instead. */
  purpose?: 'any' | 'maskable';
}

/**
 * Maskable icons are cut to a shape by the launcher (a circle, a squircle…), which may keep only
 * the middle circle of 80% of the width, so their mark is smaller (see markExtent).
 */
export const ICONS: readonly IconSpec[] = [
  { file: 'apple-touch-icon.png', size: 180, markWidth: 0.6 },
  { file: 'icons/icon-192.png', size: 192, markWidth: 0.64, purpose: 'any' },
  { file: 'icons/icon-512.png', size: 512, markWidth: 0.64, purpose: 'any' },
  { file: 'icons/icon-maskable-192.png', size: 192, markWidth: 0.56, purpose: 'maskable' },
  { file: 'icons/icon-maskable-512.png', size: 512, markWidth: 0.56, purpose: 'maskable' },
];

/** The mark's bounding box in viewBox units. */
function markBox() {
  const left = Math.min(...MARK.map((c) => c.cx - c.r));
  const right = Math.max(...MARK.map((c) => c.cx + c.r));
  const top = Math.min(...MARK.map((c) => c.cy - c.r));
  const bottom = Math.max(...MARK.map((c) => c.cy + c.r));
  return { left, top, width: right - left, height: bottom - top, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

/** The circles placed on an icon: the mark scaled to `markWidth` and centred. */
export function placedCircles(spec: IconSpec) {
  const box = markBox();
  const scale = (spec.size * spec.markWidth) / box.width;
  const mid = spec.size / 2;
  return MARK.map((c) => ({
    cx: mid + (c.cx - box.cx) * scale,
    cy: mid + (c.cy - box.cy) * scale,
    r: c.r * scale,
    color: c.color,
  }));
}

/** How far the mark reaches from the icon's centre, as a share of its width. */
export function markExtent(spec: IconSpec): number {
  const mid = spec.size / 2;
  return Math.max(...placedCircles(spec).map((c) => Math.hypot(c.cx - mid, c.cy - mid) + c.r)) / spec.size;
}

/**
 * The icon's pixels, RGB, row by row. Each circle's edge is anti-aliased by the share of the pixel
 * it covers (distance from the pixel's centre to the edge, clamped to one pixel). The circles don't
 * overlap, so drawing them over the background in any order gives the same result.
 */
export function rasterize(spec: IconSpec): Buffer {
  const { size } = spec;
  const circles = placedCircles(spec);
  const pixels = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rgb: [number, number, number] = [...BACKGROUND_RGB];
      for (const c of circles) {
        const coverage = Math.min(1, Math.max(0, c.r - Math.hypot(x + 0.5 - c.cx, y + 0.5 - c.cy) + 0.5));
        if (coverage > 0) rgb = rgb.map((v, i) => v + (c.color[i]! - v) * coverage) as [number, number, number];
      }
      const at = (y * size + x) * 3;
      pixels[at] = Math.round(rgb[0]);
      pixels[at + 1] = Math.round(rgb[1]);
      pixels[at + 2] = Math.round(rgb[2]);
    }
  }
  return pixels;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An 8-bit RGB PNG with a text chunk saying where it comes from. */
export function encodePng(size: number, rgb: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const rows = Buffer.alloc(size * (size * 3 + 1)); // each row starts with filter type 0 (none)
  for (let y = 0; y < size; y++) rgb.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Comment\0Harness Relay mark, drawn by scripts/app-icons.ts (npm run icons)', 'latin1')),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The web app manifest: what a phone or a browser shows when the app is installed. */
export function manifest() {
  return {
    id: '/',
    name: 'Harness Relay',
    short_name: 'Harness Relay',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: BACKGROUND,
    theme_color: BACKGROUND,
    icons: ICONS.filter((icon) => icon.purpose).map((icon) => ({
      src: `/${icon.file}`,
      sizes: `${icon.size}x${icon.size}`,
      type: 'image/png',
      purpose: icon.purpose,
    })),
  };
}

export const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/web/public');
export const MANIFEST_FILE = 'manifest.webmanifest';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const spec of ICONS) {
    const path = join(PUBLIC_DIR, spec.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodePng(spec.size, rasterize(spec)));
    console.log(`${spec.file} (${spec.size}×${spec.size})`);
  }
  writeFileSync(join(PUBLIC_DIR, MANIFEST_FILE), `${JSON.stringify(manifest(), null, 2)}\n`);
  console.log(MANIFEST_FILE);
}
