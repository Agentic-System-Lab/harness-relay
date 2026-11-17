import { randomUUID } from 'node:crypto';
import { AlertTracker, alertDetail } from '../shared/notify';
import type { Conversation, ConversationSummary, InboxItem } from '../shared/types';
import type { Store } from './store';

/*
 * The notification inbox: what the sidebar's bell lists. Each alert the team gives (a reply done or
 * ended with an error, an approval waiting, a team to confirm, a question for the user: the rule the
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
  /** It has read the states once (its starting point). */
  private started = false;
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
    this.check();
    this.timer = setInterval(() => this.check(), INBOX_CHECK_MS);
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

  /** Reads the conversations' states and keeps a notification for each alert since the last read; returns those kept. */
  check(): InboxItem[] {
    if (this.started && !this.dirty && this.deps.busy !== undefined && !this.deps.busy()) return [];
    this.dirty = false;
    this.started = true;
    const kept: InboxItem[] = [];
    for (const { conv, kind } of this.tracker.next(this.deps.list())) {
      const full = this.deps.get(conv.id);
      const detail = full ? alertDetail(full, kind) : {};
      const item = this.deps.store.addNotification({ id: this.newId(), conversationId: conv.id, kind, ...detail, createdAt: this.now() });
      if (item) kept.push(item);
    }
    return kept;
  }
}
