import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ENDPOINT_CLI,
  backendModelId,
  isOpenProvider,
  parseBackendModel,
  type EndpointCli,
  type ModelEndpointView,
  type ModelOption,
  type OpenProvider,
  type Provider,
  type ProviderModels,
} from '../shared/types';
import { openAgents } from './agents/index';
import { openHomeEnv, type OpenCatalog } from './agents/open';
import { capture, stripAnsi, tail } from './process';
import { t } from './i18n';

/** Discovered once per CLI and cached; defaults from Relay settings are layered on at request time. */
export type DiscoveredModels = Omit<ProviderModels, 'defaultModel' | 'defaultEffort'>;

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

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
    own = p === 'claude' ? discoverClaude(env) : p === 'codex' ? await discoverCodex(bin, env) : await discoverGrok(bin, env);
  } catch (err) {
    const efforts = p === 'claude' ? CLAUDE_EFFORTS : p === 'codex' ? CODEX_EFFORTS : GROK_EFFORTS;
    own = { provider: p, models: p === 'claude' ? CLAUDE_MODELS : [], efforts, source: 'builtin', error: (err as Error).message };
  }
  return withEndpointModels(p, own, backends.endpoints);
}

