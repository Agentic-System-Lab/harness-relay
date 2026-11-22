import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  askThroughCli,
  CLI_QUESTION_DIR_PREFIX,
  CLI_SUB_MODEL_SYSTEM,
  cliSubModelSystem,
  type CliSubModelSettings,
} from '../src/server/cliSubModel';
import type { AgentRunner, RunOptions, RunResult } from '../src/server/agents/types';
import {
  cliSubModelId,
  NATIVE_OFF_SUPPORT,
  parseBackendModel,
  parseCliSubModel,
  SUB_MODEL_CLIS,
  type SubModelCli,
} from '../src/shared/types';

describe("RLM's sub-model through a CLI: its id", () => {
  it('reads cli:<provider>[:<account>][/<model>] for the CLIs it can be asked through', () => {
    expect(parseCliSubModel('cli:claude/haiku')).toEqual({ provider: 'claude', account: '', model: 'haiku' });
    expect(parseCliSubModel(' cli:copilot:work ')).toEqual({ provider: 'copilot', account: 'work' });
    expect(parseCliSubModel('cli:muse:a1/muse-spark-1.3')).toEqual({ provider: 'muse', account: 'a1', model: 'muse-spark-1.3' });
    // A model may hold `/` (Copilot's own names do not, an endpoint's would).
    expect(parseCliSubModel('cli:claude/vendor/model')?.model).toBe('vendor/model');
  });

  it('refuses a CLI that keeps a tool, an account id that is not one, and a model connection', () => {
    for (const p of ['codex', 'grok', 'cursor', 'antigravity', 'opencode']) expect(parseCliSubModel(`cli:${p}/m`)).toBeUndefined();
    expect(parseCliSubModel('cli:claude:Work/haiku')).toBeUndefined();
    expect(parseCliSubModel('anthropic/claude-haiku-5-5')).toBeUndefined();
    // And a model connection never reads one: no endpoint id has a `:`.
    expect(parseBackendModel('cli:claude/haiku')).toBeUndefined();
    expect(SUB_MODEL_CLIS).toEqual(['claude', 'copilot', 'muse']);
  });

  it('writes what it reads back', () => {
    for (const id of ['cli:claude', 'cli:claude/haiku', 'cli:copilot:work', 'cli:muse:a1/muse-spark-1.3'])
      expect(cliSubModelId(parseCliSubModel(id)!)).toBe(id);
    expect(cliSubModelId({ provider: 'claude', account: '', model: ' ' })).toBe('cli:claude');
  });
});

describe("RLM's sub-model through a CLI: one question", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'relay-cli-sub-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const settings = (accounts: string[] = ['work']): CliSubModelSettings => ({
    hasAccount: (_p, a) => !a || accounts.includes(a),
    bin: (p) => `/bin/${p}`,
    env: (p, a) => ({ WHO: `${p}:${a ?? ''}` }),
    defaultModel: (_p, a) => (a === 'work' ? 'work-default' : ''),
  });
  /** A runner that records what it was given and answers as `answer` says. */
  const fake = (answer: (o: RunOptions) => Promise<RunResult>) => {
    const seen: RunOptions[] = [];
    const runner: AgentRunner = {
      provider: 'claude',
      run: async (o) => {
        seen.push(o);
        return answer(o);
      },
    };
    const runners = Object.fromEntries(SUB_MODEL_CLIS.map((p) => [p, runner])) as Record<SubModelCli, AgentRunner>;
    return { runners, seen };
  };
  const req = { prompt: 'Which?', system: 'Be brief.', maxTokens: 300 };
  const signal = () => new AbortController().signal;

  it('runs a toolless, read-only turn of its CLI as the account, in an empty folder removed after it', async () => {
    let cwdDuring = '';
    const { runners, seen } = fake(async (o) => {
      cwdDuring = o.cwd;
      expect(existsSync(o.cwd)).toBe(true);
      o.onEvent({ type: 'thinking', text: 'hmm' });
      o.onEvent({ type: 'text', text: 'SQLite' });
      o.onEvent({ type: 'text_end' });
      o.onEvent({ type: 'text', text: 'SSE' });
      return { inputTokens: 700, outputTokens: 12, costUsd: 0.0002 };
    });
    const a = await askThroughCli(settings(), runners, { provider: 'copilot', account: 'work' }, req, signal(), tmp);
    expect(a).toEqual({ text: 'SQLite\nSSE', inputTokens: 700, outputTokens: 12, truncated: false, costUsd: 0.0002 });
    const o = seen[0]!;
    expect(o).toMatchObject({
      bin: '/bin/copilot',
      env: { WHO: 'copilot:work' },
      prompt: 'Which?',
      permission: 'read-only',
      toolless: true,
      model: 'work-default',
      nativeOff: [...NATIVE_OFF_SUPPORT.copilot],
    });
    expect(o.systemPrompt).toBe(cliSubModelSystem(req));
    expect(o.requestApproval).toBeUndefined();
    expect(o.mcpServers).toBeUndefined();
    expect(cwdDuring.startsWith(join(tmp, CLI_QUESTION_DIR_PREFIX))).toBe(true);
    expect(existsSync(cwdDuring)).toBe(false);
  });

  it('takes the model it names, else the CLI decides; and its own instructions when the code gives none', async () => {
    const { runners, seen } = fake(async () => ({}));
    await askThroughCli(settings(), runners, { provider: 'claude', account: '', model: 'haiku' }, req, signal(), tmp);
    await askThroughCli(settings(), runners, { provider: 'claude', account: '' }, { prompt: 'q', maxTokens: 50 }, signal(), tmp);
    expect(seen[0]!.model).toBe('haiku');
    expect(seen[1]!.model).toBeUndefined();
    expect(seen[1]!.systemPrompt).toBe(cliSubModelSystem({ maxTokens: 50 }));
    expect(seen[1]!.systemPrompt.startsWith(CLI_SUB_MODEL_SYSTEM)).toBe(true);
    expect(seen[1]!.systemPrompt).toContain('50 tokens');
  });

  it('fails, saying why, for an account that is gone, a CLI that fails, and an answer that does not come in time', async () => {
    const { runners } = fake(async () => ({}));
    await expect(askThroughCli(settings([]), runners, { provider: 'muse', account: 'gone' }, req, signal(), tmp)).rejects.toThrow(
      'the Muse Code account gone is not set up',
    );
    const failing = fake(async () => {
      throw new Error('not signed in');
    });
    await expect(askThroughCli(settings(), failing.runners, { provider: 'muse', account: '' }, req, signal(), tmp)).rejects.toThrow(
      'Muse Code: not signed in',
    );
    // The run's own signal ends it: its folder goes all the same.
    const stop = new AbortController();
    let cwd = '';
    const stopped = fake(
      (o) =>
        new Promise((_, reject) => {
          cwd = o.cwd;
          o.signal.addEventListener('abort', () => reject(new Error('stopped')));
          stop.abort();
        }),
    );
    await expect(askThroughCli(settings(), stopped.runners, { provider: 'claude', account: '' }, req, stop.signal, tmp)).rejects.toThrow(
      'Claude Code: stopped',
    );
    expect(existsSync(cwd)).toBe(false);
  });
});
