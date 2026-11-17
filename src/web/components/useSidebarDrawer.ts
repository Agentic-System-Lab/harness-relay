import { useEffect, useRef } from 'react';
import { dialogsOpen } from '../dialogs';
import { DRAWER_MEDIA, SidebarSwipe, scrollTakesSwipe, swipeWay, type SideScroll } from '../swipe';

/** Form fields, where moving the finger moves the caret, a selection or a slider. */
const FIELDS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** What the finger moves itself: form fields, and a video's or a sound's controls (their seek bar). */
const CONTROLS = `${FIELDS}, video, audio`;

/** The boxes from `el` up that are wider inside than they show, with how they scroll sideways. */
function sideScrolls(el: Element | null): SideScroll[] {
  const boxes: SideScroll[] = [];
  for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const style = getComputedStyle(el);
    boxes.push({
      overflowX: style.overflowX,
      direction: style.direction,
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    });
  }
  return boxes;
}

/**
 * Text is selected on the page, outside a form field: a selection in the message box is the box's own.
 * Chromium shows a text box's selection as a collapsed range beside the box (still of type 'Range'),
 * also once the box has lost the focus; a selection in an editable element is in that element.
 */
function textSelected(): boolean {
  const selection = document.getSelection();
  if (!selection || selection.type !== 'Range' || selection.isCollapsed) return false;
  const node = selection.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  return !el?.closest(FIELDS);
}

/**
 * Where the sidebar is a drawer: a swipe right opens it and a swipe left closes it (src/web/swipe.ts),
 * and it closes once the screen is wide enough for it to be no drawer, so that it is not open again
 * when the screen narrows. The touches are only listened to (passive): a scroll goes on as before.
 */
export function useSidebarDrawer(open: boolean, setOpen: (open: boolean) => void): void {
  const now = useRef({ open, setOpen });
  now.current = { open, setOpen };

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const drawer = matchMedia(DRAWER_MEDIA);
    let swipe: SidebarSwipe | undefined;
    /**
     * The boxes under the finger that scroll sideways, measured at its first move (a tap has none, or
     * hardly any), before the browser scrolls one: by the time the move turns out sideways, Android's
     * Chrome, which sends moves from 8dp on, may have started scrolling a box near its end.
     */
    let boxes: (() => SideScroll[]) | undefined;
    const apply = (step: ReturnType<SidebarSwipe['move']>) => {
      if (step === 'wait') return;
      swipe = undefined;
      if (step !== 'drop') now.current.setOpen(step === 'open');
    };

    const onStart = (e: TouchEvent) => {
      swipe = undefined;
      boxes = undefined;
      const touch = e.touches[0];
      if (!touch) return;
      const target = e.target instanceof Element ? e.target : null;
      const way = swipeWay({
        drawer: drawer.matches,
        open: now.current.open,
        touches: e.touches.length,
        dialog: dialogsOpen() > 0 || !!target?.closest('[role="dialog"], [aria-modal="true"]'),
        control: !!target?.closest(CONTROLS),
        selecting: textSelected(),
      });
      if (!way) return;
      let measured: SideScroll[] | undefined;
      const measure = () => (measured ??= sideScrolls(target));
      boxes = measure;
      swipe = new SidebarSwipe(way, touch.clientX, touch.clientY, e.timeStamp, () => scrollTakesSwipe(measure(), way));
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!swipe || !touch) return;
      boxes?.();
      apply(e.touches.length === 1 ? swipe.move(touch.clientX, touch.clientY, e.timeStamp) : 'drop');
    };
    const onEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0];
      if (!swipe || !touch) return;
      apply(e.touches.length === 0 ? swipe.end(touch.clientX, touch.clientY, e.timeStamp) : 'drop');
    };
    const onCancel = () => {
      swipe = undefined;
    };
    const onScreen = () => {
      if (drawer.matches) return;
      swipe = undefined;
      now.current.setOpen(false);
    };

    const options = { passive: true } as const;
    document.addEventListener('touchstart', onStart, options);
    document.addEventListener('touchmove', onMove, options);
    document.addEventListener('touchend', onEnd, options);
    document.addEventListener('touchcancel', onCancel, options);
    drawer.addEventListener('change', onScreen);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
      drawer.removeEventListener('change', onScreen);
    };
  }, []);
}
