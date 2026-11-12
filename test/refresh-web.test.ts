import { describe, expect, it, vi } from 'vitest';
import type { ProviderStatus } from '../src/shared/types';
import { latestLoader, newerStatuses } from '../src/web/refresh';

const status = (provider: ProviderStatus['provider'], checkedAt: number | undefined, loggedIn: boolean): ProviderStatus => ({
  provider,
  installed: true,
  bin: provider,
  auth: { loggedIn },
  usingStoredApiKey: false,
  accounts: [{ id: '', label: '', auth: { loggedIn }, usingStoredApiKey: false }],
  ...(checkedAt === undefined ? {} : { checkedAt }),
});

/** A promise and the means to settle it from the test. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("the CLIs' status the chat shows", () => {
  it('keeps, for each CLI, the status the server checked last, whatever order the answers come in', () => {
    const newer = [status('claude', 200, true), status('codex', 200, false)];
    // An answer to an older request (checked before an account was added, say) coming in last.
    const older = [status('claude', 100, false), status('codex', 300, true)];
    expect(newerStatuses(newer, older)).toEqual([newer[0], older[1]]);
  });

  it('takes an answer from the cache over nothing, and a fresh check over the cache', () => {
    const cached = [status('claude', 100, true)];
    expect(newerStatuses([], cached)).toEqual(cached);
    // A forced check (signed out meanwhile) answered before the cached one comes in.
    const fresh = [status('claude', 200, false)];
    expect(newerStatuses(fresh, cached)).toEqual(fresh);
  });

  it('takes the new one when both have the same time or the shown one has none, and keeps a dated one over an undated new one', () => {
    expect(newerStatuses([status('grok', 100, false)], [status('grok', 100, true)])[0]!.auth.loggedIn).toBe(true);
    expect(newerStatuses([status('grok', undefined, false)], [status('grok', 100, true)])[0]!.auth.loggedIn).toBe(true);
    expect(newerStatuses([status('grok', 100, false)], [status('grok', undefined, true)])[0]!.auth.loggedIn).toBe(false);
  });
});

describe("loading what the server does not date (the model catalog)", () => {
  it('drops an older answer that comes in after a newer one', async () => {
    const answers = [deferred<string>(), deferred<string>()];
    const shown: string[] = [];
    let i = 0;
    const refresh = latestLoader(() => answers[i++]!.promise, (v) => shown.push(v), () => {});
    const first = refresh(true);
    const second = refresh(true);
    answers[1]!.resolve('new');
    await second;
    answers[0]!.resolve('old');
    await first;
    expect(shown).toEqual(['new']);
  });

  it('keeps an older answer shown when a newer request fails', async () => {
    const answers = [deferred<string>(), deferred<string>()];
    const shown: string[] = [];
    const errors: unknown[] = [];
    let i = 0;
    const refresh = latestLoader(() => answers[i++]!.promise, (v) => shown.push(v), (e) => errors.push(e));
    const first = refresh(true);
    const second = refresh(true);
    answers[1]!.reject(new Error('offline'));
    await second;
    answers[0]!.resolve('old');
    await first;
    expect(shown).toEqual(['old']);
    expect(errors).toHaveLength(1);
  });

  it('asks a plain load during a forced one only once that one has landed, so the plain answer comes after it', async () => {
    const forced = deferred<string>();
    const load = vi.fn((force: boolean) => (force ? forced.promise : Promise.resolve('after')));
    const shown: string[] = [];
    const refresh = latestLoader(load, (v) => shown.push(v), () => {});
    const a = refresh(true);
    const b = refresh();
    // Not asked yet: asked now, it could be answered from a cache made before the forced look.
    expect(load).toHaveBeenCalledTimes(1);
    forced.resolve('fresh');
    await a;
    await b;
    expect(load.mock.calls).toEqual([[true], [false]]);
    expect(shown).toEqual(['fresh', 'after']);
    // Nothing on its way: a plain load asks at once.
    await refresh();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('asks once for the plain loads made during one forced load', async () => {
    const forced = deferred<string>();
    const load = vi.fn((force: boolean) => (force ? forced.promise : Promise.resolve('after')));
    const refresh = latestLoader(load, () => {}, () => {});
    const waiting = [refresh(true), refresh(), refresh(), refresh()];
    forced.resolve('fresh');
    await Promise.all(waiting);
    expect(load.mock.calls).toEqual([[true], [false]]);
  });

  it('goes on loading after a forced load whose answer could not be shown', async () => {
    const load = vi.fn((force: boolean) => Promise.resolve(force ? 'bad' : 'good'));
    const shown: string[] = [];
    const errors: unknown[] = [];
    const refresh = latestLoader(
      load,
      (v) => {
        if (v === 'bad') throw new Error('cannot show it');
        shown.push(v);
      },
      (e) => errors.push(e),
    );
    await expect(refresh(true)).rejects.toThrow('cannot show it');
    await refresh();
    expect(load.mock.calls).toEqual([[true], [false]]);
    expect(shown).toEqual(['good']);
  });
});
