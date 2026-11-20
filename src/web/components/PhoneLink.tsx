import type { BrowserSessions } from '../browserSessions';
import { useT } from '../i18n';
import { scrollToSection, settingsHref } from '../route';
import { ChevronIcon, PhoneIcon } from './icons';

export function PhoneLink({ phone }: { phone: BrowserSessions['phone'] }) {
  const { browsers: b } = useT();
  return (
    <a
      className="phone-link"
      data-tour="pair-phone"
      href={settingsHref('home-screen')}
      title={b.phoneDetail[phone]}
      onClick={() => scrollToSection('home-screen')}
    >
      <PhoneIcon size={18} />
      <span>{b.phoneTitle[phone]}</span>
      {phone === 'online' && <i className="phone-online" aria-hidden="true" />}
      <ChevronIcon size={13} />
    </a>
  );
}
