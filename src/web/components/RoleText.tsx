import { useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

/** An agent's role description, in full: a long one is folded to a few lines with "Show more". */
export function RoleText({ text, lines = 3, className = '' }: { text: string; lines?: number; className?: string }) {
  const t = useT();
  const body = useRef<HTMLParagraphElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);

  // Measured only while folded: unfolded, the text is as tall as it is, so "Show less" just stays.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || open) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, lines, open]);

  return (
    <div className={`role-text ${className}`}>
      <p ref={body} className={open ? '' : 'folded'} style={{ ['--lines' as string]: lines }}>
        {text}
      </p>
      {(long || open) && (
        <button type="button" className="show-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? t.message.showLess : t.message.showMore}
        </button>
      )}
    </div>
  );
}
