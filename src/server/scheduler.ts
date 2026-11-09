import type { Conversation, ConversationSchedule, ScheduleResult } from '../shared/types';
import { nextRun } from '../shared/schedule';
import { HttpError } from './errors';
import { t, withLang } from './i18n';
import type { Orchestrator } from './orchestrator';
import type { Store } from './store';

/** A time missed by more than this (Harness Relay was not running, the computer slept) counts as missed. */
export const MISSED_AFTER_MS = 10 * 60_000;

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
 * the schedule says; either way only once, however many times were missed. What happened is kept
 * with the schedule (`lastResult`), and a time that was not sent leaves a note in the chat.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;

  constructor(
    private store: Store,
    private orchestrator: Orchestrator,
    private now: () => number = Date.now,
  ) {}

  /** Look for due schedules now and every `TICK_MS` (also right after the computer wakes up). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
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
    const conv = this.store.get(convId);
    const s = conv?.schedule;
    if (!conv || !s?.enabled || s.nextRunAt === undefined || s.nextRunAt > now) return;
    const due = s.nextRunAt;
    // Notes and the run's system messages are written in the language the schedule was saved in.
    await withLang(s.lang, async () => {
      let outcome: { result: ScheduleResult; reason?: string };
      if (now - due > MISSED_AFTER_MS && s.missed === 'skip') {
        outcome = { result: 'missed' };
      } else {
        const sent = await this.orchestrator.sendScheduled(convId);
        if (sent.result === 'busy') return; // tried again on the next look
        outcome = sent;
      }
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
    if (outcome.result === 'missed') this.orchestrator.systemNote(conv, t().scheduleMissedNote(when));
    else if (outcome.result === 'skipped') this.orchestrator.systemNote(conv, t().scheduleSkippedNote(when, outcome.reason ?? ''));
    else if (outcome.result === 'failed') this.orchestrator.systemNote(conv, t().scheduleFailedNote(when, outcome.reason ?? ''));
  }
}
