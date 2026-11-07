import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../copy';
import { useT } from '../i18n';
import { CheckIcon } from './icons';

interface Props {
  /** Called on click, so the latest content is copied. */
  text: () => string;
  label?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  /** Shown before the label (a check once copied); the label goes in a `.button-label` span, which CSS may hide. */
  icon?: ReactNode;
}

/** A text button that copies, then says so for a moment. */
export function CopyButton({ text, label, className = 'msg-action', disabled, title, icon }: Props) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    const ok = await copyText(text());
    setState(ok ? 'done' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1600);
  };

  const caption = state === 'done' ? t.common.copied : state === 'failed' ? t.common.copyFailed : (label ?? t.common.copy);
  return (
    <button
      type="button"
      className={state === 'idle' ? className : `${className} copy-${state}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-live="polite"
    >
      {icon ? (
        <>
          {state === 'done' ? <CheckIcon size={16} /> : icon}
          <span className="button-label">{caption}</span>
        </>
      ) : (
        caption
      )}
    </button>
  );
}
