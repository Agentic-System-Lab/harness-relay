// The working directory box's pure logic: which of the working directories in use match what is typed,
// and how the list under the box answers the keyboard and its arrow button.

import { highlightParts, searchTerms, termsIn } from '../shared/search';
import type { WorkingDirectories } from '../shared/types';

type Dir = WorkingDirectories['dirs'][number];

/** A typed `~` (alone, or followed by a separator) stands for the home folder, as the server reads it. */
function expandHome(term: string, home: string): string {
  if (!home) return term;
  if (term === '~') return home;
  return term.startsWith('~/') || term.startsWith('~\\') ? home.replace(/[\\/]+$/, '') + term.slice(1) : term;
}

/**
 * `\` as `/`, so a Windows path (`C:\Users\me\work`) matches whichever separator is typed, as the
 * server takes either. It keeps the length, so positions in the result are positions in the path.
 */
const slashes = (s: string) => s.replace(/\\/g, '/');

/** The words to look for in each path: what is typed, split on whitespace, with `~` as the home folder. */
export function cwdTerms(query: string, home: string): string[] {
  return searchTerms(query).map((t) => slashes(expandHome(t, home)));
}

/**
 * The working directories whose path contains every word of `query` (ignoring case), in the order
 * given; `null` (the list was just opened, nothing typed since): all of them.
 */
export function matchCwds(list: WorkingDirectories, query: string | null): Dir[] {
  const terms = query === null ? [] : cwdTerms(query, list.home);
  if (!terms.length) return list.dirs;
  return list.dirs.filter((d) => termsIn(slashes(d.path), terms).length === terms.length);
}

/** The path in parts, those where the words typed (`cwdTerms`) match marked, spelled as in the path. */
export function cwdHighlight(path: string, terms: string[]): { text: string; match: boolean }[] {
  let at = 0;
  return highlightParts(slashes(path), terms).map((p) => {
    const text = path.slice(at, at + p.text.length);
    at += p.text.length;
    return { text, match: p.match };
  });
}

/**
 * The list under the box: whether it is open, what was typed since it opened (`null`: nothing, so it
 * shows them all), and the highlighted path (`null`: none, so Enter leaves the box as typed). The
 * highlight is a path, not a position, so it stays on the same folder when the list is fetched again.
 */
export interface CwdMenu {
  open: boolean;
  query: string | null;
  pick: string | null;
}

export const CWD_MENU_CLOSED: CwdMenu = { open: false, query: null, pick: null };
/** Open on every working directory, nothing highlighted. */
export const CWD_MENU_ALL: CwdMenu = { open: true, query: null, pick: null };

/** Whether the list is showing: open, with something to show (`items`: what matches its query). */
export function cwdMenuShown(menu: CwdMenu, items: Dir[]): boolean {
  return menu.open && items.length > 0;
}

/** Where the highlighted path is in `items`, -1 for none. */
export function cwdPickIndex(menu: CwdMenu, items: Dir[]): number {
  return menu.pick === null ? -1 : items.findIndex((d) => d.path === menu.pick);
}

/** Typing in the box: the list opens on what is typed, nothing highlighted. */
export function cwdMenuTyped(value: string): CwdMenu {
  return { open: true, query: value, pick: null };
}

/** The arrow button: hides the list when it shows, otherwise shows every working directory. */
export function cwdMenuToggle(menu: CwdMenu, items: Dir[]): CwdMenu {
  return cwdMenuShown(menu, items) ? CWD_MENU_CLOSED : CWD_MENU_ALL;
}

/**
 * A key pressed in the box: the list's next state, the path chosen (Enter on a highlighted option),
 * and whether the key was the list's — then neither the box nor a dialog around it may act on it too.
 * ↑ ↓ move the highlight round the list, or, while it shows nothing (closed, or nothing matches what
 * is typed), show every working directory; Enter and Escape are the list's only while it shows.
 */
export function cwdMenuKey(menu: CwdMenu, key: string, items: Dir[]): { menu: CwdMenu; choose?: string; handled: boolean } {
  const shown = cwdMenuShown(menu, items);
  const at = cwdPickIndex(menu, items);
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!shown) return { menu: CWD_MENU_ALL, handled: true };
    const down = key === 'ArrowDown';
    const n = items.length;
    const next = at < 0 ? (down ? 0 : n - 1) : (at + (down ? 1 : n - 1)) % n;
    return { menu: { ...menu, pick: items[next]!.path }, handled: true };
  }
  if (key === 'Enter' && shown && at >= 0) return { menu: CWD_MENU_CLOSED, choose: items[at]!.path, handled: true };
  if (key === 'Escape' && shown) return { menu: CWD_MENU_CLOSED, handled: true };
  return { menu, handled: false };
}
