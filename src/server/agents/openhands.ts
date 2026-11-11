import { chmodSync, type Dirent, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { API_BACKEND_LABEL, PROVIDER_LABEL, isApiBackend, parseBackendModel, type ModelOption, type NativeAgent, type NativeHook, type NativeMemoryFile, type NativeSkill, type Permission } from '../../shared/types';
import { backendLabel, type BackendRun } from '../backends';
import { commandLine, isPublishCommand } from '../commands';
import { commandPaths, overlaps, protectedReads } from '../protect';
import { t } from '../i18n';
import type { NativeProbe } from '../native';
import { runProcess } from '../process';
import { leftoverSweepPids } from '../relaySandbox';
import { acpBriefing, acpPermissionDecision, acpPromptText, acpRunner, type AcpAgentSpec, type AcpCallInfo, type AcpDecision, type AcpToolCall, type AcpTurnDeps } from './acpTurn';
import type { OpenAgentDefinition, OpenCatalog, OpenHomeLayout, OpenRunContext, OpenSandboxNeeds } from './open';
import { AgentRunError, type AgentRunner, type McpServerSpec, type RunOptions, type RunResult } from './types';

/*
 * OpenHands: `openhands` (PyPI `openhands`, `uv tool install openhands`; checked with 1.16.0, which brings
 * openhands-sdk 1.21.0 and LiteLLM 1.108.4) over ACP, `openhands acp`. See docs/open-agents.md, "OpenHands".
 *
 * What the CLI does that this adapter works around (each checked with the real CLI, with an isolated home):
 * - Its settings are a whole serialized SDK agent, `agent_settings.json`, read at every `session/new` and
 *   `session/load`; ACP cannot change the model (`session/set_model` is missing, `set_config_option` does
 *   nothing). So the model, its backend, the effort, the tools and the briefing are written per run.
 * - `OPENHANDS_PERSISTENCE_DIR` moves only that file, `mcp.json` and its sessions; skills, hooks, subagents
 *   and caches follow `HOME`. Each run therefore gets a home of its own in the run's temp folder (config
 *   written there, removed after the run), and only the sessions (`OPENHANDS_CONVERSATIONS_DIR`) are kept,
 *   in the conversation member's own state folder: parallel members on other models cannot change each
 *   other's settings, nor any run another member's or conversation's sessions.
 * - It loads the `.env` of the folder it starts in into its environment, for every variable not set
 *   already, and its terminal's `bash -i` gets them (a `PROMPT_COMMAND` would run before any approval):
 *   it starts in the run's temp folder (`processCwd`), never in the project. Every variable this adapter
 *   relies on is set anyway, the ones it does not use are set empty (`emptyEnv`).
 * - It clones and fetches its public skills from GitHub at every session (and LiteLLM fetches its price
 *   list): a plain file where that clone would go turns the first off, `LITELLM_LOCAL_MODEL_COST_MAP` the
 *   second.
 * - Its terminal is a tmux server (socket `openhands`) that outlives the process. Below full access a
 *   `tmux` that fails makes it run a plain pseudo-terminal instead (`openhandsTerminal`), which the relay
 *   sandbox allows on macOS only with the user's switch (`openhandsNeedsTerminalSwitch`); with full
 *   access each run gets its own socket folder, and the server's whole tree is killed after the run
 *   (`cleanup`).
 * - Its stuck detector ends a turn as if done: the session's state says so, and the turn fails (`endTurn`).
 * - It asks about every action with one request that names none of them (`confirmation-<session>`):
 *   the decision is made about the actions its session's log holds waiting when it asks, which are the
 *   `tool_call`s it announced just before (`describeCall`; when they are not, the user decides). Its
 *   rejection reaches the model only as its own fixed words, so the briefing says what a refusal means.
 * - A stored session's actions without an answer would run on resume without asking: they are rejected
 *   first, and a log not read exactly as OpenHands reads it is not resumed (`openhandsEventLog`).
 * - Its subagents (the `task` tool) run their own commands and edits without asking: the tool is taken
 *   away below full access, and refused there if it still comes.
 * - `session/load` ignores `mcpServers`: the tool library's servers go into `mcp.json` instead.
 * - It never exits when its stdin closes (`exitGraceMs: 0`), sends its whole system prompt as a thought,
 *   reports a failed tool as `completed` (its observation says), never streams, and counts tokens for the
 *   whole conversation, across resumes (`filterUpdate`, `usage`).
 */

const CLI = PROVIDER_LABEL.openhands;

/** The tmux socket name OpenHands uses (`openhands.tools.terminal.constants.TMUX_SOCKET_NAME`). */
export const OPENHANDS_TMUX_SOCKET = 'openhands';

/**
 * The longest tmux socket path used: macOS takes 103 bytes, Linux 107 (`openhandsTerminal` says what a
 * run whose temp folder makes it longer does instead).
 */
export const SOCKET_PATH_MAX = 100;

/** OpenHands' reasoning effort values (`LLM.reasoning_effort`); none chosen, none is sent (its own default would be `high`). */
export const OPENHANDS_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];

/**
 * The thinking budget for the Claude models OpenHands gives extended thinking (`extended_thinking_budget`,
 * capped by OpenHands below the model's output limit); 0 = none. Other models take `reasoning_effort`.
 */
const THINKING_BUDGET: Record<string, number> = { none: 0, low: 2048, medium: 8192, high: 32000, xhigh: 64000 };

/** Its tools below full access: all but the subagent tools (`task`, the older `delegate`), which run unasked. */
export const OPENHANDS_TOOL_FILTER = '^(?!(task|delegate)$).*';

/** The briefing, as a skill without triggers in the run's home: OpenHands puts it in its system prompt. */
export const OPENHANDS_BRIEFING_SKILL = 'harness-relay-briefing.md';

/**
 * Variables set empty for every run, so no `.env` (OpenHands loads the one where it starts) can set them:
 * base URLs that would send a key elsewhere, tracing, its environment overrides, debug logs to files.
 */
export const OPENHANDS_EMPTY_ENV = [
  // The base URLs LiteLLM (1.108.4) and the OpenAI and Anthropic SDKs under it read for the providers
  // Harness Relay uses (OpenAI, an OpenAI-compatible endpoint, Anthropic, xAI), and LiteLLM's proxies.
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_LIKE_API_BASE',
  'HOSTED_VLLM_API_BASE',
  'AZURE_API_BASE',
  'AZURE_AI_API_BASE',
  'AZURE_OPENAI_ENDPOINT',
  'ANTHROPIC_API_BASE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_URL',
  'XAI_API_BASE',
  'XAI_OAUTH_API_BASE',
  'XAI_BASE_URL',
  'LITELLM_PROXY_API_BASE',
  'LITELLM_PROXY_URL',
  'LITELLM_GATEWAY_URL',
  'LITELLM_MODEL_COST_MAP_URL',
  'LITELLM_ANTHROPIC_BETA_HEADERS_URL',
  'LITELLM_AUTOROUTER_PRESETS_URL',
  'LITELLM_BLOG_POSTS_URL',
  'LMNR_PROJECT_API_KEY',
  'LMNR_BASE_URL',
  'OTEL_ENDPOINT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'DEBUG',
  'DEBUG_LLM',
  'LOG_TO_FILE',
  'LOG_DIR',
  'LOG_JSON',
  'EXTENSIONS_REF',
  'OPENHANDS_CLOUD_URL',
];

/** Proxy variables: kept as the server has them, else set empty so `.env` cannot set them either. */
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];

/** Variables the terminal's shell gets back as the server has them (the run's own HOME is for OpenHands only). */
const SHELL_RESTORED = ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'];

// --- The run's home and settings ------------------------------------------------------------------------

/**
 * LiteLLM's switches to its own bundled copies of what it would otherwise fetch from GitHub at start
 * or on a call (its price list, Anthropic's beta headers for extended thinking, and others it may fetch);
 * and `LITELLM_MODE`, whose default (`DEV`) makes LiteLLM load the first `.env` above its own install
 * folder (`~/.env`, say) when it is imported.
 */
export const LITELLM_LOCAL: Record<string, string> = {
  LITELLM_MODE: 'PRODUCTION',
  LITELLM_LOCAL_MODEL_COST_MAP: 'True',
  LITELLM_LOCAL_ANTHROPIC_BETA_HEADERS: 'True',
  LITELLM_LOCAL_AUTOROUTER_PRESETS: 'True',
  LITELLM_LOCAL_BLOG_POSTS: 'True',
  LITELLM_LOCAL_POLICY_TEMPLATES: 'True',
};

/**
 * The agent home: only OpenHands' sessions, in the run's state folder (the conversation member's own;
 * each run's config is its own, in its temp folder).
 */
export function openhandsHome(root: string, state = root): OpenHomeLayout {
  const conversations = join(state, 'conversations');
  return {
    env: { OPENHANDS_CONVERSATIONS_DIR: conversations, OPENHANDS_SUPPRESS_BANNER: '1', ...LITELLM_LOCAL },
    statePaths: [conversations],
    configPaths: [],
  };
}

/** LiteLLM's name for the run's model: `openai/…`, `anthropic/…`, `xai/…`; an endpoint is OpenAI-compatible. */
export function openhandsModel(run: Pick<BackendRun, 'kind' | 'model'>): string {
  return `${run.kind === 'endpoint' ? 'openai' : run.kind}/${run.model}`;
}

/** The run's effort as chosen (undefined: none chosen); an unknown one fails the run before it starts. */
export function openhandsEffort(effort: string | undefined): string | undefined {
  const e = effort?.trim();
  if (!e) return undefined;
  if (!OPENHANDS_EFFORTS.includes(e)) throw new AgentRunError(t().openRejectedEffort(CLI, e, OPENHANDS_EFFORTS.join(', ')));
  return e;
}

/** What LiteLLM's model list says of a model (its own copy in the OpenHands install). */
export type LitellmModelInfo = { supports_reasoning?: boolean; supports_xhigh_reasoning_effort?: boolean; [k: string]: unknown };

/** The run's model in LiteLLM's list (`<provider>/<model>` or the bare name); an endpoint's is not there. */
export function openhandsModelInfo(models: Record<string, unknown> | undefined, run: Pick<BackendRun, 'kind' | 'model'>): LitellmModelInfo | undefined {
  if (!models || run.kind === 'endpoint') return undefined;
  const v = models[`${run.kind}/${run.model}`] ?? models[run.model];
  return v && typeof v === 'object' ? (v as LitellmModelInfo) : undefined;
}

/**
 * The effort written to its settings: none when none was chosen, at `none`, or for a model LiteLLM says
 * does not reason (OpenHands would otherwise send its own default, `high`, which a model may refuse). A
 * model LiteLLM has no information on (an endpoint's) gets the effort chosen: one that refuses it fails
 * the turn with what to set instead (`openhandsError`).
 */
export function openhandsSentEffort(effort: string | undefined, info: LitellmModelInfo | undefined): string | null {
  if (!effort || effort === 'none') return null;
  if (info && info.supports_reasoning !== true) return null;
  return effort;
}

/** One LLM of the settings (the agent's, or the condenser's). No key: LiteLLM takes it from the environment. */
function llmSettings(run: BackendRun, effort: string | null, usageId: 'agent' | 'condenser'): Record<string, unknown> {
  return {
    model: openhandsModel(run),
    ...(run.kind === 'endpoint' && run.endpoint ? { base_url: run.endpoint.baseUrl } : {}),
    usage_id: usageId,
    reasoning_effort: effort,
    extended_thinking_budget: (effort && THINKING_BUDGET[effort]) || null,
    // A backend that cannot be reached fails in seconds, not after OpenHands' default of minutes of retries.
    num_retries: 2,
    retry_min_wait: 2,
    retry_max_wait: 10,
    retry_multiplier: 2,
  };
}

/** The whole `agent_settings.json` of one run: its model, effort and tools (no key in it). */
export function openhandsAgentSettings(run: BackendRun, effort: string | null, permission: Permission): Record<string, unknown> {
  return {
    kind: 'Agent',
    llm: llmSettings(run, effort, 'agent'),
    tools: [{ name: 'terminal' }, { name: 'file_editor' }, { name: 'task_tracker' }, { name: 'task_tool_set' }],
    system_prompt_kwargs: { cli_mode: true },
    condenser: { kind: 'LLMSummarizingCondenser', llm: llmSettings(run, effort, 'condenser'), max_size: 80, keep_first: 4 },
    ...(permission === 'full' ? {} : { filter_tools_regex: OPENHANDS_TOOL_FILTER }),
  };
}

/** The tool library's MCP servers as OpenHands' `mcp.json` has them (`session/load` ignores ACP's). */
export function openhandsMcpConfig(servers: McpServerSpec[]): { mcpServers: Record<string, unknown> } {
  return {
    mcpServers: Object.fromEntries(
      servers.map((s) => [
        s.name,
        s.transport === 'http'
          ? { url: s.url, transport: 'http', headers: { ...s.headers } }
          : { command: s.command, args: [...s.args], env: { ...s.env }, transport: 'stdio' },
      ]),
    ),
  };
}

/** A shell word in single quotes. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The run's `.bashrc`: the terminal's commands get back the user's HOME (and XDG folders) the server has. */
export function openhandsBashrc(serverEnv: NodeJS.ProcessEnv): string {
  const lines = SHELL_RESTORED.map((name) => {
    const v = name === 'HOME' ? serverEnv.HOME || homedir() : serverEnv[name];
    return v ? `export ${name}=${shellQuote(v)}` : `unset ${name}`;
  });
  return ['# Written by Harness Relay for one OpenHands run: commands get the user\'s own HOME back.', ...lines, ''].join('\n');
}

/** The path of OpenHands' tmux socket under `dir`, as tmux makes it (from the folder's real path). */
export function openhandsSocketPath(dir: string, uid: number): string {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // not made yet: as given
  }
  return join(real, `tmux-${uid}`, OPENHANDS_TMUX_SOCKET);
}

/**
 * How OpenHands' terminal runs, and where its tmux socket goes. Below full access never in tmux: a
 * command backgrounded in tmux (`nohup … &`) outlives the turn, since the tmux server closes the
 * descriptors the relay sandbox finds a run's processes by, and stopping the server only hangs up on
 * them; its terminal is then a plain pseudo-terminal, whose commands the sandbox stops with the run.
 * With full access tmux always runs, its socket in the run's temp folder or, when that is too deep, in
 * a short folder of its own; its server and everything under it are killed after the run (`cleanup`).
 */
export function openhandsTerminal(
  tmpDir: string,
  o: { sandboxed: boolean; platform: NodeJS.Platform; uid: number },
  make: () => string = () => mkdtempSync(join(tmpdir(), 'hr-oh-')),
): { mode: 'tmux' | 'pty'; dir?: string; own?: boolean } {
  if (o.sandboxed || o.platform === 'win32') return { mode: 'pty' }; // on Windows, its PowerShell terminal: no tmux
  const fits = Buffer.byteLength(openhandsSocketPath(tmpDir, o.uid)) <= SOCKET_PATH_MAX;
  return fits ? { mode: 'tmux', dir: tmpDir } : { mode: 'tmux', dir: make(), own: true };
}

/** The `tmux` OpenHands finds first on its PATH when it must not use tmux: it then runs a plain pseudo-terminal. */
export const OPENHANDS_NO_TMUX = '#!/bin/sh\necho "tmux is not available in this OpenHands run (Harness Relay)" >&2\nexit 1\n';

/** OpenHands' folder of one session: its id without dashes. */
export function openhandsSessionDir(conversations: string, sessionId: string): string {
  return join(conversations, sessionId.replace(/-/g, '').toLowerCase());
}

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Tokens and cost OpenHands counted for a conversation, as its ACP `_meta` or its `base_state.json` have them. */
export interface OpenhandsMetrics {
  input: number;
  output: number;
  cost: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** What a session's `base_state.json` counted so far (every LLM of it: the agent's and the condenser's). */
export function openhandsSavedMetrics(baseState: unknown): OpenhandsMetrics | undefined {
  const per = (baseState as { stats?: { usage_to_metrics?: unknown } } | undefined)?.stats?.usage_to_metrics;
  if (!per || typeof per !== 'object') return undefined;
  const total: OpenhandsMetrics = { input: 0, output: 0, cost: 0 };
  for (const m of Object.values(per as Record<string, any>)) {
    total.input += num(m?.accumulated_token_usage?.prompt_tokens);
    total.output += num(m?.accumulated_token_usage?.completion_tokens);
    total.cost += num(m?.accumulated_cost);
  }
  return total;
}

/** The metrics an update's `_meta` carries (OpenHands nests them under `field_meta`). */
export function openhandsUpdateMetrics(meta: unknown): OpenhandsMetrics | undefined {
  const m = meta as Record<string, any> | undefined;
  const x = m?.field_meta?.['openhands.dev/metrics'] ?? m?.['openhands.dev/metrics'];
  if (!x || typeof x !== 'object') return undefined;
  return { input: num(x.input_tokens), output: num(x.output_tokens), cost: num(x.cost) };
}

/** The turn's tokens and cost: what OpenHands counted at its end, less what the conversation had before. */
export function openhandsUsage(last: OpenhandsMetrics | undefined, before: OpenhandsMetrics | undefined, run: Pick<BackendRun, 'kind'>): Pick<RunResult, 'costUsd' | 'inputTokens' | 'outputTokens'> {
  if (!last || !before) return {};
  const d = (a: number, b: number) => Math.max(0, a - b);
  const cost = d(last.cost, before.cost);
  return {
    inputTokens: d(last.input, before.input),
    outputTokens: d(last.output, before.output),
    // An endpoint has no price list: 0 there means unknown.
    ...(cost > 0 || run.kind !== 'endpoint' ? { costUsd: Number(cost.toFixed(8)) } : {}),
  };
}

/** An action a stored session holds without an answer (`ConversationState.get_unmatched_actions`). */
export interface OpenhandsLeftover {
  id: string;
  toolCallId: string;
  toolName: string;
  /** The action itself, as OpenHands stored it (its `kind`, its arguments). */
  action: Record<string, unknown>;
}

/** A session's event log as OpenHands reads it (`openhandsEventLog`). */
export interface OpenhandsEventLog {
  /** Its actions with neither an observation, a rejection nor an error after them, oldest first. */
  actions: OpenhandsLeftover[];
  /** The index its next event file gets. */
  next: number;
  /** Whether it was left waiting for a confirmation (`base_state.json`). */
  waiting: boolean;
  /** Whether its last event is a rejection Harness Relay wrote (`openhandsRejectLeftovers`). */
  rejectedByRelay: boolean;
  /**
   * Whether it is laid out exactly as OpenHands writes it, so that it reads the same actions from it:
   * false for anything else (a file it would skip or count differently, a gap, an event JSON.parse cannot
   * read, as OpenHands' parser reads `Infinity` and `NaN`), whose actions are then not known.
   */
  sound: boolean;
}

/** OpenHands' event file names (`EVENT_NAME_RE`, `persistence_const.py`): a five-digit index, then the event's id. */
const EVENT_FILE = /^event-(\d{5})-([0-9a-fA-F-]{8,})\.json$/;
/** The one other file OpenHands keeps among its events: its lock. */
const EVENT_LOCK = '.eventlog.lock';

const isObject = (x: unknown): x is Record<string, any> => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/**
 * A stored session's event log, read as OpenHands reads it (`EventLog._scan_and_build_index`, then
 * `ConversationState.get_unmatched_actions`): the files named `event-<5 digits>-<id>.json` from index 0
 * up to the first gap, and, from the newest back, the actions no observation, rejection
 * (`action_id`) or error (`tool_call_id`) after them answers. Those it would run before anything else
 * when the session is resumed (its "implicit confirmation", without asking or showing them). Whatever
 * OpenHands alone would not have written (another file, two files for one index, a gap, an event
 * JSON.parse cannot read or that lacks its fields) makes the log not `sound`.
 */
export function openhandsEventLog(sessionDir: string): OpenhandsEventLog {
  const unsound: OpenhandsEventLog = { actions: [], next: 0, waiting: false, rejectedByRelay: false, sound: false };
  const dir = join(sessionDir, 'events');
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return unsound;
  }
  const byIndex = new Map<number, string>();
  for (const entry of entries) {
    if (entry.name === EVENT_LOCK) continue;
    const m = EVENT_FILE.exec(entry.name);
    if (!m || !entry.isFile() || byIndex.has(Number(m[1]))) return unsound;
    byIndex.set(Number(m[1]), entry.name);
  }
  const events: Record<string, any>[] = [];
  for (let i = 0; i < byIndex.size; i++) {
    const name = byIndex.get(i);
    if (!name) return unsound; // a gap: OpenHands would read only the events before it
    let e: unknown;
    try {
      e = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      return unsound;
    }
    if (!isObject(e) || typeof e.kind !== 'string' || typeof e.id !== 'string') return unsound;
    events.push(e);
  }
  const answered = new Set<string>();
  const failedCalls = new Set<string>();
  const actions: OpenhandsLeftover[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'ObservationEvent' || e.kind === 'UserRejectObservation') {
      if (typeof e.action_id !== 'string') return unsound;
      answered.add(e.action_id);
    } else if (e.kind === 'AgentErrorEvent') {
      if (typeof e.tool_call_id !== 'string') return unsound;
      failedCalls.add(e.tool_call_id);
    } else if (e.kind === 'ActionEvent') {
      if (typeof e.tool_call_id !== 'string' || typeof e.tool_name !== 'string' || (e.action != null && !isObject(e.action))) return unsound;
      if (e.action != null && !answered.has(e.id) && !failedCalls.has(e.tool_call_id)) {
        actions.unshift({ id: e.id, toolCallId: e.tool_call_id, toolName: e.tool_name, action: e.action });
      }
    }
  }
  let waiting = false;
  try {
    const state = JSON.parse(readFileSync(join(sessionDir, 'base_state.json'), 'utf8')) as unknown;
    if (!isObject(state)) return unsound;
    waiting = String(state.execution_status).toLowerCase() === 'waiting_for_confirmation';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return unsound;
  }
  const last = events[events.length - 1];
  const rejectedByRelay = last?.kind === 'UserRejectObservation' && last.rejection_reason === LEFTOVER_REASON;
  return { actions, next: events.length, waiting, rejectedByRelay, sound: true };
}

/**
 * Whether a stored session may be resumed: its log is `sound`, and, when it was left waiting for a
 * confirmation, it holds the actions waiting (or Harness Relay rejected them already), else what it
 * waits for is not what Harness Relay reads.
 */
export function openhandsResumable(log: OpenhandsEventLog): boolean {
  return log.sound && (!log.waiting || log.actions.length > 0 || log.rejectedByRelay);
}

/**
 * After a turn: its stuck detector (the same action, or the same error, over and over) stops the turn
 * as an ordinary end, with nothing said; only the session's state says `stuck`. The turn then fails with
 * what happened, rather than ending as if done.
 */
export function openhandsEndTurn(ctx: Pick<OpenRunContext, 'home'>, sessionId: string): void {
  let status: unknown;
  try {
    const state = JSON.parse(readFileSync(join(openhandsSessionDir(join(ctx.home.state, 'conversations'), sessionId), 'base_state.json'), 'utf8')) as unknown;
    status = isObject(state) ? state.execution_status : undefined;
  } catch {
    return; // nothing to tell
  }
  if (String(status).toLowerCase() === 'stuck') throw new AgentRunError(t().openhandsStuck);
}

/** What the model reads about an action an earlier turn left: it did not run, and should not again unasked. */
export const LEFTOVER_REASON =
  'Not run: this action was left unfinished when an earlier turn was stopped or cut off (Harness Relay rejected it ' +
  'before this turn). Do not run it again unless the user asks for it in this message.';

/**
 * Rejects the actions an earlier turn left, as OpenHands records a rejection (a `UserRejectObservation`
 * event for each, at the log's next indexes), so that resuming the session neither runs them nor asks
 * about them; the model reads why. Returns how many it rejected.
 */
export function openhandsRejectLeftovers(sessionDir: string, log: OpenhandsEventLog = openhandsEventLog(sessionDir), now = new Date()): number {
  if (!log.sound) throw new Error('the session\'s event log is not as OpenHands writes it');
  log.actions.forEach((a, i) => {
    const id = randomUUID();
    const event = {
      id,
      timestamp: now.toISOString().replace(/Z$/, ''),
      source: 'environment',
      tool_name: a.toolName,
      tool_call_id: a.toolCallId,
      rejection_reason: LEFTOVER_REASON,
      rejection_source: 'user',
      action_id: a.id,
      kind: 'UserRejectObservation',
    };
    writeFileSync(join(sessionDir, 'events', `event-${String(log.next + i).padStart(5, '0')}-${id}.json`), JSON.stringify(event), { flag: 'wx', mode: 0o600 });
  });
  return log.actions.length;
}

/** Whether a session's stored system prompt (its first event) holds `text`. */
export function openhandsSessionHas(sessionDir: string, text: string): boolean {
  const events = join(sessionDir, 'events');
  const first = listDir(events).find((n) => n.startsWith('event-00000-') && n.endsWith('.json'));
  if (!first) return false;
  const want = text.trim();
  const found = (x: unknown): boolean =>
    typeof x === 'string' ? x.includes(want) : Array.isArray(x) ? x.some(found) : Boolean(x) && typeof x === 'object' && Object.values(x as object).some(found);
  try {
    return found(JSON.parse(readFileSync(join(events, first), 'utf8')));
  } catch {
    return false;
  }
}

/** The prompt as sent: with the briefing in front when the resumed session lacks it, and no leading `/`. */
export function openhandsPromptText(text: string, ctx: Pick<OpenRunContext, 'state'>): string {
  const briefing = ctx.state.briefingInPrompt as string | undefined;
  return acpPromptText(briefing ? `<harness-relay-briefing>\n${briefing.trim()}\n</harness-relay-briefing>\n\n${text}` : text);
}

/** Writes a file only its owner reads. */
function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

/**
 * Writes the run's home in its temp folder and points OpenHands at it: settings, MCP servers, briefing,
 * the public skills turned off, the terminal's `.bashrc`; checks a session to resume is there.
 */
export function prepareOpenhands(ctx: OpenRunContext, uid = process.getuid?.() ?? 0, platform: NodeJS.Platform = process.platform): void {
  const { o, run, env, tmpDir } = ctx;
  // Its terminal is a pseudo-terminal, which the relay sandbox on macOS can only allow along with the
  // user's other terminal windows: only when the user said so (Settings, OpenHands' card).
  if (ctx.sandboxed && openhandsNeedsTerminalSwitch(platform) && !o.sandboxTerminal) throw new AgentRunError(t().openhandsNoTerminal);
  const effort = openhandsSentEffort(openhandsEffort(o.effort), openhandsModelInfo(litellmModelList(o.bin, env)?.data, run));
  const conversations = join(ctx.home.state, 'conversations');
  mkdirSync(conversations, { recursive: true, mode: 0o700 });
  let before: OpenhandsMetrics | undefined = { input: 0, output: 0, cost: 0 };
  if (o.sessionId) {
    // OpenHands "loads" an unknown session as a new, empty one: say so, so the orchestrator starts afresh with the history.
    const saved = join(openhandsSessionDir(conversations, o.sessionId), 'base_state.json');
    if (!UUID_RE.test(o.sessionId) || !existsSync(saved)) throw new AgentRunError(t().openResumeFailed(CLI, t().openhandsNoSuchSession));
    // Actions an earlier turn left (it was stopped, or the server went down while one waited for an
    // answer): OpenHands would run them before anything else, without asking or showing them (its
    // "implicit confirmation"). They are rejected first, so the model reads that they did not run; when
    // that cannot be done, or the log is not one Harness Relay reads as OpenHands does (so which actions
    // it holds is not known), the session is not resumed (the orchestrator starts afresh with the history).
    const dir = openhandsSessionDir(conversations, o.sessionId);
    const log = openhandsEventLog(dir);
    if (!openhandsResumable(log)) throw new AgentRunError(t().openResumeFailed(CLI, t().openhandsOddLog));
    try {
      ctx.state.leftovers = openhandsRejectLeftovers(dir, log);
    } catch {
      throw new AgentRunError(t().openResumeFailed(CLI, t().openhandsLeftover(log.actions.length)));
    }
    try {
      before = openhandsSavedMetrics(JSON.parse(readFileSync(saved, 'utf8')));
    } catch {
      before = undefined; // the turn's usage is then not known
    }
    // Its system prompt, with the briefing, is kept from the session's start: a briefing changed since
    // (another permission, another team) goes before this prompt instead.
    const briefing = acpBriefing(o, openhandsAcp);
    if (briefing && !openhandsSessionHas(openhandsSessionDir(conversations, o.sessionId), briefing)) ctx.state.briefingInPrompt = briefing;
  }
  ctx.state.before = before;

  const home = join(tmpDir, 'home');
  const own = join(home, '.openhands');
  const settings = join(own, 'agent_settings.json');
  const mcp = join(own, 'mcp.json');
  const skills = join(own, 'skills');
  const skillCache = join(own, 'cache', 'skills');
  const bashrc = join(home, '.bashrc');
  writePrivate(settings, JSON.stringify(openhandsAgentSettings(run, effort, o.permission), null, 2));
  writePrivate(mcp, JSON.stringify(openhandsMcpConfig(o.mcpServers ?? []), null, 2));
  const briefing = acpBriefing(o, openhandsAcp);
  if (briefing) writePrivate(join(skills, OPENHANDS_BRIEFING_SKILL), `${briefing}\n`);
  else mkdirSync(skills, { recursive: true, mode: 0o700 });
  // A plain file where it would clone its public skills: the clone fails at once, without the network.
  writePrivate(join(skillCache, 'public-skills'), 'Turned off by Harness Relay.\n');
  writePrivate(bashrc, openhandsBashrc(o.env));

  const terminal = openhandsTerminal(tmpDir, { sandboxed: ctx.sandboxed, platform, uid });
  ctx.state.terminal = terminal.mode;
  if (terminal.dir) ctx.state.tmuxDir = terminal.dir;
  if (terminal.own) {
    ctx.state.ownTmuxDir = terminal.dir;
    ctx.home.statePaths.push(terminal.dir!);
  }
  ctx.home.configPaths.push(settings, mcp, skills, skillCache, bashrc);
  if (terminal.mode === 'pty' && platform !== 'win32') {
    // It uses tmux when `tmux -V` works, and has no other switch: a `tmux` that fails comes first on its PATH.
    const shim = join(tmpDir, 'bin');
    writePrivate(join(shim, 'tmux'), OPENHANDS_NO_TMUX);
    chmodSync(join(shim, 'tmux'), 0o700);
    env.PATH = [shim, env.PATH].filter(Boolean).join(delimiter);
    ctx.home.configPaths.push(shim);
  }

  Object.assign(env, {
    HOME: home,
    OPENHANDS_PERSISTENCE_DIR: own,
    PERSISTENCE_DIR: own, // its cli_config.json reads this one
    OPENHANDS_CONVERSATIONS_DIR: conversations,
    OPENHANDS_WORK_DIR: o.cwd, // a loaded session's workspace, and where it looks for the project's skills
    ...(terminal.dir ? { TMUX_TMPDIR: terminal.dir } : {}),
    OPENHANDS_SUPPRESS_BANNER: '1',
    ...LITELLM_LOCAL,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
  });
  // An endpoint is reached as OpenAI-compatible: its key under OpenAI's variable (a placeholder when it needs none).
  if (run.kind === 'endpoint') env.OPENAI_API_KEY = run.endpoint?.apiKey || 'no-key';
  // In the relay sandbox, the sandbox sets them (its proxy); with full access, `.env` cannot.
  if (!ctx.sandboxed) for (const name of PROXY_VARS) if (env[name] === undefined) env[name] = '';
}

/** The processes to kill after a run: its tmux server and every descendant of it (from `ps -A -o pid=,ppid=`), never `self`. */
export function openhandsTreePids(server: number, psOut: string, self: number): number[] {
  return Number.isInteger(server) && server > 1 ? leftoverSweepPids(String(server), psOut, self) : [];
}

/**
 * Ends the run's tmux server (full access only) and removes its own socket folder, if it had one. The
 * server outlives OpenHands, outside its process group, and stopping it only hangs up on its shells,
 * which a backgrounded command ignores (`nohup … &`): the server and everything under it are killed
 * (SIGKILL), then the server is told to stop in case it is still there.
 */
export async function cleanupOpenhands(
  ctx: OpenRunContext,
  run: typeof runProcess = runProcess,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal),
): Promise<void> {
  const dir = ctx.state.tmuxDir as string | undefined;
  try {
    if (dir && existsSync(openhandsSocketPath(dir, process.getuid?.() ?? 0))) {
      const env = { PATH: ctx.env.PATH, TMUX_TMPDIR: dir };
      const server = await run({ bin: 'tmux', args: ['-L', OPENHANDS_TMUX_SOCKET, 'list-sessions', '-F', '#{pid}'], env, timeoutMs: 5000 });
      const pid = Number(server.stdout.split('\n')[0]?.trim());
      if (pid > 1) {
        const ps = await run({ bin: 'ps', args: ['-A', '-o', 'pid=,ppid='], env, timeoutMs: 5000 });
        for (const p of openhandsTreePids(pid, ps.stdout, process.pid)) {
          try {
            kill(p, 'SIGKILL');
          } catch {
            // gone already
          }
        }
      }
      await run({ bin: 'tmux', args: ['-L', OPENHANDS_TMUX_SOCKET, 'kill-server'], env, timeoutMs: 5000 });
    }
  } finally {
    const own = ctx.state.ownTmuxDir as string | undefined;
    if (own) rmSync(own, { recursive: true, force: true });
  }
}

// --- What the relay sandbox must let it do ---------------------------------------------------------------

/**
 * Whether its runs below full access need the user's switch for a terminal in the relay sandbox
 * (`RunOptions.sandboxTerminal`): on macOS, where the sandbox allows pseudo-terminals only all at once
 * (`/dev/ptmx` and every `/dev/ttys*`, so a command can print into the user's other terminal windows,
 * read what is typed there and change their settings; `TIOCSTI`, typing into them, stays refused). Not
 * on Linux, where bubblewrap gives the sandbox a `/dev/pts` of its own (a new devpts instance holding
 * only its own terminals; checked with bubblewrap 0.8.0 and srt 0.0.82).
 */
export function openhandsNeedsTerminalSwitch(platform: NodeJS.Platform): boolean {
  return platform === 'darwin';
}

/**
 * What OpenHands needs from the relay sandbox below full access (`sandbox` hook), in one place:
 * - writable: its sessions (`statePaths`) and the run's temp folder, which holds the run's home (its
 *   caches, its shell history); read-only: the run's config there (`configPaths`, added by `prepare`:
 *   settings, MCP servers, skills, the public-skills placeholder, `.bashrc`, the `tmux` stand-in);
 *   hosts: the run's backend only, nothing quietly denied (the fetches it would make at start, of its
 *   public skills and LiteLLM's price list, are turned off in `prepare`);
 * - `allowPty`: its terminal is a pseudo-terminal (`fork failed` without; checked with srt 0.0.82:
 *   every turn fails, even one with no tools, since OpenHands starts its terminal at once). On macOS
 *   only with the user's switch (`openhandsNeedsTerminalSwitch`; `prepare` refuses the run without it).
 */
export function openhandsSandbox(): OpenSandboxNeeds {
  return { allowPty: true };
}

// --- Its approvals ------------------------------------------------------------------------------------------

/** A tool call it announced, or an action its session's log holds (with the tool's own name, `tool_name`). */
export type OpenhandsCall = AcpToolCall & { toolName?: string };

/** What one tool call it announced is, from its action (`rawInput.kind`). */
export function openhandsCallInfo(call: OpenhandsCall): Partial<AcpCallInfo> & { kind: string } {
  const input = call.rawInput ?? {};
  const title = typeof call.title === 'string' && call.title.trim() ? call.title : undefined;
  const path = typeof input.path === 'string' ? input.path : call.locations?.find((l) => typeof l?.path === 'string')?.path;
  switch (input.kind) {
    case 'TerminalAction':
      return { kind: 'execute', tool: 'terminal', command: commandLine(input.command) ?? '', ...(title ? { title } : {}) };
    case 'FileEditorAction':
      return { kind: (input.editor_command ?? input.command) === 'view' ? 'read' : 'edit', tool: 'file_editor', ...(path ? { path } : {}), ...(title ? { title } : {}) };
    case 'TaskTrackerAction':
      return { kind: 'think', tool: 'task_tracker', title: title ?? 'task_tracker' };
    case 'InvokeSkillAction':
      // Invoking a skill runs the shell commands its SKILL.md holds inline (`!\`cmd\``, in the working
      // directory, with OpenHands' own rights): not a read.
      return { kind: 'other', tool: 'invoke_skill', title: title ?? `invoke_skill ${String(input.name ?? '')}`.trim() };
    case 'ThinkAction':
    case 'FinishAction':
      return { kind: 'think', title: title ?? 'think' };
    case 'TaskAction':
    case 'DelegateAction':
      return { kind: 'other', tool: input.kind === 'TaskAction' ? 'task' : 'delegate', title: title ?? 'subagent', ...(typeof input.description === 'string' ? { reason: input.description } : {}) };
    case 'MCPToolAction': {
      // Its update names no tool (only the model's summary, as its title): the log does (`tool_name`).
      // The card shows the tool and what it is given; "always allow" goes by the tool.
      const name = call.toolName?.trim() || undefined;
      const data = input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? (input.data as Record<string, unknown>) : undefined;
      return { kind: 'other', tool: name ?? title ?? 'MCP tool', ...(title || name ? { title: title ?? name } : {}), ...(data ? { input: data } : {}) };
    }
    default:
      return { kind: call.kind ?? 'other', ...(title ? { title } : {}) };
  }
}

/** How little the permission covers a call: the request is decided by the one it covers least. */
function rank(info: Partial<AcpCallInfo> & { kind: string }): number {
  if (info.tool === 'task' || info.tool === 'delegate') return 6;
  if (info.kind === 'execute') return info.command && isPublishCommand(info.command) ? 5 : 4;
  if (info.kind === 'edit' || info.kind === 'delete' || info.kind === 'move') return 3;
  if (info.kind === 'other') return 2;
  if (info.kind === 'fetch') return 1;
  return 0;
}

/**
 * A described call with the calls its request covers (`openhandsDescribeCall`), for `openhandsDecide`;
 * `unsure`: the calls announced before the request are not the actions OpenHands holds waiting.
 */
export type OpenhandsCallInfo = AcpCallInfo & { calls?: OpenhandsCoveredCall[]; unsure?: boolean };

/** One call a request covers, with its `toolCallId` (`id`), for the label of its row. */
export type OpenhandsCoveredCall = Partial<AcpCallInfo> & { kind: string; id?: string };

/** A call as the card lists it. */
const callName = (i: Partial<AcpCallInfo>) => (i.command ? `$ ${i.command}` : [i.title ?? i.tool ?? 'action', i.path].filter(Boolean).join(': '));

/** Calls that only read, plan or think: every permission lets them run. */
const onlyReads = (i: Partial<AcpCallInfo> & { kind: string }) => (i.kind === 'read' || i.kind === 'think') && !i.command;

/** The rule key of a request whose calls cannot be told (kind `other`): the same in every language. */
const UNKNOWN_TOOL = 'OpenHands action';

/** The run and session a request comes in (`describeCall`'s `turn`). */
export interface OpenhandsTurn {
  ctx: Pick<OpenRunContext, 'home'>;
  sessionId?: string;
}

/**
 * The calls OpenHands' permission request is about. It stores each action in the session's log before
 * it announces it and asks (`openhandsEventLog`): the actions there with no answer are what one answer
 * lets run. Those are described (with the titles their updates gave); when they are not exactly the
 * calls announced since the previous request (an update that came late, a log changed by something
 * else), the request is `unsure`. Without a log for the session (no `events` folder: the replayed
 * stand-in of the tests), the announced calls.
 */
export function openhandsRequestCalls(recent: AcpToolCall[], turn: OpenhandsTurn | undefined): { calls: OpenhandsCall[]; unsure: boolean } {
  if (!turn?.sessionId) return { calls: recent, unsure: false };
  const dir = openhandsSessionDir(join(turn.ctx.home.state, 'conversations'), turn.sessionId);
  if (!existsSync(join(dir, 'events'))) return { calls: recent, unsure: false };
  const log = openhandsEventLog(dir);
  if (!log.sound) return { calls: recent, unsure: true };
  const announced = new Map(recent.map((c) => [String(c.toolCallId), c]));
  const calls = log.actions.map((a): OpenhandsCall => {
    const c = announced.get(a.toolCallId);
    return { ...c, toolCallId: a.toolCallId, rawInput: a.action, toolName: a.toolName };
  });
  const same = calls.length === recent.length && calls.every((c) => announced.has(String(c.toolCallId)));
  return { calls, unsure: !same };
}

/**
 * The calls OpenHands' permission request covers: it names none (`confirmation-<session>`, kind
 * `other`), so it is about the actions it holds waiting (`openhandsRequestCalls`: the tool calls it
 * announced since the previous request), and one answer lets them all run. `calls` holds each of them
 * for `openhandsDecide`, which allows the request only when the permission covers every one. What goes
 * to the user names them all, keyed for "always allow" by all of them: their commands, one per line,
 * when they all run commands; their files, one per line, when they all edit; otherwise the whole list,
 * so that an "always" answer matches only the same calls again. Its title and reason are in the user's
 * language; its rule keys (`tool`) are not.
 */
export function openhandsDescribeCall(_call: AcpToolCall, _earlier: AcpToolCall | undefined, recent: AcpToolCall[], turn?: OpenhandsTurn): Partial<OpenhandsCallInfo> {
  const { calls: covered, unsure } = openhandsRequestCalls(recent, turn);
  const flag = unsure ? { unsure: true } : {};
  // Nothing tells such a request apart: it is allowed once only, never always (`anonymous`: no rule keys).
  if (!covered.length) return { kind: 'other', title: t().openhandsAction, tool: UNKNOWN_TOOL, calls: [], anonymous: true, ...flag };
  const calls: OpenhandsCoveredCall[] = covered.map((c) => ({ ...openhandsCallInfo(c), ...(c.toolCallId ? { id: String(c.toolCallId) } : {}) }));
  const { id: _, ...pick } = calls.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  const title = pick.title ?? (pick.command || pick.path ? callName(pick) : (pick.tool ?? t().openhandsAction));
  if (calls.length === 1) return { ...pick, title, calls, ...flag };
  const reason = t().openhandsBatch(calls.length, calls.map(callName));
  const acting = calls.filter((i) => !onlyReads(i));
  const head = { title: t().openhandsBatchTitle(title, calls.length - 1), reason, calls, ...flag };
  if (acting.length && acting.every((i) => i.kind === 'execute')) return { ...head, kind: 'execute', command: acting.map((i) => i.command ?? '').join('\n') };
  if (acting.length && acting.every((i) => i.kind === 'edit')) {
    const paths = acting.map((i) => i.path).filter((p): p is string => Boolean(p));
    return { ...head, kind: 'edit', ...(paths.length ? { path: [...new Set(paths)].join('\n') } : {}) };
  }
  if (!acting.length) return { ...head, kind: pick.kind };
  return { ...head, kind: 'other', tool: `OpenHands: ${acting.map(callName).join('; ')}` };
}

/** Why a request about calls Harness Relay cannot tell is not run (when the conversation refuses by itself). */
const UNKNOWN_REASON =
  'Not run: Harness Relay could not tell which action this permission request is about, so it was not allowed. ' +
  'Run the action again as a new tool call if it is still needed.';

/**
 * The decision about a request, over every call it covers: allowed without asking only when the
 * permission covers each one; else the user decides (as for the strictest of them). Its subagents run
 * their own commands and edits without asking: refused below full access, without asking the user. A
 * request whose calls cannot be told (it came without the calls announced before it, as for an action
 * left from an earlier turn, or those are not the actions OpenHands holds waiting) is never allowed by itself.
 */
export function openhandsDecide(permission: Permission, info: OpenhandsCallInfo): AcpDecision | undefined {
  if (permission === 'full') return undefined;
  const calls: OpenhandsCoveredCall[] = info.calls ?? [info];
  // Each row of a batch says why it did not run: its own reason, or that another one held the batch back.
  const rows = (own: (c: OpenhandsCoveredCall) => string | undefined) =>
    calls.length > 1 ? { labels: Object.fromEntries(calls.filter((c) => c.id).map((c) => [c.id!, own(c) ?? t().openhandsBatchRefused])) } : {};
  const subagent = (c: OpenhandsCoveredCall) => c.tool === 'task' || c.tool === 'delegate';
  if (calls.some(subagent)) {
    return {
      allow: false,
      reason:
        'Not run: OpenHands subagents run their own commands and edits without asking, which this conversation\'s permission ' +
        '(the user\'s Harness Relay setting) does not allow. Do not retry it; do the work yourself with your own tools.',
      label: t().openhandsSubagentRefused,
      ...rows((c) => (subagent(c) ? t().openhandsSubagentRefused : undefined)),
    };
  }
  if (!calls.length || info.unsure) return { allow: false, ask: true, reason: UNKNOWN_REASON, label: t().openhandsUnknownAction };
  const decisions = calls.map((c) => acpPermissionDecision(permission, { title: c.title ?? c.tool ?? 'tool', ...c }, CLI));
  const refused = decisions.find((d) => !d.allow);
  if (!refused || refused.allow) return { allow: true };
  return { ...refused, ask: true, ...rows((c) => {
    const d = decisions[calls.indexOf(c)]!;
    return d.allow ? undefined : d.label;
  }) };
}

// --- Its updates -----------------------------------------------------------------------------------------------

/** Its tool names, by action. */
const TOOL_NAMES: Record<string, string> = {
  TerminalAction: 'terminal',
  FileEditorAction: 'file_editor',
  TaskTrackerAction: 'task_tracker',
  InvokeSkillAction: 'invoke_skill',
  TaskAction: 'task',
  DelegateAction: 'delegate',
};

/** A tool row's name: the tool's own (an MCP tool's comes only as the model's title). */
export function openhandsToolName(u: Record<string, any>): string {
  const kind = u.rawInput?.kind;
  const editor = kind === 'FileEditorAction' && typeof u.rawInput?.editor_command === 'string' ? ` ${u.rawInput.editor_command}` : '';
  return TOOL_NAMES[kind] ? `${TOOL_NAMES[kind]}${editor}` : typeof u.title === 'string' && u.title.trim() ? u.title : String(u.kind ?? 'tool');
}

/**
 * A file editor call's input with its `command` (`view`, `create`, `str_replace`…) renamed
 * `editor_command`: a `command` reads as a shell command elsewhere, and the row's detail is then its path.
 */
export function openhandsInput(input: Record<string, any> | undefined): Record<string, any> | undefined {
  if (input?.kind !== 'FileEditorAction' || !('command' in input)) return input;
  const { command, ...rest } = input;
  return { ...rest, editor_command: command };
}

const REASONING_HEADER = '**Reasoning**:\n';
const THOUGHT_HEADER = '\n**Thought**:\n';
const FINISH = 'Finish with message:\n';

/** A thought without the header OpenHands puts before it. */
export function openhandsThought(text: string): string {
  if (text.startsWith(REASONING_HEADER)) return text.slice(REASONING_HEADER.length).trimEnd();
  if (text.startsWith(THOUGHT_HEADER)) return text.slice(THOUGHT_HEADER.length).trimEnd();
  return text;
}

/**
 * Whether a message chunk looks like OpenHands telling the failure the prompt's error then gives
 * (`Error: <the exception>`, sent right before it fails the prompt). Only looks like it: the model may
 * begin a reply the same way ("Error: AssertionError in test_parse…"), so such a chunk is held back
 * (`openhandsFilterUpdate`) and shown once anything comes after it or the prompt answers.
 */
export function isOpenhandsErrorNotice(text: string): boolean {
  return /^Error: (Conversation run failed for id=|new-session: |[\w.]*(Error|Exception)\b)/.test(text);
}

/**
 * The text of an agent message as the model wrote it: OpenHands sends its own rendering, which for a
 * `finish` call holds the call's header and for a reply may end with a reasoning summary or the skills
 * it brought in.
 */
export function openhandsMessageText(text: string): string {
  if (text.trim() === '[no text content]') return '';
  const finish = text.lastIndexOf(FINISH);
  if (finish >= 0 && /^(Predicted Security Risk: |Summary: |Reasoning:\n|Thought:\n|$)/.test(text.slice(0, finish))) return text.slice(finish + FINISH.length);
  let out = text;
  const skills = out.lastIndexOf('\n\nActivated Skills: ');
  if (skills >= 0 && !out.slice(skills + 2).includes('\n')) out = out.slice(0, skills);
  const reasoning = out.lastIndexOf('\n\nReasoning:\n');
  if (reasoning >= 0 && !out.slice(reasoning + 2).includes('\n\n')) out = out.slice(0, reasoning);
  return out;
}

/** The text of an observation (its content blocks). */
function observationText(obs: Record<string, any>): string {
  const blocks = Array.isArray(obs.content) ? obs.content : [];
  return blocks
    .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * A command's output without the command itself in front: its plain pseudo-terminal (no tmux) echoes
 * the line it was given, wrapped at the terminal's width.
 */
export function withoutEcho(text: string, command: string | undefined): string {
  if (!command) return text;
  const squash = (s: string) => s.replace(/\s+/g, '');
  const want = squash(command);
  if (!want) return text;
  let got = '';
  for (let at = 0; at < text.length; ) {
    const nl = text.indexOf('\n', at);
    const line = nl < 0 ? text.slice(at) : text.slice(at, nl);
    got += squash(line);
    if (got === want) return nl < 0 ? '' : text.slice(nl + 1);
    if (!want.startsWith(got)) return text;
    if (nl < 0) return text;
    at = nl + 1;
  }
  return text;
}

const block = (text: string) => (text ? [{ type: 'content', content: { type: 'text', text } }] : []);

/**
 * A tool's result as the turn should read it: from its observation (`rawOutput`), failed when that says
 * so (an error, a non-zero exit code, a timeout), with its own output rather than OpenHands' rendering.
 */
export function openhandsToolResult(
  u: Record<string, any>,
  command?: string,
  sandbox?: 'read-only' | 'edit',
  isProtected: (text: string) => boolean = () => false,
): Record<string, any> {
  const { rawOutput, ...rest } = u;
  const obs = rawOutput?.observation;
  if (u.status === 'completed' && obs && typeof obs === 'object') {
    let text = withoutEcho(observationText(obs), command ?? (typeof obs.command === 'string' ? obs.command : undefined));
    const code = typeof obs.exit_code === 'number' ? obs.exit_code : undefined;
    const failed = obs.is_error === true || (code !== undefined && code > 0) || obs.timeout === true;
    if (failed && code !== undefined && code > 0) text = `${text}${text ? '\n' : ''}(exit code ${code})`;
    return { ...rest, status: failed ? 'failed' : 'completed', content: block(failed ? sandboxed(text, sandbox, isProtected) : text) };
  }
  if (u.status === 'failed') {
    const raw = Array.isArray(u.content) ? u.content.map((c: any) => c?.content?.text ?? '').join('\n') : '';
    const text = raw
      .replace(/^Tool: [^\n]*\n+/, '')
      .replace(/^(Rejection Reason|Error Details):\n/, '')
      .trim();
    return { ...rest, content: block(sandboxed(text, sandbox, isProtected)) };
  }
  return rest;
}

/**
 * A failure the relay sandbox caused says so first (the sandbox's word for it: `Operation not
 * permitted`): a protected path (`RunOptions.protectedPaths`: Harness Relay's database and temporary
 * folder, browsers' data), which no agent may read; else what the permission lets it write.
 */
function sandboxed(text: string, sandbox: 'read-only' | 'edit' | undefined, isProtected: (text: string) => boolean): string {
  if (!sandbox || !/Operation not permitted/.test(text)) return text;
  const why = isProtected(text) ? t().openhandsSandboxProtected : sandbox === 'read-only' ? t().openhandsSandboxRefusedReadOnly : t().openhandsSandboxRefused;
  return `${why}\n${text.replace(/^\u274c \[An error occurred during execution\.\]\n/, '')}`;
}

type FilterContext = Pick<OpenRunContext, 'state'> & Partial<Pick<OpenRunContext, 'sandboxed' | 'o'>>;

/** The message held back as what may be OpenHands' notice of a failure, taken out of the run's state. */
function takeHeldNotice(ctx: Pick<OpenRunContext, 'state'>): Record<string, any> | undefined {
  const held = ctx.state.heldNotice as Record<string, any> | undefined;
  delete ctx.state.heldNotice;
  return held;
}

/**
 * The messages still held back once the prompt has answered: it did not fail, so what looked like
 * OpenHands' notice of a failure was the model's own reply (`heldUpdates`).
 */
export function openhandsHeldUpdates(ctx: Pick<OpenRunContext, 'state'>): Record<string, any>[] {
  const held = takeHeldNotice(ctx);
  return held ? [held] : [];
}

/**
 * Each update before the turn reads it (OpenHands' `_meta` metrics are kept for the turn's usage). A
 * message that looks like its notice of a failure is held back: if anything comes after it, it was the
 * model's, and goes before that; if the prompt fails right after it, it is dropped (the error says it).
 */
export function openhandsFilterUpdate(
  params: { update: Record<string, any>; _meta?: unknown },
  ctx: FilterContext,
): Record<string, any> | Record<string, any>[] | undefined {
  const metrics = openhandsUpdateMetrics(params._meta);
  if (metrics) ctx.state.metrics = metrics;
  if (!params.update) return undefined;
  const earlier = takeHeldNotice(ctx);
  const update = filterOne(params.update, ctx);
  return earlier ? [earlier, ...(update ? [update] : [])] : update;
}

function filterOne(u: Record<string, any>, ctx: FilterContext): Record<string, any> | undefined {
  const text: unknown = u.content?.text;
  switch (u.sessionUpdate) {
    case 'agent_thought_chunk': {
      if (typeof text !== 'string') return u;
      // Its whole system prompt, at the start of a new session; and its note after a cancel.
      if (text.startsWith('System Prompt:') || text.trim() === 'Conversation Paused') return undefined;
      const thought = openhandsThought(text);
      return thought.trim() ? { ...u, content: { ...u.content, text: thought } } : undefined;
    }
    case 'agent_message_chunk': {
      if (typeof text !== 'string') return u;
      const message = openhandsMessageText(text);
      if (isOpenhandsErrorNotice(text)) {
        if (message) ctx.state.heldNotice = { ...u, content: { ...u.content, text: message } };
        return undefined;
      }
      return message ? { ...u, content: { ...u.content, text: message } } : undefined;
    }
    case 'tool_call': {
      if (u.rawInput?.kind === 'TerminalAction' && typeof u.rawInput.command === 'string' && u.toolCallId) {
        const commands = (ctx.state.commands ??= {}) as Record<string, string>;
        commands[String(u.toolCallId)] = u.rawInput.command;
      }
      if (typeof u.rawInput?.path === 'string' && u.toolCallId) ((ctx.state.paths ??= {}) as Record<string, string>)[String(u.toolCallId)] = u.rawInput.path;
      return u.rawInput ? { ...u, rawInput: openhandsInput(u.rawInput) } : u;
    }
    case 'tool_call_update':
      return openhandsToolResult(
        u.rawInput ? { ...u, rawInput: openhandsInput(u.rawInput) } : u,
        (ctx.state.commands as Record<string, string> | undefined)?.[String(u.toolCallId)],
        ctx.sandboxed && ctx.o && ctx.o.permission !== 'full' ? ctx.o.permission : undefined,
        (text) => {
          // The paths the sandbox keeps every agent from reading, as it was given them (`open.ts`).
          const paths = (ctx.state.protectedPaths ??= ctx.o?.protectedPaths ?? protectedReads()) as string[];
          const path = (ctx.state.paths as Record<string, string> | undefined)?.[String(u.toolCallId)];
          return paths.some((p) => (path !== undefined && overlaps(path, p)) || text.includes(p));
        },
      );
    default:
      return u;
  }
}

// --- Its errors ------------------------------------------------------------------------------------------------

/** What OpenHands said went wrong: the `details` of its JSON-RPC error, without its log-folder hint. */
export function openhandsErrorDetail(message: string): string {
  let detail = message;
  // A JSON-RPC error as acp.ts words it: `<message>: {"reason": …, "details": …}`.
  const at = /^[A-Z][\w ]*: \{/.test(message) ? message.indexOf('{') : -1;
  if (at >= 0) {
    try {
      const data = JSON.parse(message.slice(at)) as { details?: unknown; reason?: unknown };
      detail = String(data.details ?? data.reason ?? message);
    } catch {
      // not JSON: as it is
    }
  }
  return detail
    .split(/\n\nConversation logs are stored at:/)[0]!
    .replace(/^Conversation run failed for id=[0-9a-f-]+: /i, '')
    .trim();
}

/** An error the user can act on, from a turn that failed: a refused key, a model the backend lacks, an unreachable backend… */
export function openhandsError(err: unknown, o: Pick<RunOptions, 'model' | 'backends'>): unknown {
  if (!(err instanceof AgentRunError) || err.aborted) return err;
  const detail = openhandsErrorDetail(err.message);
  const parsed = parseBackendModel(o.model ?? '');
  const backend = parsed ? (o.backends ? backendLabel(o.backends, parsed.backend) : isApiBackend(parsed.backend) ? API_BACKEND_LABEL[parsed.backend] : parsed.backend) : CLI;
  const model = parsed?.model ?? o.model ?? '';
  let message: string | undefined;
  if (/does not support parameter reasoning|reasoning_?effort.{0,40}(not supported|unsupported|unrecognized|unknown)/i.test(detail)) message = t().openhandsNoEffort(backend, model);
  else if (/litellm\.AuthenticationError|Error code: 401|invalid x-api-key|Incorrect API key/i.test(detail)) message = t().openhandsBadKey(backend);
  else if (/litellm\.NotFoundError|model_not_found|does not exist|not_found_error|Model .* not found/i.test(detail)) message = t().openhandsBadModel(backend, model);
  else if (/litellm\.RateLimitError|Error code: 429|insufficient_quota/i.test(detail)) message = t().openhandsRateLimited(backend, short(detail));
  // Below full access the relay sandbox's proxy answers a backend it cannot reach with 502 Bad Gateway
  // (LiteLLM: `BadGatewayError`; a tunnel it could not open, `Tunnel connection failed`).
  else if (/litellm\.(APIConnectionError|Timeout|BadGatewayError)|Connection error|ConnectError|nodename nor servname|Name or service not known|Connection refused|ProxyError|Error code: 502|Bad Gateway|Tunnel connection failed/i.test(detail)) message = t().openhandsUnreachable(backend, short(detail));
  else if (/^new-session: |fork failed|tmux/i.test(detail)) message = t().openhandsTerminal(short(detail));
  else if (detail !== err.message) message = t().openhandsFailed(short(detail));
  return message ? new AgentRunError(message) : err;
}

/** The first lines of a long detail. */
function short(text: string, n = 400): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// --- The model catalog ---------------------------------------------------------------------------------------

/** The site-packages folders of the Python OpenHands runs on, from its program (its `#!` line, or where it is). */
export function openhandsSitePackages(bin: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const venvs = new Set<string>();
  for (const path of commandPaths(bin, env)) {
    venvs.add(dirname(dirname(path)));
    try {
      const first = readFileSync(path).subarray(0, 512).toString('utf8').split('\n')[0] ?? '';
      const py = first.startsWith('#!') ? first.slice(2).trim().split(/\s+/)[0] : undefined;
      if (py) venvs.add(dirname(dirname(py)));
    } catch {
      // not readable
    }
  }
  const out: string[] = [];
  for (const venv of venvs) {
    out.push(join(venv, 'Lib', 'site-packages'));
    for (const name of listDir(join(venv, 'lib'))) if (name.startsWith('python')) out.push(join(venv, 'lib', name, 'site-packages'));
  }
  return [...new Set(out)].filter((p) => existsSync(p));
}

const CATALOG_BACKENDS = ['openai', 'anthropic', 'xai'] as const;
const DATED = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;
const NOT_FOR_AGENTS = /audio|search|realtime|tts|transcribe|image/;

/**
 * OpenHands' models: LiteLLM's model list as the OpenHands install has it (its own copy, which
 * OpenHands reads instead of fetching one), for the API backends: chat models that call tools, without
 * fine-tune templates, audio or search models, nor dated snapshots of a model listed without a date;
 * by family, the newest first.
 */
export function parseOpenhandsCatalog(json: string | Record<string, unknown>): ModelOption[] {
  const data = (typeof json === 'string' ? JSON.parse(json) : json) as Record<string, any>;
  const models: ModelOption[] = [];
  for (const backend of CATALOG_BACKENDS) {
    const names = new Set<string>();
    for (const [key, v] of Object.entries(data)) {
      if (!v || typeof v !== 'object' || v.litellm_provider !== backend) continue;
      if ((v.mode !== 'chat' && v.mode !== 'responses') || v.supports_function_calling !== true) continue;
      const name = key.startsWith(`${backend}/`) ? key.slice(backend.length + 1) : key;
      if (!name || name.includes('/') || name.startsWith('ft:') || NOT_FOR_AGENTS.test(name)) continue;
      names.add(name);
    }
    const kept = [...names].filter((n) => !(DATED.test(n) && names.has(n.replace(DATED, ''))));
    // By family (the name up to its first digit), the newest version of each first.
    const family = (n: string) => /^\D*/.exec(n)![0];
    kept.sort((a, b) => family(a).localeCompare(family(b), 'en') || b.localeCompare(a, 'en', { numeric: true }));
    for (const name of kept) {
      const info = openhandsModelInfo(data, { kind: backend, model: name });
      models.push({ id: `${backend}/${name}`, label: `${name} · ${API_BACKEND_LABEL[backend]}`, efforts: openhandsModelEfforts(info) });
    }
  }
  return models;
}

/**
 * The efforts a model of LiteLLM's list takes: none for a model it says does not reason; `xhigh` only
 * where it says so. (xAI refuses an effort for several models LiteLLM marks as reasoning, such as
 * grok-code-fast-1: such a turn fails with what to set instead, `openhandsError`.)
 */
export function openhandsModelEfforts(info: LitellmModelInfo | undefined): string[] {
  if (!info || info.supports_reasoning !== true) return [];
  return OPENHANDS_EFFORTS.filter((e) => e !== 'xhigh' || info.supports_xhigh_reasoning_effort === true);
}

/** LiteLLM's model list in the OpenHands install, read once per file version. */
const LITELLM_LIST = 'model_prices_and_context_window_backup.json';
let litellmCache: { file: string; mtime: number; data: Record<string, unknown> } | undefined;

export function litellmModelList(bin: string, env: NodeJS.ProcessEnv = process.env): { file: string; data: Record<string, unknown> } | undefined {
  for (const dir of openhandsSitePackages(bin, env)) {
    const file = join(dir, 'litellm', LITELLM_LIST);
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (litellmCache?.file !== file || litellmCache.mtime !== mtime) {
      try {
        litellmCache = { file, mtime, data: JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> };
      } catch {
        continue;
      }
    }
    return litellmCache;
  }
  return undefined;
}

/** The catalog hook: LiteLLM's list from OpenHands' own install (nothing is run or fetched). */
export async function openhandsModels(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<OpenCatalog> {
  const list = litellmModelList(bin, env);
  if (list) return { models: parseOpenhandsCatalog(list.data), efforts: OPENHANDS_EFFORTS };
  return { models: [], efforts: OPENHANDS_EFFORTS, error: t().openhandsNoCatalog };
}

// --- What it loads by itself ---------------------------------------------------------------------------------

/** The instruction files it reads from the working directory and the repository root (any case). */
const INSTRUCTION_FILES = ['agents.md', 'agent.md', 'claude.md', 'gemini.md', '.cursorrules'];
const SKILL_DIRS = [join('.agents', 'skills'), join('.openhands', 'skills'), join('.openhands', 'microagents')];
const AGENT_DIRS = [join('.agents', 'agents'), join('.openhands', 'agents')];

/** The folders it reads a project from: the working directory, then its repository root (a `.git` above). */
export function openhandsProjectRoots(cwd: string): string[] {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir === cwd ? [cwd] : [cwd, dir];
    if (dirname(dir) === dir) return [cwd];
  }
}

/** A Markdown file's frontmatter fields (simple `key: value` lines). */
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** The skills in one of its skill folders: `<name>/SKILL.md` folders and other Markdown files (by path, as it names them). */
export function openhandsSkillsIn(dir: string, source: string): NativeSkill[] {
  const out: NativeSkill[] = [];
  const walk = (d: string, depth: number) => {
    for (const name of listDir(d)) {
      const path = join(d, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory() && depth < 4) {
        const skillMd = join(path, 'SKILL.md');
        if (isFile(skillMd)) {
          const fm = frontmatter(readText(skillMd));
          out.push({ name: fm.name || name, description: fm.description ?? '', source, path: skillMd });
        } else walk(path, depth + 1);
      } else if (/\.md$/i.test(name) && name.toLowerCase() !== 'readme.md' && isFile(path)) {
        const fm = frontmatter(readText(path));
        const rel = relative(dir, path).replace(/\.md$/i, '').split(/[\\/]/).join('/');
        out.push({ name: fm.name || rel, description: fm.description ?? (fm.triggers ? `triggers: ${fm.triggers}` : ''), source, path });
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** The events of a `hooks.json` (`{ "hooks": { … } }` or the events at its top, either case). */
export function parseOpenhandsHooks(text: string, file: string, source: string): NativeHook[] {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const events = data && typeof data === 'object' && data.hooks && typeof data.hooks === 'object' ? data.hooks : data;
  if (!events || typeof events !== 'object' || Array.isArray(events)) return [];
  const out: NativeHook[] = [];
  for (const [event, list] of Object.entries(events as Record<string, unknown>)) {
    const entries = Array.isArray(list) ? list : [];
    for (const e of entries.length ? entries : [{}]) {
      const matcher = typeof (e as any)?.matcher === 'string' ? (e as any).matcher : undefined;
      out.push({ event, ...(matcher ? { matcher } : {}), source, file });
    }
  }
  return out;
}

/** Its subagents in one folder: Markdown files, named by their frontmatter or file. */
function agentsIn(dir: string, source: string): NativeAgent[] {
  return listDir(dir)
    .filter((n) => /\.md$/i.test(n) && n.toLowerCase() !== 'readme.md' && isFile(join(dir, n)))
    .map((n) => {
      const fm = frontmatter(readText(join(dir, n)));
      return { name: fm.name || n.replace(/\.md$/i, ''), description: fm.description ?? '', source };
    });
}

/**
 * What OpenHands loads by itself for a folder, found by reading the files it reads (it has no command
 * that lists them): instruction files and skills of the working directory and its repository root,
 * subagents, and the project's hooks. Its home is Harness Relay's own, so nothing comes from there,
 * and its public skills are turned off. None of these can be left out of a run.
 */
export async function openhandsNative(_bin: string, _env: NodeJS.ProcessEnv, cwd: string): Promise<NativeProbe> {
  const roots = openhandsProjectRoots(cwd);
  const memory: NativeMemoryFile[] = [];
  const skills: NativeSkill[] = [];
  const agents: NativeAgent[] = [];
  const seenSkills = new Set<string>();
  const seenAgents = new Set<string>();
  for (const root of roots) {
    const source = root === cwd ? 'project' : 'repository root';
    for (const name of listDir(root)) if (INSTRUCTION_FILES.includes(name.toLowerCase()) && isFile(join(root, name))) memory.push({ path: join(root, name), kind: 'instructions' });
    for (const d of SKILL_DIRS) for (const s of openhandsSkillsIn(join(root, d), source)) if (!seenSkills.has(s.name) && seenSkills.add(s.name)) skills.push(s);
    for (const d of AGENT_DIRS) for (const a of agentsIn(join(root, d), source)) if (!seenAgents.has(a.name) && seenAgents.add(a.name)) agents.push(a);
  }
  const hooksFile = join(cwd, '.openhands', 'hooks.json');
  const hooks = isFile(hooksFile) ? parseOpenhandsHooks(readText(hooksFile), hooksFile, 'project') : [];
  return {
    provider: 'openhands',
    cwd,
    skills,
    mcpServers: [],
    memory,
    hooks,
    agents,
    memoryFromFiles: true,
    nativeOff: [],
    nativeItems: {},
    asRun: false,
    problems: [],
    checkedAt: Date.now(),
  };
}

// --- The adapter ----------------------------------------------------------------------------------------------

export const openhandsAcp: AcpAgentSpec = {
  provider: 'openhands',
  implemented: true,
  args: () => ['acp'],
  home: openhandsHome,
  // It loads `.env` from the folder it starts in into its environment, which its terminal's `bash -i`
  // gets as it is (a `PROMPT_COMMAND` there would run at every turn's start, before any approval):
  // started in the run's temp folder, it finds none. The session's folder is still the project
  // (`session/new`'s `cwd`, `OPENHANDS_WORK_DIR`), where its tools and terminal work.
  processCwd: (ctx) => ctx.tmpDir,
  // Python's httpx (under LiteLLM) and git read srt's HTTP(S)_PROXY as they are.
  proxyEnv: {},
  emptyEnv: OPENHANDS_EMPTY_ENV,
  prepare: (ctx) => prepareOpenhands(ctx),
  cleanup: (ctx) => cleanupOpenhands(ctx),
  sandbox: openhandsSandbox,
  model: { via: 'config' },
  effort: { via: 'config' },
  briefing: 'custom',
  // It asks about everything unless told to approve all; its "always" option would stop it asking.
  mode: (permission) => (permission === 'full' ? 'always-approve' : 'always-ask'),
  chooseOption: (allow, options) => options.find((o) => o.optionId === (allow ? 'accept' : 'reject'))?.optionId,
  describeCall: openhandsDescribeCall,
  decide: openhandsDecide,
  // Its to-do list comes as `plan` updates too.
  hideTool: (u) => u.rawInput?.kind === 'TaskTrackerAction',
  toolName: openhandsToolName,
  mcpServers: () => [],
  filterUpdate: openhandsFilterUpdate,
  heldUpdates: openhandsHeldUpdates,
  promptText: openhandsPromptText,
  endTurn: (_result, ctx, sessionId) => openhandsEndTurn(ctx, sessionId),
  usage: (_result, _last, ctx) => openhandsUsage(ctx.state.metrics as OpenhandsMetrics | undefined, ctx.state.before as OpenhandsMetrics | undefined, ctx.run),
  // It never exits when its stdin closes.
  exitGraceMs: 0,
};

/** Its runner: the generic ACP turn, with OpenHands' failures turned into what the user can act on. */
export function openhandsRunnerFor(deps: Partial<AcpTurnDeps> = {}): AgentRunner {
  const acp = acpRunner(openhandsAcp, deps);
  return {
    provider: 'openhands',
    async run(o) {
      try {
        return await acp.run(o);
      } catch (err) {
        throw openhandsError(err, o);
      }
    },
  };
}

export const openhandsRunner = openhandsRunnerFor();

export const openhandsAgent: OpenAgentDefinition = {
  provider: 'openhands',
  process: openhandsAcp,
  runner: openhandsRunner,
  efforts: OPENHANDS_EFFORTS,
  models: (bin, env) => openhandsModels(bin, env),
  native: (bin, env, cwd) => openhandsNative(bin, env, cwd),
};

/** For tests: the files a run's home holds, by name. */
export function openhandsRunFiles(tmpDir: string): Record<string, string> {
  const home = join(tmpDir, 'home');
  const own = join(home, '.openhands');
  return {
    home,
    settings: join(own, 'agent_settings.json'),
    mcp: join(own, 'mcp.json'),
    briefing: join(own, 'skills', OPENHANDS_BRIEFING_SKILL),
    publicSkills: join(own, 'cache', 'skills', 'public-skills'),
    bashrc: join(home, '.bashrc'),
  };
}
