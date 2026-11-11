import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, type ServerLimits } from '../src/shared/types';
import { limitsStore } from '../src/web/limits';

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the server's limits in the UI", () => {
  it('gives the defaults until the server answers, then its limits, telling listeners only of a change', async () => {
    const answers: Array<ServerLimits | Error> = [
      { maxAccounts: 3, maxTeamAgents: 12, turnTimeoutMinutes: 90 },
      { maxAccounts: 3, maxTeamAgents: 12, turnTimeoutMinutes: 90 },
      new Error('signed out'),
      { maxAccounts: 3, maxTeamAgents: 16, turnTimeoutMinutes: 90 },
    ];
    const load = vi.fn(async () => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const store = limitsStore(load);
    expect(store.get()).toEqual(DEFAULT_LIMITS);
    expect(load).not.toHaveBeenCalled(); // asked only once something listens

    const heard = vi.fn();
    const off = store.subscribe(heard);
    await settle();
    expect(store.get()).toEqual({ maxAccounts: 3, maxTeamAgents: 12, turnTimeoutMinutes: 90 });
    expect(heard).toHaveBeenCalledTimes(1);

    // The same again: nothing to hear, and the same object (useSyncExternalStore's snapshot).
    const snapshot = store.get();
    store.refresh();
    await settle();
    expect(store.get()).toBe(snapshot);
    expect(heard).toHaveBeenCalledTimes(1);

    // A failure keeps what it had; the next ask tries again and finds the server restarted with more.
    store.refresh();
    await settle();
    expect(store.get()).toBe(snapshot);
    store.refresh();
    await settle();
    expect(store.get().maxTeamAgents).toBe(16);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(4);
    off();
  });

  it('asks again for each new listener, but once at a time', async () => {
    let answer!: (l: ServerLimits) => void;
    const load = vi.fn(() => new Promise<ServerLimits>((r) => (answer = r)));
    const store = limitsStore(load);
    const offA = store.subscribe(() => {});
    const offB = store.subscribe(() => {});
    store.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    answer({ ...DEFAULT_LIMITS, maxAccounts: 4 });
    await settle();
    expect(store.get().maxAccounts).toBe(4);
    // A component opened later (after a restart, say) asks again.
    const offC = store.subscribe(() => {});
    expect(load).toHaveBeenCalledTimes(2);
    for (const off of [offA, offB, offC]) off();
  });
});
