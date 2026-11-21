import { useEffect, useRef, useState } from 'react';
import type { AppDependency, AppDependencyView } from '../../shared/types';
import { api } from '../api';
import { logTail } from '../clis';
import { useT } from '../i18n';

/** Shown when a local prerequisite is missing. Reopening Settings resumes a running install. */
export function AppDependencyInstall({ name, onReady }: { name: AppDependency; onReady: () => Promise<unknown> }) {
  const t = useT();
  const [view, setView] = useState<AppDependencyView>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [installError, setInstallError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const ready = useRef(onReady);
  ready.current = onReady;
  const running = view?.job?.state === 'running';

  useEffect(() => {
    if (starting) return;
    const request = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const next = await api.appDependency(name, request.signal);
        if (request.signal.aborted) return;
        setView(next);
        setError('');
        if (next.available) await ready.current();
        else if (next.job?.state === 'running') timer = setTimeout(check, 1000);
      } catch (err) {
        if (!request.signal.aborted) setError((err as Error).message);
      }
    };
    void check();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [name, starting, refresh]);

  async function install() {
    setError('');
    setInstallError('');
    setStarting(true);
    try {
      setView(await api.installAppDependency(name));
    } catch (err) {
      setInstallError((err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const failed = view?.job?.state === 'failed';
  const busy = starting || running;
  const retry = () => {
    setInstallError('');
    setRefresh((n) => n + 1);
  };
  const label = name === 'github' ? t.apps.installGh : t.apps.installBrowser;
  return (
    <div className="app-dependency">
      {!view && !error && <p role="status">{t.common.loading}</p>}
      {busy && <p role="status">{t.apps.installingDependency}</p>}
      {(error || installError) && <p role="alert">{error || installError}</p>}
      {failed && !busy && <p role="alert">{view?.job?.error}</p>}
      {failed && view?.job?.log && (
        <details className="sub">
          <summary>{t.apps.installLog}</summary>
          <pre className="cli-install-log">{logTail(view.job.log)}</pre>
        </details>
      )}
      {view && !view.canInstall && !busy && !view.available && (
        <div>
          <p>{t.apps.manualDependency}</p>
          {view.command ? (
            <code>{view.command}</code>
          ) : (
            <a href={name === 'github' ? 'https://cli.github.com/' : 'https://www.google.com/chrome/'} target="_blank" rel="noreferrer">
              {t.apps.downloadPage}
            </a>
          )}
        </div>
      )}
      <div className="form-actions">
        {view?.canInstall && !busy && (
          <button type="button" className="ghost small-button" onClick={() => void install()}>
            {failed ? t.apps.retryInstall : label}
          </button>
        )}
        {((view && !busy) || error) && (
          <button type="button" className="ghost small-button" disabled={starting} onClick={retry}>
            {t.apps.checkAgain}
          </button>
        )}
      </div>
    </div>
  );
}
