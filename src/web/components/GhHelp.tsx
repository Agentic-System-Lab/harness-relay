import { GH_MIN_VERSION, GH_MISSING, GH_SIGNED_OUT } from '../../shared/types';
import { useT } from '../i18n';
import { GH_INSTALL, GH_LINKS } from '../share';
import { CopyButton } from './CopyButton';
import { CopyIcon } from './icons';

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
 * What to do when the GitHub CLI that creates and removes shared links cannot be used: install it
 * (`GH_MISSING`) and sign in, or only sign in (`GH_SIGNED_OUT`). `retry`: how to try again afterwards.
 */
export function GhHelp({ problem, retry }: { problem: typeof GH_MISSING | typeof GH_SIGNED_OUT; retry: string }) {
  const g = useT().share.gh;
  const missing = problem === GH_MISSING;
  return (
    <div className="gh-help" role="alert">
      <strong>{missing ? g.missingTitle : g.signedOutTitle}</strong>
      <p>{missing ? g.missingIntro : g.signedOutIntro}</p>
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
          {g.login}
          <Command text="gh auth login" /> <Link href={GH_LINKS.login}>{g.loginHelp}</Link>
          <br />
          {g.noAccount} <Link href={GH_LINKS.signup}>{g.signup}</Link>
        </li>
        <li>{retry}</li>
      </ol>
      {missing && <p className="muted small">{g.restart}</p>}
    </div>
  );
}
