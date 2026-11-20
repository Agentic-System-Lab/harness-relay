import { useState } from 'react';
import { isIos } from '../alerts';
import { useT } from '../i18n';
import { sectionId, settingsHref } from '../route';
import { DownloadIcon, PlusIcon, ShareIcon } from './icons';
import { Logo } from './Logo';
import { SectionTitle } from './SectionTitle';

/** Zoomed-in illustrations of the controls on the phone. The captions describe every action. */
export function HomeScreenGuide() {
  const t = useT().homeScreen;
  const android = /Android/.test(navigator.userAgent);
  const [platform, setPlatform] = useState<'ios' | 'android'>(android ? 'android' : 'ios');
  const ios = platform === 'ios';
  const steps = t[platform];
  return (
    <section className="card home-screen-guide" id={sectionId('home-screen')}>
      <SectionTitle section="home-screen">{t.title}</SectionTitle>
      <div className="guide-platforms" role="group" aria-label={t.platform}>
        <button type="button" aria-pressed={ios} onClick={() => setPlatform('ios')}>
          iPhone · Safari
        </button>
        <button type="button" aria-pressed={!ios} onClick={() => setPlatform('android')}>
          Android · Chrome
        </button>
      </div>
      <ol className="guide-steps" key={platform}>
        <li>
          <div className={'guide-frame guide-browser ' + platform} aria-hidden="true">
            <div className="guide-site">
              <Logo size={23} />
              <b>Harness Relay</b>
            </div>
            <div className="guide-bar">
              <span>https://…ts.net</span>
              <i className="guide-target">{ios ? <ShareIcon size={19} /> : '⋮'}</i>
            </div>
          </div>
          <strong>{steps.menu}</strong>
          <p>{steps.menuHint}</p>
        </li>
        <li>
          <div className={'guide-frame guide-sheet ' + platform} aria-hidden="true">
            <div className="guide-choice">
              {ios ? <PlusIcon size={16} /> : <DownloadIcon size={16} />}
              <b>{steps.action}</b>
            </div>
            <div className="guide-confirm">
              <span>Harness Relay</span>
              <b className="guide-target">{steps.confirm}</b>
            </div>
          </div>
          <strong>{steps.install}</strong>
          <p>{steps.installHint}</p>
        </li>
        <li>
          <div className="guide-frame guide-launch" aria-hidden="true">
            <div className="guide-apps">
              <span />
              <img src="/icons/icon-192.png" width="42" height="42" alt="" />
              <span />
            </div>
            <b>Harness Relay</b>
          </div>
          <strong>{steps.launch}</strong>
          <p>{steps.launchHint}</p>
        </li>
      </ol>
      <div className="guide-notifications">
        <h4>{t.notifications}</h4>
        <p className="small">{steps.notify}</p>
        {(android || isIos(navigator)) && (
          <a className="small" href={settingsHref('notifications')}>
            {t.openNotifications}
          </a>
        )}
      </div>
    </section>
  );
}
