import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, Conversation, ConversationSettings } from '../src/shared/types';

// Worktrees live under RELAY_DATA_DIR, which is read when the server modules load.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-orch-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { runners } = await import('../src/server/agents');

let n = 0;
let orchestrator: InstanceType<typeof Orchestrator>;
let store: InstanceType<typeof Store>;
let db: ReturnType<typeof openDatabase>;
let project: string;
/** Resolves when the fake agent may finish its turn. */
let gate: Promise<void> = Promise.resolve();
/** Every fake CLI run, in order. */
let calls: { name: string; sessionId?: string; prompt: string }[] = [];

// A fake CLI: writes `<name>.txt` and `shared.txt` in its cwd, then replies.
beforeAll(() => {
  runners.claude = {
    provider: 'claude',
    async run(o) {
      const name = /You are @(\w+)/.exec(o.systemPrompt)![1]!;
      calls.push({ name, sessionId: o.sessionId, prompt: o.prompt });
      writeFileSync(join(o.cwd, 'shared.txt'), `written by ${name}\n`);
      writeFileSync(join(o.cwd, `${name}.txt`), `${name}\n`);
      await gate;
      o.onEvent({ type: 'text', text: `${name} done` });
      o.onEvent({ type: 'text_end' });
      return { sessionId: `session-${name}` };
    },
  };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  calls = [];
  db = openDatabase(':memory:');
  store = new Store(db);
  orchestrator = new Orchestrator(store, new Hub(), new SettingsStore(db));
  project = join(root, `project-${++n}`);
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'shared.txt'), 'original\n');
  gate = Promise.resolve();
});

const agents: AgentConfig[] = [
  { id: 'a', name: 'Alice', provider: 'claude', role: '' },
  { id: 'b', name: 'Bob', provider: 'claude', role: '' },
];

function conversation(settings: Partial<ConversationSettings>): Conversation {
  const conv: Conversation = {
    id: `conv-${n}-${Math.random().toString(36).slice(2)}`,
    title: 'test',
    createdAt: 0,
    updatedAt: 0,
    agents,
    settings: { mode: 'parallel', rounds: 1, maxHops: 5, permission: 'edit', cwd: project, ...settings },
    messages: [],
    agentState: {},
    worktrees: {},
  };
  store.create(conv);
  return conv;
}

async function finish(convId: string): Promise<void> {
  await vi.waitFor(() => expect(orchestrator.isRunning(convId)).toBe(false), { timeout: 20_000, interval: 50 });
}

const agentMessages = (conv: Conversation) => conv.messages.filter((m) => m.author.kind === 'agent');

describe('parallel mode with edit permission', () => {
  it('gives each agent its own worktree so they cannot overwrite each other', async () => {
    const conv = conversation({ mode: 'parallel' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    // The directory became a git repository automatically.
    expect(conv.messages[0]!.author.kind).toBe('system');
    expect(conv.messages[0]!.parts[0]).toMatchObject({ text: expect.stringContaining('git init') });

    // The real directory is untouched; each agent's write landed in its own worktree.
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('original\n');
    for (const a of agents) {
      const wt = conv.worktrees[a.id]!;
      expect(readFileSync(join(wt.path, 'shared.txt'), 'utf8')).toBe(`written by ${a.name}\n`);
    }
    for (const m of agentMessages(conv)) {
      expect(m.status).toBe('done');
      expect(m.changes?.isolated).toBe(true);
      expect(m.changes?.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual([
        `A ${m.agentName}.txt`,
        'M shared.txt',
      ]);
    }

    // Apply Bob's result; Alice's is now out of date.
    await orchestrator.applyAgentWork(conv.id, 'b');
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    expect(readFileSync(join(project, 'Bob.txt'), 'utf8')).toBe('Bob\n');
    expect(Object.values(conv.worktrees).every((w) => w.needsReset)).toBe(true);
    await expect(orchestrator.applyAgentWork(conv.id, 'a')).rejects.toThrow(/過期/);

    // The next parallel run starts both agents from the new state of the directory.
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(Object.values(conv.worktrees).some((w) => w.needsReset)).toBe(false);
    const aliceWt = conv.worktrees.a!.path;
    expect(readFileSync(join(aliceWt, 'Bob.txt'), 'utf8')).toBe('Bob\n');

    await orchestrator.cleanupWorktrees(conv);
  });
});

describe('roundtable mode with edit permission', () => {
  it('lets agents work in the real directory and records what each one changed', async () => {
    const conv = conversation({ mode: 'roundtable' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    const [alice, bob] = agentMessages(conv);
    expect(alice!.changes).toMatchObject({ isolated: false });
    expect(alice!.changes!.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'shared.txt']);
    expect(bob!.changes!.files.map((f) => f.path).sort()).toEqual(['Bob.txt', 'shared.txt']);
    expect(conv.worktrees).toEqual({});
  });

  it('does not let two conversations write to the same directory at once', async () => {
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const first = conversation({ mode: 'roundtable' });
    const second = conversation({ mode: 'relay' });

    await orchestrator.send(first.id, 'go');
    await expect(orchestrator.send(second.id, 'go')).rejects.toThrow(/正在修改/);
    // Read-only conversations are not blocked.
    const reader = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(reader.id, 'look');

    release();
    await finish(first.id);
    await finish(reader.id);
    await orchestrator.send(second.id, 'go');
    await finish(second.id);
  });
});

describe('editing a user message', () => {
  const kinds = (conv: Conversation) => conv.messages.map((m) => m.author.kind);

  it('drops it and everything after, then every agent starts over from the remaining history', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'second question');
    await finish(conv.id);
    expect(kinds(conv)).toEqual(['user', 'agent', 'agent', 'user', 'agent', 'agent']);
    expect(calls.at(-1)!.sessionId).toBe('session-Bob'); // resumed normally so far

    const edited = conv.messages[3]!;
    const dropped = conv.messages.slice(3).map((m) => m.id);
    calls = [];
    await orchestrator.resend(conv.id, edited.id, 'second question, edited');
    await finish(conv.id);

    expect(kinds(conv)).toEqual(['user', 'agent', 'agent', 'user', 'agent', 'agent']);
    expect(conv.messages[3]!.parts).toEqual([{ type: 'text', text: 'second question, edited' }]);
    expect(conv.messages.some((m) => dropped.includes(m.id))).toBe(false);

    // Fresh CLI sessions, given the history up to the edit and nothing after it.
    expect(calls.map((c) => [c.name, c.sessionId])).toEqual([
      ['Alice', undefined],
      ['Bob', undefined],
    ]);
    expect(calls[0]!.prompt).toContain('first question');
    expect(calls[0]!.prompt).toContain('second question, edited');
    expect(calls[0]!.prompt.match(/second question/g)).toHaveLength(1); // the dropped original is gone

    // The database agrees with memory.
    const reloaded = new Store(db).get(conv.id)!;
    expect(reloaded.messages.map((m) => m.id)).toEqual(conv.messages.map((m) => m.id));
  });

  it('refuses while the team is replying, and for messages that are not the user\'s', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'question');
    const userMsg = conv.messages[0]!;
    await expect(orchestrator.resend(conv.id, userMsg.id, 'changed')).rejects.toThrow(/回覆中/);
    release();
    await finish(conv.id);

    const agentMsg = conv.messages.find((m) => m.author.kind === 'agent')!;
    await expect(orchestrator.resend(conv.id, agentMsg.id, 'x')).rejects.toThrow(/找不到這則訊息/);
    await expect(orchestrator.resend(conv.id, userMsg.id, '   ')).rejects.toThrow(/不能是空的/);
    expect(conv.messages[0]!.id).toBe(userMsg.id); // nothing was dropped
  });
});
