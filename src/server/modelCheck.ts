import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { NATIVE_PARTS, nativeOffFor } from '../shared/types';
import { removeTree } from './fsRemove';
import { DATA_DIR } from './settings';
import { AgentRunError, type AgentRunner, type RunOptions, type RunResult } from './agents/types';

export const MODEL_CHECK_REPLY = 'RELAY_MODEL_OK';
export const MODEL_CHECK_PROMPT = `Reply with exactly ${MODEL_CHECK_REPLY}.`;
const BRIEFING = 'This is a model availability check. Reply with the requested text. Do not read files or call tools.';

/** A fresh CLI session in an empty folder. The planner keeps only whether the model replied. */
export async function checkModel(
  runner: AgentRunner,
  run: Pick<RunOptions, 'bin' | 'env' | 'model' | 'backends' | 'permission' | 'sandboxTerminal' | 'signal'>,
): Promise<{ ok: boolean; usage?: RunResult }> {
  if (run.signal.aborted) return { ok: false };
  const root = join(DATA_DIR, 'model-checks');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'check-'));
  const stop = new AbortController();
  const signal = AbortSignal.any([run.signal, stop.signal]);
  let reply = '';
  try {
    const usage = await runner.run({
      ...run,
      cwd,
      signal,
      prompt: MODEL_CHECK_PROMPT,
      systemPrompt: BRIEFING,
      nativeOff: nativeOffFor(runner.provider, NATIVE_PARTS),
      onEvent(event) {
        if (event.type === 'tool_start') stop.abort();
        if (event.type === 'text' && reply.length < 1000) reply += event.text;
      },
    });
    return { ok: !signal.aborted && reply.trim() === MODEL_CHECK_REPLY, usage };
  } catch (err) {
    return { ok: false, usage: err instanceof AgentRunError ? err.usage : undefined };
  } finally {
    removeTree(cwd);
  }
}
