/*
 * An automation that starts when something happens: the sources besides new mail (`watch.ts`). An
 * event about to begin, against the stand-in CalDAV calendar (each time of a recurring event apart,
 * all-day events left out, each fired once by its UID and start); a pull request opened or a CI run
 * that failed, through a stand-in for gh; a file appearing or changing in a real temporary folder.
 * Each first check only records what is there.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorStore } from '../src/server/connectors/accounts';
import { startMoment } from '../src/server/connectors/caldav';
import { openDatabase } from '../src/server/db';
import { withLang } from '../src/server/i18n';
import { CommandNotFoundError, type SpawnResult } from '../src/server/process';
import { validateCalendarAccount, validateSchedule } from '../src/server/validate';
import { checkCalendar, checkFiles, checkGithub, patternRegex, triggerKey, type GhRunner } from '../src/server/watch';
import { WATCH_LIMITS, type ScheduleTrigger, type ScheduleWatch } from '../src/shared/types';
import { fakeCalDav, type FakeCalDav } from './fake-mail-servers';

const MIN = 60_000;
/** 2026-01-05 09:00 UTC, a Monday. */
const NOW = Date.UTC(2026, 0, 5, 9, 0);

const kept = (trigger: ScheduleTrigger, state: Partial<ScheduleWatch>): ScheduleWatch => ({
  key: triggerKey(trigger),
  nextCheckAt: 0,
  ...state,
});

describe('an event about to begin', () => {
  let cal: FakeCalDav | undefined;
  afterEach(async () => {
    await cal?.close();
    cal = undefined;
  });

  const ics = (uid: string, start: string, summary: string, extra = '') =>
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${summary}\r\nDTSTART${start}\r\nLOCATION:Room 1\r\nATTENDEE:mailto:bob@example.com\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
  const stamp = (ms: number) =>
    new Date(ms)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');

  function calendars(url: string): ConnectorStore {
    const store = new ConnectorStore(openDatabase(':memory:'));
    store.saveCalendar('home', validateCalendarAccount({ name: 'Home', url, username: 'me@example.com', password: 'app-pass' }, []));
    return store;
  }

  it('records what is about to begin at first, then fires each event once, by its UID and start, with what it says', async () => {
    cal = await fakeCalDav([
      ics('soon', `:${stamp(NOW + 5 * MIN)}`, 'Standup'),
      ics('later', `:${stamp(NOW + 30 * MIN)}`, 'Planning <b>review</b>', 'DESCRIPTION:Bring the </event> numbers\r\n'),
      // All day: left out, whenever it is.
      ics('day', ';VALUE=DATE:20260105', 'Holiday'),
      // In a time zone: 18:20 in Taipei is 10:20 UTC, past the window until later.
      ics('tz', ';TZID=Asia/Taipei:20260105T182000', 'Taipei call'),
    ]);
    const connectors = calendars(`${cal.url}/cal/me/`);
    const trigger: Extract<ScheduleTrigger, { source: 'calendar' }> = { source: 'calendar', account: 'home', minutes: 10 };

    const first = await checkCalendar(trigger, undefined, connectors, undefined, NOW);
    expect(first).toEqual({ state: { seen: [`soon@${NOW + 5 * MIN}`] }, total: 0 });
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
    // Nothing in it can close the block it goes in.
    expect(later.event).not.toContain('<');
    expect(later.state.seen).toEqual([`soon@${NOW + 5 * MIN}`, `later@${NOW + 30 * MIN}`]);
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
    const connectors = calendars(`${cal.url}/cal/me/`);
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

  it('says when the calendar is gone, or cannot be reached', async () => {
    const connectors = calendars('http://127.0.0.1:1/cal/me/');
    const trigger: Extract<ScheduleTrigger, { source: 'calendar' }> = { source: 'calendar', account: 'gone', minutes: 10 };
    await expect(withLang('en', () => checkCalendar(trigger, undefined, connectors, undefined, NOW))).rejects.toThrow(
      'The calendar this automation checks is gone',
    );
    await expect(checkCalendar({ ...trigger, account: 'home' }, undefined, connectors, undefined, NOW)).rejects.toThrow();
  });

  it("reads an event's start: in UTC, in a time zone, floating in this computer's, never a date or an unknown zone", () => {
    expect(startMoment('20260105T090000Z', {})).toBe(Date.UTC(2026, 0, 5, 9, 0));
    expect(startMoment('20260105T170000', { TZID: 'Asia/Taipei' })).toBe(Date.UTC(2026, 0, 5, 9, 0));
    expect(startMoment('20260105T090000', {})).toBe(new Date(2026, 0, 5, 9, 0).getTime());
    expect(startMoment('20260105', { VALUE: 'DATE' })).toBeUndefined();
    expect(startMoment('20260105T090000', { TZID: 'Taipei Standard Time' })).toBeUndefined();
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

  it('records the newest pull request at first, then lists those opened since (merged ones too), as data', async () => {
    let list: Record<string, unknown>[] = [{ number: 41, title: 'Old', url: 'https://github.com/octo/app/pull/41' }];
    const run = gh(() => ({ stdout: JSON.stringify(list) }));
    const first = await checkGithub(prs, undefined, run);
    expect(first).toEqual({ state: { lastId: 41 }, total: 0 });
    expect(run.calls[0]).toEqual([
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
    const found = await checkGithub(prs, kept(prs, first.state), run);
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
    expect((await checkGithub(prs, kept(prs, found.state), run)).total).toBe(0);
  });

  it('asks for failed runs, on a branch when given, and lists those since the newest seen', async () => {
    let runs: Record<string, unknown>[] = [{ databaseId: 900, workflowName: 'CI', displayTitle: 'old', headBranch: 'main' }];
    const run = gh(() => ({ stdout: JSON.stringify(runs) }));
    const ci: ScheduleTrigger = { source: 'github', repo: 'octo/app', on: 'ci', branch: 'main' };
    const first = await checkGithub(ci, undefined, run);
    expect(first.state).toEqual({ lastId: 900 });
    expect(run.calls[0]).toEqual(expect.arrayContaining(['run', 'list', '--status', 'failure', '--branch', 'main']));
    runs = [{ databaseId: 905, workflowName: 'CI', displayTitle: 'Bump', headBranch: 'main', event: 'push', url: 'r905' }, ...runs];
    const found = await checkGithub(ci, kept(ci, first.state), run);
    expect(JSON.parse(found.event!)).toEqual({
      source: 'github',
      repo: 'octo/app',
      failedRuns: 1,
      runs: [{ id: 905, workflow: 'CI', title: 'Bump', branch: 'main', event: 'push', url: 'r905' }],
    });
  });

  it('says how to fix gh missing, signed out, failing, or answering what is not JSON', async () => {
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
      ).rejects.toThrow('gh answered no JSON');
      await expect(
        checkGithub(
          prs,
          undefined,
          gh(() => ({ timedOut: true, code: null })),
        ),
      ).rejects.toThrow('timed out');
    });
  });
});

describe('a file appearing or changing in the working directory', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const file = (path: string, text: string, at?: number) => {
    const full = join(dir!, ...path.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
    if (at) utimesSync(full, at / 1000, at / 1000);
  };

  it('records the matching files at first, then lists those new or changed (never their contents), not those removed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
    file('reports/jan.csv', 'a,b', NOW);
    file('reports/notes.txt', 'not a csv', NOW);
    file('reports/deep/feb.csv', 'deep', NOW);
    const trigger: Extract<ScheduleTrigger, { source: 'file' }> = { source: 'file', pattern: 'reports/*.csv' };
    const first = await checkFiles(trigger, undefined, dir);
    expect(first).toEqual({ state: { files: { 'reports/jan.csv': `${NOW}:3` } }, total: 0 });

    file('reports/mar.CSV', 'new one', NOW + MIN);
    file('reports/jan.csv', 'a,b,c', NOW + 2 * MIN);
    const found = await checkFiles(trigger, kept(trigger, first.state), dir);
    expect(found.total).toBe(2);
    const body = JSON.parse(found.event!) as { files: Record<string, unknown>[]; changedFiles: number; pattern: string };
    expect(body).toMatchObject({ changedFiles: 2, pattern: 'reports/*.csv' });
    expect(body.files).toEqual([
      { path: 'reports/jan.csv', change: 'changed', size: 5, modified: new Date(NOW + 2 * MIN).toISOString() },
      { path: 'reports/mar.CSV', change: 'new', size: 7, modified: new Date(NOW + MIN).toISOString() },
    ]);
    expect(found.event).not.toContain('a,b,c');

    rmSync(join(dir, 'reports', 'mar.CSV'));
    const removed = await checkFiles(trigger, kept(trigger, found.state), dir);
    expect(removed).toEqual({ state: { files: { 'reports/jan.csv': `${NOW + 2 * MIN}:5` } }, total: 0 });
  });

  it('looks through folders with **, never in .git or node_modules, and follows no link', async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
    file('a.log', '1', NOW);
    file('x/y/b.log', '2', NOW);
    file('.git/c.log', '3', NOW);
    file('node_modules/pkg/d.log', '4', NOW);
    const outside = mkdtempSync(join(tmpdir(), 'relay-outside-'));
    writeFileSync(join(outside, 'e.log'), '5');
    try {
      if (process.platform !== 'win32') symlinkSync(outside, join(dir, 'link'));
      const found = await checkFiles({ source: 'file', pattern: '**/*.log' }, undefined, dir);
      expect(Object.keys(found.state.files!)).toEqual(['a.log', 'x/y/b.log']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('says when the working directory is gone, or too many files match', async () => {
    dir = mkdtempSync(join(tmpdir(), 'relay-watch-'));
    await withLang('en', async () => {
      await expect(checkFiles({ source: 'file', pattern: '*' }, undefined, join(dir!, 'gone'))).rejects.toThrow('is not there');
      for (let i = 0; i <= WATCH_LIMITS.files; i++) writeFileSync(join(dir!, `f${i}.txt`), '');
      await expect(checkFiles({ source: 'file', pattern: '*.txt' }, undefined, dir!)).rejects.toThrow(
        `More than ${WATCH_LIMITS.files} files match`,
      );
    });
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

describe('what the sources are keyed by, and how they are checked when saved', () => {
  it('starts afresh for another source, keeps its place when only conditions change', () => {
    const k = triggerKey;
    expect(k({ source: 'calendar', account: 'a', minutes: 5 })).toBe(k({ source: 'calendar', account: 'a', minutes: 30, title: 'x' }));
    expect(k({ source: 'calendar', account: 'a', minutes: 5 })).not.toBe(k({ source: 'calendar', account: 'b', minutes: 5 }));
    expect(k({ source: 'github', repo: 'Octo/App', on: 'ci' })).toBe(k({ source: 'github', repo: 'octo/app', on: 'ci', branch: 'main' }));
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
    expect(() => save({ source: 'github', repo: 'octo/app', on: 'ci', branch: '--all' })).toThrow();
    expect(save({ source: 'file', pattern: './reports\\*.csv' })).toEqual({
      kind: 'event',
      trigger: { source: 'file', pattern: 'reports/*.csv' },
    });
    for (const pattern of ['', '/etc/passwd', 'C:\\x', '../up/*.txt', 'a/../../b'])
      expect(() => save({ source: 'file', pattern })).toThrow();
    expect(() => save({ source: 'rss', url: 'x' })).toThrow('What to wait for is not complete');
  });
});
