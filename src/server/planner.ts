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
 * Auto team: the user's first message in an auto-team conversation describes what they need. The
 * lead agent (Settings) reads every template in full and either uses one as it is, adapts one to the
 * request, or designs a team from scratch; the user confirms the team before asking anything. Its reply is a JSON object, turned here into a team that can
 * actually run: only signed-in CLIs, only models and efforts those CLIs offer. Anything unusable
 * falls back to the general-question template.
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
  Pick<TeamPlan, 'presetId' | 'basedOn' | 'description'>;

const MODES: Mode[] = ['roundtable', 'parallel', 'relay'];
const FALLBACK_PRESET = 'builtin-general';
const MAX_MEMBERS = 5;

export const PLANNER_BRIEFING =
  'You are the lead agent of Harness Relay, a group chat in which coding-agent CLIs (Claude Code, Codex, Grok) ' +
  'work together on the user\'s questions. Right now your only job is to choose the team for a new conversation. ' +
  'Do not do the work the user describes yourself. Reply with the JSON object you are asked for and nothing else.';

const MODE_HELP: Record<Mode, string> = {
  roundtable: 'members speak one after another in order, each seeing what earlier speakers said; `rounds` (1-5) passes',
  parallel: 'members answer at the same time, independently; later rounds see the earlier answers; good for comparing approaches',
  relay: 'one member at a time; a member hands off by @mentioning a teammate; the first member leads; `maxHops` (1-30) caps the hand-offs',
};

/** A template as the lead sees it: everything in it, roles in full, so it can be reused or adapted. */
function templateForLead(p: TeamPreset): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    mode: p.settings.mode,
    ...(p.settings.mode === 'relay' ? { maxHops: p.settings.maxHops } : { rounds: p.settings.rounds }),
    agents: p.agents.map((a) => ({
      name: a.name,
      provider: a.provider,
      ...(a.model ? { model: a.model } : {}),
      ...(a.effort ? { effort: a.effort } : {}),
      role: a.role.trim(),
    })),
  };
}

const TEAM_FIELDS =
  '"name": "<short team name>", "description": "<one line>", "mode": "roundtable" | "parallel" | "relay", "rounds": <1-5>, "maxHops": <1-30>, ' +
  '"agents": [{"name": "<Name>", "provider": "claude" | "codex" | "grok", "role": "<instructions>", "model": "<optional>", "effort": "<optional>"}]';

export function buildPlannerPrompt(request: string, settings: ConversationSettings, ctx: PlannerContext): string {
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
  const templates = JSON.stringify(ctx.presets.map(templateForLead), null, 2);

  return `The user is starting a new conversation and has described what they need a team for. Choose that team: use one of the templates below as it is, adapt one of them to this request, or design a new team from scratch. The user reviews and confirms your team before asking anything, so design it for the work they described as a whole, not just its first step.

<request>
${request}
</request>

Coding agents you can use (only these):
${agents}

Conversation modes:
${MODES.map((m) => `- ${m}: ${MODE_HELP[m]}`).join('\n')}

The user already chose the file permission "${settings.permission}" and the working directory ${settings.cwd}; you cannot change them.

Templates (built-in and saved by the user), in full:
<templates>
${templates}
</templates>

How to decide: read the templates first, then pick exactly one of these three.
1. "template": a template fits the request as it is (its members, roles, mode and rounds all suit it). Prefer this whenever it is true; do not change a good template just to change it. Your reason tells the user why this template fits what they need.
2. "adapted": a template is close, but this request needs changes: members added, removed or swapped, roles rewritten for it, another mode, or more or fewer rounds. Start from that template, return the whole changed team and the template's id as "baseTemplateId". Your reason tells the user what you changed and why.
3. "custom": no template is close; design a team from scratch. Your reason tells the user why none of the templates fits.

Whichever you pick, keep it proportionate: simple work needs 1-2 members and one round; reserve big teams and several rounds for hard or open-ended problems. At most ${MAX_MEMBERS} members.

For an adapted or custom team:
- Mixing coding agents helps: different models catch different things.
- Write each member's role as instructions addressed to that member: their expertise, what to focus on, and who to hand off to with @Name when the mode is relay.
- Member names: letters, digits, _ or - only (no spaces), unique, e.g. Researcher, Backend_Dev.
- Leave "model" and "effort" out unless the work clearly needs a stronger or faster model than the default.

Write the reason (and for a new team its name, description and roles) in the language of the user's request. Do not use tools unless the choice depends on the files in the working directory.

Reply with only one of these JSON objects, in a \`\`\`json code block:
- template as it is: {"choice": "template", "templateId": "<id>", "reason": "<why it fits: one or two sentences for the user>"}
- adapted template: {"choice": "adapted", "baseTemplateId": "<id>", ${TEAM_FIELDS}, "reason": "<what you changed and why: one or two sentences for the user>"}
- new team: {"choice": "custom", ${TEAM_FIELDS}, "reason": "<why no template fits: one or two sentences for the user>"}`;
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

/** A template's team, as it is. */
function templateDecision(preset: TeamPreset, source: 'template' | 'fallback', reason: string, ctx: PlannerContext, lead: LeadAgentSettings): PlanDecision {
  return {
    source,
    presetId: preset.id,
    name: preset.name,
    description: preset.description,
    reason,
    settings: { mode: preset.settings.mode, rounds: preset.settings.rounds, maxHops: preset.settings.maxHops },
    agents: fitAgents(preset.agents, ctx, lead),
  };
}

/** The same members (names, CLIs, roles, models, efforts) working the same way. */
export function sameTeam(preset: TeamPreset, settings: PlanDecision['settings'], agents: AgentConfig[]): boolean {
  const s = preset.settings;
  if (s.mode !== settings.mode) return false;
  if (s.mode === 'relay' ? s.maxHops !== settings.maxHops : s.rounds !== settings.rounds) return false;
  return (
    preset.agents.length === agents.length &&
    preset.agents.every((p, i) => {
      const a = agents[i]!;
      return (
        p.name === a.name &&
        p.provider === a.provider &&
        p.role.trim() === a.role.trim() &&
        (p.model || undefined) === (a.model || undefined) &&
        (p.effort || undefined) === (a.effort || undefined)
      );
    })
  );
}

/** Turn the lead's JSON into a team. Throws (with a user-readable message) when it is unusable. */
export function decidePlan(raw: Record<string, any>, ctx: PlannerContext, lead: LeadAgentSettings): PlanDecision {
  const reason = String(raw.reason ?? '').trim().slice(0, 800);
  if (raw.choice === 'template') {
    const id = String(raw.templateId ?? '');
    const preset = ctx.presets.find((p) => p.id === id);
    if (!preset) throw new Error(t().planUnknownTemplate(id));
    return templateDecision(preset, 'template', reason || t().planTemplateFits(preset.name), ctx, lead);
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
  const settings = { mode, rounds: clampInt(raw.rounds, 1, 5, 1), maxHops: clampInt(raw.maxHops, 1, 30, 8) };
  // A "new" team that is exactly a template is that template: nothing new to save. The lead's
  // reason would describe changes that were not made, so the card says plainly what happened.
  const same = ctx.presets.find((p) => sameTeam(p, settings, agents));
  if (same) return templateDecision(same, 'template', t().planTemplateFits(same.name), ctx, lead);
  const base = raw.choice === 'adapted' ? ctx.presets.find((p) => p.id === String(raw.baseTemplateId ?? '')) : undefined;
  return {
    source: base ? 'adapted' : 'custom',
    ...(base ? { basedOn: { id: base.id, name: base.name } } : {}),
    name: String(raw.name ?? '').trim().slice(0, 80) || agents.map((a) => a.name).join(' · '),
    description: String(raw.description ?? '').trim().slice(0, 200) || undefined,
    reason,
    settings,
    agents: fitAgents(agents, ctx, lead),
  };
}

/** The general-question template, used when planning fails. */
export function fallbackPlan(ctx: PlannerContext, lead: LeadAgentSettings, why: string): PlanDecision {
  const preset = ctx.presets.find((p) => p.id === FALLBACK_PRESET) ?? ctx.presets[0]!;
  return templateDecision(preset, 'fallback', t().planFailed(why), ctx, lead);
}
