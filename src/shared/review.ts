import type { ChatMessage, ReviewHighlight, ReviewKind } from './types';

/*
 * The lead agent's review quotes words of the team's replies (`ReviewHighlight.quote`). The server
 * keeps a quote only when the reply has it, and the chat marks it in the reply. Both look for it in the
 * reply's text as the chat shows it: the server takes that text from the reply's Markdown
 * (`markdownText`), the chat from the rendered reply, a space between its blocks (paragraphs, list
 * items, table cells). Both ignore case, runs of whitespace and Markdown's marks, and a list marker at
 * the start of the quote (a list's numbers are not text in the chat).
 */

/** Characters left out when looking for a quote: Markdown's marks, which a rendered reply does not show. */
const MARKS = new Set(['*', '_', '`', '#', '>', '|', '[', ']', '~']);

/** A character of the text a quote is looked for in, and where it came from: which string, and where in it. */
interface Origin {
  part: number;
  offset: number;
  length: number;
}

/**
 * `parts` (strings in order, as a reply's text nodes) as one string to search, each character with its
 * origin. `breaks[i]`: part `i` starts a new block, so a space comes before it.
 */
function searchable(parts: readonly string[], breaks: readonly boolean[] = []): { text: string; origins: Origin[] } {
  let text = '';
  const origins: Origin[] = [];
  let space = true; // at the start: leading whitespace is left out
  parts.forEach((part, p) => {
    if (breaks[p] && !space) {
      text += ' ';
      origins.push({ part: p, offset: 0, length: 0 });
      space = true;
    }
    for (let i = 0; i < part.length; ) {
      const ch = String.fromCodePoint(part.codePointAt(i)!);
      const origin = { part: p, offset: i, length: ch.length };
      i += ch.length;
      if (/\s/.test(ch)) {
        if (!space) {
          text += ' ';
          origins.push(origin);
          space = true;
        }
        continue;
      }
      if (MARKS.has(ch)) continue;
      // One origin per UTF-16 unit, as `indexOf` counts.
      const lower = ch.toLowerCase();
      text += lower;
      for (let u = 0; u < lower.length; u++) origins.push(origin);
      space = false;
    }
  });
  return { text, origins };
}

/**
 * A quote as it is looked for: without quotation marks or an ellipsis around it, nor a list marker
 * before it, its own whitespace and marks dropped as the text's are.
 */
export function quoteKey(quote: string): string {
  const bare = quote
    .trim()
    .replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '')
    .replace(/^(?:\.\.\.|…)|(?:\.\.\.|…)$/g, '')
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '');
  return searchable([bare]).text.trim();
}

/** Where a quote starts and ends in `parts`: string index and offset, the end just after its last character. */
export interface QuoteSpan {
  start: { part: number; offset: number };
  end: { part: number; offset: number };
}

/**
 * Where `quote` first is in `parts` (a reply's text nodes, in order; `breaks` as for `searchable`);
 * undefined when it is not there.
 */
export function findQuote(parts: readonly string[], quote: string, breaks?: readonly boolean[]): QuoteSpan | undefined {
  const key = quoteKey(quote);
  if (!key) return undefined;
  const { text, origins } = searchable(parts, breaks);
  const at = text.indexOf(key);
  if (at < 0) return undefined;
  const first = origins[at]!;
  const last = origins[at + key.length - 1]!;
  return { start: { part: first.part, offset: first.offset }, end: { part: last.part, offset: last.offset + last.length } };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** A character for a numeric entity, or the entity as written when it names none. */
const codePoint = (n: number, all: string) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all);

/**
 * A reply's Markdown as the chat shows its text, near enough to find a quote in it: links by their
 * text, images and code fences' lines left out, entities and escapes read, list markers and table rules
 * dropped (Markdown's other marks are ignored when looking).
 */
export function markdownText(md: string): string {
  // Each pattern reads at most a line, and a link's parts at most so far: a reply of any size (nothing
  // shortens it) is read in time proportional to its length.
  return md
    .split('\n')
    // A table's rule, a thematic break or an empty list item: no text in the chat.
    .map((line) => (line.includes('-') && /^[ \t|:-]+$/.test(line) ? ' ' : line))
    .join('\n')
    .replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gm, ' ')
    // An image on the web shows as a link with its alt text (or its address); one on this computer as
    // the image itself, with no text.
    .replace(/!\[([^\]\n]{0,500})\]\(([^)\s]{0,2048})(?:[ \t]+"[^"\n]{0,500}")?\)/g, (_, alt: string, url: string) =>
      /^(?:https?|ftp):\/\//i.test(url) ? alt || url : ' ',
    )
    .replace(/\[([^\]\n]{0,500})\]\((?:[^()\n]|\([^()\n]{0,2048}\)){0,2048}\)/g, '$1')
    .replace(/\[([^\]\n]{0,500})\]\[[^\]\n]{0,500}\]/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]{1,2048})>/g, '$1')
    .replace(/^((?:[ \t]*>)*[ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name]!)
    .replace(/&#(\d{1,7});/g, (all, n: string) => codePoint(Number(n), all))
    .replace(/&#x([\da-f]{1,6});/gi, (all, n: string) => codePoint(parseInt(n, 16), all));
}

/** The reply (its Markdown) has these words, as the chat shows it. */
export function hasQuote(markdown: string, quote: string): boolean {
  return findQuote([markdownText(markdown)], quote) !== undefined;
}

/**
 * The question the latest run answers: the user's latest message that did not join a discussion under
 * way (`queued`), or, when that one answered an agent's question, the question before it, and so on.
 */
function firstReviewStart(messages: readonly ChatMessage[]): number {
  const asks = (m: ChatMessage) => m.author.kind === 'user' && !m.queued;
  let at = messages.findLastIndex(asks);
  if (at < 0) return 0;
  for (;;) {
    const before = messages.findLastIndex((m, i) => i < at && asks(m));
    if (before < 0 || !messages.slice(before + 1, at).some((m) => m.author.kind === 'agent' && m.asked)) return at;
    at = before;
  }
}

/**
 * Where the lead agent's next review starts reading: at the question the latest run answers
 * (`firstReviewStart`), or earlier where a review that failed or was stopped started (it left those
 * replies to this one); never before its last review that was ready, which read what came before. So
 * a review turned on mid-chat, or again after a while, reads the latest question, not everything since.
 */
export function reviewStart(messages: readonly ChatMessage[]): number {
  const after = messages.findLastIndex((m) => m.review?.status === 'ready') + 1;
  let start = Math.max(after, firstReviewStart(messages));
  for (const m of messages.slice(after)) {
    const fromId = m.review?.fromId;
    const from = fromId ? messages.findIndex((x) => x.id === fromId) : -1;
    if (from >= after && from < start) start = from;
  }
  return start;
}

/** The highlights a reply has from the lead agent's reviews, and the review that has the latest of them. */
export interface ReplyMarks {
  reviewId: string;
  highlights: ReviewHighlight[];
}

/** The highlights of the conversation's reviews (only those that are ready), by the reply each one is about. */
export function highlightsByReply(messages: readonly ChatMessage[]): Map<string, ReplyMarks> {
  const out = new Map<string, ReplyMarks>();
  for (const m of messages) {
    if (m.review?.status !== 'ready') continue;
    for (const h of m.review.highlights ?? []) {
      if (!h.messageId) continue;
      out.set(h.messageId, { reviewId: m.id, highlights: [...(out.get(h.messageId)?.highlights ?? []), h] });
    }
  }
  return out;
}

/** Kinds of highlight, the most serious first. */
const SEVERITY: ReviewKind[] = ['risk', 'decision', 'conflict', 'verify', 'note'];

/** The most serious kind among highlights (a reply's tag takes its colour). */
export function mostSerious(highlights: readonly ReviewHighlight[]): ReviewKind {
  return SEVERITY.find((k) => highlights.some((h) => h.kind === k)) ?? 'note';
}
