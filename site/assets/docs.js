// The docs (site/docs/ and site/zh-TW/docs/): search over the words on the pages, and copy a page as
// Markdown. The pages stay hand-written HTML. Search reads that HTML (so the index cannot drift from
// the page), and copy turns the same HTML into Markdown. The functions are tested in
// test/site-docs-search.test.ts; the wiring below runs only in the browser.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const SKIP = new Set(['svg', 'button', 'script', 'style', 'form', 'noscript']);
const BLOCK = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'table',
  'dl',
  'figure',
  'div',
  'section',
  'aside',
  'header',
  'nav',
  'blockquote',
  'pre',
  'hr',
]);

/** Text made safe to put in HTML. Every occurrence, `&` first so the others are not escaped twice. */
export function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** The entities the pages are written with, read once. `&amp;` last, so `&amp;lt;` stays `&lt;`. */
function decode(text) {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** Tags dropped, entities read, whitespace collapsed. A `<` in the text is the `&lt;` it was written as. */
export function plainText(html) {
  let text = '';
  let inTag = false;
  for (const char of html) {
    if (inTag) inTag = char !== '>';
    else if (char === '<') inTag = true;
    else text += char;
  }
  return decode(text).replace(/\s+/g, ' ').trim();
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** The element whose opening tag carries `className`, from that tag through its matching close. */
function extractElement(html, tag, className) {
  const open = new RegExp(`<${tag}\\b[^>]*\\bclass="[^"]*\\b${className}\\b[^"]*"[^>]*>`, 'i').exec(html);
  if (!open) return '';
  const token = new RegExp(`</?${tag}\\b[^>]*>`, 'gi');
  token.lastIndex = open.index + open[0].length;
  let depth = 1;
  let next;
  while ((next = token.exec(html))) {
    if (next[0].startsWith('</')) depth -= 1;
    else if (!next[0].endsWith('/>')) depth += 1;
    if (depth === 0) return html.slice(open.index, next.index + next[0].length);
  }
  return html.slice(open.index);
}

/**
 * One page's searchable pieces: the lead (no id), then each section, then the closing technical-details
 * block (`.doc-more`), which is copied as Markdown and is not a section of its own. `text` is the piece's
 * words, headings included; `subheadings` are its `h3`s, which rank above the body and below the `h2`.
 */
export function indexPage(html) {
  const title = plainText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  const sections = [];
  const lead = html.match(/<p\b[^>]*\bclass="[^"]*\blead\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  if (lead && plainText(lead)) sections.push({ id: '', heading: '', subheadings: [], text: plainText(lead) });
  const body = extractElement(html, 'div', 'doc-body');
  for (const match of body.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)) {
    const id = /\bid="([^"]*)"/i.exec(match[1])?.[1] ?? '';
    const heading = plainText(match[2].match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? '');
    const subheadings = [...match[2].matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)].map((item) => plainText(item[1]));
    sections.push({ id, heading, subheadings, text: plainText(match[2]) });
  }
  const more = extractElement(body, 'aside', 'doc-more');
  if (more) {
    const label = plainText(/\baria-label="([^"]*)"/i.exec(more)?.[1] ?? '');
    const text = plainText(more);
    if (text) sections.push({ id: '', heading: label, subheadings: [], text });
  }
  return { title, sections };
}

function termsOf(query) {
  return query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** `text` with `ranges` wrapped in `<mark>`, the rest escaped. Ranges are indexes into `text`. */
export function highlight(text, ranges) {
  let out = '';
  let cursor = 0;
  for (const [start, end] of mergeRanges(ranges)) {
    const from = Math.max(cursor, Math.min(start, text.length));
    const to = Math.max(from, Math.min(end, text.length));
    out += escapeHtml(text.slice(cursor, from));
    if (to > from) out += `<mark>${escapeHtml(text.slice(from, to))}</mark>`;
    cursor = to;
  }
  return out + escapeHtml(text.slice(cursor));
}

/** A window of `text` around the earliest term, with ranges of each term inside the window. */
function makeSnippet(text, terms, size = 180) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const lower = clean.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) at = 0;
  let start = Math.max(0, at - 60);
  if (start > 0) {
    const space = clean.indexOf(' ', start);
    if (space > start && space < at) start = space + 1;
  }
  let end = Math.min(clean.length, Math.max(at + 1, start + size));
  if (end < clean.length) {
    const space = clean.lastIndexOf(' ', end);
    if (space > at) end = space;
  }
  const slice = clean.slice(start, end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < clean.length ? '…' : '';
  const ranges = [];
  const sliceLower = slice.toLowerCase();
  for (const term of terms) {
    let from = 0;
    while (from < sliceLower.length) {
      const found = sliceLower.indexOf(term, from);
      if (found < 0) break;
      ranges.push([prefix.length + found, prefix.length + found + term.length]);
      from = found + term.length;
    }
  }
  return { snippet: `${prefix}${slice}${suffix}`, ranges: mergeRanges(ranges) };
}

function snippetSource(page, section, terms) {
  const fields = [section.text, section.heading, ...(section.subheadings ?? []), page.title];
  return fields.find((field) => terms.some((term) => field.toLowerCase().includes(term))) ?? section.text;
}

/**
 * The best matching section of each page, highest score first, then the pages' own order.
 * Every word of the query must occur (a Chinese phrase is one word when it has no spaces).
 * `pages` are `{ href, title, sections }` from `indexPage`.
 */
export function searchDocs(pages, query, limit = 8) {
  const terms = termsOf(query);
  if (!terms.length) return [];
  const hits = [];
  pages.forEach((page, pageIndex) => {
    let best = null;
    for (const section of page.sections) {
      const title = page.title.toLowerCase();
      const heading = section.heading.toLowerCase();
      const subs = (section.subheadings ?? []).map((item) => item.toLowerCase());
      const text = section.text.toLowerCase();
      const haystack = `${title}\n${heading}\n${subs.join('\n')}\n${text}`;
      if (!terms.every((term) => haystack.includes(term))) continue;
      let score = 1;
      for (const term of terms) {
        if (title.includes(term)) score += 8;
        if (heading.includes(term)) score += 5;
        if (subs.some((item) => item.includes(term))) score += 3;
        if (text.includes(term)) score += 1;
      }
      const phrase = terms.join(' ');
      if (terms.length > 1 && (title.includes(phrase) || heading.includes(phrase) || text.includes(phrase))) score += 4;
      if (!best || score > best.score) best = { score, section };
    }
    if (best) hits.push({ score: best.score, pageIndex, page, section: best.section });
  });
  hits.sort((a, b) => b.score - a.score || a.pageIndex - b.pageIndex);
  return hits.slice(0, limit).map(({ page, section }) => {
    const { snippet, ranges } = makeSnippet(snippetSource(page, section, terms), terms);
    return { href: page.href, id: section.id, title: page.title, heading: section.heading, snippet, ranges };
  });
}

/** Where a result points: the page, or the page's section. */
export function sectionHref(pageHref, id) {
  return id ? `${pageHref}#${id}` : pageHref;
}

/**
 * Pages a search may use once each menu page's fetch has settled, still in menu order.
 * `complete` is true only when every page arrived, so a partial index is not kept and the next
 * search tries again. When the page on screen did not arrive, `here` fills that slot. When none
 * arrived, the list is empty: the search failed, and the page on screen is not offered as if the
 * whole docs had been read.
 */
export function settlePages(results, here) {
  if (!results.some((result) => result.ok)) return { pages: [], complete: false };
  const pages = [];
  for (const result of results) {
    if (result.ok && result.page) pages.push(result.page);
    else if (here && result.href === here.href) pages.push(here);
  }
  return { pages, complete: results.every((result) => result.ok) };
}

/** The status line for `count` results. `one` is the singular, used when a language has it. */
export function resultsLabel(count, templates) {
  const template = (count === 1 && templates.one) || templates.many || '';
  return template.replaceAll('{n}', String(count));
}

function absoluteUrl(value, base) {
  if (!value) return '';
  try {
    return new URL(value, base || undefined).href;
  } catch {
    return value;
  }
}

function linkText(text) {
  return text.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function linkDest(url) {
  return /[\s()]/.test(url) ? `<${url}>` : url;
}

function codeSpan(inner) {
  const text = collapse(inner);
  if (!text) return '';
  const fence = text.includes('`') ? '``' : '`';
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function emph(mark, inner) {
  const lead = /^\s/.test(inner) ? ' ' : '';
  const trail = /\s$/.test(inner) ? ' ' : '';
  const text = inner.trim();
  if (!text) return '';
  return `${lead}${mark}${text}${mark}${trail}`;
}

function parseAttrs(source) {
  const attrs = {};
  for (const match of source.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)([^<>]*?)(\/?)>/gi;
  let cursor = 0;
  for (const match of html.matchAll(re)) {
    if (match.index > cursor) stack.at(-1).children.push({ tag: '#text', text: decode(html.slice(cursor, match.index)) });
    cursor = match.index + match[0].length;
    const raw = match[0];
    if (raw.startsWith('<!--') || raw[1] === '!') continue;
    if (raw.startsWith('</')) {
      const name = match[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node = { tag: match[2].toLowerCase(), attrs: parseAttrs(match[3] ?? ''), children: [] };
    stack.at(-1).children.push(node);
    if (match[4] !== '/' && !VOID.has(node.tag)) stack.push(node);
  }
  if (cursor < html.length) stack.at(-1).children.push({ tag: '#text', text: decode(html.slice(cursor)) });
  return root;
}

function hasClass(node, name) {
  return ` ${node.attrs?.class ?? ''} `.includes(` ${name} `);
}

function imageOf(node, ctx) {
  const src = absoluteUrl(node.attrs.src ?? '', ctx.pageUrl);
  if (!src) return '';
  return `![${linkText(node.attrs.alt ?? '')}](${linkDest(src)})`;
}

function childrenInline(node, ctx) {
  return node.children.map((child) => renderInline(child, ctx)).join('');
}

function inline(node, ctx) {
  return collapse(childrenInline(node, ctx));
}

function renderInline(node, ctx) {
  if (node.tag === '#text') return node.text;
  if (SKIP.has(node.tag)) return '';
  if (node.tag === 'br') return ' ';
  if (node.tag === 'img') return imageOf(node, ctx);
  if (node.tag === 'a') return renderLink(node, ctx);
  const inner = childrenInline(node, ctx);
  if (node.tag === 'code' || node.tag === 'kbd') return codeSpan(inner);
  if (node.tag === 'b' || node.tag === 'strong') return emph('**', inner);
  if (node.tag === 'em' || node.tag === 'i') return emph('*', inner);
  return inner;
}

function renderLink(node, ctx) {
  const href = absoluteUrl(node.attrs.href ?? '', ctx.pageUrl);
  const bold = node.children.find((child) => child.tag === 'b' || child.tag === 'strong');
  if (bold) {
    const rest = collapse(
      node.children
        .filter((child) => child !== bold)
        .map((child) => renderInline(child, ctx))
        .join(''),
    );
    const title = inline(bold, ctx);
    // The overview's page list is a title (the bold) and a description with no space between them:
    // the description sits under the title on the page, so the Markdown separates them.
    if (title && rest) return `[${linkText(title)}](${linkDest(href)}): ${rest}`;
  }
  const text = inline(node, ctx);
  if (!text || text === href) return href;
  return `[${linkText(text)}](${linkDest(href)})`;
}

function renderBlocks(nodes, ctx) {
  const blocks = [];
  let pending = [];
  const flush = () => {
    const text = collapse(pending.map((node) => renderInline(node, ctx)).join(''));
    pending = [];
    if (text) blocks.push(text);
  };
  for (const node of nodes) {
    if (SKIP.has(node.tag)) continue;
    if (node.tag === '#text' && !node.text.trim()) continue;
    if (node.tag !== '#text' && BLOCK.has(node.tag)) {
      flush();
      const rendered = renderBlock(node, ctx);
      if (rendered) blocks.push(rendered);
    } else pending.push(node);
  }
  flush();
  return blocks.join('\n\n');
}

function prefixBlock(text, marker, indent) {
  const lines = text.split('\n');
  return [marker + lines[0], ...lines.slice(1).map((line) => (line.length ? indent + line : line))].join('\n');
}

function indentBlock(text, indent) {
  return text
    .split('\n')
    .map((line) => (line.length ? indent + line : line))
    .join('\n');
}

function renderLi(node, ctx, marker) {
  const indent = ' '.repeat(marker.length);
  const parts = [];
  let pending = [];
  const flush = () => {
    const text = collapse(pending.map((child) => renderInline(child, ctx)).join(''));
    pending = [];
    if (text) parts.push(text);
  };
  for (const child of node.children) {
    if (SKIP.has(child.tag)) continue;
    if (child.tag !== '#text' && BLOCK.has(child.tag)) {
      flush();
      const rendered = renderBlock(child, ctx);
      if (rendered) parts.push(rendered);
    } else if (child.tag !== '#text' || child.text.trim() || pending.length) pending.push(child);
  }
  flush();
  if (!parts.length) return '';
  return parts.map((part, index) => (index === 0 ? prefixBlock(part, marker, indent) : indentBlock(part, indent))).join('\n');
}

function renderList(node, ctx, ordered) {
  let index = 1;
  return node.children
    .filter((child) => child.tag === 'li')
    .map((item) => renderLi(item, ctx, ordered ? `${index++}. ` : '- '))
    .filter(Boolean)
    .join('\n');
}

function renderTable(node, ctx) {
  const rows = [];
  const walk = (current) => {
    for (const child of current.children) {
      if (child.tag === 'tr') rows.push(child);
      else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') walk(child);
    }
  };
  walk(node);
  const rendered = rows
    .map((row) =>
      row.children
        .filter((cell) => cell.tag === 'th' || cell.tag === 'td')
        .map((cell) => collapse(childrenInline(cell, ctx)).replaceAll('|', '\\|')),
    )
    .filter((row) => row.length);
  if (!rendered.length) return '';
  const width = Math.max(...rendered.map((row) => row.length));
  const pad = (row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')];
  const body = rendered.map(pad);
  const lines = [body[0], body[0].map(() => '---'), ...body.slice(1)].map((row) => `| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function renderDl(node, ctx) {
  const parts = [];
  for (const child of node.children) {
    if (child.tag === 'dt') {
      const term = inline(child, ctx);
      if (term) parts.push(`**${term}**`);
    } else if (child.tag === 'dd') {
      const body = renderBlocks(child.children, ctx);
      if (body) parts.push(body);
    }
  }
  return parts.join('\n\n');
}

function renderFigure(node, ctx) {
  const parts = [];
  const walk = (current) => {
    for (const child of current.children) {
      if (child.tag === 'img') {
        const image = imageOf(child, ctx);
        if (image) parts.push(image);
      } else if (child.tag === 'figcaption') {
        const caption = inline(child, ctx);
        if (caption) parts.push(caption);
      } else if (child.tag !== '#text' && !SKIP.has(child.tag)) walk(child);
    }
  };
  walk(node);
  return parts.join('\n\n');
}

function quote(markdown) {
  if (!markdown) return '';
  return markdown
    .split('\n')
    .map((line) => (line.length ? `> ${line}` : '>'))
    .join('\n');
}

function renderBlock(node, ctx) {
  if (node.tag === '#text') return collapse(node.text);
  if (SKIP.has(node.tag) || hasClass(node, 'doc-actions') || hasClass(node, 'doc-search')) return '';
  if (node.tag === 'nav' && hasClass(node, 'doc-pager')) return '';
  if (hasClass(node, 'doc-note')) return quote(renderBlocks(node.children, ctx));
  if (node.tag === 'aside' && hasClass(node, 'doc-more')) {
    const label = node.attrs['aria-label'] || 'Details';
    const body = renderBlocks(node.children, ctx);
    return body ? `## ${label}\n\n${body}` : '';
  }
  if (node.tag === 'figure') return renderFigure(node, ctx);
  if (node.tag === 'ul') return renderList(node, ctx, false);
  if (node.tag === 'ol') return renderList(node, ctx, true);
  if (node.tag === 'table') return renderTable(node, ctx);
  if (node.tag === 'dl') return renderDl(node, ctx);
  if (/^h[1-6]$/.test(node.tag)) {
    const text = inline(node, ctx);
    return text ? `${'#'.repeat(Number(node.tag[1]))} ${text}` : '';
  }
  if (node.tag === 'p') return inline(node, ctx);
  if (node.tag === 'img') return imageOf(node, ctx);
  if (node.tag === 'hr') return '---';
  return renderBlocks(node.children, ctx);
}

/**
 * The page as Markdown: its title, its address, the lead, then the body. The previous and next links
 * are left out. Links and pictures are absolute against `pageUrl`, so the copy still points somewhere
 * once it has left the page.
 */
export function pageToMarkdown(html, pageUrl) {
  const head = extractElement(html, 'header', 'doc-head');
  const body = extractElement(html, 'div', 'doc-body');
  const tree = parseHtml(`${head}\n${body}`);
  let markdown = renderBlocks(tree.children, { pageUrl: pageUrl || '' })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (pageUrl && markdown.startsWith('# ')) {
    const breakAt = markdown.indexOf('\n');
    const title = breakAt === -1 ? markdown : markdown.slice(0, breakAt);
    const rest = breakAt === -1 ? '' : markdown.slice(breakAt).replace(/^\n+/, '');
    markdown = rest ? `${title}\n\n${pageUrl}\n\n${rest}` : `${title}\n\n${pageUrl}`;
  }
  return `${markdown}\n`;
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection below: a page that is not the secure context clipboard wants.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function wireCopy() {
  const button = document.querySelector('[data-doc-copy]');
  const span = button?.querySelector('span');
  if (!button || !span) return;
  const label = span.textContent;
  let timer = 0;
  button.addEventListener('click', async () => {
    const url = document.querySelector('link[rel="canonical"]')?.href || location.href;
    const markdown = pageToMarkdown(document.documentElement.outerHTML, url);
    const ok = await writeClipboard(markdown);
    span.textContent = (ok ? button.dataset.copied : button.dataset.failed) || label;
    button.classList.toggle('is-done', ok);
    button.classList.toggle('is-failed', !ok);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      span.textContent = label;
      button.classList.remove('is-done', 'is-failed');
    }, 2000);
  });
}

function wireSearch() {
  const form = document.querySelector('[data-doc-search]');
  const input = form?.querySelector('[data-doc-search-input]');
  const panel = form?.querySelector('[data-doc-search-panel]');
  const status = form?.querySelector('[data-doc-search-status]');
  const field = form?.querySelector('.doc-search-field');
  if (!form || !input || !panel || !field) return;

  let cache = null;
  let loading = null;
  let seq = 0;
  let options = [];
  let active = -1;

  const place = () => {
    if (panel.parentElement !== document.body) document.body.append(panel);
    const rect = field.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, Math.min(360, window.innerWidth - 24)), window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - 12 - width));
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.round(rect.bottom + 6)}px`;
    panel.style.width = `${Math.round(width)}px`;
    panel.style.maxHeight = `${Math.max(140, Math.round(window.innerHeight - rect.bottom - 16))}px`;
  };

  const closePanel = () => {
    panel.hidden = true;
    panel.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    options = [];
    active = -1;
    if (status) status.textContent = '';
  };

  const openPanel = () => {
    place();
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const select = (index) => {
    active = index;
    options.forEach((option, item) => {
      if (item === index) option.setAttribute('aria-selected', 'true');
      else option.removeAttribute('aria-selected');
    });
    const chosen = options[index];
    if (!chosen) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    input.setAttribute('aria-activedescendant', chosen.id);
    chosen.scrollIntoView({ block: 'nearest' });
  };

  const showMessage = (message) => {
    panel.replaceChildren();
    const note = document.createElement('p');
    note.className = 'doc-search-empty';
    note.textContent = message;
    panel.append(note);
    options = [];
    active = -1;
    input.removeAttribute('aria-activedescendant');
    if (status) status.textContent = message;
    openPanel();
  };

  const showHits = (hits) => {
    if (!hits.length) {
      showMessage(form.dataset.empty || '');
      return;
    }
    panel.replaceChildren();
    const list = document.createElement('ul');
    list.role = 'listbox';
    hits.forEach((hit, index) => {
      const item = document.createElement('li');
      item.role = 'presentation';
      const link = document.createElement('a');
      link.role = 'option';
      link.id = `doc-search-opt-${index}`;
      link.href = sectionHref(hit.href, hit.id);
      const title = document.createElement('span');
      title.className = 'doc-search-title';
      title.textContent = hit.title;
      link.append(title);
      if (hit.heading) {
        const heading = document.createElement('span');
        heading.className = 'doc-search-heading';
        heading.textContent = hit.heading;
        link.append(heading);
      }
      const snippet = document.createElement('span');
      snippet.className = 'doc-search-snippet';
      snippet.innerHTML = highlight(hit.snippet, hit.ranges);
      link.append(snippet);
      item.append(link);
      list.append(item);
    });
    panel.append(list);
    options = [...list.querySelectorAll('[role="option"]')];
    if (status) {
      status.textContent = resultsLabel(hits.length, { one: form.dataset.resultsOne, many: form.dataset.results });
    }
    openPanel();
    select(0);
  };

  const pageHere = () => {
    const current = document.querySelector('.doc-nav-list a[aria-current="page"]');
    if (!current) return [];
    const indexed = indexPage(document.documentElement.outerHTML);
    return [{ href: current.getAttribute('href') || '', title: indexed.title, sections: indexed.sections }];
  };

  const ensurePages = () => {
    if (cache) return Promise.resolve({ pages: cache, complete: true });
    if (loading) return loading;
    const anchors = [...document.querySelectorAll('.doc-nav-list ul a')];
    loading = Promise.allSettled(
      anchors.map(async (anchor) => {
        const href = anchor.getAttribute('href') || '';
        const response = await fetch(new URL(href, document.baseURI));
        if (!response.ok) throw new Error(String(response.status));
        const indexed = indexPage(await response.text());
        return { href, title: indexed.title, sections: indexed.sections };
      }),
    )
      .then((results) => {
        const settled = results.map((result, index) => ({
          ok: result.status === 'fulfilled',
          href: anchors[index]?.getAttribute('href') || '',
          page: result.status === 'fulfilled' ? result.value : null,
        }));
        const outcome = settlePages(settled, pageHere()[0] || null);
        if (outcome.complete) cache = outcome.pages;
        loading = null;
        if (!outcome.pages.length) throw new Error('docs search unavailable');
        return outcome;
      })
      .catch((error) => {
        loading = null;
        throw error;
      });
    return loading;
  };

  const run = () => {
    const query = input.value;
    const token = ++seq;
    if (!query.trim()) {
      closePanel();
      return;
    }
    const apply = (pages) => {
      if (token !== seq) return;
      showHits(searchDocs(pages, query));
    };
    if (cache) {
      apply(cache);
      return;
    }
    const local = pageHere();
    const localHits = searchDocs(local, query);
    if (localHits.length) showHits(localHits);
    else showMessage(form.dataset.pending || '');
    ensurePages()
      .then((outcome) => apply(outcome.pages))
      .catch(() => {
        if (token !== seq) return;
        showMessage(form.dataset.failed || '');
      });
  };

  const go = () => {
    const chosen = options[active] || options[0];
    if (chosen && !panel.hidden) chosen.click();
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    go();
  });
  input.addEventListener('input', (event) => {
    if (event.isComposing) return;
    run();
  });
  input.addEventListener('compositionend', run);
  input.addEventListener('focus', () => {
    if (input.value.trim() && panel.hidden) run();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (panel.hidden || !options.length) return;
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? (active + 1) % options.length : active <= 0 ? options.length - 1 : active - 1;
      select(next);
    } else if (event.key === 'Enter') {
      if (panel.hidden || !options.length) return;
      event.preventDefault();
      go();
    } else if (event.key === 'Escape' && !panel.hidden) {
      event.stopPropagation();
      closePanel();
    }
  });
  panel.addEventListener('click', (event) => {
    if (!event.target.closest('a')) return;
    closePanel();
    const nav = document.querySelector('[data-doc-nav]');
    if (!nav?.classList.contains('is-open')) return;
    nav.classList.remove('is-open');
    nav.querySelector('[data-doc-nav-toggle]')?.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', (event) => {
    if (!panel.hidden && !form.contains(event.target) && !panel.contains(event.target)) closePanel();
  });
  window.addEventListener('resize', () => {
    if (!panel.hidden) place();
  });
  window.addEventListener(
    'scroll',
    () => {
      if (!panel.hidden) place();
    },
    true,
  );
  const schedule = window.requestIdleCallback || ((callback) => window.setTimeout(callback, 300));
  schedule(() => {
    ensurePages().catch(() => {});
  });
}

function wire() {
  wireSearch();
  wireCopy();
}

if (typeof document !== 'undefined') wire();
