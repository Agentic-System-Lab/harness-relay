import { readFileSync, statSync } from 'node:fs';
import type { ApprovalAnswer, ApprovalKind, NativeItemsOff, NativePart, Permission, PlanEntry, Provider } from '../../shared/types';

/** Normalised events every CLI adapter emits while an agent is working. */
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  /** A chunk of reply text. Consecutive chunks belong to the same text block. */
  | { type: 'text'; text: string }
  /** The current text block is finished; the next `text` starts a new block. */
  | { type: 'text_end' }
  /** A chunk of the agent's reasoning (consecutive chunks join up). */
  | { type: 'thinking'; text: string }
  /** The agent's plan / to-do list, replacing the previous one. */
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'tool_start'; id: string; name: string; detail?: string }
  /**
   * `error`: the CLI's stated reason when a call failed or was refused (shown under the tool).
   * `output`: the end of what the call returned.
   * `detail`: what the call was about, when the CLI only says so once it is done (a web search's
   * query); it replaces the one from `tool_start`.
   */
  | { type: 'tool_end'; id: string; ok: boolean; error?: string; output?: string; detail?: string };

/** Something an agent wants to do that its permission does not cover. */
export interface ApprovalRequest {
  kind: ApprovalKind;
  /** The command, file path or URL. */
  detail?: string;
  /** The agent's own description of why / what (often its tool-call description). */
  reason?: string;
  /** The tool's name, for kind "other". */
  tool?: string;
  /** The command exactly as the CLI will run it, when `detail` is a tidied-up form for display. */
  command?: string;
}

export interface RunOptions {
  bin: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  /** Role briefing, injected through each CLI's system-prompt mechanism. */
  systemPrompt: string;
  /** Resume this CLI session; when absent a new session is started. */
  sessionId?: string;
  cwd: string;
  permission: Permission;
  model?: string;
  /** Reasoning effort (e.g. low / medium / high / xhigh); undefined = the CLI's default. */
  effort?: string;
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;
  /**
   * Ask the user about something the permission does not cover; resolves with their answer.
   * Absent when the conversation refuses such requests automatically.
   */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
  /** Images the user attached to the messages in this prompt, passed to the CLI as images. */
  images?: { path: string; mimeType: string }[];
  /** Folder holding the conversation's attached files (their paths are listed in the prompt). */
  attachmentsDir?: string;
  /** MCP servers from Harness Relay's tool library, besides the CLI's own. */
  mcpServers?: McpServerSpec[];
  /** Folders outside the working directory the agent may read (its skills). */
  readDirs?: string[];
  /** What the CLI loads by itself to leave out of this run, all of a kind (its own skills, MCP servers…). */
  nativeOff?: readonly NativePart[];
  /** Single items of what the CLI loads by itself to leave out of this run. */
  nativeItems?: NativeItemsOff;
}

/** An MCP server to hand to a CLI, with its secret values. */
export interface McpServerSpec {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
}

/**
 * An attached image as base64, or undefined when it is missing or too large to send inline
 * (the agent can still read it from its path). The default limit keeps it under the Anthropic
 * API's 5 MB per image once base64-encoded.
 */
export function imageData(path: string, maxBytes = 3_750_000): string | undefined {
  try {
    if (statSync(path).size > maxBytes) return undefined;
    return readFileSync(path).toString('base64');
  } catch {
    return undefined;
  }
}

/** Keep the end of long output (commands print their result last). */
export function tailText(s: string, max = 4000): string {
  const t = s.replace(/\r/g, '').trimEnd();
  return t.length > max ? '…' + t.slice(t.length - max) : t;
}

export interface RunResult {
  sessionId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentRunner {
  provider: Provider;
  run(opts: RunOptions): Promise<RunResult>;
}

/** Thrown when a CLI turn fails or is cancelled. */
export class AgentRunError extends Error {
  constructor(
    message: string,
    public aborted = false,
  ) {
    super(message);
  }
}

/** Per-turn safety net; long coding tasks are fine, a hung CLI is not. */
export const TURN_TIMEOUT_MS = 45 * 60 * 1000;

const DETAIL_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];

/** One-line summary of a tool's input for display. */
export function summarizeInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return clip(input);
  if (typeof input !== 'object') return clip(String(input));
  const obj = input as Record<string, unknown>;
  for (const k of DETAIL_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return clip(v);
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return clip(v.join(' '));
  }
  return undefined;
}

/**
 * What a server-side web search did, from its `action` (the Responses API shape Codex and Grok
 * both report, with snake_case or camelCase types): the query, the page it opened, or the text it
 * looked for on a page.
 */
export function webSearchDetail(action: unknown): string | undefined {
  if (!action || typeof action !== 'object') return undefined;
  const a = action as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const queries = Array.isArray(a.queries) ? a.queries.filter((q): q is string => typeof q === 'string' && !!q.trim()) : [];
  const query = text(a.query) ?? (queries.length ? queries.join(' | ') : undefined);
  const url = text(a.url);
  const pattern = text(a.pattern);
  const detail = query ?? (pattern && url ? `"${pattern}" · ${url}` : (pattern ?? url));
  return detail ? clip(detail) : undefined;
}

export function clip(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

export function parseJsonLine(line: string): Record<string, any> | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    return JSON.parse(t) as Record<string, any>;
  } catch {
    return null;
  }
}
