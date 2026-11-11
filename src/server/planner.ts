import { randomUUID } from 'node:crypto';
import {
  PROVIDERS,
  PROVIDER_LABEL,
  accountUsable,
  catalogFor,
  effortsFor,
  toolKey,
  type AgentConfig,
  type ChatMessage,
  type ConversationSettings,
  type LeadAgentSettings,
  type Mode,
  type NativeSetup,
  type Permission,
  type Provider,
  type ProviderModels,
  type ProviderStatus,
  type TeamPlan,
  type TeamPreset,
  type ToolLibraryView,
} from '../shared/types';
import { unknownMentions } from '../shared/mentions';
import { t } from './i18n';
import { probeCompleteness, type NativeProblem } from './native';
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

/**
 * What one CLI's members can use besides their model, as the lead reads it: what the CLI loads by
 * itself in the working directory, without what Harness Relay's runs leave out (`cliToolsForLead`).
 */
export interface CliTools {
  /** Tools built into the CLI (only Claude Code lists them). */
  builtinTools?: string[];
  skills: { name: string; description: string }[];
  /** Its MCP servers, with their tools when the CLI connected to them, and a state other than connected. */
  mcpServers: { name: string; status?: string; tools?: string[] }[];
  /** Its subagents and plugins, when the CLI lists them. */
  agents?: string[];
  plugins?: string[];
  /** It did not answer every question (it refused one, or ran out of time): the lists may be incomplete. */
  incomplete?: boolean;
  /** Nothing is known of it (the lists are empty): it did not answer in time, or could not be asked. */
  unknown?: 'late' | 'failed';
}

/** An item of Harness Relay's tool library, as the lead reads it. */
export interface LibraryItem {
  /** How the lead reads it: `mcp:<name>`, `skill:<name>`, `memory` or `memory:<cli>`. */
  name: string;
  /** Its tool key (`toolKey`). */
  key: string;
  /** A skill's description, or the start of a memory part. */
  about?: string;
  /** The CLIs whose members get it unless they turn it off. */
  providers: Provider[];
  /** A CLI's own memory part: only that CLI's members can have it. */
  only?: Provider;
}

/** What the lead agent may choose from. */
export interface PlannerContext {
  /** CLIs that are installed and signed in; empty = unknown (nothing is remapped). */
  available: Provider[];
  /**
   * The accounts of each available CLI that agents can run as, in order ('' = the default account).
   * A member whose account is not among them gets the first. Absent = unknown (accounts stay as they are).
   */
  accounts?: Partial<Record<Provider, string[]>>;
  catalog: ProviderModels[];
  presets: TeamPreset[];
  /**
   * What each available CLI loads by itself in the working directory (as Harness Relay runs it), asked
   * in the home of the account its new members get; a CLI that was not asked is absent.
   */
  native?: Partial<Record<Provider, CliTools>>;
  /** Harness Relay's tool library; absent = unknown. */
  library?: LibraryItem[];
}

/** How long a design waits for a CLI to say what it loads by itself (the CLIs' probes go on, and are kept). */
export const NATIVE_WAIT_MS = 20_000;
/** At most this many names per list, and characters per description, in what the lead reads of the tools. */
const TOOL_NAMES_MAX = 40;
const TOOL_ABOUT_MAX = 160;

/** What a CLI loads by itself, as the lead reads it: what Harness Relay's runs leave out is left out here too. */
export function cliToolsForLead(setup: Pick<NativeSetup, 'skills' | 'mcpServers' | 'builtinTools' | 'agents' | 'plugins'>): CliTools {
  const kept = <T extends { leftOut?: boolean }>(items: T[]) => items.filter((i) => !i.leftOut);
  return {
    ...(setup.builtinTools ? { builtinTools: kept(setup.builtinTools).map((t) => t.name) } : {}),
    skills: kept(setup.skills).map((s) => ({ name: s.name, description: shorten(s.description.trim(), TOOL_ABOUT_MAX) })),
    mcpServers: kept(setup.mcpServers)
      .filter((m) => m.status !== 'disabled')
      .map((m) => ({
        name: m.name,
        ...(m.status && m.status !== 'connected' ? { status: m.status } : {}),
        ...(m.tools ? { tools: kept(m.tools).map((t) => t.name) } : {}),
      })),
    ...(setup.agents ? { agents: kept(setup.agents).map((a) => a.name) } : {}),
    ...(setup.plugins ? { plugins: kept(setup.plugins).map((p) => p.name) } : {}),
  };
}

/** The tool library's items members can be given, as the lead names them (a skill that cannot be used is left out). */
export function libraryForLead(view: Pick<ToolLibraryView, 'mcpServers' | 'skills' | 'memory'>): LibraryItem[] {
  const items: LibraryItem[] = [
    ...view.mcpServers.map((m) => ({ name: `mcp:${m.name}`, key: toolKey('mcp', m.id), providers: [...m.providers] })),
    ...view.skills
      .filter((sk) => !sk.problem)
      .map((sk) => ({ name: `skill:${sk.name}`, key: toolKey('skill', sk.path), about: shorten(sk.description.trim(), TOOL_ABOUT_MAX), providers: [...sk.providers] })),
  ];
  const memory = view.memory.all.trim();
  if (memory) items.push({ name: 'memory', key: toolKey('memory'), about: shorten(memory.replace(/\s+/g, ' '), TOOL_ABOUT_MAX), providers: [...PROVIDERS] });
  for (const p of PROVIDERS) {
    const part = view.memory[p].trim();
    if (part) items.push({ name: `memory:${p}`, key: toolKey('memory', p), about: shorten(part.replace(/\s+/g, ' '), TOOL_ABOUT_MAX), providers: [p], only: p });
  }
  return items;
}

/**
 * The tool library items a member gets, as the lead reads them: its CLI's defaults with the member's
 * exceptions applied, as `ToolLibrary.forAgent` gives them (a CLI's memory part only to that CLI's
 * members). Undefined when the library is unknown.
 */
export function memberLibraryTools(agent: Pick<AgentConfig, 'provider' | 'tools'>, library: LibraryItem[] | undefined): string[] | undefined {
  if (!library) return undefined;
  return library
    .filter((i) => (!i.only || i.only === agent.provider) && (agent.tools?.[i.key] ?? i.providers.includes(agent.provider)))
    .map((i) => i.name);
}

/** What the lead agent may choose from, gathered for a design or a revision in `cwd`. */
export interface PlannerSources {
  statuses(): Promise<ProviderStatus[]>;
  catalog(): Promise<ProviderModels[]>;
  presets(): TeamPreset[];
  library(): Pick<ToolLibraryView, 'mcpServers' | 'skills' | 'memory'>;
  /**
   * What a CLI loads by itself in a folder, asked without a prompt in the home of `account` (empty: the
   * default account's), as `NativeSetupService.recent` answers.
   */
  native(
    p: Provider,
    cwd: string,
    account: string,
  ): Promise<Pick<NativeSetup, 'skills' | 'mcpServers' | 'builtinTools' | 'agents' | 'plugins'> & { problems?: NativeProblem[] }>;
}

/**
 * The lead's context: the CLIs available (any usable account) and their accounts, models and templates;
 * the tool library; and, for a working directory, what each available CLI loads by itself there, asked
 * in the home of the account its new members get (the first usable one). A CLI that answers part of it
 * keeps what it answered (`incomplete`); one that does not answer within `waitMs`, or answers nothing,
 * is `unknown`.
 */
export async function plannerContext(src: PlannerSources, cwd?: string, waitMs = NATIVE_WAIT_MS): Promise<PlannerContext> {
  const [statuses, catalog] = await Promise.all([src.statuses(), src.catalog()]);
  // A CLI is available with any account agents can run as; its members get one of those.
  const usable = statuses.map((s) => ({ provider: s.provider, ids: s.installed ? s.accounts.filter(accountUsable).map((a) => a.id) : [] }));
  const available = usable.filter((u) => u.ids.length).map((u) => u.provider);
  const accounts = Object.fromEntries(usable.filter((u) => u.ids.length).map((u) => [u.provider, u.ids]));
  let library: LibraryItem[] | undefined;
  try {
    library = libraryForLead(src.library());
  } catch (err) {
    console.warn('[planner] could not read the tool library:', (err as Error).message);
  }
  const native: Partial<Record<Provider, CliTools>> = {};
  if (cwd) {
    await Promise.all(
      available.map(async (p) => {
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), waitMs)));
        try {
          const probe = await Promise.race([src.native(p, cwd, accounts[p]![0]!), late]);
          if (!probe) {
            native[p] = { skills: [], mcpServers: [], unknown: 'late' };
            return;
          }
          // A question it refused, or a part it did not answer, leaves its other answers standing (also
          // empty ones: it has nothing of its own); only a CLI that could not be asked at all is unknown.
          const got = probeCompleteness(probe);
          if (got === 'late' || got === 'failed') native[p] = { skills: [], mcpServers: [], unknown: got };
          else native[p] = got === 'incomplete' ? { ...cliToolsForLead(probe), incomplete: true } : cliToolsForLead(probe);
        } catch (err) {
          console.warn(`[planner] could not ask ${p} what it loads:`, (err as Error).message);
          native[p] = { skills: [], mcpServers: [], unknown: 'failed' };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }
  return { available, accounts, catalog, presets: src.presets(), ...(cwd ? { native } : {}), ...(library ? { library } : {}) };
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
function templateForLead(p: TeamPreset, library?: LibraryItem[]): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    ...teamForLead(p.settings, p.agents, library),
  };
}

/** How a team works and its members, roles in full, with the tool library items each one gets. */
function teamForLead(
  s: Pick<ConversationSettings, 'mode' | 'rounds' | 'maxHops'>,
  agents: AgentConfig[],
  library?: LibraryItem[],
): Record<string, unknown> {
  return {
    mode: s.mode,
    ...(s.mode === 'relay' ? { maxHops: s.maxHops } : { rounds: s.rounds }),
    agents: agents.map((a) => {
      const tools = library?.length ? memberLibraryTools(a, library) : undefined;
      return {
        name: a.name,
        provider: a.provider,
        ...(a.model ? { model: a.model } : {}),
        ...(a.effort ? { effort: a.effort } : {}),
        ...(tools ? { fromToolLibrary: tools } : {}),
        role: a.role.trim(),
      };
    }),
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

/** At most `max` names, then how many more there are. */
function names(list: string[], max = TOOL_NAMES_MAX): string {
  return list.length > max ? `${list.slice(0, max).join(', ')}, … (${list.length - max} more)` : list.join(', ');
}

/** A CLI's models as the lead reads them: each one's name, its efforts and its default effort. */
function modelsForLead(c: ProviderModels): string {
  return c.models
    .map((m) => {
      const efforts = effortsFor(c, m.id);
      const notes = [
        m.label && m.label !== m.id ? m.label : '',
        m.latest ? 'always its family\'s newest' : '',
        efforts.length ? `efforts ${efforts.join('/')}` : '',
        m.defaultEffort ? `default effort ${m.defaultEffort}` : '',
      ].filter(Boolean);
      return notes.length ? `${m.id} (${notes.join('; ')})` : m.id;
    })
    .join(', ');
}

/**
 * The coding agents the lead may staff: the signed-in CLIs, each with its models (and each model's
 * efforts and default effort), what it loads by itself in the working directory (built-in tools,
 * skills, MCP servers with their tools, subagents, plugins), and what its members get from the tool
 * library by default.
 */
function agentsForLead(ctx: PlannerContext): string {
  const available = ctx.available.length ? ctx.available : (Object.keys(PROVIDER_LABEL) as Provider[]);
  return available
    .map((p) => {
      const lines = [`- ${p} (${PROVIDER_LABEL[p]})`];
      // As its new members run it: in the home of the account they get, with that account's defaults.
      const c = catalogFor(ctx.catalog, p, ctx.accounts?.[p]?.[0]);
      if (c?.models.length) lines.push(`  Models: ${modelsForLead(c)}`);
      const defaults = [c?.defaultModel ? `model ${c.defaultModel}` : '', c?.defaultEffort ? `effort ${c.defaultEffort}` : ''].filter(Boolean);
      if (defaults.length) lines.push(`  Default ${defaults.join(', ')}`);
      else if (c?.efforts.length && !c.models.length) lines.push(`  Efforts: ${c.efforts.join('/')}`);
      const own = ctx.native?.[p];
      if (own?.unknown) {
        lines.push(`  Its own tools, skills and MCP servers: unknown (${own.unknown === 'late' ? 'it did not answer in time' : 'it could not be asked'})`);
      } else if (own) {
        if (own.builtinTools?.length) lines.push(`  Built-in tools: ${names(own.builtinTools)}`);
        if (own.skills.length) lines.push(`  Its own skills: ${own.skills.slice(0, TOOL_NAMES_MAX).map((sk) => (sk.description ? `${sk.name} (${sk.description})` : sk.name)).join('; ')}${own.skills.length > TOOL_NAMES_MAX ? `; … (${own.skills.length - TOOL_NAMES_MAX} more)` : ''}`);
        if (own.mcpServers.length) {
          lines.push(
            `  Its own MCP servers: ${own.mcpServers
              .map((m) => `${m.name}${m.status ? ` [${m.status}]` : ''}${m.tools?.length ? ` (tools: ${names(m.tools, 20)})` : ''}`)
              .join('; ')}`,
          );
        }
        if (own.agents?.length) lines.push(`  Its own subagents: ${names(own.agents)}`);
        if (own.plugins?.length) lines.push(`  Its own plugins: ${names(own.plugins)}`);
        if (!own.builtinTools?.length && !own.skills.length && !own.mcpServers.length) lines.push('  Nothing of its own besides its built-in tools');
        if (own.incomplete) lines.push('  (It did not answer every question, so these lists may be incomplete.)');
      } else if (ctx.native) {
        lines.push('  Its own tools, skills and MCP servers: unknown (it was not asked)');
      }
      const given = ctx.library?.filter((i) => i.providers.includes(p)).map((i) => i.name) ?? [];
      if (given.length) lines.push(`  New members get from the tool library: ${given.join(', ')}`);
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * Harness Relay's tool library as the lead reads it, for reference: each item and whose members get it.
 * The user decides who gets what (in Settings and the team editor); the lead only staffs by it.
 */
function libraryForPrompt(ctx: PlannerContext): string {
  if (!ctx.library?.length) return '';
  const items = ctx.library.map((i) => {
    const who = i.only ? `only for ${i.only} members` : i.providers.length ? `${i.providers.join(', ')} members get it` : 'no member gets it unless the user gives it';
    return `- ${i.name}${i.about ? ` (${i.about})` : ''}: ${who}`;
  });
  return `
Harness Relay's tool library, which members get on top of what their coding agent loads by itself (the user decides who gets what; a member of the teams below lists what it gets as "fromToolLibrary"):
${items.join('\n')}
`;
}

/** How the lead matches members to the work, for a design or a revision. */
const STAFFING =
  '- Match each member to its part of the work. Choose the coding agent whose tools (built in, its own skills and MCP servers, and what it gets from the tool library) cover that part, ' +
  'and a model and effort that fit it: a stronger model or higher effort for hard reasoning (design, debugging, review), a faster one or lower effort for simple or bulk work. ' +
  'Every coding agent reads and edits files and runs commands in the working directory, within the file permission.';

export function buildPlannerPrompt(
  question: string,
  settings: ConversationSettings,
  ctx: PlannerContext,
  conv: PlanConversation = {},
): string {
  const agents = agentsForLead(ctx);
  const templates = JSON.stringify(ctx.presets.map((p) => templateForLead(p, ctx.library)), null, 2);
  const current = conv.current?.agents.length ? conv.current : undefined;
  const history = conv.history?.trim();
  // Like a template, without an id: it is not one.
  const currentTeam = current && JSON.stringify(teamForLead(current.settings, current.agents, ctx.library), null, 2);
  const scheduled = conv.schedule;
  // Names a schedule's message @mentions that no member has yet: the members it is for, most likely.
  // (Only for a schedule: an ordinary question's @-words are as often code, like decorators.)
  const addressed = scheduled ? unknownMentions(question, current?.agents.map((a) => a.name) ?? []) : [];
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
It @mentions ${addressed.map((n) => `@${n}`).join(', ')}. If these name the people or roles it is for (not package scopes, decorators or CSS rules), name the members it is for exactly so (a template whose members have these names, or one adapted with its members renamed): only the members a message @mentions answer it, and a name no member has reaches nobody.
`
    : ''
}
Coding agents you can use (only these), with what their members can use:
${agents}
${libraryForPrompt(ctx)}
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
${STAFFING}
- Write each member's role as instructions addressed to that member: their expertise, what to focus on, and who to hand off to with @Name when the mode is relay.
- Member names: letters, digits, _ or - only (no spaces), unique, e.g. Researcher, Backend_Dev. A member who stays on from the current team keeps its name and coding agent, so it keeps what it learned.
- Give "model" and "effort" (from the lists above) only when the member's work needs other than its coding agent's default.

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

/**
 * Make members runnable here: signed-in CLIs only, signed-in accounts of them only, and only models /
 * efforts those CLIs offer as the member's account runs them.
 *
 * `staying`: the conversation's current team. A member who stays on (same name, ignoring case, and
 * same CLI, matched as `keepMemberIds` matches them) keeps the account the user set, which
 * `keepMemberIds` gives back: its model and effort are checked against that account's models.
 */
export function fitAgents(agents: AgentConfig[], ctx: PlannerContext, lead: LeadAgentSettings, staying?: AgentConfig[]): AgentConfig[] {
  const fallbackProvider = ctx.available.includes(lead.provider) ? lead.provider : (ctx.available[0] ?? lead.provider);
  const taken = new Set<string>();
  return agents.map((a) => {
    const out: AgentConfig = { ...a, id: randomUUID() };
    if (ctx.available.length && !ctx.available.includes(out.provider)) {
      out.provider = fallbackProvider;
      out.model = undefined;
      out.effort = undefined;
      delete out.account; // the other CLI's
    }
    const same = staying?.find((c) => !taken.has(c.id) && c.provider === out.provider && c.name.toLowerCase() === out.name.toLowerCase());
    if (same) {
      taken.add(same.id);
      if (same.account) out.account = same.account;
      else delete out.account;
    }
    const usable = ctx.accounts?.[out.provider];
    if (!same && usable?.length && !usable.includes(out.account ?? '')) {
      if (usable[0]) out.account = usable[0];
      else delete out.account;
    }
    const c = catalogFor(ctx.catalog, out.provider, out.account);
    if (out.model && c?.models.length && !c.models.some((m) => m.id === out.model)) out.model = undefined;
    if (out.effort && c) {
      const efforts = effortsFor(c, out.model || c.defaultModel);
      if (efforts.length && !efforts.includes(out.effort)) out.effort = undefined;
    }
    return out;
  });
}

/** A template's team, as it is. */
function templateDecision(
  preset: TeamPreset,
  source: 'template' | 'fallback',
  reason: string,
  ctx: PlannerContext,
  lead: LeadAgentSettings,
  staying?: AgentConfig[],
): PlanDecision {
  return {
    source,
    presetId: preset.id,
    name: preset.name,
    description: preset.description,
    reason,
    settings: { mode: preset.settings.mode, rounds: preset.settings.rounds, maxHops: preset.settings.maxHops },
    agents: fitAgents(preset.agents, ctx, lead, staying),
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
    return templateDecision(preset, 'template', reason || t().planTemplateFits(preset.name), ctx, lead, current?.agents);
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
  if (same) return templateDecision(same, 'template', t().planTemplateFits(same.name), ctx, lead, current?.agents);
  const base = raw.choice === 'adapted' ? ctx.presets.find((p) => p.id === String(raw.baseTemplateId ?? '')) : undefined;
  return {
    source: base ? 'adapted' : 'custom',
    ...(base ? { basedOn: { id: base.id, name: base.name } } : {}),
    name: String(raw.name ?? '').trim().slice(0, 80) || agents.map((a) => a.name).join(' · '),
    description: String(raw.description ?? '').trim().slice(0, 200) || undefined,
    reason,
    settings,
    agents: fitAgents(base ? fromTemplate(agents, base) : agents, ctx, lead, current?.agents),
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
 * so their CLI sessions — what they learned in this conversation — carry on, and their accounts and
 * tools as the user set them (the lead reads tools, it does not change them).
 */
export function keepMemberIds(next: AgentConfig[], current: AgentConfig[]): AgentConfig[] {
  const taken = new Set<string>();
  return next.map((a) => {
    const same = current.find((c) => !taken.has(c.id) && c.provider === a.provider && c.name.toLowerCase() === a.name.toLowerCase());
    if (!same) return a;
    taken.add(same.id);
    const { account: _account, tools: _tools, ...rest } = a;
    return { ...rest, id: same.id, ...(same.tools ? { tools: same.tools } : {}), ...(same.account ? { account: same.account } : {}) };
  });
}

/**
 * Members of a team adapted from a template who are one of its members (same name, ignoring case, and
 * same CLI) keep that member's tools and account, as when the template is used as it is: the lead's
 * reply has neither.
 */
export function fromTemplate(agents: AgentConfig[], template: TeamPreset): AgentConfig[] {
  return agents.map((a) => {
    const was = template.agents.find((t) => t.provider === a.provider && t.name.toLowerCase() === a.name.toLowerCase());
    return was ? { ...a, ...(was.tools ? { tools: was.tools } : {}), ...(was.account ? { account: was.account } : {}) } : a;
  });
}

/*
 * Revising a team: in the team drawer the user tells the lead agent what to change in the team being
 * edited (the conversation's team, or the lead's design waiting for confirmation, maybe edited by hand
 * already). The lead returns the whole team with that change, turned here into a team that can run.
 * Nothing changes in the conversation: the drawer shows the team, and the user saves it.
 */

export const REVISER_BRIEFING =
  'You are the lead agent of Harness Relay, a group chat in which coding-agent CLIs (Claude Code, Codex, Grok) ' +
  'work together on the user\'s questions. Right now your only job is to change the conversation\'s team the way the user asks. ' +
  'Do not answer the conversation\'s questions or do the work yourself. Reply with the JSON object you are asked for and nothing else.';

/** A team being edited: its members and how they take turns. */
export interface TeamDraft {
  agents: AgentConfig[];
  settings: Pick<ConversationSettings, 'mode' | 'rounds' | 'maxHops'>;
}

/** The conversation whose team is revised. */
export interface ReviseConversation {
  /** What was said so far, as the lead reads it (`historyForLead`). */
  history?: string;
  /**
   * The team is the lead's design waiting for confirmation: for the user's latest question, or for
   * the conversation's schedule (its message, which nobody posted).
   */
  pending?: 'question' | 'schedule';
  /**
   * The conversation's schedule and its message: shown while it is on, or when the waiting design is
   * for it (`on` says whether it sends anything now).
   */
  schedule?: { text: string; on: boolean };
  /** The folder the lead works in (the saved one), when the drawer names another one, not saved yet. */
  savedCwd?: string;
}

/** Most members a team may have (as in the team editor). */
const MAX_TEAM = 8;

const PERMISSIONS: Permission[] = ['read-only', 'edit', 'full'];

/**
 * The file permission and working directory as the team drawer has them (maybe changed, not saved
 * yet), for the lead to read; anything missing or invalid is the conversation's own.
 */
export function draftPlace(
  raw: unknown,
  saved: Pick<ConversationSettings, 'permission' | 'cwd'>,
): Pick<ConversationSettings, 'permission' | 'cwd'> {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const cwd = typeof s.cwd === 'string' ? s.cwd.trim().slice(0, 4096) : '';
  return {
    permission: PERMISSIONS.includes(s.permission as Permission) ? (s.permission as Permission) : saved.permission,
    cwd: cwd || saved.cwd,
  };
}

/** How a team takes turns, from what was sent; anything missing or invalid is taken from `fallback`. */
export function teamSettings(raw: unknown, fallback: TeamDraft['settings']): TeamDraft['settings'] {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    mode: MODES.includes(s.mode as Mode) ? (s.mode as Mode) : fallback.mode,
    rounds: clampInt(s.rounds ?? fallback.rounds, 1, 5, fallback.rounds),
    maxHops: clampInt(s.maxHops ?? fallback.maxHops, 1, 30, fallback.maxHops),
  };
}

export function buildRevisePrompt(
  request: string,
  team: TeamDraft,
  settings: Pick<ConversationSettings, 'permission' | 'cwd'>,
  ctx: PlannerContext,
  conv: ReviseConversation = {},
): string {
  const history = conv.history?.trim();
  const scheduled = conv.schedule?.text.trim();
  const opening =
    conv.pending === 'schedule' && !conv.schedule
      ? "The user is reviewing the team you designed for the conversation's schedule, which has been deleted since, and asks you to change it. Once the user saves the team, it is the conversation's team."
      : conv.pending === 'schedule'
      ? "The user is reviewing the team you designed for the conversation's schedule, and asks you to change it. Once the user saves the team, it answers the schedule's message each time the schedule sends it."
      : conv.pending === 'question'
        ? "The user is reviewing the team you designed for their latest question, which it has not answered yet, and asks you to change it. Once the user saves the team, it answers that question."
        : 'The user is editing the team of this conversation and asks you to change it. The changed team answers from the next turn on.';
  return `${opening} Change the team the way the user asks, and keep everything else as it is. The user reviews your team before it is used.
${
  history
    ? `
The conversation so far, oldest first (long messages are shortened):
<conversation>
${history}
</conversation>
`
    : ''
}
The team now (members in speaking order):
<team>
${JSON.stringify(teamForLead(team.settings, team.agents, ctx.library), null, 2)}
</team>
${
  scheduled
    ? `
The conversation has a schedule: the team also gets this message at set times, with nobody watching${
        conv.schedule?.on ? '' : ' (the schedule is off now: it sends nothing until the user turns it on)'
      }:
<scheduled_message>
${scheduled}
</scheduled_message>
Only the members a message @mentions answer it, so keep the members it @mentions under those names unless the user asks otherwise.
`
    : ''
}
What the user asks you to change:
<request>
${request}
</request>

Coding agents you can use (only these), with what their members can use:
${agentsForLead(ctx)}
${libraryForPrompt(ctx)}
Conversation modes:
${MODES.map((m) => `- ${m}: ${MODE_HELP[m]}`).join('\n')}

The file permission "${settings.permission}" and the working directory ${settings.cwd} are the user's to set; you cannot change them.${
    conv.savedCwd && conv.savedCwd !== settings.cwd
      ? ` The user has not saved that working directory yet: you are running in the one saved now, ${conv.savedCwd}.`
      : ''
  }

Templates (built-in and saved by the user), in full, in case the user refers to one:
<templates>
${JSON.stringify(ctx.presets.map((p) => templateForLead(p, ctx.library)), null, 2)}
</templates>

How to change the team:
- Change only what the user asks for, and what that change needs (for example, roles that hand off to a member who was renamed or removed). List every member, in speaking order, but give "role" only for a new member or a role you rewrite: leave it out for every other member, whose role then stays exactly as it is.
- A member who stays keeps its name and coding agent: then it keeps what it learned in this conversation. Rename a member or move it to another coding agent only when the user asks for it, and then give its current name as "was", so it stays the same member with its settings (moved to another coding agent, it reads this conversation afresh). "was" is only for that: never for a new member, even one based on another.
- Write a new or rewritten role as instructions addressed to that member: their expertise, what to focus on, and who to hand off to with @Name when the mode is relay.
- Member names: letters, digits, _ or - only (no spaces), unique, e.g. Researcher, Backend_Dev. At most ${MAX_TEAM} members.
- "model" and "effort": for a member who stays, leave them out to keep what it has, or give "" for its coding agent's default. For a new member, give them (from the lists above) only when its work needs other than its coding agent's default.
${STAFFING}
- When the request cannot be done this way (for example, it asks to change the file permission, or to clear a member's role, which the user does in the editor), return the team as it is and say why in the reason.

Write the reason (and any new or rewritten roles) in the language of the user's request. Do not use tools unless the change depends on the files in the folder you are running in.

Reply with only this JSON object, in a \`\`\`json code block, with the whole team (every member, in speaking order):
{"mode": "roundtable" | "parallel" | "relay", "rounds": <1-5>, "maxHops": <1-30>, "agents": [{"name": "<Name>", "provider": "claude" | "codex" | "grok", "role": "<instructions: only for a new member or a role you rewrite>", "model": "<optional>", "effort": "<optional>", "was": "<its current name: only for a member you renamed or moved to another coding agent>"}], "reason": "<what you changed and why: one or two sentences for the user>"}`;
}

/**
 * Turn the lead's revised team into one that can run. Each member the lead lists is matched to a member
 * of the drawer's team, each drawer member at most once, in this order:
 * 1. the one it names as "was" (renamed, or moved to another CLI); every "was" is settled before any
 *    name, so a new member named like one renamed away does not take its place. A "was" naming a member
 *    the lead also lists unchanged under that name (no role, not itself renamed: a swap or a chain of
 *    renames lists old names again) is ignored: that member stays, and the "was" was misused for a new
 *    member based on it, which starts from that member's role when it has none of its own;
 * 2. one with the same name (ignoring case) and CLI;
 * 3. one with the same name on another CLI (moved, though the lead did not say so);
 * 4. when exactly one listed member (not one based on another) and exactly one drawer member are left
 *    over, and the listed one has no role or the same one: that one (renamed, though the lead did not
 *    say so).
 * A matched member keeps what the lead does not change — its id (and with it its CLI session, which
 * starts afresh on another CLI), its account and its tools — and the role, model and effort the lead left out (null, or a
 * blank role, is left out; a model or effort of its old CLI does not carry over to another one). A role
 * the lead copied, trimmed, stays as the user wrote it. A changed model or effort, and every new or moved
 * member, is fitted to the CLIs here (`fitAgents`); a member who stays on its CLI keeps it even when that
 * one is signed out, since the user chose it. A reply without members (the lead declined, saying why)
 * keeps the members as they are. Throws (with a user-readable message) when the team is unusable.
 */
export function decideRevision(
  raw: Record<string, any>,
  draft: TeamDraft,
  ctx: PlannerContext,
  lead: LeadAgentSettings,
): TeamDraft & { reason: string } {
  const reason = String(raw.reason ?? '').trim().slice(0, 800);
  const settings = teamSettings(raw, draft.settings);
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) return { agents: draft.agents, settings, reason };
  const handle = (v: unknown) => String(v ?? '').trim().replace(/^@/, '').replace(/\s+/g, '_');
  const listed = raw.agents.slice(0, MAX_TEAM).map((a: unknown) => {
    const m = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
    const role = typeof m.role === 'string' && m.role.trim() ? m.role : undefined;
    return { m, name: handle(m.name), provider: String(m.provider ?? '').toLowerCase(), was: handle(m.was).toLowerCase(), role };
  });
  type Listed = (typeof listed)[number];
  // The drawer member each listed member is, found in passes (see above).
  const match: (AgentConfig | undefined)[] = listed.map(() => undefined);
  const taken = new Map<string, AgentConfig>(); // id → the draft member it is
  const pass = (find: (l: Listed, d: AgentConfig) => boolean) =>
    listed.forEach((l: Listed, i: number) => {
      if (match[i]) return;
      const d = draft.agents.find((d) => !taken.has(d.id) && find(l, d));
      if (d) {
        match[i] = d;
        taken.set(d.id, d);
      }
    });
  // Listed under that name and unchanged: no role, and not itself renamed from another (a swap or a
  // chain of renames lists the old name again, for another member).
  const keptUnder = (name: string, self: Listed) =>
    listed.some((o: Listed) => o !== self && !o.role && (!o.was || o.was === o.name.toLowerCase()) && o.name.toLowerCase() === name);
  // A "was" misused for a new member based on another: that member stays, listed unchanged.
  const basedOn = listed.map((l: Listed) => (l.was && keptUnder(l.was, l) ? draft.agents.find((d) => d.name.toLowerCase() === l.was) : undefined));
  pass((l, d) => Boolean(l.was) && d.name.toLowerCase() === l.was && !keptUnder(l.was, l));
  pass((l, d) => d.provider === l.provider && d.name.toLowerCase() === l.name.toLowerCase());
  pass((l, d) => d.name.toLowerCase() === l.name.toLowerCase());
  // One member renamed without saying so: the only one left on each side, the listed one with no role
  // or the same role (and not a new member based on another).
  const leftListed = listed.map((_: Listed, i: number) => i).filter((i: number) => !match[i] && !basedOn[i]);
  const leftDraft = draft.agents.filter((d) => !taken.has(d.id));
  const lone = leftListed.length === 1 && leftDraft.length === 1 ? listed[leftListed[0]!]! : undefined;
  if (lone && (!lone.role || lone.role.trim() === leftDraft[0]!.role.trim())) {
    match[leftListed[0]!] = leftDraft[0];
    taken.set(leftDraft[0]!.id, leftDraft[0]!);
  }

  const members = listed.map(({ m, name, provider, role: given }: Listed, i: number) => {
    const same = match[i];
    const sameCli = same?.provider === provider;
    // Left out (or null): as it was on the same CLI; otherwise (a new member, another CLI) the default.
    // "" is the default.
    const kept = (key: 'model' | 'effort') =>
      m[key] !== undefined && m[key] !== null ? String(m[key]) : sameCli ? (same?.[key] ?? '') : '';
    // A new member based on another (a misused "was") starts from that one's role.
    const role = given ?? same?.role ?? basedOn[i]?.role ?? '';
    return {
      // Its tools stay as the user set them: the lead does not change them.
      ...(same ? { id: same.id, ...(same.tools ? { tools: same.tools } : {}) } : {}),
      // Its account stays while it stays on the same CLI.
      ...(sameCli && same?.account ? { account: same.account } : {}),
      name,
      provider,
      role: same && role.trim() === same.role.trim() ? same.role : role,
      model: kept('model'),
      effort: kept('effort').toLowerCase(),
    };
  });
  const agents = validateAgents(members).map((a) => {
    const same = taken.get(a.id);
    if (!same || same.provider !== a.provider) return { ...fitAgents([a], ctx, lead)[0]!, id: a.id };
    if ((a.model || undefined) === (same.model || undefined) && (a.effort || undefined) === (same.effort || undefined)) return a;
    // Its CLI and account stay (no remapping, even when signed out: the user chose them); only a model
    // or effort that CLI does not offer is dropped.
    return { ...fitAgents([a], { ...ctx, available: [], accounts: undefined }, lead)[0]!, id: a.id };
  });
  return { agents, settings, reason };
}
