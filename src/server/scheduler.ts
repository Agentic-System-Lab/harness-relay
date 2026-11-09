import type { Conversation, ConversationSchedule, ScheduleResult } from '../shared/types';
import { nextRun } from '../shared/schedule';
import { HttpError } from './errors';
import { t, withLang } from './i18n';
import type { Orchestrator } from './orchestrator';
import type { Store } from './store';

/** A time missed by more than this (Harness Relay was not running, the computer slept) counts as missed. */
export const MISSED_AFTER_MS = 10 * 60_000;

/**
 * How long a time the conversation cannot take yet (`busy`) is tried again, from the first try: long
 * enough for another conversation's run in the same folder to end.
 */
export const BUSY_RETRY_MS = 30 * 60_000;

/** How often due schedules are looked for. */
const TICK_MS = 15_000;

/** The time a schedule came due, as its notes in the chat write it. */
export function scheduleTime(at: number, s: Pick<ConversationSchedule, 'lang' | 'timeZone'>): string {
  try {
    return new Intl.DateTimeFormat(s.lang, {
      timeZone: s.timeZone,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
  } catch {
    return new Date(at).toISOString();
  }
}

/**
 * Sends each conversation's scheduled message when it comes due (`Orchestrator.sendScheduled`), then
 * works out the next time. A time missed by more than `MISSED_AFTER_MS` is skipped or sent late, as
 * the schedule says; either way only once, however many times were missed. When the conversation
 * cannot take it right now (`busy`), it is tried again at each look for up to `BUSY_RETRY_MS` from the
 * first try, then skipped. What happened is kept with the schedule (`lastResult`), and a time that was
 * not sent leaves a note in the chat.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  /** Stopped (the server is shutting down): what is being sent now is not recorded. */
  private stopped = false;
  /** Conversations whose due time was found busy: that time, and when it was first tried. Retried, not missed. */
  private retrying = new Map<string, { due: number; since: number }>();

  constructor(
    private store: Store,
    private orchestrator: Orchestrator,
    private now: () => number = Date.now,
  ) {}

  /** Look for due schedules now and every `TICK_MS` (also right after the computer wakes up). */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Send the schedules that are due, the most overdue first; one look at a time. */
  tick(): Promise<void> {
    this.ticking ??= (async () => {
      const now = this.now();
      for (const id of this.store.dueSchedules(now)) {
        try {
          await this.fire(id, now);
        } catch (err) {
          // Deleted meanwhile: its schedule went with it.
          if (!(err instanceof HttpError && err.status === 404)) console.error('[scheduler] could not send a scheduled message:', err);
        }
      }
    })().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async fire(convId: string, now: number): Promise<void> {
    if (this.stopped) return;
    const conv = this.store.get(convId);
    if (!conv) return;
    const s = conv.schedule;
    // A row that cannot be read would stay due forever: drop it.
    if (!s) return this.store.saveSchedule(conv);
    if (!s.enabled || s.nextRunAt === undefined || s.nextRunAt > now) return;
    const due = s.nextRunAt;
    const late = now - due > MISSED_AFTER_MS;
    const retry = this.retrying.get(convId);
    const since = retry?.due === due ? retry.since : undefined;
    // Notes and the run's system messages are written in the language the schedule was saved in.
    await withLang(s.lang, async () => {
      let outcome: { result: ScheduleResult; reason?: string };
      if (late && since === undefined && s.missed === 'skip') {
        outcome = { result: 'missed' };
      } else {
        const sent = await this.orchestrator.sendScheduled(convId);
        if (this.stopped) return; // shutting down: the time is still due when the server is back
        if (sent.result === 'busy') {
          // Tried again at the next look; after a while, given up.
          if (now - (since ?? now) < BUSY_RETRY_MS) {
            this.retrying.set(convId, { due, since: since ?? now });
            return;
          }
          outcome = { result: 'skipped', reason: sent.reason ?? t().scheduleBusy };
        } else {
          outcome = sent;
        }
      }
      this.retrying.delete(convId);
      // Changed or removed while it was being sent: the new one keeps its own times.
      if (conv.schedule !== s) return;
      this.record(conv, s, due, now, outcome);
    });
  }

  private record(conv: Conversation, s: ConversationSchedule, due: number, now: number, outcome: { result: ScheduleResult; reason?: string }): void {
    const { nextRunAt: _done, lastError: _error, ...rest } = s;
    const next = s.repeat.kind === 'once' ? undefined : nextRun(s, Math.max(now, due));
    conv.schedule = {
      ...rest,
      // A one-time schedule is done; it stays, switched off, to be set again.
      enabled: next !== undefined && s.enabled,
      ...(next !== undefined ? { nextRunAt: next } : {}),
      lastRunAt: due,
      lastResult: outcome.result,
      ...(outcome.reason ? { lastError: outcome.reason } : {}),
    };
    this.store.saveSchedule(conv);
    this.orchestrator.emitConversation(conv);
    const when = scheduleTime(due, s);
    // The note ends the sentence itself.
    const why = (outcome.reason ?? '').replace(/[.。]\s*$/, '');
    if (outcome.result === 'missed') this.orchestrator.systemNote(conv, t().scheduleMissedNote(when));
    else if (outcome.result === 'skipped') this.orchestrator.systemNote(conv, t().scheduleSkippedNote(when, why));
    else if (outcome.result === 'failed') this.orchestrator.systemNote(conv, t().scheduleFailedNote(when, outcome.reason ?? ''));
  }
}
