import {
  PROVIDER_LABEL,
  accountUsable,
  isOpenProvider,
  type AccountStatus,
  type AgentConfig,
  type ConversationSummary,
  type LeadAgentSettings,
  type Provider,
  type ProviderModels,
  type ProviderStatus,
} from '../shared/types';
import type { Messages } from './i18n';
import type { ConvStatus } from './locales/zh-TW';

/**
 * What the sidebar says about a conversation: needs you (an approval, a team to confirm, a question) >
 * replying > error > new reply > nothing.
 * `seenAt` is the conversation's updatedAt when the user last had it open.
 */
export function convStatus(c: ConversationSummary, seenAt: number | undefined): ConvStatus | undefined {
  if (c.waiting) return 'waiting';
  if (c.confirmTeam) return 'confirm';
  if (c.asking && !c.running) return 'answer';
  if (c.running) return 'running';
  if (!c.lastStatus || (seenAt ?? 0) >= c.updatedAt) return undefined;
  if (c.lastStatus === 'error') return 'error';
  return c.lastStatus === 'done' ? 'unread' : undefined;
}

export const PROVIDER_COLOR: Record<Provider, string> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
  grok: 'var(--grok)',
  opencode: 'var(--opencode)',
  goose: 'var(--goose)',
  cline: 'var(--cline)',
  openhands: 'var(--openhands)',
  pi: 'var(--pi)',
};

/** A new member's name on each CLI, before a number makes it unique. */
const AGENT_NAME: Record<Provider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  opencode: 'OpenCode',
  goose: 'Goose',
  cline: 'Cline',
  openhands: 'OpenHands',
  pi: 'Pi',
};

/** A model, reasoning effort and account picked for one CLI ('' or absent: that CLI's default). */
export interface ModelChoice {
  model?: string;
  effort?: string;
  account?: string;
}

/**
 * Switching an agent (or the lead agent) to another CLI. Models, efforts and accounts belong to a CLI,
 * so they cannot carry over; instead the ones picked for the CLI being left are kept, and the ones
 * picked earlier for the CLI switched to come back — switching away and back loses nothing.
 */
export function switchProvider<T extends { provider: Provider } & ModelChoice>(
  current: T,
  next: Provider,
  kept: Partial<Record<Provider, ModelChoice>>,
): { value: T; kept: Partial<Record<Provider, ModelChoice>> } {
  const leaving: ModelChoice = { model: current.model ?? '', effort: current.effort ?? '', ...(current.account ? { account: current.account } : {}) };
  const remembered = { ...kept, [current.provider]: leaving };
  const back = remembered[next];
  // Accounts belong to a CLI too.
  const { account: _left, ...rest } = current;
  const value = { ...rest, provider: next, model: back?.model ?? '', effort: back?.effort ?? '', ...(back?.account ? { account: back.account } : {}) };
  return { value: value as T, kept: remembered };
}

/** An account's name in the UI: the name the user gave it, else "Default" for the default account. */
export function accountName(a: Pick<AccountStatus, 'id' | 'label'>, t: Messages): string {
  return a.label || (a.id ? t.accounts.unnamed(a.id) : t.accounts.default);
}

/**
 * The account an agent (or the lead agent) runs as, as its CLI's status lists it: the one it names
 * while the CLI has it, else the default account (also when it names one that was removed).
 */
export function accountOf(status: ProviderStatus | undefined, account: string | undefined): AccountStatus | undefined {
  return status?.accounts.find((a) => a.id === account) ?? status?.accounts[0];
}

/** Whether an agent can run as its account: the CLI is installed, and that account signed in (or has a key). */
export function accountState(status: ProviderStatus | undefined, account: string | undefined): 'ok' | 'warn' | 'off' {
  if (!status || !status.installed) return 'off';
  const a = accountOf(status, account);
  return !a || accountUsable(a) ? 'ok' : 'warn';
}

/** The account a new member of a CLI runs as: the default one, unless it is not ready and another one is. */
export function readyAccount(status: ProviderStatus | undefined): string | undefined {
  const ready = status?.installed ? status.accounts.find(accountUsable) : undefined;
  return ready?.id || undefined;
}

export function newAgent(provider: Provider, taken: string[]): AgentConfig {
  const base = AGENT_NAME[provider];
  let name = base;
  for (let i = 2; taken.some((t) => t.toLowerCase() === name.toLowerCase()); i++) name = `${base}${i}`;
  return { id: crypto.randomUUID(), name, provider, role: '' };
}

/** A file's contents as base64, as the API takes files (a browser's FileReader: not for tests). */
export function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * A signal that aborts after `ms`, as AbortSignal.timeout() does, and `clear` to stop its timer once the
 * request is done. Made by hand rather than with AbortSignal.timeout() (Safari 16); the client as a whole
 * needs Safari 16.4 anyway (RegExp lookbehind in src/shared/links.ts, and Vite's default build target).
 */
export function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The request timed out.', 'TimeoutError')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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

/**
 * The model picker's "default" choice for a member or the lead agent: the model it then runs on. The
 * other CLIs pick their own default; an open agent runs on the one shown (Settings' default, else its
 * CLI catalog's on a configured backend), and with none it needs a model.
 */
export function inheritModelLabel(pm: ProviderModels | undefined, provider: Provider, t: Messages): string {
  if (pm?.defaultModel) return t.team.defaultModel(pm.defaultModel);
  if (!pm) return t.team.defaultModel(t.common.loading);
  return isOpenProvider(provider) ? t.team.noDefaultModel : t.team.defaultModel(t.team.cliDecides);
}
