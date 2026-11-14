import { describe, expect, it } from 'vitest';
import {
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
  field: false,
  selecting: false,
  boxes: [],
  ...extra,
});

const box = (extra: Partial<SideScroll> = {}): SideScroll => ({ overflowX: 'auto', scrollLeft: 0, scrollWidth: 600, clientWidth: 300, ...extra });

/** The steps of a finger that touched at (100, 300) at 0 ms and moved through `points` ([x, y, ms]). */
function steps(swipe: SidebarSwipe, points: [number, number, number][]): SwipeStep[] {
  return points.map(([x, y, at]) => swipe.move(x, y, at));
}

describe('what a touch may do', () => {
  it('opens a closed drawer and closes an open one', () => {
    expect(swipeWay(start())).toBe('open');
    expect(swipeWay(start({ open: true }))).toBe('close');
  });

  it('does nothing where the sidebar is no drawer, with two fingers, in a dialog, a field or a selection', () => {
    expect(swipeWay(start({ drawer: false }))).toBeUndefined();
    expect(swipeWay(start({ touches: 2 }))).toBeUndefined();
    expect(swipeWay(start({ dialog: true }))).toBeUndefined();
    expect(swipeWay(start({ field: true }))).toBeUndefined();
    expect(swipeWay(start({ selecting: true }))).toBeUndefined();
  });

  it('leaves the move to a box that scrolls sideways that way', () => {
    // Scrolled on: a swipe right scrolls it back.
    expect(swipeWay(start({ boxes: [box({ scrollLeft: 40 })] }))).toBeUndefined();
    // At its start: the swipe right is the sidebar's.
    expect(swipeWay(start({ boxes: [box()] }))).toBe('open');
    // An open drawer with a box that has more on the right: a swipe left scrolls it on.
    expect(swipeWay(start({ open: true, boxes: [box()] }))).toBeUndefined();
    expect(swipeWay(start({ open: true, boxes: [box({ scrollLeft: 300 })] }))).toBe('close');
  });
});

describe('a box that scrolls sideways', () => {
  it('takes a swipe only while it can scroll that way', () => {
    expect(scrollTakesSwipe([box({ scrollLeft: 1 })], 'open')).toBe(true);
    expect(scrollTakesSwipe([box({ scrollLeft: 0.5 })], 'open')).toBe(false);
    expect(scrollTakesSwipe([box({ scrollLeft: 298 })], 'close')).toBe(true);
    expect(scrollTakesSwipe([box({ scrollLeft: 299 })], 'close')).toBe(false);
  });

  it('takes none when it does not scroll, or has nothing more to show', () => {
    for (const overflowX of ['visible', 'hidden', 'clip']) {
      expect(scrollTakesSwipe([box({ overflowX, scrollLeft: 40 })], 'open')).toBe(false);
      expect(scrollTakesSwipe([box({ overflowX })], 'close')).toBe(false);
    }
    expect(scrollTakesSwipe([box({ overflowX: 'scroll', scrollLeft: 40 })], 'open')).toBe(true);
    // A pixel of rounding is no more to show.
    expect(scrollTakesSwipe([box({ scrollWidth: 301, scrollLeft: 1 })], 'open')).toBe(false);
    expect(scrollTakesSwipe([], 'open')).toBe(false);
  });

  it('takes it when any box under the finger can scroll', () => {
    expect(scrollTakesSwipe([box(), box({ scrollLeft: 40 })], 'open')).toBe(true);
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

  it('is not the other way', () => {
    expect(new SidebarSwipe('open', 100, 300, 0).move(80, 300, 20)).toBe('drop');
    expect(new SidebarSwipe('close', 300, 300, 0).move(320, 300, 20)).toBe('drop');
  });

  it('is no scroll up or down, nor a move that slants too much', () => {
    expect(new SidebarSwipe('open', 100, 300, 0).move(102, 280, 20)).toBe('drop');
    expect(new SidebarSwipe('open', 100, 300, 0).move(112, 290, 20)).toBe('drop');
    // A little slant is still a swipe.
    expect(new SidebarSwipe('open', 100, 300, 0).move(112, 295, 20)).toBe('wait');
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
});
