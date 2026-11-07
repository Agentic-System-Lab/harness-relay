import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PROVIDERS,
  type AgentConfig,
  type ConversationSettings,
  type Mode,
  type Permission,
} from '../shared/types';
import { HttpError } from './errors';

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

function validEffort(v: unknown, name: string): string | undefined {
  const e = String(v ?? '').trim();
  if (!e) return undefined;
  if (!/^[a-z-]{1,16}$/.test(e)) bad(`agent「${name}」的推理強度「${e}」無效`);
  return e;
}

export function validateAgents(input: unknown): AgentConfig[] {
  if (!Array.isArray(input) || input.length === 0) bad('至少需要一個 agent');
  if (input.length > MAX_AGENTS) bad(`最多 ${MAX_AGENTS} 個 agent`);
  const names = new Set<string>();
  const ids = new Set<string>();
  return input.map((raw, i) => {
    const a = (raw ?? {}) as Partial<AgentConfig>;
    const name = String(a.name ?? '').trim().replace(/^@/, '');
    if (!NAME_RE.test(name)) bad(`第 ${i + 1} 個 agent 的名稱「${name}」無效：只能用字母、數字、_ 或 -，最多 32 字`);
    if (name.toLowerCase() === 'user' || name.toLowerCase() === 'system') bad(`名稱「${name}」是保留字`);
    if (names.has(name.toLowerCase())) bad(`agent 名稱「${name}」重複了`);
    names.add(name.toLowerCase());
    if (!PROVIDERS.includes(a.provider as never)) bad(`agent「${name}」的 provider 無效`);
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

export function validateSettings(input: unknown, defaultCwd: string): ConversationSettings {
  const s = (input ?? {}) as Partial<ConversationSettings>;
  const cwd = expandPath(String(s.cwd || defaultCwd));
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) bad(`工作目錄不存在：${cwd}`);
  return {
    mode: MODES.includes(s.mode as Mode) ? (s.mode as Mode) : 'roundtable',
    rounds: clampInt(s.rounds, 1, 5, 1),
    maxHops: clampInt(s.maxHops, 1, 30, 8),
    permission: PERMISSIONS.includes(s.permission as Permission) ? (s.permission as Permission) : 'read-only',
    cwd,
  };
}
