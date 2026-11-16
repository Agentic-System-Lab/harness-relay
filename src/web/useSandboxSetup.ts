import { useCallback, useEffect, useRef, useState } from 'react';
import type { SandboxSetupView } from '../shared/types';
import { api } from './api';
import { setupRunning } from './sandboxSetup';

/**
 * What the agents' sandboxes need that is missing here (`GET /api/sandbox-setup`), asked when the
 * part using it opens, and again every second while its install runs.
 */
export function useSandboxSetup(enabled = true) {
  const [view, setView] = useState<SandboxSetupView>();
  // Set on each mount: StrictMode mounts twice, and an answer after the last unmount is dropped.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.sandboxSetup();
      if (alive.current) setView(next);
    } catch {
      /* asked again on the next tick, or when the part opens again */
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const running = setupRunning(view);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [running, refresh]);

  return { view, setView, refresh };
}
