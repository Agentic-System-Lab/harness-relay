import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  OAUTH_LIMITS,
  OAUTH_USES,
  type OAuthAccountView,
  type OAuthProviderId,
  type OAuthSignInView,
  type OAuthUse,
} from '../../shared/types';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { answerText, hostOnlyFetch, jsonObject, plainSend, tokenError, tokenRequest, type AccessToken, type TokenAnswer } from './broker';
import { missingUse, type OAuthProvider } from './providers';

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
 * What was granted is checked for each use of the sign-in, when the provider's answer says: a sign-in
 * without its use's own scopes would look connected, and fail at its first request. Where a token is
 * for one resource (Microsoft), the code exchange asks for Graph's (who signed in, the calendar), and
 * each use on another resource (mail, on Exchange Online) gets its own token at once, with the refresh
 * token, its scopes checked in its own answer; so does each use the account had before that this
 * sign-in did not name (`SignedIn.tokenFor()`, which the service asks once it knows who signed in).
 *
 * A sign-in is an account's (Microsoft, Google: `service.ts`) or a tool library MCP server's own
 * (`mcp.ts`), whose provider is a description built from what the server publishes; each brings what
 * keeps the sign-in once it worked (`keep`), and every check here holds for both alike. An MCP server's
 * also guards against a mix-up (one client, many authorization servers: a hostile server's metadata
 * naming another's sign-in page, to have its code sent to its own token endpoint): the `iss` its redirect
 * brings back must be its issuer (RFC 9207), and a sign-in page or token endpoint that is not on the
 * issuer's own origin is shown to the user first (`confirm`), its page given only once they confirm.
 */

/** A sign-in that worked, for what started it to keep: the tokens and the scopes granted. */
export interface SignedIn {
  /**
   * The refresh token: the newest, when asking for another use's token rotated it. None only for a
   * provider that allows it (`refreshOptional`).
   */
  refreshToken?: string;
  /** The access tokens it got, each with the uses it serves: the sign-in's own first, which asks who signed in. */
  access: AccessToken[];
  /** The scopes granted (those asked for, when the answers did not say). */
  scopes: string[];
  /**
   * For a provider whose tokens are each for one resource (Microsoft): a use's own token, with the
   * refresh token as it is now, its access checked in its answer (a use refused fails the sign-in),
   * added to `access`, `scopes` and `refreshToken`. Nothing for a provider whose one token serves every use.
   */
  tokenFor: (use: OAuthUse) => Promise<void>;
  /** What the sign-in's own token was granted, as its answer said (`scope`); undefined when it did not say. */
  granted?: string;
  hosts: string[];
  /** Whether it is still wanted: not cancelled, nor its app changed, while who signed in is asked. */
  live: () => boolean;
}

/** Keeps a sign-in that worked (the account it signed in, or an MCP server's tokens), and answers the account, if any. */
export type KeepSignIn = (s: SignedIn) => Promise<OAuthAccountView | undefined>;

/** Why a sign-in fails that was not given a use's access. */
export function noAccess(provider: string, use: OAuthUse): string {
  return use === 'mail' ? t().oauthNoMailAccess(provider) : t().oauthNoCalendarAccess(provider);
}

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
  /** Its page or token endpoint is not on its issuer's origin, and the user has not confirmed it yet: its page is not given. */
  unconfirmed?: NonNullable<OAuthSignInView['confirm']>;
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

/** What came back to the redirect address: the code and state, or the provider's error, and its issuer (RFC 9207). */
export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  iss?: string;
}

/** The provider's error as one line: its code and description, capped. */
export function callbackError(error: string | null | undefined, description?: string | null): string | undefined {
  const code = answerText(error, 100);
  return code ? [code, answerText(description, 300)].filter(Boolean).join(': ') : undefined;
}

/** The code and state (or the provider's error), and the issuer, in the address its page sent the browser to. */
export function callbackParams(address: string): CallbackParams {
  let u: URL;
  try {
    u = new URL(address.trim());
  } catch {
    throw new HttpError(400, t().oauthBadAddress);
  }
  const q = u.searchParams;
  const error = callbackError(q.get('error'), q.get('error_description'));
  return {
    ...(q.get('code') ? { code: q.get('code')! } : {}),
    ...(q.get('state') ? { state: q.get('state')! } : {}),
    ...(error ? { error } : {}),
    ...(q.get('iss') !== null ? { iss: q.get('iss')! } : {}),
  };
}

export class SignIns {
  private pending = new Map<string, Pending>();
  /** Sign-ins being prepared (an MCP server's discovery and registration): they count as waiting (`reserve()`). */
  private preparing = 0;

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

  /** Refuses another sign-in while too many wait or are being prepared (429): checked again as one starts. */
  assertRoom(): void {
    this.sweep();
    if ([...this.pending.values()].filter((p) => p.status === 'waiting').length + this.preparing >= OAUTH_LIMITS.pending)
      throw new HttpError(429, t().oauthTooMany);
  }

  /**
   * Holds a place for a sign-in being prepared (an MCP server's discovery and registration, which take
   * a while), refused as `assertRoom()` refuses; the function it answers gives the place back, once,
   * before the sign-in starts.
   */
  reserve(): () => void {
    this.assertRoom();
    this.preparing++;
    let held = true;
    return () => {
      if (held) this.preparing--;
      held = false;
    };
  }

  /**
   * Start a sign-in: the provider's page to open, with a redirect to `origin`'s own web app when the
   * page is on this computer (else to this computer's port on localhost: the address it then shows is
   * pasted back, `redirectAddress()`), or, with `device`, a code to type at the provider's address.
   * `keep` keeps it once it worked; `server`, for an MCP server's own sign-in, names it; `confirm`: its
   * page (or token endpoint) is not on its issuer's origin, so the page is given only once the user
   * confirms (`confirm()`).
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
    confirm?: NonNullable<OAuthSignInView['confirm']>;
    /** The address of the account signing in again (or for another use): its provider's page starts with it. */
    loginHint?: string;
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
      const res = await (provider.send ?? plainSend)(provider.endpoints.device, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: provider.clientId, ...(scopes.length ? { scope: scopes.join(' ') } : {}) }).toString(),
        timeoutMs: 30_000,
      });
      const raw = (await jsonObject(res)) ?? {};
      const text = (v: unknown, max: number) => (typeof v === 'string' && v && v.length <= max ? v : undefined);
      const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
      const body = {
        device_code: text(raw.device_code, 4096),
        user_code: text(raw.user_code, 100),
        verification_uri: text(raw.verification_uri, 2000),
        expires_in: number(raw.expires_in),
        interval: number(raw.interval),
      };
      if (!body.device_code || !body.user_code || !body.verification_uri)
        throw new HttpError(502, t().oauthStartFailed(provider.label, tokenError(res.status, raw)));
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
      ...(o.loginHint ? { login_hint: o.loginHint } : {}),
    }))
      url.searchParams.set(k, v);
    const p: Pending = {
      ...base,
      stateHash: sha256(state),
      verifier,
      redirectUri,
      authorizeUrl: url.href,
      ...(o.confirm ? { unconfirmed: o.confirm } : {}),
    };
    this.pending.set(id, p);
    return this.view(p);
  }

  /**
   * The user confirmed a sign-in whose page (or token endpoint) is not on its issuer's origin, having
   * been shown where: it is recorded, and its page given. For the browser session that started it only.
   */
  confirm(id: string, session?: string): OAuthSignInView {
    this.sweep();
    const p = this.own(id, session);
    if (p.status === 'waiting') delete p.unconfirmed;
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
      // Not confirmed yet: where its page is, and not the page itself.
      ...(p.unconfirmed && p.status === 'waiting' ? { confirm: { ...p.unconfirmed } } : {}),
      ...(p.authorizeUrl && p.status === 'waiting' && !p.unconfirmed ? { authorizeUrl: p.authorizeUrl } : {}),
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
  async callback(o: CallbackParams): Promise<OAuthSignInView> {
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

  private async finish(p: Pending, o: CallbackParams): Promise<OAuthSignInView> {
    const scopes = p.provider.scopes(p.uses);
    const own = p.provider.signInToken?.(p.uses);
    try {
      // Its page was never given (it waits for the user to confirm where it is): whatever came back is not taken.
      if (p.unconfirmed) throw new Error(t().oauthNotConfirmed(p.provider.label));
      // RFC 9207: the issuer that answered must be the one this sign-in started at, and say so when it says it will.
      const issuer = p.provider.issuer;
      if (issuer && o.iss !== undefined && o.iss !== issuer)
        throw new Error(t().oauthOtherIssuer(p.provider.label, answerText(o.iss, 200) ?? ''));
      if (issuer && o.iss === undefined && p.provider.issParameter) throw new Error(t().oauthNoIssuer(p.provider.label));
      if (o.error || !o.code) throw new Error(t().oauthRefused(p.provider.label, answerText(o.error, 400) ?? t().oauthNoCode));
      const { status, body } = await tokenRequest(p.provider, {
        grant_type: 'authorization_code',
        code: o.code,
        redirect_uri: p.redirectUri!,
        code_verifier: p.verifier!,
        // A token for one resource (Microsoft's Graph, to ask who signed in), named rather than left to the first one asked.
        ...(own ? { scope: own.scopes.join(' ') } : {}),
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
    const { provider } = p;
    if (!body.access_token) throw new Error(t().oauthRefused(provider.label, tokenError(status, body)));
    // The uses the sign-in's own token serves: on its resource (Microsoft's Graph), or every one (Google's).
    const own = provider.signInToken?.(p.uses);
    const ownUses = own ? own.uses : p.uses;
    // What was granted, when the answer says (Google lets the user untick Calendar or Gmail on its page).
    if (typeof body.scope === 'string') {
      const missing = missingUse(provider, ownUses, body.scope, own?.scopes);
      if (missing) throw new Error(noAccess(provider.label, missing));
    }
    // No refresh token: the account could be used for an hour only (Google gives one only with access_type=offline).
    // An MCP server's authorization server may give none: its sign-in then lasts as long as its access token.
    if (!body.refresh_token && !provider.refreshOptional) throw new Error(t().oauthNoRefresh(provider.label));
    const s: SignedIn = {
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      // Every use, for a token that serves each one granted (Google's); none for a sign-in that has no uses (an MCP server's).
      access: [
        {
          uses: own ? own.uses : p.uses.length ? OAUTH_USES : [],
          token: body.access_token,
          ...(body.expires_in ? { expiresIn: body.expires_in } : {}),
        },
      ],
      scopes: [...new Set(body.scope ? body.scope.split(/\s+/).filter(Boolean) : scopes)],
      ...(typeof body.scope === 'string' ? { granted: body.scope } : {}),
      hosts: provider.hosts,
      live: () => this.live(p),
      tokenFor: async (use) => {
        if (!provider.tokenScopes) return;
        if (!this.live(p)) throw new Error(t().oauthSignInCancelled);
        if (!s.refreshToken) throw new Error(t().oauthNoRefresh(provider.label));
        const r = await tokenRequest(provider, {
          grant_type: 'refresh_token',
          refresh_token: s.refreshToken,
          scope: provider.tokenScopes(use).join(' '),
        });
        if (!r.body.access_token) {
          // Refused that resource's scopes: the sign-in did not give the use's access.
          if (
            r.body.error === 'invalid_grant' ||
            r.body.error === 'consent_required' ||
            r.body.error === 'interaction_required' ||
            r.body.error === 'invalid_scope'
          )
            throw new Error(`${noAccess(provider.label, use)} (${tokenError(r.status, r.body)})`);
          throw new Error(t().oauthRefused(provider.label, tokenError(r.status, r.body)));
        }
        if (typeof r.body.scope === 'string' && missingUse(provider, [use], r.body.scope)) throw new Error(noAccess(provider.label, use));
        if (r.body.refresh_token) s.refreshToken = r.body.refresh_token;
        for (const scope of r.body.scope ? r.body.scope.split(/\s+/).filter(Boolean) : provider.tokenScopes(use))
          if (!s.scopes.includes(scope)) s.scopes.push(scope);
        s.access.push({ uses: [use], token: r.body.access_token, ...(r.body.expires_in ? { expiresIn: r.body.expires_in } : {}) });
      },
    };
    // Each use on another resource (Microsoft's mail): its own token now, its access checked in its answer.
    for (const use of p.uses) if (!ownUses.includes(use)) await s.tokenFor(use);
    const account = await p.keep(s);
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

/** A fetch with the token a sign-in just got: to its provider's hosts only, to ask who signed in. */
export function signInFetch(s: SignedIn) {
  return hostOnlyFetch(s.hosts, async () => s.access[0]!.token);
}
