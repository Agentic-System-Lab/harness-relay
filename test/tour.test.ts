import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TOUR_TARGETS, TOUR_VERSION, tourSeen } from '../src/web/components/Onboarding';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

describe('guided tour', () => {
  it('points at one target (or none) per step', () => {
    expect(TOUR_TARGETS).toHaveLength(en.tour.steps.length);
    expect(TOUR_TARGETS).toHaveLength(zhTW.tour.steps.length);
  });

  it('opens again for people who finished an earlier version', () => {
    expect(tourSeen(null, 2)).toBe(false); // first visit
    expect(tourSeen('1', 2)).toBe(false); // finished the tour before it had versions
    expect(tourSeen('2', 2)).toBe(true);
    expect(tourSeen('3', 2)).toBe(true); // a newer version was seen in this browser
    expect(tourSeen('yes', 2)).toBe(false);
  });

  it('gets a new version when its steps change', () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([zhTW.tour.steps, en.tour.steps]))
      .digest('hex')
      .slice(0, 12);
    // The steps changed? Raise TOUR_VERSION in src/web/components/Onboarding.tsx so people who finished the tour
    // see it again, then update both values here. For a change not worth showing again (a typo), update only the
    // fingerprint.
    expect({ version: TOUR_VERSION, fingerprint }).toEqual({ version: 10, fingerprint: 'f6888dffc646' });
  });
});
