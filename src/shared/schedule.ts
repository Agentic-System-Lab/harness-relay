import type { ConversationSchedule, ScheduleTrigger, ScheduleWatch, ZonedParts } from './types';

/*
 * When a conversation's schedule sends its message. Pure functions, used by the server (to decide when
 * to send) and the browser (to show the next times before saving).
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" (24-hour) as numbers; undefined when it is not one. */
export function parseTime(time: string): { hour: number; minute: number } | undefined {
  const m = TIME_RE.exec(time);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : undefined;
}

/** Whether `tz` is an IANA time zone this runtime knows. */
export function validTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock date and time of an instant in a time zone. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const year = p.year!;
  const month = p.month!;
  const day = p.day!;
  return {
    year,
    month,
    day,
    hour: p.hour === 24 ? 0 : p.hour!, // some engines write midnight as 24
    minute: p.minute!,
    second: p.second!,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** How far the time zone's clocks are ahead of UTC at an instant, in ms. */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time in a time zone stands for. A time that happens twice (clocks go back)
 * is the first; one that does not exist (clocks go forward) moves forward by the jump, e.g. 02:30 on
 * the night clocks go from 02:00 to 03:00 is 03:30.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Clocks change at most once around a given time: the offsets a day before and after cover it.
  const offsets = [...new Set([offsetAt(wall - 86_400_000, tz), offsetAt(wall + 86_400_000, tz)])];
  const fits = offsets.map((o) => wall - o).filter((at) => at + offsetAt(at, tz) === wall);
  if (fits.length) return Math.min(...fits);
  return wall - Math.min(...offsets);
}

/** When a schedule sends next after `after` (exclusive); undefined when it never will. */
export function nextRun(s: Pick<ConversationSchedule, 'repeat' | 'timeZone' | 'updatedAt'>, after: number): number | undefined {
  const r = s.repeat;
  switch (r.kind) {
    case 'manual':
      return undefined; // only Run once now and the webhook send it
    case 'event':
      return undefined; // sent when its checks find something new (`Scheduler`)
    case 'once':
      return r.at > after ? r.at : undefined;
    case 'interval': {
      if (!(r.hours > 0)) return undefined;
      const step = r.hours * 3_600_000;
      // The cadence starts when the schedule was saved: the first time is one interval later.
      const n = Math.max(1, Math.floor((after - s.updatedAt) / step) + 1);
      return s.updatedAt + n * step;
    }
    case 'daily':
    case 'weekly': {
      const time = parseTime(r.time);
      if (!time || !validTimeZone(s.timeZone)) return undefined;
      const days = r.kind === 'weekly' ? new Set(r.days) : undefined;
      if (days && !days.size) return undefined;
      const today = zonedParts(after, s.timeZone);
      // Today's time may have passed: the next one is at most a week and a day away.
      for (let i = 0; i <= 8; i++) {
        const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
        if (days && !days.has(date.getUTCDay())) continue;
        const at = zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), time.hour, time.minute, s.timeZone);
        if (at > after) return at;
      }
      return undefined;
    }
  }
}

/** The next `count` times a schedule sends after `after`. */
export function upcomingRuns(s: Pick<ConversationSchedule, 'repeat' | 'timeZone' | 'updatedAt'>, after: number, count: number): number[] {
  const out: number[] = [];
  for (let at = nextRun(s, after); at !== undefined && out.length < count; at = nextRun(s, at)) out.push(at);
  return out;
}

/*
 * What an automation that starts when something happens waits for, as the form and the server both
 * check it (`draftProblems()` in the browser, `validTrigger()` on the server), so that they agree.
 */

/**
 * For which source a trigger's checks keep what they saw (`ScheduleWatch.key`): another one (account
 * and folder, calendar, repository and what to watch there, the branch of CI runs, pattern) starts
 * afresh. Changing a trigger's conditions (sender, subject, title, minutes) keeps its place: what comes
 * next is matched against the new ones. (Another branch lists other runs, among them failures that are
 * not new: so it starts afresh.) Two triggers of one automation never have the same key.
 */
export function triggerKey(trigger: ScheduleTrigger): string {
  switch (trigger.source) {
    case 'mail':
      return JSON.stringify([trigger.source, trigger.account, trigger.folder]);
    case 'calendar':
      return JSON.stringify([trigger.source, trigger.account]);
    case 'github':
      return JSON.stringify([
        trigger.source,
        trigger.repo.toLowerCase(),
        trigger.on,
        ...(trigger.on === 'ci' ? [trigger.branch ?? ''] : []),
      ]);
    case 'file':
      return JSON.stringify([trigger.source, trigger.pattern]);
  }
}

/** What an automation's checks keep of one of its triggers (by its key), if it was checked. */
export function watchOf<W extends Pick<ScheduleWatch, 'key'>>(s: { watches?: W[] }, trigger: ScheduleTrigger): W | undefined {
  const key = triggerKey(trigger);
  return s.watches?.find((w) => w.key === key);
}

/** Whether two of the triggers wait for the same source (`triggerKey()`): an automation waits for each thing once. */
export function sameTriggers(triggers: ScheduleTrigger[]): boolean {
  const keys = triggers.map(triggerKey);
  return new Set(keys).size !== keys.length;
}

/** A GitHub repository as it is kept: `owner/name`, from that or its address on github.com. */
export function repoName(v: string): string {
  return v
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/(\.git)?\/?$/, '');
}

/** Whether `owner/name` can be a GitHub repository: an owner of at most 39 characters, a name of at most 100 (never `.` or `..`). */
export function validRepo(repo: string): boolean {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.][A-Za-z0-9_.-]{0,99})$/.exec(repo);
  return Boolean(m) && m![2] !== '.' && m![2] !== '..';
}

/**
 * Whether git allows a branch's name, as far as `gh run list --branch` needs: no spaces or control
 * characters, none of `~^:?*[\`, no `..` or `@{`, and not starting with `-` (it would read as an option)
 * or `/`, nor ending with `/`, `.` or `.lock`.
 */
export function validBranch(branch: string): boolean {
  if (!branch || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) return false;
  if (branch.endsWith('.lock') || branch.includes('..') || branch.includes('@{') || branch.includes('//')) return false;
  return !/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(branch);
}

/**
 * A file pattern as it is kept: `/` between folders, without the `./` it may start with; undefined when
 * it does not stay inside the working directory (a full path, a drive, `..`) or is empty (`./` too).
 */
export function filePattern(v: string): string | undefined {
  const pattern = v
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '');
  if (!pattern || pattern === '.' || pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) return undefined;
  const parts = pattern.split('/');
  if (parts.some((p) => p === '..')) return undefined;
  // A folder alone (`reports/`) names no file, and `.git` is never looked in: neither could ever match.
  if (pattern.endsWith('/') || parts.some((p) => p.toLowerCase() === '.git')) return undefined;
  return pattern;
}
