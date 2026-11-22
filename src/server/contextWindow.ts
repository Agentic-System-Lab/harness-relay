import { isApiBackend, parseBackendModel, type TokenLimits } from '../shared/types';
import type { RunBackends, RunEndpoint } from './agents/types';

/*
 * What a run on one of the user's own endpoints makes of its model's context window and output limit
 * (Settings → Model connections, `RunEndpoint.limits`): the figures each adapter writes where its CLI
 * reads them, and a few settings for a short window (`docs/open-agents.md`, "Context windows"). Without
 * a context window, an adapter writes none of this, and its CLI does as it does today.
 */

/** One endpoint model's limits for a run (a copy), or undefined when Settings knows neither figure. */
export function runLimits(endpoint: Pick<RunEndpoint, 'limits'> | undefined, model: string): TokenLimits | undefined {
  const l = endpoint?.limits && Object.hasOwn(endpoint.limits, model) ? endpoint.limits[model] : undefined;
  return l && (l.context || l.output) ? { ...l } : undefined;
}

/** The limits of a model `<endpoint id>/<model>` of the backends set up now (RLM's sub-model), or undefined. */
export function endpointModelLimits(backends: RunBackends, id: string): TokenLimits | undefined {
  const parsed = parseBackendModel(id);
  if (!parsed || isApiBackend(parsed.backend)) return undefined;
  return runLimits(
    backends.endpoints.find((e) => e.id === parsed.backend),
    parsed.model,
  );
}

/**
 * The tokens a run keeps for one answer, when it knows the context window: the model's output limit,
 * else a quarter of the window, at most `cap` (the CLI's own default for one answer: OpenCode's and
 * Claude Code's 32,000, Pi's 16,384). A quarter leaves three for the conversation: of 32,768 tokens,
 * 8,192 for an answer (room for a reasoning model's thinking and a long edit) and 24,576 for what it
 * reads; of 8,192 tokens, 2,048. Without it, OpenCode given a context window keeps 32,000 tokens for every
 * answer (`min(limit.output, 32000) || 32000`, OpenCode 1.19.5), all of a 32k window, so it would compact
 * at every step.
 */
export function outputReserve(l: TokenLimits & { context: number }, cap: number): number {
  return l.output ?? Math.min(cap, Math.floor(l.context / 4));
}

/**
 * A context window at or below this many tokens is short, and gets the settings that cost something
 * elsewhere (Goose's summing up of old tool output, a model call of its own): at 64k, one tool output of
 * the CLIs' defaults (Goose's 200,000 characters, some 50,000 tokens) fills most of the window, and
 * Goose's own cutoff for that summing up is at its least (10 tool calls) below about 83,000 tokens anyway.
 */
export const SHORT_CONTEXT = 65_536;

/**
 * The characters one tool output may have in a window of `context` tokens: an eighth of the window, at
 * three characters to a token. English and code run nearer four, so this errs toward less; Chinese,
 * Japanese or Korean, with fewer characters to a token, are cut sooner by a limit in bytes (OpenCode's),
 * three of them to such a character in UTF-8. Of 32,768 tokens: 12,288 characters, some 4,000 tokens.
 * Each adapter keeps its CLI's own default where that is smaller.
 */
export function toolOutputChars(context: number): number {
  return Math.floor(context / 8) * 3;
}
