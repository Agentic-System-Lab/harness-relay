import { useEffect, useState } from 'react';
import { CODE_FRAGMENT } from '../../shared/auth';
import type { AuthSessionView } from '../../shared/types';
import { api } from '../api';
import { useI18n } from '../i18n';
import { sectionId } from '../route';
import { CopyButton } from './CopyButton';
import { SectionTitle } from './SectionTitle';

/**
 * The browsers signed in to Harness Relay, the latest used first: sign out the ones no longer used,
 * and give another device (a phone) a one-time code to sign in with.
 */
export function BrowsersCard() {
  const { t, lang } = useI18n();
  const b = t.browsers;
  const [list, setList] = useState<AuthSessionView[] | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.signedInBrowsers().then(setList, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const when = (ms: number) => new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });

  const addDevice = async () => {
    setBusy(true);
    setError('');
    try {
      setCode(await api.newSignInCode());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (s: AuthSessionView) => {
    if (!confirm(s.current ? b.confirmCurrent : b.confirm(s.label))) return;
    setBusy(true);
    setError('');
    try {
      await api.signOut(s.id, s.current);
      // This browser: the sign-in page; another one: gone from the list.
      if (s.current) window.location.reload();
      else await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const link = code ? `${window.location.origin}/#${CODE_FRAGMENT}${code.code}` : '';

  return (
    <section className="card" id={sectionId('browsers')}>
      <SectionTitle section="browsers">{b.title}</SectionTitle>
      <p className="muted small">{b.hint}</p>
      {list === null ? (
        !error && <p className="muted small">{t.common.loading}</p>
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
      <div className="card-actions">
        <button type="button" className="ghost small-button" disabled={busy} onClick={() => void addDevice()}>
          {b.add}
        </button>
      </div>
      {code && (
        <div className="browsers-code">
          <p className="small">{b.codeHint(new Date(code.expiresAt).toLocaleTimeString(lang, { timeStyle: 'short' }))}</p>
          <p className="browsers-code-value">
            <code>{code.code}</code> <CopyButton text={() => code.code} className="ghost small-button" />
          </p>
          <p className="small">
            {b.link} <code className="browsers-code-link">{link}</code> <CopyButton text={() => link} className="ghost small-button" />
          </p>
        </div>
      )}
      {error && <p className="error-line">{error}</p>}
    </section>
  );
}
