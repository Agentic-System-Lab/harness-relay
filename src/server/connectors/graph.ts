import { validTimeZone, zonedParts } from '../../shared/schedule';
import { t } from '../i18n';
import type { AuthorizedFetch } from '../oauth/providers';
import { answerText, eventTime, type CalendarEvent, type NewEvent } from './caldav';

/*
 * A Microsoft 365 or Outlook.com calendar over Microsoft Graph, enough for the calendar tools: the
 * account's calendars (`/me/calendars`), the events in a time range (`calendarView`, each time of a
 * recurring event on its own), and a new event (`POST …/events`; Graph mails the invitations itself
 * when it has attendees). A calendar's address is its Graph address (`…/v1.0/me/calendar`, or
 * `…/me/calendars/{id}`). Every request goes through the account's fetch, which sends its token only to
 * Graph's host and follows no redirect. Times are asked for and given in UTC.
 */

/** The most pages of events one listing reads (Graph gives up to 200 a page). */
const MAX_PAGES = 5;

/** Graph's answer as JSON, or an error that says what failed (its own message after ours). */
async function graphJson<T>(res: Response, what: string): Promise<T> {
  const text = await answerText(res);
  if (!res.ok) {
    let why = `${res.status} ${res.statusText}`.trim();
    try {
      const e = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (e.error?.message) why = `${why}: ${e.error.message}`;
    } catch {
      /* not JSON */
    }
    throw new Error(res.status === 401 || res.status === 403 ? t().conn.calLogin(what, res.status) : t().conn.calStatus(what, why));
  }
  return JSON.parse(text) as T;
}

/**
 * The calendars of the signed-in account, which it can add events to. Its own (`isDefaultCalendar`) at
 * `…/me/calendar`, the address a new sign-in adds it as, so it is not listed as one to add again.
 */
export async function graphCalendars(fetch: AuthorizedFetch, graph: string): Promise<{ name: string; url: string }[]> {
  const res = await fetch(`${graph}/v1.0/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100`, {
    signal: AbortSignal.timeout(20_000),
  });
  const body = await graphJson<{ value?: { id: string; name?: string; canEdit?: boolean; isDefaultCalendar?: boolean }[] }>(
    res,
    t().conn.calFindFailed,
  );
  return (body.value ?? [])
    .filter((c) => c.canEdit !== false)
    .map((c) => ({
      name: c.name || c.id,
      url: c.isDefaultCalendar ? `${graph}/v1.0/me/calendar` : `${graph}/v1.0/me/calendars/${encodeURIComponent(c.id)}`,
    }));
}

interface GraphTime {
  dateTime: string;
  timeZone?: string;
}

interface GraphEvent {
  id: string;
  iCalUId?: string;
  subject?: string;
  isAllDay?: boolean;
  start?: GraphTime;
  end?: GraphTime;
  /** The time zones it was made in: an IANA name (`Pacific/Auckland`), or Windows' (`New Zealand Standard Time`, from Outlook). */
  originalStartTimeZone?: string;
  originalEndTimeZone?: string;
  location?: { displayName?: string };
  bodyPreview?: string;
  attendees?: { emailAddress?: { address?: string; name?: string } }[];
}

const DAY_MS = 86_400_000;

/**
 * The day an all-day event's time stands for (midnight UTC of its date). Its times are midnight in its
 * own time zone, which the events being asked for in UTC may move off midnight (`2026-01-05T16:00` for
 * 6 January in Taipei): such a time is the date it is in its own time zone, when Graph names that by
 * its IANA name (`zone`, the event's `originalStartTimeZone`); else it is rounded to the nearest day,
 * which is the event's own from UTC−11 to UTC+12 (further east, UTC+13 and +14, as in New Zealand's
 * summer time, a day early still).
 */
function allDayDate(at: number, given: GraphTime, zone: string | undefined): number {
  const inUtc = !given.timeZone || given.timeZone.toUpperCase() === 'UTC';
  if (at % DAY_MS !== 0 && inUtc && zone && validTimeZone(zone)) {
    const p = zonedParts(at, zone);
    return Date.UTC(p.year, p.month - 1, p.day);
  }
  return Math.round(at / DAY_MS) * DAY_MS;
}

/**
 * A Graph time as the calendar tools show it (`2026-01-05 09:00 UTC`, `2026-01-05 (all day)`), as
 * `parseEvents()` shows CalDAV's. `end`: an all-day event's end, which Graph gives as the day after its
 * last: shown as its last day. `zone`: the time zone an all-day event was made in (`allDayDate()`).
 */
function showTime(t: GraphTime | undefined, allDay: boolean, end = false, zone?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(t?.dateTime ?? '');
  if (!t || !m) return t?.dateTime ?? '';
  if (allDay) {
    const day = allDayDate(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!), t, zone) - (end ? DAY_MS : 0);
    return `${new Date(day).toISOString().slice(0, 10)} (all day)`;
  }
  const shownZone = t.timeZone && t.timeZone !== 'UTC' ? ` (${t.timeZone})` : ' UTC';
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}${shownZone}`;
}

/** A Graph event as the calendar tools list it. */
export function graphEvent(e: GraphEvent): CalendarEvent {
  const allDay = Boolean(e.isAllDay);
  return {
    uid: e.iCalUId ?? e.id,
    summary: e.subject ?? '',
    start: showTime(e.start, allDay, false, e.originalStartTimeZone),
    ...(e.end ? { end: showTime(e.end, allDay, true, e.originalEndTimeZone || e.originalStartTimeZone) } : {}),
    ...(e.location?.displayName ? { location: e.location.displayName } : {}),
    ...(e.bodyPreview ? { description: e.bodyPreview.slice(0, 2000) } : {}),
    // No `repeats`: `calendarView` lists each time of a recurring event apart, as an event of its own.
    attendees: (e.attendees ?? []).flatMap((a) => (a.emailAddress?.address ? [a.emailAddress.address] : [])),
    ...(allDay ? {} : moment(e.start)),
  };
}

/** The moment an event at a time starts (`CalendarEvent.at`): Graph gives it in UTC, as it was asked to. */
function moment(t: GraphTime | undefined): { at?: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(t?.dateTime ?? '');
  if (!m || (t?.timeZone && t.timeZone !== 'UTC')) return {};
  return { at: Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)) };
}

/** Graph's time of a moment: UTC, to the second, without its zone (given apart). */
function utc(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '');
}

/** The events of a calendar (its Graph address) between two moments, each time of a recurring one on its own. */
export async function graphEvents(fetch: AuthorizedFetch, calendar: string, from: number, to: number): Promise<CalendarEvent[]> {
  const select = 'id,iCalUId,subject,isAllDay,start,end,originalStartTimeZone,originalEndTimeZone,location,bodyPreview,attendees';
  let next: string | undefined =
    `${calendar.replace(/\/+$/, '')}/calendarView?startDateTime=${encodeURIComponent(`${utc(from)}Z`)}` +
    `&endDateTime=${encodeURIComponent(`${utc(to)}Z`)}&$top=200&$orderby=start/dateTime&$select=${select}`;
  const out: CalendarEvent[] = [];
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const res = await fetch(next, {
      headers: { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' },
      signal: AbortSignal.timeout(30_000),
    });
    const body: { value?: GraphEvent[]; '@odata.nextLink'?: string } = await graphJson(res, t().conn.calListFailed);
    out.push(...(body.value ?? []).map(graphEvent));
    // The next page is on Graph too; the account's fetch sends the token nowhere else.
    next = body['@odata.nextLink'];
  }
  return out;
}

/**
 * The event Graph is asked to add: a timed one in UTC (worked out from the wall-clock time in the time
 * zone given, as CalDAV's is), an all-day one from midnight to the midnight after its last day.
 */
export function graphNewEvent(e: NewEvent): Record<string, unknown> {
  const start = eventTime(e.start, e.timeZone);
  const end = eventTime(e.end, e.timeZone);
  if (start.allDay !== end.allDay) throw new Error('start and end must both be dates, or both times');
  if (end.ms < start.ms || (end.ms === start.ms && !start.allDay)) throw new Error('The end must come after the start');
  const day = (ms: number) => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00`;
  const times = start.allDay
    ? {
        isAllDay: true,
        start: { dateTime: day(start.ms), timeZone: e.timeZone },
        end: { dateTime: day(end.ms + 86_400_000), timeZone: e.timeZone },
      }
    : { start: { dateTime: utc(start.ms), timeZone: 'UTC' }, end: { dateTime: utc(end.ms), timeZone: 'UTC' } };
  return {
    subject: e.summary,
    ...times,
    ...(e.location ? { location: { displayName: e.location } } : {}),
    ...(e.description ? { body: { contentType: 'text', content: e.description } } : {}),
    ...(e.attendees?.length ? { attendees: e.attendees.map((address) => ({ emailAddress: { address }, type: 'required' })) } : {}),
  };
}

/** Adds an event to a calendar (its Graph address); with attendees, Graph mails them the invitation. */
export async function graphAddEvent(fetch: AuthorizedFetch, calendar: string, e: NewEvent): Promise<void> {
  const res = await fetch(`${calendar.replace(/\/+$/, '')}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: 'outlook.timezone="UTC"' },
    body: JSON.stringify(graphNewEvent(e)),
    signal: AbortSignal.timeout(30_000),
  });
  await graphJson(res, t().conn.calAddFailed);
}
