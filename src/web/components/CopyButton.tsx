import { useEffect, useRef, useState } from 'react';
import { copyText } from '../copy';

interface Props {
  /** Called on click, so the latest content is copied. */
  text: () => string;
  label?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}

/** A text button that copies, then says so for a moment. */
export function CopyButton({ text, label = '複製', className = 'msg-action', disabled, title }: Props) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    const ok = await copyText(text());
    setState(ok ? 'done' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };

  return (
    <button
      type="button"
      className={state === 'idle' ? className : `${className} copy-${state}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-live="polite"
    >
      {state === 'done' ? '已複製' : state === 'failed' ? '無法複製' : label}
    </button>
  );
}
