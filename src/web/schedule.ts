import {
  SCHEDULE_LIMITS,
  WATCH_LIMITS,
  type ConversationSchedule,
  type ConversationSummary,
  type NewScheduleHook,
  type EventSource,
  type ScheduleProposal,
  type ScheduleRepeat,
  type ScheduleTrigger,
  type ScheduleUpdate,
  type ScheduleWatch,
} from '../shared/types';
import {
  filePattern,
  mailFolder,
  parseTime,
  repoName,
  sameTriggers,
  upcomingRuns,
  validBranch,
  validRepo,
  watchOf,
} from '../shared/schedule';
import { proposalUpdate } from '../shared/scheduleProposal';
import type { PendingFile } from './components/MessageFiles';
import type { Messages } from './i18n';

/** The schedule drawer's form: every kind's fields are kept, so switching kinds and back loses nothing. */
export interface ScheduleDraft {
  files: PendingFile[];
  removeAttachments: string[];
  text: string;
  kind: ScheduleRepeat['kind'];
  /** `once`: a datetime-local value ("YYYY-MM-DDTHH:MM"), in the browser's time zone. */
  at: string;
  /** `daily` / `weekly`: "HH:MM". */
  time: string;
  /** `weekly`: 0 = Sunday. */
  days: number[];
  /** `interval` */
  hours: number;
  timeZone: string;
  enabled: boolean;
  approvals: ConversationSchedule['approvals'];
  missed: ConversationSchedule['missed'];
  newChat: boolean;
  /** The goal it tracks ('' for none). */
  goal: string;
  /**
   * `event`: what it waits for, any of them (at least one, at most `WATCH_LIMITS.triggers`), each with
   * every source's fields as the inputs keep them ('' for a condition not given), so that switching
   * sources keeps what was typed: a mail account (`account`), its folder, sender and subject; a
   * calendar (`calendar`), the minutes before an event and its title; a GitHub repository, what to
   * watch there and the branch of CI runs; a file pattern.
   */
  triggers: TriggerDraft[];
}

export interface TriggerDraft {
  source: ScheduleTrigger['source'];
  account: string;
  folder: string;
  from: string;
  subject: string;
  calendar: string;
  minutes: number;
  title: string;
  repo: string;
  on: 'pr' | 'ci';
  branch: string;
  pattern: string;
}

/** A trigger's fields in the form, before anything is picked or typed. */
export const EMPTY_TRIGGER: TriggerDraft = {
  source: 'mail',
  account: '',
  folder: 'INBOX',
  from: '',
  subject: '',
  calendar: '',
  minutes: 10,
  title: '',
  repo: '',
  on: 'pr',
  branch: '',
  pattern: '',
};

/** A saved trigger's fields in the form. */
function triggerDraft(tr: ScheduleTrigger): TriggerDraft {
  switch (tr.source) {
    case 'mail':
      return { ...EMPTY_TRIGGER, source: 'mail', account: tr.account, folder: tr.folder, from: tr.from ?? '', subject: tr.subject ?? '' };
    case 'calendar':
      return { ...EMPTY_TRIGGER, source: 'calendar', calendar: tr.account, minutes: tr.minutes, title: tr.title ?? '' };
    case 'github':
      return { ...EMPTY_TRIGGER, source: 'github', repo: tr.repo, on: tr.on, branch: tr.branch ?? '' };
    case 'file':
      return { ...EMPTY_TRIGGER, source: 'file', pattern: tr.pattern };
  }
}

/** The trigger the form's fields make (trimmed; an empty condition left out). */
export function triggerOf(d: TriggerDraft): ScheduleTrigger {
  const opt = <K extends string>(key: K, v: string) => (v.trim() ? ({ [key]: v.trim() } as Record<K, string>) : {});
  switch (d.source) {
    case 'mail':
      return {
        source: 'mail',
        account: d.account,
        folder: mailFolder(d.folder.trim() || 'INBOX'),
        ...opt('from', d.from),
        ...opt('subject', d.subject),
      };
    case 'calendar':
      return { source: 'calendar', account: d.calendar, minutes: d.minutes, ...opt('title', d.title) };
    case 'github':
      return { source: 'github', repo: repoName(d.repo), on: d.on, ...(d.on === 'ci' ? opt('branch', d.branch) : {}) };
    case 'file':
      return { source: 'file', pattern: d.pattern.trim() };
  }
}

/** A trigger as the server keeps it (a file pattern as `filePattern()` writes it): two that are the same there are the same here. */
function keptTrigger(d: TriggerDraft): ScheduleTrigger {
  const tr = triggerOf(d);
  return tr.source === 'file' ? { ...tr, pattern: filePattern(tr.pattern) ?? tr.pattern } : tr;
}

/** The time zone of this browser. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A moment as a datetime-local value, in the browser's time zone. */
export function localInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value as a moment (NaN when it is not one). */
export function fromLocalInput(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return NaN;
  return new Date(value).getTime(); // without an offset, the browser's time zone
}

/**
 * The form for a conversation's schedule, or for a new one: no set times (Run once now and its webhook
 * send it), with weekdays at 09:00 ready for when another kind is picked.
 */
export function draftFrom(s: ConversationSchedule | undefined, now: number, timeZone = browserTimeZone()): ScheduleDraft {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const draft: ScheduleDraft = {
    files: [],
    removeAttachments: [],
    text: '',
    kind: 'manual',
    at: localInput(tomorrow.getTime()),
    time: '09:00',
    days: [1, 2, 3, 4, 5],
    hours: 6,
    timeZone,
    enabled: true,
    approvals: 'deny',
    missed: 'skip',
    newChat: false,
    goal: '',
    triggers: [EMPTY_TRIGGER],
  };
  if (!s) return draft;
  const r = s.repeat;
  return {
    ...draft,
    text: s.text,
    kind: r.kind,
    ...(r.kind === 'once' ? { at: localInput(r.at) } : {}),
    ...(r.kind === 'daily' || r.kind === 'weekly' ? { time: r.time } : {}),
    ...(r.kind === 'weekly' ? { days: [...r.days] } : {}),
    ...(r.kind === 'interval' ? { hours: r.hours } : {}),
    ...(r.kind === 'event' ? { triggers: r.triggers.map(triggerDraft) } : {}),
    timeZone: s.timeZone,
    enabled: s.enabled,
    approvals: s.approvals,
    missed: s.missed,
    newChat: s.newChat,
    goal: s.goal ?? '',
  };
}

export function repeatOf(d: ScheduleDraft): ScheduleRepeat {
  switch (d.kind) {
    case 'once':
      return { kind: 'once', at: fromLocalInput(d.at) };
    case 'daily':
      return { kind: 'daily', time: d.time };
    case 'weekly':
      return { kind: 'weekly', time: d.time, days: [...new Set(d.days)].sort((a, b) => a - b) };
    case 'interval':
      return { kind: 'interval', hours: d.hours };
    case 'manual':
      return { kind: 'manual' };
    case 'event':
      return { kind: 'event', triggers: d.triggers.map(triggerOf) };
  }
}

/**
 * The form's triggers with one more (`add`: the last one's source, its fields as an empty trigger's,
 * its account and calendar the first trigger's), or without the one at `remove` (never the last one).
 */
export function editTriggers(d: Pick<ScheduleDraft, 'triggers'>, change: { add: true } | { remove: number }): TriggerDraft[] {
  if ('add' in change) {
    if (d.triggers.length >= WATCH_LIMITS.triggers) return d.triggers;
    // Most often another of the same kind (another folder, another pattern): the last one's source, its fields empty.
    const first = d.triggers[0];
    const last = d.triggers.at(-1);
    return [
      ...d.triggers,
      { ...EMPTY_TRIGGER, source: last?.source ?? EMPTY_TRIGGER.source, account: first?.account ?? '', calendar: first?.calendar ?? '' },
    ];
  }
  if (d.triggers.length <= 1) return d.triggers;
  return d.triggers.filter((_, i) => i !== change.remove);
}

/** What the form saves. */
export function toUpdate(d: ScheduleDraft): ScheduleUpdate {
  return {
    text: d.text.trim(),
    repeat: repeatOf(d),
    timeZone: d.timeZone,
    // No set times is never off: only Run once now and the webhook send it.
    enabled: d.kind === 'manual' || d.enabled,
    approvals: d.approvals,
    missed: d.missed,
    newChat: d.newChat,
    ...(d.goal.trim() ? { goal: d.goal.trim() } : {}),
  };
}

/** Whether the form says something other than the saved schedule. */
export function draftChanged(d: ScheduleDraft, s: ConversationSchedule | undefined): boolean {
  if (!s || d.files.length || d.removeAttachments.length) return true;
  // As it is saved, on or off: a schedule with no set times that its reached goal switched off is
  // turned on again by saving it.
  const saved = { ...toUpdate(draftFrom(s, 0)), enabled: s.enabled };
  return JSON.stringify(toUpdate(d)) !== JSON.stringify(saved);
}

/** What keeps the form from being saved, first problem first (the server checks the same). */
export function draftProblems(d: ScheduleDraft, now: number, t: Messages): string[] {
  const p = t.schedule.problems;
  const out: string[] = [];
  const text = d.text.trim();
  if (!text) out.push(p.text);
  else if (text.length > SCHEDULE_LIMITS.maxText) out.push(p.tooLong(SCHEDULE_LIMITS.maxText));
  if (d.goal.trim().length > SCHEDULE_LIMITS.maxGoal) out.push(t.schedule.goalTooLong(SCHEDULE_LIMITS.maxGoal));
  switch (d.kind) {
    case 'once': {
      const at = fromLocalInput(d.at);
      if (Number.isNaN(at)) out.push(p.moment);
      else if (d.enabled && at <= now) out.push(p.past);
      break;
    }
    case 'weekly':
    case 'daily':
      if (d.kind === 'weekly' && !d.days.length) out.push(p.days);
      if (!parseTime(d.time)) out.push(p.time);
      break;
    case 'interval':
      if (!Number.isInteger(d.hours) || d.hours < 1 || d.hours > SCHEDULE_LIMITS.maxHours) out.push(p.hours(SCHEDULE_LIMITS.maxHours));
      break;
    case 'event': {
      // With several, each problem says which thing to wait for it is about.
      const several = d.triggers.length > 1;
      d.triggers.forEach((tr, i) => {
        const push = (problem: string) => out.push(several ? p.ofTrigger(i + 1, problem) : problem);
        if (tr.source === 'mail' && !tr.account) push(p.account);
        if (tr.source === 'calendar' && !tr.calendar) push(p.calendar);
        if (tr.source === 'calendar' && (!Number.isInteger(tr.minutes) || tr.minutes < 1 || tr.minutes > WATCH_LIMITS.maxMinutes))
          push(p.minutes(WATCH_LIMITS.maxMinutes));
        if (tr.source === 'github' && !validRepo(repoName(tr.repo))) push(p.repo);
        if (tr.source === 'github' && tr.on === 'ci' && tr.branch.trim() && !validBranch(tr.branch.trim())) push(p.branch);
        if (tr.source === 'file' && !filePattern(tr.pattern)) push(p.pattern);
      });
      if (!d.triggers.length || d.triggers.length > WATCH_LIMITS.triggers) out.push(p.triggers(WATCH_LIMITS.triggers));
      else if (sameTriggers(d.triggers.map(keptTrigger))) out.push(p.sameTrigger);
      break;
    }
  }
  return out;
}

/**
 * Whether saving the form keeps the saved schedule's times (its `repeat` and time zone), and so an
 * interval's cadence (the server keeps `updatedAt` then).
 */
export function sameTimes(d: ScheduleDraft, s: ConversationSchedule | undefined): boolean {
  return Boolean(s) && JSON.stringify(repeatOf(d)) === JSON.stringify(s!.repeat) && d.timeZone === s!.timeZone;
}

/** The next times the form would send once saved now: an interval counts from when its times were set. */
export function previewRuns(d: ScheduleDraft, now: number, saved?: ConversationSchedule, count = 3): number[] {
  const updatedAt = saved && sameTimes(d, saved) ? saved.updatedAt : now;
  return upcomingRuns({ repeat: repeatOf(d), timeZone: d.timeZone, updatedAt }, now, count);
}

/**
 * The time zone a schedule's times are shown in: its own for times of day, so they read as they were
 * set; this browser's for a one-time schedule, typed here as a moment, and for intervals.
 */
export function shownZone(s: { repeat: Pick<ScheduleRepeat, 'kind'>; timeZone: string }): string | undefined {
  return s.repeat.kind === 'daily' || s.repeat.kind === 'weekly' ? s.timeZone : undefined;
}

/**
 * A moment as the schedule UI shows it: weekday, date and time, in `timeZone` (the schedule's, so its
 * times read as they were set) or this browser's.
 */
export function formatWhen(ms: number, lang: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  try {
    return new Date(ms).toLocaleString(lang, { ...options, timeZone });
  } catch {
    return new Date(ms).toLocaleString(lang, options); // a time zone this browser does not know
  }
}

/** When a schedule sends, in a few words: "Weekdays at 09:00", "每 6 小時", "When a new mail from … arrives". */
export function describeRepeat(r: ScheduleRepeat, t: Messages, lang: string): string {
  const s = t.schedule.summary;
  switch (r.kind) {
    case 'once':
      return s.once(formatWhen(r.at, lang)); // typed in this browser's time zone
    case 'daily':
      return s.daily(r.time);
    case 'weekly': {
      const days = [...new Set(r.days)].sort((a, b) => a - b);
      if (days.length === 7) return s.everyDay(r.time);
      if (days.join() === '1,2,3,4,5') return s.weekdays(r.time);
      // Monday first, Sunday last, as people read a week.
      const ordered = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)];
      return s.weekly(ordered.map((d) => t.schedule.weekdays[d]).join(t.schedule.daySeparator), r.time);
    }
    case 'interval':
      return s.interval(r.hours);
    case 'manual':
      return s.manual;
    case 'event':
      return describeTriggers(r.triggers, t);
  }
}

/** What an automation that starts when something happens waits for, in a few words: any of them, joined with "or". */
export function describeTriggers(triggers: ScheduleTrigger[], t: Messages): string {
  return t.schedule.summary.any(triggers.map((tr) => describeTrigger(tr, t)));
}

/** What an automation that starts when something happens waits for, in a few words (a mail folder other than the inbox named). */
export function describeTrigger(trigger: ScheduleTrigger, t: Messages): string {
  const s = t.schedule.summary;
  switch (trigger.source) {
    case 'mail':
      return s.mail({
        ...(trigger.folder.toUpperCase() !== 'INBOX' ? { folder: trigger.folder } : {}),
        ...(trigger.from ? { from: trigger.from } : {}),
        ...(trigger.subject ? { subject: trigger.subject } : {}),
      });
    case 'calendar':
      return s.calendar(trigger.minutes, trigger.title);
    case 'github':
      return trigger.on === 'pr' ? s.pullRequest(trigger.repo) : s.failedRun(trigger.repo, trigger.branch);
    case 'file':
      return s.file(trigger.pattern);
  }
}

/**
 * Whether a schedule needs a look: the last time it came due, it was not sent, or (while it is on)
 * the last check of what it waits for failed.
 */
export function scheduleTrouble(
  s:
    | (Pick<ConversationSchedule, 'lastResult'> & {
        enabled?: boolean;
        watches?: Pick<ScheduleWatch, 'key' | 'error'>[];
        watchError?: boolean;
      })
    | undefined,
): boolean {
  if ((s?.watches?.some((w) => w.error) && s.enabled !== false) || s?.watchError) return true;
  return s?.lastResult === 'missed' || s?.lastResult === 'skipped' || s?.lastResult === 'failed';
}

/**
 * A chat's schedule badge's title: what it does and how it goes, or what is wrong: the last check
 * failed (while it is on), or the last time came due and was not sent.
 */
export function scheduleBadgeTitle(s: ConversationSchedule, t: Messages, lang: string): string {
  const what = describeRepeat(s.repeat, t, lang);
  const failing = s.repeat.kind === 'event' && s.enabled ? combinedWatch(s)?.error : undefined;
  if (failing) return `${what} · ${t.schedule.watch.error(failing)}`;
  if (scheduleTrouble(s) && s.lastResult && s.lastResult !== 'sent' && s.lastResult !== 'queued')
    return `${what} · ${t.schedule.sidebar.problem(t.schedule.results[s.lastResult])}`;
  return `${what} · ${scheduleState(s, t, lang)}`;
}

/**
 * How the checks of what an automation waits for are going: when it was last checked and is checked
 * next, or why the last check failed, or that something new it found waits for the team.
 */
export function watchState(w: ScheduleWatch | undefined, t: Messages, lang: string): string {
  const m = t.schedule.watch;
  if (!w?.checkedAt) return m.notYet;
  if (w.error) return m.error(w.error);
  const checked = `${m.checked(formatWhen(w.checkedAt, lang))} · ${m.nextCheck(formatWhen(w.nextCheckAt, lang))}`;
  const listening = w.listening ? `${checked} · ${m.listening}` : checked;
  return w.held ? `${listening} · ${m.held(w.held)}` : listening;
}

/**
 * How the checks of everything an automation waits for are going, as one (`watchState()` shows it): the
 * first error or held item of any of its triggers, the last check of any, the next check of any, and
 * whether a mail server says when mail arrives; none while a trigger has not been checked yet.
 */
export function combinedWatch(s: Pick<ConversationSchedule, 'repeat' | 'watches'>): ScheduleWatch | undefined {
  if (s.repeat.kind !== 'event') return undefined;
  const watches = s.repeat.triggers.map((tr) => watchOf(s, tr));
  if (watches.length === 1) return watches[0];
  if (!watches.length || watches.some((w) => !w?.checkedAt)) return undefined;
  const all = watches as ScheduleWatch[];
  const error = all.find((w) => w.error)?.error;
  const held = all.find((w) => w.held)?.held;
  return {
    key: '',
    checkedAt: Math.max(...all.map((w) => w.checkedAt!)),
    nextCheckAt: Math.min(...all.map((w) => w.nextCheckAt)),
    ...(error ? { error } : {}),
    ...(held ? { held } : {}),
    ...(all.some((w) => w.listening) ? { listening: true } : {}),
  };
}

/**
 * Each thing an automation waits for, with how its checks are going (`watchState()`): what the
 * automation window lists, one line each, when it waits for several.
 */
export function triggerStates(s: Pick<ConversationSchedule, 'repeat' | 'watches'>, t: Messages, lang: string): string[] {
  if (s.repeat.kind !== 'event') return [];
  return s.repeat.triggers.map((tr) => `${describeTrigger(tr, t)} · ${watchState(watchOf(s, tr), t, lang)}`);
}

/**
 * The automation window's status: what the schedule does and how it goes (`title`), and, for an
 * automation that waits for several things, how each one's checks go, one line each (`lines`, only
 * while it is on: off, the title says paused, and no check comes).
 */
export function scheduleStatus(s: ConversationSchedule, t: Messages, lang: string): { title: string; lines: string[] } {
  const what = describeRepeat(s.repeat, t, lang);
  if (s.repeat.kind !== 'event' || s.repeat.triggers.length < 2) return { title: `${what} · ${scheduleState(s, t, lang)}`, lines: [] };
  return s.enabled ? { title: what, lines: triggerStates(s, t, lang) } : { title: `${what} · ${t.schedule.paused}`, lines: [] };
}

/** The schedule's state in a few words: when it sends next, paused, or (a one-time schedule that came due) done. */
export function scheduleState(s: ConversationSchedule, t: Messages, lang: string): string {
  if (s.repeat.kind === 'manual') return s.enabled ? t.schedule.manualState : t.schedule.paused;
  if (s.repeat.kind === 'event') return s.enabled ? watchState(combinedWatch(s), t, lang) : t.schedule.paused;
  if (s.enabled && s.nextRunAt !== undefined) return t.schedule.next(formatWhen(s.nextRunAt, lang, shownZone(s)));
  const r = s.repeat;
  return r.kind === 'once' && s.lastRunAt !== undefined && s.lastRunAt >= r.at ? t.schedule.finished : t.schedule.paused;
}

/** The sidebar's tooltip for a conversation's schedule. */
export function sidebarScheduleTitle(s: NonNullable<ConversationSummary['schedule']>, t: Messages, lang: string): string {
  if (s.watchError && s.enabled) return t.schedule.sidebar.watchError;
  if (scheduleTrouble(s) && s.lastResult && s.lastResult !== 'sent' && s.lastResult !== 'queued')
    return t.schedule.sidebar.problem(t.schedule.results[s.lastResult]);
  if (s.enabled && s.manual) return t.schedule.sidebar.manual;
  if (s.enabled && s.triggers?.length) return t.schedule.sidebar.watch(describeTriggers(s.triggers, t));
  if (!s.enabled || s.nextRunAt === undefined) return t.schedule.sidebar.paused;
  return t.schedule.sidebar.next(formatWhen(s.nextRunAt, lang, s.timeZone));
}

/**
 * A command that calls a schedule's webhook on the server's computer, with an example body: curl in a
 * POSIX shell, or on Windows PowerShell's own `Invoke-RestMethod` (its `curl` is another command, and
 * cmd.exe takes no single quotes). Single-quoted either way: a token is base64url, which needs no escaping.
 */
export function hookExample(url: string, token: string, platform = ''): string {
  const body = '{"event":"ci-failed","branch":"main"}';
  if (platform === 'win32') {
    return `Invoke-RestMethod -Method Post -Uri '${url}' -Headers @{ Authorization = 'Bearer ${token}' } -ContentType 'application/json' -Body '${body}'`;
  }
  return `curl -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' -d '${body}' '${url}'`;
}

/*
 * A webhook New automation made with the automation ("Create a webhook too"): its token goes from that
 * page to the automation's chat, which opens its drawer to show it there, once. Held in this page's
 * memory only (never in its address or the browser's storage), and forgotten once shown.
 */
const handedHooks = new Map<string, NewScheduleHook>();

/** Hands the chat of `convId` the webhook just made with it. */
export function handOverHook(convId: string, made: NewScheduleHook): void {
  handedHooks.set(convId, made);
}

/** The webhook handed to the chat of `convId`, if any (still there: `forgetHandedHook()` drops it). */
export function handedHook(convId: string): NewScheduleHook | undefined {
  return handedHooks.get(convId);
}

/** Drops it once shown, so the drawer opened again shows no token. */
export function forgetHandedHook(convId: string): void {
  handedHooks.delete(convId);
}

/**
 * An <event> block as the chat shows it. What a trigger found is JSON whose `<` is written `\u003c`
 * for the agents' sake: shown read back, so a sender reads `Ann <ann@example.com>`. A webhook's body
 * is shown as it came.
 */
export function shownEvent(event: string, source?: EventSource): string {
  if (!source || source === 'webhook') return event;
  try {
    return JSON.stringify(JSON.parse(event), null, 2);
  } catch {
    return event;
  }
}

/** The form's schedule as the lead agent's answers are compared with it: what it saves, its files aside. */
export function draftKey(d: ScheduleDraft): string {
  return JSON.stringify({ ...d, files: d.files.map((f) => f.id) });
}

/**
 * The form once the lead agent's schedule is in it: everything it says, the form's files kept (the lead
 * neither reads nor changes them). A trigger whose account the user is to pick keeps its source's fields.
 */
export function draftedForm(d: ScheduleDraft, update: ScheduleUpdate, now: number): ScheduleDraft {
  const next = draftFrom({ ...update, lang: 'en', updatedAt: now }, now, update.timeZone);
  // Every kind's fields are kept (switching kinds and back loses nothing): only the kind drafted changes.
  return {
    ...d,
    text: next.text,
    kind: next.kind,
    ...(next.kind === 'once' ? { at: next.at } : {}),
    ...(next.kind === 'daily' || next.kind === 'weekly' ? { time: next.time } : {}),
    ...(next.kind === 'weekly' ? { days: next.days } : {}),
    ...(next.kind === 'interval' ? { hours: next.hours } : {}),
    ...(next.kind === 'event' ? { triggers: next.triggers } : {}),
    timeZone: next.timeZone,
    enabled: next.enabled,
    approvals: next.approvals,
    missed: next.missed,
    newChat: next.newChat,
    goal: next.goal,
  };
}

/** What the lead agent changed in the form, a line each, as listed under its note. */
export function scheduleChanges(before: ScheduleDraft, after: ScheduleDraft, t: Messages, lang: string): string[] {
  const c = t.scheduleDraft.change;
  const out: string[] = [];
  if (after.text.trim() !== before.text.trim()) out.push(c.text);
  if (JSON.stringify(repeatOf(after)) !== JSON.stringify(repeatOf(before)) || after.kind !== before.kind) {
    out.push(c.when(describeRepeat(repeatOf(after), t, lang)));
  }
  if (after.goal.trim() !== before.goal.trim()) out.push(after.goal.trim() ? c.goal : c.goalRemoved);
  if (after.newChat !== before.newChat) out.push(after.newChat ? c.newChatOn : c.newChatOff);
  if (after.missed !== before.missed) out.push(after.missed === 'run' ? c.missedRun : c.missedSkip);
  if (after.approvals !== before.approvals) out.push(after.approvals === 'ask' ? c.approvalsAsk : c.approvalsDeny);
  if (
    after.kind === 'event' &&
    after.triggers.some((tr) => (tr.source === 'mail' && !tr.account) || (tr.source === 'calendar' && !tr.calendar))
  )
    out.push(c.pickAccount);
  return out;
}

/** The schedule form for a schedule an agent proposed (`ScheduleProposal`), in this browser's time zone, to change before saving. */
export function proposalDraft(p: ScheduleProposal, now: number, timeZone = browserTimeZone()): ScheduleDraft {
  return draftedForm(draftFrom(undefined, now, timeZone), proposalUpdate(p, timeZone), now);
}
