import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { scrollBy, TOPIC_LINKS } from '../src/web/components/Onboarding';
import {
  changed,
  guideOnStart,
  markRead,
  parseGuide,
  pendingTour,
  quietTour,
  TOUR_STEPS,
  TOUR_VERSION,
  unread,
  type TopicId,
} from '../src/web/tour';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

const ALL = TOUR_STEPS.map((s) => s.id);
const guide = (value: object) => JSON.stringify(value);

/** A localStorage of a few keys, for the functions that read and write the browser's. */
function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  });
  return values;
}

describe('guided tour', () => {
  it('has one topic for each step of both locales, each named once', () => {
    expect(TOUR_STEPS).toHaveLength(en.tour.steps.length);
    expect(TOUR_STEPS).toHaveLength(zhTW.tour.steps.length);
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  it.each([en, zhTW])('names the way there of each topic that has one, in $langName', (messages) => {
    TOUR_STEPS.forEach((s, n) => {
      expect(Boolean(messages.tour.steps[n]!.action), s.id).toBe(Boolean(TOPIC_LINKS[s.id]));
    });
  });

  it('keeps each topic short', () => {
    for (const step of [...en.tour.steps, ...zhTW.tour.steps]) {
      expect(step.title.length, step.title).toBeLessThanOrEqual(24);
      expect(step.body.length, step.title).toBeLessThanOrEqual(190);
    }
  });

  it('opens on a first visit only, then asks about the topics left', () => {
    expect(guideOnStart(parseGuide(null, null))).toBe('open');
    // One topic read: the others are left, none of them read before.
    const one = parseGuide(null, guide({ seen: { welcome: 17 } }));
    expect(guideOnStart(one)).toBe('ask');
    expect(unread(one)).toEqual(ALL.slice(1));
    expect(unread(one).some((id) => changed(one, id))).toBe(false);
    // Every topic read: nothing.
    const all = parseGuide(null, guide({ seen: Object.fromEntries(TOUR_STEPS.map((s) => [s.id, s.revision])) }));
    expect(unread(all)).toEqual([]);
    expect(guideOnStart(all)).toBeNull();
  });

  it('counts a tour finished before the checklist as read up to its version', () => {
    // The version the last tour had, or a test's: nothing to read.
    expect(guideOnStart(parseGuide(String(TOUR_VERSION), null))).toBeNull();
    expect(guideOnStart(parseGuide('999', null))).toBeNull();
    // An older one: the topics changed since, each read before in an earlier form.
    const old = parseGuide('20', null);
    expect(unread(old)).toEqual(['agents', 'chat', 'team', 'phone', 'automations', 'apps']);
    expect(unread(old).every((id) => changed(old, id))).toBe(true);
    expect(guideOnStart(old)).toBe('ask');
    expect(unread(parseGuide('44', null))).toEqual(['chat', 'team']);
    expect(unread(parseGuide('45', null))).toEqual(['chat']);
    // The tour before it had versions.
    expect(unread(parseGuide('1', null))).toEqual(ALL);
    // A topic read since counts, whatever the old version.
    expect(unread(parseGuide('20', guide({ seen: { agents: 39, chat: 46 } })))).toEqual(['team', 'phone', 'automations', 'apps']);
  });

  it('marks a topic read in an earlier revision as changed', () => {
    const state = parseGuide(null, guide({ seen: { welcome: 17, agents: 20 } }));
    expect(unread(state)[0]).toBe('agents');
    expect(changed(state, 'agents')).toBe(true);
    expect(changed(state, 'chat')).toBe(false);
    expect(changed(state, 'welcome')).toBe(false);
  });

  it('stops asking after "Not now" until a topic changes', () => {
    expect(guideOnStart(parseGuide(null, guide({ seen: { welcome: 17 }, quiet: TOUR_VERSION })))).toBeNull();
    // Answered before the newest topic changed: asked about it.
    const newest = TOUR_STEPS.find((s) => s.revision === TOUR_VERSION)!;
    expect(guideOnStart(parseGuide(null, guide({ seen: { welcome: 17 }, quiet: TOUR_VERSION - 1 })))).toBe('ask');
    const rest = guide({
      seen: Object.fromEntries(TOUR_STEPS.filter((s) => s.id !== 'agents').map((s) => [s.id, s.revision])),
      quiet: TOUR_VERSION - 1,
    });
    // Only a topic older than the answer left: not asked.
    expect(newest.id).not.toBe('agents');
    expect(guideOnStart(parseGuide(null, rest))).toBeNull();
  });

  it('reads what it cannot use as nothing read', () => {
    for (const broken of ['{', 'null', '[]', guide({ seen: 'x' }), guide({ seen: { welcome: -1, nope: 3 }, quiet: 'x' })]) {
      const state = parseGuide(null, broken);
      expect(state, broken).not.toBeNull();
      expect(unread(state), broken).toEqual(ALL);
      expect(guideOnStart(state), broken).toBe('ask');
    }
    expect(unread(parseGuide('broken', null))).toEqual(ALL);
  });

  it('remembers what this browser read, and its "Not now"', () => {
    const values = storage();
    try {
      expect(pendingTour()).toBe('open');
      markRead('welcome');
      expect(pendingTour()).toBe('ask');
      quietTour();
      expect(pendingTour()).toBeNull();
      expect(JSON.parse(values.get('relay:guide')!)).toEqual({ seen: { welcome: 17 }, quiet: TOUR_VERSION });
      for (const id of ALL) markRead(id as TopicId);
      expect(unread(parseGuide(null, values.get('relay:guide')!))).toEqual([]);
      // The tour's old key is left as it was.
      expect(values.has('relay:onboarded')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    const old = storage({ 'relay:onboarded': '45' });
    try {
      expect(pendingTour()).toBe('ask');
      markRead('chat');
      expect(pendingTour()).toBeNull();
      expect(old.get('relay:onboarded')).toBe('45');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens nothing by itself where the page cannot use its storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    try {
      expect(pendingTour()).toBeNull();
      expect(() => markRead('welcome')).not.toThrow();
      expect(() => quietTour()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("scrolls a long topic's text with the keys, while the focus is on its buttons", () => {
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

  it('has a topic at each version, so a version always has something to show', () => {
    expect(Math.max(...TOUR_STEPS.map((s) => s.revision))).toBe(TOUR_VERSION);
    expect(unread(parseGuide(String(TOUR_VERSION - 1), null)).length).toBeGreaterThan(0);
  });

  it('gets a new version when its topics change', () => {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([zhTW.tour.steps, en.tour.steps]))
      .digest('hex')
      .slice(0, 12);
    // The topics changed? Raise TOUR_VERSION in src/web/tour.ts and give it to each topic changed, so
    // that browsers which read them are asked about them again, then update both values here. For a
    // change not worth asking about again (a typo), update only the fingerprint.
    expect({ version: TOUR_VERSION, fingerprint }).toEqual({ version: 46, fingerprint: '778229addfbc' });
  });
});
