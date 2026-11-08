import type { ReactNode } from 'react';
import { scrollToSection, settingsHref, type SettingsSection } from '../route';

/** A settings card's title, linking to the card (#/settings/<section>) so it can be bookmarked or shared. */
export function SectionTitle({ section, children }: { section: SettingsSection; children: ReactNode }) {
  return (
    <h3 className="section-title">
      <a href={settingsHref(section)} onClick={() => scrollToSection(section)}>
        {children}
        <span className="section-hash" aria-hidden="true">
          #
        </span>
      </a>
    </h3>
  );
}
