import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_OFF_SUPPORT, PROVIDER_LABEL, type CliSubModel, type Provider, type SubModelCli } from '../shared/types';
import type { AgentRunner } from './agents/types';
import type { LlmAnswer, LlmRequest } from './llmQuery';

/*
 * RLM mode's sub-model asked through a CLI (`cli:<provider>[:<account>][/<model>]`, Settings → Labs):
 * one turn of Claude Code, Copilot or Muse Code as one of the user's accounts, on its plan rather than a
 * model connection's key, for each `llm_query()` question. The turn has no tool at all
 * (`RunOptions.toolless`: each adapter leaves out every tool, MCP server, skill, hook and the rest, and
 * passes none of Harness Relay's), as a model connection's plain completion has none (`llmQuery.ts`),
 * since what it reads is often text from elsewhere. It runs read-only, in an empty folder of its own
 * outside any repository (a CLI looks for instruction files in the folders above), removed after it,
 * and keeps no session.
 */

/** What asking through a CLI needs of the settings (`SettingsStore`). */
export interface CliSubModelSettings {
  hasAccount(p: Provider, account: string | undefined): boolean;
  bin(p: Provider): string;
  env(p: Provider, account?: string): NodeJS.ProcessEnv;
  defaultModel(p: Provider, account?: string): string;
}

/** How long one question through a CLI may take: the CLI's start, and its answer. */
export const CLI_QUESTION_TIMEOUT_MS = 180_000;

/** The empty folder each question runs in, in the system's temporary folder. */
export const CLI_QUESTION_DIR_PREFIX = 'harness-relay-ask-';

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
 * Asks `m` one question: a toolless, read-only turn of its CLI as its account, with the account's default
 * model when `m` names none. The answer's tokens and cost are the CLI's own count; it is never marked cut,
 * since the CLI applies no `max_tokens`. Throws, saying why, when the account is not set up, the CLI
 * fails, or no answer comes within `CLI_QUESTION_TIMEOUT_MS`.
 */
export async function askThroughCli(
  settings: CliSubModelSettings,
  runners: Record<SubModelCli, AgentRunner>,
  m: CliSubModel,
  req: LlmRequest,
  signal: AbortSignal,
  tmp = tmpdir(),
): Promise<LlmAnswer> {
  const label = PROVIDER_LABEL[m.provider];
  if (m.account && !settings.hasAccount(m.provider, m.account))
    throw new Error(`the ${label} account ${m.account} is not set up in Settings any more`);
  const account = m.account || undefined;
  const cwd = mkdtempSync(join(tmp, CLI_QUESTION_DIR_PREFIX));
  const timeout = AbortSignal.timeout(CLI_QUESTION_TIMEOUT_MS);
  const stop = AbortSignal.any([signal, timeout]);
  let text = '';
  try {
    const result = await runners[m.provider].run({
      bin: settings.bin(m.provider),
      env: settings.env(m.provider, account),
      prompt: req.prompt,
      systemPrompt: cliSubModelSystem(req),
      cwd,
      permission: 'read-only',
      model: m.model || settings.defaultModel(m.provider, account) || undefined,
      nativeOff: [...NATIVE_OFF_SUPPORT[m.provider]],
      toolless: true,
      signal: stop,
      onEvent: (e) => {
        if (e.type === 'text') text += e.text;
        else if (e.type === 'text_end') text += '\n';
      },
    });
    return {
      text: text.trim(),
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      truncated: false,
      ...(result.costUsd ? { costUsd: result.costUsd } : {}),
    };
  } catch (err) {
    if (timeout.aborted && !signal.aborted) throw new Error(`${label} gave no answer within ${CLI_QUESTION_TIMEOUT_MS / 1000} seconds`);
    throw new Error(`${label}: ${(err as Error).message}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
