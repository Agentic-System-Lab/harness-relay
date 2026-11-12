/*
 * Runs of a team with the fake CLI: what each agent is given (accounts and their defaults, what a
 * CLI loads by itself, attached files) and what AgentsView is told, tool calls, approvals, retrying
 * and editing, failed turns, requests that come while a run is under way, messages sent while the team
 * replies, agents asking the user, and deleting or shutting down while agents work.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationSettings } from '../src/shared/types';
import { agentMessages, agents, attachmentPath, attachmentsDir, calls, conversation, copying, db, fake, finish, Hub, n, orchestrator, Orchestrator, root, runners, safeFileName, setOrchestrator, settings, stateFolder, stateKeys, store, Store, textOf, withLang } from './orchestrator-harness';

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
    setOrchestrator(new Orchestrator(store, new Hub(), settings, undefined, traces));
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    expect(traces.told.map((x) => x.id)).toEqual([conv.id, conv.id, conv.id]);
    expect(traces.told[0]).toMatchObject({ sessions: ['session-Alice'], replies: 1 });
    expect(traces.told[2]).toMatchObject({ sessions: ['session-Alice', 'session-Bob'], replies: 2 });
  });

  it("links the lead agent's and the group sorter's sessions to the conversation", async () => {
    const traces = sink();
    setOrchestrator(new Orchestrator(
      store,
      new Hub(),
      settings,
      { context: async () => ({ available: ['claude'], catalog: [], presets: store.listPresets() }) },
      traces,
    ));
    store.createGroup({ id: 'g1', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    fake.leadReply = '{"template": "general-panel", "reason": "fits"}';
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
    setOrchestrator(new Orchestrator(store, new Hub(), settings, undefined, traces));
    store.createGroup({ id: 'g1', name: 'Docs' });
    let release!: () => void;
    fake.sorterGate = new Promise((r) => (release = r));
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', rounds: 1 });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(events).not.toContain('link claude:sorter-session');
    release();
    await orchestrator.settled(5000);
    expect(events.slice(-2)).toEqual(['link claude:sorter-session', 'schedule']);
  });

  it('is not told about a conversation deleted while it replies, only to forget it', async () => {
    fake.gate = new Promise(() => {}); // the agents only finish when stopped
    const traces = sink();
    setOrchestrator(new Orchestrator(store, new Hub(), settings, undefined, traces));
    const conv = conversation({ mode: 'parallel', permission: 'read-only' });
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(true));
    await orchestrator.deleteConversation(conv.id);
    expect(traces.told).toEqual([]);
    expect(traces.forgotten).toEqual([conv.id]);
  });

  it('keeps the run whole when telling fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setOrchestrator(new Orchestrator(store, new Hub(), settings, undefined, {
      schedule: () => {
        throw new Error('sink broke');
      },
    }));
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
    fake.leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
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
      fake.leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
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
    setOrchestrator(new Orchestrator(store, new Hub(), settings, {
      context: async () => ({ available: ['claude', 'opencode', 'goose'], catalog: [], presets: store.listPresets() }),
      defaultModel: async () => 'openai/gpt-5.4-nano',
    }));
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

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('does not run an open agent whose state folder could not be emptied, and empties it at the next turn', async () => {
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
    fake.leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
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
    setOrchestrator(new Orchestrator(store, new Hub(), settings, {
      context: async () => ({ available: ['claude', 'opencode'], catalog: [], presets: store.listPresets() }),
      defaultModel: async (p) => {
        asked.push(p);
        return 'openai/gpt-5.4-nano';
      },
    }));
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
    calls.length = 0;
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
    fake.gate = new Promise((r) => (release = r));
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
    calls.length = 0;
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
    calls.length = 0;
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
      calls.length = 0;
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
    setOrchestrator(new Orchestrator(store, new Hub(), settings, {
      context: async () => ({ available: ['claude'], accounts: { claude: [work] }, catalog: [], presets: store.listPresets() }),
    }));
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [];
    fake.leadReply = JSON.stringify({ choice: 'custom', name: 'Pair', mode: 'roundtable', rounds: 1, agents: [{ name: 'Ann', provider: 'claude', role: 'r' }], reason: 'x' });
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
    fake.leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
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

    calls.length = 0;
    await orchestrator.retry(conv.id, alice!.id);
    await finish(conv.id);
    expect(calls.map((c) => [c.name, c.sessionId])).toEqual([
      ['Alice', undefined],
      ['Bob', undefined],
    ]);
    expect(agentMessages(conv).map((m) => m.agentName)).toEqual(['Alice', 'Bob']);
    expect(conv.messages.some((m) => m.id === alice!.id || m.id === bob!.id)).toBe(false);

    calls.length = 0;
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
    calls.length = 0;
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
    fake.asking = new Set(['Alice']);
    await orchestrator.send(asks.id, 'question');
    await finish(asks.id);
    expect(asks.pause).toBeDefined();
    expect(orchestrator.busy()).toBe(0);
    fake.asking = new Set();

    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
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

    fake.reviseGate = new Promise(() => {});
    const left = new AbortController();
    const revising = orchestrator.reviseTeam(conv.id, { request: 'add a tester', agents: conv.agents, settings: { mode: 'roundtable', rounds: 1, maxHops: 5 } }, left.signal);
    await vi.waitFor(() => expect(orchestrator.busy()).toBe(1));
    left.abort();
    await expect(revising).rejects.toMatchObject({ status: 409 });
    expect(orchestrator.busy()).toBe(0);

    store.createGroup({ id: 'g1', name: 'Docs' });
    let sorted!: () => void;
    fake.sorterGate = new Promise((r) => (sorted = r));
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
    fake.gate = new Promise(() => {}); // the agents only finish when stopped
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

describe('failed turns', () => {
  it('keeps an agent\'s session when starting it fresh fails for the same reason', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.agents = [agents[0]!];
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    expect(conv.agentState.a!.sessionId).toBe('session-Alice');

    fake.fail = () => new Error('rate limited'); // not a session problem: the fresh session fails too
    calls.length = 0;
    await orchestrator.send(conv.id, 'second');
    await finish(conv.id);
    expect(calls.map((c) => c.sessionId)).toEqual(['session-Alice', undefined]);
    expect(agentMessages(conv).at(-1)).toMatchObject({ status: 'error', error: 'rate limited' });
    expect(conv.agentState.a!.sessionId).toBe('session-Alice');

    fake.fail = undefined;
    calls.length = 0;
    await orchestrator.send(conv.id, 'third');
    await finish(conv.id);
    expect(calls[0]!.sessionId).toBe('session-Alice');
    // The messages it missed are offered again.
    expect(calls[0]!.prompt).toContain('second');
  });

  it('tells teammates which files a failed turn changed', async () => {
    const conv = conversation({ mode: 'roundtable' });
    fake.fail = (name) => (name === 'Alice' ? new Error('crashed') : undefined);
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const bob = calls.find((c) => c.name === 'Bob')!.prompt;
    expect(bob).toMatch(/<message from="@Alice"[^>]* status="failed">/);
    expect(bob).toMatch(/<changed_files>[\s\S]*A Alice\.txt/);

    // Alice had no session (her first turn failed), so she starts fresh and is shown her failed reply too.
    fake.fail = undefined;
    calls.length = 0;
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(calls.find((c) => c.name === 'Alice')!.prompt).toMatch(/<message from="@Alice"[^>]* status="failed">/);
  });

  it("does not send an agent its own stopped reply when its session holds it", async () => {
    const conv = conversation({ mode: 'roundtable' });
    conv.agents = [agents[0]!];
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    fake.gate = new Promise(() => {}); // the next turn only ends when stopped
    await orchestrator.send(conv.id, 'second');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toHaveLength(1));
    orchestrator.stop(conv.id);
    await finish(conv.id);
    fake.gate = Promise.resolve();
    calls.length = 0;
    await orchestrator.send(conv.id, 'third');
    await finish(conv.id);
    expect(calls[0]!.sessionId).toBe('session-Alice');
    expect(calls[0]!.prompt).not.toContain('from="@Alice"');
    expect(calls[0]!.prompt).toContain('second'); // not delivered when it was stopped
  });

  it('keeps a parallel run going while a teammate still works, when saving one turn fails', async () => {
    const conv = conversation({ mode: 'parallel' });
    let releaseBob!: () => void;
    fake.gates.Bob = new Promise((r) => (releaseBob = r));
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
    fake.keptAsk = undefined;
    await orchestrator.send(reader.id, 'keep asking');
    await finish(reader.id);
    expect(await fake.keptAsk!({ kind: 'fetch', detail: 'github.com' })).toEqual({ allow: false });
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

describe('messages sent while the team replies', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const roundtable = (rounds = 1) => conversation({ mode: 'roundtable', permission: 'read-only', rounds });
  /** The chat as a list: what the user said, who replied, and notes. */
  const said = (conv: Conversation) =>
    conv.messages.map((m) => (m.author.kind === 'user' ? textOf(m) : m.author.kind === 'agent' ? `@${m.agentName}` : 'note'));
  /** Make an agent wait in its turn; returns the function that lets it finish. */
  const hold = (name: string) => {
    let release!: () => void;
    fake.gates[name] = new Promise((r) => (release = r));
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
    fake.gate = new Promise((r) => (release = r));
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
    fake.gate = new Promise((r) => (release = r));
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
    fake.asking = new Set(['Alice']);
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
    fake.asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(said(conv)).toEqual(['question', '@Alice', '@Bob']);
    expect(conv.pause).toBeUndefined();
  });

  it('start afresh when the reply is for someone else', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    await orchestrator.send(conv.id, '@Alice ANSWER: A'); // addressed to the one that asked: still an answer
    await finish(conv.id);
    expect(said(conv).slice(2)).toEqual(['@Alice ANSWER: A', '@Alice', '@Bob']);
    expect(told('Alice')).toEqual([false, true]);

    calls.length = 0;
    fake.asking = new Set(['Bob']);
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
    fake.asking = new Set(['Alice']);
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
    fake.asking = new Set(['Alice']);
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
    fake.asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    await orchestrator.resend(conv.id, conv.messages[0]!.id, 'question, ANSWER: B');
    await finish(conv.id);
    expect(said(conv)).toEqual(['question, ANSWER: B', '@Alice', '@Bob']);
    expect(conv.pause).toBeUndefined();
  });

  it('keep what the user wrote meanwhile waiting for the answer', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.asking = new Set(['Alice']);
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
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
