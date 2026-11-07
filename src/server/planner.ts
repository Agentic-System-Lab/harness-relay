import { randomUUID } from 'node:crypto';
import {
  PROVIDER_LABEL,
  effortsFor,
  type AgentConfig,
  type ConversationSettings,
  type LeadAgentSettings,
  type Mode,
  type Provider,
  type ProviderModels,
  type TeamPlan,
  type TeamPreset,
} from '../shared/types';
import { t } from './i18n';
import { validateAgents } from './validate';

/*
 * Auto team: before anyone answers the first message of an auto-team conversation, the lead agent
 * (Settings) either picks one of the templates or designs a team for the question. Its reply is a
 * JSON object, turned here into a team that can actually run: only signed-in CLIs, only models and
 * efforts those CLIs offer. Anything unusable falls back to the general-question template.
 */

/** What the lead agent may choose from. */
export interface PlannerContext {
  /** CLIs that are installed and signed in; empty = unknown (nothing is remapped). */
  available: Provider[];
  catalog: ProviderModels[];
  presets: TeamPreset[];
}

/** The parts of a TeamPlan the planner decides. */
export type PlanDecision = Required<Pick<TeamPlan, 'source' | 'name' | 'reason' | 'settings' | 'agents'>> &
  Pick<TeamPlan, 'presetId' | 'description'>;

const MODES: Mode[] = ['roundtable', 'parallel', 'relay'];
const FALLBACK_PRESET = 'builtin-general';
const MAX_MEMBERS = 5;

export const PLANNER_BRIEFING =
  'You are the lead agent of Harness Relay, a group chat in which coding-agent CLIs (Claude Code, Codex, Grok) ' +
  'work together on the user\'s questions. Right now your only job is to choose the team for a new conversation. ' +
  'Do not answer the user\'s question yourself. Reply with the JSON object you are asked for and nothing else.';

const MODE_HELP: Record<Mode, string> = {
  roundtable: 'members speak one after another in order, each seeing what earlier speakers said; `rounds` (1-5) passes',
  parallel: 'members answer at the same time, independently; later rounds see the earlier answers; good for comparing approaches',
  relay: 'one member at a time; a member hands off by @mentioning a teammate; the first member leads; `maxHops` (1-30) caps the hand-offs',
};

function firstLine(s: string, n = 140): string {
  const line = s.trim().split('\n')[0] ?? '';
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}

export function buildPlannerPrompt(question: string, settings: ConversationSettings, ctx: PlannerContext): string {
  const available = ctx.available.length ? ctx.available : (Object.keys(PROVIDER_LABEL) as Provider[]);
  const agents = available
    .map((p) => {
      const c = ctx.catalog.find((x) => x.provider === p);
      const models = c?.models.map((m) => m.id).join(', ');
      return `- ${p} (${PROVIDER_LABEL[p]})${models ? `: models ${models}` : ''}${c?.defaultModel ? `; default model ${c.defaultModel}` : ''}${
        c?.efforts.length ? `; efforts ${c.efforts.join(', ')}` : ''
      }`;
    })
    .join('\n');
  const templates = ctx.presets
    .map((p) => {
      const members = p.agents.map((a) => `${a.name} (${a.provider}): ${firstLine(a.role, 100)}`).join('; ');
      const rounds = p.settings.mode === 'relay' ? `maxHops ${p.settings.maxHops}` : `rounds ${p.settings.rounds}`;
      return `- id "${p.id}" — ${p.name}: ${p.description ?? ''} [${p.settings.mode}, ${rounds}] Members: ${members}`;
    })
    .join('\n');

  return `The user just started a new conversation. Choose the team that should answer it: reuse one of the templates below, or design a better-suited team.

<first_message>
${question}
</first_message>

Coding agents you can use (only these):
${agents}

Conversation modes:
${MODES.map((m) => `- ${m}: ${MODE_HELP[m]}`).join('\n')}

The user already chose the file permission "${settings.permission}" and the working directory ${settings.cwd}; you cannot change them.

Templates:
${templates}

How to decide:
- Use a template when one fits the question well. Design a custom team when the question needs different expertise, a different number of members, or a different way of working.
- Keep it proportionate: a simple question needs 1-2 members and one round; reserve big teams and several rounds for hard or open-ended problems. At most ${MAX_MEMBERS} members.
- Mixing coding agents helps: different models catch different things.
- For a custom team, write each member's role as instructions addressed to that member: their expertise, what to focus on, and who to hand off to with @Name when the mode is relay. Write roles, the team name, the description and the reason in the language of the user's message.
- Member names: letters, digits, _ or - only (no spaces), unique, e.g. Researcher, Backend_Dev.
- Leave "model" and "effort" out unless the question clearly needs a stronger or faster model than the default.
- Do not use tools unless the choice depends on the files in the working directory.

Reply with only this JSON object, in a \`\`\`json code block:
- to use a template: {"choice": "template", "templateId": "<id>", "reason": "<one or two sentences for the user>"}
- to design a team: {"choice": "custom", "name": "<short team name>", "description": "<one line>", "mode": "roundtable" | "parallel" | "relay", "rounds": <1-5>, "maxHops": <1-30>, "agents": [{"name": "<Name>", "provider": "claude" | "codex" | "grok", "role": "<instructions>", "model": "<optional>", "effort": "<optional>"}], "reason": "<one or two sentences for the user>"}`;
}

/** The JSON object in the lead's reply (a ```json block, or the outermost braces). */
export function parsePlanReply(text: string): Record<string, any> {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = [...blocks.reverse()];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(t().planUnparsable);
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Make members runnable here: signed-in CLIs only, and only models / efforts those CLIs offer. */
export function fitAgents(agents: AgentConfig[], ctx: PlannerContext, lead: LeadAgentSettings): AgentConfig[] {
  const fallbackProvider = ctx.available.includes(lead.provider) ? lead.provider : (ctx.available[0] ?? lead.provider);
  return agents.map((a) => {
    const out: AgentConfig = { ...a, id: randomUUID() };
    if (ctx.available.length && !ctx.available.includes(out.provider)) {
      out.provider = fallbackProvider;
      out.model = undefined;
      out.effort = undefined;
    }
    const c = ctx.catalog.find((x) => x.provider === out.provider);
    if (out.model && c?.models.length && !c.models.some((m) => m.id === out.model)) out.model = undefined;
    if (out.effort && c) {
      const efforts = effortsFor(c, out.model || c.defaultModel);
      if (efforts.length && !efforts.includes(out.effort)) out.effort = undefined;
    }
    return out;
  });
}

/** Turn the lead's JSON into a team. Throws (with a user-readable message) when it is unusable. */
export function decidePlan(raw: Record<string, any>, ctx: PlannerContext, lead: LeadAgentSettings): PlanDecision {
  const reason = String(raw.reason ?? '').trim().slice(0, 800);
  if (raw.choice === 'template') {
    const id = String(raw.templateId ?? '');
    const preset = ctx.presets.find((p) => p.id === id);
    if (!preset) throw new Error(t().planUnknownTemplate(id));
    return {
      source: 'template',
      presetId: preset.id,
      name: preset.name,
      description: preset.description,
      reason,
      settings: { mode: preset.settings.mode, rounds: preset.settings.rounds, maxHops: preset.settings.maxHops },
      agents: fitAgents(preset.agents, ctx, lead),
    };
  }
  const members = Array.isArray(raw.agents) ? raw.agents.slice(0, MAX_MEMBERS) : [];
  const agents = validateAgents(
    members.map((a: any) => ({
      name: String(a?.name ?? '').replace(/\s+/g, '_'),
      provider: String(a?.provider ?? '').toLowerCase(),
      role: String(a?.role ?? ''),
      model: a?.model ? String(a.model) : undefined,
      effort: a?.effort ? String(a.effort).toLowerCase() : undefined,
    })),
  );
  const mode: Mode = MODES.includes(raw.mode) ? raw.mode : 'roundtable';
  return {
    source: 'custom',
    name: String(raw.name ?? '').trim().slice(0, 80) || agents.map((a) => a.name).join(' · '),
    description: String(raw.description ?? '').trim().slice(0, 200) || undefined,
    reason,
    settings: { mode, rounds: clampInt(raw.rounds, 1, 5, 1), maxHops: clampInt(raw.maxHops, 1, 30, 8) },
    agents: fitAgents(agents, ctx, lead),
  };
}

/** The general-question template, used when planning fails. */
export function fallbackPlan(ctx: PlannerContext, lead: LeadAgentSettings, why: string): PlanDecision {
  const preset = ctx.presets.find((p) => p.id === FALLBACK_PRESET) ?? ctx.presets[0]!;
  return {
    source: 'fallback',
    presetId: preset.id,
    name: preset.name,
    description: preset.description,
    reason: t().planFailed(why),
    settings: { mode: preset.settings.mode, rounds: preset.settings.rounds, maxHops: preset.settings.maxHops },
    agents: fitAgents(preset.agents, ctx, lead),
  };
}
