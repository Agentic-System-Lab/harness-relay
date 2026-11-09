import { SCHEDULE_LIMITS, type ConversationSchedule, type ConversationSummary, type ScheduleRepeat, type ScheduleUpdate } from '../shared/types';
import { parseTime, upcomingRuns } from '../shared/schedule';
import type { Messages } from './i18n';

/** The schedule drawer's form: every kind's fields are kept, so switching kinds and back loses nothing. */
export interface ScheduleDraft {
  text: string;
  kind: ScheduleRepeat['kind'];
  /** `once`: a datetime-local value ("YYYY-MM-DDTHH:MM"), in the browser's time zone. */
  at: string;
  /** `daily` / `weekly`: "HH:MM". */
  time: string;
  /** `weekly`: 0 = Sunday. */
  days: number[];
  /** `interval` */
  hours: number;
  timeZone: string;
  enabled: boolean;
  approvals: ConversationSchedule['approvals'];
  missed: ConversationSchedule['missed'];
}

/** The time zone of this browser. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A moment as a datetime-local value, in the browser's time zone. */
export function localInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value as a moment (NaN when it is not one). */
export function fromLocalInput(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return NaN;
  return new Date(value).getTime(); // without an offset, the browser's time zone
}

/** The form for a conversation's schedule, or for a new one: weekdays at 09:00. */
export function draftFrom(s: ConversationSchedule | undefined, now: number, timeZone = browserTimeZone()): ScheduleDraft {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const draft: ScheduleDraft = {
    text: '',
    kind: 'weekly',
    at: localInput(tomorrow.getTime()),
    time: '09:00',
    days: [1, 2, 3, 4, 5],
    hours: 6,
    timeZone,
    enabled: true,
    approvals: 'deny',
    missed: 'skip',
  };
  if (!s) return draft;
  const r = s.repeat;
  return {
    ...draft,
    text: s.text,
    kind: r.kind,
    ...(r.kind === 'once' ? { at: localInput(r.at) } : {}),
    ...(r.kind === 'daily' || r.kind === 'weekly' ? { time: r.time } : {}),
    ...(r.kind === 'weekly' ? { days: [...r.days] } : {}),
    ...(r.kind === 'interval' ? { hours: r.hours } : {}),
    timeZone: s.timeZone,
    enabled: s.enabled,
    approvals: s.approvals,
    missed: s.missed,
  };
}

export function repeatOf(d: ScheduleDraft): ScheduleRepeat {
  switch (d.kind) {
    case 'once':
      return { kind: 'once', at: fromLocalInput(d.at) };
    case 'daily':
      return { kind: 'daily', time: d.time };
    case 'weekly':
      return { kind: 'weekly', time: d.time, days: [...new Set(d.days)].sort((a, b) => a - b) };
    case 'interval':
      return { kind: 'interval', hours: d.hours };
  }
}

/** What the form saves. */
export function toUpdate(d: ScheduleDraft): ScheduleUpdate {
  return {
    text: d.text.trim(),
    repeat: repeatOf(d),
    timeZone: d.timeZone,
    enabled: d.enabled,
    approvals: d.approvals,
    missed: d.missed,
  };
}

/** Whether the form says something other than the saved schedule. */
export function draftChanged(d: ScheduleDraft, s: ConversationSchedule | undefined): boolean {
  if (!s) return true;
  const saved = toUpdate(draftFrom(s, 0));
  return JSON.stringify(toUpdate(d)) !== JSON.stringify(saved);
}

/** What keeps the form from being saved, first problem first (the server checks the same). */
export function draftProblems(d: ScheduleDraft, now: number, t: Messages): string[] {
  const p = t.schedule.problems;
  const out: string[] = [];
  const text = d.text.trim();
  if (!text) out.push(p.text);
  else if (text.length > SCHEDULE_LIMITS.maxText) out.push(p.tooLong(SCHEDULE_LIMITS.maxText));
  switch (d.kind) {
    case 'once': {
      const at = fromLocalInput(d.at);
      if (Number.isNaN(at)) out.push(p.moment);
      else if (d.enabled && at <= now) out.push(p.past);
      break;
    }
    case 'weekly':
    case 'daily':
      if (d.kind === 'weekly' && !d.days.length) out.push(p.days);
      if (!parseTime(d.time)) out.push(p.time);
      break;
    case 'interval':
      if (!Number.isInteger(d.hours) || d.hours < 1 || d.hours > SCHEDULE_LIMITS.maxHours) out.push(p.hours(SCHEDULE_LIMITS.maxHours));
      break;
  }
  return out;
}

/** The next times the form would send, counted from `now` as if it were saved now. */
export function previewRuns(d: ScheduleDraft, now: number, count = 3): number[] {
  return upcomingRuns({ repeat: repeatOf(d), timeZone: d.timeZone, updatedAt: now }, now, count);
}

/** A moment as the schedule UI shows it: weekday, date and time, in this browser's time zone. */
export function formatWhen(ms: number, lang: string): string {
  return new Date(ms).toLocaleString(lang, {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** When a schedule sends, in a few words: "Weekdays at 09:00", "每 6 小時". */
export function describeRepeat(r: ScheduleRepeat, t: Messages, lang: string): string {
  const s = t.schedule.summary;
  switch (r.kind) {
    case 'once':
      return s.once(formatWhen(r.at, lang));
    case 'daily':
      return s.daily(r.time);
    case 'weekly': {
      const days = [...new Set(r.days)].sort((a, b) => a - b);
      if (days.length === 7) return s.everyDay(r.time);
      if (days.join() === '1,2,3,4,5') return s.weekdays(r.time);
      // Monday first, Sunday last, as people read a week.
      const ordered = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)];
      return s.weekly(ordered.map((d) => t.schedule.weekdays[d]).join(t.schedule.daySeparator), r.time);
    }
    case 'interval':
      return s.interval(r.hours);
  }
}

/** Whether a schedule needs a look: the last time it came due, it was not sent. */
export function scheduleTrouble(s: Pick<ConversationSchedule, 'lastResult'> | undefined): boolean {
  return s?.lastResult === 'missed' || s?.lastResult === 'skipped' || s?.lastResult === 'failed';
}

/** The schedule's state in a few words: when it sends next, paused, or (a one-time schedule that ran) done. */
export function scheduleState(s: ConversationSchedule, t: Messages, lang: string): string {
  if (s.enabled && s.nextRunAt !== undefined) return t.schedule.next(formatWhen(s.nextRunAt, lang));
  return s.repeat.kind === 'once' && s.lastRunAt !== undefined ? t.schedule.finished : t.schedule.paused;
}

/** The sidebar's tooltip for a conversation's schedule. */
export function sidebarScheduleTitle(s: NonNullable<ConversationSummary['schedule']>, t: Messages, lang: string): string {
  if (scheduleTrouble(s)) return t.schedule.sidebar.problem(t.schedule.results[s.lastResult!]);
  if (!s.enabled || s.nextRunAt === undefined) return t.schedule.sidebar.paused;
  return t.schedule.sidebar.next(formatWhen(s.nextRunAt, lang));
}
