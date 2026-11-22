import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PreviewDockerView } from '../../shared/types';
import { api } from '../api';
import { logTail } from '../clis';
import { useT } from '../i18n';
import { useDialog } from './useDialog';

export function PreviewDockerDialog({
  initial,
  onReady,
  onClose,
}: {
  initial: PreviewDockerView;
  onReady: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const p = t.appPreview;
  const dialog = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(initial);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [installError, setInstallError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  useDialog(dialog, onClose);

  useEffect(() => {
    if (starting) return;
    const controller = new AbortController();
    request.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const next = await api.previewDocker(controller.signal);
        if (controller.signal.aborted) return;
        setView(next);
        setError('');
        if (next.state === 'ready') {
          ready.current();
          return;
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError((err as Error).message);
      }
      timer = setTimeout(() => void check(), 3000);
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [starting, refresh]);

  const install = async () => {
    if (starting || !view.canInstall || view.state !== 'missing') return;
    request.current?.abort();
    setStarting(true);
    setError('');
    setInstallError('');
    try {
      setView(await api.installPreviewDocker());
    } catch (err) {
      setInstallError((err as Error).message);
    } finally {
      setStarting(false);
      setRefresh((n) => n + 1);
    }
  };
  const running = starting || view.job?.state === 'running';
  const failure = installError || error || view.job?.error;
  return createPortal(
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal update-dialog sandbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-docker-title"
        aria-describedby="preview-docker-message"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="preview-docker-title">{p.dockerTitle}</h2>
        </header>
        <p id="preview-docker-message">{view.state === 'missing' ? p.dockerMissing : p.dockerUnavailable}</p>
        {view.detail && <p className="muted small">{view.detail}</p>}
        {running && <p role="status">{p.dockerInstalling}</p>}
        {failure && <p role="alert">{failure}</p>}
        {view.job?.state === 'failed' && view.job.log && (
          <details className="sub">
            <summary>{t.apps.installLog}</summary>
            <pre className="cli-install-log">{logTail(view.job.log)}</pre>
          </details>
        )}
        {view.command && <pre className="cli-install-log">{view.command}</pre>}
        {view.help === 'linux-access' && (
          <a href="https://docs.docker.com/engine/security/rootless/" target="_blank" rel="noreferrer">
            {p.dockerLinuxAccess}
          </a>
        )}
        {view.state === 'missing' && !running && !view.canInstall && (
          <a href="https://docs.docker.com/get-started/get-docker/" target="_blank" rel="noreferrer">
            {p.dockerGuide}
          </a>
        )}
        <div className="form-actions">
          {view.state === 'missing' && view.canInstall && !running && (
            <button type="button" className="primary small-button" onClick={() => void install()}>
              {p.dockerInstall}
            </button>
          )}
          <button type="button" className="ghost small-button" disabled={starting} onClick={() => setRefresh((n) => n + 1)}>
            {t.apps.checkAgain}
          </button>
          <button type="button" className="ghost small-button" onClick={onClose}>
            {running ? t.common.close : t.common.cancel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
