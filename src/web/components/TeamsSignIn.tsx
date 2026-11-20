import { useEffect, useRef, useState } from 'react';
import type { TeamsConnection } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';

export function TeamsSignIn({ view, setView }: { view?: TeamsConnection; setView: (value: TeamsConnection) => void }) {
  const t = useT();
  const a = t.apps;
  const details = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);

  const act = async (request: () => Promise<TeamsConnection>) => {
    const id = ++revision.current;
    setBusy(true);
    setError('');
    try {
      const next = await request();
      if (id === revision.current) setView(next);
    } catch (e) {
      if (id === revision.current) setError((e as Error).message);
    } finally {
      if (id === revision.current) setBusy(false);
    }
  };

  useEffect(() => {
    void act(api.teamsStatus);
    return () => {
      revision.current++;
    };
  }, []);

  const pending = view?.status === 'installing' || view?.status === 'signing-in';
  useEffect(() => {
    if (pending && details.current) details.current.open = true;
  }, [pending]);
  useEffect(() => {
    if (!pending || busy) return;
    let stopped = false;
    const id = revision.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.teamsStatus();
        if (stopped || id !== revision.current) return;
        setError('');
        setView(next);
        if (next.status !== 'installing' && next.status !== 'signing-in') return;
      } catch (e) {
        if (stopped || id !== revision.current) return;
        setError((e as Error).message);
      }
      timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending, busy]);

  const button = (label: string, request: () => Promise<TeamsConnection>) => (
    <button type="button" className="ghost small-button" disabled={busy} onClick={() => void act(request)}>
      {label}
    </button>
  );
  return (
    <details ref={details} className="app-secondary">
      <summary>{a.teamsDirect}</summary>
      <div className="app-row-body">
        {view?.status === 'missing-powershell' && (
          <p className="muted small">
            {a.teamsPowerShell}{' '}
            <a href="https://learn.microsoft.com/powershell/scripting/install/installing-powershell" target="_blank" rel="noreferrer">
              {a.installPowerShell}
            </a>
          </p>
        )}
        {view?.status === 'missing-module' && button(a.installGraph, api.teamsInstall)}
        {view?.status === 'signed-out' && button(a.connect, api.teamsConnect)}
        {view?.status === 'installing' && <p role="status">{a.installingGraph}</p>}
        {view?.status === 'signing-in' && (
          <div role="status">
            {view.code ? (
              <>
                <p>
                  {a.teamsCode} <strong>{view.code}</strong>
                </p>
                <a
                  href={view.url === 'https://login.microsoft.com/device' ? view.url : 'https://microsoft.com/devicelogin'}
                  target="_blank"
                  rel="noreferrer"
                >
                  {a.openMicrosoft}
                </a>
              </>
            ) : (
              <p>{a.teamsWaiting}</p>
            )}
          </div>
        )}
        {pending && button(t.common.cancel, api.teamsDisconnect)}
        {view?.status === 'connected' && (
          <div>
            <span>
              {view.account} · {t.connectors.oauth.connected}
            </span>
            {button(a.disconnect, api.teamsDisconnect)}
          </div>
        )}
        {view?.status === 'error' && (
          <p role="alert" className="error-line">
            {view.message}
          </p>
        )}
        {error && (
          <p role="alert" className="error-line">
            {error}
          </p>
        )}
        {view?.status === 'error'
          ? button(a.checkAgain, api.teamsDisconnect)
          : (view?.status === 'missing-powershell' || (!view && error)) && button(a.checkAgain, api.teamsStatus)}
        {!view && !error && t.common.loading}
      </div>
    </details>
  );
}
