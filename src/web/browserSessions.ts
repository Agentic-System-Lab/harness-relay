import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthSessionView } from '../shared/types';
import { api } from './api';

export type BrowserSessions = ReturnType<typeof useBrowserSessions>;

/** Refresh while someone is looking at pairing, including when the phone opens or closes the app. */
export function useBrowserSessions(enabled: boolean) {
  const [sessions, setSessions] = useState<AuthSessionView[] | null>(null);
  const [error, setError] = useState('');
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++version.current;
    try {
      const list = await api.signedInBrowsers();
      if (current === version.current) {
        setSessions(list);
        setError('');
      }
    } catch (e) {
      if (current === version.current) {
        setSessions(null);
        setError((e as Error).message);
      }
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let polling = false;
    const visible = () => {
      if (document.visibilityState !== 'visible' || polling) return;
      polling = true;
      void refresh().finally(() => {
        polling = false;
      });
    };
    visible();
    const timer = window.setInterval(visible, 4000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    return () => {
      ++version.current;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
    };
  }, [enabled, refresh]);
  const phone = !sessions
    ? 'unknown'
    : sessions.some((s) => s.phone === 'online')
      ? 'online'
      : sessions.some((s) => s.phone === 'paired')
        ? 'paired'
        : 'unpaired';
  return { sessions, phone, error, refresh } as const;
}
