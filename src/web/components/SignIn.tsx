import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { Logo } from './Logo';

/**
 * Shown while this browser is not signed in: a one-time code signs it in, from the link the server
 * printed in its terminal (which fills it in by itself), `npm run login`, or a browser already
 * signed in (for a phone).
 */
export function SignIn({ error, desktopApp, onSignedIn }: { error?: string; desktopApp?: boolean; onSignedIn: () => void }) {
  const t = useT();
  const s = t.signIn;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(error ?? '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setNote('');
    try {
      await api.signIn(code);
      onSignedIn();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="signin">
      <section className="card signin-card">
        <header className="signin-head">
          <Logo size={32} />
          <h1>{s.title}</h1>
        </header>
        <p>{s.intro}</p>
        <form className="signin-form" onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span>{s.codeLabel}</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ABCD-EFGH"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
            />
          </label>
          <button type="submit" className="primary" disabled={busy || !code.trim()}>
            {busy ? s.signingIn : s.submit}
          </button>
        </form>
        {note && (
          <p className="danger-text" role="alert">
            {note}
          </p>
        )}
        <h2>{s.whereTitle}</h2>
        <ul className="signin-where">
          {desktopApp ? (
            // The desktop app has no terminal: its menu opens a new sign-in link.
            <li>{s.whereDesktop}</li>
          ) : (
            <>
              <li>{s.whereTerminal}</li>
              <li>
                {s.whereLogin} <code>npm run login</code>
              </li>
            </>
          )}
          <li>{s.whereOther}</li>
        </ul>
      </section>
    </main>
  );
}
