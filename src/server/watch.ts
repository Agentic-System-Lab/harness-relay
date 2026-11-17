import { lstat, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { TRACKING_LIMITS, WATCH_LIMITS, type ScheduleTrigger, type ScheduleWatch, type WatchState } from '../shared/types';
import type { ConnectorStore } from './connectors/accounts';
import { calendarBackend, type CalendarOAuth } from './connectors/calendar';
import type { CalendarEvent } from './connectors/caldav';
import { ImapClient, parseFetch, quote, type ImapResponse } from './connectors/imap';
import { parseHeaders, readMail } from './connectors/mime';
import { t } from './i18n';
import { CommandNotFoundError, runProcess, tail, type SpawnResult } from './process';
import { ghBin, ghEnv, signedOut } from './share';
import { DEFAULT_EXCLUDES } from './workspace';

/*
 * What an automation that starts when something happens waits for (`ScheduleRepeat` `event`), checked
 * by Harness Relay itself (the scheduler calls `checkTrigger()` every few minutes): no address, no
 * token, nothing listening beyond 127.0.0.1. The first check only records what is there; later ones
 * find what came since. The passwords stay in the server, as they do for the mail tools.
 *
 * A new mail: the folder's UIDVALIDITY and the highest UID seen are kept (`ScheduleWatch`); a check asks
 * for the UIDs above it (`UID SEARCH UID n:*`), reads their senders and subjects, keeps those the
 * trigger's conditions match, and lists the newest of them with the start of their text. A folder whose
 * UIDVALIDITY changed was rebuilt: it is recorded again, and nothing fires.
 *
 * An event about to begin: the events of the calendar starting within the trigger's minutes (each time
 * of a recurring one on its own), each fired once, by its UID and start (`seen`); from the last check
 * that worked, so that one that began while checks failed is still found (marked as begun).
 *
 * A pull request opened, through the user's own `gh` (as sharing runs it): the highest number seen is
 * kept, and those above it are new. A CI run that failed: the failed runs seen (by id and attempt) are
 * kept, since a run's id is given when it starts, not when it fails, and a run started again keeps it.
 *
 * A file appearing or changing in the working directory: each matching file's size and time of change
 * are kept, with the folder they were found in, and a file that is new or whose size or time changed is
 * listed (its contents never are), once it has stopped changing for a moment.
 *
 * Every source's `<event>` block is JSON within a webhook body's size (`fitEvent()`), each text from
 * outside cut (`field()`).
 */

/** What a check found: what to keep of the source now, and what is new since the last one (none the first time). */
export interface WatchCheck {
  state: WatchState;
  /** How many new items match, in all. */
  total: number;
  /** The `<event>` block's body for the run, when something new matches (JSON, as a webhook's body is). */
  event?: string;
  /** `file`: each new or changed file found, as it was then (`<mtime>:<size>`): what a hold keeps (`ScheduleWatch.heldFiles`). */
  found?: Record<string, string>;
  /** `file`: each changed file still settling (or with a time ahead of the clock), as it is now: kept like a held one meanwhile. */
  pending?: Record<string, string>;
}

/** What a check needs to know of the automation's conversation, and of the check itself. */
export interface WatchContext {
  /** The conversation's working directory (the file source). */
  cwd: string;
  /** When the check is (the scheduler's clock); now when not given. */
  now?: number;
  /**
   * Only record what is there, listing nothing (the file source): a run is writing in the working
   * directory, or was, and what it writes is the team's own.
   */
  recordOnly?: boolean;
  /**
   * With `recordOnly`: the files a check found and held for the team (`ScheduleWatch.heldFiles`). One
   * still as it was then is no run's: it is kept unseen, so a later check lists it.
   */
  held?: Record<string, string>;
}

/** Checks a trigger's source (`checkTrigger`, or a stand-in in tests). */
export type TriggerChecker = (trigger: ScheduleTrigger, prev: ScheduleWatch | undefined, ctx: WatchContext) => Promise<WatchCheck>;

/**
 * For which source a watch's state was recorded: another one (account and folder, calendar, repository
 * and what to watch there, the branch of CI runs, pattern) starts afresh. Changing a trigger's
 * conditions (sender, subject, title, minutes) keeps its place: what comes next is matched against the
 * new ones. (Another branch lists other runs, among them failures that are not new: so it starts afresh.)
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

/**
 * When the next check is, after `failures` failed checks in a row (0: the last one worked); more
 * slowly while the mail server says when mail arrives (`listening`, IMAP IDLE), which checks at once.
 */
export function nextCheckAt(now: number, failures = 0, listening = false): number {
  const steps = WATCH_LIMITS.backoffMinutes;
  const every = listening ? WATCH_LIMITS.idleCheckMinutes : WATCH_LIMITS.checkMinutes;
  const minutes = failures > 0 ? steps[Math.min(failures, steps.length) - 1]! : every;
  return now + minutes * 60_000;
}

// --- The <event> block -------------------------------------------------------------------------

/**
 * An `<event>` block's body: JSON, as a webhook's body is, with `<` written as `<` (the same
 * data), so that nothing from the source can close the block it goes in.
 */
function eventBody(body: unknown): string {
  return JSON.stringify(body, null, 2).replace(/</g, '\\u003c');
}

/**
 * An `<event>` block's body (`eventBody`) within a webhook body's size (`TRACKING_LIMITS.eventBytes`),
 * for every source: `body(n, short)` is the block listing `n` of its items (`max` at most), and fewer
 * are listed until it fits. When not even one does (each text is cut, but a calendar invitation may
 * still hold many long ones), the first is listed `short` (its longest parts left out), else none.
 */
export function fitEvent(max: number, body: (n: number, short: boolean) => unknown): string {
  const fits = (text: string) => Buffer.byteLength(text) <= TRACKING_LIMITS.eventBytes;
  for (let n = max; n > 0; n--) {
    const text = eventBody(body(n, false));
    if (fits(text)) return text;
  }
  if (max > 0) {
    const text = eventBody(body(1, true));
    if (fits(text)) return text;
  }
  return eventBody(body(0, true));
}

/** Says which of `total` new items a block lists, when it lists `n` of them (`which`: the newest, or the first to begin). */
function listedNote(n: number, total: number, which: 'newest' | 'first'): { listed?: string } {
  if (n >= total) return {};
  return { listed: n ? `the ${which} ${n}` : 'none: too long to list' };
}

/** How many new items there are, as a block says it: `at least` when every one asked for was new, so more may have come. */
function count(total: number, atLeast: boolean): number | string {
  return atLeast ? `at least ${total}` : total;
}

/** The most characters of a text from outside listed (a sender, subject, title, place, branch, path…): whoever sends it writes it. */
const MAX_FIELD_CHARS = 300;

/** Text cut at `MAX_FIELD_CHARS`, as it is otherwise (a path keeps its spaces). */
function cut(v: string): string {
  return v.length > MAX_FIELD_CHARS ? `${v.slice(0, MAX_FIELD_CHARS)}…` : v;
}

/** Text from outside as listed: on one line, cut at `MAX_FIELD_CHARS`. */
function field(v: string | undefined): string {
  return cut((v ?? '').replace(/\s+/g, ' ').trim());
}

/** The items with a key not given before (the first of each kept), in their order. */
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const keys = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (keys.has(k)) return false;
    keys.add(k);
    return true;
  });
}

/** Whether a text contains the words a condition gives (any case); no condition matches everything. */
function contains(value: string | undefined, wanted: string | undefined): boolean {
  if (!wanted?.trim()) return true;
  return (value ?? '').toLowerCase().includes(wanted.trim().toLowerCase());
}

/** Text on one line, cut at `WATCH_LIMITS.excerptChars`. */
function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > WATCH_LIMITS.excerptChars ? `${line.slice(0, WATCH_LIMITS.excerptChars)}…` : line;
}

// --- A new mail ----------------------------------------------------------------------------------

/** A new mail as the run's message lists it. */
export interface NewMail {
  uid: number;
  from: string;
  subject: string;
  date: string;
  messageId?: string;
  excerpt: string;
}

/** The numbers a `UID SEARCH` answered. */
function searchUids(untagged: ImapResponse[]): number[] {
  return untagged.flatMap((r) =>
    /^\* SEARCH\b/i.test(r.text)
      ? r.text
          .replace(/^\* SEARCH\s*/i, '')
          .split(/\s+/)
          .filter((x) => /^\d+$/.test(x))
          .map(Number)
      : [],
  );
}

/** A response code's number in the answers to EXAMINE (`[UIDVALIDITY 3]`, `[UIDNEXT 42]`). */
function responseCode(untagged: ImapResponse[], status: string, name: string): number | undefined {
  const re = new RegExp(`\\[${name} (\\d+)\\]`, 'i');
  for (const text of [...untagged.map((r) => r.text), status]) {
    const m = re.exec(text);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** The start of a mail's text, on one line. */
function excerptOf(raw: string): string {
  return excerpt(readMail(raw).text);
}

/** The most UIDs whose senders and subjects one check reads: the newest, when more came at once. */
const MAX_HEADERS = 200;
/**
 * How much older than the last time mail was recorded as seen (`seenAt`, not the last check: held or
 * failing checks do not record) a new UID's mail may have arrived (its INTERNALDATE) and still count
 * as new: old mail moved into the folder (from an archive, say) gets new UIDs, but keeps when it
 * arrived; a day covers clocks that disagree, and mail a server takes in late.
 */
const MOVED_MS = 86_400_000;

/** When IMAP says a mail arrived (INTERNALDATE, `05-Jan-2026 09:01:00 +0000`), or undefined when it cannot be read. */
export function internalDate(v: string | undefined): number | undefined {
  const m = /^\s?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(v ?? '');
  const month = m ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2]!.toLowerCase()) : -1;
  if (!m || month < 0) return undefined;
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60_000;
  return Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset;
}

/** A new mail in the trigger's folder since `prev` (the first check records what is there). */
export async function checkMail(
  trigger: Extract<ScheduleTrigger, { source: 'mail' }>,
  prev: ScheduleWatch | undefined,
  connectors: ConnectorStore,
  timeoutMs = 30_000,
): Promise<WatchCheck> {
  const found = connectors.mailById(trigger.account);
  if (!found) throw new Error(t().watchNoAccount);
  if (!found.password) throw new Error(t().watchNoPassword(found.account.name));
  const { account, password } = found;
  const c = await ImapClient.open(account.imap, { username: account.username, password }, timeoutMs);
  try {
    const opened = await c.command(`EXAMINE ${quote(trigger.folder)}`).catch((err: Error) => {
      throw new Error(t().watchNoFolder(trigger.folder, err.message));
    });
    const uidValidity = responseCode(opened.untagged, opened.status, 'UIDVALIDITY');
    const uidNext = responseCode(opened.untagged, opened.status, 'UIDNEXT');
    // The first check, or a folder that was rebuilt (its UIDs mean other mails now): only recorded.
    if (!prev || prev.lastUid === undefined || prev.uidValidity !== uidValidity) {
      const lastUid = uidNext !== undefined ? uidNext - 1 : Math.max(0, ...searchUids((await c.command('UID SEARCH UID *')).untagged));
      return { state: { ...(uidValidity !== undefined ? { uidValidity } : {}), lastUid }, total: 0 };
    }
    const since = prev.lastUid;
    const withValidity = (lastUid: number) => ({ state: { ...(uidValidity !== undefined ? { uidValidity } : {}), lastUid }, total: 0 });
    if (uidNext !== undefined && uidNext <= since + 1) return withValidity(since);
    // `n:*` also answers the newest mail when none is above n: only those above it are new.
    const uids = searchUids((await c.command(`UID SEARCH UID ${since + 1}:*`)).untagged)
      .filter((u) => u > since)
      .sort((a, b) => a - b);
    // The new mail went again before it was seen (expunged): its UIDs are never used again.
    if (!uids.length) return withValidity(uidNext !== undefined ? Math.max(since, uidNext - 1) : since);
    const lastUid = uids[uids.length - 1]!;
    const state = { ...(uidValidity !== undefined ? { uidValidity } : {}), lastUid };
    const read = uids.slice(-MAX_HEADERS);
    const heads = await c.command(`UID FETCH ${read.join(',')} (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])`);
    const movedBefore = prev.seenAt !== undefined ? prev.seenAt - MOVED_MS : undefined;
    const matching = heads.untagged
      .map(parseFetch)
      .filter((f) => f.uid !== undefined && f.uid > since)
      .filter((f) => {
        const arrived = internalDate(f.date);
        return movedBefore === undefined || arrived === undefined || arrived >= movedBefore;
      })
      .map((f) => ({ uid: f.uid!, h: parseHeaders(f.data?.toString('latin1') ?? '') }))
      .filter(({ h }) => contains(h.from, trigger.from) && contains(h.subject, trigger.subject))
      .sort((a, b) => a.uid - b.uid);
    if (!matching.length) return { state, total: 0 };
    const listed = matching.slice(-WATCH_LIMITS.items);
    const bodies = await c.command(`UID FETCH ${listed.map((m) => m.uid).join(',')} (UID BODY.PEEK[]<0.65536>)`);
    const texts = new Map(
      bodies.untagged.map(parseFetch).flatMap((f) => (f.uid !== undefined && f.data ? [[f.uid, f.data] as const] : [])),
    );
    const mails: NewMail[] = listed.map(({ uid, h }) => {
      const raw = texts.get(uid)?.toString('latin1');
      return {
        uid,
        from: field(h.from),
        subject: field(h.subject),
        date: field(h.date),
        ...(h['message-id'] ? { messageId: field(h['message-id']) } : {}),
        excerpt: raw ? excerptOf(raw) : '',
      };
    });
    // More came than one check reads the headers of: how many of the older ones were not looked at.
    const unread = uids.length - read.length;
    return { state, total: matching.length, event: mailEvent(account.name, trigger.folder, mails, matching.length, unread) };
  } finally {
    await c.logout();
  }
}

/**
 * The `<event>` block's body for new mail (`fitEvent`): the oldest of the mails listed are left out
 * until it fits. `unread`: new mails older than those whose headers were read, not looked at.
 */
export function mailEvent(account: string, folder: string, mails: NewMail[], total: number, unread = 0): string {
  return fitEvent(mails.length, (n) => ({
    source: 'mail',
    account,
    folder,
    newMail: total,
    ...listedNote(n, total, 'newest'),
    ...(unread > 0 ? { notReadOlder: unread } : {}),
    mails: mails.slice(mails.length - n),
  }));
}

// --- An event about to begin --------------------------------------------------------------------

/** How late an event that began may still be found about to begin, at least: a check that came a little late. */
const LATE_MS = 5 * 60_000;
/** How far back a check looks at most, from the last one that worked (checks failed, or the team was held). */
const LOOK_BACK_MS = 60 * 60_000;
/** How long an event seen is remembered after it began, and how many at most. */
const SEEN_MS = 86_400_000;
const MAX_SEEN = 500;
/** The most attendees of an event listed (whoever sends the invitation writes them), and of one listed short. */
const MAX_ATTENDEES = 20;
const SHORT_ATTENDEES = 5;

/** An event's key among those seen: its UID and the moment it starts (each time of a recurring one apart). */
function eventKey(e: CalendarEvent & { at: number }): string {
  return `${e.uid}@${e.at}`;
}

/** When a seen event's key says it starts. */
function keyStart(key: string): number {
  return Number(key.slice(key.lastIndexOf('@') + 1)) || 0;
}

/** An event about to begin as the run's message lists it. */
export interface StartingEvent {
  title: string;
  start: string;
  startsAt: string;
  /** It began before the check came (a late one): how many minutes before. */
  begun?: true;
  minutesAgo?: number;
  end?: string;
  location?: string;
  description?: string;
  attendees?: string[];
  /** How many more attendees it has than are listed. */
  moreAttendees?: number;
  uid: string;
}

/**
 * The events of the trigger's calendar about to begin (within its minutes) since `prev` (the first
 * check records those there are). All-day events, cancelled ones and those whose start cannot be read
 * (a time zone this computer does not know) are left out. The window starts at the last check that
 * worked (`lookedAt`), at most an hour back and 5 minutes back at least, so an event that began while
 * checks failed, or while the team could not take it, is still listed, as begun.
 */
export async function checkCalendar(
  trigger: Extract<ScheduleTrigger, { source: 'calendar' }>,
  prev: ScheduleWatch | undefined,
  connectors: ConnectorStore,
  oauth: CalendarOAuth | undefined,
  now = Date.now(),
): Promise<WatchCheck> {
  const found = connectors.calendarById(trigger.account);
  if (!found) throw new Error(t().watchNoCalendar);
  if (!found.account.oauth && !found.password) throw new Error(t().watchNoCalendarPassword(found.account.name));
  const from = Math.max(now - LOOK_BACK_MS, Math.min(now - LATE_MS, prev?.lookedAt ?? now));
  const to = now + trigger.minutes * 60_000;
  const events = unique(
    (await calendarBackend(found.account, found.password, oauth).events(from, to, true))
      .filter((e): e is CalendarEvent & { at: number } => e.at !== undefined && e.at >= from && e.at <= to && !e.cancelled)
      .filter((e) => contains(e.summary, trigger.title))
      .sort((a, b) => a.at - b.at),
    eventKey,
  );
  const keys = events.map(eventKey);
  // The first check: those about to begin now are recorded, so that only the next ones start it.
  if (!prev?.seen) return { state: { seen: keys.slice(-MAX_SEEN), lookedAt: now }, total: 0 };
  const seen = new Set(prev.seen);
  const fresh = events.filter((e) => !seen.has(eventKey(e)));
  const kept = [...prev.seen.filter((k) => keyStart(k) >= now - SEEN_MS), ...fresh.map(eventKey)].slice(-MAX_SEEN);
  const state = { seen: kept, lookedAt: now };
  if (!fresh.length) return { state, total: 0 };
  // `short`: without its description, and with fewer attendees (one that alone would not fit).
  const listing = (e: CalendarEvent & { at: number }, short: boolean): StartingEvent => {
    const attendees = short ? SHORT_ATTENDEES : MAX_ATTENDEES;
    return {
      title: field(e.summary),
      start: field(e.start),
      startsAt: new Date(e.at).toISOString(),
      ...(e.at < now ? { begun: true as const, minutesAgo: Math.round((now - e.at) / 60_000) } : {}),
      ...(e.end ? { end: field(e.end) } : {}),
      ...(e.location ? { location: field(e.location) } : {}),
      ...(e.description && !short ? { description: excerpt(e.description) } : {}),
      ...(e.attendees.length ? { attendees: e.attendees.slice(0, attendees).map(field) } : {}),
      ...(e.attendees.length > attendees ? { moreAttendees: e.attendees.length - attendees } : {}),
      uid: field(e.uid),
    };
  };
  const first = fresh.slice(0, WATCH_LIMITS.items);
  return {
    state,
    total: fresh.length,
    event: fitEvent(first.length, (n, short) => ({
      source: 'calendar',
      calendar: found.account.name,
      minutesBefore: trigger.minutes,
      startingEvents: fresh.length,
      ...listedNote(n, fresh.length, 'first'),
      events: first.slice(0, n).map((e) => listing(e, short)),
    })),
  };
}

// --- A pull request opened, a CI run that failed (GitHub, through gh) -----------------------------

/** Runs `gh` with these arguments (the user's own, as sharing runs it; a stand-in in tests). */
export type GhRunner = (args: string[]) => Promise<SpawnResult>;

/** gh as the server runs it for sharing: on the PATH or where Homebrew puts it, in its environment. */
export const runGh: GhRunner = (args) => runProcess({ bin: ghBin(), args, env: ghEnv(), timeoutMs: 60_000, maxCapture: 4_000_000 });

/** How many of the newest pull requests, and runs, a check asks for: more than enough between two checks. */
const PR_LIMIT = 50;
const RUN_LIMIT = 100;
/** The most failed runs kept as seen (those still among the newest runs). */
const MAX_RUN_KEYS = 300;
/** What a run that failed ended as: failed, timed out, or could not start. */
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

interface GhPull {
  number: number;
  title?: string;
  url?: string;
  createdAt?: string;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  author?: { login?: string };
}

interface GhRun {
  databaseId: number;
  attempt?: number;
  status?: string;
  conclusion?: string;
  displayTitle?: string;
  workflowName?: string;
  headBranch?: string;
  event?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Runs gh and reads its JSON, saying what went wrong in words the user can act on. */
async function ghJson<T>(gh: GhRunner, args: string[], repo: string): Promise<T[]> {
  let r: SpawnResult;
  try {
    r = await gh(args);
  } catch (err) {
    if (err instanceof CommandNotFoundError) throw new Error(t().watchNoGh);
    throw err;
  }
  if (r.timedOut) throw new Error(t().watchGhTimedOut(repo));
  if (r.code !== 0) {
    if (signedOut(r.stderr)) throw new Error(t().watchGhSignedOut);
    throw new Error(t().watchGhFailed(repo, tail(r.stderr.trim() || r.stdout.trim(), 300) || `exit ${r.code}`));
  }
  try {
    const v = JSON.parse(r.stdout) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    throw new Error(t().watchGhNoJson(repo));
  }
}

/** A failed run's key among those seen: its id and which attempt (a run started again fails anew). */
function runKey(r: GhRun): string {
  return `${r.databaseId}:${Number.isInteger(r.attempt) && r.attempt! > 0 ? r.attempt : 1}`;
}

/**
 * A pull request opened, or a CI run that failed, in the trigger's repository since `prev` (the first
 * check records what is there).
 */
export async function checkGithub(
  trigger: Extract<ScheduleTrigger, { source: 'github' }>,
  prev: ScheduleWatch | undefined,
  gh: GhRunner = runGh,
): Promise<WatchCheck> {
  const { repo } = trigger;
  if (trigger.on === 'pr') {
    // Every state: a pull request opened and merged between two checks still counts.
    const pulls = await ghJson<GhPull>(
      gh,
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'all',
        '--limit',
        String(PR_LIMIT),
        '--json',
        'number,title,url,createdAt,headRefName,baseRefName,isDraft,author',
      ],
      repo,
    );
    const numbered = pulls.filter((p) => Number.isInteger(p.number));
    const newest = Math.max(prev?.lastId ?? 0, ...numbered.map((p) => p.number));
    if (prev?.lastId === undefined) return { state: { lastId: newest }, total: 0 };
    const fresh = numbered.filter((p) => p.number > prev.lastId!).sort((a, b) => a.number - b.number);
    if (!fresh.length) return { state: { lastId: newest }, total: 0 };
    // Every one of the newest asked for is new: more may have come.
    const atLeast = numbered.length >= PR_LIMIT && fresh.length === numbered.length;
    const listed = fresh.slice(-WATCH_LIMITS.items).map((p) => ({
      number: p.number,
      title: field(p.title),
      ...(p.author?.login ? { author: field(p.author.login) } : {}),
      ...(p.headRefName ? { branch: field(p.headRefName) } : {}),
      ...(p.baseRefName ? { into: field(p.baseRefName) } : {}),
      ...(p.isDraft ? { draft: true } : {}),
      ...(p.createdAt ? { createdAt: field(p.createdAt) } : {}),
      ...(p.url ? { url: field(p.url) } : {}),
    }));
    return {
      state: { lastId: newest },
      total: fresh.length,
      event: fitEvent(listed.length, (n) => ({
        source: 'github',
        repo,
        newPullRequests: count(fresh.length, atLeast),
        ...listedNote(n, fresh.length, 'newest'),
        pullRequests: listed.slice(listed.length - n),
      })),
    };
  }
  // Every status: a run's id is given when it starts, so a run that fails after a newer one did, or
  // fails again once started again, is found by the failed runs seen, not by the highest id.
  const runs = await ghJson<GhRun>(
    gh,
    [
      'run',
      'list',
      '--repo',
      repo,
      ...(trigger.branch ? ['--branch', trigger.branch] : []),
      '--limit',
      String(RUN_LIMIT),
      '--json',
      'databaseId,attempt,status,conclusion,displayTitle,workflowName,headBranch,event,url,createdAt,updatedAt',
    ],
    repo,
  );
  const failed = unique(
    runs.filter((r) => Number.isInteger(r.databaseId) && r.status === 'completed' && FAILED.has(r.conclusion ?? '')),
    runKey,
  );
  const listedKeys = failed.map(runKey);
  // Those among the newest runs first; then those seen before that are not (a list that came back
  // short, its runs deleted, must not make them new again), up to `MAX_RUN_KEYS`.
  const keep = (before: string[]) => [...new Set([...listedKeys, ...before])].slice(0, MAX_RUN_KEYS);
  if (!prev?.seen) return { state: { seen: keep([]) }, total: 0 };
  const seen = new Set(prev.seen);
  const state = { seen: keep(prev.seen) };
  const when = (r: GhRun) => r.updatedAt ?? r.createdAt ?? '';
  const fresh = failed
    .filter((r) => !seen.has(runKey(r)))
    .sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : a.databaseId - b.databaseId));
  if (!fresh.length) return { state, total: 0 };
  // Every run asked for began after the last check: older ones that failed since may not be among them.
  const since = prev.checkedAt;
  const atLeast =
    runs.length >= RUN_LIMIT && since !== undefined && runs.every((r) => r.createdAt !== undefined && Date.parse(r.createdAt) >= since);
  const listed = fresh.slice(-WATCH_LIMITS.items).map((r) => ({
    id: r.databaseId,
    ...(Number.isInteger(r.attempt) && r.attempt! > 1 ? { attempt: r.attempt } : {}),
    workflow: field(r.workflowName),
    title: field(r.displayTitle),
    conclusion: r.conclusion,
    ...(r.headBranch ? { branch: field(r.headBranch) } : {}),
    ...(r.event ? { event: field(r.event) } : {}),
    ...(r.createdAt ? { createdAt: field(r.createdAt) } : {}),
    ...(r.url ? { url: field(r.url) } : {}),
  }));
  return {
    state,
    total: fresh.length,
    event: fitEvent(listed.length, (n) => ({
      source: 'github',
      repo,
      failedRuns: count(fresh.length, atLeast),
      ...listedNote(n, fresh.length, 'newest'),
      runs: listed.slice(listed.length - n),
    })),
  };
}

// --- A file appearing or changing in the working directory ---------------------------------------

/**
 * Folders looked in only where the pattern names them: those Harness Relay's own repositories leave
 * out of snapshots (packages, virtual environments, builds). `.git` is never looked in.
 */
const BULKY = new Set(DEFAULT_EXCLUDES.filter((e) => e.endsWith('/')).map((e) => e.slice(0, -1).toLowerCase()));
/** How many entries one check looks through at most, and how deep. */
const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 16;
/** A file that changed less than this before the check may still be being written: listed at a later check. */
export const SETTLE_MS = WATCH_LIMITS.settleSeconds * 1000;

/**
 * A file pattern as a regular expression over a path in the working directory (with `/`): `**` any
 * folders, `*` anything within one, `?` one character; any case.
 */
export function patternRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      // `**/` any folders (also none), a `**` at the end anything below.
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Where a pattern's matches can be: its folders, each as a match of one name (up to the first with
 * `**`, below which anything can be), and the fixed folders it starts with (those before the first with
 * `*` or `?`), where the walk starts.
 */
interface PatternWalk {
  re: RegExp;
  /** The segments before the first with `**`: each a match of one name, and whether it is written out (no `*` or `?`). */
  segments: { re: RegExp; literal: boolean }[];
  /** A segment has `**`: there is no limit on depth below the segments. */
  deep: boolean;
  /** The fixed leading folders, in lower case: the walk goes straight down them. */
  lead: string[];
  /** Every folder name the pattern writes out, in lower case: a bulky one it names is looked in. */
  named: Set<string>;
}

export function patternWalk(pattern: string): PatternWalk {
  const parts = pattern.split('/');
  const deepAt = parts.findIndex((p) => p.includes('**'));
  const segments = (deepAt < 0 ? parts : parts.slice(0, deepAt)).map((p) => ({ re: patternRegex(p), literal: !/[*?]/.test(p) }));
  // Folders only: without `**`, the last segment is the file's own name.
  const folders = deepAt < 0 ? parts.slice(0, -1) : parts.slice(0, deepAt);
  const firstWild = folders.findIndex((p) => /[*?]/.test(p));
  const lead = (firstWild < 0 ? folders : folders.slice(0, firstWild)).map((p) => p.toLowerCase());
  const named = new Set(parts.filter((p) => !/[*?]/.test(p)).map((p) => p.toLowerCase()));
  return { re: patternRegex(pattern), segments, deep: deepAt >= 0, lead, named };
}

/**
 * Whether a folder at `index` below the working directory (0: in it) named `name` can hold a match:
 * no; yes, the pattern names it there; or yes, a wildcard of the pattern takes it.
 */
export function folderMatch(w: PatternWalk, index: number, name: string): 'no' | 'named' | 'wild' {
  if (index < w.segments.length) {
    if (!w.deep && index >= w.segments.length - 1) return 'no';
    const s = w.segments[index]!;
    if (!s.re.test(name)) return 'no';
    return s.literal ? 'named' : 'wild';
  }
  return w.deep ? 'wild' : 'no';
}

/** A file found for a file trigger: its path in the working directory (with `/`), size and time of change. */
interface FoundFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * The files under `root` whose path there matches the pattern; links are not followed, `.git` is never
 * looked in, and a folder that cannot hold a match is left out (`folderMatch()`; the bulky ones too,
 * unless the pattern names them). The walk starts at the pattern's fixed leading folders, whose
 * entries do not count towards `MAX_ENTRIES`.
 */
async function matchingFiles(root: string, pattern: string): Promise<FoundFile[]> {
  const w = patternWalk(pattern);
  const out: FoundFile[] = [];
  let entries = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) throw err;
      return; // a folder that cannot be read (its permissions), or went meanwhile
    }
    // Down a fixed folder: only it (in any case), and nothing else there is a match.
    if (depth < w.lead.length) {
      for (const d of list) {
        if (d.isDirectory() && d.name.toLowerCase() === w.lead[depth] && d.name.toLowerCase() !== '.git')
          await walk(join(dir, d.name), rel ? `${rel}/${d.name}` : d.name, depth + 1);
      }
      return;
    }
    for (const d of list) {
      if (++entries > MAX_ENTRIES) throw new Error(t().watchTooManyEntries(MAX_ENTRIES));
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        const lower = d.name.toLowerCase();
        if (depth >= MAX_DEPTH || lower === '.git') continue;
        const m = folderMatch(w, depth, d.name);
        if (m === 'no' || (m === 'wild' && BULKY.has(lower) && !w.named.has(lower))) continue;
        await walk(join(dir, d.name), path, depth + 1);
      } else if (d.isFile() && w.re.test(path)) {
        try {
          const st = await lstat(join(dir, d.name));
          out.push({ path, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } catch {
          // gone meanwhile
        }
        if (out.length > WATCH_LIMITS.files) throw new Error(t().watchTooManyFiles(WATCH_LIMITS.files));
      }
    }
  };
  await walk(root, '', 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A path with `/` between its folders, as the `<event>` block writes the working directory (`\` on Windows). */
export function slashed(path: string, separator: string = sep): string {
  return path.split(separator).join('/');
}

/**
 * Files matching the trigger's pattern that appeared or changed in the working directory since `prev`.
 * The first check, and the first in another working directory (`filesIn`), records them; so does a
 * check that only records (`recordOnly`: the team writes there). A file that changed less than
 * `SETTLE_MS` before the check may still be being written: it is not listed yet, and what was kept of
 * it is kept, so the next check finds it.
 */
export async function checkFiles(
  trigger: Extract<ScheduleTrigger, { source: 'file' }>,
  prev: ScheduleWatch | undefined,
  cwd: string,
  now = Date.now(),
  recordOnly = false,
  held?: Record<string, string>,
): Promise<WatchCheck> {
  const files = await matchingFiles(cwd, trigger.pattern).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new Error(t().watchNoCwd(cwd));
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new Error(t().watchCwdNoAccess(cwd));
    if (err.code) throw new Error(t().watchCwdUnreadable(cwd, err.code));
    throw err;
  });
  const current = Object.fromEntries(files.map((f) => [f.path, `${f.mtimeMs}:${f.size}`]));
  if (!prev?.files || prev.filesIn !== cwd) return { state: { files: current, filesIn: cwd }, total: 0 };
  if (recordOnly) {
    // The team's own: recorded, whatever their times say (a file it moves, renames, extracts or copies
    // keeps an old one). One held for the team and still as it was then is kept unseen, so the next
    // check with the folder free lists it.
    const kept: Record<string, string> = {};
    for (const f of files) {
      const was = prev.files[f.path];
      if (held?.[f.path] === current[f.path] && was !== current[f.path]) {
        if (was !== undefined) kept[f.path] = was;
      } else kept[f.path] = current[f.path]!;
    }
    return { state: { files: kept, filesIn: cwd }, total: 0 };
  }
  const before = prev.files;
  // A time well ahead of this computer's clock (a NAS ahead of it, a zip's other time zone) would never
  // settle by the clock: settled once it is the same at two checks in a row (`pending` keeps it between them).
  const ahead = (f: FoundFile) => f.mtimeMs > now + 60_000;
  const settled = (f: FoundFile) => f.mtimeMs <= now - SETTLE_MS || (ahead(f) && prev.heldFiles?.[f.path] === current[f.path]);
  const state: Record<string, string> = {};
  for (const f of files) {
    const was = before[f.path];
    if (settled(f) || was === current[f.path]) state[f.path] = current[f.path]!;
    else if (was !== undefined) state[f.path] = was;
  }
  const changed = files.filter((f) => settled(f) && before[f.path] !== current[f.path]);
  /** The changed files still settling: kept like held ones, so a run starting before the next check does not take them. */
  const pendingOf = () => {
    const p = Object.fromEntries(
      files.filter((f) => !settled(f) && before[f.path] !== current[f.path]).map((f) => [f.path, current[f.path]!]),
    );
    return Object.keys(p).length ? { pending: p } : {};
  };
  if (!changed.length) return { state: { files: state, filesIn: cwd }, total: 0, ...pendingOf() };
  // The newest changes first, when more came than are listed.
  const listed = [...changed]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, WATCH_LIMITS.items)
    .map((f) => ({
      path: cut(f.path),
      change: before[f.path] === undefined ? 'new' : 'changed',
      size: f.size,
      modified: new Date(f.mtimeMs).toISOString(),
    }));
  return {
    state: { files: state, filesIn: cwd },
    total: changed.length,
    found: Object.fromEntries(changed.map((f) => [f.path, current[f.path]!])),
    ...pendingOf(),
    event: fitEvent(listed.length, (n) => ({
      source: 'file',
      workingDirectory: slashed(cwd),
      pattern: trigger.pattern,
      changedFiles: changed.length,
      ...listedNote(n, changed.length, 'newest'),
      files: listed.slice(0, n),
    })),
  };
}

/** Checks a trigger's source with the accounts in Settings (and gh, and the working directory). */
export function checkTrigger(connectors: ConnectorStore, oauth?: CalendarOAuth, gh: GhRunner = runGh): TriggerChecker {
  return (trigger, prev, ctx) => {
    switch (trigger.source) {
      case 'mail':
        return checkMail(trigger, prev, connectors);
      case 'calendar':
        return checkCalendar(trigger, prev, connectors, oauth, ctx.now);
      case 'github':
        return checkGithub(trigger, prev, gh);
      case 'file':
        return checkFiles(trigger, prev, ctx.cwd, ctx.now, ctx.recordOnly, ctx.held);
    }
  };
}
