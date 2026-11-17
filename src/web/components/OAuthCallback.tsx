import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { CALLBACK_PATH, callbackFrom } from '../oauth';
import { Logo } from './Logo';

/** What the provider's page sent the browser back with, read once, when the page loads. */
const GOT = callbackFrom(location.search);
let posting: ReturnType<typeof api.oauthCallback> | undefined;

/**
 * The page an OAuth provider's sign-in sends the browser back to (`/oauth/callback`): it posts the code
 * and state it got to the server, which finishes the sign-in, and says how it went. It needs no
 * sign-in of its own (the state is the proof): in the desktop app it opens in the system browser, and
 * a browser that started the sign-in elsewhere sees the account in Settings. Posted once for both runs
 * of the effect in development; the address then loses its code and state.
 */
export function OAuthCallback() {
  const t = useT();
  const c = t.oauthCallback;
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    history.replaceState(null, '', CALLBACK_PATH);
    posting ??= api.oauthCallback(GOT);
    let live = true;
    posting.then(
      (r) =>
        live && setResult(r.status === 'done' ? { ok: true, text: c.done(r.email ?? '') } : { ok: false, text: c.failed(r.error ?? '') }),
      (e: Error) => live && setResult({ ok: false, text: c.failed(e.message) }),
    );
    return () => {
      live = false;
    };
  }, [c]);

  return (
    <main className="signin oauth-callback">
      <section className="card signin-card">
        <header className="signin-head">
          <Logo size={32} />
          <h1>{c.title}</h1>
        </header>
        <p className={result ? (result.ok ? '' : 'error-line') : 'muted'} role="status">
          {result?.text ?? c.working}
        </p>
        {result && (
          <p className="small muted">
            {result.ok ? `${c.close} ` : ''}
            <a href="/#/settings/tools">{c.back}</a>
          </p>
        )}
      </section>
    </main>
  );
}
