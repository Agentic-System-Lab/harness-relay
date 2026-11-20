import { useState } from 'react';
import type { AuthSessionView } from '../../shared/types';
import { api } from '../api';
import type { BrowserSessions } from '../browserSessions';
import { useI18n } from '../i18n';
import { sectionId } from '../route';
import { SectionTitle } from './SectionTitle';

/** Manage the sessions that can operate this computer. */
export function BrowsersCard({ browsers }: { browsers: BrowserSessions }) {
  const { t, lang } = useI18n();
  const b = t.browsers;
  const { sessions: list, error: loadError, refresh } = browsers;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const when = (ms: number) => new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });

  const signOut = async (s: AuthSessionView) => {
    if (!confirm(s.current ? b.confirmCurrent : b.confirm(s.label))) return;
    setBusy(true);
    setError('');
    try {
      await api.signOut(s.id, s.current);
      // This browser: the sign-in page; another one: gone from the list.
      if (s.current) window.location.reload();
      else await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" id={sectionId('browsers')}>
      <SectionTitle section="browsers">{b.title}</SectionTitle>
      <p className="muted small">{b.hint}</p>
      {list === null ? (
        !loadError && <p className="muted small">{t.common.loading}</p>
      ) : (
        <ul className="share-list">
          {list.map((s) => (
            <li key={s.id} className="share-row">
              <div className="share-row-text">
                <span className="share-row-title">
                  {s.label}
                  {s.current && <span className="muted small"> · {b.current}</span>}
                </span>
                <span className="muted small">{b.used(when(s.createdAt), when(s.lastUsedAt))}</span>
              </div>
              <button type="button" className="ghost small-button danger" disabled={busy} onClick={() => void signOut(s)}>
                {b.signOut}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(error || loadError) && <p className="error-line">{error || loadError}</p>}
    </section>
  );
}
