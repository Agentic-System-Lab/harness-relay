/*
 * Accounts that sign in with OAuth (`src/server/oauth/`), against a stand-in for Microsoft's and
 * Google's sign-ins, Graph and Google's CalDAV (`fake-oauth-server.ts`): the authorization code with
 * PKCE and the loopback redirect, the state (once, for its own sign-in, expiring), a pasted address,
 * the scopes granted, a sign-in cancelled or its app changed before it finished, the device code flow
 * and its answers, the token broker (refreshing early and once, rotation, `invalid_grant` and the
 * other refusals, a refresh coming back after its account was removed or signed in again, the host
 * rule, no redirects), an app that changed, the credential store refusing a token or a client secret,
 * the calendar tools over Graph and over Google's CalDAV with the token, and the HTTP API with sign-in
 * on (the callback is the one route here that takes no sign-in).
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_KEY_HEADER } from '../src/shared/auth';
import type { ConnectorsView, OAuthCalendar, OAuthSignInView, OAuthView, OutboxItem } from '../src/shared/types';
import { fakeOAuth, type FakeOAuth } from './fake-oauth-server';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-oauth-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { AuthStore, CODE_TTL_MS } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { ConnectorStore } = await import('../src/server/connectors/accounts');
const { calendarBackend } = await import('../src/server/connectors/calendar');
const { graphEvent, graphNewEvent } = await import('../src/server/connectors/graph');
const { connectorTools } = await import('../src/server/connectors/tools');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { withLang } = await import('../src/server/i18n');
const { hostOnlyFetch } = await import('../src/server/oauth/broker');
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
/** The waits a device code sign-in asked for between two asks, in seconds. */
let waits: number[];
/** Set once a test is over: its service's clock runs out, so a device sign-in it left waiting stops asking. */
let over: { yes: boolean };

/** The service the tests use, on this test's database, with the stand-in's providers. */
function newService(store = new OAuthStore(db, keyring), on = connectors) {
  const ended = over;
  return new OAuthService(store, on, {
    provider: (id, client) =>
      id === 'microsoft' ? microsoftProvider(client, { login: fake.url, graph: fake.url }) : googleProvider(client, fake.google.urls),
    now: () => (ended.yes ? Number.MAX_SAFE_INTEGER : now),
    pollMs: (interval) => {
      waits.push(interval);
      return 20;
    },
  });
}

beforeEach(async () => {
  fake = await fakeOAuth();
  now = T0;
  waits = [];
  over = { yes: false };
  db = openDatabase(':memory:');
  keyring = fakeKeyring();
  connectors = new ConnectorStore(db, keyring);
  const store = new OAuthStore(db, keyring);
  store.saveClient('microsoft', { clientId: fake.clientId });
  service = newService(store);
});
afterEach(async () => {
  over.yes = true;
  await fake.close();
});

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
const tokenRequests = (path = '/oauth2/v2.0/token') => fake.requests.filter((r) => r.path.endsWith(path));
const grants = (grant: string) => tokenRequests().filter((r) => new URLSearchParams(r.body).get('grant_type') === grant);
/** A promise the test resolves itself, and the resolving. */
function gate(): { until: Promise<void>; open: () => void } {
  let open!: () => void;
  const until = new Promise<void>((r) => (open = r));
  return { until, open };
}

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
    // The provider, the address's name, and a random part: an id is never given again.
    expect(id).toMatch(/^microsoft-ming-[0-9a-f]{6}$/);
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
      expect(service.signIns.knows('made-up')).toBe(false);
      expect(service.signIns.knows(undefined)).toBe(false);
      const a = await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], port: 8787 });
      const b = await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], port: 8787 });
      expect(service.signIns.knows(new URL(a.authorizeUrl!).searchParams.get('state')!)).toBe(true);
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

  it('keeps at most 10 sign-ins waiting at once', async () => {
    for (let i = 0; i < 10; i++) await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], port: 8787 });
    await withLang('en', async () => {
      await expect(service.startSignIn({ provider: 'microsoft', uses: ['calendar'], port: 8787 })).rejects.toMatchObject({
        status: 429,
        message: expect.stringContaining('Too many sign-ins are waiting'),
      });
    });
    // Once they expired, there is room again.
    now += 11 * MIN;
    expect((await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], port: 8787 })).status).toBe('waiting');
  });

  it('keeps no account when the credential store refuses its refresh token', async () => {
    keyring.set = () => {
      throw new Error('The keychain is locked');
    };
    await withLang('en', async () => {
      expect(await signIn()).toMatchObject({
        status: 'failed',
        error: "The sign-in's token could not be saved in the credential store: The keychain is locked",
      });
    });
    expect(service.view().accounts).toEqual([]);
    expect(connectors.view().calendar).toEqual([]);
  });

  it("fails a sign-in whose answer grants no calendar access, and takes Graph's scopes named without their resource", async () => {
    const microsoftKeys = () => [...keyring.values.keys()].filter((k) => k.startsWith('oauth-microsoft'));
    await withLang('en', async () => {
      fake.grantScope = () => 'openid profile email offline_access https://graph.microsoft.com/User.Read';
      expect(await signIn()).toMatchObject({
        status: 'failed',
        error: 'Microsoft did not give access to the calendar: sign in again, and allow access to your calendar on the sign-in page',
      });
      expect(service.view().accounts).toEqual([]);
      expect(microsoftKeys()).toEqual([]);
      expect(connectors.view().calendar).toEqual([]);
      // Microsoft names Graph's scopes in its answer with or without their resource, in any case.
      for (const granted of [
        'openid profile email offline_access User.Read calendars.readwrite',
        'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite offline_access',
      ]) {
        fake.grantScope = () => granted;
        expect((await signIn()).status).toBe('done');
      }
      // No scope in the answer: taken as asked, as before.
      fake.grantScope = () => undefined;
      expect((await signIn()).status).toBe('done');
    });
    expect(service.view().accounts).toHaveLength(1);
    expect(microsoftKeys()).toHaveLength(1);
  });

  it('keeps no account when the sign-in is cancelled while who signed in is asked', async () => {
    await withLang('en', async () => {
      const started = await service.startSignIn({
        provider: 'microsoft',
        uses: ['calendar'],
        session: 's1',
        origin: 'http://127.0.0.1:8787',
        port: 8787,
      });
      const held = gate();
      fake.holdWhoami = held.until;
      const finishing = service.signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)));
      await vi.waitFor(() => expect(fake.requests.some((r) => r.path.startsWith('/v1.0/me?'))).toBe(true), { timeout: 5000, interval: 10 });
      service.signIns.cancel(started.id, 's1');
      held.open();
      fake.holdWhoami = undefined;
      expect(await finishing).toMatchObject({
        status: 'failed',
        error: 'The sign-in was cancelled, or the app it signed in with was changed in Settings',
      });
    });
    expect(service.view().accounts).toEqual([]);
    expect([...keyring.values.keys()].filter((k) => k.startsWith('oauth-microsoft'))).toEqual([]);
    expect(connectors.view().calendar).toEqual([]);
  });

  it('ends the sign-ins of an app that changed, so that none finishes with the app before', async () => {
    const start = () =>
      service.startSignIn({ provider: 'microsoft', uses: ['calendar'], session: 's1', origin: 'http://127.0.0.1:8787', port: 8787 });
    const waitingOne = await start();
    const exchanging = await start();
    service.saveClient('google', { clientId: fake.google.clientId, secret: fake.google.secret });
    const google = await service.startSignIn({ provider: 'google', uses: ['calendar'], session: 's1', port: 8787 });
    // The same app saved again (its tenant blank or `common`, in any case) ends nothing.
    service.saveClient('microsoft', { clientId: fake.clientId, tenant: 'Common' });
    expect(service.signIn(waitingOne.id, 's1').status).toBe('waiting');
    await withLang('en', async () => {
      // One's code is being exchanged when the app changes.
      const held = gate();
      fake.hold = { grant: 'authorization_code', until: held.until };
      const finishing = service.signIns.callback(callbackParams(fake.allow(exchanging.authorizeUrl!)));
      await vi.waitFor(() => expect(grants('authorization_code')).toHaveLength(1), { timeout: 5000, interval: 10 });
      service.saveClient('microsoft', { clientId: fake.clientId, tenant: 'organizations' });
      held.open();
      fake.hold = undefined;
      expect(await finishing).toMatchObject({ status: 'failed', error: expect.stringContaining('was changed in Settings') });
      // The other is gone for the page following it, and its address no longer finishes it.
      expect(() => service.signIn(waitingOne.id, 's1')).toThrow('No such sign-in');
      await expect(service.signIns.callback(callbackParams(fake.allow(waitingOne.authorizeUrl!)))).rejects.toMatchObject({ status: 404 });
    });
    expect(grants('authorization_code')).toHaveLength(1);
    expect(service.view().accounts).toEqual([]);
    expect([...keyring.values.keys()].filter((k) => k.startsWith('oauth-microsoft'))).toEqual([]);
    // Another provider's sign-in goes on.
    expect(service.signIn(google.id, 's1').status).toBe('waiting');
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

  it('marks the accounts of an app that changed as needing a new sign-in, until they sign in with the new one', async () => {
    const id = (await signIn()).account!.id;
    // The same app saved again: nothing to sign in again for; nor for its tenant blank, `common`, or in another case.
    for (const tenant of [undefined, 'common', ' COMMON ']) {
      service.saveClient('microsoft', { clientId: fake.clientId, ...(tenant ? { tenant } : {}) });
      expect(service.view().accounts[0]!.status).toBe('connected');
    }
    await withLang('en', async () => {
      // Another tenant: the tokens were the app's before, under the tenant before.
      service.saveClient('microsoft', { clientId: fake.clientId, tenant: 'contoso.onmicrosoft.com' });
      expect(service.view().accounts[0]).toMatchObject({ status: 'reauth', error: 'the app it signed in with was changed in Settings' });
      expect(service.problem(id)).toBe(
        'The sign-in of ming@contoso.com no longer works: sign in again in Settings → Tool library (the app it signed in with was changed in Settings)',
      );
      // No token of the app before is used: the kept one was forgotten.
      await expect(service.broker.accessToken(id)).rejects.toThrow('no longer works');
    });
    const again = await signIn();
    expect(again.account).toMatchObject({ id, status: 'connected' });
    expect(new URL(tokenRequests().at(-1)!.path, fake.url).pathname).toBe('/contoso.onmicrosoft.com/oauth2/v2.0/token');
    service.saveClient('microsoft', { clientId: fake.clientId, tenant: 'Contoso.OnMicrosoft.com' });
    expect(service.view().accounts[0]!.status).toBe('connected');
    // Another client id too.
    service.saveClient('microsoft', { clientId: 'client-2' });
    expect(service.view().accounts[0]!.status).toBe('reauth');
  });

  it('reads its accounts and apps back from the database, their refresh tokens from the credential store', async () => {
    const id = (await signIn()).account!.id;
    const reloaded = new OAuthStore(db, keyring);
    expect(reloaded.accounts()).toEqual(service.view().accounts);
    expect(reloaded.client('microsoft')).toMatchObject({ clientId: fake.clientId, builtIn: false });
    expect(reloaded.refreshToken(id)).toBe(keyring.values.get(`oauth-${id}`));
    // A server started again knows no access token: its first request refreshes.
    const restarted = newService(reloaded);
    const before = grants('refresh_token').length;
    expect((await restarted.broker.fetch(id)(`${fake.url}/v1.0/me`)).status).toBe(200);
    expect(grants('refresh_token')).toHaveLength(before + 1);
  });
});

describe('signing in on another device', () => {
  const device = () => service.startSignIn({ provider: 'microsoft', uses: ['calendar'], session: 's1', port: 8787, device: true });
  const status = (id: string) => service.signIn(id, 's1');

  it('signs in with a code, asking Microsoft until it is typed', async () => {
    const started = await device();
    expect(started).toMatchObject({ status: 'waiting', device: { userCode: 'UC1', verificationUri: `${fake.url}/devicelogin` } });
    expect(started.authorizeUrl).toBeUndefined();
    await new Promise((r) => setTimeout(r, 60));
    expect(status(started.id).status).toBe('waiting');
    fake.typeCode('UC1');
    await vi.waitFor(() => expect(status(started.id).status).toBe('done'), { timeout: 5000, interval: 20 });
    expect(service.view().accounts[0]!.email).toBe('ming@contoso.com');
  });

  it('waits longer on slow_down, asks again after a server error, and never more often than once a second', async () => {
    fake.deviceInterval = 0;
    fake.deviceAnswers.push({ status: 400, body: { error: 'slow_down' } }, { status: 503, body: { error: 'temporarily_unavailable' } });
    const started = await device();
    await vi.waitFor(() => expect(fake.deviceAnswers).toEqual([]), { timeout: 5000, interval: 20 });
    fake.typeCode('UC1');
    await vi.waitFor(() => expect(status(started.id).status).toBe('done'), { timeout: 5000, interval: 20 });
    // An interval of 0 is one second; slow_down adds five.
    expect(waits[0]).toBe(1);
    expect(waits).toContain(6);
  });

  it('asks again at the next interval when the network fails', async () => {
    fake.drop.push('urn:ietf:params:oauth:grant-type:device_code');
    const started = await device();
    await vi.waitFor(() => expect(fake.drop).toEqual([]), { timeout: 5000, interval: 20 });
    expect(status(started.id).status).toBe('waiting');
    fake.typeCode('UC1');
    await vi.waitFor(() => expect(status(started.id).status).toBe('done'), { timeout: 5000, interval: 20 });
    expect(grants('urn:ietf:params:oauth:grant-type:device_code').length).toBeGreaterThanOrEqual(2);
    expect(service.view().accounts[0]!.email).toBe('ming@contoso.com');
  });

  it('ends a sign-in refused on the other device, or whose code expired', async () => {
    await withLang('en', async () => {
      const denied = await device();
      fake.typeCode('UC1', true);
      await vi.waitFor(() => expect(status(denied.id).status).toBe('failed'), { timeout: 5000, interval: 20 });
      expect(status(denied.id).error).toBe('Microsoft did not finish the sign-in: access_denied: The user declined');
      const expired = await device();
      fake.expireCode('UC2');
      await vi.waitFor(() => expect(status(expired.id).status).toBe('failed'), { timeout: 5000, interval: 20 });
      expect(status(expired.id).error).toContain('expired_token');
      // Its own time over, too.
      const late = await device();
      now += 11 * MIN;
      await vi.waitFor(() => expect(status(late.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('expired') }), {
        timeout: 5000,
        interval: 20,
      });
    });
    expect(service.view().accounts).toEqual([]);
  });

  it('stops asking once cancelled, and keeps nothing a token request in flight then brings', async () => {
    const cancelled = await device();
    service.signIns.cancel(cancelled.id, 's1');
    const asked = grants('urn:ietf:params:oauth:grant-type:device_code').length;
    await new Promise((r) => setTimeout(r, 100));
    expect(grants('urn:ietf:params:oauth:grant-type:device_code').length).toBeLessThanOrEqual(asked + 1);

    const held = gate();
    const before = grants('urn:ietf:params:oauth:grant-type:device_code').length;
    fake.hold = { grant: 'urn:ietf:params:oauth:grant-type:device_code', until: held.until };
    const inFlight = await device();
    fake.typeCode('UC2');
    await vi.waitFor(() => expect(grants('urn:ietf:params:oauth:grant-type:device_code').length).toBeGreaterThan(before), {
      timeout: 5000,
      interval: 10,
    });
    service.signIns.cancel(inFlight.id, 's1');
    held.open();
    fake.hold = undefined;
    await new Promise((r) => setTimeout(r, 100));
    expect(service.view().accounts).toEqual([]);
    expect([...keyring.values.keys()].filter((k) => k.startsWith('oauth-microsoft'))).toEqual([]);
    expect(() => status(inFlight.id)).toThrow(/No such sign-in|找不到/);
  });

  it('says when Microsoft cannot start one, and that Google has none for the calendar', async () => {
    await withLang('en', async () => {
      fake.deviceDown = true;
      await expect(device()).rejects.toMatchObject({ status: 502, message: 'The Microsoft sign-in could not start: HTTP 500' });
      service.saveClient('google', { clientId: fake.google.clientId, secret: fake.google.secret });
      await expect(
        service.startSignIn({ provider: 'google', uses: ['calendar'], session: 's1', port: 8787, device: true }),
      ).rejects.toMatchObject({ status: 400, message: 'Google cannot sign in on another device for these permissions' });
    });
    expect(service.view().clients.find((c) => c.provider === 'google')!.device).toBe(false);
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
      const tools = Object.fromEntries(connectorTools(connectors, service).map((t) => [t.name, t]));
      expect(tools.calendar_events!.unavailable!()).toMatch(/^The sign-in of ming@contoso.com no longer works/);
      // A calendar of it, through the backend the tools and Test use: the same.
      expect(() => calendarBackend(connectors.calendar(id)!.account, '', service)).toThrow('no longer works');
      await expect(tools.calendar_events!.run!({ from: '2026-01-05', to: '2026-01-06' }, ctx)).rejects.toThrow('no longer works');
      await expect(service.calendars(id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('no longer works') });
    });
    // Signed in again, it works again.
    await signIn();
    expect(service.problem(id)).toBeUndefined();
  });

  it('marks consent_required and interaction_required as needing a new sign-in, and not a server error', async () => {
    const id = (await signIn()).account!.id;
    await withLang('en', async () => {
      for (const error of ['consent_required', 'interaction_required']) {
        now += 61 * MIN;
        fake.refreshAnswer = { status: 400, body: { error, error_description: 'AADSTS65001: The user has not consented.\r\nTrace ID: 1' } };
        await expect(service.broker.accessToken(id)).rejects.toThrow(`no longer works: sign in again in Settings → Tool library (${error}`);
        expect(service.view().accounts[0]).toMatchObject({ status: 'reauth', error: `${error}: AADSTS65001: The user has not consented.` });
        fake.refreshAnswer = undefined;
        await signIn();
      }
      // The provider down: the refresh fails this time, and the account stays connected.
      now += 61 * MIN;
      fake.refreshAnswer = { status: 500, body: {} };
      await expect(service.broker.accessToken(id)).rejects.toThrow('The sign-in of ming@contoso.com could not be renewed: HTTP 500');
      expect(service.view().accounts[0]!.status).toBe('connected');
      fake.refreshAnswer = undefined;
    });
    expect(await service.broker.accessToken(id)).toMatch(/^access-/);
  });

  it('writes nothing back from a refresh that comes back after its account was removed', async () => {
    const id = (await signIn()).account!.id;
    now += 59 * MIN;
    const held = gate();
    fake.hold = { grant: 'refresh_token', until: held.until };
    await withLang('en', async () => {
      const before = grants('refresh_token').length;
      const refreshing = service.broker.accessToken(id);
      await vi.waitFor(() => expect(grants('refresh_token')).toHaveLength(before + 1), { timeout: 5000, interval: 10 });
      await service.removeAccount(id);
      expect(keyring.values.has(`oauth-${id}`)).toBe(false);
      // The provider answers now, with a new (rotated) refresh token.
      held.open();
      await expect(refreshing).rejects.toThrow('The account that signed in is not there any more');
    });
    fake.hold = undefined;
    expect(keyring.values.has(`oauth-${id}`)).toBe(false);
    expect(service.view().accounts).toEqual([]);
    // The same account signing in again gets a new id, never the old one.
    expect((await signIn()).account!.id).not.toBe(id);
  });

  it('keeps a new sign-in over a refresh of the one before that comes back refused', async () => {
    const id = (await signIn()).account!.id;
    now += 59 * MIN;
    const held = gate();
    fake.hold = { grant: 'refresh_token', until: held.until };
    const before = grants('refresh_token').length;
    const refreshing = service.broker.accessToken(id);
    await vi.waitFor(() => expect(grants('refresh_token')).toHaveLength(before + 1), { timeout: 5000, interval: 10 });
    // Signed in again meanwhile; the refresh of the sign-in before is then refused.
    const again = await signIn();
    expect(again.account!.id).toBe(id);
    const kept = keyring.values.get(`oauth-${id}`)!;
    fake.refreshAnswer = { status: 400, body: { error: 'invalid_grant' } };
    held.open();
    fake.hold = undefined;
    // The caller gets the new sign-in's token; the account stays connected, with its own refresh token.
    const token = await refreshing;
    expect(fake.accessTokens.get(token)).toBe(true);
    expect(service.view().accounts[0]!.status).toBe('connected');
    expect(keyring.values.get(`oauth-${id}`)).toBe(kept);
  });

  it('gives a refresh of the sign-in before that fails on the network the new sign-in’s token', async () => {
    const id = (await signIn()).account!.id;
    now += 59 * MIN;
    const held = gate();
    fake.hold = { grant: 'refresh_token', until: held.until };
    const before = grants('refresh_token').length;
    const refreshing = service.broker.accessToken(id);
    await vi.waitFor(() => expect(grants('refresh_token')).toHaveLength(before + 1), { timeout: 5000, interval: 10 });
    await signIn();
    const kept = keyring.values.get(`oauth-${id}`)!;
    // The refresh of the sign-in before gets no answer: its connection closes.
    fake.drop.push('refresh_token');
    held.open();
    fake.hold = undefined;
    const token = await refreshing;
    expect(fake.drop).toEqual([]);
    expect(fake.accessTokens.get(token)).toBe(true);
    expect(service.view().accounts[0]!.status).toBe('connected');
    expect(keyring.values.get(`oauth-${id}`)).toBe(kept);
    // Not signed in again, the network failing is said, and the account stays connected.
    now += 59 * MIN;
    fake.drop.push('refresh_token');
    await withLang('en', async () => {
      await expect(service.broker.accessToken(id)).rejects.toThrow('The sign-in of ming@contoso.com could not be renewed');
    });
    expect(service.view().accounts[0]!.status).toBe('connected');
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

  it('sends a token only over https, or plain http to a stand-in on this computer', async () => {
    const token = vi.fn(async () => 'stand-in-token');
    const send = hostOnlyFetch(['example.com', 'localhost:1', fake.host], token);
    await withLang('en', async () => {
      // The right host, but plain http (or another scheme) there: refused before the token is asked for.
      await expect(send('http://example.com/cal')).rejects.toThrow('is not sent to "example.com"');
      await expect(send('ftp://example.com/cal')).rejects.toThrow('is not sent to "example.com"');
      await expect(send('https://example.com.evil.example/cal')).rejects.toThrow('is not sent to "example.com.evil.example"');
      await expect(send('not a url')).rejects.toThrow('is not sent to "not a url"');
    });
    expect(token).not.toHaveBeenCalled();
    // Plain http to this computer: sent, with the token, and its 3xx not followed.
    expect((await send(`${fake.url}/v1.0/redirect`)).status).toBe(401);
    expect(fake.requests.at(-1)!.bearer).toBe('stand-in-token');

    const real = microsoftProvider({ clientId: 'x' });
    expect(real.hosts).toEqual(['graph.microsoft.com']);
    expect(real.endpoints.token).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(real.scopes(['calendar'])).toContain('Calendars.ReadWrite');
    expect(microsoftProvider({ clientId: 'x', tenant: 'contoso.onmicrosoft.com' }).endpoints.authorize).toContain(
      '/contoso.onmicrosoft.com/',
    );
    expect(googleProvider({ clientId: 'x' }).hosts).toEqual(['apidata.googleusercontent.com', 'openidconnect.googleapis.com']);
  });
});

describe('calendars through a sign-in', () => {
  it('lists an account’s calendars (its own as added), adds one by its Graph address only, and removing the account takes its tokens and calendars', async () => {
    const id = (await signIn()).account!.id;
    const found = await service.calendars(id);
    // Its own calendar at the address the sign-in added it as, so not offered again.
    expect(found).toEqual([
      { name: 'Calendar', url: `${fake.url}/v1.0/me/calendar`, addedAs: id },
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
    const id = (await signIn()).account!.id;
    expect(service.via(id).api).toBe('graph');
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
    expect(decodeURIComponent(view.path)).toContain(',originalStartTimeZone,originalEndTimeZone,');

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
      { summary: 'Review', start: '2026-01-08', end: '2026-01-08', attendees: ['bob@contoso.com'], accountId: id },
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

  it('reads and writes Graph events as the CalDAV ones read, an all-day one on its own day', () => {
    expect(
      graphEvent({
        id: 'x',
        iCalUId: 'ical-x',
        subject: 'S',
        start: { dateTime: '2026-01-05T09:30:00', timeZone: 'Asia/Taipei' },
      }),
    ).toEqual({ uid: 'ical-x', summary: 'S', start: '2026-01-05 09:30 (Asia/Taipei)', attendees: [] });
    const allDay = (start: string, end: string) => {
      const e = graphEvent({
        id: 'd',
        isAllDay: true,
        start: { dateTime: start, timeZone: 'UTC' },
        end: { dateTime: end, timeZone: 'UTC' },
      });
      return [e.start, e.end];
    };
    // At midnight: as it is (the end is the day after its last).
    expect(allDay('2026-01-06T00:00:00.0000000', '2026-01-07T00:00:00.0000000')).toEqual(['2026-01-06 (all day)', '2026-01-06 (all day)']);
    // Midnight in Taipei, given in UTC: 16:00 the day before is that next day.
    expect(allDay('2026-01-05T16:00:00.0000000', '2026-01-07T16:00:00.0000000')).toEqual(['2026-01-06 (all day)', '2026-01-07 (all day)']);
    // Midnight in New York: 05:00 the same day.
    expect(allDay('2026-01-06T05:00:00', '2026-01-07T05:00:00')).toEqual(['2026-01-06 (all day)', '2026-01-06 (all day)']);
    // 6 January in New Zealand's summer time (UTC+13), given in UTC: 11:00 the day before. Its own time
    // zone, by its IANA name, places it; by Windows' name (Outlook's), or none, it is rounded, a day early.
    const auckland = (zone?: string) => {
      const e = graphEvent({
        id: 'nz',
        isAllDay: true,
        start: { dateTime: '2026-01-05T11:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-01-06T11:00:00.0000000', timeZone: 'UTC' },
        ...(zone ? { originalStartTimeZone: zone, originalEndTimeZone: zone } : {}),
      });
      return [e.start, e.end];
    };
    expect(auckland('Pacific/Auckland')).toEqual(['2026-01-06 (all day)', '2026-01-06 (all day)']);
    expect(auckland('New Zealand Standard Time')).toEqual(['2026-01-05 (all day)', '2026-01-05 (all day)']);
    expect(auckland()).toEqual(['2026-01-05 (all day)', '2026-01-05 (all day)']);
    // Taipei's, by its IANA name: the same day as rounding gives.
    const taipei = graphEvent({
      id: 't',
      isAllDay: true,
      start: { dateTime: '2026-01-05T16:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-01-06T16:00:00', timeZone: 'UTC' },
      originalStartTimeZone: 'Asia/Taipei',
    });
    expect([taipei.start, taipei.end]).toEqual(['2026-01-06 (all day)', '2026-01-06 (all day)']);
    expect(() => graphNewEvent({ summary: 's', start: '2026-01-05', end: '2026-01-05T10:00', timeZone: 'UTC' })).toThrow(
      'must both be dates',
    );
  });
});

describe('Google Calendar through a sign-in', () => {
  /** A Google sign-in, all the way, with the app's client secret. */
  async function googleSignIn(secret = fake.google.secret): Promise<OAuthSignInView> {
    service.saveClient('google', { clientId: fake.google.clientId, secret });
    const started = await service.startSignIn({
      provider: 'google',
      uses: ['calendar'],
      session: 's1',
      origin: 'http://127.0.0.1:8787',
      port: 8787,
    });
    return service.signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)));
  }
  const primary = () => `${fake.google.urls.caldav}/ming%40gmail.com/events/`;

  it("signs in with the app's client secret, asks who signed in, and adds the primary calendar over CalDAV", async () => {
    expect((await googleSignIn('GOCSPX-wrong')).error).toContain('invalid_client');
    const done = await googleSignIn();
    expect(done).toMatchObject({
      status: 'done',
      account: { provider: 'google', email: 'ming@gmail.com', name: 'Ming', status: 'connected' },
    });
    const exchange = new URLSearchParams(tokenRequests('/google/token').at(-1)!.body);
    expect(exchange.get('client_secret')).toBe(fake.google.secret);
    expect(exchange.get('code_verifier')).toMatch(/^[\w-]{64}$/);
    expect(fake.requests.find((r) => r.path === '/google/userinfo')!.bearer).toMatch(/^access-/);
    const id = done.account!.id;
    expect(id).toMatch(/^google-ming-[0-9a-f]{6}$/);
    expect(keyring.values.get(`oauth-${id}`)).toMatch(/^refresh-/);
    expect(connectors.view().calendar).toEqual([
      {
        id,
        name: 'Google · ming@gmail.com',
        url: primary(),
        username: 'ming@gmail.com',
        address: 'ming@gmail.com',
        oauth: id,
        password: '',
      },
    ]);
    expect(service.via(id).api).toBe('caldav');

    // Its calendars from CalDAV discovery with the token, its own as added; else its primary one.
    const team = `${fake.google.urls.caldav}/team%40group.calendar.google.com/events/`;
    expect(await service.calendars(id)).toEqual<OAuthCalendar[]>([
      { name: 'ming@gmail.com', url: primary(), addedAs: id },
      { name: 'Team', url: team },
    ]);
    fake.google.calendars = 'none';
    expect(await service.calendars(id)).toEqual([{ name: 'ming@gmail.com', url: primary(), addedAs: id }]);
    fake.google.calendars = 'fail';
    expect(await service.calendars(id)).toEqual([{ name: 'ming@gmail.com', url: primary(), addedAs: id }]);
    const dav = fake.requests.filter((r) => r.path.startsWith('/caldav/'));
    expect(dav.length).toBeGreaterThan(0);
    expect(dav.every((r) => r.bearer && fake.accessTokens.get(r.bearer))).toBe(true);
  });

  it('fails a sign-in whose calendar access was unticked on Google’s page, and keeps no account', async () => {
    const googleKeys = () => [...keyring.values.keys()].filter((k) => k.startsWith('oauth-google'));
    // What Google answers when only the sign-in's own scopes were allowed.
    fake.grantScope = () => 'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/userinfo.profile';
    await withLang('en', async () => {
      expect(await googleSignIn()).toMatchObject({
        status: 'failed',
        error: 'Google did not give access to the calendar: sign in again, and allow access to your calendar on the sign-in page',
      });
    });
    expect(service.view().accounts).toEqual([]);
    expect(connectors.view().calendar).toEqual([]);
    expect(googleKeys()).toEqual([]);
    fake.grantScope = () =>
      'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.profile';
    expect((await googleSignIn()).status).toBe('done');
    expect(googleKeys()).toHaveLength(1);
  });

  it("changes nothing when the credential store refuses an app's new client secret", async () => {
    const id = (await googleSignIn()).account!.id;
    keyring.set = () => {
      throw new Error('The keychain is locked');
    };
    await withLang('en', async () => {
      expect(() => service.saveClient('google', { clientId: 'other.apps.googleusercontent.com', secret: 'GOCSPX-other' })).toThrow(
        "The app's client secret could not be saved in the credential store: The keychain is locked",
      );
    });
    // The app before, its secret, and its account as they were.
    expect(service.view().clients.find((c) => c.provider === 'google')).toMatchObject({ clientId: fake.google.clientId, secret: '••••' });
    expect(keyring.values.get('oauth-client-google')).toBe(fake.google.secret);
    expect(new OAuthStore(db, keyring).client('google')).toMatchObject({ clientId: fake.google.clientId });
    expect(service.view().accounts[0]).toMatchObject({ id, status: 'connected' });
  });

  it('gives the calendar tools its events and adds one over CalDAV with the token', async () => {
    await googleSignIn();
    fake.google.events.push(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:g1@google.com\r\nDTSTART:20260105T090000Z\r\nDTEND:20260105T100000Z\r\nSUMMARY:Standup\r\nLOCATION:Room 2\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    );
    const tools = Object.fromEntries(connectorTools(connectors, service).map((t) => [t.name, t]));
    const listed = await tools.calendar_events!.run!({ from: '2026-01-05', to: '2026-01-09' }, ctx);
    expect(listed.text).toContain('2026-01-05 09:00');
    expect(listed.text).toContain(': Standup');
    expect(listed.text).toContain('  at Room 2');
    const report = fake.requests.find((r) => r.method === 'REPORT')!;
    expect(report.path).toBe('/caldav/v2/ming%40gmail.com/events/');
    expect(fake.accessTokens.get(report.bearer!)).toBe(true);

    await tools.calendar_create!.run!(
      { summary: 'Focus', start: '2026-01-07T09:00', end: '2026-01-07T10:30', timeZone: 'Asia/Taipei' },
      ctx,
    );
    expect(fake.google.puts).toHaveLength(1);
    const put = fake.google.puts[0]!;
    expect(put.path).toMatch(/^\/caldav\/v2\/ming%40gmail\.com\/events\/[^/]+\.ics$/);
    expect(fake.accessTokens.get(put.bearer!)).toBe(true);
    expect(put.ics).toContain('SUMMARY:Focus');
    expect(put.ics).toContain('DTSTART:20260107T010000Z');
  });

  it('says the account needs a new sign-in rather than fall back to its primary calendar, and removing it revokes its token', async () => {
    const id = (await googleSignIn()).account!.id;
    now += 61 * MIN;
    fake.refreshAnswer = { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
    await withLang('en', async () => {
      await expect(service.calendars(id)).rejects.toThrow('The sign-in of ming@gmail.com no longer works');
      expect(service.view().accounts[0]).toMatchObject({ status: 'reauth', error: 'invalid_grant: Token has been expired or revoked.' });
      await expect(service.calendars(id)).rejects.toMatchObject({ status: 409 });
    });
    fake.refreshAnswer = undefined;
    // The refresh sent the app's secret too, and asked for no scopes again (Google keeps them).
    const refresh = new URLSearchParams(
      tokenRequests('/google/token')
        .filter((r) => new URLSearchParams(r.body).get('grant_type') === 'refresh_token')
        .at(-1)!.body,
    );
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.get('client_secret')).toBe(fake.google.secret);
    expect(refresh.has('scope')).toBe(false);

    const token = keyring.values.get(`oauth-${id}`)!;
    expect(await service.removeAccount(id)).toEqual({});
    expect(fake.google.revoked).toEqual([token]);
    expect(new URLSearchParams(fake.requests.find((r) => r.path === '/google/revoke')!.body).get('token')).toBe(token);
    expect(keyring.values.has(`oauth-${id}`)).toBe(false);
    expect(connectors.view().calendar).toEqual([]);
  });
});

describe('/api/oauth', () => {
  /** The server's app, signed in as a browser: `call()` with its cookie and key, `HOST` alone signed out. */
  async function signedInApp() {
    const settings = new SettingsStore(db, keyring);
    // The service the server makes, on Settings' own calendars, with the stand-in's sign-in.
    service = newService(new OAuthStore(db, keyring), settings.connectors);
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
    const start = async () =>
      (await (
        await call('POST', '/api/oauth/signins', { provider: 'microsoft', origin: 'http://localhost:5173' })
      ).json()) as OAuthSignInView;
    return { call, HOST, settings, start };
  }
  const error = async (res: Response) => ((await res.json()) as { error: string }).error;

  it('runs a sign-in for a signed-in browser, and takes the callback from any browser with its state alone', async () => {
    const { call, HOST, start } = await signedInApp();

    // Signed out: only the callback answers.
    expect((await call('GET', '/api/oauth', undefined, HOST)).status).toBe(401);
    expect((await call('POST', '/api/oauth/signins', { provider: 'microsoft' }, HOST)).status).toBe(401);
    expect((await call('POST', '/api/oauth/callback', { state: 'nope', code: 'x' }, HOST)).status).toBe(404);

    const view = (await (await call('GET', '/api/oauth')).json()) as OAuthView;
    expect(view.clients.find((c) => c.provider === 'microsoft')).toMatchObject({ clientId: fake.clientId, device: true });
    expect((await call('POST', '/api/oauth/signins', { provider: 'yahoo' })).status).toBe(404);
    const started = await start();
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
  });

  it("saves a provider's app, checked, and a changed one asks its accounts to sign in again, which Test and the calendars say", async () => {
    const { call } = await signedInApp();
    expect((await call('PUT', '/api/oauth/clients/yahoo', { clientId: 'x' })).status).toBe(404);
    for (const bad of [{ clientId: 'not a client id' }, { clientId: 'ok', tenant: 'not a tenant' }, { clientId: 'ok', secret: 'a\nb' }]) {
      const res = await call('PUT', '/api/oauth/clients/microsoft', bad);
      expect(res.status).toBe(400);
      expect(await error(res)).toMatch(/clientId|tenant|secret/);
    }
    const google = await call('PUT', '/api/oauth/clients/google', { clientId: fake.google.clientId, secret: 'GOCSPX-typed' });
    expect(google.status).toBe(200);
    const text = await google.text();
    expect(text).not.toContain('GOCSPX-typed');
    expect((JSON.parse(text) as OAuthView).clients.find((c) => c.provider === 'google')).toMatchObject({ secret: '••••', device: false });

    const id = (await signIn()).account!.id;
    const changed = (await (
      await call('PUT', '/api/oauth/clients/microsoft', { clientId: fake.clientId, tenant: 'organizations' })
    ).json()) as OAuthView;
    expect(changed.accounts[0]).toMatchObject({ id, status: 'reauth', error: 'the app it signed in with was changed in Settings' });
    expect(changed.clients.find((c) => c.provider === 'microsoft')).toMatchObject({ tenant: 'organizations' });
    expect(await (await call('POST', `/api/connectors/calendar/${id}/test`, {})).json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('The sign-in of ming@contoso.com no longer works'),
    });
    const calendars = await call('GET', `/api/oauth/accounts/${id}/calendars`);
    expect(calendars.status).toBe(409);
    expect(await error(calendars)).toContain('no longer works');
  });

  it('answers 409 when listing the calendars finds the sign-in refused, which the account then says; 502 when the provider is down', async () => {
    const { call } = await signedInApp();
    const id = (await signIn()).account!.id;
    now += 61 * MIN;
    fake.refreshAnswer = { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS50173: The grant was revoked' } };
    const refused = await call('GET', `/api/oauth/accounts/${id}/calendars`);
    expect(refused.status).toBe(409);
    expect(await error(refused)).toBe(
      'The sign-in of ming@contoso.com no longer works: sign in again in Settings → Tool library (invalid_grant: AADSTS50173: The grant was revoked)',
    );
    expect(((await (await call('GET', '/api/oauth')).json()) as OAuthView).accounts[0]).toMatchObject({ id, status: 'reauth' });

    fake.refreshAnswer = undefined;
    await signIn();
    now += 61 * MIN;
    fake.refreshAnswer = { status: 500, body: {} };
    const down = await call('GET', `/api/oauth/accounts/${id}/calendars`);
    expect(down.status).toBe(502);
    expect(await error(down)).toContain('The sign-in of ming@contoso.com could not be renewed: HTTP 500');
    expect(((await (await call('GET', '/api/oauth')).json()) as OAuthView).accounts[0]).toMatchObject({ id, status: 'connected' });
    fake.refreshAnswer = undefined;
  });

  it("checks what it is given: its limits, a calendar's host, a calendar that signs in, a sign-in cancelled", async () => {
    const { call, HOST, start } = await signedInApp();
    const id = (await signIn()).account!.id;
    // A calendar on another host than the provider's: its token would go there.
    const elsewhere = await call('POST', `/api/oauth/accounts/${id}/calendars`, { name: 'Evil', url: 'https://evil.example/cal' });
    expect(elsewhere.status).toBe(400);
    expect(await error(elsewhere)).toBe('The sign-in\'s token is not sent to "evil.example": it goes only to the account\'s own service');
    // A calendar reached through a sign-in never turns into one with a password.
    const fixed = await call('PUT', `/api/connectors/calendar/${id}`, {
      name: 'Mine',
      url: 'https://caldav.example.com/cal/',
      username: 'u',
      password: 'p',
    });
    expect(fixed.status).toBe(409);
    expect(await error(fixed)).toBe(
      'This calendar is reached through an account that signed in, not a password: remove it and add it again',
    );

    // A pasted address of at most 8000 characters; the callback's fields of at most 4096 (a longer one is not taken).
    const started = await start();
    const long = await call('POST', `/api/oauth/signins/${started.id}/address`, { address: `http://localhost/?${'x'.repeat(8000)}` });
    expect(long.status).toBe(400);
    expect(await error(long)).toContain('That is not an address');
    const state = new URL(started.authorizeUrl!).searchParams.get('state')!;
    await expect((await call('POST', '/api/oauth/callback', { state, code: 'x'.repeat(4097) }, HOST)).json()).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('no authorization code'),
    });
    expect((await call('POST', '/api/oauth/callback', { state: `${state}${'x'.repeat(4096)}` }, HOST)).status).toBe(404);

    // Cancelled: gone for the page that started it; another browser cannot cancel it.
    const other = await start();
    expect((await call('DELETE', `/api/oauth/signins/${other.id}`, {}, HOST)).status).toBe(401);
    expect(await (await call('DELETE', `/api/oauth/signins/${other.id}`, {})).json()).toEqual({ ok: true });
    expect((await call('GET', `/api/oauth/signins/${other.id}`)).status).toBe(404);
    expect((await call('DELETE', `/api/oauth/signins/${other.id}`, {})).status).toBe(404);
  });

  it('refuses callbacks for no sign-in after 20 in 10 minutes, but never one with a state a sign-in here gave', async () => {
    const { call, HOST, start } = await signedInApp();
    const started = await start();
    for (let i = 0; i < 20; i++) expect((await call('POST', '/api/oauth/callback', { state: `guess-${i}` }, HOST)).status).toBe(404);
    const refused = await call('POST', '/api/oauth/callback', { state: 'one-more' }, HOST);
    expect(refused.status).toBe(429);
    expect(await error(refused)).toBe('Too many sign-in callbacks failed: try again in a while');
    expect((await call('POST', '/api/oauth/callback', {}, HOST)).status).toBe(429);
    // The sign-in under way still comes back.
    const done = await call('POST', '/api/oauth/callback', callbackParams(fake.allow(started.authorizeUrl!)), HOST);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: 'done', email: 'ming@contoso.com' });
  });
});
