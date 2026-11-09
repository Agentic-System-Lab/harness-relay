import type {
  AgentConfig,
  AgentSessionState,
  AgentWorktree,
  FileChange,
  MessageChanges,
  ChatMessage,
  Conversation,
  ConversationGroup,
  ConversationSchedule,
  ConversationSummary,
  Lang,
  MessagePart,
  Mode,
  Permission,
  Provider,
  RunPause,
  ScheduleRepeat,
  ScheduleResult,
  TeamPlan,
  TeamPreset,
  ToolStatus,
  MessageStatus,
  SearchResult,
  SharedPage,
} from '../shared/types';
import { pendingPlan } from '../shared/types';
import { searchTerms, snippetAround, termsIn } from '../shared/search';
import { nul, transaction, type Database } from './db';
import { currentLang } from './i18n';
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
  /** How many conversations have its conversation's id: 0 once it was deleted. */
  live: number;
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
  auto_team: number;
  auto_confirm: number;
  approvals: string | null;
  allow_rules: string | null;
  queue: string | null;
  pause: string | null;
}

interface AgentRow {
  agent_id: string;
  name: string;
  provider: Provider;
  role: string;
  model: string | null;
  effort: string | null;
  tools: string | null;
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
  plan: string | null;
  queued: number | null;
  asked: number | null;
  scheduled: number | null;
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
  const agent: AgentConfig = { id: r.agent_id, name: r.name, provider: r.provider, role: r.role, model: opt(r.model), effort: opt(r.effort) };
  const tools = parseTools(r.tools);
  if (tools) agent.tools = tools;
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

function toPart(r: PartRow): MessagePart {
  switch (r.type) {
    case 'tool':
      return {
        type: 'tool',
        id: r.tool_id ?? '',
        name: r.tool_name ?? 'tool',
        detail: opt(r.tool_detail),
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
    default:
      return { type: 'text', text: r.text ?? '' };
  }
}

/** Columns of one part: text, tool_id, tool_name, tool_detail, tool_status, tool_error, tool_output, data. */
function partColumns(p: MessagePart): (string | null)[] {
  switch (p.type) {
    case 'text':
    case 'thinking':
      return [p.text, null, null, null, null, null, null, null];
    case 'tool':
      return [null, p.id, p.name, nul(p.detail), p.status, nul(p.error), nul(p.output), null];
    case 'plan':
      return [null, null, null, null, null, null, null, JSON.stringify(p.entries)];
    case 'approval':
    case 'attachment': {
      const { type: _type, ...data } = p;
      return [null, null, null, null, null, null, null, JSON.stringify(data)];
    }
  }
}

function toChanges(r: MessageRow, files: FileChange[]): MessageChanges | undefined {
  if (!r.change_root || !r.change_base || !r.change_head) return undefined;
  return {
    root: r.change_root,
    base: r.change_base,
    head: r.change_head,
    files,
    isolated: Boolean(r.change_isolated),
    branch: opt(r.change_branch),
  };
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
    queued: r.queued ? true : undefined,
    asked: r.asked ? true : undefined,
    scheduled: r.scheduled ? true : undefined,
  };
}

function toSchedule(r: ScheduleRow): ConversationSchedule | undefined {
  const repeat = parseJson<ScheduleRepeat | null>(r.repeat, null);
  if (!repeat) return undefined;
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
  };
}

/** What the sidebar shows of a schedule; times of day are shown in the schedule's time zone. */
function scheduleSummary(
  s: Pick<ConversationSchedule, 'enabled' | 'nextRunAt' | 'lastResult' | 'timeZone'> & { repeat?: Pick<ScheduleRepeat, 'kind'> },
): ConversationSummary['schedule'] {
  const ofDay = s.repeat?.kind === 'daily' || s.repeat?.kind === 'weekly';
  return {
    enabled: s.enabled,
    ...(s.nextRunAt !== undefined ? { nextRunAt: s.nextRunAt } : {}),
    ...(s.lastResult ? { lastResult: s.lastResult } : {}),
    ...(ofDay ? { timeZone: s.timeZone } : {}),
  };
}

/** The latest agent reply's status, from memory when the conversation is open (it may be streaming). */
function statusOf(live: Conversation | undefined, stored: MessageStatus | undefined): { lastStatus?: MessageStatus } {
  const last = live ? [...live.messages].reverse().find((m) => m.author.kind === 'agent')?.status : stored;
  return last ? { lastStatus: last } : {};
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
function scheduleOf(
  live: Conversation | undefined,
  stored: ConversationSummary['schedule'],
): Pick<ConversationSummary, 'schedule'> {
  const schedule = live ? live.schedule && scheduleSummary(live.schedule) : stored;
  return schedule ? { schedule } : {};
}

function pauseOf(json: string | null): Pick<Conversation, 'pause'> {
  const pause = parseJson<RunPause | null>(json, null);
  return pause ? { pause } : {};
}

function parsePlan(json: string | null): TeamPlan | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as TeamPlan;
  } catch {
    return undefined;
  }
}

const UPSERT_MESSAGE = `INSERT INTO messages (id, conversation_id, seq, author_kind, agent_id, agent_name, provider, created_at,
                       status, passed, error, round, duration_ms, cost_usd, input_tokens, output_tokens,
                       change_root, change_base, change_head, change_isolated, change_branch, plan, queued, asked, scheduled)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET
   seq = excluded.seq, status = excluded.status, passed = excluded.passed, error = excluded.error,
   round = excluded.round, duration_ms = excluded.duration_ms, cost_usd = excluded.cost_usd,
   input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
   change_root = excluded.change_root, change_base = excluded.change_base, change_head = excluded.change_head,
   change_isolated = excluded.change_isolated, change_branch = excluded.change_branch, plan = excluded.plan,
   queued = excluded.queued, asked = excluded.asked, scheduled = excluded.scheduled`;

const INSERT_PART = `INSERT INTO message_parts (message_id, idx, type, text, tool_id, tool_name, tool_detail, tool_status, tool_error,
                            tool_output, data)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const seenKey = (convId: string, agentId: string) => `${convId}\u0000${agentId}`;

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
    // A previous server process died mid-turn.
    db.prepare("UPDATE messages SET status = 'aborted' WHERE status = 'streaming'").run();
  }

  // Conversations ------------------------------------------------------------

  list(
    running: (id: string) => boolean,
    waiting: (id: string) => boolean = () => false,
    sorting: (id: string) => boolean = () => false,
  ): ConversationSummary[] {
    const rows = this.db
      .prepare('SELECT id, title, updated_at, group_id, pause IS NOT NULL AS asking FROM conversations ORDER BY updated_at DESC')
      .all() as (Pick<ConversationRow, 'id' | 'title' | 'updated_at'> & { group_id: string | null; asking: number })[];
    const agents = this.db
      .prepare('SELECT conversation_id, name, provider FROM conversation_agents ORDER BY conversation_id, position')
      .all() as { conversation_id: string; name: string; provider: Provider }[];
    // How each conversation's latest agent reply ended.
    const lastStatus = new Map(
      (
        this.db
          .prepare(
            `SELECT m.conversation_id, m.status FROM messages m
             JOIN (SELECT conversation_id, MAX(seq) AS seq FROM messages WHERE author_kind = 'agent' GROUP BY conversation_id) l
               ON l.conversation_id = m.conversation_id AND l.seq = m.seq`,
          )
          .all() as { conversation_id: string; status: MessageStatus }[]
      ).map((r) => [r.conversation_id, r.status]),
    );
    // Team designs waiting for the user's confirmation (JSON.stringify writes the flag this way).
    const confirming = new Set(
      (
        this.db
          .prepare(`SELECT DISTINCT conversation_id FROM messages WHERE plan LIKE '%"awaitingConfirmation":true%'`)
          .all() as { conversation_id: string }[]
      ).map((r) => r.conversation_id),
    );
    const schedules = new Map(
      (
        this.db.prepare('SELECT conversation_id, enabled, next_run_at, last_result, time_zone, repeat FROM schedules').all() as Pick<
          ScheduleRow,
          'conversation_id' | 'enabled' | 'next_run_at' | 'last_result' | 'time_zone' | 'repeat'
        >[]
      ).map((r) => [
        r.conversation_id,
        scheduleSummary({
          enabled: Boolean(r.enabled),
          nextRunAt: opt(r.next_run_at),
          lastResult: opt(r.last_result),
          timeZone: r.time_zone,
          repeat: parseJson<ScheduleRepeat | undefined>(r.repeat, undefined),
        }),
      ]),
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
        return {
          id: r.id,
          title: live?.title ?? r.title,
          updatedAt: live?.updatedAt ?? r.updated_at,
          agents: byConv.get(r.id) ?? [],
          running: running(r.id),
          ...(waiting(r.id) ? { waiting: true } : {}),
          ...((live ? pendingPlan(live.messages) : confirming.has(r.id)) ? { confirmTeam: true } : {}),
          ...((live ? live.pause : r.asking) ? { asking: true } : {}),
          ...statusOf(live, lastStatus.get(r.id)),
          ...(r.group_id ? { groupId: r.group_id } : {}),
          ...(sorting(r.id) ? { sorting: true } : {}),
          ...scheduleOf(live, schedules.get(r.id)),
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
          'SELECT agent_id, name, provider, role, model, effort, tools FROM conversation_agents WHERE conversation_id = ? ORDER BY position',
        )
        .all(id) as unknown as AgentRow[]
    ).map(toAgent);

    const agentState: Record<string, AgentSessionState> = {};
    const sessions = this.db
      .prepare('SELECT agent_id, provider, session_id FROM agent_sessions WHERE conversation_id = ?')
      .all(id) as { agent_id: string; provider: Provider | null; session_id: string | null }[];
    for (const s of sessions) {
      agentState[s.agent_id] = { provider: opt(s.provider), sessionId: opt(s.session_id), seen: [] };
    }
    const seen = this.db
      .prepare('SELECT agent_id, message_id FROM agent_seen WHERE conversation_id = ?')
      .all(id) as { agent_id: string; message_id: string }[];
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

    const worktrees: Record<string, AgentWorktree> = {};
    const wtRows = this.db
      .prepare(
        'SELECT agent_id, repo_root, path, branch, base_commit, needs_reset FROM agent_worktrees WHERE conversation_id = ?',
      )
      .all(id) as { agent_id: string; repo_root: string; path: string; branch: string; base_commit: string; needs_reset: number }[];
    for (const w of wtRows) {
      worktrees[w.agent_id] = {
        root: w.repo_root,
        path: w.path,
        branch: w.branch,
        base: w.base_commit,
        needsReset: Boolean(w.needs_reset),
      };
    }

    const scheduleRow = this.db.prepare('SELECT * FROM schedules WHERE conversation_id = ?').get(id) as ScheduleRow | undefined;
    const schedule = scheduleRow && toSchedule(scheduleRow);

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
        cwd: c.cwd,
        ...(c.auto_team ? { autoTeam: true } : {}),
        ...(c.auto_confirm ? { autoConfirm: true } : {}),
        ...(c.approvals === 'deny' ? { approvals: 'deny' as const } : {}),
      },
      messages,
      agentState,
      worktrees,
      ...(c.allow_rules ? { allowRules: parseJson(c.allow_rules, []) } : {}),
      ...queueOf(c.queue, messages),
      ...pauseOf(c.pause),
      ...(schedule ? { schedule } : {}),
    };
  }

  create(conv: Conversation): void {
    transaction(this.db, () => {
      const s = conv.settings;
      this.db
        .prepare(
          `INSERT INTO conversations (id, title, created_at, updated_at, mode, rounds, max_hops, permission, cwd, auto_team,
                                     auto_confirm, approvals, allow_rules, pause)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          s.autoTeam ? 1 : 0,
          s.autoConfirm ? 1 : 0,
          nul(s.approvals),
          conv.allowRules?.length ? JSON.stringify(conv.allowRules) : null,
          conv.pause ? JSON.stringify(conv.pause) : null,
        );
      this.writeAgents(conv);
    });
    this.cache.set(conv.id, conv);
  }

  /** Persist title, timestamps, settings, the team, and where the team waits for the user's answer. */
  saveMeta(conv: Conversation): void {
    if (this.deleted.has(conv.id)) return;
    transaction(this.db, () => {
      const s = conv.settings;
      this.db
        .prepare(
          `UPDATE conversations SET title = ?, updated_at = ?, mode = ?, rounds = ?, max_hops = ?, permission = ?, cwd = ?,
             auto_team = ?, auto_confirm = ?, approvals = ?, allow_rules = ?, pause = ?
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
          s.autoTeam ? 1 : 0,
          s.autoConfirm ? 1 : 0,
          nul(s.approvals),
          conv.allowRules?.length ? JSON.stringify(conv.allowRules) : null,
          conv.pause ? JSON.stringify(conv.pause) : null,
          conv.id,
        );
      this.writeAgents(conv);
    });
  }

  private writeAgents(conv: Conversation): void {
    this.db.prepare('DELETE FROM conversation_agents WHERE conversation_id = ?').run(conv.id);
    const insert = this.db.prepare(
      `INSERT INTO conversation_agents (conversation_id, agent_id, position, name, provider, role, model, effort, tools)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    conv.agents.forEach((a, i) =>
      insert.run(conv.id, a.id, i, a.name, a.provider, a.role, nul(a.model), nul(a.effort), toolsJson(a)),
    );
  }

  /**
   * Delete a conversation. A schedule that opened it forgets it (`lastChatId`): returns the
   * conversations whose schedule did, so their open chats can be told.
   */
  delete(id: string): string[] {
    this.deleted.add(id);
    for (const key of this.savedSeen.keys()) if (key.startsWith(seenKey(id, ''))) this.savedSeen.delete(key);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.dirty.delete(id);
    this.cache.delete(id);
    const linked = (
      this.db.prepare('SELECT conversation_id FROM schedules WHERE last_chat_id = ?').all(id) as { conversation_id: string }[]
    ).map((r) => r.conversation_id);
    transaction(this.db, () => {
      this.db.prepare('UPDATE schedules SET last_chat_id = NULL WHERE last_chat_id = ?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    });
    for (const convId of linked) {
      const s = this.cache.get(convId)?.schedule;
      if (s?.lastChatId === id) delete s.lastChatId;
    }
    return linked;
  }

  /** Persist the messages waiting to be delivered. */
  saveQueue(conv: Conversation): void {
    if (this.deleted.has(conv.id)) return;
    this.db
      .prepare('UPDATE conversations SET queue = ? WHERE id = ?')
      .run(conv.queue?.length ? JSON.stringify(conv.queue) : null, conv.id);
  }

  // Schedules ----------------------------------------------------------------------

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
                                next_run_at, last_run_at, last_result, last_error, last_chat_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET text = excluded.text, repeat = excluded.repeat,
           time_zone = excluded.time_zone, lang = excluded.lang, enabled = excluded.enabled, approvals = excluded.approvals,
           missed = excluded.missed, new_chat = excluded.new_chat, updated_at = excluded.updated_at,
           next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at, last_result = excluded.last_result,
           last_error = excluded.last_error, last_chat_id = excluded.last_chat_id`,
      )
      .run(
        conv.id,
        s.text,
        JSON.stringify(s.repeat),
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
      );
  }

  /** Conversations whose schedule is on and due by `now`, the most overdue first. */
  dueSchedules(now: number): string[] {
    return (
      this.db
        .prepare('SELECT conversation_id FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at')
        .all(now) as { conversation_id: string }[]
    ).map((r) => r.conversation_id);
  }

  // Messages -------------------------------------------------------------------

  /** Queue a message for writing; `immediate` writes it (and anything else pending) now. */
  saveMessage(convId: string, msg: ChatMessage, immediate = false): void {
    if (this.deleted.has(convId)) return;
    let set = this.dirty.get(convId);
    if (!set) this.dirty.set(convId, (set = new Set()));
    set.add(msg.id);
    if (immediate) {
      this.flush(convId);
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

  flush(convId: string): void {
    clearTimeout(this.timers.get(convId));
    this.timers.delete(convId);
    const ids = this.dirty.get(convId);
    const conv = this.cache.get(convId);
    this.dirty.delete(convId);
    if (!ids?.size || !conv) return;

    try {
      this.writeMessages(convId, conv, ids);
    } catch (err) {
      // Keep them pending for the next flush.
      const pending = this.dirty.get(convId);
      if (pending) for (const id of ids) pending.add(id);
      else this.dirty.set(convId, ids);
      throw err;
    }
  }

  private writeMessages(convId: string, conv: Conversation, ids: Set<string>): void {
    const upsert = this.db.prepare(UPSERT_MESSAGE);
    const clearChanges = this.db.prepare('DELETE FROM message_changes WHERE message_id = ?');
    const insertChange = this.db.prepare(
      'INSERT INTO message_changes (message_id, idx, path, status, added, deleted) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const clearParts = this.db.prepare('DELETE FROM message_parts WHERE message_id = ?');
    const insertPart = this.db.prepare(INSERT_PART);
    transaction(this.db, () => {
      conv.messages.forEach((m, seq) => {
        if (!ids.has(m.id)) return;
        const agentId = m.author.kind === 'agent' ? m.author.agentId : null;
        const meta = m.meta ?? {};
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
          nul(m.changes?.root),
          nul(m.changes?.base),
          nul(m.changes?.head),
          m.changes ? (m.changes.isolated ? 1 : 0) : null,
          nul(m.changes?.branch),
          m.plan ? JSON.stringify(m.plan) : null,
          m.queued ? 1 : null,
          m.asked ? 1 : null,
          m.scheduled ? 1 : null,
        );
        clearChanges.run(m.id);
        m.changes?.files.forEach((f, idx) => insertChange.run(m.id, idx, f.path, f.status, f.added, f.deleted));
        clearParts.run(m.id);
        m.parts.forEach((p, idx) => insertPart.run(m.id, idx, p.type, ...partColumns(p)));
      });
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
          `INSERT INTO agent_sessions (conversation_id, agent_id, provider, session_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(conversation_id, agent_id) DO UPDATE SET provider = excluded.provider, session_id = excluded.session_id`,
        )
        .run(convId, agentId, nul(state.provider), nul(state.sessionId));
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

  saveWorktree(convId: string, agentId: string, w: AgentWorktree): void {
    if (this.deleted.has(convId)) return;
    this.db
      .prepare(
        `INSERT INTO agent_worktrees (conversation_id, agent_id, repo_root, path, branch, base_commit, needs_reset)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, agent_id) DO UPDATE SET repo_root = excluded.repo_root, path = excluded.path,
           branch = excluded.branch, base_commit = excluded.base_commit, needs_reset = excluded.needs_reset`,
      )
      .run(convId, agentId, w.root, w.path, w.branch, w.base, w.needsReset ? 1 : 0);
  }

  // --- Shared conversations (secret gists) ----------------------------------------------

  addShare(s: SharedPage): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO shares (id, conversation_id, title, up_to_message_id, up_to_agent, url, gist_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.conversationId, s.title, nul(s.upTo?.messageId), nul(s.upTo?.agentName), s.url, s.gistUrl, s.createdAt);
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

  // Groups -------------------------------------------------------------------------

  /** The user's groups, in the order they were made. (The default group, "Other", is not stored.) */
  listGroups(): ConversationGroup[] {
    return this.db.prepare('SELECT id, name FROM conversation_groups ORDER BY position, created_at').all() as unknown as ConversationGroup[];
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

  /** The sidebar group a conversation is in (`null`: the default group, "Other"). */
  groupOf(convId: string): string | null {
    const row = this.db.prepare('SELECT group_id FROM conversations WHERE id = ?').get(convId) as { group_id: string | null } | undefined;
    return row?.group_id ?? null;
  }

  /** The user puts a conversation in a group (`null`: the default group). */
  moveToGroup(convId: string, groupId: string | null): void {
    this.db.prepare("UPDATE conversations SET group_id = ?, group_source = 'user' WHERE id = ?").run(groupId, convId);
  }

  /**
   * The lead agent sorted a conversation by its first message: it goes into `groupId` (`null`: stays
   * in the default group) unless it was sorted already — the user may have moved it meanwhile — or
   * the group is gone. Returns whether it moved.
   */
  sortIntoGroup(convId: string, groupId: string | null): boolean {
    if (this.deleted.has(convId)) return false;
    const res = this.db
      .prepare(
        `UPDATE conversations SET group_id = ?, group_source = 'auto'
         WHERE id = ? AND group_source IS NULL AND (? IS NULL OR EXISTS (SELECT 1 FROM conversation_groups WHERE id = ?))`,
      )
      .run(groupId, convId, groupId, groupId);
    return res.changes > 0;
  }

  /** The conversation was put in a group already (or left in "Other" on purpose), by the user or the lead agent. */
  isSorted(convId: string): boolean {
    const row = this.db.prepare('SELECT group_source FROM conversations WHERE id = ?').get(convId) as
      | { group_source: string | null }
      | undefined;
    return Boolean(row?.group_source);
  }

  /** Titles of a group's most recent conversations (shown to the lead agent as examples of what is in it). */
  groupTitles(groupId: string, limit: number): string[] {
    return (
      this.db
        .prepare('SELECT title FROM conversations WHERE group_id = ? ORDER BY updated_at DESC LIMIT ?')
        .all(groupId, limit) as { title: string }[]
    ).map((r) => r.title);
  }

  /** The conversations' working directories, each once, the most recently used first. */
  listCwds(): string[] {
    return (
      this.db.prepare('SELECT cwd FROM conversations GROUP BY cwd ORDER BY MAX(updated_at) DESC, cwd').all() as { cwd: string }[]
    ).map((r) => r.cwd);
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
    const byConv = new Map<string, typeof hits>();
    for (const h of hits) {
      const list = byConv.get(h.conversation_id) ?? [];
      list.push(h);
      byConv.set(h.conversation_id, list);
    }
    const rows = this.db.prepare('SELECT id, title, updated_at, group_id FROM conversations').all() as {
      id: string;
      title: string;
      updated_at: number;
      group_id: string | null;
    }[];
    const results: (SearchResult & { titleMatch: boolean })[] = [];
    for (const r of rows) {
      const live = this.cache.get(r.id);
      const title = live?.title ?? r.title;
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
    }[];
    const agentStmt = this.db.prepare(
      'SELECT agent_id, name, provider, role, model, effort, tools FROM preset_agents WHERE preset_id = ? ORDER BY position',
    );
    const user = rows.map<TeamPreset>((r) => ({
      id: r.id,
      name: r.name,
      description: opt(r.description),
      agents: (agentStmt.all(r.id) as unknown as AgentRow[]).map(toAgent),
      settings: { mode: r.mode, rounds: r.rounds, maxHops: r.max_hops, permission: r.permission },
    }));
    return [...builtinPresets(currentLang()), ...user];
  }

  savePreset(p: TeamPreset): void {
    transaction(this.db, () => {
      const s = p.settings;
      this.db
        .prepare(
          `INSERT INTO presets (id, name, description, mode, rounds, max_hops, permission, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, mode = excluded.mode,
             rounds = excluded.rounds, max_hops = excluded.max_hops, permission = excluded.permission`,
        )
        .run(p.id, p.name, nul(p.description), s.mode, s.rounds, s.maxHops, s.permission, Date.now());
      this.db.prepare('DELETE FROM preset_agents WHERE preset_id = ?').run(p.id);
      const insert = this.db.prepare(
        `INSERT INTO preset_agents (preset_id, position, agent_id, name, provider, role, model, effort, tools)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      p.agents.forEach((a, i) =>
        insert.run(p.id, i, a.id, a.name, a.provider, a.role, nul(a.model), nul(a.effort), toolsJson(a)),
      );
    });
  }

  deletePreset(id: string): void {
    this.db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }
}
