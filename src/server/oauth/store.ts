import { randomBytes } from 'node:crypto';
import {
  CONNECTOR_LIMITS,
  OAUTH_PROVIDERS,
  OAUTH_USES,
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

  /** Writes a secret (none: deletes it); a credential store that refuses is a 503 that says what was not saved. */
  private setSecret(name: string, value: string, notSaved: (why: string) => string = t().oauthTokenNotSaved): void {
    if (!this.keyring) {
      if (value) this.secrets.set(name, value);
      else this.secrets.delete(name);
      return;
    }
    try {
      if (value) this.keyring.set(name, value);
      else this.keyring.delete(name);
    } catch (err) {
      throw new HttpError(503, notSaved((err as Error).message));
    }
  }

  /** The app a provider is signed in to with: the user's own, else Harness Relay's (none when neither). */
  client(provider: OAuthProviderId): (OAuthClient & { builtIn: boolean }) | undefined {
    const own = this.data.clients[provider];
    const builtIn = BUILT_IN_CLIENTS[provider];
    const secret = this.secret(`oauth-client-${provider}`) || (builtIn?.clientId === own?.clientId ? builtIn?.secret : undefined);
    if (own?.clientId)
      return { clientId: own.clientId, ...(own.tenant ? { tenant: own.tenant } : {}), ...(secret ? { secret } : {}), builtIn: false };
    return builtIn ? { ...builtIn, builtIn: true } : undefined;
  }

  /**
   * Saves the app a provider is signed in to with; true when it is another app than before (another
   * client id or tenant, or none): the accounts that signed in with the one before then need a new
   * sign-in. A tenant is compared without case, none being `common`. The secret is written first: when
   * the credential store refuses it, nothing changes.
   */
  saveClient(provider: OAuthProviderId, u: OAuthClientUpdate): boolean {
    const before = this.client(provider);
    // A secret belongs to the app it was given with: another app (or none) takes it away unless a new one comes.
    const secret = u.secret !== undefined ? u.secret : !u.clientId || u.clientId !== before?.clientId ? '' : undefined;
    if (secret !== undefined) this.setSecret(`oauth-client-${provider}`, secret, t().oauthSecretNotSaved);
    if (u.clientId) this.data.clients[provider] = { clientId: u.clientId, ...(u.tenant ? { tenant: u.tenant } : {}) };
    else delete this.data.clients[provider];
    this.save();
    const after = this.client(provider);
    const tenant = (c: OAuthClient | undefined) => c?.tenant?.trim().toLowerCase() || 'common';
    return before?.clientId !== after?.clientId || tenant(before) !== tenant(after);
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

  /** The account a provider knows by this id (a sign-in of it again updates it). */
  bySubject(provider: OAuthProviderId, subject: string): StoredAccount | undefined {
    return this.data.accounts.find((a) => a.provider === provider && a.subject === subject);
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
   * keeps its id, and what uses it besides this sign-in's uses: incremental consent), connected, with its
   * refresh token and the scopes granted (with those before). The refresh token is stored first: when
   * the credential store refuses it, nothing changes (no account shown as connected without one).
   */
  signedIn(
    provider: OAuthProviderId,
    who: OAuthIdentity,
    uses: readonly OAuthUse[],
    scopes: string[],
    refreshToken: string,
    now: number,
  ): OAuthAccountView {
    let account = this.bySubject(provider, who.subject);
    if (!account) {
      if (this.data.accounts.length >= CONNECTOR_LIMITS.accounts) throw new HttpError(400, t().connectorTooMany(CONNECTOR_LIMITS.accounts));
      const id = this.newId(provider, who.email);
      this.setRefreshToken(id, refreshToken);
      account = { id, provider, subject: who.subject, email: who.email, uses: [], status: 'connected', connectedAt: now, scopes: [] };
      this.data.accounts.push(account);
    } else this.setRefreshToken(account.id, refreshToken);
    account.email = who.email;
    if (who.name) account.name = who.name;
    else delete account.name;
    // In their usual order, each once.
    const had = account.uses;
    account.uses = OAUTH_USES.filter((u) => had.includes(u) || uses.includes(u));
    account.scopes = [...new Set([...account.scopes, ...scopes])];
    account.status = 'connected';
    account.connectedAt = now;
    delete account.error;
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

  /**
   * A new account's id: the provider, the address's name and a random part (`microsoft-ming-3fa2c1`), so
   * that an id is never given again: nothing meant for an account removed (a refresh coming back late,
   * its calendars) can reach a new one. At most 37 characters, so its calendars' ids fit in 40.
   */
  private newId(provider: OAuthProviderId, email: string): string {
    const base = `${provider}-${email
      .replace(/@.*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')}`
      .slice(0, 30)
      .replace(/-+$/, '');
    const taken = new Set(this.data.accounts.map((a) => a.id));
    let id: string;
    do id = `${base}-${randomBytes(3).toString('hex')}`;
    while (taken.has(id));
    return id;
  }
}
