import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_LABEL, type Permission, type PlanEntry, type ToolCallKind } from '../../shared/types';
import type { BackendRun } from '../backends';
import { commandLine, isPublishCommand } from '../commands';
import { t } from '../i18n';
import { runProcess, tail } from '../process';
import { RELAY_ROOT } from '../protect';
import { acpTokens, JsonRpcConnection, RpcError } from './acp';
import { defaultOpenDeps, startOpenProcess, type OpenAgentProcess, type OpenProcessDeps, type OpenRunContext } from './open';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  imageData,
  summarizeInput,
  tailText,
  toolCallKind,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type McpServerSpec,
  type RunOptions,
  type RunResult,
} from './types';

/*
 * The generic ACP turn the open agents that speak the Agent Client Protocol share (OpenCode, Goose,
 * Cline, OpenHands): JSON-RPC over the CLI's stdin/stdout, one process per turn. Built from the logic
 * of the Grok adapter (grok.ts, which stays as it is): `session/update` → AgentEvents,
 * `session/request_permission` → the permission's decision → the user (`requestApproval`) → the
 * declined note as feedback, cancel, timeout, usage. What differs per CLI is an `AcpAgentSpec` hook,
 * filled in by each adapter in its own file. See docs/open-agents.md, "The generic ACP turn".
 */

/** The `toolCall` of a `session/request_permission`, or a `tool_call` update. */
export interface AcpToolCall {
  toolCallId?: string;
  /** read, edit, delete, move, search, execute, think, fetch, switch_mode, other. */
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: Record<string, any>;
  locations?: { path?: string; line?: number }[];
  content?: unknown;
  _meta?: Record<string, any>;
}

/** What a tool call is, for the permission's decision and the approval card. */
export interface AcpCallInfo {
  /** ACP's tool kind; `other` when the agent gives none. */
  kind: string;
  /** The agent's title for the call, else its tool's name. */
  title: string;
  /** The command line it runs (exactly as the agent will run it). */
  command?: string;
  /** The file it reads or changes. */
  path?: string;
  url?: string;
  /** The tool's own name, when the agent says. */
  tool?: string;
  /** The agent's stated reason. */
  reason?: string;
  /** The call's input as the agent gave it (`rawInput`), for a card that has no command, file or URL to show. */
  input?: Record<string, unknown>;
  /**
   * Nothing tells this call from another (no title, tool, command, file, URL or input): its card
   * offers no "always allow", which would let every such call through.
   */
  anonymous?: boolean;
}

/** The parts of `initialize`'s answer the turn reads. */
export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: { resume?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

export interface AcpInitialize {
  protocolVersion?: number;
  agentCapabilities?: AcpAgentCapabilities;
  authMethods?: { id: string; name?: string; description?: string }[];
  [k: string]: unknown;
}

/** What `session/new`, `session/load` and `session/resume` answer, as far as the turn reads it. */
export interface AcpSessionState {
  sessionId?: string;
  configOptions?: { id: string; category?: string; currentValue?: unknown; [k: string]: unknown }[];
  models?: { currentModelId?: string; availableModels?: { modelId: string; name?: string }[] };
  modes?: { currentModeId?: string; availableModes?: { id: string; name?: string; description?: string }[] };
  [k: string]: unknown;
}

/** The last `usage_update` (ACP's context window and cost). */
export interface AcpUsageUpdate {
  used?: number;
  size?: number;
  cost?: { amount?: number; currency?: string };
}

/**
 * Per-CLI hooks of the generic ACP turn: everything the adapter of one CLI fills in, besides what
 * every open agent declares (`OpenAgentProcess`: its home, proxy variables, config written before the
 * run). Optional hooks have a default that follows ACP itself.
 */
export interface AcpAgentSpec extends OpenAgentProcess {
  /** The CLI's arguments for an ACP agent on stdio (`['acp']`, `['--acp']`…). */
  args(ctx: OpenRunContext): string[];
  /**
   * The folder the CLI's process starts in (default: the working directory). The session's `cwd`
   * stays the working directory. For a CLI whose runtime reads files of the folder it starts in by
   * itself (Cline, on Bun: the project's `.env` files and `bunfig.toml`), the run's temp folder.
   */
  processCwd?(ctx: OpenRunContext): string;
  /** Fields of `initialize` besides `protocolVersion`, `clientCapabilities` and `clientInfo` (`_meta`…). */
  initialize?(ctx: OpenRunContext): Record<string, unknown>;
  /** Steps once `initialize` answered, before the session: `authenticate` with a method it lists, say. */
  afterInitialize?(conn: JsonRpcConnection, init: AcpInitialize, ctx: OpenRunContext): Promise<void>;
  /** Fields of `session/new`, `session/load` and `session/resume` besides `sessionId`, `cwd` and `mcpServers` (`_meta`…). */
  sessionParams?(ctx: OpenRunContext, method: AcpSessionMethod): Record<string, unknown>;
  /**
   * Steps once the session started or was resumed, before the turn sets its mode, model and effort:
   * an extension method that adds the briefing (Goose: `_goose/unstable/session/system-prompt/set`), or
   * settings a loaded session keeps from before, applied again in the agent's own order (then set
   * `model` and `effort` to `via: 'config'` so the turn leaves them alone).
   */
  afterSession?(conn: JsonRpcConnection, session: { sessionId: string; state: AcpSessionState; method: AcpSessionMethod }, ctx: OpenRunContext): Promise<void>;
  /**
   * How the run's model is chosen: in the CLI's config before it starts (`prepare`), with
   * `session/set_model`, or with `session/set_config_option`. `id`: the agent's id for the run's model
   * (default: `<backend>/<model>`); `configId`: the option (default: the one of category `model`,
   * else `model`).
   */
  model: { via: 'config' } | { via: 'set_model'; id?(run: BackendRun): string } | { via: 'config_option'; configId?: string; id?(run: BackendRun): string };
  /**
   * How the reasoning effort is set: not at all, in the CLI's config (`prepare`), or with
   * `session/set_config_option` (default option: the one of category `thought_level`, else
   * `reasoning_effort`). `value`: the agent's value for Harness Relay's effort.
   */
  effort: { via: 'none' } | { via: 'config' } | { via: 'config_option'; configId?: string; value?(effort: string): string };
  /** The session mode for the permission (`session/set_mode`), from the modes the session lists; undefined = left as it is. */
  mode?(permission: Permission, modes: NonNullable<AcpSessionState['modes']>['availableModes']): string | undefined;
  /**
   * How the role briefing reaches the model: `prompt` puts it before each prompt (for a CLI without
   * a system-prompt mechanism the turn can reach); `custom`: `sessionParams` or `prepare` hands it
   * over, as `acpBriefing(ctx.o, spec)` gives it.
   */
  briefing: 'prompt' | 'custom';
  /**
   * What a tool call the agent asks about is (default: from its kind, title and `rawInput`;
   * `acpCallInfo`). `earlier`: what the turn saw of the same `toolCallId` in its `tool_call` updates
   * (an agent may ask about a folder outside the project with a call whose kind only came there).
   * `recent`: the tool calls updated since the previous permission request, for an agent whose request
   * names no call (OpenHands: `confirmation-<session>`, kind `other`); several of them are described as
   * one: the one the permission covers least. `turn`: the run and its session (OpenHands reads the
   * actions its request is about from the session's own files).
   */
  describeCall?(call: AcpToolCall, earlier: AcpToolCall | undefined, recent: AcpToolCall[], turn: { ctx: OpenRunContext; sessionId?: string }): Partial<AcpCallInfo>;
  /**
   * The adapter's own decision about a call, before the permission's (`acpPermissionDecision`):
   * undefined leaves it to the permission. A refusal from here is final (the user is not asked, for a
   * call no answer could keep bounded: OpenHands' subagents run their own commands without asking),
   * unless it says `ask`: then the user decides, as for a call the permission does not cover (a request
   * covering several calls that are not all covered, or calls the adapter cannot tell).
   */
  decide?(permission: Permission, info: AcpCallInfo): AcpDecision | undefined;
  /**
   * The option to answer a permission request with (`allow`: the decision), from the options the agent
   * offers; undefined answers `cancelled`, which ACP takes as a refusal. Default: the `allow_once` or
   * `reject_once` option, never an "always" one (an agent may then stop asking, or write its config).
   */
  chooseOption?(allow: boolean, options: AcpPermissionOption[]): string | undefined;
  /** Tool calls not shown as rows: a to-do tool whose list also comes as `plan` updates, or as `planOf`. */
  hideTool?(update: Record<string, any>): boolean;
  /**
   * The plan in an update of a hidden tool call, for an agent whose to-do list only comes as a tool's
   * input (OpenCode's `todowrite`): its entries, or undefined when it holds none.
   */
  planOf?(update: Record<string, any>): PlanEntry[] | undefined;
  /** The row's name for a tool call (default: its title, else its kind). */
  toolName?(update: Record<string, any>): string;
  /**
   * What a tool call does, for an agent whose `kind` says too little (Goose: `other` for every call):
   * from its tool. Default: its `kind` (`toolCallKind()`). Kept on the row for AgentsView only, never for
   * a permission (`describeCall` decides those).
   */
  toolKind?(update: Record<string, any>): ToolCallKind | undefined;
  /**
   * How a refusal reaches the model: fields added to the `reject_once` answer that the agent passes to
   * its model (Grok: `{ _meta: { followup_message: reason } }`). Without it the model only sees the
   * agent's own generic rejection, so the briefing says what a refused call means (`acpBriefing`, put
   * before the prompt with `briefing: 'prompt'`). The chat shows Harness Relay's reason either way.
   */
  rejection?(reason: string): Record<string, unknown>;
  /**
   * Called once a refusal was answered, for an agent that takes the reason with a request of its own
   * (Goose: `_goose/unstable/session/steer`). `refusal.sessionId`: the session the turn runs.
   */
  afterRefusal?(conn: JsonRpcConnection, refusal: { sessionId: string; reason: string; call: AcpToolCall; info: AcpCallInfo }, ctx: OpenRunContext): Promise<void>;
  /**
   * The answer to a request of the agent's other than `session/request_permission` (`fs/*`,
   * `terminal/*`…), which some agents send although `initialize` said the client does neither: the
   * turn never does what they ask (that would run outside the relay sandbox). Return `{ result }` for a
   * method the agent needs answered so (OpenCode: `fs/write_text_file` → `null`, after writing the file
   * itself); undefined, the default, answers with a "method not found" error.
   */
  clientRequest?(method: string, params: unknown): { result: unknown } | undefined;
  /**
   * The tool library's MCP servers in the agent's form for this session method (default: ACP's
   * `mcpServers`, `acpMcpServers`). An agent that ignores them on `session/load` gets them in its
   * config instead (`prepare`), and `[]` here.
   */
  mcpServers?(servers: McpServerSpec[], caps: AcpAgentCapabilities, method: AcpSessionMethod): unknown[];
  /**
   * Each of this session's updates before the turn reads it: the update to read (changed or not),
   * several (one it held back, then this one), or undefined to drop it. For an agent that sends its
   * whole system prompt as a thought, reports a failed tool as `completed`, or keeps what it says about
   * the run in `_meta` (`ctx.state` keeps it for later hooks). Updates `session/load` replays never
   * reach it.
   */
  filterUpdate?(
    params: { sessionId: string; update: Record<string, any>; _meta?: unknown },
    ctx: OpenRunContext,
  ): Record<string, any> | Record<string, any>[] | undefined;
  /**
   * The updates `filterUpdate` held back until it could tell what they were, read once the prompt has
   * answered (it did not fail): OpenHands' notice of a failure always comes right before the prompt's
   * error, so a message that only looked like one is the model's after all.
   */
  heldUpdates?(ctx: OpenRunContext): Record<string, any>[];
  /**
   * Tokens and cost of the turn (default: ACP's `usage` on the answer and the last `usage_update`,
   * `acpUsage`). An agent whose ACP numbers are not the turn's reads its own instead: OpenCode's and
   * Goose's databases, Cline's session file, OpenHands' metrics.
   */
  usage?(
    result: Record<string, any> | undefined,
    last: AcpUsageUpdate | undefined,
    ctx: OpenRunContext,
  ): Pick<RunResult, 'costUsd' | 'inputTokens' | 'outputTokens'> | Promise<Pick<RunResult, 'costUsd' | 'inputTokens' | 'outputTokens'>>;
  /**
   * After the prompt returned as an ordinary end of turn (not cancelled, not refused): throws an
   * `AgentRunError` when the agent ended it without finishing (OpenHands' stuck detector stops a turn
   * as `end_turn`, and only its session's files say so).
   */
  endTurn?(result: Record<string, any> | undefined, ctx: OpenRunContext, sessionId: string): void;
  /**
   * The prompt's text as sent (after the briefing). Default `acpPromptText`: a text starting with `/`
   * gets a word before it, since agents run such a prompt as a command of theirs. `ctx`: the run, for
   * what `prepare` found out (OpenHands: a briefing its resumed session does not have yet).
   */
  promptText?(text: string, ctx: OpenRunContext): string;
  /** Notifications that carry session updates besides `session/update`. */
  updateMethods?: string[];
  /**
   * How long the process may take to exit once its stdin is closed after the turn, before it is
   * stopped (SIGTERM, then SIGKILL, through process.ts). Default 3000 ms; 0 for an agent that never
   * exits on its own (OpenHands).
   */
  exitGraceMs?: number;
}

export type AcpSessionMethod = 'new' | 'load' | 'resume';

/** One of the answers a `session/request_permission` offers. */
export interface AcpPermissionOption {
  optionId: string;
  /** allow_once, allow_always, reject_once, reject_always. */
  kind: string;
  name?: string;
}

/** The tool kinds read-only runs without asking: reading, searching, thinking, and the web. */
const READ_KINDS = new Set(['read', 'search', 'think', 'fetch']);
/** The tool kinds that write: in read-only, allowing one does not lift the relay sandbox. */
const WRITE_KINDS = new Set(['edit', 'delete', 'move', 'execute']);

const PATH_FIELDS = ['file_path', 'filePath', 'path', 'target_file', 'filename', 'file'];

/** What a tool call is, from ACP's own fields and the usual `rawInput` names. */
export function acpCallInfo(call: AcpToolCall, describe?: (call: AcpToolCall) => Partial<AcpCallInfo>): AcpCallInfo {
  const input = call.rawInput ?? {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  // `command` is a shell command only for a call that runs one (a file editor's `command` is its own: `view`, `create`…).
  const shell = call.kind === undefined || call.kind === 'execute';
  const command = shell
    ? (commandLine(input.command) ?? commandLine(input.cmd))
    : undefined;
  const path = PATH_FIELDS.map((k) => text(input[k])).find(Boolean) ?? call.locations?.find((l) => text(l?.path))?.path;
  const base: AcpCallInfo = {
    kind: text(call.kind) ?? (command ? 'execute' : 'other'),
    title: text(call.title) ?? 'tool',
    ...(command ? { command } : {}),
    ...(path ? { path } : {}),
    ...(text(input.url) ? { url: input.url } : {}),
    ...(text(input.description) ? { reason: input.description } : {}),
    ...(Object.keys(input).length ? { input } : {}),
  };
  const info: AcpCallInfo = { ...base, ...(describe?.(call) ?? {}) };
  const named = Boolean(info.tool || (info.title && (info.title !== 'tool' || text(call.title))) || info.command || info.path || info.url || info.input);
  return info.anonymous || named ? info : { ...info, anonymous: true };
}

export type AcpDecision =
  | { allow: true }
  /**
   * `reason` goes back to the model; `label` is shown under the tool in the chat. `ask` (from an
   * adapter's `decide`): not final, the user decides as for a call the permission does not cover.
   * `labels` (from an adapter's `decide`, for a request covering several calls): the label of each
   * call's row by its `toolCallId`, where it is not `label` (the calls refused only along with another).
   */
  | { allow: false; reason: string; label: string; ask?: boolean; labels?: Record<string, string> };

/**
 * Whether a call the agent asks about runs under this permission without asking the user:
 * - full access: everything;
 * - read-only: reading, searching, thinking and the web; every edit and command asks;
 * - edit: everything but pushing and publishing (`isPublishCommand`), which asks.
 */
export function acpPermissionDecision(permission: Permission, info: AcpCallInfo, cli: string): AcpDecision {
  if (permission === 'full') return { allow: true };
  const what = info.title || info.tool || 'this tool call';
  if (permission === 'read-only') {
    if (READ_KINDS.has(info.kind) && !info.command) return { allow: true };
    return {
      allow: false,
      reason:
        `Not run: this conversation is read-only (the user's Harness Relay setting), so "${what}" is not allowed. ` +
        'Do not retry it or try to work around it. Continue with tools that only read (reading and searching files, web fetch/search) ' +
        'and describe any change you would make instead of making it.',
      label: t().openRefusedReadOnly(cli),
    };
  }
  if (info.command && isPublishCommand(info.command)) {
    return {
      allow: false,
      reason:
        `Not run: "${what}" publishes outside this machine, which this conversation's edit permission does not allow. ` +
        'Leave pushing/publishing to the user and continue with the rest of the task.',
      label: t().grokRefusedPublish,
    };
  }
  return { allow: true };
}

/** What to show the user when the agent asks about a call the permission does not cover. */
export function acpApprovalRequest(info: AcpCallInfo, permission: Permission): ApprovalRequest {
  // In read-only, the relay sandbox still refuses writes the user allows: the card says so.
  const boundary = permission === 'read-only' && WRITE_KINDS.has(info.kind) ? { readOnlySandbox: true } : {};
  const reason = info.reason ?? info.title;
  if (info.kind === 'execute' || info.command) return { kind: 'command', detail: info.command ?? '', reason, ...boundary };
  if (info.kind === 'edit' || info.kind === 'delete' || info.kind === 'move') return { kind: 'edit', detail: info.path, reason: info.title, ...boundary };
  if (info.kind === 'fetch' && info.url) return { kind: 'fetch', detail: info.url, reason: info.title };
  // Any other tool (an MCP server's, say): what it is given, so the user sees what it will do. Its
  // server runs in the relay sandbox too, so in read-only a write it tries fails the same way.
  const detail = info.path ?? info.url ?? inputDetail(info.input);
  return {
    kind: 'other',
    tool: info.tool || info.title,
    ...(detail ? { detail } : {}),
    reason: info.title,
    ...(permission === 'read-only' ? { readOnlySandbox: true } : {}),
    // A call nothing tells apart: allowing it always would allow every such call.
    ...(info.anonymous ? { noRule: true } : {}),
  };
}

/** A tool's input for its card: its usual fields (whole paths), else its JSON, shortened; none when empty. */
export function inputDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input || !Object.keys(input).length) return undefined;
  return summarizeInput(input, { wholePaths: true }) ?? clip(JSON.stringify(input), 300);
}

/** The decision after the user declined (their note, if any, goes to the model). */
export function acpDeclined(info: AcpCallInfo, note?: string): AcpDecision {
  const what = info.title || info.tool || 'this tool call';
  return {
    allow: false,
    reason: `Not run: the user declined "${what}".${note ? ` Their message: ${note}` : ''} Do not retry it; continue without it, or explain in your reply why it is needed.`,
    label: note ? `${t().approvalDeclined} ${note}` : t().approvalDeclined,
  };
}

/** The default `chooseOption`: the `allow_once` or `reject_once` option, never an "always" one. */
export function acpOption(allow: boolean, options: AcpPermissionOption[]): string | undefined {
  return options.find((o) => o.kind === (allow ? 'allow_once' : 'reject_once'))?.optionId;
}

/**
 * The answer to `session/request_permission`: the option `chooseOption` picks (an id the agent
 * offered), with `rejection`'s fields on a refusal; `cancelled` (a refusal) when there is none.
 */
export function answerAcpPermission(
  decision: AcpDecision,
  options: AcpPermissionOption[],
  hooks: Pick<AcpAgentSpec, 'rejection' | 'chooseOption'> = {},
): Record<string, unknown> {
  const chosen = (hooks.chooseOption ?? acpOption)(decision.allow, options);
  const optionId = options.some((o) => o.optionId === chosen) ? chosen : undefined;
  const extra = decision.allow ? {} : (hooks.rejection?.(decision.reason) ?? {});
  if (decision.allow && !optionId) console.warn('[acp] the agent offers no way to allow this call once; it is refused');
  return optionId ? { outcome: { outcome: 'selected', optionId }, ...extra } : { outcome: { outcome: 'cancelled' }, ...extra };
}

/**
 * The tool library's MCP servers as ACP takes them (`env` and `headers` as name/value lists). HTTP
 * servers only go to an agent that says it takes them (`mcpCapabilities.http`); ACP forbids them otherwise.
 */
export function acpMcpServers(servers: McpServerSpec[], caps: AcpAgentCapabilities | undefined, cli = 'agent'): Record<string, unknown>[] {
  const http = Boolean(caps?.mcpCapabilities?.http);
  const list = (vars: Record<string, string>) => Object.entries(vars).map(([name, value]) => ({ name, value }));
  const skipped = http ? [] : servers.filter((s) => s.transport === 'http');
  if (skipped.length) console.warn(`[${cli}] does not take HTTP MCP servers; left out: ${skipped.map((s) => s.name).join(', ')}`);
  return servers
    .filter((s) => http || s.transport !== 'http')
    .map((s) =>
      s.transport === 'http'
        ? { type: 'http', name: s.name, url: s.url, headers: list(s.headers) }
        : { name: s.name, command: s.command, args: s.args, env: list(s.env) },
    );
}

/**
 * Tokens from the prompt's answer (`usage`, or `_meta.usage`; `acpTokens`), and the cost of the last
 * `usage_update` in USD.
 */
export function acpUsage(result: Record<string, any> | undefined, last: AcpUsageUpdate | undefined): Pick<RunResult, 'costUsd' | 'inputTokens' | 'outputTokens'> {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const cost = last?.cost;
  return {
    ...acpTokens(result?.usage ?? result?._meta?.usage),
    costUsd: cost && (cost.currency ?? 'USD').toUpperCase() === 'USD' ? num(cost.amount) : undefined,
  };
}

/** Text of an ACP tool-call `content` array (its output, or why it failed). */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((c) => (typeof c?.content?.text === 'string' ? c.content.text : typeof c?.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || undefined;
}

const DONE = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/** Turns ACP `session/update` payloads into AgentEvents (pure: updates in, events out). */
/** What a tool's failure reads like when the relay sandbox refused a write (macOS and Linux, most runtimes). */
export const SANDBOX_REFUSAL_RE = /\b(?:Operation not permitted|EPERM|EROFS|Read-only file system)\b|\(os error (?:1|30)\)/i;

export function createAcpUpdateHandler(
  emit: (e: AgentEvent) => void,
  hooks: Pick<AcpAgentSpec, 'hideTool' | 'toolName' | 'toolKind' | 'planOf'> & {
    /** Below full access: the sentence put before a tool's error that reads like the sandbox's refusal. */
    sandboxRefusal?: () => string;
  } = {},
) {
  const open = new Set<string>();
  const hidden = new Set<string>();
  /** What each tool call said of itself so far, its later updates over its first (subagents' too). */
  const calls = new Map<string, AcpToolCall>();
  /** The tool calls updated since the last permission request, in the order they were last updated. */
  let recent: string[] = [];
  const names = new Map<string, string>();
  /** Calls whose start said nothing about what they do: their input may come with an update. */
  const vague = new Set<string>();
  const refused = new Map<string, string>();
  let inText = false;
  let lastFailure: { tool: string; reason?: string } | undefined;
  let lastUsage: AcpUsageUpdate | undefined;

  const closeText = () => {
    if (inText) {
      inText = false;
      emit({ type: 'text_end' });
    }
  };

  const start = (id: string, u: Record<string, any>) => {
    open.add(id);
    const name = hooks.toolName?.(u) || String(u.title || u.kind || 'tool');
    names.set(id, name);
    const detail = summarizeInput(u.rawInput);
    if (!detail) vague.add(id);
    const kind = hooks.toolKind ? hooks.toolKind(u) : toolCallKind(u.kind);
    emit({ type: 'tool_start', id, name, ...(detail ? { detail } : {}), ...(kind ? { kind } : {}) });
  };

  const finish = (id: string, u: Record<string, any>) => {
    open.delete(id);
    const ok = u.status === 'completed';
    const text = contentText(u.content);
    let error: string | undefined;
    if (!ok) {
      lastFailure = { tool: names.get(id) ?? 'tool', reason: text };
      error = refused.get(id) ?? text ?? (u.status === 'cancelled' || u.status === 'rejected' ? t().openToolNotRun : undefined);
      // The CLI's raw "Operation not permitted": say it was Harness Relay's sandbox, and why (an adapter
      // that already says so, OpenHands', is left as it is).
      const note = hooks.sandboxRefusal?.();
      if (note && error && !refused.has(id) && SANDBOX_REFUSAL_RE.test(error) && !error.includes('Harness Relay')) error = `${note} ${error}`;
    }
    const output = ok && text ? tailText(text) : undefined;
    const detail = vague.delete(id) ? summarizeInput(u.rawInput) : undefined;
    emit({ type: 'tool_end', id, ok, ...(error ? { error } : {}), ...(output ? { output } : {}), ...(detail ? { detail } : {}) });
  };

  /** Keeps what a tool call update says of the call, also of a session the turn does not show (a subagent's). */
  function note(u: Record<string, any> | undefined): void {
    if (!u || (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')) return;
    const id = String(u.toolCallId ?? '');
    if (!id) return;
    const before = calls.get(id);
    calls.set(id, {
      ...before,
      ...Object.fromEntries(Object.entries(u).filter(([k, v]) => v !== undefined && k !== 'sessionUpdate')),
      rawInput: { ...before?.rawInput, ...u.rawInput },
    } as AcpToolCall);
    recent = [...recent.filter((x) => x !== id), id];
  }

  function handle(u: Record<string, any> | undefined): void {
    if (!u) return;
    note(u);
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = u.content?.type === undefined || u.content?.type === 'text' ? u.content?.text : undefined;
        if (typeof text === 'string' && text) {
          inText = true;
          emit({ type: 'text', text });
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text = u.content?.text;
        if (typeof text === 'string' && text) {
          closeText();
          emit({ type: 'thinking', text });
        }
        break;
      }
      case 'plan': {
        const entries = Array.isArray(u.entries) ? u.entries : [];
        emit({
          type: 'plan',
          entries: entries.map((e: any) => ({
            text: String(e?.content ?? ''),
            status: e?.status === 'completed' || e?.status === 'in_progress' ? e.status : 'pending',
          })),
        });
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        if (!id) break;
        if (hidden.has(id)) {
          const entries = hooks.planOf?.(u);
          if (entries) emit({ type: 'plan', entries });
          break;
        }
        if (!open.has(id) && !names.has(id)) {
          // A call is announced with `tool_call`; an update for one never announced starts it too.
          if (u.sessionUpdate === 'tool_call_update' && !u.title && !u.kind) break;
          if (hooks.hideTool?.(u)) {
            hidden.add(id);
            const entries = hooks.planOf?.(u);
            if (entries) emit({ type: 'plan', entries });
            break;
          }
          closeText();
          start(id, u);
        }
        // A call whose start said nothing about what it does gets its input shown when it ends (tool_end.detail).
        if (open.has(id) && DONE.has(u.status)) finish(id, u);
        break;
      }
      case 'usage_update':
        lastUsage = { used: u.used, size: u.size, cost: u.cost };
        break;
    }
  }

  return {
    handle,
    /** Remember why we refused a call, to show that instead of the agent's own wording. */
    refused(toolCallId: string, label: string) {
      refused.set(toolCallId, label);
    },
    finish: closeText,
    /** The most recent tool call that did not complete, with the agent's stated reason. */
    get lastFailure() {
      return lastFailure;
    },
    get lastUsage() {
      return lastUsage;
    },
    note,
    /** What the turn saw of a tool call in its updates (for the permission request about it). */
    call(toolCallId: string): AcpToolCall | undefined {
      return calls.get(toolCallId);
    },
    /** The tool calls updated since the previous call of this (one per permission request), still unfinished. */
    takeRecent(): AcpToolCall[] {
      const taken = recent.map((id) => calls.get(id)!).filter((c) => !DONE.has(String(c.status)));
      recent = [];
      return taken;
    },
    /**
     * Ends the rows of tool calls the agent never finished (a cancelled turn sends them no update): as
     * done when the turn ended normally, else as not finished.
     */
    closeOpen(ended: boolean): void {
      for (const id of [...open]) {
        open.delete(id);
        emit({ type: 'tool_end', id, ok: ended, ...(ended ? {} : { error: refused.get(id) ?? t().openToolNotFinished }) });
      }
    },
  };
}

/**
 * Said in the briefing of an agent that cannot pass Harness Relay's reason for a refusal to its model
 * (no `rejection` hook): what a refused tool call means, since the model only sees a generic rejection.
 */
export const ACP_REFUSAL_NOTE =
  'When a tool call of yours is rejected, Harness Relay refused it: the conversation\'s permission does not cover it ' +
  '(read-only allows reading and searching files and the web, but no edits and no commands; edit allows edits and ' +
  'commands but no pushing or publishing), or the user declined it. Do not retry it or work around it: continue ' +
  'without it, or say in your reply what you would do and why it is needed.';

/** The role briefing to hand an agent: with `ACP_REFUSAL_NOTE` when the agent takes no refusal reasons. */
export function acpBriefing(o: Pick<RunOptions, 'systemPrompt' | 'permission'>, spec: Pick<AcpAgentSpec, 'rejection' | 'afterRefusal'>): string {
  const brief = o.systemPrompt.trim();
  if (spec.rejection || spec.afterRefusal || o.permission === 'full') return brief;
  return brief ? `${brief}\n\n${ACP_REFUSAL_NOTE}` : ACP_REFUSAL_NOTE;
}

/** The default `promptText`: a prompt starting with `/` (an agent's own command) gets a word before it. */
export function acpPromptText(text: string): string {
  return /^\s*\//.test(text) ? `Message: ${text}` : text;
}

/**
 * The prompt's blocks: the briefing first when the CLI takes it there (`briefing`, from `acpBriefing`),
 * the text (through `promptText`), attached images when the agent takes them.
 */
export function acpPrompt(
  o: Pick<RunOptions, 'prompt' | 'images'>,
  briefing: string | undefined,
  images: boolean,
  promptText: (text: string) => string = acpPromptText,
): unknown[] {
  const text = promptText(briefing?.trim() ? `<harness-relay-briefing>\n${briefing.trim()}\n</harness-relay-briefing>\n\n${o.prompt}` : o.prompt);
  const blocks: unknown[] = [{ type: 'text', text }];
  if (images) {
    for (const img of o.images ?? []) {
      const data = imageData(img.path);
      if (data) blocks.push({ type: 'image', data, mimeType: img.mimeType });
    }
  }
  return blocks;
}

let relayVersion: string | undefined;
function version(): string {
  if (relayVersion === undefined) {
    try {
      relayVersion = String((JSON.parse(readFileSync(join(RELAY_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0');
    } catch {
      relayVersion = '0.0.0';
    }
  }
  return relayVersion;
}

/** What the turn needs besides its spec (swapped in tests): the relay sandbox, and how long a turn may take. */
export interface AcpTurnDeps extends OpenProcessDeps {
  timeoutMs: number;
}

export const defaultAcpDeps: AcpTurnDeps = { ...defaultOpenDeps, timeoutMs: TURN_TIMEOUT_MS };

/** The runner of an ACP open agent. */
export function acpRunner(spec: AcpAgentSpec, deps: Partial<AcpTurnDeps> = {}): AgentRunner {
  return { provider: spec.provider, run: (o) => acpTurn(o, spec, { ...defaultAcpDeps, ...deps }) };
}

/** One turn of an ACP open agent: its process (in the relay sandbox below full access), one session, one prompt. */
export async function acpTurn(o: RunOptions, spec: AcpAgentSpec, deps: AcpTurnDeps = defaultAcpDeps): Promise<RunResult> {
  if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
  const cli = PROVIDER_LABEL[spec.provider];
  const proc = await startOpenProcess(spec, o, (ctx) => spec.args(ctx), deps);
  try {
    return await acpSession(o, spec, proc.ctx, proc, deps.timeoutMs, cli);
  } finally {
    await proc.dispose().catch((err: Error) => console.warn(`[${spec.provider}] could not end its sandbox:`, err.message));
  }
}

async function acpSession(
  o: RunOptions,
  spec: AcpAgentSpec,
  ctx: OpenRunContext,
  proc: { bin: string; args: string[]; env: NodeJS.ProcessEnv; failure(): string | undefined },
  timeoutMs: number,
  cli: string,
): Promise<RunResult> {
  let child: ChildProcess | undefined;
  let sessionId: string | undefined;
  let userAborted = false;
  /** While `session/load` replays the session's history: those updates are not this turn's. */
  let replaying = false;
  /** The turn ended as the agent meant it to (its open tool rows count as done). */
  let ended = false;
  // Ends the process: once the turn is over, or when a cancel is not honoured in time.
  const stop = new AbortController();
  const stopSoon = (ms: number) => setTimeout(() => stop.abort(), ms).unref();

  const conn = new JsonRpcConnection((line) => child?.stdin?.write(line + '\n'));
  const updates = createAcpUpdateHandler(o.onEvent, {
    ...spec,
    ...(ctx.sandboxed ? { sandboxRefusal: () => (o.permission === 'read-only' ? t().openSandboxRefusedReadOnly : t().openSandboxRefused) } : {}),
  });
  const updateMethods = new Set(['session/update', ...(spec.updateMethods ?? [])]);
  conn.onNotification = (method, params) => {
    if (!updateMethods.has(method)) return;
    if (replaying) return; // the history `session/load` replays
    if (!sessionId || params?.sessionId !== sessionId) {
      updates.note(params?.update); // a subagent's: not shown, but its permission requests come here
      return;
    }
    const update = spec.filterUpdate ? spec.filterUpdate({ sessionId, update: params.update, _meta: params._meta }, ctx) : params.update;
    for (const u of Array.isArray(update) ? update : update ? [update] : []) updates.handle(u);
  };
  conn.onRequest = async (method, params) => {
    if (method !== 'session/request_permission') {
      // Never done for the agent (it would run outside the relay sandbox): answered as the spec says, or refused.
      const answer = spec.clientRequest?.(method, params);
      if (answer) return answer.result;
      throw new RpcError(-32601, `${method} is not supported`);
    }
    // Stopped: a request still coming in, or one the user was still being asked about, is cancelled
    // (ACP's answer for a turn being cancelled), not refused: nobody declined it.
    const cancelled = { outcome: { outcome: 'cancelled' } };
    if (userAborted) return cancelled;
    // Subagents ask under the parent session too: the same decision, the same approvals.
    const call: AcpToolCall = params?.toolCall ?? {};
    const earlier = call.toolCallId ? updates.call(String(call.toolCallId)) : undefined;
    const recent = updates.takeRecent();
    const info = acpCallInfo(call, spec.describeCall ? (c) => spec.describeCall!(c, earlier, recent, { ctx, ...(sessionId ? { sessionId } : {}) }) : undefined);
    const own = spec.decide?.(o.permission, info);
    let decision = own ?? acpPermissionDecision(o.permission, info, cli);
    // Not covered by the permission: the user decides, when the conversation asks.
    if (!decision.allow && (!own || ('ask' in own && own.ask)) && o.requestApproval) {
      const answer = await o.requestApproval(acpApprovalRequest(info, o.permission));
      if (userAborted || o.signal.aborted) return cancelled;
      decision = answer.allow ? { allow: true } : acpDeclined(info, answer.note);
    }
    if (!decision.allow && call.toolCallId) updates.refused(call.toolCallId, decision.label);
    // A request that names no call it announced covers the calls described to it: their rows show why.
    if (!decision.allow && !earlier && spec.describeCall) {
      for (const c of recent) if (c.toolCallId) updates.refused(String(c.toolCallId), decision.labels?.[String(c.toolCallId)] ?? decision.label);
    }
    if (!decision.allow && spec.afterRefusal && sessionId) {
      // After the answer has gone out (it is sent once this handler returns).
      const refusal = { sessionId, reason: decision.reason, call, info };
      setImmediate(() => {
        if (userAborted) return; // the session is being cancelled: nothing to steer
        spec.afterRefusal!(conn, refusal, ctx).catch((err: Error) => console.warn(`[${spec.provider}] could not pass on a refusal:`, err.message));
      });
    }
    return answerAcpPermission(decision, Array.isArray(params?.options) ? params.options : [], spec);
  };

  const onAbort = () => {
    userAborted = true;
    if (sessionId) conn.notify('session/cancel', { sessionId });
    stopSoon(2000);
  };
  o.signal.addEventListener('abort', onAbort, { once: true });
  // Stopped while the process was being got ready (its config, the sandbox): it does not start.
  if (o.signal.aborted) {
    o.signal.removeEventListener('abort', onAbort);
    throw new AgentRunError(t().stopped, true);
  }

  const exited = runProcess({
    bin: proc.bin,
    args: proc.args,
    cwd: spec.processCwd?.(ctx) ?? o.cwd,
    env: proc.env,
    signal: stop.signal,
    timeoutMs,
    keepStdinOpen: true,
    onSpawn: (c) => (child = c),
    onLine: conn.handleLine,
  }).then(
    (res) => {
      // The relay sandbox's reason (it could not start, or refused) comes first: stderr then says little.
      const why = res.timedOut ? t().timedOut : proc.failure() || tail(res.stderr) || t().exitedWithoutTurn(cli, res.code);
      conn.close(new AgentRunError(why));
      return res;
    },
    (err: Error) => {
      conn.close(err);
      throw err;
    },
  );
  exited.catch(() => undefined); // surfaced through the pending requests instead

  try {
    const init = ((await conn.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'harness-relay', title: 'Harness Relay', version: version() },
      ...(spec.initialize?.(ctx) ?? {}),
    })) ?? {}) as AcpInitialize;
    // A stop after any step on the way to the prompt ends the turn there: the prompt is never sent.
    const stopIfStopped = () => {
      if (userAborted) throw new AgentRunError(t().stopped, true);
    };
    stopIfStopped();
    const caps = init.agentCapabilities ?? {};
    await spec.afterInitialize?.(conn, init, ctx);
    stopIfStopped();
    const mcpServers = (method: AcpSessionMethod) =>
      spec.mcpServers ? spec.mcpServers(o.mcpServers ?? [], caps, method) : acpMcpServers(o.mcpServers ?? [], caps, spec.provider);

    let state: AcpSessionState;
    let started: AcpSessionMethod;
    if (o.sessionId) {
      // Only as the agent says it can; otherwise this turn fails before anything is said, and the
      // orchestrator starts a fresh session with the whole history (as after any failed resume).
      const method = caps.sessionCapabilities?.resume ? 'resume' : caps.loadSession ? 'load' : undefined;
      if (!method) throw new AgentRunError(t().openCannotResume(cli));
      sessionId = o.sessionId;
      started = method;
      replaying = method === 'load';
      try {
        state = ((await conn.request(`session/${method}`, { sessionId, cwd: o.cwd, mcpServers: mcpServers(method), ...(spec.sessionParams?.(ctx, method) ?? {}) })) ?? {}) as AcpSessionState;
      } catch (err) {
        if (userAborted) throw err;
        throw new AgentRunError(t().openResumeFailed(cli, (err as Error).message));
      } finally {
        replaying = false;
      }
    } else {
      started = 'new';
      state = ((await conn.request('session/new', { cwd: o.cwd, mcpServers: mcpServers('new'), ...(spec.sessionParams?.(ctx, 'new') ?? {}) })) ?? {}) as AcpSessionState;
      sessionId = typeof state.sessionId === 'string' ? state.sessionId : '';
      if (!sessionId) throw new AgentRunError(t().openNoSession(cli));
    }
    o.onEvent({ type: 'session', sessionId });
    stopIfStopped();

    await spec.afterSession?.(conn, { sessionId, state, method: started }, ctx);
    stopIfStopped();

    await setSessionOptions(conn, spec, ctx, sessionId, state, o, cli, stopIfStopped);
    stopIfStopped();

    const result = (await conn.request('session/prompt', {
      sessionId,
      prompt: acpPrompt(o, spec.briefing === 'prompt' ? acpBriefing(o, spec) : undefined, Boolean(caps.promptCapabilities?.image), spec.promptText && ((text) => spec.promptText!(text, ctx))),
    })) as Record<string, any> | undefined;
    for (const u of spec.heldUpdates?.(ctx) ?? []) updates.handle(u);
    updates.finish();
    const ending = result?.stopReason !== 'cancelled' && !userAborted;
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (result?.stopReason === 'cancelled') {
      const f = updates.lastFailure;
      throw new AgentRunError(f ? t().openCancelled(cli, f.tool, f.reason) : t().openCancelledNoReason(cli));
    }
    // The model refused: the turn failed, so the rows it left open did not finish either.
    if (result?.stopReason === 'refusal') throw new AgentRunError(t().openRefusal(cli));
    // A turn the agent ended without finishing it (`endTurn` throws): its open rows did not finish either.
    spec.endTurn?.(result, ctx, sessionId);
    ended = ending;
    return { sessionId, ...(spec.usage ? await spec.usage(result, updates.lastUsage, ctx) : acpUsage(result, updates.lastUsage)) };
  } catch (err) {
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (err instanceof AgentRunError) throw err;
    throw new AgentRunError(err instanceof Error ? err.message : String(err));
  } finally {
    updates.closeOpen(ended);
    o.signal.removeEventListener('abort', onAbort);
    child?.stdin?.end(); // ACP agents exit when their stdin closes; one that does not is stopped
    stopSoon(spec.exitGraceMs ?? 3000);
    await exited.catch(() => undefined);
  }
}

/** The session's mode for the permission, its model and its effort, as the spec says each is set. */
async function setSessionOptions(
  conn: JsonRpcConnection,
  spec: AcpAgentSpec,
  ctx: OpenRunContext,
  sessionId: string,
  state: AcpSessionState,
  o: RunOptions,
  cli: string,
  /** Throws when the turn was stopped: checked after each request. */
  stopIfStopped: () => void = () => undefined,
): Promise<void> {
  if (spec.mode) {
    const modeId = spec.mode(o.permission, state.modes?.availableModes ?? []);
    if (modeId && modeId !== state.modes?.currentModeId) {
      await conn.request('session/set_mode', { sessionId, modeId }).catch((err: Error) => {
        throw new AgentRunError(t().openRejectedMode(cli, modeId, err.message));
      });
      stopIfStopped();
    }
  }
  const options = state.configOptions ?? [];
  const optionId = (configId: string | undefined, category: string, fallback: string) =>
    configId ?? options.find((c) => c?.category === category)?.id ?? fallback;
  const setOption = async (configId: string, value: string, rejected: (v: string, e: string) => string) => {
    if (options.find((c) => c?.id === configId)?.currentValue === value) return;
    await conn.request('session/set_config_option', { sessionId, configId, value }).catch((err: Error) => {
      throw new AgentRunError(rejected(value, err.message));
    });
    stopIfStopped();
  };

  const m = spec.model;
  if (m.via === 'set_model') {
    const modelId = m.id?.(ctx.run) ?? ctx.run.id;
    if (modelId !== state.models?.currentModelId) {
      await conn.request('session/set_model', { sessionId, modelId }).catch((err: Error) => {
        throw new AgentRunError(t().openRejectedModel(cli, modelId, err.message));
      });
      stopIfStopped();
    }
  } else if (m.via === 'config_option') {
    await setOption(optionId(m.configId, 'model', 'model'), m.id?.(ctx.run) ?? ctx.run.id, (v, e) => t().openRejectedModel(cli, v, e));
  }

  const e = spec.effort;
  if (o.effort && e.via === 'config_option') {
    await setOption(optionId(e.configId, 'thought_level', 'reasoning_effort'), e.value?.(o.effort) ?? o.effort, (v, err) => t().openRejectedEffort(cli, v, err));
  }
}
