import { AGENT_LIMITS, agentLimitValid, type AgentConfig, type AgentLimitSpec, type AgentLimits } from '../shared/types';

/*
 * A member's own limit in the team editor (`AgentConfig.limits`, `AGENT_LIMITS`): a number field shown
 * only for the CLIs that have one, in that CLI's unit. A value out of its bounds stays in the member as
 * typed, so the team cannot be saved until it is fixed (`limitProblem`); an empty field is no limit.
 */

/** The limit the member's CLI has, or undefined when it has none (no field then). */
export function limitSpecOf(agent: Pick<AgentConfig, 'provider'>): AgentLimitSpec | undefined {
  return AGENT_LIMITS[agent.provider];
}

/** What the field shows: the member's limit for its CLI, as typed, or '' for none. */
export function limitText(agent: Pick<AgentConfig, 'provider' | 'limits'>): string {
  const spec = limitSpecOf(agent);
  const v = spec ? agent.limits?.[spec.key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

/**
 * The member's limits once the field reads `text`: its CLI's own set to the number (kept as typed, even
 * out of bounds), or taken out when the field is empty or not a number; the limits of the other CLIs it
 * was on stay, as its models do, for when it goes back to one of them. Undefined when none is left.
 */
export function limitsFromText(agent: Pick<AgentConfig, 'provider' | 'limits'>, text: string): AgentLimits | undefined {
  const spec = limitSpecOf(agent);
  if (!spec) return agent.limits;
  const rest: AgentLimits = { ...agent.limits };
  delete rest[spec.key];
  const n = text.trim() === '' ? NaN : Number(text);
  const next: AgentLimits = Number.isFinite(n) ? { ...rest, [spec.key]: n } : rest;
  return Object.keys(next).length ? next : undefined;
}

/** The member's limit for its CLI is set but not one the CLI takes (out of bounds, or not whole). */
export function limitProblem(agent: Pick<AgentConfig, 'provider' | 'limits'>): AgentLimitSpec | undefined {
  const spec = limitSpecOf(agent);
  const v = spec ? agent.limits?.[spec.key] : undefined;
  return spec && v !== undefined && !agentLimitValid(spec, v) ? spec : undefined;
}

/**
 * A member's limit as a key for comparing members: its CLI's own, as typed (out of bounds too, which is a
 * change all the same); the other CLIs' it keeps do not count.
 */
export function limitsKey(agent: Pick<AgentConfig, 'provider' | 'limits'>): [string, number][] {
  const spec = limitSpecOf(agent);
  const v = spec ? agent.limits?.[spec.key] : undefined;
  return spec && typeof v === 'number' ? [[spec.key, v]] : [];
}
