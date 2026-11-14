import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { useDialog } from './useDialog';

interface Props {
  version: string;
  current: string;
  /** Where what changed since the running version is read (GitHub's comparison of the two versions). */
  changes: string;
  /** Has the desktop app update (it asks the user first, in its own dialog). */
  onUpdate: () => Promise<void>;
  /** Later: this version is not offered again with a dialog (Settings still offers it). */
  onLater: () => void;
  /** Closed otherwise (Escape, ×, outside): not offered again while the page is open, but next time. */
  onClose: () => void;
}

/**
 * Offers a newer version of the desktop app, once per version, in the app's own window (src/web/update.ts,
 * `shouldOffer`). The tray menu offers it as before.
 */
export function UpdateDialog({ version, current, changes, onUpdate, onLater, onClose }: Props) {
  const t = useT();
  const u = t.update;
  const dialog = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Escape may be a reflex: it closes the dialog for now, without dismissing the version for good (Later does).
  useDialog(dialog, onClose);

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
    <div className="modal-scrim" onClick={onClose}>
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
          <button type="button" className="icon-button" onClick={onClose} aria-label={t.common.close}>
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
          <a className="small" href={changes} target="_blank" rel="noopener noreferrer">
            {u.whatChanged}
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
