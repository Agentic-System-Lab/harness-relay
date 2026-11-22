import { describe, expect, it } from 'vitest';
import { AGENT_LIMITS, PROVIDERS, agentLimitsFor, type AgentConfig } from '../src/shared/types';
import { revisedTeam } from '../src/web/chat';
import { teamProblems } from '../src/web/components/TeamEditor';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import { limitProblem, limitSpecOf, limitText, limitsFromText, limitsKey } from '../src/web/memberLimits';
import { templateKey } from '../src/web/templates';

/* A member's own limit in the team editor (`src/web/memberLimits.ts`, for `components/TeamEditor.tsx`). */

const claude: AgentConfig = { id: 'c', name: 'Coder', provider: 'claude', role: '' };

describe("a member's own limit", () => {
  it('is offered only for the CLIs that have one, each with its own unit and bounds', () => {
    expect(PROVIDERS.filter((p) => limitSpecOf({ provider: p }))).toEqual(['claude', 'copilot', 'opencode', 'goose']);
    expect(AGENT_LIMITS.claude).toMatchObject({ key: 'usd', integer: false, notOnEndpoint: true });
    expect(AGENT_LIMITS.copilot).toMatchObject({ key: 'aiCredits', min: 30, integer: true, notOnEndpoint: true });
    expect(AGENT_LIMITS.goose).toMatchObject({ key: 'steps', integer: true });
    expect(AGENT_LIMITS.opencode).toMatchObject({ key: 'steps', integer: true });
    // Each CLI with a limit has its label and what it does, in both languages.
    for (const t of [en, zhTW])
      for (const p of Object.keys(AGENT_LIMITS)) {
        expect(t.team.limit.label[p as keyof typeof t.team.limit.label]).toBeTruthy();
        expect(t.team.limit.hint[p as keyof typeof t.team.limit.hint](1, 2)).toMatch(/1.*2/);
      }
  });

  it('reads what is typed, keeps a value out of bounds as typed (a problem), and empties to none', () => {
    expect(limitText(claude)).toBe('');
    const set = { ...claude, limits: limitsFromText(claude, '2.5') };
    expect(set.limits).toEqual({ usd: 2.5 });
    expect(limitText(set)).toBe('2.5');
    expect(limitProblem(set)).toBeUndefined();
    const tooLow = { ...claude, limits: limitsFromText(claude, '0') };
    expect(tooLow.limits).toEqual({ usd: 0 });
    expect(limitProblem(tooLow)).toBe(AGENT_LIMITS.claude);
    expect(limitsFromText(set, '')).toBeUndefined();
    expect(limitsFromText(set, 'abc')).toBeUndefined();
    // Copilot's is a whole number of at least 30.
    const pilot: AgentConfig = { id: 'p', name: 'Pilot', provider: 'copilot', role: '' };
    expect(limitProblem({ ...pilot, limits: { aiCredits: 30.5 } })).toBe(AGENT_LIMITS.copilot);
    expect(limitProblem({ ...pilot, limits: { aiCredits: 29 } })).toBe(AGENT_LIMITS.copilot);
    expect(limitProblem({ ...pilot, limits: { aiCredits: 30 } })).toBeUndefined();
  });

  it("keeps another CLI's limit the member was on, for when it goes back, but runs and compares by its own", () => {
    const moved: AgentConfig = { ...claude, provider: 'goose', limits: { usd: 2 } };
    expect(limitText(moved)).toBe('');
    expect(limitsFromText(moved, '40')).toEqual({ usd: 2, steps: 40 });
    expect(limitsFromText(moved, '')).toEqual({ usd: 2 });
    expect(agentLimitsFor('goose', { usd: 2, steps: 40 })).toEqual({ steps: 40 });
    expect(limitsKey(moved)).toEqual([]);
    expect(limitsKey({ ...moved, limits: { usd: 2, steps: 40 } })).toEqual([['steps', 40]]);
    // A CLI without a limit has no field: the member's limits stay as they are.
    const codex: AgentConfig = { ...claude, provider: 'codex', limits: { usd: 2 } };
    expect(limitsFromText(codex, '5')).toEqual({ usd: 2 });
  });

  it('stops the team from being saved while a limit is out of bounds, and says whose', () => {
    const team = (agents: AgentConfig[]) => ({
      agents,
      settings: { mode: 'roundtable' as const, rounds: 1, maxHops: 8, permission: 'edit' as const, cwd: '/work' },
    });
    expect(teamProblems(team([{ ...claude, limits: { usd: 2 } }]), en)).toEqual([]);
    expect(teamProblems(team([{ ...claude, limits: { usd: 0 } }]), en)).toEqual([
      "@Coder's limit must be a number from 0.01 to 10000, or empty for none",
    ]);
    expect(teamProblems(team([{ id: 'g', name: 'G', provider: 'goose', role: '', limits: { steps: 2.5 } }]), en)).toEqual([
      "@G's limit must be a whole number from 1 to 10000, or empty for none",
    ]);
  });

  it('counts as a change in a template, and as the same member after the lead changed the team', () => {
    const draft = { name: 'T', description: '', agents: [claude], settings: { mode: 'roundtable' as const, rounds: 1, maxHops: 8 } };
    expect(templateKey({ ...draft, agents: [{ ...claude, limits: { usd: 2 } }] })).not.toBe(templateKey(draft));
    // Another CLI's, kept from before: no change.
    expect(templateKey({ ...draft, agents: [{ ...claude, limits: { steps: 5 } }] })).toBe(templateKey(draft));
    const mine = { ...claude, limits: { usd: 2, steps: 5 } };
    const settings = { mode: 'roundtable' as const, rounds: 1, maxHops: 8, permission: 'edit' as const, cwd: '/work' };
    // The server keeps only its CLI's: the drawer's member stays, the same.
    expect(revisedTeam({ agents: [mine], settings }, { agents: [{ ...claude, limits: { usd: 2 } }], settings }).agents[0]).toBe(mine);
    expect(revisedTeam({ agents: [mine], settings }, { agents: [{ ...claude, limits: { usd: 3 } }], settings }).agents[0]).not.toBe(mine);
  });
});
