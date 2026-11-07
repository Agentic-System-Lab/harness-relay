// Searching conversations: shared by the server (matching, snippets) and the client (highlighting).

/** Most words in one search, and the longest search. */
const MAX_TERMS = 8;
const MAX_QUERY = 200;

/** The words of a search: split on whitespace, without repeats (ignoring case). Every word must match. */
export function searchTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const word of query.slice(0, MAX_QUERY).split(/\s+/)) {
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    terms.push(word);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches any of the terms, ignoring case; longer terms first, so the longest match wins. */
function termPattern(terms: string[]): RegExp | undefined {
  if (!terms.length) return undefined;
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  return new RegExp(sorted.map(escapeRegExp).join('|'), 'giu');
}

/** Where the terms occur in `text`, ignoring case: [start, end) ranges, in order, overlaps merged. */
export function matchRanges(text: string, terms: string[]): [number, number][] {
  const re = termPattern(terms);
  if (!re) return [];
  const ranges: [number, number][] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges;
}

/** The terms that occur in `text` (ignoring case). */
export function termsIn(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((t) => lower.includes(t.toLowerCase()));
}

/**
 * A one-line excerpt of `text` around its first match: whitespace collapsed, about `width`
 * characters, with "…" where it was cut.
 */
export function snippetAround(text: string, terms: string[], width = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = matchRanges(flat, terms)[0];
  if (!first) return flat.length > width ? flat.slice(0, width - 1) + '…' : flat;
  // Some context before the match, most of the room after it.
  const before = Math.min(first[0], Math.floor(width / 4));
  let start = first[0] - before;
  const end = Math.min(flat.length, start + width);
  start = Math.max(0, Math.min(start, end - width));
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}

/** `text` split into pieces, the matching ones marked, to highlight them. */
export function highlightParts(text: string, terms: string[]): { text: string; match: boolean }[] {
  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const [start, end] of matchRanges(text, terms)) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length || !parts.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}
