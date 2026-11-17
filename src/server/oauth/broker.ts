import type { OAuthUse } from '../../shared/types';
import { t } from '../i18n';
import { OAuthSignInError, tokenHost, type AuthorizedFetch, type OAuthProvider } from './providers';

/*
 * The token broker: a sign-in's access token, refreshed shortly before it expires (one refresh at a
 * time per sign-in), kept in memory only; the new refresh token kept when the provider rotates it
 * (Microsoft does); a sign-in whose refresh is refused (`invalid_grant`: revoked, expired, its password
 * changed) marked as needing a new one. `fetch()` sends the token only to the provider's hosts and
 * never follows a redirect with it, the rule a kept password follows: it goes only to the servers it
 * was given for. Its sign-ins are an account's (`OAuthStore`) or a tool library MCP server's own
 * (`ToolLibrary`, `oauth/mcp.ts`), each broker keeping one kind, by its id (`TokenGrants`).
 */

/**
 * The sign-ins a broker refreshes, by id: whose each is (for what it says), what uses it, whether it
 * needs a new sign-in, and its refresh token, kept in the credential store.
 */
export interface TokenGrants {
  grant(id: string):
    | {
        /** Whose sign-in it is, as the messages name it: an account's address, an MCP server's name. */
        label: string;
        status: 'connected' | 'reauth';
        /** Why it needs a new sign-in. */
        error?: string;
        uses: readonly OAuthUse[];
        /** Its sign-in brought no refresh token: once its access token runs out, it needs a new sign-in. */
        noRefresh?: boolean;
      }
    | undefined;
  /** Its refresh token ('' when none can be read). */
  refreshToken(id: string): string;
  /** The provider's new refresh token (it rotates them), in place of the one kept. */
  setRefreshToken(id: string, token: string): void;
  /** Its sign-in no longer works: it needs a new one (the tools and Settings say so). */
  needsSignIn(id: string, why: string): void;
}

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
  // A client secret in a Basic header (`client_secret_basic`), or in the form.
  const basic = provider.clientSecret && provider.clientSecretBasic;
  const res = await fetch(provider.endpoints.token, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...(basic ? { authorization: basicAuth(provider.clientId, provider.clientSecret!) } : {}),
    },
    body: new URLSearchParams({
      client_id: provider.clientId,
      ...(provider.clientSecret && !basic ? { client_secret: provider.clientSecret } : {}),
      ...provider.tokenParams,
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

/** A client's id and secret as a Basic header (`client_secret_basic`), each part form-encoded first (RFC 6749, 2.3.1). */
export function basicAuth(clientId: string, secret: string): string {
  const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
  return `Basic ${Buffer.from(`${enc(clientId)}:${enc(secret)}`).toString('base64')}`;
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
   * Each sign-in's generation: one more each time it is signed in again or removed (`forget()`). A
   * refresh takes it before it asks the provider, and writes nothing (no refresh token, no `reauth`, no
   * access token) when it changed meanwhile: what came back belongs to a sign-in that is over.
   */
  private generations = new Map<string, number>();

  constructor(
    private store: TokenGrants,
    /** The provider a sign-in is with (an account's app as Settings has it now, an MCP server's as discovered), or why there is none. */
    private providerOf: (accountId: string) => OAuthProvider,
    private now: () => number = Date.now,
  ) {}

  /** The access token kept for it now, if any (to revoke, when it has no refresh token). */
  held(accountId: string): string | undefined {
    return this.tokens.get(accountId)?.token;
  }

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
   * The account's access token: the one kept while it is good for more than a couple of minutes
   * (`earlyMs`: for longer, a turn's), else a new one (`fresh`: a new one anyway, the provider refused
   * the one kept). One refresh at a time per account: callers meanwhile wait for the same one.
   */
  accessToken(accountId: string, fresh = false, earlyMs = EARLY_MS): Promise<string> {
    const kept = this.tokens.get(accountId);
    if (!fresh && kept && kept.expiresAt - earlyMs > this.now()) return Promise.resolve(kept.token);
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
    const account = this.store.grant(accountId);
    if (!account) throw new OAuthSignInError(t().oauthAccountGone);
    if (account.status === 'reauth') throw new OAuthSignInError(t().oauthSignInAgain(account.label, account.error ?? ''));
    // A sign-in that brought no refresh token, its access token run out (or lost when the server restarted).
    if (account.noRefresh) {
      this.tokens.delete(accountId);
      this.store.needsSignIn(accountId, t().oauthTokenRanOut);
      throw new OAuthSignInError(t().oauthSignInAgain(account.label, t().oauthTokenRanOut));
    }
    const refreshToken = this.store.refreshToken(accountId);
    if (!refreshToken) throw new OAuthSignInError(t().oauthNoToken(account.label));
    const provider = this.providerOf(accountId);
    const generation = this.generation(accountId);
    // Removed, or signed in again, while the provider was asked: nothing of its answer (or its failure)
    // is written or told; the caller gets the new sign-in's token, or the account being gone.
    const superseded = () => {
      if (!this.store.grant(accountId)) throw new OAuthSignInError(t().oauthAccountGone);
      return this.accessToken(accountId);
    };
    let answer: { status: number; body: TokenAnswer };
    try {
      answer = await tokenRequest(provider, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        ...(provider.refreshWithScopes ? { scope: provider.scopes(account.uses).join(' ') } : {}),
      });
    } catch (err) {
      if (this.generation(accountId) !== generation) return superseded();
      throw new OAuthSignInError(t().oauthRefreshFailed(account.label, (err as Error).message));
    }
    if (this.generation(accountId) !== generation) return superseded();
    const { status, body } = answer;
    if (!body.access_token) {
      const why = tokenError(status, body);
      // Refused for good: only a new sign-in mends it. Anything else (the network, the provider down) may pass.
      if (body.error === 'invalid_grant' || body.error === 'interaction_required' || body.error === 'consent_required') {
        this.tokens.delete(accountId);
        this.store.needsSignIn(accountId, why);
        throw new OAuthSignInError(t().oauthSignInAgain(account.label, why));
      }
      throw new OAuthSignInError(t().oauthRefreshFailed(account.label, why));
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
