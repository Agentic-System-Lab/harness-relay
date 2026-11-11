import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  PROVIDER_LABEL,
  nativeItemCount,
  sameNativeItems,
  type NativeAgent,
  type NativeHook,
  type NativeItemKind,
  type NativeItemsOff,
  type NativeMcpServer,
  type NativeMemoryFile,
  type NativePart,
  type NativePlugin,
  type NativeSetup,
  type NativeSkill,
  type NativeTool,
  type OpenProvider,
  type Provider,
} from '../shared/types';
import {
  CLAUDE_PROBE_ARGS,
  claudeAgentDenyRules,
  claudeAgents,
  claudeBuiltinAgents,
  claudeMcpName,
  claudeNativeArgs,
  claudeNativeEnv,
  claudeNativeSettings,
  claudePlugins,
  claudeSettingsFile,
  isBuiltinAgent,
  type ClaudeBuiltinAgents,
  type ClaudePlugin,
} from './agents/claude';
import {
  codexMcpConfig,
  codexMcpOff,
  codexMcpToolId,
  codexNativeConfig,
  codexOverrideArgs,
  codexUserMcpConfig,
} from './agents/codex';
import { grokNativeEnv } from './agents/grok';
import { openAgents } from './agents/index';
import { openHomeEnv } from './agents/open';
import { parseFrontMatter } from './tools';
import { t } from './i18n';
import { converse, runProcess } from './process';
import { AGENT_HOME_ENV } from './settings';

/*
 * What each CLI loads by itself — its own skills, MCP servers, hooks, subagents, plugins and
 * memory — asked from the CLI the way an IDE would, without sending a prompt (so no model is
 * called):
 * - Claude Code: stream-json control requests `initialize` (its commands, skills among them, and
 *   subagents), `mcp_status`, `get_hooks_listing` and `get_settings` (which subagents are denied,
 *   which plugins are off), then a `/usage` turn, which Claude Code answers by itself, for the
 *   `system/init` message that lists its tools (built-in and MCP) and MCP servers; and
 *   `claude plugin list --json`. Starting it runs the user's SessionStart hooks and connects its
 *   MCP servers.
 * - Codex: `codex app-server` requests `skills/list`, `config/read` (configured MCP servers),
 *   `hooks/list`, `plugin/installed` and `mcpServerStatus/list` for each of the user's MCP servers
 *   that is on (their tools; this starts them).
 * - Grok: `grok inspect --json`.
 * - Cursor: it has no such question over ACP, so its lists come from the files it is known to read
 *   (`probeCursor`); it has no switch that leaves any of them out of one run.
 * Claude Code and Codex have no list of the instruction and memory files they read, so those come
 * from the files at the places they are documented to read. Only names, descriptions, paths and
 * states are kept: MCP server configs and hook commands (which can hold tokens) never leave this
 * module.
 *
 * When some of the CLI's own setup is left out of Harness Relay's runs (all of a kind, or single
 * items), the CLI is asked a second time the way Harness Relay starts it (the same flags, variables
 * and config overrides), and what it then leaves out is marked `leftOut`. Each item the CLI can
 * leave out alone gets the `id` it is left out by.
 */

const PROBE_TIMEOUT_MS = 30_000;

type Json = Record<string, any>;

const short = (s: string) => s.trim().split('\n').slice(-3).join(' ').slice(0, 300);

/**
 * Something a probe could not find out. Kept as data, not text: answers are cached, and the text
 * follows the language of each request (`nativeProblemText`).
 */
export type NativeProblem =
  | { kind: 'timeout' }
  | { kind: 'no-answer'; part: 'all' | 'skills' | 'mcp' | 'tools' | 'hooks' | 'agents' | 'plugins' }
  /** `refused`: the CLI refused one of the questions (or one list could not be read); its other answers stand. */
  | { kind: 'failed'; detail: string; refused?: true }
  /** Asking the CLI again the way Harness Relay starts it went wrong, so nothing is marked left out. */
  | { kind: 'as-run'; cause: NativeProblem }
  /** Asking it again ran out of time after some answers: those are marked, the rest is not. */
  | { kind: 'as-run-partial' };

/** A probe's answer before its problems are put into words. */
export type NativeProbe = Omit<NativeSetup, 'errors'> & { problems: NativeProblem[] };

/** The lists one answer gives; a list the CLI did not give is undefined. */
export type NativeLists = Pick<NativeSetup, 'skills' | 'mcpServers' | 'memory'> &
  Pick<Partial<NativeSetup>, 'hooks' | 'agents' | 'plugins' | 'builtinTools'>;

/** What a probe that ended without some answers reports: a timeout, the CLI's own words, or the parts missing. */
function missing(parts: ('skills' | 'mcp' | 'tools' | 'hooks' | 'plugins')[], all: boolean, res: { stderr: string; timedOut: boolean }): NativeProblem[] {
  if (res.timedOut) return [{ kind: 'timeout' }];
  if (all) return short(res.stderr) ? [{ kind: 'failed', detail: short(res.stderr) }] : [{ kind: 'no-answer', part: 'all' }];
  return parts.map((part) => ({ kind: 'no-answer', part }));
}

// --- Marking what Harness Relay's runs leave out ---------------------------------------------

/** How an item is matched between the two answers. */
const KEYS = {
  skills: (s: NativeSkill) => `${s.name}\0${s.path ?? ''}`,
  mcpServers: (s: NativeMcpServer) => s.name,
  memory: (m: NativeMemoryFile) => m.path,
  hooks: (h: NativeHook) => [h.event, h.matcher ?? '', h.source ?? '', h.file ?? ''].join('\0'),
  agents: (a: NativeAgent) => a.name,
  plugins: (p: NativePlugin) => p.name,
  tools: (t: NativeTool) => t.name,
};

/** Whether the CLI loads an item: not turned off (`enabled: false`, or an MCP server's `disabled` status). */
const loads = (item: object) => (item as { enabled?: boolean }).enabled !== false && (item as { status?: string }).status !== 'disabled';

/** A picked item the second answer still loads. */
const still = <T extends object>(item: T, picked: ReadonlySet<string> | undefined): T =>
  picked?.has((item as { id?: string }).id ?? '') && loads(item) && !(item as { leftOut?: boolean }).leftOut ? { ...item, stillLoaded: true } : item;

/** Marks `leftOut`, and `stillLoaded` on the items `picked` (by id) that the second answer still loads. */
function mark<T extends object>(list: T[], again: T[] | undefined, key: (item: T) => string, picked?: ReadonlySet<string>): T[];
function mark<T extends object>(list: T[] | undefined, again: T[] | undefined, key: (item: T) => string, picked?: ReadonlySet<string>): T[] | undefined;
function mark<T extends object>(list: T[] | undefined, again: T[] | undefined, key: (item: T) => string, picked?: ReadonlySet<string>): T[] | undefined {
  if (!list || !again) return list;
  const loaded = new Set(again.filter(loads).map(key));
  return list.map((item) => still(loads(item) && !loaded.has(key(item)) ? { ...item, leftOut: true } : item, picked));
}

/**
 * MCP servers marked as `mark` marks them, and also when every tool one offered is gone the second
 * time (its tools are taken away, while the server still starts). A server that stays gets its
 * tools marked, when the second answer lists them. `byTools`: a server is left out by taking away
 * its tools (Claude Code), so one is still loaded only when it had tools and still has some; else
 * (Codex) by turning it off, which the second answer shows.
 */
function markServers(
  list: NativeMcpServer[],
  again: NativeMcpServer[] | undefined,
  picked: { servers?: ReadonlySet<string>; tools?: ReadonlySet<string>; byTools?: boolean } = {},
): NativeMcpServer[] {
  if (!again) return list;
  const after = new Map(again.filter(loads).map((s) => [s.name, s]));
  return mark(list, again, KEYS.mcpServers).map((server) => {
    const then = after.get(server.name);
    const judged = !picked.byTools || Boolean(server.tools?.length && then?.tools);
    const kept = (s: NativeMcpServer) => (judged ? still(s, picked.servers) : s);
    if (server.leftOut || !server.tools || !then?.tools) return kept(server);
    const tools = mark(server.tools, then.tools, KEYS.tools, picked.tools);
    const lost = tools.length > 0 && tools.every((t) => t.leftOut || !loads(t)) && tools.some((t) => t.leftOut);
    return lost ? { ...server, tools: server.tools, leftOut: true } : kept({ ...server, tools });
  });
}

/**
 * Marks `leftOut` the items the CLI loads by itself (`own`) but not when asked the way Harness
 * Relay starts it (`asRun`): missing from that answer, or reported off in it. A list the CLI did not
 * give the second time stays unmarked. With the single items left out (`items`), those the second
 * answer still loads are marked `stillLoaded`, in the lists it gave (`serversByTools`: see
 * `markServers`).
 */
export function markLeftOut(own: NativeLists, asRun: Partial<NativeLists>, items: NativeItemsOff = {}, serversByTools = false): NativeLists {
  const ids = (kind: NativeItemKind) => (items[kind]?.length ? new Set(items[kind]) : undefined);
  return {
    skills: mark(own.skills, asRun.skills, KEYS.skills, ids('skills')),
    mcpServers: markServers(own.mcpServers, asRun.mcpServers, { servers: ids('mcp'), tools: ids('mcpTools'), byTools: serversByTools }),
    memory: mark(own.memory, asRun.memory, KEYS.memory, ids('instructions')),
    ...(own.hooks ? { hooks: mark(own.hooks, asRun.hooks, KEYS.hooks, ids('hooks')) } : {}),
    ...(own.agents ? { agents: mark(own.agents, asRun.agents, KEYS.agents, ids('agents')) } : {}),
    ...(own.plugins ? { plugins: mark(own.plugins, asRun.plugins, KEYS.plugins, ids('plugins')) } : {}),
    ...(own.builtinTools ? { builtinTools: mark(own.builtinTools, asRun.builtinTools, KEYS.tools, ids('tools')) } : {}),
  };
}

/** A list for the second answer: undefined when the CLI did not give it then. */
const given = <T>(answered: unknown, list: T[] | undefined): T[] | undefined => (answered ? list : undefined);

/** The parts and kinds of single items that change each list: a list nothing left out touches needs no second look. */
const TOUCHED_BY: Record<'skills' | 'mcp' | 'tools' | 'hooks' | 'agents' | 'plugins', [NativePart[], NativeItemKind[]]> = {
  skills: [['skills', 'plugins'], ['skills', 'plugins']],
  mcp: [['mcp', 'plugins'], ['mcp', 'mcpTools', 'plugins']],
  tools: [['tools'], ['tools']],
  hooks: [['hooks', 'plugins'], ['hooks', 'plugins']],
  agents: [['agents', 'plugins'], ['agents', 'plugins']],
  plugins: [['plugins'], ['plugins']],
};

/** Whether what is left out changes a list. */
const touches = (off: readonly NativePart[], items: NativeItemsOff, list: keyof typeof TOUCHED_BY) =>
  TOUCHED_BY[list][0].some((p) => off.includes(p)) || TOUCHED_BY[list][1].some((k) => items[k]?.length);

/** Problems for the lists the second answer lacked (so they are not marked), among those what is left out touches. */
const unmarked = (off: readonly NativePart[], items: NativeItemsOff, lists: [unknown, keyof typeof TOUCHED_BY][]): NativeProblem[] =>
  lists
    .filter(([lacking, part]) => lacking && touches(off, items, part))
    .map(([, part]) => ({ kind: 'as-run', cause: { kind: 'no-answer', part } }));

// --- Claude Code ---------------------------------------------------------------------------

/**
 * What Claude Code answered to `initialize`, `mcp_status`, `get_hooks_listing` and `get_settings`,
 * and its `system/init` message for a `/usage` turn (`session`: its tools and MCP servers).
 */
export interface ClaudeAnswers {
  init?: Json;
  mcp?: Json;
  hooks?: Json;
  settings?: Json;
  session?: Json;
}

/** An MCP server's permission rule in Claude Code, `mcp__<server>`: it takes away all of the server's tools. */
const claudeServerId = (server: string) => `mcp__${claudeMcpName(server)}`;

/**
 * The MCP servers from `mcp_status`, with those only the `system/init` message names (it comes after
 * Claude Code waited for its servers to connect, so its status is the later one), and their tools:
 * the init message's `mcp__<server>__<tool>` names by server (the longest server name that fits),
 * else the tools `mcp_status` names. A tool of a server neither lists gets a server of its own.
 */
function claudeMcpServers(a: ClaudeAnswers): NativeMcpServer[] {
  const list = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
  const servers = new Map<string, NativeMcpServer>();
  const tool = (server: string, name: string): NativeTool => ({ name, id: `${claudeServerId(server)}__${name}` });
  for (const s of list(a.mcp?.mcpServers).filter((s) => typeof s.name === 'string')) {
    servers.set(s.name, {
      name: s.name,
      id: claudeServerId(s.name),
      ...(typeof s.status === 'string' ? { status: s.status } : {}),
      ...(typeof (s.scope ?? s.source) === 'string' ? { source: String(s.scope ?? s.source) } : {}),
      ...(typeof (s.transport ?? s.config?.type) === 'string' ? { transport: String(s.transport ?? s.config?.type) } : {}),
      ...(Array.isArray(s.tools) ? { tools: s.tools.filter((t: Json) => typeof t?.name === 'string').map((t: Json) => tool(s.name, t.name)) } : {}),
    });
  }
  for (const s of list(a.session?.mcp_servers).filter((s) => typeof s.name === 'string')) {
    const known = servers.get(s.name);
    servers.set(s.name, {
      ...(known ?? { name: s.name, id: claudeServerId(s.name) }),
      ...(typeof s.status === 'string' ? { status: s.status } : {}),
      ...(!known?.source && typeof s.source === 'string' ? { source: s.source } : {}),
    });
  }
  if (!Array.isArray(a.session?.tools)) return [...servers.values()];
  const names = (a.session!.tools as unknown[]).filter((t): t is string => typeof t === 'string' && t.startsWith('mcp__'));
  const prefixes = [...servers.keys()].map((name) => [name, `${claudeServerId(name)}__`] as const).sort((x, y) => y[1].length - x[1].length);
  const tools = new Map<string, NativeTool[]>();
  for (const full of names) {
    let server = prefixes.find(([, prefix]) => full.startsWith(prefix))?.[0];
    if (!server) {
      server = full.match(/^mcp__(.+?)__./)?.[1];
      if (!server) continue;
      if (!servers.has(server)) servers.set(server, { name: server, id: `mcp__${server}` });
    }
    const id = servers.get(server)!.id!;
    tools.set(server, [...(tools.get(server) ?? []), { name: full.slice(id.length + 2), id: full }]);
  }
  // The init message lists each connected server's tools: one it gives none of has none.
  return [...servers.values()].map((s) => (tools.has(s.name) || s.status === 'connected' ? { ...s, tools: tools.get(s.name) ?? [] } : s));
}

/** The subagents a permission rule denies (`Agent(name)`, or `Task(name)` from older versions). */
function deniedAgents(settings: Json | undefined): Set<string> {
  const deny: unknown = settings?.effective?.permissions?.deny;
  const names = (Array.isArray(deny) ? deny : []).map((r) => (typeof r === 'string' ? r.match(/^(?:Agent|Task)\((.+)\)$/)?.[1] : undefined));
  return new Set(names.filter((n): n is string => Boolean(n)));
}

/**
 * Skills (and the other non-built-in commands), MCP servers, hooks and subagents from Claude Code's
 * control responses, its built-in and MCP tools from its `system/init` message, and its plugins
 * from `claude plugin list --json`. Its effective settings say which subagents are denied and which
 * plugins are off; `builtins` names its built-in subagents with their descriptions. Every item but
 * a hook gets the id it is left out by.
 */
export function parseClaudeProbe(
  a: ClaudeAnswers,
  plugins?: readonly ClaudePlugin[],
  builtins?: ClaudeBuiltinAgents,
): Pick<NativeLists, 'skills' | 'mcpServers' | 'hooks' | 'agents' | 'plugins' | 'builtinTools'> {
  const list = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
  const effective: Json | undefined = a.settings?.effective;
  const denied = deniedAgents(a.settings);
  const pluginsOff: Json = effective?.enabledPlugins && typeof effective.enabledPlugins === 'object' ? effective.enabledPlugins : {};
  return {
    skills: list(a.init?.commands)
      .filter((c) => !c.builtin && typeof c.name === 'string')
      .map((c) => ({ name: c.name, description: String(c.description ?? ''), id: c.name })),
    mcpServers: claudeMcpServers(a),
    ...(Array.isArray(a.session?.tools)
      ? {
          builtinTools: (a.session!.tools as unknown[])
            .filter((t): t is string => typeof t === 'string' && !t.startsWith('mcp__'))
            .map((name) => ({ name, id: name })),
        }
      : {}),
    ...(a.hooks
      ? {
          hooks: list(a.hooks.hooks)
            .filter((h) => typeof h.event === 'string')
            .map((h) => ({
              event: h.event,
              ...(typeof h.matcher === 'string' && h.matcher ? { matcher: h.matcher } : {}),
              ...(typeof h.pluginName === 'string' ? { source: `plugin: ${h.pluginName}` } : typeof h.source === 'string' ? { source: h.source } : {}),
              ...(h.disabled === true ? { enabled: false } : {}),
            })),
        }
      : {}),
    ...(Array.isArray(a.init?.agents)
      ? {
          agents: list(a.init!.agents)
            .filter((g) => typeof g.name === 'string')
            .map((g) => ({
              name: g.name,
              description: String(g.description ?? ''),
              id: g.name,
              // A subagent of the same name that replaces a built-in one has its own description.
              ...(builtins && isBuiltinAgent({ name: g.name, description: String(g.description ?? '') }, builtins) ? { source: 'built-in' } : {}),
              ...(denied.has(g.name) ? { enabled: false } : {}),
            })),
        }
      : {}),
    ...(plugins
      ? {
          plugins: plugins.map((p) => ({
            name: p.id,
            id: p.id,
            ...(p.scope ? { source: p.scope } : {}),
            ...(p.enabled === false || pluginsOff[p.id] === false ? { enabled: false } : {}),
          })),
        }
      : {}),
  };
}

/** The folders from `cwd` up to the filesystem root, nearest first. */
function upFrom(cwd: string): string[] {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) return dirs;
  }
}

/** The repository root above `cwd` (a folder with `.git`), if any. */
function gitRoot(cwd: string): string | undefined {
  return upFrom(cwd).find((d) => existsSync(join(d, '.git')));
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The Markdown files directly in a folder. */
function markdownIn(dir: string, limit = 50): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.md'))
      .sort()
      .slice(0, limit)
      .map((n) => join(dir, n))
      .filter(isFile);
  } catch {
    return [];
  }
}

/** Claude Code's project folder name for a path (every character but letters and digits becomes `-`). */
export const claudeProjectSlug = (path: string) => resolve(path).replace(/[^A-Za-z0-9]/g, '-');

/**
 * The instruction and memory files Claude Code reads for `cwd`: CLAUDE.md and rules in its config
 * folder, CLAUDE.md / CLAUDE.local.md / .claude/CLAUDE.md / .claude/rules in each folder up from
 * `cwd`, and its auto memory for the project.
 */
export function claudeMemoryFiles(cwd: string, configDir: string): NativeMemoryFile[] {
  const instructions = [join(configDir, 'CLAUDE.md'), ...markdownIn(join(configDir, 'rules'))];
  for (const dir of upFrom(cwd).reverse()) {
    instructions.push(join(dir, 'CLAUDE.md'), join(dir, 'CLAUDE.local.md'), join(dir, '.claude', 'CLAUDE.md'));
    instructions.push(...markdownIn(join(dir, '.claude', 'rules')));
  }
  const roots = [...new Set([resolve(cwd), gitRoot(cwd)].filter((d): d is string => Boolean(d)))];
  const memory = roots.flatMap((d) => markdownIn(join(configDir, 'projects', claudeProjectSlug(d), 'memory')));
  return [
    // An instruction file can be left out alone, by its path (`claudeMdExcludes`).
    ...[...new Set(instructions)].filter(isFile).map((path) => ({ path, kind: 'instructions' as const, id: path })),
    ...[...new Set(memory)].map((path) => ({ path, kind: 'memory' as const })),
  ];
}

/**
 * Claude Code's files as it reads them with these variables and these instruction files excluded:
 * none of a kind its variable turns off, nor an excluded file.
 */
export function claudeMemoryState(files: NativeMemoryFile[], env: NodeJS.ProcessEnv, excluded: readonly string[] = []): NativeMemoryFile[] {
  const off = (f: NativeMemoryFile) =>
    Boolean(env[f.kind === 'memory' ? 'CLAUDE_CODE_DISABLE_AUTO_MEMORY' : 'CLAUDE_CODE_DISABLE_CLAUDE_MDS']) ||
    (f.kind === 'instructions' && excluded.includes(f.path));
  return files.map((f) => (off(f) ? { ...f, enabled: false } : f));
}

type ClaudeRequest = Json | ((answers: (Json | undefined)[]) => Json | undefined);

/** One exchange with a CLI: its answers, and its words for the questions it refused. */
interface Asked<A, K extends PropertyKey> {
  answers: A;
  errors: Partial<Record<K, string>>;
  res: { stderr: string; timedOut: boolean };
}

/**
 * The prompt of the turn that asks Claude Code for its tools: `/usage`, a command it answers by
 * itself (no model is called, nothing is spent), whose `system/init` message lists its tools.
 */
export const CLAUDE_TOOLS_TURN = '/usage';

/**
 * Whether `/usage` is Claude Code's own command in this `initialize` answer, and no skill or command
 * of that name replaces it: only then may it be sent, since anything else would go to the model.
 */
export function claudeAnswersUsage(init: Json | undefined): boolean {
  const commands = Array.isArray(init?.commands) ? (init.commands as Json[]) : [];
  const usage = commands.filter((c) => c?.name === 'usage');
  return usage.length > 0 && usage.every((c) => c.builtin === true);
}

/**
 * Claude Code's answers to control requests sent one after another; a function makes its request
 * from the answers so far (or none). Answers line up with the requests (undefined when skipped,
 * refused or not answered). With `turn` saying yes to the answers, a `/usage` turn follows, without
 * a session file, and its `system/init` message is the `session` answer; Claude Code is stopped as
 * soon as it comes. A Claude Code that does not know `--no-session-persistence` is asked again
 * without the turn.
 */
async function askClaude(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
  requests: ClaudeRequest[],
  turn?: (answers: (Json | undefined)[]) => boolean,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Asked<(Json | undefined)[], number> & { session?: Json }> {
  const ask = async (withTurn: boolean) => {
    const answers: (Json | undefined)[] = [];
    const errors: Record<number, string> = {};
    let session: Json | undefined;
    let waiting = false;
    let at = 0;
    const next = (write: (msg: unknown) => void, finish: () => void) => {
      for (; at < requests.length; at++) {
        const r = requests[at]!;
        const request = typeof r === 'function' ? r(answers) : r;
        if (request) return write({ type: 'control_request', request_id: `relay-${at}`, request });
      }
      if (withTurn && turn!(answers)) {
        waiting = true;
        return write({ type: 'user', message: { role: 'user', content: CLAUDE_TOOLS_TURN } });
      }
      finish();
    };
    const res = await converse({
      bin,
      args: [...CLAUDE_PROBE_ARGS, ...(withTurn ? ['--no-session-persistence'] : []), ...args],
      cwd,
      env,
      timeoutMs,
      open: (write) => next(write, () => undefined),
      onMessage: (m, write, finish) => {
        if (waiting) {
          if (m.type === 'system' && m.subtype === 'init') session = m;
          if (session || m.type === 'result') finish();
          return;
        }
        if (m.type !== 'control_response' || m.response?.request_id !== `relay-${at}`) return;
        const r = m.response;
        if (r.subtype === 'error') errors[at] = String(r.error ?? 'error');
        else answers[at] = r.response ?? {};
        at++;
        next(write, finish);
      },
    });
    return { answers, errors, res, session };
  };
  if (!turn) return ask(false);
  const first = await ask(true);
  if (!first.answers.some(Boolean) && /unknown option.*no-session-persistence/i.test(first.res.stderr)) return ask(false);
  return first;
}

/** The CLI's words for the questions it refused, as problems. */
const refused = (errors: Partial<Record<PropertyKey, string>>): NativeProblem[] =>
  Object.values(errors).map((detail) => ({ kind: 'failed', detail: String(detail), refused: true }));

const CLAUDE_ASKS = {
  init: { subtype: 'initialize' },
  mcp: { subtype: 'mcp_status' },
  hooks: { subtype: 'get_hooks_listing' },
  settings: { subtype: 'get_settings' },
};

async function probeClaude(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  off: readonly NativePart[],
  items: NativeItemsOff,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<NativeProbe> {
  const { answers, errors, res, session } = await askClaude(
    bin,
    env,
    cwd,
    [],
    [CLAUDE_ASKS.init, CLAUDE_ASKS.mcp, CLAUDE_ASKS.hooks, CLAUDE_ASKS.settings],
    (got) => claudeAnswersUsage(got[0]),
    timeoutMs,
  );
  const [init, mcp, hooks, settings] = answers;
  const problems = refused(errors);
  const unanswered = (i: number) => !answers[i] && errors[i] === undefined;
  problems.push(
    ...missing(
      [...(unanswered(0) ? ['skills' as const] : []), ...(unanswered(1) ? ['mcp' as const] : []), ...(unanswered(2) ? ['hooks' as const] : [])],
      !init && !mcp && !hooks,
      res,
    ),
  );
  // Without the turn's answer there is no list of its tools (a skill named "usage" means it is not asked).
  if (init && !session && !res.timedOut) problems.push({ kind: 'no-answer', part: 'tools' });
  // Only when it started: otherwise these would fail the same way.
  let plugins: ClaudePlugin[] | undefined;
  let pluginsError: string | undefined;
  let builtins: ClaudeBuiltinAgents | undefined;
  let builtinsError: string | undefined;
  if (init) {
    try {
      plugins = await claudePlugins(bin, env, cwd);
    } catch (err) {
      pluginsError = (err as Error).message;
      problems.push({ kind: 'no-answer', part: 'plugins' });
    }
    const version = typeof init.claude_code_version === 'string' ? init.claude_code_version : undefined;
    builtins = await claudeBuiltinAgents(bin, env, version).catch((err: Error) => {
      builtinsError = err.message;
      return undefined;
    });
    // Without them no subagent is marked built-in; with subagents left out, the second ask says so instead.
    if (builtinsError !== undefined && !off.includes('agents')) problems.push({ kind: 'failed', detail: builtinsError, refused: true });
  }
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const files = claudeMemoryFiles(cwd, configDir);
  let lists: NativeLists = {
    ...parseClaudeProbe({ init, mcp, hooks, settings, session }, plugins, builtins),
    memory: claudeMemoryState(files, env),
  };

  let asRun = false;
  const runEnv = { ...env, ...claudeNativeEnv(off) };
  const excluded = off.includes('instructions') ? [] : (items.instructions ?? []);
  const anything = off.length > 0 || nativeItemCount(items) > 0;
  const onlyFiles = off.every((p) => p === 'instructions' || p === 'memory') && Object.keys(items).every((k) => k === 'instructions');
  if (anything && init && onlyFiles) {
    // Only files left out, through variables and settings: no need to start Claude Code (and run its hooks) again.
    lists = markLeftOut(lists, { memory: claudeMemoryState(files, runEnv, excluded) }, items);
    asRun = true;
  } else if (anything && init) {
    // The run's own steps: it cannot leave out plugins it cannot list, or subagents it cannot tell from built-in ones.
    const cannot =
      off.includes('plugins') && !plugins ? pluginsError : off.includes('agents') && !builtins ? (builtinsError ?? 'no answer') : undefined;
    if (cannot !== undefined) {
      problems.push({ kind: 'as-run', cause: { kind: 'failed', detail: cannot } });
    } else {
      // Denied as a run denies them: only when some are not built in.
      const deny = (got: (Json | undefined)[]) => {
        const agents = off.includes('agents') && got[0] ? claudeAgents(got[0]) : undefined;
        const rules = agents ? claudeAgentDenyRules(agents, builtins!) : [];
        return rules.length ? { subtype: 'apply_flag_settings', settings: { permissions: { deny: rules } } } : undefined;
      };
      const pluginIds = (plugins ?? []).map((p) => p.id);
      const settingsFile = claudeSettingsFile(claudeNativeSettings(off, pluginIds, items));
      const args = claudeNativeArgs(off, pluginIds, items, settingsFile?.file);
      const again = await askClaude(
        bin,
        runEnv,
        cwd,
        args,
        [CLAUDE_ASKS.init, deny, CLAUDE_ASKS.mcp, CLAUDE_ASKS.hooks, CLAUDE_ASKS.settings],
        // Checked again: only when it was sent the first time, and `/usage` is still Claude Code's own
        // command. With all skills left out it lists no commands, built-in ones included, but answers
        // `/usage` by itself all the same, and no skill can take its name.
        session ? (got) => claudeAnswersUsage(got[0]) || args.includes('--disable-slash-commands') : undefined,
        timeoutMs,
      ).finally(() => settingsFile?.remove());
      const [init2, , mcp2, hooks2, settings2] = again.answers;
      // Without its answer to `initialize`, or with its subagents not denied, there is nothing to compare.
      const cause: NativeProblem | undefined = !init2
        ? again.res.timedOut
          ? { kind: 'timeout' }
          : (refused(again.errors)[0] ?? missing([], true, again.res)[0])
        : off.includes('agents') && !claudeAgents(init2)
            ? { kind: 'no-answer', part: 'agents' }
            : again.errors[1] !== undefined
              ? { kind: 'failed', detail: again.errors[1] }
              : undefined;
      if (cause) {
        problems.push({ kind: 'as-run', cause });
      } else {
        const parsed = parseClaudeProbe({ init: init2, mcp: mcp2, hooks: hooks2, settings: settings2, session: again.session }, plugins, builtins);
        lists = markLeftOut(
          lists,
          {
            skills: parsed.skills,
            // Like for like: with the turn's answer the first time (servers and their tools), only with it again.
            mcpServers: given(session ? again.session : mcp2, parsed.mcpServers),
            hooks: given(hooks2, parsed.hooks),
            agents: given(settings2, parsed.agents),
            plugins: given(settings2, parsed.plugins),
            builtinTools: given(again.session, parsed.builtinTools),
            memory: claudeMemoryState(files, runEnv, excluded),
          },
          items,
          true,
        );
        asRun = true;
        // Out of time after `initialize`: what came is marked, and the lists that did not are named below.
        if (again.res.timedOut) problems.push({ kind: 'as-run-partial' });
        // A list the second answer lacks stays unmarked: say so, rather than let it look all loaded.
        problems.push(
          ...unmarked(off, items, [
            [session ? !again.session : mcp && !mcp2, 'mcp'],
            [lists.builtinTools && !again.session, 'tools'],
            [hooks && !hooks2, 'hooks'],
            [lists.agents && !settings2, 'agents'],
            [lists.plugins && !settings2, 'plugins'],
          ]),
        );
      }
    }
  }
  return {
    provider: 'claude',
    cwd,
    ...lists,
    memoryFromFiles: true,
    nativeOff: [...off],
    nativeItems: items,
    asRun,
    problems,
    checkedAt: Date.now(),
  };
}

// --- Codex ---------------------------------------------------------------------------------

/**
 * What `codex app-server` answered to `skills/list`, `config/read`, `hooks/list` and
 * `plugin/installed`, and to `mcpServerStatus/list` for each of the user's MCP servers that is on
 * (`mcpStatus`, by server).
 */
export interface CodexAnswers {
  skills?: Json;
  config?: Json;
  hooks?: Json;
  plugins?: Json;
  mcpStatus?: Record<string, Json>;
}

/**
 * Skills (once each), configured MCP servers (names and kinds only) with the tools each offers,
 * hooks and installed plugins from Codex's answers. With `skills.include_instructions` off, Codex
 * no longer lists its skills to the model, so they count as off. Skills get their path as the id
 * they are left out by, MCP servers their name, their tools `codexMcpToolId`, hooks their key and
 * plugins their id.
 */
export function parseCodexProbe(a: CodexAnswers): Pick<NativeLists, 'skills' | 'mcpServers' | 'hooks' | 'plugins'> {
  const list = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
  const config: Json | undefined = a.config?.config;
  const unlisted = config?.skills?.include_instructions === false;
  const seen = new Set<string>();
  const skills: NativeSkill[] = [];
  for (const s of list(a.skills?.data).flatMap((e) => list(e.skills))) {
    if (typeof s?.name !== 'string' || seen.has(`${s.name}\0${s.path}`)) continue;
    seen.add(`${s.name}\0${s.path}`);
    skills.push({
      name: s.name,
      description: String(s.shortDescription || s.description || ''),
      ...(typeof s.scope === 'string' ? { source: s.scope } : {}),
      ...(typeof s.path === 'string' ? { path: s.path, id: s.path } : {}),
      ...(s.enabled === false || unlisted ? { enabled: false } : {}),
    });
  }
  const servers = config?.mcp_servers;
  // The tools of a server Codex started, by name (its answer keys them by name).
  const tools = (name: string): NativeTool[] | undefined => {
    // Its tools as Codex lists them, without those its config turns off: the config is not read for them,
    // so a Codex that ignored `disabled_tools` shows them still there.
    const found = list(a.mcpStatus?.[name]?.data).find((d) => d?.name === name);
    // One that failed to start lists none: its tools are not known, rather than none.
    if (!found || !found.tools || typeof found.tools !== 'object' || (found.toolsError && !Object.keys(found.tools).length)) return undefined;
    return Object.keys(found.tools as Json).map((tool) => ({ name: tool, id: codexMcpToolId(name, tool) }));
  };
  // Once each: an answer has an entry per folder asked about.
  const hooks = new Map<string, Json>();
  for (const h of list(a.hooks?.data).flatMap((e) => list(e.hooks))) {
    if (typeof h.eventName === 'string') hooks.set(String(h.key ?? JSON.stringify([h.eventName, h.matcher, h.sourcePath, h.pluginId])), h);
  }
  return {
    skills,
    mcpServers:
      servers && typeof servers === 'object'
        ? Object.entries(servers as Record<string, Json>).map(([name, c]) => {
            const offered = tools(name);
            return {
              name,
              id: name,
              transport: c?.url ? 'http' : 'stdio',
              ...(c?.enabled === false ? { status: 'disabled' } : {}),
              ...(offered ? { tools: offered } : {}),
            };
          })
        : [],
    ...(a.hooks
      ? {
          hooks: [...hooks.values()].map((h) => ({
              event: h.eventName,
              ...(typeof h.key === 'string' ? { id: h.key } : {}),
              ...(typeof h.matcher === 'string' && h.matcher ? { matcher: h.matcher } : {}),
              ...(typeof h.pluginId === 'string' ? { source: `plugin: ${h.pluginId}` } : typeof h.source === 'string' ? { source: h.source } : {}),
              ...(typeof h.sourcePath === 'string' ? { file: h.sourcePath } : {}),
              ...(h.enabled === false ? { enabled: false } : {}),
            })),
        }
      : {}),
    ...(a.plugins
      ? {
          plugins: list(a.plugins.marketplaces).flatMap((m) =>
            list(m.plugins)
              .filter((p) => p.installed === true && typeof (p.id ?? p.name) === 'string')
              .map((p) => ({
                name: String(p.id ?? p.name),
                id: String(p.id ?? p.name),
                ...(typeof m.name === 'string' ? { source: m.name } : {}),
                ...(p.enabled === false ? { enabled: false } : {}),
              })),
          ),
        }
      : {}),
  };
}

/**
 * The instruction files Codex reads for `cwd`: AGENTS.override.md or AGENTS.md in its home, then in
 * each folder from the repository root down to `cwd`; and the notes in its memories folder.
 */
export function codexMemoryFiles(cwd: string, codexHome: string): NativeMemoryFile[] {
  const pick = (dir: string) => [join(dir, 'AGENTS.override.md'), join(dir, 'AGENTS.md')].find(isFile);
  const root = gitRoot(cwd) ?? resolve(cwd);
  const dirs = upFrom(cwd).filter((d) => d.startsWith(root)).reverse();
  const instructions = [pick(codexHome), ...dirs.map(pick)].filter((p): p is string => Boolean(p));
  return [
    ...instructions.map((path) => ({ path, kind: 'instructions' as const })),
    ...markdownIn(join(codexHome, 'memories')).map((path) => ({ path, kind: 'memory' as const })),
  ];
}

/**
 * Codex's files as it reads them with this config (a `config/read` answer): with
 * `project_doc_max_bytes = 0` not the project's AGENTS.md files (its home's still), and without the
 * memories feature not its memories.
 */
export function codexMemoryState(files: NativeMemoryFile[], codexHome: string, read: Json | undefined): NativeMemoryFile[] {
  const config: Json = read?.config ?? {};
  const off = (f: NativeMemoryFile) =>
    f.kind === 'memory' ? config.features?.memories === false : config.project_doc_max_bytes === 0 && dirname(f.path) !== resolve(codexHome);
  return files.map((f) => (off(f) ? { ...f, enabled: false } : f));
}

/**
 * Codex's answers to its four questions, from an app-server started with `preArgs` (config
 * overrides); then, once `config/read` has answered, the tools of each of the user's MCP servers
 * that is on (`mcpServerStatus/list`, one server at a time: asking starts it).
 */
async function askCodex(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  preArgs: string[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Asked<CodexAnswers, keyof CodexAnswers>> {
  const asks: [keyof CodexAnswers | string, string, unknown][] = [
    ['skills', 'skills/list', { cwds: [cwd] }],
    ['config', 'config/read', { cwd }],
    ['hooks', 'hooks/list', { cwds: [cwd] }],
    ['plugins', 'plugin/installed', { cwds: [cwd] }],
  ];
  const answers: CodexAnswers = {};
  const errors: Partial<Record<keyof CodexAnswers, string>> = {};
  let pending = asks.length;
  const send = (write: (msg: unknown) => void, from: number) =>
    asks.slice(from).forEach(([, method, params], i) => write({ jsonrpc: '2.0', id: from + i + 1, method, params }));
  const res = await converse({
    bin,
    args: [...preArgs, 'app-server'],
    cwd,
    env,
    timeoutMs,
    open: (write) =>
      write({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'harness_relay', title: 'Harness Relay', version: '0.1.0' }, capabilities: null } }),
    onMessage: (m, write, finish) => {
      if (m.id === undefined || m.method) return;
      if (m.id === 0) {
        write({ jsonrpc: '2.0', method: 'initialized' });
        send(write, 0);
        return;
      }
      const ask = asks[Number(m.id) - 1];
      if (!ask) return;
      const [key] = ask;
      if (key.startsWith('mcp:')) {
        // A server that does not answer has no tools listed; that is not a problem of the whole answer.
        if (!m.error) answers.mcpStatus = { ...answers.mcpStatus, [key.slice(4)]: m.result ?? {} };
      } else if (m.error) errors[key as keyof CodexAnswers] = String(m.error.message ?? 'error');
      else answers[key as Exclude<keyof CodexAnswers, 'mcpStatus'>] = m.result ?? {};
      if (key === 'config' && m.result) {
        const servers = (m.result?.config?.mcp_servers ?? {}) as Record<string, Json>;
        const on = Object.entries(servers).filter(([, c]) => c?.enabled !== false).map(([name]) => name);
        const from = asks.length;
        asks.push(...on.map((name): [string, string, unknown] => [`mcp:${name}`, 'mcpServerStatus/list', { serverName: name, detail: 'toolsAndAuthOnly' }]));
        pending += on.length;
        send(write, from);
      }
      if (--pending === 0) finish();
    },
  });
  return { answers, errors, res };
}

async function probeCodex(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  off: readonly NativePart[],
  items: NativeItemsOff,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<NativeProbe> {
  const { answers, errors, res } = await askCodex(bin, env, cwd, [], timeoutMs);
  const problems = refused(errors);
  const unanswered = (k: keyof CodexAnswers) => !answers[k] && errors[k] === undefined;
  problems.push(
    ...missing(
      [
        ...(unanswered('skills') ? ['skills' as const] : []),
        ...(unanswered('config') ? ['mcp' as const] : []),
        ...(unanswered('hooks') ? ['hooks' as const] : []),
        ...(unanswered('plugins') ? ['plugins' as const] : []),
      ],
      !answers.skills && !answers.config && !answers.hooks && !answers.plugins,
      res,
    ),
  );
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  const files = codexMemoryFiles(cwd, home);
  let lists: NativeLists = { ...parseCodexProbe(answers), memory: codexMemoryState(files, home, answers.config) };

  let asRun = false;
  const mcpLeftOut = off.includes('mcp') || Boolean(items.mcp?.length || items.mcpTools?.length);
  if ((off.length || nativeItemCount(items)) && (answers.skills || answers.config)) {
    if (mcpLeftOut && !answers.config) {
      // The run itself fails when Codex cannot list its MCP servers.
      problems.push({ kind: 'as-run', cause: { kind: 'no-answer', part: 'mcp' } });
    } else {
      // The overrides a thread of the run gets, here for the whole app-server.
      const mcpOff = codexMcpOff(off, items, codexUserMcpConfig(answers.config));
      const overrides = { ...codexNativeConfig(off, items), ...codexMcpConfig([], false, mcpOff.turnOff, mcpOff.toolsOff) };
      const again = await askCodex(bin, env, cwd, codexOverrideArgs(overrides), timeoutMs);
      const a = again.answers;
      // A question it refused leaves that list unmarked; no answer at all (overrides it would not start with, say) marks nothing.
      const cause: NativeProblem | undefined =
        a.skills || a.config ? undefined : again.res.timedOut ? { kind: 'timeout' } : (refused(again.errors)[0] ?? missing([], true, again.res)[0]);
      if (cause) {
        problems.push({ kind: 'as-run', cause });
      } else {
        const parsed = parseCodexProbe(a);
        lists = markLeftOut(
          lists,
          {
            skills: given(a.skills, parsed.skills),
            mcpServers: given(a.config, parsed.mcpServers),
            hooks: parsed.hooks,
            plugins: parsed.plugins,
            memory: given(a.config, codexMemoryState(files, home, a.config)),
          },
          items,
        );
        asRun = true;
        // Out of time (a server slow to list its tools, say): what came is marked, the rest is not.
        if (again.res.timedOut) problems.push({ kind: 'as-run-partial' });
        problems.push(
          ...unmarked(off, items, [
            [answers.skills && !a.skills, 'skills'],
            [answers.config && !a.config, 'mcp'],
            [answers.hooks && !a.hooks, 'hooks'],
            [answers.plugins && !a.plugins, 'plugins'],
          ]),
        );
      }
    }
  }
  return {
    provider: 'codex',
    cwd,
    ...lists,
    memoryFromFiles: true,
    nativeOff: [...off],
    nativeItems: items,
    asRun,
    problems,
    checkedAt: Date.now(),
  };
}

// --- Grok ----------------------------------------------------------------------------------

/**
 * A folder as Grok's trust store names it: `grok inspect` writes the project root with a trailing
 * `/` that the store leaves out. Grok keys trust on the project root (the repository root, links
 * resolved), else on the folder it ran in (also a real path); outside a repository, trust in a
 * parent folder does not count.
 */
function grokTrustFolder(dir: unknown): string | undefined {
  if (typeof dir !== 'string' || !dir) return undefined;
  const trimmed = dir.length > 1 ? dir.replace(/[\\/]+$/, '') : dir;
  // `C:\` keeps its separator: without it the path would mean the current folder on that drive.
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed || undefined;
}

/**
 * Skills, MCP servers, hooks, subagents, plugins and instruction files from `grok inspect --json`.
 * Grok lists what it turned off with `disabled: true`.
 */
export function parseGrokInspect(
  d: Json | undefined,
): Pick<NativeSetup, 'skills' | 'mcpServers' | 'memory' | 'hooks' | 'agents' | 'plugins' | 'folderTrusted' | 'trustFolder' | 'trustFolderAbove'> {
  const trustFolder = grokTrustFolder(d?.projectRoot) ?? grokTrustFolder(d?.cwd);
  const ranIn = grokTrustFolder(d?.cwd);
  const list = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
  const source = (s: Json | undefined) =>
    s?.plugin_name ? `plugin: ${s.plugin_name}` : s?.type === 'builtin' ? 'built-in' : typeof s?.type === 'string' ? s.type : undefined;
  const state = (x: Json) => (x.disabled === true || x.enabled === false ? { enabled: false } : {});
  return {
    skills: list(d?.skills)
      .filter((s) => typeof s.name === 'string')
      .map((s) => ({
        name: s.name,
        description: String(s.description ?? ''),
        ...(source(s.source) ? { source: source(s.source) } : {}),
        ...(typeof s.source?.path === 'string' ? { path: s.source.path } : {}),
        ...state(s),
      })),
    mcpServers: list(d?.mcpServers)
      .filter((s) => typeof s.name === 'string')
      .map((s) => ({
        name: s.name,
        ...(typeof s.transport === 'string' ? { transport: s.transport } : {}),
        ...(source(s.source) ? { source: source(s.source) } : {}),
        ...state(s),
      })),
    memory: list(d?.projectInstructions)
      .filter((p) => typeof p.path === 'string')
      .map((p) => ({ path: p.path, kind: 'instructions' as const })),
    ...(d
      ? {
          hooks: list(d.hooks)
            .filter((h) => typeof h.event === 'string')
            .map((h) => ({
              event: h.event,
              ...(typeof h.matcher === 'string' && h.matcher ? { matcher: h.matcher } : {}),
              ...(source(h.source) ? { source: source(h.source) } : {}),
              // A file hook names its file; another kind's target is its command, which is not shown.
              ...(h.hookType === 'file' && typeof h.target === 'string' ? { file: h.target } : {}),
              ...state(h),
            })),
          agents: list(d.agents)
            .filter((g) => typeof g.name === 'string')
            .map((g) => ({ name: g.name, description: String(g.description ?? ''), ...(source(g.source) ? { source: source(g.source) } : {}), ...state(g) })),
          plugins: list(d.plugins)
            .filter((p) => typeof p.name === 'string')
            .map((p) => ({ name: p.name, ...(typeof p.scope === 'string' ? { source: p.scope } : {}), ...state(p) })),
        }
      : {}),
    ...(typeof d?.projectTrusted === 'boolean' ? { folderTrusted: d.projectTrusted } : {}),
    ...(trustFolder ? { trustFolder } : {}),
    ...(trustFolder && ranIn && trustFolder !== ranIn ? { trustFolderAbove: true } : {}),
  };
}

async function inspectGrok(bin: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ data?: Json; problems: NativeProblem[] }> {
  const res = await runProcess({ bin, args: ['inspect', '--json'], cwd, env, timeoutMs, maxCapture: 20 * 1024 * 1024 });
  try {
    return { data: JSON.parse(res.stdout) as Json, problems: [] };
  } catch {
    return { problems: missing([], true, res) };
  }
}

async function probeGrok(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  off: readonly NativePart[],
  items: NativeItemsOff,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<NativeProbe> {
  const { data, problems } = await inspectGrok(bin, env, cwd, timeoutMs);
  const own = parseGrokInspect(data);
  let lists: NativeLists = own;
  let asRun = false;
  if (off.length && data) {
    const again = await inspectGrok(bin, { ...env, ...grokNativeEnv(off) }, cwd, timeoutMs);
    if (!again.data) {
      problems.push({ kind: 'as-run', cause: again.problems[0] ?? { kind: 'no-answer', part: 'all' } });
    } else {
      lists = markLeftOut(lists, parseGrokInspect(again.data));
      asRun = true;
    }
  }
  return { provider: 'grok', cwd, ...own, ...lists, memoryFromFiles: false, nativeOff: [...off], nativeItems: items, asRun, problems, checkedAt: Date.now() };
}

/**
 * An open agent: its adapter's probe (`OpenAgentDefinition.native`), else an answer that says Harness
 * Relay cannot list what it loads yet. Nothing is left out of its runs until its adapter can
 * (NATIVE_OFF_SUPPORT is empty for it), so it is asked once.
 */
function probeOpen(provider: OpenProvider) {
  return async (bin: string, env: NodeJS.ProcessEnv, cwd: string, off: readonly NativePart[], items: NativeItemsOff, timeoutMs = PROBE_TIMEOUT_MS): Promise<NativeProbe> => {
    const agent = openAgents[provider];
    if (agent.native) return { ...(await agent.native(bin, openHomeEnv(agent.process, env), cwd, timeoutMs, off, items)), nativeOff: [...off], nativeItems: items };
    return {
      provider,
      cwd,
      skills: [],
      mcpServers: [],
      memory: [],
      memoryFromFiles: false,
      nativeOff: [...off],
      nativeItems: items,
      asRun: false,
      problems: [{ kind: 'failed', detail: t().openNativeNotYet(PROVIDER_LABEL[provider]) }],
      checkedAt: Date.now(),
    };
  };
}

// --- Cursor ----------------------------------------------------------------------------------

/** The folders directly in `dir` that hold a `SKILL.md` (links are left out: Cursor does not follow them). */
function skillFolders(dir: string): string[] {
  try {
    return readdirSync(dir)
      .sort()
      .map((n) => join(dir, n))
      .filter((p) => {
        try {
          return lstatSync(p).isDirectory() && isFile(join(p, 'SKILL.md'));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** A Markdown file's front matter, or none when it cannot be read. */
function frontMatter(path: string): Record<string, string> {
  try {
    return parseFrontMatter(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The skills Cursor finds for `cwd`: the `skills` folders of `.cursor`, `.claude`, `.codex`, `.grok`
 * and `.agents` in the working directory (project) and in the home folder (user), and its built-in
 * ones in `~/.cursor/skills-cursor`. A name found earlier wins.
 */
export function cursorSkills(cwd: string, home = homedir()): NativeSkill[] {
  const kinds = ['.cursor', '.claude', '.codex', '.grok', '.agents'];
  const places: [string, string][] = [
    ...kinds.map((k): [string, string] => [join(resolve(cwd), k, 'skills'), 'project']),
    ...kinds.map((k): [string, string] => [join(home, k, 'skills'), 'user']),
    [join(home, '.cursor', 'skills-cursor'), 'built-in'],
  ];
  const skills: NativeSkill[] = [];
  for (const [dir, source] of places) {
    for (const folder of skillFolders(dir)) {
      const path = join(folder, 'SKILL.md');
      const fm = frontMatter(path);
      const name = fm.name || folder.slice(dir.length + 1);
      if (skills.some((x) => x.name === name)) continue;
      skills.push({ name, description: fm.description ?? '', source, path });
    }
  }
  return skills;
}

/** A JSON file, or undefined when it is missing or not JSON. */
function jsonFile(path: string): Json | undefined {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cursor's MCP servers, by name only (their configs can hold tokens): those in `~/.cursor/mcp.json`
 * (user), which it loads, and those in the project's `.cursor/mcp.json` (the repository root's, and
 * the working directory's), which it loads only once approved, which it never asks over ACP.
 */
export function cursorMcpServers(cwd: string, home = homedir()): NativeMcpServer[] {
  const servers: NativeMcpServer[] = [];
  const add = (file: string, source: string, status?: string) => {
    const list = jsonFile(file)?.mcpServers;
    if (!list || typeof list !== 'object') return;
    for (const [name, config] of Object.entries(list as Json)) {
      if (servers.some((x) => x.name === name)) continue;
      const transport = typeof config?.url === 'string' ? 'http' : 'stdio';
      servers.push({ name, transport, source, ...(status ? { status } : {}) });
    }
  };
  add(join(home, '.cursor', 'mcp.json'), 'user');
  for (const dir of [...new Set([gitRoot(cwd), resolve(cwd)].filter((d): d is string => Boolean(d)))]) {
    add(join(dir, '.cursor', 'mcp.json'), 'project', 'needs approval');
  }
  return servers;
}

/** The hooks of a Cursor `hooks.json` (`{ version, hooks: { <event>: [{ command, matcher? }] } }`), never their commands. */
function cursorHooksIn(file: string, source: string): NativeHook[] {
  const hooks = jsonFile(file)?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  return Object.entries(hooks as Json).flatMap(([event, list]) =>
    (Array.isArray(list) ? list : []).map((h: Json) => ({
      event,
      ...(typeof h?.matcher === 'string' && h.matcher ? { matcher: h.matcher } : {}),
      source,
      file,
    })),
  );
}

/**
 * The hooks of Claude Code's `~/.claude/settings.json`, which Cursor loads too
 * (`{ hooks: { <Event>: [{ matcher?, hooks: [{ type, command }] }] } }`), one per matcher entry.
 */
function claudeHooksIn(file: string): NativeHook[] {
  const hooks = jsonFile(file)?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  return Object.entries(hooks as Json).flatMap(([event, list]) =>
    (Array.isArray(list) ? list : []).map((h: Json) => ({
      event,
      ...(typeof h?.matcher === 'string' && h.matcher ? { matcher: h.matcher } : {}),
      source: 'Claude Code',
      file,
    })),
  );
}

/**
 * Cursor's hooks: the organisation's (managed), the user's `~/.cursor/hooks.json`, and Claude Code's in
 * `~/.claude/settings.json` (always that file: Cursor does not follow `CLAUDE_CONFIG_DIR`).
 */
export function cursorHooks(home = homedir(), platform: NodeJS.Platform = process.platform): NativeHook[] {
  const managed =
    platform === 'darwin'
      ? '/Library/Application Support/Cursor/hooks.json'
      : platform === 'linux'
        ? '/etc/cursor/hooks.json'
        : join(process.env.ProgramData ?? 'C:\\ProgramData', 'Cursor', 'hooks.json');
  return [
    ...cursorHooksIn(managed, 'managed'),
    ...cursorHooksIn(join(home, '.cursor', 'hooks.json'), 'user'),
    ...claudeHooksIn(join(home, '.claude', 'settings.json')),
  ];
}

/** Cursor's subagents: the Markdown files in the working directory's `.cursor/agents` and `.claude/agents`. */
export function cursorAgents(cwd: string): NativeAgent[] {
  const agents: NativeAgent[] = [];
  for (const dir of ['.cursor', '.claude'].map((k) => join(resolve(cwd), k, 'agents'))) {
    for (const path of markdownIn(dir)) {
      const fm = frontMatter(path);
      const name = fm.name || path.slice(dir.length + 1).replace(/\.md$/i, '');
      if (!agents.some((a) => a.name === name)) agents.push({ name, description: fm.description ?? '', source: 'project' });
    }
  }
  return agents;
}

/**
 * The instruction files Cursor reads: AGENTS.md, CLAUDE.md, CLAUDE.local.md and the rules in
 * `.cursor/rules` (`.mdc` and `.md`), in the folder it starts in and in each folder above it. Its
 * account's rules on Cursor's side are not files, so they are not listed.
 */
export function cursorMemoryFiles(cwd: string): NativeMemoryFile[] {
  const files: string[] = [];
  for (const dir of upFrom(cwd).reverse()) {
    files.push(join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md'), join(dir, 'CLAUDE.local.md'));
    try {
      const rules = join(dir, '.cursor', 'rules');
      files.push(
        ...readdirSync(rules)
          .filter((n) => /\.mdc?$/i.test(n))
          .sort()
          .slice(0, 50)
          .map((n) => join(rules, n)),
      );
    } catch {
      // no rules here
    }
  }
  return [...new Set(files)].filter(isFile).map((path) => ({ path, kind: 'instructions' as const }));
}

/** What Cursor loads by itself for `cwd`, from its files; nothing can be left out of its runs (`NATIVE_OFF_SUPPORT`). */
async function probeCursor(
  _bin: string,
  _env: NodeJS.ProcessEnv,
  cwd: string,
  off: readonly NativePart[],
  items: NativeItemsOff,
): Promise<NativeProbe> {
  return {
    provider: 'cursor',
    cwd,
    skills: cursorSkills(cwd),
    mcpServers: cursorMcpServers(cwd),
    memory: cursorMemoryFiles(cwd),
    hooks: cursorHooks(),
    agents: cursorAgents(cwd),
    memoryFromFiles: true,
    nativeOff: [...off],
    nativeItems: items,
    asRun: false,
    problems: [],
    checkedAt: Date.now(),
  };
}

const PROBES: Record<
  Provider,
  (bin: string, env: NodeJS.ProcessEnv, cwd: string, off: readonly NativePart[], items: NativeItemsOff, timeoutMs?: number) => Promise<NativeProbe>
> = {
  claude: probeClaude,
  codex: probeCodex,
  grok: probeGrok,
  cursor: probeCursor,
  opencode: probeOpen('opencode'),
  goose: probeOpen('goose'),
  cline: probeOpen('cline'),
  openhands: probeOpen('openhands'),
  pi: probeOpen('pi'),
};

const CACHE_MS = 60_000;

const sameParts = (a: readonly NativePart[], b: readonly NativePart[]) => a.length === b.length && a.every((p) => b.includes(p));

/**
 * Asks each CLI what it loads by itself, and what Harness Relay's runs leave out of it; answers are
 * kept for a minute per CLI, executable, folder and account home, while what that account's runs leave
 * out stays the same.
 */
export class NativeSetupService {
  private cache = new Map<string, { at: number; off: readonly NativePart[]; items: NativeItemsOff; result: Promise<NativeProbe> }>();
  /** The last answer each CLI, folder and home gave, with what was left out then (`recent`). */
  private answered = new Map<string, { off: readonly NativePart[]; items: NativeItemsOff; probe: NativeProbe }>();

  constructor(
    private settings: {
      bin(p: Provider): string;
      /** A CLI's environment; `account`: one of its accounts besides the default one (`SettingsStore.env`). */
      env(p: Provider, account?: string): NodeJS.ProcessEnv;
      /** What runs as the account leave out (`SettingsStore.nativeOff`): each account chooses its own. */
      nativeOff?(p: Provider, account?: string): readonly NativePart[];
      nativeItems?(p: Provider, account?: string): NativeItemsOff;
    },
    /** How long each question to a CLI may take (tests shorten it). */
    private timeoutMs = PROBE_TIMEOUT_MS,
  ) {}

  /** Per CLI, executable, folder and CLI home (the agent home setting and the account move it). */
  private key(provider: Provider, cwd: string, account?: string): string {
    const home = this.settings.env(provider, account)[AGENT_HOME_ENV[provider]] ?? '';
    return `${provider}\0${this.settings.bin(provider)}\0${cwd}\0${home}`;
  }

  /**
   * For the lead agent, which should not wait for the CLIs on every question: the last answer for this
   * CLI, folder and account however old, while what is left out of the runs is the same, asked again in
   * the background once it is older than the cache keeps it; the CLI is waited for only when there is
   * none yet (or the last one said nothing at all).
   */
  recent(provider: Provider, cwd: string, account?: string): Promise<NativeProbe> {
    const off = this.settings.nativeOff?.(provider, account) ?? [];
    const items = this.settings.nativeItems?.(provider, account) ?? {};
    const last = this.answered.get(this.key(provider, cwd, account));
    if (!last || !sameParts(last.off, off) || !sameNativeItems(last.items, items) || saidNothing(last.probe)) return this.get(provider, cwd, false, account);
    void this.get(provider, cwd, false, account); // the cached question when it is fresh, else a new one
    return Promise.resolve(last.probe);
  }

  /**
   * The latest answer for this CLI, executable, folder and account, however old; the CLI is asked only
   * when there is none yet. For checks against what the UI was shown (opening a reported file), which
   * should not start the CLI again.
   */
  latest(provider: Provider, cwd: string, account?: string): Promise<NativeProbe> {
    return this.cache.get(this.key(provider, cwd, account))?.result ?? this.get(provider, cwd, false, account);
  }

  /**
   * `account`: ask the CLI in that account's home (default: the default account's), leaving out what
   * that account's runs leave out.
   */
  get(provider: Provider, cwd: string, refresh = false, account?: string): Promise<NativeProbe> {
    const bin = this.settings.bin(provider);
    const off = [...(this.settings.nativeOff?.(provider, account) ?? [])];
    const items = this.settings.nativeItems?.(provider, account) ?? {};
    const key = this.key(provider, cwd, account);
    const hit = this.cache.get(key);
    if (hit && !refresh && Date.now() - hit.at < CACHE_MS && sameParts(hit.off, off) && sameNativeItems(hit.items, items)) return hit.result;
    const result = PROBES[provider](bin, this.settings.env(provider, account), cwd, off, items, this.timeoutMs).catch(
      (err: Error): NativeProbe => ({
        provider,
        cwd,
        skills: [],
        mcpServers: [],
        memory: [],
        memoryFromFiles: provider === 'claude' || provider === 'codex',
        nativeOff: off,
        nativeItems: items,
        asRun: false,
        problems: [{ kind: 'failed', detail: err.message }],
        checkedAt: Date.now(),
      }),
    );
    this.cache.set(key, { at: Date.now(), off, items, result });
    void result.then((probe) => this.answered.set(key, { off, items, probe }));
    return result;
  }
}

/**
 * How much of what a CLI loads by itself a probe got: `complete`; `incomplete`, some of it (it refused
 * a question, one part went unanswered, or it ran out of time after some answers); or none, because it
 * ran out of time (`late`) or could not be asked (`failed`). A CLI that answered its lists empty, with
 * only a question refused or a part unanswered, has nothing of its own: that is not none.
 */
export function probeCompleteness(probe: {
  problems?: readonly NativeProblem[];
  skills: readonly unknown[];
  mcpServers: readonly unknown[];
  builtinTools?: readonly unknown[];
  agents?: readonly unknown[];
  plugins?: readonly unknown[];
}): 'complete' | 'incomplete' | 'late' | 'failed' {
  const problems = probe.problems ?? [];
  const lists = [probe.skills, probe.mcpServers, probe.builtinTools, probe.agents, probe.plugins];
  if (lists.every((l) => !l?.length)) {
    if (problems.some((x) => x.kind === 'timeout')) return 'late';
    if (problems.some((x) => (x.kind === 'failed' && !x.refused) || (x.kind === 'no-answer' && x.part === 'all'))) return 'failed';
  }
  return problems.some((x) => x.kind === 'timeout' || x.kind === 'failed' || x.kind === 'no-answer') ? 'incomplete' : 'complete';
}

/** A probe that got none of the CLI's lists (`probeCompleteness`): not worth giving the lead again. */
export function saidNothing(probe: Parameters<typeof probeCompleteness>[0]): boolean {
  const c = probeCompleteness(probe);
  return c === 'late' || c === 'failed';
}

/**
 * Whether `path` is one of the files the probe reported (an instruction or memory file, or a
 * skill's SKILL.md): only those can be previewed, so no other file on the computer can be read.
 */
export function listedFile(probe: Pick<NativeSetup, 'memory' | 'skills'>, path: string): boolean {
  return probe.memory.some((m) => m.path === path) || probe.skills.some((s) => s.path === path);
}

/** A probe's answer for the client, its problems in the language of this request. */
export function nativeForClient(probe: NativeProbe): NativeSetup {
  const { problems, ...rest } = probe;
  return { ...rest, errors: problems.map((p) => nativeProblemText(probe.provider, p)) };
}

export function nativeProblemText(provider: Provider, p: NativeProblem): string {
  const m = t();
  const cli = PROVIDER_LABEL[provider];
  if (p.kind === 'as-run') return m.nativeAsRunFailed(cli, nativeProblemText(provider, p.cause));
  if (p.kind === 'as-run-partial') return m.nativeAsRunPartial(cli);
  if (p.kind === 'timeout') return m.nativeTimeout(cli);
  if (p.kind === 'failed') return m.nativeFailed(cli, p.detail);
  return m.nativeNoAnswer(cli, p.part);
}
