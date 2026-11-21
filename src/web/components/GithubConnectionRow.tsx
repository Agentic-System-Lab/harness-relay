import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { GithubConnection } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { AppRow } from './AppRow';
import { AppDependencyInstall } from './AppDependencyInstall';
import { GhSignIn } from './GhHelp';

export function GithubConnectionRow({ access }: { access: ReactNode }) {
  const t = useT();
  const a = t.apps;
  const [account, setAccount] = useState<GithubConnection>();
  const [error, setError] = useState('');
  const [signedOut, setSignedOut] = useState('');
  const [busy, setBusy] = useState(false);
  const signOutButton = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (busy || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (document.activeElement === document.body) (signOutButton.current ?? retryButton.current)?.focus();
  }, [busy]);
  const check = useRef(0);
  const refresh = async () => {
    const id = ++check.current;
    try {
      const current = await api.githubStatus();
      if (id === check.current) setAccount(current);
    } catch (e) {
      if (id === check.current) {
        setAccount(undefined);
        setError((e as Error).message);
      }
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      check.current++;
    };
  }, []);

  const signOut = async (login: string) => {
    if (!window.confirm(a.ghConfirmSignOut(login))) return;
    restoreFocus.current = document.activeElement === signOutButton.current;
    setBusy(true);
    setError('');
    setSignedOut('');
    try {
      await api.githubSignOut(login);
      setSignedOut(login);
      setAccount(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  const token = account?.status !== 'missing' && account?.tokenSource;
  return (
    <AppRow
      name="GitHub"
      description={a.details.github}
      label={account?.status === 'connected' ? a.manage : a.options}
      status={account?.status === 'connected' ? account.login + ' · ' + t.connectors.oauth.connected : undefined}
    >
      {signedOut && <p role="status">{a.ghSignedOut(signedOut)}</p>}
      {token ? (
        <p className="muted small">{a.ghToken(token)}</p>
      ) : account?.status === 'connected' ? (
        <button ref={signOutButton} className="ghost small-button" disabled={busy} onClick={() => void signOut(account.login)}>
          {a.ghSignOut}
        </button>
      ) : account?.status === 'missing' ? (
        <AppDependencyInstall name="github" onReady={refresh} />
      ) : account?.status === 'signed-out' ? (
        <GhSignIn
          onSignedIn={() => {
            setSignedOut('');
            setError('');
            void refresh();
          }}
        />
      ) : (
        !error && t.common.loading
      )}
      {error && <p role="alert">{error}</p>}
      {error && (
        <button
          ref={retryButton}
          className="ghost small-button"
          disabled={busy}
          onClick={() => {
            setError('');
            void refresh();
          }}
        >
          {a.checkAgain}
        </button>
      )}
      {access}
    </AppRow>
  );
}
