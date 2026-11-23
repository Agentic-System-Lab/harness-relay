// A hand-over of the chat's browser (`browser_hand_over`) in the page, without React: which way to show
// the page first, where a click on the screencast lands on the page, what a key becomes, how the
// input waiting to go is merged, and what the screencast's stream says. The card and the panel are
// `components/HandoverCard.tsx`.
import { HANDOVER_LIMITS, type HandoverInput, type HandoverMode, type HandoverScreenEvent } from '../shared/types';

/**
 * Which way the card offers first: the window when this computer can show one and the chat seems to be on
 * that computer too (the desktop app, or a page at 127.0.0.1 or localhost), else the screencast. An SSH
 * tunnel also arrives at localhost, which is why the card always says where the window opens.
 */
export function preferredMode(modes: readonly HandoverMode[], where: { desktop: boolean; hostname: string }): HandoverMode {
  if (!modes.includes('window')) return 'screencast';
  const local = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i.test(where.hostname);
  return where.desktop || local ? 'window' : 'screencast';
}

/** A box on the screen: the screencast's image element. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a point on the screen (`x`, `y`, as a pointer event gives it) lands on the page, as fractions of
 * the frame (0 to 1), given the image's box and the frame's size: the frame is fitted in the box keeping
 * its shape (`object-fit: contain`), so the bars beside or above it are no part of the page (undefined
 * there).
 */
export function framePoint(
  x: number,
  y: number,
  box: Box,
  frame: { width: number; height: number },
  /** Outside the frame, its nearest edge instead of nothing (a button let go of past it must still be let go of). */
  clamp = false,
): { x: number; y: number } | undefined {
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return undefined;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const w = frame.width * scale;
  const h = frame.height * scale;
  const left = box.left + (box.width - w) / 2;
  const top = box.top + (box.height - h) / 2;
  let fx = (x - left) / w;
  let fy = (y - top) / h;
  if (clamp) {
    fx = Math.min(1, Math.max(0, fx));
    fy = Math.min(1, Math.max(0, fy));
  }
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return undefined;
  return { x: Math.round(fx * 10_000) / 10_000, y: Math.round(fy * 10_000) / 10_000 };
}

/** The modifier keys held, as Chromium's input takes them: Alt 1, Ctrl 2, Meta (⌘) 4, Shift 8. */
export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** Keys that type nothing but do something on the page: sent as keys. */
const SPECIAL = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Escape',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** A key as the browser's keyboard event gives it. */
export interface KeyLike {
  key: string;
  code: string;
  keyCode: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

/**
 * What a key pressed in the panel's typing box becomes: a key event for the page (Enter, Backspace, the
 * arrows, Tab, Escape; a character typed on a hardware keyboard, with its text; a shortcut: ⌘ or Ctrl
 * with A, Z or Y as the editing command it stands for); `paste` for ⌘ or Ctrl with V, left to the box,
 * whose paste event gives the text; or undefined, left to the box too: an input method composing
 * (keyCode 229), a key an on-screen keyboard does not name ('Unidentified'), the modifier keys alone, and
 * other shortcuts, which a page in another browser should not take from this one (copying, a new tab).
 */
export function keyInput(e: KeyLike, mac: boolean): HandoverInput | 'paste' | undefined {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Unidentified' || e.key === 'Process' || e.key === 'Dead') return undefined;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(e.key)) return undefined;
  const modifiers = modifiersOf(e);
  const base = {
    key: e.key,
    ...(e.code ? { code: e.code } : {}),
    ...(e.keyCode ? { keyCode: e.keyCode } : {}),
    ...(modifiers ? { modifiers } : {}),
  };
  const shortcut = mac ? e.metaKey : e.ctrlKey;
  if (shortcut && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'v') return 'paste';
    if (k === 'a') return { type: 'key', ...base, command: 'selectAll' };
    if (k === 'z') return { type: 'key', ...base, command: e.shiftKey ? 'redo' : 'undo' };
    if (k === 'y' && !mac) return { type: 'key', ...base, command: 'redo' };
    return undefined;
  }
  if (SPECIAL.has(e.key)) return { type: 'key', ...base };
  // A character of a hardware keyboard: with Option on a Mac, or AltGr (Ctrl and Alt) elsewhere, too.
  const typing = [...e.key].length === 1 && !e.metaKey && (mac ? !e.ctrlKey : !e.ctrlKey || e.altKey);
  if (typing) return { type: 'key', ...base, text: e.key };
  return undefined;
}

/**
 * The input waiting to go, merged before it is sent: moves of the pointer one after another become the
 * last one (with what it held), wheel turns add up, but never past what the server takes of one
 * (`HANDOVER_LIMITS.wheelMax`: a new turn starts before). Everything else stays, in order.
 */
export function mergeInputs(list: readonly HandoverInput[]): HandoverInput[] {
  const out: HandoverInput[] = [];
  for (const e of list) {
    const last = out[out.length - 1];
    if (e.type === 'mouse' && e.action === 'move' && last?.type === 'mouse' && last.action === 'move' && last.button === e.button) {
      out[out.length - 1] = e;
    } else if (
      e.type === 'wheel' &&
      last?.type === 'wheel' &&
      last.modifiers === e.modifiers &&
      Math.abs(last.dx + e.dx) <= HANDOVER_LIMITS.wheelMax &&
      Math.abs(last.dy + e.dy) <= HANDOVER_LIMITS.wheelMax
    ) {
      out[out.length - 1] = { ...e, dx: last.dx + e.dx, dy: last.dy + e.dy };
    } else out.push(e);
  }
  return out;
}

/**
 * The next request of the input waiting to go: what `mergeInputs()` makes of it, at most
 * `HANDOVER_LIMITS.eventsMax` events, and the rest, which waits its turn in order.
 */
export function nextBatch(queue: readonly HandoverInput[]): { batch: HandoverInput[]; rest: HandoverInput[] } {
  const merged = mergeInputs(queue);
  return { batch: merged.slice(0, HANDOVER_LIMITS.eventsMax), rest: merged.slice(HANDOVER_LIMITS.eventsMax) };
}

/**
 * What Enter in the panel's address bar sends: the address (`addressOf()`), `typed` only when the user
 * changed what the bar showed of the page (`shown`, the latest address the page went to: after a page
 * refused there, it shows that address, which Enter must not open as one the user typed); or `refused`
 * for another scheme than http and https, which the panel says it does not open.
 */
export function addressEntry(text: string, shown: string): { url: string; typed: boolean } | { refused: true } | undefined {
  const url = addressOf(text);
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { refused: true };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { refused: true };
  const same = (() => {
    try {
      return new URL(shown).href === parsed.href;
    } catch {
      return false;
    }
  })();
  return { url: parsed.href, typed: !same };
}

/** How far a finger may move, in pixels, and how long it may stay down, for a touch to be a tap (a click) rather than a scroll. */
export const TAP = { distance: 10, ms: 600 } as const;

/** Whether a touch from `start` to `end` is a tap: it barely moved, and was quick. */
export function isTap(start: { x: number; y: number; at: number }, end: { x: number; y: number; at: number }): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= TAP.distance && end.at - start.at <= TAP.ms;
}

/** One message of the screencast's stream, or undefined when it is not one (a ping, something else). */
export function screenEvent(data: string): HandoverScreenEvent | undefined {
  try {
    const e = JSON.parse(data) as HandoverScreenEvent;
    if (e?.type === 'frame' && typeof e.data === 'string' && e.width > 0 && e.height > 0) return e;
    if (e?.type === 'location' && typeof e.url === 'string') return e;
    if (e?.type === 'notice' && (e.kind === 'popup' || e.kind === 'refused')) return e;
    if (e?.type === 'ended') return e;
  } catch {
    /* not one */
  }
  return undefined;
}

/**
 * What the panel's address bar opens: the address as typed when it begins with a scheme and `//`
 * (`https://…`, and `file://`, which the server refuses with why); else with `http://` for this computer or
 * a local name or address (`localhost:3000`, `192.168.1.5`, `printer.local`), `https://` for the rest.
 */
export function addressOf(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(t)) return t;
  const host = t.split(/[/?#]/)[0]!.replace(/:\d+$/, '').toLowerCase();
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /^\[?[0-9a-f:]*:[0-9a-f:]*\]?$/.test(host) ||
    /^(127|10)\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
  return `${local ? 'http' : 'https'}://${t}`;
}

/** A page's host, as a button names it (the address itself when it has none). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The whole minutes left until `deadline` (at least one while any time is left; zero once it passed). */
export function minutesLeft(deadline: number, now: number): number {
  const ms = deadline - now;
  return ms <= 0 ? 0 : Math.max(1, Math.round(ms / 60_000));
}

/**
 * The page's size in the panel: the panel's own, in whole pixels within what the server takes (200 to
 * 4000 each way), at the screen's pixel ratio (at most 2, since frames grow with its square). A narrow
 * panel gets a narrow page, which a site made for phones lays out for one.
 */
export function viewportOf(width: number, height: number, ratio: number): Extract<HandoverInput, { type: 'viewport' }> {
  const clamp = (v: number) => Math.min(4000, Math.max(200, Math.round(v)));
  return {
    type: 'viewport',
    width: clamp(width),
    height: clamp(height),
    scale: Math.min(2, Math.max(1, Math.round(ratio * 4) / 4)),
  };
}
