import type { OAuthSignInView } from '../../shared/types';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { AgentTools, DroppedMcpOAuth, StoredMcpOAuth, ToolLibrary } from '../tools';
import { basicAuth, tokenError, TokenBroker, type TokenAnswer, type TokenGrants } from './broker';
import { tokenHost, type OAuthProvider } from './providers';
import { redirectAddress, type SignedIn, type SignIns } from './signin';

/*
 * A tool library HTTP MCP server's own sign-in: MCP's authorization (the 2025-06-18 spec), OAuth 2.1
 * with what the server and its authorization server publish, so the provider is discovered for each
 * server instead of being built in (`providers.ts` has the built-in ones). It shares the sign-ins
 * (`signin.ts`: the callback page, the pasted address, the state, PKCE) and the token broker
 * (`broker.ts`) with the accounts that sign in.
 *
 * - Discovery: the server answers 401 with `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728),
 *   or else its protected resource metadata is at `/.well-known/oauth-protected-resource` (with the
 *   server's path, then without); that names its authorization servers, whose metadata is at
 *   `/.well-known/oauth-authorization-server` (RFC 8414, the well-known part before an issuer's path) or
 *   OpenID's `/.well-known/openid-configuration`. No PKCE with S256, or no dynamic client registration:
 *   no sign-in (a client registered by hand is not taken yet).
 * - Registration (RFC 7591): a public client (`token_endpoint_auth_method: none`) named Harness Relay,
 *   with the exact redirect addresses its sign-ins use; again when a sign-in needs one it lacks.
 * - Every authorization and token request names the resource (RFC 8707), and asks for the scopes the
 *   server's challenge or metadata lists, or none.
 * - At each turn, an agent given the server gets an access token with a while left in its
 *   `Authorization` header (`forTurn()`), as the library's headers reach its CLI; only to the server's own
 *   host, over https (plain http to this computer only). A server whose sign-in needs renewing is left
 *   out of the turn, with a note the agents and the user see.
 */

/** Discovery's requests: each this long at most, and what they read this large at most. */
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 256 * 1024;
/** A token with less than this left is renewed before a turn gets it: a turn may take a while. */
const TURN_EARLY_MS = 10 * 60_000;
/** The redirect addresses one registration lists at most (the pages a sign-in started from). */
const MAX_REDIRECTS = 5;
/** The MCP version discovery's probe speaks. */
const MCP_VERSION = '2025-06-18';
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

/** The code of the 409 a server that asks for no sign-in answers (`POST /api/tools/mcp/:name/signin`). */
export const MCP_NO_SIGN_IN = 'mcp-no-sign-in';

/** What discovery found: where the server signs in, and what its tokens are for. */
export interface McpAuthDiscovery {
  /** The resource its tokens are for (RFC 8707): as its protected resource metadata names it, else the server's canonical URL. */
  resource: string;
  scopes: string[];
  issuer: string;
  authorize: string;
  token: string;
  revoke?: string;
  registration: string;
}

/** A client registered at an authorization server, with the redirect addresses it was registered with. */
export interface McpClient {
  clientId: string;
  clientSecret?: string;
  secretBasic?: boolean;
  redirectUris: string[];
}

/**
 * An MCP server's canonical URL (MCP's authorization spec, RFC 8707): its scheme and host in lower case,
 * no default port, no fragment, and no slash at the end of its path.
 */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/** Whether two URLs name the same MCP server. */
function sameServer(a: string, b: string): boolean {
  try {
    return canonicalResource(a) === canonicalResource(b);
  } catch {
    return a === b;
  }
}

/** What a 401's `WWW-Authenticate` says: a Bearer challenge, where its resource metadata is, the scope it wants. */
export function parseWwwAuthenticate(header: string | null): { bearer: boolean; resourceMetadata?: string; scope?: string } {
  if (!header) return { bearer: false };
  const param = (name: string) => {
    const m = new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s,]+))`, 'i').exec(header);
    if (!m) return undefined;
    return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
  };
  const resourceMetadata = param('resource_metadata');
  const scope = param('scope');
  return {
    bearer: /(?:^|[\s,])bearer(?=$|[\s,])/i.test(header),
    ...(resourceMetadata ? { resourceMetadata } : {}),
    ...(scope ? { scope } : {}),
  };
}

/**
 * A URL discovery or a sign-in reaches: https, or plain http to this computer, only for a server that is
 * on this computer itself (a stand-in): a server elsewhere cannot send Harness Relay to this computer's ports.
 */
function checkedUrl(url: unknown, loopbackOk: boolean): URL {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(t().mcpBadAddress(String(url).slice(0, 200)));
  }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopbackOk && LOOPBACK.test(u.hostname))) return u;
  throw new Error(t().mcpInsecureAddress(u.href.slice(0, 200)));
}

/** A response's body as a JSON object, read up to `MAX_BYTES` (undefined when it is not one, or longer). */
async function jsonObject(res: Response): Promise<Record<string, unknown> | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** A GET of metadata: its JSON object, or why there is none (never following a redirect). */
async function metadata(url: string): Promise<{ body?: Record<string, unknown>; why: string }> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { why: `HTTP ${res.status}` };
    }
    const body = await jsonObject(res);
    return body ? { body, why: '' } : { why: t().mcpNotJson };
  } catch (err) {
    return { why: (err as Error).message };
  }
}

/** Whether a protected resource's `resource` covers the server: the same origin, and the server's path at or under its own. */
function resourceCovers(resource: URL, server: URL): boolean {
  if (resource.origin !== server.origin) return false;
  const slash = (p: string) => (p.endsWith('/') ? p : `${p}/`);
  return slash(server.pathname).startsWith(slash(resource.pathname));
}

/** Where an authorization server's metadata may be, in order: RFC 8414's, then OpenID's (both with an issuer's path). */
export function authServerMetadataUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/+$/, '');
  const base = issuer.origin;
  if (!path) return [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`];
  return [
    `${base}/.well-known/oauth-authorization-server${path}`,
    `${base}/.well-known/openid-configuration${path}`,
    `${base}${path}/.well-known/openid-configuration`,
  ];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
const noSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * Where an MCP server signs in, as it and its authorization server publish it; undefined when it asks
 * for no sign-in (it answered without a 401 and publishes no protected resource metadata). Throws, saying
 * why, when it cannot be signed in to.
 */
export async function discoverMcpAuth(serverUrl: string): Promise<McpAuthDiscovery | undefined> {
  const server = checkedUrl(serverUrl, true);
  const local = LOOPBACK.test(server.hostname);
  // The server as a CLI first reaches it: an `initialize`, without a token.
  let status: number;
  let challenge: ReturnType<typeof parseWwwAuthenticate>;
  try {
    const res = await fetch(server.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'Harness Relay', version: '1' } },
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    challenge = parseWwwAuthenticate(res.headers.get('www-authenticate'));
    await res.body?.cancel().catch(() => undefined);
  } catch (err) {
    throw new Error(t().mcpUnreachable((err as Error).message));
  }
  const refused = status === 401 || status === 403;

  // Its protected resource metadata: where the challenge says, else at the well-known address with its path, then without.
  let resource: Record<string, unknown> | undefined;
  if (challenge.resourceMetadata) {
    const at = checkedUrl(challenge.resourceMetadata, local);
    const got = await metadata(at.href);
    if (!got.body) throw new Error(t().mcpMetadataFailed(at.href, got.why));
    resource = got.body;
  } else {
    const path = server.pathname.replace(/\/+$/, '');
    for (const at of [
      ...(path ? [`${server.origin}/.well-known/oauth-protected-resource${path}`] : []),
      `${server.origin}/.well-known/oauth-protected-resource`,
    ]) {
      resource = (await metadata(at)).body;
      if (resource) break;
    }
  }
  if (!resource) {
    if (refused) throw new Error(t().mcpNoResourceMetadata);
    return undefined;
  }

  // RFC 9728: metadata for another resource than this server is not used.
  let resourceParam = canonicalResource(server.href);
  if (typeof resource.resource === 'string' && resource.resource) {
    let named: URL;
    try {
      named = new URL(resource.resource);
    } catch {
      throw new Error(t().mcpOtherResource(resource.resource.slice(0, 200)));
    }
    if (!resourceCovers(named, server)) throw new Error(t().mcpOtherResource(named.href.slice(0, 200)));
    // As the metadata names it: what its authorization server knows it by.
    resourceParam = resource.resource;
  }
  const issuerText = strings(resource.authorization_servers)[0];
  if (!issuerText) throw new Error(t().mcpNoAuthServer);
  const issuer = checkedUrl(issuerText, local);

  let as: Record<string, unknown> | undefined;
  for (const at of authServerMetadataUrls(issuer)) {
    as = (await metadata(at)).body;
    if (as) break;
  }
  if (!as) throw new Error(t().mcpNoAuthServerMetadata(issuer.href));
  // RFC 8414, 3.3: the metadata is the issuer's own.
  const issuerName = typeof as.issuer === 'string' ? as.issuer : '';
  if (!issuerName || noSlash(issuerName) !== noSlash(issuerText))
    throw new Error(t().mcpOtherIssuer(String(as.issuer ?? '').slice(0, 200)));
  if (!as.authorization_endpoint || !as.token_endpoint) throw new Error(t().mcpNoEndpoints(issuer.href));
  const authorize = checkedUrl(as.authorization_endpoint, local).href;
  const token = checkedUrl(as.token_endpoint, local).href;
  // PKCE with S256 always (MCP: a server that does not say it supports it is not signed in to).
  if (!strings(as.code_challenge_methods_supported).includes('S256')) throw new Error(t().mcpNoPkce(issuer.href));
  if (!as.registration_endpoint) throw new Error(t().mcpNoRegistration(issuer.href));
  const registration = checkedUrl(as.registration_endpoint, local).href;
  let revoke: string | undefined;
  try {
    revoke = as.revocation_endpoint ? checkedUrl(as.revocation_endpoint, local).href : undefined;
  } catch {
    revoke = undefined; // one it cannot reach safely is not used
  }
  const scopes = challenge.scope ? challenge.scope.split(/\s+/).filter(Boolean) : strings(resource.scopes_supported);
  return {
    resource: resourceParam,
    scopes: scopes.slice(0, 50),
    issuer: issuerName,
    authorize,
    token,
    ...(revoke ? { revoke } : {}),
    registration,
  };
}

/**
 * Registers Harness Relay as a public client at the authorization server (RFC 7591), with these redirect
 * addresses. A client secret it gives all the same is kept and sent as it says.
 */
export async function registerClient(d: McpAuthDiscovery, redirectUris: string[]): Promise<McpClient> {
  let res: Response;
  try {
    res = await fetch(d.registration, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Harness Relay',
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(d.scopes.length ? { scope: d.scopes.join(' ') } : {}),
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(t().mcpRegistrationFailed(d.issuer, (err as Error).message));
  }
  const body = (await jsonObject(res)) ?? {};
  const clientId = typeof body.client_id === 'string' ? body.client_id : '';
  if (!res.ok || !clientId) throw new Error(t().mcpRegistrationFailed(d.issuer, tokenError(res.status, body as TokenAnswer)));
  const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : undefined;
  const secret = typeof body.client_secret === 'string' && body.client_secret && method !== 'none' ? body.client_secret : undefined;
  // RFC 7591's default for a client with a secret is `client_secret_basic`.
  return {
    clientId,
    ...(secret ? { clientSecret: secret, ...(method !== 'client_secret_post' ? { secretBasic: true } : {}) } : {}),
    redirectUris,
  };
}

/** An MCP server's sign-in as a provider description, for the sign-ins and the broker. */
function mcpProvider(name: string, o: Omit<StoredMcpOAuth, 'status' | 'signedInAt'>, clientSecret?: string): OAuthProvider {
  return {
    id: 'mcp',
    label: t().mcpServerLabel(name),
    endpoints: { authorize: o.authorize, token: o.token, ...(o.revoke ? { revoke: o.revoke } : {}) },
    clientId: o.clientId,
    ...(clientSecret ? { clientSecret, ...(o.secretBasic ? { clientSecretBasic: true } : {}) } : {}),
    flows: ['loopback'],
    scopes: () => [...o.scopes],
    hosts: [o.host],
    extraParams: { resource: o.resource },
    tokenParams: { resource: o.resource },
    refreshOptional: true,
  };
}

/** The tool library HTTP MCP servers' own sign-ins: starting one, signing out, and the tokens each turn gets. */
export class McpOAuth {
  readonly broker: TokenBroker;
  /** Revocations under way (`settled()`). */
  private revoking = new Set<Promise<void>>();

  constructor(
    private tools: ToolLibrary,
    private signIns: SignIns,
    private now: () => number = Date.now,
  ) {
    const grants: TokenGrants = {
      grant: (id) => {
        const s = tools.mcpServerById(id);
        const o = s?.oauth;
        if (!s || !o) return undefined;
        return {
          label: t().mcpServerLabel(s.name),
          status: o.status === 'reauth' ? 'reauth' : 'connected',
          ...(o.error ? { error: o.error } : {}),
          uses: [],
          ...(o.noRefresh ? { noRefresh: true } : {}),
        };
      },
      refreshToken: (id) => tools.mcpOAuthSecrets(id).refresh ?? '',
      setRefreshToken: (id, token) => tools.setMcpRefreshToken(id, token),
      needsSignIn: (id, why) => tools.mcpNeedsSignIn(id, why),
    };
    this.broker = new TokenBroker(grants, (id) => this.providerOf(id), now);
    tools.onMcpOAuthDropped = (id, dropped) => this.dropped(id, dropped);
  }

  private providerOf(id: string): OAuthProvider {
    const s = this.tools.mcpServerById(id);
    if (!s?.oauth) throw new Error(t().oauthAccountGone);
    return mcpProvider(s.name, s.oauth, this.tools.mcpOAuthSecrets(id).clientSecret);
  }

  /**
   * Starts a server's sign-in: discovery, a registration when the kept one lacks this sign-in's redirect
   * address, then the authorization server's page to open, as an account's sign-in does. One that asks
   * for no sign-in is a 409 that says so (`MCP_NO_SIGN_IN`); one that cannot be signed in to, a 502 that says why.
   */
  async startSignIn(o: { name: string; session?: string; origin?: string; port: number }): Promise<OAuthSignInView> {
    const server = this.tools.mcpServer(o.name);
    if (!server) throw new HttpError(404, t().mcpNotFound(o.name));
    if (server.transport !== 'http') throw new HttpError(400, t().mcpSignInNotHttp(o.name));
    this.signIns.assertRoom();
    const url = server.url;
    const cannot = (err: unknown) => new HttpError(502, t().mcpSignInCannotStart(o.name, (err as Error).message));
    let found: McpAuthDiscovery | undefined;
    try {
      found = await discoverMcpAuth(url);
    } catch (err) {
      throw cannot(err);
    }
    if (!found) throw new HttpError(409, t().mcpNoSignIn(o.name), MCP_NO_SIGN_IN);
    const redirect = redirectAddress(o.origin, o.port);
    const kept = server.oauth?.issuer === found.issuer && server.oauth.registration === found.registration ? server.oauth : undefined;
    let client: McpClient;
    if (kept?.redirectUris.includes(redirect)) {
      const secret = this.tools.mcpOAuthSecrets(server.id).clientSecret;
      client = {
        clientId: kept.clientId,
        redirectUris: kept.redirectUris,
        ...(secret ? { clientSecret: secret, ...(kept.secretBasic ? { secretBasic: true } : {}) } : {}),
      };
    } else {
      try {
        client = await registerClient(found, [redirect, ...(kept?.redirectUris ?? [])].slice(0, MAX_REDIRECTS));
      } catch (err) {
        throw cannot(err);
      }
    }
    // Removed, or its URL changed, while its authorization server was asked: not signed in to.
    const now = this.tools.mcpServerById(server.id);
    if (!now || now.transport !== 'http' || !sameServer(now.url, url)) throw new HttpError(409, t().mcpServerChanged(o.name));
    const oauth: Omit<StoredMcpOAuth, 'status' | 'signedInAt'> = {
      ...found,
      clientId: client.clientId,
      redirectUris: client.redirectUris,
      ...(client.secretBasic ? { secretBasic: true } : {}),
      host: tokenHost(url),
    };
    return this.signIns.start({
      provider: mcpProvider(now.name, oauth, client.clientSecret),
      uses: [],
      server: { id: server.id, name: now.name },
      ...(o.session ? { session: o.session } : {}),
      ...(o.origin ? { origin: o.origin } : {}),
      port: o.port,
      keep: (s) => this.keep(server.id, url, oauth, client.clientSecret, s),
    });
  }

  /**
   * Keeps a sign-in that worked: where it signed in and the client, with the server; its refresh token
   * (and client secret) in the credential store; its access token with the broker. Nothing, when the
   * server was removed or its URL changed meanwhile, or the sign-in ended.
   */
  private async keep(
    id: string,
    url: string,
    oauth: Omit<StoredMcpOAuth, 'status' | 'signedInAt'>,
    clientSecret: string | undefined,
    s: SignedIn,
  ): Promise<undefined> {
    if (!s.live()) throw new Error(t().oauthSignInCancelled);
    const server = this.tools.mcpServerById(id);
    if (!server || server.transport !== 'http' || !sameServer(server.url, url)) throw new Error(t().mcpServerChanged(server?.name ?? id));
    const refresh = s.tokens.refresh_token;
    this.tools.mcpSignedIn(
      id,
      { ...oauth, status: 'signed-in', signedInAt: this.now(), ...(refresh ? {} : { noRefresh: true }) },
      { ...(refresh ? { refresh } : {}), ...(clientSecret ? { clientSecret } : {}) },
    );
    this.broker.signedIn(id, s.tokens.access_token, s.tokens.expires_in);
    return undefined;
  }

  /** Signs a server out: its tokens are deleted, and revoked at its authorization server when it can. */
  async signOut(name: string): Promise<void> {
    const server = this.tools.mcpServer(name);
    if (!server) throw new HttpError(404, t().mcpNotFound(name));
    const access = this.broker.held(server.id);
    const dropped = this.tools.mcpSignOut(server.id);
    await this.forget(server.id, dropped, access);
  }

  /** A server's sign-in is gone (removed, its URL changed): forgotten here too, and revoked. */
  private dropped(id: string, dropped: DroppedMcpOAuth | undefined): void {
    void this.forget(id, dropped, this.broker.held(id));
  }

  private forget(id: string, dropped: DroppedMcpOAuth | undefined, access: string | undefined): Promise<void> {
    this.broker.forget(id);
    this.signIns.cancelServer(id);
    if (!dropped) return Promise.resolve();
    const p = this.revoke(dropped, access).finally(() => this.revoking.delete(p));
    this.revoking.add(p);
    return p;
  }

  /** Revokes the refresh token (else the access token) at the authorization server's revocation endpoint (RFC 7009), if it has one. */
  private async revoke({ oauth, secrets }: DroppedMcpOAuth, access: string | undefined): Promise<void> {
    const token = secrets.refresh ?? access;
    if (!oauth.revoke || !token) return;
    const basic = Boolean(secrets.clientSecret && oauth.secretBasic);
    await fetch(oauth.revoke, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(basic ? { authorization: basicAuth(oauth.clientId, secrets.clientSecret!) } : {}),
      },
      body: new URLSearchParams({
        token,
        token_type_hint: secrets.refresh ? 'refresh_token' : 'access_token',
        client_id: oauth.clientId,
        ...(secrets.clientSecret && !basic ? { client_secret: secrets.clientSecret } : {}),
      }).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then((res) => res.body?.cancel())
      .catch(() => undefined);
  }

  /** The revocations under way, done (tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.revoking]);
  }

  /**
   * What an agent gets from the library for a turn, its signed-in servers with an access token each in
   * their `Authorization` header (in place of one typed by hand). A server whose token cannot be had
   * (its sign-in needs renewing, or could not be renewed now), or would go to another host than the one
   * it signed in at, or over plain http to another computer, is left out, with a note (`leftOut`).
   */
  async forTurn(tools: AgentTools): Promise<AgentTools> {
    if (!tools.oauthServers?.length) return tools;
    const specs = tools.mcpServers.map((s) => ({ ...s, headers: { ...s.headers } }));
    const leftOut: NonNullable<AgentTools['leftOut']> = [];
    await Promise.all(
      tools.oauthServers.map(async ({ name, id }) => {
        const spec = specs.find((s) => s.name === name);
        if (!spec) return;
        try {
          const token = await this.turnToken(id, spec.url);
          for (const k of Object.keys(spec.headers)) if (k.toLowerCase() === 'authorization') delete spec.headers[k];
          spec.headers.Authorization = `Bearer ${token}`;
        } catch (err) {
          const o = this.tools.mcpServerById(id)?.oauth;
          leftOut.push(
            o?.status === 'reauth'
              ? { name, reason: 'reauth', note: t().mcpLeftOutSignIn(name, o.error ?? '') }
              : { name, reason: 'failed', note: t().mcpLeftOut(name, (err as Error).message) },
          );
        }
      }),
    );
    return {
      ...tools,
      mcpServers: specs.filter((s) => !leftOut.some((l) => l.name === s.name)),
      ...(leftOut.length ? { leftOut } : {}),
    };
  }

  /** A turn's token for a server: only for its own host, over https or plain http to this computer. */
  private turnToken(id: string, url: string): Promise<string> {
    const o = this.tools.mcpServerById(id)?.oauth;
    let u: URL | undefined;
    try {
      u = new URL(url);
    } catch {
      u = undefined;
    }
    const safe = u && (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.test(u.hostname)));
    if (!o || !u || !safe || tokenHost(url) !== o.host) return Promise.reject(new Error(t().oauthHostRefused(u?.host ?? url)));
    // One that cannot be renewed is given for what it has left.
    return this.broker.accessToken(id, false, o.noRefresh ? undefined : TURN_EARLY_MS);
  }
}
