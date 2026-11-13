import type { ServerEvent } from '../shared/types';

type Listener = (e: ServerEvent) => void;

/** Fan-out of conversation events to connected SSE clients (and to listeners of every conversation). */
export class Hub {
  private listeners = new Map<string, Set<Listener>>();
  private everywhere = new Set<(conversationId: string, e: ServerEvent) => void>();

  subscribe(conversationId: string, fn: Listener): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) this.listeners.set(conversationId, (set = new Set()));
    set.add(fn);
    let subscribed = true;
    // Idempotent, and never removes a newer set: an SSE connection unsubscribes twice (on abort and
    // when its loop ends), possibly after the browser has reconnected and subscribed again.
    return () => {
      if (!subscribed) return;
      subscribed = false;
      set!.delete(fn);
      if (set!.size === 0 && this.listeners.get(conversationId) === set) this.listeners.delete(conversationId);
    };
  }

  /** Every conversation's events (the push notifications' watcher hears that something changed). */
  subscribeAll(fn: (conversationId: string, e: ServerEvent) => void): () => void {
    this.everywhere.add(fn);
    return () => void this.everywhere.delete(fn);
  }

  emit(conversationId: string, e: ServerEvent): void {
    for (const fn of this.listeners.get(conversationId) ?? []) {
      try {
        fn(e);
      } catch (err) {
        console.error('[hub] listener failed:', err);
      }
    }
    for (const fn of this.everywhere) {
      try {
        fn(conversationId, e);
      } catch (err) {
        console.error('[hub] listener failed:', err);
      }
    }
  }
}
