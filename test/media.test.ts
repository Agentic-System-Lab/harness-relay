import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileName, isVideo, localFilePath, localMediaPath, mediaType } from '../src/shared/media';
import type { ChatMessage, Conversation } from '../src/shared/types';
import { attachmentsDir } from '../src/server/attachments';
import { byteRange, contentDisposition, downloadProblem, mediaRoots, replyWorktrees, resolveDownload, resolveMedia } from '../src/server/media';

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
    expect(localFilePath('src/app.ts:10-20')).toBe('src/app.ts');
    expect(localFilePath('src/app.ts#L42')).toBe('src/app.ts');
    expect(localFilePath('file:///C:/Users/me/report.pdf')).toBe('C:/Users/me/report.pdf');
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
      // Another computer's share: on Windows, even looking it up would connect to it.
      '\\\\host\\share\\a.pdf',
      '%5C%5Chost%5Cshare%5Ca.pdf',
      '/%2Fhost/share/a.pdf',
      'file:////host/share/a.pdf',
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
    expect(resolveDownload('//host/share/a.pdf', [cwd])).toBeUndefined();
  });

  it('says why a file cannot be downloaded: not there, or outside the directories (or in .git)', () => {
    const cwd = join(root, 'problems');
    const outside = join(root, 'problems-outside');
    mkdirSync(join(cwd, 'out'), { recursive: true });
    mkdirSync(join(cwd, '.git'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(cwd, '.git', 'config'), 'secret');
    writeFileSync(join(outside, 'other.pdf'), 'pdf');
    symlinkSync(join(outside, 'other.pdf'), join(cwd, 'escape.pdf'));
    symlinkSync(join(cwd, '.git', 'config'), join(cwd, 'config.txt'));

    expect(downloadProblem('missing.pdf', [cwd])).toBe('missing');
    expect(downloadProblem('out', [cwd])).toBe('missing'); // a folder
    expect(downloadProblem('', [cwd])).toBe('missing');
    expect(downloadProblem('.git/config', [cwd])).toBe('outside');
    expect(downloadProblem('.GIT/config', [cwd])).toBe('outside');
    expect(downloadProblem('config.txt', [cwd])).toBe('outside'); // a link into .git
    expect(downloadProblem('escape.pdf', [cwd])).toBe('outside'); // a link out of the directory
    expect(downloadProblem('../problems-outside/other.pdf', [cwd])).toBe('outside');
    expect(downloadProblem(join(outside, 'other.pdf'), [cwd])).toBe('outside');
    expect(downloadProblem('/etc/hosts', [cwd])).toBe('outside');
    // Missing in one root, and not allowed in none: missing.
    expect(downloadProblem('gone.md', [cwd, join(root, 'no-such-root')])).toBe('missing');
  });

  /** A folder of its own with out/deck.pptx and .git/config, so each test runs alone too. */
  function project(name: string): string {
    const dir = join(root, name);
    mkdirSync(join(dir, 'out'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'out', 'deck.pptx'), 'pptx');
    writeFileSync(join(dir, '.git', 'config'), 'secret');
    return dir;
  }

  it('looks nothing up outside the directories, not even a link there that leads back in', () => {
    // Followed, this would resolve inside; but a path outside is never touched (on Windows a
    // \\host\share path would make this computer connect to another one).
    const dir = project('lookup');
    const back = join(root, 'lookup-back.pptx');
    symlinkSync(join(dir, 'out', 'deck.pptx'), back);
    expect(resolveDownload(join(dir, 'out', 'deck.pptx'), [dir])).toBe(join(dir, 'out', 'deck.pptx'));
    expect(resolveDownload(back, [dir])).toBeUndefined();
    expect(resolveDownload('../lookup-back.pptx', [dir])).toBeUndefined();
  });

  it('takes an absolute path written through a link to the root, as the agent sees the folder', () => {
    const dir = project('through-link');
    const linked = join(root, 'through-link-alias');
    symlinkSync(dir, linked);
    expect(resolveDownload(join(linked, 'out', 'deck.pptx'), [linked])).toBe(join(dir, 'out', 'deck.pptx'));
    expect(resolveDownload(join(linked, '.git', 'config'), [linked])).toBeUndefined();
  });

  it('looks in the agent’s own worktree first for an isolated turn, then the working directory, then the attachments', () => {
    const cwd = join(root, 'roots-cwd');
    const wt = join(root, 'roots-wt');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(wt, { recursive: true });
    const conv = {
      id: 'c1',
      settings: { cwd },
      worktrees: { a: [{ root: cwd, path: wt, branch: 'relay/a', base: 'x', needsReset: false }] },
    } as unknown as Conversation;
    const reply = (isolated: boolean) =>
      ({
        id: 'm',
        author: { kind: 'agent', agentId: 'a' },
        parts: [],
        changes: [{ root: cwd, base: 'x', head: 'y', files: [], isolated }],
      }) as unknown as ChatMessage;
    expect(mediaRoots(conv, reply(true))).toEqual([wt, cwd, attachmentsDir('c1')]);
    expect(mediaRoots(conv, reply(false))).toEqual([cwd, wt, attachmentsDir('c1')]);
    const user = { id: 'u', author: { kind: 'user' }, parts: [] } as unknown as ChatMessage;
    expect(mediaRoots(conv, user)).toEqual([cwd, attachmentsDir('c1')]);
  });

  it('with several working directories, looks in each one, inside every worktree of its repository', () => {
    const [a, b] = ['roots-a', 'roots-b'].map((name) => join(root, name));
    const [wtA, wtB] = ['roots-wt-a', 'roots-wt-b'].map((name) => join(root, name));
    for (const dir of [a, b, wtA, wtB]) mkdirSync(dir, { recursive: true });
    const conv = {
      id: 'c2',
      settings: { cwd: a, extraCwds: [b] },
      worktrees: {
        x: [
          { root: a, path: wtA, branch: 'relay/x', base: 'p', needsReset: false },
          { root: b, path: wtB, branch: 'relay/x', base: 'q', needsReset: false },
        ],
      },
    } as unknown as Conversation;
    const reply = (isolated: boolean) =>
      ({
        id: 'm',
        author: { kind: 'agent', agentId: 'x' },
        parts: [],
        changes: [
          { root: a, base: 'p', head: 'p2', files: [], isolated, branch: 'relay/x' },
          { root: b, base: 'q', head: 'q2', files: [], isolated, branch: 'relay/x' },
        ],
      }) as unknown as ChatMessage;
    // Each worktree holds its own working directory only.
    expect(mediaRoots(conv, reply(true))).toEqual([wtA, wtB, a, b, attachmentsDir('c2')]);
    expect(mediaRoots(conv, reply(false))).toEqual([a, b, wtA, wtB, attachmentsDir('c2')]);
  });

  it("finds a copied parallel reply's worktree in the conversation it was branched from, further up for a branch of a branch", () => {
    const wt = (branch: string) => [{ root: '/repo', path: `/wt/${branch}`, branch, base: 'x', needsReset: false }];
    const reply = {
      id: 'm',
      author: { kind: 'agent', agentId: 'a' },
      parts: [],
      changes: [{ root: '/repo', base: 'x', head: 'y', files: [], isolated: true, branch: 'relay/c0/Alice' }],
    } as unknown as ChatMessage;
    const conv = (id: string, from?: string, branch?: string) =>
      ({ id, worktrees: branch ? { a: wt(branch) } : {}, ...(from ? { branch: { fromId: from, fromTitle: '', afterId: 'm' } } : {}) }) as unknown as Conversation;
    const all = new Map([conv('c0', undefined, 'relay/c0/Alice'), conv('c1', 'c0', 'relay/c1/Alice'), conv('c2', 'c1')].map((c) => [c.id, c]));
    const lookup = (id: string) => all.get(id);
    expect(replyWorktrees(all.get('c0')!, reply, lookup)[0]?.branch).toBe('relay/c0/Alice');
    // Not the branch's own worktree for that agent, which holds other work.
    expect(replyWorktrees(all.get('c1')!, reply, lookup)[0]?.branch).toBe('relay/c0/Alice');
    expect(replyWorktrees(all.get('c2')!, reply, lookup)[0]?.branch).toBe('relay/c0/Alice');
    // The original is gone: nowhere.
    expect(replyWorktrees(all.get('c2')!, reply, (id) => (id === 'c0' ? undefined : lookup(id)))).toEqual([]);
    // A branch whose earlier copied messages were written in c0, while the one it was branched from is
    // gone (or no longer a branch): found in c0 through that part.
    const c3 = { ...conv('c3', 'gone'), branch: { fromId: 'gone', fromTitle: '', afterId: 'm', earlier: [{ fromId: 'c0', fromTitle: '', afterId: 'm' }] } };
    expect(replyWorktrees(c3, reply, lookup)[0]?.branch).toBe('relay/c0/Alice');
    // A loop of branches ends.
    const loop = new Map([conv('x', 'y'), conv('y', 'x')].map((c) => [c.id, c]));
    expect(replyWorktrees(loop.get('x')!, reply, (id) => loop.get(id))).toEqual([]);
  });

  it('names the file for saving, safely for any name', () => {
    expect(contentDisposition('attachment', 'deck.pptx')).toBe(`attachment; filename="deck.pptx"; filename*=UTF-8''deck.pptx`);
    // ' ( ) * are not allowed unencoded in filename* (RFC 5987).
    expect(contentDisposition('attachment', "Jimmy's deck (1)*.pptx")).toBe(
      `attachment; filename="Jimmy's deck (1)*.pptx"; filename*=UTF-8''Jimmy%27s%20deck%20%281%29%2A.pptx`,
    );
    expect(contentDisposition('inline', 'Q3 報告 "final" \\ 100%.pdf')).toBe(
      `inline; filename="Q3 __ _final_ _ 100_.pdf"; filename*=UTF-8''Q3%20%E5%A0%B1%E5%91%8A%20%22final%22%20%5C%20100%25.pdf`,
    );
  });
});
