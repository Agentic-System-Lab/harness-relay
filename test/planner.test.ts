import { describe, expect, it } from 'vitest';
import { planSavable, type ProviderModels, type TeamPreset } from '../src/shared/types';
import { withLang } from '../src/server/i18n';
import { buildPlannerPrompt, decidePlan, fallbackPlan, fitAgents, parsePlanReply, sameTeam, type PlannerContext } from '../src/server/planner';
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
