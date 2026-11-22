import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  NATIVE_OFF_SUPPORT,
  parseBackendModel,
  parseCliSubModel,
  PROVIDER_LABEL,
  type CliSubModel,
  type Provider,
  type SubModelCli,
} from '../shared/types';
import type { AgentRunner } from './agents/types';
import type { LlmAnswer, LlmRequest } from './llmQuery';
import { relayTmpDir, RUN_TMP_PREFIXES } from './protect';

/*
 * RLM mode's sub-model asked through a CLI (`cli:<provider>[:<account>][/<model>]`, Settings → Labs):
 * one turn of Claude Code, Copilot or Muse Code as one of the user's accounts, on its plan rather than a
 * model connection's key, for each `llm_query()` question. The turn has no tool at all
 * (`RunOptions.toolless`: each adapter leaves out every tool, MCP server, skill, hook and the rest,
 * passes none of Harness Relay's and refuses every permission the CLI asks for), as a model connection's
 * plain completion has none (`llmQuery.ts`), since what it reads is often text from elsewhere; a run in
 * which the CLI starts a tool all the same is stopped and gives no answer. It runs read-only, in an empty
 * folder of its own in Harness Relay's own temporary folder (`relayTmpDir`, which no sandbox lets a
 * command write in, so that no agent can put settings there for the CLI to load), with an empty `.git`
 * where a CLI's search for instruction files and a repository's root stops; the folder is removed after
 * the question, and at the server's next start if it was stopped meanwhile (`RUN_TMP_PREFIXES.ask`). No
 * session is kept.
 */

/** What asking through a CLI needs of the settings (`SettingsStore`). */
export interface CliSubModelSettings {
  hasAccount(p: Provider, account: string | undefined): boolean;
  bin(p: Provider): string;
  env(p: Provider, account?: string): NodeJS.ProcessEnv;
  defaultModel(p: Provider, account?: string): string;
}

/** What `askThroughCli` runs with (swapped in tests). */
export interface CliSubModelDeps {
  settings: CliSubModelSettings;
  runners: Record<SubModelCli, AgentRunner>;
  /** Where each question's folder is made: Harness Relay's own temporary folder. */
  dir?: string;
  /** How long one question may take (`CLI_QUESTION_TIMEOUT_MS`). */
  timeoutMs?: number;
}

/** How long one question through a CLI may take: the CLI's start, and its answer. */
export const CLI_QUESTION_TIMEOUT_MS = 180_000;

/** The instructions when the code gives none. */
export const CLI_SUB_MODEL_SYSTEM = 'Answer the message from what it holds, directly and without preamble.';

/**
 * The system prompt of a question: the code's (else `CLI_SUB_MODEL_SYSTEM`), and its `max_tokens` as a
 * request, since none of these CLIs takes a limit on the answer.
 */
export function cliSubModelSystem(req: Pick<LlmRequest, 'system' | 'maxTokens'>): string {
  return `${req.system?.trim() || CLI_SUB_MODEL_SYSTEM}\n\nKeep the answer under about ${req.maxTokens} tokens.`;
}

/**
 * Whether a model is one of the user's own endpoints' or an API backend's (`<backend>/<model>`), never a
 * CLI's own: asked through the CLI, it would send the question to the CLI's maker with a model it does
 * not know. Such a model is asked through a model connection instead.
 */
export function connectionModel(model: string | undefined): boolean {
  return Boolean(model && parseBackendModel(model));
}

/**
 * The empty folder one question runs in: in `root` (Harness Relay's own temporary folder), owner-only,
 * with an empty `.git` where a CLI's walk up for a repository and its instruction files stops.
 */
export function questionDir(root = relayTmpDir()): { cwd: string; remove: () => void } {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const cwd = mkdtempSync(join(root, RUN_TMP_PREFIXES.ask));
  chmodSync(cwd, 0o700);
  mkdirSync(join(cwd, '.git'));
  return { cwd, remove: () => rmSync(cwd, { recursive: true, force: true }) };
}

/**
 * Asks `m` one question: a toolless, read-only turn of its CLI as its account, with the account's default
 * model when `m` names none. The answer's tokens and cost are the CLI's own count; it is never marked cut,
 * since the CLI applies no `max_tokens`. Throws, saying why, when the account is not set up, the model is
 * a model connection's, the CLI fails, starts a tool, gives an empty answer, or gives none within the time.
 */
export async function askThroughCli(deps: CliSubModelDeps, m: CliSubModel, req: LlmRequest, signal: AbortSignal): Promise<LlmAnswer> {
  const { settings } = deps;
  const label = PROVIDER_LABEL[m.provider];
  if (m.account && !settings.hasAccount(m.provider, m.account))
    throw new Error(`the ${label} account ${m.account} is not set up in Settings any more`);
  const account = m.account || undefined;
  const model = m.model || settings.defaultModel(m.provider, account) || undefined;
  if (connectionModel(model))
    throw new Error(
      `${model} is a model of your own endpoints or API keys, which ${label} would send to its own service: ask it through a model connection in Settings → Labs, or name one of ${label}'s own models`,
    );
  const { cwd, remove } = questionDir(deps.dir ?? relayTmpDir());
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? CLI_QUESTION_TIMEOUT_MS);
  const toolStop = new AbortController();
  const stop = AbortSignal.any([signal, timeout, toolStop.signal]);
  let text = '';
  let tool: string | undefined;
  const failed = (why: string) => new Error(`${label}: ${why}`);
  try {
    const result = await deps.runners[m.provider].run({
      bin: settings.bin(m.provider),
      env: settings.env(m.provider, account),
      prompt: req.prompt,
      systemPrompt: cliSubModelSystem(req),
      cwd,
      permission: 'read-only',
      ...(model ? { model } : {}),
      nativeOff: [...NATIVE_OFF_SUPPORT[m.provider]],
      toolless: true,
      signal: stop,
      onEvent: (e) => {
        if (e.type === 'text') text += e.text;
        else if (e.type === 'text_end') text += '\n';
        else if (e.type === 'tool_start' && tool === undefined) {
          // A tool it should not have: the run is stopped, and nothing it said is taken.
          tool = e.name || 'a tool';
          toolStop.abort();
        }
      },
    });
    if (tool !== undefined) throw failed(`it tried to use a tool (${tool}), which RLM's sub-model may not have: no answer was taken`);
    if (!text.trim()) throw failed('it gave an empty answer');
    return {
      text: text.trim(),
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      truncated: false,
      ...(result.costUsd ? { costUsd: result.costUsd } : {}),
    };
  } catch (err) {
    if (tool !== undefined) throw failed(`it tried to use a tool (${tool}), which RLM's sub-model may not have: no answer was taken`);
    if (timeout.aborted && !signal.aborted)
      throw failed(`no answer within ${Math.round((deps.timeoutMs ?? CLI_QUESTION_TIMEOUT_MS) / 1000)} seconds`);
    const message = (err as Error).message;
    throw message.startsWith(`${label}: `) ? err : failed(message);
  } finally {
    remove();
  }
}

/**
 * RLM mode's `llm_query()` asker (`RunCodeDeps.ask`): a model through a CLI (`parseCliSubModel`) asked with
 * `askThroughCli`, any other on its model connection (`complete`, `llmQuery.ts`'s `llmComplete` with its target).
 */
export function subModelAsker(
  deps: CliSubModelDeps,
  complete: (model: string, req: LlmRequest, signal: AbortSignal) => Promise<LlmAnswer>,
): (model: string, req: LlmRequest, signal: AbortSignal) => Promise<LlmAnswer> {
  return (model, req, signal) => {
    const cli = parseCliSubModel(model);
    return cli ? askThroughCli(deps, cli, req, signal) : complete(model, req, signal);
  };
}
