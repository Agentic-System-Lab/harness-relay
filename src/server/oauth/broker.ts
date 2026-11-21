import type { OAuthUse } from '../../shared/types';
import { t } from '../i18n';
import { OAuthSignInError, tokenHost, type AuthorizedFetch, type OAuthProvider } from './providers';

/*
 * The token broker: a sign-in's access token for each use, refreshed shortly before it expires (one
 * refresh at a time per sign-in), kept in memory only: Microsoft's for each use apart, since its tokens
 * are each for one resource (Graph, Exchange Online), Google's one for all, an MCP server's one (it has
 * no uses). The new refresh token is kept when the provider rotates it (Microsoft does), and serves
 * every use; a sign-in whose refresh is refused (`invalid_grant`: revoked, expired, its password
 * changed) is marked as needing a new one. `fetch()` sends the token only to the provider's hosts and
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
        /** The registration is paused or incomplete. Its grants and refresh token still belong to this account. */
        unavailable?: string;
        /** Why it needs a new sign-in. */
        error?: string;
        /** What it was signed in for (an account's uses; none for an MCP server's, whose one token is asked for with no use). */
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
  /**
   * Its client was refused (`invalid_client`, `unauthorized_client`: an MCP server's registered client
   * expired or was purged): it needs a new sign-in, which registers again. Without it (accounts, whose
   * app is the user's own), such a refusal is only a failed refresh.
   */
  clientRefused?(id: string, why: string): void;
}

/** Refreshed this long before it expires, so a request never starts with a token about to run out. */
const EARLY_MS = 2 * 60_000;

/** A provider's token endpoint's answer, as it is used (`tokenAnswer()`). */
export interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** What an answer of a token, registration, revocation or device endpoint is read up to. */
export const MAX_ANSWER_BYTES = 256 * 1024;
/** The longest error code, error description and scope list kept from an answer. */
const MAX_ERROR = 100;
const MAX_DESCRIPTION = 300;
const MAX_SCOPE = 4000;
/** The longest token taken: an answer with a longer one is refused (a JWT is a few kilobytes). */
export const MAX_TOKEN = 16 * 1024;

/**
 * A response's body as a JSON object, read up to `max` bytes: undefined when it is not one, is longer,
 * or cannot be read (the connection failed, or its time ran out, meanwhile).
 */
export async function jsonObject(res: Response, max = MAX_ANSWER_BYTES): Promise<Record<string, unknown> | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Text from an answer, on one line and at most `max` characters (none when it is not text). */
export function answerText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const line = v
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max);
  return line || undefined;
}

/**
 * A token endpoint's answer as it is used: its strings only, the error and its description on one line
 * and capped, `expires_in` a number of seconds. A token longer than `MAX_TOKEN` is none, with an error
 * that says so: such an answer is refused, never kept.
 */
export function tokenAnswer(raw: Record<string, unknown> | undefined): TokenAnswer {
  const v = raw ?? {};
  const token = (x: unknown) => (typeof x === 'string' && x ? x : undefined);
  const access = token(v.access_token);
  const refresh = token(v.refresh_token);
  if ((access && access.length > MAX_TOKEN) || (refresh && refresh.length > MAX_TOKEN))
    return { error: 'invalid_response', error_description: t().oauthTokenTooLong(MAX_TOKEN) };
  const expires = typeof v.expires_in === 'string' ? Number(v.expires_in) : v.expires_in;
  const error = answerText(v.error, MAX_ERROR);
  const description = firstLine(v.error_description);
  const scope = answerText(v.scope, MAX_SCOPE);
  return {
    ...(access ? { access_token: access } : {}),
    ...(refresh ? { refresh_token: refresh } : {}),
    ...(typeof expires === 'number' && Number.isFinite(expires) && expires > 0 ? { expires_in: expires } : {}),
    ...(scope ? { scope } : {}),
    ...(error ? { error } : {}),
    ...(description ? { error_description: description } : {}),
  };
}

/** What a request to a provider sends: a form, or JSON (registration), to one address. */
export interface ProviderRequest {
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** A request to a provider's endpoint the usual way: this process's fetch, following no redirect. */
export function plainSend(url: string, r: ProviderRequest): Promise<Response> {
  return fetch(url, {
    method: r.method,
    headers: r.headers,
    ...(r.body !== undefined ? { body: r.body } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(r.timeoutMs),
  });
}

/** A request to a provider's token endpoint: a form, its answer as JSON (an error answer too), read up to `MAX_ANSWER_BYTES`. */
export async function tokenRequest(
  provider: OAuthProvider,
  form: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ status: number; body: TokenAnswer }> {
  // A client secret in a Basic header (`client_secret_basic`), or in the form.
  const basic = provider.clientSecret && provider.clientSecretBasic;
  const res = await (provider.send ?? plainSend)(provider.endpoints.token, {
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
    timeoutMs,
  });
  // Not JSON, or too long: the status says it.
  return { status: res.status, body: tokenAnswer(await jsonObject(res)) };
}

/** A client's id and secret as a Basic header (`client_secret_basic`), each part form-encoded first (RFC 6749, 2.3.1). */
export function basicAuth(clientId: string, secret: string): string {
  const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
  return `Basic ${Buffer.from(`${enc(clientId)}:${enc(secret)}`).toString('base64')}`;
}

/** An error description's first line (Microsoft's go on with a trace id), capped. */
function firstLine(v: unknown): string | undefined {
  return answerText(typeof v === 'string' ? v.split(/\r?\n/)[0] : undefined, MAX_DESCRIPTION);
}

/** What a token (or registration) endpoint's error answer says, in a line, capped. */
export function tokenError(status: number, body: { error?: unknown; error_description?: unknown }): string {
  return [answerText(body.error, MAX_ERROR), firstLine(body.error_description)].filter(Boolean).join(': ') || `HTTP ${status}`;
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

/**
 * An access token the broker keeps, and the uses it serves (a sign-in's, for `TokenBroker.signedIn`):
 * none for a sign-in that has no uses (an MCP server's), whose one token it is.
 */
export interface AccessToken {
  uses: readonly OAuthUse[];
  token: string;
  expiresIn?: number;
}

/** The errors of a refresh that only a new sign-in mends. */
const REFUSED_FOR_GOOD = ['invalid_grant', 'interaction_required', 'consent_required'];
/** The errors of a refresh that refuse the client itself (an MCP server's registered client expired or purged). */
const CLIENT_REFUSED = ['invalid_client', 'unauthorized_client'];

/** How long before it expires a kept token is renewed: a time, or one from its lifetime (both in ms). */
export type EarlyMargin = number | ((lifetimeMs: number) => number);

/** The slot of the one token that serves every use (Google's), or a sign-in with no uses (an MCP server's). */
const EVERY_USE = '*';

export class TokenBroker {
  /**
   * The access tokens kept, by sign-in, then by slot: each use's own for a provider whose tokens are
   * each for one resource (Microsoft: the calendar's on Graph, mail's on Exchange Online), else one for
   * every use (`*`: Google's covers each scope granted; an MCP server's, which has no uses).
   */
  private tokens = new Map<string, Map<string, { token: string; expiresAt: number; lifetimeMs: number }>>();
  private refreshing = new Map<string, Map<string, Promise<string>>>();
  /**
   * Each sign-in's refreshes, one after another: a refresh token one rotates (Microsoft) is the one the
   * next sends, whichever use it is for.
   */
  private queue = new Map<string, Promise<void>>();
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

  /** The access token kept for it now for a use (none: its one token), if any (to revoke, when it has no refresh token). */
  held(accountId: string, use?: OAuthUse): string | undefined {
    return this.tokens.get(accountId)?.get(this.slot(accountId, use))?.token;
  }

  private generation(accountId: string): number {
    return this.generations.get(accountId) ?? 0;
  }

  /**
   * Where a use's token is kept: its own slot when its provider's tokens are each for one resource, else
   * the one for all; no use (a sign-in that has none: an MCP server's), the one.
   */
  private slot(accountId: string, use: OAuthUse | undefined): string {
    if (!use) return EVERY_USE;
    try {
      return this.providerOf(accountId).tokenScopes ? use : EVERY_USE;
    } catch {
      // No app for it now: no refresh either, which says why.
      return use;
    }
  }

  private keep(accountId: string, slot: string, token: string, expiresIn: number | undefined): void {
    let slots = this.tokens.get(accountId);
    if (!slots) this.tokens.set(accountId, (slots = new Map()));
    const lifetimeMs = (expiresIn ?? 3600) * 1000;
    slots.set(slot, { token, expiresAt: this.now() + lifetimeMs, lifetimeMs });
  }

  /**
   * A sign-in just worked: a new generation of it, with the access tokens the sign-in got, each for the
   * uses it serves (so their first requests do not refresh them). A refresh still under way for the
   * sign-in before writes nothing.
   */
  signedIn(accountId: string, tokens: readonly AccessToken[]): void {
    this.forget(accountId);
    // A token for no use is an MCP server's: an account's sign-in token that serves none of its uses is not kept.
    const account = Boolean(this.store.grant(accountId)?.uses.length);
    for (const t of tokens) {
      if (account && !t.uses.length) continue;
      const slots = t.uses.length ? new Set(t.uses.map((u) => this.slot(accountId, u))) : [EVERY_USE];
      for (const slot of slots) this.keep(accountId, slot, t.token, t.expiresIn);
    }
  }

  /**
   * Forget the sign-in's tokens, and the refreshes under way (it was removed, its sign-in replaced, or
   * its app changed): a new generation, so that a refresh writes nothing when it comes back.
   */
  forget(accountId: string): void {
    this.generations.set(accountId, this.generation(accountId) + 1);
    this.tokens.delete(accountId);
    this.refreshing.delete(accountId);
  }

  /**
   * The sign-in's access token for a use (an account's: always one; an MCP server's, which has none:
   * `undefined`): the one kept while it is good for more than a couple of minutes (`early`: another
   * margin, such as a turn's, which may depend on the token's lifetime), else a new one (`fresh`: a new
   * one anyway, the server refused the one kept). One refresh at a time per token: callers meanwhile
   * wait for the same one. Never one for a use the account was not signed in for: not the one kept
   * (Google's serves every use granted), nor a refresh, whose refusal would mark the whole account.
   */
  accessToken(accountId: string, use: OAuthUse | undefined, fresh = false, early: EarlyMargin = EARLY_MS): Promise<string> {
    const grant = this.store.grant(accountId);
    if (grant?.unavailable) return Promise.reject(new OAuthSignInError(grant.unavailable));
    if (grant && use && !grant.uses.includes(use)) return Promise.reject(new OAuthSignInError(t().oauthNotFor(grant.label, use)));
    // An account's tokens are each for its uses: asked with none (a caller's mistake), not one of them,
    // nor a refresh with no scope, whose refusal would mark the whole account.
    if (grant && !use && grant.uses.length) return Promise.reject(new OAuthSignInError(t().oauthNoUse(grant.label)));
    const slot = this.slot(accountId, use);
    const kept = this.tokens.get(accountId)?.get(slot);
    const margin = kept ? (typeof early === 'function' ? early(kept.lifetimeMs) : early) : 0;
    if (!fresh && kept && kept.expiresAt - margin > this.now()) return Promise.resolve(kept.token);
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

  /** Runs `fn` after the sign-in's refreshes before it are over. */
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

  private async refresh(accountId: string, use: OAuthUse | undefined, slot: string): Promise<string> {
    const account = this.store.grant(accountId);
    if (!account) throw new OAuthSignInError(t().oauthAccountGone);
    if (account.status === 'reauth') throw new OAuthSignInError(t().oauthSignInAgain(account.label, account.error ?? '', use));
    // A sign-in that brought no refresh token, its access token run out (or lost when the server restarted).
    if (account.noRefresh) {
      this.tokens.delete(accountId);
      this.store.needsSignIn(accountId, t().oauthTokenRanOut);
      throw new OAuthSignInError(t().oauthSignInAgain(account.label, t().oauthTokenRanOut, use));
    }
    const provider = this.providerOf(accountId);
    const generation = this.generation(accountId);
    // Removed, or signed in again, while the provider was asked: nothing of its answer (or its failure)
    // is written or told; the caller gets the new sign-in's token, or the account being gone.
    const superseded = () => {
      if (!this.store.grant(accountId)) throw new OAuthSignInError(t().oauthAccountGone);
      return this.accessToken(accountId, use);
    };
    let answer: { status: number; body: TokenAnswer } | undefined;
    try {
      answer = await this.oneAtATime(accountId, async () => {
        // Another refresh before it found the sign-in refused, or a new sign-in came: not asked.
        if (this.generation(accountId) !== generation) return undefined;
        const now = this.store.grant(accountId);
        if (now?.unavailable) throw new OAuthSignInError(now.unavailable);
        if (now?.status === 'reauth') throw new OAuthSignInError(t().oauthSignInAgain(now.label, now.error ?? '', use));
        // The refresh token as it is now: one another use's refresh rotated is the one sent.
        const refreshToken = this.store.refreshToken(accountId);
        if (!refreshToken) throw new OAuthSignInError(t().oauthNoToken(account.label, use));
        const a = await tokenRequest(provider, {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          ...(provider.tokenScopes && use ? { scope: provider.tokenScopes(use).join(' ') } : {}),
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
      throw new OAuthSignInError(t().oauthRefreshFailed(account.label, (err as Error).message));
    }
    if (!answer || this.generation(accountId) !== generation) return superseded();
    // An in-flight refresh can rotate the credential. Keep the rotation above, but never release an access token while paused.
    const unavailable = this.store.grant(accountId)?.unavailable;
    if (unavailable) throw new OAuthSignInError(unavailable);
    const { status, body } = answer;
    if (!body.access_token) {
      const why = tokenError(status, body);
      // Refused for good: only a new sign-in mends it. Anything else (the network, the provider down) may pass.
      if (body.error && (REFUSED_FOR_GOOD.includes(body.error) || provider.revokedRefreshErrors?.includes(body.error))) {
        this.tokens.delete(accountId);
        this.store.needsSignIn(accountId, why);
        throw new OAuthSignInError(t().oauthSignInAgain(account.label, why, use));
      }
      // Its client refused: a new sign-in, with a client registered again (an MCP server's).
      if (body.error && CLIENT_REFUSED.includes(body.error) && this.store.clientRefused) {
        this.tokens.delete(accountId);
        this.store.clientRefused(accountId, why);
        throw new OAuthSignInError(t().oauthSignInAgain(account.label, why, use));
      }
      throw new OAuthSignInError(t().oauthRefreshFailed(account.label, why));
    }
    this.keep(accountId, slot, body.access_token, body.expires_in);
    return body.access_token;
  }

  /**
   * A fetch with the account's token for a use, only to its provider's hosts, following no redirect. A
   * token the provider refuses (401) is normally refreshed once. Mutations that cannot be replayed opt out.
   */
  fetch(accountId: string, use: OAuthUse, { retryUnauthorized = true } = {}): AuthorizedFetch {
    return async (url, init) => {
      const provider = this.providerOf(accountId);
      let fresh = false;
      let presented = '';
      const generation = this.generation(accountId);
      const send = hostOnlyFetch(provider.useHosts?.[use] ?? provider.hosts, async () => {
        presented = await this.accessToken(accountId, use, fresh);
        return presented;
      });
      const res = await send(url, init);
      if (res.status !== 401) return res;
      if (!retryUnauthorized) {
        // A later, independently approved request can refresh. Keep a newer concurrent token intact.
        const slot = this.slot(accountId, use);
        const slots = this.tokens.get(accountId);
        if (generation === this.generation(accountId) && slots?.get(slot)?.token === presented) slots.delete(slot);
        return res;
      }
      await res.body?.cancel().catch(() => undefined);
      fresh = true;
      return send(url, init);
    };
  }
}
