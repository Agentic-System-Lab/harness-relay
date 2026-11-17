import { t } from '../i18n';
import type { OAuthStore } from './store';
import { OAuthSignInError, tokenHost, type AuthorizedFetch, type OAuthProvider } from './providers';

/*
 * The token broker: an account's access token, refreshed shortly before it expires (one refresh at a
 * time per account), kept in memory only; the new refresh token kept when the provider rotates it
 * (Microsoft does); an account whose refresh is refused (`invalid_grant`: revoked, expired, its password
 * changed) marked as needing a new sign-in. `fetch()` sends the token only to the provider's hosts and
 * never follows a redirect with it, the rule a kept password follows: it goes only to the servers it
 * was given for.
 */

/** Refreshed this long before it expires, so a request never starts with a token about to run out. */
const EARLY_MS = 2 * 60_000;

/** A provider's token endpoint's answer. */
export interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** A request to a provider's token endpoint: a form, its answer as JSON (an error answer too). */
export async function tokenRequest(
  provider: OAuthProvider,
  form: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ status: number; body: TokenAnswer }> {
  const res = await fetch(provider.endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: provider.clientId,
      ...(provider.clientSecret ? { client_secret: provider.clientSecret } : {}),
      ...form,
    }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: TokenAnswer = {};
  try {
    body = (await res.json()) as TokenAnswer;
  } catch {
    /* not JSON: the status says it */
  }
  return { status: res.status, body };
}

/** What a token endpoint's error answer says, in a line. */
export function tokenError(status: number, body: TokenAnswer): string {
  return [body.error, body.error_description?.split(/\r?\n/)[0]].filter(Boolean).join(': ') || `HTTP ${status}`;
}

/**
 * A fetch with `token` that goes only to `hosts` (https, or plain http to a stand-in on this computer
 * the environment names), and follows no redirect: a 3xx comes back as it is.
 */
export function hostOnlyFetch(hosts: readonly string[], token: () => Promise<string>): AuthorizedFetch {
  return async (url, init = {}) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(t().oauthHostRefused(url));
    }
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
    if (!hosts.includes(tokenHost(url)) || (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)))
      throw new Error(t().oauthHostRefused(u.host));
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await token()}`);
    return fetch(url, { ...init, headers, redirect: 'manual' });
  };
}

export class TokenBroker {
  private tokens = new Map<string, { token: string; expiresAt: number }>();
  private refreshing = new Map<string, Promise<string>>();
  /**
   * Each account's generation: one more each time it is signed in again or removed (`forget()`). A
   * refresh takes it before it asks the provider, and writes nothing (no refresh token, no `reauth`, no
   * access token) when it changed meanwhile: what came back belongs to a sign-in that is over.
   */
  private generations = new Map<string, number>();

  constructor(
    private store: OAuthStore,
    /** The provider an account signs in with (its app as Settings has it now), or why there is none. */
    private providerOf: (accountId: string) => OAuthProvider,
    private now: () => number = Date.now,
  ) {}

  private generation(accountId: string): number {
    return this.generations.get(accountId) ?? 0;
  }

  private keep(accountId: string, token: string, expiresIn: number | undefined): void {
    this.tokens.set(accountId, { token, expiresAt: this.now() + (expiresIn ?? 3600) * 1000 });
  }

  /**
   * A sign-in of the account just worked: a new generation of it, with the access token the sign-in got
   * (so its first request does not refresh it). A refresh still under way for the sign-in before writes nothing.
   */
  signedIn(accountId: string, token: string, expiresIn: number | undefined): void {
    this.forget(accountId);
    this.keep(accountId, token, expiresIn);
  }

  /**
   * Forget the account's token, and the refresh under way (it was removed, its sign-in replaced, or its
   * app changed): a new generation, so that refresh writes nothing when it comes back.
   */
  forget(accountId: string): void {
    this.generations.set(accountId, this.generation(accountId) + 1);
    this.tokens.delete(accountId);
    this.refreshing.delete(accountId);
  }

  /**
   * The account's access token: the one kept while it is good for more than a couple of minutes, else
   * a new one (`fresh`: a new one anyway, the provider refused the one kept). One refresh at a time per
   * account: callers meanwhile wait for the same one.
   */
  accessToken(accountId: string, fresh = false): Promise<string> {
    const kept = this.tokens.get(accountId);
    if (!fresh && kept && kept.expiresAt - EARLY_MS > this.now()) return Promise.resolve(kept.token);
    const running = this.refreshing.get(accountId);
    if (running) return running;
    const p: Promise<string> = this.refresh(accountId).finally(() => {
      // Only its own: `forget()` may have dropped it, and another refresh begun since.
      if (this.refreshing.get(accountId) === p) this.refreshing.delete(accountId);
    });
    this.refreshing.set(accountId, p);
    return p;
  }

  private async refresh(accountId: string): Promise<string> {
    const account = this.store.account(accountId);
    if (!account) throw new OAuthSignInError(t().oauthAccountGone);
    if (account.status === 'reauth') throw new OAuthSignInError(t().oauthSignInAgain(account.email, account.error ?? ''));
    const refreshToken = this.store.refreshToken(accountId);
    if (!refreshToken) throw new OAuthSignInError(t().oauthNoToken(account.email));
    const provider = this.providerOf(accountId);
    const generation = this.generation(accountId);
    const { status, body } = await tokenRequest(provider, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      ...(provider.refreshWithScopes ? { scope: provider.scopes(account.uses).join(' ') } : {}),
    }).catch((err: Error) => {
      throw new OAuthSignInError(t().oauthRefreshFailed(account.email, err.message));
    });
    // Removed, or signed in again, while the provider was asked: nothing of this answer is written.
    if (this.generation(accountId) !== generation) {
      if (!this.store.account(accountId)) throw new OAuthSignInError(t().oauthAccountGone);
      return this.accessToken(accountId);
    }
    if (!body.access_token) {
      const why = tokenError(status, body);
      // Refused for good: only a new sign-in mends it. Anything else (the network, the provider down) may pass.
      if (body.error === 'invalid_grant' || body.error === 'interaction_required' || body.error === 'consent_required') {
        this.tokens.delete(accountId);
        this.store.needsSignIn(accountId, why);
        throw new OAuthSignInError(t().oauthSignInAgain(account.email, why));
      }
      throw new OAuthSignInError(t().oauthRefreshFailed(account.email, why));
    }
    if (body.refresh_token && body.refresh_token !== refreshToken) this.store.setRefreshToken(accountId, body.refresh_token);
    this.keep(accountId, body.access_token, body.expires_in);
    return body.access_token;
  }

  /**
   * A fetch with the account's token, only to its provider's hosts, following no redirect. A token the
   * provider refuses (401) is refreshed once and the request sent again.
   */
  fetch(accountId: string): AuthorizedFetch {
    const hosts = () => this.providerOf(accountId).hosts;
    return async (url, init) => {
      let fresh = false;
      const send = hostOnlyFetch(hosts(), () => this.accessToken(accountId, fresh));
      const res = await send(url, init);
      if (res.status !== 401) return res;
      await res.body?.cancel().catch(() => undefined);
      fresh = true;
      return send(url, init);
    };
  }
}
