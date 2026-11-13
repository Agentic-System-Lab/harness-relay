/**
 * The parts of the page loaded when first needed (Settings, the dialogs, the other language:
 * `React.lazy`, `loadMessages`) that could not be. Most often a page left open across an update or a
 * rebuild, whose parts the new version replaced: reloading gets the new version's. Once only: a server
 * that cannot be reached would otherwise have the page reload again and again (`RELOAD_GAP_MS`).
 * `main.tsx` reloads; a part still missing says so (`components/Deferred.tsx`).
 */

/** How long after a reload for a missing part the page does not reload for one again. */
export const RELOAD_GAP_MS = 60_000;

/** Where this tab keeps when it last reloaded for one (sessionStorage). */
export const RELOAD_KEY = 'relay:partReload';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether to reload the page for a part it could not load, noting the time if so: not again within
 * `RELOAD_GAP_MS`, nor with nowhere to note it (it could not tell a second time from the first).
 */
export function reloadForMissingPart(store: Store | undefined, now = Date.now()): boolean {
  if (!store) return false;
  try {
    const last = Number(store.getItem(RELOAD_KEY) ?? '');
    if (last > 0 && Math.abs(now - last) < RELOAD_GAP_MS) return false;
    store.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
