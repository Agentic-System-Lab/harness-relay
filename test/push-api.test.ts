import { createECDH } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_KEY_HEADER } from '../src/shared/auth';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-push-api-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { AuthStore, CODE_TTL_MS } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { AlertWatcher } = await import('../src/server/alerts');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { PushService } = await import('../src/server/push');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
type PushRequest = import('../src/server/push').PushRequest;

const HOST = { host: '127.0.0.1:8787' };
/** A browser's keys: a real P-256 public key, as a browser makes. */
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') };
const prefs = { done: true, needs: false, sound: true };

describe('/api/push', () => {
  let app: ReturnType<typeof createApp>;
  let auth: InstanceType<typeof AuthStore>;
  let push: InstanceType<typeof PushService>;
  let alerts: InstanceType<typeof AlertWatcher>;
  let sent: PushRequest[];
  let status: number;

  beforeEach(() => {
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    const store = new Store(db);
    const hub = new Hub();
    auth = new AuthStore(db);
    sent = [];
    status = 201;
    push = new PushService(db, undefined, async (req) => {
      sent.push(req);
      return { status, text: '' };
    });
    alerts = new AlertWatcher({ list: () => [], get: () => undefined, push });
    app = createApp({ auth, store, settings, hub, orchestrator: new Orchestrator(store, hub, settings), providers: new ProviderService(settings), push, alerts });
  });

  /** A signed-in browser: its requests' headers. */
  async function browser(): Promise<Record<string, string>> {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ code: auth.createCode(CODE_TTL_MS.device).code }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    return { ...HOST, cookie, [AUTH_KEY_HEADER]: ((await res.json()) as { key: string }).key };
  }
  const send = (headers: Record<string, string>, method: string, path: string, body: unknown = {}) =>
    app.request(path, { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('gives the key browsers subscribe with, to signed-in browsers only', async () => {
    expect((await app.request('/api/push', { headers: HOST })).status).toBe(401);
    const res = await app.request('/api/push', { headers: await browser() });
    expect(Buffer.from(((await res.json()) as { publicKey: string }).publicKey, 'base64url')).toHaveLength(65);
  });

  it("keeps a browser's subscription in its language, and refuses addresses that are no push service's and wrong keys", async () => {
    const phone = await browser();
    const subscribe = (subscription: unknown, p: unknown = prefs) => send({ ...phone, 'x-relay-lang': 'en' }, 'PUT', '/api/push/subscription', { subscription, prefs: p });
    expect((await subscribe({ endpoint: 'https://example.com/push', keys })).status).toBe(400);
    expect((await subscribe({ endpoint: 'http://10.0.0.2/push', keys })).status).toBe(400);
    expect((await subscribe({ endpoint: 'https://web.push.apple.com/x', keys: { ...keys, auth: 'AA' } })).status).toBe(400);
    expect((await subscribe({ endpoint: 'https://web.push.apple.com/x', keys }, { done: 'yes' })).status).toBe(400);
    expect((await subscribe({ endpoint: 'https://web.push.apple.com/x', keys })).status).toBe(200);
    expect(push.subscriptions()).toMatchObject([{ endpoint: 'https://web.push.apple.com/x', lang: 'en', prefs }]);
  });

  it('sends a test notification to its own browser only, and removes it only from there', async () => {
    const phone = await browser();
    const laptop = await browser();
    const endpoint = 'https://web.push.apple.com/phone';
    await send(phone, 'PUT', '/api/push/subscription', { subscription: { endpoint, keys }, prefs });
    expect((await send(laptop, 'POST', '/api/push/test', { endpoint })).status).toBe(404);
    expect((await send(phone, 'POST', '/api/push/test', { endpoint })).status).toBe(200);
    expect(sent.map((r) => r.endpoint)).toEqual([endpoint]);
    await send(laptop, 'DELETE', '/api/push/subscription', { endpoint });
    expect(push.hasSubscriptions()).toBe(true);
    // Its push service no longer has it: the test says so, and it is gone here too.
    status = 410;
    const failed = await send(phone, 'POST', '/api/push/test', { endpoint });
    expect(failed.status).toBe(502);
    expect(push.hasSubscriptions()).toBe(false);
    await send(phone, 'PUT', '/api/push/subscription', { subscription: { endpoint, keys }, prefs });
    expect((await send(phone, 'DELETE', '/api/push/subscription', { endpoint })).status).toBe(200);
    expect(push.hasSubscriptions()).toBe(false);
  });

  it('hears from a page whether it is in front: its polls, and going to the background', async () => {
    const seen = vi.spyOn(alerts, 'seen');
    const phone = await browser();
    await app.request('/api/conversations?visible=1', { headers: phone });
    await app.request('/api/conversations', { headers: phone });
    await send(phone, 'POST', '/api/push/presence', { visible: false });
    const session = auth.sessions()[0]!.id;
    expect(seen.mock.calls).toEqual([
      [session, true],
      [session, false],
    ]);
  });

  it('says it sends no push notifications when it has no push service', async () => {
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    const store = new Store(db);
    const hub = new Hub();
    const bare = createApp({ auth: null, store, settings, hub, orchestrator: new Orchestrator(store, hub, settings), providers: new ProviderService(settings) });
    expect(await (await bare.request('/api/push', { headers: HOST })).json()).toHaveProperty('error');
    const res = await bare.request('/api/push/subscription', {
      method: 'PUT',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: { endpoint: 'https://web.push.apple.com/x', keys }, prefs }),
    });
    expect(res.status).toBe(503);
  });
});
