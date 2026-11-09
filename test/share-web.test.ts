import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHARE_MAX_BYTES, type ChatMessage } from '../src/shared/types';
import {
  HARNESS_RELAY_URL,
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

  it('leaves out tool calls and thinking, and the app-only controls', () => {
    for (const s of ['.tool-group', '.approval-card', '.approval-done', '.todo', '.changes-card', '.chat-head-actions', '.file-missing', '.plan-ask-save']) {
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

  it("carries Harness Relay's name, logo and website", () => {
    const foot = shareFooter({ logo: '<svg class="brand-logo"></svg>', tagline: 'A <group> chat', note: 'Shared today' });
    expect(foot).toContain('<svg class="brand-logo"></svg><span>Harness Relay</span>');
    expect(foot).toContain(`href="${HARNESS_RELAY_URL}"`);
    expect(foot).toContain('>agentic-system-lab.github.io/harness-relay</a>');
    expect(foot).toContain('A &lt;group&gt; chat');
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
