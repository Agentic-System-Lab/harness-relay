import { randomUUID } from 'node:crypto';
import {
  PROVIDER_LABEL,
  effortsFor,
  type AgentConfig,
  type ChatMessage,
  type ConversationSettings,
  type LeadAgentSettings,
  type Mode,
  type Provider,
  type ProviderModels,
  type TeamPlan,
  type TeamPreset,
} from '../shared/types';
import { unknownMentions } from '../shared/mentions';
import { t } from './i18n';
import { validateAgents } from './validate';

/*
 * Auto team: before the team answers a new question, the lead agent (Settings) chooses the team for
 * it. It reads the question, the conversation so far, the current team and every template in full,
 * and keeps the current team, uses a template as it is, adapts one, or designs a team from scratch;
 * the user confirms the team (unless the conversation uses it at once), then the team answers. Its
 * reply is a JSON object, turned here into a team that can actually run: only signed-in CLIs, only
 * models and efforts those CLIs offer. Anything unusable keeps the current team, or falls back to the
 * general-question template when there is none.
 */

/** What the lead agent may choose from. */
export interface PlannerContext {
  /** CLIs that are installed and signed in; empty = unknown (nothing is remapped). */
  available: Provider[];
  catalog: ProviderModels[];
  presets: TeamPreset[];
}

/** The conversation a question is asked in. */
export interface PlanConversation {
  /** What was said before the question, as the lead reads it (`historyForLead`); empty for a new conversation. */
  history?: string;
  /** The team that answers now; the lead may keep it. */
  current?: { agents: AgentConfig[]; settings: Pick<ConversationSettings, 'mode' | 'rounds' | 'maxHops'> };
  /**
   * The question is a schedule's message: the team gets it automatically at set times (`newChat`: in a
   * new conversation each time), and nobody may be watching then.
   */
  schedule?: { newChat: boolean };
}

/** The parts of a TeamPlan the planner decides. */
export type PlanDecision = Required<Pick<TeamPlan, 'source' | 'name' | 'reason' | 'settings' | 'agents'>> &
  Pick<TeamPlan, 'presetId' | 'basedOn' | 'description'>;

const MODES: Mode[] = ['roundtable', 'parallel', 'relay'];
const FALLBACK_PRESET = 'builtin-general';
const MAX_MEMBERS = 5;
/** How much of the conversation the lead reads: each message, and all of them (the latest are kept). */
const HISTORY_MESSAGE_CHARS = 1500;
const HISTORY_CHARS = 12000;

export const PLANNER_BRIEFING =
  'You are the lead agent of Harness Relay, a group chat in which coding-agent CLIs (Claude Code, Codex, Grok) ' +
  'work together on the user\'s questions. Right now your only job is to choose the team for the user\'s new question. ' +
  'Do not answer the question or do the work yourself. Reply with the JSON object you are asked for and nothing else.';

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
    ...teamForLead(p.settings, p.agents),
  };
}

/** How a team works and its members, roles in full. */
function teamForLead(s: Pick<ConversationSettings, 'mode' | 'rounds' | 'maxHops'>, agents: AgentConfig[]): Record<string, unknown> {
  return {
    mode: s.mode,
    ...(s.mode === 'relay' ? { maxHops: s.maxHops } : { rounds: s.rounds }),
    agents: agents.map((a) => ({
      name: a.name,
      provider: a.provider,
      ...(a.model ? { model: a.model } : {}),
      ...(a.effort ? { effort: a.effort } : {}),
      role: a.role.trim(),
    })),
  };
}

/** A message's text parts (no tool calls, thinking or files). */
function textOf(m: ChatMessage): string {
  return m.parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('\n\n')
    .trim();
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The conversation so far as the lead reads it: the user's messages and the agents' replies, oldest
 * first, each shortened, the oldest left out when it is long. System notes, team designs, passes and
 * replies that failed are left out.
 */
export function historyForLead(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.author.kind === 'system' || m.passed || m.status === 'error') continue;
    const files = m.parts.flatMap((p) => (p.type === 'attachment' ? [p.name] : []));
    const text = textOf(m) + (files.length ? `${textOf(m) ? '\n' : ''}(Attached files: ${files.join(', ')})` : '');
    if (!text) continue;
    const who =
      m.author.kind === 'user' ? 'User' : `@${m.agentName ?? 'agent'}${m.provider ? ` (${PROVIDER_LABEL[m.provider]})` : ''}`;
    lines.push(`[${who}]: ${shorten(text, HISTORY_MESSAGE_CHARS)}`);
  }
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i]!.length + 2;
    if (size > HISTORY_CHARS && kept.length) {
      kept.unshift('(earlier messages left out)');
      break;
    }
    kept.unshift(lines[i]!);
  }
  return kept.join('\n\n');
}

const TEAM_FIELDS =
  '"name": "<short team name>", "description": "<one line>", "mode": "roundtable" | "parallel" | "relay", "rounds": <1-5>, "maxHops": <1-30>, ' +
  '"agents": [{"name": "<Name>", "provider": "claude" | "codex" | "grok", "role": "<instructions>", "model": "<optional>", "effort": "<optional>"}]';

export function buildPlannerPrompt(
  question: string,
  settings: ConversationSettings,
  ctx: PlannerContext,
  conv: PlanConversation = {},
): string {
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
  const current = conv.current?.agents.length ? conv.current : undefined;
  const history = conv.history?.trim();
  // Like a template, without an id: it is not one.
  const currentTeam = current && JSON.stringify(teamForLead(current.settings, current.agents), null, 2);
  const scheduled = conv.schedule;
  // Names the question @mentions that no member has yet: the user means the members they address.
  const addressed = unknownMentions(question, current?.agents.map((a) => a.name) ?? []);
  const review = scheduled
    ? settings.autoConfirm
      ? 'Your team is used as it is; it answers the message each time the schedule sends it.'
      : 'The user reviews your team; then it answers the message each time the schedule sends it.'
    : settings.autoConfirm
      ? 'Your team answers the question right away.'
      : 'The user reviews your team, and then it answers the question.';
  const opening = scheduled
    ? `The user is setting up a schedule: the message below is sent to the team automatically at set times, ${
        scheduled.newChat ? 'each time in a new conversation' : 'each time in this conversation'
      }, and nobody may be watching then, so the team must do the work without asking. Treat the message as the question.`
    : current
      ? 'The user asked a new question in this conversation.'
      : 'The user started a new conversation with this question.';
  const options = current
    ? 'keep the current team, use one of the templates below as it is, adapt one of them to this question, or design a new team from scratch'
    : 'use one of the templates below as it is, adapt one of them to this question, or design a new team from scratch';

  const choices = [
    ...(current
      ? [
          '"keep": the current team suits this question as it is, for example a follow-up on the work it just did. Prefer this whenever it is true: its members keep what they learned in this conversation. Your reason tells the user why the team still fits.',
        ]
      : []),
    '"template": a template fits the question as it is (its members, roles, mode and rounds all suit it). Prefer this over a new team whenever it is true; do not change a good template just to change it. Your reason tells the user why this template fits.',
    '"adapted": a template is close, but this question needs changes: members added, removed or swapped, roles rewritten for it, another mode, or more or fewer rounds. Start from that template, return the whole changed team and the template\'s id as "baseTemplateId". Your reason tells the user what you changed and why.',
    `"custom": no template is close${current ? ' and the current team does not fit' : ''}; design a team from scratch. Your reason tells the user why none of the templates fits.`,
  ];

  return `${opening} Choose the team that answers it: ${options}. ${review} Choose for this question, with the conversation so far in mind.
${
  history
    ? `
The conversation so far, oldest first (long messages are shortened):
<conversation>
${history}
</conversation>
`
    : ''
}${
  currentTeam
    ? `
The team that answered so far:
<current_team>
${currentTeam}
</current_team>
`
    : ''
}
${scheduled ? 'The scheduled message' : 'The new question'}:
<question>
${question}
</question>
${
  addressed.length
    ? `
It addresses ${addressed.map((n) => `@${n}`).join(', ')} by name: only the members a message @mentions answer it, so name the members it is for exactly so (a template whose members have these names, or one adapted with its members renamed), or nobody is addressed and the whole team answers.
`
    : ''
}
Coding agents you can use (only these):
${agents}

Conversation modes:
${MODES.map((m) => `- ${m}: ${MODE_HELP[m]}`).join('\n')}

The user already chose the file permission "${settings.permission}" and the working directory ${settings.cwd}; you cannot change them.

Templates (built-in and saved by the user), in full:
<templates>
${templates}
</templates>

How to decide: read ${current ? 'the current team and ' : ''}the templates first, then pick exactly one of these ${choices.length}.
${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Whichever you pick, keep it proportionate: simple work needs 1-2 members and one round; reserve big teams and several rounds for hard or open-ended problems. At most ${MAX_MEMBERS} members.

For an adapted or custom team:
- Mixing coding agents helps: different models catch different things.
- Write each member's role as instructions addressed to that member: their expertise, what to focus on, and who to hand off to with @Name when the mode is relay.
- Member names: letters, digits, _ or - only (no spaces), unique, e.g. Researcher, Backend_Dev. A member who stays on from the current team keeps its name and coding agent, so it keeps what it learned.
- Leave "model" and "effort" out unless the work clearly needs a stronger or faster model than the default.

Write the reason (and for a new team its name, description and roles) in the language of the user's question. Do not use tools unless the choice depends on the files in the working directory.

Reply with only one of these JSON objects, in a \`\`\`json code block:
${current ? '- current team as it is: {"choice": "keep", "reason": "<why it still fits: one or two sentences for the user>"}\n' : ''}- template as it is: {"choice": "template", "templateId": "<id>", "reason": "<why it fits: one or two sentences for the user>"}
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

/** The current team, as it is: the same members (ids too, so they keep their sessions). */
function keptDecision(current: NonNullable<PlanConversation['current']>, source: 'kept' | 'fallback', reason: string): PlanDecision {
  const s = current.settings;
  return {
    source,
    name: current.agents.map((a) => a.name).join(' · '),
    reason,
    settings: { mode: s.mode, rounds: s.rounds, maxHops: s.maxHops },
    agents: current.agents.map((a) => ({ ...a })),
  };
}

/**
 * Turn the lead's JSON into a team. Throws (with a user-readable message) when it is unusable.
 * `current`: the conversation's team, which the lead may keep.
 */
export function decidePlan(
  raw: Record<string, any>,
  ctx: PlannerContext,
  lead: LeadAgentSettings,
  current?: PlanConversation['current'],
): PlanDecision {
  const reason = String(raw.reason ?? '').trim().slice(0, 800);
  if (raw.choice === 'keep') {
    if (!current?.agents.length) throw new Error(t().planNoCurrentTeam);
    return keptDecision(current, 'kept', reason || t().planKeepFits);
  }
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

/** When planning fails: the current team, or the general-question template when there is none. */
export function fallbackPlan(ctx: PlannerContext, lead: LeadAgentSettings, why: string, current?: PlanConversation['current']): PlanDecision {
  if (current?.agents.length) return keptDecision(current, 'fallback', t().planFailedKept(why));
  const preset = ctx.presets.find((p) => p.id === FALLBACK_PRESET) ?? ctx.presets[0]!;
  return templateDecision(preset, 'fallback', t().planFailed(why), ctx, lead);
}

/**
 * Members who stay on from the current team (same name, ignoring case, and same CLI) keep their ids,
 * so their CLI sessions — what they learned in this conversation — carry on.
 */
export function keepMemberIds(next: AgentConfig[], current: AgentConfig[]): AgentConfig[] {
  const taken = new Set<string>();
  return next.map((a) => {
    const same = current.find((c) => !taken.has(c.id) && c.provider === a.provider && c.name.toLowerCase() === a.name.toLowerCase());
    if (!same) return a;
    taken.add(same.id);
    return { ...a, id: same.id };
  });
}
