import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CWD_MISSING,
  GROUP_LIMITS,
  MCP_NAME_RE,
  MEMORY_SCOPES,
  NATIVE_PARTS,
  PROVIDERS,
  TOOL_LIMITS,
  VOICE_LANGUAGES,
  VOICE_MODELS,
  type AgentConfig,
  type ConversationGroup,
  type ConversationSettings,
  type LeadAgentSettings,
  type McpServerUpdate,
  type MemoryScope,
  type Mode,
  type Permission,
  type Provider,
  type ProviderSettingsUpdate,
  type ToolLibraryUpdate,
  type VoiceLanguage,
  type VoiceModelId,
  type VoiceSettingsUpdate,
} from '../shared/types';
import { HttpError } from './errors';
import { isOtherGroupName, t } from './i18n';

const MODES: Mode[] = ['roundtable', 'parallel', 'relay'];
const PERMISSIONS: Permission[] = ['read-only', 'edit', 'full'];
export const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const MAX_AGENTS = 8;

function bad(msg: string): never {
  throw new HttpError(400, msg);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function expandPath(p: string): string {
  const t = p.trim();
  if (t === '~' || t.startsWith('~/')) return resolve(homedir(), t.slice(2));
  return isAbsolute(t) ? resolve(t) : resolve(process.cwd(), t);
}

/**
 * A working directory. A missing one is a 404 with the code `CWD_MISSING`, so
 * the client can offer to create it; with `create` it is created (parents too).
 */
function directory(dir: string, create: boolean): string {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) bad(t().cwdNotDirectory(dir));
    return dir;
  }
  if (!create) throw new HttpError(404, t().cwdMissing(dir), CWD_MISSING);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    bad(t().cwdCreateFailed(dir, (e as NodeJS.ErrnoException).code ?? (e as Error).message));
  }
  return dir;
}

/** A directory from user input (`~` expanded); see `directory()` for a missing one. */
export function validDirectory(input: unknown, create = false): string {
  if (typeof input !== 'string' || !input.trim()) bad(t().invalidField('defaultCwd'));
  return directory(expandPath(input), create);
}

function optionalString(v: unknown, field: string, max = 500): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) bad(t().invalidField(field));
  return v.trim();
}

/** The lead agent (auto team) from a settings update. */
export function validateLead(input: unknown): LeadAgentSettings {
  const l = (input ?? {}) as Partial<LeadAgentSettings>;
  if (!PROVIDERS.includes(l.provider as Provider)) bad(t().unknownProvider(String(l.provider)));
  return {
    provider: l.provider as Provider,
    model: optionalString(l.model, 'lead.model') ?? '',
    effort: validEffort(optionalString(l.effort, 'lead.effort'), 'lead') ?? '',
  };
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

/** A provider settings update: strings, a valid effort, `apiKey` null to remove, `nativeOff` a list of known parts. */
export function validateProviderUpdate(input: unknown): ProviderSettingsUpdate {
  const u = (input ?? {}) as Record<string, unknown>;
  const out: ProviderSettingsUpdate = {};
  const bin = optionalString(u.bin, 'bin', 4096);
  if (bin !== undefined) out.bin = bin;
  const model = optionalString(u.defaultModel, 'defaultModel');
  if (model !== undefined) out.defaultModel = model;
  if (u.defaultEffort !== undefined) out.defaultEffort = validEffort(optionalString(u.defaultEffort, 'defaultEffort'), 'default') ?? '';
  if (u.apiKey === null) out.apiKey = null;
  else {
    const key = optionalString(u.apiKey, 'apiKey', 4096);
    if (key !== undefined) out.apiKey = key;
  }
  if (u.nativeOff !== undefined) {
    const parts = u.nativeOff;
    if (!Array.isArray(parts) || parts.some((x) => !(NATIVE_PARTS as readonly unknown[]).includes(x))) bad(t().invalidField('nativeOff'));
    out.nativeOff = parts as ProviderSettingsUpdate['nativeOff'];
  }
  return out;
}

function validEffort(v: unknown, name: string): string | undefined {
  const e = String(v ?? '').trim();
  if (!e) return undefined;
  if (!/^[a-z-]{1,16}$/.test(e)) bad(t().badEffort(name, e));
  return e;
}

export function validateAgents(input: unknown): AgentConfig[] {
  if (!Array.isArray(input) || input.length === 0) bad(t().needAgent);
  if (input.length > MAX_AGENTS) bad(t().tooManyAgents(MAX_AGENTS));
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
      ...validAgentTools(a.tools),
    };
  });
}

const TOOL_KEY_RE = /^(memory|memory:(claude|codex|grok)|mcp:[A-Za-z0-9_-]{1,40}|skill:[^\0]{1,4000})$/;

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

/** Conversation settings; with `create`, a missing working directory is created. */
export function validateSettings(input: unknown, defaultCwd: string, create = false): ConversationSettings {
  const s = (input ?? {}) as Partial<ConversationSettings>;
  const cwd = directory(expandPath(String(s.cwd || defaultCwd)), create);
  return {
    mode: MODES.includes(s.mode as Mode) ? (s.mode as Mode) : 'roundtable',
    rounds: clampInt(s.rounds, 1, 5, 1),
    maxHops: clampInt(s.maxHops, 1, 30, 8),
    permission: PERMISSIONS.includes(s.permission as Permission) ? (s.permission as Permission) : 'read-only',
    cwd,
    ...(s.autoTeam === true ? { autoTeam: true } : {}),
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
