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
let project: string;
/** Resolves when the fake agent may finish its turn. */
let gate: Promise<void> = Promise.resolve();

// A fake CLI: writes `<name>.txt` and `shared.txt` in its cwd, then replies.
beforeAll(() => {
  runners.claude = {
    provider: 'claude',
    async run(o) {
      const name = /You are @(\w+)/.exec(o.systemPrompt)![1]!;
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
  const db = openDatabase(':memory:');
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
