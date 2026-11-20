import { useEffect, useRef, useState } from 'react';
import type { SlackPostingConnection } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';

export function SlackPostingSettings({ view, setView }: { view?: SlackPostingConnection; setView: (v: SlackPostingConnection) => void }) {
  const t = useT();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const act = async (call: () => Promise<SlackPostingConnection>) => {
    const id = ++revision.current;
    setBusy(true);
    setError('');
    try {
      const result = await call();
      if (id === revision.current) {
        setView(result);
        if (call !== api.slackPosting) setToken('');
      }
    } catch (e) {
      if (id === revision.current) setError((e as Error).message);
    } finally {
      if (id === revision.current) setBusy(false);
    }
  };
  useEffect(() => {
    void act(api.slackPosting);
    return () => {
      revision.current++;
    };
  }, []);
  return (
    <details className="app-secondary">
      <summary>{t.apps.posting}</summary>
      <div className="app-row-body">
        <p className="muted small">{t.apps.postingHint}</p>
        {view?.status === 'connected' ? (
          <>
            <span>
              {view.sender} · {view.workspace}
            </span>
            <button type="button" className="ghost small-button" disabled={busy} onClick={() => void act(api.disconnectSlackPosting)}>
              {t.apps.disablePosting}
            </button>
          </>
        ) : (
          <form
            className="mcp-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => api.connectSlackPosting(token.trim()));
            }}
          >
            <p className="muted small">
              {t.apps.slackSetupHint}{' '}
              <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
                {t.apps.slackSetUp}
              </a>
            </p>
            <label className="field">
              <span>{t.apps.slackToken}</span>
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <div>
              <button type="submit" className="ghost small-button" disabled={busy || !token.trim()}>
                {t.apps.enablePosting}
              </button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="error-line">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
