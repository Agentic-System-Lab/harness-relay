/*
 * The tool library HTTP MCP servers' own sign-in (`src/server/oauth/mcp.ts`, MCP's authorization),
 * against a stand-in MCP server and its authorization server (`fake-mcp-auth-server.ts`): discovery (the
 * 401's header, the well-known addresses with the server's path and without, RFC 8414's and OpenID's
 * metadata for an issuer with a path, no PKCE with S256 or no registration refused, another resource's
 * metadata refused (one above the server's path too), the issuer exactly, a server that asks for none,
 * every way it fails, no redirect followed), a server elsewhere (`net.ts`: only addresses on the
 * internet, checked with a stand-in lookup and pinned, also by the real requests to a name that resolves
 * nowhere; IPv4 carried in IPv6 and site-local addresses; plain http and this computer's ports refused),
 * registration (a public client with the exact redirect address, again for another one, its failures),
 * the sign-in through the shared sign-ins (PKCE, the resource, the scopes, a pasted address, RFC 9207's
 * `iss`, a page off the issuer's origin confirmed first, the mix-up attack against two stand-ins, its
 * failures), the token a turn's server gets in its headers (only to members given it, not to a CLI that
 * takes no HTTP server), refresh (with the resource, rotation, early for a turn by the token's lifetime),
 * `invalid_grant`, `invalid_client` and a failing refresh leaving the server out with a note, a sign-in
 * with no refresh token, signing in again (the old token revoked), signing out, removing the server and
 * changing its URL (tokens deleted and revoked, revocation's failures), the host rule, bounded answers,
 * the waiting limit counting discoveries, and the HTTP API with sign-in on.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveLegacySlackGrant } from '../e2e/support/legacy-slack-grant';
import { APP_SERVERS } from '../src/shared/apps';
import { AUTH_KEY_HEADER } from '../src/shared/auth';
import { OAUTH_LIMITS, type AgentConfig, type OAuthSignInView, type ToolLibraryView } from '../src/shared/types';
import { fakeMcpAuth, type FakeMcpAuth } from './fake-mcp-auth-server';

// A sign-in's state is random: one test makes it known, to post a callback its page was never given for.
vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-mcp-oauth-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { AuthStore, CODE_TTL_MS } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { withLang } = await import('../src/server/i18n');
const { McpOAuth, TURN_EARLY, canonicalResource, discoverMcpAuth, parseWwwAuthenticate, authServerMetadataUrls, signInConfirmation } =
  await import('../src/server/oauth/mcp');
const { checkedAddresses, nearbyAddress, pinnedLookup, pinnedSend } = await import('../src/server/oauth/net');
const { MAX_TOKEN } = await import('../src/server/oauth/broker');
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

it('renews only a persisted Slack grant using its own previous client, PKCE and public-channel scopes', async () => {
  const name = saveLegacySlackGrant(tools);
  tools = new ToolLibrary(db, keyring);
  const remote = new McpOAuth(tools, signIns, () => now, {
    lookup: async () => ['93.184.216.34'],
    send: async (url, r) => {
      expect(url.href).toBe('https://slack.com/api/oauth.v2.user.access');
      const form = new URLSearchParams(r.body);
      expect(form.get('client_id')).toBe('registered-test-client');
      if (form.get('grant_type') === 'refresh_token') return Response.json({ ok: false, error: 'invalid_refresh_token' });
      expect(form.get('code_verifier')).toBeTruthy();
      expect(form.has('client_secret')).toBe(false);
      return Response.json({
        ok: true,
        token_type: 'user',
        access_token: 'stand-in',
        refresh_token: 'stand-in-refresh',
        expires_in: 3600,
      });
    },
  });
  expect(tools.ensureApp('slack')).toBe(name);
  const login = await remote.startSignIn({ name, port: 8787, origin: 'http://127.0.0.1:8787', session: 'slack-test' });
  expect(login.confirm?.host).toBe('slack.com');
  const url = new URL(signIns.confirm(login.id, 'slack-test').authorizeUrl!);
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/oauth/callback');
  expect(url.searchParams.get('scope')).toContain('search:read.public');
  expect(url.searchParams.get('scope')).not.toContain('write');
  expect((await signIns.callback({ code: 'test', state: url.searchParams.get('state')! })).status).toBe('done');
  expect((await remote.forTurn(tools.forAgent(agent))).mcpServers.find((s) => s.name === name)?.headers.Authorization).toBe(
    'Bearer stand-in',
  );
  now += 3600_000;
  expect((await remote.forTurn(tools.forAgent(agent))).mcpServers.some((s) => s.name === name)).toBe(false);
  expect(tools.view().mcpServers.find((s) => s.name === name)?.oauth?.status).toBe('reauth');
  await remote.signOut(name);
  expect(tools.forAgent(agent).mcpServers.some((s) => s.name === name)).toBe(false);
  await expect(remote.startSignIn({ name, port: 8787 })).rejects.toMatchObject({ status: 409 });
});

const serverId = (name = 'linear') => tools.view().mcpServers.find((s) => s.name === name)!.id;
const tokenForms = () => fake.requests.filter((r) => r.path === '/tenant/token').map((r) => new URLSearchParams(r.body));
const refreshOf = (name = 'linear') => (JSON.parse(keyring.values.get(`mcp-oauth.${serverId(name)}`)!) as { refresh: string }).refresh;

/** A promise to hold a stand-in's answer until `release()`. */
function gate() {
  let release!: () => void;
  const until = new Promise<void>((r) => (release = r));
  return { until, release };
}

/**
 * A stand-in lookup for a server elsewhere: these names have these addresses (none for another); every
 * request goes, to the addresses checked for it, on to the stand-in on this computer, as if it were at
 * `https://mcp.example.com`. What each request was pinned to is recorded.
 */
function elsewhere(names: Record<string, string[]>) {
  const sent: { url: string; addresses: readonly string[] | undefined }[] = [];
  const looked: string[] = [];
  const net = {
    lookup: async (host: string) => {
      looked.push(host);
      return names[host] ?? [];
    },
    send: (url: URL, r: Parameters<typeof pinnedSend>[1], addresses: readonly string[] | undefined) => {
      sent.push({ url: url.href, addresses });
      return pinnedSend(new URL(`${url.pathname}${url.search}`, fake.url), r, undefined);
    },
  };
  return { net, sent, looked };
}

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
      // It says how to use the server all the same: a token of the service's own in its headers.
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow(
        /does not let Harness Relay register itself[\s\S]*click Edit and add the HTTP header Authorization with the value Bearer <your token>/,
      );
      fake.registration = true;
      fake.resource = 'https://elsewhere.example/mcp';
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('its metadata is for another resource');
      // One above it on the same origin is another resource too: a token for it would be for the whole origin.
      for (const above of [fake.url, `${fake.url}/`, `${fake.url}/m`]) {
        fake.resource = above;
        await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow(`its metadata is for another resource (${above})`);
      }
      // Below it, with a fragment, or not text: refused as well.
      for (const other of [`${fake.mcpUrl}/v2`, `${fake.mcpUrl}#x`, 42]) {
        fake.resource = other as string;
        await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('its metadata is for another resource');
      }
      // The same canonical URL is the server: sent as the metadata names it, which its authorization server knows it by.
      fake.resource = `${fake.mcpUrl}/`;
      expect((await discoverMcpAuth(fake.mcpUrl))?.resource).toBe(`${fake.mcpUrl}/`);
      fake.resource = fake.mcpUrl.replace('http://', 'HTTP://');
      expect((await discoverMcpAuth(fake.mcpUrl))?.resource).toBe(fake.mcpUrl.replace('http://', 'HTTP://'));
      // None named: the server's own canonical URL.
      fake.resource = null;
      expect((await discoverMcpAuth(`${fake.mcpUrl}/`))?.resource).toBe(fake.mcpUrl);
      fake.resource = undefined;
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
      resourceMetadata: 'https://a.example/.well-known/r',
      scope: 'a b',
    });
    expect(parseWwwAuthenticate('Bearer error="invalid_token", scope=mcp:tools')).toEqual({ scope: 'mcp:tools' });
    expect(parseWwwAuthenticate('Basic realm="x"')).toEqual({});
    expect(parseWwwAuthenticate(null)).toEqual({});
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

  it('sends a client secret the authorization server gave as it says, Basic or in the form, to sign in, refresh and revoke', async () => {
    const tokenRequests = () => fake.requests.filter((r) => r.path === '/tenant/token');
    fake.clientSecret = 'client_secret_basic';
    expect((await signIn()).status).toBe('done');
    const basic = `client-1:${fake.clients[0]!.secret}`;
    expect(tokenRequests()[0]!.basic).toBe(basic);
    expect(new URLSearchParams(tokenRequests()[0]!.body).get('client_secret')).toBeNull();
    // Kept in the credential store with the refresh token, never with the server.
    expect(JSON.parse(keyring.values.get(`mcp-oauth.${serverId()}`)!)).toMatchObject({ clientSecret: fake.clients[0]!.secret });
    now += 2 * 60 * MIN;
    expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers[0]!.headers.Authorization).toMatch(/^Bearer mcp-access-/);
    expect(tokenRequests().at(-1)!.basic).toBe(basic);
    await mcp.signOut('linear');
    expect(fake.revoked.at(-1)).toMatchObject({ basic, clientId: 'client-1' });

    fake.clientSecret = 'client_secret_post';
    expect((await signIn('linear', 'http://localhost:5173')).status).toBe('done');
    const secret = fake.clients[1]!.secret;
    const exchange = tokenRequests().at(-1)!;
    expect(exchange.basic).toBeUndefined();
    expect(new URLSearchParams(exchange.body).get('client_secret')).toBe(secret);
    now += 2 * 60 * MIN;
    expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers).toHaveLength(1);
    expect(tokenRequests().at(-1)!.basic).toBeUndefined();
    expect(new URLSearchParams(tokenRequests().at(-1)!.body).get('client_secret')).toBe(secret);
    await mcp.signOut('linear');
    const revoke = fake.requests.filter((r) => r.path === '/tenant/revoke').at(-1)!;
    expect(revoke.basic).toBeUndefined();
    expect(new URLSearchParams(revoke.body).get('client_secret')).toBe(secret);
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
    // Marked, for a CLI that keeps a session's servers on disk to take the token out after the turn (Goose).
    expect(linear.signedIn).toBe(true);
    expect(given.mcpServers.find((s) => s.name === 'docs')!.signedIn).toBeUndefined();
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
        note: 'The MCP server "linear" was left out of this turn: its sign-in no longer works (invalid_grant: revoked). Sign in to it again in Settings → Apps and tools → Tool library → MCP servers.',
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
    // Given for what it has left, to its last minute (no margin: it cannot be renewed early), then no more.
    now += 55 * MIN;
    expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers).toHaveLength(1);
    now += 4 * MIN + 30_000;
    expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers).toHaveLength(1);
    now += 30_000;
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

    // Its own host, over plain HTTP to another computer (a URL the library never takes for a sign-in): not given.
    tools.mcpSignedIn(serverId(), { ...signed, host: 'mcp.example.com' }, tools.mcpOAuthSecrets(serverId()));
    (tools.mcpServerById(serverId()) as { url: string }).url = 'http://mcp.example.com/mcp';
    const plain = await en(() => mcp.forTurn(tools.forAgent(agent)));
    expect(plain.mcpServers).toEqual([]);
    expect(plain.leftOut?.[0]).toMatchObject({ reason: 'failed', note: expect.stringContaining('is not sent to "mcp.example.com"') });
    // Over HTTPS to that host, it is.
    (tools.mcpServerById(serverId()) as { url: string }).url = 'https://mcp.example.com/mcp';
    const secure = await mcp.forTurn(tools.forAgent(agent));
    expect(secure.mcpServers[0]!.headers.Authorization).toMatch(/^Bearer mcp-access-/);
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

  it('keeps its sign-in over a restart, with a credential store and without one, and refreshes then', async () => {
    for (const store of [fakeKeyring(), undefined]) {
      const before = tokenForms().filter((f) => f.get('grant_type') === 'refresh_token').length;
      const kept = openDatabase(':memory:');
      const library = new ToolLibrary(kept, store);
      library.saveServer('linear', { transport: 'http', url: fake.mcpUrl, headers: [] });
      const ins = new SignIns(() => now);
      const first = new McpOAuth(library, ins, () => now);
      const started = await first.startSignIn({ name: 'linear', port: 8787 });
      await ins.callback(callbackParams(fake.allow(started.authorizeUrl!)));
      // With a credential store, the refresh token is there and not in the database; without one, in the database.
      const saved = (kept.prepare("SELECT value FROM app_settings WHERE key = 'tool_library'").get() as { value: string }).value;
      expect(saved.includes('mcp-refresh-')).toBe(!store);
      if (store) expect([...store.values.keys()].some((k) => k.startsWith('mcp-oauth.'))).toBe(true);
      // Started again: the access token is gone with the process, the refresh token is not.
      const again = new ToolLibrary(kept, store);
      const restarted = new McpOAuth(again, new SignIns(() => now), () => now);
      const given = await restarted.forTurn(again.forAgent(agent));
      expect(given.mcpServers[0]!.headers.Authorization).toMatch(/^Bearer mcp-access-/);
      expect(tokenForms().filter((f) => f.get('grant_type') === 'refresh_token')).toHaveLength(before + 1);
    }
  });
});

describe('discovery that fails', () => {
  it('says why, at each step: unreachable, unreadable, not JSON, no authorization server, another issuer, no endpoints, not an address', async () => {
    await en(async () => {
      // Nothing listening there.
      const closed = await fakeMcpAuth();
      await closed.close();
      await expect(discoverMcpAuth(closed.mcpUrl)).rejects.toThrow('the server could not be reached');
      // The header's address answers 404, or something else than a JSON object.
      fake.resourceMetadataUrl = `${fake.url}/nowhere`;
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow(
        `its protected resource metadata (${fake.url}/nowhere) could not be read: HTTP 404`,
      );
      fake.resourceMetadataUrl = `${fake.url}/text`;
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('its answer is not a JSON object');
      fake.resourceMetadataUrl = 'not an address';
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('"not an address" is not an address');
      delete fake.resourceMetadataUrl;
      fake.issuer = '';
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('its metadata names no authorization server');
      fake.publishAs(fake.url);
      // Its issuer exactly, a slash at its end included (RFC 8414).
      fake.asMetadata = { issuer: `${fake.issuer}/` };
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow(`names another issuer (${fake.issuer}/)`);
      fake.asMetadata = { token_endpoint: undefined };
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('has no authorization or token endpoint');
      fake.asMetadata = { authorization_endpoint: 'javascript:alert(1)' };
      await expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('is not HTTPS');
    });
  });

  it('never follows a redirect: metadata that answers one is no metadata', async () => {
    fake.metadataRedirect = true;
    await en(() => expect(discoverMcpAuth(fake.mcpUrl)).rejects.toThrow('publishes no metadata'));
    expect(fake.requests.some((r) => r.path.startsWith('/moved'))).toBe(false);
  });

  it('does not use a revocation endpoint it could not reach safely', async () => {
    fake.asMetadata = { revocation_endpoint: 'http://revoke.example.com/revoke' };
    expect((await discoverMcpAuth(fake.mcpUrl))?.revoke).toBeUndefined();
  });
});

describe('a server that is not on this computer', () => {
  beforeEach(() => fake.publishAs('https://mcp.example.com'));

  it('is signed in to through addresses on the internet only, each request going to the addresses checked for it', async () => {
    const { net, sent, looked } = elsewhere({ 'mcp.example.com': ['203.0.113.10', '2001:db8::10'] });
    const found = await discoverMcpAuth('https://mcp.example.com/mcp', net);
    expect(found).toMatchObject({ issuer: 'https://mcp.example.com/tenant', token: 'https://mcp.example.com/tenant/token' });
    expect(sent.map((r) => r.url)).toEqual([
      'https://mcp.example.com/mcp',
      'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
      'https://mcp.example.com/.well-known/oauth-authorization-server/tenant',
    ]);
    // Pinned: each went to the addresses its lookup gave, and was looked up for it.
    expect(sent.every((r) => r.addresses?.join() === '203.0.113.10,2001:db8::10')).toBe(true);
    expect(looked.every((h) => h === 'mcp.example.com')).toBe(true);
  });

  it('refuses one whose name leads to this computer or the local network, before any request', async () => {
    await en(async () => {
      for (const addresses of [
        ['10.0.0.7'],
        ['203.0.113.10', '192.168.1.4'],
        ['127.0.0.1'],
        ['::1'],
        ['fd12::1'],
        ['169.254.169.254'],
        ['::ffff:10.0.0.1'],
        ['0.0.0.0'],
      ]) {
        const { net, sent } = elsewhere({ 'mcp.example.com': addresses });
        await expect(discoverMcpAuth('https://mcp.example.com/mcp', net)).rejects.toThrow(
          'mcp.example.com leads to this computer or the local network',
        );
        expect(sent).toEqual([]);
      }
      // A name with no address.
      await expect(discoverMcpAuth('https://mcp.example.com/mcp', elsewhere({}).net)).rejects.toThrow(
        'the address of mcp.example.com could not be found',
      );
    });
    expect(fake.requests).toEqual([]);
    // Written as addresses, too, without a lookup.
    for (const url of ['https://169.254.169.254/mcp', 'https://[fd00::1]/mcp', 'https://[::ffff:10.0.0.1]/mcp', 'https://10.1.2.3/mcp']) {
      const { net, looked } = elsewhere({});
      await expect(discoverMcpAuth(url, net)).rejects.toThrow();
      expect(looked).toEqual([]);
    }
  });

  it("refuses metadata that sends it to this computer's ports, over plain http or https, or to the local network", async () => {
    await en(async () => {
      const names = { 'mcp.example.com': ['203.0.113.10'], localhost: ['127.0.0.1'], 'auth.intranet.example': ['10.20.30.40'] };
      // Its resource metadata on this computer: plain http, or https to a loopback name or address.
      fake.resourceMetadataUrl = `${fake.url}/.well-known/oauth-protected-resource/mcp`;
      await expect(discoverMcpAuth('https://mcp.example.com/mcp', elsewhere(names).net)).rejects.toThrow('is not HTTPS');
      for (const at of [`https://localhost:${new URL(fake.url).port}/x`, `https://127.0.0.1:${new URL(fake.url).port}/x`]) {
        fake.resourceMetadataUrl = at;
        await expect(discoverMcpAuth('https://mcp.example.com/mcp', elsewhere(names).net)).rejects.toThrow(
          'leads to this computer or the local network',
        );
      }
      delete fake.resourceMetadataUrl;
      // Its token or registration endpoint on the local network: refused before the sign-in page opens.
      fake.asMetadata = { token_endpoint: 'https://auth.intranet.example/token' };
      await expect(discoverMcpAuth('https://mcp.example.com/mcp', elsewhere(names).net)).rejects.toThrow(
        'auth.intranet.example leads to this computer or the local network',
      );
      fake.asMetadata = { registration_endpoint: `https://127.0.0.1:${new URL(fake.url).port}/tenant/register` };
      await expect(discoverMcpAuth('https://mcp.example.com/mcp', elsewhere(names).net)).rejects.toThrow(
        'leads to this computer or the local network',
      );
    });
    // None of those addresses was asked for anything.
    expect(fake.requests.every((r) => !r.path.startsWith('/x') && r.path !== '/tenant/register')).toBe(true);
  });

  it('signs in, refreshes and revokes through the checked addresses only', async () => {
    const { net, sent } = elsewhere({ 'mcp.example.com': ['203.0.113.10'] });
    const remote = new McpOAuth(tools, signIns, () => now, net);
    tools.saveServer('linear', { transport: 'http', url: 'https://mcp.example.com/mcp', headers: [], previousName: 'linear' });
    const started = await remote.startSignIn({ name: 'linear', session: 's1', origin: 'http://127.0.0.1:8787', port: 8787 });
    expect(started.confirm).toBeUndefined();
    expect((await signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)))).status).toBe('done');
    now += 2 * 60 * MIN;
    expect((await remote.forTurn(tools.forAgent(agent))).mcpServers[0]!.headers.Authorization).toMatch(/^Bearer mcp-access-/);
    await remote.signOut('linear');
    await remote.settled();
    const paths = sent.map((r) => new URL(r.url).pathname);
    expect(paths.filter((p) => p === '/tenant/register' || p === '/tenant/token' || p === '/tenant/revoke')).toEqual([
      '/tenant/register',
      '/tenant/token',
      '/tenant/token',
      '/tenant/revoke',
    ]);
    expect(sent.every((r) => r.addresses?.join() === '203.0.113.10')).toBe(true);
    expect(fake.revoked).toHaveLength(1);
  });

  it('pins a connection to the addresses checked, whatever name it asks for', async () => {
    const lookup = pinnedLookup(['203.0.113.10', '2001:db8::10']);
    const ask = (options: object) =>
      new Promise<unknown[]>((resolve) => (lookup as (...a: unknown[]) => void)('evil.example', options, (...a: unknown[]) => resolve(a)));
    expect(await ask({ all: true })).toEqual([
      null,
      [
        { address: '203.0.113.10', family: 4 },
        { address: '2001:db8::10', family: 6 },
      ],
    ]);
    expect(await ask({ family: 6 })).toEqual([null, '2001:db8::10', 6]);
    expect(await ask({})).toEqual([null, '203.0.113.10', 4]);
    expect(((await ask({ family: 6, all: true })) as unknown[])[1]).toEqual([{ address: '2001:db8::10', family: 6 }]);
    const none = await new Promise<unknown[]>((resolve) =>
      (pinnedLookup(['203.0.113.10']) as (...a: unknown[]) => void)('x', { family: 6 }, (...a: unknown[]) => resolve(a)),
    );
    expect((none[0] as { code: string }).code).toBe('ENOTFOUND');
    // What a server elsewhere may not reach, and what it may.
    for (const a of [
      '127.0.0.1',
      '::1',
      '10.0.0.1',
      '172.20.1.1',
      '192.168.0.2',
      '100.64.0.1',
      '169.254.169.254',
      'fe80::1',
      'fd00::1',
      '0.0.0.0',
      '::',
      // An IPv4 address on the local network or this computer, carried in IPv6: compatible, NAT64 (its
      // well-known prefix, and its local-use one), 6to4; and site-local ones.
      '::10.0.0.1',
      '64:ff9b::a00:1',
      '64:ff9b::7f00:1',
      '64:ff9b:1::a00:1',
      '2002:a00:1::',
      '2002:7f00:1::1',
      '2002:a9fe:a9fe::',
      'fec0::1',
    ])
      expect(nearbyAddress(a, []), a).toBe(true);
    for (const a of ['203.0.113.10', '8.8.8.8', '2606:4700::1111', '64:ff9b::cb00:710a', '2002:cb00:710a::1', '::ffff:203.0.113.10'])
      expect(nearbyAddress(a, []), a).toBe(false);
    // This computer's own addresses too.
    expect(nearbyAddress('198.51.100.7', ['198.51.100.7'])).toBe(true);
    await expect(checkedAddresses(new URL('https://198.51.100.7/'), elsewhere({}).net, ['198.51.100.7'])).rejects.toThrow();
  });

  // The real requests (`pinnedSend()`), with no stand-in `send`: to a name that resolves nowhere
  // (`.invalid`, RFC 6761), given the addresses checked for it, a stand-in on this computer's.
  const listening = (server: HttpServer | NetServer) =>
    new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
  const GET = { method: 'GET' as const, headers: {}, timeoutMs: 5000 };

  it('connects to the addresses checked, never to where the name leads, with a connection of its own each time', async () => {
    const connections: number[] = [];
    // What each request asked for, kept here rather than written back into the answer.
    const asked: string[] = [];
    const server = createHttpServer((req, res) => {
      asked.push(`${req.headers.host} ${req.url}`);
      res.end('ok');
    });
    server.on('connection', () => connections.push(Date.now()));
    const port = await listening(server);
    try {
      for (let i = 0; i < 2; i++) {
        const res = await pinnedSend(new URL(`http://mcp.invalid:${port}/mcp`), GET, ['127.0.0.1']);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('ok');
        // The name it was asked for, at the address it was checked for.
        expect(asked[i]).toBe(`mcp.invalid:${port} /mcp`);
        await new Promise((r) => setImmediate(r));
      }
      expect(asked).toHaveLength(2);
      // None kept for the next request, which may have been checked for other addresses.
      expect(connections).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('goes to the addresses checked over https too, asking for the name it was given (SNI)', async () => {
    // No key needed: a plain TCP stand-in reads the TLS ClientHello, then hangs up.
    const hellos: Buffer[] = [];
    const server = createNetServer((socket) =>
      socket.once('data', (chunk: Buffer) => {
        hellos.push(chunk);
        socket.destroy();
      }),
    );
    const port = await listening(server);
    try {
      const err = await pinnedSend(new URL(`https://mcp.invalid:${port}/mcp`), GET, ['127.0.0.1']).then(
        () => undefined,
        (e: NodeJS.ErrnoException) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.code).not.toBe('ENOTFOUND');
      expect(hellos).toHaveLength(1);
      expect(hellos[0]![0]).toBe(0x16); // a TLS handshake
      expect(hellos[0]!.includes('mcp.invalid')).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('the mix-up attack', () => {
  let honest: FakeMcpAuth;
  beforeEach(async () => {
    // An authorization server the user trusts (it says which issuer answers), and a hostile MCP server whose
    // metadata names that server's sign-in page and registration, and its own token endpoint.
    honest = await fakeMcpAuth();
    honest.issParameter = true;
    fake.asMetadata = { authorization_endpoint: `${honest.issuer}/authorize`, registration_endpoint: `${honest.issuer}/register` };
  });
  afterEach(() => honest.close());

  const hostileTokenRequests = () => fake.requests.filter((r) => r.path === '/tenant/token');

  it('shows where the sign-in page is first, gives it only once confirmed, and never sends the code to the hostile token endpoint', async () => {
    const started = await mcp.startSignIn({ name: 'linear', session: 's1', origin: 'http://127.0.0.1:8787', port: 8787 });
    expect(started.confirm).toEqual({ host: honest.host, issuer: fake.host });
    expect(started.authorizeUrl).toBeUndefined();
    expect(honest.clients).toHaveLength(1);
    // Followed, it still waits for the user, and gives no page.
    expect(signIns.get(started.id, 's1')).toMatchObject({ status: 'waiting', confirm: { host: honest.host } });
    expect(signIns.get(started.id, 's1').authorizeUrl).toBeUndefined();
    // Only the browser that started it confirms it.
    expect(() => signIns.confirm(started.id, 's2')).toThrow();
    const confirmed = signIns.confirm(started.id, 's1');
    expect(confirmed.confirm).toBeUndefined();
    expect(new URL(confirmed.authorizeUrl!).origin).toBe(new URL(honest.url).origin);

    // The user signs in at the server they trust, which says it answered (RFC 9207): not this sign-in's issuer.
    const back = honest.allow(confirmed.authorizeUrl!);
    expect(new URL(back).searchParams.get('iss')).toBe(honest.issuer);
    const done = await en(() => signIns.callback(callbackParams(back)));
    expect(done.status).toBe('failed');
    expect(done.error).toContain('another authorization server');
    expect(hostileTokenRequests()).toEqual([]);
    expect(honest.requests.filter((r) => r.path === '/tenant/token')).toEqual([]);
    expect(tools.view().mcpServers[0]!.oauth).toBeUndefined();
  });

  it('refuses a callback for a sign-in whose page the user never confirmed', async () => {
    const state = Buffer.alloc(32, 7);
    vi.mocked(randomBytes).mockImplementationOnce((() => state) as never);
    const started = await mcp.startSignIn({ name: 'linear', session: 's1', port: 8787 });
    expect(started.confirm).toBeDefined();
    const done = await en(() => signIns.callback({ state: state.toString('base64url'), code: 'code-from-elsewhere', iss: fake.issuer }));
    expect(done.status).toBe('failed');
    expect(done.error).toContain('came back before you confirmed it');
    expect(hostileTokenRequests()).toEqual([]);
  });

  it('asks too when only the token endpoint is elsewhere, and needs no confirmation when everything is on the issuer', async () => {
    expect(
      signInConfirmation({ issuer: 'https://a.example/t', authorize: 'https://a.example/t/authorize', token: 'https://a.example/t/token' }),
    ).toBeUndefined();
    expect(
      signInConfirmation({ issuer: 'https://a.example/t', authorize: 'https://a.example/authorize', token: 'https://b.example/token' }),
    ).toEqual({
      host: 'a.example',
      issuer: 'a.example',
      tokenHost: 'b.example',
    });
    // Another port is another origin.
    expect(
      signInConfirmation({ issuer: 'https://a.example', authorize: 'https://a.example:8443/authorize', token: 'https://a.example/token' }),
    ).toEqual({
      host: 'a.example:8443',
      issuer: 'a.example',
    });
  });
});

describe("the redirect's issuer (RFC 9207)", () => {
  it('takes its own issuer, refuses another (pasted too), and refuses none when the metadata says it is always there', async () => {
    fake.issParameter = true;
    expect((await signIn()).status).toBe('done');
    fake.sendIss = 'https://other.example';
    const other = await en(() => signIn());
    expect(other).toMatchObject({ status: 'failed', error: expect.stringContaining('(https://other.example)') });
    const pasted = await mcp.startSignIn({ name: 'linear', session: 's1', origin: 'https://relay.example', port: 8787 });
    expect((await en(() => signIns.pasted(pasted.id, fake.allow(pasted.authorizeUrl!), 's1'))).status).toBe('failed');
    fake.sendIss = null;
    expect((await en(() => signIn())).error).toContain('this one did not');
    expect(tokenForms().filter((f) => f.get('grant_type') === 'authorization_code')).toHaveLength(1);
  });

  it('takes a redirect without it when the metadata does not say it is there, but never another issuer', async () => {
    fake.sendIss = null;
    expect((await signIn()).status).toBe('done');
    fake.sendIss = fake.issuer;
    expect((await signIn()).status).toBe('done');
    fake.sendIss = `${fake.issuer}/`;
    expect((await signIn()).status).toBe('failed');
    fake.sendIss = '';
    expect((await signIn()).status).toBe('failed');
  });
});

describe('sign-ins that fail', () => {
  it('says why: the user refused, the code was refused, a token too long, an answer too large, an error capped', async () => {
    await en(async () => {
      const started = await mcp.startSignIn({ name: 'linear', session: 's1', port: 8787 });
      expect(await signIns.callback(callbackParams(fake.allow(started.authorizeUrl!, true)))).toMatchObject({
        status: 'failed',
        error: 'MCP server "linear" did not finish the sign-in: access_denied',
      });
      fake.codeAnswer = { status: 400, body: { error: 'invalid_grant', error_description: `${'x'.repeat(1000)}\nmore` } };
      const refused = await signIn();
      expect(refused.status).toBe('failed');
      expect(refused.error).toBe(`MCP server "linear" did not finish the sign-in: invalid_grant: ${'x'.repeat(300)}`);
      fake.codeAnswer = { status: 200, body: { access_token: 'a'.repeat(MAX_TOKEN + 1), refresh_token: 'r' } };
      expect((await signIn()).error).toContain(`longer than ${MAX_TOKEN} characters`);
      // An answer over 256 KiB is not read: no token.
      fake.codeAnswer = { status: 200, body: { access_token: 'mcp-access-big', padding: 'p'.repeat(300 * 1024) } };
      expect((await signIn()).error).toBe('MCP server "linear" did not finish the sign-in: HTTP 200');
      fake.codeAnswer = { status: 200, body: 'not json' };
      expect((await signIn()).error).toBe('MCP server "linear" did not finish the sign-in: HTTP 200');
      expect(tools.view().mcpServers[0]!.oauth).toBeUndefined();
    });
  });

  it('keeps nothing of a sign-in whose server was removed while its code was exchanged', async () => {
    const started = await mcp.startSignIn({ name: 'linear', session: 's1', port: 8787 });
    const held = gate();
    fake.hold = { path: '/tenant/token', until: held.until };
    const id = serverId();
    const finishing = signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)));
    await vi.waitFor(() => expect(fake.requests.some((r) => r.path === '/tenant/token')).toBe(true));
    tools.deleteServer('linear');
    held.release();
    expect((await finishing).status).toBe('failed');
    expect(keyring.values.has(`mcp-oauth.${id}`)).toBe(false);
    expect(tools.view().mcpServers).toEqual([]);
  });

  it('says why a registration failed: refused, no client id, not JSON', async () => {
    await en(async () => {
      fake.registrationAnswer = { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'd'.repeat(500) } };
      await expect(mcp.startSignIn({ name: 'linear', port: 8787 })).rejects.toMatchObject({
        status: 502,
        message: `The sign-in of the MCP server "linear" could not start: registering a client at ${fake.issuer} was refused: invalid_redirect_uri: ${'d'.repeat(300)}`,
      });
      fake.registrationAnswer = { status: 201, body: { client_name: 'Harness Relay' } };
      await expect(mcp.startSignIn({ name: 'linear', port: 8787 })).rejects.toThrow('was refused: HTTP 201');
      fake.registrationAnswer = { status: 201, body: { client_id: 'c'.repeat(5000) } };
      await expect(mcp.startSignIn({ name: 'linear', port: 8787 })).rejects.toThrow('was refused: HTTP 201');
      fake.registrationAnswer = { status: 500, body: '<html>down</html>' };
      await expect(mcp.startSignIn({ name: 'linear', port: 8787 })).rejects.toThrow('was refused: HTTP 500');
    });
  });

  it('counts discoveries under way among the sign-ins waiting', async () => {
    const held = gate();
    fake.hold = { path: '/mcp', until: held.until };
    const starting = Array.from({ length: OAUTH_LIMITS.pending }, () => mcp.startSignIn({ name: 'linear', port: 8787 }));
    await vi.waitFor(() => expect(() => signIns.assertRoom()).toThrow());
    await expect(mcp.startSignIn({ name: 'linear', port: 8787 })).rejects.toMatchObject({ status: 429 });
    held.release();
    const started = await Promise.all(starting);
    expect(started.every((v) => v.status === 'waiting')).toBe(true);
    // Its place is given back when discovery fails, too.
    for (const v of started) signIns.cancel(v.id);
    delete fake.hold;
    fake.pkce = false;
    await expect(mcp.startSignIn({ name: 'linear', port: 8787 })).rejects.toMatchObject({ status: 502 });
    expect(() => signIns.assertRoom()).not.toThrow();
  });
});

describe('a turn and the sign-in it replaces', () => {
  it('gives no token to a member the server is not given to, nor to a CLI that takes no HTTP MCP server', async () => {
    tools.saveServer('linear', {
      transport: 'http',
      url: fake.mcpUrl,
      headers: [],
      providers: ['claude', 'antigravity'],
      previousName: 'linear',
    });
    await signIn();
    now += 2 * 60 * MIN;
    fake.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } };
    const before = tokenForms().length;
    const codex = await mcp.forTurn(tools.forAgent({ provider: 'codex' }));
    expect(codex.mcpServers).toEqual([]);
    expect(codex.oauthServers).toBeUndefined();
    const agy = await mcp.forTurn(tools.forAgent({ provider: 'antigravity' }));
    // Its CLI leaves HTTP servers out of its runs: no token, no refresh, no note.
    expect(agy.oauthServers).toBeUndefined();
    expect(agy.leftOut).toBeUndefined();
    expect(agy.mcpServers[0]!.headers.Authorization).toBeUndefined();
    expect(tokenForms()).toHaveLength(before);
    expect(tools.view().mcpServers[0]!.oauth?.status).toBe('signed-in');
  });

  it('renews a token that lasts ten minutes or less once less than half of it is left', async () => {
    expect(TURN_EARLY(60 * MIN)).toBe(10 * MIN);
    expect(TURN_EARLY(10 * MIN)).toBe(5 * MIN);
    fake.expiresIn = 600;
    await signIn();
    const first = (await mcp.forTurn(tools.forAgent(agent))).mcpServers[0]!.headers.Authorization;
    now += 4 * MIN;
    expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers[0]!.headers.Authorization).toBe(first);
    now += 2 * MIN;
    expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers[0]!.headers.Authorization).not.toBe(first);
  });

  it('needs a new sign-in when its client is refused (invalid_client, unauthorized_client), which registers again', async () => {
    for (const error of ['invalid_client', 'unauthorized_client']) {
      await signIn();
      const clientsBefore = fake.clients.length;
      now += 2 * 60 * MIN;
      fake.refreshAnswer = { status: 401, body: { error } };
      const given = await en(() => mcp.forTurn(tools.forAgent(agent)));
      expect(given.leftOut).toEqual([
        {
          name: 'linear',
          reason: 'reauth',
          note: `The MCP server "linear" was left out of this turn: its sign-in no longer works (${error}). Sign in to it again in Settings → Apps and tools → Tool library → MCP servers.`,
        },
      ]);
      expect(tools.view().mcpServers[0]!.oauth).toMatchObject({ status: 'reauth', error });
      delete fake.refreshAnswer;
      // Signed in again: with a client registered again, not the refused one.
      expect((await signIn()).status).toBe('done');
      expect(fake.clients.length).toBe(clientsBefore + 1);
      expect(fake.clients.at(-1)!.body.redirect_uris).toEqual(['http://127.0.0.1:8787/oauth/callback']);
      expect(tools.mcpServerById(serverId())!.oauth!.clientRefused).toBeUndefined();
      expect((await mcp.forTurn(tools.forAgent(agent))).mcpServers).toHaveLength(1);
      // The account kind of refusal is only a refresh that failed: covered in oauth.test.ts.
    }
  });

  it('revokes the refresh token a sign-in again, or one at the same time, replaces', async () => {
    await signIn();
    const first = refreshOf();
    await signIn();
    await mcp.settled();
    expect(fake.revoked).toEqual([{ token: first, hint: 'refresh_token', clientId: 'client-1' }]);
    expect(fake.refreshTokens.get(refreshOf())).toBe(true);
    // Two at the same time: the one that finishes last stays, the other's token is revoked.
    const a = await mcp.startSignIn({ name: 'linear', session: 's1', port: 8787 });
    const b = await mcp.startSignIn({ name: 'linear', session: 's1', port: 8787 });
    const kept = refreshOf();
    await signIns.callback(callbackParams(fake.allow(a.authorizeUrl!)));
    const fromA = refreshOf();
    await signIns.callback(callbackParams(fake.allow(b.authorizeUrl!)));
    await mcp.settled();
    expect(fake.revoked.map((r) => r.token)).toEqual([first, kept, fromA]);
    expect(fake.refreshTokens.get(refreshOf())).toBe(true);
  });
});

describe('revoking that fails', () => {
  it('still signs out when revocation fails, or there is no revocation endpoint, and revokes the access token when there is no refresh token', async () => {
    await signIn();
    fake.revokeStatus = 500;
    await mcp.signOut('linear');
    expect(fake.revoked).toHaveLength(1);
    expect(keyring.values.has(`mcp-oauth.${serverId()}`)).toBe(false);
    fake.revokeStatus = 200;

    fake.noRefresh = true;
    await signIn();
    const access = (await mcp.forTurn(tools.forAgent(agent))).mcpServers[0]!.headers.Authorization!.slice(7);
    await mcp.signOut('linear');
    // Signed out before, it registered again: its new client asks.
    expect(fake.revoked.at(-1)).toEqual({ token: access, hint: 'access_token', clientId: 'client-2' });

    fake.noRefresh = false;
    fake.asMetadata = { revocation_endpoint: null };
    await signIn();
    const count = fake.requests.filter((r) => r.path === '/tenant/revoke').length;
    await mcp.signOut('linear');
    expect(fake.requests.filter((r) => r.path === '/tenant/revoke')).toHaveLength(count);
    expect(tools.view().mcpServers[0]!.oauth).toBeUndefined();

    // Its authorization server gone: signing out does not wait on it.
    fake.asMetadata = {};
    await signIn();
    await fake.close();
    await mcp.signOut('linear');
    expect(tools.view().mcpServers[0]!.oauth).toBeUndefined();
    fake = await fakeMcpAuth();
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

  it('directs fresh Slack sign-ins from either HTTP route to Claude, without creating a grant or a catalog row', async () => {
    const { call, settings } = await signedInApp();
    const before = settings.tools.view().mcpServers;
    const catalog = await call('POST', '/api/apps/slack/signin', {});
    expect(catalog.status).toBe(409);
    expect(await catalog.text()).toContain('Connect Slack in Claude or Codex');
    expect(settings.tools.view().mcpServers).toEqual(before);
    for (const [index, url] of [
      APP_SERVERS.slack,
      APP_SERVERS.slack + '/',
      APP_SERVERS.slack + '?test=1',
      'https://mcp.slack.com./mcp',
    ].entries()) {
      const name = 'saved-slack-' + index;
      expect((await call('PUT', '/api/tools/mcp/' + name, { transport: 'http', url })).status).toBe(200);
      const denied = await call('POST', '/api/tools/mcp/' + name + '/signin', {});
      expect(denied.status).toBe(409);
      expect(await denied.text()).toContain('Connect Slack in Claude or Codex');
      expect(settings.tools.mcpServer(name)?.oauth).toBeUndefined();
    }
  });

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

  it("names the Common apps row of a server Common apps added in the callback's answer, for the page's way back", async () => {
    const { call, HOST, settings } = await signedInApp();
    // Heptabase's row added it (here at the stand-in's address): the callback says which row.
    settings.tools.saveServer('heptabase', { transport: 'http', url: fake.mcpUrl, headers: [] }, 'heptabase');
    const started = (await (
      await call('POST', '/api/tools/mcp/heptabase/signin', { origin: 'http://localhost:5173' })
    ).json()) as OAuthSignInView;
    const done = await call('POST', '/api/oauth/callback', callbackParams(fake.allow(started.authorizeUrl!)), HOST);
    expect(await done.json()).toEqual({ status: 'done', provider: 'mcp', server: 'heptabase', app: 'heptabase' });
  });

  it("confirms a sign-in whose page is elsewhere for the browser that started it only, and refuses a callback's other issuer", async () => {
    const { call, HOST } = await signedInApp();
    const honest = await fakeMcpAuth();
    try {
      fake.asMetadata = { authorization_endpoint: `${honest.issuer}/authorize`, registration_endpoint: `${honest.issuer}/register` };
      const started = (await (
        await call('POST', '/api/tools/mcp/linear/signin', { origin: 'http://localhost:5173' })
      ).json()) as OAuthSignInView;
      expect(started).toMatchObject({ status: 'waiting', confirm: { host: honest.host, issuer: fake.host } });
      expect(started.authorizeUrl).toBeUndefined();
      expect((await call('POST', `/api/oauth/signins/${started.id}/confirm`, {}, HOST)).status).toBe(401);
      const confirmed = (await (await call('POST', `/api/oauth/signins/${started.id}/confirm`, {})).json()) as OAuthSignInView;
      expect(confirmed.confirm).toBeUndefined();
      expect(confirmed.authorizeUrl).toContain(`${honest.issuer}/authorize?`);
      // What the page at /oauth/callback posts, with the issuer the redirect named.
      const back = callbackParams(honest.allow(confirmed.authorizeUrl!));
      const done = await call('POST', '/api/oauth/callback', { ...back, iss: honest.issuer }, HOST);
      expect(await done.json()).toMatchObject({
        status: 'failed',
        provider: 'mcp',
        error: expect.stringContaining('another authorization server'),
      });
      expect(fake.requests.some((r) => r.path === '/tenant/token')).toBe(false);
      expect((await call('POST', '/api/oauth/signins/nope/confirm', {})).status).toBe(404);
    } finally {
      await honest.close();
    }
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
