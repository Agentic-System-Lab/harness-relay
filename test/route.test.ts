import { describe, expect, it } from 'vitest';
import { CORNER_GAP, SETTINGS_SECTIONS, currentSection, hashFor, makeRoomForCorner, readingLine, revealLink, routeFromHash, sectionId, settingsHref } from '../src/web/route';

describe('client routes', () => {
  it('reads the hash', () => {
    expect(routeFromHash('')).toEqual({ page: 'home' });
    expect(routeFromHash('#/')).toEqual({ page: 'home' });
    expect(routeFromHash('#/new')).toEqual({ page: 'new' });
    // A route this version does not know opens the home page.
    expect(routeFromHash('#/nope')).toEqual({ page: 'home' });
    expect(routeFromHash('#/c/abc')).toEqual({ page: 'chat', id: 'abc' });
    expect(routeFromHash('#/schedule')).toEqual({ page: 'schedule' });
    expect(routeFromHash('#/settings')).toEqual({ page: 'settings' });
    expect(routeFromHash('#/settings/tools')).toEqual({ page: 'settings', section: 'tools' });
    expect(routeFromHash('#/settings/codex')).toEqual({ page: 'settings', section: 'codex' });
    // An unknown section opens the page at its top.
    expect(routeFromHash('#/settings/nope')).toEqual({ page: 'settings' });
  });

  it('writes it back the same way', () => {
    for (const hash of ['#/', '#/new', '#/schedule', '#/c/abc', '#/settings', ...SETTINGS_SECTIONS.map((s) => `#/settings/${s}`)]) {
      expect(hashFor(routeFromHash(hash))).toBe(hash);
    }
    expect(settingsHref('lead')).toBe('#/settings/lead');
    expect(sectionId('voice')).toBe('settings-voice');
  });

  it('has a settings section for every CLI', () => {
    // The model backends come before every CLI: the open agents run on them, and the others on their endpoints too.
    expect(SETTINGS_SECTIONS).toEqual([
      'version',
      'language',
      'appearance',
      'notifications',
      'backends',
      'claude',
      'codex',
      'grok',
      'cursor',
      'antigravity',
      'copilot',
      'muse',
      'opencode',
      'goose',
      'cline',
      'openhands',
      'pi',
      'lead',
      'tools',
      'voice',
      'cwd',
      'sessions',
      'shares',
      'browsers',
      'tour',
    ]);
  });
});

describe('the settings card being read', () => {
  const tops = [
    { section: 'language' as const, top: 200 },
    { section: 'claude' as const, top: 500 },
    { section: 'codex' as const, top: 900 },
  ];

  it('is the last card that scrolled up to the line, else the first', () => {
    expect(currentSection(tops, 100)).toBe('language');
    expect(currentSection(tops, 520)).toBe('claude');
    expect(currentSection(tops, 2000)).toBe('codex');
    expect(currentSection([], 0)).toBeUndefined();
  });

  it('moves the line down over the last half screen, so short cards at the end are each reached', () => {
    const view = { linksBottom: 60, viewBottom: 900, scrollHeight: 3000, clientHeight: 900 };
    expect(readingLine({ ...view, scrollTop: 0 })).toBe(84);
    expect(readingLine({ ...view, scrollTop: 2100 - 450 })).toBe(84); // half a screen from the end
    expect(readingLine({ ...view, scrollTop: 2100 - 225 })).toBe(84 + (900 - 84) / 2);
    expect(readingLine({ ...view, scrollTop: 2100 })).toBe(900); // the end: the bottom of the view
    // A page that does not scroll keeps the line under the links.
    expect(readingLine({ ...view, scrollHeight: 900, scrollTop: 0 })).toBe(84);
  });
});

describe('the settings links and the button in the corner', () => {
  it('make room for it as soon as their row comes up to its bottom edge, not only once stuck to the top', () => {
    // The menu button: 36px at 10px from the top.
    expect(makeRoomForCorner(200, 46)).toBe(false);
    expect(makeRoomForCorner(46 + CORNER_GAP, 46)).toBe(false);
    expect(makeRoomForCorner(46 + CORNER_GAP - 1, 46)).toBe(true);
    expect(makeRoomForCorner(12, 46)).toBe(true);
    // No button there (a wide screen with the sidebar open).
    expect(makeRoomForCorner(12, undefined)).toBe(false);
  });
});

describe('the settings links following the card being read', () => {
  // A row 976px wide holding 980px of links: they all but fit (a wide window).
  const nearlyFits = { scrollLeft: 0, clientWidth: 976, scrollWidth: 980 };

  it('stays still while the highlighted link shows', () => {
    expect(revealLink(nearlyFits, { left: 12, width: 90 })).toBeUndefined();
    expect(revealLink(nearlyFits, { left: 880, width: 88 })).toBeUndefined(); // the last link, ending at 968
    expect(revealLink({ scrollLeft: 100, clientWidth: 400, scrollWidth: 980 }, { left: 200, width: 80 })).toBeUndefined();
  });

  it('scrolls just far enough to show a link that is cut off, clear of the faded end', () => {
    const row = { scrollLeft: 0, clientWidth: 400, scrollWidth: 980 };
    expect(revealLink(row, { left: 380, width: 80 })).toBe(380 + 80 + 12 - 400);
    expect(revealLink({ ...row, scrollLeft: 300 }, { left: 200, width: 80 })).toBe(200 - 12);
  });

  it('never scrolls past either end', () => {
    expect(revealLink({ scrollLeft: 100, clientWidth: 400, scrollWidth: 980 }, { left: 6, width: 80 })).toBe(0);
    expect(revealLink({ scrollLeft: 0, clientWidth: 400, scrollWidth: 980 }, { left: 900, width: 80 })).toBe(580);
  });
});
