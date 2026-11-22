import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  askThroughCli,
  CLI_SUB_MODEL_SYSTEM,
  cliSubModelSystem,
  connectionModel,
  subModelAsker,
  type CliSubModelDeps,
  type CliSubModelSettings,
} from '../src/server/cliSubModel';
import { RUN_TMP_PREFIXES } from '../src/server/protect';
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

  const settings = (accounts: string[] = ['work'], defaults: Record<string, string> = { work: 'work-default' }): CliSubModelSettings => ({
    hasAccount: (_p, a) => !a || accounts.includes(a),
    bin: (p) => `/bin/${p}`,
    env: (p, a) => ({ WHO: `${p}:${a ?? ''}` }),
    defaultModel: (_p, a) => defaults[a ?? ''] ?? '',
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
  const deps = (runners: CliSubModelDeps['runners'], more: Partial<CliSubModelDeps> = {}): CliSubModelDeps => ({
    settings: settings(),
    runners,
    dir: tmp,
    ...more,
  });
  const req = { prompt: 'Which?', system: 'Be brief.', maxTokens: 300 };
  const signal = () => new AbortController().signal;
  const answering = (text = 'SQLite') =>
    fake(async (o) => {
      o.onEvent({ type: 'text', text });
      return {};
    });

  it('runs a toolless, read-only turn of its CLI as the account, in an empty folder of its own removed after it', async () => {
    let cwdDuring = '';
    let gitDuring = false;
    const { runners, seen } = fake(async (o) => {
      cwdDuring = o.cwd;
      gitDuring = existsSync(join(o.cwd, '.git'));
      o.onEvent({ type: 'thinking', text: 'hmm' });
      o.onEvent({ type: 'text', text: 'SQLite' });
      o.onEvent({ type: 'text_end' });
      o.onEvent({ type: 'text', text: 'SSE' });
      return { inputTokens: 700, outputTokens: 12, costUsd: 0.0002 };
    });
    const a = await askThroughCli(deps(runners), { provider: 'copilot', account: 'work' }, req, signal());
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
    // In Harness Relay's own temporary folder (here `dir`), swept at a start (`RUN_TMP_PREFIXES.ask`), with
    // an empty `.git` where a CLI's walk up for its instruction files stops.
    expect(cwdDuring.startsWith(join(tmp, RUN_TMP_PREFIXES.ask))).toBe(true);
    expect(gitDuring).toBe(true);
    expect(existsSync(cwdDuring)).toBe(false);
  });

  it('takes the model it names, else the CLI decides; and its own instructions when the code gives none', async () => {
    const { runners, seen } = answering();
    await askThroughCli(deps(runners), { provider: 'claude', account: '', model: 'haiku' }, req, signal());
    await askThroughCli(deps(runners), { provider: 'claude', account: '' }, { prompt: 'q', maxTokens: 50 }, signal());
    expect(seen[0]!.model).toBe('haiku');
    expect(seen[1]!.model).toBeUndefined();
    expect(seen[1]!.systemPrompt).toBe(cliSubModelSystem({ maxTokens: 50 }));
    expect(seen[1]!.systemPrompt.startsWith(CLI_SUB_MODEL_SYSTEM)).toBe(true);
    expect(seen[1]!.systemPrompt).toContain('50 tokens');
  });

  it("never sends one of the user's endpoints' models to the CLI's own service, named or the account's default", async () => {
    expect(connectionModel('homelab/qwen')).toBe(true);
    expect(connectionModel('anthropic/claude-haiku-5-5')).toBe(true);
    expect(connectionModel('haiku')).toBe(false);
    expect(connectionModel(undefined)).toBe(false);
    const { runners, seen } = answering();
    await expect(askThroughCli(deps(runners), { provider: 'claude', account: '', model: 'homelab/qwen' }, req, signal())).rejects.toThrow(
      'homelab/qwen is a model of your own endpoints or API keys',
    );
    const local = deps(runners, { settings: settings([], { '': 'homelab/qwen' }) });
    await expect(askThroughCli(local, { provider: 'claude', account: '' }, req, signal())).rejects.toThrow(
      'ask it through a model connection',
    );
    expect(seen).toHaveLength(0);
  });

  it('stops a run whose CLI starts a tool all the same, and takes nothing it said', async () => {
    let stopped = false;
    const { runners } = fake(
      (o) =>
        new Promise((resolve) => {
          o.onEvent({ type: 'text', text: 'Let me look' });
          o.onEvent({ type: 'tool_start', id: 't1', name: 'WebFetch' });
          const end = () => {
            stopped = true;
            resolve({});
          };
          if (o.signal.aborted) end();
          else o.signal.addEventListener('abort', end);
        }),
    );
    await expect(askThroughCli(deps(runners), { provider: 'claude', account: '' }, req, signal())).rejects.toThrow(
      'Claude Code: it tried to use a tool (WebFetch)',
    );
    expect(stopped).toBe(true);
  });

  it('fails on an empty answer, and on none within its time', async () => {
    const empty = fake(async (o) => {
      o.onEvent({ type: 'text', text: '  ' });
      return {};
    });
    await expect(askThroughCli(deps(empty.runners), { provider: 'copilot', account: '' }, req, signal())).rejects.toThrow(
      'Copilot: it gave an empty answer',
    );
    let cwd = '';
    const slow = fake(
      (o) =>
        new Promise((_, reject) => {
          cwd = o.cwd;
          o.signal.addEventListener('abort', () => reject(new Error('stopped')));
        }),
    );
    await expect(askThroughCli(deps(slow.runners, { timeoutMs: 50 }), { provider: 'muse', account: '' }, req, signal())).rejects.toThrow(
      'Muse Code: no answer within 0 seconds',
    );
    expect(existsSync(cwd)).toBe(false);
  });

  it('fails, saying why, for an account that is gone, a CLI that fails, and a stopped question', async () => {
    const { runners } = answering();
    await expect(
      askThroughCli(deps(runners, { settings: settings([]) }), { provider: 'muse', account: 'gone' }, req, signal()),
    ).rejects.toThrow('the Muse Code account gone is not set up');
    const failing = fake(async () => {
      throw new Error('not signed in');
    });
    await expect(askThroughCli(deps(failing.runners), { provider: 'muse', account: '' }, req, signal())).rejects.toThrow(
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
    await expect(askThroughCli(deps(stopped.runners), { provider: 'claude', account: '' }, req, stop.signal)).rejects.toThrow(
      'Claude Code: stopped',
    );
    expect(existsSync(cwd)).toBe(false);
  });

  it('asks a CLI sub-model through its CLI, and any other on its model connection', async () => {
    const { runners, seen } = answering('through the CLI');
    const asked: string[] = [];
    const ask = subModelAsker(deps(runners), async (model) => {
      asked.push(model);
      return { text: 'on the connection', inputTokens: 1, outputTokens: 1, truncated: false };
    });
    expect((await ask('cli:claude/haiku', req, signal())).text).toBe('through the CLI');
    expect((await ask('homelab/qwen', req, signal())).text).toBe('on the connection');
    // A CLI that cannot be asked so reads as a model connection's id, which its connection then refuses.
    await ask('cli:codex/gpt-6', req, signal());
    expect(seen).toHaveLength(1);
    expect(asked).toEqual(['homelab/qwen', 'cli:codex/gpt-6']);
  });
});
