import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { OAUTH_LIMITS, type OAuthAccountView, type OAuthProviderId, type OAuthSignInView, type OAuthUse } from '../../shared/types';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { hostOnlyFetch, tokenError, tokenRequest, type TokenAnswer } from './broker';
import { missingScopes, useScopes, type OAuthProvider } from './providers';

/*
 * Signing an account in with OAuth. The server runs the sign-in; the page only starts it and shows how
 * it went.
 *
 * - The main flow is an authorization code with PKCE (S256) and a redirect to this server's own web
 *   app on this computer (`/oauth/callback`, RFC 8252: Microsoft and Google take any loopback port for
 *   a desktop app). The page there posts the code and `state` back (`POST /api/oauth/callback`): the
 *   state is its proof, as a webhook's token is, since the redirect is a navigation from the provider's
 *   page that carries no key (and, cross-site, no Strict cookie), and in the desktop app it opens in the
 *   system browser, which was never signed in. The state is random, works once, and expires within
 *   minutes; the code is worth nothing without the verifier, which never leaves the server.
 * - A browser on another computer (a codespace, Tailscale) never reaches this computer's loopback: the
 *   user pastes the address the provider's page sent it to, from the page that started the sign-in
 *   (that same signed-in browser only).
 * - Where the provider allows it for the scopes (Microsoft), the device code flow: a code typed at the
 *   provider's address on any device, while the server asks the provider until it is done.
 *
 * A sign-in is an account's (Microsoft, Google: `service.ts`) or a tool library MCP server's own
 * (`mcp.ts`), whose provider is a description built from what the server publishes; each brings what
 * keeps the sign-in once it worked (`keep`), and every check here holds for both alike.
 */

/** A sign-in that worked, for what started it to keep: the tokens and the scopes granted. */
export interface SignedIn {
  /** No refresh token only for a provider that allows it (`refreshOptional`). */
  tokens: TokenAnswer & { access_token: string; refresh_token?: string };
  scopes: string[];
  hosts: string[];
  /** Whether it is still wanted: not cancelled, nor its app changed, while who signed in is asked. */
  live: () => boolean;
}

/** Keeps a sign-in that worked (the account it signed in, or an MCP server's tokens), and answers the account, if any. */
export type KeepSignIn = (s: SignedIn) => Promise<OAuthAccountView | undefined>;

interface Pending {
  id: string;
  provider: OAuthProvider;
  uses: OAuthUse[];
  keep: KeepSignIn;
  /** A tool library MCP server's own sign-in: the server, by its id and name. */
  server?: { id: string; name: string };
  /** The signed-in browser's session that started it (none when signing in is off: tests). */
  session?: string;
  /** The SHA-256 of its state (the state itself only goes to the provider and back). */
  stateHash?: Buffer;
  verifier?: string;
  redirectUri?: string;
  authorizeUrl?: string;
  device?: { code: string; userCode: string; verificationUri: string; interval: number };
  expiresAt: number;
  status: OAuthSignInView['status'];
  account?: OAuthAccountView;
  error?: string;
  /** Finishing now (the code is being exchanged): a second post of the same address waits for it. */
  finishing?: Promise<OAuthSignInView>;
}

const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** How long a sign-in that ended stays for the page that started it to see how it went. */
const KEPT_MS = 5 * 60_000;

/**
 * The redirect address of a sign-in started from a page at `origin`: that page's own web app when it is
 * on this computer, else this computer's port on localhost (the address it then shows is pasted back).
 */
export function redirectAddress(origin: string | undefined, port: number): string {
  return `${loopbackOrigin(origin) ?? `http://localhost:${port}`}/oauth/callback`;
}

/** Whether an origin is this computer's own (`http://localhost:5173`, `http://127.0.0.1:8787`): its page can be a redirect address. */
export function loopbackOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' || !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) || !u.port) return undefined;
    return `http://${u.host}`;
  } catch {
    return undefined;
  }
}

/** The code and state (or the provider's error) in the address its page sent the browser to. */
export function callbackParams(address: string): { code?: string; state?: string; error?: string } {
  let u: URL;
  try {
    u = new URL(address.trim());
  } catch {
    throw new HttpError(400, t().oauthBadAddress);
  }
  const q = u.searchParams;
  const error = q.get('error');
  return {
    ...(q.get('code') ? { code: q.get('code')! } : {}),
    ...(q.get('state') ? { state: q.get('state')! } : {}),
    ...(error ? { error: [error, q.get('error_description')].filter(Boolean).join(': ') } : {}),
  };
}

export class SignIns {
  private pending = new Map<string, Pending>();

  constructor(
    private now: () => number = Date.now,
    /** How long to wait between two asks of a device code sign-in (the provider's interval; shorter in tests). */
    private pollMs: (interval: number) => number = (interval) => interval * 1000,
  ) {}

  /** Drops the sign-ins whose time is over (one still waiting fails), and those ended a while ago. */
  private sweep(): void {
    const now = this.now();
    for (const [id, p] of this.pending) {
      if (p.status === 'waiting' && p.expiresAt <= now) {
        p.status = 'failed';
        p.error = t().oauthExpired;
        p.expiresAt = now + KEPT_MS;
      } else if (p.status !== 'waiting' && p.expiresAt <= now) this.pending.delete(id);
    }
  }

  /** Refuses another sign-in while too many wait (429): checked again as one starts, and before an MCP server's registration. */
  assertRoom(): void {
    this.sweep();
    if ([...this.pending.values()].filter((p) => p.status === 'waiting').length >= OAUTH_LIMITS.pending)
      throw new HttpError(429, t().oauthTooMany);
  }

  /**
   * Start a sign-in: the provider's page to open, with a redirect to `origin`'s own web app when the
   * page is on this computer (else to this computer's port on localhost: the address it then shows is
   * pasted back, `redirectAddress()`), or, with `device`, a code to type at the provider's address.
   * `keep` keeps it once it worked; `server`, for an MCP server's own sign-in, names it.
   */
  async start(o: {
    provider: OAuthProvider;
    uses: OAuthUse[];
    keep: KeepSignIn;
    server?: { id: string; name: string };
    session?: string;
    origin?: string;
    port: number;
    device?: boolean;
  }): Promise<OAuthSignInView> {
    this.assertRoom();
    const { provider, uses } = o;
    const scopes = provider.scopes(uses);
    const id = randomUUID();
    const expiresAt = this.now() + OAUTH_LIMITS.signInMinutes * 60_000;
    const base = {
      id,
      provider,
      uses,
      keep: o.keep,
      ...(o.server ? { server: o.server } : {}),
      ...(o.session ? { session: o.session } : {}),
      expiresAt,
      status: 'waiting' as const,
    };
    if (o.device) {
      if (!provider.flows.includes('device') || !provider.endpoints.device) throw new HttpError(400, t().oauthNoDevice(provider.label));
      const res = await fetch(provider.endpoints.device, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: provider.clientId, ...(scopes.length ? { scope: scopes.join(' ') } : {}) }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        expires_in?: number;
        interval?: number;
        error?: string;
        error_description?: string;
      };
      if (!body.device_code || !body.user_code || !body.verification_uri)
        throw new HttpError(502, t().oauthStartFailed(provider.label, tokenError(res.status, body)));
      const p: Pending = {
        ...base,
        expiresAt: Math.min(expiresAt, this.now() + (body.expires_in ?? 900) * 1000),
        // At least a second between two asks, whatever the provider says.
        device: {
          code: body.device_code,
          userCode: body.user_code,
          verificationUri: body.verification_uri,
          interval: Math.max(1, body.interval ?? 5),
        },
      };
      this.pending.set(id, p);
      void this.poll(p, scopes);
      return this.view(p);
    }
    const state = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(48));
    const redirectUri = redirectAddress(o.origin, o.port);
    const url = new URL(provider.endpoints.authorize);
    for (const [k, v] of Object.entries({
      client_id: provider.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      // None asked (an MCP server whose metadata lists none): left out, not sent empty.
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
      state,
      code_challenge: b64url(sha256(verifier)),
      code_challenge_method: 'S256',
      ...provider.extraParams,
    }))
      url.searchParams.set(k, v);
    const p: Pending = { ...base, stateHash: sha256(state), verifier, redirectUri, authorizeUrl: url.href };
    this.pending.set(id, p);
    return this.view(p);
  }

  /** How a sign-in goes, for the browser session that started it. */
  get(id: string, session?: string): OAuthSignInView {
    this.sweep();
    return this.view(this.own(id, session));
  }

  /** Stop waiting for it. */
  cancel(id: string, session?: string): void {
    this.own(id, session);
    this.pending.delete(id);
  }

  /**
   * Ends the provider's sign-ins still waiting: its app changed, and they would finish with the one
   * before. The pages following them then find them gone; one whose code is being exchanged keeps nothing.
   */
  cancelProvider(provider: OAuthProviderId): void {
    for (const [id, p] of this.pending) if (p.provider.id === provider && p.status === 'waiting') this.pending.delete(id);
  }

  /** Ends an MCP server's sign-ins still waiting: it was removed, its address changed, or it signed out. */
  cancelServer(serverId: string): void {
    for (const [id, p] of this.pending) if (p.server?.id === serverId && p.status === 'waiting') this.pending.delete(id);
  }

  /** Whether a sign-in is still wanted: still here (not cancelled, nor its app changed), and waiting. */
  private live(p: Pending): boolean {
    return this.pending.get(p.id) === p && p.status === 'waiting';
  }

  private own(id: string, session?: string): Pending {
    const p = this.pending.get(id);
    if (!p || p.session !== session) throw new HttpError(404, t().oauthSignInNotFound);
    return p;
  }

  private view(p: Pending): OAuthSignInView {
    return {
      id: p.id,
      provider: p.provider.id,
      ...(p.server ? { server: { ...p.server } } : {}),
      status: p.status,
      expiresAt: p.expiresAt,
      ...(p.authorizeUrl && p.status === 'waiting' ? { authorizeUrl: p.authorizeUrl } : {}),
      ...(p.redirectUri ? { redirectUri: p.redirectUri } : {}),
      ...(p.device && p.status === 'waiting' ? { device: { userCode: p.device.userCode, verificationUri: p.device.verificationUri } } : {}),
      ...(p.account ? { account: p.account } : {}),
      ...(p.error ? { error: p.error } : {}),
    };
  }

  /** The sign-in whose state this is (compared by hash, in constant time). */
  private byState(state: string): Pending | undefined {
    const h = sha256(state);
    for (const p of this.pending.values()) if (p.stateHash && timingSafeEqual(p.stateHash, h)) return p;
    return undefined;
  }

  /** Whether a sign-in here gave this state: the callback's limit on misses never refuses one. */
  knows(state: string | undefined): boolean {
    return Boolean(state && this.byState(state));
  }

  /**
   * The provider's page sent the browser back (`/oauth/callback` posted what it got): the code is
   * exchanged, with the verifier, and the account kept. The state is the proof; it works for one
   * sign-in only, and once: the same address posted again answers how that sign-in went.
   */
  async callback(o: { state?: string; code?: string; error?: string }): Promise<OAuthSignInView> {
    this.sweep();
    const p = o.state ? this.byState(o.state) : undefined;
    if (!p) throw new HttpError(404, t().oauthSignInNotFound);
    if (p.finishing) return p.finishing;
    if (p.status !== 'waiting') return this.view(p);
    p.finishing = this.finish(p, o).finally(() => (p.finishing = undefined));
    return p.finishing;
  }

  /** The address the provider's page sent the browser to, pasted in the page that started the sign-in. */
  async pasted(id: string, address: string, session?: string): Promise<OAuthSignInView> {
    const p = this.own(id, session);
    const got = callbackParams(address);
    // Its own sign-in's address only: another's state is not this one's.
    if (!got.state || this.byState(got.state) !== p) throw new HttpError(400, t().oauthWrongAddress);
    return this.callback(got);
  }

  private async finish(p: Pending, o: { code?: string; error?: string }): Promise<OAuthSignInView> {
    const scopes = p.provider.scopes(p.uses);
    try {
      if (o.error || !o.code) throw new Error(t().oauthRefused(p.provider.label, o.error ?? t().oauthNoCode));
      const { status, body } = await tokenRequest(p.provider, {
        grant_type: 'authorization_code',
        code: o.code,
        redirect_uri: p.redirectUri!,
        code_verifier: p.verifier!,
      });
      // Cancelled, or its app changed, while the code was exchanged: nothing it brought is kept.
      if (!this.live(p)) throw new Error(t().oauthSignInCancelled);
      await this.signedIn(p, status, body, scopes);
    } catch (err) {
      this.failed(p, err);
    }
    return this.view(p);
  }

  /**
   * Asks the provider whether the device code was typed, as often as it says, until it is or the code
   * expires. The network failing, or the provider answering with a server error, is asked again at the
   * next interval; the code refused (denied, expired) ends it.
   */
  private async poll(p: Pending, scopes: string[]): Promise<void> {
    let wait = p.device!.interval;
    const live = () => this.live(p);
    for (;;) {
      await new Promise((r) => setTimeout(r, this.pollMs(wait)).unref());
      if (!live()) return;
      if (this.now() >= p.expiresAt) return this.failed(p, new Error(t().oauthExpired));
      let answer: { status: number; body: TokenAnswer };
      try {
        answer = await tokenRequest(p.provider, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: p.device!.code,
        });
      } catch {
        continue;
      }
      // Cancelled while the provider was asked: nothing it answered is kept.
      if (!live()) return;
      const { status, body } = answer;
      if (body.error === 'authorization_pending' || (!body.access_token && status >= 500)) continue;
      // Asked to slow down, or throttled (429) without saying so: more slowly from now on.
      if (body.error === 'slow_down' || (status === 429 && !body.access_token)) {
        wait += 5;
        continue;
      }
      try {
        await this.signedIn(p, status, body, scopes);
      } catch (err) {
        this.failed(p, err);
      }
      return;
    }
  }

  private async signedIn(p: Pending, status: number, body: TokenAnswer, scopes: string[]): Promise<void> {
    if (!body.access_token) throw new Error(t().oauthRefused(p.provider.label, tokenError(status, body)));
    // What was granted, when the answer says (Google lets the user untick Calendar on its page): a sign-in
    // without its use's own scopes would look connected, and fail at its first request.
    if (typeof body.scope === 'string' && missingScopes(useScopes(p.provider, p.uses), body.scope).length)
      throw new Error(t().oauthNoCalendarAccess(p.provider.label));
    // No refresh token: the account could be used for an hour only (Google gives one only with access_type=offline).
    // An MCP server's authorization server may give none: its sign-in then lasts as long as its access token.
    if (!body.refresh_token && !p.provider.refreshOptional) throw new Error(t().oauthNoRefresh(p.provider.label));
    const tokens = body as SignedIn['tokens'];
    const account = await p.keep({
      tokens,
      scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : scopes,
      hosts: p.provider.hosts,
      live: () => this.live(p),
    });
    if (account) p.account = account;
    p.status = 'done';
    p.expiresAt = this.now() + KEPT_MS;
    delete p.verifier;
  }

  private failed(p: Pending, err: unknown): void {
    p.status = 'failed';
    p.error = (err as Error).message || String(err);
    p.expiresAt = this.now() + KEPT_MS;
    delete p.verifier;
  }
}

/** A fetch with a token a sign-in just got: to its provider's hosts only, to ask who signed in. */
export function signInFetch(s: SignedIn) {
  return hostOnlyFetch(s.hosts, async () => s.tokens.access_token);
}
