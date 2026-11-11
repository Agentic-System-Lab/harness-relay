import { describe, expect, it } from 'vitest';
import { cwdSettings, cwdsOf, type WorkingDirectories } from '../src/shared/types';
import {
  CWD_MENU_ALL,
  CWD_MENU_CLOSED,
  addCwds,
  cwdChipKey,
  hasCwd,
  pickStart,
  removeCwd,
  cwdMenuKey,
  cwdMenuShown,
  cwdMenuToggle,
  cwdHighlight,
  cwdMenuTyped,
  cwdPickIndex,
  cwdTerms,
  matchCwds,
  type CwdMenu,
} from '../src/web/cwds';

const list: WorkingDirectories = {
  home: '/Users/me',
  dirs: [
    { path: '/Users/me/Projects/harness-relay', default: true },
    { path: '/Users/me/Projects/Site' },
    { path: '/srv/My Notes' },
  ],
};
const all = list.dirs.map((d) => d.path);
const paths = (query: string | null, l = list) => matchCwds(l, query).map((d) => d.path);

describe('the working directory box', () => {
  it('lists them all when it opens, and when the box is cleared', () => {
    expect(paths(null)).toEqual(all);
    expect(paths('')).toEqual(all);
    expect(paths('   ')).toEqual(all);
  });

  it('keeps those whose path contains what is typed, ignoring case, in their order', () => {
    expect(paths('projects')).toEqual(['/Users/me/Projects/harness-relay', '/Users/me/Projects/Site']);
    expect(paths('SITE')).toEqual(['/Users/me/Projects/Site']);
    expect(paths('/Users/me/Projects/Site')).toEqual(['/Users/me/Projects/Site']);
    expect(paths('nowhere')).toEqual([]);
  });

  it('needs every word typed', () => {
    expect(paths('relay projects')).toEqual(['/Users/me/Projects/harness-relay']);
    expect(paths('relay notes')).toEqual([]);
  });

  it('finds folders whose names have spaces, however much space is typed', () => {
    const spaced: WorkingDirectories = {
      home: '/Users/me',
      dirs: [{ path: '/Users/me/My Notes' }, { path: '/Users/me/Work  Drafts/2026 Q4' }, { path: '/Users/me/Notes' }],
    };
    expect(paths('My Notes', spaced)).toEqual(['/Users/me/My Notes']);
    expect(paths('/Users/me/My Notes', spaced)).toEqual(['/Users/me/My Notes']);
    expect(paths('~/My Notes', spaced)).toEqual(['/Users/me/My Notes']);
    expect(paths('  my   notes ', spaced)).toEqual(['/Users/me/My Notes']);
    expect(paths('work drafts 2026 q4', spaced)).toEqual(['/Users/me/Work  Drafts/2026 Q4']);
    expect(paths('notes', spaced)).toEqual(['/Users/me/My Notes', '/Users/me/Notes']);
  });

  it('reads a typed ~ as the home folder', () => {
    expect(paths('~')).toEqual(['/Users/me/Projects/harness-relay', '/Users/me/Projects/Site']);
    expect(paths('~/projects/s')).toEqual(['/Users/me/Projects/Site']);
    expect(paths('~\\Projects')).toEqual(['/Users/me/Projects/harness-relay', '/Users/me/Projects/Site']); // the server takes ~\ too
    expect(cwdTerms('~/a ~b', '/home/me/')).toEqual(['/home/me/a', '~b']);
  });

  it('matches Windows paths whichever separator is typed, and marks the match as the path spells it', () => {
    const win: WorkingDirectories = {
      home: 'C:\\Users\\me',
      dirs: [{ path: 'C:\\Users\\me\\Projects\\relay', default: true }, { path: 'D:\\work\\My Notes' }],
    };
    expect(paths('~/projects', win)).toEqual(['C:\\Users\\me\\Projects\\relay']);
    expect(paths('~\\Projects\\relay', win)).toEqual(['C:\\Users\\me\\Projects\\relay']);
    expect(paths('c:/users/me', win)).toEqual(['C:\\Users\\me\\Projects\\relay']);
    expect(paths('d:\\work\\my notes', win)).toEqual(['D:\\work\\My Notes']);
    expect(paths('~', win)).toEqual(['C:\\Users\\me\\Projects\\relay']);
    expect(cwdHighlight('C:\\Users\\me\\Projects', cwdTerms('~/proj', win.home))).toEqual([
      { text: 'C:\\Users\\me\\Proj', match: true },
      { text: 'ects', match: false },
    ]);
  });

  it('marks every word typed in a path, and nothing when nothing is typed', () => {
    expect(cwdHighlight('/srv/My Notes', cwdTerms('my notes', ''))).toEqual([
      { text: '/srv/', match: false },
      { text: 'My', match: true },
      { text: ' ', match: false },
      { text: 'Notes', match: true },
    ]);
    expect(cwdHighlight('/srv/My Notes', [])).toEqual([{ text: '/srv/My Notes', match: false }]);
  });
});

describe('the list under the working directory box', () => {
  const items = list.dirs;
  const key = (menu: CwdMenu, k: string, shown = items) => cwdMenuKey(menu, k, shown);

  it('shows only while open with something to show', () => {
    expect(cwdMenuShown(CWD_MENU_ALL, items)).toBe(true);
    expect(cwdMenuShown(CWD_MENU_CLOSED, items)).toBe(false);
    expect(cwdMenuShown(cwdMenuTyped('nowhere'), [])).toBe(false);
  });

  it('moves the highlight round the list with the arrow keys', () => {
    let menu = CWD_MENU_ALL;
    const down = () => (menu = key(menu, 'ArrowDown').menu);
    const up = () => (menu = key(menu, 'ArrowUp').menu);
    expect(down().pick).toBe(all[0]);
    expect(down().pick).toBe(all[1]);
    expect(down().pick).toBe(all[2]);
    expect(down().pick).toBe(all[0]);
    expect(up().pick).toBe(all[2]);
    expect(key(CWD_MENU_ALL, 'ArrowUp').menu.pick).toBe(all[2]);
    expect(key(CWD_MENU_ALL, 'ArrowDown').handled).toBe(true);
  });

  it('keeps the highlight on the same folder when the list changes, and starts again when it is gone', () => {
    const menu = { ...CWD_MENU_ALL, pick: all[1]! };
    expect(cwdPickIndex(menu, items)).toBe(1);
    const fetchedAgain = [{ path: '/new' }, ...items];
    expect(cwdPickIndex(menu, fetchedAgain)).toBe(2);
    expect(key(menu, 'ArrowDown', fetchedAgain).menu.pick).toBe(all[2]);
    expect(cwdPickIndex(menu, [items[0]!])).toBe(-1);
    expect(key(menu, 'ArrowDown', [items[0]!]).menu.pick).toBe(all[0]);
  });

  it('shows every folder on an arrow key while it shows nothing: closed, or nothing matches', () => {
    expect(key(CWD_MENU_CLOSED, 'ArrowDown')).toEqual({ menu: CWD_MENU_ALL, handled: true });
    expect(key(cwdMenuTyped('nowhere'), 'ArrowUp', [])).toEqual({ menu: CWD_MENU_ALL, handled: true });
  });

  it('chooses the highlighted folder with Enter, and leaves Enter alone with none', () => {
    expect(key({ ...CWD_MENU_ALL, pick: all[2]! }, 'Enter')).toEqual({ menu: CWD_MENU_CLOSED, choose: all[2], handled: true });
    expect(key(CWD_MENU_ALL, 'Enter')).toEqual({ menu: CWD_MENU_ALL, handled: false });
    expect(key({ ...CWD_MENU_CLOSED, pick: all[0]! }, 'Enter').handled).toBe(false);
  });

  it('closes on Escape only while it shows, so a dialog around the box closes otherwise', () => {
    expect(key(CWD_MENU_ALL, 'Escape')).toEqual({ menu: CWD_MENU_CLOSED, handled: true });
    expect(key(CWD_MENU_CLOSED, 'Escape').handled).toBe(false);
    expect(key(cwdMenuTyped('nowhere'), 'Escape', []).handled).toBe(false);
  });

  it('leaves other keys to the box', () => {
    const menu = cwdMenuTyped('pro');
    expect(key(menu, 'a')).toEqual({ menu, handled: false });
    expect(key(menu, 'Tab')).toEqual({ menu, handled: false });
  });

  it('opens on what is typed with nothing highlighted, and the arrow button shows them all or hides them', () => {
    expect(cwdMenuTyped('~/pro')).toEqual({ open: true, query: '~/pro', pick: null });
    expect(cwdMenuToggle(CWD_MENU_CLOSED, items)).toEqual(CWD_MENU_ALL);
    expect(cwdMenuToggle(cwdMenuTyped('pro'), items)).toEqual(CWD_MENU_CLOSED);
    // Open, but nothing matches what is typed: the button shows them all rather than closing what shows nothing.
    expect(cwdMenuToggle(cwdMenuTyped('nowhere'), [])).toEqual(CWD_MENU_ALL);
  });
});

describe('several working directories, one chip each', () => {
  it('adds each folder once, trimmed, at the end; a separator at the end makes no other folder', () => {
    expect(addCwds(['/a'], ['  /b ', '', '/a/', '/b', '/c'])).toEqual(['/a', '/b', '/c']);
    expect(addCwds([], ['/'])).toEqual(['/']);
    expect(hasCwd(['C:\\work'], 'C:\\work\\')).toBe(true);
    // A root keeps its separator: `C:\` is not `C:`.
    expect(hasCwd(['C:\\'], 'C:')).toBe(false);
    expect(removeCwd(['/a', '/b', '/c'], 1)).toEqual(['/a', '/c']);
    // No more than a conversation may have: the dialog's or the list's past that are left out.
    const eight = Array.from({ length: 7 }, (_, i) => `/d${i}`);
    expect(addCwds(eight, ['/x', '/y'])).toEqual([...eight, '/x']);
    expect(addCwds(['/a'], ['/b', '/c'], 2)).toEqual(['/a', '/b']);
  });

  it('adds what is typed on Enter and takes out the last folder on Backspace in an empty box', () => {
    expect(cwdChipKey(['/a'], ' /b ', 'Enter')).toEqual({ dirs: ['/a', '/b'], text: '' });
    // Typed again: it is there already, and what was typed is cleared.
    expect(cwdChipKey(['/a'], '/a', 'Enter')).toEqual({ dirs: ['/a'], text: '' });
    expect(cwdChipKey(['/a', '/b'], '', 'Backspace')).toEqual({ dirs: ['/a'], text: '' });
    // Not the box's: Enter with nothing typed (a form around it may take it), Backspace inside a path.
    expect(cwdChipKey(['/a'], '  ', 'Enter')).toBeUndefined();
    expect(cwdChipKey(['/a'], '/b', 'Backspace')).toBeUndefined();
    expect(cwdChipKey([], '', 'Backspace')).toBeUndefined();
    expect(cwdChipKey(['/a'], '/b', 'Tab')).toBeUndefined();
  });

  it('opens the folder dialog at what is typed, else the last folder, else the default', () => {
    expect(pickStart(['/a', '/b'], ' /c ')).toBe('/c');
    expect(pickStart(['/a', '/b'], '')).toBe('/b');
    expect(pickStart([], '')).toBe('');
  });

  it("are a conversation's cwd and extraCwds, the first where agents start", () => {
    expect(cwdSettings(['/a'])).toEqual({ cwd: '/a' });
    expect(cwdSettings(['/a', '/b', '/c'])).toEqual({ cwd: '/a', extraCwds: ['/b', '/c'] });
    expect(cwdSettings([])).toEqual({ cwd: '' });
    expect(cwdsOf({ cwd: '/a', extraCwds: ['/b'] })).toEqual(['/a', '/b']);
    expect(cwdsOf({ cwd: '/a' })).toEqual(['/a']);
  });
});
