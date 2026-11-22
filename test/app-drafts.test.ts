/*
 * The HTTP API of the lead agent's help outside a conversation's team: the editors' drafts, the
 * sidebar's group suggestions and applying them, a proposed schedule's card, and naming new chats.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { removeTree } from '../src/server/fsRemove';
import type { ChatMessage, Conversation, ConversationSchedule, GroupSuggestion, SettingsView, TemplateRevision } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-drafts-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { createApp } = await import('../src/server/app');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { runners } = await import('../src/server/agents');
const { TEMPLATE_BRIEFING } = await import('../src/server/planner');
const { CHECKS_BRIEFING } = await import('../src/server/checksDraft');
const { SCHEDULE_BRIEFING } = await import('../src/server/scheduleDraft');
const { ORGANIZER_BRIEFING } = await import('../src/server/grouping');

let app: ReturnType<typeof createApp>;
let store: InstanceType<typeof Store>;
let project: string;
let n = 0;
/** What the fake lead agent answers a draft with, by its briefing. */
const replies = new Map<string, string>();

beforeAll(() => {
  runners.claude = {
    provider: 'claude',
    async run(o) {
      const reply = replies.get(o.systemPrompt ?? '');
      if (reply === undefined) throw new Error(`unexpected run: ${o.systemPrompt?.slice(0, 60)}`);
      o.onEvent({ type: 'text', text: reply });
      o.onEvent({ type: 'text_end' });
      return {};
    },
  };
});

afterAll(() => removeTree(root, { restore: true }));

beforeEach(() => {
  replies.clear();
  const db = openDatabase(':memory:');
  const settings = new SettingsStore(db);
  store = new Store(db);
  const hub = new Hub();
  const orchestrator = new Orchestrator(store, hub, settings);
  app = createApp({ auth: null, store, settings, hub, orchestrator, providers: new ProviderService(settings) });
  project = join(root, `project-${++n}`);
  mkdirSync(project, { recursive: true });
});

const HOST = { host: '127.0.0.1:8787' };
const req = (path: string, method: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...HOST, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = (v: unknown) => '```json\n' + JSON.stringify(v) + '\n```';

/** A conversation with a team of one, saved. */
function conversation(title = 'test'): Conversation {
  const conv: Conversation = {
    id: `conv-${n}-${Math.random().toString(36).slice(2)}`,
    title,
    createdAt: 0,
    updatedAt: 0,
    agents: [{ id: 'a', name: 'Alice', provider: 'claude', role: '' }],
    settings: { mode: 'roundtable', rounds: 1, maxHops: 5, permission: 'edit', cwd: project },
    messages: [],
    agentState: {},
    worktrees: {},
  };
  store.create(conv);
  return store.get(conv.id)!;
}

/** A reply of Alice's that proposes `proposal`. */
function proposing(conv: Conversation, proposal: unknown): ChatMessage {
  const msg: ChatMessage = {
    id: `m-${Math.random().toString(36).slice(2)}`,
    author: { kind: 'agent', agentId: 'a' },
    parts: [
      { type: 'text', text: 'Here it is.' },
      { type: 'schedule', proposal: proposal as never },
    ],
    createdAt: Date.now(),
    status: 'done',
  };
  conv.messages.push(msg);
  store.saveMessage(conv.id, msg, true);
  return msg;
}

describe('drafts for the editors', () => {
  it('drafts a template, and refuses an empty request', async () => {
    replies.set(
      TEMPLATE_BRIEFING,
      json({ name: 'Pair', description: 'Two views.', agents: [{ name: 'Ann', provider: 'claude', role: 'Look.' }], reason: 'ok' }),
    );
    const body = { request: 'a pair', name: '', description: '', agents: [], settings: { mode: 'roundtable', rounds: 1, maxHops: 8 } };
    const res = await req('/api/presets/draft', 'POST', body);
    expect(res.status).toBe(200);
    const r = (await res.json()) as TemplateRevision;
    expect(r).toMatchObject({ name: 'Pair', description: 'Two views.', reason: 'ok' });
    expect(r.agents).toEqual([expect.objectContaining({ name: 'Ann', role: 'Look.' })]);
    expect((await req('/api/presets/draft', 'POST', { ...body, request: '' })).status).toBe(400);
  });

  it('drafts team checks for a conversation, and is not found for one that is not there', async () => {
    const conv = conversation();
    replies.set(CHECKS_BRIEFING, json({ commands: [{ run: 'npm test' }], reason: 'tests' }));
    const res = await req('/api/checks/draft', 'POST', { request: 'tests', variant: 'team', convId: conv.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checks: { commands: [{ run: 'npm test' }] }, readIn: project });
    expect((await req('/api/checks/draft', 'POST', { request: 'tests', variant: 'team', convId: 'nope' })).status).toBe(404);
  });

  it('drafts a schedule', async () => {
    replies.set(SCHEDULE_BRIEFING, json({ text: 'Morning summary', repeat: { kind: 'daily', time: '08:30' }, reason: 'daily' }));
    const res = await req('/api/schedules/draft', 'POST', { request: 'every morning', timeZone: 'Europe/Paris' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      schedule: { text: 'Morning summary', repeat: { kind: 'daily', time: '08:30' }, timeZone: 'Europe/Paris' },
    });
  });
});

describe('organizing the sidebar groups', () => {
  it('suggests groups once there are conversations, and applies the ones the user took together', async () => {
    expect((await req('/api/groups/suggest', 'POST', {})).status).toBe(400);
    const a = conversation('Invoice for ACME');
    const b = conversation('Fix the build');
    const g = (await (await req('/api/groups', 'POST', { name: 'Work' })).json()) as { id: string };
    replies.set(
      ORGANIZER_BRIEFING,
      json({
        create: [{ name: 'Clients' }],
        rename: [],
        move: [
          { conversation: 1, group: 2 },
          { conversation: 2, group: 2 },
        ],
        reason: 'ok',
      }),
    );
    const s = (await (await req('/api/groups/suggest', 'POST', { request: 'by client' })).json()) as GroupSuggestion;
    expect(s.create).toEqual([{ key: 'new-1', name: 'Clients' }]);
    expect(s.move.map((m) => m.to)).toEqual(['new-1', 'new-1']);

    const res = await req('/api/groups/reorganize', 'POST', {
      create: [{ key: 'new-1', name: 'Clients' }],
      rename: [{ id: g.id, name: 'Engineering' }],
      move: [
        { convId: a.id, to: 'new-1' },
        { convId: b.id, to: g.id },
      ],
    });
    expect(res.status).toBe(200);
    const { groups, created } = (await res.json()) as { groups: { id: string; name: string }[]; created: { id: string; name: string }[] };
    expect(groups.map((x) => x.name)).toEqual(['Engineering', 'Clients']);
    expect(store.groupOf(a.id)).toBe(created[0]!.id);
    expect(store.groupOf(b.id)).toBe(g.id);
    // The user's own choice: the lead agent does not sort them again.
    expect(store.isSorted(a.id)).toBe(true);
  });

  it('changes nothing when one of the suggestions cannot be applied', async () => {
    const a = conversation('A');
    const g = (await (await req('/api/groups', 'POST', { name: 'Work' })).json()) as { id: string };
    const taken = await req('/api/groups/reorganize', 'POST', {
      create: [{ key: 'new-1', name: 'work' }],
      move: [{ convId: a.id, to: 'new-1' }],
    });
    expect(taken.status).toBe(400);
    expect((await req('/api/groups/reorganize', 'POST', { move: [{ convId: 'gone', to: g.id }] })).status).toBe(404);
    expect((await req('/api/groups/reorganize', 'POST', { move: [{ convId: a.id, to: 'new-9' }] })).status).toBe(404);
    expect((await req('/api/groups/reorganize', 'POST', { create: [{ key: 'bad key', name: 'X' }] })).status).toBe(400);
    expect(store.listGroups().map((x) => x.name)).toEqual(['Work']);
    expect(store.groupOf(a.id)).toBeNull();
  });
});

describe("a proposed schedule's card", () => {
  const daily = { text: 'Check the build', repeat: { kind: 'daily', time: '08:00' } };

  it('creates the schedule in the browser’s time zone, once, and the card says so', async () => {
    const conv = conversation();
    const msg = proposing(conv, daily);
    const res = await req(`/api/conversations/${conv.id}/messages/${msg.id}/schedule`, 'POST', {
      action: 'create',
      timeZone: 'Asia/Tokyo',
    });
    expect(res.status).toBe(200);
    const s = (await res.json()) as ConversationSchedule;
    expect(s).toMatchObject({
      text: 'Check the build',
      repeat: { kind: 'daily', time: '08:00' },
      timeZone: 'Asia/Tokyo',
      enabled: true,
      approvals: 'deny',
    });
    expect(store.get(conv.id)!.schedule?.text).toBe('Check the build');
    expect(
      store
        .get(conv.id)!
        .messages.find((m) => m.id === msg.id)!
        .parts.at(-1),
    ).toMatchObject({ type: 'schedule', status: 'created' });
    expect((await req(`/api/conversations/${conv.id}/messages/${msg.id}/schedule`, 'POST', { action: 'create' })).status).toBe(409);
  });

  it('dismisses one, refuses an unknown action, and is not found where no reply proposed one', async () => {
    const conv = conversation();
    const msg = proposing(conv, daily);
    expect((await req(`/api/conversations/${conv.id}/messages/${msg.id}/schedule`, 'POST', { action: 'maybe' })).status).toBe(400);
    expect((await req(`/api/conversations/${conv.id}/messages/${msg.id}/schedule`, 'POST', { action: 'dismiss' })).status).toBe(200);
    expect(store.get(conv.id)!.schedule).toBeUndefined();
    expect(store.get(conv.id)!.messages[0]!.parts.at(-1)).toMatchObject({ status: 'dismissed' });
    expect((await req(`/api/conversations/${conv.id}/messages/nope/schedule`, 'POST', { action: 'create' })).status).toBe(404);
  });

  it('refuses one whose time has passed, leaving the card to the form', async () => {
    const conv = conversation();
    const msg = proposing(conv, { text: 'Once', repeat: { kind: 'once', at: '2020-01-01T09:00' } });
    expect(
      (await req(`/api/conversations/${conv.id}/messages/${msg.id}/schedule`, 'POST', { action: 'create', timeZone: 'UTC' })).status,
    ).toBe(400);
    expect(store.get(conv.id)!.messages[0]!.parts.at(-1)).not.toHaveProperty('status');
  });

  it('is marked created when the user saves it from the form', async () => {
    const conv = conversation();
    const msg = proposing(conv, daily);
    const form = {
      text: 'Check the build, and the tests',
      repeat: { kind: 'daily', time: '09:00' },
      timeZone: 'UTC',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
    };
    expect((await req(`/api/conversations/${conv.id}/schedule`, 'PUT', { ...form, fromProposal: 42 })).status).toBe(400);
    expect((await req(`/api/conversations/${conv.id}/schedule`, 'PUT', { ...form, fromProposal: 'nope' })).status).toBe(404);
    expect(store.get(conv.id)!.schedule).toBeUndefined();
    expect((await req(`/api/conversations/${conv.id}/schedule`, 'PUT', { ...form, fromProposal: msg.id })).status).toBe(200);
    expect(store.get(conv.id)!.schedule?.text).toBe('Check the build, and the tests');
    expect(store.get(conv.id)!.messages[0]!.parts.at(-1)).toMatchObject({ status: 'created' });
  });
});

it('turns naming new chats on and off in Settings, and refuses a value that is not a boolean', async () => {
  const view = async () => (await (await req('/api/settings', 'GET')).json()) as SettingsView;
  // Off in the tests (test/setup.ts), as RELAY_CHAT_TITLES says until Settings changes it.
  expect((await view()).chatTitles).toBe(false);
  expect(((await (await req('/api/settings', 'PUT', { chatTitles: true })).json()) as SettingsView).chatTitles).toBe(true);
  expect((await view()).chatTitles).toBe(true);
  expect((await req('/api/settings', 'PUT', { chatTitles: 'yes' })).status).toBe(400);
  await req('/api/settings', 'PUT', { chatTitles: false });
  expect((await view()).chatTitles).toBe(false);
});
