import { randomUUID } from 'node:crypto';
import {
  HANDOVER_LIMITS,
  type HandoverAnswer,
  type HandoverInput,
  type HandoverMode,
  type HandoverScreenEvent,
  type HandoverWindowAt,
} from '../../shared/types';
import { dataLine } from '../gateway';
import { runSync } from '../process';

/*
 * Taking over the chat's browser (`browser_hand_over`): when a page needs the user (a sign-in, a
 * two-factor code, a CAPTCHA, a consent screen), an agent hands it to them, and its call waits until they
 * hand it back, decline, or the time runs out (`HANDOVER_LIMITS`), then hears only how it ended and the
 * note the user wrote, never the page or what they typed. The page is shown one of two ways: in a window
 * of the browser itself on the computer Harness Relay runs on (the same profile, started without
 * `--headless=new`), or as Chromium's screencast in the chat, with the user's clicks and keys sent back.
 * Either way it is the same browser, with the same proxy and gate: a page on a host the chat's browser has
 * not opened asks as usual below full access, and it keeps to one tab. The browser itself does the work
 * (`BrowserService.handOver()` in `session.ts`); this holds what stands between it and the user: each
 * hand-over's ticket (what the user answered, what the screencast panel is told), what this computer can
 * show, what the user's input becomes, and what the agent is told.
 */

/** Whether a Mac's server runs in a session signed in at its screen (launchd's `Aqua`), which can show a window. */
let guiSession: boolean | undefined;
export function macGuiSession(): boolean {
  if (guiSession === undefined) {
    const r = runSync('launchctl', ['managername'], { timeoutMs: 2000 });
    guiSession = r.status === 0 && r.stdout.trim() === 'Aqua';
  }
  return guiSession;
}

/**
 * Where a hand-over's window can open, or undefined when this computer cannot show one: beside the desktop
 * app; on a Mac whose server runs in a session signed in at its screen (not one started over SSH); on Linux
 * with a display (`DISPLAY` or `WAYLAND_DISPLAY`); on Windows in a session someone signed in to
 * (`SESSIONNAME`, which a service in session 0 has not). A codespace or a server reached over SSH offers
 * the screencast only.
 */
export function handoverWindowAt(o: {
  desktop: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  macGui: () => boolean;
}): HandoverWindowAt | undefined {
  if (o.desktop) return 'desktop';
  if (o.platform === 'win32') return o.env.SESSIONNAME ? 'server' : undefined;
  if (o.platform === 'darwin') return o.macGui() ? 'server' : undefined;
  if (o.platform === 'linux' || o.platform === 'freebsd' || o.platform === 'openbsd')
    return o.env.DISPLAY || o.env.WAYLAND_DISPLAY ? 'server' : undefined;
  return undefined;
}

/** The page as the card shows it: its address without the query or fragment (which may carry a token), or undefined for none. */
export function cardUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return `${u.origin}${u.pathname}`.slice(0, 300);
  } catch {
    return undefined;
  }
}

/** What comes next in a hand-over: the user's answer, the window closed, the time limit, the turn's end, or the browser gone. */
export type HandoverWake =
  | HandoverAnswer
  | { action: 'timeout' }
  | { action: 'turn' }
  | { action: 'gone' }
  | { action: 'closed' }
  | { action: 'failed'; error: string };

/** What the screencast panel's input reaches: the browser showing the page. */
export interface HandoverScreen {
  input(events: HandoverInput[]): Promise<void>;
}

/**
 * One hand-over: where it stands (`pending` until the user starts it, `active` while they have it,
 * `over`), what wakes its call, and the screencast's watchers, who get the latest frame and address first.
 */
export class HandoverTicket {
  status: 'pending' | 'starting' | 'active' | 'ending' | 'over' = 'pending';
  mode?: HandoverMode;
  screen?: HandoverScreen;
  private waiter?: (w: HandoverWake) => void;
  private queued?: HandoverWake;
  private readonly watchers = new Set<(e: HandoverScreenEvent) => void>();
  private latest: { frame?: HandoverScreenEvent; location?: HandoverScreenEvent } = {};

  constructor(
    readonly id: string,
    readonly convId: string,
    readonly modes: readonly HandoverMode[],
  ) {}

  /**
   * What comes next, within `ms`: the user's answer, the window closed, the time limit, the turn's end, or
   * the CLI no longer waiting for the call (`gone`, looked at every second).
   */
  wait(ms: number, signal: AbortSignal, gone?: () => boolean): Promise<HandoverWake> {
    if (this.queued) {
      const w = this.queued;
      this.queued = undefined;
      return Promise.resolve(w);
    }
    return new Promise((resolve) => {
      const finish = (w: HandoverWake) => {
        clearTimeout(timer);
        clearInterval(watch);
        signal.removeEventListener('abort', onAbort);
        this.waiter = undefined;
        resolve(w);
      };
      const onAbort = () => finish({ action: 'turn' });
      const timer = setTimeout(() => finish({ action: 'timeout' }), ms);
      timer.unref?.();
      const watch = setInterval(() => gone?.() && finish({ action: 'gone' }), 1000);
      watch.unref?.();
      if (!gone) clearInterval(watch);
      this.waiter = finish;
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Wakes the call (or keeps what happened for its next wait); nothing once the hand-over is over. */
  wake(w: HandoverWake): void {
    if (this.status === 'over') return;
    if (this.waiter) this.waiter(w);
    else this.queued ??= w;
  }

  /** Tells the screencast's watchers (a frame, the page's address, a window closed), keeping the latest frame and address for those who come later. */
  emit(e: HandoverScreenEvent): void {
    if (e.type === 'frame') this.latest.frame = e;
    if (e.type === 'location') this.latest.location = e;
    for (const w of this.watchers) w(e);
  }

  /** The address told last (`emit()`). */
  get location(): Extract<HandoverScreenEvent, { type: 'location' }> | undefined {
    const at = this.latest.location;
    return at?.type === 'location' ? at : undefined;
  }

  /** A watcher of the screencast: given the latest frame and address at once, then each event; returns its end. */
  watch(fn: (e: HandoverScreenEvent) => void): () => void {
    this.watchers.add(fn);
    if (this.latest.location) fn(this.latest.location);
    if (this.latest.frame) fn(this.latest.frame);
    return () => this.watchers.delete(fn);
  }

  /** It is over: its watchers are told, and nothing wakes it any more. */
  end(): void {
    if (this.status === 'over') return;
    this.status = 'over';
    this.screen = undefined;
    this.waiter = undefined;
    this.queued = undefined;
    for (const w of [...this.watchers]) w({ type: 'ended' });
    this.watchers.clear();
  }
}

/** Why the user's answer, watcher or input was not taken: no such hand-over, not now, or a mode it does not offer. */
export type HandoverRefusal = 'missing' | 'state' | 'mode';

/** The hand-overs going on, by id: what the routes reach (`/api/conversations/:id/handovers/…`). */
export class Handovers {
  private readonly items = new Map<string, HandoverTicket>();

  create(convId: string, modes: readonly HandoverMode[]): HandoverTicket {
    const ticket = new HandoverTicket(randomUUID(), convId, modes);
    this.items.set(ticket.id, ticket);
    return ticket;
  }

  /** The ticket `id` of conversation `convId`, while it goes on. */
  get(convId: string, id: string): HandoverTicket | undefined {
    const t = this.items.get(id);
    return t && t.convId === convId && t.status !== 'over' ? t : undefined;
  }

  /** It is over: gone from here, its watchers told. */
  remove(ticket: HandoverTicket): void {
    ticket.end();
    if (this.items.get(ticket.id) === ticket) this.items.delete(ticket.id);
  }

  /** Every hand-over of a conversation ends (it is being deleted). */
  endAll(convId: string): void {
    for (const t of this.items.values()) if (t.convId === convId) t.wake({ action: 'turn' });
  }

  /**
   * The user's answer: start (in a mode it offers) or decline while it waits for them; hand it back or
   * cancel while they have it. Only the first answer of each step counts (two browsers open on the chat).
   */
  answer(convId: string, id: string, a: HandoverAnswer): HandoverRefusal | undefined {
    const t = this.get(convId, id);
    if (!t) return 'missing';
    if (t.status === 'pending' && a.action === 'start') {
      if (!t.modes.includes(a.mode)) return 'mode';
      t.status = 'starting';
      t.mode = a.mode;
    } else if (t.status === 'pending' && a.action === 'cancel') t.status = 'ending';
    else if (t.status === 'active' && (a.action === 'done' || a.action === 'cancel')) t.status = 'ending';
    else return 'state';
    t.wake(a);
    return undefined;
  }

  /**
   * A watcher of a screencast going on (`HandoverTicket.watch()`), or of a window, which is told only
   * that it ended (a browser for the user alone's card, whose window the user may close).
   */
  watch(convId: string, id: string, fn: (e: HandoverScreenEvent) => void): (() => void) | HandoverRefusal {
    const t = this.get(convId, id);
    if (!t) return 'missing';
    if (!t.mode || (t.status !== 'active' && t.status !== 'starting')) return 'state';
    return t.watch(fn);
  }

  /** The user's input in the screencast panel, given to the browser in order. */
  async input(convId: string, id: string, events: HandoverInput[]): Promise<HandoverRefusal | undefined> {
    const t = this.get(convId, id);
    if (!t) return 'missing';
    if (t.status !== 'active' || !t.screen) return 'state';
    await t.screen.input(events);
    return undefined;
  }
}

const MODIFIERS = 15;
const BUTTONS = ['left', 'middle', 'right', 'none'] as const;
const COMMANDS = ['selectAll', 'undo', 'redo'] as const;
const fraction = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const whole = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const short = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * The screencast panel's input, checked: at most `HANDOVER_LIMITS.eventsMax` events, each of a kind it
 * knows with values in range (positions as fractions of the frame, a key's name and code short, text at
 * most `HANDOVER_LIMITS.textMax` characters, an address http or https); or why not, in a line.
 */
export function checkInputs(raw: unknown): HandoverInput[] | string {
  if (!Array.isArray(raw) || !raw.length) return 'events must be a list of the input events';
  if (raw.length > HANDOVER_LIMITS.eventsMax) return `at most ${HANDOVER_LIMITS.eventsMax} events at once`;
  const out: HandoverInput[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object') return 'an event must be an object';
    const mods = e.modifiers === undefined || whole(e.modifiers, 0, MODIFIERS);
    switch (e.type) {
      case 'mouse':
        if (!['down', 'up', 'move'].includes(e.action as string) || !fraction(e.x) || !fraction(e.y) || !mods)
          return 'a mouse event is not valid';
        if (e.button !== undefined && !BUTTONS.includes(e.button as never)) return 'a mouse button is not valid';
        if (e.clicks !== undefined && !whole(e.clicks, 1, 3)) return 'a click count is from 1 to 3';
        out.push({
          type: 'mouse',
          action: e.action as 'down' | 'up' | 'move',
          x: e.x as number,
          y: e.y as number,
          ...(e.button ? { button: e.button as (typeof BUTTONS)[number] } : {}),
          ...(e.clicks ? { clicks: e.clicks as number } : {}),
          ...(e.modifiers ? { modifiers: e.modifiers as number } : {}),
        });
        break;
      case 'wheel': {
        const delta = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= HANDOVER_LIMITS.wheelMax;
        if (!fraction(e.x) || !fraction(e.y) || !delta(e.dx) || !delta(e.dy) || !mods) return 'a wheel event is not valid';
        out.push({
          type: 'wheel',
          x: e.x as number,
          y: e.y as number,
          dx: e.dx as number,
          dy: e.dy as number,
          ...(e.modifiers ? { modifiers: e.modifiers as number } : {}),
        });
        break;
      }
      case 'key':
        if (!short(e.key, 32) || (e.code !== undefined && !short(e.code, 32)) || !mods) return 'a key event is not valid';
        if (e.keyCode !== undefined && !whole(e.keyCode, 0, 255)) return 'a key code is from 0 to 255';
        if (e.text !== undefined && !short(e.text, 4)) return "a key's text is at most 4 characters";
        if (e.command !== undefined && !COMMANDS.includes(e.command as never)) return 'an editing command is not valid';
        out.push({
          type: 'key',
          key: e.key as string,
          ...(e.code ? { code: e.code as string } : {}),
          ...(e.keyCode !== undefined ? { keyCode: e.keyCode as number } : {}),
          ...(e.text ? { text: e.text as string } : {}),
          ...(e.modifiers ? { modifiers: e.modifiers as number } : {}),
          ...(e.command ? { command: e.command as (typeof COMMANDS)[number] } : {}),
        });
        break;
      case 'text':
        if (!short(e.text, HANDOVER_LIMITS.textMax)) return `text is from 1 to ${HANDOVER_LIMITS.textMax} characters`;
        out.push({ type: 'text', text: e.text as string });
        break;
      case 'navigate': {
        if (!short(e.url, 2000)) return 'an address is not valid';
        let url: URL;
        try {
          url = new URL(e.url as string);
        } catch {
          return 'an address is not valid';
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http and https pages open';
        out.push({ type: 'navigate', url: url.href, ...(e.typed === true ? { typed: true } : {}) });
        break;
      }
      case 'history':
        if (!['back', 'forward', 'reload'].includes(e.to as string)) return 'history goes back, forward or reloads';
        out.push({ type: 'history', to: e.to as 'back' | 'forward' | 'reload' });
        break;
      case 'viewport':
        if (!whole(e.width, 200, 4000) || !whole(e.height, 200, 4000)) return 'a viewport is from 200 to 4000 pixels each way';
        if (e.scale !== undefined && !(typeof e.scale === 'number' && e.scale >= 0.5 && e.scale <= 4)) return 'a scale is from 0.5 to 4';
        out.push({
          type: 'viewport',
          width: e.width as number,
          height: e.height as number,
          ...(e.scale !== undefined ? { scale: e.scale as number } : {}),
        });
        break;
      default:
        return 'an event of an unknown kind';
    }
  }
  return out;
}

/** The Windows virtual key codes of the keys an input method's name does not give (Chromium's input wants them). */
const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Meta: 91,
};

/** A key's Windows virtual key code: the one given, else the key's own (a letter's capital, a digit's). */
export function keyCodeOf(key: string, given?: number): number {
  if (given) return given;
  if (KEY_CODES[key] !== undefined) return KEY_CODES[key]!;
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  return 0;
}

/** A CDP command, on the page's session. */
export interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}

const BUTTON_BIT = { left: 1, right: 2, middle: 4, none: 0 } as const;

/**
 * What an input event of the user's becomes in Chromium's input (`Input.*`), on a frame `frame` big (the
 * page's own pixels): a position from fractions of it; a key with text typed as a key of the keyboard
 * would (`keyDown` with its text; Enter's a carriage return, as a form's submit wants), one without as a
 * raw key, each then let go; text inserted as an input method does. Navigation and the viewport are the
 * browser's own business, not input: none here.
 */
export function inputCalls(e: HandoverInput, frame: { width: number; height: number }): CdpCall[] {
  const at = (x: number, y: number) => ({
    x: Math.round(Math.min(1, Math.max(0, x)) * frame.width * 100) / 100,
    y: Math.round(Math.min(1, Math.max(0, y)) * frame.height * 100) / 100,
  });
  switch (e.type) {
    case 'mouse': {
      const button = e.button ?? (e.action === 'move' ? 'none' : 'left');
      const type = e.action === 'down' ? 'mousePressed' : e.action === 'up' ? 'mouseReleased' : 'mouseMoved';
      return [
        {
          method: 'Input.dispatchMouseEvent',
          params: {
            type,
            ...at(e.x, e.y),
            button,
            buttons: e.action === 'up' ? 0 : BUTTON_BIT[button],
            ...(e.action === 'move' ? {} : { clickCount: e.clicks ?? 1 }),
            modifiers: e.modifiers ?? 0,
          },
        },
      ];
    }
    case 'wheel':
      return [
        {
          method: 'Input.dispatchMouseEvent',
          params: { type: 'mouseWheel', ...at(e.x, e.y), deltaX: e.dx, deltaY: e.dy, modifiers: e.modifiers ?? 0 },
        },
      ];
    case 'key': {
      const code = keyCodeOf(e.key, e.keyCode);
      // What the key types, as the panel said (a character, with Option or AltGr too; never a shortcut's).
      const typed = e.key === 'Enter' ? '\r' : e.text;
      const base = {
        key: e.key,
        ...(e.code ? { code: e.code } : {}),
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
        modifiers: e.modifiers ?? 0,
      };
      return [
        {
          method: 'Input.dispatchKeyEvent',
          params: {
            type: typed ? 'keyDown' : 'rawKeyDown',
            ...base,
            ...(typed ? { text: typed, unmodifiedText: typed } : {}),
            ...(e.command ? { commands: [e.command] } : {}),
          },
        },
        { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } },
      ];
    }
    case 'text':
      return [{ method: 'Input.insertText', params: { text: e.text } }];
    default:
      return [];
  }
}

/*
 * A browser for the user alone (B2 of docs/proposals/user-handoffs.md), for a page that shows a secret (a
 * token generator): a Chromium of its own, with a throwaway profile, shown through the same screencast
 * panel and routes as a hand-over, which no agent drives or reads; the user selects the value on the page
 * and saves it to a secrets card (`selectionOf()`), the value never leaving the server but for the
 * screencast's picture.
 */

/** The most browsers for the user alone at once, on this server: each is a Chromium of its own. */
export const USER_BROWSERS_MAX = 3;

/**
 * A page of a browser for the user alone (`ownerVerdict()`): its host and port (`key`, as `approvalKeys()`
 * keys a fetch), whether it led to this computer or the local network when the user opened it (`nearby`),
 * and the addresses its name had then (none for an address, or a name on this computer).
 */
export interface OwnerPage {
  key: string;
  nearby: boolean;
  addresses: readonly string[];
}

/**
 * Whether a request of a browser for the user alone goes (`key`: its host and port; `nearby`: it leads to
 * this computer or the local network, by the addresses its name has now). Nobody is asked: the user
 * navigates it themselves, and what it opens is never the agents' (its profile goes when it closes). One
 * to the internet goes. One here goes only:
 * - to the host of the page open in its tab (`top`: that page's own images, scripts, forms, sockets and
 *   links), when that page was itself opened here as the user's (`nearby`) and its name leads to none but
 *   the addresses it had then;
 * - or, to open a page in its tab, to the address the user typed in its address bar (or the card's own,
 *   which they confirmed, or a page of theirs Back or Forward goes to) for that one opening (`typed`, until
 *   the tab shows a page again), on the same terms.
 *
 * Never to a host a page elsewhere leads to or reaches by itself (a link, a redirect, a script's request,
 * a form a public page posts to a device on the network), however often the user opened it before
 * (`unasked`); nor, under the name of a page opened while it led to the internet, or elsewhere, here now
 * (`moved`: DNS rebinding, a public page whose name comes to lead to the user's router). Harness Relay's
 * own ports, link-local and metadata addresses never open, as in every browser of Harness Relay's
 * (`navigationVerdict()`).
 */
export function ownerVerdict(o: {
  nearby: boolean;
  key?: string;
  addresses?: readonly string[];
  top?: OwnerPage;
  typed?: OwnerPage;
}): 'allow' | 'moved' | 'unasked' {
  if (!o.nearby) return 'allow';
  const same = [o.typed, o.top].filter((p): p is OwnerPage => Boolean(o.key) && p?.key === o.key);
  if (!same.length) return 'unasked';
  const now = o.addresses ?? [];
  return same.some((p) => p.nearby && now.every((a) => p.addresses.includes(a))) ? 'allow' : 'moved';
}

/**
 * Why a browser for the user alone could not open, or is gone: no browser to start, too many open, an
 * address no browser of Harness Relay's opens (its own ports, a metadata address), a window asked for
 * where this computer shows none, or it closed.
 */
export class UserBrowserError extends Error {
  constructor(
    /** `nearby`: the address leads to this computer or the local network, and the user has not confirmed it. */
    readonly why: 'unavailable' | 'busy' | 'refused' | 'nearby' | 'window' | 'gone',
    message: string,
  ) {
    super(message);
  }
}

/** What the orchestrator reaches of the browsers for the user alone (`BrowserService`). */
export interface UserBrowsers {
  /**
   * Opens one for conversation `convId`, at `url` if given (one that leads to this computer or the local
   * network only once the user confirmed it, `nearbyConfirmed`: else `UserBrowserError('nearby')`), in a
   * window on this computer with `window` (where `userWindowAt()` names one), else as a screencast;
   * `onEnd` once it closed. Returns its id.
   */
  openForUser(convId: string, o?: { url?: string; nearbyConfirmed?: boolean; window?: boolean; onEnd?: () => void }): Promise<string>;
  /** Takes one that is open to `url`, as `openForUser()` would open it there. */
  navigateForUser(convId: string, id: string, url: string, o?: { nearbyConfirmed?: boolean }): Promise<void>;
  /** Whether it is open still. */
  userBrowserOpen(convId: string, id: string): boolean;
  /** How it shows (in a window, or as a screencast); undefined once it is gone. */
  userBrowserMode(convId: string, id: string): HandoverMode | undefined;
  /** Where one can open in a window, or undefined where this computer shows none. */
  userWindowAt(): HandoverWindowAt | undefined;
  /** The text the user selected on its page (in a field too), or a focused field's whole value; '' for none. */
  selectionOf(convId: string, id: string): Promise<string>;
  /** Closes it, and its profile goes. */
  closeForUser(convId: string, id: string): Promise<void>;
}

/**
 * Runs in a world of its own beside the page's (`Page.createIsolatedWorld`): the text the user selected,
 * in a field (an input or a text area, also in a shadow root: its own selection) or on the page; with
 * nothing selected, the whole value of the field that has the focus (a token shown in a read-only field,
 * which a tap on a phone focuses), but never a password field's: only a selection made in one. Read in
 * the server and kept there (`selectionOf()`), never sent to the page that shows the panel.
 */
export const SELECTION_SCRIPT = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  const field = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el : null;
  if (field) {
    try {
      const a = field.selectionStart;
      const b = field.selectionEnd;
      if (typeof a === 'number' && typeof b === 'number' && b > a) return String(field.value).slice(a, b);
    } catch (e) {}
  }
  const selected = String(getSelection() || '');
  if (selected.trim()) return selected;
  if (field && field.type !== 'hidden' && field.type !== 'password' && String(field.value).trim()) return String(field.value);
  return '';
})()`;

/** What the agent is told when nobody can be asked to take over the browser. */
export const HANDOVER_UNASKED =
  'browser_hand_over cannot be used now: nobody can be asked (a run a schedule started, or a conversation that refuses requests). Tell the user in your reply what they need to do in the browser instead.';

/** The user's note, as the agent is told it: on one line, in quotes. */
const said = (note?: string) => (note?.trim() ? `, saying: "${dataLine(note.trim()).replace(/"/g, "'")}"` : '');

/**
 * What the agent is told of a hand-over that ended: how (handed back, declined, cancelled, the time ran
 * out, the browser could not be shown), the user's note, and where the page is now. Never what the page
 * shows nor what the user typed: it reads the page itself afterwards (`browser_snapshot`).
 */
export function handoverOutcome(o: {
  end: HandoverWake;
  /** It had started (the time ran out while the user had it, not before). */
  started: boolean;
  /** Where the page is now: as the user left it, open again without a window, or not open (the window closed with it). */
  page: 'kept' | 'reopened' | 'closed';
  /** The minutes the user had to start it, then to hand it back. */
  minutes?: { start: number; use: number };
}): { text: string; isError?: boolean } {
  const minutes = o.minutes ?? { start: HANDOVER_LIMITS.startMinutes, use: HANDOVER_LIMITS.useMinutes };
  const page =
    o.page === 'kept'
      ? 'The page is open as they left it.'
      : o.page === 'reopened'
        ? 'The browser opened again without a window, at the page the user ended on.'
        : 'The browser closed with its window: open the page again with browser_open.';
  const kept = "What they signed in to stays in this conversation's browser: read the page with browser_snapshot before going on.";
  const { end } = o;
  switch (end.action) {
    case 'done':
    case 'closed':
      return { text: `The user took over the browser and handed it back${end.action === 'done' ? said(end.note) : ''}. ${page} ${kept}` };
    case 'cancel':
      return o.started
        ? { text: `The user stopped the hand-over before finishing${said(end.note)}. ${page}`, isError: true }
        : { text: `The user declined to take over the browser${said(end.note)}.`, isError: true };
    case 'timeout':
      return o.started
        ? {
            text: `The hand-over ended after ${minutes.use} minutes, before the user said they were done. ${page}`,
            isError: true,
          }
        : { text: `The user did not take over the browser within ${minutes.start} minutes.`, isError: true };
    case 'gone':
      return { text: "The agent's CLI stopped waiting for this call, so the hand-over ended.", isError: true };
    case 'failed':
      return {
        text: `The browser could not be shown to the user: ${end.error}.${o.page === 'closed' ? ' Open the page again with browser_open.' : ''}`,
        isError: true,
      };
    default:
      return { text: 'The turn ended.', isError: true };
  }
}
