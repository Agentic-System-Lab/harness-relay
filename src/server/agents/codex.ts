import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { endpointEffort, ENDPOINT_CLI, PROVIDER_LABEL, type NativeItemsOff, type NativePart, type Permission, type PlanEntry } from '../../shared/types';
import { endpointKeyEnv, endpointRunModel, ENDPOINT_KEY_ENV, type EndpointModel } from '../backends';
import { unwrapShell } from '../commands';
import { t } from '../i18n';
import { runProcess, tail } from '../process';
import { patternPath, protectedReads } from '../protect';
import { JsonRpcConnection, RpcError } from './acp';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  clipPath,
  summarizeInput,
  tailText,
  webSearchDetail,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type McpServerSpec,
  type RunOptions,
  type RunResult,
} from './types';

/*
 * Codex runs as `codex app-server` (JSON-RPC over stdio, the protocol of Codex's IDE extensions)
 * rather than `codex exec`, so that it can ask the user for approvals and stream its reasoning,
 * plan and command output.
 *
 * Commands always run in Codex's OS sandbox for the permission (read-only / workspace-write).
 * When the conversation asks the user, the approval policy is "on-request": Codex asks before
 * anything the sandbox does not allow (writing outside the working directory, network…), and
 * the request goes to the user. Otherwise the policy is "never" and such actions just fail.
 */

const SANDBOX: Record<Permission, string> = {
  'read-only': 'read-only',
  edit: 'workspace-write',
  full: 'danger-full-access',
};

/** The start of the permission profile's name Harness Relay defines in a thread's config, below full access. */
export const CODEX_PROFILE = 'harness-relay';

/**
 * The profile's name for one run: `harness-relay-` and a random part. Codex merges a profile of the
 * same name from its other config layers (the user's config.toml, a trusted project's
 * .codex/config.toml) into this one, and a more specific `read` entry there would open a denied
 * path again (checked with Codex 0.167); a name nobody knows in advance cannot be added to.
 */
export function codexProfileId(): string {
  return `${CODEX_PROFILE}-${randomBytes(8).toString('hex')}`;
}

/**
 * The thread's permission profile below full access, which lets Codex's sandbox deny reading the
 * protected paths (`protectedReads()`: the browsers' folders, Harness Relay's database): the sandbox
 * of the permission (`:read-only` / `:workspace`, both without network) plus a `deny` entry for each.
 * In edit mode, the conversation's other working directories (`addDirs`) get a `write` entry each,
 * as the working directory has (a protected path is denied all the same). A thread names it
 * (`permissions`, an experimental field), which wins over a `sandbox_mode` in the user's config.
 * Undefined, for the legacy `sandbox` mode instead: full access, native Windows (whose legacy sandbox
 * cannot deny reading everywhere) and nothing to protect.
 */
export function codexProfile(
  permission: Permission,
  protectedPaths: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
  addDirs: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (permission === 'full' || platform === 'win32' || !protectedPaths.length) return undefined;
  const writes = permission === 'edit' ? addDirs : [];
  return {
    extends: permission === 'read-only' ? ':read-only' : ':workspace',
    filesystem: Object.fromEntries([...writes.map((path) => [path, 'write']), ...protectedPaths.map((path) => [path, 'deny'])]),
  };
}

/**
 * Config overrides for a thread. Edit mode keeps the sandbox off the network even when the user's
 * ~/.codex/config.toml turns `sandbox_workspace_write.network_access` on: pushing and publishing
 * (anything that leaves the machine) must go through an approval. Its legacy sandbox may also write
 * the conversation's other working directories (`addDirs`).
 */
export function codexConfig(
  permission: Permission,
  effort?: string,
  mcpServers: McpServerSpec[] = [],
  native: { off: readonly NativePart[]; items?: NativeItemsOff; user?: CodexUserMcp } = { off: [] },
  addDirs: readonly string[] = [],
): Record<string, unknown> {
  const mcpOff = codexMcpOff(native.off, native.items ?? {}, native.user ?? NO_USER_MCP);
  const write = { network_access: false, ...(addDirs.length ? { writable_roots: [...addDirs] } : {}) };
  return {
    ...(effort ? { model_reasoning_effort: effort } : {}),
    ...(permission === 'edit' ? { sandbox_workspace_write: write } : {}),
    ...codexNativeConfig(native.off, native.items),
    ...codexMcpConfig(mcpServers, permission === 'full', mcpOff.turnOff, mcpOff.toolsOff),
  };
}

/**
 * Config overrides that leave out what Codex loads by itself, for one thread: the skills list in its
 * instructions; ChatGPT apps (its own MCP servers are turned off in `codexMcpConfig`); the project's
 * AGENTS.md files (no setting reaches its own ~/.codex/AGENTS.md); its memories; its hooks (plugins'
 * hooks too); its plugins (their skills, MCP servers and hooks). Dotted keys, so the user's other
 * settings in those tables stay.
 *
 * Single items: skills by path (`skills.config`: Codex still applies the entries of the user's own
 * config files, checked with Codex 0.167), hooks by key (`hooks.state`) and plugins by id
 * (`plugins`), as tables Codex merges into the user's. Single hooks or plugins of a part left out
 * whole are left to its switch.
 */
export function codexNativeConfig(off: readonly NativePart[], items: NativeItemsOff = {}): Record<string, unknown> {
  const skills = items.skills ?? [];
  const hooks = off.includes('hooks') ? [] : (items.hooks ?? []);
  const plugins = off.includes('plugins') ? [] : (items.plugins ?? []);
  return {
    ...(off.includes('skills') ? { 'skills.include_instructions': false } : {}),
    ...(skills.length ? { 'skills.config': skills.map((path) => ({ path, enabled: false })) } : {}),
    ...(off.includes('mcp') ? { 'features.apps': false } : {}),
    ...(off.includes('instructions') ? { project_doc_max_bytes: 0 } : {}),
    ...(off.includes('memory') ? { 'features.memories': false } : {}),
    ...(off.includes('hooks') ? { 'features.hooks': false } : {}),
    ...(hooks.length ? { 'hooks.state': Object.fromEntries(hooks.map((key) => [key, { enabled: false }])) } : {}),
    ...(off.includes('plugins') ? { 'features.plugins': false } : {}),
    ...(plugins.length ? { plugins: Object.fromEntries(plugins.map((id) => [id, { enabled: false }])) } : {}),
  };
}

/** The id one of an MCP server's tools is left out by: the server and the tool, as JSON (either may hold any character). */
export const codexMcpToolId = (server: string, tool: string) => JSON.stringify([server, tool]);

/** The server and tool of a `codexMcpToolId`, or undefined. */
function codexMcpTool(id: string): [string, string] | undefined {
  try {
    const v: unknown = JSON.parse(id);
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? [v[0], v[1]] : undefined;
  } catch {
    return undefined;
  }
}

/** The user's own MCP servers in Codex's config, with the tools each already has turned off (`disabled_tools`). */
export interface CodexUserMcp {
  names: string[];
  disabledTools: Record<string, string[]>;
}

const NO_USER_MCP: CodexUserMcp = { names: [], disabledTools: {} };

/** The user's MCP servers in a `config/read` answer. */
export function codexUserMcpConfig(read: unknown): CodexUserMcp {
  const servers = (read as { config?: { mcp_servers?: unknown } } | undefined)?.config?.mcp_servers;
  if (!servers || typeof servers !== 'object') return NO_USER_MCP;
  const disabledTools: Record<string, string[]> = {};
  for (const [name, c] of Object.entries(servers as Record<string, { disabled_tools?: unknown }>)) {
    const tools = Array.isArray(c?.disabled_tools) ? c.disabled_tools.filter((x): x is string => typeof x === 'string') : [];
    if (tools.length) disabledTools[name] = tools;
  }
  return { names: Object.keys(servers), disabledTools };
}

/**
 * Which of the user's MCP servers a run turns off, and which tools of the others (each with the
 * tools the user already turned off: a list in an override replaces the user's). Only servers in
 * the user's config: an entry for any other would be a server without a command.
 */
export function codexMcpOff(off: readonly NativePart[], items: NativeItemsOff, user: CodexUserMcp): { turnOff: string[]; toolsOff: Record<string, string[]> } {
  if (off.includes('mcp')) return { turnOff: user.names, toolsOff: {} };
  const turnOff = (items.mcp ?? []).filter((name) => user.names.includes(name));
  const toolsOff: Record<string, string[]> = {};
  for (const id of items.mcpTools ?? []) {
    const pair = codexMcpTool(id);
    if (!pair || !user.names.includes(pair[0]) || turnOff.includes(pair[0])) continue;
    toolsOff[pair[0]] = [...new Set([...(toolsOff[pair[0]] ?? user.disabledTools[pair[0]] ?? []), pair[1]])];
  }
  return { turnOff, toolsOff };
}

/** A value written as TOML, for `-c`: tables inline, their keys quoted (so `a.b` stays one key). */
function tomlValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (v && typeof v === 'object') {
    return `{ ${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${JSON.stringify(k)} = ${tomlValue(x)}`)
      .join(', ')} }`;
  }
  return '""';
}

/**
 * Thread config overrides as `codex -c key=value` arguments, for asking `codex app-server` what a
 * thread with them would load. Codex merges an inline table into the user's (checked with Codex
 * 0.167 for `mcp_servers`), as it does a thread's config.
 */
export function codexOverrideArgs(config: Record<string, unknown>): string[] {
  return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${tomlValue(value)}`]);
}

/**
 * The MCP servers as one config override, `mcp_servers`: the tool library's servers, the user's own
 * servers named in `turnOff` with `enabled = false`, and those in `toolsOff` with the tools to turn
 * off (`disabled_tools`; a library server of the same name replaces the user's instead). Codex merges this table into the user's config.toml, so their other servers
 * and settings stay (checked with Codex 0.167). One table rather than a dotted key per server:
 * Codex splits a dotted key at every `.`, quotes or not, so a server named `a.b` could not be reached.
 *
 * Codex asks before every MCP tool call, and with the approval policy "never" (full access, or a
 * conversation that refuses automatically) it refuses the call instead. In full access the
 * library's servers therefore approve their own tools (`default_tools_approval_mode`), as full
 * access promises: everything, without asking.
 */
export function codexMcpConfig(
  servers: McpServerSpec[],
  approveTools = false,
  turnOff: string[] = [],
  toolsOff: Record<string, string[]> = {},
): Record<string, unknown> {
  const has = (vars: Record<string, string>) => Object.keys(vars).length > 0;
  const table = {
    ...Object.fromEntries(Object.entries(toolsOff).map(([name, tools]) => [name, { disabled_tools: tools }])),
    ...Object.fromEntries(turnOff.map((name) => [name, { enabled: false }])),
    ...Object.fromEntries(
      servers.map((s) => [
        s.name,
        {
          ...(s.transport === 'http'
            ? { url: s.url, ...(has(s.headers) ? { http_headers: s.headers } : {}) }
            : { command: s.command, args: s.args, ...(has(s.env) ? { env: s.env } : {}) }),
          ...(approveTools ? { default_tools_approval_mode: 'approve' } : {}),
        },
      ]),
    ),
  };
  return Object.keys(table).length ? { mcp_servers: table } : {};
}

/**
 * The MCP servers in the user's Codex config, so that each (or some of its tools) can be turned off;
 * asked (`config/read`) only when MCP servers or their tools are left out. When Codex cannot say,
 * the run fails with a message that says so: going on would quietly run the servers the user turned
 * off.
 */
export async function codexUserMcp(
  conn: { request(method: string, params?: unknown): Promise<unknown> },
  o: Pick<RunOptions, 'cwd' | 'nativeOff' | 'nativeItems'>,
): Promise<CodexUserMcp> {
  if (!o.nativeOff?.includes('mcp') && !o.nativeItems?.mcp?.length && !o.nativeItems?.mcpTools?.length) return NO_USER_MCP;
  try {
    return codexUserMcpConfig(await conn.request('config/read', { cwd: o.cwd }));
  } catch (err) {
    throw new AgentRunError(t().codexMcpListFailed(err instanceof Error ? err.message : String(err)));
  }
}

/** Whether an answer lists any entry that is on (`enabled` not false), among `items` of each of `groups`. */
function anyOn(groups: unknown, items: string, keep: (x: Record<string, unknown>) => boolean = () => true): boolean {
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);
  return list(groups).some((g) => list(g[items]).some((x) => keep(x) && x.enabled !== false));
}

/**
 * Whether a request failed because Codex does not have that method: -32601 (method not found), or
 * -32600 with "unknown variant", as Codex 0.167 answers an unknown method.
 */
export const isUnknownMethod = (err: unknown) =>
  err instanceof RpcError && (err.code === -32601 || (err.code === -32600 && /unknown variant/i.test(err.message)));

/**
 * Checks, once the thread has started, that Codex took the switches for hooks and plugins, and the
 * single skills, hooks and plugins left out: Codex ignores a config key it does not know (an older
 * version, a renamed key), so they could be left on without a word. When it still lists one of them
 * on, the run fails with a message that says so. A Codex without `hooks/list`, `plugin/installed`
 * or `skills/list` is older than these features, and goes on; any other failure to answer fails the
 * run, which could not be checked.
 */
export async function codexConfirmLeftOut(
  conn: { request(method: string, params?: unknown): Promise<unknown> },
  o: Pick<RunOptions, 'cwd' | 'nativeOff' | 'nativeItems'>,
  threadId: string,
): Promise<void> {
  const off = o.nativeOff ?? [];
  const items = o.nativeItems ?? {};
  const still: ('skills' | 'hooks' | 'plugins')[] = [];
  const ask = (method: string, params: unknown) =>
    conn.request(method, params).then(
      (r) => r as Record<string, unknown> | undefined,
      (err: unknown) => {
        if (isUnknownMethod(err)) return undefined;
        throw new AgentRunError(t().codexLeftOutUnchecked(err instanceof Error ? err.message : String(err)));
      },
    );
  const hookKeys = off.includes('hooks') ? undefined : new Set(items.hooks ?? []);
  const pluginIds = off.includes('plugins') ? undefined : new Set(items.plugins ?? []);
  const skillPaths = new Set(items.skills ?? []);
  if (skillPaths.size && anyOn((await ask('skills/list', { cwds: [o.cwd] }))?.data, 'skills', (s) => skillPaths.has(String(s.path)))) {
    still.push('skills');
  }
  if (
    (!hookKeys || hookKeys.size) &&
    anyOn((await ask('hooks/list', { threadId }))?.data, 'hooks', (h) => !hookKeys || hookKeys.has(String(h.key)))
  ) {
    still.push('hooks');
  }
  if (
    (!pluginIds || pluginIds.size) &&
    anyOn(
      (await ask('plugin/installed', { cwds: [o.cwd] }))?.marketplaces,
      'plugins',
      (p) => p.installed === true && (!pluginIds || pluginIds.has(String(p.id ?? p.name))),
    )
  ) {
    still.push('plugins');
  }
  if (still.length) throw new AgentRunError(t().codexStillLoaded(still));
}

/** The model provider Harness Relay names one of the user's own endpoints in a thread's config. */
export const codexEndpointProvider = (endpointId: string): string => `harness-relay-${endpointId}`;

/**
 * The model provider of one of the user's own endpoints, which the thread's config adds to the user's
 * own (`model_providers`): its base URL, the Responses API (`/v1/responses`: vLLM, Ollama, LM Studio and
 * llama.cpp serve it), and its key in `ENDPOINT_KEY_ENV` when it has one (none sent otherwise, nor the
 * user's ChatGPT sign-in or OpenAI key).
 */
export function codexEndpointConfig(run: EndpointModel): Record<string, unknown> {
  return {
    name: `Harness Relay: ${run.endpoint.name || run.endpoint.id}`,
    base_url: run.endpoint.baseUrl,
    wire_api: 'responses',
    ...(run.endpoint.apiKey ? { env_key: ENDPOINT_KEY_ENV } : {}),
  };
}

/** The config that makes one of the user's own endpoints the model provider: for the app-server and the thread. */
export function codexEndpointProviderConfig(run: EndpointModel): Record<string, unknown> {
  const provider = codexEndpointProvider(run.endpoint.id);
  return { model_provider: provider, model_providers: { [provider]: codexEndpointConfig(run) } };
}

/**
 * The effort a Codex run on the user's own endpoint sends: one its endpoint models offer
 * (`endpointEffort`). With none given, the one the user's Codex config sets is asked (`config/read`):
 * Codex cannot be told to send none, and one such as `xhigh`, meant for OpenAI's models, would make
 * the endpoint refuse the turn, so it becomes `medium`; with none set, none is sent. Also `medium` when
 * Codex cannot say.
 */
export async function codexEndpointEffort(
  effort: string | undefined,
  conn: { request(method: string, params?: unknown): Promise<unknown> },
  cwd: string,
): Promise<string | undefined> {
  const given = endpointEffort('codex', effort);
  if (given) return given;
  let configured: unknown;
  try {
    configured = ((await conn.request('config/read', { cwd })) as { config?: { model_reasoning_effort?: unknown } } | undefined)?.config
      ?.model_reasoning_effort;
  } catch {
    return ENDPOINT_CLI.codex.fallbackEffort;
  }
  return typeof configured === 'string' ? endpointEffort('codex', configured) : undefined;
}

/** The request that starts the run's thread, or resumes the agent's session. */
export function codexThreadRequest(
  o: Pick<
    RunOptions,
    | 'cwd'
    | 'addDirs'
    | 'permission'
    | 'systemPrompt'
    | 'model'
    | 'effort'
    | 'sessionId'
    | 'requestApproval'
    | 'mcpServers'
    | 'nativeOff'
    | 'nativeItems'
    | 'protectedPaths'
  >,
  user: CodexUserMcp = NO_USER_MCP,
  platform: NodeJS.Platform = process.platform,
  /** The profile's name (`codexProfileId()`, a new one for each run). */
  profileId: string = CODEX_PROFILE,
  /** The user's own endpoint the model is on: the thread runs its model there (`codexEndpointConfig`). */
  endpoint?: EndpointModel,
): { method: 'thread/start' | 'thread/resume'; params: Record<string, unknown> } {
  const ask = Boolean(o.requestApproval) && o.permission !== 'full';
  const profile = codexProfile(o.permission, o.protectedPaths, platform, o.addDirs);
  const config = codexConfig(o.permission, o.effort, o.mcpServers, { off: o.nativeOff ?? [], items: o.nativeItems, user }, o.addDirs);
  // A profile keeps the network off by itself; the legacy setting is for the legacy sandbox only.
  if (profile) delete config.sandbox_workspace_write;
  const provider = endpoint ? codexEndpointProvider(endpoint.endpoint.id) : undefined;
  // The app-server is started with it too (`codexEndpointProviderConfig`): Codex refuses a thread whose
  // `modelProvider` is not the app-server's own (codex 0.167).
  if (endpoint) Object.assign(config, codexEndpointProviderConfig(endpoint));
  const model = endpoint ? endpoint.model : o.model;
  const params = {
    cwd: o.cwd,
    approvalPolicy: ask ? 'on-request' : 'never',
    ...(profile ? { permissions: profileId } : { sandbox: SANDBOX[o.permission] }),
    developerInstructions: o.systemPrompt,
    ...(model ? { model } : {}),
    ...(provider ? { modelProvider: provider } : {}),
    config: profile ? { ...config, permissions: { [profileId]: profile } } : config,
  };
  return o.sessionId
    ? { method: 'thread/resume', params: { threadId: o.sessionId, ...params } }
    : { method: 'thread/start', params };
}

/**
 * Throws unless Codex runs the thread in the permission profile the request named: one that does
 * not know the field ignores it, and would run in the user's own `sandbox_mode` without a word.
 * Codex answers the profile it applied (`activePermissionProfile`, Codex 0.167).
 */
export function codexCheckProfile(params: Record<string, unknown>, response: unknown): void {
  if (typeof params.permissions !== 'string') return;
  const active = (response as { activePermissionProfile?: { id?: unknown } } | undefined)?.activePermissionProfile?.id;
  if (active !== params.permissions) throw new AgentRunError(t().codexNoProfile(typeof active === 'string' ? active : undefined));
}

const PLAN_STATUS: Record<string, PlanEntry['status']> = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed',
};

/** The folder all these paths are in, ending in its separator; '' when they share none but the root. */
export function sharedFolder(paths: string[]): string {
  if (paths.length < 2) return '';
  let prefix = paths[0]!;
  for (const p of paths.slice(1)) while (prefix && !p.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const end = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  return end > 0 ? prefix.slice(0, end + 1) : '';
}

/** A folder's last two names, with its separator: "/Users/me/repo/crates/core/" → "crates/core/". */
export function folderTail(folder: string): string {
  const sep = folder.endsWith('\\') ? '\\' : '/';
  return folder.split(/[\\/]/).filter(Boolean).slice(-2).join(sep) + sep;
}

/** A tool row for a Codex thread item, or null for items that are not tool calls. */
export function describeCodexItem(item: Record<string, any>): { name: string; detail?: string } | null {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'Shell', detail: clip(unwrapShell(String(item.command ?? ''))) };
    case 'fileChange': {
      const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
      if (changes.length === 1) {
        // One file: its path alone, which keeps its file name when it is long, and the kind as the name
        // (one the log of actions forwarded to teammates recognises, see forwardText()).
        const kind = changes[0]?.kind?.type;
        const path = changes[0]?.path ? clipPath(String(changes[0].path)) : undefined;
        return { name: kind === 'add' ? 'Create' : kind === 'delete' ? 'Delete' : 'Edit', detail: path };
      }
      // Several files: each relative to the folder they share, so their names fit, after that folder's
      // last two names, so you can tell which part of the project they are in.
      const root = sharedFolder(changes.map((c) => String(c.path ?? '')));
      const list = changes.map((c) => `${c.kind?.type ?? 'update'} ${String(c.path ?? '').slice(root.length)}`).join(', ');
      return { name: 'Edit', detail: clip((root ? `${folderTail(root)}: ` : '') + list) || undefined };
    }
    case 'mcpToolCall':
      return { name: `${item.server ?? 'mcp'}:${item.tool ?? 'tool'}`, detail: summarizeInput(item.arguments) };
    case 'dynamicToolCall':
      return { name: String(item.tool ?? 'tool'), detail: summarizeInput(item.arguments) };
    case 'webSearch':
      // The query and action only come with item/completed; item/started has an empty query.
      return { name: 'WebSearch', detail: clip(String(item.query ?? '')) || webSearchDetail(item.action) };
    default:
      return null;
  }
}

/** How a finished tool item went: ok, plus output or a failure reason. */
function itemOutcome(item: Record<string, any>): { ok: boolean; output?: string; error?: string } {
  switch (item.type) {
    case 'commandExecution': {
      const output = item.aggregatedOutput ? tailText(String(item.aggregatedOutput)) : undefined;
      if (item.status === 'declined') return { ok: false, error: t().approvalDeclined };
      const ok = item.status === 'completed' && (item.exitCode === null || item.exitCode === undefined || item.exitCode === 0);
      return ok ? { ok, output } : { ok, output, error: item.exitCode != null ? `exit ${item.exitCode}` : undefined };
    }
    case 'fileChange':
      return item.status === 'declined'
        ? { ok: false, error: t().approvalDeclined }
        : { ok: item.status === 'completed' || item.status === undefined };
    case 'mcpToolCall': {
      if (item.error) return { ok: false, error: clip(String(item.error.message ?? item.error), 240) };
      const content = Array.isArray(item.result?.content) ? item.result.content : [];
      const text = content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim();
      return { ok: item.status !== 'failed', output: text ? tailText(text) : undefined };
    }
    default:
      return { ok: item.status !== 'failed' };
  }
}

/** Turns app-server notifications for one thread into AgentEvents. */
export function createCodexUpdateHandler(emit: (e: AgentEvent) => void) {
  /** Tool items already shown, with the detail they were shown with. */
  const started = new Map<string, string | undefined>();
  const streamedText = new Set<string>();
  const streamedThinking = new Set<string>();
  /** File paths of file-change items, to show what an approval request is about. */
  const filePaths = new Map<string, string>();
  let usage = { input: 0, output: 0, seen: false };
  let threadTotal: number | undefined; // the thread's total tokens at the last update

  const startTool = (item: Record<string, any>) => {
    const d = describeCodexItem(item);
    if (!d || !item.id || started.has(item.id)) return;
    started.set(item.id, d.detail);
    if (item.type === 'fileChange') filePaths.set(item.id, (item.changes ?? []).map((c: any) => c.path).join(', '));
    emit({ type: 'tool_start', id: item.id, ...d });
  };

  function handle(method: string, p: Record<string, any>): void {
    switch (method) {
      case 'item/agentMessage/delta':
        if (p.delta) {
          streamedText.add(p.itemId);
          emit({ type: 'text', text: String(p.delta) });
        }
        break;
      case 'item/reasoning/summaryTextDelta':
        if (p.delta) {
          streamedThinking.add(p.itemId);
          emit({ type: 'thinking', text: String(p.delta) });
        }
        break;
      case 'item/reasoning/summaryPartAdded':
        if (streamedThinking.has(p.itemId)) emit({ type: 'thinking', text: '\n\n' });
        break;
      case 'item/started':
        startTool(p.item ?? {});
        break;
      case 'item/completed': {
        const item = p.item ?? {};
        if (item.type === 'agentMessage') {
          if (!streamedText.has(item.id) && item.text) emit({ type: 'text', text: String(item.text) });
          emit({ type: 'text_end' });
          break;
        }
        if (item.type === 'reasoning') {
          const summary = (Array.isArray(item.summary) ? item.summary : []).join('\n\n').trim();
          if (!streamedThinking.has(item.id) && summary) emit({ type: 'thinking', text: summary });
          break;
        }
        const d = describeCodexItem(item);
        if (!d) break;
        startTool(item);
        // A web search only says what it searched for now.
        const detail = d.detail && d.detail !== started.get(item.id) ? d.detail : undefined;
        const { ok, output, error } = itemOutcome(item);
        emit({ type: 'tool_end', id: item.id, ok, ...(output ? { output } : {}), ...(error ? { error } : {}), ...(detail ? { detail } : {}) });
        break;
      }
      case 'turn/plan/updated': {
        const plan: any[] = Array.isArray(p.plan) ? p.plan : [];
        emit({ type: 'plan', entries: plan.map((s) => ({ text: String(s.step ?? ''), status: PLAN_STATUS[s.status] ?? 'pending' })) });
        break;
      }
      case 'thread/tokenUsage/updated': {
        // One update per model call; `last` is that call's usage. Its input counts the cached tokens
        // (`cachedInputTokens` is part of it) and its output the reasoning (`reasoningOutputTokens` is
        // part of it: `totalTokens` is input plus output). Codex sends the same count again at times
        // (with its rate limits): an update whose thread total did not change is no new call.
        const last = p.tokenUsage?.last;
        const total = p.tokenUsage?.total?.totalTokens;
        if (typeof total === 'number' && total === threadTotal) break;
        if (typeof total === 'number') threadTotal = total;
        if (last) {
          usage = {
            input: usage.input + (last.inputTokens ?? 0),
            output: usage.output + (last.outputTokens ?? 0),
            seen: true,
          };
        }
        break;
      }
    }
  }

  return {
    handle,
    filePaths(itemId: string): string | undefined {
      return filePaths.get(itemId);
    },
    get usage() {
      return usage.seen ? { inputTokens: usage.input, outputTokens: usage.output } : {};
    },
  };
}

/** What to show the user for an app-server approval request. */
export function codexApprovalRequest(
  method: string,
  p: Record<string, any>,
  filePaths: (itemId: string) => string | undefined,
): ApprovalRequest | null {
  const reason = p.reason ? String(p.reason) : undefined;
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { kind: 'command', detail: unwrapShell(String(p.command ?? '')), command: String(p.command ?? ''), reason };
    case 'item/fileChange/requestApproval':
      return { kind: 'edit', detail: p.grantRoot ? String(p.grantRoot) : filePaths(String(p.itemId)), reason };
    case 'item/permissions/requestApproval':
      return { kind: 'other', tool: 'permissions', detail: clip(JSON.stringify(p.permissions ?? {})), reason };
    case 'execCommandApproval':
      const command = Array.isArray(p.command) ? p.command.join(' ') : String(p.command ?? '');
      return { kind: 'command', detail: unwrapShell(command), command, reason };
    case 'applyPatchApproval':
      return { kind: 'edit', detail: Object.keys(p.fileChanges ?? {}).join(', ') || undefined, reason };
    default:
      return null;
  }
}

/**
 * Codex asks before an MCP tool runs with an MCP elicitation marked as a tool-call approval
 * (`_meta.codex_approval_kind: "mcp_tool_call"`, Codex 0.167): what to show the user for it. Null
 * for any other elicitation (a form an MCP server wants filled in), which is declined.
 */
export function codexMcpToolApproval(p: Record<string, any>): ApprovalRequest | null {
  const meta = p?._meta;
  if (meta?.codex_approval_kind !== 'mcp_tool_call' || typeof meta.tool_name !== 'string') return null;
  const params = meta.tool_params && typeof meta.tool_params === 'object' && Object.keys(meta.tool_params).length ? meta.tool_params : undefined;
  return {
    kind: 'other',
    tool: p.serverName ? `${p.serverName}:${meta.tool_name}` : meta.tool_name,
    ...(params ? { detail: clip(JSON.stringify(params)) } : {}),
  };
}

/** The reply to an MCP elicitation: an accepted tool-call approval has no form, so no content. */
export function codexElicitationResponse(accept: boolean): unknown {
  return accept ? { action: 'accept', content: {}, _meta: null } : { action: 'decline', content: null, _meta: null };
}

/** The reply Codex expects for an approval request, allowed or not. */
export function codexApprovalResponse(method: string, p: Record<string, any>, allow: boolean, note?: string): unknown {
  switch (method) {
    case 'item/permissions/requestApproval':
      return allow
        ? { permissions: { network: p.permissions?.network ?? undefined, fileSystem: p.permissions?.fileSystem ?? undefined }, scope: 'turn' }
        : { permissions: {}, scope: 'turn' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: allow ? 'approved' : { denied: { rejection: note || 'The user declined this.' } } };
    default:
      return { decision: allow ? 'accept' : 'decline' };
  }
}

const codexTurnRunner: AgentRunner = {
  provider: 'codex',
  async run(given): Promise<RunResult> {
    if (given.signal.aborted) throw new AgentRunError(t().stopped, true);
    // On the user's own endpoint: its key in the variable its model provider names, and no other.
    const endpoint = endpointRunModel(given.backends, given.model, PROVIDER_LABEL.codex);
    const o = {
      ...given,
      protectedPaths: given.protectedPaths ?? protectedReads(),
      ...(endpoint ? { env: endpointKeyEnv(given.env, endpoint) } : {}),
    };
    // A permission profile is an experimental thread field, which the client opts into.
    const profile = codexProfile(o.permission, o.protectedPaths);
    // A path its sandbox would read as a pattern would be left unprotected: the run does not start.
    const pattern = profile ? patternPath(o.protectedPaths) : undefined;
    if (pattern) throw new AgentRunError(t().protectedPattern(pattern));
    // Also for the whole app-server, as asking Codex what a run loads does (the thread gets them too):
    // none of these carries a secret, unlike the MCP servers, which only go in the thread's config.
    // The endpoint's model provider neither (its key is in a variable): Codex takes a thread's
    // `modelProvider` only when it is the app-server's own (codex 0.167).
    const args = [
      'app-server',
      '-c',
      'model_reasoning_summary="auto"',
      ...codexOverrideArgs(codexNativeConfig(o.nativeOff ?? [], o.nativeItems)),
      ...(endpoint ? codexOverrideArgs(codexEndpointProviderConfig(endpoint)) : []),
    ];

    let child: ChildProcess | undefined;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let userAborted = false;
    let failure: string | undefined;
    const stop = new AbortController();
    const stopSoon = (ms: number) => setTimeout(() => stop.abort(), ms).unref();

    const conn = new JsonRpcConnection((line) => child?.stdin?.write(line + '\n'), { versionField: false });
    const updates = createCodexUpdateHandler(o.onEvent);
    let resolveTurn: (turn: Record<string, any>) => void = () => {};
    const turnDone = new Promise<Record<string, any>>((r) => (resolveTurn = r));

    conn.onNotification = (method, params) => {
      if (method === 'error' && params?.error?.message) failure = String(params.error.message);
      if (!threadId || params?.threadId !== threadId) return; // other threads (sub-agents) and startup noise
      if (method === 'turn/completed') resolveTurn(params.turn ?? {});
      else updates.handle(method, params);
    };
    conn.onRequest = async (method, params) => {
      if (method === 'item/tool/requestUserInput') return { answers: {} };
      // Asked only of clients that take the experimental API, as a profile needs.
      if (method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1000) };
      if (method === 'mcpServer/elicitation/request') {
        const tool = codexMcpToolApproval(params ?? {});
        if (!tool || !o.requestApproval) return codexElicitationResponse(false);
        return codexElicitationResponse((await o.requestApproval(tool)).allow);
      }
      const req = codexApprovalRequest(method, params ?? {}, (id) => updates.filePaths(id));
      if (!req) throw new RpcError(-32601, `${method} is not supported`);
      const answer = o.requestApproval ? await o.requestApproval(req) : { allow: false };
      return codexApprovalResponse(method, params ?? {}, answer.allow, answer.note);
    };

    const onAbort = () => {
      userAborted = true;
      if (threadId && turnId) void conn.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
      stopSoon(2000);
    };
    o.signal.addEventListener('abort', onAbort, { once: true });

    const exited = runProcess({
      bin: o.bin,
      args,
      cwd: o.cwd,
      env: o.env,
      signal: stop.signal,
      timeoutMs: TURN_TIMEOUT_MS,
      keepStdinOpen: true,
      onSpawn: (c) => (child = c),
      onLine: conn.handleLine,
    }).then(
      (res) => {
        const why = res.timedOut ? t().timedOut : tail(res.stderr) || t().exitedWithoutTurn('codex', res.code);
        conn.close(new AgentRunError(why));
        resolveTurn({ status: 'failed', error: { message: why } });
        return res;
      },
      (err: Error) => {
        conn.close(err);
        resolveTurn({ status: 'failed', error: { message: err.message } });
        throw err;
      },
    );
    exited.catch(() => undefined); // surfaced through the requests and the turn instead

    try {
      await conn.request('initialize', {
        clientInfo: { name: 'harness_relay', title: 'Harness Relay', version: '0.1.0' },
        capabilities: profile ? { experimentalApi: true } : null,
      });
      conn.notify('initialized');
      const effort = endpoint ? await codexEndpointEffort(o.effort, conn, o.cwd) : o.effort;
      const { method, params } = codexThreadRequest({ ...o, effort }, await codexUserMcp(conn, o), process.platform, codexProfileId(), endpoint);
      const thread = await conn.request(method, params);
      codexCheckProfile(params, thread);
      threadId = String(thread?.thread?.id ?? o.sessionId ?? '');
      if (!threadId) throw new AgentRunError(t().exitedWithoutTurn('codex', null));
      o.onEvent({ type: 'session', sessionId: threadId });
      if (userAborted) throw new AgentRunError(t().stopped, true);
      await codexConfirmLeftOut(conn, o, threadId);
      // Stopped during the check: there is no turn to interrupt yet, so do not start one.
      if (userAborted) throw new AgentRunError(t().stopped, true);

      const started = await conn.request('turn/start', {
        threadId,
        input: [
          { type: 'text', text: o.prompt, text_elements: [] },
          ...(o.images ?? []).map((img) => ({ type: 'localImage', path: img.path })),
        ],
      });
      turnId = started?.turn?.id;
      const turn = await turnDone;

      if (userAborted) throw new AgentRunError(t().stopped, true);
      if (turn.status === 'failed' || turn.status === 'interrupted') {
        const err = turn.error ?? {};
        const message = [err.message, err.additionalDetails].filter(Boolean).join('\n') || failure;
        throw new AgentRunError(message || t().exitedWithoutTurn('codex', null));
      }
      return { sessionId: threadId, ...updates.usage };
    } catch (err) {
      if (userAborted) throw new AgentRunError(t().stopped, true);
      if (err instanceof AgentRunError) throw err;
      throw new AgentRunError(err instanceof Error ? err.message : String(err));
    } finally {
      o.signal.removeEventListener('abort', onAbort);
      child?.stdin?.end();
      stopSoon(3000);
      await exited.catch(() => undefined);
    }
  },
};

/**
 * Whether this Codex cannot load a permission profile of Harness Relay's: seen with Codex 0.167 on
 * Linux (DGX Spark, Ubuntu 24.04), where a turn in any profile but Codex's own fails sending its
 * request ("failed to load workspace requirements: invalid input parameter"). Then, for the rest of
 * the server's run, Codex gets its legacy sandbox mode for the permission instead: its writes and
 * network as before, without the deny list (`docs/sandboxing.md`).
 */
let profilesUnavailable = false;

/** The message of a turn whose permission profile Codex could not load. */
export const CODEX_PROFILE_LOAD_FAILED = /failed to load workspace requirements/i;

export const codexRunner: AgentRunner = {
  provider: 'codex',
  async run(o): Promise<RunResult> {
    const legacy = { ...o, protectedPaths: [] };
    if (profilesUnavailable) return codexTurnRunner.run(legacy);
    try {
      return await codexTurnRunner.run(o);
    } catch (err) {
      const profiled = codexProfile(o.permission, o.protectedPaths ?? protectedReads());
      if (!profiled || !(err instanceof AgentRunError) || err.aborted || !CODEX_PROFILE_LOAD_FAILED.test(err.message)) throw err;
      profilesUnavailable = true;
      console.warn(`[codex] it cannot load a permission profile here (${err.message}): using its legacy sandbox, without the deny list`);
      return codexTurnRunner.run(legacy);
    }
  },
};

/** For tests: forget that profiles were found not to load. */
export function resetCodexProfiles(): void {
  profilesUnavailable = false;
}

