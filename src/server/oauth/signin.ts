import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { OAUTH_LIMITS, type OAuthAccountView, type OAuthProviderId, type OAuthSignInView, type OAuthUse } from '../../shared/types';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { hostOnlyFetch, tokenError, tokenRequest, type TokenAnswer } from './broker';
import type { OAuthProvider } from './providers';

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
 */

/** A sign-in that worked, for the service to keep: who signed in and the tokens. */
export interface SignedIn {
  provider: OAuthProviderId;
  uses: OAuthUse[];
  tokens: TokenAnswer & { access_token: string; refresh_token: string };
  scopes: string[];
  whoami: OAuthProvider['whoami'];
  hosts: string[];
}

interface Pending {
  id: string;
  provider: OAuthProvider;
  uses: OAuthUse[];
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
    /** Keeps the account a sign-in signed in (the store, the calendar it adds), and answers it. */
    private keep: (s: SignedIn) => Promise<OAuthAccountView>,
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

  /**
   * Start a sign-in: the provider's page to open, with a redirect to `origin`'s own web app when the
   * page is on this computer (else to this computer's port on localhost: the address it then shows is
   * pasted back), or, with `device`, a code to type at the provider's address.
   */
  async start(o: {
    provider: OAuthProvider;
    uses: OAuthUse[];
    session?: string;
    origin?: string;
    port: number;
    device?: boolean;
  }): Promise<OAuthSignInView> {
    this.sweep();
    if ([...this.pending.values()].filter((p) => p.status === 'waiting').length >= OAUTH_LIMITS.pending)
      throw new HttpError(429, t().oauthTooMany);
    const { provider, uses } = o;
    const scopes = provider.scopes(uses);
    const id = randomUUID();
    const expiresAt = this.now() + OAUTH_LIMITS.signInMinutes * 60_000;
    const base = { id, provider, uses, ...(o.session ? { session: o.session } : {}), expiresAt, status: 'waiting' as const };
    if (o.device) {
      if (!provider.flows.includes('device') || !provider.endpoints.device) throw new HttpError(400, t().oauthNoDevice(provider.label));
      const res = await fetch(provider.endpoints.device, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: provider.clientId, scope: scopes.join(' ') }).toString(),
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
        device: { code: body.device_code, userCode: body.user_code, verificationUri: body.verification_uri, interval: body.interval ?? 5 },
      };
      this.pending.set(id, p);
      void this.poll(p, scopes);
      return this.view(p);
    }
    const state = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(48));
    const redirectUri = `${loopbackOrigin(o.origin) ?? `http://localhost:${o.port}`}/oauth/callback`;
    const url = new URL(provider.endpoints.authorize);
    for (const [k, v] of Object.entries({
      client_id: provider.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
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

  private own(id: string, session?: string): Pending {
    const p = this.pending.get(id);
    if (!p || p.session !== session) throw new HttpError(404, t().oauthSignInNotFound);
    return p;
  }

  private view(p: Pending): OAuthSignInView {
    return {
      id: p.id,
      provider: p.provider.id,
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
      await this.signedIn(p, status, body, scopes);
    } catch (err) {
      this.failed(p, err);
    }
    return this.view(p);
  }

  /** Asks the provider whether the device code was typed, as often as it says, until it is or the code expires. */
  private async poll(p: Pending, scopes: string[]): Promise<void> {
    let wait = p.device!.interval;
    for (;;) {
      await new Promise((r) => setTimeout(r, this.pollMs(wait)).unref());
      if (this.pending.get(p.id) !== p || p.status !== 'waiting') return;
      if (this.now() >= p.expiresAt) return this.failed(p, new Error(t().oauthExpired));
      try {
        const { status, body } = await tokenRequest(p.provider, {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: p.device!.code,
        });
        if (body.error === 'authorization_pending') continue;
        if (body.error === 'slow_down') {
          wait += 5;
          continue;
        }
        await this.signedIn(p, status, body, scopes);
        return;
      } catch (err) {
        return this.failed(p, err);
      }
    }
  }

  private async signedIn(p: Pending, status: number, body: TokenAnswer, scopes: string[]): Promise<void> {
    if (!body.access_token) throw new Error(t().oauthRefused(p.provider.label, tokenError(status, body)));
    // No refresh token: the account could be used for an hour only (Google gives one only with access_type=offline).
    if (!body.refresh_token) throw new Error(t().oauthNoRefresh(p.provider.label));
    const tokens = body as SignedIn['tokens'];
    p.account = await this.keep({
      provider: p.provider.id,
      uses: p.uses,
      tokens,
      scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : scopes,
      whoami: p.provider.whoami,
      hosts: p.provider.hosts,
    });
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
