import { describe, expect, it } from 'vitest';
import type { ProviderModels } from '../src/shared/types';
import { en } from '../src/web/locales/en';
import { inheritModelLabel, switchProvider } from '../src/web/util';

describe('switching an agent to another CLI', () => {
  it('restores the model and effort picked for a CLI when switching back to it', () => {
    const lead = { provider: 'claude' as const, model: '', effort: 'xhigh' };
    const toCodex = switchProvider(lead, 'codex', {});
    expect(toCodex.value).toEqual({ provider: 'codex', model: '', effort: '' });
    const picked = { ...toCodex.value, model: 'gpt-5', effort: 'high' };
    const back = switchProvider(picked, 'claude', toCodex.kept);
    expect(back.value).toEqual({ provider: 'claude', model: '', effort: 'xhigh' });
    // And Codex keeps what was picked for it.
    expect(switchProvider(back.value, 'codex', back.kept).value).toEqual({ provider: 'codex', model: 'gpt-5', effort: 'high' });
  });

  it("starts a CLI never picked with its defaults, and keeps the agent's other fields", () => {
    const agent = { id: 'a', name: 'Ann', role: 'Reviews', provider: 'claude' as const, model: 'opus', effort: 'max', tools: { memory: false } };
    const { value } = switchProvider(agent, 'grok', {});
    expect(value).toEqual({ id: 'a', name: 'Ann', role: 'Reviews', provider: 'grok', model: '', effort: '', tools: { memory: false } });
  });

  it('treats a model or effort left unset as the default', () => {
    const lead = { provider: 'grok' as const };
    const away = switchProvider(lead, 'claude', {});
    expect(away.kept.grok).toEqual({ model: '', effort: '' });
    expect(switchProvider(away.value, 'grok', away.kept).value).toEqual({ provider: 'grok', model: '', effort: '' });
  });
});

describe("the model picker's default", () => {
  const t = en;
  const pm = (over: Partial<ProviderModels> = {}): ProviderModels => ({ provider: 'opencode', models: [], efforts: [], source: 'cli', ...over });

  it('names the model an open agent then runs on, and says it needs one when there is none', () => {
    expect(inheritModelLabel(pm({ defaultModel: 'openai/gpt-5.4-nano' }), 'opencode', t)).toBe(t.team.defaultModel('openai/gpt-5.4-nano'));
    expect(inheritModelLabel(pm(), 'opencode', t)).toBe(t.team.noDefaultModel);
    // The other CLIs choose their own default.
    expect(inheritModelLabel(pm({ provider: 'claude' }), 'claude', t)).toBe(t.team.defaultModel(t.team.cliDecides));
    expect(inheritModelLabel(undefined, 'goose', t)).toBe(t.team.defaultModel(t.common.loading));
  });
});
