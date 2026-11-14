import { useState } from 'react';
import type { UpdateStatus } from '../../shared/types';
import { sectionId } from '../route';
import { useI18n } from '../i18n';
import { isAppWindow, updateLine } from '../update';
import { SectionTitle } from './SectionTitle';

interface Props {
  /** undefined until the server answered. */
  status?: UpdateStatus;
  /** Has the desktop app update (it asks the user first, in its own dialog). */
  onUpdate: () => Promise<void>;
}

/**
 * Settings' first card: this version, and the desktop app's updates (a newer version to update to,
 * one under way, or when it last checked). "Check again" at the top of the page checks GitHub now.
 */
export function VersionCard({ status, onUpdate }: Props) {
  const { t, lang } = useI18n();
  const v = t.settings.version;
  const [asked, setAsked] = useState<string>();
  /** Update was pressed and the server has not answered yet. */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const line = status ? updateLine(status, t, lang) : undefined;
  const offer = status?.available && !status.progress ? status.available : undefined;

  const update = async () => {
    setError('');
    setBusy(true);
    try {
      await onUpdate();
      setAsked(offer?.version);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" id={sectionId('version')}>
      <SectionTitle section="version">{v.title}</SectionTitle>
      <p className="version-current">
        <span className="muted small">{v.current}</span>
        <strong>{status?.current ?? '…'}</strong>
      </p>
      {line && (
        <div className="version-update">
          <span className={`small version-${line.tone}`} role="status">
            {line.text}
          </span>
          {offer && (
            <>
              <button type="button" className="primary small-button" disabled={busy} onClick={() => void update()}>
                {v.update}
              </button>
              <a className="small" href={offer.changes} target="_blank" rel="noopener noreferrer">
                {v.whatChanged}
              </a>
            </>
          )}
        </div>
      )}
      {offer && asked === offer.version && <p className="muted small">{isAppWindow(navigator.userAgent) ? v.confirmHere : v.confirmThere}</p>}
      {error && (
        <p className="small warn-text" role="alert">
          {error}
        </p>
      )}
      {status?.updates && <p className="muted small">{v.hint}</p>}
    </section>
  );
}
