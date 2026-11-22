// Where a shared page is read (Harness Relay's viewer on its website), and its links to the files that
// go along with it, into a secret gist of their own. The page is made in the browser before that gist
// exists, so each such link holds a placeholder (`relay-share-file:<n>`, the n-th file), and the server
// puts the file's address on GitHub in its place once the gist has one.

/**
 * Harness Relay's own page that shows a shared conversation, on its website (`site/share/`). It reads
 * the gist's page from GitHub's raw files, not through GitHub's API, which lets a browser that is not
 * signed in ask only 60 times an hour (gistpreview.github.io, which shares were read on before, does):
 * the API only when the raw files cannot say where the gist is.
 */
export const SHARE_VIEWER_URL = 'https://agentic-system-lab.github.io/harness-relay/share/';

/**
 * The address of a gist's shared page on the viewer: its owner and id after the `#` (which the browser
 * never sends to a server), as `gistOf()` in `site/assets/share.js` reads them. Without the owner, the
 * id alone: the viewer then asks GitHub's API where the gist is.
 */
export function shareViewerUrl(owner: string | undefined, id: string): string {
  return `${SHARE_VIEWER_URL}#${owner ? `${encodeURIComponent(owner)}/` : ''}${encodeURIComponent(id)}`;
}

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

/**
 * A size over a share's limit, in MB to one decimal, rounded up (as the limits count it: 1 MB =
 * 1,000,000 bytes), so that one just over 10 MB reads 10.1, never 10.0.
 */
export function megabytesOver(bytes: number): string {
  return (Math.ceil(bytes / 100_000) / 10).toFixed(1);
}

/** A size as the share limits count it (1 MB = 1,000,000 bytes): bytes, KB under 1 MB, else MB to one decimal. */
export function shareSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.min(999, Math.ceil(bytes / 1000))} KB`;
  return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
}

/** Names of files that tend to hold secrets: keys and certificates, and names that say so. */
const SECRET_NAMES = [
  /\.(pem|key|p12|pfx|jks|keystore|gpg|asc|ovpn|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /secret|credential|passw(or)?d|token|api[-_]?key|private[-_]?key/i,
];

/**
 * A file whose name says it may hold secrets: a dotfile (.env, .npmrc, .netrc…), a key or certificate
 * (*.pem, *.key, id_rsa…), or a name with secret, credential, password, token or API key in it.
 */
export function looksSecret(name: string): boolean {
  return name.startsWith('.') || SECRET_NAMES.some((re) => re.test(name));
}
