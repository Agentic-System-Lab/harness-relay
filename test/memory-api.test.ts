/*
 * Long-term memory's HTTP API (`/api/memory…` in src/server/app.ts): the view, its settings, adding,
 * changing and deleting a note, and Tidy up now, each answered with the whole view.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryView } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-memory-api-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { removeTree } = await import('../src/server/fsRemove');

afterAll(() => removeTree(root, { restore: true }));

let app: ReturnType<typeof createApp>;
const noPicker = { available: () => false, pick: async () => [] };

beforeEach(() => {
  const db = openDatabase(':memory:');
  const settings = new SettingsStore(db);
  const store = new Store(db);
  const hub = new Hub();
  app = createApp({
    auth: null,
    store,
    settings,
    hub,
    orchestrator: new Orchestrator(store, hub, settings),
    providers: new ProviderService(settings),
    folderPicker: noPicker,
  });
});

const HOST = { host: '127.0.0.1:8787' };
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...HOST, 'content-type': 'application/json', 'x-relay-lang': 'en' },
    body: JSON.stringify(body ?? {}),
  });
const view = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()) as MemoryView;
};

describe('long-term memory API', () => {
  it('shows the memory, empty at first, with its settings on', async () => {
    const v = await view(await app.request('/api/memory', { headers: HOST }));
    expect(v).toEqual({
      settings: { enabled: true, review: false, autoTidy: true },
      notes: [],
      sources: {},
      tidying: false,
      changedSinceTidy: 0,
    });
  });

  it('changes the settings, and refuses what is not a switch', async () => {
    expect((await view(await send('PUT', '/api/memory/settings', { review: true }))).settings.review).toBe(true);
    expect((await send('PUT', '/api/memory/settings', { review: 'yes' })).status).toBe(400);
  });

  it('adds, changes and deletes a note', async () => {
    const added = await view(await send('POST', '/api/memory/notes', { text: 'I use pnpm', cwd: join(root, 'app'), pinned: true }));
    const [n] = added.notes;
    expect(n).toMatchObject({
      text: 'I use pnpm',
      cwd: join(root, 'app'),
      pinned: 'user',
      basis: 'user',
      state: 'active',
      author: { kind: 'user' },
    });
    const changed = await view(
      await send('PATCH', `/api/memory/notes/${n!.id}`, { text: 'I use pnpm 9', cwd: null, pinned: false, state: 'archived' }),
    );
    expect(changed.notes[0]).toMatchObject({ text: 'I use pnpm 9', state: 'archived' });
    expect(changed.notes[0]).not.toHaveProperty('cwd');
    expect(changed.notes[0]).not.toHaveProperty('pinned');
    expect((await view(await send('DELETE', `/api/memory/notes/${n!.id}`))).notes).toEqual([]);
    expect((await send('DELETE', `/api/memory/notes/${n!.id}`)).status).toBe(404);
    expect((await send('PATCH', '/api/memory/notes/m_none', { pinned: true })).status).toBe(404);
  });

  it('refuses an empty or too long note, and a folder that is not absolute', async () => {
    expect((await send('POST', '/api/memory/notes', { text: '  ' })).status).toBe(400);
    expect((await send('POST', '/api/memory/notes', { text: 'x'.repeat(5000) })).status).toBe(400);
    expect((await send('POST', '/api/memory/notes', { text: 'x', cwd: 'relative' })).status).toBe(400);
    expect((await send('PATCH', '/api/memory/notes/m_1', { state: 'pending' })).status).toBe(400);
  });

  it('refuses Tidy up now with nothing to tidy', async () => {
    const res = await send('POST', '/api/memory/tidy');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('There are no notes to tidy yet.');
  });

  it('takes writes only as JSON from this computer', async () => {
    const res = await app.request('/api/memory/notes', { method: 'POST', headers: { host: 'evil.example' }, body: '{"text":"x"}' });
    expect(res.status).toBe(403);
  });
});
