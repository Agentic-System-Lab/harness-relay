import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_LIMITS,
  SHARE_FILES_MAX,
  SHARE_FILES_MAX_BYTES,
  SHARE_FILE_MAX_BYTES,
  SHARE_FILE_REFUSED,
  SHARE_FILE_URL_MAX,
  SHARE_MAX_BYTES,
  type Conversation,
  type ConversationSummary,
  type SettingsView,
  type ShareFileInfo,
  type TeamRevision,
  type WorkingDirectories,
} from '../src/shared/types';
import { shareFileHref } from '../src/shared/share';

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
const { expandPath, sameFolder } = await import('../src/server/validate');
const { attachmentsDir } = await import('../src/server/attachments');
const { readZip } = await import('./zipReader');
const { REVISER_BRIEFING } = await import('../src/server/planner');
const { ShareError } = await import('../src/server/share');

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
  app = createApp({ auth: null, store, settings, hub, orchestrator, providers: new ProviderService(settings) });
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
    const app = createApp({ auth: null, store, settings, hub, orchestrator, providers: new ProviderService(settings), agentsView });
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
    const app = createApp({ auth: null, store, settings, hub, orchestrator: new Orchestrator(store, hub, settings), providers });
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

  it('tells the same folder written another way: a trailing slash, .., ~, a symlink', () => {
    expect(sameFolder(`${project}/`, project)).toBe(true);
    expect(sameFolder(join(project, 'x', '..'), project)).toBe(true);
    expect(sameFolder('~', homedir())).toBe(true);
    const link = join(root, `link-${n}`);
    symlinkSync(project, link);
    expect(sameFolder(link, project)).toBe(true);
    expect(sameFolder(join(project, 'other'), project)).toBe(false);
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
    // Seeking is never turned into a whole download (If-Range applies to downloads only).
    expect((await get(base + 'out/demo.mp4', { range: 'bytes=2-5', 'if-range': 'W/"x"' })).status).toBe(206);
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

describe('files replies link to', () => {
  async function replyIn(): Promise<{ conv: Conversation; base: string }> {
    const conv = await createConversation({ permission: 'read-only' });
    const live = store.get(conv.id)!;
    live.messages.push({ id: 'reply-1', author: { kind: 'agent', agentId: live.agents[0]!.id }, createdAt: Date.now(), parts: [], status: 'done' });
    mkdirSync(join(project, 'out'), { recursive: true });
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, 'out', 'Q3 報告.pdf'), '%PDF-1.7 0123456789');
    writeFileSync(join(project, 'out', 'slides.html'), '<script>alert(1)</script>');
    writeFileSync(join(project, '.git', 'config'), 'secret');
    return { conv, base: `/api/conversations/${conv.id}/messages/reply-1/download?path=` };
  }

  it('serves any file in the working directory as a download that cannot run in the app', async () => {
    const { base } = await replyIn();
    const res = await get(base + encodeURIComponent('out/Q3 報告.pdf'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Q3 __.pdf"; filename*=UTF-8''${encodeURIComponent('Q3 報告.pdf')}`);
    expect(res.headers.get('content-length')).toBe('19');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(await res.text()).toBe('%PDF-1.7 0123456789');
    // An HTML file is a download too, never a page in this origin.
    const html = await get(base + 'out/slides.html');
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
    expect(html.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect((await get(base + encodeURIComponent(join(project, 'out', 'slides.html')))).status).toBe(200);
    // A download that was cut off can go on where it stopped, unless the file changed since.
    const pdf = base + encodeURIComponent('out/Q3 報告.pdf');
    const since = res.headers.get('last-modified')!;
    const rest = await get(pdf, { range: 'bytes=9-', 'if-range': since });
    expect(rest.status).toBe(206);
    expect(await rest.text()).toBe('0123456789');
    const changed = await get(pdf, { range: 'bytes=9-', 'if-range': 'Thu, 01 Jan 2015 00:00:00 GMT' });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe('%PDF-1.7 0123456789');
    // A weak ETag may not be used for If-Range: the whole file again.
    expect((await get(pdf, { range: 'bytes=9-', 'if-range': res.headers.get('etag')! })).status).toBe(200);
    expect((await get(pdf, { range: 'bytes=50-' })).status).toBe(416);
    expect((await get(pdf, { 'if-none-match': res.headers.get('etag')! })).status).toBe(304);
  });

  it('answers HEAD with the headers only, so the chat can check a link first', async () => {
    const { base } = await replyIn();
    const head = await app.request(base + 'out/slides.html', { method: 'HEAD', headers: HOST });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('25');
    expect(head.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(await head.text()).toBe('');
    expect((await app.request(base + 'out/missing.pdf', { method: 'HEAD', headers: HOST })).status).toBe(404);
  });

  // A stream reads ahead 64 KiB: a smaller file closes by itself, a larger one stayed open for good.
  it.skipIf(process.platform === 'win32')('opens no file for HEAD, so checking links leaves nothing open', async () => {
    const { base } = await replyIn();
    writeFileSync(join(project, 'out', 'big.pptx'), Buffer.alloc(1024 * 1024, 1));
    const open = () => readdirSync('/dev/fd').length;
    const before = open();
    for (let i = 0; i < 40; i++) {
      const res = await app.request(base + 'out/big.pptx', { method: 'HEAD', headers: HOST });
      expect(res.headers.get('content-length')).toBe(String(1024 * 1024));
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(open() - before).toBeLessThan(10);
  });

  it("serves an isolated turn's file from the agent's own worktree, and attached files", async () => {
    const { conv, base } = await replyIn();
    const live = store.get(conv.id)!;
    const agentId = live.agents[0]!.id;
    const wt = join(root, `worktree-${n}`);
    mkdirSync(join(wt, 'out'), { recursive: true });
    writeFileSync(join(wt, 'out', 'slides.html'), 'from the worktree');
    live.worktrees[agentId] = { root: project, path: wt, branch: 'relay/x', base: 'b', needsReset: false };
    const reply = live.messages.find((m) => m.id === 'reply-1')!;
    reply.changes = { root: project, base: 'b', head: 'h', files: [], isolated: true };
    expect(await (await get(base + 'out/slides.html')).text()).toBe('from the worktree');
    // Not yet applied, so only the worktree has it; a shared turn looks in the working directory first.
    writeFileSync(join(wt, 'out', 'only-here.csv'), 'a,b');
    expect((await get(base + 'out/only-here.csv')).status).toBe(200);
    reply.changes = { ...reply.changes, isolated: false };
    expect(await (await get(base + 'out/slides.html')).text()).toBe('<script>alert(1)</script>');

    const attached = join(attachmentsDir(conv.id), 'att-1', 'brief.docx');
    mkdirSync(join(attachmentsDir(conv.id), 'att-1'), { recursive: true });
    writeFileSync(attached, 'docx');
    expect(await (await get(base + encodeURIComponent(attached))).text()).toBe('docx');
  });

  it('works through a host name the server was told to allow, such as its Tailscale name', async () => {
    const { base } = await replyIn();
    // As started with RELAY_ALLOWED_HOSTS=my-computer.tail1234.ts.net, behind `tailscale serve`.
    const settings = new SettingsStore(openDatabase(':memory:'));
    app = createApp({ auth: null, store, settings, hub: new Hub(), orchestrator, providers: new ProviderService(settings), extraHosts: ['my-computer.tail1234.ts.net'] });
    const viaTailnet = (host: string) => app.request(base + 'out/slides.html', { headers: { host } });
    expect((await viaTailnet('my-computer.tail1234.ts.net')).status).toBe(200);
    expect((await viaTailnet('my-computer.tail1234.ts.net:443')).status).toBe(200);
    expect((await viaTailnet('other.tail1234.ts.net')).status).toBe(403);
  });

  it('refuses files outside the working directory, in .git, folders and unknown messages', async () => {
    const { conv, base } = await replyIn();
    writeFileSync(join(root, `outside-${n}.pdf`), 'pdf');
    for (const bad of ['', 'out', 'missing.pdf', '.git/config', '.GIT/config', `../outside-${n}.pdf`, join(root, `outside-${n}.pdf`)]) {
      expect((await get(base + encodeURIComponent(bad))).status, bad).toBe(404);
    }
    expect((await get(`/api/conversations/${conv.id}/messages/nope/download?path=out/slides.html`)).status).toBe(404);
    expect((await get(base + 'out/slides.html', { origin: 'https://evil.example' })).status).toBe(403);
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

  it('can be declined: the current team stays and answers', async () => {
    const conv = await waiting();
    const live = store.get(conv.id)!;
    live.messages[1]!.plan!.agents = [{ id: 'z', name: 'Zed', provider: 'claude', role: '' }];
    const res = await app.request(`/api/conversations/${conv.id}/messages/plan/decline-plan`, json('POST', {}));
    expect(res.status).toBe(200);
    expect(live.messages[1]!.plan).toMatchObject({ declinedAt: expect.any(Number) });
    expect(live.agents.map((a) => a.name)).toEqual(['Alice']);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(true));
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
    expect((await app.request(`/api/conversations/${conv.id}/messages/nope/decline-plan`, json('POST', {}))).status).toBe(404);
  });

  it('is confirmed by a team set by hand, which then answers', async () => {
    const conv = await waiting();
    const res = await app.request(
      `/api/conversations/${conv.id}`,
      json('PATCH', { agents: [{ name: 'Zed', provider: 'claude', role: 'Mine.' }] }),
    );
    expect(res.status).toBe(200);
    expect(store.get(conv.id)!.messages[1]!.plan!.awaitingConfirmation).toBeUndefined();
    // The team set by hand is the one that answers, not the design.
    expect(store.get(conv.id)!.agents.map((a) => a.name)).toEqual(['Zed']);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(true));
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
  });

  it("is changed by the lead agent at the user's request, then saved: the changed team answers", async () => {
    const conv = await waiting();
    const live = store.get(conv.id)!;
    const before = runners.claude;
    const briefings: string[] = [];
    runners.claude = {
      provider: 'claude',
      async run(o) {
        if (o.systemPrompt === REVISER_BRIEFING) {
          const team = { agents: [{ name: 'Alice', provider: 'claude' }, { name: 'Tester', provider: 'claude', role: 'Test it.' }], reason: 'Added a tester.' };
          o.onEvent({ type: 'text', text: JSON.stringify(team) });
          return {};
        }
        briefings.push(o.systemPrompt);
        if (!o.signal?.aborted) await new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }));
        throw new AgentRunError('stopped', true);
      },
    };
    try {
      const plan = live.messages[1]!.plan!;
      const res = await app.request(
        `/api/conversations/${conv.id}/revise-team`,
        json('POST', { request: 'add a tester', agents: plan.agents, settings: { mode: 'roundtable', rounds: 1, maxHops: 8 } }),
      );
      const revised = (await res.json()) as TeamRevision;
      // Nothing changes until it is saved: the design still waits.
      expect(live.messages[1]!.plan!.awaitingConfirmation).toBe(true);
      expect(live.agents.map((a) => a.name)).toEqual(['Alice']);

      const saved = await app.request(`/api/conversations/${conv.id}`, json('PATCH', { agents: revised.agents }));
      expect(saved.status).toBe(200);
      expect(live.messages[1]!.plan!.awaitingConfirmation).toBeUndefined();
      expect(live.agents.map((a) => [a.id, a.name])).toEqual([
        [conv.agents[0]!.id, 'Alice'],
        [revised.agents[1]!.id, 'Tester'],
      ]);
      // The changed team answers the question its design was for.
      await vi.waitFor(() => expect(briefings).toHaveLength(1));
      expect(briefings[0]).toContain('You are @Alice');
      expect(briefings[0]).toContain('@Tester');
    } finally {
      orchestrator.stop(conv.id);
      await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
      runners.claude = before;
    }
  });

  it('keeps auto team on when the team or settings are changed by hand, and saves whether to ask', async () => {
    const res = await app.request(
      '/api/conversations',
      json('POST', { settings: { autoTeam: true, mode: 'roundtable', permission: 'read-only', cwd: project } }),
    );
    const conv = (await res.json()) as Conversation;
    expect(conv.settings).toMatchObject({ autoTeam: true });
    expect(conv.settings.autoConfirm).toBeUndefined();
    const patch = (body: Record<string, unknown>) => app.request(`/api/conversations/${conv.id}`, json('PATCH', body));

    // The settings, without autoTeam (the drawer may leave it out): it stays on; autoConfirm follows.
    const patched = (await (await patch({ settings: { ...conv.settings, autoTeam: undefined, autoConfirm: true } })).json()) as Conversation;
    expect(patched.settings).toMatchObject({ autoTeam: true, autoConfirm: true });
    // A team set by hand does not switch it off either.
    const team = (await (await patch({ agents: [{ name: 'Zed', provider: 'claude', role: '' }] })).json()) as Conversation;
    expect(team.settings).toMatchObject({ autoTeam: true, autoConfirm: true });
    // Nor can an edit switch it on in a conversation without it.
    const fixed = await createConversation({ permission: 'read-only' });
    const on = await app.request(`/api/conversations/${fixed.id}`, json('PATCH', { settings: { ...fixed.settings, autoTeam: true } }));
    expect(((await on.json()) as Conversation).settings.autoTeam).toBeUndefined();
  });
});

describe('POST /api/conversations/:id/revise-team', () => {
  const revise = (id: string, body: unknown, init: RequestInit = {}) =>
    app.request(`/api/conversations/${id}/revise-team`, { ...json('POST', body, { 'x-relay-lang': 'en' }), ...init });

  it("returns the lead agent's change to the team sent, and saves nothing", async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const before = runners.claude;
    let prompt = '';
    runners.claude = {
      provider: 'claude',
      async run(o) {
        prompt = o.prompt;
        const team = {
          mode: 'parallel',
          rounds: 2,
          agents: [
            { name: 'Alice', provider: 'claude', role: 'Lead.' },
            { name: 'Bob', provider: 'claude', role: 'Check.' },
          ],
          reason: 'Added Bob.',
        };
        o.onEvent({ type: 'text', text: JSON.stringify(team) });
        return {};
      },
    };
    try {
      const res = await revise(conv.id, { request: 'add Bob', agents: conv.agents, settings: conv.settings });
      expect(res.status).toBe(200);
      const r = (await res.json()) as TeamRevision;
      expect(r).toMatchObject({ reason: 'Added Bob.', settings: { mode: 'parallel', rounds: 2, maxHops: conv.settings.maxHops } });
      expect(r.agents.map((a) => a.name)).toEqual(['Alice', 'Bob']);
      expect(r.agents[0]!.id).toBe(conv.agents[0]!.id);
      expect(prompt).toContain('<request>\nadd Bob\n</request>');
    } finally {
      runners.claude = before;
    }
    const saved = (await (await get(`/api/conversations/${conv.id}`)).json()) as Conversation;
    expect(saved.agents).toEqual(conv.agents);
    expect(saved.settings).toEqual(conv.settings);

    const empty = await revise(conv.id, { request: ' ', agents: conv.agents, settings: conv.settings });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe('Say how the team should change first');
  });

  it("refuses to change the CLIs' own folder while the lead agent changes a team", async () => {
    // The fake CLI waits until it is stopped.
    const conv = await createConversation({ permission: 'read-only' });
    const closed = new AbortController();
    const res = revise(conv.id, { request: 'more', agents: conv.agents, settings: conv.settings }, { signal: closed.signal });
    await vi.waitFor(() => expect(orchestrator.anyRunning()).toBe(true));
    const busy = await app.request('/api/settings', json('PUT', { agentHome: join(project, 'agents') }, { 'x-relay-lang': 'en' }));
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toContain('changing a team');
    closed.abort();
    expect((await res).status).toBe(409);
  });

  it('stops the lead agent when the request is closed', async () => {
    // The fake CLI waits until it is stopped.
    const conv = await createConversation({ permission: 'read-only' });
    const closed = new AbortController();
    const res = revise(conv.id, { request: 'more', agents: conv.agents, settings: conv.settings }, { signal: closed.signal });
    await vi.waitFor(() => expect(orchestrator.anyRunning()).toBe(true));
    closed.abort();
    expect((await res).status).toBe(409);
    expect(orchestrator.anyRunning()).toBe(false);
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

describe('POST /api/conversations/:id/messages/:messageId/branch', () => {
  it('answers with a new conversation holding the messages up to the reply, and refuses the user\'s messages', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    await app.request(`/api/conversations/${conv.id}/messages`, json('POST', { text: 'go' }));
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toHaveLength(1));
    const [question, reply] = store.get(conv.id)!.messages;
    const branch = (messageId: string, headers: Record<string, string> = {}) =>
      app.request(`/api/conversations/${conv.id}/messages/${messageId}/branch`, json('POST', {}, headers));
    // Not from a reply still being written.
    expect((await branch(reply!.id)).status).toBe(409);
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));

    const res = await branch(reply!.id, { 'X-Relay-Lang': 'en' });
    expect(res.status).toBe(200);
    const made = (await res.json()) as Conversation;
    expect(made.title).toBe('Branch · go');
    expect(made.messages.map((m) => m.author.kind)).toEqual(['user', 'agent']);
    expect(made.branch).toEqual({ fromId: conv.id, fromTitle: 'go', afterId: made.messages[1]!.id });
    expect(store.get(made.id)!.agentState).toEqual({});
    const list = (await (await get('/api/conversations')).json()) as { id: string }[];
    expect(list.map((c) => c.id)).toContain(made.id);

    expect((await branch(question!.id)).status).toBe(400);
    expect((await branch('nope')).status).toBe(404);
    orchestrator.stopAll();
    expect((await branch(reply!.id)).status).toBe(503);
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

  it('moves a branched conversation with its family, and lists where each was branched from', async () => {
    const original = await createConversation();
    const branch = await createConversation();
    const live = store.get(branch.id)!;
    live.branch = { fromId: original.id, fromTitle: 'Before', afterId: 'm1' };
    store.saveMeta(live);
    const group = (await (await create('Docs')).json()) as { id: string };

    expect((await app.request(`/api/conversations/${branch.id}/group`, json('PUT', { groupId: group.id }))).status).toBe(200);
    const list = (await (await get('/api/conversations')).json()) as ConversationSummary[];
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    expect(byId[original.id]!.groupId).toBe(group.id);
    expect(byId[branch.id]).toMatchObject({ groupId: group.id, branchFrom: { id: original.id, title: 'Before' } });
    expect(typeof byId[branch.id]!.createdAt).toBe('number');
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

describe('GET /api/cwds', () => {
  it('offers the default working directory, then those in use, the most recently used first, only folders that exist', async () => {
    expect((await app.request('/api/settings', json('PUT', { defaultCwd: project }))).status).toBe(200);
    const [a, b, gone] = ['a', 'b with spaces', 'gone'].map((name) => join(project, name));
    for (const [cwd, at] of [[a, 3], [b, 2], [gone, 4], [project, 1], [a, 1]] as const) {
      mkdirSync(cwd, { recursive: true });
      const conv = store.get((await createConversation({ cwd })).id)!;
      conv.updatedAt = at;
      store.saveMeta(conv);
    }
    rmSync(gone, { recursive: true, force: true });

    const res = await get('/api/cwds');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ home: homedir(), dirs: [{ path: project, default: true }, { path: a }, { path: b }] });
  });

  it('expands a ~ in the default, as a new conversation reads it', async () => {
    const before = process.env.RELAY_DEFAULT_CWD;
    process.env.RELAY_DEFAULT_CWD = '~';
    try {
      const db = openDatabase(':memory:');
      const s = new SettingsStore(db);
      const st = new Store(db);
      const hub = new Hub();
      const own = createApp({ auth: null, store: st, settings: s, hub, orchestrator: new Orchestrator(st, hub, s), providers: new ProviderService(s) });
      const res = await own.request('/api/cwds', { headers: HOST });
      expect(((await res.json()) as WorkingDirectories).dirs).toEqual([{ path: homedir(), default: true }]);
    } finally {
      if (before === undefined) delete process.env.RELAY_DEFAULT_CWD;
      else process.env.RELAY_DEFAULT_CWD = before;
    }
  });

  it('lists a folder once, also spelled in another case where the filesystem ignores case', async () => {
    expect((await app.request('/api/settings', json('PUT', { defaultCwd: project }))).status).toBe(200);
    const conv = await createConversation();
    // Saved as it is: on a case-insensitive filesystem (macOS, Windows) it is the same folder.
    const other = join(root, basename(project).toUpperCase());
    store.create({ ...conv, id: 'upper', updatedAt: conv.updatedAt + 1, settings: { ...conv.settings, cwd: other } });
    expect(((await (await get('/api/cwds')).json()) as WorkingDirectories).dirs).toEqual([{ path: project, default: true }]);
  });

  it('leaves the default out once its folder is gone', async () => {
    const other = join(project, 'other');
    mkdirSync(other);
    await createConversation({ cwd: other });
    const def = join(project, 'default');
    mkdirSync(def);
    expect((await app.request('/api/settings', json('PUT', { defaultCwd: def }))).status).toBe(200);
    const dirs = async () => ((await (await get('/api/cwds')).json()) as WorkingDirectories).dirs;
    expect(await dirs()).toEqual([{ path: def, default: true }, { path: other }]);

    rmSync(def, { recursive: true, force: true });
    expect(await dirs()).toEqual([{ path: other }]);
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

    // Any file can be downloaded, never so that it runs in the app.
    const download = await get(`${base}/download?path=src/a.ts`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('content-disposition')).toBe(`attachment; filename="a.ts"; filename*=UTF-8''a.ts`);
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-security-policy')).toContain('sandbox');
    expect(await download.text()).toBe('const a = 1;\n');
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, '.git', 'config'), 'secret');
    for (const bad of ['src', '.git/config', '.GIT/config', '../x', '/etc/passwd', 'missing']) {
      expect((await get(`${base}/download?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
    }

    for (const bad of ['..', '../..', '/etc/passwd', '.git', 'missing']) {
      expect((await get(`${base}?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
      expect((await get(`${base}/preview?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
    }
    expect((await get(`${base}?root=someone`)).status).toBe(404);
    expect((await get(`/api/conversations/nope/files`)).status).toBe(404);
    expect((await app.request(`${base}?path=`, { headers: { host: 'evil.example' } })).status).toBe(403);
  });

  it('downloads a folder, or the whole working directory, as a ZIP file', async () => {
    mkdirSync(join(project, 'src', 'empty'), { recursive: true });
    writeFileSync(join(project, 'src', 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(project, '報告.md'), '# 報告\n');
    const conv = await createConversation({ permission: 'read-only' });
    const base = `/api/conversations/${conv.id}/files`;
    const top = basename(project);

    expect(await (await get(`${base}/zip/check?path=`)).json()).toEqual({ all: { files: 2, bytes: 13 + Buffer.byteLength('# 報告\n') } });
    const res = await get(`${base}/zip?root=cwd&path=`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain(`filename*=UTF-8''${top}.zip`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const all = readZip(Buffer.from(await res.arrayBuffer()));
    expect(all.map((e) => e.name).sort()).toEqual([`${top}/`, `${top}/src/`, `${top}/src/a.ts`, `${top}/src/empty/`, `${top}/報告.md`].sort());
    expect(all.find((e) => e.name.endsWith('報告.md'))!.data.toString()).toBe('# 報告\n');

    // HEAD: the headers only.
    const head = await app.request(`${base}/zip?path=src`, { method: 'HEAD', headers: HOST });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('application/zip');
    expect(head.body).toBeNull();

    const src = readZip(Buffer.from(await (await get(`${base}/zip?path=src`)).arrayBuffer()));
    expect(src.map((e) => e.name)).toEqual(['src/', 'src/a.ts', 'src/empty/']);
    for (const bad of ['src/a.ts', '..', '.git', 'missing']) {
      expect((await get(`${base}/zip?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
      expect((await get(`${base}/zip/check?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
    }
  });

  it('offers a folder too large to zip without what git ignores, and refuses all of it', async () => {
    const conv = await createConversation({ permission: 'edit' }); // a git repository
    writeFileSync(join(project, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(project, 'index.js'), 'require("pkg");\n');
    const modules = join(project, 'node_modules', 'pkg');
    mkdirSync(modules, { recursive: true });
    for (let i = 0; i <= FILE_LIMITS.zipItems; i++) writeFileSync(join(modules, `f${i}.js`), '');
    const base = `/api/conversations/${conv.id}/files`;

    const check = await (await get(`${base}/zip/check?path=`)).json();
    expect(check).toEqual({ all: null, unignored: { files: 2, bytes: Buffer.byteLength('node_modules/\n') + Buffer.byteLength('require("pkg");\n') } });
    const big = await get(`${base}/zip?path=`, { 'x-relay-lang': 'en' });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toMatch(/too large for a ZIP file: at most 10,000 files and folders, 1 GB/);
    const res = await get(`${base}/zip?path=&unignored=1`);
    expect(res.status).toBe(200);
    expect(readZip(Buffer.from(await res.arrayBuffer())).map((e) => e.name.split('/').slice(1).join('/')).sort()).toEqual(['', '.gitignore', 'index.js']);
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
    const local = createApp({ auth: null, store: s, settings, hub, orchestrator: new Orchestrator(s, hub, settings), providers: new ProviderService(settings), native });
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
    const local = createApp({ auth: null, store: s, settings, hub, orchestrator: new Orchestrator(s, hub, settings), providers: new ProviderService(settings), native });
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
    const local = createApp({ auth: null, store: s, settings, hub, orchestrator: new Orchestrator(s, hub, settings), providers: new ProviderService(settings), native });
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
    expect(list.find((c) => c.id === conv.id)!.schedule).toEqual({ enabled: true, nextRunAt: saved.nextRunAt, timeZone: 'UTC' });

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

    // Once it has a team, the current team takes the scheduled messages.
    store.get(auto.id)!.agents = [{ id: 'z', name: 'Zed', provider: 'claude', role: '' }];
    expect((await put(auto.id, valid)).status).toBe(200);
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

  it('opens a new chat each time when asked, says which one "Run now" opened, and keeps the last one across a save', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const run = () => app.request(`/api/conversations/${conv.id}/schedule/run`, json('POST', {}, { 'x-relay-lang': 'en' }));
    const saved = (await (await put(conv.id, { ...valid, newChat: true })).json()) as NonNullable<Conversation['schedule']>;
    expect(saved.newChat).toBe(true);
    expect(((await (await get(`/api/conversations/${conv.id}`)).json()) as Conversation).schedule!.newChat).toBe(true);

    const res = await run();
    expect(res.status).toBe(202);
    const sent = (await res.json()) as { ok: true; queued: boolean; chatId: string };
    expect(sent).toEqual({ ok: true, queued: false, chatId: expect.any(String) });
    expect(sent.chatId).not.toBe(conv.id);
    expect(orchestrator.isRunning(sent.chatId)).toBe(true);
    expect(orchestrator.isRunning(conv.id)).toBe(false);
    const list = (await (await get('/api/conversations')).json()) as { id: string }[];
    expect(list.map((c) => c.id)).toContain(sent.chatId);
    const chat = (await (await get(`/api/conversations/${sent.chatId}`)).json()) as Conversation;
    expect(chat.messages.map((m) => m.author.kind)).toEqual(['system', 'user', 'agent']);
    expect(chat.messages[1]).toMatchObject({ scheduled: true });
    // Its team is busy in the new chat only: "Run now" opens another one.
    const second = (await (await run()).json()) as { chatId: string };
    expect(second.chatId).not.toBe(sent.chatId);

    Object.assign(store.get(conv.id)!.schedule!, { lastRunAt: 5, lastResult: 'sent', lastChatId: sent.chatId });
    const again = (await (await put(conv.id, { ...valid, text: 'another message' })).json()) as NonNullable<Conversation['schedule']>;
    expect(again).toMatchObject({ newChat: false, lastResult: 'sent', lastChatId: sent.chatId });
    for (const id of [sent.chatId, second.chatId]) {
      orchestrator.stop(id);
      await vi.waitFor(() => expect(orchestrator.isRunning(id)).toBe(false));
    }
  });

  it('creates a schedule in a chat of its own, whose lead agent designs its team now and nothing else runs', async () => {
    const create = (b: Record<string, unknown>) => app.request('/api/schedules', json('POST', b, { 'x-relay-lang': 'en' }));
    const res = await create({ settings: { permission: 'read-only', cwd: project }, schedule: { ...valid, text: 'Weekly report\nwith numbers', newChat: true } });
    expect(res.status).toBe(200);
    const conv = (await res.json()) as Conversation;
    expect(conv.title).toBe('Weekly report');
    expect(conv.agents).toEqual([]);
    expect(conv.settings).toMatchObject({ autoTeam: true, permission: 'read-only', cwd: project });
    expect(conv.schedule).toMatchObject({ text: 'Weekly report\nwith numbers', enabled: true, newChat: true, lang: 'en', nextRunAt: expect.any(Number) });
    const live = store.get(conv.id)!;
    expect(orchestrator.isRunning(conv.id)).toBe(true); // the lead agent designs the team
    expect(live.messages.map((m) => m.author.kind)).toEqual(['system', 'system']);
    expect(live.messages[0]!.parts).toEqual([{ type: 'text', text: expect.stringMatching(/^Schedule created\./) }]);
    expect(live.messages[1]!.plan).toMatchObject({ status: 'planning' });
    expect(live.messages.some((m) => m.author.kind === 'user')).toBe(false);

    const design = () => app.request(`/api/conversations/${conv.id}/schedule/design`, json('POST', {}, { 'x-relay-lang': 'en' }));
    expect((await design()).status).toBe(409); // designing already
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
    // A design that was stopped can be asked for again.
    expect((await design()).status).toBe(202);
    expect(orchestrator.isRunning(conv.id)).toBe(true);
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));

    const titled = (await (await create({ title: ' Reports ', settings: { cwd: project }, schedule: valid })).json()) as Conversation;
    expect(titled.title).toBe('Reports');
    orchestrator.stop(titled.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(titled.id)).toBe(false));
  });

  it("sorts a new schedule's chat into the user's groups by its message, and creates nothing while the server stops", async () => {
    const create = (b: Record<string, unknown>) => app.request('/api/schedules', json('POST', b, { 'x-relay-lang': 'en' }));
    await app.request('/api/groups', json('POST', { name: 'Reports' }));
    const conv = (await (await create({ settings: { cwd: project }, schedule: valid })).json()) as Conversation;
    expect(orchestrator.isSorting(conv.id)).toBe(true);
    await orchestrator.deleteConversation(conv.id); // stops the design and the sorting
    expect(orchestrator.isSorting(conv.id)).toBe(false);
    expect(orchestrator.isRunning(conv.id)).toBe(false);

    orchestrator.stopAll();
    expect((await create({ settings: { cwd: project }, schedule: valid })).status).toBe(503);
    expect(store.list(() => false)).toEqual([]);
  });

  it('creates no schedule that could never send, nor a working directory it was not asked to', async () => {
    const create = (b: Record<string, unknown>) => app.request('/api/schedules', json('POST', b, { 'x-relay-lang': 'en' }));
    const dir = join(project, 'brand', 'new');
    const bad = await create({ settings: { cwd: dir }, createCwd: true, schedule: { ...valid, text: ' ' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/Type the message/);
    expect(existsSync(dir)).toBe(false); // checked before anything is created
    expect((await create({ settings: { cwd: dir }, schedule: valid })).status).toBe(404);
    expect(existsSync(dir)).toBe(false);
    expect(store.list(() => false)).toEqual([]);

    const made = await create({ settings: { cwd: dir }, createCwd: true, schedule: valid });
    expect(made.status).toBe(200);
    expect(statSync(dir).isDirectory()).toBe(true);
    const id = ((await made.json()) as Conversation).id;
    orchestrator.stop(id);
    await vi.waitFor(() => expect(orchestrator.isRunning(id)).toBe(false));
    expect((await app.request('/api/conversations/missing/schedule/design', json('POST', {}))).status).toBe(404);
  });

  it('runs a switched-off schedule now, and says why when the conversation is busy', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const run = () => app.request(`/api/conversations/${conv.id}/schedule/run`, json('POST', {}, { 'x-relay-lang': 'en' }));
    await put(conv.id, { ...valid, enabled: false });
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    const busy = await run();
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toBe('The conversation is busy with a settings change or an apply');
    release();
    await held;
    expect((await run()).status).toBe(202);
    orchestrator.stop(conv.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
  });
});

describe('sharing conversations', () => {
  const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const link = (id = ID) => ({ id, url: `https://gistpreview.github.io/?${id}`, gistUrl: `https://gist.github.com/me/${id}` });

  type Upload = { name: string; data: Buffer };
  type Link = ReturnType<typeof link> & { filesGist?: string };
  const FILES = 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
  function shareApp(gists: {
    create?: (html: string, description: string, files?: Upload[], onFilesGist?: (gist: Link) => void) => Promise<Link>;
    remove?: (id: string) => Promise<void>;
  }) {
    const s = new SettingsStore(openDatabase(':memory:'));
    const never = async () => {
      throw new Error('should not be called');
    };
    return createApp({
      auth: null,
      store,
      settings: s,
      hub: new Hub(),
      orchestrator,
      providers: new ProviderService(s),
      gists: { create: gists.create ?? never, remove: gists.remove ?? never },
    });
  }

  it("puts the page on the web, described by the conversation's title, and lists it", async () => {
    const conv = await createConversation();
    const calls: [string, string][] = [];
    const own = shareApp({
      create: async (html, description) => {
        calls.push([html, description]);
        return link();
      },
    });
    const res = await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: '<!doctype html><p>hi</p>' }));
    expect(res.status).toBe(200);
    const shared = await res.json();
    expect(shared).toMatchObject({ ...link(), conversationId: conv.id, title: conv.title });
    expect(shared.upTo).toBeUndefined();
    expect(calls).toEqual([['<!doctype html><p>hi</p>', `${conv.title} · Harness Relay`]]);
    expect(await (await own.request('/api/shares', { headers: HOST })).json()).toEqual([shared]);
  });

  it('records the agent reply a page ends with', async () => {
    const conv = await createConversation();
    const agentId = conv.agents[0]!.id;
    const cached = store.get(conv.id)!;
    cached.messages.push({ id: 'r1', author: { kind: 'agent', agentId }, agentName: 'Alice', createdAt: 1, parts: [{ type: 'text', text: 'hi' }], status: 'done' });
    const own = shareApp({ create: async () => link() });
    const res = await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: '<p>hi</p>', upTo: 'r1' }));
    expect((await res.json()).upTo).toEqual({ messageId: 'r1', agentName: 'Alice' });
  });

  it('records no reply for an upTo that is not an agent reply of the conversation', async () => {
    const conv = await createConversation();
    store.get(conv.id)!.messages.push({ id: 'u1', author: { kind: 'user' }, createdAt: 1, parts: [{ type: 'text', text: 'hi' }], status: 'done' });
    let n = 0;
    const own = shareApp({ create: async () => link((++n).toString(16).padStart(32, '0')) });
    for (const upTo of ['u1', 'missing', 42]) {
      const res = await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: '<p>hi</p>', upTo }));
      expect(res.status).toBe(200);
      expect((await res.json()).upTo, String(upTo)).toBeUndefined();
    }
  });

  it('refuses an empty page, one too large for gistpreview, and an unknown conversation', async () => {
    const conv = await createConversation();
    const own = shareApp({});
    const send = (id: string, body: unknown) => own.request(`/api/conversations/${id}/share`, json('POST', body));
    expect((await send(conv.id, { html: '  ' })).status).toBe(400);
    expect((await send(conv.id, { html: 42 })).status).toBe(400);
    expect((await send(conv.id, { html: 'é'.repeat(SHARE_MAX_BYTES / 2 + 1) })).status).toBe(413);
    expect((await send('missing', { html: '<p>hi</p>' })).status).toBe(404);
    expect(store.listShares()).toEqual([]);
  });

  it("reports gh's trouble to the user, with the code the UI explains, and records nothing", async () => {
    const conv = await createConversation();
    const own = shareApp({
      create: async () => {
        throw new ShareError('GitHub CLI (gh) is not signed in.', 'gh-signed-out');
      },
    });
    const res = await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: '<p>hi</p>' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'GitHub CLI (gh) is not signed in.', code: 'gh-signed-out' });
    const other = shareApp({
      create: async () => {
        throw new ShareError('Could not create the gist: HTTP 500');
      },
    });
    const failed = await other.request(`/api/conversations/${conv.id}/share`, json('POST', { html: '<p>hi</p>' }));
    expect(await failed.json()).toEqual({ error: 'Could not create the gist: HTTP 500' });
    expect(store.listShares()).toEqual([]);
  });

  it('deletes the gist, then forgets the share', async () => {
    const conv = await createConversation();
    const removed: string[] = [];
    const own = shareApp({ create: async () => link(), remove: async (id) => void removed.push(id) });
    await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: '<p>hi</p>' }));
    const res = await own.request(`/api/shares/${ID}`, { method: 'DELETE', headers: { ...HOST, 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(removed).toEqual([ID]);
    expect(store.listShares()).toEqual([]);
  });

  it('keeps a share whose gist could not be deleted, and knows only its own', async () => {
    const conv = await createConversation();
    const own = shareApp({
      create: async () => link(),
      remove: async () => {
        throw new ShareError('Could not delete the gist: HTTP 500');
      },
    });
    await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: '<p>hi</p>' }));
    const del = (id: string) => own.request(`/api/shares/${id}`, { method: 'DELETE', headers: { ...HOST, 'content-type': 'application/json' } });
    expect((await del(ID)).status).toBe(502);
    expect(store.listShares().map((s) => s.id)).toEqual([ID]);
    expect((await del('ffffffffffffffffffffffff')).status).toBe(404);
    expect((await del('--help')).status).toBe(404);
  });

  /** A file of `size` bytes that takes no room on disk (none of the share routes should read it). */
  const sparse = (path: string, size: number) => {
    writeFileSync(path, '');
    truncateSync(path, size);
  };
  /** The bytes of a PNG's start, and two NULs: a file no gist made through GitHub's API could hold. */
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

  /** A conversation whose replies r1–r3 link to files in its folder: text, binary, empty, too large… */
  async function withFiles(): Promise<Conversation> {
    const conv = await createConversation({ permission: 'read-only' });
    const live = store.get(conv.id)!;
    const agentId = live.agents[0]!.id;
    for (const id of ['r1', 'r2', 'r3']) {
      live.messages.push({ id, author: { kind: 'agent', agentId }, agentName: 'Alice', createdAt: 1, parts: [{ type: 'text', text: id }], status: 'done' });
    }
    mkdirSync(join(project, 'out'), { recursive: true });
    mkdirSync(join(project, 'docs'), { recursive: true });
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, 'out', 'report.md'), '# Report\n');
    writeFileSync(join(project, 'docs', 'report.md'), '# Other report\n');
    writeFileSync(join(project, 'out', 'data.csv'), 'a,b\n');
    writeFileSync(join(project, 'out', 'chart.png'), PNG);
    writeFileSync(join(project, 'out', 'empty.txt'), '  \n');
    sparse(join(project, 'out', 'big.log'), SHARE_FILE_MAX_BYTES + 1);
    writeFileSync(join(project, '.git', 'config'), 'secret');
    writeFileSync(join(root, `outside-${n}.md`), 'outside');
    return conv;
  }
  const ref = (messageId: string, path: string) => ({ messageId, path });
  const fileLink = (i: number, text = 'file') => `<a class="file-link" href="${shareFileHref(i)}">${text}</a>`;

  it('lists the files the shared replies link to, each once, with why one cannot go along', async () => {
    const conv = await withFiles();
    const refs = [
      ref('r1', 'out/report.md'),
      ref('r2', './out/report.md'), // the same file, from another reply
      ref('r1', 'out/data.csv'),
      ref('r1', 'out/chart.png'),
      ref('r1', 'out/empty.txt'),
      ref('r1', 'out/big.log'),
      ref('r1', '.git/config'),
      ref('r1', `../outside-${n}.md`),
      ref('r1', join(root, `outside-${n}.md`)),
      ref('r1', 'out/missing.md'),
      ref('r1', 'out'),
      ref('r3', 'out/data.csv'), // after the reply the share ends with
      ref('nope', 'out/data.csv'),
      ref('r1', 'out/alias.md'), // a link to out/report.md
    ];
    symlinkSync(join(project, 'out', 'report.md'), join(project, 'out', 'alias.md'));
    const res = await app.request(`/api/conversations/${conv.id}/share/files`, json('POST', { files: refs, upTo: 'r2' }));
    expect(res.status).toBe(200);
    const { files } = (await res.json()) as { files: ShareFileInfo[] };
    expect(files).toEqual([
      { name: 'report.md', path: 'out/report.md', size: 9, refs: [0, 1, 13] },
      { name: 'data.csv', path: 'out/data.csv', size: 4, refs: [2] },
      // Any kind of file goes along: binary, blank or empty.
      { name: 'chart.png', path: 'out/chart.png', size: 10, refs: [3] },
      { name: 'empty.txt', path: 'out/empty.txt', size: 3, refs: [4] },
      { name: 'big.log', path: 'out/big.log', size: SHARE_FILE_MAX_BYTES + 1, problem: 'too-large', refs: [5] },
      { name: 'config', path: '.git/config', problem: 'outside', refs: [6] },
      { name: `outside-${n}.md`, path: `../outside-${n}.md`, problem: 'outside', refs: [7] },
      { name: `outside-${n}.md`, path: join(root, `outside-${n}.md`), problem: 'outside', refs: [8] },
      { name: 'missing.md', path: 'out/missing.md', problem: 'missing', refs: [9] },
      { name: 'out', path: 'out', problem: 'missing', refs: [10] },
      { name: 'data.csv', path: 'out/data.csv', problem: 'missing', refs: [11, 12] },
    ]);
    // Never what the files hold.
    const said = JSON.stringify(files);
    for (const held of ['# Report', 'secret', 'a,b', 'content']) expect(said).not.toContain(held);
  });

  it("finds nothing for another conversation's reply, or when the share ends at a reply that is not there", async () => {
    const conv = await withFiles();
    const other = await createConversation({ permission: 'read-only' });
    const live = store.get(other.id)!;
    live.messages.push({ id: 'theirs', author: { kind: 'agent', agentId: live.agents[0]!.id }, createdAt: 1, parts: [], status: 'done' });
    const check = async (body: unknown) => {
      const res = await app.request(`/api/conversations/${conv.id}/share/files`, json('POST', body));
      return ((await res.json()) as { files: ShareFileInfo[] }).files.map((f) => f.problem);
    };
    expect(await check({ files: [ref('theirs', 'out/report.md')] })).toEqual(['missing']);
    expect(await check({ files: [ref('r1', 'out/report.md')], upTo: 'gone' })).toEqual(['missing']);
    expect(await check({ files: [ref('r1', 'out/report.md')], upTo: 'r1' })).toEqual([undefined]);
    // Nor does a share take it along.
    const own = shareApp({});
    const res = await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: fileLink(0), files: [ref('theirs', 'out/report.md')] }));
    expect(res.status).toBe(409);
  });

  it('refuses a list of files that is not one', async () => {
    const conv = await withFiles();
    const check = (body: unknown, id = conv.id) => app.request(`/api/conversations/${id}/share/files`, json('POST', body));
    expect((await check({ files: 'out/report.md' })).status).toBe(400);
    expect((await check({ files: [{ path: 'out/report.md' }] })).status).toBe(400);
    expect((await check({ files: [] }, 'missing')).status).toBe(404);
    expect((await check({ files: [] }, conv.id)).status).toBe(200);
    expect((await check({ files: [ref('r1', 'out/report.md')] }, conv.id)).headers.get('content-type')).toContain('application/json');
    expect((await app.request(`/api/conversations/${conv.id}/share/files`, { method: 'POST', headers: { ...HOST, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });

  it('takes the files the page links to along, each once and named apart, and records them and their gist', async () => {
    const conv = await withFiles();
    const calls: { html: string; files?: Upload[] }[] = [];
    const own = shareApp({
      create: async (html, _d, files) => {
        calls.push({ html, files });
        return { ...link(), filesGist: FILES };
      },
    });
    writeFileSync(join(project, 'out', 'none.txt'), '');
    const files = [
      ref('r1', 'out/report.md'),
      ref('r1', 'out/data.csv'),
      ref('r2', './out/report.md'),
      ref('r2', 'docs/report.md'),
      ref('r1', 'out/chart.png'),
      ref('r1', 'out/empty.txt'),
      ref('r1', 'out/none.txt'),
      ref('r1', 'out/big.log'),
    ];
    // Linked: data.csv, report.md (twice, by two paths), docs/report.md, chart.png, none.txt; empty.txt
    // and big.log (not linked) stay behind, and big.log, too large, is not even read.
    const html = `<!doctype html>${fileLink(1, 'data')}${fileLink(0, 'report')}${fileLink(2, 'again')}${fileLink(3, 'other')}${fileLink(4, 'chart')}${fileLink(6, 'none')}`;
    const res = await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html, files, upTo: 'r2' }));
    expect(res.status).toBe(200);
    const shared = await res.json();
    expect(shared).toMatchObject({ ...link(), files: 5, filesGist: FILES, upTo: { messageId: 'r2', agentName: 'Alice' } });
    expect(calls).toHaveLength(1);
    // Each file's bytes, as they are: the PNG's NULs too.
    expect(calls[0]!.files).toEqual([
      { name: 'data.csv', data: Buffer.from('a,b\n') },
      { name: 'report.md', data: Buffer.from('# Report\n') },
      { name: 'report-2.md', data: Buffer.from('# Other report\n') },
      { name: 'chart.png', data: PNG },
      { name: 'none.txt', data: Buffer.alloc(0) },
    ]);
    // The page's links now name the gist's files, by their place in that list.
    expect(calls[0]!.html).toBe(
      `<!doctype html>${fileLink(0, 'data')}${fileLink(1, 'report')}${fileLink(1, 'again')}${fileLink(2, 'other')}${fileLink(3, 'chart')}${fileLink(4, 'none')}`,
    );
    expect(store.listShares()).toEqual([shared]);
  });

  it('shares a page without files as before', async () => {
    const conv = await withFiles();
    const calls: (Upload[] | undefined)[] = [];
    const own = shareApp({ create: async (_h, _d, files) => (calls.push(files), link()) });
    const res = await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: '<p>hi</p>', files: [ref('r1', 'out/report.md')] }));
    expect((await res.json()).files).toBeUndefined();
    expect(calls).toEqual([[]]);
  });

  it('refuses a file the download link would not serve, or that cannot go along, before anything goes up', async () => {
    const conv = await withFiles();
    const own = shareApp({});
    const send = (files: unknown, html = `<p>${fileLink(0)}</p>`, upTo?: string) =>
      own.request(`/api/conversations/${conv.id}/share`, json('POST', { html, files, upTo }, { 'x-relay-lang': 'en' }));
    for (const path of ['.git/config', `../outside-${n}.md`, join(root, `outside-${n}.md`), 'out/big.log', 'out/missing.md']) {
      const res = await send([ref('r1', path)]);
      expect(res.status, path).toBe(409);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe(SHARE_FILE_REFUSED);
      expect(body.error).toContain('Cannot include');
    }
    expect((await send([ref('r3', 'out/report.md')], undefined, 'r2')).status).toBe(409); // a reply the page does not hold
    // A link to a file the request does not name, or a list that is not one.
    expect((await send([])).status).toBe(400);
    expect((await send('out/report.md')).status).toBe(400);
    expect(store.listShares()).toEqual([]);
  });

  it('refuses more files, or more bytes, than a share takes along, and a page that would grow too large', async () => {
    const conv = await withFiles();
    const own = shareApp({});
    const send = (files: unknown, html: string) => own.request(`/api/conversations/${conv.id}/share`, json('POST', { html, files }));
    const many = Array.from({ length: SHARE_FILES_MAX + 1 }, (_, i) => {
      writeFileSync(join(project, 'out', `${i}.md`), `${i}\n`);
      return ref('r1', `out/${i}.md`);
    });
    expect((await send(many, many.map((_, i) => fileLink(i)).join(''))).status).toBe(413);
    // Each small enough, too many bytes in all: refused as measured, before any of it is read (none
    // could be: reading one would make it a file that cannot go along, 409).
    const heavy = Array.from({ length: Math.floor(SHARE_FILES_MAX_BYTES / SHARE_FILE_MAX_BYTES) + 1 }, (_, i) => {
      const path = join(project, 'out', `heavy-${i}.csv`);
      sparse(path, SHARE_FILE_MAX_BYTES);
      chmodSync(path, 0);
      return ref('r1', `out/heavy-${i}.csv`);
    });
    expect((await send(heavy, heavy.map((_, i) => fileLink(i)).join(''))).status).toBe(413);
    // (Unreadable indeed, unless the tests run as root.)
    if (process.getuid?.() !== 0) expect((await send(heavy.slice(0, 1), fileLink(0))).status).toBe(409);
    // Each link leaves room for the address it gets on GitHub.
    const near = 'x'.repeat(SHARE_MAX_BYTES - SHARE_FILE_URL_MAX);
    expect((await send([ref('r1', 'out/report.md')], near + fileLink(0))).status).toBe(413);
    expect(store.listShares()).toEqual([]);
  });

  it('lists a files gist left without its page, to be removed, and removes only that gist', async () => {
    const conv = await withFiles();
    const removed: string[] = [];
    const leftover = { id: FILES, url: '', gistUrl: `https://gist.github.com/${FILES}` };
    const own = shareApp({
      create: async () => {
        throw new ShareError('Could not make the shared page, nor delete the files', undefined, leftover);
      },
      remove: async (id) => void removed.push(id),
    });
    const res = await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: fileLink(0), files: [ref('r1', 'out/report.md')] }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Could not make the shared page, nor delete the files' });
    const [listed] = store.listShares();
    expect(listed).toEqual(expect.objectContaining({ ...leftover, conversationId: conv.id, files: 1, unfinished: true }));
    expect(listed!.filesGist).toBeUndefined();
    const del = await own.request(`/api/shares/${FILES}`, { method: 'DELETE', headers: { ...HOST, 'content-type': 'application/json' } });
    expect(del.status).toBe(200);
    expect(removed).toEqual([FILES]);
    expect(store.listShares()).toEqual([]);
  });

  it('lists the files gist as unfinished while the share is made, and forgets it once the page is up', async () => {
    const conv = await withFiles();
    const during: unknown[] = [];
    const own = shareApp({
      create: async (_h, _d, _f, onFilesGist) => {
        onFilesGist!({ id: FILES, url: '', gistUrl: `https://gist.github.com/${FILES}` });
        during.push(store.listShares());
        return { ...link(), filesGist: FILES };
      },
    });
    const res = await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: fileLink(0), files: [ref('r1', 'out/report.md')] }));
    expect(res.status).toBe(200);
    // Listed while the files went up, so it could be removed had the server stopped then.
    expect(during).toEqual([[expect.objectContaining({ id: FILES, url: '', unfinished: true, conversationId: conv.id, files: 1 })]]);
    expect(store.listShares()).toEqual([await res.json()]);
    expect(store.listShares()[0]).toMatchObject({ id: ID, filesGist: FILES });
    expect(store.listShares()[0]!.unfinished).toBeUndefined();
  });

  it('neither lists nor removes a share still being made, and lists its files gist after a restart', async () => {
    const conv = await withFiles();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let told!: () => void;
    const madeGist = new Promise<void>((r) => (told = r));
    const removed: string[] = [];
    const own = shareApp({
      create: async (_h, _d, _f, onFilesGist) => {
        onFilesGist!({ id: FILES, url: '', gistUrl: `https://gist.github.com/${FILES}` });
        told();
        await released;
        return { ...link(), filesGist: FILES };
      },
      remove: async (id) => void removed.push(id),
    });
    const sharing = own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: fileLink(0), files: [ref('r1', 'out/report.md')] }));
    await madeGist;
    // Recorded, for a restart, but not listed nor removed while its files go up.
    expect(store.getShare(FILES)).toMatchObject({ unfinished: true });
    expect(await (await own.request('/api/shares', { headers: HOST })).json()).toEqual([]);
    const del = await own.request(`/api/shares/${FILES}`, { method: 'DELETE', headers: { ...HOST, 'content-type': 'application/json', 'x-relay-lang': 'en' } });
    expect(del.status).toBe(409);
    expect((await del.json()).error).toContain('still being made');
    expect(removed).toEqual([]);
    // After a restart (another app on the same records) it is listed, to be removed.
    const restarted = shareApp({});
    expect(await (await restarted.request('/api/shares', { headers: HOST })).json()).toEqual([expect.objectContaining({ id: FILES, unfinished: true })]);
    release();
    expect((await sharing).status).toBe(200);
    expect(await (await own.request('/api/shares', { headers: HOST })).json()).toEqual([expect.objectContaining({ id: ID, filesGist: FILES })]);
  });

  it('forgets the files gist when it was deleted again, and keeps it listed when it may still be on GitHub', async () => {
    const conv = await withFiles();
    const gist = { id: FILES, url: '', gistUrl: `https://gist.github.com/${FILES}` };
    const send = (fail: () => never) =>
      shareApp({
        create: async (_h, _d, _f, onFilesGist) => {
          onFilesGist!(gist);
          fail();
        },
      }).request(`/api/conversations/${conv.id}/share`, json('POST', { html: fileLink(0), files: [ref('r1', 'out/report.md')] }));
    // Deleted again: nothing left to list.
    const undone = await send(() => {
      throw new ShareError('Could not make the shared page, so the files were deleted again');
    });
    expect(undone.status).toBe(502);
    expect(store.listShares()).toEqual([]);
    // Left on GitHub: listed, to be removed.
    const left = await send(() => {
      throw new ShareError('Could not make the shared page, nor delete the files', undefined, gist);
    });
    expect(left.status).toBe(502);
    expect(store.listShares()).toEqual([expect.objectContaining({ id: FILES, unfinished: true })]);
    store.deleteShare(FILES);
    // Stopped by something unforeseen: whether it is still there is not known, so it stays listed.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = await send(() => {
      throw new Error('disk full');
    });
    expect(broken.status).toBe(500);
    expect(store.listShares()).toEqual([expect.objectContaining({ id: FILES, unfinished: true })]);
    vi.restoreAllMocks();
  });

  it('records nothing when a share with files fails and leaves nothing behind', async () => {
    const conv = await withFiles();
    const own = shareApp({
      create: async () => {
        throw new ShareError('GitHub CLI (gh) is not signed in.', 'gh-signed-out');
      },
    });
    const res = await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: fileLink(0), files: [ref('r1', 'out/report.md')] }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'GitHub CLI (gh) is not signed in.', code: 'gh-signed-out' });
    expect(store.listShares()).toEqual([]);
  });

  it('deletes both gists of a share, the files first, and forgets it only once both are gone', async () => {
    const conv = await withFiles();
    const removed: string[] = [];
    let failFiles = true;
    const own = shareApp({
      create: async () => ({ ...link(), filesGist: FILES }),
      remove: async (id) => {
        removed.push(id);
        if (id === FILES && failFiles) throw new ShareError('Could not delete the gist: HTTP 500');
      },
    });
    await own.request(`/api/conversations/${conv.id}/share`, json('POST', { html: fileLink(0), files: [ref('r1', 'out/report.md')] }));
    const del = () => own.request(`/api/shares/${ID}`, { method: 'DELETE', headers: { ...HOST, 'content-type': 'application/json' } });
    // The files gist could not be deleted: the page's is tried all the same, and the share stays listed.
    const first = await del();
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ error: 'Could not delete the gist: HTTP 500' });
    expect(removed).toEqual([FILES, ID]);
    expect(store.listShares().map((s) => [s.id, s.filesGist])).toEqual([[ID, FILES]]);
    // Removed again (a gist already gone counts as deleted): both are gone, and so is the share.
    failFiles = false;
    expect((await del()).status).toBe(200);
    expect(removed).toEqual([FILES, ID, FILES, ID]);
    expect(store.listShares()).toEqual([]);
  });
});
