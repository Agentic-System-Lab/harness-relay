import { describe, expect, it } from 'vitest';
import { PROVIDERS, type ProviderModels } from '../src/shared/types';
import { familiesForLead, familyOf, guideMark, modelFamily, ROLE_GUIDES, roleGuidesForLead, unlistedFamily, type ModelFamily } from '../src/server/roleGuides';

describe('the family of a model', () => {
  it('is read from the ids each CLI lists', () => {
    for (const id of ['opus', 'fable', 'haiku', 'opus[1m]', 'sonnet[1m]', 'opusplan', 'claude-sonnet-5-5', 'claude-haiku-4.5', 'anthropic/claude-haiku-5-5', 'sonnet-4.5-thinking'])
      expect(modelFamily(id), id).toBe('claude');
    for (const id of ['gpt-5.3-codex', 'gpt-6-sol', 'gpt-5.4-nano', 'gpt5', 'gpt4o', 'o3-pro', 'openai/gpt-5.4-nano', 'codex-mini-latest', 'chatgpt-4o-latest'])
      expect(modelFamily(id), id).toBe('gpt');
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
    for (const id of ['default', 'auto', '', 'cursor-fake', 'opusx', 'museum']) expect(modelFamily(id), id).toBeUndefined();
  });

  it("of a CLI's model is read without the API or endpoint it is on", () => {
    // An endpoint's id does not count: a gateway there may serve Claude.
    expect(familyOf('claude', 'qwen-box/claude-sonnet-5', { endpoint: 'qwen-box' })).toBe('claude');
    expect(familyOf('codex', 'homelab/my-finetune', { endpoint: 'homelab' })).toBe('open');
    // An open agent's `<backend>/<model>`: open weights on an endpoint, the API's family when the name says nothing.
    expect(familyOf('goose', 'homelab/muse-glimmer-30b-nvfp4')).toBe('open');
    expect(familyOf('goose', 'xai/unnamed-1')).toBe('grok');
    expect(familyOf('pi', 'anthropic/some-model')).toBe('claude');
    expect(familyOf('opencode', 'openai/gpt-5.4')).toBe('gpt');
    // Other CLIs' ids are names.
    expect(familyOf('cursor', 'default')).toBeUndefined();
    expect(familyOf('copilot', 'claude-sonnet-5.5')).toBe('claude');
  });
});

describe('the families the lead reads guides for', () => {
  const claude: ProviderModels = { provider: 'claude', models: [{ id: 'opus' }, { id: 'sonnet' }], efforts: [], source: 'builtin' };

  it('are those of the models the available CLIs offer, in a fixed order', () => {
    const cursor: ProviderModels = { provider: 'cursor', models: [{ id: 'default' }, { id: 'gpt-6-sol' }, { id: 'composer-1' }, { id: 'claude-sonnet-5-5' }], efforts: [], source: 'cli' };
    expect(familiesForLead({ available: ['claude'], catalog: [claude, cursor] })).toEqual(['claude']);
    expect(familiesForLead({ available: ['cursor', 'claude'], catalog: [claude, cursor] })).toEqual(['claude', 'gpt', 'composer']);
    // Unknown availability: every CLI.
    expect(familiesForLead({ available: [], catalog: [cursor] })).toEqual(['claude', 'gpt', 'gemini', 'grok', 'muse', 'composer']);
  });

  it("are a CLI's own family when it lists none of its own models, and none for a CLI with no family of its own", () => {
    expect(familiesForLead({ available: ['codex', 'antigravity', 'muse'], catalog: [] })).toEqual(['gpt', 'gemini', 'muse']);
    expect(familiesForLead({ available: ['copilot', 'opencode'], catalog: [] })).toEqual([]);
    // Its own list failed, its endpoint models are still there: its own models are still its family.
    const failed: ProviderModels = { provider: 'codex', models: [{ id: 'homelab/qwen3-coder', endpoint: 'homelab' }], efforts: [], source: 'builtin' };
    expect(familiesForLead({ available: ['codex'], catalog: [failed] })).toEqual(['gpt', 'open']);
    expect(unlistedFamily('codex', failed)).toBe('gpt');
    expect(unlistedFamily('codex', { models: [{ id: 'gpt-5.4' }] })).toBeUndefined();
    expect(unlistedFamily('cursor', { models: [] })).toBeUndefined();
  });

  it("follow a CLI's endpoint models and an open agent's backends", () => {
    const withEndpoint: ProviderModels = { ...claude, models: [...claude.models, { id: 'homelab/my-finetune', endpoint: 'homelab' }] };
    expect(familiesForLead({ available: ['claude'], catalog: [withEndpoint] })).toEqual(['claude', 'open']);
    const gateway: ProviderModels = { ...claude, models: [{ id: 'opus' }, { id: 'qwen-box/claude-sonnet-5', endpoint: 'qwen-box' }] };
    expect(familiesForLead({ available: ['claude'], catalog: [gateway] })).toEqual(['claude']);
    const goose: ProviderModels = { provider: 'goose', models: [{ id: 'xai/grok-4.3' }, { id: 'homelab/muse-glimmer-30b-nvfp4' }, { id: 'homelab/tiny' }], efforts: [], source: 'cli' };
    // Meta's open Muse models on the user's own server are open weights, unlike the ones Muse Code runs.
    expect(familiesForLead({ available: ['goose'], catalog: [goose] })).toEqual(['grok', 'open']);
    expect(familiesForLead({ available: ['goose'], catalog: [{ ...goose, models: [{ id: 'openai/gpt-5.4' }, { id: 'xai/unnamed-1' }] }] })).toEqual(['gpt', 'grok']);
  });

  it('read the models of the account new members get, and the default it runs', () => {
    const other: ProviderModels = { provider: 'codex', account: 'work', models: [{ id: 'gpt-5.4' }], efforts: [], defaultModel: 'homelab/qwen3-coder', source: 'cli' };
    const mine: ProviderModels = { provider: 'codex', models: [{ id: 'gpt-5.4' }], efforts: [], source: 'cli' };
    expect(familiesForLead({ available: ['codex'], catalog: [mine, other], accounts: { codex: ['work'] } })).toEqual(['gpt', 'open']);
    expect(familiesForLead({ available: ['codex'], catalog: [mine, other], accounts: { codex: [''] } })).toEqual(['gpt']);
  });
});

describe('the guides the lead reads', () => {
  const line = (f: ModelFamily, edits = true) => `- ${ROLE_GUIDES[f].label} (${ROLE_GUIDES[f].about}): ${ROLE_GUIDES[f].text(edits)}`;

  it('are those of the families given only, in a fixed order, each named as its models are marked', () => {
    const text = roleGuidesForLead(['open', 'claude'], 'edit');
    expect(text).toContain('follow the guide that model is marked with above ("guide: …")');
    expect(text).toContain('A model marked with none (such as Auto, which picks a model by itself) follows none of them.');
    expect(text).toContain(`${line('claude')}\n${line('open')}\n`);
    for (const f of ['gpt', 'gemini', 'grok', 'muse', 'composer'] as const) expect(text).not.toContain(ROLE_GUIDES[f].about);
    for (const f of Object.keys(ROLE_GUIDES) as ModelFamily[]) expect(guideMark(f)).toBe(`guide: ${ROLE_GUIDES[f].label}`);
  });

  it('are nothing when no family is known', () => {
    expect(roleGuidesForLead([], 'full')).toBe('');
  });

  it('ask for edits only when the team may edit', () => {
    const all = Object.keys(ROLE_GUIDES) as ModelFamily[];
    const readOnly = roleGuidesForLead(all, 'read-only');
    for (const asks of ['Ask for the action itself', 'make the changes itself', 'the files it may change']) {
      expect(readOnly, asks).not.toContain(asks);
      expect(roleGuidesForLead(all, 'edit'), asks).toContain(asks);
      expect(roleGuidesForLead(all, 'full'), asks).toContain(asks);
    }
    expect(readOnly).toContain('Tell it to read the files it needs with its tools instead of guessing.');
  });

  it('each stay short', () => {
    for (const [f, guide] of Object.entries(ROLE_GUIDES))
      for (const edits of [true, false]) expect(guide.text(edits).split(/\s+/).length, f).toBeLessThanOrEqual(110);
  });

  it('cover every CLI with a family of its own', () => {
    // Claude Code, Codex, Grok, Antigravity and Muse Code run their own family when they list no models.
    expect(PROVIDERS.filter((p) => unlistedFamily(p, undefined))).toEqual(['claude', 'codex', 'grok', 'antigravity', 'muse']);
  });
});
