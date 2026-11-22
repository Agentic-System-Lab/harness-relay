import { createHash } from 'node:crypto';
import { HttpError } from './errors';
import type { AttachmentData, AttachmentPart } from './attachments';
import type {
  AgentConfig,
  AgentSessionState,
  AgentWorktree,
  FileChange,
  MessageChanges,
  ChatMessage,
  Conversation,
  BranchPart,
  ConversationBranch,
  ConversationGroup,
  ConversationSchedule,
  ConversationSummary,
  AlertKind,
  InboxItem,
  InboxReadRequest,
  InboxSummary,
  Lang,
  LeadReview,
  CheckList,
  ConversationSettings,
  ChecksResult,
  MessagePart,
  Mode,
  Permission,
  ProgressStatus,
  Provider,
  RunPause,
  TrackedRun,
  ScheduleHook,
  ScheduleRepeat,
  ScheduleResult,
  ScheduleTracking,
  ScheduleWatch,
  TeamPlan,
  TeamPreset,
  ToolCallKind,
  ToolStatus,
  MessageStatus,
  SearchResult,
  SharedPage,
} from '../shared/types';
import {
  ALERT_KINDS,
  ATTACHMENT_LIMITS,
  PERMISSION_ORDER,
  PROGRESS_STATUSES,
  PROVIDERS,
  TOOL_CALL_KINDS,
  TRIGGER_SOURCES,
  agentLimitsFor,
  cwdSettings,
  pendingPlan,
  type ScheduleTrigger,
} from '../shared/types';
import { byAge, familyOf, type FamilyMember } from '../shared/family';
import { mailFolder, triggerKey, watchOf } from '../shared/schedule';
import { searchTerms, snippetAround, termsIn } from '../shared/search';
import { nul, transaction, type Database } from './db';
import { reviewText } from '../shared/review';
import { currentLang, t } from './i18n';
import { overallStatus } from '../shared/checks';
import { builtinPresets } from './presets';

interface ShareRow {
  id: string;
  conversation_id: string;
  title: string;
  up_to_message_id: string | null;
  up_to_agent: string | null;
  url: string;
  gist_url: string;
  created_at: number;
  files: number;
  files_gist: string | null;
  unfinished: number;
  /** How many conversations have its conversation's id: 0 once it was deleted. */
  live: number;
}

/** How many notifications the inbox keeps: past them, the oldest go. */
export const INBOX_KEPT = 200;

interface NotificationRow {
  id: string;
  conversation_id: string;
  title: string;
  kind: string;
  agent: string | null;
  text: string | null;
  created_at: number;
  read_at: number | null;
}

/** A share with whether its conversation is still there. */
const SHARE_SELECT = 'SELECT s.*, (SELECT COUNT(*) FROM conversations c WHERE c.id = s.conversation_id) AS live FROM shares s';

function shareFromRow(r: ShareRow): SharedPage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    title: r.title,
    ...(r.up_to_message_id ? { upTo: { messageId: r.up_to_message_id, agentName: r.up_to_agent ?? '' } } : {}),
    url: r.url,
    gistUrl: r.gist_url,
    createdAt: r.created_at,
    ...(r.live ? {} : { conversationGone: true }),
    ...(r.files ? { files: r.files } : {}),
    ...(r.files_gist ? { filesGist: r.files_gist } : {}),
    ...(r.unfinished ? { unfinished: true } : {}),
  };
}

interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  mode: Mode;
  rounds: number;
  max_hops: number;
  permission: Permission;
  cwd: string;
  extra_cwds: string | null;
  auto_team: number;
  auto_confirm: number;
  lead_review: number;
  approvals: string | null;
  steer: number;
  checks: string | null;
  allow_rules: string | null;
  queue: string | null;
  pause: string | null;
  branch: string | null;
}

interface AgentRow {
  agent_id: string;
  name: string;
  provider: Provider;
  role: string;
  model: string | null;
  effort: string | null;
  tools: string | null;
  account: string | null;
  limits: string | null;
}

interface MessageRow {
  id: string;
  author_kind: 'user' | 'agent' | 'system';
  agent_id: string | null;
  agent_name: string | null;
  provider: Provider | null;
  created_at: number;
  status: MessageStatus;
  passed: number;
  error: string | null;
  round: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  change_root: string | null;
  change_base: string | null;
  change_head: string | null;
  change_isolated: number | null;
  change_branch: string | null;
  more_changes: string | null;
  plan: string | null;
  review: string | null;
  checks: string | null;
  queued: number | null;
  steered: string | null;
  auto_fix: string | null;
  asked: number | null;
  scheduled: number | null;
  tracked: string | null;
  event: string | null;
  event_source: string | null;
}

interface ScheduleRow {
  conversation_id: string;
  text: string;
  repeat: string;
  time_zone: string;
  lang: Lang;
  enabled: number;
  approvals: string;
  missed: string;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_result: ScheduleResult | null;
  last_error: string | null;
  new_chat: number;
  last_chat_id: string | null;
  goal: string | null;
  tracking: string | null;
  hook: string | null;
  watch: string | null;
}

interface ChangeRow {
  message_id: string;
  path: string;
  status: FileChange['status'];
  added: number | null;
  deleted: number | null;
}

interface PartRow {
  message_id: string;
  type: MessagePart['type'];
  text: string | null;
  tool_id: string | null;
  tool_name: string | null;
  tool_detail: string | null;
  tool_status: ToolStatus | null;
  tool_error: string | null;
  tool_output: string | null;
  /** JSON: plan entries, or the approval request. */
  data: string | null;
}

/** A member's record per CLI (`agent_sessions.by_cli`): only known CLIs and permissions are kept. */
function byCliOf(json: string | null): AgentSessionState['byCli'] {
  const raw = parseJson<Record<string, { permission?: unknown; home?: unknown; mustEmpty?: unknown }>>(json, {});
  const out: NonNullable<AgentSessionState['byCli']> = {};
  for (const p of PROVIDERS) {
    const e = raw[p];
    const permission = PERMISSION_ORDER.find((x) => x === e?.permission);
    if (!permission) continue;
    out[p] = {
      permission,
      ...(typeof e?.home === 'string' && e.home ? { home: e.home } : {}),
      ...(e?.mustEmpty === true ? { mustEmpty: true } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

function toAgent(r: AgentRow): AgentConfig {
  const agent: AgentConfig = {
    id: r.agent_id,
    name: r.name,
    provider: r.provider,
    role: r.role,
    model: opt(r.model),
    effort: opt(r.effort),
  };
  const tools = parseTools(r.tools);
  if (tools) agent.tools = tools;
  if (r.account) agent.account = r.account;
  const limits = agentLimitsFor(r.provider, parseJson<unknown>(r.limits, undefined));
  if (limits) agent.limits = limits;
  return agent;
}

/** An agent's tool exceptions as stored (JSON), or undefined when it has none. */
function parseTools(json: string | null): Record<string, boolean> | undefined {
  if (!json) return undefined;
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out = Object.fromEntries(Object.entries(v).filter(([, on]) => typeof on === 'boolean')) as Record<string, boolean>;
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

function toolsJson(a: AgentConfig): string | null {
  return a.tools && Object.keys(a.tools).length ? JSON.stringify(a.tools) : null;
}

/** A member's limits as stored (JSON: `AgentLimits`), only those its CLI has; null when it has none. */
function limitsJson(a: AgentConfig): string | null {
  const limits = agentLimitsFor(a.provider, a.limits);
  return limits ? JSON.stringify(limits) : null;
}

type ToolData = Pick<Extract<MessagePart, { type: 'tool' }>, 'kind' | 'parentId' | 'agent' | 'model'>;

/**
 * What a tool part keeps in its `data` column: its kind (one this server does not know is dropped), the
 * call a subagent made it under, and a subagent's name and model, when it has them.
 */
function toolData(json: string | null): ToolData {
  const data = parseJson<unknown>(json, {});
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const kind = typeof d.kind === 'string' && (TOOL_CALL_KINDS as readonly string[]).includes(d.kind) ? (d.kind as ToolCallKind) : undefined;
  const out: ToolData = {};
  if (kind) out.kind = kind;
  for (const key of ['parentId', 'agent', 'model'] as const) {
    const v = text(d[key]);
    if (v) out[key] = v;
  }
  return out;
}

/** A tool part's `data` column (`toolData()` reads it back), or null when it has none of it. */
function toolDataJson(p: Extract<MessagePart, { type: 'tool' }>): string | null {
  const data: ToolData = {
    ...(p.kind ? { kind: p.kind } : {}),
    ...(p.parentId ? { parentId: p.parentId } : {}),
    ...(p.agent ? { agent: p.agent } : {}),
    ...(p.model ? { model: p.model } : {}),
  };
  return Object.keys(data).length ? JSON.stringify(data) : null;
}

function toPart(r: PartRow): MessagePart {
  switch (r.type) {
    case 'tool':
      return {
        type: 'tool',
        id: r.tool_id ?? '',
        name: r.tool_name ?? 'tool',
        detail: opt(r.tool_detail),
        ...toolData(r.data),
        status: r.tool_status ?? 'done',
        ...(r.tool_error ? { error: r.tool_error } : {}),
        ...(r.tool_output ? { output: r.tool_output } : {}),
      };
    case 'thinking':
      return { type: 'thinking', text: r.text ?? '' };
    case 'plan':
      return { type: 'plan', entries: parseJson(r.data, []) };
    case 'approval':
      return { type: 'approval', ...parseJson(r.data, { id: '', kind: 'other' as const, status: 'expired' as const }) };
    case 'attachment':
      return { type: 'attachment', ...parseJson(r.data, { id: '', name: 'file', mimeType: 'application/octet-stream', size: 0 }) };
    case 'outbox':
      return {
        type: 'outbox',
        ...parseJson(r.data, { id: '', tool: '', title: '', preview: { fields: [] }, status: 'failed' as const }),
      };
    case 'notice':
      return { type: 'notice', text: r.text ?? '' };
    case 'progress': {
      const status = parseJson<{ status?: unknown }>(r.data, {}).status;
      return {
        type: 'progress',
        status: PROGRESS_STATUSES.includes(status as never) ? (status as ProgressStatus) : 'working',
        text: r.text ?? '',
      };
    }
    default:
      return { type: 'text', text: r.text ?? '' };
  }
}

/** Columns of one part: text, tool_id, tool_name, tool_detail, tool_status, tool_error, tool_output, data. */
function partColumns(p: MessagePart): (string | null)[] {
  switch (p.type) {
    case 'text':
    case 'thinking':
    case 'notice':
      return [p.text, null, null, null, null, null, null, null];
    case 'tool':
      return [null, p.id, p.name, nul(p.detail), p.status, nul(p.error), nul(p.output), toolDataJson(p)];
    case 'plan':
      return [null, null, null, null, null, null, null, JSON.stringify(p.entries)];
    case 'progress':
      return [p.text, null, null, null, null, null, null, JSON.stringify({ status: p.status })];
    case 'approval':
    case 'attachment':
    case 'outbox': {
      const { type: _type, ...data } = p;
      return [null, null, null, null, null, null, null, JSON.stringify(data)];
    }
  }
}

function toChanges(r: MessageRow, files: FileChange[]): MessageChanges[] | undefined {
  if (!r.change_root || !r.change_base || !r.change_head) return undefined;
  const first: MessageChanges = {
    root: r.change_root,
    base: r.change_base,
    head: r.change_head,
    files,
    isolated: Boolean(r.change_isolated),
    branch: opt(r.change_branch),
  };
  return [first, ...moreChanges(r.more_changes)];
}

/** The changes in the repositories after the first (`more_changes`), leaving out any that cannot be read. */
function moreChanges(json: string | null): MessageChanges[] {
  const list = parseJson<unknown>(json, []);
  if (!Array.isArray(list)) return [];
  return list.filter(
    (c): c is MessageChanges =>
      Boolean(c) &&
      typeof c.root === 'string' &&
      typeof c.base === 'string' &&
      typeof c.head === 'string' &&
      Array.isArray(c.files) &&
      typeof c.isolated === 'boolean',
  );
}

/** A conversation's working directories after the first (`extra_cwds`), leaving out what cannot be read. */
function extraCwdsOf(json: string | null): string[] {
  const list = parseJson<unknown>(json, []);
  return Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string' && d.length > 0) : [];
}

/** Whether a message's `event_source` names what a trigger found (absent, or anything else: the webhook). */
function isTriggerSource(v: string | null): v is ScheduleTrigger['source'] {
  return (TRIGGER_SOURCES as (string | null)[]).includes(v);
}

function toMessage(r: MessageRow, parts: MessagePart[], files: FileChange[]): ChatMessage {
  const meta = {
    round: opt(r.round),
    durationMs: opt(r.duration_ms),
    costUsd: opt(r.cost_usd),
    inputTokens: opt(r.input_tokens),
    outputTokens: opt(r.output_tokens),
  };
  const hasMeta = Object.values(meta).some((v) => v !== undefined);
  return {
    id: r.id,
    author: r.author_kind === 'agent' ? { kind: 'agent', agentId: r.agent_id ?? '' } : { kind: r.author_kind },
    createdAt: r.created_at,
    parts,
    status: r.status,
    passed: r.passed ? true : undefined,
    error: opt(r.error),
    meta: hasMeta ? meta : r.author_kind === 'agent' ? {} : undefined,
    agentName: opt(r.agent_name),
    provider: opt(r.provider),
    changes: toChanges(r, files),
    plan: parsePlan(r.plan),
    review: parseReview(r.review),
    ...checksOf(r.checks),
    queued: r.queued ? true : undefined,
    ...steeredOf(r.steered),
    ...autoFixOf(r.auto_fix),
    asked: r.asked ? true : undefined,
    scheduled: r.scheduled ? true : undefined,
    ...(r.event ? { event: r.event } : {}),
    ...(r.event && isTriggerSource(r.event_source) ? { eventSource: r.event_source } : {}),
    ...trackedOf(r.tracked),
  };
}

function toSchedule(r: ScheduleRow): ConversationSchedule | undefined {
  const repeat = parseRepeat(r.repeat);
  if (!repeat) return undefined;
  const tracking = parseTracking(r.tracking);
  const hook = parseHook(r.hook);
  const watches = repeat.kind === 'event' ? parseWatches(r.watch, repeat.triggers) : undefined;
  return {
    text: r.text,
    repeat,
    timeZone: r.time_zone,
    lang: r.lang,
    enabled: Boolean(r.enabled),
    approvals: r.approvals === 'ask' ? 'ask' : 'deny',
    missed: r.missed === 'run' ? 'run' : 'skip',
    newChat: Boolean(r.new_chat),
    updatedAt: r.updated_at,
    ...(r.next_run_at !== null ? { nextRunAt: r.next_run_at } : {}),
    ...(r.last_run_at !== null ? { lastRunAt: r.last_run_at } : {}),
    ...(r.last_result ? { lastResult: r.last_result } : {}),
    ...(r.last_error ? { lastError: r.last_error } : {}),
    ...(r.last_chat_id ? { lastChatId: r.last_chat_id } : {}),
    ...(r.goal ? { goal: r.goal } : {}),
    ...(r.goal && tracking ? { tracking } : {}),
    ...(hook ? { hook } : {}),
    ...(watches ? { watches } : {}),
  };
}

/**
 * A schedule's times as stored, when they can be read. An automation saved before it could wait for
 * several things kept its one trigger as `trigger`: it is read as the only one of `triggers`. One saved
 * since keeps both (`storedRepeat()`), and `triggers` is what this version reads. A mail folder kept as
 * the inbox in another letter case is read as `INBOX` (`mailFolder()`), and a trigger that waits for
 * what an earlier one does is left out; one that waits for nothing it can read cannot be read.
 */
function parseRepeat(json: string | null): ScheduleRepeat | undefined {
  const r = parseJson<(ScheduleRepeat & { trigger?: unknown; triggers?: unknown }) | null>(json, null);
  if (!r || typeof r !== 'object') return undefined;
  if (r.kind !== 'event') return r;
  const listed: unknown[] = Array.isArray(r.triggers) ? r.triggers : r.trigger ? [r.trigger] : [];
  const keys = new Set<string>();
  const triggers = listed.flatMap((t): ScheduleTrigger[] => {
    if (!t || typeof t !== 'object' || !(TRIGGER_SOURCES as unknown[]).includes((t as { source?: unknown }).source)) return [];
    const tr = t as ScheduleTrigger;
    const read = tr.source === 'mail' ? { ...tr, folder: typeof tr.folder === 'string' ? mailFolder(tr.folder) : 'INBOX' } : tr;
    let key: string;
    try {
      key = triggerKey(read);
    } catch {
      return []; // its fields cannot be read
    }
    if (keys.has(key)) return [];
    keys.add(key);
    return [read];
  });
  return triggers.length ? { kind: 'event', triggers } : undefined;
}

/**
 * A schedule's times as they are written: an automation that starts when something happens keeps its
 * first trigger as `trigger` too, beside `triggers`, which a version from before it could wait for
 * several things reads (as waiting for that one, its checks starting afresh: it reads no object in
 * `watch`). Browsers get `triggers` only.
 */
function storedRepeat(r: ScheduleRepeat): string {
  return JSON.stringify(r.kind === 'event' ? { ...r, trigger: r.triggers[0] } : r);
}

/** A kept watch's key as `triggerKey()` writes it now: one from when the inbox's letter case still counted names `INBOX`. */
function currentKey(key: string): string {
  const k = parseJson<unknown>(key, null);
  return Array.isArray(k) && k.length === 3 && k[0] === 'mail' && typeof k[2] === 'string'
    ? JSON.stringify([k[0], k[1], mailFolder(k[2])])
    : key;
}

/**
 * What an automation that starts when something happens kept of each trigger's source, when it can be
 * read: one for each of its triggers that has one, in their order. One kept before an automation could
 * wait for several things (a single object) is its one trigger's.
 */
function parseWatches(json: string | null, triggers: ScheduleTrigger[]): ScheduleWatch[] | undefined {
  const v = parseJson<unknown>(json, null);
  const kept = (Array.isArray(v) ? v : v ? [v] : [])
    .filter(
      (w): w is ScheduleWatch =>
        Boolean(w) &&
        typeof w === 'object' &&
        typeof (w as ScheduleWatch).key === 'string' &&
        typeof (w as ScheduleWatch).nextCheckAt === 'number',
    )
    .map((w) => {
      const key = currentKey(w.key);
      return key === w.key ? w : { ...w, key };
    });
  const watches = triggers.flatMap((t) => watchOf({ watches: kept }, t) ?? []);
  return watches.length ? watches : undefined;
}

/** A schedule's tracking state as stored, when it can be read. */
function parseTracking(json: string | null): ScheduleTracking | undefined {
  const t = parseJson<ScheduleTracking | null>(json, null);
  if (!t || typeof t !== 'object' || !Array.isArray(t.notes)) return undefined;
  return { ...t, status: PROGRESS_STATUSES.includes(t.status) ? t.status : 'working' };
}

function parseHook(json: string | null): ScheduleHook | undefined {
  const h = parseJson<ScheduleHook | null>(json, null);
  return h && typeof h === 'object' && typeof h.createdAt === 'number' ? h : undefined;
}

/** What the sidebar shows of a schedule; times of day are shown in the schedule's time zone. */
function scheduleSummary(
  s: Pick<ConversationSchedule, 'enabled' | 'nextRunAt' | 'lastResult' | 'timeZone' | 'watches'> & { repeat?: ScheduleRepeat },
): ConversationSummary['schedule'] {
  const ofDay = s.repeat?.kind === 'daily' || s.repeat?.kind === 'weekly';
  return {
    enabled: s.enabled,
    ...(s.nextRunAt !== undefined ? { nextRunAt: s.nextRunAt } : {}),
    ...(s.lastResult ? { lastResult: s.lastResult } : {}),
    ...(ofDay ? { timeZone: s.timeZone } : {}),
    ...(s.repeat?.kind === 'manual' ? { manual: true } : {}),
    ...(s.repeat?.kind === 'event' ? { triggers: s.repeat.triggers } : {}),
    ...(s.repeat?.kind === 'event' && s.enabled && s.watches?.some((w) => w.error) ? { watchError: true } : {}),
  };
}

/** The latest agent reply's id and status, from memory when the conversation is open (it may be streaming). */
function statusOf(
  live: Conversation | undefined,
  stored: { id: string; status: MessageStatus; blocked?: boolean } | undefined,
): Pick<ConversationSummary, 'lastStatus' | 'lastReplyId' | 'blocked'> {
  const reply = live ? [...live.messages].reverse().find((m) => m.author.kind === 'agent') : undefined;
  const last = reply ?? (live ? undefined : stored);
  if (!last) return {};
  // A finished reply whose tracked goal it says is held up needs the user (`blocked`).
  const blocked = reply ? reply.parts.some((p) => p.type === 'progress' && p.status === 'blocked') : Boolean(stored?.blocked);
  return { lastStatus: last.status, lastReplyId: last.id, ...(blocked && last.status !== 'streaming' ? { blocked: true } : {}) };
}

/**
 * The waiting messages. A message is posted (saved as a message) before it leaves the queue, so one
 * that is in both was delivered just before the server died: it counts as delivered.
 */
function queueOf(json: string | null, messages: ChatMessage[]): Pick<Conversation, 'queue'> {
  if (!json) return {};
  const posted = new Set(messages.map((m) => m.id));
  const queue = parseJson<ChatMessage[]>(json, []).filter((m) => !posted.has(m.id));
  return queue.length ? { queue } : {};
}

/** The sidebar's view of a conversation's schedule, from memory when the conversation is open. */
function scheduleOf(live: Conversation | undefined, stored: ConversationSummary['schedule']): Pick<ConversationSummary, 'schedule'> {
  const schedule = live ? live.schedule && scheduleSummary(live.schedule) : stored;
  return schedule ? { schedule } : {};
}

/** A message's `tracked` run (JSON), when it has a sound one. */
function trackedOf(json: string | null): Pick<ChatMessage, 'tracked'> {
  const t = parseJson<Partial<TrackedRun> | null>(json, null);
  return t && typeof t.sourceId === 'string' && typeof t.due === 'number' && typeof t.attempt === 'number'
    ? { tracked: { sourceId: t.sourceId, due: t.due, attempt: t.attempt, retries: Boolean(t.retries) } }
    : {};
}

function pauseOf(json: string | null): Pick<Conversation, 'pause'> {
  const pause = parseJson<RunPause | null>(json, null);
  return pause ? { pause } : {};
}

/** Copied messages of a branch and where they were written (`BranchPart`); undefined when unreadable. */
function partOf(b: Partial<BranchPart> | null | undefined): BranchPart | undefined {
  if (typeof b?.fromId !== 'string' || typeof b.afterId !== 'string') return undefined;
  const via = Array.isArray(b.via)
    ? b.via.filter((v): v is { id: string; title: string } => typeof v?.id === 'string' && typeof v.title === 'string')
    : [];
  return {
    fromId: b.fromId,
    fromTitle: typeof b.fromTitle === 'string' ? b.fromTitle : '',
    afterId: b.afterId,
    ...(via.length ? { via: via.map((v) => ({ id: v.id, title: v.title })) } : {}),
  };
}

/** Where a branched conversation comes from; one that cannot be read is left out, as are unreadable earlier parts. */
function branchOf(json: string | null): Pick<Conversation, 'branch'> {
  const b = parseJson<Partial<ConversationBranch> | null>(json, null);
  const main = partOf(b);
  if (!main) return {};
  const earlier = Array.isArray(b?.earlier) ? b.earlier.map(partOf).filter((p) => p !== undefined) : [];
  return { branch: { ...main, ...(earlier.length ? { earlier } : {}) } };
}

/**
 * A part of a branch's copied messages whose line up ends in `deleted`, once that one is deleted:
 * where the deleted one came from goes after it (see `BranchPart.via`), so the family stays together.
 * Undefined when nothing changes.
 */
function partPast<P extends BranchPart>(part: P, deleted: { id: string; title: string; branch?: ConversationBranch }): P | undefined {
  const via = part.via ?? [];
  if ((via.at(-1)?.id ?? part.fromId) !== deleted.id) return undefined;
  const above = deleted.branch ? [{ id: deleted.branch.fromId, title: deleted.branch.fromTitle }, ...(deleted.branch.via ?? [])] : [];
  // A deleted one further up keeps the title it had then.
  const kept = via.length ? [...via.slice(0, -1), { id: deleted.id, title: deleted.title }] : [];
  const next = [...kept, ...above];
  return next.length ? { ...part, via: next } : undefined;
}

/**
 * The branch of a conversation once `deleted` is deleted: each of its parts whose line up ends there
 * learns where the deleted one came from (`partPast`). Undefined when nothing changes.
 */
function branchPast(
  branch: ConversationBranch,
  deleted: { id: string; title: string; branch?: ConversationBranch },
): ConversationBranch | undefined {
  const main = partPast(branch, deleted);
  const earlier = branch.earlier?.map((p) => partPast(p, deleted));
  if (!main && !earlier?.some(Boolean)) return undefined;
  return {
    ...(main ?? branch),
    ...(earlier ? { earlier: earlier.map((p, i) => p ?? branch.earlier![i]!) } : {}),
  };
}

function parsePlan(json: string | null): TeamPlan | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as TeamPlan;
  } catch {
    return undefined;
  }
}

function parseReview(json: string | null): LeadReview | undefined {
  const review = parseJson<LeadReview | null>(json, null);
  return review && typeof review === 'object' ? review : undefined;
}

/** The members whose running turn a user message went into (`ChatMessage.steered`, steering). */
function steeredOf(json: string | null): Pick<ChatMessage, 'steered'> {
  const ids = parseJson<unknown>(json, null);
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  return list.length ? { steered: list } : {};
}

/** Which automatic fix of the team checks a user message Relay sent is (`ChatMessage.autoFix`). */
function autoFixOf(json: string | null): Pick<ChatMessage, 'autoFix'> {
  const fix = parseJson<{ attempt?: unknown; of?: unknown } | null>(json, null);
  const n = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
  return fix && typeof fix === 'object' && n(fix.attempt) && n(fix.of)
    ? { autoFix: { attempt: fix.attempt as number, of: fix.of as number } }
    : {};
}

/** A system message's team checks result (`ChatMessage.checks`). */
function checksOf(json: string | null): Pick<ChatMessage, 'checks'> {
  const checks = parseJson<ChecksResult | null>(json, null);
  return checks && typeof checks === 'object' && Array.isArray(checks.outcomes) ? { checks } : {};
}

/** A conversation's or a template's check list (`ConversationSettings.checks`). */
function checkListOf(json: string | null): Pick<ConversationSettings, 'checks'> {
  const list = parseJson<CheckList | null>(json, null);
  return list && typeof list === 'object' ? { checks: list } : {};
}

const UPSERT_MESSAGE = `INSERT INTO messages (id, conversation_id, seq, author_kind, agent_id, agent_name, provider, created_at,
                       status, passed, error, round, duration_ms, cost_usd, input_tokens, output_tokens,
                       change_root, change_base, change_head, change_isolated, change_branch, more_changes, plan, review, queued,
                       asked, scheduled, event, tracked, event_source, checks, steered, auto_fix)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   seq = excluded.seq, status = excluded.status, passed = excluded.passed, error = excluded.error,
   round = excluded.round, duration_ms = excluded.duration_ms, cost_usd = excluded.cost_usd,
   input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
   change_root = excluded.change_root, change_base = excluded.change_base, change_head = excluded.change_head,
   change_isolated = excluded.change_isolated, change_branch = excluded.change_branch,
   more_changes = excluded.more_changes, plan = excluded.plan, review = excluded.review,
   queued = excluded.queued, asked = excluded.asked, scheduled = excluded.scheduled, event = excluded.event,
   tracked = excluded.tracked, event_source = excluded.event_source, checks = excluded.checks, steered = excluded.steered,
   auto_fix = excluded.auto_fix`;

const INSERT_PART = `INSERT INTO message_parts (message_id, idx, type, text, tool_id, tool_name, tool_detail, tool_status, tool_error,
                            tool_output, data)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const seenKey = (convId: string, agentId: string) => `${convId}\u0000${agentId}`;

export interface TaskRequest {
  scope: string;
  id: string;
  digest: string;
}

/**
 * SQLite-backed persistence. Conversations being used are kept in memory (the orchestrator mutates
 * them while streaming); changes are written back explicitly, message writes debounced.
 */
export class Store {
  private cache = new Map<string, Conversation>();
  private dirty = new Map<string, Set<string>>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Deleted conversations: late writes from a run that is still winding down are dropped. */
  private deleted = new Set<string>();
  /** The `agent_seen` rows in the database, per conversation and agent, so saves write only the difference. */
  private savedSeen = new Map<string, Set<string>>();

  constructor(private db: Database) {
    // A previous server process died mid-turn: its replies are aborted, an approval they still waited
    // on can no longer be answered (expired, as when a run is stopped), and a tool call they still
    // showed running ended without a result (as a stopped run closes it). Also in replies an older
    // server already marked aborted.
    transaction(db, () => {
      const waiting = db
        .prepare(
          `SELECT p.message_id, p.idx, p.data FROM message_parts p JOIN messages m ON m.id = p.message_id
           WHERE m.status = 'streaming' AND p.type = 'approval'`,
        )
        .all() as { message_id: string; idx: number; data: string | null }[];
      const expire = db.prepare('UPDATE message_parts SET data = ? WHERE message_id = ? AND idx = ?');
      for (const r of waiting) {
        const data = parseJson<Record<string, unknown>>(r.data, {});
        if (data.status === 'pending') expire.run(JSON.stringify({ ...data, status: 'expired' }), r.message_id, r.idx);
      }
      db.prepare(
        `UPDATE message_parts SET tool_status = 'error' WHERE type = 'tool' AND tool_status = 'running'
           AND message_id IN (SELECT id FROM messages WHERE status IN ('streaming', 'aborted'))`,
      ).run();
      db.prepare("UPDATE messages SET status = 'aborted' WHERE status = 'streaming'").run();
      // A team checks command it was still running did not finish: the card can be checked again.
      const checking = db.prepare(`SELECT id, checks FROM messages WHERE checks LIKE '%"running"%'`).all() as {
        id: string;
        checks: string;
      }[];
      const settle = db.prepare('UPDATE messages SET checks = ? WHERE id = ?');
      for (const r of checking) {
        const c = parseJson<ChecksResult | null>(r.checks, null);
        if (!c || !Array.isArray(c.outcomes) || !c.outcomes.some((o) => o.status === 'running')) continue;
        const outcomes = c.outcomes.map((o) =>
          o.status === 'running' ? { ...o, status: 'error' as const, reason: t().checksInterrupted, notRun: 'interrupted' as const } : o,
        );
        settle.run(JSON.stringify({ ...c, outcomes, status: overallStatus(outcomes) }), r.id);
      }
    });
  }

  // Conversations ------------------------------------------------------------

  list(
    running: (id: string) => boolean,
    waiting: (id: string) => boolean = () => false,
    sorting: (id: string) => boolean = () => false,
  ): ConversationSummary[] {
    const rows = this.db
      .prepare(
        'SELECT id, title, created_at, updated_at, group_id, pinned_at, branch, pause IS NOT NULL AS asking FROM conversations ORDER BY updated_at DESC',
      )
      .all() as (Pick<ConversationRow, 'id' | 'title' | 'created_at' | 'updated_at' | 'branch'> & {
      group_id: string | null;
      pinned_at: number | null;
      asking: number;
    })[];
    const agents = this.db
      .prepare('SELECT conversation_id, name, provider FROM conversation_agents ORDER BY conversation_id, position')
      .all() as { conversation_id: string; name: string; provider: Provider }[];
    // Each conversation's latest agent reply: which, how it ended, and whether its progress block says
    // the tracked goal is held up (JSON.stringify writes the status this way).
    const lastStatus = new Map(
      (
        this.db
          .prepare(
            `SELECT m.conversation_id, m.id, m.status,
                    EXISTS (SELECT 1 FROM message_parts p WHERE p.message_id = m.id AND p.type = 'progress'
                            AND p.data LIKE '%"status":"blocked"%') AS blocked
             FROM messages m
             JOIN (SELECT conversation_id, MAX(seq) AS seq FROM messages WHERE author_kind = 'agent' GROUP BY conversation_id) l
               ON l.conversation_id = m.conversation_id AND l.seq = m.seq`,
          )
          .all() as { conversation_id: string; id: string; status: MessageStatus; blocked: number }[]
      ).map((r) => [r.conversation_id, { id: r.id, status: r.status, ...(r.blocked ? { blocked: true } : {}) }]),
    );
    // Team designs waiting for the user's confirmation (JSON.stringify writes the flag this way).
    const confirming = new Set(
      (
        this.db.prepare(`SELECT DISTINCT conversation_id FROM messages WHERE plan LIKE '%"awaitingConfirmation":true%'`).all() as {
          conversation_id: string;
        }[]
      ).map((r) => r.conversation_id),
    );
    const schedules = new Map(
      (
        this.db.prepare('SELECT conversation_id, enabled, next_run_at, last_result, time_zone, repeat, watch FROM schedules').all() as Pick<
          ScheduleRow,
          'conversation_id' | 'enabled' | 'next_run_at' | 'last_result' | 'time_zone' | 'repeat' | 'watch'
        >[]
      ).map((r) => {
        const repeat = parseRepeat(r.repeat);
        return [
          r.conversation_id,
          scheduleSummary({
            enabled: Boolean(r.enabled),
            nextRunAt: opt(r.next_run_at),
            lastResult: opt(r.last_result),
            timeZone: r.time_zone,
            repeat,
            watches: repeat?.kind === 'event' ? parseWatches(r.watch, repeat.triggers) : undefined,
          }),
        ] as const;
      }),
    );
    const byConv = new Map<string, ConversationSummary['agents']>();
    for (const a of agents) {
      const list = byConv.get(a.conversation_id) ?? [];
      list.push({ name: a.name, provider: a.provider });
      byConv.set(a.conversation_id, list);
    }
    return rows
      .map((r) => {
        const live = this.cache.get(r.id);
        const branch = live ? live.branch : branchOf(r.branch).branch;
        return {
          id: r.id,
          title: live?.title ?? r.title,
          createdAt: r.created_at,
          updatedAt: live?.updatedAt ?? r.updated_at,
          agents: byConv.get(r.id) ?? [],
          running: running(r.id),
          ...(waiting(r.id) ? { waiting: true } : {}),
          ...((live ? pendingPlan(live.messages) : confirming.has(r.id)) ? { confirmTeam: true } : {}),
          ...((live ? live.pause : r.asking) ? { asking: true } : {}),
          ...statusOf(live, lastStatus.get(r.id)),
          ...(r.group_id ? { groupId: r.group_id } : {}),
          ...(r.pinned_at !== null ? { pinnedAt: r.pinned_at } : {}),
          ...(sorting(r.id) ? { sorting: true } : {}),
          ...scheduleOf(live, schedules.get(r.id)),
          ...(branch ? { branchFrom: { id: branch.fromId, title: branch.fromTitle, ...(branch.via ? { via: branch.via } : {}) } } : {}),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Conversation | undefined {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const conv = this.load(id);
    if (conv) this.cache.set(id, conv);
    return conv;
  }

  private load(id: string): Conversation | undefined {
    const c = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    if (!c) return undefined;

    const agents = (
      this.db
        .prepare(
          'SELECT agent_id, name, provider, role, model, effort, tools, account, limits FROM conversation_agents WHERE conversation_id = ? ORDER BY position',
        )
        .all(id) as unknown as AgentRow[]
    ).map(toAgent);

    const agentState: Record<string, AgentSessionState> = {};
    const sessions = this.db
      .prepare('SELECT agent_id, provider, account, session_id, permission, by_cli, backend FROM agent_sessions WHERE conversation_id = ?')
      .all(id) as {
      agent_id: string;
      provider: Provider | null;
      account: string | null;
      session_id: string | null;
      permission: string | null;
      by_cli: string | null;
      backend: string | null;
    }[];
    for (const s of sessions) {
      const permission = PERMISSION_ORDER.find((p) => p === s.permission);
      const byCli = byCliOf(s.by_cli);
      agentState[s.agent_id] = {
        provider: opt(s.provider),
        sessionId: opt(s.session_id),
        ...(permission ? { permission } : {}),
        ...(byCli ? { byCli } : {}),
        seen: [],
      };
      if (s.account) agentState[s.agent_id]!.account = s.account;
      if (s.backend) agentState[s.agent_id]!.backend = s.backend;
    }
    const seen = this.db.prepare('SELECT agent_id, message_id FROM agent_seen WHERE conversation_id = ?').all(id) as {
      agent_id: string;
      message_id: string;
    }[];
    for (const s of seen) agentState[s.agent_id]?.seen.push(s.message_id);
    for (const [agentId, state] of Object.entries(agentState)) this.savedSeen.set(seenKey(id, agentId), new Set(state.seen));

    const partRows = this.db
      .prepare(
        `SELECT p.message_id, p.type, p.text, p.tool_id, p.tool_name, p.tool_detail, p.tool_status, p.tool_error,
                p.tool_output, p.data
         FROM message_parts p JOIN messages m ON m.id = p.message_id
         WHERE m.conversation_id = ? ORDER BY m.seq, p.idx`,
      )
      .all(id) as unknown as PartRow[];
    const partsByMsg = new Map<string, MessagePart[]>();
    for (const p of partRows) {
      const list = partsByMsg.get(p.message_id) ?? [];
      list.push(toPart(p));
      partsByMsg.set(p.message_id, list);
    }
    const changeRows = this.db
      .prepare(
        `SELECT c.message_id, c.path, c.status, c.added, c.deleted
         FROM message_changes c JOIN messages m ON m.id = c.message_id
         WHERE m.conversation_id = ? ORDER BY m.seq, c.idx`,
      )
      .all(id) as unknown as ChangeRow[];
    const changesByMsg = new Map<string, FileChange[]>();
    for (const c of changeRows) {
      const list = changesByMsg.get(c.message_id) ?? [];
      list.push({ path: c.path, status: c.status, added: c.added, deleted: c.deleted });
      changesByMsg.set(c.message_id, list);
    }
    const messages = (
      this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq').all(id) as unknown as MessageRow[]
    ).map((m) => toMessage(m, partsByMsg.get(m.id) ?? [], changesByMsg.get(m.id) ?? []));

    const worktrees: Record<string, AgentWorktree[]> = {};
    const wtRows = this.db
      .prepare(
        'SELECT agent_id, repo_root, path, branch, base_commit, needs_reset FROM agent_worktrees WHERE conversation_id = ? ORDER BY rowid',
      )
      .all(id) as { agent_id: string; repo_root: string; path: string; branch: string; base_commit: string; needs_reset: number }[];
    for (const w of wtRows) {
      (worktrees[w.agent_id] ??= []).push({
        root: w.repo_root,
        path: w.path,
        branch: w.branch,
        base: w.base_commit,
        needsReset: Boolean(w.needs_reset),
      });
    }

    const scheduleRow = this.db.prepare('SELECT * FROM schedules WHERE conversation_id = ?').get(id) as ScheduleRow | undefined;
    const schedule = scheduleRow && toSchedule(scheduleRow);
    if (schedule) {
      const files = this.scheduleFileList(id);
      if (files.length) schedule.attachments = files;
    }

    return {
      id: c.id,
      title: c.title,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      agents,
      settings: {
        mode: c.mode,
        rounds: c.rounds,
        maxHops: c.max_hops,
        permission: c.permission,
        ...cwdSettings([c.cwd, ...extraCwdsOf(c.extra_cwds)]),
        ...(c.auto_team ? { autoTeam: true } : {}),
        ...(c.auto_confirm ? { autoConfirm: true } : {}),
        ...(c.lead_review ? { leadReview: true } : {}),
        ...(c.approvals === 'deny' ? { approvals: 'deny' as const } : {}),
        ...(c.steer ? { steer: true } : {}),
        ...checkListOf(c.checks),
      },
      messages,
      agentState,
      worktrees,
      ...(c.allow_rules ? { allowRules: parseJson(c.allow_rules, []) } : {}),
      ...queueOf(c.queue, messages),
      ...pauseOf(c.pause),
      ...(schedule ? { schedule } : {}),
      ...branchOf(c.branch),
    };
  }

  taskReceipt(request: TaskRequest) {
    return this.db
      .prepare('SELECT conversation_id AS conversationId, digest, queued FROM task_requests WHERE scope = ? AND request_id = ?')
      .get(request.scope, request.id) as { conversationId: string; digest: string; queued: number | null } | undefined;
  }

  recordTask(request: TaskRequest, convId: string, queued: boolean | null): void {
    this.db
      .prepare(
        'INSERT INTO task_requests (scope, request_id, digest, conversation_id, queued) VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, request_id) DO UPDATE SET queued = excluded.queued',
      )
      .run(request.scope, request.id, request.digest, convId, queued === null ? null : Number(queued));
  }

  /** Save a new conversation: its settings, its team, and the messages it starts with (a branch's copies). */
  create(conv: Conversation, request?: TaskRequest): void {
    transaction(this.db, () => {
      const s = conv.settings;
      this.db
        .prepare(
          `INSERT INTO conversations (id, title, created_at, updated_at, mode, rounds, max_hops, permission, cwd, extra_cwds,
                                     auto_team, auto_confirm, lead_review, approvals, allow_rules, pause, branch, checks, steer)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conv.id,
          conv.title,
          conv.createdAt,
          conv.updatedAt,
          s.mode,
          s.rounds,
          s.maxHops,
          s.permission,
          s.cwd,
          s.extraCwds?.length ? JSON.stringify(s.extraCwds) : null,
          s.autoTeam ? 1 : 0,
          s.autoConfirm ? 1 : 0,
          s.leadReview ? 1 : 0,
          nul(s.approvals),
          conv.allowRules?.length ? JSON.stringify(conv.allowRules) : null,
          conv.pause ? JSON.stringify(conv.pause) : null,
          conv.branch ? JSON.stringify(conv.branch) : null,
          s.checks ? JSON.stringify(s.checks) : null,
          s.steer ? 1 : 0,
        );
      if (request) this.recordTask(request, conv.id, null);
      this.writeAgents(conv);
      if (conv.messages.length) this.insertMessages(conv.id, conv, new Set(conv.messages.map((m) => m.id)));
    });
    this.cache.set(conv.id, conv);
  }

  /** Persist title, timestamps, settings, the team, where the team waits for the user's answer, and where a branch's copied messages end. */
  saveMeta(conv: Conversation): void {
    if (this.deleted.has(conv.id)) return;
    transaction(this.db, () => {
      const s = conv.settings;
      this.db
        .prepare(
          `UPDATE conversations SET title = ?, updated_at = ?, mode = ?, rounds = ?, max_hops = ?, permission = ?, cwd = ?,
             extra_cwds = ?, auto_team = ?, auto_confirm = ?, lead_review = ?, approvals = ?, allow_rules = ?, pause = ?, branch = ?,
             checks = ?, steer = ?
           WHERE id = ?`,
        )
        .run(
          conv.title,
          conv.updatedAt,
          s.mode,
          s.rounds,
          s.maxHops,
          s.permission,
          s.cwd,
          s.extraCwds?.length ? JSON.stringify(s.extraCwds) : null,
          s.autoTeam ? 1 : 0,
          s.autoConfirm ? 1 : 0,
          s.leadReview ? 1 : 0,
          nul(s.approvals),
          conv.allowRules?.length ? JSON.stringify(conv.allowRules) : null,
          conv.pause ? JSON.stringify(conv.pause) : null,
          conv.branch ? JSON.stringify(conv.branch) : null,
          s.checks ? JSON.stringify(s.checks) : null,
          s.steer ? 1 : 0,
          conv.id,
        );
      this.writeAgents(conv);
    });
  }

  private writeAgents(conv: Conversation): void {
    this.db.prepare('DELETE FROM conversation_agents WHERE conversation_id = ?').run(conv.id);
    const insert = this.db.prepare(
      `INSERT INTO conversation_agents (conversation_id, agent_id, position, name, provider, role, model, effort, tools, account, limits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    conv.agents.forEach((a, i) =>
      insert.run(conv.id, a.id, i, a.name, a.provider, a.role, nul(a.model), nul(a.effort), toolsJson(a), a.account || null, limitsJson(a)),
    );
  }

  /**
   * Delete a conversation. A schedule that opened it forgets it (`lastChatId`): returns the
   * conversations whose schedule did, so their open chats can be told.
   */
  delete(id: string): string[] {
    const gone = this.cache.get(id);
    this.deleted.add(id);
    for (const key of this.savedSeen.keys()) if (key.startsWith(seenKey(id, ''))) this.savedSeen.delete(key);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.dirty.delete(id);
    this.cache.delete(id);
    const linked = (
      this.db.prepare('SELECT conversation_id FROM schedules WHERE last_chat_id = ?').all(id) as { conversation_id: string }[]
    ).map((r) => r.conversation_id);
    const below = this.branchesPast(id, gone);
    transaction(this.db, () => {
      this.db.prepare('UPDATE schedules SET last_chat_id = NULL WHERE last_chat_id = ?').run(id);
      const save = this.db.prepare('UPDATE conversations SET branch = ? WHERE id = ?');
      for (const [convId, branch] of below) save.run(JSON.stringify(branch), convId);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    });
    for (const [convId, branch] of below) {
      const live = this.cache.get(convId);
      if (live) live.branch = branch;
    }
    for (const convId of linked) {
      const s = this.cache.get(convId)?.schedule;
      if (s?.lastChatId === id) delete s.lastChatId;
    }
    return linked;
  }

  /** Persist the messages waiting to be delivered. */
  saveQueue(conv: Conversation, request?: TaskRequest): void {
    if (this.deleted.has(conv.id)) return;
    const save = () =>
      this.db
        .prepare('UPDATE conversations SET queue = ? WHERE id = ?')
        .run(conv.queue?.length ? JSON.stringify(conv.queue) : null, conv.id);
    if (request)
      transaction(this.db, () => {
        save();
        this.recordTask(request, conv.id, true);
      });
    else save();
  }

  // Schedules ----------------------------------------------------------------------

  private scheduleFileList(id: string): AttachmentPart[] {
    return this.db
      .prepare(
        "SELECT 'attachment' AS type, id, name, mime_type AS mimeType, length(data) AS size FROM schedule_attachments WHERE conversation_id = ? ORDER BY rowid",
      )
      .all(id) as unknown as AttachmentPart[];
  }

  /** Load the originals one at a time only when a new scheduled message is sent. */
  scheduleFileData(id: string): Iterable<AttachmentData> {
    return this.db
      .prepare('SELECT name, mime_type AS mimeType, data AS bytes FROM schedule_attachments WHERE conversation_id = ? ORDER BY rowid')
      .iterate(id) as unknown as Iterable<AttachmentData>;
  }

  /** Save an edited definition and its file changes together. Routine scheduler writes leave the originals alone. */
  setSchedule(conv: Conversation, schedule: ConversationSchedule, add: AttachmentData[], remove: string[]): void {
    transaction(this.db, () => {
      this.saveSchedule({ ...conv, schedule });
      const del = this.db.prepare('DELETE FROM schedule_attachments WHERE conversation_id = ? AND id = ?');
      for (const id of remove) del.run(conv.id, id);
      // The same named file has a stable ID in this schedule, so retrying a save never adds it twice.
      const insert = this.db.prepare(
        'INSERT INTO schedule_attachments(id, conversation_id, name, mime_type, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      );
      for (const file of add) {
        const id = createHash('sha256')
          .update(JSON.stringify([conv.id, file.name, file.mimeType]))
          .update(file.bytes)
          .digest('hex');
        insert.run(id, conv.id, file.name, file.mimeType, file.bytes);
      }
      const files = this.scheduleFileList(conv.id);
      if (files.length > ATTACHMENT_LIMITS.maxFiles) throw new HttpError(400, t().tooManyAttachments(ATTACHMENT_LIMITS.maxFiles));
      if (files.length) schedule.attachments = files;
      else delete schedule.attachments;
    });
    conv.schedule = schedule;
  }

  /** Persist the conversation's schedule (none: delete it). */
  saveSchedule(conv: Conversation): void {
    if (this.deleted.has(conv.id)) return;
    const s = conv.schedule;
    if (!s) {
      this.db.prepare('DELETE FROM schedules WHERE conversation_id = ?').run(conv.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO schedules (conversation_id, text, repeat, time_zone, lang, enabled, approvals, missed, new_chat, updated_at,
                                next_run_at, last_run_at, last_result, last_error, last_chat_id, goal, tracking, hook, watch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET text = excluded.text, repeat = excluded.repeat,
           time_zone = excluded.time_zone, lang = excluded.lang, enabled = excluded.enabled, approvals = excluded.approvals,
           missed = excluded.missed, new_chat = excluded.new_chat, updated_at = excluded.updated_at,
           next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at, last_result = excluded.last_result,
           last_error = excluded.last_error, last_chat_id = excluded.last_chat_id, goal = excluded.goal,
           tracking = excluded.tracking, hook = excluded.hook, watch = excluded.watch`,
      )
      .run(
        conv.id,
        s.text,
        storedRepeat(s.repeat),
        s.timeZone,
        s.lang,
        s.enabled ? 1 : 0,
        s.approvals,
        s.missed,
        s.newChat ? 1 : 0,
        s.updatedAt,
        nul(s.nextRunAt),
        nul(s.lastRunAt),
        nul(s.lastResult),
        nul(s.lastError),
        nul(s.lastChatId),
        nul(s.goal),
        s.goal && s.tracking ? JSON.stringify(s.tracking) : null,
        s.hook ? JSON.stringify(s.hook) : null,
        s.repeat.kind === 'event' && s.watches?.length ? JSON.stringify(s.watches) : null,
      );
    // A schedule without a webhook has no token either.
    if (!s.hook) this.db.prepare('UPDATE schedules SET hook_hash = NULL WHERE conversation_id = ?').run(conv.id);
  }

  /** The SHA-256 (hex) of the token of the conversation's schedule's webhook, if it has one. */
  hookHash(convId: string): string | undefined {
    const row = this.db.prepare('SELECT hook_hash FROM schedules WHERE conversation_id = ?').get(convId) as
      { hook_hash: string | null } | undefined;
    return row?.hook_hash ?? undefined;
  }

  /**
   * Give the conversation's schedule a webhook whose token has this hash (replacing one it had), or
   * take it away (`undefined`). The schedule must be saved; its `hook` is set here as well.
   */
  setHook(conv: Conversation, hash: string | undefined, now: number): void {
    if (!conv.schedule || this.deleted.has(conv.id)) return;
    if (hash) conv.schedule.hook = { createdAt: now };
    else delete conv.schedule.hook;
    transaction(this.db, () => {
      this.saveSchedule(conv);
      this.db.prepare('UPDATE schedules SET hook_hash = ? WHERE conversation_id = ?').run(nul(hash), conv.id);
    });
  }

  /** Conversations whose schedule tracks a goal. */
  trackingSchedules(): string[] {
    return (
      this.db.prepare('SELECT conversation_id FROM schedules WHERE goal IS NOT NULL AND tracking IS NOT NULL').all() as {
        conversation_id: string;
      }[]
    ).map((r) => r.conversation_id);
  }

  /**
   * The new-mail triggers of the automations that are on, each with its automation (one automation may
   * wait for mail in several folders): those IMAP IDLE listens for (`idle.ts`).
   */
  mailWatches(): { conversationId: string; trigger: Extract<ScheduleTrigger, { source: 'mail' }> }[] {
    return this.eventSchedules().flatMap((r) =>
      r.repeat.triggers.flatMap((trigger) => (trigger.source === 'mail' ? [{ conversationId: r.conversation_id, trigger }] : [])),
    );
  }

  /**
   * Conversations whose automation is on and starts when something happens, and the next check of one
   * of whose triggers has come by `now` (or that was never checked), the longest waiting first.
   */
  watchDue(now: number): string[] {
    return this.eventSchedules(true)
      .map((r) => {
        const watches = parseWatches(r.watch, r.repeat.triggers);
        return { id: r.conversation_id, next: Math.min(...r.repeat.triggers.map((t) => watchOf({ watches }, t)?.nextCheckAt ?? 0)) };
      })
      .filter((r) => r.next <= now)
      .sort((a, b) => a.next - b.next)
      .map((r) => r.id);
  }

  /** The automations that are on and start when something happens, their times read (and what their checks keep, with `watch`). */
  private eventSchedules(
    watch = false,
  ): { conversation_id: string; repeat: Extract<ScheduleRepeat, { kind: 'event' }>; watch: string | null }[] {
    const rows = this.db
      .prepare(
        // A row that cannot be read (JSON that is not) is left out, not an error for every other one.
        `SELECT conversation_id, repeat${watch ? ', watch' : ''} FROM schedules
         WHERE enabled = 1 AND (CASE WHEN json_valid(repeat) THEN json_extract(repeat, '$.kind') END) = 'event'`,
      )
      .all() as { conversation_id: string; repeat: string; watch?: string | null }[];
    return rows.flatMap((r) => {
      const repeat = parseRepeat(r.repeat);
      return repeat?.kind === 'event' ? [{ conversation_id: r.conversation_id, repeat, watch: r.watch ?? null }] : [];
    });
  }

  /** Conversations whose schedule is on and due by `now`, the most overdue first. */
  dueSchedules(now: number): string[] {
    return (
      this.db.prepare('SELECT conversation_id FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at').all(now) as {
        conversation_id: string;
      }[]
    ).map((r) => r.conversation_id);
  }

  // Messages -------------------------------------------------------------------

  /** Queue a message for writing; `immediate` writes it (and anything else pending) now. */
  saveMessage(convId: string, msg: ChatMessage, immediate = false, request?: TaskRequest): void {
    if (this.deleted.has(convId)) return;
    let set = this.dirty.get(convId);
    if (!set) this.dirty.set(convId, (set = new Set()));
    set.add(msg.id);
    if (immediate || request) {
      this.flush(convId, request);
    } else if (!this.timers.has(convId)) {
      // Streaming changes a message many times per second; batch them.
      this.scheduleFlush(convId, 1000);
    }
  }

  /** Flush later; an error there (database busy, disk full) is logged and retried, never thrown. */
  private scheduleFlush(convId: string, ms: number): void {
    this.timers.set(
      convId,
      setTimeout(() => {
        try {
          this.flush(convId);
        } catch (err) {
          console.error('[store] could not save messages, retrying in 5 s:', err);
          if (!this.timers.has(convId) && this.dirty.has(convId)) this.scheduleFlush(convId, 5000);
        }
      }, ms),
    );
  }

  flush(convId: string, request?: TaskRequest): void {
    clearTimeout(this.timers.get(convId));
    this.timers.delete(convId);
    const ids = this.dirty.get(convId);
    const conv = this.cache.get(convId);
    this.dirty.delete(convId);
    if (!ids?.size || !conv) return;

    try {
      this.writeMessages(convId, conv, ids, request);
    } catch (err) {
      // Keep them pending for the next flush.
      const pending = this.dirty.get(convId);
      if (pending) for (const id of ids) pending.add(id);
      else this.dirty.set(convId, ids);
      throw err;
    }
  }

  private writeMessages(convId: string, conv: Conversation, ids: Set<string>, request?: TaskRequest): void {
    transaction(this.db, () => {
      this.insertMessages(convId, conv, ids);
      if (request) this.recordTask(request, convId, false);
    });
  }

  /** Write these of the conversation's messages, with their parts and file changes (inside the caller's transaction). */
  private insertMessages(convId: string, conv: Conversation, ids: Set<string>): void {
    const upsert = this.db.prepare(UPSERT_MESSAGE);
    const clearChanges = this.db.prepare('DELETE FROM message_changes WHERE message_id = ?');
    const insertChange = this.db.prepare(
      'INSERT INTO message_changes (message_id, idx, path, status, added, deleted) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const clearParts = this.db.prepare('DELETE FROM message_parts WHERE message_id = ?');
    const insertPart = this.db.prepare(INSERT_PART);
    conv.messages.forEach((m, seq) => {
      if (!ids.has(m.id)) return;
      const agentId = m.author.kind === 'agent' ? m.author.agentId : null;
      const meta = m.meta ?? {};
      // The first repository's changes in their columns and rows, the others' as JSON.
      const [first, ...more] = m.changes ?? [];
      upsert.run(
        m.id,
        convId,
        seq,
        m.author.kind,
        agentId,
        nul(m.agentName),
        nul(m.provider),
        m.createdAt,
        m.status,
        m.passed ? 1 : 0,
        nul(m.error),
        nul(meta.round),
        nul(meta.durationMs),
        nul(meta.costUsd),
        nul(meta.inputTokens),
        nul(meta.outputTokens),
        nul(first?.root),
        nul(first?.base),
        nul(first?.head),
        first ? (first.isolated ? 1 : 0) : null,
        nul(first?.branch),
        more.length ? JSON.stringify(more) : null,
        m.plan ? JSON.stringify(m.plan) : null,
        m.review ? JSON.stringify(m.review) : null,
        m.queued ? 1 : null,
        m.asked ? 1 : null,
        m.scheduled ? 1 : null,
        nul(m.event),
        m.tracked ? JSON.stringify(m.tracked) : null,
        m.event !== undefined ? nul(m.eventSource) : null,
        m.checks ? JSON.stringify(m.checks) : null,
        m.steered?.length ? JSON.stringify(m.steered) : null,
        m.autoFix ? JSON.stringify(m.autoFix) : null,
      );
      clearChanges.run(m.id);
      first?.files.forEach((f, idx) => insertChange.run(m.id, idx, f.path, f.status, f.added, f.deleted));
      clearParts.run(m.id);
      m.parts.forEach((p, idx) => insertPart.run(m.id, idx, p.type, ...partColumns(p)));
    });
  }

  /** Delete messages (with their parts and file changes); the caller has already removed them from `conv.messages`. */
  deleteMessages(convId: string, ids: string[]): void {
    if (this.deleted.has(convId)) return;
    const pending = this.dirty.get(convId);
    for (const id of ids) pending?.delete(id);
    const del = this.db.prepare('DELETE FROM messages WHERE conversation_id = ? AND id = ?');
    transaction(this.db, () => {
      for (const id of ids) del.run(convId, id);
    });
  }

  flushAll(): void {
    for (const id of [...this.dirty.keys()]) this.flush(id);
  }

  // Agent sessions ---------------------------------------------------------------

  saveAgentState(convId: string, agentId: string, state: AgentSessionState): void {
    if (this.deleted.has(convId)) return;
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO agent_sessions (conversation_id, agent_id, provider, account, session_id, permission, by_cli, backend) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id, agent_id) DO UPDATE SET
             provider = excluded.provider, account = excluded.account, session_id = excluded.session_id,
             permission = excluded.permission, by_cli = excluded.by_cli, backend = excluded.backend`,
        )
        .run(
          convId,
          agentId,
          nul(state.provider),
          state.account || null,
          nul(state.sessionId),
          nul(state.permission),
          state.byCli ? JSON.stringify(state.byCli) : null,
          state.backend || null,
        );
      // Write only what changed since the last save: the list grows with the conversation.
      const key = seenKey(convId, agentId);
      const saved = this.savedSeen.get(key);
      const current = new Set(state.seen);
      if (!saved) this.db.prepare('DELETE FROM agent_seen WHERE conversation_id = ? AND agent_id = ?').run(convId, agentId);
      const del = this.db.prepare('DELETE FROM agent_seen WHERE conversation_id = ? AND agent_id = ? AND message_id = ?');
      for (const m of saved ?? []) if (!current.has(m)) del.run(convId, agentId, m);
      const insert = this.db.prepare('INSERT OR IGNORE INTO agent_seen (conversation_id, agent_id, message_id) VALUES (?, ?, ?)');
      for (const m of current) if (!saved?.has(m)) insert.run(convId, agentId, m);
      this.savedSeen.set(key, current);
    });
  }

  // Worktrees ----------------------------------------------------------------------

  /** Saves an agent's worktree of one repository (`w.root`), in place of the one it had there. */
  saveWorktree(convId: string, agentId: string, w: AgentWorktree): void {
    if (this.deleted.has(convId)) return;
    this.db
      .prepare(
        `INSERT INTO agent_worktrees (conversation_id, agent_id, repo_root, path, branch, base_commit, needs_reset)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, agent_id, repo_root) DO UPDATE SET path = excluded.path,
           branch = excluded.branch, base_commit = excluded.base_commit, needs_reset = excluded.needs_reset`,
      )
      .run(convId, agentId, w.root, w.path, w.branch, w.base, w.needsReset ? 1 : 0);
  }

  /** Forgets an agent's worktree of a repository no working directory is in any more. */
  deleteWorktree(convId: string, agentId: string, root: string): void {
    if (this.deleted.has(convId)) return;
    this.db.prepare('DELETE FROM agent_worktrees WHERE conversation_id = ? AND agent_id = ? AND repo_root = ?').run(convId, agentId, root);
  }

  // --- Shared conversations (secret gists) ----------------------------------------------

  addShare(s: SharedPage): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO shares (id, conversation_id, title, up_to_message_id, up_to_agent, url, gist_url, created_at, files, files_gist, unfinished)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.conversationId,
        s.title,
        nul(s.upTo?.messageId),
        nul(s.upTo?.agentName),
        s.url,
        s.gistUrl,
        s.createdAt,
        s.files ?? 0,
        nul(s.filesGist),
        s.unfinished ? 1 : 0,
      );
  }

  /** Every share, the newest first. */
  listShares(): SharedPage[] {
    return (this.db.prepare(`${SHARE_SELECT} ORDER BY s.created_at DESC, s.rowid DESC`).all() as unknown as ShareRow[]).map(shareFromRow);
  }

  getShare(id: string): SharedPage | undefined {
    const row = this.db.prepare(`${SHARE_SELECT} WHERE s.id = ?`).get(id) as ShareRow | undefined;
    return row && shareFromRow(row);
  }

  deleteShare(id: string): void {
    this.db.prepare('DELETE FROM shares WHERE id = ?').run(id);
  }

  /** Puts `s` in the place of the share recorded as `id` (its files gist, recorded while it was made), in one step. */
  replaceShare(id: string, s: SharedPage): void {
    transaction(this.db, () => {
      this.deleteShare(id);
      this.addShare(s);
    });
  }

  // Groups -------------------------------------------------------------------------

  /** The user's groups, in the order they were made. (The default group, "Other", is not stored.) */
  listGroups(): ConversationGroup[] {
    return this.db
      .prepare('SELECT id, name FROM conversation_groups ORDER BY position, created_at')
      .all() as unknown as ConversationGroup[];
  }

  getGroup(id: string): ConversationGroup | undefined {
    return this.db.prepare('SELECT id, name FROM conversation_groups WHERE id = ?').get(id) as ConversationGroup | undefined;
  }

  /** A new group goes after the others. */
  createGroup(group: ConversationGroup): void {
    this.db
      .prepare(
        `INSERT INTO conversation_groups (id, name, position, created_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM conversation_groups), ?)`,
      )
      .run(group.id, group.name, Date.now());
  }

  renameGroup(id: string, name: string): void {
    this.db.prepare('UPDATE conversation_groups SET name = ? WHERE id = ?').run(name, id);
  }

  /** Its conversations go to the default group (the foreign key sets their group to NULL). */
  deleteGroup(id: string): void {
    this.db.prepare('DELETE FROM conversation_groups WHERE id = ?').run(id);
  }

  /**
   * A conversation's title now (what is in memory counts), without loading it. Once it is deleted, the
   * title the sidebar shows for it (`deletedTitles()` in `src/web/sidebar.ts`): the one it had when
   * deleted, where a conversation further down remembers it (`via`), else its title when the newest of
   * the conversations branched from it was made. Undefined when nothing knows it.
   */
  titleOf(convId: string): string | undefined {
    const live = this.cache.get(convId);
    if (live) return live.title;
    if (!this.deleted.has(convId)) {
      const row = this.db.prepare('SELECT title FROM conversations WHERE id = ?').get(convId) as { title: string } | undefined;
      if (row) return row.title;
    }
    const rows = this.db.prepare('SELECT id, created_at, branch FROM conversations WHERE branch IS NOT NULL').all() as Pick<
      ConversationRow,
      'id' | 'created_at' | 'branch'
    >[];
    const branches = rows.flatMap((r) => {
      const cached = this.cache.get(r.id);
      const branch = cached ? cached.branch : branchOf(r.branch).branch;
      return branch ? [{ id: r.id, createdAt: r.created_at, branch }] : [];
    });
    let title: string | undefined;
    for (const b of byAge(branches)) if (b.branch.fromId === convId) title = b.branch.fromTitle;
    for (const b of branches) for (const v of b.branch.via ?? []) if (v.id === convId) title = v.title;
    return title;
  }

  /** The sidebar group a conversation is in (`null`: the default group, "Other"). */
  groupOf(convId: string): string | null {
    const row = this.db.prepare('SELECT group_id FROM conversations WHERE id = ?').get(convId) as { group_id: string | null } | undefined;
    return row?.group_id ?? null;
  }

  /**
   * The conversations below `id` (branched from it, or from deleted ones under it) with their branch
   * as it is once `id` is deleted: knowing where it came from, they stay in its family.
   */
  private branchesPast(id: string, live: Conversation | undefined): [string, ConversationBranch][] {
    const row = this.db.prepare('SELECT title, branch FROM conversations WHERE id = ?').get(id) as
      Pick<ConversationRow, 'title' | 'branch'> | undefined;
    if (!row) return [];
    const deleted = { id, title: live?.title ?? row.title, branch: live ? live.branch : branchOf(row.branch).branch };
    const rows = this.db.prepare('SELECT id, branch FROM conversations WHERE branch IS NOT NULL AND id != ?').all(id) as Pick<
      ConversationRow,
      'id' | 'branch'
    >[];
    const out: [string, ConversationBranch][] = [];
    for (const r of rows) {
      const cached = this.cache.get(r.id);
      const branch = cached ? cached.branch : branchOf(r.branch).branch;
      const next = branch && branchPast(branch, deleted);
      if (next) out.push([r.id, next]);
    }
    return out;
  }

  /** Every conversation's place in a family of branched conversations (see `src/shared/family.ts`). */
  private familyMembers(): (FamilyMember & { groupId: string | null })[] {
    const rows = this.db.prepare('SELECT id, created_at, group_id, branch FROM conversations').all() as (Pick<
      ConversationRow,
      'id' | 'created_at' | 'branch'
    > & { group_id: string | null })[];
    return rows.map((r) => {
      const live = this.cache.get(r.id);
      const branch = live ? live.branch : branchOf(r.branch).branch;
      return {
        id: r.id,
        createdAt: r.created_at,
        groupId: r.group_id,
        ...(branch ? { fromId: branch.fromId, ...(branch.via ? { via: branch.via.map((v) => v.id) } : {}) } : {}),
      };
    });
  }

  /** The ids of the conversations in the same family as `convId` (itself included), oldest first. */
  family(convId: string): string[] {
    return familyOf(this.familyMembers(), convId);
  }

  /** The group a family of branched conversations is in: its oldest conversation's (`null`: "Other"). */
  familyGroupOf(convId: string): string | null {
    const members = this.familyMembers();
    const ids = new Set(familyOf(members, convId));
    return byAge(members.filter((m) => ids.has(m.id)))[0]?.groupId ?? null;
  }

  /**
   * The user puts a conversation in a group (`null`: the default group), and with it the rest of its
   * family: the conversations it was branched from, and those branched from them or from it.
   */
  moveToGroup(convId: string, groupId: string | null): void {
    const ids = this.family(convId);
    const update = this.db.prepare("UPDATE conversations SET group_id = ?, group_source = 'user' WHERE id = ?");
    transaction(this.db, () => {
      for (const id of ids.length ? ids : [convId]) update.run(groupId, id);
    });
  }

  /**
   * The user pins a conversation to the top of the sidebar, or unpins it. Pinning one that is pinned
   * already keeps when it was pinned, and so its place among the pinned ones. Neither is activity: the
   * conversation keeps its `updatedAt`. Returns whether there was such a conversation.
   */
  setPinned(convId: string, pinned: boolean, now = Date.now()): boolean {
    if (this.deleted.has(convId)) return false;
    const update = pinned
      ? this.db.prepare('UPDATE conversations SET pinned_at = COALESCE(pinned_at, ?) WHERE id = ?').run(now, convId)
      : this.db.prepare('UPDATE conversations SET pinned_at = NULL WHERE id = ?').run(convId);
    return update.changes > 0;
  }

  /** A new branch goes into its family's group, as the user's choice (so the lead agent does not sort it). */
  placeBranch(convId: string): void {
    this.db.prepare("UPDATE conversations SET group_id = ?, group_source = 'user' WHERE id = ?").run(this.familyGroupOf(convId), convId);
  }

  /**
   * The lead agent sorted a conversation by its first message: it goes into `groupId` (`null`: stays
   * in the default group) unless it was sorted already — the user may have moved it meanwhile — or
   * the group is gone. Returns whether it moved.
   */
  sortIntoGroup(convId: string, groupId: string | null): boolean {
    if (this.deleted.has(convId)) return false;
    const sort = this.db.prepare(
      `UPDATE conversations SET group_id = ?, group_source = 'auto'
       WHERE id = ? AND group_source IS NULL AND (? IS NULL OR EXISTS (SELECT 1 FROM conversation_groups WHERE id = ?))`,
    );
    const along = this.db.prepare('UPDATE conversations SET group_id = ? WHERE id = ?');
    const others = this.family(convId).filter((id) => id !== convId);
    return transaction(this.db, () => {
      if (!sort.run(groupId, convId, groupId, groupId).changes) return false;
      // A branch made while it was being sorted goes along (it keeps being the user's choice).
      for (const id of others) along.run(groupId, id);
      return true;
    });
  }

  /** The conversation was put in a group already (or left in "Other" on purpose), by the user or the lead agent. */
  isSorted(convId: string): boolean {
    const row = this.db.prepare('SELECT group_source FROM conversations WHERE id = ?').get(convId) as
      { group_source: string | null } | undefined;
    return Boolean(row?.group_source);
  }

  /** Titles of a group's most recent conversations (shown to the lead agent as examples of what is in it). */
  groupTitles(groupId: string, limit: number): string[] {
    return (
      this.db.prepare('SELECT title FROM conversations WHERE group_id = ? ORDER BY updated_at DESC LIMIT ?').all(groupId, limit) as {
        title: string;
      }[]
    ).map((r) => r.title);
  }

  /** The conversations' working directories (all of each), each once, the most recently used first. */
  listCwds(): string[] {
    const rows = this.db.prepare('SELECT cwd, extra_cwds FROM conversations ORDER BY updated_at DESC, cwd').all() as {
      cwd: string;
      extra_cwds: string | null;
    }[];
    return [...new Set(rows.flatMap((r) => [r.cwd, ...extraCwdsOf(r.extra_cwds)]))];
  }

  // Search -------------------------------------------------------------------------

  /**
   * Conversations whose title or messages (what the user and the agents wrote) contain every word of
   * `query`, ignoring case: those whose title matches first, then the most recent.
   */
  search(query: string, limit = 50): SearchResult[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    try {
      this.flushAll(); // replies still streaming are searchable too
    } catch (err) {
      console.error('[store] could not save messages before searching:', err);
    }
    const like = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const hits = this.db
      .prepare(
        `SELECT m.conversation_id, m.id AS message_id, p.text FROM message_parts p JOIN messages m ON m.id = p.message_id
         WHERE p.type = 'text' AND m.author_kind IN ('user', 'agent') AND (${like.map(() => "p.text LIKE ? ESCAPE '\\'").join(' OR ')})
         ORDER BY m.conversation_id, m.seq, p.idx`,
      )
      .all(...like) as { conversation_id: string; message_id: string; text: string }[];
    // The lead agent's reviews too (their text is in `review`, not in parts): what they say, not their JSON.
    // Their column holds JSON, which escapes quotes and backslashes: the words are looked for as it writes them.
    const inJson = terms.map(
      (t) =>
        `%${JSON.stringify(t)
          .slice(1, -1)
          .replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    );
    const reviews = this.db
      .prepare(
        `SELECT conversation_id, id AS message_id, review FROM messages
         WHERE review IS NOT NULL AND (${inJson.map(() => "review LIKE ? ESCAPE '\\'").join(' OR ')})`,
      )
      .all(...inJson) as { conversation_id: string; message_id: string; review: string }[];
    for (const r of reviews) {
      const text = reviewText(parseReview(r.review));
      if (text) hits.push({ conversation_id: r.conversation_id, message_id: r.message_id, text });
    }
    const byConv = new Map<string, typeof hits>();
    for (const h of hits) {
      const list = byConv.get(h.conversation_id) ?? [];
      list.push(h);
      byConv.set(h.conversation_id, list);
    }
    const rows = this.db.prepare('SELECT id, title, updated_at, group_id, branch FROM conversations').all() as {
      id: string;
      title: string;
      updated_at: number;
      group_id: string | null;
      branch: string | null;
    }[];
    const titles = new Map(rows.map((r) => [r.id, this.cache.get(r.id)?.title ?? r.title]));
    const results: (SearchResult & { titleMatch: boolean })[] = [];
    for (const r of rows) {
      const live = this.cache.get(r.id);
      const title = live?.title ?? r.title;
      const branch = live ? live.branch : branchOf(r.branch).branch;
      const found = new Set(termsIn(title, terms).map((t) => t.toLowerCase()));
      const titleMatch = found.size === terms.length;
      // LIKE ignores case for ASCII letters only; the check here is the one that counts.
      const parts = (byConv.get(r.id) ?? []).filter((h) => termsIn(h.text, terms).length);
      for (const h of parts) for (const t of termsIn(h.text, terms)) found.add(t.toLowerCase());
      if (found.size < terms.length) continue;
      // The excerpt comes from the part with the most of the words.
      const best = parts.reduce<(typeof parts)[number] | undefined>(
        (a, h) => (!a || termsIn(h.text, terms).length > termsIn(a.text, terms).length ? h : a),
        undefined,
      );
      results.push({
        id: r.id,
        title,
        updatedAt: live?.updatedAt ?? r.updated_at,
        ...(r.group_id ? { groupId: r.group_id } : {}),
        ...(best ? { snippet: snippetAround(best.text, terms) } : {}),
        matches: new Set(parts.map((h) => h.message_id)).size,
        ...(branch ? { branchFrom: titles.get(branch.fromId) ?? branch.fromTitle } : {}),
        titleMatch,
      });
    }
    return results
      .sort((a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(({ titleMatch: _titleMatch, ...r }) => r);
  }

  // Presets ------------------------------------------------------------------------

  listPresets(): TeamPreset[] {
    const rows = this.db.prepare('SELECT * FROM presets ORDER BY created_at').all() as {
      id: string;
      name: string;
      description: string | null;
      mode: Mode;
      rounds: number;
      max_hops: number;
      permission: Permission;
      checks: string | null;
    }[];
    const agentStmt = this.db.prepare(
      'SELECT agent_id, name, provider, role, model, effort, tools, account, limits FROM preset_agents WHERE preset_id = ? ORDER BY position',
    );
    const user = rows.map<TeamPreset>((r) => ({
      id: r.id,
      name: r.name,
      description: opt(r.description),
      agents: (agentStmt.all(r.id) as unknown as AgentRow[]).map(toAgent),
      settings: { mode: r.mode, rounds: r.rounds, maxHops: r.max_hops, permission: r.permission, ...checkListOf(r.checks) },
    }));
    return [...builtinPresets(currentLang()), ...user];
  }

  savePreset(p: TeamPreset): void {
    transaction(this.db, () => {
      const s = p.settings;
      this.db
        .prepare(
          `INSERT INTO presets (id, name, description, mode, rounds, max_hops, permission, created_at, checks)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, mode = excluded.mode,
             rounds = excluded.rounds, max_hops = excluded.max_hops, permission = excluded.permission, checks = excluded.checks`,
        )
        .run(
          p.id,
          p.name,
          nul(p.description),
          s.mode,
          s.rounds,
          s.maxHops,
          s.permission,
          Date.now(),
          s.checks ? JSON.stringify(s.checks) : null,
        );
      this.db.prepare('DELETE FROM preset_agents WHERE preset_id = ?').run(p.id);
      const insert = this.db.prepare(
        `INSERT INTO preset_agents (preset_id, position, agent_id, name, provider, role, model, effort, tools, account, limits)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      p.agents.forEach((a, i) =>
        insert.run(p.id, i, a.id, a.name, a.provider, a.role, nul(a.model), nul(a.effort), toolsJson(a), a.account || null, limitsJson(a)),
      );
    });
  }

  deletePreset(id: string): void {
    this.db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }

  // Team checks' baselines (where the run of a conversation's latest result started from) -----------

  /** Keep where the run of a conversation's latest check result (`messageId`) started from, replacing the one before. */
  saveChecksBaseline(convId: string, messageId: string, baseline: unknown): void {
    if (this.deleted.has(convId)) return;
    this.db
      .prepare(
        `INSERT INTO check_baselines (conversation_id, message_id, data) VALUES (?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET message_id = excluded.message_id, data = excluded.data`,
      )
      .run(convId, messageId, JSON.stringify(baseline));
  }

  /** Where the run of this check result started from, when it is the conversation's latest one with a baseline. */
  checksBaseline<T>(convId: string, messageId: string): T | undefined {
    const row = this.db.prepare('SELECT message_id, data FROM check_baselines WHERE conversation_id = ?').get(convId) as
      { message_id: string; data: string } | undefined;
    if (!row || row.message_id !== messageId) return undefined;
    return parseJson<T | undefined>(row.data, undefined);
  }

  // Notification inbox (the sidebar's bell; recorded by src/server/inbox.ts) -------------------

  /**
   * Keeps a notification about a conversation, unread; past `INBOX_KEPT`, the oldest go. Returns it,
   * or undefined when the conversation is gone (deleted while its run wound down).
   */
  addNotification(n: {
    id: string;
    conversationId: string;
    kind: AlertKind;
    agent?: string;
    text?: string;
    createdAt: number;
  }): InboxItem | undefined {
    if (this.deleted.has(n.conversationId)) return undefined;
    try {
      transaction(this.db, () => {
        this.db
          .prepare('INSERT INTO notifications (id, conversation_id, kind, agent, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(n.id, n.conversationId, n.kind, nul(n.agent), nul(n.text), n.createdAt);
        this.db
          .prepare('DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?)')
          .run(INBOX_KEPT);
      });
    } catch {
      // Its conversation is no longer in the database.
      return undefined;
    }
    return this.notifications().find((x) => x.id === n.id);
  }

  /** Every notification kept, the newest first, with its conversation's title now. */
  notifications(): InboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT n.id, n.conversation_id, c.title, n.kind, n.agent, n.text, n.created_at, n.read_at
         FROM notifications n JOIN conversations c ON c.id = n.conversation_id
         ORDER BY n.created_at DESC, n.rowid DESC`,
      )
      .all() as unknown as NotificationRow[];
    return rows
      .filter((r) => (ALERT_KINDS as readonly string[]).includes(r.kind))
      .map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        title: this.cache.get(r.conversation_id)?.title ?? r.title,
        kind: r.kind as AlertKind,
        ...(r.agent ? { agent: r.agent } : {}),
        ...(r.text ? { text: r.text } : {}),
        createdAt: r.created_at,
        read: r.read_at !== null,
      }));
  }

  /** How many are unread, in which conversations, and the newest one's id. */
  notificationSummary(): InboxSummary {
    const unread = this.db
      .prepare(
        'SELECT conversation_id, COUNT(*) AS n FROM notifications WHERE read_at IS NULL GROUP BY conversation_id ORDER BY MAX(created_at) DESC',
      )
      .all() as { conversation_id: string; n: number }[];
    const newest = this.db.prepare('SELECT id FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as
      { id: string } | undefined;
    return {
      unread: unread.reduce((sum, r) => sum + r.n, 0),
      unreadIn: unread.map((r) => r.conversation_id),
      ...(newest ? { newest: newest.id } : {}),
    };
  }

  /** Marks notifications read (those named, those of one conversation, or all); returns how many were unread. */
  readNotifications(which: InboxReadRequest, now = Date.now()): number {
    if ('all' in which) return Number(this.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(now).changes);
    if ('conversationId' in which) {
      return Number(
        this.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND conversation_id = ?').run(now, which.conversationId)
          .changes,
      );
    }
    return transaction(this.db, () => {
      const mark = this.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND id = ?');
      return which.ids.reduce((n, id) => n + Number(mark.run(now, id).changes), 0);
    });
  }

  /** Removes every notification. */
  clearNotifications(): void {
    this.db.prepare('DELETE FROM notifications').run();
  }
}
