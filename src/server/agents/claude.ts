import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import type { NativeItemsOff, NativePart, Permission, PlanEntry } from '../../shared/types';
import { converse, runProcess, tail } from '../process';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  imageData,
  parseJsonLine,
  summarizeInput,
  tailText,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type McpServerSpec,
  type RunOptions,
  type RunResult,
} from './types';
import { t } from '../i18n';

/*
 * Claude Code runs as `claude -p` with stream-json in both directions. The prompt goes in as a
 * user message; when the conversation asks the user about actions the permission does not cover,
 * `--permission-prompt-tool stdio` makes Claude Code send each one as a `can_use_tool` control
 * request on stdout and wait for our control response on stdin. Without it, such actions are
 * denied automatically and the model is told.
 */

/** Permission mode when the user is asked / when such actions are refused automatically. */
const PERMISSION_MODE: Record<Permission, { ask: string; deny: string }> = {
  // manual: anything beyond reading asks; dontAsk: anything that would ask is denied.
  'read-only': { ask: 'manual', deny: 'dontAsk' },
  edit: { ask: 'acceptEdits', deny: 'acceptEdits' },
  full: { ask: 'bypassPermissions', deny: 'bypassPermissions' },
};

/**
 * Shell commands pre-approved in edit mode: building, testing, linting and formatting the project.
 * Any other command that needs approval goes to the user (or is denied when the conversation does
 * not ask). Installs, git writes and deletes are never pre-approved.
 */
export const CLAUDE_EDIT_COMMANDS = [
  'mkdir',
  'make',
  // Node
  'npm test',
  'npm run',
  'pnpm test',
  'pnpm run',
  'yarn test',
  'yarn run',
  'bun test',
  'bun run',
  'npx tsc',
  'npx vitest',
  'npx jest',
  'npx eslint',
  'npx prettier',
  'tsc',
  'vitest',
  'jest',
  'eslint',
  'prettier',
  // Python
  'pytest',
  'python -m pytest',
  'python3 -m pytest',
  'uv run pytest',
  'ruff',
  'mypy',
  'black',
  // Rust / Go
  'cargo build',
  'cargo check',
  'cargo test',
  'cargo clippy',
  'cargo fmt',
  'cargo run',
  'go build',
  'go test',
  'go vet',
  'gofmt',
];

/**
 * The rule that sends every command the model runs outside the sandbox (`dangerouslyDisableSandbox`)
 * to the user. An ask rule beats allow rules, so the edit commands above cannot leave it unasked.
 */
export const CLAUDE_UNSANDBOXED_RULE = 'Bash(dangerouslyDisableSandbox:true)';

/**
 * Claude Code's own sandbox below full access (`sandbox` in `--settings`): its Bash commands, and
 * what they start, run in the OS sandbox (Seatbelt on macOS, bubblewrap on Linux and WSL2), which
 * lets them write in the working directory, its added folders and the temp folders only, and asks
 * about every network host (a `SandboxNetworkAccess` request).
 * - `failIfUnavailable`: no sandbox, no run, rather than commands run without one.
 * - `autoAllowBashIfSandboxed: false`: the permission, not the sandbox, still decides what runs
 *   without asking.
 * Claude Code has no sandbox on native Windows, so there it runs without one, as before.
 */
export function claudeSandboxSettings(
  permission: Permission,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> | undefined {
  if (permission === 'full' || platform === 'win32') return undefined;
  return {
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false },
    permissions: { ask: [CLAUDE_UNSANDBOXED_RULE] },
  };
}

/** The `--settings` of one turn: what it leaves out (`claudeNativeSettings`) and the sandbox. */
export function claudeRunSettings(
  permission: Permission,
  off: readonly NativePart[] = [],
  pluginIds: readonly string[] = [],
  items: NativeItemsOff = {},
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> | undefined {
  const native = claudeNativeSettings(off, pluginIds, items);
  const sandbox = claudeSandboxSettings(permission, platform);
  if (!native || !sandbox) return native ?? sandbox;
  return { ...native, ...sandbox, permissions: { ...(native.permissions as object | undefined), ...(sandbox.permissions as object) } };
}

/** Tools approved up front. Web access is not about the file system, so every level gets it. */
export function claudeAllowedTools(permission: Permission): string[] {
  if (permission === 'full') return [];
  return ['WebFetch', 'WebSearch', ...(permission === 'edit' ? CLAUDE_EDIT_COMMANDS.map((c) => `Bash(${c}:*)`) : [])];
}

/**
 * Tools removed outright. Read-only drops the file-editing tools: `permissions.allow` rules in the
 * user's or a trusted project's Claude Code settings would otherwise let them run without asking.
 */
export function claudeDisallowedTools(permission: Permission): string[] {
  return permission === 'read-only' ? ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] : [];
}

/**
 * A `Read` permission rule for everything in an absolute folder (`//` starts an absolute path in
 * Claude Code's rules; Windows paths are written as /c/…).
 */
export function claudeReadRule(dir: string): string {
  const posix = /^[A-Za-z]:[\\/]/.test(dir) ? `/${dir[0]!.toLowerCase()}${dir.slice(2)}` : dir;
  return `Read(/${posix.replace(/\\/g, '/').replace(/\/+$/, '')}/**)`;
}

/** Claude Code's `--mcp-config` content for the tool library's MCP servers. */
export function claudeMcpConfig(servers: McpServerSpec[]): { mcpServers: Record<string, unknown> } {
  const has = (vars: Record<string, string>) => Object.keys(vars).length > 0;
  return {
    mcpServers: Object.fromEntries(
      servers.map((s) => [
        s.name,
        s.transport === 'http'
          ? { type: 'http', url: s.url, ...(has(s.headers) ? { headers: s.headers } : {}) }
          : { type: 'stdio', command: s.command, args: s.args, ...(has(s.env) ? { env: s.env } : {}) },
      ]),
    ),
  };
}

/**
 * Variables that make Claude Code leave out its instruction files (CLAUDE.md, rules) and its auto
 * memory for one run; the rest is left out with flags (`claudeNativeArgs`), and its own subagents
 * once it has started (`claudeAgentsGate`).
 */
export function claudeNativeEnv(off: readonly NativePart[] = []): Record<string, string> {
  return {
    ...(off.includes('instructions') ? { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } : {}),
    ...(off.includes('memory') ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}),
  };
}

/**
 * Claude Code's name for an MCP server in its tool names and permission rules
 * (`mcp__<name>__<tool>`): every character but letters, digits, `_` and `-` becomes `_`, and for a
 * claude.ai connector runs of `_` become one and none is left at either end (as Claude Code 2.1.319
 * does).
 */
export function claudeMcpName(server: string): string {
  const name = server.replace(/[^a-zA-Z0-9_-]/g, '_');
  return server.startsWith('claude.ai ') ? name.replace(/_+/g, '_').replace(/^_|_$/g, '') : name;
}

/**
 * A file path as a `claudeMdExcludes` pattern that matches only that file: Claude Code matches the
 * patterns as globs (picomatch) against paths written with `/`, so the characters a glob gives a
 * meaning to are put in brackets. Not with a backslash: Claude Code turns every `\\` in a pattern
 * into `/` first. With every `[` in brackets, a `]` is plain.
 */
export function claudeExcludePattern(path: string): string {
  return path.replace(/\\/g, '/').replace(/[*?[{}()]/g, (c) => `[${c}]`);
}

/**
 * Single items without the MCP servers (and their tools) the tool library gives this run: a rule
 * `mcp__<server>` goes by name, so it would also take away a library server of the same name, which
 * replaces the user's own anyway.
 */
export function claudeItemsBesideLibrary(items: NativeItemsOff, servers: readonly { name: string }[]): NativeItemsOff {
  const library = servers.map((s) => `mcp__${claudeMcpName(s.name)}`);
  if (!library.length || (!items.mcp?.length && !items.mcpTools?.length)) return items;
  const mcp = (items.mcp ?? []).filter((id) => !library.includes(id));
  const mcpTools = (items.mcpTools ?? []).filter((id) => !library.some((server) => id.startsWith(`${server}__`)));
  const { mcp: _m, mcpTools: _t, ...rest } = items;
  return { ...rest, ...(mcp.length ? { mcp } : {}), ...(mcpTools.length ? { mcpTools } : {}) };
}

/**
 * Settings for one run (`--settings`, the flag layer above the user's and the project's files):
 * - no hooks, from settings files or plugins;
 * - plugins turned off by id (all installed ones when plugins are left out: Claude Code has no
 *   switch for all of them, hence the ids from `claudePlugins`), which also takes away their skills,
 *   commands, subagents, hooks and MCP servers;
 * - single skills by name (`skillOverrides` "off": hidden from the model and from /name);
 * - single instruction files by path (`claudeMdExcludes`);
 * - permission rules that deny single built-in tools, MCP servers (`mcp__<server>`: all its tools;
 *   the server still starts), MCP tools and subagents (`Agent(name)`).
 * Single items of a part left out whole are left to that part's switch, except subagents (the
 * switch keeps the built-in ones) and plugins; with all MCP servers left out, rules for single ones
 * are not added, since they would also reach a tool library server of the same name.
 */
export function claudeNativeSettings(
  off: readonly NativePart[] = [],
  pluginIds: readonly string[] = [],
  items: NativeItemsOff = {},
): Record<string, unknown> | undefined {
  const plugins = off.includes('plugins') ? pluginIds : (items.plugins ?? []);
  const skills = off.includes('skills') ? [] : (items.skills ?? []);
  const files = off.includes('instructions') ? [] : (items.instructions ?? []);
  const deny = [
    ...(off.includes('tools') ? [] : (items.tools ?? [])),
    ...(off.includes('mcp') ? [] : [...(items.mcp ?? []), ...(items.mcpTools ?? [])]),
    ...(items.agents ?? []).map((name) => `Agent(${name})`),
  ];
  const settings = {
    ...(off.includes('hooks') ? { disableAllHooks: true } : {}),
    ...(plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((id) => [id, false])) } : {}),
    ...(skills.length ? { skillOverrides: Object.fromEntries(skills.map((name) => [name, 'off'])) } : {}),
    ...(files.length ? { claudeMdExcludes: files.map(claudeExcludePattern) } : {}),
    ...(deny.length ? { permissions: { deny } } : {}),
  };
  return Object.keys(settings).length ? settings : undefined;
}

/**
 * The flags that leave out what Claude Code loads by itself: its skills (and other custom
 * commands), its own MCP servers (only the tool library's, from --mcp-config, stay), all its
 * built-in tools (`--tools ""`), and through `--settings` its hooks, plugins and single items
 * (`claudeNativeSettings`).
 */
export function claudeNativeArgs(
  off: readonly NativePart[] = [],
  pluginIds: readonly string[] = [],
  items: NativeItemsOff = {},
  settingsFile?: string,
  /** The `--settings` to pass; what is left out, unless the turn adds more (`claudeRunSettings`). */
  settings: Record<string, unknown> | undefined = claudeNativeSettings(off, pluginIds, items),
): string[] {
  return [
    ...(off.includes('skills') ? ['--disable-slash-commands'] : []),
    ...(off.includes('mcp') ? ['--strict-mcp-config'] : []),
    ...(off.includes('tools') ? ['--tools', ''] : []),
    ...(settings ? ['--settings', settingsFile ?? JSON.stringify(settings)] : []),
  ];
}

/**
 * The run's `--settings` in a private file for the run, when there are any: with many single items
 * left out they would not fit a command line (Windows takes 32,767 characters).
 */
export function claudeSettingsFile(settings: Record<string, unknown> | undefined): { file: string; remove: () => void } | undefined {
  return settings ? privateTempFile('settings.json', JSON.stringify(settings)) : undefined;
}

/** How long a short question to Claude Code (its plugins, its built-in subagents) may take. */
const PROBE_TIMEOUT_MS = 30_000;

/** The arguments that start Claude Code for control requests only (the stream-json protocol, no prompt). */
export const CLAUDE_PROBE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

/** An installed plugin as `claude plugin list --json` reports it. */
export interface ClaudePlugin {
  id: string;
  enabled?: boolean;
  scope?: string;
}

/** The plugins in `claude plugin list --json`, once each; undefined when the output is not that list. */
export function parseClaudePluginList(stdout: string): ClaudePlugin[] | undefined {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const seen = new Set<string>();
  const plugins: ClaudePlugin[] = [];
  for (const p of list) {
    if (typeof p?.id !== 'string' || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    plugins.push({
      id: p.id,
      ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
      ...(typeof p.scope === 'string' ? { scope: p.scope } : {}),
    });
  }
  return plugins;
}

/** Claude Code's installed plugins (user, project and the rest), asked with `claude plugin list --json`. */
export async function claudePlugins(bin: string, env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal): Promise<ClaudePlugin[]> {
  const res = await runProcess({ bin, args: ['plugin', 'list', '--json'], cwd, env, signal, timeoutMs: PROBE_TIMEOUT_MS, maxCapture: 4 * 1024 * 1024 });
  const list = res.code === 0 ? parseClaudePluginList(res.stdout) : undefined;
  if (!list) throw new Error(res.timedOut ? 'timed out' : tail(res.stderr || res.stdout) || `exit ${res.code}`);
  return list;
}

/** A subagent as Claude Code's `initialize` answer names it. */
export interface ClaudeAgent {
  name: string;
  description: string;
}

/**
 * The subagents in an `initialize` answer; undefined when it does not list them, or lists one
 * without a name (it could not be denied).
 */
export function claudeAgents(init: unknown): ClaudeAgent[] | undefined {
  const agents = (init as { agents?: unknown } | undefined)?.agents;
  if (!Array.isArray(agents) || agents.some((a) => typeof a?.name !== 'string' || !a.name)) return undefined;
  return agents.map((a) => ({ name: a.name as string, description: typeof a.description === 'string' ? a.description : '' }));
}

/** Claude Code's built-in subagents: each name with its description. */
export type ClaudeBuiltinAgents = ReadonlyMap<string, string>;

/**
 * Whether a subagent is a built-in one: its name and description as Claude Code has them with
 * nothing around it. A user's or project's subagent of the same name replaces the built-in one,
 * and its own description gives it away.
 */
export const isBuiltinAgent = (agent: ClaudeAgent, builtins: ClaudeBuiltinAgents) => builtins.get(agent.name) === agent.description;

/**
 * Permission rules that deny the subagents that are not built in (one that replaces a built-in
 * one too, which leaves that name without a subagent). Claude Code takes a denied subagent off the
 * Agent tool's list and refuses to start it.
 */
export function claudeAgentDenyRules(agents: readonly ClaudeAgent[], builtins: ClaudeBuiltinAgents): string[] {
  return [...new Set(agents.filter((a) => !isBuiltinAgent(a, builtins)).map((a) => a.name))].map((name) => `Agent(${name})`);
}

const builtinAgents = new Map<string, Promise<ClaudeBuiltinAgents>>();

/**
 * Claude Code's built-in subagents (with any an organisation's managed settings add): the ones it
 * reports with no settings files, plugins or project around it. Its `initialize` answer does not
 * say where a subagent comes from. Asked once per executable, version and config folder, in an
 * empty folder; no model is called.
 */
export function claudeBuiltinAgents(bin: string, env: NodeJS.ProcessEnv, version = ''): Promise<ClaudeBuiltinAgents> {
  const key = `${bin}\0${version}\0${env.CLAUDE_CONFIG_DIR ?? ''}`;
  let hit = builtinAgents.get(key);
  if (!hit) {
    hit = askBuiltinAgents(bin, env);
    builtinAgents.set(key, hit);
    hit.catch(() => builtinAgents.delete(key));
  }
  return hit;
}

async function askBuiltinAgents(bin: string, env: NodeJS.ProcessEnv): Promise<ClaudeBuiltinAgents> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-relay-'));
  try {
    let agents: ClaudeAgent[] | undefined;
    let error: string | undefined;
    const res = await converse({
      bin,
      cwd: dir,
      env,
      timeoutMs: PROBE_TIMEOUT_MS,
      args: [
        ...CLAUDE_PROBE_ARGS,
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--settings',
        JSON.stringify({ disableAllHooks: true }),
      ],
      open: (write) => write({ type: 'control_request', request_id: 'relay-builtin', request: { subtype: 'initialize' } }),
      onMessage: (m, _write, finish) => {
        if (m.type !== 'control_response' || m.response?.request_id !== 'relay-builtin') return;
        if (m.response.subtype === 'error') {
          error = String(m.response.error ?? 'error');
        } else {
          agents = claudeAgents(m.response.response);
          if (!agents) error = 'it did not list its subagents';
        }
        finish();
      },
    });
    if (!agents) throw new Error(error ?? (res.timedOut ? 'timed out' : tail(res.stderr) || 'no answer'));
    return new Map(agents.map((a) => [a.name, a.description]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Leaves Claude Code's own subagents out of a run, before the prompt is sent: once the answer to
 * `initialize` names the subagents it loaded, those that are not built in are denied for the
 * session (an `apply_flag_settings` control request with `Agent(name)` rules), and then `start`
 * sends the prompt. Returns a handler for the CLI's messages that says which ones it took. Anything
 * that goes wrong calls `fail`, a list of subagents missing from the answer too: going on would
 * quietly run the subagents the user turned off.
 */
export function claudeAgentsGate(o: {
  initId: string;
  builtins: (version: string | undefined) => Promise<ClaudeBuiltinAgents>;
  send: (msg: unknown) => void;
  start: () => void;
  fail: (detail: string) => void;
}): (msg: Record<string, any>) => boolean {
  const denyId = `${o.initId}-agents`;
  return (msg) => {
    if (msg.type !== 'control_response') return false;
    const r = msg.response ?? {};
    if (r.request_id === o.initId) {
      if (r.subtype === 'error') {
        o.fail(String(r.error ?? 'initialize failed'));
        return true;
      }
      const agents = claudeAgents(r.response);
      if (!agents) {
        o.fail('it did not list its subagents');
        return true;
      }
      const version = typeof r.response?.claude_code_version === 'string' ? r.response.claude_code_version : undefined;
      o.builtins(version).then(
        (builtins) => {
          const deny = claudeAgentDenyRules(agents, builtins);
          if (!deny.length) return o.start();
          o.send({ type: 'control_request', request_id: denyId, request: { subtype: 'apply_flag_settings', settings: { permissions: { deny } } } });
        },
        (err: unknown) => o.fail(err instanceof Error ? err.message : String(err)),
      );
      return true;
    }
    if (r.request_id === denyId) {
      if (r.subtype === 'error') o.fail(String(r.error ?? 'apply_flag_settings failed'));
      else o.start();
      return true;
    }
    return false;
  };
}

/** A file only this user can read, in a new temporary folder that `remove()` deletes. */
function privateTempFile(name: string, content: string): { file: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'harness-relay-'));
  const file = join(dir, name);
  writeFileSync(file, content, { mode: 0o600 });
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Command-line flags a Claude Code version may not know yet; dropped (and remembered) when it rejects one. */
const OPTIONAL_FLAGS = {
  // Readable thinking summaries (by default the thinking text is left empty). Not in `--help`.
  thinking: ['--thinking-display', 'summarized'],
  // Without it, a resumed session keeps the system prompt of its first request, so role, team,
  // mode and permission changes would never reach the agent.
  freshPrompt: ['--system-prompt-snapshot', 'off'],
} as const;
type OptionalFlag = keyof typeof OPTIONAL_FLAGS;
const unsupported = new Set<OptionalFlag>();

/** The `claude` arguments for one turn. */
export function claudeArgs(o: {
  systemPrompt: string;
  permission: Permission;
  ask: boolean;
  model?: string;
  effort?: string;
  sessionId?: string;
  newSessionId?: string;
  /** A directory of attached files outside the working directory that Claude may read. */
  attachmentsDir?: string;
  /** Other folders outside the working directory Claude may read (not write), e.g. skills. */
  readDirs?: string[];
  /** The `--mcp-config` file with the tool library's MCP servers. */
  mcpConfig?: string;
  /** What Claude Code loads by itself to leave out (instructions and memory go through `claudeNativeEnv`). */
  nativeOff?: readonly NativePart[];
  /** Single items of it to leave out. */
  nativeItems?: NativeItemsOff;
  /** The installed plugins, turned off when plugins are left out. */
  pluginIds?: readonly string[];
  /** A file holding the turn's `--settings` (else they go on the command line). */
  settingsFile?: string;
  /** The platform Claude Code runs on, which decides whether it has a sandbox. */
  platform?: NodeJS.Platform;
  skip?: ReadonlySet<OptionalFlag>;
}): string[] {
  const optional = (Object.keys(OPTIONAL_FLAGS) as OptionalFlag[]).filter((f) => !o.skip?.has(f));
  const disallowed = claudeDisallowedTools(o.permission);
  const reads = o.permission === 'full' ? [] : (o.readDirs ?? []).map(claudeReadRule);
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt',
    o.systemPrompt,
    // Variadic; the next `--flag` ends the list.
    ...withAllowedTools([...claudeAllowedTools(o.permission), ...reads]),
    ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
    // Lets Claude read the attached files outside the working directory (variadic too).
    ...(o.attachmentsDir ? ['--add-dir', o.attachmentsDir] : []),
    // Added to the user's own MCP servers (variadic too).
    ...(o.mcpConfig ? ['--mcp-config', o.mcpConfig] : []),
    // Leave out what Claude Code loads by itself: its skills, its own MCP servers (the tool
    // library's, from --mcp-config, stay), its built-in tools, hooks and plugins, and single items;
    // and below full access, turn its sandbox on.
    ...claudeNativeArgs(
      o.nativeOff,
      o.pluginIds,
      o.nativeItems,
      o.settingsFile,
      claudeRunSettings(o.permission, o.nativeOff, o.pluginIds, o.nativeItems, o.platform),
    ),
    '--permission-mode',
    PERMISSION_MODE[o.permission][o.ask ? 'ask' : 'deny'],
    ...(o.ask ? ['--permission-prompt-tool', 'stdio'] : []),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...optional.flatMap((f) => OPTIONAL_FLAGS[f]),
    ...(o.sessionId ? ['--resume', o.sessionId] : ['--session-id', o.newSessionId!]),
  ];
}

/** Text of a `tool_result` block's content (a string or text blocks). */
function resultText(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
      : '';
}

const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed']);

/** Claude Code's to-do list (the TodoWrite tool) as plan entries. */
function todoEntries(input: any): PlanEntry[] | undefined {
  if (!Array.isArray(input?.todos)) return undefined;
  return input.todos.map((todo: any) => ({
    text: String(todo?.content ?? todo?.activeForm ?? ''),
    status: PLAN_STATUS.has(todo?.status) ? todo.status : 'pending',
  }));
}

/** What to show the user for a `can_use_tool` request. */
export function claudeApprovalRequest(
  tool: string,
  input: Record<string, any> = {},
  description?: string,
  /** Allowing it runs the command outside Claude Code's sandbox (`claudeOutsideSandbox`). */
  outsideSandbox = false,
): ApprovalRequest {
  const reason = (typeof input.description === 'string' && input.description) || description || undefined;
  // A command in the sandbox wants to reach a host: allowing it lets the sandbox connect there.
  if (tool === 'SandboxNetworkAccess') return { kind: 'fetch', detail: String(input.host ?? ''), reason: t().sandboxHost };
  if (tool === 'Bash') {
    return { kind: 'command', detail: String(input.command ?? ''), reason, ...(outsideSandbox ? { outsideSandbox: true } : {}) };
  }
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) {
    return { kind: 'edit', detail: String(input.file_path ?? input.notebook_path ?? ''), reason };
  }
  if (tool === 'WebFetch') return { kind: 'fetch', detail: String(input.url ?? ''), reason };
  return { kind: 'other', tool, detail: summarizeInput(input), reason };
}

/**
 * The folders Claude Code's sandbox lets a turn's commands write in: the working directory, the
 * folder it may also use (`--add-dir`, the attachments) and the temp folder, each also by its real
 * path (macOS's /tmp is /private/tmp). Undefined when the turn has no sandbox.
 */
export function claudeSandboxWrites(permission: Permission, dirs: (string | undefined)[]): string[] | undefined {
  if (!claudeSandboxSettings(permission)) return undefined;
  const real = (dir: string) => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  };
  return [...new Set([...dirs, tmpdir()].filter((d): d is string => Boolean(d)).flatMap((d) => [d, real(d)]))];
}

/**
 * Whether allowing a `can_use_tool` request runs a command outside the sandbox: the model asked to
 * (`dangerouslyDisableSandbox`), or Claude Code asks because of a path (`blocked_path`) the sandbox
 * would not let it write, so that it would fail there even once allowed. A path in the folders it
 * may write (a file in the working directory in read-only mode, say) runs in the sandbox.
 */
export function claudeOutsideSandbox(request: Record<string, any>, writes: readonly string[] | undefined): boolean {
  if (!writes || request.tool_name !== 'Bash') return false;
  if (request.input?.dangerouslyDisableSandbox === true) return true;
  const path = request.blocked_path;
  if (typeof path !== 'string' || !path) return false;
  return !writes.some((dir) => {
    const rel = relative(dir, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/**
 * The input an allowed request runs with: a command that would fail in the sandbox runs outside
 * it, as the user allowed (like Codex's approvals).
 */
export function claudeAllowedInput(request: Record<string, any>, outsideSandbox: boolean): Record<string, any> {
  const input = (request.input ?? {}) as Record<string, any>;
  if (!outsideSandbox || request.tool_name !== 'Bash' || input.dangerouslyDisableSandbox === true) return input;
  return { ...input, dangerouslyDisableSandbox: true };
}

const DECLINED = 'The user declined this.';

/** The message Claude gets when the user declines (shown to the user localized instead). */
function declinedMessage(note?: string): string {
  return `${DECLINED}${note ? ` Their message: ${note}` : ''} Do not retry it; continue without it, or explain in your reply why it is needed.`;
}

/** The user's note when a tool result is our decline message ('' without a note), else undefined. */
function declinedNote(text: string): string | undefined {
  if (!text.startsWith(DECLINED)) return undefined;
  return text.match(/Their message: ([\s\S]*?) Do not retry it;/)?.[1] ?? '';
}

/** A `control_request` Claude Code sends on stdout (e.g. `can_use_tool`). */
export interface ClaudeControlRequest {
  requestId: string;
  subtype: string;
  request: Record<string, any>;
}

/** Parses `claude -p --output-format stream-json --verbose --include-partial-messages`. */
export function createClaudeParser(emit: (e: AgentEvent) => void, onControl?: (req: ClaudeControlRequest) => void) {
  const openTextBlocks = new Set<number>();
  const thinkingBlocks = new Set<number>();
  const streamedMessages = new Set<string>();
  /** Tool calls shown as something else (the to-do list), so their results are not tool rows. */
  const hiddenTools = new Set<string>();
  let result: Record<string, any> | null = null;
  let sessionId: string | undefined;

  function handle(line: string): void {
    const ev = parseJsonLine(line);
    if (!ev) return;
    if (ev.type === 'control_request') {
      onControl?.({ requestId: String(ev.request_id), subtype: String(ev.request?.subtype ?? ''), request: ev.request ?? {} });
      return;
    }
    if (ev.session_id && ev.session_id !== sessionId) {
      sessionId = ev.session_id as string;
      emit({ type: 'session', sessionId });
    }
    // Ignore events produced inside sub-agents; only the main agent's turn goes to the chat.
    if (ev.parent_tool_use_id) return;

    switch (ev.type) {
      case 'stream_event': {
        const e = ev.event ?? {};
        if (e.type === 'message_start' && e.message?.id) streamedMessages.add(e.message.id);
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') openTextBlocks.add(e.index);
        if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') thinkingBlocks.add(e.index);
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          emit({ type: 'text', text: e.delta.text });
        }
        if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && e.delta.thinking) {
          emit({ type: 'thinking', text: e.delta.thinking });
        }
        if (e.type === 'content_block_stop') {
          if (openTextBlocks.delete(e.index)) emit({ type: 'text_end' });
          thinkingBlocks.delete(e.index);
        }
        break;
      }
      case 'assistant': {
        const msg = ev.message ?? {};
        const streamed = msg.id && streamedMessages.has(msg.id);
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (block.type === 'tool_use') {
            const todos = block.name === 'TodoWrite' ? todoEntries(block.input) : undefined;
            if (todos) {
              hiddenTools.add(block.id);
              emit({ type: 'plan', entries: todos });
            } else {
              emit({ type: 'tool_start', id: block.id, name: block.name, detail: summarizeInput(block.input) });
            }
          } else if (!streamed && block.type === 'thinking' && block.thinking) {
            emit({ type: 'thinking', text: block.thinking });
          } else if (!streamed && block.type === 'text' && block.text) {
            // Fallback when partial messages were not streamed.
            emit({ type: 'text', text: block.text });
            emit({ type: 'text_end' });
          }
        }
        break;
      }
      case 'user': {
        const content = ev.message?.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block.type !== 'tool_result' || hiddenTools.has(block.tool_use_id)) continue;
          const text = resultText(block.content).trim();
          const declined = block.is_error ? declinedNote(text) : undefined;
          const extra = !text
            ? {}
            : declined !== undefined
              ? { error: declined ? `${t().approvalDeclined} ${declined}` : t().approvalDeclined }
              : block.is_error
                ? { error: clip(text, 240) }
                : { output: tailText(text) };
          emit({ type: 'tool_end', id: block.tool_use_id, ok: !block.is_error, ...extra });
        }
        break;
      }
      case 'result':
        result = ev;
        break;
    }
  }

  return {
    handle,
    get result() {
      return result;
    },
    get sessionId() {
      return sessionId;
    },
  };
}

export const claudeRunner: AgentRunner = {
  provider: 'claude',
  async run(o): Promise<RunResult> {
    // The servers' tokens go in a private file for this turn, not on the command line (which `ps` shows).
    const mcp = o.mcpServers?.length ? privateTempFile('mcp.json', JSON.stringify(claudeMcpConfig(o.mcpServers))) : undefined;
    try {
      // An older Claude Code that rejects an optional flag: remember that and run again without it.
      for (;;) {
        try {
          return await runClaude(o, mcp?.file);
        } catch (err) {
          if (!(err instanceof UnsupportedFlag)) throw err;
          unsupported.add(err.flag);
        }
      }
    } finally {
      mcp?.remove();
    }
  },
};

class UnsupportedFlag extends Error {
  constructor(readonly flag: OptionalFlag) {
    super(`unsupported flag ${OPTIONAL_FLAGS[flag][0]}`);
  }
}

/** The optional flag an "unknown option" error is about, if it is one we can drop. */
function rejectedFlag(stderr: string): OptionalFlag | undefined {
  return (Object.keys(OPTIONAL_FLAGS) as OptionalFlag[]).find(
    (f) => !unsupported.has(f) && new RegExp(`unknown option.*${OPTIONAL_FLAGS[f][0]}`, 'i').test(stderr),
  );
}

/**
 * The ids of the installed plugins, to turn each off for a run that leaves plugins out. When Claude
 * Code cannot list them the run fails with a message that says so: going on would quietly load
 * the plugins the user turned off.
 */
async function pluginIdsForRun(o: Parameters<AgentRunner['run']>[0]): Promise<string[]> {
  if (!o.nativeOff?.includes('plugins')) return [];
  try {
    return (await claudePlugins(o.bin, o.env, o.cwd, o.signal)).map((p) => p.id);
  } catch (err) {
    if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
    throw new AgentRunError(t().claudePluginsFailed(err instanceof Error ? err.message : String(err)));
  }
}

async function runClaude(o: Parameters<AgentRunner['run']>[0], mcpConfig?: string): Promise<RunResult> {
  const pluginIds = await pluginIdsForRun(o);
  const nativeItems = claudeItemsBesideLibrary(o.nativeItems ?? {}, o.mcpServers ?? []);
  const settings = claudeSettingsFile(claudeRunSettings(o.permission, o.nativeOff, pluginIds, nativeItems));
  try {
    return await runClaudeTurn(o, { mcpConfig, pluginIds, nativeItems, settingsFile: settings?.file });
  } finally {
    settings?.remove();
  }
}

async function runClaudeTurn(
  o: Parameters<AgentRunner['run']>[0],
  run: { mcpConfig?: string; pluginIds: string[]; nativeItems: NativeItemsOff; settingsFile?: string },
): Promise<RunResult> {
  const newSessionId = o.sessionId ? undefined : randomUUID();
  const ask = Boolean(o.requestApproval) && o.permission !== 'full';
  const sandboxed = Boolean(claudeSandboxSettings(o.permission));
  const writes = claudeSandboxWrites(o.permission, [o.cwd, o.attachmentsDir]);
  const args = claudeArgs({
    systemPrompt: o.systemPrompt,
    permission: o.permission,
    ask,
    model: o.model,
    effort: o.effort,
    sessionId: o.sessionId,
    newSessionId,
    attachmentsDir: o.attachmentsDir,
    readDirs: o.readDirs,
    mcpConfig: run.mcpConfig,
    nativeOff: o.nativeOff,
    nativeItems: run.nativeItems,
    pluginIds: run.pluginIds,
    settingsFile: run.settingsFile,
    skip: unsupported,
  });

  let child: ChildProcess | undefined;
  const send = (msg: unknown) => {
    if (child?.stdin?.writable) child.stdin.write(JSON.stringify(msg) + '\n');
  };
  const respond = (requestId: string, response: unknown) =>
    send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

  const onControl = (req: ClaudeControlRequest) => {
    if (req.subtype !== 'can_use_tool') {
      send({ type: 'control_response', response: { subtype: 'error', request_id: req.requestId, error: 'not supported' } });
      return;
    }
    const tool = String(req.request.tool_name ?? '');
    const input = (req.request.input ?? {}) as Record<string, any>;
    const ask = o.requestApproval;
    if (!ask) {
      respond(req.requestId, { behavior: 'deny', message: 'Not allowed in this conversation.' });
      return;
    }
    const outside = claudeOutsideSandbox(req.request, writes);
    void ask(claudeApprovalRequest(tool, input, req.request.description, outside)).then(
      (answer) =>
        respond(
          req.requestId,
          answer.allow
            ? { behavior: 'allow', updatedInput: claudeAllowedInput(req.request, outside) }
            : { behavior: 'deny', message: declinedMessage(answer.note) },
        ),
      () => respond(req.requestId, { behavior: 'deny', message: 'Not allowed.' }),
    );
  };

  const parser = createClaudeParser(o.onEvent, onControl);
  const initId = `init-${randomUUID()}`;
  const sendPrompt = () => send({ type: 'user', message: { role: 'user', content: claudeContent(o.prompt, o.images) } });
  // Our own stop as well as the user's, to end the run when its subagents cannot be left out.
  const stop = new AbortController();
  const relayStop = () => stop.abort();
  if (o.signal.aborted) stop.abort();
  else o.signal.addEventListener('abort', relayStop, { once: true });
  let failure: AgentRunError | undefined;
  // When its own subagents are left out, the prompt waits until they are denied.
  const gate = o.nativeOff?.includes('agents')
    ? claudeAgentsGate({
        initId,
        builtins: (version) => claudeBuiltinAgents(o.bin, o.env, version),
        send,
        start: sendPrompt,
        fail: (detail) => {
          failure ??= new AgentRunError(t().claudeAgentsFailed(detail));
          stop.abort();
        },
      })
    : undefined;
  const res = await runProcess({
    bin: o.bin,
    args,
    cwd: o.cwd,
    env: { ...o.env, ...claudeNativeEnv(o.nativeOff) },
    keepStdinOpen: true,
    onSpawn: (c) => {
      child = c;
      send({ type: 'control_request', request_id: initId, request: { subtype: 'initialize', hooks: null } });
      if (!gate) sendPrompt();
    },
    signal: stop.signal,
    timeoutMs: TURN_TIMEOUT_MS,
    onLine: (line) => {
      if (gate) {
        const msg = parseJsonLine(line);
        if (msg && gate(msg)) return;
      }
      parser.handle(line);
      // One prompt per run: once the turn has its result, let Claude Code exit.
      if (parser.result) child?.stdin?.end();
    },
  }).finally(() => o.signal.removeEventListener('abort', relayStop));
  if (failure && !o.signal.aborted) throw failure;
  if (res.aborted) throw new AgentRunError(t().stopped, true);
  if (res.timedOut) throw new AgentRunError(t().timedOut);

  const r = parser.result;
  const rejected = r ? undefined : rejectedFlag(res.stderr);
  if (rejected) throw new UnsupportedFlag(rejected);
  if (!r) {
    const why = tail(res.stderr || res.stdout);
    // `failIfUnavailable`: Claude Code stops at start when its sandbox cannot run here.
    if (sandboxed && why && /sandbox/i.test(why)) throw new AgentRunError(t().claudeSandbox(why));
    throw new AgentRunError(why || t().exitedWithoutReply('claude', res.code));
  }
  if (r.is_error) {
    const detail = typeof r.result === 'string' && r.result ? r.result : (r.errors ?? []).join('\n') || r.subtype;
    throw new AgentRunError(String(detail || t().claudeError));
  }
  return {
    sessionId: parser.sessionId ?? newSessionId ?? o.sessionId,
    costUsd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : undefined,
    inputTokens: sumInput(r.usage),
    outputTokens: r.usage?.output_tokens,
  };
}

/** The prompt, plus attached images as image blocks. */
export function claudeContent(prompt: string, images: RunOptions['images']): string | unknown[] {
  const blocks: unknown[] = [];
  for (const img of images ?? []) {
    const data = imageData(img.path);
    if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data } });
  }
  return blocks.length ? [{ type: 'text', text: prompt }, ...blocks] : prompt;
}

function withAllowedTools(tools: string[]): string[] {
  return tools.length ? ['--allowedTools', ...tools] : [];
}

function sumInput(u: any): number | undefined {
  if (!u) return undefined;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
