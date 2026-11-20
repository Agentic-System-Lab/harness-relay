import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CODE_FRAGMENT } from '../../shared/auth';
import { api } from '../api';
import type { BrowserSessions } from '../browserSessions';
import { useI18n } from '../i18n';
import { CopyButton } from './CopyButton';

export function PhonePairing({ phone, onPhone }: { phone: BrowserSessions['phone']; onPhone: boolean }) {
  const { t, lang } = useI18n();
  const b = t.browsers;
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

  const installUrl = 'https://tailscale.com/download';
  const origin = code?.phoneUrl;
  const link = code ? `${origin ?? window.location.origin}/#${CODE_FRAGMENT}${code.code}` : '';

  const controls = (
    <div className="phone-pair-form">
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
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
    </div>
  );
  return onPhone ? (
    <details className="guide-pairing">
      <summary>{b.phoneTitle[phone]}</summary>
      {controls}
    </details>
  ) : (
    <div className="guide-pairing">
      {(phone === 'paired' || phone === 'online') && <h4>{b.phoneTitle[phone]}</h4>}
      {controls}
    </div>
  );
}
