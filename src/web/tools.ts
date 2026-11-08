// The tool library as the team editor shows it: the items an agent can be given, and its exceptions.

import {
  MEMORY_SCOPES,
  PROVIDERS,
  agentHasTool,
  toolKey,
  type AgentConfig,
  type Provider,
  type ToolKind,
  type ToolLibraryView,
} from '../shared/types';

export interface ToolItem {
  key: string;
  kind: ToolKind;
  /** Server or skill name; for memory, its part: 'all' or a CLI. */
  name: string;
  /** The CLIs whose agents get it unless they turn it off. */
  providers: Provider[];
  /** Why it cannot be used right now (a skill without SKILL.md…). */
  problem?: string;
}

/** Everything in the library an agent can be given: MCP servers, skills, then the memory parts that have text. */
export function toolItems(lib: ToolLibraryView): ToolItem[] {
  return [
    ...lib.mcpServers.map<ToolItem>((s) => ({ key: toolKey('mcp', s.id), kind: 'mcp', name: s.name, providers: s.providers })),
    ...lib.skills.map<ToolItem>((s) => ({
      key: toolKey('skill', s.path),
      kind: 'skill',
      name: s.name,
      providers: s.providers,
      ...(s.problem ? { problem: s.problem } : {}),
    })),
    ...MEMORY_SCOPES.filter((scope) => lib.memory[scope].trim()).map<ToolItem>((scope) => ({
      key: toolKey('memory', scope),
      kind: 'memory',
      name: scope,
      providers: scope === 'all' ? [...PROVIDERS] : [scope],
    })),
  ];
}

/** The items that apply to an agent of `provider`: all but the memory parts for other CLIs. */
export function itemsFor(items: ToolItem[], provider: Provider): ToolItem[] {
  return items.filter((i) => i.kind !== 'memory' || i.name === 'all' || i.name === provider);
}

/** On for an agent of `provider` unless it turns it off. */
export function defaultOn(item: ToolItem, provider: Provider): boolean {
  return item.providers.includes(provider);
}

/** Whether the agent gets the item (usable or not). */
export function hasTool(agent: Pick<AgentConfig, 'tools' | 'provider'>, item: ToolItem): boolean {
  return agentHasTool(agent, item.key, defaultOn(item, agent.provider));
}

/**
 * The agent's exceptions after turning `item` on or off: matching the default for its CLI removes
 * the exception, and no exceptions at all is undefined.
 */
export function setTool(agent: Pick<AgentConfig, 'tools' | 'provider'>, item: ToolItem, on: boolean): AgentConfig['tools'] {
  const next = { ...(agent.tools ?? {}) };
  if (on === defaultOn(item, agent.provider)) delete next[item.key];
  else next[item.key] = on;
  return Object.keys(next).length ? next : undefined;
}
