import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  PROVIDER_LABEL,
  type NativeAgent,
  type NativeHook,
  type NativeMcpServer,
  type NativeMemoryFile,
  type NativePart,
  type NativePlugin,
  type NativeSetup,
  type NativeSkill,
  type Provider,
} from '../shared/types';
import {
  CLAUDE_PROBE_ARGS,
  claudeAgentDenyRules,
  claudeAgents,
  claudeBuiltinAgents,
  claudeNativeArgs,
  claudeNativeEnv,
  claudePlugins,
  isBuiltinAgent,
  type ClaudeBuiltinAgents,
  type ClaudePlugin,
} from './agents/claude';
import { codexConfiguredMcpServers, codexMcpConfig, codexNativeConfig, codexOverrideArgs } from './agents/codex';
import { grokNativeEnv } from './agents/grok';
import { t } from './i18n';
import { converse, runProcess } from './process';

/*
 * What each CLI loads by itself — its own skills, MCP servers, hooks, subagents, plugins and
 * memory — asked from the CLI the way an IDE would, without sending a prompt (so no model is
 * called):
 * - Claude Code: stream-json control requests `initialize` (its commands, skills among them, and
 *   subagents), `mcp_status`, `get_hooks_listing` and `get_settings` (which subagents are denied,
 *   which plugins are off), and `claude plugin list --json`. Starting it runs the user's
 *   SessionStart hooks and connects its MCP servers.
 * - Codex: `codex app-server` requests `skills/list`, `config/read` (configured MCP servers),
 *   `hooks/list` and `plugin/installed`.
 * - Grok: `grok inspect --json`.
 * Claude Code and Codex have no list of the instruction and memory files they read, so those come
 * from the files at the places they are documented to read. Only names, descriptions, paths and
 * states are kept: MCP server configs and hook commands (which can hold tokens) never leave this
 * module.
 *
 * When some of the CLI's own setup is left out of Harness Relay's runs, the CLI is asked a second
 * time the way Harness Relay starts it (the same flags, variables and config overrides), and what
 * it then leaves out is marked `leftOut`.
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
  | { kind: 'no-answer'; part: 'all' | 'skills' | 'mcp' | 'hooks' | 'agents' | 'plugins' }
  | { kind: 'failed'; detail: string }
  /** Asking the CLI again the way Harness Relay starts it went wrong, so nothing is marked left out. */
  | { kind: 'as-run'; cause: NativeProblem };

/** A probe's answer before its problems are put into words. */
export type NativeProbe = Omit<NativeSetup, 'errors'> & { problems: NativeProblem[] };

/** The lists one answer gives; a list the CLI did not give is undefined. */
export type NativeLists = Pick<NativeSetup, 'skills' | 'mcpServers' | 'memory'> & Pick<Partial<NativeSetup>, 'hooks' | 'agents' | 'plugins'>;

/** What a probe that ended without some answers reports: a timeout, the CLI's own words, or the parts missing. */
function missing(parts: ('skills' | 'mcp' | 'hooks' | 'plugins')[], all: boolean, res: { stderr: string; timedOut: boolean }): NativeProblem[] {
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
};

/** Whether the CLI loads an item: not turned off (`enabled: false`, or an MCP server's `disabled` status). */
const loads = (item: object) => (item as { enabled?: boolean }).enabled !== false && (item as { status?: string }).status !== 'disabled';

/**
 * Marks `leftOut` the items the CLI loads by itself (`own`) but not when asked the way Harness
 * Relay starts it (`asRun`): missing from that answer, or reported off in it. A list the CLI did not
 * give the second time stays unmarked.
 */
export function markLeftOut(own: NativeLists, asRun: Partial<NativeLists>): NativeLists {
  function mark<T extends object>(list: T[], again: T[] | undefined, key: (item: T) => string): T[];
  function mark<T extends object>(list: T[] | undefined, again: T[] | undefined, key: (item: T) => string): T[] | undefined;
  function mark<T extends object>(list: T[] | undefined, again: T[] | undefined, key: (item: T) => string): T[] | undefined {
    if (!list || !again) return list;
    const loaded = new Set(again.filter(loads).map(key));
    return list.map((item) => (loads(item) && !loaded.has(key(item)) ? { ...item, leftOut: true } : item));
  }
  return {
    skills: mark(own.skills, asRun.skills, KEYS.skills),
    mcpServers: mark(own.mcpServers, asRun.mcpServers, KEYS.mcpServers),
    memory: mark(own.memory, asRun.memory, KEYS.memory),
    ...(own.hooks ? { hooks: mark(own.hooks, asRun.hooks, KEYS.hooks) } : {}),
    ...(own.agents ? { agents: mark(own.agents, asRun.agents, KEYS.agents) } : {}),
    ...(own.plugins ? { plugins: mark(own.plugins, asRun.plugins, KEYS.plugins) } : {}),
  };
}

/** A list for the second answer: undefined when the CLI did not give it then. */
const given = <T>(answered: unknown, list: T[] | undefined): T[] | undefined => (answered ? list : undefined);

/** The switches that change each list: a list nothing left out touches needs no second look. */
const TOUCHED_BY: Record<'skills' | 'mcp' | 'hooks' | 'agents' | 'plugins', NativePart[]> = {
  skills: ['skills', 'plugins'],
  mcp: ['mcp', 'plugins'],
  hooks: ['hooks', 'plugins'],
  agents: ['agents', 'plugins'],
  plugins: ['plugins'],
};

/** Problems for the lists the second answer lacked (so they are not marked), among those the switches touch. */
const unmarked = (off: readonly NativePart[], lists: [unknown, keyof typeof TOUCHED_BY][]): NativeProblem[] =>
  lists
    .filter(([lacking, part]) => lacking && TOUCHED_BY[part].some((p) => off.includes(p)))
    .map(([, part]) => ({ kind: 'as-run', cause: { kind: 'no-answer', part } }));

// --- Claude Code ---------------------------------------------------------------------------

/** What Claude Code answered to `initialize`, `mcp_status`, `get_hooks_listing` and `get_settings`. */
export interface ClaudeAnswers {
  init?: Json;
  mcp?: Json;
  hooks?: Json;
  settings?: Json;
}

/** The subagents a permission rule denies (`Agent(name)`, or `Task(name)` from older versions). */
function deniedAgents(settings: Json | undefined): Set<string> {
  const deny: unknown = settings?.effective?.permissions?.deny;
  const names = (Array.isArray(deny) ? deny : []).map((r) => (typeof r === 'string' ? r.match(/^(?:Agent|Task)\((.+)\)$/)?.[1] : undefined));
  return new Set(names.filter((n): n is string => Boolean(n)));
}

/**
 * Skills (and the other non-built-in commands), MCP servers, hooks and subagents from Claude Code's
 * control responses, and its plugins from `claude plugin list --json`. Its effective settings say
 * which subagents are denied and which plugins are off; `builtins` names its built-in subagents
 * with their descriptions.
 */
export function parseClaudeProbe(
  a: ClaudeAnswers,
  plugins?: readonly ClaudePlugin[],
  builtins?: ClaudeBuiltinAgents,
): Pick<NativeLists, 'skills' | 'mcpServers' | 'hooks' | 'agents' | 'plugins'> {
  const list = (v: unknown): Json[] => (Array.isArray(v) ? v : []);
  const effective: Json | undefined = a.settings?.effective;
  const denied = deniedAgents(a.settings);
  const pluginsOff: Json = effective?.enabledPlugins && typeof effective.enabledPlugins === 'object' ? effective.enabledPlugins : {};
  return {
    skills: list(a.init?.commands)
      .filter((c) => !c.builtin && typeof c.name === 'string')
      .map((c) => ({ name: c.name, description: String(c.description ?? '') })),
    mcpServers: list(a.mcp?.mcpServers)
      .filter((s) => typeof s.name === 'string')
      .map((s) => ({
        name: s.name,
        ...(typeof s.status === 'string' ? { status: s.status } : {}),
        ...(typeof (s.scope ?? s.source) === 'string' ? { source: String(s.scope ?? s.source) } : {}),
        ...(typeof (s.transport ?? s.config?.type) === 'string' ? { transport: String(s.transport ?? s.config?.type) } : {}),
        ...(Array.isArray(s.tools) ? { tools: s.tools.length } : {}),
      })),
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
    ...[...new Set(instructions)].filter(isFile).map((path) => ({ path, kind: 'instructions' as const })),
    ...[...new Set(memory)].map((path) => ({ path, kind: 'memory' as const })),
  ];
}

/** Claude Code's files as it reads them with these variables: none of a kind its variable turns off. */
export function claudeMemoryState(files: NativeMemoryFile[], env: NodeJS.ProcessEnv): NativeMemoryFile[] {
  const off = (f: NativeMemoryFile) => Boolean(env[f.kind === 'memory' ? 'CLAUDE_CODE_DISABLE_AUTO_MEMORY' : 'CLAUDE_CODE_DISABLE_CLAUDE_MDS']);
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
 * Claude Code's answers to control requests sent one after another; a function makes its request
 * from the answers so far (or none). Answers line up with the requests (undefined when skipped,
 * refused or not answered).
 */
async function askClaude(bin: string, env: NodeJS.ProcessEnv, cwd: string, args: string[], requests: ClaudeRequest[]): Promise<Asked<(Json | undefined)[], number>> {
  const answers: (Json | undefined)[] = [];
  const errors: Record<number, string> = {};
  let at = 0;
  const next = (write: (msg: unknown) => void, finish: () => void) => {
    for (; at < requests.length; at++) {
      const r = requests[at]!;
      const request = typeof r === 'function' ? r(answers) : r;
      if (request) return write({ type: 'control_request', request_id: `relay-${at}`, request });
    }
    finish();
  };
  const res = await converse({
    bin,
    args: [...CLAUDE_PROBE_ARGS, ...args],
    cwd,
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
    open: (write) => next(write, () => undefined),
    onMessage: (m, write, finish) => {
      if (m.type !== 'control_response' || m.response?.request_id !== `relay-${at}`) return;
      const r = m.response;
      if (r.subtype === 'error') errors[at] = String(r.error ?? 'error');
      else answers[at] = r.response ?? {};
      at++;
      next(write, finish);
    },
  });
  return { answers, errors, res };
}

/** The CLI's words for the questions it refused, as problems. */
const refused = (errors: Partial<Record<PropertyKey, string>>): NativeProblem[] =>
  Object.values(errors).map((detail) => ({ kind: 'failed', detail: String(detail) }));

const CLAUDE_ASKS = {
  init: { subtype: 'initialize' },
  mcp: { subtype: 'mcp_status' },
  hooks: { subtype: 'get_hooks_listing' },
  settings: { subtype: 'get_settings' },
};

async function probeClaude(bin: string, env: NodeJS.ProcessEnv, cwd: string, off: readonly NativePart[]): Promise<NativeProbe> {
  const { answers, errors, res } = await askClaude(bin, env, cwd, [], [CLAUDE_ASKS.init, CLAUDE_ASKS.mcp, CLAUDE_ASKS.hooks, CLAUDE_ASKS.settings]);
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
    if (builtinsError !== undefined && !off.includes('agents')) problems.push({ kind: 'failed', detail: builtinsError });
  }
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const files = claudeMemoryFiles(cwd, configDir);
  let lists: NativeLists = { ...parseClaudeProbe({ init, mcp, hooks, settings }, plugins, builtins), memory: claudeMemoryState(files, env) };

  let asRun = false;
  const runEnv = { ...env, ...claudeNativeEnv(off) };
  if (off.length && init && off.every((p) => p === 'instructions' || p === 'memory')) {
    // Only files left out, through variables: no need to start Claude Code (and run its hooks) again.
    lists = markLeftOut(lists, { memory: claudeMemoryState(files, runEnv) });
    asRun = true;
  } else if (off.length && init) {
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
      const again = await askClaude(bin, runEnv, cwd, claudeNativeArgs(off, (plugins ?? []).map((p) => p.id)), [
        CLAUDE_ASKS.init,
        deny,
        CLAUDE_ASKS.mcp,
        CLAUDE_ASKS.hooks,
        CLAUDE_ASKS.settings,
      ]);
      const [init2, , mcp2, hooks2, settings2] = again.answers;
      // Without its answer to `initialize`, or with its subagents not denied, there is nothing to compare.
      const cause: NativeProblem | undefined = again.res.timedOut
        ? { kind: 'timeout' }
        : !init2
          ? (refused(again.errors)[0] ?? missing([], true, again.res)[0])
          : off.includes('agents') && !claudeAgents(init2)
            ? { kind: 'no-answer', part: 'agents' }
            : again.errors[1] !== undefined
              ? { kind: 'failed', detail: again.errors[1] }
              : undefined;
      if (cause) {
        problems.push({ kind: 'as-run', cause });
      } else {
        const parsed = parseClaudeProbe({ init: init2, mcp: mcp2, hooks: hooks2, settings: settings2 }, plugins, builtins);
        lists = markLeftOut(lists, {
          skills: parsed.skills,
          mcpServers: given(mcp2, parsed.mcpServers),
          hooks: given(hooks2, parsed.hooks),
          agents: given(settings2, parsed.agents),
          plugins: given(settings2, parsed.plugins),
          memory: claudeMemoryState(files, runEnv),
        });
        asRun = true;
        // A list the second answer lacks stays unmarked: say so, rather than let it look all loaded.
        problems.push(
          ...unmarked(off, [
            [mcp && !mcp2, 'mcp'],
            [hooks && !hooks2, 'hooks'],
            [lists.agents && !settings2, 'agents'],
            [lists.plugins && !settings2, 'plugins'],
          ]),
        );
      }
    }
  }
  return { provider: 'claude', cwd, ...lists, memoryFromFiles: true, nativeOff: [...off], asRun, problems, checkedAt: Date.now() };
}

// --- Codex ---------------------------------------------------------------------------------

/** What `codex app-server` answered to `skills/list`, `config/read`, `hooks/list` and `plugin/installed`. */
export interface CodexAnswers {
  skills?: Json;
  config?: Json;
  hooks?: Json;
  plugins?: Json;
}

/**
 * Skills (once each), configured MCP servers (names and kinds only), hooks and installed plugins
 * from Codex's answers. With `skills.include_instructions` off, Codex no longer lists its skills to
 * the model, so they count as off.
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
      ...(typeof s.path === 'string' ? { path: s.path } : {}),
      ...(s.enabled === false || unlisted ? { enabled: false } : {}),
    });
  }
  const servers = config?.mcp_servers;
  // Once each: an answer has an entry per folder asked about.
  const hooks = new Map<string, Json>();
  for (const h of list(a.hooks?.data).flatMap((e) => list(e.hooks))) {
    if (typeof h.eventName === 'string') hooks.set(String(h.key ?? JSON.stringify([h.eventName, h.matcher, h.sourcePath, h.pluginId])), h);
  }
  return {
    skills,
    mcpServers:
      servers && typeof servers === 'object'
        ? Object.entries(servers as Record<string, Json>).map(([name, c]) => ({
            name,
            transport: c?.url ? 'http' : 'stdio',
            ...(c?.enabled === false ? { status: 'disabled' } : {}),
          }))
        : [],
    ...(a.hooks
      ? {
          hooks: [...hooks.values()].map((h) => ({
              event: h.eventName,
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

/** Codex's answers to its four questions, from an app-server started with `preArgs` (config overrides). */
async function askCodex(bin: string, env: NodeJS.ProcessEnv, cwd: string, preArgs: string[]): Promise<Asked<CodexAnswers, keyof CodexAnswers>> {
  const asks: [keyof CodexAnswers, string, unknown][] = [
    ['skills', 'skills/list', { cwds: [cwd] }],
    ['config', 'config/read', { cwd }],
    ['hooks', 'hooks/list', { cwds: [cwd] }],
    ['plugins', 'plugin/installed', { cwds: [cwd] }],
  ];
  const answers: CodexAnswers = {};
  const errors: Partial<Record<keyof CodexAnswers, string>> = {};
  let pending = asks.length;
  const res = await converse({
    bin,
    args: [...preArgs, 'app-server'],
    cwd,
    env,
    timeoutMs: PROBE_TIMEOUT_MS,
    open: (write) =>
      write({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'harness_relay', title: 'Harness Relay', version: '0.1.0' }, capabilities: null } }),
    onMessage: (m, write, finish) => {
      if (m.id === undefined || m.method) return;
      if (m.id === 0) {
        write({ jsonrpc: '2.0', method: 'initialized' });
        asks.forEach(([, method, params], i) => write({ jsonrpc: '2.0', id: i + 1, method, params }));
        return;
      }
      const ask = asks[Number(m.id) - 1];
      if (!ask) return;
      if (m.error) errors[ask[0]] = String(m.error.message ?? 'error');
      else answers[ask[0]] = m.result ?? {};
      if (--pending === 0) finish();
    },
  });
  return { answers, errors, res };
}

async function probeCodex(bin: string, env: NodeJS.ProcessEnv, cwd: string, off: readonly NativePart[]): Promise<NativeProbe> {
  const { answers, errors, res } = await askCodex(bin, env, cwd, []);
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
  if (off.length && (answers.skills || answers.config)) {
    if (off.includes('mcp') && !answers.config) {
      // The run itself fails when Codex cannot list its MCP servers.
      problems.push({ kind: 'as-run', cause: { kind: 'no-answer', part: 'mcp' } });
    } else {
      // The overrides a thread of the run gets, here for the whole app-server.
      const overrides = {
        ...codexNativeConfig(off),
        ...codexMcpConfig([], false, off.includes('mcp') ? codexConfiguredMcpServers(answers.config) : []),
      };
      const again = await askCodex(bin, env, cwd, codexOverrideArgs(overrides));
      const a = again.answers;
      // A question it refused leaves that list unmarked; no answer at all (overrides it would not start with, say) marks nothing.
      const cause: NativeProblem | undefined = again.res.timedOut
        ? { kind: 'timeout' }
        : a.skills || a.config
          ? undefined
          : (refused(again.errors)[0] ?? missing([], true, again.res)[0]);
      if (cause) {
        problems.push({ kind: 'as-run', cause });
      } else {
        const parsed = parseCodexProbe(a);
        lists = markLeftOut(lists, {
          skills: given(a.skills, parsed.skills),
          mcpServers: given(a.config, parsed.mcpServers),
          hooks: parsed.hooks,
          plugins: parsed.plugins,
          memory: given(a.config, codexMemoryState(files, home, a.config)),
        });
        asRun = true;
        problems.push(
          ...unmarked(off, [
            [answers.skills && !a.skills, 'skills'],
            [answers.config && !a.config, 'mcp'],
            [answers.hooks && !a.hooks, 'hooks'],
            [answers.plugins && !a.plugins, 'plugins'],
          ]),
        );
      }
    }
  }
  return { provider: 'codex', cwd, ...lists, memoryFromFiles: true, nativeOff: [...off], asRun, problems, checkedAt: Date.now() };
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

async function inspectGrok(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ data?: Json; problems: NativeProblem[] }> {
  const res = await runProcess({ bin, args: ['inspect', '--json'], cwd, env, timeoutMs: PROBE_TIMEOUT_MS, maxCapture: 20 * 1024 * 1024 });
  try {
    return { data: JSON.parse(res.stdout) as Json, problems: [] };
  } catch {
    return { problems: missing([], true, res) };
  }
}

async function probeGrok(bin: string, env: NodeJS.ProcessEnv, cwd: string, off: readonly NativePart[]): Promise<NativeProbe> {
  const { data, problems } = await inspectGrok(bin, env, cwd);
  const own = parseGrokInspect(data);
  let lists: NativeLists = own;
  let asRun = false;
  if (off.length && data) {
    const again = await inspectGrok(bin, { ...env, ...grokNativeEnv(off) }, cwd);
    if (!again.data) {
      problems.push({ kind: 'as-run', cause: again.problems[0] ?? { kind: 'no-answer', part: 'all' } });
    } else {
      lists = markLeftOut(lists, parseGrokInspect(again.data));
      asRun = true;
    }
  }
  return { provider: 'grok', cwd, ...own, ...lists, memoryFromFiles: false, nativeOff: [...off], asRun, problems, checkedAt: Date.now() };
}

const PROBES: Record<Provider, (bin: string, env: NodeJS.ProcessEnv, cwd: string, off: readonly NativePart[]) => Promise<NativeProbe>> = {
  claude: probeClaude,
  codex: probeCodex,
  grok: probeGrok,
};

const CACHE_MS = 60_000;

const sameParts = (a: readonly NativePart[], b: readonly NativePart[]) => a.length === b.length && a.every((p) => b.includes(p));

/**
 * Asks each CLI what it loads by itself, and what Harness Relay's runs leave out of it; answers are
 * kept for a minute per CLI, executable and folder, while the parts left out stay the same.
 */
export class NativeSetupService {
  private cache = new Map<string, { at: number; off: readonly NativePart[]; result: Promise<NativeProbe> }>();

  constructor(
    private settings: { bin(p: Provider): string; env(p: Provider): NodeJS.ProcessEnv; nativeOff?(p: Provider): readonly NativePart[] },
  ) {}

  private key(provider: Provider, cwd: string): string {
    return `${provider}\0${this.settings.bin(provider)}\0${cwd}`;
  }

  /**
   * The latest answer for this CLI, executable and folder, however old; the CLI is asked only when
   * there is none yet. For checks against what the UI was shown (opening a reported file), which
   * should not start the CLI again.
   */
  latest(provider: Provider, cwd: string): Promise<NativeProbe> {
    return this.cache.get(this.key(provider, cwd))?.result ?? this.get(provider, cwd);
  }

  get(provider: Provider, cwd: string, refresh = false): Promise<NativeProbe> {
    const bin = this.settings.bin(provider);
    const off = [...(this.settings.nativeOff?.(provider) ?? [])];
    const key = this.key(provider, cwd);
    const hit = this.cache.get(key);
    if (hit && !refresh && Date.now() - hit.at < CACHE_MS && sameParts(hit.off, off)) return hit.result;
    const result = PROBES[provider](bin, this.settings.env(provider), cwd, off).catch(
      (err: Error): NativeProbe => ({
        provider,
        cwd,
        skills: [],
        mcpServers: [],
        memory: [],
        memoryFromFiles: provider !== 'grok',
        nativeOff: off,
        asRun: false,
        problems: [{ kind: 'failed', detail: err.message }],
        checkedAt: Date.now(),
      }),
    );
    this.cache.set(key, { at: Date.now(), off, result });
    return result;
  }
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
  if (p.kind === 'timeout') return m.nativeTimeout(cli);
  if (p.kind === 'failed') return m.nativeFailed(cli, p.detail);
  return m.nativeNoAnswer(cli, p.part);
}
