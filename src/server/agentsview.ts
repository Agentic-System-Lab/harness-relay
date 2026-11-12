import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { PROVIDER_LABEL, type ChatMessage, type Conversation, type MessagePart, type Provider } from '../shared/types';

/*
 * AgentsView (https://www.agentsview.io) indexes the CLIs' own session transcripts. Each agent of a
 * conversation has its own session there, with every tool call and token; nothing ties them
 * together. This module sends the conversation itself as one more session — the "thread", as a
 * Claude Code transcript, the format AgentsView's upload takes — and links each agent's session
 * to it as a worker the thread started. AgentsView then lists the conversation once, with the
 * agents' sessions nested under it and their costs added up.
 *
 * Where AgentsView cannot read a CLI's own sessions, Harness Relay sends that member's session
 * itself, from its own record of the conversation (`memberTranscript`), and links it the same way.
 */

/**
 * How each CLI's sessions reach AgentsView. A prefix: AgentsView reads the CLI's own sessions where
 * the CLI keeps them, and names them by the CLI's session id after that prefix (Claude Code's by the
 * id alone). `recorded`: it cannot, so the member's session is Harness Relay's record of it:
 *
 * - Cursor keeps its ACP sessions in a database alone (`acp-sessions/<id>/store.db`), and AgentsView
 *   reads Cursor's sessions only from the transcripts in `projects/<project>/agent-transcripts/`.
 * - The open agents keep each member's sessions in a folder of its own in Harness Relay's homes
 *   (`<home>/private/<key>`), and AgentsView reads only the folders its own settings list (and
 *   syncs a given path only inside them): OpenCode's, Goose's, Cline's and OpenHands' at a fixed
 *   place below each, so it would take a setting per member.
 */
export const AGENTSVIEW_SESSIONS: Record<Provider, { prefix: string } | 'recorded'> = {
  claude: { prefix: '' },
  codex: { prefix: 'codex:' },
  grok: { prefix: 'grok:' },
  // agy's conversations (`antigravity-cli/conversations/<id>.db`), AgentsView's "Antigravity CLI".
  antigravity: { prefix: 'antigravity-cli:' },
  cursor: 'recorded',
  opencode: 'recorded',
  goose: 'recorded',
  cline: 'recorded',
  openhands: 'recorded',
  pi: 'recorded',
};

/** How AgentsView names a CLI's own session; undefined for a CLI whose sessions Harness Relay records itself. */
export function agentsViewSessionId(provider: Provider, sessionId: string): string | undefined {
  const how = AGENTSVIEW_SESSIONS[provider];
  return how === 'recorded' ? undefined : `${how.prefix}${sessionId}`;
}

/** Whether a reply's session is Harness Relay's record of it rather than the CLI's own. */
export function recordedSession(provider: Provider): boolean {
  return AGENTSVIEW_SESSIONS[provider] === 'recorded';
}

/** The agents' current sessions in AgentsView's naming (those AgentsView reads itself). */
export function agentSessionIds(conv: Conversation): string[] {
  const ids: string[] = [];
  for (const state of Object.values(conv.agentState)) {
    const id = state.sessionId && state.provider ? agentsViewSessionId(state.provider, state.sessionId) : undefined;
    if (id) ids.push(id);
  }
  return ids;
}

/** A UUID-shaped id made from the parts (the same parts, the same id): valid as a session id and a record's. */
function derivedId(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The id of a member's recorded session: one per conversation and member, whatever CLI sessions it went through. */
export function memberSessionId(convId: string, agentId: string): string {
  return derivedId('harness-relay-member', convId, agentId);
}

/** A message as plain text for the thread: its text, attached files by name, a failure noted. */
function threadText(m: ChatMessage): string {
  const lines: string[] = [];
  for (const p of m.parts) {
    if (p.type === 'text' && p.text.trim()) lines.push(p.text.trim());
    else if (p.type === 'attachment') lines.push(`[${p.name}]`);
  }
  if (m.passed && !lines.length) lines.push('[PASS]');
  if (m.status === 'error' && m.error) lines.push(`(${m.error})`);
  return lines.join('\n\n');
}

/** A reply's agent and CLI: the message's snapshot, else the team's member as it is now. */
function authorOf(conv: Conversation, m: ChatMessage): { agentId: string; name: string; provider?: Provider } | undefined {
  if (m.author.kind !== 'agent') return undefined;
  const agentId = m.author.agentId;
  const agent = conv.agents.find((a) => a.id === agentId);
  return { agentId, name: m.agentName ?? agent?.name ?? 'agent', provider: m.provider ?? agent?.provider };
}

/** What the thread shows of a message: the user's text, or a reply under its agent's name and CLI ('' for nothing). */
function threadEntry(conv: Conversation, m: ChatMessage): string {
  const text = threadText(m);
  const who = authorOf(conv, m);
  if (!text || !who) return text;
  return `${who.provider ? `**${who.name}** · ${who.provider}` : `**${who.name}**`}\n\n${text}`;
}

/** Messages a transcript can show: not system notes, team designs or replies still streaming. */
const shown = (m: ChatMessage) => m.status !== 'streaming' && m.author.kind !== 'system';

const toJsonl = (records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join('');

/**
 * The conversation as a Claude Code transcript (JSONL, one record per line): the user's messages
 * as user turns and each agent's reply as an assistant turn that starts with the agent's name.
 * System notes, team designs and replies still streaming are left out. Records reuse the
 * messages' ids, so sending it again replaces the same session.
 */
export function threadTranscript(conv: Conversation): string {
  const records: unknown[] = [];
  let parentUuid: string | null = null;
  for (const m of conv.messages) {
    if (!shown(m)) continue;
    const text = threadEntry(conv, m);
    if (!text) continue;
    const base = {
      uuid: m.id,
      parentUuid,
      sessionId: conv.id,
      timestamp: new Date(m.createdAt).toISOString(),
      cwd: conv.settings.cwd,
      isSidechain: false,
      userType: 'external',
    };
    if (m.author.kind === 'user') {
      records.push({ ...base, type: 'user', message: { role: 'user', content: text } });
    } else {
      records.push({
        ...base,
        type: 'assistant',
        message: { role: 'assistant', model: 'harness-relay', content: [{ type: 'text', text }] },
      });
    }
    parentUuid = m.id;
  }
  if (!records.length) return '';
  // Claude Code's record of /rename: AgentsView shows it as the session's name.
  if (conv.title.trim()) records.push({ type: 'custom-title', customTitle: conv.title.trim(), sessionId: conv.id });
  return toJsonl(records);
}

const APPROVAL_ASK: Record<Extract<MessagePart, { type: 'approval' }>['kind'], string> = {
  command: 'run',
  edit: 'edit',
  fetch: 'fetch',
  other: 'use',
};
const APPROVAL_ANSWER: Record<Extract<MessagePart, { type: 'approval' }>['status'], string> = {
  pending: 'not answered',
  allowed: 'allowed',
  denied: 'declined',
  expired: 'expired',
};
const PLAN_MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const;

/** A part of a reply that is not a tool call, as a block of a Claude Code assistant message (none for nothing). */
function replyBlock(p: Exclude<MessagePart, { type: 'tool' }>): Record<string, unknown> | undefined {
  switch (p.type) {
    case 'text':
      return p.text.trim() ? { type: 'text', text: p.text.trim() } : undefined;
    case 'thinking':
      return p.text.trim() ? { type: 'thinking', thinking: p.text.trim() } : undefined;
    case 'plan':
      return p.entries.length ? { type: 'text', text: ['Plan:', ...p.entries.map((e) => `${PLAN_MARK[e.status]} ${e.text}`)].join('\n') } : undefined;
    case 'approval': {
      const what = [p.kind === 'other' ? (p.tool ?? 'a tool') : '', p.detail ? `\`${p.detail}\`` : ''].filter(Boolean).join(' ');
      const answer = `${APPROVAL_ANSWER[p.status]}${p.always ? ' for the rest of the conversation' : ''}${p.note ? `: "${p.note}"` : ''}`;
      return { type: 'text', text: `[Asked to ${APPROVAL_ASK[p.kind]}${what ? ` ${what}` : ''}: ${answer}]` };
    }
    case 'attachment':
      return { type: 'text', text: `[${p.name}]` };
  }
}

/**
 * A reply as Claude Code records it: assistant messages with its thinking, text and tool calls, each
 * group of tool calls followed by a user message with their results (the end of their output, as
 * the chat keeps it, or why they failed). A [PASS] and a failure are noted at the end.
 */
function replyRecords(m: ChatMessage, model: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let content: unknown[] = [];
  let results: unknown[] = [];
  const flush = () => {
    if (content.length) out.push({ type: 'assistant', message: { role: 'assistant', model, content } });
    if (results.length) out.push({ type: 'user', message: { role: 'user', content: results } });
    content = [];
    results = [];
  };
  let said = false;
  m.parts.forEach((p, i) => {
    if (p.type === 'tool') {
      const id = `toolu_${createHash('sha256').update(`${m.id}\0${i}\0${p.id}`).digest('hex').slice(0, 24)}`;
      content.push({ type: 'tool_use', id, name: p.name, input: p.detail ? { detail: p.detail } : {} });
      const result = (p.status === 'error' ? [p.error, p.output] : [p.output]).filter((x) => x?.trim()).join('\n\n');
      results.push({ type: 'tool_result', tool_use_id: id, content: result, ...(p.status === 'error' ? { is_error: true } : {}) });
      return;
    }
    const block = replyBlock(p);
    if (!block) return;
    // What the agent says after its tool calls comes after their results.
    if (results.length) flush();
    content.push(block);
    if (p.type === 'text') said = true;
  });
  const tail: string[] = [];
  if (m.passed && !said) tail.push('[PASS]');
  if (m.status === 'error' && m.error) tail.push(`(${m.error})`);
  if (tail.length) {
    if (results.length) flush();
    content.push({ type: 'text', text: tail.join('\n\n') });
  }
  flush();
  return out;
}

/** Dollars to the microdollar, AgentsView's unit of money. */
const dollars = (usd: number) => Math.round(usd * 1e6) / 1e6;

/**
 * A member's own session as Harness Relay recorded it, for its replies on a CLI whose sessions
 * AgentsView cannot read (`AGENTSVIEW_SESSIONS`), as a Claude Code transcript: before each of those
 * replies, a user turn with what was said since its last one (the user's messages and the other
 * agents' replies, as the thread shows them); then the reply itself (`replyRecords`), its last
 * assistant message carrying the reply's tokens (`message.usage`, which AgentsView counts, and
 * prices when its catalog knows the model); at the end the cost the CLIs reported (Claude Code's
 * `cost-state` record, the session's total, which AgentsView keeps apart from its own figures and
 * shows beside them, never adding it to them) and a name: the member's name and CLI, and the
 * conversation's title. One session per
 * member, whatever CLI sessions it went through. Records get ids of their own (derived, so sending it
 * again replaces the same session), never the messages' ids the thread uses. Empty while it has no
 * such reply.
 */
export function memberTranscript(conv: Conversation, agentId: string): string {
  const sessionId = memberSessionId(conv.id, agentId);
  const records: unknown[] = [];
  let parentUuid: string | null = null;
  let heard: string[] = [];
  let last: { name: string; provider: Provider } | undefined;
  const usage = new Map<string, { inputTokens: number; outputTokens: number; costUSD: number }>();
  let total = 0;
  let unknownCost = false;
  const member = conv.agents.find((a) => a.id === agentId);
  for (const m of conv.messages) {
    if (!shown(m)) continue;
    const who = authorOf(conv, m);
    if (who?.agentId !== agentId || !who.provider || !recordedSession(who.provider)) {
      const text = threadEntry(conv, m);
      if (text) heard.push(text);
      continue;
    }
    const provider = who.provider;
    // The member's model, while it is still on this CLI; else the CLI (its default model, or one since changed).
    const model = (member?.provider === provider && member.model?.trim()) || provider;
    const reply = replyRecords(m, model);
    if (!reply.length) continue;
    const meta = m.meta;
    const lastAssistant = reply.findLast((r) => r.type === 'assistant') as { message: Record<string, unknown> } | undefined;
    if (lastAssistant && (meta?.inputTokens || meta?.outputTokens)) {
      lastAssistant.message.usage = { input_tokens: meta.inputTokens ?? 0, output_tokens: meta.outputTokens ?? 0 };
    }
    const turn = heard.length ? [{ type: 'user', message: { role: 'user', content: heard.join('\n\n') } }, ...reply] : reply;
    turn.forEach((r, n) => {
      const uuid = derivedId(sessionId, m.id, String(n));
      records.push({
        uuid,
        parentUuid,
        sessionId,
        timestamp: new Date(m.createdAt).toISOString(),
        cwd: conv.settings.cwd,
        isSidechain: false,
        userType: 'external',
        ...r,
      });
      parentUuid = uuid;
    });
    heard = [];
    last = { name: who.name, provider };
    if (meta && (meta.inputTokens || meta.outputTokens || meta.costUsd)) {
      const u = usage.get(model) ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
      u.inputTokens += meta.inputTokens ?? 0;
      u.outputTokens += meta.outputTokens ?? 0;
      if (meta.costUsd !== undefined) {
        u.costUSD += meta.costUsd;
        total += meta.costUsd;
      } else unknownCost = true;
      usage.set(model, u);
    }
  }
  if (!last) return '';
  if (usage.size) {
    records.push({
      type: 'cost-state',
      sessionId,
      totalCostUSD: dollars(total),
      hasUnknownModelCost: unknownCost,
      modelUsage: Object.fromEntries([...usage].map(([model, u]) => [model, { ...u, costUSD: dollars(u.costUSD) }])),
    });
  }
  const title = conv.title.trim();
  records.push({ type: 'custom-title', customTitle: `${last.name} · ${PROVIDER_LABEL[last.provider]}${title ? ` — ${title}` : ''}`, sessionId });
  return toJsonl(records);
}

/** The members' recorded sessions (those with a reply on a CLI AgentsView cannot read), in the order they first replied. */
export function memberTranscripts(conv: Conversation): { id: string; transcript: string }[] {
  const members: string[] = [];
  for (const m of conv.messages) {
    const who = shown(m) ? authorOf(conv, m) : undefined;
    if (who?.provider && recordedSession(who.provider) && !members.includes(who.agentId)) members.push(who.agentId);
  }
  return members
    .map((agentId) => ({ id: memberSessionId(conv.id, agentId), transcript: memberTranscript(conv, agentId) }))
    .filter((s) => s.transcript);
}

/** Where the thread goes when none of its agents' sessions is in AgentsView yet. */
export function fallbackProject(cwd: string): string {
  return basename(cwd) || 'harness-relay';
}

type Fetch = typeof fetch;

/** What the orchestrator tells about a conversation (AgentsView when its address is set). */
export interface TraceSink {
  /** The conversation changed (a turn or a run ended): send it. */
  schedule(conv: Conversation): void;
  /** A session the conversation started besides its members' (the lead agent's, the group sorter's): link it too. */
  link?(conv: Conversation, provider: Provider, sessionId: string): void;
  /** The conversation is being deleted: drop what is still waiting to be sent. */
  forget?(convId: string): void;
}

/**
 * Keeps AgentsView up to date with the conversations: after a change, the thread is sent again and
 * the agents' sessions linked to it. One update runs at a time per conversation; changes made
 * meanwhile are sent once it finishes. Failures never reach the chat: the last one is kept for
 * the settings page.
 */
export class AgentsViewSync implements TraceSink {
  /** The last failure and the address it happened at. */
  private failure?: { base: string; message: string };
  private running = new Map<string, Promise<void>>();
  private again = new Set<string>();
  /** Conversations being deleted while an update runs: nothing more is sent for them. */
  private forgotten = new Set<string>();
  /** Sessions to link besides the members' current ones, by conversation (kept until the server stops). */
  private extra = new Map<string, Set<string>>();
  /**
   * The recorded sessions as last sent, by conversation: a hash of each by address and session, so
   * one that has not changed since (a member who did not reply) is not sent again.
   */
  private sent = new Map<string, Map<string, string>>();

  constructor(
    /** AgentsView's origin; empty = off. Read at every update, so a settings change applies at once. */
    private url: () => string,
    private fetchImpl: Fetch = fetch,
    private timeoutMs = 15_000,
  ) {}

  /** Why the last update to the current address failed; undefined after one that worked, or for another address. */
  get error(): string | undefined {
    const base = this.url();
    return base && this.failure?.base === base ? this.failure.message : undefined;
  }

  schedule(conv: Conversation): void {
    if (!this.url()) return;
    if (this.running.has(conv.id)) {
      this.again.add(conv.id);
      return;
    }
    this.running.set(conv.id, this.drain(conv));
  }

  link(conv: Conversation, provider: Provider, sessionId: string): void {
    // A session on a CLI AgentsView cannot read: Harness Relay has no record of it to send instead.
    const id = agentsViewSessionId(provider, sessionId);
    if (!id) return;
    const ids = this.extra.get(conv.id) ?? new Set<string>();
    ids.add(id);
    this.extra.set(conv.id, ids);
  }

  forget(convId: string): void {
    this.again.delete(convId);
    this.extra.delete(convId);
    this.sent.delete(convId);
    if (this.running.has(convId)) this.forgotten.add(convId);
  }

  /** Waits until no update is running (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  private async drain(conv: Conversation): Promise<void> {
    // Let schedule() register this run first: a drain that ends at once must not leave it registered.
    await undefined;
    try {
      do {
        this.again.delete(conv.id);
        const base = this.url();
        if (!base || this.forgotten.has(conv.id)) return;
        try {
          await this.send(base, conv);
          if (this.failure?.base === base) this.failure = undefined;
        } catch (err) {
          this.failure = { base, message: (err as Error).message };
          console.warn(`[agentsview] could not update ${conv.id}: ${this.failure.message}`);
        }
      } while (this.again.has(conv.id));
    } finally {
      // In the same step as the last check: a schedule() from now on starts a new drain.
      this.running.delete(conv.id);
      this.forgotten.delete(conv.id);
    }
  }

  /**
   * Sends the thread, then the members' sessions Harness Relay records (`memberTranscripts`) in the
   * same project and machine, then links the agents' sessions (and the conversation's other
   * sessions, and the recorded ones) to it. A thread that cannot be sent stops the update; past
   * that, one session that fails (AgentsView refuses a session the user moved to its trash, say)
   * keeps none of the others from being sent and linked, and the first failure is reported once
   * all have been tried.
   */
  async send(base: string, conv: Conversation): Promise<void> {
    const transcript = threadTranscript(conv);
    if (!transcript) return;
    const members = agentSessionIds(conv);
    // The thread goes where its agents' sessions are, so filters by project or machine keep them together.
    const where = await this.placeOf(base, members);
    const query = new URLSearchParams({
      project: where?.project || fallbackProject(conv.settings.cwd),
      machine: where?.machine || 'local',
      // Retried or edited turns remove messages: the thread may get shorter.
      allow_shorter: 'true',
    });
    const upload = async (id: string, jsonl: string) => {
      const form = new FormData();
      form.append('file', new Blob([jsonl], { type: 'application/octet-stream' }), `${id}.jsonl`);
      await this.call(base, 'POST', `/api/v1/sessions/upload?${query}`, form);
    };
    await upload(conv.id, transcript);

    let failure: unknown;
    const sent = this.sent.get(conv.id) ?? new Map<string, string>();
    this.sent.set(conv.id, sent);
    const recorded: string[] = [];
    for (const r of memberTranscripts(conv)) {
      const key = `${base}\0${r.id}`;
      const hash = createHash('sha256').update(r.transcript).digest('hex');
      try {
        if (sent.get(key) !== hash) {
          await upload(r.id, r.transcript);
          sent.set(key, hash);
        }
        recorded.push(r.id);
      } catch (err) {
        failure ??= err;
      }
    }
    for (const id of new Set([...members, ...(this.extra.get(conv.id) ?? []), ...recorded])) {
      try {
        // Recorded even before AgentsView has read the session: the link applies once it has.
        await this.call(base, 'PUT', `/api/v1/sessions/${encodeURIComponent(id)}/parent`, JSON.stringify({ parent_session_id: conv.id }));
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure) throw failure;
  }

  /** Project and machine of the first agent session AgentsView knows. */
  private async placeOf(base: string, sessions: string[]): Promise<{ project?: string; machine?: string } | undefined> {
    for (const id of sessions) {
      const res = await this.request(base, 'GET', `/api/v1/sessions/${encodeURIComponent(id)}`);
      if (!res.ok) continue;
      const s = (await res.json().catch(() => undefined)) as { project?: unknown; machine?: unknown } | undefined;
      if (typeof s?.project === 'string' && s.project) {
        return { project: s.project, machine: typeof s.machine === 'string' ? s.machine : undefined };
      }
    }
    return undefined;
  }

  /** One request; a network failure names the address and its cause (e.g. ECONNREFUSED: AgentsView is not running). */
  private async request(base: string, method: string, path: string, body?: BodyInit): Promise<Response> {
    const headers: Record<string, string> = {};
    if (method !== 'GET') {
      // AgentsView refuses writes without its own origin (its cross-site check).
      headers.Origin = base;
      if (typeof body === 'string') headers['Content-Type'] = 'application/json';
    }
    try {
      // Never follow a redirect: the conversation must not leave this computer.
      return await this.fetchImpl(`${base}${path}`, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`${base}: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
    }
  }

  private async call(base: string, method: string, path: string, body?: BodyInit): Promise<void> {
    const res = await this.request(base, method, path, body);
    if (res.ok) return;
    let detail = '';
    try {
      const b = (await res.json()) as { error?: unknown; detail?: unknown };
      detail = String(b.error ?? b.detail ?? '');
    } catch {
      /* not JSON */
    }
    throw new Error(`${method} ${path.split('?')[0]}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
  }
}
