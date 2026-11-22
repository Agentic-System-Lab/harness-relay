import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { reservedMcpName } from './gateway';
import { commitPatternError, hasRules, tidyFolder, tidyPattern } from '../shared/checks';
import {
  ACCOUNT_ID_RE,
  AGENT_LIMITS,
  API_BACKENDS,
  BACKEND_LIMITS,
  CHECK_LIMITS,
  CWD_MISSING,
  ENDPOINT_ID_RE,
  GROUP_LIMITS,
  LAB_MODES,
  MAX_CWDS,
  MAX_ACCOUNT_LABEL,
  MCP_NAME_RE,
  MAX_NATIVE_ITEM_ID,
  MAX_NATIVE_ITEMS,
  MEMORY_SCOPES,
  RELAY_TOOL_GROUPS,
  NATIVE_ITEM_KINDS,
  NATIVE_ON_PARTS,
  NATIVE_PARTS,
  PROVIDERS,
  SCHEDULE_KINDS,
  SCHEDULE_LIMITS,
  WATCH_LIMITS,
  OAUTH_PROVIDERS,
  OAUTH_USES,
  TOOL_LIMITS,
  VOICE_LANGUAGES,
  agentLimitValid,
  cwdSettings,
  cliSubModelId,
  parseBackendModel,
  parseCliSubModel,
  PROVIDER_LABEL,
  VOICE_MODELS,
  type AgentConfig,
  type AlertPrefs,
  type ApiBackend,
  type CheckCommand,
  type CheckHook,
  type CheckList,
  type ConversationGroup,
  type ConversationSettings,
  type LabSettings,
  type LeadAgentSettings,
  type McpServerUpdate,
  type MemoryScope,
  type ModelEndpointUpdate,
  type Mode,
  type Permission,
  type Provider,
  type RelayToolGroup,
  type CalendarAccountUpdate,
  type MailAccountUpdate,
  type MailServer,
  CONNECTOR_LIMITS,
  type ProviderAccountUpdate,
  type ProviderSettingsUpdate,
  type PushSubscriptionJson,
  type ScheduleRepeat,
  type ScheduleTrigger,
  type OAuthClientUpdate,
  type OAuthProviderId,
  type OAuthUse,
  type ScheduleUpdate,
  type ToolLibraryUpdate,
  type VoiceLanguage,
  type VoiceModelId,
  type VoiceSettingsUpdate,
  type InboxReadRequest,
} from '../shared/types';
import { filePattern, mailFolder, parseTime, repoName, sameTriggers, validBranch, validRepo, validTimeZone } from '../shared/schedule';
import { CONFIG } from './config';
import { HttpError } from './errors';
import { isOtherGroupName, t } from './i18n';
import { apiPort } from './ports';
import { isLocalHost, isLoopbackHost, localAddresses, relayPorts } from './relaySandbox';
import { validAddress } from './connectors/mime';
import { endpointProblem, subscriptionKeys } from './push';
import { MODEL_LIMIT_RANGE, validContext, validOutput } from '../shared/modelLimits';
import type { TokenLimits } from '../shared/types';

const MODES: Mode[] = ['roundtable', 'parallel', 'relay'];
const PERMISSIONS: Permission[] = ['read-only', 'edit', 'full'];
export const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

function bad(msg: string): never {
  throw new HttpError(400, msg);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** A path from user input: `~` is the home folder (`~/` or, on Windows, `~\`); relative paths start at the server's folder. */
/**
 * Two folders are the same one, written differently: `~`, a trailing slash, `..`, a symlink (such as
 * macOS's /tmp), or letter case where the filesystem ignores it.
 */
export function sameFolder(a: string, b: string): boolean {
  const real = (p: string) => {
    const full = expandPath(p);
    try {
      return realpathSync(full);
    } catch {
      return full; // not there (yet)
    }
  };
  return foldCase(real(a)) === foldCase(real(b));
}

export function expandPath(p: string): string {
  const t = p.trim();
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) return resolve(homedir(), t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(process.cwd(), t);
}

/**
 * A working directory. A missing one is a 404 with the code `CWD_MISSING`, so
 * the client can offer to create it; with `create` it is created (parents too).
 */
function directory(dir: string, create: boolean): string {
  return directories([dir], create)[0]!;
}

/**
 * Working directories, as `directory()` takes one. Each must be a folder; when any is missing, the
 * 404 names all that are (`paths`), and with `create` all of them are created. Nothing is created
 * while another is not a folder.
 */
function directories(dirs: string[], create: boolean): string[] {
  const missing: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) missing.push(dir);
    else if (!statSync(dir).isDirectory()) bad(t().cwdNotDirectory(dir));
  }
  if (missing.length && !create) throw new HttpError(404, t().cwdMissing(missing.join(', ')), CWD_MISSING, missing);
  for (const dir of missing) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      bad(t().cwdCreateFailed(dir, (e as NodeJS.ErrnoException).code ?? (e as Error).message));
    }
  }
  return dirs;
}

/** A directory from user input (`~` expanded); see `directory()` for a missing one. */
export function validDirectory(input: unknown, create = false): string {
  if (typeof input !== 'string' || !input.trim()) bad(t().invalidField('defaultCwd'));
  return directory(expandPath(input), create);
}

/**
 * Working directories from user input: `cwd` and the others after it (`extra`; `~` expanded, the
 * empty ones left out), at most `MAX_CWDS` and each once (the same folder by another spelling,
 * through a link, or in another case where the filesystem ignores it, counts too). See
 * `directories()` for missing ones.
 */
export function validDirectories(cwd: unknown, extra: unknown, create = false, field = 'cwd'): { cwd: string; extraCwds?: string[] } {
  if (typeof cwd !== 'string' || !cwd.trim()) bad(t().invalidField(field));
  if (extra !== undefined && (!Array.isArray(extra) || extra.some((d) => typeof d !== 'string'))) bad(t().invalidField('extraCwds'));
  const dirs = [cwd, ...((extra as string[] | undefined) ?? [])].filter((d) => d.trim()).map(expandPath);
  if (dirs.length > MAX_CWDS) bad(t().tooManyCwds(MAX_CWDS));
  dirs.forEach((dir, i) => {
    const same = dirs.slice(0, i).find((d) => sameFolder(d, dir));
    if (same) bad(t().cwdTwice(dir));
  });
  return cwdSettings(directories(dirs, create));
}

/** Folder names compare ignoring case where the filesystem usually does (macOS, Windows). */
export const foldCase = (p: string) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);

function samePath(a: string, b: string): boolean {
  return foldCase(resolve(a)) === foldCase(resolve(b));
}

/** `child` is `parent` or lies inside it. */
function isInside(child: string, parent: string): boolean {
  const r = relative(foldCase(resolve(parent)), foldCase(resolve(child)));
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/**
 * The folder for the CLIs' own homes (not created yet: see `ensureFolder`); empty = off. It must be
 * an absolute or `~` path, not the home folder or a root (the CLIs' subfolders would sit loose
 * in it), and not inside `outside` (Harness Relay's own folder, the default working directory):
 * a working directory's snapshots would then take in the CLIs' sign-ins and transcripts.
 */
export function validAgentHome(input: unknown, outside: string[] = []): string {
  if (typeof input !== 'string' || input.length > 4096) bad(t().invalidField('agentHome'));
  const raw = input.trim();
  if (!raw) return '';
  if (!(raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') || isAbsolute(raw))) bad(t().agentHomeNotAbsolute(raw));
  const dir = expandPath(raw);
  if (samePath(dir, homedir()) || samePath(dir, parse(dir).root)) bad(t().agentHomeTooBroad(dir));
  for (const folder of outside) {
    // A working directory as broad as the home folder or a root is refused by itself (workspace.ts).
    if (!folder || samePath(folder, homedir()) || samePath(folder, parse(folder).root)) continue;
    if (isInside(dir, folder)) bad(t().agentHomeInside(dir, folder));
  }
  if (existsSync(dir) && !statSync(dir).isDirectory()) bad(t().cwdNotDirectory(dir));
  return dir;
}

/** Creates a folder (and its parents) readable by the owner only, when missing. */
export function ensureFolder(dir: string): void {
  if (existsSync(dir)) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    bad(t().agentHomeCreateFailed(dir, (e as NodeJS.ErrnoException).code ?? (e as Error).message));
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * AgentsView's address: http(s) on this computer only, since conversations are sent there. Empty =
 * off. Returns the origin (scheme, host and port).
 */
export function validAgentsViewUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) bad(t().invalidField('agentsViewUrl'));
  const raw = input.trim();
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    bad(t().agentsViewUrlInvalid(raw));
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !LOOPBACK_HOSTS.has(url.hostname)) {
    bad(t().agentsViewUrlInvalid(raw));
  }
  return url.origin;
}

/**
 * Where "Open AgentsView" goes: any http(s) address without credentials (it is only shown as a
 * link, nothing is sent there), such as the one `tailscale serve` gives AgentsView. Empty = off.
 */
export function validAgentsViewLink(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) bad(t().invalidField('agentsViewLink'));
  const raw = input.trim();
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    bad(t().agentsViewLinkInvalid(raw));
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) bad(t().agentsViewLinkInvalid(raw));
  return url.href;
}

function optionalString(v: unknown, field: string, max = 500): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) bad(t().invalidField(field));
  return v.trim();
}

/**
 * The account an agent or the lead names: an account id, or undefined for the default account (also
 * for anything that is not an id). Whether the CLI has it is checked when it runs.
 */
function validAccount(input: unknown): { account?: string } {
  return typeof input === 'string' && ACCOUNT_ID_RE.test(input) ? { account: input } : {};
}

/** The lead agent (auto team) from a settings update. */
export function validateLead(input: unknown): LeadAgentSettings {
  const l = (input ?? {}) as Partial<LeadAgentSettings>;
  if (!PROVIDERS.includes(l.provider as Provider)) bad(t().unknownProvider(String(l.provider)));
  return {
    provider: l.provider as Provider,
    model: optionalString(l.model, 'lead.model') ?? '',
    effort: validEffort(optionalString(l.effort, 'lead.effort'), 'lead') ?? '',
    ...validAccount(l.account),
  };
}

/**
 * Settings → Labs: one of its modes; with RLM, its sub-model as `<backend>/<model>` on a model connection
 * set up now (`configured`: the API backends with a key and the endpoints, by id), or through one of the
 * accounts of a CLI of `SUB_MODEL_CLIS` (`cli:<provider>[:<account>][/<model>]`, `hasAccount`).
 */
export function validLabs(
  input: unknown,
  configured: readonly string[],
  hasAccount: (p: Provider, account: string) => boolean = () => false,
): LabSettings {
  const l = (input ?? {}) as Partial<LabSettings>;
  if (!(LAB_MODES as readonly unknown[]).includes(l.mode)) bad(t().labsBadMode);
  if (l.mode !== 'rlm') return { mode: l.mode as LabSettings['mode'] };
  const id = typeof l.rlmModel === 'string' ? l.rlmModel.trim() : '';
  if (!id) bad(t().labsNoModel);
  if (id.length > 300) bad(t().labsBadModel(id.slice(0, 40)));
  const cli = parseCliSubModel(id);
  if (cli) {
    if (!hasAccount(cli.provider, cli.account)) bad(t().labsNoCliAccount(PROVIDER_LABEL[cli.provider], cli.account));
    return { mode: 'rlm', rlmModel: cliSubModelId(cli) };
  }
  const parsed = parseBackendModel(id);
  if (!parsed) bad(t().labsBadModel(id));
  if (!configured.includes(parsed.backend)) bad(t().labsNoConnection(parsed.backend));
  return { mode: 'rlm', rlmModel: id };
}

/** An account's name: a string of up to `MAX_ACCOUNT_LABEL` characters, with no line breaks. */
export function validAccountLabel(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length > MAX_ACCOUNT_LABEL || /[\u0000-\u001f\u007f]/.test(input)) {
    bad(t().badAccountLabel(MAX_ACCOUNT_LABEL));
  }
  return input.trim();
}

/**
 * An account update: a name, its key (null to remove), and how it runs: strings, a valid effort,
 * `nativeOff` and `nativeOn` lists of known parts, `nativeItems` lists of ids by known kind.
 */
export function validateAccountUpdate(input: unknown): ProviderAccountUpdate {
  const u = (input ?? {}) as Record<string, unknown>;
  const out: ProviderAccountUpdate = {};
  if (u.label !== undefined) out.label = validAccountLabel(u.label);
  if (u.apiKey === null) out.apiKey = null;
  else {
    const key = optionalString(u.apiKey, 'apiKey', 4096);
    if (key !== undefined) out.apiKey = key;
  }
  const model = optionalString(u.defaultModel, 'defaultModel');
  if (model !== undefined) out.defaultModel = model;
  if (u.defaultEffort !== undefined) out.defaultEffort = validEffort(optionalString(u.defaultEffort, 'defaultEffort'), 'default') ?? '';
  if (u.nativeOff !== undefined) {
    const parts = u.nativeOff;
    if (!Array.isArray(parts) || parts.some((x) => !(NATIVE_PARTS as readonly unknown[]).includes(x))) bad(t().invalidField('nativeOff'));
    out.nativeOff = parts as ProviderAccountUpdate['nativeOff'];
  }
  if (u.nativeItems !== undefined) {
    const items = u.nativeItems as Record<string, unknown> | null;
    const valid =
      items !== null &&
      typeof items === 'object' &&
      !Array.isArray(items) &&
      Object.entries(items).every(
        ([kind, ids]) =>
          (NATIVE_ITEM_KINDS as readonly string[]).includes(kind) &&
          Array.isArray(ids) &&
          ids.length <= MAX_NATIVE_ITEMS &&
          ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_NATIVE_ITEM_ID),
      );
    if (!valid) bad(t().invalidField('nativeItems'));
    out.nativeItems = items as ProviderAccountUpdate['nativeItems'];
  }
  if (u.nativeOn !== undefined) {
    const parts = u.nativeOn;
    if (!Array.isArray(parts) || parts.some((x) => !(NATIVE_ON_PARTS as readonly unknown[]).includes(x))) bad(t().invalidField('nativeOn'));
    out.nativeOn = parts as ProviderAccountUpdate['nativeOn'];
  }
  return out;
}

export function validVoiceModel(input: unknown): VoiceModelId {
  if (!VOICE_MODELS.includes(input as VoiceModelId)) bad(t().invalidField('model'));
  return input as VoiceModelId;
}

/** A voice settings update: a known model and language, the engine path as a string. */
export function validateVoiceUpdate(input: unknown): VoiceSettingsUpdate {
  const u = (input ?? {}) as Record<string, unknown>;
  const out: VoiceSettingsUpdate = {};
  if (u.model !== undefined) out.model = validVoiceModel(u.model);
  if (u.language !== undefined) {
    if (!VOICE_LANGUAGES.includes(u.language as VoiceLanguage)) bad(t().invalidField('language'));
    out.language = u.language as VoiceLanguage;
  }
  const bin = optionalString(u.bin, 'bin', 4096);
  if (bin !== undefined) out.bin = bin;
  return out;
}

/**
 * A provider settings update: what a CLI has once for all its accounts (its executable, and whether
 * its commands may use a terminal in the relay sandbox: `sandboxTerminal`, a boolean), and the
 * default account's key (null to remove). Defaults and what runs leave out are each account's
 * (`validateAccountUpdate`); a request that still names them here is refused, not half applied.
 */
export function validateProviderUpdate(input: unknown): ProviderSettingsUpdate {
  const u = (input ?? {}) as Record<string, unknown>;
  for (const field of ['defaultModel', 'defaultEffort', 'nativeOff', 'nativeItems', 'nativeOn']) {
    if (u[field] !== undefined) bad(t().invalidField(field));
  }
  const out: ProviderSettingsUpdate = {};
  const bin = optionalString(u.bin, 'bin', 4096);
  if (bin !== undefined) out.bin = bin;
  if (u.apiKey === null) out.apiKey = null;
  else {
    const key = optionalString(u.apiKey, 'apiKey', 4096);
    if (key !== undefined) out.apiKey = key;
  }
  if (u.sandboxTerminal !== undefined) {
    if (typeof u.sandboxTerminal !== 'boolean') bad(t().invalidField('sandboxTerminal'));
    out.sandboxTerminal = u.sandboxTerminal;
  }
  return out;
}

function validEffort(v: unknown, name: string): string | undefined {
  const e = String(v ?? '').trim();
  if (!e) return undefined;
  if (!/^[a-z-]{1,16}$/.test(e)) bad(t().badEffort(name, e));
  return e;
}

/** A team's members, at least one and at most `max` (`RELAY_MAX_TEAM_AGENTS`, else 8). */
export function validateAgents(input: unknown, max = CONFIG.maxTeamAgents): AgentConfig[] {
  if (!Array.isArray(input) || input.length === 0) bad(t().needAgent);
  if (input.length > max) bad(t().tooManyAgents(max));
  const names = new Set<string>();
  const ids = new Set<string>();
  return input.map((raw, i) => {
    const a = (raw ?? {}) as Partial<AgentConfig>;
    const name = String(a.name ?? '')
      .trim()
      .replace(/^@/, '');
    if (!NAME_RE.test(name)) bad(t().badName(i + 1, name));
    if (name.toLowerCase() === 'user' || name.toLowerCase() === 'system') bad(t().reservedName(name));
    if (names.has(name.toLowerCase())) bad(t().duplicateName(name));
    names.add(name.toLowerCase());
    if (!PROVIDERS.includes(a.provider as never)) bad(t().badProvider(name));
    let id = String(a.id ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) id = randomUUID();
    ids.add(id);
    return {
      id,
      name,
      provider: a.provider!,
      role: String(a.role ?? '').slice(0, 8000),
      model: String(a.model ?? '').trim() || undefined,
      effort: validEffort(a.effort, name),
      ...validAccount(a.account),
      ...validAgentTools(a.tools),
      ...validAgentLimits(a.provider!, a.limits, name),
    };
  });
}

/**
 * A member's limits: only its CLI's own (`AGENT_LIMITS`), whose value must be one the CLI takes; any
 * other is dropped (one kept from another CLI the member was on, say). Null or none: no limit.
 */
function validAgentLimits(provider: Provider, input: unknown, name: string): Pick<AgentConfig, 'limits'> {
  const spec = AGENT_LIMITS[provider];
  if (!spec || !input || typeof input !== 'object' || Array.isArray(input)) return {};
  const v = (input as Record<string, unknown>)[spec.key];
  if (v === undefined || v === null) return {};
  if (!agentLimitValid(spec, v)) bad(t().badLimit(name, spec.min, spec.max));
  return { limits: { [spec.key]: v } };
}

/**
 * A member's tool library exception: the memory for everyone or for its CLI (any of PROVIDERS), an MCP
 * server, a skill, or one of Harness Relay's own tool groups (`relay:mail`, as the member's tool picker
 * offers them).
 */
const TOOL_KEY_RE = new RegExp(
  `^(memory|memory:(${PROVIDERS.join('|')})|mcp:[A-Za-z0-9_-]{1,40}|skill:[^\\0]{1,4000}|relay:(${RELAY_TOOL_GROUPS.join('|')}))$`,
);

/** The CLIs a library item is on for by default; absent = all of them. */
function validProviders(input: unknown, field: string): Provider[] {
  if (input === undefined || input === null) return [...PROVIDERS];
  if (!Array.isArray(input) || input.some((p) => !PROVIDERS.includes(p as Provider))) bad(t().invalidField(field));
  return PROVIDERS.filter((p) => input.includes(p));
}

/** An agent's tool exceptions: tool key -> boolean; anything else is dropped. */
function validAgentTools(input: unknown): { tools?: Record<string, boolean> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const tools: Record<string, boolean> = {};
  for (const [key, on] of Object.entries(input).slice(0, 200)) {
    if (typeof on === 'boolean' && TOOL_KEY_RE.test(key)) tools[key] = on;
  }
  return Object.keys(tools).length ? { tools } : {};
}

/** Names of environment variables and HTTP headers: no spaces, `=` or control characters. */
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/;

function validVars(input: unknown, field: string): { name: string; value?: string }[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) bad(t().invalidField(field));
  if (input.length > TOOL_LIMITS.maxVars) bad(t().invalidField(field));
  const seen = new Set<string>();
  return input.map((raw) => {
    const v = (raw ?? {}) as { name?: unknown; value?: unknown };
    const name = String(v.name ?? '').trim();
    if (!VAR_NAME_RE.test(name) || seen.has(name.toLowerCase())) bad(t().badVarName(name));
    seen.add(name.toLowerCase());
    if (v.value === undefined || v.value === null) return { name };
    if (typeof v.value !== 'string' || v.value.length > 8000 || /[\0\r\n]/.test(v.value)) bad(t().invalidField(field));
    return { name, value: v.value };
  });
}

/** The server's name (from the URL) and its settings. */
export function validateMcpServer(nameInput: unknown, input: unknown): { name: string; update: McpServerUpdate } {
  const name = String(nameInput ?? '').trim();
  if (!MCP_NAME_RE.test(name)) bad(t().badMcpName(name));
  // The gateway's own name, or one its tools' names start with (`relay_…`, as OpenCode joins a server's
  // name and its tool's): a library server called so would be left out of every turn that has the gateway.
  if (reservedMcpName(name)) bad(t().mcpNameReserved(name));
  const b = (input ?? {}) as Partial<Record<keyof McpServerUpdate, unknown>>;
  const transport = b.transport === 'http' ? 'http' : b.transport === 'stdio' ? 'stdio' : bad(t().invalidField('transport'));
  const update: McpServerUpdate = { transport, providers: validProviders(b.providers, 'providers') };
  if (transport === 'stdio') {
    const command = String(b.command ?? '').trim();
    if (!command || command.length > 1000 || /[\0\r\n]/.test(command)) bad(t().mcpNeedsCommand);
    update.command = command;
    if (b.args !== undefined && (!Array.isArray(b.args) || b.args.length > 100)) bad(t().invalidField('args'));
    update.args = ((b.args as unknown[] | undefined) ?? []).map((a) => {
      if (typeof a !== 'string' || a.length > 2000 || a.includes('\0')) bad(t().invalidField('args'));
      return a;
    });
    update.env = validVars(b.env, 'env') ?? [];
  } else {
    const url = String(b.url ?? '').trim();
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      /* reported below */
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) bad(t().mcpNeedsUrl);
    update.url = url;
    update.headers = validVars(b.headers, 'headers') ?? [];
  }
  if (b.previousName !== undefined && b.previousName !== null && b.previousName !== '') {
    const prev = String(b.previousName);
    if (!MCP_NAME_RE.test(prev)) bad(t().badMcpName(prev));
    update.previousName = prev;
  }
  return { name, update };
}

/** A folder (or SKILL.md) to look for skills in. */
export function validSkillPath(input: unknown): string {
  const path = String(input ?? '').trim();
  if (!path || path.length > 4000 || path.includes('\0')) bad(t().invalidField('path'));
  return expandPath(path);
}

export function validateToolLibraryUpdate(input: unknown): ToolLibraryUpdate {
  const b = (input ?? {}) as Partial<Record<keyof ToolLibraryUpdate, unknown>>;
  const out: ToolLibraryUpdate = {};
  if (b.memory !== undefined) {
    if (!b.memory || typeof b.memory !== 'object' || Array.isArray(b.memory)) bad(t().invalidField('memory'));
    const memory: Partial<Record<MemoryScope, string>> = {};
    for (const [scope, text] of Object.entries(b.memory)) {
      if (!MEMORY_SCOPES.includes(scope as MemoryScope) || typeof text !== 'string') bad(t().invalidField('memory'));
      if (text.length > TOOL_LIMITS.maxMemoryChars) bad(t().memoryTooLong(TOOL_LIMITS.maxMemoryChars));
      memory[scope as MemoryScope] = text;
    }
    out.memory = memory;
  }
  if (b.skills !== undefined) {
    if (!Array.isArray(b.skills) || b.skills.length > TOOL_LIMITS.maxSkills) bad(t().invalidField('skills'));
    out.skills = b.skills.map((raw) => {
      const s = (raw ?? {}) as { path?: unknown; providers?: unknown };
      const path = String(s.path ?? '').trim();
      if (!path || path.length > 4000 || path.includes('\0')) bad(t().invalidField('skills'));
      return { path: expandPath(path), providers: validProviders(s.providers, 'providers') };
    });
  }
  if (b.relayTools !== undefined) {
    if (!b.relayTools || typeof b.relayTools !== 'object' || Array.isArray(b.relayTools)) bad(t().invalidField('relayTools'));
    const groups: Partial<Record<RelayToolGroup, Provider[]>> = {};
    for (const [group, providers] of Object.entries(b.relayTools)) {
      if (!(RELAY_TOOL_GROUPS as readonly string[]).includes(group) || !Array.isArray(providers)) bad(t().invalidField('relayTools'));
      groups[group as RelayToolGroup] = validProviders(providers, 'relayTools');
    }
    out.relayTools = groups;
  }
  if (b.browser !== undefined) {
    if (typeof b.browser !== 'string' || b.browser.length > 4000 || b.browser.includes('\0')) bad(t().invalidField('browser'));
    const path = b.browser.trim();
    if (!path) out.browser = '';
    else {
      // A file there now, as the browser tools will start it; empty finds one by itself again.
      const full = expandPath(path);
      let file = false;
      try {
        file = statSync(full).isFile();
      } catch {
        /* none there */
      }
      if (!file) bad(t().browserNotFound(full));
      out.browser = full;
    }
  }
  return out;
}

/**
 * Conversation settings; with `create`, missing working directories are created. Without a `cwd`,
 * the working directories are `defaults` (the default ones, or a conversation's own).
 */
export function validateSettings(
  input: unknown,
  defaults: { cwd: string; extraCwds?: readonly string[] },
  create = false,
): ConversationSettings {
  const s = (input ?? {}) as Partial<ConversationSettings>;
  const given = typeof s.cwd === 'string' && s.cwd.trim() !== '';
  const dirs = validDirectories(given ? s.cwd : defaults.cwd, given ? s.extraCwds : defaults.extraCwds?.slice(), create);
  return {
    mode: MODES.includes(s.mode as Mode) ? (s.mode as Mode) : 'roundtable',
    rounds: clampInt(s.rounds, 1, 5, 1),
    maxHops: clampInt(s.maxHops, 1, 30, 8),
    permission: PERMISSIONS.includes(s.permission as Permission) ? (s.permission as Permission) : 'read-only',
    ...dirs,
    ...(s.autoTeam === true ? { autoTeam: true } : {}),
    ...(s.autoConfirm === true ? { autoConfirm: true } : {}),
    ...(s.leadReview === true ? { leadReview: true } : {}),
    ...(s.approvals === 'deny' ? { approvals: 'deny' as const } : {}),
    ...(s.steer === true ? { steer: true } : {}),
    ...(s.checks !== undefined && s.checks !== null ? { checks: validateChecks(s.checks) } : {}),
  };
}

/**
 * A team check list (`ConversationSettings.checks`): protected path patterns, each tidied and once
 * (`tidyPattern`), and a commit pattern JavaScript can read. Refuses what cannot be used, rather than
 * leave a rule out unseen. An empty list is kept: the conversation then has none, and a template's is
 * not copied into it.
 */
export function validateChecks(input: unknown): CheckList {
  if (typeof input !== 'object' || Array.isArray(input)) bad(t().invalidField('checks'));
  const c = input as Record<string, unknown>;
  const out: CheckList = {};
  if (c.protectedPaths !== undefined) {
    if (!Array.isArray(c.protectedPaths)) bad(t().invalidField('checks.protectedPaths'));
    const paths: string[] = [];
    for (const raw of c.protectedPaths) {
      if (typeof raw !== 'string') bad(t().invalidField('checks.protectedPaths'));
      if (!raw.trim()) continue;
      const tidy = tidyPattern(raw);
      if (!tidy) bad(t().checksBadPath(raw.trim().slice(0, CHECK_LIMITS.pattern)));
      if (!paths.includes(tidy)) paths.push(tidy);
    }
    if (paths.length > CHECK_LIMITS.protectedPaths) bad(t().checksTooManyPaths(CHECK_LIMITS.protectedPaths));
    if (paths.length) out.protectedPaths = paths;
  }
  if (c.commitPattern !== undefined) {
    if (typeof c.commitPattern !== 'string') bad(t().invalidField('checks.commitPattern'));
    const pattern = c.commitPattern.trim();
    if (pattern.length > CHECK_LIMITS.commitPattern) bad(t().checksCommitPatternTooLong(CHECK_LIMITS.commitPattern));
    const why = pattern ? commitPatternError(pattern) : undefined;
    if (why) bad(t().checksBadCommitPattern(why));
    if (pattern) out.commitPattern = pattern;
  }
  if (c.commands !== undefined) {
    if (!Array.isArray(c.commands)) bad(t().invalidField('checks.commands'));
    if (c.commands.length > CHECK_LIMITS.commands) bad(t().checksTooManyCommands(CHECK_LIMITS.commands));
    const commands: CheckCommand[] = [];
    for (const raw of c.commands) {
      const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const run = typeof r.run === 'string' ? r.run.trim() : '';
      if (!run) bad(t().checksCommandEmpty);
      if (run.length > CHECK_LIMITS.command) bad(t().checksCommandTooLong(CHECK_LIMITS.command));
      const cwd = r.cwd === undefined ? '' : typeof r.cwd === 'string' ? tidyFolder(r.cwd) : undefined;
      if (cwd === undefined) bad(t().checksBadFolder(String(r.cwd).slice(0, CHECK_LIMITS.folder)));
      let timeoutMin: number | undefined;
      if (r.timeoutMin !== undefined) {
        timeoutMin = Number(r.timeoutMin);
        if (!Number.isInteger(timeoutMin) || timeoutMin < 1 || timeoutMin > CHECK_LIMITS.maxTimeoutMin)
          bad(t().checksBadTimeout(CHECK_LIMITS.maxTimeoutMin));
      }
      // An id the list keeps for the command's results; a new command gets one (each once).
      const given = typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : undefined;
      const id = given && !commands.some((x) => x.id === given) ? given : randomUUID().slice(0, 8);
      commands.push({
        id,
        run,
        ...(cwd ? { cwd } : {}),
        ...(timeoutMin !== undefined && timeoutMin !== CHECK_LIMITS.timeoutMin ? { timeoutMin } : {}),
        ...(r.localPorts === true ? { localPorts: true } : {}),
        ...(r.unixSockets === true ? { unixSockets: true } : {}),
      });
    }
    if (commands.length) out.commands = commands;
  }
  if (c.hooks !== undefined) {
    if (!Array.isArray(c.hooks)) bad(t().invalidField('checks.hooks'));
    if (c.hooks.length > CHECK_LIMITS.hooks) bad(t().hooksTooMany(CHECK_LIMITS.hooks));
    const hooks: CheckHook[] = [];
    for (const raw of c.hooks) {
      const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (r.when !== 'before' && r.when !== 'after') bad(t().invalidField('checks.hooks.when'));
      if (r.tools !== 'command' && r.tools !== 'edit' && r.tools !== 'any') bad(t().invalidField('checks.hooks.tools'));
      const run = typeof r.run === 'string' ? r.run.trim() : '';
      if (!run) bad(t().checksCommandEmpty);
      if (run.length > CHECK_LIMITS.command) bad(t().checksCommandTooLong(CHECK_LIMITS.command));
      const cwd = r.cwd === undefined ? '' : typeof r.cwd === 'string' ? tidyFolder(r.cwd) : undefined;
      if (cwd === undefined) bad(t().checksBadFolder(String(r.cwd).slice(0, CHECK_LIMITS.folder)));
      let timeoutSec: number | undefined;
      if (r.timeoutSec !== undefined) {
        timeoutSec = Number(r.timeoutSec);
        if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > CHECK_LIMITS.maxHookTimeoutSec)
          bad(t().hooksBadTimeout(CHECK_LIMITS.maxHookTimeoutSec));
      }
      const given = typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : undefined;
      const id = given && !hooks.some((x) => x.id === given) ? given : randomUUID().slice(0, 8);
      hooks.push({
        id,
        when: r.when,
        tools: r.tools,
        run,
        ...(cwd ? { cwd } : {}),
        ...(timeoutSec !== undefined && timeoutSec !== CHECK_LIMITS.hookTimeoutSec ? { timeoutSec } : {}),
      });
    }
    if (hooks.length) out.hooks = hooks;
  }
  if (c.previewApp !== undefined && typeof c.previewApp !== 'boolean') bad(t().invalidField('checks.previewApp'));
  if (c.previewApp === true) out.previewApp = true;
  if (c.autoFix !== undefined && typeof c.autoFix !== 'boolean') bad(t().invalidField('checks.autoFix'));
  if (c.autoFix === true) out.autoFix = true;
  // Settings' default, unchanged since it was copied in (a list with rules only).
  if (c.fromDefault === true && hasRules(out)) out.fromDefault = true;
  return out;
}

/**
 * A group name: trimmed, spaces collapsed, not too long, and not the name of another group (`except`
 * is the one being renamed) or of the default group in any language, ignoring case.
 */
export function validGroupName(input: unknown, groups: ConversationGroup[], except?: string): string {
  const name = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) bad(t().groupNameRequired);
  if ([...name].length > GROUP_LIMITS.maxName) bad(t().groupNameTooLong(GROUP_LIMITS.maxName));
  const key = name.toLowerCase();
  if (isOtherGroupName(name) || groups.some((g) => g.id !== except && g.name.toLowerCase() === key)) bad(t().groupNameTaken(name));
  return name;
}

/** The time zone of the computer Harness Relay runs on. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function validRepeat(input: unknown, enabled: boolean, now: number): ScheduleRepeat {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const kind = r.kind as ScheduleRepeat['kind'];
  if (!SCHEDULE_KINDS.includes(kind)) bad(t().scheduleBadRepeat);
  const time = () => {
    const v = typeof r.time === 'string' ? r.time.trim() : '';
    if (!parseTime(v)) bad(t().scheduleBadTime);
    return v;
  };
  switch (kind) {
    case 'manual':
      return { kind };
    case 'once': {
      const at = Number(r.at);
      if (!Number.isSafeInteger(at) || at <= 0) bad(t().scheduleBadMoment);
      // A time that has passed would never send (a schedule kept off may keep it, to be changed later).
      if (enabled && at <= now) bad(t().scheduleInPast);
      return { kind, at };
    }
    case 'daily':
      return { kind, time: time() };
    case 'weekly': {
      const days = Array.isArray(r.days) ? r.days : [];
      if (days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) bad(t().scheduleNeedDays);
      const unique = [...new Set(days as number[])].sort((a, b) => a - b);
      if (!unique.length) bad(t().scheduleNeedDays);
      return { kind, time: time(), days: unique };
    }
    case 'interval': {
      const hours = Number(r.hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > SCHEDULE_LIMITS.maxHours) bad(t().scheduleBadHours(SCHEDULE_LIMITS.maxHours));
      return { kind, hours };
    }
    case 'event': {
      // One trigger alone, as automations were saved before they could wait for several things.
      const listed = Array.isArray(r.triggers) ? r.triggers : r.triggers === undefined && r.trigger !== undefined ? [r.trigger] : undefined;
      if (!listed) bad(t().watchBadTrigger);
      if (!listed.length || listed.length > WATCH_LIMITS.triggers) bad(t().watchTriggerCount(WATCH_LIMITS.triggers));
      const triggers = listed.map(validTrigger);
      if (sameTriggers(triggers)) bad(t().watchSameTrigger);
      return { kind, triggers };
    }
  }
}

/**
 * One of the things an automation that starts when something happens waits for (`ScheduleTrigger`;
 * 1 to `WATCH_LIMITS.triggers` of them, no two for the same source: `sameTriggers()`), each text a line
 * of at most `WATCH_LIMITS.field`:
 * - a new mail in a folder (the inbox when none is given, `INBOX` in any letter case: `mailFolder()`)
 *   of a mail account, by its id (that it exists is checked where the accounts are), with the words
 *   its sender and subject contain, when given;
 * - an event of a calendar, by its id, about to begin: 1 to `WATCH_LIMITS.maxMinutes` minutes before,
 *   with the words its title contains, when given;
 * - in a GitHub repository (`owner/name`): a pull request opened, or a CI run that failed (on a branch,
 *   when given, one git allows);
 * - a file in the working directory matching a pattern: relative, inside it (no `..`), not empty.
 * The browser's form checks the same (`src/shared/schedule.ts`).
 */
function validTrigger(input: unknown): ScheduleTrigger {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const line = (v: unknown, field: string): string => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string' || v.length > WATCH_LIMITS.field || /[\r\n\0]/.test(v)) bad(t().invalidField(field));
    return v.trim();
  };
  const id = (v: unknown): string => {
    const account = line(v, 'account');
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(account)) bad(t().watchBadTrigger);
    return account;
  };
  switch (r.source) {
    case 'mail': {
      const account = id(r.account);
      // The inbox in any letter case is the one inbox, written as IMAP names it.
      const folder = mailFolder(line(r.folder, 'folder') || 'INBOX');
      const from = line(r.from, 'from');
      const subject = line(r.subject, 'subject');
      return { source: 'mail', account, folder, ...(from ? { from } : {}), ...(subject ? { subject } : {}) };
    }
    case 'calendar': {
      const account = id(r.account);
      const minutes = r.minutes;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > WATCH_LIMITS.maxMinutes)
        bad(t().watchBadMinutes(WATCH_LIMITS.maxMinutes));
      const title = line(r.title, 'title');
      return { source: 'calendar', account, minutes, ...(title ? { title } : {}) };
    }
    case 'github': {
      const repo = repoName(line(r.repo, 'repo'));
      if (!validRepo(repo)) bad(t().watchBadRepo);
      if (r.on !== 'pr' && r.on !== 'ci') bad(t().invalidField('on'));
      const branch = r.on === 'ci' ? line(r.branch, 'branch') : '';
      if (branch && !validBranch(branch)) bad(t().watchBadBranch);
      return { source: 'github', repo, on: r.on, ...(branch ? { branch } : {}) };
    }
    case 'file': {
      const pattern = filePattern(line(r.pattern, 'pattern'));
      if (!pattern) bad(t().watchBadPattern);
      return { source: 'file', pattern };
    }
    default:
      bad(t().watchBadTrigger);
  }
}

/** A schedule to save. Missing choices take their defaults: on, refuse approvals, skip missed times. */
export function validateSchedule(input: unknown, now: number): ScheduleUpdate {
  const b = (input ?? {}) as Record<string, unknown>;
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (!text) bad(t().scheduleTextRequired);
  if (text.length > SCHEDULE_LIMITS.maxText) bad(t().scheduleTextTooLong(SCHEDULE_LIMITS.maxText));
  const enabled = b.enabled !== false;
  const tz = typeof b.timeZone === 'string' && b.timeZone.trim() ? b.timeZone.trim().slice(0, 100) : serverTimeZone();
  if (!validTimeZone(tz)) bad(t().scheduleBadTimeZone(tz));
  if (b.goal !== undefined && b.goal !== null && typeof b.goal !== 'string') bad(t().invalidField('goal'));
  const goal = typeof b.goal === 'string' ? b.goal.trim() : '';
  if (goal.length > SCHEDULE_LIMITS.maxGoal) bad(t().scheduleGoalTooLong(SCHEDULE_LIMITS.maxGoal));
  return {
    text,
    repeat: validRepeat(b.repeat, enabled, now),
    timeZone: tz,
    enabled,
    approvals: b.approvals === 'ask' ? 'ask' : 'deny',
    missed: b.missed === 'run' ? 'run' : 'skip',
    newChat: b.newChat === true,
    ...(goal ? { goal } : {}),
  };
}

// --- Model backends (the open agents) ------------------------------------------------------------

/** One of the API backends (openai, anthropic, xai); any other is a 404. */
export function validApiBackend(input: string): ApiBackend {
  if (!(API_BACKENDS as readonly string[]).includes(input)) throw new HttpError(404, t().backendUnknown(input));
  return input as ApiBackend;
}

/** `{ apiKey }`: the key to keep, or null / "" to remove it. */
export function validateBackendKey(input: unknown): string | null {
  const v = ((input ?? {}) as { apiKey?: unknown }).apiKey;
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > 4096) bad(t().invalidField('apiKey'));
  return v.trim() || null;
}

/** A custom endpoint's id: a slug (`ENDPOINT_ID_RE`), never one of the API backends' names. */
export function validEndpointId(input: string): string {
  if (!ENDPOINT_ID_RE.test(input)) bad(t().endpointIdInvalid(input));
  if ((API_BACKENDS as readonly string[]).includes(input)) bad(t().endpointIdReserved(input));
  return input;
}

/**
 * An endpoint's base URL: http(s), without credentials, a query or a fragment (its path stays:
 * `http://10.0.0.5:8000/v1`), with no trailing slash. Never Harness Relay's own API on this computer
 * (`relayPort`, and its other ports: `relayPorts()`), which the relay sandbox never lets agents
 * reach, however the address is spelled: loopback (`localhost` and names under it, a trailing dot,
 * 127/8, `::1`, IPv4 in IPv6), the unspecified address, or one of this computer's own (`own`).
 */
export function validEndpointUrl(input: unknown, relayPort = apiPort(), own: readonly string[] = localAddresses()): string {
  if (typeof input !== 'string' || input.length > BACKEND_LIMITS.maxUrl) bad(t().invalidField('baseUrl'));
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    bad(t().endpointUrlInvalid);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    raw.includes('#') ||
    raw.includes('?')
  ) {
    bad(t().endpointUrlInvalid);
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const host = url.hostname.replace(/\.$/, '');
  if (new Set([relayPort, ...relayPorts()]).has(port) && isLocalHost(host, own)) bad(t().endpointUrlRelay);
  return url.href.replace(/\/+$/, '');
}

export function validEndpointModelId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= BACKEND_LIMITS.maxModelId && !/[\s\p{Cc}\p{Cs}]/u.test(id);
}

/** A catalog lookup can use an unsaved URL and key. Only an omitted key may use the saved credential. */
export function validateEndpointCatalog(input: unknown): { baseUrl: string; endpointId?: string; apiKey?: string | null } {
  const u = (input ?? {}) as Record<string, unknown>;
  const baseUrl = validEndpointUrl(u.baseUrl);
  if (u.endpointId !== undefined && typeof u.endpointId !== 'string') bad(t().invalidField('endpointId'));
  return {
    baseUrl,
    ...(u.endpointId === undefined ? {} : { endpointId: validEndpointId(u.endpointId) }),
    ...(u.apiKey === undefined ? {} : { apiKey: validateBackendKey(u) }),
  };
}

/** `PUT /api/backends/endpoints/:id`: a name, a base URL, the model names to offer, and maybe its key. */
export function validateEndpoint(input: unknown, relayPort?: number): ModelEndpointUpdate {
  const u = (input ?? {}) as Record<string, unknown>;
  const name = optionalString(u.name, 'name', BACKEND_LIMITS.maxName);
  if (!name) bad(t().endpointNameMissing);
  const baseUrl = validEndpointUrl(u.baseUrl, relayPort);
  const models = u.models ?? [];
  const { maxModels, maxModelId } = BACKEND_LIMITS;
  if (!Array.isArray(models) || models.length > maxModels) bad(t().endpointModelsInvalid(maxModels, maxModelId));
  const names = models.map((m) => (typeof m === 'string' ? m.trim() : ''));
  if (names.some((m) => !validEndpointModelId(m))) bad(t().endpointModelsInvalid(maxModels, maxModelId));
  if (u.verifyModels !== undefined && typeof u.verifyModels !== 'boolean') bad(t().invalidField('verifyModels'));
  if (u.allowMissingMetadata !== undefined && (typeof u.allowMissingMetadata !== 'boolean' || u.verifyModels !== true))
    bad(t().invalidField('allowMissingMetadata'));
  const unique = [...new Set(names)];
  const out = {
    name,
    baseUrl,
    models: unique,
    ...(u.apiKey === undefined ? {} : { apiKey: validateBackendKey(u) }),
    ...(u.verifyModels === true ? { verifyModels: true } : {}),
    ...(u.allowMissingMetadata === true ? { allowMissingMetadata: true } : {}),
    ...(u.limits === undefined ? {} : { limits: validEndpointLimits(u.limits, unique) }),
  };
  return out;
}

/**
 * An endpoint's context windows and output limits as the user set them (`ModelEndpointUpdate.limits`):
 * an object by model id, only of the models it lists, each `{ context?, output? }` in whole tokens
 * (`MODEL_LIMIT_RANGE`), an output limit less than the context window set with it. A model with
 * neither is left out.
 */
export function validEndpointLimits(input: unknown, models: readonly string[]): Record<string, TokenLimits> {
  const { minContext, maxContext, minOutput, maxOutput } = MODEL_LIMIT_RANGE;
  const fail = () => bad(t().endpointLimitsInvalid(minContext, maxContext, minOutput, maxOutput));
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  // As entries, so that a model named `__proto__` is a key like any other.
  const out: [string, TokenLimits][] = [];
  for (const [model, value] of Object.entries(input as Record<string, unknown>)) {
    if (!models.includes(model) || !value || typeof value !== 'object' || Array.isArray(value)) fail();
    const { context, output, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length) fail();
    if ((context !== undefined && !validContext(context)) || (output !== undefined && !validOutput(output))) fail();
    if (context !== undefined && output !== undefined && (output as number) >= (context as number)) fail();
    const limits = {
      ...(context !== undefined ? { context: context as number } : {}),
      ...(output !== undefined ? { output: output as number } : {}),
    };
    if (limits.context !== undefined || limits.output !== undefined) out.push([model, limits]);
  }
  return Object.fromEntries(out);
}

/** How many notifications one `POST /api/notifications/read` may name. */
export const INBOX_READ_MAX = 500;

/** Which notifications to mark read: `{ ids }`, `{ conversationId }` or `{ all: true }`. */
export function validateInboxRead(input: unknown): InboxReadRequest {
  const u = (input ?? {}) as { ids?: unknown; conversationId?: unknown; all?: unknown };
  if (u.all === true) return { all: true };
  if (typeof u.conversationId === 'string' && u.conversationId.length > 0 && u.conversationId.length <= 64)
    return { conversationId: u.conversationId };
  if (
    Array.isArray(u.ids) &&
    u.ids.length <= INBOX_READ_MAX &&
    u.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
  ) {
    return { ids: u.ids as string[] };
  }
  bad(t().invalidField(u.ids !== undefined ? 'ids' : u.conversationId !== undefined ? 'conversationId' : 'all'));
}

/**
 * A browser's push subscription and which alerts it wants (`PUT /api/push/subscription`): a push
 * service's HTTPS address (one of `PUSH_HOSTS`), and its keys (the browser's P-256 public key and
 * auth secret, base64url); each preference a boolean.
 */
export function validatePushSubscription(input: unknown): { subscription: PushSubscriptionJson; prefs: AlertPrefs } {
  const u = (input ?? {}) as { subscription?: unknown; prefs?: unknown };
  const sub = (u.subscription ?? {}) as { endpoint?: unknown; keys?: unknown };
  if (typeof sub.endpoint !== 'string') bad(t().invalidField('subscription.endpoint'));
  const endpoint = sub.endpoint as string;
  const problem = endpointProblem(endpoint);
  if (problem) bad(problem);
  const keys = (sub.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys.auth === 'string' ? keys.auth : '';
  if (!subscriptionKeys({ p256dh, auth })) bad(t().pushBadKeys);
  const p = (u.prefs ?? {}) as Record<string, unknown>;
  const flag = (name: keyof AlertPrefs) => {
    if (typeof p[name] !== 'boolean') bad(t().invalidField(`prefs.${name}`));
    return p[name] as boolean;
  };
  return { subscription: { endpoint, keys: { p256dh, auth } }, prefs: { done: flag('done'), needs: flag('needs'), sound: flag('sound') } };
}

// --- Mail accounts and calendars (the mail and calendar tools) ------------------------------------

/** A provider of accounts that sign in with OAuth; any other is a 404. */
export function validOAuthProvider(input: string): OAuthProviderId {
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(input)) throw new HttpError(404, t().invalidField('provider'));
  return input as OAuthProviderId;
}

/** What a sign-in is for: some of the uses, each once (the calendar when none is said, as before mail). */
export function validOAuthUses(input: unknown): OAuthUse[] {
  if (input === undefined) return ['calendar'];
  if (!Array.isArray(input) || !input.length || input.some((u) => !(OAUTH_USES as readonly unknown[]).includes(u)))
    bad(t().invalidField('uses'));
  return OAUTH_USES.filter((u) => (input as unknown[]).includes(u));
}

/**
 * A provider's OAuth app: its client id (empty: none of the user's own), Microsoft's tenant (`common`,
 * `organizations`, `consumers`, a tenant's id or domain), and a client secret (none: the kept one stays;
 * empty: none).
 */
export function validateOAuthClient(input: unknown): OAuthClientUpdate {
  const b = (input ?? {}) as Record<string, unknown>;
  const clientId = typeof b.clientId === 'string' ? b.clientId.trim() : '';
  if (clientId && !/^[A-Za-z0-9._:-]{1,200}$/.test(clientId)) bad(t().invalidField('clientId'));
  const tenant = typeof b.tenant === 'string' ? b.tenant.trim() : '';
  if (tenant && !/^[A-Za-z0-9.-]{1,100}$/.test(tenant)) bad(t().invalidField('tenant'));
  if (b.secret !== undefined && b.secret !== null && (typeof b.secret !== 'string' || b.secret.length > 500 || /[\r\n\0]/.test(b.secret)))
    bad(t().invalidField('secret'));
  return {
    clientId,
    ...(tenant ? { tenant } : {}),
    ...(typeof b.secret === 'string' ? { secret: b.secret.trim() } : {}),
  };
}

/** One of an OAuth account's calendars to add to the calendar tools: a name, and its address (https). */
export function validateOAuthCalendar(input: unknown): { name: string; url: string } {
  const b = (input ?? {}) as Record<string, unknown>;
  const raw = typeof b.url === 'string' ? b.url.trim() : '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    bad(t().connectorBadUrl);
  }
  // https, as the token goes (plain http only to a stand-in on this computer): one it could never be sent to is refused.
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)))
    bad(t().connectorBadUrl);
  return { name: connectorName(b.name), url: url.href };
}

/** An account's id: a short slug the UI makes. */
export function validConnectorId(input: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(input)) bad(t().invalidField('id'));
  return input;
}

function connectorName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > CONNECTOR_LIMITS.name || /[\r\n]/.test(name)) bad(t().invalidField('name'));
  return name;
}

function connectorPassword(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 1000 || /[\r\n\0]/.test(v)) bad(t().invalidField('password'));
  return v;
}

function connectorUser(v: unknown): string {
  const user = typeof v === 'string' ? v.trim() : '';
  if (!user || user.length > 320 || /[\r\n\0]/.test(user)) bad(t().invalidField('username'));
  return user;
}

/**
 * A mail server: a host name or address, a port, TLS or STARTTLS (plain only to this computer: a
 * local bridge), and never one of Harness Relay's own ports on this computer.
 */
function mailServer(input: unknown, field: string, own: readonly string[]): MailServer {
  const b = (input ?? {}) as Record<string, unknown>;
  const host = typeof b.host === 'string' ? b.host.trim().replace(/^\[|\]$/g, '') : '';
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) && !/^[0-9A-Fa-f:]{2,39}$/.test(host)) bad(t().connectorBadHost(field));
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) bad(t().connectorBadPort(field));
  const security = b.security === 'starttls' ? 'starttls' : b.security === 'none' ? 'none' : 'tls';
  if (security === 'none' && !isLoopbackHost(host)) bad(t().connectorPlainRemote(field));
  if (isLocalHost(host, own) && relayPorts().includes(port)) bad(t().connectorRelayPort(field));
  return { host, port, security };
}

export function validateMailAccount(input: unknown, own: readonly string[] = localAddresses()): MailAccountUpdate {
  const b = (input ?? {}) as Record<string, unknown>;
  const address = typeof b.address === 'string' ? validAddress(b.address) : undefined;
  if (!address) bad(t().connectorBadAddress('address'));
  const password = connectorPassword(b.password);
  return {
    name: connectorName(b.name),
    address,
    username: connectorUser(b.username),
    imap: mailServer(b.imap, 'IMAP', own),
    smtp: mailServer(b.smtp, 'SMTP', own),
    ...(password !== undefined ? { password } : {}),
  };
}

export function validateCalendarAccount(input: unknown, own: readonly string[] = localAddresses()): CalendarAccountUpdate {
  const b = (input ?? {}) as Record<string, unknown>;
  let url: URL;
  try {
    url = new URL(String(b.url ?? '').trim());
  } catch {
    bad(t().connectorBadUrl);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.username ||
    url.password ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !isLoopbackHost(host))
  )
    bad(t().connectorBadUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (isLocalHost(host, own) && relayPorts().includes(port)) bad(t().connectorRelayPort('URL'));
  const address = typeof b.address === 'string' && b.address.trim() ? validAddress(b.address) : '';
  if (address === undefined) bad(t().connectorBadAddress('address'));
  const password = connectorPassword(b.password);
  return {
    name: connectorName(b.name),
    url: url.href,
    username: connectorUser(b.username),
    ...(address ? { address } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}
