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
 * has it, `onSignedIn` (the share dialog creates its link again).
 */
function GhSignIn({ onSignedIn }: { onSignedIn?: () => void }) {
  const t = useT();
  const g = t.share.gh;
  const [login, setLogin] = useState<CliLoginView | null>(null);
  const [error, setError] = useState('');
  const running = login?.state === 'running';
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;

  // Asked again while it waits for GitHub, as Settings does for the CLIs' sign-ins.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      const v = await api.getGhLogin().catch(() => null);
      setLogin(v);
      if (v?.state === 'success') signedIn.current?.();
    }, 1000);
    return () => clearInterval(timer);
  }, [running]);

  const start = () => {
    setError('');
    api.startGhLogin().then(setLogin, (e: Error) => setError(e.message));
  };
  const cancel = () =>
    api
      .cancelGhLogin()
      .then(() => api.getGhLogin())
      .then(setLogin, (e: Error) => setError(e.message));

  if (login?.state === 'success') return <p className="gh-signed-in">{g.signedIn}</p>;
  return (
    <div className="gh-sign-in">
      <p>{g.signInHere}</p>
      {!running && (
        <button className="primary" onClick={start}>
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
  return (
    <div className="gh-help" role="alert">
      <strong>{missing ? g.missingTitle : g.signedOutTitle}</strong>
      <p>{missing ? g.missingIntro : g.signedOutIntro}</p>
      {!missing && <GhSignIn onSignedIn={onSignedIn} />}
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
