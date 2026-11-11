// The dialogs open on the page, the newest last. Only the top one takes keys (Escape closes it, Tab
// stays inside it), so a dialog opened over another never closes both; and a dialog that offers
// itself (a new version, src/web/update.ts) waits until none is open. No DOM: tested in Node.

const open: object[] = [];
const listeners = new Set<() => void>();

const changed = () => listeners.forEach((fn) => fn());

/** A dialog that opened: whether it is the top one, and its close (once). */
export function openDialog(): { isTop(): boolean; close(): void } {
  const token = {};
  open.push(token);
  changed();
  return {
    isTop: () => open[open.length - 1] === token,
    close: () => {
      const at = open.indexOf(token);
      if (at < 0) return;
      open.splice(at, 1);
      changed();
    },
  };
}

/** How many dialogs are open. */
export function dialogsOpen(): number {
  return open.length;
}

/** Told each time a dialog opens or closes; returns the unsubscribe. */
export function onDialogsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
