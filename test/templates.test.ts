import { describe, expect, it } from 'vitest';
import { PROVIDERS, type AgentConfig, type Provider, type ProviderStatus } from '../src/shared/types';
import { blankAgents, fitTemplateAgents, readyProviders, templateKey, type TemplateDraft } from '../src/web/templates';

/** Every CLI's status, as the server lists them: `ready` installed and signed in, `installed` only installed. */
function statuses(ready: Provider[], installed: Provider[] = []): ProviderStatus[] {
  return PROVIDERS.map((provider) => {
    const loggedIn = ready.includes(provider);
    return {
      provider,
      installed: loggedIn || installed.includes(provider),
      bin: provider,
      auth: { loggedIn },
      usingStoredApiKey: false,
      accounts: [{ id: '', label: '', auth: { loggedIn }, usingStoredApiKey: false }],
    };
  });
}

const member: AgentConfig = { id: 'a', name: 'Architect', provider: 'claude', role: 'Plan it.', model: 'opus', tools: { memory: true, 'mcp:x': false } };
const draft: TemplateDraft = {
  name: 'My team',
  description: 'For plans',
  agents: [member],
  settings: { mode: 'relay', rounds: 1, maxHops: 6 },
};
const key = (d: Partial<TemplateDraft>) => templateKey({ ...draft, ...d });

describe('telling whether a template was changed', () => {
  it('ignores member ids, spaces around the text and empty optional fields', () => {
    const same = templateKey(draft);
    expect(key({ agents: [{ ...member, id: 'fresh' }] })).toBe(same);
    expect(key({ name: ' My team ', description: 'For plans\n' })).toBe(same);
    expect(key({ agents: [{ ...member, role: 'Plan it.  ', tools: { 'mcp:x': false, memory: true } }] })).toBe(same);
    const bare = { ...member, model: undefined, effort: undefined, tools: undefined };
    expect(key({ agents: [{ ...bare, model: '', effort: '', tools: {} }] })).toBe(key({ agents: [bare] }));
  });

  it('sees any change to the name, description, members or how they take turns', () => {
    const same = templateKey(draft);
    for (const changed of [
      key({ name: 'My team 2' }),
      key({ description: '' }),
      key({ settings: { ...draft.settings, maxHops: 7 } }),
      key({ settings: { ...draft.settings, mode: 'roundtable' } }),
      key({ agents: [{ ...member, role: 'Build it.' }] }),
      key({ agents: [{ ...member, provider: 'codex' }] }),
      key({ agents: [{ ...member, effort: 'high' }] }),
      key({ agents: [{ ...member, tools: { memory: false } }] }),
      key({ agents: [member, { ...member, id: 'b', name: 'Builder' }] }),
    ]) {
      expect(changed).not.toBe(same);
    }
  });
});

describe('a template only on CLIs that can run here', () => {
  it('knows the ready CLIs (installed and signed in) once their statuses have come, in Settings’ order', () => {
    expect(readyProviders([])).toBeUndefined();
    expect(readyProviders(statuses(['grok', 'claude'], ['codex']))).toEqual(['claude', 'grok']);
    expect(readyProviders(statuses([]))).toEqual([]);
  });

  it('gives a new template one member per ready CLI, and none before the statuses come or when none is ready', () => {
    // The page had just loaded: no member at all, not one per CLI (the bug: all twelve, installed or not).
    expect(blankAgents([])).toEqual([]);
    expect(blankAgents(statuses([], ['codex']))).toEqual([]);
    const agents = blankAgents(statuses(['claude', 'cursor'], ['codex']));
    expect(agents.map((a) => a.provider)).toEqual(['claude', 'cursor']);
  });

  it("moves a template's members off CLIs that cannot run here, keeping a team of different CLIs different", () => {
    const debate: AgentConfig[] = [
      { id: '1', name: 'Proposer', provider: 'claude', role: 'Propose.', model: 'opus' },
      { id: '2', name: 'Pragmatist', provider: 'codex', role: 'Weigh it.', model: 'gpt-5', effort: 'high', account: 'other' },
      { id: '3', name: 'Skeptic', provider: 'grok', role: 'Doubt it.' },
    ];
    // Claude Code and Cursor ready, Codex installed but signed out, Grok missing: Codex's and Grok's
    // members move, first to the ready CLI the template does not use (Cursor), then back to the first.
    const fit = fitTemplateAgents(debate, statuses(['claude', 'cursor'], ['codex']));
    expect(fit.agents.map((a) => a.provider)).toEqual(['claude', 'cursor', 'claude']);
    expect(fit.moved).toEqual(['Pragmatist', 'Skeptic']);
    // A member that stays keeps everything; one that moves keeps its name and role, not its CLI's model, effort or account.
    expect(fit.agents[0]).toBe(debate[0]);
    expect(fit.agents[1]).toEqual({ id: '2', name: 'Pragmatist', provider: 'cursor', role: 'Weigh it.' });
    // Members that shared a CLI move together.
    const pair = fitTemplateAgents([{ ...debate[1]!, id: 'a' }, { ...debate[1]!, id: 'b', name: 'Second' }], statuses(['claude', 'cursor']));
    expect(pair.agents.map((a) => a.provider)).toEqual(['claude', 'claude']);
  });

  it('moves nothing when all can run, before the statuses come, or when no CLI is ready', () => {
    const team: AgentConfig[] = [{ id: '1', name: 'A', provider: 'codex', role: '' }];
    expect(fitTemplateAgents(team, statuses(['codex']))).toEqual({ agents: team, moved: [] });
    expect(fitTemplateAgents(team, [])).toEqual({ agents: team, moved: [] });
    expect(fitTemplateAgents(team, statuses([]))).toEqual({ agents: team, moved: [] });
  });
});
