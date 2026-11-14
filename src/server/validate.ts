import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_ID_RE,
  API_BACKENDS,
  BACKEND_LIMITS,
  CWD_MISSING,
  ENDPOINT_ID_RE,
  GROUP_LIMITS,
  MAX_CWDS,
  MAX_ACCOUNT_LABEL,
  MCP_NAME_RE,
  MAX_NATIVE_ITEM_ID,
  MAX_NATIVE_ITEMS,
  MEMORY_SCOPES,
  NATIVE_ITEM_KINDS,
  NATIVE_PARTS,
  PROVIDERS,
  SCHEDULE_KINDS,
  SCHEDULE_LIMITS,
  TOOL_LIMITS,
  VOICE_LANGUAGES,
  cwdSettings,
  VOICE_MODELS,
  type AgentConfig,
  type AlertPrefs,
  type ApiBackend,
  type ConversationGroup,
  type ConversationSettings,
  type LeadAgentSettings,
  type McpServerUpdate,
  type MemoryScope,
  type ModelEndpointUpdate,
  type Mode,
  type Permission,
  type Provider,
  type ProviderAccountUpdate,
  type ProviderSettingsUpdate,
  type PushSubscriptionJson,
  type ScheduleRepeat,
  type ScheduleUpdate,
  type ToolLibraryUpdate,
  type VoiceLanguage,
  type VoiceModelId,
  type VoiceSettingsUpdate,
} from '../shared/types';
import { parseTime, validTimeZone } from '../shared/schedule';
import { CONFIG } from './config';
import { HttpError } from './errors';
import { isOtherGroupName, t } from './i18n';
import { apiPort } from './ports';
import { isLocalHost, localAddresses, relayPorts } from './relaySandbox';
import { endpointProblem, subscriptionKeys } from './push';

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

/** An account's name: a string of up to `MAX_ACCOUNT_LABEL` characters, with no line breaks. */
export function validAccountLabel(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length > MAX_ACCOUNT_LABEL || /[\u0000-\u001f\u007f]/.test(input)) {
    bad(t().badAccountLabel(MAX_ACCOUNT_LABEL));
  }
  return input.trim();
}

/**
 * An account update: a name, its key (null to remove), and how it runs: strings, a valid effort,
 * `nativeOff` a list of known parts, `nativeItems` lists of ids by known kind.
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
  for (const field of ['defaultModel', 'defaultEffort', 'nativeOff', 'nativeItems']) {
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
    const name = String(a.name ?? '').trim().replace(/^@/, '');
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
    };
  });
}

/** A member's tool library exception: the memory for everyone or for its CLI (any of PROVIDERS), an MCP server, a skill. */
const TOOL_KEY_RE = new RegExp(`^(memory|memory:(${PROVIDERS.join('|')})|mcp:[A-Za-z0-9_-]{1,40}|skill:[^\\0]{1,4000})$`);

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
  };
}

/**
 * A group name: trimmed, spaces collapsed, not too long, and not the name of another group (`except`
 * is the one being renamed) or of the default group in any language, ignoring case.
 */
export function validGroupName(input: unknown, groups: ConversationGroup[], except?: string): string {
  const name = String(input ?? '').replace(/\s+/g, ' ').trim();
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
  return {
    text,
    repeat: validRepeat(b.repeat, enabled, now),
    timeZone: tz,
    enabled,
    approvals: b.approvals === 'ask' ? 'ask' : 'deny',
    missed: b.missed === 'run' ? 'run' : 'skip',
    newChat: b.newChat === true,
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
    bad(t().endpointUrlInvalid(raw));
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || raw.includes('#') || raw.includes('?')) {
    bad(t().endpointUrlInvalid(raw));
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const host = url.hostname.replace(/\.$/, '');
  if (new Set([relayPort, ...relayPorts()]).has(port) && isLocalHost(host, own)) bad(t().endpointUrlRelay(raw));
  return url.href.replace(/\/+$/, '');
}

/** `PUT /api/backends/endpoints/:id`: a name, a base URL, the model names it serves, and maybe its key. */
export function validateEndpoint(input: unknown, relayPort?: number): ModelEndpointUpdate {
  const u = (input ?? {}) as Record<string, unknown>;
  const name = optionalString(u.name, 'name', BACKEND_LIMITS.maxName);
  if (!name) bad(t().endpointNameMissing);
  const baseUrl = validEndpointUrl(u.baseUrl, relayPort);
  const models = u.models ?? [];
  const { maxModels, maxModelId } = BACKEND_LIMITS;
  if (!Array.isArray(models) || models.length > maxModels) bad(t().endpointModelsInvalid(maxModels, maxModelId));
  const names = models.map((m) => (typeof m === 'string' ? m.trim() : ''));
  if (names.some((m) => !m || m.length > maxModelId || /\s/.test(m))) bad(t().endpointModelsInvalid(maxModels, maxModelId));
  const out: ModelEndpointUpdate = { name, baseUrl, models: [...new Set(names)] };
  if (u.apiKey === null) out.apiKey = null;
  else if (u.apiKey !== undefined) {
    const key = optionalString(u.apiKey, 'apiKey', 4096);
    out.apiKey = key || null;
  }
  return out;
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
