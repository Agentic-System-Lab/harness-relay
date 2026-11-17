import { randomUUID } from 'node:crypto';
import { validTimeZone, zonedTime } from '../../shared/schedule';
import type { Login } from './imap';
import { t } from '../i18n';
import type { AuthorizedFetch } from '../oauth/providers';

/*
 * A calendar over CalDAV (RFC 4791), enough for the calendar tools: the events in a time range
 * (`REPORT calendar-query`) and a new event (`PUT` of an iCalendar file, never over one that is
 * there). The calendar's address is its collection's own (iCloud, Fastmail, Nextcloud and most others
 * show it); redirects are not followed, so the password goes nowhere else. Times are written in UTC,
 * from a wall-clock time in a time zone, so no VTIMEZONE is needed. A calendar is reached with its
 * password (Basic), or with an OAuth account's token (Google's), through that account's fetch, which
 * sends it only to its provider's hosts (`CalDavAuth`).
 */

export interface CalendarEvent {
  uid: string;
  summary: string;
  start: string;
  end?: string;
  location?: string;
  description?: string;
  /** How it repeats (its RRULE), when it does: the range shows its first time only. */
  repeats?: string;
  attendees: string[];
  /**
   * The moment it starts, for an event at a time (not all day) whose time can be read: in UTC, in a
   * time zone this computer knows, or (floating) in this computer's own. For an automation that starts
   * before an event (`watch.ts`); the tools show `start`.
   */
  at?: number;
  /** It was cancelled (iCalendar's `STATUS:CANCELLED`, Graph's `isCancelled`): an automation leaves it out. */
  cancelled?: boolean;
}

/** The moment a DTSTART at a time starts (`at`), or undefined for a date, or a time zone not known here. */
export function startMoment(value: string, params: Record<string, string>): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(value);
  if (!m || params.VALUE?.toUpperCase() === 'DATE') return undefined;
  const [y, mo, d, h, mi, s] = [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)];
  if (m[7]) return Date.UTC(y, mo - 1, d, h, mi, s);
  const tz = params.TZID?.replace(/^"|"$/g, '');
  if (tz) return validTimeZone(tz) ? zonedTime(y, mo, d, h, mi, tz) + s * 1000 : undefined;
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** iCalendar text unescaped. */
function unescapeText(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/**
 * iCalendar text escaped. Every line break (a bare CR too, which some parsers end a line at) becomes
 * `\n`, and other control characters go, so a value can never start a property of its own (an
 * ATTENDEE, which would invite someone without the outbox).
 */
export function escapeText(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n|\u2028|\u2029|\u0085/g, '\\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** A content line folded at 75 octets (RFC 5545 §3.1), between characters, never inside one. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  // A continuation line starts with a space, which counts.
  let room = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > room) {
      out.push(cur);
      cur = '';
      bytes = 0;
      room = 74;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * A content line's name, parameters and value. A parameter's value may be quoted, and a quoted one
 * may hold `:`, `;` and `,` (a CN, say); a parameter with several values keeps them joined by commas.
 */
export function contentLine(line: string): { name: string; params: Record<string, string>; value: string } | undefined {
  const m = /^[A-Za-z0-9-]+/.exec(line);
  if (!m) return undefined;
  let i = m[0].length;
  const params: Record<string, string> = {};
  while (line[i] === ';') {
    const eq = line.indexOf('=', i + 1);
    if (eq < 0) return undefined;
    const key = line.slice(i + 1, eq).toUpperCase();
    i = eq + 1;
    const values: string[] = [];
    for (;;) {
      if (line[i] === '"') {
        const close = line.indexOf('"', i + 1);
        if (close < 0) return undefined;
        values.push(line.slice(i + 1, close));
        i = close + 1;
      } else {
        const rest = line.slice(i);
        const stop = rest.search(/[;:,]/);
        if (stop < 0) return undefined;
        values.push(rest.slice(0, stop));
        i += stop;
      }
      if (line[i] !== ',') break;
      i++;
    }
    params[key] = values.join(',');
  }
  if (line[i] !== ':') return undefined;
  return { name: m[0].toUpperCase(), params, value: line.slice(i + 1) };
}

/**
 * A DATE or DATE-TIME as the tools show it: `2026-01-05 09:00 UTC`, `… (Asia/Taipei)`, `2026-01-05
 * (all day)`. `end`: an all-day event's end, which iCalendar gives as the day after its last: shown as
 * its last day, as `calendar_create` takes it.
 */
function showTime(value: string, params: Record<string, string>, end = false): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
  if (!m) return value;
  let date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4] && end) date = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]! - 1)).toISOString().slice(0, 10);
  if (!m[4]) return `${date} (all day)`;
  return `${date} ${m[4]}:${m[5]}${m[7] ? ' UTC' : params.TZID ? ` (${params.TZID})` : ''}`;
}

/** The events of an iCalendar text (its VEVENTs; a recurring one by its first time). */
export function parseEvents(ics: string): CalendarEvent[] {
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out: CalendarEvent[] = [];
  let ev: CalendarEvent | undefined;
  let depth = 0;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      ev = { uid: '', summary: '', start: '', attendees: [] };
      depth = 0;
      continue;
    }
    if (!ev) continue;
    if (/^BEGIN:/i.test(line)) depth++;
    else if (/^END:VEVENT$/i.test(line) && depth === 0) {
      out.push(ev);
      ev = undefined;
      continue;
    } else if (/^END:/i.test(line)) depth--;
    if (depth > 0) continue; // inside a VALARM
    const cl = contentLine(line);
    if (!cl) continue;
    const { name, params, value } = cl;
    if (name === 'UID') ev.uid = value;
    else if (name === 'SUMMARY') ev.summary = unescapeText(value);
    else if (name === 'DTSTART') {
      ev.start = showTime(value, params);
      const at = startMoment(value, params);
      if (at !== undefined) ev.at = at;
    } else if (name === 'DTEND') ev.end = showTime(value, params, true);
    else if (name === 'LOCATION') ev.location = unescapeText(value);
    else if (name === 'DESCRIPTION') ev.description = unescapeText(value).slice(0, 2000);
    else if (name === 'RRULE') ev.repeats = value;
    else if (name === 'STATUS' && value.trim().toUpperCase() === 'CANCELLED') ev.cancelled = true;
    else if (name === 'ATTENDEE') ev.attendees.push(value.replace(/^mailto:/i, ''));
  }
  return out;
}

/**
 * What each `local` element of `xml` holds, whatever prefix its namespace has, in one pass from start to
 * end: an element never closed ends it, and an opening tag ends at the next `<` at the latest, so an
 * answer takes time in proportion to its size whatever it holds (a server's answer of 16 MB of opening
 * tags included).
 */
export function elementContents(xml: string, local: string): string[] {
  const open = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${local}\\b[^<>]*>`, 'gi');
  const close = new RegExp(`</(?:[A-Za-z0-9_-]+:)?${local}>`, 'gi');
  const out: string[] = [];
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(xml);
    if (!end) break;
    out.push(xml.slice(open.lastIndex, end.index));
    open.lastIndex = close.lastIndex;
  }
  return out;
}

/** An element's text with XML's escapes undone, or what its CDATA section holds. */
function xmlText(v: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(v);
  return cdata
    ? cdata[1]!
    : v
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#13;|&#x0?[dD];/g, '\r')
        .replace(/&amp;/g, '&');
}

/** `calendar-data` out of a multistatus answer, with XML's escapes undone (whatever prefix its namespace has). */
export function calendarData(xml: string): string[] {
  return elementContents(xml, 'calendar-data').map(xmlText);
}

/**
 * An opening tag named `local` up to its `>` (or `/>`), whatever its namespace prefix and attributes:
 * iCloud writes `<href xmlns="DAV:">` and `<calendar xmlns="urn:ietf:params:xml:ns:caldav"/>`.
 */
function openTag(local: string): string {
  return `<(?:[A-Za-z0-9_-]+:)?${local}(?=[\\s/>])[^<>]*`;
}

/** A moment as iCalendar's UTC DATE-TIME. */
function utc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * A time the user or an agent gave: `2026-01-05` (all day), `2026-01-05T09:00` (wall-clock time in
 * `timeZone`) or an ISO time with its offset or `Z`. As iCalendar's value and, for a range, a moment.
 */
export function eventTime(raw: string, timeZone: string): { ics: string; ms: number; allDay: boolean } {
  const s = raw.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) return { ics: `;VALUE=DATE:${day[1]}${day[2]}${day[3]}`, ms: Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!), allDay: true };
  const wall = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (wall) {
    if (!validTimeZone(timeZone)) throw new Error(`Unknown time zone "${timeZone}"`);
    const ms = zonedTime(+wall[1]!, +wall[2]!, +wall[3]!, +wall[4]!, +wall[5]!, timeZone);
    return { ics: `:${utc(ms)}`, ms, allDay: false };
  }
  const ms = Date.parse(s);
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) || Number.isNaN(ms))
    throw new Error(`"${raw}" is not a date (YYYY-MM-DD) or a time (YYYY-MM-DDTHH:MM)`);
  return { ics: `:${utc(ms)}`, ms, allDay: false };
}

/**
 * A range's end point: a date is its midnight in `timeZone` (`end`: the midnight after it, so the
 * range takes the whole day), a time as `eventTime()` reads it.
 */
export function rangeTime(raw: string, timeZone: string, end = false): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!day) return eventTime(raw, timeZone).ms;
  if (!validTimeZone(timeZone)) throw new Error(`Unknown time zone "${timeZone}"`);
  const midnight = zonedTime(+day[1]!, +day[2]!, +day[3]!, 0, 0, timeZone);
  if (!end) return midnight;
  const next = new Date(Date.UTC(+day[1]!, +day[2]! - 1, +day[3]! + 1));
  return zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
}

export interface NewEvent {
  summary: string;
  start: string;
  end: string;
  timeZone: string;
  location?: string;
  description?: string;
  /** Who is invited: the server mails them an invitation from `organizer`. */
  attendees?: string[];
  organizer?: string;
}

/** A new event as an iCalendar file, and its UID. */
export function composeEvent(e: NewEvent, now = Date.now()): { uid: string; ics: string } {
  const start = eventTime(e.start, e.timeZone);
  const end = eventTime(e.end, e.timeZone);
  if (start.allDay !== end.allDay) throw new Error('start and end must both be dates, or both times');
  if (end.ms < start.ms || (end.ms === start.ms && !start.allDay)) throw new Error('The end must come after the start');
  // An all-day event's end is its last day, given; iCalendar's is the day after it.
  const endIcs = start.allDay ? `;VALUE=DATE:${utc(end.ms + 86_400_000).slice(0, 8)}` : end.ics;
  const uid = `${randomUUID()}@harness-relay`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Harness Relay//Calendar//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART${start.ics}`,
    `DTEND${endIcs}`,
    `SUMMARY:${escapeText(e.summary)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
    ...(e.attendees?.length && e.organizer ? [`ORGANIZER:mailto:${e.organizer}`] : []),
    ...(e.attendees ?? []).map((a) => `ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:${a}`),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return { uid, ics: lines.map(foldLine).join('\r\n') + '\r\n' };
}

/** The most a calendar's answer may hold: a month or two of events many times over. */
export const CALDAV_MAX_ANSWER = 16 * 1024 * 1024;

/** A calendar's answer as text, refused once it is longer than `max` (read no further). */
export async function answerText(res: Response, max = CALDAV_MAX_ANSWER): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(t().conn.calTooMuch);
  }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(t().conn.calTooMuch);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * How the requests to a calendar are signed: its user name and password (Basic authentication), or an
 * OAuth account's token, by that account's fetch (`TokenBroker.fetch`: only to its provider's hosts).
 */
export type CalDavAuth = Login | { fetch: AuthorizedFetch };

/** A request to the calendar, signed as `auth` says; never following a redirect, so the password or token goes nowhere else. */
function send(auth: CalDavAuth, url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
  if ('fetch' in auth) return auth.fetch(url, init);
  const basic = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  return fetch(url, { ...init, headers: { ...init.headers, authorization: basic }, redirect: 'manual' });
}

/** A calendar's answer that is not what was asked: why, in a line. */
async function failure(res: Response, what: string): Promise<Error> {
  if (res.status === 401 || res.status === 403) return new Error(t().conn.calLogin(what, res.status));
  if (res.status >= 300 && res.status < 400) return new Error(t().conn.calMoved(what, res.headers.get('location') ?? String(res.status)));
  return new Error(t().conn.calStatus(what, `${res.status} ${res.statusText}`.trim()));
}

/** The answers a server that cannot expand recurring events gives a REPORT asking it to: asked again without. */
const NO_EXPAND = new Set([400, 403, 415, 501]);

/**
 * The events between two moments. `expand`: each time of a recurring event on its own, as the server
 * expands it (RFC 4791's `expand`, in UTC); a server that refuses that (`NO_EXPAND`) is asked once more
 * without it, and one that does not expand gives a recurring event's first time only.
 */
export async function listEvents(
  url: string,
  login: CalDavAuth,
  from: number,
  to: number,
  timeoutMs = 30_000,
  expand = false,
): Promise<CalendarEvent[]> {
  const report = (expanded: boolean) => {
    const data = expanded ? `<c:calendar-data><c:expand start="${utc(from)}" end="${utc(to)}"/></c:calendar-data>` : '<c:calendar-data/>';
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/>${data}</d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${utc(from)}" end="${utc(to)}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
    return send(login, url, {
      method: 'REPORT',
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
  let res = await report(expand);
  if (expand && NO_EXPAND.has(res.status)) {
    await res.body?.cancel().catch(() => undefined);
    res = await report(false);
  }
  if (res.status !== 207 && res.status !== 200) throw await failure(res, t().conn.calListFailed);
  const xml = await answerText(res);
  return calendarData(xml).flatMap(parseEvents);
}

/** Adds an event, never over one that is there; resolves with its address. */
export async function putEvent(url: string, login: CalDavAuth, ics: string, uid: string, timeoutMs = 30_000): Promise<string> {
  const target = `${url.replace(/\/+$/, '')}/${encodeURIComponent(uid.replace(/@.*$/, ''))}.ics`;
  const res = await send(login, target, {
    method: 'PUT',
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
    body: ics,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 201 && res.status !== 204 && res.status !== 200) throw await failure(res, t().conn.calAddFailed);
  return target;
}

/**
 * Whether the password given for `given` may go to `next` too: the same provider's address. The same
 * host, or one under the domain `given`'s host is in (`p42-caldav.icloud.com` for `caldav.icloud.com`),
 * unless that domain looks like a country's public one (`co.uk`), where only the same host is; an
 * address only as itself; never from https to http.
 */
export function sameProvider(given: URL | string, next: URL | string): boolean {
  const a = typeof given === 'string' ? new URL(given) : given;
  const b = typeof next === 'string' ? new URL(next) : next;
  if (a.protocol === 'https:' && b.protocol !== 'https:') return false;
  if (b.protocol !== 'https:' && b.protocol !== 'http:') return false;
  const ha = a.hostname.toLowerCase().replace(/\.$/, '');
  const hb = b.hostname.toLowerCase().replace(/\.$/, '');
  if (ha === hb) return true;
  const ip = (h: string) => h.startsWith('[') || /^\d+(\.\d+){3}$/.test(h);
  if (ip(ha) || ip(hb)) return false;
  const labels = ha.split('.');
  if (labels.length < 3) return false;
  const parent = labels.slice(1).join('.');
  if (/^[a-z]{2,3}\.[a-z]{2}$/.test(parent)) return false;
  return hb.endsWith(`.${parent}`);
}

/** The first `href` inside an element named `name` (any namespace prefix, any attributes), resolved against `base`. */
function hrefIn(xml: string, name: string, base: string): string | undefined {
  const m = new RegExp(`${openTag(name)}>\\s*${openTag('href')}>([^<]+)</`, 'i').exec(xml);
  return m ? new URL(xmlText(m[1]!.trim()), base).href : undefined;
}

async function propfind(url: string, login: CalDavAuth, depth: '0' | '1', props: string, timeoutMs: number): Promise<string> {
  const res = await send(login, url, {
    method: 'PROPFIND',
    headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 207) throw await failure(res, t().conn.calFindFailed);
  return answerText(res);
}

/**
 * The calendars of an account, from its server's address (`https://caldav.icloud.com/`) or any
 * address on it: its principal, its calendar home, and the calendars there, each with its name and its
 * own address, which the calendar tools use. Only addresses of the same provider are asked. A calendar
 * that says which kinds of items it holds, none of them events (iCloud's Reminders lists hold to-dos
 * only), is left out: the calendar tools could not add an event to it.
 */
export async function discoverCalendars(url: string, login: CalDavAuth, timeoutMs = 20_000): Promise<{ name: string; url: string }[]> {
  const follow = (next: string | undefined) => {
    if (!next) return undefined;
    if (!sameProvider(url, next))
      throw new Error(
        `The calendar points at another address (${new URL(next).origin}), which the password does not go to; give that one instead`,
      );
    return next;
  };
  const root = await propfind(url, login, '0', '<d:current-user-principal/><c:calendar-home-set/>', timeoutMs);
  let home = follow(hrefIn(root, 'calendar-home-set', url));
  if (!home) {
    const principal = follow(hrefIn(root, 'current-user-principal', url));
    if (!principal) throw new Error("The server did not say where the calendars are: give the calendar's own address");
    home = follow(hrefIn(await propfind(principal, login, '0', '<c:calendar-home-set/>', timeoutMs), 'calendar-home-set', principal));
    if (!home) throw new Error("The server did not say where the calendars are: give the calendar's own address");
  }
  const list = await propfind(home, login, '1', '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>', timeoutMs);
  const out: { name: string; url: string }[] = [];
  const calendarType = new RegExp(openTag('calendar'), 'i');
  const hrefTag = new RegExp(`${openTag('href')}>([^<]+)<`, 'i');
  const nameTag = new RegExp(`${openTag('displayname')}>([^<]*)<`, 'i');
  for (const r of elementContents(list, 'response')) {
    if (!elementContents(r, 'resourcetype').some((t) => calendarType.test(t))) continue;
    const kinds = elementContents(r, 'supported-calendar-component-set').flatMap((s) =>
      [...s.matchAll(/\bname\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]!.trim().toUpperCase()),
    );
    if (kinds.length && !kinds.includes('VEVENT')) continue;
    const href = hrefTag.exec(r)?.[1]?.trim();
    if (!href) continue;
    const name = xmlText(nameTag.exec(r)?.[1] ?? '').trim();
    const abs = new URL(xmlText(href), home).href;
    if (!sameProvider(url, abs)) continue;
    out.push({ name: name || decodeURIComponent(abs.replace(/\/+$/, '').split('/').pop() ?? abs), url: abs });
  }
  return out;
}
