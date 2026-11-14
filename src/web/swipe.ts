// The sidebar's swipe where it is a drawer (phones and small tablets, `max-width: 820px` in styles.css):
// a swipe right anywhere on the page opens it, and a swipe left closes it. Anywhere, not only from the
// screen's edge, which phones keep for going back. A move mostly up or down is a scroll, a move after a
// long press is selecting text, and a box that scrolls sideways the way the finger goes (a code block,
// a wide table) takes the move itself. No DOM: `useSidebarSwipe()` gives it the touches; tested in Node.

/** The screens where the sidebar is a drawer, as in styles.css. */
export const DRAWER_MEDIA = '(max-width: 820px)';

/** How far the finger moves before its direction is told, in pixels. */
export const SWIPE_SLOP = 10;

/** How far sideways a swipe goes before the sidebar opens or closes, in pixels. */
export const SWIPE_DISTANCE = 50;

/** A swipe goes at least this many times as far sideways as up or down when its direction is told. */
export const SWIPE_SLANT = 1.5;

/** A finger that rests longer than this before it moves is a long press's (selecting text), in ms. */
export const SWIPE_HOLD_MS = 400;

/** What a swipe does: open a closed sidebar, or close an open one. */
export type SwipeWay = 'open' | 'close';

/** What a move of the finger does: nothing yet, nothing at all (not a swipe), or the swipe's work. */
export type SwipeStep = 'wait' | 'drop' | SwipeWay;

/** A box under the finger, with how it scrolls sideways. */
export interface SideScroll {
  /** Its computed `overflow-x`. */
  overflowX: string;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Whether one of the boxes under the finger scrolls the way a swipe goes, and so takes the move itself:
 * a swipe right scrolls a box back while it is scrolled at all, a swipe left scrolls it on while there is
 * more of it on the right. A box at its own end leaves the swipe to the sidebar.
 */
export function scrollTakesSwipe(boxes: readonly SideScroll[], way: SwipeWay): boolean {
  return boxes.some((b) => {
    if (b.overflowX !== 'auto' && b.overflowX !== 'scroll') return false;
    if (b.scrollWidth <= b.clientWidth + 1) return false;
    return way === 'open' ? b.scrollLeft >= 1 : b.scrollLeft + b.clientWidth < b.scrollWidth - 1;
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
  /** The touch is in a text box or another form field, where moving the finger moves the caret or a slider. */
  field: boolean;
  /** Text is selected: the finger may be dragging the selection's handles. */
  selecting: boolean;
  /** The boxes under the finger that scroll sideways. */
  boxes: readonly SideScroll[];
}

/** What a touch that starts so may do, if it turns out a swipe: undefined when it may do nothing. */
export function swipeWay(s: SwipeStart): SwipeWay | undefined {
  if (!s.drawer || s.touches !== 1 || s.dialog || s.field || s.selecting) return undefined;
  const way: SwipeWay = s.open ? 'close' : 'open';
  return scrollTakesSwipe(s.boxes, way) ? undefined : way;
}

/** One finger's swipe, from where it touched: told each move, it says when the sidebar opens or closes. */
export class SidebarSwipe {
  private sideways = false;

  constructor(
    readonly way: SwipeWay,
    private readonly x: number,
    private readonly y: number,
    private readonly at: number,
  ) {}

  /** The finger moved to (x, y) at `at` (ms, on the clock the start was on). After 'drop' or a way, it is done. */
  move(x: number, y: number, at: number): SwipeStep {
    const dx = x - this.x;
    const dy = y - this.y;
    const forward = this.way === 'open' ? dx : -dx;
    if (!this.sideways) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP) return 'wait';
      // A long press first, a move up or down, or the other way: not this swipe.
      if (at - this.at > SWIPE_HOLD_MS || forward <= Math.abs(dy) * SWIPE_SLANT) return 'drop';
      this.sideways = true;
    }
    return forward >= SWIPE_DISTANCE ? this.way : 'wait';
  }
}
