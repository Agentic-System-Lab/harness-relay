import type { ConversationSchedule } from './types';

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

export interface ZonedParts {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday */
  weekday: number;
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
