import { describe, expect, it } from 'vitest';
import type { ProviderModels } from '../src/shared/types';
import { withLang } from '../src/server/i18n';
import { buildPlannerPrompt, decidePlan, fallbackPlan, fitAgents, parsePlanReply, type PlannerContext } from '../src/server/planner';
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

  it('tells the lead what it can use and asks for JSON', () => {
    const prompt = buildPlannerPrompt('How do I bake bread?', { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'read-only', cwd: '/tmp' }, ctx);
    expect(prompt).toContain('How do I bake bread?');
    expect(prompt).toContain('- claude (Claude Code): models opus, haiku');
    expect(prompt).not.toContain('- grok');
    expect(prompt).toContain('id "builtin-general"');
    expect(prompt).toContain('"read-only"');
    expect(prompt).toContain('```json');
  });
});
