import { type RefObject, useEffect, useRef, useState } from 'react';
import { CHAT_MIN_WIDTH, PREVIEW_MIN_WIDTH, previewWidth } from '../appPreview';

/**
 * The divider between the chat and a panel beside it (the app preview, the computer): drag it, or focus
 * it and use the arrow keys (left widens the panel; Home or Enter, or a double click, gives back the
 * default width). `onResize` gets each width as it goes, `final` once the drag ends (to keep it).
 */
export function PanelDivider({
  panel,
  onResize,
  label,
  title,
}: {
  panel: RefObject<HTMLElement | null>;
  onResize: (width: number | undefined, final: boolean) => void;
  label: string;
  title: string;
}) {
  /** The panel's width and the most it may take, for the divider's value. */
  const [measured, setMeasured] = useState<{ width: number; max: number }>();
  /** Ends a drag of the divider under way. */
  const dragEnd = useRef<(() => void) | null>(null);

  useEffect(() => {
    const box = panel.current;
    if (!box) return;
    const measure = () => {
      const container = box.offsetParent;
      if (container)
        setMeasured({
          width: Math.round(box.getBoundingClientRect().width),
          max: Math.max(PREVIEW_MIN_WIDTH, Math.round(container.getBoundingClientRect().width) - CHAT_MIN_WIDTH),
        });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    if (box.offsetParent) observer.observe(box.offsetParent);
    return () => {
      observer.disconnect();
      dragEnd.current?.();
    };
  }, [panel]);

  const resizeBy = (delta: number) => {
    const box = panel.current;
    const container = box?.offsetParent;
    if (!box || !container) return;
    onResize(previewWidth(box.getBoundingClientRect().width + delta, container.getBoundingClientRect().width), true);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = panel.current?.offsetParent;
    if (event.button !== 0 || !container) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    // The page and the terminal would take the pointer over them: see .resizing-preview.
    document.body.classList.add('resizing-preview');
    let last: number | undefined;
    const move = (e: PointerEvent) => {
      const box = container.getBoundingClientRect();
      last = previewWidth(box.right - e.clientX, box.width);
      onResize(last, false);
    };
    const end = () => {
      document.body.classList.remove('resizing-preview');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      dragEnd.current = null;
      // Kept once, when the drag ends.
      if (last !== undefined) onResize(last, true);
    };
    dragEnd.current = end;
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  };

  return (
    <div
      className="app-preview-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={PREVIEW_MIN_WIDTH}
      aria-valuemax={measured?.max}
      aria-valuenow={measured?.width}
      title={title}
      tabIndex={0}
      onPointerDown={startResize}
      onDoubleClick={() => onResize(undefined, true)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 128 : 32;
        if (e.key === 'ArrowLeft') resizeBy(step);
        else if (e.key === 'ArrowRight') resizeBy(-step);
        else if (e.key === 'Home' || e.key === 'Enter') onResize(undefined, true);
        else return;
        e.preventDefault();
      }}
    />
  );
}
