import {
  NATIVE_ITEM_SUPPORT,
  NATIVE_OFF_SUPPORT,
  nativeItemCount,
  type NativeItemKind,
  type NativeItemsOff,
  type NativePart,
  type NativeSetup,
  type Provider,
} from '../shared/types';

/** NativeSetupPanel's logic, kept out of the component so it can be tested without a DOM. */

export type NativeTab = 'skills' | 'mcp' | 'tools' | 'hooks' | 'agents' | 'plugins' | 'instructions' | 'memory';

/**
 * The tabs each CLI gets, before it is asked too: the kinds it lists or has a switch for. Codex has
 * no list of its subagents and no switch for them; only Claude Code lists its built-in tools.
 */
const TABS: Record<Provider, NativeTab[]> = {
  claude: ['skills', 'mcp', 'tools', 'hooks', 'agents', 'plugins', 'instructions', 'memory'],
  codex: ['skills', 'mcp', 'hooks', 'plugins', 'instructions', 'memory'],
  grok: ['skills', 'mcp', 'hooks', 'agents', 'plugins', 'instructions', 'memory'],
  cursor: ['skills', 'mcp', 'hooks', 'agents', 'instructions'],
  antigravity: ['skills', 'mcp', 'hooks', 'agents', 'plugins', 'instructions'],
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

/** The part (the "leave all out" switch) of each tab. */
export const TAB_PART: Record<NativeTab, NativePart> = {
  skills: 'skills',
  mcp: 'mcp',
  tools: 'tools',
  hooks: 'hooks',
  agents: 'agents',
  plugins: 'plugins',
  instructions: 'instructions',
  memory: 'memory',
};

/** The kinds of single items each tab lists. */
export const TAB_KINDS: Record<NativeTab, NativeItemKind[]> = {
  skills: ['skills'],
  mcp: ['mcp', 'mcpTools'],
  tools: ['tools'],
  hooks: ['hooks'],
  agents: ['agents'],
  plugins: ['plugins'],
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
    case 'instructions':
    case 'memory':
      return setup.memory.filter((m) => m.kind === tab).length;
  }
}

/** A CLI's tabs, with their counts once it has answered. */
export function nativeTabs(provider: Provider, setup?: NativeSetup | null): { tab: NativeTab; count?: number }[] {
  return TABS[provider].map((tab) => ({ tab, ...(setup ? { count: tabCount(setup, tab) } : {}) }));
}

/** Whether a CLI can leave out all of a tab's kind at once. */
export const canLeaveOutAll = (provider: Provider, tab: NativeTab) => NATIVE_OFF_SUPPORT[provider].includes(TAB_PART[tab]);

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

/** `items` without any of a tab's kinds. */
export function withoutTab(items: NativeItemsOff, tab: NativeTab): NativeItemsOff {
  return Object.fromEntries(Object.entries(items).filter(([kind]) => !TAB_KINDS[tab].includes(kind as NativeItemKind)));
}

/** How many single items of a tab are left out. */
export const tabPicked = (items: NativeItemsOff, tab: NativeTab) => TAB_KINDS[tab].reduce((n, k) => n + (items[k]?.length ?? 0), 0);

/** Whether an item is picked to be left out. */
export const isPicked = (items: NativeItemsOff, kind: NativeItemKind, id: string | undefined) => Boolean(id && items[kind]?.includes(id));

/** What is left out in all: parts left out whole, and single items. */
export const nativeOffTotal = (off: readonly NativePart[], items: NativeItemsOff) => off.length + nativeItemCount(items);

/**
 * How many of the items the CLI loads by itself Harness Relay's runs leave out: an MCP server left
 * out counts once (its tools with it), the tools of one that stays each.
 */
export function nativeLeftOutCount(setup: NativeSetup): number {
  const tools = setup.mcpServers.filter((s) => !s.leftOut).flatMap((s) => s.tools ?? []);
  return [setup.skills, setup.mcpServers, tools, setup.builtinTools ?? [], setup.memory, setup.hooks ?? [], setup.agents ?? [], setup.plugins ?? []]
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
  return TAB_KINDS[tab].flatMap((kind) =>
    (items[kind] ?? [])
      .filter((id) => !listed[kind]?.includes(id) && !(kind === 'mcpTools' && unknown.some((prefix) => id.startsWith(prefix))))
      .map((id) => ({ kind, id })),
  );
}

/** `items` without these. */
export function withoutPicks(items: NativeItemsOff, picks: { kind: NativeItemKind; id: string }[]): NativeItemsOff {
  return picks.reduce((next, p) => withItem(next, p.kind, p.id, false), items);
}
