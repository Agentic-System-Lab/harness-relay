import { describe, expect, it } from 'vitest';
import {
  FLICK_DISTANCE,
  FLICK_MS,
  FLICK_WOBBLE,
  SWIPE_DISTANCE,
  SWIPE_HOLD_MS,
  SWIPE_SLOP,
  SidebarSwipe,
  scrollTakesSwipe,
  swipeWay,
  type SideScroll,
  type SwipeStart,
  type SwipeStep,
} from '../src/web/swipe';

const start = (extra: Partial<SwipeStart> = {}): SwipeStart => ({
  drawer: true,
  open: false,
  touches: 1,
  dialog: false,
  control: false,
  selecting: false,
  ...extra,
});

/** A box 300px wide with 600px inside (300px to scroll), at its left end unless told. */
const box = (extra: Partial<SideScroll> = {}): SideScroll => ({
  overflowX: 'auto',
  direction: 'ltr',
  scrollLeft: 0,
  scrollWidth: 600,
  clientWidth: 300,
  ...extra,
});

/** The steps of a swipe through `points` ([x, y, ms]). */
function steps(swipe: SidebarSwipe, points: [number, number, number][]): SwipeStep[] {
  return points.map(([x, y, at]) => swipe.move(x, y, at));
}

describe('what a touch may do', () => {
  it('opens a closed drawer and closes an open one', () => {
    expect(swipeWay(start())).toBe('open');
    expect(swipeWay(start({ open: true }))).toBe('close');
  });

  it('does nothing where the sidebar is no drawer, with two fingers, in a dialog, on a control or a selection', () => {
    expect(swipeWay(start({ drawer: false }))).toBeUndefined();
    expect(swipeWay(start({ touches: 2 }))).toBeUndefined();
    expect(swipeWay(start({ touches: 0 }))).toBeUndefined();
    expect(swipeWay(start({ dialog: true }))).toBeUndefined();
    expect(swipeWay(start({ control: true }))).toBeUndefined();
    expect(swipeWay(start({ selecting: true }))).toBeUndefined();
    expect(swipeWay(start({ open: true, dialog: true }))).toBeUndefined();
  });
});

describe('a box that scrolls sideways', () => {
  it('takes a swipe right while it is scrolled from its left end, a swipe left while it has more on the right', () => {
    expect(scrollTakesSwipe([box({ scrollLeft: 40 })], 'open')).toBe(true);
    expect(scrollTakesSwipe([box()], 'open')).toBe(false);
    expect(scrollTakesSwipe([box()], 'close')).toBe(true);
    expect(scrollTakesSwipe([box({ scrollLeft: 300 })], 'close')).toBe(false);
  });

  it('leaves out a pixel of rounding at either end', () => {
    expect(scrollTakesSwipe([box({ scrollLeft: 1 })], 'open')).toBe(true);
    expect(scrollTakesSwipe([box({ scrollLeft: 0.5 })], 'open')).toBe(false);
    expect(scrollTakesSwipe([box({ scrollLeft: 298 })], 'close')).toBe(true);
    expect(scrollTakesSwipe([box({ scrollLeft: 299 })], 'close')).toBe(false);
    // A pixel more inside than it shows is nothing to scroll.
    expect(scrollTakesSwipe([box({ scrollWidth: 301, scrollLeft: 1 })], 'open')).toBe(false);
    expect(scrollTakesSwipe([box({ scrollWidth: 301 })], 'close')).toBe(false);
  });

  it('counts from its right end in a right-to-left box', () => {
    // At its start, its right end (scrollLeft 0): more to show on the left.
    expect(scrollTakesSwipe([box({ direction: 'rtl' })], 'open')).toBe(true);
    expect(scrollTakesSwipe([box({ direction: 'rtl' })], 'close')).toBe(false);
    // At its left end (scrollLeft -300).
    expect(scrollTakesSwipe([box({ direction: 'rtl', scrollLeft: -300 })], 'open')).toBe(false);
    expect(scrollTakesSwipe([box({ direction: 'rtl', scrollLeft: -300 })], 'close')).toBe(true);
    expect(scrollTakesSwipe([box({ direction: 'rtl', scrollLeft: -299.5 })], 'open')).toBe(false);
  });

  it('takes none when it does not scroll', () => {
    for (const overflowX of ['visible', 'hidden', 'clip']) {
      expect(scrollTakesSwipe([box({ overflowX, scrollLeft: 40 })], 'open')).toBe(false);
      expect(scrollTakesSwipe([box({ overflowX })], 'close')).toBe(false);
    }
    expect(scrollTakesSwipe([box({ overflowX: 'scroll', scrollLeft: 40 })], 'open')).toBe(true);
    expect(scrollTakesSwipe([], 'open')).toBe(false);
  });

  it('takes it when any box under the finger can scroll that way', () => {
    expect(scrollTakesSwipe([box(), box({ scrollLeft: 40 })], 'open')).toBe(true);
    expect(scrollTakesSwipe([box(), box({ overflowX: 'hidden', scrollLeft: 40 })], 'open')).toBe(false);
  });
});

describe('a swipe', () => {
  it('opens the drawer once the finger has gone far enough right', () => {
    const swipe = new SidebarSwipe('open', 100, 300, 0);
    expect(steps(swipe, [[105, 301, 10], [100 + SWIPE_SLOP, 302, 20], [140, 305, 40], [100 + SWIPE_DISTANCE, 310, 60]])).toEqual(['wait', 'wait', 'wait', 'open']);
  });

  it('closes the drawer once the finger has gone far enough left', () => {
    const swipe = new SidebarSwipe('close', 300, 300, 0);
    expect(steps(swipe, [[285, 298, 15], [300 - SWIPE_DISTANCE + 1, 296, 40], [300 - SWIPE_DISTANCE, 296, 50]])).toEqual(['wait', 'wait', 'close']);
  });

  it('tells its direction once the finger has gone SWIPE_SLOP pixels, not before', () => {
    // Under the slop, even a move straight down waits.
    expect(new SidebarSwipe('open', 100, 300, 0).move(100, 300 + SWIPE_SLOP - 1, 20)).toBe('wait');
    expect(new SidebarSwipe('open', 100, 300, 0).move(100 + SWIPE_SLOP - 1, 300, 20)).toBe('wait');
    // At the slop the direction is told: too slanted here.
    expect(new SidebarSwipe('open', 100, 300, 0).move(100 + SWIPE_SLOP, 307, 20)).toBe('drop');
    expect(new SidebarSwipe('open', 100, 300, 0).move(100 + SWIPE_SLOP, 306, 20)).toBe('wait');
  });

  it('is not the other way', () => {
    expect(new SidebarSwipe('open', 100, 300, 0).move(80, 300, 20)).toBe('drop');
    expect(new SidebarSwipe('close', 300, 300, 0).move(320, 300, 20)).toBe('drop');
  });

  it('is no scroll up or down, nor a move that slants as much as 1.5 times its rise', () => {
    expect(new SidebarSwipe('open', 100, 300, 0).move(102, 280, 20)).toBe('drop');
    expect(new SidebarSwipe('open', 100, 300, 0).move(112, 290, 20)).toBe('drop');
    // Exactly 1.5 times as far sideways as down.
    expect(new SidebarSwipe('open', 100, 300, 0).move(115, 310, 20)).toBe('drop');
    // A little less slant is a swipe.
    expect(new SidebarSwipe('open', 100, 300, 0).move(112, 295, 20)).toBe('wait');
    // The same for closing.
    expect(new SidebarSwipe('close', 300, 300, 0).move(298, 280, 20)).toBe('drop');
    expect(new SidebarSwipe('close', 300, 300, 0).move(288, 290, 20)).toBe('drop');
    expect(new SidebarSwipe('close', 300, 300, 0).move(288, 295, 20)).toBe('wait');
  });

  it('is no move after a long press, which selects text', () => {
    expect(new SidebarSwipe('open', 100, 300, 0).move(100 + SWIPE_DISTANCE, 300, SWIPE_HOLD_MS + 1)).toBe('drop');
    // Resting a moment still swipes.
    expect(new SidebarSwipe('open', 100, 300, 0).move(100 + SWIPE_DISTANCE, 300, SWIPE_HOLD_MS)).toBe('open');
  });

  it('goes on sideways once its direction is told, whatever the finger does then', () => {
    const swipe = new SidebarSwipe('open', 100, 300, 0);
    expect(steps(swipe, [[115, 300, 20], [125, 330, 40], [105, 340, 2000], [160, 360, 2100]])).toEqual(['wait', 'wait', 'wait', 'open']);
  });

  it('waits while the finger turns back, and opens only once it is far enough from where it touched', () => {
    const swipe = new SidebarSwipe('open', 100, 300, 0);
    // Back past where it touched, then right again: the distance counts from the touch, not the turn.
    expect(steps(swipe, [[115, 300, 20], [40, 300, 60], [120, 300, 100], [100 + SWIPE_DISTANCE, 300, 140]])).toEqual(['wait', 'wait', 'wait', 'open']);
  });

  it('asks whether a box takes the move once, when the move turns out sideways', () => {
    let asked = 0;
    const takes = (answer: boolean) => () => {
      asked++;
      return answer;
    };
    // A tap, or a scroll, asks nothing.
    new SidebarSwipe('open', 100, 300, 0, takes(false)).move(103, 302, 20);
    new SidebarSwipe('open', 100, 300, 0, takes(false)).move(100, 260, 20);
    expect(asked).toBe(0);
    const swipe = new SidebarSwipe('open', 100, 300, 0, takes(false));
    expect(steps(swipe, [[115, 300, 20], [130, 300, 40], [100 + SWIPE_DISTANCE, 300, 60]])).toEqual(['wait', 'wait', 'open']);
    expect(asked).toBe(1);
    // A box that takes it: the swipe is the box's.
    expect(new SidebarSwipe('open', 100, 300, 0, takes(true)).move(115, 300, 20)).toBe('drop');
    expect(asked).toBe(2);
  });
});

describe('where the finger lifts', () => {
  it('opens or closes on a quick flick short of the distance', () => {
    const open = new SidebarSwipe('open', 100, 300, 0);
    expect(open.move(115, 300, 20)).toBe('wait');
    expect(open.end(100 + FLICK_DISTANCE + 10, 300, 40)).toBe('open');
    const close = new SidebarSwipe('close', 300, 300, 0);
    expect(close.move(285, 300, 20)).toBe('wait');
    expect(close.end(300 - FLICK_DISTANCE - 10, 300, 40)).toBe('close');
  });

  it('opens on moves sent together, at the same time', () => {
    const swipe = new SidebarSwipe('open', 100, 300, 5);
    expect(swipe.move(115, 300, 5)).toBe('wait');
    expect(swipe.end(100 + FLICK_DISTANCE, 300, 5)).toBe('open');
  });

  it('does nothing for a flick shorter than FLICK_DISTANCE, or a slow drag', () => {
    const short = new SidebarSwipe('open', 100, 300, 0);
    short.move(112, 300, 10);
    expect(short.end(100 + FLICK_DISTANCE - 1, 300, 20)).toBe('drop');
    // 30px over 300ms: 0.1px/ms.
    const slow = new SidebarSwipe('open', 100, 300, 0);
    expect(steps(slow, [[110, 300, 100], [120, 300, 200]])).toEqual(['wait', 'wait']);
    expect(slow.end(130, 300, 300)).toBe('drop');
  });

  it('counts only the last FLICK_MS: a slow drag that ends in a flick opens, one that stops before lifting does not', () => {
    const flicked = new SidebarSwipe('open', 100, 300, 0);
    expect(steps(flicked, [[112, 300, 100], [115, 300, 260], [120, 300, 300]])).toEqual(['wait', 'wait', 'wait']);
    // 33px over the last 70ms (from 115 at 260ms): 0.47px/ms, though 48px over 330ms in all.
    expect(flicked.end(148, 300, 330)).toBe('open');
    // The same drag lifted later: from 120 at 300ms, 27px over 70ms is 0.39px/ms, short of a flick.
    const later = new SidebarSwipe('open', 100, 300, 0);
    steps(later, [[112, 300, 100], [115, 300, 260], [120, 300, 300]]);
    expect(later.end(147, 300, 370)).toBe('drop');
    const stopped = new SidebarSwipe('open', 100, 300, 0);
    expect(steps(stopped, [[112, 300, 10], [140, 300, 30]])).toEqual(['wait', 'wait']);
    // Lifted where it stopped, FLICK_MS later.
    expect(stopped.end(140, 300, 30 + FLICK_MS + 1)).toBe('drop');
  });

  it('counts a point exactly FLICK_MS old, a speed of exactly FLICK_SPEED, and the distance from where it touched', () => {
    // From 101 at 100ms (exactly 100ms before the lift) 45px: 0.45px/ms; from 144 at 190ms only 0.2.
    const edge = new SidebarSwipe('open', 100, 300, 0);
    expect(steps(edge, [[101, 300, 100], [144, 300, 190]])).toEqual(['wait', 'wait']);
    expect(edge.end(146, 300, 200)).toBe('open');
    // 40px over the last 100ms: exactly 0.4px/ms.
    const exact = new SidebarSwipe('open', 100, 300, 0);
    expect(steps(exact, [[101, 300, 100], [130, 300, 190]])).toEqual(['wait', 'wait']);
    expect(exact.end(141, 300, 200)).toBe('open');
    // 15px slowly, then 10px quickly: 25px from the touch, though only 10px over the last 100ms.
    const late = new SidebarSwipe('open', 100, 300, 0);
    expect(steps(late, [[112, 300, 150], [115, 300, 300]])).toEqual(['wait', 'wait']);
    expect(late.end(125, 300, 320)).toBe('open');
  });

  it("does not let a lifting finger's wobble back undo a flick, only a turn back of more than FLICK_WOBBLE", () => {
    const flick = (back: number) => {
      const swipe = new SidebarSwipe('open', 100, 300, 0);
      steps(swipe, [[115, 300, 10], [140, 300, 20]]);
      return swipe.end(140 - back, 300, 30);
    };
    expect(flick(0.5)).toBe('open');
    expect(flick(1)).toBe('open');
    expect(flick(FLICK_WOBBLE)).toBe('open');
    expect(flick(FLICK_WOBBLE + 0.5)).toBe('drop');
    expect(flick(5)).toBe('drop');
    // The same closing.
    const close = new SidebarSwipe('close', 300, 300, 0);
    steps(close, [[285, 300, 10], [260, 300, 20]]);
    expect(close.end(261, 300, 30)).toBe('close');
    // Back a pixel at a time, more than FLICK_WOBBLE in all.
    const creep = new SidebarSwipe('open', 100, 300, 0);
    steps(creep, [[115, 300, 10], [140, 300, 20], [139, 300, 25], [138, 300, 30], [137, 300, 35], [136, 300, 40]]);
    expect(creep.end(135, 300, 45)).toBe('drop');
  });

  it('does nothing when the finger lifts before its direction is told, the other way, or going back', () => {
    // A tap.
    expect(new SidebarSwipe('open', 100, 300, 0).end(102, 301, 50)).toBe('drop');
    // Told at the lift: down, so no swipe.
    expect(new SidebarSwipe('open', 100, 300, 0).end(105, 340, 20)).toBe('drop');
    const back = new SidebarSwipe('open', 100, 300, 0);
    expect(steps(back, [[115, 300, 10], [140, 300, 20]])).toEqual(['wait', 'wait']);
    // Flicked back left: still 25px right of the touch, but going the other way.
    expect(back.end(125, 300, 30)).toBe('drop');
  });

  it('still does a swipe that reaches its distance as the finger lifts', () => {
    const swipe = new SidebarSwipe('open', 100, 300, 0);
    swipe.move(115, 300, 20);
    expect(swipe.end(100 + SWIPE_DISTANCE, 300, 2000)).toBe('open');
  });
});
