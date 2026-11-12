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

  it('takes the new one when they were checked at the same time, or when either has no time', () => {
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

  it('waits for a forced load on its way instead of asking the cache, and asks again once it is over', async () => {
    const forced = deferred<string>();
    const load = vi.fn((force: boolean) => (force ? forced.promise : Promise.resolve('cached')));
    const shown: string[] = [];
    const refresh = latestLoader(load, (v) => shown.push(v), () => {});
    const a = refresh(true);
    const b = refresh();
    expect(b).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
    forced.resolve('fresh');
    await b;
    expect(shown).toEqual(['fresh']);
    await refresh();
    expect(load).toHaveBeenLastCalledWith(false);
    expect(shown).toEqual(['fresh', 'cached']);
  });
});
