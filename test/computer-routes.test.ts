/*
 * The chat's computer over the HTTP API (src/server/app.ts): its state, the user's start, control, hand
 * back and turning it off, its panel's stream and input, Cua's viewer link, Settings' view, and the
 * hand-over answers that take a computer mode; for signed-in browsers only.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AUTH_KEY_HEADER } from '../src/shared/auth';
import type { ComputerView, Conversation } from '../src/shared/types';
import type { SpawnResult } from '../src/server/process';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-computer-routes-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { Handovers } = await import('../src/server/browser/handover');
const { ComputerService, computerName, folderKey } = await import('../src/server/computer/session');
const { AuthStore, CODE_TTL_MS } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');

const HOST = { host: '127.0.0.1:8787' };

/** A PNG's first bytes, `w` by `h`, as base64. */
function png(w: number, h: number): string {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
}

describe('the computer over the HTTP API', () => {
  const conversation: Conversation = {
    id: 'c1',
    title: 'Try the app',
    createdAt: 1,
    updatedAt: 1,
    agents: [{ id: 'a1', name: 'Claude', provider: 'claude', role: '' }],
    settings: { mode: 'roundtable', rounds: 1, maxHops: 6, permission: 'edit', cwd: root },
    messages: [],
    agentState: {},
    worktrees: {},
  };
  const setup = async (available = true) => {
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    const store = new Store(db);
    const hub = new Hub();
    const auth = new AuthStore(db);
    const handovers = new Handovers();
    const calls: [string, Record<string, unknown>][] = [];
    const runs: string[][] = [];
    const computer = new ComputerService({
      run: async (args): Promise<SpawnResult> => {
        runs.push(args);
        if (args.includes('info')) return { code: 1, stdout: '', stderr: 'not found', timedOut: false, aborted: false } as SpawnResult;
        if (args.includes('view'))
          return {
            code: 0,
            stdout: JSON.stringify({ url: 'https://evil.example/viewer/#x' }),
            stderr: '',
            timedOut: false,
            aborted: false,
          } as SpawnResult;
        if (args.includes('ls'))
          return {
            code: 0,
            stdout: JSON.stringify([{ name: computerName(join(root, 'data'), folderKey(root)), state: 'running', status: 'ready' }]),
            stderr: '',
            timedOut: false,
            aborted: false,
          } as SpawnResult;
        return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false } as SpawnResult;
      },
      available: () => available,
      startMcp: async () => ({
        alive: true,
        call: async (name, args) => {
          calls.push([name, args]);
          return name === 'computer_screenshot'
            ? { text: '', images: [{ data: png(1200, 750), mimeType: 'image/png' }], isError: false }
            : { text: 'ok', images: [], isError: false };
        },
        close: () => undefined,
      }),
      found: () => (available ? { bin: '/x/cua', version: '0.31.2', own: true } : undefined),
      dataDir: join(root, 'data'),
      handovers,
      folderOf: (id) => store.cwdOf(id),
      shotsDir: () => join(root, 'shots'),
      frameMs: 50,
    });
    const app = createApp({
      auth,
      store,
      settings,
      hub,
      orchestrator: new Orchestrator(store, hub, settings),
      providers: new ProviderService(settings),
      handovers,
      computer,
    });
    store.create(structuredClone(conversation));
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ code: auth.createCode(CODE_TTL_MS.device).code }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const headers = { ...HOST, cookie, [AUTH_KEY_HEADER]: ((await res.json()) as { key: string }).key };
    const post = (path: string, body: unknown, h: Record<string, string> = headers) =>
      app.request(path, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const view = async () => (await (await app.request('/api/conversations/c1/computer', { headers })).json()) as ComputerView;
    return { app, computer, handovers, headers, post, view, calls, runs };
  };

  it('is for signed-in browsers only', async () => {
    const { app, post } = await setup();
    expect((await app.request('/api/conversations/c1/computer', { headers: HOST })).status).toBe(401);
    expect((await post('/api/conversations/c1/computer', { action: 'take' }, HOST)).status).toBe(401);
    expect((await app.request('/api/conversations/c1/computer/screen', { headers: HOST })).status).toBe(401);
    expect((await post('/api/conversations/c1/computer/input', { events: [{ type: 'text', text: 'a' }] }, HOST)).status).toBe(401);
    expect((await app.request('/api/computer', { headers: HOST })).status).toBe(401);
  });

  it('starts, takes control, takes input only then, hands back and turns off', async () => {
    const { computer, post, view, calls } = await setup();
    expect(await view()).toMatchObject({ status: 'off', control: 'agents', available: true, recent: [] });
    expect((await post('/api/conversations/c1/computer', { action: 'fly' })).status).toBe(400);
    expect((await post('/api/conversations/missing/computer', { action: 'take' })).status).toBe(404);
    expect((await post('/api/conversations/c1/computer', { action: 'start' })).status).toBe(200);
    await expect.poll(async () => (await view()).status).toBe('ready');
    const events = [{ type: 'click', x: 0.5, y: 0.5 }];
    expect((await post('/api/conversations/c1/computer/input', { events })).status).toBe(409);
    expect((await post('/api/conversations/c1/computer', { action: 'take' })).status).toBe(200);
    expect((await view()).control).toBe('user');
    expect((await post('/api/conversations/c1/computer/input', { events: [{ type: 'script' }] })).status).toBe(400);
    expect((await post('/api/conversations/c1/computer/input', { events })).status).toBe(200);
    expect(calls.at(-1)?.[0]).toBe('computer_click');
    expect((await post('/api/conversations/c1/computer', { action: 'return', note: 'done' })).status).toBe(200);
    expect((await view()).control).toBe('agents');
    expect((await post('/api/conversations/c1/computer', { action: 'stop' })).status).toBe(200);
    expect((await view()).status).toBe('off');
    await computer.shutdown();
  });

  it('streams the state, then the screen while the panel watches', async () => {
    const { app, computer, headers, post } = await setup();
    await post('/api/conversations/c1/computer', { action: 'start' });
    const res = await app.request('/api/conversations/c1/computer/screen', { headers });
    expect(res.status).toBe(200);
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    while (!text.includes('"type":"frame"')) text += (await reader.read()).value ?? '';
    expect(text.indexOf('"type":"state"')).toBeLessThan(text.indexOf('"type":"frame"'));
    await reader.cancel();
    await computer.shutdown();
  });

  it('refuses a viewer link that is not the computer’s own local page, and one of a computer that is off', async () => {
    const { computer, post } = await setup();
    expect((await post('/api/conversations/c1/computer/viewer', {})).status).toBe(409);
    await post('/api/conversations/c1/computer', { action: 'start' });
    await expect.poll(async () => computer.view('c1').status).toBe('ready');
    expect((await post('/api/conversations/c1/computer/viewer', {})).status).toBe(502);
    await computer.shutdown();
  });

  it('deletes the computer, and gives Settings this data folder’s computers with their chats', async () => {
    const { app, computer, headers, runs } = await setup();
    const settings = (await (await app.request('/api/computer', { headers })).json()) as { computers: unknown[]; installs: string };
    const name = computerName(join(root, 'data'), folderKey(root));
    expect(settings).toMatchObject({
      cua: { version: '0.31.2' },
      computers: [{ name, folder: folderKey(root), chats: ['Try the app'], status: 'ready' }],
    });
    const del = (path: string) => app.request(path, { method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' } });
    expect((await del('/api/computers/relay-000000-000000000000')).status).toBe(404);
    expect((await del('/api/computers/' + name)).status).toBe(200);
    expect(runs.at(-1)).toEqual(['sb', 'rm', 'local:' + name, '--force']);
    // Deleting is Settings' alone: a chat has no route of its own for it.
    expect((await del('/api/conversations/c1/computer')).status).toBe(404);
    await computer.shutdown();
  });

  it('says Cua is missing, in the request’s language', async () => {
    const { computer, headers, post, view } = await setup(false);
    expect(await view()).toMatchObject({ available: false });
    const refused = await post('/api/conversations/c1/computer', { action: 'start' }, { ...headers, 'x-relay-lang': 'en' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/Cua is not installed/) });
    await computer.shutdown();
  });

  it('takes a hand-over of the computer in its own mode only', async () => {
    const { handovers, post, computer } = await setup();
    const t = handovers.create('c1', ['computer']);
    const path = `/api/conversations/c1/handovers/${t.id}`;
    expect((await post(path, { action: 'start', mode: 'window' })).status).toBe(400);
    const woke = t.wait(10_000, new AbortController().signal);
    expect((await post(path, { action: 'start', mode: 'computer' })).status).toBe(200);
    expect(await woke).toEqual({ action: 'start', mode: 'computer' });
    await computer.shutdown();
  });
});
