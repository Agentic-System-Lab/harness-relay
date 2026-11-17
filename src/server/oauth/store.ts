import {
  CONNECTOR_LIMITS,
  OAUTH_PROVIDERS,
  type KeyStorage,
  type OAuthAccountView,
  type OAuthClientUpdate,
  type OAuthClientView,
  type OAuthProviderId,
  type OAuthUse,
} from '../../shared/types';
import type { Database } from '../db';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { SecretStore } from '../secrets';
import { BUILT_IN_CLIENTS, type OAuthClient, type OAuthIdentity } from './providers';

/*
 * The accounts that sign in with OAuth and the apps they sign in with, kept under `oauth` in
 * `app_settings`. Their secrets go to the OS credential store (or the database encrypted, `secrets.ts`),
 * one entry each: an account's refresh token as `oauth-<id>`, a provider's client secret as
 * `oauth-client-<provider>`. Access tokens are never kept: the broker holds them in memory
 * (`broker.ts`). The UI sees an account's address and state, never a token, and no CLI ever gets one.
 */

interface StoredAccount extends Omit<OAuthAccountView, 'error'> {
  /** Its id at the provider, which never changes: a sign-in of the same account updates it. */
  subject: string;
  /** The scopes it was granted. */
  scopes: string[];
  error?: string;
}

interface Stored {
  clients: Partial<Record<OAuthProviderId, { clientId: string; tenant?: string }>>;
  accounts: StoredAccount[];
  /** Without a credential store (tests only): the secrets, by entry name. */
  secrets?: Record<string, string>;
}

const KEY = 'oauth';

export class OAuthStore {
  private data: Stored = { clients: {}, accounts: [] };
  private secrets = new Map<string, string>();

  constructor(
    private db: Database,
    private keyring?: SecretStore,
  ) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (row) {
      try {
        const v = JSON.parse(row.value) as Partial<Stored>;
        this.data = {
          clients: v.clients && typeof v.clients === 'object' ? v.clients : {},
          accounts: Array.isArray(v.accounts) ? v.accounts : [],
        };
        if (!keyring && v.secrets) for (const [k, s] of Object.entries(v.secrets)) this.secrets.set(k, s);
      } catch {
        /* none */
      }
    }
  }

  private save(): void {
    const stored: Stored = { ...this.data, ...(this.keyring ? {} : { secrets: Object.fromEntries(this.secrets) }) };
    this.db
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(KEY, JSON.stringify(stored));
  }

  get storage(): KeyStorage {
    return this.keyring?.storage ?? 'database';
  }

  /** A secret ('' when none, or the store cannot be read now). */
  private secret(name: string): string {
    if (!this.keyring) return this.secrets.get(name) ?? '';
    try {
      return this.keyring.get(name) ?? '';
    } catch {
      return '';
    }
  }

  private setSecret(name: string, value: string): void {
    if (!this.keyring) {
      if (value) this.secrets.set(name, value);
      else this.secrets.delete(name);
      return;
    }
    try {
      if (value) this.keyring.set(name, value);
      else this.keyring.delete(name);
    } catch (err) {
      throw new HttpError(503, t().oauthTokenNotSaved((err as Error).message));
    }
  }

  /** The app a provider is signed in to with: the user's own, else Harness Relay's (none when neither). */
  client(provider: OAuthProviderId): (OAuthClient & { builtIn: boolean }) | undefined {
    const own = this.data.clients[provider];
    const secret = this.secret(`oauth-client-${provider}`);
    if (own?.clientId)
      return { clientId: own.clientId, ...(own.tenant ? { tenant: own.tenant } : {}), ...(secret ? { secret } : {}), builtIn: false };
    const builtIn = BUILT_IN_CLIENTS[provider];
    return builtIn ? { clientId: builtIn, builtIn: true } : undefined;
  }

  saveClient(provider: OAuthProviderId, u: OAuthClientUpdate): void {
    const before = this.data.clients[provider]?.clientId;
    if (u.clientId) this.data.clients[provider] = { clientId: u.clientId, ...(u.tenant ? { tenant: u.tenant } : {}) };
    else delete this.data.clients[provider];
    // A secret belongs to the app it was given with: another app (or none) takes it away unless a new one comes.
    if (u.secret !== undefined) this.setSecret(`oauth-client-${provider}`, u.secret);
    else if (!u.clientId || u.clientId !== before) this.setSecret(`oauth-client-${provider}`, '');
    this.save();
  }

  clientsView(device: (provider: OAuthProviderId) => boolean): OAuthClientView[] {
    return OAUTH_PROVIDERS.map((provider) => {
      const c = this.client(provider);
      return {
        provider,
        clientId: c?.clientId ?? '',
        builtIn: Boolean(c?.builtIn),
        ...(c?.tenant ? { tenant: c.tenant } : {}),
        secret: c?.secret ? '••••' : '',
        device: device(provider),
      };
    });
  }

  accounts(): OAuthAccountView[] {
    return this.data.accounts.map(({ subject: _s, scopes: _sc, ...view }) => view);
  }

  account(id: string): StoredAccount | undefined {
    return this.data.accounts.find((a) => a.id === id);
  }

  /** An account's refresh token ('' when none can be read). */
  refreshToken(id: string): string {
    return this.secret(`oauth-${id}`);
  }

  /** A provider's new refresh token (it rotates them: Microsoft does), in place of the one kept. */
  setRefreshToken(id: string, token: string): void {
    this.setSecret(`oauth-${id}`, token);
  }

  /**
   * A sign-in that worked: the account it signed in (the same one again, by the provider's id for it,
   * keeps its id and what uses it), connected, with its refresh token and the scopes granted.
   */
  signedIn(
    provider: OAuthProviderId,
    who: OAuthIdentity,
    uses: readonly OAuthUse[],
    scopes: string[],
    refreshToken: string,
    now: number,
  ): OAuthAccountView {
    let account = this.data.accounts.find((a) => a.provider === provider && a.subject === who.subject);
    if (!account) {
      if (this.data.accounts.length >= CONNECTOR_LIMITS.accounts) throw new HttpError(400, t().connectorTooMany(CONNECTOR_LIMITS.accounts));
      account = {
        id: this.newId(provider, who.email),
        provider,
        subject: who.subject,
        email: who.email,
        uses: [],
        status: 'connected',
        connectedAt: now,
        scopes: [],
      };
      this.data.accounts.push(account);
    }
    account.email = who.email;
    if (who.name) account.name = who.name;
    else delete account.name;
    account.uses = [...new Set([...account.uses, ...uses])];
    account.scopes = scopes;
    account.status = 'connected';
    account.connectedAt = now;
    delete account.error;
    this.setRefreshToken(account.id, refreshToken);
    this.save();
    const { subject: _s, scopes: _sc, ...view } = account;
    return view;
  }

  /** Its sign-in no longer works: it needs signing in again (the tools and Settings say so). */
  needsSignIn(id: string, why: string): void {
    const a = this.account(id);
    if (!a) return;
    a.status = 'reauth';
    a.error = why;
    this.save();
  }

  delete(id: string): void {
    const i = this.data.accounts.findIndex((a) => a.id === id);
    if (i < 0) throw new HttpError(404, t().connectorNotFound(id));
    this.data.accounts.splice(i, 1);
    try {
      this.setSecret(`oauth-${id}`, '');
    } catch {
      /* gone from the list all the same */
    }
    this.save();
  }

  /** A new account's id: the provider and the address's name (`microsoft-ming`, `microsoft-ming-2`…). */
  private newId(provider: OAuthProviderId, email: string): string {
    const base = `${provider}-${email
      .replace(/@.*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')}`
      .replace(/-+$/, '')
      .slice(0, 34);
    const taken = new Set(this.data.accounts.map((a) => a.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }
}
