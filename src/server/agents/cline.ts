import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_BACKENDS, backendModelId, type ApiBackend, type ModelOption, type NativeItemsOff, type NativePart, type NativeHook, type NativeMemoryFile, type NativePlugin, type NativeSkill, type NativeTool, type NativeAgent } from '../../shared/types';
import type { BackendRun } from '../backends';
import { API_BACKEND_ENV } from '../backends';
import { commandLine } from '../commands';
import { t } from '../i18n';
import type { NativeProbe } from '../native';
import { converse, runProcess, runShellScript } from '../process';
import { RpcError, type JsonRpcConnection } from './acp';
import { acpBriefing, acpRunner, type AcpAgentSpec, type AcpCallInfo, type AcpToolCall } from './acpTurn';
import { openAgentHome, type OpenAgentDefinition, type OpenCatalog, type OpenRunContext, type OpenSandboxNeeds } from './open';
import { AgentRunError, webSearchDetail, type McpServerSpec, type RunOptions, type RunResult } from './types';

/*
 * Cline: `cline` (npm `cline`) over ACP, `cline --acp`, checked with 3.0.74 (its source at the tag
 * `cli-v3.0.74`, and the real CLI with isolated homes). The `cline` on PATH is a small Node launcher
 * that starts the Bun-compiled CLI next to it. See docs/open-agents.md, "Cline".
 *
 * What it does with ACP, and what this adapter does about it:
 * - It asks about every tool call (`toolPolicies: {"*": {autoApprove: false}}` in every ACP session),
 *   reads included; full access is `--auto-approve true`. Its rejection reaches the model as a fixed
 *   text (`_meta` in the answer is ignored), so the briefing says what a refused call means.
 * - The model is taken from `CLINE_MODEL` only when it is in Cline's own catalog, else it silently
 *   uses the provider's default: the run's model is always set with `session/set_config_option`.
 * - `mcpServers` of `session/new` / `session/load` are ignored: the tool library goes into its MCP
 *   settings file. `_meta`, `-s`, `-P`, `-m` and images are ignored too (images still reach it as
 *   the paths listed in the prompt, which its file reader opens).
 * - The role briefing is a rules file in `CLINE_DIR/rules`, read again at every start (resumed
 *   sessions too). Each run gets a `CLINE_DIR` of its own in its temp folder, and its own settings
 *   files, so parallel runs never share them; sessions stay in `CLINE_DATA_DIR`, in the conversation
 *   member's own state folder (no other member's or conversation's run reads or writes it).
 * - By default its runtime joins a "hub" daemon (the user's own Cline, on port 25463) or starts a
 *   detached one: `CLINE_SESSION_BACKEND_MODE=local` keeps each run in its own process.
 * - Telemetry is on in the published build and connects directly, past any proxy:
 *   `telemetryOptOut` in its global settings turns it off. Its feature flags are fetched from
 *   data.cline.bot even then: `E2E_TEST=true` makes them a no-op.
 * - Its tool updates come as `tool_call_update` before the `tool_call` (when it asks), with the
 *   output in `rawOutput` (never `content`) and a failed command or edit often `completed` with
 *   `success: false`; OpenAI models edit with `apply_patch` (kind `other`). `filterUpdate` fixes these.
 * - A stop while a permission request is pending does not end its turn until that request is
 *   answered: the answer is then `cancelled` at once.
 * - Usage is not in ACP: it is read from its session file (`<data>/sessions/<id>/<id>.json`).
 * - `session/set_mode` does not reach a loaded session (its runtime is built during `session/load`),
 *   so plan mode would hold for new sessions only: every run stays in `act`, and read-only is
 *   approvals plus the relay sandbox, as for the other agents.
 */

/** Cline's provider id for each kind of backend. */
export const CLINE_PROVIDER: Record<ApiBackend | 'endpoint', string> = {
  openai: 'openai-native',
  anthropic: 'anthropic',
  xai: 'xai',
  endpoint: 'openai-compatible',
};

/** `--thinking` levels (`none|low|medium|high|xhigh`); without the flag an ACP turn runs with thinking off. */
export const CLINE_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];

/** What CLINE_API_KEY holds for an endpoint without a key: Cline's ACP refuses to start a session with none. */
export const CLINE_NO_KEY = 'none';

/*
 * ===== What Cline needs from the relay sandbox (one place) =====
 * - Writable (`statePaths`): its data folder `<state>/data` (`CLINE_DATA_DIR`, the member's own: sessions, SQLite
 *   `db/sessions.db`, `logs/hooks.jsonl`, `teams`, `workspaces`), and the run's temp folder, where
 *   jiti (plugins) and Bun's transpiler cache (`BUN_RUNTIME_TRANSPILER_CACHE_PATH`) write.
 * - Read-only (`configPaths`): `<home>/config` (the `CLINE_DIR` and settings files the status check,
 *   the catalog and the native probe use), `<data>/cache/feature-flags.json` (written before each
 *   run, read by its runtime), and the run's own `CLINE_DIR` in its temp folder (rules with the
 *   briefing, global settings, MCP settings, provider settings), added by `prepare`.
 * - Hosts: only the run's backend (`run.hosts`). Cline's own services stay off in every run
 *   (telemetry, feature flags, its account), so their hosts are refused quietly if it still tries,
 *   never asked about (`quietlyDeniedHosts`, the one opt-in it takes: `clineSandbox`).
 * - Proxy: Cline runs on Bun, which reads the sandbox's HTTPS_PROXY / HTTP_PROXY (seen under srt
 *   0.0.82); the sandbox's own `NODE_USE_ENV_PROXY=1` covers the Node MCP servers and hooks it starts.
 * - No loopback port of its own (with `CLINE_SESSION_BACKEND_MODE=local` there is no hub to listen
 *   or connect to), no PTY (its commands run without one), no Unix sockets. macOS trustd: not
 *   needed (Bun's TLS goes through the proxy with its own CA list; the Node launcher's look at the OS
 *   trust store fails in the sandbox and prints "failed to copy trust settings" on stderr, harmlessly).
 */
export const CLINE_QUIET_HOSTS = ['otel.cline.bot', 'data.cline.bot', 'api.cline.bot'];

/** The relay sandbox's opt-ins Cline takes (`sandbox`): only the quietly refused hosts of Cline's own services. */
export function clineSandbox(): OpenSandboxNeeds {
  return { quietlyDeniedHosts: [...CLINE_QUIET_HOSTS] };
}

/**
 * Variables of Cline's set empty for every run, so the server's environment (or a project's `.env`)
 * cannot move its data, swap its program, replay or record its requests, or point it elsewhere.
 * The ones Harness Relay sets for the run are set after these (`prepare`).
 */
export const CLINE_EMPTY_ENV = [
  'CLINE_API_KEY',
  'CLINE_PROVIDER',
  'CLINE_MODEL',
  'CLINE_BIN_PATH',
  'CLINE_HOOKS_DIR',
  'CLINE_SANDBOX',
  'CLINE_SANDBOX_DATA_DIR',
  'CLINE_SESSION_DATA_DIR',
  'CLINE_DB_DATA_DIR',
  'CLINE_TEAM_DATA_DIR',
  'CLINE_TASKS_DB_PATH',
  'CLINE_CRON_DB_PATH',
  'CLINE_CONNECTORS_DB_PATH',
  'CLINE_CONNECTOR_DATA_DIR',
  'CLINE_CONNECTOR_SETTINGS_PATH',
  'CLINE_HOOKS_LOG_PATH',
  'CLINE_HUB_PORT',
  'CLINE_HUB_ADDRESS',
  'CLINE_RPC_ADDRESS',
  'CLINE_VCR',
  'CLINE_VCR_CASSETTE',
  'CLINE_CAPTURE_PROVIDER_REQUEST',
  'CLINE_CAPTURE_WIRE',
  'CLINE_CAPTURE_DIR',
  'CLINE_TOOL_APPROVAL_DIR',
  'CLINE_MARKETPLACE_CATALOG_URL',
  'CLINE_USER_ID',
  'CLINE_LOG_PATH',
];

/**
 * Where Cline keeps its files: its config under its home `root` (shared, written by Harness Relay), its
 * data folder (sessions, its SQLite database, logs) under `state`, the run's state folder (the
 * conversation member's own; outside a run, Harness Relay's own).
 */
export function clineHome(root: string, state = root): { env: Record<string, string>; statePaths: string[]; configPaths: string[] } {
  const data = join(state, 'data');
  const config = join(root, 'config');
  return {
    env: {
      CLINE_DIR: config,
      CLINE_DATA_DIR: data,
      CLINE_GLOBAL_SETTINGS_PATH: join(config, 'global-settings.json'),
      CLINE_MCP_SETTINGS_PATH: join(config, 'mcp.json'),
      CLINE_PROVIDER_SETTINGS_PATH: join(config, 'providers.json'),
      CLINE_SESSION_BACKEND_MODE: 'local',
      CLINE_NO_AUTO_UPDATE: '1',
      E2E_TEST: 'true',
    },
    statePaths: [data],
    configPaths: [config, flagsFile(data)],
  };
}

const flagsFile = (data: string) => join(data, 'cache', 'feature-flags.json');

/** Its global settings: telemetry and updates off, and the tools and plugins left out of the run. */
export function clineGlobalSettings(o: Pick<RunOptions, 'nativeOff' | 'nativeItems'> = {}): Record<string, unknown> {
  const tools = [...(o.nativeOff?.includes('skills') ? ['skills'] : []), ...(o.nativeItems?.tools ?? [])];
  const plugins = o.nativeItems?.plugins ?? [];
  return {
    telemetryOptOut: true,
    autoUpdateEnabled: false,
    ...(tools.length ? { disabledTools: [...new Set(tools)] } : {}),
    ...(plugins.length ? { disabledPlugins: [...new Set(plugins)] } : {}),
  };
}

/** The tool library's MCP servers in Cline's MCP settings file (`mcpServers` over ACP are ignored). */
export function clineMcpSettings(servers: McpServerSpec[] = [], cwd?: string): { mcpServers: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    out[s.name] =
      s.transport === 'http'
        ? { type: 'streamableHttp', url: s.url, ...(Object.keys(s.headers).length ? { headers: s.headers } : {}) }
        : // Started in the working directory, as with the other CLIs (Cline itself starts in the run's temp folder).
          { command: s.command, args: s.args, ...(cwd ? { cwd } : {}), ...(Object.keys(s.env).length ? { env: s.env } : {}) };
  }
  return { mcpServers: out };
}

/** Its provider settings for the run: the provider, the model and, for an endpoint, its base URL (never a key). */
export function clineProviderSettings(run: BackendRun, now = new Date()): Record<string, unknown> {
  const provider = CLINE_PROVIDER[run.kind];
  return {
    version: 1,
    lastUsedProvider: provider,
    modes: {},
    providers: {
      [provider]: {
        settings: { provider, model: run.model, ...(run.endpoint ? { baseUrl: run.endpoint.baseUrl } : {}) },
        updatedAt: now.toISOString(),
        tokenSource: 'manual',
      },
    },
  };
}

/** The key Cline gets in CLINE_API_KEY, which it sends to the run's provider. */
export function clineApiKey(run: BackendRun): string {
  if (run.kind === 'endpoint') return run.endpoint?.apiKey?.trim() || CLINE_NO_KEY;
  return run.env[API_BACKEND_ENV[run.kind]] ?? '';
}

/** Its arguments: ACP, always-approve with full access, the reasoning effort as `--thinking`. */
export function clineArgs(o: Pick<RunOptions, 'permission' | 'effort'>): string[] {
  return [
    '--acp',
    ...(o.permission === 'full' ? ['--auto-approve', 'true'] : []),
    ...(o.effort && CLINE_EFFORTS.includes(o.effort) ? ['--thinking', o.effort] : []),
  ];
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The files every start of Cline outside a run reads (status check, catalog, native probe): its
 * home's `config` folder, with telemetry off and no MCP servers, and the feature-flag cache.
 */
export function writeClineHomeDefaults(root: string, data?: string): void {
  const home = clineHome(root);
  mkdirSync(home.env.CLINE_DIR, { recursive: true, mode: 0o700 });
  writeJson(home.env.CLINE_GLOBAL_SETTINGS_PATH, clineGlobalSettings());
  writeJson(home.env.CLINE_MCP_SETTINGS_PATH, clineMcpSettings());
  writeJson(home.env.CLINE_PROVIDER_SETTINGS_PATH, { version: 1, modes: {}, providers: {} });
  writeFlags(data || home.env.CLINE_DATA_DIR);
}

/** Its feature-flag cache, empty and fresh, so its runtime neither polls nor takes flags a run left behind. */
function writeFlags(data: string, now = Date.now()): void {
  mkdirSync(join(data, 'cache'), { recursive: true, mode: 0o700 });
  writeJson(flagsFile(data), { version: 2, updatedAt: now, userId: null, flagsPayload: { featureFlags: {}, featureFlagPayloads: {} } });
}

/** The rules file with the role briefing, in the run's own `CLINE_DIR`. */
export function clineBriefingFile(briefing: string): string | undefined {
  const text = briefing.trim();
  return text ? `# Harness Relay\n\n${text}\n` : undefined;
}

/**
 * Writes the run's own `CLINE_DIR` (rules with the briefing, global, MCP and provider settings) in its
 * temp folder, points Cline at it and at the run's backend, and keeps the other backends' keys out.
 */
export function prepareCline(ctx: OpenRunContext): void {
  const { o, run, env, home } = ctx;
  const dir = join(ctx.tmpDir, 'cline');
  mkdirSync(join(dir, 'rules'), { recursive: true, mode: 0o700 });
  const brief = clineBriefingFile(acpBriefing(o, clineAcp));
  if (brief) writeFileSync(join(dir, 'rules', 'harness-relay-briefing.md'), brief, { mode: 0o600 });
  writeJson(join(dir, 'global-settings.json'), clineGlobalSettings(o));
  writeJson(join(dir, 'mcp.json'), clineMcpSettings(o.mcpServers, o.cwd));
  writeJson(join(dir, 'providers.json'), clineProviderSettings(run));
  writeFlags(home.env.CLINE_DATA_DIR);
  // Read-only inside the relay sandbox, though in the run's (writable) temp folder.
  home.configPaths.push(dir);
  for (const id of API_BACKENDS) delete env[API_BACKEND_ENV[id]];
  dropClineVars(env);
  Object.assign(env, {
    CLINE_DIR: dir,
    CLINE_GLOBAL_SETTINGS_PATH: join(dir, 'global-settings.json'),
    CLINE_MCP_SETTINGS_PATH: join(dir, 'mcp.json'),
    CLINE_PROVIDER_SETTINGS_PATH: join(dir, 'providers.json'),
    CLINE_PROVIDER: CLINE_PROVIDER[run.kind],
    CLINE_MODEL: run.model,
    CLINE_API_KEY: clineApiKey(run),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(ctx.tmpDir, 'bun-cache'),
  });
  ctx.state.dataDir = env.CLINE_DATA_DIR;
}

/**
 * Takes out every other `CLINE_*` variable the server's environment holds (Cline reads about a
 * hundred: plugin bootstraps, its JavaScript runtime, npm, tracing, Langfuse…), besides those of its
 * home (`keep`) and those set empty (`CLINE_EMPTY_ENV`). Taken out, not set empty: some are read with
 * a default (`?? 'production'`) that an empty value would replace. A project's `.env` cannot set them
 * either: Cline starts in the run's temp folder (`processCwd`), not in the project.
 */
export function dropClineVars(env: NodeJS.ProcessEnv, keep: Iterable<string> = CLINE_HOME_VARS): void {
  const kept = new Set(keep);
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('CLINE_') && value !== '' && !kept.has(name)) delete env[name];
  }
}

/** The variables of Cline's home (`clineHome`), which Harness Relay sets for every start. */
export const CLINE_HOME_VARS = Object.keys(clineHome('/').env);

// --- Tool calls -------------------------------------------------------------------------------

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/** The tool's own name: the start of Cline's title (`run_commands: echo hi`), else its kind. */
export function clineToolOf(call: { title?: unknown; kind?: unknown }): string {
  const title = text(call.title);
  if (title) {
    const at = title.indexOf(':');
    const name = (at > 0 ? title.slice(0, at) : title).trim();
    if (/^[\w.-]+$/.test(name)) return name;
  }
  return text(call.kind) ?? 'tool';
}

/** The files an `apply_patch` patch adds, changes, deletes or moves to. */
export function clinePatchFiles(patch: unknown): string[] {
  if (typeof patch !== 'string') return [];
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] ?? m[2]).trim());
  return [...new Set(files.filter(Boolean))];
}

/** The paths of `read_files`' `files` (`[{path}]`, or plain strings). */
function readPaths(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files.map((f) => (typeof f === 'string' ? f : text(f?.path))).filter((p): p is string => Boolean(p));
}

/** The commands of `run_commands` (`commands: string[]`, or a single `command`), one per line. */
function commandsOf(input: Record<string, any>): string | undefined {
  const list = strings(input.commands);
  if (list.length) return list.join('\n');
  return commandLine(input.command);
}

/** The fields of a call's input that tell what it does, by Cline's tool (for the row and the decision). */
function inputFacts(tool: string, input: Record<string, any>): { command?: string; path?: string; paths?: string[]; url?: string; query?: string } {
  switch (tool) {
    case 'run_commands':
      return { command: commandsOf(input) };
    case 'read_files': {
      const paths = readPaths(input.files);
      return { path: paths[0], paths };
    }
    case 'apply_patch': {
      const paths = clinePatchFiles(input.input);
      return { path: paths[0], paths };
    }
    case 'editor':
      return { path: text(input.path) };
    case 'search_codebase':
      return { query: strings(input.queries).join(' | ') || text(input.query) };
    case 'fetch_web_content': {
      const urls = Array.isArray(input.requests) ? input.requests.map((r: any) => text(r?.url)).filter(Boolean) : [];
      return { url: urls[0] ?? text(input.url) };
    }
    case 'skills':
      return { query: text(input.skill) };
    default:
      return {};
  }
}

/** Cline's tools whose ACP kind is wrong or missing for the permission: `apply_patch` edits, `skills` only reads its instructions. */
const KIND: Record<string, string> = {
  run_commands: 'execute',
  read_files: 'read',
  search_codebase: 'search',
  fetch_web_content: 'fetch',
  editor: 'edit',
  apply_patch: 'edit',
  skills: 'read',
  spawn_agent: 'think',
};

/**
 * What a call Cline asks about is (`describeCall`): its tool, the command it runs, the file it reads
 * or changes, the URL it fetches. Cline's titles hold its input as JSON, cut short; the card shows
 * the tool and what it is about instead.
 */
export function clineCallInfo(call: AcpToolCall, earlier?: AcpToolCall): Partial<AcpCallInfo> {
  const tool = clineToolOf(call.title ? call : (earlier ?? call));
  const input = { ...earlier?.rawInput, ...call.rawInput };
  const facts = inputFacts(tool, input);
  const about = facts.command ?? (facts.paths && facts.paths.length > 1 ? facts.paths.join(', ') : facts.path) ?? facts.url ?? facts.query;
  return {
    tool,
    title: about ? `${tool}: ${about.split('\n')[0]}${facts.command?.includes('\n') ? ' …' : ''}` : tool,
    ...(KIND[tool] ? { kind: KIND[tool] } : {}),
    ...(facts.command ? { command: facts.command } : {}),
    ...(facts.path ? { path: facts.path } : {}),
    ...(facts.url ? { url: facts.url } : {}),
  };
}

/** One result of Cline's tools: `{query, result, success, error}`. */
interface ClineResult {
  query?: string;
  result?: unknown;
  success?: boolean;
  error?: unknown;
}

/**
 * A tool's output as text, and whether it failed, from Cline's `rawOutput`: a list of
 * `{query, result, success, error}` (reads, searches, commands, fetches), one of them (editor,
 * apply_patch), an MCP result (`{content, isError}`), a provider's web search (`{action, sources}`),
 * or a string (a rejection: `{"error": …}` as JSON).
 */
export function clineOutput(raw: unknown): { text?: string; failed: boolean; detail?: string } {
  if (raw === undefined || raw === null) return { failed: false };
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && 'error' in parsed) return { text: String((parsed as { error: unknown }).error), failed: true };
    } catch {
      // plain text
    }
    return { text: raw, failed: false };
  }
  if (Array.isArray(raw)) {
    const items = raw.filter((x): x is ClineResult => Boolean(x) && typeof x === 'object');
    const one = (r: ClineResult) => [text(r.result), text(r.error)].filter(Boolean).join('\n');
    const body = items.length === 1 ? one(items[0]) : items.map((r) => [text(r.query), one(r)].filter(Boolean).join('\n')).join('\n\n');
    return { ...(body.trim() ? { text: body } : {}), failed: items.some((r) => r.success === false || Boolean(text(r.error))) };
  }
  if (typeof raw === 'object') {
    const r = raw as Record<string, any>;
    if (Array.isArray(r.content)) {
      const body = r.content
        .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n');
      return { ...(body ? { text: body } : {}), failed: r.isError === true };
    }
    if (r.action !== undefined || Array.isArray(r.sources)) {
      const urls = Array.isArray(r.sources) ? r.sources.map((s: any) => text(s?.url)).filter(Boolean) : [];
      const detail = webSearchDetail(r.action);
      return { ...(urls.length ? { text: urls.join('\n') } : {}), failed: false, ...(detail ? { detail } : {}) };
    }
    if ('result' in r || 'success' in r || 'error' in r) return clineOutput([r]);
    return { text: JSON.stringify(r), failed: false };
  }
  return { text: String(raw), failed: false };
}

/**
 * Cline's tool updates as the generic turn reads them (`filterUpdate`): the output from `rawOutput`
 * as `content`, a call that failed (`success: false`) as `failed`, and its input with the fields that
 * name what it does (`command`, `path`, `url`, `query`) for its row.
 */
export function clineUpdate(update: Record<string, any>): Record<string, any> {
  const kind = update.sessionUpdate;
  if (kind !== 'tool_call' && kind !== 'tool_call_update') return update;
  const out: Record<string, any> = { ...update };
  if (update.rawInput && typeof update.rawInput === 'object') {
    const facts = inputFacts(clineToolOf(update), update.rawInput);
    const extra = Object.fromEntries(
      Object.entries({ command: facts.command, path: facts.paths && facts.paths.length > 1 ? facts.paths.join(', ') : facts.path, url: facts.url, query: facts.query }).filter(
        ([k, v]) => v !== undefined && update.rawInput[k] === undefined,
      ),
    );
    if (Object.keys(extra).length) out.rawInput = { ...update.rawInput, ...extra };
  }
  if ('rawOutput' in update && (update.status === 'completed' || update.status === 'failed')) {
    const res = clineOutput(update.rawOutput);
    if (res.text) out.content = [{ type: 'content', content: { type: 'text', text: res.text } }];
    if (res.failed) out.status = 'failed';
    // A provider's web search says what it looked for only with its result.
    if (res.detail) out.rawInput = { ...out.rawInput, query: res.detail };
  }
  return out;
}

// --- Errors and usage -------------------------------------------------------------------------

/** The text of a JSON-RPC error from Cline: its `data.message` (the provider's own words), without "Internal error: ". */
function rpcText(err: unknown): string {
  const data = err instanceof RpcError ? (err.data as { message?: unknown } | undefined) : undefined;
  const raw = typeof data?.message === 'string' ? data.message : err instanceof Error ? err.message : String(err);
  return raw.replace(/^Internal error:\s*/i, '').trim();
}

/** A prompt Cline failed, in words the user can act on: the key, the model, the endpoint, or Cline's own reason. */
export function clineError(err: unknown, run: Pick<BackendRun, 'kind' | 'backend' | 'model' | 'endpoint'>): AgentRunError {
  const detail = rpcText(err);
  const where = run.endpoint?.name || run.backend;
  const code = err instanceof RpcError ? err.code : undefined;
  if (code === -32000 || /api[ _-]?key|unauthori[sz]ed|authenticat|\b401\b|\b403\b|forbidden|permission denied|invalid.*token/i.test(detail)) {
    return new AgentRunError(t().clineBadKey(where, detail));
  }
  if (/model\b.*(does not exist|not found|not_found|unknown|invalid|not supported|no access)|no such model|unknown model|\b404\b/i.test(detail)) {
    return new AgentRunError(t().clineBadModel(run.model, where, detail));
  }
  if (/cannot connect|unable to connect|econnrefused|enotfound|fetch failed|getaddrinfo|connection refused|timed? ?out/i.test(detail)) {
    return new AgentRunError(t().clineUnreachable(run.endpoint ? run.endpoint.baseUrl : where, detail));
  }
  return new AgentRunError(t().clineFailed(detail));
}

/** A session's tokens and cost so far, from Cline's session file (its `aggregateUsage`, subagents included). */
export interface ClineUsage {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

/** Where Cline keeps a session's record. */
export const clineSessionFile = (dataDir: string, sessionId: string): string => join(dataDir, 'sessions', sessionId, `${sessionId}.json`);

/** The usage in a session's record, undefined when there is none (yet). */
export function readClineUsage(file: string): ClineUsage | undefined {
  try {
    const meta = (JSON.parse(readFileSync(file, 'utf8')) as { metadata?: Record<string, any> }).metadata;
    const u = meta?.aggregateUsage ?? meta?.usage;
    if (!u || typeof u !== 'object') return undefined;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), totalCost: num(u.totalCost ?? meta?.totalCost) };
  } catch {
    return undefined;
  }
}

/** This turn's part of a session's usage (`before`: what it was when the turn started). */
export function usageDelta(after: ClineUsage | undefined, before: ClineUsage | undefined): Pick<RunResult, 'costUsd' | 'inputTokens' | 'outputTokens'> {
  if (!after) return {};
  const b = before ?? { inputTokens: 0, outputTokens: 0, totalCost: 0 };
  const d = (x: number, y: number) => (x >= y ? x - y : undefined);
  const input = d(after.inputTokens, b.inputTokens);
  const output = d(after.outputTokens, b.outputTokens);
  const cost = d(after.totalCost, b.totalCost);
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    // No cost for a model without a price (an endpoint): Cline counts it as 0.
    ...(cost !== undefined && cost > 0 ? { costUsd: Math.round(cost * 1e9) / 1e9 } : {}),
  };
}

const sameUsage = (a: ClineUsage | undefined, b: ClineUsage | undefined) =>
  a?.inputTokens === b?.inputTokens && a?.outputTokens === b?.outputTokens && a?.totalCost === b?.totalCost;

/** How long to wait for Cline to write the turn's usage to its session file, once the prompt answered. */
export const USAGE_WAIT_MS = 1500;

/**
 * Wraps the run's connection, once the session is there (`afterSession`):
 * - a permission request still waiting when the run is stopped gets `cancelled` at once (Cline does
 *   not end a cancelled turn until it is answered);
 * - the prompt's error becomes one the user can act on (`clineError`), and its result waits for the
 *   turn's usage in Cline's session file (`ctx.state.usage`, read by `usage`).
 */
export function wrapClineConnection(conn: JsonRpcConnection, sessionId: string, ctx: OpenRunContext, waitMs = USAGE_WAIT_MS): void {
  const { signal } = ctx.o;
  const dataDir = typeof ctx.state.dataDir === 'string' ? ctx.state.dataDir : join(ctx.home.state, 'data');
  const file = clineSessionFile(dataDir, sessionId);
  const before = readClineUsage(file);
  const answer = conn.onRequest;
  conn.onRequest = (method, params) => {
    const inner = Promise.resolve().then(() => answer?.(method, params));
    if (method !== 'session/request_permission') return inner;
    const cancelled = { outcome: { outcome: 'cancelled' } };
    if (signal.aborted) return cancelled;
    return new Promise((resolve, reject) => {
      const onAbort = () => resolve(cancelled);
      signal.addEventListener('abort', onAbort, { once: true });
      inner.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(signal.aborted ? cancelled : v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  };
  const request = conn.request.bind(conn);
  conn.request = (async (method: string, params?: unknown) => {
    if (method !== 'session/prompt') return request(method, params);
    let result: unknown;
    try {
      result = await request(method, params);
    } catch (err) {
      if (signal.aborted || err instanceof AgentRunError) throw err;
      throw clineError(err, ctx.run);
    }
    let after = readClineUsage(file);
    for (let waited = 0; sameUsage(after, before) && waited < waitMs && !signal.aborted; waited += 100) {
      await new Promise((r) => setTimeout(r, 100));
      after = readClineUsage(file);
    }
    ctx.state.usage = sameUsage(after, before) ? {} : usageDelta(after, before);
    return result;
  }) as JsonRpcConnection['request'];
}

// --- The spec ---------------------------------------------------------------------------------

export const clineAcp: AcpAgentSpec = {
  provider: 'cline',
  implemented: true,
  args: (ctx) => clineArgs(ctx.o),
  // Bun reads the `.env`, `.env.local`, `.env.<NODE_ENV>…` and `bunfig.toml` (its `preload` runs code)
  // of the folder it starts in: Cline starts in the run's own temp folder; the session is the project.
  processCwd: (ctx) => ctx.tmpDir,
  home: clineHome,
  emptyEnv: CLINE_EMPTY_ENV,
  prepare: prepareCline,
  sandbox: clineSandbox,
  // CLINE_MODEL counts only when the model is in its catalog: the run's model is always set.
  model: { via: 'config_option', configId: 'model', id: (run) => run.model },
  effort: { via: 'config' }, // `--thinking`, in `args`
  briefing: 'custom', // the rules file `prepare` writes
  // Always `act`: `session/set_mode` does not reach a loaded session (see above).
  mode: (_permission, modes) => (modes?.some((m) => m.id === 'act') ? 'act' : undefined),
  describeCall: (call, earlier) => clineCallInfo(call, earlier),
  toolName: (u) => clineToolOf(u),
  mcpServers: () => [], // in its MCP settings file instead
  filterUpdate: ({ update }) => clineUpdate(update),
  afterSession: async (conn, session, ctx) => wrapClineConnection(conn, session.sessionId, ctx),
  usage: (_result, _last, ctx) => (ctx.state.usage as Pick<RunResult, 'costUsd' | 'inputTokens' | 'outputTokens'> | undefined) ?? {},
};

// --- Its catalog and what it loads by itself -------------------------------------------------

/** The models of one provider in Cline's catalog, from `session/new` (offline: no model API is asked). */
export function parseClineCatalog(backend: ApiBackend, state: { models?: { currentModelId?: string; availableModels?: { modelId: string; name?: string }[] } }): { models: ModelOption[]; defaultModel?: string } {
  const list = state.models?.availableModels ?? [];
  const models = list
    .filter((m) => typeof m?.modelId === 'string' && m.modelId)
    .map((m) => ({ id: backendModelId(backend, m.modelId), ...(m.name && m.name !== m.modelId ? { label: `${m.name} · ${m.modelId}` } : {}) }));
  const current = state.models?.currentModelId;
  return { models, ...(current && list.some((m) => m.modelId === current) ? { defaultModel: backendModelId(backend, current) } : {}) };
}

/**
 * The environment Cline is asked with outside a run (catalog, native probe): its home's, without the
 * model backends' keys (nothing it is asked then needs one, and a project's plugin runs in it) and
 * with its own variables that would move it or point it elsewhere set empty.
 */
export function clineProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  dropClineVars(out);
  Object.assign(out, Object.fromEntries(CLINE_EMPTY_ENV.map((name) => [name, ''])));
  for (const id of API_BACKENDS) delete out[API_BACKEND_ENV[id]];
  return out;
}

/** Asks Cline for one provider's catalog: `initialize` and `session/new`, with a placeholder key (nothing is sent anywhere). */
async function catalogOf(bin: string, env: NodeJS.ProcessEnv, root: string, backend: ApiBackend, timeoutMs: number) {
  let state: Record<string, any> | undefined;
  let error: string | undefined;
  const run: NodeJS.ProcessEnv = { ...clineProbeEnv(env), CLINE_PROVIDER: CLINE_PROVIDER[backend], CLINE_API_KEY: 'catalog' };
  const res = await converse({
    bin,
    args: ['--acp'],
    cwd: root,
    env: run,
    timeoutMs,
    open: (write) => write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } }),
    onMessage: (msg, write, finish) => {
      if (msg.id === 1) write({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: root, mcpServers: [] } });
      if (msg.id === 2) {
        if (msg.error) error = String(msg.error.message ?? 'session/new failed');
        else state = msg.result as Record<string, any>;
        finish();
      }
    },
  });
  if (!state) throw new Error(error ?? (res.timedOut ? t().timedOut : res.stderr.trim().split('\n').slice(-2).join(' ') || 'no answer'));
  return parseClineCatalog(backend, state);
}

/** Its catalog of the API backends' models (endpoints add their own typed models). */
export async function clineModels(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<OpenCatalog> {
  const root = openAgentHome(env);
  writeClineHomeDefaults(root, env.CLINE_DATA_DIR);
  const results = await Promise.allSettled(API_BACKENDS.map((b) => catalogOf(bin, env, root, b, timeoutMs)));
  const models: ModelOption[] = [];
  const errors: string[] = [];
  let defaultModel: string | undefined;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      errors.push(`${API_BACKENDS[i]}: ${(r.reason as Error).message}`);
      return;
    }
    models.push(...r.value.models);
    // The default of the first API backend that has a key.
    if (!defaultModel && r.value.defaultModel && env[API_BACKEND_ENV[API_BACKENDS[i]]]) defaultModel = r.value.defaultModel;
  });
  return { models, ...(defaultModel ? { defaultModel } : {}), ...(errors.length ? { error: errors.join('; ') } : {}) };
}

type ClineItem = { id?: string; name?: string; fileName?: string; hookEventName?: string; path?: string; description?: string; frontmatter?: Record<string, unknown> };

/**
 * The built-in tools of Cline's ACP sessions, by the name `disabledTools` takes. OpenAI models get
 * `apply_patch` where the others get `editor`; `skills` only when there are skills. (`cline config`
 * lists `ask_question` and the agent-team tools too, which ACP sessions never offer.)
 */
export const CLINE_BUILTIN_TOOLS = ['read_files', 'search_codebase', 'run_commands', 'fetch_web_content', 'editor', 'apply_patch', 'skills', 'spawn_agent'];

/** The kinds `cline config <kind> --json` lists, as the native probe asks them. */
export const CLINE_CONFIG_KINDS = ['rules', 'skills', 'hooks', 'agents', 'plugins'] as const;
export type ClineConfigKind = (typeof CLINE_CONFIG_KINDS)[number];

/** Where an item comes from: the project (under `cwd`), else the user's own folders. */
function sourceOf(path: string | undefined, cwd: string): { source?: string } {
  if (!path) return {};
  return { source: path === cwd || path.startsWith(`${cwd}/`) ? 'project' : 'user' };
}

/**
 * What `cline config <kind> --json` reports for a folder, as native.ts lists it: rules (instruction
 * files), skills, hooks (event and file; never their commands), agents, plugins (by path, the id
 * `disabledPlugins` takes), and its built-in tools. Workflows are left out (slash commands, and
 * Harness Relay's prompts never start with one), and so are MCP servers: only the tool library's
 * reach a run (its MCP settings file).
 */
export function parseClineConfig(lists: Partial<Record<ClineConfigKind, unknown>>, cwd: string): Pick<NativeProbe, 'skills' | 'mcpServers' | 'memory' | 'hooks' | 'agents' | 'plugins' | 'builtinTools'> {
  const list = (k: ClineConfigKind): ClineItem[] => (Array.isArray(lists[k]) ? (lists[k] as ClineItem[]).filter((x) => x && typeof x === 'object') : []);
  const off = (x: ClineItem) => (x.frontmatter?.disabled === true || x.frontmatter?.enabled === false ? { enabled: false } : {});
  const skills: NativeSkill[] = list('skills').map((x) => ({
    name: String(x.name ?? x.id ?? ''),
    description: String(x.description ?? ''),
    ...sourceOf(x.path, cwd),
    ...(x.path ? { path: x.path } : {}),
    ...off(x),
  }));
  const memory: NativeMemoryFile[] = list('rules')
    .filter((x) => x.path)
    .map((x) => ({ path: String(x.path), kind: 'instructions' as const, ...off(x) }));
  const hooks: NativeHook[] = list('hooks').map((x) => ({ event: String(x.fileName ?? x.name ?? x.hookEventName ?? ''), ...sourceOf(x.path, cwd), ...(x.path ? { file: x.path } : {}) }));
  const agents: NativeAgent[] = list('agents').map((x) => ({ name: String(x.name ?? x.id ?? ''), description: String(x.description ?? ''), ...sourceOf(x.path, cwd), ...off(x) }));
  const plugins: NativePlugin[] = list('plugins').map((x) => ({ name: String(x.name ?? x.path ?? ''), ...sourceOf(x.path, cwd), ...(x.path ? { id: x.path } : {}) }));
  const builtinTools: NativeTool[] = CLINE_BUILTIN_TOOLS.map((name) => ({ name, id: name }));
  return { skills, mcpServers: [], memory, hooks, agents, plugins, builtinTools };
}

/**
 * Marks what Harness Relay's runs leave out of what Cline reports, with the switches the run writes
 * into its global settings (`clineGlobalSettings`): every skill and the `skills` tool when skills are
 * off (`disabledTools: ["skills"]`; `cline config skills` lists them whatever that says), each
 * built-in tool (`disabledTools`) and plugin (`disabledPlugins`) picked alone. `asRun`: something is
 * left out, and these are exactly the run's switches.
 */
export function clineLeftOut(
  lists: Pick<NativeProbe, 'skills' | 'builtinTools' | 'plugins'>,
  off: readonly NativePart[] = [],
  items: NativeItemsOff = {},
): Pick<NativeProbe, 'skills' | 'builtinTools' | 'plugins' | 'asRun'> {
  const settings = clineGlobalSettings({ nativeOff: off, nativeItems: items });
  const tools = new Set((settings.disabledTools as string[] | undefined) ?? []);
  const plugins = new Set((settings.disabledPlugins as string[] | undefined) ?? []);
  const out = <T extends { id?: string }>(item: T, gone: boolean): T => (gone ? { ...item, leftOut: true } : item);
  return {
    skills: lists.skills.map((x) => out(x, tools.has('skills'))),
    builtinTools: lists.builtinTools?.map((x) => out(x, tools.has(x.id ?? x.name))),
    plugins: lists.plugins?.map((x) => out(x, Boolean(x.id) && plugins.has(x.id!))),
    asRun: tools.size + plugins.size > 0,
  };
}

/** How the config probe starts `cline config <kind> --json` with its output in a file (fixed text). */
export const CLINE_PROBE_SCRIPT = 'exec "$HARNESS_RELAY_CLINE" --cwd "$HARNESS_RELAY_CLINE_CWD" config "$HARNESS_RELAY_CLINE_KIND" --json > "$HARNESS_RELAY_CLINE_OUT"';

/**
 * What Cline loads by itself for `cwd`: `cline config <kind> --json` for each kind, in its home
 * (telemetry off, no MCP servers). These only read files: no plugin code runs, no hook, no network.
 * (`cline config --json` without a kind is not used: it builds Cline's runtime in "auto" mode, which
 * joins a running Cline hub, the user's own, or starts one in the background that keeps running.)
 */
export async function clineNative(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 30_000,
  off: readonly NativePart[] = [],
  items: NativeItemsOff = {},
): Promise<NativeProbe> {
  const root = openAgentHome(env);
  writeClineHomeDefaults(root, env.CLINE_DATA_DIR);
  const probeEnv = clineProbeEnv(env);
  // Cline exits before a pipe takes more than 128 KiB of what it printed (a few dozen skills with their
  // instructions), so each answer goes to a file: `sh` starts it with its output there.
  const dir = mkdtempSync(join(root, 'probe-'));
  let answers: { kind: ClineConfigKind; data: unknown; res: Awaited<ReturnType<typeof runProcess>> }[];
  try {
    answers = await Promise.all(
      CLINE_CONFIG_KINDS.map(async (kind) => {
        const out = join(dir, `${kind}.json`);
        // Started in the probe's own empty folder, about `cwd` (`--cwd`), so it reads no `.env` or `bunfig.toml` of the project.
        // A fixed script; what it needs comes in its environment (AGENTS.md: never in a shell's text or arguments).
        const res = await runShellScript('/bin/sh', [], CLINE_PROBE_SCRIPT, {
          cwd: dir,
          env: { ...probeEnv, HARNESS_RELAY_CLINE: bin, HARNESS_RELAY_CLINE_KIND: kind, HARNESS_RELAY_CLINE_OUT: out, HARNESS_RELAY_CLINE_CWD: cwd },
          timeoutMs,
        });
        try {
          return { kind, data: JSON.parse(readFileSync(out, 'utf8')) as unknown, res };
        } catch {
          return { kind, data: undefined, res };
        }
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const problems: NativeProbe['problems'] = [];
  const lists: Partial<Record<ClineConfigKind, unknown>> = {};
  for (const a of answers) {
    if (Array.isArray(a.data)) {
      lists[a.kind] = a.data;
      continue;
    }
    const detail = a.res.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
    if (a.res.timedOut) problems.push({ kind: 'timeout' });
    else if (a.kind === 'rules') problems.push(detail ? { kind: 'failed', detail } : { kind: 'no-answer', part: 'all' });
    else problems.push({ kind: 'no-answer', part: a.kind === 'agents' ? 'agents' : a.kind });
  }
  const found = parseClineConfig(lists, cwd);
  return {
    provider: 'cline',
    cwd,
    ...found,
    ...clineLeftOut(found, off, items),
    memoryFromFiles: false,
    nativeOff: [...off],
    nativeItems: items,
    problems: problems.some((p) => p.kind === 'timeout') ? [{ kind: 'timeout' }] : problems,
    checkedAt: Date.now(),
  };
}

export const clineAgent: OpenAgentDefinition = {
  provider: 'cline',
  process: clineAcp,
  runner: acpRunner(clineAcp),
  efforts: CLINE_EFFORTS,
  models: (bin, env) => clineModels(bin, env),
  native: (bin, env, cwd, timeoutMs, off, items) => clineNative(bin, env, cwd, timeoutMs, off, items),
};
