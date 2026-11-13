import { describe, expect, it } from 'vitest';
import { hastToHtml, highlightHtml } from '../src/web/highlight';

describe("the file browser's highlighting", () => {
  it('highlights a language replies know too, as spans with highlight.js classes', () => {
    const html = highlightHtml('const a = 1;', 'typescript')!;
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<span class="hljs-number">1</span>');
    // By an alias too, and the text is all there.
    expect(highlightHtml('x = 1', 'py')).not.toBeNull();
    expect(html.replace(/<[^>]+>/g, '')).toBe('const a = 1;');
  });

  it('gives null for a language it does not have', () => {
    expect(highlightHtml('x', 'not-a-language')).toBeNull();
  });

  it('escapes the text, so a file cannot put markup in the page', () => {
    const html = highlightHtml('<img src=x onerror="alert(1)"> & \'q\'', 'xml')!;
    expect(html).not.toMatch(/<img/);
    expect(html).toContain('&lt;');
    expect(html.replace(/<span[^>]*>|<\/span>/g, '')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;q&#39;');
  });

  it('keeps only spans and their classes from a tree, and the text of anything else', () => {
    expect(
      hastToHtml({
        type: 'root',
        children: [
          { type: 'element', tagName: 'span', properties: { className: ['hljs-string', 'x"y'] }, children: [{ type: 'text', value: 'a<b' }] },
          { type: 'element', tagName: 'script', properties: { src: 'x' }, children: [{ type: 'text', value: 'c' }] },
          { type: 'comment', value: 'gone' },
        ],
      }),
    ).toBe('<span class="hljs-string x&quot;y">a&lt;b</span>c');
  });
});
