import { TRACKING_LIMITS, WATCH_LIMITS, type ScheduleTrigger, type ScheduleWatch } from '../shared/types';
import type { ConnectorStore } from './connectors/accounts';
import { ImapClient, parseFetch, quote, type ImapResponse } from './connectors/imap';
import { parseHeaders, readMail } from './connectors/mime';
import { t } from './i18n';

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
 */

/** What a check found: what to keep of the source now, and what is new since the last one (none the first time). */
export interface WatchCheck {
  state: Pick<ScheduleWatch, 'uidValidity' | 'lastUid'>;
  /** How many new items match, in all. */
  total: number;
  /** The `<event>` block's body for the run, when something new matches (JSON, as a webhook's body is). */
  event?: string;
}

/** Checks a trigger's source (`checkTrigger`, or a stand-in in tests). */
export type TriggerChecker = (trigger: ScheduleTrigger, prev: ScheduleWatch | undefined) => Promise<WatchCheck>;

/**
 * For which source a watch's state was recorded: another one (account, folder) starts afresh. Changing a
 * trigger's conditions keeps its place: what comes next is matched against the new ones.
 */
export function triggerKey(trigger: ScheduleTrigger): string {
  return JSON.stringify([trigger.source, trigger.account, trigger.folder]);
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

/** The start of a mail's text, on one line. */
function excerptOf(raw: string): string {
  const text = readMail(raw).text.replace(/\s+/g, ' ').trim();
  return text.length > WATCH_LIMITS.excerptChars ? `${text.slice(0, WATCH_LIMITS.excerptChars)}…` : text;
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
 * The `<event>` block's body for new mail: JSON, as a webhook's body is, with `<` written as `\u003c`
 * (the same data), so that nothing in a mail can close the block it goes in. Within a webhook body's
 * size (`TRACKING_LIMITS.eventBytes`): the oldest of the mails listed are left out until it fits.
 * `unread`: new mails older than those whose headers were read, not looked at.
 */
export function mailEvent(account: string, folder: string, mails: NewMail[], total: number, unread = 0): string {
  const body = (listed: NewMail[]) =>
    JSON.stringify(
      {
        source: 'mail',
        account,
        folder,
        newMail: total,
        ...(total > listed.length ? { listed: `the newest ${listed.length}` } : {}),
        ...(unread > 0 ? { notReadOlder: unread } : {}),
        mails: listed,
      },
      null,
      2,
    ).replace(/</g, '\\u003c');
  let listed = mails;
  let text = body(listed);
  while (listed.length > 1 && Buffer.byteLength(text) > TRACKING_LIMITS.eventBytes) {
    listed = listed.slice(1);
    text = body(listed);
  }
  return text;
}

/** Checks a trigger's source with the accounts in Settings. */
export function checkTrigger(connectors: ConnectorStore): TriggerChecker {
  return (trigger, prev) => {
    switch (trigger.source) {
      case 'mail':
        return checkMail(trigger, prev, connectors);
    }
  };
}
