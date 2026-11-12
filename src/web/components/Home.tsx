import { Fragment } from 'react';
import { useT } from '../i18n';

/**
 * The home page (#/): the mark in the middle and the tagline under it (in English on two lines). Chats start
 * from the sidebar's New chat.
 *
 * The mark is the Logo's drawing (Claude, Codex and Grok's dots) at 96px, made of three elements rather
 * than an SVG so that its animation, once on each load, runs on the compositor: the dots spiral in and
 * meet while the mark turns once, with transform and opacity alone (styles.css, `.home-logo`).
 */
export function Home() {
  const t = useT();
  return (
    <div className="page-center">
      <div className="home-hero">
        <div className="home-logo" aria-hidden="true">
          <div className="home-logo-orbit">
            <span className="home-dot home-dot-claude" />
            <span className="home-dot home-dot-codex" />
            <span className="home-dot home-dot-grok" />
          </div>
        </div>
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
