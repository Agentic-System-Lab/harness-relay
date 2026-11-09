import { describe, expect, it } from 'vitest';
import type { ConversationSchedule, ScheduleRepeat } from '../src/shared/types';
import { nextRun, parseTime, upcomingRuns, validTimeZone, zonedParts, zonedTime } from '../src/shared/schedule';
import { validateSchedule } from '../src/server/validate';
import { withLang } from '../src/server/i18n';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import {
  describeRepeat,
  draftChanged,
  draftFrom,
  draftProblems,
  formatWhen,
  fromLocalInput,
  localInput,
  previewRuns,
  scheduleState,
  scheduleTrouble,
  sidebarScheduleTitle,
  toUpdate,
} from '../src/web/schedule';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Monday 5 January 2026, 08:00 UTC. */
const MON = Date.UTC(2026, 0, 5, 8, 0);

const at = (repeat: ScheduleRepeat, timeZone = 'UTC', updatedAt = MON) => ({ repeat, timeZone, updatedAt });

describe('times of day and time zones', () => {
  it('reads HH:MM on a 24-hour clock, and knows real time zones', () => {
    expect(parseTime('09:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseTime('23:59')).toEqual({ hour: 23, minute: 59 });
    for (const bad of ['24:00', '9:05', '09:60', '0905', '']) expect(parseTime(bad)).toBeUndefined();
    expect(validTimeZone('Asia/Taipei')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
    expect(validTimeZone('')).toBe(false);
  });

  it('turns a wall-clock time in a time zone into the moment it stands for', () => {
    expect(zonedTime(2026, 1, 5, 9, 0, 'Asia/Taipei')).toBe(Date.UTC(2026, 0, 5, 1, 0));
    expect(zonedTime(2026, 7, 1, 9, 0, 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 13, 0)); // EDT
    expect(zonedTime(2026, 1, 5, 9, 0, 'America/New_York')).toBe(Date.UTC(2026, 0, 5, 14, 0)); // EST
    expect(zonedParts(Date.UTC(2026, 0, 4, 23, 30), 'Asia/Taipei')).toEqual({
      year: 2026,
      month: 1,
      day: 5,
      hour: 7,
      minute: 30,
      second: 0,
      weekday: 1,
    });
  });

  it('moves a time the clocks skip forward, and takes the first of a time that happens twice', () => {
    // 8 March 2026, New York: 02:00 EST becomes 03:00 EDT, so 02:30 does not exist.
    const skipped = zonedTime(2026, 3, 8, 2, 30, 'America/New_York');
    expect(zonedParts(skipped, 'America/New_York')).toMatchObject({ hour: 3, minute: 30 });
    // 1 November 2026: 02:00 EDT becomes 01:00 EST, so 01:30 happens twice; the first is EDT.
    expect(zonedTime(2026, 11, 1, 1, 30, 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });
});

describe('nextRun', () => {
  it('sends a daily schedule today if its time is still to come, otherwise tomorrow', () => {
    const daily = at({ kind: 'daily', time: '09:00' });
    expect(nextRun(daily, MON)).toBe(Date.UTC(2026, 0, 5, 9, 0));
    expect(nextRun(daily, Date.UTC(2026, 0, 5, 9, 0))).toBe(Date.UTC(2026, 0, 6, 9, 0)); // exactly then: the next one
    expect(nextRun(at({ kind: 'daily', time: '09:00' }, 'Asia/Taipei'), MON)).toBe(Date.UTC(2026, 0, 6, 1, 0)); // 16:00 there now
  });

  it('keeps the wall-clock time across a change of clocks', () => {
    const daily = at({ kind: 'daily', time: '09:00' }, 'America/New_York');
    const before = Date.UTC(2026, 2, 7, 15, 0); // Saturday 7 March, 10:00 EST
    expect(nextRun(daily, before)).toBe(Date.UTC(2026, 2, 8, 13, 0)); // Sunday 09:00 EDT
  });

  it('sends a weekly schedule on its days only, into next week when they have passed', () => {
    const mwf = at({ kind: 'weekly', time: '09:00', days: [1, 3, 5] });
    expect(upcomingRuns(mwf, MON, 4)).toEqual([
      Date.UTC(2026, 0, 5, 9, 0),
      Date.UTC(2026, 0, 7, 9, 0),
      Date.UTC(2026, 0, 9, 9, 0),
      Date.UTC(2026, 0, 12, 9, 0),
    ]);
    // Monday after 09:00, with only Monday chosen: a week later.
    expect(nextRun(at({ kind: 'weekly', time: '09:00', days: [1] }), MON + 2 * HOUR)).toBe(Date.UTC(2026, 0, 12, 9, 0));
    expect(nextRun(at({ kind: 'weekly', time: '09:00', days: [] }), MON)).toBeUndefined();
  });

  it('repeats an interval from when the schedule was saved, whatever time it is asked', () => {
    const every6 = at({ kind: 'interval', hours: 6 });
    expect(nextRun(every6, MON)).toBe(MON + 6 * HOUR);
    expect(nextRun(every6, MON + 6 * HOUR)).toBe(MON + 12 * HOUR);
    expect(nextRun(every6, MON + 3 * DAY + 1)).toBe(MON + 3 * DAY + 6 * HOUR);
    expect(nextRun(every6, MON - HOUR)).toBe(MON + 6 * HOUR); // a clock that went back
  });

  it('goes to the next day after the first of a time that happens twice', () => {
    const daily = at({ kind: 'daily', time: '01:30' }, 'America/New_York');
    const first = Date.UTC(2026, 10, 1, 5, 30); // 1 November, 01:30 EDT
    expect(nextRun(daily, first - 1)).toBe(first);
    expect(nextRun(daily, first)).toBe(Date.UTC(2026, 10, 2, 6, 30)); // not the second 01:30 (EST) that night
  });

  it('moves a time skipped at midnight or by half an hour forward by the jump', () => {
    // Santiago: on 6 September 2026 midnight becomes 01:00, so 00:30 is 01:30.
    const santiago = nextRun(at({ kind: 'daily', time: '00:30' }, 'America/Santiago'), Date.UTC(2026, 8, 5, 12));
    expect(santiago).toBe(Date.UTC(2026, 8, 6, 4, 30));
    expect(zonedParts(santiago!, 'America/Santiago')).toMatchObject({ day: 6, hour: 1, minute: 30 });
    // Lord Howe: on 4 October 2026 02:00 becomes 02:30, so 02:15 is 02:45.
    const lordHowe = nextRun(at({ kind: 'daily', time: '02:15' }, 'Australia/Lord_Howe'), Date.UTC(2026, 9, 3, 12));
    expect(zonedParts(lordHowe!, 'Australia/Lord_Howe')).toMatchObject({ day: 4, hour: 2, minute: 45 });
  });

  it('keeps a weekly time across a change of clocks, and reads the weekday where the schedule is', () => {
    const sundays = at({ kind: 'weekly', time: '09:00', days: [0] }, 'America/New_York');
    expect(upcomingRuns(sundays, Date.UTC(2026, 1, 28), 2)).toEqual([Date.UTC(2026, 2, 1, 14, 0), Date.UTC(2026, 2, 8, 13, 0)]);
    // Monday 08:00 in Tokyo is still Sunday in UTC.
    const tokyoMondays = at({ kind: 'weekly', time: '08:00', days: [1] }, 'Asia/Tokyo');
    expect(nextRun(tokyoMondays, Date.UTC(2026, 0, 4, 12))).toBe(Date.UTC(2026, 0, 4, 23, 0));
  });

  it('sends a one-time schedule once, if its time is still to come', () => {
    expect(nextRun(at({ kind: 'once', at: MON + HOUR }), MON)).toBe(MON + HOUR);
    expect(nextRun(at({ kind: 'once', at: MON + HOUR }), MON + HOUR)).toBeUndefined();
    expect(upcomingRuns(at({ kind: 'once', at: MON + HOUR }), MON, 3)).toEqual([MON + HOUR]);
  });

  it('never sends a schedule whose time or time zone it cannot read', () => {
    expect(nextRun(at({ kind: 'daily', time: '25:00' }), MON)).toBeUndefined();
    expect(nextRun(at({ kind: 'daily', time: '09:00' }, 'Nowhere/Land'), MON)).toBeUndefined();
  });
});

describe('validateSchedule', () => {
  const valid = { text: ' check the build ', repeat: { kind: 'daily', time: '09:00' }, timeZone: 'Asia/Taipei' };
  const message = (input: unknown) => {
    try {
      withLang('en', () => validateSchedule(input, MON));
    } catch (e) {
      return (e as Error).message;
    }
    return 'ok';
  };

  it('trims the message and fills in the defaults: on, refuse approvals, skip missed times', () => {
    expect(validateSchedule(valid, MON)).toEqual({
      text: 'check the build',
      repeat: { kind: 'daily', time: '09:00' },
      timeZone: 'Asia/Taipei',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
    });
    expect(validateSchedule({ ...valid, enabled: false, approvals: 'ask', missed: 'run' }, MON)).toMatchObject({
      enabled: false,
      approvals: 'ask',
      missed: 'run',
    });
    // Days come back once each, in order.
    expect(validateSchedule({ ...valid, repeat: { kind: 'weekly', time: '18:30', days: [5, 1, 5] } }, MON).repeat).toEqual({
      kind: 'weekly',
      time: '18:30',
      days: [1, 5],
    });
    // Without a time zone, the server's.
    expect(validTimeZone(validateSchedule({ ...valid, timeZone: '' }, MON).timeZone)).toBe(true);
  });

  it('refuses what could never send', () => {
    expect(message({ ...valid, text: '  ' })).toMatch(/Type the message/);
    expect(message({ ...valid, text: 'x'.repeat(4001) })).toMatch(/at most 4000/);
    expect(message({ ...valid, repeat: { kind: 'hourly' } })).toMatch(/does not say when/);
    expect(message({ ...valid, repeat: undefined })).toMatch(/does not say when/);
    expect(message({ ...valid, repeat: { kind: 'daily', time: '9am' } })).toMatch(/HH:MM/);
    expect(message({ ...valid, repeat: { kind: 'weekly', time: '09:00', days: [] } })).toMatch(/at least one day/);
    expect(message({ ...valid, repeat: { kind: 'weekly', time: '09:00', days: [7] } })).toMatch(/at least one day/);
    expect(message({ ...valid, repeat: { kind: 'interval', hours: 0 } })).toMatch(/1 to 168/);
    expect(message({ ...valid, repeat: { kind: 'interval', hours: 1.5 } })).toMatch(/1 to 168/);
    expect(message({ ...valid, repeat: { kind: 'once', at: 'soon' } })).toMatch(/Pick a date/);
    expect(message({ ...valid, repeat: { kind: 'once', at: MON - 1 } })).toMatch(/has passed/);
    expect(message({ ...valid, timeZone: 'Mars/Olympus' })).toMatch(/Unknown time zone/);
  });

  it('keeps a past one-time schedule that is switched off', () => {
    expect(message({ ...valid, enabled: false, repeat: { kind: 'once', at: MON - 1 } })).toBe('ok');
  });
});

describe('the schedule form', () => {
  const saved: ConversationSchedule = {
    text: '@Reviewer look at yesterday',
    repeat: { kind: 'weekly', time: '18:30', days: [5, 1] },
    timeZone: 'Asia/Taipei',
    lang: 'zh-TW',
    enabled: true,
    approvals: 'ask',
    missed: 'run',
    updatedAt: MON,
    nextRunAt: MON + DAY,
  };

  it('starts a new schedule on weekdays at 09:00, and reads a saved one back unchanged', () => {
    const fresh = draftFrom(undefined, MON, 'UTC');
    expect(fresh).toMatchObject({ kind: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5], enabled: true, approvals: 'deny', missed: 'skip' });
    expect(draftChanged(fresh, undefined)).toBe(true);

    const draft = draftFrom(saved, MON);
    expect(toUpdate(draft)).toEqual({
      text: saved.text,
      repeat: { kind: 'weekly', time: '18:30', days: [1, 5] },
      timeZone: 'Asia/Taipei',
      enabled: true,
      approvals: 'ask',
      missed: 'run',
    });
    expect(draftChanged(draft, { ...saved, repeat: { kind: 'weekly', time: '18:30', days: [1, 5] } })).toBe(false);
    expect(draftChanged({ ...draft, text: 'other' }, saved)).toBe(true);
    // Switching kinds keeps the other kinds' fields.
    expect(toUpdate({ ...draft, kind: 'interval' }).repeat).toEqual({ kind: 'interval', hours: 6 });
  });

  it("shows a schedule's times in its own time zone", () => {
    expect(formatWhen(Date.UTC(2026, 0, 5, 1, 0), 'en', 'Asia/Taipei')).toMatch(/09:00/);
    expect(formatWhen(Date.UTC(2026, 0, 5, 1, 0), 'en', 'UTC')).toMatch(/01:00/);
    expect(formatWhen(Date.UTC(2026, 0, 5, 1, 0), 'en', 'Nowhere/Land')).toBeTruthy(); // falls back to this browser's
  });

  it('turns a date and time typed in the browser into a moment and back', () => {
    const value = localInput(MON);
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(value)).toBe(MON);
    expect(fromLocalInput('tomorrow')).toBeNaN();
  });

  it('says what keeps it from being saved, like the server', () => {
    const draft = draftFrom(undefined, MON, 'UTC');
    const p = en.schedule.problems;
    expect(draftProblems(draft, MON, en)).toEqual([p.text]);
    expect(draftProblems({ ...draft, text: 'go', days: [], time: '' }, MON, en)).toEqual([p.days, p.time]);
    expect(draftProblems({ ...draft, text: 'go', kind: 'interval', hours: 200 }, MON, en)).toEqual([p.hours(168)]);
    expect(draftProblems({ ...draft, text: 'go', kind: 'once', at: localInput(MON - HOUR) }, MON, en)).toEqual([p.past]);
    expect(draftProblems({ ...draft, text: 'go', kind: 'once', at: localInput(MON - HOUR), enabled: false }, MON, en)).toEqual([]);
    expect(draftProblems({ ...draft, text: 'go', kind: 'once', at: '' }, MON, en)).toEqual([p.moment]);
    expect(previewRuns({ ...draft, text: 'go', kind: 'interval', hours: 2 }, MON)).toEqual([MON + 2 * HOUR, MON + 4 * HOUR, MON + 6 * HOUR]);
    // A saved interval whose times stay the same keeps its cadence, as the server does on saving.
    const every6: ConversationSchedule = { ...saved, repeat: { kind: 'interval', hours: 6 }, updatedAt: MON - 2 * HOUR };
    const editing = { ...draftFrom(every6, MON), text: 'another message' };
    expect(previewRuns(editing, MON, every6)).toEqual([MON + 4 * HOUR, MON + 10 * HOUR, MON + 16 * HOUR]);
    expect(previewRuns({ ...editing, hours: 3 }, MON, every6)[0]).toBe(MON + 3 * HOUR); // new times: from now
  });

  it('describes when it sends in a few words, Monday first', () => {
    expect(describeRepeat({ kind: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5] }, en, 'en')).toBe('Weekdays at 09:00');
    expect(describeRepeat({ kind: 'weekly', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }, en, 'en')).toBe('Every day at 09:00');
    expect(describeRepeat({ kind: 'weekly', time: '18:30', days: [0, 3, 1] }, zhTW, 'zh-TW')).toBe('每週一、三、日 18:30');
    expect(describeRepeat({ kind: 'daily', time: '07:15' }, zhTW, 'zh-TW')).toBe('每天 07:15');
    expect(describeRepeat({ kind: 'interval', hours: 1 }, en, 'en')).toBe('Every hour');
    expect(describeRepeat({ kind: 'interval', hours: 6 }, zhTW, 'zh-TW')).toBe('每 6 小時');
  });

  it('tells a schedule that needs a look from one that is fine, paused or done', () => {
    expect(scheduleTrouble({ lastResult: 'sent' })).toBe(false);
    expect(scheduleTrouble({ lastResult: 'queued' })).toBe(false);
    for (const r of ['missed', 'skipped', 'failed'] as const) expect(scheduleTrouble({ lastResult: r })).toBe(true);
    expect(scheduleState({ ...saved, enabled: false }, en, 'en')).toBe('paused');
    expect(scheduleState({ ...saved, repeat: { kind: 'once', at: MON }, enabled: false, nextRunAt: undefined, lastRunAt: MON }, en, 'en')).toBe('done');
    // Changed to a one-time schedule, switched off: the earlier time it came due does not make it done.
    expect(scheduleState({ ...saved, repeat: { kind: 'once', at: MON + DAY }, enabled: false, nextRunAt: undefined, lastRunAt: MON }, en, 'en')).toBe('paused');
    expect(scheduleState(saved, en, 'en')).toMatch(/^next /);
    expect(sidebarScheduleTitle({ enabled: true, nextRunAt: MON, lastResult: 'failed' }, en, 'en')).toBe('Schedule last time: could not be sent');
    expect(sidebarScheduleTitle({ enabled: false }, en, 'en')).toBe('Schedule paused');
  });
});
