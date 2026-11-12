import type { ProviderStatus } from '../shared/types';

/**
 * The CLIs' status to show once an answer comes in: for each CLI, whichever of the shown one and the
 * new one the server checked last (`checkedAt`). An answer can come in after a newer one (asked
 * before an account was added, or taken from the server's cache while a forced check ran), and must
 * not put the older state back; a request that fails changes nothing.
 */
export function newerStatuses(shown: ProviderStatus[], incoming: ProviderStatus[]): ProviderStatus[] {
  return incoming.map((s) => {
    const old = shown.find((x) => x.provider === s.provider);
    return old && (old.checkedAt ?? 0) > (s.checkedAt ?? 0) ? old : s;
  });
}

/**
 * Loads something the page shows that the server does not date (the model catalog), so that an older
 * answer never replaces a newer one:
 * - requests are numbered, and an answer is shown only when it is newer than the last one shown, so
 *   an older answer coming in last is dropped, while a newer request that fails leaves the older
 *   answer shown;
 * - a plain load while a forced one (asked to look again rather than use a cache) is on its way waits
 *   for that one instead of asking: its answer is at least as fresh, where a plain one could come
 *   from a cache made before it.
 * Returns the load: `force` asks the server to look again.
 */
export function latestLoader<T>(load: (force: boolean) => Promise<T>, show: (value: T) => void, onError: (err: unknown) => void): (force?: boolean) => Promise<void> {
  let asked = 0;
  let shown = 0;
  let forced: Promise<void> | undefined;
  return (force = false) => {
    if (!force && forced) return forced;
    const n = ++asked;
    const done = load(force).then((value) => {
      if (n > shown) {
        shown = n;
        show(value);
      }
    }, onError);
    if (force) {
      forced = done;
      void done.then(() => {
        if (forced === done) forced = undefined;
      });
    }
    return done;
  };
}
