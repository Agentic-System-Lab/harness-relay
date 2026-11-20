import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ChevronIcon } from './icons';

export function AppRowCopy({ name, description, descriptionId }: { name: string; description: string; descriptionId?: string }) {
  return (
    <span className="app-row-copy">
      <strong>{name}</strong>
      <span className="muted small" id={descriptionId}>
        {description}
      </span>
    </span>
  );
}

/** Keep sign-in feedback and unfinished forms mounted when a service changes from Connect to Manage. */
export function AppRow({
  name,
  description,
  status,
  label,
  reveal,
  onOpen,
  children,
}: {
  name: string;
  description: string;
  status?: string;
  label?: string;
  reveal?: boolean;
  onOpen?: () => void;
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
  return (
    <li aria-label={name} className="app-row">
      <details
        className="app-options"
        ref={details}
        onToggle={(e) => {
          if (e.target === e.currentTarget && e.currentTarget.open) onOpen?.();
        }}
        onFocusCapture={(e) => {
          focused.current = e.target;
        }}
        onBlurCapture={(e) => {
          if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) focused.current = null;
        }}
      >
        <summary hidden={!label}>
          <AppRowCopy name={name} description={status || description} />
          <span className="app-row-action">
            {label}
            <ChevronIcon size={14} />
          </span>
        </summary>
        <div className={label ? 'app-row-body' : 'app-quick'}>{children}</div>
      </details>
    </li>
  );
}
