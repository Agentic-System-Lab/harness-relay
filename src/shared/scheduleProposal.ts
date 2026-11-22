import { filePattern, mailFolder, parseTime, repoName, validBranch, validRepo, zonedTime } from './schedule';
import {
  SCHEDULE_KINDS,
  SCHEDULE_LIMITS,
  WATCH_LIMITS,
  type ScheduleProposal,
  type ScheduleProposalRepeat,
  type ScheduleRepeat,
  type ScheduleTrigger,
  type ScheduleUpdate,
} from './types';

/*
 * A schedule an agent proposes in a reply, when the user asks for something to be done at set times or
 * whenever something happens. The agent writes one block on lines of its own,
 *
 *   <schedule>{"text": "…", "repeat": {"kind": "weekly", "time": "09:00", "days": [1, 2, 3, 4, 5]}}</schedule>
 *
 * which is taken out of the reply's text: the chat shows a card instead, from which the user creates
 * the schedule (as it is, or once changed in the schedule's form) or dismisses it. Nothing is
 * scheduled until then. Pure, shared by the server and the UI.
 */

const OPEN = '<schedule>';
const CLOSE = '</schedule>';

/** A once time as the block gives it: the user's wall-clock date and time. */
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;

/** The day names an agent may write for a weekly schedule's days (0 = Sunday). */
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Where each block is in `text`: from its opening tag to the end of its closing one, with the code
 * fence around it when it is alone in one. Read once from the start, so that a reply full of opening
 * tags takes time in proportion to its size. A block that is not closed (still being written) is left.
 */
function blocks(text: string): { start: number; end: number; body: string }[] {
  const lower = text.toLowerCase();
  const out: { start: number; end: number; body: string }[] = [];
  let from = 0;
  for (;;) {
    const open = lower.indexOf(OPEN, from);
    if (open < 0) break;
    const close = lower.indexOf(CLOSE, open + OPEN.length);
    if (close < 0) break;
    let start = open;
    let end = close + CLOSE.length;
    // Alone in a code fence the agent wrapped it in: the fence goes too.
    const before = /```[^\n`]*\n[ \t]*$/.exec(text.slice(Math.max(0, open - 200), open));
    const after = /^[ \t]*\n[ \t]*```[ \t]*(?=\n|$)/.exec(text.slice(end, end + 200));
    if (before && after) {
      start = open - before[0].length;
      end += after[0].length;
    }
    out.push({ start, end, body: text.slice(open + OPEN.length, close) });
    from = close + CLOSE.length;
  }
  return out;
}

/**
 * A reply's text without its `<schedule>` blocks, and the schedule the last usable one proposes. A
 * reply whose blocks are all unusable keeps its text as it is, so that the agent's mistake shows.
 */
export function splitSchedule(text: string): { text: string; proposal?: ScheduleProposal } {
  const found = blocks(text);
  if (!found.length) return { text };
  let proposal: ScheduleProposal | undefined;
  for (const b of found) proposal = readProposal(parseJson(b.body)) ?? proposal;
  if (!proposal) return { text };
  let out = '';
  let at = 0;
  for (const b of found) {
    out += text.slice(at, b.start);
    at = b.end;
  }
  out += text.slice(at);
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), proposal };
}

/** A reply's text as it streams: its finished `<schedule>` blocks, and one still being written at its end, left out. */
export function withoutScheduleBlocks(text: string): string {
  const found = blocks(text);
  let out = '';
  let at = 0;
  for (const b of found) {
    out += text.slice(at, b.start);
    at = b.end;
  }
  const rest = text.slice(at);
  const open = rest.toLowerCase().indexOf(OPEN);
  out += open >= 0 ? rest.slice(0, open) : rest;
  // The start of an opening tag that has not all come yet.
  return out.replace(/<(?:s(?:c(?:h(?:e(?:d(?:u(?:l(?:e)?)?)?)?)?)?)?)?$/i, '');
}

function parseJson(body: string): unknown {
  const trimmed = body
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

const line = (v: unknown, max: number): string | undefined => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || /[\r\n\0]/.test(v)) return undefined;
  const s = v.trim();
  return s.length > max ? undefined : s;
};

/** A trigger as a block gives it; a mail or calendar account it names is kept to be checked later, or `''`. */
function readTrigger(raw: unknown): ScheduleTrigger | undefined {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const account = typeof r.account === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(r.account.trim()) ? r.account.trim() : '';
  switch (r.source) {
    case 'mail': {
      const folder = line(r.folder, WATCH_LIMITS.field);
      const from = line(r.from, WATCH_LIMITS.field);
      const subject = line(r.subject, WATCH_LIMITS.field);
      if (folder === undefined || from === undefined || subject === undefined) return undefined;
      return { source: 'mail', account, folder: mailFolder(folder || 'INBOX'), ...(from ? { from } : {}), ...(subject ? { subject } : {}) };
    }
    case 'calendar': {
      const minutes = Number(r.minutes ?? 10);
      const title = line(r.title, WATCH_LIMITS.field);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > WATCH_LIMITS.maxMinutes || title === undefined) return undefined;
      return { source: 'calendar', account, minutes, ...(title ? { title } : {}) };
    }
    case 'github': {
      const repo = repoName(line(r.repo, WATCH_LIMITS.field) ?? '');
      const on = r.on === 'ci' ? 'ci' : r.on === 'pr' || r.on === undefined ? 'pr' : undefined;
      const branch = on === 'ci' ? line(r.branch, WATCH_LIMITS.field) : '';
      if (!validRepo(repo) || !on || branch === undefined || (branch && !validBranch(branch))) return undefined;
      return { source: 'github', repo, on, ...(branch ? { branch } : {}) };
    }
    case 'file': {
      const pattern = filePattern(line(r.pattern, WATCH_LIMITS.field) ?? '');
      return pattern ? { source: 'file', pattern } : undefined;
    }
    default:
      return undefined;
  }
}

function readRepeat(raw: unknown): ScheduleProposalRepeat | undefined {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = r.kind as ScheduleRepeat['kind'];
  if (!SCHEDULE_KINDS.includes(kind)) return undefined;
  const time = typeof r.time === 'string' && parseTime(r.time.trim()) ? r.time.trim() : undefined;
  switch (kind) {
    case 'manual':
      return { kind };
    case 'once': {
      const at = typeof r.at === 'string' ? r.at.trim() : '';
      return LOCAL_RE.test(at) ? { kind, at: at.replace(' ', 'T') } : undefined;
    }
    case 'daily':
      return time ? { kind, time } : undefined;
    case 'weekly': {
      const listed = Array.isArray(r.days) ? r.days : [];
      const days = listed.map((d) =>
        typeof d === 'number' ? d : typeof d === 'string' ? DAY_NAMES.indexOf(d.trim().slice(0, 3).toLowerCase()) : -1,
      );
      if (!time || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return undefined;
      return { kind, time, days: [...new Set(days)].sort((a, b) => a - b) };
    }
    case 'interval': {
      const hours = Number(r.hours);
      return Number.isInteger(hours) && hours >= 1 && hours <= SCHEDULE_LIMITS.maxHours ? { kind, hours } : undefined;
    }
    case 'event': {
      const listed = Array.isArray(r.triggers) ? r.triggers : [];
      if (!listed.length || listed.length > WATCH_LIMITS.triggers) return undefined;
      const triggers = listed.map(readTrigger);
      return triggers.every((t): t is ScheduleTrigger => Boolean(t)) ? { kind, triggers } : undefined;
    }
  }
}

/** The schedule a block proposes, or undefined when it proposes none that could be made. */
export function readProposal(raw: unknown): ScheduleProposal | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  if (!text || text.length > SCHEDULE_LIMITS.maxText) return undefined;
  const repeat = readRepeat(r.repeat);
  if (!repeat) return undefined;
  const goal = typeof r.goal === 'string' ? r.goal.trim().slice(0, SCHEDULE_LIMITS.maxGoal) : '';
  return {
    text,
    repeat,
    ...(goal ? { goal } : {}),
    ...(r.newChat === true ? { newChat: true } : {}),
    ...(r.missed === 'run' ? { missed: 'run' as const } : {}),
  };
}

/** A once time (`YYYY-MM-DDTHH:MM`) in a time zone, or undefined when it is not a real date and time. */
export function localMoment(at: string, timeZone: string): number | undefined {
  const m = LOCAL_RE.exec(at);
  if (!m) return undefined;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return undefined;
  const ms = zonedTime(year, month, day, hour, minute, timeZone);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The schedule to save from a proposal, in the user's time zone: on, refusing approvals in its runs
 * (the default), its once time turned into an instant (0, which no schedule takes, when it is not one).
 */
export function proposalUpdate(p: ScheduleProposal, timeZone: string): ScheduleUpdate {
  const repeat: ScheduleRepeat = p.repeat.kind === 'once' ? { kind: 'once', at: localMoment(p.repeat.at, timeZone) ?? 0 } : p.repeat;
  return {
    text: p.text,
    repeat,
    timeZone,
    enabled: true,
    approvals: 'deny',
    missed: p.missed ?? 'skip',
    newChat: Boolean(p.newChat),
    ...(p.goal ? { goal: p.goal } : {}),
  };
}

/** What keeps a proposal from being made as it is (the schedule's form can still take it): its once time passed, a trigger needs an account. */
export function proposalGaps(p: ScheduleProposal, timeZone: string, now: number): ('past' | 'account')[] {
  const gaps: ('past' | 'account')[] = [];
  if (p.repeat.kind === 'once' && (localMoment(p.repeat.at, timeZone) ?? 0) <= now) gaps.push('past');
  if (p.repeat.kind === 'event' && p.repeat.triggers.some((t) => (t.source === 'mail' || t.source === 'calendar') && !t.account))
    gaps.push('account');
  return gaps;
}
