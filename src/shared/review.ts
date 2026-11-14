import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import type { ChatMessage, LeadReview, ReviewHighlight, ReviewKind } from './types';

/*
 * The lead agent's review quotes words of the team's replies (`ReviewHighlight.quote`). The server
 * keeps a quote only when the reply has it, and the chat marks it in the reply. Both look for it in the
 * reply's text as the chat shows it: the server takes that text from the reply's Markdown
 * (`markdownText`), the chat from the rendered reply, a space between its blocks (paragraphs, list
 * items, table cells). Both ignore case, runs of whitespace and Markdown's marks, and a list marker at
 * the start of the quote (a list's numbers are not text in the chat).
 */

/** Characters left out when looking for a quote (by UTF-16 code): Markdown's marks, which a rendered reply does not show. */
const MARKS = new Set([...'*_`#>|[]~'].map((c) => c.charCodeAt(0)));

/** Whether a UTF-16 unit is whitespace, as `\s` says. */
function isSpace(code: number): boolean {
  if (code < 128) return code === 32 || (code >= 9 && code <= 13);
  return /\s/.test(String.fromCharCode(code));
}

/**
 * `parts` (strings in order, as a reply's text nodes) as one string to search: whitespace collapsed,
 * marks left out, lower case. `breaks[i]`: part `i` starts a new block, so a space comes before it.
 * With `origins`, where each of its UTF-16 units came from (which part, where in it, how long there),
 * kept in arrays of numbers, not an object a character: a reply of any size is read quickly.
 */
function searchable(
  parts: readonly string[],
  breaks: readonly boolean[] = [],
  origins = false,
): { text: string; part: number[]; offset: number[]; length: number[] } {
  const codes: number[] = [];
  const part: number[] = [];
  const offset: number[] = [];
  const length: number[] = [];
  const push = (code: number, p: number, o: number, l: number) => {
    codes.push(code);
    if (!origins) return;
    part.push(p);
    offset.push(o);
    length.push(l);
  };
  let space = true; // at the start: leading whitespace is left out
  parts.forEach((str, p) => {
    if (breaks[p] && !space) {
      push(32, p, 0, 0);
      space = true;
    }
    for (let i = 0; i < str.length; ) {
      const code = str.charCodeAt(i);
      const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
      const size = pair ? 2 : 1;
      const at = i;
      i += size;
      if (!pair && isSpace(code)) {
        if (!space) {
          push(32, p, at, 1);
          space = true;
        }
        continue;
      }
      if (!pair && MARKS.has(code)) continue;
      if (code < 128) {
        push(code >= 65 && code <= 90 ? code + 32 : code, p, at, 1);
      } else {
        // One origin per UTF-16 unit, as `indexOf` counts (lower case may be longer). The dot above
        // that lower case adds to a dotted capital I (Turkish İ) is left out: "İzmir" is "izmir".
        const lower = str.slice(at, at + size).toLowerCase();
        for (let u = 0; u < lower.length; u++) if (lower.charCodeAt(u) !== 0x307) push(lower.charCodeAt(u), p, at, size);
      }
      space = false;
    }
  });
  let text = '';
  for (let k = 0; k < codes.length; k += 8192) text += String.fromCharCode(...codes.slice(k, k + 8192));
  return { text, part, offset, length };
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
  const { text, part, offset, length } = searchable(parts, breaks, true);
  const at = text.indexOf(key);
  if (at < 0) return undefined;
  const last = at + key.length - 1;
  return { start: { part: part[at]!, offset: offset[at]! }, end: { part: part[last]!, offset: offset[last]! + length[last]! } };
}

/** A character for a numeric entity, or the entity as written when it names none. */
const codePoint = (n: number, all: string) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all);

/** A line with no text in the chat: a table's rule, a thematic break, an empty list item, a heading's underline. */
const ruleLine = (line: string) => (line.includes('-') && /^[ \t|:-]+$/.test(line)) || /^ {0,3}=+[ \t]*$/.test(line);

/** A line that ends in a hard line break written as a backslash (an odd number of them: an even one is text). */
const breakLine = (line: string) => line.endsWith('\\') && /(?:^|[^\\])(?:\\\\)*\\$/.test(line);

/** What a line of a reply is: text, code the chat shows as written, or a code fence (no text). */
const PROSE = 0;
const CODE = 1;
const FENCE = 2;

/** A list item's first line: its indented lines are its text, not code. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/**
 * Which of a reply's lines are code the chat shows as written: a fenced block's (between fences of the
 * same character, the closing one at least as long; a backtick fence's info has no backtick, so
 * "```a``` b" is inline code; one never closed runs to the end), and an indented block's (four spaces
 * or a tab, after a blank line and not in a list, with the blank lines inside it).
 */
function lineKinds(lines: readonly string[]): Uint8Array {
  const kinds = new Uint8Array(lines.length);
  let fence: { char: string; size: number } | undefined;
  let blank = true; // the line before is blank, or there is none, or a block of code ended there
  let list = false;
  let indented = false; // in an indented block of code
  lines.forEach((line, i) => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.size) {
        kinds[i] = FENCE;
        fence = undefined;
        blank = true;
      } else kinds[i] = CODE;
      return;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      kinds[i] = FENCE;
      fence = { char: open[1]![0]!, size: open[1]!.length };
      indented = false;
      return;
    }
    if (!line.trim()) {
      blank = true;
      return;
    }
    if (/^(?: {4}|\t)/.test(line) && (indented || (blank && !list))) {
      kinds[i] = CODE;
      indented = true;
      blank = false;
      return;
    }
    if (LIST_ITEM.test(line)) list = true;
    else if (blank && !/^[ \t]/.test(line)) list = false;
    blank = false;
    indented = false;
  });
  return kinds;
}

/**
 * Footnotes, defined in the reply's text (not its code): a reference to one shows as its number, in
 * the order they are first referred to across the reply, and a definition's text without its label
 * (the chat puts it at the end, which is near enough). Returns what reads them in a run of text, in order.
 */
function footnotes(lines: readonly string[], kinds: Uint8Array): (text: string) => string {
  const defined = new Set<string>();
  lines.forEach((line, i) => {
    const m = kinds[i] === PROSE ? /^ {0,3}\[\^([^\]\s]{1,100})\]:/.exec(line) : null;
    if (m) defined.add(m[1]!.toLowerCase());
  });
  if (!defined.size) return (text) => text;
  const numbers = new Map<string, number>();
  return (text) =>
    text.replace(/^( {0,3})\[\^([^\]\s]{1,100})\]:[ \t]*/gm, '$1').replace(/\[\^([^\]\s]{1,100})\]/g, (all, label: string) => {
      const key = label.toLowerCase();
      if (!defined.has(key)) return all;
      if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
      return String(numbers.get(key));
    });
}

/**
 * Escapes (of any ASCII punctuation) and entities (every named one HTML has, as the chat's Markdown
 * reads them) read, outside inline code (whose text the chat shows as written); `ticks` matches inline
 * code first, which is kept as it is. It opens only where a run of backticks starts (after a backtick
 * that is escaped, too), so a long run is tried once, not from each of its backticks.
 */
const INLINE = /(?<!(?<!\\)`)(`+)[^`\n]{1,2000}?\1(?!`)|\\([!-/:-@[-`{-~])|&([A-Za-z][A-Za-z\d]{1,31});|&#(\d{1,7});|&#[xX]([\da-fA-F]{1,6});/g;

/** A run of a reply's text lines as the chat shows them; `notes` reads its footnotes. */
function inlineText(text: string, notes: (text: string) => string): string {
  return (
    notes(text)
      // An image on the web shows as a link with its alt text (or its address); one on this computer as
      // the image itself, with no text.
      .replace(/!\[([^[\]\n]{0,300})\]\(([^()\s]{0,2048})(?:[ \t]+"[^"\n]{0,500}")?\)/g, (_, alt: string, url: string) =>
        /^(?:https?|ftp):\/\//i.test(url) ? alt || url : ' ',
      )
      .replace(/\[([^[\]\n]{0,300})\]\((?:[^()\n]|\([^()\n]{0,2048}\)){0,2048}\)/g, '$1')
      .replace(/\[([^[\]\n]{0,300})\]\[[^[\]\n]{0,300}\]/g, '$1')
      .replace(/<((?:https?|mailto):[^<>\s]{1,2048})>/g, '$1')
      .replace(/^((?:[ \t]*>)*[ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, '$1')
      .replace(INLINE, (all, ticks?: string, escaped?: string, name?: string, dec?: string, hex?: string) =>
        ticks
          ? all
          : escaped !== undefined
            ? escaped
            : name !== undefined
              ? decodeNamedCharacterReference(name) || all
              : dec !== undefined
                ? codePoint(Number(dec), all)
                : codePoint(parseInt(hex!, 16), all),
      )
  );
}

/**
 * A reply's Markdown as the chat shows its text, near enough to find a quote in it. In its text: links
 * by their text, images left out, footnotes by their numbers, entities and escapes read (not in inline
 * code), list markers, table rules, headings' underlines and hard line breaks dropped (Markdown's other
 * marks are ignored when looking). Its code (fenced or indented) as written, its fences left out.
 */
export function markdownText(md: string): string {
  // Each pattern reads at most a line, and a link's parts at most so far: a reply of any size (nothing
  // shortens it) is read in time proportional to its length.
  const lines = md.split('\n');
  const kinds = lineKinds(lines);
  const notes = footnotes(lines, kinds);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(inlineText(run.join('\n'), notes));
    run = [];
  };
  lines.forEach((line, i) => {
    if (kinds[i] === PROSE) {
      run.push(ruleLine(line) ? ' ' : breakLine(line) && kinds[i + 1] === PROSE && lines[i + 1]!.trim() ? line.slice(0, -1) : line);
      return;
    }
    flush();
    out.push(kinds[i] === FENCE ? ' ' : line);
  });
  flush();
  return out.join('\n');
}

/**
 * Whether a piece of a reply (its Markdown) has a quote's words, as the chat shows it: read once, for
 * as many quotes as asked.
 */
export function quoteChecker(markdown: string): (quote: string) => boolean {
  let text: string | undefined;
  return (quote) => {
    const key = quoteKey(quote);
    if (!key) return false;
    text ??= searchable([markdownText(markdown)]).text;
    return text.includes(key);
  };
}

/** The reply (its Markdown) has these words, as the chat shows it. */
export function hasQuote(markdown: string, quote: string): boolean {
  return quoteChecker(markdown)(quote);
}

/**
 * The question the latest run answers: the user's latest message that did not join a discussion under
 * way (`queued`), with the ones they wrote before it that no agent answered (finished, not a pass) in between (while the team
 * was designed, its design waited for confirmation, or a run could not start: one question); or, when
 * it answered an agent's question, the question before it, and so on.
 */
function firstReviewStart(messages: readonly ChatMessage[]): number {
  const asks = (m: ChatMessage) => m.author.kind === 'user' && !m.queued;
  let at = messages.findLastIndex(asks);
  if (at < 0) return 0;
  for (;;) {
    const before = messages.findLastIndex((m, i) => i < at && asks(m));
    if (before < 0) return at;
    // Only a finished reply answers it: one stopped, failed or passed leaves the question open.
    const replies = messages.slice(before + 1, at).filter((m) => m.author.kind === 'agent' && m.status === 'done' && !m.passed);
    if (replies.length && !replies.some((m) => m.asked)) return at;
    at = before;
  }
}

/**
 * Where the lead agent's next review starts reading: at the question the latest run answers
 * (`firstReviewStart`); or earlier, where the review of the run just before that one started, when it
 * failed or was stopped (it left those replies to this one, and its own start reaches back over the
 * reviews that failed before it); never before its last review that was ready, which read what came
 * before. So a review turned on mid-chat, or again after a while (a review stopped long ago, before
 * other questions, included), reads the latest question, not everything since.
 */
export function reviewStart(messages: readonly ChatMessage[]): number {
  const after = messages.findLastIndex((m) => m.review?.status === 'ready') + 1;
  const start = Math.max(after, firstReviewStart(messages));
  // The latest review that is not ready, if it comes right before the latest question (no other
  // question of the user's between them).
  const pending = messages.findLastIndex((m, i) => i >= after && i < start && m.review && m.review.status !== 'ready');
  if (pending < 0 || messages.slice(pending + 1, start).some((m) => m.author.kind === 'user' && !m.queued)) return start;
  const fromId = messages[pending]!.review!.fromId;
  const from = fromId ? messages.findIndex((m) => m.id === fromId) : -1;
  return from >= after && from < start ? from : start;
}

/**
 * What a ready review says, as text (search): its summary, each highlight's note and quote, and each
 * next step with the message it sends; nothing for a review that is not ready.
 */
export function reviewText(review: LeadReview | undefined): string {
  if (review?.status !== 'ready') return '';
  const lines = [review.summary ?? ''];
  for (const h of review.highlights ?? []) lines.push(h.note, h.quote ?? '');
  for (const s of review.nextSteps ?? []) lines.push(s.text, s.message ?? '');
  return lines.filter((l) => l.trim()).join('\n');
}

/** A question the user might write next, for `nextReviewStart()`. */
const NEXT_QUESTION: ChatMessage = { id: '', author: { kind: 'user' }, createdAt: 0, status: 'done', parts: [] };

/**
 * Where the next review would start reading, were the user to ask another question now: a stopped or
 * failed review before it left replies that review reads (its card says so); one at or after it, none.
 */
export function nextReviewStart(messages: readonly ChatMessage[]): number {
  return reviewStart([...messages, NEXT_QUESTION]);
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
