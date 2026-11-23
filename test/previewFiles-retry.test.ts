/*
 * A static page's folder that changes while it is copied (a turn still writing there): copied whole once
 * more before the preview falls back to the page and what it names (`previewSnapshot()` in
 * src/server/previewFiles.ts). A stand-in `opendir` changes the folder's time as it is listed, as a
 * file written there would (set apart by seconds, so that no file system's clock can miss it).
 */
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => ({ dir: '', left: 0, at: Date.now() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    opendir: async (...args: Parameters<typeof fs.opendir>) => {
      const dir = await fs.opendir(...args);
      if (args[0] === writes.dir && writes.left > 0) {
        writes.left--;
        writes.at += 10_000;
        utimesSync(writes.dir, new Date(writes.at), new Date(writes.at));
      }
      return dir;
    },
  };
});

const { previewPrivatePath, previewSnapshot } = await import('../src/server/previewFiles');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-preview-retry-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function site(name: string): string {
  const folder = realpathSync(mkdtempSync(join(root, `${name}-`)));
  writeFileSync(join(folder, 'index.html'), '<link rel="stylesheet" href="style.css"><h1>hi</h1>');
  writeFileSync(join(folder, 'style.css'), 'h1 { color: red }');
  writeFileSync(join(folder, 'unnamed.js'), 'console.log(1)'); // the page does not name it
  return folder;
}

describe('a static page whose folder changes while it is copied', () => {
  it('is copied whole once more when it changed once', async () => {
    const folder = site('once');
    Object.assign(writes, { dir: folder, left: 1 });
    const snapshot = await previewSnapshot(folder, '', 'static', undefined, previewPrivatePath(), 'index.html');
    expect(writes.left).toBe(0);
    expect([...snapshot.keys()].sort()).toEqual(['index.html', 'style.css', 'unnamed.js']);
    expect(snapshot.partial).toBe(false);
  });

  it('falls back to the page and what it names when it changed twice running, and says so', async () => {
    const folder = site('twice');
    Object.assign(writes, { dir: folder, left: 2 });
    const snapshot = await previewSnapshot(folder, '', 'static', undefined, previewPrivatePath(), 'index.html');
    expect(writes.left).toBe(0);
    expect([...snapshot.keys()].sort()).toEqual(['index.html', 'style.css']);
    expect(snapshot.partial).toBe(true);
  });

  it('is refused as changed, as before, without a page to fall back to or in another mode', async () => {
    const folder = site('no-page');
    Object.assign(writes, { dir: folder, left: 1 });
    await expect(previewSnapshot(folder, '', 'static')).rejects.toMatchObject({ status: 409 });
    Object.assign(writes, { dir: folder, left: 1 });
    await expect(previewSnapshot(folder, '', 'build', undefined, previewPrivatePath(), 'index.html')).rejects.toMatchObject({
      status: 409,
    });
  });
});
