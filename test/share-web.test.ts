import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SHARE_FILES_MAX,
  SHARE_FILES_MAX_BYTES,
  SHARE_FILE_LINKS_MAX,
  SHARE_FILE_URL_MAX,
  SHARE_MAX_BYTES,
  type ChatMessage,
  type ShareFileInfo,
} from '../src/shared/types';
import { fileLinkCount, fileLinksIn, replaceFileLinks, shareFileHref, shareSize } from '../src/shared/share';
import {
  HARNESS_RELAY_URL,
  anchorPlan,
  chosenFileRefs,
  defaultFileSelection,
  fileLinkRoom,
  fileRefOf,
  fileRefsOf,
  fileSelection,
  filesGistUrl,
  linkedFileRefs,
  looksSecret,
  nextFileSelection,
  SHARE_CSP,
  SHARE_DROP,
  SHARE_KEEP_BUTTONS,
  stillStreaming,
  byteLength,
  escapeHtml,
  keepImages,
  linkKept,
  messagesUpTo,
  shareDocument,
  shareFooter,
  shareScope,
  ghProblem,
  GH_INSTALL,
  GH_LINKS,
} from '../src/web/share';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

const msg = (id: string): ChatMessage => ({ id, author: { kind: 'user' }, parts: [], status: 'done', createdAt: 0 }) as unknown as ChatMessage;

describe('what a shared page holds', () => {
  it('is every message, or those up to and including one reply', () => {
    const all = [msg('a'), msg('b'), msg('c')];
    expect(messagesUpTo(all)?.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(messagesUpTo(all, 'b')?.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('is nothing, never the whole conversation, once the reply it is up to is gone', () => {
    expect(messagesUpTo([msg('a'), msg('b')], 'retried')).toBeUndefined();
  });

  it('waits for a reply still being written', () => {
    const live = { ...msg('b'), status: 'streaming' } as ChatMessage;
    expect(stillStreaming([msg('a'), live])).toBe(true);
    expect(stillStreaming([msg('a'), msg('b')])).toBe(false);
  });

  it("leaves out the app's own elements by the class names its components really use", () => {
    const dir = join(__dirname, '../src/web/components');
    const source = readdirSync(dir)
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    // A renamed class would let tool calls or thinking onto shared pages without a word.
    for (const cls of [...SHARE_DROP.map((s) => s.slice(1)), ...SHARE_KEEP_BUTTONS]) {
      // A whole class name: `todo` must not pass on `todo-head`.
      expect(source, cls).toMatch(new RegExp(`className=\\{?["'\`][^"'\`]*(?<![\\w-])${cls}(?![\\w-])`));
    }
  });

  it('leaves out tool calls and thinking, the app-only controls, and the header badges', () => {
    for (const s of [
      '.tool-group',
      '.approval-card',
      '.approval-done',
      '.todo',
      '.changes-card',
      '.chat-head-actions',
      '.file-missing',
      '.plan-ask-save',
      // Mode and rounds, the file permission and the schedule; the full-access warning beside the title.
      '.chat-head-badges',
      '.head-warning',
    ]) {
      expect(SHARE_DROP).toContain(s);
    }
  });

  it('keeps only links that go somewhere outside the app', () => {
    expect(linkKept('https://example.com/a')).toBe(true);
    expect(linkKept('mailto:me@example.com')).toBe(true);
    expect(linkKept('/api/conversations/x/messages/y/download?path=a.txt')).toBe(false);
    expect(linkKept('javascript:alert(1)')).toBe(false);
    expect(linkKept(null)).toBe(false);
  });
});

describe('fitting images in the page', () => {
  it('keeps them all when they fit', () => {
    expect(keepImages(100, [50, 50], 200)).toEqual([true, true]);
  });

  it('leaves out the largest first, and those it could not read', () => {
    expect(keepImages(100, [60, 90, 30], 200)).toEqual([true, false, true]);
    expect(keepImages(100, [undefined, 50], 200)).toEqual([false, true]);
    expect(keepImages(100, [150, 120], 200)).toEqual([false, false]);
  });

  it('cannot fit a page too large without images', () => {
    expect(keepImages(SHARE_MAX_BYTES + 1, [])).toBeNull();
  });

  it('measures the page in UTF-8 bytes, as GitHub does', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('分享')).toBe(6);
  });
});

describe('the shared page', () => {
  const page = shareDocument({
    lang: 'zh-TW',
    title: 'A <b>plan</b> & "more"',
    css: '.a{color:red}</style><script>x</script>',
    body: '<div class="chat"></div>',
    icon: 'data:image/svg+xml,%3Csvg%3E',
  });

  it('loads nothing from anywhere and runs no scripts', () => {
    expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${SHARE_CSP}">`);
    expect(SHARE_CSP).toContain("default-src 'none'");
    expect(SHARE_CSP).not.toMatch(/script-src|https?:/);
    expect(page).not.toContain('</style><script>');
  });

  it('is titled by the conversation, escaped', () => {
    expect(page).toContain('<title>A &lt;b&gt;plan&lt;/b&gt; &amp; &quot;more&quot; · Harness Relay</title>');
    expect(page).toContain('<html lang="zh-TW">');
    expect(page.startsWith('<!doctype html>')).toBe(true);
  });

  it('takes an icon only as a data URL', () => {
    expect(page).toContain('<link rel="icon" href="data:image/svg+xml,%3Csvg%3E">');
    expect(shareDocument({ lang: 'en', title: 't', css: '', body: '', icon: 'https://evil.example/i.png' })).not.toContain('rel="icon"');
  });

  it("carries Harness Relay's name and logo, and a link icon beside the time; both link to its website", () => {
    const foot = shareFooter({
      logo: '<svg class="brand-logo"></svg>',
      icon: '<svg class="share"></svg>',
      tagline: 'A <group> chat',
      note: 'Shared <today>',
      siteLabel: 'Harness Relay\'s "website"',
    });
    expect(foot).toContain('<svg class="brand-logo"></svg><span>Harness Relay</span>');
    expect(foot).toContain('A &lt;group&gt; chat');
    // The logo and the icon go to the same place; the address itself is not shown.
    const links = [...foot.matchAll(/<a class="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual([
      ['share-brand-name', HARNESS_RELAY_URL],
      ['share-brand-site', HARNESS_RELAY_URL],
    ]);
    expect(foot).not.toContain('>agentic-system-lab.github.io');
    // The icon follows the time, and is named for screen readers.
    expect(foot).toContain(
      '<span class="share-brand-shared"><span class="share-brand-note">Shared &lt;today&gt;</span>' +
        `<a class="share-brand-site" href="${HARNESS_RELAY_URL}" target="_blank" rel="noopener noreferrer" ` +
        'aria-label="Harness Relay\'s &quot;website&quot;" title="Harness Relay\'s &quot;website&quot;"><svg class="share"></svg></a></span>',
    );
    expect(HARNESS_RELAY_URL).toBe('https://agentic-system-lab.github.io/harness-relay/');
  });
});

describe('escapeHtml', () => {
  it('escapes what could end text or an attribute', () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});

describe('the list of shares in Settings', () => {
  it('says what each holds', () => {
    expect(shareScope({}, en)).toBe('Whole conversation');
    expect(shareScope({ upTo: { messageId: 'm1', agentName: 'builder' } }, en)).toBe("Up to @builder's reply");
    expect(shareScope({ upTo: { messageId: 'm1', agentName: 'builder' } }, zhTW)).toBe('到 @builder 的回覆');
  });
});

describe('when the GitHub CLI cannot be used', () => {
  it('tells a missing gh and a signed-out one apart from other errors', () => {
    expect(ghProblem({ message: 'x', code: 'gh-missing' })).toBe('gh-missing');
    expect(ghProblem({ message: 'x', code: 'gh-signed-out' })).toBe('gh-signed-out');
    expect(ghProblem({ message: 'x', code: 'cwd-missing' })).toBeUndefined();
    expect(ghProblem(new Error('x'))).toBeUndefined();
    expect(ghProblem(null)).toBeUndefined();
  });

  it('points to the official install commands and pages', () => {
    expect(GH_INSTALL).toEqual({ macos: 'brew install gh', windows: 'winget install --id GitHub.cli --source winget' });
    for (const url of Object.values(GH_LINKS)) expect(url).toMatch(/^https:\/\/(cli\.)?github\.com\//);
  });
});

describe('the files a shared page links to', () => {
  const CONV = 'c-1';
  const href = (mid: string, path: string, conv = CONV) => `/api/conversations/${conv}/messages/${mid}/download?path=${encodeURIComponent(path)}`;

  it("reads which reply's file a download link of this conversation names", () => {
    expect(fileRefOf(href('r1', 'out/Q3 報告.md'), CONV)).toEqual({ messageId: 'r1', path: 'out/Q3 報告.md' });
    expect(fileRefOf(href('r1', '/Users/me/p/a&b.csv'), CONV)).toEqual({ messageId: 'r1', path: '/Users/me/p/a&b.csv' });
    // Another conversation's, another of the app's links, a site, a link without a path: none.
    expect(fileRefOf(href('r1', 'a.md', 'c-2'), CONV)).toBeUndefined();
    expect(fileRefOf(`/api/conversations/${CONV}/messages/r1/media?path=a.png`, CONV)).toBeUndefined();
    expect(fileRefOf(`/api/conversations/${CONV}/files/download?root=cwd&path=a.md`, CONV)).toBeUndefined();
    expect(fileRefOf('https://example.com/api/conversations/c-1/messages/r1/download?path=a.md', CONV)).toBeUndefined();
    expect(fileRefOf(`/api/conversations/${CONV}/messages/r1/download`, CONV)).toBeUndefined();
    expect(fileRefOf(null, CONV)).toBeUndefined();
  });

  it('collects each link once, in order, up to a limit', () => {
    const hrefs = [href('r1', 'a.md'), 'https://example.com', href('r2', 'a.md'), href('r1', 'a.md'), null, href('r1', 'b.md')];
    expect(fileRefsOf(hrefs, CONV)).toEqual([
      { messageId: 'r1', path: 'a.md' },
      { messageId: 'r2', path: 'a.md' },
      { messageId: 'r1', path: 'b.md' },
    ]);
    expect(fileRefsOf(hrefs, CONV, 2)).toHaveLength(2);
    const many = Array.from({ length: SHARE_FILE_LINKS_MAX + 5 }, (_, i) => href('r1', `${i}.md`));
    expect(fileRefsOf(many, CONV)).toHaveLength(SHARE_FILE_LINKS_MAX);
  });

  const file = (name: string, size: number, refs: number[], problem?: ShareFileInfo['problem']): ShareFileInfo => ({
    name,
    path: `out/${name}`,
    size,
    refs,
    ...(problem ? { problem } : {}),
  });

  it('includes at first each file that can go along, while they fit in the limits', () => {
    const files = [file('a.md', 10, [0]), file('b.png', 10, [1], 'binary'), file('c.md', 20, [2, 3]), file('big.csv', 2_000_000, [4], 'too-large')];
    expect(defaultFileSelection(files)).toEqual([true, false, true, false]);
    expect(fileSelection(files, [true, false, true, false])).toEqual({ count: 2, bytes: 30 });
    // A file that cannot go along never counts, even when checked.
    expect(fileSelection(files, [true, true, true, true])).toEqual({ count: 2, bytes: 30 });

    const heavy = Array.from({ length: 6 }, (_, i) => file(`${i}.csv`, 999_999, [i]));
    expect(defaultFileSelection(heavy)).toEqual([true, true, true, true, true, false]);
    expect(fileSelection(heavy, heavy.map(() => true))).toMatchObject({ count: 6, over: 'bytes' });
    expect(5 * 999_999).toBeLessThanOrEqual(SHARE_FILES_MAX_BYTES);

    const lots = Array.from({ length: SHARE_FILES_MAX + 1 }, (_, i) => file(`${i}.md`, 1, [i]));
    expect(defaultFileSelection(lots).filter(Boolean)).toHaveLength(SHARE_FILES_MAX);
    expect(fileSelection(lots, lots.map(() => true)).over).toBe('count');
  });

  it('sends the links of the files chosen, in the order the replies have them', () => {
    const refs = ['a', 'b', 'c', 'd', 'e'].map((p) => ({ messageId: 'r1', path: p }));
    const files = [file('c', 1, [2, 0]), file('b', 1, [1], 'missing'), file('d', 1, [3]), file('e', 1, [4])];
    expect(chosenFileRefs(refs, files, [true, true, false, true]).map((r) => r.path)).toEqual(['a', 'c', 'e']);
    expect(chosenFileRefs(refs, files, [false, false, false, false])).toEqual([]);
  });

  it('gives sizes as the limits count them', () => {
    expect(shareSize(999)).toBe('999 B');
    expect(shareSize(1_500)).toBe('2 KB');
    expect(shareSize(999_999)).toBe('999 KB');
    expect(shareSize(1_000_000)).toBe('1 MB');
    expect(shareSize(SHARE_FILES_MAX_BYTES)).toBe('5 MB');
    expect(shareSize(1_250_000)).toBe('1.3 MB');
  });

  it('marks the links to files with placeholders the server fills in, escaped', () => {
    const html = `<a href="${shareFileHref(1)}" class="file-link">b</a><a class="x" href="${shareFileHref(0)}">a</a><a href="${shareFileHref(1)}">b</a><code>href="relay-share-file:x"</code>`;
    expect(fileLinksIn(html)).toEqual([1, 0]);
    expect(fileLinkCount(html)).toBe(3);
    const out = replaceFileLinks(html, (n) => (n === 1 ? 'https://gist.githubusercontent.com/me/x/raw/a"b&c' : undefined));
    expect(out).toBe(
      `<a href="https://gist.githubusercontent.com/me/x/raw/a&quot;b&amp;c" class="file-link">b</a><a class="x" href="${shareFileHref(0)}">a</a><a href="https://gist.githubusercontent.com/me/x/raw/a&quot;b&amp;c">b</a><code>href="relay-share-file:x"</code>`,
    );
  });

  it('takes text of the chat that reads like a placeholder, digits and all, for text', () => {
    // How a page serializes a reply (or a title) that writes the placeholder out: in text, and in a
    // tooltip, where the quotes are escaped.
    const text = `<p>Try href="relay-share-file:0" or <code>&lt;a href="relay-share-file:12"&gt;</code></p><span title="href=&quot;relay-share-file:3&quot;">x</span><h1>href="relay-share-file:7"</h1>`;
    expect(fileLinksIn(text)).toEqual([]);
    expect(fileLinkCount(text)).toBe(0);
    expect(replaceFileLinks(text, () => 'https://example.com')).toBe(text);
    // Next to a real link, only the link counts.
    const both = `${text}<a class="file-link" href="${shareFileHref(2)}">real</a>`;
    expect(fileLinksIn(both)).toEqual([2]);
    expect(replaceFileLinks(both, () => 'https://gist.githubusercontent.com/u/x/raw/r.md')).toBe(
      `${text}<a class="file-link" href="https://gist.githubusercontent.com/u/x/raw/r.md">real</a>`,
    );
  });

  it("knows a share's files gist on GitHub", () => {
    expect(filesGistUrl('f0f1f2f3f4f5f6f7f8f9')).toBe('https://gist.github.com/f0f1f2f3f4f5f6f7f8f9');
  });

  it('leaves files that may hold secrets unchecked at first', () => {
    for (const name of ['.env', '.env.local', '.npmrc', '.netrc', 'server.pem', 'tls.key', 'id_rsa', 'id_ed25519.pub', 'client_secret.json', 'credentials.csv', 'passwords.txt', 'api-token.txt', 'API_KEY.md', 'private_key.txt']) {
      expect(looksSecret(name), name).toBe(true);
    }
    for (const name of ['report.md', 'data.csv', 'keys.md', 'notes.txt', 'index.html', 'monkey.md']) expect(looksSecret(name), name).toBe(false);
    const files = [file('report.md', 10, [0]), file('.env', 10, [1]), file('id_rsa', 10, [2]), file('notes.md', 10, [3])];
    expect(defaultFileSelection(files)).toEqual([true, false, false, true]);
    // Still the user's to choose.
    expect(fileSelection(files, [true, true, false, true])).toEqual({ count: 3, bytes: 30 });
  });

  it("keeps the user's choices when the files are checked again, and chooses only new files by default", () => {
    const first = [file('report.md', 10, [0]), file('data.csv', 10, [1]), file('.env', 10, [2])];
    // The user leaves data.csv out and takes .env along.
    const chosen = [true, false, true];
    // Checked again (a reply finished, or a share was refused): one more file, one that can no longer go.
    const again = [file('report.md', 12, [0]), file('data.csv', 10, [1]), file('.env', 10, [2]), file('new.md', 5, [3]), file('.npmrc', 5, [4])];
    expect(nextFileSelection(again, { list: first, chosen })).toEqual([true, false, true, true, false]);
    // A file that cannot go along any more is not chosen; once it can again, it is new to the user.
    const broken = [file('report.md', 12, [0], 'missing'), file('data.csv', 10, [1])];
    const afterBroken = nextFileSelection(broken, { list: first, chosen });
    expect(afterBroken).toEqual([false, false]);
    expect(nextFileSelection(first, { list: broken, chosen: afterBroken })).toEqual([true, false, false]);
    // New files are chosen only while those kept leave room.
    const full = Array.from({ length: SHARE_FILES_MAX }, (_, i) => file(`${i}.md`, 1, [i]));
    const more = [...full, file('extra.md', 1, [SHARE_FILES_MAX])];
    expect(nextFileSelection(more, { list: full, chosen: full.map(() => true) }).at(-1)).toBe(false);
    // Without a list before, the default.
    expect(nextFileSelection(first)).toEqual(defaultFileSelection(first));
  });

  it('makes each link of the page a placeholder, plain text or a link, and leaves room for the addresses', () => {
    const files = [{ messageId: 'r1', path: 'out/a.md' }, { messageId: 'r2', path: 'b.md' }];
    const a = (href: string | null, fileLink = false, dropped = false) => ({ href, fileLink, dropped });
    const plans = [
      anchorPlan(a(href('r2', 'b.md'), true), CONV, files),
      anchorPlan(a(href('r1', 'out/a.md'), true), CONV, files),
      anchorPlan(a(href('r1', 'out/left-behind.md'), true), CONV, files), // not chosen
      anchorPlan(a(href('r1', 'out/a.md', 'c-2'), true), CONV, files), // another conversation's
      anchorPlan(a('https://example.com/x'), CONV, files),
      anchorPlan(a('mailto:me@example.com'), CONV, files),
      anchorPlan(a('#/c/c-1'), CONV, files), // into the app
      anchorPlan(a(href('r1', 'out/a.md'), true, true), CONV, files), // in a tool call the page leaves out
    ];
    expect(plans).toEqual([
      { as: 'link', href: shareFileHref(1), remove: ['download'], file: true },
      { as: 'link', href: shareFileHref(0), remove: ['download'], file: true },
      // Files left behind: plain text without the download icon, which would promise a download.
      { as: 'text', icon: false },
      { as: 'text' },
      { as: 'link', href: 'https://example.com/x', remove: [], file: false },
      { as: 'link', href: 'mailto:me@example.com', remove: [], file: false },
      { as: 'text' },
      { as: 'gone' },
    ]);
    expect(fileLinkRoom(plans)).toBe(2 * SHARE_FILE_URL_MAX);
    expect(fileLinkRoom([])).toBe(0);
    // Not a FileLink (an image link to the same address, say): never a placeholder.
    expect(anchorPlan(a(href('r1', 'out/a.md')), CONV, files)).toEqual({ as: 'text' });
  });

  it("lists the files the page's links download, not those in parts it leaves out", () => {
    const anchors = [
      { href: href('r1', 'a.md'), fileLink: true, dropped: false },
      { href: href('r1', 'tool-output.md'), fileLink: true, dropped: true },
      { href: 'https://example.com', fileLink: false, dropped: false },
      { href: href('r1', 'a.md'), fileLink: true, dropped: false },
      { href: href('r2', 'b.md'), fileLink: true, dropped: false },
    ];
    expect(linkedFileRefs(anchors, CONV)).toEqual([
      { messageId: 'r1', path: 'a.md' },
      { messageId: 'r2', path: 'b.md' },
    ]);
  });
});
