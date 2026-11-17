import type { OAuthUse } from '../../shared/types';
import { t } from '../i18n';
import type { OAuthStore } from './store';
import { OAuthSignInError, tokenHost, type AuthorizedFetch, type OAuthProvider } from './providers';

/*
 * The token broker: an account's access token for each use, refreshed shortly before it expires (one
 * refresh at a time per account), kept in memory only: Microsoft's for each use apart, since its tokens
 * are each for one resource (Graph, Exchange Online), Google's one for all. The new refresh token is
 * kept when the provider rotates it (Microsoft does), and serves every use; an account whose refresh is
 * refused (`invalid_grant`: revoked, expired, its password changed) is marked as needing a new sign-in. `fetch()` sends the token only to the provider's hosts and
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

/** An access token the broker keeps, and the uses it serves (a sign-in's, for `TokenBroker.signedIn`). */
export interface AccessToken {
  uses: readonly OAuthUse[];
  token: string;
  expiresIn?: number;
}

export class TokenBroker {
  /**
   * The access tokens kept, by account, then by slot: each use's own for a provider whose tokens are
   * each for one resource (Microsoft: the calendar's on Graph, mail's on Exchange Online), else one for
   * every use (`*`: Google's covers each scope granted).
   */
  private tokens = new Map<string, Map<string, { token: string; expiresAt: number }>>();
  private refreshing = new Map<string, Map<string, Promise<string>>>();
  /**
   * Each account's refreshes, one after another: a refresh token one rotates (Microsoft) is the one the
   * next sends, whichever use it is for.
   */
  private queue = new Map<string, Promise<void>>();
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

  /** Where a use's token is kept: its own slot when its provider's tokens are each for one resource, else the one for all. */
  private slot(accountId: string, use: OAuthUse): string {
    try {
      return this.providerOf(accountId).tokenScopes ? use : '*';
    } catch {
      // No app for it now: no refresh either, which says why.
      return use;
    }
  }

  private keep(accountId: string, slot: string, token: string, expiresIn: number | undefined): void {
    let slots = this.tokens.get(accountId);
    if (!slots) this.tokens.set(accountId, (slots = new Map()));
    slots.set(slot, { token, expiresAt: this.now() + (expiresIn ?? 3600) * 1000 });
  }

  /**
   * A sign-in of the account just worked: a new generation of it, with the access tokens the sign-in
   * got, each for the uses it serves (so their first requests do not refresh them). A refresh still
   * under way for the sign-in before writes nothing.
   */
  signedIn(accountId: string, tokens: readonly AccessToken[]): void {
    this.forget(accountId);
    for (const t of tokens)
      for (const slot of new Set(t.uses.map((u) => this.slot(accountId, u)))) this.keep(accountId, slot, t.token, t.expiresIn);
  }

  /**
   * Forget the account's tokens, and the refreshes under way (it was removed, its sign-in replaced, or
   * its app changed): a new generation, so that a refresh writes nothing when it comes back.
   */
  forget(accountId: string): void {
    this.generations.set(accountId, this.generation(accountId) + 1);
    this.tokens.delete(accountId);
    this.refreshing.delete(accountId);
  }

  /**
   * The account's access token for a use: the one kept while it is good for more than a couple of
   * minutes, else a new one (`fresh`: a new one anyway, the server refused the one kept). One refresh at
   * a time per token: callers meanwhile wait for the same one.
   */
  accessToken(accountId: string, use: OAuthUse, fresh = false): Promise<string> {
    const slot = this.slot(accountId, use);
    const kept = this.tokens.get(accountId)?.get(slot);
    if (!fresh && kept && kept.expiresAt - EARLY_MS > this.now()) return Promise.resolve(kept.token);
    const running = this.refreshing.get(accountId)?.get(slot);
    if (running) return running;
    const p: Promise<string> = this.refresh(accountId, use, slot).finally(() => {
      // Only its own: `forget()` may have dropped it, and another refresh begun since.
      const slots = this.refreshing.get(accountId);
      if (slots?.get(slot) === p) slots.delete(slot);
    });
    let slots = this.refreshing.get(accountId);
    if (!slots) this.refreshing.set(accountId, (slots = new Map()));
    slots.set(slot, p);
    return p;
  }

  /** Runs `fn` after the account's refreshes before it are over. */
  private oneAtATime<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.queue.get(accountId) ?? Promise.resolve();
    const run = before.then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queue.set(accountId, settled);
    void settled.then(() => {
      if (this.queue.get(accountId) === settled) this.queue.delete(accountId);
    });
    return run;
  }

  private async refresh(accountId: string, use: OAuthUse, slot: string): Promise<string> {
    const account = this.store.account(accountId);
    if (!account) throw new OAuthSignInError(t().oauthAccountGone);
    if (account.status === 'reauth') throw new OAuthSignInError(t().oauthSignInAgain(account.email, account.error ?? ''));
    // Never asked for a use it was not signed in for: a refusal of that would mark the whole account.
    if (!account.uses.includes(use)) throw new OAuthSignInError(t().oauthNotFor(account.email, use));
    const provider = this.providerOf(accountId);
    const generation = this.generation(accountId);
    // Removed, or signed in again, while the provider was asked: nothing of its answer (or its failure)
    // is written or told; the caller gets the new sign-in's token, or the account being gone.
    const superseded = () => {
      if (!this.store.account(accountId)) throw new OAuthSignInError(t().oauthAccountGone);
      return this.accessToken(accountId, use);
    };
    let answer: { status: number; body: TokenAnswer } | undefined;
    try {
      answer = await this.oneAtATime(accountId, async () => {
        // Another refresh before it found the sign-in refused, or a new sign-in came: not asked.
        if (this.generation(accountId) !== generation) return undefined;
        const now = this.store.account(accountId);
        if (now?.status === 'reauth') throw new OAuthSignInError(t().oauthSignInAgain(now.email, now.error ?? ''));
        // The refresh token as it is now: one another use's refresh rotated is the one sent.
        const refreshToken = this.store.refreshToken(accountId);
        if (!refreshToken) throw new OAuthSignInError(t().oauthNoToken(account.email));
        const a = await tokenRequest(provider, {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          ...(provider.tokenScopes ? { scope: provider.tokenScopes(use).join(' ') } : {}),
        });
        // A rotated refresh token kept at once, before the next refresh reads it.
        if (
          this.generation(accountId) === generation &&
          a.body.access_token &&
          a.body.refresh_token &&
          a.body.refresh_token !== refreshToken
        )
          this.store.setRefreshToken(accountId, a.body.refresh_token);
        return a;
      });
    } catch (err) {
      if (this.generation(accountId) !== generation) return superseded();
      if (err instanceof OAuthSignInError) throw err;
      throw new OAuthSignInError(t().oauthRefreshFailed(account.email, (err as Error).message));
    }
    if (!answer || this.generation(accountId) !== generation) return superseded();
    const { status, body } = answer;
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
    this.keep(accountId, slot, body.access_token, body.expires_in);
    return body.access_token;
  }

  /**
   * A fetch with the account's token for a use, only to its provider's hosts, following no redirect. A
   * token the provider refuses (401) is refreshed once and the request sent again.
   */
  fetch(accountId: string, use: OAuthUse): AuthorizedFetch {
    const hosts = () => this.providerOf(accountId).hosts;
    return async (url, init) => {
      let fresh = false;
      const send = hostOnlyFetch(hosts(), () => this.accessToken(accountId, use, fresh));
      const res = await send(url, init);
      if (res.status !== 401) return res;
      await res.body?.cancel().catch(() => undefined);
      fresh = true;
      return send(url, init);
    };
  }
}
