import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
let store: InstanceType<typeof Store>;
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
  store = new Store(db);
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

  it('creates a missing default directory only when asked to', async () => {
    const put = (body: unknown) => app.request('/api/settings', json('PUT', body));
    const dir = join(project, 'new', 'chats');
    const missing = await put({ defaultCwd: dir });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code?: string }).code).toBe('cwd-missing');
    expect(existsSync(dir)).toBe(false);

    // A bad lead is refused before anything is created.
    expect((await put({ defaultCwd: dir, createCwd: true, lead: { provider: 'nope' } })).status).toBe(400);
    expect(existsSync(dir)).toBe(false);

    const created = await put({ defaultCwd: dir, createCwd: true });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { defaultCwd: string }).defaultCwd).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    // Saving an existing directory again is fine.
    expect((await put({ defaultCwd: dir, createCwd: true })).status).toBe(200);

    // A path through a file cannot be created.
    const file = join(project, 'plain.txt');
    writeFileSync(file, '');
    expect((await put({ defaultCwd: file, createCwd: true })).status).toBe(400);
    expect((await put({ defaultCwd: join(file, 'sub'), createCwd: true })).status).toBe(400);
  });

  it('creates a missing conversation directory only when asked to, after checking the team', async () => {
    const post = (body: Record<string, unknown>) => app.request('/api/conversations', json('POST', body));
    const agents = [{ name: 'Alice', provider: 'claude', role: '' }];
    const dir = join(project, 'brand', 'new');
    expect((await post({ agents, settings: { cwd: dir } })).status).toBe(404);
    expect(existsSync(dir)).toBe(false);

    // An invalid team is refused before anything is created.
    expect((await post({ agents: [{ name: 'Bad name!', provider: 'claude' }], settings: { cwd: dir }, createCwd: true })).status).toBe(400);
    expect(existsSync(dir)).toBe(false);

    const res = await post({ agents, settings: { cwd: dir }, createCwd: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Conversation).settings.cwd).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);

    // Auto team needs no agents, and still creates the directory.
    const auto = join(project, 'auto', 'team');
    expect((await post({ settings: { cwd: auto, autoTeam: true }, createCwd: true })).status).toBe(200);
    expect(statSync(auto).isDirectory()).toBe(true);
  });

  it('creates a missing directory when the team settings change, only when asked to', async () => {
    const conv = await createConversation();
    const patch = (id: string, body: Record<string, unknown>) => app.request(`/api/conversations/${id}`, json('PATCH', body));
    const dir = join(project, 'moved', 'here');
    const settings = { ...conv.settings, cwd: dir };

    const missing = await patch(conv.id, { settings });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code?: string }).code).toBe('cwd-missing');
    expect(existsSync(dir)).toBe(false);
    // A conversation that does not exist is also a 404, but not about the directory.
    const gone = await patch('no-such-conversation', { settings, createCwd: true });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code?: string }).code).toBeUndefined();
    expect(existsSync(dir)).toBe(false);

    // An invalid team is refused before anything is created.
    expect((await patch(conv.id, { agents: [{ name: 'Bad name!', provider: 'claude' }], settings, createCwd: true })).status).toBe(400);
    expect(existsSync(dir)).toBe(false);

    const res = await patch(conv.id, { settings, createCwd: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Conversation).settings.cwd).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
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

describe('images and videos in replies', () => {
  async function replyIn(): Promise<{ conv: Conversation; base: string }> {
    const conv = await createConversation({ permission: 'read-only' });
    const live = store.get(conv.id)!;
    const msg = { id: 'reply-1', author: { kind: 'agent' as const, agentId: live.agents[0]!.id }, createdAt: Date.now(), parts: [], status: 'done' as const };
    live.messages.push(msg);
    mkdirSync(join(project, 'out'), { recursive: true });
    writeFileSync(join(project, 'out', 'chart.png'), 'not really a png');
    writeFileSync(join(project, 'out', 'demo.mp4'), '0123456789');
    writeFileSync(join(project, 'notes.txt'), 'secret');
    return { conv, base: `/api/conversations/${conv.id}/messages/reply-1/media?path=` };
  }

  it('serves media files from the working directory so they cannot run in the app', async () => {
    const { base } = await replyIn();
    const res = await get(base + encodeURIComponent('out/chart.png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(await res.text()).toBe('not really a png');
    const absolute = await get(base + encodeURIComponent(join(project, 'out', 'chart.png')));
    expect(absolute.status).toBe(200);
    // Unchanged since: no body again.
    expect((await get(base + 'out/chart.png', { 'if-none-match': res.headers.get('etag')! })).status).toBe(304);
  });

  it('serves video in byte ranges', async () => {
    const { base } = await replyIn();
    const res = await get(base + 'out/demo.mp4', { range: 'bytes=2-5' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await res.text()).toBe('2345');
    expect((await get(base + 'out/demo.mp4', { range: 'bytes=50-' })).status).toBe(416);
  });

  it('refuses anything else', async () => {
    const { conv, base } = await replyIn();
    expect((await get(base + 'notes.txt')).status).toBe(404);
    expect((await get(base + encodeURIComponent('../' + 'x.png'))).status).toBe(404);
    expect((await get(base + 'missing.png')).status).toBe(404);
    expect((await get(base)).status).toBe(404);
    expect((await get(`/api/conversations/${conv.id}/messages/nope/media?path=out/chart.png`)).status).toBe(404);
    expect((await get(base + 'out/chart.png', { origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('a team design waiting for confirmation', () => {
  async function waiting(): Promise<Conversation> {
    const conv = await createConversation({ permission: 'read-only' });
    const live = store.get(conv.id)!;
    live.messages.push(
      { id: 'req', author: { kind: 'user' }, createdAt: Date.now(), parts: [{ type: 'text', text: 'I need a team' }], status: 'done' },
      {
        id: 'plan',
        author: { kind: 'system' },
        createdAt: Date.now(),
        parts: [],
        status: 'done',
        plan: { status: 'ready', lead: { provider: 'claude' }, source: 'template', name: 'x', agents: live.agents, awaitingConfirmation: true },
      },
    );
    return conv;
  }

  it('holds messages until it is confirmed, then the team answers them', async () => {
    const conv = await waiting();
    const send = () => app.request(`/api/conversations/${conv.id}/messages`, json('POST', { text: 'first question' }));
    const sent = await send();
    expect(sent.status).toBe(202);
    expect(await sent.json()).toEqual({ ok: true, queued: true });
    expect(store.get(conv.id)!.queue).toHaveLength(1);
    expect(orchestrator.isRunning(conv.id)).toBe(false);

    const res = await app.request(`/api/conversations/${conv.id}/messages/plan/confirm-plan`, json('POST', {}));
    expect(res.status).toBe(200);
    expect(store.get(conv.id)!.messages[1]!.plan).toMatchObject({ confirmedAt: expect.any(Number) });
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(true));
    expect(store.get(conv.id)!.messages[2]).toMatchObject({ parts: [{ type: 'text', text: 'first question' }] });
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
    expect((await app.request(`/api/conversations/${conv.id}/messages/nope/confirm-plan`, json('POST', {}))).status).toBe(404);
  });

  it('is confirmed by a team set by hand', async () => {
    const conv = await waiting();
    const res = await app.request(
      `/api/conversations/${conv.id}`,
      json('PATCH', { agents: [{ name: 'Zed', provider: 'claude', role: 'Mine.' }] }),
    );
    expect(res.status).toBe(200);
    expect(store.get(conv.id)!.messages[1]!.plan!.awaitingConfirmation).toBeUndefined();
  });
});

describe('messages sent while the team replies', () => {
  it('wait in the queue, can be withdrawn, and interrupt sends one now', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const send = (b: Record<string, unknown>) => app.request(`/api/conversations/${conv.id}/messages`, json('POST', b));
    const withdraw = (messageId: string) =>
      app.request(`/api/conversations/${conv.id}/queue/${messageId}`, { method: 'DELETE', headers: { ...HOST, 'content-type': 'application/json' } });
    expect(await (await send({ text: 'go' })).json()).toEqual({ ok: true, queued: false });
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toHaveLength(1));

    const queued = await send({ text: 'and this' });
    expect(queued.status).toBe(202);
    expect(await queued.json()).toEqual({ ok: true, queued: true });
    const waiting = store.get(conv.id)!.queue![0]!;
    const taken = await withdraw(waiting.id);
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ id: waiting.id, parts: [{ type: 'text', text: 'and this' }], queued: true });
    expect(store.get(conv.id)!.queue).toEqual([]);
    expect((await withdraw(waiting.id)).status).toBe(404);

    // Stop the team and send this now.
    expect(await (await send({ text: 'do this instead', interrupt: true })).json()).toEqual({ ok: true, queued: false });
    const live = store.get(conv.id)!;
    expect(live.messages.map((m) => m.author.kind)).toEqual(['user', 'agent', 'system', 'user', 'agent']);
    expect(live.messages[1]!.status).toBe('aborted');
    expect(live.messages[3]!.parts).toEqual([{ type: 'text', text: 'do this instead' }]);
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
  });
});
