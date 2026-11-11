import { describe, expect, it } from 'vitest';
import { planSavable, type AgentConfig, type ChatMessage, type ProviderModels, type TeamPreset } from '../src/shared/types';
import { withLang } from '../src/server/i18n';
import {
  buildPlannerPrompt,
  buildRevisePrompt,
  cliToolsForLead,
  decidePlan,
  decideRevision,
  draftPlace,
  fallbackPlan,
  fitAgents,
  historyForLead,
  keepMemberIds,
  libraryForLead,
  parsePlanReply,
  plannerContext,
  sameTeam,
  teamSettings,
  toolsFromLead,
  type LibraryItem,
  type PlannerContext,
  type PlannerSources,
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
    // Each model with the efforts it takes (its own list, else the CLI's), and the defaults.
    expect(prompt).toContain('- claude (Claude Code)\n  Models: opus (efforts low/medium/high), haiku (efforts low)\n  Default model opus');
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

  it('lets members who stay on keep their accounts; new ones get a signed-in account of their CLI', () => {
    const current: AgentConfig[] = [{ id: 'a1', name: 'Alice', provider: 'claude', role: '', account: 'work0001' }];
    const next: AgentConfig[] = [
      { id: 'n1', name: 'Alice', provider: 'claude', role: '' },
      { id: 'n2', name: 'Bob', provider: 'claude', role: '', account: 'other001' },
    ];
    expect(keepMemberIds(next, current).map((a) => [a.id, a.account])).toEqual([
      ['a1', 'work0001'],
      ['n2', 'other001'],
    ]);
    // The default account is not signed in, the Work one is.
    const signedIn: PlannerContext = { ...ctx, accounts: { claude: ['work0001'], codex: [''] } };
    const fitted = fitAgents(
      [
        { id: 'x', name: 'A', provider: 'claude', role: '' },
        { id: 'y', name: 'B', provider: 'claude', role: '', account: 'work0001' },
        { id: 'z', name: 'C', provider: 'codex', role: '', account: 'gone0001' },
        // On a CLI that is not available: moved to the lead's, whose accounts it then gets.
        { id: 'w', name: 'D', provider: 'grok', role: '', account: 'grok0001' },
      ],
      signedIn,
      lead,
    );
    expect(fitted.map((a) => [a.provider, a.account])).toEqual([
      ['claude', 'work0001'],
      ['claude', 'work0001'],
      ['codex', undefined],
      ['claude', 'work0001'],
    ]);
    expect('account' in fitted[2]!).toBe(false);
    // Accounts unknown: left as they are.
    expect(fitAgents([{ id: 'y', name: 'B', provider: 'claude', role: '', account: 'any00001' }], ctx, lead)[0]!.account).toBe('any00001');
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

  it("keeps a member's account while it stays on the same CLI, and never shows the lead the account ids", () => {
    const withAccount: TeamDraft = { ...draft, agents: [{ ...draft.agents[0]!, account: 'work0001' }, draft.agents[1]!] };
    expect(buildRevisePrompt('x', withAccount, where, ctx)).not.toContain('work0001');
    const stays = decideRevision({ agents: [{ name: 'Alice', provider: 'claude' }, { name: 'Gus', provider: 'grok' }] }, withAccount, ctx, lead);
    expect(stays.agents.map((a) => [a.id, a.account])).toEqual([
      ['a1', 'work0001'],
      ['g1', undefined],
    ]);
    // Its account is signed out and only the default one is usable: a member who keeps its CLI keeps
    // it all the same, also when the lead changes its model.
    const signedOut: PlannerContext = { ...ctx, accounts: { claude: [''], codex: [''] } };
    for (const model of [undefined, 'haiku']) {
      const r = decideRevision({ agents: [{ name: 'Alice', provider: 'claude', model }, { name: 'Gus', provider: 'grok' }] }, withAccount, signedOut, lead);
      expect(r.agents[0]).toMatchObject({ id: 'a1', model: model ?? 'opus', account: 'work0001' });
    }
    const moves = decideRevision({ agents: [{ name: 'Alice', provider: 'codex' }] }, withAccount, ctx, lead);
    expect(moves.agents[0]).toMatchObject({ id: 'a1', provider: 'codex' });
    expect(moves.agents[0]!.account).toBeUndefined();
  });

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

  it('keeps a member the lead renamed without saying so, when it is the only one left over and has no role', () => {
    // "Rename Alice to Researcher": the lead forgot "was" and, as told, left the role out.
    const r = decideRevision({ agents: [{ name: 'Researcher', provider: 'claude' }, { name: 'Gus', provider: 'grok' }] }, draft, ctx, lead);
    expect(r.agents[0]).toMatchObject({ id: 'a1', name: 'Researcher', role: 'Research it.', model: 'opus', tools: { memory: false } });
    // A new member (it has a role), or more than one left over: not taken for a rename.
    const added = decideRevision({ agents: [{ name: 'Tester', provider: 'claude', role: 'Test it.' }, { name: 'Gus', provider: 'grok' }] }, draft, ctx, lead);
    expect(added.agents[0]!.id).not.toBe('a1');
    const two = decideRevision({ agents: [{ name: 'P', provider: 'claude' }, { name: 'Q', provider: 'claude' }] }, draft, ctx, lead);
    expect(two.agents.map((a) => a.id)).not.toContain('a1');
  });

  it('takes a null or blank role, and a null model or effort, as left out; "" still clears a model', () => {
    const r = decideRevision(
      {
        agents: [
          { name: 'Alice', provider: 'claude', role: null, model: null },
          { name: 'Gus', provider: 'grok', role: '  ', effort: null },
        ],
      },
      draft,
      ctx,
      lead,
    );
    expect(r.agents[0]).toMatchObject({ role: 'Research it.', model: 'opus' });
    expect(r.agents[1]).toMatchObject({ role: 'Doubt it.', effort: 'high' });
    expect(decideRevision({ agents: [{ name: 'Alice', provider: 'claude', model: '' }] }, draft, ctx, lead).agents[0]!.model).toBeUndefined();
  });

  it('ignores a "was" misused for a new member based on one the lead keeps unchanged', () => {
    // "Add Alice2 based on Alice": Alice is listed unchanged (no role), so the "was" does not take her place.
    const r = decideRevision(
      { agents: [{ name: 'Alice', provider: 'claude' }, { name: 'Alice2', provider: 'claude', role: 'Like Alice.', was: 'Alice' }, { name: 'Gus', provider: 'grok' }] },
      draft,
      ctx,
      lead,
    );
    expect(r.agents[0]).toMatchObject({ id: 'a1', name: 'Alice', role: 'Research it.' });
    expect(r.agents[1]!.id).not.toMatch(/^(a1|g1)$/);
  });

  it('describes a design for a schedule deleted since, and points the lead at the folder it runs in', () => {
    const prompt = buildRevisePrompt('x', draft, where, ctx, { pending: 'schedule' });
    expect(prompt).toContain("designed for the conversation's schedule, which has been deleted since");
    expect(prompt).not.toContain("answers the schedule's message");
    expect(prompt).toContain('"was" is only for that: never for a new member, even one based on another.');
    expect(prompt).toContain('Do not use tools unless the change depends on the files in the folder you are running in.');
  });

  it('keeps swaps and chains of renames, which list old names again', () => {
    // Swap across CLIs: each keeps its own id, role and settings under the other's name.
    const swap = decideRevision(
      { agents: [{ name: 'Gus', provider: 'claude', was: 'Alice' }, { name: 'Alice', provider: 'grok', was: 'Gus' }] },
      draft,
      ctx,
      lead,
    );
    expect(swap.agents[0]).toMatchObject({ id: 'a1', name: 'Gus', provider: 'claude', role: 'Research it.', model: 'opus', tools: { memory: false } });
    expect(swap.agents[1]).toMatchObject({ id: 'g1', name: 'Alice', provider: 'grok', role: 'Doubt it.', effort: 'high' });
    // A chain on one CLI (Alice → Bob, Bob → Dan, with Dan's role rewritten), Carol removed.
    const three: TeamDraft = {
      settings: draft.settings,
      agents: [
        { id: 'a', name: 'Alice', provider: 'claude', role: 'A.' },
        { id: 'b', name: 'Bob', provider: 'claude', role: 'B.', tools: { memory: true } },
        { id: 'c', name: 'Carol', provider: 'claude', role: 'C.' },
      ],
    };
    const chain = decideRevision(
      { agents: [{ name: 'Bob', provider: 'claude', was: 'Alice' }, { name: 'Dan', provider: 'claude', was: 'Bob', role: 'D.' }] },
      three,
      ctx,
      lead,
    );
    expect(chain.agents.map((a) => [a.id, a.name, a.role])).toEqual([
      ['a', 'Bob', 'A.'],
      ['b', 'Dan', 'D.'],
    ]);
    expect(chain.agents[1]!.tools).toEqual({ memory: true });
  });

  it('starts a new member based on another (a misused "was") from that one\'s role, never from a removed member', () => {
    // "Add Alice2 based on Alice, remove Gus": Alice2 is new, with Alice's role; it is not taken for Gus renamed.
    const r = decideRevision({ agents: [{ name: 'Alice', provider: 'claude' }, { name: 'Alice2', provider: 'claude', was: 'Alice' }] }, draft, ctx, lead);
    expect(r.agents[0]).toMatchObject({ id: 'a1', name: 'Alice' });
    expect(r.agents[1]).toMatchObject({ name: 'Alice2', role: 'Research it.' });
    expect(r.agents[1]!.id).not.toMatch(/^(a1|g1)$/);
    expect(r.agents[1]!.tools).toBeUndefined();
  });

  it('keeps a member renamed without "was" when the lead copied its role', () => {
    const r = decideRevision({ agents: [{ name: 'Researcher', provider: 'claude', role: ' Research it. ' }, { name: 'Gus', provider: 'grok' }] }, draft, ctx, lead);
    expect(r.agents[0]).toMatchObject({ id: 'a1', name: 'Researcher', role: 'Research it.', tools: { memory: false } });
  });

  it('tells the lead it cannot clear a role', () => {
    expect(buildRevisePrompt('x', draft, where, ctx)).toContain("or to clear a member's role, which the user does in the editor");
  });
});

describe("what the lead knows of each coding agent's tools and models", () => {
  const library: LibraryItem[] = libraryForLead({
    mcpServers: [
      { id: 'srv1', name: 'browser', transport: 'stdio', command: 'b', args: [], url: '', env: [], headers: [], providers: ['claude'] },
      { id: 'srv2', name: 'db', transport: 'http', command: '', args: [], url: 'http://x', env: [], headers: [], providers: [] },
    ],
    skills: [
      { path: '/skills/pdf', name: 'pdf', description: 'Make PDFs', providers: ['claude', 'codex', 'grok'] },
      { path: '/skills/broken', name: 'broken', description: '', providers: ['claude'], problem: 'no SKILL.md' },
    ],
    memory: { all: 'We use pnpm.\n  Always.', claude: '', codex: 'Codex: run tests', grok: '' },
  });

  it('reads the tool library: MCP servers, usable skills and the memory parts that are set, with their keys', () => {
    expect(library).toEqual([
      { name: 'mcp:browser', key: 'mcp:srv1', providers: ['claude'] },
      { name: 'mcp:db', key: 'mcp:srv2', providers: [] },
      { name: 'skill:pdf', key: 'skill:/skills/pdf', about: 'Make PDFs', providers: ['claude', 'codex', 'grok'] },
      { name: 'memory', key: 'memory', about: 'We use pnpm. Always.', providers: ['claude', 'codex', 'grok'] },
      { name: 'memory:codex', key: 'memory:codex', about: 'Codex: run tests', providers: ['codex'], only: 'codex' },
    ]);
  });

  it("reads what a CLI loads by itself as Harness Relay runs it: items left out of its runs, and disabled servers, are not there", () => {
    const tools = cliToolsForLead({
      builtinTools: [{ name: 'Bash' }, { name: 'WebSearch', leftOut: true }],
      skills: [{ name: 'commit', description: ' Make commits ' }, { name: 'gone', description: '', leftOut: true }],
      mcpServers: [
        { name: 'github', status: 'connected', tools: [{ name: 'create_issue' }, { name: 'delete_repo', leftOut: true }] },
        { name: 'jira', status: 'needs-auth' },
        { name: 'old', status: 'disabled' },
      ],
      agents: [{ name: 'explorer', description: '' }],
      plugins: [{ name: 'x@market' }],
    });
    expect(tools).toEqual({
      builtinTools: ['Bash'],
      skills: [{ name: 'commit', description: 'Make commits' }],
      mcpServers: [{ name: 'github', tools: ['create_issue'] }, { name: 'jira', status: 'needs-auth' }],
      agents: ['explorer'],
      plugins: ['x@market'],
    });
  });

  it("tells the lead each model's efforts and default effort, each CLI's own tools and the library, and how to staff by them", () => {
    const rich: PlannerContext = {
      ...ctx,
      catalog: [
        {
          provider: 'claude',
          models: [{ id: 'fable', label: 'Fable', latest: true, efforts: ['low', 'high', 'max'], defaultEffort: 'high' }, { id: 'haiku' }],
          efforts: ['low', 'medium'],
          defaultModel: 'fable',
          defaultEffort: 'medium',
          source: 'cli',
        },
      ],
      native: {
        claude: { builtinTools: ['Bash', 'WebSearch'], skills: [{ name: 'commit', description: 'Make commits' }], mcpServers: [{ name: 'github', tools: ['create_issue'] }], agents: ['explorer'] },
      },
      library,
    };
    const current = { agents: [{ id: 'a1', name: 'Ann', provider: 'claude' as const, role: 'R', tools: { 'mcp:srv1': false, 'skill:/gone': true } }], settings: { mode: 'roundtable' as const, rounds: 1, maxHops: 8 } };
    const prompt = buildPlannerPrompt('Fix the login bug', { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'edit', cwd: '/w' }, rich, { current });
    expect(prompt).toContain('  Models: fable (Fable; always its family\'s newest; efforts low/high/max; default effort high), haiku (efforts low/medium)');
    expect(prompt).toContain('  Default model fable, effort medium');
    expect(prompt).toContain('  Built-in tools: Bash, WebSearch');
    expect(prompt).toContain('  Its own skills: commit (Make commits)');
    expect(prompt).toContain('  Its own MCP servers: github (tools: create_issue)');
    expect(prompt).toContain('  Its own subagents: explorer');
    expect(prompt).toContain('  From the tool library by default: mcp:browser, skill:pdf, memory');
    // Codex is available but did not say what it loads.
    expect(prompt).toContain('- codex (Codex)\n  Its own tools, skills and MCP servers: unknown (it did not say in time)\n  From the tool library by default: skill:pdf, memory, memory:codex');
    expect(prompt).toContain('- mcp:db: for nobody by default');
    expect(prompt).toContain('- memory:codex (Codex: run tests): only for codex members');
    expect(prompt).toContain('A member\'s "tools" gives it a library item');
    expect(prompt).toContain('Give it a coding agent that has the tools that part needs');
    expect(prompt).toContain('"tools": {"<optional: tool library item>": true | false}');
    // The current team's exceptions, by name; one for an item that is gone is left out.
    expect(prompt).toContain('"tools": {\n        "mcp:browser": false\n      }');
    expect(prompt).not.toContain('/gone');
  });

  it("turns a member's \"tools\" into exceptions to its CLI's defaults", () => {
    expect(toolsFromLead(undefined, { 'mcp:browser': true, 'MCP:DB': true, 'skill:pdf': false, 'skill:nope': true, memory: 'yes' }, 'codex', library)).toEqual({
      'mcp:srv1': true,
      'mcp:srv2': true,
      'skill:/skills/pdf': false,
    });
    // Back to the default drops the exception; others stay; another CLI's memory is ignored.
    expect(toolsFromLead({ 'mcp:srv1': false, 'skill:/skills/pdf': false }, { 'mcp:browser': true, 'memory:codex': false }, 'claude', library)).toEqual({ 'skill:/skills/pdf': false });
    expect(toolsFromLead({ memory: false }, { 'memory:codex': false }, 'codex', library)).toEqual({ memory: false, 'memory:codex': false });
    // Without the library nothing is taken from the lead, and what the member has stays.
    expect(toolsFromLead({ memory: false }, { 'mcp:browser': true }, 'claude', undefined)).toEqual({ memory: false });
    expect(toolsFromLead(undefined, ['mcp:browser'], 'claude', library)).toBeUndefined();
  });

  it("gives a designed member the tools the lead names, and a revision changes only those", () => {
    const withLibrary: PlannerContext = { ...ctx, library };
    const d = decidePlan(
      { choice: 'custom', name: 'T', agents: [{ name: 'Web', provider: 'codex', role: 'Browse', tools: { 'mcp:browser': true, memory: false } }], reason: 'r' },
      withLibrary,
      lead,
    );
    expect(d.agents[0]!.tools).toEqual({ 'mcp:srv1': true, memory: false });

    const draft: TeamDraft = { settings: { mode: 'roundtable', rounds: 1, maxHops: 8 }, agents: [{ id: 'a1', name: 'Ann', provider: 'claude', role: 'R', tools: { 'skill:/skills/pdf': false } }] };
    const kept = decideRevision({ agents: [{ name: 'Ann', provider: 'claude' }] }, draft, withLibrary, lead);
    expect(kept.agents[0]!.tools).toEqual({ 'skill:/skills/pdf': false });
    const changed = decideRevision({ agents: [{ name: 'Ann', provider: 'claude', tools: { 'mcp:browser': false } }] }, draft, withLibrary, lead);
    expect(changed.agents[0]!.tools).toEqual({ 'skill:/skills/pdf': false, 'mcp:srv1': false });
    const reset = decideRevision({ agents: [{ name: 'Ann', provider: 'claude', tools: { 'skill:pdf': true } }] }, draft, withLibrary, lead);
    expect(reset.agents[0]!.tools).toBeUndefined();
  });

  it('gathers the context: CLIs with a usable account, their tools in the folder, the library; a CLI that does not say in time is left out', async () => {
    const account = (id: string, loggedIn: boolean) => ({ id, label: '', auth: { loggedIn }, usingStoredApiKey: false });
    const asked: string[] = [];
    const src: PlannerSources = {
      statuses: async () => [
        { provider: 'claude', installed: true, bin: 'claude', auth: { loggedIn: true }, usingStoredApiKey: false, accounts: [account('', true)] },
        { provider: 'codex', installed: true, bin: 'codex', auth: { loggedIn: false }, usingStoredApiKey: false, accounts: [account('', false), account('w1', true)] },
        { provider: 'grok', installed: true, bin: 'grok', auth: { loggedIn: false }, usingStoredApiKey: false, accounts: [account('', false)] },
      ],
      catalog: async () => catalog,
      presets: () => [],
      library: () => ({ mcpServers: [], skills: [], memory: { all: 'notes', claude: '', codex: '', grok: '' } }),
      native: async (p, cwd) => {
        asked.push(`${p} ${cwd}`);
        if (p === 'codex') return new Promise(() => {}); // never answers
        return { skills: [{ name: 'commit', description: '' }], mcpServers: [], builtinTools: [{ name: 'Bash' }], problems: [] };
      },
    };
    const got = await plannerContext(src, '/work', 50);
    expect(got.available).toEqual(['claude', 'codex']);
    expect(got.accounts).toEqual({ claude: [''], codex: ['w1'] });
    expect(asked).toEqual(['claude /work', 'codex /work']); // grok cannot run: not asked
    expect(got.native).toEqual({ claude: { builtinTools: ['Bash'], skills: [{ name: 'commit', description: '' }], mcpServers: [] } });
    expect(got.library).toEqual([{ name: 'memory', key: 'memory', about: 'notes', providers: ['claude', 'codex', 'grok'] }]);
    // A CLI that answered nothing at all is unknown, not one without tools; without a folder nothing is asked.
    const silent = await plannerContext({ ...src, native: async () => ({ skills: [], mcpServers: [], problems: [{ kind: 'timeout' }] }) }, '/work', 50);
    expect(silent.native).toEqual({});
    asked.length = 0;
    expect((await plannerContext(src)).native).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
