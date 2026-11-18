import { Fragment } from 'react';
import { useT } from '../i18n';
import { AnimatedLogo } from './Logo';

/**
 * The home page (#/): the mark in the middle and the tagline under it (in English on two lines). Chats start
 * from the sidebar's New chat.
 *
 * The mark is the Logo's drawing (Claude, Codex and Grok's dots) at 96px, its animation once on each
 * load: the dots spiral in and meet while the mark turns once (`AnimatedLogo`, styles.css `.logo-motion`).
 */
export function Home() {
  const t = useT();
  return (
    <div className="page-center">
      <div className="home-hero">
        <AnimatedLogo className="home-logo" />
        <h1 className="home-line">
          {t.home.tagline.split('\n').map((line, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              {line}
            </Fragment>
          ))}
        </h1>
      </div>
    </div>
  );
}
