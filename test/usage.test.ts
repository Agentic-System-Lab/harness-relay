import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { removeTree } from '../src/server/fsRemove';
import { slow } from './timeouts';

/*
 * Plan usage as each CLI reports it (`src/server/usage.ts`): the answers recorded from the real CLIs
 * (`test/fixtures/usage/`: Claude Code 2.1.323 on a Max plan and with an API key, codex-cli 0.167.0
 * on a ChatGPT plan, grok 1.0.77 on SuperGrok, muse 1.4.18 on a Meta account without an allowance,
 * cursor-agent 2026.11.11 on a free plan, copilot 1.0.110 on a GitHub token against a stand-in GitHub
 * API; their e-mail addresses and ids replaced), Antigravity's as agy 1.5.8 types them (no real
 * Google account's answer was seen), and the questions asked, through stand-ins for the CLIs.
 */

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'usage', name), 'utf8');
const json = (name: string) => JSON.parse(fixture(name)) as unknown;

const root = mkdtempSync(join(tmpdir(), 'relay-usage-'));
// Copilot's question runs in a home of its own in the data folder's `tmp`.
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => removeTree(root));

const { askUsage, parseAntigravityUsage, parseClaudeUsage, parseCopilotUsage, parseCodexUsage, parseCursorAbout, parseGrokUsage, parseMuseUsage, spanOfMinutes } =
  await import('../src/server/usage');

describe("Claude Code's get_usage answer", () => {
  it('gives each limit of a Max plan, a model\'s own weekly limit named after the model', () => {
    expect(parseClaudeUsage(json('claude-get-usage-max.json'), false)).toEqual({
      plan: 'max',
      limits: [
        { span: 'week', usedPercent: 55, resetsAt: Date.parse('2026-11-13T13:00:00.565052+00:00') },
        { span: 'week', scope: 'Fable', usedPercent: 0, resetsAt: Date.parse('2026-11-13T13:00:00+00:00') },
      ],
    });
  });

  it('says an account on an API key has no plan limits, and one without them otherwise that they are not available for how it signs in', () => {
    expect(parseClaudeUsage(json('claude-get-usage-api-key.json'), true)).toEqual({ limits: [], none: 'apiKey' });
    // A token from `claude setup-token`, Bedrock or Vertex: not an API key, and not "does not report".
    expect(parseClaudeUsage(json('claude-get-usage-api-key.json'), false)).toEqual({ limits: [], none: 'unavailable' });
  });

  it('reads the per-window fields when the list of limits is there but empty', () => {
    const r = { subscription_type: 'pro', rate_limits: { limits: [], seven_day: { utilization: 30, resets_at: '2026-11-17T00:00:00Z' } } };
    expect(parseClaudeUsage(r, false)).toEqual({ plan: 'pro', limits: [{ span: 'week', usedPercent: 30, resetsAt: Date.parse('2026-11-17T00:00:00Z') }] });
  });

  it('reads the per-window fields of a Claude Code without the list of limits', () => {
    const r = {
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 12.5, resets_at: '2026-11-13T15:00:00Z' },
        seven_day: { utilization: 40, resets_at: '2026-11-17T00:00:00Z' },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 7, resets_at: null },
      },
    };
    expect(parseClaudeUsage(r, false)).toEqual({
      plan: 'pro',
      limits: [
        { span: 'fiveHour', usedPercent: 12.5, resetsAt: Date.parse('2026-11-13T15:00:00Z') },
        { span: 'week', usedPercent: 40, resetsAt: Date.parse('2026-11-17T00:00:00Z') },
        { span: 'week', scope: 'Sonnet', usedPercent: 7 },
      ],
    });
  });

  it('keeps a limit it does not know by its own name, and a percent over 100 at 100', () => {
    const r = { rate_limits: { limits: [{ kind: 'session', group: 'session', percent: 130 }, { kind: 'burst', group: 'other', percent: 3 }] } };
    expect(parseClaudeUsage(r, false)?.limits).toEqual([
      { span: 'fiveHour', usedPercent: 100 },
      { scope: 'burst', usedPercent: 3 },
    ]);
  });

  it('says there is nothing yet when the plan has no limits listed, and nothing at all for an answer that is not one', () => {
    expect(parseClaudeUsage({ subscription_type: 'max', rate_limits: { limits: [] } }, false)).toEqual({ plan: 'max', limits: [], none: 'noData' });
    expect(parseClaudeUsage('nope', false)).toBeUndefined();
    expect(parseClaudeUsage(null, false)).toBeUndefined();
  });
});

describe("Codex's account and rate limits", () => {
  it('gives the weekly window of a ChatGPT plan and its credits', () => {
    expect(parseCodexUsage(json('codex-account-read.json'), json('codex-rate-limits.json'))).toEqual({
      plan: 'prolite',
      limits: [{ span: 'week', usedPercent: 5, resetsAt: 1795003102 * 1000 }],
      credits: { balance: 52831.177348 },
    });
  });

  it('names each limit when there are several, and gives a window of another length in minutes', () => {
    const snapshot = (limitId: string, mins: number, used: number) => ({
      limitId,
      limitName: null,
      normalModelSlug: limitId === 'codex' ? null : 'gpt-6.1-spark',
      primary: { usedPercent: used, windowDurationMins: mins, resetsAt: 1795003102 },
      secondary: limitId === 'codex' ? { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1795500000 } : null,
      credits: { hasCredits: false, unlimited: false, balance: null },
    });
    const r = { rateLimitsByLimitId: { codex: snapshot('codex', 300, 10), spark: snapshot('spark', 120, 50) } };
    expect(parseCodexUsage({ account: { type: 'chatgpt', planType: 'pro' } }, r)).toEqual({
      plan: 'pro',
      limits: [
        { span: 'fiveHour', usedPercent: 10, resetsAt: 1795003102000 },
        { span: 'week', usedPercent: 30, resetsAt: 1795500000000 },
        { minutes: 120, scope: 'gpt-6.1-spark', usedPercent: 50, resetsAt: 1795003102000 },
      ],
    });
  });

  it('says an API key has no plan limits, and a signed-out Codex is signed out', () => {
    expect(parseCodexUsage({ account: { type: 'apiKey' } }, undefined)).toEqual({ limits: [], none: 'apiKey' });
    expect(parseCodexUsage({ account: null, requiresOpenaiAuth: true }, undefined)).toEqual({ limits: [], none: 'signedOut' });
  });

  it('reads the limits of a Codex without account/read, and unlimited credits', () => {
    const r = { rateLimits: { primary: null, secondary: null, credits: { hasCredits: true, unlimited: true, balance: null }, planType: 'enterprise' } };
    expect(parseCodexUsage(undefined, r)).toEqual({ plan: 'enterprise', limits: [], credits: { unlimited: true } });
    expect(parseCodexUsage(undefined, undefined)).toBeUndefined();
  });
});

describe("Grok's billing", () => {
  it('gives the share of the weekly credits used and when the period ends', () => {
    expect(parseGrokUsage(json('grok-billing.json'))).toEqual({
      plan: 'SuperGrok',
      limits: [{ span: 'week', usedPercent: 1, resetsAt: Date.parse('2026-11-17T05:30:27.116040+00:00') }],
    });
  });

  it('keeps the plan of an answer without a share, and nothing of one that is not an answer', () => {
    expect(parseGrokUsage({ subscription_tier: 'Free', config: {} })).toEqual({ plan: 'Free', limits: [], none: 'noData' });
    expect(parseGrokUsage({})).toBeUndefined();
    expect(parseGrokUsage(undefined)).toBeUndefined();
  });

  it('takes the billing period when the current period has no end, and a monthly one', () => {
    const r = { config: { creditUsagePercent: 81, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' }, billingPeriodEnd: '2026-12-01T00:00:00Z' } };
    expect(parseGrokUsage(r)?.limits).toEqual([{ span: 'month', usedPercent: 81, resetsAt: Date.parse('2026-12-01T00:00:00Z') }]);
  });
});

describe("Muse Code's usage --json", () => {
  it('says a Meta account without a subscription allowance has none', () => {
    expect(parseMuseUsage(fixture('muse-usage-no-allowance.json'))).toEqual({ limits: [], none: 'noAllowance' });
  });

  it('gives an allowance, and the reasons it gives for none', () => {
    expect(parseMuseUsage('{"schemaVersion":1,"allowance":{"usedPercent":42.5,"resetsAtMs":1795003102000},"reason":null}')).toEqual({
      limits: [{ usedPercent: 42.5, resetsAt: 1795003102000 }],
    });
    expect(parseMuseUsage('{"schemaVersion":1,"allowance":null,"reason":"api_key"}')).toEqual({ limits: [], none: 'apiKey' });
    expect(parseMuseUsage('{"schemaVersion":1,"allowance":null,"reason":"server_sent_no_usage"}')).toEqual({ limits: [], none: 'noData' });
    expect(parseMuseUsage('{"schemaVersion":1,"allowance":null,"reason":"later","hint":"Try again later"}')).toEqual({ limits: [], error: 'Try again later' });
    // Nothing it says: Harness Relay's own reason, for the UI to word.
    expect(parseMuseUsage('{"schemaVersion":1,"allowance":null,"reason":null}')).toEqual({ limits: [], problem: 'noAnswer' });
    expect(parseMuseUsage('not json')).toBeUndefined();
  });
});

describe("Copilot's quota", () => {
  it('gives the premium requests of a monthly plan, counted, with the reset its user record names', () => {
    expect(parseCopilotUsage(json('copilot-get-quota.json'), json('copilot-current-auth.json'))).toEqual({
      plan: 'individual',
      limits: [{ span: 'month', kind: 'premiumRequests', usedPercent: 100 - 41.16666666666667, used: 176, total: 300, resetsAt: 1796083200 * 1000 }],
    });
  });

  it("takes the plan's reset date when a kind has none of its own, never getQuota's resetDate (when the snapshot was taken)", () => {
    const quota = { quotaSnapshots: { premium_interactions: { entitlementRequests: 50, usedRequests: 10, remainingPercentage: 80, resetDate: '2026-11-13T10:00:00Z' } } };
    const auth = { authInfo: { copilotUser: { access_type_sku: 'free_limited_copilot', quota_reset_date_utc: '2026-12-01T00:00:00Z' } } };
    expect(parseCopilotUsage(quota, auth)).toEqual({
      plan: 'free_limited_copilot',
      limits: [{ span: 'month', kind: 'premiumRequests', usedPercent: 20, used: 10, total: 50, resetsAt: Date.parse('2026-12-01T00:00:00Z') }],
    });
    expect(parseCopilotUsage(quota, {})?.limits).toEqual([{ span: 'month', kind: 'premiumRequests', usedPercent: 20, used: 10, total: 50 }]);
  });

  it('names a kind it does not know by its key, and says a plan without any limit has none', () => {
    const quota = { quotaSnapshots: { ai_credits: { entitlementRequests: 1000, usedRequests: 250, remainingPercentage: 75 } } };
    expect(parseCopilotUsage(quota, undefined)?.limits).toEqual([{ span: 'month', scope: 'ai_credits', usedPercent: 25, used: 250, total: 1000 }]);
    const unlimited = { isUnlimitedEntitlement: true, entitlementRequests: 0, usedRequests: 0, remainingPercentage: 100 };
    expect(parseCopilotUsage({ quotaSnapshots: { chat: unlimited, premium_interactions: { ...unlimited, entitlementRequests: -1 } } }, {})).toEqual({ limits: [], none: 'unlimited' });
    expect(parseCopilotUsage({}, {})).toBeUndefined();
  });
});

describe("Antigravity's /usage and /credits", () => {
  const bucket = (name: string, left: number, window?: string) => ({ name, remaining_fraction: left, ...(window ? { window } : {}), reset_time: '2026-11-13T18:00:00Z' });

  it("gives each bucket's share used, its window's span, and the plan and credits", () => {
    const usage = { groups: [{ name: 'Models', buckets: [bucket('Gemini 3.1 Pro', 0.25, '5h'), bucket('Gemini 3.8 Flash', 1, 'weekly'), { name: 'Off', remaining_fraction: 0, disabled: true }] }] };
    expect(parseAntigravityUsage(usage, { remaining_credits: 1500, plan_name: 'Google AI Pro' })).toEqual({
      plan: 'Google AI Pro',
      limits: [
        { span: 'fiveHour', scope: 'Gemini 3.1 Pro', usedPercent: 75, resetsAt: Date.parse('2026-11-13T18:00:00Z') },
        { span: 'week', scope: 'Gemini 3.8 Flash', usedPercent: 0, resetsAt: Date.parse('2026-11-13T18:00:00Z') },
      ],
      credits: { balance: 1500 },
    });
  });

  it("names each bucket after its group when there are several, and keeps a window it does not know as the bucket's own", () => {
    const usage = { groups: [{ name: 'Pro', buckets: [bucket('Requests', 0.5, 'per-request')] }, { name: 'Flash', buckets: [bucket('Requests', 0.9)] }] };
    expect(parseAntigravityUsage(usage, undefined)?.limits.map((l) => [l.span, l.scope, Math.round(l.usedPercent)])).toEqual([
      [undefined, 'Pro · Requests', 50],
      [undefined, 'Flash · Requests', 10],
    ]);
  });

  it('says there is nothing to show for no buckets and no credits (a Gemini API key), a zero of credits without a plan saying nothing', () => {
    expect(parseAntigravityUsage({ groups: [] }, { remaining_credits: 0 })).toEqual({ limits: [], none: 'noData' });
    expect(parseAntigravityUsage(undefined, undefined)).toBeUndefined();
  });
});

describe("Cursor's about", () => {
  it('gives the plan only: its usage shows in its own terminal UI alone', () => {
    expect(parseCursorAbout(fixture('cursor-about.json'))).toEqual({ plan: 'Free', limits: [], none: 'notReported' });
    expect(parseCursorAbout('Not signed in')).toBeUndefined();
  });
});

it('names the usual window lengths', () => {
  expect([300, 1440, 10080, 43200, 120].map(spanOfMinutes)).toEqual(['fiveHour', 'day', 'week', 'month', undefined]);
});

describe('an account on a key its provider bills by use', () => {
  // A command that is not there: had it been started, the ask would throw.
  const missing = join(root, 'no-such-cli');

  it('has no plan limits, without its CLI being asked', async () => {
    expect(await askUsage('grok', missing, { XAI_API_KEY: 'xai-test' })).toEqual({ limits: [], none: 'apiKey' });
    expect(await askUsage('muse', missing, { META_API_KEY: 'meta-test' })).toEqual({ limits: [], none: 'apiKey' });
    expect(await askUsage('antigravity', missing, { GEMINI_API_KEY: 'g-test' })).toEqual({ limits: [], none: 'apiKey' });
  });

  it("but Codex is asked (its account/read says what it runs on), and Copilot's GitHub token belongs to the user's own plan", async () => {
    await expect(askUsage('codex', missing, { OPENAI_API_KEY: 'sk-test' })).rejects.toThrow();
    await expect(askUsage('copilot', missing, { COPILOT_GITHUB_TOKEN: 'github_pat_test', COPILOT_HOME: join(root, 'copilot-home') })).rejects.toThrow();
  });

  it("and Cursor's key is not reported (its about would describe the computer's one sign-in, not the key's plan)", async () => {
    expect(await askUsage('cursor', missing, { CURSOR_API_KEY: 'key_test' })).toEqual({ limits: [], none: 'notReported' });
  });

  it('and an open agent has no plan', async () => {
    expect(await askUsage('opencode', missing, {})).toEqual({ limits: [], none: 'notReported' });
  });
});

/*
 * A stand-in for the CLIs, by the name it is started under: it answers what Harness Relay asks with
 * the recorded answers, and logs its arguments, working directory and the requests it got to
 * STAND_LOG. STAND_* variables steer it (signed out, refusing, failing, hanging…).
 */
const STAND_IN = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
const answer = (file) => JSON.parse(fs.readFileSync(path.join(env.STAND_FIXTURES, file), 'utf8'));
const log = (o) => fs.appendFileSync(env.STAND_LOG, JSON.stringify({ name, ...o }) + '\\n');
log({ args, cwd: process.cwd(), mcp: env.GROK_CLAUDE_MCPS_ENABLED, home: env.COPILOT_HOME, cache: env.COPILOT_CACHE_HOME });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const hang = () => setTimeout(() => {}, 60000);
if (env.STAND_HANG) { hang(); return; }
if (name === 'muse') {
  if (env.STAND_SIGNED_OUT) { process.stderr.write('not logged in: run \\x60muse login\\x60 first\\n'); process.exit(1); }
  if (env.STAND_FAIL) { process.stderr.write('muse: something broke\\n'); process.exit(2); }
  process.stdout.write(fs.readFileSync(path.join(env.STAND_FIXTURES, 'muse-usage-no-allowance.json'), 'utf8'));
  process.exit(0);
}
if (name === 'cursor-agent') {
  if (env.STAND_FAIL) { process.stderr.write('fake cursor: no\\n'); process.exit(1); }
  process.stdout.write(fs.readFileSync(path.join(env.STAND_FIXTURES, 'cursor-about.json'), 'utf8'));
  process.exit(0);
}
if (name === 'agy') {
  // Signed out, it asks on stderr and waits for a code, as agy 1.5.8 does.
  if (env.STAND_SIGNED_OUT) { process.stderr.write('Authentication required. Please visit the URL to log in:\\n  https://accounts.example.invalid/\\n'); hang(); return; }
  const command = args[1].slice(1);
  if (env.STAND_FAIL === command) { out({ conversation_id: '', status: 'ERROR', error: 'quota service unavailable' }); process.exit(1); }
  const data = command === 'usage'
    ? { groups: [{ name: 'Models', buckets: [{ name: 'Gemini 3.1 Pro', window: '5h', remaining_fraction: 0.4, reset_time: '2026-11-13T18:00:00Z' }] }] }
    : { remaining_credits: 1000, plan_name: 'Google AI Pro' };
  if (env.STAND_NOISE) process.stdout.write('Loading quota…\\n');
  out({ conversation_id: '', status: 'SUCCESS', response: '', num_turns: 0, command: { name: command, data } });
  process.exit(0);
}
if (name === 'copilot') {
  const send = (o) => { const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...o })); process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n'); process.stdout.write(body); };
  let raw = Buffer.alloc(0);
  process.stdin.on('data', (d) => {
    raw = Buffer.concat([raw, d]);
    for (;;) {
      const end = raw.indexOf('\\r\\n\\r\\n');
      if (end < 0) return;
      const length = Number(/Content-Length: (\\d+)/.exec(raw.subarray(0, end).toString())[1]);
      if (raw.length < end + 4 + length) return;
      const m = JSON.parse(raw.subarray(end + 4, end + 4 + length).toString());
      raw = raw.subarray(end + 4 + length);
      log({ method: m.method });
      if (m.method === 'connect' && env.STAND_CONNECT_FAIL) send({ id: m.id, error: { code: -32600, message: 'protocol version 9 is not supported' } });
      else if (m.method === 'connect') send({ id: m.id, result: { ok: true, protocolVersion: 3 } });
      else if (m.method === 'account.getQuota' && env.STAND_SIGNED_OUT) send({ id: m.id, error: { code: -32603, message: 'Request account.getQuota failed with message: Not authenticated. Please authenticate first.' } });
      // The auth's answer first, when asked: the quota's comes a moment later.
      else if (m.method === 'account.getQuota') setTimeout(() => send({ id: m.id, result: answer('copilot-get-quota.json') }), env.STAND_AUTH_FIRST ? 100 : 0);
      else if (m.method === 'account.getCurrentAuth') send({ id: m.id, result: answer('copilot-current-auth.json') });
    }
  });
  return;
}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method) log({ method: m.method });
    if (name === 'claude' && m.type === 'control_request') {
      if (env.STAND_REFUSE) out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Unsupported control request subtype: ' + m.request.subtype } });
      else out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: answer('claude-get-usage-max.json') } });
    }
    if (name === 'codex' && m.id !== undefined) {
      if (m.method === 'initialize') out({ id: m.id, result: {} });
      // Signed out, or on a key (one in its environment too), as account/read says.
      if (m.method === 'account/read') out({ id: m.id, result: env.STAND_SIGNED_OUT ? { account: null, requiresOpenaiAuth: true } : env.OPENAI_API_KEY ? { account: { type: 'apiKey' }, requiresOpenaiAuth: true } : answer('codex-account-read.json') });
      if (m.method === 'account/rateLimits/read') out({ id: m.id, result: answer('codex-rate-limits.json') });
    }
    if (name === 'grok' && m.id !== undefined) {
      if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
      else if (m.method === '_x.ai/billing' && env.STAND_SIGNED_OUT) out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'Authentication required to fetch billing data' } });
      else if (m.method === '_x.ai/billing') out({ jsonrpc: '2.0', id: m.id, result: answer('grok-billing.json') });
      else out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
`;

describe.skipIf(process.platform === 'win32')('asking each CLI (stand-ins)', () => {
  const bin = (name: string) => {
    const file = join(root, name);
    writeFileSync(file, STAND_IN);
    chmodSync(file, 0o755);
    return file;
  };
  const log = join(root, 'stand.log');
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    STAND_LOG: log,
    STAND_FIXTURES: join(import.meta.dirname, 'fixtures', 'usage'),
    ...extra,
  });
  interface Logged {
    name: string;
    args?: string[];
    cwd?: string;
    mcp?: string;
    home?: string;
    cache?: string;
    method?: string;
  }
  const logged = (): Logged[] =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Logged);
  const started = () => logged().filter((e) => e.args);
  const methods = () => logged().flatMap((e) => (e.method ? [e.method] : []));
  const fresh = () => writeFileSync(log, '');

  it('asks Claude Code get_usage over stream-json, without settings files, hooks or MCP servers, in the same empty folder each time', async () => {
    fresh();
    const answer = await askUsage('claude', bin('claude'), env());
    expect(answer).toMatchObject({ plan: 'max', limits: [{ span: 'week', usedPercent: 55 }, { scope: 'Fable' }] });
    await askUsage('claude', bin('claude'), env());
    const [first, second] = started();
    expect(first!.args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
    ]);
    // In the data folder's tmp, one folder for every ask (Claude Code records each folder it starts in).
    expect(first!.cwd).toBe(realpathSync(join(root, 'data', 'tmp', 'usage-probe')));
    expect(second!.cwd).toBe(first!.cwd);
  });

  it("gives Claude Code's refusal as it was (an older Claude Code without get_usage)", async () => {
    expect(await askUsage('claude', bin('claude'), env({ STAND_REFUSE: '1' }))).toEqual({
      limits: [],
      error: 'Unsupported control request subtype: get_usage',
    });
  });

  it('asks codex app-server for the account and its rate limits', async () => {
    fresh();
    expect(await askUsage('codex', bin('codex'), env())).toEqual({
      plan: 'prolite',
      limits: [{ span: 'week', usedPercent: 5, resetsAt: 1795003102000 }],
      credits: { balance: 52831.177348 },
    });
    expect(started()[0]!.args).toEqual(['app-server']);
    expect(methods()).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  });

  it('asks a signed-out Codex, or one on a key (in its environment too), no more than who it is', async () => {
    fresh();
    expect(await askUsage('codex', bin('codex'), env({ STAND_SIGNED_OUT: '1' }))).toEqual({ limits: [], none: 'signedOut' });
    expect(await askUsage('codex', bin('codex'), env({ OPENAI_API_KEY: 'sk-test' }))).toEqual({ limits: [], none: 'apiKey' });
    expect(methods().filter((m) => m === 'account/rateLimits/read')).toEqual([]);
  });

  it("asks Grok's agent for its billing, with the user's MCP servers and the rest of its own setup left out", async () => {
    fresh();
    expect(await askUsage('grok', bin('grok'), env())).toMatchObject({ plan: 'SuperGrok', limits: [{ span: 'week', usedPercent: 1 }] });
    expect(started()[0]).toMatchObject({ args: ['agent', '--no-leader', 'stdio'], mcp: 'false' });
  });

  it('says a Grok without a grok.com sign-in is signed out', async () => {
    expect(await askUsage('grok', bin('grok'), env({ STAND_SIGNED_OUT: '1' }))).toEqual({ limits: [], none: 'signedOut' });
  });

  it('runs muse usage --json, and says a signed-out Muse Code is signed out, and passes on what a failing one said', async () => {
    fresh();
    expect(await askUsage('muse', bin('muse'), env())).toEqual({ limits: [], none: 'noAllowance' });
    expect(started()[0]!.args).toEqual(['usage', '--json']);
    expect(await askUsage('muse', bin('muse'), env({ STAND_SIGNED_OUT: '1' }))).toEqual({ limits: [], none: 'signedOut' });
    expect(await askUsage('muse', bin('muse'), env({ STAND_FAIL: '1' }))).toEqual({ limits: [], error: 'muse: something broke' });
  });

  it("asks Copilot's headless server for its quota and auth, framed as its SDK frames them, in a home and a cache of the question's own", async () => {
    fresh();
    const account = join(root, 'copilot-account');
    const expected = {
      plan: 'individual',
      limits: [{ span: 'month', kind: 'premiumRequests', usedPercent: 100 - 41.16666666666667, used: 176, total: 300, resetsAt: 1796083200 * 1000 }],
    };
    expect(await askUsage('copilot', bin('copilot'), env({ COPILOT_HOME: account }))).toEqual(expected);
    const [start] = started();
    expect(start!.args).toEqual(['--headless', '--stdio', '--no-auto-update']);
    expect(start!.home).not.toBe(account);
    expect(start!.cache?.startsWith(start!.home!)).toBe(true);
    expect(methods()).toEqual(['connect', 'account.getQuota', 'account.getCurrentAuth']);
    // Its answers in either order.
    expect(await askUsage('copilot', bin('copilot'), env({ COPILOT_HOME: account, STAND_AUTH_FIRST: '1' }))).toEqual(expected);
  });

  it('says a Copilot without a sign-in is signed out, and passes on its refusal to connect', async () => {
    const account = join(root, 'copilot-account');
    expect(await askUsage('copilot', bin('copilot'), env({ COPILOT_HOME: account, STAND_SIGNED_OUT: '1' }))).toEqual({ limits: [], none: 'signedOut' });
    expect(await askUsage('copilot', bin('copilot'), env({ COPILOT_HOME: account, STAND_CONNECT_FAIL: '1' }))).toEqual({
      limits: [],
      error: 'protocol version 9 is not supported',
    });
  });

  it("asks Antigravity's print mode for /usage, then /credits, reading its answer after anything printed before it", async () => {
    fresh();
    const expected = {
      plan: 'Google AI Pro',
      limits: [{ span: 'fiveHour', scope: 'Gemini 3.1 Pro', usedPercent: 60, resetsAt: Date.parse('2026-11-13T18:00:00Z') }],
      credits: { balance: 1000 },
    };
    expect(await askUsage('antigravity', bin('agy'), env())).toEqual(expected);
    expect(started().map((s) => s.args)).toEqual([
      ['-p', '/usage', '--output-format', 'json'],
      ['-p', '/credits', '--output-format', 'json'],
    ]);
    expect(await askUsage('antigravity', bin('agy'), env({ STAND_NOISE: '1' }))).toEqual(expected);
  });

  it("passes on Antigravity's error for /usage, and shows the limits without the credits when /credits fails", async () => {
    expect(await askUsage('antigravity', bin('agy'), env({ STAND_FAIL: 'usage' }))).toEqual({ limits: [], error: 'quota service unavailable' });
    expect(await askUsage('antigravity', bin('agy'), env({ STAND_FAIL: 'credits' }))).toEqual({
      limits: [{ span: 'fiveHour', scope: 'Gemini 3.1 Pro', usedPercent: 60, resetsAt: Date.parse('2026-11-13T18:00:00Z') }],
    });
  });

  it(
    'stops a signed-out Antigravity as soon as it asks for a sign-in, rather than waiting the minute it would',
    async () => {
      const t0 = Date.now();
      expect(await askUsage('antigravity', bin('agy'), env({ STAND_SIGNED_OUT: '1' }))).toEqual({ limits: [], none: 'signedOut' });
      expect(Date.now() - t0).toBeLessThan(15_000);
    },
    slow(40_000),
  );

  it(
    'stops a CLI that does not answer when asked to (the account was removed, say)',
    async () => {
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 200);
      const t0 = Date.now();
      await askUsage('claude', bin('claude'), env({ STAND_HANG: '1' }), stop.signal);
      await askUsage('antigravity', bin('agy'), env({ STAND_HANG: '1' }), stop.signal);
      expect(Date.now() - t0).toBeLessThan(15_000);
    },
    slow(40_000),
  );

  it("reads Cursor's plan from its about, and has no plan to show when about fails", async () => {
    fresh();
    expect(await askUsage('cursor', bin('cursor-agent'), env())).toEqual({ plan: 'Free', limits: [], none: 'notReported' });
    expect(started()[0]!.args).toEqual(['about', '--format', 'json']);
    expect(await askUsage('cursor', bin('cursor-agent'), env({ STAND_FAIL: '1' }))).toEqual({ limits: [], none: 'notReported' });
  });
});
