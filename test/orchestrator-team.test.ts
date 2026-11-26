/*
 * The lead agent: designing a team (auto team) and changing it, its context, the directory lock while
 * it designs, and sorting new conversations into sidebar groups.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlannerContext } from '../src/server/planner';
import { TEAM_WORKTREE, type Conversation, type ConversationSchedule } from '../src/shared/types';
import { AgentRunError } from '../src/server/agents/types';
import { HttpError } from '../src/server/errors';
import {
  agentMessages,
  agents,
  calls,
  conversation,
  db,
  fake,
  finish,
  firstUserMessage,
  Hub,
  n,
  orchestrator,
  Orchestrator,
  project,
  root,
  runners,
  setOrchestrator,
  settings,
  store,
  Store,
  textOf,
} from './orchestrator-harness';

describe('a team the lead agent designs', () => {
  it('streams lead activity and checks each distinct proposed model before showing the team', async () => {
    const ctx: PlannerContext = {
      available: ['claude'],
      accounts: { claude: [''] },
      presets: store.listPresets(),
      catalog: [
        { provider: 'claude', source: 'builtin', models: [{ id: 'sonnet' }, { id: 'haiku' }], efforts: [], defaultModel: 'sonnet' },
      ],
      staffing: { now: Date.now(), usage: [] },
    };
    setOrchestrator(new Orchestrator(store, new Hub(), settings, { context: async () => ctx }));
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true, rounds: 1 });
    fake.leadReply = JSON.stringify({
      choice: 'custom',
      agents: [
        { name: 'Alice', provider: 'claude' },
        { name: 'Bob', provider: 'claude' },
      ],
    });
    const tasks: { model?: string; cwd: string; prompt: string; session?: string }[] = [];
    const real = runners.claude.run;
    const stub = vi.spyOn(runners.claude, 'run').mockImplementation(async (o) => {
      if (o.stateKey?.startsWith('lead.')) {
        o.onEvent({ type: 'thinking', text: 'Choosing roles' });
        o.onEvent({ type: 'tool_start', id: 'read', name: 'Read', detail: 'README.md' });
        o.onEvent({ type: 'tool_end', id: 'read', ok: true });
      }
      if (!o.stateKey) {
        tasks.push({ model: o.model, cwd: o.cwd, prompt: o.prompt, session: o.sessionId });
        if (!o.model || o.model === 'sonnet') throw new AgentRunError('endpoint unavailable', false, { inputTokens: 3 });
        o.onEvent({ type: 'text', text: 'RELAY_MODEL_OK' });
        return { inputTokens: 7, outputTokens: 0 };
      }
      return real(o);
    });
    try {
      await orchestrator.send(conv.id, 'private question for the team');
      await finish(conv.id);

      expect(tasks.map((task) => task.model)).toEqual(['sonnet', 'haiku']);
      expect(tasks.every((task) => task.cwd !== project && !task.session && !task.prompt.includes('private question'))).toBe(true);
      const plan = conv.messages.find((m) => m.plan)!;
      const question = conv.messages.find((m) => m.author.kind === 'user')!.id;
      expect(plan.usageQuestionId).toBe(question);
      expect(agentMessages(conv).map((m) => m.usageQuestionId)).toEqual([question, question]);
      expect(plan.plan?.usage).toEqual([
        { kind: 'planning', costUsd: 0.01 },
        { kind: 'modelCheck', provider: 'claude', model: 'sonnet', inputTokens: 3 },
        { kind: 'modelCheck', provider: 'claude', model: 'haiku', inputTokens: 7, outputTokens: 0 },
      ]);
      expect(plan.meta).toMatchObject({ inputTokens: 10, outputTokens: 0, costUsd: 0.01 });
      expect(new Store(db).get(conv.id)?.messages.find((m) => m.plan)?.plan?.usage).toEqual(plan.plan?.usage);
      expect(plan.parts).toEqual(
        expect.arrayContaining([
          { type: 'thinking', text: 'Choosing roles' },
          expect.objectContaining({ type: 'tool', id: 'read', status: 'done' }),
        ]),
      );
      expect(plan.plan?.agents?.map((a) => a.model)).toEqual(['haiku', 'haiku']);
      expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2);
    } finally {
      stub.mockRestore();
    }
  });

  it('stops before using a cloud model when the selected private endpoint fails its check', async () => {
    const ctx: PlannerContext = {
      available: ['claude'],
      accounts: { claude: [''] },
      presets: store.listPresets(),
      catalog: [
        {
          provider: 'claude',
          source: 'builtin',
          models: [{ id: 'private/local-model', endpoint: 'private' }, { id: 'sonnet' }],
          efforts: [],
        },
      ],
      staffing: { now: Date.now(), usage: [], backends: { configured: ['private'], deletedEndpoints: [] } },
    };
    setOrchestrator(new Orchestrator(store, new Hub(), settings, { context: async () => ctx }));
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true });
    conv.agents = [{ ...conv.agents[0]!, model: 'private/local-model' }];
    store.saveMeta(conv);
    fake.leadReply = JSON.stringify({ choice: 'keep' });
    const real = runners.claude.run;
    const stub = vi.spyOn(runners.claude, 'run').mockImplementation(async (o) => {
      if (o.stateKey) return real(o);
      o.onEvent({ type: 'text', text: 'I cannot respond with RELAY_MODEL_OK.' });
      return {};
    });
    try {
      await orchestrator.send(conv.id, 'private question for the team');
      await finish(conv.id);
      expect(conv.messages.find((m) => m.plan)?.plan).toMatchObject({
        status: 'failed',
        reason: expect.stringContaining('private/local-model'),
      });
      expect(agentMessages(conv)).toEqual([]);
    } finally {
      stub.mockRestore();
    }
  });

  it('waits for confirmation before testing a full-access team and keeps a failed plan from answering', async () => {
    const ctx: PlannerContext = {
      available: ['claude'],
      accounts: { claude: [''] },
      presets: store.listPresets(),
      catalog: [],
      staffing: { now: Date.now(), usage: [] },
    };
    setOrchestrator(new Orchestrator(store, new Hub(), settings, { context: async () => ctx }));
    const conv = conversation({ mode: 'roundtable', permission: 'full', autoTeam: true });
    fake.leadReply = JSON.stringify({ choice: 'keep' });
    const real = runners.claude.run;
    const probe = vi.fn(async () => {
      throw new AgentRunError('check refused', false, { outputTokens: 2 });
    });
    const stub = vi.spyOn(runners.claude, 'run').mockImplementation((o) => (o.stateKey ? real(o) : probe()));
    try {
      await orchestrator.send(conv.id, 'verify the proposed team');
      await finish(conv.id);
      const msg = conv.messages.find((m) => m.plan)!;
      expect(msg.plan).toMatchObject({ status: 'ready', awaitingConfirmation: true, checkOnConfirm: true });
      expect(msg.plan?.usage).toHaveLength(1);
      expect(probe).not.toHaveBeenCalled();

      orchestrator.confirmPlan(conv.id, msg.id);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      await finish(conv.id);
      expect(msg.plan?.usage).toHaveLength(2);
      expect(msg.plan?.usage?.[1]).toMatchObject({ kind: 'modelCheck', provider: 'claude', outputTokens: 2 });
      expect(msg.meta).toMatchObject({ costUsd: 0.01, outputTokens: 2 });
      expect(msg.plan?.status).toBe('failed');
      expect(agentMessages(conv)).toEqual([]);
    } finally {
      stub.mockRestore();
    }
  });

  it('cancels a running model test when the user stops the design', async () => {
    const ctx: PlannerContext = {
      available: ['claude'],
      accounts: { claude: [''] },
      presets: store.listPresets(),
      catalog: [],
      staffing: { now: Date.now(), usage: [] },
    };
    setOrchestrator(new Orchestrator(store, new Hub(), settings, { context: async () => ctx }));
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true });
    fake.leadReply = JSON.stringify({ choice: 'keep' });
    const real = runners.claude.run;
    let signal: AbortSignal | undefined;
    const stub = vi.spyOn(runners.claude, 'run').mockImplementation(async (o) => {
      if (o.stateKey) return real(o);
      signal = o.signal;
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
      return {};
    });
    try {
      await orchestrator.send(conv.id, 'check the team');
      await vi.waitFor(() => expect(signal).toBeDefined());
      orchestrator.stop(conv.id);
      await finish(conv.id);
      expect(signal?.aborted).toBe(true);
      const msg = conv.messages.find((m) => m.plan)!;
      expect(msg).toMatchObject({ status: 'aborted', plan: { status: 'planning' } });
      expect(agentMessages(conv)).toEqual([]);
    } finally {
      stub.mockRestore();
    }
  });

  it('does not start a team or drain its queue when all available models are exhausted', async () => {
    const context = vi.fn<() => Promise<PlannerContext>>(async () => ({
      available: [],
      accounts: {},
      catalog: [],
      presets: store.listPresets(),
      staffing: { usage: [], now: Date.now() },
    }));
    setOrchestrator(new Orchestrator(store, new Hub(), settings, { context }));
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true, rounds: 1 });
    await orchestrator.send(conv.id, 'design my team');
    await orchestrator.send(conv.id, 'and cover edge cases');
    await finish(conv.id);

    expect(calls).toEqual([]);
    expect(conv.messages.find((m) => m.plan)?.plan).toMatchObject({ status: 'failed', reason: expect.any(String) });
    expect(conv.queue?.map(textOf)).toEqual(['and cover edge cases']);

    context.mockResolvedValue({
      available: ['claude'],
      accounts: { claude: [''] },
      catalog: [],
      presets: store.listPresets(),
      staffing: { usage: [], now: Date.now() },
    });
    fake.leadReply = JSON.stringify({ choice: 'keep' });
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(calls[0]?.prompt).toContain('design my team\n\nand cover edge cases');
    expect(conv.messages.findLast((m) => m.plan)?.plan?.status).toBe('ready');
    expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2);
  });

  it('marks the unavailable lead and uses a different account for the current member', async () => {
    const resetsAt = Date.now() + 60_000;
    const work = settings.addAccount('claude', 'Work');
    setOrchestrator(
      new Orchestrator(store, new Hub(), settings, {
        context: async () => ({
          available: ['claude'],
          accounts: { claude: [work] },
          catalog: [],
          presets: store.listPresets(),
          staffing: {
            now: Date.now(),
            usage: [{ provider: 'claude', account: '', checkedAt: Date.now(), limits: [{ usedPercent: 100, span: 'week', resetsAt }] }],
          },
        }),
      }),
    );
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true, rounds: 1 });
    const member = conv.agents[0]!;
    conv.agents = [{ ...member, tools: { memory: false } }];
    store.saveMeta(conv);

    await orchestrator.send(conv.id, 'design my team');
    await finish(conv.id);

    expect(calls.map((c) => [c.name, c.home])).toEqual([[member.name, settings.env('claude', work).CLAUDE_CONFIG_DIR]]);
    expect(conv.agents[0]).toMatchObject({ id: member.id, provider: 'claude', account: work, tools: { memory: false } });
    expect(new Store(db).get(conv.id)!.messages.find((m) => m.plan)?.plan).toMatchObject({
      status: 'ready',
      source: 'fallback',
      leadUnavailable: true,
      fallback: { limit: { span: 'week', resetsAt } },
    });
  });

  it('keeps the unavailable lead marked when the CLI fails and its fallback team cannot pass verification', async () => {
    const context: PlannerContext = {
      available: ['claude'],
      accounts: { claude: [''] },
      catalog: [],
      presets: store.listPresets(),
      staffing: { now: Date.now(), usage: [] },
    };
    setOrchestrator(new Orchestrator(store, new Hub(), settings, { context: async () => context }));
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true });
    const real = runners.claude.run;
    const stub = vi.spyOn(runners.claude, 'run').mockImplementation(async (o) => {
      if (o.stateKey?.startsWith('lead.')) throw new Error('lead endpoint is down');
      if (!o.stateKey) throw new Error('backup model is down');
      return real(o);
    });
    try {
      await orchestrator.send(conv.id, 'design my team');
      await finish(conv.id);
      const reloaded = new Store(db).get(conv.id)!;
      expect(reloaded.messages.find((m) => m.plan)?.plan).toMatchObject({ status: 'failed', leadUnavailable: true });
      expect(agentMessages(reloaded)).toEqual([]);
    } finally {
      stub.mockRestore();
    }
  });

  it('stops a kept team whose private endpoint has been deleted', async () => {
    setOrchestrator(
      new Orchestrator(store, new Hub(), settings, {
        context: async () => ({
          available: ['claude'],
          accounts: { claude: [''] },
          catalog: [],
          presets: store.listPresets(),
          staffing: { usage: [], now: Date.now(), backends: { configured: [], deletedEndpoints: ['private'] } },
        }),
      }),
    );
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true, rounds: 1 });
    conv.agents = [{ ...conv.agents[0]!, model: 'private/local-model' }];
    store.saveMeta(conv);
    fake.leadReply = JSON.stringify({ choice: 'keep' });

    await orchestrator.send(conv.id, 'design my team');
    await finish(conv.id);

    expect(calls.map((c) => c.name)).toEqual(['lead']);
    expect(conv.messages.find((m) => m.plan)?.plan).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('private/local-model'),
    });
    expect(conv.agents[0]?.model).toBe('private/local-model');
  });

  it("keeps the tools and account the user set for a member who stays on, and gives new members their CLI's defaults", async () => {
    const work = settings.addAccount('claude', 'Work');
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [{ id: 'r1', name: 'Researcher', provider: 'claude', role: 'Search the web', tools: { memory: false }, account: work }];
    store.saveMeta(conv);
    fake.leadReply = JSON.stringify({
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
  it("is gathered for the folder the team works in, and the lead reads each CLI's tools from it", async () => {
    const folders: (string | undefined)[] = [];
    setOrchestrator(
      new Orchestrator(store, new Hub(), settings, {
        context: async (cwd) => {
          folders.push(cwd);
          return {
            available: ['claude'],
            catalog: [],
            presets: store.listPresets(),
            native: { claude: { builtinTools: ['WebSearch'], skills: [], mcpServers: [{ name: 'github', tools: ['create_issue'] }] } },
          };
        },
      }),
    );
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [];
    fake.leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-general', reason: 'x' });
    await orchestrator.send(conv.id, 'design one');
    await finish(conv.id);
    expect(folders).toEqual([project]);
    expect(calls[0]!.prompt).toContain('  Built-in tools: WebSearch\n  Its own MCP servers: github (tools: create_issue)');

    // Changing the team: the folder in the drawer, saved or not.
    const other = join(root, `other-${n}`);
    mkdirSync(other, { recursive: true });
    fake.reviseReply = JSON.stringify({ agents: [{ name: 'Ann', provider: 'claude', role: 'r' }], reason: 'r' });
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
    fake.leadReply = customTeam;
    await orchestrator.send(conv.id, 'I want to understand functional programming');
    await finish(conv.id);
    orchestrator.confirmPlan(conv.id, conv.messages.find((m) => m.plan)!.id);
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    calls.length = 0;
    return conv;
  };
  const plans = (conv: Conversation) => conv.messages.filter((m) => m.plan);

  it('lets the lead agent design the team for the question; the team answers it once the user confirmed it', async () => {
    const conv = autoConversation();
    conv.agents = [];
    fake.leadReply = 'Here is my choice:\n```json\n' + customTeam + '\n```';
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
    expect(plan!.plan).toMatchObject({
      status: 'ready',
      source: 'custom',
      name: 'Research pair',
      reason: 'Two views beat one.',
      awaitingConfirmation: true,
    });
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

    // Simulate an older pending plan that persisted only the combined figures.
    delete plan!.usageQuestionId;
    delete plan!.plan!.usage;
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
    expect(agentMessages(conv).every((m) => m.usageQuestionId === request!.id)).toBe(true);
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
    fake.leadReply = JSON.stringify({ choice: 'keep', reason: 'Same topic.' });
    await orchestrator.send(conv.id, 'And what is a functor?');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead']);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('The user asked a new question in this conversation');
    expect(prompt).toContain('<question>\nAnd what is a functor?\n</question>');
    // What was said before, and the team that answered it.
    expect(prompt).toContain('[User]: I want to understand functional programming');
    expect(prompt).toContain('[@Alice (Claude Code)]: Alice done');
    expect(prompt).toMatch(/<current_team>[\s\S]*"name":\s*"Bob"[\s\S]*<\/current_team>/);
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
    calls.length = 0;
    fake.leadReply = JSON.stringify({
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
    const solo = JSON.stringify({
      choice: 'custom',
      name: 'Solo',
      agents: [{ name: 'Zed', provider: 'claude', role: 'Alone.' }],
      reason: 'One is enough.',
    });
    fake.leadReply = solo;
    await orchestrator.send(conv.id, 'A small thing');
    await finish(conv.id);
    expect(conv.agents.map((a) => a.id)).toEqual(team);

    // Retrying an earlier reply drops the waiting design with what follows; the team that wrote it answers.
    calls.length = 0;
    await orchestrator.retry(conv.id, agentMessages(conv)[0]!.id);
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(plans(conv)).toHaveLength(1);
    expect(conv.agents.map((a) => a.id)).toEqual(team);

    // Declining keeps the current team, which answers the question.
    calls.length = 0;
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
    fake.gates = { Bob: new Promise<void>((r) => (release = r)) };
    await orchestrator.send(conv.id, '@Bob say more');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toEqual([conv.agents[1]!.id]), { interval: 20 });
    expect(await orchestrator.send(conv.id, 'And one more thing')).toEqual({ queued: true });
    release();
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Bob', 'Alice', 'Bob']), { timeout: 20_000 });
    await finish(conv.id);
    expect(conv.messages.find((m) => textOf(m) === 'And one more thing')!.queued).toBe(true);

    // Editing a question so that it @mentions a member: that member answers, no design.
    calls.length = 0;
    await orchestrator.resend(conv.id, firstUserMessage(conv).id, '@Alice explain monads again');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice']);

    // Stop and ask this instead: a new question, so the lead designs its team.
    calls.length = 0;
    fake.gates = { Alice: new Promise<void>(() => {}) };
    await orchestrator.send(conv.id, '@Alice and then?');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(conv.id)).toHaveLength(1), { interval: 20 });
    fake.leadReply = JSON.stringify({ choice: 'keep' });
    await orchestrator.send(conv.id, 'Something else entirely', undefined, true);
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'lead']);
    expect(plans(conv).at(-1)!.plan).toMatchObject({ source: 'kept', awaitingConfirmation: true });
  });

  it('says why when the team used at once cannot start, and Continue lets it answer without a new design', async () => {
    const conv = conversation({ mode: 'roundtable', autoTeam: true, autoConfirm: true }); // may edit files
    conv.agents = [];
    fake.leadReply = customTeam;
    // The design's own run starts; the team's, right after it, cannot for now.
    const real = orchestrator.prepareWorkspace.bind(orchestrator);
    let runs = 0;
    const prepare = vi.spyOn(orchestrator, 'prepareWorkspace').mockImplementation(async (c) => {
      if (++runs > 1) throw new HttpError(409, 'the folder is busy');
      return real(c);
    });
    try {
      await orchestrator.send(conv.id, 'Fix the bug');
      await vi.waitFor(() => expect(conv.messages.at(-1)!.author.kind).toBe('system'), { timeout: 20_000 });
      await vi.waitFor(() => expect(textOf(conv.messages.at(-1)!)).toMatch(/the folder is busy/), { timeout: 20_000 });
      await finish(conv.id);
    } finally {
      prepare.mockRestore();
    }
    expect(agentMessages(conv)).toHaveLength(0);
    expect(plans(conv)[0]!.plan).toMatchObject({ autoConfirmed: true });

    calls.length = 0;
    await orchestrator.send(conv.id, '');
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
  });

  it('refuses to confirm while something else holds the conversation', async () => {
    const conv = autoConversation();
    conv.agents = [];
    fake.leadReply = customTeam;
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
    calls.length = 0;
    fake.asking = new Set(['Alice']);
    fake.leadReply = JSON.stringify({ choice: 'keep' });
    await orchestrator.send(conv.id, 'One more thing');
    await finish(conv.id);
    orchestrator.confirmPlan(conv.id, plans(conv).at(-1)!.id);
    await vi.waitFor(() => expect(conv.pause).toBeDefined(), { timeout: 20_000 });
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice']);
    calls.length = 0;
    fake.asking = new Set();
    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);

    // Continue, and a retry.
    calls.length = 0;
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    await orchestrator.retry(conv.id, agentMessages(conv).at(-1)!.id);
    await finish(conv.id);
    expect(calls.map((c) => c.name)).not.toContain('lead');
    expect(plans(conv)).toHaveLength(2);
  });

  it("uses the lead agent's team at once when the conversation does not ask", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true });
    conv.agents = [];
    fake.leadReply = customTeam;
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
    fake.leadReply = 'No idea.';
    await orchestrator.send(conv.id, 'Something else');
    await finish(conv.id);
    expect(plans(conv)[1]!.plan).toMatchObject({ source: 'fallback', awaitingConfirmation: true });
    expect(plans(conv)[1]!.plan!.presetId).toBeUndefined();
    expect(conv.agents.map((a) => a.id)).toEqual(ids);
    orchestrator.confirmPlan(conv.id, plans(conv)[1]!.id);
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(4), { timeout: 20_000 });
    await finish(conv.id);

    // Stopped while designing: Continue designs again, for the question that still waits.
    calls.length = 0;
    let reject!: (error: Error) => void;
    fake.leadGate = new Promise((_, r) => (reject = r));
    fake.leadReply = JSON.stringify({ choice: 'keep' });
    await orchestrator.send(conv.id, 'A third question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['lead']), { interval: 20 });
    orchestrator.stop(conv.id);
    reject(new Error('lead run cancelled'));
    await finish(conv.id);
    const stopped = plans(conv).at(-1)!;
    expect(stopped.status).toBe('aborted');
    expect(stopped.plan!.leadUnavailable).toBeUndefined();
    fake.leadGate = undefined;
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['lead', 'lead']);
    expect(calls[1]!.prompt).toContain('<question>\nA third question\n</question>');
    expect(plans(conv).at(-1)!.plan).toMatchObject({ status: 'ready', source: 'kept', awaitingConfirmation: true });
  });

  it('keeps a question asked while the lead agent designs the team until the user confirms it', async () => {
    const conv = autoConversation();
    conv.agents = [];
    fake.leadReply = customTeam;
    let release!: () => void;
    fake.leadGate = new Promise((r) => (release = r));
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
    fake.leadReply = customTeam;
    await orchestrator.send(conv.id, 'Help me plan a trip');
    await finish(conv.id);
    const plan = conv.messages.find((m) => m.plan)!;
    expect(plan.plan!.awaitingConfirmation).toBe(true);
    // What PATCH { agents } does: the team set, then the design settled by it, showing it.
    conv.agents = [{ id: 'z', name: 'Zed', provider: 'claude', role: 'Mine.' }];
    expect(orchestrator.teamSetByHand(conv, true)).toBe(true);
    expect(plan.plan!.awaitingConfirmation).toBeUndefined();
    expect(plan.plan!.agents!.map((a) => a.name)).toEqual(['Zed']);
    expect(plan.plan!.adjustedAt).toEqual(expect.any(Number));
    // Confirming again, or a plan that never waited, changes nothing.
    const at = plan.plan!.confirmedAt;
    orchestrator.confirmPlan(conv.id, plan.id);
    expect(plan.plan!.confirmedAt).toBe(at);
    expect(() => orchestrator.confirmPlan(conv.id, 'nope')).toThrow(/找不到這份團隊設計/);
  });

  it('uses an existing template when the lead picks one, and the default one when its reply is unusable', async () => {
    const conv = autoConversation();
    conv.agents = [];
    fake.leadReply = JSON.stringify({ choice: 'template', templateId: 'builtin-parallel', reason: 'Compare.' });
    await orchestrator.send(conv.id, 'Sort a list in three languages');
    await finish(conv.id);
    expect(conv.messages[1]!.plan).toMatchObject({ source: 'template', presetId: 'builtin-parallel', settings: { mode: 'parallel' } });
    expect(() => orchestrator.savePlanAsPreset(conv.id, conv.messages[1]!.id)).toThrow(/設計或調整/);

    const other = autoConversation();
    other.agents = [];
    fake.leadReply = 'I would pick a nice team.';
    await orchestrator.send(other.id, 'Hello');
    await finish(other.id);
    expect(other.messages[1]!.plan).toMatchObject({ source: 'fallback', presetId: 'builtin-general' });
    expect(other.messages[1]!.plan!.agents!.map((a) => a.name)).toEqual(['Analyst', 'Critic', 'Synthesizer']);
  });

  it('designs the team again when the question is edited', async () => {
    const conv = autoConversation();
    conv.agents = [];
    fake.leadReply = customTeam;
    await orchestrator.send(conv.id, 'First version');
    await finish(conv.id);
    calls.length = 0;
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
    fake.reviseReply = 'Done:\n```json\n' + withTester + '\n```';
    await orchestrator.reviseTeam(conv.id, { request: 'add a tester', ...draft });
    expect(calls.map((c) => [c.name, c.home, c.model, c.effort, c.nativeOff?.join()])).toEqual([
      ['reviser', join(home, `claude-${work}`), 'sonnet', 'low', 'hooks'],
    ]);
  });

  it('returns the changed team and changes nothing in the conversation', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'Fix the login bug');
    await finish(conv.id);
    calls.length = 0;
    const before = { agents: structuredClone(conv.agents), settings: structuredClone(conv.settings), messages: conv.messages.length };
    fake.reviseReply = 'Done:\n```json\n' + withTester + '\n```';

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

  it('takes a team saved before the team limit was lowered, and cuts the answer to the limit', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    // Nine members: more than the limit (8 here), as a team saved under a higher one would be.
    const nine = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, name: `M${i}`, provider: 'claude' as const, role: 'Help.' }));
    conv.agents = nine;
    fake.reviseReply =
      'Done:\n```json\n' + JSON.stringify({ agents: nine.map((a) => ({ name: a.name, provider: a.provider })), reason: 'Kept.' }) + '\n```';
    const r = await orchestrator.reviseTeam(conv.id, { request: 'remove one', agents: nine, settings: draft.settings });
    expect(r.agents.map((a) => a.name)).toEqual(nine.slice(0, 8).map((a) => a.name));
    // A draft larger than both the limit and the saved team is refused as before.
    const ten = [...nine, { id: 'm9', name: 'M9', provider: 'claude' as const, role: '' }];
    await expect(orchestrator.reviseTeam(conv.id, { request: 'add one', agents: ten, settings: draft.settings })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("changes the lead agent's design waiting for confirmation, which keeps waiting", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    conv.agents = [];
    fake.leadReply = JSON.stringify({
      choice: 'custom',
      name: 'Pair',
      mode: 'roundtable',
      rounds: 1,
      agents: draft.agents,
      reason: 'Two.',
    });
    await orchestrator.send(conv.id, 'Plan the migration');
    await finish(conv.id);
    const plan = conv.messages.find((m) => m.plan)!;
    fake.reviseReply = withTester;

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

    fake.reviseReply = 'Sorry, I cannot.';
    await expect(orchestrator.reviseTeam(conv.id, { request: 'more', ...draft })).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('首席 agent 沒能調整團隊'),
    });
    fake.reviseReply = JSON.stringify({ agents: [{ name: 'Bad name', provider: 'nobody' }] });
    await expect(orchestrator.reviseTeam(conv.id, { request: 'more', ...draft })).rejects.toMatchObject({ status: 503 });
  });

  it('stops when the request goes away, when a newer one comes, and when the conversation is deleted', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.reviseGate = new Promise(() => {});
    fake.reviseReply = withTester;

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
    fake.reviseReply = withTester;
    await orchestrator.reviseTeam(conv.id, {
      request: 'more',
      agents,
      settings: { ...draft.settings, permission: 'full', cwd: '/not/saved/yet' },
    });
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
    fake.reviseReply = JSON.stringify({
      agents: [
        { name: 'Lead', provider: 'claude', was: 'Alice' },
        { name: 'Bob', provider: 'claude' },
      ],
      reason: 'Renamed.',
    });
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
    fake.reviseReply = JSON.stringify({ reason: 'The permission is yours to set.' });
    const kept = await orchestrator.reviseTeam(conv.id, { request: 'give it full access', ...draft });
    expect(kept.agents.map((a) => a.id)).toEqual(['a', 'b']);
    expect(kept.reason).toBe('The permission is yours to set.');

    await expect(
      orchestrator.reviseTeam(conv.id, {
        request: 'more',
        agents: [{ id: 'a', name: 'Bad name', provider: 'claude', role: '' }],
        settings: draft.settings,
      }),
    ).rejects.toMatchObject({ status: 400 });

    fake.reviseFail = 'rate limited';
    await expect(orchestrator.reviseTeam(conv.id, { request: 'more', ...draft })).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('rate limited'),
    });
  });

  it("links the lead agent's session to the conversation in AgentsView", async () => {
    const links: string[] = [];
    setOrchestrator(
      new Orchestrator(
        store,
        new Hub(),
        settings,
        { context: async () => ({ available: ['claude'], catalog: [], presets: store.listPresets() }) },
        {
          schedule: () => undefined,
          link: (c: Conversation, provider: string, sessionId: string) => links.push(`${c.id} ${provider}:${sessionId}`),
        },
      ),
    );
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.reviseReply = withTester;
    await orchestrator.reviseTeam(conv.id, { request: 'more', ...draft });
    expect(links).toEqual([`${conv.id} claude:reviser-session`]);
  });

  it('waits for a replaced request until its lead process has ended, on delete too', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.reviseGate = new Promise(() => {});
    let exit!: () => void;
    fake.reviseLinger = new Promise((r) => (exit = r));
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
    fake.reviseGate = new Promise(() => {});
    let exit!: () => void;
    fake.reviseLinger = new Promise((r) => (exit = r));
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
    fake.leadGate = new Promise((r) => (release = r));
    const conv = conversation({ mode: 'roundtable', autoTeam: true }); // may edit files
    conv.agents = [];
    fake.leadReply = teamIn('roundtable');
    await orchestrator.send(conv.id, 'Request');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toContain('lead'), { interval: 20 });

    const other = conversation({ mode: 'roundtable' }); // same directory
    await orchestrator.send(other.id, 'go');
    await finish(other.id);
    expect(other.worktrees[TEAM_WORKTREE]).toBeUndefined(); // in the directory itself
    release();
    await finish(conv.id);
  });

  it("locks the directory by the confirmed team's mode once it answers", async () => {
    let release!: () => void;
    const plan = async (mode: string) => {
      const conv = conversation({ mode: 'roundtable', autoTeam: true });
      conv.agents = [];
      fake.leadReply = teamIn(mode);
      await orchestrator.send(conv.id, 'Question');
      await finish(conv.id);
      fake.gate = new Promise((r) => (release = r));
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
    expect(other.worktrees[TEAM_WORKTREE]).toBeUndefined(); // it wrote in the directory itself
    await orchestrator.cleanupWorktrees(parallel);

    // Roundtable: the agents write to the directory itself, so another conversation's team works in its own worktree.
    const shared = await plan('roundtable');
    await vi.waitFor(() => expect(orchestrator.activeAgentIds(shared.id)).toHaveLength(1), { interval: 20 });
    const third = conversation({ mode: 'roundtable' });
    await orchestrator.send(third.id, 'go');
    await vi.waitFor(() => expect(third.worktrees[TEAM_WORKTREE]).toHaveLength(1), { interval: 20 });
    release();
    await finish(shared.id);
    await finish(third.id);
    expect(shared.worktrees[TEAM_WORKTREE]).toBeUndefined();
  });

  it('designs again for an edited question, with what came before it as history', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, autoConfirm: true });
    conv.agents = [];
    fake.leadReply = teamIn('roundtable');
    await orchestrator.send(conv.id, 'First question');
    await vi.waitFor(() => expect(agentMessages(conv)).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    await orchestrator.send(conv.id, 'Second question');
    await vi.waitFor(() => expect(agentMessages(conv)).toHaveLength(4), { timeout: 20_000 });
    await finish(conv.id);

    calls.length = 0;
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
    fake.leadReply = teamIn('roundtable');
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

describe('sorting new conversations into sidebar groups', () => {
  const groupOf = (convId: string) => store.list(() => false).find((c) => c.id === convId)?.groupId;

  it('lets the lead agent put a conversation in a group by its first message, next to the team', async () => {
    store.createGroup({ id: 'g1', name: 'Frontend' });
    store.createGroup({ id: 'g2', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.sorterReply = '```json\n{"group": 2}\n```';
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
    fake.sorterGate = new Promise((r) => (release = r));
    fake.sorterReply = '{"group": 2}';
    await orchestrator.send(conv.id, 'Fix the sidebar');
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(true));
    expect(
      store
        .list(
          () => false,
          () => false,
          (id) => orchestrator.isSorting(id),
        )
        .find((c) => c.id === conv.id)?.sorting,
    ).toBe(true);
    store.moveToGroup(conv.id, 'g1');
    release();
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(false));
    expect(groupOf(conv.id)).toBe('g1');
  });

  it('takes a branch made while its conversation was being sorted into the group it is sorted into', async () => {
    store.createGroup({ id: 'g1', name: 'Frontend' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    let release!: () => void;
    fake.sorterGate = new Promise((r) => (release = r));
    fake.sorterReply = '{"group": 1}';
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
    fake.sorterGate = new Promise(() => {}); // never answers by itself
    await orchestrator.send(conv.id, 'Fix the sidebar');
    await vi.waitFor(() => expect(orchestrator.isSorting(conv.id)).toBe(true));
    await orchestrator.deleteConversation(conv.id);
    expect(orchestrator.isSorting(conv.id)).toBe(false);
    expect(store.list(() => false).some((c) => c.id === conv.id)).toBe(false);
  });
});
