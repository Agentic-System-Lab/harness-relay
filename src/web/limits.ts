import { useSyncExternalStore } from 'react';
import { DEFAULT_LIMITS, type ServerLimits } from '../shared/types';
import { api } from './api';

/** The server's limits as a store: the defaults until they arrive, asked again by `refresh()`. */
export interface LimitsStore {
  get(): ServerLimits;
  subscribe(listener: () => void): () => void;
  /** Asks the server again (once at a time); listeners hear of it only when something changed. */
  refresh(): void;
  /**
   * `refresh()`, but only while a component listens: only signed-in pages do, and a request made on the
   * sign-in page would answer 401, which signs the browser out (perhaps just as it signs in).
   */
  refreshIfListened(): void;
}

const same = (a: ServerLimits, b: ServerLimits) =>
  a.maxAccounts === b.maxAccounts && a.maxTeamAgents === b.maxTeamAgents && a.turnTimeoutMinutes === b.turnTimeoutMinutes;

/**
 * A store of the limits `load` gives (`GET /api/limits`). Each component that starts listening asks
 * again, so one opened after the server restarted with other values shows them; a failed request
 * (signed out, the server restarting) keeps what it had, and the next ask tries again.
 */
export function limitsStore(load: () => Promise<ServerLimits>): LimitsStore {
  let limits = DEFAULT_LIMITS;
  let asking = false;
  const listeners = new Set<() => void>();
  const refresh = () => {
    if (asking) return;
    asking = true;
    load().then(
      (l) => {
        asking = false;
        if (same(l, limits)) return;
        limits = l;
        listeners.forEach((f) => f());
      },
      () => {
        asking = false;
      },
    );
  };
  return {
    get: () => limits,
    subscribe(listener) {
      listeners.add(listener);
      refresh();
      return () => listeners.delete(listener);
    },
    refresh,
    refreshIfListened: () => {
      if (listeners.size) refresh();
    },
  };
}

const store = limitsStore(() => api.limits());

/**
 * Asks the server for its limits again, while a page shows them: when a chat's live updates connect
 * again or the sidebar reaches the server again (it may have restarted with other values, from the
 * desktop app's Restart server…), and when the page is shown again.
 */
export function refreshLimits(): void {
  store.refreshIfListened();
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', refreshLimits);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshLimits());
}

/** The server's limits (accounts per CLI, team size, the turn timeout), the defaults until they arrive. */
export function useLimits(): ServerLimits {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
