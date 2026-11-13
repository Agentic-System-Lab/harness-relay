import type { ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { endpointEffort, PROVIDER_LABEL, type NativeItemsOff, type NativePart, type Permission } from '../../shared/types';
import { endpointRunModel, type EndpointModel } from '../backends';
import { isPublishCommand } from '../commands';
import { t } from '../i18n';
import { converse, runProcess, stripAnsi, tail } from '../process';
import { patternPath, protectedReads, realPath, relayTmpDir, RUN_TMP_PREFIXES } from '../protect';
import { PROJECT_AGENT_CONFIG } from '../relaySandbox';
import { JsonRpcConnection, RpcError, acpContentText, acpMcpServers, acpPrompt, acpTokens, answerPermission, type AcpDecision } from './acp';
import { agentConfigPath, antigravityProjectFingerprint } from './antigravity';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  clipPath,
  summarizeInput,
  tailText,
  toolCallKind,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type RunOptions,
  type RunResult,
} from './types';

/*
 * GitHub Copilot CLI runs as an ACP agent (`copilot --acp`: JSON-RPC over stdin/stdout), like Grok,
 * Cursor and Antigravity. What its ACP server does, as tried with copilot 1.0.109 (a GitHub sign-in,
 * and a stand-in for an OpenAI-compatible model API):
 *
 * - Without allow-all it asks (`session/request_permission`: allow-once, allow-always, deny) before
 *   every command it does not take for read-only, every file it creates or edits, every URL a command
 *   or its fetch tool names, and every read outside the working directory and the temporary folder.
 *   It reads and runs read-only commands (`ls`, `cat` of any path, `git status`) without asking.
 * - Its own sandbox (`--sandbox`: Seatbelt on macOS, bubblewrap on Linux, a process container on
 *   Windows) works over ACP: commands write only in the working directory and the temporary folder,
 *   read only system, tool and working folders, and never the policy's denied paths; its file tools
 *   keep to the same policy. A read-only path inside the working directory holds against its
 *   commands (`copilotReadOnlyPaths`: git's hooks and config, the agents' config), but only one that
 *   exists when the sandbox starts, and on macOS not against a command that renames the folder above
 *   it; git needs the user's `~/.gitconfig` readable to run at all. A command it asks about still
 *   runs in the sandbox once allowed. The policy
 *   comes from the settings in its home (`sandbox`), which a project's `.github/copilot/settings.json`
 *   cannot widen. Only the flag fails closed: a sandbox on in the settings alone is dropped on a
 *   computer that cannot run it, and the flag itself is ignored while Copilot's own feature switch for
 *   it is off. So each run asks `/sandbox policy` (answered without the model) and checks it before
 *   the prompt (`copilotPolicyProblem`).
 * - Its home (`COPILOT_HOME`) holds what decides what runs without asking: saved approvals
 *   (`permissions-config.json`), trusted folders (`config.json`), URL rules and the sandbox policy
 *   (`settings.json`). Each run therefore gets a home of its own (`prepareCopilotRun`): settings of
 *   Harness Relay's, the account's sign-in state (`config.json` without its trusted folders), a link
 *   to the account's sessions (`session-state`), so sessions resume and AgentsView finds them, and
 *   links to what the account loads by itself, but for what the run leaves out. Its GitHub sign-in is
 *   in the system's credential store under the user's GitHub login, so a run's home finds it.
 * - A refused call ends its turn: Copilot tells the model "The user rejected this tool call." and stops
 *   (`stopReason: "end_turn"`), whatever the answer's `_meta` says.
 * - A project's hooks (`.github/hooks/*.json`, from the working directory up to the repository's
 *   root) run when the session opens and before tool calls, without asking (inside the sandbox below
 *   full access). Below full access the user is asked before Copilot starts when a project has any
 *   (`copilotProjectGate`).
 * - The briefing goes into its system prompt: the run's home has it as `copilot-instructions.md`, which
 *   Copilot reads at every start, so a resumed session has only the current one.
 * - `session/load` replays the session's messages before it answers; they are not this turn's. A
 *   session it does not have fails at once ("Resource not found").
 * - Mode and allow-all are the session's config options (`mode`, `allow_all`); autopilot mode turns
 *   allow-all on, so each turn sets both explicitly. Model and reasoning effort are flags (`--model`,
 *   `--reasoning-effort`), which apply to a loaded session too: setting the session's
 *   `reasoning_effort` option fails for every model ("does not support reasoning_effort
 *   configuration"), and a model that takes no effort refuses to open a session with one, so the run
 *   starts again without it.
 * - On the user's own endpoint it runs with its BYOK variables (`COPILOT_PROVIDER_*`): chat completions
 *   at the endpoint's base URL, the effort sent as `reasoning_effort`.
 */

/** An account's Copilot home: `COPILOT_HOME`, else `~/.copilot`. */
export function copilotHome(env: NodeJS.ProcessEnv, home = homedir()): string {
  return env.COPILOT_HOME || join(home, '.copilot');
}

/** Reads one of Copilot's JSON files, which may begin with `//` comment lines (`config.json` does). */
export function readCopilotJson(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const v = JSON.parse(text.replace(/^\s*\/\/[^\n]*$/gm, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The GitHub login an account's home says it is signed in as, if any (`config.json`). */
export function copilotSignedInAs(home: string): string | undefined {
  const config = readCopilotJson(join(home, 'config.json'));
  const last = config?.lastLoggedInUser as { login?: unknown } | undefined;
  if (typeof last?.login === 'string' && last.login) return last.login;
  const users = Array.isArray(config?.loggedInUsers) ? (config.loggedInUsers as { login?: unknown }[]) : [];
  const login = users.find((u) => typeof u?.login === 'string' && u.login)?.login;
  return typeof login === 'string' ? login : undefined;
}

/**
 * The keys of the account's own `settings.json` a run keeps: its model (but on the user's own endpoint,
 * where they would name one of Copilot's service), its proxy, whether its sessions are synced to
 * GitHub (`remoteExport`) and whether it updates itself, and what it loads by itself (each only while
 * that part is not left out). Nothing else is kept: other keys decide what runs without asking
 * (`allowedUrls`, `defaultPermissionMode`, `sandbox`), run commands of their own (`statusLine`,
 * `telemetry`) or let a session start others (`sessionManagementTools`).
 */
const KEPT: Record<'model' | 'always' | 'skills' | 'mcp' | 'hooks' | 'plugins' | 'memory', readonly string[]> = {
  model: ['model', 'modelProviderId', 'effortLevel', 'contextTier', 'autoTier', 'fusionTier'],
  always: [
    'remoteExport',
    'autoUpdate',
    'autoUpdatesChannel',
    'proxyUrl',
    'proxyKerberosServicePrincipal',
    'deniedUrls',
    'includeCoAuthoredBy',
    'experimental',
    'subagents',
    'customAgents',
    'extensions',
    'storeTokenPlaintext',
    'logLevel',
  ],
  skills: ['skillDirectories', 'ignoredSkillsLocations', 'disabledSkills', 'dynamicRetrieval'],
  mcp: ['disabledMcpServers', 'enabledMcpServers', 'githubMcpToolsets', 'githubMcpTools', 'enableAllGithubMcpTools', 'githubMcpInsiders'],
  hooks: ['hooks', 'disableAllHooks', 'disabledHooks'],
  plugins: ['enabledPlugins', 'extraKnownMarketplaces', 'strictKnownMarketplaces'],
  memory: ['memory'],
};

/** What a run's settings need besides the account's own: its permission and folders. */
export interface CopilotRunPolicy {
  permission: Permission;
  /** The conversation's other working directories: read-write in the sandbox (`--add-dir` does not make them so). */
  addDirs?: readonly string[];
  /** Folders the agent may read besides them (its skills, the attachments). */
  readDirs?: readonly string[];
  /** What the sandbox may neither read nor write. */
  protectedPaths?: readonly string[];
  nativeOff?: readonly NativePart[];
  nativeItems?: NativeItemsOff;
  /** It runs on the user's own endpoint (its BYOK variables name the model). */
  onEndpoint?: boolean;
}

/**
 * The settings of one run (`settings.json` in its home): the account's kept keys (`KEPT`), with
 * below full access Copilot's sandbox on: commands write in the working directories only, read what
 * the run may read, never the protected paths, no command may leave the sandbox (`allowBypass`), and
 * git and gh get no credentials through its proxy, nor commands the macOS keychain; MCP servers (the user's own, the tool library's)
 * run outside it, as with every other CLI. Its dev-tool access stays on (commands read the tool
 * folders builds need), but what it would let them write besides the working directories (shared
 * build caches, Cargo's stores) is in the read-only paths the run gives it (`copilotReadOnlyPaths`).
 * Full access: no sandbox (`--allow-all` too). Memory and hooks left out are off; skills left out one
 * by one are disabled by name.
 */
export function copilotRunSettings(own: unknown, p: CopilotRunPolicy): Record<string, unknown> {
  const base = own && typeof own === 'object' && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
  const off = new Set(p.nativeOff ?? []);
  const keys = [
    ...(p.onEndpoint ? [] : KEPT.model),
    ...KEPT.always,
    ...(off.has('skills') ? [] : KEPT.skills),
    ...(off.has('mcp') ? [] : KEPT.mcp),
    ...(off.has('hooks') ? [] : KEPT.hooks),
    ...(off.has('plugins') ? [] : KEPT.plugins),
    ...(off.has('memory') ? [] : KEPT.memory),
  ];
  const out: Record<string, unknown> = Object.fromEntries(keys.filter((k) => base[k] !== undefined).map((k) => [k, base[k]]));
  const skills = p.nativeItems?.skills ?? [];
  if (skills.length) {
    const ownDisabled = Array.isArray(out.disabledSkills) ? out.disabledSkills.filter((s): s is string => typeof s === 'string') : [];
    out.disabledSkills = [...new Set([...ownDisabled, ...skills])];
  }
  if (off.has('memory')) out.memory = false;
  if (off.has('hooks')) out.disableAllHooks = true;
  out.sessionManagementTools = { enabled: false };
  if (p.permission === 'full') {
    out.sandbox = { enabled: false };
    return out;
  }
  out.sandbox = {
    enabled: true,
    allowBypass: false,
    addCurrentWorkingDirectory: true,
    allowDevToolAccess: true,
    auth: { git: false, gh: false },
    sandboxMcpServers: false,
    sandboxLspServers: true,
    sandboxExtensions: true,
    userPolicy: {
      filesystem: {
        readwritePaths: [...(p.addDirs ?? [])],
        readonlyPaths: [...(p.readDirs ?? [])],
        deniedPaths: [...(p.protectedPaths ?? [])],
      },
      network: { allowOutbound: true, allowLocalNetwork: true },
      seatbelt: { keychainAccess: false },
    },
  };
  return out;
}

/**
 * Keys of an account's `config.json` a run never takes, in either spelling (older Copilot CLIs kept
 * settings there, `trusted_folders` and `allowed_urls` among them): the folders it trusts, and what
 * `settings.json` would decide that a run's settings leave out (`KEPT`).
 */
const CONFIG_DROPPED = /^(trusted_?folders|allowed_?urls|allow_?all|default_?permission_?mode|sandbox|status_?line|telemetry|session_?management_?tools|assisted_?approval)$/i;

/**
 * The account's `config.json` as a run takes it: its sign-in state (the users signed in, which name
 * their tokens in the credential store), without the folders the user trusted (whose workspace MCP
 * servers would start) or what would widen what runs (`CONFIG_DROPPED`), and without its plugins' or
 * hooks' state when those are left out. Every other key is
 * kept, not only the known ones: Copilot writes this file itself (it says so at its top), and a sign-in
 * it could not save in a credential store (`storeTokenPlaintext`) keeps what it needs here too, under
 * keys of its own. The run's home is in Harness Relay's temporary folder, which commands in its sandbox
 * may not read (`protectedReads`).
 */
export function copilotRunConfig(own: Record<string, unknown> | undefined, nativeOff: readonly NativePart[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(own ?? {})) {
    if (CONFIG_DROPPED.test(k)) continue;
    if (nativeOff.includes('hooks') && /hook/i.test(k)) continue;
    if (nativeOff.includes('plugins') && /plugin|marketplace/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** What a run's home links to in the account's home, by the part of what Copilot loads by itself it belongs to. */
const LINKED: { name: string; part?: NativePart; dir: boolean }[] = [
  { name: 'skills', part: 'skills', dir: true },
  { name: 'agents', part: 'agents', dir: true },
  { name: 'hooks', part: 'hooks', dir: true },
  { name: 'instructions', dir: true },
  { name: 'installed-plugins', part: 'plugins', dir: true },
  { name: 'plugin-data', part: 'plugins', dir: true },
  { name: 'extensions', dir: true },
  { name: 'mcp-config.json', part: 'mcp', dir: false },
  { name: 'lsp-config.json', dir: false },
];

/** The briefing as the run's `copilot-instructions.md` has it, before the account's own personal instructions. */
export function copilotInstructions(briefing: string, own?: string): string {
  const parts = [
    '<harness-relay-briefing>',
    'Standing instructions from Harness Relay, the app this conversation runs in.',
    '',
    briefing.trim(),
    '',
    COPILOT_NOTES,
    '</harness-relay-briefing>',
  ];
  return `${parts.join('\n')}\n${own?.trim() ? `\n${own.trim()}\n` : ''}`;
}

/**
 * What the briefing adds for Copilot: a refused tool call ends its turn at once, and its own question
 * tool is not how the user is asked.
 */
export const COPILOT_NOTES =
  'In this app, a tool call that is refused (by the user, or because the conversation\'s permission does not cover it) ends your turn at once, ' +
  'and you are not told why. So before a call that may need the user\'s approval (a shell command, a write outside the working directories), ' +
  'first say in your reply what you are about to do and why. To ask the user something, ask as these instructions say.';

/** A run's own home, and how to remove it. */
export interface CopilotRun {
  dir: string;
  /** For a question about its models or sign-in: the empty folder it is asked in. */
  cwd?: string;
  done(): void;
}

/**
 * Makes a run's home in Harness Relay's own temporary folder (owner only): its `settings.json`
 * (`copilotRunSettings`), `config.json` (`copilotRunConfig`), the briefing (`copilotInstructions`), a
 * link to the account's `session-state` (made if missing) and, but on Windows, to its `session-store.db`,
 * and links (copies, for files) to what the account loads by itself that the run keeps. On Windows a
 * folder's link is a junction.
 */
export function prepareCopilotRun(accountHome: string, policy: CopilotRunPolicy, briefing: string, tmp = relayTmpDir()): CopilotRun {
  const own = readCopilotJson(join(accountHome, 'settings.json'));
  const config = readCopilotJson(join(accountHome, 'config.json'));
  const sessions = join(accountHome, 'session-state');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(tmp, RUN_TMP_PREFIXES.copilot));
  chmodSync(dir, 0o700);
  const done = () => rmSync(dir, { recursive: true, force: true }); // the links go, not what they lead to
  const link = (target: string, name: string) => symlinkSync(target, join(dir, name), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const write = (name: string, text: string) => writeFileSync(join(dir, name), text, { mode: 0o600 });
    write('settings.json', `${JSON.stringify(copilotRunSettings(own, policy), null, 2)}\n`);
    write('config.json', `${JSON.stringify(copilotRunConfig(config, policy.nativeOff), null, 2)}\n`);
    let personal: string | undefined;
    try {
      personal = readFileSync(join(accountHome, 'copilot-instructions.md'), 'utf8');
    } catch {
      personal = undefined;
    }
    write('copilot-instructions.md', copilotInstructions(briefing, personal));
    link(sessions, 'session-state');
    // Its index of sessions, with each turn's usage, which AgentsView reads: the account's, made there if
    // missing (SQLite follows the link, its journal beside the account's file). Not on Windows, where a
    // link to a file needs Developer Mode: a run's usage stays in its own home there.
    if (process.platform !== 'win32') symlinkSync(join(accountHome, 'session-store.db'), join(dir, 'session-store.db'), 'file');
    const off = new Set(policy.nativeOff ?? []);
    for (const item of LINKED) {
      if (item.part && off.has(item.part)) continue;
      const from = join(accountHome, item.name);
      if (!existsSync(from)) continue;
      if (item.dir) link(from, item.name);
      else copyFileSync(from, join(dir, item.name));
    }
  } catch (err) {
    done();
    throw err;
  }
  return { dir, done };
}

/**
 * A home of its own for a question to Copilot that opens a session (its models, its sign-in): the
 * account's sign-in state only, so the session it opens is not kept among the account's; and an empty
 * folder to ask it in, a repository of its own in the system's temporary folder, so that no project's
 * hooks run (Copilot reads them up to a repository's root, and Harness Relay's data folder may be in
 * one).
 */
export function prepareCopilotProbeHome(accountHome: string, tmp = relayTmpDir()): CopilotRun {
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(tmp, RUN_TMP_PREFIXES.copilot));
  chmodSync(dir, 0o700);
  const cwd = mkdtempSync(join(tmpdir(), 'relay-copilot-ask-'));
  mkdirSync(join(cwd, '.git'));
  const done = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  };
  try {
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(copilotRunConfig(readCopilotJson(join(accountHome, 'config.json'))), null, 2)}\n`, { mode: 0o600 });
    const own = readCopilotJson(join(accountHome, 'settings.json'));
    const kept = Object.fromEntries(['model', 'modelProviderId', 'effortLevel', 'proxyUrl', 'storeTokenPlaintext'].filter((k) => own?.[k] !== undefined).map((k) => [k, own![k]]));
    writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    done();
    throw err;
  }
  return { dir, cwd, done };
}

/** Every part of what Copilot loads by itself, left out. */
const ALL_PARTS: readonly NativePart[] = ['skills', 'mcp', 'memory', 'hooks', 'plugins'];

/**
 * A home in which a run's sandbox is checked before the run itself starts: the account's sign-in
 * state and the run's settings (its sandbox, the same as the run's), with everything Copilot loads by
 * itself left out and nothing linked, and an empty repository of its own as the working directory, so
 * nothing runs when its session opens. Removed by `done()`.
 */
export function prepareCopilotPolicyHome(accountHome: string, policy: CopilotRunPolicy, tmp = relayTmpDir()): CopilotRun {
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(tmp, RUN_TMP_PREFIXES.copilot));
  chmodSync(dir, 0o700);
  const cwd = mkdtempSync(join(tmpdir(), 'relay-copilot-check-'));
  mkdirSync(join(cwd, '.git'));
  const done = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  };
  try {
    const config = copilotRunConfig(readCopilotJson(join(accountHome, 'config.json')), ALL_PARTS);
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const settings = copilotRunSettings(readCopilotJson(join(accountHome, 'settings.json')), { ...policy, nativeOff: ALL_PARTS, nativeItems: {} });
    writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    done();
    throw err;
  }
  return { dir, cwd, done };
}

/**
 * Whether Copilot would run something by itself as a run's session opens, before its sandbox can be
 * checked: a project's hooks, or in the run's home hooks, plugins (theirs), extensions or language
 * servers. Then the run's sandbox is checked first in a home where nothing runs (`prepareCopilotPolicyHome`).
 */
export function copilotStartsSomething(runDir: string, projectHooks: readonly string[]): boolean {
  if (projectHooks.length) return true;
  if (['hooks', 'installed-plugins', 'extensions', 'lsp-config.json'].some((n) => existsSync(join(runDir, n)))) return true;
  const hooks = readCopilotJson(join(runDir, 'settings.json'))?.hooks;
  return Boolean(hooks && typeof hooks === 'object' && Object.keys(hooks).length);
}

/** The variables a run's key could be in, kept from its commands and MCP servers (`--secret-env-vars`). */
export const COPILOT_SECRET_VARS = ['COPILOT_GITHUB_TOKEN', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN'] as const;

/**
 * The arguments of a run: ACP; below full access its sandbox (the flag, so that it fails closed),
 * full access allows everything; the other working directories; the keys kept from commands; and what
 * the run leaves out of what Copilot loads by itself (skills by its skill tool, the built-in MCP
 * servers, single MCP servers by name); the model (`--model`) and the reasoning effort
 * (`--reasoning-effort`). On an endpoint the model is in `COPILOT_MODEL` instead (`copilotEnv`): a BYOK
 * model given with `--model` as well refuses any effort ("does not support reasoning effort
 * configuration"), and takes it this way (copilot 1.0.109).
 */
export function copilotArgs(o: {
  permission: Permission;
  addDirs?: readonly string[];
  nativeOff?: readonly NativePart[];
  nativeItems?: NativeItemsOff;
  /** The model, but on an endpoint (`COPILOT_MODEL` names it there). */
  model?: string;
  effort?: string;
}): string[] {
  const off = new Set(o.nativeOff ?? []);
  return [
    '--acp',
    ...(o.permission === 'full' ? ['--allow-all'] : ['--sandbox']),
    ...(o.addDirs ?? []).flatMap((d) => ['--add-dir', d]),
    `--secret-env-vars=${COPILOT_SECRET_VARS.join(',')}`,
    ...(off.has('skills') ? ['--excluded-tools', 'skill'] : []),
    ...(off.has('mcp') ? ['--disable-builtin-mcps'] : []),
    ...(off.has('mcp') ? [] : (o.nativeItems?.mcp ?? []).flatMap((name) => ['--disable-mcp-server', name])),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--reasoning-effort', o.effort] : []),
  ];
}

/** The variables that would widen what runs without asking, or point Copilot at a model service the run did not choose. */
const DROPPED_VARS = ['COPILOT_ALLOW_ALL', 'COPILOT_ASSISTED_APPROVAL'] as const;

/** Copilot's BYOK variables, all of which a run on an endpoint sets or clears. */
const PROVIDER_VARS = [
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_API_KEY_COMMAND',
  'COPILOT_PROVIDER_BEARER_TOKEN',
  'COPILOT_PROVIDER_WIRE_API',
  'COPILOT_PROVIDER_TRANSPORT',
  'COPILOT_PROVIDER_MODEL_ID',
  'COPILOT_PROVIDER_WIRE_MODEL',
  'COPILOT_PROVIDER_HEADERS',
  'COPILOT_PROVIDERS_CONFIG',
  'COPILOT_MODEL',
] as const;

/**
 * The environment of a run: the account's, with the run's own home, none of the variables that would
 * let it run everything without asking, plugins found only where the run puts them when they are left
 * out, the skills in `~/.agents/skills` for an account in Copilot's usual home (below), and on an
 * endpoint Copilot's BYOK variables for it (chat completions at its base URL, its key).
 */
export function copilotEnv(
  env: NodeJS.ProcessEnv,
  runHome: string,
  nativeOff: readonly NativePart[] = [],
  endpoint?: EndpointModel,
  home = homedir(),
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, COPILOT_HOME: runHome };
  for (const k of DROPPED_VARS) delete out[k];
  if (nativeOff.includes('skills')) delete out.COPILOT_SKILLS_DIRS;
  else if (realPath(resolve(copilotHome(env, home))) === realPath(join(home, '.copilot'))) {
    // Copilot reads `~/.agents/skills` only while its home is `~/.copilot` itself (however `COPILOT_HOME`
    // spells it: a trailing slash, a link, another letter case), which a run's own home is not; given as
    // one of its skill folders (a comma-separated list; a missing folder is skipped), the default
    // account's runs get them as the user's own Copilot does, and as Settings lists them (`skill list`
    // there, in that home). Tried with copilot 1.0.111. A path with a comma in it cannot be one of the
    // list's: such a home's runs go without them.
    const agents = join(home, '.agents', 'skills');
    if (!agents.includes(',')) out.COPILOT_SKILLS_DIRS = env.COPILOT_SKILLS_DIRS ? `${env.COPILOT_SKILLS_DIRS},${agents}` : agents;
  }
  if (nativeOff.includes('plugins')) out.COPILOT_PLUGIN_DIR_ONLY = 'true';
  if (endpoint) {
    for (const k of PROVIDER_VARS) delete out[k];
    out.COPILOT_PROVIDER_BASE_URL = endpoint.endpoint.baseUrl.trim().replace(/\/+$/, '');
    out.COPILOT_PROVIDER_TYPE = 'openai';
    out.COPILOT_PROVIDER_WIRE_API = 'completions';
    out.COPILOT_MODEL = endpoint.model;
    if (endpoint.endpoint.apiKey) out.COPILOT_PROVIDER_API_KEY = endpoint.endpoint.apiKey;
  }
  return out;
}

/** The environment of a question to Copilot (its models, its lists), in the account's home or `home`. */
export function copilotProbeEnv(env: NodeJS.ProcessEnv, home?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, NO_COLOR: '1' };
  for (const k of DROPPED_VARS) delete out[k];
  if (home) out.COPILOT_HOME = home;
  return out;
}

// --- The sandbox policy ------------------------------------------------------------------------

/**
 * What in a working directory decides how agents run later, outside any sandbox: git's hooks and
 * config, the agents' project config (`PROJECT_AGENT_CONFIG`, which the relay sandbox keeps read-only
 * too), and the editors' tasks.
 */
const PROJECT_RUNNABLE = ['.git/hooks', '.git/config', '.gitmodules', '.vscode', '.idea', ...PROJECT_AGENT_CONFIG];

/**
 * Where Copilot's dev-tool access lets commands write besides the working directories: the shared
 * package and build caches of the tools it finds (tried with copilot 1.0.109 on a Mac, in projects of
 * each kind: Cargo's registry, git store and lock files, Go's build and module caches, npm's, pnpm's,
 * Yarn's, Bun's, Deno's, pip's, uv's, Poetry's, virtualenv's, Bundler's, Maven's, Gradle's, ccache's,
 * sccache's, node-gyp's, Electron's and Playwright's), each where its variable
 * moves it and also where it is by default, since Copilot grants both (tried: with `CARGO_HOME` and
 * `GOCACHE` moved it still granted `~/.cargo/registry` and the default go-build). Some hold programs
 * a later build or command runs outside any sandbox (npx's packages, Playwright's browsers, Gradle's
 * wrapper), so below full access they are read-only, as every other CLI's sandbox keeps them: commands
 * write only in the working directories and temporary folders. What else its policy lists is found in
 * the turn (`copilotDevWrites`).
 */
export function copilotToolCaches(env: NodeJS.ProcessEnv, home = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const both = (moved: string | undefined, standard: string) => (moved ? [moved, standard] : [standard]);
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const caches =
    platform === 'darwin'
      ? [join(home, 'Library', 'Caches'), join(home, '.cache')]
      : platform === 'win32'
        ? [local, join(home, '.cache')]
        : both(env.XDG_CACHE_HOME, join(home, '.cache'));
  const cargo = both(env.CARGO_HOME, join(home, '.cargo'));
  const gopath = both(env.GOPATH, join(home, 'go'));
  const sccache = platform === 'darwin' ? 'Mozilla.sccache' : platform === 'win32' ? join('Mozilla', 'sccache') : 'sccache';
  const moved = ['GOCACHE', 'GOMODCACHE', 'CCACHE_DIR', 'SCCACHE_DIR', 'npm_config_cache', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'BUN_INSTALL_CACHE_DIR', 'YARN_CACHE_FOLDER', 'ELECTRON_CACHE', 'PLAYWRIGHT_BROWSERS_PATH']
    .map((k) => env[k])
    .filter((v): v is string => Boolean(v));
  return [
    ...new Set([
      ...moved,
      ...cargo.flatMap((c) => ['registry', 'git', '.global-cache', '.package-cache', '.package-cache-mutate'].map((p) => join(c, p))),
      ...gopath.map((g) => join(g, 'pkg', 'mod')),
      ...caches.flatMap((c) =>
        ['go-build', 'ccache', sccache, 'pip', 'uv', 'pypoetry', 'electron', 'ms-playwright', 'node-gyp', 'node', 'deno', 'Yarn', 'yarn', 'gh'].map((p) => join(c, p)),
      ),
      ...both(env.CCACHE_DIR, join(home, '.ccache')),
      ...both(env.GRADLE_USER_HOME, join(home, '.gradle')),
      join(home, '.m2', 'repository'),
      join(home, '.npm'),
      ...(platform === 'win32' ? [join(local, 'npm-cache'), join(local, 'pnpm', 'store'), join(local, 'Yarn', 'Cache'), join(local, 'pypoetry', 'Cache')] : []),
      join(home, '.pnpm-store'),
      ...both(env.XDG_DATA_HOME, join(home, '.local', 'share')).flatMap((d) => [join(d, 'pnpm', 'store'), join(d, 'virtualenv')]),
      ...(platform === 'darwin' ? [join(home, 'Library', 'pnpm', 'store')] : []),
      join(env.BUN_INSTALL || join(home, '.bun'), 'install', 'cache'),
      join(home, '.yarn', 'berry'),
      join(home, '.bundle', 'cache'),
      join(home, '.node-gyp'),
      join(home, '.electron-gyp'),
      ...(env.XDG_CACHE_HOME ? [join(env.XDG_CACHE_HOME, 'gh')] : []),
    ]),
  ];
}

/**
 * What Copilot's sandbox lets commands read but not write, below full access: the user's git config
 * (its sandbox does not let commands read the home folder, and git refuses to run without it), the
 * shared caches its dev-tool access would let them write (`copilotToolCaches`; a read-only path wins
 * over that), and what in each working directory decides how agents run later. Only what exists now:
 * a path that does not exist when its sandbox starts is not protected by it (and bubblewrap refuses to
 * start on one).
 */
export function copilotReadOnlyPaths(dirs: readonly string[], env: NodeJS.ProcessEnv, home = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  const xdgGit = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'git');
  // git's own files there, not the folder: credential-store may keep `credentials` in it.
  const git = [join(home, '.gitconfig'), ...['config', 'ignore', 'attributes'].map((f) => join(xdgGit, f))];
  const project = dirs.flatMap((d) => PROJECT_RUNNABLE.map((p) => join(d, p)));
  return [...new Set([...git, ...copilotToolCaches(env, home, platform), ...project])].filter((p) => existsSync(p));
}

/** A path as Copilot's policy may print it: as given, and by its real path (macOS's `/private/tmp` for `/tmp`). */
const spellings = (path: string) => [...new Set([path, realPath(path)].map((p) => p.replace(/[\\/]+$/, '')))];

/**
 * The paths a policy lists, by kind (`denied`, `read-write`, `read-only`), as whole lines: from every
 * section, or from the one `section` names ("Dev tools", "User-configured paths").
 */
export function copilotPolicyPaths(text: string, section?: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let kind: string | undefined;
  let inSection = section === undefined;
  for (const line of stripAnsi(text).replace(/\r/g, '').split('\n')) {
    const title = /^(\S.*):\s*$/.exec(line);
    if (title) {
      if (section !== undefined) inSection = title[1] === section;
      kind = undefined;
      continue;
    }
    if (!inSection) continue;
    const heading = /^ {2}(Denied|Read-write|Read-only) paths \(\d+\):\s*$/.exec(line);
    if (heading) {
      kind = heading[1]!.toLowerCase();
      continue;
    }
    const entry = /^ {4}(\S.*?)\s*$/.exec(line);
    if (kind && entry) (out[kind] ??= []).push(entry[1]!);
    else kind = undefined;
  }
  return out;
}

/**
 * What is wrong with the policy Copilot says is in force (`/sandbox policy`) for a run below full
 * access, or undefined: it must be on, let no command leave it, list each protected path among its
 * denied paths and each other working directory among its read-write ones, each as a line of its own.
 */
export function copilotPolicyProblem(
  text: string,
  p: { protectedPaths?: readonly string[]; addDirs?: readonly string[] },
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const policy = stripAnsi(text);
  if (!/^Effective sandbox policy/im.test(policy)) {
    return clip(policy.trim().split('\n')[0] || 'no policy', 200);
  }
  if (!/^\s*Allow sandbox bypass:\s*no\s*$/im.test(policy)) return 'a command may leave the sandbox (bypass)';
  // What would give its commands the user's credentials, where it says.
  for (const m of policy.matchAll(/^\s*(Allow keychain access|Authenticate git(?: \(sandbox setting\))?|Authenticate gh(?: \(sandbox setting\))?):\s*(.*?)\s*$/gim)) {
    if (m[2]!.toLowerCase() !== 'off') return `${m[1]}: ${m[2]}`;
  }
  const paths = copilotPolicyPaths(policy);
  const norm = (path: string) => {
    const p = path.replace(/[\\/]+$/, '');
    return platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
  };
  const listed = (path: string, kind: string) => spellings(path).some((s) => (paths[kind] ?? []).some((l) => norm(l) === norm(s)));
  const notDenied = (p.protectedPaths ?? []).find((path) => !listed(path, 'denied'));
  if (notDenied) return `${notDenied} is not among its denied paths`;
  const notWritable = (p.addDirs ?? []).find((path) => !listed(path, 'read-write'));
  return notWritable ? `${notWritable} is not among its read-write paths` : undefined;
}

/** The temporary folders every CLI's commands may write: the environment's, and the system's (pnpm keeps its lock folders in `/tmp`). */
export function copilotTempDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  return [env.TMPDIR || env.TEMP || env.TMP || tmpdir(), ...(platform === 'win32' ? [] : ['/tmp', '/private/tmp', '/var/tmp'])];
}

/**
 * What the policy's dev-tool access lets commands write that none of the read-only paths the run gave
 * covers (a cache this computer keeps elsewhere, a tool `copilotToolCaches` does not know): the paths
 * that exist, which the run then makes read-only too. A command can still bring in more of them as it
 * runs ("run /sandbox policy <command> to resolve those"), which are not seen in advance.
 */
export function copilotDevWrites(
  text: string,
  readOnly: readonly string[],
  tempDirs: readonly string[] = copilotTempDirs(process.env),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const sep = platform === 'win32' ? '\\' : '/';
  const norm = (path: string) => {
    const p = path.replace(/[\\/]+$/, '');
    return platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
  };
  const within = (dirs: readonly string[]) => {
    const all = dirs.flatMap(spellings).map(norm);
    return (path: string) => spellings(path).map(norm).some((p) => all.some((g) => p === g || p.startsWith(g + sep)));
  };
  const covered = within(readOnly);
  // Every CLI's commands may write the temporary folders (pnpm's lock folders are there).
  const temp = within(tempDirs);
  return (copilotPolicyPaths(text, 'Dev tools')['read-write'] ?? []).filter((p) => !covered(p) && !temp(p) && existsSync(p));
}

// --- What a project makes Copilot run by itself --------------------------------------------------

/** The folders from `dir` up to its repository's root (a folder with `.git`), or `dir` alone outside one. */
function upToRepo(dir: string): string[] {
  const dirs: string[] = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    dirs.push(d);
    if (existsSync(join(d, '.git'))) return dirs;
    if (dirname(d) === d) return [resolve(dir)];
  }
}

/**
 * The settings files of a project that Copilot's help says hooks may also be defined in (its own, and
 * Claude Code's, whose hooks it runs on the matching events). Their hooks did not run in an untrusted
 * folder (copilot 1.0.109), but a file that defines any is asked about all the same.
 */
const HOOK_SETTINGS = [
  ['.github', 'copilot', 'settings.json'],
  ['.github', 'copilot', 'settings.local.json'],
  ['.claude', 'settings.json'],
  ['.claude', 'settings.local.json'],
];

/**
 * The hook files of the chat's working directories that Copilot runs by itself, without a permission
 * request (`.github/hooks/*.json`, from each folder up to its repository's root): when its session
 * opens and before tool calls, also when the run's own settings say `disableAllHooks` (tried with
 * copilot 1.0.109); and the project settings files that define hooks too (`HOOK_SETTINGS`). Another
 * agent in edit mode can write them, and so can whoever made the repository.
 */
export function copilotProjectHooks(dirs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const dir of dirs) {
    for (const up of upToRepo(dir)) {
      for (const parts of HOOK_SETTINGS) {
        const file = join(up, ...parts);
        const hooks = readCopilotJson(file)?.hooks;
        if (hooks && typeof hooks === 'object' && Object.keys(hooks).length) out.add(file);
      }
      const hooks = join(up, '.github', 'hooks');
      let names: string[];
      try {
        names = readdirSync(hooks);
      } catch {
        continue;
      }
      for (const name of names) {
        const p = join(hooks, name);
        try {
          if (/\.json$/i.test(name) && statSync(p).isFile()) out.add(p);
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return [...out].sort();
}

/**
 * Below full access, before Copilot starts: when the working directories hold project hooks Copilot
 * would run by itself (`copilotProjectHooks`), the user decides first (its card names the files;
 * "always allow" holds while their contents stay the same); refused, or when the chat refuses
 * automatically, the turn does not start. Asked also when the run leaves hooks out: Copilot runs a
 * project's hooks whatever its `disableAllHooks` says.
 */
async function copilotProjectGate(o: RunOptions): Promise<string[]> {
  if (o.permission === 'full') return [];
  const files = copilotProjectHooks([o.cwd, ...(o.addDirs ?? [])]);
  if (!files.length) return [];
  const shown = files.map((f) => {
    const rel = relative(o.cwd, f);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : f;
  });
  const answer = o.requestApproval
    ? await o.requestApproval({
        kind: 'other',
        // Not translated: it names the "always allow" rule, which must be the same in every language.
        // What the hooks run may be beside them (a script in .github/hooks): the folders count, not only their JSON files.
        tool: `Copilot project hooks ${antigravityProjectFingerprint(files.map((f) => (basename(dirname(f)) === 'hooks' ? dirname(f) : f)), 16)}`,
        detail: shown.join(', '),
        reason: t().copilotProjectHooks,
      })
    : { allow: false };
  if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
  if (!answer.allow) throw new AgentRunError(t().copilotProjectHooksRefused(shown.join(', ')));
  return files;
}

// --- Permissions -------------------------------------------------------------------------------

/** The `toolCall` of a `session/request_permission` (Copilot sends its kind, title and input). */
export interface CopilotToolCall {
  toolCallId?: string;
  kind?: string;
  title?: string;
  rawInput?: Record<string, any>;
  locations?: { path?: string }[];
  content?: unknown;
}

/** The command a call runs. */
export function copilotCommand(call: CopilotToolCall): string {
  const cmd = call.rawInput?.command;
  return typeof cmd === 'string' && cmd ? cmd : (call.title ?? '');
}

/** The input keys a call names a file or folder by (`fileName` in a write it asks about, `path` in the call). */
const PATH_KEYS = ['path', 'fileName', 'file_path', 'filePath'] as const;

/** Every file or folder a call is about: its input's paths and its locations, each once. */
export function copilotPaths(call: CopilotToolCall): string[] {
  const input = call.rawInput ?? {};
  const fromInput = PATH_KEYS.map((k) => input[k]).filter((p): p is string => typeof p === 'string' && p.length > 0);
  const fromLocations = Array.isArray(call.locations) ? call.locations.map((l) => l?.path).filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
  return [...new Set([...fromInput, ...fromLocations])];
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
 * Whether a path inside `dir` is one where a write could change how agents run later
 * (`agentConfigPath`: the other CLIs' folders, Copilot's own in a `.github` folder, git's hooks and
 * config, the editors'), compared without letter case.
 */
export function copilotConfigPath(cwd: string, path: string, dir: string): boolean {
  return agentConfigPath(cwd, path, dir);
}

/** A write, edit, delete or move. */
const isWrite = (call: CopilotToolCall) => call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move';

/** What to do with a call Copilot asks about: run it, ask the user, or refuse it without asking. */
export type CopilotDecision = { run: 'allow' } | { run: 'ask' } | { run: 'refuse'; reason: string };

/**
 * Whether to approve a call Copilot asks about under this permission. Below full access its commands
 * run in its sandbox, so the permission covers: reads (but of the protected paths, which are refused)
 * and URLs, in read-only and edit; in edit, commands (but pushing and publishing, `isPublishCommand`,
 * which go to the user) and writes in the conversation's working directories (but where a write could
 * change how agents run later, which go to the user). Anything else goes to the user: an MCP server's
 * tool (Copilot's built-in GitHub server can push files and open pull requests, outside any sandbox)
 * and storing a memory (kept on GitHub for everyone using the repository's memories).
 */
export function copilotPermissionDecision(
  permission: Permission,
  call: CopilotToolCall,
  cwd: string,
  addDirs: readonly string[] = [],
  protectedPaths: readonly string[] = [],
): CopilotDecision {
  if (permission === 'full') return { run: 'allow' };
  const paths = copilotPaths(call);
  if (paths.some((path) => protectedPaths.some((p) => within(cwd, path, p)))) return { run: 'refuse', reason: t().copilotProtected };
  if (call.kind === 'fetch') return { run: 'allow' };
  if (call.kind === 'read' || call.kind === 'search') return { run: 'allow' };
  if (permission === 'read-only') return { run: 'ask' };
  if (call.kind === 'execute') return isPublishCommand(copilotCommand(call)) ? { run: 'ask' } : { run: 'allow' };
  if (isWrite(call)) {
    const fine =
      paths.length > 0 &&
      paths.every((path) => {
        const dir = [cwd, ...addDirs].find((d) => within(cwd, path, d));
        return dir !== undefined && !copilotConfigPath(cwd, path, dir);
      });
    return fine ? { run: 'allow' } : { run: 'ask' };
  }
  return { run: 'ask' };
}

/** What to show the user when Copilot asks about a call the permission does not cover. */
export function copilotApprovalRequest(permission: Permission, call: CopilotToolCall, cwd: string, addDirs: readonly string[] = []): ApprovalRequest {
  const input = call.rawInput ?? {};
  if (call.kind === 'execute') {
    const description = typeof input.description === 'string' && input.description ? input.description : undefined;
    // Below full access it runs in Copilot's sandbox once allowed: no `outsideSandbox`.
    return { kind: 'command', detail: copilotCommand(call), reason: description ?? (call.title !== copilotCommand(call) ? call.title : undefined) };
  }
  if (isWrite(call)) {
    const path = copilotPaths(call)[0];
    const dir = path ? [cwd, ...addDirs].find((d) => within(cwd, path, d)) : undefined;
    const reason = permission === 'read-only' ? call.title : !path || !dir ? t().copilotOutsideWrite : t().copilotConfigWrite;
    return { kind: 'edit', detail: path, reason };
  }
  if (call.kind === 'fetch') return { kind: 'fetch', detail: typeof input.url === 'string' ? input.url : call.title, reason: call.title };
  return {
    kind: 'other',
    tool: call.title || call.kind || 'tool',
    detail: summarizeInput(input, { wholePaths: true }) ?? acpContentText(call.content),
    reason: call.title,
  };
}

// --- Session updates ---------------------------------------------------------------------------

/** What its tools are called in the chat: by kind, else its title. */
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

/** A command's output as Copilot reports it, without the line it ends with (`<shellId: 0 completed with exit code 0>`). */
export function copilotCommandOutput(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n?<shellId: [^>]*>\s*$/, '');
}

/** The exit code a finished command's `rawOutput` gives (`contents[{ type: "shell_exit", exitCode }]`). */
export function copilotExitCode(rawOutput: unknown): number | undefined {
  const contents = (rawOutput as { contents?: unknown } | undefined)?.contents;
  if (!Array.isArray(contents)) return undefined;
  const exit = contents.find((c: any) => c?.type === 'shell_exit' && typeof c.exitCode === 'number');
  return exit?.exitCode;
}

const DONE = new Set(['completed', 'failed', 'cancelled', 'rejected']);

/**
 * Whether a reply chunk that starts a text block is one of Copilot's own notices, which it sends as
 * reply text (`Info: …`, one line): not the model's. Its errors (`Error: … hook … failed`) are kept, so
 * the user sees them.
 */
export function copilotNotice(text: string): boolean {
  return /^Info: [^\n]*$/.test(text.trim());
}

/** One call's latest kind, title, input and location, which arrive over several updates. */
interface CallState {
  kind?: string;
  title?: string;
  rawInput?: Record<string, any>;
  locations?: { path?: string }[];
}

/** Turns Copilot's ACP `session/update` payloads into AgentEvents. */
export function createCopilotUpdateHandler(emit: (e: AgentEvent) => void) {
  const calls = new Map<string, CallState>();
  const open = new Set<string>();
  const ended = new Set<string>();
  const refused = new Map<string, string>();
  /** Copilot's own error lines (`Error: …`), held until the turn ends: its failure, or text after all. */
  const errors: string[] = [];
  let inText = false;
  /**
   * A block's first chunk that reads like one of Copilot's own lines ("Info: …", "Error: …"). Copilot
   * sends those as a block of their own, followed by a tool call or the turn's end; a model reply that
   * begins with the same words goes on in the same block. So what it is shows with the next update.
   */
  let held: string | undefined;
  const ownLine = (text: string) => copilotNotice(text) || /^Error: /.test(text.trim());
  /** The held line is the model's text after all (`asText`), else Copilot's: a notice is dropped, an error kept. */
  const settle = (asText: boolean) => {
    if (held === undefined) return;
    const text = held;
    held = undefined;
    if (asText) {
      inText = true;
      emit({ type: 'text', text });
    } else if (!copilotNotice(text)) errors.push(text.trim());
  };

  const closeText = () => {
    settle(false);
    if (inText) {
      inText = false;
      emit({ type: 'text_end' });
    }
  };

  const remember = (id: string, u: Record<string, any>): CallState => {
    const c = calls.get(id) ?? {};
    if (typeof u.kind === 'string') c.kind = u.kind;
    if (typeof u.title === 'string' && u.title) c.title = u.title;
    if (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length && !c.rawInput) c.rawInput = u.rawInput;
    if (Array.isArray(u.locations) && u.locations.length) c.locations = u.locations;
    calls.set(id, c);
    return c;
  };

  const detailOf = (c: CallState): string | undefined => {
    if (c.kind === 'execute') return clip(copilotCommand(c));
    const path = copilotPaths(c)[0];
    if (path) return clipPath(path);
    return summarizeInput(c.rawInput) ?? (c.title ? clip(c.title) : undefined);
  };

  const start = (id: string, c: CallState) => {
    open.add(id);
    const detail = detailOf(c);
    const kind = toolCallKind(c.kind);
    emit({ type: 'tool_start', id, name: KIND_NAME[c.kind ?? ''] ?? (c.title || 'tool'), ...(detail ? { detail } : {}), ...(kind ? { kind } : {}) });
  };

  const finish = (id: string, c: CallState, u: Record<string, any>) => {
    open.delete(id);
    ended.add(id);
    const out = u.rawOutput && typeof u.rawOutput === 'object' ? (u.rawOutput as Record<string, any>) : undefined;
    const command = c.kind === 'execute';
    const code = command ? copilotExitCode(out) : undefined;
    const raw = typeof out?.content === 'string' ? out.content : (acpContentText(u.content) ?? (typeof out?.message === 'string' ? out.message : ''));
    const printed = raw ? (command ? copilotCommandOutput(raw) : raw) : '';
    const why = refused.get(id);
    const ok = u.status === 'completed' && !why && (code === undefined || code === 0);
    // A refused call's text is Copilot's own ("The user rejected this tool call."): the reason shown is ours.
    const output = printed.trim() && (ok || command) && !why ? tailText(printed) : undefined;
    const error = ok
      ? undefined
      : (why ?? (code !== undefined && code !== 0 ? t().copilotExitCode(code) : typeof out?.message === 'string' ? out.message : printed.trim() ? tailText(printed, 500) : undefined));
    emit({ type: 'tool_end', id, ok, ...(error ? { error } : {}), ...(output ? { output } : {}) });
  };

  function handle(u: Record<string, any> | undefined): void {
    if (!u) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = u.content?.text;
        if (typeof text !== 'string' || !text) break;
        // Copilot's own notices come as reply text, each a block of its own ("Info: <file it created>",
        // "Info: Operation cancelled by user"): not the model's words. Held until the next update says.
        if (!inText && ownLine(text)) {
          settle(false); // one right after another: both Copilot's
          held = text;
          break;
        }
        settle(true);
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
        settle(false);
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
        // A call Copilot reports only once it is over (refused before it started) gets its row too.
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
    /**
     * The turn is over. Its error lines are why it failed when it reports no usage (a model call that
     * failed: `Error: Could not connect to …`, the service's refusal), else they are shown as its text.
     */
    finish(usage: boolean): string | undefined {
      closeText();
      if (!errors.length) return undefined;
      if (!usage) return errors.join('\n');
      for (const text of errors.splice(0)) {
        emit({ type: 'text', text });
        emit({ type: 'text_end' });
      }
      return undefined;
    },
  };
}

// --- The runner --------------------------------------------------------------------------------

/** The label under a call the user declined (Copilot takes no message with a refusal, and ends its turn). */
function declinedLabel(note?: string): string {
  return `${note ? `${t().approvalDeclined} ${note}` : t().approvalDeclined}${t().copilotEndsTurn}`;
}

/** A session Copilot would not open with the reasoning effort given (its model takes none): nothing was shown yet. */
export class CopilotEffortRefused extends AgentRunError {}

/** Its policy lets commands write where the run did not make read-only (`copilotDevWrites`): nothing was sent yet. */
export class CopilotMoreReadOnly extends AgentRunError {
  constructor(readonly paths: string[]) {
    super(`writable by its dev-tool access: ${paths.join(', ')}`);
  }
}

/** Whether an error opening a session is Copilot refusing the reasoning effort for its model. */
export function copilotEffortRefusal(message: string): boolean {
  return /does not support reasoning[ _]effort/i.test(message);
}

/** Whether an error opening a session is Copilot saying it is signed out. */
export function copilotSignedOut(message: string): boolean {
  return /^Authentication required\b|not (logged|signed) in to (GitHub|Copilot)|copilot login\b/i.test(message.trim());
}

export const copilotRunner: AgentRunner = {
  provider: 'copilot',
  async run(given): Promise<RunResult> {
    if (given.signal.aborted) throw new AgentRunError(t().stopped, true);
    // On the user's own endpoint: its BYOK variables, the model as the endpoint names it, and an effort it takes.
    const endpoint = endpointRunModel(given.backends, given.model, PROVIDER_LABEL.copilot);
    const o = endpoint ? { ...given, model: endpoint.model } : given;
    const protectedPaths = o.permission === 'full' ? [] : (o.protectedPaths ?? protectedReads());
    // A path its sandbox would read as a pattern would be left unprotected: the run does not start.
    const pattern = patternPath(protectedPaths);
    if (pattern) throw new AgentRunError(t().protectedPattern(pattern));
    const projectHooks = await copilotProjectGate(o);
    // What it may read besides the working directories (only folders that exist: bubblewrap refuses a missing one).
    const baseReadDirs =
      o.permission === 'full'
        ? []
        : [...new Set([...(o.readDirs ?? []), ...(o.attachmentsDir ? [o.attachmentsDir] : []), ...copilotReadOnlyPaths([o.cwd, ...(o.addDirs ?? [])], o.env)])].filter((p) =>
            existsSync(p),
          );
    const policy = (more: readonly string[]): CopilotRunPolicy => ({
      permission: o.permission,
      addDirs: o.addDirs,
      readDirs: [...new Set([...baseReadDirs, ...more])],
      protectedPaths,
      nativeOff: o.nativeOff,
      nativeItems: o.nativeItems,
      onEndpoint: Boolean(endpoint),
    });
    const effort = endpoint ? endpointEffort('copilot', o.effort) : o.effort?.trim() || undefined;
    const args = (withEffort: boolean) =>
      copilotArgs({
        permission: o.permission,
        addDirs: o.addDirs,
        nativeOff: o.nativeOff,
        nativeItems: o.nativeItems,
        model: endpoint ? undefined : o.model?.trim() || undefined,
        effort: withEffort ? effort : undefined,
      });
    const prepare = (prep: () => CopilotRun): CopilotRun => {
      try {
        return prep();
      } catch (err) {
        throw new AgentRunError(t().copilotConfigFailed((err as Error).message));
      }
    };
    let withEffort = Boolean(effort);
    let more: string[] = [];
    let checked = o.permission === 'full';
    for (;;) {
      const p = policy(more);
      const run = prepare(() => prepareCopilotRun(copilotHome(o.env), p, o.systemPrompt));
      try {
        const how = { protectedPaths, readOnly: p.readDirs ?? [], onEndpoint: Boolean(endpoint) };
        // Its sandbox checked before a session that would run something by itself (hooks) opens.
        if (!checked && copilotStartsSomething(run.dir, projectHooks)) {
          const home = prepare(() => prepareCopilotPolicyHome(copilotHome(o.env), p));
          try {
            const bare = { ...o, cwd: home.cwd!, sessionId: undefined, mcpServers: [], images: [] };
            await copilotTurn(bare, copilotArgs({ permission: o.permission, addDirs: o.addDirs, nativeOff: ALL_PARTS }), copilotEnv(o.env, home.dir, ALL_PARTS, endpoint), {
              ...how,
              policyOnly: true,
            });
          } finally {
            home.done();
          }
          checked = true;
        }
        return await copilotTurn(o, args(withEffort), copilotEnv(o.env, run.dir, o.nativeOff, endpoint), how);
      } catch (err) {
        // A model that takes no reasoning effort refuses to open a session with one: it runs at its own.
        if (err instanceof CopilotEffortRefused && withEffort) {
          withEffort = false;
          continue;
        }
        // Its dev-tool access lets commands write a cache the run did not make read-only: again, with it read-only.
        if (err instanceof CopilotMoreReadOnly) {
          const added = err.paths.filter((x) => !more.includes(x));
          if (!added.length) throw new AgentRunError(t().copilotSandbox(err.message));
          more = [...more, ...added];
          continue;
        }
        throw err;
      } finally {
        run.done();
      }
    }
  },
};

/** How a turn goes besides its options: what the run made read-only, and whether it only checks the sandbox. */
interface CopilotTurnHow {
  protectedPaths: readonly string[];
  /** What its sandbox keeps read-only (the settings' `readonlyPaths`). */
  readOnly: readonly string[];
  onEndpoint: boolean;
  /** Only open a session and check its sandbox: no prompt, no session for the conversation. */
  policyOnly?: boolean;
}

/** One Copilot turn over ACP, in its run's home (set in `env`). */
async function copilotTurn(o: RunOptions, args: string[], env: NodeJS.ProcessEnv, how: CopilotTurnHow): Promise<RunResult> {
  const { protectedPaths, onEndpoint } = how;
  let child: ChildProcess | undefined;
  let sessionId: string | undefined;
  let userAborted = false;
  /** Until `session/new` or `session/load` answers, its updates are not this turn's (a load replays the session). */
  let opening = true;
  /** While its sandbox policy is asked for, its reply is collected here, not shown. */
  let policy: string[] | undefined;
  /** Something that only the model does happened while the policy was asked for (a tool call, a permission request). */
  let policyReachedModel = false;
  const stop = new AbortController();
  const stopSoon = (ms: number) => setTimeout(() => stop.abort(), ms).unref();

  const conn = new JsonRpcConnection((line) => child?.stdin?.write(line + '\n'));
  const updates = createCopilotUpdateHandler(o.onEvent);
  conn.onNotification = (method, params) => {
    if (method !== 'session/update' || opening) return;
    if (!sessionId || params?.sessionId !== sessionId) return;
    const u = params?.update;
    if (policy) {
      if (u?.sessionUpdate === 'agent_message_chunk' && typeof u.content?.text === 'string') policy.push(u.content.text);
      if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update' || u?.sessionUpdate === 'agent_thought_chunk') policyReachedModel = true;
      return;
    }
    updates.handle(u);
  };
  conn.onRequest = async (method, params) => {
    if (method !== 'session/request_permission') throw new RpcError(-32601, `${method} is not supported`);
    const options: { optionId: string; kind: string }[] = Array.isArray(params?.options) ? params.options : [];
    // While its sandbox is checked, nothing runs: the check went to the model, which it never should.
    if (policy) {
      policyReachedModel = true;
      return answerPermission({ allow: false, reason: '' }, options.filter((x) => x.kind !== 'reject_always'));
    }
    const call = (params?.toolCall ?? {}) as CopilotToolCall;
    const verdict = copilotPermissionDecision(o.permission, call, o.cwd, o.addDirs, protectedPaths);
    let decision: AcpDecision;
    let label = `${t().copilotRefused}${t().copilotEndsTurn}`;
    if (verdict.run === 'allow') decision = { allow: true };
    else if (verdict.run === 'refuse') {
      decision = { allow: false, reason: verdict.reason };
      label = `${verdict.reason}${t().copilotEndsTurn}`;
    } else if (o.requestApproval) {
      const answer = await o.requestApproval(copilotApprovalRequest(o.permission, call, o.cwd, o.addDirs));
      decision = answer.allow ? { allow: true } : { allow: false, reason: answer.note ?? '' };
      label = declinedLabel(answer.note);
    } else decision = { allow: false, reason: 'Not covered by the permission' };
    if (!decision.allow && call.toolCallId) updates.refused(call.toolCallId, label);
    // Never "always": Copilot would save the rule.
    return answerPermission(decision, options.filter((x) => x.kind !== 'allow_always' && x.kind !== 'reject_always'));
  };

  const onAbort = () => {
    userAborted = true;
    if (sessionId) conn.notify('session/cancel', { sessionId });
    stopSoon(2000);
  };
  o.signal.addEventListener('abort', onAbort, { once: true });

  const exited = runProcess({
    bin: o.bin,
    args,
    cwd: o.cwd, // Copilot reads its instruction files (AGENTS.md, .github/…) from the folder it starts in up to the repository's root
    env,
    signal: stop.signal,
    timeoutMs: TURN_TIMEOUT_MS,
    keepStdinOpen: true,
    onSpawn: (c) => (child = c),
    onLine: conn.handleLine,
  }).then(
    (res) => {
      conn.close(new AgentRunError(res.timedOut ? t().timedOut : tail(res.stderr) || t().exitedWithoutTurn('copilot', res.code)));
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
    const mcpServers = how.policyOnly ? [] : acpMcpServers(o.mcpServers ?? [], Boolean(caps.mcpCapabilities?.http), 'copilot');
    const signIn = (err: unknown): never => {
      const message = err instanceof Error ? err.message : String(err);
      if (copilotEffortRefusal(message)) throw new CopilotEffortRefused(message);
      if (!onEndpoint && copilotSignedOut(message)) throw new AgentRunError(t().copilotSignIn(message));
      throw err instanceof AgentRunError ? err : new AgentRunError(message);
    };
    let opened: any;
    if (o.sessionId) {
      sessionId = o.sessionId;
      opened = await conn.request('session/load', { sessionId, cwd: o.cwd, mcpServers }).catch(signIn);
    } else {
      opened = await conn.request('session/new', { cwd: o.cwd, mcpServers }).catch(signIn);
      sessionId = String(opened?.sessionId ?? '');
      if (!sessionId) throw new AgentRunError(t().copilotNoSession);
    }
    opening = false;
    if (!how.policyOnly) o.onEvent({ type: 'session', sessionId });
    if (userAborted) throw new AgentRunError(t().stopped, true);

    // Its agent mode and allow-all as the permission says, before anything else is sent.
    await setCopilotOptions(conn, sessionId, opened, o);

    if (o.permission !== 'full') {
      // Its sandbox must be what the run set up, or no command of it may run: asked without the model.
      policy = [];
      const checked = await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/sandbox policy' }] });
      const text = policy.join('');
      policy = undefined;
      // Answered by Copilot itself, never by its model (which reports usage, and could call tools).
      if (policyReachedModel || checked?.usage) throw new AgentRunError(t().copilotSandbox('/sandbox policy reached the model'));
      const problem = copilotPolicyProblem(text, { protectedPaths, addDirs: o.addDirs });
      if (problem) throw new AgentRunError(t().copilotSandbox(problem));
      if (userAborted) throw new AgentRunError(t().stopped, true);
      const more = copilotDevWrites(text, how.readOnly, copilotTempDirs(o.env));
      if (more.length) throw new CopilotMoreReadOnly(more);
    }
    if (how.policyOnly) return { sessionId };

    const result = await conn.request('session/prompt', { sessionId, prompt: acpPrompt(o.prompt, caps.promptCapabilities?.image ? o.images : []) });
    const failed = updates.finish(Boolean(result?.usage));
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (failed) throw new AgentRunError(failed);
    if (result?.stopReason === 'cancelled') throw new AgentRunError(t().copilotCancelled);
    // The turn's: one process per turn, and its count starts when the process opens the session.
    return { sessionId, ...acpTokens(result?.usage) };
  } catch (err) {
    if (userAborted) throw new AgentRunError(t().stopped, true);
    if (err instanceof AgentRunError) throw err;
    throw new AgentRunError(err instanceof Error ? err.message : String(err));
  } finally {
    opening = false;
    o.signal.removeEventListener('abort', onAbort);
    child?.stdin?.end(); // copilot exits when its stdin closes
    stopSoon(3000);
    await exited.catch(() => undefined);
  }
}

/** A session's config option by id. */
const option = (opts: any[] | undefined, id: string) => (Array.isArray(opts) ? opts.find((c) => c?.id === id) : undefined);

/** A config option's values. */
export const copilotOptionValues = (o: any): string[] =>
  Array.isArray(o?.options) ? o.options.map((x: any) => (typeof x?.value === 'string' ? x.value : '')).filter(Boolean) : [];

/** Copilot's agent mode (`mode`): its plan and autopilot modes are not Harness Relay's (autopilot allows everything). */
export const COPILOT_AGENT_MODE = 'https://agentclientprotocol.com/protocol/session-modes#agent';

/**
 * Puts the session in Copilot's agent mode and allow-all as the permission says (a resumed session
 * keeps what it had: autopilot turns allow-all on), each only when it differs. The model and effort
 * were given as flags.
 */
async function setCopilotOptions(conn: JsonRpcConnection, sessionId: string, opened: any, o: RunOptions): Promise<void> {
  let opts: any[] | undefined = opened?.configOptions;
  const set = async (configId: string, value: string, rejected: (value: string, err: string) => string) => {
    const r = await conn.request('session/set_config_option', { sessionId, configId, value }).catch((err: Error) => {
      throw new AgentRunError(rejected(value, err.message));
    });
    if (Array.isArray(r?.configOptions)) opts = r.configOptions;
  };
  const mode = option(opts, 'mode')?.currentValue ?? opened?.modes?.currentModeId;
  if (mode !== undefined && mode !== COPILOT_AGENT_MODE) await set('mode', COPILOT_AGENT_MODE, (_v, err) => t().copilotRejectedMode(err));
  const allowAll = o.permission === 'full' ? 'on' : 'off';
  const current = option(opts, 'allow_all')?.currentValue;
  // Below full access, an allow-all it does not report could be on (a session resumed from full access):
  // nothing would be asked, so the turn does not run.
  if (current === undefined && o.permission !== 'full') throw new AgentRunError(t().copilotRejectedMode('its allow-all option is not reported'));
  if (current !== undefined && current !== allowAll) await set('allow_all', allowAll, (_v, err) => t().copilotRejectedMode(err));
}

// --- Sign-out and models -----------------------------------------------------------------------

/**
 * Signs Copilot out (its ACP `logout`), in the account's home. Resolves once Copilot answered; fails
 * with what went wrong otherwise.
 */
export async function copilotLogout(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<void> {
  let error: string | undefined;
  let done = false;
  const failed = (msg: Record<string, any>) => String(msg.error?.data?.message ?? msg.error?.message ?? 'error');
  const res = await converse({
    bin,
    args: ['--acp'],
    cwd: homedir(),
    env: copilotProbeEnv(env),
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

/** A model Copilot offers: its id, name, and the reasoning efforts the session's option gives it (the current model's only). */
export interface CopilotModel {
  id: string;
  label?: string;
}

/** The models of a `session/new` answer (`models.availableModels`), each once (it lists Auto twice). */
export function parseCopilotModels(opened: unknown): { models: CopilotModel[]; current?: string; efforts: string[]; effort?: string } {
  const m = (opened as { models?: { availableModels?: unknown; currentModelId?: unknown } } | undefined)?.models;
  const list = Array.isArray(m?.availableModels) ? m.availableModels : [];
  const models: CopilotModel[] = [];
  for (const x of list) {
    const id = typeof x?.modelId === 'string' ? x.modelId : '';
    if (!id || models.some((y) => y.id === id)) continue;
    const label = typeof x?.name === 'string' && x.name && x.name !== id ? x.name : undefined;
    models.push({ id, ...(label ? { label } : {}) });
  }
  const effort = option((opened as { configOptions?: any[] } | undefined)?.configOptions, 'reasoning_effort');
  return {
    models,
    ...(typeof m?.currentModelId === 'string' ? { current: m.currentModelId } : {}),
    efforts: copilotOptionValues(effort),
    ...(typeof effort?.currentValue === 'string' ? { effort: effort.currentValue } : {}),
  };
}

/**
 * Asks Copilot for its models the way Harness Relay runs it: `initialize`, then `session/new` in an
 * empty folder of a home of its own (`prepareCopilotProbeHome`), so no project's hooks run and the
 * session is not kept.
 */
export async function askCopilotModels(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<{ opened?: unknown; error?: string }> {
  const probe = prepareCopilotProbeHome(copilotHome(env));
  try {
    let opened: unknown;
    let error: string | undefined;
    const failed = (msg: Record<string, any>) => String(msg.error?.data?.message ?? msg.error?.message ?? 'error');
    const cwd = probe.cwd!;
    const res = await converse({
      bin,
      args: ['--acp'],
      cwd,
      env: copilotProbeEnv(env, probe.dir),
      timeoutMs,
      open: (write) => write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }),
      onMessage: (msg, write, finish) => {
        if (msg.method !== undefined) return;
        if (msg.error) {
          error = failed(msg);
          finish();
        } else if (msg.id === 1) write({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
        else if (msg.id === 2) {
          opened = msg.result;
          finish();
        }
      },
    });
    return { opened, error: error ?? (opened ? undefined : res.timedOut ? t().timedOut : tail(res.stderr, 200) || undefined) };
  } finally {
    probe.done();
  }
}
