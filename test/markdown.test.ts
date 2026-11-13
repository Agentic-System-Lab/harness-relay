import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../src/shared/types';
import { parseMentions } from '../src/server/prompt';
import { FileLink, Markdown, findMentions, mermaidSource, tableCellClass, textWidthEm } from '../src/web/components/Markdown';
import { CHECK_DELAY_MS, checkDownload, checkLater, fileClicks } from '../src/web/download';
import { I18nProvider, currentLang, loadMessages } from '../src/web/i18n';

// As the page does before it draws anything: its language's messages, which load on their own.
beforeAll(() => loadMessages(currentLang()));

const html = (text: string, mentions = ['Claude', 'Bob']) =>
  renderToStaticMarkup(createElement(I18nProvider, null, createElement(Markdown, { text, mentions })));
const chip = (name: string) => `<span class="mention">${name}</span>`;

describe('@mention chips', () => {
  it('highlights mentions in prose, but not in code or link text', () => {
    expect(html('ask @Claude and @bob, or @user')).toContain(`ask ${chip('@Claude')} and ${chip('@bob')}, or ${chip('@user')}`);
    expect(html('**@Claude** please')).toContain(`<strong>${chip('@Claude')}</strong>`);
    const out = html(
      [
        'Inline `ask @Claude` here.',
        '',
        '~~~',
        'ping @Claude',
        '~~~',
        '',
        '````',
        '```',
        '@Claude inside a longer fence',
        '````',
        '',
        '    @Claude in an indented block',
        '',
        '[ask @Claude](https://example.com)',
      ].join('\n'),
    );
    expect(out).not.toContain('class="mention"');
    expect(out).not.toContain('#mention');
    expect(out).toContain('<code>ask @Claude</code>');
    expect(out).toContain('>ask @Claude</a>');
  });

  it('follows the server rule for where a mention starts and ends', () => {
    const agents: AgentConfig[] = ['Bob', 'Bobby', '小明', 'Builder'].map((name) => ({ id: name, name, provider: 'claude', role: '' }));
    const names = agents.map((a) => a.name);
    const texts = [
      '@Builder請實作',
      '請 @小明檢查',
      '@Bobby and @Bob-x and @Bob.',
      'mail bob@Bob.com, a.@Bob, @@Bob',
      'x@Bob (@BOB) 「@Bob」',
      '@Bobbyx @Bob_ @Bob!',
    ];
    for (const text of texts) {
      const fromServer = parseMentions(text, agents).map((a) => a.name);
      const found = findMentions(text, names).map(({ start, end }) => text.slice(start + 1, end).toLowerCase());
      const chips = [...new Set(found)].map((n) => names.find((x) => x.toLowerCase() === n));
      expect(chips, text).toEqual(fromServer);
    }
    expect(html('@Builder請實作', ['Builder'])).toContain(`${chip('@Builder')}請實作`);
    expect(html('@Bobby', ['Bob'])).not.toContain('class="mention"');
  });
});

describe('chips and the server agree on Markdown structure', () => {
  const agents: AgentConfig[] = ['Claude', 'Builder', 'Bob'].map((name) => ({ id: name, name, provider: 'claude', role: '' }));
  const names = agents.map((a) => a.name);
  /** Names of the chips the UI renders, first appearance first. */
  const chips = (text: string) =>
    [...new Set([...html(text, names).matchAll(/<span class="mention">@([^<]+)<\/span>/g)].map((m) => m[1]!.toLowerCase()))].map(
      (n) => names.find((x) => x.toLowerCase() === n)!,
    );

  it('in links, URLs, code of every kind, quotes, lists and emphasis', () => {
    const texts = [
      '[ask @Claude](https://x.example) then @Bob',
      'see https://github.com/@Claude/x and mail bob@Builder.dev',
      '    @Claude in indented code\n\nthen @Bob',
      '> ```\n> @Claude\n> ```\n\n@Bob',
      '1. step\n\n       ```java\n       @Builder\n       ```\n\n2. @Bob',
      '`two-line\n@Claude code` and @Bob',
      '_@Claude_ and __@Bob__ and _note_@Builder',
      '@Builder請實作，@Claude 檢查',
      '```ts\nconst a = "@Builder";',
      '看https://x.example/pr/1請@Builder處理，<https://x.example/請@Claude>',
    ];
    for (const text of texts) expect(chips(text), text).toEqual(parseMentions(text, agents).map((a) => a.name));
    // A Java annotation in a code block inside a list does not hand the floor to @Builder.
    expect(parseMentions(texts[4]!, agents).map((a) => a.name)).toEqual(['Bob']);
  });
});

describe('bare URLs', () => {
  it('end where Chinese text written right after them starts', () => {
    const out = html('檢查https://github.com/Canner/WrenAI-saas及https://github.com/Canner/wren-agent-stack是否有新的PR，說明');
    const link = (url: string) => `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`;
    expect(out).toContain(
      `<p>檢查${link('https://github.com/Canner/WrenAI-saas')}及${link('https://github.com/Canner/wren-agent-stack')}是否有新的PR，說明</p>`,
    );
    // Chinese that is part of the URL stays in the link.
    expect(html('https://zh.wikipedia.org/wiki/臺灣，見')).toContain('>https://zh.wikipedia.org/wiki/臺灣</a>，見');
  });
});

describe('images in agent output', () => {
  it('are links, never loaded', () => {
    const out = html('![tracker](https://evil.example/beacon.png?d=secret) and ![](https://evil.example/2.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('<a href="https://evil.example/beacon.png?d=secret" class="image-link" target="_blank" rel="noreferrer">tracker</a>');
    expect(out).toContain('>https://evil.example/2.png</a>');
    // Unsafe targets are still dropped.
    expect(html('[x](javascript:alert(1)) ![y](javascript:alert(2))')).not.toContain('javascript:');
  });

  it('covers reference images and images inside links, without nesting links', () => {
    const ref = html('![logo][l]\n\n[l]: https://evil.example/l.png');
    expect(ref).not.toContain('<img');
    expect(ref).toContain('href="https://evil.example/l.png"');
    const badge = html('[![build](https://evil.example/badge.svg)](https://ci.example)');
    expect(badge).not.toContain('<img');
    expect(badge).not.toContain('evil.example');
    expect(badge.match(/<a /g)).toHaveLength(1);
  });
});

describe('mermaid blocks', () => {
  it('are picked out by their language, with their source intact', () => {
    const pre = (className: string[], text: string) => ({
      type: 'element',
      tagName: 'pre',
      children: [{ type: 'element', tagName: 'code', properties: { className }, children: [{ type: 'text', value: text }] }],
    });
    expect(mermaidSource(pre(['language-mermaid'], 'flowchart TD\n  A --> B\n'))).toBe('flowchart TD\n  A --> B\n');
    expect(mermaidSource(pre(['hljs', 'language-mermaid'], 'graph LR'))).toBe('graph LR');
    expect(mermaidSource(pre(['language-ts'], 'const a = 1'))).toBeUndefined();
    expect(mermaidSource(undefined)).toBeUndefined();
  });

  it('show their source until the diagram is drawn, and leave other code blocks alone', () => {
    const out = html(['```mermaid', 'flowchart TD', '  A["a <b>b</b>"] --> B', '```', '', '```ts', 'const a = 1', '```'].join('\n'));
    expect(out).toContain('<div class="mermaid-block"><pre><code class="language-mermaid">flowchart TD\n  A[&quot;a &lt;b&gt;b&lt;/b&gt;&quot;] --&gt; B\n</code></pre></div>');
    expect(out).toContain('<pre><code class="hljs language-ts">');
  });
});

describe('tables', () => {
  it('measure text roughly: wide characters 1em, the rest about half', () => {
    expect(textWidthEm('結束條件')).toBe(4);
    expect(textWidthEm('Roundtable')).toBeCloseTo(5.5);
    expect(textWidthEm('最多 5 輪')).toBeCloseTo(3 + 3 * 0.55);
    expect(textWidthEm('')).toBe(0);
  });

  it('keep short cells on one line and let long ones wrap at a readable width', () => {
    for (const text of ['Roundtable', 'OK', '模式', '結束條件', '`Promise.allSettled`', ' 小表格 ']) expect(tableCellClass(text), text).toBe('one-line');
    for (const text of ['依隊伍順序一個接一個發言，後面的人看得到前面的發言', 'Speakers take turns in team order, each seeing earlier replies'])
      expect(tableCellClass(text), text).toBe('wrap');
  });

  it('mark each cell, and keep its alignment', () => {
    const out = html(['| 模式 | 排程 | OK |', '| --- | --- | :-: |', '| Roundtable | 依隊伍順序一個接一個發言，後面的人看得到前面的發言 | ✓ |'].join('\n'));
    expect(out).toContain('<th class="one-line">模式</th>');
    expect(out).toContain('<td class="one-line">Roundtable</td>');
    expect(out).toContain('<td class="wrap">依隊伍順序');
    expect(out).toContain('<th style="text-align:center" class="one-line">OK</th>');
  });
});

describe("the user's own messages", () => {
  const user = (text: string) =>
    renderToStaticMarkup(createElement(I18nProvider, null, createElement(Markdown, { text, mentions: ['Claude'], breaks: true })));

  it('keep each line break as typed', () => {
    expect(user('第一行\n第二行\r\n第三行')).toContain('<p>第一行<br/>\n第二行<br/>\n第三行</p>');
    expect(user('a\n\nb')).toContain('<p>a</p>\n<p>b</p>');
    // Agent replies stay plain Markdown: the lines of a paragraph are joined.
    expect(html('第一行\n第二行')).toContain('<p>第一行\n第二行</p>');
  });

  it('still mark mentions, and leave code and links alone', () => {
    expect(user('hi\n@Claude please')).toContain('<p>hi<br/>\n<span class="mention">@Claude</span> please</p>');
    expect(user('```\na\nb\n```')).toContain('<code>a\nb\n</code>');
    expect(user('`a\nb`')).not.toContain('<br/>');
    expect(user('[a\n@Claude](https://x.example)')).toContain('>a<br/>\n@Claude</a>');
  });
});

describe('images and videos from this computer', () => {
  const media = (text: string) =>
    renderToStaticMarkup(createElement(I18nProvider, null, createElement(Markdown, { text, mediaBase: '/api/conversations/c/messages/m/media' })));

  it('are shown through the app, while other sites stay links', () => {
    const out = media('Here: ![Sales](charts/sales.png) and ![remote](https://evil.example/x.png)');
    expect(out).toContain('<img class="chat-media" src="/api/conversations/c/messages/m/media?path=charts%2Fsales.png" alt="Sales"');
    expect(out).not.toContain('src="https://evil.example');
    expect(out).toContain('href="https://evil.example/x.png"');
    const video = media('![Demo](file:///Users/me/p/demo.mp4)');
    expect(video).toContain('<video class="chat-media" src="/api/conversations/c/messages/m/media?path=%2FUsers%2Fme%2Fp%2Fdemo.mp4"');
  });

  it('stay links without a media URL, inside links, and for other files', () => {
    expect(html('![Sales](charts/sales.png)')).not.toContain('<img');
    expect(media('[![Sales](charts/sales.png)](https://ci.example)')).not.toContain('<img');
    expect(media('![doc](docs/readme.md)')).not.toContain('<img');
  });

  it('are shown when written as reference images too', () => {
    const out = media('![Sales][s] and ![remote][r]\n\n[s]: charts/sales.png\n[r]: https://evil.example/x.png');
    expect(out).toContain('<img class="chat-media" src="/api/conversations/c/messages/m/media?path=charts%2Fsales.png" alt="Sales"');
    expect(out).not.toContain('src="https://evil.example');
    expect(out).toContain('<a href="https://evil.example/x.png" class="image-link" target="_blank" rel="noreferrer">remote</a>');
  });
});

describe('files a reply links to', () => {
  const base = '/api/conversations/c/messages/m/download';
  const reply = (text: string) =>
    renderToStaticMarkup(
      createElement(I18nProvider, null, createElement(Markdown, { text, mediaBase: '/api/conversations/c/messages/m/media', downloadBase: base })),
    );

  it('are downloaded through the app, also from another device', () => {
    const out = reply('Here is [the deck](out/deck.pptx) and [the report](</Users/me/p/Q3 report.pdf>).');
    expect(out).toContain(`<a href="${base}?path=out%2Fdeck.pptx" class="file-link" download="deck.pptx" title="Download deck.pptx">the deck<svg`);
    expect(out).toContain(`href="${base}?path=%2FUsers%2Fme%2Fp%2FQ3%20report.pdf"`);
    expect(out).toContain('download="Q3 report.pdf"');
    expect(out).not.toContain('target="_blank"');
    // A file: URL, which a browser would not open from a web page (and react-markdown would drop).
    expect(reply('<file:///Users/me/p/slides.html>')).toContain(`href="${base}?path=%2FUsers%2Fme%2Fp%2Fslides.html"`);
  });

  it('cover reference links and files written as images', () => {
    const ref = reply('See [the deck][d] and [notes].\n\n[d]: out/deck.pptx\n[notes]: https://example.com/notes');
    expect(ref).toContain(`href="${base}?path=out%2Fdeck.pptx"`);
    expect(ref).toContain('<a href="https://example.com/notes" target="_blank" rel="noreferrer">notes</a>');
    const asImage = reply('![report](out/report.pdf)');
    expect(asImage).toContain(`href="${base}?path=out%2Freport.pdf"`);
    expect(asImage).toContain('class="image-link file-link"');
    // A local image is still shown, and a link around it downloads what it points to.
    const wrapped = reply('[![chart](out/chart.png)](out/data.csv)');
    expect(wrapped).toContain(`href="${base}?path=out%2Fdata.csv"`);
    expect(wrapped).not.toContain('<img');
  });

  it('leave links to sites, anchors and folders alone, and every link without a download URL', () => {
    const out = reply('[site](https://example.com/a.pdf) [mail](mailto:me@example.com) [top](#top) [folder](out/)');
    expect(out).not.toContain('file-link');
    expect(out).toContain('<a href="https://example.com/a.pdf" target="_blank" rel="noreferrer">site</a>');
    expect(out).toContain('<a href="out/" target="_blank" rel="noreferrer">folder</a>');
    expect(html('[the deck](out/deck.pptx)')).toContain('<a href="out/deck.pptx" target="_blank" rel="noreferrer">the deck</a>');
  });

  it('drop a line number or anchor, and name the download, not the agent’s title', () => {
    expect(reply('[app.ts](src/app.ts:10-20)')).toContain(`href="${base}?path=src%2Fapp.ts"`);
    expect(reply('[app.ts](src/app.ts#L42)')).toContain(`href="${base}?path=src%2Fapp.ts"`);
    expect(reply('[deck](out/deck.pptx "click me")')).toContain('title="Download deck.pptx"');
    // Another computer's share is never a download (on Windows the server would connect to it).
    expect(reply(String.raw`[a](<\\\\host\share\a.pdf>)`)).not.toContain('file-link');
    expect(reply('[a](%5C%5Chost%5Cshare%5Ca.pdf)')).not.toContain('file-link');
  });

  it('keep the link and its text when the file is not there, and say why', () => {
    const link = (initial?: 'missing' | 'ok') =>
      renderToStaticMarkup(
        createElement(I18nProvider, null, createElement(FileLink, { href: `${base}?path=out%2Freport.pdf`, path: 'out/report.pdf', initial, children: 'the report' })),
      );
    const missing = link('missing');
    expect(missing).toContain(`<a href="${base}?path=out%2Freport.pdf" class="file-link" download="report.pdf" title="Download report.pdf">the report<svg`);
    expect(missing).toContain('</a><span class="media-missing file-missing" title="out/report.pdf"> ⚠ Cannot download: not a file in the working directory');
    expect(link('ok')).not.toContain('file-missing');
    expect(link()).not.toContain('file-missing');
  });

  it('are checked a moment after they appear, and not for a URL that changed or went away', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(async () => new Response(null, { status: 404 }));
      const states: string[] = [];
      checkLater('/a', (s) => states.push(s), fetchFn as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS - 1);
      expect(fetchFn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(states).toEqual(['missing']);

      // Cancelled before the check (the URL is still streaming in), or before its answer.
      const cancelEarly = checkLater('/b', (s) => states.push(s), fetchFn as unknown as typeof fetch);
      cancelEarly();
      await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const cancelLate = checkLater('/c', (s) => states.push(s), fetchFn as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(CHECK_DELAY_MS - 1);
      const answer = vi.advanceTimersByTimeAsync(1);
      cancelLate();
      await answer;
      expect(states).toEqual(['missing']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('download on a click, or check again first while the file is missing', async () => {
    let found: 'ok' | 'missing' = 'missing';
    const check = vi.fn(async () => found);
    const states: string[] = [];
    const click = fileClicks(check, (s) => states.push(s));
    const link = { click: vi.fn(() => click('missing', link)) };

    expect(click('ok', link)).toBe(true);
    expect(click('unknown', link)).toBe(true);
    expect(check).not.toHaveBeenCalled();

    // Still missing: the click is stopped, and nothing is clicked for the user.
    expect(click('missing', link)).toBe(false);
    await vi.waitFor(() => expect(states).toEqual(['missing']));
    expect(link.click).not.toHaveBeenCalled();

    // Made since: the link is clicked once more, and that click goes through (no loop).
    found = 'ok';
    expect(click('missing', link)).toBe(false);
    await vi.waitFor(() => expect(link.click).toHaveBeenCalledTimes(1));
    expect(link.click.mock.results[0]!.value).toBe(true);
    expect(states).toEqual(['missing', 'ok']);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('are checked before a click, so a file the server cannot hand over says so', async () => {
    const answer = (status: number) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status }));
    const ok = answer(200);
    expect(await checkDownload(`${base}?path=out%2Fdeck.pptx`, ok as unknown as typeof fetch)).toBe('ok');
    expect(ok).toHaveBeenCalledWith(`${base}?path=out%2Fdeck.pptx`, { method: 'HEAD' });
    expect(await checkDownload(base, answer(404) as unknown as typeof fetch)).toBe('missing');
    expect(await checkDownload(base, answer(500) as unknown as typeof fetch)).toBe('unknown');
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await checkDownload(base, offline as unknown as typeof fetch)).toBe('unknown');
  });
});
