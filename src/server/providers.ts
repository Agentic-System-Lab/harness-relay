import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import {
  PROVIDERS,
  PROVIDER_LABEL,
  isEndpointCli,
  isOpenProvider,
  keyOnlyAccount,
  type AccountStatus,
  type LoginMethod,
  type LoginSessionView,
  type Provider,
  type ProviderAuth,
  type ProviderModels,
  type ProviderStatus,
} from '../shared/types';
import { openAgents } from './agents/index';
import { openHomeEnv } from './agents/open';
import { backendLabel } from './backends';
import { HttpError } from './errors';
import { discoverModels, type DiscoveredModels } from './models';
import { CommandNotFoundError, capture, killTree, spawnInteractive, stripAnsi, tail } from './process';
import { CREDENTIAL_ENV, CURSOR_SHARED_SIGN_IN, type SettingsStore } from './settings';
import { t } from './i18n';

// ---------------------------------------------------------------------------
// Status

function parseVersion(out: string): string | undefined {
  const m = stripAnsi(out).match(/\d+\.\d+\.\d+[\w.-]*/);
  return m?.[0];
}

function firstJsonObject(s: string): Record<string, any> | null {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Whether an account is signed in, and how. Signed out, it says nothing more: the CLIs' own words for
 * that (Claude Code's `"authMethod": "none"`, Codex's "Not logged in") would only repeat the pill.
 */
async function checkAuth(p: Provider, bin: string, env: NodeJS.ProcessEnv): Promise<ProviderAuth> {
  switch (p) {
    case 'claude': {
      const r = await capture(bin, ['auth', 'status'], env);
      const j = firstJsonObject(r.stdout);
      if (!j) return { loggedIn: null, detail: tail(r.stderr || r.stdout, 200) };
      if (!j.loggedIn) return { loggedIn: false };
      return {
        loggedIn: true,
        method: j.authMethod,
        account: j.email ?? j.orgName,
        detail: j.subscriptionType ? t().planDetail(j.subscriptionType) : undefined,
      };
    }
    case 'codex': {
      const r = await capture(bin, ['login', 'status'], env);
      const out = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
      if (/not logged in/i.test(out)) return { loggedIn: false };
      const logged = /logged in/i.test(out);
      const method = out.match(/logged in using ([^\n]+)/i)?.[1]?.trim();
      return { loggedIn: logged ? true : null, method, detail: out.split('\n')[0] };
    }
    case 'grok': {
      const r = await capture(bin, ['models'], env);
      const out = stripAnsi(`${r.stdout}\n${r.stderr}`);
      if (/not (authenticated|signed in)/i.test(out)) return { loggedIn: false };
      const model = out.match(/Default model:\s*(\S+)/i)?.[1];
      return r.code === 0
        ? { loggedIn: true, detail: model ? t().defaultModelDetail(model) : undefined }
        : { loggedIn: null, detail: tail(out, 200) };
    }
    case 'cursor': {
      // With a key it runs on that key, in the one run's memory (`CURSOR_SHARED_SIGN_IN`), which
      // `status` does not sign in with: it would say signed out.
      if (CREDENTIAL_ENV.cursor.some((k) => env[k])) return { loggedIn: true, method: 'API key' };
      // `status` signs nothing in and needs no terminal; anything else it took for a prompt.
      const r = await capture(bin, ['status', '--format', 'json'], { ...env, NO_OPEN_BROWSER: '1' });
      const j = firstJsonObject(r.stdout);
      if (!j) return { loggedIn: null, detail: tail(stripAnsi(r.stderr || r.stdout), 200) };
      if (j.isAuthenticated === true) return { loggedIn: true, account: j.userInfo?.email ?? undefined };
      if (j.status === 'unauthenticated') return { loggedIn: false };
      return { loggedIn: null, detail: typeof j.message === 'string' ? j.message : undefined };
    }
    default:
      return { loggedIn: null };
  }
}

/** One account of one CLI, as a key of a map. */
const slot = (p: Provider, account = '') => `${p}\0${account}`;

export class ProviderService {
  private cache = new Map<Provider, { at: number; status: ProviderStatus }>();
  /** Sign-ins running or finished, by account (`slot`). */
  private logins = new Map<string, LoginSession>();
  /** Models each account's CLI offers (`slot`): asked in its home, whose config has the CLI's own defaults. */
  private modelCache = new Map<string, { at: number; models: Promise<DiscoveredModels> }>();

  constructor(private settings: SettingsStore) {}

  invalidate(p?: Provider): void {
    if (p) {
      this.cache.delete(p);
      for (const key of this.modelCache.keys()) if (key.startsWith(slot(p))) this.modelCache.delete(key);
    } else {
      this.cache.clear();
      this.modelCache.clear();
    }
  }

  /**
   * Models / effort levels of a CLI as one of its accounts runs it (empty: the default account), with
   * that account's own defaults in Harness Relay layered over the CLI's in its home.
   */
  async models(p: Provider, refresh = false, account = ''): Promise<ProviderModels> {
    const id = this.settings.resolveAccount(p, account);
    let entry = this.modelCache.get(slot(p, id));
    if (refresh || !entry || Date.now() - entry.at > 10 * 60_000) {
      const backends = { configured: this.settings.backends.configured(), endpoints: this.settings.backends.view().endpoints };
      entry = { at: Date.now(), models: discoverModels(p, this.settings.bin(p), this.settings.env(p, id), backends) };
      this.modelCache.set(slot(p, id), entry);
    }
    const d = await entry.models;
    return {
      ...d,
      ...(id ? { account: id } : {}),
      defaultModel: this.settings.defaultModel(p, id) || d.cliDefaultModel,
      // Model-specific defaults (e.g. codex catalog) are applied by the client per selected model.
      defaultEffort: this.settings.defaultEffort(p, id) || d.cliDefaultEffort,
    };
  }

  /** Every account of every CLI, each CLI's default account first (`catalogFor` picks one out). */
  async modelsAll(refresh = false): Promise<ProviderModels[]> {
    const all = await Promise.all(
      PROVIDERS.map((p) => Promise.all(['', ...this.settings.accountIds(p)].map((id) => this.models(p, refresh, id)))),
    );
    return all.flat();
  }

  async status(p: Provider, refresh = false): Promise<ProviderStatus> {
    const cached = this.cache.get(p);
    if (!refresh && cached && Date.now() - cached.at < 20_000) return cached.status;
    const bin = this.settings.bin(p);
    const env = this.settings.env(p);
    const ids = ['', ...this.settings.accountIds(p)];
    const account = (id: string, auth: ProviderAuth): AccountStatus => ({
      id,
      label: this.settings.accountLabel(p, id),
      auth,
      usingStoredApiKey: this.settings.hasStoredApiKey(p, id),
    });
    let status: ProviderStatus;
    try {
      const v = await capture(bin, ['--version'], isOpenProvider(p) ? openHomeEnv(openAgents[p].process, env) : env, { timeoutMs: 10_000 });
      const version = parseVersion(v.stdout || v.stderr);
      // Each account signs in on its own, in its own home; an open agent has no sign-in (and no other account).
      const accounts = await Promise.all(
        ids.map(async (id) => {
          try {
            return account(id, isOpenProvider(p) ? this.openAuth(p) : await checkAuth(p, bin, id ? this.settings.env(p, id) : env));
          } catch (err) {
            return account(id, { loggedIn: null, detail: (err as Error).message });
          }
        }),
      );
      const first = accounts[0]!;
      status = { provider: p, installed: true, bin, version, auth: first.auth, usingStoredApiKey: first.usingStoredApiKey, accounts };
    } catch (err) {
      // Not found: Settings says so in its own words, with where to install it. Anything else (the
      // file is there but cannot run, say) is told as it happened.
      const auth: ProviderAuth = { loggedIn: null, detail: err instanceof CommandNotFoundError ? undefined : (err as Error).message };
      const accounts = ids.map((id) => account(id, { loggedIn: null }));
      status = { provider: p, installed: false, bin, auth, usingStoredApiKey: accounts[0]!.usingStoredApiKey, accounts };
    }
    this.cache.set(p, { at: Date.now(), status });
    return status;
  }

  /**
   * An open agent has no sign-in: it is ready once at least one model backend is set up in Settings
   * (and its adapter is done).
   */
  private openAuth(p: Provider): ProviderAuth {
    if (isOpenProvider(p) && !openAgents[p].process.implemented) return { loggedIn: false, detail: t().openNotImplemented(PROVIDER_LABEL[p]) };
    const view = this.settings.backends.view();
    const configured = this.settings.backends.configured();
    if (!configured.length) return { loggedIn: false, detail: t().openNoBackend };
    return { loggedIn: true, detail: t().openBackendsReady(configured.map((id) => backendLabel(view, id)).join(', ')) };
  }

  /**
   * The open agents' status and models follow the model backends, and the model menus of Claude Code,
   * Codex and Grok list the endpoints' models too: asked again after a change (their sign-ins stay
   * cached). Cursor's menu has no endpoint models, so it stays.
   */
  backendsChanged(): void {
    for (const p of PROVIDERS) {
      if (isOpenProvider(p)) this.invalidate(p);
      else if (isEndpointCli(p)) for (const key of this.modelCache.keys()) if (key.startsWith(slot(p))) this.modelCache.delete(key);
    }
  }

  statusAll(refresh = false): Promise<ProviderStatus[]> {
    return Promise.all(PROVIDERS.map((p) => this.status(p, refresh)));
  }

  // -------------------------------------------------------------------------
  // Login / logout

  loginMethods(p: Provider): LoginMethod[] {
    return LOGIN_METHODS[p].map(({ id, key }) => {
      const [label, description] = t().login[key]!;
      return { id, label, description };
    });
  }

  /** Signs an account in (empty `account`: the default one), with the CLI's own flow, in its home. */
  startLogin(p: Provider, methodId?: string, account = ''): LoginSessionView {
    // Its sign-in would replace the default account's (see `keyOnlyAccount`).
    if (keyOnlyAccount(p, this.settings.resolveAccount(p, account))) throw new KeyOnlyAccountError();
    const method = LOGIN_METHODS[p].find((m) => m.id === methodId) ?? LOGIN_METHODS[p][0];
    if (!method) throw new HttpError(400, t().openNoLogin(PROVIDER_LABEL[p]));
    this.logins.get(slot(p, account))?.cancel();
    const env = { ...this.settings.env(p, account), ...method.env };
    const session = new LoginSession(p, account, method, this.settings.bin(p), env, () => this.invalidate(p));
    this.logins.set(slot(p, account), session);
    return session.view();
  }

  login(p: Provider, account = ''): LoginSessionView | null {
    return this.logins.get(slot(p, account))?.view() ?? null;
  }

  sendLoginInput(p: Provider, text: string, account = ''): LoginSessionView | null {
    const s = this.logins.get(slot(p, account));
    if (!s) return null;
    s.write(text);
    return s.view();
  }

  cancelLogin(p: Provider, account = ''): void {
    this.logins.get(slot(p, account))?.cancel();
  }

  /** Stops every sign-in still running (their homes changed); they are forgotten. */
  cancelLogins(): void {
    for (const s of this.logins.values()) s.cancel();
    this.logins.clear();
  }

  /** Forgets an account's sign-in, stopping it if it still runs (the account was removed). */
  forgetLogin(p: Provider, account: string): void {
    this.cancelLogin(p, account);
    this.logins.delete(slot(p, account));
  }

  async logout(p: Provider, account = '', timeoutMs = 30_000): Promise<string> {
    if (!LOGIN_METHODS[p].length) throw new HttpError(400, t().openNoLogin(PROVIDER_LABEL[p]));
    const env = this.settings.env(p, account);
    // Cursor's default account signs out of the sign-in Cursor keeps, which its API key (if any) keeps
    // aside: in the store the server was started with, if it names one.
    if (p === 'cursor' && !this.settings.resolveAccount(p, account)) {
      const own = process.env[CURSOR_SHARED_SIGN_IN];
      if (own) env[CURSOR_SHARED_SIGN_IN] = own;
      else delete env[CURSOR_SHARED_SIGN_IN];
      for (const k of CREDENTIAL_ENV.cursor) delete env[k];
    }
    return this.logoutIn(p, env, timeoutMs);
  }

  /**
   * Signs the CLI out in the environment given: an account's, taken while it was still one (a removed
   * account's id names the default account).
   */
  async logoutIn(p: Provider, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<string> {
    // Signed in for the one run only (an API key, an account besides the default): nothing is kept to sign out of.
    if (p === 'cursor' && env[CURSOR_SHARED_SIGN_IN] === 'memory') {
      this.invalidate(p);
      return '';
    }
    const bin = this.settings.bin(p);
    const args = p === 'claude' ? ['auth', 'logout'] : ['logout'];
    const r = await capture(bin, args, env, { timeoutMs });
    this.invalidate(p);
    if (r.code !== 0) throw new Error(tail(r.stderr || r.stdout, 300) || t().logoutFailed(r.code));
    return tail(r.stdout || r.stderr, 300);
  }

  /** Codex stores API keys itself; the key is piped to `codex login --with-api-key` (in the account's home) and not kept here. */
  async codexApiKeyLogin(key: string, account = ''): Promise<string> {
    const r = await capture(this.settings.bin('codex'), ['login', '--with-api-key'], this.settings.env('codex', account), {
      stdin: key.trim() + '\n',
      timeoutMs: 30_000,
    });
    this.invalidate('codex');
    if (r.code !== 0) throw new Error(tail(r.stderr || r.stdout, 300) || t().codexLoginFailed(r.code));
    return tail(r.stdout || r.stderr, 300);
  }

  shutdown(): void {
    for (const s of this.logins.values()) s.cancel();
  }
}

// ---------------------------------------------------------------------------
// Login sessions: run the CLI's own login flow headlessly and surface its URL / code.

/**
 * `key` names the method's label and description in the server messages (i18n.ts); `env` is added to
 * the CLI's environment for the sign-in.
 */
const LOGIN_METHODS: Record<Provider, { id: string; key: string; args: string[]; env?: Record<string, string> }[]> = {
  claude: [
    {
      id: 'claudeai',
      key: 'claudeSubscription',
      args: ['auth', 'login', '--claudeai'],
    },
    {
      id: 'console',
      key: 'claudeConsole',
      args: ['auth', 'login', '--console'],
    },
  ],
  codex: [
    {
      id: 'device',
      key: 'codexDevice',
      args: ['login', '--device-auth'],
    },
    {
      id: 'browser',
      key: 'codexBrowser',
      args: ['login'],
    },
  ],
  grok: [
    {
      id: 'device',
      key: 'grokDevice',
      args: ['login', '--device-auth'],
    },
    {
      id: 'oauth',
      key: 'grokBrowser',
      args: ['login', '--oauth'],
    },
  ],
  // It prints the sign-in link instead of opening a browser here, so it can be opened on any device.
  cursor: [
    {
      id: 'browser',
      key: 'cursorBrowser',
      args: ['login'],
      env: { NO_OPEN_BROWSER: '1' },
    },
  ],
  // The open agents have no sign-in: they use the model backends in Settings.
  opencode: [],
  goose: [],
  cline: [],
  openhands: [],
  pi: [],
};

/** A browser sign-in asked for an account that signs in with its API key only (`keyOnlyAccount`). */
export class KeyOnlyAccountError extends Error {
  constructor() {
    super(t().cursorAccountLogin);
  }
}

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const URL_RE = /https?:\/\/[^\s"'<>\u001b]+/g;
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/g;

class LoginSession {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  private child: ChildProcess;
  private output = '';
  private state: LoginSessionView['state'] = 'running';
  private exitCode: number | null | undefined;
  private timer: NodeJS.Timeout;

  constructor(
    readonly provider: Provider,
    readonly account: string,
    readonly method: { id: string; args: string[] },
    bin: string,
    env: NodeJS.ProcessEnv,
    private onDone: () => void,
  ) {
    this.child = spawnInteractive(bin, method.args, env);
    const onData = (chunk: Buffer) => {
      this.output += chunk.toString('utf8');
      if (this.output.length > 32_000) this.output = this.output.slice(-32_000);
    };
    this.child.stdout!.on('data', onData);
    this.child.stderr!.on('data', onData);
    this.child.stdin!.on('error', () => {});
    this.child.on('error', (err: NodeJS.ErrnoException) => {
      this.output += `\n${err.code === 'ENOENT' ? new CommandNotFoundError(bin).message : err.message}\n`;
      this.finish('failed', null);
    });
    this.child.on('close', (code) => {
      if (this.state === 'running') this.finish(code === 0 ? 'success' : 'failed', code);
    });
    this.timer = setTimeout(() => this.cancel(), LOGIN_TIMEOUT_MS);
  }

  private finish(state: LoginSessionView['state'], code: number | null): void {
    this.state = state;
    this.exitCode = code;
    clearTimeout(this.timer);
    this.onDone();
  }

  write(text: string): void {
    if (this.state !== 'running' || !this.child.stdin?.writable) return;
    this.child.stdin.write(text.trim() + '\n');
  }

  cancel(): void {
    if (this.state !== 'running') return;
    this.finish('cancelled', null);
    killTree(this.child, 'SIGTERM');
    setTimeout(() => killTree(this.child, 'SIGKILL'), 2000);
  }

  view(): LoginSessionView {
    const clean = stripAnsi(this.output).replace(/\r/g, '');
    const urls = [...new Set(clean.match(URL_RE) ?? [])];
    const codes = [...new Set(clean.match(CODE_RE) ?? [])];
    const lastLine = clean.trimEnd().split('\n').pop() ?? '';
    return {
      id: this.id,
      provider: this.provider,
      account: this.account,
      method: this.method.id,
      state: this.state,
      startedAt: this.startedAt,
      output: clean,
      urls,
      codes,
      wantsInput: this.state === 'running' && /(paste|enter).*code|code.*>\s*$/i.test(lastLine),
      exitCode: this.exitCode,
    };
  }
}
