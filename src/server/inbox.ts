import { randomUUID } from 'node:crypto';
import { AlertTracker, alertDetail } from '../shared/notify';
import type { AlertKind, Conversation, ConversationSummary, InboxItem } from '../shared/types';
import type { Store } from './store';

/*
 * The notification inbox: what the sidebar's bell lists. Each alert the team gives (a reply done or
 * ended with an error, an approval waiting, a team to confirm, a question for the user, a tracked goal
 * held up: the rule the
 * system notifications and push follow, `AlertTracker` in src/shared/notify.ts) is kept in the
 * database (`notifications`, `Store.addNotification()`), whether or not a browser was open, and shown
 * to every signed-in browser alike. The text of each line is the browser's own (in its language); the
 * server keeps only the kind, the agent and what it said.
 *
 * The recorder reads the conversations' states as the alert watcher does: now and then while agents
 * are at work or a conversation event came (`touch()`), and never otherwise. Its first read is where it
 * starts: nothing before is news.
 */

/** How often the conversations' states are read while something may have changed. */
export const INBOX_CHECK_MS = 1500;

/**
 * What a conversation made since the last read tells (the alert rule takes one it has not seen as no
 * news by its replies): a reply that ended, since it cannot be older than the conversation. Not a
 * branch's (its replies were copied), nor while it runs (the rule follows that run from now on).
 */
export function newConversationNews(
  c: Pick<ConversationSummary, 'running' | 'branchFrom' | 'lastReplyId' | 'lastStatus'>,
): AlertKind | undefined {
  if (c.running || c.branchFrom || !c.lastReplyId) return undefined;
  return c.lastStatus === 'done' || c.lastStatus === 'error' ? c.lastStatus : undefined;
}

export interface InboxDeps {
  /** The conversations as the sidebar gets them. */
  list(): ConversationSummary[];
  /** A conversation, for who replied and what they said. */
  get(id: string): Conversation | undefined;
  store: Pick<Store, 'addNotification'>;
  /**
   * Whether agents are at work (`Orchestrator.busy()`). While none are and no conversation event came
   * (`touch()`), nothing can have changed, and the conversations are not read. Absent: always read.
   */
  busy?: () => boolean;
  now?: () => number;
  /** Makes a notification's id (random ones; fixed ones in tests). */
  newId?: () => string;
}

export class Inbox {
  private tracker = new AlertTracker();
  /** The conversations at the last read; none before the first (its starting point). */
  private known?: Set<string>;
  /** A conversation event came since the last read. */
  private dirty = true;
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: InboxDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  /** Reads the states now (where it starts), then now and then. */
  start(): void {
    if (this.timer) return;
    this.checkSafely();
    this.timer = setInterval(() => this.checkSafely(), INBOX_CHECK_MS);
    this.timer.unref?.();
  }

  /**
   * A check in the background: a failure (the database busy, say) is logged and the next check tries
   * again, rather than taking the server, and every conversation, down with it.
   */
  private checkSafely(): void {
    try {
      this.check();
    } catch (err) {
      console.error('[inbox] could not read the conversations:', err);
    }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Something happened in a conversation (a hub event): the next check reads the states. */
  touch(): void {
    this.dirty = true;
  }

  /** Reads the conversations' states and keeps a notification for each alert since the last read; returns those kept. */
  check(): InboxItem[] {
    if (this.known && !this.dirty && this.deps.busy !== undefined && !this.deps.busy()) return [];
    this.dirty = false;
    const list = this.deps.list();
    const news = this.tracker.next(list);
    // A conversation made and answered between two reads (a quick reply in a new chat).
    if (this.known) {
      for (const conv of list) {
        if (this.known.has(conv.id) || news.some((n) => n.conv.id === conv.id)) continue;
        const kind = newConversationNews(conv);
        if (kind) news.push({ conv, kind });
      }
    }
    this.known = new Set(list.map((c) => c.id));
    const kept: InboxItem[] = [];
    for (const { conv, kind } of news) {
      const full = this.deps.get(conv.id);
      const detail = full ? alertDetail(full, kind) : {};
      const item = this.deps.store.addNotification({ id: this.newId(), conversationId: conv.id, kind, ...detail, createdAt: this.now() });
      if (item) kept.push(item);
    }
    return kept;
  }
}
