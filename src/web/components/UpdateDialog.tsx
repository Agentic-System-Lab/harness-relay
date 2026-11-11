import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { useDialog } from './useDialog';

interface Props {
  version: string;
  current: string;
  /** The release's page on GitHub. */
  page: string;
  /** Has the desktop app update (it asks the user first, in its own dialog). */
  onUpdate: () => Promise<void>;
  /** Later: this version is not offered again with a dialog (Settings still offers it). */
  onLater: () => void;
}

/**
 * Offers a newer version of the desktop app, once per version, in the app's own window (src/web/update.ts,
 * `shouldOffer`). The tray menu offers it as before.
 */
export function UpdateDialog({ version, current, page, onUpdate, onLater }: Props) {
  const t = useT();
  const u = t.update;
  const dialog = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useDialog(dialog, onLater);

  const update = async () => {
    setBusy(true);
    setError('');
    try {
      await onUpdate();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-scrim" onClick={onLater}>
      <div
        ref={dialog}
        className="modal update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id="update-title">{u.title}</h2>
          <button type="button" className="icon-button" onClick={onLater} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <p>{u.body(version, current)}</p>
        <p className="muted small">{u.hint}</p>
        {error && (
          <p className="small warn-text" role="alert">
            {error}
          </p>
        )}
        <footer className="update-foot">
          <a className="small" href={page} target="_blank" rel="noopener noreferrer">
            {u.releaseNotes}
          </a>
          <span className="update-buttons">
            <button type="button" className="ghost" onClick={onLater}>
              {u.later}
            </button>
            <button type="button" className="primary" disabled={busy} onClick={() => void update()}>
              {u.update}
            </button>
          </span>
        </footer>
        <p className="muted small">{u.laterHint}</p>
      </div>
    </div>,
    document.body,
  );
}
