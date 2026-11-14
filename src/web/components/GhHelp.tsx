import { useEffect, useRef, useState } from 'react';
import { GH_MIN_VERSION, GH_MISSING, GH_SIGNED_OUT, type CliLoginView } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { GH_INSTALL, GH_LINKS, ghLoginCommand } from '../share';
import { CopyButton } from './CopyButton';
import { CopyIcon } from './icons';
import { LoginLinks, LoginOutput } from './LoginLinks';

/** A command to type in a terminal, with a button that copies it. */
function Command({ text }: { text: string }) {
  return (
    <span className="gh-command">
      <code>{text}</code>
      <CopyButton className="icon-button gh-copy" iconOnly icon={<CopyIcon size={14} />} text={() => text} />
    </span>
  );
}

function Link({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/**
 * gh's own sign-in, run from here on the computer that runs Harness Relay (`/api/gh/login`): GitHub's
 * code and the page to enter it on, without a terminal (a phone, a codespace, a server). Once GitHub
 * has it, `onSignedIn`, once (the share dialog creates its link again).
 */
function GhSignIn({ onSignedIn }: { onSignedIn?: () => void }) {
  const t = useT();
  const g = t.share.gh;
  const [login, setLogin] = useState<CliLoginView | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const running = login?.state === 'running';
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;
  const told = useRef(false);

  // A sign-in still waiting from before (the dialog opened again, or this help shown again after
  // another try): its code goes on showing, rather than a new sign-in replacing it.
  useEffect(() => {
    let gone = false;
    api.getGhLogin().then(
      // Never over one started here meanwhile.
      (v) => !gone && v?.state === 'running' && setLogin((cur) => cur ?? v),
      () => {},
    );
    return () => {
      gone = true;
    };
  }, []);

  // Asked again while it waits for GitHub, each time once the last answer is in (on a slow network
  // answers would otherwise pile up). A failed ask keeps what was shown and asks again.
  useEffect(() => {
    if (!running) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      const v = await api.getGhLogin().catch(() => undefined);
      if (gone) return;
      if (v !== undefined) setLogin(v);
      if (v?.state === 'success' && !told.current) {
        told.current = true;
        signedIn.current?.();
      }
      if (v === undefined || v?.state === 'running') timer = setTimeout(ask, 1000);
    };
    timer = setTimeout(ask, 1000);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [running]);

  const start = () => {
    setError('');
    told.current = false;
    setStarting(true);
    api
      .startGhLogin()
      .then(setLogin, (e: Error) => setError(e.message))
      .finally(() => setStarting(false));
  };
  const cancel = () =>
    api
      .cancelGhLogin()
      .then(() => api.getGhLogin())
      .then(setLogin, (e: Error) => setError(e.message));

  return (
    <div className="gh-sign-in">
      <p>{g.signInHere}</p>
      <p className="muted small">{g.signInScope}</p>
      {!running && (
        <button className="primary" onClick={start} disabled={starting}>
          {g.signIn}
        </button>
      )}
      {login && (
        <div className={`login-panel ${login.state}`}>
          <div className="login-state">
            {running && <span className="pulse" />}
            <strong>{t.settings.loginState[login.state]}</strong>
            {running && (
              <button className="ghost small-button" onClick={cancel}>
                {t.common.cancel}
              </button>
            )}
          </div>
          <LoginLinks login={login} />
          {login.state === 'failed' && <LoginOutput login={login} />}
        </div>
      )}
      {error && <p className="error-line">{error}</p>}
    </div>
  );
}

/**
 * What to do when the GitHub CLI that creates and removes shared links cannot be used: install it
 * (`GH_MISSING`) and sign in, or only sign in (`GH_SIGNED_OUT`), here or in a terminal. `retry`: how
 * to try again afterwards; `onSignedIn`: what to do once signed in here.
 */
export function GhHelp({
  problem,
  retry,
  onSignedIn,
}: {
  problem: typeof GH_MISSING | typeof GH_SIGNED_OUT;
  retry: string;
  onSignedIn?: () => void;
}) {
  const g = useT().share.gh;
  const missing = problem === GH_MISSING;
  const [signedIn, setSignedIn] = useState(false);
  // Signed in here: the help says so and how to go on, no longer that gh is signed out (the share
  // dialog goes on by itself, and this help goes with it).
  if (signedIn) {
    return (
      <div className="gh-help" role="status">
        <p className="gh-signed-in">{g.signedIn}</p>
        <p>{retry}</p>
      </div>
    );
  }
  return (
    <div className="gh-help" role="alert">
      <strong>{missing ? g.missingTitle : g.signedOutTitle}</strong>
      <p>{missing ? g.missingIntro : g.signedOutIntro}</p>
      {!missing && (
        <GhSignIn
          onSignedIn={() => {
            setSignedIn(true);
            onSignedIn?.();
          }}
        />
      )}
      <ol>
        {missing && (
          <li>
            {g.install(GH_MIN_VERSION)}
            <Link href={GH_LINKS.site}>{g.installSite}</Link>
            {g.installOr}
            <ul>
              <li>
                macOS: <Command text={GH_INSTALL.macos} />
              </li>
              <li>
                Windows: <Command text={GH_INSTALL.windows} />
              </li>
              <li>
                Linux: <Link href={GH_LINKS.linux}>{g.linuxGuide}</Link>
              </li>
            </ul>
          </li>
        )}
        <li>
          {missing ? g.login : g.orTerminal}
          <Command text={ghLoginCommand(location.hostname)} /> <Link href={GH_LINKS.login}>{g.loginHelp}</Link>
          <br />
          {g.noAccount} <Link href={GH_LINKS.signup}>{g.signup}</Link>
        </li>
        <li>{retry}</li>
      </ol>
      {missing && <p className="muted small">{g.restart}</p>}
    </div>
  );
}
