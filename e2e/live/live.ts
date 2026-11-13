/**
 * What the live tests share: which model servers and CLIs the environment names, and a turn run
 * through the server's API with its approvals answered.
 *
 * - E2E_LIVE_OLLAMA: an Ollama (or any OpenAI-compatible) server's base URL, such as
 *   http://127.0.0.1:11434/v1; E2E_LIVE_OLLAMA_MODEL its model (default gemma4:e4b), and
 *   E2E_LIVE_OLLAMA_TYPED another model it serves, for a model typed for the endpoint.
 * - E2E_LIVE_VLLM, E2E_LIVE_VLLM_MODEL, E2E_LIVE_VLLM_KEY: a vLLM server, its model and its key.
 * - E2E_LIVE_CLIS: the CLIs to try, comma-separated (default: all eleven).
 * - E2E_LIVE_CLOUD=1: also the CLIs' own cloud models (Claude Code's, Codex's, Grok's, Cursor's,
 *   Antigravity's and Copilot's), which the user's sign-ins pay for.
 * - E2E_LIVE_MODEL_<CLI> (E2E_LIVE_MODEL_ANTIGRAVITY=gemini-3.8-flash, say): a model of that CLI's own,
 *   picked in Team settings for its cloud tests; unset, its default model.
 */
import { expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Conversation, ConversationSettings, Provider } from '../../src/shared/types';
import type { RelayServer } from '../support/relay';

export interface LiveEndpoint {
  id: 'ollama' | 'vllm';
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

const env = process.env;
export const ENDPOINTS: LiveEndpoint[] = [
  ...(env.E2E_LIVE_OLLAMA ? [{ id: 'ollama' as const, name: 'Ollama', baseUrl: env.E2E_LIVE_OLLAMA, model: env.E2E_LIVE_OLLAMA_MODEL || 'gemma4:e4b' }] : []),
  ...(env.E2E_LIVE_VLLM
    ? [{ id: 'vllm' as const, name: 'vLLM', baseUrl: env.E2E_LIVE_VLLM, model: env.E2E_LIVE_VLLM_MODEL || 'default', ...(env.E2E_LIVE_VLLM_KEY ? { apiKey: env.E2E_LIVE_VLLM_KEY } : {}) }]
    : []),
];
export const TYPED_MODEL = env.E2E_LIVE_OLLAMA_TYPED;
export const CLOUD = env.E2E_LIVE_CLOUD === '1';
export const CLIS = (env.E2E_LIVE_CLIS || 'claude,codex,grok,cursor,antigravity,copilot,opencode,goose,cline,openhands,pi').split(',').map((c) => c.trim()) as Provider[];
export const OPEN = ['opencode', 'goose', 'cline', 'openhands', 'pi'] as const;
export const ENDPOINT_CLIS = ['claude', 'codex', 'grok', 'copilot'] as const;
/** The CLIs with models of their own service (Cursor and Antigravity have nothing else: no endpoints). */
export const CLOUD_CLIS = ['claude', 'codex', 'grok', 'cursor', 'antigravity', 'copilot'] as const;
/** A model of the CLI's own to pick for its cloud tests (`E2E_LIVE_MODEL_<CLI>`), or undefined: its default. */
export const ownModel = (p: Provider): string | undefined => env[`E2E_LIVE_MODEL_${p.toUpperCase()}`] || undefined;
/**
 * Who runs only with full access: the open agents on native Windows (Harness Relay's own sandbox is not
 * there), and OpenCode on Linux (Harness Relay cannot watch its server in the sandbox's own network).
 */
const fullOnly = (p: Provider) => (process.platform === 'win32' && (OPEN as readonly string[]).includes(p)) || (process.platform === 'linux' && p === 'opencode');
/** The permission a member that only answers runs with. */
export const askPermission = (p: Provider): ConversationSettings['permission'] => (fullOnly(p) ? 'full' : 'read-only');
/** The permission a member that writes runs with. */
export const editPermission = (p: Provider): ConversationSettings['permission'] => (fullOnly(p) ? 'full' : 'edit');
export const has = (p: Provider) => CLIS.includes(p);
export const modelId = (e: LiveEndpoint) => `${e.id}/${e.model}`;
/** The endpoint a member's model is on (`<endpoint>/<model>`), or undefined for a model of the CLI's own. */
export const endpointOf = (model: string | undefined): string | undefined => ENDPOINTS.find((e) => model?.startsWith(`${e.id}/`))?.id;

/**
 * The backend the member's session was made on (`agent_sessions.backend`: an endpoint's id; undefined:
 * the CLI's own service), as the server recorded it: that the turn ran on the user's own server, not
 * on the CLI's cloud. Read from the test's own database, which the server keeps open.
 */
export function sessionBackend(relay: RelayServer, conversationId: string, agentId: string): string | undefined {
  const db = new DatabaseSync(join(relay.dataDir, 'relay.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT backend FROM agent_sessions WHERE conversation_id = ? AND agent_id = ?').get(conversationId, agentId) as { backend: string | null } | undefined;
    return row?.backend ?? undefined;
  } finally {
    db.close();
  }
}

/**
 * The endpoints, set up in the server's Settings; and OpenHands let use a terminal in the sandbox, as
 * it must be to run below full access (Settings → OpenHands).
 */
export async function setUpEndpoints(relay: RelayServer): Promise<void> {
  for (const e of ENDPOINTS) {
    await relay.api(`/api/backends/endpoints/${e.id}`, { method: 'PUT', body: { name: e.name, baseUrl: e.baseUrl, models: [e.model], apiKey: e.apiKey ?? null } });
  }
  if (has('openhands')) await relay.api('/api/settings/providers/openhands', { method: 'PUT', body: { sandboxTerminal: true } });
}

export interface LiveMember {
  provider: Provider;
  model?: string;
  name?: string;
}

export interface TurnResult {
  conv: Conversation;
  /** Each member's last reply: its status, error and text. */
  replies: { name: string; status: string; error?: string; text: string }[];
  /** The approvals asked, as answered. */
  approvals: { kind: string; detail?: string; reason?: string; allowed: boolean }[];
  /** The tools the members called, as `<name> <detail> (<status>: <error or the end of its output>)`: for the messages of failed checks. */
  tools: string[];
}

/**
 * A folder for a test outside the system's temporary folders, in the user's home, which `remove()`
 * deletes: Cursor's own tools write in a temporary folder without asking.
 */
export function homeFolder(): { dir: string; remove(): void } {
  const dir = realpathSync.native(mkdtempSync(join(homedir(), '.relay-e2e-live-')));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) };
}

/** A folder of its own for a test, under the server's temporary folder. */
export function folder(relay: RelayServer, name: string): string {
  const dir = join(relay.root, 'live', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Whether a live test allows what a member asks: only what the tests ask for, a command that writes
 * `hi` into a file (`echo hi > …`), and a write in the chat's own folders. Anything else is refused,
 * since the CLIs run with the user's own homes and sign-ins.
 */
export function liveAllows(a: { kind: string; detail?: string }, folders: readonly string[]): boolean {
  const detail = a.detail ?? '';
  if (a.kind === 'command') return /\becho hi >/.test(detail);
  if (a.kind === 'edit') {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    return folders.some((f) => norm(detail).startsWith(`${norm(f)}/`));
  }
  return false;
}

/**
 * Sends one message to a new chat of these members and waits until the team is done, answering each
 * approval (`liveAllows`).
 */
export async function liveTurn(
  relay: RelayServer,
  members: LiveMember[],
  text: string,
  settings: Partial<ConversationSettings> & { cwd: string },
): Promise<TurnResult> {
  const conv = await relay.api<Conversation>('/api/conversations', {
    body: {
      title: text.slice(0, 40),
      agents: members.map((m, i) => ({ id: `m${i + 1}`, name: m.name ?? `Member${i + 1}`, provider: m.provider, role: '', ...(m.model ? { model: m.model } : {}) })),
      settings: { mode: 'roundtable', rounds: 1, maxHops: 2, permission: 'read-only', approvals: 'ask', ...settings },
    },
  });
  await relay.api(`/api/conversations/${conv.id}/messages`, { body: { text } });
  const approvals: TurnResult['approvals'] = [];
  const answered = new Set<string>();
  let current = conv;
  await expect
    .poll(
      async () => {
        current = await relay.api<Conversation>(`/api/conversations/${conv.id}`);
        for (const m of current.messages) {
          for (const p of m.parts) {
            if (p.type !== 'approval' || p.status !== 'pending' || answered.has(p.id)) continue;
            answered.add(p.id);
            const allowed = liveAllows(p, [settings.cwd, ...(settings.extraCwds ?? [])]);
            approvals.push({ kind: p.kind, detail: p.detail, reason: p.reason, allowed });
            await relay.api(`/api/conversations/${conv.id}/approvals/${p.id}`, { body: { allow: allowed } });
          }
        }
        const list = await relay.api<{ id: string; running?: boolean }[]>('/api/conversations');
        const running = list.find((c) => c.id === conv.id)?.running;
        const agentMessages = current.messages.filter((m) => m.author.kind === 'agent');
        return !running && agentMessages.length > 0 && agentMessages.every((m) => m.status !== 'streaming');
      },
      { timeout: 15 * 60_000, intervals: [2_000] },
    )
    .toBe(true);
  const replies = current.agents.map((a) => {
    const m = current.messages.filter((x) => x.author.kind === 'agent' && x.author.agentId === a.id).at(-1);
    const text = (m?.parts ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
    return { name: a.name, status: m?.status ?? 'none', ...(m?.error ? { error: m.error } : {}), text };
  });
  const tools = current.messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'tool' ? [`${p.name} ${p.detail ?? ''} (${p.status}${p.error || p.output ? `: ${(p.error || p.output || '').replace(/\s+/g, ' ').slice(-200)}` : ''})`] : [])));
  return { conv: current, replies, approvals, tools };
}
