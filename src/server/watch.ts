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
 * of a recurring one on its own), each fired once, by its UID and start (`seen`).
 *
 * A pull request opened, or a CI run that failed, through the user's own `gh` (as sharing runs it): the
 * highest number (or run id) seen is kept, and those above it are new.
 *
 * A file appearing or changing in the working directory: each matching file's size and time of change
 * are kept, and a file that is new or whose size or time changed is listed (its contents never are).
 */

/** What a check found: what to keep of the source now, and what is new since the last one (none the first time). */
export interface WatchCheck {
  state: WatchState;
  /** How many new items match, in all. */
  total: number;
  /** The `<event>` block's body for the run, when something new matches (JSON, as a webhook's body is). */
  event?: string;
}

/** What a check needs to know of the automation's conversation: its working directory (the file source). */
export interface WatchContext {
  cwd: string;
}

/** Checks a trigger's source (`checkTrigger`, or a stand-in in tests). */
export type TriggerChecker = (trigger: ScheduleTrigger, prev: ScheduleWatch | undefined, ctx: WatchContext) => Promise<WatchCheck>;

/**
 * For which source a watch's state was recorded: another one (account and folder, calendar, repository
 * and what to watch there, pattern) starts afresh. Changing a trigger's conditions (sender, subject,
 * title, minutes, branch) keeps its place: what comes next is matched against the new ones.
 */
export function triggerKey(trigger: ScheduleTrigger): string {
  switch (trigger.source) {
    case 'mail':
      return JSON.stringify([trigger.source, trigger.account, trigger.folder]);
    case 'calendar':
      return JSON.stringify([trigger.source, trigger.account]);
    case 'github':
      return JSON.stringify([trigger.source, trigger.repo.toLowerCase(), trigger.on]);
    case 'file':
      return JSON.stringify([trigger.source, trigger.pattern]);
  }
}

/** When the next check is, after `failures` failed checks in a row (0: the last one worked). */
export function nextCheckAt(now: number, failures = 0): number {
  const steps = WATCH_LIMITS.backoffMinutes;
  const minutes = failures > 0 ? steps[Math.min(failures, steps.length) - 1]! : WATCH_LIMITS.checkMinutes;
  return now + minutes * 60_000;
}

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

/** Whether a header contains the words a condition gives (any case); no condition matches everything. */
function contains(value: string | undefined, wanted: string | undefined): boolean {
  if (!wanted?.trim()) return true;
  return (value ?? '').toLowerCase().includes(wanted.trim().toLowerCase());
}

/** Text on one line, cut at `WATCH_LIMITS.excerptChars`. */
function excerpt(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > WATCH_LIMITS.excerptChars ? `${line.slice(0, WATCH_LIMITS.excerptChars)}…` : line;
}

/** The start of a mail's text, on one line. */
function excerptOf(raw: string): string {
  return excerpt(readMail(raw).text);
}

/**
 * An `<event>` block's body: JSON, as a webhook's body is, with `<` written as `\u003c` (the same
 * data), so that nothing from the source can close the block it goes in.
 */
function eventBody(body: unknown): string {
  return JSON.stringify(body, null, 2).replace(/</g, '\\u003c');
}

/** The most UIDs whose senders and subjects one check reads: the newest, when more came at once. */
const MAX_HEADERS = 200;
/** The most characters of a sender, subject, date or Message-ID listed: the sender writes them. */
const MAX_HEADER_CHARS = 300;
/**
 * How much older than the last time mail was recorded as seen (`seenAt`, not the last check: held or
 * failing checks do not record) a new UID's mail may have arrived (its INTERNALDATE) and still count
 * as new: old mail moved into the folder (from an archive, say) gets new UIDs, but keeps when it
 * arrived; a day covers clocks that disagree, and mail a server takes in late.
 */
const MOVED_MS = 86_400_000;

/** A header as listed: on one line, cut at `MAX_HEADER_CHARS`. */
function header(v: string | undefined): string {
  const line = (v ?? '').replace(/\s+/g, ' ').trim();
  return line.length > MAX_HEADER_CHARS ? `${line.slice(0, MAX_HEADER_CHARS)}…` : line;
}

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
        from: header(h.from),
        subject: header(h.subject),
        date: header(h.date),
        ...(h['message-id'] ? { messageId: header(h['message-id']) } : {}),
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
 * The `<event>` block's body for new mail (`eventBody`), within a webhook body's size
 * (`TRACKING_LIMITS.eventBytes`): the oldest of the mails listed are left out until it fits.
 * `unread`: new mails older than those whose headers were read, not looked at.
 */
export function mailEvent(account: string, folder: string, mails: NewMail[], total: number, unread = 0): string {
  const body = (listed: NewMail[]) =>
    eventBody({
      source: 'mail',
      account,
      folder,
      newMail: total,
      ...(total > listed.length ? { listed: `the newest ${listed.length}` } : {}),
      ...(unread > 0 ? { notReadOlder: unread } : {}),
      mails: listed,
    });
  let listed = mails;
  let text = body(listed);
  while (listed.length > 1 && Buffer.byteLength(text) > TRACKING_LIMITS.eventBytes) {
    listed = listed.slice(1);
    text = body(listed);
  }
  return text;
}

// --- An event about to begin --------------------------------------------------------------------

/** How late an event that began may still be found about to begin: a check that came late (slower after errors). */
const LATE_MS = 5 * 60_000;
/** How long an event seen is remembered after it began, and how many at most. */
const SEEN_MS = 86_400_000;
const MAX_SEEN = 500;

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
  end?: string;
  location?: string;
  description?: string;
  attendees?: string[];
  uid: string;
}

/**
 * The events of the trigger's calendar about to begin (within its minutes, or begun at most a few
 * minutes ago) since `prev` (the first check records those there are). All-day events are left out.
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
  const to = now + trigger.minutes * 60_000;
  const events = (await calendarBackend(found.account, found.password, oauth).events(now - LATE_MS, to, true))
    .filter((e): e is CalendarEvent & { at: number } => e.at !== undefined && e.at >= now - LATE_MS && e.at <= to)
    .filter((e) => contains(e.summary, trigger.title))
    .sort((a, b) => a.at - b.at);
  const keys = events.map(eventKey);
  // The first check: those about to begin now are recorded, so that only the next ones start it.
  if (!prev?.seen) return { state: { seen: keys.slice(-MAX_SEEN) }, total: 0 };
  const seen = new Set(prev.seen);
  const fresh = events.filter((e) => !seen.has(eventKey(e)));
  const kept = [...prev.seen.filter((k) => keyStart(k) >= now - SEEN_MS), ...fresh.map(eventKey)].slice(-MAX_SEEN);
  if (!fresh.length) return { state: { seen: kept }, total: 0 };
  const listed: StartingEvent[] = fresh.slice(0, WATCH_LIMITS.items).map((e) => ({
    title: e.summary,
    start: e.start,
    startsAt: new Date(e.at).toISOString(),
    ...(e.end ? { end: e.end } : {}),
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: excerpt(e.description) } : {}),
    ...(e.attendees.length ? { attendees: e.attendees.slice(0, 50) } : {}),
    uid: e.uid,
  }));
  return {
    state: { seen: kept },
    total: fresh.length,
    event: eventBody({
      source: 'calendar',
      calendar: found.account.name,
      minutesBefore: trigger.minutes,
      startingEvents: fresh.length,
      ...(fresh.length > listed.length ? { listed: `the first ${listed.length}` } : {}),
      events: listed,
    }),
  };
}

// --- A pull request opened, a CI run that failed (GitHub, through gh) -----------------------------

/** Runs `gh` with these arguments (the user's own, as sharing runs it; a stand-in in tests). */
export type GhRunner = (args: string[]) => Promise<SpawnResult>;

/** gh as the server runs it for sharing: on the PATH or where Homebrew puts it, in its environment. */
export const runGh: GhRunner = (args) => runProcess({ bin: ghBin(), args, env: ghEnv(), timeoutMs: 60_000, maxCapture: 4_000_000 });

/** How many of the newest pull requests or runs a check asks for: more than enough between two checks. */
const GH_LIMIT = 50;

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
  displayTitle?: string;
  workflowName?: string;
  headBranch?: string;
  event?: string;
  url?: string;
  createdAt?: string;
  conclusion?: string;
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
  if (r.timedOut) throw new Error(t().watchGhFailed(repo, 'timed out'));
  if (r.code !== 0) {
    if (signedOut(r.stderr)) throw new Error(t().watchGhSignedOut);
    throw new Error(t().watchGhFailed(repo, tail(r.stderr.trim() || r.stdout.trim(), 300) || `exit ${r.code}`));
  }
  try {
    const v = JSON.parse(r.stdout) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    throw new Error(t().watchGhFailed(repo, 'gh answered no JSON'));
  }
}

/** A pull request opened, or a CI run that failed, in the trigger's repository since `prev` (the first check records the newest). */
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
        String(GH_LIMIT),
        '--json',
        'number,title,url,createdAt,headRefName,baseRefName,isDraft,author',
      ],
      repo,
    );
    const newest = Math.max(prev?.lastId ?? 0, ...pulls.map((p) => p.number).filter(Number.isInteger));
    if (prev?.lastId === undefined) return { state: { lastId: newest }, total: 0 };
    const fresh = pulls.filter((p) => p.number > prev.lastId!).sort((a, b) => a.number - b.number);
    if (!fresh.length) return { state: { lastId: newest }, total: 0 };
    const listed = fresh.slice(-WATCH_LIMITS.items).map((p) => ({
      number: p.number,
      title: p.title ?? '',
      ...(p.author?.login ? { author: p.author.login } : {}),
      ...(p.headRefName ? { branch: p.headRefName } : {}),
      ...(p.baseRefName ? { into: p.baseRefName } : {}),
      ...(p.isDraft ? { draft: true } : {}),
      ...(p.createdAt ? { createdAt: p.createdAt } : {}),
      ...(p.url ? { url: p.url } : {}),
    }));
    return {
      state: { lastId: newest },
      total: fresh.length,
      event: eventBody({
        source: 'github',
        repo,
        newPullRequests: fresh.length,
        ...(fresh.length > listed.length ? { listed: `the newest ${listed.length}` } : {}),
        pullRequests: listed,
      }),
    };
  }
  const runs = await ghJson<GhRun>(
    gh,
    [
      'run',
      'list',
      '--repo',
      repo,
      '--status',
      'failure',
      ...(trigger.branch ? ['--branch', trigger.branch] : []),
      '--limit',
      String(GH_LIMIT),
      '--json',
      'databaseId,displayTitle,workflowName,headBranch,event,url,createdAt,conclusion',
    ],
    repo,
  );
  const newest = Math.max(prev?.lastId ?? 0, ...runs.map((r) => r.databaseId).filter(Number.isInteger));
  if (prev?.lastId === undefined) return { state: { lastId: newest }, total: 0 };
  const fresh = runs.filter((r) => r.databaseId > prev.lastId!).sort((a, b) => a.databaseId - b.databaseId);
  if (!fresh.length) return { state: { lastId: newest }, total: 0 };
  const listed = fresh.slice(-WATCH_LIMITS.items).map((r) => ({
    id: r.databaseId,
    workflow: r.workflowName ?? '',
    title: r.displayTitle ?? '',
    ...(r.headBranch ? { branch: r.headBranch } : {}),
    ...(r.event ? { event: r.event } : {}),
    ...(r.createdAt ? { createdAt: r.createdAt } : {}),
    ...(r.url ? { url: r.url } : {}),
  }));
  return {
    state: { lastId: newest },
    total: fresh.length,
    event: eventBody({
      source: 'github',
      repo,
      failedRuns: fresh.length,
      ...(fresh.length > listed.length ? { listed: `the newest ${listed.length}` } : {}),
      runs: listed,
    }),
  };
}

// --- A file appearing or changing in the working directory ---------------------------------------

/** Folders never looked in: git's own, and the packages a project installs. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);
/** How many entries one check looks through at most, and how deep. */
const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 16;

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

/** A file found for a file trigger: its path in the working directory (with `/`), size and time of change. */
interface FoundFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** The files under `root` whose path there matches; links are not followed. */
async function matchingFiles(root: string, re: RegExp): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  let entries = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) throw err;
      return; // a folder that cannot be read (its permissions), or went meanwhile
    }
    for (const d of list) {
      if (++entries > MAX_ENTRIES) throw new Error(t().watchTooManyEntries(MAX_ENTRIES));
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(d.name)) await walk(join(dir, d.name), path, depth + 1);
      } else if (d.isFile() && re.test(path)) {
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

/** Files matching the trigger's pattern that appeared or changed in the working directory since `prev` (the first check records them). */
export async function checkFiles(
  trigger: Extract<ScheduleTrigger, { source: 'file' }>,
  prev: ScheduleWatch | undefined,
  cwd: string,
): Promise<WatchCheck> {
  const files = await matchingFiles(cwd, patternRegex(trigger.pattern)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw new Error(t().watchNoCwd(cwd));
    throw err;
  });
  const state = Object.fromEntries(files.map((f) => [f.path, `${f.mtimeMs}:${f.size}`]));
  if (!prev?.files) return { state: { files: state }, total: 0 };
  const before = prev.files;
  const changed = files.filter((f) => before[f.path] !== state[f.path]);
  if (!changed.length) return { state: { files: state }, total: 0 };
  // The newest changes first, when more came than are listed.
  const listed = [...changed]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, WATCH_LIMITS.items)
    .map((f) => ({
      path: f.path,
      change: before[f.path] === undefined ? 'new' : 'changed',
      size: f.size,
      modified: new Date(f.mtimeMs).toISOString(),
    }));
  return {
    state: { files: state },
    total: changed.length,
    event: eventBody({
      source: 'file',
      workingDirectory: cwd.split(sep).join('/'),
      pattern: trigger.pattern,
      changedFiles: changed.length,
      ...(changed.length > listed.length ? { listed: `the newest ${listed.length}` } : {}),
      files: listed,
    }),
  };
}

/** Checks a trigger's source with the accounts in Settings (and gh, and the working directory). */
export function checkTrigger(connectors: ConnectorStore, oauth?: CalendarOAuth, gh: GhRunner = runGh): TriggerChecker {
  return (trigger, prev, ctx) => {
    switch (trigger.source) {
      case 'mail':
        return checkMail(trigger, prev, connectors);
      case 'calendar':
        return checkCalendar(trigger, prev, connectors, oauth);
      case 'github':
        return checkGithub(trigger, prev, gh);
      case 'file':
        return checkFiles(trigger, prev, ctx.cwd);
    }
  };
}
