import { describe, expect, it } from 'vitest';
import { PartLoadError, RELOAD_GAP_MS, RELOAD_KEY, loadPart, reloadForMissingPart } from '../src/web/chunks';

/** Whether a promise settled within a few turns of the event loop. */
async function settles(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return done;
}

describe('loading a part of the page', () => {
  it('gives the part as loaded', async () => {
    expect(await loadPart(async () => 'Settings', () => true)).toBe('Settings');
  });

  it('waits while the page reloads for a part that cannot be loaded, so that no note flashes before the new page', async () => {
    let reloads = 0;
    const part = loadPart(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')), () => (reloads++, true));
    expect(await settles(part)).toBe(false);
    expect(reloads).toBe(1);
  });

  it('fails with a PartLoadError, its cause kept, when the page does not reload for it (again so soon)', async () => {
    const cause = new TypeError('Failed to fetch dynamically imported module');
    const part = loadPart(() => Promise.reject(cause), () => false);
    await expect(part).rejects.toBeInstanceOf(PartLoadError);
    await expect(part).rejects.toMatchObject({ cause });
  });
});

function store(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('reloading for a part of the page that could not be loaded', () => {
  it('reloads once, then not again for a while, so that a server that is gone does not make it reload over and over', () => {
    const s = store();
    expect(reloadForMissingPart(s, 1_000_000)).toBe(true);
    expect(s.data.get(RELOAD_KEY)).toBe('1000000');
    // The part is still missing after the reload: the page says so instead.
    expect(reloadForMissingPart(s, 1_000_000 + 2_000)).toBe(false);
    expect(reloadForMissingPart(s, 1_000_000 + RELOAD_GAP_MS - 1)).toBe(false);
    // Long after (another update): once again.
    expect(reloadForMissingPart(s, 1_000_000 + RELOAD_GAP_MS)).toBe(true);
    expect(s.data.get(RELOAD_KEY)).toBe(String(1_000_000 + RELOAD_GAP_MS));
  });

  it('does not reload where it cannot note that it did, nor just after a time it cannot be sure of', () => {
    expect(reloadForMissingPart(undefined)).toBe(false);
    const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(reloadForMissingPart(full)).toBe(false);
    const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {} };
    expect(reloadForMissingPart(blocked)).toBe(false);
    // The clock went back: as if just reloaded.
    expect(reloadForMissingPart(store({ [RELOAD_KEY]: '5000' }), 4_000)).toBe(false);
    // Something else written there: as if never reloaded.
    expect(reloadForMissingPart(store({ [RELOAD_KEY]: 'x' }), 4_000)).toBe(true);
  });
});
