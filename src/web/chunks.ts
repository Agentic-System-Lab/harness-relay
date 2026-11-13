/**
 * The parts of the page loaded when first needed (Settings, the dialogs, the other language:
 * `lazyPart` in `components/Deferred.tsx`, `loadMessages`) that could not be. Most often a page left
 * open across an update or a rebuild, whose parts the new version replaced: reloading gets the new
 * version's. Once only: a server that cannot be reached would otherwise have the page reload again and
 * again (`RELOAD_GAP_MS`). A part still missing says so (`Deferred`).
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

/** A part of the page that could not be loaded, told apart from one that could not be drawn (`Deferred`). */
export class PartLoadError extends Error {
  constructor(cause: unknown) {
    super('could not load a part of the page', { cause });
    this.name = 'PartLoadError';
  }
}

/**
 * Loads a part of the page (its `import()`). When it cannot be, the page reloads for it (`reload`),
 * the part waiting meanwhile, so that no note flashes before the new page; when it does not reload
 * (`reloadForMissingPart`), the part fails with a `PartLoadError`. Only the parts loaded through here:
 * a Mermaid diagram that cannot be loaded shows its source, as before, and reloads nothing.
 */
export function loadPart<T>(load: () => Promise<T>, reload: () => boolean = reloadPage): Promise<T> {
  return load().catch((err: unknown) => {
    if (reload()) return new Promise<never>(() => {});
    throw new PartLoadError(err);
  });
}

let reloading = false;

/** Reloads the page for a missing part, once (`reloadForMissingPart`): true when it does, or already is. */
function reloadPage(): boolean {
  if (reloading) return true;
  let store: Storage | undefined;
  try {
    store = sessionStorage;
  } catch {
    // no storage: no reload, which could not be told from the next
  }
  if (!reloadForMissingPart(store)) return false;
  reloading = true;
  location.reload();
  return true;
}
