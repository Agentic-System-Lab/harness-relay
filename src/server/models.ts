import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ENDPOINT_CLI,
  backendModelId,
  isEndpointCli,
  isOpenProvider,
  parseBackendModel,
  type EndpointCli,
  type ModelEndpointView,
  type ModelOption,
  type OpenProvider,
  type Provider,
  type ProviderModels,
} from '../shared/types';
import { antigravityAppDir, antigravityProbeEnv, antigravityProbeSettings } from './agents/antigravity';
import { openAgents } from './agents/index';
import { openHomeEnv, type OpenCatalog } from './agents/open';
import { capture, converse, stripAnsi, tail } from './process';
import { t } from './i18n';

/** Discovered once per CLI and cached; defaults from Relay settings are layered on at request time. */
export type DiscoveredModels = Omit<ProviderModels, 'defaultModel' | 'defaultEffort'>;

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const CURSOR_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high'];

/** Claude Code accepts aliases that always point at the latest model of each family. */
const CLAUDE_MODELS: ModelOption[] = [
  { id: 'fable', label: 'Fable', latest: true },
  { id: 'opus', label: 'Opus', latest: true },
  { id: 'sonnet', label: 'Sonnet', latest: true },
  { id: 'haiku', label: 'Haiku', latest: true },
];

/** Top-level `key = "value"` pairs of a TOML file (before the first [table]). Enough for codex defaults. */
function readTopLevelToml(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

async function discoverCodex(bin: string, env: NodeJS.ProcessEnv): Promise<DiscoveredModels> {
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  const cfg = readTopLevelToml(join(codexHome, 'config.toml'));
  const base: DiscoveredModels = {
    provider: 'codex',
    models: [],
    efforts: CODEX_EFFORTS,
    cliDefaultModel: cfg.model,
    cliDefaultEffort: cfg.model_reasoning_effort,
    source: 'builtin',
  };
  // The catalog embeds each model's full instructions, so it is several MB of JSON.
  const r = await capture(bin, ['debug', 'models'], env, { timeoutMs: 30_000, maxCapture: 64 * 1024 * 1024 });
  try {
    const catalog = JSON.parse(r.stdout) as { models?: Record<string, any>[] };
    const models: ModelOption[] = (catalog.models ?? [])
      .filter((m) => m.slug && m.visibility !== 'hide')
      .map((m) => ({
        id: String(m.slug),
        label: m.display_name ? String(m.display_name) : undefined,
        efforts: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels.map((l: any) => String(l.effort ?? l)).filter(Boolean)
          : undefined,
        defaultEffort: m.default_reasoning_level ? String(m.default_reasoning_level) : undefined,
      }));
    const efforts = [...new Set(models.flatMap((m) => m.efforts ?? []))];
    return { ...base, models, efforts: efforts.length ? efforts : CODEX_EFFORTS, source: 'cli' };
  } catch {
    return { ...base, error: tail(r.stderr || r.stdout, 200) || t().codexModelsFailed };
  }
}

async function discoverGrok(bin: string, env: NodeJS.ProcessEnv): Promise<DiscoveredModels> {
  const r = await capture(bin, ['models'], env, { timeoutMs: 20_000 });
  const out = stripAnsi(`${r.stdout}\n${r.stderr}`);
  const models: ModelOption[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*[*-]\s+([A-Za-z0-9._:/-]+)/);
    if (m && !models.some((x) => x.id === m[1])) models.push({ id: m[1]! });
  }
  const cliDefaultModel = out.match(/Default model:\s*(\S+)/i)?.[1];
  return {
    provider: 'grok',
    models,
    efforts: GROK_EFFORTS,
    cliDefaultModel,
    source: models.length ? 'cli' : 'builtin',
    error: models.length ? undefined : tail(out, 200) || t().grokModelsEmpty,
  };
}

/** A name as Cursor shows it, without the zero-width spaces and doubled spaces some have. */
const cleanName = (name: unknown) => (typeof name === 'string' ? name.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim() : '');

/** An option's values. */
export const cursorOptionValues = (option: any): string[] =>
  Array.isArray(option?.options) ? option.options.map((o: any) => (typeof o?.value === 'string' ? o.value : '')).filter(Boolean) : [];

/**
 * A Cursor model's reasoning effort: its option of category `thought_level`, unless that is only a
 * thinking switch (`true` / `false`), which is no level to pick (such a model runs at its own).
 */
export function cursorEffortOption(options: unknown): any {
  const option = Array.isArray(options) ? options.find((c: any) => c?.category === 'thought_level') : undefined;
  const values = cursorOptionValues(option);
  return values.length && !values.every((v) => v === 'true' || v === 'false') ? option : undefined;
}

/**
 * Cursor's models from its `cursor/list_available_models` answer (with the parameterized model picker):
 * each model by its base name, with the reasoning efforts of its option of category `thought_level`
 * (named `effort`, `reasoning_effort`, `reasoning`… per model, `cursorEffortOption`) and that option's
 * default. `default` is
 * Auto, which picks a model by itself.
 */
export function parseCursorModels(result: unknown): ModelOption[] {
  const list = (result as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(list)) return [];
  const models: ModelOption[] = [];
  for (const m of list) {
    const id = typeof m?.value === 'string' ? m.value : '';
    if (!id || models.some((x) => x.id === id)) continue;
    const effort = cursorEffortOption(m.configOptions);
    const efforts = effort ? cursorOptionValues(effort) : undefined;
    const label = cleanName(m.name);
    models.push({
      id,
      ...(label && label !== id ? { label } : {}),
      ...(efforts?.length ? { efforts } : { efforts: [] }),
      ...(efforts?.length && typeof effort.currentValue === 'string' ? { defaultEffort: effort.currentValue } : {}),
    });
  }
  return models;
}

/**
 * Asks Cursor for its models over ACP, the way Harness Relay runs it, without a session or a prompt:
 * `initialize`, `authenticate` (not with an API key, which signs it in already), then
 * `cursor/list_available_models`.
 */
async function discoverCursor(bin: string, env: NodeJS.ProcessEnv): Promise<DiscoveredModels> {
  const keyed = Boolean(env.CURSOR_API_KEY || env.CURSOR_AUTH_TOKEN);
  let answer: unknown;
  let error: string | undefined;
  const failed = (msg: Record<string, any>) => String(msg.error?.data?.message ?? msg.error?.message ?? 'error');
  const res = await converse({
    bin,
    args: ['--disable-project-configs', 'acp'],
    cwd: homedir(),
    env: { ...env, NO_OPEN_BROWSER: '1' },
    timeoutMs: 30_000,
    open: (write) =>
      write({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } },
        },
      }),
    onMessage: (msg, write, finish) => {
      const list = () => write({ jsonrpc: '2.0', id: 3, method: 'cursor/list_available_models', params: {} });
      if (msg.method !== undefined) return;
      if (msg.error) {
        error = failed(msg);
        finish();
      } else if (msg.id === 1) {
        const login = Array.isArray(msg.result?.authMethods) && msg.result.authMethods.some((m: any) => m?.id === 'cursor_login');
        if (keyed || !login) list();
        else write({ jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'cursor_login' } });
      } else if (msg.id === 2) list();
      else if (msg.id === 3) {
        answer = msg.result;
        finish();
      }
    },
  });
  const models = parseCursorModels(answer);
  const efforts = [...new Set(models.flatMap((m) => m.efforts ?? []))];
  return {
    provider: 'cursor',
    models,
    efforts: efforts.length ? efforts : CURSOR_EFFORTS,
    source: models.length ? 'cli' : 'builtin',
    error: models.length ? undefined : error || (res.timedOut ? t().timedOut : tail(res.stderr, 200)) || t().cursorModelsFailed,
  };
}

/** The thinking levels an Antigravity model's id may end in, lowest first. */
const AGY_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Antigravity's models from `agy models` (lines `<id>\t<name>`, such as `gemini-4-argon-high\tGemini 4
 * Argon (High)`): one model per base id (`gemini-4-argon`, as its sessions' `model` option names it),
 * with the thinking levels its ids end in (its sessions' `thought_level` option), lowest first.
 */
export function parseAntigravityModels(out: string): ModelOption[] {
  const models: ModelOption[] = [];
  for (const line of stripAnsi(out).split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._:/-]*)\t+(.+?)\s*$/);
    if (!m) continue;
    const [, slug, name] = m as unknown as [string, string, string];
    const level = AGY_LEVELS.find((l) => slug.endsWith(`-${l}`));
    const id = level ? slug.slice(0, -level.length - 1) : slug;
    const label = level ? name.replace(/\s*\([^)]*\)\s*$/, '') : name;
    let model = models.find((x) => x.id === id);
    if (!model) {
      model = { id, ...(label && label !== id ? { label } : {}) };
      models.push(model);
    }
    if (level) model.efforts = [...new Set([...(model.efforts ?? []), level])].sort((a, b) => AGY_LEVELS.indexOf(a) - AGY_LEVELS.indexOf(b));
  }
  return models;
}

/** The model an Antigravity account's settings name (`model`), as a base id with its thinking level when the id carries one. */
export function antigravityDefaultModel(model: unknown, models: readonly ModelOption[]): { model?: string; effort?: string } {
  if (typeof model !== 'string' || !model.trim()) return {};
  const v = model.trim();
  if (models.some((m) => m.id === v)) return { model: v };
  const level = AGY_LEVELS.find((l) => v.endsWith(`-${l}`));
  const id = level ? v.slice(0, -level.length - 1) : undefined;
  return id && models.some((m) => m.id === id) ? { model: id, effort: level } : {};
}

/**
 * Asks Antigravity for its models (`agy models`, signed in: it lists those of the account's plan), in
 * the account's home; with a Gemini API key, told to use it (`antigravityProbeSettings`).
 */
async function discoverAntigravity(bin: string, env: NodeJS.ProcessEnv): Promise<DiscoveredModels> {
  const r = await capture(bin, [...antigravityProbeSettings(env), 'models'], antigravityProbeEnv(env), { timeoutMs: 30_000 });
  const models = parseAntigravityModels(r.stdout);
  let own: unknown;
  try {
    own = (JSON.parse(readFileSync(join(antigravityAppDir(env), 'settings.json'), 'utf8')) as Record<string, unknown>).model;
  } catch {
    own = undefined;
  }
  const def = antigravityDefaultModel(own, models);
  const efforts = [...new Set(models.flatMap((m) => m.efforts ?? []))].sort((a, b) => AGY_LEVELS.indexOf(a) - AGY_LEVELS.indexOf(b));
  return {
    provider: 'antigravity',
    models,
    efforts: efforts.length ? efforts : ANTIGRAVITY_EFFORTS,
    ...(def.model ? { cliDefaultModel: def.model } : {}),
    ...(def.effort ? { cliDefaultEffort: def.effort } : {}),
    source: models.length ? 'cli' : 'builtin',
    error: models.length ? undefined : tail(stripAnsi(`${r.stdout}\n${r.stderr}`).replace(/^Fetching available models\.\.\.\s*/m, ''), 200) || t().antigravityModelsFailed,
  };
}

function discoverClaude(env: NodeJS.ProcessEnv): DiscoveredModels {
  // Claude Code has no list command; read the user's configured default if there is one.
  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let cliDefaultModel: string | undefined = env.ANTHROPIC_MODEL;
  let cliDefaultEffort: string | undefined = env.CLAUDE_CODE_EFFORT_LEVEL;
  try {
    const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    if (!cliDefaultModel && typeof s.model === 'string') cliDefaultModel = s.model;
    if (!cliDefaultEffort && typeof s.effortLevel === 'string') cliDefaultEffort = s.effortLevel;
  } catch {
    /* no settings file */
  }
  return { provider: 'claude', models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS, cliDefaultModel, cliDefaultEffort, source: 'builtin' };
}

/** The model backends set up in Settings: an open agent's models may be on any; Claude Code's, Codex's and Grok's on the endpoints. */
export interface ConfiguredBackends {
  /** API backends with a key, and every endpoint (`ModelBackendStore.configured()`). */
  configured: string[];
  endpoints: ModelEndpointView[];
}

/**
 * An open agent's models: those of its CLI's own catalog (adapter's `models` hook) whose backend is set
 * up, then each endpoint's typed models (`<endpoint id>/<model>`). Harness Relay never asks a model
 * API for its list.
 */
export async function discoverOpenModels(p: OpenProvider, bin: string, env: NodeJS.ProcessEnv, backends: ConfiguredBackends): Promise<DiscoveredModels> {
  const agent = openAgents[p];
  let catalog: OpenCatalog = { models: [] };
  if (agent.models) {
    try {
      catalog = await agent.models(bin, openHomeEnv(agent.process, env));
    } catch (err) {
      catalog = { models: [], error: (err as Error).message };
    }
  }
  const configured = new Set(backends.configured);
  const fromCli = catalog.models.filter((m) => configured.has(parseBackendModel(m.id)?.backend ?? ''));
  const ids = new Set(fromCli.map((m) => m.id));
  const fromEndpoints = backends.endpoints.flatMap((e) =>
    e.models.map((model): ModelOption => ({ id: backendModelId(e.id, model), label: `${model} · ${e.name || e.id}` })).filter((m) => !ids.has(m.id)),
  );
  return {
    provider: p,
    models: [...fromCli, ...fromEndpoints],
    efforts: catalog.efforts ?? agent.efforts,
    ...(catalog.defaultModel && configured.has(parseBackendModel(catalog.defaultModel)?.backend ?? '') ? { cliDefaultModel: catalog.defaultModel } : {}),
    ...(catalog.defaultEffort ? { cliDefaultEffort: catalog.defaultEffort } : {}),
    source: agent.models ? 'cli' : 'builtin',
    ...(catalog.error ? { error: catalog.error } : {}),
  };
}

/**
 * Claude Code's, Codex's or Grok's models with each endpoint's typed models after them
 * (`<endpoint id>/<model>`, marked with the endpoint and the efforts the CLI may send there:
 * `ENDPOINT_CLI`). An id the CLI already lists stays its own.
 */
export function withEndpointModels(p: EndpointCli, d: DiscoveredModels, endpoints: readonly ModelEndpointView[]): DiscoveredModels {
  const ids = new Set(d.models.map((m) => m.id));
  const { efforts, fallbackEffort } = ENDPOINT_CLI[p];
  const fromEndpoints = endpoints.flatMap((e) =>
    e.models
      .map(
        (model): ModelOption => ({
          id: backendModelId(e.id, model),
          label: `${model} · ${e.name || e.id}`,
          endpoint: e.id,
          efforts: [...efforts],
          ...(fallbackEffort ? { defaultEffort: fallbackEffort } : {}),
        }),
      )
      .filter((m) => !ids.has(m.id)),
  );
  return fromEndpoints.length ? { ...d, models: [...d.models, ...fromEndpoints] } : d;
}

export async function discoverModels(
  p: Provider,
  bin: string,
  env: NodeJS.ProcessEnv,
  backends: ConfiguredBackends = { configured: [], endpoints: [] },
): Promise<DiscoveredModels> {
  if (isOpenProvider(p)) {
    try {
      return await discoverOpenModels(p, bin, env, backends);
    } catch (err) {
      return { provider: p, models: [], efforts: openAgents[p].efforts, source: 'builtin', error: (err as Error).message };
    }
  }
  let own: DiscoveredModels;
  try {
    if (p === 'claude') own = discoverClaude(env);
    else if (p === 'codex') own = await discoverCodex(bin, env);
    else if (p === 'cursor') own = await discoverCursor(bin, env);
    else if (p === 'antigravity') own = await discoverAntigravity(bin, env);
    else own = await discoverGrok(bin, env);
  } catch (err) {
    const efforts = { claude: CLAUDE_EFFORTS, codex: CODEX_EFFORTS, grok: GROK_EFFORTS, cursor: CURSOR_EFFORTS, antigravity: ANTIGRAVITY_EFFORTS }[p];
    own = { provider: p, models: p === 'claude' ? CLAUDE_MODELS : [], efforts, source: 'builtin', error: (err as Error).message };
  }
  // Cursor's and Antigravity's models run only through their own services, so the endpoints' models are not theirs.
  return isEndpointCli(p) ? withEndpointModels(p, own, backends.endpoints) : own;
}

