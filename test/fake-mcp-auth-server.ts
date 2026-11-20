/*
 * A stand-in for a remote MCP server that signs in with OAuth (MCP's authorization spec), and for its
 * authorization server, on one local port, for the MCP sign-in tests. The MCP server (`/mcp`) answers 401
 * with `WWW-Authenticate: Bearer resource_metadata="…"` without a good token, and serves its protected
 * resource metadata (RFC 9728) where the header says, or only at a well-known address (with its path, or
 * without), or nowhere. The authorization server's issuer has a path (`/tenant`), and its metadata is at
 * RFC 8414's address (the well-known part before the issuer's path) or OpenID's (both forms); it can leave
 * out PKCE with S256 or dynamic client registration. Registration (RFC 7591), the authorization page
 * (`allow()`, or a page with an Allow link), the token endpoint (the code exchanged with its PKCE
 * verifier, the registered redirect address and the `resource` checked; refresh with rotation, an
 * `invalid_grant` or any other answer instead; no refresh token if asked) and revocation, recorded. Plain
 * HTTP on 127.0.0.1, which Harness Relay allows only for a server on this computer; `publishAs()` makes it
 * name itself by another address (`https://mcp.example.com`), for a test that reaches it through a stand-in
 * `McpNet` as if it were elsewhere. Its authorization server can say its redirects bring back `iss`
 * (RFC 9207), answer its metadata with a redirect, and answer registration, the code exchange or
 * revocation with anything; `asMetadata` and `resourceMetadataUrl` override what it publishes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

export interface FakeMcpAuth {
  /** `http://127.0.0.1:<port>`: where it listens. */
  url: string;
  host: string;
  /** The address it names itself by in what it publishes: `url`, unless `publishAs()` set another. */
  publicUrl: string;
  /** Name itself by another base address (`https://mcp.example.com`): `mcpUrl` and `issuer` follow. */
  publishAs(base: string): void;
  /** The MCP server's URL (`<url>/mcp`). */
  mcpUrl: string;
  /** The authorization server's issuer (`<url>/tenant`). */
  issuer: string;
  /** Every request: its method, path (and query), body, and Bearer token or Basic credentials (decoded `id:secret`). */
  requests: { method: string; path: string; body: string; bearer?: string; basic?: string }[];
  /** How the MCP server says where its metadata is: in the 401's header, or not (found at a well-known address). */
  header: 'resource_metadata' | 'bare' | 'none';
  /** A `scope` in the 401's challenge, while set. */
  challengeScope?: string;
  /** The MCP server answers without a sign-in (200), as one that asks for none. */
  open: boolean;
  /** Where its protected resource metadata is served: where the header points (and the well-known address with the path), at the origin's, or nowhere. */
  resourceMetadataAt: 'path' | 'root' | 'none';
  /** The `resource` its metadata names (the MCP server's URL unless set; `null`: none). */
  resource?: string | null;
  /** Where the 401's header says its metadata is (its own address with the path unless set). */
  resourceMetadataUrl?: string;
  /** What the authorization server's metadata says besides (or instead of) the usual. */
  asMetadata: Record<string, unknown>;
  /** Its metadata is answered with a redirect to where it really is, which must never be followed. */
  metadataRedirect: boolean;
  /** Its metadata says its redirects bring back `iss` (RFC 9207), and they do. */
  issParameter: boolean;
  /** The `iss` its redirects bring back instead of its own issuer (`null`: none), while set. */
  sendIss?: string | null;
  /** The scopes its metadata lists. */
  scopes: string[];
  /** Where the authorization server's metadata is: RFC 8414's, OpenID's with the path inserted, OpenID's appended, or nowhere. */
  metadataAt: 'oauth' | 'openid' | 'openid-appended' | 'none';
  /** It says it supports PKCE with S256. */
  pkce: boolean;
  /** It has a registration endpoint. */
  registration: boolean;
  /** Registration gives a client secret too, to send as this method says. */
  clientSecret?: 'client_secret_basic' | 'client_secret_post';
  /** The clients registered: what each asked for, and its id. */
  clients: { clientId: string; body: Record<string, unknown>; secret?: string }[];
  /** The resource each authorization asked for. */
  authorized: { clientId: string; resource: string | null; scope: string | null; redirectUri: string }[];
  refreshTokens: Map<string, boolean>;
  accessTokens: Map<string, boolean>;
  /** Give a new refresh token on each refresh, the old one no longer working. */
  rotate: boolean;
  /** The code exchange gives no refresh token. */
  noRefresh: boolean;
  /** An access token's lifetime, in seconds. */
  expiresIn: number;
  /** What a refresh is answered instead of a token, while set. */
  refreshAnswer?: { status: number; body: Record<string, unknown> };
  /** What the code exchange is answered instead of tokens, while set (a string: sent as it is). */
  codeAnswer?: { status: number; body: Record<string, unknown> | string };
  /** What registration is answered instead, while set. */
  registrationAnswer?: { status: number; body: Record<string, unknown> | string };
  /** The status revocation answers (200 unless set). */
  revokeStatus: number;
  /** A request to this path is recorded, then waits for `until` before it is answered, while set (`/text` answers plain text). */
  hold?: { path: string; until: Promise<void> };
  /** The tokens revoked, with the client that asked (in the form, or Basic's `id:secret`). */
  revoked: { token: string; hint: string | null; clientId: string | null; basic?: string }[];
  /** The authorization server's page: the address it sends the browser to (Allow, or not). */
  allow(authorizeUrl: string, deny?: boolean): string;
  close(): Promise<void>;
}

const b64url = (b: Buffer) => b.toString('base64url');

export async function fakeMcpAuth(tool?: { name: string; text: string; calls: string[] }): Promise<FakeMcpAuth> {
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string; resource: string | null }>();
  const self: FakeMcpAuth = {
    url: '',
    host: '',
    publicUrl: '',
    publishAs(base) {
      self.publicUrl = base;
      self.mcpUrl = `${base}/mcp`;
      self.issuer = `${base}/tenant`;
    },
    mcpUrl: '',
    issuer: '',
    requests: [],
    header: 'resource_metadata',
    open: false,
    resourceMetadataAt: 'path',
    asMetadata: {},
    metadataRedirect: false,
    issParameter: false,
    revokeStatus: 200,
    scopes: ['mcp:tools', 'mcp:read'],
    metadataAt: 'oauth',
    pkce: true,
    registration: true,
    clients: [],
    authorized: [],
    refreshTokens: new Map(),
    accessTokens: new Map(),
    rotate: true,
    noRefresh: false,
    expiresIn: 3600,
    revoked: [],
    allow(authorizeUrl, deny = false) {
      const q = new URL(authorizeUrl).searchParams;
      const client = self.clients.find((c) => c.clientId === q.get('client_id'));
      const redirectUri = q.get('redirect_uri') ?? '';
      // Only an address the client was registered with.
      if (!client || !(client.body.redirect_uris as string[]).includes(redirectUri))
        throw new Error(`not a registered redirect: ${redirectUri}`);
      const back = new URL(redirectUri);
      self.authorized.push({ clientId: client.clientId, resource: q.get('resource'), scope: q.get('scope'), redirectUri });
      if (deny) back.searchParams.set('error', 'access_denied');
      else {
        const code = `code-${randomUUID()}`;
        codes.set(code, { challenge: q.get('code_challenge') ?? '', redirectUri, clientId: client.clientId, resource: q.get('resource') });
        back.searchParams.set('code', code);
      }
      back.searchParams.set('state', q.get('state') ?? '');
      // RFC 9207: its issuer, when it says so (or what a test makes it send).
      const iss = self.sendIss !== undefined ? self.sendIss : self.issParameter ? self.issuer : null;
      if (iss !== null) back.searchParams.set('iss', iss);
      return back.href;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };

  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => resolve(body));
    });
  const tokens = (refresh: boolean) => {
    const access = `mcp-access-${randomUUID()}`;
    self.accessTokens.set(access, true);
    const r = refresh ? `mcp-refresh-${randomUUID()}` : undefined;
    if (r) self.refreshTokens.set(r, true);
    return { access, refresh: r };
  };
  /** The client a token request is from: its id, and its secret checked as it registered (none for a public client). */
  const clientOf = (form: URLSearchParams, basic: string | undefined) => {
    const [basicId, basicSecret] = basic ? basic.split(':').map(decodeURIComponent) : [];
    const id = basicId ?? form.get('client_id');
    const client = self.clients.find((c) => c.clientId === id);
    if (!client) return undefined;
    if (client.secret) {
      const given = self.clientSecret === 'client_secret_basic' ? basicSecret : form.get('client_secret');
      if (given !== client.secret) return undefined;
    }
    return client;
  };

  const server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? '/';
    const auth = req.headers.authorization ?? '';
    const bearer = /^Bearer (.+)$/.exec(auth)?.[1];
    const basicRaw = /^Basic (.+)$/.exec(auth)?.[1];
    const basic = basicRaw ? Buffer.from(basicRaw, 'base64').toString() : undefined;
    self.requests.push({ method: req.method ?? '', path, body, ...(bearer ? { bearer } : {}), ...(basic ? { basic } : {}) });
    const url = new URL(path, self.url);
    // Recorded, then held.
    if (self.hold && url.pathname === self.hold.path) await self.hold.until;
    // Something that is not JSON.
    if (url.pathname === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('hello');
    }
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof v === 'string' ? v : JSON.stringify(v));
    };
    const resourceMetadata = {
      ...(self.resource !== null ? { resource: self.resource ?? self.mcpUrl } : {}),
      authorization_servers: [self.issuer],
      scopes_supported: self.scopes,
    };
    const asMetadata = {
      issuer: self.issuer,
      authorization_endpoint: `${self.issuer}/authorize`,
      token_endpoint: `${self.issuer}/token`,
      revocation_endpoint: `${self.issuer}/revoke`,
      ...(self.registration ? { registration_endpoint: `${self.issuer}/register` } : {}),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: self.pkce ? ['S256'] : ['plain'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      ...(self.issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
      ...self.asMetadata,
    };

    // The MCP server: a good token, or 401 with where to sign in.
    if (url.pathname === '/mcp') {
      if (self.open || (bearer && self.accessTokens.get(bearer))) {
        if (tool && req.method === 'POST') {
          const request = JSON.parse(body);
          if (request.method === 'tools/call') {
            if (request.params.name !== tool.name)
              return json(200, { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Unknown tool' } });
            tool.calls.push(request.params.name);
            return json(200, { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: tool.text }] } });
          }
        }
        return json(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } });
      }
      const params = [
        ...(self.header === 'resource_metadata'
          ? [`resource_metadata="${self.resourceMetadataUrl ?? `${self.publicUrl}/.well-known/oauth-protected-resource/mcp`}"`]
          : []),
        ...(self.challengeScope ? [`scope="${self.challengeScope}"`] : []),
      ];
      res.writeHead(401, self.header === 'none' ? {} : { 'www-authenticate': `Bearer${params.length ? ` ${params.join(', ')}` : ''}` });
      return res.end();
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' && self.resourceMetadataAt === 'path')
      return json(200, resourceMetadata);
    if (url.pathname === '/.well-known/oauth-protected-resource' && self.resourceMetadataAt === 'root') return json(200, resourceMetadata);
    const served = {
      oauth: '/.well-known/oauth-authorization-server/tenant',
      openid: '/.well-known/openid-configuration/tenant',
      'openid-appended': '/tenant/.well-known/openid-configuration',
      none: '',
    }[self.metadataAt];
    if (served && url.pathname === served) {
      if (!self.metadataRedirect) return json(200, asMetadata);
      res.writeHead(302, { location: `${self.publicUrl}/moved${served}` });
      return res.end();
    }
    if (served && url.pathname === `/moved${served}`) return json(200, asMetadata);

    if (req.method === 'POST' && url.pathname === '/tenant/register' && self.registration) {
      if (self.registrationAnswer) return json(self.registrationAnswer.status, self.registrationAnswer.body);
      const asked = JSON.parse(body) as Record<string, unknown>;
      const clientId = `client-${self.clients.length + 1}`;
      const secret = self.clientSecret ? `secret-${randomUUID()}` : undefined;
      self.clients.push({ clientId, body: asked, ...(secret ? { secret } : {}) });
      return json(201, {
        client_id: clientId,
        ...asked,
        ...(secret ? { client_secret: secret, token_endpoint_auth_method: self.clientSecret } : {}),
      });
    }
    if (req.method === 'GET' && url.pathname === '/tenant/authorize') {
      // A page with an Allow link, for a browser.
      const back = self.allow(url.href);
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(
        `<!doctype html><title>Sign in</title><h1>Let Harness Relay use this server?</h1><a href="${back.replace(/&/g, '&amp;')}">Allow</a>`,
      );
    }
    if (req.method === 'POST' && url.pathname === '/tenant/token') {
      const form = new URLSearchParams(body);
      const client = clientOf(form, basic);
      if (!client) return json(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        if (self.codeAnswer) return json(self.codeAnswer.status, self.codeAnswer.body);
        const c = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verified =
          c &&
          c.clientId === client.clientId &&
          c.redirectUri === form.get('redirect_uri') &&
          c.challenge ===
            b64url(
              createHash('sha256')
                .update(form.get('code_verifier') ?? '')
                .digest(),
            );
        if (!verified) return json(400, { error: 'invalid_grant', error_description: 'The code is not valid' });
        // RFC 8707: the resource the authorization named, again.
        if (!form.get('resource') || form.get('resource') !== c.resource) return json(400, { error: 'invalid_target' });
        const t = tokens(!self.noRefresh);
        return json(200, {
          access_token: t.access,
          ...(t.refresh ? { refresh_token: t.refresh } : {}),
          token_type: 'Bearer',
          expires_in: self.expiresIn,
        });
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (self.refreshAnswer) return json(self.refreshAnswer.status, self.refreshAnswer.body);
        const old = form.get('refresh_token') ?? '';
        if (!self.refreshTokens.get(old)) return json(400, { error: 'invalid_grant', error_description: 'The refresh token is not valid' });
        if (form.get('resource') !== (self.resource ?? self.mcpUrl)) return json(400, { error: 'invalid_target' });
        const t = tokens(self.rotate);
        if (self.rotate) self.refreshTokens.set(old, false);
        return json(200, { access_token: t.access, ...(t.refresh ? { refresh_token: t.refresh } : {}), expires_in: self.expiresIn });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (req.method === 'POST' && url.pathname === '/tenant/revoke') {
      const form = new URLSearchParams(body);
      const token = form.get('token') ?? '';
      self.revoked.push({ token, hint: form.get('token_type_hint'), clientId: form.get('client_id'), ...(basic ? { basic } : {}) });
      if (self.revokeStatus !== 200) return json(self.revokeStatus, { error: 'server_error' });
      self.refreshTokens.set(token, false);
      self.accessTokens.set(token, false);
      return json(200, {});
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  self.url = `http://127.0.0.1:${port}`;
  self.host = `127.0.0.1:${port}`;
  self.publishAs(self.url);
  return self;
}
