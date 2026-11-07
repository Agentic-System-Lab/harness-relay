import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CWD_MISSING,
  PROVIDERS,
  VOICE_LANGUAGES,
  VOICE_MODELS,
  type AgentConfig,
  type ConversationSettings,
  type LeadAgentSettings,
  type Mode,
  type Permission,
  type Provider,
  type ProviderSettingsUpdate,
  type VoiceLanguage,
  type VoiceModelId,
  type VoiceSettingsUpdate,
} from '../shared/types';
import { HttpError } from './errors';
import { t } from './i18n';

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

/** A provider settings update: strings only, a valid effort, `apiKey` null to remove. */
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
    };
  });
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
