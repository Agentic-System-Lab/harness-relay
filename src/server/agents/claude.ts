import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import {
  agentLimitsFor,
  endpointEffort,
  PROVIDER_LABEL,
  type NativeItemsOff,
  type NativeOnPart,
  type NativePart,
  type Permission,
  type PlanEntry,
} from '../../shared/types';
import { endpointRunModel, type EndpointModel } from '../backends';
import { outputReserve, runLimits } from '../contextWindow';
import { converse, runProcess, tail } from '../process';
import {
  AgentRunError,
  TURN_TIMEOUT_MS,
  clip,
  imageData,
  parseJsonLine,
  summarizeInput,
  tailText,
  type AgentEvent,
  type AgentRunner,
  type ApprovalRequest,
  type McpServerSpec,
  type OutputSchema,
  type RunOptions,
  type RunResult,
  type RunUsage,
  type SteerTurn,
} from './types';
import { t } from '../i18n';
import { overlaps, patternPath, protectedReads, relayTmpDir, RUN_TMP_PREFIXES } from '../protect';
import { HOOK_WAIT, type HookCall, type TurnHooks } from '../hooks';
import { guardGlobs, guardedNow, type WriteGuard } from '../writeGuard';

/*
 * Claude Code runs as `claude -p` with stream-json in both directions. The prompt goes in as a
 * user message; when the conversation asks the user about actions the permission does not cover,
 * `--permission-prompt-tool stdio` makes Claude Code send each one as a `can_use_tool` control
 * request on stdout and wait for our control response on stdin. Without it, such actions are
 * denied automatically and the model is told.
 */

/** Permission mode when the user is asked / when such actions are refused automatically. */
const PERMISSION_MODE: Record<Permission, { ask: string; deny: string }> = {
  // manual: anything beyond reading asks; dontAsk: anything that would ask is denied.
  'read-only': { ask: 'manual', deny: 'dontAsk' },
  edit: { ask: 'acceptEdits', deny: 'acceptEdits' },
  full: { ask: 'bypassPermissions', deny: 'bypassPermissions' },
};

/**
 * Shell commands pre-approved in edit mode: building, testing, linting and formatting the project.
 * Any other command that needs approval goes to the user (or is denied when the conversation does
 * not ask). Installs, git writes and deletes are never pre-approved.
 */
export const CLAUDE_EDIT_COMMANDS = [
  'mkdir',
  'make',
  // Node
  'npm test',
  'npm run',
  'pnpm test',
  'pnpm run',
  'yarn test',
  'yarn run',
  'bun test',
  'bun run',
  'npx tsc',
  'npx vitest',
  'npx jest',
  'npx eslint',
  'npx prettier',
  'tsc',
  'vitest',
  'jest',
  'eslint',
  'prettier',
  // Python
  'pytest',
  'python -m pytest',
  'python3 -m pytest',
  'uv run pytest',
  'ruff',
  'mypy',
  'black',
  // Rust / Go
  'cargo build',
  'cargo check',
  'cargo test',
  'cargo clippy',
  'cargo fmt',
  'cargo run',
  'go build',
  'go test',
  'go vet',
  'gofmt',
];

/**
 * The rule that sends every command the model runs outside the sandbox (`dangerouslyDisableSandbox`)
 * to the user. An ask rule beats allow rules, so the edit commands above cannot leave it unasked.
 */
export const CLAUDE_UNSANDBOXED_RULE = 'Bash(dangerouslyDisableSandbox:true)';

/**
 * Claude Code's own sandbox below full access (`sandbox` in `--settings`): its Bash commands, and
 * what they start, run in the OS sandbox (Seatbelt on macOS, bubblewrap on Linux and WSL2), which
 * lets them write in the working directory, its added folders and the temp folders only, and asks
 * about every network host (a `SandboxNetworkAccess` request).
 * - `failIfUnavailable`: no sandbox, no run, rather than commands run without one.
 * - `autoAllowBashIfSandboxed: false`: the permission, not the sandbox, still decides what runs
 *   without asking.
 * - `denyRead` / `denyWrite`: the paths it may not read or write (`protectedReads()`: the browsers'
 *   folders, Harness Relay's database, also when the working directory holds it); and `Read` deny
 *   rules for the same, since its own file tools are outside the sandbox.
 * Claude Code has no sandbox on native Windows, so there it runs without one, as before.
 */
export function claudeSandboxSettings(
  permission: Permission,
  platform: NodeJS.Platform = process.platform,
  denyRead: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (permission === 'full' || platform === 'win32') return undefined;
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      // `disabled: false` here wins over a user's setting that turns file isolation off.
      filesystem: { disabled: false, ...(denyRead.length ? { denyRead: [...denyRead], denyWrite: [...denyRead] } : {}) },
    },
    permissions: {
      ask: [CLAUDE_UNSANDBOXED_RULE],
      ...(denyRead.length ? { deny: denyRead.flatMap(claudeDenyReadRules) } : {}),
    },
  };
}

/** `Read` deny rules for a path, a file or a folder (Claude Code's `Read` rules cover its Grep and Glob too). */
export function claudeDenyReadRules(path: string): string[] {
  const folder = claudeReadRule(path); // Read(//path/**)
  return [folder.replace(/\/\*\*\)$/, ')'), folder];
}

/** The user's own Claude Code settings file, in its home (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
export function claudeUserSettings(env: NodeJS.ProcessEnv): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}

// --- Usage --------------------------------------------------------------------------------------

/** Cost and tokens as Claude Code counts them (input with the cached tokens read and written). */
export interface ClaudeTally {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

const NOTHING_USED: ClaudeTally = { costUsd: 0, inputTokens: 0, outputTokens: 0 };

/**
 * Claude Code's record of a session: `<its home>/projects/<folder>/<session id>.jsonl`, the folder
 * being the working directory's path with every character but a letter or digit as `-` (cut and
 * hashed when that is too long), so it is otherwise looked for in every project folder by its name.
 */
export function claudeSessionFile(env: NodeJS.ProcessEnv, cwd: string, sessionId: string): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const name = `${sessionId}.jsonl`;
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // the path as given
  }
  const named = [...new Set([cwd, real].map((p) => p.replace(/[^a-zA-Z0-9]/g, '-')))];
  let all: string[] = [];
  try {
    all = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const folder of [...named, ...all]) {
    const file = join(projects, folder, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** The tokens of every model in a `modelUsage` (a result's, or a `cost-state` record's), or undefined without one. */
export function claudeModelTokens(modelUsage: unknown): Pick<ClaudeTally, 'inputTokens' | 'outputTokens'> | undefined {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  let inputTokens = 0;
  let outputTokens = 0;
  for (const m of Object.values(modelUsage as Record<string, any>)) {
    inputTokens += num(m?.inputTokens) + num(m?.cacheReadInputTokens) + num(m?.cacheCreationInputTokens);
    outputTokens += num(m?.outputTokens);
  }
  return { inputTokens, outputTokens };
}

/** The cost of every model in a `modelUsage` (`costUSD`), or undefined when none has one. */
function claudeModelCost(modelUsage: unknown): number | undefined {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return undefined;
  let cost: number | undefined;
  for (const m of Object.values(modelUsage as Record<string, any>)) {
    if (typeof m?.costUSD === 'number' && Number.isFinite(m.costUSD) && m.costUSD >= 0) cost = (cost ?? 0) + m.costUSD;
  }
  return cost;
}

/** Two `modelUsage`s added up, model by model (undefined when neither is one). */
export function addModelUsage(a: unknown, b: unknown): Record<string, Record<string, unknown>> | undefined {
  const isUsage = (v: unknown): v is Record<string, Record<string, unknown>> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  if (!isUsage(a)) return isUsage(b) ? b : undefined;
  if (!isUsage(b)) return a;
  const sum: Record<string, Record<string, unknown>> = { ...a };
  for (const [model, m] of Object.entries(b)) {
    const was = sum[model];
    if (!was || typeof was !== 'object' || !m || typeof m !== 'object') {
      sum[model] = m;
      continue;
    }
    const both: Record<string, unknown> = { ...was, ...m };
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
      both[key] = (typeof was[key] === 'number' ? was[key] : 0) + (typeof m[key] === 'number' ? m[key] : 0);
    }
    // A cost only one of them has is not the model's cost: not known then.
    if (typeof was.costUSD === 'number' && typeof m.costUSD === 'number') both.costUSD = was.costUSD + m.costUSD;
    else delete both.costUSD;
    sum[model] = both;
  }
  return sum;
}

/** How far back from the end of a session's file its last `cost-state` record is looked for. */
const COST_STATE_SCAN = 16 * 1024 * 1024;

/**
 * What a session has used so far, as Claude Code keeps it: the session's last `cost-state` record in
 * its file (Claude Code writes one as each run ends, and a resumed run starts its `total_cost_usd` and
 * `modelUsage` from it; only a record of this session, with a cost Claude Code would take, counts).
 * Nothing when the file has none: a run of a Claude Code that keeps none starts from nothing too.
 * Undefined when the file cannot be read, or has no record in its last `limit` bytes.
 */
export async function claudeSessionTally(file: string, sessionId: string, limit = COST_STATE_SCAN): Promise<ClaudeTally | undefined> {
  try {
    const found = await lastLine(file, '"cost-state"', limit, (line) => {
      try {
        const r = JSON.parse(line);
        const cost = r?.totalCostUSD;
        return r?.type === 'cost-state' &&
          r.sessionId === sessionId &&
          typeof cost === 'number' &&
          Number.isFinite(cost) &&
          cost >= 0 &&
          cost <= 1e9
          ? (r as { totalCostUSD: number; modelUsage?: unknown })
          : undefined;
      } catch {
        return undefined;
      }
    });
    if (!found.line) return found.whole ? NOTHING_USED : undefined;
    return { costUsd: found.line.totalCostUSD, ...(claudeModelTokens(found.line.modelUsage) ?? { inputTokens: 0, outputTokens: 0 }) };
  } catch {
    return undefined;
  }
}

/**
 * The last line of a file that `pick` takes, read from the end a block at a time without holding up
 * the server (a session's file can be large): only lines with `marker` in them are decoded and given
 * to `pick`. `whole` says whether the file was read to its start (it stops `limit` bytes from the end).
 */
async function lastLine<T>(
  file: string,
  marker: string,
  limit: number,
  pick: (line: string) => T | undefined,
): Promise<{ line?: T; whole: boolean }> {
  const fh = await open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    let end = size;
    let pieces: Buffer[] = []; // the rest of a line whose start is not read yet, in order
    const take = (parts: Buffer[]) => {
      const line = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
      return line.includes(marker) ? pick(line.toString('utf8')) : undefined;
    };
    while (end > 0) {
      if (size - end >= limit) return { whole: false };
      const start = Math.max(0, end - 64 * 1024);
      const block = Buffer.alloc(end - start);
      for (let got = 0; got < block.length;) {
        const { bytesRead } = await fh.read(block, got, block.length - got, start + got);
        if (bytesRead <= 0) throw new Error('the file got shorter');
        got += bytesRead;
      }
      let stop = block.length;
      for (let i = block.length - 1; i >= 0; i--) {
        if (block[i] !== 0x0a) continue;
        const line = take([block.subarray(i + 1, stop), ...pieces]);
        pieces = [];
        if (line !== undefined) return { line, whole: true };
        stop = i;
      }
      if (stop > 0) pieces.unshift(block.subarray(0, stop));
      end = start;
    }
    return { line: pieces.length ? take(pieces) : undefined, whole: true };
  } finally {
    await fh.close();
  }
}

/**
 * The turn's cost and tokens. Claude Code 2.1.323 gives them in `model_usage_since_last_result`:
 * every model's usage since its process started, which runs this turn alone (subagents and its own
 * side calls included). One without it reports only a resumed session's totals so far
 * (`total_cost_usd`, and every model's tokens in `modelUsage`), so the turn's are those less what the
 * session had used before it (`before`, nothing for a new session). Without that, or when the totals
 * do not add up, the tokens are the main conversation's (`usage`) and the cost is not known.
 */
export function claudeTurnUsage(
  r: Record<string, any>,
  before: ClaudeTally | undefined,
): Pick<RunResult, 'costUsd' | 'inputTokens' | 'outputTokens'> {
  const round = (n: number) => Math.round(n * 1e10) / 1e10;
  const turn = r.model_usage_since_last_result;
  const turnTokens = claudeModelTokens(turn);
  if (turnTokens) {
    // Nothing counted (`{}`): no model was called, which cost nothing.
    const cost = Object.keys(turn).length ? claudeModelCost(turn) : 0;
    return { costUsd: cost === undefined ? undefined : round(cost), ...turnTokens };
  }
  const since = (total: number, was: number) => {
    const d = total - was;
    return d >= -1e-9 ? Math.max(0, round(d)) : undefined;
  };
  const total = typeof r.total_cost_usd === 'number' && Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : undefined;
  const costUsd = total !== undefined && before ? since(total, before.costUsd) : undefined;
  const models = before ? claudeModelTokens(r.modelUsage) : undefined;
  const input = models && before ? since(models.inputTokens, before.inputTokens) : undefined;
  const output = models && before ? since(models.outputTokens, before.outputTokens) : undefined;
  if (input !== undefined && output !== undefined && (input > 0 || output > 0))
    return { costUsd, inputTokens: input, outputTokens: output };
  return { costUsd, inputTokens: sumInput(r.usage), outputTokens: r.usage?.output_tokens };
}

/**
 * The managed settings files an administrator may have put on this computer (`managed-settings.json`
 * and the files in `managed-settings.d`), whose `allowRead` lists add up with the others too.
 */
export function claudeManagedSettings(platform: NodeJS.Platform = process.platform): string[] {
  const dir = platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : platform === 'win32' ? undefined : '/etc/claude-code';
  if (!dir) return [];
  // POSIX paths: `platform` is macOS or Linux here, whichever system this runs on.
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(posix.join(dir, 'managed-settings.d'))
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => posix.join(dir, 'managed-settings.d', name));
  } catch {
    // none
  }
  return [posix.join(dir, 'managed-settings.json'), ...dropIns];
}

/**
 * An entry of `sandbox.filesystem.allowRead` / `allowWrite` in these settings files that reaches a
 * protected path (is one, holds one or is inside one), as `[file, entry]`: those lists add up across
 * settings files, so the turn's `--settings` cannot take an entry out. Patterns are taken by the
 * folder before their first `*`, `?` or `[`. A relative entry is taken both from the file's folder
 * (where Claude Code takes it from: `~/.claude` for the user's settings) and from the working
 * directory. (Claude Code itself drops a project's `allowRead` entries that would open a path the
 * turn's `--settings` deny.)
 */
export function claudeReopening(
  files: readonly string[],
  protectedPaths: readonly string[],
  o: { home?: string; cwd?: string } = {},
): [string, string] | undefined {
  const home = o.home ?? homedir();
  for (const file of files) {
    let settings: any;
    try {
      settings = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      continue; // none, or not JSON (Claude Code then skips the file too)
    }
    const fs = settings?.sandbox?.filesystem ?? {};
    const entries = [fs.allowRead, fs.allowWrite].flatMap((list) => (Array.isArray(list) ? list : []));
    for (const entry of entries) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      const bases = entry === '~' || entry.startsWith('~/') ? [home] : [dirname(file), o.cwd ?? home];
      for (const base of bases) {
        let path = entry === '~' ? home : entry.startsWith('~/') ? join(home, entry.slice(2)) : resolve(base, entry);
        const glob = path.search(/[*?[]/);
        if (glob >= 0) path = dirname(`${path.slice(0, glob)}x`);
        if (protectedPaths.some((p) => overlaps(p, path))) return [file, entry];
      }
    }
  }
  return undefined;
}

/**
 * The `--settings` of one turn: what it leaves out (`claudeNativeSettings`), the sandbox, and on the
 * user's own endpoint its variables (`env`: `claudeEndpointEnv`), which the flag layer sets over any
 * the user's settings files set.
 */
export function claudeRunSettings(
  permission: Permission,
  off: readonly NativePart[] = [],
  pluginIds: readonly string[] = [],
  items: NativeItemsOff = {},
  platform: NodeJS.Platform = process.platform,
  denyRead: readonly string[] = [],
  env?: Record<string, string>,
  guard?: WriteGuard,
  on: readonly NativeOnPart[] = [],
): Record<string, unknown> | undefined {
  const native = claudeNativeSettings(off, pluginIds, items, on);
  const sandbox = claudeSandboxSettings(permission, platform, denyRead);
  const guarded = claudeGuardRules(guard, platform);
  const withGuard = (settings: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!guarded.length) return settings;
    const rules = (settings?.permissions ?? {}) as { deny?: string[] };
    return { ...settings, permissions: { ...rules, deny: [...(rules.deny ?? []), ...guarded] } };
  };
  const withEnv = (settings: Record<string, unknown> | undefined) => (env ? { ...settings, env: { ...env } } : settings);
  if (!native || !sandbox) return withEnv(withGuard(native ?? sandbox));
  type Rules = { deny?: string[]; ask?: string[] };
  const a = (native.permissions ?? {}) as Rules;
  const b = sandbox.permissions as Rules;
  const deny = [...(a.deny ?? []), ...(b.deny ?? [])];
  return withEnv(
    withGuard({ ...native, ...sandbox, permissions: { ...(deny.length ? { deny } : {}), ask: [...(a.ask ?? []), ...(b.ask ?? [])] } }),
  );
}

/**
 * The team's protected paths as Claude Code's `Edit` deny rules (`//` and an absolute glob), which it
 * keeps with any permission, full access included: they refuse its file tools and the shell commands
 * whose target it can tell (a redirect, `rm`, `mv`, `sed -i`…), and below full access its sandbox takes
 * them too (on macOS for every command). With them, what matches when the turn starts, by name
 * (`guardedNow()`), so that moving the folder above one does not take it out of reach. Its sandbox on
 * Linux takes only a name (a rule ending in `/**` as the name before it) and puts a stand-in on a name
 * that is not there while a command runs: there a rule is given for a name only when it is there. None
 * on native Windows (not tried there), and none for a folder or name holding `*`, `?` or `[`, which a
 * rule would read as a pattern.
 */
export function claudeGuardRules(
  g: WriteGuard | undefined,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  now?: readonly string[],
): string[] {
  if (!g || platform === 'win32') return [];
  const plain = (p: string) => !/[*?[\]]/.test(p);
  const dirs = g.dirs.filter(plain);
  if (!dirs.length) return [];
  const guard = { ...g, dirs };
  const named = (now ?? guardedNow(g)).filter(plain).flatMap((p) => [p, `${p.split('\\').join('/')}/**`]);
  const rules = [...guardGlobs(guard), ...named].filter((glob) => {
    if (platform !== 'linux') return true;
    const name = glob.replace(/\/\*\*$/, '');
    return /[*?[]/.test(name) || exists(name);
  });
  return [...new Set(rules)].map((glob) => `Edit(/${glob})`);
}

/**
 * What Claude Code is given as the credential of an endpoint that has no key: it needs one, and one of
 * its own keeps the user's Claude sign-in (and any Anthropic key) from going to the endpoint.
 */
export const CLAUDE_ENDPOINT_NO_KEY = 'no-key';

/**
 * The endpoint's address as Claude Code takes it (`ANTHROPIC_BASE_URL`, to which it adds
 * `/v1/messages`): the base URL without a trailing `/v1`.
 */
export function claudeEndpointUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/**
 * The variables that run Claude Code on one of the user's own endpoints, an Anthropic Messages API
 * server (vLLM, Ollama, LM Studio and llama.cpp serve one):
 * - its address and its key as a bearer token (`ANTHROPIC_AUTH_TOKEN`, which Claude Code takes before
 *   an `ANTHROPIC_API_KEY`, an `apiKeyHelper` or the user's sign-in), or `CLAUDE_ENDPOINT_NO_KEY`;
 * - no Anthropic key or sign-in token, and none of the cloud providers (Bedrock, Vertex, Foundry),
 *   which Claude Code would take first;
 * - the model for everything it runs: the turn, its background requests and its subagents;
 * - its context window and output limit, when Settings knows them (`claudeEndpointLimitsEnv`).
 */
export function claudeEndpointEnv(run: EndpointModel): Record<string, string> {
  const m = run.model;
  return {
    ...claudeEndpointLimitsEnv(run),
    ANTHROPIC_BASE_URL: claudeEndpointUrl(run.endpoint.baseUrl),
    ANTHROPIC_AUTH_TOKEN: run.endpoint.apiKey || CLAUDE_ENDPOINT_NO_KEY,
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '0',
    CLAUDE_CODE_USE_VERTEX: '0',
    CLAUDE_CODE_USE_FOUNDRY: '0',
    ANTHROPIC_MODEL: m,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
    ANTHROPIC_SMALL_FAST_MODEL: m,
    CLAUDE_CODE_SUBAGENT_MODEL: m,
  };
}

/**
 * A model of the user's own endpoint whose limits Settings knows: `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, the
 * window Claude Code takes for a model id it does not recognize (else it assumes one, 200K before
 * 2.1.323 and 1M since, and compacts only near it), and `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, the tokens it asks for one answer: the
 * model's output limit, else `outputReserve()`. Both from Claude Code's model configuration docs, and in
 * the binary of 2.1.327 to 2.1.330. An id that names one of Claude's own models (a gateway's alias) keeps
 * that model's window. Empty without limits.
 */
export function claudeEndpointLimitsEnv(run: EndpointModel): Record<string, string> {
  const l = runLimits(run.endpoint, run.model);
  if (!l) return {};
  const output = l.context ? outputReserve({ ...l, context: l.context }, 32_000) : l.output;
  return {
    ...(l.context ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(l.context) } : {}),
    ...(output ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(output) } : {}),
  };
}

/** The process environment of a turn on an endpoint: the user's, with `claudeEndpointEnv` over it (an empty value unset). */
export function claudeEndpointProcessEnv(env: NodeJS.ProcessEnv, endpointEnv: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of Object.entries(endpointEnv)) {
    if (v) out[k] = v;
    else delete out[k];
  }
  return out;
}

/** Tools approved up front. Web access is not about the file system, so every level gets it. */
export function claudeAllowedTools(permission: Permission): string[] {
  if (permission === 'full') return [];
  return ['WebFetch', 'WebSearch', ...(permission === 'edit' ? CLAUDE_EDIT_COMMANDS.map((c) => `Bash(${c}:*)`) : [])];
}

/**
 * Tools removed outright. Read-only drops the file-editing tools: `permissions.allow` rules in the
 * user's or a trusted project's Claude Code settings would otherwise let them run without asking.
 * Every level drops `AskUserQuestion`, Claude Code's own question form: in `-p` it is on whenever a
 * permission prompt tool is set (below full access when the conversation asks), and it would reach the
 * user as an approval that sends back no answer. The briefing has the agent ask in its reply
 * (`[ASK_USER]`) instead.
 */
export function claudeDisallowedTools(permission: Permission): string[] {
  return [...(permission === 'read-only' ? ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] : []), 'AskUserQuestion'];
}

/**
 * A `Read` permission rule for everything in an absolute folder (`//` starts an absolute path in
 * Claude Code's rules; Windows paths are written as /c/…).
 */
export function claudeReadRule(dir: string): string {
  const posix = /^[A-Za-z]:[\\/]/.test(dir) ? `/${dir[0]!.toLowerCase()}${dir.slice(2)}` : dir;
  return `Read(/${posix.replace(/\\/g, '/').replace(/\/+$/, '')}/**)`;
}

/** Claude Code's `--mcp-config` content for the tool library's MCP servers. */
export function claudeMcpConfig(servers: McpServerSpec[]): { mcpServers: Record<string, unknown> } {
  const has = (vars: Record<string, string>) => Object.keys(vars).length > 0;
  return {
    mcpServers: Object.fromEntries(
      servers.map((s) => [
        s.name,
        s.transport === 'http'
          ? { type: 'http', url: s.url, ...(has(s.headers) ? { headers: s.headers } : {}) }
          : { type: 'stdio', command: s.command, args: s.args, ...(has(s.env) ? { env: s.env } : {}) },
      ]),
    ),
  };
}

/**
 * Variables that make Claude Code leave out its instruction files (CLAUDE.md, rules) and its auto
 * memory for one run; the rest is left out with flags (`claudeNativeArgs`), and its own subagents
 * once it has started (`claudeAgentsGate`).
 */
export function claudeNativeEnv(off: readonly NativePart[] = []): Record<string, string> {
  return {
    ...(off.includes('instructions') ? { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } : {}),
    ...(off.includes('memory') ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}),
  };
}

/**
 * Variables for what Claude Code does by itself in a run:
 * - `CLAUDE_CODE_DISABLE_WORKFLOWS`: its dynamic workflows (the `Workflow` tool, scripts of subagents)
 *   stay off unless the account turns them on (`NATIVE_ON_SUPPORT`): below full access the call reaches
 *   the user as an approval that does not say what it will run, with full access it runs unasked, and
 *   its progress comes only as `task_*` messages. Claude Code 2.1.330 reads it at start ("Set in the
 *   environment before Claude Code starts, CLAUDE_CODE_DISABLE_WORKFLOWS disables Workflows").
 * - `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`: how long `-p` waits once the turn has answered for its
 *   background work, 10 minutes by default. That work is its background subagents and workflows, and its
 *   background commands too (2.1.330 holds for them: `holdForBackgroundShells`), so a dev server started
 *   in the background would hold the turn as long as the wait. Kept at its default, but with workflows
 *   turned on, whose subagents may well run longer: then up to the turn's own time limit, less a margin
 *   (`CLAUDE_BG_WAIT_MARGIN_MS`), so that Claude Code stops what is left and answers before Harness Relay's
 *   own timer ends the turn.
 */
export function claudeFeatureEnv(on: readonly NativeOnPart[] = [], turnMs: number = TURN_TIMEOUT_MS): Record<string, string> {
  if (!on.includes('workflows')) return { CLAUDE_CODE_DISABLE_WORKFLOWS: '1' };
  return { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(Math.max(60_000, turnMs - CLAUDE_BG_WAIT_MARGIN_MS)) };
}

/**
 * Whether a run that ran out of time failed: not once the turn had answered (it was waiting for its
 * background work, or its own wait was longer than the time left), whose answer stands, what was still
 * at work showing as cut off (`parser.finish()`).
 */
export function claudeTimedOut(res: { timedOut?: boolean }, result: Record<string, any> | null): boolean {
  return Boolean(res.timedOut) && !(result && !result.is_error);
}

/** How much sooner than the turn's time limit Claude Code stops waiting for its background work (workflows on). */
export const CLAUDE_BG_WAIT_MARGIN_MS = 2 * 60_000;

/**
 * Claude Code's name for an MCP server in its tool names and permission rules
 * (`mcp__<name>__<tool>`): every character but letters, digits, `_` and `-` becomes `_`, and for a
 * claude.ai connector runs of `_` become one and none is left at either end (as Claude Code 2.1.319
 * does).
 */
export function claudeMcpName(server: string): string {
  const name = server.replace(/[^a-zA-Z0-9_-]/g, '_');
  return server.startsWith('claude.ai ') ? name.replace(/_+/g, '_').replace(/^_|_$/g, '') : name;
}

/**
 * A file path as a `claudeMdExcludes` pattern that matches only that file: Claude Code matches the
 * patterns as globs (picomatch) against paths written with `/`, so the characters a glob gives a
 * meaning to are put in brackets. Not with a backslash: Claude Code turns every `\\` in a pattern
 * into `/` first. With every `[` in brackets, a `]` is plain.
 */
export function claudeExcludePattern(path: string): string {
  return path.replace(/\\/g, '/').replace(/[*?[{}()]/g, (c) => `[${c}]`);
}

/**
 * Single items without the MCP servers (and their tools) the tool library gives this run: a rule
 * `mcp__<server>` goes by name, so it would also take away a library server of the same name, which
 * replaces the user's own anyway.
 */
export function claudeItemsBesideLibrary(items: NativeItemsOff, servers: readonly { name: string }[]): NativeItemsOff {
  const library = servers.map((s) => `mcp__${claudeMcpName(s.name)}`);
  if (!library.length || (!items.mcp?.length && !items.mcpTools?.length)) return items;
  const mcp = (items.mcp ?? []).filter((id) => !library.includes(id));
  const mcpTools = (items.mcpTools ?? []).filter((id) => !library.some((server) => id.startsWith(`${server}__`)));
  const { mcp: _m, mcpTools: _t, ...rest } = items;
  return { ...rest, ...(mcp.length ? { mcp } : {}), ...(mcpTools.length ? { mcpTools } : {}) };
}

/**
 * Settings for one run (`--settings`, the flag layer above the user's and the project's files):
 * - no hooks, from settings files or plugins;
 * - plugins turned off by id (all installed ones when plugins are left out: Claude Code has no
 *   switch for all of them, hence the ids from `claudePlugins`), which also takes away their skills,
 *   commands, subagents, hooks and MCP servers;
 * - single skills by name (`skillOverrides` "off": hidden from the model and from /name);
 * - single instruction files by path (`claudeMdExcludes`);
 * - permission rules that deny single built-in tools, MCP servers (`mcp__<server>`: all its tools;
 *   the server still starts), MCP tools and subagents (`Agent(name)`).
 * Single items of a part left out whole are left to that part's switch, except subagents (the
 * switch keeps the built-in ones) and plugins; with all MCP servers left out, rules for single ones
 * are not added, since they would also reach a tool library server of the same name.
 */
export function claudeNativeSettings(
  off: readonly NativePart[] = [],
  pluginIds: readonly string[] = [],
  items: NativeItemsOff = {},
  /** What the run turns on: `ultracode` (with workflows) sets `"ultracode": true`, which keeps the member's effort. */
  on: readonly NativeOnPart[] = [],
): Record<string, unknown> | undefined {
  const plugins = off.includes('plugins') ? pluginIds : (items.plugins ?? []);
  const skills = off.includes('skills') ? [] : (items.skills ?? []);
  const files = off.includes('instructions') ? [] : (items.instructions ?? []);
  // All its subagents: a rule for the whole `Agent` tool, which the built-in ones are called through too.
  const allAgents = off.includes('subagents');
  const deny = [
    ...(off.includes('tools') ? [] : (items.tools ?? [])),
    ...(off.includes('mcp') ? [] : [...(items.mcp ?? []), ...(items.mcpTools ?? [])]),
    ...(allAgents ? ['Agent'] : (items.agents ?? []).map((name) => `Agent(${name})`)),
  ];
  const settings = {
    ...(on.includes('workflows') && on.includes('ultracode') ? { ultracode: true } : {}),
    ...(off.includes('hooks') ? { disableAllHooks: true } : {}),
    ...(plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((id) => [id, false])) } : {}),
    ...(skills.length ? { skillOverrides: Object.fromEntries(skills.map((name) => [name, 'off'])) } : {}),
    ...(files.length ? { claudeMdExcludes: files.map(claudeExcludePattern) } : {}),
    ...(deny.length ? { permissions: { deny } } : {}),
  };
  return Object.keys(settings).length ? settings : undefined;
}

/**
 * The flags that leave out what Claude Code loads by itself: its skills (and other custom
 * commands), its own MCP servers (only the tool library's, from --mcp-config, stay), all its
 * built-in tools (`--tools ""`), and through `--settings` its hooks, plugins and single items
 * (`claudeNativeSettings`).
 */
export function claudeNativeArgs(
  off: readonly NativePart[] = [],
  pluginIds: readonly string[] = [],
  items: NativeItemsOff = {},
  settingsFile?: string,
  /** The `--settings` to pass; what is left out, unless the turn adds more (`claudeRunSettings`). */
  settings: Record<string, unknown> | undefined = claudeNativeSettings(off, pluginIds, items),
): string[] {
  return [
    ...(off.includes('skills') ? ['--disable-slash-commands'] : []),
    ...(off.includes('mcp') ? ['--strict-mcp-config'] : []),
    ...(off.includes('tools') ? ['--tools', ''] : []),
    ...(settings ? ['--settings', settingsFile ?? JSON.stringify(settings)] : []),
  ];
}

/**
 * The run's `--settings` in a private file for the run, when there are any: with many single items
 * left out they would not fit a command line (Windows takes 32,767 characters).
 */
export function claudeSettingsFile(settings: Record<string, unknown> | undefined): { file: string; remove: () => void } | undefined {
  return settings ? privateTempFile('settings.json', JSON.stringify(settings)) : undefined;
}

/** How long a short question to Claude Code (its plugins, its built-in subagents) may take. */
const PROBE_TIMEOUT_MS = 30_000;

/** The arguments that start Claude Code for control requests only (the stream-json protocol, no prompt). */
export const CLAUDE_PROBE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

/** An installed plugin as `claude plugin list --json` reports it. */
export interface ClaudePlugin {
  id: string;
  enabled?: boolean;
  scope?: string;
}

/** The plugins in `claude plugin list --json`, once each; undefined when the output is not that list. */
export function parseClaudePluginList(stdout: string): ClaudePlugin[] | undefined {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const seen = new Set<string>();
  const plugins: ClaudePlugin[] = [];
  for (const p of list) {
    if (typeof p?.id !== 'string' || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    plugins.push({
      id: p.id,
      ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
      ...(typeof p.scope === 'string' ? { scope: p.scope } : {}),
    });
  }
  return plugins;
}

/** Claude Code's installed plugins (user, project and the rest), asked with `claude plugin list --json`. */
export async function claudePlugins(bin: string, env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal): Promise<ClaudePlugin[]> {
  const res = await runProcess({
    bin,
    args: ['plugin', 'list', '--json'],
    cwd,
    env,
    signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxCapture: 4 * 1024 * 1024,
  });
  const list = res.code === 0 ? parseClaudePluginList(res.stdout) : undefined;
  if (!list) throw new Error(res.timedOut ? 'timed out' : tail(res.stderr || res.stdout) || `exit ${res.code}`);
  return list;
}

/** A subagent as Claude Code's `initialize` answer names it. */
export interface ClaudeAgent {
  name: string;
  description: string;
}

/**
 * The subagents in an `initialize` answer; undefined when it does not list them, or lists one
 * without a name (it could not be denied).
 */
export function claudeAgents(init: unknown): ClaudeAgent[] | undefined {
  const agents = (init as { agents?: unknown } | undefined)?.agents;
  if (!Array.isArray(agents) || agents.some((a) => typeof a?.name !== 'string' || !a.name)) return undefined;
  return agents.map((a) => ({ name: a.name as string, description: typeof a.description === 'string' ? a.description : '' }));
}

/** Claude Code's built-in subagents: each name with its description. */
export type ClaudeBuiltinAgents = ReadonlyMap<string, string>;

/**
 * Whether a subagent is a built-in one: its name and description as Claude Code has them with
 * nothing around it. A user's or project's subagent of the same name replaces the built-in one,
 * and its own description gives it away.
 */
export const isBuiltinAgent = (agent: ClaudeAgent, builtins: ClaudeBuiltinAgents) => builtins.get(agent.name) === agent.description;

/**
 * Permission rules that deny the subagents that are not built in (one that replaces a built-in
 * one too, which leaves that name without a subagent). Claude Code takes a denied subagent off the
 * Agent tool's list and refuses to start it.
 */
export function claudeAgentDenyRules(agents: readonly ClaudeAgent[], builtins: ClaudeBuiltinAgents): string[] {
  return [...new Set(agents.filter((a) => !isBuiltinAgent(a, builtins)).map((a) => a.name))].map((name) => `Agent(${name})`);
}

const builtinAgents = new Map<string, Promise<ClaudeBuiltinAgents>>();

/**
 * Claude Code's built-in subagents (with any an organisation's managed settings add): the ones it
 * reports with no settings files, plugins or project around it. Its `initialize` answer does not
 * say where a subagent comes from. Asked once per executable, version and config folder, in an
 * empty folder; no model is called.
 */
export function claudeBuiltinAgents(bin: string, env: NodeJS.ProcessEnv, version = ''): Promise<ClaudeBuiltinAgents> {
  const key = `${bin}\0${version}\0${env.CLAUDE_CONFIG_DIR ?? ''}`;
  let hit = builtinAgents.get(key);
  if (!hit) {
    hit = askBuiltinAgents(bin, env);
    builtinAgents.set(key, hit);
    hit.catch(() => builtinAgents.delete(key));
  }
  return hit;
}

async function askBuiltinAgents(bin: string, env: NodeJS.ProcessEnv): Promise<ClaudeBuiltinAgents> {
  const dir = mkdtempSync(join(tmpdir(), 'harness-relay-'));
  try {
    let agents: ClaudeAgent[] | undefined;
    let error: string | undefined;
    const res = await converse({
      bin,
      cwd: dir,
      env,
      timeoutMs: PROBE_TIMEOUT_MS,
      args: [...CLAUDE_PROBE_ARGS, '--setting-sources', '', '--strict-mcp-config', '--settings', JSON.stringify({ disableAllHooks: true })],
      open: (write) => write({ type: 'control_request', request_id: 'relay-builtin', request: { subtype: 'initialize' } }),
      onMessage: (m, _write, finish) => {
        if (m.type !== 'control_response' || m.response?.request_id !== 'relay-builtin') return;
        if (m.response.subtype === 'error') {
          error = String(m.response.error ?? 'error');
        } else {
          agents = claudeAgents(m.response.response);
          if (!agents) error = 'it did not list its subagents';
        }
        finish();
      },
    });
    if (!agents) throw new Error(error ?? (res.timedOut ? 'timed out' : tail(res.stderr) || 'no answer'));
    return new Map(agents.map((a) => [a.name, a.description]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Leaves Claude Code's own subagents out of a run, before the prompt is sent: once the answer to
 * `initialize` names the subagents it loaded, those that are not built in are denied for the
 * session (an `apply_flag_settings` control request with `Agent(name)` rules), and then `start`
 * sends the prompt. Returns a handler for the CLI's messages that says which ones it took. Anything
 * that goes wrong calls `fail`, a list of subagents missing from the answer too: going on would
 * quietly run the subagents the user turned off.
 */
export function claudeAgentsGate(o: {
  initId: string;
  builtins: (version: string | undefined) => Promise<ClaudeBuiltinAgents>;
  send: (msg: unknown) => void;
  start: () => void;
  fail: (detail: string) => void;
}): (msg: Record<string, any>) => boolean {
  const denyId = `${o.initId}-agents`;
  return (msg) => {
    if (msg.type !== 'control_response') return false;
    const r = msg.response ?? {};
    if (r.request_id === o.initId) {
      if (r.subtype === 'error') {
        o.fail(String(r.error ?? 'initialize failed'));
        return true;
      }
      const agents = claudeAgents(r.response);
      if (!agents) {
        o.fail('it did not list its subagents');
        return true;
      }
      const version = typeof r.response?.claude_code_version === 'string' ? r.response.claude_code_version : undefined;
      o.builtins(version).then(
        (builtins) => {
          const deny = claudeAgentDenyRules(agents, builtins);
          if (!deny.length) return o.start();
          o.send({
            type: 'control_request',
            request_id: denyId,
            request: { subtype: 'apply_flag_settings', settings: { permissions: { deny } } },
          });
        },
        (err: unknown) => o.fail(err instanceof Error ? err.message : String(err)),
      );
      return true;
    }
    if (r.request_id === denyId) {
      if (r.subtype === 'error') o.fail(String(r.error ?? 'apply_flag_settings failed'));
      else o.start();
      return true;
    }
    return false;
  };
}

/** A file only this user can read, in a new folder in Harness Relay's own temporary folder, that `remove()` deletes. */
function privateTempFile(name: string, content: string): { file: string; remove: () => void } {
  // Not in the system's temporary folder, where sandboxed commands could change it (`relayTmpDir`).
  const root = relayTmpDir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, RUN_TMP_PREFIXES.claude));
  const file = join(dir, name);
  writeFileSync(file, content, { mode: 0o600 });
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Command-line flags a Claude Code version may not know yet; dropped (and remembered) when it rejects one. */
const OPTIONAL_FLAGS = {
  // Readable thinking summaries (by default the thinking text is left empty). Not in `--help`.
  thinking: ['--thinking-display', 'summarized'],
  // Without it, a resumed session keeps the system prompt of its first request, so role, team,
  // mode and permission changes would never reach the agent.
  freshPrompt: ['--system-prompt-snapshot', 'off'],
} as const;
type OptionalFlag = keyof typeof OPTIONAL_FLAGS;
const unsupported = new Set<OptionalFlag>();

/** The `claude` arguments for one turn. */
export function claudeArgs(o: {
  systemPrompt: string;
  permission: Permission;
  ask: boolean;
  model?: string;
  effort?: string;
  sessionId?: string;
  newSessionId?: string;
  /** A directory of attached files outside the working directory that Claude may read. */
  attachmentsDir?: string;
  /** The conversation's other working directories, which Claude uses as it uses the working directory. */
  addDirs?: string[];
  /** Other folders outside the working directory Claude may read (not write), e.g. skills. */
  readDirs?: string[];
  /** The `--mcp-config` file with the tool library's MCP servers. */
  mcpConfig?: string;
  /** What Claude Code loads by itself to leave out (instructions and memory go through `claudeNativeEnv`). */
  nativeOff?: readonly NativePart[];
  /** Single items of it to leave out. */
  nativeItems?: NativeItemsOff;
  /** What the run turns on (its `ultracode` setting; workflows go through `claudeFeatureEnv`). */
  nativeOn?: readonly NativeOnPart[];
  /** The installed plugins, turned off when plugins are left out. */
  pluginIds?: readonly string[];
  /** A file holding the turn's `--settings` (else they go on the command line). */
  settingsFile?: string;
  /** The platform Claude Code runs on, which decides whether it has a sandbox. */
  platform?: NodeJS.Platform;
  /** Paths its sandbox may not let it read (`protectedReads()`). */
  protectedPaths?: readonly string[];
  /** On the user's own endpoint: its variables (`claudeEndpointEnv`), in the turn's `--settings`. */
  endpointEnv?: Record<string, string>;
  /** The team's protected paths, refused as `Edit` deny rules (`claudeGuardRules`). */
  guard?: WriteGuard;
  /** The lead agent's turns: the answer's JSON shape (`--json-schema`), which the result carries as `structured_output`. */
  jsonSchema?: OutputSchema;
  /** The member's own limit: the US dollars the turn may cost, by Claude Code's own estimate (`--max-budget-usd`). */
  maxBudgetUsd?: number;
  skip?: ReadonlySet<OptionalFlag>;
}): string[] {
  const optional = (Object.keys(OPTIONAL_FLAGS) as OptionalFlag[]).filter((f) => !o.skip?.has(f));
  const disallowed = claudeDisallowedTools(o.permission);
  const reads = o.permission === 'full' ? [] : (o.readDirs ?? []).map(claudeReadRule);
  const addDirs = [...(o.addDirs ?? []), ...(o.attachmentsDir ? [o.attachmentsDir] : [])];
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt',
    o.systemPrompt,
    // Variadic; the next `--flag` ends the list.
    ...withAllowedTools([...claudeAllowedTools(o.permission), ...reads]),
    ...(disallowed.length ? ['--disallowedTools', ...disallowed] : []),
    // Lets Claude use the other working directories as it uses this one (its permission mode and its
    // sandbox's writes cover them too), and read the attached files outside them (variadic too).
    ...(addDirs.length ? ['--add-dir', ...addDirs] : []),
    // Added to the user's own MCP servers (variadic too).
    ...(o.mcpConfig ? ['--mcp-config', o.mcpConfig] : []),
    // Leave out what Claude Code loads by itself: its skills, its own MCP servers (the tool
    // library's, from --mcp-config, stay), its built-in tools, hooks and plugins, and single items;
    // and below full access, turn its sandbox on.
    ...claudeNativeArgs(
      o.nativeOff,
      o.pluginIds,
      o.nativeItems,
      o.settingsFile,
      claudeRunSettings(
        o.permission,
        o.nativeOff,
        o.pluginIds,
        o.nativeItems,
        o.platform,
        o.protectedPaths,
        o.endpointEnv,
        o.guard,
        o.nativeOn,
      ),
    ),
    '--permission-mode',
    PERMISSION_MODE[o.permission][o.ask ? 'ask' : 'deny'],
    ...(o.ask ? ['--permission-prompt-tool', 'stdio'] : []),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...(o.jsonSchema ? ['--json-schema', JSON.stringify(o.jsonSchema)] : []),
    // Claude Code counts it for this process alone, which runs this turn alone.
    ...(o.maxBudgetUsd ? ['--max-budget-usd', String(o.maxBudgetUsd)] : []),
    ...optional.flatMap((f) => OPTIONAL_FLAGS[f]),
    ...(o.sessionId ? ['--resume', o.sessionId] : ['--session-id', o.newSessionId!]),
  ];
}

/** Text of a `tool_result` block's content (a string or text blocks). */
function resultText(content: unknown): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
      : '';
}

const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed']);

/** Claude Code's to-do list (the TodoWrite tool) as plan entries. */
function todoEntries(input: any): PlanEntry[] | undefined {
  if (!Array.isArray(input?.todos)) return undefined;
  return input.todos.map((todo: any) => ({
    text: String(todo?.content ?? todo?.activeForm ?? ''),
    status: PLAN_STATUS.has(todo?.status) ? todo.status : 'pending',
  }));
}

/** What to show the user for a `can_use_tool` request. */
export function claudeApprovalRequest(
  tool: string,
  input: Record<string, any> = {},
  description?: string,
  /** Allowing it runs the command outside Claude Code's sandbox (`claudeOutsideSandbox`). */
  outsideSandbox = false,
): ApprovalRequest {
  const reason = (typeof input.description === 'string' && input.description) || description || undefined;
  // A command in the sandbox wants to reach a host: allowing it lets the sandbox connect there.
  if (tool === 'SandboxNetworkAccess') return { kind: 'fetch', detail: String(input.host ?? ''), reason: t().sandboxHost };
  // A command: its Bash tool, or on Windows its PowerShell tool (seen with Claude Code 2.1.322).
  if (tool === 'Bash' || tool === 'PowerShell') {
    return { kind: 'command', detail: String(input.command ?? ''), reason, ...(outsideSandbox ? { outsideSandbox: true } : {}) };
  }
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) {
    return { kind: 'edit', detail: String(input.file_path ?? input.notebook_path ?? ''), reason };
  }
  if (tool === 'WebFetch') return { kind: 'fetch', detail: String(input.url ?? ''), reason };
  return { kind: 'other', tool, detail: summarizeInput(input, { wholePaths: true }), reason };
}

/**
 * The folders Claude Code's sandbox lets a turn's commands write in: the working directory, the
 * folders it may also use (`--add-dir`: the other working directories, the attachments) and the temp
 * folder, each also by its real path (macOS's /tmp is /private/tmp). Undefined when the turn has no
 * sandbox.
 */
export function claudeSandboxWrites(permission: Permission, dirs: (string | undefined)[]): string[] | undefined {
  if (!claudeSandboxSettings(permission)) return undefined;
  const real = (dir: string) => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  };
  return [...new Set([...dirs, tmpdir()].filter((d): d is string => Boolean(d)).flatMap((d) => [d, real(d)]))];
}

/**
 * Whether allowing a `can_use_tool` request runs a command outside the sandbox: the model asked to
 * (`dangerouslyDisableSandbox`), or Claude Code asks because of a path (`blocked_path`) the sandbox
 * would not let it write, so that it would fail there even once allowed. A path in the folders it
 * may write (a file in the working directory in read-only mode, say) runs in the sandbox.
 */
export function claudeOutsideSandbox(request: Record<string, any>, writes: readonly string[] | undefined): boolean {
  if (!writes || request.tool_name !== 'Bash') return false;
  if (request.input?.dangerouslyDisableSandbox === true) return true;
  const path = request.blocked_path;
  if (typeof path !== 'string' || !path) return false;
  return !writes.some((dir) => {
    const rel = relative(dir, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/**
 * The input an allowed request runs with: a command that would fail in the sandbox runs outside
 * it, as the user allowed (like Codex's approvals).
 */
export function claudeAllowedInput(request: Record<string, any>, outsideSandbox: boolean): Record<string, any> {
  const input = (request.input ?? {}) as Record<string, any>;
  if (!outsideSandbox || request.tool_name !== 'Bash' || input.dangerouslyDisableSandbox === true) return input;
  return { ...input, dangerouslyDisableSandbox: true };
}

const DECLINED = 'The user declined this.';

/** The message Claude gets when the user declines (shown to the user localized instead). */
function declinedMessage(note?: string): string {
  return `${DECLINED}${note ? ` Their message: ${note}` : ''} Do not retry it; continue without it, or explain in your reply why it is needed.`;
}

/** The user's note when a tool result is our decline message ('' without a note), else undefined. */
function declinedNote(text: string): string | undefined {
  if (!text.startsWith(DECLINED)) return undefined;
  return text.match(/Their message: ([\s\S]*?) Do not retry it;/)?.[1] ?? '';
}

/*
 * The team's hooks (`RunOptions.hooks`), through Claude Code's own hook callbacks: the turn's
 * `initialize` registers a `PreToolUse` and a `PostToolUse` callback for the tools they cover, and
 * Claude Code sends a `hook_callback` control request for each such call, which waits for the answer.
 * These run with any permission mode, full access included, and `disableAllHooks` (the account's own
 * hooks left out) leaves them on (tried with claude 2.1.327).
 */

/** The callbacks' ids, as `initialize` registers them and `hook_callback` names them. */
export const CLAUDE_HOOK_IDS = { before: 'relay-hook-before', after: 'relay-hook-after' } as const;

/**
 * Claude Code's tools each kind of call is, for a hook's matcher: every tool that runs a command line
 * (`Monitor` runs its `command` in a shell of its own, in the background), and every one that changes a file.
 */
const CLAUDE_HOOK_TOOLS: Record<'command' | 'edit', string[]> = {
  command: ['Bash', 'Monitor'],
  edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
};

/**
 * The `hooks` of the turn's `initialize`: a callback for each of `PreToolUse` and `PostToolUse` that a
 * hook needs, for the tools its kinds cover (none named: every tool), waiting long enough for every
 * hook it may run (`budgetSec`, their time limits one after another, and `HOOK_WAIT.cli` more: Harness
 * Relay's own deadline refuses first). Null when there are none.
 */
export function claudeHooksConfig(hooks: TurnHooks | undefined): Record<string, unknown> | null {
  if (!hooks) return null;
  const entry = (when: 'before' | 'after') => {
    const kinds = hooks.kinds(when);
    if (!kinds.size) return undefined;
    const tools = kinds.has('any') ? undefined : [...kinds].flatMap((k) => CLAUDE_HOOK_TOOLS[k as 'command' | 'edit']);
    return [
      {
        ...(tools ? { matcher: tools.join('|') } : {}),
        hookCallbackIds: [CLAUDE_HOOK_IDS[when]],
        timeout: hooks.budgetSec(when) + HOOK_WAIT.cli,
      },
    ];
  };
  const before = entry('before');
  const after = entry('after');
  if (!before && !after) return null;
  return { ...(before ? { PreToolUse: before } : {}), ...(after ? { PostToolUse: after } : {}) };
}

/** A `hook_callback`'s call as the team's hooks see it (`HookCall`), from its `tool_name` and `tool_input`. */
export function claudeHookCall(input: Record<string, any>): HookCall {
  const tool = String(input.tool_name ?? '');
  const args = (input.tool_input ?? {}) as Record<string, any>;
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  if (CLAUDE_HOOK_TOOLS.command.includes(tool)) return { kind: 'command', tool, command: String(args.command ?? ''), input: args };
  if (CLAUDE_HOOK_TOOLS.edit.includes(tool)) {
    const file = args.file_path ?? args.notebook_path;
    const files = typeof file === 'string' && file ? [cwd && !isAbsolute(file) ? resolve(cwd, file) : file] : [];
    return { kind: 'edit', tool, files, input: args };
  }
  return { kind: 'other', tool, input: args };
}

/** What a `PostToolUse` callback's call returned, as text: a command's output, else its response as JSON. */
export function claudeHookOutput(input: Record<string, any>): string {
  const r = input.tool_response;
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object' && ('stdout' in r || 'stderr' in r))
    return [r.stdout, r.stderr].filter((x) => typeof x === 'string' && x).join('\n');
  try {
    return JSON.stringify(r ?? '');
  } catch {
    return '';
  }
}

/**
 * The answer to a `hook_callback`: before a call, a refusal with its reason (`permissionDecision:
 * deny`, which the model reads), or nothing, so that the call goes on as it would (never an allow,
 * which would skip the approval the permission asks for); after it, what the hooks said, which Claude
 * Code gives the model (`decision: block`, its `reason`), or nothing.
 */
export function claudeHookAnswer(when: 'before' | 'after', said: string | undefined): Record<string, unknown> {
  if (!said) return {};
  return when === 'before'
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: said } }
    : { decision: 'block', reason: said };
}

/** The tools that start a subagent: `Agent`, and `Task`, the name it had before (Claude Code 2.1.330 keeps it as an alias). */
const CLAUDE_AGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * A tool call's row. An `Agent` call names its subagent (`subagent_type`; without one Claude Code runs
 * `general-purpose`) and the model it asked for (`model`), as the tool's input has them in Claude Code
 * 2.1.330. `parentId`: the call whose subagent made this one.
 */
function claudeToolStart(block: Record<string, any>, parentId?: string): AgentEvent {
  const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const agent = CLAUDE_AGENT_TOOLS.has(block.name) ? (text(input.subagent_type) ?? 'general-purpose') : undefined;
  const model = agent ? text(input.model) : undefined;
  return {
    type: 'tool_start',
    id: block.id,
    name: block.name,
    detail: summarizeInput(block.input),
    ...(parentId ? { parentId } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * What a subagent reported (its `Agent` call's result): its words, without the line Claude Code adds
 * for the agent that called it (`agentId: … (use SendMessage …)` and its `<usage>`).
 */
function agentResultText(content: unknown): string {
  if (!Array.isArray(content)) return resultText(content);
  return resultText(content.filter((b) => !(typeof b?.text === 'string' && /^agentId: /.test(b.text))));
}

/**
 * The rows of a workflow's agents, from a `task_progress`'s `workflow_progress` (Claude Code 2.1.330's
 * schema: `{ type: 'workflow_agent', index, label, state: 'start' | 'progress' | 'done' | 'error',
 * agentType?, model?, phaseTitle?, error?, resultPreview? }`), under the `Workflow` call.
 */
function workflowAgents(toolUseId: string, rows: unknown, shown: Map<string, string>, emit: (e: AgentEvent) => void): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (row?.type !== 'workflow_agent' || typeof row.index !== 'number') continue;
    const id = `${toolUseId}:agent-${row.index}`;
    const label = typeof row.label === 'string' && row.label ? row.label : undefined;
    const detail = label && typeof row.phaseTitle === 'string' && row.phaseTitle ? `${row.phaseTitle}: ${label}` : label;
    const state = String(row.state ?? '');
    const before = shown.get(id);
    if (before === 'done' || before === 'error') continue;
    if (before === undefined) {
      emit({
        type: 'tool_start',
        id,
        name: 'Agent',
        agent: typeof row.agentType === 'string' && row.agentType ? row.agentType : (label ?? 'agent'),
        ...(detail ? { detail: clip(detail) } : {}),
        ...(typeof row.model === 'string' && row.model ? { model: row.model } : {}),
        parentId: toolUseId,
      });
    }
    shown.set(id, state);
    if (state === 'done') {
      const output = typeof row.resultPreview === 'string' && row.resultPreview.trim() ? tailText(row.resultPreview) : undefined;
      emit({ type: 'tool_end', id, ok: true, ...(output ? { output } : {}) });
    } else if (state === 'error') {
      emit({ type: 'tool_end', id, ok: false, ...(typeof row.error === 'string' && row.error ? { error: clip(row.error, 240) } : {}) });
    }
  }
}

/** A `control_request` Claude Code sends on stdout (e.g. `can_use_tool`). */
export interface ClaudeControlRequest {
  requestId: string;
  subtype: string;
  request: Record<string, any>;
}

/** Parses `claude -p --output-format stream-json --verbose --include-partial-messages`. */
export function createClaudeParser(emit: (e: AgentEvent) => void, onControl?: (req: ClaudeControlRequest) => void) {
  const openTextBlocks = new Set<number>();
  const thinkingBlocks = new Set<number>();
  const streamedMessages = new Set<string>();
  /** Tool calls shown as something else (the to-do list), so their results are not tool rows. */
  const hiddenTools = new Set<string>();
  /** The calls that start a subagent (`Agent`), whose result is what the subagent reported. */
  const agentCalls = new Set<string>();
  /**
   * Calls whose work goes on in the background once they answered (a background subagent, which
   * `Agent` starts by default in 2.1.330, a `Workflow`, a background command): their row ends with
   * their task's `task_notification`, or with the run.
   */
  const background = new Set<string>();
  /** Background calls that answered and are still at work. */
  const held = new Set<string>();
  /** Background tasks that ended before their call answered: how. */
  const settled = new Map<string, Extract<AgentEvent, { type: 'tool_end' }>>();
  /** A workflow's agents' rows shown so far, with their state. */
  const workflowRows = new Map<string, string>();
  /** The rows of a workflow's agents still at work as the workflow ended: ended with it. */
  const endWorkflowAgents = (toolUseId: string, ok: boolean, error?: string) => {
    for (const [id, state] of workflowRows) {
      if (!id.startsWith(`${toolUseId}:agent-`) || state === 'done' || state === 'error') continue;
      workflowRows.set(id, ok ? 'done' : 'error');
      emit({ type: 'tool_end', id, ok, ...(error ? { error } : {}) });
    }
  };
  let result: Record<string, any> | null = null;
  let sessionId: string | undefined;

  /**
   * What Claude Code reports about its own run and its background tasks (`type: 'system'`), as Claude
   * Code 2.1.330's own schemas of its stream-json messages have them: a compaction, a retried request,
   * a fallback model; and its tasks (`task_started`, `task_progress`, `task_notification`, linked to the
   * call that started them by `tool_use_id`).
   */
  const system = (ev: Record<string, any>) => {
    const toolUseId = typeof ev.tool_use_id === 'string' && ev.tool_use_id ? ev.tool_use_id : undefined;
    switch (ev.subtype) {
      case 'compact_boundary':
        emit({ type: 'notice', text: t().cliCompacted('Claude Code') });
        break;
      case 'status':
        if (ev.compact_result === 'failed') {
          const why = typeof ev.compact_error === 'string' && ev.compact_error ? clip(ev.compact_error, 240) : undefined;
          emit({ type: 'notice', text: t().cliCompactFailed('Claude Code', why) });
        }
        break;
      case 'api_retry': {
        const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
        const why = typeof ev.error === 'string' && ev.error ? ev.error.replace(/_/g, ' ') : undefined;
        emit({ type: 'notice', text: t().cliRetrying('Claude Code', n(ev.attempt), n(ev.max_retries), why) });
        break;
      }
      case 'model_fallback':
        if (typeof ev.fallback_model === 'string' && ev.fallback_model) {
          emit({ type: 'notice', text: t().cliModelSwitched('Claude Code', String(ev.original_model ?? ''), ev.fallback_model) });
        }
        break;
      case 'task_started':
        if (toolUseId && ev.is_backgrounded === true) background.add(toolUseId);
        break;
      case 'task_progress':
        if (!toolUseId) break;
        // `agentProgressSummaries`: a line on what the subagent is doing, as its row's detail.
        if (agentCalls.has(toolUseId) && typeof ev.summary === 'string' && ev.summary.trim()) {
          emit({ type: 'tool_start', id: toolUseId, name: 'Agent', detail: clip(ev.summary) });
        }
        workflowAgents(toolUseId, ev.workflow_progress, workflowRows, emit);
        break;
      case 'task_notification': {
        if (!toolUseId || !background.has(toolUseId)) break;
        workflowAgents(toolUseId, ev.workflow_progress, workflowRows, emit);
        const said = typeof ev.result === 'string' && ev.result.trim() ? ev.result : typeof ev.summary === 'string' ? ev.summary : '';
        const ok = ev.status === 'completed';
        const end: Extract<AgentEvent, { type: 'tool_end' }> = ok
          ? { type: 'tool_end', id: toolUseId, ok, ...(said.trim() ? { output: tailText(said.trim()) } : {}) }
          : { type: 'tool_end', id: toolUseId, ok, ...(said.trim() ? { error: clip(said, 240) } : {}) };
        background.delete(toolUseId);
        endWorkflowAgents(toolUseId, ok);
        if (held.delete(toolUseId)) emit(end);
        else settled.set(toolUseId, end);
        break;
      }
    }
  };

  function handle(line: string): void {
    const ev = parseJsonLine(line);
    if (!ev) return;
    if (ev.type === 'control_request') {
      onControl?.({ requestId: String(ev.request_id), subtype: String(ev.request?.subtype ?? ''), request: ev.request ?? {} });
      return;
    }
    if (ev.session_id && ev.session_id !== sessionId) {
      sessionId = ev.session_id as string;
      emit({ type: 'session', sessionId });
    }
    // A subagent's calls go to the chat under the call that started it (`parentId`); nothing else of
    // its own does (its words, its partial messages, its notes).
    const parentId = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id ? ev.parent_tool_use_id : undefined;
    if (parentId && ev.type !== 'assistant' && ev.type !== 'user') return;

    switch (ev.type) {
      case 'system':
        system(ev);
        break;
      case 'stream_event': {
        const e = ev.event ?? {};
        if (e.type === 'message_start' && e.message?.id) streamedMessages.add(e.message.id);
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') openTextBlocks.add(e.index);
        if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') thinkingBlocks.add(e.index);
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          emit({ type: 'text', text: e.delta.text });
        }
        if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && e.delta.thinking) {
          emit({ type: 'thinking', text: e.delta.thinking });
        }
        if (e.type === 'content_block_stop') {
          if (openTextBlocks.delete(e.index)) emit({ type: 'text_end' });
          thinkingBlocks.delete(e.index);
        }
        break;
      }
      case 'assistant': {
        const msg = ev.message ?? {};
        const streamed = msg.id && streamedMessages.has(msg.id);
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (block.type === 'tool_use') {
            // A subagent's to-do list is its own: not the agent's plan.
            const todos = !parentId && block.name === 'TodoWrite' ? todoEntries(block.input) : undefined;
            if (todos) {
              hiddenTools.add(block.id);
              emit({ type: 'plan', entries: todos });
            } else {
              if (CLAUDE_AGENT_TOOLS.has(block.name)) agentCalls.add(block.id);
              // A workflow always runs in the background, and a command asked to.
              if (block.name === 'Workflow' || block.input?.run_in_background === true) background.add(block.id);
              emit(claudeToolStart(block, parentId));
            }
          } else if (parentId) {
            continue;
          } else if (!streamed && block.type === 'thinking' && block.thinking) {
            emit({ type: 'thinking', text: block.thinking });
          } else if (!streamed && block.type === 'text' && block.text) {
            // Fallback when partial messages were not streamed.
            emit({ type: 'text', text: block.text });
            emit({ type: 'text_end' });
          }
        }
        break;
      }
      case 'user': {
        const content = ev.message?.content;
        for (const block of Array.isArray(content) ? content : []) {
          if (block.type !== 'tool_result' || hiddenTools.has(block.tool_use_id)) continue;
          const id = String(block.tool_use_id);
          const text = (agentCalls.has(id) ? agentResultText(block.content) : resultText(block.content)).trim();
          // A background subagent's call answers at once (`status: 'async_launched'`): it is still at work.
          if (ev.tool_use_result?.status === 'async_launched') background.add(id);
          if (background.has(id)) {
            const end = settled.get(id);
            settled.delete(id);
            if (!block.is_error) {
              if (end) emit(end);
              else held.add(id);
              continue;
            }
            background.delete(id); // it never started
          }
          const declined = block.is_error ? declinedNote(text) : undefined;
          const extra = !text
            ? {}
            : declined !== undefined
              ? { error: declined ? `${t().approvalDeclined} ${declined}` : t().approvalDeclined }
              : block.is_error
                ? { error: clip(text, 240) }
                : { output: tailText(text) };
          emit({ type: 'tool_end', id: block.tool_use_id, ok: !block.is_error, ...extra });
        }
        break;
      }
      case 'result': {
        // A call that ends after a result is counted on the next one (Claude Code 2.1.323): the run's
        // own usage is that of all its results.
        const since = addModelUsage(result?.model_usage_since_last_result, ev.model_usage_since_last_result);
        result = since ? { ...ev, model_usage_since_last_result: since } : ev;
        break;
      }
    }
  }

  return {
    handle,
    /** Claude Code has exited: a background call still at work was cut off with the run. */
    finish() {
      for (const id of [...held]) {
        held.delete(id);
        endWorkflowAgents(id, false, t().backgroundCutOff);
        emit({ type: 'tool_end', id, ok: false, error: t().backgroundCutOff });
      }
    },
    get result() {
      return result;
    },
    get sessionId() {
      return sessionId;
    },
  };
}

export const claudeRunner: AgentRunner = {
  provider: 'claude',
  async run(o): Promise<RunResult> {
    // The servers' tokens go in a private file for this turn, not on the command line (which `ps` shows).
    const mcp = o.mcpServers?.length ? privateTempFile('mcp.json', JSON.stringify(claudeMcpConfig(o.mcpServers))) : undefined;
    try {
      // An older Claude Code that rejects an optional flag: remember that and run again without it.
      for (;;) {
        try {
          return await runClaude(o, mcp?.file);
        } catch (err) {
          if (!(err instanceof UnsupportedFlag)) throw err;
          unsupported.add(err.flag);
        }
      }
    } finally {
      mcp?.remove();
    }
  },
};

class UnsupportedFlag extends Error {
  constructor(readonly flag: OptionalFlag) {
    super(`unsupported flag ${OPTIONAL_FLAGS[flag][0]}`);
  }
}

/** The optional flag an "unknown option" error is about, if it is one we can drop. */
function rejectedFlag(stderr: string): OptionalFlag | undefined {
  return (Object.keys(OPTIONAL_FLAGS) as OptionalFlag[]).find(
    (f) => !unsupported.has(f) && new RegExp(`unknown option.*${OPTIONAL_FLAGS[f][0]}`, 'i').test(stderr),
  );
}

/**
 * The ids of the installed plugins, to turn each off for a run that leaves plugins out. When Claude
 * Code cannot list them the run fails with a message that says so: going on would quietly load
 * the plugins the user turned off.
 */
async function pluginIdsForRun(o: Parameters<AgentRunner['run']>[0]): Promise<string[]> {
  if (!o.nativeOff?.includes('plugins')) return [];
  try {
    return (await claudePlugins(o.bin, o.env, o.cwd, o.signal)).map((p) => p.id);
  } catch (err) {
    if (o.signal.aborted) throw new AgentRunError(t().stopped, true);
    throw new AgentRunError(t().claudePluginsFailed(err instanceof Error ? err.message : String(err)));
  }
}

async function runClaude(given: Parameters<AgentRunner['run']>[0], mcpConfig?: string): Promise<RunResult> {
  // On the user's own endpoint: its model by its own name, an effort it takes, and its variables.
  const endpoint = endpointRunModel(given.backends, given.model, PROVIDER_LABEL.claude);
  const endpointEnv = endpoint ? claudeEndpointEnv(endpoint) : undefined;
  const o = endpoint
    ? {
        ...given,
        model: endpoint.model,
        effort: endpointEffort('claude', given.effort),
        env: claudeEndpointProcessEnv(given.env, endpointEnv!),
      }
    : given;
  const pluginIds = await pluginIdsForRun(o);
  const nativeItems = claudeItemsBesideLibrary(o.nativeItems ?? {}, o.mcpServers ?? []);
  const protectedPaths = o.protectedPaths ?? protectedReads();
  if (claudeSandboxSettings(o.permission)) {
    // Paths a sandbox would read as patterns, and the user's own settings opening them again, would
    // leave them unprotected: the run does not start.
    const pattern = patternPath(protectedPaths);
    if (pattern) throw new AgentRunError(t().protectedPattern(pattern));
    const reopened = claudeReopening([claudeUserSettings(o.env), ...claudeManagedSettings()], protectedPaths, { cwd: o.cwd });
    if (reopened) throw new AgentRunError(t().claudeReopens(...reopened));
  }
  // The endpoint's key goes in this private file, never on the command line.
  const settings = claudeSettingsFile(
    claudeRunSettings(
      o.permission,
      o.nativeOff,
      pluginIds,
      nativeItems,
      process.platform,
      protectedPaths,
      endpointEnv,
      o.guard,
      o.nativeOn,
    ),
  );
  // Its maker's models only: on the user's own endpoint the answer's shape is not asked for, and no
  // budget is set, since Claude Code would price the endpoint's model as one of its own.
  const jsonSchema = endpoint ? undefined : o.outputSchema;
  const maxBudgetUsd = endpoint ? undefined : agentLimitsFor('claude', o.limits)?.usd;
  try {
    const result = await runClaudeTurn(o, {
      mcpConfig,
      pluginIds,
      nativeItems,
      settingsFile: settings?.file,
      protectedPaths,
      endpointEnv,
      ...(jsonSchema ? { jsonSchema } : {}),
      ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
    });
    // Claude Code prices a model it does not know as one of its own: no cost for the user's own endpoint.
    return endpoint ? { ...result, costUsd: undefined } : result;
  } catch (err) {
    if (endpoint && err instanceof AgentRunError && err.usage) err.usage = { ...err.usage, costUsd: undefined };
    throw err;
  } finally {
    settings?.remove();
  }
}

/** How long Claude Code gets to end a turn the user stopped (its `interrupt`) before its process is stopped. */
export const CLAUDE_STOP_GRACE_MS = 3000;
let stopGraceMs = CLAUDE_STOP_GRACE_MS;

/** For tests: another wait before a stopped turn's process is stopped (none: the default again). */
export function setClaudeStopGrace(ms?: number): void {
  stopGraceMs = ms ?? CLAUDE_STOP_GRACE_MS;
}

/**
 * What a turn's result says it spent, kept when the turn fails or is stopped (`AgentRunError.usage`);
 * undefined without a result.
 */
function resultUsage(r: Record<string, any> | null, before: ClaudeTally | undefined): RunUsage | undefined {
  return r ? claudeTurnUsage(r, before) : undefined;
}

async function runClaudeTurn(
  o: Parameters<AgentRunner['run']>[0],
  run: {
    mcpConfig?: string;
    pluginIds: string[];
    nativeItems: NativeItemsOff;
    settingsFile?: string;
    protectedPaths: readonly string[];
    endpointEnv?: Record<string, string>;
    jsonSchema?: OutputSchema;
    maxBudgetUsd?: number;
  },
): Promise<RunResult> {
  const newSessionId = o.sessionId ? undefined : randomUUID();
  // What the session had used before this turn, for a Claude Code that does not say what the run alone
  // used (it then reports the session's totals; `claudeTurnUsage`).
  const resumed = o.sessionId ? claudeSessionFile(o.env, o.cwd, o.sessionId) : undefined;
  const before = o.sessionId ? (resumed ? await claudeSessionTally(resumed, o.sessionId) : undefined) : NOTHING_USED;
  const ask = Boolean(o.requestApproval) && o.permission !== 'full';
  const sandboxed = Boolean(claudeSandboxSettings(o.permission));
  const writes = claudeSandboxWrites(o.permission, [o.cwd, ...(o.addDirs ?? []), o.attachmentsDir]);
  const args = claudeArgs({
    systemPrompt: o.systemPrompt,
    permission: o.permission,
    ask,
    model: o.model,
    effort: o.effort,
    sessionId: o.sessionId,
    newSessionId,
    attachmentsDir: o.attachmentsDir,
    addDirs: o.addDirs,
    readDirs: o.readDirs,
    mcpConfig: run.mcpConfig,
    nativeOff: o.nativeOff,
    nativeItems: run.nativeItems,
    nativeOn: o.nativeOn,
    pluginIds: run.pluginIds,
    settingsFile: run.settingsFile,
    protectedPaths: run.protectedPaths,
    endpointEnv: run.endpointEnv,
    ...(o.guard ? { guard: o.guard } : {}),
    ...(run.jsonSchema ? { jsonSchema: run.jsonSchema } : {}),
    ...(run.maxBudgetUsd ? { maxBudgetUsd: run.maxBudgetUsd } : {}),
    skip: unsupported,
  });

  let child: ChildProcess | undefined;
  const send = (msg: unknown) => {
    if (child?.stdin?.writable) child.stdin.write(JSON.stringify(msg) + '\n');
  };
  /** Its input is over: no more prompts, approvals' answers or steering. */
  let inputEnded = false;
  const steering = new ClaudeSteering((msg) => {
    if (inputEnded || !child?.stdin?.writable) return false;
    send(msg);
    return true;
  });
  const respond = (requestId: string, response: unknown) =>
    send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

  const onControl = (req: ClaudeControlRequest) => {
    if (req.subtype === 'hook_callback') {
      const id = req.request.callback_id;
      const when = id === CLAUDE_HOOK_IDS.before ? 'before' : id === CLAUDE_HOOK_IDS.after ? 'after' : undefined;
      const hooks = o.hooks;
      if (!when || !hooks) {
        respond(req.requestId, {});
        return;
      }
      const input = (req.request.input ?? {}) as Record<string, any>;
      const call = claudeHookCall(input);
      const asked = when === 'before' ? hooks.before(call) : hooks.after({ ...call, output: claudeHookOutput(input) });
      // A hook that cannot be asked refuses the call before it (it fails closed), and says nothing after it.
      void asked.then(
        (said) => respond(req.requestId, claudeHookAnswer(when, said)),
        (err) =>
          respond(
            req.requestId,
            claudeHookAnswer(when, when === 'before' ? `Refused: the team's hook could not run (${(err as Error).message}).` : undefined),
          ),
      );
      return;
    }
    if (req.subtype !== 'can_use_tool') {
      send({ type: 'control_response', response: { subtype: 'error', request_id: req.requestId, error: 'not supported' } });
      return;
    }
    const tool = String(req.request.tool_name ?? '');
    const input = (req.request.input ?? {}) as Record<string, any>;
    const ask = o.requestApproval;
    if (!ask) {
      respond(req.requestId, { behavior: 'deny', message: 'Not allowed in this conversation.' });
      return;
    }
    const outside = claudeOutsideSandbox(req.request, writes);
    void ask(claudeApprovalRequest(tool, input, req.request.description, outside)).then(
      (answer) =>
        respond(
          req.requestId,
          answer.allow
            ? { behavior: 'allow', updatedInput: claudeAllowedInput(req.request, outside) }
            : { behavior: 'deny', message: declinedMessage(answer.note) },
        ),
      () => respond(req.requestId, { behavior: 'deny', message: 'Not allowed.' }),
    );
  };

  const parser = createClaudeParser(o.onEvent, onControl);
  const initId = `init-${randomUUID()}`;
  // Never once the user stopped the run (the gate below may answer after that).
  let prompted = false;
  const sendPrompt = () => {
    if (o.signal.aborted) return;
    prompted = true;
    send({ type: 'user', message: { role: 'user', content: claudeContent(o.prompt, o.images) } });
    // From now on a message the user sends may go into the turn (steering).
    o.onSteer?.(steering.steer);
  };
  // One prompt per run: once the turn has its result, and no message sent into it still waits for its
  // turn (steering), the input ends and Claude Code exits.
  const endInput = () => {
    if (inputEnded) return;
    inputEnded = true;
    o.onSteer?.(undefined);
    steering.close();
    child?.stdin?.end();
  };
  const maybeEndInput = () => {
    if (parser.result && !steering.holdsInput()) endInput();
  };
  steering.onChange = maybeEndInput;
  // Our own stop as well as the user's, to end the run when its subagents cannot be left out.
  const stop = new AbortController();
  // The user's stop: Claude Code is asked to interrupt the turn first, which ends it with a result that
  // says what it used (and then the process, its stdin closed); it is stopped all the same after a while.
  let grace: NodeJS.Timeout | undefined;
  const relayStop = () => {
    // No turn under way yet: nothing to interrupt.
    if (!child || !prompted) return stop.abort();
    send({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } });
    grace = setTimeout(() => stop.abort(), stopGraceMs);
    grace.unref();
  };
  if (o.signal.aborted) stop.abort();
  else o.signal.addEventListener('abort', relayStop, { once: true });
  let failure: AgentRunError | undefined;
  // When its own subagents are left out, the prompt waits until they are denied.
  // With all its subagents left out, the `Agent` deny rule takes them all: nothing to wait for.
  const gate =
    o.nativeOff?.includes('agents') && !o.nativeOff.includes('subagents')
      ? claudeAgentsGate({
          initId,
          builtins: (version) => claudeBuiltinAgents(o.bin, o.env, version),
          send,
          start: sendPrompt,
          fail: (detail) => {
            failure ??= new AgentRunError(t().claudeAgentsFailed(detail));
            stop.abort();
          },
        })
      : undefined;
  const res = await runProcess({
    bin: o.bin,
    args,
    cwd: o.cwd,
    env: { ...o.env, ...claudeNativeEnv(o.nativeOff), ...claudeFeatureEnv(o.nativeOn) },
    keepStdinOpen: true,
    onSpawn: (c) => {
      child = c;
      // `agentProgressSummaries`: a line now and then on what each subagent is doing (`task_progress`).
      send({
        type: 'control_request',
        request_id: initId,
        request: { subtype: 'initialize', hooks: claudeHooksConfig(o.hooks), agentProgressSummaries: true },
      });
      if (!gate) sendPrompt();
    },
    signal: stop.signal,
    timeoutMs: TURN_TIMEOUT_MS,
    onLine: (line) => {
      if (gate) {
        const msg = parseJsonLine(line);
        if (msg && gate(msg)) return;
      }
      // Only a lifecycle or result line can change what holds the input: the others go by unparsed here.
      const ev = line.includes('"command_lifecycle"') || line.includes('"result"') ? parseJsonLine(line) : null;
      if (ev && steering.handle(ev)) return;
      parser.handle(line);
      if (ev?.type === 'result') maybeEndInput();
    },
  }).finally(() => {
    o.signal.removeEventListener('abort', relayStop);
    clearTimeout(grace);
    // Gone: no message can go in any more.
    inputEnded = true;
    o.onSteer?.(undefined);
    steering.close();
  });
  parser.finish();
  if (failure && !o.signal.aborted) throw failure;
  // Stopped: what its result said it used (an interrupted turn has one), else nothing.
  if (res.aborted || o.signal.aborted) throw new AgentRunError(t().stopped, true, resultUsage(parser.result, before));
  if (claudeTimedOut(res, parser.result)) throw new AgentRunError(t().timedOut);

  const r = parser.result;
  const rejected = r ? undefined : rejectedFlag(res.stderr);
  if (rejected) throw new UnsupportedFlag(rejected);
  if (!r) {
    const why = tail(res.stderr || res.stdout);
    // `failIfUnavailable`: Claude Code stops at start when its sandbox cannot run here.
    if (sandboxed && why && /sandbox/i.test(why)) throw new AgentRunError(t().claudeSandbox(why));
    throw new AgentRunError(why || t().exitedWithoutReply('claude', res.code));
  }
  const usage = claudeTurnUsage(r, before);
  // A shape it could not answer in after its retries: the turn's text is read instead.
  const unshaped = Boolean(run.jsonSchema) && r.subtype === 'error_max_structured_output_retries';
  if (r.is_error && !unshaped) {
    if (r.subtype === 'error_max_budget_usd' && run.maxBudgetUsd)
      throw new AgentRunError(t().claudeBudgetReached(run.maxBudgetUsd), false, usage);
    const detail = typeof r.result === 'string' && r.result ? r.result : (r.errors ?? []).join('\n') || r.subtype;
    throw new AgentRunError(String(detail || t().claudeError), false, usage);
  }
  return {
    sessionId: parser.sessionId ?? newSessionId ?? o.sessionId,
    ...usage,
    ...(run.jsonSchema && !unshaped && r.structured_output !== undefined ? { structured: r.structured_output } : {}),
  };
}

/** How long a message sent into a running turn waits for Claude Code to say it took it (`command_lifecycle`). */
export const CLAUDE_STEER_ACK_MS = 5000;

/**
 * Steering a Claude Code turn (`RunOptions.onSteer`). A user message written to its stream-json input
 * while the turn runs, with `priority: "next"` and a `uuid` of its own, goes into the running turn:
 * Claude Code folds queued messages of priority `now` or `next` into the turn after the current tool
 * calls, before its next model request (framed as "This is how Claude Code surfaces messages the user
 * sends mid-turn…"; `later` waits for the turn's end, `now` may stop it). One it reads once the model
 * has answered runs as a further turn of the same process, with a result of its own. For a message with
 * a uuid it writes `command_lifecycle` lines (`command_uuid`, `state`: queued, started, then completed,
 * cancelled, discarded or refused), and a result's `queued_turn_count` says how many more turns follow.
 * All of it read in Claude Code 2.1.330 (its SDK message schema: `priority`, `command_lifecycle`,
 * `queued_turn_count`, `cancel_async_message`; its print mode's queue), not run.
 *
 * So a message counts as taken once Claude Code says it queued or started it; one it says nothing about
 * within `ackMs` is withdrawn (`cancel_async_message`, a no-op once dequeued) and counts as refused. The
 * run's input stays open after a result while a message of ours waits for its turn or its answer, or
 * more turns follow (`holdsInput`): ending it then would lose the message, or leave a turn without the
 * way to answer its approvals.
 */
export class ClaudeSteering {
  /** Ours, written, that Claude Code has said nothing about yet. */
  private waiting = new Map<string, (taken: boolean) => void>();
  /** Ours that Claude Code queued but has not started. */
  private queued = new Set<string>();
  /** Ours that started a turn of their own since the latest result: those turns are running. */
  private running = new Set<string>();
  private latest: Record<string, any> | undefined;
  private closed = false;

  constructor(
    private write: (msg: unknown) => boolean,
    private ackMs = CLAUDE_STEER_ACK_MS,
  ) {}

  /** The `SteerTurn` for this turn. */
  readonly steer: SteerTurn = (text) => {
    if (this.closed) return Promise.resolve(false);
    const uuid = randomUUID();
    const message = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, priority: 'next', uuid };
    if (!this.write(message)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.waiting.delete(uuid)) return;
        this.write({
          type: 'control_request',
          request_id: `cancel-${uuid}`,
          request: { subtype: 'cancel_async_message', message_uuid: uuid },
        });
        resolve(false);
        this.onChange?.();
      }, this.ackMs);
      timer.unref?.();
      this.waiting.set(uuid, (taken) => {
        clearTimeout(timer);
        resolve(taken);
      });
    });
  };

  /** Called when what holds the input may have changed (a message taken, refused, given up on). */
  onChange?: () => void;

  /** A line of Claude Code's output, parsed: true when it was the lifecycle of a message of ours. */
  handle(ev: Record<string, any>): boolean {
    if (ev.type === 'result') {
      this.latest = ev;
      this.running.clear();
      return false;
    }
    if (ev.type !== 'command_lifecycle') return false;
    const uuid = String(ev.command_uuid ?? '');
    const state = String(ev.state ?? '');
    const answer = this.waiting.get(uuid);
    // Not ours (none of Harness Relay's other messages has a uuid), or ours and done with.
    if (!answer && !this.queued.has(uuid) && !this.running.has(uuid)) return true;
    this.waiting.delete(uuid);
    if (state === 'queued') {
      this.queued.add(uuid);
      answer?.(true);
    } else if (state === 'started') {
      this.queued.delete(uuid);
      if (this.latest) this.running.add(uuid);
      answer?.(true);
    } else {
      // completed, cancelled, discarded, refused: no longer waiting for a turn, and a turn it started is
      // over (its result may still come; nothing more needs the input).
      this.queued.delete(uuid);
      this.running.delete(uuid);
      answer?.(false);
    }
    this.onChange?.();
    return true;
  }

  /**
   * After a result: whether the input must stay open, because more turns follow (its
   * `queued_turn_count`), a message of ours waits for Claude Code to say it took it or for its turn,
   * or one of ours started a turn that has no result yet.
   */
  holdsInput(): boolean {
    const more = typeof this.latest?.queued_turn_count === 'number' && this.latest.queued_turn_count > 0;
    return more || this.waiting.size > 0 || this.queued.size > 0 || this.running.size > 0;
  }

  /** No more messages (the input is ending, or the process is gone): one still waiting counts as refused. */
  close(): void {
    this.closed = true;
    for (const answer of this.waiting.values()) answer(false);
    this.waiting.clear();
  }
}

/** The prompt, plus attached images as image blocks. */
export function claudeContent(prompt: string, images: RunOptions['images']): string | unknown[] {
  const blocks: unknown[] = [];
  for (const img of images ?? []) {
    const data = imageData(img.path);
    if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data } });
  }
  return blocks.length ? [{ type: 'text', text: prompt }, ...blocks] : prompt;
}

function withAllowedTools(tools: string[]): string[] {
  return tools.length ? ['--allowedTools', ...tools] : [];
}

function sumInput(u: any): number | undefined {
  if (!u) return undefined;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
