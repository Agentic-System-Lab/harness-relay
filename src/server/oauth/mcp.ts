import { APP_SERVERS, isSlackMcp } from '../../shared/apps';
import type { OAuthSignInView } from '../../shared/types';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { AgentTools, DroppedMcpOAuth, StoredMcpOAuth, ToolLibrary } from '../tools';
import { basicAuth, jsonObject, tokenError, TokenBroker, type ProviderRequest, type TokenGrants } from './broker';
import { checkedAddresses, mcpSend, SYSTEM_NET, type McpNet } from './net';
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
 * - Its requests (`net.ts`) follow no redirect, read little, and for a server that is not on this computer
 *   go only to addresses on the internet, checked and pinned. Against a mix-up (a hostile server's
 *   metadata naming another authorization server's page, to have its code sent to its own token
 *   endpoint): the issuer must be the metadata's own, exactly; the redirect's `iss` must be it (RFC 9207);
 *   and a page or token endpoint that is not on the issuer's origin is shown to the user, who confirms it
 *   before the page opens (`signin.ts`).
 * - At each turn, an agent given the server gets an access token with a while left in its
 *   `Authorization` header (`forTurn()`), as the library's headers reach its CLI; only to the server's own
 *   host, over https (plain http to this computer only). A server whose sign-in needs renewing is left
 *   out of the turn, with a note the agents and the user see.
 */

/** Discovery's requests: each this long at most (what they read is bounded by `jsonObject()`). */
const TIMEOUT_MS = 15_000;
/**
 * How long before it expires a turn's token is renewed: when less than half its lifetime, or ten
 * minutes, whichever is less, is left (a turn may take a while; a token that lasts ten minutes or less
 * is not renewed at every turn).
 */
export const TURN_EARLY = (lifetimeMs: number): number => Math.min(lifetimeMs / 2, 10 * 60_000);
/** The longest client id or client secret a registration may give. */
const MAX_CLIENT_TEXT = 4096;
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
  registration: string; // empty for a distributor-registered public client
  /** Its metadata says its redirects bring back `iss` (`authorization_response_iss_parameter_supported`, RFC 9207). */
  issParameter?: boolean;
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

/** What a 401's `WWW-Authenticate` says: where its resource metadata is, and the scope it wants. */
export function parseWwwAuthenticate(header: string | null): { resourceMetadata?: string; scope?: string } {
  if (!header) return {};
  const param = (name: string) => {
    const m = new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s,]+))`, 'i').exec(header);
    if (!m) return undefined;
    return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
  };
  const resourceMetadata = param('resource_metadata');
  const scope = param('scope');
  return {
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

/** How discovery, registration and revocation reach a server and its authorization server (`net.ts`). */
interface Reach {
  /** The MCP server is on this computer: its addresses are not checked. */
  local: boolean;
  net: McpNet;
}

/** A request of the sign-in: to checked addresses only for a server elsewhere, never following a redirect. */
function send(url: string, r: Omit<ProviderRequest, 'timeoutMs'>, reach: Reach): Promise<Response> {
  return mcpSend(url, { ...r, timeoutMs: TIMEOUT_MS }, reach);
}

/** A GET of metadata: its JSON object, or why there is none (never following a redirect: a 3xx is a failure). */
async function metadata(url: string, reach: Reach): Promise<{ body?: Record<string, unknown>; why: string }> {
  try {
    const res = await send(url, { method: 'GET', headers: { accept: 'application/json' } }, reach);
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

/** Whether a protected resource's `resource` is the server itself (RFC 9728, 3.3): the same canonical URL, with no fragment. */
function sameResource(resource: string, server: URL): boolean {
  try {
    return !resource.includes('#') && canonicalResource(resource) === canonicalResource(server.href);
  } catch {
    return false;
  }
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

/** Whether a host (with its port) is this computer's loopback: a server there is on this computer. */
function onThisComputer(host: string): boolean {
  try {
    return LOOPBACK.test(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Where an MCP server signs in, as it and its authorization server publish it; undefined when it asks
 * for no sign-in (it answered without a 401 and publishes no protected resource metadata). Throws, saying
 * why, when it cannot be signed in to. `net`: how its requests find addresses (a stand-in's in tests).
 */
export async function discoverMcpAuth(serverUrl: string, net: McpNet = SYSTEM_NET): Promise<McpAuthDiscovery | undefined> {
  const server = checkedUrl(serverUrl, true);
  const local = LOOPBACK.test(server.hostname);
  const reach: Reach = { local, net };
  // The server as a CLI first reaches it: an `initialize`, without a token.
  let status: number;
  let challenge: ReturnType<typeof parseWwwAuthenticate>;
  try {
    const res = await send(
      server.href,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'Harness Relay', version: '1' } },
        }),
      },
      reach,
    );
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
    const got = await metadata(at.href, reach);
    if (!got.body) throw new Error(t().mcpMetadataFailed(at.href, got.why));
    resource = got.body;
  } else {
    const path = server.pathname.replace(/\/+$/, '');
    for (const at of [
      ...(path ? [`${server.origin}/.well-known/oauth-protected-resource${path}`] : []),
      `${server.origin}/.well-known/oauth-protected-resource`,
    ]) {
      resource = (await metadata(at, reach)).body;
      if (resource) break;
    }
  }
  if (!resource) {
    if (refused) throw new Error(t().mcpNoResourceMetadata);
    return undefined;
  }

  // RFC 9728: metadata for another resource than this server (another server, or one above it on the
  // same origin) is not used: a token for it would not be this server's alone.
  let resourceParam = canonicalResource(server.href);
  if (resource.resource !== undefined) {
    if (typeof resource.resource !== 'string' || !sameResource(resource.resource, server))
      throw new Error(t().mcpOtherResource(String(resource.resource).slice(0, 200)));
    // As the metadata names it: what its authorization server knows it by.
    resourceParam = resource.resource;
  }
  const issuerText = strings(resource.authorization_servers)[0];
  if (!issuerText) throw new Error(t().mcpNoAuthServer);
  const issuer = checkedUrl(issuerText, local);

  let as: Record<string, unknown> | undefined;
  for (const at of authServerMetadataUrls(issuer)) {
    as = (await metadata(at, reach)).body;
    if (as) break;
  }
  if (!as) throw new Error(t().mcpNoAuthServerMetadata(issuer.href));
  // RFC 8414, 3.3: the metadata is the issuer's own, named exactly as the server names it.
  const issuerName = typeof as.issuer === 'string' ? as.issuer : '';
  if (!issuerName || issuerName !== issuerText) throw new Error(t().mcpOtherIssuer(String(as.issuer ?? '').slice(0, 200)));
  if (!as.authorization_endpoint || !as.token_endpoint) throw new Error(t().mcpNoEndpoints(issuer.href));
  const authorize = checkedUrl(as.authorization_endpoint, local).href;
  const token = checkedUrl(as.token_endpoint, local).href;
  // PKCE with S256 always (MCP: a server that does not say it supports it is not signed in to).
  if (!strings(as.code_challenge_methods_supported).includes('S256')) throw new Error(t().mcpNoPkce(issuer.href));
  if (!as.registration_endpoint) throw new Error(t().mcpNoRegistration(issuer.href));
  const registration = checkedUrl(as.registration_endpoint, local).href;
  // For a server elsewhere, the addresses Harness Relay will post to are checked now too, to say so
  // before the sign-in page opens (and again at each request, which goes only to those checked then).
  if (!local) for (const at of new Set([token, registration])) await checkedAddresses(new URL(at), net);
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
    ...(as.authorization_response_iss_parameter_supported === true ? { issParameter: true } : {}),
  };
}

/**
 * Registers Harness Relay as a public client at the authorization server (RFC 7591), with these redirect
 * addresses. A client secret it gives all the same is kept and sent as it says.
 */
export async function registerClient(
  d: McpAuthDiscovery,
  redirectUris: string[],
  reach: Reach = { local: false, net: SYSTEM_NET },
): Promise<McpClient> {
  let res: Response;
  try {
    res = await send(
      d.registration,
      {
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
      },
      reach,
    );
  } catch (err) {
    throw new Error(t().mcpRegistrationFailed(d.issuer, (err as Error).message));
  }
  const body = (await jsonObject(res)) ?? {};
  // A client id or secret longer than any token is no client of Harness Relay's.
  const text = (v: unknown) => (typeof v === 'string' && v.length <= MAX_CLIENT_TEXT ? v : '');
  const clientId = text(body.client_id);
  if (!res.ok || !clientId) throw new Error(t().mcpRegistrationFailed(d.issuer, tokenError(res.status, body)));
  const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : undefined;
  const secret = text(body.client_secret) && method !== 'none' ? text(body.client_secret) : undefined;
  // RFC 7591's default for a client with a secret is `client_secret_basic`.
  return {
    clientId,
    ...(secret ? { clientSecret: secret, ...(method !== 'client_secret_post' ? { secretBasic: true } : {}) } : {}),
    redirectUris,
  };
}

/** An MCP server's sign-in as a provider description, for the sign-ins and the broker. */
function mcpProvider(name: string, o: Omit<StoredMcpOAuth, 'status' | 'signedInAt'>, net: McpNet, clientSecret?: string): OAuthProvider {
  const reach: Reach = { local: onThisComputer(o.host), net };
  return {
    id: 'mcp',
    label: t().mcpServerLabel(name),
    endpoints: { authorize: o.authorize, token: o.token, ...(o.revoke ? { revoke: o.revoke } : {}) },
    clientId: o.clientId,
    ...(clientSecret ? { clientSecret, ...(o.secretBasic ? { clientSecretBasic: true } : {}) } : {}),
    flows: ['loopback'],
    scopes: () => [...o.scopes],
    hosts: [o.host],
    extraParams: { resource: o.resource, ...(o.resource === APP_SERVERS.heptabase ? { prompt: 'consent' } : {}) },
    tokenParams: { resource: o.resource },
    refreshOptional: true,
    ...(o.token === 'https://slack.com/api/oauth.v2.user.access'
      ? { revokedRefreshErrors: ['invalid_refresh_token', 'token_revoked'] }
      : {}),
    issuer: o.issuer,
    ...(o.issParameter ? { issParameter: true } : {}),
    send: (url, r) => mcpSend(url, r, reach),
  };
}

/**
 * What the user confirms before a sign-in's page opens, when its page or its token endpoint is not on its
 * issuer's own origin (a mix-up: a server naming another authorization server's page); undefined when
 * both are.
 */
export function signInConfirmation(d: Pick<McpAuthDiscovery, 'issuer' | 'authorize' | 'token'>): OAuthSignInView['confirm'] {
  const issuer = new URL(d.issuer);
  const page = new URL(d.authorize);
  const token = new URL(d.token);
  if (page.origin === issuer.origin && token.origin === issuer.origin) return undefined;
  return { host: page.host, issuer: issuer.host, ...(token.origin !== issuer.origin ? { tokenHost: token.host } : {}) };
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
    /** How its requests find a host's addresses (a stand-in's in tests). */
    private net: McpNet = SYSTEM_NET,
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
      // Its registered client refused (expired, purged): the next sign-in registers again.
      clientRefused: (id, why) => tools.mcpClientRefused(id, why),
    };
    this.broker = new TokenBroker(grants, (id) => this.providerOf(id), now);
    tools.onMcpOAuthDropped = (id, dropped) => this.dropped(id, dropped);
  }

  private providerOf(id: string): OAuthProvider {
    const s = this.tools.mcpServerById(id);
    if (!s?.oauth) throw new Error(t().oauthAccountGone);
    return mcpProvider(s.name, s.oauth, this.net, this.tools.mcpOAuthSecrets(id).clientSecret);
  }

  /**
   * Starts a server's sign-in: discovery, a registration when the kept one lacks this sign-in's redirect
   * address (or was refused), then the authorization server's page to open, as an account's sign-in
   * does; when that page or its token endpoint is not on the issuer's origin, where it is, for the user
   * to confirm first (`confirm`). One that asks for no sign-in is a 409 that says so (`MCP_NO_SIGN_IN`);
   * one that cannot be signed in to, a 502 that says why. Its discovery counts as a sign-in waiting (429).
   */
  async startSignIn(o: { name: string; session?: string; origin?: string; port: number }): Promise<OAuthSignInView> {
    const server = this.tools.mcpServer(o.name);
    if (!server) throw new HttpError(404, t().mcpNotFound(o.name));
    if (server.transport !== 'http') throw new HttpError(400, t().mcpSignInNotHttp(o.name));
    const url = server.url;
    const reach: Reach = { local: onThisComputer(tokenHost(url)), net: this.net };
    const cannot = (err: unknown) => new HttpError(502, t().mcpSignInCannotStart(o.name, (err as Error).message));
    // Slack registers one public desktop client in advance. Its desktop PKCE redirect is on localhost.
    const slack = isSlackMcp(url);
    const callback = new URL(redirectAddress(o.origin, o.port));
    const origin = slack ? `http://localhost:${callback.port}` : o.origin;
    const redirect = redirectAddress(origin, o.port);
    let found: McpAuthDiscovery | undefined;
    let client: McpClient;
    const release = this.signIns.reserve();
    try {
      if (slack) {
        // The old desktop client survives in a completed grant. Adding an MCP library row alone
        // cannot start Slack OAuth. Renew only the same client, endpoints and read permissions.
        const saved = server.oauth;
        if (
          !sameServer(url, APP_SERVERS.slack) ||
          !saved?.clientId ||
          saved.registration !== '' ||
          saved.issuer !== 'https://mcp.slack.com' ||
          saved.resource !== 'https://mcp.slack.com' ||
          saved.authorize !== 'https://slack.com/oauth/v2_user/authorize' ||
          saved.token !== 'https://slack.com/api/oauth.v2.user.access'
        )
          throw new HttpError(409, t().appsSlackInAssistant);
        const scopes = saved.scopes.filter((scope) => ['search:read.public', 'channels:history', 'channels:read'].includes(scope));
        if (!scopes.length) throw new HttpError(409, t().appsSlackInAssistant);
        found = {
          resource: saved.resource,
          issuer: saved.issuer,
          authorize: saved.authorize,
          token: saved.token,
          registration: '',
          scopes,
        };
        client = { clientId: saved.clientId, redirectUris: [redirect] };
      } else {
        try {
          found = await discoverMcpAuth(url, this.net);
        } catch (err) {
          throw cannot(err);
        }
        if (!found) throw new HttpError(409, t().mcpNoSignIn(o.name), MCP_NO_SIGN_IN);
        if (url === APP_SERVERS.heptabase && !found.scopes.includes('offline_access')) found.scopes.push('offline_access');
        // The client kept, when it is this authorization server's and was not refused.
        const had = server.oauth;
        const kept = had?.issuer === found.issuer && had.registration === found.registration && !had.clientRefused ? had : undefined;
        if (kept?.redirectUris.includes(redirect)) {
          const secret = this.tools.mcpOAuthSecrets(server.id).clientSecret;
          client = {
            clientId: kept.clientId,
            redirectUris: kept.redirectUris,
            ...(secret ? { clientSecret: secret, ...(kept.secretBasic ? { secretBasic: true } : {}) } : {}),
          };
        } else {
          try {
            client = await registerClient(found, [redirect, ...(kept?.redirectUris ?? [])].slice(0, MAX_REDIRECTS), reach);
          } catch (err) {
            throw cannot(err);
          }
        }
      }
    } finally {
      release();
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
    const confirm = signInConfirmation(found);
    return this.signIns.start({
      provider: mcpProvider(now.name, oauth, this.net, client.clientSecret),
      uses: [],
      server: { id: server.id, name: now.name },
      ...(o.session ? { session: o.session } : {}),
      ...(origin ? { origin } : {}),
      port: o.port,
      ...(confirm ? { confirm } : {}),
      keep: (s) => this.keep(server.id, url, oauth, client.clientSecret, s),
    });
  }

  /**
   * Keeps a sign-in that worked: where it signed in and the client, with the server; its refresh token
   * (and client secret) in the credential store; its access token with the broker. Nothing, when the
   * server was removed or its URL changed meanwhile, or the sign-in ended. The sign-in it replaces (a
   * sign-in again, or another one at the same time) has its refresh token revoked.
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
    if (isSlackMcp(url) && server.oauth?.clientId !== oauth.clientId) throw new Error(t().oauthSignInCancelled);
    const refresh = s.refreshToken;
    // Its one token: an MCP server's sign-in has no uses.
    const token = s.access[0]!.token;
    const before = server.oauth ? { oauth: server.oauth, secrets: this.tools.mcpOAuthSecrets(id) } : undefined;
    const access = this.broker.held(id);
    this.tools.mcpSignedIn(
      id,
      { ...oauth, status: 'signed-in', signedInAt: this.now(), ...(refresh ? {} : { noRefresh: true }) },
      { ...(refresh ? { refresh } : {}), ...(clientSecret ? { clientSecret } : {}) },
    );
    this.broker.signedIn(id, s.access);
    // The one it replaces, revoked (its refresh token, else its access token) unless it is the same.
    if (before && (before.secrets.refresh ? before.secrets.refresh !== refresh : access && access !== token))
      this.track(this.revoke(before, access));
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
    return this.track(this.revoke(dropped, access));
  }

  /** A revocation under way, for `settled()`. */
  private track(p: Promise<void>): Promise<void> {
    const tracked = p.finally(() => this.revoking.delete(tracked));
    this.revoking.add(tracked);
    return tracked;
  }

  /**
   * Revokes the refresh token (else the access token) at the authorization server's revocation endpoint
   * (RFC 7009), if it has one, to the addresses its server may reach (`net.ts`). Its answer is not read:
   * nothing it says changes anything here, and one that fails is not tried again.
   */
  private async revoke({ oauth, secrets }: DroppedMcpOAuth, access: string | undefined): Promise<void> {
    const token = secrets.refresh ?? access;
    if (!oauth.revoke || !token) return;
    const basic = Boolean(secrets.clientSecret && oauth.secretBasic);
    await send(
      oauth.revoke,
      {
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
      },
      { local: onThisComputer(oauth.host), net: this.net },
    )
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
          spec.signedIn = true;
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
    return this.broker.accessToken(id, undefined, false, o.noRefresh ? 0 : TURN_EARLY);
  }
}
