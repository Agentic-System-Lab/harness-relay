import { WATCH_LIMITS, type ScheduleTrigger, type ScheduleWatch } from '../shared/types';
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
    const same = { state: { ...(uidValidity !== undefined ? { uidValidity } : {}), lastUid: since }, total: 0 };
    if (uidNext !== undefined && uidNext <= since + 1) return same;
    // `n:*` also answers the newest mail when none is above n: only those above it are new.
    const uids = searchUids((await c.command(`UID SEARCH UID ${since + 1}:*`)).untagged)
      .filter((u) => u > since)
      .sort((a, b) => a - b);
    if (!uids.length) return same;
    const lastUid = uids[uids.length - 1]!;
    const state = { ...(uidValidity !== undefined ? { uidValidity } : {}), lastUid };
    const heads = await c.command(
      `UID FETCH ${uids.slice(-MAX_HEADERS).join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])`,
    );
    const matching = heads.untagged
      .map(parseFetch)
      .filter((f) => f.uid !== undefined && f.uid > since)
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
        from: h.from ?? '',
        subject: h.subject ?? '',
        date: h.date ?? '',
        ...(h['message-id'] ? { messageId: h['message-id'] } : {}),
        excerpt: raw ? excerptOf(raw) : '',
      };
    });
    return { state, total: matching.length, event: mailEvent(account.name, trigger.folder, mails, matching.length) };
  } finally {
    await c.logout();
  }
}

/**
 * The `<event>` block's body for new mail: JSON, as a webhook's body is, with `<` written as `<`
 * (the same data), so that nothing in a mail can close the block it goes in.
 */
export function mailEvent(account: string, folder: string, mails: NewMail[], total: number): string {
  const body = {
    source: 'mail',
    account,
    folder,
    newMail: total,
    ...(total > mails.length ? { listed: `the newest ${mails.length}` } : {}),
    mails,
  };
  return JSON.stringify(body, null, 2).replace(/</g, '\\u003c');
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
