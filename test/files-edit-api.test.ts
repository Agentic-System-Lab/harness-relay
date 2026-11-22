/*
 * The Files panel's writes over HTTP (`PUT /api/conversations/:id/files/text`, `POST …/files/upload`
 * in src/server/app.ts): what the listing says about a root, a save and its conflict, a new file, an
 * upload and its replacement, and what they refuse: an agent's worktree, a folder where edit mode is
 * refused, a run writing in the folder (this chat's or another's), too much, a request that is not the
 * UI's.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_CHANGED,
  FILE_EDIT_LIMITS,
  FILE_EXISTS,
  FOLDER_BUSY,
  type Conversation,
  type FileListing,
  type FilePreview,
} from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-files-edit-api-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { AgentRunError, runners } = await import('../src/server/agents');
const { removeTree } = await import('../src/server/fsRemove');

afterAll(() => removeTree(root, { restore: true }));

// A fake CLI that waits until it is stopped, writing nothing.
beforeAll(() => {
  runners.claude = {
    provider: 'claude',
    async run(o) {
      o.onEvent({ type: 'text', text: 'working…' });
      if (!o.signal?.aborted) await new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }));
      throw new AgentRunError('stopped', true);
    },
  };
});

let app: ReturnType<typeof createApp>;
let orchestrator: InstanceType<typeof Orchestrator>;
let store: InstanceType<typeof Store>;
let project: string;
let n = 0;
const noPicker = { available: () => false, pick: async () => [] };

beforeEach(() => {
  const db = openDatabase(':memory:');
  const settings = new SettingsStore(db);
  store = new Store(db);
  const hub = new Hub();
  orchestrator = new Orchestrator(store, hub, settings);
  app = createApp({ auth: null, store, settings, hub, orchestrator, providers: new ProviderService(settings), folderPicker: noPicker });
  project = join(root, `project-${++n}`);
  mkdirSync(join(project, 'notes'), { recursive: true });
  writeFileSync(join(project, 'queue.csv'), 'date,text\n');
});

const HOST = { host: '127.0.0.1:8787' };
const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { ...HOST, 'content-type': 'application/json', 'x-relay-lang': 'en', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (path: string) => app.request(path, { headers: { ...HOST, 'x-relay-lang': 'en' } });

async function createConversation(settings: Record<string, unknown> = {}, cwd = project): Promise<Conversation> {
  const res = await send('POST', '/api/conversations', {
    agents: [{ name: 'Alice', provider: 'claude', role: '' }],
    settings: { mode: 'roundtable', permission: 'edit', cwd, ...settings },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Conversation;
}

const base = (conv: Conversation) => `/api/conversations/${conv.id}/files`;
const preview = async (conv: Conversation, path: string) =>
  (await (await get(`${base(conv)}/preview?path=${encodeURIComponent(path)}`)).json()) as FilePreview;
const save = (conv: Conversation, body: Record<string, unknown>) => send('PUT', `${base(conv)}/text`, body);
const upload = (conv: Conversation, body: Record<string, unknown>) => send('POST', `${base(conv)}/upload`, body);
const errorOf = async (res: Response) => (await res.json()) as { error: string; code?: string };

describe('editing a file', () => {
  it('says the working directory takes writes, saves over the version loaded, and refuses a stale one', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const listing = (await (await get(`${base(conv)}?path=`)).json()) as FileListing;
    expect(listing).toMatchObject({ writable: true });
    expect(listing.readOnly).toBeUndefined();

    const loaded = await preview(conv, 'queue.csv');
    const res = await save(conv, { path: 'queue.csv', text: 'date,text\n2026-11-23,Hi\n', version: loaded.version });
    expect(res.status).toBe(200);
    const written = await res.json();
    expect(written).toMatchObject({ path: 'queue.csv', size: 24 });
    expect(readFileSync(join(project, 'queue.csv'), 'utf8')).toBe('date,text\n2026-11-23,Hi\n');
    expect((await preview(conv, 'queue.csv')).version).toBe(written.version);

    // Saved again over the first version: the file changed since.
    const stale = await save(conv, { path: 'queue.csv', text: 'mine', version: loaded.version });
    expect(stale.status).toBe(409);
    expect(await errorOf(stale)).toMatchObject({ code: FILE_CHANGED, error: expect.stringContaining('changed since you opened it') });
    expect(readFileSync(join(project, 'queue.csv'), 'utf8')).toBe('date,text\n2026-11-23,Hi\n');
  });

  it('makes a new file, and refuses a name taken or one no system takes', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    expect((await save(conv, { root: 'cwd', path: 'notes/plan.md', text: '', version: null })).status).toBe(200);
    expect(readFileSync(join(project, 'notes', 'plan.md'), 'utf8')).toBe('');
    const taken = await save(conv, { path: 'notes/plan.md', text: '', version: null });
    expect(taken.status).toBe(409);
    expect((await errorOf(taken)).code).toBe(FILE_EXISTS);
    const bad = await save(conv, { path: 'notes/CON', text: '', version: null });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).error).toContain('a name Windows keeps for devices');
    for (const body of [
      { path: 'x.txt', text: 1, version: null },
      { path: 'x.txt', text: '' },
      { path: 5, text: '', version: null },
      { root: 3, path: 'x', text: '', version: null },
    ]) {
      expect((await save(conv, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses .git, links, what the server withholds, and paths outside', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    mkdirSync(join(project, '.git'));
    writeFileSync(join(project, '.git', 'config'), '[core]\n');
    const outside = join(root, `outside-${n}`);
    mkdirSync(outside);
    symlinkSync(outside, join(project, 'out'), 'dir');
    for (const path of ['.git/config', '.GIT/config', '../x.txt', '/etc/passwd', 'missing/x.txt']) {
      expect((await save(conv, { path, text: 'x', version: null })).status, path).toBe(404);
    }
    expect((await save(conv, { path: 'out/x.txt', text: 'x', version: null })).status).toBe(403);
    expect((await upload(conv, { dir: 'out', name: 'x.txt', data: 'eA==' })).status).toBe(403);
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
    expect(readFileSync(join(project, '.git', 'config'), 'utf8')).toBe('[core]\n');
  });

  it("keeps an agent's worktree and a folder that holds Harness Relay's data read-only", async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const live = store.get(conv.id)!;
    const agentId = live.agents[0]!.id;
    const wt = join(root, `wt-${n}`);
    mkdirSync(wt);
    writeFileSync(join(wt, 'result.txt'), 'theirs\n');
    live.worktrees[agentId] = [{ root: project, path: wt, branch: 'relay/x', base: 'b', needsReset: false }];
    const listing = (await (await get(`${base(conv)}?root=${encodeURIComponent(agentId)}&path=`)).json()) as FileListing;
    expect(listing).toMatchObject({ writable: false, readOnly: expect.stringContaining('worktree') });
    const loaded = (await (await get(`${base(conv)}/preview?root=${encodeURIComponent(agentId)}&path=result.txt`)).json()) as FilePreview;
    const res = await save(conv, { root: agentId, path: 'result.txt', text: 'mine', version: loaded.version });
    expect(res.status).toBe(403);
    expect((await upload(conv, { root: agentId, dir: '', name: 'x.txt', data: 'eA==' })).status).toBe(403);
    expect(readFileSync(join(wt, 'result.txt'), 'utf8')).toBe('theirs\n');
    expect((await save(conv, { root: 'nope', path: 'x', text: '', version: null })).status).toBe(404);

    // A read-only chat may work in a folder that holds the data folder; the Files panel writes nothing there.
    const top = await createConversation({ permission: 'read-only' }, root);
    expect(await (await get(`${base(top)}?path=`)).json()).toMatchObject({
      writable: false,
      readOnly: expect.stringContaining('Harness Relay'),
    });
    expect((await save(top, { path: 'new.txt', text: '', version: null })).status).toBe(403);
    expect(existsSync(join(root, 'new.txt'))).toBe(false);
  });

  it("waits while a run writes in the folder: this chat's, or another chat's", async () => {
    const writer = await createConversation();
    const reader = await createConversation({ permission: 'read-only' });
    const loaded = await preview(reader, 'queue.csv');
    expect((await send('POST', `/api/conversations/${writer.id}/messages`, { text: 'go' })).status).toBe(202);
    await vi.waitFor(() => expect(orchestrator.isRunning(writer.id)).toBe(true));
    await vi.waitFor(() => expect(orchestrator.writingIn(writer.id, realpathSync(project))).toBe(true));
    for (const conv of [writer, reader]) {
      const busy = await save(conv, { path: 'queue.csv', text: 'mine', version: loaded.version });
      expect(busy.status).toBe(409);
      expect(await errorOf(busy)).toMatchObject({ code: FOLDER_BUSY, error: expect.stringContaining('A run is changing files') });
      expect((await upload(conv, { dir: '', name: 'photo.jpg', data: 'eA==' })).status).toBe(409);
    }
    // A folder of its own is not held.
    const elsewhere = join(root, `elsewhere-${n}`);
    mkdirSync(elsewhere);
    const other = await createConversation({ permission: 'read-only' }, elsewhere);
    expect((await save(other, { path: 'free.txt', text: 'x', version: null })).status).toBe(200);

    await send('POST', `/api/conversations/${writer.id}/stop`, {});
    await vi.waitFor(() => expect(orchestrator.isRunning(writer.id)).toBe(false));
    expect((await save(reader, { path: 'queue.csv', text: 'mine', version: loaded.version })).status).toBe(200);
    expect(readFileSync(join(project, 'queue.csv'), 'utf8')).toBe('mine');
  });

  it('refuses a body too large before reading it all, and text over the limit', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const loaded = await preview(conv, 'queue.csv');
    const tooLong = await save(conv, { path: 'queue.csv', text: 'x'.repeat(FILE_EDIT_LIMITS.maxEditBytes + 1), version: loaded.version });
    expect(tooLong.status).toBe(413);
    expect((await errorOf(tooLong)).error).toContain('at most 512 KB');
    const huge = await save(conv, {
      path: 'queue.csv',
      text: 'x'.repeat(FILE_EDIT_LIMITS.maxEditBytes * 6 + 65 * 1024),
      version: loaded.version,
    });
    expect(huge.status).toBe(413);
    expect((await errorOf(huge)).error).toBe('What was sent is too large.');
    expect(readFileSync(join(project, 'queue.csv'), 'utf8')).toBe('date,text\n');
  });

  it('takes writes only as the UI sends them', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const body = { path: 'evil.txt', text: 'x', version: null };
    expect((await send('PUT', `${base(conv)}/text`, body, { host: 'evil.example' })).status).toBe(403);
    expect((await send('PUT', `${base(conv)}/text`, body, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await send('PUT', `${base(conv)}/text`, body, { 'content-type': 'text/plain' })).status).toBe(415);
    expect(
      (await send('POST', `${base(conv)}/upload`, { dir: '', name: 'evil.txt', data: 'eA==' }, { 'content-type': 'multipart/form-data' }))
        .status,
    ).toBe(415);
    expect((await send('PUT', `/api/conversations/nope/files/text`, body)).status).toBe(404);
    expect(existsSync(join(project, 'evil.txt'))).toBe(false);
  });
});

describe('uploading files', () => {
  it('writes a file into a folder, and replaces one only once the user agreed', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]).toString('base64');
    const res = await upload(conv, { dir: 'notes', name: 'photo.jpg', data });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: 'notes/photo.jpg', size: 5 });
    expect(readFileSync(join(project, 'notes', 'photo.jpg'))).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]));

    const again = await upload(conv, { dir: 'notes', name: 'photo.jpg', data: Buffer.from('new').toString('base64') });
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toMatchObject({ code: FILE_EXISTS, error: '"photo.jpg" exists already.' });
    expect(
      (await upload(conv, { dir: 'notes', name: 'photo.jpg', data: Buffer.from('new').toString('base64'), replace: true })).status,
    ).toBe(200);
    expect(readFileSync(join(project, 'notes', 'photo.jpg'), 'utf8')).toBe('new');

    for (const name of ['../x', 'a/b', '.git', 'nul', 'x?']) {
      expect((await upload(conv, { dir: '', name, data: 'eA==' })).status, name).toBe(400);
    }
    expect((await upload(conv, { dir: 'nope', name: 'x.txt', data: 'eA==' })).status).toBe(404);
  });

  it('refuses a file over the limit', async () => {
    const conv = await createConversation({ permission: 'read-only' });
    const max = FILE_EDIT_LIMITS.maxUploadBytes;
    FILE_EDIT_LIMITS.maxUploadBytes = 4;
    try {
      const res = await upload(conv, { dir: '', name: 'big.bin', data: Buffer.from('12345').toString('base64') });
      expect(res.status).toBe(413);
      expect((await errorOf(res)).error).toContain('"big.bin" is too large to upload');
    } finally {
      FILE_EDIT_LIMITS.maxUploadBytes = max;
    }
    expect(existsSync(join(project, 'big.bin'))).toBe(false);
  });
});
