import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { useT } from '../i18n';
import { CALLBACK_PATH, callbackFrom, callbackOutcome, type CallbackAnswer, type CallbackOutcome } from '../oauth';
import { CopyButton } from './CopyButton';
import { Logo } from './Logo';

/** What the provider's page sent the browser back with, read once, when the page loads. */
const GOT = callbackFrom(location.search);
/** The whole address it came to: to paste into the Harness Relay that started the sign-in, when that is not this one. */
const ADDRESS = location.href;
let posting: Promise<CallbackAnswer> | undefined;

/**
 * The page an OAuth provider's sign-in sends the browser back to (`/oauth/callback`): it posts the code
 * and state it got to the server, which finishes the sign-in, and says how it went. It needs no
 * sign-in of its own (the state is the proof): in the desktop app it opens in the system browser, and
 * a browser that started the sign-in elsewhere sees the account in Settings. Posted once for both runs
 * of the effect in development. The address loses its code and state once a sign-in here answered;
 * when none here has them (it is over: ended a while ago, or lost when the server restarted; or another
 * computer's Harness Relay started it), the page says so and shows the address to copy and paste there.
 */
export function OAuthCallback() {
  const t = useT();
  const c = t.oauthCallback;
  const [outcome, setOutcome] = useState<CallbackOutcome>();

  useEffect(() => {
    posting ??= api.oauthCallback(GOT).then(
      (r): CallbackAnswer => ({ ok: true, ...r }),
      (e: unknown): CallbackAnswer => ({ ok: false, httpStatus: e instanceof ApiError ? e.status : 0, error: (e as Error).message }),
    );
    let live = true;
    void posting.then((answer) => {
      if (!live) return;
      const shown = callbackOutcome(answer, Boolean(GOT.state));
      if (shown.clearAddress) history.replaceState(null, '', CALLBACK_PATH);
      setOutcome(shown.outcome);
    });
    return () => {
      live = false;
    };
  }, []);

  const text = !outcome
    ? c.working
    : outcome.kind === 'done'
      ? c.done(outcome.email)
      : outcome.kind === 'failed'
        ? c.failed(outcome.error)
        : c.elsewhere;
  return (
    <main className="signin oauth-callback">
      <section className="card signin-card">
        <header className="signin-head">
          <Logo size={32} />
          <h1>{c.title}</h1>
        </header>
        <p className={outcome ? (outcome.kind === 'done' ? '' : 'error-line') : 'muted'} role="status">
          {text}
        </p>
        {outcome?.kind === 'elsewhere' && (
          <p className="oauth-callback-address">
            <code>{ADDRESS}</code> <CopyButton text={() => ADDRESS} className="ghost small-button" />
          </p>
        )}
        {outcome && (
          <p className="small muted">
            {outcome.kind === 'done' ? `${c.close} ` : ''}
            <a href="/#/settings/tools">{c.back}</a>
          </p>
        )}
      </section>
    </main>
  );
}
