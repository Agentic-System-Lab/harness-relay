// Makes the page a shared conversation is: a copy of the chat as it is on screen (its header and
// messages), without tool calls, thinking and the app's buttons, with the app's styles and its images
// in it, so it shows the same anywhere. Links to the files that go along with it (into a gist of their own) hold
// placeholders the server fills in. The parts that need no DOM are in share.ts.

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { SHARE_MAX_BYTES, type ChatMessage, type ShareFileRef } from '../shared/types';
import { Logo } from './components/Logo';
import { LinkIcon } from './components/icons';
import type { Messages } from './i18n';
import {
  IMAGE_STEPS,
  SHARE_DROP,
  SHARE_KEEP_BUTTONS,
  anchorPlan,
  byteLength,
  fileLinkRoom,
  keepImages,
  linkedFileRefs,
  type ShareAnchor,
  messagesUpTo,
  shareDocument,
  shareFooter,
} from './share';

export interface SharePage {
  html: string;
  /** Images were made smaller to fit. */
  shrunk: boolean;
  /** Images left out to fit (or that could not be read). */
  dropped: number;
}

/** Why a page could not be made, in words for the user. */
export class SharePageError extends Error {}

/** The page is too large even without images; `bytes` is its size. */
export class ShareTooLargeError extends Error {
  constructor(public bytes: number) {
    super(`shared page of ${bytes} bytes`);
  }
}

/** Every rule of the app's stylesheets. */
function appCss(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) rules.push(rule.cssText);
    } catch {
      /* a stylesheet from another origin cannot be read; the app has none */
    }
  }
  return rules.join('\n');
}

/** The Harness Relay mark as SVG markup. */
function svgOf(node: React.ReactNode): string {
  const box = document.createElement('div');
  const root = createRoot(box);
  flushSync(() => root.render(node));
  const svg = box.innerHTML;
  root.unmount();
  return svg;
}

/** `el` replaced by a <span> with its classes and children (a button or link that does nothing here). */
function toSpan(el: Element): void {
  const span = document.createElement('span');
  const cls = el.getAttribute('class');
  if (cls) span.className = cls;
  span.append(...Array.from(el.childNodes));
  el.replaceWith(span);
}

function placeholder(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'media-missing';
  span.textContent = text;
  return span;
}

/** A link of the chat as anchorPlan() takes it. */
const anchorOf = (a: Element, dropped: boolean): ShareAnchor => ({
  href: a.getAttribute('href'),
  fileLink: a.classList.contains('file-link'),
  dropped,
});

/**
 * Leaves out what a shared page does not show (see SHARE_DROP), and what does nothing outside the app.
 * A link to one of `files` (of conversation `convId`) points at its placeholder (see anchorPlan).
 * Returns the room those links need for their addresses on GitHub.
 */
function strip(root: HTMLElement, t: Messages, convId = '', files: ShareFileRef[] = []): number {
  root.querySelectorAll(SHARE_DROP.join(',')).forEach((el) => el.remove());
  root.querySelectorAll('button').forEach((b) => {
    if (SHARE_KEEP_BUTTONS.some((c) => b.classList.contains(c))) toSpan(b);
    else b.remove();
  });
  root.querySelectorAll('input, textarea, select').forEach((el) => el.remove());
  const plans = Array.from(root.querySelectorAll('a')).map((a) => {
    const plan = anchorPlan(anchorOf(a, false), convId, files);
    if (plan.as === 'link') {
      a.setAttribute('href', plan.href);
      plan.remove.forEach((name) => a.removeAttribute(name));
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else {
      // A file of this computer left behind loses its download icon; a link into the app is just text.
      if (plan.as === 'text' && plan.icon === false) a.querySelectorAll('svg').forEach((svg) => svg.remove());
      toSpan(a);
    }
    return plan;
  });
  root.querySelectorAll('video').forEach((v) => v.replaceWith(placeholder(t.share.page.video(v.title || ''))));
  // A reply that was only tool calls and thinking says nothing now.
  root.querySelectorAll('.msg-agent').forEach((m) => {
    const body = m.querySelector('.msg-body');
    if (body && Array.from(body.children).every((c) => c.matches('.msg-head, .msg-actions'))) m.remove();
  });
  root.querySelectorAll('.msg-actions').forEach((a) => a.childElementCount === 0 && a.remove());
  root.querySelectorAll('.bubble.folded').forEach((b) => b.classList.remove('folded'));
  root.querySelectorAll('.team-chip.speaking').forEach((c) => c.classList.remove('speaking'));
  root.querySelectorAll('[aria-expanded], [aria-controls], [aria-pressed]').forEach((el) => {
    el.removeAttribute('aria-expanded');
    el.removeAttribute('aria-controls');
    el.removeAttribute('aria-pressed');
  });
  // Tooltips name what the app's controls do, and some hold a path on this computer (a missing image's).
  root.querySelectorAll('[title]').forEach((el) => el.removeAttribute('title'));
  return fileLinkRoom(plans);
}

/** The messages a share holds, as ChatView shows them (each MessageItem is one element, in order); undefined when they cannot be told. */
function shownItems(chat: HTMLElement, messages: ChatMessage[], upTo?: string): Element[] | undefined {
  const range = messagesUpTo(messages, upTo);
  const inner = chat.querySelector('.messages-inner');
  const items = inner ? Array.from(inner.children) : [];
  return range && items.length === messages.length ? items.slice(0, range.length) : undefined;
}

/**
 * The files the messages a share holds link to (each FileLink, outside what a shared page leaves
 * out), each link once, in order; `convId`: the conversation's id, which their download links name.
 */
export function linkedFiles(o: { chat: HTMLElement; messages: ChatMessage[]; upTo?: string; convId: string }): ShareFileRef[] {
  const items = shownItems(o.chat, o.messages, o.upTo) ?? [];
  const dropped = SHARE_DROP.join(',');
  const anchors = items.flatMap((el) => Array.from(el.querySelectorAll('a')).map((a) => anchorOf(a, a.closest(dropped) !== null)));
  return linkedFileRefs(anchors, o.convId);
}

/** An image of the app (an attachment, a reply's image of this computer), read so it can be drawn smaller. */
async function load(src: string): Promise<HTMLImageElement | undefined> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img.naturalWidth > 0 && img.naturalHeight > 0 ? img : undefined;
  } catch {
    return undefined; // gone, or not an image the browser can draw
  }
}

/** The image as a data URL no larger than `step` allows: WebP, or JPEG where the browser cannot write WebP. */
function encode(img: HTMLImageElement, step: { max: number; quality: number }): string {
  const scale = Math.min(1, step.max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const webp = canvas.toDataURL('image/webp', step.quality);
  if (webp.startsWith('data:image/webp')) return webp;
  // JPEG has no transparency: what was transparent becomes white, not black.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', step.quality);
}

/**
 * The shared page of the conversation shown in `chat` (ChatView's root element): every message, or up
 * to and including `upTo`. Throws ShareTooLargeError when it cannot fit in SHARE_MAX_BYTES. The links
 * to `files` (of conversation `convId`) point at placeholders, the n-th file's at `shareFileHref(n)`,
 * and each leaves room for the address on GitHub it gets; links to other files are plain text.
 */
export async function sharePage(o: {
  chat: HTMLElement;
  messages: ChatMessage[];
  title: string;
  upTo?: string;
  t: Messages;
  lang: string;
  convId?: string;
  files?: ShareFileRef[];
}): Promise<SharePage> {
  const { t } = o;
  const range = messagesUpTo(o.messages, o.upTo);
  if (!range) throw new SharePageError(t.share.gone);
  const head = o.chat.querySelector('.chat-head');
  const inner = o.chat.querySelector('.messages-inner');
  const items = inner ? Array.from(inner.children) : [];
  // Each MessageItem is one element, in the order of the messages.
  if (!head || items.length !== o.messages.length) throw new SharePageError(t.share.notOnScreen);
  const end = range.length;
  // A message being edited shows the edit box instead of its text.
  if (items.slice(0, end).some((el) => el.querySelector('.edit-box'))) throw new SharePageError(t.share.editing);

  const page = document.createElement('div');
  page.className = 'chat';
  const scroller = document.createElement('div');
  scroller.className = 'messages';
  const list = document.createElement('div');
  list.className = 'messages-inner';
  list.append(...items.slice(0, end).map((el) => el.cloneNode(true)));
  scroller.append(list);
  page.append(head.cloneNode(true), scroller);
  // Each link to a file grows to its address on GitHub once the server fills it in.
  const room = strip(page, t, o.convId, o.files);
  const limit = SHARE_MAX_BYTES - room;

  const date = new Intl.DateTimeFormat(o.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  page.insertAdjacentHTML(
    'beforeend',
    shareFooter({
      logo: svgOf(<Logo size={20} />),
      icon: svgOf(<LinkIcon size={14} />),
      tagline: t.share.page.tagline,
      note: t.share.page.note(date),
      siteLabel: t.share.page.site,
    }),
  );

  // The images the page holds as data URLs (diagrams already are): left empty while the page is measured.
  const images = Array.from(page.querySelectorAll('img')).filter((img) => !img.getAttribute('src')?.startsWith('data:'));
  const sources = images.map((img) => img.src);
  for (const img of images) {
    img.removeAttribute('loading');
    img.removeAttribute('srcset');
    img.setAttribute('src', '');
  }
  const css = appCss();
  const icon = document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? undefined;
  const doc = () => shareDocument({ lang: o.lang, title: o.title, css, body: page.outerHTML, icon });
  const base = byteLength(doc());
  if (base > limit) throw new ShareTooLargeError(base + room);

  const loaded = await Promise.all(sources.map(load));
  let encoded: (string | undefined)[] = [];
  let step = 0;
  for (; step < IMAGE_STEPS.length; step++) {
    encoded = loaded.map((img) => (img ? encode(img, IMAGE_STEPS[step]!) : undefined));
    const total = encoded.reduce((sum, e) => sum + (e?.length ?? 0), base);
    if (total <= limit) break;
  }
  step = Math.min(step, IMAGE_STEPS.length - 1);
  const keep = keepImages(base, encoded.map((e) => e?.length), limit) ?? [];
  let dropped = 0;
  images.forEach((img, i) => {
    const data = encoded[i];
    if (keep[i] && data) {
      img.setAttribute('src', data);
    } else {
      dropped++;
      img.replaceWith(placeholder(t.share.page.image(img.alt)));
    }
  });
  const html = doc();
  if (byteLength(html) > limit) throw new ShareTooLargeError(byteLength(html) + room);
  return { html, shrunk: step > 0 && images.length > dropped, dropped };
}
