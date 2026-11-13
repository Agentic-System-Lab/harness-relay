import { PROVIDERS, accountUsable, type AgentConfig, type ConversationSettings, type Provider, type ProviderStatus } from '../shared/types';
import { newAgent, readyAccount } from './util';

/**
 * The CLIs a member can run on here, in Settings' order: installed, with an account ready to use;
 * undefined while their statuses have not come yet (none listed).
 */
export function readyProviders(providers: ProviderStatus[]): Provider[] | undefined {
  if (!providers.length) return undefined;
  return PROVIDERS.filter((p) => providers.some((s) => s.provider === p && s.installed && s.accounts.some(accountUsable)));
}

/**
 * A new template's members: one for each CLI ready here, on its first ready account, roles left to
 * the user. None while the statuses have not come yet, nor when no CLI is ready: never one on a CLI
 * that cannot run here.
 */
export function blankAgents(providers: ProviderStatus[]): AgentConfig[] {
  const agents: AgentConfig[] = [];
  for (const p of readyProviders(providers) ?? []) {
    const agent = newAgent(p, agents.map((a) => a.name));
    const account = readyAccount(providers.find((s) => s.provider === p));
    agents.push(account ? { ...agent, account } : agent);
  }
  return agents;
}

/**
 * A template's members as the editor opens it: each one on a CLI that cannot run here (not
 * installed, or no account ready) moves to one that can, its model and effort left to that CLI (the
 * lead agent, using a template, moves them to its own CLI: `fitAgents`). Members that shared a CLI stay
 * together, and a CLI the template does not use yet is taken first, so that a team of different CLIs
 * (a debate, a comparison) stays one of different CLIs while it can. Nothing moves while the statuses
 * have not come yet, or when no CLI is ready. `moved`: the names of the members that moved.
 */
export function fitTemplateAgents(agents: AgentConfig[], providers: ProviderStatus[]): { agents: AgentConfig[]; moved: string[] } {
  const ready = readyProviders(providers);
  if (!ready?.length) return { agents, moved: [] };
  const spare = ready.filter((p) => !agents.some((a) => a.provider === p));
  const instead = new Map<Provider, Provider>();
  let next = 0;
  const moved: string[] = [];
  const fitted = agents.map((a) => {
    if (ready.includes(a.provider)) return a;
    let to = instead.get(a.provider);
    if (!to) {
      to = spare.shift() ?? ready[next++ % ready.length]!;
      instead.set(a.provider, to);
    }
    moved.push(a.name);
    const { model: _model, effort: _effort, account: _account, ...rest } = a;
    const account = readyAccount(providers.find((s) => s.provider === to));
    return { ...rest, provider: to, ...(account ? { account } : {}) };
  });
  return { agents: fitted, moved };
}

/** What the template editor holds. */
export interface TemplateDraft {
  name: string;
  description: string;
  agents: AgentConfig[];
  settings: Pick<ConversationSettings, 'mode' | 'rounds' | 'maxHops'>;
}

/**
 * A template's content, to tell whether the editor changed anything: member ids, spaces around the
 * text and empty optional fields do not count.
 */
export function templateKey(d: TemplateDraft): string {
  return JSON.stringify({
    name: d.name.trim(),
    description: d.description.trim(),
    mode: d.settings.mode,
    rounds: d.settings.rounds,
    maxHops: d.settings.maxHops,
    agents: d.agents.map((a) => ({
      name: a.name,
      provider: a.provider,
      role: a.role.trim(),
      model: a.model || null,
      effort: a.effort || null,
      tools: Object.entries(a.tools ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    })),
  });
}
