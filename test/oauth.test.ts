/*
 * Accounts that sign in with OAuth (`src/server/oauth/`), against a stand-in for Microsoft's sign-in
 * and Graph (`fake-oauth-server.ts`): the authorization code with PKCE and the loopback redirect, the
 * state (once, for its own sign-in, expiring), a pasted address, the device code flow, the token broker
 * (refreshing early and once, rotation, `invalid_grant`, the host rule, no redirects), the calendar
 * tools over Graph, and the HTTP API with sign-in on (the callback is the one route that takes no sign-in).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_KEY_HEADER } from '../src/shared/auth';
import type { ConnectorsView, OAuthSignInView, OAuthView, OutboxItem } from '../src/shared/types';
import { fakeOAuth, type FakeOAuth } from './fake-oauth-server';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-oauth-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { AuthStore, CODE_TTL_MS } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { ConnectorStore } = await import('../src/server/connectors/accounts');
const { graphEvent, graphNewEvent } = await import('../src/server/connectors/graph');
const { connectorTools } = await import('../src/server/connectors/tools');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { withLang } = await import('../src/server/i18n');
const { microsoftProvider, googleProvider } = await import('../src/server/oauth/providers');
const { OAuthService } = await import('../src/server/oauth/service');
const { callbackParams, loopbackOrigin } = await import('../src/server/oauth/signin');
const { OAuthStore } = await import('../src/server/oauth/store');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
type GatewayContext = import('../src/server/gateway').GatewayContext;

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
const T0 = Date.UTC(2026, 0, 5, 8, 0);
const ctx = {
  convId: 'c',
  agentId: 'a',
  agentName: 'Alice',
  messageId: 'm',
  cwd: '/tmp',
  permission: 'edit',
  unattended: false,
} as GatewayContext;

let fake: FakeOAuth;
let now = T0;
let db: ReturnType<typeof openDatabase>;
let keyring: ReturnType<typeof fakeKeyring>;
let connectors: InstanceType<typeof ConnectorStore>;
let service: InstanceType<typeof OAuthService>;

beforeEach(async () => {
  fake = await fakeOAuth();
  now = T0;
  db = openDatabase(':memory:');
  keyring = fakeKeyring();
  connectors = new ConnectorStore(db, keyring);
  const store = new OAuthStore(db, keyring);
  store.saveClient('microsoft', { clientId: fake.clientId });
  service = new OAuthService(store, connectors, {
    provider: (id, client) =>
      id === 'microsoft' ? microsoftProvider(client, { login: fake.url, graph: fake.url }) : googleProvider(client),
    now: () => now,
    pollMs: () => 20,
  });
});
afterEach(() => fake.close());

/** A Microsoft sign-in, all the way, as the browser that started it would do it. */
async function signIn(session = 's1'): Promise<OAuthSignInView> {
  const started = await service.startSignIn({
    provider: 'microsoft',
    uses: ['calendar'],
    session,
    origin: 'http://127.0.0.1:8787',
    port: 8787,
  });
  return service.signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)));
}
const tokenRequests = () => fake.requests.filter((r) => r.path.endsWith('/oauth2/v2.0/token'));

describe('signing in', () => {
  it('asks for an authorization code with PKCE, to the page’s own web app on this computer, and keeps who signed in', async () => {
    const started = await service.startSignIn({
      provider: 'microsoft',
      uses: ['calendar'],
      session: 's1',
      origin: 'http://127.0.0.1:8787',
      port: 8787,
    });
    expect(started).toMatchObject({ provider: 'microsoft', status: 'waiting', redirectUri: 'http://127.0.0.1:8787/oauth/callback' });
    const q = new URL(started.authorizeUrl!).searchParams;
    expect(new URL(started.authorizeUrl!).pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(q.get('client_id')).toBe(fake.clientId);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(q.get('state')).toMatch(/^[\w-]{43}$/);
    expect(q.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['offline_access', `${fake.url}/Calendars.ReadWrite`]));
    expect(q.get('prompt')).toBe('select_account');

    const done = await service.signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)));
    expect(done).toMatchObject({
      status: 'done',
      account: { provider: 'microsoft', email: 'ming@contoso.com', name: 'Ming', status: 'connected' },
    });
    const id = done.account!.id;
    expect(id).toBe('microsoft-ming');
    // The refresh token in the credential store, never with the settings.
    expect(keyring.values.get(`oauth-${id}`)).toMatch(/^refresh-/);
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'oauth'").get() as { value: string };
    expect(row.value).not.toMatch(/refresh-|access-/);
    // Its own calendar, for the calendar tools, reached through it (no password).
    expect(connectors.view().calendar).toEqual([
      {
        id,
        name: 'Outlook · ming@contoso.com',
        url: `${fake.url}/v1.0/me/calendar`,
        username: 'ming@contoso.com',
        address: 'ming@contoso.com',
        oauth: id,
        password: '',
      },
    ]);
    // The page that started it sees how it went; another browser does not.
    expect(service.signIn(started.id, 's1').status).toBe('done');
    expect(() => service.signIn(started.id, 's2')).toThrow(/No such sign-in|找不到/);
    // The same address posted again (a reload, React's StrictMode) answers the same, with no second exchange.
    const exchanges = tokenRequests().length;
    expect((await service.signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)))).status).toBe('done');
    expect(tokenRequests()).toHaveLength(exchanges);

    // Signed in again: the same account (its id at Microsoft), the same calendar.
    expect((await signIn()).account!.id).toBe(id);
    expect(service.view().accounts).toHaveLength(1);
    expect(connectors.view().calendar).toHaveLength(1);
  });

  it('goes back to localhost on this computer for a page elsewhere, whose address is pasted then', async () => {
    expect(loopbackOrigin('https://relay-8787.app.github.dev')).toBeUndefined();
    expect(loopbackOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(loopbackOrigin('http://[::1]:8787')).toBe('http://[::1]:8787');
    const started = await service.startSignIn({
      provider: 'microsoft',
      uses: ['calendar'],
      session: 's1',
      origin: 'https://relay-8787.app.github.dev',
      port: 8787,
    });
    expect(started.redirectUri).toBe('http://localhost:8787/oauth/callback');
    const address = fake.allow(started.authorizeUrl!);
    const other = await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], session: 's1', port: 8787 });
    await withLang('en', async () => {
      // Only the browser that started it, with an address of its own sign-in.
      await expect(service.signIns.pasted(started.id, address, 's2')).rejects.toThrow('No such sign-in');
      await expect(service.signIns.pasted(started.id, 'not an address', 's1')).rejects.toThrow('That is not an address');
      await expect(service.signIns.pasted(other.id, address, 's1')).rejects.toThrow('not from this sign-in');
    });
    expect((await service.signIns.pasted(started.id, address, 's1')).status).toBe('done');
  });

  it('refuses a state it never gave, a code from another sign-in, a refusal, and a sign-in that waited too long', async () => {
    await withLang('en', async () => {
      await expect(service.signIns.callback({ state: 'made-up', code: 'x' })).rejects.toThrow('No such sign-in');
      const a = await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], port: 8787 });
      const b = await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], port: 8787 });
      // A's code with B's state: B's verifier does not fit A's challenge.
      const code = callbackParams(fake.allow(a.authorizeUrl!)).code!;
      const bState = new URL(b.authorizeUrl!).searchParams.get('state')!;
      expect(await service.signIns.callback({ state: bState, code })).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('invalid_grant'),
      });
      // The user said no.
      const c = await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], port: 8787 });
      expect(await service.signIns.callback(callbackParams(fake.allow(c.authorizeUrl!, true)))).toMatchObject({
        status: 'failed',
        error: 'Microsoft did not finish the sign-in: access_denied: The user said no',
      });
      const d = await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], port: 8787 });
      now += 11 * MIN;
      expect(service.signIn(d.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('expired') });
      expect((await service.signIns.callback(callbackParams(fake.allow(d.authorizeUrl!)))).status).toBe('failed');
    });
    expect(service.view().accounts).toEqual([]);
  });

  it('signs in on another device with a code, asking Microsoft until it is typed', async () => {
    const started = await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], session: 's1', port: 8787, device: true });
    expect(started).toMatchObject({ status: 'waiting', device: { userCode: 'UC1', verificationUri: `${fake.url}/devicelogin` } });
    expect(started.authorizeUrl).toBeUndefined();
    await new Promise((r) => setTimeout(r, 60));
    expect(service.signIn(started.id, 's1').status).toBe('waiting');
    fake.typeCode('UC1');
    await vi.waitFor(() => expect(service.signIn(started.id, 's1').status).toBe('done'), { timeout: 5000, interval: 20 });
    expect(service.view().accounts[0]!.email).toBe('ming@contoso.com');
  });

  it('needs an app for the provider first, and keeps a client secret masked', async () => {
    await withLang('en', async () => {
      await expect(service.startSignIn({ provider: 'google', uses: ['calendar'], port: 8787 })).rejects.toThrow(
        'There is no app to sign in to Google with yet',
      );
    });
    service.saveClient('google', { clientId: '123-abc.apps.googleusercontent.com', secret: 'GOCSPX-secret' });
    const google = service.view().clients.find((c) => c.provider === 'google')!;
    expect(google).toEqual({
      provider: 'google',
      clientId: '123-abc.apps.googleusercontent.com',
      builtIn: false,
      secret: '••••',
      device: false,
    });
    expect(keyring.values.get('oauth-client-google')).toBe('GOCSPX-secret');
    const started = await service.startSignIn({ provider: 'google', uses: ['calendar'], port: 8787 });
    const q = new URL(started.authorizeUrl!).searchParams;
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('scope')).toContain('https://www.googleapis.com/auth/calendar');
    // The same app saved again keeps its secret; another app does not get it.
    service.saveClient('google', { clientId: '123-abc.apps.googleusercontent.com' });
    expect(keyring.values.get('oauth-client-google')).toBe('GOCSPX-secret');
    service.saveClient('google', { clientId: '456-def.apps.googleusercontent.com' });
    expect(keyring.values.has('oauth-client-google')).toBe(false);
    // No app of the user's own any more: the secret goes with it.
    service.saveClient('google', { clientId: '123-abc.apps.googleusercontent.com', secret: 'GOCSPX-secret' });
    service.saveClient('google', { clientId: '' });
    expect(keyring.values.has('oauth-client-google')).toBe(false);
  });
});

describe('the token broker', () => {
  it('refreshes shortly before the token expires, once for requests at the same time, and keeps the rotated refresh token', async () => {
    const id = (await signIn()).account!.id;
    const first = keyring.values.get(`oauth-${id}`)!;
    const fetch = service.broker.fetch(id);
    expect((await fetch(`${fake.url}/v1.0/me`)).status).toBe(200);
    const exchanges = tokenRequests().length;
    // Within two minutes of expiring: refreshed, once for both.
    now += 59 * MIN;
    const [a, b] = await Promise.all([fetch(`${fake.url}/v1.0/me`), fetch(`${fake.url}/v1.0/me`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(tokenRequests()).toHaveLength(exchanges + 1);
    const refresh = new URLSearchParams(tokenRequests().at(-1)!.body);
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.get('scope')).toContain('Calendars.ReadWrite');
    expect(keyring.values.get(`oauth-${id}`)).not.toBe(first);
    expect(fake.refreshTokens.get(first)).toBe(false);
  });

  it('marks an account whose refresh is refused as needing a new sign-in, which the calendar tools say', async () => {
    const id = (await signIn()).account!.id;
    fake.refreshTokens.set(keyring.values.get(`oauth-${id}`)!, false);
    now += 61 * MIN;
    await withLang('en', async () => {
      await expect(service.broker.accessToken(id)).rejects.toThrow('The sign-in of ming@contoso.com no longer works');
      expect(service.view().accounts[0]).toMatchObject({ status: 'reauth', error: expect.stringContaining('invalid_grant') });
      expect(service.problem(id)).toMatch(/sign in again/);
      const calendar = connectorTools(connectors, service).find((t) => t.name === 'calendar_events')!;
      expect(calendar.unavailable!()).toMatch(/^The sign-in of ming@contoso.com no longer works/);
    });
    // Signed in again, it works again.
    await signIn();
    expect(service.problem(id)).toBeUndefined();
  });

  it("sends the token only to its provider's hosts, follows no redirect, and refreshes once when the token is refused", async () => {
    const id = (await signIn()).account!.id;
    const fetch = service.broker.fetch(id);
    await withLang('en', async () => {
      await expect(fetch('https://evil.example/steal')).rejects.toThrow('is not sent to "evil.example"');
      await expect(fetch('http://127.0.0.1:1/v1.0/me')).rejects.toThrow('is not sent to "127.0.0.1:1"');
    });
    expect(fake.requests.some((r) => r.path.includes('steal'))).toBe(false);
    const redirected = await fetch(`${fake.url}/v1.0/redirect`);
    expect(redirected.status).toBe(302);
    // The provider refuses the kept token (revoked early): refreshed, and the request sent again.
    const used = fake.requests.at(-1)!.bearer!;
    fake.accessTokens.set(used, false);
    expect((await fetch(`${fake.url}/v1.0/me`)).status).toBe(200);
    expect(fake.requests.at(-1)!.bearer).not.toBe(used);
  });

  it('sends Microsoft tokens only to https, or plain http to a stand-in on this computer', async () => {
    const real = microsoftProvider({ clientId: 'x' });
    expect(real.hosts).toEqual(['graph.microsoft.com']);
    expect(real.endpoints.token).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(real.scopes(['calendar'])).toContain('Calendars.ReadWrite');
    expect(microsoftProvider({ clientId: 'x', tenant: 'contoso.onmicrosoft.com' }).endpoints.authorize).toContain(
      '/contoso.onmicrosoft.com/',
    );
  });
});

describe('calendars through a sign-in', () => {
  it('lists an account’s calendars, adds one by its Graph address only, and removing the account takes its tokens and calendars', async () => {
    const id = (await signIn()).account!.id;
    const found = await service.calendars(id);
    expect(found).toEqual([
      { name: 'Calendar', url: `${fake.url}/v1.0/me/calendars/AAA%3D` },
      { name: 'Team', url: `${fake.url}/v1.0/me/calendars/BBB%2F1` },
    ]);
    service.addCalendar(id, { name: 'Team', url: found[1]!.url });
    expect((await service.calendars(id))[1]!.addedAs).toBe(`${id}-2`);
    await withLang('en', async () => {
      expect(() => service.addCalendar(id, { name: 'Evil', url: 'https://evil.example/cal' })).toThrow('not sent to "evil.example"');
    });
    // A calendar reached through a sign-in never takes a password.
    expect(() => connectors.saveCalendar(id, { name: 'X', url: `${fake.url}/v1.0/me/calendar`, username: 'u', password: 'p' })).toThrow();
    const removed = await service.removeAccount(id);
    expect(removed.permissionsPages).toContain('https://account.live.com/consent/Manage');
    expect(keyring.values.has(`oauth-${id}`)).toBe(false);
    expect(connectors.view().calendar).toEqual([]);
    expect(service.view().accounts).toEqual([]);
  });

  it('gives the calendar tools a Microsoft calendar over Graph: its events across pages, an event added, an invitation', async () => {
    await signIn();
    fake.events.push(
      {
        id: 'e1',
        subject: 'Planning',
        start: { dateTime: '2026-01-05T09:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-01-05T10:00:00.0000000', timeZone: 'UTC' },
        location: { displayName: 'Room 1' },
        attendees: [{ emailAddress: { address: 'bob@contoso.com' } }],
      },
      {
        id: 'e2',
        subject: 'Offsite',
        isAllDay: true,
        start: { dateTime: '2026-01-06T00:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-01-08T00:00:00.0000000', timeZone: 'UTC' },
      },
    );
    const tools = Object.fromEntries(connectorTools(connectors, service).map((t) => [t.name, t]));
    const listed = await tools.calendar_events!.run!({ from: '2026-01-05', to: '2026-01-09' }, ctx);
    expect(listed.text).toContain('- 2026-01-05 09:00 UTC – 2026-01-05 10:00 UTC: Planning');
    expect(listed.text).toContain('  at Room 1');
    expect(listed.text).toContain('  with bob@contoso.com');
    expect(listed.text).toContain('- 2026-01-06 (all day) – 2026-01-07 (all day): Offsite');
    const view = fake.requests.find((r) => r.path.includes('/calendarView'))!;
    expect(view.path).toContain('startDateTime=2026-01-05T00%3A00%3A00Z');

    await tools.calendar_create!.run!(
      { summary: 'Focus', start: '2026-01-07T09:00', end: '2026-01-07T10:30', timeZone: 'Asia/Taipei' },
      ctx,
    );
    expect(fake.created[0]).toEqual({
      subject: 'Focus',
      start: { dateTime: '2026-01-07T01:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-01-07T02:30:00', timeZone: 'UTC' },
      calendar: '/v1.0/me/calendar/events',
    });
    const sent = await tools.calendar_invite!.send!(
      { summary: 'Review', start: '2026-01-08', end: '2026-01-08', attendees: ['bob@contoso.com'], accountId: 'microsoft-ming' },
      {} as OutboxItem,
    );
    expect(sent).toBeTruthy();
    expect(fake.created[1]).toMatchObject({
      subject: 'Review',
      isAllDay: true,
      start: { dateTime: '2026-01-08T00:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-01-09T00:00:00', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'bob@contoso.com' }, type: 'required' }],
    });
  });

  it('reads and writes Graph events as the CalDAV ones read', () => {
    expect(
      graphEvent({
        id: 'x',
        iCalUId: 'ical-x',
        subject: 'S',
        type: 'seriesMaster',
        recurrence: { pattern: { type: 'weekly' } },
        start: { dateTime: '2026-01-05T09:30:00', timeZone: 'Asia/Taipei' },
      }),
    ).toEqual({ uid: 'ical-x', summary: 'S', start: '2026-01-05 09:30 (Asia/Taipei)', repeats: 'weekly', attendees: [] });
    expect(() => graphNewEvent({ summary: 's', start: '2026-01-05', end: '2026-01-05T10:00', timeZone: 'UTC' })).toThrow(
      'must both be dates',
    );
  });
});

describe('/api/oauth', () => {
  it('runs a sign-in for a signed-in browser, and takes the callback from any browser with its state alone', async () => {
    const settings = new SettingsStore(db, keyring);
    // The service the server makes, on Settings' own calendars, with the stand-in's sign-in.
    service = new OAuthService(new OAuthStore(db, keyring), settings.connectors, {
      provider: (_id, client) => microsoftProvider(client, { login: fake.url, graph: fake.url }),
      now: () => now,
    });
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
      oauth: service,
    });
    const HOST = { host: '127.0.0.1:8787' };
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ code: auth.createCode(CODE_TTL_MS.device).code }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const signedIn = { ...HOST, cookie, [AUTH_KEY_HEADER]: ((await res.json()) as { key: string }).key, 'x-relay-lang': 'en' };
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = signedIn) =>
      app.request(path, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    // Signed out: only the callback answers.
    expect((await call('GET', '/api/oauth', undefined, HOST)).status).toBe(401);
    expect((await call('POST', '/api/oauth/signins', { provider: 'microsoft' }, HOST)).status).toBe(401);
    expect((await call('POST', '/api/oauth/callback', { state: 'nope', code: 'x' }, HOST)).status).toBe(404);

    const view = (await (await call('GET', '/api/oauth')).json()) as OAuthView;
    expect(view.clients.find((c) => c.provider === 'microsoft')).toMatchObject({ clientId: fake.clientId, device: true });
    expect((await call('POST', '/api/oauth/signins', { provider: 'yahoo' })).status).toBe(404);
    const started = (await (
      await call('POST', '/api/oauth/signins', { provider: 'microsoft', origin: 'http://localhost:5173' })
    ).json()) as OAuthSignInView;
    expect(started.redirectUri).toBe('http://localhost:5173/oauth/callback');

    // The provider's page sent the browser back: the callback page posts what it got, without a key or cookie.
    const back = callbackParams(fake.allow(started.authorizeUrl!));
    const done = await call('POST', '/api/oauth/callback', back, HOST);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ status: 'done', provider: 'microsoft', email: 'ming@contoso.com' });
    // The page that started it sees it done; its calendar is there for the calendar tools.
    expect(((await (await call('GET', `/api/oauth/signins/${started.id}`)).json()) as OAuthSignInView).status).toBe('done');
    const id = service.view().accounts[0]!.id;
    const list = await call('GET', `/api/oauth/accounts/${id}/calendars`);
    expect(((await list.json()) as unknown[]).length).toBe(2);
    const added = (await (
      await call('POST', `/api/oauth/accounts/${id}/calendars`, { name: 'Team', url: `${fake.url}/v1.0/me/calendars/BBB%2F1` })
    ).json()) as ConnectorsView;
    expect(added.calendar.map((c) => c.name)).toEqual(['Outlook · ming@contoso.com', 'Team']);
    // Test, as for any calendar: through the sign-in.
    expect(await (await call('POST', `/api/connectors/calendar/${id}/test`, {})).json()).toMatchObject({ ok: true });
    // Never a token in what the page gets.
    expect(JSON.stringify(await (await call('GET', '/api/oauth')).json())).not.toMatch(/refresh-|access-/);

    const removed = (await (await call('DELETE', `/api/oauth/accounts/${id}`, {})).json()) as OAuthView & {
      connectors: ConnectorsView;
      permissionsPages: string[];
    };
    expect(removed.accounts).toEqual([]);
    expect(removed.connectors.calendar).toEqual([]);
    expect(removed.permissionsPages.length).toBeGreaterThan(0);

    // Too many callbacks for no sign-in: refused for a while.
    for (let i = 0; i < 20; i++) await call('POST', '/api/oauth/callback', { state: `guess-${i}` }, HOST);
    expect((await call('POST', '/api/oauth/callback', { state: 'one-more' }, HOST)).status).toBe(429);
  });
});
