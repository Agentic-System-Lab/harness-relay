import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApprovalAnswer, Permission } from '../src/shared/types';
import { RpcError } from '../src/server/agents/acp';
import { defaultAcpDeps, type AcpTurnDeps } from '../src/server/agents/acpTurn';
import type { OpenRunContext } from '../src/server/agents/open';
import {
  OPENCODE_ACCOUNT_TABLES,
  OPENCODE_SAVED_PERMISSIONS_TABLE,
  OPENCODE_EMPTY_ENV,
  OPENCODE_ENDPOINT_KEY_ENV,
  OPENCODE_GITIGNORE,
  OPENCODE_REFUSAL_NOTE,
  OPENCODE_QUIET_HOSTS,
  OPENCODE_SHELL,
  OPENCODE_SHELL_ENV,
  OPENCODE_SHELL_SCREEN_ENV,
  OPENCODE_SHELL_REFUSED,
  OPENCODE_STATIC_CONFIG,
  describeOpencodeCall,
  ensureOpencodeHome,
  filterOpencodeUpdate,
  hideOpencodeTool,
  opencodeAcp,
  opencodeAfterSession,
  opencodeAgent,
  opencodeBaseUrl,
  opencodeBriefing,
  opencodeClientRequest,
  opencodeConfigText,
  opencodeHome,
  opencodeModelId,
  opencodeModels,
  opencodeNative,
  opencodePaths,
  opencodePermission,
  opencodePlan,
  opencodeProjectInstructions,
  opencodeProviderId,
  opencodeRefusalBridge,
  opencodeRejection,
  opencodeRunConfig,
  opencodeRunError,
  opencodeRunner,
  opencodeSandbox,
  opencodeToolKind,
  opencodePartIds,
  opencodeTurnCalls,
  opencodeTurnUsage,
  type OpencodeCalls,
  opencodeUsage,
  opencodeUserShell,
  opencodeShellScript,
  opencodeSandboxUnsupported,
  opencodeWouldAsk,
  shellSegments,
  segmentCommand,
  commandSubstitutions,
  watchOpencode,
  WATCH_CLOSE_GRACE_MS,
  parseOpencodeAgents,
  parseOpencodeModels,
  parseOpencodeSkills,
  prepareOpencode,
  rejectWithReason,
  scrubOpencodeDatabase,
} from '../src/server/agents/opencode';
import { AgentRunError, type AgentEvent, type ApprovalRequest, type McpServerSpec, type RunBackends, type RunOptions } from '../src/server/agents/types';
import { backendRun } from '../src/server/backends';
import { t, withLang } from '../src/server/i18n';
import type { SpawnOptions, SpawnResult } from '../src/server/process';
import type { RelaySandboxCommand, RelaySandboxSpec } from '../src/server/relaySandbox';
import { OPEN_AGENT_HOME_ENV } from '../src/server/settings';
import { writeFakeOpencode } from './fake-opencode';
import { addOpencodeRows, rowsEnv, stepData, writeOpencodeWithRows, type StepRow } from './opencode-db';


/** The state key of the runs here: their state is in `<home>/private/<key>`. */
const STATE_KEY = 'conv.c1.a1';
const FIXTURES = join(__dirname, 'fixtures', 'opencode');
let root: string;
let bin: string;
/** The fake, adding the turn's model calls to its database as it starts (`withCalls`). */
let binWithCalls: string;
let n = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-opencode-'));
  bin = writeFakeOpencode(join(root, 'opencode'));
  binWithCalls = writeOpencodeWithRows(join(root, 'opencode-with-calls'), bin);
});

afterAll(() => {
  // The config folders are read-only by design.
  const unlock = (p: string) => {
    try {
      if (statSync(p).isDirectory()) {
        chmodSync(p, 0o700);
        for (const x of readdirSync(p)) unlock(join(p, x));
      }
    } catch {
      // gone
    }
  };
  unlock(root);
  rmSync(root, { recursive: true, force: true });
});

const backends = (): RunBackends => ({
  apis: { openai: 'sk-test-openai-0000', anthropic: 'sk-ant-test-0000', xai: 'xai-test-0000' },
  endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://vllm.example:8000/v1', models: ['muse-glimmer-30b-nvfp4'], apiKey: 'endpoint-test-key' }],
});

/** The specs the fake relay sandbox was given, by run folder. */
const specs = new Map<string, RelaySandboxSpec>();

/** A relay sandbox that runs the command as it is, keeping the spec it was given. */
const fakeSandbox = (dir: string): Partial<AcpTurnDeps> => ({
  platform: 'darwin',
  sandboxAvailable: async () => ({ ok: true }),
  makeRunDirs: () => {
    mkdirSync(join(dir, 'sandbox-tmp'), { recursive: true });
    mkdirSync(join(dir, 'sandbox-host'), { recursive: true });
    return { tmp: join(dir, 'sandbox-tmp'), hostTmp: join(dir, 'sandbox-host') };
  },
  sandboxCommand: async (b, args, env, spec) => {
    specs.set(dir, spec);
    return { bin: b, args, env, channel: () => undefined, failure: () => undefined, run: {} as RelaySandboxCommand['run'], dispose: async () => { for (const d of [spec.dirs?.tmp, spec.dirs?.hostTmp]) if (d) rmSync(d, { recursive: true, force: true }); } };
  },
});

interface Turn {
  o: RunOptions;
  events: AgentEvent[];
  approvals: ApprovalRequest[];
  log: () => Record<string, any>[];
  abort: AbortController;
  dir: string;
  home: string;
}

/** A turn against the fake replaying `fixture` (test/fixtures/opencode/<fixture>.jsonl). */
function turn(fixture: string, over: Partial<RunOptions> = {}, answer?: (req: ApprovalRequest) => ApprovalAnswer): Turn {
  const dir = join(root, `turn-${++n}`);
  mkdirSync(join(dir, 'cwd'), { recursive: true });
  const logFile = join(dir, 'log.jsonl');
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const abort = new AbortController();
  const home = join(dir, 'home');
  const o: RunOptions = {
    bin,
    env: {
      PATH: process.env.PATH,
      HOME: join(dir, 'user'),
      FAKE_OC_FIXTURE: join(FIXTURES, `${fixture}.jsonl`),
      FAKE_OC_LOG: logFile,
      FAKE_OC_ENV: ['OPENCODE_CONFIG_CONTENT', 'OPENCODE_SERVER_PASSWORD', 'XDG_CACHE_HOME', OPENCODE_ENDPOINT_KEY_ENV, 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PERMISSION'].join(','),
      OPENCODE_PERMISSION: '{"edit":"allow"}',
      [OPEN_AGENT_HOME_ENV]: home,
    },
    prompt: 'Do the task.',
    systemPrompt: 'You are @Ada on a team.',
    cwd: join(dir, 'cwd'),
    stateKey: STATE_KEY,
    permission: 'full',
    model: 'anthropic/claude-haiku-5-5',
    signal: abort.signal,
    onEvent: (e) => events.push(e),
    backends: backends(),
    ...(answer
      ? {
          requestApproval: async (req) => {
            approvals.push(req);
            return answer(req);
          },
        }
      : {}),
    ...over,
  };
  const log = () =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, any>)
      : [];
  return { o, events, approvals, log, abort, dir, home };
}

const runTurn = (r: Turn) => opencodeRunner({ ...fakeSandbox(r.dir), runTmpDir: join(r.dir, 'run-tmp') }).run(r.o);
/** The turn's member's OpenCode database. */
const dbOf = (r: Turn) => join(r.home, 'private', STATE_KEY, 'data', 'opencode', 'opencode.db');
/** The turn's model calls, written to its database as the fake starts (after the run read what was there). */
const withCalls = (r: Turn, rows: { sessions?: { id: string; parent?: string }[]; steps: StepRow[] }): Turn => {
  r.o = { ...r.o, bin: binWithCalls, env: { ...r.o.env, FAKE_OC_ROWS: rowsEnv(rows) } };
  return r;
};
const sent = (r: Turn, method: string) => r.log().filter((m) => m.method === method);
/** The client's answers to the agent's requests (no method, an id). */
const answers = (r: Turn) => r.log().filter((m) => m.method === undefined && m.id !== undefined && !m.start);
const tools = (r: Turn) => r.events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end');
const textOf = (r: Turn) =>
  r.events
    .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text)
    .join('');

// Its stand-in CLI is a script, and Windows starts only real programs (`.exe`): tried on macOS and Linux.
describe('OpenCode turns replayed from the real CLI', () => {
  it.skipIf(process.platform === 'win32')('runs a text turn on an endpoint: its model as relay-<id>, thinking and text, tokens', async () => {
    const r = withCalls(turn('text-only', { model: 'homelab/muse-glimmer-30b-nvfp4' }), {
      steps: [{ id: 'prt_1', session: 'ses_e3a879d12ffeGVYFMLkxG3Kbz2', input: 7000, cacheRead: 700, cacheWrite: 21, output: 40, reasoning: 12, cost: 0 }],
    });
    const result = await runTurn(r);
    // An endpoint has no price list: no cost.
    expect(result).toEqual({ sessionId: 'ses_e3a879d12ffeGVYFMLkxG3Kbz2', inputTokens: 7721, outputTokens: 52 });
    expect(r.events.some((e) => e.type === 'thinking')).toBe(true);
    expect(textOf(r)).toBe('pong');
    expect(r.events[0]).toEqual({ type: 'session', sessionId: 'ses_e3a879d12ffeGVYFMLkxG3Kbz2' });
    // The session's model is OpenCode's id for the endpoint's provider.
    expect(sent(r, 'session/set_config_option')[0]!.params).toEqual({ sessionId: 'ses_e3a879d12ffeGVYFMLkxG3Kbz2', configId: 'model', value: 'relay-homelab/muse-glimmer-30b-nvfp4' });
    // Its own server on a port of its own, a password of this run, the endpoint's key in a variable.
    const start = r.log()[0]!;
    expect(start.argv[0]).toBe('acp');
    expect(start.argv[1]).toBe('--port');
    expect(Number(start.argv[2])).toBeGreaterThan(0);
    expect(start.env.OPENCODE_SERVER_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(start.env[OPENCODE_ENDPOINT_KEY_ENV]).toBe('endpoint-test-key');
    expect(start.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(start.env.OPENCODE_PERMISSION).toBe(''); // an inherited one is emptied
    const config = JSON.parse(start.env.OPENCODE_CONFIG_CONTENT);
    expect(config.enabled_providers).toEqual(['relay-homelab']);
    expect(config.provider['relay-homelab']).toEqual({
      npm: '@ai-sdk/openai-compatible',
      name: 'Homelab',
      env: [OPENCODE_ENDPOINT_KEY_ENV],
      options: { baseURL: 'http://vllm.example:8000/v1' },
      models: { 'muse-glimmer-30b-nvfp4': { name: 'muse-glimmer-30b-nvfp4', tool_call: true } },
    });
    expect(JSON.stringify(config)).not.toContain('endpoint-test-key');
    // The run's cache is its own (in the run's temp folder, gone after the run).
    expect(start.env.XDG_CACHE_HOME).toContain(join(r.dir, 'run-tmp'));
    expect(existsSync(start.env.XDG_CACHE_HOME)).toBe(false);
  });

  it('runs below full access on macOS only: on Linux its server could not be watched, so nothing starts', async () => {
    expect(opencodeSandboxUnsupported('darwin')).toBeUndefined();
    expect(withLang('en', () => opencodeSandboxUnsupported('linux'))).toMatch(/On Linux, OpenCode runs only with full access/);
    for (const permission of ['read-only', 'edit'] as const) {
      const r = turn('text-only', { permission, model: 'homelab/muse-glimmer-30b-nvfp4' });
      await expect(withLang('en', () => opencodeRunner({ ...fakeSandbox(r.dir), platform: 'linux', runTmpDir: join(r.dir, 'run-tmp') }).run(r.o))).rejects.toThrow(
        /On Linux, OpenCode runs only with full access/,
      );
      expect(r.log()).toEqual([]); // the CLI never started
      expect(specs.has(r.dir)).toBe(false);
    }
  });

  it.skipIf(process.platform === 'win32')('read-only: asks about the write and the command, never does fs/write_text_file, shows each call', async () => {
    const r = turn('read-write-bash-permission-allowed', { permission: 'read-only', model: 'homelab/muse-glimmer-30b-nvfp4' }, () => ({ allow: true }));
    await runTurn(r);
    expect(r.approvals).toEqual([
      { kind: 'edit', detail: '/home/user/project/notes.txt', reason: '/home/user/project/notes.txt', readOnlySandbox: true },
      { kind: 'command', detail: 'ls -1', reason: 'ls -1', readOnlySandbox: true },
    ]);
    // Allowed once each; the write it asks the client to do is answered null and not done.
    const a = answers(r);
    expect(a.map((x) => x.result?.outcome?.optionId ?? x.result)).toEqual(['once', null, 'once']);
    expect(existsSync('/home/user/project/notes.txt')).toBe(false);
    expect(tools(r)).toEqual([
      { type: 'tool_start', id: 'chatcmpl-tool-97137ca34452aed8', name: 'read', kind: 'read' },
      { type: 'tool_end', id: 'chatcmpl-tool-97137ca34452aed8', ok: true, output: 'hello from the fixture project\nline two', detail: '/home/user/project/hello.txt' },
      { type: 'tool_start', id: 'chatcmpl-tool-817550916c09ed0d', name: 'write', kind: 'edit' },
      { type: 'tool_end', id: 'chatcmpl-tool-817550916c09ed0d', ok: true, output: 'Wrote file successfully.', detail: '/home/user/project/notes.txt' },
      { type: 'tool_start', id: 'chatcmpl-tool-a441a6e679f5edc6', name: 'bash', kind: 'execute' },
      { type: 'tool_end', id: 'chatcmpl-tool-a441a6e679f5edc6', ok: true, output: 'AGENTS.md\nhello.txt\nnotes.txt', detail: 'ls -1' },
    ]);
    // In the relay sandbox: its own server's port only, its config read-only, the run's temp folder its cache.
    const spec = specs.get(r.dir)!;
    expect(spec.localPorts).toEqual([Number(r.log()[0]!.argv[2])]);
    expect(spec.quietlyDeniedHosts).toEqual(OPENCODE_QUIET_HOSTS);
    // Its data and state are the conversation member's own.
    expect(spec.readOnly).toEqual(opencodeHome(r.home, join(r.home, 'private', STATE_KEY)).configPaths);
    expect(spec.writable).toEqual([...opencodeHome(r.home, join(r.home, 'private', STATE_KEY)).statePaths, join(r.dir, 'sandbox-tmp')]);
    expect(spec.allowedHosts).toEqual(['vllm.example:8000']);
    expect(r.log()[0]!.env.XDG_CACHE_HOME).toBe(join(r.dir, 'sandbox-tmp', 'cache'));
    // The read-only rules, and the briefing with what a rejection means.
    const config = JSON.parse(r.log()[0]!.env.OPENCODE_CONFIG_CONTENT);
    expect(config.permission).toMatchObject({ '*': 'ask', read: 'allow', task: 'deny' });
    expect(config.permission.edit).toBeUndefined();
    expect(config.experimental).toEqual({ continue_loop_on_deny: true });
    expect(config.agent.title).toEqual({ disable: true });
  });

  it.skipIf(process.platform === 'win32')('read-only, declined with a note: refuses with reject_once, the reason going through its server, not in the answer', async () => {
    const r = turn('permission-rejected-turn-ends', { permission: 'read-only', model: 'homelab/muse-glimmer-30b-nvfp4' }, () => ({ allow: false, note: 'not now' }));
    await withLang('en', () => runTurn(r));
    expect(r.approvals).toHaveLength(1);
    expect(answers(r)[0]!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    const end = r.events.find((e) => e.type === 'tool_end' && !e.ok) as Extract<AgentEvent, { type: 'tool_end' }>;
    expect(end.error).toBe(`${withLang('en', () => t().approvalDeclined)} not now`);
  });

  it.skipIf(process.platform === 'win32')('full access on Anthropic: no approvals, model then effort set in its order, the cost and tokens of every call of the turn', async () => {
    const session = 'ses_e3a82337bffen0E28XT7dK76JK';
    const call = (i: number, more: Partial<StepRow> = {}): StepRow => ({ id: `prt_${i}`, session, input: 2, cacheRead: 10915, cacheWrite: 575, output: 59, cost: 0.0004, ...more });
    // Four calls (a read, a write, a command, the reply), the third with some reasoning.
    const r = withCalls(turn('anthropic-read-write-bash', { effort: 'low' }), { steps: [call(1), call(2), call(3, { reasoning: 30 }), call(4, { cost: 0.0005484999999999998 })] });
    const result = await runTurn(r);
    expect(r.approvals).toEqual([]);
    expect(answers(r).map((x) => x.result?.outcome?.optionId ?? x.result)).toEqual(['once', null, 'once']);
    expect(sent(r, 'session/set_config_option').map((m) => [m.params.configId, m.params.value])).toEqual([
      ['model', 'anthropic/claude-haiku-5-5'],
    ]);
    expect(result.sessionId).toBe(session);
    expect(result).toMatchObject({ inputTokens: 4 * 11492, outputTokens: 4 * 59 + 30, costUsd: 0.0017485 });
    const config = JSON.parse(r.log()[0]!.env.OPENCODE_CONFIG_CONTENT);
    expect(config).toMatchObject({ model: 'anthropic/claude-haiku-5-5', enabled_providers: ['anthropic'], permission: { '*': 'allow', skill: 'allow' } });
    expect(config.provider).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('OpenAI: its apply_patch row says the file it adds', async () => {
    const r = turn('openai-read-applypatch-bash', { model: 'openai/gpt-6-luna', effort: 'low' });
    await runTurn(r);
    const patch = tools(r).find((e) => e.type === 'tool_end' && e.id === 'call_YgrjV0eZoUW0kxgnn42ju2LF');
    expect(patch).toMatchObject({ ok: true, detail: '/home/user/project/openai.txt' });
    expect(sent(r, 'session/set_config_option').map((m) => m.params.value)).toEqual(['openai/gpt-6-luna', 'low']);
  });

  it.skipIf(process.platform === 'win32')('xAI: thinking, then its tools', async () => {
    const r = turn('xai-read-write-bash-thinking', { model: 'xai/grok-4.3', effort: 'low' });
    await runTurn(r);
    expect(r.events.filter((e) => e.type === 'thinking').length).toBeGreaterThan(0);
    expect(tools(r).filter((e) => e.type === 'tool_end').map((e) => (e as any).ok)).toEqual([true, true, true]);
  });

  it.skipIf(process.platform === 'win32')('turns its todowrite calls into the plan, without rows', async () => {
    const r = turn('todo-plan');
    await runTurn(r);
    expect(tools(r)).toEqual([]);
    expect(r.events.filter((e) => e.type === 'plan')).toEqual([
      { type: 'plan', entries: [{ text: 'inspect', status: 'in_progress' }, { text: 'decide', status: 'pending' }, { text: 'report', status: 'pending' }] },
      { type: 'plan', entries: [{ text: 'inspect', status: 'completed' }, { text: 'decide', status: 'pending' }, { text: 'report', status: 'pending' }] },
    ]);
  });

  it.skipIf(process.platform === 'win32')('streams thinking at a high effort', async () => {
    const r = turn('thinking', { effort: 'high' });
    await runTurn(r);
    expect(r.events.filter((e) => e.type === 'thinking').length).toBeGreaterThan(3);
    expect(sent(r, 'session/set_config_option').map((m) => m.params.configId)).toEqual(['model', 'effort']);
  });

  it.skipIf(process.platform === 'win32')('edit: edits and commands run without asking, each allowed once (never "always")', async () => {
    const r = turn('edit-diff-bash-exit1-always', { permission: 'edit' }, () => ({ allow: false }));
    await runTurn(r);
    expect(r.approvals).toEqual([]);
    expect(answers(r).map((x) => x.result?.outcome?.optionId ?? x.result)).toEqual(['once', 'once', null, 'once']);
    // A command that exits 1 is a finished call with its output.
    expect(tools(r).find((e) => e.type === 'tool_end' && (e as any).detail === 'ls /nonexistent-dir-xyz')).toMatchObject({ ok: true });
    const config = JSON.parse(r.log()[0]!.env.OPENCODE_CONFIG_CONTENT);
    expect(config.permission).toMatchObject({ '*': 'ask', edit: 'allow', task: 'deny' });
  });

  it.skipIf(process.platform === 'win32')('edit: a push asks the user; declined, it is refused', async () => {
    const r = turn('edit-mode-config', { permission: 'edit' }, () => ({ allow: false }));
    await runTurn(r);
    expect(r.approvals).toEqual([{ kind: 'command', detail: 'git push origin main', reason: 'git push origin main' }]);
    expect(answers(r).map((x) => x.result?.outcome?.optionId)).toEqual(['reject', 'once']);
  });

  it.skipIf(process.platform === 'win32')('watches its own server below full access, with the run\'s password', async () => {
    const r = turn('edit-mode-config', { permission: 'edit' }, () => ({ allow: true }));
    await runTurn(r);
    expect(r.log().filter((m) => m.http)).toContainEqual({ http: 'GET /global/event', auth: true });
  });

  it.skipIf(process.platform === 'win32')('ends a turn quietly: its stream resetting while the process exits is no security event (ended or stopped)', async () => {
    const quiet = async (r: Turn) => {
      r.o.env.FAKE_OC_SLOW_EXIT = String(WATCH_CLOSE_GRACE_MS + 500); // the stream resets at once; the exit comes after the grace
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const out = await runTurn(r).catch((e: unknown) => e);
        await new Promise((res) => setTimeout(res, 50));
        expect(warn.mock.calls.filter((c) => String(c[0]).startsWith('[opencode]'))).toEqual([]);
        return out;
      } finally {
        warn.mockRestore();
      }
    };
    // An ordinary end: the watch stops as the prompt answers, before the process is told to exit.
    const done = turn('edit-mode-config', { permission: 'edit' }, () => ({ allow: true }));
    expect(await quiet(done)).toMatchObject({ sessionId: expect.any(String) });
    expect(sent(done, 'session/cancel')).toEqual([]);
    // A stop: only the user's own session/cancel, and the turn ends as stopped, not as a security error.
    const stopped = turn('cancel-then-next-prompt', { permission: 'edit', onEvent: (e) => (stopped.events.push(e), e.type === 'text' && stopped.abort.abort()) }, () => ({ allow: true }));
    const err = (await quiet(stopped)) as AgentRunError;
    expect(err).toBeInstanceOf(AgentRunError);
    expect(err.message).toBe(t().stopped);
    expect(sent(stopped, 'session/cancel')).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('ends the run with a security error when something else drives its server', async () => {
    const replied = { type: 'permission.replied', properties: { sessionID: 'ses_x', requestID: 'per_foreign', reply: 'once' } };
    const r = turn('edit-mode-config', { permission: 'edit' }, () => ({ allow: true }));
    r.o.env.FAKE_OC_FOREIGN = JSON.stringify(replied);
    const err = (await withLang('en', () => runTurn(r)).catch((e: unknown) => e)) as AgentRunError;
    expect(err).toBeInstanceOf(AgentRunError);
    expect(err.message).toBe(
      withLang('en', () => t().opencodeForeignControl('a permission request (per_foreign) was answered "once" by something other than Harness Relay')),
    );
    expect(sent(r, 'session/cancel')).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('does not run below full access when its server cannot be watched', async () => {
    const r = turn('edit-mode-config', { permission: 'edit' });
    r.o.env.FAKE_OC_NO_EVENTS = '1';
    const err = (await withLang('en', () => runTurn(r)).catch((e: unknown) => e)) as AgentRunError;
    expect(err.message).toBe(withLang('en', () => t().opencodeWatchFailed('its event stream answered 500')));
    expect(sent(r, 'session/prompt')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('read-only without asking the user (approvals refused): refused at once', async () => {
    const r = turn('edit-mode-config', { permission: 'read-only' });
    await runTurn(r);
    expect(answers(r).map((x) => x.result?.outcome?.optionId)).toEqual(['reject', 'reject']);
  });

  it.skipIf(process.platform === 'win32')('stops: session/cancel, and the turn ends as stopped', async () => {
    const r = turn('cancel-then-next-prompt', { onEvent: (e) => (r.events.push(e), e.type === 'text' && r.abort.abort()) });
    const err = await runTurn(r).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunError);
    expect((err as AgentRunError).aborted).toBe(true);
    expect(sent(r, 'session/cancel')).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')("resumes with session/resume, and counts only this turn's calls, a stopped turn's before it not among them", async () => {
    const session = 'ses_e3a7ee4f4ffe2IzySQqvlHk7AO';
    const r = turn('resume-3-session-resume', { sessionId: session, effort: 'low' });
    // Earlier turns' calls, a stopped turn's and a subagent's among them, all made before this turn.
    addOpencodeRows(dbOf(r), {
      sessions: [{ id: 'ses_child', parent: session }],
      steps: [
        { id: 'prt_a', session, input: 100, output: 10, cost: 0.0001 },
        { id: 'prt_stopped', session, input: 200, output: 20, cost: 0.0002 },
        { id: 'prt_child_old', session: 'ses_child', input: 50, output: 5, cost: 0.00005 },
      ],
    });
    withCalls(r, {
      sessions: [{ id: 'ses_grandchild', parent: 'ses_child' }],
      steps: [
        { id: 'prt_b', session, input: 3, cacheRead: 9000, cacheWrite: 41, output: 8, reasoning: 2, cost: 0.0003 },
        // The subagent it had (resumed by the task tool) and the one that one started.
        { id: 'prt_child_new', session: 'ses_child', input: 7, output: 1, cost: 0.00004 },
        { id: 'prt_grandchild', session: 'ses_grandchild', input: 5, cacheRead: 5, output: 1, cost: 0.00002044 },
      ],
    });
    const result = await runTurn(r);
    expect(sent(r, 'session/resume')[0]!.params).toMatchObject({ sessionId: 'ses_e3a7ee4f4ffe2IzySQqvlHk7AO', mcpServers: [] });
    expect(sent(r, 'session/set_config_option')).toEqual([]); // model and effort as the session has them
    expect(textOf(r)).toBe('BLUE-HERON-42');
    expect(result).toEqual({ sessionId: session, inputTokens: 9044 + 7 + 10, outputTokens: 10 + 1 + 1, costUsd: 0.00036044 });
  });

  it.skipIf(process.platform === 'win32')('a session it cannot resume fails before anything is said, without its error data', async () => {
    const r = turn('resume-5-resume-unknown-id', { sessionId: 'ses_doesnotexist000000000000' });
    const err = (await withLang('en', () => runTurn(r)).catch((e: unknown) => e)) as AgentRunError;
    expect(err.message).toBe(withLang('en', () => t().openResumeFailed('OpenCode', 'Internal error: OpenCode service failure')));
    expect(r.events).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('a bad key: the backend error, with where to fix it', async () => {
    const r = turn('bad-key');
    const err = (await withLang('en', () => runTurn(r)).catch((e: unknown) => e)) as AgentRunError;
    expect(err.message).toBe(withLang('en', () => t().opencodeBackendError('Anthropic', 'invalid x-api-key')));
  });

  it.skipIf(process.platform === 'win32')('a model OpenCode does not know: refused when it is set', async () => {
    const r = turn('bad-model-config-option', { model: 'anthropic/claude-nonexistent-9' });
    const err = (await withLang('en', () => runTurn(r)).catch((e: unknown) => e)) as AgentRunError;
    expect(err.message).toBe(
      withLang('en', () => t().openRejectedModel('OpenCode', 'anthropic/claude-nonexistent-9', 'Invalid params: model not found: anthropic/claude-nonexistent-9')),
    );
    expect(sent(r, 'session/prompt')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')("a model the endpoint does not have: the endpoint's answer", async () => {
    const r = turn('bad-model-endpoint', { model: 'homelab/no-such-model' });
    const err = (await withLang('en', () => runTurn(r)).catch((e: unknown) => e)) as AgentRunError;
    expect(err.message).toBe(withLang('en', () => t().opencodeBackendError('Homelab', 'The model `no-such-model` does not exist')));
    const config = JSON.parse(r.log()[0]!.env.OPENCODE_CONFIG_CONTENT);
    expect(Object.keys(config.provider['relay-homelab'].models)).toEqual(['muse-glimmer-30b-nvfp4', 'no-such-model']);
  });

  it.skipIf(process.platform === 'win32')("passes the tool library's MCP servers, stdio and HTTP", async () => {
    const servers: McpServerSpec[] = [
      { name: 'relayecho', transport: 'stdio', command: 'node', args: ['echo.mjs'], url: '', env: { A: '1' }, headers: {} },
      { name: 'relayhttp', transport: 'http', command: '', args: [], url: 'http://127.0.0.1:18765/mcp', env: {}, headers: { 'x-relay-token': 'tok' } },
    ];
    const r = turn('mcp-http', { mcpServers: servers, permission: 'read-only' }, () => ({ allow: true }));
    await runTurn(r);
    expect(sent(r, 'session/new')[0]!.params.mcpServers).toEqual([
      { name: 'relayecho', command: 'node', args: ['echo.mjs'], env: [{ name: 'A', value: '1' }] },
      { type: 'http', name: 'relayhttp', url: 'http://127.0.0.1:18765/mcp', headers: [{ name: 'x-relay-token', value: 'tok' }] },
    ]);
    // An MCP tool asks in read-only, as an "other" tool by its name.
    expect(r.approvals).toEqual([{ kind: 'other', tool: 'relayhttp_http_marker', reason: 'relayhttp_http_marker', readOnlySandbox: true }]);
  });

  it.skipIf(process.platform === 'win32')('an MCP tool in edit runs without asking', async () => {
    const r = turn('mcp-stdio', { permission: 'edit' }, () => ({ allow: false }));
    await runTurn(r);
    expect(r.approvals).toEqual([]);
    expect(textOf(r)).toContain('MCP-MARKER-913');
  });
});

/** A run context for the hooks, in a fresh home. */
function context(over: Partial<RunOptions> = {}, model = 'anthropic/claude-haiku-5-5'): OpenRunContext {
  const dir = join(root, `ctx-${++n}`);
  const homeRoot = join(dir, 'home');
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(dir, 'cwd'), { recursive: true });
  const o: RunOptions = {
    bin: 'opencode',
    env: { HOME: join(dir, 'user'), [OPEN_AGENT_HOME_ENV]: homeRoot },
    prompt: 'hi',
    systemPrompt: 'You are @Ada.',
    cwd: join(dir, 'cwd'),
    permission: 'read-only',
    model,
    signal: new AbortController().signal,
    onEvent: () => undefined,
    backends: backends(),
    ...over,
  };
  const run = backendRun(o.backends, o.model, 'OpenCode');
  // On Linux unless a test says otherwise: relay-shell is not used on Windows.
  return { o, run, home: { root: homeRoot, state: homeRoot, ...opencodeHome(homeRoot) }, env: { ...o.env }, sandboxed: o.permission !== 'full', platform: 'linux', tmpDir: tmp, state: {} };
}

describe('its home', () => {
  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('points every folder into the home, and says which are state and which config', () => {
    const h = opencodeHome('/h');
    expect(h.env).toMatchObject({
      XDG_CONFIG_HOME: '/h/config',
      XDG_DATA_HOME: '/h/data',
      XDG_STATE_HOME: '/h/state',
      XDG_CACHE_HOME: '/h/cache',
      OPENCODE_TEST_HOME: '/h/home',
      OPENCODE_CONFIG_DIR: '/h/config/opencode',
      OPENCODE_MODELS_PATH: '/h/cache/opencode/models.json',
      OPENCODE_AUTH_CONTENT: '{}',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_PURE: '1',
    });
    expect(h.statePaths).toEqual(['/h/data', '/h/state']);
    expect(h.configPaths).toEqual(['/h/config', '/h/home', '/h/cache']);
    expect(opencodePaths('/h').db).toBe('/h/data/opencode/opencode.db');
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('keeps its config folder exactly as Harness Relay writes it, read-only, and the home stand-in empty', () => {
    const home = join(root, `home-${++n}`);
    ensureOpencodeHome(home);
    const p = opencodePaths(home);
    expect(readdirSync(p.configDir).sort()).toEqual(['.gitignore', 'opencode.json', OPENCODE_SHELL]);
    expect(JSON.parse(readFileSync(join(p.configDir, 'opencode.json'), 'utf8'))).toEqual(OPENCODE_STATIC_CONFIG);
    // LSP and formatters are off so OpenCode never starts a project program on its own (biome, tsserver…).
    expect(OPENCODE_STATIC_CONFIG).toMatchObject({ lsp: false, formatter: false, snapshot: false });
    expect(readFileSync(join(p.configDir, '.gitignore'), 'utf8')).toBe(OPENCODE_GITIGNORE);
    expect(statSync(p.configDir).mode & 0o777).toBe(0o555);
    expect(statSync(p.home).mode & 0o777).toBe(0o555);
    // Nothing to do when it is as it should be.
    const before = statSync(join(p.configDir, 'opencode.json')).mtimeMs;
    ensureOpencodeHome(home);
    expect(statSync(join(p.configDir, 'opencode.json')).mtimeMs).toBe(before);
    // What a full-access run may leave there goes.
    chmodSync(p.configDir, 0o755);
    mkdirSync(join(p.configDir, 'plugins'));
    writeFileSync(join(p.configDir, 'plugins', 'auto-allow.ts'), 'export default {}');
    chmodSync(join(p.configDir, 'plugins'), 0o555);
    mkdirSync(join(p.config, 'git'));
    writeFileSync(join(p.config, 'git', 'config'), '[core]\n');
    chmodSync(p.home, 0o755);
    mkdirSync(join(p.home, '.opencode'));
    writeFileSync(join(p.home, '.opencode', 'opencode.json'), '{}');
    ensureOpencodeHome(home);
    expect(readdirSync(p.configDir).sort()).toEqual(['.gitignore', 'opencode.json', OPENCODE_SHELL]);
    expect(readdirSync(p.config)).toEqual(['opencode']);
    expect(readdirSync(p.home)).toEqual([]);
    // A changed file is written again.
    chmodSync(p.configDir, 0o755);
    chmodSync(join(p.configDir, 'opencode.json'), 0o644);
    writeFileSync(join(p.configDir, 'opencode.json'), '{"permission":"allow"}');
    ensureOpencodeHome(home);
    expect(JSON.parse(readFileSync(join(p.configDir, 'opencode.json'), 'utf8'))).toEqual(OPENCODE_STATIC_CONFIG);
  });

  it('removes console accounts, sessions\' permission rules and saved permissions from its database, and throws when it cannot', () => {
    const dir = join(root, `db-${++n}`);
    mkdirSync(dir);
    const file = join(dir, 'opencode.db');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file);
    for (const table of [...OPENCODE_ACCOUNT_TABLES, OPENCODE_SAVED_PERMISSIONS_TABLE]) {
      db.exec(`CREATE TABLE "${table}" (id TEXT); INSERT INTO "${table}" VALUES ('planted');`);
    }
    // A run's command wrote rules into its session row, which OpenCode would apply over the agent's own.
    const allowAll = JSON.stringify([{ permission: '*', pattern: '*', action: 'allow' }]);
    db.exec(`CREATE TABLE session (id TEXT, title TEXT, permission TEXT); INSERT INTO session VALUES ('s1', 'kept', '${allowAll}'), ('s2', 'kept', NULL);`);
    db.close();
    scrubOpencodeDatabase(file);
    const after = new DatabaseSync(file);
    for (const table of [...OPENCODE_ACCOUNT_TABLES, OPENCODE_SAVED_PERMISSIONS_TABLE]) {
      expect(after.prepare(`SELECT count(*) AS n FROM "${table}"`).get()).toEqual({ n: 0 });
    }
    // The sessions stay, without rules of their own.
    expect(after.prepare('SELECT id, title, permission FROM session ORDER BY id').all()).toEqual([
      { id: 's1', title: 'kept', permission: null },
      { id: 's2', title: 'kept', permission: null },
    ]);
    after.close();
    // A session table without the column (an older OpenCode) is left as it is.
    const old = join(dir, 'old.db');
    const o = new DatabaseSync(old);
    o.exec("CREATE TABLE session (id TEXT); INSERT INTO session VALUES ('kept');");
    o.close();
    scrubOpencodeDatabase(old);
    const oldAfter = new DatabaseSync(old);
    expect(oldAfter.prepare('SELECT count(*) AS n FROM session').get()).toEqual({ n: 1 });
    oldAfter.close();
    scrubOpencodeDatabase(join(dir, 'missing.db'));
    const bad = join(dir, 'bad.db');
    writeFileSync(bad, 'not a database');
    expect(() => scrubOpencodeDatabase(bad)).toThrow();
  });

  it('drops the triggers and views a command planted to put the rules back, and throws when the rules stay', () => {
    const dir = join(root, `db-${++n}`);
    mkdirSync(dir);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const allowAll = JSON.stringify([{ permission: '*', pattern: '*', action: 'allow' }]);
    // Triggers that write the rules back after any change (the scrub's, or OpenCode's own), and a view.
    const file = join(dir, 'opencode.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE session (id TEXT, permission TEXT); INSERT INTO session VALUES ('s1', '${allowAll}');
      CREATE TABLE "${OPENCODE_SAVED_PERMISSIONS_TABLE}" (id TEXT);
      CREATE TRIGGER keep AFTER UPDATE ON session BEGIN UPDATE session SET permission = '${allowAll}' WHERE id = NEW.id; END;
      CREATE TRIGGER "re""fill" AFTER DELETE ON "${OPENCODE_SAVED_PERMISSIONS_TABLE}" BEGIN INSERT INTO "${OPENCODE_SAVED_PERMISSIONS_TABLE}" VALUES ('planted'); END;
      CREATE VIEW sessions_view AS SELECT * FROM session;`);
    db.close();
    scrubOpencodeDatabase(file);
    const after = new DatabaseSync(file);
    expect(after.prepare('SELECT id, permission FROM session').all()).toEqual([{ id: 's1', permission: null }]);
    expect(after.prepare(`SELECT count(*) AS n FROM "${OPENCODE_SAVED_PERMISSIONS_TABLE}"`).get()).toEqual({ n: 0 });
    expect(after.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view')").all()).toEqual([]);
    after.close();
    // A generated column (which PRAGMA table_info does not list) keeps the rules: it throws.
    const generated = join(dir, 'generated.db');
    const g = new DatabaseSync(generated);
    g.exec(`CREATE TABLE session (id TEXT, permission TEXT GENERATED ALWAYS AS ('${allowAll}') VIRTUAL); INSERT INTO session (id) VALUES ('s1');`);
    g.close();
    expect(() => scrubOpencodeDatabase(generated)).toThrow();
  });

  it('starts the member\'s state over when its database cannot be cleared, and does not resume the session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    /** A context whose state folder is a member's own, in `private/` (as startOpenProcess gives it). */
    const member = (over: Partial<RunOptions>): OpenRunContext => {
      const ctx = context(over);
      const state = join(ctx.home.root, 'private', 'm1');
      mkdirSync(state, { recursive: true, mode: 0o700 });
      return { ...ctx, home: { root: ctx.home.root, state, ...opencodeHome(ctx.home.root, state) } };
    };
    const unreadable = (ctx: OpenRunContext) => {
      const file = opencodePaths(ctx.home.root, ctx.home.state).db;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'not a database');
      writeFileSync(join(ctx.home.state, 'left-behind'), 'x');
      return file;
    };
    // Resuming: the folder is emptied, and the run fails so that the orchestrator starts a fresh session.
    const resumed = member({ sessionId: 'ses_1', stateKey: 'conv.c1.a1' });
    const file = unreadable(resumed);
    await expect(withLang('en', () => prepareOpencode(resumed, async () => 1))).rejects.toThrow(/could not take out of OpenCode's database/);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(resumed.home.state)).toEqual([]);
    // A new session goes on, in the emptied folder.
    const fresh = member({ stateKey: 'conv.c2.a1' });
    const other = unreadable(fresh);
    await prepareOpencode(fresh, async () => 1);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(join(fresh.home.state, 'left-behind'))).toBe(false);
    warn.mockRestore();
  });
});

describe('the run config', () => {
  it('names providers and models as OpenCode does', () => {
    expect(opencodeProviderId({ kind: 'anthropic', backend: 'anthropic' })).toBe('anthropic');
    expect(opencodeProviderId({ kind: 'endpoint', backend: 'lmstudio' })).toBe('relay-lmstudio');
    expect(opencodeModelId({ kind: 'endpoint', backend: 'homelab', model: 'Qwen/Qwen3-8B' })).toBe('relay-homelab/Qwen/Qwen3-8B');
    expect(opencodeModelId({ kind: 'xai', backend: 'xai', model: 'grok-4.3' })).toBe('xai/grok-4.3');
  });

  it('asks about everything but reading below full access, and allows all in full access', () => {
    const ro = opencodePermission({ permission: 'read-only' });
    expect(Object.keys(ro)[0]).toBe('*'); // the last matching rule wins: "*" first
    expect(ro).toEqual({
      '*': 'ask',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      lsp: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      todowrite: 'allow',
      skill: 'allow',
      task: 'deny',
    });
    expect(opencodePermission({ permission: 'edit' })).toEqual({ ...ro, edit: 'allow' });
    expect(opencodePermission({ permission: 'full' })).toEqual({ '*': 'allow', skill: 'allow' });
    // Skills left out: none at all; single ones: denied by name.
    expect(opencodePermission({ permission: 'full', nativeOff: ['skills'] })).toEqual({ '*': 'allow', skill: 'deny' });
    expect(opencodePermission({ permission: 'edit', nativeItems: { skills: ['a', 'b'] } }).skill).toEqual({ '*': 'allow', a: 'deny', b: 'deny' });
  });

  it("finds the project's instruction files as OpenCode does: the first kind found, every copy up to the repository root", () => {
    const top = join(root, `proj-${++n}`);
    const sub = join(top, 'pkg', 'app');
    mkdirSync(join(top, '.git'), { recursive: true });
    mkdirSync(sub, { recursive: true });
    expect(opencodeProjectInstructions(sub)).toEqual([]);
    writeFileSync(join(top, 'CLAUDE.md'), 'c');
    expect(opencodeProjectInstructions(sub)).toEqual([join(top, 'CLAUDE.md')]);
    writeFileSync(join(top, 'AGENTS.md'), 'a');
    writeFileSync(join(sub, 'AGENTS.md'), 'a');
    expect(opencodeProjectInstructions(sub)).toEqual([join(sub, 'AGENTS.md'), join(top, 'AGENTS.md')]);
    // Above the repository root is not looked at.
    writeFileSync(join(root, 'AGENTS.md'), 'outside');
    expect(opencodeProjectInstructions(sub)).not.toContain(join(root, 'AGENTS.md'));
    rmSync(join(root, 'AGENTS.md'));
  });

  it('keeps OpenCode from filling in variables and files from what the config holds', () => {
    expect(opencodeBaseUrl('http://h:1/v1/${OPENAI_API_KEY}')).toBe('http://h:1/v1/%24%7BOPENAI_API_KEY}');
    const text = opencodeConfigText({ instructions: ['/p/{file:/etc/passwd}'], provider: { x: { name: '{env:OPENAI_API_KEY}' } } });
    expect(text).not.toMatch(/\{(env|file):/);
    expect(JSON.parse(text)).toEqual({ instructions: ['/p/{file:/etc/passwd}'], provider: { x: { name: '{env:OPENAI_API_KEY}' } } });
  });

  it("holds only the run's backend, the left-out subagents and the instruction files", () => {
    const ctx = context({ nativeOff: ['agents'] });
    const api = opencodeRunConfig(ctx.o, ctx.run, ['/p/AGENTS.md']);
    expect(api).toMatchObject({
      model: 'anthropic/claude-haiku-5-5',
      small_model: 'anthropic/claude-haiku-5-5',
      enabled_providers: ['anthropic'],
      instructions: ['/p/AGENTS.md'],
      agent: { title: { disable: true }, general: { disable: true }, explore: { disable: true } },
    });
    const one = context({ nativeItems: { agents: ['explore'] } });
    expect(opencodeRunConfig(one.o, one.run, []).agent).toEqual({ title: { disable: true }, explore: { disable: true } });
    expect(opencodeRunConfig(one.o, one.run, []).instructions).toBeUndefined();
    const ep = context({}, 'homelab/typed-model');
    const cfg = opencodeRunConfig(ep.o, ep.run, []) as any;
    expect(cfg.enabled_providers).toEqual(['relay-homelab']);
    expect(Object.keys(cfg.provider['relay-homelab'].models)).toEqual(['muse-glimmer-30b-nvfp4', 'typed-model']);
  });
});

describe('prepare', () => {
  it('writes the briefing with the refusal note below full access, the config and the variables', async () => {
    const ctx = context({ permission: 'edit' }, 'homelab/muse-glimmer-30b-nvfp4');
    writeFileSync(join(ctx.o.cwd, 'AGENTS.md'), 'rules');
    mkdirSync(join(ctx.o.env.HOME!, '.config', 'gh'), { recursive: true });
    await prepareOpencode(ctx, async () => 4321);
    const config = JSON.parse(ctx.env.OPENCODE_CONFIG_CONTENT!);
    const briefing = join(ctx.tmpDir, 'harness-relay-briefing.md');
    expect(config.instructions).toEqual([join(ctx.o.cwd, 'AGENTS.md'), briefing]);
    expect(readFileSync(briefing, 'utf8')).toBe(`You are @Ada.\n\n${OPENCODE_REFUSAL_NOTE}\n`);
    expect(ctx.state.port).toBe(4321);
    expect(opencodeAcp.args(ctx)).toEqual(['acp', '--port', '4321']);
    expect(ctx.env).toMatchObject({
      [OPENCODE_ENDPOINT_KEY_ENV]: 'endpoint-test-key',
      OPENCODE_SERVER_USERNAME: 'opencode',
      XDG_CACHE_HOME: join(ctx.tmpDir, 'cache'),
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      GH_CONFIG_DIR: join(ctx.o.env.HOME!, '.config', 'gh'),
    });
    expect(ctx.env.OPENCODE_SERVER_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(existsSync(join(ctx.home.root, 'config', 'opencode', '.gitignore'))).toBe(true);
  });

  it("keeps OpenCode's own shell on Windows, where relay-shell (a POSIX shell script) cannot run", async () => {
    const posix = context({ permission: 'full' });
    await prepareOpencode(posix, async () => 1);
    expect(JSON.parse(posix.env.OPENCODE_CONFIG_CONTENT!).shell).toBe(join(opencodePaths(posix.home.root).configDir, OPENCODE_SHELL));
    const windows: OpenRunContext = { ...context({ permission: 'full' }), platform: 'win32' };
    await prepareOpencode(windows, async () => 1);
    expect(JSON.parse(windows.env.OPENCODE_CONFIG_CONTENT!)).not.toHaveProperty('shell');
  });

  it('leaves out the instruction files when asked, has no briefing file without a briefing in full access, and no endpoint key on an API backend', async () => {
    const ctx = context({ permission: 'full', systemPrompt: '  ', nativeOff: ['instructions'] });
    writeFileSync(join(ctx.o.cwd, 'AGENTS.md'), 'rules');
    ctx.env[OPENCODE_ENDPOINT_KEY_ENV] = 'stale';
    ctx.env.GH_CONFIG_DIR = undefined;
    ctx.o.env.GH_CONFIG_DIR = '/mine/gh';
    await prepareOpencode(ctx, async () => 1);
    expect(JSON.parse(ctx.env.OPENCODE_CONFIG_CONTENT!).instructions).toBeUndefined();
    expect(ctx.env[OPENCODE_ENDPOINT_KEY_ENV]).toBeUndefined();
    expect(ctx.env.GH_CONFIG_DIR).toBeUndefined();
    expect(existsSync(join(ctx.tmpDir, 'harness-relay-briefing.md'))).toBe(false);
    expect(opencodeBriefing({ systemPrompt: '', permission: 'read-only' })).toBe(OPENCODE_REFUSAL_NOTE);
    expect(opencodeBriefing({ systemPrompt: 'Brief.', permission: 'full' })).toBe('Brief.');
  });

  it('declares what it needs from the relay sandbox: its own port only, and the variables it empties', () => {
    expect(opencodeSandbox({ state: { port: 4321 } })).toEqual({ localPorts: [4321], quietlyDeniedHosts: OPENCODE_QUIET_HOSTS });
    expect(opencodeSandbox({ state: {} })).toEqual({ quietlyDeniedHosts: OPENCODE_QUIET_HOSTS });
    expect(opencodeAcp.sandbox).toBe(opencodeSandbox);
    expect(OPENCODE_EMPTY_ENV).toContain('OPENCODE_PERMISSION');
    expect(opencodeAcp.proxyEnv).toEqual({});
    expect(opencodeAcp.emptyEnv).toBe(OPENCODE_EMPTY_ENV);
  });
});

describe('what its calls are', () => {
  it('maps its tools to ACP kinds', () => {
    expect(['bash', 'webfetch', 'apply_patch', 'glob', 'read', 'task', 'skill'].map(opencodeToolKind)).toEqual(['execute', 'fetch', 'edit', 'search', 'read', 'think', 'other']);
  });

  it('a folder outside the project: what the earlier call does', () => {
    const outside = { toolCallId: 'c1', kind: 'other', title: '/elsewhere', rawInput: { filepath: '/elsewhere/a.txt', parentDir: '/elsewhere' } };
    expect(describeOpencodeCall(outside, { kind: 'read', title: 'read' })).toEqual({ kind: 'read', title: 'read (outside the project: /elsewhere)', path: '/elsewhere/a.txt' });
    expect(describeOpencodeCall(outside, { kind: 'edit', title: 'write' })).toMatchObject({ kind: 'edit' });
    expect(describeOpencodeCall(outside, undefined)).toMatchObject({ kind: 'read', title: 'tool (outside the project: /elsewhere)' });
    expect(
      describeOpencodeCall({ kind: 'other', rawInput: { command: 'ls /etc', directories: ['/etc'], patterns: ['/etc/*'] } }, { kind: 'execute', title: 'bash' }),
    ).toEqual({ kind: 'execute', title: 'ls /etc (outside the project: /etc)', command: 'ls /etc', path: '/etc' });
  });

  it('the same call again (doom_loop): the kind of that tool', () => {
    expect(describeOpencodeCall({ kind: 'other', title: 'doom_loop', rawInput: { tool: 'bash', input: { command: 'make' } } }, undefined)).toEqual({
      kind: 'execute',
      tool: 'bash',
      title: 'bash (the same call again)',
      command: 'make',
    });
    expect(describeOpencodeCall({ kind: 'other', title: 'doom_loop', rawInput: { tool: 'read', input: { filePath: '/p/a' } } }, undefined)).toMatchObject({ kind: 'read', path: '/p/a' });
  });

  it('an MCP tool: its name; anything else: as ACP says', () => {
    expect(describeOpencodeCall({ kind: 'other', title: 'srv_tool', rawInput: {} }, undefined)).toEqual({ tool: 'srv_tool' });
    expect(describeOpencodeCall({ kind: 'execute', title: 'ls', rawInput: { command: 'ls' } }, undefined)).toEqual({});
  });

  it('hides todowrite and takes the plan from its input, leaving out cancelled items', () => {
    expect(hideOpencodeTool({ title: 'todowrite' })).toBe(true);
    expect(hideOpencodeTool({ title: 'write' })).toBe(false);
    expect(opencodePlan({ rawInput: {} })).toBeUndefined();
    expect(
      opencodePlan({ rawInput: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'cancelled' }, { content: 'c', status: 'weird' }, null] } }),
    ).toEqual([
      { text: 'a', status: 'completed' },
      { text: 'c', status: 'pending' },
    ]);
  });

  it('gives a call its input back when it ends, and an apply_patch its file', () => {
    const ctx = { state: {}, sandboxed: false };
    const f = (update: Record<string, any>) => filterOpencodeUpdate({ update }, ctx);
    expect(f({ sessionUpdate: 'agent_message_chunk', content: { text: 'x' } })).toEqual({ sessionUpdate: 'agent_message_chunk', content: { text: 'x' } });
    f({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'bash', rawInput: {} });
    f({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress', rawInput: { command: 'ls' } });
    expect(f({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' })).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't',
      status: 'completed',
      rawInput: { command: 'ls' },
    });
    f({ sessionUpdate: 'tool_call_update', toolCallId: 'p', status: 'in_progress', rawInput: { patchText: '*** Begin Patch\n*** Update File: src/a.ts\n@@' } });
    expect(f({ sessionUpdate: 'tool_call_update', toolCallId: 'p', status: 'failed' })!.rawInput).toEqual({ patchText: '*** Begin Patch\n*** Update File: src/a.ts\n@@', path: 'src/a.ts' });
    // Its own input at the end stays; one it never saw stays without.
    expect(f({ sessionUpdate: 'tool_call_update', toolCallId: 'q', status: 'completed' })).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'q', status: 'completed' });
    expect(f({ sessionUpdate: 'tool_call_update', status: 'completed' })).toEqual({ sessionUpdate: 'tool_call_update', status: 'completed' });
  });

  it('answers fs/write_text_file as done (never doing it), and nothing else', () => {
    expect(opencodeClientRequest('fs/write_text_file')).toEqual({ result: null });
    expect(opencodeClientRequest('terminal/create')).toBeUndefined();
  });
});

/** A fake JSON-RPC connection: answers by method, records requests. */
function fakeConn(answer: (method: string, params: any) => unknown = () => ({})) {
  const requests: [string, any][] = [];
  return {
    requests,
    onRequest: undefined as ((method: string, params: any) => unknown) | undefined,
    request: async (method: string, params: any) => {
      requests.push([method, params]);
      const a = answer(method, params);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

/** A context whose runs are not watched (as in full access), for the hooks' other steps. */
const unwatched = (ctx: OpenRunContext): OpenRunContext => ((ctx.sandboxed = false), ctx);

describe('after the session starts', () => {
  const state = (model: string, extra: any[] = []) => ({
    configOptions: [
      { id: 'model', category: 'model', currentValue: model },
      { id: 'mode', category: 'mode', currentValue: 'plan' },
      ...extra,
    ],
  });

  it('sets the mode to build, the model, then the effort from the options as they are after the model', async () => {
    const ctx = unwatched(context({ effort: 'high' }));
    const conn = fakeConn((method, p) =>
      p.configId === 'model' ? { configOptions: [{ id: 'model', currentValue: p.value }, { id: 'effort', category: 'thought_level', currentValue: 'low' }] } : null,
    );
    await opencodeAfterSession(conn as any, { sessionId: 's1', state: state('anthropic/claude-sonnet-4-6') }, ctx);
    expect(conn.requests.map(([, p]) => [p.configId, p.value])).toEqual([
      ['mode', 'build'],
      ['model', 'anthropic/claude-haiku-5-5'],
      ['effort', 'high'],
    ]);
  });

  it('leaves the effort alone when none is given, when the model has none, or when it is already set', async () => {
    for (const [effort, extra] of [
      [undefined, [{ id: 'effort', category: 'thought_level', currentValue: 'low' }]],
      ['high', []],
      ['high', [{ id: 'effort', category: 'thought_level', currentValue: 'high' }]],
    ] as const) {
      const ctx = unwatched(context(effort ? { effort } : {}));
      const conn = fakeConn(() => ({}));
      await opencodeAfterSession(conn as any, { sessionId: 's', state: { configOptions: [{ id: 'model', currentValue: 'anthropic/claude-haiku-5-5' }, ...extra] } }, ctx);
      expect(conn.requests).toEqual([]);
    }
  });

  it('says which setting it refused', async () => {
    const reject = (id: string) => (_m: string, p: any) => (p.configId === id ? new RpcError(-32602, 'Invalid params: nope', { x: 1 }) : {});
    const cases = [
      ['mode', () => t().openRejectedMode('OpenCode', 'build', 'Invalid params: nope')],
      ['model', () => t().openRejectedModel('OpenCode', 'anthropic/claude-haiku-5-5', 'Invalid params: nope')],
      ['effort', () => t().openRejectedEffort('OpenCode', 'max', 'Invalid params: nope')],
    ] as const;
    for (const [id, message] of cases) {
      const ctx = unwatched(context({ effort: 'max' }));
      const conn = fakeConn(reject(id));
      const err = await withLang('en', () =>
        opencodeAfterSession(conn as any, { sessionId: 's', state: state('x/y', [{ id: 'effort', category: 'thought_level', currentValue: 'low' }]) }, ctx),
      ).catch((e: unknown) => e);
      expect((err as Error).message).toBe(withLang('en', message));
    }
    const plain = unwatched(context());
    const err = await withLang('en', () =>
      opencodeAfterSession(fakeConn(() => new Error('gone')) as any, { sessionId: 's', state: state('x/y') }, plain),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe(withLang('en', () => t().openRejectedMode('OpenCode', 'build', 'gone')));
  });
});

describe('refusal reasons', () => {
  const pending = [
    { id: 'per_other', sessionID: 's1', tool: { callID: 'other' } },
    { id: 'per_1', sessionID: 's1', tool: { messageID: 'm', callID: 'call-1' } },
  ];

  /** A fake fetch for OpenCode's server: lists `list`, takes replies. */
  function fakeFetch(list: unknown, ok = true) {
    const calls: { url: string; init: any }[] = [];
    const fetcher = (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok, json: async () => list } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  }

  it('refuses the pending request through its server, with the reason', async () => {
    const { calls, fetcher } = fakeFetch(pending);
    const ok = await rejectWithReason({ port: 4321, password: 'pw' }, '/p q', 's1', 'call-1', 'Not run: read-only.', fetcher);
    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4321/permission?directory=%2Fp%20q');
    expect(calls[0]!.init.headers.authorization).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`);
    expect(calls[1]!.url).toBe('http://127.0.0.1:4321/permission/per_1/reply?directory=%2Fp%20q');
    expect(calls[1]!.init.method).toBe('POST');
    expect(JSON.parse(calls[1]!.init.body)).toEqual({ reply: 'reject', message: 'Not run: read-only.' });
  });

  it('finds a request by its own id, and gives up when there is none or the server says no', async () => {
    expect(await rejectWithReason({ port: 1, password: 'p' }, '/p', 's1', 'per_other', 'r', fakeFetch(pending).fetcher)).toBe(true);
    expect(await rejectWithReason({ port: 1, password: 'p' }, '/p', 's2', 'call-1', 'r', fakeFetch(pending).fetcher)).toBe(false);
    expect(await rejectWithReason({ port: 1, password: 'p' }, '/p', 's1', 'call-1', 'r', fakeFetch({}).fetcher)).toBe(false);
    expect(await rejectWithReason({ port: 1, password: 'p' }, '/p', 's1', 'call-1', 'r', fakeFetch(pending, false).fetcher)).toBe(false);
  });

  it('takes the reason out of the answer and hands it over first', async () => {
    const conn = fakeConn();
    const answer = { outcome: { outcome: 'selected', optionId: 'reject' }, ...opencodeRejection('because') };
    conn.onRequest = async () => answer;
    const ctx = { o: { cwd: '/p' } as RunOptions, env: { OPENCODE_SERVER_PASSWORD: 'pw' }, state: { port: 99 } };
    const sends: unknown[][] = [];
    opencodeRefusalBridge(conn as any, ctx, 's1', async (...args) => (sends.push(args), true));
    const out = await conn.onRequest!('session/request_permission', { sessionId: 's1', toolCall: { toolCallId: 'call-1' } });
    expect(out).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    expect(sends).toEqual([[{ port: 99, password: 'pw' }, '/p', 's1', 'call-1', 'because']]);
  });

  it("keeps the answer's other _meta, lets allowed answers and other requests through, and survives a failed hand-over", async () => {
    const conn = fakeConn();
    let next: unknown = { outcome: { outcome: 'selected', optionId: 'reject' }, _meta: { other: 1, ...(opencodeRejection('r')._meta as object) } };
    conn.onRequest = async () => next;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    opencodeRefusalBridge(conn as any, { o: { cwd: '/p' } as RunOptions, env: { OPENCODE_SERVER_PASSWORD: 'pw' }, state: { port: 1 } }, 's1', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await conn.onRequest!('session/request_permission', { toolCall: { toolCallId: 'c' } })).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' }, _meta: { other: 1 } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    next = { outcome: { outcome: 'selected', optionId: 'once' } };
    expect(await conn.onRequest!('session/request_permission', {})).toBe(next);
    next = null;
    expect(await conn.onRequest!('fs/write_text_file', {})).toBe(null);
    // Without a port or a password, nothing is handed over.
    const quiet = fakeConn();
    quiet.onRequest = async () => ({ outcome: { outcome: 'cancelled' }, ...opencodeRejection('r') });
    const sends: unknown[] = [];
    opencodeRefusalBridge(quiet as any, { o: { cwd: '/p' } as RunOptions, env: {}, state: {} }, 's1', async (...a) => (sends.push(a), true));
    expect(await quiet.onRequest!('session/request_permission', { toolCall: { toolCallId: 'c' } })).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(sends).toEqual([]);
    // A connection without a handler is left as it is.
    const none = fakeConn();
    opencodeRefusalBridge(none as any, { o: { cwd: '/p' } as RunOptions, env: {}, state: {} }, 's1');
    expect(none.onRequest).toBeUndefined();
  });
});

describe('keeping its server to Harness Relay', () => {
  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('runs its commands through a fixed read-only shell that drops the server password (shell from the environment)', () => {
    const home = join(root, `shell-${++n}`);
    ensureOpencodeHome(home);
    const wrapper = join(opencodePaths(home).configDir, OPENCODE_SHELL);
    expect(statSync(wrapper).mode & 0o777).toBe(0o555);
    // Fixed text: the user's shell is not baked in (AGENTS.md: a shell script's values go in the environment).
    expect(readFileSync(wrapper, 'utf8')).toBe(opencodeShellScript());
    expect(readFileSync(wrapper, 'utf8')).not.toContain('/bin/zsh');
    const run = (cmd: string, env: Record<string, string> = {}) =>
      spawnSync(wrapper, ['-c', cmd], { env: { PATH: '/usr/bin:/bin', [OPENCODE_SHELL_ENV]: '/bin/sh', ...env }, encoding: 'utf8' });
    const out = run('echo "pw=${OPENCODE_SERVER_PASSWORD:-unset} user=${OPENCODE_SERVER_USERNAME:-unset} shell=${HARNESS_RELAY_USER_SHELL:-unset} keep=$KEEP"', {
      OPENCODE_SERVER_PASSWORD: 'secret',
      OPENCODE_SERVER_USERNAME: 'opencode',
      KEEP: 'yes',
    });
    expect(out.stdout.trim()).toBe('pw=unset user=unset shell=unset keep=yes');
    // An unchanged home is left as it is; a changed mode is written again.
    chmodSync(opencodePaths(home).configDir, 0o755);
    chmodSync(wrapper, 0o755);
    ensureOpencodeHome(home);
    expect(statSync(wrapper).mode & 0o777).toBe(0o555);
    expect(opencodeUserShell('/bin/sh')).toBe('/bin/sh');
    expect(opencodeUserShell('zsh', 'darwin')).toBe('/bin/zsh');
    expect(opencodeUserShell("/bin/it's", 'darwin')).toBe('/bin/zsh');
    expect(['/bin/bash', '/bin/sh']).toContain(opencodeUserShell(undefined, 'linux'));
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('below full access refuses the hidden-substitution forms OpenCode would not ask about, and runs ordinary commands', () => {
    const home = join(root, `shell2-${++n}`);
    ensureOpencodeHome(home);
    const wrapper = join(opencodePaths(home).configDir, OPENCODE_SHELL);
    const cwd = join(root, `shellcwd-${n}`);
    mkdirSync(cwd, { recursive: true });
    const run = (cmd: string, shell = '/bin/bash', armed = true) =>
      spawnSync(wrapper, ['-c', cmd], { cwd, env: { PATH: '/usr/bin:/bin', [OPENCODE_SHELL_ENV]: shell, ...(armed ? { [OPENCODE_SHELL_SCREEN_ENV]: '1' } : {}) }, encoding: 'utf8' });
    const availableShells = ['/bin/bash', '/bin/zsh'].filter((s) => existsSync(s));
    // The traps: a command substitution hidden (single-quoted, escaped, `$'`, backquote) inside a subscript or
    // arithmetic the shell re-evaluates, or an eval. The inner `touch RAN` must never run.
    const traps = [
      "eval 'touch RAN'",
      "x='a[$(touch RAN)]'; a[x]=1",
      "x='a[$(touch RAN)]'; (( x ))",
      "declare 'a[$(touch RAN)]=1'",
      "x='a[`touch RAN`]'; a[x]=1",
      "y='[$''(touch RAN)]'; declare \"a$y=1\"",
      'y=a\\[\\$\\(touch\\ RAN\\)\\]; (( y ))',
      "x='a[$(touch RAN)]'; arr=([x]=1)",
      // The single-quoted text set aside only where it can be told apart: a declaration's quoted argument is
      // itself evaluated, and a quote the shell takes literally (in double quotes, a comment) or one left open
      // keeps the whole line looked at.
      "local 'a[$(touch RAN)]=1'",
      "typeset 'a[$(touch RAN)]=1'",
      `x='it'"'"'s'; y='a[$(touch RAN)]'; a[y]=1`,
      "x='a[$(touch RAN)]';a[x]=1 # it's",
      "x='a[$(touch RAN)]'; a[x]=1; echo 'open",
      "x='a[$(touch RAN)]'; a['k']=1; a[x]+=1",
      // `let` evaluates each argument, a quoted one too; bash evaluates a name in `$(( … ))` again.
      "let 'a[$(touch RAN)]=1'",
      "x='a[$(touch RAN)]'; let x+1",
      "x='a[$(touch RAN)]'; y=$((x+1))",
      'x=a\\[\\$\\(touch\\ RAN\\)\\]; echo $((x))',
    ];
    for (const shell of availableShells) {
      for (const trap of traps) {
        const r = run(trap, shell);
        expect(r.status).toBe(OPENCODE_SHELL_REFUSED);
        expect(r.stderr).toContain('Harness Relay refused');
        expect(existsSync(join(cwd, 'RAN'))).toBe(false);
      }
    }
    // Ordinary commands run: arithmetic `$((…))`, a live `$(…)` (which OpenCode itself asks about), the keyword
    // words as substrings (`npm run eval`, `--read-only`, `grep "eval("`), and the harmless no-command forms.
    const ordinary = [
      'echo hello',
      'echo $((1 + 2))',
      'X=$(echo hi); echo $X',
      'export FOO="$(echo hi)"; echo p',
      'if [[ -n "$(echo x)" ]]; then echo ok; fi',
      'count=$(echo 3); if (( count >= 0 )); then echo ok; fi',
      "awk '{print $1}' /dev/null; echo ok",
      'grep -c "eval(" /dev/null; echo ok',
      'echo npm run eval; echo ok',
      'export PATH=${HOME}/bin:$PATH; echo p',
      'printf "%s\\n" ok',
      // A subscript or arithmetic look-alike inside single quotes, with a `$` there too, is only text.
      "awk -F= '/^[A-Z_]+=/ {print $2}' /dev/null; echo ok",
      "grep -E '^[A-Z_]+=.*$' /dev/null; echo ok",
      "sed -n '/^[a-z]*=/p' /dev/null; echo ok",
      // Arithmetic beside a quoted `$`, and the word `let` as a substring or an argument.
      "echo $((1 + 2)) | awk '{print $1}'",
      "n=2; echo $((n * 2)); echo '$HOME'",
      "echo letter; grep -c 'let $x' /dev/null; echo ok",
    ];
    for (const shell of availableShells) for (const ok of ordinary) expect(run(ok, shell).status).toBe(0);
    // In full access the screen is not armed: even a trap runs (the sandbox is not there; every command runs anyway).
    expect(run("eval 'echo ran'", '/bin/bash', false).status).toBe(0);
    // The refusal message is single-quoted, so the shell never expands the `$(...)` it names.
    const r = run("x='a[$(touch RAN)]'; a[x]=1");
    expect(r.stderr).toContain('$(...)');
    expect(r.stderr).not.toMatch(/command not found/);
    expect(existsSync(join(cwd, 'RAN'))).toBe(false);
  });

  it('names the shell in the run config and in the environment, and arms the screen only below full access', async () => {
    const ctx = context({ permission: 'edit' });
    ctx.o.env.SHELL = '/bin/sh';
    await prepareOpencode(ctx, async () => 1);
    expect(JSON.parse(ctx.env.OPENCODE_CONFIG_CONTENT!).shell).toBe(join(ctx.home.root, 'config', 'opencode', OPENCODE_SHELL));
    expect(ctx.env[OPENCODE_SHELL_ENV]).toBe('/bin/sh');
    expect(ctx.env[OPENCODE_SHELL_SCREEN_ENV]).toBe('1');
    const full = context({ permission: 'full' });
    full.sandboxed = false;
    await prepareOpencode(full, async () => 1);
    expect(full.env[OPENCODE_SHELL_SCREEN_ENV]).toBeUndefined();
  });

  /** A fake fetch whose event stream sends `events` (then stays open until stopped; `send` adds one later). */
  function eventStream(events: unknown[], status = 200) {
    const calls: { url: string; init: any }[] = [];
    let close: (() => void) | undefined;
    let push: ((e: unknown) => void) | undefined;
    const fetcher = (async (url: string, init: any) => {
      calls.push({ url, init });
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ payload: e })}\n\n: comment\ndata: not json\n`));
          close = () => c.close();
          push = (e) => c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ payload: e })}\n`));
          init.signal.addEventListener('abort', () => c.error(new Error('aborted')));
        },
      });
      return { ok: status === 200, status, body } as unknown as Response;
    }) as unknown as typeof fetch;
    return { calls, fetcher, close: () => close?.(), send: (e: unknown) => push?.(e) };
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it('sees what only something else could have done on its server', async () => {
    const cases: [unknown[], string[]][] = [
      [[{ type: 'permission.asked', properties: { id: 'per_1', sessionID: 's1', tool: { callID: 'c1' } } }, { type: 'permission.replied', properties: { requestID: 'per_1', reply: 'once' } }], ['a permission request (per_1) was answered "once" by something other than Harness Relay']],
      [[{ type: 'permission.replied', properties: { requestID: 'per_9', reply: 'always' } }], ['a permission request (per_9) was answered "always" by something other than Harness Relay']],
      [[{ type: 'permission.replied', properties: { requestID: 'per_9', reply: 'reject' } }], []],
      [[{ type: 'session.created', properties: { info: { id: 'ses_child', parentID: 's1' } } }, { type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'busy' } } }], []],
      [[{ type: 'session.created', properties: { info: { id: 'ses_other' } } }], ['a session Harness Relay did not start was created (ses_other)']],
      [[{ type: 'session.status', properties: { sessionID: 'ses_old', status: { type: 'busy' } } }, { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } }], ['a session Harness Relay did not start was set to work (ses_old)']],
      [[{ type: 'session.updated', properties: { info: { id: 's1', permission: [{ permission: '*', pattern: '*', action: 'allow' }] } } }, { type: 'session.updated', properties: { info: { id: 's1', title: 't' } } }, { type: 'session.updated', properties: {} }], ['permission rules were set on the session (s1)']],
      [[{ type: 'pty.created', properties: {} }], ['a terminal was opened on its server']],
    ];
    for (const [events, expected] of cases) {
      const seen: string[] = [];
      const { fetcher, calls } = eventStream(events);
      const w = watchOpencode({ port: 4321, password: 'pw' }, 's1', (d) => seen.push(d), fetcher);
      await w.ready;
      await tick();
      expect(seen).toEqual(expected);
      expect(calls[0]!.url).toBe('http://127.0.0.1:4321/global/event');
      expect(calls[0]!.init.headers.authorization).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`);
      w.stop();
    }
  });

  it('ends the run when its stream closes or fails before the watch is stopped (fail closed), but not when we stop it in time', async () => {
    const grace = 30; // the close/fail foreign fires this long after, so the turn's cleanup can stop it first
    // The stream closes on its own: the watch is blind, so the run ends after the grace.
    const closed: string[] = [];
    const c = eventStream([]);
    const wc = watchOpencode({ port: 1, password: 'p' }, 's1', (d) => closed.push(d), c.fetcher, grace);
    await wc.ready;
    c.close();
    await tick();
    expect(closed).toEqual([]); // not yet
    await new Promise((r) => setTimeout(r, grace + 20));
    expect(closed).toEqual(['its event stream closed while the turn was running']);
    // The stream errors: likewise, after the grace.
    const failed: string[] = [];
    const errFetcher = (async (_u: string, init: any) => {
      const body = new ReadableStream<Uint8Array>({ start: (s) => (init.signal.addEventListener('abort', () => s.error(new Error('aborted'))), setTimeout(() => s.error(new Error('reset by peer')), 5)) });
      return { ok: true, status: 200, body } as unknown as Response;
    }) as unknown as typeof fetch;
    const wf = watchOpencode({ port: 1, password: 'p' }, 's1', (d) => failed.push(d), errFetcher, grace);
    await wf.ready;
    await new Promise((r) => setTimeout(r, grace + 30));
    expect(failed).toEqual(['its event stream failed while the turn was running: reset by peer']);
    // A close followed by stop() within the grace is suppressed (the normal turn end).
    const ended: string[] = [];
    const e = eventStream([]);
    const we = watchOpencode({ port: 1, password: 'p' }, 's1', (d) => ended.push(d), e.fetcher, grace);
    await we.ready;
    e.close();
    we.stop();
    await new Promise((r) => setTimeout(r, grace + 20));
    expect(ended).toEqual([]);
    // A turn being stopped (`closing()`): its stream closing is expected, but anything else still counts.
    const closing: string[] = [];
    const k = eventStream([]);
    const wk = watchOpencode({ port: 1, password: 'p' }, 's1', (d) => closing.push(d), k.fetcher, grace);
    await wk.ready;
    wk.closing();
    k.send({ type: 'pty.created', properties: { info: { id: 'pty_1' } } });
    k.close();
    await new Promise((r) => setTimeout(r, grace + 20));
    expect(closing).toHaveLength(1);
    expect(closing[0]).toMatch(/terminal/);
  });

  it("takes Harness Relay's own approvals as expected, and says nothing once stopped", async () => {
    const seen: string[] = [];
    const events = [
      { type: 'permission.asked', properties: { id: 'per_1', sessionID: 's1', tool: { callID: 'c1' } } },
      { type: 'permission.asked', properties: { id: 'per_2', sessionID: 's1' } },
    ];
    const { fetcher } = eventStream(events);
    const w = watchOpencode({ port: 1, password: 'p' }, 's1', (d) => seen.push(d), fetcher);
    await w.ready;
    await tick();
    w.allowed('c1');
    w.allowed('per_2');
    const later = eventStream([{ type: 'permission.replied', properties: { requestID: 'per_1', reply: 'once' } }]);
    // The same watch reading on: replies to the two allowed requests are fine.
    const w2 = watchOpencode({ port: 1, password: 'p' }, 's1', (d) => seen.push(d), (async (u: string, init: any) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          const send = (e: unknown) => c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ payload: e })}\n`));
          for (const e of events) send(e);
          init.signal.addEventListener('abort', () => c.error(new Error('aborted')));
          setTimeout(() => {
            send({ type: 'permission.replied', properties: { requestID: 'per_1', reply: 'once' } });
            send({ type: 'permission.replied', properties: { requestID: 'per_2', reply: 'once' } }); // stream stays open; close is its own test
          }, 30);
        },
      });
      void u;
      void init;
      return { ok: true, status: 200, body } as unknown as Response;
    }) as unknown as typeof fetch);
    await w2.ready;
    await tick();
    w2.allowed('c1');
    w2.allowed('per_2');
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toEqual([]);
    w.stop();
    w2.stop();
    void later;
    // Stopped: nothing is reported.
    const quiet: string[] = [];
    const q = eventStream([{ type: 'pty.created', properties: {} }]);
    const w3 = watchOpencode({ port: 1, password: 'p' }, 's1', (d) => quiet.push(d), q.fetcher);
    w3.stop();
    await w3.ready.catch(() => undefined);
    await tick();
    expect(quiet).toEqual([]);
    // A stream it cannot open: `ready` fails.
    await expect(watchOpencode({ port: 1, password: 'p' }, 's1', () => undefined, eventStream([], 401).fetcher).ready).rejects.toThrow('its event stream answered 401');
  });

  it('after the session, below full access: watches, fails closed, and ends the run on what it sees', async () => {
    const conn = () => ({ ...fakeConn(() => ({})), notify: vi.fn(), close: vi.fn() });
    const base = (ctx: OpenRunContext) => ({ sessionId: 's1', state: { configOptions: [{ id: 'model', currentValue: opencodeModelId(ctx.run) }, { id: 'mode', currentValue: 'build' }] } });
    // Without a port, or a stream that does not open: the run does not go on.
    const noPort = context({ permission: 'edit' });
    noPort.env.OPENCODE_SERVER_PASSWORD = 'pw';
    await expect(withLang('en', () => opencodeAfterSession(conn() as any, base(noPort), noPort))).rejects.toThrow(withLang('en', () => t().opencodeWatchFailed('no port or password for its server')));
    const broken = context({ permission: 'edit' });
    Object.assign(broken.state, { port: 1 });
    broken.env.OPENCODE_SERVER_PASSWORD = 'pw';
    const failing = () => ({ ready: Promise.reject(new Error('refused')), allowed: () => undefined, stop: vi.fn() });
    await expect(withLang('en', () => opencodeAfterSession(conn() as any, base(broken), broken, failing as any))).rejects.toThrow(withLang('en', () => t().opencodeWatchFailed('refused')));
    // Watching: something it sees cancels the turn and closes the connection with the security error.
    const ok = context({ permission: 'read-only' });
    Object.assign(ok.state, { port: 2 });
    ok.env.OPENCODE_SERVER_PASSWORD = 'pw';
    let report: ((d: string) => void) | undefined;
    const stop = vi.fn();
    const c = conn();
    await opencodeAfterSession(c as any, base(ok), ok, ((_s: unknown, _id: string, on: (d: string) => void) => ((report = on), { ready: Promise.resolve(), allowed: () => undefined, stop })) as any);
    withLang('en', () => report!('a terminal was opened on its server'));
    withLang('en', () => report!('again'));
    expect(c.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 's1' });
    expect(c.close).toHaveBeenCalledTimes(1);
    expect((c.close.mock.calls[0]![0] as Error).message).toBe(withLang('en', () => t().opencodeForeignControl('a terminal was opened on its server')));
    expect(stop).toHaveBeenCalled();
    // In full access nothing is watched.
    const full = context({ permission: 'full' });
    full.sandboxed = false;
    const watch = vi.fn();
    await opencodeAfterSession(conn() as any, base(full), full, watch as any);
    expect(watch).not.toHaveBeenCalled();
  });

  it('expects its stream to close once the sandbox says its process exited (a crash is no security error)', async () => {
    const ctx = context({ permission: 'edit' });
    Object.assign(ctx.state, { port: 3 });
    ctx.env.OPENCODE_SERVER_PASSWORD = 'pw';
    let exited: (() => void) | undefined;
    ctx.onAgentExit = (listener) => (exited = listener);
    const closing = vi.fn();
    const base = { sessionId: 's1', state: { configOptions: [{ id: 'model', currentValue: opencodeModelId(ctx.run) }, { id: 'mode', currentValue: 'build' }] } };
    await opencodeAfterSession({ ...fakeConn(() => ({})), notify: vi.fn(), close: vi.fn() } as any, base, ctx, (() => ({ ready: Promise.resolve(), allowed: () => undefined, closing, stop: vi.fn() })) as any);
    expect(closing).not.toHaveBeenCalled();
    exited!();
    expect(closing).toHaveBeenCalledTimes(1);
  });

  it('stops the watch as the prompt answers, and in its cleanup hook however else the turn ends', () => {
    const stop = vi.fn();
    const ctx = { state: { watch: { stop, allowed: () => undefined, closing: () => undefined, ready: Promise.resolve() } } } as unknown as OpenRunContext;
    opencodeAcp.endTurn!({ stopReason: 'end_turn' }, ctx, 's1');
    expect(stop).toHaveBeenCalledTimes(1);
    opencodeAcp.cleanup!(ctx);
    expect(stop).toHaveBeenCalledTimes(2);
    // No watch (full access, or set up never finished): harmless.
    expect(() => opencodeAcp.cleanup!({ state: {} } as OpenRunContext)).not.toThrow();
  });

  it('tells the watch which calls Harness Relay allowed', async () => {
    const allowed: string[] = [];
    const ctx = { o: { cwd: '/p' } as RunOptions, env: {}, state: { watch: { allowed: (c: string) => allowed.push(c), ready: Promise.resolve(), stop: () => undefined } } as any };
    const c = fakeConn();
    const options = [
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    let answer: unknown = { outcome: { outcome: 'selected', optionId: 'once' } };
    c.onRequest = async () => answer;
    opencodeRefusalBridge(c as any, ctx, 's1');
    await c.onRequest!('session/request_permission', { toolCall: { toolCallId: 'c1' }, options });
    answer = { outcome: { outcome: 'cancelled' } };
    await c.onRequest!('session/request_permission', { toolCall: { toolCallId: 'c2' }, options });
    expect(allowed).toEqual(['c1']);
    expect([...ctx.state.asked]).toEqual(['c1', 'c2']);
  });

  it('below full access, a command that ran without being asked about ends the run; the sandbox refusal is said in words', () => {
    const seen: string[] = [];
    const ctx = { state: { asked: new Set(['asked']), foreign: (d: string) => seen.push(d) } as any, sandboxed: true };
    const f = (update: Record<string, any>) => filterOpencodeUpdate({ update }, ctx);
    for (const [id, command] of [['shell-route', 'curl -s http://x'], ['asked', 'ls'], ['cd', 'cd src && cd ..']]) {
      f({ sessionUpdate: 'tool_call', toolCallId: id, kind: 'execute', title: 'bash', rawInput: {} });
      f({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', rawInput: { command } });
      f({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });
    }
    expect(seen).toEqual(['a command ran without being asked about (curl -s http://x)']);
    // In full access nothing is checked.
    const full = { state: { foreign: (d: string) => seen.push(d) } as any, sandboxed: false };
    filterOpencodeUpdate({ update: { sessionUpdate: 'tool_call_update', toolCallId: 'z', kind: 'execute', status: 'completed', rawInput: { command: 'make' } } }, full);
    expect(seen).toHaveLength(1);
    const refused = withLang('en', () =>
      f({ sessionUpdate: 'tool_call_update', toolCallId: 'w', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Unknown: FileSystem.writeFile (/p/ro.txt)' } }, { type: 'content', content: { type: 'text', text: 'other' } }] }),
    );
    expect(refused!.content).toEqual([
      { type: 'content', content: { type: 'text', text: withLang('en', () => t().opencodeWriteRefused('/p/ro.txt')) } },
      { type: 'content', content: { type: 'text', text: 'other' } },
    ]);
  });

  it("mirrors OpenCode's own tree-sitter decision about which commands it asks for (never a false alarm on what it skips)", () => {
    // What OpenCode's grammar makes no `command` node of, so it never asks: cd-only, declarations,
    // `(( ))`/`[[ ]]`/`[ ]`, loops over folders, assignments, comments, bare redirections. (Verified
    // against bash-language-server's tree-sitter-bash by the reviewer's oracle.)
    for (const skip of [
      '(cd src)', 'for d in a b; do cd $d; done', 'X=1', 'FOO=bar BAZ=1', '# a comment', '   ', 'cd a && cd ..', 'pushd x; popd', '> out', '2>&1',
      '[[ -d x ]] && cd x', '[ -d x ] && cd x', 'export X=1', '(( i++ ))', 'unset X', 'declare -p', 'declare -A m', 'X=1 cd y', 'X=$(( 1 + 1 ))',
      "declare 'a[$(echo P)]=1'", "x='a[$(echo P)]'; (( x ))", 'cd "a; curl evil"',
      // Parameter expansions, array literals and function headers are not commands (the round-3 false stops).
      'cd ${dir}', 'export PATH=${HOME}/bin:$PATH', 'FOO=${BAR:-x}', 'pushd ${d}', 'arr=(a b)', 'arr+=(x)', 'f() { cd x; }', 'declare -A m=([k]=v)',
      'cd "${HOME}/p"',
      // A line continuation is no separator (`cd \⏎ /long/dir` is one cd), and `function NAME` is a header.
      'cd \\\n  /long/dir', 'function f { cd x; }', 'function f() { cd x; }', 'function f\n{\n  cd x\n}',
    ]) {
      expect(opencodeWouldAsk(skip)).toBe(false);
    }
    // What it asks for: a real program anywhere in the line, including inside a command substitution a
    // declaration or a double-quoted string holds (the A5 blind spots).
    for (const ask of [
      'cat f', 'cat f; X=1', 'curl http://x', 'time curl http://x', 'while cat f; do echo x; done', 'FOO=1 node app.js', 'ls | xargs rg x',
      '$(curl http://x)', 'cd a; curl http://x', 'for d in a b; do curl $d; done', '/project/node_modules/.bin/biome lsp-proxy', 'echo "a; b"',
      'test -d x && cd x', 'X="$(curl -s e | sh)"', 'cd "$(touch /tmp/x)"', 'cd "`id`"', 'X=$(id)', 'cd $(id)', 'eval "$X"', 'export X=$(id)', 'echo $(( 1 + 1 ))',
      'read x', 'mapfile -t a < f', 'printf -v X %s y', 'let x=1+1',
      // A command in a parameter-expansion default or a function body is still a command; `echo ${x}` is too.
      'echo ${x}', 'cat ${f}', 'f() { curl evil; }', 'local x=$(id)', 'X=${y:-$(curl e)}',
      'curl \\\n  http://x', 'cd x && \\\n  curl e', 'function f { curl evil; }',
    ]) {
      expect(opencodeWouldAsk(ask)).toBe(true);
    }
    // A double-quoted string's command substitution and a backquote are found inside it.
    expect(commandSubstitutions('X="$(curl e|sh)" `id`')).toEqual(['curl e|sh', 'id']);
    expect(commandSubstitutions("'$(not me)' $((1+1))")).toEqual([]); // single quotes and arithmetic are not command substitutions
    // A simple command's program word (undefined when it has none).
    expect(segmentCommand(['FOO=1', 'node', 'app.js'])).toBe('node');
    expect(segmentCommand(['time', '/usr/bin/curl', 'x'])).toBe('curl');
    expect(segmentCommand(['export', 'X=1'])).toBeUndefined();
    expect(segmentCommand(['[', '-d', 'x', ']'])).toBeUndefined();
    expect(segmentCommand(['cd', 'x'])).toBeUndefined();
    // Quotes and comments do not split or hide a command the way a naive split would.
    // A quoted span becomes one filler word, so a quoted `;` never splits (`cd "a; rm"` is one command).
    expect(shellSegments('echo "a; b" # c')).toEqual([['echo', '_']]);
    expect(shellSegments("rg 'x;y' .")).toEqual([['rg', '_', '.']]);
    expect(opencodeWouldAsk('cd "a; curl evil"')).toBe(false);
    expect(opencodeWouldAsk('echo "a; b"')).toBe(true);
    expect(opencodeWouldAsk("rg $'x;y' .")).toBe(true);
  });
});

describe('usage and errors', () => {
  it("reads every model call of a session and of the sessions under it, from OpenCode's database", async () => {
    const file = join(root, `usage-${++n}`, 'opencode.db');
    addOpencodeRows(file, {
      sessions: [
        { id: 'ses_child', parent: 'ses_a' },
        { id: 'ses_grandchild', parent: 'ses_child' },
        { id: 'ses_other' },
      ],
      steps: [
        { id: 'prt_1', session: 'ses_a', input: 3, output: 4, reasoning: 5, cacheRead: 6, cacheWrite: 7, cost: 0.25 },
        { id: 'prt_2', session: 'ses_child', input: 1, output: 1, cost: 0.125 },
        { id: 'prt_3', session: 'ses_grandchild', input: 2, output: 2 },
        { id: 'prt_x', session: 'ses_other', input: 99, output: 99, cost: 9 },
      ],
      parts: [
        // Other parts, one of them saying "step-finish" in its text, and ones that are no JSON or no numbers.
        { id: 'prt_t', session: 'ses_a', data: JSON.stringify({ type: 'text', text: 'a step-finish part' }) },
        { id: 'prt_bad', session: 'ses_a', data: 'step-finish, not JSON' },
        {
          id: 'prt_odd',
          session: 'ses_a',
          // Written as a command could write it: JSON.stringify would make 1e400 null.
          data: '{"type":"step-finish","tokens":{"input":-5,"output":"x","reasoning":null,"cache":{"read":1e400}},"cost":"NaN"}',
        },
        // Numbers past 2^63 together: a sum of integers would fail, the whole read with it.
        {
          id: 'prt_huge',
          session: 'ses_other',
          data: '{"type":"step-finish","tokens":{"input":9000000000000000000},"cost":0}',
        },
        {
          id: 'prt_huge2',
          session: 'ses_other',
          data: '{"type":"step-finish","tokens":{"input":9000000000000000000},"cost":0}',
        },
      ],
    });
    // prt_1, prt_2, prt_3 and prt_odd (whose numbers count as 0), added up: one row comes back.
    expect(await opencodeTurnCalls(file, 'ses_a')).toEqual({ calls: 4, cost: 0.375, input: 6, output: 7, reasoning: 5, cacheRead: 6, cacheWrite: 7 });
    expect(await opencodeTurnCalls(file, 'ses_none')).toEqual({ calls: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    expect((await opencodeTurnCalls(file, 'ses_other'))!.input).toBe(99 + 1.8e19);
    // No database, or not OpenCode's: not known.
    expect(await opencodeTurnCalls(join(root, 'no-such.db'), 'ses_a')).toBeUndefined();
    const notOurs = join(root, `usage-${++n}.db`);
    writeFileSync(notOurs, 'not a database');
    expect(await opencodeTurnCalls(notOurs, 'ses_a')).toBeUndefined();
  });

  it('reads the parts there before a turn without their data, and leaves them out after it', async () => {
    const file = join(root, `usage-${++n}`, 'opencode.db');
    addOpencodeRows(file, { sessions: [{ id: 'ses_child', parent: 'ses_a' }], steps: [{ id: 'prt_1', session: 'ses_a', input: 1, output: 1 }], parts: [{ id: 'prt_t', session: 'ses_child', data: '{"type":"text"}' }] });
    // A part a command added without a text id: left out of the list (a NULL there would leave every part out).
    const odd = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(file);
    odd.exec(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (NULL, 'm', 'ses_a', 0, '{}'), (x'01', 'm', 'ses_a', 0, '{}')`);
    odd.close();
    const before = (await opencodePartIds(file, 'ses_a'))!;
    expect((JSON.parse(before) as string[]).sort()).toEqual(['prt_1', 'prt_t']);
    // And a NULL in a list handed back does not leave the turn's calls out either.
    expect(await opencodeTurnCalls(file, 'ses_a', '["prt_1", null, "prt_t"]')).toEqual({ calls: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    addOpencodeRows(file, { steps: [{ id: 'prt_2', session: 'ses_child', input: 2, output: 3, cost: 0.5 }] });
    expect(await opencodeTurnCalls(file, 'ses_a', before)).toEqual({ calls: 1, cost: 0.5, input: 2, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    expect(await opencodeTurnCalls(file, 'ses_a', JSON.stringify([...(JSON.parse(before) as string[]), null]))).toEqual({
      calls: 1,
      cost: 0.5,
      input: 2,
      output: 3,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    // A database without OpenCode's tables yet has no parts; one that cannot be read, none known.
    const empty = join(root, `usage-${++n}.db`);
    new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(empty).close();
    expect(await opencodePartIds(empty, 'ses_a')).toBe('[]');
    expect(await opencodeTurnCalls(empty, 'ses_a')).toEqual({ calls: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
    expect(await opencodePartIds(join(root, 'no-such.db'), 'ses_a')).toBeUndefined();
  });

  it("does not let a run's commands hold up the server: a view in place of a table, a link, a named pipe", async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    // A view where `part` was, whose query would never end.
    const viewed = join(root, `usage-${++n}`, 'opencode.db');
    addOpencodeRows(viewed, { steps: [{ id: 'prt_1', session: 'ses_a', input: 1, output: 1 }] });
    const db = new DatabaseSync(viewed);
    db.exec(`ALTER TABLE part RENAME TO part_old;
      CREATE VIEW part AS WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT 'prt_' || i AS id, 'ses_a' AS session_id, '{}' AS data FROM r;`);
    db.close();
    expect(await opencodeTurnCalls(viewed, 'ses_a')).toBeUndefined();
    expect(await opencodePartIds(viewed, 'ses_a')).toBeUndefined();
    // Links need a privilege on Windows, and named pipes are made with mkfifo.
    if (process.platform === 'win32') return;
    // A link to a database.
    const real = join(root, `usage-${++n}`, 'opencode.db');
    addOpencodeRows(real, { steps: [{ id: 'prt_1', session: 'ses_a', input: 1, output: 1 }] });
    const link = join(root, `usage-${++n}.db`);
    symlinkSync(real, link);
    expect(await opencodeTurnCalls(link, 'ses_a')).toBeUndefined();
    // A named pipe as the database, or as its write-ahead log: opening it would wait for a writer.
    const pipe = join(root, `usage-${++n}.db`);
    execFileSync('mkfifo', [pipe]);
    expect(await opencodeTurnCalls(pipe, 'ses_a')).toBeUndefined();
    execFileSync('mkfifo', [`${real}-wal`]);
    expect(await opencodeTurnCalls(real, 'ses_a')).toBeUndefined();
    expect(await opencodePartIds(real, 'ses_a')).toBeUndefined();
    // The scrub before a run refuses it too (the run then starts its state over).
    expect(() => scrubOpencodeDatabase(real)).toThrow(/not a plain file/);
  });

  it("counts the turn's calls with the cached input and the reasoning; an endpoint's zero cost is none", () => {
    const calls = (more: Partial<OpencodeCalls> = {}): OpencodeCalls => ({ calls: 2, cost: 0.3, input: 2, output: 4, reasoning: 6, cacheRead: 80, cacheWrite: 100, ...more });
    const api = { kind: 'anthropic' as const };
    const endpoint = { kind: 'endpoint' as const };
    expect(opencodeTurnUsage(calls(), api)).toEqual({ inputTokens: 182, outputTokens: 10, costUsd: 0.3 });
    // No price: 0 on an API backend (OpenCode counted it so), none on an endpoint.
    expect(opencodeTurnUsage(calls({ cost: 0 }), api)).toEqual({ inputTokens: 182, outputTokens: 10, costUsd: 0 });
    expect(opencodeTurnUsage(calls({ cost: 0 }), endpoint)).toEqual({ inputTokens: 182, outputTokens: 10 });
    expect(opencodeTurnUsage(calls(), endpoint)).toEqual({ inputTokens: 182, outputTokens: 10, costUsd: 0.3 });
    // Float noise is rounded off.
    expect(opencodeTurnUsage(calls({ cost: 0.1 + 0.2 }), api).costUsd).toBe(0.3);
    // No call in the turn, or the calls not known: nothing rather than a wrong number.
    expect(opencodeTurnUsage(calls({ calls: 0 }), api)).toEqual({});
    expect(opencodeTurnUsage(undefined, api)).toEqual({});
  });

  it('gives up on a session with more parts before a turn than it reads', async () => {
    const file = join(root, `usage-${++n}`, 'opencode.db');
    addOpencodeRows(file, { parts: [{ id: 'prt_0', session: 'ses_a', data: '{}' }] });
    const db = new (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync(file);
    db.exec(`WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 200000)
      INSERT INTO part (id, message_id, session_id, time_created, data) SELECT 'prt_' || i, 'msg', 'ses_a', 0, '{}' FROM r`);
    db.close();
    expect(await opencodePartIds(file, 'ses_a')).toBeUndefined();
  });

  it("reads the turn's usage from the member's database once the prompt has answered", async () => {
    const home = join(root, `usage-home-${++n}`);
    const state = join(home, 'private', 'k');
    const db = join(state, 'data', 'opencode', 'opencode.db');
    addOpencodeRows(db, { steps: [{ id: 'prt_1', session: 'ses_a', input: 1, output: 1, cost: 0.5 }, { id: 'prt_2', session: 'ses_a', input: 2, output: 2, cost: 0.25 }] });
    const ctx = (st: Record<string, unknown>) => ({ state: st, home: { root: home, state, env: {}, statePaths: [], configPaths: [] }, run: backendRun(backends(), 'anthropic/claude-haiku-5-5', 'OpenCode') });
    expect(await opencodeUsage(undefined, undefined, ctx({ sessionId: 'ses_a', partsBefore: '["prt_1"]' }))).toEqual({ inputTokens: 2, outputTokens: 2, costUsd: 0.25 });
    // What ACP says is not used: the last call's tokens only, the session's total cost.
    expect(await opencodeUsage({ usage: { inputTokens: 9, outputTokens: 9 } }, { cost: { amount: 9, currency: 'USD' } }, ctx({ sessionId: 'ses_a', partsBefore: '[]' }))).toEqual({
      inputTokens: 3,
      outputTokens: 3,
      costUsd: 0.75,
    });
    expect(await opencodeUsage(undefined, undefined, ctx({ partsBefore: '[]' }))).toEqual({});
    expect(await opencodeUsage(undefined, undefined, ctx({ sessionId: 'ses_a' }))).toEqual({});
    expect(stepData({ id: 'x', session: 'y' })).toContain('"type":"step-finish"');
  });

  it('says the backend error, an authentication problem, and strips the data of others', () => {
    const o = { model: 'homelab/m', backends: backends() };
    const en = <T>(f: () => T) => withLang('en', f);
    expect(en(() => (opencodeRunError(new AgentRunError('Internal error: The model `m` does not exist.: {"service":"session","errorName":"APIError"}'), o) as Error).message)).toBe(
      en(() => t().opencodeBackendError('Homelab', 'The model `m` does not exist')),
    );
    expect(en(() => (opencodeRunError(new AgentRunError('Authentication required: provider authentication required: {"providerId":"x"}'), o) as Error).message)).toBe(
      en(() => t().opencodeAuthRequired('Homelab')),
    );
    expect((opencodeRunError(new AgentRunError('X failed: Internal error: OpenCode service failure: {"service":"session"}'), o) as Error).message).toBe('X failed: Internal error: OpenCode service failure');
    // An internal error without OpenCode's data, a stop and other errors stay as they are.
    const internal = new AgentRunError('Internal error: something: {not json}');
    expect(opencodeRunError(internal, o)).toBe(internal);
    const stop = new AgentRunError('stopped', true);
    expect(opencodeRunError(stop, o)).toBe(stop);
    const other = new Error('plain');
    expect(opencodeRunError(other, o)).toBe(other);
    expect(en(() => (opencodeRunError(new AgentRunError('provider authentication required'), {}) as Error).message)).toBe(en(() => t().opencodeAuthRequired('OpenCode')));
  });
});

// Its stand-in CLI is a script, and Windows starts only real programs (`.exe`): tried on macOS and Linux.
describe('its catalog and what it loads by itself', () => {
  const verbose = readFileSync(join(FIXTURES, 'cli', 'models-verbose.txt'), 'utf8');

  it("lists the API backends' models that call tools and answer in text, with their efforts", () => {
    const models = parseOpencodeModels(verbose);
    expect(models.map((m) => m.id)).toEqual([
      'anthropic/claude-haiku-5-5',
      'anthropic/claude-sonnet-5-5',
      'openai/gpt-5.4-nano',
      'openai/gpt-6-luna',
      'xai/grok-4.20-0309-non-reasoning',
      'xai/grok-4.3',
    ]);
    expect(models.find((m) => m.id === 'anthropic/claude-haiku-5-5')).toEqual({ id: 'anthropic/claude-haiku-5-5', label: 'Claude Haiku 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(models.find((m) => m.id === 'xai/grok-4.20-0309-non-reasoning')!.efforts).toBeUndefined();
    // Deprecated models, other providers and broken blocks are left out.
    const more = `${verbose.replace('"id": "gpt-6-luna",', '"id": "gpt-6-luna", "status": "deprecated",')}opencode/big-pickle\n{\n  "capabilities": { "toolcall": true }\n}\nopenai/broken\n{\n  nope\n}\n`;
    expect(parseOpencodeModels(more).map((m) => m.id)).not.toContain('opencode/big-pickle');
    expect(parseOpencodeModels(more).map((m) => m.id)).not.toContain('openai/broken');
  });

  it('asks the CLI for its catalog with dummy keys only, in its home', async () => {
    const home = join(root, `cat-${++n}`);
    const calls: SpawnOptions[] = [];
    const run = async (o: SpawnOptions): Promise<SpawnResult> => (calls.push(o), result({ stdout: verbose }));
    const cat = await opencodeModels('opencode', { [OPEN_AGENT_HOME_ENV]: home, ...opencodeHome(home).env }, run);
    expect(cat.models.length).toBe(6);
    expect(calls[0]!.args).toEqual(['models', '--verbose']);
    expect(calls[0]!.env).toMatchObject({ OPENAI_API_KEY: 'harness-relay-catalog', ANTHROPIC_API_KEY: 'harness-relay-catalog', XAI_API_KEY: 'harness-relay-catalog', OPENCODE_PERMISSION: '' });
    expect(JSON.parse(calls[0]!.env.OPENCODE_CONFIG_CONTENT!)).toEqual({ enabled_providers: ['openai', 'anthropic', 'xai'] });
    expect(existsSync(join(home, 'config', 'opencode', '.gitignore'))).toBe(true);
    expect(await opencodeModels('opencode', { [OPEN_AGENT_HOME_ENV]: home }, async () => result({ timedOut: true }))).toEqual({ models: [], error: t().timedOut });
    expect(await opencodeModels('opencode', { [OPEN_AGENT_HOME_ENV]: home }, async () => result({ code: 1, stderr: 'a\nb\nboom' }))).toEqual({ models: [], error: 'a b boom' });
    expect((await opencodeModels('opencode', { [OPEN_AGENT_HOME_ENV]: home }, async () => result({ code: 1 }))).error).toBe(t().exitedWithoutTurn('OpenCode', 1));
  });

  it.skipIf(process.platform === 'win32')('reads its skills and subagents', () => {
    const skills = parseOpencodeSkills(readFileSync(join(FIXTURES, 'cli', 'debug-skill.json'), 'utf8'), '/home/user/project');
    expect(skills!.map((s) => [s.name, s.source, s.path])).toEqual([
      ['customize-opencode', 'built-in', undefined],
      ['user-agents-skill', 'user', '/home/user/.agents/skills/user-agents-skill/SKILL.md'],
      ['user-claude-skill', 'user', '/home/user/.claude/skills/user-claude-skill/SKILL.md'],
      ['proj-claude-skill', 'project', '/home/user/project/.claude/skills/proj-claude-skill/SKILL.md'],
    ]);
    expect(skills![2]).toMatchObject({ id: 'user-claude-skill', description: 'USER-CLAUDE-SKILL-CANARY-2' });
    expect(parseOpencodeSkills('no json', '/p')).toBeUndefined();
    expect(parseOpencodeSkills('{"a":1}', '/p')).toBeUndefined();
    expect(parseOpencodeSkills('[{"name":"x"},null,{"nope":1}]', '/p/')).toEqual([{ id: 'x', name: 'x', description: '', source: 'user' }]);
    expect(parseOpencodeAgents(readFileSync(join(FIXTURES, 'cli', 'agent-list.txt'), 'utf8'))).toEqual([
      { id: 'explore', name: 'explore', description: '', source: 'built-in' },
      { id: 'general', name: 'general', description: '', source: 'built-in' },
    ]);
    expect(parseOpencodeAgents('mine (all)\n')).toEqual([{ id: 'mine', name: 'mine', description: '', source: 'config' }]);
    expect(parseOpencodeAgents('nothing')).toBeUndefined();
  });

  it('asks the CLI what it loads for a folder, and the instruction files it would get', async () => {
    const home = join(root, `nat-${++n}`);
    const cwd = join(root, `natcwd-${n}`);
    mkdirSync(join(cwd, '.git'), { recursive: true });
    writeFileSync(join(cwd, 'AGENTS.md'), 'rules');
    const outputs: Record<string, string> = {
      debug: readFileSync(join(FIXTURES, 'cli', 'debug-skill.json'), 'utf8'),
      agent: readFileSync(join(FIXTURES, 'cli', 'agent-list.txt'), 'utf8'),
    };
    const run = async (o: SpawnOptions) => result({ stdout: outputs[o.args[0]!]! });
    const probe = await opencodeNative('opencode', { [OPEN_AGENT_HOME_ENV]: home }, cwd, 1000, run);
    expect(probe.skills).toHaveLength(4);
    expect(probe.agents).toHaveLength(2);
    expect(probe.memory).toEqual([{ path: join(cwd, 'AGENTS.md'), kind: 'instructions' }]);
    expect(probe).toMatchObject({ provider: 'opencode', cwd, mcpServers: [], memoryFromFiles: true, asRun: false, problems: [] });
    const failed = await opencodeNative('opencode', { [OPEN_AGENT_HOME_ENV]: home }, cwd, 1000, async (o) =>
      o.args[0] === 'debug' ? result({ code: 1, stderr: 'broken' }) : result({ timedOut: true }),
    );
    expect(failed.problems).toEqual([{ kind: 'failed', detail: 'broken' }, { kind: 'timeout' }]);
    expect(failed.skills).toEqual([]);
    expect(failed.agents).toBeUndefined();
    const silent = await opencodeNative('opencode', { [OPEN_AGENT_HOME_ENV]: home }, cwd, 1000, async () => result({ stdout: '???' }));
    expect(silent.problems).toEqual([{ kind: 'no-answer', part: 'skills' }, { kind: 'no-answer', part: 'agents' }]);
  });

  it.skipIf(process.platform === 'win32')('runs the real hooks against the fake CLI', async () => {
    const home = join(root, `hooks-${++n}`);
    const env = { PATH: process.env.PATH, [OPEN_AGENT_HOME_ENV]: home, FAKE_OC_CLI: join(FIXTURES, 'cli') };
    const cat = await opencodeAgent.models!(bin, env);
    expect(cat.models.length).toBe(6);
    const probe = await opencodeAgent.native!(bin, env, root, 10_000);
    expect(probe.skills.length).toBe(4);
    expect(opencodeAgent.efforts).toEqual([]);
  });
});

function result(over: Partial<SpawnResult> = {}): SpawnResult {
  return { code: 0, signal: null, stdout: '', stdoutBytes: Buffer.alloc(0), stdoutTruncated: false, stdoutSize: 0, stderr: '', aborted: false, timedOut: false, ...over };
}

// Kept for the type of permissions used above.
export type { Permission };
