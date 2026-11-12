import { useEffect, useRef } from 'react';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '../../shared/types';
import { PROVIDER_COLOR } from '../util';

/**
 * A choice of CLI: one row of every CLI, which scrolls sideways where it does not fit (`.cli-picker`).
 * The chosen one is scrolled into the row's view when it changes (Pi, the last, say), the row only,
 * never the page.
 */
export function CliPicker({ value, onPick, label }: { value: Provider; onPick: (p: Provider) => void; label: string }) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => revealChosen(row.current), [value]);
  return (
    <div ref={row} className="segmented cli-picker" role="radiogroup" aria-label={label}>
      {PROVIDERS.map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          className={value === p ? 'on' : ''}
          style={{ ['--accent' as string]: PROVIDER_COLOR[p] }}
          onClick={() => {
            if (value !== p) onPick(p);
          }}
        >
          {PROVIDER_LABEL[p]}
        </button>
      ))}
    </div>
  );
}

/** Scrolls the row sideways so that its chosen button is in view, with a little room beside it. */
function revealChosen(row: HTMLElement | null): void {
  const on = row?.querySelector<HTMLElement>('button.on');
  if (!row || !on) return;
  const box = row.getBoundingClientRect();
  const button = on.getBoundingClientRect();
  if (button.left < box.left) row.scrollLeft -= box.left - button.left + 12;
  else if (button.right > box.right) row.scrollLeft += button.right - box.right + 12;
}
