import { useCallback, useEffect, useState } from 'react';
import type { VoiceStatus } from '../shared/types';
import { api } from './api';

/** The voice input status, polled every second while something is being installed or started. */
export function useVoiceStatus() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.voice());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const busy = status?.job?.state === 'running' || status?.server === 'starting';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  return { status, setStatus, refresh, error };
}
