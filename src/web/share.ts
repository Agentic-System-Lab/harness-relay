// A shared conversation is one HTML page that looks like the chat: the header and the messages, as the
// app shows them, without tool calls and thinking. These are the parts of making it that need no DOM.

import { GH_MISSING, GH_SIGNED_OUT, SHARE_MAX_BYTES, type ChatMessage, type SharedPage } from '../shared/types';
import type { Messages } from './i18n';

/** Harness Relay's website: every shared page links to it. */
export const HARNESS_RELAY_URL = 'https://agentic-system-lab.github.io/harness-relay/';

/**
 * What a shared page leaves out: the agents' tool calls and thinking (and the to-do lists, permission
 * requests and changed files that come of them), and what only means something in the app.
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
  '.more-button',
  '.schedule-badge',
  '.plan-ask-save',
  '.file-missing',
];

/** Buttons that show content (the title, a diagram) stay, as plain elements. Every other button goes. */
export const SHARE_KEEP_BUTTONS = ['chat-title', 'mermaid-zoom'];

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

/** The bar at the foot of a shared page, where the composer is in the app: Harness Relay's name, logo and website. */
export function shareFooter(o: { logo: string; tagline: string; note: string }): string {
  const site = HARNESS_RELAY_URL.replace(/^https:\/\//, '').replace(/\/$/, '');
  const link = (cls: string, inner: string) =>
    `<a class="${cls}" href="${HARNESS_RELAY_URL}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
  return (
    '<footer class="share-brand">' +
    link('share-brand-name', `${o.logo}<span>Harness Relay</span>`) +
    `<span class="share-brand-tagline">${escapeHtml(o.tagline)}</span>` +
    `<span class="share-brand-note">${escapeHtml(o.note)}</span>` +
    link('share-brand-site', escapeHtml(site)) +
    '</footer>'
  );
}

/** The whole page: the app's styles in it, the chat as `body` (HTML), and the title of the conversation. */
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
    `<style>${css}</style>`,
    '</head>',
    `<body><div id="root" class="share-page">${o.body}</div></body>`,
    '</html>',
    '',
  ]
    .filter(Boolean)
    .join('\n');
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
