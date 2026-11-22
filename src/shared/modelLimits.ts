import type { ModelLimits, TokenLimits } from './types';

/*
 * The context windows and output limits of the user's own endpoint models (Settings → Model
 * connections), shared by the server and the page: what may be set, and what a run uses of what was
 * set and what the server reported (`docs/open-agents.md`, "Context windows").
 */

/**
 * The context windows and output limits Settings takes, in tokens. The smallest window is far below
 * what an agent needs (its briefing and tools alone take thousands of tokens), but a small model's own
 * window, which the user may want written as it is; the largest is above every model served today.
 */
export const MODEL_LIMIT_RANGE = { minContext: 1024, maxContext: 10_000_000, minOutput: 16, maxOutput: 1_000_000 } as const;

/** Whether `n` is a context window Settings takes. */
export function validContext(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= MODEL_LIMIT_RANGE.minContext && (n as number) <= MODEL_LIMIT_RANGE.maxContext;
}

/** Whether `n` is an output limit Settings takes (its context window apart). */
export function validOutput(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= MODEL_LIMIT_RANGE.minOutput && (n as number) <= MODEL_LIMIT_RANGE.maxOutput;
}

/**
 * What a run uses of one endpoint model's limits: what the user set over what the server reported. An
 * output limit is kept only when it is less than the context window (one the server reported may not
 * be: it would leave no room for the request).
 */
export function effectiveLimits(l: ModelLimits | undefined): TokenLimits {
  if (!l) return {};
  const context = l.context ?? l.reported?.context;
  const output = l.output ?? l.reported?.output;
  return {
    ...(context ? { context } : {}),
    ...(output && (!context || output < context) ? { output } : {}),
  };
}
