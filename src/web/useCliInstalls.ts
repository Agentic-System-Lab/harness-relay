import { useCallback, useEffect, useRef, useState } from 'react';
import type { CliInstallView, Provider } from '../shared/types';
import { GIT_AVAILABLE_EVENT, api } from './api';
import { anyInstalling, followInstalls, installsEnded, withView } from './clis';

/**
 * How each CLI can be installed from Settings and what Harness Relay installed of it, asked again
 * every second while an install runs; `onEnded` is told of each CLI whose install ended (installed,
 * failed or cancelled), whose status and executable path changed, also once Settings is closed
 * (`followInstalls`).
 */
export function useCliInstalls(onEnded: (p: Provider) => void) {
  const [views, setViews] = useState<CliInstallView[]>([]);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const shown = useRef<CliInstallView[]>([]);

  const show = useCallback((next: CliInstallView[]) => {
    const before = shown.current;
    shown.current = next;
    setViews(next);
    for (const p of installsEnded(before, next)) ended.current(p);
  }, []);

  const refresh = useCallback(async () => {
    try {
      show(await api.clis());
    } catch {
      /* asked again on the next tick, or when the page opens again */
    }
  }, [show]);

  useEffect(() => {
    void refresh();
    window.addEventListener(GIT_AVAILABLE_EVENT, refresh);
    return () => window.removeEventListener(GIT_AVAILABLE_EVENT, refresh);
  }, [refresh]);

  // Settings closed with installs under way: they are followed until they end, for the sidebar's status.
  useEffect(
    () => () => {
      if (anyInstalling(shown.current))
        void followInstalls(
          shown.current,
          () => api.clis(),
          (p) => ended.current(p),
        );
    },
    [],
  );

  const running = anyInstalling(views);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [running, refresh]);

  /** One CLI's view as an install, a cancel or a removal answered it. */
  const update = useCallback((view: CliInstallView) => show(withView(shown.current, view)), [show]);

  return { views, update, refresh };
}
