import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HOOK_PROVIDERS, PROVIDER_LABEL } from '../src/shared/types';
import { scrollBy } from '../src/web/components/Onboarding';
import { markDone, pendingTour, TOUR_STEPS, TOUR_VERSION, tourIndices } from '../src/web/tour';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

describe('guided tour', () => {
  it('points at one target (or none) per step', () => {
    expect(TOUR_STEPS).toHaveLength(en.tour.steps.length);
    expect(TOUR_STEPS).toHaveLength(zhTW.tour.steps.length);
  });

  it('points only at elements the app has (a data-tour attribute in the client)', () => {
    const web = fileURLToPath(new URL('../src/web/', import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const names = new Set(files(web).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1])));
    for (const { target } of TOUR_STEPS) if (target) expect([...names], `data-tour="${target}"`).toContain(target);
  });

  it('remembers a browser, shows changes since its version, and preserves a newer marker during manual replay', () => {
    let value: string | null = null;
    vi.stubGlobal('localStorage', {
      getItem: () => value,
      setItem: (_: string, v: string) => {
        value = v;
      },
    });
    try {
      expect(pendingTour()).toBe(0);
      expect(tourIndices(0)).toHaveLength(en.tour.steps.length);
      const titles = (since: number) => tourIndices(since).map((i) => en.tour.steps[i]!.title);
      expect(titles(20)).toEqual([
        'Connect your phone',
        'API keys and endpoints for open-source agents',
        'Start a new chat',
        'Notifications and sound',
        'Team checks',
        'Browse the working directory',
        'Automations',
        'Connect apps to your chats',
      ]);
      expect(titles(21)).toEqual([
        'Connect your phone',
        'API keys and endpoints for open-source agents',
        'Start a new chat',
        'Notifications and sound',
        'Browse the working directory',
        'Automations',
        'Connect apps to your chats',
      ]);
      expect(titles(22)).toEqual([
        'Connect your phone',
        'API keys and endpoints for open-source agents',
        'Start a new chat',
        'Notifications and sound',
        'Browse the working directory',
        'Automations',
        'Connect apps to your chats',
      ]);
      for (let version = 23; version <= 32; version++) {
        expect(titles(version)).toEqual([
          'API keys and endpoints for open-source agents',
          'Start a new chat',
          'Browse the working directory',
          'Automations',
          'Connect apps to your chats',
        ]);
      }
      for (let version = 33; version <= 35; version++) {
        expect(titles(version)).toEqual([
          'API keys and endpoints for open-source agents',
          'Start a new chat',
          'Browse the working directory',
          'Automations',
        ]);
      }
      expect(titles(36)).toEqual(['Start a new chat', 'Browse the working directory', 'Automations']);
      expect(titles(37)).toEqual(['Browse the working directory']);
      expect(titles(38)).toEqual(['Browse the working directory']);
      expect(tourIndices(39)).toEqual([]);
      value = '21';
      expect(pendingTour()).toBe(21);
      markDone();
      expect(pendingTour()).toBeNull();
      value = '999';
      markDone();
      expect(value).toBe('999');
      value = 'broken';
      expect(pendingTour()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([en, zhTW])('explains the permissions and CLI support for team checks in $langName', (messages) => {
    const step = messages.tour.steps.find((s) => s.title === messages.checks.title);
    expect(step?.body).toContain(messages.permissions.edit.label);
    expect(step?.body).toContain(messages.permissions.full.label);
    const points = step?.points?.join('\n');
    for (const provider of HOOK_PROVIDERS) expect(points).toContain(PROVIDER_LABEL[provider]);
  });

  it("scrolls a long step's text with the keys, while the focus is on its buttons", () => {
    expect(scrollBy('ArrowDown', 300, 900)).toBe(40);
    expect(scrollBy('ArrowUp', 300, 900)).toBe(-40);
    expect(scrollBy('PageDown', 300, 900)).toBe(260);
    expect(scrollBy('PageUp', 300, 900)).toBe(-260);
    expect(scrollBy('PageDown', 30, 900)).toBe(40);
    // All the way: a number the browser takes (Infinity would be 0 to it).
    expect(scrollBy('End', 300, 900)).toBe(900);
    expect(scrollBy('Home', 300, 900)).toBe(-900);
    expect(scrollBy('ArrowRight', 300, 900)).toBeUndefined();
    expect(scrollBy(' ', 300, 900)).toBeUndefined();
  });

  it('gets a new version when its steps change', () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([zhTW.tour.steps, en.tour.steps]))
      .digest('hex')
      .slice(0, 12);
    // The steps changed? Raise TOUR_VERSION in src/web/tour.ts so people who finished the tour
    // see the updated steps, then update both values here. For a change not worth showing again (a typo), update only the
    // fingerprint.
    expect({ version: TOUR_VERSION, fingerprint }).toEqual({ version: 39, fingerprint: '741dc9a62d14' });
  });
});
