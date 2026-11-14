// Syntax highlighting of a whole file (the file browser), with the highlighter replies' code blocks
// use (rehype-highlight's lowlight, the same languages), so the page carries one copy of highlight.js.

import type { Root, RootContent } from 'hast';
import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/**
 * A highlighted tree as HTML. lowlight makes only text and `<span class="hljs-…">` elements: text is
 * escaped, a span keeps its classes alone, and anything else gives its children only.
 */
export function hastToHtml(node: Root | RootContent): string {
  if (node.type === 'text') return escape(node.value);
  if (node.type === 'root') return node.children.map(hastToHtml).join('');
  if (node.type !== 'element') return '';
  const inner = node.children.map(hastToHtml).join('');
  if (node.tagName !== 'span') return inner;
  const cls = node.properties?.className;
  const classes = Array.isArray(cls) ? cls.join(' ') : typeof cls === 'string' ? cls : '';
  return classes ? `<span class="${escape(classes)}">${inner}</span>` : `<span>${inner}</span>`;
}

/** `text` highlighted as `language` (a highlight.js name or alias), as HTML; null for a language it does not have. */
export function highlightHtml(text: string, language: string): string | null {
  if (!lowlight.registered(language)) return null;
  return hastToHtml(lowlight.highlight(language, text));
}
