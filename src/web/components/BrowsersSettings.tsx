import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CODE_FRAGMENT } from '../../shared/auth';
import type { AuthSessionView } from '../../shared/types';
import { api } from '../api';
import type { BrowserSessions } from '../browserSessions';
import { useI18n } from '../i18n';
import { sectionId, settingsHref } from '../route';
import { CopyButton } from './CopyButton';
import { SectionTitle } from './SectionTitle';

/**
 * The browsers signed in to Harness Relay, the latest used first: sign out the ones no longer used,
 * and give another device (a phone) a one-time code to sign in with.
 */
export function BrowsersCard({ browsers }: { browsers: BrowserSessions }) {
  const { t, lang } = useI18n();
  const b = t.browsers;
  const { sessions: list, phone, error: loadError, refresh } = browsers;
  const [code, setCode] = useState<{ code: string; expiresAt: number; phoneUrl?: string }>();
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!code) return;
    const expire = () => {
      if (Date.now() >= code.expiresAt) {
        setCode(undefined);
        setExpired(true);
      }
    };
    const timer = window.setTimeout(expire, Math.max(0, code.expiresAt - Date.now()));
    document.addEventListener('visibilitychange', expire);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', expire);
    };
  }, [code]);

  const when = (ms: number) => new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });

  const addDevice = async () => {
    setBusy(true);
    setError('');
    try {
      setCode(await api.newSignInCode());
      setExpired(false);
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
      else await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const installUrl = 'https://tailscale.com/download';
  const origin = code?.phoneUrl;
  const link = code ? `${origin ?? window.location.origin}/#${CODE_FRAGMENT}${code.code}` : '';

  return (
    <section className="card" id={sectionId('browsers')}>
      <SectionTitle section="browsers">{b.title}</SectionTitle>
      <h4 className="phone-pair-title">{b.phoneTitle[phone]}</h4>
      {(phone === 'paired' || phone === 'online') && (
        <p role="status" className="muted small">
          {b.phoneDetail[phone]}
        </p>
      )}
      <details className="phone-setup">
        <summary>{b.install}</summary>
        <p>{b.setup}</p>
        <QRCodeSVG value={installUrl} size={176} marginSize={4} title={b.install} role="img" />
        <p>
          <a href={installUrl} target="_blank" rel="noreferrer">
            {b.download}
          </a>
        </p>
      </details>
      <p className="muted small">{b.ready}</p>
      <div className="card-actions">
        <button type="button" className="ghost small-button" disabled={busy} onClick={() => void addDevice()}>
          {b.add}
        </button>
      </div>
      {expired && (
        <p role="status" className="muted small">
          {b.expired}
        </p>
      )}
      {code && (
        <div className="browsers-code" aria-live="polite">
          {origin ? <QRCodeSVG value={link} size={208} marginSize={4} title={b.scan} role="img" /> : <p>{b.local}</p>}
          <p className="small">{b.codeHint(new Date(code.expiresAt).toLocaleTimeString(lang, { timeStyle: 'short' }))}</p>
          <p className="browsers-code-value">
            <code>{code.code}</code> <CopyButton text={() => code.code} className="ghost small-button" />
          </p>
          <p className="small">
            {origin || location.protocol === 'https:' ? b.link : b.localLink} <code className="browsers-code-link">{link}</code>{' '}
            <CopyButton text={() => link} className="ghost small-button" />
          </p>
        </div>
      )}
      <p className="small">
        <a href={settingsHref('home-screen')}>{t.homeScreen.title}</a>
      </p>
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
