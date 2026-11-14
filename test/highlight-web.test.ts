import { describe, expect, it } from 'vitest';
import { hastToHtml, highlightHtml } from '../src/web/highlight';

/** Every tag in `html`, each of which must be a highlight.js span's start or an end of one. */
const strayTags = (html: string) => [...html.matchAll(/<[^>]*>/g)].map((m) => m[0]).filter((tag) => !/^<span class="hljs-[a-z_-]+">$|^<\/span>$/.test(tag));

describe("the file browser's highlighting", () => {
  it('highlights a language replies know too, as spans with highlight.js classes', () => {
    expect(highlightHtml('const a = 1;', 'typescript')).toBe('<span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>;');
    // By an alias too.
    expect(highlightHtml('x = 1', 'py')).not.toBeNull();
  });

  it('gives null for a language it does not have', () => {
    expect(highlightHtml('x', 'not-a-language')).toBeNull();
  });

  it('escapes the text, so a file cannot put markup in the page', () => {
    const html = highlightHtml('<img src=x onerror="alert(1)"> & \'q\'', 'xml')!;
    expect(html).toBe(
      '<span class="hljs-tag">&lt;<span class="hljs-name">img</span> <span class="hljs-attr">src</span>=<span class="hljs-string">x</span> ' +
        '<span class="hljs-attr">onerror</span>=<span class="hljs-string">&quot;alert(1)&quot;</span>&gt;</span> &amp; &#39;q&#39;',
    );
    // Whatever the file holds, no tag but the highlighter's own spans.
    for (const [text, language] of [
      ['<script>alert(1)</script>', 'xml'],
      ['"><svg onload=alert(1)>', 'javascript'],
      ['<<script>script>x', 'html'],
    ]) {
      expect(strayTags(highlightHtml(text!, language!)!)).toEqual([]);
    }
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
