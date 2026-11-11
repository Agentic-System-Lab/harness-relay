import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  API_BACKENDS,
  isApiBackend,
  parseBackendModel,
  type ModelOption,
  type NativeHook,
  type NativeMcpServer,
  type NativeMemoryFile,
  type NativePlugin,
  type NativeSkill,
  type Permission,
  type PlanEntry,
} from '../../shared/types';
import { API_BACKEND_HOST, backendLabel, urlHost, type BackendRun } from '../backends';
import { commandLine, parseCommandLine, parseShellSyntax } from '../commands';
import { t } from '../i18n';
import type { NativeProbe } from '../native';
import { converse } from '../process';
import type { JsonRpcConnection } from './acp';
import {
  acpBriefing,
  acpMcpServers,
  acpUsage,
  acpTurn,
  defaultAcpDeps,
  type AcpAgentSpec,
  type AcpCallInfo,
  type AcpSessionMethod,
  type AcpSessionState,
  type AcpToolCall,
  type AcpTurnDeps,
  type AcpUsageUpdate,
} from './acpTurn';
import { openAgentHome, type OpenAgentDefinition, type OpenCatalog, type OpenHomeLayout, type OpenRunContext, type OpenSandboxNeeds } from './open';
import { AgentRunError, type AgentRunner, type McpServerSpec, type RunOptions, type RunResult } from './types';

/*
 * Goose: `goose` (Homebrew `block-goose-cli`) over ACP, `goose acp` (checked with 1.58.1). What this
 * file does, and why, is in docs/open-agents.md ("Goose"); the investigation behind it found:
 *
 * - Home. `GOOSE_PATH_ROOT` moves its config, data, state and `.agents` folder, but Goose still finds
 *   skills and recipes through `$HOME` (`~/.agents/skills`, `~/.claude/skills`, `~/.config/agents/skills`,
 *   `~/.goose/recipes`), so both point at the run's state folder (the conversation member's own: its
 *   sessions are no other member's or conversation's; its config there is written each run, read-only).
 *   Its shell commands get the user's own `HOME` back
 *   through a small wrapper (`GOOSE_SHELL`), so git, rustup, nvm and the like keep working.
 * - Everything a run decides goes in variables (Goose reads a variable before `config.yaml` for every
 *   key, and reads `config.yaml` again on each access, so a file shared by parallel runs would race):
 *   provider, model, mode, extensions (`EXTENSIONS`), plugins (`PLUGINS`), instruction files
 *   (`CONTEXT_FILE_NAMES`). Variables the server inherited that would change what it does are taken out.
 * - Keyring and telemetry off (`GOOSE_DISABLE_KEYRING`: any value), session naming off (an extra model
 *   call per new session).
 * - Its loaded session keeps the provider, model, effort and mode it had: they are set again after every
 *   `session/load`, provider first (setting it resets the model), then model, effort and mode.
 * - Read-only and edit run in `approve` mode, where Goose asks about every tool call; full access in
 *   `auto`. Only `allow_once` / `reject_once` are ever answered: the "always" options write
 *   `permission.yaml`, and with its folder read-only (the relay sandbox) Goose panics and the turn hangs.
 *   `smart_approve` writes that file on every model call, so it is never used.
 * - A refusal's reason does not ride on the answer (Goose ignores `_meta.followup_message`): it goes to
 *   the model with `_goose/unstable/session/steer` right after, as a user message of the running turn.
 * - The briefing goes through `_goose/unstable/session/system-prompt/set` (append, key `harness-relay`).
 * - Tool calls come without a `kind` and permission requests with `kind: "other"`; what a call is comes
 *   from the tool's name (`_meta.goose.toolCall.toolName`, or the title's first part).
 * - Goose has no tool that reads a file: it reads with `shell`. In read-only, plain reading commands
 *   (`cat`, `ls`, `rg`… without redirection or substitution) count as reading.
 * - The cost Goose reports is the session's total: a turn's cost is what it added.
 */

/** The goose provider id of a Harness Relay endpoint (kept apart from Goose's own providers, such as `ollama`). */
export function gooseEndpointProvider(endpointId: string): string {
  return `relay-${endpointId}`;
}

/** The goose provider of a run: `openai`, `anthropic`, `xai`, or the endpoint's own. */
export function gooseProvider(run: Pick<BackendRun, 'kind' | 'backend'>): string {
  return run.kind === 'endpoint' ? gooseEndpointProvider(run.backend) : run.backend;
}

/** The variable an endpoint's key is handed to Goose in (its provider file names it; the key never goes in a file). */
export function gooseEndpointKeyVar(endpointId: string): string {
  return `HARNESS_RELAY_ENDPOINT_${endpointId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/**
 * Goose's files: `GOOSE_PATH_ROOT` and `HOME` both point at `state`, the run's state folder (the
 * conversation member's own), since `GOOSE_PATH_ROOT` moves its config, data and state together; its
 * config there is written by Harness Relay before each run and read-only. Only the shell wrapper, the
 * same for every run, is in the shared home `root`. Outside a run `state` is Harness Relay's own.
 */
export function gooseHome(root: string, state = root): OpenHomeLayout {
  return {
    env: {
      HOME: state,
      GOOSE_PATH_ROOT: state,
      // Any value turns the keyring off; secrets come from the environment anyway.
      GOOSE_DISABLE_KEYRING: '1',
      GOOSE_TELEMETRY_OFF: '1',
      GOOSE_DISABLE_SESSION_NAMING: 'true',
    },
    // Sessions (SQLite), the model catalog cache, its apps; logs and full request logs.
    statePaths: [join(state, 'data'), join(state, 'state')],
    configPaths: [
      // config.yaml, permission.yaml, secrets.yaml, custom_providers/, .goosehints, AGENTS.md, skills/, recipes/, adversary.md
      join(state, 'config'),
      // The shell wrapper (GOOSE_SHELL).
      join(root, 'bin'),
      // plugins/ (hooks, MCP servers, skills), agents/, skills/, AGENTS.md, recipes/
      join(state, '.agents'),
      // .config/goose/settings.json (which plugins), .config/agents/skills
      join(state, '.config'),
      join(state, '.claude'),
      join(state, '.goose'),
    ],
  };
}

// --- What the relay sandbox needs for Goose ---------------------------------------------------
//
// Besides `gooseHome()` (statePaths writable, configPaths read-only) and the run's backend host,
// `gooseSandbox()` asks the relay sandbox for these opt-ins only (docs/sandboxing.md, "Harness Relay's
// own sandbox"; docs/open-agents.md, "Goose"):
// - `allowTlsTrustd` (macOS) when the run talks HTTPS: Goose checks TLS certificates through the
//   system (rustls-platform-verifier → Security framework → `com.apple.trustd.agent`), which the
//   sandbox blocks by default; every HTTPS request then fails with "invalid peer certificate:
//   OSStatus -26276" ("Network error: Could not connect"). No variable avoids it (`GOOSE_CA_CERT_PATH`
//   and `SSL_CERT_FILE` still go through the platform verifier: checked with 1.58.1). A plain-HTTP
//   endpoint and plain-HTTP MCP servers need none.
// - `quietlyDeniedHosts`: what Goose fetches by itself, and does without when refused.
// - `connectPorts`: the ports of the tool library's HTTP MCP servers on this computer, which Goose reaches
//   through the proxy (connect only: the sandbox may not listen on them, so no command can take over the
//   port of a server that is down).
// No pseudo-terminal, no Unix sockets.

/** Hosts Goose reaches by itself and does without when refused: denied quietly, never asked about. */
export const GOOSE_QUIET_HOSTS = [
  'models.dev', // its model catalog, fetched at every start (no switch turns it off)
  'api.osv.dev', // a malware check before an npx / uvx MCP server starts (it fails open)
  'us.i.posthog.com', // telemetry (off anyway)
];

/** Loopback hosts, as a URL names them. */
function isLoopbackName(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || h.endsWith('.localhost');
}

/** The ports of the tool library's HTTP MCP servers on this computer. */
export function gooseLocalMcpPorts(servers: readonly McpServerSpec[] = []): number[] {
  const ports = new Set<number>();
  for (const s of servers) {
    if (s.transport !== 'http') continue;
    try {
      const u = new URL(s.url);
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      if (isLoopbackName(u.hostname) && port >= 1 && port <= 65535) ports.add(port);
    } catch {
      // not a URL: Goose cannot reach it either
    }
  }
  return [...ports];
}

/** Whether the run talks HTTPS: its backend, or one of the tool library's HTTP MCP servers. */
export function gooseUsesHttps(run: Pick<BackendRun, 'kind' | 'endpoint'>, servers: readonly McpServerSpec[] = []): boolean {
  if (run.kind !== 'endpoint' || /^https:/i.test(run.endpoint?.baseUrl ?? '')) return true;
  return servers.some((s) => s.transport === 'http' && /^https:/i.test(s.url));
}

/** What Goose needs from the relay sandbox for one run (below full access). */
export function gooseSandbox(ctx: Pick<OpenRunContext, 'run' | 'o'>): OpenSandboxNeeds {
  const ports = gooseLocalMcpPorts(ctx.o.mcpServers);
  return {
    quietlyDeniedHosts: [...GOOSE_QUIET_HOSTS],
    ...(gooseUsesHttps(ctx.run, ctx.o.mcpServers) ? { allowTlsTrustd: true } : {}),
    ...(ports.length ? { connectPorts: ports } : {}),
  };
}

// --- Per-run settings ------------------------------------------------------------------------

/** The session mode for each permission: `approve` asks about every tool call; `auto` asks about none. */
export function gooseMode(permission: Permission): 'approve' | 'auto' {
  return permission === 'full' ? 'auto' : 'approve';
}

/** Goose's thinking-effort levels (`thinking_effort`); a provider may offer fewer (a custom endpoint: `off`). */
export const GOOSE_EFFORTS = ['off', 'low', 'medium', 'high', 'max'];

/** Goose's own instruction files, read from the working directory up to the repository root. */
export const GOOSE_HINT_FILES = ['.goosehints', 'AGENTS.md'];

/**
 * The platform extensions a run has besides `developer` (which `goose acp` always starts): `analyze`
 * (code structure), `summon` (`load`, `delegate`: subagents, whose tool calls are asked about like
 * the agent's own) and `todo` (its notes, shown as the plan). Left out: `apps` (writes HTML apps),
 * `extensionmanager` (would let the model turn on other extensions, such as computer control),
 * `scheduler`, `tom`, `chatrecall`, `summarize`, `code_execution`.
 */
export const GOOSE_PLATFORM_EXTENSIONS = ['analyze', 'summon', 'todo'];

/** `EXTENSIONS` for a run (Goose takes a config key's value from its upper-case variable, as JSON). */
export function gooseExtensionsEnv(): string {
  const entries = Object.fromEntries(
    GOOSE_PLATFORM_EXTENSIONS.map((name) => [name, { enabled: true, type: 'platform', name, description: '', bundled: true }]),
  );
  return JSON.stringify(entries);
}

/** One plugin folder Goose would load: a project's (`<cwd>/.agents/plugins/<name>`) or its home's. */
export interface GoosePluginDir {
  name: string;
  root: string;
  scope: 'project' | 'user';
}

/** The plugin folders Goose finds for `cwd` (each child folder of `.agents/plugins`), the project's first. */
export function goosePluginDirs(cwd: string, home: string): GoosePluginDir[] {
  const list = (dir: string, scope: GoosePluginDir['scope']): GoosePluginDir[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, root: join(dir, e.name), scope }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  };
  const project = join(cwd, '.agents', 'plugins');
  const user = join(home, '.agents', 'plugins');
  return [...(project === user ? [] : list(project, 'project')), ...list(user, 'user')];
}

/**
 * `PLUGINS` for a run: every plugin folder Goose would find, on or off (all off when the run leaves
 * plugins out, or one by its folder). Listing them all also keeps Goose from writing new ones into
 * `config.yaml`, which it does for a plugin it has not seen.
 */
export function goosePluginsEnv(plugins: readonly GoosePluginDir[], o: Pick<RunOptions, 'nativeOff' | 'nativeItems'>): string {
  const allOff = o.nativeOff?.includes('plugins') ?? false;
  const off = new Set(o.nativeItems?.plugins ?? []);
  return JSON.stringify(Object.fromEntries(plugins.map((p) => [p.root, { enabled: !allOff && !off.has(p.root) }])));
}

/**
 * Variables the server may have inherited that would change what Goose does, besides every `GOOSE_*`
 * one: config keys it reads from the environment first, and providers' addresses.
 */
export const GOOSE_INHERITED_VARS = [
  'EXTENSIONS',
  'PLUGINS',
  'CONTEXT_FILE_NAMES',
  'OPENAI_HOST',
  'OPENAI_BASE_PATH',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'OPENAI_CUSTOM_HEADERS',
  'OPENAI_TIMEOUT',
  'ANTHROPIC_HOST',
  'ANTHROPIC_TIMEOUT',
  'XAI_HOST',
  'SECURITY_PROMPT_ENABLED',
];

/**
 * Prefixes of inherited variables Goose would send its traces with: OpenTelemetry (`OTEL_EXPORTER_OTLP_*`,
 * `OTEL_*_EXPORTER`, `OTEL_SERVICE_NAME`…) and Langfuse (`LANGFUSE_*`), each a way out for the turn's
 * prompts and replies.
 */
export const GOOSE_TRACING_PREFIXES = ['OTEL_', 'LANGFUSE_'];

/** Takes out what the server inherited that would change what Goose does (not the home's own variables). */
export function cleanGooseEnv(env: NodeJS.ProcessEnv, keep: Record<string, string>): void {
  for (const name of Object.keys(env)) {
    if (name in keep) continue;
    if (name.startsWith('GOOSE_') || GOOSE_INHERITED_VARS.includes(name) || GOOSE_TRACING_PREFIXES.some((p) => name.startsWith(p))) delete env[name];
  }
}

/** A custom endpoint as a Goose provider file (`config/custom_providers/<provider>.json`). */
export function gooseEndpointFile(endpoint: { id: string; name: string; baseUrl: string; models: string[]; apiKey?: string }, extraModel?: string): Record<string, unknown> {
  const models = [...new Set([...endpoint.models, ...(extraModel ? [extraModel] : [])].filter(Boolean))];
  return {
    name: gooseEndpointProvider(endpoint.id),
    engine: 'openai',
    display_name: endpoint.name || endpoint.id,
    description: 'Written by Harness Relay before each run; changes here are replaced.',
    api_key_env: endpoint.apiKey ? gooseEndpointKeyVar(endpoint.id) : '',
    requires_auth: Boolean(endpoint.apiKey),
    base_url: endpoint.baseUrl,
    models: models.map((name) => ({ name })),
    supports_streaming: true,
    // Its typed models, without asking the endpoint for its list (Goose asks when the list is empty).
    ...(models.length ? { dynamic_models: false } : {}),
  };
}

/** `config.yaml`: only what never differs between runs (the rest is in variables). */
export const GOOSE_CONFIG_YAML = [
  '# Written by Harness Relay before each run; changes here are replaced.',
  '# What a run decides (provider, model, mode, extensions, plugins) is in its environment instead.',
  'GOOSE_TELEMETRY_ENABLED: false',
  'GOOSE_DISABLE_KEYRING: true',
  'GOOSE_DISABLE_SESSION_NAMING: true',
  '',
].join('\n');

/** `permission.yaml` with no rules: in `approve` mode every tool call then comes to Harness Relay. */
export const GOOSE_PERMISSION_YAML = ['user:', '  always_allow: []', '  ask_before: []', '  never_allow: []', ''].join('\n');

/**
 * The shell Goose's `shell` tool runs commands with: the user's own `HOME` back, then bash. Fixed text
 * (AGENTS.md: no path in a shell's text): the home and the bash it runs come in its environment
 * (`gooseShellEnv`), and are taken out before bash starts.
 */
export const GOOSE_SHELL_WRAPPER = String.raw`#!/bin/sh
# Written by Harness Relay: Goose runs with a home of its own; its commands get the user's back.
HOME=$HARNESS_RELAY_USER_HOME
export HOME
b=$HARNESS_RELAY_GOOSE_BASH
[ -n "$b" ] || b=/bin/sh
unset HARNESS_RELAY_USER_HOME HARNESS_RELAY_GOOSE_BASH
exec "$b" "$@"
`;

/** What `GOOSE_SHELL_WRAPPER` reads: the user's real home and the bash it runs. */
export function gooseShellEnv(realHome: string, bash: string): Record<string, string> {
  return { HARNESS_RELAY_USER_HOME: realHome, HARNESS_RELAY_GOOSE_BASH: bash };
}

/** bash on PATH (as Goose would pick it), else /bin/sh. */
export function findBash(path = process.env.PATH ?? ''): string {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'bash');
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return '/bin/sh';
}

/** Writes `content` at `path` unless it is there already: beside it, then renamed into place (parallel runs read old or new). */
function writeIfChanged(path: string, content: string, mode = 0o600): void {
  try {
    if (!lstatSync(path).isSymbolicLink() && readFileSync(path, 'utf8') === content) return;
  } catch {
    // not there yet
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.relay-${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, content, { mode, flag: 'wx' });
  try {
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Makes `path` and everything in it removable (a run may have taken write permission off), not following links. */
function unlock(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) unlock(join(path, name));
}

/**
 * Makes `dir` a folder of its own (not a link) holding only the entries named in `keep`: anything else
 * an earlier run left there (a plugin, a skill, a recipe, a hints file…) is removed, so that a run
 * with full access cannot plant what a later read-only run of the same member then loads.
 */
export function resetGooseDir(dir: string, keep: readonly string[] = []): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    st = undefined;
  }
  if (st && (!st.isDirectory() || st.isSymbolicLink())) rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    if (keep.includes(name)) continue;
    unlock(join(dir, name));
    chmodSync(dir, 0o700);
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

/** What `prepare` needs besides the run (swapped in tests). */
export interface GoosePrepareDeps {
  /** The user's own home, for the commands Goose runs. */
  realHome: string;
  bash: string;
}

/**
 * Writes Goose's files in its home and its variables for one run: its config (`config.yaml`, an empty
 * `permission.yaml`, no `secrets.yaml`), each endpoint as a provider file, the shell wrapper; then the
 * provider, model, mode, extensions, plugins and instruction files in `ctx.env`.
 */
export function prepareGoose(ctx: OpenRunContext, deps: GoosePrepareDeps = { realHome: homedir(), bash: findBash(ctx.env.PATH) }): void {
  const { o, run, home, env } = ctx;
  const root = home.root;
  // GOOSE_PATH_ROOT and HOME: the conversation member's own folder.
  const own = home.state;
  for (const dir of home.statePaths) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Its config folders hold only what Harness Relay writes in them, every run (a run with full access
  // may have left anything there; a sandboxed one cannot write them).
  const config = join(own, 'config');
  const wanted = run.backends.endpoints.map((e) => `${gooseEndpointProvider(e.id)}.json`);
  resetGooseDir(config, ['config.yaml', 'permission.yaml', 'custom_providers']);
  const providers = join(config, 'custom_providers');
  resetGooseDir(providers, wanted);
  for (const dir of home.configPaths) if (dir !== config && dir !== join(root, 'bin')) resetGooseDir(dir);
  resetGooseDir(join(root, 'bin'), ['bash']);
  writeIfChanged(join(config, 'config.yaml'), GOOSE_CONFIG_YAML);
  writeIfChanged(join(config, 'permission.yaml'), GOOSE_PERMISSION_YAML);
  // Every endpoint as a provider (the same file for every run, so parallel runs agree).
  for (const e of run.backends.endpoints) writeIfChanged(join(providers, `${gooseEndpointProvider(e.id)}.json`), JSON.stringify(gooseEndpointFile(e), null, 2) + '\n');

  const shell = join(root, 'bin', 'bash');
  writeIfChanged(shell, GOOSE_SHELL_WRAPPER, 0o700);
  // The tool library's MCP servers get the user's HOME too (gooseMcpServers).
  ctx.state.realHome = deps.realHome;

  cleanGooseEnv(env, home.env);
  Object.assign(env, home.env, {
    GOOSE_PROVIDER: gooseProvider(run),
    GOOSE_MODEL: run.model,
    GOOSE_MODE: gooseMode(o.permission),
    GOOSE_SHELL: shell,
    ...gooseShellEnv(deps.realHome, deps.bash),
    EXTENSIONS: gooseExtensionsEnv(),
    PLUGINS: goosePluginsEnv(goosePluginDirs(o.cwd, own), o),
    CONTEXT_FILE_NAMES: JSON.stringify(o.nativeOff?.includes('instructions') ? [] : GOOSE_HINT_FILES),
  });
  if (run.endpoint?.apiKey) env[gooseEndpointKeyVar(run.endpoint.id)] = run.endpoint.apiKey;
}

// --- The session ------------------------------------------------------------------------------

/** Said with the briefing: how Harness Relay shows Goose's todo notes. */
export const GOOSE_TODO_NOTE =
  'When you keep notes with your todo tool, Harness Relay shows them to the user as a checklist: in those notes, ' +
  'write each step as "- [ ] step", the one you are on as "- [~] step" and finished ones as "- [x] step".';

/** The text Goose's system prompt gets for the run: the briefing, and how the todo notes are shown. */
export function gooseBriefing(o: Pick<RunOptions, 'systemPrompt' | 'permission'>): string {
  const brief = acpBriefing(o, gooseAcp);
  return brief ? `${brief}\n\n${GOOSE_TODO_NOTE}` : GOOSE_TODO_NOTE;
}

/** What a session's config options say now (`currentValue` by id). */
function optionValue(options: AcpSessionState['configOptions'], id: string): unknown {
  return options?.find((c) => c?.id === id)?.currentValue;
}

/** The values an option offers, when it lists them. */
function optionValues(options: AcpSessionState['configOptions'], id: string): string[] | undefined {
  const o = options?.find((c) => c?.id === id) as { options?: { value?: unknown }[] } | undefined;
  return Array.isArray(o?.options) ? o.options.map((x) => String(x?.value)) : undefined;
}

/**
 * Once the session is there: the briefing, then the provider, model, effort and mode, in that order
 * (a loaded session keeps its own; setting the provider resets the model to the provider's default).
 */
export async function gooseAfterSession(
  conn: JsonRpcConnection,
  session: { sessionId: string; state: AcpSessionState; method: AcpSessionMethod },
  ctx: OpenRunContext,
): Promise<void> {
  const { sessionId, state } = session;
  const { o, run } = ctx;
  const cli = 'Goose';
  ctx.state.method = session.method;
  ctx.state.sessionId = sessionId;
  // Always, so that a loaded session's earlier briefing is replaced (empty text would clear it).
  await conn.request('_goose/unstable/session/system-prompt/set', { sessionId, mode: 'append', key: 'harness-relay', text: gooseBriefing(o) });

  let options = state.configOptions ?? [];
  const set = async (configId: string, value: string, rejected: (v: string, e: string) => string) => {
    const r = (await conn.request('session/set_config_option', { sessionId, configId, value }).catch((err: Error) => {
      throw new AgentRunError(rejected(value, err.message));
    })) as AcpSessionState | undefined;
    if (Array.isArray(r?.configOptions)) options = r.configOptions;
  };
  const provider = gooseProvider(run);
  if (optionValue(options, 'provider') !== provider) await set('provider', provider, (v, e) => t().openRejectedModel(cli, run.id, `${v}: ${e}`));
  if (optionValue(options, 'model') !== run.model) await set('model', run.model, (_v, e) => t().openRejectedModel(cli, run.id, e));
  if (o.effort && optionValue(options, 'thinking_effort') !== o.effort) {
    const offered = optionValues(options, 'thinking_effort');
    // A provider that has no such level (a custom endpoint offers only `off`) runs with its own.
    if (!offered || offered.includes(o.effort)) await set('thinking_effort', o.effort, (v, e) => t().openRejectedEffort(cli, v, e));
  }
  const mode = gooseMode(o.permission);
  const current = state.modes?.currentModeId ?? optionValue(options, 'mode');
  if (current !== mode || optionValue(options, 'mode') !== mode) {
    await conn.request('session/set_mode', { sessionId, modeId: mode }).catch((err: Error) => {
      throw new AgentRunError(t().openRejectedMode(cli, mode, err.message));
    });
  }
}

/**
 * Fields of `session/new` and `session/load`. Leaving out the MCP servers Goose loads by itself
 * (its plugins') takes the session's whole extension list (`_meta.enabledExtensions`, which then
 * replaces `mcpServers` too); a loaded session keeps the list it started with. `replayTail` keeps
 * `session/load` from replaying more than the last turn (its replay is not shown anyway).
 */
export function gooseSessionParams(ctx: OpenRunContext, method: AcpSessionMethod): Record<string, unknown> {
  const mcpServers = gooseMcpServers(ctx);
  if (method !== 'new') return { mcpServers, _meta: { replayTail: 1 } };
  if (!ctx.o.nativeOff?.includes('mcp')) return { mcpServers };
  const servers = mcpServers as Record<string, unknown>[];
  return {
    mcpServers,
    _meta: {
      enabledExtensions: [
        { type: 'platform', name: 'developer' },
        ...GOOSE_PLATFORM_EXTENSIONS.map((name) => ({ type: 'platform', name })),
        ...servers.map((server) => ({ type: 'mcp', server, env_keys: [], scopes: [] })),
      ],
    },
  };
}

/**
 * The tool library's MCP servers for Goose (HTTP ones too: it takes them). A stdio server runs with
 * Goose's environment, whose `HOME` is the member's state folder: it gets the user's own `HOME` back,
 * as the shell does, and in the relay sandbox, where neither home is writable, the caches `npx`, `uvx`
 * and the like write go in the run's temp folder. What the tool library sets for a server wins.
 */
export function gooseMcpServers(ctx: Pick<OpenRunContext, 'o' | 'sandboxed' | 'tmpDir' | 'state'>): unknown[] {
  const home = typeof ctx.state.realHome === 'string' ? ctx.state.realHome : homedir();
  const caches = join(ctx.tmpDir, 'mcp-cache');
  const extra: Record<string, string> = {
    HOME: home,
    ...(ctx.sandboxed
      ? { npm_config_cache: join(caches, 'npm'), XDG_CACHE_HOME: join(caches, 'xdg'), UV_CACHE_DIR: join(caches, 'uv'), PIP_CACHE_DIR: join(caches, 'pip') }
      : {}),
  };
  const servers = (ctx.o.mcpServers ?? []).map((s) => (s.transport === 'stdio' ? { ...s, env: { ...extra, ...s.env } } : s));
  return acpMcpServers(servers, { mcpCapabilities: { http: true } }, 'goose');
}

/**
 * Hands the reason for a refusal to the model: Goose ignores it on the answer, so it goes as a user
 * message into the running turn (`_goose/unstable/session/steer`), right after the declined call.
 */
export async function gooseAfterRefusal(conn: JsonRpcConnection, refusal: { sessionId: string; reason: string }, ctx: OpenRunContext): Promise<void> {
  const runId = ctx.state.activeRunId;
  if (typeof runId !== 'string' || !runId) {
    console.warn('[goose] no running turn to pass a refusal to');
    return;
  }
  await conn.request('_goose/unstable/session/steer', {
    sessionId: refusal.sessionId,
    expectedRunId: runId,
    prompt: [{ type: 'text', text: `Harness Relay: ${refusal.reason}` }],
  });
}

/** Keeps what the updates say about the run: the running turn's id (for steering), the session's cost so far. */
export function gooseFilterUpdate(params: { sessionId: string; update: Record<string, any> }, ctx: OpenRunContext): Record<string, any> | undefined {
  const u = params.update;
  switch (u?.sessionUpdate) {
    case 'session_info_update':
      if (u._meta?.goose && 'activeRunId' in u._meta.goose) ctx.state.activeRunId = u._meta.goose.activeRunId ?? undefined;
      break;
    case 'usage_update':
      // Before the turn's first output it is still the session's total from before the turn.
      if (typeof u.cost?.amount === 'number' && !ctx.state.output && ctx.state.costBefore === undefined) ctx.state.costBefore = u.cost.amount;
      break;
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
      ctx.state.output = true;
      break;
  }
  return u;
}

/**
 * Where the session's cost so far is kept between turns (Goose reports the session's total): in the
 * shared home, which Harness Relay writes and no sandboxed run may, by the member's state folder and
 * the session, so that the agent cannot change what its turns are said to cost.
 */
export function gooseCostFile(home: Pick<OpenRunContext['home'], 'root' | 'state'>, sessionId: string): string {
  const member = createHash('sha256').update(home.state).digest('hex').slice(0, 16);
  return join(home.root, 'relay-cost', member, sessionId.replace(/[^A-Za-z0-9_.-]/g, '_'));
}

/**
 * Tokens of the turn's last model call (what Goose's answer says) and the turn's cost: Goose's cost
 * is the session's total, so a loaded session's turn costs what it added to the total kept after its
 * previous turn (or, without one, to the total Goose reported before the turn's first output). The
 * new total is kept for the next turn.
 */
export function gooseUsage(result: Record<string, any> | undefined, last: AcpUsageUpdate | undefined, ctx: OpenRunContext): Pick<RunResult, 'costUsd' | 'inputTokens' | 'outputTokens'> {
  const usage = acpUsage(result, last);
  if (usage.costUsd === undefined) return usage;
  const total = usage.costUsd;
  const sessionId = typeof ctx.state.sessionId === 'string' ? ctx.state.sessionId : undefined;
  const file = sessionId ? gooseCostFile(ctx.home, sessionId) : undefined;
  let before: number | undefined = ctx.state.method === 'new' ? 0 : undefined;
  if (before === undefined && file) {
    try {
      const kept = Number(readFileSync(file, 'utf8'));
      if (Number.isFinite(kept)) before = kept;
    } catch {
      // not kept (a session from before Harness Relay kept it)
    }
  }
  if (before === undefined && typeof ctx.state.costBefore === 'number') before = ctx.state.costBefore;
  if (file) {
    try {
      writeIfChanged(file, String(total));
    } catch (err) {
      console.warn('[goose] could not keep the session cost:', (err as Error).message);
    }
  }
  const cost = before === undefined ? undefined : total - before;
  return { ...usage, costUsd: cost !== undefined && cost >= 0 ? Math.round(cost * 1e10) / 1e10 : undefined };
}

// --- Tool calls -----------------------------------------------------------------------------

/**
 * A tool's name as Goose knows it: `shell`, `write`, `edit`, `tree`, `analyze`, `read_image`, `load`,
 * `delegate`, `load_skill`, or `<extension>__<tool>`; from the call's `_meta`, else its title (a
 * subagent's call is only asked about: its title is all there is).
 */
export function gooseToolOf(call: AcpToolCall | undefined): string | undefined {
  const named = call?._meta?.goose?.toolCall?.toolName;
  if (typeof named === 'string' && named) return named;
  const title = typeof call?.title === 'string' ? call.title.split(' · ')[0]!.trim() : '';
  if (!title) return undefined;
  const at = title.indexOf(': ');
  return at > 0 ? `${title.slice(0, at).replace(/ /g, '_')}__${title.slice(at + 2).replace(/ /g, '_')}` : title.replace(/ /g, '_');
}

/** A tool row's name: Goose's tool, `<extension>: <tool>` for an extension's. */
export function gooseToolName(u: Record<string, any>): string {
  const tool = gooseToolOf(u as AcpToolCall);
  if (!tool) return String(u.title || 'tool');
  const at = tool.indexOf('__');
  return at > 0 ? `${tool.slice(0, at)}: ${tool.slice(at + 2)}` : tool;
}

/**
 * The options a reading program may have for its command to count as reading (an allowlist: any
 * other option asks). `flags`: one-letter options without a value, which may be grouped (`-la`);
 * `values`: one-letter options that take one (`-n 5`, `-n5`); `long`: `--name` (also `--name=value`)
 * and `--name=` (`--name=value` or `--name value`); `numeric`: `-20` (head, tail); `any`: every option
 * (programs that have none that writes a file or runs another program). Left out on purpose, among
 * others: `sort -o/--output/--compress-program/-T`, `find -exec/-execdir/-ok/-okdir/-delete/-fprint…/-fls`
 * (find's primaries are listed in FIND_PRIMARIES), `rg --pre/--pre-glob/-z/--search-zip/--hostname-bin`,
 * `tree -o/-R/-H`, `file -C`, `diff -l/--paginate`, `tail -f`. git is not here at all: its read commands
 * can run programs a repository's own config names (`core.fsmonitor`, diff drivers, aliases).
 */
interface ReadOptions {
  flags?: string;
  values?: string;
  long?: string[];
  numeric?: boolean;
  any?: boolean;
}

const GREP: ReadOptions = {
  flags: 'abcEFGHhIiLlnoPqRrsUuVvwxyZz',
  values: 'ABCDdefm',
  long: [
    'extended-regexp', 'fixed-strings', 'basic-regexp', 'perl-regexp', 'ignore-case', 'no-ignore-case', 'invert-match', 'word-regexp',
    'line-regexp', 'count', 'files-with-matches', 'files-without-match', 'line-number', 'no-filename', 'with-filename', 'only-matching',
    'quiet', 'silent', 'recursive', 'dereference-recursive', 'include=', 'exclude=', 'exclude-dir=', 'exclude-from=', 'color', 'colour',
    'max-count=', 'after-context=', 'before-context=', 'context=', 'null', 'null-data', 'text', 'binary-files=', 'regexp=', 'file=',
    'label=', 'line-buffered', 'no-messages', 'devices=', 'directories=', 'byte-offset', 'initial-tab',
  ],
};
const SUMS: ReadOptions = { flags: 'bctwz0', values: 'a', long: ['check', 'quiet', 'status', 'strict', 'tag', 'binary', 'text', 'warn', 'zero', 'algorithm='] };

const READ_PROGRAMS: Record<string, ReadOptions> = {
  cat: { flags: 'AbeEnstTuv', long: ['number', 'number-nonblank', 'show-all', 'show-ends', 'show-tabs', 'show-nonprinting', 'squeeze-blank'] },
  head: { flags: 'qvz', values: 'nc', numeric: true, long: ['lines=', 'bytes=', 'quiet', 'silent', 'verbose', 'zero-terminated'] },
  // Not -f / -F: they follow the file for ever.
  tail: { flags: 'qvrz', values: 'nc', numeric: true, long: ['lines=', 'bytes=', 'quiet', 'silent', 'verbose', 'zero-terminated'] },
  ls: {
    flags: '1@aAbBcCdeFfgGhHiklLmnOopqrRsStTuUvwWxX%,',
    values: 'IDw',
    long: [
      'all', 'almost-all', 'color', 'colour', 'classify', 'directory', 'human-readable', 'si', 'inode', 'recursive', 'reverse', 'size',
      'sort=', 'time=', 'time-style=', 'group-directories-first', 'ignore=', 'hide=', 'format=', 'full-time', 'no-group',
      'numeric-uid-gid', 'dereference', 'indicator-style=', 'width=', 'literal', 'quoting-style=', 'author', 'file-type',
    ],
  },
  pwd: { flags: 'LP' },
  echo: { flags: 'neE' },
  // No option at all: bash's `printf -v NAME` assigns a variable (PATH, IFS, or an array element whose
  // subscript bash evaluates as code).
  printf: {},
  true: { any: true },
  wc: { flags: 'clmwL', long: ['lines', 'words', 'chars', 'bytes', 'max-line-length', 'files0-from='] },
  // Not -C / --compile (writes a compiled magic file), -z / -Z / --uncompress / --uncompress-noreport (run decompression programs).
  file: { flags: 'bcdhiIkLlNnprsv0', values: 'fF', long: ['brief', 'mime', 'mime-type', 'mime-encoding', 'dereference', 'no-dereference', 'keep-going', 'raw', 'special-files'] },
  stat: { flags: 'FLlnqrstx', values: 'fc', long: ['dereference', 'file-system', 'terse', 'format=', 'printf='] },
  du: { flags: 'acdhHkLmPsxgA', values: 'dBt', long: ['all', 'apparent-size', 'bytes', 'human-readable', 'si', 'summarize', 'max-depth=', 'total', 'dereference', 'one-file-system', 'block-size=', 'exclude='] },
  df: { flags: 'ahHiklmPTgn', values: 't', long: ['all', 'human-readable', 'si', 'inodes', 'local', 'portability', 'print-type', 'total', 'output', 'type=', 'block-size='] },
  // Not -o (writes its output to a file), -R (writes a file in each folder with -H), -H.
  tree: { flags: 'adfFgilpsuhDCnNqrtvxJ', values: 'LIP', long: ['noreport', 'dirsfirst', 'gitignore', 'charset=', 'filelimit=', 'du', 'prune', 'sort='] },
  // Not -z / --search-zip (runs decompression programs), --pre / --pre-glob (runs a given program), --hostname-bin.
  rg: {
    flags: 'iIlLnNoqsSuUvwxF.0HhcP',
    values: 'ABCegmtTjfrEMd',
    long: [
      'ignore-case', 'smart-case', 'case-sensitive', 'fixed-strings', 'word-regexp', 'line-regexp', 'invert-match', 'count',
      'count-matches', 'files', 'files-with-matches', 'files-without-match', 'line-number', 'no-line-number', 'column', 'heading',
      'no-heading', 'hidden', 'no-ignore', 'no-ignore-vcs', 'no-ignore-parent', 'follow', 'glob=', 'iglob=', 'type=', 'type-not=',
      'type-list', 'max-count=', 'max-depth=', 'max-filesize=', 'context=', 'after-context=', 'before-context=', 'color=', 'colors=',
      'json', 'vimgrep', 'only-matching', 'replace=', 'sort=', 'sortr=', 'multiline', 'multiline-dotall', 'null', 'null-data', 'trim',
      'stats', 'unrestricted', 'text', 'binary', 'pcre2', 'engine=', 'threads=', 'max-columns=', 'max-columns-preview', 'passthru',
      'no-messages', 'quiet', 'regexp=', 'file=', 'encoding=', 'path-separator=', 'ignore-file=', 'no-config', 'with-filename',
      'no-filename', 'byte-offset', 'crlf', 'one-file-system', 'no-require-git',
    ],
  },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  // Not -o / --output, -T (temporary files elsewhere), --compress-program (runs a program).
  sort: {
    flags: 'bdfgihMnRrsuVcCmz',
    values: 'ktS',
    long: [
      'numeric-sort', 'general-numeric-sort', 'human-numeric-sort', 'month-sort', 'version-sort', 'random-sort', 'reverse', 'unique',
      'ignore-case', 'ignore-leading-blanks', 'dictionary-order', 'ignore-nonprinting', 'stable', 'key=', 'field-separator=', 'check',
      'merge', 'zero-terminated', 'buffer-size=', 'parallel=', 'sort=',
    ],
  },
  cut: { flags: 'snzw', values: 'bcdf', long: ['bytes=', 'characters=', 'delimiter=', 'fields=', 'only-delimited', 'complement', 'output-delimiter=', 'zero-terminated'] },
  nl: { flags: 'p', values: 'bdfhilnsvw' },
  basename: { flags: 'az', values: 's', long: ['multiple', 'suffix=', 'zero'] },
  dirname: { flags: 'z', long: ['zero'] },
  realpath: { flags: 'eLmPqsz', long: ['canonicalize-existing', 'canonicalize-missing', 'logical', 'physical', 'quiet', 'strip', 'no-symlinks', 'relative-to=', 'relative-base=', 'zero'] },
  readlink: { flags: 'efmnqsvz', long: ['canonicalize', 'canonicalize-existing', 'canonicalize-missing', 'no-newline', 'quiet', 'silent', 'verbose', 'zero'] },
  which: { flags: 'as' },
  // Not -l / --paginate (runs pr).
  diff: {
    flags: 'abBcdeEfhHiNnpPqrsStTuwyZ',
    values: 'CUDFIxXSL',
    long: [
      'unified', 'context', 'brief', 'recursive', 'new-file', 'unidirectional-new-file', 'ignore-case', 'ignore-all-space',
      'ignore-space-change', 'ignore-blank-lines', 'ignore-tab-expansion', 'ignore-trailing-space', 'text', 'side-by-side',
      'suppress-common-lines', 'color', 'exclude=', 'exclude-from=', 'label=', 'strip-trailing-cr', 'report-identical-files', 'minimal',
      'speed-large-files', 'normal', 'ifdef=', 'width=', 'tabsize=', 'expand-tabs', 'initial-tab', 'show-c-function',
      'show-function-line=', 'ignore-matching-lines=', 'starting-file=', 'no-dereference',
    ],
  },
  cmp: { flags: 'blsv', values: 'in', long: ['print-bytes', 'quiet', 'silent', 'verbose', 'ignore-initial=', 'bytes='] },
  whoami: {},
  uname: { flags: 'amnoprsvi', long: ['all', 'kernel-name', 'nodename', 'kernel-release', 'kernel-version', 'machine', 'processor', 'operating-system'] },
  id: { flags: 'aGgnPpru', long: ['groups', 'group', 'name', 'real', 'user', 'zero'] },
  column: { flags: 'tx', values: 'cs' },
  // jq has no option that writes a file or runs a program.
  jq: { any: true },
  od: { flags: 'bcCdDeFfHhIiLlOosvXx', values: 'AjNtw' },
  hexdump: { flags: 'bcCdovx', values: 'efns' },
  shasum: { flags: 'bcstUp0', values: 'a', long: ['algorithm=', 'binary', 'check', 'text', 'UNIVERSAL', 'portable', 'status', 'quiet', 'warn', 'strict', 'tag'] },
  sha256sum: SUMS,
  md5sum: SUMS,
  md5: { flags: 'pqrt', values: 's' },
};

/**
 * find's options and primaries that only read (an allowlist), and those of them that take a value (which
 * may start with `-`: `-mtime -5`). Not `-exec`, `-execdir`, `-ok`, `-okdir` (run programs), `-delete`,
 * `-fprint`, `-fprint0`, `-fprintf`, `-fls` (write files).
 */
const FIND_PRIMARIES = new Set([
  '-E', '-H', '-L', '-P', '-X', '-d', '-s', '-x', '-depth', '-follow', '-xdev', '-mount', '-not', '-and', '-or', '-a', '-o', '-true',
  '-false', '-prune', '-print', '-print0', '-ls', '-empty', '-nouser', '-nogroup', '-readable', '-writable', '-executable', '-quit',
]);
const FIND_VALUES = new Set([
  '-f', '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname', '-type', '-xtype',
  '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-Btime', '-Bmin', '-newer', '-anewer',
  '-cnewer', '-perm', '-user', '-group', '-uid', '-gid', '-links', '-inum', '-samefile', '-printf', '-regextype', '-fstype', '-flags',
]);

/** Whether every option of a reading program's arguments is on its allowlist. */
function readOptionsOk(program: string, args: readonly string[]): boolean {
  if (program === 'find') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (!a.startsWith('-') || a === '-') continue;
      if (FIND_VALUES.has(a) || /^-newer[aBcmt]{2}$/.test(a)) i++;
      else if (!FIND_PRIMARIES.has(a)) return false;
    }
    return true;
  }
  const spec = READ_PROGRAMS[program];
  if (!spec) return false;
  if (spec.any) return true;
  const long = new Set((spec.long ?? []).map((l) => l.replace(/=$/, '')));
  const longValue = new Set((spec.long ?? []).filter((l) => l.endsWith('=')).map((l) => l.slice(0, -1)));
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return true; // the rest are operands
    if (!a.startsWith('-') || a === '-') continue;
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0]!;
      if (!long.has(name)) return false;
      if (longValue.has(name) && !a.includes('=')) i++;
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      const ch = a[k]!;
      if (spec.flags?.includes(ch)) continue;
      if (!spec.values?.includes(ch)) return false;
      if (k === a.length - 1) i++; // its value is the next argument
      break;
    }
  }
  return true;
}

/**
 * The line as the shell sees its words, with quoted and escaped text masked (`_`); undefined when the
 * shell would rewrite a word before the program sees it: any `$` or backquote outside single quotes
 * (expansions, `$'…'` and `$"…"` quoting), and outside quotes a glob (`*`, `?`, `[`, so also `[[`), a
 * brace (`{`), a tilde, a comment (`#`), a parenthesis (subshells, `((…))`, functions), or an unclosed quote.
 */
export function shellMask(line: string): string | undefined {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      out += ch === "'" ? ch : '_';
      continue;
    }
    if (ch === '$' || ch === '`') return undefined;
    if (ch === '\\') {
      out += '__';
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      out += ch === '"' ? ch : '_';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    // Globs, braces, tilde, comments; and `(` / `)`: subshells, `(( … ))` arithmetic (which evaluates a
    // variable's value as code), function definitions.
    if ('*?[{~#()'.includes(ch)) return undefined;
    out += ch;
  }
  return quote ? undefined : out;
}

/**
 * A command line that only reads, as bash will run it: no word the shell rewrites (`shellMask`: no
 * expansion, glob, brace, tilde), no redirection or background job; each command begins with a reading
 * program named on its own (not `./cat`, not behind `xargs`, `env`, `nohup`, `eval`, a shell, a
 * variable set for it or on its own, a reserved word), and each of its options is on that program's
 * allowlist (`readOptionsOk`). Read-only runs these without asking (the relay sandbox keeps the folder
 * unwritable anyway); anything else asks.
 */
export function isReadOnlyCommand(line: string): boolean {
  const masked = shellMask(line);
  if (!masked?.trim() || /[<>]/.test(masked) || /(^|[^&])&([^&]|$)/.test(masked)) return false;
  // Every command, as the shell splits them, starts with a reading program's own name.
  const firsts = masked
    .split(/[;&|\n]/)
    .map((segment) => segment.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
  if (!firsts.length || !firsts.every((w) => w === 'find' || Object.hasOwn(READ_PROGRAMS, w))) return false;
  let commands;
  try {
    commands = [...parseCommandLine(line), ...parseShellSyntax(line)]; // every command of both readings
  } catch {
    return false;
  }
  if (!commands.length) return false;
  return commands.every((c) => {
    if (c.privileged.length || c.dynamic || c.exact || c.assignments.length) return false;
    const [program, ...args] = c.args;
    if (!program || !(program === 'find' || Object.hasOwn(READ_PROGRAMS, program))) return false;
    return readOptionsOk(program, args);
  });
}

/** What a Goose tool call is, for the permission's decision and the approval card. */
export function gooseCallInfo(call: AcpToolCall, earlier: AcpToolCall | undefined): Partial<AcpCallInfo> {
  const tool = gooseToolOf(earlier) ?? gooseToolOf(call);
  const input = { ...earlier?.rawInput, ...call.rawInput } as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const path = text(input.path);
  const base = { ...(tool ? { tool } : {}), ...(path ? { path } : {}) };
  switch (tool) {
    case 'shell': {
      const command = commandLine(input.command);
      if (command && isReadOnlyCommand(command)) return { ...base, kind: 'read', command: undefined };
      return { ...base, kind: 'execute', ...(command ? { command } : {}) };
    }
    case 'write':
    case 'edit':
      return { ...base, kind: 'edit' };
    case 'read_image':
      // It also fetches an http(s) URL.
      return path && /^https?:\/\//i.test(path) ? { tool, kind: 'fetch', url: path, path: undefined } : { ...base, kind: 'read' };
    case 'tree':
    case 'analyze':
    case 'load':
    case 'load_skill':
      return { ...base, kind: 'read' };
    case 'delegate': {
      // A subagent's own tool calls are asked about one by one; but a source (a recipe or agent, the
      // project's own among them) starts the extensions it declares, commands included, and `resume`
      // continues a subagent that such a source may have started.
      const source = text(input.source) ?? text(input.resume);
      return source ? { ...base, kind: 'other', path: source, reason: `delegate to ${source}` } : { ...base, kind: 'think' };
    }
    case 'todo__todo_write':
      // The todo tool only keeps notes.
      return { ...base, kind: 'think' };
    default:
      return { ...base, kind: 'other' };
  }
}

/** The todo tool: shown as the plan, not as a row. */
export function gooseHideTool(u: Record<string, any>): boolean {
  return gooseToolOf(u as AcpToolCall) === 'todo__todo_write';
}

/** The plan in the todo tool's notes: their list items (`- [ ]`, `- [~]`, `- [x]`, bullets, numbers). */
export function goosePlan(u: Record<string, any>): PlanEntry[] | undefined {
  const content = u?.rawInput?.content;
  if (typeof content !== 'string') return undefined;
  const entries: PlanEntry[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX~>-])\]\s*)?(.*\S)\s*$/);
    if (!m) continue;
    const mark = m[1];
    entries.push({ text: m[2]!, status: mark === 'x' || mark === 'X' ? 'completed' : mark && mark !== ' ' ? 'in_progress' : 'pending' });
  }
  return entries.length ? entries : undefined;
}

// --- The adapter -------------------------------------------------------------------------------

export const gooseAcp: AcpAgentSpec = {
  provider: 'goose',
  implemented: true,
  args: () => ['acp'],
  home: gooseHome,
  // Rust's reqwest takes the sandbox's HTTP(S)_PROXY as it is.
  proxyEnv: {},
  prepare: (ctx) => prepareGoose(ctx),
  sandbox: gooseSandbox,
  // Set again after every session/load, in Goose's order (`gooseAfterSession`).
  model: { via: 'config' },
  effort: { via: 'config' },
  briefing: 'custom',
  sessionParams: gooseSessionParams,
  afterSession: gooseAfterSession,
  describeCall: (call, earlier) => gooseCallInfo(call, earlier),
  hideTool: gooseHideTool,
  planOf: goosePlan,
  toolName: gooseToolName,
  afterRefusal: gooseAfterRefusal,
  filterUpdate: gooseFilterUpdate,
  usage: gooseUsage,
};

/** A clearer message for what Goose answers a failed turn with (its JSON-RPC error). */
export function gooseError(err: unknown, o: Pick<RunOptions, 'model' | 'backends'>): unknown {
  if (!(err instanceof AgentRunError) || err.aborted) return err;
  const message = err.message.replace(/:\s*\{"reason":"turn_failed"\}\s*$/, '');
  const parsed = parseBackendModel(o.model ?? '');
  const label = parsed && o.backends ? backendLabel(o.backends, parsed.backend) : (parsed?.backend ?? 'the backend');
  // xAI answers a wrong key with 400 "Incorrect API key provided"; OpenAI and Anthropic with 401 (Goose: "Authentication required").
  if (/^Authentication required\b/.test(message) || /Authentication (failed|error)|Incorrect API key|invalid x-api-key|\(401\)/i.test(message)) return new AgentRunError(t().gooseAuthFailed(label));
  if (/\(404\)/.test(message) && /model/i.test(message)) return new AgentRunError(t().gooseModelNotFound(label, parsed?.model ?? o.model ?? ''));
  const unreachable = message.match(/Could not connect to ([^\s—]+)/);
  if (unreachable) return new AgentRunError(t().gooseUnreachable(label, unreachable[1]!));
  // Through the relay sandbox's proxy, a backend that does not answer (a wrong port, a server that is
  // down) comes back as the proxy's own error, with no body: "Bad request (400): ." or "Server error
  // (502 Bad Gateway) at <url>: .". A model API's own 400 or 5xx always says something.
  const proxied = message.match(/\((400|502|503|504)\b[^)]*\)(?: at (\S+?))?:\s*\.?\s*(?:$|\n)/);
  if (proxied) return new AgentRunError(t().gooseUnreachable(label, (proxied[2] && urlHost(proxied[2])) || gooseBackendHost(o) || label));
  return message === err.message ? err : new AgentRunError(message);
}

/** The host a run's model is on (`host` or `host:port`), from its model id and the backends. */
export function gooseBackendHost(o: Pick<RunOptions, 'model' | 'backends'>): string | undefined {
  const parsed = parseBackendModel(o.model ?? '');
  if (!parsed) return undefined;
  if (isApiBackend(parsed.backend)) return API_BACKEND_HOST[parsed.backend];
  const endpoint = o.backends?.endpoints.find((e) => e.id === parsed.backend);
  return endpoint ? urlHost(endpoint.baseUrl) : undefined;
}

/** Goose's runner: the generic ACP turn, with Goose's failures said plainly. */
export function gooseRunner(deps: Partial<AcpTurnDeps> = {}): AgentRunner {
  return {
    provider: 'goose',
    async run(o) {
      try {
        return await acpTurn(o, gooseAcp, { ...defaultAcpDeps, ...deps });
      } catch (err) {
        throw gooseError(err, o);
      }
    },
  };
}

// --- Asking Goose outside a run ------------------------------------------------------------------

/** One extension request to `goose acp` after `initialize`, without a session or a model; its result. */
export async function gooseAsk(bin: string, env: NodeJS.ProcessEnv, cwd: string, method: string, params: unknown, timeoutMs: number): Promise<any> {
  let result: any;
  let failure: string | undefined;
  const r = await converse({
    bin,
    args: ['acp'],
    cwd,
    env,
    timeoutMs,
    open: (write) => write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } }),
    onMessage: (msg, write, finish) => {
      if (msg.id === 1) return write({ jsonrpc: '2.0', id: 2, method, params });
      if (msg.id !== 2) return;
      if (msg.error) failure = String(msg.error.message ?? 'error');
      else result = msg.result;
      finish();
    },
  });
  if (result === undefined) throw new Error(failure ?? (r.timedOut ? t().timedOut : r.stderr.trim().split('\n').pop() || t().exitedWithoutTurn('Goose', null)));
  return result;
}

/** Goose's catalog (`_goose/unstable/providers/list`) as `<backend>/<model>` ids, for the API backends. */
export function parseGooseCatalog(result: any): OpenCatalog {
  const models: ModelOption[] = [];
  for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
    const backend = String(entry?.providerId ?? '');
    if (!(API_BACKENDS as readonly string[]).includes(backend)) continue;
    for (const m of Array.isArray(entry.models) ? entry.models : []) {
      if (typeof m?.id !== 'string' || !m.id) continue;
      models.push({ id: `${backend}/${m.id}`, ...(typeof m.name === 'string' && m.name ? { label: m.name } : {}) });
    }
  }
  return { models, efforts: GOOSE_EFFORTS };
}

/** Its model catalog: what Goose knows of each API backend's models (no key needed, no model API asked). */
export async function gooseModels(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<OpenCatalog> {
  const root = openAgentHome(env);
  const result = await gooseAsk(bin, env, root, '_goose/unstable/providers/list', { providerIds: [...API_BACKENDS] }, timeoutMs);
  return parseGooseCatalog(result);
}

/** The repository root above `cwd` (a folder holding `.git`), else undefined. */
function gitRoot(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The instruction files Goose reads for `cwd`: its home's, then from the repository root down to `cwd`. */
export function gooseHintFiles(cwd: string, root: string): NativeMemoryFile[] {
  const files: string[] = [join(root, 'config', '.goosehints'), join(root, 'config', 'AGENTS.md'), join(root, '.agents', 'AGENTS.md')];
  const top = gitRoot(cwd);
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (!top || dir === top || dirname(dir) === dir) break;
  }
  for (const dir of dirs) for (const name of GOOSE_HINT_FILES) files.push(join(dir, name));
  return [...new Set(files)].filter((p) => existsSync(p)).map((path) => ({ path, kind: 'instructions' as const }));
}

/** Reads a JSON file, or undefined. */
function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** What Goose's plugins bring: each plugin, its MCP servers (`.mcp.json`) and hooks (`hooks/hooks.json`). */
export function goosePluginParts(plugins: readonly GoosePluginDir[]): { plugins: NativePlugin[]; mcpServers: NativeMcpServer[]; hooks: NativeHook[] } {
  const out = { plugins: [] as NativePlugin[], mcpServers: [] as NativeMcpServer[], hooks: [] as NativeHook[] };
  for (const p of plugins) {
    const source = `plugin ${p.name}`;
    out.plugins.push({ name: p.name, source: p.scope === 'project' ? 'project' : 'user', id: p.root });
    const mcp = readJson(join(p.root, '.mcp.json'));
    const servers = mcp?.mcpServers && typeof mcp.mcpServers === 'object' ? mcp.mcpServers : {};
    for (const [name, s] of Object.entries<any>(servers)) {
      out.mcpServers.push({ name: `${p.name}:${name}`, transport: s?.url ? 'http' : 'stdio', source });
    }
    const file = join(p.root, 'hooks', 'hooks.json');
    const hooks = readJson(file)?.hooks;
    for (const [event, groups] of Object.entries<any>(hooks && typeof hooks === 'object' ? hooks : {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        out.hooks.push({ event, ...(typeof g?.matcher === 'string' && g.matcher ? { matcher: g.matcher } : {}), source, file });
      }
    }
  }
  return out;
}

/** Goose's skills for `cwd`, as `_goose/unstable/sources/list` gives them. */
export function parseGooseSkills(result: any): NativeSkill[] {
  return (Array.isArray(result?.sources) ? result.sources : [])
    .filter((s: any) => s?.type === 'skill' && typeof s.name === 'string')
    .map((s: any) => ({
      name: s.name,
      description: typeof s.description === 'string' ? s.description : '',
      source: String(s.path ?? '').startsWith('builtin://') ? 'bundled' : s.global ? 'user' : 'project',
      ...(typeof s.path === 'string' && !s.path.startsWith('builtin://') ? { path: s.path } : {}),
    }));
}

/**
 * What Goose loads by itself for `cwd`, asked without a prompt: its skills (from Goose), its plugins
 * with their MCP servers and hooks, and its instruction files (from the folders it reads them in).
 */
export async function gooseNative(bin: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 20_000): Promise<NativeProbe> {
  // Where this start of Goose finds its config and plugins (`gooseHome`'s state folder).
  const root = env.GOOSE_PATH_ROOT || openAgentHome(env);
  const problems: NativeProbe['problems'] = [];
  let skills: NativeSkill[] = [];
  try {
    skills = parseGooseSkills(await gooseAsk(bin, env, cwd, '_goose/unstable/sources/list', { sourceType: 'skill', projectDir: cwd }, timeoutMs));
  } catch (err) {
    problems.push({ kind: 'failed', detail: (err as Error).message });
  }
  const parts = goosePluginParts(goosePluginDirs(cwd, root));
  return {
    provider: 'goose',
    cwd,
    skills,
    mcpServers: parts.mcpServers,
    memory: gooseHintFiles(cwd, root),
    hooks: parts.hooks,
    plugins: parts.plugins,
    memoryFromFiles: true,
    nativeOff: [],
    nativeItems: {},
    asRun: false,
    problems,
    checkedAt: Date.now(),
  };
}

export const gooseAgent: OpenAgentDefinition = {
  provider: 'goose',
  process: gooseAcp,
  runner: gooseRunner(),
  efforts: GOOSE_EFFORTS,
  models: (bin, env) => gooseModels(bin, env),
  native: (bin, env, cwd, timeoutMs) => gooseNative(bin, env, cwd, timeoutMs),
};
