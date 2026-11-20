import { Fragment } from 'react';
import type { ConversationSummary } from '../../shared/types';
import { fromHomeScreen } from '../alerts';
import { hashFor, settingsHref } from '../route';
import { useT } from '../i18n';
import { AnimatedLogo } from './Logo';

/**
 * The home page (#/): the mark in the middle and the tagline under it (in English on two lines). A new chat and a waiting team are reachable even with the sidebar closed.
 *
 * The mark is the Logo's drawing (Claude, Codex and Grok's dots) at 96px, its animation once on each
 * load: the dots spiral in and meet while the mark turns once (`AnimatedLogo`, styles.css `.logo-motion`).
 */
export function Home({ waiting, mobile }: { waiting?: ConversationSummary; mobile: boolean }) {
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
        <a className="primary home-start" data-tour="new-chat" href={hashFor({ page: 'new' })}>
          {t.home.start}
        </a>
        {waiting && (
          <a className="home-waiting" href={hashFor({ page: 'chat', id: waiting.id })}>
            {t.home.waiting(waiting.title)}
          </a>
        )}
        {mobile && !fromHomeScreen() && (
          <a className="home-waiting" data-tour="pair-phone" href={settingsHref('home-screen')}>
            {t.homeScreen.title}
          </a>
        )}
      </div>
    </div>
  );
}
