import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { API_BACKENDS, PROVIDER_LABEL, type ModelOption, type NativeMemoryFile } from '../../shared/types';
import { commandLine } from '../commands';
import { backendLabel, type BackendRun } from '../backends';
import { t } from '../i18n';
import type { NativeProbe } from '../native';
import { converse, runProcess, tail } from '../process';
import { commandPaths, overlaps } from '../protect';
import { acpApprovalRequest, acpDeclined, acpPermissionDecision, acpPromptText, type AcpCallInfo, type AcpDecision } from './acpTurn';
import {
  defaultOpenDeps,
  openAgentHome,
  startOpenProcess,
  type OpenAgentDefinition,
  type OpenAgentProcess,
  type OpenCatalog,
  type OpenHomeLayout,
  type OpenProcessDeps,
  type OpenRunContext,
  type OpenSandboxNeeds,
} from './open';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  imageData,
  summarizeInput,
  tailText,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type McpServerSpec,
  type RunOptions,
  type RunResult,
} from './types';

/*
 * Pi: `pi` (npm `@earendil-works/pi-coding-agent`, checked with 1.5.1) over its JSONL RPC,
 * `pi --mode rpc`: commands on stdin, responses and events on stdout, one JSON object per line, LF
 * only as the record separator (`PiLines`, not readline). One process per turn:
 *
 *   get_state (the session, the model) → get_commands (the gate is loaded) →
 *   get_available_thinking_levels / set_thinking_level (the effort, checked first: Pi clamps silently) →
 *   prompt → events … → agent_settled (the end of the turn; not agent_end, after which retries and
 *   queued messages can still come) → stdin closed, Pi exits.
 *
 * Pi has no permission prompts of its own. Below full access a gate extension of Harness Relay's
 * (`piGate.js`, in Harness Relay's own folder, loaded by its absolute path with
 * `--no-extensions -e <gate>`) stops every tool call, MCP tools included, and asks over the RPC (an
 * `input` dialog); the same decision → `requestApproval` → declined note as the ACP agents answers, and
 * a refusal's reason reaches the model as the call's result. It fails closed, and a run where it did not
 * load does not start. Read-only also limits Pi's tools to reading ones (`--tools read,grep,find,ls`).
 *
 * Its home: the sessions (`<state>/sessions`, `PI_CODING_AGENT_SESSION_DIR`, in the conversation
 * member's own state folder, which no other member's or conversation's run can read) are kept; everything else
 * Pi reads at start (settings, models.json, mcp.json, auth.json, the briefing) is written for each run
 * into a fresh agent folder in the run's own temp folder (`PI_CODING_AGENT_DIR`), which stays
 * writable (Pi makes `auth.json.lock` beside `auth.json`) while each of those files is read-only in
 * the relay sandbox. Leaks its variables do not cover are closed with its flags: `$HOME/.agents/skills`
 * (`--no-skills`), project `.pi/` folders (`--no-approve`), extensions and themes. Every AGENTS.md /
 * CLAUDE.md from the working directory up to `/` is what it loads by itself (`--no-context-files`
 * turns them all off). See docs/open-agents.md, "Pi".
 */

const CLI = PROVIDER_LABEL.pi;

/** The gate extension, by its absolute path in Harness Relay's own folder (never the agent's home). */
export const PI_GATE_PATH = fileURLToPath(new URL('./piGate.js', import.meta.url));
/** The title of the gate's `input` dialogs. */
export const PI_GATE_TITLE = 'harness-relay:tool_call';
/** The command the gate registers: its presence in `get_commands` proves the gate loaded. */
export const PI_GATE_COMMAND = 'harness-relay-gate';

/** Pi's thinking levels (`--thinking`, `set_thinking_level`), Harness Relay's efforts for it. */
export const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The variable an endpoint's key reaches Pi in (models.json names it; never written to a file). */
export const PI_ENDPOINT_KEY_VAR = 'HARNESS_RELAY_ENDPOINT_API_KEY';
/** models.json's `apiKey` for an endpoint without a key: Pi needs one to offer the model. */
export const PI_NO_KEY = 'harness-relay-no-key';

/**
 * Variables of every Pi process: no network at start (catalog refresh, version check, fd / ripgrep
 * downloads into its folder), no telemetry, and none of its code-loading caches (jiti's transpile cache
 * of extensions and Node's compile cache would go in the temp folder, where a run could plant code).
 */
export const PI_ENV: Record<string, string> = {
  PI_OFFLINE: '1',
  PI_SKIP_VERSION_CHECK: '1',
  PI_TELEMETRY: '0',
  JITI_FS_CACHE: 'false',
  NODE_DISABLE_COMPILE_CACHE: '1',
};

/**
 * Everything in Pi's agent folder that changes what it does when it starts (`<agentDir>/<name>`): each is
 * read-only in the relay sandbox, also those Harness Relay does not write (so none can be created).
 */
export const PI_CONFIG_NAMES = [
  'settings.json',
  'models.json',
  'mcp.json',
  'auth.json',
  'models-store.json',
  'mcp-auth.json',
  'keybindings.json',
  'trust.json',
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
  'SYSTEM.md',
  'APPEND_SYSTEM.md',
  // Folders: extensions, skills, prompts and themes it would discover; `bin` holds the fd and ripgrep
  // it runs (looked up before the PATH); `npm` and `git` hold installed packages.
  'extensions',
  'skills',
  'prompts',
  'themes',
  'bin',
  'tools',
  'npm',
  'git',
];
const PI_CONFIG_DIRS = new Set(['extensions', 'skills', 'prompts', 'themes', 'bin', 'tools', 'npm', 'git']);

/** The briefing's file in the run's agent folder (`--append-system-prompt <file>`). */
export const PI_BRIEFING_FILE = 'harness-relay-briefing.md';

/** Read-only's tools: Pi's reading tools (`find` needs fd, `grep` ripgrep: left out when missing). */
export const PI_READ_TOOLS = ['read', 'grep', 'find', 'ls'];

/** Flags of every Pi process: nothing of the user's or the project's is loaded. */
const PI_FLAGS = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve'];

// --- What Pi needs from the relay sandbox ------------------------------------------------------

/*
 * What a Pi run needs from the relay sandbox, besides what `startOpenProcess` hands it (the sessions
 * folder and the run's temp folder writable, the run's agent folder inside it, every config file there
 * read-only, the backend's hosts): no opt-in at all (`piSandbox`).
 * - The proxy: Pi needs no `NODE_USE_ENV_PROXY`; it installs undici's `EnvHttpProxyAgent` as its global
 *   dispatcher, which reads `HTTP(S)_PROXY` and `NO_PROXY` (owned by the sandbox, which narrows
 *   `NO_PROXY` so a LAN endpoint goes through the proxy).
 * - No loopback ports of its own, PTY, Unix sockets or macOS trustd (Node's own CA store).
 * - No host is quietly refused: `PI_ENV` turns off everything Pi would fetch by itself (its version
 *   check and catalog on pi.dev, fd / ripgrep from GitHub).
 * - The gate extension is read from Harness Relay's own folder, outside every folder the run may write
 *   (checked in `preparePi`).
 */
export function piSandbox(): OpenSandboxNeeds {
  return {};
}

// --- Home and the config written for each run ---------------------------------------------------

/**
 * Pi's layout: the sessions are kept, in the run's state folder (the conversation member's own); the
 * agent folder of a run is its own (`prepare`).
 */
export function piHomeLayout(root: string, state = root): OpenHomeLayout {
  const sessions = join(state, 'sessions');
  return {
    // The agent folder outside a run (status, models, native): never the user's ~/.pi/agent.
    env: { PI_CODING_AGENT_DIR: join(root, 'agent'), PI_CODING_AGENT_SESSION_DIR: sessions, ...PI_ENV },
    statePaths: [sessions],
    configPaths: [],
  };
}

/** Pi's provider id for the run's backend: OpenAI, Anthropic and xAI as Pi names them; an endpoint as `relay-<id>`. */
export function piProvider(run: Pick<BackendRun, 'kind' | 'backend'>): string {
  return run.kind === 'endpoint' ? `relay-${run.backend}` : run.kind;
}

/** Pi's `<provider>/<model>` for the run. */
export function piModelRef(run: Pick<BackendRun, 'kind' | 'backend' | 'model'>): string {
  return `${piProvider(run)}/${run.model}`;
}

/** Pi's user settings for a run: no project trust, no telemetry, no cache warming between runs. */
export function piSettings(): Record<string, unknown> {
  return {
    defaultProjectTrust: 'never',
    enableInstallTelemetry: false,
    enableAnalytics: false,
    enableSkillCommands: false,
    quietStartup: true,
    collapseChangelog: true,
    cacheWarming: 'off',
  };
}

/** Where an API backend's models live in Pi, for a model its catalog does not have (`piModelsJson`). */
export const PI_API_MODEL: Record<string, { api: string; baseUrl: string }> = {
  openai: { api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' },
  xai: { api: 'openai-responses', baseUrl: 'https://api.x.ai/v1' },
};

/**
 * models.json for a run:
 * - an endpoint as an OpenAI-compatible provider (`openai-completions`) at its base URL, with its typed
 *   models and the run's, its key by variable (`$HARNESS_RELAY_ENDPOINT_API_KEY`);
 * - an API backend's model that Pi's catalog does not have (`known` false): added to the provider, since
 *   Pi would otherwise copy its default model's settings (a reasoning model's, which a model that does
 *   not reason rejects); one it has stays as its catalog says.
 * The run's model reasons only when an effort other than `off` is asked for (Pi then sends it).
 */
export function piModelsJson(run: BackendRun, effort?: string, known = true): { providers: Record<string, unknown> } {
  const reasoning = Boolean(effort && effort !== 'off');
  if (run.kind !== 'endpoint' || !run.endpoint) {
    const where = PI_API_MODEL[run.kind];
    if (known || !where) return { providers: {} };
    return { providers: { [run.kind]: { models: [{ id: run.model, name: run.model, ...where, reasoning, input: ['text', 'image'] }] } } };
  }
  const ids = [...new Set([...run.endpoint.models, run.model])];
  return {
    providers: {
      [piProvider(run)]: {
        name: run.endpoint.name || run.endpoint.id,
        baseUrl: run.endpoint.baseUrl,
        api: 'openai-completions',
        apiKey: run.endpoint.apiKey ? `$${PI_ENDPOINT_KEY_VAR}` : PI_NO_KEY,
        models: ids.map((id) => ({ id, name: id, reasoning: id === run.model && reasoning })),
      },
    },
  };
}

/** Pi's catalog ids (`<provider>/<id>`) per program, asked at most every ten minutes (`piModels`). */
const knownCache = new Map<string, { at: number; ids: Promise<Set<string> | undefined> }>();

/**
 * Whether Pi's own catalog has the run's model (undefined when it could not be asked: the model is
 * then left to Pi). Swapped in tests through `piKnownModels.ask`.
 */
export const piKnownModels = {
  ask: async (bin: string, env: NodeJS.ProcessEnv): Promise<Set<string> | undefined> => {
    const catalog = await piModels(bin, env);
    return catalog.error ? undefined : new Set(catalog.models.map((m) => m.id));
  },
  async has(bin: string, env: NodeJS.ProcessEnv, id: string): Promise<boolean | undefined> {
    const now = Date.now();
    let hit = knownCache.get(bin);
    if (!hit || now - hit.at > 600_000) {
      hit = { at: now, ids: this.ask(bin, env).catch(() => undefined) };
      knownCache.set(bin, hit);
    }
    const ids = await hit.ids;
    return ids ? ids.has(id) : undefined;
  },
  clear(): void {
    knownCache.clear();
  },
};

/** A tool-library server's name as Pi takes it (letters, digits, `_` and `-`), once each. */
function serverNames(servers: McpServerSpec[]): string[] {
  const seen = new Set<string>();
  return servers.map((s) => {
    const base = s.name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[-_]+|[-_]+$/g, '') || 'server';
    let name = base;
    for (let n = 2; seen.has(name.replace(/-/g, '_').toLowerCase()); n++) name = `${base}_${n}`;
    seen.add(name.replace(/-/g, '_').toLowerCase());
    return name;
  });
}

/**
 * mcp.json for the tool library's servers (stdio and streamable HTTP), each declared to the model
 * (`exposure: "direct"`), with their secret values in variables (`${HARNESS_RELAY_MCP_<n>_<m>}`) that
 * `env` gets, never in the file.
 */
export function piMcpJson(servers: McpServerSpec[]): { json: Record<string, unknown>; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const names = serverNames(servers);
  const entries = servers.map((s, i) => {
    const vars = (values: Record<string, string>, kind: string) =>
      Object.fromEntries(
        Object.entries(values).map(([k, v], j) => {
          const name = `HARNESS_RELAY_MCP_${i}_${kind}_${j}`;
          env[name] = v;
          return [k, `\${${name}}`];
        }),
      );
    const server =
      s.transport === 'http'
        ? { url: s.url, headers: vars(s.headers, 'H'), exposure: 'direct' }
        : { command: s.command, args: [...s.args], env: vars(s.env, 'E'), exposure: 'direct' };
    return [names[i]!, server] as const;
  });
  return { json: { mcpServers: Object.fromEntries(entries), autoEnableCodemode: false }, env };
}

/** Read-only's tools: those whose program is there (`find` runs fd, `grep` ripgrep). */
export function piReadTools(env: NodeJS.ProcessEnv): string[] {
  const needs: Record<string, string> = { find: 'fd', grep: 'rg' };
  return PI_READ_TOOLS.filter((tool) => !needs[tool] || commandPaths(needs[tool]!, env).length > 0);
}

/** What `prepare` keeps for `piArgs` and the turn (`ctx.state`). */
export interface PiRunState {
  agentDir: string;
  sessionFile?: string;
  briefingFile?: string;
  mcp: boolean;
  tools?: string[];
}

function piState(ctx: Pick<OpenRunContext, 'state'>): PiRunState {
  return ctx.state as unknown as PiRunState;
}

/** Whether two paths are the same folder (links resolved where they exist). */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

/** The longest session header read (Pi reads any length; a longer one is not resumed). */
export const PI_HEADER_MAX = 16 * 1024 * 1024;

/** A file's first line, however long (up to `max` bytes; undefined beyond, or for an empty file). */
function firstLine(file: string, max = PI_HEADER_MAX): string | undefined {
  const fd = openSync(file, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(65536);
    const parts: string[] = [];
    let bytes = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      const at = n ? buf.subarray(0, n).indexOf(0x0a) : -1;
      bytes += at >= 0 ? at : n;
      if (bytes > max) return undefined;
      if (n === 0) return parts.join('') + decoder.end() || undefined;
      if (at >= 0) return parts.join('') + decoder.write(buf.subarray(0, at)) + decoder.end();
      parts.push(decoder.write(buf.subarray(0, n)));
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * The working directory a session file's header names, when its first line is the header of this
 * session (`{"type":"session","id":…,"cwd":…}`); undefined otherwise. Pi takes the first entry it can
 * read as the header, skipping lines it cannot, and runs the session in that header's `cwd`: anything
 * but a readable header of this session on the first line is not resumed.
 */
export function piSessionCwd(file: string, id: string): string | undefined {
  try {
    const header = JSON.parse(firstLine(file) ?? '') as Record<string, unknown> | null;
    if (!header || typeof header !== 'object' || header.type !== 'session' || header.id !== id) return undefined;
    return typeof header.cwd === 'string' && header.cwd ? header.cwd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The file of the session to resume (`<sessions>/<time>_<id>.jsonl`), checked before Pi starts, since
 * Pi itself would quietly start a new session for a missing file, and run a session in the folder its
 * header names (the file is in a folder the runs may write). Throws the resume failure (the
 * orchestrator then starts afresh with the whole history) when it is gone, its header cannot be read
 * as this session's on its first line, or it names another working directory.
 */
export function piSessionFile(sessionsDir: string, id: string, cwd: string): string {
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && existsSync(sessionsDir) ? readdirSync(sessionsDir).find((n) => n.endsWith(`_${id}.jsonl`)) : undefined;
  if (!name) throw new AgentRunError(t().openResumeFailed(CLI, t().piSessionMissing(id)));
  const file = join(sessionsDir, name);
  const then = piSessionCwd(file, id);
  if (!then) throw new AgentRunError(t().openResumeFailed(CLI, t().piSessionMissing(id)));
  if (!samePath(then, cwd)) throw new AgentRunError(t().openResumeFailed(CLI, t().piSessionMoved(then, cwd)));
  return file;
}

function writeFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
}

/**
 * Writes the run's agent folder (a fresh one in the run's temp folder, so parallel runs never share it
 * and nothing a run leaves there reaches another): settings.json, models.json, mcp.json, an empty
 * auth.json and models-store.json (keys come from the environment), the briefing; the folders Pi would
 * load code or instructions from, empty. Every config path is added to the run's read-only list.
 */
export async function preparePi(ctx: OpenRunContext): Promise<void> {
  const { o, run } = ctx;
  const agentDir = join(ctx.tmpDir, 'pi-agent');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  ctx.env.PI_CODING_AGENT_DIR = agentDir;
  const sessions = ctx.env.PI_CODING_AGENT_SESSION_DIR ?? join(ctx.home.state, 'sessions');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });

  // The gate must stay out of reach of the run: never inside a folder it may write.
  const writable = [...ctx.home.statePaths, ctx.tmpDir, ...(o.permission === 'edit' ? [o.cwd, ...(o.addDirs ?? []), ...(o.attachmentsDir ? [o.attachmentsDir] : [])] : [])];
  if (o.permission !== 'full' && writable.some((dir) => overlaps(PI_GATE_PATH, dir))) throw new AgentRunError(t().piGateWritable(PI_GATE_PATH));

  const state: PiRunState = { agentDir, mcp: false };
  if (o.sessionId) state.sessionFile = piSessionFile(sessions, o.sessionId, o.cwd);

  writeFile(join(agentDir, 'settings.json'), JSON.stringify(piSettings(), null, 2));
  const known = run.kind === 'endpoint' ? true : ((await piKnownModels.has(o.bin, ctx.env, run.id)) ?? true);
  writeFile(join(agentDir, 'models.json'), JSON.stringify(piModelsJson(run, o.effort, known), null, 2));
  if (run.endpoint?.apiKey) ctx.env[PI_ENDPOINT_KEY_VAR] = run.endpoint.apiKey;
  const servers = o.mcpServers ?? [];
  const mcp = piMcpJson(servers);
  writeFile(join(agentDir, 'mcp.json'), JSON.stringify(mcp.json, null, 2));
  Object.assign(ctx.env, mcp.env);
  state.mcp = servers.length > 0;
  writeFile(join(agentDir, 'auth.json'), '{}');
  writeFile(join(agentDir, 'models-store.json'), '{}');
  for (const name of PI_CONFIG_NAMES) if (PI_CONFIG_DIRS.has(name)) mkdirSync(join(agentDir, name), { recursive: true, mode: 0o700 });

  const brief = o.systemPrompt.trim();
  if (brief) {
    state.briefingFile = join(agentDir, PI_BRIEFING_FILE);
    writeFile(state.briefingFile, brief + '\n');
  }
  // `--tools` with plain names would drop the MCP tools too (seen with Pi 1.5.1): `mcp__*` keeps them.
  if (o.permission === 'read-only') state.tools = [...piReadTools(ctx.env), ...(state.mcp ? ['mcp__*'] : [])];

  ctx.home.configPaths.push(...PI_CONFIG_NAMES.map((n) => join(agentDir, n)), join(agentDir, PI_BRIEFING_FILE));
  Object.assign(ctx.state, state);
}

/** Pi's arguments for the run (after `preparePi`). */
export function piArgs(ctx: Pick<OpenRunContext, 'o' | 'run' | 'state'>): string[] {
  const s = piState(ctx);
  const { o } = ctx;
  const args = ['--mode', 'rpc', '--model', piModelRef(ctx.run), ...PI_FLAGS];
  if (o.permission !== 'full') args.push('-e', PI_GATE_PATH);
  if (s.mcp) args.push('-e', 'builtin:mcp');
  else args.push('--no-mcp');
  if (o.nativeOff?.includes('instructions')) args.push('--no-context-files');
  if (s.briefingFile) args.push('--append-system-prompt', s.briefingFile);
  if (s.sessionFile) args.push('--session', s.sessionFile);
  if (s.tools) args.push('--tools', s.tools.join(','));
  // A model Pi does not know reasons only when started with a level; the level is checked again over RPC.
  if (o.effort && PI_LEVELS.includes(o.effort)) args.push('--thinking', o.effort);
  return args;
}

export const piProcess: OpenAgentProcess = {
  provider: 'pi',
  implemented: true,
  home: piHomeLayout,
  sandbox: piSandbox,
  // Inherited, these would change where Pi loads its code from or which credential it uses.
  emptyEnv: ['PI_PACKAGE_DIR', 'PI_SELF_UPDATE_COMMAND', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_FEDERATION_RULE_ID'],
  prepare: preparePi,
};

// --- The JSONL RPC ------------------------------------------------------------------------------

/**
 * Splits Pi's stdout into records on LF only (a CR before it is dropped), as raw bytes: never on
 * U+2028 / U+2029 or a lone CR, which a generic line reader may take as line ends.
 */
export class PiLines {
  private parts: Buffer[] = [];

  constructor(private onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (let i = chunk.indexOf(0x0a); i >= 0; i = chunk.indexOf(0x0a, start)) {
      this.parts.push(chunk.subarray(start, i));
      const line = Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      start = i + 1;
      this.emit(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (start < chunk.length) this.parts.push(chunk.subarray(start));
  }

  /** The last record, when the stream ended without an LF after it. */
  end(): void {
    if (!this.parts.length) return;
    const line = Buffer.concat(this.parts).toString('utf8');
    this.parts = [];
    this.emit(line);
  }

  private emit(line: string): void {
    if (!line.trim()) return;
    try {
      this.onLine(line);
    } catch (err) {
      console.error('[pi] line handler failed:', err);
    }
  }
}

/** One of Pi's command responses. */
export interface PiResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

/** Commands to Pi and their responses, matched by id (`hr-<n>`). */
export class PiRpc {
  private next = 1;
  private pending = new Map<string, { resolve: (r: PiResponse) => void; reject: (e: Error) => void }>();
  private closed?: Error;

  constructor(private write: (msg: Record<string, unknown>) => void) {}

  /** Sends a command and resolves with its response (`success` true or false). */
  request(cmd: Record<string, unknown>): Promise<PiResponse> {
    if (this.closed) return Promise.reject(this.closed);
    const id = `hr-${this.next++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, ...cmd });
    });
  }

  /** Sends a command without waiting for its response (`abort`, answered only once the run settled). */
  send(cmd: Record<string, unknown>): void {
    if (!this.closed) this.write(cmd);
  }

  /** Takes a record that answers a pending command; false for anything else. */
  handle(msg: Record<string, any>): boolean {
    if (msg.type !== 'response') return false;
    const waiting = typeof msg.id === 'string' ? this.pending.get(msg.id) : undefined;
    if (waiting) {
      this.pending.delete(msg.id);
      waiting.resolve(msg as PiResponse);
    } else if (msg.command === 'parse') {
      console.warn('[pi] could not read a command:', msg.error);
    }
    return true;
  }

  /** The process is gone: every pending command fails with `err`, later ones at once. */
  close(err: Error): void {
    this.closed = err;
    for (const w of this.pending.values()) w.reject(err);
    this.pending.clear();
  }
}

/** A successful response's data; the CLI's own error otherwise. */
function ok(r: PiResponse): any {
  if (!r.success) throw new Error(r.error || `${r.command} failed`);
  return r.data;
}

// --- The gate's requests → decisions --------------------------------------------------------------

/** A tool call the gate asks about. */
export interface PiGateRequest {
  toolCallId?: string;
  toolName: string;
  input: Record<string, any>;
  parentToolCallId?: string;
}

/** The gate's request in an `extension_ui_request`, or undefined when the record is not one (or unreadable: `null`). */
export function piGateRequest(msg: Record<string, any>): PiGateRequest | null | undefined {
  if (msg.type !== 'extension_ui_request' || msg.method !== 'input' || msg.title !== PI_GATE_TITLE) return undefined;
  try {
    const req = JSON.parse(String(msg.placeholder)) as Record<string, any>;
    if (typeof req?.toolName !== 'string' || !req.toolName) return null;
    return {
      toolName: req.toolName,
      input: req.input && typeof req.input === 'object' ? req.input : {},
      ...(typeof req.toolCallId === 'string' ? { toolCallId: req.toolCallId } : {}),
      ...(typeof req.parentToolCallId === 'string' ? { parentToolCallId: req.parentToolCallId } : {}),
    };
  } catch {
    return null;
  }
}

/** Pi's built-in tools as rows in the chat. */
const TOOL_LABEL: Record<string, string> = { read: 'Read', bash: 'Bash', edit: 'Edit', write: 'Write', grep: 'Grep', find: 'Find', ls: 'List' };

/** A tool's row name: Pi's built-in ones as words, an MCP tool as `mcp__<server>__<tool>`. */
export function piToolName(name: string): string {
  return TOOL_LABEL[name] ?? name;
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * What a call is about, exactly: the command, the file, what it searches for, or an MCP tool's input
 * (its usual fields, whole paths, else its JSON, short).
 */
export function piCallDetail(req: PiGateRequest): string | undefined {
  const input = req.input ?? {};
  if (req.toolName === 'bash') return commandLine(input.command);
  if (req.toolName === 'grep' || req.toolName === 'find') return piToolDetail(req.toolName, input);
  return summarizeInput(input, { wholePaths: true }) ?? (Object.keys(input).length ? clip(JSON.stringify(input), 300) : undefined);
}

/**
 * What a tool call the gate asks about is, for the permission's decision. Its title names the exact
 * call (`Bash npm publish`), since the refusal's text the model gets says which call was not run: in a
 * batch of calls, only that one.
 */
export function piCallInfo(req: PiGateRequest): AcpCallInfo {
  const input = req.input ?? {};
  const label = piToolName(req.toolName);
  const detail = piCallDetail(req);
  const path = text(input.path);
  const base = { title: detail ? `${label} ${clip(detail, 200)}` : label, tool: req.toolName, ...(path ? { path } : {}) };
  switch (req.toolName) {
    case 'read':
      return { kind: 'read', ...base };
    case 'grep':
    case 'find':
    case 'ls':
      return { kind: 'search', ...base };
    case 'bash':
      return { kind: 'execute', ...base, command: commandLine(input.command) ?? '' };
    case 'edit':
    case 'write':
      return { kind: 'edit', ...base };
    default:
      // MCP tools (`mcp__<server>__<tool>`) and anything else: the user decides below full access.
      return { kind: 'other', ...base, ...(text(input.url) ? { url: input.url } : {}) };
  }
}

/**
 * The approval card for a call: the command or the file as `acpApprovalRequest` makes it, the tool's
 * name as the reason; an MCP tool's card shows its input. In read-only, a card for an MCP tool also
 * says that the sandbox still refuses writes (Pi's only approvals there: its own tools are reading
 * ones), as for an edit or a command.
 */
export function piApprovalRequest(req: PiGateRequest, info: AcpCallInfo, permission: RunOptions['permission']): ApprovalRequest {
  const reason = piToolName(req.toolName);
  if (info.kind !== 'other') return { ...acpApprovalRequest(info, permission), reason };
  const detail = piCallDetail(req);
  return { kind: 'other', tool: req.toolName, ...(detail ? { detail } : {}), reason, ...(permission === 'read-only' ? { readOnlySandbox: true } : {}) };
}

/** The gate's answer: `{"allow":true}`, or a refusal with the reason the model gets. */
export function piGateAnswer(decision: AcpDecision): Record<string, unknown> {
  return decision.allow ? { allow: true } : { allow: false, reason: decision.reason };
}

/**
 * The decision about one call: the permission's (read-only: reading tools run; edit: all but pushing
 * and publishing), else the user's, when the conversation asks (their note goes to the model).
 */
export async function piDecide(o: Pick<RunOptions, 'permission' | 'requestApproval'>, req: PiGateRequest): Promise<AcpDecision> {
  const info = piCallInfo(req);
  let decision = acpPermissionDecision(o.permission, info, CLI);
  if (!decision.allow && o.requestApproval) {
    try {
      const answer = await o.requestApproval(piApprovalRequest(req, info, o.permission));
      decision = answer.allow ? { allow: true } : acpDeclined(info, answer.note);
    } catch (err) {
      console.warn('[pi] the approval failed; the call is refused:', (err as Error).message);
    }
  }
  return decision;
}

// --- Events → AgentEvents (pure) ------------------------------------------------------------------

/** The tokens and cost of a turn, summed over its assistant messages. */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  messages: number;
}

/** The last assistant message of the turn, as `message_end` gave it. */
export interface PiAssistantMessage {
  stopReason?: string;
  errorMessage?: string;
  usage?: Record<string, any>;
  [k: string]: unknown;
}

/** The text of a tool result's `content` (text blocks). */
function resultText(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const joined = content
    .map((c) => (c && typeof c === 'object' && (c as any).type === 'text' && typeof (c as any).text === 'string' ? (c as any).text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  return joined || undefined;
}

/** What a tool call is about, for its row: the command, the file, or what it searches for where. */
export function piToolDetail(name: string, args: unknown): string | undefined {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, any>;
  if ((name === 'grep' || name === 'find') && text(a.pattern)) return clip(text(a.path) ? `${a.pattern} · ${a.path}` : a.pattern);
  // An MCP tool's input has names of its own: shown as it is, short.
  return summarizeInput(args) ?? (Object.keys(a).length ? clip(JSON.stringify(a)) : undefined);
}

/** Turns Pi's session events into AgentEvents (pure: records in, events out). */
export function createPiEventHandler(emit: (e: AgentEvent) => void) {
  let inText = false;
  const open = new Set<string>();
  const refused = new Map<string, string>();
  let last: PiAssistantMessage | undefined;
  const usage: PiUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 };
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  const closeText = () => {
    if (inText) {
      inText = false;
      emit({ type: 'text_end' });
    }
  };

  function handle(msg: Record<string, any>): void {
    switch (msg.type) {
      case 'message_update': {
        const e = msg.assistantMessageEvent ?? {};
        if (e.type === 'text_delta' && typeof e.delta === 'string' && e.delta) {
          inText = true;
          emit({ type: 'text', text: e.delta });
        } else if (e.type === 'text_end') {
          closeText();
        } else if (e.type === 'thinking_delta' && typeof e.delta === 'string' && e.delta) {
          closeText();
          emit({ type: 'thinking', text: e.delta });
        }
        break;
      }
      case 'message_end': {
        const m = msg.message;
        if (m?.role !== 'assistant') break; // the system prompt, the user's message, tool results
        closeText();
        last = m as PiAssistantMessage;
        const u = m.usage ?? {};
        usage.input += num(u.input);
        usage.output += num(u.output);
        usage.cacheRead += num(u.cacheRead);
        usage.cacheWrite += num(u.cacheWrite);
        usage.cost += num(u.cost?.total);
        usage.messages++;
        break;
      }
      case 'tool_execution_start': {
        const id = String(msg.toolCallId ?? '');
        if (!id || open.has(id)) break;
        closeText();
        open.add(id);
        const name = String(msg.toolName ?? 'tool');
        const detail = piToolDetail(name, msg.args);
        emit({ type: 'tool_start', id, name: piToolName(name), ...(detail ? { detail } : {}) });
        break;
      }
      case 'tool_execution_end': {
        const id = String(msg.toolCallId ?? '');
        if (!open.delete(id)) break;
        const ok = msg.isError !== true;
        const diff = msg.result?.details?.diff;
        const out = resultText(msg.result);
        if (ok) {
          const output = typeof diff === 'string' && diff.trim() ? diff : out;
          emit({ type: 'tool_end', id, ok, ...(output ? { output: tailText(output) } : {}) });
        } else {
          emit({ type: 'tool_end', id, ok, error: refused.get(id) ?? (out ? tailText(out, 600) : t().openToolNotRun) });
        }
        break;
      }
    }
  }

  return {
    handle,
    /** Remember why Harness Relay refused a call, to show that rather than the reason the model got. */
    refused(toolCallId: string, label: string) {
      refused.set(toolCallId, label);
    },
    finish: closeText,
    /** Ends the rows of calls Pi never finished: as done when the turn ended normally, else as not finished. */
    closeOpen(ended: boolean): void {
      for (const id of [...open]) {
        open.delete(id);
        emit({ type: 'tool_end', id, ok: ended, ...(ended ? {} : { error: refused.get(id) ?? t().openToolNotFinished }) });
      }
    },
    get last() {
      return last;
    },
    get usage(): PiUsage {
      return { ...usage };
    },
  };
}

/** The turn's tokens and cost for `RunResult` (an endpoint's cost is not known: none). */
export function piRunUsage(u: PiUsage, run: Pick<BackendRun, 'kind'>): Pick<RunResult, 'costUsd' | 'inputTokens' | 'outputTokens'> {
  if (!u.messages) return {};
  return {
    inputTokens: u.input + u.cacheRead + u.cacheWrite,
    outputTokens: u.output,
    // Pi prices a turn from its catalog: none for an endpoint, or a model it does not know (0).
    ...(run.kind !== 'endpoint' && u.cost > 0 ? { costUsd: u.cost } : {}),
  };
}

/** What kind of failure a provider's error message says. */
export function piErrorKind(message: string): 'key' | 'model' | 'connection' | 'other' {
  // Through the relay sandbox an unreachable host is the proxy's answer (502, 403…): never a key's.
  if (PROXY_FAILURE.test(message)) return 'connection';
  if (/\b40[13]\b|invalid[ _-]?(x-)?api[ _-]?key|incorrect api key|authentication[_ ]error|unauthori[sz]ed|permission[_ ]denied/i.test(message)) return 'key';
  if (/\b404\b|model[_ ]not[_ ]found|not_found_error|does not exist|unknown model|no such model|model .* not found/i.test(message)) return 'model';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPERM|fetch failed|connection error|socket hang up|getaddrinfo/i.test(message)) return 'connection';
  return 'other';
}

/** undici's words when the relay sandbox's proxy could not open the connection. */
const PROXY_FAILURE = /Proxy response \((\d{3})\)|HTTP Tunneling|UND_ERR_ABORTED/i;

/** What a connection failure says: the proxy's status alone (`HTTP 502`) rather than undici's words. */
export function piConnectionDetail(e: string): string {
  const m = PROXY_FAILURE.exec(e);
  if (!m) return e;
  return m[1] ? `HTTP ${m[1]}` : 'no connection';
}

/** The turn's failure, from the error of its last assistant message, in words the user can act on. */
export function piErrorText(message: string | undefined, run: BackendRun): string {
  const e = clip(message?.trim() || 'unknown error', 400);
  const label = backendLabel(run.backends, run.backend);
  switch (piErrorKind(e)) {
    case 'key':
      return t().piKeyRejected(label, e);
    case 'model':
      return t().piModelRejected(run.model, label, e);
    case 'connection':
      return run.endpoint ? t().piEndpointUnreachable(label, run.endpoint.baseUrl, piConnectionDetail(e)) : t().piUnreachable(label, piConnectionDetail(e));
    default:
      return t().piModelError(e);
  }
}

/** The gate is among Pi's commands, from Harness Relay's own file. */
export function piGateLoaded(data: any): boolean {
  const commands: any[] = Array.isArray(data?.commands) ? data.commands : [];
  return commands.some((c) => c?.name === PI_GATE_COMMAND && c?.source === 'extension' && samePath(String(c?.sourceInfo?.path ?? ''), PI_GATE_PATH));
}

/** The prompt command: the text (a leading `/` gets a word before it, or Pi would run it as a command) and the images. */
export function piPrompt(o: Pick<RunOptions, 'prompt' | 'images'>): Record<string, unknown> {
  const images = (o.images ?? []).flatMap((img) => {
    const data = imageData(img.path);
    return data ? [{ type: 'image', data, mimeType: img.mimeType }] : [];
  });
  return { type: 'prompt', message: acpPromptText(o.prompt), ...(images.length ? { images } : {}) };
}

// --- The turn ----------------------------------------------------------------------------------

export interface PiTurnDeps extends OpenProcessDeps {
  timeoutMs: number;
  /** How long Pi may take to exit once its stdin is closed (default 3 s). */
  exitGraceMs?: number;
}

export const defaultPiDeps: PiTurnDeps = { ...defaultOpenDeps, timeoutMs: TURN_TIMEOUT_MS };

/** One Pi turn: its process (in the relay sandbox below full access), its session, one prompt. */
export async function piTurn(o: RunOptions, deps: PiTurnDeps = defaultPiDeps): Promise<RunResult> {
  if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
  const proc = await startOpenProcess(piProcess, o, piArgs, deps);
  try {
    return await piSession(o, proc.ctx, proc, deps);
  } finally {
    await proc.dispose().catch((err: Error) => console.warn('[pi] could not end its sandbox:', err.message));
  }
}

async function piSession(
  o: RunOptions,
  ctx: OpenRunContext,
  proc: { bin: string; args: string[]; env: NodeJS.ProcessEnv; failure(): string | undefined },
  deps: PiTurnDeps,
): Promise<RunResult> {
  const { run } = ctx;
  let child: ChildProcess | undefined;
  let userAborted = false;
  /** The turn is over (settled, stopped or failed): answers that come later are not sent. */
  let over = false;
  let ended = false;
  const stop = new AbortController();
  const stopSoon = (ms: number) => setTimeout(() => stop.abort(), ms).unref();

  const write = (msg: Record<string, unknown>) => {
    if (child?.stdin?.writable) child.stdin.write(JSON.stringify(msg) + '\n');
  };
  const rpc = new PiRpc(write);
  const events = createPiEventHandler(o.onEvent);
  let settle!: () => void;
  let fail!: (err: Error) => void;
  const settled = new Promise<void>((res, rej) => {
    settle = res;
    fail = rej;
  });
  settled.catch(() => undefined);

  const onUiRequest = (msg: Record<string, any>) => {
    const req = piGateRequest(msg);
    if (req === undefined) {
      // Another dialog (none of Harness Relay's): dismissed. Notifications and status need no answer.
      if (['select', 'confirm', 'input', 'editor'].includes(msg.method)) write({ type: 'extension_ui_response', id: msg.id, cancelled: true });
      return;
    }
    const answer = (decision: AcpDecision, toolCallId?: string) => {
      // Expired: the run settled or was stopped while the user was asked; Pi has cancelled the dialog,
      // and the row keeps Pi's own words (the call was not refused by anyone).
      if (over || userAborted) return;
      if (!decision.allow && toolCallId) events.refused(toolCallId, decision.label);
      write({ type: 'extension_ui_response', id: msg.id, value: JSON.stringify(piGateAnswer(decision)) });
    };
    if (req === null) {
      answer({ allow: false, reason: 'Not run: Harness Relay could not read this tool call.', label: t().openToolNotRun });
      return;
    }
    void piDecide(o, req).then((d) => answer(d, req.toolCallId));
  };

  const lines = new PiLines((line) => {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line) as Record<string, any>;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || rpc.handle(msg)) return;
    if (msg.type === 'extension_ui_request') return onUiRequest(msg);
    if (msg.type === 'agent_settled') {
      over = true; // approvals still being asked about have expired (Pi cancelled their dialogs)
      events.finish();
      settle();
      return;
    }
    if (msg.type === 'extension_error') console.warn(`[pi] an extension failed (${msg.event}):`, msg.error);
    events.handle(msg);
  });

  const onAbort = () => {
    userAborted = true;
    rpc.send({ type: 'abort' });
    stopSoon(3000);
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
    cwd: o.cwd,
    env: proc.env,
    signal: stop.signal,
    timeoutMs: deps.timeoutMs,
    keepStdinOpen: true,
    maxCapture: 1024,
    onSpawn: (c) => {
      child = c;
      c.stdout?.on('data', (chunk: Buffer) => lines.push(chunk));
      c.stdout?.on('end', () => lines.end());
    },
  }).then(
    (res) => {
      // The relay sandbox's reason (it could not start, or refused) comes first: stderr then says little.
      const err = new AgentRunError(res.timedOut ? t().timedOut : proc.failure() || tail(res.stderr) || t().exitedWithoutTurn(CLI, res.code));
      rpc.close(err);
      fail(err);
      return res;
    },
    (err: Error) => {
      rpc.close(err);
      fail(err);
      throw err;
    },
  );
  exited.catch(() => undefined);

  try {
    /** Ends the turn at once when the user stopped it (checked after every await before the prompt). */
    const stopped = () => {
      if (userAborted) throw new AgentRunError(t().stopped, true);
    };
    const state = ok(await rpc.request({ type: 'get_state' }));
    stopped();
    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : '';
    if (!sessionId) throw new AgentRunError(t().openNoSession(CLI));
    if (o.sessionId && sessionId !== o.sessionId) throw new AgentRunError(t().openResumeFailed(CLI, t().piSessionMismatch(o.sessionId, sessionId)));

    // The model: a resumed session may keep its own, and Pi matches `--model` loosely.
    const provider = piProvider(run);
    if (state?.model?.provider !== provider || state?.model?.id !== run.model) {
      const set = await rpc.request({ type: 'set_model', provider, modelId: run.model });
      stopped();
      const got = state?.model ? `${state.model.provider}/${state.model.id}` : '—';
      if (!set.success) throw new AgentRunError(t().openRejectedModel(CLI, run.id, set.error || t().piModelMismatch(run.id, got)));
    }
    o.onEvent({ type: 'session', sessionId });
    stopped();

    if (o.permission !== 'full') {
      const commands = ok(await rpc.request({ type: 'get_commands' }));
      stopped();
      if (!piGateLoaded(commands)) throw new AgentRunError(t().piGateMissing);
    }

    if (o.effort) {
      const levels: string[] = (ok(await rpc.request({ type: 'get_available_thinking_levels' }))?.levels ?? []).filter((l: unknown) => typeof l === 'string');
      stopped();
      if (!levels.includes(o.effort)) throw new AgentRunError(t().openRejectedEffort(CLI, o.effort, t().piEffortLevels(levels.join(', ') || '—')));
      const now = ok(await rpc.request({ type: 'get_state' }))?.thinkingLevel;
      stopped();
      if (now !== o.effort) ok(await rpc.request({ type: 'set_thinking_level', level: o.effort }));
    }

    // Pi takes `abort` on an idle session as nothing: a stop on the way here must keep the prompt from going out.
    stopped();
    const started = await rpc.request(piPrompt(o));
    if (!started.success) throw new AgentRunError(t().piPromptRejected(started.error || 'prompt'));
    if (started.data?.disposition !== 'handled') await settled;
    over = true;
    if (userAborted) throw new AgentRunError(t().stopped, true);
    const last = events.last;
    if (last?.stopReason === 'error') throw new AgentRunError(piErrorText(last.errorMessage, run));
    if (last?.stopReason === 'aborted') throw new AgentRunError(t().openCancelledNoReason(CLI));
    ended = true;
    return { sessionId, ...piRunUsage(events.usage, run) };
  } catch (err) {
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (err instanceof AgentRunError) throw err;
    throw new AgentRunError(err instanceof Error ? err.message : String(err));
  } finally {
    over = true;
    events.finish();
    events.closeOpen(ended);
    o.signal.removeEventListener('abort', onAbort);
    child?.stdin?.end(); // Pi shuts down when its stdin closes
    stopSoon(deps.exitGraceMs ?? 3000);
    await exited.catch(() => undefined);
  }
}

export const piRunner: AgentRunner = {
  provider: 'pi',
  run: (o) => piTurn(o),
};

// --- The catalog and what Pi loads by itself ----------------------------------------------------

/** The thinking levels a model of Pi's catalog takes (as `get_available_thinking_levels` gives them). */
export function piModelLevels(m: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }): string[] {
  if (!m.reasoning) return ['off'];
  const map = m.thinkingLevelMap ?? {};
  return PI_LEVELS.filter((l) => {
    const v = map[l];
    if (v === null) return false;
    return l === 'xhigh' || l === 'max' ? typeof v === 'string' : true;
  });
}

/** Pi's catalog (`get_available_models`) as `<backend>/<model>` ids, for OpenAI, Anthropic and xAI. */
export function piCatalog(models: unknown): OpenCatalog {
  const list = Array.isArray(models) ? models : [];
  const out: ModelOption[] = [];
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || !(API_BACKENDS as readonly string[]).includes(m.provider)) continue;
    out.push({ id: `${m.provider}/${m.id}`, ...(typeof m.name === 'string' && m.name !== m.id ? { label: m.name } : {}), efforts: piModelLevels(m) });
  }
  return { models: out, efforts: [...PI_LEVELS] };
}

/** Keys that make Pi list a backend's models (it lists only providers with credentials); never sent anywhere. */
const CATALOG_KEYS = { OPENAI_API_KEY: 'harness-relay-catalog', ANTHROPIC_API_KEY: 'harness-relay-catalog', XAI_API_KEY: 'harness-relay-catalog' };

/** Asks Pi for its model catalog, offline, in an agent folder of its own (removed after). */
export async function piModels(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<OpenCatalog> {
  const dir = join(openAgentHome(env), `catalog-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFile(join(dir, 'settings.json'), JSON.stringify(piSettings()));
  try {
    let answer: PiResponse | undefined;
    const res = await converse({
      bin,
      args: ['--mode', 'rpc', '--no-session', ...PI_FLAGS, '--no-context-files', '--no-mcp', '--offline'],
      cwd: dir,
      env: { ...env, ...PI_ENV, PI_CODING_AGENT_DIR: dir, ...CATALOG_KEYS },
      timeoutMs,
      open: (w) => w({ id: 'models', type: 'get_available_models' }),
      onMessage: (m, _w, finish) => {
        if (m.type === 'response' && m.id === 'models') {
          answer = m as PiResponse;
          finish();
        }
      },
    });
    if (!answer?.success) return { models: [], efforts: [...PI_LEVELS], error: answer?.error || (res.timedOut ? t().timedOut : tail(res.stderr) || 'pi: no answer') };
    return piCatalog(answer.data?.models);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CONTEXT_FILES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The instruction files Pi loads for `cwd`: its agent folder's, then one per folder from `/` down to
 * `cwd`, the first there of AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD.
 */
export function piContextFiles(cwd: string, agentDir?: string): NativeMemoryFile[] {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  const pick = (dir: string) => CONTEXT_FILES.map((n) => join(dir, n)).find(isFile);
  const files = [...(agentDir ? [pick(agentDir)] : []), ...dirs.map(pick)].filter((p): p is string => Boolean(p));
  return [...new Set(files)].map((path) => ({ path, kind: 'instructions' as const }));
}

/** What Pi loads by itself for a folder: its instruction files (read from the files; Pi has no command that lists them). */
export async function piNative(_bin: string, _env: NodeJS.ProcessEnv, cwd: string): Promise<NativeProbe> {
  return {
    provider: 'pi',
    cwd,
    skills: [],
    mcpServers: [],
    memory: piContextFiles(cwd),
    memoryFromFiles: true,
    nativeOff: [],
    nativeItems: {},
    asRun: false,
    problems: [],
    checkedAt: Date.now(),
  };
}

export const piAgent: OpenAgentDefinition = {
  provider: 'pi',
  process: piProcess,
  runner: piRunner,
  efforts: [...PI_LEVELS],
  models: (bin, env) => piModels(bin, env),
  native: (bin, env, cwd) => piNative(bin, env, cwd),
};
