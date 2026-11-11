import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ACCOUNT_ID_RE,
  MAX_ACCOUNT_LABEL,
  type AccountRunSettings,
  nativeItemsFor,
  nativeOffFor,
  PROVIDERS,
  VOICE_LANGUAGES,
  VOICE_MODELS,
  type LeadAgentSettings,
  type NativeItemsOff,
  type NativePart,
  type Provider,
  type ProviderAccountUpdate,
  type ProviderAccountView,
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

/** A CLI's settings, with its default account's key, name and run settings. */
interface ProviderSettings extends AccountRunSettings {
  bin: string;
  /** The default account's key. */
  apiKey: string;
  /** The default account's name. */
  accountLabel: string;
}

/** An account of a CLI besides its default one, with run settings of its own. */
interface AccountSettings extends AccountRunSettings {
  id: string;
  label: string;
  apiKey: string;
}

/** A new account's run settings: the CLI's own defaults, nothing left out. */
const freshRun = (): AccountRunSettings => ({ defaultModel: '', defaultEffort: '', nativeOff: [], nativeItems: {} });

/** Applies an update's run settings to an account's: what the CLI cannot leave out is dropped. */
function applyRun(p: Provider, run: AccountRunSettings, u: ProviderAccountUpdate): void {
  if (u.defaultModel !== undefined) run.defaultModel = u.defaultModel.trim();
  if (u.defaultEffort !== undefined) run.defaultEffort = u.defaultEffort.trim();
  if (u.nativeOff !== undefined) run.nativeOff = nativeOffFor(p, u.nativeOff);
  if (u.nativeItems !== undefined) run.nativeItems = nativeItemsFor(p, u.nativeItems);
}

/** Env var each CLI reads an API key from. Codex keys go through `codex login --with-api-key` instead. */
export const API_KEY_ENV: Partial<Record<Provider, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  grok: 'XAI_API_KEY',
  cursor: 'CURSOR_API_KEY',
};

/**
 * The variables each CLI takes a sign-in from ahead of the one kept in its home: Claude Code reads
 * `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`)
 * before its own sign-in, Codex an API key from `CODEX_API_KEY` or `OPENAI_API_KEY`, Grok from
 * `XAI_API_KEY`, Cursor from `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN`. An account besides the default one gets none of them from the server's environment
 * (only its own key), or every such account would run as whoever they sign in.
 */
export const CREDENTIAL_ENV: Record<Provider, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  grok: ['XAI_API_KEY'],
  cursor: ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'],
};

const DEFAULT_BIN: Record<Provider, string> = { claude: 'claude', codex: 'codex', grok: 'grok', cursor: 'cursor-agent' };

/**
 * The variable that moves each CLI's home: its sign-in, settings and session transcripts. Cursor's
 * moves its settings and sessions only: its sign-in stays where Cursor keeps it for the computer user
 * (on macOS, the keychain), see `CURSOR_SHARED_SIGN_IN`.
 */
export const AGENT_HOME_ENV: Record<Provider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  grok: 'GROK_HOME',
  cursor: 'CURSOR_CONFIG_DIR',
};

/**
 * Cursor keeps its sign-in once per computer user, under fixed names (macOS: the login keychain;
 * Linux and Windows: an `auth.json` its config folder does not move), and saves an API key it is given
 * there too, over that sign-in. So Cursor gets `AGENT_CLI_CREDENTIAL_STORE=memory`, which keeps what it
 * signs in with to the one run, whenever it runs with a key, and always as an account besides the
 * default one: such an account signs in with its API key only, and never reads or replaces the
 * shared sign-in (`ProviderService.startLogin` refuses it a browser sign-in).
 */
export const CURSOR_SHARED_SIGN_IN = 'AGENT_CLI_CREDENTIAL_STORE';

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

/** A stored JSON value, or undefined when it does not parse. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Name of an account's API key in the system keyring (the default account's: `<provider>-api-key`). */
const keyName = (p: Provider, account = '') => (account ? `${p}-api-key-${account}` : `${p}-api-key`);

/** One account of one CLI, as a key of a set. */
const slot = (p: Provider, account = '') => `${p}\0${account}`;

/**
 * Where the CLIs' homes of the accounts besides each one's default go when there is no folder of the
 * CLIs' own (`agentHome`): Harness Relay's data folder.
 */
export const ACCOUNTS_DIR = join(DATA_DIR, 'accounts');

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
  /** With a keyring: accounts (`slot`) whose key is still in the database because moving it failed. */
  private keysLeftInDb = new Set<string>();
  /** Each CLI's accounts besides its default one, in the order they were added. */
  private accountList: Record<Provider, AccountSettings[]>;
  /** MCP servers, skills and memory for the agents. */
  readonly tools: ToolLibrary;

  constructor(
    private db: Database,
    private keyring?: SecretStore,
  ) {
    const empty = (): ProviderSettings => ({
      bin: '',
      apiKey: '',
      accountLabel: '',
      defaultModel: '',
      defaultEffort: '',
      nativeOff: [],
      nativeItems: {},
    });
    this.providers = { claude: empty(), codex: empty(), grok: empty(), cursor: empty() };
    const rows = db
      .prepare(
        'SELECT provider, bin, api_key, account_label, default_model, default_effort, native_off, native_items FROM provider_settings',
      )
      .all() as {
      provider: Provider;
      bin: string;
      api_key: string;
      account_label: string;
      default_model: string;
      default_effort: string;
      native_off: string;
      native_items: string;
    }[];
    for (const r of rows) {
      if (!PROVIDERS.includes(r.provider)) continue;
      this.providers[r.provider] = {
        bin: r.bin,
        apiKey: r.api_key,
        accountLabel: r.account_label,
        defaultModel: r.default_model,
        defaultEffort: r.default_effort,
        nativeOff: nativeOffFor(r.provider, r.native_off.split(',')),
        nativeItems: nativeItemsFor(r.provider, parseJson(r.native_items)),
      };
    }
    this.accountList = { claude: [], codex: [], grok: [], cursor: [] };
    const accounts = db
      .prepare(
        `SELECT id, provider, label, api_key, default_model, default_effort, native_off, native_items
         FROM provider_accounts ORDER BY position, created_at`,
      )
      .all() as {
      id: string;
      provider: Provider;
      label: string;
      api_key: string;
      default_model: string;
      default_effort: string;
      native_off: string;
      native_items: string;
    }[];
    for (const a of accounts) {
      if (PROVIDERS.includes(a.provider) && ACCOUNT_ID_RE.test(a.id)) {
        this.accountList[a.provider].push({
          id: a.id,
          label: a.label,
          apiKey: a.api_key,
          defaultModel: a.default_model,
          defaultEffort: a.default_effort,
          nativeOff: nativeOffFor(a.provider, a.native_off.split(',')),
          nativeItems: nativeItemsFor(a.provider, parseJson(a.native_items)),
        });
      }
    }
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'default_cwd'").get() as { value: string } | undefined;
    this.cwd = row?.value ?? process.env.RELAY_DEFAULT_CWD ?? process.cwd();
    this.agentHomeDir = this.appSetting('agent_home') ?? '';
    this.agentsView = this.appSetting('agentsview_url') ?? '';
    this.agentsViewLinkValue = this.appSetting('agentsview_link') ?? '';
    const lead = db.prepare("SELECT value FROM app_settings WHERE key = 'lead_agent'").get() as { value: string } | undefined;
    if (lead) {
      try {
        const v = JSON.parse(lead.value) as LeadAgentSettings;
        if (PROVIDERS.includes(v.provider)) {
          this.leadAgent = {
            provider: v.provider,
            model: v.model || undefined,
            effort: v.effort || undefined,
            account: typeof v.account === 'string' && ACCOUNT_ID_RE.test(v.account) ? v.account : undefined,
          };
        }
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
      const accounts: { id: string; key: { apiKey: string }; save: () => void }[] = [
        { id: '', key: this.providers[p], save: () => this.saveProvider(p) },
        ...this.accountList[p].map((a) => ({ id: a.id, key: a, save: () => this.saveAccount(p, a) })),
      ];
      for (const { id, key, save } of accounts) {
        const what = id ? `the ${p} API key of account ${id}` : `the ${p} API key`;
        if (key.apiKey) {
          try {
            keyring.set(keyName(p, id), key.apiKey);
            if (keyring.get(keyName(p, id)) !== key.apiKey) throw new Error('the stored key reads back differently');
            save(); // clears the database copy
            moved = true;
          } catch (err) {
            this.keysLeftInDb.add(slot(p, id));
            console.warn(`[settings] could not move ${what} to the system keyring: ${(err as Error).message}`);
          }
          continue;
        }
        try {
          key.apiKey = keyring.get(keyName(p, id)) ?? '';
        } catch (err) {
          console.warn(`[settings] could not read ${what} from the system keyring: ${(err as Error).message}`);
        }
      }
    }
    // Write the scrubbed page into the database file now; until a checkpoint the old plaintext stays there.
    if (moved) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /** The account's key lives in the database rather than the keyring. */
  private keyInDb(p: Provider, account = ''): boolean {
    return !this.keyring || this.keysLeftInDb.has(slot(p, account));
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
  }

  /** The home a CLI's default account uses under Harness Relay, or undefined when it uses its usual one. */
  agentHomeFor(p: Provider): string | undefined {
    return this.agentHomeDir ? join(this.agentHomeDir, p) : undefined;
  }

  // --- Accounts: each CLI's default account, and any others, each with a home of its own ----------

  /** Where the homes of the accounts besides the CLIs' default ones are: the CLIs' own folder, or `ACCOUNTS_DIR`. */
  get accountsDir(): string {
    return this.agentHomeDir || ACCOUNTS_DIR;
  }

  /** The ids of a CLI's accounts besides its default one, in order. */
  accountIds(p: Provider): string[] {
    return this.accountList[p].map((a) => a.id);
  }

  /** Whether `account` is one of the CLI's accounts (empty: the default account, always). */
  hasAccount(p: Provider, account: string | undefined): boolean {
    return !account || this.accountList[p].some((a) => a.id === account);
  }

  /** The account a run uses: `account` while the CLI has it, else the default account (empty). */
  resolveAccount(p: Provider, account: string | undefined): string {
    return account && this.hasAccount(p, account) ? account : '';
  }

  /** The name the user gave the account; empty = none. */
  accountLabel(p: Provider, account = ''): string {
    if (!account) return this.providers[p].accountLabel;
    return this.accountList[p].find((a) => a.id === account)?.label ?? '';
  }

  /**
   * The CLI's home for an account: the default account's as `agentHomeFor` (undefined = the CLI's
   * usual home), any other's a folder of its own, `<accountsDir>/<provider>-<id>`.
   */
  accountHome(p: Provider, account = ''): string | undefined {
    const id = this.resolveAccount(p, account);
    return id ? join(this.accountsDir, `${p}-${id}`) : this.agentHomeFor(p);
  }

  /** The homes of every account besides the default ones (which `agentHome` and the CLIs' usual homes are). */
  accountHomes(): string[] {
    return PROVIDERS.flatMap((p) => this.accountList[p].map((a) => join(this.accountsDir, `${p}-${a.id}`)));
  }

  private saveAccount(p: Provider, a: AccountSettings): void {
    const position = this.accountList[p].indexOf(a);
    this.db
      .prepare(
        `INSERT INTO provider_accounts (id, provider, label, api_key, position, created_at, default_model, default_effort, native_off, native_items)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, api_key = excluded.api_key, position = excluded.position,
           default_model = excluded.default_model, default_effort = excluded.default_effort,
           native_off = excluded.native_off, native_items = excluded.native_items`,
      )
      .run(
        a.id,
        p,
        a.label,
        this.keyInDb(p, a.id) ? a.apiKey : '',
        position < 0 ? 0 : position,
        Date.now(),
        a.defaultModel,
        a.defaultEffort,
        a.nativeOff.join(','),
        JSON.stringify(a.nativeItems),
      );
  }

  /**
   * Adds an account to a CLI, signed out and with no key; returns its id. The caller checks
   * `MAX_ACCOUNTS`. Its home starts empty, so it runs with the CLI's own defaults and leaves nothing out.
   */
  addAccount(p: Provider, label: string): string {
    let id: string;
    do id = randomBytes(4).toString('hex');
    while (PROVIDERS.some((q) => this.accountList[q].some((a) => a.id === id)));
    const account: AccountSettings = { id, label: label.trim().slice(0, MAX_ACCOUNT_LABEL), apiKey: '', ...freshRun() };
    this.accountList[p].push(account);
    this.saveAccount(p, account);
    return id;
  }

  /**
   * Renames an account, sets or removes its key, or changes its defaults or what its runs leave out
   * (empty `account`: the default one).
   */
  updateAccount(p: Provider, account: string, u: ProviderAccountUpdate): void {
    if (!account) {
      const s = this.providers[p];
      if (u.label !== undefined) s.accountLabel = u.label.trim().slice(0, MAX_ACCOUNT_LABEL);
      if (u.apiKey !== undefined && API_KEY_ENV[p]) s.apiKey = this.storeKey(p, '', u.apiKey);
      applyRun(p, s, u);
      this.saveProvider(p);
      return;
    }
    const a = this.accountList[p].find((x) => x.id === account);
    if (!a) return;
    if (u.apiKey !== undefined && API_KEY_ENV[p]) a.apiKey = this.storeKey(p, account, u.apiKey);
    if (u.label !== undefined) a.label = u.label.trim().slice(0, MAX_ACCOUNT_LABEL);
    applyRun(p, a, u);
    this.saveAccount(p, a);
  }

  /**
   * Forgets an account other than the default one, with its key; returns its home, which the caller
   * deletes (its sign-in and the CLI's sessions are in it). Agents that named it use the default account.
   */
  removeAccount(p: Provider, account: string): string | undefined {
    const a = this.accountList[p].find((x) => x.id === account);
    if (!a) return undefined;
    const home = this.accountHome(p, account);
    if (this.keyring && API_KEY_ENV[p]) {
      try {
        this.keyring.delete(keyName(p, account));
      } catch (err) {
        console.warn(`[settings] could not remove the ${p} API key of account ${account} from the system keyring: ${(err as Error).message}`);
      }
    }
    this.keysLeftInDb.delete(slot(p, account));
    this.accountList[p] = this.accountList[p].filter((x) => x !== a);
    this.db.prepare('DELETE FROM provider_accounts WHERE id = ?').run(account);
    this.accountList[p].forEach((x) => this.saveAccount(p, x));
    if (this.leadAgent.provider === p && this.leadAgent.account === account) this.setLead({ ...this.leadAgent, account: undefined });
    return home;
  }

  /**
   * Stores an account's key in the keyring when there is one (never falling back to the database
   * silently: the user is told and decides), and returns the key to keep in memory.
   */
  private storeKey(p: Provider, account: string, apiKey: string | null): string {
    const key = (apiKey ?? '').trim();
    if (this.keyring) {
      try {
        if (key) this.keyring.set(keyName(p, account), key);
        else this.keyring.delete(keyName(p, account));
      } catch (err) {
        throw new Error(t().keyringFailed((err as Error).message));
      }
      this.keysLeftInDb.delete(slot(p, account));
    }
    return key;
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
    this.leadAgent = {
      provider: lead.provider,
      model: lead.model?.trim() || undefined,
      effort: lead.effort?.trim() || undefined,
      account: lead.account && this.hasAccount(lead.provider, lead.account) ? lead.account : undefined,
    };
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
        `INSERT INTO provider_settings (provider, bin, api_key, account_label, default_model, default_effort, native_off, native_items)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           bin = excluded.bin, api_key = excluded.api_key, account_label = excluded.account_label,
           default_model = excluded.default_model, default_effort = excluded.default_effort,
           native_off = excluded.native_off, native_items = excluded.native_items`,
      )
      .run(
        p,
        s.bin,
        this.keyInDb(p) ? s.apiKey : '',
        s.accountLabel,
        s.defaultModel,
        s.defaultEffort,
        s.nativeOff.join(','),
        JSON.stringify(s.nativeItems),
      );
  }

  bin(p: Provider): string {
    return this.providers[p].bin.trim() || DEFAULT_BIN[p];
  }

  /**
   * How a run as `account` goes (empty or one the CLI does not have, such as one removed since: the
   * default account, as `env()` does).
   */
  private run(p: Provider, account?: string): AccountRunSettings {
    const id = this.resolveAccount(p, account);
    return (id && this.accountList[p].find((a) => a.id === id)) || this.providers[p];
  }

  /** The model an agent of this account runs when it names none; empty = the CLI's own default. */
  defaultModel(p: Provider, account?: string): string {
    return this.run(p, account).defaultModel.trim();
  }

  /** The effort an agent of this account runs with when it names none; empty = the CLI's own default. */
  defaultEffort(p: Provider, account?: string): string {
    return this.run(p, account).defaultEffort.trim();
  }

  /** What this CLI loads by itself in the account's home that Harness Relay's runs leave out. */
  nativeOff(p: Provider, account?: string): NativePart[] {
    return [...this.run(p, account).nativeOff];
  }

  /** Single items of what this CLI loads by itself in the account's home that Harness Relay's runs leave out. */
  nativeItems(p: Provider, account?: string): NativeItemsOff {
    return Object.fromEntries(Object.entries(this.run(p, account).nativeItems).map(([kind, ids]) => [kind, [...(ids ?? [])]]));
  }

  /** Whether Harness Relay keeps an API key for the account (empty: the default one) and gives it to the CLI. */
  hasStoredApiKey(p: Provider, account = ''): boolean {
    return Boolean(API_KEY_ENV[p] && this.apiKey(p, account));
  }

  private apiKey(p: Provider, account: string): string {
    const id = this.resolveAccount(p, account);
    return id ? (this.accountList[p].find((a) => a.id === id)?.apiKey ?? '') : this.providers[p].apiKey;
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

  /** What a CLI has once for all its accounts (and the default account's key); the rest is `updateAccount`. */
  update(p: Provider, u: ProviderSettingsUpdate): void {
    const s = this.providers[p];
    if (u.apiKey !== undefined && API_KEY_ENV[p]) s.apiKey = this.storeKey(p, '', u.apiKey);
    if (u.bin !== undefined) s.bin = u.bin.trim();
    this.saveProvider(p);
  }

  view(): SettingsView {
    return {
      defaultCwd: this.cwd,
      lead: this.lead,
      agentHome: this.agentHomeDir,
      agentsViewUrl: this.agentsView,
      agentsViewLink: this.agentsViewLinkValue,
      providers: PROVIDERS.map((p) => {
        const accounts = this.accountViews(p);
        return {
          provider: p,
          bin: this.providers[p].bin,
          apiKeyMasked: accounts[0]!.apiKeyMasked,
          apiKeyStorage: accounts[0]!.apiKeyStorage,
          accounts,
        };
      }),
    };
  }

  /** A CLI's accounts as Settings shows them, the default one first. */
  private accountViews(p: Provider): ProviderAccountView[] {
    return ['', ...this.accountIds(p)].map((id) => {
      const home = this.accountHome(p, id);
      const run = this.run(p, id);
      return {
        id,
        label: this.accountLabel(p, id),
        apiKeyMasked: mask(this.apiKey(p, id)),
        apiKeyStorage: API_KEY_ENV[p] ? (this.keyInDb(p, id) ? 'database' : this.keyring!.storage) : undefined,
        ...(home ? { home } : {}),
        defaultModel: run.defaultModel,
        defaultEffort: run.defaultEffort,
        nativeOff: this.nativeOff(p, id),
        nativeItems: this.nativeItems(p, id),
      };
    });
  }

  /**
   * Environment for a spawned CLI: the server's env, minus nesting markers, plus stored API keys.
   * With an agent home set, the CLI's home variable points into it, replacing any the server was
   * started with, so the CLI's sign-in, settings and sessions are Harness Relay's own.
   *
   * `account`: one of the CLI's accounts besides its default one (an unknown one is the default
   * account). Its home is a folder of its own, and it gets its own key only: the credentials the
   * server was started with (`CREDENTIAL_ENV`) are the default account's.
   */
  env(p: Provider, account?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of NESTED_AGENT_VARS) delete env[k];
    const id = this.resolveAccount(p, account);
    const keyVar = API_KEY_ENV[p];
    const key = this.apiKey(p, id);
    if (id) for (const k of CREDENTIAL_ENV[p]) delete env[k];
    if (keyVar && key) env[keyVar] = key;
    if (p === 'cursor' && (id || CREDENTIAL_ENV.cursor.some((k) => env[k]))) env[CURSOR_SHARED_SIGN_IN] = 'memory';
    const home = this.accountHome(p, id);
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
