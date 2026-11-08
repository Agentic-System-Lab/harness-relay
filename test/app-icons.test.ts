import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ICONS, MANIFEST_FILE, PUBLIC_DIR, manifest, markExtent, rasterize } from '../scripts/app-icons';

/** Reads a PNG as scripts/app-icons.ts writes it: 8-bit RGB, every row unfiltered. */
function decode(png: Buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colourType = body[9]!;
    }
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(data));
  const stride = width * 3 + 1;
  const rgb = Buffer.alloc(width * height * 3);
  const filters = new Set<number>();
  for (let y = 0; y < height; y++) {
    filters.add(rows[y * stride]!);
    rows.copy(rgb, y * width * 3, y * stride + 1, (y + 1) * stride);
  }
  return { width, height, colourType, filters, rgb };
}

describe('the app icons and the web app manifest', () => {
  it('has every icon drawn as npm run icons draws it (run it after changing the mark)', () => {
    for (const spec of ICONS) {
      const png = decode(readFileSync(join(PUBLIC_DIR, spec.file)));
      expect({ file: spec.file, width: png.width, height: png.height }).toEqual({ file: spec.file, width: spec.size, height: spec.size });
      expect(png.colourType, `${spec.file} is opaque RGB`).toBe(2);
      expect([...png.filters]).toEqual([0]);
      expect(png.rgb.equals(rasterize(spec)), `${spec.file} matches scripts/app-icons.ts`).toBe(true);
    }
  });

  it('has the manifest npm run icons writes, which a browser can install', () => {
    const onDisk = JSON.parse(readFileSync(join(PUBLIC_DIR, MANIFEST_FILE), 'utf8'));
    expect(onDisk).toEqual(manifest());
    expect(onDisk).toMatchObject({ name: 'Harness Relay', start_url: '/', display: 'standalone' });
    const sizes = (purpose: string) =>
      onDisk.icons.filter((icon: { purpose: string }) => icon.purpose === purpose).map((icon: { sizes: string }) => icon.sizes);
    expect(sizes('any')).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(sizes('maskable')).toEqual(expect.arrayContaining(['512x512']));
  });

  it('keeps the mark of a maskable icon inside the circle every launcher shape keeps', () => {
    for (const spec of ICONS) {
      const limit = spec.purpose === 'maskable' ? 0.4 : 0.5;
      expect(markExtent(spec), spec.file).toBeLessThan(limit);
    }
  });

  it('links the manifest and the Apple touch icon from index.html', () => {
    const html = readFileSync(join(PUBLIC_DIR, '..', 'index.html'), 'utf8');
    for (const rel of ['manifest', 'apple-touch-icon']) {
      const href = html.match(new RegExp(`<link rel="${rel}" href="/([^"]+)"`))?.[1];
      expect(href, rel).toBeDefined();
      expect(existsSync(join(PUBLIC_DIR, href!)), `${rel} → ${href}`).toBe(true);
    }
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Harness Relay" />');
  });
});
