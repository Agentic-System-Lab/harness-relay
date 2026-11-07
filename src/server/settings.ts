import { join, resolve } from 'node:path';
import {
  PROVIDERS,
  type Provider,
  type ProviderSettingsUpdate,
  type SettingsView,
} from '../shared/types';
import type { Database } from './db';

export const DATA_DIR = resolve(process.env.RELAY_DATA_DIR ?? join(process.cwd(), 'data'));
export const DB_FILE = join(DATA_DIR, 'relay.db');

interface ProviderSettings {
  bin: string;
  apiKey: string;
  defaultModel: string;
  defaultEffort: string;
}

/** Env var each CLI reads an API key from. Codex keys go through `codex login --with-api-key` instead. */
export const API_KEY_ENV: Partial<Record<Provider, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  grok: 'XAI_API_KEY',
};

const DEFAULT_BIN: Record<Provider, string> = { claude: 'claude', codex: 'codex', grok: 'grok' };

/**
 * Variables Claude Code sets for its own child processes. If Harness Relay is started from inside
 * a Claude Code session they would make the spawned `claude` think it is nested.
 */
const NESTED_AGENT_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
];

function mask(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Provider settings and app-wide settings, stored in SQLite and cached in memory. */
export class SettingsStore {
  private providers: Record<Provider, ProviderSettings>;
  private cwd: string;

  constructor(private db: Database) {
    const empty = (): ProviderSettings => ({ bin: '', apiKey: '', defaultModel: '', defaultEffort: '' });
    this.providers = { claude: empty(), codex: empty(), grok: empty() };
    const rows = db
      .prepare('SELECT provider, bin, api_key, default_model, default_effort FROM provider_settings')
      .all() as { provider: Provider; bin: string; api_key: string; default_model: string; default_effort: string }[];
    for (const r of rows) {
      if (!PROVIDERS.includes(r.provider)) continue;
      this.providers[r.provider] = {
        bin: r.bin,
        apiKey: r.api_key,
        defaultModel: r.default_model,
        defaultEffort: r.default_effort,
      };
    }
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'default_cwd'").get() as { value: string } | undefined;
    this.cwd = row?.value ?? process.env.RELAY_DEFAULT_CWD ?? process.cwd();
  }

  private saveProvider(p: Provider): void {
    const s = this.providers[p];
    this.db
      .prepare(
        `INSERT INTO provider_settings (provider, bin, api_key, default_model, default_effort)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           bin = excluded.bin, api_key = excluded.api_key,
           default_model = excluded.default_model, default_effort = excluded.default_effort`,
      )
      .run(p, s.bin, s.apiKey, s.defaultModel, s.defaultEffort);
  }

  bin(p: Provider): string {
    return this.providers[p].bin.trim() || DEFAULT_BIN[p];
  }

  defaultModel(p: Provider): string {
    return this.providers[p].defaultModel.trim();
  }

  defaultEffort(p: Provider): string {
    return this.providers[p].defaultEffort.trim();
  }

  hasStoredApiKey(p: Provider): boolean {
    return Boolean(API_KEY_ENV[p] && this.providers[p].apiKey);
  }

  get defaultCwd(): string {
    return this.cwd;
  }

  setDefaultCwd(cwd: string): void {
    this.cwd = cwd;
    this.db
      .prepare(
        "INSERT INTO app_settings (key, value) VALUES ('default_cwd', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(cwd);
  }

  update(p: Provider, u: ProviderSettingsUpdate): void {
    const s = this.providers[p];
    if (u.bin !== undefined) s.bin = u.bin.trim();
    if (u.defaultModel !== undefined) s.defaultModel = u.defaultModel.trim();
    if (u.defaultEffort !== undefined) s.defaultEffort = u.defaultEffort.trim();
    if (u.apiKey !== undefined && API_KEY_ENV[p]) s.apiKey = (u.apiKey ?? '').trim();
    this.saveProvider(p);
  }

  view(): SettingsView {
    return {
      defaultCwd: this.cwd,
      providers: PROVIDERS.map((p) => ({
        provider: p,
        bin: this.providers[p].bin,
        apiKeyMasked: mask(this.providers[p].apiKey),
        defaultModel: this.providers[p].defaultModel,
        defaultEffort: this.providers[p].defaultEffort,
      })),
    };
  }

  /** Environment for a spawned CLI: the server's env, minus nesting markers, plus stored API keys. */
  env(p: Provider): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of NESTED_AGENT_VARS) delete env[k];
    const keyVar = API_KEY_ENV[p];
    const key = this.providers[p].apiKey;
    if (keyVar && key) env[keyVar] = key;
    return env;
  }
}
