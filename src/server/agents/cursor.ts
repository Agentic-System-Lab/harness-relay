import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Permission, PlanEntry } from '../../shared/types';
import { t } from '../i18n';
import { runProcess, tail } from '../process';
import { cursorEffortOption, cursorOptionValues } from '../models';
import { patternPath, agentProtectedReads, realPath, relayTmpDir, RUN_TMP_PREFIXES } from '../protect';
import { JsonRpcConnection, RpcError, acpContentText, acpMcpServers, acpPrompt, answerPermission, type AcpDecision } from './acp';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  summarizeInput,
  tailText,
  toolCallKind,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type RunOptions,
  type RunResult,
} from './types';
import type { WriteGuard } from '../writeGuard';

/*
 * Cursor runs as an ACP agent (`cursor-agent acp`: JSON-RPC over stdin/stdout), like Grok. What its ACP
 * server does, as read from cursor-agent 2026.11.11 and tried with it:
 *
 * - It has no OS sandbox: its ACP permission layer never applies one, whatever `--sandbox` or
 *   `sandbox.mode` say. So below full access every shell command it wants to run comes to Harness
 *   Relay (`session/request_permission`); none runs without asking, except those on a Cursor team's
 *   auto-run allowlist, which a team admin sets on Cursor's side. Its own tools read anywhere and
 *   edit inside the workspace without asking (but for its protected files, which it asks about).
 * - Its settings file (`cli-config.json` in `CURSOR_CONFIG_DIR`) decides what runs without asking
 *   (`permissions.allow`, `approvalMode`), and Cursor writes into it when a session changes its model
 *   or the user answers "allow always". Each run therefore gets a private config folder of its own
 *   (`prepareCursorRun`): the account's settings, with no allow rules and Harness Relay's deny rules,
 *   and a link to the account's sessions folder (`acp-sessions`), so sessions still resume. A
 *   project's own `.cursor/cli.json`, which Cursor would merge over it, is not read
 *   (`--disable-project-configs`).
 * - Below full access its read and write tools may not reach the protected paths (`Read(<path>/**)`,
 *   `Write(<path>/**)` deny rules), as far as Cursor matches them: against the path as written, by
 *   letter case, without resolving links. In read-only mode its write tool may not write at all
 *   (`Write(**)`).
 * - Full access: `--force` (its "Run Everything"); no rules are added.
 * - It has no system prompt over ACP, so the briefing goes at the top of the prompt: in a new session,
 *   and in a resumed one when it changed since it was last sent (`cursorPromptText`).
 * - A refusal reaches the model only as Cursor's own "Rejected: User rejected" (it takes no message);
 *   the turn carries on.
 * - Errors from Cursor's service (no plan for a model, signed out) come as reply text, not as errors
 *   (`cursorServiceError`).
 */

/** Cursor's own config folder: `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`. */
export function cursorConfigDir(env: NodeJS.ProcessEnv, home = homedir()): string {
  if (env.CURSOR_CONFIG_DIR) return env.CURSOR_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'cursor');
  return join(home, '.cursor');
}

/** Cursor's permission rule for everything in an absolute folder (or a file). */
export function cursorPathRule(tool: 'Read' | 'Write', path: string): string {
  return `${tool}(${path.replace(/\\/g, '/').replace(/\/+$/, '')}/**)`;
}

/**
 * The deny rules of a run: below full access, the protected paths for its read and write tools (each
 * path itself, for the database's files, and everything under it); in read-only mode, any write by
 * its write tool.
 */
export function cursorDenyRules(permission: Permission, protectedPaths: readonly string[], guard?: WriteGuard): string[] {
  const guarded = cursorGuardRules(guard);
  if (permission === 'full') return guarded;
  const paths = protectedPaths.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''));
  return [
    ...(permission === 'read-only' ? ['Write(**)'] : []),
    ...(['Read', 'Write'] as const).flatMap((tool) => paths.flatMap((p) => [`${tool}(${p})`, cursorPathRule(tool, p)])),
    ...guarded,
  ];
}

/**
 * The team's protected paths as Cursor's `Write` deny rules, which it keeps with full access too (its
 * write and delete tools; never its commands). Cursor matches a rule against the real absolute path,
 * case-sensitively, with `*` for any text, `/` included (`**` is the same), and `?` and `[…]` as
 * themselves: so a rule names each working directory's real path, and `?` and `[…]` become `*`, which
 * may refuse more than the team checks protect, never less. Each pattern is that path itself and what is
 * under it, at the top (or where it is anchored) and, for one without a `/`, in any folder below.
 */
export function cursorGuardRules(g: WriteGuard | undefined): string[] {
  if (!g) return [];
  const out = new Set<string>();
  for (const dir of g.dirs) {
    const base = dir.replace(/\\/g, '/').replace(/\/+$/, '');
    for (const pattern of g.patterns) {
      const body = pattern
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\[[^\]]*\]|\?|\*\*/g, '*');
      const anchored = pattern.replace(/\/+$/, '').includes('/');
      const tops = anchored ? [`${base}/${body}`] : [`${base}/${body}`, `${base}/*/${body}`];
      for (const t of tops) out.add(`Write(${t})`).add(`Write(${t}/*)`);
    }
  }
  return [...out];
}

/**
 * The `cli-config.json` of a run: the account's own (its model and network settings), with no allow
 * rules (so every command asks), the user's deny rules plus `deny`, and `approvalMode: "allowlist"`
 * (full access: "unrestricted", with `--force`).
 */
export function cursorRunConfig(own: unknown, permission: Permission, deny: readonly string[]): Record<string, unknown> {
  const base = own && typeof own === 'object' && !Array.isArray(own) ? { ...(own as Record<string, unknown>) } : {};
  const perms = base.permissions && typeof base.permissions === 'object' ? (base.permissions as Record<string, unknown>) : {};
  const userDeny = Array.isArray(perms.deny) ? perms.deny.filter((d): d is string => typeof d === 'string') : [];
  return {
    version: 1,
    ...base,
    permissions: { allow: [], deny: [...new Set([...userDeny, ...deny])] },
    approvalMode: permission === 'full' ? 'unrestricted' : 'allowlist',
  };
}

/** The arguments of a run: project `.cursor/cli.json` files are not read; full access runs everything. */
export function cursorArgs(permission: Permission): string[] {
  return ['--disable-project-configs', ...(permission === 'full' ? ['--force'] : []), 'acp'];
}

/**
 * The environment of a run: the account's, with its private config folder, and no browser opened when
 * Cursor finds itself signed out (it answers with the sign-in link instead).
 */
export function cursorEnv(env: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  return { ...env, CURSOR_CONFIG_DIR: configDir, NO_OPEN_BROWSER: '1' };
}

/** A run's private config folder, and how to remove it. */
export interface CursorRun {
  dir: string;
  done(): void;
}

/**
 * Makes a run's private config folder in Harness Relay's own temporary folder (owner only): its
 * `cli-config.json` (`cursorRunConfig`) and a link to the account's sessions folder, made if missing.
 */
export function prepareCursorRun(accountDir: string, permission: Permission, deny: readonly string[], tmp = relayTmpDir()): CursorRun {
  let own: unknown;
  try {
    own = JSON.parse(readFileSync(join(accountDir, 'cli-config.json'), 'utf8'));
  } catch {
    own = undefined; // none yet, or not JSON: Cursor's defaults
  }
  const sessions = join(accountDir, 'acp-sessions');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(tmp, RUN_TMP_PREFIXES.cursor));
  chmodSync(dir, 0o700);
  const done = () => rmSync(dir, { recursive: true, force: true }); // the link goes, not what it leads to
  try {
    writeFileSync(join(dir, 'cli-config.json'), `${JSON.stringify(cursorRunConfig(own, permission, deny), null, 2)}\n`, { mode: 0o600 });
    symlinkSync(sessions, join(dir, 'acp-sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    done();
    throw err;
  }
  return { dir, done };
}

// --- The briefing ------------------------------------------------------------------------------

/** The briefing each session was last given (a hash), so a resumed session gets it again only when it changed. */
const briefed = new Map<string, string>();
const MAX_BRIEFED = 1000;

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The prompt text of a turn: the briefing first, when the session is new or was last given another
 * one (`lastBriefing`, its hash), then the turn's prompt.
 */
export function cursorPromptText(prompt: string, briefing: string, lastBriefing?: string): string {
  if (!briefing.trim() || lastBriefing === hashOf(briefing)) return prompt;
  return [
    '<harness-relay-briefing>',
    'Standing instructions from Harness Relay, the app this conversation runs in. They replace any earlier ones and come before the message below.',
    '',
    briefing.trim(),
    '</harness-relay-briefing>',
    '',
    prompt,
  ].join('\n');
}

function rememberBriefing(sessionId: string, briefing: string): void {
  briefed.delete(sessionId);
  briefed.set(sessionId, hashOf(briefing));
  if (briefed.size > MAX_BRIEFED) briefed.delete(briefed.keys().next().value!);
}

// --- Permissions -------------------------------------------------------------------------------

/** The `toolCall` of a `session/request_permission` (with the input of its `tool_call`, which the request leaves out). */
export interface CursorToolCall {
  toolCallId?: string;
  kind?: string;
  title?: string;
  rawInput?: Record<string, any>;
  content?: unknown;
}

/**
 * What a title is about: the text between its first pair of backticks ("Edit `/w/a.ts`"), else an
 * absolute path or a URL after its first word ("Write /w/a.ts", "Fetch https://…"); not a word such
 * as "Edit File".
 */
function titleSubject(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const quoted = title.match(/`([^`]+)`/)?.[1];
  if (quoted) return quoted;
  const rest = title.replace(/^\S+\s+/, '').trim();
  return rest !== title.trim() && /^(\/|[A-Za-z]:[\\/]|~\/|https?:\/\/)/.test(rest) ? rest : undefined;
}

/** The command a shell call runs: its input's, else the one its title quotes. */
export function cursorCommand(call: CursorToolCall): string {
  const cmd = call.rawInput?.command;
  return typeof cmd === 'string' && cmd ? cmd : (call.title?.match(/^`([\s\S]*)`$/)?.[1] ?? '');
}

/** The file a write, edit or delete is about: its input's path, its diff's, or its title's. */
export function cursorPath(call: CursorToolCall): string | undefined {
  const p = call.rawInput?.path ?? call.rawInput?.file_path;
  if (typeof p === 'string' && p) return p;
  const diff = Array.isArray(call.content) ? call.content.find((c: any) => c?.type === 'diff' && typeof c.path === 'string') : undefined;
  return (diff as { path?: string } | undefined)?.path ?? titleSubject(call.title);
}

/** A web fetch or search: the main agent's (kind fetch, or a search titled "Web search…"), or a subagent's ("Allow web search?"). */
const isWeb = (call: CursorToolCall) =>
  call.kind === 'fetch' ||
  (call.kind === 'search' && /^web[ _]search/i.test(call.title ?? call.toolCallId ?? '')) ||
  (call.kind === 'other' && /^Allow web (search|fetch)\?$/.test(call.title ?? ''));

/** A delete (Cursor reports one as kind `edit`, titled "Delete `<path>`"). */
const isDelete = (call: CursorToolCall) => call.kind === 'delete' || /^delete\b/i.test(call.title ?? '');

/** A path as a shell takes it: `~` and `~/…` (`~\…` on Windows) are in the home folder, not in the working directory. */
export function cursorHomePath(path: string, home = homedir()): string {
  if (path === '~') return home;
  return /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path;
}

/**
 * Whether `path`, as Cursor gave it in `cwd`, is in `dir` (default: `cwd` itself), `~` and links on
 * the way resolved (a link in the project may lead out of it).
 */
const inside = (cwd: string, path: string, dir = cwd) => {
  const rel = relative(realPath(resolve(dir)), realPath(resolve(cwd, cursorHomePath(path))));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Whether to approve a call Cursor asks about under this permission. It has no sandbox, so below full
 * access the permission covers only web fetches and searches, reads, and in edit mode a delete inside
 * the working directory (Cursor asks about every delete). Every command, MCP tool call and anything
 * else goes to the user, and so does a write: Cursor writes inside the workspace without asking, except
 * its protected files (`.git/hooks/**`, `.git/config`, `.vscode/**`, `.cursor/*.json`…), where a write
 * could make code run later, outside any sandbox.
 */
export function cursorPermissionDecision(
  permission: Permission,
  call: CursorToolCall,
  cwd: string,
  addDirs: readonly string[] = [],
): AcpDecision {
  if (permission === 'full') return { allow: true };
  if (isWeb(call) || call.kind === 'read') return { allow: true };
  // A delete in any of the conversation's working directories (each has the same access as `cwd`).
  if (permission === 'edit' && isDelete(call)) {
    const path = cursorPath(call);
    if (path && [cwd, ...addDirs].some((dir) => inside(cwd, path, dir))) return { allow: true };
  }
  return { allow: false, reason: 'Not covered by the permission' };
}

/**
 * What to show the user when Cursor asks about a call the permission does not cover. A command it
 * runs once allowed runs outside any sandbox (Cursor has none over ACP), and the card says so.
 */
export function cursorApprovalRequest(call: CursorToolCall, cwd: string, addDirs: readonly string[] = []): ApprovalRequest {
  if (call.kind === 'execute')
    return { kind: 'command', detail: cursorCommand(call), reason: call.rawInput?.description, outsideSandbox: true };
  // Cursor asks about a write outside its workspace (`cwd`), and inside it only for its protected
  // files: say which, and when the file is in another of the conversation's working directories.
  if (call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move') {
    const path = cursorPath(call);
    const reason = isDelete(call)
      ? call.title
      : !path || inside(cwd, path)
        ? t().cursorProtectedWrite
        : addDirs.some((dir) => inside(cwd, path, dir))
          ? t().cursorOtherCwdWrite
          : t().cursorOutsideWrite;
    return { kind: 'edit', detail: path, reason };
  }
  if (call.kind === 'fetch') return { kind: 'fetch', detail: call.rawInput?.url ?? titleSubject(call.title), reason: call.title };
  const tool = call.title?.replace(/\s*\(.*$/, '') || call.kind || 'tool';
  return {
    kind: 'other',
    tool,
    detail: summarizeInput(call.rawInput, { wholePaths: true }) ?? acpContentText(call.content),
    reason: call.title,
  };
}

/**
 * Cursor asks the model's questions to the user as permission requests, one per question, when the
 * client has no `cursor/ask_question`: those carry a skip option. Agents ask the user through
 * Harness Relay instead (`[ASK_USER]`), so they are skipped.
 */
export function cursorQuestionSkip(options: { optionId: string; kind?: string }[]): string | undefined {
  return options.find((o) => o.optionId === '__ask_question_skip__')?.optionId;
}

// --- Session updates ---------------------------------------------------------------------------

/** What Cursor calls its tools in the chat: by kind, else its title (an MCP tool's `<server>: <tool>`). */
const KIND_NAME: Record<string, string> = {
  execute: 'Shell',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  read: 'Read',
  search: 'Search',
  fetch: 'Fetch',
  think: 'Think',
};

/**
 * Cursor's service errors, which it sends as reply text on a text block of their own (as its code
 * does in 2026.11.11: `"\n\nError: …"`, or "Please sign in", "Upgrade your plan", "Add a payment
 * method" or "Check your settings" "to continue"). Returns the error, or undefined. An error of
 * another kind it sends as its bare message, which cannot be told from a reply.
 */
export function cursorServiceError(chunk: string): string | undefined {
  if (!chunk.startsWith('\n\n')) return undefined;
  const text = chunk.trim();
  if (/^Error: \S/.test(text)) return text.slice('Error: '.length);
  if (/^(Upgrade your plan|Please sign in|Add a payment method|Check your settings) to continue\b/i.test(text)) return text;
  return undefined;
}

const DONE = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/** One call's latest title, kind and input, which arrive over several updates. */
interface CallState {
  kind?: string;
  title?: string;
  rawInput?: Record<string, any>;
  /** The detail given at `tool_start`; a better one comes with `tool_end` once known. */
  detail?: string;
}

/** A Task call's subagent type as Cursor names it: a name, or `{ custom: name }` for one of the user's. */
function cursorSubagentType(v: unknown): string | undefined {
  const name = v && typeof v === 'object' ? (v as { custom?: unknown }).custom : v;
  return typeof name === 'string' && name && name !== 'unspecified' ? name : undefined;
}

/** Whether a call is Cursor's Task tool, which starts a subagent (`rawInput._toolName: 'task'`, 2026.11.11). */
const isTask = (c: CallState) => c.rawInput?._toolName === 'task';

/**
 * Turns Cursor's ACP `session/update` payloads into AgentEvents. `readOnly`: its write tool may not
 * write or delete (`Write(**)`, which Cursor checks before it would ask), and reports such a call as
 * completed, so its writes and deletes are shown as not made.
 */
/**
 * Cursor's to-do list as plan entries: a `cursor/update_todos` request's todos (`{ id, content, status }`)
 * replace the list, or with `merge` change the items of the same id and add the others (as
 * `sendToolExtensionNotification` sends them, cursor-agent 2026.11.11's bundle). Its statuses are
 * pending, in_progress, completed and cancelled; a cancelled item is no longer part of the plan.
 * Undefined when the request holds no todos.
 */
export function cursorTodos(
  current: readonly CursorTodo[],
  params: Record<string, any> | undefined,
): { todos: CursorTodo[]; entries: PlanEntry[] } | undefined {
  const given: CursorTodo[] = (Array.isArray(params?.todos) ? params.todos : [])
    .filter((x: any) => x && typeof x.id === 'string' && typeof x.content === 'string')
    .map((x: any) => ({ id: x.id, content: x.content, status: typeof x.status === 'string' ? x.status : 'pending' }));
  if (!given.length) return undefined;
  let todos: CursorTodo[];
  if (params?.merge === true) {
    todos = current.map((x) => given.find((g) => g.id === x.id) ?? x);
    for (const g of given) if (!current.some((x) => x.id === g.id)) todos.push(g);
  } else todos = given;
  const entries = todos
    .filter((x) => x.status !== 'cancelled')
    .map((x): PlanEntry => ({ text: x.content, status: x.status === 'completed' || x.status === 'in_progress' ? x.status : 'pending' }));
  return { todos, entries };
}

/** One item of Cursor's to-do list. */
export interface CursorTodo {
  id: string;
  content: string;
  status: string;
}

export function createCursorUpdateHandler(emit: (e: AgentEvent) => void, readOnly = false) {
  const calls = new Map<string, CallState>();
  const open = new Set<string>();
  /** Calls of its to-do tool, shown as the plan rather than as tool rows. */
  const todoCalls = new Set<string>();
  let todos: CursorTodo[] = [];
  const refused = new Map<string, string>();
  let inText = false;
  let serviceError: string | undefined;
  /**
   * The subagents' sessions (with the `subagents` client capability, Cursor 2026.11.11 makes each
   * subagent a session of its own, announced by `subagent_spawned` on the session that started it,
   * with `_meta.cursor.toolCallId`, its Task call): for each, that call.
   */
  const children = new Map<string, string>();
  /** What each subagent last said (its words stay out of the chat): what it reported, when its call does not say. */
  const words = new Map<string, string>();
  /** Task calls that answered while their subagent works on in the background (`rawOutput.isBackground`). */
  const background = new Set<string>();
  /** The subagent's name and model each Task call's row shows. */
  const named = new Map<string, { agent?: string; model?: string }>();
  /**
   * Names a Task call's subagent (its type, then the name and model Cursor gave it), when that says
   * something new; for a call not shown yet, its row gets them when it is.
   */
  const nameTask = (id: string, agent?: string, model?: string) => {
    const was = named.get(id) ?? {};
    const now = { agent: agent ?? was.agent, model: model ?? was.model };
    if (now.agent === was.agent && now.model === was.model) return;
    named.set(id, now);
    if (open.has(id) || calls.has(id))
      emit({ type: 'tool_start', id, name: 'Task', ...(agent ? { agent } : {}), ...(model ? { model } : {}) });
  };

  const closeText = () => {
    if (inText) {
      inText = false;
      emit({ type: 'text_end' });
    }
  };

  const remember = (id: string, u: Record<string, any>): CallState => {
    const c = calls.get(id) ?? {};
    if (typeof u.kind === 'string') c.kind = u.kind;
    if (typeof u.title === 'string' && u.title) c.title = u.title;
    if (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length) c.rawInput = u.rawInput;
    calls.set(id, c);
    return c;
  };

  const detailOf = (c: CallState) =>
    summarizeInput(c.rawInput) ?? (c.kind === 'execute' ? undefined : titleSubject(c.title) && clip(titleSubject(c.title)!));

  /** The last words of the subagent a Task call started, if it said any. */
  const saidFor = (callId: string) => {
    for (const [session, call] of children) if (call === callId && words.get(session)?.trim()) return words.get(session)!.trim();
    return undefined;
  };

  const finish = (id: string, c: CallState, u: Record<string, any>) => {
    const out = u.rawOutput && typeof u.rawOutput === 'object' ? (u.rawOutput as Record<string, any>) : undefined;
    // A background subagent's call answers at once: its row ends when the subagent does.
    if (isTask(c) && out?.isBackground === true && u.status === 'completed') {
      background.add(id);
      return;
    }
    open.delete(id);
    const code = typeof out?.exitCode === 'number' ? out.exitCode : undefined;
    const printed = [out?.stdout, out?.stderr].filter((s): s is string => typeof s === 'string' && s.length > 0).join('\n');
    const text = acpContentText(u.content);
    const blocked = readOnly && (c.kind === 'edit' || c.kind === 'delete') && u.status === 'completed';
    const why = refused.get(id) ?? (blocked ? t().cursorReadOnlyWrite : undefined);
    const ok = u.status === 'completed' && !why && (code === undefined || code === 0);
    const said = ok && !printed && !text && isTask(c) ? saidFor(id) : undefined;
    const output = printed ? tailText(printed) : ok && text ? tailText(text) : said ? tailText(said) : undefined;
    const error = ok ? undefined : (why ?? (code !== undefined && code !== 0 ? t().cursorExitCode(code) : text));
    const detail = !c.detail ? detailOf(c) : undefined;
    emit({ type: 'tool_end', id, ok, ...(error ? { error } : {}), ...(output ? { output } : {}), ...(detail ? { detail } : {}) });
  };

  /** A call's update, the agent's own or a subagent's (`parentId`: the Task call that started it). */
  const toolUpdate = (u: Record<string, any>, parentId?: string) => {
    const id = String(u.toolCallId ?? '');
    if (!id) return;
    // Its to-do tool (`_toolName` in the input Cursor gives the call): the list comes as the plan.
    if (todoCalls.has(id)) return;
    if (u.sessionUpdate === 'tool_call') {
      const c = remember(id, u);
      if (c.rawInput?._toolName === 'updateTodos') return void todoCalls.add(id);
      if (!open.has(id)) {
        open.add(id);
        c.detail = detailOf(c);
        const kind = toolCallKind(c.kind);
        const known = isTask(c) ? named.get(id) : undefined;
        const agent = isTask(c) ? (known?.agent ?? cursorSubagentType(c.rawInput?.subagentType) ?? 'subagent') : undefined;
        const model = known?.model;
        if (agent) named.set(id, { agent, model });
        emit({
          type: 'tool_start',
          id,
          name: agent ? 'Task' : (KIND_NAME[c.kind ?? ''] ?? (c.title || 'tool')),
          ...(c.detail ? { detail: c.detail } : {}),
          ...(kind ? { kind } : {}),
          ...(parentId ? { parentId } : {}),
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
        });
      }
      if (DONE.has(u.status)) finish(id, c, u);
      return;
    }
    if (!open.has(id) || background.has(id)) return;
    const c = remember(id, u);
    if (DONE.has(u.status)) finish(id, c, u);
  };

  /** `subagent_spawned` and `subagent_state_update`, on the session that started the subagent. */
  const lifecycle = (u: Record<string, any>) => {
    const session = typeof u.subagentSessionId === 'string' ? u.subagentSessionId : '';
    const meta = u._meta?.cursor ?? {};
    if (u.sessionUpdate === 'subagent_spawned') {
      const call = typeof meta.toolCallId === 'string' ? meta.toolCallId : '';
      if (!session || !call) return;
      children.set(session, call);
      const agent = typeof u.name === 'string' && u.name ? u.name : undefined;
      const model = typeof meta.model === 'string' && meta.model ? meta.model : undefined;
      nameTask(call, agent, model);
      return;
    }
    // `completed`, `failed`, `cancelled` or `disconnected`: the end of a background subagent's row.
    const call = children.get(session);
    if (!call || !background.delete(call)) return;
    open.delete(call);
    const ok = u.state === 'completed';
    const said = saidFor(call);
    emit({
      type: 'tool_end',
      id: call,
      ok,
      ...(ok && said ? { output: tailText(said) } : {}),
      ...(!ok ? { error: u.state === 'disconnected' ? t().backgroundCutOff : String(u.state ?? 'failed') } : {}),
    });
  };

  function handle(u: Record<string, any> | undefined): void {
    if (!u) return;
    switch (u.sessionUpdate) {
      case 'subagent_spawned':
      case 'subagent_state_update':
        lifecycle(u);
        break;
      case 'agent_message_chunk': {
        const text = u.content?.text;
        if (typeof text !== 'string' || !text) break;
        const failure = cursorServiceError(text);
        if (failure) {
          serviceError = failure;
          break;
        }
        inText = true;
        emit({ type: 'text', text });
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
        closeText();
        toolUpdate(u);
        break;
      case 'tool_call_update':
        toolUpdate(u);
        break;
    }
  }

  /**
   * An update on a subagent's own session: its calls under the Task call that started it, its own
   * subagents announced, its words kept for what it reported. False for a session that is no subagent's.
   */
  function child(sessionId: string, u: Record<string, any> | undefined): boolean {
    const call = children.get(sessionId);
    if (!call || !u) return false;
    switch (u.sessionUpdate) {
      case 'subagent_spawned':
      case 'subagent_state_update':
        lifecycle(u);
        break;
      case 'agent_message_chunk':
        if (typeof u.content?.text === 'string') words.set(sessionId, (words.get(sessionId) ?? '') + u.content.text);
        break;
      case 'tool_call':
      case 'tool_call_update':
        toolUpdate(u, call);
        break;
    }
    return true;
  }

  return {
    handle,
    /** A `cursor/update_todos` request: the plan it makes, emitted; its call is not shown as a tool row. */
    todos(params: Record<string, any> | undefined) {
      if (typeof params?.toolCallId === 'string') todoCalls.add(params.toolCallId);
      const next = cursorTodos(todos, params);
      if (!next) return;
      todos = next.todos;
      closeText();
      emit({ type: 'plan', entries: next.entries });
    },
    child,
    /**
     * `cursor/task`, which Cursor sends as a Task call completes (`{ toolCallId, description, prompt,
     * subagentType, model?, agentId?, durationMs? }`, 2026.11.11): the subagent's name and model on its row.
     */
    task(p: Record<string, any> | undefined) {
      const id = typeof p?.toolCallId === 'string' ? p.toolCallId : '';
      const agent = cursorSubagentType(p?.subagentType);
      const model = typeof p?.model === 'string' && p.model ? p.model : undefined;
      if (id && calls.has(id)) nameTask(id, agent, model);
    },
    /** The turn is over: a background subagent Cursor did not wait for was cut off with it. */
    finishSubagents() {
      for (const id of [...background]) {
        background.delete(id);
        open.delete(id);
        emit({ type: 'tool_end', id, ok: false, error: t().backgroundCutOff });
      }
    },
    /** The title, kind and input Cursor gave a call so far (its permission requests leave the input out). */
    call(toolCallId: string): CallState | undefined {
      return calls.get(toolCallId);
    },
    /** Remember why a call was refused, to show under it (Cursor reports a refused call as completed). */
    refused(toolCallId: string, label: string) {
      refused.set(toolCallId, label);
    },
    finish: closeText,
    /** A service error Cursor sent as reply text, if any. */
    get serviceError() {
      return serviceError;
    },
  };
}

// --- The runner --------------------------------------------------------------------------------

/** Why `authenticate` failed, without the sign-in link Cursor adds (signing in goes through Settings). */
export function cursorSignInError(message: string): string {
  return message
    .replace(/[\s.:]*Please visit:?\s*https?:\/\/\S+/gi, '')
    .replace(/[\s:]+$/, '')
    .trim();
}

/** The decision after the user declined; Cursor cannot pass their note to the model. */
function declinedLabel(note?: string): string {
  return note ? `${t().approvalDeclined} ${note}` : t().approvalDeclined;
}

export const cursorRunner: AgentRunner = {
  provider: 'cursor',
  async run(o): Promise<RunResult> {
    if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
    const deny = o.permission === 'full' ? [] : (o.protectedPaths ?? agentProtectedReads());
    // The team's protected paths (with full access too) are patterns of its own, never checked as names.
    // A path Cursor would read as a pattern would be left unprotected: the run does not start.
    const pattern = patternPath(deny);
    if (pattern) throw new AgentRunError(t().protectedPattern(pattern));
    let run: CursorRun;
    try {
      run = prepareCursorRun(cursorConfigDir(o.env), o.permission, cursorDenyRules(o.permission, deny, o.guard));
    } catch (err) {
      throw new AgentRunError(t().cursorConfigFailed((err as Error).message));
    }
    try {
      return await cursorTurn(o, run.dir);
    } finally {
      run.done();
    }
  },
};

/** One Cursor turn over ACP, with `configDir` as its config folder. */
async function cursorTurn(o: RunOptions, configDir: string): Promise<RunResult> {
  let child: ChildProcess | undefined;
  let sessionId: string | undefined;
  let userAborted = false;
  /** While a resumed session replays its history (before `session/load` answers), its updates are not this turn's. */
  let replaying = false;
  const stop = new AbortController();
  const stopSoon = (ms: number) => setTimeout(() => stop.abort(), ms).unref();

  const conn = new JsonRpcConnection((line) => child?.stdin?.write(line + '\n'));
  const updates = createCursorUpdateHandler(o.onEvent, o.permission === 'read-only');
  conn.onNotification = (method, params) => {
    if (method !== 'session/update' || replaying) return;
    if (!sessionId) return;
    // Another session: a subagent's (the handler knows those of this turn), or not this turn's.
    if (params?.sessionId !== sessionId) return void updates.child(String(params?.sessionId), params?.update);
    updates.handle(params.update);
  };
  conn.onRequest = async (method, params) => {
    // Its to-do list in agent mode, sent as a request it does not wait for (no session id in it).
    if (method === 'cursor/update_todos') {
      if (!replaying) updates.todos(params);
      return {};
    }
    // Sent as a Task call completes, without waiting for the answer: it names the call's subagent.
    if (method === 'cursor/task') {
      if (!replaying) updates.task(params);
      return {};
    }
    if (method !== 'session/request_permission') throw new RpcError(-32601, `${method} is not supported`);
    const options: { optionId: string; kind: string }[] = Array.isArray(params?.options) ? params.options : [];
    const skip = cursorQuestionSkip(options);
    if (skip) return { outcome: { outcome: 'selected', optionId: skip } };
    const asked = (params?.toolCall ?? {}) as CursorToolCall;
    const known = asked.toolCallId ? updates.call(asked.toolCallId) : undefined;
    const call: CursorToolCall = { ...known, ...asked, rawInput: asked.rawInput ?? known?.rawInput, kind: asked.kind ?? known?.kind };
    let decision = cursorPermissionDecision(o.permission, call, o.cwd, o.addDirs);
    let label = t().cursorRefused;
    if (!decision.allow && o.requestApproval) {
      const answer = await o.requestApproval(cursorApprovalRequest(call, o.cwd, o.addDirs));
      decision = answer.allow ? { allow: true } : { allow: false, reason: answer.note ?? '' };
      label = declinedLabel(answer.note);
    }
    if (!decision.allow && call.toolCallId) updates.refused(call.toolCallId, label);
    // Never "allow always": Cursor would write the rule into its settings.
    return answerPermission(
      decision,
      options.filter((x) => x.kind !== 'allow_always' && x.kind !== 'reject_always'),
    );
  };

  const onAbort = () => {
    userAborted = true;
    if (sessionId) conn.notify('session/cancel', { sessionId });
    stopSoon(2000);
  };
  o.signal.addEventListener('abort', onAbort, { once: true });

  const env = cursorEnv(o.env, configDir);
  const exited = runProcess({
    bin: o.bin,
    args: cursorArgs(o.permission),
    cwd: o.cwd, // Cursor reads the instruction files (AGENTS.md, .cursor/rules…) from the folder it starts in
    env,
    signal: stop.signal,
    timeoutMs: TURN_TIMEOUT_MS,
    keepStdinOpen: true,
    onSpawn: (c) => (child = c),
    onLine: conn.handleLine,
  }).then(
    (res) => {
      conn.close(new AgentRunError(res.timedOut ? t().timedOut : tail(res.stderr) || t().exitedWithoutTurn('cursor-agent', res.code)));
      return res;
    },
    (err: Error) => {
      conn.close(err);
      throw err;
    },
  );
  exited.catch(() => undefined); // surfaced through the pending requests instead

  try {
    const init = await conn.request('initialize', {
      protocolVersion: 1,
      // A model and its reasoning effort as two settings (else one entry per combination). `subagents`:
      // each subagent a session of its own, linked to its Task call, and a prompt that answers only once
      // its background subagents are done (`_meta.subagents`, read by 2026.11.11's `initialize`).
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { parameterizedModelPicker: true, subagents: true },
      },
    });
    // With an API key Cursor is signed in already; `authenticate` would drop the stored key.
    const methods: { id?: string }[] = Array.isArray(init?.authMethods) ? init.authMethods : [];
    if (!env.CURSOR_API_KEY && !env.CURSOR_AUTH_TOKEN && methods.some((m) => m.id === 'cursor_login')) {
      await conn.request('authenticate', { methodId: 'cursor_login' }).catch((err: Error) => {
        // Cursor's own words are in the error's data. Its sign-in link would lead nowhere: this
        // process, which would finish that sign-in, ends with the turn.
        const data = err instanceof RpcError ? (err.data as { message?: unknown } | undefined) : undefined;
        throw new AgentRunError(t().cursorSignIn(cursorSignInError(typeof data?.message === 'string' ? data.message : err.message)));
      });
    }
    const mcpServers = acpMcpServers(o.mcpServers ?? [], Boolean(init?.agentCapabilities?.mcpCapabilities?.http), 'cursor');
    let configOptions: any[] | undefined;
    if (o.sessionId) {
      replaying = true;
      sessionId = o.sessionId;
      const r = await conn.request('session/load', { sessionId, cwd: o.cwd, mcpServers });
      replaying = false;
      configOptions = r?.configOptions;
    } else {
      const r = await conn.request('session/new', { cwd: o.cwd, mcpServers });
      sessionId = String(r?.sessionId ?? '');
      if (!sessionId) throw new AgentRunError(t().cursorNoSession);
      configOptions = r?.configOptions;
    }
    o.onEvent({ type: 'session', sessionId });
    if (userAborted) throw new AgentRunError(t().stopped, true);

    configOptions = await setCursorOptions(conn, sessionId, configOptions, o);

    const briefing = o.systemPrompt;
    const text = cursorPromptText(o.prompt, briefing, o.sessionId ? briefed.get(o.sessionId) : undefined);
    const result = await conn.request('session/prompt', { sessionId, prompt: acpPrompt(text, o.images) });
    rememberBriefing(sessionId, briefing);
    updates.finish();
    updates.finishSubagents();
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (updates.serviceError) throw new AgentRunError(t().cursorService(updates.serviceError));
    if (result?.stopReason === 'cancelled') throw new AgentRunError(t().cursorCancelled);
    return { sessionId };
  } catch (err) {
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (err instanceof AgentRunError) throw err;
    throw new AgentRunError(err instanceof Error ? err.message : String(err));
  } finally {
    replaying = false;
    o.signal.removeEventListener('abort', onAbort);
    child?.stdin?.end(); // cursor-agent exits when its stdin closes
    stopSoon(3000);
    await exited.catch(() => undefined);
  }
}

/** A session's config option by id or category. */
const option = (opts: any[] | undefined, pick: (c: any) => boolean) => (Array.isArray(opts) ? opts.find(pick) : undefined);

/**
 * Puts the session in agent mode (a loaded one may be in another), and sets its model and then its
 * reasoning effort (the model's option of category `thought_level`, named differently per model), each
 * only when it differs. A model without such an option (Auto, say), or without that effort among its
 * values, runs at its own effort. Returns the session's options as they then are.
 */
async function setCursorOptions(
  conn: JsonRpcConnection,
  sessionId: string,
  configOptions: any[] | undefined,
  o: RunOptions,
): Promise<any[] | undefined> {
  let opts = configOptions;
  const set = async (configId: string, value: string, rejected: (value: string, err: string) => string) => {
    const r = await conn.request('session/set_config_option', { sessionId, configId, value }).catch((err: Error) => {
      throw new AgentRunError(rejected(value, err.message));
    });
    if (Array.isArray(r?.configOptions)) opts = r.configOptions;
  };
  const mode = option(opts, (c) => c?.id === 'mode');
  if (mode && mode.currentValue !== 'agent') await set('mode', 'agent', (_v, err) => t().cursorRejectedMode(err));
  if (o.model && option(opts, (c) => c?.id === 'model')?.currentValue !== o.model) await set('model', o.model, t().cursorRejectedModel);
  // Only an effort the model offers: a team's default effort may not fit every model.
  const effort = o.effort ? cursorEffortOption(opts) : undefined;
  if (o.effort && effort && cursorOptionValues(effort).includes(o.effort) && effort.currentValue !== o.effort) {
    await set(String(effort.id), o.effort, t().cursorRejectedEffort);
  }
  return opts;
}
