/*
 * The tool library HTTP MCP servers' own sign-in (`src/server/oauth/mcp.ts`, MCP's authorization),
 * against a stand-in MCP server and its authorization server (`fake-mcp-auth-server.ts`): discovery (the
 * 401's header, the well-known addresses with the server's path and without, RFC 8414's and OpenID's
 * metadata for an issuer with a path, no PKCE with S256 or no registration refused, another resource's
 * metadata refused, a server that asks for none), registration (a public client with the exact redirect
 * address, again for another one), the sign-in through the shared sign-ins (PKCE, the resource, the
 * scopes, a pasted address), the token a turn's server gets in its headers, refresh (with the resource,
 * rotation, early for a turn), `invalid_grant` and a failing refresh leaving the server out with a note,
 * a sign-in with no refresh token, signing out, removing the server and changing its URL (tokens deleted
 * and revoked), the host rule, and the HTTP API with sign-in on.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_KEY_HEADER } from '../src/shared/auth';
import type { AgentConfig, OAuthSignInView, ToolLibraryView } from '../src/shared/types';
import { fakeMcpAuth, type FakeMcpAuth } from './fake-mcp-auth-server';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-mcp-oauth-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { AuthStore, CODE_TTL_MS } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { withLang } = await import('../src/server/i18n');
const { McpOAuth, canonicalResource, discoverMcpAuth, parseWwwAuthenticate, authServerMetadataUrls } =
  await import('../src/server/oauth/mcp');
const { SignIns, callbackParams } = await import('../src/server/oauth/signin');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { ToolLibrary } = await import('../src/server/tools');

/** A fake credential store, as the tests of the other secrets use. */
function fakeKeyring() {
  const values = new Map<string, string>();
  return {
    storage: 'keychain' as const,
    values,
    get: (n: string) => values.get(n) ?? null,
    set: (n: string, v: string) => void values.set(n, v),
    delete: (n: string) => void values.delete(n),
  };
}

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 18, 8, 0);
const agent: Pick<AgentConfig, 'tools' | 'provider'> = { provider: 'claude' };
const en = <T>(fn: () => Promise<T>) => withLang('en', fn);

let fake: FakeMcpAuth;
let now = T0;
let db: ReturnType<typeof openDatabase>;
let keyring: ReturnType<typeof fakeKeyring>;
let tools: InstanceType<typeof ToolLibrary>;
let signIns: InstanceType<typeof SignIns>;
let mcp: InstanceType<typeof McpOAuth>;

beforeEach(async () => {
  fake = await fakeMcpAuth();
  now = T0;
  db = openDatabase(':memory:');
  keyring = fakeKeyring();
  tools = new ToolLibrary(db, keyring);
  signIns = new SignIns(() => now);
  mcp = new McpOAuth(tools, signIns, () => now);
  tools.saveServer('linear', { transport: 'http', url: fake.mcpUrl, headers: [{ name: 'X-Team', value: 'core' }] });
});
afterEach(async () => {
  await mcp.settled();
  await fake.close();
});

const serverId = (name = 'linear') => tools.view().mcpServers.find((s) => s.name === name)!.id;
const tokenForms = () => fake.requests.filter((r) => r.path === '/tenant/token').map((r) => new URLSearchParams(r.body));

/** A sign-in of the server, all the way, as the browser that started it would do it. */
async function signIn(name = 'linear', origin = 'http://127.0.0.1:8787'): Promise<OAuthSignInView> {
  const started = await mcp.startSignIn({ name, session: 's1', origin, port: 8787 });
  return signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)));
}

describe('discovery', () => {
  it("reads where the server signs in from its 401's header, and its authorization server's RFC 8414 metadata under the issuer's path", async () => {
    const found = await discoverMcpAuth(fake.mcpUrl);
    expect(found).toEqual({
      resource: fake.mcpUrl,
      scopes: ['mcp:tools', 'mcp:read'],
      issuer: fake.issuer,
      authorize: `${fake.issuer}/authorize`,
      token: `${fake.issuer}/token`,
      revoke: `${fake.issuer}/revoke`,
      registration: `${fake.issuer}/register`,
    });
    const asked = fake.requests.map((r) => `${r.method} ${r.path}`);
    expect(asked).toEqual([
      'POST /mcp',
      'GET /.well-known/oauth-protected-resource/mcp',
      'GET /.well-known/oauth-authorization-server/tenant',
    ]);
    // The probe is an `initialize`, as a CLI's first request, without a token.
    expect(JSON.parse(fake.requests[0]!.body)).toMatchObject({ method: 'initialize' });
    expect(fake.requests[0]!.bearer).toBeUndefined();
  });

  it("without the header's address: the well-known address with the server's path, then without it", async () => {
    fake.header = 'bare';
    expect((await discoverMcpAuth(fake.mcpUrl))?.issuer).toBe(fake.issuer);
    fake.requests.length = 0;
    fake.resourceMetadataAt = 'root';
    expect((await discoverMcpAuth(fake.mcpUrl))?.issuer).toBe(fake.issuer);
    expect(fake.requests.map((r) => r.path)).toEqual([
      '/mcp',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server/tenant',
    ]);
  });

  it("falls back to OpenID's metadata, with the issuer's path inserted and then appended", async () => {
    fake.metadataAt = 'openid';
    expect((await discoverMcpAuth(fake.mcpUrl))?.token).toBe(`${fake.issuer}/token`);
    fake.metadataAt = 'openid-appended';
    fake.requests.length = 0;
    expect((await discoverMcpAuth(fake.mcpUrl))?.token).toBe(`${fake.issuer}/token`);
    expect(fake.requests.map((r) => r.path).slice(2)).toEqual([
      '/.well-known/oauth-authorization-server/tenant',
      '/.well-known/openid-configuration/tenant',
      '/tenant/.well-known/openid-configuration',
    ]);
    expect(authServerMetadataUrls(new URL('https://auth.example.com/'))).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ]);
  });

  it("asks for the challenge's scope when it names one, else the metadata's, else none", async () => {
    fake.challengeScope = 'mcp:tools';
    expect((await discoverMcpAuth(fake.mcpUrl))?.scopes).toEqual(['mcp:tools']);
    delete fake.challengeScope;
    fake.scopes = [];
    expect((await discoverMcpAuth(fake.mcpUrl))?.scopes).toEqual([]);
  });

  it('refuses an authorization server without PKCE S256, or without registration, and metadata for another resource', async () => {
    await en(async () => {
      fake.pkce = false;
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('does not support PKCE with S256');
      fake.pkce = true;
      fake.registration = false;
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('needs a client registered by hand');
      fake.registration = true;
      fake.resource = 'https://elsewhere.example/mcp';
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('its metadata is for another resource');
      // One for the server's origin covers it: its tokens are for that resource.
      fake.resource = fake.url;
      expect((await discoverMcpAuth(fake.mcpUrl))?.resource).toBe(fake.url);
      // Sent as the metadata names it, which its authorization server knows it by.
      fake.resource = `${fake.url}/`;
      expect((await discoverMcpAuth(fake.mcpUrl))?.resource).toBe(`${fake.url}/`);
      fake.metadataAt = 'none';
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('publishes no metadata');
      fake.resourceMetadataAt = 'none';
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('its protected resource metadata');
      fake.header = 'bare';
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('does not say where');
    });
  });

  it('finds no sign-in for a server that answers without one, and never goes over plain HTTP to another computer', async () => {
    fake.open = true;
    fake.resourceMetadataAt = 'none';
    expect(await discoverMcpAuth(fake.mcpUrl)).toBeUndefined();
    await en(async () => {
      await expect(discoverMcpAuth('http://mcp.example.com/mcp')).rejects.toThrow('is not HTTPS');
    });
  });

  it('reads the challenge and the canonical URL as the spec writes them', () => {
    expect(parseWwwAuthenticate('Bearer realm="x", resource_metadata="https://a.example/.well-known/r", scope="a b"')).toEqual({
      bearer: true,
      resourceMetadata: 'https://a.example/.well-known/r',
      scope: 'a b',
    });
    expect(parseWwwAuthenticate('Basic realm="x"')).toEqual({ bearer: false });
    expect(parseWwwAuthenticate(null)).toEqual({ bearer: false });
    expect(canonicalResource('HTTPS://MCP.Example.com:443/mcp/#x')).toBe('https://mcp.example.com/mcp');
    expect(canonicalResource('https://mcp.example.com/')).toBe('https://mcp.example.com');
    expect(canonicalResource('http://127.0.0.1:8080/a/mcp')).toBe('http://127.0.0.1:8080/a/mcp');
  });
});

describe('signing in', () => {
  it('registers a public client with the exact redirect address, signs in with PKCE and the resource, and keeps no token where the page sees it', async () => {
    const started = await mcp.startSignIn({ name: 'linear', session: 's1', origin: 'http://127.0.0.1:8787', port: 8787 });
    expect(started).toMatchObject({ provider: 'mcp', server: { name: 'linear' }, status: 'waiting' });
    expect(fake.clients).toHaveLength(1);
    expect(fake.clients[0]!.body).toEqual({
      client_name: 'Harness Relay',
      redirect_uris: ['http://127.0.0.1:8787/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:tools mcp:read',
    });
    const q = new URL(started.authorizeUrl!).searchParams;
    expect(q.get('client_id')).toBe('client-1');
    expect(q.get('resource')).toBe(fake.mcpUrl);
    expect(q.get('scope')).toBe('mcp:tools mcp:read');
    expect(q.get('code_challenge_method')).toBe('S256');

    const done = await signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)));
    expect(done).toMatchObject({ status: 'done', provider: 'mcp', server: { id: serverId(), name: 'linear' } });
    expect(done.account).toBeUndefined();
    // The code went with its verifier and the resource again.
    const exchange = tokenForms().find((f) => f.get('grant_type') === 'authorization_code')!;
    expect(exchange.get('resource')).toBe(fake.mcpUrl);
    expect(exchange.get('code_verifier')).toBeTruthy();

    const view = tools.view().mcpServers[0]!;
    expect(view.oauth).toEqual({ status: 'signed-in', signedInAt: T0 });
    expect(JSON.stringify(tools.view())).not.toMatch(/mcp-access-|mcp-refresh-/);
    // The refresh token is in the credential store, by a name no server's own entry has.
    const entry = JSON.parse(keyring.values.get(`mcp-oauth.${serverId()}`)!) as { refresh: string };
    expect(fake.refreshTokens.get(entry.refresh)).toBe(true);
    expect(keyring.values.get(`mcp-${serverId()}`)).toContain('X-Team');
  });

  it('registers again only when a sign-in needs a redirect address the kept client lacks', async () => {
    await signIn();
    await signIn();
    expect(fake.clients).toHaveLength(1);
    const other = await signIn('linear', 'http://localhost:5173');
    expect(other.status).toBe('done');
    expect(fake.clients).toHaveLength(2);
    expect(fake.clients[1]!.body.redirect_uris).toEqual(['http://localhost:5173/oauth/callback', 'http://127.0.0.1:8787/oauth/callback']);
    // The new client is kept: the first page's address is among its own.
    await signIn();
    expect(fake.clients).toHaveLength(2);
  });

  it('signs in from a browser on another computer by its pasted address, its client registered for localhost', async () => {
    const started = await mcp.startSignIn({ name: 'linear', session: 's1', origin: 'https://relay-8787.app.github.dev', port: 8787 });
    expect(started.redirectUri).toBe('http://localhost:8787/oauth/callback');
    expect(fake.clients[0]!.body.redirect_uris).toEqual(['http://localhost:8787/oauth/callback']);
    const address = fake.allow(started.authorizeUrl!);
    // Only the browser that started it pastes it.
    await expect(signIns.pasted(started.id, address, 's2')).rejects.toMatchObject({ status: 404 });
    expect(await signIns.pasted(started.id, address, 's1')).toMatchObject({ status: 'done', server: { name: 'linear' } });
    expect(tools.view().mcpServers[0]!.oauth?.status).toBe('signed-in');
  });

  it('sends a client secret the authorization server gave as it says: Basic, or in the form', async () => {
    fake.clientSecret = 'client_secret_basic';
    await signIn();
    expect(fake.requests.find((r) => r.path === '/tenant/token')!.basic).toBeTruthy();
    fake.clientSecret = 'client_secret_post';
    await signIn('linear', 'http://localhost:5173');
    const last = fake.requests.filter((r) => r.path === '/tenant/token').pop()!;
    expect(last.basic).toBeUndefined();
    expect(new URLSearchParams(last.body).get('client_secret')).toBe(fake.clients[1]!.secret);
  });

  it('refuses a server that asks for none, one that is not HTTP, and keeps nothing of a server removed or changed meanwhile', async () => {
    await en(async () => {
      fake.open = true;
      fake.resourceMetadataAt = 'none';
      await expect(mcp.startSignIn({ name: 'linear', port: 8787 })).rejects.toMatchObject({ status: 409, code: 'mcp-no-sign-in' });
      fake.open = false;
      fake.resourceMetadataAt = 'path';
      tools.saveServer('local', { transport: 'stdio', command: 'npx', args: [] });
      await expect(mcp.startSignIn({ name: 'local', port: 8787 })).rejects.toMatchObject({ status: 400 });
      await expect(mcp.startSignIn({ name: 'nope', port: 8787 })).rejects.toMatchObject({ status: 404 });

      const started = await mcp.startSignIn({ name: 'linear', port: 8787 });
      tools.saveServer('linear', { transport: 'http', url: `${fake.url}/other`, previousName: 'linear' });
      // Its sign-in under way ended with the URL it started for.
      await expect(signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)))).rejects.toMatchObject({ status: 404 });
      expect(tools.view().mcpServers[0]!.oauth).toBeUndefined();
    });
  });
});

describe('the token a turn gets', () => {
  it("is put in the server's Authorization header, in place of one typed by hand; a server not signed in goes as it is", async () => {
    tools.saveServer('linear', {
      transport: 'http',
      url: fake.mcpUrl,
      headers: [{ name: 'authorization', value: 'Bearer typed-by-hand' }],
      previousName: 'linear',
    });
    tools.saveServer('docs', {
      transport: 'http',
      url: 'https://docs.example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer own' }],
    });
    await signIn();
    const given = await mcp.forTurn(tools.forAgent(agent));
    const linear = given.mcpServers.find((s) => s.name === 'linear')!;
    expect(Object.keys(linear.headers)).toEqual(['Authorization']);
    expect(linear.headers.Authorization).toMatch(/^Bearer mcp-access-/);
    expect(fake.accessTokens.get(linear.headers.Authorization!.slice(7))).toBe(true);
    expect(given.mcpServers.find((s) => s.name === 'docs')!.headers).toEqual({ Authorization: 'Bearer own' });
    expect(given.leftOut).toBeUndefined();
    // The stand-in takes it.
    const res = await fetch(fake.mcpUrl, { method: 'POST', headers: { authorization: linear.headers.Authorization! }, body: '{}' });
    expect(res.status).toBe(200);
  });

  it('is renewed with the resource, keeping a rotated refresh token, when it has less than ten minutes left', async () => {
    await signIn();
    const first = (await mcp.forTurn(tools.forAgent(agent))).mcpServers[0]!.headers.Authorization;
    now += 45 * MIN;
    expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers[0]!.headers.Authorization).toBe(first);
    now += 6 * MIN;
    const renewed = (await mcp.forTurn(tools.forAgent(agent))).mcpServers[0]!.headers.Authorization;
    expect(renewed).not.toBe(first);
    const refresh = tokenForms().find((f) => f.get('grant_type') === 'refresh_token')!;
    expect(refresh.get('resource')).toBe(fake.mcpUrl);
    expect(refresh.get('client_id')).toBe('client-1');
    const kept = (JSON.parse(keyring.values.get(`mcp-oauth.${serverId()}`)!) as { refresh: string }).refresh;
    expect(kept).not.toBe(refresh.get('refresh_token'));
    expect(fake.refreshTokens.get(kept)).toBe(true);
  });

  it('leaves the server out, with a note, when its refresh is refused (invalid_grant), and Settings says it needs a new sign-in', async () => {
    await signIn();
    now += 2 * 60 * MIN;
    fake.refreshAnswer = { status: 400, body: { error: 'invalid_grant', error_description: 'revoked' } };
    const given = await en(() => mcp.forTurn(tools.forAgent(agent)));
    expect(given.mcpServers).toEqual([]);
    expect(given.leftOut).toEqual([
      {
        name: 'linear',
        reason: 'reauth',
        note: 'The MCP server "linear" was left out of this turn: its sign-in no longer works (invalid_grant: revoked). Sign in to it again in Settings → Tool library.',
      },
    ]);
    expect(tools.view().mcpServers[0]!.oauth).toMatchObject({ status: 'reauth', error: 'invalid_grant: revoked' });
    // Signed in again, it is given again.
    delete fake.refreshAnswer;
    await signIn();
    expect(tools.view().mcpServers[0]!.oauth?.status).toBe('signed-in');
    expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers).toHaveLength(1);
  });

  it('leaves it out for the turn when the refresh fails otherwise, without asking for a new sign-in', async () => {
    await signIn();
    now += 2 * 60 * MIN;
    fake.refreshAnswer = { status: 503, body: { error: 'temporarily_unavailable' } };
    const given = await en(() => mcp.forTurn(tools.forAgent(agent)));
    expect(given.leftOut).toEqual([
      {
        name: 'linear',
        reason: 'failed',
        note: 'The MCP server "linear" was left out of this turn: The sign-in of MCP server "linear" could not be renewed: temporarily_unavailable',
      },
    ]);
    expect(tools.view().mcpServers[0]!.oauth?.status).toBe('signed-in');
  });

  it('lasts as long as its access token when the sign-in brought no refresh token', async () => {
    fake.noRefresh = true;
    await signIn();
    expect(keyring.values.has(`mcp-oauth.${serverId()}`)).toBe(false);
    expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers).toHaveLength(1);
    // Given for what it has left, then no more.
    now += 55 * MIN;
    expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers).toHaveLength(1);
    now += 4 * MIN;
    const given = await en(() => mcp.forTurn(tools.forAgent(agent)));
    expect(given.leftOut?.[0]?.reason).toBe('reauth');
    expect(tools.view().mcpServers[0]!.oauth?.error).toMatch(/no refresh token/);
    expect(tokenForms().filter((f) => f.get('grant_type') === 'refresh_token')).toEqual([]);
  });

  it('goes only to the host the server signed in at, and over HTTPS or to this computer', async () => {
    await signIn();
    const signed = tools.mcpServerById(serverId())!.oauth!;
    // As if another host were kept for it: the URL's host is not the one its token is for.
    tools.mcpSignedIn(serverId(), { ...signed, host: 'elsewhere.example' }, tools.mcpOAuthSecrets(serverId()));
    const given = await en(() => mcp.forTurn(tools.forAgent(agent)));
    expect(given.mcpServers).toEqual([]);
    expect(given.leftOut?.[0]?.note).toContain(`is not sent to "${fake.host}"`);
  });
});

describe('signing out and removing', () => {
  it('signs out: its tokens deleted, revoked with its client, and no Authorization header any more', async () => {
    await signIn();
    const refresh = (JSON.parse(keyring.values.get(`mcp-oauth.${serverId()}`)!) as { refresh: string }).refresh;
    await mcp.signOut('linear');
    expect(fake.revoked).toEqual([{ token: refresh, hint: 'refresh_token', clientId: 'client-1' }]);
    expect(keyring.values.has(`mcp-oauth.${serverId()}`)).toBe(false);
    expect(tools.view().mcpServers[0]!.oauth).toBeUndefined();
    const given = await mcp.forTurn(tools.forAgent(agent));
    expect(given.mcpServers[0]!.headers).toEqual({ 'X-Team': 'core' });
    // Its other values stay.
    expect(keyring.values.get(`mcp-${serverId()}`)).toContain('X-Team');
  });

  it('removing the server, or changing its URL, deletes and revokes its tokens; renaming keeps them', async () => {
    await signIn();
    tools.saveServer('linear-2', { transport: 'http', url: `${fake.mcpUrl}/`, headers: [], previousName: 'linear' });
    expect(tools.view().mcpServers[0]!.oauth?.status).toBe('signed-in');
    const id = serverId('linear-2');
    tools.saveServer('linear-2', { transport: 'http', url: `${fake.url}/v2/mcp`, headers: [], previousName: 'linear-2' });
    await mcp.settled();
    expect(fake.revoked).toHaveLength(1);
    expect(keyring.values.has(`mcp-oauth.${id}`)).toBe(false);
    expect(tools.view().mcpServers[0]!.oauth).toBeUndefined();

    tools.saveServer('linear-2', { transport: 'http', url: fake.mcpUrl, headers: [], previousName: 'linear-2' });
    await signIn('linear-2');
    tools.deleteServer('linear-2');
    await mcp.settled();
    expect(fake.revoked).toHaveLength(2);
    expect([...keyring.values.keys()].filter((k) => k.startsWith('mcp-oauth.'))).toEqual([]);
  });

  it('keeps its sign-in over a restart, without a credential store too, and refreshes then', async () => {
    const plain = openDatabase(':memory:');
    const library = new ToolLibrary(plain);
    library.saveServer('linear', { transport: 'http', url: fake.mcpUrl, headers: [] });
    const ins = new SignIns(() => now);
    const first = new McpOAuth(library, ins, () => now);
    const started = await first.startSignIn({ name: 'linear', port: 8787 });
    await ins.callback(callbackParams(fake.allow(started.authorizeUrl!)));
    // Started again: the access token is gone with the process, the refresh token is not.
    const again = new ToolLibrary(plain);
    const restarted = new McpOAuth(again, new SignIns(() => now), () => now);
    const given = await restarted.forTurn(again.forAgent(agent));
    expect(given.mcpServers[0]!.headers.Authorization).toMatch(/^Bearer mcp-access-/);
    expect(tokenForms().filter((f) => f.get('grant_type') === 'refresh_token')).toHaveLength(1);
  });
});

describe('/api/tools/mcp/:name/signin', () => {
  /** The server's app, signed in as a browser: `call()` with its cookie and key, `HOST` alone signed out. */
  async function signedInApp() {
    // On the database the library of `beforeEach` saved its server to.
    const settings = new SettingsStore(db, keyring);
    const store = new Store(db);
    const hub = new Hub();
    const auth = new AuthStore(db);
    const app = createApp({
      auth,
      store,
      settings,
      hub,
      orchestrator: new Orchestrator(store, hub, settings),
      providers: new ProviderService(settings),
    });
    const HOST = { host: '127.0.0.1:8787', 'x-relay-lang': 'en' };
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ code: auth.createCode(CODE_TTL_MS.device).code }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const signedIn = { ...HOST, cookie, [AUTH_KEY_HEADER]: ((await res.json()) as { key: string }).key };
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = signedIn) =>
      app.request(path, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    return { call, HOST, settings };
  }

  it('starts, follows and finishes a sign-in for a signed-in browser, says the state in the library, and signs out', async () => {
    const { call, HOST, settings } = await signedInApp();
    // Signed out: refused, as every route but the callback.
    expect((await call('POST', '/api/tools/mcp/linear/signin', { origin: 'http://localhost:5173' }, HOST)).status).toBe(401);
    expect((await call('DELETE', '/api/tools/mcp/linear/signin', {}, HOST)).status).toBe(401);

    const started = (await (
      await call('POST', '/api/tools/mcp/linear/signin', { origin: 'http://localhost:5173' })
    ).json()) as OAuthSignInView;
    expect(started).toMatchObject({ provider: 'mcp', server: { name: 'linear' }, redirectUri: 'http://localhost:5173/oauth/callback' });
    // Followed by the browser that started it only.
    expect((await call('GET', `/api/oauth/signins/${started.id}`)).status).toBe(200);
    // The callback page posts what it got, with no key or cookie: the state is the proof.
    const done = await call('POST', '/api/oauth/callback', callbackParams(fake.allow(started.authorizeUrl!)), HOST);
    expect(await done.json()).toEqual({ status: 'done', provider: 'mcp', server: 'linear' });
    const lib = (await (await call('GET', '/api/tools')).json()) as ToolLibraryView;
    expect(lib.mcpServers[0]!.oauth?.status).toBe('signed-in');
    expect(JSON.stringify(lib)).not.toMatch(/mcp-access-|mcp-refresh-/);
    // A turn's agent gets the token.
    const turn = await settings.mcpOAuth.forTurn(settings.tools.forAgent(agent));
    expect(turn.mcpServers[0]!.headers.Authorization).toMatch(/^Bearer mcp-access-/);

    const out = (await (await call('DELETE', '/api/tools/mcp/linear/signin', {})).json()) as ToolLibraryView;
    expect(out.mcpServers[0]!.oauth).toBeUndefined();
    expect(fake.revoked).toHaveLength(1);
  });

  it('answers a server that asks for none with a 409 that says so, a stdio server with a 400, and no server with a 404', async () => {
    const { call, settings } = await signedInApp();
    fake.open = true;
    fake.resourceMetadataAt = 'none';
    const none = await call('POST', '/api/tools/mcp/linear/signin', { origin: 'http://localhost:5173' });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({
      error: 'The MCP server "linear" asks for no sign-in: it works without one',
      code: 'mcp-no-sign-in',
    });
    fake.open = false;
    fake.resourceMetadataAt = 'path';
    fake.pkce = false;
    const noPkce = await call('POST', '/api/tools/mcp/linear/signin', { origin: 'http://localhost:5173' });
    expect(noPkce.status).toBe(502);
    expect(((await noPkce.json()) as { error: string }).error).toContain('does not support PKCE with S256');
    settings.tools.saveServer('local', { transport: 'stdio', command: 'npx', args: [] });
    expect((await call('POST', '/api/tools/mcp/local/signin', {})).status).toBe(400);
    expect((await call('POST', '/api/tools/mcp/nope/signin', {})).status).toBe(404);
    expect((await call('DELETE', '/api/tools/mcp/nope/signin', {})).status).toBe(404);
  });
});
