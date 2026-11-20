import { useEffect, useRef, useState } from 'react';
import { isSlackMcp } from '../../shared/apps';
import type { McpServerView, OAuthSignInView, ToolLibraryView } from '../../shared/types';
import { ApiError, api } from '../api';
import { useI18n, useT } from '../i18n';
import { settingsHref } from '../route';
import { confirmLines, mcpSignInLine, waiting } from '../oauth';
import { openPendingTab, showSignInPage, SignInWaiting, useFollowSignIn } from './OAuthAccounts';

/**
 * An HTTP MCP server's own sign-in, in its row of Settings → Tool library → MCP servers (MCP's
 * authorization: the server and its authorization server say where it signs in). The server runs the
 * sign-in, as it does an account's: this starts it (the authorization server's page in a tab opened on
 * the click, navigated once the server answers; in the desktop app in the system browser), follows it,
 * takes a pasted address when that page cannot come back here, and shows its state: signed in (since
 * when), or needing a new sign-in. A sign-in whose page (or token endpoint) is not on its authorization
 * server's own host first says where, and opens only on Continue. No token ever comes here.
 * `change`: runs a call that answers the library, and shows it (or its error).
 */
export function McpSignIn({
  server,
  change,
}: {
  server: McpServerView;
  change: (call: () => Promise<ToolLibraryView>) => Promise<boolean>;
}) {
  const t = useT();
  if (!server.oauth && (server.app === 'slack' || isSlackMcp(server.url))) {
    return <a href={settingsHref('apps')}>{t.apps.slackInApps}</a>;
  }
  return (
    <AppSignIn
      name={server.name}
      oauth={server.oauth}
      startRequest={() => api.startMcpSignIn(server.name)}
      onDone={() => change(() => api.tools())}
      onSignOut={() => change(() => api.signOutMcp(server.name))}
    />
  );
}

export function AppSignIn({
  name,
  oauth,
  startRequest,
  onDone,
  onSignOut,
  button,
}: {
  name: string;
  oauth?: McpServerView['oauth'];
  startRequest?: () => Promise<OAuthSignInView>;
  onDone: () => Promise<unknown>;
  onSignOut?: () => Promise<boolean>;
  button?: string;
}) {
  const { t, lang } = useI18n();
  const m = t.tools.signIn;
  const [signIn, setSignIn] = useState<OAuthSignInView>();
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  useFollowSignIn(signIn, setSignIn, setError);
  const ended = signIn && !waiting(signIn) ? signIn : undefined;
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!ended || shown.current === ended.id) return;
    shown.current = ended.id;
    if (ended.status === 'done') {
      setInfo(m.done(ended.account?.email ?? name));
      void onDone().catch((e: Error) => setError(e.message));
    } else setError(ended.error ?? '');
    setSignIn(undefined);
  }, [ended, m, name, onDone]);

  /** Opens a tab on the click, runs `call`, and shows the page it answers in that tab (closed when there is none to show). */
  const withPage = async (call: () => Promise<OAuthSignInView>) => {
    setError('');
    setInfo('');
    setBusy(true);
    const tab = openPendingTab();
    try {
      const v = await call();
      setSignIn(v);
      if (v.authorizeUrl && !v.confirm) {
        if (!showSignInPage(tab, v.authorizeUrl)) setError(t.connectors.oauth.popupBlocked);
      } else tab?.close();
    } catch (e) {
      tab?.close();
      // One that asks for no sign-in says so: news, not trouble.
      if (e instanceof ApiError && e.code === 'mcp-no-sign-in') setInfo(e.message);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Its page is on another host than its authorization server's: Continue opens it, once the server records it.
  const proceed = (id: string) => withPage(() => api.confirmOAuthSignIn(id));
  const cancel = async (id: string) => {
    await api.cancelOAuthSignIn(id).catch(() => undefined);
    setSignIn(undefined);
  };

  const signOut = async () => {
    if (!confirm(m.confirmSignOut(name))) return;
    setError('');
    if (await onSignOut?.()) setInfo(m.signedOut(name));
  };

  const line = mcpSignInLine(oauth, t, lang);
  const under = Boolean(signIn && waiting(signIn));
  const asking = under && signIn?.confirm ? signIn : undefined;
  return (
    <div className="mcp-signin">
      <div className="mcp-signin-row">
        {line && <span className={`small ${line.warn ? 'warn-text' : 'muted'}`}>{line.text}</span>}
        <div className="lib-row-actions">
          {startRequest && (
            <button type="button" className="ghost small-button" disabled={busy || under} onClick={() => void withPage(startRequest)}>
              {button ?? (oauth ? m.signInAgain : m.signIn)}
            </button>
          )}
          {oauth && onSignOut && (
            <button type="button" className="ghost small-button" disabled={under} onClick={() => void signOut()}>
              {m.signOut}
            </button>
          )}
        </div>
      </div>
      {asking?.confirm && (
        <div className="oauth-waiting mcp-confirm" role="alert">
          {confirmLines(asking.confirm, t).map((l) => (
            <p key={l} className="small warn-text">
              {l}
            </p>
          ))}
          <p className="small muted">{m.confirmHint}</p>
          <div className="form-actions">
            <button type="button" className="ghost small-button" onClick={() => void cancel(asking.id)}>
              {t.connectors.oauth.cancel}
            </button>
            <button type="button" className="primary small-button" disabled={busy} onClick={() => void proceed(asking.id)}>
              {m.confirmContinue}
            </button>
          </div>
        </div>
      )}
      {signIn && under && !asking && <SignInWaiting signIn={signIn} label={name} onChange={setSignIn} onError={setError} />}
      {error && <p className="error-line">{error}</p>}
      {info && <p className="small ok-text">{info}</p>}
    </div>
  );
}
