import type { ChatMessage, ReviewHighlight } from './types';

/*
 * The lead agent's review quotes words of the team's replies (`ReviewHighlight.quote`). The server
 * keeps a quote only when the reply has it, and the chat marks it in the reply. Both find it the same
 * way: whitespace collapsed, case ignored, and Markdown's marks left out (the lead quotes plain text,
 * the server reads the reply's Markdown, the chat its rendered text).
 */

/** Characters left out when looking for a quote: Markdown's marks, which a rendered reply does not show. */
const MARKS = new Set(['*', '_', '`', '#', '>', '|', '[', ']', '~']);

/** A character of the text a quote is looked for in, and where it came from: which string, and where in it. */
interface Origin {
  part: number;
  offset: number;
  length: number;
}

/** `parts` (strings in order, as a reply's text nodes) as one string to search, each character with its origin. */
function searchable(parts: readonly string[]): { text: string; origins: Origin[] } {
  let text = '';
  const origins: Origin[] = [];
  let space = true; // at the start: leading whitespace is left out
  parts.forEach((part, p) => {
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

/** A quote as it is looked for (its own whitespace and marks dropped as the text's are; without quotation marks around it). */
export function quoteKey(quote: string): string {
  const bare = quote.trim().replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '').replace(/^(?:\.\.\.|…)|(?:\.\.\.|…)$/g, '');
  return searchable([bare]).text.trim();
}

/** Where a quote starts and ends in `parts`: string index and offset, the end just after its last character. */
export interface QuoteSpan {
  start: { part: number; offset: number };
  end: { part: number; offset: number };
}

/** Where `quote` first is in `parts` (a reply's text nodes, in order); undefined when it is not there. */
export function findQuote(parts: readonly string[], quote: string): QuoteSpan | undefined {
  const key = quoteKey(quote);
  if (!key) return undefined;
  const { text, origins } = searchable(parts);
  const at = text.indexOf(key);
  if (at < 0) return undefined;
  const first = origins[at]!;
  const last = origins[at + key.length - 1]!;
  return { start: { part: first.part, offset: first.offset }, end: { part: last.part, offset: last.offset + last.length } };
}

/** The reply has these words (its Markdown, or its text as the chat shows it). */
export function hasQuote(text: string, quote: string): boolean {
  return findQuote([text], quote) !== undefined;
}

/** Where the lead agent's next review starts reading: after its last review that was ready. */
export function reviewStart(messages: readonly ChatMessage[]): number {
  return messages.findLastIndex((m) => m.review?.status === 'ready') + 1;
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
