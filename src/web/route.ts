// The client's routes, kept in the URL hash: #/ (home), #/new (new chat), #/schedule (new schedule), #/c/<id>,
// #/settings, #/settings/<section>, and #/settings/apps/<item> or #/settings/tools/<item> for one row of Apps and tools.

import { OPEN_PROVIDERS, PROVIDERS, isOpenProvider, type Provider } from '../shared/types';

/** `section`: the card of the settings page to scroll to; `item`: the row of Apps and tools in it, opened. */
export type Route =
  | { page: 'home' }
  | { page: 'new' }
  | { page: 'schedule' }
  | { page: 'chat'; id: string }
  | { page: 'settings'; section?: SettingsSection; item?: SettingsItem };

/** Where to continue after visiting Settings from a creation form. */
export interface SettingsReturn {
  page: 'new' | 'schedule';
  createdId?: string;
}

/**
 * The cards of the settings page, in page order; each is the element `settings-<section>`. The model
 * backends come before every CLI: the open agents run on them, and Claude Code, Codex and Grok can run
 * on their endpoints too.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'version',
  'language',
  'appearance',
  'notifications',
  'sandboxes',
  'backends',
  ...PROVIDERS.filter((p) => !isOpenProvider(p)),
  ...OPEN_PROVIDERS,
  'lead',
  'apps',
  'voice',
  'cwd',
  'sessions',
  'shares',
  'publish',
  'handoffs',
  'browsers',
  'home-screen',
  'tour',
  'labs',
] as const;
/** The tool library tab and the menu of agent settings each have a direct link. */
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number] | 'tools' | 'agents';
export const settingsCard = (section: SettingsSection) => (section === 'tools' ? 'apps' : section);

/**
 * The rows of Settings → Apps and tools, each with a link of its own that opens it: Common apps' services
 * and the computer (#/settings/apps/<item>), then the tool library's parts (#/settings/tools/<item>), each
 * in page order.
 */
export const APPS_ITEMS = [
  'mail',
  'calendar',
  'teams',
  'slack',
  'drive',
  'notion',
  'heptabase',
  'obsidian',
  'github',
  'browser',
  'computer',
] as const;
export const LIBRARY_ITEMS = ['mcp', 'skills', 'memory', 'hooks', 'checks'] as const;
export type AppsItem = (typeof APPS_ITEMS)[number];
export type LibraryItem = (typeof LIBRARY_ITEMS)[number];
export type SettingsItem = AppsItem | LibraryItem;

const isAppsItem = (item: string): item is AppsItem => (APPS_ITEMS as readonly string[]).includes(item);
const isLibraryItem = (item: string): item is LibraryItem => (LIBRARY_ITEMS as readonly string[]).includes(item);

/** The tab of Apps and tools a row is on. */
export const itemTab = (item: SettingsItem): 'apps' | 'tools' => (isAppsItem(item) ? 'apps' : 'tools');

/** The element id of a row of Apps and tools (`settings-apps-computer`, `settings-tools-mcp`). */
export const itemId = (item: SettingsItem) => `settings-${itemTab(item)}-${item}`;

/** Whether a settings card is an agent's (one per CLI). */
export const isAgentSection = (section: SettingsSection): section is Provider => (PROVIDERS as readonly string[]).includes(section);

/** The agents' cards, in page order: the links row lists them in one menu, "Agents". */
export const AGENT_SECTIONS: Provider[] = SETTINGS_SECTIONS.filter(isAgentSection);

/** An entry of the settings page's links row: a card's own link, or the agents' menu. */
export type SettingsNavEntry = Exclude<SettingsSection, Provider | 'tools'> | 'agents';

/** The entry of the links row that leads to a card: the agents' menu for an agent's card. */
export function navEntryOf(section: SettingsSection): SettingsNavEntry {
  const card = settingsCard(section);
  return isAgentSection(card) ? 'agents' : card;
}

/** The links row, in page order: every card's link, the agents' gathered into one menu where the first of them is. */
export const SETTINGS_NAV: SettingsNavEntry[] = SETTINGS_SECTIONS.map(navEntryOf).filter((e, i, all) => all.indexOf(e) === i);

/**
 * Which item of a menu of `count` a key moves the focus to from item `index` (-1: none yet): the
 * arrows to the next or previous one, round the ends; Home and End to the first or last. Undefined
 * for any other key.
 */
export function menuMove(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
  if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return undefined;
}

export function routeFromHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h.startsWith('c/')) return { page: 'chat', id: h.slice(2) };
  if (h === 'new') return { page: 'new' };
  if (h === 'schedule') return { page: 'schedule' };
  if (h === 'settings') return { page: 'settings' };
  if (h.startsWith('settings/')) {
    const [name = '', item, ...more] = h.slice('settings/'.length).split('/');
    const section = name as SettingsSection;
    if (section !== 'tools' && section !== 'agents' && !SETTINGS_SECTIONS.includes(section)) return { page: 'settings' };
    // A row of Apps and tools, on its own tab; any other row (or more after it) opens the card alone.
    if (item !== undefined && !more.length && ((section === 'apps' && isAppsItem(item)) || (section === 'tools' && isLibraryItem(item)))) {
      return { page: 'settings', section, item };
    }
    return { page: 'settings', section };
  }
  return { page: 'home' };
}

export function hashFor(r: Route): string {
  if (r.page === 'chat') return `#/c/${r.id}`;
  if (r.page === 'settings') {
    if (r.item) return `#/settings/${itemTab(r.item)}/${r.item}`;
    return r.section ? `#/settings/${r.section}` : '#/settings';
  }
  if (r.page === 'new') return '#/new';
  if (r.page === 'schedule') return '#/schedule';
  return '#/';
}

/** The link to a card of the settings page. */
export const settingsHref = (section: SettingsSection | Provider) => hashFor({ page: 'settings', section });

/** The link to a row of Apps and tools, which opens it. */
export const itemHref = (item: SettingsItem) => hashFor({ page: 'settings', section: itemTab(item), item });

/** The element id of a settings card. */
export const sectionId = (section: SettingsSection) => `settings-${settingsCard(section)}`;

/**
 * Scrolls to a settings card. Links call it too, because following a link to the hash already in
 * the address bar does not change the route.
 */
export function scrollToSection(section: SettingsSection, focusTitle = false): void {
  const card = document.getElementById(sectionId(section));
  if (focusTitle) card?.querySelector<HTMLElement>('.section-title a')?.focus({ preventScroll: true });
  card?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/**
 * Opens a row of Apps and tools that the page shows, if it does: unfolded, flashed for a moment and given
 * the focus (its title, else the row), for a keyboard and a screen reader to land there too. The
 * settings page does it as a link to the row arrives; a link calls it too, as for scrollToSection. The row
 * opened, or null while the page does not show it.
 */
export function openItem(item: SettingsItem): HTMLElement | null {
  const row = document.getElementById(itemId(item));
  // Not on the page yet (its tab not shown, the library still loading): the route's change does it.
  if (!row || row.closest('[hidden]')) return null;
  const details = row instanceof HTMLDetailsElement ? row : row.querySelector<HTMLDetailsElement>(':scope > details');
  if (!details) return null;
  details.open = true;
  // Its title, or the row itself where it shows none (a service not connected yet: its action is the row).
  const title = details.querySelector<HTMLElement>(':scope > summary');
  if (title && !title.hidden) title.focus({ preventScroll: true });
  else {
    if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1');
    row.focus({ preventScroll: true });
  }
  row.classList.remove('settings-item-flash');
  requestAnimationFrame(() => {
    row.classList.add('settings-item-flash');
    setTimeout(() => row.classList.remove('settings-item-flash'), 1600);
  });
  return row;
}

/**
 * Whether a row its link opened shows whole with its card's top, both below the sticky links (`linksHeight`
 * and the cards' scroll margin, `gap`) in a view `viewHeight` tall: the opened row's bottom `rowBottom`
 * pixels below the card's top. Coming from a draft, the card's top holds the link back to it.
 */
export function rowFitsUnderCard(v: { rowBottom: number; linksHeight: number; viewHeight: number }, gap = 16): boolean {
  return v.linksHeight + gap + v.rowBottom <= v.viewHeight;
}

/** Opens a row of Apps and tools and scrolls to it, for a link whose address may be the one shown already. */
export function revealItem(item: SettingsItem): void {
  openItem(item)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
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

/** The least room left between the corner button and the settings links' row below it (px). */
export const CORNER_GAP = 6;

/**
 * Whether the settings links make room for the button in the page's top-left corner (the menu on
 * phones, the collapsed sidebar's on wide screens): as soon as their row comes up to the button's
 * bottom edge (`cornerBottom`, none without such a button), not only once stuck to the top, so that
 * the button never covers a link.
 */
export function makeRoomForCorner(linksTop: number, cornerBottom: number | undefined, gap = CORNER_GAP): boolean {
  return cornerBottom !== undefined && linksTop < cornerBottom + gap;
}

/**
 * Where a card's top must reach to count as being read: just under the sticky links. Over the last
 * half screen of scrolling the line moves down to the bottom of the view, so the short cards at the
 * end of the page, which can never scroll up to the links, are each reached in turn.
 */
export function readingLine(v: {
  linksBottom: number;
  viewBottom: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): number {
  const line = v.linksBottom + 24;
  const scrollable = v.scrollHeight - v.clientHeight;
  const sweep = Math.min(v.clientHeight / 2, scrollable);
  const remaining = scrollable - v.scrollTop;
  if (sweep <= 0 || remaining >= sweep) return line;
  return line + (v.viewBottom - line) * (1 - Math.max(0, remaining) / sweep);
}
