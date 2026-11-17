import type { Conversation, ConversationSchedule, ScheduleResult, ScheduleWatch } from '../shared/types';
import { nextRun } from '../shared/schedule';
import { HttpError } from './errors';
import { t, withLang } from './i18n';
import type { Orchestrator } from './orchestrator';
import type { Store } from './store';
import { nextCheckAt, triggerKey, type TriggerChecker, type WatchCheck } from './watch';

/** A time missed by more than this (Harness Relay was not running, the computer slept) counts as missed. */
export const MISSED_AFTER_MS = 10 * 60_000;

/**
 * How long a time the conversation cannot take yet (`busy`) is tried again, from the first try: long
 * enough for another conversation's run in the same folder to end.
 */
export const BUSY_RETRY_MS = 30 * 60_000;

/** How often due schedules are looked for. */
const TICK_MS = 15_000;

/** How a time that came due went; `chatId`: the conversation it opened (`newChat`). */
type Outcome = { result: ScheduleResult; reason?: string; chatId?: string };

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
  /** The checks of what automations wait for, under way: one at a time for each. */
  private checks = new Map<string, Promise<void>>();
  private watching?: Promise<void>;

  constructor(
    private store: Store,
    private orchestrator: Orchestrator,
    private now: () => number = Date.now,
    /** Checks what an automation that starts when something happens waits for (`watch.ts`); none: such automations wait. */
    private checkTrigger?: TriggerChecker,
  ) {}

  /** Look for due schedules now and every `TICK_MS` (also right after the computer wakes up). */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.recover();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Send the schedules that are due, the most overdue first; one look at a time. Then check what automations wait for. */
  tick(): Promise<void> {
    void this.watchTick();
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

  /**
   * Check what the automations that start when something happens wait for, those whose next check has
   * come, one after another: a slow mail server holds up the others' checks, never a time coming due.
   */
  watchTick(): Promise<void> {
    this.watching ??= (async () => {
      for (const id of this.store.watchDue(this.now())) {
        if (this.stopped) return;
        try {
          await this.check(id);
        } catch (err) {
          if (!(err instanceof HttpError && err.status === 404)) console.error('[scheduler] could not check an automation:', err);
        }
      }
    })().finally(() => (this.watching = undefined));
    return this.watching;
  }

  /**
   * Check what the conversation's automation waits for (`force`: now, even while it is off: the user's
   * Check now), and send its message, with what is new in an <event> block, when something is. The
   * first check only records what is there. A team that cannot take it now (`busy`, `skipped`) leaves
   * it to a later check, which finds it again with whatever came meanwhile; a message that was sent,
   * queued or could not start counts it as seen. A check that fails is shown, and the next ones come
   * slower. One check at a time per conversation: a second call waits for the one under way.
   */
  check(convId: string, force = false): Promise<void> {
    const running = this.checks.get(convId);
    if (running) return running;
    const p = this.runCheck(convId, force).finally(() => this.checks.delete(convId));
    this.checks.set(convId, p);
    return p;
  }

  private async runCheck(convId: string, force: boolean): Promise<void> {
    if (this.stopped || !this.checkTrigger) return;
    const conv = this.store.get(convId);
    const s = conv?.schedule;
    if (!conv || !s || s.repeat.kind !== 'event' || (!s.enabled && !force)) return;
    const trigger = s.repeat.trigger;
    const key = triggerKey(trigger);
    // Checked while it is off (Check now): what came meanwhile is only recorded, as turning it on
    // again would, so that trying the connection never starts a run.
    const prev = s.watch?.key === key && s.enabled ? s.watch : undefined;
    const started = this.now();
    // Something found earlier still waits for a team that cannot take it: the source is not asked
    // again (nor the same mail downloaded) until the team can. The user's own check always asks it.
    const hold = prev?.held && !force ? withLang(s.lang, () => this.orchestrator.scheduledHold(convId)) : undefined;
    if (prev && hold) return this.keepWatch(conv, s, { ...prev, checkedAt: started, nextCheckAt: nextCheckAt(started), held: hold });
    let found: WatchCheck;
    try {
      found = await withLang(s.lang, () => this.checkTrigger!(trigger, prev));
    } catch (err) {
      if (this.stopped || conv.schedule !== s) return;
      const failures = (prev?.failures ?? 0) + 1;
      const { held: _held, ...kept } = prev ?? { key, nextCheckAt: started };
      return this.keepWatch(conv, s, {
        ...kept,
        key,
        checkedAt: started,
        nextCheckAt: nextCheckAt(this.now(), failures),
        error: (err as Error).message || String(err),
        failures,
      });
    }
    // Changed or removed while it was checked: the new one starts afresh.
    if (this.stopped || conv.schedule !== s) return;
    const { uidValidity, lastUid } = found.state;
    const seen: ScheduleWatch = {
      key,
      ...(uidValidity !== undefined ? { uidValidity } : {}),
      ...(lastUid !== undefined ? { lastUid } : {}),
      checkedAt: started,
      seenAt: started,
      nextCheckAt: nextCheckAt(this.now()),
    };
    if (!found.event) return this.keepWatch(conv, s, seen);
    const now = this.now();
    await withLang(s.lang, async () => {
      const sent = await this.orchestrator.sendScheduled(convId, now, { event: found.event, eventSource: trigger.source });
      // Shutting down: nothing was recorded, so the next start finds the same mail.
      if (this.stopped) return;
      if (sent.result === 'busy' || sent.result === 'skipped') {
        if (conv.schedule !== s) return;
        // Not seen yet: a later check finds it again, with what came meanwhile, in one run.
        const { error: _e, failures: _f, ...kept } = prev ?? { key, nextCheckAt: seen.nextCheckAt };
        return this.keepWatch(conv, s, {
          ...kept,
          checkedAt: started,
          nextCheckAt: seen.nextCheckAt,
          held: sent.reason ?? t().scheduleBusy,
        });
      }
      // The message went (or could not start): what it was about counts as seen, also when the
      // automation was saved meanwhile and still waits for the same source.
      const current = conv.schedule;
      if (!current || current.repeat.kind !== 'event' || triggerKey(current.repeat.trigger) !== key) return;
      const { lastError: _error, lastChatId: _chat, watch: _watch, ...rest } = current;
      conv.schedule = {
        ...rest,
        watch: seen,
        lastRunAt: now,
        lastResult: sent.result,
        ...('reason' in sent && sent.reason ? { lastError: sent.reason } : {}),
        ...(sent.result === 'sent' && sent.chatId ? { lastChatId: sent.chatId } : {}),
      };
      this.store.saveSchedule(conv);
      this.orchestrator.emitConversation(conv);
      if (sent.result === 'failed') this.orchestrator.systemNote(conv, t().watchFailedNote(sent.reason.replace(/[.。]\s*$/, '')));
    });
  }

  /** Keep what a check found of the automation's source (the rest of the schedule as it is). */
  private keepWatch(conv: Conversation, s: ConversationSchedule, watch: ScheduleWatch): void {
    conv.schedule = { ...s, watch };
    this.store.saveSchedule(conv);
    this.orchestrator.emitConversation(conv);
  }

  /**
   * At startup: a run a tracking schedule started that never ended was cut off when the server stopped,
   * so it is tried again now (as a retry, so the schedule's tries still count).
   */
  recover(): void {
    const now = this.now();
    for (const id of this.store.trackingSchedules()) {
      const conv = this.store.get(id);
      const flight = conv?.schedule?.tracking?.inFlight;
      if (!conv || !flight) continue;
      const { inFlight: _cut, ...rest } = conv.schedule!.tracking!;
      conv.schedule!.tracking = rest;
      this.store.saveSchedule(conv);
      withLang(conv.schedule!.lang, () => this.orchestrator.retryTracked(conv, flight.due, flight.attempt + 1, now, true));
    }
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
    // A tracking schedule's time whose run failed, tried again: sent as that time, its tries counted.
    const retry = s.tracking?.retry?.at === due ? s.tracking.retry : undefined;
    const late = now - due > MISSED_AFTER_MS;
    const busyFor = this.retrying.get(convId);
    const since = busyFor?.due === due ? busyFor.since : undefined;
    // Notes and the run's system messages are written in the language the schedule was saved in.
    await withLang(s.lang, async () => {
      let outcome: Outcome;
      if (late && since === undefined && s.missed === 'skip') {
        outcome = { result: 'missed' };
      } else if (retry && s.tracking?.notes.some((n) => n.at >= retry.due)) {
        // A report on the goal came after that time's run failed (the user's Retry of it, say): not tried again.
        outcome = { result: 'skipped', reason: t().trackingRetryNotNeeded };
      } else {
        const sent = await this.orchestrator.sendScheduled(convId, retry?.due ?? due, { attempt: retry?.attempt ?? 0, retries: true });
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
      // A tracking schedule's run that could not start is tried again too.
      if (outcome.result === 'failed' && s.goal) this.orchestrator.retryTracked(conv, retry?.due ?? due, (retry?.attempt ?? 0) + 1, now);
    });
  }

  private record(conv: Conversation, s: ConversationSchedule, due: number, now: number, outcome: Outcome): void {
    const { nextRunAt: _done, lastError: _error, lastChatId: _chat, ...rest } = s;
    const next = s.repeat.kind === 'once' ? undefined : nextRun(s, Math.max(now, due));
    // A retry is used up by the time it came due for, whatever happened then.
    const { retry: _retry, ...tracking } = s.tracking ?? { status: 'working', notes: [] };
    conv.schedule = {
      ...rest,
      ...(s.tracking ? { tracking } : {}),
      // A one-time schedule is done; it stays, switched off, to be set again.
      enabled: next !== undefined && s.enabled,
      ...(next !== undefined ? { nextRunAt: next } : {}),
      lastRunAt: due,
      lastResult: outcome.result,
      ...(outcome.reason ? { lastError: outcome.reason } : {}),
      ...(outcome.chatId ? { lastChatId: outcome.chatId } : {}),
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
