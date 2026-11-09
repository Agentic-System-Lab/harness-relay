// Makes the page a shared conversation is: a copy of the chat as it is on screen (its header and
// messages), without tool calls, thinking and the app's buttons, with the app's styles and its images
// in it, so it shows the same anywhere. The parts that need no DOM are in share.ts.

import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { SHARE_MAX_BYTES, type ChatMessage } from '../shared/types';
import { Logo } from './components/Logo';
import type { Messages } from './i18n';
import {
  IMAGE_STEPS,
  SHARE_DROP,
  SHARE_KEEP_BUTTONS,
  byteLength,
  keepImages,
  linkKept,
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
function logoSvg(): string {
  const box = document.createElement('div');
  const root = createRoot(box);
  flushSync(() => root.render(<Logo size={20} />));
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

/** Leaves out what a shared page does not show (see SHARE_DROP), and what does nothing outside the app. */
function strip(root: HTMLElement, t: Messages): void {
  root.querySelectorAll(SHARE_DROP.join(',')).forEach((el) => el.remove());
  root.querySelectorAll('button').forEach((b) => {
    if (SHARE_KEEP_BUTTONS.some((c) => b.classList.contains(c))) toSpan(b);
    else b.remove();
  });
  root.querySelectorAll('input, textarea, select').forEach((el) => el.remove());
  root.querySelectorAll('a').forEach((a) => {
    if (linkKept(a.getAttribute('href'))) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else {
      toSpan(a); // a file of this computer, or a link into the app
    }
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
 * to and including `upTo`. Throws ShareTooLargeError when it cannot fit in SHARE_MAX_BYTES.
 */
export async function sharePage(o: {
  chat: HTMLElement;
  messages: ChatMessage[];
  title: string;
  upTo?: string;
  t: Messages;
  lang: string;
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
  strip(page, t);

  const date = new Intl.DateTimeFormat(o.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  page.insertAdjacentHTML('beforeend', shareFooter({ logo: logoSvg(), tagline: t.share.page.tagline, note: t.share.page.note(date) }));

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
  if (base > SHARE_MAX_BYTES) throw new ShareTooLargeError(base);

  const loaded = await Promise.all(sources.map(load));
  let encoded: (string | undefined)[] = [];
  let step = 0;
  for (; step < IMAGE_STEPS.length; step++) {
    encoded = loaded.map((img) => (img ? encode(img, IMAGE_STEPS[step]!) : undefined));
    const total = encoded.reduce((sum, e) => sum + (e?.length ?? 0), base);
    if (total <= SHARE_MAX_BYTES) break;
  }
  step = Math.min(step, IMAGE_STEPS.length - 1);
  const keep = keepImages(base, encoded.map((e) => e?.length)) ?? [];
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
  if (byteLength(html) > SHARE_MAX_BYTES) throw new ShareTooLargeError(byteLength(html));
  return { html, shrunk: step > 0 && images.length > dropped, dropped };
}
