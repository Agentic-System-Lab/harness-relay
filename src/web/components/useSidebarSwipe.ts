import { useEffect, useRef } from 'react';
import { dialogsOpen } from '../dialogs';
import { DRAWER_MEDIA, SidebarSwipe, swipeWay, type SideScroll } from '../swipe';

/** Form fields, where moving the finger moves the caret, a selection or a slider. */
const FIELDS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** The boxes from `el` up that are wider inside than they show, with how they scroll sideways. */
function sideScrolls(el: Element | null): SideScroll[] {
  const boxes: SideScroll[] = [];
  for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    boxes.push({ overflowX: getComputedStyle(el).overflowX, scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }
  return boxes;
}

/**
 * Where the sidebar is a drawer, a swipe right opens it and a swipe left closes it (src/web/swipe.ts).
 * The touches are only listened to (passive): a scroll that is not a swipe goes on as before.
 */
export function useSidebarSwipe(open: boolean, setOpen: (open: boolean) => void): void {
  const now = useRef({ open, setOpen });
  now.current = { open, setOpen };

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const drawer = matchMedia(DRAWER_MEDIA);
    let swipe: SidebarSwipe | undefined;

    const onStart = (e: TouchEvent) => {
      swipe = undefined;
      const touch = e.touches[0];
      if (!touch) return;
      const target = e.target instanceof Element ? e.target : null;
      const way = swipeWay({
        drawer: drawer.matches,
        open: now.current.open,
        touches: e.touches.length,
        dialog: dialogsOpen() > 0 || !!target?.closest('[role="dialog"], [aria-modal="true"]'),
        field: !!target?.closest(FIELDS),
        selecting: document.getSelection()?.type === 'Range',
        boxes: drawer.matches ? sideScrolls(target) : [],
      });
      if (way) swipe = new SidebarSwipe(way, touch.clientX, touch.clientY, e.timeStamp);
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!swipe || !touch) return;
      const step = e.touches.length === 1 ? swipe.move(touch.clientX, touch.clientY, e.timeStamp) : 'drop';
      if (step === 'wait') return;
      swipe = undefined;
      if (step !== 'drop') now.current.setOpen(step === 'open');
    };
    const onEnd = () => {
      swipe = undefined;
    };

    const options = { passive: true } as const;
    document.addEventListener('touchstart', onStart, options);
    document.addEventListener('touchmove', onMove, options);
    document.addEventListener('touchend', onEnd, options);
    document.addEventListener('touchcancel', onEnd, options);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, []);
}
