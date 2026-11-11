import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import {
  PROVIDERS,
  PROVIDER_LABEL,
  isOpenProvider,
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
import type { SettingsStore } from './settings';
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

async function checkAuth(p: Provider, bin: string, env: NodeJS.ProcessEnv): Promise<ProviderAuth> {
  switch (p) {
    case 'claude': {
      const r = await capture(bin, ['auth', 'status'], env);
      const j = firstJsonObject(r.stdout);
      if (!j) return { loggedIn: null, detail: tail(r.stderr || r.stdout, 200) };
      return {
        loggedIn: Boolean(j.loggedIn),
        method: j.authMethod,
        account: j.email ?? j.orgName,
        detail: j.subscriptionType ? t().planDetail(j.subscriptionType) : undefined,
      };
    }
    case 'codex': {
      const r = await capture(bin, ['login', 'status'], env);
      const out = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
      const notLogged = /not logged in/i.test(out);
      const logged = !notLogged && /logged in/i.test(out);
      const method = out.match(/logged in using ([^\n]+)/i)?.[1]?.trim();
      return { loggedIn: logged ? true : notLogged ? false : null, method, detail: out.split('\n')[0] };
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
    default:
      return { loggedIn: null };
  }
}

export class ProviderService {
  private cache = new Map<Provider, { at: number; status: ProviderStatus }>();
  private logins = new Map<Provider, LoginSession>();
  private modelCache = new Map<Provider, { at: number; models: Promise<DiscoveredModels> }>();

  constructor(private settings: SettingsStore) {}

  invalidate(p?: Provider): void {
    if (p) {
      this.cache.delete(p);
      this.modelCache.delete(p);
    } else {
      this.cache.clear();
      this.modelCache.clear();
    }
  }

  /** Models / effort levels per provider, with Relay's own defaults layered over the CLI's. */
  async models(p: Provider, refresh = false): Promise<ProviderModels> {
    let entry = this.modelCache.get(p);
    if (refresh || !entry || Date.now() - entry.at > 10 * 60_000) {
      const backends = { configured: this.settings.backends.configured(), endpoints: this.settings.backends.view().endpoints };
      entry = { at: Date.now(), models: discoverModels(p, this.settings.bin(p), this.settings.env(p), backends) };
      this.modelCache.set(p, entry);
    }
    const d = await entry.models;
    return {
      ...d,
      defaultModel: this.settings.defaultModel(p) || d.cliDefaultModel,
      // Model-specific defaults (e.g. codex catalog) are applied by the client per selected model.
      defaultEffort: this.settings.defaultEffort(p) || d.cliDefaultEffort,
    };
  }

  modelsAll(refresh = false): Promise<ProviderModels[]> {
    return Promise.all(PROVIDERS.map((p) => this.models(p, refresh)));
  }

  async status(p: Provider, refresh = false): Promise<ProviderStatus> {
    const cached = this.cache.get(p);
    if (!refresh && cached && Date.now() - cached.at < 20_000) return cached.status;
    const bin = this.settings.bin(p);
    const env = this.settings.env(p);
    let status: ProviderStatus;
    try {
      const v = await capture(bin, ['--version'], isOpenProvider(p) ? openHomeEnv(openAgents[p].process, env) : env, { timeoutMs: 10_000 });
      const version = parseVersion(v.stdout || v.stderr);
      let auth: ProviderAuth;
      try {
        auth = isOpenProvider(p) ? this.openAuth(p) : await checkAuth(p, bin, env);
      } catch (err) {
        auth = { loggedIn: null, detail: (err as Error).message };
      }
      status = { provider: p, installed: true, bin, version, auth, usingStoredApiKey: this.settings.hasStoredApiKey(p) };
    } catch (err) {
      status = {
        provider: p,
        installed: false,
        bin,
        // Not found: Settings says so in its own words, with where to install it. Anything else (the
        // file is there but cannot run, say) is told as it happened.
        auth: { loggedIn: null, detail: err instanceof CommandNotFoundError ? undefined : (err as Error).message },
        usingStoredApiKey: this.settings.hasStoredApiKey(p),
      };
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
   * The open agents' status and models follow the model backends, and the other CLIs' model menus list
   * the endpoints' models too: asked again after a change (the other CLIs' sign-ins stay cached).
   */
  backendsChanged(): void {
    for (const p of PROVIDERS) {
      if (isOpenProvider(p)) this.invalidate(p);
      else this.modelCache.delete(p);
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

  startLogin(p: Provider, methodId?: string): LoginSessionView {
    const method = LOGIN_METHODS[p].find((m) => m.id === methodId) ?? LOGIN_METHODS[p][0];
    if (!method) throw new HttpError(400, t().openNoLogin(PROVIDER_LABEL[p]));
    this.logins.get(p)?.cancel();
    const session = new LoginSession(p, method, this.settings.bin(p), this.settings.env(p), () => this.invalidate(p));
    this.logins.set(p, session);
    return session.view();
  }

  login(p: Provider): LoginSessionView | null {
    return this.logins.get(p)?.view() ?? null;
  }

  sendLoginInput(p: Provider, text: string): LoginSessionView | null {
    const s = this.logins.get(p);
    if (!s) return null;
    s.write(text);
    return s.view();
  }

  cancelLogin(p: Provider): void {
    this.logins.get(p)?.cancel();
  }

  async logout(p: Provider): Promise<string> {
    if (!LOGIN_METHODS[p].length) throw new HttpError(400, t().openNoLogin(PROVIDER_LABEL[p]));
    const bin = this.settings.bin(p);
    const args = p === 'claude' ? ['auth', 'logout'] : ['logout'];
    const r = await capture(bin, args, this.settings.env(p), { timeoutMs: 30_000 });
    this.invalidate(p);
    if (r.code !== 0) throw new Error(tail(r.stderr || r.stdout, 300) || t().logoutFailed(r.code));
    return tail(r.stdout || r.stderr, 300);
  }

  /** Codex stores API keys itself; the key is piped to `codex login --with-api-key` and not kept here. */
  async codexApiKeyLogin(key: string): Promise<string> {
    const r = await capture(this.settings.bin('codex'), ['login', '--with-api-key'], this.settings.env('codex'), {
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

/** `key` names the method's label and description in the server messages (i18n.ts). */
const LOGIN_METHODS: Record<Provider, { id: string; key: string; args: string[] }[]> = {
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
  // The open agents have no sign-in: they use the model backends in Settings.
  opencode: [],
  goose: [],
  cline: [],
  openhands: [],
  pi: [],
};

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
