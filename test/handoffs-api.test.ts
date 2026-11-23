/*
 * Secrets and fixed commands' HTTP API (src/server/app.ts): a secrets card's answer, Settings' view
 * (names only, never a value), replacing and removing a secret of a folder it lists only, removing a
 * fixed command; an interactive command's card (Start refused for an automation's run and for another
 * chat's card, typing into a run that ended refused, its actions checked); a secrets card's browser
 * for the user alone and its Save selection (with a stand-in for the browser); and the middleware's
 * checks on these writes.
 */
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Conversation, FolderHandoffs, MessagePart } from '../src/shared/types';
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
const { UserBrowserError } = await import('../src/server/browser/handover');

afterAll(() => removeTree(root, { restore: true }));

let app: ReturnType<typeof createApp>;
let orchestrator: InstanceType<typeof Orchestrator>;
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
  orchestrator = new Orchestrator(store, hub, settings);
  app = createApp({
    auth: null,
    store,
    settings,
    hub,
    orchestrator,
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
    const res = await send('POST', `/api/conversations/${conv.id}/messages/m2/secrets/${partId}`, {
      values: { TOKEN: 'tok-123456', N: 5 },
    });
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

  it("saves a schedule's fixed command of the chat's own working directory only, and lists its commands", async () => {
    const { conv } = chatAsking();
    const id = settings.handoffs.commandId(root, 'check');
    settings.handoffs.saveCommand(root, id, { name: 'check', run: 'true', hosts: [], secrets: [] }, { manifest: {} });
    const other = settings.handoffs.commandId('/elsewhere', 'check');
    settings.handoffs.saveCommand('/elsewhere', other, { name: 'check', run: 'true', hosts: [], secrets: [] }, { manifest: {} });
    const listed = (await (await app.request(`/api/conversations/${conv.id}/commands`, { headers: HOST })).json()) as { id: string }[];
    expect(listed.map((c) => c.id)).toEqual([id]);
    const schedule = { text: 'check', repeat: { kind: 'interval', hours: 1 }, timeZone: 'UTC' };
    expect((await send('PUT', `/api/conversations/${conv.id}/schedule`, { ...schedule, command: other })).status).toBe(400);
    const saved = await send('PUT', `/api/conversations/${conv.id}/schedule`, { ...schedule, command: id });
    expect(saved.status).toBe(200);
    expect(store.get(conv.id)!.schedule!.command).toBe(id);
    // Removed in Settings: the schedule runs none now, rather than failing at each time.
    expect((await send('DELETE', `/api/handoffs/commands/${id}`)).status).toBe(200);
    expect(store.get(conv.id)!.schedule!.command).toBeUndefined();
  });

  it('refuses an unknown card action, and extra words or input that are not text or too long', async () => {
    const { conv } = chatAsking();
    expect((await send('POST', `/api/conversations/${conv.id}/messages/m2/commands/x`, { action: 'run' })).status).toBe(400);
    expect((await send('POST', `/api/conversations/${conv.id}/commands/c1/try`, { extra: 5 })).status).toBe(400);
    expect((await send('POST', `/api/conversations/${conv.id}/commands/c1/try`, { stdin: 5 })).status).toBe(400);
    expect((await send('POST', `/api/conversations/${conv.id}/commands/c1/try`, { stdin: 'x'.repeat(16 * 1024 + 1) })).status).toBe(400);
    expect((await send('POST', `/api/conversations/${conv.id}/commands/c1/try`, {})).status).toBe(404);
  });

  it("shows a command's changes with the digest Approve sends, and approves only with that digest", async () => {
    const { conv } = chatAsking();
    writeFileSync(join(root, 'check.py'), 'print(1)\n');
    const id = settings.handoffs.commandId(root, 'check');
    // Pinned before check.py existed: it is a change.
    settings.handoffs.saveCommand(root, id, { name: 'check', run: 'python3 check.py', hosts: [], secrets: [] }, { manifest: {} });
    const res = await app.request(`/api/conversations/${conv.id}/commands/${id}/diff`, { headers: HOST });
    expect(res.status).toBe(200);
    const diff = (await res.json()) as { changed: string[]; digest: string };
    expect(diff.changed).toContain('check.py');
    expect(diff.digest).toMatch(/^[0-9a-f]{32}$/);
    // Approve is the digest the user saw, never a yes.
    expect((await send('POST', `/api/conversations/${conv.id}/commands/${id}/try`, { approve: true })).status).toBe(400);
    expect((await send('POST', `/api/conversations/${conv.id}/commands/${id}/try`, { approve: 'not-a-digest' })).status).toBe(400);
    const stale = await send('POST', `/api/conversations/${conv.id}/commands/${id}/try`, { approve: '0'.repeat(32) });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toMatch(/changed again/);
    expect(settings.handoffs.pin(id)!.manifest).toEqual({});
  });

  it("opens a secrets card's browser for the user alone, and keeps what is selected there without sending any of it back", async () => {
    const { conv, partId } = chatAsking();
    const opened: string[] = [];
    orchestrator.userBrowsers = {
      openForUser: async (convId) => (opened.push(convId), 'ub-1'),
      navigateForUser: async () => undefined,
      userBrowserOpen: (_c, id) => id === 'ub-1',
      userBrowserMode: (_c, id) => (id === 'ub-1' ? 'screencast' : undefined),
      userWindowAt: () => undefined,
      selectionOf: async () => ' tok-selected-on-page ',
      closeForUser: async () => undefined,
    };
    const path = `/api/conversations/${conv.id}/messages/m2/secrets/${partId}`;
    expect((await send('POST', `${path}/browser`, { name: 5 })).status).toBe(400);
    expect((await send('POST', `${path}/browser`, { name: 'TOKEN', window: 'yes' })).status).toBe(400);
    // No window where this computer shows none: the card offers the screencast only.
    expect(await (await app.request('/api/handovers/window', { headers: HOST })).json()).toEqual({ windowAt: null });
    // An address on this computer or the local network: refused until confirmed, with a code the card tells apart.
    const stub = orchestrator.userBrowsers!;
    orchestrator.userBrowsers = {
      ...stub,
      openForUser: async (convId, o = {}) => {
        if (!o.nearbyConfirmed) throw new UserBrowserError('nearby', 'http://127.0.0.1:3000/token');
        return stub.openForUser(convId, o);
      },
    };
    const refused = await send('POST', `${path}/browser`, { name: 'TOKEN' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'nearby', error: expect.stringContaining('http://127.0.0.1:3000/token') });
    const res = await send('POST', `${path}/browser`, { name: 'TOKEN', confirm: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handoverId: 'ub-1', mode: 'screencast' });
    expect(opened).toEqual([conv.id]);
    expect((await send('POST', `${path}/selection`, { name: 'TOKEN' })).status).toBe(400);
    expect((await send('POST', `${path}/selection`, { handoverId: 'ub-9', name: 'TOKEN' })).status).toBe(404);
    const saved = await send('POST', `${path}/selection`, { handoverId: 'ub-1', name: 'TOKEN' });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain('tok-selected-on-page');
    expect(settings.handoffs.values(root)).toEqual({ TOKEN: 'tok-selected-on-page' });
    const conversation = await (await app.request(`/api/conversations/${conv.id}`, { headers: HOST })).text();
    expect(conversation).toContain('"from":"page"');
    expect(conversation).not.toContain('tok-selected-on-page');
    expect((await send('POST', `${path}/browser`, {})).status).toBe(409);
  });

  it("opens a secrets card's browser for the user alone in a window where this computer shows one", async () => {
    const { conv, partId } = chatAsking();
    const asked: { window?: boolean }[] = [];
    orchestrator.userBrowsers = {
      openForUser: async (_c, o = {}) => {
        asked.push({ window: o.window });
        if (o.window) throw new UserBrowserError('window', 'this computer shows no window');
        return 'ub-2';
      },
      navigateForUser: async () => undefined,
      userBrowserOpen: () => false,
      userBrowserMode: () => undefined,
      userWindowAt: () => 'server',
      selectionOf: async () => '',
      closeForUser: async () => undefined,
    };
    expect(await (await app.request('/api/handovers/window', { headers: HOST })).json()).toEqual({ windowAt: 'server' });
    const path = `/api/conversations/${conv.id}/messages/m2/secrets/${partId}`;
    // The window could not open after all (the server's session changed): said so, the screencast offered instead.
    const refused = await send('POST', `${path}/browser`, { name: 'TOKEN', window: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/cannot show a window.*show it in the chat instead/);
    const shown = await send('POST', `${path}/browser`, { name: 'TOKEN' });
    expect(await shown.json()).toEqual({ handoverId: 'ub-2', mode: 'screencast' });
    expect(asked).toEqual([{ window: true }, { window: undefined }]);
  });
});

describe("an interactive command card's API", () => {
  /** A chat whose reply asks the user to run a command, as the orchestrator records it. */
  function chatWith(part: Partial<Extract<MessagePart, { type: 'interactive' }>> = {}, id = 'conv-i'): Conversation {
    const conv: Conversation = {
      id,
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
          parts: [{ type: 'interactive', id: 'i1', folder: root, run: 'npm login', configFiles: [], status: 'proposed', ...part }],
          status: 'done',
          asked: true,
        },
      ],
      agentState: {},
      worktrees: {},
    };
    store.create(conv);
    return conv;
  }
  const path = (conv: string) => `/api/conversations/${conv}/messages/m2/interactive/i1`;

  it("refuses Start for a card an automation's run proposed, and for another chat's card", async () => {
    chatWith({ blocked: 'automation' });
    const res = await send('POST', path('conv-i'), { action: 'start' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("automation's run");
    chatWith({}, 'conv-other');
    expect((await send('POST', '/api/conversations/conv-other/messages/m2/interactive/nope', { action: 'start' })).status).toBe(404);
    expect((await send('POST', '/api/conversations/conv-none/messages/m2/interactive/i1', { action: 'start' })).status).toBe(404);
  });

  it('refuses typing into a run that ended, sending one twice, and actions it does not know', async () => {
    chatWith({
      status: 'started',
      session: {
        state: 'exited',
        exitCode: 0,
        startedAt: 1,
        endsAt: 2,
        inWorkdir: false,
        output: 'done\n',
        urls: [],
        codes: [],
        helper: 'off',
      },
    });
    expect((await send('POST', path('conv-i'), { action: 'input', text: 'x', hidden: true })).status).toBe(409);
    expect((await send('POST', path('conv-i'), { action: 'input', text: 5 })).status).toBe(400);
    expect((await send('POST', path('conv-i'), { action: 'answer', askId: 'q1', text: 'x' })).status).toBe(409);
    expect((await send('POST', path('conv-i'), { action: 'cancel' })).status).toBe(409);
    expect((await send('POST', path('conv-i'), { action: 'run' })).status).toBe(400);
    expect((await send('POST', path('conv-i'), { action: 'send' })).status).toBe(200);
    expect((await send('POST', path('conv-i'), { action: 'send' })).status).toBe(409);
    expect((await send('POST', path('conv-i'), { action: 'dismiss' })).status).toBe(409);
    // Only from this page's origin, as JSON.
    expect((await send('POST', path('conv-i'), { action: 'start' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await send('POST', path('conv-i'), { action: 'start' }, { 'content-type': 'text/plain' })).status).toBe(415);
  });
});
