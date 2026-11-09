import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, SettingsView } from '../src/shared/types';

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
const { NativeSetupService } = await import('../src/server/native');
const { AgentsViewSync } = await import('../src/server/agentsview');
const { expandPath } = await import('../src/server/validate');

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
    expect((await provider({ nativeOff: 'skills' })).status).toBe(400);
    expect((await provider({ nativeOff: ['skills', 'rules'] })).status).toBe(400);
    const off = await provider({ nativeOff: ['mcp', 'skills'] });
    expect(off.status).toBe(200);
    const view = (await off.json()) as SettingsView;
    expect(view.providers.find((p) => p.provider === 'claude')!.nativeOff).toEqual(['skills', 'mcp']);
    const more = (await (await provider({ nativeOff: ['plugins', 'hooks', 'agents'] })).json()) as SettingsView;
    expect(more.providers.find((p) => p.provider === 'claude')!.nativeOff).toEqual(['hooks', 'agents', 'plugins']);

    // Single items: lists of ids by known kind.
    expect((await provider({ nativeItems: ['skills'] })).status).toBe(400);
    expect((await provider({ nativeItems: null })).status).toBe(400);
    expect((await provider({ nativeItems: { rules: ['x'] } })).status).toBe(400);
    expect((await provider({ nativeItems: { skills: 'commit' } })).status).toBe(400);
    expect((await provider({ nativeItems: { skills: [''] } })).status).toBe(400);
    expect((await provider({ nativeItems: { skills: [7] } })).status).toBe(400);
    expect((await provider({ nativeItems: { skills: ['x'.repeat(4097)] } })).status).toBe(400);
    expect((await provider({ nativeItems: { skills: Array.from({ length: 2001 }, (_, i) => `s${i}`) } })).status).toBe(400);
    const items = await provider({ nativeItems: { skills: ['commit'], mcpTools: ['mcp__local__fetch'], hooks: ['h1'] } });
    expect(items.status).toBe(200);
    const withItems = ((await items.json()) as SettingsView).providers.find((p) => p.provider === 'claude')!;
    expect(withItems.nativeItems).toEqual({ skills: ['commit'], mcpTools: ['mcp__local__fetch'] });
    expect(withItems.nativeOff).toEqual(['hooks', 'agents', 'plugins']);
  });

  it("sets the CLIs' own folder: created when missing, never the home folder itself", async () => {
    const put = (body: unknown) => app.request('/api/settings', json('PUT', body));
    const home = join(project, 'relay-agents');
    const set = await put({ agentHome: home });
    expect(set.status).toBe(200);
    expect(((await set.json()) as SettingsView).agentHome).toBe(home);
    expect(statSync(home).isDirectory()).toBe(true);

    expect((await put({ agentHome: '~' })).status).toBe(400);
    expect((await put({ agentHome: '/' })).status).toBe(400);
    expect((await put({ agentHome: 7 })).status).toBe(400);
    const file = join(project, 'plain.txt');
    writeFileSync(file, '');
    expect((await put({ agentHome: file })).status).toBe(400);

    const off = (await (await put({ agentHome: '  ' })).json()) as SettingsView;
    expect(off.agentHome).toBe('');
  });

  it("accepts AgentsView only on this computer, sends a renamed conversation, and shows the last update's failure", async () => {
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    const store = new Store(db);
    const hub = new Hub();
    const sent: string[] = [];
    // AgentsView is not running.
    const fetchImpl = (async (input: string | URL | Request) => {
      sent.push(new URL(String(input)).origin);
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    const agentsView = new AgentsViewSync(() => settings.agentsViewUrl, fetchImpl);
    const orchestrator = new Orchestrator(store, hub, settings, undefined, agentsView);
    const app = createApp({ store, settings, hub, orchestrator, providers: new ProviderService(settings), agentsView });
    const put = async (body: unknown) => app.request('/api/settings', json('PUT', body));

    for (const url of ['http://example.com:8080', 'ftp://127.0.0.1:21', 'http://me:secret@127.0.0.1:8080', 'not a url', 42]) {
      expect((await put({ agentsViewUrl: url })).status).toBe(400);
    }
    // Saved as its origin.
    expect(((await (await put({ agentsViewUrl: 'http://localhost:8080' })).json()) as SettingsView).agentsViewUrl).toBe('http://localhost:8080');
    expect(((await (await put({ agentsViewUrl: 'http://[::1]:8080' })).json()) as SettingsView).agentsViewUrl).toBe('http://[::1]:8080');
    const set = (await (await put({ agentsViewUrl: 'http://127.0.0.1:9999/sessions?x=1' })).json()) as SettingsView;
    expect(set.agentsViewUrl).toBe('http://127.0.0.1:9999');

    // Renaming sends the conversation (its title names the thread), here to an AgentsView that is down.
    const conv: Conversation = {
      id: 'conv-renamed',
      title: 'Old name',
      createdAt: 0,
      updatedAt: 0,
      agents: [{ id: 'a', name: 'Alice', provider: 'claude', role: '' }],
      settings: { mode: 'roundtable', rounds: 1, maxHops: 3, permission: 'read-only', cwd: project },
      messages: [{ id: 'm1', author: { kind: 'user' }, createdAt: 1, parts: [{ type: 'text', text: 'hello' }], status: 'done' }],
      agentState: {},
      worktrees: {},
    };
    store.create(conv);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await app.request(`/api/conversations/${conv.id}`, json('PATCH', { title: 'New name' }))).status).toBe(200);
      await agentsView.idle();
    } finally {
      warn.mockRestore();
    }
    expect(sent).toContain('http://127.0.0.1:9999');
    const failing = (await (await app.request('/api/settings', { headers: HOST })).json()) as SettingsView;
    expect(failing.agentsViewError).toBe('http://127.0.0.1:9999: ECONNREFUSED');

    // Another address: the old failure is not about it.
    const moved = (await (await put({ agentsViewUrl: 'http://127.0.0.1:8080' })).json()) as SettingsView;
    expect(moved.agentsViewError).toBeUndefined();
    const off = (await (await put({ agentsViewUrl: '' })).json()) as SettingsView;
    expect(off).toMatchObject({ agentsViewUrl: '' });
    expect(off.agentsViewError).toBeUndefined();
  });

  it('takes any http(s) address to open AgentsView, without changing where conversations go', async () => {
    const put = (body: unknown) => app.request('/api/settings', json('PUT', body));
    for (const link of ['javascript:alert(1)', 'ftp://my-computer.tail1234.ts.net', 'https://me:secret@my-computer.tail1234.ts.net', 'not a url', 7]) {
      expect((await put({ agentsViewLink: link })).status).toBe(400);
    }
    await put({ agentsViewUrl: 'http://127.0.0.1:9999' });
    const set = (await (await put({ agentsViewLink: ' https://my-computer.tail1234.ts.net:9999 ' })).json()) as SettingsView;
    expect(set).toMatchObject({ agentsViewLink: 'https://my-computer.tail1234.ts.net:9999/', agentsViewUrl: 'http://127.0.0.1:9999' });
    const off = (await (await put({ agentsViewLink: '' })).json()) as SettingsView;
    expect(off).toMatchObject({ agentsViewLink: '', agentsViewUrl: 'http://127.0.0.1:9999' });
  });

  it("keeps the CLIs' own folder out of Harness Relay's folder and the default working directory", async () => {
    const put = (body: unknown) => app.request('/api/settings', json('PUT', body));
    expect((await put({ agentHome: 'relay-agents' })).status).toBe(400); // relative
    expect((await put({ agentHome: join(process.cwd(), 'relay-agents-test') })).status).toBe(400);
    expect(existsSync(join(process.cwd(), 'relay-agents-test'))).toBe(false);
    expect((await put({ defaultCwd: project })).status).toBe(200);
    expect((await put({ agentHome: join(project, '.agents') })).status).toBe(400);
    // Changing the default working directory in the same request is checked against the new one.
    const other = join(root, `other-${n}`);
    mkdirSync(other, { recursive: true });
    expect((await put({ defaultCwd: other, agentHome: join(other, 'agents') })).status).toBe(400);
    expect((await put({ defaultCwd: other, agentHome: join(project, '.agents') })).status).toBe(200);
  });

  it("drops cached sign-in state and sign-ins in progress when the CLIs' folder changes, and not when it stays", async () => {
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    const store = new Store(db);
    const hub = new Hub();
    const providers = new ProviderService(settings);
    const invalidate = vi.spyOn(providers, 'invalidate');
    const cancelLogin = vi.spyOn(providers, 'cancelLogin');
    const app = createApp({ store, settings, hub, orchestrator: new Orchestrator(store, hub, settings), providers });
    const put = (body: unknown) => app.request('/api/settings', json('PUT', body));
    const home = join(project, 'homes');
    expect((await put({ agentHome: home })).status).toBe(200);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(cancelLogin.mock.calls.map((c) => c[0])).toEqual(['claude', 'codex', 'grok']);
    // The same folder spelled another way changes nothing.
    expect((await put({ agentHome: `${home}/` })).status).toBe(200);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("refuses to move the CLIs' folder while a conversation runs", async () => {
    const conv = await createConversation();
    await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { text: 'go' }));
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(true));
    const busy = await app.request('/api/settings', json('PUT', { agentHome: join(project, 'homes') }));
    expect(busy.status).toBe(409);
    expect(existsSync(join(project, 'homes'))).toBe(false); // nothing created for a refused change
    await app.request(`/api/conversations/${conv.id}/stop`, json('POST', {}));
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
    expect((await app.request('/api/settings', json('PUT', { agentHome: join(project, 'homes') }))).status).toBe(200);
  });

  it('reads ~ as the home folder, the Windows way too', () => {
    expect(expandPath('~')).toBe(homedir());
    expect(expandPath('~/.relay-agents')).toBe(join(homedir(), '.relay-agents'));
    expect(expandPath('~\\.relay-agents')).toBe(join(homedir(), '.relay-agents'));
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

describe('sidebar groups', () => {
  const create = (name: unknown, lang = 'en') => app.request('/api/groups', json('POST', { name }, { 'x-relay-lang': lang }));

  it('creates, renames and deletes groups, with names that tell them apart', async () => {
    const res = await create('  Front   end ');
    expect(res.status).toBe(200);
    const front = (await res.json()) as { id: string; name: string };
    expect(front.name).toBe('Front end');
    expect((await create('Docs')).status).toBe(200);

    // Names must be new, not empty, not too long, and not the default group's, in either language.
    for (const name of ['front END', '', '   ', 'x'.repeat(41), 'Other', '其他', 'other']) {
      const bad = await create(name);
      expect(bad.status, name).toBe(400);
    }
    expect(((await (await create('docs', 'zh-TW')).json()) as { error: string }).error).toBe('已經有叫「docs」的群組了');

    const renamed = await app.request(`/api/groups/${front.id}`, json('PATCH', { name: 'Web' }));
    expect(await renamed.json()).toEqual({ id: front.id, name: 'Web' });
    expect((await app.request(`/api/groups/${front.id}`, json('PATCH', { name: 'web' }))).status).toBe(200); // its own name
    expect((await app.request(`/api/groups/${front.id}`, json('PATCH', { name: 'Docs' }))).status).toBe(400);
    expect((await app.request('/api/groups/nope', json('PATCH', { name: 'x' }))).status).toBe(404);

    expect(((await (await get('/api/groups')).json()) as { name: string }[]).map((g) => g.name)).toEqual(['web', 'Docs']);
    expect((await app.request(`/api/groups/${front.id}`, json('DELETE', {}))).status).toBe(200);
    expect(((await (await get('/api/groups')).json()) as { name: string }[]).map((g) => g.name)).toEqual(['Docs']);
    expect((await app.request(`/api/groups/${front.id}`, json('DELETE', {}))).status).toBe(404);
  });

  it('moves a conversation between groups; deleting its group puts it in Other', async () => {
    const conv = await createConversation();
    const group = (await (await create('Docs')).json()) as { id: string };
    const move = (groupId: unknown) => app.request(`/api/conversations/${conv.id}/group`, json('PUT', { groupId }));
    const listed = async () =>
      ((await (await get('/api/conversations')).json()) as { id: string; groupId?: string }[]).find((c) => c.id === conv.id)!.groupId;

    expect((await move(group.id)).status).toBe(200);
    expect(await listed()).toBe(group.id);
    expect((await move('missing')).status).toBe(404);
    expect(await listed()).toBe(group.id);
    expect((await app.request('/api/conversations/nope/group', json('PUT', { groupId: group.id }))).status).toBe(404);

    expect((await move(null)).status).toBe(200);
    expect(await listed()).toBeUndefined();
    await move(group.id);
    await app.request(`/api/groups/${group.id}`, json('DELETE', {}));
    expect(await listed()).toBeUndefined();
  });
});

describe('GET /api/search', () => {
  it('finds conversations by title and by what was written in them', async () => {
    const conv = await createConversation();
    const stored = store.get(conv.id)!;
    stored.title = 'Release checklist';
    store.saveMeta(stored);
    const msg = { id: 'm1', author: { kind: 'user' as const }, createdAt: 1, parts: [{ type: 'text' as const, text: '部署到 staging 之前要跑測試' }], status: 'done' as const };
    stored.messages.push(msg);
    store.saveMessage(conv.id, msg, true);

    const search = async (q: string) => (await (await get(`/api/search?q=${encodeURIComponent(q)}`)).json()) as { id: string; snippet?: string }[];
    expect((await search('release')).map((r) => r.id)).toEqual([conv.id]);
    const [hit] = await search('staging 測試');
    expect(hit?.id).toBe(conv.id);
    expect(hit?.snippet).toBe('部署到 staging 之前要跑測試');
    expect(await search('production')).toEqual([]);
    expect(await search('')).toEqual([]);
  });
});

describe('tool library', () => {
  it('saves MCP servers with masked values and refuses bad input', async () => {
    const save = (name: string, body: unknown) => app.request(`/api/tools/mcp/${name}`, json('PUT', body, { 'x-relay-lang': 'en' }));
    const ok = await save('github', {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'gh'],
      env: [{ name: 'GITHUB_TOKEN', value: 'ghp_secret_value_123' }],
      providers: ['claude', 'grok'],
    });
    expect(ok.status).toBe(200);
    const view = await ok.json();
    expect(JSON.stringify(view)).not.toContain('ghp_secret_value_123');
    expect(view.mcpServers[0]).toMatchObject({ name: 'github', providers: ['claude', 'grok'], env: [{ name: 'GITHUB_TOKEN', masked: 'ghp…123' }] });
    expect(JSON.stringify(await (await get('/api/tools')).json())).not.toContain('ghp_secret_value_123');

    expect((await save('bad.name', { transport: 'stdio', command: 'x' })).status).toBe(400);
    expect((await save('x', { transport: 'stdio', command: '' })).status).toBe(400);
    expect((await save('x', { transport: 'http', url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await save('x', { transport: 'stdio', command: 'x', providers: ['gemini'] })).status).toBe(400);
    expect((await save('x', { transport: 'stdio', command: 'x', env: [{ name: 'A B', value: '1' }] })).status).toBe(400);
    expect((await save('GitHub', { transport: 'stdio', command: 'x' })).status).toBe(409);
    expect((await app.request('/api/tools/mcp/nope', { method: 'DELETE', headers: { ...HOST, 'content-type': 'application/json' } })).status).toBe(404);
    const del = await app.request('/api/tools/mcp/github', { method: 'DELETE', headers: { ...HOST, 'content-type': 'application/json' } });
    expect((await del.json()).mcpServers).toEqual([]);
  });

  it('saves skills and memory, and gives agents what applies to them', async () => {
    const skills = join(project, 'skills', 'commit');
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, 'SKILL.md'), '---\nname: commit\ndescription: Commit well.\n---\n');
    const res = await app.request(
      '/api/tools',
      json('PUT', { skills: [{ path: join(project, 'skills'), providers: ['codex'] }], memory: { all: 'Be brief.', claude: 'Use pnpm.' } }),
    );
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.skills).toEqual([{ path: skills, name: 'commit', description: 'Commit well.', providers: ['codex'] }]);
    expect(view.memory).toEqual({ all: 'Be brief.', claude: 'Use pnpm.', codex: '', grok: '' });
    expect((await app.request('/api/tools', json('PUT', { memory: { gemini: 'x' } }))).status).toBe(400);
    expect((await app.request('/api/tools', json('PUT', { memory: { all: 'x'.repeat(20_001) } }))).status).toBe(400);
    expect((await app.request('/api/tools', json('PUT', { skills: [{ path: join(project, 'nothing-here') }] }))).status).toBe(400);
  });

  it('lists the skills under a folder without adding them', async () => {
    for (const name of ['one', 'two']) {
      mkdirSync(join(project, 'pack', name), { recursive: true });
      writeFileSync(join(project, 'pack', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
    }
    const res = await get(`/api/tools/skills/scan?path=${encodeURIComponent(join(project, 'pack'))}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: join(project, 'pack'),
      skills: [
        { path: join(project, 'pack', 'one'), name: 'one', description: '', added: false },
        { path: join(project, 'pack', 'two'), name: 'two', description: '', added: false },
      ],
    });
    expect((await (await get('/api/tools')).json()).skills).toEqual([]);
    expect((await get('/api/tools/skills/scan?path=')).status).toBe(400);
  });

  it("keeps an agent's tool exceptions and drops unknown keys", async () => {
    const res = await app.request(
      '/api/conversations',
      json('POST', {
        agents: [{ name: 'Alice', provider: 'claude', role: '', tools: { 'mcp:github': false, memory: true, 'memory:codex': true, bogus: true, 'mcp:x': 'yes' } }],
        settings: { mode: 'roundtable', permission: 'read-only', cwd: project },
      }),
    );
    expect(res.status).toBe(200);
    const conv = (await res.json()) as Conversation;
    expect(conv.agents[0]!.tools).toEqual({ 'mcp:github': false, memory: true, 'memory:codex': true });
  });

  it("hands each agent its library items when it runs", async () => {
    writeFileSync(join(project, 'SKILL.md'), '---\nname: solo\n---\n');
    await app.request('/api/tools', json('PUT', { skills: [{ path: project }], memory: { all: 'Shared note.' } }));
    await app.request('/api/tools/mcp/gh', json('PUT', { transport: 'stdio', command: 'gh-mcp', env: [{ name: 'T', value: 'tok' }] }));
    const seen: { mcp: unknown; readDirs: unknown; briefing: string }[] = [];
    const before = runners.claude;
    runners.claude = {
      provider: 'claude',
      async run(o) {
        seen.push({ mcp: o.mcpServers, readDirs: o.readDirs, briefing: o.systemPrompt });
        o.onEvent({ type: 'text', text: 'ok' });
        return {};
      },
    };
    try {
      const conv = await createConversation({ permission: 'read-only' });
      await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { text: 'hi' }));
      await vi.waitFor(() => expect(seen).toHaveLength(1));
    } finally {
      runners.claude = before;
    }
    expect(seen[0]!.mcp).toEqual([{ name: 'gh', transport: 'stdio', command: 'gh-mcp', args: [], url: '', env: { T: 'tok' }, headers: {} }]);
    expect(seen[0]!.readDirs).toEqual([project]);
    expect(seen[0]!.briefing).toContain('Shared note.');
    expect(seen[0]!.briefing).toContain(`- solo (${join(project, 'SKILL.md')})`);
  });
});

describe('browsing files', () => {
  it('lists folders, previews text and serves images safely', async () => {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'src', 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(project, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const conv = await createConversation({ permission: 'read-only' });
    const base = `/api/conversations/${conv.id}/files`;

    const list = await (await get(`${base}?root=cwd&path=`)).json();
    expect(list.roots).toEqual([{ id: 'cwd', path: project }]);
    expect(list.entries.map((e: { name: string }) => e.name)).toEqual(['src', 'pic.png']);
    expect((await (await get(`${base}?path=src`)).json()).entries).toMatchObject([{ name: 'a.ts', kind: 'file', size: 13 }]);

    const preview = await (await get(`${base}/preview?path=src/a.ts`)).json();
    expect(preview).toMatchObject({ path: 'src/a.ts', kind: 'text', text: 'const a = 1;\n' });
    expect((await (await get(`${base}/preview?path=pic.png`)).json()).kind).toBe('image');

    const raw = await get(`${base}/raw?path=pic.png`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('image/png');
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect(raw.headers.get('content-security-policy')).toContain('sandbox');
    expect((await get(`${base}/raw?path=src/a.ts`)).status).toBe(404);

    for (const bad of ['..', '../..', '/etc/passwd', '.git', 'missing']) {
      expect((await get(`${base}?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
      expect((await get(`${base}/preview?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
    }
    expect((await get(`${base}?root=someone`)).status).toBe(404);
    expect((await get(`/api/conversations/nope/files`)).status).toBe(404);
    expect((await app.request(`${base}?path=`, { headers: { host: 'evil.example' } })).status).toBe(403);
  });
});

describe("what each CLI loads by itself", () => {
  it('asks the CLI for the default working directory, only from the app itself', async () => {
    const asked: [string, string, boolean][] = [];
    const reported: { path: string; kind: 'instructions' }[] = [];
    const answer = (provider: string, cwd: string) => ({
      provider,
      cwd,
      skills: [],
      mcpServers: [],
      memory: [...reported],
      memoryFromFiles: true,
      problems: [{ kind: 'timeout' }],
      checkedAt: 1,
    });
    const native = {
      get: async (provider: string, cwd: string, refresh = false) => {
        asked.push([provider, cwd, refresh]);
        return answer(provider, cwd);
      },
      // Opening a reported file checks the latest answer and does not start the CLI.
      latest: async (provider: string, cwd: string) => answer(provider, cwd),
    } as unknown as InstanceType<typeof NativeSetupService>;
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    settings.setDefaultCwd(project);
    const s = new Store(db);
    const hub = new Hub();
    const local = createApp({ store: s, settings, hub, orchestrator: new Orchestrator(s, hub, settings), providers: new ProviderService(settings), native });
    const call = (path: string, body: unknown = {}) => local.request(path, json('POST', body, { 'x-relay-lang': 'en' }));

    const res = await call('/api/providers/codex/native');
    expect(await res.json()).toEqual({
      provider: 'codex',
      cwd: project,
      skills: [],
      mcpServers: [],
      memory: [],
      memoryFromFiles: true,
      errors: ['Codex did not answer in time.'],
      checkedAt: 1,
    });
    // A folder cannot be chosen: other sites must not be able to start a CLI in one.
    await call('/api/providers/grok/native', { refresh: true, cwd: root });
    expect(asked.slice(0, 2)).toEqual([
      ['codex', project, false],
      ['grok', project, true],
    ]);
    expect((await call('/api/providers/gemini/native')).status).toBe(404);

    // Reading a reported file, and nothing else.
    const notes = join(project, 'CLAUDE.md');
    writeFileSync(notes, '# Notes\n');
    reported.push({ path: notes, kind: 'instructions' });
    const file = await call('/api/providers/claude/native/file', { path: notes });
    expect(await file.json()).toMatchObject({ path: notes, kind: 'text', text: '# Notes\n' });
    for (const path of [join(project, 'other.md'), '/etc/passwd', `${project}/../${project.split('/').pop()}/CLAUDE.md`, '']) {
      expect((await call('/api/providers/claude/native/file', { path })).status, path).toBe(404);
    }
    rmSync(notes);
    expect((await call('/api/providers/claude/native/file', { path: notes })).status).toBe(404);
    expect(asked).toHaveLength(2);

    // Not a GET, and not a form post: a page elsewhere cannot set it off.
    expect((await local.request('/api/providers/claude/native', { headers: HOST })).status).toBe(404);
    expect((await local.request('/api/providers/claude/native', { method: 'POST', headers: { ...HOST, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });
});

describe("Grok's folder trust", () => {
  /*
   * A stand-in for `grok inspect --json` that keys trust the way grok 1.0.77 does: on the repository
   * root (reported with a trailing `/`), else on the folder it runs in, links resolved either way.
   * With FAKE_GROK_REFUSE set it reports every folder untrusted, as an organisation policy would.
   */
  const FAKE_GROK = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cwd = process.cwd();
let root;
for (let d = cwd; ; d = path.dirname(d)) {
  if (fs.existsSync(path.join(d, '.git'))) { root = d; break; }
  if (path.dirname(d) === d) break;
}
let store = '';
try { store = fs.readFileSync(path.join(process.env.GROK_HOME, 'trusted_folders.toml'), 'utf8'); } catch {}
const trusted = !process.env.FAKE_GROK_REFUSE && store.includes('[folders.' + JSON.stringify(root || cwd) + ']\\ntrusted = true');
process.stdout.write(JSON.stringify({ cwd, projectRoot: root ? root + '/' : null, projectTrusted: trusted }));
`;

  it('trusts the folder Grok decides trust for: the repository root, links resolved', async () => {
    const home = join(root, `grok-home-${++n}`);
    const storeFile = join(home, 'trusted_folders.toml');
    const fakeGrok = join(root, `fake-grok-${n}`);
    writeFileSync(fakeGrok, FAKE_GROK, { mode: 0o755 });
    const repo = join(root, `repo-${n}`);
    const sub = join(repo, 'packages', 'app');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(sub, { recursive: true });
    const link = join(root, `link-${n}`);
    symlinkSync(project, link);
    const saved = { home: process.env.GROK_HOME, refuse: process.env.FAKE_GROK_REFUSE };
    process.env.GROK_HOME = home;
    delete process.env.FAKE_GROK_REFUSE;
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    settings.setDefaultCwd(project);
    const s = new Store(db);
    const hub = new Hub();
    // The real probe, running the stand-in.
    const native = new NativeSetupService({ bin: () => fakeGrok, env: () => settings.env('grok') });
    const local = createApp({ store: s, settings, hub, orchestrator: new Orchestrator(s, hub, settings), providers: new ProviderService(settings), native });
    const call = (body: unknown) => local.request('/api/providers/grok/folder-trust', json('POST', body, { 'x-relay-lang': 'en' }));
    try {
      // A folder outside a repository: trust is decided for that folder.
      expect(await (await call({})).json()).toEqual({ cwd: project, folder: project, above: false, trusted: false });

      // A repository's subfolder: the repository root is the one trusted, and the answer says it is above.
      expect(await (await call({ cwd: sub })).json()).toEqual({ cwd: sub, folder: repo, above: true, trusted: false });
      // Trusting a folder other than the one the user confirmed is refused, and nothing is written.
      const wrong = await call({ cwd: sub, trust: true, folder: sub });
      expect(wrong.status).toBe(409);
      expect((await wrong.json()).error).toContain(repo);
      expect(existsSync(storeFile)).toBe(false);
      expect(await (await call({ cwd: sub, trust: true, folder: repo })).json()).toEqual({ cwd: sub, folder: repo, above: true, trusted: true });
      const afterRepo = readFileSync(storeFile, 'utf8');
      expect(afterRepo).toContain(`[folders."${repo}"]`);
      expect(afterRepo).not.toContain(sub);

      // A folder reached through a link: its real path is the one trusted.
      expect(await (await call({ cwd: link })).json()).toEqual({ cwd: link, folder: project, above: false, trusted: false });

      // Grok does not take the entry (a policy): the store is put back as it was, byte for byte.
      process.env.FAKE_GROK_REFUSE = '1';
      const refused = await call({ cwd: link, trust: true, folder: project });
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toMatch(/undone/);
      expect(readFileSync(storeFile, 'utf8')).toBe(afterRepo);
      delete process.env.FAKE_GROK_REFUSE;

      expect(await (await call({ cwd: link, trust: true, folder: project })).json()).toEqual({ cwd: link, folder: project, above: false, trusted: true });
      expect(readFileSync(storeFile, 'utf8')).toContain(`[folders."${project}"]`);
      expect(readFileSync(storeFile, 'utf8')).not.toContain(link);

      expect((await call({ cwd: join(root, 'missing') })).status).toBe(404);
      expect((await local.request('/api/providers/grok/folder-trust', { method: 'POST', headers: { ...HOST, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    } finally {
      if (saved.home === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = saved.home;
      if (saved.refuse === undefined) delete process.env.FAKE_GROK_REFUSE;
      else process.env.FAKE_GROK_REFUSE = saved.refuse;
    }
  });

  it('removes the store again when there was none and Grok does not take the entry', async () => {
    const home = join(root, `grok-home-${++n}`);
    const fakeGrok = join(root, `fake-grok-${n}`);
    writeFileSync(fakeGrok, FAKE_GROK, { mode: 0o755 });
    const saved = { home: process.env.GROK_HOME, refuse: process.env.FAKE_GROK_REFUSE };
    process.env.GROK_HOME = home;
    process.env.FAKE_GROK_REFUSE = '1';
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    settings.setDefaultCwd(project);
    const s = new Store(db);
    const hub = new Hub();
    const native = new NativeSetupService({ bin: () => fakeGrok, env: () => settings.env('grok') });
    const local = createApp({ store: s, settings, hub, orchestrator: new Orchestrator(s, hub, settings), providers: new ProviderService(settings), native });
    try {
      const res = await local.request('/api/providers/grok/folder-trust', json('POST', { trust: true, folder: project }));
      expect(res.status).toBe(409);
      expect(existsSync(join(home, 'trusted_folders.toml'))).toBe(false);
    } finally {
      if (saved.home === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = saved.home;
      if (saved.refuse === undefined) delete process.env.FAKE_GROK_REFUSE;
      else process.env.FAKE_GROK_REFUSE = saved.refuse;
    }
  });
});

describe('schedules', () => {
  const HOUR = 3_600_000;
  const valid = { text: 'check the build', repeat: { kind: 'daily', time: '09:00' }, timeZone: 'UTC' };
  const put = (id: string, b: unknown) => app.request(`/api/conversations/${id}/schedule`, json('PUT', b, { 'x-relay-lang': 'en' }));

  it('saves a schedule, works out when it sends next, and shows it with the conversation', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const before = Date.now();
    const res = await put(conv.id, valid);
    expect(res.status).toBe(200);
    const saved = (await res.json()) as NonNullable<Conversation['schedule']>;
    expect(saved).toMatchObject({ text: 'check the build', enabled: true, approvals: 'deny', missed: 'skip', lang: 'en', timeZone: 'UTC' });
    expect(saved.nextRunAt! - before).toBeGreaterThan(0);
    expect(saved.nextRunAt! - before).toBeLessThanOrEqual(24 * HOUR);
    expect(new Date(saved.nextRunAt!).getUTCHours()).toBe(9);

    expect(((await (await get(`/api/conversations/${conv.id}`)).json()) as Conversation).schedule).toEqual(saved);
    const list = (await (await get('/api/conversations')).json()) as { id: string; schedule?: unknown }[];
    expect(list.find((c) => c.id === conv.id)!.schedule).toEqual({ enabled: true, nextRunAt: saved.nextRunAt });

    // Switched off, it has no next time; deleted, it is gone.
    const off = (await (await put(conv.id, { ...valid, enabled: false })).json()) as NonNullable<Conversation['schedule']>;
    expect(off.enabled).toBe(false);
    expect(off.nextRunAt).toBeUndefined();
    expect((await app.request(`/api/conversations/${conv.id}/schedule`, json('DELETE', {}))).status).toBe(200);
    expect(((await (await get(`/api/conversations/${conv.id}`)).json()) as Conversation).schedule).toBeUndefined();
  });

  it('refuses a schedule that could never send, and one for a team that is not confirmed yet', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const bad = await put(conv.id, { ...valid, repeat: { kind: 'weekly', time: '09:00', days: [] } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/at least one day/);
    expect((await put('missing', valid)).status).toBe(404);

    const res = await app.request(
      '/api/conversations',
      json('POST', { settings: { autoTeam: true, mode: 'roundtable', permission: 'read-only', cwd: project } }),
    );
    const auto = (await res.json()) as Conversation;
    const refused = await put(auto.id, valid);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Confirm the team/);
    expect((await put(auto.id, { ...valid, enabled: false })).status).toBe(200); // kept off until there is a team
  });

  it('runs the schedule now: sent, then waiting while the team replies, then held back', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const run = () => app.request(`/api/conversations/${conv.id}/schedule/run`, json('POST', {}, { 'x-relay-lang': 'en' }));
    expect((await run()).status).toBe(404); // no schedule yet
    await put(conv.id, valid);

    const first = await run();
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ ok: true, queued: false });
    expect(orchestrator.isRunning(conv.id)).toBe(true);
    expect(await (await run()).json()).toEqual({ ok: true, queued: true });
    const third = await run();
    expect(third.status).toBe(409);
    expect(((await third.json()) as { error: string }).error).toBe('The previous scheduled message is still waiting to be delivered');

    const live = store.get(conv.id)!;
    expect(live.messages[0]).toMatchObject({ scheduled: true });
    expect(live.queue).toEqual([expect.objectContaining({ scheduled: true })]);
    expect(live.schedule!.lastResult).toBeUndefined(); // running it by hand leaves the schedule's record as it is
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
  });

  it('refuses a schedule while the team design waits for confirmation', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const live = store.get(conv.id)!;
    live.messages.push({
      id: 'plan',
      author: { kind: 'system' },
      createdAt: 1,
      parts: [],
      status: 'done',
      plan: { status: 'ready', lead: { provider: 'claude' }, source: 'template', name: 'x', agents: [], awaitingConfirmation: true },
    });
    expect((await put(conv.id, valid)).status).toBe(409);
  });

  it("keeps how it went last time across a save, and an interval's cadence while its times stay the same", async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const every6 = { ...valid, repeat: { kind: 'interval', hours: 6 } };
    const first = (await (await put(conv.id, every6)).json()) as NonNullable<Conversation['schedule']>;
    const live = store.get(conv.id)!;
    Object.assign(live.schedule!, { lastRunAt: 5, lastResult: 'failed', lastError: 'boom' });

    const renamed = (await (await put(conv.id, { ...every6, text: 'another message' })).json()) as NonNullable<Conversation['schedule']>;
    expect(renamed).toMatchObject({ text: 'another message', updatedAt: first.updatedAt, nextRunAt: first.nextRunAt });
    expect(renamed).toMatchObject({ lastRunAt: 5, lastResult: 'failed', lastError: 'boom' });

    await new Promise((r) => setTimeout(r, 5));
    const retimed = (await (await put(conv.id, { ...every6, repeat: { kind: 'interval', hours: 2 } })).json()) as NonNullable<
      Conversation['schedule']
    >;
    expect(retimed.updatedAt).toBeGreaterThan(first.updatedAt); // new times: a new cadence
    expect(retimed.nextRunAt).toBe(retimed.updatedAt + 2 * HOUR);
  });

  it('runs a switched-off schedule now, and says why when the conversation is busy', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const run = () => app.request(`/api/conversations/${conv.id}/schedule/run`, json('POST', {}, { 'x-relay-lang': 'en' }));
    await put(conv.id, { ...valid, enabled: false });
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    const busy = await run();
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toBe('The conversation was busy with a settings change or an apply');
    release();
    await held;
    expect((await run()).status).toBe(202);
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
  });
});
