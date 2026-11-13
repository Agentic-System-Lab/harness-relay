// The client's routes, kept in the URL hash: #/ (home), #/new (new chat), #/schedule (new schedule), #/c/<id>,
// #/settings and #/settings/<section>.

import { OPEN_PROVIDERS, PROVIDERS, isOpenProvider, type Provider } from '../shared/types';

/** `section`: the card of the settings page to scroll to. */
export type Route =
  | { page: 'home' }
  | { page: 'new' }
  | { page: 'schedule' }
  | { page: 'chat'; id: string }
  | { page: 'settings'; section?: SettingsSection };

/**
 * The cards of the settings page, in page order; each is the element `settings-<section>`. The model
 * backends come before every CLI: the open agents run on them, and Claude Code, Codex and Grok can run
 * on their endpoints too.
 */
export const SETTINGS_SECTIONS = [
  'version',
  'language',
  'appearance',
  'notifications',
  'backends',
  ...PROVIDERS.filter((p) => !isOpenProvider(p)),
  ...OPEN_PROVIDERS,
  'lead',
  'tools',
  'voice',
  'cwd',
  'sessions',
  'shares',
  'browsers',
  'tour',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function routeFromHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h.startsWith('c/')) return { page: 'chat', id: h.slice(2) };
  if (h === 'new') return { page: 'new' };
  if (h === 'schedule') return { page: 'schedule' };
  if (h === 'settings') return { page: 'settings' };
  if (h.startsWith('settings/')) {
    const section = h.slice('settings/'.length) as SettingsSection;
    return SETTINGS_SECTIONS.includes(section) ? { page: 'settings', section } : { page: 'settings' };
  }
  return { page: 'home' };
}

export function hashFor(r: Route): string {
  if (r.page === 'chat') return `#/c/${r.id}`;
  if (r.page === 'settings') return r.section ? `#/settings/${r.section}` : '#/settings';
  if (r.page === 'new') return '#/new';
  if (r.page === 'schedule') return '#/schedule';
  return '#/';
}

/** The link to a card of the settings page. */
export const settingsHref = (section: SettingsSection | Provider) => hashFor({ page: 'settings', section });

/** The element id of a settings card. */
export const sectionId = (section: SettingsSection) => `settings-${section}`;

/**
 * Scrolls to a settings card. Links call it too, because following a link to the hash already in
 * the address bar does not change the route.
 */
export function scrollToSection(section: SettingsSection): void {
  document.getElementById(sectionId(section))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** The settings card being read: the last one whose top has scrolled up to `line`, else the first card. */
export function currentSection(tops: { section: SettingsSection; top: number }[], line: number): SettingsSection | undefined {
  if (!tops.length) return undefined;
  let current = tops[0]!.section;
  for (const t of tops) if (t.top <= line) current = t.section;
  return current;
}

/** How wide the settings links' faded ends are (`.settings-nav-links` in styles.css). */
export const LINKS_FADE = 12;

/**
 * Where the row of settings links (scrolling sideways where it does not fit) should scroll so the
 * highlighted link shows: undefined while it already does, so the row stays still as the page scrolls;
 * otherwise just far enough to bring it clear of the faded end. `link.left` is from the row's start.
 */
export function revealLink(
  row: { scrollLeft: number; clientWidth: number; scrollWidth: number },
  link: { left: number; width: number },
  fade = LINKS_FADE,
): number | undefined {
  const right = link.left + link.width;
  if (link.left >= row.scrollLeft && right <= row.scrollLeft + row.clientWidth) return undefined;
  const target = link.left < row.scrollLeft ? link.left - fade : right + fade - row.clientWidth;
  return Math.round(Math.min(Math.max(0, row.scrollWidth - row.clientWidth), Math.max(0, target)));
}

/**
 * Where a card's top must reach to count as being read: just under the sticky links. Over the last
 * half screen of scrolling the line moves down to the bottom of the view, so the short cards at the
 * end of the page, which can never scroll up to the links, are each reached in turn.
 */
export function readingLine(v: { linksBottom: number; viewBottom: number; scrollTop: number; scrollHeight: number; clientHeight: number }): number {
  const line = v.linksBottom + 24;
  const scrollable = v.scrollHeight - v.clientHeight;
  const sweep = Math.min(v.clientHeight / 2, scrollable);
  const remaining = scrollable - v.scrollTop;
  if (sweep <= 0 || remaining >= sweep) return line;
  return line + (v.viewBottom - line) * (1 - Math.max(0, remaining) / sweep);
}
