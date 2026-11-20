import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ChevronIcon } from './icons';

/** Keep sign-in feedback and unfinished forms mounted when a service changes from Connect to Manage. */
export function AppRow({
  name,
  description,
  status,
  label,
  reveal,
  children,
}: {
  name: string;
  description: string;
  status?: string;
  label?: string;
  reveal?: boolean;
  children: ReactNode;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const row = details.current;
    if (!row) return;
    if (!label || reveal) row.open = true;
    // The sign-out or sign-in action can be replaced when its request finishes.
    if (focused.current && !focused.current.isConnected && document.activeElement === document.body) {
      row.querySelector<HTMLElement>(label ? 'summary' : 'button:not(:disabled), input:not(:disabled)')?.focus();
    }
  }, [label, reveal]);
  const title = (
    <span className="app-row-copy">
      <strong>{name}</strong>
      <span className="muted small">{status || description}</span>
    </span>
  );
  return (
    <li aria-label={name} className="app-row">
      <details
        className="app-options"
        ref={details}
        onFocusCapture={(e) => {
          focused.current = e.target;
        }}
        onBlurCapture={(e) => {
          if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) focused.current = null;
        }}
      >
        <summary hidden={!label}>
          {title}
          <span className="app-row-action">
            {label}
            <ChevronIcon size={14} />
          </span>
        </summary>
        <div className={label ? 'app-row-body' : 'app-quick'}>
          {!label && title}
          {children}
        </div>
      </details>
    </li>
  );
}
