import { catalogFor, isApiBackend, isOpenProvider, parseBackendModel, PROVIDERS, type ApiBackend, type ModelOption, type Provider, type ProviderModels } from '../shared/types';

/*
 * How each model family takes a role best, for the lead agent to follow when it writes members' roles
 * (a team it adapts or designs, a member it adds or rewrites). Each family's own guides say different
 * things, and a role works best written the way its model reads instructions. The lead reads only the
 * guides of the families its coding agents can run, and only where it writes roles; each guide holds
 * only what changes how a role is written for that family, not what holds for every model.
 */

export type ModelFamily = 'claude' | 'gpt' | 'gemini' | 'grok' | 'muse' | 'composer' | 'open';

/**
 * Each family's guide, from its makers' own prompting guides and agent docs (November 2026; the sources
 * are in the developer guide, "Changing prompts"). Only what changes how a role is written for that family.
 */
export const ROLE_GUIDES: Record<ModelFamily, string> = {
  claude:
    'Claude (Anthropic): calm, plain wording, no CAPS, MUST or bare "never" (it over-applies them): give a rule its scope and its reason. ' +
    'Say what the larger task is and what the member\'s output is for. Ask for the action itself ("change", "fix"), not suggestions, with its scope stated literally, ' +
    'and give it a stop rule: once its part is done and checked, it reports, mentioning extras (features, tests, refactors) instead of adding them. ' +
    'No "think hard", "double-check" or "delegate" lines: it checks and delegates readily, and its "effort" sets how hard it thinks. ' +
    'A reviewer lists every finding with its severity and confidence, not only the serious ones.',
  gpt:
    'GPT and Codex (OpenAI): less is more: a few sentences, outcome first (the goal, what done looks like, the constraints, when to stop), each instruction once, no step-by-step procedure. ' +
    'MUST and NEVER only for true invariants; words like "be thorough" make it overdo. ' +
    'Leave out what its coding agent already gives it (the project\'s AGENTS.md, its tools, plans and progress updates), and do not ask for an upfront plan or preambles. ' +
    'Conflicting instructions (within the role, with AGENTS.md or with a teammate\'s role) make it stall: say which one wins. Say how much testing its part needs. ' +
    'No "think step by step": its "effort" sets how hard it thinks.',
  gemini:
    'Gemini (Google): short and direct, no persuasive language or elaborate prompting tricks (it over-analyzes them). ' +
    'A working role, not a character (it may ignore instructions to stay in character). Say what it owns, what it must not touch, and what done looks like. ' +
    'Put its hard limits (what not to do, the reply\'s format, numbers) at the end of the role, where it keeps them. ' +
    'Scope a rule like "do not guess" ("use only the files in the working directory") instead of making it blanket. It reports briefly by default: say what its reply must contain.',
  grok:
    'Grok (xAI): concrete goals, with the files, folders and commands its part involves, and no context it does not need (that sends it off course). ' +
    'Cover the task, what is expected, the edge cases and what done looks like, each in one short line. ' +
    'State its constraints and the reply\'s format directly, and what its report must contain.',
  muse:
    'Muse (Meta): a goal and an objective check (a failing test to make pass, a command that must succeed), not a script of steps. ' +
    'It asks when a prompt is ambiguous and confirms before consequential actions: say who settles open questions (the user or a named teammate) and what it may do without asking. ' +
    'State its limits as "You do not …", and what it hands over, written so that teammates can build on it without asking back.',
  composer:
    'Composer (Cursor): short, one responsibility, the workflow and the reply\'s format. A goal it can verify, with the commands to run (tests, type checks, linters). ' +
    'An explicit scope: the files it may change ("do not write code" for a role that must not edit), and which shortcuts are off limits (it finds workarounds).',
  open:
    'Open-weight and local models (Qwen, DeepSeek, GLM, Kimi, gpt-oss, Llama and the like, and any model on the user\'s own server): they infer less and have little context to spare. ' +
    'A short role of numbered rules that do not overlap: one scoped task (the files or functions, and when it is done), measurable criteria instead of words like "better", and the reply\'s format. ' +
    'Tell it to make the changes itself with its tools, never to hand code to the user. ' +
    'No mode switches (/think, /no_think, "Reasoning: high"), which do nothing in a role: its "effort" sets how hard it thinks.',
};

/** The families in the order the lead reads them. */
const FAMILIES: ModelFamily[] = ['claude', 'gpt', 'gemini', 'grok', 'muse', 'composer', 'open'];

/**
 * The guides for the roles the lead writes, as a section of its prompt: those of `families` only, after
 * what holds for every role. Empty when there are none (no family is known): the lead writes roles as it
 * would without them.
 */
export function roleGuidesForLead(families: readonly ModelFamily[]): string {
  if (!families.length) return '';
  return `
How to write each role for the model its member runs on (its "model", else its coding agent's default model), from each family's own prompting guides:
- Every role is read inside Harness Relay's briefing (the chat, the team, taking turns, the workspace, the file permission), beside the coding agent's own instructions and the project's instruction files: say only what is particular to the member, and do not repeat or contradict those.
${FAMILIES.filter((f) => families.includes(f)).map((f) => `- ${ROLE_GUIDES[f]}`).join('\n')}
`;
}

/** What a CLI runs when nothing says which model: its own family (the others name none of their own). */
const CLI_FAMILY: Partial<Record<Provider, ModelFamily>> = {
  claude: 'claude',
  codex: 'gpt',
  grok: 'grok',
  antigravity: 'gemini',
  muse: 'muse',
};

/**
 * The family of a model, by its name: `opus`, `claude-sonnet-5-5`, `gpt-5.3-codex`, `gemini-3.1-pro`,
 * `grok-4.3`, `muse-spark-1.3`, `composer-1`, `Qwen/Qwen3-30B-A3B`, a gateway's `anthropic/claude-sonnet-5`.
 * An open-weight model (gpt-oss too, although OpenAI's) is `open`, and so is
 * any model the user's own endpoint serves (`onEndpoint`) but Claude, GPT, Gemini and Grok, which only a
 * gateway there can reach: such a server runs open weights (Meta's open Muse models too, whose hosted
 * ones Muse Code runs). Undefined when the id names no family (Cursor's Auto, `default`).
 */
export function modelFamily(id: string, onEndpoint = false): ModelFamily | undefined {
  const m = id.trim().toLowerCase();
  if (!m) return undefined;
  if (/gpt-oss|qwen|deepseek|glm|kimi|llama|mistral|devstral|codestral|mixtral|minimax|gemma|nemotron|granite|phi-?\d|olmo|seed-oss|hermes/.test(m)) return 'open';
  if (/claude|(^|[/._-])(opus|sonnet|haiku|fable)([._-]|$)/.test(m)) return 'claude';
  if (/(^|[/._-])(gpt|codex|o[1-9])([._-]|$)|chatgpt/.test(m)) return 'gpt';
  if (/gemini/.test(m)) return 'gemini';
  if (/grok/.test(m)) return 'grok';
  if (onEndpoint) return 'open';
  if (/(^|[/._-])muse([._-]|$)/.test(m)) return 'muse';
  if (/(^|[/._-])composer([._-]|$)/.test(m)) return 'composer';
  return undefined;
}

/** The family of the models an open agent reaches through each model API. */
const API_FAMILY: Record<ApiBackend, ModelFamily> = { openai: 'gpt', anthropic: 'claude', xai: 'grok' };

/**
 * The family of a CLI's model: by its own name, without the API or endpoint it is on (an open agent's
 * `<backend>/<model>`, an endpoint model's `<endpoint id>/<model>`), as open weights when the user's own
 * endpoint serves it, and through a model API, that API's family when its name says nothing.
 */
function familyOf(p: Provider, id: string, option?: ModelOption): ModelFamily | undefined {
  const parsed = option?.endpoint || isOpenProvider(p) ? parseBackendModel(id) : undefined;
  if (!parsed) return modelFamily(id, Boolean(option?.endpoint));
  const api = !option?.endpoint && isApiBackend(parsed.backend) ? parsed.backend : undefined;
  return modelFamily(parsed.model, !api) ?? (api ? API_FAMILY[api] : undefined);
}

/**
 * The families the lead may give members: those of every model the available CLIs offer (as their new
 * members' accounts run them) and of their defaults, or, for a CLI that lists none, its own family.
 * `available` empty = unknown: every CLI.
 */
export function familiesForLead(ctx: { available: Provider[]; catalog: ProviderModels[]; accounts?: Partial<Record<Provider, string[]>> }): ModelFamily[] {
  const found = new Set<ModelFamily>();
  for (const p of ctx.available.length ? ctx.available : PROVIDERS) {
    const c = catalogFor(ctx.catalog, p, ctx.accounts?.[p]?.[0]);
    const ids = [...(c?.models.map((m) => m.id) ?? []), ...(c?.defaultModel ? [c.defaultModel] : [])];
    for (const id of ids) {
      const f = familyOf(p, id, c?.models.find((o) => o.id === id));
      if (f) found.add(f);
    }
    if (!c?.models.length && CLI_FAMILY[p]) found.add(CLI_FAMILY[p]!);
  }
  return FAMILIES.filter((f) => found.has(f));
}
