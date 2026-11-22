import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPreviewSession, Conversation, PublishedApp, PublishPlan, PublishSettingsView } from '../src/shared/types';
import type { SecretStore } from '../src/server/secrets';
import type { SpawnResult } from '../src/server/process';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-app-publish-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { createApp } = await import('../src/server/app');
const { AppPreviews } = await import('../src/server/appPreviews');
const { AppPublisher } = await import('../src/server/publish');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { removeTree } = await import('../src/server/fsRemove');
afterAll(() => removeTree(root, { restore: true }));

const KEY = 'rnd_abcdefghijklmnopqrstuvwxyz';
const HOST = { host: '127.0.0.1:8787' };
const json = (method: string, body: unknown) => ({
  method,
  headers: { ...HOST, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let app: ReturnType<typeof createApp>;
let project: string;
let n = 0;
let calls: string[];

beforeEach(() => {
  const db = openDatabase(':memory:');
  const values = new Map<string, string>();
  const keyring: SecretStore = {
    storage: 'keychain',
    get: (k) => values.get(k) ?? null,
    set: (k, v) => void values.set(k, v),
    delete: (k) => void values.delete(k),
  };
  const settings = new SettingsStore(db, keyring);
  const store = new Store(db);
  const hub = new Hub();
  calls = [];
  // Render only (a static site needs no Neon), answering every request it is asked.
  const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if ((init?.headers as Record<string, string>).Authorization !== 'Bearer ' + KEY)
      return new Response('{"message":"no"}', { status: 401 });
    if (url.pathname === '/v1/owners') return Response.json([{ owner: { id: 'tea-1', name: 'Me' } }]);
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const publisher = new AppPublisher(settings.publish, {
    fetcher,
    run: vi.fn(
      async () => ({ code: 0, signal: null, stdout: 'me\n', stderr: '', timedOut: false, aborted: false }) as unknown as SpawnResult,
    ),
    renderBase: 'https://render.test/v1',
    owner: 'test',
  });
  app = createApp({
    auth: null,
    store,
    settings,
    hub,
    orchestrator: new Orchestrator(store, hub, settings),
    providers: new ProviderService(settings),
    previews: new AppPreviews('test', vi.fn()),
    publisher,
    folderPicker: { available: () => false, pick: async () => [] },
  });
  project = join(root, `project-${++n}`);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'index.html'), '<h1>hi</h1>');
});

async function previewing(): Promise<{ conv: Conversation; session: AppPreviewSession }> {
  const res = await app.request(
    '/api/conversations',
    json('POST', {
      agents: [{ name: 'Alice', provider: 'claude', role: '' }],
      settings: { mode: 'roundtable', permission: 'edit', cwd: project },
    }),
  );
  const conv = (await res.json()) as Conversation;
  const started = await app.request(
    `/api/conversations/${conv.id}/preview`,
    json('POST', { mode: 'static', folder: '', entry: 'index.html' }),
  );
  expect(started.status).toBe(200);
  return { conv, session: (await started.json()) as AppPreviewSession };
}

describe('the publish routes', () => {
  it('keep a checked Render key and give back only its masked end', async () => {
    expect((await app.request('/api/publish/render', json('PUT', { apiKey: 'rnd_wrongwrongwrongwrong' }))).status).toBe(400);
    const saved = await app.request('/api/publish/render', json('PUT', { apiKey: KEY }));
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as PublishSettingsView;
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(view.render).toMatchObject({ ownerId: 'tea-1', owners: [{ id: 'tea-1', name: 'Me' }] });
    expect(
      ((await (await app.request('/api/publish/render', json('PATCH', { region: 'frankfurt' }))).json()) as PublishSettingsView).render
        .region,
    ).toBe('frankfurt');
    expect((await app.request('/api/publish/render', json('PATCH', { region: 'mars' }))).status).toBe(400);
    expect(((await (await app.request('/api/publish/render', json('DELETE', {}))).json()) as PublishSettingsView).render.keyMasked).toBe(
      '',
    );
    // Writes take JSON only, as every other route's.
    expect(
      (await app.request('/api/publish/render', { method: 'PUT', headers: { ...HOST, 'content-type': 'text/plain' }, body: KEY })).status,
    ).toBe(415);
  });

  it("plan a running preview's publish, and refuse one that is not running or not confirmed as public", async () => {
    await app.request('/api/publish/render', json('PUT', { apiKey: KEY }));
    const { conv, session } = await previewing();
    const res = await app.request(`/api/conversations/${conv.id}/preview/${session.id}/publish/plan`, json('POST', {}));
    expect(res.status).toBe(200);
    const plan = (await res.json()) as PublishPlan;
    expect(plan).toMatchObject({
      kind: 'static',
      serviceType: 'static_site',
      folder: project,
      missing: [],
      github: { login: 'me' },
      commands: { publish: '.' },
    });
    expect((await app.request(`/api/conversations/${conv.id}/preview/nope/publish/plan`, json('POST', {}))).status).toBe(404);
    const unconfirmed = await app.request(`/api/conversations/${conv.id}/preview/${session.id}/publish`, json('POST', { public: false }));
    expect(unconfirmed.status).toBe(400);
    // The files changed since the preview started: tried again first.
    writeFileSync(join(project, 'index.html'), '<h1>changed</h1>');
    const changed = await app.request(`/api/conversations/${conv.id}/preview/${session.id}/publish`, json('POST', { public: true }));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'publish-changed' });
    // Nothing was made at Render.
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
  });

  it('answer for an app that is not there, and list none at first', async () => {
    expect((await app.request('/api/publish/apps/none', { headers: HOST })).status).toBe(404);
    expect((await app.request('/api/publish/apps/none', json('DELETE', {}))).status).toBe(404);
    expect(((await (await app.request('/api/publish', { headers: HOST })).json()) as PublishSettingsView).apps as PublishedApp[]).toEqual(
      [],
    );
  });
});
