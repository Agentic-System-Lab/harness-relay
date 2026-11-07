import { PROVIDER_LABEL, type AgentConfig, type ConversationSummary, type LeadAgentSettings, type Provider } from '../shared/types';
import type { Messages } from './i18n';
import type { ConvStatus } from './locales/zh-TW';

/**
 * What the sidebar says about a conversation: needs you (an approval, then a team to confirm) >
 * replying > error > new reply > nothing.
 * `seenAt` is the conversation's updatedAt when the user last had it open.
 */
export function convStatus(c: ConversationSummary, seenAt: number | undefined): ConvStatus | undefined {
  if (c.waiting) return 'waiting';
  if (c.confirmTeam) return 'confirm';
  if (c.running) return 'running';
  if (!c.lastStatus || (seenAt ?? 0) >= c.updatedAt) return undefined;
  if (c.lastStatus === 'error') return 'error';
  return c.lastStatus === 'done' ? 'unread' : undefined;
}

export const PROVIDER_COLOR: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
  grok: 'var(--grok)',
};

export function newAgent(provider: Provider, taken: string[]): AgentConfig {
  const base = { claude: 'Claude', codex: 'Codex', grok: 'Grok' }[provider];
  let name = base;
  for (let i = 2; taken.some((t) => t.toLowerCase() === name.toLowerCase()); i++) name = `${base}${i}`;
  return { id: crypto.randomUUID(), name, provider, role: '' };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export function formatTokens(n?: number): string {
  if (n === undefined) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function relativeTime(ts: number, t: Messages): string {
  const d = Date.now() - ts;
  if (d < 60_000) return t.time.justNow;
  if (d < 3_600_000) return t.time.minutesAgo(Math.floor(d / 60_000));
  if (d < 86_400_000) return t.time.hoursAgo(Math.floor(d / 3_600_000));
  return new Date(ts).toLocaleDateString();
}

/** "Claude Code · opus" */
export function leadLabel(lead: LeadAgentSettings): string {
  return `${PROVIDER_LABEL[lead.provider]}${lead.model ? ` · ${lead.model}` : ''}`;
}

export function initials(name: string): string {
  return [...name][0]?.toUpperCase() ?? '?';
}

/** "gpt-6.1-sol · 高（high）" — only the parts an agent overrides. */
export function modelSummary(a: Pick<AgentConfig, 'model' | 'effort'>, t: Messages): string {
  return [a.model, a.effort && t.effortLabel(a.effort)].filter(Boolean).join(' · ');
}
