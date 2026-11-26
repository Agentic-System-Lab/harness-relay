import {
  NATIVE_ITEM_SUPPORT,
  NATIVE_OFF_SUPPORT,
  NATIVE_ON_SUPPORT,
  SUBAGENTS_FULL_ACCESS_ONLY,
  nativeItemCount,
  type NativeItemKind,
  type NativeItemsOff,
  type NativeOnPart,
  type NativePart,
  type NativeSetup,
  type Provider,
} from '../shared/types';

/** NativeSetupPanel's logic, kept out of the component so it can be tested without a DOM. */

export type NativeTab = 'skills' | 'mcp' | 'tools' | 'hooks' | 'agents' | 'plugins' | 'mods' | 'instructions' | 'memory';

/**
 * The kinds each CLI lists or has a switch for. Mods appear only after Claude Code reports a list.
 */
const TABS: Record<Provider, NativeTab[]> = {
  claude: ['skills', 'mcp', 'tools', 'hooks', 'agents', 'plugins', 'mods', 'instructions', 'memory'],
  codex: ['skills', 'mcp', 'hooks', 'plugins', 'instructions', 'memory'],
  grok: ['skills', 'mcp', 'hooks', 'agents', 'plugins', 'instructions', 'memory'],
  cursor: ['skills', 'mcp', 'hooks', 'agents', 'instructions'],
  antigravity: ['skills', 'mcp', 'hooks', 'agents', 'plugins', 'instructions'],
  copilot: ['skills', 'mcp', 'hooks', 'agents', 'plugins', 'instructions', 'memory'],
  muse: ['skills', 'mcp', 'hooks'],
  // The open agents: none until each adapter lists what its CLI reports (one line each, kept apart).
  opencode: ['skills', 'agents', 'instructions'],

  goose: ['skills', 'mcp', 'hooks', 'plugins', 'instructions'],

  cline: ['skills', 'tools', 'hooks', 'agents', 'plugins', 'instructions'],

  openhands: ['skills', 'hooks', 'agents', 'instructions'],

  // Pi: only its instruction files (AGENTS.md / CLAUDE.md up from the folder); its skills, prompt
  // templates, extensions and the project's .pi folder are never loaded in Harness Relay's runs.
  pi: ['instructions'],
};

/** Whether a CLI's card shows what it loads by itself (an open agent's only once its adapter asks it). */
export const hasNativePanel = (provider: Provider): boolean => TABS[provider].length > 0;

/** The kinds of single items each tab lists. */
export const TAB_KINDS: Record<NativeTab, NativeItemKind[]> = {
  skills: ['skills'],
  mcp: ['mcp', 'mcpTools'],
  tools: ['tools'],
  hooks: ['hooks'],
  agents: ['agents'],
  plugins: ['plugins'],
  mods: ['plugins'],
  instructions: ['instructions'],
  memory: [],
};

/** How many items a tab lists in a CLI's answer; undefined when the CLI gave no such list. */
export function tabCount(setup: NativeSetup, tab: NativeTab): number | undefined {
  switch (tab) {
    case 'skills':
      return setup.skills.length;
    case 'mcp':
      return setup.mcpServers.length;
    case 'tools':
      return setup.builtinTools?.length;
    case 'hooks':
      return setup.hooks?.length;
    case 'agents':
      return setup.agents?.length;
    case 'plugins':
      return setup.plugins?.length;
    case 'mods':
      return setup.mods?.length;
    case 'instructions':
    case 'memory':
      return setup.memory.filter((m) => m.kind === tab).length;
  }
}

/** A CLI's tabs, with their counts once it has answered. */
export function nativeTabs(provider: Provider, setup?: NativeSetup | null): { tab: NativeTab; count?: number }[] {
  return TABS[provider]
    .filter((tab) => tab !== 'mods' || setup?.mods !== undefined)
    .map((tab) => ({ tab, ...(setup ? { count: tabCount(setup, tab) } : {}) }));
}

/** Whether a CLI can leave out all of a tab's kind at once. */
export const canLeaveOutAll = (provider: Provider, tab: NativeTab) => tab !== 'mods' && NATIVE_OFF_SUPPORT[provider].includes(tab);

/** Whether a CLI can leave out single items of a kind. */
export const canPick = (provider: Provider, kind: NativeItemKind) => NATIVE_ITEM_SUPPORT[provider].includes(kind);

/** Whether a CLI can leave out single items in a tab. */
export const canPickIn = (provider: Provider, tab: NativeTab) => TAB_KINDS[tab].some((k) => canPick(provider, k));

/** `items` with one item left out (`on`) or not; kinds left with none are dropped. */
export function withItem(items: NativeItemsOff, kind: NativeItemKind, id: string, on: boolean): NativeItemsOff {
  const ids = items[kind] ?? [];
  const next = on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id);
  const { [kind]: _, ...rest } = items;
  return next.length ? { ...rest, [kind]: next } : rest;
}

/**
 * Mods and Plugins share their saved IDs. An ID shown on both tabs can be cleared from either.
 * Picks absent from both lists stay on Plugins, where the user can clear them.
 */
export function picksInTab(
  provider: Provider,
  items: NativeItemsOff,
  tab: NativeTab,
  setup?: NativeSetup | null,
  installedOff?: ReadonlySet<string>,
) {
  const picks = TAB_KINDS[tab].flatMap((kind) => (items[kind] ?? []).map((id) => ({ kind, id })));
  if (!picks.length || (tab !== 'mods' && tab !== 'plugins')) return picks;
  const mods = new Set(setup?.mods?.map((p) => p.id));
  if (tab === 'mods') return picks.filter((p) => mods.has(p.id) && !installedOff?.has(p.id));
  const plugins = new Set(setup?.plugins?.map((p) => p.id));
  return picks.filter(({ id }) => {
    if (plugins.has(id)) return true;
    // Claude's installed plugin list omits built-ins. An unavailable mod list cannot orphan one.
    if (provider === 'claude' && setup?.mods === undefined && id.endsWith('@builtin')) return false;
    return !mods.has(id);
  });
}

/** Installed plugin IDs covered by “Leave all out”, including any that also appear on Mods. */
export function installedPluginsLeftOut(setup: NativeSetup | null, off: readonly NativePart[]) {
  return new Set(off.includes('plugins') ? setup?.plugins?.map((p) => p.name) : []);
}

/** Whether an item is picked to be left out. */
export const isPicked = (items: NativeItemsOff, kind: NativeItemKind, id: string | undefined) => Boolean(id && items[kind]?.includes(id));

/** What is left out in all: parts left out whole, and single items. */
export const nativeOffTotal = (off: readonly NativePart[], items: NativeItemsOff) =>
  off.filter((p) => p !== 'subagents').length + nativeItemCount(items);

/**
 * How many of the items the CLI loads by itself Harness Relay's runs leave out: an MCP server left
 * out counts once (its tools with it), the tools of one that stays each.
 */
export function nativeLeftOutCount(setup: NativeSetup): number {
  const tools = setup.mcpServers.filter((s) => !s.leftOut).flatMap((s) => s.tools ?? []);
  const plugins = setup.plugins ?? [];
  const omittedPlugins = new Set(plugins.filter((p) => p.leftOut).map((p) => p.name));
  return [
    setup.skills,
    setup.mcpServers,
    tools,
    setup.builtinTools ?? [],
    setup.memory,
    setup.hooks ?? [],
    setup.agents ?? [],
    plugins,
    setup.mods?.filter((m) => !omittedPlugins.has(m.name)) ?? [],
  ]
    .flat()
    .filter((item) => (item as { leftOut?: boolean }).leftOut).length;
}

/** The same parts, in any order. */
export function sameNativeParts(a: readonly NativePart[], b: readonly NativePart[]): boolean {
  return a.length === b.length && a.every((p) => b.includes(p));
}

/** The ids each tab's items have in a CLI's answer, by kind; a list the CLI did not give has none. */
function listedIds(setup: NativeSetup, tab: NativeTab): Partial<Record<NativeItemKind, string[]>> | undefined {
  const ids = (list: { id?: string }[] | undefined) => list?.flatMap((x) => (x.id ? [x.id] : []));
  switch (tab) {
    case 'skills':
      return { skills: ids(setup.skills) };
    case 'mcp':
      return { mcp: ids(setup.mcpServers), mcpTools: ids(setup.mcpServers.flatMap((s) => s.tools ?? [])) };
    case 'tools':
      return setup.builtinTools && { tools: ids(setup.builtinTools) };
    case 'hooks':
      return setup.hooks && { hooks: ids(setup.hooks) };
    case 'agents':
      return setup.agents && { agents: ids(setup.agents) };
    case 'plugins':
      return setup.plugins && { plugins: ids(setup.plugins) };
    case 'instructions':
      return { instructions: ids(setup.memory.filter((m) => m.kind === 'instructions')) };
    case 'mods':
      return setup.mods && { plugins: ids(setup.mods) };
    case 'memory':
      return {};
  }
}

/**
 * The items of a tab picked to be left out that the CLI's answer does not list (gone since, or, for
 * a project's files and skills, in another folder than the default working directory), so they can
 * be cleared. None for a list the CLI did not give, or an MCP server's tools it did not list.
 */
export function unlistedPicks(setup: NativeSetup, items: NativeItemsOff, tab: NativeTab): { kind: NativeItemKind; id: string }[] {
  const listed = listedIds(setup, tab);
  if (!listed) return [];
  // A tool of a server whose tools are not known may well still be there. A tool's id starts with
  // its server's: `mcp__<server>__` (Claude Code) or `["<server>",` (Codex).
  const unknown = setup.mcpServers.flatMap((s) => (!s.tools && s.id ? [`${s.id}__`, `${JSON.stringify([s.id]).slice(0, -1)},`] : []));
  return picksInTab(setup.provider, items, tab, setup).filter(
    ({ kind, id }) => !listed[kind]?.includes(id) && !(kind === 'mcpTools' && unknown.some((prefix) => id.startsWith(prefix))),
  );
}

/** `items` without these. */
export function withoutPicks(items: NativeItemsOff, picks: { kind: NativeItemKind; id: string }[]): NativeItemsOff {
  return picks.reduce((next, p) => withItem(next, p.kind, p.id, false), items);
}

// --- Subagents and workflows (CliFeatures) -------------------------------------------------------

/** Whether the CLI does subagents at all: Pi has none, so it gets no such box. */
export const hasSubagents = (provider: Provider): boolean => provider !== 'pi';

/** Whether an account of the CLI can turn its subagents off for Harness Relay's runs (`subagents` in `NATIVE_OFF_SUPPORT`). */
export const hasSubagentSwitch = (provider: Provider): boolean => NATIVE_OFF_SUPPORT[provider].includes('subagents');

/** Whether an account of the CLI can turn its workflows on for Harness Relay's runs (`NATIVE_ON_SUPPORT`). */
export const hasWorkflowSwitch = (provider: Provider): boolean => NATIVE_ON_SUPPORT[provider].includes('workflows');

/** Whether an account of the CLI can have it plan a workflow for every substantial task (Claude Code's ultracode). */
export const hasUltracodeSwitch = (provider: Provider): boolean => NATIVE_ON_SUPPORT[provider].includes('ultracode');

/** Harness Relay turns the CLI's subagents off below full access whatever the switch says (`SUBAGENTS_FULL_ACCESS_ONLY`). */
export const subagentsFullAccessOnly = (provider: Provider): boolean => SUBAGENTS_FULL_ACCESS_ONLY.includes(provider);

/** What is left out with the CLI's subagents on or off. */
export function withSubagents(off: readonly NativePart[], on: boolean): NativePart[] {
  const rest = off.filter((p) => p !== 'subagents');
  return on ? rest : [...rest, 'subagents'];
}

/** What is turned on with one part switched: workflows off takes ultracode with them, ultracode on needs workflows. */
export function withNativeOn(list: readonly NativeOnPart[], part: NativeOnPart, on: boolean): NativeOnPart[] {
  const rest = list.filter((p) => p !== part && !(part === 'workflows' && !on && p === 'ultracode'));
  if (!on) return rest;
  return part === 'ultracode' && !rest.includes('workflows') ? [...rest, 'workflows', part] : [...rest, part];
}

/** The box's summary: whether subagents are on (undefined for a CLI without a switch) and workflows (undefined without one). */
export function cliFeaturesState(
  provider: Provider,
  off: readonly NativePart[],
  on: readonly NativeOnPart[],
): { subagents?: boolean; workflows?: boolean; ultracode?: boolean } {
  return {
    ...(hasSubagentSwitch(provider) ? { subagents: !off.includes('subagents') } : {}),
    ...(hasWorkflowSwitch(provider) ? { workflows: on.includes('workflows') } : {}),
    ...(hasUltracodeSwitch(provider) ? { ultracode: on.includes('ultracode') } : {}),
  };
}
