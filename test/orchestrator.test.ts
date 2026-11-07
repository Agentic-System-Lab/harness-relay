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
const { PLANNER_BRIEFING } = await import('../src/server/planner');
const { attachmentPath, attachmentsDir, safeFileName } = await import('../src/server/attachments');

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
}[] = [];
/** What the fake lead agent replies when asked to design a team (auto team). */
let leadReply = '';

// A fake CLI: writes `<name>.txt` and `shared.txt` in its cwd, then replies.
beforeAll(() => {
  runners.claude = {
    provider: 'claude',
    async run(o) {
      if (o.systemPrompt === PLANNER_BRIEFING) {
        calls.push({ name: 'lead', sessionId: o.sessionId, prompt: o.prompt });
        o.onEvent({ type: 'text', text: leadReply });
        o.onEvent({ type: 'text_end' });
        return { costUsd: 0.01 };
      }
      const name = /You are @(\w+)/.exec(o.systemPrompt)![1]!;
      calls.push({ name, sessionId: o.sessionId, prompt: o.prompt, images: o.images, attachmentsDir: o.attachmentsDir });
      writeFileSync(join(o.cwd, 'shared.txt'), `written by ${name}\n`);
      writeFileSync(join(o.cwd, `${name}.txt`), `${name}\n`);
      await gate;
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
  orchestrator = new Orchestrator(store, new Hub(), new SettingsStore(db), {
    context: async () => ({ available: ['claude'], catalog: [], presets: store.listPresets() }),
  });
  leadReply = '';
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

  it('lets the lead agent design the team, then that team answers', async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = 'Here is my choice:\n```json\n' + customTeam + '\n```';
    await orchestrator.send(conv.id, 'What is a monad?');
    await finish(conv.id);

    expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice', 'Bob']);
    expect(calls[0]!.prompt).toContain('What is a monad?');
    const [user, plan, ...replies] = conv.messages;
    expect(user!.author.kind).toBe('user');
    expect(plan!.plan).toMatchObject({ status: 'ready', source: 'custom', name: 'Research pair', reason: 'Two views beat one.' });
    expect(plan!.meta?.costUsd).toBe(0.01);
    expect(replies.map((m) => m.agentName)).toEqual(['Alice', 'Bob']);
    // Grok is not available here, so Bob runs on the lead's CLI.
    expect(conv.agents.map((a) => [a.name, a.provider])).toEqual([
      ['Alice', 'claude'],
      ['Bob', 'claude'],
    ]);
    expect(conv.settings.autoTeam).toBeFalsy();
    // The plan was never shown to the team as a chat message.
    expect(calls[1]!.prompt).not.toContain('Research pair');

    const preset = orchestrator.savePlanAsPreset(conv.id, plan!.id, 'My research pair');
    expect(store.listPresets().find((p) => p.id === preset.id)).toMatchObject({ name: 'My research pair' });
    expect(plan!.plan!.savedPresetId).toBe(preset.id);

    const reloaded = new Store(db).get(conv.id)!;
    expect(reloaded.messages[1]!.plan).toMatchObject({ source: 'custom', savedPresetId: preset.id });
    expect(reloaded.settings.autoTeam).toBeUndefined();
  });

  it('uses an existing template when the lead picks one, and the default one when its reply is unusable', async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
    await orchestrator.send(conv.id, 'Sort a list in three languages');
    await finish(conv.id);
    expect(conv.messages[1]!.plan).toMatchObject({ source: 'template', presetId: 'builtin-parallel' });
    expect(conv.settings.mode).toBe('parallel');
    expect(() => orchestrator.savePlanAsPreset(conv.id, conv.messages[1]!.id)).toThrow(/自行設計/);

    const other = autoConversation();
    other.agents = [];
    leadReply = 'I would pick a nice team.';
    await orchestrator.send(other.id, 'Hello');
    await finish(other.id);
    expect(other.messages[1]!.plan).toMatchObject({ source: 'fallback', presetId: 'builtin-general' });
    expect(other.agents.map((a) => a.name)).toEqual(['Analyst', 'Critic', 'Synthesizer']);
  });

  it('designs the team again when the first question is edited', async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = customTeam;
    await orchestrator.send(conv.id, 'First version');
    await finish(conv.id);
    calls = [];
    await orchestrator.resend(conv.id, conv.messages[0]!.id, 'Second version');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice', 'Bob']);
    expect(calls[0]!.prompt).toContain('Second version');
    expect(conv.messages.filter((m) => m.plan)).toHaveLength(1);
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
