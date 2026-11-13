import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOUR_TARGETS, TOUR_VERSION, scrollBy, tourSeen } from '../src/web/components/Onboarding';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

describe('guided tour', () => {
  it('points at one target (or none) per step', () => {
    expect(TOUR_TARGETS).toHaveLength(en.tour.steps.length);
    expect(TOUR_TARGETS).toHaveLength(zhTW.tour.steps.length);
  });

  it('points only at elements the app has (a data-tour attribute in the client)', () => {
    const web = fileURLToPath(new URL('../src/web/', import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const names = new Set(files(web).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1])));
    for (const target of TOUR_TARGETS) if (target) expect([...names], `data-tour="${target}"`).toContain(target);
  });

  it('opens again for people who finished an earlier version', () => {
    expect(tourSeen(null, 2)).toBe(false); // first visit
    expect(tourSeen('1', 2)).toBe(false); // finished the tour before it had versions
    expect(tourSeen('2', 2)).toBe(true);
    expect(tourSeen('3', 2)).toBe(true); // a newer version was seen in this browser
    expect(tourSeen('yes', 2)).toBe(false);
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
    // The steps changed? Raise TOUR_VERSION in src/web/components/Onboarding.tsx so people who finished the tour
    // see it again, then update both values here. For a change not worth showing again (a typo), update only the
    // fingerprint.
    expect({ version: TOUR_VERSION, fingerprint }).toEqual({ version: 14, fingerprint: 'd628be731df0' });
  });
});
