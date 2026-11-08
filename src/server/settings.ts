import { join, resolve } from 'node:path';
import {
  PROVIDERS,
  VOICE_LANGUAGES,
  VOICE_MODELS,
  type LeadAgentSettings,
  type Provider,
  type ProviderSettingsUpdate,
  type SettingsView,
  type VoiceLanguage,
  type VoiceModelId,
} from '../shared/types';
import type { Database } from './db';
import { t } from './i18n';
import type { SecretStore } from './secrets';
import { ToolLibrary } from './tools';

export const DATA_DIR = resolve(process.env.RELAY_DATA_DIR ?? join(process.cwd(), 'data'));
export const DB_FILE = join(DATA_DIR, 'relay.db');

/** Voice input; an unset model means the one recommended for this computer. */
export interface VoiceSettings {
  model?: VoiceModelId;
  language: VoiceLanguage;
  bin: string;
}

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

/** Name of a provider's API key in the system keyring. */
const keyName = (p: Provider) => `${p}-api-key`;

/**
 * Provider settings and app-wide settings, stored in SQLite and cached in memory.
 *
 * API keys go to `keyring` (the OS credential store) when there is one; without it they stay in
 * the database, which only the current user can read.
 */
export class SettingsStore {
  private providers: Record<Provider, ProviderSettings>;
  private cwd: string;
  private leadAgent: LeadAgentSettings = { provider: 'claude' };
  private voiceSettings: VoiceSettings = { language: 'follow', bin: '' };
  /** With a keyring: providers whose key is still in the database because moving it failed. */
  private keysLeftInDb = new Set<Provider>();
  /** MCP servers, skills and memory for the agents. */
  readonly tools: ToolLibrary;

  constructor(
    private db: Database,
    private keyring?: SecretStore,
  ) {
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
    const lead = db.prepare("SELECT value FROM app_settings WHERE key = 'lead_agent'").get() as { value: string } | undefined;
    if (lead) {
      try {
        const v = JSON.parse(lead.value) as LeadAgentSettings;
        if (PROVIDERS.includes(v.provider)) this.leadAgent = { provider: v.provider, model: v.model || undefined, effort: v.effort || undefined };
      } catch {
        /* keep the default */
      }
    }
    const voice = db.prepare("SELECT value FROM app_settings WHERE key = 'voice'").get() as { value: string } | undefined;
    if (voice) {
      try {
        const v = JSON.parse(voice.value) as Partial<VoiceSettings>;
        this.voiceSettings = {
          model: VOICE_MODELS.includes(v.model as VoiceModelId) ? v.model : undefined,
          language: VOICE_LANGUAGES.includes(v.language as VoiceLanguage) ? v.language! : 'follow',
          bin: typeof v.bin === 'string' ? v.bin : '',
        };
      } catch {
        /* keep the defaults */
      }
    }
    if (keyring) this.loadKeys(keyring);
    this.tools = new ToolLibrary(db, keyring);
  }

  /** Reads the keys from the keyring, moving any still in the database (saved before) into it. */
  private loadKeys(keyring: SecretStore): void {
    let moved = false;
    for (const p of PROVIDERS) {
      if (!API_KEY_ENV[p]) continue;
      const s = this.providers[p];
      if (s.apiKey) {
        try {
          keyring.set(keyName(p), s.apiKey);
          if (keyring.get(keyName(p)) !== s.apiKey) throw new Error('the stored key reads back differently');
          this.saveProvider(p); // clears the database copy
          moved = true;
        } catch (err) {
          this.keysLeftInDb.add(p);
          console.warn(`[settings] could not move the ${p} API key to the system keyring: ${(err as Error).message}`);
        }
        continue;
      }
      try {
        s.apiKey = keyring.get(keyName(p)) ?? '';
      } catch (err) {
        console.warn(`[settings] could not read the ${p} API key from the system keyring: ${(err as Error).message}`);
      }
    }
    // Write the scrubbed page into the database file now; until a checkpoint the old plaintext stays there.
    if (moved) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** The provider's key lives in the database rather than the keyring. */
  private keyInDb(p: Provider): boolean {
    return !this.keyring || this.keysLeftInDb.has(p);
  }

  /** The agent that designs the team for auto-team conversations. */
  get lead(): LeadAgentSettings {
    return { ...this.leadAgent };
  }

  setLead(lead: LeadAgentSettings): void {
    this.leadAgent = { provider: lead.provider, model: lead.model?.trim() || undefined, effort: lead.effort?.trim() || undefined };
    this.db
      .prepare(
        "INSERT INTO app_settings (key, value) VALUES ('lead_agent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(this.leadAgent));
  }

  /** Voice input settings. */
  get voice(): VoiceSettings {
    return { ...this.voiceSettings };
  }

  setVoice(update: Partial<VoiceSettings>): void {
    const next = { ...this.voiceSettings };
    if (update.model !== undefined) next.model = update.model;
    if (update.language !== undefined) next.language = update.language;
    if (update.bin !== undefined) next.bin = update.bin.trim();
    this.voiceSettings = next;
    this.db
      .prepare("INSERT INTO app_settings (key, value) VALUES ('voice', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
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
      .run(p, s.bin, this.keyInDb(p) ? s.apiKey : '', s.defaultModel, s.defaultEffort);
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
    if (u.apiKey !== undefined && API_KEY_ENV[p]) {
      const key = (u.apiKey ?? '').trim();
      if (this.keyring) {
        // Never fall back to the database silently: say so and let the user decide.
        try {
          if (key) this.keyring.set(keyName(p), key);
          else this.keyring.delete(keyName(p));
        } catch (err) {
          throw new Error(t().keyringFailed((err as Error).message));
        }
        this.keysLeftInDb.delete(p);
      }
      s.apiKey = key;
    }
    if (u.bin !== undefined) s.bin = u.bin.trim();
    if (u.defaultModel !== undefined) s.defaultModel = u.defaultModel.trim();
    if (u.defaultEffort !== undefined) s.defaultEffort = u.defaultEffort.trim();
    this.saveProvider(p);
  }

  view(): SettingsView {
    return {
      defaultCwd: this.cwd,
      lead: this.lead,
      providers: PROVIDERS.map((p) => ({
        provider: p,
        bin: this.providers[p].bin,
        apiKeyMasked: mask(this.providers[p].apiKey),
        apiKeyStorage: API_KEY_ENV[p] ? (this.keyInDb(p) ? 'database' : this.keyring!.storage) : undefined,
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
