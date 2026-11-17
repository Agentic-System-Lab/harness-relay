import { useEffect, useRef, useState } from 'react';
import type { McpServerView, OAuthSignInView, ToolLibraryView } from '../../shared/types';
import { ApiError, api } from '../api';
import { useI18n } from '../i18n';
import { mcpSignInLine, waiting } from '../oauth';
import { openSignInPage, SignInWaiting, useFollowSignIn } from './OAuthAccounts';

/**
 * An HTTP MCP server's own sign-in, in its row of Settings → Tool library → MCP servers (MCP's
 * authorization: the server and its authorization server say where it signs in). The server runs the
 * sign-in, as it does an account's: this starts it (the authorization server's page in a new tab, in the
 * desktop app in the system browser), follows it, takes a pasted address when that page cannot come back
 * here, and shows its state: signed in (since when), or needing a new sign-in. No token ever comes here.
 * `change`: runs a call that answers the library, and shows it (or its error).
 */
export function McpSignIn({
  server,
  change,
}: {
  server: McpServerView;
  change: (call: () => Promise<ToolLibraryView>) => Promise<boolean>;
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
      setInfo(m.done(server.name));
      void change(() => api.tools());
    } else setError(ended.error ?? '');
    setSignIn(undefined);
  }, [ended, m, server.name, change]);

  const start = async () => {
    setError('');
    setInfo('');
    setBusy(true);
    try {
      const v = await api.startMcpSignIn(server.name);
      setSignIn(v);
      if (v.authorizeUrl && !openSignInPage(v.authorizeUrl)) setError(t.connectors.oauth.popupBlocked);
    } catch (e) {
      // One that asks for no sign-in says so: news, not trouble.
      if (e instanceof ApiError && e.code === 'mcp-no-sign-in') setInfo(e.message);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (!confirm(m.confirmSignOut(server.name))) return;
    setError('');
    if (await change(() => api.signOutMcp(server.name))) setInfo(m.signedOut(server.name));
  };

  const line = mcpSignInLine(server.oauth, t, lang);
  const under = Boolean(signIn && waiting(signIn));
  return (
    <div className="mcp-signin">
      <div className="mcp-signin-row">
        {line && <span className={`small ${line.warn ? 'warn-text' : 'muted'}`}>{line.text}</span>}
        <div className="lib-row-actions">
          <button type="button" className="ghost small-button" disabled={busy || under} onClick={() => void start()}>
            {server.oauth ? m.signInAgain : m.signIn}
          </button>
          {server.oauth && (
            <button type="button" className="ghost small-button" disabled={under} onClick={() => void signOut()}>
              {m.signOut}
            </button>
          )}
        </div>
      </div>
      {signIn && under && <SignInWaiting signIn={signIn} label={server.name} onChange={setSignIn} onError={setError} />}
      {error && <p className="error-line">{error}</p>}
      {info && <p className="small ok-text">{info}</p>}
    </div>
  );
}
