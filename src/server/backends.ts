import {
  API_BACKENDS,
  API_BACKEND_LABEL,
  BACKEND_LIMITS,
  ENDPOINT_ID_RE,
  isApiBackend,
  parseBackendModel,
  type ApiBackend,
  type KeyStorage,
  type ModelBackendsView,
  type ModelEndpointUpdate,
} from '../shared/types';
import { AgentRunError, type RunBackends, type RunEndpoint } from './agents/types';
import type { Database } from './db';
import { HttpError } from './errors';
import { t } from './i18n';
import { maskSecret, type SecretStore } from './secrets';

/*
 * Model backends: what the open agents (OpenCode, Goose, Cline, OpenHands, Pi) run their models on.
 * An API key for OpenAI, Anthropic and xAI each, and the user's own OpenAI-compatible endpoints, which
 * Claude Code, Codex and Grok can run on too (`endpointModel`).
 * Keys live in the OS credential store (`backend-<id>-api-key`, `endpoint-<id>-api-key`, service
 * `harness-relay`), with the same fallback and migration as the CLIs' API keys (settings.ts): without
 * a credential store they stay in the database; one found there while a store exists is moved into
 * it. Harness Relay never calls these APIs itself: it only hands them to the CLIs.
 */

/** The variable each CLI reads an API backend's key from. */
export const API_BACKEND_ENV: Record<ApiBackend, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
};

/** The host each API backend is reached at (what the relay sandbox lets a run reach). */
export const API_BACKEND_HOST: Record<ApiBackend, string> = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  xai: 'api.x.ai',
};

/**
 * Variables the server may have inherited from the user's shell that would hand an open agent another
 * model provider's key, a sign-in, or another address for one: taken out of the open agents'
 * environment, which gets only the run's own backend (`BackendRun.env`). The well-known model APIs'
 * keys and base URLs; what else the shell holds (`PATH`, `HOME`, `GITHUB_TOKEN`, `AWS_*`, an SSH agent)
 * still reaches the agent, as it does the other CLIs.
 */
export const INHERITED_BACKEND_VARS = [
  // The three backends of Settings.
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'XAI_API_KEY',
  'XAI_BASE_URL',
  'XAI_API_BASE',
  // Other model APIs the CLIs know.
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'VERTEX_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'TOGETHER_API_KEY',
  'TOGETHERAI_API_KEY',
  'FIREWORKS_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_API_KEY',
  'AZURE_API_BASE',
  'COHERE_API_KEY',
  'CO_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'HUGGING_FACE_HUB_TOKEN',
  'PERPLEXITY_API_KEY',
  'CEREBRAS_API_KEY',
  'NVIDIA_API_KEY',
  'REPLICATE_API_TOKEN',
  'VOYAGE_API_KEY',
  'MOONSHOT_API_KEY',
  'DASHSCOPE_API_KEY',
  'ZAI_API_KEY',
  'LITELLM_API_KEY',
  'OLLAMA_HOST',
  'OLLAMA_API_KEY',
  // Amazon Bedrock's API key (other `AWS_*` variables stay, as for the other CLIs).
  'AWS_BEARER_TOKEN_BEDROCK',
];

/** The keyring account of a backend's key. */
export function backendKeyName(id: string): string {
  return isApiBackend(id) ? `backend-${id}-api-key` : `endpoint-${id}-api-key`;
}

interface Row {
  id: string;
  name: string;
  base_url: string;
  models: string;
  api_key: string;
  created_at: number;
}

function parseModels(text: string): string[] {
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string' && m.length > 0) : [];
  } catch {
    return [];
  }
}

interface Endpoint extends RunEndpoint {
  createdAt: number;
}

/**
 * The model backends, stored in SQLite (`model_backends`, schema version 19) and cached in memory,
 * their keys in `keyring` when there is one. A row holds an endpoint (always), or an API backend's key
 * only while that key is kept in the database.
 */
export class ModelBackendStore {
  private apis: Partial<Record<ApiBackend, string>> = {};
  private endpoints: Endpoint[] = [];
  /** With a keyring: backends whose key is still in the database because moving it failed. */
  private keysLeftInDb = new Set<string>();
  /** With a keyring: backends whose key could not be read at startup. */
  private unreadable = new Set<string>();

  constructor(
    private db: Database,
    private keyring?: SecretStore,
  ) {
    const rows = db.prepare('SELECT id, name, base_url, models, api_key, created_at FROM model_backends ORDER BY created_at, id').all() as unknown as Row[];
    for (const r of rows) {
      if (isApiBackend(r.id)) {
        if (r.api_key) this.apis[r.id] = r.api_key;
        continue;
      }
      if (!ENDPOINT_ID_RE.test(r.id)) continue;
      this.endpoints.push({
        id: r.id,
        name: r.name,
        baseUrl: r.base_url,
        models: parseModels(r.models),
        ...(r.api_key ? { apiKey: r.api_key } : {}),
        createdAt: r.created_at,
      });
    }
    if (keyring) this.loadKeys(keyring);
  }

  private ids(): string[] {
    return [...API_BACKENDS, ...this.endpoints.map((e) => e.id)];
  }

  private key(id: string): string {
    return (isApiBackend(id) ? this.apis[id] : this.endpoints.find((e) => e.id === id)?.apiKey) ?? '';
  }

  private setKey(id: string, key: string): void {
    if (isApiBackend(id)) {
      if (key) this.apis[id] = key;
      else delete this.apis[id];
      return;
    }
    const e = this.endpoints.find((x) => x.id === id);
    if (!e) return;
    if (key) e.apiKey = key;
    else delete e.apiKey;
  }

  /** Reads the keys from the keyring, moving any still in the database (saved before) into it. */
  private loadKeys(keyring: SecretStore): void {
    let moved = false;
    for (const id of this.ids()) {
      const name = backendKeyName(id);
      const inDb = this.key(id);
      if (inDb) {
        try {
          keyring.set(name, inDb);
          if (keyring.get(name) !== inDb) throw new Error('the stored key reads back differently');
          this.save(id); // clears the database copy
          moved = true;
        } catch (err) {
          this.keysLeftInDb.add(id);
          console.warn(`[backends] could not move the ${id} API key to the system keyring: ${(err as Error).message}`);
        }
        continue;
      }
      try {
        const key = keyring.get(name);
        if (key) this.setKey(id, key);
      } catch (err) {
        this.unreadable.add(id);
        console.warn(`[backends] could not read the ${id} API key from the system keyring: ${(err as Error).message}`);
      }
    }
    // Write the scrubbed page into the database file now; until a checkpoint the old plaintext stays there.
    if (moved) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** The backend's key lives in the database rather than the keyring. */
  private keyInDb(id: string): boolean {
    return !this.keyring || this.keysLeftInDb.has(id);
  }

  private storage(id: string): KeyStorage {
    return this.keyInDb(id) ? 'database' : this.keyring!.storage;
  }

  /** Writes one backend's row: an endpoint always, an API backend only while its key is in the database. */
  private save(id: string): void {
    const key = this.keyInDb(id) ? this.key(id) : '';
    if (isApiBackend(id)) {
      if (key) {
        this.db
          .prepare(
            `INSERT INTO model_backends (id, api_key, created_at) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key`,
          )
          .run(id, key, Date.now());
      } else {
        this.db.prepare('DELETE FROM model_backends WHERE id = ?').run(id);
      }
      return;
    }
    const e = this.endpoints.find((x) => x.id === id);
    if (!e) return;
    this.db
      .prepare(
        `INSERT INTO model_backends (id, name, base_url, models, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url,
           models = excluded.models, api_key = excluded.api_key`,
      )
      .run(e.id, e.name, e.baseUrl, JSON.stringify(e.models), key, e.createdAt);
  }

  /** Stores or removes a key in the keyring; never falls back to the database silently. */
  private storeKey(id: string, key: string): void {
    if (this.keyring) {
      try {
        if (key) this.keyring.set(backendKeyName(id), key);
        else this.keyring.delete(backendKeyName(id));
      } catch (err) {
        throw new Error(t().keyringFailed((err as Error).message));
      }
      this.keysLeftInDb.delete(id);
    }
    this.unreadable.delete(id);
    this.setKey(id, key);
  }

  /** Sets (or with an empty / null key, removes) an API backend's key. */
  setApiKey(id: ApiBackend, key: string | null): void {
    this.storeKey(id, (key ?? '').trim());
    this.save(id);
  }

  /** Adds an endpoint, or replaces the one with this id (its key stays unless `apiKey` is given). */
  putEndpoint(id: string, u: ModelEndpointUpdate): void {
    let e = this.endpoints.find((x) => x.id === id);
    if (!e) {
      if (this.endpoints.length >= BACKEND_LIMITS.maxEndpoints) throw new HttpError(400, t().tooManyEndpoints(BACKEND_LIMITS.maxEndpoints));
      e = { id, name: u.name, baseUrl: u.baseUrl, models: [...u.models], createdAt: Date.now() };
      this.endpoints.push(e);
    } else {
      Object.assign(e, { name: u.name, baseUrl: u.baseUrl, models: [...u.models] });
    }
    if (u.apiKey !== undefined) {
      try {
        this.storeKey(id, (u.apiKey ?? '').trim());
      } catch (err) {
        this.save(id); // the endpoint itself is saved; only its key was refused
        throw err;
      }
    }
    this.save(id);
  }

  deleteEndpoint(id: string): void {
    const at = this.endpoints.findIndex((x) => x.id === id);
    if (at < 0) throw new HttpError(404, t().endpointNotFound(id));
    // Its key goes first: one left behind would come back for a later endpoint of the same id.
    if (this.keyring) {
      try {
        this.keyring.delete(backendKeyName(id));
      } catch (err) {
        throw new Error(t().keyringFailed((err as Error).message));
      }
    }
    this.endpoints.splice(at, 1);
    this.keysLeftInDb.delete(id);
    this.unreadable.delete(id);
    this.db.prepare('DELETE FROM model_backends WHERE id = ?').run(id);
  }

  /** What the UI sees: keys masked. */
  view(): ModelBackendsView {
    const flags = (id: string) => (this.unreadable.has(id) ? { keyUnreadable: true } : {});
    return {
      apis: API_BACKENDS.map((id) => ({ id, keyMasked: maskSecret(this.apis[id] ?? ''), keyStorage: this.storage(id), ...flags(id) })),
      endpoints: this.endpoints.map((e) => ({
        id: e.id,
        name: e.name,
        baseUrl: e.baseUrl,
        models: [...e.models],
        keyMasked: maskSecret(e.apiKey ?? ''),
        keyStorage: this.storage(e.id),
        ...flags(e.id),
      })),
    };
  }

  /** The backends an open agent can use now: the API backends with a key, and every endpoint. */
  configured(): string[] {
    return [...API_BACKENDS.filter((id) => this.apis[id]), ...this.endpoints.map((e) => e.id)];
  }

  /** The backends with their keys, for one run (a copy: later changes do not reach a run under way). */
  forRun(): RunBackends {
    return {
      apis: { ...this.apis },
      endpoints: this.endpoints.map(({ createdAt: _, ...e }) => ({ ...e, models: [...e.models] })),
    };
  }
}

/** Each API backend's key under the variable the CLIs read it from (`OPENAI_API_KEY`…), for those that have one. */
export function backendEnv(b: RunBackends): Record<string, string> {
  const env: Record<string, string> = {};
  for (const id of API_BACKENDS) {
    const key = b.apis[id];
    if (key) env[API_BACKEND_ENV[id]] = key;
  }
  return env;
}

/** A URL's `host` or `host:port` (its port only when it has one other than the scheme's), or undefined. */
export function urlHost(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname || undefined;
  } catch {
    return undefined;
  }
}

/** A configured backend's name for people: OpenAI, Anthropic, xAI, or the endpoint's name. */
export function backendLabel(b: RunBackends | ModelBackendsView, id: string): string {
  if (isApiBackend(id)) return API_BACKEND_LABEL[id];
  return b.endpoints.find((e) => e.id === id)?.name || id;
}

/**
 * The variable a run of Claude Code, Codex or Grok on an endpoint gets the endpoint's key in, when it
 * has one (Codex's `env_key`, Grok's): never a config file. Claude Code takes it as
 * `ANTHROPIC_AUTH_TOKEN` instead.
 */
export const ENDPOINT_KEY_ENV = 'HARNESS_RELAY_ENDPOINT_API_KEY';

/** A run of Claude Code, Codex or Grok on one of the user's own endpoints. */
export interface EndpointModel {
  /** The member's model id: `<endpoint id>/<model>`. */
  id: string;
  /** The model's own name, as the endpoint serves it. */
  model: string;
  /** The endpoint, with its key when it has one. */
  endpoint: RunEndpoint;
}

/**
 * Whether a model of Claude Code, Codex or Grok is on one of the user's own endpoints: an id
 * `<endpoint id>/<model>` whose endpoint is set up in Settings (`RunOptions.backends`). Undefined for
 * any other model: the CLI's own, or an id of its own that holds a `/` (a provider of the user's Codex
 * config, say), which goes to the CLI as it is.
 */
export function endpointModel(backends: RunBackends | undefined, model: string | undefined): EndpointModel | undefined {
  const parsed = model ? parseBackendModel(model) : undefined;
  const endpoint = parsed && backends?.endpoints.find((e) => e.id === parsed.backend);
  if (!parsed || !endpoint) return undefined;
  return { id: model!.trim(), model: parsed.model, endpoint: { ...endpoint, models: [...endpoint.models] } };
}

/** A run's environment with its endpoint's key in `ENDPOINT_KEY_ENV`, or without that variable when the endpoint has none. */
export function endpointKeyEnv(env: NodeJS.ProcessEnv, run: EndpointModel): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (run.endpoint.apiKey) out[ENDPOINT_KEY_ENV] = run.endpoint.apiKey;
  else delete out[ENDPOINT_KEY_ENV];
  return out;
}

/** What one open-agent run uses: its model's backend, with what the adapter needs to point the CLI at it. */
export interface BackendRun {
  /** The model id as the agent was given it: `<backend>/<model>`. */
  id: string;
  /** One of API_BACKENDS, or the endpoint's id. */
  backend: string;
  kind: ApiBackend | 'endpoint';
  /** The model's own name, without the backend. */
  model: string;
  /**
   * The key of the run's own API backend under its usual variable (`OPENAI_API_KEY`,
   * `ANTHROPIC_API_KEY` or `XAI_API_KEY`), and no other: the agent's commands inherit this environment.
   * Every configured API backend's key only for an adapter that asks for them all
   * (`OpenAgentProcess.allBackendKeys`). An endpoint's key is in `endpoint.apiKey`: the adapter puts it
   * under whatever variable its CLI reads (never in a config file).
   */
  env: Record<string, string>;
  /** The endpoint, when the model is on one: its base URL and key. */
  endpoint?: RunEndpoint;
  /** The hosts this run must reach ("host" or "host:port"): its model's backend. */
  hosts: string[];
  /**
   * Every configured backend, for a CLI whose config lists them all: the endpoints' names and
   * addresses, with keys only for what `env` holds (the run's own backend, or all with `allBackendKeys`).
   */
  backends: RunBackends;
}

/**
 * The backend and model of one open-agent run, from its model id (`RunOptions.model`) and the backends
 * set up in Settings (`RunOptions.backends`). `fallback`: the model to use when none is given (an
 * adapter may know its CLI's default for a configured backend). Throws an AgentRunError the user can
 * act on when there is no model, it is not `<backend>/<model>`, or its backend is not set up.
 */
export function backendRun(
  backends: RunBackends | undefined,
  model: string | undefined,
  cli: string,
  fallback?: string,
  allKeys = false,
): BackendRun {
  const b: RunBackends = backends ?? { apis: {}, endpoints: [] };
  const id = (model?.trim() || fallback?.trim()) ?? '';
  if (!id) throw new AgentRunError(t().openNoModel(cli));
  const parsed = parseBackendModel(id);
  if (!parsed) throw new AgentRunError(t().openBadModel(cli, id));
  /** The backends with the keys this run may hold: its own, or (`allKeys`) every one. */
  const own = (backend: string): RunBackends => ({
    apis: allKeys ? { ...b.apis } : isApiBackend(backend) && b.apis[backend] ? { [backend]: b.apis[backend] } : {},
    endpoints: b.endpoints.map(({ apiKey, ...e }) => ({ ...e, models: [...e.models], ...(apiKey && (allKeys || e.id === backend) ? { apiKey } : {}) })),
  });
  if (isApiBackend(parsed.backend)) {
    if (!b.apis[parsed.backend]) throw new AgentRunError(t().openBackendMissing(cli, API_BACKEND_LABEL[parsed.backend], id));
    const keys = own(parsed.backend);
    return { id, backend: parsed.backend, kind: parsed.backend, model: parsed.model, env: backendEnv(keys), hosts: [API_BACKEND_HOST[parsed.backend]], backends: keys };
  }
  const endpoint = b.endpoints.find((e) => e.id === parsed.backend);
  if (!endpoint) throw new AgentRunError(t().openEndpointMissing(cli, parsed.backend, id));
  const host = urlHost(endpoint.baseUrl);
  const keys = own(endpoint.id);
  return {
    id,
    backend: endpoint.id,
    kind: 'endpoint',
    model: parsed.model,
    env: backendEnv(keys),
    endpoint: { ...endpoint, models: [...endpoint.models] },
    hosts: host ? [host] : [],
    backends: keys,
  };
}
