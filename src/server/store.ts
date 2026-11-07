import type {
  AgentConfig,
  AgentSessionState,
  AgentWorktree,
  FileChange,
  MessageChanges,
  ChatMessage,
  Conversation,
  ConversationSummary,
  MessagePart,
  Mode,
  Permission,
  Provider,
  TeamPlan,
  TeamPreset,
  ToolStatus,
  MessageStatus,
} from '../shared/types';
import { nul, transaction, type Database } from './db';
import { currentLang } from './i18n';
import { builtinPresets } from './presets';

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
  approvals: string | null;
  allow_rules: string | null;
}

interface AgentRow {
  agent_id: string;
  name: string;
  provider: Provider;
  role: string;
  model: string | null;
  effort: string | null;
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
  return { id: r.agent_id, name: r.name, provider: r.provider, role: r.role, model: opt(r.model), effort: opt(r.effort) };
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
  };
}

/** The latest agent reply's status, from memory when the conversation is open (it may be streaming). */
function statusOf(live: Conversation | undefined, stored: MessageStatus | undefined): { lastStatus?: MessageStatus } {
  const last = live ? [...live.messages].reverse().find((m) => m.author.kind === 'agent')?.status : stored;
  return last ? { lastStatus: last } : {};
}

function parsePlan(json: string | null): TeamPlan | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as TeamPlan;
  } catch {
    return undefined;
  }
}

/**
 * SQLite-backed persistence. Conversations being used are kept in memory (the orchestrator mutates
 * them while streaming); changes are written back explicitly, message writes debounced.
 */
export class Store {
  private cache = new Map<string, Conversation>();
  private dirty = new Map<string, Set<string>>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private db: Database) {
    // A previous server process died mid-turn.
    db.prepare("UPDATE messages SET status = 'aborted' WHERE status = 'streaming'").run();
  }

  // Conversations ------------------------------------------------------------

  list(running: (id: string) => boolean, waiting: (id: string) => boolean = () => false): ConversationSummary[] {
    const rows = this.db
      .prepare('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC')
      .all() as Pick<ConversationRow, 'id' | 'title' | 'updated_at'>[];
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
          ...statusOf(live, lastStatus.get(r.id)),
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
          'SELECT agent_id, name, provider, role, model, effort FROM conversation_agents WHERE conversation_id = ? ORDER BY position',
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
        ...(c.approvals === 'deny' ? { approvals: 'deny' as const } : {}),
      },
      messages,
      agentState,
      worktrees,
      ...(c.allow_rules ? { allowRules: parseJson(c.allow_rules, []) } : {}),
    };
  }

  create(conv: Conversation): void {
    transaction(this.db, () => {
      const s = conv.settings;
      this.db
        .prepare(
          `INSERT INTO conversations (id, title, created_at, updated_at, mode, rounds, max_hops, permission, cwd, auto_team,
                                     approvals, allow_rules)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          nul(s.approvals),
          conv.allowRules?.length ? JSON.stringify(conv.allowRules) : null,
        );
      this.writeAgents(conv);
    });
    this.cache.set(conv.id, conv);
  }

  /** Persist title, timestamps, settings and the team. */
  saveMeta(conv: Conversation): void {
    transaction(this.db, () => {
      const s = conv.settings;
      this.db
        .prepare(
          `UPDATE conversations SET title = ?, updated_at = ?, mode = ?, rounds = ?, max_hops = ?, permission = ?, cwd = ?,
             auto_team = ?, approvals = ?, allow_rules = ?
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
          nul(s.approvals),
          conv.allowRules?.length ? JSON.stringify(conv.allowRules) : null,
          conv.id,
        );
      this.writeAgents(conv);
    });
  }

  private writeAgents(conv: Conversation): void {
    this.db.prepare('DELETE FROM conversation_agents WHERE conversation_id = ?').run(conv.id);
    const insert = this.db.prepare(
      `INSERT INTO conversation_agents (conversation_id, agent_id, position, name, provider, role, model, effort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    conv.agents.forEach((a, i) =>
      insert.run(conv.id, a.id, i, a.name, a.provider, a.role, nul(a.model), nul(a.effort)),
    );
  }

  delete(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.dirty.delete(id);
    this.cache.delete(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  // Messages -------------------------------------------------------------------

  /** Queue a message for writing; `immediate` writes it (and anything else pending) now. */
  saveMessage(convId: string, msg: ChatMessage, immediate = false): void {
    let set = this.dirty.get(convId);
    if (!set) this.dirty.set(convId, (set = new Set()));
    set.add(msg.id);
    if (immediate) {
      this.flush(convId);
    } else if (!this.timers.has(convId)) {
      // Streaming changes a message many times per second; batch them.
      this.timers.set(
        convId,
        setTimeout(() => this.flush(convId), 1000),
      );
    }
  }

  flush(convId: string): void {
    clearTimeout(this.timers.get(convId));
    this.timers.delete(convId);
    const ids = this.dirty.get(convId);
    const conv = this.cache.get(convId);
    this.dirty.delete(convId);
    if (!ids?.size || !conv) return;

    const upsert = this.db.prepare(
      `INSERT INTO messages (id, conversation_id, seq, author_kind, agent_id, agent_name, provider, created_at,
                             status, passed, error, round, duration_ms, cost_usd, input_tokens, output_tokens,
                             change_root, change_base, change_head, change_isolated, change_branch, plan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         seq = excluded.seq, status = excluded.status, passed = excluded.passed, error = excluded.error,
         round = excluded.round, duration_ms = excluded.duration_ms, cost_usd = excluded.cost_usd,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         change_root = excluded.change_root, change_base = excluded.change_base, change_head = excluded.change_head,
         change_isolated = excluded.change_isolated, change_branch = excluded.change_branch, plan = excluded.plan`,
    );
    const clearChanges = this.db.prepare('DELETE FROM message_changes WHERE message_id = ?');
    const insertChange = this.db.prepare(
      'INSERT INTO message_changes (message_id, idx, path, status, added, deleted) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const clearParts = this.db.prepare('DELETE FROM message_parts WHERE message_id = ?');
    const insertPart = this.db.prepare(
      `INSERT INTO message_parts (message_id, idx, type, text, tool_id, tool_name, tool_detail, tool_status, tool_error,
                                  tool_output, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

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
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO agent_sessions (conversation_id, agent_id, provider, session_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(conversation_id, agent_id) DO UPDATE SET provider = excluded.provider, session_id = excluded.session_id`,
        )
        .run(convId, agentId, nul(state.provider), nul(state.sessionId));
      this.db.prepare('DELETE FROM agent_seen WHERE conversation_id = ? AND agent_id = ?').run(convId, agentId);
      const insert = this.db.prepare('INSERT OR IGNORE INTO agent_seen (conversation_id, agent_id, message_id) VALUES (?, ?, ?)');
      for (const m of state.seen) insert.run(convId, agentId, m);
    });
  }

  // Worktrees ----------------------------------------------------------------------

  saveWorktree(convId: string, agentId: string, w: AgentWorktree): void {
    this.db
      .prepare(
        `INSERT INTO agent_worktrees (conversation_id, agent_id, repo_root, path, branch, base_commit, needs_reset)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, agent_id) DO UPDATE SET repo_root = excluded.repo_root, path = excluded.path,
           branch = excluded.branch, base_commit = excluded.base_commit, needs_reset = excluded.needs_reset`,
      )
      .run(convId, agentId, w.root, w.path, w.branch, w.base, w.needsReset ? 1 : 0);
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
      'SELECT agent_id, name, provider, role, model, effort FROM preset_agents WHERE preset_id = ? ORDER BY position',
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
        `INSERT INTO preset_agents (preset_id, position, agent_id, name, provider, role, model, effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      p.agents.forEach((a, i) => insert.run(p.id, i, a.id, a.name, a.provider, a.role, nul(a.model), nul(a.effort)));
    });
  }

  deletePreset(id: string): void {
    this.db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }
}
