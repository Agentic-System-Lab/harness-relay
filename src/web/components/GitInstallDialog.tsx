import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GitInstallView, GitRequirement } from '../../shared/types';
import { api, GIT_AVAILABLE_EVENT } from '../api';
import { logTail } from '../clis';
import { useT } from '../i18n';
import { useDialog } from './useDialog';

export function GitInstallDialog({ requirement, open, onClose }: { requirement: GitRequirement; open: boolean; onClose: () => void }) {
  const t = useT();
  const d = t.gitInstall;
  const dialog = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<GitInstallView>();
  const [error, setError] = useState('');
  const [installError, setInstallError] = useState('');
  const [starting, setStarting] = useState(false);
  const [check, setCheck] = useState(0);
  const running = view?.job?.state === 'running';
  useDialog(dialog, onClose, open);

  useEffect(() => {
    if (starting || view?.available || (!open && !running)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.gitInstall(requirement, controller.signal);
        if (controller.signal.aborted) return;
        setView(next);
        setError('');
        if (next.job?.state !== 'running' || next.available) return;
      } catch (err) {
        if (controller.signal.aborted) return;
        setError((err as Error).message);
        if (!running) return;
      }
      timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [requirement, check, open, running, starting, view?.available]);

  useEffect(() => {
    if (view?.available) window.dispatchEvent(new Event(GIT_AVAILABLE_EVENT));
  }, [view?.available]);

  const install = async () => {
    setStarting(true);
    setInstallError('');
    try {
      setView(await api.installGit(requirement));
    } catch (err) {
      setInstallError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  if (!open) return null;
  const job = view?.job;
  const appleWaiting = view?.method === 'apple' && job?.state === 'success';

  return createPortal(
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal update-dialog sandbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-install-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="git-install-title">{d.title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        {view?.available ? (
          <p role="status">{d.ready}</p>
        ) : (
          <>
            <p>{requirement === 'gitBash' ? d.bash : d.body}</p>
            {view?.method && !appleWaiting && <p className="muted small">{d.methods[view.method]}</p>}
            {appleWaiting && <p role="status">{d.appleWaiting}</p>}
            {(starting || running) && <p role="status">{d.installing}</p>}
            {!view && !error && <p role="status">{t.common.loading}</p>}
            {view && !view.method && (
              <p>
                {d.manual}{' '}
                <a href="https://git-scm.com/install" target="_blank" rel="noreferrer">
                  {d.instructions}
                </a>
              </p>
            )}
            {view?.command && <pre className="cli-install-log">{view.command}</pre>}
            {(installError || error || job?.error) && (
              <p className="error-line" role="alert">
                {installError || error || job?.error}
              </p>
            )}
            {job?.log && <pre className="cli-install-log">{logTail(job.log)}</pre>}
          </>
        )}
        <footer className="update-foot">
          <span className="update-buttons">
            <button type="button" className="ghost" onClick={onClose}>
              {view?.available || running ? t.common.close : d.later}
            </button>
            {!view?.available && !running && (
              <button
                type="button"
                className="ghost"
                disabled={starting}
                onClick={() => {
                  setInstallError('');
                  setCheck((count) => count + 1);
                }}
              >
                {d.check}
              </button>
            )}
            {view?.method && !view.available && !running && (
              <button type="button" className="primary" disabled={starting} onClick={() => void install()}>
                {job ? d.retry : d.install}
              </button>
            )}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
