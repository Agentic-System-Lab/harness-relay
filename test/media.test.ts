import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileName, isVideo, localFilePath, localMediaPath, mediaType } from '../src/shared/media';
import { byteRange, resolveDownload, resolveMedia } from '../src/server/media';

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

  it('serves no media from a .git folder', () => {
    const cwd = join(root, 'git-media');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    writeFileSync(join(cwd, '.git', 'a.png'), 'png');
    expect(resolveMedia('.git/a.png', [cwd])).toBeUndefined();
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

describe('files a reply links to', () => {
  it('takes relative and absolute paths, file: URLs and a file:line, never other sites', () => {
    expect(localFilePath('out/deck.pptx')).toBe('out/deck.pptx');
    expect(localFilePath('./out/Q3%20deck.pdf')).toBe('./out/Q3 deck.pdf');
    expect(localFilePath('/Users/me/p/report.pdf?x=1#page=2')).toBe('/Users/me/p/report.pdf');
    expect(localFilePath('file:///Users/me/p/report.pdf')).toBe('/Users/me/p/report.pdf');
    expect(localFilePath('C:\\Users\\me\\report.pdf')).toBe('C:\\Users\\me\\report.pdf');
    expect(localFilePath('Makefile')).toBe('Makefile');
    expect(localFilePath('src/app.ts:42')).toBe('src/app.ts');
    expect(localFilePath('app.ts:42:7')).toBe('app.ts');
    for (const url of [
      'https://example.com/report.pdf',
      'http://example.com:8080',
      '//evil.example/a.pdf',
      'mailto:me@example.com',
      'tel:123',
      'javascript:alert(1)//.pdf',
      'data:application/pdf;base64,AAAA',
      '#intro',
      '?x=1',
      '',
      'out/',
      '.',
      '..',
      'out/..',
      'a%00.pdf',
    ]) {
      expect(localFilePath(url), url).toBeUndefined();
    }
    expect(fileName('out/Q3 deck.pptx')).toBe('Q3 deck.pptx');
    expect(fileName('C:\\x\\r.pdf')).toBe('r.pdf');
  });

  it('downloads any file inside the allowed directories, never from .git or outside', () => {
    const cwd = join(root, 'downloads');
    const outside = join(root, 'downloads-outside');
    mkdirSync(join(cwd, 'out'), { recursive: true });
    mkdirSync(join(cwd, '.git'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(cwd, 'out', 'deck.pptx'), 'pptx');
    writeFileSync(join(cwd, '.git', 'config'), 'secret');
    writeFileSync(join(outside, 'other.pdf'), 'pdf');
    symlinkSync(join(outside, 'other.pdf'), join(cwd, 'escape.pdf'));
    symlinkSync(join(cwd, '.git', 'config'), join(cwd, 'config.txt'));

    expect(resolveDownload('out/deck.pptx', [cwd])).toBe(join(cwd, 'out', 'deck.pptx'));
    expect(resolveDownload(join(cwd, 'out', 'deck.pptx'), [cwd])).toBe(join(cwd, 'out', 'deck.pptx'));
    expect(resolveDownload('.git/config', [cwd])).toBeUndefined();
    expect(resolveDownload('.GIT/config', [cwd])).toBeUndefined(); // the same folder on a case-insensitive disk
    expect(resolveDownload('config.txt', [cwd])).toBeUndefined(); // a link into .git
    expect(resolveDownload('escape.pdf', [cwd])).toBeUndefined(); // a link out of the directory
    expect(resolveDownload('../downloads-outside/other.pdf', [cwd])).toBeUndefined();
    expect(resolveDownload(join(outside, 'other.pdf'), [cwd])).toBeUndefined();
    expect(resolveDownload('out', [cwd])).toBeUndefined(); // a folder
    expect(resolveDownload('missing.pdf', [cwd])).toBeUndefined();
    expect(resolveDownload('', [cwd])).toBeUndefined();
    expect(resolveDownload('a\0b', [cwd])).toBeUndefined();
    // Later roots are tried in turn.
    expect(resolveDownload('other.pdf', [cwd, outside])).toBe(join(outside, 'other.pdf'));
  });
});
