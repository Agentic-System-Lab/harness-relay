import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-app-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { AgentRunError, runners } = await import('../src/server/agents');

let app: ReturnType<typeof createApp>;
let orchestrator: InstanceType<typeof Orchestrator>;
let project: string;
let n = 0;

// A fake CLI that writes a file, then waits until it is stopped.
beforeAll(() => {
  runners.claude = {
    provider: 'claude',
    async run(o) {
      writeFileSync(join(o.cwd, 'out.txt'), 'x\n');
      o.onEvent({ type: 'text', text: 'working…' });
      if (!o.signal?.aborted) await new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }));
      throw new AgentRunError('stopped', true);
    },
  };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  const db = openDatabase(':memory:');
  const settings = new SettingsStore(db);
  const store = new Store(db);
  const hub = new Hub();
  orchestrator = new Orchestrator(store, hub, settings);
  app = createApp({ store, settings, hub, orchestrator, providers: new ProviderService(settings) });
  project = join(root, `project-${++n}`);
  mkdirSync(project, { recursive: true });
});

const HOST = { host: '127.0.0.1:8787' };
const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { ...HOST, 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { ...HOST, ...headers } });

async function createConversation(settings: Record<string, unknown> = {}): Promise<Conversation> {
  const res = await app.request(
    '/api/conversations',
    json('POST', {
      agents: [{ name: 'Alice', provider: 'claude', role: '' }],
      settings: { mode: 'roundtable', permission: 'edit', cwd: project, ...settings },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Conversation;
}

describe('request checks', () => {
  it('only lets the local UI in', async () => {
    expect((await app.request('/api/settings', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await get('/api/settings', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await get('/api/settings', { origin: 'http://localhost:5173' })).status).toBe(200);
  });

  it('requires a JSON content type for writes, not just one that mentions it', async () => {
    const send = (type: string) =>
      app.request('/api/presets', { method: 'POST', headers: { ...HOST, 'content-type': type }, body: '{}' });
    expect((await send('text/plain; x=application/json')).status).toBe(415);
    expect((await send('text/plain')).status).toBe(415);
    expect((await send('application/json; charset=utf-8')).status).toBe(400); // passes the check, then fails validation
  });
});

describe('request bodies', () => {
  it('must be JSON objects', async () => {
    for (const raw of ['null', '[]', '"text"', '{bad']) {
      const res = await app.request('/api/settings', {
        method: 'PUT',
        headers: { ...HOST, 'content-type': 'application/json' },
        body: raw,
      });
      expect(res.status, raw).toBe(400);
    }
  });
});

describe('DELETE /api/conversations/:id', () => {
  it('stops a conversation that is replying and deletes it without crashing the server', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const conv = await createConversation();
      expect((await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { text: 'go' }))).status).toBe(202);
      // Wait until the agent's turn is under way (its message is streaming).
      await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 50));

      const res = await app.request(`/api/conversations/${conv.id}`, { method: 'DELETE', headers: { ...HOST, 'content-type': 'application/json' } });
      expect(res.status).toBe(200);
      expect(orchestrator.isRunning(conv.id)).toBe(false);
      expect((await get(`/api/conversations/${conv.id}`)).status).toBe(404);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('PATCH /api/conversations/:id', () => {
  it('refuses team and settings changes while the team replies, but allows renaming', async () => {
    const conv = await createConversation();
    await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { text: 'go' }));
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(true));
    const patch = (body: unknown) => app.request(`/api/conversations/${conv.id}`, json('PATCH', body));
    expect((await patch({ settings: { ...conv.settings, permission: 'full' } })).status).toBe(409);
    const renamed = await patch({ title: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as Conversation).title).toBe('Renamed');
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
  });

  it("does not send the agents' session bookkeeping to the browser", async () => {
    const conv = await createConversation();
    await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { text: 'go' }));
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(true));
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
    const body = (await (await get(`/api/conversations/${conv.id}`)).json()) as Conversation;
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.agentState).toEqual({});
  });
});

describe('settings', () => {
  it('rejects values of the wrong type and a default directory that is a file', async () => {
    const put = (body: unknown) => app.request('/api/settings', json('PUT', body));
    expect((await put({ defaultCwd: 42 })).status).toBe(400);
    const file = join(project, 'file.txt');
    writeFileSync(file, '');
    expect((await put({ defaultCwd: file })).status).toBe(400);
    expect((await put({ defaultCwd: project })).status).toBe(200);
    expect((await put({ lead: { provider: 'claude', effort: 'not an effort!' } })).status).toBe(400);
    expect((await put({ lead: { provider: 'claude', model: 7 } })).status).toBe(400);
    expect((await put({ lead: { provider: 'claude', model: 'opus', effort: 'high' } })).status).toBe(200);

    const provider = (body: unknown) => app.request('/api/settings/providers/claude', json('PUT', body));
    expect((await provider({ bin: 123 })).status).toBe(400);
    expect((await provider({ defaultEffort: 'way too much effort' })).status).toBe(400);
    expect((await provider({ defaultModel: 'sonnet', defaultEffort: 'low' })).status).toBe(200);
  });
});

describe('POST /api/presets', () => {
  it('never takes the id of a built-in template', async () => {
    const res = await app.request(
      '/api/presets',
      json('POST', { id: 'builtin-general', name: 'Mine', agents: [{ name: 'A', provider: 'claude', role: '' }] }),
    );
    expect(res.status).toBe(200);
    const preset = (await res.json()) as { id: string };
    expect(preset.id).toMatch(/^user-/);
    const presets = (await (await get('/api/presets')).json()) as { id: string; name: string }[];
    expect(presets.filter((p) => p.id === 'builtin-general')).toHaveLength(1);
  });
});
