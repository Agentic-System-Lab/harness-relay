// The sidebar's swipe where it is a drawer (phones and small tablets, `max-width: 820px` in styles.css):
// a swipe right anywhere on the page opens it, and a swipe left closes it; a quick flick does too.
// Anywhere, not only from the screen's edge, which phones keep for going back. A move mostly up or down
// is a scroll, a move after a long press is selecting text, and a box that scrolls sideways the way the
// finger goes (a code block, a wide table) takes the move itself. No DOM: `useSidebarDrawer()` gives it
// the touches; tested in Node.

/** The screens where the sidebar is a drawer, as in styles.css. */
export const DRAWER_MEDIA = '(max-width: 820px)';

/** How far the finger moves before its direction is told, in pixels. */
export const SWIPE_SLOP = 10;

/** How far sideways a swipe goes before the sidebar opens or closes, in pixels. */
export const SWIPE_DISTANCE = 50;

/** A swipe goes more than this many times as far sideways as up or down when its direction is told. */
export const SWIPE_SLANT = 1.5;

/** A finger that rests longer than this before it moves is a long press's (selecting text), in ms. */
export const SWIPE_HOLD_MS = 400;

/** A flick: a finger that lifts going at least this fast sideways (px/ms, 400px a second)… */
export const FLICK_SPEED = 0.4;

/** …over its last moves, this long (ms)… */
export const FLICK_MS = 100;

/** …once it has gone this far that way (px), opens or closes the sidebar short of a swipe's distance… */
export const FLICK_DISTANCE = 20;

/** …unless it went back more than this (px) from the farthest it went over those moves: more than a lifting finger's wobble. */
export const FLICK_WOBBLE = 3;

/** What a swipe does: open a closed sidebar, or close an open one. */
export type SwipeWay = 'open' | 'close';

/** What a move of the finger does: nothing yet, nothing at all (not a swipe), or the swipe's work. */
export type SwipeStep = 'wait' | 'drop' | SwipeWay;

/** A box under the finger, with how it scrolls sideways. */
export interface SideScroll {
  /** Its computed `overflow-x`. */
  overflowX: string;
  /** Its computed `direction`: in a right-to-left box `scrollLeft` is 0 at its right end, and negative leftwards. */
  direction: string;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Whether one of the boxes under the finger scrolls the way a swipe goes, and so takes the move itself:
 * a swipe right shows more of a box's left side while it is not at its left end, a swipe left more of
 * its right side while it is not at its right end. A box at that end leaves the swipe to the sidebar.
 */
export function scrollTakesSwipe(boxes: readonly SideScroll[], way: SwipeWay): boolean {
  return boxes.some((b) => {
    if (b.overflowX !== 'auto' && b.overflowX !== 'scroll') return false;
    const room = b.scrollWidth - b.clientWidth;
    if (room <= 1) return false;
    const fromLeft = b.direction === 'rtl' ? room + b.scrollLeft : b.scrollLeft;
    return way === 'open' ? fromLeft >= 1 : fromLeft < room - 1;
  });
}

/** Where a touch starts, and what the page is doing then. */
export interface SwipeStart {
  /** The sidebar is a drawer on this screen (`DRAWER_MEDIA`). */
  drawer: boolean;
  /** The drawer is open. */
  open: boolean;
  /** How many fingers are on the screen. */
  touches: number;
  /** The touch is in a dialog, or a dialog is open (the dialog has the page). */
  dialog: boolean;
  /** The touch is on a control the finger moves itself: a text box's caret, a slider, a video's seek bar. */
  control: boolean;
  /** Text is selected on the page: the finger may be dragging the selection's handles. */
  selecting: boolean;
}

/** What a touch that starts so may do, if it turns out a swipe: undefined when it may do nothing. */
export function swipeWay(s: SwipeStart): SwipeWay | undefined {
  if (!s.drawer || s.touches !== 1 || s.dialog || s.control || s.selecting) return undefined;
  return s.open ? 'close' : 'open';
}

/**
 * One finger's swipe, from where it touched: told each move, and where it lifted, it says when the
 * sidebar opens or closes. `takes` says whether a box under the finger takes the move (see
 * `scrollTakesSwipe()`); it is asked once, when the move turns out sideways, so a tap or a scroll
 * measures nothing. After 'drop' or a way, the swipe is done.
 */
export class SidebarSwipe {
  private sideways = false;
  /** Where the finger was over the last `FLICK_MS`, oldest first (at least its latest place). */
  private trail: { x: number; at: number }[];

  constructor(
    readonly way: SwipeWay,
    private readonly x: number,
    private readonly y: number,
    private readonly at: number,
    private readonly takes: () => boolean = () => false,
  ) {
    this.trail = [{ x, at }];
  }

  /** How far `x` is from `from` the way the swipe goes. */
  private ahead(x: number, from: number): number {
    return this.way === 'open' ? x - from : from - x;
  }

  /** The finger moved to (x, y) at `at` (ms, on the clock the start was on). */
  move(x: number, y: number, at: number): SwipeStep {
    this.trail.push({ x, at });
    while (this.trail.length > 1 && this.trail[0]!.at < at - FLICK_MS) this.trail.shift();
    const forward = this.ahead(x, this.x);
    const dy = y - this.y;
    if (!this.sideways) {
      if (Math.max(Math.abs(x - this.x), Math.abs(dy)) < SWIPE_SLOP) return 'wait';
      // A long press first, a move up or down, or the other way: not this swipe.
      if (at - this.at > SWIPE_HOLD_MS || forward <= Math.abs(dy) * SWIPE_SLANT) return 'drop';
      if (this.takes()) return 'drop';
      this.sideways = true;
    }
    return forward >= SWIPE_DISTANCE ? this.way : 'wait';
  }

  /** The finger lifted at (x, y): short of a swipe's distance, a flick still does the swipe's work. */
  end(x: number, y: number, at: number): SwipeStep {
    const step = this.move(x, y, at);
    if (step !== 'wait') return step;
    if (!this.sideways || this.ahead(x, this.x) < FLICK_DISTANCE) return 'drop';
    // Turned back before it lifted, more than a wobble: no flick.
    const farthest = Math.max(...this.trail.map((p) => this.ahead(p.x, this.x)));
    if (farthest - this.ahead(x, this.x) > FLICK_WOBBLE) return 'drop';
    const from = this.trail[0]!;
    // Moves sent together have the same time: Infinity, a flick (and with no move, NaN, none).
    const speed = this.ahead(x, from.x) / (at - from.at);
    return speed >= FLICK_SPEED ? this.way : 'drop';
  }
}
