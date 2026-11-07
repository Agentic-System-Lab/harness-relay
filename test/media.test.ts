import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isVideo, localMediaPath, mediaType } from '../src/shared/media';
import { byteRange, resolveMedia } from '../src/server/media';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-media-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('local media in replies', () => {
  it('knows images and videos by extension, and nothing else', () => {
    expect(mediaType('a/b/Chart.PNG')).toBe('image/png');
    expect(mediaType('x.svg')).toBe('image/svg+xml');
    expect(mediaType('clip.mp4')).toBe('video/mp4');
    expect(mediaType('notes.txt')).toBeUndefined();
    expect(mediaType('.env')).toBeUndefined();
    expect(isVideo('demo.webm')).toBe(true);
    expect(isVideo('demo.gif')).toBe(false);
  });

  it('takes relative and absolute paths and file: URLs, never other sites', () => {
    expect(localMediaPath('charts/sales.png')).toBe('charts/sales.png');
    expect(localMediaPath('./out/my%20chart.png')).toBe('./out/my chart.png');
    expect(localMediaPath('/Users/me/p/a.jpg?raw=1#x')).toBe('/Users/me/p/a.jpg');
    expect(localMediaPath('file:///Users/me/p/demo.mp4')).toBe('/Users/me/p/demo.mp4');
    expect(localMediaPath('file://localhost/tmp/a.png')).toBe('/tmp/a.png');
    expect(localMediaPath('https://evil.example/a.png')).toBeUndefined();
    expect(localMediaPath('//evil.example/a.png')).toBeUndefined();
    expect(localMediaPath('data:image/png;base64,AAAA')).toBeUndefined();
    expect(localMediaPath('javascript:alert(1)//.png')).toBeUndefined();
    expect(localMediaPath('README.md')).toBeUndefined();
    expect(localMediaPath('a%00.png')).toBeUndefined();
  });

  it('serves only media files inside the allowed directories', () => {
    const cwd = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(join(cwd, 'charts'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(cwd, 'charts', 'sales.png'), 'png');
    writeFileSync(join(cwd, 'secret.txt'), 'secret');
    writeFileSync(join(outside, 'other.png'), 'png');
    symlinkSync(join(outside, 'other.png'), join(cwd, 'escape.png'));
    symlinkSync(join(cwd, 'secret.txt'), join(cwd, 'secret.png'));
    mkdirSync(join(cwd, 'dir.png'));

    expect(resolveMedia('charts/sales.png', [cwd])).toBe(join(cwd, 'charts', 'sales.png'));
    expect(resolveMedia(join(cwd, 'charts', 'sales.png'), [cwd])).toBe(join(cwd, 'charts', 'sales.png'));
    expect(resolveMedia('../outside/other.png', [cwd])).toBeUndefined();
    expect(resolveMedia(join(outside, 'other.png'), [cwd])).toBeUndefined();
    expect(resolveMedia('escape.png', [cwd])).toBeUndefined(); // symlink out of the directory
    expect(resolveMedia('secret.png', [cwd])).toBeUndefined(); // symlink to a non-media file
    expect(resolveMedia('secret.txt', [cwd])).toBeUndefined();
    expect(resolveMedia('dir.png', [cwd])).toBeUndefined();
    expect(resolveMedia('missing.png', [cwd])).toBeUndefined();
    // Later roots are tried in turn.
    expect(resolveMedia('other.png', [cwd, outside])).toBe(join(outside, 'other.png'));
  });

  it('reads byte ranges for video', () => {
    expect(byteRange(undefined, 100)).toBeNull();
    expect(byteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(byteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(byteRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange('bytes=100-', 100)).toBe('invalid');
    expect(byteRange('bytes=0-1,5-6', 100)).toBeNull();
  });
});
