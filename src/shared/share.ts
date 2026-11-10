// A shared page's links to the files that go along with it, into a secret gist of their own. The page
// is made in the browser before that gist exists, so each such link holds a placeholder
// (`relay-share-file:<n>`, the n-th file), and the server puts the file's address on GitHub in its
// place once the gist has one.

/**
 * A placeholder link: only as the href of a real <a> tag. Text of the chat cannot open a tag (`<` is
 * escaped in text), and an attribute's value cannot hold a bare `"`, so text that merely reads
 * `href="relay-share-file:0"` never matches.
 */
const PLACEHOLDER = /(<a\b[^<>]*?\s)href="relay-share-file:(\d+)"/g;

/** The placeholder href of a link to the `n`-th file. */
export function shareFileHref(n: number): string {
  return `relay-share-file:${n}`;
}

/** The files the page links to, by number, each once, in the order they are first linked. */
export function fileLinksIn(html: string): number[] {
  const seen = new Set<number>();
  for (const m of html.matchAll(PLACEHOLDER)) seen.add(Number(m[2]));
  return [...seen];
}

/** How many links to files the page has (a file linked twice counts twice). */
export function fileLinkCount(html: string): number {
  return Array.from(html.matchAll(PLACEHOLDER)).length;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The page with each placeholder link's href replaced by `href(n)` (escaped), or left as it is when that is undefined. */
export function replaceFileLinks(html: string, href: (n: number) => string | undefined): string {
  return html.replace(PLACEHOLDER, (whole, tag: string, n: string) => {
    const to = href(Number(n));
    return to === undefined ? whole : `${tag}href="${attr(to)}"`;
  });
}

/** A size as the share limits count it (1 MB = 1,000,000 bytes): bytes, KB under 1 MB, else MB to one decimal. */
export function shareSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.min(999, Math.ceil(bytes / 1000))} KB`;
  return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
}
