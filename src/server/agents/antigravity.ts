import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Permission } from '../../shared/types';
import { t } from '../i18n';
import { converse, runProcess, tail } from '../process';
import { protectedReads, realPath } from '../protect';
import { ANTIGRAVITY_HOME_ENV } from '../settings';
import { JsonRpcConnection, RpcError, acpContentText, acpMcpServers, acpPrompt, answerPermission, type AcpDecision } from './acp';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  clipPath,
  summarizeInput,
  tailText,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type RunOptions,
  type RunResult,
} from './types';

/*
 * Antigravity runs as an ACP agent (`agy acp`: JSON-RPC over stdin/stdout), like Grok and Cursor. What
 * its ACP server does, as read from agy 1.5.6 and tried with it (on a Gemini API key, against a
 * stand-in for the Gemini API):
 *
 * - In its `default` mode it asks (`session/request_permission`, allow-once or deny-once) before every
 *   command, every write and edit, and every read outside the workspace; it reads in the workspace and
 *   searches the web without asking. Its own permission rules (`permissions.allow` / `deny` in its
 *   settings) do not apply over ACP, but its `toolPermission` setting does: `proceed-in-sandbox` or
 *   `always-proceed` would run commands without asking. Each run therefore gets settings of its own
 *   (`--cli_dir_name`: a folder in the account's `antigravity-cli` folder, removed after the run) with
 *   `toolPermission: "request-review"`, so everything it would ask about comes to Harness Relay.
 * - Its terminal sandbox (`--sandbox`) lets commands write nowhere in the working directory over ACP
 *   (only in the temporary folder), so it is not turned on: as with Cursor, every command goes to the
 *   user below full access, and one they allow runs outside any sandbox.
 * - Full access: `--dangerously-skip-permissions` (nothing asks).
 * - A refused call ends its turn: Antigravity tells the model nothing and stops (`stopReason:
 *   "end_turn"`), whatever the answer's `_meta` says.
 * - The briefing goes into its system prompt (`_meta.antigravity.systemPrompt.append` on `session/new`
 *   and `session/resume`, which it advertises). Each one sent is added to the session's system prompt,
 *   so a resumed session is given it again only when it changed.
 * - Its home has no variable: `--gemini-dir` moves the whole `.gemini` folder for `agy acp`.
 * - Model and thinking level are the session's config options `model` and `thought_level`; a resumed
 *   session starts again on the account's default model, so both are set on every turn they are given.
 */

/** The `.gemini` folder of an account (`ANTIGRAVITY_HOME_ENV`), else the user's own. */
export function antigravityGeminiDir(env: NodeJS.ProcessEnv, home = homedir()): string {
  const root = env[ANTIGRAVITY_HOME_ENV];
  return join(root ? root : home, '.gemini');
}

/** The account's CLI folder, where its settings, conversations and logs are. */
export function antigravityAppDir(env: NodeJS.ProcessEnv, home = homedir()): string {
  return join(antigravityGeminiDir(env, home), 'antigravity-cli');
}

/**
 * agy opens a browser on this computer to sign in, unless it finds itself in an SSH session: then it
 * prints the link (and waits for the code on its standard input). It has no other switch for it.
 */
export const ANTIGRAVITY_NO_BROWSER = { SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0' } as const;

/**
 * The environment of a command that asks Antigravity something (`agy models`, `agy -p /skills`, its
 * sign-in and sign-out): an account's home as `HOME` (`USERPROFILE` on Windows), since only `agy acp`
 * takes `--gemini-dir`, and no browser opened (`ANTIGRAVITY_NO_BROWSER`) when it finds itself signed
 * out; Harness Relay's own variable is not passed on.
 */
export function antigravityProbeEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const root = env[ANTIGRAVITY_HOME_ENV];
  const out: NodeJS.ProcessEnv = { ...env, ...ANTIGRAVITY_NO_BROWSER };
  delete out[ANTIGRAVITY_HOME_ENV];
  if (root) out[platform === 'win32' ? 'USERPROFILE' : 'HOME'] = root;
  return out;
}

/**
 * The settings a question to Antigravity needs for this one command (`agy --settings`, never saved):
 * with a Gemini API key, `modelProvider: "gemini"`, without which agy does not use the key and answers
 * as if signed out. Placed before the subcommand (`agy --settings … models`); `-p` takes it after.
 */
export function antigravityProbeSettings(env: NodeJS.ProcessEnv): string[] {
  return env.GEMINI_API_KEY ? ['--settings', JSON.stringify({ modelProvider: 'gemini' })] : [];
}

/**
 * Signs Antigravity out (its ACP `logout`, which drops the Google sign-in it keeps), in the account's
 * home. Resolves once agy answered; fails with what went wrong otherwise.
 */
export async function antigravityLogout(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<void> {
  let error: string | undefined;
  let done = false;
  const failed = (msg: Record<string, any>) => String(msg.error?.data?.message ?? msg.error?.message ?? 'error');
  const own: NodeJS.ProcessEnv = { ...env, ...ANTIGRAVITY_NO_BROWSER };
  delete own[ANTIGRAVITY_HOME_ENV];
  const res = await converse({
    bin,
    args: ['acp', ...(env[ANTIGRAVITY_HOME_ENV] ? ['--gemini-dir', antigravityGeminiDir(env)] : [])],
    cwd: homedir(),
    env: own,
    timeoutMs,
    open: (write) => write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }),
    onMessage: (msg, write, finish) => {
      if (msg.method !== undefined) return;
      if (msg.error) {
        error = failed(msg);
        finish();
      } else if (msg.id === 1) write({ jsonrpc: '2.0', id: 2, method: 'logout', params: {} });
      else if (msg.id === 2) {
        done = true;
        finish();
      }
    },
  });
  if (!done) throw new Error(error ?? (res.timedOut ? t().timedOut : tail(res.stderr, 300) || t().logoutFailed(null)));
}

/** How the folders of runs' own settings begin, in the account's CLI folder. */
export const ANTIGRAVITY_RUN_PREFIX = 'harness-relay-';

/**
 * The arguments of a run: its home (`--gemini-dir`, when the account has one of Harness Relay's own),
 * its own settings folder (`--cli_dir_name`, relative to the CLI folder: agy takes no absolute one), and
 * in full access nothing asks.
 */
export function antigravityArgs(env: NodeJS.ProcessEnv, permission: Permission, runDir: string): string[] {
  return [
    'acp',
    ...(env[ANTIGRAVITY_HOME_ENV] ? ['--gemini-dir', antigravityGeminiDir(env)] : []),
    '--cli_dir_name',
    runDir,
    ...(permission === 'full' ? ['--dangerously-skip-permissions'] : []),
  ];
}

/**
 * The settings of one run: the account's own (`settings.json`: its model, theme, sandbox…), with
 * `toolPermission: "request-review"` (so that nothing runs without asking that Harness Relay has not
 * decided on; full access passes `--dangerously-skip-permissions` instead), the default mode (the mode
 * is also set on each session), and, with a Gemini API key, `modelProvider: "gemini"`, without which
 * agy does not use the key.
 */
export function antigravityRunSettings(own: unknown, permission: Permission, apiKey: boolean): Record<string, unknown> {
  const base = own && typeof own === 'object' && !Array.isArray(own) ? { ...(own as Record<string, unknown>) } : {};
  return {
    ...base,
    toolPermission: permission === 'full' ? 'always-proceed' : 'request-review',
    agentMode: '',
    ...(apiKey ? { modelProvider: 'gemini' } : {}),
  };
}

/** The settings folders of runs now under way, by path (two servers may share one home: see `sweep`). */
const runsInUse = new Set<string>();

/** A run's own settings folder, and how to remove it. */
export interface AntigravityRun {
  /** Its name in the CLI folder (`--cli_dir_name`). */
  name: string;
  dir: string;
  done(): void;
}

/**
 * Removes the settings folders runs left behind (the server stopped during one), once they are older
 * than a turn may last: another Harness Relay on the same home may be running one.
 */
function sweep(appDir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(appDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(ANTIGRAVITY_RUN_PREFIX)) continue;
    const dir = join(appDir, name);
    if (runsInUse.has(dir)) continue;
    try {
      if (now - statSync(dir).mtimeMs > TURN_TIMEOUT_MS + 60_000) rmSync(dir, { recursive: true, force: true });
    } catch {
      // gone already, or not ours to remove: the next run tries again
    }
  }
}

/**
 * Makes a run's settings folder in the account's CLI folder (owner only), with its `settings.json`
 * (`antigravityRunSettings`); the account's own settings stay as they are.
 */
export function prepareAntigravityRun(appDir: string, permission: Permission, apiKey: boolean): AntigravityRun {
  let own: unknown;
  try {
    own = JSON.parse(readFileSync(join(appDir, 'settings.json'), 'utf8'));
  } catch {
    own = undefined; // none yet, or not JSON: agy's defaults
  }
  mkdirSync(appDir, { recursive: true, mode: 0o700 });
  sweep(appDir);
  const name = `${ANTIGRAVITY_RUN_PREFIX}${randomBytes(6).toString('hex')}`;
  const dir = join(appDir, name);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  runsInUse.add(dir);
  const done = () => {
    runsInUse.delete(dir);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(antigravityRunSettings(own, permission, apiKey), null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    done();
    throw err;
  }
  return { name, dir, done };
}

// --- The briefing ------------------------------------------------------------------------------

/** The briefing each session was last given (a hash): every one sent is added to its system prompt. */
const briefed = new Map<string, string>();
const MAX_BRIEFED = 1000;

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * What the briefing adds for Antigravity: a refused tool call ends its turn at once (the model is told
 * nothing), and its own question tool ends the turn without Harness Relay knowing it asked.
 */
export const ANTIGRAVITY_NOTES =
  'In this app, a tool call that is refused (by the user, or because the conversation\'s permission does not cover it) ends your turn at once, ' +
  'and you are not told why. So before a call that may need the user\'s approval (a shell command, a write outside the working directories), ' +
  'first say in your reply what you are about to do and why. To ask the user something, ask as these instructions say, not with your ask_question tool.';

/** The briefing as it is added to the system prompt: it replaces any earlier one the session was given. */
export function antigravityBriefing(briefing: string): string {
  return [
    '<harness-relay-briefing>',
    'Standing instructions from Harness Relay, the app this conversation runs in. They replace any earlier Harness Relay instructions in this conversation.',
    '',
    briefing.trim(),
    '',
    ANTIGRAVITY_NOTES,
    '</harness-relay-briefing>',
  ].join('\n');
}

/**
 * The `_meta` of `session/new` or `session/resume`: the briefing for its system prompt, in a new
 * session and in a resumed one last given another (`lastBriefing`, its hash); none otherwise.
 */
export function antigravitySessionMeta(briefing: string, lastBriefing?: string): Record<string, unknown> | undefined {
  if (!briefing.trim() || lastBriefing === hashOf(briefing)) return undefined;
  return { antigravity: { systemPrompt: { append: antigravityBriefing(briefing) } } };
}

/** The prompt text when agy cannot take the briefing in its system prompt (it does not advertise it): the briefing on top. */
export function antigravityPromptText(prompt: string, briefing: string, lastBriefing?: string): string {
  if (!briefing.trim() || lastBriefing === hashOf(briefing)) return prompt;
  return `${antigravityBriefing(briefing)}\n\n${prompt}`;
}

function rememberBriefing(sessionId: string, briefing: string): void {
  briefed.delete(sessionId);
  briefed.set(sessionId, hashOf(briefing));
  if (briefed.size > MAX_BRIEFED) briefed.delete(briefed.keys().next().value!);
}

// --- Permissions -------------------------------------------------------------------------------

/** The `toolCall` of a `session/request_permission` (agy sends the whole tool call, its input too). */
export interface AntigravityToolCall {
  toolCallId?: string;
  /** agy's own tool name (`run_command`, `write_file`, `read_file`, `edit_file`, `search_web`…). */
  name?: string;
  kind?: string;
  title?: string;
  rawInput?: Record<string, any>;
  locations?: { path?: string }[];
  content?: unknown;
}

/** The command a call runs. */
export function antigravityCommand(call: AntigravityToolCall): string {
  const cmd = call.rawInput?.CommandLine ?? call.rawInput?.command;
  return typeof cmd === 'string' && cmd ? cmd : (call.title ?? '');
}

/** The file a read, write or edit is about: its input's path, else its first location. */
export function antigravityPath(call: AntigravityToolCall): string | undefined {
  const p = call.rawInput?.Path ?? call.rawInput?.path ?? call.rawInput?.AbsolutePath ?? call.rawInput?.SearchPath ?? call.rawInput?.DirectoryPath;
  if (typeof p === 'string' && p) return p;
  const loc = Array.isArray(call.locations) ? call.locations.find((l) => typeof l?.path === 'string' && l.path) : undefined;
  return loc?.path;
}

/** A path as a shell takes it: `~` and `~/…` (`~\…` on Windows) are in the home folder. */
function homePath(path: string, home = homedir()): string {
  if (path === '~') return home;
  return /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path;
}

/** Whether `path`, given in `cwd`, is `dir` or inside it, links on the way resolved. */
function within(cwd: string, path: string, dir: string): boolean {
  const rel = relative(realPath(resolve(dir)), realPath(resolve(cwd, homePath(path))));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The project folders where a write could change what an agent does later, outside any sandbox (its
 * hooks, MCP servers, settings): Antigravity's own (`.agents`, `.agent`, `_agents`, `_agent`, which it
 * reads from the working directory up to the repository's root), the other CLIs', git's hooks and
 * config, and the editor's tasks.
 */
const AGENT_CONFIG = [/^\.agents?$/, /^_agents?$/, /^\.gemini$/, /^\.claude$/, /^\.codex$/, /^\.grok$/, /^\.cursor$/, /^\.vscode$/, /^\.mcp\.json$/];

/** Whether a path inside `dir` is one where a write could change how agents run (`AGENT_CONFIG`, `.git/hooks`, `.git/config`). */
function agentConfigPath(cwd: string, path: string, dir: string): boolean {
  const rel = relative(realPath(resolve(dir)), realPath(resolve(cwd, homePath(path))));
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.some((p) => AGENT_CONFIG.some((re) => re.test(p)))) return true;
  const git = parts.indexOf('.git');
  return git >= 0 && (parts[git + 1] === 'hooks' || parts[git + 1] === 'config');
}

/** A web search or fetch. */
const isWeb = (call: AntigravityToolCall) => call.kind === 'fetch' || call.name === 'search_web' || call.name === 'read_url_content';

/** A write, edit, delete or move. */
const isWrite = (call: AntigravityToolCall) =>
  call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move' || call.name === 'write_file' || call.name === 'edit_file';

/**
 * A read of a file or folder, or a search of its files with the place it searches given (a search
 * whose place is not known could be of a protected folder: it asks).
 */
const isRead = (call: AntigravityToolCall) =>
  call.kind === 'read' || call.name === 'read_file' || call.name === 'list_dir' || (call.kind === 'search' && !isWeb(call) && Boolean(antigravityPath(call)));

/** What to do with a call Antigravity asks about: run it, ask the user, or refuse it without asking. */
export type AntigravityDecision = { run: 'allow' } | { run: 'ask' } | { run: 'refuse'; reason: string };

/**
 * Whether to approve a call Antigravity asks about under this permission. Below full access it runs
 * no command without asking (it has no sandbox Harness Relay uses), so the permission covers reads (but
 * of the protected paths, which are refused), web searches and fetches, and in edit mode writes in the
 * conversation's working directories (but where a write could change how agents run, which go to the
 * user). Commands, MCP tool calls and anything else go to the user.
 */
export function antigravityPermissionDecision(
  permission: Permission,
  call: AntigravityToolCall,
  cwd: string,
  addDirs: readonly string[] = [],
  protectedPaths: readonly string[] = [],
): AntigravityDecision {
  if (permission === 'full') return { run: 'allow' };
  const path = antigravityPath(call);
  const isProtected = path ? protectedPaths.some((p) => within(cwd, path, p)) : false;
  if (isProtected) return { run: 'refuse', reason: t().antigravityProtected };
  if (isWeb(call)) return { run: 'allow' };
  if (isRead(call)) return { run: 'allow' };
  if (permission === 'edit' && isWrite(call) && path) {
    const dir = [cwd, ...addDirs].find((d) => within(cwd, path, d));
    if (dir && !agentConfigPath(cwd, path, dir)) return { run: 'allow' };
  }
  return { run: 'ask' };
}

/**
 * What to show the user when Antigravity asks about a call the permission does not cover. A command
 * it runs once allowed runs outside any sandbox, and the card says so; a write says why it was asked.
 */
export function antigravityApprovalRequest(
  permission: Permission,
  call: AntigravityToolCall,
  cwd: string,
  addDirs: readonly string[] = [],
): ApprovalRequest {
  const input = call.rawInput ?? {};
  const summary = typeof input.toolSummary === 'string' && input.toolSummary ? input.toolSummary : undefined;
  if (call.kind === 'execute' || call.name === 'run_command') {
    return { kind: 'command', detail: antigravityCommand(call), reason: summary, outsideSandbox: true };
  }
  if (isWrite(call)) {
    const path = antigravityPath(call);
    const dir = path ? [cwd, ...addDirs].find((d) => within(cwd, path, d)) : undefined;
    const reason =
      permission === 'read-only'
        ? (summary ?? call.title)
        : !path || !dir
          ? t().antigravityOutsideWrite
          : t().antigravityConfigWrite;
    return { kind: 'edit', detail: path, reason };
  }
  if (call.kind === 'fetch') return { kind: 'fetch', detail: input.Url ?? input.url ?? call.title, reason: call.title };
  const tool = call.name || call.title || call.kind || 'tool';
  return { kind: 'other', tool, detail: summarizeInput(input, { wholePaths: true }) ?? acpContentText(call.content), reason: summary ?? call.title };
}

// --- Session updates ---------------------------------------------------------------------------

/** What its tools are called in the chat: by kind, else agy's own name. */
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
 * A command's output as agy reports it, without the lines it puts first (`Created At: …`,
 * `Completed At: …`, `Command exited with code N.`, `Command output:`) or its "No output from the
 * command." when there was none.
 */
export function antigravityCommandOutput(text: string): string {
  const out = text.replace(/\r\n/g, '\n');
  const marker = out.indexOf('Command output:\n');
  if (marker >= 0) return out.slice(marker + 'Command output:\n'.length);
  return out
    .split('\n')
    .filter((l) => !/^(Created At|Completed At): /.test(l) && !/^Command exited with code -?\d+\.$/.test(l) && l.trim() !== 'No output from the command.')
    .join('\n')
    .trim();
}

const DONE = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/** One call's latest kind, name, title, input and location, which arrive over several updates. */
interface CallState {
  kind?: string;
  name?: string;
  title?: string;
  rawInput?: Record<string, any>;
  locations?: { path?: string }[];
}

/** Turns Antigravity's ACP `session/update` payloads into AgentEvents. */
export function createAntigravityUpdateHandler(emit: (e: AgentEvent) => void) {
  const calls = new Map<string, CallState>();
  const open = new Set<string>();
  const ended = new Set<string>();
  const refused = new Map<string, string>();
  let inText = false;

  const closeText = () => {
    if (inText) {
      inText = false;
      emit({ type: 'text_end' });
    }
  };

  const remember = (id: string, u: Record<string, any>): CallState => {
    const c = calls.get(id) ?? {};
    if (typeof u.kind === 'string') c.kind = u.kind;
    if (typeof u.name === 'string' && u.name) c.name = u.name;
    if (typeof u.title === 'string' && u.title) c.title = u.title;
    if (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length) c.rawInput = u.rawInput;
    if (Array.isArray(u.locations) && u.locations.length) c.locations = u.locations;
    calls.set(id, c);
    return c;
  };

  const detailOf = (c: CallState): string | undefined => {
    if (c.kind === 'execute' || c.name === 'run_command') return clip(antigravityCommand(c));
    const path = antigravityPath(c);
    if (path) return clipPath(path);
    return summarizeInput(c.rawInput) ?? (c.title ? clip(c.title) : undefined);
  };

  const start = (id: string, c: CallState) => {
    open.add(id);
    const detail = detailOf(c);
    emit({ type: 'tool_start', id, name: KIND_NAME[c.kind ?? ''] ?? (c.name || c.title || 'tool'), ...(detail ? { detail } : {}) });
  };

  const finish = (id: string, c: CallState, u: Record<string, any>) => {
    open.delete(id);
    ended.add(id);
    const out = u.rawOutput && typeof u.rawOutput === 'object' ? (u.rawOutput as Record<string, any>) : undefined;
    const code = typeof out?.exit_code === 'number' ? out.exit_code : undefined;
    const raw = typeof out?.output === 'string' ? out.output : acpContentText(u.content);
    const command = c.kind === 'execute' || c.name === 'run_command';
    const printed = raw ? (command ? antigravityCommandOutput(raw) : raw) : '';
    const why = refused.get(id);
    const ok = u.status === 'completed' && !why && (code === undefined || code === 0);
    const output = printed.trim() && (ok || command) ? tailText(printed) : undefined;
    const error = ok ? undefined : (why ?? (code !== undefined && code !== 0 ? t().antigravityExitCode(code) : printed.trim() ? tailText(printed, 500) : undefined));
    emit({ type: 'tool_end', id, ok, ...(error ? { error } : {}), ...(output ? { output } : {}) });
  };

  function handle(u: Record<string, any> | undefined): void {
    if (!u) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = u.content?.text;
        if (typeof text !== 'string' || !text) break;
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
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        if (!id || ended.has(id)) break;
        closeText();
        const c = remember(id, u);
        // A call agy reports only once it is over (it failed before it started) gets its row too.
        if (!open.has(id)) start(id, c);
        if (DONE.has(u.status)) finish(id, c, u);
        break;
      }
    }
  }

  return {
    handle,
    /** Remember why a call was refused, to show under it. */
    refused(toolCallId: string, label: string) {
      refused.set(toolCallId, label);
    },
    /** Whether a call was refused in this turn (agy then ends the turn). */
    get anyRefused() {
      return refused.size > 0;
    },
    finish: closeText,
  };
}

// --- The runner --------------------------------------------------------------------------------

/** The label under a call the user declined (agy takes no message with a refusal, and ends its turn). */
function declinedLabel(note?: string): string {
  return `${note ? `${t().approvalDeclined} ${note}` : t().approvalDeclined}${t().antigravityEndsTurn}`;
}

export const antigravityRunner: AgentRunner = {
  provider: 'antigravity',
  async run(o): Promise<RunResult> {
    if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
    let run: AntigravityRun;
    try {
      run = prepareAntigravityRun(antigravityAppDir(o.env), o.permission, Boolean(o.env.GEMINI_API_KEY));
    } catch (err) {
      throw new AgentRunError(t().antigravityConfigFailed((err as Error).message));
    }
    try {
      return await antigravityTurn(o, run.name);
    } finally {
      run.done();
    }
  },
};

/** One Antigravity turn over ACP, with its own settings folder `runDir` (in the account's CLI folder). */
async function antigravityTurn(o: RunOptions, runDir: string): Promise<RunResult> {
  let child: ChildProcess | undefined;
  let sessionId: string | undefined;
  let userAborted = false;
  /** Until `session/new` or `session/resume` answers, its updates are not this turn's. */
  let opening = true;
  const stop = new AbortController();
  const stopSoon = (ms: number) => setTimeout(() => stop.abort(), ms).unref();
  const protectedPaths = o.permission === 'full' ? [] : (o.protectedPaths ?? protectedReads());

  const conn = new JsonRpcConnection((line) => child?.stdin?.write(line + '\n'));
  const updates = createAntigravityUpdateHandler(o.onEvent);
  conn.onNotification = (method, params) => {
    if (method !== 'session/update' || opening) return;
    if (!sessionId || params?.sessionId !== sessionId) return;
    updates.handle(params.update);
  };
  conn.onRequest = async (method, params) => {
    if (method !== 'session/request_permission') throw new RpcError(-32601, `${method} is not supported`);
    const options: { optionId: string; kind: string }[] = Array.isArray(params?.options) ? params.options : [];
    const call = (params?.toolCall ?? {}) as AntigravityToolCall;
    const verdict = antigravityPermissionDecision(o.permission, call, o.cwd, o.addDirs, protectedPaths);
    let decision: AcpDecision;
    let label = `${t().antigravityRefused}${t().antigravityEndsTurn}`;
    if (verdict.run === 'allow') decision = { allow: true };
    else if (verdict.run === 'refuse') {
      decision = { allow: false, reason: verdict.reason };
      label = `${verdict.reason}${t().antigravityEndsTurn}`;
    } else if (o.requestApproval) {
      const answer = await o.requestApproval(antigravityApprovalRequest(o.permission, call, o.cwd, o.addDirs));
      decision = answer.allow ? { allow: true } : { allow: false, reason: answer.note ?? '' };
      label = declinedLabel(answer.note);
    } else decision = { allow: false, reason: 'Not covered by the permission' };
    if (!decision.allow && call.toolCallId) updates.refused(call.toolCallId, label);
    return answerPermission(decision, options.filter((x) => x.kind !== 'allow_always' && x.kind !== 'reject_always'));
  };

  const onAbort = () => {
    userAborted = true;
    if (sessionId) conn.notify('session/cancel', { sessionId });
    stopSoon(2000);
  };
  o.signal.addEventListener('abort', onAbort, { once: true });

  const env: NodeJS.ProcessEnv = { ...o.env };
  delete env[ANTIGRAVITY_HOME_ENV];
  const exited = runProcess({
    bin: o.bin,
    args: antigravityArgs(o.env, o.permission, runDir),
    cwd: o.cwd, // agy reads its rules (GEMINI.md, AGENTS.md, .agents/) from the folder it starts in up to the repository's root
    env,
    signal: stop.signal,
    timeoutMs: TURN_TIMEOUT_MS,
    keepStdinOpen: true,
    onSpawn: (c) => (child = c),
    onLine: conn.handleLine,
  }).then(
    (res) => {
      conn.close(new AgentRunError(res.timedOut ? t().timedOut : tail(res.stderr) || t().exitedWithoutTurn('agy', res.code)));
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
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const caps = init?.agentCapabilities ?? {};
    const mcpServers = acpMcpServers(o.mcpServers ?? [], Boolean(caps.mcpCapabilities?.http), 'antigravity');
    // The briefing goes into its system prompt when it says it takes one there, else on top of the prompt.
    const systemPrompt = Boolean(caps._meta?.antigravity?.systemPrompt?.append);
    const last = o.sessionId ? briefed.get(o.sessionId) : undefined;
    const meta = systemPrompt ? antigravitySessionMeta(o.systemPrompt, last) : undefined;
    const dirs = caps.sessionCapabilities?.additionalDirectories && o.addDirs?.length ? { additionalDirectories: o.addDirs } : {};
    const signIn = (err: unknown): never => {
      const message = err instanceof Error ? err.message : String(err);
      if (/authenticat|sign in|log in|login/i.test(message)) throw new AgentRunError(t().antigravitySignIn(message));
      throw err instanceof AgentRunError ? err : new AgentRunError(message);
    };
    let opened: any;
    if (o.sessionId) {
      sessionId = o.sessionId;
      opened = await conn.request('session/resume', { sessionId, cwd: o.cwd, mcpServers, ...dirs, ...(meta ? { _meta: meta } : {}) }).catch(signIn);
    } else {
      opened = await conn.request('session/new', { cwd: o.cwd, mcpServers, ...dirs, ...(meta ? { _meta: meta } : {}) }).catch(signIn);
      sessionId = String(opened?.sessionId ?? '');
      if (!sessionId) throw new AgentRunError(t().antigravityNoSession);
    }
    opening = false;
    o.onEvent({ type: 'session', sessionId });
    if (userAborted) throw new AgentRunError(t().stopped, true);

    await setAntigravityOptions(conn, sessionId, opened, o);

    const text = systemPrompt ? o.prompt : antigravityPromptText(o.prompt, o.systemPrompt, last);
    const result = await conn.request('session/prompt', { sessionId, prompt: acpPrompt(text, o.images) });
    rememberBriefing(sessionId, o.systemPrompt);
    updates.finish();
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (result?.stopReason === 'cancelled') throw new AgentRunError(t().antigravityCancelled);
    const usage = result?.usage ?? {};
    return {
      sessionId,
      inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined,
      outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined,
    };
  } catch (err) {
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (err instanceof AgentRunError) throw err;
    throw new AgentRunError(err instanceof Error ? err.message : String(err));
  } finally {
    opening = false;
    o.signal.removeEventListener('abort', onAbort);
    child?.stdin?.end(); // agy exits when its stdin closes
    stopSoon(3000);
    await exited.catch(() => undefined);
  }
}

/** A session's config option by id. */
const option = (opts: any[] | undefined, id: string) => (Array.isArray(opts) ? opts.find((c) => c?.id === id) : undefined);

/** A config option's values. */
export const antigravityOptionValues = (o: any): string[] =>
  Array.isArray(o?.options) ? o.options.map((x: any) => (typeof x?.value === 'string' ? x.value : '')).filter(Boolean) : [];

/** The session's thinking level: its option of category `thought_level` (not a mere on/off switch). */
export function antigravityEffortOption(options: unknown): any {
  const o = Array.isArray(options) ? options.find((c: any) => c?.category === 'thought_level') : undefined;
  const values = antigravityOptionValues(o);
  return values.length && !values.every((v) => v === 'true' || v === 'false') ? o : undefined;
}

/**
 * Puts the session in agy's default mode (a resumed one may be in another: its mode decides what runs
 * without asking), and sets its model, then its thinking level (only one the model offers, of its option
 * of category `thought_level`), each only when it differs.
 */
async function setAntigravityOptions(conn: JsonRpcConnection, sessionId: string, opened: any, o: RunOptions): Promise<void> {
  let opts: any[] | undefined = opened?.configOptions;
  const set = async (configId: string, value: string, rejected: (value: string, err: string) => string) => {
    const r = await conn.request('session/set_config_option', { sessionId, configId, value }).catch((err: Error) => {
      throw new AgentRunError(rejected(value, err.message));
    });
    if (Array.isArray(r?.configOptions)) opts = r.configOptions;
  };
  const mode = option(opts, 'mode')?.currentValue ?? opened?.modes?.currentModeId;
  if (mode !== undefined && mode !== 'default') await set('mode', 'default', (_v, err) => t().antigravityRejectedMode(err));
  if (o.model && option(opts, 'model')?.currentValue !== o.model) await set('model', o.model, t().antigravityRejectedModel);
  const effort = o.effort ? antigravityEffortOption(opts) : undefined;
  if (o.effort && effort && antigravityOptionValues(effort).includes(o.effort) && effort.currentValue !== o.effort) {
    await set(String(effort.id), o.effort, t().antigravityRejectedEffort);
  }
}
