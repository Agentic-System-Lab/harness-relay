import type { AgentConfig, ConversationSettings } from '../shared/types';

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
