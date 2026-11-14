import { describe, expect, it } from 'vitest';
import type { ProviderModels } from '../src/shared/types';
import { familiesForLead, modelFamily, ROLE_GUIDES, roleGuidesForLead } from '../src/server/roleGuides';

describe('the family of a model', () => {
  it('is read from the ids each CLI lists', () => {
    for (const id of ['opus', 'fable', 'haiku', 'claude-sonnet-5-5', 'claude-haiku-4.5', 'anthropic/claude-haiku-5-5', 'sonnet-4.5-thinking']) expect(modelFamily(id), id).toBe('claude');
    for (const id of ['gpt-5.3-codex', 'gpt-6-sol', 'gpt-5.4-nano', 'o3-pro', 'openai/gpt-5.4-nano', 'codex-mini-latest']) expect(modelFamily(id), id).toBe('gpt');
    for (const id of ['gemini-3.1-pro', 'gemini-4-argon', 'gemini-3.8-flash']) expect(modelFamily(id), id).toBe('gemini');
    for (const id of ['grok-4.3', 'grok-code-fast-1', 'xai/grok-4.20-0309-non-reasoning']) expect(modelFamily(id), id).toBe('grok');
    for (const id of ['muse-spark-1.3', 'muse-spark-1.3-contributor', 'muse-wonder-1.0']) expect(modelFamily(id), id).toBe('muse');
    expect(modelFamily('composer-1')).toBe('composer');
  });

  it('is open for open weights, also on a gateway, and for anything else an endpoint serves', () => {
    for (const id of ['homelab/Qwen/Qwen3-30B-A3B', 'qwen3-coder', 'deepseek-v3.2', 'glm-5', 'kimi-k3', 'router/openai/gpt-oss-120b', 'llama3.3:70b', 'devstral-small'])
      expect(modelFamily(id), id).toBe('open');
    expect(modelFamily('router/anthropic/claude-sonnet-5', true)).toBe('claude');
    expect(modelFamily('homelab/my-finetune', true)).toBe('open');
    // Meta's and Cursor's names on the user's own server are open weights too.
    expect(modelFamily('homelab/muse-glimmer-30b-nvfp4', true)).toBe('open');
    expect(modelFamily('my-finetune')).toBeUndefined();
  });

  it('is none for a choice that names no model', () => {
    for (const id of ['default', 'auto', '', 'cursor-fake']) expect(modelFamily(id), id).toBeUndefined();
  });
});

describe('the families the lead reads guides for', () => {
  const claude: ProviderModels = { provider: 'claude', models: [{ id: 'opus' }, { id: 'sonnet' }], efforts: [], source: 'builtin' };

  it('are those of the models the available CLIs offer, in a fixed order', () => {
    const cursor: ProviderModels = { provider: 'cursor', models: [{ id: 'default' }, { id: 'gpt-6-sol' }, { id: 'composer-1' }, { id: 'claude-sonnet-5-5' }], efforts: [], source: 'cli' };
    expect(familiesForLead({ available: ['claude'], catalog: [claude, cursor] })).toEqual(['claude']);
    expect(familiesForLead({ available: ['cursor', 'claude'], catalog: [claude, cursor] })).toEqual(['claude', 'gpt', 'composer']);
  });

  it("are a CLI's own family when it lists no models, and none for a CLI with no family of its own", () => {
    expect(familiesForLead({ available: ['codex', 'antigravity', 'muse'], catalog: [] })).toEqual(['gpt', 'gemini', 'muse']);
    expect(familiesForLead({ available: ['copilot', 'opencode'], catalog: [] })).toEqual([]);
  });

  it("follow a CLI's endpoint models and an open agent's backends", () => {
    const withEndpoint: ProviderModels = { ...claude, models: [...claude.models, { id: 'homelab/my-finetune', endpoint: 'homelab' }] };
    expect(familiesForLead({ available: ['claude'], catalog: [withEndpoint] })).toEqual(['claude', 'open']);
    // The endpoint's own id does not count: a gateway there may serve Claude.
    const gateway: ProviderModels = { ...claude, models: [{ id: 'qwen-box/claude-sonnet-5', endpoint: 'qwen-box' }] };
    expect(familiesForLead({ available: ['claude'], catalog: [gateway] })).toEqual(['claude']);
    const goose: ProviderModels = { provider: 'goose', models: [{ id: 'xai/grok-4.3' }, { id: 'homelab/muse-glimmer-30b-nvfp4' }, { id: 'homelab/tiny' }], efforts: [], source: 'cli' };
    // Through a model API: that API's family when the name says nothing.
    expect(familiesForLead({ available: ['goose'], catalog: [{ ...goose, models: [{ id: 'openai/gpt-5.4' }, { id: 'xai/unnamed-1' }] }] })).toEqual(['gpt', 'grok']);
    // Meta's open Muse models on the user's own server are open weights, unlike the ones Muse Code runs.
    expect(familiesForLead({ available: ['goose'], catalog: [goose] })).toEqual(['grok', 'open']);
  });

  it("read the models of the account new members get, and the default it runs", () => {
    const other: ProviderModels = { provider: 'codex', account: 'work', models: [{ id: 'gpt-5.4' }], efforts: [], defaultModel: 'homelab/qwen3-coder', source: 'cli' };
    const mine: ProviderModels = { provider: 'codex', models: [{ id: 'gpt-5.4' }], efforts: [], source: 'cli' };
    expect(familiesForLead({ available: ['codex'], catalog: [mine, other], accounts: { codex: ['work'] } })).toEqual(['gpt', 'open']);
    expect(familiesForLead({ available: ['codex'], catalog: [mine, other], accounts: { codex: [''] } })).toEqual(['gpt']);
  });
});

describe("the guides the lead reads", () => {
  it('are those of the families given only, in a fixed order, after what holds for every role', () => {
    const text = roleGuidesForLead(['open', 'claude']);
    expect(text).toContain('How to write each role for the model its member runs on (its "model", else its coding agent\'s default model)');
    expect(text).toContain('say only what is particular to the member, and do not repeat or contradict those.');
    expect(text.indexOf(ROLE_GUIDES.claude)).toBeGreaterThan(text.indexOf('particular to the member'));
    expect(text.indexOf(ROLE_GUIDES.open)).toBeGreaterThan(text.indexOf(ROLE_GUIDES.claude));
    for (const f of ['gpt', 'gemini', 'grok', 'muse', 'composer'] as const) expect(text).not.toContain(ROLE_GUIDES[f]);
  });

  it('are nothing when no family is known', () => {
    expect(roleGuidesForLead([])).toBe('');
  });

  it("each name their family and stay short", () => {
    const names = { claude: 'Claude (Anthropic)', gpt: 'GPT and Codex (OpenAI)', gemini: 'Gemini (Google)', grok: 'Grok (xAI)', muse: 'Muse (Meta)', composer: 'Composer (Cursor)', open: 'Open-weight and local models' };
    for (const [f, guide] of Object.entries(ROLE_GUIDES)) {
      expect(guide.startsWith(names[f as keyof typeof names]), f).toBe(true);
      expect(guide.split(/\s+/).length, f).toBeLessThanOrEqual(110);
    }
  });
});
