/*
 * Secrets and fixed commands' HTTP API (src/server/app.ts): a secrets card's answer, Settings' view
 * (names only, never a value), replacing and removing a secret of a folder it lists only, removing a
 * fixed command; and the middleware's checks on these writes.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Conversation, FolderHandoffs } from '../src/shared/types';
import type { SecretStore } from '../src/server/secrets';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-handoffs-api-')));
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
let settings: InstanceType<typeof SettingsStore>;
let store: InstanceType<typeof Store>;
const keys = new Map<string, string>();
const noPicker = { available: () => false, pick: async () => [] };

beforeEach(() => {
  keys.clear();
  const db = openDatabase(':memory:');
  const keyring: SecretStore = {
    storage: 'keychain',
    get: (k) => keys.get(k) ?? null,
    set: (k, v) => void keys.set(k, v),
    delete: (k) => void keys.delete(k),
  };
  settings = new SettingsStore(db, keyring);
  store = new Store(db);
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
const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { ...HOST, 'content-type': 'application/json', 'x-relay-lang': 'en', ...headers },
    body: JSON.stringify(body ?? {}),
  });

/** A chat whose reply asks for a secret, as the orchestrator records it. */
function chatAsking(): { conv: Conversation; partId: string } {
  const conv: Conversation = {
    id: 'conv-1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    agents: [{ id: 'a', name: 'Alice', provider: 'claude', role: '' }],
    settings: { mode: 'relay', rounds: 1, maxHops: 5, permission: 'read-only', cwd: root },
    messages: [
      { id: 'm1', author: { kind: 'user' }, createdAt: 1, parts: [{ type: 'text', text: 'go' }], status: 'done' },
      {
        id: 'm2',
        author: { kind: 'agent', agentId: 'a' },
        createdAt: 2,
        parts: [{ type: 'secrets', id: 's1', folder: root, asks: [{ name: 'TOKEN', status: 'waiting' }] }],
        status: 'done',
        asked: true,
      },
    ],
    agentState: {},
    worktrees: {},
  };
  store.create(conv);
  return { conv, partId: 's1' };
}

describe('secrets and fixed commands API', () => {
  it("takes a secrets card's answer, and Settings lists the name, never the value", async () => {
    const { conv, partId } = chatAsking();
    const res = await send('POST', `/api/conversations/${conv.id}/messages/m2/secrets/${partId}`, { values: { TOKEN: 'tok-123456', N: 5 } });
    expect(res.status).toBe(200);
    expect(settings.handoffs.values(root)).toEqual({ TOKEN: 'tok-123456' });
    const view = (await (await app.request('/api/handoffs', { headers: HOST })).json()) as { storage: boolean; folders: FolderHandoffs[] };
    expect(view.storage).toBe(true);
    expect(view.folders).toEqual([{ folder: root, secrets: [{ name: 'TOKEN', setAt: expect.any(Number) }], commands: [] }]);
    expect(JSON.stringify(view)).not.toContain('tok-123456');
    // The conversation shows the card answered, and holds no value.
    const conversation = await (await app.request(`/api/conversations/${conv.id}`, { headers: HOST })).text();
    expect(conversation).toContain('"saved"');
    expect(conversation).not.toContain('tok-123456');
  });

  it('refuses a write that is not JSON, or from another origin', async () => {
    const { conv, partId } = chatAsking();
    const path = `/api/conversations/${conv.id}/messages/m2/secrets/${partId}`;
    expect((await send('POST', path, { values: { TOKEN: 'x1234' } }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await send('POST', path, { values: { TOKEN: 'x1234' } }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(settings.handoffs.values(root)).toEqual({});
  });

  it('replaces and removes a secret of a listed folder only, and removes a fixed command', async () => {
    settings.handoffs.setSecrets(root, { TOKEN: 'old-value' });
    expect((await send('PUT', '/api/handoffs/secrets', { folder: root, name: 'TOKEN', value: 'new-value' })).status).toBe(200);
    expect(settings.handoffs.values(root)).toEqual({ TOKEN: 'new-value' });
    expect((await send('PUT', '/api/handoffs/secrets', { folder: '/elsewhere', name: 'TOKEN', value: 'x1234' })).status).toBe(404);
    expect((await send('PUT', '/api/handoffs/secrets', { folder: root, name: 'bad name', value: 'x1234' })).status).toBe(400);
    expect((await send('POST', '/api/handoffs/secrets/delete', { folder: root, name: 'TOKEN' })).status).toBe(200);
    expect(settings.handoffs.values(root)).toEqual({});

    const id = settings.handoffs.commandId(root, 'post');
    settings.handoffs.saveCommand(root, id, { name: 'post', run: 'true', hosts: [], secrets: [] }, { manifest: {} });
    expect((await send('DELETE', `/api/handoffs/commands/${id}`)).status).toBe(200);
    expect(settings.handoffs.command(id)).toBeUndefined();
    expect((await send('DELETE', `/api/handoffs/commands/${id}`)).status).toBe(404);
  });

  it('refuses an unknown card action, and extra words that are not text', async () => {
    const { conv } = chatAsking();
    expect((await send('POST', `/api/conversations/${conv.id}/messages/m2/commands/x`, { action: 'run' })).status).toBe(400);
    expect((await send('POST', `/api/conversations/${conv.id}/commands/c1/try`, { extra: 5 })).status).toBe(400);
    expect((await send('POST', `/api/conversations/${conv.id}/commands/c1/try`, {})).status).toBe(404);
  });
});
