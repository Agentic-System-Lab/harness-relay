import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, Conversation, ConversationSchedule, ConversationSettings } from '../src/shared/types';
import { slow } from './timeouts';

/** When `gate` is set, copying a branch's attached files waits for it. */
const copying = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }));
vi.mock('../src/server/attachments', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/server/attachments')>();
  return {
    ...real,
    copyAttachments: async (...args: Parameters<typeof real.copyAttachments>) => {
      if (copying.gate) await copying.gate;
      return real.copyAttachments(...args);
    },
  };
});

// Worktrees live under RELAY_DATA_DIR, which is read when the server modules load.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-orch-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator, branchAfterCut, branchOrigin, branchPause } = await import('../src/server/orchestrator');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { AgentRunError, runners, stateKeys } = await import('../src/server/agents');
const { removeTree } = await import('../src/server/fsRemove');
const { stateFolder } = await import('../src/server/agents/open');
const { PLANNER_BRIEFING, REVISER_BRIEFING } = await import('../src/server/planner');
const { GROUPER_BRIEFING } = await import('../src/server/grouping');
const { withLang } = await import('../src/server/i18n');
const { attachmentPath, attachmentsDir, safeFileName } = await import('../src/server/attachments');
const { mediaRoots, resolveMedia } = await import('../src/server/media');
const { worktreeDir } = await import('../src/server/workspace');
const { BUSY_RETRY_MS, MISSED_AFTER_MS, Scheduler, scheduleTime } = await import('../src/server/scheduler');

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
  cwd?: string;
  /** The other working directories it was given. */
  addDirs?: string[];
  systemPrompt?: string;
  images?: { path: string; mimeType: string }[];
  attachmentsDir?: string;
  nativeOff?: readonly string[];
  nativeItems?: Record<string, string[]>;
  sandboxTerminal?: boolean;
  stateKey?: string;
  freshState?: boolean;
  permission?: string;
  /** The CLI's home it was started with (its account's). */
  home?: string;
  model?: string;
  effort?: string;
}[] = [];
let settings: InstanceType<typeof SettingsStore>;
/** What the fake lead agent replies when asked to design a team (auto team). */
let leadReply = '';
/** When set, the fake lead agent waits for it before replying. */
let leadGate: Promise<void> | undefined;
/** What the fake lead agent replies when asked to change a team (team drawer). */
let reviseReply = '';
/** When set, the fake lead agent waits for it before changing the team (or until it is stopped). */
let reviseGate: Promise<void> | undefined;
/** When set, the next fake lead agent run, once stopped, ends only when it resolves (a CLI slow to exit). */
let reviseLinger: Promise<void> | undefined;
/** When set, the fake lead agent's CLI fails with this message when asked to change a team. */
let reviseFail: string | undefined;
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
/** The way to ask the user that a fake CLI run whose prompt says "keep asking" had (kept past its turn). */
let keptAsk: ((req: { kind: 'fetch'; detail: string }) => Promise<unknown>) | undefined;
/** Makes an agent's fake CLI run fail (after it wrote its files), e.g. to simulate a rate limit. */
let fail: ((name: string, sessionId?: string) => Error | undefined) | undefined;

// A fake CLI: writes `<name>.txt` and `shared.txt` in its cwd, then replies.
beforeAll(() => {
  runners.claude = {
    provider: 'claude',
    async run(o) {
      if (o.systemPrompt === GROUPER_BRIEFING) {
        calls.push({ name: 'sorter', prompt: o.prompt, nativeOff: o.nativeOff, nativeItems: o.nativeItems, sandboxTerminal: o.sandboxTerminal, stateKey: o.stateKey, model: o.model, effort: o.effort });
        if (sorterGate && !o.signal?.aborted) {
          await Promise.race([sorterGate, new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }))]);
        }
        if (o.signal?.aborted) throw new AgentRunError('stopped', true);
        o.onEvent({ type: 'text', text: sorterReply });
        o.onEvent({ type: 'text_end' });
        return { sessionId: 'sorter-session' };
      }
      if (o.systemPrompt === REVISER_BRIEFING) {
        calls.push({ name: 'reviser', prompt: o.prompt, cwd: o.cwd, stateKey: o.stateKey, model: o.model, effort: o.effort, nativeOff: o.nativeOff, home: o.env?.CLAUDE_CONFIG_DIR });
        // Only the run that starts while it is set lingers.
        const linger = reviseLinger;
        reviseLinger = undefined;
        if (reviseGate && !o.signal?.aborted) {
          await Promise.race([reviseGate, new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }))]);
        }
        // Like a CLI that takes a while to end once it is stopped.
        if (o.signal?.aborted && linger) await linger;
        if (o.signal?.aborted) throw new AgentRunError('stopped', true);
        if (reviseFail) throw new Error(reviseFail);
        o.onEvent({ type: 'text', text: reviseReply });
        o.onEvent({ type: 'text_end' });
        return { costUsd: 0.02, sessionId: 'reviser-session' };
      }
      if (o.systemPrompt === PLANNER_BRIEFING) {
        calls.push({
          name: 'lead',
          sessionId: o.sessionId,
          prompt: o.prompt,
          nativeOff: o.nativeOff,
          nativeItems: o.nativeItems,
          sandboxTerminal: o.sandboxTerminal,
          stateKey: o.stateKey,
          home: o.env?.CLAUDE_CONFIG_DIR,
          model: o.model,
          effort: o.effort,
        });
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
        cwd: o.cwd,
        ...(o.addDirs ? { addDirs: o.addDirs } : {}),
        systemPrompt: o.systemPrompt,
        images: o.images,
        attachmentsDir: o.attachmentsDir,
        nativeOff: o.nativeOff,
        nativeItems: o.nativeItems,
        sandboxTerminal: o.sandboxTerminal,
        stateKey: o.stateKey,
        freshState: o.freshState,
        permission: o.permission,
        home: o.env?.CLAUDE_CONFIG_DIR,
        model: o.model,
        effort: o.effort,
      });
      writeFileSync(join(o.cwd, 'shared.txt'), `written by ${name}\n`);
      writeFileSync(join(o.cwd, `${name}.txt`), `${name}\n`);
      // In each other working directory too.
      for (const dir of o.addDirs ?? []) writeFileSync(join(dir, `${name}.txt`), `${name} was here\n`);
      during?.(name, o.cwd);
      // Like a real CLI, a run ends when it is stopped.
      if (!o.signal?.aborted) {
        await Promise.race([gates[name] ?? gate, new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }))]);
      }
      if (o.signal?.aborted) throw new AgentRunError('stopped', true);
      const failure = fail?.(name, o.sessionId);
      if (failure) throw failure;
      if (o.prompt.includes('keep asking')) keptAsk = o.requestApproval;
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
      if (o.prompt.includes('search the web')) {
        // Like a server-side web search: what it searched for only comes with the result.
        o.onEvent({ type: 'tool_start', id: `ws-${name}`, name: 'Web search' });
        o.onEvent({ type: 'tool_end', id: `ws-${name}`, ok: true, detail: `${name}'s query` });
        // Most calls say what they are about from the start.
        o.onEvent({ type: 'tool_start', id: `sh-${name}`, name: 'Shell', detail: 'npm test' });
        o.onEvent({ type: 'tool_end', id: `sh-${name}`, ok: true, output: 'ok' });
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

// As the server does at its next start: a folder a run locked (`chmod 000`) stays set aside until then, and
// rmSync cannot remove it as it is (Node 24's, not even an empty one).
afterAll(() => {
  removeTree(root, { restore: true });
  expect(existsSync(root)).toBe(false);
});

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
  reviseReply = '';
  reviseGate = undefined;
  reviseLinger = undefined;
  reviseFail = undefined;
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

describe("Harness Relay's own folder", () => {
  it('refuses an edit-mode turn there, also for a conversation saved before the check', async () => {
    const { RELAY_ROOT } = await import('../src/server/protect');
    orchestrator = new Orchestrator(store, new Hub(), settings);
    const conv = conversation({ mode: 'roundtable', permission: 'edit', cwd: RELAY_ROOT });
    await withLang('en', () => orchestrator.send(conv.id, 'go'));
    await finish(conv.id);
    const replies = agentMessages(store.get(conv.id)!);
    expect(replies.length).toBeGreaterThan(0);
    for (const m of replies) {
      expect(m.status).toBe('error');
      expect(m.error).toMatch(/holds Harness Relay itself/);
    }
  });
});

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

describe('parallel mode, replies in order', () => {
  it("adds every member's reply in the team's order, whichever CLI each runs on", async () => {
    const saved = runners.cursor;
    runners.cursor = { ...runners.claude, provider: 'cursor' };
    try {
      const conv = conversation({ mode: 'parallel', permission: 'read-only' });
      // Claude Code works out whether it runs on an endpoint first; Cursor does not.
      conv.agents = [
        { id: 'a', name: 'Alice', provider: 'claude', role: '' },
        { id: 'b', name: 'Bob', provider: 'cursor', role: '' },
      ];
      store.saveMeta(conv);
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      expect(agentMessages(conv).map((m) => m.agentName)).toEqual(['Alice', 'Bob']);
    } finally {
      runners.cursor = saved;
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
      const wt = conv.worktrees[a.id]![0]!;
      expect(readFileSync(join(wt.path, 'shared.txt'), 'utf8')).toBe(`written by ${a.name}\n`);
    }
    for (const m of agentMessages(conv)) {
      expect(m.status).toBe('done');
      expect(m.changes?.[0]?.isolated).toBe(true);
      expect(m.changes?.[0]?.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual([
        `A ${m.agentName}.txt`,
        'M shared.txt',
      ]);
    }

    // Apply Bob's result; Alice's is now out of date.
    await orchestrator.applyAgentWork(conv.id, 'b');
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    expect(readFileSync(join(project, 'Bob.txt'), 'utf8')).toBe('Bob\n');
    expect(Object.values(conv.worktrees).flat().every((w) => w.needsReset)).toBe(true);
    await expect(orchestrator.applyAgentWork(conv.id, 'a')).rejects.toThrow(/過期/);

    // The next parallel run starts both agents from the new state of the directory.
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(Object.values(conv.worktrees).flat().some((w) => w.needsReset)).toBe(false);
    const aliceWt = conv.worktrees.a![0]!.path;
    expect(readFileSync(join(aliceWt, 'Bob.txt'), 'utf8')).toBe('Bob\n');

    await orchestrator.cleanupWorktrees(conv);
  });
});

describe('what a CLI loads by itself', () => {
  it("leaves out of every agent's run what the user turned off for that CLI", async () => {
    settings.updateAccount('claude', '', { nativeOff: ['mcp', 'memory'], nativeItems: { skills: ['commit'] } });
    const conv = conversation({ mode: 'roundtable' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const turns = calls.filter((c) => c.name === 'Alice' || c.name === 'Bob');
    expect(turns).toHaveLength(2);
    expect(turns.every((c) => c.nativeOff?.join() === 'mcp,memory')).toBe(true);
    expect(turns.every((c) => c.nativeItems?.skills?.join() === 'commit')).toBe(true);
  });

  it("leaves it out of the lead agent's and the group sorter's runs too", async () => {
    settings.updateAccount('claude', '', { nativeOff: ['skills', 'instructions'], nativeItems: { tools: ['WebSearch'] } });
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

  it("gives every run the user's switch for a terminal in the sandbox, as Settings has it for the run's CLI", async () => {
    const asked: string[] = [];
    const spy = vi.spyOn(settings, 'sandboxTerminal').mockImplementation((p) => (asked.push(p), true));
    try {
      const team = conversation({ mode: 'roundtable' });
      await orchestrator.send(team.id, 'go');
      await finish(team.id);
      store.createGroup({ id: 'g2', name: 'Notes' });
      const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
      conv.agents = [];
      leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
      await orchestrator.send(conv.id, 'Write the notes');
      await finish(conv.id);
      await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(false));
    } finally {
      spy.mockRestore();
    }
    const runs = calls.filter((c) => c.name !== 'reviser');
    expect(runs.map((c) => c.name)).toEqual(expect.arrayContaining(['Alice', 'Bob', 'lead', 'sorter']));
    expect(runs.every((c) => c.sandboxTerminal === true)).toBe(true);
    expect(new Set(asked)).toEqual(new Set(['claude']));
    expect(settings.sandboxTerminal('claude')).toBe(false);
  });
});

describe("each member's own state, and a session that ran with less permission", () => {
  const alice = () => calls.filter((c) => c.name === 'Alice');

  it('gives each member a state key of its own, the same at every turn, so its session resumes', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    for (const text of ['one', 'two']) {
      await orchestrator.send(conv.id, text);
      await finish(conv.id);
    }
    expect(alice().map((c) => c.stateKey)).toEqual([stateKeys.member(conv.id, 'a'), stateKeys.member(conv.id, 'a')]);
    expect(calls.find((c) => c.name === 'Bob')!.stateKey).toBe(stateKeys.member(conv.id, 'b'));
    expect(alice()[1]!.sessionId).toBe('session-Alice');
    expect(alice().map((c) => c.freshState)).toEqual([false, false]);
    // Another conversation's members have keys of their own.
    const other = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(other.id, 'one');
    await finish(other.id);
    expect(alice()[2]!.stateKey).toBe(stateKeys.member(other.id, 'a'));
    expect(alice()[2]!.stateKey).not.toBe(alice()[0]!.stateKey);
  });

  /** Runs `body` with the fake CLI standing in for OpenCode and Goose too (each with a home of its own). */
  const withOpenAgents = async (body: () => Promise<void>) => {
    const saved = { opencode: runners.opencode, goose: runners.goose };
    runners.opencode = { ...runners.claude, provider: 'opencode' };
    runners.goose = { ...runners.claude, provider: 'goose' };
    orchestrator = new Orchestrator(store, new Hub(), settings, {
      context: async () => ({ available: ['claude', 'opencode', 'goose'], catalog: [], presets: store.listPresets() }),
      defaultModel: async () => 'openai/gpt-5.4-nano',
    });
    try {
      await body();
    } finally {
      Object.assign(runners, saved);
    }
  };
  /** A file in member `agentId`'s state folder in an open agent's home, as its CLI would leave there. */
  const leaveInState = (provider: 'opencode' | 'goose', convId: string, agentId = 'a') => {
    const dir = stateFolder(settings.openAgentHome(provider), stateKeys.member(convId, agentId));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session.db');
    writeFileSync(file, 'written by the run before');
    return file;
  };

  it('starts a fresh session with the whole history after the permission went up, and resumes after it went down', async () => {
    await withOpenAgents(async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      conv.agents = [{ ...agents[0]!, provider: 'opencode' }];
      const turn = async (permission: 'read-only' | 'edit' | 'full', text: string) => {
        conv.settings.permission = permission;
        store.saveMeta(conv);
        await orchestrator.send(conv.id, text);
        await finish(conv.id);
        return alice().at(-1)!;
      };
      const first = await turn('read-only', 'one');
      expect(first).toMatchObject({ permission: 'read-only', freshState: false, sessionId: undefined });
      const left = leaveInState('opencode', conv.id);
      // read-only → edit: not resumed, the state folder emptied, the whole chat in the prompt.
      const raised = await turn('edit', 'two');
      expect(raised).toMatchObject({ permission: 'edit', freshState: true, sessionId: undefined });
      expect(existsSync(left)).toBe(false);
      expect(raised.prompt).toContain('Here is the group chat so far:');
      expect(raised.prompt).toContain('one');
      // The permission is Harness Relay's own record, in its database, and the folder no longer needs emptying.
      expect(new Store(db).get(conv.id)!.agentState.a).toMatchObject({ permission: 'edit', byCli: { opencode: { permission: 'edit' } } });
      expect(new Store(db).get(conv.id)!.agentState.a!.byCli!.opencode!.mustEmpty).toBeUndefined();
      // The same permission again: resumed, and what the edit run left is kept.
      const kept = leaveInState('opencode', conv.id);
      expect(await turn('edit', 'three')).toMatchObject({ freshState: false, sessionId: 'session-Alice' });
      expect(existsSync(kept)).toBe(true);
      // edit → read-only: resumed (what a run with more permission wrote may be read with less).
      expect(await turn('read-only', 'four')).toMatchObject({ freshState: false, sessionId: 'session-Alice' });
      // read-only → full: fresh again (its last run was read-only).
      expect(await turn('full', 'five')).toMatchObject({ freshState: true, sessionId: undefined });
      expect(existsSync(kept)).toBe(false);
    });
  }, 30_000);

  it('starts a fresh Claude Code session when the permission went up (it keeps no state folder here)', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.agents = [agents[0]!];
    await orchestrator.send(conv.id, 'one');
    await finish(conv.id);
    conv.settings.permission = 'edit';
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'two');
    await finish(conv.id);
    expect(alice().at(-1)).toMatchObject({ permission: 'edit', sessionId: undefined, freshState: false });
    expect(alice().at(-1)!.prompt).toContain('Here is the group chat so far:');
  });

  it('does not run an open agent whose state folder could not be emptied, and empties it at the next turn', async () => {
    await withOpenAgents(async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      conv.agents = [{ ...agents[0]!, provider: 'opencode' }];
      await orchestrator.send(conv.id, 'one');
      await finish(conv.id);
      const left = leaveInState('opencode', conv.id);
      conv.settings.permission = 'edit';
      store.saveMeta(conv);
      const folders = dirname(dirname(left));
      chmodSync(folders, 0o500); // the folder cannot be set aside
      try {
        await withLang('en', () => orchestrator.send(conv.id, 'two'));
        await finish(conv.id);
      } finally {
        chmodSync(folders, 0o700);
      }
      expect(existsSync(left)).toBe(true);
      // What a run may do in its own folder (lock a folder in it) does not keep it from being emptied.
      mkdirSync(join(dirname(left), 'locked'));
      chmodSync(join(dirname(left), 'locked'), 0o000);
      expect(alice()).toHaveLength(1);
      expect(agentMessages(conv).at(-1)).toMatchObject({ status: 'error' });
      expect(agentMessages(conv).at(-1)!.error).toMatch(/must be emptied before it runs, but it could not be/);
      expect(new Store(db).get(conv.id)!.agentState.a!.byCli!.opencode).toEqual({ permission: 'edit', home: settings.openAgentHome('opencode'), mustEmpty: true });
      // The permission did not go up from the last run's (edit), but the folder still has to be emptied.
      await orchestrator.send(conv.id, 'three');
      await finish(conv.id);
      expect(alice().at(-1)).toMatchObject({ permission: 'edit', freshState: true, sessionId: undefined });
      expect(existsSync(left)).toBe(false);
      expect(new Store(db).get(conv.id)!.agentState.a!.byCli!.opencode).toEqual({ permission: 'edit', home: settings.openAgentHome('opencode') });
    });
  }, 30_000);

  it("keeps each CLI's own permission: back on a CLI whose last run was read-only, its folder is emptied", async () => {
    await withOpenAgents(async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      conv.agents = [{ ...agents[0]!, provider: 'opencode' }];
      const turn = async (provider: 'opencode' | 'goose', permission: 'read-only' | 'edit', text: string) => {
        conv.agents = [{ ...agents[0]!, provider }];
        conv.settings.permission = permission;
        store.saveMeta(conv);
        await orchestrator.send(conv.id, text);
        await finish(conv.id);
        return alice().at(-1)!;
      };
      await turn('opencode', 'read-only', 'one');
      const left = leaveInState('opencode', conv.id);
      // Goose has never run for her: its folder is new, nothing to empty.
      expect(await turn('goose', 'edit', 'two')).toMatchObject({ freshState: true, sessionId: undefined });
      expect(existsSync(left)).toBe(true);
      // Back on OpenCode at edit: its own latest run was read-only.
      expect(await turn('opencode', 'edit', 'three')).toMatchObject({ freshState: true, sessionId: undefined });
      expect(existsSync(left)).toBe(false);
      expect(new Store(db).get(conv.id)!.agentState.a!.byCli).toEqual({
        opencode: { permission: 'edit', home: settings.openAgentHome('opencode') },
        goose: { permission: 'edit', home: settings.openAgentHome('goose') },
      });
    });
  }, 30_000);

  it("starts afresh, its folder emptied, in an open agent's home other than its latest run's, also back in an earlier one", async () => {
    await withOpenAgents(async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      conv.agents = [{ ...agents[0]!, provider: 'opencode' }];
      const turn = async (permission: 'read-only' | 'edit', text: string) => {
        conv.settings.permission = permission;
        store.saveMeta(conv);
        await orchestrator.send(conv.id, text);
        await finish(conv.id);
        return alice().at(-1)!;
      };
      const homeA = join(root, `homes-a-${n}`);
      const homeB = join(root, `homes-b-${n}`);
      settings.setAgentHome(homeA);
      // Read-only in A: what it leaves there was written with less permission than edit.
      await turn('read-only', 'one');
      const leftInA = leaveInState('opencode', conv.id);
      // Edit in B: a home of its own (the session is in A), fresh.
      settings.setAgentHome(homeB);
      expect(await turn('edit', 'two')).toMatchObject({ freshState: true, sessionId: undefined });
      expect(await turn('edit', 'three')).toMatchObject({ freshState: false, sessionId: 'session-Alice' });
      // Back in A at edit, the same permission as the latest run's: A's folder, written by the read-only
      // run, is emptied before the run, and the session in B is not resumed there.
      settings.setAgentHome(homeA);
      expect(await turn('edit', 'four')).toMatchObject({ freshState: true, sessionId: undefined });
      expect(existsSync(leftInA)).toBe(false);
      expect(new Store(db).get(conv.id)!.agentState.a!.byCli!.opencode).toEqual({ permission: 'edit', home: join(homeA, 'opencode') });
      // Both homes are remembered: deleting the conversation removes its state in each.
      expect(settings.openAgentHomes('opencode')).toEqual(expect.arrayContaining([join(homeA, 'opencode'), join(homeB, 'opencode')]));
      const inB = stateFolder(join(homeB, 'opencode'), stateKeys.member(conv.id, 'a'));
      mkdirSync(inB, { recursive: true });
      await orchestrator.deleteConversation(conv.id);
      expect(existsSync(inB)).toBe(false);
      settings.setAgentHome('');
    });
  }, 30_000);

  it("removes an open agent member's state folder with its conversation", async () => {
    await withOpenAgents(async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      conv.agents = [{ ...agents[0]!, provider: 'opencode' }];
      await orchestrator.send(conv.id, 'one');
      await finish(conv.id);
      const left = leaveInState('opencode', conv.id);
      const other = conversation({ mode: 'roundtable', permission: 'read-only' });
      const kept = leaveInState('opencode', other.id);
      await orchestrator.deleteConversation(conv.id);
      expect(existsSync(dirname(left))).toBe(false);
      expect(existsSync(kept)).toBe(true);
    });
  }, 30_000);

  it("takes a session whose permission was never recorded as read-only's", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    // A session saved before Harness Relay recorded permissions.
    conv.agentState.a = { provider: 'claude', sessionId: 'old-session', seen: [] };
    store.saveAgentState(conv.id, 'a', conv.agentState.a);
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(alice()[0]).toMatchObject({ sessionId: undefined, freshState: false });
  }, 30_000);

  it('takes a session recorded with a permission but not yet per CLI as that permission, on the same CLI', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    conv.agents = [agents[0]!];
    conv.agentState.a = { provider: 'claude', sessionId: 'old-session', permission: 'edit', seen: [] };
    store.saveAgentState(conv.id, 'a', conv.agentState.a);
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(alice()[0]).toMatchObject({ sessionId: 'old-session' });
  }, 30_000);

  it("gives the lead agent's and the group sorter's runs keys of their own", async () => {
    store.createGroup({ id: 'g1', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [];
    leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
    await orchestrator.send(conv.id, 'Write the README');
    await finish(conv.id);
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(false));
    expect(calls.find((c) => c.name === 'lead')!.stateKey).toBe(stateKeys.lead(conv.id));
    expect(calls.find((c) => c.name === 'sorter')!.stateKey).toBe(stateKeys.sort(conv.id));
    const keys = new Set([stateKeys.lead(conv.id), stateKeys.revise(conv.id), stateKeys.sort(conv.id), stateKeys.member(conv.id, 'a')]);
    expect(keys.size).toBe(4);
  });

  it("runs an open agent with no model on the default its model picker shows; the other CLIs on their own", async () => {
    const saved = runners.opencode;
    runners.opencode = { ...runners.claude, provider: 'opencode' };
    const asked: string[] = [];
    orchestrator = new Orchestrator(store, new Hub(), settings, {
      context: async () => ({ available: ['claude', 'opencode'], catalog: [], presets: store.listPresets() }),
      defaultModel: async (p) => {
        asked.push(p);
        return 'openai/gpt-5.4-nano';
      },
    });
    try {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      conv.agents = [
        { id: 'o', name: 'Otto', provider: 'opencode', role: '' },
        { id: 'c', name: 'Cleo', provider: 'claude', role: '' },
      ];
      const turn = async () => {
        await orchestrator.send(conv.id, 'go');
        await finish(conv.id);
        return { otto: calls.filter((c) => c.name === 'Otto').at(-1)!.model, cleo: calls.filter((c) => c.name === 'Cleo').at(-1)!.model };
      };
      expect(await turn()).toEqual({ otto: 'openai/gpt-5.4-nano', cleo: undefined });
      expect(asked).toEqual(['opencode']);
      // Settings' default comes first, and a member's own model before that.
      settings.updateAccount('opencode', '', { defaultModel: 'xai/grok-4.3' });
      expect((await turn()).otto).toBe('xai/grok-4.3');
      conv.agents[0]!.model = 'anthropic/claude-haiku-5-5';
      expect((await turn()).otto).toBe('anthropic/claude-haiku-5-5');
    } finally {
      runners.opencode = saved;
    }
  });
});

describe('tool calls', () => {
  it('shows what a call was about when the CLI only says so once it is done', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'search the web');
    await finish(conv.id);

    const [alice] = agentMessages(conv);
    expect(alice!.parts.filter((p) => p.type === 'tool')).toMatchObject([
      { name: 'Web search', detail: "Alice's query", status: 'done' },
      // A tool_end without a detail keeps the one from tool_start.
      { name: 'Shell', detail: 'npm test', status: 'done', output: 'ok' },
    ]);
  });
});

describe('roundtable mode with edit permission', () => {
  it('lets agents work in the real directory and records what each one changed', async () => {
    const conv = conversation({ mode: 'roundtable' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    const [alice, bob] = agentMessages(conv);
    expect(alice!.changes).toMatchObject([{ isolated: false }]);
    expect(alice!.changes![0]!.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'shared.txt']);
    expect(bob!.changes![0]!.files.map((f) => f.path).sort()).toEqual(['Bob.txt', 'shared.txt']);
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

// Two repositories' git work in each test: more time than one's.
describe('several working directories', { timeout: slow(20_000) }, () => {
  /** A second working directory with a file of its own; the first is `project`. */
  function docsFolder(): string {
    const docs = join(root, `docs-${n}`);
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'guide.md'), 'guide\n');
    return docs;
  }

  it('gives every agent all of them, makes each a repository and records the changes in each', async () => {
    const docs = docsFolder();
    const conv = conversation({ mode: 'roundtable', extraCwds: [docs] });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    // Both became git repositories.
    const notes = conv.messages.filter((m) => m.author.kind === 'system').map(textOf);
    expect(notes.filter((t) => t.includes('git init'))).toHaveLength(2);
    expect(existsSync(join(docs, '.git'))).toBe(true);
    const turns = calls.filter((c) => c.name === 'Alice' || c.name === 'Bob');
    expect(turns.map((c) => [c.cwd, c.addDirs])).toEqual([
      [project, [docs]],
      [project, [docs]],
    ]);
    expect(turns[0]!.systemPrompt).toContain(`share these working directories, each with the same access: ${project}, ${docs}.`);

    const [alice] = agentMessages(conv);
    expect(alice!.changes!.map((c) => [c.root, c.isolated, c.files.map((f) => f.path).sort()])).toEqual([
      [project, false, ['Alice.txt', 'shared.txt']],
      [docs, false, ['Alice.txt']],
    ]);
    // One diff, each repository's paths under its folder's name.
    const diff = await orchestrator.messageDiff(conv.id, alice!.id);
    expect(diff).toContain(`+++ b/${basename(project)}/Alice.txt`);
    expect(diff).toContain(`+++ b/${basename(docs)}/Alice.txt`);
    // The second repository keeps the turns' snapshots too, until the conversation goes.
    const refs = () => execFileSync('git', ['-C', docs, 'for-each-ref', `refs/harness-relay/${conv.id}/`], { encoding: 'utf8' });
    expect(refs()).not.toBe('');
    await orchestrator.cleanupWorktrees(conv);
    expect(refs()).toBe('');
  });

  it('makes one repository for a folder and one inside it, whichever comes first', async () => {
    for (const mode of ['roundtable', 'parallel'] as const) {
      const outer = join(root, `outer-${mode}-${n}`);
      const inner = join(outer, 'docs');
      mkdirSync(inner, { recursive: true });
      const conv = conversation({ mode, cwd: inner, extraCwds: [outer] });
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      // Only the outer one was made a repository: git could not snapshot it around an empty inner one.
      expect(existsSync(join(inner, '.git'))).toBe(false);
      const alice = agentMessages(conv).find((m) => m.agentName === 'Alice')!;
      expect(alice.status).toBe('done');
      expect(alice.changes!.map((c) => c.root)).toEqual([outer]);
      expect(alice.changes![0]!.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'docs/Alice.txt', 'docs/shared.txt']);
      if (mode === 'parallel') {
        // One worktree, in which the agent starts in the inner folder and also has the outer one.
        const [wt] = conv.worktrees.a!;
        expect(conv.worktrees.a).toHaveLength(1);
        expect(calls.filter((c) => c.name === 'Alice').at(-1)).toMatchObject({ cwd: join(wt!.path, 'docs'), addDirs: [wt!.path] });
      }
      await orchestrator.cleanupWorktrees(conv);
    }
  });

  it('takes the lock on all of them for an action allowed in a read-only run, and declines it while another conversation writes in one', async () => {
    const docs = docsFolder();
    const pendingIn = (conv: Conversation) =>
      conv.messages.flatMap((m) => m.parts).find((p) => p.type === 'approval' && p.status === 'pending') as { id: string } | undefined;
    const writer = conversation({ mode: 'roundtable', cwd: docs });
    writer.agents = [agents[0]!];
    await orchestrator.send(writer.id, 'please install'); // waits for its approval, holding the lock on docs
    await vi.waitFor(() => expect(pendingIn(writer)).toBeDefined());
    const reader = conversation({ mode: 'roundtable', permission: 'read-only', extraCwds: [docs] });
    reader.agents = [agents[0]!];
    await orchestrator.send(reader.id, 'please install');
    await vi.waitFor(() => expect(pendingIn(reader)).toBeDefined());
    orchestrator.answerApproval(reader.id, pendingIn(reader)!.id, { allow: true });
    await finish(reader.id);
    expect(agentMessages(reader)[0]!.parts.find((p) => p.type === 'approval')).toMatchObject({ status: 'denied' });
    orchestrator.answerApproval(writer.id, pendingIn(writer)!.id, { allow: true });
    await finish(writer.id);
  });

  it("tells a schedule that another conversation writes in one of them, before setting up its run", async () => {
    const docs = docsFolder();
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const writer = conversation({ mode: 'roundtable', cwd: docs });
    await orchestrator.send(writer.id, 'go');
    const conv = conversation({ mode: 'roundtable', extraCwds: [docs] });
    conv.schedule = {
      text: 'scheduled check',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: 0,
      nextRunAt: 1,
    };
    store.saveSchedule(conv);
    expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'busy', reason: expect.stringContaining(docs) });
    expect(conv.messages).toEqual([]);
    release();
    await finish(writer.id);
  });

  it("records the others' changes when one repository cannot be snapshotted", async () => {
    const docs = docsFolder();
    execFileSync('git', ['init', '-q'], { cwd: docs });
    // A repository inside it without a commit: git cannot snapshot docs around it.
    mkdirSync(join(docs, 'sub'));
    execFileSync('git', ['init', '-q'], { cwd: join(docs, 'sub') });
    const conv = conversation({ mode: 'roundtable', extraCwds: [docs] });
    conv.agents = [agents[0]!];
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const [alice] = agentMessages(conv);
    expect(alice!.status).toBe('done');
    expect(alice!.changes!.map((c) => c.root)).toEqual([project]);
    expect(alice!.changes![0]!.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'shared.txt']);
    await orchestrator.cleanupWorktrees(conv);
  });

  // chmod cannot keep a program from writing in a folder on Windows.
  it.skipIf(process.platform === 'win32')('marks the worktrees for a reset when a patch fails after another was applied', async () => {
    const docs = docsFolder();
    const conv = conversation({ mode: 'parallel', extraCwds: [docs] });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    // The check passes (nothing in the way), but nothing can be written in docs: its patch fails.
    chmodSync(docs, 0o555);
    try {
      await expect(orchestrator.applyAgentWork(conv.id, 'b')).rejects.toThrow();
    } finally {
      chmodSync(docs, 0o755);
    }
    // The first folder's patch was applied: the worktrees start again from the folders as they are.
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    expect(Object.values(conv.worktrees).flat().every((w) => w.needsReset)).toBe(true);
    await orchestrator.cleanupWorktrees(conv);
  });

  it("neither applies nor shows a worktree of a folder taken off the list, even once that folder is gone", async () => {
    const docs = docsFolder();
    const conv = conversation({ mode: 'parallel', extraCwds: [docs] });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    conv.settings = { ...conv.settings, extraCwds: undefined };
    rmSync(docs, { recursive: true, force: true });
    const diff = await orchestrator.agentDiff(conv.id, 'b');
    expect(diff).toContain('+++ b/Bob.txt');
    expect(diff).not.toContain(basename(docs));
    const files = await orchestrator.applyAgentWork(conv.id, 'b');
    expect(files.map((f) => f.path).sort()).toEqual(['Bob.txt', 'shared.txt']);
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    await orchestrator.cleanupWorktrees(conv);
  });

  it('keeps another conversation from writing in any of them meanwhile', async () => {
    const docs = docsFolder();
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const first = conversation({ mode: 'roundtable', extraCwds: [docs] });
    const second = conversation({ mode: 'relay', cwd: docs });
    await orchestrator.send(first.id, 'go');
    await expect(orchestrator.send(second.id, 'go')).rejects.toThrow(/正在修改/);
    release();
    await finish(first.id);
    await orchestrator.send(second.id, 'go');
    await finish(second.id);
  });

  it('in parallel mode, gives each agent a worktree of each, and applies all of a result or none of it', async () => {
    const docs = docsFolder();
    const conv = conversation({ mode: 'parallel', extraCwds: [docs] });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    for (const a of agents) {
      const wts = conv.worktrees[a.id]!;
      expect(wts.map((w) => w.root)).toEqual([project, docs]);
      const call = calls.find((c) => c.name === a.name)!;
      expect([call.cwd, call.addDirs]).toEqual([wts[0]!.path, [wts[1]!.path]]);
      expect(readFileSync(join(wts[1]!.path, `${a.name}.txt`), 'utf8')).toBe(`${a.name} was here\n`);
    }
    // The real folders are untouched.
    expect(existsSync(join(docs, 'Bob.txt'))).toBe(false);
    const bob = agentMessages(conv).find((m) => m.agentName === 'Bob')!;
    expect(bob.changes!.map((c) => [c.root, c.isolated])).toEqual([
      [project, true],
      [docs, true],
    ]);
    expect(await orchestrator.agentDiff(conv.id, 'b')).toContain(`+++ b/${basename(docs)}/Bob.txt`);

    // A file in the way in one of them: nothing is applied anywhere.
    writeFileSync(join(docs, 'Bob.txt'), 'in the way\n');
    await expect(orchestrator.applyAgentWork(conv.id, 'b')).rejects.toThrow();
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('original\n');
    rmSync(join(docs, 'Bob.txt'));

    const files = await orchestrator.applyAgentWork(conv.id, 'b');
    expect(files.map((f) => f.path).sort()).toEqual(['Bob.txt', 'Bob.txt', 'shared.txt']);
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    expect(readFileSync(join(docs, 'Bob.txt'), 'utf8')).toBe('Bob was here\n');
    expect(Object.values(conv.worktrees).flat().every((w) => w.needsReset)).toBe(true);
    await orchestrator.cleanupWorktrees(conv);
    expect(Object.values(conv.worktrees).flat().some((w) => existsSync(w.path))).toBe(false);
  });

  it('removes the worktrees of a folder the conversation no longer works in', async () => {
    const docs = docsFolder();
    const conv = conversation({ mode: 'parallel', extraCwds: [docs] });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const gone = conv.worktrees.a!.find((w) => w.root === docs)!;
    expect(existsSync(gone.path)).toBe(true);

    conv.settings = { ...conv.settings, extraCwds: undefined };
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(conv.worktrees.a!.map((w) => w.root)).toEqual([project]);
    expect(existsSync(gone.path)).toBe(false);
    expect(new Store(db).get(conv.id)!.worktrees.a!.map((w) => w.root)).toEqual([project]);
    await orchestrator.cleanupWorktrees(conv);
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

describe('accounts', () => {
  it("runs each member as its account, in that account's home, and starts a new session when its account changes", async () => {
    const home = join(root, `agents-${n}`);
    settings.setAgentHome(home);
    const work = settings.addAccount('claude', 'Work');
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.agents = [
      { id: 'a', name: 'Alice', provider: 'claude', role: '', account: work },
      { id: 'b', name: 'Bob', provider: 'claude', role: '' },
    ];
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    expect(calls.map((c) => [c.name, c.home, c.sessionId])).toEqual([
      ['Alice', join(home, `claude-${work}`), undefined],
      ['Bob', join(home, 'claude'), undefined],
    ]);
    expect(new Store(db).get(conv.id)!.agentState.a).toMatchObject({ account: work, sessionId: 'session-Alice' });

    // Alice moves to the default account: her session is in the other home, so she starts a new one.
    calls = [];
    conv.agents = [{ ...conv.agents[0]!, account: undefined }, conv.agents[1]!];
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'second');
    await finish(conv.id);
    expect(calls.map((c) => [c.name, c.home, c.sessionId])).toEqual([
      ['Alice', join(home, 'claude'), undefined],
      ['Bob', join(home, 'claude'), 'session-Bob'],
    ]);
    expect(calls[0]!.prompt).toContain('first'); // started fresh, so given the conversation again

    // Bob names an account that was removed since: it is the default account, so his session goes on.
    calls = [];
    const gone = settings.addAccount('claude', 'Gone');
    settings.removeAccount('claude', gone);
    conv.agents = [conv.agents[0]!, { ...conv.agents[1]!, account: gone }];
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'third');
    await finish(conv.id);
    expect(calls.map((c) => [c.name, c.home, c.sessionId])).toEqual([
      ['Alice', join(home, 'claude'), 'session-Alice'],
      ['Bob', join(home, 'claude'), 'session-Bob'],
    ]);
  });

  it("starts a new session when a member's model moves between the CLI's own service and an endpoint, or to another endpoint", async () => {
    settings.backends.putEndpoint('homelab', { name: 'Homelab', baseUrl: 'http://10.0.0.5:11434/v1', models: ['gemma4:e4b'] });
    settings.backends.putEndpoint('studio', { name: 'Studio', baseUrl: 'http://10.0.0.6:1234/v1', models: ['qwen3'] });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.agents = [{ id: 'a', name: 'Alice', provider: 'claude', role: '', model: 'homelab/gemma4:e4b' }];
    store.saveMeta(conv);
    const turn = async (model: string | undefined, text: string) => {
      calls = [];
      conv.agents = [{ ...conv.agents[0]!, model }];
      store.saveMeta(conv);
      await orchestrator.send(conv.id, text);
      await finish(conv.id);
      return calls[0]!;
    };
    expect(await turn('homelab/gemma4:e4b', 'one')).toMatchObject({ sessionId: undefined, model: 'homelab/gemma4:e4b' });
    expect(new Store(db).get(conv.id)!.agentState.a).toMatchObject({ backend: 'homelab', sessionId: 'session-Alice' });
    // The same endpoint, another model of it: the session goes on.
    expect((await turn('homelab/other', 'two')).sessionId).toBe('session-Alice');
    // The CLI's own model (named, or its default): the session was the endpoint's, so a fresh one, with the whole history.
    const own = await turn(undefined, 'three');
    expect(own.sessionId).toBeUndefined();
    expect(own.prompt).toContain('one');
    expect(new Store(db).get(conv.id)!.agentState.a).not.toHaveProperty('backend');
    expect((await turn('opus', 'four')).sessionId).toBe('session-Alice');
    // Back on an endpoint, and then on another one: fresh each time.
    expect((await turn('homelab/gemma4:e4b', 'five')).sessionId).toBeUndefined();
    expect((await turn('studio/qwen3', 'six')).sessionId).toBeUndefined();
    expect(new Store(db).get(conv.id)!.agentState.a).toMatchObject({ backend: 'studio' });
    expect((await turn('studio/qwen3', 'seven')).sessionId).toBe('session-Alice');
  });

  it("runs the lead agent as its account, and new members of its team as an account that is signed in", async () => {
    const home = join(root, `agents-${n}`);
    settings.setAgentHome(home);
    const work = settings.addAccount('claude', 'Work');
    settings.setLead({ provider: 'claude', account: work });
    // Only the Work account is signed in.
    orchestrator = new Orchestrator(store, new Hub(), settings, {
      context: async () => ({ available: ['claude'], accounts: { claude: [work] }, catalog: [], presets: store.listPresets() }),
    });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [];
    leadReply = JSON.stringify({ choice: 'custom', name: 'Pair', mode: 'roundtable', rounds: 1, agents: [{ name: 'Ann', provider: 'claude', role: 'r' }], reason: 'x' });
    await orchestrator.send(conv.id, 'design one');
    await finish(conv.id);
    expect(calls.map((c) => [c.name, c.home])).toEqual([['lead', join(home, `claude-${work}`)]]);
    expect(conv.messages.find((m) => m.plan)!.plan!.agents!.map((a) => [a.name, a.account])).toEqual([['Ann', work]]);
  });
});

describe("each account's own defaults and what its runs leave out", () => {
  it("runs each member with its account's default model and effort, and leaves out what that account leaves out", async () => {
    settings.setAgentHome(join(root, `agents-${n}`));
    settings.updateAccount('claude', '', { defaultModel: 'opus', defaultEffort: 'high', nativeOff: ['mcp'] });
    const work = settings.addAccount('claude', 'Work');
    settings.updateAccount('claude', work, { defaultModel: 'sonnet', defaultEffort: 'low', nativeOff: ['hooks'], nativeItems: { skills: ['commit'] } });
    const gone = settings.addAccount('claude', 'Gone');
    settings.updateAccount('claude', gone, { defaultModel: 'haiku', nativeOff: ['plugins'] });
    settings.removeAccount('claude', gone);
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.agents = [
      { id: 'a', name: 'Alice', provider: 'claude', role: '', account: work },
      // Her own model and effort come before her account's defaults.
      { id: 'b', name: 'Bob', provider: 'claude', role: '', account: work, model: 'fable', effort: 'max' },
      { id: 'c', name: 'Cid', provider: 'claude', role: '' },
      // An account removed since is the default account, with its defaults.
      { id: 'd', name: 'Dee', provider: 'claude', role: '', account: gone },
    ];
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(calls.map((c) => [c.name, c.model, c.effort, c.nativeOff?.join(), c.nativeItems?.skills?.join()])).toEqual([
      ['Alice', 'sonnet', 'low', 'hooks', 'commit'],
      ['Bob', 'fable', 'max', 'hooks', 'commit'],
      ['Cid', 'opus', 'high', 'mcp', undefined],
      ['Dee', 'opus', 'high', 'mcp', undefined],
    ]);
    // Briefed with what its own runs leave out.
    expect(calls[0]!.systemPrompt).not.toEqual(calls[2]!.systemPrompt);
  });

  it("runs the lead agent and the group sorter with the lead's account's defaults and what it leaves out", async () => {
    settings.setAgentHome(join(root, `agents-${n}`));
    settings.updateAccount('claude', '', { defaultModel: 'opus', nativeOff: ['mcp'] });
    const work = settings.addAccount('claude', 'Work');
    settings.updateAccount('claude', work, { defaultModel: 'sonnet', defaultEffort: 'medium', nativeOff: ['skills'], nativeItems: { tools: ['WebFetch'] } });
    settings.setLead({ provider: 'claude', account: work });
    store.createGroup({ id: 'g1', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [];
    leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
    await orchestrator.send(conv.id, 'Write the README');
    await finish(conv.id);
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(false));
    const helpers = calls.filter((c) => c.name === 'lead' || c.name === 'sorter').sort((x, y) => x.name.localeCompare(y.name));
    expect(helpers.map((c) => [c.name, c.model, c.effort, c.nativeOff?.join(), c.nativeItems?.tools?.join()])).toEqual([
      ['lead', 'sonnet', 'medium', 'skills', 'WebFetch'],
      ['sorter', 'sonnet', 'medium', 'skills', 'WebFetch'],
    ]);
  });
});

describe('a team the lead agent designs', () => {
  it("keeps the tools and account the user set for a member who stays on, and gives new members their CLI's defaults", async () => {
    const work = settings.addAccount('claude', 'Work');
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [{ id: 'r1', name: 'Researcher', provider: 'claude', role: 'Search the web', tools: { memory: false }, account: work }];
    store.saveMeta(conv);
    leadReply = JSON.stringify({
      choice: 'custom',
      name: 'Research and write',
      mode: 'roundtable',
      rounds: 1,
      agents: [
        // The lead names tools: never taken.
        { name: 'Researcher', provider: 'claude', role: 'Search the web', tools: { memory: true } },
        { name: 'Writer', provider: 'claude', role: 'Write it up', tools: { memory: false } },
      ],
      reason: 'x',
    });
    await orchestrator.send(conv.id, 'research and write');
    await finish(conv.id);
    const plan = conv.messages.find((m) => m.plan)!.plan!;
    expect(plan.agents!.map((a) => [a.name, a.id === 'r1', a.tools, a.account])).toEqual([
      ['Researcher', true, { memory: false }, work],
      ['Writer', false, undefined, undefined],
    ]);
  });
});

describe("the lead agent's context", () => {
  it('is gathered for the folder the team works in, and the lead reads each CLI\'s tools from it', async () => {
    const folders: (string | undefined)[] = [];
    orchestrator = new Orchestrator(store, new Hub(), settings, {
      context: async (cwd) => {
        folders.push(cwd);
        return {
          available: ['claude'],
          catalog: [],
          presets: store.listPresets(),
          native: { claude: { builtinTools: ['WebSearch'], skills: [], mcpServers: [{ name: 'github', tools: ['create_issue'] }] } },
        };
      },
    });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [];
    leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-general', reason: 'x' });
    await orchestrator.send(conv.id, 'design one');
    await finish(conv.id);
    expect(folders).toEqual([project]);
    expect(calls[0]!.prompt).toContain('  Built-in tools: WebSearch\n  Its own MCP servers: github (tools: create_issue)');

    // Changing the team: the folder in the drawer, saved or not.
    const other = join(root, `other-${n}`);
    mkdirSync(other, { recursive: true });
    reviseReply = JSON.stringify({ agents: [{ name: 'Ann', provider: 'claude', role: 'r' }], reason: 'r' });
    await orchestrator.reviseTeam(conv.id, {
      request: 'one member',
      agents: [{ id: 'x', name: 'Ann', provider: 'claude', role: 'r' }],
      settings: { mode: 'roundtable', rounds: 1, maxHops: 5, permission: 'read-only', cwd: other },
    });
    expect(folders).toEqual([project, other]);
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

  /** The conversation after its first question was designed for, confirmed and answered by the research pair. */
  const answered = async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = customTeam;
    await orchestrator.send(conv.id, 'I want to understand functional programming');
    await finish(conv.id);
    orchestrator.confirmPlan(conv.id, conv.messages.find((m) => m.plan)!.id);
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    calls = [];
    return conv;
  };
  const plans = (conv: Conversation) => conv.messages.filter((m) => m.plan);

  it('lets the lead agent design the team for the question; the team answers it once the user confirmed it', async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = 'Here is my choice:\n```json\n' + customTeam + '\n```';
    await orchestrator.send(conv.id, 'I want to understand functional programming');
    await finish(conv.id);

    // Only the lead agent ran, for a new conversation: nothing to keep, no history.
    expect(calls.map((c) => c.name)).toEqual(['lead']);
    expect(calls[0]!.prompt).toContain('<question>\nI want to understand functional programming\n</question>');
    expect(calls[0]!.prompt).toContain('The user started a new conversation');
    expect(calls[0]!.prompt).not.toContain('<conversation>');
    expect(calls[0]!.prompt).not.toContain('"choice": "keep"');
    const [request, plan] = conv.messages;
    expect(conv.messages).toHaveLength(2);
    expect(request!.author.kind).toBe('user');
    expect(plan!.plan).toMatchObject({ status: 'ready', source: 'custom', name: 'Research pair', reason: 'Two views beat one.', awaitingConfirmation: true });
    expect(plan!.meta?.costUsd).toBe(0.01);
    // Grok is not available here, so Bob runs on the lead's CLI.
    expect(plan!.plan!.agents!.map((a) => [a.name, a.provider])).toEqual([
      ['Alice', 'claude'],
      ['Bob', 'claude'],
    ]);
    // The team is the conversation's once the user confirms it.
    expect(conv.agents).toEqual([]);
    // Auto team stays on: the next question is designed too.
    expect(conv.settings.autoTeam).toBe(true);

    // Nobody answers until the user confirms the team: a message written meanwhile waits for it.
    expect(await orchestrator.send(conv.id, 'Start with monads')).toEqual({ queued: true });
    await expect(orchestrator.send(conv.id, '')).rejects.toThrow(/確認/);
    expect(conv.messages).toHaveLength(2);
    expect(calls.map((c) => c.name)).toEqual(['lead']);
    orchestrator.confirmPlan(conv.id, plan!.id);
    expect(plan!.plan!.awaitingConfirmation).toBeUndefined();
    expect(plan!.plan!.confirmedAt).toEqual(expect.any(Number));
    expect(conv.agents.map((a) => a.name)).toEqual(['Alice', 'Bob']);
    expect(new Store(db).get(conv.id)!.agents.map((a) => a.name)).toEqual(['Alice', 'Bob']);

    // Confirming lets the team answer the question, with the message that waited.
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(conv.messages[2]!.author.kind).toBe('user');
    expect(conv.messages[2]!.queued).toBeUndefined(); // written before the team replied, not added mid-reply
    expect(conv.queue).toEqual([]);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice', 'Bob']);
    // The team sees the question and what waited; never the plan.
    expect(calls[1]!.prompt).toContain('I want to understand functional programming');
    expect(calls[1]!.prompt).toContain('Start with monads');
    expect(calls[1]!.prompt).not.toContain('Research pair');
    expect(agentMessages(conv).map((m) => m.agentName)).toEqual(['Alice', 'Bob']);

    const preset = orchestrator.savePlanAsPreset(conv.id, plan!.id, 'My research pair');
    expect(store.listPresets().find((p) => p.id === preset.id)).toMatchObject({ name: 'My research pair' });
    expect(plan!.plan!.savedPresetId).toBe(preset.id);

    const reloaded = new Store(db).get(conv.id)!;
    expect(reloaded.messages[1]!.plan).toMatchObject({ source: 'custom', savedPresetId: preset.id, confirmedAt: plan!.plan!.confirmedAt });
    expect(reloaded.messages[1]!.plan!.awaitingConfirmation).toBeUndefined();
    expect(reloaded.settings.autoTeam).toBe(true);
  });

  it('designs the team for each new question, with the conversation so far, and keeps members who stay on', async () => {
    const conv = await answered();
    const [alice, bob] = conv.agents;

    // The lead keeps the team: the same members, who carry on in their sessions.
    leadReply = JSON.stringify({ choice: 'keep', reason: 'Same topic.' });
    await orchestrator.send(conv.id, 'And what is a functor?');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead']);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('The user asked a new question in this conversation');
    expect(prompt).toContain('<question>\nAnd what is a functor?\n</question>');
    // What was said before, and the team that answered it.
    expect(prompt).toContain('[User]: I want to understand functional programming');
    expect(prompt).toContain('[@Alice (Claude Code)]: Alice done');
    expect(prompt).toMatch(/<current_team>[\s\S]*"name": "Bob"[\s\S]*<\/current_team>/);
    expect(prompt).toContain('"choice": "keep"');
    expect(plans(conv)[1]!.plan).toMatchObject({ source: 'kept', reason: 'Same topic.', awaitingConfirmation: true });
    expect(conv.agents.map((a) => a.id)).toEqual([alice!.id, bob!.id]);

    orchestrator.confirmPlan(conv.id, plans(conv)[1]!.id);
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(4), { timeout: 20_000 });
    await finish(conv.id);
    expect(calls.slice(1).map((c) => [c.name, c.sessionId])).toEqual([
      ['Alice', 'session-Alice'],
      ['Bob', 'session-Bob'],
    ]);

    // A new team for the next question: Alice stays on (same name and CLI), Carol joins.
    calls = [];
    leadReply = JSON.stringify({
      choice: 'custom',
      name: 'Writers',
      mode: 'relay',
      maxHops: 4,
      agents: [
        { name: 'alice', provider: 'claude', role: 'Draft it.' },
        { name: 'Carol', provider: 'claude', role: 'Edit it.' },
      ],
      reason: 'A writing job.',
    });
    await orchestrator.send(conv.id, 'Now write a blog post about it');
    await finish(conv.id);
    // Only the new question is the question; the earlier one is history.
    expect(calls[0]!.prompt).toContain('<question>\nNow write a blog post about it\n</question>');
    expect(calls[0]!.prompt).toContain('[User]: And what is a functor?');
    // Until the user confirms it, the current team stays.
    expect(conv.agents.map((a) => a.id)).toEqual([alice!.id, bob!.id]);
    expect(conv.settings.mode).toBe('roundtable');
    orchestrator.confirmPlan(conv.id, plans(conv)[2]!.id);
    expect(conv.agents.map((a) => a.name)).toEqual(['alice', 'Carol']);
    expect(conv.agents[0]!.id).toBe(alice!.id);
    expect(conv.agents[1]!.id).not.toBe(bob!.id);
    expect(conv.settings).toMatchObject({ mode: 'relay', maxHops: 4, autoTeam: true });
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(5), { timeout: 20_000 });
    await finish(conv.id);
    // Relay: the leader answers, and keeps its session.
    expect(calls.slice(1).map((c) => [c.name, c.sessionId])).toEqual([['alice', 'session-Alice']]);
  });

  it('keeps the current team while a design waits: the user may decline it, retry or edit an earlier message', async () => {
    const conv = await answered();
    const team = conv.agents.map((a) => a.id);
    const solo = JSON.stringify({ choice: 'custom', name: 'Solo', agents: [{ name: 'Zed', provider: 'claude', role: 'Alone.' }], reason: 'One is enough.' });
    leadReply = solo;
    await orchestrator.send(conv.id, 'A small thing');
    await finish(conv.id);
    expect(conv.agents.map((a) => a.id)).toEqual(team);

    // Retrying an earlier reply drops the waiting design with what follows; the team that wrote it answers.
    calls = [];
    await orchestrator.retry(conv.id, agentMessages(conv)[0]!.id);
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(plans(conv)).toHaveLength(1);
    expect(conv.agents.map((a) => a.id)).toEqual(team);

    // Declining keeps the current team, which answers the question.
    calls = [];
    await orchestrator.send(conv.id, 'A small thing');
    await finish(conv.id);
    const waiting = plans(conv)[1]!;
    expect(() => orchestrator.declinePlan(conv.id, 'nope')).toThrow(/找不到這份團隊設計/);
    orchestrator.declinePlan(conv.id, waiting.id);
    expect(waiting.plan).toMatchObject({ declinedAt: expect.any(Number) });
    expect(waiting.plan!.awaitingConfirmation).toBeUndefined();
    expect(waiting.plan!.confirmedAt).toBeUndefined();
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(4), { timeout: 20_000 });
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice', 'Bob']);
    expect(conv.agents.map((a) => a.id)).toEqual(team);
    // Answered already: confirming it later changes nothing.
    orchestrator.confirmPlan(conv.id, waiting.id);
    expect(conv.agents.map((a) => a.id)).toEqual(team);

    // A first question has no team to keep.
    const fresh = autoConversation();
    fresh.agents = [];
    await orchestrator.send(fresh.id, 'Hello');
    await finish(fresh.id);
    expect(() => orchestrator.declinePlan(fresh.id, plans(fresh)[0]!.id)).toThrow(/還沒有團隊/);
  });

  it('lets the current team take an interjection, and an edit that @mentions a member; designs for "stop and ask this instead"', async () => {
    const conv = await answered();
    // Written while Bob replies and taken by no turn: the current team answers it in a run of its own.
    let release!: () => void;
    gates = { Bob: new Promise<void>((r) => (release = r)) };
    await orchestrator.send(conv.id, '@Bob say more');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toEqual([conv.agents[1]!.id]), { interval: 20 });
    expect(await orchestrator.send(conv.id, 'And one more thing')).toEqual({ queued: true });
    release();
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Bob', 'Alice', 'Bob']), { timeout: 20_000 });
    await finish(conv.id);
    expect(conv.messages.find((m) => textOf(m) === 'And one more thing')!.queued).toBe(true);

    // Editing a question so that it @mentions a member: that member answers, no design.
    calls = [];
    await orchestrator.resend(conv.id, firstUserMessage(conv).id, '@Alice explain monads again');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice']);

    // Stop and ask this instead: a new question, so the lead designs its team.
    calls = [];
    gates = { Alice: new Promise<void>(() => {}) };
    await orchestrator.send(conv.id, '@Alice and then?');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toHaveLength(1), { interval: 20 });
    leadReply = JSON.stringify({ choice: 'keep' });
    await orchestrator.send(conv.id, 'Something else entirely', undefined, true);
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'lead']);
    expect(plans(conv).at(-1)!.plan).toMatchObject({ source: 'kept', awaitingConfirmation: true });
  });

  it('says why when the team used at once cannot start, and Continue lets it answer without a new design', async () => {
    // Another conversation is writing in the same folder.
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const writer = conversation({ mode: 'roundtable' });
    await orchestrator.send(writer.id, 'go');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(writer.id)).toHaveLength(1), { interval: 20 });

    const conv = conversation({ mode: 'roundtable', autoTeam: true, autoConfirm: true }); // may edit files
    conv.agents = [];
    leadReply = customTeam;
    await orchestrator.send(conv.id, 'Fix the bug');
    await vi.waitFor(() => expect(conv.messages.at(-1)!.author.kind).toBe('system'), { timeout: 20_000 });
    await vi.waitFor(() => expect(textOf(conv.messages.at(-1)!)).toMatch(/正在修改/), { timeout: 20_000 });
    expect(agentMessages(conv)).toHaveLength(0);
    expect(plans(conv)[0]!.plan).toMatchObject({ autoConfirmed: true });

    release();
    await finish(writer.id);
    calls = [];
    await orchestrator.send(conv.id, '');
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
  });

  it('refuses to confirm while something else holds the conversation', async () => {
    const conv = autoConversation();
    conv.agents = [];
    leadReply = customTeam;
    await orchestrator.send(conv.id, 'Question');
    await finish(conv.id);
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    expect(() => orchestrator.confirmPlan(conv.id, plans(conv)[0]!.id)).toThrow(/回覆中/);
    expect(plans(conv)[0]!.plan!.awaitingConfirmation).toBe(true);
    expect(conv.agents).toEqual([]);
    release();
    await held;
    orchestrator.confirmPlan(conv.id, plans(conv)[0]!.id);
    await vi.waitFor(() => expect(agentMessages(conv)).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
  });

  it('lets the current team take an answer, a message for its members, Continue and a retry without a new design', async () => {
    const conv = await answered();
    // A message that @mentions a member goes to that member.
    await orchestrator.send(conv.id, '@Bob can you say more?');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Bob']);

    // An answer to an agent's question.
    calls = [];
    asking = new Set(['Alice']);
    leadReply = JSON.stringify({ choice: 'keep' });
    await orchestrator.send(conv.id, 'One more thing');
    await finish(conv.id);
    orchestrator.confirmPlan(conv.id, plans(conv).at(-1)!.id);
    await vi.waitFor(() => expect(conv.pause).toBeDefined(), { timeout: 20_000 });
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice']);
    calls = [];
    asking = new Set();
    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);

    // Continue, and a retry.
    calls = [];
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    await orchestrator.retry(conv.id, agentMessages(conv).at(-1)!.id);
    await finish(conv.id);
    expect(calls.map((c) => c.name)).not.toContain('lead');
    expect(plans(conv)).toHaveLength(2);
  });

  it('uses the lead agent\'s team at once when the conversation does not ask', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true });
    conv.agents = [];
    leadReply = customTeam;
    await orchestrator.send(conv.id, 'Explain closures');
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice', 'Bob']);
    expect(calls[0]!.prompt).toContain('Your team answers the question right away.');
    expect(plans(conv)[0]!.plan).toMatchObject({ source: 'custom', autoConfirmed: true, confirmedAt: expect.any(Number) });
    expect(plans(conv)[0]!.plan!.awaitingConfirmation).toBeUndefined();
    expect(new Store(db).get(conv.id)!.settings.autoConfirm).toBe(true);
  });

  it('keeps the current team when the design fails, and designs again on Continue after a stopped design', async () => {
    const conv = await answered();
    const ids = conv.agents.map((a) => a.id);
    leadReply = 'No idea.';
    await orchestrator.send(conv.id, 'Something else');
    await finish(conv.id);
    expect(plans(conv)[1]!.plan).toMatchObject({ source: 'fallback', awaitingConfirmation: true });
    expect(plans(conv)[1]!.plan!.presetId).toBeUndefined();
    expect(conv.agents.map((a) => a.id)).toEqual(ids);
    orchestrator.confirmPlan(conv.id, plans(conv)[1]!.id);
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(4), { timeout: 20_000 });
    await finish(conv.id);

    // Stopped while designing: Continue designs again, for the question that still waits.
    calls = [];
    let release!: () => void;
    leadGate = new Promise((r) => (release = r));
    leadReply = JSON.stringify({ choice: 'keep' });
    await orchestrator.send(conv.id, 'A third question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['lead']), { interval: 20 });
    orchestrator.stop(conv.id);
    release();
    await finish(conv.id);
    expect(plans(conv).at(-1)!.status).toBe('aborted');
    leadGate = undefined;
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'lead']);
    expect(calls[1]!.prompt).toContain('<question>\nA third question\n</question>');
    expect(plans(conv).at(-1)!.plan).toMatchObject({ status: 'ready', source: 'kept', awaitingConfirmation: true });
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
    expect(conv.messages[1]!.plan).toMatchObject({ source: 'template', presetId: 'builtin-parallel', settings: { mode: 'parallel' } });
    expect(() => orchestrator.savePlanAsPreset(conv.id, conv.messages[1]!.id)).toThrow(/設計或調整/);

    const other = autoConversation();
    other.agents = [];
    leadReply = 'I would pick a nice team.';
    await orchestrator.send(other.id, 'Hello');
    await finish(other.id);
    expect(other.messages[1]!.plan).toMatchObject({ source: 'fallback', presetId: 'builtin-general' });
    expect(other.messages[1]!.plan!.agents!.map((a) => a.name)).toEqual(['Analyst', 'Critic', 'Synthesizer']);
  });

  it('designs the team again when the question is edited', async () => {
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

describe('branching a conversation', () => {
  const kinds = (conv: Conversation) => conv.messages.map((m) => m.author.kind);
  const refs = () =>
    execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/harness-relay/'], { cwd: project, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

  it('copies the messages up to the reply into a new conversation, which goes on from there with fresh sessions', async () => {
    store.createGroup({ id: 'g1', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.allowRules = [{ kind: 'command', key: 'npm test' }];
    store.saveMeta(conv);
    store.moveToGroup(conv.id, 'g1');
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'second question');
    await finish(conv.id);
    expect(kinds(conv)).toEqual(['user', 'agent', 'agent', 'user', 'agent', 'agent']);

    const source = conv.messages.slice(0, 3);
    const branch = await orchestrator.branch(conv.id, source[2]!.id);
    expect(branch.title).toBe('分支 · test');
    expect(kinds(branch)).toEqual(['user', 'agent', 'agent']);
    expect(branch.messages.map(textOf)).toEqual(source.map(textOf));
    expect(branch.messages.map((m) => m.createdAt)).toEqual(source.map((m) => m.createdAt));
    // New ids: messages are rows of their own.
    expect(branch.messages.some((m) => conv.messages.some((x) => x.id === m.id))).toBe(false);
    expect(branch.branch).toEqual({ fromId: conv.id, fromTitle: 'test', afterId: branch.messages[2]!.id });
    expect(branch.agents).toEqual(conv.agents);
    expect(branch.settings).toEqual(conv.settings);
    expect(branch.allowRules).toEqual([{ kind: 'command', key: 'npm test' }]);
    expect(branch.agentState).toEqual({});
    // In the same sidebar group, as the user's choice: the lead agent does not sort it.
    expect(store.groupOf(branch.id)).toBe('g1');
    expect(store.isSorted(branch.id)).toBe(true);
    // The original is untouched, and the database agrees with memory.
    expect(conv.messages).toHaveLength(6);
    const reloaded = new Store(db).get(branch.id)!;
    expect(reloaded.messages.map((m) => [m.id, m.author, textOf(m)])).toEqual(branch.messages.map((m) => [m.id, m.author, textOf(m)]));
    expect(reloaded.branch).toEqual(branch.branch);

    // The branch's agents start fresh, with the copied history and nothing after it.
    calls = [];
    await orchestrator.send(branch.id, 'another question');
    await finish(branch.id);
    expect(calls.map((c) => [c.name, c.sessionId])).toEqual([
      ['Alice', undefined],
      ['Bob', undefined],
    ]);
    expect(calls[0]!.prompt).toContain('first question');
    expect(calls[0]!.prompt).toContain('Alice done');
    expect(calls[0]!.prompt).toContain('another question');
    expect(calls[0]!.prompt).not.toContain('second question');
    expect(calls[0]!.systemPrompt).toContain('branched from an earlier one');
    expect(kinds(branch)).toEqual(['user', 'agent', 'agent', 'user', 'agent', 'agent']);
    expect(conv.messages).toHaveLength(6);
    // Named after what the user went on with there, as a new chat is after its first question.
    expect(branch.title).toBe('another question');
    expect(new Store(db).get(branch.id)!.title).toBe('another question');
  });

  it('names a branch after the first message written there only while it has the name it was made with', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    const reply = agentMessages(conv).at(-1)!.id;

    // Named once: the next message keeps the name.
    const one = await orchestrator.branch(conv.id, reply);
    await orchestrator.send(one.id, 'try it with tables\nand more lines');
    await finish(one.id);
    expect(one.title).toBe('try it with tables');
    await orchestrator.send(one.id, 'and then?');
    await finish(one.id);
    expect(one.title).toBe('try it with tables');

    // A name the user gave it stays.
    const two = await orchestrator.branch(conv.id, reply);
    two.title = 'My own name';
    store.saveMeta(two);
    await orchestrator.send(two.id, 'something else');
    await finish(two.id);
    expect(two.title).toBe('My own name');

    // A branch of a branch, and one made while the chat was called by another language's name for it.
    const three = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    expect(three.title).toBe('分支 · try it with tables');
    three.title = 'Branch · try it with tables';
    store.saveMeta(three);
    await orchestrator.send(three.id, 'only the totals');
    await finish(three.id);
    expect(three.title).toBe('only the totals');
  });

  it('makes a branch from a reply a branch had copied a branch of the conversation that reply was written in', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'second question');
    await finish(conv.id);
    // One: all six of conv's messages copied, then three of its own.
    const one = await orchestrator.branch(conv.id, agentMessages(conv)[3]!.id);
    await orchestrator.send(one.id, 'third question');
    await finish(one.id);
    expect(one.title).toBe('third question');

    // Two, from one's own reply: one's branch, which knows the six before were written in conv.
    const two = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    expect(two.title).toBe('分支 · third question');
    expect(two.branch).toEqual({
      fromId: one.id,
      fromTitle: 'third question',
      afterId: two.messages[8]!.id,
      earlier: [{ fromId: conv.id, fromTitle: 'test', afterId: two.messages[5]!.id }],
    });
    expect(new Store(db).get(two.id)!.branch).toEqual(two.branch);

    // conv is renamed: the branches made from now on name it by its title now.
    conv.title = 'Renamed';
    store.saveMeta(conv);

    // From a reply two copied that one wrote: a branch of one.
    const three = await orchestrator.branch(two.id, agentMessages(two)[4]!.id);
    expect(three.branch).toEqual({
      fromId: one.id,
      fromTitle: 'third question',
      afterId: three.messages[7]!.id,
      earlier: [{ fromId: conv.id, fromTitle: 'Renamed', afterId: three.messages[5]!.id }],
    });

    // From a reply conv wrote, copied into one and from there into two: a branch of conv, as if
    // branched there, named after it.
    const four = await orchestrator.branch(two.id, agentMessages(two)[1]!.id);
    expect(four.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: four.messages[2]!.id });
    expect(four.title).toBe('分支 · Renamed');
    expect(four.messages.map(textOf)).toEqual(conv.messages.slice(0, 3).map(textOf));

    // From a branch point, one's and the last of conv's part in two: that reply was written in the
    // conversation it was copied from too.
    const five = await orchestrator.branch(one.id, agentMessages(one)[3]!.id);
    expect(five.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: five.messages[5]!.id });
    const edge = await orchestrator.branch(two.id, agentMessages(two)[3]!.id);
    expect(edge.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: edge.messages[5]!.id });

    // The sidebar lists each under the conversation its reply was written in.
    const from = Object.fromEntries(store.list(() => false).map((c) => [c.id, c.branchFrom?.id]));
    expect(from).toMatchObject({ [one.id]: conv.id, [two.id]: one.id, [three.id]: one.id, [four.id]: conv.id, [five.id]: conv.id, [edge.id]: conv.id });

    // The conversation the reply was written in is deleted: the branch still names it, by the title
    // the sidebar shows for it (its title when the newest branch of it was made).
    conv.title = 'Renamed again';
    store.saveMeta(conv);
    await orchestrator.deleteConversation(conv.id);
    const six = await orchestrator.branch(two.id, agentMessages(two)[1]!.id);
    expect(six.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: six.messages[2]!.id });
    expect(six.title).toBe('分支 · Renamed');
    expect(store.family(six.id).sort()).toEqual([one.id, two.id, three.id, four.id, five.id, edge.id, six.id].sort());
  });

  it("keeps a branch from the part a deleted conversation wrote in its family, also when it is deleted while the branch's files are copied", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    const one = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    await orchestrator.send(one.id, 'second question');
    await finish(one.id);
    const two = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    const three = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);

    // One goes while a branch from what it wrote is copying its files, which only two waits for:
    // the branch still learns where one came from.
    let release!: () => void;
    copying.gate = new Promise((r) => (release = r));
    let four: Conversation;
    try {
      const making = orchestrator.branch(two.id, agentMessages(two)[2]!.id);
      await orchestrator.deleteConversation(one.id);
      release();
      four = await making;
    } finally {
      copying.gate = undefined;
    }
    expect(four.branch).toMatchObject({ fromId: one.id, fromTitle: 'second question', via: [{ id: conv.id, title: 'test' }] });
    expect(four.branch?.earlier).toEqual([{ fromId: conv.id, fromTitle: 'test', afterId: four.messages[2]!.id }]);

    // Once it is deleted: a branch from what it wrote is under its place too, which is under conv.
    const five = await orchestrator.branch(three.id, agentMessages(three)[2]!.id);
    expect(five.branch).toMatchObject({ fromId: one.id, fromTitle: 'second question', via: [{ id: conv.id, title: 'test' }] });

    // Every other conversation that remembered where one came from is deleted: still one family.
    await orchestrator.deleteConversation(two.id);
    await orchestrator.deleteConversation(three.id);
    expect(store.family(four.id).sort()).toEqual([conv.id, four.id, five.id].sort());
  });

  it('makes a branch one of the conversation further up once an edit leaves nothing of the one it was branched from', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'second question');
    await finish(conv.id);
    const one = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    one.title = 'One';
    store.saveMeta(one);
    await orchestrator.send(one.id, 'third question');
    await finish(one.id);
    // conv's first three, then one's three.
    const two = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    const mine = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    const blank = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    expect(two.title).toBe('分支 · One');

    // Retrying a reply one wrote: one's part ends earlier.
    await orchestrator.retry(two.id, agentMessages(two).at(-1)!.id);
    await finish(two.id);
    expect(two.branch).toEqual({
      fromId: one.id,
      fromTitle: 'One',
      afterId: two.messages[4]!.id,
      earlier: [{ fromId: conv.id, fromTitle: 'test', afterId: two.messages[2]!.id }],
    });

    // Retrying a reply conv wrote: nothing of one is left, so it is conv's branch, named after conv
    // by its title now.
    conv.title = 'Renamed';
    store.saveMeta(conv);
    await orchestrator.retry(two.id, agentMessages(two)[1]!.id);
    expect(two.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: two.messages[1]!.id });
    expect(new Store(db).get(two.id)!.branch).toEqual(two.branch);
    await finish(two.id);
    expect(two.title).toBe('分支 · Renamed');
    expect(store.list(() => false).find((c) => c.id === two.id)!.branchFrom?.id).toBe(conv.id);

    // Editing the message one wrote first in a branch the user named: conv's branch, the name stays.
    mine.title = 'Mine';
    store.saveMeta(mine);
    await orchestrator.resend(mine.id, mine.messages[3]!.id, 'third question, edited');
    expect(mine.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: mine.messages[2]!.id });
    await finish(mine.id);
    expect(mine.title).toBe('Mine');

    // Editing the first message: nothing copied is left, of either part.
    await orchestrator.resend(blank.id, blank.messages[0]!.id, 'from scratch');
    expect(blank.branch).toBeUndefined();
    await finish(blank.id);
    expect(blank.title).toBe('from scratch');
  });

  it('works while the team replies, but not from a reply with one before it still being written', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only' });
    let release!: () => void;
    gates = { Alice: new Promise((r) => (release = r)) };
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(agentMessages(conv).map((m) => m.status)).toEqual(['streaming', 'done']));
    const bob = agentMessages(conv)[1]!;
    await expect(orchestrator.branch(conv.id, bob.id)).rejects.toMatchObject({ status: 409 });
    release();
    await finish(conv.id);
    expect(textOf(agentMessages(conv)[0]!)).toBe('Alice done');

    gates = { Bob: new Promise(() => {}) }; // Bob only finishes when stopped
    await orchestrator.send(conv.id, 'again');
    await vi.waitFor(() => expect(agentMessages(conv).at(-2)?.status).toBe('done'));
    const branch = await orchestrator.branch(conv.id, agentMessages(conv).at(-2)!.id);
    expect(kinds(branch)).toEqual(['user', 'agent', 'agent', 'user', 'agent']);
    expect(orchestrator.isRunning(conv.id)).toBe(true);
    orchestrator.stop(conv.id);
    await finish(conv.id);
  });

  it("refuses the user's messages, unknown messages and unknown conversations", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    await expect(orchestrator.branch(conv.id, conv.messages[0]!.id)).rejects.toMatchObject({ status: 400 });
    await expect(orchestrator.branch(conv.id, 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(orchestrator.branch('nope', agentMessages(conv)[0]!.id)).rejects.toMatchObject({ status: 404 });
    expect(store.list(() => false)).toHaveLength(1);
  });

  it('copies the attached files and keeps the diffs of the copied replies, also once the original is deleted', async () => {
    const conv = conversation({ mode: 'roundtable' });
    conv.agents = [agents[0]!];
    during = (_name, cwd) => writeFileSync(join(cwd, 'turn.txt'), 'changed\n');
    await orchestrator.send(conv.id, 'look', [
      { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('marmalade\n').toString('base64') },
      { name: 'gone.txt', mimeType: 'text/plain', data: 'aGk=' },
    ]);
    await finish(conv.id);
    const reply = agentMessages(conv)[0]!;
    expect(reply.changes?.[0]?.files.length).toBeGreaterThan(0);

    // A file already gone is skipped; the others are copied, readable by the owner only.
    const gone = conv.messages.find((m) => m.author.kind === 'user')!.parts.find((p) => p.type === 'attachment' && p.name === 'gone.txt')!;
    rmSync(gone.type === 'attachment' ? attachmentPath(conv.id, gone) : '');
    const branch = await orchestrator.branch(conv.id, reply.id);
    const file = branch.messages.find((m) => m.author.kind === 'user')!.parts.find((p) => p.type === 'attachment')!;
    expect(file.type === 'attachment' && readFileSync(attachmentPath(branch.id, file), 'utf8')).toBe('marmalade\n');
    // (Windows has no permission bits.)
    if (process.platform !== 'win32') expect(file.type === 'attachment' && statSync(attachmentPath(branch.id, file)).mode & 0o777).toBe(0o600);
    expect(gone.type === 'attachment' && existsSync(attachmentPath(branch.id, gone))).toBe(false);
    expect(refs().filter((r) => r.includes(`/${branch.id}/`))).toHaveLength(2);

    const copied = agentMessages(branch)[0]!;
    const diff = await orchestrator.messageDiff(branch.id, copied.id);
    await orchestrator.deleteConversation(conv.id);
    expect(file.type === 'attachment' && readFileSync(attachmentPath(branch.id, file), 'utf8')).toBe('marmalade\n');
    expect(await orchestrator.messageDiff(branch.id, copied.id)).toBe(diff);
    expect(refs().every((r) => r.includes(`/${branch.id}/`))).toBe(true);

    await orchestrator.deleteConversation(branch.id);
    expect(refs()).toEqual([]);
  });

  it('moves the line after the copied messages back when one of them is retried, and drops it once none is left', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    const [question, alice] = branch.messages;

    await orchestrator.retry(branch.id, agentMessages(branch)[1]!.id);
    await finish(branch.id);
    expect(kinds(branch)).toEqual(['user', 'agent', 'agent']);
    expect(branch.branch?.afterId).toBe(alice!.id);
    expect(new Store(db).get(branch.id)!.branch?.afterId).toBe(alice!.id);

    await orchestrator.resend(branch.id, question!.id, 'question, edited');
    await finish(branch.id);
    expect(branch.branch).toBeUndefined();
    expect(new Store(db).get(branch.id)!.branch).toBeUndefined();
    // No longer a branch: named after the edited question, as a new chat is after its first one.
    expect(branch.title).toBe('question, edited');
    expect(new Store(db).get(branch.id)!.title).toBe('question, edited');
  });

  it('keeps a name the user gave a branch once it is no longer one', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    branch.title = 'Mine';
    store.saveMeta(branch);
    await orchestrator.resend(branch.id, branch.messages[0]!.id, 'question, edited');
    await finish(branch.id);
    expect(branch.branch).toBeUndefined();
    expect(branch.title).toBe('Mine');
  });

  it('names a branch after a message that waited in its queue, and moves along with its family', async () => {
    store.createGroup({ id: 'g1', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    // Bob answers again; written meanwhile, the message waits in the queue, unposted.
    let release!: () => void;
    gates = { Bob: new Promise((r) => (release = r)) };
    await orchestrator.retry(branch.id, agentMessages(branch)[1]!.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(branch.id)).toBe(true));
    await orchestrator.send(branch.id, 'try it differently');
    expect(branch.queue?.map(textOf)).toEqual(['try it differently']);
    expect(branch.title).toBe('分支 · test');
    release();
    await finish(branch.id);
    expect(branch.messages.some((m) => textOf(m) === 'try it differently')).toBe(true);
    expect(branch.title).toBe('try it differently');

    // A family moves as one: from the branch, the original goes too.
    store.moveToGroup(branch.id, 'g1');
    expect(store.groupOf(conv.id)).toBe('g1');
  });

  it("keeps a question the reply asked open in the branch, also once it was answered here", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    const asked = agentMessages(conv)[0]!;
    expect(conv.pause).toMatchObject({ askers: ['a'], rest: [{ agentId: 'b' }] });

    // Branched where this conversation waits: the branch waits the same way.
    const now = await orchestrator.branch(conv.id, asked.id);
    expect(now.pause).toEqual(conv.pause);
    expect(new Store(db).get(now.id)!.pause).toEqual(conv.pause);

    // Answered here; a branch from the question still waits for its answer.
    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(conv.pause).toBeUndefined();
    const later = await orchestrator.branch(conv.id, asked.id);
    expect(later.pause).toEqual({ mode: 'roundtable', askers: ['a'], rest: [{ agentId: 'b' }], participants: ['a', 'b'], round: 1, rounds: 1 });

    // Its answer goes to the agent that asked, then the round goes on, with no new team designed.
    later.settings.autoTeam = true;
    calls = [];
    await orchestrator.send(later.id, 'ANSWER: B');
    await finish(later.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(calls[0]!.prompt).toContain('You asked the user a question and their reply is among the messages above');
    expect(kinds(later)).toEqual(['user', 'agent', 'user', 'agent', 'agent']);
    expect(later.pause).toBeUndefined();
  });

  it('works out what a branch waits for in each mode, and waits for nothing after a reply that did not ask', () => {
    const reply = (agentId: string, asked: boolean, round = 1) =>
      ({ id: `${agentId}-${round}`, author: { kind: 'agent', agentId }, parts: [], status: 'done', createdAt: 0, meta: { round }, ...(asked ? { asked } : {}) }) as Conversation['messages'][number];
    const question = (text: string) => ({ id: 'q', author: { kind: 'user' }, parts: [{ type: 'text', text }], status: 'done', createdAt: 0 }) as Conversation['messages'][number];
    const conv = (mode: ConversationSettings['mode'], messages: Conversation['messages']) =>
      ({ id: 'c', agents, settings: { mode, rounds: 2, maxHops: 4, permission: 'read-only', cwd: project }, messages }) as unknown as Conversation;

    // Parallel: the round's questions before the reply wait together; the others answered already.
    expect(branchPause(conv('parallel', [question('go'), reply('a', true), reply('b', true)]), 2)).toEqual({
      mode: 'parallel', askers: ['a', 'b'], rest: [], participants: ['a', 'b'], round: 1, rounds: 2,
    });
    // Roundtable: a question for one member only leaves nobody after it in the round.
    expect(branchPause(conv('roundtable', [question('@Bob go'), reply('b', true, 2)]), 1)).toEqual({
      mode: 'roundtable', askers: ['b'], rest: [], participants: ['b'], round: 2, rounds: 2,
    });
    expect(branchPause(conv('relay', [question('go'), reply('a', true)]), 1)).toEqual({
      mode: 'relay', askers: ['a'], rest: [], participants: [], round: 1, rounds: 1, hopsLeft: 4,
    });
    expect(branchPause(conv('relay', [question('go'), reply('a', false)]), 1)).toBeUndefined();
  });

  it("works out where a branch's copied messages come from, and where they end after a cut, from its parts", () => {
    const msgs = (...ids: string[]) => ids.map((id) => ({ id })) as unknown as Conversation['messages'];
    const branch = { fromId: 'A', fromTitle: 'A', afterId: 'm4', earlier: [{ fromId: 'Z', fromTitle: 'Z', afterId: 'm1' }] };
    const b = { id: 'B', title: 'B', branch, messages: msgs('m0', 'm1', 'm2', 'm3', 'm4', 'm5') } as unknown as Conversation;
    const copies = msgs('c0', 'c1', 'c2', 'c3', 'c4', 'c5');
    const titleOf = (id: string) => ({ Z: 'Zed' })[id];
    // From the last message of the earlier part, and from inside the latest: by the titles now.
    expect(branchOrigin(b, 1, copies, titleOf)).toEqual({ fromId: 'Z', fromTitle: 'Zed', afterId: 'c1' });
    expect(branchOrigin(b, 3, copies, titleOf)).toEqual({ ...branch, afterId: 'c3', earlier: [{ fromId: 'Z', fromTitle: 'Zed', afterId: 'c1' }] });
    // From its own reply: its branch, with both parts before it.
    expect(branchOrigin(b, 5, copies)).toEqual({
      fromId: 'B',
      fromTitle: 'B',
      afterId: 'c5',
      earlier: [
        { fromId: 'A', fromTitle: 'A', afterId: 'c4' },
        { fromId: 'Z', fromTitle: 'Z', afterId: 'c1' },
      ],
    });

    // Cut: a part that lost its last message ends with the last one left; one left with nothing goes.
    expect(branchAfterCut({ branch, messages: msgs('m0', 'm1', 'm2') }, new Set(['m3', 'm4', 'm5']))).toEqual({ ...branch, afterId: 'm2' });
    expect(branchAfterCut({ branch, messages: msgs('m0', 'm1') }, new Set(['m2', 'm3', 'm4', 'm5']))).toEqual({ fromId: 'Z', fromTitle: 'Z', afterId: 'm1' });
    expect(branchAfterCut({ branch, messages: msgs('m0') }, new Set(['m1', 'm2', 'm3', 'm4', 'm5']))).toEqual({ fromId: 'Z', fromTitle: 'Z', afterId: 'm0' });
    expect(branchAfterCut({ branch, messages: [] }, new Set(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']))).toBeUndefined();
    // Nothing of it dropped: as it was.
    expect(branchAfterCut({ branch, messages: msgs('m0', 'm1', 'm2', 'm3', 'm4') }, new Set(['m5']))).toEqual(branch);

    // A part whose last message is not here, and was not just dropped, cannot be placed: left out.
    const odd = { ...branch, earlier: [{ fromId: 'Z', fromTitle: 'Z', afterId: 'gone' }] };
    expect(branchAfterCut({ branch: odd, messages: b.messages }, new Set(['m6']))).toEqual({ fromId: 'A', fromTitle: 'A', afterId: 'm4' });
    expect(branchOrigin({ ...b, branch: odd }, 1, copies)).toEqual({ fromId: 'A', fromTitle: 'A', afterId: 'c1' });
  });

  it('waits for a parallel peer whose turn still records the files it changed', async () => {
    const conv = conversation({ mode: 'parallel' });
    let release!: () => void;
    gates = { Alice: new Promise((r) => (release = r)) };
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(agentMessages(conv)[1]?.changes).toBeTruthy(), { timeout: 10_000, interval: 5 });
    release();
    // Alice's reply is done, but her turn has not recorded her changes yet.
    while (agentMessages(conv)[0]!.status !== 'done') await new Promise((r) => setImmediate(r));
    expect(agentMessages(conv)[0]!.changes).toBeUndefined();
    await expect(orchestrator.branch(conv.id, agentMessages(conv)[1]!.id)).rejects.toMatchObject({ status: 409 });
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    expect(agentMessages(branch).map((m) => Boolean(m.changes?.[0]?.files.length))).toEqual([true, true]);
  });

  it('finishes copying the attached files before the original is deleted, and before shutdown', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.agents = [agents[0]!];
    const big = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.txt`, mimeType: 'text/plain', data: Buffer.alloc(1_000_000, 65).toString('base64') }));
    await orchestrator.send(conv.id, 'look', big);
    await finish(conv.id);
    const [branch] = await Promise.all([orchestrator.branch(conv.id, agentMessages(conv)[0]!.id), orchestrator.deleteConversation(conv.id)]);
    const files = branch.messages[0]!.parts.filter((p) => p.type === 'attachment');
    expect(files).toHaveLength(10);
    expect(files.filter((p) => p.type === 'attachment' && existsSync(attachmentPath(branch.id, p)))).toHaveLength(10);
    expect(store.get(conv.id)).toBeUndefined();

    let done = false;
    const again = orchestrator.branch(branch.id, agentMessages(branch)[0]!.id).then(() => (done = true));
    orchestrator.stopAll();
    await orchestrator.settled(10_000);
    expect(done).toBe(true);
    await again;
    await expect(orchestrator.branch(branch.id, agentMessages(branch)[0]!.id)).rejects.toMatchObject({ status: 503 });
  });

  it("shows a parallel reply's images from the worktree it was made in, not the branch's own", async () => {
    const conv = conversation({ mode: 'parallel' });
    conv.agents = [agents[0]!];
    await orchestrator.send(conv.id, 'draw');
    await finish(conv.id);
    const reply = agentMessages(conv)[0]!;
    expect(reply.changes?.[0]?.isolated).toBe(true);
    const wt = conv.worktrees.a![0]!;
    writeFileSync(join(worktreeDir(wt.root, conv.settings.cwd, wt.path), 'chart.png'), 'the original chart');
    const lookup = (id: string) => store.get(id);
    const chart = (c: Conversation, m: Conversation['messages'][number]) => {
      const file = resolveMedia('chart.png', mediaRoots(c, m, lookup));
      return file && readFileSync(file, 'utf8');
    };

    const branch = await orchestrator.branch(conv.id, reply.id);
    const copied = agentMessages(branch)[0]!;
    expect(chart(branch, copied)).toBe('the original chart');
    // The branch works in its own worktree; the copied reply still shows the original's chart.
    await orchestrator.send(branch.id, 'draw again');
    await finish(branch.id);
    const own = branch.worktrees.a![0]!;
    writeFileSync(join(worktreeDir(own.root, branch.settings.cwd, own.path), 'chart.png'), "the branch's chart");
    expect(chart(branch, copied)).toBe('the original chart');
    expect(chart(branch, agentMessages(branch)[1]!)).toBe("the branch's chart");

    // Once the original is gone, so is its worktree; the diff stays.
    const diff = await orchestrator.messageDiff(branch.id, copied.id);
    expect(diff).toContain('Alice.txt');
    await orchestrator.deleteConversation(conv.id);
    expect(chart(branch, copied)).toBeUndefined();
    expect(await orchestrator.messageDiff(branch.id, copied.id)).toBe(diff);
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

describe('conversations with agents at work (what an update of the desktop app waits for)', () => {
  it('counts each conversation replying, but not one waiting for the answer to its question', async () => {
    expect(orchestrator.busy()).toBe(0);
    const asks = conversation({ mode: 'roundtable', permission: 'read-only' });
    asking = new Set(['Alice']);
    await orchestrator.send(asks.id, 'question');
    await finish(asks.id);
    expect(asks.pause).toBeDefined();
    expect(orchestrator.busy()).toBe(0);
    asking = new Set();

    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const one = conversation({ mode: 'roundtable', permission: 'read-only' });
    const two = conversation({ mode: 'parallel', permission: 'read-only' });
    // Counted from the moment its run is being set up.
    const sending = orchestrator.send(one.id, 'go');
    expect(orchestrator.busy()).toBe(1);
    await sending;
    await orchestrator.send(two.id, 'go');
    expect(orchestrator.busy()).toBe(2);
    release();
    await finish(one.id);
    await finish(two.id);
    expect(orchestrator.busy()).toBe(0);
  });

  it('counts the lead agent changing a team or sorting a conversation, a change being made to it, and a branch being made', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    reviseGate = new Promise(() => {});
    const left = new AbortController();
    const revising = orchestrator.reviseTeam(conv.id, { request: 'add a tester', agents: conv.agents, settings: { mode: 'roundtable', rounds: 1, maxHops: 5 } }, left.signal);
    await vi.waitFor(() => expect(orchestrator.busy()).toBe(1));
    left.abort();
    await expect(revising).rejects.toMatchObject({ status: 409 });
    expect(orchestrator.busy()).toBe(0);

    store.createGroup({ id: 'g1', name: 'Docs' });
    let sorted!: () => void;
    sorterGate = new Promise((r) => (sorted = r));
    const fresh = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(fresh.id, 'go');
    await finish(fresh.id);
    expect(orchestrator.busy()).toBe(1); // still being sorted
    sorted();
    await vi.waitFor(() => expect(orchestrator.busy()).toBe(0));

    // A change being made to the conversation (applying a parallel reply, a settings change).
    let applied!: () => void;
    const applying = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (applied = r)));
    await vi.waitFor(() => expect(orchestrator.busy()).toBe(1));
    applied();
    await applying;
    expect(orchestrator.busy()).toBe(0);

    let copied!: () => void;
    copying.gate = new Promise((r) => (copied = r));
    try {
      const branching = orchestrator.branch(conv.id, agentMessages(conv)[0]!.id);
      await vi.waitFor(() => expect(orchestrator.busy()).toBe(1));
      copied();
      await branching;
    } finally {
      copying.gate = undefined;
    }
    expect(orchestrator.busy()).toBe(0);
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
    const worktrees = Object.values(conv.worktrees).flat().map((w) => w.path);

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

describe('asking the lead agent to change the team', () => {
  const draft = { agents, settings: { mode: 'roundtable', rounds: 1, maxHops: 5 } };
  const withTester = JSON.stringify({
    mode: 'relay',
    maxHops: 4,
    agents: [
      { name: 'Alice', provider: 'claude', role: 'Lead, hand off to @Tester.' },
      { name: 'Bob', provider: 'claude', role: '' },
      { name: 'Tester', provider: 'codex', role: 'Test it.' },
    ],
    reason: 'Added a tester.',
  });

  it("runs as the lead's account, with that account's defaults and what it leaves out", async () => {
    const home = join(root, `agents-${n}`);
    settings.setAgentHome(home);
    settings.updateAccount('claude', '', { defaultModel: 'opus', nativeOff: ['mcp'] });
    const work = settings.addAccount('claude', 'Work');
    settings.updateAccount('claude', work, { defaultModel: 'sonnet', defaultEffort: 'low', nativeOff: ['hooks'] });
    settings.setLead({ provider: 'claude', account: work });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    reviseReply = 'Done:\n```json\n' + withTester + '\n```';
    await orchestrator.reviseTeam(conv.id, { request: 'add a tester', ...draft });
    expect(calls.map((c) => [c.name, c.home, c.model, c.effort, c.nativeOff?.join()])).toEqual([
      ['reviser', join(home, `claude-${work}`), 'sonnet', 'low', 'hooks'],
    ]);
  });

  it('returns the changed team and changes nothing in the conversation', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'Fix the login bug');
    await finish(conv.id);
    calls = [];
    const before = { agents: structuredClone(conv.agents), settings: structuredClone(conv.settings), messages: conv.messages.length };
    reviseReply = 'Done:\n```json\n' + withTester + '\n```';

    const r = await orchestrator.reviseTeam(conv.id, { request: '  add a tester  ', ...draft });
    expect(calls.map((c) => c.name)).toEqual(['reviser']);
    expect(calls[0]!.prompt).toContain('<request>\nadd a tester\n</request>');
    expect(calls[0]!.prompt).toContain('[User]: Fix the login bug');
    expect(calls[0]!.prompt).toContain('The user is editing the team of this conversation');
    expect(r.reason).toBe('Added a tester.');
    expect(r.settings).toEqual({ mode: 'relay', rounds: 1, maxHops: 4 });
    // Alice and Bob stay (their ids, and with them their sessions); only claude is signed in here.
    expect(r.agents.map((a) => [a.id, a.name, a.provider])).toEqual([
      ['a', 'Alice', 'claude'],
      ['b', 'Bob', 'claude'],
      [r.agents[2]!.id, 'Tester', 'claude'],
    ]);
    expect(r.meta?.costUsd).toBe(0.02);
    // The drawer shows it until the user saves it.
    expect(conv.agents).toEqual(before.agents);
    expect(conv.settings).toEqual(before.settings);
    expect(conv.messages).toHaveLength(before.messages);
    expect(store.get(conv.id)!.agents).toEqual(before.agents);
  });

  it("changes the lead agent's design waiting for confirmation, which keeps waiting", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [];
    leadReply = JSON.stringify({ choice: 'custom', name: 'Pair', mode: 'roundtable', rounds: 1, agents: draft.agents, reason: 'Two.' });
    await orchestrator.send(conv.id, 'Plan the migration');
    await finish(conv.id);
    const plan = conv.messages.find((m) => m.plan)!;
    reviseReply = withTester;

    const r = await orchestrator.reviseTeam(conv.id, { request: 'add a tester', agents: plan.plan!.agents, settings: plan.plan!.settings });
    expect(calls.at(-1)!.prompt).toContain('reviewing the team you designed for their latest question');
    expect(calls.at(-1)!.prompt).toContain('[User]: Plan the migration');
    // Members who stay keep the ids the design gave them.
    expect(r.agents.slice(0, 2).map((a) => a.id)).toEqual(plan.plan!.agents!.slice(0, 2).map((a) => a.id));
    expect(plan.plan!.awaitingConfirmation).toBe(true);
    expect(conv.agents).toEqual([]);
  });

  it('refuses an empty request or team, and says why the lead agent could not change it', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await expect(orchestrator.reviseTeam(conv.id, { request: '   ', ...draft })).rejects.toMatchObject({ status: 400 });
    await expect(orchestrator.reviseTeam(conv.id, { request: 'x'.repeat(4001), ...draft })).rejects.toMatchObject({ status: 400 });
    await expect(orchestrator.reviseTeam(conv.id, { request: 'more', agents: [], settings: draft.settings })).rejects.toMatchObject({
      status: 400,
    });
    await expect(orchestrator.reviseTeam('nope', { request: 'more', ...draft })).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([]);

    reviseReply = 'Sorry, I cannot.';
    await expect(orchestrator.reviseTeam(conv.id, { request: 'more', ...draft })).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('首席 agent 沒能調整團隊'),
    });
    reviseReply = JSON.stringify({ agents: [{ name: 'Bad name', provider: 'nobody' }] });
    await expect(orchestrator.reviseTeam(conv.id, { request: 'more', ...draft })).rejects.toMatchObject({ status: 503 });
  });

  it('stops when the request goes away, when a newer one comes, and when the conversation is deleted', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    reviseGate = new Promise(() => {});
    reviseReply = withTester;

    const left = new AbortController();
    const first = orchestrator.reviseTeam(conv.id, { request: 'one', ...draft }, left.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(orchestrator.anyRunning()).toBe(true);
    left.abort();
    await expect(first).rejects.toMatchObject({ status: 409 });
    expect(orchestrator.anyRunning()).toBe(false);

    const older = orchestrator.reviseTeam(conv.id, { request: 'two', ...draft });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    const newer = orchestrator.reviseTeam(conv.id, { request: 'three', ...draft });
    await expect(older).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    const stopped = expect(newer).rejects.toMatchObject({ status: 409 });
    await orchestrator.deleteConversation(conv.id);
    await stopped;
    expect(orchestrator.anyRunning()).toBe(false);
  });
  it("reads the drawer's permission and folder, works in the saved folder, and the schedule's message only when it is on", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    reviseReply = withTester;
    await orchestrator.reviseTeam(conv.id, { request: 'more', agents, settings: { ...draft.settings, permission: 'full', cwd: '/not/saved/yet' } });
    expect(calls.at(-1)!.prompt).toContain('The file permission "full" and the working directory /not/saved/yet');
    expect(calls.at(-1)!.prompt).toContain(`you are running in the one saved now, ${project}.`);
    expect(calls.at(-1)!.cwd).toBe(project);
    // The saved folder spelled another way (a trailing slash) is not another folder.
    await orchestrator.reviseTeam(conv.id, { request: 'more', agents, settings: { ...draft.settings, cwd: `${project}/` } });
    expect(calls.at(-1)!.prompt).not.toContain('not saved that working directory');
    expect(calls.at(-1)!.prompt).not.toContain('<scheduled_message>');

    const schedule: ConversationSchedule = {
      text: '@Alice check the build',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: false,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: 0,
      nextRunAt: 0,
    } as ConversationSchedule;
    conv.schedule = schedule;
    await orchestrator.reviseTeam(conv.id, { request: 'more', ...draft });
    expect(calls.at(-1)!.prompt).not.toContain('<scheduled_message>');
    conv.schedule = { ...schedule, enabled: true };
    await orchestrator.reviseTeam(conv.id, { request: 'more', ...draft });
    expect(calls.at(-1)!.prompt).toContain('<scheduled_message>\n@Alice check the build\n</scheduled_message>');
  });

  it("tells the lead when the waiting design is the schedule's, and keeps a renamed member's id", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.messages.push({
      id: 'plan',
      author: { kind: 'system' },
      createdAt: 0,
      parts: [],
      status: 'done',
      plan: { status: 'ready', lead: { provider: 'claude' }, source: 'custom', agents, awaitingConfirmation: true, forSchedule: true },
    });
    conv.schedule = {
      text: '@Alice check the build',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: false,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: 0,
      nextRunAt: 0,
    } as ConversationSchedule;
    reviseReply = JSON.stringify({ agents: [{ name: 'Lead', provider: 'claude', was: 'Alice' }, { name: 'Bob', provider: 'claude' }], reason: 'Renamed.' });
    const r = await orchestrator.reviseTeam(conv.id, { request: 'rename Alice to Lead', ...draft });
    expect(calls.at(-1)!.prompt).toContain("designed for the conversation's schedule");
    // The design is for the schedule's message: shown although the schedule is off, which is said.
    expect(calls.at(-1)!.prompt).toContain('(the schedule is off now: it sends nothing until the user turns it on)');
    expect(calls.at(-1)!.prompt).toContain('<scheduled_message>\n@Alice check the build\n</scheduled_message>');
    expect(r.agents.map((a) => [a.id, a.name])).toEqual([
      ['a', 'Lead'],
      ['b', 'Bob'],
    ]);
  });

  it("keeps the team when the lead declines, refuses a drawer team with a bad name, and says when the lead's CLI fails", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    reviseReply = JSON.stringify({ reason: 'The permission is yours to set.' });
    const kept = await orchestrator.reviseTeam(conv.id, { request: 'give it full access', ...draft });
    expect(kept.agents.map((a) => a.id)).toEqual(['a', 'b']);
    expect(kept.reason).toBe('The permission is yours to set.');

    await expect(
      orchestrator.reviseTeam(conv.id, { request: 'more', agents: [{ id: 'a', name: 'Bad name', provider: 'claude', role: '' }], settings: draft.settings }),
    ).rejects.toMatchObject({ status: 400 });

    reviseFail = 'rate limited';
    await expect(orchestrator.reviseTeam(conv.id, { request: 'more', ...draft })).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('rate limited'),
    });
  });

  it("links the lead agent's session to the conversation in AgentsView", async () => {
    const links: string[] = [];
    orchestrator = new Orchestrator(
      store,
      new Hub(),
      settings,
      { context: async () => ({ available: ['claude'], catalog: [], presets: store.listPresets() }) },
      { schedule: () => undefined, link: (c: Conversation, provider: string, sessionId: string) => links.push(`${c.id} ${provider}:${sessionId}`) },
    );
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    reviseReply = withTester;
    await orchestrator.reviseTeam(conv.id, { request: 'more', ...draft });
    expect(links).toEqual([`${conv.id} claude:reviser-session`]);
  });

  it('waits for a replaced request until its lead process has ended, on delete too', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    reviseGate = new Promise(() => {});
    let exit!: () => void;
    reviseLinger = new Promise((r) => (exit = r));
    const older = orchestrator.reviseTeam(conv.id, { request: 'one', ...draft });
    const olderStopped = expect(older).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const newer = orchestrator.reviseTeam(conv.id, { request: 'two', ...draft });
    const newerStopped = expect(newer).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    // The newer one is stopped and ends at once; the older one's process is still ending.
    let deleted = false;
    const deleting = orchestrator.deleteConversation(conv.id).then(() => (deleted = true));
    await newerStopped;
    await new Promise((r) => setTimeout(r, 50));
    expect(deleted).toBe(false);
    expect(orchestrator.anyRunning()).toBe(true);
    exit();
    await deleting;
    await olderStopped;
    expect(orchestrator.anyRunning()).toBe(false);
  });

  it('stops on shutdown, which waits for it, and refuses new requests then', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    reviseGate = new Promise(() => {});
    let exit!: () => void;
    reviseLinger = new Promise((r) => (exit = r));
    const running = orchestrator.reviseTeam(conv.id, { request: 'one', ...draft });
    const stopped = expect(running).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    orchestrator.stopAll();
    // The lead's process is still ending: shutdown waits for it (within its time limit).
    let settled = false;
    const settling = orchestrator.settled(5_000).then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    exit();
    await settling;
    await stopped;
    expect(orchestrator.anyRunning()).toBe(false);
    await expect(orchestrator.reviseTeam(conv.id, { request: 'two', ...draft })).rejects.toMatchObject({ status: 503 });
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

  it('locks the directory by the confirmed team\'s mode once it answers', async () => {
    let release!: () => void;
    const plan = async (mode: string) => {
      const conv = conversation({ mode: 'roundtable', autoTeam: true });
      conv.agents = [];
      leadReply = teamIn(mode);
      await orchestrator.send(conv.id, 'Question');
      await finish(conv.id);
      gate = new Promise((r) => (release = r));
      orchestrator.confirmPlan(conv.id, conv.messages.find((m) => m.plan)!.id);
      return conv;
    };

    // Parallel: the agents write to their own worktrees, so the directory stays free.
    const parallel = await plan('parallel');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(parallel.id)).toHaveLength(2), { interval: 20 });
    const other = conversation({ mode: 'roundtable' });
    await orchestrator.send(other.id, 'go');
    release();
    await finish(parallel.id);
    await finish(other.id);
    await orchestrator.cleanupWorktrees(parallel);

    // Roundtable: the agents write to the directory itself.
    const shared = await plan('roundtable');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(shared.id)).toHaveLength(1), { interval: 20 });
    await expect(orchestrator.send(conversation({ mode: 'roundtable' }).id, 'go')).rejects.toThrow(/正在修改/);
    release();
    await finish(shared.id);
  });

  it('designs again for an edited question, with what came before it as history', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true });
    conv.agents = [];
    leadReply = teamIn('roundtable');
    await orchestrator.send(conv.id, 'First question');
    await vi.waitFor(() => expect(agentMessages(conv)).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    await orchestrator.send(conv.id, 'Second question');
    await vi.waitFor(() => expect(agentMessages(conv)).toHaveLength(4), { timeout: 20_000 });
    await finish(conv.id);

    calls = [];
    const second = conv.messages.filter((m) => m.author.kind === 'user')[1]!;
    await orchestrator.resend(conv.id, second.id, 'Second question, edited');
    await vi.waitFor(() => expect(agentMessages(conv)).toHaveLength(4), { timeout: 20_000 });
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice', 'Bob']);
    expect(calls[0]!.prompt).toContain('<question>\nSecond question, edited\n</question>');
    expect(calls[0]!.prompt).toContain('[User]: First question');
    expect(calls[0]!.prompt).not.toContain('Second question\n');
    expect(conv.messages.filter((m) => m.plan)).toHaveLength(2);
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

  it('refuses a request that comes after the turn ended without asking, and keeps no lock for it', async () => {
    // Like a network request the relay sandbox queued behind another one, put once the turn has ended.
    const reader = conversation({ mode: 'roundtable', permission: 'read-only' });
    reader.agents = [agents[0]!];
    keptAsk = undefined;
    await orchestrator.send(reader.id, 'keep asking');
    await finish(reader.id);
    expect(await keptAsk!({ kind: 'fetch', detail: 'github.com' })).toEqual({ allow: false });
    expect(agentMessages(reader)[0]!.parts.some((p) => p.type === 'approval')).toBe(false);
    expect(orchestrator.isWaiting(reader.id)).toBe(false);
    // Another conversation may write in the folder.
    const writer = conversation({ mode: 'roundtable' });
    writer.agents = [agents[0]!];
    await orchestrator.send(writer.id, 'go');
    await finish(writer.id);
    expect(agentMessages(writer)[0]).toMatchObject({ status: 'done' });
  }, 30_000);

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
    expect(alice.changes?.[0]?.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'shared.txt']);
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

  it('takes a branch made while its conversation was being sorted into the group it is sorted into', async () => {
    store.createGroup({ id: 'g1', name: 'Frontend' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    let release!: () => void;
    sorterGate = new Promise((r) => (release = r));
    sorterReply = '{"group": 1}';
    await orchestrator.send(conv.id, 'Fix the sidebar');
    await finish(conv.id);
    expect(orchestrator.isSorting(conv.id)).toBe(true);
    const branch = await orchestrator.branch(conv.id, agentMessages(conv).at(-1)!.id);
    expect(groupOf(branch.id)).toBeUndefined();
    release();
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(false));
    expect(groupOf(conv.id)).toBe('g1');
    expect(groupOf(branch.id)).toBe('g1');
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
      newChat: false,
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

  const approvalParts = (conv: Conversation) =>
    conv.messages.flatMap((m) => m.parts).filter((p) => p.type === 'approval') as Extract<
      Conversation['messages'][number]['parts'][number],
      { type: 'approval' }
    >[];

  it('refuses approvals in the runs it starts, except what the chat always allows, unless the schedule says to ask', async () => {
    const conv = solo();
    schedule(conv, { text: 'please install' });
    now = T0 + HOUR;
    await scheduler().tick();
    await finish(conv.id);
    // The agent is told in English; the card shows it in the schedule's language.
    expect(textOf(agentMessages(conv).at(-1)!)).toMatch(/^Alice skipped \(This run was started by a schedule and nobody may be watching/);
    expect(approvalParts(conv)[0]).toMatchObject({ status: 'denied', note: 'Refused automatically: nobody may be watching a scheduled run' });

    // What the user always allows in this chat goes through.
    conv.allowRules = [{ kind: 'command', key: 'npm install' }];
    store.saveMeta(conv);
    schedule(conv, { text: 'please install', nextRunAt: T0 + 2 * HOUR });
    now = T0 + 2 * HOUR;
    await scheduler().tick();
    await finish(conv.id);
    expect(textOf(agentMessages(conv).at(-1)!)).toBe('Alice installed');
    expect(approvalParts(conv)[1]).toMatchObject({ status: 'allowed', auto: true });
    conv.allowRules = undefined;
    store.saveMeta(conv);

    schedule(conv, { text: 'please install', approvals: 'ask', nextRunAt: T0 + 3 * HOUR });
    now = T0 + 3 * HOUR;
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
    expect(textOf(agentMessages(conv).at(-1)!)).toMatch(/^Bob skipped \(/);
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

    // With a team, auto team or not, the current team takes it: no design nobody could confirm.
    const withTeam = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true });
    schedule(withTeam, { nextRunAt: now });
    calls = [];
    asking = new Set();
    await scheduler().tick();
    await finish(withTeam.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(withTeam.messages.some((m) => m.plan)).toBe(false);
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

  const pendingPart = (conv: Conversation) =>
    conv.messages.flatMap((m) => m.parts).find((p) => p.type === 'approval' && p.status === 'pending') as { id: string } | undefined;
  const told = (name: string) => calls.filter((c) => c.name === name).map((c) => c.prompt.includes('You asked the user a question'));

  /** An agent asks while the scheduled message waits in the queue behind its turn. */
  async function questionWithScheduledWaiting(text: string) {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv, { text });
    asking = new Set(['Alice']);
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'which one?');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + HOUR;
    await scheduler().tick();
    expect(conv.schedule!.lastResult).toBe('queued');
    alice();
    await finish(conv.id);
    expect(conv.pause).toBeDefined();
    expect(conv.queue).toEqual([expect.objectContaining({ scheduled: true })]); // waits for the answer too
    return conv;
  }

  it("is no answer to an agent's question, and its @mentions do not make the team start afresh", async () => {
    const conv = await questionWithScheduledWaiting('@Bob daily report');
    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    // The answer goes first; the scheduled message waits for Bob's turn.
    expect(said(conv)).toEqual(['which one?', '@Alice', 'ANSWER: A', '@Alice', '@Bob daily report', '@Bob']);
    expect(told('Alice')).toEqual([false, true]); // told that the user replied
  });

  it("lets Continue skip the agent that asked, though a scheduled message goes out with it", async () => {
    const conv = await questionWithScheduledWaiting('daily report');
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(said(conv)).toEqual(['which one?', '@Alice', 'daily report', '@Bob']);
    expect(told('Alice')).toEqual([false]);
  });

  it('sends an earlier scheduled message left waiting after Stop at the next time, once', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + HOUR;
    await scheduler().tick();
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(conv.queue).toHaveLength(1); // kept after Stop

    gates = {};
    now = T0 + 2 * HOUR;
    await scheduler().tick();
    await finish(conv.id);
    expect(conv.queue).toEqual([]);
    expect(conv.messages.filter((m) => m.scheduled)).toHaveLength(1);
    expect(said(conv).slice(-3)).toEqual(['scheduled check', '@Alice', '@Bob']);
    expect(conv.schedule).toMatchObject({ lastResult: 'sent', nextRunAt: T0 + 3 * HOUR });
    expect(notes(conv).some((n) => n.includes('still waiting'))).toBe(false);
  });

  it('waits while another conversation writes in the same folder, and gives up after a while', async () => {
    const writer = conversation({ mode: 'roundtable', permission: 'edit' });
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    schedule(conv);
    hold('Alice');
    await orchestrator.send(writer.id, 'go'); // holds the folder
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));

    now = T0 + HOUR;
    await scheduler().tick();
    const s = scheduler();
    await s.tick();
    expect(conv.messages).toEqual([]); // nothing sent, nothing recorded yet: tried again later
    expect(conv.schedule).toMatchObject({ nextRunAt: T0 + HOUR });
    expect(conv.schedule!.lastResult).toBeUndefined();

    now = T0 + HOUR + MISSED_AFTER_MS + 1000;
    await s.tick(); // still busy, and late: tried again, not counted as missed
    expect(conv.schedule!.lastResult).toBeUndefined();

    now = T0 + HOUR + BUSY_RETRY_MS + 1000;
    await s.tick(); // given up
    expect(conv.schedule).toMatchObject({ lastResult: 'skipped', nextRunAt: T0 + 2 * HOUR });
    expect(conv.schedule!.lastError).toMatch(/is changing/);
    expect(notes(conv)).toHaveLength(1);
    expect(notes(conv)[0]).not.toMatch(/\.\.$/); // one full stop
    orchestrator.stop(writer.id);
    await finish(writer.id);
  });

  it('stays queued after an answer to a question the team was not asked as a whole, until the agent it is for speaks', async () => {
    for (const mode of ['roundtable', 'relay'] as const) {
      calls = [];
      const conv = conversation({ mode, permission: 'read-only' });
      schedule(conv, { text: '@Bob daily report', nextRunAt: now + HOUR });
      asking = new Set(['Alice']);
      const alice = hold('Alice');
      await orchestrator.send(conv.id, '@Alice which one?');
      await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
      const due = conv.schedule!.nextRunAt!;
      const was = now;
      now = due;
      await scheduler().tick();
      alice();
      await finish(conv.id);
      expect(conv.pause).toBeDefined();

      await orchestrator.send(conv.id, 'ANSWER: A');
      // The answer run ends with Alice; the scheduled message then gets a run of its own, for Bob.
      await vi.waitFor(() => expect(said(conv).at(-1)).toBe('@Bob'), { timeout: 20_000 });
      await finish(conv.id);
      expect(said(conv)).toEqual(['@Alice which one?', '@Alice', 'ANSWER: A', '@Alice', '@Bob daily report', '@Bob']);
      expect(conv.queue ?? []).toEqual([]);
      now = was;
      gates = {};
    }
  });

  /** An agent asks; meanwhile the schedule's message and then one the user wrote wait in the queue: [S, U]. */
  async function questionWithBothWaiting(question: string, text: string) {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv, { text });
    asking = new Set(['Alice']);
    const alice = hold('Alice');
    await orchestrator.send(conv.id, question);
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + HOUR;
    await scheduler().tick();
    expect(await orchestrator.send(conv.id, 'user note U')).toEqual({ queued: true });
    alice();
    await finish(conv.id);
    expect(conv.pause).toBeDefined();
    expect(conv.queue!.map((m) => (m.scheduled ? 'S' : 'U'))).toEqual(['S', 'U']);
    return conv;
  }

  it("sends the user's own message waiting behind a scheduled one with their answer, in the order written", async () => {
    const conv = await questionWithBothWaiting('which one?', 'daily report');
    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(said(conv)).toEqual(['which one?', '@Alice', 'user note U', 'ANSWER: A', 'daily report', '@Alice', '@Bob']);
    expect(told('Alice')).toEqual([false, true]);
    const answering = calls.filter((c) => c.name === 'Alice')[1]!.prompt;
    expect(answering.indexOf('user note U')).toBeLessThan(answering.indexOf('ANSWER: A'));
    expect(answering).toContain('one marked via="schedule" is not their reply');
  });

  it("counts the user's own waiting message as their reply on Continue, whatever waits ahead of it", async () => {
    const conv = await questionWithBothWaiting('which one?', 'daily report');
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(said(conv).slice(0, 5)).toEqual(['which one?', '@Alice', 'user note U', 'daily report', '@Alice']);
    expect(told('Alice')).toEqual([false, true]); // as without a schedule: the message the user wrote is the reply
  });

  it("gives the agent that asked the user's own waiting message, while a scheduled one for another agent waits for it", async () => {
    const conv = await questionWithBothWaiting('@Alice which one?', '@Bob daily report');
    await orchestrator.send(conv.id, 'ANSWER: A');
    await vi.waitFor(() => expect(said(conv).at(-1)).toBe('@Bob'), { timeout: 20_000 });
    await finish(conv.id);
    expect(said(conv)).toEqual(['@Alice which one?', '@Alice', 'user note U', 'ANSWER: A', '@Alice', '@Bob daily report', '@Bob']);
    expect(calls.filter((c) => c.name === 'Alice')[1]!.prompt).toContain('user note U');
  });

  it('holds a new time back while a question waits and the earlier scheduled message waits with it', async () => {
    const conv = await questionWithScheduledWaiting('daily report');
    now = T0 + 2 * HOUR;
    await scheduler().tick();
    expect(conv.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the team is waiting for your answer' });
    expect(orchestrator.isRunning(conv.id)).toBe(false);
    expect(conv.queue).toHaveLength(1);
  });

  it('retries a time that is already late when the conversation is busy, and sends it once free', async () => {
    const writer = conversation({ mode: 'roundtable', permission: 'edit' });
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    schedule(conv, { missed: 'run' });
    const alice = hold('Alice');
    await orchestrator.send(writer.id, 'go');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + HOUR + 3 * MISSED_AFTER_MS; // the server was off; the folder is taken
    const s = scheduler();
    await s.tick();
    expect(conv.schedule!.lastResult).toBeUndefined();
    // Something the user sends meanwhile is not left in a queue nobody runs.
    await expect(orchestrator.send(conv.id, 'hello')).rejects.toThrow(/正在修改|is changing/);
    expect(conv.queue ?? []).toEqual([]);

    alice();
    await finish(writer.id);
    now += 60_000;
    await s.tick();
    await finish(conv.id);
    expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: T0 + HOUR });
  });

  it('refuses without asking in a conversation that refuses automatically', async () => {
    const conv = solo({ approvals: 'deny' });
    schedule(conv, { text: 'please install', approvals: 'ask' });
    now = T0 + HOUR;
    await scheduler().tick();
    await finish(conv.id);
    expect(textOf(agentMessages(conv).at(-1)!)).toBe('Alice not asked');
    expect(approvalParts(conv)).toEqual([]);
  });

  it('asks for approvals again once the user writes into a scheduled run in parallel mode', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', rounds: 2 });
    schedule(conv);
    const alice = hold('Alice');
    const bob = hold('Bob');
    now = T0 + HOUR;
    await scheduler().tick();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(await orchestrator.send(conv.id, 'please install')).toEqual({ queued: true });
    alice();
    bob();
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true)); // round 2 asks
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(approvalParts(conv).every((p) => p.status !== 'denied')).toBe(true);
  });

  it('asks for approvals again once the user writes into a scheduled run', async () => {
    const conv = solo({ rounds: 2 });
    schedule(conv);
    const alice = hold('Alice');
    now = T0 + HOUR;
    await scheduler().tick();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await orchestrator.send(conv.id, 'please install')).toEqual({ queued: true });
    alice();
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true)); // asked, not refused
    orchestrator.answerApproval(conv.id, pendingPart(conv)!.id, { allow: true });
    await finish(conv.id);
    expect(textOf(agentMessages(conv).at(-1)!)).toBe('Alice installed');
  });

  it("asks when a scheduled send also delivers the user's own waiting message", async () => {
    const conv = solo();
    schedule(conv);
    hold('Alice');
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await orchestrator.send(conv.id, 'please install');
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(conv.queue).toHaveLength(1); // the user's, kept after Stop

    gates = {};
    now = T0 + HOUR;
    await scheduler().tick();
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    expect(said(conv).slice(-3)).toEqual(['please install', 'scheduled check', '@Alice']);
    orchestrator.stop(conv.id);
    await finish(conv.id);
  });

  it('records nothing when the server stops while it sends, so the time is still due', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    now = T0 + HOUR;
    const s = scheduler();
    const looking = s.tick();
    s.stop();
    orchestrator.stopAll();
    await looking;
    expect(conv.messages).toEqual([]);
    expect(conv.schedule).toMatchObject({ nextRunAt: T0 + HOUR });
    expect(conv.schedule!.lastResult).toBeUndefined();
    expect(store.dueSchedules(now)).toEqual([conv.id]);
  });

  it('tries again when a settings change holds the conversation', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    now = T0 + HOUR;
    await scheduler().tick();
    expect(conv.messages).toEqual([]);
    expect(conv.schedule!.lastResult).toBeUndefined();
    release();
    await held;
    await scheduler().tick();
    await finish(conv.id);
    expect(conv.schedule).toMatchObject({ lastResult: 'sent', nextRunAt: T0 + 2 * HOUR });
  });

  it('leaves a schedule replaced while its message was being sent as it is', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    now = T0 + HOUR;
    const looking = scheduler().tick();
    const replaced = { ...conv.schedule!, text: 'new text', nextRunAt: T0 + 5 * HOUR };
    conv.schedule = replaced;
    await looking;
    await finish(conv.id);
    expect(conv.schedule).toBe(replaced);
    expect(said(conv)[0]).toBe('scheduled check'); // what was due went out
  });

  it('sends a repeating schedule once after several missed times, when it says to', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    const nine = Date.UTC(2026, 0, 5, 9, 0);
    schedule(conv, { repeat: { kind: 'daily', time: '09:00' }, nextRunAt: nine, missed: 'run' });
    now = nine + 3 * 24 * HOUR + HOUR;
    await scheduler().tick();
    await finish(conv.id);
    await scheduler().tick();
    expect(conv.messages.filter((m) => m.scheduled)).toHaveLength(1);
    expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: nine, nextRunAt: nine + 4 * 24 * HOUR });
  });

  it('drops a stored schedule it cannot read', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    db.prepare("UPDATE schedules SET repeat = 'not json' WHERE conversation_id = ?").run(conv.id);
    store = new Store(db);
    orchestrator = new Orchestrator(store, new Hub(), settings);
    now = T0 + HOUR;
    await scheduler().tick();
    expect(store.dueSchedules(now)).toEqual([]);
    expect(store.get(conv.id)!.schedule).toBeUndefined();
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

  describe('a team the lead agent designs for a schedule', () => {
    const pair = JSON.stringify({
      choice: 'custom',
      name: 'Report pair',
      description: 'Write it, then check it',
      mode: 'roundtable',
      rounds: 1,
      agents: [
        { name: 'Alice', provider: 'claude', role: 'Write the report.' },
        { name: 'Bob', provider: 'claude', role: 'Check it.' },
      ],
      reason: 'One writes, one checks.',
    });
    /** A conversation made for a schedule (New schedule): auto team, no team yet. */
    const forSchedule = (s: Partial<ConversationSchedule> = {}, settings: Partial<ConversationSettings> = {}) => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, ...settings });
      conv.agents = [];
      store.saveMeta(conv);
      schedule(conv, { text: 'Weekly report', ...s });
      leadReply = pair;
      return conv;
    };
    const planOf = (conv: Conversation) => conv.messages.find((m) => m.plan)!;

    it('designs the team for the message, which nobody posts, and runs nothing once it is confirmed', async () => {
      const conv = forSchedule({ newChat: true });
      await orchestrator.designForSchedule(conv.id);
      await finish(conv.id);
      expect(calls.map((c) => c.name)).toEqual(['lead']);
      expect(calls[0]!.prompt).toContain('The user is setting up a schedule');
      expect(calls[0]!.prompt).toContain('each time in a new conversation');
      expect(calls[0]!.prompt).toContain('The scheduled message:\n<question>\nWeekly report\n</question>');
      expect(conv.messages.map((m) => m.author.kind)).toEqual(['system']); // only the team's card
      expect(planOf(conv).plan).toMatchObject({ status: 'ready', forSchedule: true, awaitingConfirmation: true });

      orchestrator.confirmPlan(conv.id, planOf(conv).id);
      expect(conv.agents.map((a) => a.name)).toEqual(['Alice', 'Bob']);
      expect(orchestrator.isRunning(conv.id)).toBe(false);
      expect(calls.map((c) => c.name)).toEqual(['lead']);
      expect(new Store(db).get(conv.id)!.messages[0]!.plan!.forSchedule).toBe(true);

      // When it comes due, that team gets the message, in a new chat.
      now = T0 + HOUR;
      await scheduler().tick();
      const chat = store.get(conv.schedule!.lastChatId!)!;
      await finish(chat.id);
      expect(said(chat)).toEqual(['note', 'Weekly report', '@Alice', '@Bob']);
      expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice', 'Bob']);
    });

    it('uses the team at once when asked to, still running nothing, and answers what the user wrote while it waited', async () => {
      const auto = forSchedule({}, { autoConfirm: true });
      await orchestrator.designForSchedule(auto.id);
      await finish(auto.id);
      expect(planOf(auto).plan).toMatchObject({ forSchedule: true, autoConfirmed: true });
      expect(auto.agents.map((a) => a.name)).toEqual(['Alice', 'Bob']);
      expect(calls.map((c) => c.name)).toEqual(['lead']);
      expect(calls[0]!.prompt).toContain('each time in this conversation');

      calls = [];
      const asks = forSchedule();
      await orchestrator.designForSchedule(asks.id);
      await finish(asks.id);
      expect(await orchestrator.send(asks.id, 'Use last week as the template')).toEqual({ queued: true });
      orchestrator.confirmPlan(asks.id, planOf(asks).id);
      await vi.waitFor(() => expect(agentMessages(asks).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
      await finish(asks.id);
      expect(said(asks).slice(1)).toEqual(['Use last week as the template', '@Alice', '@Bob']);
    });

    it('designs for a later question in that chat as usual', async () => {
      const conv = forSchedule();
      await orchestrator.designForSchedule(conv.id);
      await finish(conv.id);
      orchestrator.confirmPlan(conv.id, planOf(conv).id);
      calls = [];
      await orchestrator.send(conv.id, 'Also compare with last month');
      await finish(conv.id);
      expect(calls.map((c) => c.name)).toEqual(['lead']);
      expect(calls[0]!.prompt).toContain('The user asked a new question in this conversation.');
      expect(calls[0]!.prompt).toContain('<question>\nAlso compare with last month\n</question>');
      expect(conv.messages.filter((m) => m.plan).at(-1)!.plan!.forSchedule).toBeUndefined();
    });

    it('tells an open chat when the chat its schedule last opened is deleted', async () => {
      const hub = new Hub();
      orchestrator = new Orchestrator(store, hub, settings);
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      schedule(conv, { newChat: true });
      now = T0 + HOUR;
      await scheduler().tick();
      const chatId = conv.schedule!.lastChatId!;
      await finish(chatId);
      const events: { type: string; schedule?: unknown }[] = [];
      hub.subscribe(conv.id, (e) => events.push(e as never));
      await orchestrator.deleteConversation(chatId);
      expect(events).toEqual([expect.objectContaining({ type: 'conversation', schedule: expect.not.objectContaining({ lastChatId: chatId }) })]);
    });

    it('runs nothing either when the user sets the team by hand instead', async () => {
      const conv = forSchedule();
      await orchestrator.designForSchedule(conv.id);
      await finish(conv.id);
      conv.agents = [agents[0]!];
      expect(orchestrator.confirmPendingPlan(conv)).toBe(true);
      expect(orchestrator.startConfirmed(conv)).toBe(false);
      expect(orchestrator.isRunning(conv.id)).toBe(false);
    });

    it('keeps a time that comes due while the team is designed or waits, and sends it once the team is confirmed', async () => {
      const conv = forSchedule({ repeat: { kind: 'once', at: T0 + HOUR } });
      let release!: () => void;
      leadGate = new Promise((r) => (release = r));
      await orchestrator.designForSchedule(conv.id);
      expect(conv.messages.find((m) => m.plan)!.plan).toMatchObject({ status: 'planning', forSchedule: true });
      now = T0 + HOUR;
      const s = scheduler();
      await s.tick(); // the lead agent is still designing
      expect(conv.schedule).toMatchObject({ enabled: true, nextRunAt: T0 + HOUR });
      expect(conv.schedule!.lastResult).toBeUndefined();
      release();
      await finish(conv.id);
      now += 60_000;
      await s.tick(); // the team waits for confirmation
      expect(conv.schedule!.lastResult).toBeUndefined();

      orchestrator.confirmPlan(conv.id, planOf(conv).id);
      now += 60_000;
      await s.tick();
      await finish(conv.id);
      expect(said(conv).slice(-3)).toEqual(['Weekly report', '@Alice', '@Bob']);
      expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: T0 + HOUR, enabled: false }); // the one time went out
    });

    it('gives up on a time after a while when nobody confirms the team, and refuses what it cannot design for', async () => {
      const conv = forSchedule();
      await orchestrator.designForSchedule(conv.id);
      await finish(conv.id);
      now = T0 + HOUR;
      const s = scheduler();
      await s.tick();
      now = T0 + HOUR + BUSY_RETRY_MS + 1000;
      await s.tick();
      expect(conv.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the team is not confirmed yet', nextRunAt: T0 + 2 * HOUR });
      await expect(orchestrator.designForSchedule(conv.id)).rejects.toThrow(/確認/); // a design waits already
      orchestrator.confirmPlan(conv.id, planOf(conv).id);
      await expect(orchestrator.designForSchedule(conv.id)).rejects.toThrow(/已經有團隊/); // and then it has a team

      const none = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true });
      await expect(orchestrator.designForSchedule(none.id)).rejects.toThrow(/沒有排程/);
      const fixed = conversation({ mode: 'roundtable', permission: 'read-only' });
      schedule(fixed);
      await expect(orchestrator.designForSchedule(fixed.id)).rejects.toThrow(/首席 agent/);
    });
  });

  describe('opening a new chat each time', () => {
    /** The conversations the schedule of `conv` opened. */
    const opened = (conv: Conversation) =>
      store
        .list(() => false)
        .filter((c) => c.id !== conv.id)
        .map((c) => store.get(c.id)!);

    it('opens a new chat with the same team, settings, "always allow" answers and group, and sends the message there', async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      conv.allowRules = [{ kind: 'command', key: 'npm install' }];
      store.saveMeta(conv);
      store.createGroup({ id: 'g1', name: 'Ops' });
      store.moveToGroup(conv.id, 'g1');
      schedule(conv, { newChat: true });
      now = T0 + HOUR;
      await scheduler().tick();
      const [chat] = opened(conv);
      expect(chat).toBeDefined();
      await finish(chat!.id);

      expect(conv.messages).toEqual([]); // nothing in the schedule's own chat
      expect(chat!.title).toBe(`test · ${scheduleTime(T0 + HOUR, conv.schedule!)}`);
      expect(chat!.agents).toEqual(conv.agents);
      expect(chat!.agents).not.toBe(conv.agents);
      expect(chat!.settings).toEqual(conv.settings);
      expect(chat!.allowRules).toEqual(conv.allowRules);
      expect(chat!.schedule).toBeUndefined();
      expect(said(chat!)).toEqual(['note', 'scheduled check', '@Alice', '@Bob']);
      expect(notes(chat!)[0]).toBe('The schedule of "test" opened this conversation to send its message here.');
      expect(chat!.messages[1]!.scheduled).toBe(true);
      // In the group of the schedule's chat, as the user put it: the lead agent does not sort it.
      expect(store.groupOf(chat!.id)).toBe('g1');
      expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
      expect(calls[0]!.prompt).toContain('<message from="user" via="schedule">');
      expect(calls[0]!.systemPrompt).toContain('A user message marked via="schedule" was sent automatically');
      expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: T0 + HOUR, lastChatId: chat!.id, nextRunAt: T0 + 2 * HOUR });
      expect(new Store(db).get(conv.id)!.schedule!.lastChatId).toBe(chat!.id);
      expect(new Store(db).get(chat!.id)!.messages.map((m) => m.author.kind)).toEqual(['system', 'user', 'agent', 'agent']);

      // The next time opens another one, where the agents start new sessions.
      now = T0 + 2 * HOUR;
      await scheduler().tick();
      const second = opened(conv).find((c) => c.id !== chat!.id)!;
      await finish(second.id);
      expect(opened(conv)).toHaveLength(2);
      expect(said(second)).toEqual(['note', 'scheduled check', '@Alice', '@Bob']);
      expect(calls.slice(2).map((c) => c.sessionId)).toEqual([undefined, undefined]);
      expect(conv.schedule!.lastChatId).toBe(second.id);
      expect(conv.messages).toEqual([]);
    });

    it('refuses approvals there too, unless the schedule says to ask, and asks once the user writes in it', async () => {
      const conv = solo();
      schedule(conv, { text: 'please install', newChat: true });
      now = T0 + HOUR;
      await scheduler().tick();
      const chat = store.get(conv.schedule!.lastChatId!)!;
      await finish(chat.id);
      expect(textOf(agentMessages(chat).at(-1)!)).toMatch(/^Alice skipped \(This run was started by a schedule and nobody may be watching/);
      expect(approvalParts(chat)[0]).toMatchObject({ status: 'denied', note: 'Refused automatically: nobody may be watching a scheduled run' });
      expect(calls[0]!.systemPrompt).toContain('refused automatically');

      // The user writes in the new chat: they are here, so the run asks.
      await orchestrator.send(chat.id, 'please install');
      await vi.waitFor(() => expect(orchestrator.isWaiting(chat.id)).toBe(true));
      expect(calls.at(-1)!.systemPrompt).toContain('A user message marked via="schedule" was sent automatically');
      expect(calls.at(-1)!.systemPrompt).not.toContain('refused automatically');
      orchestrator.stop(chat.id);
      await finish(chat.id);

      schedule(conv, { text: 'please install', newChat: true, approvals: 'ask', nextRunAt: T0 + 2 * HOUR });
      now = T0 + 2 * HOUR;
      await scheduler().tick();
      const asks = store.get(conv.schedule!.lastChatId!)!;
      expect(asks.id).not.toBe(chat.id);
      await vi.waitFor(() => expect(orchestrator.isWaiting(asks.id)).toBe(true));
      orchestrator.answerApproval(asks.id, pendingPart(asks)!.id, { allow: true });
      await finish(asks.id);
      expect(textOf(agentMessages(asks).at(-1)!)).toBe('Alice installed');
    });

    it("goes ahead whatever this conversation is doing: waiting for the user's answer, or replying", async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      schedule(conv, { newChat: true });
      asking = new Set(['Alice']);
      await orchestrator.send(conv.id, 'which one?');
      await finish(conv.id);
      expect(conv.pause).toBeDefined();
      asking = new Set();

      now = T0 + HOUR;
      await scheduler().tick();
      const chat = store.get(conv.schedule!.lastChatId!)!;
      await finish(chat.id);
      expect(said(chat)).toEqual(['note', 'scheduled check', '@Alice', '@Bob']);
      // This conversation still waits for the answer, with nothing taken for it or queued.
      expect(said(conv)).toEqual(['which one?', '@Alice']);
      expect(conv.pause).toBeDefined();
      expect(conv.queue ?? []).toEqual([]);

      const alice = hold('Alice');
      await orchestrator.send(conv.id, 'ANSWER: A');
      await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(true));
      now = T0 + 2 * HOUR;
      await scheduler().tick();
      expect(conv.schedule).toMatchObject({ lastResult: 'sent', nextRunAt: T0 + 3 * HOUR });
      expect(conv.queue ?? []).toEqual([]);
      alice();
      await finish(conv.id);
      await finish(conv.schedule!.lastChatId!);
    });

    it('waits while this or another conversation writes in the same folder, and leaves no chat behind', async () => {
      const conv = solo({ permission: 'edit' });
      schedule(conv, { newChat: true });
      const alice = hold('Alice');
      await orchestrator.send(conv.id, 'go'); // this conversation writes in the folder
      await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));

      now = T0 + HOUR;
      const s = scheduler();
      await s.tick();
      expect(opened(conv)).toEqual([]);
      expect(conv.schedule!.lastResult).toBeUndefined(); // tried again at the next look

      alice();
      await finish(conv.id);
      now += 60_000;
      await s.tick();
      const chat = store.get(conv.schedule!.lastChatId!)!;
      await finish(chat.id);
      expect(said(chat)).toEqual(['note', 'scheduled check', '@Alice']);
      expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: T0 + HOUR });
      expect(chat.title).toBe(`test · ${scheduleTime(T0 + HOUR, conv.schedule!)}`); // the time it came due, not when it went out
    });

    it('removes a chat whose run could not start after all: the server began to stop meanwhile', async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      schedule(conv, { newChat: true });
      const sending = orchestrator.sendScheduled(conv.id);
      orchestrator.stopAll();
      expect(await sending).toEqual({ result: 'busy', reason: expect.any(String) });
      expect(opened(conv)).toEqual([]);
      expect(calls).toEqual([]);
    });

    it('keeps a chat opened from a conversation in Other there, unsorted, and gives parallel teams worktrees of its own', async () => {
      const conv = conversation({ mode: 'parallel', permission: 'edit' });
      store.createGroup({ id: 'g1', name: 'Ops' }); // there are groups, but the conversation is in Other
      schedule(conv, { newChat: true });
      const sent = await orchestrator.sendScheduled(conv.id);
      const chat = store.get((sent as { chatId: string }).chatId)!;
      await finish(chat.id);
      expect(store.groupOf(chat.id)).toBeNull();
      expect(store.isSorted(chat.id)).toBe(true);
      expect(calls.map((c) => c.name).sort()).toEqual(['Alice', 'Bob']); // no sorter
      expect(Object.keys(chat.worktrees).sort()).toEqual(['a', 'b']);
      expect(Object.values(chat.worktrees).flat().every((w) => w.branch.startsWith(`relay/${chat.id.slice(0, 8)}/`))).toBe(true);
      expect(conv.worktrees).toEqual({});
    });

    it('names the chats after the message while the schedule\'s conversation has no name, and forgets a chat that is deleted', async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      conv.title = 'New chat';
      store.saveMeta(conv);
      schedule(conv, { newChat: true, text: 'Weekly report\nwith the numbers' });
      now = T0 + HOUR;
      await scheduler().tick();
      const chatId = conv.schedule!.lastChatId!;
      await finish(chatId);
      expect(store.get(chatId)!.title).toBe(`Weekly report · ${scheduleTime(T0 + HOUR, conv.schedule!)}`);

      await orchestrator.deleteConversation(chatId);
      expect(conv.schedule!.lastChatId).toBeUndefined();
      expect(conv.schedule!.lastResult).toBe('sent');
      expect(new Store(db).get(conv.id)!.schedule!.lastChatId).toBeUndefined();
    });

    it('opens no chat without a confirmed team, removes one whose run cannot start, and forgets the last chat then', async () => {
      const auto = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true });
      auto.agents = [];
      store.saveMeta(auto);
      schedule(auto, { newChat: true });
      now = T0 + HOUR;
      await scheduler().tick();
      expect(auto.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the team is not confirmed yet' });

      const gone = conversation({ mode: 'roundtable', permission: 'edit', cwd: join(project, 'gone') });
      schedule(gone, { newChat: true, lastResult: 'sent', lastChatId: 'earlier-chat' });
      await scheduler().tick();
      expect(gone.schedule).toMatchObject({ lastResult: 'failed', nextRunAt: T0 + 2 * HOUR });
      expect(gone.schedule!.lastChatId).toBeUndefined();
      expect(notes(gone).at(-1)).toMatch(/could not be sent/);
      expect(store.list(() => false).map((c) => c.id).sort()).toEqual([auto.id, gone.id].sort());
      expect(calls).toEqual([]);
    });

    it('says which chat "Run now" opened, and leaves what the schedule recorded alone', async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      schedule(conv, { newChat: true });
      const sent = await orchestrator.sendScheduled(conv.id);
      expect(sent).toEqual({ result: 'sent', chatId: expect.any(String) });
      const chat = store.get((sent as { chatId: string }).chatId)!;
      await finish(chat.id);
      expect(said(chat)).toEqual(['note', 'scheduled check', '@Alice', '@Bob']);
      expect(conv.schedule!.lastChatId).toBeUndefined();
      expect(conv.schedule!.lastResult).toBeUndefined();
    });
  });
});
