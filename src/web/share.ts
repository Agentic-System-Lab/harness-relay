// A shared conversation is one HTML page that looks like the chat: the header and the messages, as the
// app shows them, without tool calls and thinking. These are the parts of making it that need no DOM.

import {
  GH_MISSING,
  GH_SIGNED_OUT,
  SHARE_FILES_MAX,
  SHARE_FILES_MAX_BYTES,
  SHARE_FILE_LINKS_MAX,
  SHARE_FILE_URL_MAX,
  SHARE_MAX_BYTES,
  type ChatMessage,
  type ShareFileInfo,
  type ShareFileRef,
  type SharedPage,
} from '../shared/types';
import { shareFileHref } from '../shared/share';
import type { Messages } from './i18n';

/** Harness Relay's website: every shared page links to it. */
export const HARNESS_RELAY_URL = 'https://agentic-system-lab.github.io/harness-relay/';

/**
 * What a shared page leaves out: the agents' tool calls and thinking (and the to-do lists, permission
 * requests and changed files that come of them), and what only means something in the app: its
 * controls, the header's badges (mode and rounds, file permission, schedule) and the full-access
 * warning beside the title, and a branch's "Continued from" after its title and its messages (a link into the app).
 */
export const SHARE_DROP = [
  '.tool-group',
  '.todo',
  '.approval-card',
  '.approval-done',
  '.changes-card',
  '.ask-card',
  '.typing',
  '.live-tag',
  '.plan-confirm',
  '.plan-note',
  '.grok-trust',
  '.mermaid-bar',
  '.chat-head-actions',
  '.chat-head-badges',
  '.head-warning',
  '.more-button',
  '.plan-ask-save',
  '.plan-review-box',
  '.file-missing',
  '.branch-divider',
  '.head-branch',
];

/** What the chat shows between its messages that is no message: a branch's "Continued from" line. */
export const BETWEEN_MESSAGES = 'branch-divider';

/**
 * The chat's message elements, in order (each MessageItem is one element), without what sits between
 * them (`BETWEEN_MESSAGES`): what a shared page takes, one element per message.
 */
export function messageElements<T extends { classList: { contains(name: string): boolean } }>(children: T[]): T[] {
  return children.filter((el) => !el.classList.contains(BETWEEN_MESSAGES));
}

/** Buttons that show content (the title, a diagram, the reply a review's point is about) stay, as plain elements. Every other button goes. */
export const SHARE_KEEP_BUTTONS = ['chat-title', 'mermaid-zoom', 'review-reply-link'];

/**
 * A role folded to its first lines (RoleText, as in the team design): its box, the class that folds its
 * text (a <p>), and its "Show more" button, which a shared page turns into shareFold().
 */
export const SHARE_FOLD = { box: 'role-text', folded: 'folded', button: 'show-more' };

/**
 * How wide a window a shared page's roles are measured in (sharePage.tsx): wide enough for its widest
 * layout, with the chat's column at its widest and none of styles.css's narrow layouts (max-width media
 * queries) in force.
 */
export const SHARE_WIDEST = 1600;

/**
 * "Show more" on a shared page, which runs no script: a <details> whose <summary> opens and folds the
 * role it is in with CSS alone (SHARE_CSS), naming what a click does. `open`: the role was shown whole
 * in the chat.
 */
export function shareFold(o: { open: boolean; more: string; less: string }): string {
  return (
    `<details class="share-fold"${o.open ? ' open' : ''}><summary class="${SHARE_FOLD.button}">` +
    `<span class="share-fold-more">${escapeHtml(o.more)}</span>` +
    `<span class="share-fold-less">${escapeHtml(o.less)}</span>` +
    '</summary></details>'
  );
}

/** What shareRoleFolds() reads and changes of an element: a DOM Element is one. */
export interface FoldElement {
  tagName: string;
  children: ArrayLike<FoldElement>;
  classList: { contains(name: string): boolean; remove(name: string): void };
  getAttribute(name: string): string | null;
  insertAdjacentHTML(where: 'afterend', html: string): void;
  remove(): void;
}

/** The first element inside `el` (at any depth, in order) that `test` takes. */
function findInside<E extends FoldElement>(el: E, test: (e: E) => boolean): E | undefined {
  for (const child of Array.from(el.children) as E[]) {
    if (test(child)) return child;
    const inner = findInside(child, test);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * The roles (each a `.role-text`) as a shared page shows them. No script runs there to measure a role
 * at the viewer's width, and CSS cannot tell whether text overflows, so each one's text is whole,
 * never cut with nothing to open it, unless it is `long`: too long for its lines however wide a screen
 * shows it, as the sharing browser lays it out at the page's widest (SHARE_WIDEST; undefined when it
 * could not be measured, and then a role with "Show more" on screen counts). A long role gets
 * shareFold() in place of its button, folded or open as it was on screen, and SHARE_CSS folds its text
 * while that is shut. Another browser, or other fonts, may wrap a role right at its limit otherwise:
 * there it shows whole a line longer than the app would fold it, or with a "Show more" that opens
 * nothing more.
 */
export function shareRoleFolds<E extends FoldElement>(roles: { box: E; long?: boolean }[], words: { more: string; less: string }): void {
  for (const { box, long } of roles) {
    const text = findInside(box, (e) => e.tagName.toLowerCase() === 'p');
    text?.classList.remove(SHARE_FOLD.folded);
    const button = findInside(box, (e) => e.tagName.toLowerCase() === 'button' && e.classList.contains(SHARE_FOLD.button));
    if (!(long ?? Boolean(button))) continue;
    const toggle = shareFold({ open: button?.getAttribute('aria-expanded') === 'true', ...words });
    (button ?? text)?.insertAdjacentHTML('afterend', toggle);
    button?.remove();
  }
}

/**
 * Styles every shared page brings itself, as they are, whatever browser made it (the app's own come
 * from that browser's copy of them, which leaves out what it cannot read): a folded role's "Show more"
 * (shareFold). A role's text is folded only while its toggle is shut, and only where :has() works;
 * elsewhere the toggle is hidden and the role shown whole.
 */
export const SHARE_CSS = `
.share-fold { display: none; }
@supports selector(:has(*)) {
  .share-fold { display: block; }
  .${SHARE_FOLD.box}:has(.share-fold:not([open])) p {
    display: -webkit-box;
    -webkit-line-clamp: var(--lines, 3);
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
}
.share-fold > summary { width: fit-content; list-style: none; cursor: pointer; }
.share-fold > summary::-webkit-details-marker { display: none; }
.share-fold[open] .share-fold-more,
.share-fold:not([open]) .share-fold-less { display: none; }
`;

/**
 * How images are made smaller, one step at a time, until the page fits in SHARE_MAX_BYTES: the
 * longest side in pixels, and the WebP (or JPEG) quality.
 */
export const IMAGE_STEPS = [
  { max: 1280, quality: 0.82 },
  { max: 800, quality: 0.7 },
  { max: 480, quality: 0.6 },
];

/**
 * The messages a share holds: all of them, or those up to and including `id`. Undefined when that reply
 * is gone (retried or edited away since): never the whole conversation instead.
 */
export function messagesUpTo(messages: ChatMessage[], id?: string): ChatMessage[] | undefined {
  if (!id) return messages;
  const i = messages.findIndex((m) => m.id === id);
  return i < 0 ? undefined : messages.slice(0, i + 1);
}

/** A reply in it is still being written: a page made now would show it cut short, as if it were done. */
export function stillStreaming(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.status === 'streaming');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** A link that still goes somewhere on a page outside the app: a web or mail address. */
export function linkKept(href: string | null): boolean {
  return href !== null && /^(https?:|mailto:)/i.test(href.trim());
}

/**
 * Which images a page of `base` bytes (without them) keeps, when each takes `sizes[i]` bytes
 * (undefined: it could not be read). The largest are left out first until the page fits in `limit`.
 * Null when the page is too large even without images.
 */
export function keepImages(base: number, sizes: (number | undefined)[], limit = SHARE_MAX_BYTES): boolean[] | null {
  if (base > limit) return null;
  const keep = sizes.map((s) => s !== undefined);
  let total = base + sizes.reduce<number>((sum, s) => sum + (s ?? 0), 0);
  const largest = sizes.map((s, i) => ({ s: s ?? 0, i })).sort((a, b) => b.s - a.s);
  for (const { s, i } of largest) {
    if (total <= limit) break;
    if (!keep[i]) continue;
    keep[i] = false;
    total -= s;
  }
  return keep;
}

/**
 * Nothing on a shared page loads from anywhere: no scripts, and only styles and images it holds.
 * (Through gistpreview.github.io, too, which writes the page into its own.)
 */
export const SHARE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/**
 * The bar at the foot of a shared page, where the composer is in the app: Harness Relay's logo and
 * name, its tagline, and when the page was shared with a link icon beside it. The logo and the icon
 * both link to Harness Relay's website (`siteLabel` names it for the icon, which has no text).
 */
export function shareFooter(o: { logo: string; icon: string; tagline: string; note: string; siteLabel: string }): string {
  const link = (cls: string, inner: string, label?: string) =>
    `<a class="${cls}" href="${HARNESS_RELAY_URL}" target="_blank" rel="noopener noreferrer"${
      label ? ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"` : ''
    }>${inner}</a>`;
  return (
    '<footer class="share-brand">' +
    link('share-brand-name', `${o.logo}<span>Harness Relay</span>`) +
    `<span class="share-brand-tagline">${escapeHtml(o.tagline)}</span>` +
    // Together, so the icon stays beside the time when the bar wraps.
    `<span class="share-brand-shared"><span class="share-brand-note">${escapeHtml(o.note)}</span>` +
    link('share-brand-site', o.icon, o.siteLabel) +
    '</span></footer>'
  );
}

/** The whole page: the app's styles in it (and SHARE_CSS), the chat as `body` (HTML), and the title of the conversation. */
export function shareDocument(o: { lang: string; title: string; css: string; body: string; icon?: string }): string {
  // A stylesheet cannot end the <style> element early.
  const css = o.css.replace(/<\/style/gi, '<\\/style');
  const icon = o.icon?.startsWith('data:') ? `<link rel="icon" href="${escapeHtml(o.icon)}">` : '';
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(o.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SHARE_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="generator" content="Harness Relay">',
    `<title>${escapeHtml(o.title)} · Harness Relay</title>`,
    icon,
    `<style>${css}\n${SHARE_CSS}</style>`,
    '</head>',
    `<body><div id="root" class="share-page">${o.body}</div></body>`,
    '</html>',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A share's files gist on GitHub (only github.com gists are kept: gistpreview reads no other). */
export function filesGistUrl(id: string): string {
  return `https://gist.github.com/${id}`;
}

/** What a share holds, for the list in Settings: the whole conversation, or up to one reply. */
export function shareScope(s: Pick<SharedPage, 'upTo'>, t: Messages): string {
  return s.upTo ? t.share.list.upTo(s.upTo.agentName) : t.share.list.whole;
}

/** Where to get, and how to sign in to, the GitHub CLI that creates and removes the gists. */
export const GH_LINKS = {
  site: 'https://cli.github.com/',
  linux: 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md',
  login: 'https://cli.github.com/manual/gh_auth_login',
  signup: 'https://github.com/signup',
};

/** The official install commands (cli/cli's docs/install_macos.md and install_windows.md). */
export const GH_INSTALL = { macos: 'brew install gh', windows: 'winget install --id GitHub.cli --source winget' };

/** Whether an error from the share routes is about the GitHub CLI: not installed, or not signed in. */
export function ghProblem(e: unknown): typeof GH_MISSING | typeof GH_SIGNED_OUT | undefined {
  const code = typeof e === 'object' && e !== null && 'code' in e ? (e as { code?: unknown }).code : undefined;
  return code === GH_MISSING || code === GH_SIGNED_OUT ? code : undefined;
}

// --- The files a shared page links to --------------------------------------------------

/**
 * The file a link of the chat downloads (a FileLink: `/api/conversations/<id>/messages/<reply>/download?path=…`),
 * when it is one of this conversation's. Undefined for any other link.
 */
export function fileRefOf(href: string | null, convId: string): ShareFileRef | undefined {
  if (!href?.startsWith('/api/')) return undefined;
  let url: URL;
  try {
    url = new URL(href, 'http://relay.invalid');
  } catch {
    return undefined;
  }
  const m = /^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/download$/.exec(url.pathname);
  const path = url.searchParams.get('path');
  if (!m || !path) return undefined;
  try {
    return decodeURIComponent(m[1]!) === convId ? { messageId: decodeURIComponent(m[2]!), path } : undefined;
  } catch {
    return undefined;
  }
}

/** The same link: from the same reply, by the same path. */
export const fileRefKey = (r: ShareFileRef): string => `${r.messageId}\n${r.path}`;

/** The files the links (hrefs, in order) download, each link once, at most `max` of them. */
export function fileRefsOf(hrefs: (string | null)[], convId: string, max = SHARE_FILE_LINKS_MAX): ShareFileRef[] {
  const seen = new Set<string>();
  const refs: ShareFileRef[] = [];
  for (const href of hrefs) {
    const ref = fileRefOf(href, convId);
    if (!ref || seen.has(fileRefKey(ref))) continue;
    seen.add(fileRefKey(ref));
    refs.push(ref);
    if (refs.length >= max) break;
  }
  return refs;
}

/** What the files chosen come to, and the limit they are over (if any). */
export function fileSelection(files: ShareFileInfo[], chosen: boolean[]): { count: number; bytes: number; over?: 'count' | 'bytes' } {
  let count = 0;
  let bytes = 0;
  files.forEach((f, i) => {
    if (!chosen[i] || f.problem) return;
    count++;
    bytes += f.size ?? 0;
  });
  const over = count > SHARE_FILES_MAX ? 'count' : bytes > SHARE_FILES_MAX_BYTES ? 'bytes' : undefined;
  return over ? { count, bytes, over } : { count, bytes };
}

/** Names of files that tend to hold secrets: keys and certificates, and names that say so. */
const SECRET_NAMES = [
  /\.(pem|key|p12|pfx|jks|keystore|gpg|asc|ovpn|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /secret|credential|passw(or)?d|token|api[-_]?key|private[-_]?key/i,
];

/**
 * A file whose name says it may hold secrets: a dotfile (.env, .npmrc, .netrc…), a key or certificate
 * (*.pem, *.key, id_rsa…), or a name with secret, credential, password, token or API key in it. It is
 * left unchecked at first; the user may still choose it.
 */
export function looksSecret(name: string): boolean {
  return name.startsWith('.') || SECRET_NAMES.some((re) => re.test(name));
}

/**
 * The files chosen, once the server has checked them (`next`): a file seen before (by its path) keeps
 * the user's choice from `before`, while it can go along. A new one is chosen when it can go along,
 * does not look secret, and still fits in SHARE_FILES_MAX and SHARE_FILES_MAX_BYTES with those chosen.
 */
export function nextFileSelection(next: ShareFileInfo[], before?: { list: ShareFileInfo[]; chosen: boolean[] }): boolean[] {
  // Only a file that could be chosen was chosen or left out by the user.
  const was = new Map<string, boolean>();
  before?.list.forEach((f, i) => !f.problem && was.set(f.path, Boolean(before.chosen[i])));
  const kept = next.map((f) => (f.problem ? false : was.get(f.path)));
  let count = 0;
  let bytes = 0;
  kept.forEach((k, i) => {
    if (!k) return;
    count++;
    bytes += next[i]!.size ?? 0;
  });
  return next.map((f, i) => {
    const k = kept[i];
    if (k !== undefined) return k;
    if (looksSecret(f.name) || count >= SHARE_FILES_MAX || bytes + (f.size ?? 0) > SHARE_FILES_MAX_BYTES) return false;
    count++;
    bytes += f.size ?? 0;
    return true;
  });
}

/** The files chosen when the dialog opens (see nextFileSelection). */
export function defaultFileSelection(files: ShareFileInfo[]): boolean[] {
  return nextFileSelection(files);
}

/** The links to the files chosen (`files[i].refs` name places in `refs`), in the order of `refs`. */
export function chosenFileRefs(refs: ShareFileRef[], files: ShareFileInfo[], chosen: boolean[]): ShareFileRef[] {
  const picked = new Set<number>();
  files.forEach((f, i) => {
    if (chosen[i] && !f.problem) f.refs.forEach((r) => picked.add(r));
  });
  return refs.filter((_, i) => picked.has(i));
}

/** A link of the chat, as a shared page sees it: where it goes, whether it is a FileLink, and whether a part the page leaves out holds it. */
export interface ShareAnchor {
  href: string | null;
  fileLink: boolean;
  dropped: boolean;
}

/**
 * What a shared page makes of a link: `gone` with a part it leaves out; `file`, a link to a file that
 * goes along, pointing at its placeholder, without `download` (the file is on another site then, where
 * a browser would not heed it); `link`, a web or mail address that stays; else `text` (a file left
 * behind, or a link into the app). A file left behind loses its download icon too (`icon: false`): it
 * cannot be downloaded from the page.
 */
export type AnchorPlan =
  | { as: 'gone' }
  | { as: 'text'; icon?: false }
  | { as: 'link'; href: string; remove: string[]; file: boolean };

/** What the page makes of `a`, `files` being the links to the files that go along, their places their placeholders' numbers. */
export function anchorPlan(a: ShareAnchor, convId: string, files: ShareFileRef[]): AnchorPlan {
  if (a.dropped) return { as: 'gone' };
  if (a.fileLink) {
    const ref = fileRefOf(a.href, convId);
    const n = ref ? files.findIndex((f) => fileRefKey(f) === fileRefKey(ref)) : -1;
    if (n >= 0) return { as: 'link', href: shareFileHref(n), remove: ['download'], file: true };
    // A file left behind (or one this page cannot point at): plain text, without the download icon.
    if (ref) return { as: 'text', icon: false };
  }
  return linkKept(a.href) ? { as: 'link', href: a.href!, remove: [], file: false } : { as: 'text' };
}

/** How many links on the page point at files that go along: each leaves room for its address on GitHub. */
export function fileLinkRoom(plans: AnchorPlan[]): number {
  return plans.filter((p) => p.as === 'link' && p.file).length * SHARE_FILE_URL_MAX;
}

/** The files the page's links download (FileLinks outside the parts it leaves out), each link once, in order. */
export function linkedFileRefs(anchors: ShareAnchor[], convId: string): ShareFileRef[] {
  return fileRefsOf(
    anchors.filter((a) => a.fileLink && !a.dropped).map((a) => a.href),
    convId,
  );
}
