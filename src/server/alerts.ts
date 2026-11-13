import { NEEDS_KINDS, alertDetail, alertTag, alertUrl, alertsBetween, needsOf, wanted, type AlertState } from '../shared/notify';
import type { AlertKind, AlertPayload, Conversation, ConversationSummary } from '../shared/types';
import { t, withLang } from './i18n';
import { pushTopic, type PushService, type PushSubscriptionRecord } from './push';

/*
 * Push notifications when agents finish or need the user (`push.ts` sends them). The watcher checks
 * the conversations' states now and then, as the sidebar does, while some browser has subscribed, and
 * tells each subscribed browser what changed (`alertsBetween`, the rule the page follows too).
 *
 * A browser with a Harness Relay page in front (the page's polls say it is visible) is told by that
 * page, with its sound, so it gets no push then: one would show the same news twice, and Safari takes
 * a subscription away whose pushes show nothing. Its alerts are held instead: a poll of the page after
 * them says it had them, and they are dropped; the page going to the background (`seen(…, false)`),
 * or no poll within `PRESENT_MS`, sends them after all.
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

export interface AlertWatcherDeps {
  /** The conversations as the sidebar gets them. */
  list(): ConversationSummary[];
  /** A conversation, for who replied and what they said. */
  get(id: string): Conversation | undefined;
  push: PushService;
  now?: () => number;
}

/** The key of a browser's session in `present` (none without sign-in). */
const sessionKey = (session: string | undefined) => session ?? '';

interface Held {
  sub: PushSubscriptionRecord;
  payload: AlertPayload;
  kind: AlertKind;
  convId: string;
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
  /** Each conversation's state at the last check; undefined until a check with a subscription took it. */
  private last?: Map<string, AlertState>;
  /** When each browser's page last said it was visible. */
  private present = new Map<string, number>();
  private held: Held[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
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

  /**
   * A browser's page said whether it is visible (its poll of the conversations, or going to the
   * background): visible, it had the news held for its browser; hidden, that news is sent now.
   */
  seen(session: string | undefined, visible: boolean): void {
    const key = sessionKey(session);
    const now = this.now();
    if (visible) {
      this.present.set(key, now);
      this.held = this.held.filter((h) => sessionKey(h.sub.sessionId) !== key || h.at > now);
      return;
    }
    this.present.delete(key);
    void this.flush();
  }

  private inFront(session: string | undefined): boolean {
    const at = this.present.get(sessionKey(session));
    return at !== undefined && this.now() - at < PRESENT_MS;
  }

  /** Checks the conversations and tells each subscribed browser what changed; returns when it was sent. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.checkOnce();
    } finally {
      this.checking = false;
    }
  }

  private async checkOnce(): Promise<void> {
    if (!this.deps.push.hasSubscriptions()) {
      // Taken again from the states then, once a browser subscribes: nothing before is news.
      this.last = undefined;
      this.held = [];
      return;
    }
    const list = this.deps.list();
    const before = this.last;
    this.last = new Map(list.map((c) => [c.id, c]));
    if (before) {
      const alerts = alertsBetween(before, list);
      const subs = alerts.length ? this.deps.push.subscriptions() : [];
      const sends: Promise<unknown>[] = [];
      for (const { conv, kind } of alerts) {
        const full = this.deps.get(conv.id);
        for (const sub of subs) {
          if (!wanted(kind, sub.prefs)) continue;
          const held: Held = { sub, payload: alertPayload(conv, kind, full, sub), kind, convId: conv.id, at: this.now() };
          if (this.inFront(sub.sessionId)) this.held.push(held);
          else sends.push(this.send(held));
        }
      }
      await Promise.all(sends);
    }
    await this.flush();
  }

  /** Sends what was held for browsers whose page is no longer in front. */
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
