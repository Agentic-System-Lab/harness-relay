import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SandboxSetupView } from '../../shared/types';
import { useT } from '../i18n';
import { canInstall, setupRunning } from '../sandboxSetup';
import { SandboxSetupBody, startSandboxSetup } from './SandboxSetup';
import { useDialog } from './useDialog';

interface Props {
  view: SandboxSetupView;
  onView: (v: SandboxSetupView) => void;
  /** Not now, or Install: this browser is not asked again (Settings → Sandboxes still offers it). */
  onAnswered: () => void;
  /** Closed (Escape, ×, outside, or Close once it is done): asked again on the next page load unless answered. */
  onClose: () => void;
}

/**
 * Asks, as New chat opens while the sandboxes lack something here, to install it: strongly
 * recommended, since the agents whose sandbox lacks it run no command below full access. The install
 * runs in the dialog, its output shown as in Settings.
 */
export function SandboxSetupDialog({ view, onView, onAnswered, onClose }: Props) {
  const t = useT();
  const d = t.sandboxSetup.dialog;
  const dialog = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  useDialog(dialog, onClose);

  const install = async () => {
    onAnswered();
    setStarted(true);
    setError(await startSandboxSetup(onView));
  };
  const ended = started && !setupRunning(view);

  return createPortal(
    <div className="modal-scrim" onClick={onClose}>
      <div
        ref={dialog}
        className="modal update-dialog sandbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sandbox-setup-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="sandbox-setup-title">{d.title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p>{d.body}</p>
        <SandboxSetupBody view={view} onView={onView} />
        {error && (
          <p className="small warn-text" role="alert">
            {error}
          </p>
        )}
        <footer className="update-foot">
          <span className="update-buttons">
            {ended || setupRunning(view) ? (
              <button type="button" className="ghost" onClick={onClose}>
                {d.close}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    onAnswered();
                    onClose();
                  }}
                >
                  {d.later}
                </button>
                {canInstall(view) && (
                  <button type="button" className="primary" onClick={() => void install()}>
                    {d.install}
                  </button>
                )}
              </>
            )}
          </span>
        </footer>
        <p className="muted small">{d.laterHint}</p>
      </div>
    </div>,
    document.body,
  );
}
