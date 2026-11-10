import { describe, expect, it } from 'vitest';
import { planSavable, type AgentConfig, type ChatMessage, type ProviderModels, type TeamPreset } from '../src/shared/types';
import { withLang } from '../src/server/i18n';
import {
  buildPlannerPrompt,
  buildRevisePrompt,
  decidePlan,
  decideRevision,
  draftPlace,
  fallbackPlan,
  fitAgents,
  historyForLead,
  keepMemberIds,
  parsePlanReply,
  sameTeam,
  teamSettings,
  type PlannerContext,
  type TeamDraft,
} from '../src/server/planner';
import { builtinPresets } from '../src/server/presets';

const catalog: ProviderModels[] = [
  {
    provider: 'claude',
    models: [{ id: 'opus' }, { id: 'haiku', efforts: ['low'] }],
    efforts: ['low', 'medium', 'high'],
    defaultModel: 'opus',
    source: 'cli',
  },
];
const ctx: PlannerContext = { available: ['claude', 'codex'], catalog, presets: builtinPresets('en') };
const lead = { provider: 'claude' as const };

describe('lead agent reply', () => {
  it('reads the JSON from a code block, or from bare braces', () => {
    expect(parsePlanReply('Sure.\n```json\n{"choice":"template","templateId":"x"}\n```\nDone')).toEqual({ choice: 'template', templateId: 'x' });
    expect(parsePlanReply('My pick: {"choice":"template","templateId":"y"} — enjoy')).toEqual({ choice: 'template', templateId: 'y' });
    expect(() => parsePlanReply('no json here')).toThrow();
  });

  it('turns a template choice into that template\'s team', () => {
    const d = decidePlan({ choice: 'template', templateId: 'builtin-debate', reason: 'Trade-offs.' }, ctx, lead);
    expect(d).toMatchObject({ source: 'template', presetId: 'builtin-debate', name: 'Three-way debate', reason: 'Trade-offs.' });
    expect(d.settings).toEqual({ mode: 'roundtable', rounds: 2, maxHops: 6 });
    // grok is not signed in here: the Skeptic runs on the lead's CLI instead.
    expect(d.agents.map((a) => a.provider)).toEqual(['claude', 'codex', 'claude']);
  });

  it('validates a custom team and keeps it runnable', () => {
    const d = decidePlan(
      {
        choice: 'custom',
        name: 'Docs',
        mode: 'relay',
        maxHops: 99,
        agents: [
          { name: 'Tech Writer', provider: 'Claude', role: 'Write.', model: 'haiku', effort: 'high' },
          { name: 'Checker', provider: 'codex', role: 'Check.', model: 'gpt-x' },
        ],
      },
      ctx,
      lead,
    );
    expect(d.source).toBe('custom');
    expect(d.settings).toEqual({ mode: 'relay', rounds: 1, maxHops: 30 });
    expect(d.agents.map((a) => a.name)).toEqual(['Tech_Writer', 'Checker']);
    // haiku only supports "low" here; codex has no catalog, so its model is kept.
    expect(d.agents[0]).toMatchObject({ provider: 'claude', model: 'haiku', effort: undefined });
    expect(d.agents[1]).toMatchObject({ provider: 'codex', model: 'gpt-x' });
  });

  it('rejects unusable designs', () => {
    expect(() => decidePlan({ choice: 'template', templateId: 'nope' }, ctx, lead)).toThrow(/nope/);
    expect(() => decidePlan({ choice: 'custom', agents: [] }, ctx, lead)).toThrow();
    expect(() =>
      decidePlan({ choice: 'custom', agents: [{ name: 'A', provider: 'claude' }, { name: 'a', provider: 'claude' }] }, ctx, lead),
    ).toThrow();
  });

  it('falls back to the general template, with the reason in the UI language', () => {
    const d = withLang('en', () => fallbackPlan(ctx, lead, 'no JSON'));
    expect(d).toMatchObject({ source: 'fallback', presetId: 'builtin-general' });
    expect(d.reason).toContain('no JSON');
    expect(d.reason).toContain('default template');
  });

  it('remaps members to signed-in CLIs and drops models those CLIs do not offer', () => {
    const [a] = fitAgents([{ id: 'x', name: 'G', provider: 'grok', role: '', model: 'grok-9', effort: 'xhigh' }], ctx, lead);
    expect(a).toMatchObject({ provider: 'claude', model: undefined, effort: undefined });
    expect(a!.id).not.toBe('x');
  });

  it('uses a template as it is with a reason, and offers no saving', () => {
    const d = withLang('en', () => decidePlan({ choice: 'template', templateId: 'builtin-debate' }, ctx, lead));
    expect(d.reason).toContain('Three-way debate');
    expect(planSavable(d)).toBe(false);
  });

  it('adapts a template: a new team that remembers where it came from', () => {
    const debate = ctx.presets.find((p) => p.id === 'builtin-debate')!;
    const raw = {
      choice: 'adapted',
      baseTemplateId: 'builtin-debate',
      name: 'Two-way debate',
      mode: 'roundtable',
      rounds: 1,
      agents: debate.agents.slice(0, 2).map(({ name, provider, role }) => ({ name, provider, role })),
      reason: 'Dropped the skeptic and kept one round.',
    };
    const d = decidePlan(raw, ctx, lead);
    expect(d).toMatchObject({ source: 'adapted', basedOn: { id: 'builtin-debate', name: 'Three-way debate' }, name: 'Two-way debate' });
    expect(d.reason).toBe('Dropped the skeptic and kept one round.');
    expect(d.presetId).toBeUndefined();
    expect(planSavable(d)).toBe(true);
    // An unknown base template still gives a usable team, just not an adapted one.
    const orphan = decidePlan({ ...raw, baseTemplateId: 'nope' }, ctx, lead);
    expect(orphan.source).toBe('custom');
    expect(orphan.basedOn).toBeUndefined();
  });

  it('treats a "new" team that is exactly a template as that template', () => {
    const debate = ctx.presets.find((p) => p.id === 'builtin-debate')!;
    const raw = {
      mode: debate.settings.mode,
      rounds: debate.settings.rounds,
      agents: debate.agents.map(({ name, provider, role, model, effort }) => ({ name, provider, role, model, effort })),
      reason: 'I changed the roles.',
    };
    for (const choice of ['adapted', 'custom']) {
      const d = withLang('en', () => decidePlan({ ...raw, choice, baseTemplateId: debate.id }, ctx, lead));
      expect(d).toMatchObject({ source: 'template', presetId: debate.id });
      expect(d.reason).not.toContain('I changed');
      expect(planSavable(d)).toBe(false);
    }
    const settings = { mode: debate.settings.mode, rounds: debate.settings.rounds, maxHops: debate.settings.maxHops };
    expect(sameTeam(debate, settings, debate.agents)).toBe(true);
    expect(sameTeam(debate, { ...settings, rounds: settings.rounds + 1 }, debate.agents)).toBe(false);
    expect(sameTeam(debate, settings, [{ ...debate.agents[0]!, role: 'Something else' }, ...debate.agents.slice(1)])).toBe(false);
  });

  it('shows the lead every template in full, saved ones included', () => {
    const role = 'You review SQL migrations.\nCheck locking, backfills and rollbacks.\n' + 'Be thorough. '.repeat(30);
    const saved: TeamPreset = {
      id: 'user-1',
      name: 'Migration review',
      description: 'Two reviewers for schema changes',
      agents: [{ id: 'a', name: 'DBA', provider: 'codex', role, model: 'gpt-x', effort: 'high' }],
      settings: { mode: 'relay', rounds: 1, maxHops: 4, permission: 'read-only' },
    };
    const prompt = buildPlannerPrompt(
      'Review my migration',
      { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'read-only', cwd: '/tmp' },
      { ...ctx, presets: [...ctx.presets, saved] },
    );
    const json = prompt.slice(prompt.indexOf('<templates>') + '<templates>'.length, prompt.indexOf('</templates>'));
    const templates = JSON.parse(json);
    expect(templates.map((t: { id: string }) => t.id)).toEqual([...ctx.presets.map((p) => p.id), 'user-1']);
    expect(templates.at(-1)).toEqual({
      id: 'user-1',
      name: 'Migration review',
      description: 'Two reviewers for schema changes',
      mode: 'relay',
      maxHops: 4,
      agents: [{ name: 'DBA', provider: 'codex', model: 'gpt-x', effort: 'high', role: role.trim() }],
    });
    for (const p of ctx.presets) for (const a of p.agents) expect(prompt).toContain(JSON.stringify(a.role.trim()).slice(1, -1));
    expect(prompt).toContain('"choice": "adapted", "baseTemplateId"');
  });

  it('tells the lead what it can use and asks for JSON', () => {
    const prompt = buildPlannerPrompt('How do I bake bread?', { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'read-only', cwd: '/tmp' }, ctx);
    expect(prompt).toContain('How do I bake bread?');
    expect(prompt).toContain('- claude (Claude Code): models opus, haiku');
    expect(prompt).not.toContain('- grok');
    expect(prompt).toContain('"id": "builtin-general"');
    expect(prompt).toContain('"read-only"');
    expect(prompt).toContain('```json');
  });
});

describe('a question in a conversation', () => {
  const settings = { mode: 'roundtable' as const, rounds: 1, maxHops: 8, permission: 'read-only' as const, cwd: '/tmp' };
  const team: AgentConfig[] = [
    { id: 'a1', name: 'Alice', provider: 'claude', role: 'Research it.' },
    { id: 'b1', name: 'Bob', provider: 'codex', role: 'Check it.', model: 'gpt-x' },
  ];
  const current = { agents: team, settings: { mode: 'relay' as const, rounds: 1, maxHops: 6 } };

  it('shows the lead the conversation so far and the current team, and lets it keep that team', () => {
    const prompt = buildPlannerPrompt('And functors?', settings, ctx, { history: '[User]: What is a monad?', current });
    expect(prompt).toContain('The user asked a new question in this conversation');
    expect(prompt).toContain('<conversation>\n[User]: What is a monad?\n</conversation>');
    const json = prompt.slice(prompt.indexOf('<current_team>') + '<current_team>'.length, prompt.indexOf('</current_team>'));
    expect(JSON.parse(json)).toEqual({
      mode: 'relay',
      maxHops: 6,
      agents: [
        { name: 'Alice', provider: 'claude', role: 'Research it.' },
        { name: 'Bob', provider: 'codex', model: 'gpt-x', role: 'Check it.' },
      ],
    });
    expect(prompt).toContain('1. "keep"');
    expect(prompt).toContain('{"choice": "keep"');
    expect(prompt).toContain('The user reviews your team');
    expect(buildPlannerPrompt('Q', { ...settings, autoConfirm: true }, ctx, { current })).toContain('Your team answers the question right away.');
  });

  it("asks for members named as a schedule's message @mentions them, unless the team has them", () => {
    const schedule = { newChat: false };
    const prompt = buildPlannerPrompt('@Reviewer 看一下 @dddd 的 PR', settings, ctx, { schedule });
    expect(prompt).toContain('It @mentions @Reviewer, @dddd. If these name the people or roles it is for');
    expect(buildPlannerPrompt('@alice what now?', settings, ctx, { current, schedule })).not.toContain('It @mentions');
    expect(buildPlannerPrompt('Upgrade @angular/core and @types/node, keep @Component(…)', settings, ctx, { schedule })).not.toContain('It @mentions');
    // An ordinary question's @-words are as often code: no hint.
    expect(buildPlannerPrompt('@Reviewer please look', settings, ctx, { current })).not.toContain('It @mentions');
  });

  it('keeps the current team as it is, ids included, and offers no saving', () => {
    const d = withLang('en', () => decidePlan({ choice: 'keep' }, ctx, lead, current));
    expect(d).toMatchObject({ source: 'kept', name: 'Alice · Bob', settings: { mode: 'relay', rounds: 1, maxHops: 6 } });
    expect(d.reason).toContain('current team');
    expect(d.agents).toEqual(team);
    expect(d.agents[0]).not.toBe(team[0]);
    expect(planSavable(d)).toBe(false);
    // Nothing to keep in a new conversation.
    expect(() => decidePlan({ choice: 'keep' }, ctx, lead)).toThrow();
  });

  it('keeps the current team when planning fails, and the general template when there is none', () => {
    const d = withLang('en', () => fallbackPlan(ctx, lead, 'no JSON', current));
    expect(d).toMatchObject({ source: 'fallback', agents: team });
    expect(d.presetId).toBeUndefined();
    expect(d.reason).toContain('keeping the current team');
    expect(fallbackPlan(ctx, lead, 'no JSON').presetId).toBe('builtin-general');
  });

  it('lets members who stay on keep their ids', () => {
    const next: AgentConfig[] = [
      { id: 'n1', name: 'alice', provider: 'claude', role: 'New role.' },
      { id: 'n2', name: 'Bob', provider: 'claude', role: 'Another CLI.' },
      { id: 'n3', name: 'Carol', provider: 'grok', role: '' },
    ];
    expect(keepMemberIds(next, team).map((a) => a.id)).toEqual(['a1', 'n2', 'n3']);
    expect(keepMemberIds(next, team)[0]!.role).toBe('New role.');
  });

  it('gives the lead the conversation in short: what was said, not tool calls, notes or plans', () => {
    const msg = (m: Partial<ChatMessage> & Pick<ChatMessage, 'author'>): ChatMessage => ({
      id: Math.random().toString(36),
      createdAt: 0,
      status: 'done',
      parts: [],
      ...m,
    });
    const text = (t: string) => [{ type: 'text' as const, text: t }];
    const history = historyForLead([
      msg({ author: { kind: 'user' }, parts: [...text('Look at this'), { type: 'attachment', id: 'f', name: 'log.txt', mimeType: 'text/plain', size: 3 }] }),
      msg({ author: { kind: 'system' }, parts: text('A note'), plan: { status: 'ready', lead } }),
      msg({
        author: { kind: 'agent', agentId: 'a1' },
        agentName: 'Alice',
        provider: 'claude',
        parts: [{ type: 'tool', id: 't', name: 'Read', detail: 'secret.txt', status: 'done' }, ...text('Found it.')],
      }),
      msg({ author: { kind: 'agent', agentId: 'b1' }, agentName: 'Bob', provider: 'codex', parts: text('[PASS]'), passed: true }),
      msg({ author: { kind: 'agent', agentId: 'b1' }, agentName: 'Bob', provider: 'codex', parts: text('x'.repeat(5000)) }),
    ]);
    expect(history.split('\n\n')).toEqual([
      '[User]: Look at this\n(Attached files: log.txt)',
      '[@Alice (Claude Code)]: Found it.',
      `[@Bob (Codex)]: ${'x'.repeat(1499)}…`,
    ]);
    // A long conversation: the latest messages are kept.
    const long = historyForLead(Array.from({ length: 40 }, (_, i) => msg({ author: { kind: 'user' }, parts: text(`${i} ${'y'.repeat(600)}`) })));
    expect(long.startsWith('(earlier messages left out)')).toBe(true);
    expect(long).toContain('[User]: 39 ');
    expect(long).not.toContain('[User]: 0 ');
    expect(long.length).toBeLessThan(13000);
  });
});

describe('changing a team at the user\'s request', () => {
  const draft: TeamDraft = {
    settings: { mode: 'roundtable', rounds: 2, maxHops: 8 },
    agents: [
      { id: 'a1', name: 'Alice', provider: 'claude', role: 'Research it.', model: 'opus', tools: { memory: false } },
      { id: 'g1', name: 'Gus', provider: 'grok', role: 'Doubt it.', effort: 'high' },
    ],
  };
  const where = { permission: 'edit' as const, cwd: '/work' };

  it('shows the lead the team, the request and the conversation, and asks for the whole team back', () => {
    const prompt = buildRevisePrompt('加一位用 Codex 的測試人員', draft, where, ctx, { history: '[User]: Fix the login bug' });
    expect(prompt).toContain('The user is editing the team of this conversation');
    expect(prompt).toContain('<request>\n加一位用 Codex 的測試人員\n</request>');
    expect(prompt).toContain('<conversation>\n[User]: Fix the login bug\n</conversation>');
    const json = prompt.slice(prompt.indexOf('<team>') + '<team>'.length, prompt.indexOf('</team>'));
    expect(JSON.parse(json)).toEqual({
      mode: 'roundtable',
      rounds: 2,
      agents: [
        { name: 'Alice', provider: 'claude', model: 'opus', role: 'Research it.' },
        { name: 'Gus', provider: 'grok', effort: 'high', role: 'Doubt it.' },
      ],
    });
    // What it may use and must leave alone, and the templates it may be pointed at.
    expect(prompt).toContain('- codex (Codex)');
    expect(prompt).not.toContain('- grok (Grok)');
    expect(prompt).toContain('The file permission "edit" and the working directory /work are the user\'s to set');
    expect(prompt).toContain('"id": "builtin-general"');
    // Roles it does not change are left out, so it cannot reword them by accident.
    expect(prompt).toContain('give "role" only for a new member or a role you rewrite: leave it out for every other member');
    expect(prompt).toContain('"role": "<instructions: only for a new member or a role you rewrite>"');
    expect(prompt).toContain('"reason": "<what you changed and why');
    // No conversation yet, no schedule: neither is mentioned.
    const bare = buildRevisePrompt('Fewer members', draft, where, ctx);
    expect(bare).not.toContain('<conversation>');
    expect(bare).not.toContain('<scheduled_message>');
  });

  it("tells the lead when the team is its design waiting for confirmation, and about the schedule's message", () => {
    const prompt = buildRevisePrompt('Use relay', draft, where, ctx, { pending: 'question', schedule: { text: '@Alice check the build', on: true } });
    expect(prompt).toContain('reviewing the team you designed for their latest question');
    expect(prompt).toContain('<scheduled_message>\n@Alice check the build\n</scheduled_message>');
    expect(prompt).toContain('keep the members it @mentions under those names');
    expect(prompt).toContain('with nobody watching:');
    // A schedule that is off (shown because the waiting design is for it): said so.
    expect(buildRevisePrompt('x', draft, where, ctx, { pending: 'schedule', schedule: { text: 'check', on: false } })).toContain(
      'with nobody watching (the schedule is off now: it sends nothing until the user turns it on):',
    );
  });

  it('keeps what the lead does not see for members who stay, and fits new members to the CLIs here', () => {
    const r = decideRevision(
      {
        mode: 'relay',
        maxHops: 5,
        agents: [
          // Stays: renamed only in case, model and effort left out (kept), role rewritten.
          { name: 'alice', provider: 'claude', role: 'Research it, then hand off to @Tester.' },
          // Stays on a CLI that is signed out here: the user chose it, so it is not moved.
          { name: 'Gus', provider: 'grok', role: 'Doubt it.', effort: 'high' },
          // New, on a CLI that is not signed in, with a model the lead made up: fitted.
          { name: 'Test er', provider: 'Grok', role: 'Test it.', model: 'grok-9' },
        ],
        reason: 'Added a tester, relay so Alice hands off.',
      },
      draft,
      ctx,
      lead,
    );
    expect(r.reason).toBe('Added a tester, relay so Alice hands off.');
    expect(r.settings).toEqual({ mode: 'relay', rounds: 2, maxHops: 5 });
    expect(r.agents[0]).toEqual({
      id: 'a1',
      name: 'alice',
      provider: 'claude',
      role: 'Research it, then hand off to @Tester.',
      model: 'opus',
      effort: undefined,
      tools: { memory: false },
    });
    expect(r.agents[1]).toMatchObject({ id: 'g1', provider: 'grok', effort: 'high' });
    expect(r.agents[2]).toMatchObject({ name: 'Test_er', provider: 'claude', model: undefined });
    expect(r.agents[2]!.id).not.toMatch(/^(a1|g1)$/);
  });

  it('clears a model given as "", drops one the CLI does not offer, and keeps a member moved to another CLI under its name', () => {
    const r = decideRevision(
      {
        agents: [
          { name: 'Alice', provider: 'claude', model: '', effort: 'turbo' },
          { name: 'Gus', provider: 'codex', role: 'Doubt it.' },
        ],
      },
      draft,
      ctx,
      lead,
    );
    // Left out: the role stays; the effort is one claude does not offer.
    expect(r.agents[0]).toMatchObject({ id: 'a1', role: 'Research it.', model: undefined, effort: undefined });
    // Moved to another CLI under its name, without "was": still Gus (its id; its session starts afresh
    // there), without the effort of its old CLI.
    expect(r.agents[1]).toMatchObject({ id: 'g1', name: 'Gus', provider: 'codex', role: 'Doubt it.', effort: undefined });
    // How they take turns: what the lead left out stays.
    expect(r.settings).toEqual(draft.settings);
    expect(r.reason).toBe('');
  });

  it('rejects a team that cannot run', () => {
    expect(() => decideRevision({ agents: [{ name: 'A', provider: 'claude' }, { name: 'a', provider: 'codex' }] }, draft, ctx, lead)).toThrow();
    expect(() => decideRevision({ agents: [{ name: 'A!', provider: 'claude' }] }, draft, ctx, lead)).toThrow();
  });

  it('reads how a team takes turns, keeping what is missing or invalid', () => {
    const was = { mode: 'parallel' as const, rounds: 3, maxHops: 7 };
    expect(teamSettings(undefined, was)).toEqual(was);
    expect(teamSettings({ mode: 'chaos', rounds: 99, maxHops: '4' }, was)).toEqual({ mode: 'parallel', rounds: 5, maxHops: 4 });
  });

  it("tells the lead a design for the schedule answers the schedule's message, not a question", () => {
    const prompt = buildRevisePrompt('Add a tester', draft, where, ctx, { pending: 'schedule', schedule: { text: 'check the build', on: true } });
    expect(prompt).toContain("reviewing the team you designed for the conversation's schedule");
    expect(prompt).toContain("answers the schedule's message each time the schedule sends it");
    expect(prompt).not.toContain('latest question');
  });

  it('asks the lead to say which member it renamed or moved', () => {
    const prompt = buildRevisePrompt('Rename Gus', draft, where, ctx);
    expect(prompt).toContain('give its current name as "was"');
    expect(prompt).toContain('"was": "<its current name: only for a member you renamed or moved to another coding agent>"');
  });

  it('keeps a member renamed or moved by the lead the same member, with its tools', () => {
    const r = decideRevision(
      {
        agents: [
          // Renamed (same CLI): id, tools, model and role kept.
          { name: 'Researcher', provider: 'claude', was: '@alice' },
          // Moved to codex: id kept; grok's effort does not carry over.
          { name: 'Gus', provider: 'codex', role: 'Doubt it.', was: 'Gus' },
        ],
      },
      draft,
      ctx,
      lead,
    );
    expect(r.agents[0]).toEqual({ id: 'a1', name: 'Researcher', provider: 'claude', role: 'Research it.', model: 'opus', effort: undefined, tools: { memory: false } });
    expect(r.agents[1]).toMatchObject({ id: 'g1', name: 'Gus', provider: 'codex', effort: undefined });
    // "Rename Alice to Bob and add a new Alice": the "was" is settled first, whatever the order, so the
    // new Alice does not take the renamed member's place; a "was" naming nobody is a new member.
    const swap = decideRevision(
      {
        agents: [
          { name: 'Alice', provider: 'claude', role: 'New.' },
          { name: 'Bob', provider: 'claude', was: 'Alice' },
          { name: 'X', provider: 'claude', was: 'Nobody' },
        ],
      },
      draft,
      ctx,
      lead,
    );
    expect(swap.agents[1]).toMatchObject({ id: 'a1', name: 'Bob', role: 'Research it.', tools: { memory: false } });
    expect(swap.agents[0]!.id).not.toMatch(/^(a1|g1)$/);
    expect(swap.agents[0]!.tools).toBeUndefined();
    expect(swap.agents[2]!.id).not.toMatch(/^(a1|g1)$/);
  });

  it('keeps a role the lead copied without its surrounding space as the user wrote it', () => {
    const spaced: TeamDraft = { ...draft, agents: [{ ...draft.agents[0]!, role: '  Research it.\n' }, draft.agents[1]!] };
    const r = decideRevision({ agents: [{ name: 'Alice', provider: 'claude', role: 'Research it.' }, { name: 'Gus', provider: 'grok' }] }, spaced, ctx, lead);
    expect(r.agents[0]!.role).toBe('  Research it.\n');
    expect(r.agents[1]!.role).toBe('Doubt it.');
  });

  it('keeps the members when the lead declines and only says why (how they take turns may still change)', () => {
    expect(decideRevision({ reason: 'I cannot change the permission.' }, draft, ctx, lead)).toEqual({
      agents: draft.agents,
      settings: draft.settings,
      reason: 'I cannot change the permission.',
    });
    expect(decideRevision({ agents: [], mode: 'relay', reason: 'Relay.' }, draft, ctx, lead).settings.mode).toBe('relay');
  });

  it('refuses the same member twice, and cuts a team longer than 8', () => {
    expect(() => decideRevision({ agents: [{ name: 'Alice', provider: 'claude' }, { name: 'alice', provider: 'claude' }] }, draft, ctx, lead)).toThrow();
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `M${i}`, provider: 'claude', role: '' }));
    expect(decideRevision({ agents: many }, draft, ctx, lead).agents.map((a) => a.name)).toEqual(many.slice(0, 8).map((m) => m.name));
  });

  it("reads the drawer's permission and folder for the lead, or the conversation's", () => {
    const saved = { permission: 'read-only' as const, cwd: '/saved' };
    expect(draftPlace({ permission: 'full', cwd: ' /draft ' }, saved)).toEqual({ permission: 'full', cwd: '/draft' });
    expect(draftPlace({ permission: 'root', cwd: '   ' }, saved)).toEqual(saved);
    expect(draftPlace(undefined, saved)).toEqual(saved);
    expect(buildRevisePrompt('x', draft, draftPlace({ permission: 'full', cwd: '/draft' }, saved), ctx)).toContain(
      'The file permission "full" and the working directory /draft',
    );
    // A folder not saved yet: the lead is told it works in the saved one.
    const unsaved = buildRevisePrompt('x', draft, draftPlace({ cwd: '/draft' }, saved), ctx, { savedCwd: '/saved' });
    expect(unsaved).toContain('The user has not saved that working directory yet: you are running in the one saved now, /saved.');
    expect(buildRevisePrompt('x', draft, saved, ctx, { savedCwd: '/saved' })).not.toContain('not saved that working directory');
  });
});
