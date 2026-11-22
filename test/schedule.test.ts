import { describe, expect, it } from 'vitest';
import type { ConversationSchedule, ScheduleRepeat, ScheduleTrigger, ScheduleWatch } from '../src/shared/types';
import { nextRun, parseTime, triggerKey, upcomingRuns, validTimeZone, zonedParts, zonedTime } from '../src/shared/schedule';
import { validateSchedule } from '../src/server/validate';
import { withLang } from '../src/server/i18n';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import {
  combinedWatch,
  describeRepeat,
  describeTriggers,
  editTriggers,
  scheduleStatus,
  triggerOf,
  triggerStates,
  scheduleBadgeTitle,
  shownEvent,
  EMPTY_TRIGGER,
  draftChanged,
  draftFrom,
  draftProblems,
  forgetHandedHook,
  formatWhen,
  handOverHook,
  handedHook,
  fromLocalInput,
  hookExample,
  localInput,
  previewRuns,
  scheduleState,
  scheduleTrouble,
  shownZone,
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

  it('trims the message and fills in the defaults: on, refuse approvals, skip missed times, in this chat', () => {
    expect(validateSchedule(valid, MON)).toEqual({
      text: 'check the build',
      repeat: { kind: 'daily', time: '09:00' },
      timeZone: 'Asia/Taipei',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
    });
    expect(validateSchedule({ ...valid, enabled: false, approvals: 'ask', missed: 'run', newChat: true }, MON)).toMatchObject({
      enabled: false,
      approvals: 'ask',
      missed: 'run',
      newChat: true,
    });
    // Only a real true opens a new chat each time.
    expect(validateSchedule({ ...valid, newChat: 'yes' }, MON).newChat).toBe(false);
    // A fixed command's id goes through (the route checks it is the chat's own); anything else is refused.
    expect(validateSchedule({ ...valid, command: 'c-1_2' }, MON).command).toBe('c-1_2');
    expect(validateSchedule({ ...valid, command: null }, MON)).not.toHaveProperty('command');
    expect(message({ ...valid, command: '../x' })).toMatch(/command/);
    expect(message({ ...valid, command: 5 })).toMatch(/command/);
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

  it('takes what an automation waits for: a new mail in a folder of an account, with conditions', () => {
    const repeat = (trigger: unknown) =>
      withLang('en', () => validateSchedule({ ...valid, repeat: { kind: 'event', trigger } }, MON).repeat);
    // One trigger alone, as automations were saved before they could wait for several: read as the only one.
    expect(repeat({ source: 'mail', account: 'work' })).toEqual({
      kind: 'event',
      triggers: [{ source: 'mail', account: 'work', folder: 'INBOX' }],
    });
    expect(repeat({ source: 'mail', account: 'work', folder: ' Alerts ', from: ' bob ', subject: '' })).toEqual({
      kind: 'event',
      triggers: [{ source: 'mail', account: 'work', folder: 'Alerts', from: 'bob' }],
    });
    expect(message({ ...valid, repeat: { kind: 'event', triggers: [{ source: 'mail' }] } })).toMatch(
      /pick a source, and its account or calendar/,
    );
    expect(message({ ...valid, repeat: { kind: 'event', triggers: [{ source: 'rss', account: 'work' }] } })).toMatch(
      /pick a source, and its account or calendar/,
    );
    expect(message({ ...valid, repeat: { kind: 'event', triggers: [{ source: 'mail', account: 'work', from: 'a\r\nb' }] } })).toMatch(
      /from/,
    );
    expect(
      message({ ...valid, repeat: { kind: 'event', triggers: [{ source: 'mail', account: 'work', subject: 'x'.repeat(201) }] } }),
    ).toMatch(/subject/);
  });

  it('takes several things to wait for, each as one is taken: 1 to 5, no two for the same source', () => {
    const several = (triggers: unknown) =>
      withLang('en', () => validateSchedule({ ...valid, repeat: { kind: 'event', triggers } }, MON).repeat);
    const inbox = { source: 'mail', account: 'work' };
    const csv = { source: 'file', pattern: './reports/*.csv' };
    expect(several([inbox, csv, { source: 'github', repo: 'octo/app', on: 'pr' }])).toEqual({
      kind: 'event',
      triggers: [
        { source: 'mail', account: 'work', folder: 'INBOX' },
        { source: 'file', pattern: 'reports/*.csv' },
        { source: 'github', repo: 'octo/app', on: 'pr' },
      ],
    });
    // Each is checked as one alone is.
    expect(message({ ...valid, repeat: { kind: 'event', triggers: [inbox, { source: 'file', pattern: '../x' }] } })).toMatch(/pattern/);
    // None, too many, or not a list.
    expect(message({ ...valid, repeat: { kind: 'event', triggers: [] } })).toBe('An automation waits for 1 to 5 things');
    const six = Array.from({ length: 6 }, (_, i) => ({ source: 'file', pattern: `${i}/*.csv` }));
    expect(message({ ...valid, repeat: { kind: 'event', triggers: six } })).toBe('An automation waits for 1 to 5 things');
    expect(several(six.slice(0, 5)).kind).toBe('event');
    expect(message({ ...valid, repeat: { kind: 'event', triggers: inbox } })).toMatch(/pick a source, and its account or calendar/);
    expect(message({ ...valid, repeat: { kind: 'event' } })).toMatch(/pick a source, and its account or calendar/);
    // The same source twice, as its key has it: other conditions, another case of a repository, ./ before a pattern.
    const same = /^Two of the things to wait for are the same/;
    expect(message({ ...valid, repeat: { kind: 'event', triggers: [inbox, { ...inbox, from: 'bob' }] } })).toMatch(same);
    expect(message({ ...valid, repeat: { kind: 'event', triggers: [csv, { source: 'file', pattern: 'reports/*.csv' }] } })).toMatch(same);
    expect(
      message({
        ...valid,
        repeat: {
          kind: 'event',
          triggers: [
            { source: 'github', repo: 'Octo/App', on: 'pr' },
            { source: 'github', repo: 'octo/app', on: 'pr' },
          ],
        },
      }),
    ).toMatch(same);
    // The inbox in any letter case is the one inbox, written INBOX (its key too): twice is the same
    // thing. Any other folder keeps its case, and another case is another folder.
    expect(several([{ ...inbox, folder: ' inbox ' }])).toEqual({
      kind: 'event',
      triggers: [{ source: 'mail', account: 'work', folder: 'INBOX' }],
    });
    expect(message({ ...valid, repeat: { kind: 'event', triggers: [inbox, { ...inbox, folder: 'Inbox' }] } })).toMatch(same);
    expect(triggerKey({ source: 'mail', account: 'work', folder: 'inbox' })).toBe(
      triggerKey({ source: 'mail', account: 'work', folder: 'INBOX' }),
    );
    expect(
      several([
        { ...inbox, folder: 'Alerts' },
        { ...inbox, folder: 'alerts' },
      ]),
    ).toEqual({
      kind: 'event',
      triggers: [
        { source: 'mail', account: 'work', folder: 'Alerts' },
        { source: 'mail', account: 'work', folder: 'alerts' },
      ],
    });
    // Another folder, or pull requests beside failed runs, are other things.
    expect(several([inbox, { ...inbox, folder: 'Alerts' }]).kind).toBe('event');
    expect(
      several([
        { source: 'github', repo: 'o/a', on: 'pr' },
        { source: 'github', repo: 'o/a', on: 'ci' },
      ]).kind,
    ).toBe('event');
    expect(() => withLang('zh-TW', () => validateSchedule({ ...valid, repeat: { kind: 'event', triggers: [] } }, MON))).toThrow(
      '一個自動任務可以等 1 到 5 件事',
    );
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
    newChat: false,
    updatedAt: MON,
    nextRunAt: MON + DAY,
  };

  it('starts a new schedule with no set times (weekdays at 09:00 ready for another kind), and reads a saved one back unchanged', () => {
    const fresh = draftFrom(undefined, MON, 'UTC');
    expect(fresh).toMatchObject({
      kind: 'manual',
      time: '09:00',
      days: [1, 2, 3, 4, 5],
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
    });
    expect(draftChanged(fresh, undefined)).toBe(true);

    const draft = draftFrom(saved, MON);
    expect(toUpdate(draft)).toEqual({
      text: saved.text,
      repeat: { kind: 'weekly', time: '18:30', days: [1, 5] },
      timeZone: 'Asia/Taipei',
      enabled: true,
      approvals: 'ask',
      missed: 'run',
      newChat: false,
    });
    expect(draftChanged(draft, { ...saved, repeat: { kind: 'weekly', time: '18:30', days: [1, 5] } })).toBe(false);
    expect(draftChanged({ ...draft, text: 'other' }, saved)).toBe(true);
    // Opening a new chat each time is a change to save, and is read back.
    expect(draftChanged({ ...draft, newChat: true }, saved)).toBe(true);
    expect(draftFrom({ ...saved, newChat: true }, MON).newChat).toBe(true);
    // Switching kinds keeps the other kinds' fields.
    expect(toUpdate({ ...draft, kind: 'interval' }).repeat).toEqual({ kind: 'interval', hours: 6 });
  });

  it('reads a goal back, saves it trimmed, leaves out an empty one, and says when it is too long', () => {
    const draft = draftFrom({ ...saved, goal: 'CI passes' }, MON);
    expect(draft.goal).toBe('CI passes');
    expect(toUpdate({ ...draft, goal: '  Ship it  ' }).goal).toBe('Ship it');
    expect(toUpdate({ ...draft, goal: '   ' })).not.toHaveProperty('goal');
    // A fixed command to run first, on the schedule's own times only, never for what it waits for.
    expect(toUpdate({ ...draft, kind: 'daily', command: 'cmd-1' }).command).toBe('cmd-1');
    expect(toUpdate({ ...draft, kind: 'event', command: 'cmd-1' })).not.toHaveProperty('command');
    expect(toUpdate({ ...draft, command: '' })).not.toHaveProperty('command');
    expect(draftChanged({ ...draft, goal: 'other' }, { ...saved, goal: 'CI passes' })).toBe(true);
    expect(draftChanged(draft, { ...saved, goal: 'CI passes' })).toBe(false);
    expect(draftProblems({ ...draft, goal: 'x'.repeat(2001) }, MON, en)).toContain('A goal can be at most 2000 characters');
  });

  it("hands the webhook New automation made to that automation's chat alone, until it was shown", () => {
    const made = { token: 't0k', url: 'http://127.0.0.1:8787/api/hooks/c1', hook: { createdAt: 1 }, platform: 'darwin' };
    expect(handedHook('c1')).toBeUndefined();
    handOverHook('c1', made);
    expect(handedHook('c2')).toBeUndefined();
    // Read as often as the page renders, until the drawer showed it.
    expect(handedHook('c1')).toBe(made);
    expect(handedHook('c1')).toBe(made);
    forgetHandedHook('c1');
    expect(handedHook('c1')).toBeUndefined();
  });

  it('has no set times when the user only wants Run once now and the webhook: never due, never off, said so everywhere', () => {
    const manual: ScheduleRepeat = { kind: 'manual' };
    expect(nextRun(at(manual), MON)).toBeUndefined();
    expect(upcomingRuns(at(manual), MON, 3)).toEqual([]);
    // Saved as it is, with nothing else asked for: no time, no day, and on whatever the box said.
    expect(withLang('en', () => validateSchedule({ text: 'check CI', repeat: manual, enabled: true }, MON).repeat)).toEqual(manual);
    const draft = { ...draftFrom(undefined, MON, 'UTC'), text: 'check CI', kind: 'manual' as const, time: '', days: [], enabled: false };
    expect(draftProblems(draft, MON, en)).toEqual([]);
    expect(toUpdate(draft)).toMatchObject({ repeat: manual, enabled: true });
    expect(describeRepeat(manual, en, 'en')).toBe('No set times');
    expect(describeRepeat(manual, zhTW, 'zh-TW')).toBe('不定時');
    const manualSaved: ConversationSchedule = { ...saved, repeat: manual, enabled: true, nextRunAt: undefined };
    expect(scheduleState(manualSaved, en, 'en')).toBe('sent by Run once now or its webhook');
    // Switched off by its reached goal, saving it as it is turns it on again.
    expect(draftChanged(draftFrom(manualSaved, MON), manualSaved)).toBe(false);
    const manualOff = { ...manualSaved, enabled: false };
    expect(draftChanged(draftFrom(manualOff, MON), manualOff)).toBe(true);
    expect(toUpdate(draftFrom(manualOff, MON)).enabled).toBe(true);
    expect(scheduleState(manualOff, en, 'en')).toBe('paused');
    expect(sidebarScheduleTitle({ enabled: true, manual: true }, en, 'en')).toBe('Automation: no set times (Run once now or its webhook)');
    expect(sidebarScheduleTitle({ enabled: true, manual: true }, zhTW, 'zh-TW')).toBe('自動任務：不定時（立即執行一次或 webhook）');
  });

  it('waits for something to happen: never due, its trigger saved trimmed, said in a few words everywhere', () => {
    const event: ScheduleRepeat = { kind: 'event', triggers: [{ source: 'mail', account: 'work', folder: 'INBOX', from: 'github.com' }] };
    expect(nextRun(at(event), MON)).toBeUndefined();
    expect(upcomingRuns(at(event), MON, 3)).toEqual([]);
    // The form: an account to pick first; the inbox when no folder is given; conditions trimmed, empty ones left out.
    const draft = { ...draftFrom(undefined, MON, 'UTC'), text: 'triage it', kind: 'event' as const };
    expect(draftProblems(draft, MON, en)).toEqual(['Pick the mail account to check']);
    const filled = { ...draft, triggers: [{ ...EMPTY_TRIGGER, account: 'work', folder: ' ', from: ' github.com ', subject: '  ' }] };
    expect(draftProblems(filled, MON, en)).toEqual([]);
    expect(toUpdate(filled).repeat).toEqual(event);
    const saved2: ConversationSchedule = { ...saved, repeat: event, nextRunAt: undefined };
    expect(draftFrom(saved2, MON).triggers).toEqual([{ ...EMPTY_TRIGGER, account: 'work', from: 'github.com' }]);
    expect(draftChanged(draftFrom(saved2, MON), saved2)).toBe(false);
    expect(describeRepeat(event, en, 'en')).toBe('When a new mail from github.com arrives');
    expect(
      describeRepeat({ kind: 'event', triggers: [{ source: 'mail', account: 'w', folder: 'INBOX', subject: 'CI' }] }, zhTW, 'zh-TW'),
    ).toBe('收到主旨含「CI」的新郵件時');
    // A folder other than the inbox is named.
    const alerts: ScheduleRepeat = {
      kind: 'event',
      triggers: [{ source: 'mail', account: 'w', folder: 'Alerts', from: 'bot', subject: 'CI' }],
    };
    expect(describeRepeat(alerts, en, 'en')).toBe('When a new mail from bot with "CI" in its subject arrives in Alerts');
    expect(describeRepeat(alerts, zhTW, 'zh-TW')).toBe('「Alerts」收到 bot 寄來、主旨含「CI」的新郵件時');
    expect(describeRepeat(event, zhTW, 'zh-TW')).toBe('收到 github.com 寄來的新郵件時');
    // Its state: how its checks go.
    expect(scheduleState(saved2, en, 'en')).toMatch(/^Not checked yet/);
    const key = triggerKey(event.triggers[0]!);
    const checked = { ...saved2, watches: [{ key, checkedAt: MON, nextCheckAt: MON + 120_000 }] };
    expect(scheduleState(checked, en, 'en')).toBe(`Checked ${formatWhen(MON, 'en')} · next check ${formatWhen(MON + 120_000, 'en')}`);
    const failing = { ...checked, watches: [{ ...checked.watches[0]!, error: 'Connection refused' }] };
    expect(scheduleState(failing, en, 'en')).toBe('The check failed: Connection refused');
    expect(scheduleTrouble(failing)).toBe(true);
    expect(scheduleState({ ...checked, watches: [{ ...checked.watches[0]!, held: 'the team is busy' }] }, en, 'en')).toMatch(
      /Something new is waiting until the team can take it \(the team is busy\)$/,
    );
    expect(scheduleState({ ...checked, enabled: false }, en, 'en')).toBe('paused');
    // The mail server says when mail arrives (IMAP IDLE).
    expect(scheduleState({ ...checked, watches: [{ ...checked.watches[0]!, listening: true }] }, en, 'en')).toMatch(
      / · the mail server says at once when mail arrives$/,
    );
    expect(scheduleState({ ...checked, watches: [{ ...checked.watches[0]!, listening: true }] }, zhTW, 'zh-TW')).toMatch(
      /郵件伺服器收到郵件時會馬上通知$/,
    );
    // Off, a failed check is no trouble: nothing checks it.
    expect(scheduleTrouble({ ...failing, enabled: false })).toBe(false);
    // The badge's title says what is wrong: the check, not the last time it sent.
    expect(scheduleBadgeTitle({ ...failing, lastResult: 'sent', lastRunAt: MON }, en, 'en')).toBe(
      'When a new mail from github.com arrives · The check failed: Connection refused',
    );
    expect(scheduleBadgeTitle({ ...checked, lastResult: 'sent', lastRunAt: MON }, en, 'en')).toBe(
      `When a new mail from github.com arrives · ${scheduleState(checked, en, 'en')}`,
    );
    expect(sidebarScheduleTitle({ enabled: false, triggers: event.triggers, lastResult: 'sent' }, en, 'en')).toBe('Automation paused');
    // What a trigger found reads back in the chat; a webhook's body as it came.
    expect(shownEvent('{"from":"Ann \\u003cann@example.com>"}', 'mail')).toBe('{\n  "from": "Ann <ann@example.com>"\n}');
    expect(shownEvent('{"a":"\\u003c"}', 'webhook')).toBe('{"a":"\\u003c"}');
    expect(shownEvent('{"a":"\\u003c"}')).toBe('{"a":"\\u003c"}');
    expect(shownEvent('not json', 'mail')).toBe('not json');
    // The sidebar says what it waits for, or that its last check failed.
    expect(sidebarScheduleTitle({ enabled: true, triggers: event.triggers }, en, 'en')).toBe(
      'Automation: when a new mail from github.com arrives',
    );
    expect(sidebarScheduleTitle({ enabled: true, triggers: event.triggers }, zhTW, 'zh-TW')).toBe(
      '自動任務：收到 github.com 寄來的新郵件時',
    );
    expect(sidebarScheduleTitle({ enabled: true, triggers: event.triggers, watchError: true }, en, 'en')).toBe(
      'Automation: its last check failed',
    );
  });

  it('waits for several things: each in the form (added, removed, its problems), joined with "or" everywhere, and each one\'s checks', () => {
    const draft = { ...draftFrom(undefined, MON, 'UTC'), text: 'triage it', kind: 'event' as const };
    const inbox = { ...EMPTY_TRIGGER, account: 'work' };
    // Another one: the last one's source, empty, with the first one's account; at most 5; the last one stays.
    const two = { ...draft, triggers: editTriggers({ triggers: [inbox] }, { add: true }) };
    expect(two.triggers).toEqual([inbox, { ...EMPTY_TRIGGER, account: 'work' }]);
    let five = two.triggers;
    for (let i = 0; i < 5; i++) five = editTriggers({ triggers: five }, { add: true });
    expect(five).toHaveLength(5);
    expect(editTriggers({ triggers: [inbox] }, { remove: 0 })).toEqual([inbox]);
    expect(editTriggers({ triggers: [inbox, { ...inbox, folder: 'Alerts' }] }, { remove: 0 })).toEqual([{ ...inbox, folder: 'Alerts' }]);
    // The new box once the others are filled in: the last one's source with every field empty (not a
    // copy of it), the mail account and calendar the first one's.
    const filled = [
      { ...EMPTY_TRIGGER, account: 'work', folder: 'Alerts', from: 'bank', subject: 'due', calendar: 'home' },
      { ...EMPTY_TRIGGER, source: 'file' as const, account: 'other', calendar: 'team', minutes: 30, pattern: 'invoices/*.pdf' },
    ];
    const added = editTriggers({ triggers: filled }, { add: true });
    expect(added).toEqual([...filled, { ...EMPTY_TRIGGER, source: 'file', account: 'work', calendar: 'home' }]);
    // Remove takes away that one alone, wherever it is.
    expect(editTriggers({ triggers: added }, { remove: 1 })).toEqual([filled[0], added[2]]);
    // The same folder twice is one thing; each problem says which thing it is about.
    expect(draftProblems(two, MON, en)).toEqual([
      'Two of the things to wait for are the same (the same source, such as the same mail account and folder, or the same file pattern): change or remove one',
    ]);
    const mixed = {
      ...draft,
      triggers: [
        { ...inbox, account: '' },
        { ...EMPTY_TRIGGER, source: 'file' as const, pattern: '../x' },
      ],
    };
    expect(draftProblems(mixed, MON, en)).toEqual([
      'Thing 1 to wait for: pick the mail account to check',
      'Thing 2 to wait for: give a pattern for files in the working directory (not a full path, and without ..)',
    ]);
    expect(draftProblems(mixed, MON, zhTW)[0]).toBe('要等的第 1 件事：請選擇要檢查的郵件帳號');
    // A pattern as the server keeps it: ./ before it is the same pattern.
    const files = (a: string, b: string) => ({
      ...draft,
      triggers: [
        { ...EMPTY_TRIGGER, source: 'file' as const, pattern: a },
        { ...EMPTY_TRIGGER, source: 'file' as const, pattern: b },
      ],
    });
    expect(draftProblems(files('reports/*.csv', './reports/*.csv'), MON, en)).toHaveLength(1);
    const both = files('invoices/*.pdf', 'reports/*.csv');
    expect(draftProblems(both, MON, en)).toEqual([]);
    const repeat = toUpdate(both).repeat;
    expect(repeat).toEqual({
      kind: 'event',
      triggers: [
        { source: 'file', pattern: 'invoices/*.pdf' },
        { source: 'file', pattern: 'reports/*.csv' },
      ],
    });
    // Read back as it was saved.
    const saved2: ConversationSchedule = { ...saved, repeat, nextRunAt: undefined };
    expect(draftFrom(saved2, MON).triggers.map((tr) => tr.pattern)).toEqual(['invoices/*.pdf', 'reports/*.csv']);
    expect(draftChanged(draftFrom(saved2, MON), saved2)).toBe(false);
    // Said in a few words, joined with "or".
    const mailAndFile: ScheduleRepeat = {
      kind: 'event',
      triggers: [
        { source: 'mail', account: 'work', folder: 'INBOX', from: 'bank' },
        { source: 'file', pattern: 'invoices/*' },
        { source: 'calendar', account: 'home', minutes: 5 },
      ],
    };
    expect(describeRepeat(mailAndFile, en, 'en')).toBe(
      'When a new mail from bank arrives, or when a file matching invoices/* appears or changes in the working directory, or 5 minutes before each event begins',
    );
    expect(describeRepeat(mailAndFile, zhTW, 'zh-TW')).toBe(
      '收到 bank 寄來的新郵件時，或工作目錄中符合 invoices/* 的檔案出現或變動時，或每個行程開始前 5 分鐘',
    );
    expect(describeTriggers(mailAndFile.triggers.slice(0, 1), en)).toBe('When a new mail from bank arrives');
    expect(sidebarScheduleTitle({ enabled: true, triggers: mailAndFile.triggers.slice(0, 2) }, en, 'en')).toBe(
      'Automation: when a new mail from bank arrives, or when a file matching invoices/* appears or changes in the working directory',
    );
    expect(sidebarScheduleTitle({ enabled: true, triggers: mailAndFile.triggers.slice(0, 2) }, zhTW, 'zh-TW')).toBe(
      '自動任務：收到 bank 寄來的新郵件時，或工作目錄中符合 invoices/* 的檔案出現或變動時',
    );
    // How its checks go: each one's, and as one (not yet checked until each is; the first error; the last check, the next one).
    const [mailTr, fileTr] = (mailAndFile as Extract<ScheduleRepeat, { kind: 'event' }>).triggers as [ScheduleTrigger, ScheduleTrigger];
    const twoOf: ConversationSchedule = { ...saved, repeat: { kind: 'event', triggers: [mailTr, fileTr] }, nextRunAt: undefined };
    const mailWatch = { key: triggerKey(mailTr), checkedAt: MON, nextCheckAt: MON + 120_000 };
    expect(scheduleState({ ...twoOf, watches: [mailWatch] }, en, 'en')).toMatch(/^Not checked yet/);
    const fileWatch = { key: triggerKey(fileTr), checkedAt: MON + 60_000, nextCheckAt: MON + 180_000 };
    const checked = { ...twoOf, watches: [mailWatch, fileWatch] };
    expect(scheduleState(checked, en, 'en')).toBe(
      `Checked ${formatWhen(MON + 60_000, 'en')} · next check ${formatWhen(MON + 120_000, 'en')}`,
    );
    expect(triggerStates(checked, en, 'en')).toEqual([
      `When a new mail from bank arrives · Checked ${formatWhen(MON, 'en')} · next check ${formatWhen(MON + 120_000, 'en')}`,
      `When a file matching invoices/* appears or changes in the working directory · Checked ${formatWhen(MON + 60_000, 'en')} · next check ${formatWhen(MON + 180_000, 'en')}`,
    ]);
    const failing = { ...checked, watches: [mailWatch, { ...fileWatch, error: 'disk gone' }] };
    expect(scheduleState(failing, en, 'en')).toBe('The check failed: disk gone');
    expect(scheduleTrouble(failing)).toBe(true);
    expect(scheduleBadgeTitle(failing, en, 'en')).toMatch(/, or when a file matching invoices\/\* .* · The check failed: disk gone$/);
    expect(triggerStates(failing, en, 'en')[1]).toMatch(/ · The check failed: disk gone$/);

    // As one: by the triggers' order (not the order they are kept in), the first error and held item of
    // any, the last check and the next one of any, listening when any mail server does; one alone as it is.
    const asOne = (mail: Partial<ScheduleWatch>, file: Partial<ScheduleWatch>) =>
      combinedWatch({
        ...twoOf,
        watches: [
          { ...fileWatch, ...file },
          { ...mailWatch, ...mail },
        ],
      });
    expect(asOne({}, {})).toEqual({ key: '', checkedAt: MON + 60_000, nextCheckAt: MON + 120_000 });
    expect(asOne({ error: 'mail down' }, { error: 'disk gone' })).toMatchObject({ error: 'mail down' });
    expect(asOne({}, { error: 'disk gone' })).toMatchObject({ error: 'disk gone' });
    expect(asOne({}, { held: 'waits for your answer' })).toMatchObject({ held: 'waits for your answer' });
    expect(asOne({ held: 'the queue is full' }, { held: 'waits for your answer' })).toMatchObject({ held: 'the queue is full' });
    expect(asOne({ listening: true }, {})).toMatchObject({ listening: true });
    expect(asOne({}, {})).not.toHaveProperty('listening');
    const alone = { key: triggerKey(mailTr), checkedAt: MON, nextCheckAt: MON + 900_000, listening: true, held: 'x' };
    expect(combinedWatch({ repeat: { kind: 'event', triggers: [mailTr] }, watches: [alone] })).toBe(alone);
    expect(combinedWatch({ repeat: { kind: 'event', triggers: [mailTr] } })).toBeUndefined();
    expect(combinedWatch({ ...twoOf, watches: [{ ...mailWatch, error: 'x' }] })).toBeUndefined();

    // The automation window: one line for each while it is on, only paused while it is off.
    const status = scheduleStatus(failing, en, 'en');
    expect(status.title).toBe(describeRepeat(twoOf.repeat, en, 'en'));
    expect(status.lines).toEqual(triggerStates(failing, en, 'en'));
    expect(scheduleStatus({ ...failing, enabled: false }, en, 'en')).toEqual({
      title: `${describeRepeat(twoOf.repeat, en, 'en')} · paused`,
      lines: [],
    });
    expect(scheduleStatus({ ...failing, enabled: false }, zhTW, 'zh-TW').title).toBe(
      `${describeRepeat(twoOf.repeat, zhTW, 'zh-TW')} · 已暫停`,
    );
    // One thing to wait for, or another kind: one line, how it goes beside what it does.
    const one = { ...twoOf, repeat: { kind: 'event' as const, triggers: [mailTr] }, watches: [mailWatch] };
    expect(scheduleStatus(one, en, 'en')).toEqual({
      title: `When a new mail from bank arrives · ${scheduleState(one, en, 'en')}`,
      lines: [],
    });
    expect(scheduleStatus(saved, en, 'en')).toEqual({
      title: `${describeRepeat(saved.repeat, en, 'en')} · ${scheduleState(saved, en, 'en')}`,
      lines: [],
    });

    // The inbox in any letter case is the one inbox, written INBOX; other folders keep their case.
    expect(triggerOf({ ...inbox, folder: ' inbox ' })).toEqual({ source: 'mail', account: 'work', folder: 'INBOX' });
    expect(triggerOf({ ...inbox, folder: 'Alerts' })).toEqual({ source: 'mail', account: 'work', folder: 'Alerts' });
    const inboxes = (a: string, b: string) => ({
      ...draft,
      triggers: [
        { ...inbox, folder: a },
        { ...inbox, folder: b },
      ],
    });
    expect(draftProblems(inboxes('INBOX', 'Inbox'), MON, en)).toEqual([en.schedule.problems.sameTrigger]);
    expect(draftProblems(inboxes('Alerts', 'alerts'), MON, en)).toEqual([]);
  });

  it('waits for an event about to begin, a pull request or failed run, or a file: each source in the form and in a few words', () => {
    const draft = { ...draftFrom(undefined, MON, 'UTC'), text: 'prepare', kind: 'event' as const };
    const withTrigger = (t: Partial<typeof EMPTY_TRIGGER>) => ({ ...draft, triggers: [{ ...EMPTY_TRIGGER, ...t }] });
    // A calendar: one to pick, minutes in range, the title's words trimmed.
    expect(draftProblems(withTrigger({ source: 'calendar' }), MON, en)).toEqual(['Pick the calendar to check']);
    expect(draftProblems(withTrigger({ source: 'calendar', calendar: 'home', minutes: 0 }), MON, en)).toEqual([
      'The minutes before an event begins are a whole number from 1 to 1440',
    ]);
    const cal = withTrigger({ source: 'calendar', calendar: 'home', minutes: 15, title: ' standup ' });
    expect(draftProblems(cal, MON, en)).toEqual([]);
    const calRepeat = toUpdate(cal).repeat;
    expect(calRepeat).toEqual({ kind: 'event', triggers: [{ source: 'calendar', account: 'home', minutes: 15, title: 'standup' }] });
    expect(describeRepeat(calRepeat, en, 'en')).toBe('15 minutes before each event with "standup" in its title begins');
    expect(describeRepeat(calRepeat, zhTW, 'zh-TW')).toBe('標題含「standup」的行程開始前 15 分鐘');
    // One minute is a minute.
    expect(describeRepeat({ kind: 'event', triggers: [{ source: 'calendar', account: 'home', minutes: 1 }] }, en, 'en')).toBe(
      '1 minute before each event begins',
    );
    expect(describeRepeat({ kind: 'event', triggers: [{ source: 'calendar', account: 'home', minutes: 1 }] }, zhTW, 'zh-TW')).toBe(
      '每個行程開始前 1 分鐘',
    );
    const savedCal: ConversationSchedule = { ...saved, repeat: calRepeat, nextRunAt: undefined };
    expect(draftFrom(savedCal, MON).triggers[0]).toMatchObject({ source: 'calendar', calendar: 'home', minutes: 15, title: 'standup' });
    expect(draftChanged(draftFrom(savedCal, MON), savedCal)).toBe(false);

    // GitHub: owner/name (or its address), as the server takes it (an owner of at most 39 characters, a
    // name of at most 100), and a branch git allows for CI runs only.
    const badRepo = ['Give the GitHub repository as owner/name (an owner of at most 39 characters, a name of at most 100)'];
    for (const repo of ['not a repo', `${'o'.repeat(40)}/app`, `octo/${'a'.repeat(101)}`, 'octo/..', '-octo/app'])
      expect(draftProblems(withTrigger({ source: 'github', repo }), MON, en)).toEqual(badRepo);
    expect(draftProblems(withTrigger({ source: 'github', repo: `${'o'.repeat(39)}/${'a'.repeat(100)}` }), MON, en)).toEqual([]);
    const badBranch = ['The branch is not a name git allows: no spaces, none of ~^:?*[\\, no .., and not starting with -'];
    for (const branch of ['my branch', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a..b', '-x'])
      expect(draftProblems(withTrigger({ source: 'github', repo: 'octo/app', on: 'ci', branch }), MON, en)).toEqual(badBranch);
    // What git allows beyond letters and digits: slashes, plus signs, @, other scripts.
    for (const branch of ['feature/x+y', 'release@2026', '修正-1', 'v1.2'])
      expect(draftProblems(withTrigger({ source: 'github', repo: 'octo/app', on: 'ci', branch }), MON, en)).toEqual([]);
    // The server agrees with the form, either way.
    const serverTakes = (trigger: Record<string, unknown>) => {
      try {
        withLang('en', () => validateSchedule({ text: 'go', repeat: { kind: 'event', trigger } }, MON));
        return true;
      } catch {
        return false;
      }
    };
    for (const repo of ['not a repo', `${'o'.repeat(40)}/app`, `octo/${'a'.repeat(101)}`, 'octo/..', '-octo/app'])
      expect(serverTakes({ source: 'github', repo, on: 'pr' })).toBe(false);
    expect(serverTakes({ source: 'github', repo: `${'o'.repeat(39)}/${'a'.repeat(100)}`, on: 'pr' })).toBe(true);
    for (const branch of ['my branch', 'a~1', 'a..b', '-x'])
      expect(serverTakes({ source: 'github', repo: 'o/a', on: 'ci', branch })).toBe(false);
    for (const branch of ['feature/x+y', 'release@2026', '修正-1'])
      expect(serverTakes({ source: 'github', repo: 'o/a', on: 'ci', branch })).toBe(true);
    for (const pattern of ['./', '././', '../x']) expect(serverTakes({ source: 'file', pattern })).toBe(false);
    expect(serverTakes({ source: 'file', pattern: '././reports/*.csv' })).toBe(true);
    const pr = withTrigger({ source: 'github', repo: 'https://github.com/octo/app', on: 'pr', branch: 'main' });
    expect(draftProblems(pr, MON, en)).toEqual([]);
    expect(toUpdate(pr).repeat).toEqual({ kind: 'event', triggers: [{ source: 'github', repo: 'octo/app', on: 'pr' }] });
    expect(describeRepeat({ kind: 'event', triggers: [{ source: 'github', repo: 'octo/app', on: 'pr' }] }, en, 'en')).toBe(
      'When a pull request is opened in octo/app',
    );
    const ci: ScheduleRepeat = { kind: 'event', triggers: [{ source: 'github', repo: 'octo/app', on: 'ci', branch: 'main' }] };
    expect(describeRepeat(ci, en, 'en')).toBe('When a CI run fails in octo/app on main');
    expect(describeRepeat(ci, zhTW, 'zh-TW')).toBe('octo/app 的 main 分支有 CI 執行失敗時');

    // A file: a pattern inside the working directory (`./` alone is none).
    for (const pattern of ['', './', '/etc/x', 'C:\\x', '../x', 'a/../b']) {
      expect(draftProblems(withTrigger({ source: 'file', pattern }), MON, en)).toEqual([
        'Give a pattern for files in the working directory (not a full path, and without ..)',
      ]);
    }
    const file = withTrigger({ source: 'file', pattern: ' reports/*.csv ' });
    expect(toUpdate(file).repeat).toEqual({ kind: 'event', triggers: [{ source: 'file', pattern: 'reports/*.csv' }] });
    expect(describeRepeat(toUpdate(file).repeat, en, 'en')).toBe(
      'When a file matching reports/*.csv appears or changes in the working directory',
    );
    expect(sidebarScheduleTitle({ enabled: true, triggers: [{ source: 'file', pattern: '*.log' }] }, zhTW, 'zh-TW')).toBe(
      '自動任務：工作目錄中符合 *.log 的檔案出現或變動時',
    );
    // Switching sources keeps what was typed for the others.
    const switched = { ...cal, triggers: [{ ...cal.triggers[0]!, source: 'mail' as const, account: 'work' }] };
    expect(switched.triggers[0]!.calendar).toBe('home');
    expect(toUpdate(switched).repeat).toEqual({ kind: 'event', triggers: [{ source: 'mail', account: 'work', folder: 'INBOX' }] });
  });

  it("writes a command that calls the schedule's webhook", () => {
    expect(hookExample('http://127.0.0.1:8787/api/hooks/c1', 'tok_en-1')).toBe(
      `curl -X POST -H 'Authorization: Bearer tok_en-1' -H 'Content-Type: application/json' -d '{"event":"ci-failed","branch":"main"}' 'http://127.0.0.1:8787/api/hooks/c1'`,
    );
    // A server on Windows: PowerShell's own command, whose `curl` is another one and whose cmd.exe takes no single quotes.
    expect(hookExample('http://127.0.0.1:8787/api/hooks/c1', 'tok_en-1', 'win32')).toBe(
      `Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/api/hooks/c1' -Headers @{ Authorization = 'Bearer tok_en-1' } -ContentType 'application/json' -Body '{"event":"ci-failed","branch":"main"}'`,
    );
  });

  it("shows times of day in the schedule's time zone, and moments and intervals in the browser's", () => {
    expect(shownZone({ repeat: { kind: 'daily' }, timeZone: 'Asia/Taipei' })).toBe('Asia/Taipei');
    expect(shownZone({ repeat: { kind: 'weekly' }, timeZone: 'Asia/Taipei' })).toBe('Asia/Taipei');
    expect(shownZone({ repeat: { kind: 'once' }, timeZone: 'Asia/Taipei' })).toBeUndefined();
    expect(shownZone({ repeat: { kind: 'interval' }, timeZone: 'Asia/Taipei' })).toBeUndefined();
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
    expect(draftProblems({ ...draft, text: 'go', kind: 'weekly', days: [], time: '' }, MON, en)).toEqual([p.days, p.time]);
    // No set times: no days nor time to check.
    expect(draftProblems({ ...draft, text: 'go', days: [], time: '' }, MON, en)).toEqual([]);
    expect(draftProblems({ ...draft, text: 'go', kind: 'interval', hours: 200 }, MON, en)).toEqual([p.hours(168)]);
    expect(draftProblems({ ...draft, text: 'go', kind: 'once', at: localInput(MON - HOUR) }, MON, en)).toEqual([p.past]);
    expect(draftProblems({ ...draft, text: 'go', kind: 'once', at: localInput(MON - HOUR), enabled: false }, MON, en)).toEqual([]);
    expect(draftProblems({ ...draft, text: 'go', kind: 'once', at: '' }, MON, en)).toEqual([p.moment]);
    expect(previewRuns({ ...draft, text: 'go', kind: 'interval', hours: 2 }, MON)).toEqual([
      MON + 2 * HOUR,
      MON + 4 * HOUR,
      MON + 6 * HOUR,
    ]);
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
    expect(
      scheduleState({ ...saved, repeat: { kind: 'once', at: MON }, enabled: false, nextRunAt: undefined, lastRunAt: MON }, en, 'en'),
    ).toBe('done');
    // Changed to a one-time schedule, switched off: the earlier time it came due does not make it done.
    expect(
      scheduleState({ ...saved, repeat: { kind: 'once', at: MON + DAY }, enabled: false, nextRunAt: undefined, lastRunAt: MON }, en, 'en'),
    ).toBe('paused');
    expect(scheduleState(saved, en, 'en')).toMatch(/^next /);
    expect(sidebarScheduleTitle({ enabled: true, nextRunAt: MON, lastResult: 'failed' }, en, 'en')).toBe(
      'Automation last time: could not be sent',
    );
    expect(sidebarScheduleTitle({ enabled: false }, en, 'en')).toBe('Automation paused');
    // The next time in the schedule's own time zone when it has one, else the browser's.
    const next = Date.UTC(2026, 0, 5, 1, 0);
    expect(sidebarScheduleTitle({ enabled: true, nextRunAt: next, timeZone: 'Asia/Taipei' }, en, 'en')).toMatch(/09:00/);
    expect(sidebarScheduleTitle({ enabled: true, nextRunAt: next, timeZone: 'UTC' }, en, 'en')).toMatch(/01:00/);
    expect(sidebarScheduleTitle({ enabled: true, nextRunAt: next }, en, 'en')).toBe(`Automation: next ${formatWhen(next, 'en')}`);
  });
});
