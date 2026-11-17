import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_KEY_HEADER } from '../src/shared/auth';
import type { Conversation, InboxItem, InboxSummary } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-inbox-api-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { AuthStore, CODE_TTL_MS } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { INBOX_READ_MAX } = await import('../src/server/validate');

const HOST = { host: '127.0.0.1:8787' };

const conversation = (id: string, title: string): Conversation => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  agents: [{ id: 'a1', name: 'Claude', provider: 'claude', role: '' }],
  settings: { mode: 'roundtable', rounds: 1, maxHops: 6, permission: 'edit', cwd: '/tmp' },
  messages: [],
  agentState: {},
  worktrees: {},
});

describe('/api/notifications', () => {
  let app: ReturnType<typeof createApp>;
  let auth: InstanceType<typeof AuthStore>;
  let store: InstanceType<typeof Store>;
  let headers: Record<string, string>;

  beforeEach(async () => {
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    store = new Store(db);
    const hub = new Hub();
    auth = new AuthStore(db);
    app = createApp({ auth, store, settings, hub, orchestrator: new Orchestrator(store, hub, settings), providers: new ProviderService(settings) });
    store.create(conversation('c1', 'First'));
    store.create(conversation('c2', 'Second'));
    store.addNotification({ id: 'n1', conversationId: 'c1', kind: 'done', agent: 'Claude', text: 'All tests pass.', createdAt: 1 });
    store.addNotification({ id: 'n2', conversationId: 'c2', kind: 'answer', agent: 'Claude', text: 'Which database?', createdAt: 2 });
    store.addNotification({ id: 'n3', conversationId: 'c1', kind: 'approval', createdAt: 3 });
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ code: auth.createCode(CODE_TTL_MS.device).code }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    headers = { ...HOST, cookie, [AUTH_KEY_HEADER]: ((await res.json()) as { key: string }).key };
  });

  const get = async <T>(path: string) => {
    const res = await app.request(path, { headers });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  };
  const send = (method: string, path: string, body: unknown = {}) =>
    app.request(path, { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('is for signed-in browsers only', async () => {
    expect((await app.request('/api/notifications', { headers: HOST })).status).toBe(401);
    expect((await app.request('/api/notifications/summary', { headers: HOST })).status).toBe(401);
    const write = await app.request('/api/notifications/read', { method: 'POST', headers: { ...HOST, 'content-type': 'application/json' }, body: '{"all":true}' });
    expect(write.status).toBe(401);
    expect(store.notificationSummary().unread).toBe(3);
  });

  it('lists every notification, the newest first, and sums them up', async () => {
    const items = await get<InboxItem[]>('/api/notifications');
    expect(items.map((i) => [i.id, i.title, i.kind, i.read])).toEqual([
      ['n3', 'First', 'approval', false],
      ['n2', 'Second', 'answer', false],
      ['n1', 'First', 'done', false],
    ]);
    expect(await get<InboxSummary>('/api/notifications/summary')).toEqual({ unread: 3, unreadIn: ['c1', 'c2'], newest: 'n3' });
  });

  it("marks read those named, a conversation's, or all", async () => {
    let res = await send('POST', '/api/notifications/read', { ids: ['n1'] });
    expect(await res.json()).toEqual({ read: 1 });
    res = await send('POST', '/api/notifications/read', { conversationId: 'c1' });
    expect(await res.json()).toEqual({ read: 1 });
    expect(await get<InboxSummary>('/api/notifications/summary')).toEqual({ unread: 1, unreadIn: ['c2'], newest: 'n3' });
    res = await send('POST', '/api/notifications/read', { all: true });
    expect(await res.json()).toEqual({ read: 1 });
    expect((await get<InboxItem[]>('/api/notifications')).every((i) => i.read)).toBe(true);
  });

  it('refuses a request that names nothing, or too much', async () => {
    for (const body of [{}, { all: false }, { ids: 'n1' }, { ids: [1] }, { ids: [''] }, { conversationId: '' }, { conversationId: 'c'.repeat(65) }, { ids: ['n'.repeat(65)] }, { ids: Array(INBOX_READ_MAX + 1).fill('n1') }]) {
      expect((await send('POST', '/api/notifications/read', body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(store.notificationSummary().unread).toBe(3);
  });

  it('clears them all', async () => {
    expect((await send('DELETE', '/api/notifications')).status).toBe(200);
    expect(await get<InboxItem[]>('/api/notifications')).toEqual([]);
    expect(await get<InboxSummary>('/api/notifications/summary')).toEqual({ unread: 0, unreadIn: [] });
  });

  it('removes them with their conversation', async () => {
    expect((await send('DELETE', '/api/conversations/c1')).status).toBe(200);
    expect((await get<InboxItem[]>('/api/notifications')).map((i) => i.id)).toEqual(['n2']);
  });
});
