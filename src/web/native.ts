import type { NativePart, NativeSetup } from '../shared/types';

/** NativeSetupPanel's logic, kept out of the component so it can be tested without a DOM. */

export type NativeTab = 'skills' | 'mcp' | 'memory' | 'hooks' | 'agents' | 'plugins';

/** The tabs for a CLI's answer, with their counts: only the lists the CLI gave. */
export function nativeTabs(setup: NativeSetup): { tab: NativeTab; count: number }[] {
  const lists: [NativeTab, unknown[] | undefined][] = [
    ['skills', setup.skills],
    ['mcp', setup.mcpServers],
    ['hooks', setup.hooks],
    ['agents', setup.agents],
    ['plugins', setup.plugins],
    ['memory', setup.memory],
  ];
  return lists.filter((e): e is [NativeTab, unknown[]] => Array.isArray(e[1])).map(([tab, list]) => ({ tab, count: list.length }));
}

/** How many of the items the CLI loads by itself Harness Relay's runs leave out. */
export function nativeLeftOutCount(setup: NativeSetup): number {
  return [setup.skills, setup.mcpServers, setup.memory, setup.hooks ?? [], setup.agents ?? [], setup.plugins ?? []]
    .flat()
    .filter((item) => (item as { leftOut?: boolean }).leftOut).length;
}

/** The same parts, in any order. */
export function sameNativeParts(a: readonly NativePart[], b: readonly NativePart[]): boolean {
  return a.length === b.length && a.every((p) => b.includes(p));
}
