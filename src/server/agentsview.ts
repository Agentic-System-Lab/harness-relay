import { basename } from 'node:path';
import type { ChatMessage, Conversation, Provider } from '../shared/types';

/*
 * AgentsView (https://www.agentsview.io) indexes the CLIs' own session transcripts. Each agent of a
 * conversation has its own session there, with every tool call and token; nothing ties them
 * together. This module sends the conversation itself as one more session — the "thread", as a
 * Claude Code transcript, the format AgentsView's upload takes — and links each agent's session
 * to it as a worker the thread started. AgentsView then lists the conversation once, with the
 * agents' sessions nested under it and their costs added up.
 */

/**
 * How AgentsView names a CLI's session: Claude Code's by its own id, Codex's and Grok's with a prefix.
 * Cursor keeps its ACP sessions in a database of its own (`acp-sessions/<id>/store.db`), which
 * AgentsView does not read, so they are not linked (undefined); its replies are in the thread.
 */
export function agentsViewSessionId(provider: Provider, sessionId: string): string | undefined {
  if (provider === 'cursor') return undefined;
  return provider === 'claude' ? sessionId : `${provider}:${sessionId}`;
}

/** The agents' current sessions in AgentsView's naming. */
export function agentSessionIds(conv: Conversation): string[] {
  const ids: string[] = [];
  for (const state of Object.values(conv.agentState)) {
    const id = state.sessionId && state.provider ? agentsViewSessionId(state.provider, state.sessionId) : undefined;
    if (id) ids.push(id);
  }
  return ids;
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
    if (m.status === 'streaming' || m.author.kind === 'system') continue;
    const text = threadText(m);
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
      const agentId = m.author.agentId;
      const agent = conv.agents.find((a) => a.id === agentId);
      const name = m.agentName ?? agent?.name ?? 'agent';
      const provider = m.provider ?? agent?.provider;
      const who = provider ? `**${name}** · ${provider}` : `**${name}**`;
      records.push({
        ...base,
        type: 'assistant',
        message: { role: 'assistant', model: 'harness-relay', content: [{ type: 'text', text: `${who}\n\n${text}` }] },
      });
    }
    parentUuid = m.id;
  }
  if (!records.length) return '';
  // Claude Code's record of /rename: AgentsView shows it as the session's name.
  if (conv.title.trim()) records.push({ type: 'custom-title', customTitle: conv.title.trim(), sessionId: conv.id });
  return records.map((r) => `${JSON.stringify(r)}\n`).join('');
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
    const id = agentsViewSessionId(provider, sessionId);
    if (!id) return;
    const ids = this.extra.get(conv.id) ?? new Set<string>();
    ids.add(id);
    this.extra.set(conv.id, ids);
  }

  forget(convId: string): void {
    this.again.delete(convId);
    this.extra.delete(convId);
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

  /** Sends the thread and links the agents' sessions (and the conversation's other sessions) to it. */
  async send(base: string, conv: Conversation): Promise<void> {
    const transcript = threadTranscript(conv);
    if (!transcript) return;
    const members = agentSessionIds(conv);
    const sessions = [...new Set([...members, ...(this.extra.get(conv.id) ?? [])])];
    // The thread goes where its agents' sessions are, so filters by project or machine keep them together.
    const where = await this.placeOf(base, members);
    const form = new FormData();
    form.append('file', new Blob([transcript], { type: 'application/octet-stream' }), `${conv.id}.jsonl`);
    const query = new URLSearchParams({
      project: where?.project || fallbackProject(conv.settings.cwd),
      machine: where?.machine || 'local',
      // Retried or edited turns remove messages: the thread may get shorter.
      allow_shorter: 'true',
    });
    await this.call(base, 'POST', `/api/v1/sessions/upload?${query}`, form);
    for (const id of sessions) {
      // Recorded even before AgentsView has read the session: the link applies once it has.
      await this.call(base, 'PUT', `/api/v1/sessions/${encodeURIComponent(id)}/parent`, JSON.stringify({ parent_session_id: conv.id }));
    }
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
