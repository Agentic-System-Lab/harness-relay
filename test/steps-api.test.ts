/*
 * A steps card's HTTP API (src/server/app.ts): ticking a step (`PUT …/messages/:messageId/steps/:index`)
 * and answering (`POST …/messages/:messageId/steps/answer`), with what they refuse.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-steps-api-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { runners } = await import('../src/server/agents');
const { removeTree } = await import('../src/server/fsRemove');

// A fake CLI that gives the user two steps, and thanks them once their answer is in its prompt.
beforeAll(() => {
  runners.claude = {
    provider: 'claude',
    async run(o) {
      const answered = o.prompt.includes('gave me');
      o.onEvent({ type: 'text', text: answered ? 'Thanks.' : 'First:\n<steps>\n1. Sign in\n2. Create a key\n</steps>' });
      o.onEvent({ type: 'text_end' });
      return { sessionId: 'session' };
    },
  };
});

afterAll(() => removeTree(root, { restore: true }));

let app: ReturnType<typeof createApp>;
let orchestrator: InstanceType<typeof Orchestrator>;
let store: InstanceType<typeof Store>;
let n = 0;
const noPicker = { available: () => false, pick: async () => [] };

beforeEach(() => {
  const db = openDatabase(':memory:');
  const settings = new SettingsStore(db);
  store = new Store(db);
  const hub = new Hub();
  orchestrator = new Orchestrator(store, hub, settings);
  app = createApp({ auth: null, store, settings, hub, orchestrator, providers: new ProviderService(settings), folderPicker: noPicker });
});

const HOST = { host: '127.0.0.1:8787' };
const call = (method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { ...HOST, 'content-type': 'application/json', 'x-relay-lang': 'en' }, body: JSON.stringify(body) });

async function stepsReply(): Promise<{ conv: Conversation; reply: ChatMessage; base: string }> {
  const cwd = join(root, `project-${++n}`);
  mkdirSync(cwd, { recursive: true });
  const conv: Conversation = {
    id: `conv-${n}`,
    title: 'steps',
    createdAt: 0,
    updatedAt: 0,
    agents: [{ id: 'a', name: 'Alice', provider: 'claude', role: '' }],
    settings: { mode: 'roundtable', rounds: 1, maxHops: 5, permission: 'read-only', cwd },
    messages: [],
    agentState: {},
    worktrees: {},
  };
  store.create(conv);
  await orchestrator.send(conv.id, 'set it up');
  await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
  const reply = conv.messages.find((m) => m.author.kind === 'agent')!;
  return { conv, reply, base: `/api/conversations/${conv.id}/messages/${reply.id}/steps` };
}

describe('steps card API', () => {
  it('ticks a step, and refuses what is not one', async () => {
    const { reply, base } = await stepsReply();
    expect(reply.parts.at(-1)).toEqual({ type: 'steps', items: [{ text: 'Sign in' }, { text: 'Create a key' }] });
    const res = await call('PUT', `${base}/1`, { done: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(reply.parts.at(-1)).toMatchObject({ items: [{}, { done: true }] });
    expect((await call('PUT', `${base}/1`, { done: 'yes' })).status).toBe(400);
    expect((await call('PUT', `${base}/-1`, { done: true })).status).toBe(400);
    expect((await call('PUT', `${base}/x`, { done: true })).status).toBe(400);
    const missing = await call('PUT', `${base}/2`, { done: true });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'There is no step 3' });
  });

  it('answers: the user’s message, and the team goes on; answered twice is refused', async () => {
    const { conv, reply, base } = await stepsReply();
    const res = await call('POST', `${base}/answer`, { done: [0], note: 'Waiting for the key mail.' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, queued: false });
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false));
    const texts = conv.messages.map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
    expect(texts.slice(2)).toEqual([
      'I did 1 of the 2 steps @Alice gave me.\n\n1. [done] Sign in\n2. [not done] Create a key\n\nNote: Waiting for the key mail.',
      'Thanks.',
    ]);
    expect(reply.parts.at(-1)).toMatchObject({ answer: { note: 'Waiting for the key mail.' } });
    const again = await call('POST', `${base}/answer`, { done: [] });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'These steps were already answered' });
  });

  it('refuses an answer that is not one', async () => {
    const { base } = await stepsReply();
    expect((await call('POST', `${base}/answer`, {})).status).toBe(400);
    expect((await call('POST', `${base}/answer`, { done: ['0'] })).status).toBe(400);
    expect((await call('POST', `${base}/answer`, { done: [], stuckAt: 1.5 })).status).toBe(400);
    expect((await call('POST', `${base}/answer`, { done: [], note: 3 })).status).toBe(400);
    expect((await call('POST', `/api/conversations/nope/messages/x/steps/answer`, { done: [] })).status).toBe(404);
  });

  it('keeps the browser checks: a write without JSON is refused', async () => {
    const { base } = await stepsReply();
    const res = await app.request(`${base}/0`, {
      method: 'PUT',
      headers: { ...HOST, 'content-type': 'text/plain' },
      body: '{"done":true}',
    });
    expect(res.status).toBe(415);
  });
});
