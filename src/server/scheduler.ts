import type { Conversation, ConversationSchedule, ScheduleResult, ScheduleTrigger, ScheduleWatch, WatchState } from '../shared/types';
import { nextRun, triggerKey, watchOf } from '../shared/schedule';
import { HttpError } from './errors';
import { t, withLang } from './i18n';
import type { Orchestrator } from './orchestrator';
import type { Store } from './store';
import { nextCheckAt, type TriggerChecker, type WatchCheck } from './watch';

/** The entries of `map` whose path is also in `within` (none there: nothing). */
function only(map: Record<string, string>, within: Record<string, string> | undefined): Record<string, string> | undefined {
  const kept = Object.fromEntries(Object.entries(map).filter(([path]) => within?.[path] !== undefined));
  return Object.keys(kept).length ? kept : undefined;
}

/** Files held for the team or still settling, together (none: nothing). */
function heldOf(...maps: (Record<string, string> | undefined)[]): Pick<ScheduleWatch, 'heldFiles'> {
  const all = Object.assign({}, ...maps.filter(Boolean)) as Record<string, string>;
  return Object.keys(all).length ? { heldFiles: all } : {};
}

/** What a check found of its source, to keep: only what each source keeps (`WatchState`), never anything else it said. */
function keptState(state: WatchState): WatchState {
  const { uidValidity, lastUid, lastId, seen, lookedAt, files, filesIn } = state;
  return {
    ...(uidValidity !== undefined ? { uidValidity } : {}),
    ...(lastUid !== undefined ? { lastUid } : {}),
    ...(lastId !== undefined ? { lastId } : {}),
    ...(seen ? { seen } : {}),
    ...(lookedAt !== undefined ? { lookedAt } : {}),
    ...(files ? { files } : {}),
    ...(filesIn !== undefined ? { filesIn } : {}),
  };
}

/** What each trigger's checks keep, with one trigger's replaced by `watch` (by its key), in the triggers' order. */
function withWatch(s: ConversationSchedule, watch: ScheduleWatch): ScheduleWatch[] {
  if (s.repeat.kind !== 'event') return [watch];
  return s.repeat.triggers.flatMap((t) => (triggerKey(t) === watch.key ? [watch] : (watchOf(s, t) ?? [])));
}

/**
 * One round of checks of an automation's triggers: whether a message one of them sent started or
 * queued a run (`started`), and the folder as it was just before that message went (`inUse`,
 * `writes`), for the file triggers checked after it: the run it starts writes there, but what they
 * find was there before it, while a run that began before it (the user's own, during a slow check of
 * another trigger) is seen as it is.
 */
interface Round {
  /** Some of the triggers it checks look at files: the folder's state is taken before the message that starts a run. */
  files: boolean;
  /** Whether the folder was in use just before the message that started a run went. */
  inUse?: boolean;
  /** The folder's write count then (`Orchestrator.folderWrites()`). */
  writes?: string;
  /** One of its triggers' messages started a run (or was queued for one). */
  started?: boolean;
}

/** One more check asked for after the one under way: the user's own (`force`), and of which triggers (none: every one). */
interface FollowUp {
  force: boolean;
  keys?: Set<string>;
  done: Promise<void>;
}

/** A time missed by more than this (Harness Relay was not running, the computer slept) counts as missed. */
export const MISSED_AFTER_MS = 10 * 60_000;

/**
 * How long a time the conversation cannot take yet (`busy`) is tried again, from the first try: long
 * enough for a settings change, an apply or the lead agent's design to end; one held up longer has the
 * time skipped, with a note. (Another conversation writing in the same folder holds nothing up: the
 * team then works in a worktree of its own.)
 */
export const BUSY_RETRY_MS = 30 * 60_000;

/** How often due schedules are looked for. */
const TICK_MS = 15_000;

/** How a time that came due went; `chatId`: the conversation it opened (`newChat`). */
/** `noted`: the chat has a note of it already (its fixed command's), not written again. */
type Outcome = { result: ScheduleResult; reason?: string; chatId?: string; noted?: boolean };

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
 * not sent leaves a note in the chat; times skipped one after another for the same reason share one
 * (`Orchestrator.noteSkipped()`).
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  /** Stopped (the server is shutting down): what is being sent now is not recorded. */
  private stopped = false;
  /** Conversations whose due time was found busy: that time, and when it was first tried. Retried, not missed. */
  private retrying = new Map<string, { due: number; since: number }>();
  /** The checks of what automations wait for, under way: one at a time for each (whether it is the user's own). */
  private checks = new Map<string, { done: Promise<void>; force: boolean }>();
  /** The one more check asked for after the one under way (`check(…, again)`). */
  private followUps = new Map<string, FollowUp>();
  private watching?: Promise<void>;
  /**
   * Whether the mail server tells Harness Relay when mail arrives for this automation (IMAP IDLE,
   * `idle.ts`): its checks then come more slowly, since one comes at once when mail arrives.
   */
  listening?: (convId: string, trigger: ScheduleTrigger) => boolean;

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
   * Check what the automations that start when something happens wait for, those one of whose triggers'
   * next check has come (those triggers), one after another: a slow mail server holds up the others'
   * checks, never a time coming due.
   */
  watchTick(): Promise<void> {
    this.watching ??= (async () => {
      for (const id of this.store.watchDue(this.now())) {
        if (this.stopped) return;
        try {
          await this.check(id, false, false, 'due');
        } catch (err) {
          if (!(err instanceof HttpError && err.status === 404)) console.error('[scheduler] could not check an automation:', err);
        }
      }
    })().finally(() => (this.watching = undefined));
    return this.watching;
  }

  /**
   * Check what the conversation's automation waits for, and send its message, with what is new in an
   * <event> block, when something is: each trigger on its own (its own state, next check and errors),
   * one after another, and each that found something sends a message of its own. Which triggers:
   * `keys` (IMAP IDLE: those on the folder where mail arrived; `due`: those whose next check has come,
   * at the scheduler's own look), else every one. `force`: the user's Check now, even while it is off.
   * The first check of a trigger only records what is there. A team that cannot take it now (`busy`,
   * `skipped`) leaves it to a later check, which finds it again with whatever came meanwhile; a message
   * that was sent, queued or could not start counts it as seen. A check that fails is shown, and that
   * trigger's next ones come slower. One check at a time per conversation: a second call waits for the
   * one under way, or (`again`, or the user's check after one that was not) comes once after it.
   *
   * Files in the working directory: what a run writes there is the team's own, never something new to
   * start it. While a run writes there (this conversation's, or another's holding the folder:
   * `Orchestrator.folderInUse()`), at the first check once the folder is free again (`teamWrote`), and
   * at a check after a run wrote there since the last one (the folder's write count, `writes`), a check
   * only records the files as they are, but for those held for the team or still settling.
   */
  check(convId: string, force = false, again = false, keys?: string[] | 'due'): Promise<void> {
    const running = this.checks.get(convId);
    if (running) {
      if (!again && (!force || running.force)) return running.done;
      // Asked for something that may have come after the check under way looked (the mail server
      // said mail arrived), or the user's check after one of the triggers whose time had come: one
      // more check after it, shared by every such ask meanwhile (what each asked for, together).
      const asked = Array.isArray(keys) ? keys : undefined;
      const next = this.followUps.get(convId);
      if (next) {
        next.force ||= force;
        next.keys = next.keys && asked ? new Set([...next.keys, ...asked]) : undefined;
        return next.done;
      }
      const follow: FollowUp = { force, keys: asked ? new Set(asked) : undefined, done: Promise.resolve() };
      // After the one under way, however it went (a deleted conversation's 404 too): never left behind.
      follow.done = running.done
        .catch(() => undefined)
        .then(() => {
          this.followUps.delete(convId);
          return this.check(convId, follow.force, false, follow.keys && [...follow.keys]);
        });
      this.followUps.set(convId, follow);
      return follow.done;
    }
    const which = keys === 'due' ? 'due' : keys ? new Set(keys) : 'all';
    const done = this.runCheck(convId, force, which).finally(() => this.checks.delete(convId));
    this.checks.set(convId, { done, force });
    return done;
  }

  /**
   * The mail server said mail arrived in a folder (IMAP IDLE, `idle.ts`): check the automation's
   * trigger on it (by its key) now, and only that one, once more after a check under way.
   */
  mailArrived(convId: string, key: string): Promise<void> {
    return this.check(convId, false, true, [key]);
  }

  private async runCheck(convId: string, force: boolean, which: Set<string> | 'all' | 'due'): Promise<void> {
    if (this.stopped || !this.checkTrigger) return;
    const conv = this.store.get(convId);
    const s = conv?.schedule;
    if (!conv || !s || s.repeat.kind !== 'event' || (!s.enabled && !force)) return;
    const now = this.now();
    const picked = s.repeat.triggers.filter((t) =>
      which === 'all' ? true : which === 'due' ? (watchOf(s, t)?.nextCheckAt ?? 0) <= now : which.has(triggerKey(t)),
    );
    const round: Round = { files: picked.some((t) => t.source === 'file') };
    // The files first: they are on this computer, so no slow server's check (mail, a calendar, GitHub)
    // comes between a message another trigger sent, whose run may move a file in with its old time
    // (`mv`, `tar x`: settled at once, never told from one that came from outside), and their look.
    const files = picked.filter((t) => t.source === 'file');
    let failed: unknown;
    for (const key of [...files, ...picked.filter((t) => t.source !== 'file')].map(triggerKey)) {
      // Deleted meanwhile (or shutting down): nothing more to check.
      if (this.stopped || this.store.get(convId) !== conv) return;
      try {
        await this.checkOne(conv, key, force, round);
      } catch (err) {
        // Deleted meanwhile: nothing more to check. Anything else is the other triggers' business still.
        if (err instanceof HttpError && err.status === 404) throw err;
        failed ??= err;
      }
    }
    if (failed) throw failed;
  }

  /** Check one trigger of the conversation's automation (by its key), and send what it found. */
  private async checkOne(conv: Conversation, key: string, force: boolean, round: Round): Promise<void> {
    const s = conv.schedule;
    if (!s || s.repeat.kind !== 'event' || (!s.enabled && !force)) return;
    const trigger = s.repeat.triggers.find((t) => triggerKey(t) === key);
    // Removed since the check began.
    if (!trigger) return;
    const convId = conv.id;
    // Checked while it is off (Check now): what came meanwhile is only recorded, as turning it on
    // again would, so that trying the connection never starts a run.
    const prev = s.enabled ? watchOf(s, trigger) : undefined;
    const started = this.now();
    // Something found earlier still waits for a team that cannot take it: the source is not asked
    // again (nor the same mail downloaded) until the team can. The user's own check always asks it.
    // Not for files: the folder is looked at all the same (it is on this computer), so that a file that
    // arrives while one waits for the team is held with it, never taken for the team's later.
    const hold =
      prev?.held && !force && trigger.source !== 'file' ? withLang(s.lang, () => this.orchestrator.scheduledHold(convId)) : undefined;
    // The team writes in the folder now, or did since the last check: only recorded. (A run another
    // trigger's message just started writes there too, but what was there before it is not its own:
    // the folder is taken as it was just before that message went, its write count too.)
    const files = trigger.source === 'file';
    const writing = files && (round.started ? Boolean(round.inUse) : this.orchestrator.folderInUse(convId));
    /** Someone writes in the folder while nothing is recorded (held, a failed check): what is written is the team's. */
    const wrote = writing ? { teamWrote: true } : {};
    if (prev && hold) {
      const { listening: _l, ...rest } = prev;
      const listening = this.listening?.(convId, trigger) ?? false;
      return this.keepWatch(conv, s, {
        ...rest,
        checkedAt: started,
        nextCheckAt: nextCheckAt(started),
        held: hold,
        ...wrote,
        ...(listening ? { listening } : {}),
      });
    }
    // A run that wrote there since the last check (began and ended between them): the next check only records too.
    const writes = files ? (round.started ? round.writes : this.orchestrator.folderWrites(convId)) : undefined;
    const sameServer = (a: string, b: string) => a.split(':')[0] === b.split(':')[0];
    // Kept by another start of the server: any write counted since this one started is new.
    const wroteSince = Boolean(
      writes && prev?.writes && (sameServer(prev.writes, writes) ? prev.writes !== writes : !writes.endsWith(':0')),
    );
    const recordOnly = files && (writing || Boolean(prev?.teamWrote) || wroteSince);
    let found: WatchCheck;
    try {
      found = await withLang(s.lang, () =>
        this.checkTrigger!(trigger, prev, {
          cwd: conv.settings.cwd,
          now: started,
          recordOnly,
          ...(prev?.heldFiles ? { held: prev.heldFiles } : {}),
        }),
      );
    } catch (err) {
      if (this.stopped || conv.schedule !== s) return;
      const failures = (prev?.failures ?? 0) + 1;
      const { held: _held, listening: _listening, ...kept } = prev ?? { key, nextCheckAt: started };
      return this.keepWatch(conv, s, {
        ...kept,
        key,
        checkedAt: started,
        nextCheckAt: nextCheckAt(this.now(), failures),
        error: (err as Error).message || String(err),
        failures,
        ...wrote,
      });
    }
    // Changed or removed while it was checked: the new one starts afresh.
    if (this.stopped || conv.schedule !== s) return;
    // A run that began while the files were looked at writes there too (or began and ended meanwhile).
    const busy =
      writing || (files && !round.started && (this.orchestrator.folderInUse(convId) || this.orchestrator.folderWrites(convId) !== writes));
    const listening = this.listening?.(convId, trigger) ?? false;
    // What still settled while such a run began may be its own: only what already waited before it stays kept.
    // (So does what still settles once another trigger's message started a run in this round.)
    const pending = (busy || round.started) && found.pending ? only(found.pending, prev?.heldFiles) : found.pending;
    // Files still waiting through a check that only records: why they wait stays said (asked again, nothing
    // started); with nothing else holding them, it is that the team writes there, or just did.
    const stillHeld =
      recordOnly && prev?.held && prev.heldFiles
        ? { held: withLang(s.lang, () => this.orchestrator.scheduledHold(convId) ?? t().scheduleFolderWritten) }
        : {};
    const seen: ScheduleWatch = {
      key,
      ...keptState(found.state),
      checkedAt: started,
      seenAt: started,
      nextCheckAt: nextCheckAt(this.now(), 0, listening),
      ...(listening ? { listening } : {}),
      ...(busy ? { teamWrote: true } : {}),
      // What was held for the team stays held while only recorded, and what still settles is kept like it:
      // listed once the folder is free.
      ...heldOf(recordOnly ? prev?.heldFiles : undefined, pending),
      ...(writes ? { writes } : {}),
      ...stillHeld,
    };
    // A run that began during this look did not write what was found (every file listed had not
    // changed for a while): sent all the same, queued for the team.
    if (!found.event || recordOnly) return this.keepWatch(conv, s, seen);
    const now = this.now();
    // The folder as it is just before this message goes, for the file triggers checked after it once
    // it starts a run (taken again before the next message while none has).
    if (round.files && !round.started) {
      round.inUse = this.orchestrator.folderInUse(convId);
      round.writes = this.orchestrator.folderWrites(convId);
    }
    await withLang(s.lang, async () => {
      const sent = await this.orchestrator.sendScheduled(convId, now, { event: found.event, eventSource: trigger.source });
      // Shutting down: nothing was recorded, so the next start finds the same mail.
      if (this.stopped) return;
      if (sent.result === 'sent' || sent.result === 'queued') round.started = true;
      if (sent.result === 'busy' || sent.result === 'skipped') {
        if (conv.schedule !== s) return;
        // Not seen yet: a later check finds it again, with what came meanwhile, in one run.
        const { error: _e, failures: _f, listening: _l, ...kept } = prev ?? { key, nextCheckAt: seen.nextCheckAt };
        // Checked again soon, as when no IDLE listens: nothing else says when the team is free.
        return this.keepWatch(conv, s, {
          ...kept,
          checkedAt: started,
          nextCheckAt: nextCheckAt(this.now()),
          ...(listening ? { listening } : {}),
          held: sent.reason ?? t().scheduleBusy,
          // The files it found, as they are now: kept unseen through what the team writes meanwhile.
          ...heldOf(found.found, pending),
          ...(writes ? { writes } : {}),
          ...(busy ? { teamWrote: true } : {}),
        });
      }
      // The message went (or could not start): what it was about counts as seen, also when the
      // automation was saved meanwhile and still waits for the same source.
      const current = conv.schedule;
      if (!current || current.repeat.kind !== 'event' || !current.repeat.triggers.some((tr) => triggerKey(tr) === key)) return;
      const { lastError: _error, lastChatId: _chat, ...rest } = current;
      // The run it started, when it writes in the folder, locks it: the next check sees the count change.
      conv.schedule = {
        ...rest,
        watches: withWatch(current, seen),
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

  /** Keep what a check found of one trigger's source (the other triggers', and the rest of the schedule, as they are). */
  private keepWatch(conv: Conversation, s: ConversationSchedule, watch: ScheduleWatch): void {
    conv.schedule = { ...s, watches: withWatch(s, watch) };
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
    if (outcome.result === 'skipped') this.orchestrator.noteSkipped(conv, s, due, why);
    else if (outcome.result === 'missed') this.orchestrator.systemNote(conv, t().scheduleMissedNote(when));
    else if (outcome.result === 'failed' && !outcome.noted)
      this.orchestrator.systemNote(conv, t().scheduleFailedNote(when, outcome.reason ?? ''));
  }
}
