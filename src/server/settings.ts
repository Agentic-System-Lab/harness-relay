import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  isOpenProvider,
  nativeItemsFor,
  nativeOffFor,
  PROVIDERS,
  SANDBOX_TERMINAL_SUPPORT,
  VOICE_LANGUAGES,
  VOICE_MODELS,
  type LeadAgentSettings,
  type NativeItemsOff,
  type NativePart,
  type Provider,
  type ProviderSettingsUpdate,
  type SettingsView,
  type VoiceLanguage,
  type VoiceModelId,
} from '../shared/types';
import type { RunBackends } from './agents/types';
import { INHERITED_BACKEND_VARS, ModelBackendStore, backendEnv } from './backends';
import type { Database } from './db';
import { t } from './i18n';
import { maskSecret, type SecretStore } from './secrets';
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
  nativeOff: NativePart[];
  nativeItems: NativeItemsOff;
  sandboxTerminal: boolean;
}

/** Env var each CLI reads an API key from. Codex keys go through `codex login --with-api-key` instead. */
export const API_KEY_ENV: Partial<Record<Provider, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  grok: 'XAI_API_KEY',
};

const DEFAULT_BIN: Record<Provider, string> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  opencode: 'opencode',
  goose: 'goose',
  cline: 'cline',
  openhands: 'openhands',
  pi: 'pi',
};

/**
 * The variable that tells an open agent's adapter where its CLI's home is. The open agents always run
 * in a home of Harness Relay's own (`SettingsStore.openAgentHome`), never the user's, since Harness
 * Relay writes their config before each run; each adapter moves its CLI there with the CLI's own
 * variables (XDG folders, its home variable): `OpenAgentProcess.home` in `agents/open.ts`.
 */
export const OPEN_AGENT_HOME_ENV = 'HARNESS_RELAY_AGENT_HOME';
/**
 * Where an open agent's run learns the folders its CLI's homes were in before (a JSON list): an
 * agent-home folder used earlier in **Settings → Agent sessions**, or the data folder's own. What runs
 * kept in their `private/` folders there is kept from this run too (`privateRoots`).
 */
export const OPEN_AGENT_ROOTS_ENV = 'HARNESS_RELAY_AGENT_HOMES_BEFORE';

/** The variable that moves each CLI's home: its sign-in, settings and session transcripts. */
export const AGENT_HOME_ENV: Record<Provider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  grok: 'GROK_HOME',
  opencode: OPEN_AGENT_HOME_ENV,
  goose: OPEN_AGENT_HOME_ENV,
  cline: OPEN_AGENT_HOME_ENV,
  openhands: OPEN_AGENT_HOME_ENV,
  pi: OPEN_AGENT_HOME_ENV,
};

/** Where the open agents' homes are when no agent-home folder is set: in Harness Relay's data folder. */
export const OPEN_HOMES_DIR = join(DATA_DIR, 'agent-homes');

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

const mask = maskSecret;

/** A stored JSON value, or undefined when it does not parse. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
  /** Folder of the CLIs' own homes (absolute); empty = their usual homes. */
  private agentHomeDir: string;
  /** AgentsView's origin; empty = off. */
  private agentsView: string;
  /** Where "Open AgentsView" goes, when not to `agentsView`. */
  private agentsViewLinkValue: string;
  /** Agent homes already created (env() runs for every CLI start and status check). */
  private madeHomes = new Set<string>();
  /** With a keyring: providers whose key is still in the database because moving it failed. */
  private keysLeftInDb = new Set<Provider>();
  /** MCP servers, skills and memory for the agents. */
  readonly tools: ToolLibrary;
  /** The open agents' model backends (API keys and the user's own endpoints). */
  readonly backends: ModelBackendStore;

  constructor(
    private db: Database,
    private keyring?: SecretStore,
  ) {
    const empty = (): ProviderSettings => ({ bin: '', apiKey: '', defaultModel: '', defaultEffort: '', nativeOff: [], nativeItems: {}, sandboxTerminal: false });
    this.providers = Object.fromEntries(PROVIDERS.map((p) => [p, empty()])) as Record<Provider, ProviderSettings>;
    const rows = db
      .prepare('SELECT provider, bin, api_key, default_model, default_effort, native_off, native_items, sandbox_terminal FROM provider_settings')
      .all() as {
      provider: Provider;
      bin: string;
      api_key: string;
      default_model: string;
      default_effort: string;
      native_off: string;
      native_items: string;
      sandbox_terminal: number;
    }[];
    for (const r of rows) {
      if (!PROVIDERS.includes(r.provider)) continue;
      this.providers[r.provider] = {
        bin: r.bin,
        apiKey: r.api_key,
        defaultModel: r.default_model,
        defaultEffort: r.default_effort,
        nativeOff: nativeOffFor(r.provider, r.native_off.split(',')),
        nativeItems: nativeItemsFor(r.provider, parseJson(r.native_items)),
        sandboxTerminal: SANDBOX_TERMINAL_SUPPORT.includes(r.provider) && r.sandbox_terminal === 1,
      };
    }
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'default_cwd'").get() as { value: string } | undefined;
    this.cwd = row?.value ?? process.env.RELAY_DEFAULT_CWD ?? process.cwd();
    this.agentHomeDir = this.appSetting('agent_home') ?? '';
    this.rememberOpenAgentRoot();
    this.agentsView = this.appSetting('agentsview_url') ?? '';
    this.agentsViewLinkValue = this.appSetting('agentsview_link') ?? '';
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
    this.backends = new ModelBackendStore(db, keyring);
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

  private appSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private saveAppSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Folder of the CLIs' own homes when Harness Relay runs them; empty = each CLI's usual home. */
  get agentHome(): string {
    return this.agentHomeDir;
  }

  /** `dir`: an absolute path (validated by the caller), or empty to turn it off. */
  setAgentHome(dir: string): void {
    this.agentHomeDir = dir;
    this.saveAppSetting('agent_home', dir);
    this.rememberOpenAgentRoot();
  }

  /** The folder the open agents' homes are in now: the agent-home folder, else the data folder's. */
  private openAgentRoot(): string {
    return this.agentHomeDir || OPEN_HOMES_DIR;
  }

  /** The agent-home folders the open agents' homes have been in (kept in `app_settings`). */
  private agentRootsUsed(): string[] {
    let used: unknown;
    try {
      used = JSON.parse(this.appSetting('open_agent_roots') ?? '[]');
    } catch {
      used = [];
    }
    return Array.isArray(used) ? used.filter((r): r is string => typeof r === 'string' && r !== '') : [];
  }

  /** Keeps an agent-home folder the open agents' homes are in now among those they have been in. */
  private rememberOpenAgentRoot(): void {
    const used = this.agentRootsUsed();
    if (this.agentHomeDir && !used.includes(this.agentHomeDir)) this.saveAppSetting('open_agent_roots', JSON.stringify([...used, this.agentHomeDir]));
  }

  /**
   * Every folder the open agents' homes have been in, the one now first: what their runs kept in each
   * stays theirs (no other run reads it) and goes with its conversation, also after **Settings → Agent
   * sessions** moved the homes elsewhere.
   */
  openAgentRoots(): string[] {
    return [...new Set([this.openAgentRoot(), OPEN_HOMES_DIR, ...this.agentRootsUsed()])];
  }

  /** An open agent's home in each folder it has been in (`openAgentRoots`), the one now first. */
  openAgentHomes(p: Provider): string[] {
    return this.openAgentRoots().map((root) => join(root, p));
  }

  /** The home a CLI uses under Harness Relay, or undefined when it uses its usual one. */
  agentHomeFor(p: Provider): string | undefined {
    return this.agentHomeDir ? join(this.agentHomeDir, p) : undefined;
  }

  /**
   * An open agent's home: in the agent-home folder when one is set, else in Harness Relay's data
   * folder (`OPEN_HOMES_DIR`). Never the user's own: Harness Relay writes its config before each run.
   * Created (owner-only) by the adapter before the CLI starts (`openAgentHome()` in agents/open.ts).
   */
  openAgentHome(p: Provider): string {
    return this.agentHomeFor(p) ?? join(OPEN_HOMES_DIR, p);
  }

  /** The model backends with their keys, for a run of an open agent (undefined for the other CLIs). */
  backendsFor(p: Provider): RunBackends | undefined {
    return isOpenProvider(p) ? this.backends.forRun() : undefined;
  }

  /** AgentsView's origin, e.g. http://127.0.0.1:8080; empty = off. */
  get agentsViewUrl(): string {
    return this.agentsView;
  }

  setAgentsViewUrl(url: string): void {
    this.agentsView = url;
    this.saveAppSetting('agentsview_url', url);
  }

  /** Where "Open AgentsView" goes (e.g. its Tailscale address); empty = `agentsViewUrl`. Only shown as a link. */
  get agentsViewLink(): string {
    return this.agentsViewLinkValue;
  }

  setAgentsViewLink(url: string): void {
    this.agentsViewLinkValue = url;
    this.saveAppSetting('agentsview_link', url);
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
        `INSERT INTO provider_settings (provider, bin, api_key, default_model, default_effort, native_off, native_items, sandbox_terminal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           bin = excluded.bin, api_key = excluded.api_key,
           default_model = excluded.default_model, default_effort = excluded.default_effort,
           native_off = excluded.native_off, native_items = excluded.native_items,
           sandbox_terminal = excluded.sandbox_terminal`,
      )
      .run(p, s.bin, this.keyInDb(p) ? s.apiKey : '', s.defaultModel, s.defaultEffort, s.nativeOff.join(','), JSON.stringify(s.nativeItems), s.sandboxTerminal ? 1 : 0);
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

  /** What this CLI loads by itself that Harness Relay's runs leave out. */
  nativeOff(p: Provider): NativePart[] {
    return [...this.providers[p].nativeOff];
  }

  /** Single items of what this CLI loads by itself that Harness Relay's runs leave out. */
  nativeItems(p: Provider): NativeItemsOff {
    return Object.fromEntries(Object.entries(this.providers[p].nativeItems).map(([kind, ids]) => [kind, [...(ids ?? [])]]));
  }

  /** Whether the user lets this CLI's commands use a terminal in the relay sandbox (`ProviderSettingsView.sandboxTerminal`). */
  sandboxTerminal(p: Provider): boolean {
    return this.providers[p].sandboxTerminal;
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
    if (u.nativeOff !== undefined) s.nativeOff = nativeOffFor(p, u.nativeOff);
    if (u.nativeItems !== undefined) s.nativeItems = nativeItemsFor(p, u.nativeItems);
    if (u.sandboxTerminal !== undefined) s.sandboxTerminal = SANDBOX_TERMINAL_SUPPORT.includes(p) && u.sandboxTerminal;
    this.saveProvider(p);
  }

  view(): SettingsView {
    return {
      defaultCwd: this.cwd,
      lead: this.lead,
      agentHome: this.agentHomeDir,
      agentsViewUrl: this.agentsView,
      agentsViewLink: this.agentsViewLinkValue,
      providers: PROVIDERS.map((p) => ({
        provider: p,
        bin: this.providers[p].bin,
        apiKeyMasked: mask(this.providers[p].apiKey),
        apiKeyStorage: API_KEY_ENV[p] ? (this.keyInDb(p) ? 'database' : this.keyring!.storage) : undefined,
        defaultModel: this.providers[p].defaultModel,
        defaultEffort: this.providers[p].defaultEffort,
        nativeOff: this.nativeOff(p),
        nativeItems: this.nativeItems(p),
        sandboxTerminal: this.providers[p].sandboxTerminal,
      })),
    };
  }

  /**
   * Environment for a spawned CLI: the server's env, minus nesting markers, plus stored API keys.
   * With an agent home set, the CLI's home variable points into it, replacing any the server was
   * started with, so the CLI's sign-in, settings and sessions are Harness Relay's own.
   * An open agent gets the configured model backends' keys instead of any the server inherited, and
   * `OPEN_AGENT_HOME_ENV` names its home (always one of Harness Relay's own).
   */
  env(p: Provider): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of NESTED_AGENT_VARS) delete env[k];
    if (isOpenProvider(p)) {
      // Only the backends set up in Settings: not a key or an address the server inherited.
      for (const k of INHERITED_BACKEND_VARS) delete env[k];
      Object.assign(env, backendEnv(this.backends.forRun()), {
        [OPEN_AGENT_HOME_ENV]: this.openAgentHome(p),
        [OPEN_AGENT_ROOTS_ENV]: JSON.stringify(this.openAgentRoots().slice(1)),
      });
      return env;
    }
    const keyVar = API_KEY_ENV[p];
    const key = this.providers[p].apiKey;
    if (keyVar && key) env[keyVar] = key;
    const home = this.agentHomeFor(p);
    if (home) {
      // Codex refuses a CODEX_HOME that does not exist.
      if (!this.madeHomes.has(home)) {
        try {
          mkdirSync(home, { recursive: true, mode: 0o700 });
          this.madeHomes.add(home);
        } catch (err) {
          console.warn(`[settings] could not create ${home}: ${(err as Error).message}`);
        }
      }
      env[AGENT_HOME_ENV[p]] = home;
    }
    return env;
  }
}
