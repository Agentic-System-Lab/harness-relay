import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountUsage, Provider, UsageKind, UsageLimit, UsageNone, UsagePayer, UsageProblem, UsageSpan } from '../shared/types';
import {
  antigravityAiCredits,
  antigravityAppDir,
  antigravityKeyOnly,
  antigravityProbeEnv,
  antigravityProbeSettings,
} from './agents/antigravity';
import { CLAUDE_PROBE_ARGS } from './agents/claude';
import { copilotHome, copilotProbeEnv, prepareCopilotProbeHome } from './agents/copilot';
import { grokNativeEnv } from './agents/grok';
import { museProbeEnv } from './agents/muse';
import { converse, converseFramed, runProcess, stripAnsi, tail } from './process';
import { relayTmpDir } from './protect';
import { CREDENTIAL_ENV } from './settings';

/*
 * How much of an account's plan is used, as its own CLI reports it, asked without a prompt (no model
 * is called, nothing is billed), in the account's own home:
 *
 * - Claude Code: a `get_usage` control request over stream-json (what its `/usage` shows).
 * - Codex: `account/read` and `account/rateLimits/read` on `codex app-server`.
 * - Grok: the ACP extension request `_x.ai/billing` on `grok agent --no-leader stdio` (what its
 *   `/usage` shows), without a session.
 * - Muse Code: `muse usage --json`.
 * - Copilot: `account.getQuota` and `account.getCurrentAuth` on its headless server (`copilot
 *   --headless --stdio`, the JSON-RPC its SDK speaks), without a session.
 * - Antigravity: `/usage` and `/credits` in print mode (`agy -p /usage --output-format json`), which
 *   it answers without a turn.
 * - Cursor: only its plan (`cursor-agent about --format json`); its usage shows in its own terminal
 *   UI only (`/usage`), which has no command or ACP request outside it.
 *
 * An account that runs on an API key its provider bills by use has no plan limits, and the key cannot
 * read a balance: it is told so without asking its CLI (Grok's billing would describe the grok.com
 * sign-in, not the key the runs use); Claude Code and Codex say so themselves. Cursor's and Copilot's
 * keys belong to the user's own plan.
 *
 * Nothing here is translated: an answer is kept a while and given to every browser, whatever its
 * language, so Harness Relay's own reasons are codes (`UsageProblem`) the UI words.
 */

/** What a CLI answered, before it is given its account and time. */
export type UsageAnswer = Omit<AccountUsage, 'provider' | 'account' | 'checkedAt'>;

/** How long asking a CLI about its usage may take. */
const USAGE_TIMEOUT_MS = 30_000;

/**
 * The variables of a key the provider bills by use, where the CLI does not say so itself: set, the
 * account's runs use it rather than a plan. (Claude Code answers `rate_limits_available: false` on
 * one; Codex's `account/read` names the key it runs on.)
 */
export const BILLED_KEY_ENV: Partial<Record<Provider, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  grok: ['XAI_API_KEY'],
  antigravity: ['GEMINI_API_KEY'],
  muse: ['META_API_KEY'],
};

const none = (why: UsageNone, plan?: string): UsageAnswer => ({ limits: [], none: why, ...(plan ? { plan } : {}) });
/** The CLI refused or failed, in its own words. */
const failed = (error: string): UsageAnswer => ({ limits: [], error });
/** Harness Relay could not tell, for a reason the UI words. */
const trouble = (problem: UsageProblem): UsageAnswer => ({ limits: [], problem });
/** What went wrong with an ask: the CLI's own error, else its timeout, else what it said on stderr, else no answer. */
const failure = (error: string | undefined, timedOut: boolean, said = ''): UsageAnswer =>
  error ? failed(error) : timedOut ? trouble('timedOut') : tail(said, 200) ? failed(tail(said, 200)) : trouble('noAnswer');

/** A number, or undefined for anything else (NaN included). */
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** A time given as an ISO date, or as seconds or milliseconds since the epoch, in ms. */
function when(v: unknown): number | undefined {
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v.trim())) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  // Seconds until the year 33658; milliseconds after.
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

const clampPercent = (n: number) => Math.min(100, Math.max(0, n));

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** `limits` with the ones `covered` says `payer` pays past marked so, and the payer beside them; as they are without one. */
function paidBy(
  limits: UsageLimit[],
  payer: UsagePayer | undefined,
  covered: (l: UsageLimit, i: number) => boolean = () => true,
): Pick<AccountUsage, 'limits' | 'payer'> {
  if (!payer) return { limits };
  return { limits: limits.map((l, i) => (covered(l, i) ? { ...l, paidPast: true as const } : l)), payer };
}

/** The span of a window given in minutes, when it is one of the usual ones. */
export function spanOfMinutes(minutes: number): UsageSpan | undefined {
  if (minutes === 300) return 'fiveHour';
  if (minutes === 1440) return 'day';
  if (minutes === 10080) return 'week';
  if (minutes >= 28 * 1440 && minutes <= 31 * 1440) return 'month';
  return undefined;
}

/**
 * The one empty folder the CLIs are asked in (in the data folder's `tmp`, the user's own): the same
 * each time, as Claude Code records each folder it starts in, and a new one each time would pile up
 * there.
 */
function probeDir(): string {
  const dir = join(relayTmpDir(), 'usage-probe');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ---------------------------------------------------------------------------
// Claude Code

/** Claude Code's span for one of its limits (`kind` and `group` of `rate_limits.limits[]`). */
function claudeSpan(kind: string, group: string): UsageSpan | undefined {
  if (kind === 'session' || group === 'session' || kind === 'five_hour') return 'fiveHour';
  if (kind.startsWith('weekly') || group === 'weekly' || kind.startsWith('seven_day')) return 'week';
  if (kind.startsWith('monthly') || group === 'monthly') return 'month';
  if (kind.startsWith('daily') || group === 'daily') return 'day';
  return undefined;
}

/**
 * Claude Code's answer to `get_usage`: its `rate_limits.limits` (each limit, its percent used and when
 * it resets, a model's own weekly limit with the model's name), or the older per-window fields when
 * that list is missing or empty. `rate_limits_available: false`: plan limits do not apply (an API key)
 * or it cannot read them for how the account signs in (a token from `claude setup-token`, Bedrock,
 * Vertex, a sign-in without the profile scope). Its usage credits pay past every limit while they can
 * (`claudeUsageCredits`).
 */
export function parseClaudeUsage(r: unknown, apiKey: boolean): UsageAnswer | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const o = r as Record<string, any>;
  const plan = text(o.subscription_type);
  if (o.rate_limits_available === false || !o.rate_limits) return none(apiKey ? 'apiKey' : 'unavailable', plan);
  const rl = o.rate_limits as Record<string, any>;
  const limits: UsageLimit[] = [];
  for (const l of Array.isArray(rl.limits) ? rl.limits : []) {
    const usedPercent = num(l?.percent);
    if (usedPercent === undefined) continue;
    const kind = String(l.kind ?? '');
    const span = claudeSpan(kind, String(l.group ?? ''));
    const model = text(l.scope?.model?.display_name) ?? text(l.scope?.model?.id);
    const scope = model ?? text(l.scope?.surface?.display_name) ?? (span ? undefined : text(kind));
    const resetsAt = when(l.resets_at);
    limits.push({
      ...(span ? { span } : {}),
      ...(scope ? { scope } : {}),
      usedPercent: clampPercent(usedPercent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  if (!limits.length) {
    const windows: [string, UsageSpan, string | undefined][] = [
      ['five_hour', 'fiveHour', undefined],
      ['seven_day', 'week', undefined],
      ['seven_day_opus', 'week', 'Opus'],
      ['seven_day_sonnet', 'week', 'Sonnet'],
    ];
    for (const [key, span, scope] of windows) {
      const usedPercent = num(rl[key]?.utilization);
      if (usedPercent === undefined) continue;
      const resetsAt = when(rl[key].resets_at);
      limits.push({ span, ...(scope ? { scope } : {}), usedPercent: clampPercent(usedPercent), ...(resetsAt ? { resetsAt } : {}) });
    }
    for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
      const usedPercent = num(m?.utilization);
      const scope = text(m?.display_name);
      if (usedPercent === undefined || !scope) continue;
      const resetsAt = when(m.resets_at);
      limits.push({ span: 'week', scope, usedPercent: clampPercent(usedPercent), ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  const paid = paidBy(limits, claudeUsageCredits(rl.extra_usage) ? 'usageCredits' : undefined);
  return { ...(plan ? { plan } : {}), ...paid, ...(limits.length ? {} : { none: 'noData' as const }) };
}

/**
 * Whether Claude Code's usage credits (extra usage, `rate_limits.extra_usage`) pay once a plan limit
 * is used up: turned on, by nothing turned off (the user, the organization, the seat, a balance used
 * up), and below its monthly, daily and weekly spend limits. Claude Code then keeps running past the
 * 5-hour, weekly and a model's own weekly limits ("You're now using usage credits"). Missing (an answer
 * made from the response headers alone), it says nothing: no payer.
 */
function claudeUsageCredits(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, any>;
  if (e.is_enabled !== true || e.spend_limit_reached === true || e.user_disabled === true) return false;
  if (text(e.disabled_reason)) return false;
  const cap = num(e.monthly_limit);
  const spent = num(e.used_credits);
  const share = num(e.utilization);
  if (cap !== undefined && ((spent !== undefined && spent >= cap) || (share !== undefined && share >= 100))) return false;
  for (const period of [e.daily, e.weekly]) {
    const limit = num(period?.limit);
    const used = num(period?.used_credits);
    if (limit !== undefined && used !== undefined && used >= limit) return false;
  }
  return true;
}

/** Codex's reasons a workspace's credits cannot pay: out of credits, or a spend cap reached. */
const CODEX_CREDITS_STOPPED = new Set([
  'workspace_owner_credits_depleted',
  'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached',
  'workspace_member_usage_limit_reached',
]);

/**
 * Whether Codex's credits pay past the plan's own limit, read from its `codex` snapshot: unlimited, or
 * credits it has (`hasCredits`) with a balance above zero (or none given), with no spend control
 * reached and no workspace out of credits or at its spend cap. The plan's limit being reached
 * (`rate_limit_reached`) is when they pay: Codex then keeps running on them while the balance lasts.
 */
function codexCreditsPay(s: Record<string, any> | undefined): boolean {
  const c = s?.credits as Record<string, any> | null | undefined;
  if (!c) return false;
  const balance = num(c.balance);
  if (c.unlimited !== true && (c.hasCredits !== true || (balance !== undefined && balance <= 0))) return false;
  return s!.spendControlReached !== true && !CODEX_CREDITS_STOPPED.has(String(s!.rateLimitReachedType ?? ''));
}

async function askClaude(bin: string, env: NodeJS.ProcessEnv, apiKey: boolean, signal?: AbortSignal): Promise<UsageAnswer> {
  // With no settings files, hooks or MCP servers of its own: only the account's sign-in matters here.
  let answer: UsageAnswer | undefined;
  let error: string | undefined;
  const res = await converse({
    bin,
    cwd: probeDir(),
    env,
    timeoutMs: USAGE_TIMEOUT_MS,
    signal,
    args: [...CLAUDE_PROBE_ARGS, '--setting-sources', '', '--strict-mcp-config', '--settings', JSON.stringify({ disableAllHooks: true })],
    open: (write) => write({ type: 'control_request', request_id: 'relay-usage', request: { subtype: 'get_usage' } }),
    onMessage: (m, _write, finish) => {
      if (m.type !== 'control_response' || m.response?.request_id !== 'relay-usage') return;
      if (m.response.subtype === 'error') error = String(m.response.error ?? 'error');
      else answer = parseClaudeUsage(m.response.response, apiKey);
      finish();
    },
  });
  return answer ?? failure(error, res.timedOut, res.stderr);
}

// ---------------------------------------------------------------------------
// Codex

/**
 * Codex's answers to `account/read` (who it is signed in as: a ChatGPT plan, or an API key) and
 * `account/rateLimits/read` (each limit's windows, by limit id when it has several, and the credits,
 * which pay past the plan's own limit and its block while they can: `codexCreditsPay`).
 */
export function parseCodexUsage(account: unknown, rateLimits: unknown): UsageAnswer | undefined {
  const a = (account as Record<string, any> | undefined)?.account;
  if (account && typeof account === 'object' && a === null) return none('signedOut');
  if (a?.type === 'apiKey') return none('apiKey');
  const r = rateLimits as Record<string, any> | undefined;
  if (!r || typeof r !== 'object') return undefined;
  const byId = r.rateLimitsByLimitId && typeof r.rateLimitsByLimitId === 'object' ? Object.values(r.rateLimitsByLimitId) : [];
  const snapshots = (byId.length ? byId : [r.rateLimits]).filter((s): s is Record<string, any> => Boolean(s) && typeof s === 'object');
  // The plan's own limit, which alone carries the account's credits; `rateLimits` is it when the
  // answer has no list (the app-server fills it with the `codex` snapshot, else the first).
  const main = (r.rateLimitsByLimitId?.codex ?? r.rateLimits) as Record<string, any> | undefined;
  const pays = codexCreditsPay(main);
  const limits: UsageLimit[] = [];
  /** Which of `limits` belong to the plan's own limit, which credits pay past. */
  const plans = new Set<number>();
  let plan = text(a?.planType);
  let credits: AccountUsage['credits'];
  for (const s of snapshots) {
    plan ??= text(s.planType);
    // The default limit ("codex") needs no name; another one (a model's own) is named.
    const model = text(s.normalModelSlug);
    const own = !model && (s === main || text(s.limitId) === 'codex');
    const scope = text(s.limitId) === 'codex' && !model ? undefined : (text(s.limitName) ?? model ?? text(s.limitId));
    for (const w of [s.primary, s.secondary]) {
      const usedPercent = num(w?.usedPercent);
      if (usedPercent === undefined) continue;
      const minutes = num(w.windowDurationMins);
      const span = minutes === undefined ? undefined : spanOfMinutes(minutes);
      const resetsAt = when(w.resetsAt);
      if (own && !scope) plans.add(limits.length);
      limits.push({
        ...(span ? { span } : minutes ? { minutes } : {}),
        ...(scope ? { scope } : {}),
        ...(model ? { model } : {}),
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  // The plan's own snapshot's credits, else the first another one has.
  for (const s of main ? [main, ...snapshots] : snapshots) {
    const c = s.credits;
    if (!c || !(c.hasCredits || c.unlimited)) continue;
    const balance = num(c.balance);
    credits = { ...(balance !== undefined ? { balance } : {}), ...(c.unlimited ? { unlimited: true } : {}) };
    break;
  }
  return {
    ...(plan ? { plan } : {}),
    ...paidBy(limits, pays ? 'credits' : undefined, (_, i) => plans.has(i)),
    ...(r.ordinaryUsageAllowed === false ? { planUsageBlocked: true } : {}),
    ...(credits ? { credits } : {}),
    ...(limits.length || credits ? {} : { none: 'noData' as const }),
  };
}

async function askCodex(bin: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<UsageAnswer> {
  const answers: { account?: unknown; rateLimits?: unknown } = {};
  let error: string | undefined;
  const res = await converse({
    bin,
    args: ['app-server'],
    cwd: probeDir(),
    env,
    timeoutMs: USAGE_TIMEOUT_MS,
    signal,
    open: (write) =>
      write({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { clientInfo: { name: 'harness_relay', title: 'Harness Relay', version: '0.1.0' }, capabilities: null },
      }),
    onMessage: (m, write, finish) => {
      if (m.id === undefined || m.method) return;
      if (m.id === 0) {
        write({ jsonrpc: '2.0', method: 'initialized' });
        write({ jsonrpc: '2.0', id: 1, method: 'account/read', params: { refreshToken: false } });
        return;
      }
      if (m.id === 1) {
        // A Codex without `account/read` may still answer the limits.
        if (m.error) error = String(m.error.message ?? 'error');
        else {
          answers.account = m.result ?? {};
          // Signed out or on an API key: there are no plan limits to ask about.
          const acct = (answers.account as Record<string, any>).account;
          if (acct === null || acct?.type === 'apiKey') return finish();
        }
        write({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' });
        return;
      }
      if (m.id === 2) {
        if (m.error) error = String(m.error.message ?? 'error');
        else answers.rateLimits = m.result ?? {};
        finish();
      }
    },
  });
  const answer = answers.account || answers.rateLimits ? parseCodexUsage(answers.account, answers.rateLimits) : undefined;
  return answer ?? failure(error, res.timedOut, res.stderr);
}

// ---------------------------------------------------------------------------
// Grok

/** Grok's span for its billing period (`USAGE_PERIOD_TYPE_WEEKLY` and the like). */
function grokSpan(type: unknown): UsageSpan | undefined {
  const s = String(type ?? '').toUpperCase();
  if (s.endsWith('WEEKLY')) return 'week';
  if (s.endsWith('MONTHLY')) return 'month';
  if (s.endsWith('DAILY')) return 'day';
  return undefined;
}

/**
 * What pays once Grok's plan allowance is used up, which xAI says is "not a hard stop": prepaid Extra
 * Usage Credits left (`config.prepaidBalance`), else pay-as-you-go turned on (`on_demand_enabled`) with
 * room below its spending cap (`config.onDemandUsed` below `config.onDemandCap`; a cap of 0 leaves none).
 */
function grokPayer(o: Record<string, any>, c: Record<string, any> | undefined): UsagePayer | undefined {
  if ((num(c?.prepaidBalance?.val) ?? 0) > 0) return 'credits';
  const cap = num(c?.onDemandCap?.val) ?? 0;
  if (o.on_demand_enabled === true && cap > 0 && (num(c?.onDemandUsed?.val) ?? 0) < cap) return 'payAsYouGo';
  return undefined;
}

/**
 * Grok's answer to `_x.ai/billing`: its plan (`subscription_tier`) and the share of the period's
 * credits used (`config.creditUsagePercent`), with the period it counts in, and what pays past it once
 * it is used up (`grokPayer`).
 */
export function parseGrokUsage(r: unknown): UsageAnswer | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const o = r as Record<string, any>;
  const plan = text(o.subscription_tier);
  const c = o.config as Record<string, any> | undefined;
  const usedPercent = num(c?.creditUsagePercent);
  if (usedPercent === undefined) return plan ? none('noData', plan) : undefined;
  const span = grokSpan(c?.currentPeriod?.type);
  const resetsAt = when(c?.currentPeriod?.end) ?? when(c?.billingPeriodEnd);
  return {
    ...(plan ? { plan } : {}),
    ...paidBy([{ ...(span ? { span } : {}), usedPercent: clampPercent(usedPercent), ...(resetsAt ? { resetsAt } : {}) }], grokPayer(o, c)),
  };
}

/** Grok's words for a billing request without a grok.com sign-in. */
const GROK_SIGNED_OUT = /requires auth|authentication required|not (signed|logged) in|run `?grok login/i;

async function askGrok(bin: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<UsageAnswer> {
  let answer: UsageAnswer | undefined;
  let error: string | undefined;
  const res = await converse({
    bin,
    args: ['agent', '--no-leader', 'stdio'],
    cwd: probeDir(),
    // Nothing of the user's own setup is needed to read the billing.
    env: { ...env, ...grokNativeEnv(['skills', 'mcp', 'memory', 'hooks']) },
    timeoutMs: USAGE_TIMEOUT_MS,
    signal,
    open: (write) =>
      write({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
      }),
    onMessage: (m, write, finish) => {
      if (m.id === undefined || m.method) return;
      if (m.id === 1) {
        if (m.error) {
          error = String(m.error.message ?? 'error');
          return finish();
        }
        write({ jsonrpc: '2.0', id: 2, method: '_x.ai/billing', params: {} });
        return;
      }
      if (m.id === 2) {
        if (m.error) error = String(m.error.data?.message ?? m.error.message ?? 'error');
        else answer = parseGrokUsage(m.result);
        finish();
      }
    },
  });
  if (answer) return answer;
  if (error && GROK_SIGNED_OUT.test(error)) return none('signedOut');
  return failure(error, res.timedOut, res.stderr);
}

// ---------------------------------------------------------------------------
// Muse Code

/**
 * `muse usage --json`: `{"schemaVersion": 1, "allowance": {"usedPercent", "resetsAtMs"} | null,
 * "reason": "api_key" | "no_allowance" | "server_sent_no_usage" | …, "hint"}`.
 */
export function parseMuseUsage(stdout: string): UsageAnswer | undefined {
  let o: Record<string, any>;
  try {
    o = JSON.parse(stdout.trim()) as Record<string, any>;
  } catch {
    return undefined;
  }
  if (!o || typeof o !== 'object') return undefined;
  const a = o.allowance as Record<string, any> | null | undefined;
  const usedPercent = num(a?.usedPercent);
  if (usedPercent !== undefined) {
    const resetsAt = when(a?.resetsAtMs);
    return { limits: [{ usedPercent: clampPercent(usedPercent), ...(resetsAt ? { resetsAt } : {}) }] };
  }
  switch (o.reason) {
    case 'api_key':
      return none('apiKey');
    case 'no_allowance':
      return none('noAllowance');
    case 'server_sent_no_usage':
      return none('noData');
    default: {
      const said = text(o.hint) ?? text(o.reason);
      return said ? failed(said) : trouble('noAnswer');
    }
  }
}

async function askMuse(bin: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<UsageAnswer> {
  const r = await runProcess({
    bin,
    args: ['usage', '--json'],
    env: museProbeEnv(env),
    signal,
    timeoutMs: USAGE_TIMEOUT_MS,
    maxCapture: 1024 * 1024,
  });
  const out = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
  if (/not logged in|run `?muse login/i.test(out)) return none('signedOut');
  return parseMuseUsage(r.stdout) ?? failure(undefined, r.timedOut, out);
}

// ---------------------------------------------------------------------------
// Copilot

/** The kinds of Copilot's quota snapshots the UI names, in the order shown. */
const COPILOT_KINDS: Record<string, UsageKind> = { premium_interactions: 'premiumRequests', chat: 'chat', completions: 'completions' };

/**
 * Copilot's answers to `account.getQuota` (`quotaSnapshots`: each kind's entitlement, requests used
 * and percent left) and `account.getCurrentAuth` (the GitHub user Copilot reports, with its plan and
 * when its quota resets: `getQuota`'s own `resetDate` is when the snapshot was taken). A kind without
 * a limit (`isUnlimitedEntitlement`) is left out; a plan with none at all has no limits. Additional
 * paid usage pays past a kind whose overage is allowed (`overageAllowedWithExhaustedQuota`).
 */
export function parseCopilotUsage(quota: unknown, auth: unknown): UsageAnswer | undefined {
  const snaps = (quota as Record<string, any> | undefined)?.quotaSnapshots;
  if (!snaps || typeof snaps !== 'object') return undefined;
  const a = auth as Record<string, any> | undefined;
  const user = (a?.authInfo?.copilotUser ?? a?.copilotUser) as Record<string, any> | undefined;
  const plan = text(user?.copilot_plan) ?? text(user?.access_type_sku);
  const resetAll = when(user?.quota_reset_date_utc) ?? when(user?.quota_reset_date);
  const known = Object.keys(COPILOT_KINDS).filter((k) => k in snaps);
  const keys = [...known, ...Object.keys(snaps).filter((k) => !(k in COPILOT_KINDS))];
  const limits: UsageLimit[] = [];
  /** Which of `limits` additional paid usage goes past. */
  const overages = new Set<number>();
  let unlimited = false;
  for (const key of keys) {
    const s = snaps[key] as Record<string, any> | undefined;
    if (!s || typeof s !== 'object') continue;
    const total = num(s.entitlementRequests);
    if (s.isUnlimitedEntitlement || total === -1) {
      unlimited = true;
      continue;
    }
    const left = num(s.remainingPercentage);
    if (total === undefined || total <= 0 || left === undefined) continue;
    const used = num(s.usedRequests);
    const kind = COPILOT_KINDS[key];
    const resetsAt = when(user?.quota_snapshots?.[key]?.quota_reset_at) ?? resetAll;
    // Additional paid usage allowed once this kind's quota is used up: Copilot keeps running ("Plan:
    // additional usage"). getQuota's flag, else the user record's; false again once its cap is reached.
    const overage = s.overageAllowedWithExhaustedQuota ?? user?.quota_snapshots?.[key]?.overage_permitted;
    if (overage === true) overages.add(limits.length);
    limits.push({
      span: 'month',
      ...(kind ? { kind } : { scope: key }),
      usedPercent: clampPercent(100 - left),
      ...(used !== undefined ? { used, total } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return {
    ...(plan ? { plan } : {}),
    ...paidBy(limits, overages.size ? 'additionalUsage' : undefined, (_, i) => overages.has(i)),
    ...(limits.length ? {} : { none: unlimited ? ('unlimited' as const) : ('noData' as const) }),
  };
}

/** Copilot's words for a question asked without a sign-in. */
const COPILOT_SIGNED_OUT = /not authenticated|authenticate first|authentication required/i;

/**
 * Asks Copilot over its headless server (`copilot --headless --stdio`, the JSON-RPC its SDK speaks;
 * its ACP has no such question), without a session: `connect`, then `account.getQuota` and
 * `account.getCurrentAuth`. In a home of the question's own with a copy of the account's sign-in
 * state, as its status is asked (`prepareCopilotProbeHome`), and a cache folder of its own, where
 * Copilot would otherwise keep an earlier answer.
 */
async function askCopilot(bin: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<UsageAnswer> {
  const probe = prepareCopilotProbeHome(copilotHome(env));
  try {
    const answers: { quota?: unknown; auth?: unknown } = {};
    let error: string | undefined;
    const said = (m: Record<string, any>) => String(m.error?.data?.message ?? m.error?.message ?? 'error');
    const res = await converseFramed({
      bin,
      args: ['--headless', '--stdio', '--no-auto-update'],
      cwd: probe.cwd!,
      env: { ...copilotProbeEnv(env, probe.dir), COPILOT_CACHE_HOME: join(probe.dir, 'cache'), COPILOT_AUTO_UPDATE: 'false' },
      timeoutMs: USAGE_TIMEOUT_MS,
      signal,
      open: (write) => write({ jsonrpc: '2.0', id: 1, method: 'connect', params: {} }),
      onMessage: (m, write, finish) => {
        if (m.id === undefined || m.method) return;
        if (m.id === 1) {
          if (m.error) {
            error = said(m);
            return finish();
          }
          write({ jsonrpc: '2.0', id: 2, method: 'account.getQuota', params: {} });
          write({ jsonrpc: '2.0', id: 3, method: 'account.getCurrentAuth', params: {} });
          return;
        }
        if (m.id === 2) {
          if (m.error) {
            error = said(m);
            return finish();
          }
          answers.quota = m.result ?? {};
        }
        // Without it the limits still show, without their plan and reset time.
        if (m.id === 3) answers.auth = m.error ? {} : (m.result ?? {});
        if (answers.quota !== undefined && answers.auth !== undefined) finish();
      },
    });
    if (error && COPILOT_SIGNED_OUT.test(error)) return none('signedOut');
    const answer = answers.quota !== undefined ? parseCopilotUsage(answers.quota, answers.auth) : undefined;
    return answer ?? failure(error, res.timedOut, res.stderr);
  } finally {
    probe.done();
  }
}

// ---------------------------------------------------------------------------
// Antigravity

/** The span of one of Antigravity's buckets, from its `window` ("5h", "weekly"…), when it is a usual one. */
function windowSpan(w: unknown): UsageSpan | undefined {
  const s = String(w ?? '').toLowerCase();
  if (/^(5\s*h|5[-\s]?hours?|five[-_\s]?hours?)/.test(s)) return 'fiveHour';
  if (/week|^7\s*d/.test(s)) return 'week';
  if (/month|^30\s*d/.test(s)) return 'month';
  if (/day|daily|^24\s*h/.test(s)) return 'day';
  return undefined;
}

/**
 * Antigravity's answers to `/usage` (`groups` of `buckets`, each with the fraction of it left, its
 * `window` and when it resets) and `/credits` (`remaining_credits`, and `plan_name` when it has one) in
 * print mode, as agy types them (read from 1.5.8's binary; seen from 1.5.14 with a Google AI Pro
 * account's quota unused). The account's AI credits, when it turned them on (`aiCredits`:
 * `antigravityAiCredits`, since neither answer says) and has some left, pay past every quota.
 */
export function parseAntigravityUsage(usage: unknown, credits: unknown, aiCredits = false): UsageAnswer | undefined {
  const u = usage as Record<string, any> | undefined;
  if (!u || typeof u !== 'object') return undefined;
  const groups = (Array.isArray(u.groups) ? u.groups : []).filter(
    (g: unknown): g is Record<string, any> => Boolean(g) && typeof g === 'object',
  );
  const several = groups.length > 1;
  const limits: UsageLimit[] = [];
  for (const g of groups) {
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      if (!b || typeof b !== 'object' || b.disabled) continue;
      const left = num(b.remaining_fraction);
      if (left === undefined) continue;
      const span = windowSpan(b.window);
      const scope = [several ? text(g.name) : undefined, text(b.name)].filter(Boolean).join(' · ');
      const resetsAt = when(b.reset_time);
      limits.push({
        ...(span ? { span } : {}),
        ...(scope ? { scope } : {}),
        usedPercent: clampPercent((1 - left) * 100),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  const c = credits as Record<string, any> | undefined;
  const plan = text(c?.plan_name);
  const balance = num(c?.remaining_credits);
  // No credits on a plan without them: a zero says nothing then.
  const withCredits = balance !== undefined && (balance > 0 || Boolean(plan));
  return {
    ...(plan ? { plan } : {}),
    ...paidBy(limits, aiCredits && balance !== undefined && balance > 0 ? 'credits' : undefined),
    ...(withCredits ? { credits: { balance } } : {}),
    ...(limits.length || withCredits ? {} : { none: 'noData' as const }),
  };
}

/** The last line of `stdout` that is a JSON object: agy's answer, after anything it printed before it. */
function lastJsonObject(stdout: string): Record<string, any> | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.startsWith('{')) continue;
    try {
      const v: unknown = JSON.parse(lines[i]!);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
    } catch {
      // not this line
    }
  }
  return undefined;
}

/** What agy prints when a print-mode command finds no sign-in, before it waits for a code. */
const ANTIGRAVITY_SIGN_IN_ASKED = /authentication required|visit the url to log in/i;
/** Antigravity's words for a print-mode command without a sign-in. */
const ANTIGRAVITY_SIGNED_OUT = /sign in|authentication failed|not (signed|logged) in/i;

/** One of the commands Antigravity answers in print mode without a turn (`agy -p /usage --output-format json`). */
async function askAntigravityCommand(
  bin: string,
  env: NodeJS.ProcessEnv,
  command: string,
  signal?: AbortSignal,
): Promise<{ data?: unknown; failed?: UsageAnswer; signedOut?: boolean }> {
  // Signed out, agy prints a sign-in link and waits a minute for a code, even with its stdin closed
  // (agy 1.5.8): it is stopped as soon as it asks (on stderr).
  const stop = new AbortController();
  if (signal?.aborted) stop.abort();
  else signal?.addEventListener('abort', () => stop.abort(), { once: true });
  let signedOut = false;
  const res = await runProcess({
    bin,
    args: ['-p', command, '--output-format', 'json', ...antigravityProbeSettings(env)],
    cwd: probeDir(),
    env: antigravityProbeEnv(env),
    signal: stop.signal,
    timeoutMs: USAGE_TIMEOUT_MS,
    maxCapture: 1024 * 1024,
    onSpawn: (child) => {
      let said = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        said = (said + chunk.toString('utf8')).slice(-4096);
        if (signedOut || !ANTIGRAVITY_SIGN_IN_ASKED.test(said)) return;
        signedOut = true;
        stop.abort();
      });
    },
  });
  if (signedOut) return { signedOut };
  const j = lastJsonObject(res.stdout);
  if (j?.status === 'SUCCESS') return { data: j.command?.data ?? {} };
  if (j) {
    const error = String(j.error ?? 'error');
    return ANTIGRAVITY_SIGNED_OUT.test(error) ? { signedOut: true } : { failed: failed(error) };
  }
  return { failed: failure(undefined, res.timedOut, res.stderr || res.stdout) };
}

async function askAntigravity(bin: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<UsageAnswer> {
  const usage = await askAntigravityCommand(bin, env, '/usage', signal);
  if (usage.signedOut) return none('signedOut');
  if (usage.failed) return usage.failed;
  // One after the other: two agy processes in the same home at once could get in each other's way.
  // Its credits are a part of the answer only: without them the limits still show.
  const credits = await askAntigravityCommand(bin, env, '/credits', signal);
  const aiCredits = !antigravityKeyOnly(env) && antigravityAiCredits(antigravityAppDir(env));
  return parseAntigravityUsage(usage.data, credits.data, aiCredits) ?? trouble('noAnswer');
}

// ---------------------------------------------------------------------------
// Cursor

/** `cursor-agent about --format json`: its plan only (`subscriptionTier`). */
export function parseCursorAbout(stdout: string): UsageAnswer | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const o = JSON.parse(stdout.slice(start, end + 1)) as Record<string, any>;
    return none('notReported', text(o.subscriptionTier));
  } catch {
    return undefined;
  }
}

async function askCursor(bin: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<UsageAnswer> {
  const r = await runProcess({
    bin,
    args: ['about', '--format', 'json'],
    env: { ...env, NO_OPEN_BROWSER: '1' },
    signal,
    timeoutMs: USAGE_TIMEOUT_MS,
    maxCapture: 1024 * 1024,
  });
  // Its plan is all it could say: without it, there is still no usage to show.
  return parseCursorAbout(r.stdout) ?? none('notReported');
}

// ---------------------------------------------------------------------------

/**
 * How much of one account's plan is used, asked of its CLI in that account's environment (`env`,
 * with its home and any key it runs on). `signal` stops the CLI (the account was removed, say).
 */
export async function askUsage(p: Provider, bin: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<UsageAnswer> {
  const apiKey = (BILLED_KEY_ENV[p] ?? []).some((k) => env[k]);
  switch (p) {
    case 'claude':
      // Claude Code says by itself that an API key has no plan limits (`rate_limits_available`).
      return askClaude(bin, env, apiKey, signal);
    case 'codex':
      // `account/read` says what it runs on, a key in its environment or one it keeps included.
      return askCodex(bin, env, signal);
    case 'grok':
      return apiKey ? none('apiKey') : askGrok(bin, env, signal);
    case 'muse':
      return apiKey ? none('apiKey') : askMuse(bin, env, signal);
    case 'cursor':
      // `about` reads the computer's one Cursor sign-in (`CURSOR_SHARED_SIGN_IN`), whatever key the
      // account runs on: it would name another plan than the key's.
      return CREDENTIAL_ENV.cursor.some((k) => env[k]) ? none('notReported') : askCursor(bin, env, signal);
    case 'antigravity':
      return apiKey ? none('apiKey') : askAntigravity(bin, env, signal);
    case 'copilot':
      // A GitHub token belongs to the user's own Copilot plan: asked about too.
      return askCopilot(bin, env, signal);
    default:
      return none('notReported');
  }
}
