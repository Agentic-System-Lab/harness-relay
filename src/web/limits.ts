import { useSyncExternalStore } from 'react';
import { DEFAULT_LIMITS, type ServerLimits } from '../shared/types';
import { api } from './api';

/**
 * The server's limits (`GET /api/limits`: accounts per CLI, team size, the turn timeout, which its
 * environment may set), asked for once a page needs them and kept while it is open. Until they arrive,
 * or when they cannot be had (signed out), the defaults; the server checks its own all the same.
 */
let limits: ServerLimits = DEFAULT_LIMITS;
let asked = false;
const listeners = new Set<() => void>();

function load(): void {
  if (asked) return;
  asked = true;
  api.limits().then(
    (l) => {
      limits = l;
      listeners.forEach((f) => f());
    },
    () => {
      asked = false; // asked again by the next component that needs them
    },
  );
}

function subscribe(f: () => void): () => void {
  listeners.add(f);
  load();
  return () => listeners.delete(f);
}

const current = () => limits;

/** The server's limits, the defaults until they arrive. */
export function useLimits(): ServerLimits {
  return useSyncExternalStore(subscribe, current, current);
}
