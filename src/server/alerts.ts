import { AlertTracker, NEEDS_KINDS, alertDetail, alertTag, alertUrl, needsOf, wanted } from '../shared/notify';
import type { AlertKind, AlertPayload, Conversation, ConversationSummary } from '../shared/types';
import { t, withLang } from './i18n';
import { pushTopic, type PushService, type PushSubscriptionRecord } from './push';

/*
 * Push notifications when agents finish or need the user (`push.ts` sends them). The watcher checks
 * the conversations' states now and then, as the sidebar does, while some browser has subscribed and
 * something may have changed, and tells each subscribed browser what changed (`AlertTracker`, the rule
 * the page follows too).
 *
 * A browser with a Harness Relay page in front (the page's polls say it is visible) is told by that
 * page, with its sound, so it gets no push then: one would show the same news twice, and Safari takes
 * a subscription away whose pushes show nothing. Its alerts are held instead: a poll after them, from a
 * page that was in front before them, says it had them, and they are dropped; that page going to the
 * background (`seen(…, false)`), or no poll within `PRESENT_MS`, sends them after all. Each page (tab,
 * home-screen app) counts on its own, so one tab going to the background leaves another in front.
 */

/** How often the conversations' states are checked while some browser has subscribed. */
export const CHECK_MS = 1500;

/**
 * How long a page that said it was visible counts as in front: it asks for the conversations every
 * 3 seconds while it is, so two of its polls missed means it is not (frozen in the background, say).
 */
export const PRESENT_MS = 7000;

/** How long a push service keeps a notification for a browser that is offline. */
const TTL_S: Record<'needs' | 'done', number> = { needs: 24 * 60 * 60, done: 6 * 60 * 60 };

/** A page's id as it sends it (`?page=`): made up by the page; anything else counts as none. */
export const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface AlertWatcherDeps {
  /** The conversations as the sidebar gets them. */
  list(): ConversationSummary[];
  /** A conversation, for who replied and what they said. */
  get(id: string): Conversation | undefined;
  push: PushService;
  /**
   * Whether agents are at work (`Orchestrator.busy()`). While none are and no conversation event came
   * (`touch()`), nothing can have changed, and the conversations are not read. Absent: always read.
   */
  busy?: () => boolean;
  now?: () => number;
}

/** The key of a browser's session (none without sign-in). */
const sessionKey = (session: string | undefined) => session ?? '';

interface Held {
  sub: PushSubscriptionRecord;
  payload: AlertPayload;
  kind: AlertKind;
  convId: string;
  at: number;
}

/** A page in front: since when (this time), and its latest poll. */
interface Present {
  since: number;
  at: number;
}

/** The text of a notification about `conv`, in the subscriber's language. */
export function alertPayload(conv: Pick<ConversationSummary, 'id' | 'title'>, kind: AlertKind, full: Conversation | undefined, sub: Pick<PushSubscriptionRecord, 'lang' | 'prefs'>): AlertPayload {
  return withLang(sub.lang, () => {
    const detail = full ? alertDetail(full, kind) : {};
    const line = t().alert[kind](detail.agent);
    return {
      title: conv.title.slice(0, 120) || 'Harness Relay',
      body: detail.text ? `${line}\n${detail.text}` : line,
      tag: alertTag(conv.id),
      url: alertUrl(conv.id),
      silent: !sub.prefs.sound,
      kind,
    };
  });
}

export class AlertWatcher {
  private tracker = new AlertTracker();
  /** Taken from the states anew at the next check: no browser had subscribed. */
  private idle = true;
  /** A conversation event came since the last read. */
  private dirty = true;
  /** Each browser's pages in front, by page id. */
  private present = new Map<string, Map<string, Present>>();
  private held: Held[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(private readonly deps: AlertWatcherDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.check(), CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Something happened in a conversation (a hub event): the next check reads the states. */
  touch(): void {
    this.dirty = true;
  }

  /**
   * A browser's page said whether it is in front (`page`: its own id; its poll of the conversations,
   * or going to the background). In front, what was held for its browser since that page was is
   * dropped: the page had it. Gone to the background, what was held is sent now, unless another page
   * of the browser is still in front.
   */
  seen(session: string | undefined, page: string | undefined, visible: boolean): void {
    const key = sessionKey(session);
    const id = page && PAGE_ID_RE.test(page) ? page : '';
    const now = this.now();
    const pages = this.pagesOf(key);
    if (visible) {
      const since = pages.get(id)?.since ?? now;
      pages.set(id, { since, at: now });
      this.held = this.held.filter((h) => sessionKey(h.sub.sessionId) !== key || h.at < since);
      return;
    }
    pages.delete(id);
    void this.flush();
  }

  private pagesOf(key: string): Map<string, Present> {
    let pages = this.present.get(key);
    if (!pages) this.present.set(key, (pages = new Map()));
    return pages;
  }

  /** Whether a page of the browser is in front (pages that stopped polling are forgotten). */
  private inFront(session: string | undefined): boolean {
    const pages = this.present.get(sessionKey(session));
    if (!pages) return false;
    const now = this.now();
    for (const [id, p] of pages) if (now - p.at >= PRESENT_MS) pages.delete(id);
    return pages.size > 0;
  }

  /** Checks the conversations and tells each subscribed browser what changed; returns when it was sent. */
  async check(): Promise<void> {
    if (!this.deps.push.hasSubscriptions()) {
      // Taken again from the states then, once a browser subscribes: nothing before is news.
      this.tracker.reset();
      this.idle = true;
      this.held = [];
      return;
    }
    const quiet = !this.idle && !this.dirty && this.deps.busy !== undefined && !this.deps.busy();
    const sends: Promise<unknown>[] = [];
    if (!quiet) {
      this.dirty = false;
      this.idle = false;
      const list = this.deps.list();
      const alerts = this.tracker.next(list);
      const subs = alerts.length ? this.deps.push.subscriptions() : [];
      for (const { conv, kind } of alerts) {
        const full = this.deps.get(conv.id);
        for (const sub of subs) {
          if (!wanted(kind, sub.prefs)) continue;
          const held: Held = { sub, payload: alertPayload(conv, kind, full, sub), kind, convId: conv.id, at: this.now() };
          if (this.inFront(sub.sessionId)) this.held.push(held);
          else sends.push(this.send(held));
        }
      }
    }
    // Sent without holding up the next check: a push service that is slow to answer delays nothing else.
    await Promise.all([...sends, this.flush()]);
  }

  /** Sends what was held for browsers whose pages are no longer in front. */
  private async flush(): Promise<void> {
    const due = this.held.filter((h) => !this.inFront(h.sub.sessionId));
    if (!due.length) return;
    this.held = this.held.filter((h) => !due.includes(h));
    // What still matters: a conversation that needed the user and no longer does is no news now.
    const states = new Map(this.deps.list().map((c) => [c.id, c]));
    await Promise.all(
      due.filter((h) => !isNeeds(h.kind) || needsOf(states.get(h.convId) ?? { running: false }) === h.kind).map((h) => this.send(h)),
    );
  }

  private send(h: Held): Promise<unknown> {
    const needs = isNeeds(h.kind);
    return this.deps.push.push(h.sub, h.payload, {
      urgency: needs ? 'high' : 'normal',
      ttl: TTL_S[needs ? 'needs' : 'done'],
      topic: pushTopic(h.convId),
    });
  }
}

const isNeeds = (kind: AlertKind) => NEEDS_KINDS.includes(kind);

/** A test notification for one browser (Settings → Notifications → Send a test notification). */
export function testPayload(sub: Pick<PushSubscriptionRecord, 'lang' | 'prefs'>): AlertPayload {
  return withLang(sub.lang, () => ({
    title: t().alert.testTitle,
    body: t().alert.testBody,
    tag: 'relay-test',
    url: '/#/settings/notifications',
    silent: !sub.prefs.sound,
    kind: 'test',
  }));
}
