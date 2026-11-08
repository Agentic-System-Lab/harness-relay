import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS, currentSection, hashFor, readingLine, routeFromHash, sectionId, settingsHref } from '../src/web/route';

describe('client routes', () => {
  it('reads the hash', () => {
    expect(routeFromHash('')).toEqual({ page: 'new' });
    expect(routeFromHash('#/')).toEqual({ page: 'new' });
    expect(routeFromHash('#/c/abc')).toEqual({ page: 'chat', id: 'abc' });
    expect(routeFromHash('#/settings')).toEqual({ page: 'settings' });
    expect(routeFromHash('#/settings/tools')).toEqual({ page: 'settings', section: 'tools' });
    expect(routeFromHash('#/settings/codex')).toEqual({ page: 'settings', section: 'codex' });
    // An unknown section opens the page at its top.
    expect(routeFromHash('#/settings/nope')).toEqual({ page: 'settings' });
  });

  it('writes it back the same way', () => {
    for (const hash of ['#/', '#/c/abc', '#/settings', ...SETTINGS_SECTIONS.map((s) => `#/settings/${s}`)]) {
      expect(hashFor(routeFromHash(hash))).toBe(hash);
    }
    expect(settingsHref('lead')).toBe('#/settings/lead');
    expect(sectionId('voice')).toBe('settings-voice');
  });

  it('has a settings section for every CLI', () => {
    expect(SETTINGS_SECTIONS).toEqual(['language', 'claude', 'codex', 'grok', 'lead', 'tools', 'voice', 'cwd', 'tour']);
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
