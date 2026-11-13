import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { NativeItemsOff, NativePart, Permission } from '../../shared/types';
import { t } from '../i18n';
import { isPublishCommand } from '../commands';
import { runProcess, tail } from '../process';
import { patternPath, protectedReads, realPath } from '../protect';
import { DATA_DIR, MUSE_HOME_ENV, MUSE_KEY_ONLY_ENV } from '../settings';
import { JsonRpcConnection, RpcError, acpContentText, acpMcpServers, acpPrompt, answerPermission, type AcpDecision } from './acp';
import { agentConfigPath } from './antigravity';
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
 * Muse Code (Meta's `muse`) runs as an ACP agent (`muse acp`: JSON-RPC over stdin/stdout), like Grok,
 * Cursor and Antigravity. What its ACP server does, as tried with muse 1.4.18 (on a fake Meta API key,
 * against a stand-in for the Meta API, which speaks the OpenAI Responses API):
 *
 * - Below full access its OS sandbox runs every command (Seatbelt on macOS, its own bubblewrap on Linux,
 *   a Windows sandbox): commands may write only in the workspace (its `additionalDirectories` too) and
 *   the temporary folder, `.git`, `.muse` and `.agents` stay read-only, and every host a command or its
 *   web fetch reaches is asked about (`--sandbox-network proxy-only`, its default).
 * - What runs without asking is its permission profile's and its session mode's. A profile can be chosen
 *   only in its `settings.json` (`-c permissions=…` is refused), so each run gets a config folder of its
 *   own (`XDG_CONFIG_HOME`, see `prepareMuseRun`) whose settings hold Harness Relay's profile: from
 *   `:ask-me` (a human reviewer), with a `"deny"` rule for each protected path, which binds its file
 *   tools and the sandbox alike. Its `:read-only` profile cannot take deny rules ("deny cannot be
 *   enforced"), so read-only is the same profile with its file tools' writes taken away
 *   (`--disable-write`: no `write_file` or `edit_file`) and the `promptUnmatched` mode, in which every
 *   command asks; edit is the `onRequest` mode, in which commands run in the sandbox, and a command
 *   that writes, or reaches the network, asks (once allowed it still runs in the sandbox).
 * - Its default profile (`:auto-review`) lets an LLM judge decide what it asks about. Harness Relay's
 *   profiles have a human reviewer, and `MUSE_DISABLE_APPROVAL_JUDGE=1` turns the judge off anyway.
 * - A workspace it trusts (`trust.json` in its config folder, `--trust-workspace`) loads the project's
 *   instruction files, skills and hooks; its hooks (`.muse/hooks.json`) run outside the sandbox. The
 *   run's own config folder has no `trust.json`, so below full access every workspace is untrusted.
 * - Full access: `--disable-sandbox --trust-workspace` and the session's `allowAll` mode.
 * - The same call may be asked about twice (seen with a command writing outside the workspace): it
 *   gets the first answer again, so the user is asked once.
 * - It asks with `session/request_permission` naming the call by `toolCallId` only (what it is comes in
 *   the `tool_call` update before), with allow-once and reject-once (and sometimes allow-always).
 * - A refusal reaches the model as Muse's own words ("The user rejected this action…"); no message
 *   passes with it. The turn carries on.
 * - The briefing goes into the session's first developer message (`-c run.developer_prompt=…`), given
 *   to every process: a resumed session gets the new one instead of the old.
 * - `session/resume` keeps the history and replays nothing (`session/load` would replay it); an
 *   unknown session fails before the turn says anything (`sessionNotFound`).
 */

// --- Its home --------------------------------------------------------------------------------------

/**
 * The folder Muse's config folder (`muse/`: `settings.json`, `auth.json`, `trust.json`) is in: an
 * account's home of Harness Relay's own (`MUSE_HOME_ENV`, its `config`), else `XDG_CONFIG_HOME`, else
 * `~/.config` (on every system: Muse uses the XDG folders on macOS and Windows too).
 */
export function museConfigBase(env: NodeJS.ProcessEnv, home = homedir()): string {
  const root = env[MUSE_HOME_ENV];
  if (root) return join(root, 'config');
  return env.XDG_CONFIG_HOME || join(home, '.config');
}

/** The folder Muse's data folder (`muse/`: sessions, its model catalog, plugins, logs) is in. */
export function museDataBase(env: NodeJS.ProcessEnv, home = homedir()): string {
  const root = env[MUSE_HOME_ENV];
  if (root) return join(root, 'data');
  return env.XDG_DATA_HOME || join(home, '.local', 'share');
}

/** Whether this is an account that runs on its own API key only (`MUSE_KEY_ONLY_ENV`). */
export function museKeyOnly(env: NodeJS.ProcessEnv): boolean {
  return env[MUSE_KEY_ONLY_ENV] === '1';
}

/**
 * The environment of a command that asks Muse something (`muse usage`, `muse skills list`, its sign-in
 * and sign-out): the account's folders as Muse's XDG folders, and Harness Relay's own variables not
 * passed on. The default account keeps the user's own.
 */
export function museProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (env[MUSE_HOME_ENV]) {
    out.XDG_CONFIG_HOME = museConfigBase(env);
    out.XDG_DATA_HOME = museDataBase(env);
  }
  delete out[MUSE_HOME_ENV];
  delete out[MUSE_KEY_ONLY_ENV];
  return out;
}

// --- A run's own config folder ---------------------------------------------------------------------

/**
 * The settings of the account's a run keeps: its model and service, and what it loads by itself (its
 * MCP servers, hooks, plugins and skills, as the other CLIs' runs keep theirs), its tools' and context
 * settings. Nothing else is kept, so that no setting of the user's (or of a later Muse) decides what
 * runs without asking: not `permissions`, its custom agents' definitions (`agents`, `agent_definitions`),
 * `run` (its system prompt and tool set), `runtime_capabilities` (computer use…: only its reminders'
 * switches are kept, `museReminderSwitches`), `feature_config`.
 */
export const MUSE_KEPT_SETTINGS = [
  'model',
  'reasoning_effort',
  'provider',
  'endpoint_transport',
  'mcp_servers',
  'mcpServers',
  'hooks',
  'managed_hooks_path',
  'plugins',
  'plugin_keys',
  'skills',
  'context',
  'tools',
  'contributor_mode_enabled',
  'contributor_mode_disclosure_acknowledged',
  'mcp_oauth_dynamic_client_registration',
  'telemetry',
  'session_retention_days',
  'provider_retry',
  'context_compaction',
] as const;

/**
 * A reminder's capability in `runtime_capabilities` (`plugin:tbh-reminders:reminder:verify-reminder`, or a
 * plugin's own): Muse's reminders are model requests of their own that run beside a turn (skills, goals,
 * verification, memory, its to-do list and scope), which the user may turn off in Muse's settings.
 */
const REMINDER_CAPABILITY = /^plugin:[^:]+:reminder:[^:]+$/;

/**
 * Of the account's `runtime_capabilities`, its reminders' switches only (`{ enabled }`), so that a reminder
 * the user turned off stays off in Harness Relay's runs (each one sends model requests of its own: with
 * muse 1.4.18 more of a short turn's requests than the turn itself), and no other capability is turned on.
 */
export function museReminderSwitches(capabilities: unknown): Record<string, { enabled: boolean }> | undefined {
  if (!isObject(capabilities)) return undefined;
  const kept = Object.entries(capabilities).flatMap(([id, v]) =>
    REMINDER_CAPABILITY.test(id) && isObject(v) && typeof v.enabled === 'boolean' ? [[id, { enabled: v.enabled }] as const] : [],
  );
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/**
 * The `run` settings of every run: workflows off. Muse's `workflow` tool starts its agents in the
 * background and ends the turn at once, to be woken by their result later; a run ends with its turn, so
 * they were always cancelled before they did anything (muse 1.4.18, on a real Meta account).
 */
export const MUSE_RUN_RUN_SETTINGS = { workflow_trigger_mode: 'off' } as const;

/** The two places Muse keeps MCP servers in its settings: `muse mcp add` writes `mcpServers`. */
const MCP_KEYS = ['mcpServers', 'mcp_servers'] as const;

/** The name of Harness Relay's permission profile in a run's settings. */
export const MUSE_PROFILE = 'harness-relay';

/**
 * The `permissions` of a run's settings: below full access Harness Relay's profile, from Muse's
 * `:ask-me` (a human reviewer), with a `"deny"` rule for each protected path (read-only takes the
 * writes away otherwise: `museArgs`, `museMode`); full access, Muse's `:unrestricted`.
 */
export function musePermissions(permission: Permission, protectedPaths: readonly string[]): Record<string, unknown> {
  if (permission === 'full') return { schema_version: 1, default_profile: ':unrestricted' };
  const filesystem = Object.fromEntries([...new Set(protectedPaths)].map((p) => [p, 'deny']));
  return {
    schema_version: 1,
    default_profile: MUSE_PROFILE,
    profiles: {
      [MUSE_PROFILE]: {
        extends: ':ask-me',
        description: 'Harness Relay',
        ...(Object.keys(filesystem).length ? { filesystem } : {}),
      },
    },
  };
}

/** Whether a settings value is a plain object. */
const isObject = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The settings of one run: what it keeps of the account's own (`MUSE_KEPT_SETTINGS`, and its reminders'
 * switches: `museReminderSwitches`), with Harness
 * Relay's `permissions` (`musePermissions`) and workflows off (`MUSE_RUN_RUN_SETTINGS`), and without the MCP servers and hooks left out of the run
 * (`nativeOff`: all of them, its managed hooks too; `nativeItems.mcp`: a server by its name).
 */
export function museRunSettings(
  own: unknown,
  permission: Permission,
  protectedPaths: readonly string[],
  nativeOff: readonly NativePart[] = [],
  nativeItems: NativeItemsOff = {},
): Record<string, unknown> {
  const base: Record<string, any> = isObject(own) ? own : {};
  const out: Record<string, any> = Object.fromEntries(MUSE_KEPT_SETTINGS.filter((k) => base[k] !== undefined).map((k) => [k, base[k]]));
  const reminders = museReminderSwitches(base.runtime_capabilities);
  if (reminders) out.runtime_capabilities = reminders;
  if (nativeOff.includes('hooks')) {
    delete out.hooks;
    delete out.managed_hooks_path;
  }
  for (const key of MCP_KEYS) {
    if (nativeOff.includes('mcp')) delete out[key];
    else if (isObject(out[key]) && nativeItems.mcp?.length) {
      out[key] = Object.fromEntries(Object.entries(out[key]).filter(([name]) => !nativeItems.mcp!.includes(name)));
    }
  }
  return { ...out, schema_version: 1, run: { ...MUSE_RUN_RUN_SETTINGS }, permissions: musePermissions(permission, protectedPaths) };
}

/** A run's own config folder (`XDG_CONFIG_HOME`), and how to put things back and remove it. */
export interface MuseRun {
  /** The folder given as `XDG_CONFIG_HOME`: Muse's config folder is its `muse`. */
  dir: string;
  done(): void;
}

/**
 * Where runs' config folders are: in Harness Relay's data folder, but not in its temporary folder,
 * which the runs' profiles deny (the commands Muse runs look in their `XDG_CONFIG_HOME`, and git fails
 * when it may not even look there).
 */
export function museRunsDir(dataDir = DATA_DIR): string {
  return join(dataDir, 'muse-runs');
}

/** How a run's config folder begins. */
export const MUSE_RUN_PREFIX = 'run-';

/** The config folders of runs now under way, by path (two servers may share a data folder: see `sweepRuns`). */
const runsInUse = new Set<string>();

/** Removes the config folders runs left behind (the server stopped during one), once older than a turn may last. */
function sweepRuns(root: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(root, name);
    if (!name.startsWith(MUSE_RUN_PREFIX) || runsInUse.has(dir)) continue;
    try {
      if (now - lstatSync(dir).mtimeMs > TURN_TIMEOUT_MS + 60_000) rmSync(dir, { recursive: true, force: true }); // links go, not what they lead to
    } catch {
      // gone already: the next run tries again
    }
  }
}

/** A real path, or the path itself when it cannot be resolved. */
const realOr = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The `trust.json` of a run below full access: each of its working directories untrusted, so that Muse
 * loads none of their instruction files, skills or hooks, and its commands that would ask a terminal
 * whether to trust the folder (`muse skills list`) answer instead.
 */
export function museTrust(dirs: readonly string[]): Record<string, unknown> {
  return { schema_version: 1, projects: Object.fromEntries([...new Set(dirs.map(realOr))].map((d) => [d, { decision: 'untrusted' }])) };
}

/**
 * Makes a run's config folder (`museRunsDir`, owner only, removed after the turn; one the server was
 * stopped during goes once older than a turn may last):
 *
 * - `muse/settings.json`: the run's settings (`museRunSettings`), never written into the account's;
 * - `muse/auth.json`: a link to the account's (a copy on Windows), where Muse keeps its sign-in (on
 *   macOS a pointer to the login keychain, which it finds from any folder); a sign-in Muse refreshed in
 *   a file of its own is put back into the account's, unless that changed meanwhile;
 * - `muse/trust.json`: below full access, the working directories untrusted (`museTrust`): never the
 *   account's own trust, so no workspace is trusted below full access;
 * - links to the user's other XDG config folders (`gh`, `git`…; not on Windows), since the commands Muse
 *   runs get its `XDG_CONFIG_HOME` too.
 */
export function prepareMuseRun(
  env: NodeJS.ProcessEnv,
  permission: Permission,
  protectedPaths: readonly string[],
  opts: {
    nativeOff?: readonly NativePart[];
    nativeItems?: NativeItemsOff;
    /** The run's working directories, untrusted below full access. */
    dirs?: readonly string[];
    /** Where the folder is made (`museRunsDir()`). */
    root?: string;
    platform?: NodeJS.Platform;
    /** The user's own XDG config folder, whose other entries are linked (`XDG_CONFIG_HOME`, else `~/.config`). */
    userConfig?: string;
  } = {},
): MuseRun {
  const platform = opts.platform ?? process.platform;
  const base = museConfigBase(env);
  const own = join(base, 'muse');
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(join(own, 'settings.json'), 'utf8'));
  } catch {
    settings = undefined; // none yet, or not JSON: Muse's defaults
  }
  const root = opts.root ?? museRunsDir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  sweepRuns(root);
  const dir = mkdtempSync(join(root, MUSE_RUN_PREFIX));
  chmodSync(dir, 0o700);
  runsInUse.add(dir);
  const cfg = join(dir, 'muse');
  const auth = join(own, 'auth.json');
  const runAuth = join(cfg, 'auth.json');
  const authLinked = !museKeyOnly(env) && existsSync(auth) && platform !== 'win32';
  const authCopied = !museKeyOnly(env) && existsSync(auth) && platform === 'win32';
  let original: Buffer | undefined;
  const done = () => {
    runsInUse.delete(dir);
    try {
      if (original) putBackAuth(auth, runAuth, original);
    } catch (err) {
      console.warn(`[muse] could not put back the sign-in Muse refreshed: ${(err as Error).message}`);
    }
    try {
      rmSync(dir, { recursive: true, force: true }); // the links go, not what they lead to
    } catch (err) {
      console.warn(`[muse] could not remove ${dir}: ${(err as Error).message}`);
    }
  };
  try {
    // Read in here, so that a sign-in it cannot read leaves no folder behind.
    if (authLinked || authCopied) original = readFileSync(auth);
    mkdirSync(cfg, { mode: 0o700 });
    writeFileSync(
      join(cfg, 'settings.json'),
      `${JSON.stringify(museRunSettings(settings, permission, protectedPaths, opts.nativeOff, opts.nativeItems), null, 2)}\n`,
      { mode: 0o600 },
    );
    if (authLinked) symlinkSync(auth, runAuth, 'file');
    if (authCopied) copyFileSync(auth, runAuth);
    // What Muse loads by itself from its own config folder besides its settings: its skills and its own
    // rules (`AGENTS.md`, which come before `~/.claude/CLAUDE.md`), found there in the user's own Muse but
    // missing from the runs until linked (tried with muse 1.4.18). Not its approval policy
    // (`approval-policy.json`), which would decide what runs without asking, nor its workflows, which the
    // runs turn off. Muse has no switch that leaves its skills or rules out of one run.
    const skills = join(own, 'skills');
    if (existsSync(skills)) symlinkSync(skills, join(cfg, 'skills'), platform === 'win32' ? 'junction' : 'dir');
    const rules = join(own, 'AGENTS.md');
    if (existsSync(rules)) copyFileSync(rules, join(cfg, 'AGENTS.md'));
    if (permission !== 'full') writeFileSync(join(cfg, 'trust.json'), `${JSON.stringify(museTrust(opts.dirs ?? []), null, 2)}\n`, { mode: 0o600 });
    // The commands Muse runs find the rest of the user's config folder where they look for it.
    if (platform !== 'win32') {
      const user = opts.userConfig ?? (env.XDG_CONFIG_HOME || join(homedir(), '.config'));
      let names: string[] = [];
      try {
        names = readdirSync(user);
      } catch {
        // no config folder yet
      }
      for (const name of names) if (name !== 'muse') symlinkSync(join(user, name), join(dir, name));
    }
  } catch (err) {
    done();
    throw err;
  }
  return { dir, done };
}

/**
 * Puts a sign-in Muse refreshed in the run's config folder back into the account's: when it replaced
 * the link with a file of its own (POSIX), or changed the copy (Windows), and only while the account's
 * is still what it was when the run started (`original`), so that a newer one another run or the user
 * wrote meanwhile stays. Atomic, owner only, written where the account's file is (through a link).
 */
export function putBackAuth(auth: string, runAuth: string, original: Buffer): void {
  let st;
  try {
    st = lstatSync(runAuth);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || !st.isFile()) return;
  const now = readFileSync(runAuth);
  if (now.equals(original)) return;
  const target = realOr(auth);
  if (!readFileSync(target).equals(original)) return;
  const next = `${target}.harness-relay-${randomBytes(4).toString('hex')}`;
  writeFileSync(next, now, { mode: 0o600 });
  renameSync(next, target);
}

// --- Its arguments --------------------------------------------------------------------------------

/**
 * The longest briefing given on Muse's command line on Windows (its command line is at most 32,767
 * characters); a longer one goes on top of the prompt instead.
 */
export const MUSE_WINDOWS_BRIEFING_MAX = 24_000;

/**
 * What the briefing adds for Muse Code: a refusal reaches it as Muse's own words, without a reason; and
 * workflows are off (`MUSE_RUN_RUN_SETTINGS`), which the user cannot change in Harness Relay.
 */
export const MUSE_NOTES =
  'In this app, a tool call that is refused (by the user, or because the conversation\'s permission does not cover it) comes back to you as ' +
  '"The user rejected this action", without the reason. Do not retry it; say what you needed it for, or ask the user as these instructions say. ' +
  'Workflows are off in this app, since your turn ends before their agents could finish; this is not a setting the user can change here, so do the work yourself.';

/**
 * The briefing as Muse's developer prompt. A lone surrogate (a role cut in the middle of an emoji) is
 * made a replacement character: Muse refuses a `-c` value that is not valid JSON text.
 */
export function museBriefing(briefing: string): string {
  const text = ['<harness-relay-briefing>', 'Standing instructions from Harness Relay, the app this conversation runs in.', '', briefing.trim(), '', MUSE_NOTES, '</harness-relay-briefing>'].join('\n');
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * Whether the briefing goes on Muse's command line (`-c run.developer_prompt`), else on top of the
 * prompt: on Windows only while it fits, counting the backslash Windows' quoting puts before each `"`
 * and `\\` of its JSON text.
 */
export function briefingOnCommandLine(briefing: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return true;
  const json = JSON.stringify(museBriefing(briefing));
  return json.length + (json.match(/["\\]/g)?.length ?? 0) <= MUSE_WINDOWS_BRIEFING_MAX;
}

/** The efforts Muse takes (`none` is refused by its Meta provider). */
export const MUSE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * The arguments of a run: its model and effort, the briefing as its developer prompt (when it fits on
 * the command line), and in full access no sandbox and a trusted workspace.
 */
export function museArgs(o: Pick<RunOptions, 'permission' | 'model' | 'effort' | 'systemPrompt'>, platform: NodeJS.Platform = process.platform): string[] {
  const effort = o.effort?.trim();
  const briefing = o.systemPrompt.trim() && briefingOnCommandLine(o.systemPrompt, platform) ? museBriefing(o.systemPrompt) : '';
  return [
    'acp',
    ...(o.model?.trim() ? ['--model', o.model.trim()] : []),
    ...(effort && (MUSE_EFFORTS as readonly string[]).includes(effort) ? ['-c', `reasoning_effort=${JSON.stringify(effort)}`] : []),
    ...(briefing ? ['-c', `run.developer_prompt=${JSON.stringify(briefing)}`] : []),
    ...(o.permission === 'read-only' ? ['--disable-write'] : []),
    ...(o.permission === 'full' ? ['--disable-sandbox', '--trust-workspace'] : []),
  ];
}

/** The session mode of a run: every command asks in read-only; commands run in the sandbox in edit; nothing asks in full access. */
export function museMode(permission: Permission): string {
  return permission === 'full' ? 'allowAll' : permission === 'read-only' ? 'promptUnmatched' : 'onRequest';
}

/** The prompt text: the briefing on top when it does not go on the command line. */
export function musePromptText(prompt: string, briefing: string, platform: NodeJS.Platform = process.platform): string {
  if (!briefing.trim() || briefingOnCommandLine(briefing, platform)) return prompt;
  return `${museBriefing(briefing)}\n\n${prompt}`;
}

/**
 * The environment of a run: the account's, with the run's config folder as `XDG_CONFIG_HOME`, the
 * account's data folder (where its sessions are) as `XDG_DATA_HOME` when it has a home of Harness
 * Relay's own, and the approval judge off.
 */
export function museEnv(env: NodeJS.ProcessEnv, runDir: string): NodeJS.ProcessEnv {
  const out = museProbeEnv(env);
  out.XDG_CONFIG_HOME = runDir;
  out.MUSE_DISABLE_APPROVAL_JUDGE = '1';
  return out;
}

// --- Permissions -----------------------------------------------------------------------------------

/** A call as Muse described it in its `tool_call` updates. */
export interface MuseToolCall {
  toolCallId?: string;
  /** Muse's own tool name (`bash`, `read_file`, `write_file`, `edit_file`, `search`, `web_fetch`, `web_search`, an MCP tool…). */
  name?: string;
  kind?: string;
  title?: string;
  rawInput?: Record<string, any>;
  locations?: { path?: string }[];
  content?: unknown;
  /**
   * Muse is asking whether the call's command may reach the network: its update just before the
   * request is titled `network <command>` (seen with muse 1.4.18, after the command itself was asked
   * about or ran in the sandbox).
   */
  network?: boolean;
}

/** The command a call runs. */
export function museCommand(call: MuseToolCall): string {
  const cmd = call.rawInput?.command;
  return typeof cmd === 'string' && cmd ? cmd : (call.title ?? '').replace(/^(bash|powershell)\s+/, '');
}

/** Every file or folder a call is about: its input's `path` and its locations, each once. */
export function musePaths(call: MuseToolCall): string[] {
  const input = call.rawInput ?? {};
  const fromInput = [input.path, input.file_path, input.workdir].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const fromLocations = Array.isArray(call.locations) ? call.locations.map((l) => l?.path).filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
  return [...new Set([...fromInput, ...fromLocations])];
}

/** Whether `path`, given in `cwd`, is `dir` or inside it, links on the way resolved. */
function within(cwd: string, path: string, dir: string): boolean {
  const rel = relative(realPath(resolve(dir)), realPath(resolve(cwd, path)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Its shell tools: `bash` (and `bash_input`) on macOS and Linux, `powershell` on Windows (seen with muse 1.4.18). */
const COMMAND_TOOLS = new Set(['bash', 'bash_input', 'powershell', 'powershell_input']);
const isCommand = (c: MuseToolCall) => c.kind === 'execute' || COMMAND_TOOLS.has(c.name ?? '');
const isWeb = (c: MuseToolCall) => c.kind === 'fetch' || c.name === 'web_fetch' || c.name === 'web_search';
const isWrite = (c: MuseToolCall) => c.kind === 'edit' || c.kind === 'delete' || c.kind === 'move' || c.name === 'write_file' || c.name === 'edit_file';
const isRead = (c: MuseToolCall) => (c.kind === 'read' || c.kind === 'search' || c.name === 'read_file' || c.name === 'search') && !isWeb(c);

/** What to do with a call Muse asks about: run it, ask the user, or refuse it without asking. */
export type MuseDecision = { run: 'allow' } | { run: 'ask' } | { run: 'refuse'; reason: string };

/**
 * Whether to approve a call Muse asks about under this permission. Muse asks only about what its
 * profile, mode and sandbox do not let run, so below full access: web searches and fetches run; a
 * read of a protected path is refused (its deny rules keep those anyway), other reads run; a
 * command's network (`MuseToolCall.network`) goes to the user. In
 * read-only every command goes to the user. In edit mode a command runs (it stays in the sandbox,
 * which keeps its writes in the working directories), but pushing and publishing and a shell running
 * what it reads on standard input (`isPublishCommand`), which go to the user; and a write in the
 * working directories runs but where it could change how agents run later (`agentConfigPath`).
 * Everything else goes to the user.
 */
export function musePermissionDecision(
  permission: Permission,
  call: MuseToolCall,
  cwd: string,
  addDirs: readonly string[] = [],
  protectedPaths: readonly string[] = [],
): MuseDecision {
  if (permission === 'full') return { run: 'allow' };
  const paths = musePaths(call);
  if (paths.some((path) => protectedPaths.some((p) => within(cwd, path, p)))) return { run: 'refuse', reason: t().museProtected };
  if (isWeb(call)) return { run: 'allow' };
  // A command's network: every host it would reach is the user's to allow, as Claude Code's sandbox asks.
  if (call.network && isCommand(call)) return { run: 'ask' };
  if (isCommand(call)) return permission === 'edit' && !isPublishCommand(museCommand(call)) ? { run: 'allow' } : { run: 'ask' };
  if (isRead(call) && paths.length) return { run: 'allow' };
  if (permission === 'edit' && isWrite(call) && paths.length) {
    const fine = paths.every((path) => {
      const dir = [cwd, ...addDirs].find((d) => within(cwd, path, d));
      return dir !== undefined && !agentConfigPath(cwd, path, dir);
    });
    if (fine) return { run: 'allow' };
  }
  return { run: 'ask' };
}

/** What to show the user when Muse asks about a call the permission does not cover. */
export function museApprovalRequest(permission: Permission, call: MuseToolCall, cwd: string, addDirs: readonly string[] = []): ApprovalRequest {
  const input = call.rawInput ?? {};
  const description = typeof input.description === 'string' && input.description ? input.description : undefined;
  if (call.network && isCommand(call)) return { kind: 'fetch', detail: museCommand(call), reason: t().museNetwork };
  if (isCommand(call)) return { kind: 'command', detail: museCommand(call), reason: permission === 'edit' ? t().musePublish : (description ?? t().museCommandAsked) };
  if (isWrite(call)) {
    const path = musePaths(call)[0];
    const dir = path ? [cwd, ...addDirs].find((d) => within(cwd, path, d)) : undefined;
    const reason = permission === 'read-only' ? call.title : !path || !dir ? t().museOutsideWrite : t().museConfigWrite;
    return { kind: 'edit', detail: path, reason };
  }
  if (isWeb(call)) return { kind: 'fetch', detail: input.url ?? input.query ?? call.title, reason: call.title };
  const tool = call.name || call.title || call.kind || 'tool';
  return { kind: 'other', tool, detail: summarizeInput(input, { wholePaths: true }) ?? acpContentText(call.content), reason: call.title };
}

// --- Session updates -------------------------------------------------------------------------------

/** What its tools are called in the chat: by kind, else Muse's own name. */
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

/** A command's result as Muse reports it (`rawOutput`, a JSON text): its output and exit code. */
export function museCommandResult(raw: unknown): { output?: string; exitCode?: number; status?: string; reason?: string } | undefined {
  let j: any = raw;
  if (typeof raw === 'string') {
    try {
      j = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!isObject(j) || (typeof j.output !== 'string' && typeof j.exit_code !== 'number')) return undefined;
  return {
    output: typeof j.output === 'string' ? j.output : undefined,
    exitCode: typeof j.exit_code === 'number' ? j.exit_code : undefined,
    status: typeof j.terminal_status === 'string' ? j.terminal_status : undefined,
    reason: typeof j.terminal_reason === 'string' ? j.terminal_reason : undefined,
  };
}

const DONE = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/** One call's latest kind, name, title, input and location, which arrive over several updates. */
interface CallState {
  kind?: string;
  name?: string;
  title?: string;
  network?: boolean;
  rawInput?: Record<string, any>;
  locations?: { path?: string }[];
  content?: unknown;
}

/** Turns Muse's ACP `session/update` payloads into AgentEvents, and keeps what each call is about. */
export function createMuseUpdateHandler(emit: (e: AgentEvent) => void) {
  const calls = new Map<string, CallState>();
  const open = new Set<string>();
  const ended = new Set<string>();
  const refused = new Map<string, string>();
  /** Calls reported over before their result came (a refused write's reason comes in the next update). */
  const endedEarly = new Map<string, Record<string, any>>();
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
    // The first title names the call ("bash echo hi"); later ones are its description, or say that
    // Muse is about to ask for the command's network ("network curl …").
    if (typeof u.title === 'string' && u.title) {
      if (/^network\s/.test(u.title)) c.network = true;
      else if (c.network && u.status) c.network = false;
      if (!c.title) c.title = u.title;
    }
    if (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length) c.rawInput = u.rawInput;
    if (Array.isArray(u.locations) && u.locations.length) c.locations = u.locations;
    if (u.content !== undefined) c.content = u.content;
    calls.set(id, c);
    return c;
  };

  const detailOf = (c: CallState): string | undefined => {
    if (isCommand(c)) return clip(museCommand(c));
    const path = musePaths(c)[0];
    if (path) return clipPath(path);
    if (isWeb(c) && typeof (c.rawInput?.url ?? c.rawInput?.query) === 'string') return clip(c.rawInput!.url ?? c.rawInput!.query);
    return summarizeInput(c.rawInput) ?? (c.title ? clip(c.title) : undefined);
  };

  const start = (id: string, c: CallState) => {
    open.add(id);
    const detail = detailOf(c);
    const name = isCommand(c) ? 'Shell' : (KIND_NAME[c.kind ?? ''] ?? (c.name || c.title || 'tool'));
    emit({ type: 'tool_start', id, name, ...(detail ? { detail } : {}) });
  };

  const finish = (id: string, c: CallState, u: Record<string, any>) => {
    open.delete(id);
    ended.add(id);
    const why = refused.get(id);
    const command = isCommand(c) ? museCommandResult(u.rawOutput) : undefined;
    const raw = command?.output ?? (typeof u.rawOutput === 'string' ? u.rawOutput : acpContentText(u.content));
    const failedCode = command?.exitCode !== undefined && command.exitCode !== 0 ? command.exitCode : undefined;
    const ok = u.status === 'completed' && !why && failedCode === undefined && command?.status !== 'failed' && command?.status !== 'cancelled';
    const printed = raw?.trim() ? raw : '';
    const output = printed && (ok || command) ? tailText(printed) : undefined;
    const error = ok
      ? undefined
      : (why ??
        (failedCode !== undefined
          ? t().museExitCode(failedCode)
          : command?.reason
            ? clip(command.reason, 300)
            : printed
              ? tailText(printed, 500)
              : undefined));
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
        if (!open.has(id)) start(id, c);
        const early = endedEarly.get(id);
        const said = u.rawOutput !== undefined || acpContentText(u.content) !== undefined;
        if (early && said) {
          endedEarly.delete(id);
          finish(id, c, { ...early, ...u, status: DONE.has(u.status) ? u.status : early.status });
        } else if (DONE.has(u.status)) {
          if (said || u.sessionUpdate === 'tool_call_update') finish(id, c, u);
          else endedEarly.set(id, u);
        }
        break;
      }
    }
  }

  return {
    handle,
    /** What Muse said a call is about (a permission request names it by id only). */
    call(toolCallId: string): MuseToolCall {
      return { toolCallId, ...(calls.get(toolCallId) ?? {}) };
    },
    /** Remember why a call was refused, to show under it. */
    refused(toolCallId: string, label: string) {
      refused.set(toolCallId, label);
    },
    /** The turn is over: close the text, and the calls still waiting for their result. */
    finish() {
      closeText();
      for (const [id, u] of endedEarly) finish(id, calls.get(id) ?? {}, u);
      endedEarly.clear();
    },
  };
}

// --- What its Linux sandbox leaves --------------------------------------------------------------

/**
 * The folders Muse's bubblewrap sandbox makes in a working directory to mount over (checked with muse
 * 1.4.18 on Linux): it keeps `.agents` and `.muse` read-only and hides `.hg`, `.sl` and `.eden`, and
 * leaves an empty folder of each behind, which a version-control tool could take for a repository.
 */
export const MUSE_MOUNT_POINTS = ['.agents', '.muse', '.hg', '.sl', '.eden'] as const;

/** Of `MUSE_MOUNT_POINTS`, those not in the folders yet: the ones a turn may remove again. */
export function missingMountPoints(dirs: readonly string[]): string[] {
  return dirs.flatMap((d) => MUSE_MOUNT_POINTS.map((m) => join(d, m))).filter((p) => !existsSync(p));
}

/**
 * The marker Muse's Linux sandbox puts in a folder it mounts over, named by its process
 * (`.tbh-sandbox-mountpoint.<pid>`, "a directory holding only these markers is sandbox residue and safe
 * to delete"); a stopped turn leaves them behind.
 */
const MOUNT_MARKER = /^\.tbh-sandbox-mountpoint\.(\d+)$/;

/** Whether a process is running (one of another user's counts as running). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes those of `paths` (made during the turn) that are empty folders now, or hold only the markers
 * of sandbox processes no longer running; anything else stays.
 */
export function removeEmptyMountPoints(paths: readonly string[], alive: (pid: number) => boolean = running): void {
  for (const p of paths) {
    try {
      if (!lstatSync(p).isDirectory()) continue;
      const names = readdirSync(p);
      const markers = names.map((n) => MOUNT_MARKER.exec(n));
      if (markers.some((m) => !m || alive(Number(m[1])))) continue;
      for (const n of names) rmSync(join(p, n));
      rmdirSync(p);
    } catch {
      // not there, or still mounted by another run: left as it is
    }
  }
}

// --- The runner ------------------------------------------------------------------------------------

/**
 * What each session was made with: its permission and the paths its profile denies. Muse keeps a
 * session's permission profile and sandbox as they were when it was made (checked with muse 1.4.18: a
 * session made with full access, resumed with the edit settings, still read a denied file and wrote
 * outside the workspace), so a session is resumed only with the same, else the turn starts a fresh
 * one (the orchestrator retries with the whole history). Kept by this server only: after a restart
 * every Muse session starts afresh once.
 */
const grants = new Map<string, string>();
const MAX_GRANTS = 1000;

/** A run's permission and denied paths as one key. */
export function museGrant(permission: Permission, denied: readonly string[]): string {
  return [permission, ...[...new Set(denied)].sort()].join('\0');
}

/** Records what a session was made with (`grants`). */
export function rememberMuseSession(sessionId: string, grant: string): void {
  grants.delete(sessionId);
  grants.set(sessionId, grant);
  if (grants.size > MAX_GRANTS) grants.delete(grants.keys().next().value!);
}

/** The working directories with a run below full access under way, by how many (Linux: their mount points). */
const mountUsers = new Map<string, number>();

/** The protected paths a run's profile denies, or why the run may not start. */
function deniedPaths(o: RunOptions): string[] {
  if (o.permission === 'full') return [];
  const paths = o.protectedPaths ?? protectedReads();
  // Muse reads a `*`, `?` or `[` in a rule as a pattern: such a path cannot be denied as it is.
  const pattern = patternPath(paths);
  if (pattern) throw new AgentRunError(t().museProtectedPattern(pattern));
  return paths;
}

export const museRunner: AgentRunner = {
  provider: 'muse',
  async run(o): Promise<RunResult> {
    if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
    const denied = deniedPaths(o);
    const grant = museGrant(o.permission, denied);
    // Before anything is said, so that the orchestrator starts a fresh session.
    if (o.sessionId && grants.get(o.sessionId) !== grant) throw new AgentRunError(t().museSessionGrant);
    let run: MuseRun;
    try {
      run = prepareMuseRun(o.env, o.permission, denied, { nativeOff: o.nativeOff, nativeItems: o.nativeItems, dirs: [o.cwd, ...(o.addDirs ?? [])] });
    } catch (err) {
      throw new AgentRunError(t().museConfigFailed((err as Error).message));
    }
    // Below full access on Linux, the folders its sandbox makes in the working directories to mount over.
    // Another run in the same folder may have them mounted: the last one to end removes them.
    const dirs = process.platform === 'linux' && o.permission !== 'full' ? [o.cwd, ...(o.addDirs ?? [])].map(realOr) : [];
    const mounts = missingMountPoints(dirs);
    for (const d of dirs) mountUsers.set(d, (mountUsers.get(d) ?? 0) + 1);
    try {
      const result = await museTurn(o, run.dir, denied);
      if (result.sessionId) rememberMuseSession(result.sessionId, grant);
      return result;
    } finally {
      run.done();
      for (const d of dirs) {
        const n = (mountUsers.get(d) ?? 1) - 1;
        if (n > 0) mountUsers.set(d, n);
        else mountUsers.delete(d);
      }
      removeEmptyMountPoints(mounts.filter((m) => !mountUsers.has(realOr(join(m, '..')))));
    }
  },
};

/** One Muse Code turn over ACP, with its own config folder `runDir`. */
async function museTurn(o: RunOptions, runDir: string, protectedPaths: readonly string[]): Promise<RunResult> {
  let child: ChildProcess | undefined;
  let sessionId: string | undefined;
  let userAborted = false;
  /** Until `session/new` or `session/resume` answers, its updates are not this turn's. */
  let opening = true;
  const stop = new AbortController();
  const stopSoon = (ms: number) => setTimeout(() => stop.abort(), ms).unref();

  const conn = new JsonRpcConnection((line) => child?.stdin?.write(line + '\n'));
  const updates = createMuseUpdateHandler(o.onEvent);
  conn.onNotification = (method, params) => {
    if (method !== 'session/update' || opening) return;
    if (!sessionId || params?.sessionId !== sessionId) return;
    updates.handle(params?.update);
  };
  /** The answer each call got, for the same call asked about again. */
  const answered = new Map<string, AcpDecision>();
  conn.onRequest = async (method, params) => {
    if (method !== 'session/request_permission') throw new RpcError(-32601, `${method} is not supported`);
    const options: { optionId: string; kind: string }[] = Array.isArray(params?.options) ? params.options : [];
    const id = String(params?.toolCall?.toolCallId ?? '');
    const once = (x: { optionId: string; kind: string }) => x.kind !== 'allow_always' && x.kind !== 'reject_always';
    const call: MuseToolCall = { ...updates.call(id), ...(params?.toolCall ?? {}) };
    // The same call asked about again gets the same answer; its network is asked of its own, every time
    // (each host it would reach).
    const key = `${id}\0call`;
    const again = id && !call.network ? answered.get(key) : undefined;
    if (again) return answerPermission(again, options.filter(once));
    const verdict = musePermissionDecision(o.permission, call, o.cwd, o.addDirs, protectedPaths);
    let decision: AcpDecision;
    let label = t().museRefused;
    if (verdict.run === 'allow') decision = { allow: true };
    else if (verdict.run === 'refuse') {
      decision = { allow: false, reason: verdict.reason };
      label = verdict.reason;
    } else if (o.requestApproval) {
      const answer = await o.requestApproval(museApprovalRequest(o.permission, call, o.cwd, o.addDirs));
      decision = answer.allow ? { allow: true } : { allow: false, reason: answer.note ?? '' };
      label = answer.note ? `${t().approvalDeclined} ${answer.note}` : t().approvalDeclined;
    } else decision = { allow: false, reason: 'Not covered by the permission' };
    if (!decision.allow && id) updates.refused(id, label);
    if (id && !call.network) answered.set(key, decision);
    // Never "allow always": Muse would keep the rule for the workspace.
    return answerPermission(decision, options.filter(once));
  };

  const onAbort = () => {
    userAborted = true;
    if (sessionId) conn.notify('session/cancel', { sessionId });
    stopSoon(2000);
  };
  o.signal.addEventListener('abort', onAbort, { once: true });

  const exited = runProcess({
    bin: o.bin,
    args: museArgs(o),
    cwd: o.cwd,
    env: museEnv(o.env, runDir),
    signal: stop.signal,
    timeoutMs: TURN_TIMEOUT_MS,
    keepStdinOpen: true,
    onSpawn: (c) => (child = c),
    onLine: conn.handleLine,
  }).then(
    (res) => {
      conn.close(new AgentRunError(res.timedOut ? t().timedOut : tail(res.stderr) || t().exitedWithoutTurn('muse', res.code)));
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
    const mcpServers = acpMcpServers(o.mcpServers ?? [], Boolean(caps.mcpCapabilities?.http), 'muse');
    const dirs = caps.sessionCapabilities?.additionalDirectories && o.addDirs?.length ? { additionalDirectories: o.addDirs } : {};
    const signIn = (err: unknown): never => {
      const message = err instanceof Error ? err.message : String(err);
      if (/log ?in to muse|not logged in|authenticat|credential/i.test(message)) throw new AgentRunError(t().museSignIn(message));
      throw err instanceof AgentRunError ? err : new AgentRunError(message);
    };
    if (o.sessionId) {
      sessionId = o.sessionId;
      await conn.request('session/resume', { sessionId, cwd: o.cwd, mcpServers, ...dirs }).catch(signIn);
    } else {
      const opened = await conn.request('session/new', { cwd: o.cwd, mcpServers, ...dirs }).catch(signIn);
      sessionId = String(opened?.sessionId ?? '');
      if (!sessionId) throw new AgentRunError(t().museNoSession);
    }
    opening = false;
    o.onEvent({ type: 'session', sessionId });
    if (userAborted) throw new AgentRunError(t().stopped, true);

    // The session's mode decides what runs without asking; a resumed one may have been left in another.
    await conn.request('session/set_config_option', { sessionId, configId: 'mode', value: museMode(o.permission) }).catch((err: Error) => {
      throw new AgentRunError(t().museRejectedMode(err.message));
    });

    const result = await conn.request('session/prompt', { sessionId, prompt: acpPrompt(musePromptText(o.prompt, o.systemPrompt), o.images) });
    updates.finish();
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (result?.stopReason === 'cancelled') throw new AgentRunError(t().museCancelled);
    return { sessionId };
  } catch (err) {
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (err instanceof AgentRunError) throw err;
    throw new AgentRunError(err instanceof Error ? err.message : String(err));
  } finally {
    opening = false;
    o.signal.removeEventListener('abort', onAbort);
    child?.stdin?.end(); // muse exits when its stdin closes
    stopSoon(3000);
    await exited.catch(() => undefined);
  }
}
