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
 * - a plain load while a forced one (asked to look again rather than use a cache) is on its way asks
 *   only once that one has landed: asked at the same time, it could be answered from a cache made
 *   before the forced look, and win as the later request; asked after, it is answered from what the
 *   forced look found, and with whatever changed meanwhile (an account's defaults saved, say).
 * Returns the load: `force` asks the server to look again.
 */
export function latestLoader<T>(load: (force: boolean) => Promise<T>, show: (value: T) => void, onError: (err: unknown) => void): (force?: boolean) => Promise<void> {
  let asked = 0;
  let shown = 0;
  let forced: Promise<void> | undefined;
  /** The plain load asked once `forced` has landed: the plain loads made meanwhile share it. */
  let after: Promise<void> | undefined;
  const run = (force: boolean): Promise<void> => {
    if (!force && forced) {
      after ??= forced.then(() => {
        after = undefined;
        return run(false);
      });
      return after;
    }
    const n = ++asked;
    const done = load(force).then((value) => {
      if (n > shown) {
        shown = n;
        show(value);
      }
    }, onError);
    if (force) {
      forced = done;
      // Over however it ends, so that a later plain load is never left waiting on it.
      const over = () => {
        if (forced === done) forced = undefined;
      };
      done.then(over, over);
    }
    return done;
  };
  return (force = false) => run(force);
}
