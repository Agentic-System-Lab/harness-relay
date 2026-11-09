import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vitest';
import { endBareUrls, splitUrls, urlLength, type LinkNode } from '../src/shared/links';

/** The links (text → URL) and prose of a Markdown paragraph, after `endBareUrls`. */
function parts(markdown: string): (string | [string, string])[] {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as LinkNode;
  endBareUrls(tree);
  const text = (n: LinkNode): string => n.value ?? (n.children ?? []).map(text).join('');
  return (tree.children?.[0]?.children ?? []).map((n) => (n.type === 'link' ? [text(n), n.url!] : text(n)));
}

describe('bare URLs written right against Chinese text', () => {
  it('end where the Chinese starts, and the next URL in it is a link of its own', () => {
    expect(parts('檢查https://github.com/Canner/WrenAI-saas及https://github.com/Canner/wren-agent-stack是否在過去一天內有新的PR，說明')).toEqual([
      '檢查',
      ['https://github.com/Canner/WrenAI-saas', 'https://github.com/Canner/WrenAI-saas'],
      '及',
      ['https://github.com/Canner/wren-agent-stack', 'https://github.com/Canner/wren-agent-stack'],
      '是否在過去一天內有新的PR，說明',
    ]);
    expect(parts('見 https://a.example/x。好 www.b.example請看')).toEqual([
      '見 ',
      ['https://a.example/x', 'https://a.example/x'],
      '。好 ',
      ['www.b.example', 'http://www.b.example'],
      '請看',
    ]);
  });

  it('end at full-width punctuation, curly quotes and the ellipsis, leaving out trailing punctuation', () => {
    expect(urlLength('https://a.example/x，見')).toBe('https://a.example/x'.length);
    expect(urlLength('https://a.example/x」')).toBe('https://a.example/x'.length);
    expect(urlLength('https://a.example/x（註）')).toBe('https://a.example/x'.length);
    expect(urlLength('https://a.example/x”')).toBe('https://a.example/x'.length);
    expect(urlLength('https://a.example/x…')).toBe('https://a.example/x'.length);
    expect(urlLength('https://a.example/x.，')).toBe('https://a.example/x'.length);
    expect(urlLength('https://a.example/x!及')).toBe('https://a.example/x'.length);
    expect(urlLength('https://a.example/x),及')).toBe('https://a.example/x'.length);
    // A `)` stays when it closes a `(` in the URL.
    expect(urlLength('https://a.example/Foo_(bar)及')).toBe('https://a.example/Foo_(bar)'.length);
    expect(urlLength('https://a.example/x)及')).toBe('https://a.example/x'.length);
    expect(urlLength('https://a.example/x 及')).toBe('https://a.example/x'.length);
    expect(urlLength('https://，')).toBe(0);
  });

  it('keep Chinese that is part of the URL: a path segment, a query value, a domain', () => {
    for (const url of [
      'https://zh.wikipedia.org/wiki/臺灣',
      'https://zh.wikipedia.org/wiki/臺灣_(消歧義)',
      'https://a.example/search?q=中文&lang=zh',
      'https://a.example/2024-年報',
      'https://中文.tw/首頁',
      'https://example.台灣',
    ]) {
      expect(urlLength(url), url).toBe(url.length);
      expect(parts(url), url).toEqual([[url, url]]);
    }
    expect(parts('https://zh.wikipedia.org/wiki/臺灣，見')).toEqual([['https://zh.wikipedia.org/wiki/臺灣', 'https://zh.wikipedia.org/wiki/臺灣'], '，見']);
    // Chinese right after an ASCII part of the path is prose.
    expect(urlLength('https://a.example/中文abc及')).toBe('https://a.example/中文abc'.length);
  });

  it('leave other links alone: <…>, [text](…), e-mail addresses, URLs ended by a space', () => {
    expect(parts('<https://a.example/x及>')).toEqual([['https://a.example/x及', 'https://a.example/x及']]);
    expect(parts('[https://a.example/x及](https://a.example/x及)')).toEqual([['https://a.example/x及', 'https://a.example/x及']]);
    expect(parts('[看這裡](https://a.example/x及)')).toEqual([['看這裡', 'https://a.example/x及']]);
    expect(parts('寄給bob@a.example的信')).toEqual(['寄給', ['bob@a.example', 'mailto:bob@a.example'], '的信']);
    expect(parts('see https://a.example/x, then')).toEqual(['see ', ['https://a.example/x', 'https://a.example/x'], ', then']);
    // Ended once, a URL stays as it is.
    const tree = fromMarkdown('看https://a.example/x及', { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as LinkNode;
    endBareUrls(tree);
    const once = JSON.stringify(tree);
    endBareUrls(tree);
    expect(JSON.stringify(tree)).toBe(once);
  });
});

describe('splitUrls', () => {
  it('finds bare URLs as GFM does, each ended as above', () => {
    expect(splitUrls('及https://a.example/b是，www.c.example，xhttps://d.example 請www.e.example')).toEqual([
      { text: '及' },
      { text: 'https://a.example/b', url: 'https://a.example/b' },
      { text: '是，' },
      { text: 'www.c.example', url: 'http://www.c.example' },
      // After an ASCII letter (https) or a Chinese character (www), GFM sees no URL either.
      { text: '，xhttps://d.example 請www.e.example' },
    ]);
    expect(splitUrls('沒有網址')).toEqual([{ text: '沒有網址' }]);
    expect(splitUrls('')).toEqual([]);
  });
});
