// The chat's computer (a Cua desktop) in the page, without React: what a key becomes, what a pointer's
// press and release are (a click, a double click, a drag), what the wheel scrolls, and what its stream
// says. The panel is `components/ComputerPanel.tsx`.
import { COMPUTER_LIMITS, type ComputerInput, type ComputerScreenEvent } from '../shared/types';

/** A key as the browser's keyboard event gives it. */
export interface ComputerKeyLike {
  key: string;
  keyCode?: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

/** Keys that type nothing, by the browser's name, as Cua names them. */
const NAMED: Record<string, string> = {
  Enter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'page_up',
  PageDown: 'page_down',
  ' ': 'space',
};

/**
 * What a key pressed on the panel becomes: a key of Cua's (`enter`, `ctrl+c`, `alt+tab`), with the modifiers
 * held; `text` for a character typed without Ctrl, Alt or ⌘ (it goes as text, which keeps its case and any
 * language); undefined for what is left to the page (an input method composing, a modifier alone, an unknown
 * key). ⌘ is the computer's Super key, but ⌘ with C, V, X, A, Z on a Mac is Ctrl there (Linux's shortcuts).
 */
export function computerKey(e: ComputerKeyLike, mac: boolean): { keys: string } | { text: string } | undefined {
  if (e.isComposing || e.keyCode === 229 || e.key === 'Unidentified' || e.key === 'Process' || e.key === 'Dead') return undefined;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS'].includes(e.key)) return undefined;
  const f = /^F([1-9]|1[0-2])$/.exec(e.key);
  const named = NAMED[e.key] ?? (f ? 'f' + f[1] : undefined);
  const single = [...e.key].length === 1 ? e.key : undefined;
  const ctrl = e.ctrlKey || (mac && e.metaKey && !!single && /^[cvxazy]$/i.test(single));
  const superKey = e.metaKey && !ctrl;
  if (!named && !single) return undefined;
  if (!named && single && !ctrl && !e.altKey && !superKey) return { text: single };
  const base = named ?? single!.toLowerCase();
  if (!/^(?:[a-z0-9_]{1,16}|[-=[\];'`,./\\])$/.test(base)) return single && !ctrl && !e.altKey ? { text: single } : undefined;
  const mods = [ctrl && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', superKey && 'super'].filter(Boolean) as string[];
  return { keys: [...mods, base].join('+') };
}

/** A press of a pointer on the screen, where and when (fractions of the frame, milliseconds). */
export interface Press {
  x: number;
  y: number;
  at: number;
  button: 'left' | 'middle' | 'right';
}

/** The farthest a press may move, as a fraction of the frame's larger side, and still be a click. */
const STILL = 0.006;

/** What a press and its release are: a drag when the pointer moved (left button), else a click. */
export function pressInput(start: Press, end: { x: number; y: number }): ComputerInput {
  const moved = Math.hypot(end.x - start.x, end.y - start.y) > STILL;
  if (moved && start.button === 'left') return { type: 'drag', x: start.x, y: start.y, toX: end.x, toY: end.y };
  return { type: 'click', x: start.x, y: start.y, ...(start.button !== 'left' ? { button: start.button } : {}) };
}

/** How long a click waits for a second one, which makes them a double click. */
export const DOUBLE_MS = 300;

/** Whether click `b` makes a double click of click `a`: the left button, soon after, at about the same point. */
export function isDouble(a: ComputerInput & { at?: number }, b: ComputerInput & { at?: number }): boolean {
  if (a.type !== 'click' || b.type !== 'click' || a.button || b.button || a.double || b.double) return false;
  if (a.at === undefined || b.at === undefined || b.at - a.at > DOUBLE_MS) return false;
  return Math.hypot(b.x - a.x, b.y - a.y) <= STILL * 2;
}

/** Pixels of the wheel a line of scrolling stands for. */
const LINE = 40;

/**
 * The wheel turned by `dx`, `dy` (pixels; lines when `lines`) at a point: what it scrolls, or undefined while
 * it is less than a line (`carry` keeps the rest for the next turn).
 */
export function wheelInput(
  dx: number,
  dy: number,
  at: { x: number; y: number },
  carry: { x: number; y: number },
  lines = false,
): ComputerInput | undefined {
  carry.x += lines ? dx * LINE : dx;
  carry.y += lines ? dy * LINE : dy;
  const vertical = Math.abs(carry.y) >= Math.abs(carry.x);
  const amount = Math.trunc(Math.abs(vertical ? carry.y : carry.x) / LINE);
  if (!amount) return undefined;
  const direction = vertical ? (carry.y > 0 ? 'down' : 'up') : carry.x > 0 ? 'right' : 'left';
  carry.x = 0;
  carry.y = 0;
  return { type: 'scroll', x: at.x, y: at.y, direction, amount: Math.min(amount, COMPUTER_LIMITS.scrollMax) };
}

/**
 * The input waiting to go, merged before it is sent: text typed one key after another is one text, scrolls
 * the same way one after another add up (to `COMPUTER_LIMITS.scrollMax`); then at most
 * `COMPUTER_LIMITS.eventsMax` events at once, the rest after.
 */
export function mergeComputerInputs(list: readonly ComputerInput[]): { batch: ComputerInput[]; rest: ComputerInput[] } {
  const out: ComputerInput[] = [];
  for (const e of list) {
    const last = out.at(-1);
    if (e.type === 'text' && last?.type === 'text' && last.text.length + e.text.length <= COMPUTER_LIMITS.textMax) {
      out[out.length - 1] = { type: 'text', text: last.text + e.text };
      continue;
    }
    if (
      e.type === 'scroll' &&
      last?.type === 'scroll' &&
      last.direction === e.direction &&
      last.amount + e.amount <= COMPUTER_LIMITS.scrollMax
    ) {
      out[out.length - 1] = { ...last, amount: last.amount + e.amount };
      continue;
    }
    out.push(e);
  }
  return { batch: out.slice(0, COMPUTER_LIMITS.eventsMax), rest: out.slice(COMPUTER_LIMITS.eventsMax) };
}

/** One message of the panel's stream, when it is one it knows. */
export function computerEvent(data: string): ComputerScreenEvent | undefined {
  try {
    const e = JSON.parse(data) as ComputerScreenEvent;
    if (e?.type === 'frame' && typeof e.data === 'string' && typeof e.width === 'number' && typeof e.height === 'number') return e;
    if (e?.type === 'state' && e.view && typeof e.view.status === 'string') return e;
  } catch {
    // not JSON
  }
  return undefined;
}

/** Whether Cua's own viewer can open for this page: it is on the computer Harness Relay runs on (its link is a local port). */
export function viewerReachable(where: { desktop: boolean; hostname: string }): boolean {
  return where.desktop || /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i.test(where.hostname);
}

/** The event that opens the chat's computer panel (from a hand-over's card): its conversation's id. */
export const OPEN_COMPUTER = 'relay:open-computer';
