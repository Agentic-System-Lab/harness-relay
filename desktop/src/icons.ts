/**
 * The desktop app's icons, drawn at build time from the Harness Relay mark (scripts/app-icons.ts),
 * without an image library: the app icon (a white rounded square with the mark), the menu-bar icon
 * of macOS (a template image: black with transparency, which macOS tints for light and dark menu
 * bars) and the tray icon of Windows and Linux (the mark in its colours).
 */
import { crc32, deflateSync } from 'node:zlib';
import { MARK } from '../../scripts/app-icons';

export type IconStyle = 'app' | 'template' | 'tray';

export interface DesktopIcon {
  file: string;
  size: number;
  style: IconStyle;
}

/** What the build writes: `@2x` files are picked up by Electron on high-density screens. */
export const DESKTOP_ICONS: readonly DesktopIcon[] = [
  // For electron-builder, which makes the macOS, Windows and Linux icons from it.
  { file: 'icon.png', size: 1024, style: 'app' },
  // The chat window's icon on Windows and Linux (macOS takes the app's).
  { file: 'app.png', size: 256, style: 'app' },
  { file: 'trayTemplate.png', size: 16, style: 'template' },
  { file: 'trayTemplate@2x.png', size: 32, style: 'template' },
  { file: 'tray.png', size: 16, style: 'tray' },
  { file: 'tray@2x.png', size: 32, style: 'tray' },
];

type Rgba = [number, number, number, number];

/** Paints `color` with `coverage` (0–1) over `dst` (straight alpha). */
function over(dst: Rgba, color: readonly [number, number, number], coverage: number): Rgba {
  if (coverage <= 0) return dst;
  const a = coverage;
  const da = dst[3] / 255;
  const outA = a + da * (1 - a);
  if (outA === 0) return [0, 0, 0, 0];
  const mix = (c: number, d: number) => (c * a + d * da * (1 - a)) / outA;
  return [mix(color[0], dst[0]), mix(color[1], dst[1]), mix(color[2], dst[2]), outA * 255];
}

/** How much of the pixel at (x, y) a rounded square covers (signed distance, one pixel of edge). */
function roundedSquare(x: number, y: number, centre: number, half: number, radius: number): number {
  const qx = Math.abs(x - centre) - (half - radius);
  const qy = Math.abs(y - centre) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
  return Math.min(1, Math.max(0, 0.5 - outside));
}

function markBounds() {
  const left = Math.min(...MARK.map((c) => c.cx - c.r));
  const right = Math.max(...MARK.map((c) => c.cx + c.r));
  const top = Math.min(...MARK.map((c) => c.cy - c.r));
  const bottom = Math.max(...MARK.map((c) => c.cy + c.r));
  return { width: right - left, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

/** The icon's pixels, RGBA, row by row. */
export function rasterizeIcon(icon: Pick<DesktopIcon, 'size' | 'style'>): Buffer {
  const { size, style } = icon;
  // The app icon follows macOS's grid: the square fills 824 of 1024, with rounded corners.
  const half = (size * 824) / 1024 / 2;
  const radius = (size * 185) / 1024;
  // The tray icons keep a hair of margin, as the system's own icons do.
  const markWidth = style === 'app' ? 0.5 : 0.9;
  const box = markBounds();
  const scale = (size * markWidth) / box.width;
  const circles = MARK.map((c) => ({
    cx: size / 2 + (c.cx - box.cx) * scale,
    cy: size / 2 + (c.cy - box.cy) * scale,
    r: c.r * scale,
    color: style === 'template' ? ([0, 0, 0] as const) : c.color,
  }));
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let rgba: Rgba = [0, 0, 0, 0];
      if (style === 'app') rgba = over(rgba, [0xff, 0xff, 0xff], roundedSquare(px, py, size / 2, half, radius));
      for (const c of circles) {
        rgba = over(rgba, c.color, Math.min(1, Math.max(0, c.r - Math.hypot(px - c.cx, py - c.cy) + 0.5)));
      }
      const at = (y * size + x) * 4;
      for (let i = 0; i < 4; i++) pixels[at + i] = Math.round(rgba[i]!);
    }
  }
  return pixels;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An 8-bit RGBA PNG. */
export function encodePngRgba(size: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const stride = size * 4;
  const rows = Buffer.alloc(size * (stride + 1)); // each row starts with filter type 0 (none)
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
