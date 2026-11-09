import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, Conversation, ConversationSchedule, ConversationSettings } from '../src/shared/types';

// Worktrees live under RELAY_DATA_DIR, which is read when the server modules load.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-orch-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { AgentRunError, runners } = await import('../src/server/agents');
const { PLANNER_BRIEFING } = await import('../src/server/planner');
const { GROUPER_BRIEFING } = await import('../src/server/grouping');
const { attachmentPath, attachmentsDir, safeFileName } = await import('../src/server/attachments');
const { MISSED_AFTER_MS, Scheduler } = await import('../src/server/scheduler');

let n = 0;
let orchestrator: InstanceType<typeof Orchestrator>;
let store: InstanceType<typeof Store>;
let db: ReturnType<typeof openDatabase>;
let project: string;
/** Resolves when the fake agent may finish its turn. */
let gate: Promise<void> = Promise.resolve();
/** Every fake CLI run, in order. */
let calls: {
  name: string;
  sessionId?: string;
  prompt: string;
  images?: { path: string; mimeType: string }[];
  attachmentsDir?: string;
  nativeOff?: readonly string[];
  nativeItems?: Record<string, string[]>;
}[] = [];
let settings: InstanceType<typeof SettingsStore>;
/** What the fake lead agent replies when asked to design a team (auto team). */
let leadReply = '';
/** When set, the fake lead agent waits for it before replying. */
let leadGate: Promise<void> | undefined;
/** What the fake lead agent replies when asked to sort a conversation into a sidebar group. */
let sorterReply = '{"group": 0}';
/** When set, the fake lead agent waits for it before sorting (or until it is stopped). */
let sorterGate: Promise<void> | undefined;
/** Runs inside an agent's fake CLI turn after it wrote its files (e.g. to commit them itself). */
let during: ((name: string, cwd: string) => void) | undefined;
/** Per-agent gates: when set, that agent waits for its own gate instead of `gate`. */
let gates: Record<string, Promise<void>> = {};
/** Agents that ask the user a question until their prompt carries an answer ("ANSWER:"). */
let asking = new Set<string>();
/** Makes an agent's fake CLI run fail (after it wrote its files), e.g. to simulate a rate limit. */
let fail: ((name: string, sessionId?: string) => Error | undefined) | undefined;

// A fake CLI: writes `<name>.txt` and `shared.txt` in its cwd, then replies.
beforeAll(() => {
  runners.claude = {
    provider: 'claude',
    async run(o) {
      if (o.systemPrompt === GROUPER_BRIEFING) {
        calls.push({ name: 'sorter', prompt: o.prompt, nativeOff: o.nativeOff, nativeItems: o.nativeItems });
        if (sorterGate && !o.signal?.aborted) {
          await Promise.race([sorterGate, new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }))]);
        }
        if (o.signal?.aborted) throw new AgentRunError('stopped', true);
        o.onEvent({ type: 'text', text: sorterReply });
        o.onEvent({ type: 'text_end' });
        return { sessionId: 'sorter-session' };
      }
      if (o.systemPrompt === PLANNER_BRIEFING) {
        calls.push({ name: 'lead', sessionId: o.sessionId, prompt: o.prompt, nativeOff: o.nativeOff, nativeItems: o.nativeItems });
        if (leadGate) await leadGate;
        o.onEvent({ type: 'text', text: leadReply });
        o.onEvent({ type: 'text_end' });
        return { costUsd: 0.01, sessionId: 'lead-session' };
      }
      const name = /You are @(\w+)/.exec(o.systemPrompt)![1]!;
      calls.push({
        name,
        sessionId: o.sessionId,
        prompt: o.prompt,
        images: o.images,
        attachmentsDir: o.attachmentsDir,
        nativeOff: o.nativeOff,
        nativeItems: o.nativeItems,
      });
      writeFileSync(join(o.cwd, 'shared.txt'), `written by ${name}\n`);
      writeFileSync(join(o.cwd, `${name}.txt`), `${name}\n`);
      during?.(name, o.cwd);
      // Like a real CLI, a run ends when it is stopped.
      if (!o.signal?.aborted) {
        await Promise.race([gates[name] ?? gate, new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }))]);
      }
      if (o.signal?.aborted) throw new AgentRunError('stopped', true);
      const failure = fail?.(name, o.sessionId);
      if (failure) throw failure;
      if (o.prompt.includes('crash after asking')) {
        // The CLI asks, then dies before the user answers.
        void o.requestApproval?.({ kind: 'command', detail: 'npm install left-pad' });
        throw new Error('CLI crashed');
      }
      if (o.prompt.includes('please install')) {
        // Something the permission does not cover: ask (when the conversation asks).
        const answer = o.requestApproval
          ? await o.requestApproval({ kind: 'command', detail: 'npm install left-pad', reason: 'Install a dependency' })
          : undefined;
        const outcome = !answer ? 'not asked' : answer.allow ? 'installed' : `skipped (${answer.note ?? 'no note'})`;
        o.onEvent({ type: 'text', text: `${name} ${outcome}` });
        o.onEvent({ type: 'text_end' });
        return { sessionId: `session-${name}` };
      }
      if (asking.has(name) && !o.prompt.includes('ANSWER:')) {
        o.onEvent({ type: 'text', text: `${name} asks: A or B?\n\n[ASK_USER]` });
        o.onEvent({ type: 'text_end' });
        return { sessionId: `session-${name}` };
      }
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
  // Only the fake claude CLI exists here, so the lead agent may only staff claude members.
  settings = new SettingsStore(db);
  orchestrator = new Orchestrator(store, new Hub(), settings, {
    context: async () => ({ available: ['claude'], catalog: [], presets: store.listPresets() }),
  });
  leadReply = '';
  leadGate = undefined;
  sorterReply = '{"group": 0}';
  sorterGate = undefined;
  fail = undefined;
  during = undefined;
  gates = {};
  asking = new Set();
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
const textOf = (m: Conversation['messages'][number]) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

describe('AgentsView', () => {
  /** A sink that records what it was told. */
  function sink() {
    const told: { id: string; sessions: (string | undefined)[]; replies: number }[] = [];
    const links: string[] = [];
    const forgotten: string[] = [];
    return {
      told,
      links,
      forgotten,
      schedule: (c: Conversation) =>
        told.push({ id: c.id, sessions: Object.values(c.agentState).map((s) => s.sessionId), replies: agentMessages(c).length }),
      link: (c: Conversation, provider: string, sessionId: string) => links.push(`${c.id} ${provider}:${sessionId}`),
      forget: (id: string) => forgotten.push(id),
    };
  }

  it("is told after every turn and when the run ends, with the agents' sessions known by then", async () => {
    const traces = sink();
    orchestrator = new Orchestrator(store, new Hub(), settings, undefined, traces);
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    expect(traces.told.map((x) => x.id)).toEqual([conv.id, conv.id, conv.id]);
    expect(traces.told[0]).toMatchObject({ sessions: ['session-Alice'], replies: 1 });
    expect(traces.told[2]).toMatchObject({ sessions: ['session-Alice', 'session-Bob'], replies: 2 });
  });

  it("links the lead agent's and the group sorter's sessions to the conversation", async () => {
    const traces = sink();
    orchestrator = new Orchestrator(
      store,
      new Hub(),
      settings,
      { context: async () => ({ available: ['claude'], catalog: [], presets: store.listPresets() }) },
      traces,
    );
    store.createGroup({ id: 'g1', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    leadReply = '{"template": "general-panel", "reason": "fits"}';
    await orchestrator.send(conv.id, 'what should we write?');
    await finish(conv.id);
    await orchestrator.settled(5000);
    expect(traces.links).toEqual(expect.arrayContaining([`${conv.id} claude:lead-session`, `${conv.id} claude:sorter-session`]));
  });

  it('sends the conversation again when the group sorter finishes after the run', async () => {
    const events: string[] = [];
    const traces = {
      schedule: () => events.push('schedule'),
      link: (_c: Conversation, provider: string, sessionId: string) => events.push(`link ${provider}:${sessionId}`),
    };
    orchestrator = new Orchestrator(store, new Hub(), settings, undefined, traces);
    store.createGroup({ id: 'g1', name: 'Docs' });
    let release!: () => void;
    sorterGate = new Promise((r) => (release = r));
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', rounds: 1 });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(events).not.toContain('link claude:sorter-session');
    release();
    await orchestrator.settled(5000);
    expect(events.slice(-2)).toEqual(['link claude:sorter-session', 'schedule']);
  });

  it('is not told about a conversation deleted while it replies, only to forget it', async () => {
    gate = new Promise(() => {}); // the agents only finish when stopped
    const traces = sink();
    orchestrator = new Orchestrator(store, new Hub(), settings, undefined, traces);
    const conv = conversation({ mode: 'parallel', permission: 'read-only' });
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(true));
    await orchestrator.deleteConversation(conv.id);
    expect(traces.told).toEqual([]);
    expect(traces.forgotten).toEqual([conv.id]);
  });

  it('keeps the run whole when telling fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    orchestrator = new Orchestrator(store, new Hub(), settings, undefined, {
      schedule: () => {
        throw new Error('sink broke');
      },
    });
    try {
      const conv = conversation({ mode: 'roundtable' }); // edit: locks the directory
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      expect(agentMessages(conv).map((m) => m.status)).toEqual(['done', 'done']);
      // The directory is free again: another conversation can write there.
      const next = conversation({ mode: 'roundtable' });
      await orchestrator.send(next.id, 'go');
      await finish(next.id);
      expect(agentMessages(next)).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });
});

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

describe('what a CLI loads by itself', () => {
  it("leaves out of every agent's run what the user turned off for that CLI", async () => {
    settings.update('claude', { nativeOff: ['mcp', 'memory'], nativeItems: { skills: ['commit'] } });
    const conv = conversation({ mode: 'roundtable' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const turns = calls.filter((c) => c.name === 'Alice' || c.name === 'Bob');
    expect(turns).toHaveLength(2);
    expect(turns.every((c) => c.nativeOff?.join() === 'mcp,memory')).toBe(true);
    expect(turns.every((c) => c.nativeItems?.skills?.join() === 'commit')).toBe(true);
  });

  it("leaves it out of the lead agent's and the group sorter's runs too", async () => {
    settings.update('claude', { nativeOff: ['skills', 'instructions'], nativeItems: { tools: ['WebSearch'] } });
    store.createGroup({ id: 'g1', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [];
    leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
    await orchestrator.send(conv.id, 'Write the README');
    await finish(conv.id);
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(false));
    const helpers = calls.filter((c) => c.name === 'lead' || c.name === 'sorter');
    expect(helpers.map((c) => c.name).sort()).toEqual(['lead', 'sorter']);
    expect(helpers.every((c) => c.nativeOff?.join() === 'skills,instructions')).toBe(true);
    expect(helpers.every((c) => c.nativeItems?.tools?.join() === 'WebSearch')).toBe(true);
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

describe('auto team', () => {
  const autoConversation = () => conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
  const customTeam = JSON.stringify({
    choice: 'custom',
    name: 'Research pair',
    description: 'Look it up, then check it',
    mode: 'roundtable',
    rounds: 1,
    agents: [
      { name: 'Alice', provider: 'claude', role: 'Research it.' },
      { name: 'Bob', provider: 'grok', role: 'Check it.' },
    ],
    reason: 'Two views beat one.',
  });

  it('lets the lead agent design the team from the request; the team answers once the user confirmed it', async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = 'Here is my choice:\n```json\n' + customTeam + '\n```';
    await orchestrator.send(conv.id, 'I want to understand functional programming');
    await finish(conv.id);

    // Only the lead agent ran: the request is not a question for the team.
    expect(calls.map((c) => c.name)).toEqual(['lead']);
    expect(calls[0]!.prompt).toContain('<request>\nI want to understand functional programming\n</request>');
    const [request, plan] = conv.messages;
    expect(conv.messages).toHaveLength(2);
    expect(request!.author.kind).toBe('user');
    expect(plan!.plan).toMatchObject({ status: 'ready', source: 'custom', name: 'Research pair', reason: 'Two views beat one.', awaitingConfirmation: true });
    expect(plan!.meta?.costUsd).toBe(0.01);
    // Grok is not available here, so Bob runs on the lead's CLI.
    expect(conv.agents.map((a) => [a.name, a.provider])).toEqual([
      ['Alice', 'claude'],
      ['Bob', 'claude'],
    ]);
    expect(conv.settings.autoTeam).toBeFalsy();

    // Nobody answers until the user confirms the team: a question asked meanwhile waits for it.
    expect(await orchestrator.send(conv.id, 'What is a monad?')).toEqual({ queued: true });
    await expect(orchestrator.send(conv.id, '')).rejects.toThrow(/確認/);
    expect(conv.messages).toHaveLength(2);
    expect(calls.map((c) => c.name)).toEqual(['lead']);
    orchestrator.confirmPlan(conv.id, plan!.id);
    expect(plan!.plan!.awaitingConfirmation).toBeUndefined();
    expect(plan!.plan!.confirmedAt).toEqual(expect.any(Number));

    // Confirming sends it.
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(conv.messages[2]!.author.kind).toBe('user');
    expect(conv.messages[2]!.queued).toBeUndefined(); // a first question, not one added mid-reply
    expect(conv.queue).toEqual([]);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice', 'Bob']);
    // The team sees the request as context, and the question; never the plan.
    expect(calls[1]!.prompt).toContain('I want to understand functional programming');
    expect(calls[1]!.prompt).toContain('What is a monad?');
    expect(calls[1]!.prompt).not.toContain('Research pair');
    expect(agentMessages(conv).map((m) => m.agentName)).toEqual(['Alice', 'Bob']);

    const preset = orchestrator.savePlanAsPreset(conv.id, plan!.id, 'My research pair');
    expect(store.listPresets().find((p) => p.id === preset.id)).toMatchObject({ name: 'My research pair' });
    expect(plan!.plan!.savedPresetId).toBe(preset.id);

    const reloaded = new Store(db).get(conv.id)!;
    expect(reloaded.messages[1]!.plan).toMatchObject({ source: 'custom', savedPresetId: preset.id, confirmedAt: plan!.plan!.confirmedAt });
    expect(reloaded.messages[1]!.plan!.awaitingConfirmation).toBeUndefined();
    expect(reloaded.settings.autoTeam).toBeUndefined();
  });

  it('keeps a question asked while the lead agent designs the team until the user confirms it', async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = customTeam;
    let release!: () => void;
    leadGate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'Help me learn Haskell');
    expect(await orchestrator.send(conv.id, 'What is a monad?')).toEqual({ queued: true });
    release();
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead']);
    expect(conv.queue!.map(textOf)).toEqual(['What is a monad?']);

    orchestrator.confirmPlan(conv.id, conv.messages.find((m) => m.plan)!.id);
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice', 'Bob']);
    expect(calls[1]!.prompt).toContain('What is a monad?');
  });

  it('takes a team set by hand as confirmation', async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = customTeam;
    await orchestrator.send(conv.id, 'Help me plan a trip');
    await finish(conv.id);
    const plan = conv.messages.find((m) => m.plan)!;
    expect(plan.plan!.awaitingConfirmation).toBe(true);
    orchestrator.confirmPendingPlan(conv); // what PATCH { agents } does
    expect(plan.plan!.awaitingConfirmation).toBeUndefined();
    // Confirming again, or a plan that never waited, changes nothing.
    const at = plan.plan!.confirmedAt;
    orchestrator.confirmPlan(conv.id, plan.id);
    expect(plan.plan!.confirmedAt).toBe(at);
    expect(() => orchestrator.confirmPlan(conv.id, 'nope')).toThrow(/找不到這份團隊設計/);
  });

  it('uses an existing template when the lead picks one, and the default one when its reply is unusable', async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
    await orchestrator.send(conv.id, 'Sort a list in three languages');
    await finish(conv.id);
    expect(conv.messages[1]!.plan).toMatchObject({ source: 'template', presetId: 'builtin-parallel' });
    expect(conv.settings.mode).toBe('parallel');
    expect(() => orchestrator.savePlanAsPreset(conv.id, conv.messages[1]!.id)).toThrow(/設計或調整/);

    const other = autoConversation();
    other.agents = [];
    leadReply = 'I would pick a nice team.';
    await orchestrator.send(other.id, 'Hello');
    await finish(other.id);
    expect(other.messages[1]!.plan).toMatchObject({ source: 'fallback', presetId: 'builtin-general' });
    expect(other.agents.map((a) => a.name)).toEqual(['Analyst', 'Critic', 'Synthesizer']);
  });

  it('designs the team again when the request is edited', async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = customTeam;
    await orchestrator.send(conv.id, 'First version');
    await finish(conv.id);
    calls = [];
    // Editing is allowed while the design waits; it is designed again and waits again.
    await orchestrator.resend(conv.id, conv.messages[0]!.id, 'Second version');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead']);
    expect(calls[0]!.prompt).toContain('Second version');
    const plans = conv.messages.filter((m) => m.plan);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.plan!.awaitingConfirmation).toBe(true);
  });
});

describe('approvals', () => {
  const solo = (settings: Partial<ConversationSettings> = {}) => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', ...settings });
    conv.agents = [agents[0]!];
    return conv;
  };
  const pendingApproval = (conv: Conversation) =>
    conv.messages.flatMap((m) => m.parts).find((p) => p.type === 'approval' && p.status === 'pending') as
      | Extract<Conversation['messages'][number]['parts'][number], { type: 'approval' }>
      | undefined;
  const approvals = (conv: Conversation) =>
    conv.messages.flatMap((m) => m.parts).filter((p) => p.type === 'approval') as Extract<
      Conversation['messages'][number]['parts'][number],
      { type: 'approval' }
    >[];
  const lastReply = (conv: Conversation) => agentMessages(conv).at(-1)!.parts.find((p) => p.type === 'text');

  it('asks the user, waits, and remembers "always allow" for the conversation', async () => {
    const conv = solo();
    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    expect(store.list(() => true, (id) => orchestrator.isWaiting(id)).find((c) => c.id === conv.id)?.waiting).toBe(true);
    const pending = pendingApproval(conv)!;
    expect(pending).toMatchObject({ kind: 'command', detail: 'npm install left-pad', ruleLabel: 'npm install', reason: 'Install a dependency' });

    orchestrator.answerApproval(conv.id, pending.id, { allow: true, always: true });
    await finish(conv.id);
    expect(orchestrator.isWaiting(conv.id)).toBe(false);
    expect(approvals(conv)[0]).toMatchObject({ status: 'allowed', always: true });
    expect(lastReply(conv)).toEqual({ type: 'text', text: 'Alice installed' });
    expect(conv.allowRules).toEqual([{ kind: 'command', key: 'npm install' }]);

    // The next request like it is allowed without asking.
    await orchestrator.send(conv.id, 'please install again');
    await finish(conv.id);
    expect(approvals(conv)[1]).toMatchObject({ status: 'allowed', auto: true });

    // Both the answers and the rule survive a reload.
    const reloaded = new Store(db).get(conv.id)!;
    expect(reloaded.allowRules).toEqual([{ kind: 'command', key: 'npm install' }]);
    expect(approvals(reloaded).map((a) => a.status)).toEqual(['allowed', 'allowed']);
  });

  it('passes a decline note to the agent, and expires requests when the run is stopped', async () => {
    const conv = solo();
    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(pendingApproval(conv)).toBeTruthy());
    orchestrator.answerApproval(conv.id, pendingApproval(conv)!.id, { allow: false, note: 'use yarn' });
    await finish(conv.id);
    expect(approvals(conv)[0]).toMatchObject({ status: 'denied', note: 'use yarn' });
    expect(lastReply(conv)).toEqual({ type: 'text', text: 'Alice skipped (use yarn)' });
    expect(() => orchestrator.answerApproval(conv.id, approvals(conv)[0]!.id, { allow: true })).toThrow(/已經處理過/);

    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(pendingApproval(conv)).toBeTruthy());
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(approvals(conv)[1]!.status).toBe('expired');
  });

  it('does not ask when the conversation refuses automatically', async () => {
    const conv = solo({ approvals: 'deny' });
    await orchestrator.send(conv.id, 'please install');
    await finish(conv.id);
    expect(approvals(conv)).toEqual([]);
    expect(lastReply(conv)).toEqual({ type: 'text', text: 'Alice not asked' });
  });
});

describe('retrying a reply', () => {
  it('lets that agent, and the later speakers of its round, answer again', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    const [alice, bob] = agentMessages(conv);

    calls = [];
    await orchestrator.retry(conv.id, alice!.id);
    await finish(conv.id);
    expect(calls.map((c) => [c.name, c.sessionId])).toEqual([
      ['Alice', undefined],
      ['Bob', undefined],
    ]);
    expect(agentMessages(conv).map((m) => m.agentName)).toEqual(['Alice', 'Bob']);
    expect(conv.messages.some((m) => m.id === alice!.id || m.id === bob!.id)).toBe(false);

    calls = [];
    await orchestrator.retry(conv.id, agentMessages(conv)[1]!.id);
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Bob']);
    expect(conv.messages.map((m) => m.author.kind)).toEqual(['user', 'agent', 'agent']);
  });

  it('refuses user messages and agents that left the team', async () => {
    const conv = conversation({ mode: 'relay', permission: 'read-only' });
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    await expect(orchestrator.retry(conv.id, conv.messages[0]!.id)).rejects.toThrow(/找不到這則訊息/);
    const reply = agentMessages(conv)[0]!;
    conv.agents = [agents[1]!];
    await expect(orchestrator.retry(conv.id, reply.id)).rejects.toThrow(/不在團隊中/);
  });
});

describe('attached files', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const uploads = () => [
    { name: 'shot.png', mimeType: 'image/png', data: png.toString('base64') },
    { name: '../../notes.txt', mimeType: 'text/plain', data: Buffer.from('secret: marmalade\n').toString('base64') },
  ];
  const files = (m: { parts: { type: string }[] }) =>
    m.parts.filter((p): p is Extract<Conversation['messages'][number]['parts'][number], { type: 'attachment' }> => p.type === 'attachment');

  it('saves them, shows images to every agent and lists every file with its path', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'what is in these?', uploads());
    await finish(conv.id);

    const user = store.get(conv.id)!.messages[0]!;
    const [image, notes] = files(user);
    expect(image).toMatchObject({ name: 'shot.png', mimeType: 'image/png', size: png.length });
    expect(notes!.name).toBe('notes.txt'); // no directories in names
    expect(readFileSync(attachmentPath(conv.id, notes!), 'utf8')).toBe('secret: marmalade\n');

    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    for (const call of calls) {
      expect(call.images).toEqual([{ path: attachmentPath(conv.id, image!), mimeType: 'image/png' }]);
      expect(call.attachmentsDir).toBe(attachmentsDir(conv.id));
      expect(call.prompt).toContain(`notes.txt (text/plain, 18 B): ${attachmentPath(conv.id, notes!)}`);
    }

    // A later message without files shows no images again.
    calls = [];
    await orchestrator.send(conv.id, 'thanks');
    await finish(conv.id);
    expect(calls.every((c) => c.images?.length === 0 && c.attachmentsDir === undefined)).toBe(true);
  });

  it('keeps the files of an edited message and deletes those of dropped messages', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'first', uploads());
    await finish(conv.id);
    await orchestrator.send(conv.id, 'second', [{ name: 'later.txt', mimeType: 'text/plain', data: 'aGk=' }]);
    await finish(conv.id);
    const before = store.get(conv.id)!.messages.filter((m) => m.author.kind === 'user');
    const kept = files(before[0]!);
    const dropped = files(before[1]!)[0]!;

    await orchestrator.resend(conv.id, before[0]!.id, 'first, edited');
    await finish(conv.id);
    const user = store.get(conv.id)!.messages.filter((m) => m.author.kind === 'user');
    expect(user).toHaveLength(1);
    expect(files(user[0]!).map((p) => p.id)).toEqual(kept.map((p) => p.id));
    expect(readFileSync(attachmentPath(conv.id, kept[1]!), 'utf8')).toContain('marmalade');
    expect(() => readFileSync(attachmentPath(conv.id, dropped))).toThrow();
  });

  it('accepts a message that is only files, and rejects bad uploads', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.title = 'New chat'; // the default title, which the first message replaces
    store.saveMeta(conv);
    await expect(orchestrator.send(conv.id, 'x', [{ name: 'a.txt' }])).rejects.toMatchObject({ status: 400 });
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `${i}.txt`, mimeType: 'text/plain', data: 'aGk=' }));
    await expect(orchestrator.send(conv.id, 'x', many)).rejects.toMatchObject({ status: 400 });
    expect(store.get(conv.id)!.messages).toHaveLength(0);

    await orchestrator.send(conv.id, '', [{ name: 'diagram.png', mimeType: 'image/png', data: png.toString('base64') }]);
    await finish(conv.id);
    const saved = store.get(conv.id)!;
    expect(saved.messages[0]!.parts.map((p) => p.type)).toEqual(['attachment']);
    expect(saved.title).toBe('diagram.png');
  });

  it('makes file names safe to put on disk', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(safeFileName('.hidden')).toBe('hidden');
    expect(safeFileName('a\u0000b:c?.txt')).toBe('a_b_c_.txt');
    expect(safeFileName('')).toBe('file');
  });
});

const firstUserMessage = (conv: Conversation) => conv.messages.find((m) => m.author.kind === 'user')!;

describe('concurrent requests', () => {
  it('queues a second send and refuses a settings change while a run is being set up', async () => {
    const conv = conversation({ mode: 'roundtable' });
    const sending = orchestrator.send(conv.id, 'go'); // reserves the conversation, then prepares the workspace
    expect(await orchestrator.send(conv.id, 'again')).toEqual({ queued: true });
    await expect(orchestrator.send(conv.id, '')).rejects.toThrow(/回覆中/); // nothing to queue
    await expect(orchestrator.exclusive(conv.id, 'busy', async () => {})).rejects.toThrow('busy');
    await sending;
    await finish(conv.id);
    // Sent after "go", so it waited for the first turn.
    const chat = conv.messages.filter((m) => m.author.kind !== 'system'); // not the "git init" note
    expect(chat.map((m) => (m.author.kind === 'user' ? textOf(m) : m.agentName))).toEqual(['go', 'again', 'Alice', 'Bob']);
    await orchestrator.exclusive(conv.id, 'busy', async () => {}); // free again
  });

  it('does not start the team while a result is being applied, and unlocks the directory afterwards', async () => {
    const conv = conversation({ mode: 'parallel' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    const applying = orchestrator.applyAgentWork(conv.id, 'b');
    await expect(orchestrator.send(conv.id, 'next')).rejects.toThrow(/回覆中/);
    await applying;

    const other = conversation({ mode: 'roundtable' }); // same directory
    await orchestrator.send(other.id, 'go');
    await finish(other.id);
    await orchestrator.cleanupWorktrees(conv);
  });
});

describe('shutting down', () => {
  it('refuses new runs, applies and settings changes once everything was stopped', async () => {
    const conv = conversation({ mode: 'roundtable' });
    orchestrator.stopAll();
    await expect(orchestrator.send(conv.id, 'go')).rejects.toMatchObject({ status: 503 });
    await expect(orchestrator.exclusive(conv.id, 'busy', async () => {})).rejects.toMatchObject({ status: 503 });
  });

  it('does not start a run whose workspace was still being prepared when shutdown began', async () => {
    const conv = conversation({ mode: 'roundtable' });
    const sending = orchestrator.send(conv.id, 'go');
    orchestrator.stopAll();
    await expect(sending).rejects.toMatchObject({ status: 503 });
    expect(calls).toEqual([]);
  });
});

describe('kept snapshot refs', () => {
  const refs = () =>
    execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/harness-relay/'], { cwd: project, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

  it('are dropped with the messages that linked to them, and with the conversation', async () => {
    const conv = conversation({ mode: 'roundtable' });
    conv.agents = [agents[0]!];
    let turn = 0;
    during = (_name, cwd) => writeFileSync(join(cwd, 'turn.txt'), `turn ${++turn}\n`); // every turn changes a file
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    const kept = refs();
    expect(kept.length).toBe(2); // the turn's before and after snapshots

    await orchestrator.send(conv.id, 'second');
    await finish(conv.id);
    // (Its "before" may be the first turn's "after": same tree, parent and second give the same commit.)
    expect(refs().length).toBeGreaterThan(kept.length);

    // Editing the second question drops its turn (and its refs); the first turn's stay.
    const second = conv.messages.filter((m) => m.author.kind === 'user')[1]!;
    during = undefined; // the edited turn changes nothing
    await orchestrator.resend(conv.id, second.id, 'second, edited');
    await finish(conv.id);
    await vi.waitFor(() => expect(refs().sort()).toEqual([...kept].sort()));

    await orchestrator.deleteConversation(conv.id);
    expect(refs()).toEqual([]);
  });
});

describe('deleting a conversation', () => {
  it('waits for a settings change in progress, and then refuses further ones', async () => {
    const conv = conversation({ mode: 'roundtable' });
    let finishPatch!: () => void;
    const patching = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (finishPatch = r)));
    const deleting = orchestrator.deleteConversation(conv.id);
    await expect(orchestrator.exclusive(conv.id, 'busy', async () => {})).rejects.toMatchObject({ status: 404 });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.get(conv.id)).toBeDefined(); // not deleted under the running change
    finishPatch();
    await patching;
    await deleting;
    expect(store.get(conv.id)).toBeUndefined();
  });

  it('stops the team and waits for the run to wind down before removing it', async () => {
    gate = new Promise(() => {}); // the agents only finish when stopped
    const conv = conversation({ mode: 'parallel' });
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toHaveLength(2));
    const worktrees = Object.values(conv.worktrees).map((w) => w.path);

    await orchestrator.deleteConversation(conv.id);
    expect(orchestrator.isRunning(conv.id)).toBe(false);
    expect(store.get(conv.id)).toBeUndefined();
    for (const table of ['conversations', 'messages', 'agent_sessions', 'agent_worktrees', 'conversation_agents']) {
      const key = table === 'conversations' ? 'id' : 'conversation_id';
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${key} = ?`).get(conv.id)).toEqual({ n: 0 });
    }
    expect(worktrees.some((p) => existsSync(p))).toBe(false);
  });

  it('does not start the team when the conversation is deleted while its run is being set up', async () => {
    const conv = conversation({ mode: 'roundtable' });
    const sending = orchestrator.send(conv.id, 'go').catch((err: Error) => err); // rejects while delete waits for it
    await orchestrator.deleteConversation(conv.id);
    expect(String(await sending)).toMatch(/找不到對話/);
    expect(calls).toEqual([]);
    expect(orchestrator.isRunning(conv.id)).toBe(false);
  });
});

describe('auto team and the directory lock', () => {
  const teamIn = (mode: string) =>
    JSON.stringify({
      choice: 'custom',
      name: 'Pair',
      mode,
      rounds: 1,
      agents: [
        { name: 'Alice', provider: 'claude', role: 'Do it.' },
        { name: 'Bob', provider: 'claude', role: 'Check it.' },
      ],
      reason: 'Two of us.',
    });

  it('locks nothing while the lead agent designs the team', async () => {
    let release!: () => void;
    leadGate = new Promise((r) => (release = r));
    const conv = conversation({ mode: 'roundtable', autoTeam: true }); // may edit files
    conv.agents = [];
    leadReply = teamIn('roundtable');
    await orchestrator.send(conv.id, 'Request');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toContain('lead'), { interval: 20 });

    const other = conversation({ mode: 'roundtable' }); // same directory
    await orchestrator.send(other.id, 'go');
    await finish(other.id);
    release();
    await finish(conv.id);
  });

  it('locks the directory by the confirmed team\'s mode once the user asks', async () => {
    const plan = async (mode: string) => {
      const conv = conversation({ mode: 'roundtable', autoTeam: true });
      conv.agents = [];
      leadReply = teamIn(mode);
      await orchestrator.send(conv.id, 'Request');
      await finish(conv.id);
      orchestrator.confirmPlan(conv.id, conv.messages.find((m) => m.plan)!.id);
      return conv;
    };
    let release!: () => void;

    // Parallel: the agents write to their own worktrees, so the directory stays free.
    const parallel = await plan('parallel');
    gate = new Promise((r) => (release = r));
    await orchestrator.send(parallel.id, 'Question');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(parallel.id)).toHaveLength(2), { interval: 20 });
    const other = conversation({ mode: 'roundtable' });
    await orchestrator.send(other.id, 'go');
    release();
    await finish(parallel.id);
    await finish(other.id);
    await orchestrator.cleanupWorktrees(parallel);

    // Roundtable: the agents write to the directory itself.
    const shared = await plan('roundtable');
    gate = new Promise((r) => (release = r));
    await orchestrator.send(shared.id, 'Question');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(shared.id)).toHaveLength(1), { interval: 20 });
    await expect(orchestrator.send(conversation({ mode: 'roundtable' }).id, 'go')).rejects.toThrow(/正在修改/);
    release();
    await finish(shared.id);
  });

  it('keeps a team adjusted by hand when the first question is edited', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true });
    conv.agents = [];
    leadReply = teamIn('roundtable');
    await orchestrator.send(conv.id, 'First version');
    await finish(conv.id);

    // What PATCH { agents } does: a team set by hand replaces the lead agent's design.
    conv.agents = [{ id: 'z', name: 'Zed', provider: 'claude', role: 'My own pick.' }];
    conv.settings = { ...conv.settings, autoTeam: undefined };
    calls = [];
    await orchestrator.resend(conv.id, firstUserMessage(conv).id, 'Second version');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Zed']);
    expect(conv.agents.map((a) => a.name)).toEqual(['Zed']);
  });

  it('saves a plan as a template only once', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true });
    conv.agents = [];
    leadReply = teamIn('roundtable');
    await orchestrator.send(conv.id, 'Question');
    await finish(conv.id);
    const plan = conv.messages.find((m) => m.plan)!;
    const first = orchestrator.savePlanAsPreset(conv.id, plan.id, 'x'.repeat(500));
    expect(first.name).toHaveLength(100);
    const again = orchestrator.savePlanAsPreset(conv.id, plan.id, 'Another name');
    expect(again.id).toBe(first.id);
    expect(store.listPresets().filter((p) => !p.builtin)).toHaveLength(1);
  });
});

describe('failed turns', () => {
  it('keeps an agent\'s session when starting it fresh fails for the same reason', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.agents = [agents[0]!];
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    expect(conv.agentState.a!.sessionId).toBe('session-Alice');

    fail = () => new Error('rate limited'); // not a session problem: the fresh session fails too
    calls = [];
    await orchestrator.send(conv.id, 'second');
    await finish(conv.id);
    expect(calls.map((c) => c.sessionId)).toEqual(['session-Alice', undefined]);
    expect(agentMessages(conv).at(-1)).toMatchObject({ status: 'error', error: 'rate limited' });
    expect(conv.agentState.a!.sessionId).toBe('session-Alice');

    fail = undefined;
    calls = [];
    await orchestrator.send(conv.id, 'third');
    await finish(conv.id);
    expect(calls[0]!.sessionId).toBe('session-Alice');
    // The messages it missed are offered again.
    expect(calls[0]!.prompt).toContain('second');
  });

  it('tells teammates which files a failed turn changed', async () => {
    const conv = conversation({ mode: 'roundtable' });
    fail = (name) => (name === 'Alice' ? new Error('crashed') : undefined);
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const bob = calls.find((c) => c.name === 'Bob')!.prompt;
    expect(bob).toMatch(/<message from="@Alice"[^>]* status="failed">/);
    expect(bob).toMatch(/<changed_files>[\s\S]*A Alice\.txt/);

    // Alice had no session (her first turn failed), so she starts fresh and is shown her failed reply too.
    fail = undefined;
    calls = [];
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(calls.find((c) => c.name === 'Alice')!.prompt).toMatch(/<message from="@Alice"[^>]* status="failed">/);
  });

  it("does not send an agent its own stopped reply when its session holds it", async () => {
    const conv = conversation({ mode: 'roundtable' });
    conv.agents = [agents[0]!];
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    gate = new Promise(() => {}); // the next turn only ends when stopped
    await orchestrator.send(conv.id, 'second');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toHaveLength(1));
    orchestrator.stop(conv.id);
    await finish(conv.id);
    gate = Promise.resolve();
    calls = [];
    await orchestrator.send(conv.id, 'third');
    await finish(conv.id);
    expect(calls[0]!.sessionId).toBe('session-Alice');
    expect(calls[0]!.prompt).not.toContain('from="@Alice"');
    expect(calls[0]!.prompt).toContain('second'); // not delivered when it was stopped
  });

  it('keeps a parallel run going while a teammate still works, when saving one turn fails', async () => {
    const conv = conversation({ mode: 'parallel' });
    let releaseBob!: () => void;
    gates.Bob = new Promise((r) => (releaseBob = r));
    const save = store.saveMessage.bind(store);
    store.saveMessage = (convId, m, immediate) => {
      if (m.agentName === 'Alice' && m.status === 'done') throw new Error('database is locked');
      return save(convId, m, immediate);
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toEqual(['b']));
    await new Promise((r) => setTimeout(r, 50));
    expect(orchestrator.isRunning(conv.id)).toBe(true); // Bob is still working
    releaseBob();
    await finish(conv.id);
    errors.mockRestore();
    store.saveMessage = save;
    await orchestrator.cleanupWorktrees(conv);
  });
});

describe('approvals and the directory lock', () => {
  const pending = (conv: Conversation) =>
    conv.messages.flatMap((m) => m.parts).find((p) => p.type === 'approval' && p.status === 'pending') as
      | { id: string }
      | undefined;

  it('declines an approved action in a read-only conversation while another one writes the directory', async () => {
    const writer = conversation({ mode: 'roundtable' });
    writer.agents = [agents[0]!];
    await orchestrator.send(writer.id, 'please install'); // waits for its approval, holding the lock
    await vi.waitFor(() => expect(pending(writer)).toBeDefined());

    const reader = conversation({ mode: 'roundtable', permission: 'read-only' });
    reader.agents = [agents[0]!];
    await orchestrator.send(reader.id, 'please install');
    await vi.waitFor(() => expect(pending(reader)).toBeDefined());
    orchestrator.answerApproval(reader.id, pending(reader)!.id, { allow: true });
    await finish(reader.id);
    expect(textOf(agentMessages(reader)[0]!)).toContain('skipped');
    expect(agentMessages(reader)[0]!.parts.find((p) => p.type === 'approval')).toMatchObject({ status: 'denied' });

    orchestrator.answerApproval(writer.id, pending(writer)!.id, { allow: true });
    await finish(writer.id);
  });

  it('expires a request whose CLI died before the user answered', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.agents = [agents[0]!];
    await orchestrator.send(conv.id, 'crash after asking');
    await finish(conv.id);
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(false));
    const part = agentMessages(conv)[0]!.parts.find((p) => p.type === 'approval')!;
    expect(part).toMatchObject({ status: 'expired' });
    expect(() => orchestrator.answerApproval(conv.id, (part as { id: string }).id, { allow: true, always: true })).toThrow();
    expect(conv.allowRules ?? []).toEqual([]);
  });
});

describe('nested repositories', () => {
  it('does not let two conversations write a repository and one nested inside it at once', async () => {
    const inner = join(project, 'lib');
    mkdirSync(inner);
    execFileSync('git', ['init', '-q'], { cwd: inner });
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const outer = conversation({ mode: 'roundtable' }); // project: a repository of its own is created
    outer.agents = [agents[0]!];
    await orchestrator.send(outer.id, 'go');
    const nested = conversation({ mode: 'roundtable', cwd: inner });
    nested.agents = [agents[1]!];
    await expect(orchestrator.send(nested.id, 'go')).rejects.toThrow(/正在修改/);
    release();
    await finish(outer.id);
  });
});

describe('parallel worktrees', () => {
  it('records a turn whose agent committed its work itself', async () => {
    const conv = conversation({ mode: 'parallel' });
    during = (name, cwd) => {
      if (name !== 'Alice') return;
      execFileSync('git', ['add', '-A'], { cwd });
      execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@x', 'commit', '-q', '-m', 'mine'], { cwd });
    };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const alice = agentMessages(conv).find((m) => m.agentName === 'Alice')!;
    expect(alice.changes?.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'shared.txt']);
    await orchestrator.cleanupWorktrees(conv);
  });
});

describe('messages sent while the team replies', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const roundtable = (rounds = 1) => conversation({ mode: 'roundtable', permission: 'read-only', rounds });
  /** The chat as a list: what the user said, who replied, and notes. */
  const said = (conv: Conversation) =>
    conv.messages.map((m) => (m.author.kind === 'user' ? textOf(m) : m.author.kind === 'agent' ? `@${m.agentName}` : 'note'));
  /** Make an agent wait in its turn; returns the function that lets it finish. */
  const hold = (name: string) => {
    let release!: () => void;
    gates[name] = new Promise((r) => (release = r));
    return () => release();
  };
  /** A follow-up run starts after a short gap, so wait for its replies instead of the first run's end. */
  const replied = (conv: Conversation, n: number) =>
    vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status !== 'streaming')).toHaveLength(n), { timeout: 20_000 });

  it('reach the next speaker before its turn; the one speaking sees them on its next turn', async () => {
    const conv = roundtable(2);
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    expect(await orchestrator.send(conv.id, 'also check the tests')).toEqual({ queued: true });
    expect(conv.queue!.map(textOf)).toEqual(['also check the tests']);
    expect(said(conv)).toEqual(['question', '@Alice']); // not in the chat until it is delivered
    alice();
    await finish(conv.id);

    expect(said(conv)).toEqual(['question', '@Alice', 'also check the tests', '@Bob', '@Alice', '@Bob']);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob', 'Alice', 'Bob']);
    expect(calls[0]!.prompt).not.toContain('also check the tests');
    expect(calls[1]!.prompt).toContain('also check the tests');
    expect(calls[2]!.prompt).toContain('also check the tests');
    expect(calls[3]!.prompt).not.toContain('also check the tests'); // Bob has seen it already
    expect(conv.queue).toEqual([]);

    const reloaded = new Store(db).get(conv.id)!;
    expect(reloaded.messages.map((m) => m.id)).toEqual(conv.messages.map((m) => m.id));
    expect(reloaded.messages[2]!.queued).toBe(true);
    expect(reloaded.queue).toBeUndefined();
  });

  it('start another run when no turn took them', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only' });
    const alice = hold('Alice');
    const bob = hold('Bob');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await orchestrator.send(conv.id, 'one more thing');
    alice();
    bob();
    await replied(conv, 4);
    await finish(conv.id);
    expect(said(conv)).toEqual(['question', '@Alice', '@Bob', 'one more thing', '@Alice', '@Bob']);
    expect(calls.slice(2).every((c) => c.prompt.includes('one more thing'))).toBe(true);
  });

  it('wait for the agents they @mention', async () => {
    const conv = roundtable();
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    await orchestrator.send(conv.id, '@Alice what about X?');
    alice();
    await replied(conv, 3);
    await finish(conv.id);
    // Bob spoke next, but the message was for Alice: she answers it once the round is over.
    expect(said(conv)).toEqual(['question', '@Alice', '@Bob', '@Alice what about X?', '@Alice']);
    expect(calls[1]!.prompt).not.toContain('what about X');
  });

  it('stay in the order they were sent', async () => {
    const conv = roundtable();
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    await orchestrator.send(conv.id, '@Alice what about X?');
    await orchestrator.send(conv.id, 'and Y, everyone');
    alice();
    await replied(conv, 4);
    await finish(conv.id);
    // The second one is for Bob too, but it waits behind the first; then both start a run for everyone.
    expect(said(conv)).toEqual(['question', '@Alice', '@Bob', '@Alice what about X?', 'and Y, everyone', '@Alice', '@Bob']);
  });

  it('keep waiting after Stop; Stop and send posts them first', async () => {
    const conv = roundtable();
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'question');
    await orchestrator.send(conv.id, 'first addition');
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(said(conv)).toEqual(['question', '@Alice', 'note']);
    expect(conv.queue!.map(textOf)).toEqual(['first addition']);

    // The next message sends what was waiting first.
    await orchestrator.send(conv.id, 'second question');
    await orchestrator.send(conv.id, 'second addition');
    expect(await orchestrator.send(conv.id, 'do this instead', undefined, true)).toEqual({ queued: false });
    expect(said(conv)).toEqual([
      'question', '@Alice', 'note',
      'first addition', 'second question', '@Alice', 'note',
      'second addition', 'do this instead', '@Alice',
    ]);
    release();
    await finish(conv.id);
    expect(said(conv).slice(-2)).toEqual(['@Alice', '@Bob']);
  });

  it('can be withdrawn, survive a restart, are limited, and Continue sends them', async () => {
    const conv = roundtable();
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'question');
    await orchestrator.send(conv.id, 'look', [{ name: 'shot.png', mimeType: 'image/png', data: png }]);
    const [waiting] = conv.queue!;
    const file = waiting!.parts.find((p) => p.type === 'attachment') as Parameters<typeof attachmentPath>[1];
    expect(existsSync(attachmentPath(conv.id, file))).toBe(true);
    expect(new Store(db).get(conv.id)!.queue!.map((m) => m.id)).toEqual([waiting!.id]);

    expect(orchestrator.withdraw(conv.id, waiting!.id).id).toBe(waiting!.id);
    expect(conv.queue).toEqual([]);
    expect(existsSync(attachmentPath(conv.id, file))).toBe(false);
    expect(() => orchestrator.withdraw(conv.id, waiting!.id)).toThrow(/已經送出或撤回/);

    for (let i = 0; i < 20; i++) await orchestrator.send(conv.id, `note ${i}`);
    await expect(orchestrator.send(conv.id, 'one too many')).rejects.toThrow(/最多 20 則/);
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(conv.queue).toHaveLength(20);

    release();
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(conv.queue).toEqual([]);
    expect(conv.messages.filter((m) => m.queued)).toHaveLength(20);
    expect(said(conv).slice(-2)).toEqual(['@Alice', '@Bob']);
  });
});

describe('agents asking the user', () => {
  const said = (conv: Conversation) =>
    conv.messages.map((m) => (m.author.kind === 'user' ? textOf(m) : m.author.kind === 'agent' ? `@${m.agentName}` : 'note'));
  const told = (name: string) => calls.filter((c) => c.name === name).map((c) => c.prompt.includes('You asked the user a question'));

  it('stop the team until the user answers; then the one that asked answers first and the round goes on', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'which school of therapy?');
    await finish(conv.id);

    expect(said(conv)).toEqual(['which school of therapy?', '@Alice']); // Bob waits
    const question = conv.messages[1]!;
    expect(question.asked).toBe(true);
    expect(textOf(question)).toBe('Alice asks: A or B?'); // the marker is not part of the chat
    expect(conv.pause).toEqual({ mode: 'roundtable', askers: ['a'], rest: [{ agentId: 'b' }], participants: ['a', 'b'], round: 1, rounds: 1 });
    const reloaded = new Store(db).get(conv.id)!;
    expect(reloaded.pause).toEqual(conv.pause);
    expect(reloaded.messages[1]!.asked).toBe(true);
    expect(store.list(() => false).find((c) => c.id === conv.id)!.asking).toBe(true);

    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(said(conv)).toEqual(['which school of therapy?', '@Alice', 'ANSWER: A', '@Alice', '@Bob']);
    expect(told('Alice')).toEqual([false, true]);
    expect(told('Bob')).toEqual([false]);
    expect(calls.at(-1)!.prompt).toContain('Alice asks: A or B?'); // Bob sees the question and the answer
    expect(conv.pause).toBeUndefined();
    expect(new Store(db).get(conv.id)!.pause).toBeUndefined();
  });

  it('let the others go on when the user presses Continue', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(said(conv)).toEqual(['question', '@Alice', '@Bob']);
    expect(conv.pause).toBeUndefined();
  });

  it('start afresh when the reply is for someone else', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    await orchestrator.send(conv.id, '@Alice ANSWER: A'); // addressed to the one that asked: still an answer
    await finish(conv.id);
    expect(said(conv).slice(2)).toEqual(['@Alice ANSWER: A', '@Alice', '@Bob']);
    expect(told('Alice')).toEqual([false, true]);

    calls = [];
    asking = new Set(['Bob']);
    await orchestrator.send(conv.id, 'next question');
    await finish(conv.id);
    expect(conv.pause).toMatchObject({ askers: ['b'], rest: [] });
    await orchestrator.send(conv.id, '@Alice what do you think?');
    await finish(conv.id);
    expect(said(conv).slice(-2)).toEqual(['@Alice what do you think?', '@Alice']);
    expect(conv.pause).toBeUndefined();
    expect(told('Alice')).toEqual([false, false]);
  });

  it('in parallel mode, let the ones that asked answer again before the next round', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', rounds: 2 });
    asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    expect(said(conv)).toEqual(['question', '@Alice', '@Bob']); // round 1 ran side by side
    expect(conv.pause).toMatchObject({ askers: ['a'], rest: [], round: 1, rounds: 2 });

    await orchestrator.send(conv.id, 'ANSWER: B');
    await finish(conv.id);
    expect(said(conv).slice(3)).toEqual(['ANSWER: B', '@Alice', '@Alice', '@Bob']);
    expect(agentMessages(conv).map((m) => m.meta?.round)).toEqual([1, 1, 1, 2, 2]);
  });

  it('in relay mode, give the floor back to the one that asked', async () => {
    const conv = conversation({ mode: 'relay', permission: 'read-only', maxHops: 5 });
    asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    expect(conv.pause).toMatchObject({ mode: 'relay', askers: ['a'], rest: [], hopsLeft: 4 });
    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(said(conv)).toEqual(['question', '@Alice', 'ANSWER: A', '@Alice']);
    expect(calls.at(-1)!.prompt).toContain('You asked the user a question');
    expect(calls.at(-1)!.prompt).toContain('Mention a teammate to hand off');
  });

  it('are answered by editing the question that led to them', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    await orchestrator.resend(conv.id, conv.messages[0]!.id, 'question, ANSWER: B');
    await finish(conv.id);
    expect(said(conv)).toEqual(['question, ANSWER: B', '@Alice', '@Bob']);
    expect(conv.pause).toBeUndefined();
  });

  it('keep what the user wrote meanwhile waiting for the answer', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    asking = new Set(['Alice']);
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'question');
    await orchestrator.send(conv.id, 'a note');
    release();
    await finish(conv.id);
    // Alice asked: the note does not start another run.
    expect(said(conv)).toEqual(['question', '@Alice']);
    expect(conv.queue!.map(textOf)).toEqual(['a note']);

    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(said(conv)).toEqual(['question', '@Alice', 'a note', 'ANSWER: A', '@Alice', '@Bob']);
  });
});

describe('sorting new conversations into sidebar groups', () => {
  const groupOf = (convId: string) => store.list(() => false).find((c) => c.id === convId)?.groupId;

  it('lets the lead agent put a conversation in a group by its first message, next to the team', async () => {
    store.createGroup({ id: 'g1', name: 'Frontend' });
    store.createGroup({ id: 'g2', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    sorterReply = '```json\n{"group": 2}\n```';
    await orchestrator.send(conv.id, 'Write the README for the API');
    await finish(conv.id);
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(false));

    expect(groupOf(conv.id)).toBe('g2');
    const sorter = calls.find((c) => c.name === 'sorter')!;
    expect(sorter.prompt).toContain('Write the README for the API');
    expect(sorter.prompt).toContain('2. "Docs"');
    expect(calls.map((c) => c.name).sort()).toEqual(['Alice', 'Bob', 'sorter']);

    // Only the first message sorts it.
    await orchestrator.send(conv.id, 'And the changelog');
    await finish(conv.id);
    expect(calls.filter((c) => c.name === 'sorter')).toHaveLength(1);
  });

  it('asks nobody without groups, and keeps a conversation where the user put it meanwhile', async () => {
    const plain = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(plain.id, 'hello');
    await finish(plain.id);
    expect(calls.map((c) => c.name)).not.toContain('sorter');

    store.createGroup({ id: 'g1', name: 'Frontend' });
    store.createGroup({ id: 'g2', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    let release!: () => void;
    sorterGate = new Promise((r) => (release = r));
    sorterReply = '{"group": 2}';
    await orchestrator.send(conv.id, 'Fix the sidebar');
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(true));
    expect(store.list(() => false, () => false, (id) => orchestrator.isSorting(id)).find((c) => c.id === conv.id)?.sorting).toBe(true);
    store.moveToGroup(conv.id, 'g1');
    release();
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(false));
    expect(groupOf(conv.id)).toBe('g1');
  });

  it('stops sorting a conversation that is deleted', async () => {
    store.createGroup({ id: 'g1', name: 'Frontend' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    sorterGate = new Promise(() => {}); // never answers by itself
    await orchestrator.send(conv.id, 'Fix the sidebar');
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(true));
    await orchestrator.deleteConversation(conv.id);
    expect(orchestrator.isSorting(conv.id)).toBe(false);
    expect(store.list(() => false).some((c) => c.id === conv.id)).toBe(false);
  });
});

describe('schedules', () => {
  const HOUR = 3_600_000;
  /** Monday 5 January 2026, 08:00 UTC. */
  const T0 = Date.UTC(2026, 0, 5, 8, 0);
  let now = T0;
  const scheduler = () => new Scheduler(store, orchestrator, () => now);
  /** Give the conversation a schedule (English notes, every hour from T0, due at T0 + 1 h). */
  const schedule = (conv: Conversation, s: Partial<ConversationSchedule> = {}) => {
    conv.schedule = {
      text: 'scheduled check',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      updatedAt: T0,
      nextRunAt: T0 + HOUR,
      ...s,
    };
    store.saveSchedule(conv);
  };
  const said = (conv: Conversation) =>
    conv.messages.map((m) => (m.author.kind === 'user' ? textOf(m) : m.author.kind === 'agent' ? `@${m.agentName}` : 'note'));
  const notes = (conv: Conversation) => conv.messages.filter((m) => m.author.kind === 'system').map(textOf);
  const solo = (settings: Partial<ConversationSettings> = {}) => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', ...settings });
    conv.agents = [agents[0]!];
    store.saveMeta(conv);
    return conv;
  };
  const hold = (name: string) => {
    let release!: () => void;
    gates[name] = new Promise((r) => (release = r));
    return () => release();
  };

  it('sends the message when it comes due, marked as scheduled, then waits for the next time', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    now = T0 + HOUR - 1;
    await scheduler().tick();
    expect(conv.messages).toEqual([]); // not yet

    now = T0 + HOUR + 5000;
    await scheduler().tick();
    await finish(conv.id);
    expect(said(conv)).toEqual(['scheduled check', '@Alice', '@Bob']);
    expect(conv.messages[0]!.scheduled).toBe(true);
    expect(calls[0]!.prompt).toContain('<message from="user" via="schedule">');
    expect(conv.schedule).toMatchObject({ lastRunAt: T0 + HOUR, lastResult: 'sent', nextRunAt: T0 + 2 * HOUR, enabled: true });

    // Once is enough: the same look again sends nothing.
    await scheduler().tick();
    await finish(conv.id);
    expect(calls).toHaveLength(2);

    const reloaded = new Store(db).get(conv.id)!;
    expect(reloaded.schedule).toEqual(conv.schedule);
    expect(reloaded.messages[0]!.scheduled).toBe(true);
    expect(store.list(() => false).find((c) => c.id === conv.id)!.schedule).toEqual({
      enabled: true,
      nextRunAt: T0 + 2 * HOUR,
      lastResult: 'sent',
    });
  });

  it('refuses approvals in the runs it starts, unless the schedule says to ask', async () => {
    const conv = solo();
    schedule(conv, { text: 'please install' });
    now = T0 + HOUR;
    await scheduler().tick();
    await finish(conv.id);
    expect(textOf(agentMessages(conv).at(-1)!)).toBe('Alice not asked');

    schedule(conv, { text: 'please install', approvals: 'ask', nextRunAt: T0 + 2 * HOUR });
    now = T0 + 2 * HOUR;
    await scheduler().tick();
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    const pending = conv.messages.flatMap((m) => m.parts).find((p) => p.type === 'approval' && p.status === 'pending')!;
    orchestrator.answerApproval(conv.id, (pending as { id: string }).id, { allow: true });
    await finish(conv.id);
    expect(textOf(agentMessages(conv).at(-1)!)).toBe('Alice installed');

    // A run the user starts asks as usual.
    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    orchestrator.stop(conv.id);
    await finish(conv.id);
  });

  it('waits in the queue while the team replies, and holds a second one back until the first is delivered', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));

    now = T0 + HOUR;
    await scheduler().tick();
    expect(conv.schedule).toMatchObject({ lastResult: 'queued', nextRunAt: T0 + 2 * HOUR });
    expect(conv.queue).toEqual([expect.objectContaining({ scheduled: true, queued: true })]);

    now = T0 + 2 * HOUR;
    await scheduler().tick();
    expect(conv.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the previous scheduled message is still waiting to be delivered' });
    expect(conv.queue).toHaveLength(1);

    alice();
    await finish(conv.id);
    expect(said(conv)).toEqual([
      'question',
      '@Alice',
      'note', // the time it held back
      'scheduled check',
      '@Bob',
    ]);
    expect(notes(conv)[0]).toMatch(/^The scheduled message of .* was not sent: the previous scheduled message is still waiting/);
  });

  it('is held back when the queue is full', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    for (let i = 0; i < 20; i++) await orchestrator.send(conv.id, `@Alice note ${i}`);
    now = T0 + HOUR;
    await scheduler().tick();
    expect(conv.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the queue of waiting messages is full' });
    expect(conv.queue!.some((m) => m.scheduled)).toBe(false);
    orchestrator.stop(conv.id);
    alice();
    await finish(conv.id);
  });

  it('starts a run of its own, still refusing approvals, for a message no turn of the run took', async () => {
    const conv = solo();
    conv.agents = agents;
    store.saveMeta(conv);
    schedule(conv, { text: '@Bob please install' });
    const alice = hold('Alice');
    await orchestrator.send(conv.id, '@Alice question'); // only Alice answers this run
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + HOUR;
    await scheduler().tick();
    alice();
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(said(conv)).toEqual(['@Alice question', '@Alice', '@Bob please install', '@Bob']);
    expect(textOf(agentMessages(conv).at(-1)!)).toBe('Bob not asked');
  });

  it('holds the message back while the team waits for an answer, or has no confirmed team', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'which one?');
    await finish(conv.id);
    expect(conv.pause).toBeDefined();

    now = T0 + HOUR;
    await scheduler().tick();
    expect(said(conv)).toEqual(['which one?', '@Alice', 'note']); // not taken for the answer
    expect(conv.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the team is waiting for your answer' });
    expect(conv.pause).toBeDefined();

    const auto = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true });
    auto.agents = [];
    store.saveMeta(auto);
    schedule(auto);
    await scheduler().tick();
    expect(said(auto)).toEqual(['note']);
    expect(auto.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the team is not confirmed yet' });
  });

  it('skips a time missed while it was not running, or sends it once late, as the schedule says', async () => {
    const skips = conversation({ mode: 'roundtable', permission: 'read-only' });
    const nine = Date.UTC(2026, 0, 5, 9, 0);
    schedule(skips, { repeat: { kind: 'daily', time: '09:00' }, nextRunAt: nine });
    const sends = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(sends, { repeat: { kind: 'once', at: nine }, nextRunAt: nine, missed: 'run' });

    // Three days later (the server was off), past the grace period.
    now = nine + 3 * 24 * HOUR + 2 * HOUR;
    expect(now - nine).toBeGreaterThan(MISSED_AFTER_MS);
    await scheduler().tick();
    await finish(sends.id);

    expect(said(skips)).toEqual(['note']);
    expect(notes(skips)[0]).toMatch(/was not sent: Harness Relay was not running then/);
    expect(skips.schedule).toMatchObject({ lastResult: 'missed', lastRunAt: nine, nextRunAt: nine + 4 * 24 * HOUR, enabled: true });

    expect(said(sends)).toEqual(['scheduled check', '@Alice', '@Bob']);
    // A one-time schedule is done: it stays, switched off.
    expect(sends.schedule).toMatchObject({ lastResult: 'sent', enabled: false });
    expect(sends.schedule!.nextRunAt).toBeUndefined();
    expect(store.dueSchedules(now + 365 * 24 * HOUR)).toEqual([skips.id]); // the daily one only
  });

  it('sends a time only a little late as usual, and says why one could not start', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'edit', cwd: join(project, 'gone') });
    schedule(conv);
    now = T0 + HOUR + MISSED_AFTER_MS - 1000;
    await scheduler().tick();
    expect(conv.schedule).toMatchObject({ lastResult: 'failed', nextRunAt: T0 + 2 * HOUR });
    expect(conv.schedule!.lastError).toBeTruthy();
    expect(notes(conv).at(-1)).toMatch(/could not be sent/);
  });

  it('sends nothing for a deleted conversation', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    await orchestrator.deleteConversation(conv.id);
    now = T0 + HOUR;
    expect(store.dueSchedules(now)).toEqual([]);
    await expect(orchestrator.sendScheduled(conv.id)).rejects.toThrow();
    await scheduler().tick();
    expect(calls).toEqual([]);
  });
});
