/*
 * An automation that starts when something happens: the sources besides new mail (`watch.ts`). An
 * event about to begin, against the stand-in CalDAV calendar (each time of a recurring event apart,
 * also from a server that expands them, and one asked again without expanding; all-day and cancelled
 * events left out, each fired once by its UID and start, a late check still finding what began), and
 * over an OAuth calendar (Graph, and CalDAV with a token); a pull request opened or a CI run that
 * failed, through a stand-in for gh; a file appearing or changing in a real temporary folder (not
 * while it is still being written, another folder starting afresh). Each first check only records what
 * is there, and every source's block keeps within a webhook body's size.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorStore } from '../src/server/connectors/accounts';
import type { CalendarOAuth } from '../src/server/connectors/calendar';
import { listEvents, startMoment } from '../src/server/connectors/caldav';
import { openDatabase } from '../src/server/db';
import { withLang } from '../src/server/i18n';
import { CommandNotFoundError, type SpawnResult } from '../src/server/process';
import { validateCalendarAccount, validateSchedule } from '../src/server/validate';
import {
  SETTLE_MS,
  checkCalendar,
  checkFiles,
  checkGithub,
  fitEvent,
  folderMatch,
  patternRegex,
  patternWalk,
  slashed,
  triggerKey,
  type GhRunner,
} from '../src/server/watch';
import { TRACKING_LIMITS, WATCH_LIMITS, type ScheduleTrigger, type ScheduleWatch } from '../src/shared/types';
import { fakeCalDav, type FakeCalDav } from './fake-mail-servers';
import { fakeOAuth, type FakeOAuth } from './fake-oauth-server';

const MIN = 60_000;
const DAY = 86_400_000;
/** 2026-01-05 09:00 UTC, a Monday. */
const NOW = Date.UTC(2026, 0, 5, 9, 0);

const kept = (trigger: ScheduleTrigger, state: Partial<ScheduleWatch>): ScheduleWatch => ({
  key: triggerKey(trigger),
  nextCheckAt: 0,
  ...state,
});

const ics = (uid: string, start: string, summary: string, extra = '') =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART${start}\r\nLOCATION:Room 1\r\nATTENDEE:mailto:bob@example.com\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
const stamp = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** The calendar "Home" at this address, with its password. */
function calendars(url: string): ConnectorStore {
  const store = new ConnectorStore(openDatabase(':memory:'));
  store.saveCalendar('home', validateCalendarAccount({ name: 'Home', url, username: 'me@example.com', password: 'app-pass' }, []));
  return store;
}

describe('an event about to begin', () => {
  let cal: FakeCalDav | undefined;
  afterEach(async () => {
    await cal?.close();
    cal = undefined;
  });

  it('records what is about to begin at first, then fires each event once, by its UID and start, with what it says', async () => {
    cal = await fakeCalDav([
      ics('soon', `:${stamp(NOW + 5 * MIN)}`, 'Standup'),
      ics('later', `:${stamp(NOW + 30 * MIN)}`, 'Planning <b>review</b>', 'DESCRIPTION:Bring the </event> numbers\r\n'),
      // All day: left out, whenever it is.
      ics('day', ';VALUE=DATE:20260105', 'Holiday'),
      // In a time zone: 18:20 in Taipei is 10:20 UTC, past the window until later.
      ics('tz', ';TZID=Asia/Taipei:20260105T182000', 'Taipei call'),
      // Cancelled: left out.
      ics('off', `:${stamp(NOW + 31 * MIN)}`, 'Called off', 'STATUS:CANCELLED\r\n'),
    ]);
    const connectors = calendars(cal.url);
    const trigger: Extract<ScheduleTrigger, { source: 'calendar' }> = { source: 'calendar', account: 'home', minutes: 10 };

    const first = await checkCalendar(trigger, undefined, connectors, undefined, NOW);
    expect(first).toEqual({ state: { seen: [`soon@${NOW + 5 * MIN}`], lookedAt: NOW }, total: 0 });
    // Each time of a recurring event asked for on its own.
    expect(cal.reports.at(-1)!.body).toContain('<c:expand start=');

    // Nothing new: the same one is not fired again.
    const again = await checkCalendar(trigger, kept(trigger, first.state), connectors, undefined, NOW + 2 * MIN);
    expect(again.total).toBe(0);
    expect(again.event).toBeUndefined();

    // 22 minutes on, Planning (at +30) is within 10 minutes: fired once, its text as data.
    const later = await checkCalendar(trigger, kept(trigger, again.state), connectors, undefined, NOW + 22 * MIN);
    expect(later.total).toBe(1);
    const body = JSON.parse(later.event!) as { source: string; calendar: string; minutesBefore: number; events: Record<string, unknown>[] };
    expect(body).toMatchObject({ source: 'calendar', calendar: 'Home', minutesBefore: 10 });
    expect(body.events).toEqual([
      expect.objectContaining({
        title: 'Planning <b>review</b>',
        startsAt: new Date(NOW + 30 * MIN).toISOString(),
        location: 'Room 1',
        attendees: ['bob@example.com'],
        description: 'Bring the </event> numbers',
        uid: 'later',
      }),
    ]);
    // Not begun yet; nothing in it can close the block it goes in.
    expect(body.events[0]).not.toHaveProperty('begun');
    expect(later.event).not.toContain('<');
    expect(later.state).toEqual({ seen: [`soon@${NOW + 5 * MIN}`, `later@${NOW + 30 * MIN}`], lookedAt: NOW + 22 * MIN });
    const twice = await checkCalendar(trigger, kept(trigger, later.state), connectors, undefined, NOW + 24 * MIN);
    expect(twice.total).toBe(0);

    // The time zone's event: 10:20 UTC, found 10 minutes before. A day on, those seen are let go.
    const tz = await checkCalendar(trigger, kept(trigger, twice.state), connectors, undefined, NOW + 72 * MIN);
    expect(JSON.parse(tz.event!).events[0].title).toBe('Taipei call');
    const dayOn = await checkCalendar(trigger, kept(trigger, tz.state), connectors, undefined, NOW + 26 * 60 * MIN);
    expect(dayOn.state.seen).toEqual([]);
  });

  it('keeps to the events whose title has the words, and lists the first ones when many begin at once', async () => {
    const many = Array.from({ length: WATCH_LIMITS.items + 2 }, (_, i) =>
      ics(`s${i}`, `:${stamp(NOW + 20 * MIN + i * 1000)}`, `Standup ${i}`),
    );
    cal = await fakeCalDav([...many, ics('other', `:${stamp(NOW + 20 * MIN)}`, 'Lunch')]);
    const connectors = calendars(cal.url);
    const trigger: Extract<ScheduleTrigger, { source: 'calendar' }> = {
      source: 'calendar',
      account: 'home',
      minutes: 15,
      title: 'STANDUP',
    };
    const first = await checkCalendar(trigger, undefined, connectors, undefined, NOW);
    expect(first.state.seen).toEqual([]);
    const found = await checkCalendar(trigger, kept(trigger, first.state), connectors, undefined, NOW + 10 * MIN);
    expect(found.total).toBe(WATCH_LIMITS.items + 2);
    const body = JSON.parse(found.event!) as { startingEvents: number; listed: string; events: { title: string }[] };
    expect(body.startingEvents).toBe(WATCH_LIMITS.items + 2);
    expect(body.listed).toBe(`the first ${WATCH_LIMITS.items}`);
    expect(body.events.map((e) => e.title)).toEqual(many.slice(0, WATCH_LIMITS.items).map((_, i) => `Standup ${i}`));
  });

  it('still lists an event that began while the checks came late, marked as begun, from the last check that worked (an hour back at most)', async () => {
    cal = await fakeCalDav([ics('review', `:${stamp(NOW + 25 * MIN)}`, 'Review'), ics('old', `:${stamp(NOW - 90 * MIN)}`, 'Long gone')]);
    const connectors = calendars(cal.url);
    const trigger: Extract<ScheduleTrigger, { source: 'calendar' }> = { source: 'calendar', account: 'home', minutes: 10 };
    const first = await checkCalendar(trigger, undefined, connectors, undefined, NOW);
    expect(first.state).toEqual({ seen: [], lookedAt: NOW });
    // The next check comes 30 minutes late (the server was unreachable, or the team held): Review
    // began 15 minutes ago, still found; the window starts where the last check was.
    const late = await checkCalendar(trigger, kept(trigger, first.state), connectors, undefined, NOW + 40 * MIN);
    expect(late.total).toBe(1);
    expect(JSON.parse(late.event!).events).toEqual([expect.objectContaining({ title: 'Review', begun: true, minutesAgo: 15 })]);
    expect(cal.reports.at(-1)!.body).toContain(`start="${stamp(NOW)}"`);
    // Far later, an hour back at most.
    await checkCalendar(trigger, kept(trigger, late.state), connectors, undefined, NOW + 5 * 60 * MIN);
    expect(cal.reports.at(-1)!.body).toContain(`start="${stamp(NOW + 4 * 60 * MIN)}"`);
  });

  it('fires a recurring event at each of its times from a server that expands it, its first time only from one that does not', async () => {
    const daily = ics('standup', `:${stamp(NOW + 30 * MIN)}`, 'Daily standup', 'RRULE:FREQ=DAILY;COUNT=3\r\n');
    cal = await fakeCalDav([daily], undefined, { expand: true });
    const connectors = calendars(cal.url);
    const trigger: Extract<ScheduleTrigger, { source: 'calendar' }> = { source: 'calendar', account: 'home', minutes: 10 };
    let watch = kept(trigger, (await checkCalendar(trigger, undefined, connectors, undefined, NOW)).state);
    const fired: string[] = [];
    for (const at of [NOW + 22 * MIN, NOW + 24 * MIN, NOW + DAY + 22 * MIN, NOW + 2 * DAY + 22 * MIN, NOW + 3 * DAY + 22 * MIN]) {
      const found = await checkCalendar(trigger, watch, connectors, undefined, at);
      if (found.event) fired.push(JSON.parse(found.event).events[0].startsAt);
      watch = kept(trigger, found.state);
    }
    expect(fired).toEqual([0, 1, 2].map((d) => new Date(NOW + d * DAY + 30 * MIN).toISOString()));

    // A server that does not expand: the first time only (the docs and the hint say so).
    await cal.close();
    cal = await fakeCalDav([daily]);
    const plain = calendars(cal.url);
    watch = kept(trigger, (await checkCalendar(trigger, undefined, plain, undefined, NOW)).state);
    const once: string[] = [];
    for (const at of [NOW + 22 * MIN, NOW + DAY + 22 * MIN]) {
      const found = await checkCalendar(trigger, watch, plain, undefined, at);
      if (found.event) once.push(JSON.parse(found.event).events[0].startsAt);
      watch = kept(trigger, found.state);
    }
    expect(once).toEqual([new Date(NOW + 30 * MIN).toISOString()]);
  });

  it('asks once more without expanding when the server refuses it', async () => {
    for (const status of [400, 403, 415, 501]) {
      cal = await fakeCalDav([ics('soon', `:${stamp(NOW + 5 * MIN)}`, 'Standup')], undefined, { refuseExpand: status });
      const events = await listEvents(cal.url, { username: 'me@example.com', password: 'app-pass' }, NOW, NOW + 10 * MIN, 5000, true);
      expect(events.map((e) => e.uid)).toEqual(['soon']);
      expect(cal.reports.map((r) => r.body.includes('<c:expand'))).toEqual([true, false]);
      await cal.close();
      cal = undefined;
    }
  });

  it('keeps huge invitations within a webhook body: each field cut, at most 20 attendees, fewer events listed', async () => {
    const huge = (i: number, attendee: (a: number) => string) =>
      ics(
        `big-${i}-${'u'.repeat(400)}`,
        `:${stamp(NOW + 20 * MIN + i * 1000)}`,
        `<Title ${i}> ${'<'.repeat(2000)}`,
        `LOCATION:${'L'.repeat(5000)}\r\nDESCRIPTION:${'D'.repeat(20_000)}\r\n` +
          Array.from({ length: 200 }, (_, a) => `ATTENDEE:mailto:${attendee(a)}\r\n`).join(''),
      );
    const trigger: Extract<ScheduleTrigger, { source: 'calendar' }> = { source: 'calendar', account: 'home', minutes: 30 };
    const check = async (files: string[]) => {
      cal = await fakeCalDav(files);
      const connectors = calendars(cal.url);
      const first = await checkCalendar(trigger, undefined, connectors, undefined, NOW - 20 * MIN);
      const found = await checkCalendar(trigger, kept(trigger, first.state), connectors, undefined, NOW);
      await cal.close();
      cal = undefined;
      expect(found.total).toBe(files.length);
      expect(Buffer.byteLength(found.event!)).toBeLessThanOrEqual(TRACKING_LIMITS.eventBytes);
      return JSON.parse(found.event!) as {
        startingEvents: number;
        listed: string;
        events: { title: string; location: string; description?: string; attendees: string[]; moreAttendees: number; uid: string }[];
      };
    };
    // Long texts: each cut, and fewer events listed.
    const body = await check(Array.from({ length: 12 }, (_, i) => huge(i, (a) => `a${a}@example.com`)));
    expect(body.startingEvents).toBe(12);
    expect(body.events.length).toBeGreaterThan(1);
    expect(body.events.length).toBeLessThan(WATCH_LIMITS.items);
    expect(body.listed).toBe(`the first ${body.events.length}`);
    const e = body.events[0]!;
    expect(e.title).toHaveLength(301);
    expect(e.location).toHaveLength(301);
    expect(e.uid).toHaveLength(301);
    expect(e.description).toHaveLength(WATCH_LIMITS.excerptChars + 1);
    expect(e.attendees).toHaveLength(20);
    // Bob, whom every invitation here has, and the 200.
    expect(e.moreAttendees).toBe(181);
    // Attendees whose every character is escaped: not even one event fits whole, so the first is listed short.
    const short = await check([huge(0, (a) => `${'<'.repeat(300)}${a}@example.com`)]);
    expect(short.events).toHaveLength(1);
    expect(short.events[0]!.description).toBeUndefined();
    expect(short.events[0]!.attendees).toHaveLength(5);
    expect(short.events[0]!.moreAttendees).toBe(196);
  });

  it('says when the calendar is gone, its password cannot be read, or it cannot be reached', async () => {
    const connectors = calendars('http://127.0.0.1:1/cal/me/');
    const trigger: Extract<ScheduleTrigger, { source: 'calendar' }> = { source: 'calendar', account: 'gone', minutes: 10 };
    await expect(withLang('en', () => checkCalendar(trigger, undefined, connectors, undefined, NOW))).rejects.toThrow(
      'The calendar this automation checks is gone',
    );
    await expect(checkCalendar({ ...trigger, account: 'home' }, undefined, connectors, undefined, NOW)).rejects.toThrow();
    // Its password went from the credential store (another computer's, a store that was reset).
    const values = new Map<string, string>();
    const keyring = {
      storage: 'keychain' as const,
      get: (n: string) => values.get(n) ?? null,
      set: (n: string, v: string) => void values.set(n, v),
      delete: (n: string) => void values.delete(n),
    };
    const store = new ConnectorStore(openDatabase(':memory:'), keyring);
    store.saveCalendar(
      'home',
      validateCalendarAccount({ name: 'Home', url: 'https://cal.example/', username: 'me', password: 'app-pass' }, []),
    );
    values.clear();
    await expect(withLang('en', () => checkCalendar({ ...trigger, account: 'home' }, undefined, store, undefined, NOW))).rejects.toThrow(
      'The password of the calendar "Home" cannot be read: type it again in Settings → Tool library',
    );
    await expect(withLang('zh-TW', () => checkCalendar({ ...trigger, account: 'home' }, undefined, store, undefined, NOW))).rejects.toThrow(
      '讀不到行事曆「Home」的密碼',
    );
  });

  it("reads an event's start: in UTC, in a time zone, floating in this computer's, never a date or an unknown zone", () => {
    expect(startMoment('20260105T090000Z', {})).toBe(Date.UTC(2026, 0, 5, 9, 0));
    expect(startMoment('20260105T170000', { TZID: 'Asia/Taipei' })).toBe(Date.UTC(2026, 0, 5, 9, 0));
    expect(startMoment('20260105T090000', {})).toBe(new Date(2026, 0, 5, 9, 0).getTime());
    expect(startMoment('20260105', { VALUE: 'DATE' })).toBeUndefined();
    expect(startMoment('20260105T090000', { TZID: 'Taipei Standard Time' })).toBeUndefined();
  });
});

describe('an event about to begin, in a calendar signed in with OAuth', () => {
  let oauth: FakeOAuth | undefined;
  let cal: FakeCalDav | undefined;
  afterEach(async () => {
    await oauth?.close();
    await cal?.close();
    oauth = cal = undefined;
  });

  /** A stand-in for the OAuth service: the account's API, and a fetch that signs each request with its token. */
  const signedIn = (api: 'graph' | 'caldav', token: string): CalendarOAuth & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      problem: () => undefined,
      via: (account) => {
        asked.push(account);
        return {
          api,
          fetch: (url, init) =>
            fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}` } }),
        };
      },
    };
  };
  const trigger: Extract<ScheduleTrigger, { source: 'calendar' }> = { source: 'calendar', account: 'work', minutes: 10 };

  it('reads a Microsoft calendar over Graph (its times in UTC, cancelled meetings left out)', async () => {
    oauth = await fakeOAuth();
    oauth.accessTokens.set('graph-token', true);
    const at = (ms: number) => ({ dateTime: new Date(ms).toISOString().replace(/\.\d{3}Z$/, '.0000000'), timeZone: 'UTC' });
    oauth.events.push(
      { id: 'g1', subject: 'Sync', start: at(NOW + 25 * MIN), end: at(NOW + 55 * MIN), location: { displayName: 'Teams' } },
      { id: 'g2', subject: 'Cancelled sync', start: at(NOW + 26 * MIN), end: at(NOW + 56 * MIN), isCancelled: true },
    );
    const store = new ConnectorStore(openDatabase(':memory:'));
    store.saveOAuthCalendar('work', { name: 'Work', url: `${oauth.url}/v1.0/me/calendar`, oauth: 'ms-1', email: 'ming@contoso.com' });
    const service = signedIn('graph', 'graph-token');
    const first = await checkCalendar(trigger, undefined, store, service, NOW);
    expect(first.state.seen).toEqual([]);
    const found = await checkCalendar(trigger, kept(trigger, first.state), store, service, NOW + 20 * MIN);
    expect(service.asked).toContain('ms-1');
    expect(JSON.parse(found.event!).events).toEqual([
      expect.objectContaining({ title: 'Sync', startsAt: new Date(NOW + 25 * MIN).toISOString(), location: 'Teams', uid: 'g1' }),
    ]);
    expect(oauth.requests.some((r) => r.path.includes('/calendarView') && r.path.includes('isCancelled'))).toBe(true);
  });

  it("reads a Google calendar over CalDAV with the account's token", async () => {
    cal = await fakeCalDav([ics('google-1', `:${stamp(NOW + 25 * MIN)}`, 'Focus')], undefined, { bearer: 'google-token' });
    const store = new ConnectorStore(openDatabase(':memory:'));
    store.saveOAuthCalendar('work', { name: 'Google', url: cal.url, oauth: 'google-1', email: 'ming@gmail.com' });
    const service = signedIn('caldav', 'google-token');
    const first = await checkCalendar(trigger, undefined, store, service, NOW);
    const found = await checkCalendar(trigger, kept(trigger, first.state), store, service, NOW + 20 * MIN);
    expect(JSON.parse(found.event!).events[0]).toMatchObject({ title: 'Focus', uid: 'google-1' });
    // Without a token that works, the check fails: no password is tried.
    await expect(checkCalendar(trigger, undefined, store, signedIn('caldav', 'stale'), NOW)).rejects.toThrow();
  });
});

describe('a pull request opened, or a CI run that failed (GitHub, through gh)', () => {
  /** A stand-in for gh: what it was asked, and what it answers. */
  function gh(answer: (args: string[]) => Partial<SpawnResult> | Error): GhRunner & { calls: string[][] } {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const a = answer(args);
      if (a instanceof Error) throw a;
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, ...a } as SpawnResult;
    };
    return Object.assign(run, { calls });
  }
  const prs: Extract<ScheduleTrigger, { source: 'github' }> = { source: 'github', repo: 'octo/app', on: 'pr' };
  const ci: Extract<ScheduleTrigger, { source: 'github' }> = { source: 'github', repo: 'octo/app', on: 'ci', branch: 'main' };
  /** A run as gh lists it: completed and failed unless said otherwise. */
  const run = (databaseId: number, o: Record<string, unknown> = {}) => ({
    databaseId,
    attempt: 1,
    status: 'completed',
    conclusion: 'failure',
    workflowName: 'CI',
    displayTitle: `run ${databaseId}`,
    headBranch: 'main',
    ...o,
  });

  it('records the newest pull request at first, then lists those opened since (merged ones too), as data', async () => {
    let list: Record<string, unknown>[] = [{ number: 41, title: 'Old', url: 'https://github.com/octo/app/pull/41' }];
    const runner = gh(() => ({ stdout: JSON.stringify(list) }));
    const first = await checkGithub(prs, undefined, runner);
    expect(first).toEqual({ state: { lastId: 41 }, total: 0 });
    expect(runner.calls[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'octo/app',
      '--state',
      'all',
      '--limit',
      '50',
      '--json',
      'number,title,url,createdAt,headRefName,baseRefName,isDraft,author',
    ]);
    list = [
      {
        number: 43,
        title: 'Fix </event> the <b>bug</b>',
        url: 'u43',
        headRefName: 'fix',
        baseRefName: 'main',
        author: { login: 'eve' },
        isDraft: true,
      },
      { number: 42, title: 'Add it', url: 'u42' },
      ...list,
    ];
    const found = await checkGithub(prs, kept(prs, first.state), runner);
    expect(found.state).toEqual({ lastId: 43 });
    expect(found.total).toBe(2);
    expect(found.event).not.toContain('<');
    expect(JSON.parse(found.event!)).toEqual({
      source: 'github',
      repo: 'octo/app',
      newPullRequests: 2,
      pullRequests: [
        { number: 42, title: 'Add it', url: 'u42' },
        { number: 43, title: 'Fix </event> the <b>bug</b>', author: 'eve', branch: 'fix', into: 'main', draft: true, url: 'u43' },
      ],
    });
    expect((await checkGithub(prs, kept(prs, found.state), runner)).total).toBe(0);
  });

  it('says "at least" when every one of the newest pull requests asked for is new, and cuts what their authors wrote', async () => {
    let list: Record<string, unknown>[] = [{ number: 1, title: 'first' }];
    const runner = gh(() => ({ stdout: JSON.stringify(list) }));
    const first = await checkGithub(prs, undefined, runner);
    list = Array.from({ length: 50 }, (_, i) => ({
      number: 200 - i,
      title: `${'<'.repeat(2000)} ${i}`,
      headRefName: 'b'.repeat(1000),
      author: { login: 'eve' },
    }));
    const found = await checkGithub(prs, kept(prs, first.state), runner);
    expect(Buffer.byteLength(found.event!)).toBeLessThanOrEqual(TRACKING_LIMITS.eventBytes);
    const body = JSON.parse(found.event!) as { newPullRequests: string; listed: string; pullRequests: { title: string; branch: string }[] };
    expect(body.newPullRequests).toBe('at least 50');
    expect(body.listed).toBe(`the newest ${body.pullRequests.length}`);
    expect(body.pullRequests.at(-1)!.title).toMatch(/^<{300}…$/);
    expect(body.pullRequests.at(-1)!.branch).toHaveLength(301);
  });

  it('asks for every run, on a branch when given, and lists the failed ones not seen yet', async () => {
    let runs: Record<string, unknown>[] = [run(900, { displayTitle: 'old' })];
    const runner = gh(() => ({ stdout: JSON.stringify(runs) }));
    const first = await checkGithub(ci, undefined, runner);
    expect(first.state).toEqual({ seen: ['900:1'] });
    expect(runner.calls[0]).toEqual([
      'run',
      'list',
      '--repo',
      'octo/app',
      '--branch',
      'main',
      '--limit',
      '100',
      '--json',
      'databaseId,attempt,status,conclusion,displayTitle,workflowName,headBranch,event,url,createdAt,updatedAt',
    ]);
    runs = [
      run(905, { displayTitle: 'Bump', event: 'push', url: 'r905' }),
      // Still running, passed, cancelled: none failed.
      run(906, { status: 'in_progress', conclusion: '' }),
      run(907, { conclusion: 'success' }),
      run(908, { conclusion: 'cancelled' }),
      ...runs,
    ];
    const found = await checkGithub(ci, kept(ci, first.state), runner);
    expect(JSON.parse(found.event!)).toEqual({
      source: 'github',
      repo: 'octo/app',
      failedRuns: 1,
      runs: [{ id: 905, workflow: 'CI', title: 'Bump', conclusion: 'failure', branch: 'main', event: 'push', url: 'r905' }],
    });
    expect(found.state).toEqual({ seen: ['905:1', '900:1'] });
  });

  it('finds an older run that fails after a newer one did, a run that fails again once started again, and timed-out runs', async () => {
    // 910 and 911 run side by side; 911 (newer) fails first.
    let runs: Record<string, unknown>[] = [run(911), run(910, { status: 'in_progress', conclusion: '' })];
    const runner = gh(() => ({ stdout: JSON.stringify(runs) }));
    let watch = kept(ci, (await checkGithub(ci, undefined, runner)).state);
    const failedIds = async () => {
      const found = await checkGithub(ci, watch, runner);
      watch = kept(ci, found.state);
      return found.event ? (JSON.parse(found.event).runs as { id: number; attempt?: number; conclusion: string }[]) : [];
    };
    expect(await failedIds()).toEqual([]);
    // The older one fails now: its id is below the newest failure seen, and it is still new.
    runs = [run(911), run(910)];
    expect((await failedIds()).map((r) => r.id)).toEqual([910]);
    // 911 is started again (the same id, attempt 2), and fails again.
    runs = [run(911, { attempt: 2, status: 'queued', conclusion: '' }), run(910)];
    expect(await failedIds()).toEqual([]);
    runs = [run(911, { attempt: 2 }), run(910)];
    expect(await failedIds()).toEqual([expect.objectContaining({ id: 911, attempt: 2 })]);
    // Timed out, and could not start: failures too.
    runs = [run(913, { conclusion: 'startup_failure' }), run(912, { conclusion: 'timed_out' }), ...runs];
    expect((await failedIds()).map((r) => [r.id, r.conclusion])).toEqual([
      [912, 'timed_out'],
      [913, 'startup_failure'],
    ]);
    // A list that comes back short (runs deleted) does not make the ones seen new again.
    runs = [run(913, { conclusion: 'startup_failure' })];
    expect(await failedIds()).toEqual([]);
    runs = [run(913, { conclusion: 'startup_failure' }), run(912, { conclusion: 'timed_out' }), run(911, { attempt: 2 }), run(910)];
    expect(await failedIds()).toEqual([]);
  });

  it('says "at least" when every run asked for began after the last check', async () => {
    let runs: Record<string, unknown>[] = [run(1, { createdAt: new Date(NOW - DAY).toISOString() })];
    const runner = gh(() => ({ stdout: JSON.stringify(runs) }));
    const first = await checkGithub(ci, undefined, runner);
    runs = Array.from({ length: 100 }, (_, i) => run(500 - i, { createdAt: new Date(NOW + MIN + i).toISOString() }));
    const found = await checkGithub(ci, kept(ci, { ...first.state, checkedAt: NOW }), runner);
    expect(JSON.parse(found.event!).failedRuns).toBe('at least 100');
    // One of them older than the last check: the list reaches back past it.
    runs[99] = run(401, { createdAt: new Date(NOW - MIN).toISOString() });
    const exact = await checkGithub(ci, kept(ci, { ...first.state, checkedAt: NOW }), runner);
    expect(JSON.parse(exact.event!).failedRuns).toBe(100);
  });

  it('says how to fix gh missing, signed out, failing, timing out, or answering what is not JSON', async () => {
    await withLang('en', async () => {
      await expect(
        checkGithub(
          prs,
          undefined,
          gh(() => new CommandNotFoundError('gh')),
        ),
      ).rejects.toThrow('The GitHub CLI (gh) is not installed');
      await expect(
        checkGithub(
          prs,
          undefined,
          gh(() => ({ code: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login' })),
        ),
      ).rejects.toThrow('is not signed in');
      await expect(
        checkGithub(
          prs,
          undefined,
          gh(() => ({ code: 1, stderr: 'GraphQL: Could not resolve to a Repository' })),
        ),
      ).rejects.toThrow('The GitHub repository octo/app cannot be read: GraphQL: Could not resolve to a Repository');
      await expect(
        checkGithub(
          prs,
          undefined,
          gh(() => ({ stdout: 'not json' })),
        ),
      ).rejects.toThrow('The GitHub CLI (gh) did not answer about octo/app in JSON: update gh');
      await expect(
        checkGithub(
          prs,
          undefined,
          gh(() => ({ timedOut: true, code: null })),
        ),
      ).rejects.toThrow('The GitHub CLI (gh) did not answer about octo/app within a minute');
    });
    await withLang('zh-TW', async () => {
      await expect(
        checkGithub(
          prs,
          undefined,
          gh(() => ({ stdout: 'not json' })),
        ),
      ).rejects.toThrow('的回答不是 JSON');
      await expect(
        checkGithub(
          prs,
          undefined,
          gh(() => ({ timedOut: true, code: null })),
        ),
      ).rejects.toThrow('一分鐘內沒有回答');
    });
  });
});

describe('a file appearing or changing in the working directory', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
    dir = undefined;
  });
  const file = (path: string, text: string, at?: number) => {
    const full = join(dir!, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
    if (at) utimesSync(full, at / 1000, at / 1000);
  };
  /** A check at `NOW + 1 hour`: every file below written at `NOW`-ish has settled. */
  const LATER = NOW + 60 * MIN;

  it('records the matching files at first, then lists those new or changed (never their contents), not those removed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
    file('reports/jan.csv', 'a,b', NOW);
    file('reports/notes.txt', 'not a csv', NOW);
    file('reports/deep/feb.csv', 'deep', NOW);
    const trigger: Extract<ScheduleTrigger, { source: 'file' }> = { source: 'file', pattern: 'reports/*.csv' };
    const first = await checkFiles(trigger, undefined, dir, LATER);
    expect(first).toEqual({ state: { files: { 'reports/jan.csv': `${NOW}:3` }, filesIn: dir }, total: 0 });

    file('reports/mar.CSV', 'new one', NOW + MIN);
    file('reports/jan.csv', 'a,b,c', NOW + 2 * MIN);
    const found = await checkFiles(trigger, kept(trigger, first.state), dir, LATER);
    expect(found.total).toBe(2);
    const body = JSON.parse(found.event!) as {
      files: Record<string, unknown>[];
      changedFiles: number;
      pattern: string;
      workingDirectory: string;
    };
    expect(body).toMatchObject({ changedFiles: 2, pattern: 'reports/*.csv', workingDirectory: slashed(dir) });
    expect(body.files).toEqual([
      { path: 'reports/jan.csv', change: 'changed', size: 5, modified: new Date(NOW + 2 * MIN).toISOString() },
      { path: 'reports/mar.CSV', change: 'new', size: 7, modified: new Date(NOW + MIN).toISOString() },
    ]);
    expect(found.event).not.toContain('a,b,c');

    rmSync(join(dir, 'reports', 'mar.CSV'));
    const removed = await checkFiles(trigger, kept(trigger, found.state), dir, LATER);
    expect(removed).toEqual({ state: { files: { 'reports/jan.csv': `${NOW + 2 * MIN}:5` }, filesIn: dir }, total: 0 });
  });

  it('lists a file only once it has stopped changing for a moment, keeping what it was meanwhile', async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
    file('out/a.log', 'old', NOW);
    const trigger: Extract<ScheduleTrigger, { source: 'file' }> = { source: 'file', pattern: 'out/*.log' };
    const first = await checkFiles(trigger, undefined, dir, LATER);
    // Being written: changed 10 seconds before the check, and a new one 5 seconds before.
    file('out/a.log', 'old and more', LATER - 10_000);
    file('out/b.log', 'start', LATER - 5_000);
    const writing = await checkFiles(trigger, kept(trigger, first.state), dir, LATER);
    expect(writing).toEqual({ state: { files: { 'out/a.log': `${NOW}:3` }, filesIn: dir }, total: 0 });
    // Still being written at the next check.
    file('out/b.log', 'start and the rest', LATER + 2 * MIN - 1000);
    const still = await checkFiles(trigger, kept(trigger, writing.state), dir, LATER + 2 * MIN);
    expect(still.total).toBe(1);
    expect(JSON.parse(still.event!).files.map((f: { path: string; change: string }) => [f.path, f.change])).toEqual([
      ['out/a.log', 'changed'],
    ]);
    // Settled: listed once, as new.
    const done = await checkFiles(trigger, kept(trigger, still.state), dir, LATER + 2 * MIN + SETTLE_MS);
    expect(JSON.parse(done.event!).files).toEqual([expect.objectContaining({ path: 'out/b.log', change: 'new', size: 18 })]);
    expect((await checkFiles(trigger, kept(trigger, done.state), dir, LATER + 10 * MIN)).total).toBe(0);
  });

  it('starts afresh in another working directory, and only records when asked to (the team writes there)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
    mkdirSync(join(dir, 'one'));
    mkdirSync(join(dir, 'two'));
    file('one/a.csv', '1', NOW);
    file('two/a.csv', '1', NOW);
    file('two/b.csv', '2', NOW);
    const trigger: Extract<ScheduleTrigger, { source: 'file' }> = { source: 'file', pattern: '*.csv' };
    const one = await checkFiles(trigger, undefined, join(dir, 'one'), LATER);
    // The chat moved to another folder: what is there is recorded, not new.
    const moved = await checkFiles(trigger, kept(trigger, one.state), join(dir, 'two'), LATER);
    expect(moved).toEqual({ state: { files: { 'a.csv': `${NOW}:1`, 'b.csv': `${NOW}:1` }, filesIn: join(dir, 'two') }, total: 0 });
    file('two/c.csv', '3', NOW + MIN);
    const recorded = await checkFiles(trigger, kept(trigger, moved.state), join(dir, 'two'), LATER, true);
    expect(recorded.total).toBe(0);
    expect(recorded.event).toBeUndefined();
    expect(Object.keys(recorded.state.files!)).toEqual(['a.csv', 'b.csv', 'c.csv']);
  });

  it('looks through folders with **, never in .git, in bulky folders only where the pattern names them, and follows no link', async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
    file('a.log', '1', NOW);
    file('x/y/b.log', '2', NOW);
    file('.git/c.log', '3', NOW);
    file('node_modules/pkg/d.log', '4', NOW);
    file('.venv/lib/e.log', '5', NOW);
    file('target/debug/f.log', '6', NOW);
    const outside = mkdtempSync(join(tmpdir(), 'relay-outside-'));
    writeFileSync(join(outside, 'e.log'), '5');
    try {
      // A link to a folder (a junction on Windows, which needs no rights there), and on macOS and Linux one to a file.
      symlinkSync(outside, join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
      if (process.platform !== 'win32') symlinkSync(join(outside, 'e.log'), join(dir, 'linked.log'));
      const found = await checkFiles({ source: 'file', pattern: '**/*.log' }, undefined, dir, LATER);
      expect(Object.keys(found.state.files!)).toEqual(['a.log', 'x/y/b.log']);
      // Named, a bulky folder is looked in; `.git` never is.
      const named = await checkFiles({ source: 'file', pattern: 'node_modules/**/*.log' }, undefined, dir, LATER);
      expect(Object.keys(named.state.files!)).toEqual(['node_modules/pkg/d.log']);
      // Named after `**` too.
      const deep = await checkFiles({ source: 'file', pattern: '**/node_modules/*/*.log' }, undefined, dir, LATER);
      expect(Object.keys(deep.state.files!)).toEqual(['node_modules/pkg/d.log']);
      expect((await checkFiles({ source: 'file', pattern: '.git/*.log' }, undefined, dir, LATER)).state.files).toEqual({});
      // Through a link: nothing.
      expect((await checkFiles({ source: 'file', pattern: 'link/*.log' }, undefined, dir, LATER)).state.files).toEqual({});
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("starts at the pattern's fixed folders (in any case, by their own names), and leaves out folders where it cannot match", async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
    file('Reports/2026/jan.csv', '1', NOW);
    file('Reports/2026/deep/feb.csv', '2', NOW);
    file('other/2026/mar.csv', '3', NOW);
    const found = await checkFiles({ source: 'file', pattern: 'reports/*/*.csv' }, undefined, dir, LATER);
    expect(Object.keys(found.state.files!)).toEqual(['Reports/2026/jan.csv']);
    const w = patternWalk('reports/*/*.csv');
    expect(w.lead).toEqual(['reports']);
    expect(folderMatch(w, 0, 'Reports')).toBe('named');
    expect(folderMatch(w, 1, '2026')).toBe('wild');
    // Deeper than the pattern: no folder there can hold a match.
    expect(folderMatch(w, 2, 'deep')).toBe('no');
    expect(folderMatch(patternWalk('*.csv'), 0, 'any')).toBe('no');
    expect(folderMatch(patternWalk('src/**/*.ts'), 0, 'lib')).toBe('no');
    expect(folderMatch(patternWalk('src/**/*.ts'), 5, 'lib')).toBe('wild');
    expect(patternWalk('src/**/*.ts').lead).toEqual(['src']);
    expect(patternWalk('**/*.log').lead).toEqual([]);
    // A fixed folder that is not there: nothing, not an error.
    expect((await checkFiles({ source: 'file', pattern: 'missing/*.csv' }, undefined, dir, LATER)).state.files).toEqual({});
  });

  it('says when the working directory is gone, cannot be read, or too many files match, in words the user can act on', async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
    await withLang('en', async () => {
      await expect(checkFiles({ source: 'file', pattern: '*' }, undefined, join(dir!, 'gone'))).rejects.toThrow('is not there');
      for (let i = 0; i <= WATCH_LIMITS.files; i++) writeFileSync(join(dir!, `f${i}.txt`), '');
      await expect(checkFiles({ source: 'file', pattern: '*.txt' }, undefined, dir!)).rejects.toThrow(
        'More than 2,000 files match the pattern: make it narrower',
      );
    });
    await expect(withLang('zh-TW', () => checkFiles({ source: 'file', pattern: '*.txt' }, undefined, dir!))).rejects.toThrow(
      '符合樣式的檔案超過 2,000 個',
    );
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says when the working directory cannot be read, in both languages',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
      chmodSync(dir, 0o000);
      await expect(withLang('en', () => checkFiles({ source: 'file', pattern: '*' }, undefined, dir!))).rejects.toThrow(
        `The working directory "${dir}" cannot be read: check the folder's permissions`,
      );
      await expect(withLang('zh-TW', () => checkFiles({ source: 'file', pattern: '*' }, undefined, dir!))).rejects.toThrow(
        `沒有權限讀取工作目錄「${dir}」`,
      );
    },
  );

  it('writes the working directory with / between its folders, also on Windows', () => {
    expect(slashed('C:\\Users\\me\\project', '\\')).toBe('C:/Users/me/project');
    expect(slashed('/home/me/project', '/')).toBe('/home/me/project');
    expect(slashed(['a', 'b'].join(sep))).toBe('a/b');
  });

  it('records only what changed after the folder was last free of the team, keeping what came before it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
    file('held.pdf', 'from outside', NOW - 10 * MIN);
    const trigger: Extract<ScheduleTrigger, { source: 'file' }> = { source: 'file', pattern: '*.pdf' };
    const prev = kept(trigger, { files: {}, filesIn: dir });
    file('team.pdf', 'the team wrote it', NOW);
    const only = await checkFiles(trigger, prev, dir, NOW + MIN, true, NOW - 5 * MIN);
    // The team's file recorded; the one from before the team started not, so it is listed later.
    expect(only).toEqual({ state: { files: { 'team.pdf': `${NOW}:17` }, filesIn: dir }, total: 0 });
    const later = await checkFiles(trigger, kept(trigger, only.state), dir, NOW + 2 * MIN);
    expect(JSON.parse(later.event!).files.map((f: { path: string }) => f.path)).toEqual(['held.pdf']);
  });

  it('turns a pattern into a match of paths with /, in any case', () => {
    const re = (p: string) => patternRegex(p);
    expect(re('*.csv').test('a.csv')).toBe(true);
    expect(re('*.csv').test('d/a.csv')).toBe(false);
    expect(re('**/*.csv').test('a.csv')).toBe(true);
    expect(re('**/*.csv').test('d/e/a.CSV')).toBe(true);
    expect(re('logs/**').test('logs/x/y.txt')).toBe(true);
    expect(re('report-??.txt').test('report-01.txt')).toBe(true);
    expect(re('report-??.txt').test('report-1.txt')).toBe(false);
    // Other characters are themselves.
    expect(re('a+(b).txt').test('a+(b).txt')).toBe(true);
    expect(re('a.txt').test('abtxt')).toBe(false);
  });
});

describe('every source’s <event> block', () => {
  it('lists fewer items until it fits a webhook body, and none when not even one does', () => {
    const body = (n: number) => ({ source: 'x', items: Array.from({ length: n }, () => 'y'.repeat(5000)) });
    // Not even one fits whole: the first, short.
    const short = JSON.parse(fitEvent(3, (n, s) => ({ items: Array.from({ length: n }, () => (s ? 'short' : 'z'.repeat(30_000))) })));
    expect(short.items).toEqual(['short']);
    const fit = JSON.parse(fitEvent(10, body)) as { items: string[] };
    expect(fit.items.length).toBe(3);
    const none = JSON.parse(fitEvent(1, (n) => ({ items: n ? ['z'.repeat(TRACKING_LIMITS.eventBytes)] : [] }))) as { items: string[] };
    expect(none.items).toEqual([]);
  });
});

describe('what the sources are keyed by, and how they are checked when saved', () => {
  it('starts afresh for another source (or the branch of CI runs), keeps its place when only conditions change', () => {
    const k = triggerKey;
    expect(k({ source: 'calendar', account: 'a', minutes: 5 })).toBe(k({ source: 'calendar', account: 'a', minutes: 30, title: 'x' }));
    expect(k({ source: 'calendar', account: 'a', minutes: 5 })).not.toBe(k({ source: 'calendar', account: 'b', minutes: 5 }));
    expect(k({ source: 'github', repo: 'Octo/App', on: 'ci', branch: 'main' })).toBe(
      k({ source: 'github', repo: 'octo/app', on: 'ci', branch: 'main' }),
    );
    // Another branch lists other runs, failures that are not new among them.
    expect(k({ source: 'github', repo: 'octo/app', on: 'ci' })).not.toBe(
      k({ source: 'github', repo: 'octo/app', on: 'ci', branch: 'main' }),
    );
    expect(k({ source: 'github', repo: 'octo/app', on: 'ci' })).not.toBe(k({ source: 'github', repo: 'octo/app', on: 'pr' }));
    expect(k({ source: 'file', pattern: '*.csv' })).not.toBe(k({ source: 'file', pattern: '*.txt' }));
  });

  it('validates each source: minutes, repository, branch, pattern', () => {
    const save = (trigger: unknown) =>
      withLang('en', () => validateSchedule({ text: 'go', repeat: { kind: 'event', trigger } }, NOW).repeat);
    expect(save({ source: 'calendar', account: 'home', minutes: 15, title: ' standup ' })).toEqual({
      kind: 'event',
      trigger: { source: 'calendar', account: 'home', minutes: 15, title: 'standup' },
    });
    expect(() => save({ source: 'calendar', account: 'home', minutes: 0 })).toThrow('whole number from 1 to 1440');
    expect(() => save({ source: 'calendar', account: 'home', minutes: 2.5 })).toThrow('whole number');
    expect(save({ source: 'github', repo: 'https://github.com/octo/app.git', on: 'ci', branch: 'main' })).toEqual({
      kind: 'event',
      trigger: { source: 'github', repo: 'octo/app', on: 'ci', branch: 'main' },
    });
    // A branch only for CI runs.
    expect(save({ source: 'github', repo: 'octo/app', on: 'pr', branch: 'main' })).toEqual({
      kind: 'event',
      trigger: { source: 'github', repo: 'octo/app', on: 'pr' },
    });
    expect(() => save({ source: 'github', repo: '--help', on: 'pr' })).toThrow('owner/name');
    expect(() => save({ source: 'github', repo: 'octo/app', on: 'issues' })).toThrow();
    expect(() => save({ source: 'github', repo: 'octo/app', on: 'ci', branch: '--all' })).toThrow('not a name git allows');
    expect(save({ source: 'github', repo: 'octo/app', on: 'ci', branch: 'feature/x+y' })).toMatchObject({
      trigger: { branch: 'feature/x+y' },
    });
    expect(save({ source: 'file', pattern: './reports\\*.csv' })).toEqual({
      kind: 'event',
      trigger: { source: 'file', pattern: 'reports/*.csv' },
    });
    for (const pattern of ['', './', '/etc/passwd', 'C:\\x', '../up/*.txt', 'a/../../b', 'reports/', '.git/*.log', 'a/.GIT/x'])
      expect(() => save({ source: 'file', pattern })).toThrow();
    expect(() => save({ source: 'rss', url: 'x' })).toThrow('What to wait for is not complete');
  });
});
