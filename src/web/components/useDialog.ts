import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { dialogsOpen, onDialogsChange, openDialog } from '../dialogs';

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Basic modal dialog behaviour for the element in `ref` (give it tabIndex={-1}): focus moves into it on
 * open, Tab stays inside it, Escape closes it, and focus goes back to where it was on close. Only the
 * top dialog takes keys, when one opens over another (src/web/dialogs.ts).
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.focus();
    const entry = openDialog();

    const onKey = (e: KeyboardEvent) => {
      if (!entry.isTop()) return;
      // Escape cancels the IME candidate list, not the dialog (Safari ends composition first: keyCode 229).
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        dialog.focus();
      } else if (e.shiftKey && (at === first || at === dialog || !dialog.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !dialog.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      entry.close();
      document.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [ref]);
}

/** How many dialogs are open on the page, kept up to date. */
export function useDialogsOpen(): number {
  return useSyncExternalStore(onDialogsChange, dialogsOpen);
}
