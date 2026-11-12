import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalAnswer, Permission } from '../src/shared/types';
import { NATIVE_OFF_SUPPORT } from '../src/shared/types';
import type { BackendRun } from '../src/server/backends';
import { withLang } from '../src/server/i18n';
import type { RelaySandboxCommand, RelaySandboxSpec } from '../src/server/relaySandbox';
import { OPEN_AGENT_HOME_ENV } from '../src/server/settings';
import {
  PI_CONFIG_NAMES,
  PI_ENDPOINT_KEY_VAR,
  PI_ENV,
  PI_GATE_COMMAND,
  PI_GATE_PATH,
  PI_GATE_TITLE,
  PI_HEADER_MAX,
  PI_LEVELS,
  PI_NO_KEY,
  PiLines,
  PiRpc,
  createPiEventHandler,
  defaultPiDeps,
  piAgent,
  piArgs,
  piApprovalRequest,
  piCallDetail,
  piCallInfo,
  piConnectionDetail,
  piCatalog,
  piContextFiles,
  piDecide,
  piErrorKind,
  piErrorText,
  piGateAnswer,
  piGateLoaded,
  piGateRequest,
  piHomeLayout,
  piKnownModels,
  piMcpJson,
  piModelLevels,
  piModelRef,
  piModels,
  piModelsJson,
  piNative,
  piProcess,
  piPrompt,
  piProvider,
  piReadTools,
  piRunUsage,
  piSandbox,
  piSessionCwd,
  piSessionFile,
  piSettings,
  piToolDetail,
  piToolName,
  piTurn,
  preparePi,
  type PiTurnDeps,
} from '../src/server/agents/pi';
import type { OpenRunContext } from '../src/server/agents/open';
import { AgentRunError, type AgentEvent, type ApprovalRequest, type McpServerSpec, type RunOptions } from '../src/server/agents/types';
import { writeFakePi } from './fake-pi';


/** The state key of the runs here: their state is in `<home>/private/<key>`. */
const STATE_KEY = 'conv.c1.a1';
const FIX = join(import.meta.dirname, 'fixtures', 'pi');
const fixture = (name: string) => join(FIX, `${name}.jsonl`);
/** The records Pi sent in a fixture, in order. */
const piRecords = (name: string): Record<string, any>[] =>
  readFileSync(fixture(name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { dir: string; msg: Record<string, any> })
    .filter((r) => r.dir === 'pi')
    .map((r) => r.msg);

let root: string;
let bin: string;
let n = 0;
/** The catalog lookup the adapter really does (the tests swap in the recorded catalog). */
const realAsk = piKnownModels.ask;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-pi-'));
  bin = writeFakePi(join(root, 'fake-pi.mjs'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  piKnownModels.clear();
  // Pi's catalog, as the fake answers it from the recorded one.
  piKnownModels.ask = async () => new Set(piCatalog(piRecords('available-models').find((m) => m.command === 'get_available_models')!.data.models).models.map((m) => m.id));
});

const backends = {
  apis: { openai: 'sk-test-openai-0000', anthropic: 'sk-ant-test-0000', xai: 'xai-test-0000' },
  endpoints: [
    { id: 'homelab', name: 'Homelab', baseUrl: 'http://vllm.example:8000/v1', models: ['muse-glimmer-30b-nvfp4'], apiKey: 'endpoint-key-0000' },
    { id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5-coder:7b'] },
  ],
};

interface Run {
  o: RunOptions;
  events: AgentEvent[];
  approvals: ApprovalRequest[];
  log: () => Record<string, any>[];
  abort: AbortController;
  dir: string;
}

/** One turn's options against the fake Pi; `env` adds FAKE_PI_* settings. */
function run(env: Record<string, string> = {}, over: Partial<RunOptions> = {}, answer?: (req: ApprovalRequest) => ApprovalAnswer | Promise<ApprovalAnswer>): Run {
  const dir = join(root, `run-${++n}`);
  mkdirSync(join(dir, 'project'), { recursive: true });
  const logFile = join(dir, 'log.jsonl');
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const abort = new AbortController();
  const o: RunOptions = {
    bin,
    env: { PATH: process.env.PATH, FAKE_PI_LOG: logFile, [OPEN_AGENT_HOME_ENV]: join(dir, 'home'), ...env },
    prompt: 'What is in notes.txt?',
    systemPrompt: 'You are @Ada on a team.',
    cwd: join(dir, 'project'),
    stateKey: STATE_KEY,
    permission: 'full',
    model: 'openai/gpt-5.4-nano',
    signal: abort.signal,
    onEvent: (e) => events.push(e),
    backends,
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
  return { o, events, approvals, log, abort, dir };
}

const start = (r: Run) => r.log().find((m) => m.start)!;
const sent = (r: Run, type: string) => r.log().filter((m) => m.type === type);
const uiAnswers = (r: Run) => sent(r, 'extension_ui_response');

/** A relay sandbox that runs the command as it is, recording the spec it was given. */
function fakeSandbox(specs: RelaySandboxSpec[], failure?: string): Pick<PiTurnDeps, 'sandboxAvailable' | 'sandboxCommand' | 'makeRunDirs' | 'platform'> {
  return {
    platform: 'darwin',
    sandboxAvailable: async () => ({ ok: true }),
    makeRunDirs: () => {
      const dir = mkdtempSync(join(root, 'sandbox-run-'));
      mkdirSync(join(dir, 'tmp'));
      mkdirSync(join(dir, 'host'));
      return { tmp: join(dir, 'tmp'), hostTmp: join(dir, 'host') };
    },
    sandboxCommand: async (b, args, env, s) => {
      specs.push(s);
      return { bin: b, args, env, channel: (() => undefined) as unknown as RelaySandboxCommand['channel'], failure: () => failure, run: {} as RelaySandboxCommand['run'], dispose: async () => { for (const d of [s.dirs?.tmp, s.dirs?.hostTmp]) if (d) rmSync(d, { recursive: true, force: true }); } };
    },
  };
}

const deps = (over: Partial<PiTurnDeps> = {}): PiTurnDeps => ({ ...defaultPiDeps, runTmpDir: join(root, 'run-tmp'), ...over });
const sandboxed = (specs: RelaySandboxSpec[] = [], failure?: string) => deps(fakeSandbox(specs, failure));
const en = <T>(fn: () => Promise<T>) => withLang('en', fn);

/** A BackendRun as `backendRun()` makes it. */
function backendRunOf(id: string): BackendRun {
  const [backend, ...rest] = id.split('/');
  const model = rest.join('/');
  const endpoint = backends.endpoints.find((e) => e.id === backend);
  return {
    id,
    backend: backend!,
    kind: endpoint ? 'endpoint' : (backend as 'openai'),
    model,
    env: {},
    ...(endpoint ? { endpoint: { ...endpoint } } : {}),
    hosts: endpoint ? [new URL(endpoint.baseUrl).host] : [`api.${backend}.com`],
    backends,
  };
}

/** A run context as `startOpenProcess` makes it, for the hooks. */
function context(over: Partial<RunOptions> = {}, model = 'openai/gpt-5.4-nano'): OpenRunContext {
  const r = run({}, { model, ...over });
  const homeRoot = join(r.dir, 'home');
  const tmpDir = join(r.dir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const layout = piHomeLayout(homeRoot);
  return { o: r.o, run: backendRunOf(model), home: { root: homeRoot, state: homeRoot, ...layout }, env: { ...r.o.env, ...layout.env }, sandboxed: r.o.permission !== 'full', tmpDir, state: {} };
}

const stdio: McpServerSpec = { name: 'shout', transport: 'stdio', command: 'node', args: ['shout.mjs'], url: '', env: { TOKEN: 'secret-1' }, headers: {} };
const http: McpServerSpec = { name: 'my docs.v2', transport: 'http', command: '', args: [], url: 'https://docs.example/mcp', env: {}, headers: { Authorization: 'Bearer secret-2' } };

// --- Home, config and arguments -----------------------------------------------------------------

describe('Pi: home and config', () => {
  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('keeps its sessions in its home and never points at ~/.pi', () => {
    const layout = piHomeLayout('/h');
    expect(layout).toEqual({
      env: { PI_CODING_AGENT_DIR: '/h/agent', PI_CODING_AGENT_SESSION_DIR: '/h/sessions', ...PI_ENV },
      statePaths: ['/h/sessions'],
      configPaths: [],
    });
    // No network at start, no telemetry, no code-loading caches.
    expect(PI_ENV).toEqual({ PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', JITI_FS_CACHE: 'false', NODE_DISABLE_COMPILE_CACHE: '1' });
    expect(piProcess.implemented).toBe(true);
    expect(piProcess.proxyEnv).toBeUndefined();
    expect(piProcess.emptyEnv).toContain('PI_PACKAGE_DIR');
    expect(piSandbox()).toEqual({});
  });

  it('names providers and models as Pi does', () => {
    expect(piProvider(backendRunOf('openai/gpt-5.4-nano'))).toBe('openai');
    expect(piProvider(backendRunOf('homelab/muse-glimmer-30b-nvfp4'))).toBe('relay-homelab');
    expect(piModelRef(backendRunOf('local/qwen2.5-coder:7b'))).toBe('relay-local/qwen2.5-coder:7b');
    expect(piSettings()).toMatchObject({ defaultProjectTrust: 'never', enableInstallTelemetry: false, cacheWarming: 'off', enableSkillCommands: false });
  });

  it('writes an endpoint into models.json with its key by variable, and an API model Pi does not know', () => {
    expect(piModelsJson(backendRunOf('openai/gpt-5.4-nano'))).toEqual({ providers: {} });
    expect(piModelsJson(backendRunOf('homelab/muse-glimmer-30b-nvfp4'), 'high')).toEqual({
      providers: {
        'relay-homelab': {
          name: 'Homelab',
          baseUrl: 'http://vllm.example:8000/v1',
          api: 'openai-completions',
          apiKey: `$${PI_ENDPOINT_KEY_VAR}`,
          models: [{ id: 'muse-glimmer-30b-nvfp4', name: 'muse-glimmer-30b-nvfp4', reasoning: true }],
        },
      },
    });
    // No key: a placeholder (Pi offers no model without one); a typed-in model joins the endpoint's; no effort: no reasoning.
    const local = piModelsJson(backendRunOf('local/other'), undefined) as any;
    expect(local.providers['relay-local'].apiKey).toBe(PI_NO_KEY);
    expect(local.providers['relay-local'].models.map((m: any) => [m.id, m.reasoning])).toEqual([
      ['qwen2.5-coder:7b', false],
      ['other', false],
    ]);
    expect(piModelsJson(backendRunOf('xai/grok-4.20-0309-non-reasoning'), undefined, false)).toEqual({
      providers: { xai: { models: [{ id: 'grok-4.20-0309-non-reasoning', name: 'grok-4.20-0309-non-reasoning', api: 'openai-responses', baseUrl: 'https://api.x.ai/v1', reasoning: false, input: ['text', 'image'] }] } },
    });
  });

  it('writes the tool library into mcp.json with its secrets in variables', () => {
    const { json, env } = piMcpJson([stdio, http, { ...stdio, name: 'shout' }]);
    expect(json).toEqual({
      mcpServers: {
        shout: { command: 'node', args: ['shout.mjs'], env: { TOKEN: '${HARNESS_RELAY_MCP_0_E_0}' }, exposure: 'direct' },
        'my_docs_v2': { url: 'https://docs.example/mcp', headers: { Authorization: '${HARNESS_RELAY_MCP_1_H_0}' }, exposure: 'direct' },
        shout_2: { command: 'node', args: ['shout.mjs'], env: { TOKEN: '${HARNESS_RELAY_MCP_2_E_0}' }, exposure: 'direct' },
      },
      autoEnableCodemode: false,
    });
    expect(env).toEqual({ HARNESS_RELAY_MCP_0_E_0: 'secret-1', HARNESS_RELAY_MCP_1_H_0: 'Bearer secret-2', HARNESS_RELAY_MCP_2_E_0: 'secret-1' });
    expect(JSON.stringify(json)).not.toContain('secret');
    expect(Object.keys(piMcpJson([{ ...stdio, name: '***' }]).json.mcpServers as object)).toEqual(['server']);
  });

  it('gives read-only the reading tools whose programs are there', () => {
    const dir = join(root, 'bins');
    mkdirSync(dir, { recursive: true });
    expect(piReadTools({ PATH: dir })).toEqual(['read', 'ls']);
    for (const b of ['fd', 'rg']) {
      writeFileSync(join(dir, b), '#!/bin/sh\n');
      chmodSync(join(dir, b), 0o755);
    }
    expect(piReadTools({ PATH: dir })).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('finds the session file to resume, and refuses a missing, moved or unreadable one', () => {
    const dir = join(root, 'sessions-a');
    mkdirSync(dir, { recursive: true });
    const cwd = join(root, 'proj-a');
    mkdirSync(cwd, { recursive: true });
    const header = (id: string, over: Record<string, unknown> = {}) => JSON.stringify({ type: 'session', version: 3, id, cwd, ...over });
    const files: Record<string, string> = {
      's-1': header('s-1') + '\n{}\n',
      's-2': header('s-2', { cwd: '/elsewhere' }) + '\n',
      's-3': 'not json\n',
      // Pi skips a line it cannot read and takes the next header: never resumed.
      's-4': 'junk\n' + header('s-4', { cwd: '/elsewhere' }) + '\n',
      // A header far longer than one read, naming another folder: still read whole, and refused.
      's-5': header('s-5', { cwd: '/elsewhere', pad: 'x'.repeat(200_000) }) + '\n',
      's-6': header('s-6', { pad: 'ü'.repeat(100_000) }), // long, multi-byte, no LF at the end: fine
      's-7': header('other') + '\n', // the header of another session
      's-8': header('s-8', { cwd: '' }) + '\n',
      's-9': '',
      's-10': '\n' + header('s-10') + '\n', // not on the first line
      's-11': JSON.stringify({ type: 'message', id: 's-11', cwd }) + '\n',
      's-12': 'null\n',
    };
    for (const [id, text] of Object.entries(files)) writeFileSync(join(dir, `2026-11-10T12-41-59-246Z_${id}.jsonl`), text);
    expect(piSessionFile(dir, 's-1', cwd)).toBe(join(dir, '2026-11-10T12-41-59-246Z_s-1.jsonl'));
    expect(piSessionFile(dir, 's-6', cwd)).toMatch(/s-6\.jsonl$/);
    expect(piSessionCwd(join(dir, '2026-11-10T12-41-59-246Z_s-5.jsonl'), 's-5')).toBe('/elsewhere');
    return en(async () => {
      expect(() => piSessionFile(dir, 'nope', cwd)).toThrow(/could not resume the earlier session: The file of session nope is gone/);
      expect(() => piSessionFile(dir, '../etc', cwd)).toThrow(/is gone/);
      expect(() => piSessionFile(join(root, 'no-dir'), 's-1', cwd)).toThrow(/is gone/);
      for (const id of ['s-2', 's-5']) expect(() => piSessionFile(dir, id, cwd)).toThrow(/the session's working directory is \/elsewhere/);
      for (const id of ['s-3', 's-4', 's-7', 's-8', 's-9', 's-10', 's-11', 's-12']) expect(() => piSessionFile(dir, id, cwd), id).toThrow(/could not resume the earlier session/);
    });
  });

  it('reads a session header only up to its limit', () => {
    const file = join(root, 'huge-header.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session', id: 'h', cwd: '/x', pad: 'x'.repeat(PI_HEADER_MAX + 10) }) + '\n');
    expect(piSessionCwd(file, 'h')).toBeUndefined();
    rmSync(file);
  });

  it('writes a fresh agent folder for the run, every config file read-only', async () => {
    const ctx = context({ permission: 'read-only', mcpServers: [stdio], effort: 'high' }, 'homelab/muse-glimmer-30b-nvfp4');
    await preparePi(ctx);
    const agentDir = join(ctx.tmpDir, 'pi-agent');
    expect(ctx.env.PI_CODING_AGENT_DIR).toBe(agentDir);
    expect(ctx.env[PI_ENDPOINT_KEY_VAR]).toBe('endpoint-key-0000');
    expect(ctx.env.HARNESS_RELAY_MCP_0_E_0).toBe('secret-1');
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))).toEqual(piSettings());
    expect(JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'))).toEqual({});
    expect(readFileSync(join(agentDir, 'models.json'), 'utf8')).not.toContain('endpoint-key-0000');
    expect(readFileSync(join(agentDir, 'harness-relay-briefing.md'), 'utf8')).toBe('You are @Ada on a team.\n');
    for (const d of ['extensions', 'skills', 'prompts', 'themes', 'bin']) expect(existsSync(join(agentDir, d))).toBe(true);
    for (const name of PI_CONFIG_NAMES) expect(ctx.home.configPaths).toContain(join(agentDir, name));
    expect(ctx.state).toMatchObject({ agentDir, mcp: true, tools: expect.arrayContaining(['read', 'ls', 'mcp__*']) });
    expect(existsSync(join(ctx.home.root, 'sessions'))).toBe(true);
  });

  it('adds a model Pi does not know to models.json, and leaves one it knows as its catalog says', async () => {
    const unknown = context({}, 'xai/grok-4.20-0309-non-reasoning');
    await preparePi(unknown);
    expect(JSON.parse(readFileSync(join(unknown.tmpDir, 'pi-agent', 'models.json'), 'utf8')).providers.xai.models[0].id).toBe('grok-4.20-0309-non-reasoning');
    const known = context({}, 'xai/grok-4.3');
    await preparePi(known);
    expect(JSON.parse(readFileSync(join(known.tmpDir, 'pi-agent', 'models.json'), 'utf8'))).toEqual({ providers: {} });
    // The catalog could not be asked: the model is left to Pi.
    piKnownModels.clear();
    piKnownModels.ask = async () => undefined;
    expect(await piKnownModels.has('pi', {}, 'xai/grok-4.20-0309-non-reasoning')).toBeUndefined();
  });

  it('asks Pi for its catalog once per program within ten minutes', async () => {
    let asked = 0;
    piKnownModels.ask = async () => {
      asked++;
      return new Set(['openai/gpt-5.4-nano']);
    };
    expect(await piKnownModels.has('pi-x', {}, 'openai/gpt-5.4-nano')).toBe(true);
    expect(await piKnownModels.has('pi-x', {}, 'openai/other')).toBe(false);
    expect(asked).toBe(1);
  });

  it('refuses to run when the gate is inside a folder the run may write', async () => {
    const ctx = context({ permission: 'edit', cwd: join(PI_GATE_PATH, '..') });
    await expect(en(() => preparePi(ctx))).rejects.toThrow(/gate extension .* is inside a folder this turn may write/);
    // Full access has no gate, so nothing to protect.
    await preparePi(context({ permission: 'full', cwd: join(PI_GATE_PATH, '..') }));
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('builds its arguments for each backend and permission', async () => {
    const cases: [string, Permission, Partial<RunOptions>][] = [
      ['openai/gpt-5.4-nano', 'full', {}],
      ['anthropic/claude-haiku-5-5', 'edit', { effort: 'high' }],
      ['xai/grok-4.3', 'read-only', { mcpServers: [stdio], nativeOff: ['instructions'] }],
      ['homelab/muse-glimmer-30b-nvfp4', 'edit', { effort: 'bogus' }],
    ];
    const got: string[][] = [];
    for (const [model, permission, over] of cases) {
      const ctx = context({ permission, ...over }, model);
      await preparePi(ctx);
      got.push(piArgs(ctx).map((a) => a.replace(ctx.tmpDir, '<tmp>')));
    }
    const base = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve'];
    const brief = ['--append-system-prompt', '<tmp>/pi-agent/harness-relay-briefing.md'];
    expect(got[0]).toEqual(['--mode', 'rpc', '--model', 'openai/gpt-5.4-nano', ...base, '--no-mcp', ...brief]);
    expect(got[1]).toEqual(['--mode', 'rpc', '--model', 'anthropic/claude-haiku-5-5', ...base, '-e', PI_GATE_PATH, '--no-mcp', ...brief, '--thinking', 'high']);
    expect(got[2]).toEqual(['--mode', 'rpc', '--model', 'xai/grok-4.3', ...base, '-e', PI_GATE_PATH, '-e', 'builtin:mcp', '--no-context-files', ...brief, '--tools', expect.stringMatching(/^read,.*ls,mcp__\*$/)]);
    // An effort that is no Pi level is not passed (Pi would refuse to start); the turn says why.
    expect(got[3]).toEqual(['--mode', 'rpc', '--model', 'relay-homelab/muse-glimmer-30b-nvfp4', ...base, '-e', PI_GATE_PATH, '--no-mcp', ...brief]);
    // Resuming: the session's file; no briefing when there is none.
    const sessions = join(root, 'sessions-b');
    const ctx = context({ systemPrompt: ' ' });
    mkdirSync(join(ctx.home.root, 'sessions'), { recursive: true });
    writeFileSync(join(ctx.home.root, 'sessions', 'x_abc.jsonl'), JSON.stringify({ type: 'session', id: 'abc', cwd: ctx.o.cwd }) + '\n');
    ctx.o.sessionId = 'abc';
    await preparePi(ctx);
    expect(piArgs(ctx)).toEqual(['--mode', 'rpc', '--model', 'openai/gpt-5.4-nano', ...base, '--no-mcp', '--session', join(ctx.home.root, 'sessions', 'x_abc.jsonl')]);
    expect(sessions).toBeTruthy();
  });
});

// --- The JSONL framing and the RPC ------------------------------------------------------------------

describe('Pi: JSONL framing', () => {
  it('splits records on LF only, across chunks and multi-byte characters', () => {
    const lines: string[] = [];
    const split = new PiLines((l) => lines.push(l));
    const data = Buffer.from('{"a":"x y z"}\r\n{"b":"ü€"}\n\n{"c":1}');
    for (let i = 0; i < data.length; i += 3) split.push(data.subarray(i, i + 3));
    expect(lines).toEqual(['{"a":"x y z"}', '{"b":"ü€"}']);
    split.end();
    expect(lines.at(-1)).toBe('{"c":1}');
    split.end(); // nothing left
    expect(lines).toHaveLength(3);
    // A handler that throws does not stop the stream.
    const after: string[] = [];
    const bad = new PiLines((l) => {
      after.push(l);
      throw new Error('boom');
    });
    bad.push(Buffer.from('{"x":1}\n{"y":2}\n'));
    expect(after).toHaveLength(2);
  });

  it('matches responses to commands by id, and fails pending ones when Pi is gone', async () => {
    const out: Record<string, unknown>[] = [];
    const rpc = new PiRpc((m) => out.push(m));
    const a = rpc.request({ type: 'get_state' });
    const b = rpc.request({ type: 'get_commands' });
    expect(out).toEqual([
      { id: 'hr-1', type: 'get_state' },
      { id: 'hr-2', type: 'get_commands' },
    ]);
    expect(rpc.handle({ type: 'response', id: 'hr-2', command: 'get_commands', success: true, data: { commands: [] } })).toBe(true);
    expect(rpc.handle({ type: 'response', command: 'parse', success: false, error: 'bad json' })).toBe(true);
    expect(rpc.handle({ type: 'agent_settled' })).toBe(false);
    expect(await b).toMatchObject({ success: true });
    rpc.send({ type: 'abort' });
    expect(out.at(-1)).toEqual({ type: 'abort' });
    rpc.close(new Error('gone'));
    await expect(a).rejects.toThrow('gone');
    await expect(rpc.request({ type: 'get_state' })).rejects.toThrow('gone');
    rpc.send({ type: 'abort' });
    expect(out).toHaveLength(3);
  });
});

// --- The gate ------------------------------------------------------------------------------------

describe('Pi: the gate', () => {
  const ui = (placeholder: unknown, extra: Record<string, unknown> = {}) => ({ type: 'extension_ui_request', id: 'u1', method: 'input', title: PI_GATE_TITLE, placeholder: typeof placeholder === 'string' ? placeholder : JSON.stringify(placeholder), ...extra });

  it('reads its requests, and nothing else', () => {
    expect(piGateRequest(ui({ toolCallId: 't1', toolName: 'bash', input: { command: 'ls' }, parentToolCallId: 'p' }))).toEqual({ toolCallId: 't1', toolName: 'bash', input: { command: 'ls' }, parentToolCallId: 'p' });
    expect(piGateRequest(ui({ toolName: 'read', input: 'x' }))).toEqual({ toolName: 'read', input: {} });
    expect(piGateRequest(ui('not json'))).toBeNull();
    expect(piGateRequest(ui({ input: {} }))).toBeNull();
    expect(piGateRequest(ui({}, { title: 'other' }))).toBeUndefined();
    expect(piGateRequest({ type: 'extension_ui_request', method: 'notify' })).toBeUndefined();
    expect(piGateRequest({ type: 'tool_execution_start' })).toBeUndefined();
  });

  it('describes each of Pi\'s tools for the decision, naming the exact call', () => {
    expect(piCallInfo({ toolName: 'read', input: { path: 'a.txt' } })).toEqual({ kind: 'read', title: 'Read a.txt', tool: 'read', path: 'a.txt' });
    expect(piCallInfo({ toolName: 'grep', input: { pattern: 'x', path: 'src' } })).toMatchObject({ kind: 'search', title: 'Grep x · src' });
    expect(piCallInfo({ toolName: 'ls', input: {} })).toMatchObject({ kind: 'search', title: 'List' });
    expect(piCallInfo({ toolName: 'find', input: { pattern: '*.ts' } })).toMatchObject({ kind: 'search', title: 'Find *.ts' });
    expect(piCallInfo({ toolName: 'bash', input: { command: 'git push' } })).toMatchObject({ kind: 'execute', title: 'Bash git push', command: 'git push' });
    expect(piCallInfo({ toolName: 'bash', input: {} })).toMatchObject({ kind: 'execute', title: 'Bash', command: '' });
    expect(piCallInfo({ toolName: 'edit', input: { path: 'a.txt' } })).toMatchObject({ kind: 'edit', path: 'a.txt', title: 'Edit a.txt' });
    expect(piCallInfo({ toolName: 'write', input: { path: 'b.txt' } })).toMatchObject({ kind: 'edit', title: 'Write b.txt' });
    expect(piCallInfo({ toolName: 'mcp__docs__fetch', input: { url: 'https://x.example' } })).toEqual({
      kind: 'other',
      title: 'mcp__docs__fetch https://x.example',
      tool: 'mcp__docs__fetch',
      url: 'https://x.example',
    });
    expect(piCallDetail({ toolName: 'mcp__shout__shout', input: { text: 'hi' } })).toBe('{"text":"hi"}');
    expect(piCallDetail({ toolName: 'mcp__x__y', input: {} })).toBeUndefined();
    const long = `/very/long/${'folder/'.repeat(40)}file.txt`;
    expect(piCallDetail({ toolName: 'mcp__fs__read', input: { path: long } })).toBe(long); // whole, for the card
  });

  it('shows an MCP tool\'s input on its approval card, and the read-only boundary', () => {
    const req = { toolName: 'mcp__shmcp__sh', input: { command: 'rm -rf build' } };
    expect(piApprovalRequest(req, piCallInfo(req), 'read-only')).toEqual({ kind: 'other', tool: 'mcp__shmcp__sh', detail: 'rm -rf build', reason: 'mcp__shmcp__sh', readOnlySandbox: true });
    expect(piApprovalRequest(req, piCallInfo(req), 'edit')).toEqual({ kind: 'other', tool: 'mcp__shmcp__sh', detail: 'rm -rf build', reason: 'mcp__shmcp__sh' });
    const bare = { toolName: 'mcp__x__ping', input: {} };
    expect(piApprovalRequest(bare, piCallInfo(bare), 'edit')).toEqual({ kind: 'other', tool: 'mcp__x__ping', reason: 'mcp__x__ping' });
    const push = { toolName: 'bash', input: { command: 'git push origin main' } };
    expect(piApprovalRequest(push, piCallInfo(push), 'edit')).toEqual({ kind: 'command', detail: 'git push origin main', reason: 'Bash' });
  });

  it('decides as the permission says, then asks the user', async () => {
    const decide = (permission: Permission, toolName: string, input: Record<string, any>, answer?: ApprovalAnswer | Error) => {
      const asked: ApprovalRequest[] = [];
      const requestApproval =
        answer === undefined
          ? undefined
          : async (req: ApprovalRequest) => {
              asked.push(req);
              if (answer instanceof Error) throw answer;
              return answer;
            };
      return en(async () => ({ decision: await piDecide({ permission, ...(requestApproval ? { requestApproval } : {}) }, { toolName, input }), asked }));
    };
    expect((await decide('full', 'bash', { command: 'rm -rf x' })).decision).toEqual({ allow: true });
    expect((await decide('read-only', 'read', { path: 'a' })).decision).toEqual({ allow: true });
    expect((await decide('read-only', 'grep', { pattern: 'a' })).decision).toEqual({ allow: true });
    expect((await decide('edit', 'bash', { command: 'npm test' })).decision).toEqual({ allow: true });
    expect((await decide('edit', 'mcp__x__y', {})).decision).toEqual({ allow: true });
    // Read-only: a command is refused when the conversation refuses on its own…
    const refused = await decide('read-only', 'bash', { command: 'ls' });
    expect(refused.decision).toMatchObject({ allow: false, reason: expect.stringMatching(/read-only/), label: expect.stringMatching(/read-only/) });
    // …else asked about, with the sandbox's boundary on the card.
    const asked = await decide('read-only', 'edit', { path: 'a.txt' }, { allow: true });
    expect(asked.decision).toEqual({ allow: true });
    expect(asked.asked).toEqual([{ kind: 'edit', detail: 'a.txt', reason: 'Edit', readOnlySandbox: true }]);
    // The refusal names the exact call: in a batch, the model must know which one was not run.
    const publish = await decide('edit', 'bash', { command: 'npm publish --dry-run' }, { allow: false });
    expect(publish.decision).toMatchObject({ allow: false, reason: expect.stringContaining('the user declined "Bash npm publish --dry-run"') });
    const mcp = await decide('read-only', 'mcp__shout__shout', { text: 'hi' }, { allow: false, note: 'Not now.' });
    // Read-only stays a boundary for its server too.
    expect(mcp.asked).toEqual([{ kind: 'other', tool: 'mcp__shout__shout', detail: '{"text":"hi"}', reason: 'mcp__shout__shout', readOnlySandbox: true }]);
    expect(mcp.decision).toMatchObject({ allow: false, reason: expect.stringContaining('Their message: Not now.'), label: 'The user declined this action. Not now.' });
    // Edit: pushing and publishing ask.
    const push = await decide('edit', 'bash', { command: 'git push origin main' }, { allow: false });
    expect(push.asked).toEqual([{ kind: 'command', detail: 'git push origin main', reason: 'Bash' }]);
    expect(push.decision).toMatchObject({ allow: false });
    // An approval that fails refuses the call.
    expect((await decide('edit', 'bash', { command: 'npm publish' }, new Error('x'))).decision).toMatchObject({ allow: false });
  });

  it('answers the gate as it reads its answers', () => {
    expect(piGateAnswer({ allow: true })).toEqual({ allow: true });
    expect(piGateAnswer({ allow: false, reason: 'No.', label: 'x' })).toEqual({ allow: false, reason: 'No.' });
  });

  it('knows the gate loaded from its own file only', () => {
    const cmd = (path: string, name = PI_GATE_COMMAND, source = 'extension') => ({ commands: [{ name, source, sourceInfo: { path } }] });
    expect(piGateLoaded(cmd(PI_GATE_PATH))).toBe(true);
    expect(piGateLoaded(cmd('/elsewhere/piGate.js'))).toBe(false);
    expect(piGateLoaded(cmd(PI_GATE_PATH, 'other'))).toBe(false);
    expect(piGateLoaded(cmd(PI_GATE_PATH, PI_GATE_COMMAND, 'prompt'))).toBe(false);
    expect(piGateLoaded({})).toBe(false);
  });
});

// --- Events from the recorded runs ---------------------------------------------------------------------

/** Replays a fixture's records through the event handler. */
function replay(name: string, refused: Record<string, string> = {}) {
  const events: AgentEvent[] = [];
  const h = createPiEventHandler((e) => events.push(e));
  for (const [id, label] of Object.entries(refused)) h.refused(id, label);
  for (const m of piRecords(name)) {
    if (m.type === 'agent_settled') break;
    h.handle(m);
  }
  h.finish();
  return { events, h };
}
const kinds = (events: AgentEvent[]) => events.map((e) => e.type);
const joined = (events: AgentEvent[], type: 'text' | 'thinking') => events.flatMap((e) => (e.type === type ? [e.text] : [])).join('');

describe('Pi: events from recorded runs', () => {
  it('a text turn: thinking, then the reply; usage summed', () => {
    const { events, h } = replay('text-only');
    expect(joined(events, 'text')).toBe('hello from pi');
    expect(joined(events, 'thinking')).toMatch(/^Reply with exactly: hello from pi/);
    expect(kinds(events).at(-1)).toBe('text_end');
    expect(h.last).toMatchObject({ stopReason: 'stop' });
    expect(h.usage).toMatchObject({ input: 1628, output: 89, messages: 1 });
    expect(piRunUsage(h.usage, { kind: 'endpoint' })).toEqual({ inputTokens: 1628, outputTokens: 89 });
  });

  it('read, edit (its diff), write and bash rows', () => {
    const read = replay('read-tool').events.filter((e) => e.type.startsWith('tool_'));
    expect(read).toEqual([
      { type: 'tool_start', id: 'chatcmpl-tool-b1fb53c43c4e60aa', name: 'Read', detail: '…/home/user/project/notes.txt'.slice(1) },
      { type: 'tool_end', id: 'chatcmpl-tool-b1fb53c43c4e60aa', ok: true, output: 'hello from notes\nline two' },
    ]);
    const edit = replay('edit-tool').events.filter((e) => e.type === 'tool_end');
    expect(edit.at(-1)).toMatchObject({ ok: true, output: ' 1 hello from notes\n-2 line two\n+2 line 2' });
    expect(replay('write-tool').events.find((e) => e.type === 'tool_start')).toMatchObject({ name: 'Write', detail: '/home/user/project/hello.txt' });
    const bash = replay('bash-tool').events.filter((e) => e.type.startsWith('tool_'));
    expect(bash[0]).toMatchObject({ name: 'Bash', detail: 'echo out-line && echo err-line 1>&2 && ls' });
    expect(bash[1]).toMatchObject({ ok: true, output: expect.stringContaining('out-line\nerr-line') });
    const failed = replay('bash-failure').events.find((e) => e.type === 'tool_end');
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining('Command exited with code 1') });
  });

  it('read-only tools, a missing fd, and their details', () => {
    const tools = replay('readonly-tools').events.filter((e) => e.type === 'tool_start');
    expect(tools.map((e) => e.type === 'tool_start' && e.name)).toEqual(['List', 'Grep', 'Find', 'Find', 'Find', 'Read']);
    expect(tools[1]).toMatchObject({ detail: 'hello · /home/user/project' });
    expect(replay('readonly-tools').events.find((e) => e.type === 'tool_end' && !e.ok)).toMatchObject({ error: 'fd is not available and could not be downloaded' });
    expect(piToolDetail('find', { pattern: '*.txt' })).toBe('*.txt');
    expect(piToolDetail('mcp__shout__shout', { text: 'hi' })).toBe('{"text":"hi"}');
    expect(piToolDetail('mcp__x__y', {})).toBeUndefined();
    expect(piToolName('mcp__shout__shout')).toBe('mcp__shout__shout');
  });

  it('a refused call shows Harness Relay\'s label, not the reason the model got', () => {
    const { events } = replay('approval-rejected', { 'chatcmpl-tool-94319e574bcd7259': 'Declined: just say BANANA' });
    expect(events.find((e) => e.type === 'tool_end')).toEqual({ type: 'tool_end', id: 'chatcmpl-tool-94319e574bcd7259', ok: false, error: 'Declined: just say BANANA' });
    expect(joined(events, 'text')).toBe('BANANA');
    expect(replay('anthropic-approval-rejected').events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false, error: expect.stringContaining('BANANA') });
  });

  it('an MCP tool', () => {
    const { events } = replay('mcp-stdio');
    expect(events.filter((e) => e.type.startsWith('tool_'))).toEqual([
      { type: 'tool_start', id: 'toolu_01NMi58dQJfQA9LNNWhwXPwB', name: 'mcp__shout__shout', detail: '{"text":"hello mcp"}' },
      { type: 'tool_end', id: 'toolu_01NMi58dQJfQA9LNNWhwXPwB', ok: true, output: 'HELLO MCP!' },
    ]);
  });

  it('each backend: text, bash and thinking, with usage and cost', () => {
    for (const p of ['anthropic', 'openai', 'xai']) {
      expect(joined(replay(`${p}-text-only`).events, 'text')).toMatch(/hello from pi/);
      const bash = replay(`${p}-bash-tool`).events;
      expect(bash.find((e) => e.type === 'tool_start')).toMatchObject({ name: 'Bash' });
      const thinking = replay(`${p}-thinking-high`);
      expect(joined(thinking.events, 'text')).toMatch(/391/);
      expect(thinking.h.usage.cost).toBeGreaterThan(0);
      expect(piRunUsage(thinking.h.usage, { kind: 'anthropic' }).costUsd).toBeGreaterThan(0);
    }
    expect(joined(replay('anthropic-thinking-high').events, 'thinking')).not.toBe('');
    expect(joined(replay('openai-thinking-high').events, 'thinking')).toBe(''); // OpenAI sends no summary
    expect(replay('anthropic-read-tool').events.find((e) => e.type === 'tool_start')).toMatchObject({ name: 'Read', detail: 'notes.txt' });
    expect(replay('anthropic-edit-tool').events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: true, output: expect.stringContaining('+2 line 2') });
  });

  it('a stopped run leaves its rows not finished', () => {
    const events: AgentEvent[] = [];
    const h = createPiEventHandler((e) => events.push(e));
    h.handle({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'sleep 9' } });
    h.handle({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} }); // once
    h.handle({ type: 'tool_execution_end', toolCallId: 'nope' });
    h.handle({ type: 'tool_execution_start', toolCallId: '' });
    h.refused('t2', 'Refused');
    h.handle({ type: 'tool_execution_start', toolCallId: 't2', toolName: 'read', args: {} });
    h.handle({ type: 'tool_execution_end', toolCallId: 'x' });
    h.closeOpen(false);
    expect(events).toEqual([
      { type: 'tool_start', id: 't1', name: 'Bash', detail: 'sleep 9' },
      { type: 'tool_start', id: 't2', name: 'Read' },
      { type: 'tool_end', id: 't1', ok: false, error: expect.any(String) },
      { type: 'tool_end', id: 't2', ok: false, error: 'Refused' },
    ]);
    const done: AgentEvent[] = [];
    const g = createPiEventHandler((e) => done.push(e));
    g.handle({ type: 'tool_execution_start', toolCallId: 't3', toolName: 'ls' });
    g.handle({ type: 'tool_execution_end', toolCallId: 't3', isError: true, result: {} });
    g.handle({ type: 'tool_execution_start', toolCallId: 't4', toolName: 'ls' });
    g.closeOpen(true);
    expect(done.slice(1)).toEqual([
      { type: 'tool_end', id: 't3', ok: false, error: expect.any(String) },
      { type: 'tool_start', id: 't4', name: 'List' },
      { type: 'tool_end', id: 't4', ok: true },
    ]);
    expect(piRunUsage(g.usage, { kind: 'openai' })).toEqual({});
  });

  it('turns provider errors into what the user can act on', () => {
    const errorOf = (name: string) => piRecords(name).filter((m) => m.type === 'message_end' && m.message.role === 'assistant').at(-1)!.message.errorMessage as string;
    expect(errorOf('bad-key')).toBe('401 "Unauthorized"');
    for (const name of ['bad-key', 'anthropic-bad-key', 'openai-bad-key', 'xai-bad-key']) expect(piErrorKind(errorOf(name))).toBe('key');
    expect(piErrorKind(errorOf('bad-model-flag'))).toBe('model');
    expect(piErrorKind(errorOf('sandbox-localhost-endpoint-blocked'))).toBe('connection');
    expect(piErrorKind('500 internal')).toBe('other');
    // Through the relay sandbox, an endpoint that is down is the proxy's answer, never a key's 403.
    const proxied = 'Connection error.: Proxy response (502) !== 200 when HTTP Tunneling (UND_ERR_ABORTED)';
    expect(piErrorKind(proxied)).toBe('connection');
    expect(piErrorKind('Proxy response (403) !== 200 when HTTP Tunneling')).toBe('connection');
    expect(piConnectionDetail(proxied)).toBe('HTTP 502');
    expect(piConnectionDetail('UND_ERR_ABORTED')).toBe('no connection');
    expect(piConnectionDetail('ECONNREFUSED')).toBe('ECONNREFUSED');
    return en(async () => {
      expect(piErrorText(errorOf('xai-bad-key'), backendRunOf('xai/grok-4.3'))).toMatch(/^xAI rejected the API key \(xai API error \(400\).*Settings → Model backends/);
      expect(piErrorText(errorOf('bad-model-flag'), backendRunOf('homelab/no-such-model'))).toMatch(/^Homelab has no model "no-such-model"/);
      expect(piErrorText(errorOf('sandbox-localhost-endpoint-blocked'), backendRunOf('local/qwen2.5-coder:7b'))).toMatch(/^Could not reach the endpoint "Local" \(http:\/\/127\.0\.0\.1:11434\/v1\): Connection error/);
      expect(piErrorText('ECONNREFUSED', backendRunOf('openai/gpt-5.4-nano'))).toBe('Could not reach OpenAI: ECONNREFUSED');
      expect(piErrorText(proxied, backendRunOf('homelab/muse-glimmer-30b-nvfp4'))).toBe(
        'Could not reach the endpoint "Homelab" (http://vllm.example:8000/v1): HTTP 502. Check that the server is running and the address is right.',
      );
      expect(piErrorText(proxied, backendRunOf('xai/grok-4.3'))).toBe('Could not reach xAI: HTTP 502');
      expect(piErrorText(undefined, backendRunOf('openai/gpt-5.4-nano'))).toBe('The model reported an error: unknown error');
    });
  });
});

// --- Prompt, catalog and what it loads by itself ---------------------------------------------------------

// Its stand-in CLI is a script, and Windows starts only real programs (`.exe`): tried on macOS and Linux.
describe('Pi: prompt, catalog and native', () => {
  it('sends the prompt, a leading slash defused, with the images that fit', () => {
    const png = join(root, 'tiny.png');
    writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    expect(piPrompt({ prompt: '/harness-relay-gate now' })).toEqual({ type: 'prompt', message: 'Message: /harness-relay-gate now' });
    expect(piPrompt({ prompt: 'look', images: [{ path: png, mimeType: 'image/png' }, { path: join(root, 'gone.png'), mimeType: 'image/png' }] })).toEqual({
      type: 'prompt',
      message: 'look',
      images: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
    });
  });

  it('reads the model catalog: OpenAI, Anthropic and xAI, with each model\'s levels', () => {
    const data = piRecords('available-models').find((m) => m.command === 'get_available_models')!.data.models;
    const c = piCatalog(data);
    expect(c.efforts).toEqual(PI_LEVELS);
    expect(c.models.some((m) => m.id.startsWith('homelab/'))).toBe(false);
    expect(c.models.find((m) => m.id === 'openai/gpt-5.4-mini')).toEqual({ id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini', efforts: ['off', 'low', 'medium', 'high', 'xhigh'] });
    expect(c.models.find((m) => m.id === 'anthropic/claude-haiku-5-5')?.efforts).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(c.models.find((m) => m.id === 'xai/grok-4.3')).toBeTruthy();
    expect(c.models.find((m) => m.id === 'openai/gpt-4o')?.efforts).toEqual(['off']);
    expect(piModelLevels({ reasoning: true })).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(piCatalog(undefined)).toEqual({ models: [], efforts: PI_LEVELS });
    expect(piCatalog([null, { id: 1 }, { id: 'x', provider: 'groq' }]).models).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('asks Pi for its catalog offline, in a folder of its own', async () => {
    const r = run({ FAKE_PI_MODELS: fixture('available-models') });
    const env = { ...r.o.env, ...piHomeLayout(join(r.dir, 'home')).env };
    const c = await piModels(bin, env);
    expect(c.models.length).toBeGreaterThan(50);
    const s = start(r);
    expect(s.argv).toEqual(expect.arrayContaining(['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-context-files', '--no-mcp', '--offline']));
    expect(s.env.PI_CODING_AGENT_DIR).toMatch(/catalog-[0-9a-f]+$/);
    expect(s.env.OPENAI_API_KEY).toBe('harness-relay-catalog');
    expect(existsSync(s.env.PI_CODING_AGENT_DIR)).toBe(false); // removed
    expect(await piAgent.models!(bin, { ...env, FAKE_PI_MODELS_FAIL: 'no catalog' })).toMatchObject({ models: [], error: 'no catalog' });
    expect(await piModels(bin, { ...env, FAKE_PI_EXIT: '2', FAKE_PI_STDERR: 'cannot start' })).toMatchObject({ models: [], error: expect.stringContaining('cannot start') });
    const ids = await realAsk.call(piKnownModels, bin, env);
    expect(ids?.has('openai/gpt-5.4-nano')).toBe(true);
    expect(await realAsk.call(piKnownModels, bin, { ...env, FAKE_PI_MODELS_FAIL: 'x' })).toBeUndefined();
  });

  it('lists the instruction files it loads, up from the folder', async () => {
    const top = join(root, 'ctx');
    const proj = join(top, 'a', 'b');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(top, 'CLAUDE.md'), 'x');
    writeFileSync(join(top, 'a', 'AGENTS.md'), 'x');
    writeFileSync(join(top, 'a', 'CLAUDE.md'), 'x'); // AGENTS.md comes first in the same folder
    writeFileSync(join(proj, 'AGENTS.override.md'), 'x');
    const agentDir = join(root, 'ctx-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENTS.md'), 'x');
    const files = piContextFiles(proj, agentDir).map((f) => f.path).filter((p) => p.startsWith(root));
    expect(files).toEqual([join(agentDir, 'AGENTS.md'), join(top, 'CLAUDE.md'), join(top, 'a', 'AGENTS.md'), join(proj, 'AGENTS.override.md')]);
    const native = await piAgent.native!(bin, {}, proj);
    expect(native).toMatchObject({ provider: 'pi', cwd: proj, skills: [], mcpServers: [], memoryFromFiles: true, problems: [] });
    expect(native.memory.filter((f) => f.path.startsWith(root)).map((f) => f.kind)).toEqual(['instructions', 'instructions', 'instructions']);
    expect((await piNative(bin, {}, proj)).memory).toEqual(native.memory);
    expect(NATIVE_OFF_SUPPORT.pi).toEqual(['instructions']);
  });
});

// --- Whole turns against the fake Pi ------------------------------------------------------------------------

// Its stand-in CLI is a script, and Windows starts only real programs (`.exe`): tried on macOS and Linux.
describe('Pi: turns', () => {
  it.skipIf(process.platform === 'win32')('a text turn: the session, the reply, usage; LF-only framing across chunks', async () => {
    const r = run({ FAKE_PI_CHUNKED: '1', FAKE_PI_NOISE: '1' });
    const result = await piTurn(r.o, deps());
    expect(result).toEqual({ sessionId: 'fake-session-1', inputTokens: 3, outputTokens: 1 });
    expect(r.events).toEqual([
      { type: 'session', sessionId: 'fake-session-1' },
      { type: 'text', text: 'hi   there ü' },
      { type: 'text_end' },
    ]);
    const s = start(r);
    expect(s.env).toMatchObject({ PI_OFFLINE: '1', JITI_FS_CACHE: 'false', NODE_DISABLE_COMPILE_CACHE: '1', PI_PACKAGE_DIR: '' });
    expect(s.env.PI_CODING_AGENT_DIR).toMatch(/pi-agent$/);
    expect(Object.keys(s.files).sort()).toEqual(expect.arrayContaining(['auth.json', 'models.json', 'settings.json', 'mcp.json', 'harness-relay-briefing.md']));
    // Full access: no gate, no check for it, no thinking level touched; stdin closed at the end.
    expect(s.argv).not.toContain('-e');
    expect(r.log().map((m) => m.type ?? (m.stdinClosed ? 'closed' : 'start'))).toEqual(['start', 'get_state', 'prompt', 'closed']);
    expect(existsSync(s.env.PI_CODING_AGENT_DIR)).toBe(false); // the run's temp folder is gone
  });

  it.skipIf(process.platform === 'win32')('replays a recorded turn: thinking, text, usage of an endpoint (no cost)', async () => {
    const r = run({ FAKE_PI_FIXTURE: fixture('text-only') }, { model: 'homelab/muse-glimmer-30b-nvfp4' });
    const result = await piTurn(r.o, deps());
    expect(result).toEqual({ sessionId: 'fake-session-1', inputTokens: 1628, outputTokens: 89 });
    expect(joined(r.events, 'text')).toBe('hello from pi');
    expect(start(r).env[PI_ENDPOINT_KEY_VAR]).toBe('endpoint-key-0000');
    expect(start(r).files['models.json']).toContain('relay-homelab');
  });

  it.skipIf(process.platform === 'win32')('below full access: the gate loaded, the sandbox given the run\'s paths, Pi\'s config read-only', async () => {
    const specs: RelaySandboxSpec[] = [];
    const r = run({ FAKE_PI_FIXTURE: fixture('read-tool') }, { permission: 'edit', model: 'anthropic/claude-haiku-5-5' });
    await piTurn(r.o, sandboxed(specs));
    const s = start(r);
    expect(s.argv).toEqual(expect.arrayContaining(['-e', PI_GATE_PATH]));
    expect(sent(r, 'get_commands')).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.permission).toBe('edit');
    expect(spec.allowedHosts).toEqual(['api.anthropic.com']);
    expect(spec.writable).toEqual([join(r.dir, 'home', 'private', STATE_KEY, 'sessions'), expect.stringMatching(/sandbox-run-.*\/tmp$/)]);
    expect(spec.readOnly).toEqual(expect.arrayContaining([join(s.env.PI_CODING_AGENT_DIR, 'auth.json'), join(s.env.PI_CODING_AGENT_DIR, 'settings.json'), join(s.env.PI_CODING_AGENT_DIR, 'extensions')]));
    expect(s.env.PI_CODING_AGENT_DIR.startsWith(spec.writable[1]!)).toBe(true);
    expect(spec).not.toHaveProperty('localPorts');
  });

  it('does not start Pi when it is stopped while it is being got ready (the sandbox check)', async () => {
    const r = run({}, { permission: 'edit' });
    const slow = deps({ ...fakeSandbox([]), sandboxAvailable: () => new Promise((res) => setTimeout(() => res({ ok: true }), 300)) });
    setTimeout(() => r.abort.abort(), 50);
    const err = await piTurn(r.o, slow).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRunError);
    expect((err as AgentRunError).aborted).toBe(true);
    // Pi never started, so it got no prompt.
    expect(r.log().some((m) => m.type === 'prompt')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('fails closed when the gate did not load', async () => {
    const r = run({ FAKE_PI_NO_GATE: '1' }, { permission: 'read-only' });
    await expect(en(() => piTurn(r.o, sandboxed()))).rejects.toThrow(/gate extension did not load in Pi/);
    expect(sent(r, 'prompt')).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('asks about a call through the real gate, and passes the user\'s note to the model', async () => {
    const calls = [
      { toolCallId: 't1', toolName: 'read', input: { path: 'notes.txt' } },
      { toolCallId: 't2', toolName: 'bash', input: { command: 'git push origin main' } },
      { toolCallId: 't3', toolName: 'bash', input: { command: 'npm test' } },
    ];
    const r = run({ FAKE_PI_CALLS: JSON.stringify(calls), FAKE_PI_UI_OTHER: '1' }, { permission: 'edit' }, () => ({ allow: false, note: 'Not yet.' }));
    const result = await en(() => piTurn(r.o, sandboxed()));
    expect(result).toMatchObject({ sessionId: 'fake-session-1', inputTokens: 13, outputTokens: 5, costUsd: 0.001 });
    // Only the push was asked about; the other dialog was dismissed.
    expect(r.approvals).toEqual([{ kind: 'command', detail: 'git push origin main', reason: 'Bash' }]);
    const answers = uiAnswers(r);
    expect(answers.find((a) => a.id === 'other-confirm')).toEqual({ type: 'extension_ui_response', id: 'other-confirm', cancelled: true });
    const gate = answers.filter((a) => a.id !== 'other-confirm').map((a) => JSON.parse(a.value));
    expect(gate[0]).toEqual({ allow: true });
    expect(gate[1]).toEqual({ allow: false, reason: expect.stringContaining('Their message: Not yet.') });
    expect(gate[2]).toEqual({ allow: true });
    expect(r.events.filter((e) => e.type === 'tool_end')).toEqual([
      { type: 'tool_end', id: 't1', ok: true, output: 'ran read' },
      { type: 'tool_end', id: 't2', ok: false, error: 'The user declined this action. Not yet.' },
      { type: 'tool_end', id: 't3', ok: true, output: 'ran bash' },
    ]);
  });

  it.skipIf(process.platform === 'win32')('a batch of commands: only the declined one is refused, and its refusal names it', async () => {
    const calls = ['ls', 'npm publish --dry-run', 'npm test'].map((command, i) => ({ toolCallId: `b${i}`, toolName: 'bash', input: { command } }));
    const r = run({ FAKE_PI_CALLS: JSON.stringify(calls) }, { permission: 'edit' }, () => ({ allow: false }));
    await en(() => piTurn(r.o, sandboxed()));
    expect(r.approvals.map((a) => a.detail)).toEqual(['npm publish --dry-run']);
    const answers = uiAnswers(r).map((a) => JSON.parse(a.value));
    expect(answers.map((a) => a.allow)).toEqual([true, false, true]);
    expect(answers[1].reason).toMatch(/^Not run: the user declined "Bash npm publish --dry-run"\./);
    expect(r.events.filter((e) => e.type === 'tool_end').map((e) => e.type === 'tool_end' && e.ok)).toEqual([true, false, true]);
  });

  it.skipIf(process.platform === 'win32')('read-only: reading runs without asking, and a refused call keeps Pi going', async () => {
    const calls = [
      { toolCallId: 'r1', toolName: 'read', input: { path: 'a' } },
      { toolCallId: 'r2', toolName: 'mcp__shout__shout', input: { text: 'hi' } },
    ];
    const r = run({ FAKE_PI_CALLS: JSON.stringify(calls) }, { permission: 'read-only' });
    await en(() => piTurn(r.o, sandboxed()));
    expect(uiAnswers(r).map((a) => JSON.parse(a.value).allow)).toEqual([true, false]);
    expect(r.events.find((e) => e.type === 'tool_end' && e.id === 'r2')).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
    expect(start(r).argv).toEqual(expect.arrayContaining(['--tools']));
  });

  it.skipIf(process.platform === 'win32')('the gate fails closed on an answer it cannot read', async () => {
    const r = run({ FAKE_PI_FIXTURE: fixture('approval-allowed') }, { permission: 'read-only' });
    await en(() => piTurn(r.o, sandboxed()));
    // The recorded bash call: refused in read-only (the conversation refuses on its own).
    expect(JSON.parse(uiAnswers(r)[0]!.value)).toMatchObject({ allow: false });
    const gate = (await import(PI_GATE_PATH)).default as (pi: any) => void;
    const handlers: Record<string, any> = {};
    gate({ registerCommand: () => undefined, on: (ev: string, h: any) => (handlers[ev] = h) });
    const call = { toolName: 'bash', toolCallId: 'x', input: {}, parentToolCallId: 'p' };
    const ask = (value: unknown) => handlers.tool_call(call, { hasUI: true, signal: undefined, ui: { input: async () => value } });
    expect(await ask(JSON.stringify({ allow: true }))).toBeUndefined();
    expect(await ask(undefined)).toEqual({ block: true, reason: expect.stringMatching(/stopped/) });
    expect(await ask('{"allow":"yes"}')).toEqual({ block: true, reason: 'Not run: Harness Relay refused this tool call.' });
    expect(await ask(JSON.stringify({ allow: false, reason: ' Because. ' }))).toEqual({ block: true, reason: 'Because.' });
    expect(await handlers.tool_call(call, { hasUI: false })).toMatchObject({ block: true });
    expect(await handlers.tool_call(call, { hasUI: true, ui: { input: async () => Promise.reject(new Error('io')) } })).toEqual({ block: true, reason: expect.stringContaining('io') });
    expect(await handlers.tool_call(call, { hasUI: true, ui: { input: async () => Promise.reject('plain') } })).toEqual({ block: true, reason: expect.stringContaining('plain') });
  });

  it.skipIf(process.platform === 'win32')('a gate request it cannot read is refused', async () => {
    const r = run({ FAKE_PI_FIXTURE: join(root, 'bad-gate.jsonl') }, { permission: 'edit' });
    writeFileSync(
      join(root, 'bad-gate.jsonl'),
      [
        { dir: 'client', msg: { type: 'prompt' } },
        { dir: 'pi', msg: { type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } } },
        { dir: 'pi', msg: { type: 'extension_ui_request', id: 'g1', method: 'input', title: PI_GATE_TITLE, placeholder: '{oops' } },
        { dir: 'client', msg: { type: 'extension_ui_response' } },
        { dir: 'pi', msg: { type: 'agent_settled', aborted: false } },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n'),
    );
    await en(() => piTurn(r.o, sandboxed()));
    expect(JSON.parse(uiAnswers(r)[0]!.value)).toEqual({ allow: false, reason: expect.stringMatching(/could not read/) });
  });

  it.skipIf(process.platform === 'win32')('stops a run: abort sent, rows not finished, a pending approval expired', async () => {
    const r = run({ FAKE_PI_FIXTURE: fixture('cancel') });
    r.o.onEvent = (e) => {
      r.events.push(e);
      if (e.type === 'tool_start') setTimeout(() => r.abort.abort(), 20);
    };
    await expect(en(() => piTurn(r.o, deps()))).rejects.toMatchObject({ aborted: true, message: 'Stopped' });
    expect(sent(r, 'abort')).toHaveLength(1);
    expect(r.events.filter((e) => e.type === 'tool_end')).toEqual([{ type: 'tool_end', id: 'chatcmpl-tool-87fed63223bc9b02', ok: false, error: 'Command aborted' }]);

    // Asked, and stopped before the user answered: nothing is sent to Pi afterwards.
    let release!: (a: ApprovalAnswer) => void;
    const p = run({ FAKE_PI_CALLS: JSON.stringify([{ toolCallId: 'w1', toolName: 'bash', input: { command: 'git push' } }]) }, { permission: 'edit' }, () => new Promise((res) => (release = res)));
    p.o.onEvent = (e) => {
      p.events.push(e);
      if (e.type === 'tool_start') setTimeout(() => p.abort.abort(), 50);
    };
    const stopped = en(() => piTurn(p.o, sandboxed()));
    stopped.catch(() => undefined); // awaited below
    await new Promise((res) => setTimeout(res, 300));
    release({ allow: false, note: 'too late' }); // answered after Stop: the approval had expired
    await expect(stopped).rejects.toMatchObject({ aborted: true });
    await new Promise((res) => setTimeout(res, 20));
    expect(uiAnswers(p)).toEqual([]);
    const row = p.events.find((e) => e.type === 'tool_end');
    expect(row).toMatchObject({ ok: false, error: 'Operation aborted' });
    expect(JSON.stringify(row)).not.toContain('declined');
  });

  it.skipIf(process.platform === 'win32')('a run stopped before it starts, or before its prompt', async () => {
    const r = run();
    r.abort.abort();
    await expect(piTurn(r.o, deps())).rejects.toMatchObject({ aborted: true });
    expect(r.log()).toEqual([]);
    const q = run({ FAKE_PI_HANG: '1' });
    q.o.onEvent = (e) => {
      if (e.type === 'session') q.abort.abort();
    };
    await expect(en(() => piTurn(q.o, deps()))).rejects.toMatchObject({ aborted: true });
  });

  it.skipIf(process.platform === 'win32')('a stop on the way to the prompt keeps the prompt from going out', async () => {
    for (const [slow, over] of [
      ['get_commands', { permission: 'edit' as Permission }],
      ['get_available_thinking_levels', { effort: 'high' }],
      ['set_thinking_level', { effort: 'high' }],
      ['set_model', {}],
    ] as const) {
      const r = run({ FAKE_PI_SLOW: slow, ...(slow === 'set_model' ? { FAKE_PI_STATE: JSON.stringify({ model: { provider: 'openai', id: 'gpt-5.4' } }) } : {}), ...(slow === 'set_thinking_level' ? { FAKE_PI_STATE: JSON.stringify({ thinkingLevel: 'low' }) } : {}) }, over);
      const asked = r.log;
      const p = en(() => piTurn(r.o, sandboxed()));
      p.catch(() => undefined);
      for (let i = 0; i < 100 && !asked().some((m) => m.type === slow); i++) await new Promise((res) => setTimeout(res, 20));
      r.abort.abort();
      await expect(p, slow).rejects.toMatchObject({ aborted: true });
      expect(sent(r, 'prompt'), slow).toEqual([]);
    }
  });

  it.skipIf(process.platform === 'win32')('resumes a session by its file, checking it is the one Pi opened', async () => {
    const r = run({ FAKE_PI_FIXTURE: fixture('resume-2-second-process') }, { sessionId: 'abc' });
    mkdirSync(join(r.dir, 'home', 'private', STATE_KEY, 'sessions'), { recursive: true });
    const file = join(r.dir, 'home', 'private', STATE_KEY, 'sessions', '2026-11-10T12-41-59-246Z_abc.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session', id: 'abc', cwd: r.o.cwd }) + '\n');
    const result = await piTurn(r.o, deps());
    expect(result.sessionId).toBe('abc');
    expect(start(r).argv).toEqual(expect.arrayContaining(['--session', file]));
    expect(joined(r.events, 'text')).toBe('KIWI-42');
    // Pi opened another session: the resume failed (the orchestrator then starts afresh).
    const other = run({ FAKE_PI_STATE: JSON.stringify({ sessionId: 'zzz' }) }, { sessionId: 'abc' });
    mkdirSync(join(other.dir, 'home', 'private', STATE_KEY, 'sessions'), { recursive: true });
    writeFileSync(join(other.dir, 'home', 'private', STATE_KEY, 'sessions', 'x_abc.jsonl'), JSON.stringify({ type: 'session', id: 'abc', cwd: other.o.cwd }) + '\n');
    await expect(en(() => piTurn(other.o, deps()))).rejects.toThrow(/could not resume the earlier session: Pi opened session zzz, not abc/);
    expect(other.events).toEqual([]);
    // A missing one fails before Pi starts.
    const gone = run({}, { sessionId: 'missing' });
    await expect(en(() => piTurn(gone.o, deps()))).rejects.toThrow(/The file of session missing is gone/);
    expect(gone.log()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('sets the model again when Pi picked another, and fails when it cannot', async () => {
    const r = run({ FAKE_PI_STATE: JSON.stringify({ model: { provider: 'openai', id: 'gpt-5.4' } }) });
    await piTurn(r.o, deps());
    expect(sent(r, 'set_model')[0]).toMatchObject({ provider: 'openai', modelId: 'gpt-5.4-nano' });
    const bad = run({ FAKE_PI_STATE: JSON.stringify({ model: null }), FAKE_PI_SET_MODEL_FAIL: 'Model not found: openai/gpt-5.4-nano' });
    await expect(en(() => piTurn(bad.o, deps()))).rejects.toThrow('Pi does not accept the model "openai/gpt-5.4-nano": Model not found: openai/gpt-5.4-nano');
    const quiet = run({ FAKE_PI_STATE: JSON.stringify({ model: { provider: 'openai', id: 'x' } }), FAKE_PI_SET_MODEL_FAIL: '' });
    await piTurn(quiet.o, deps());
  });

  it.skipIf(process.platform === 'win32')('checks the effort against the model\'s levels before setting it', async () => {
    const r = run({ FAKE_PI_STATE: JSON.stringify({ thinkingLevel: 'medium' }) }, { effort: 'high' });
    await piTurn(r.o, deps());
    expect(sent(r, 'set_thinking_level')).toEqual([expect.objectContaining({ level: 'high' })]);
    const same = run({}, { effort: 'low' });
    await piTurn(same.o, deps());
    expect(sent(same, 'set_thinking_level')).toEqual([]); // --thinking low already
    const bad = run({}, { effort: 'xhigh' });
    await expect(en(() => piTurn(bad.o, deps()))).rejects.toThrow('Pi does not accept the reasoning effort "xhigh": this model takes: off, minimal, low, medium, high');
    expect(sent(bad, 'prompt')).toEqual([]);
    const none = run({ FAKE_PI_LEVELS: '[]' }, { effort: 'off' });
    await expect(en(() => piTurn(none.o, deps()))).rejects.toThrow(/this model takes: —/);
  });

  it.skipIf(process.platform === 'win32')('errors: a rejected prompt, a provider error, a run Pi ended by itself, no session', async () => {
    const rejected = run({ FAKE_PI_PROMPT_FAIL: 'No API key found for openai.' });
    await expect(en(() => piTurn(rejected.o, deps()))).rejects.toThrow("Pi did not take this turn's message: No API key found for openai.");
    const badKey = run({ FAKE_PI_FIXTURE: fixture('anthropic-bad-key') }, { model: 'anthropic/claude-haiku-5-5' });
    await expect(en(() => piTurn(badKey.o, deps()))).rejects.toThrow(/^Anthropic rejected the API key \(401/);
    // Pi ended the run aborted although nobody asked: the recorded aborted message, without our abort.
    const recorded = readFileSync(fixture('cancel-streaming'), 'utf8')
      .split('\n')
      .filter((l) => l && (JSON.parse(l) as { msg?: { type?: string } }).msg?.type !== 'abort')
      .join('\n');
    writeFileSync(join(root, 'self-aborted.jsonl'), recorded);
    const aborted = run({ FAKE_PI_FIXTURE: join(root, 'self-aborted.jsonl') });
    await expect(en(() => piTurn(aborted.o, deps()))).rejects.toThrow('Pi ended the turn by itself (stopReason: cancelled) without giving a reason.');
    const noSession = run({ FAKE_PI_STATE: JSON.stringify({ sessionId: '' }) });
    await expect(en(() => piTurn(noSession.o, deps()))).rejects.toThrow('Pi returned no session id');
    const handled = run({ FAKE_PI_HANDLED: '1' });
    expect(await piTurn(handled.o, deps())).toEqual({ sessionId: 'fake-session-1' });
  });

  it.skipIf(process.platform === 'win32')('a Pi that will not start: its own words, or the sandbox\'s reason', async () => {
    const r = run({ FAKE_PI_EXIT: '1', FAKE_PI_STDERR: "No session found matching 'x'" });
    await expect(piTurn(r.o, deps())).rejects.toThrow("No session found matching 'x'");
    const s = run({ FAKE_PI_EXIT: '1' }, { permission: 'edit' });
    await expect(piTurn(s.o, sandboxed([], 'the sandbox refused to start'))).rejects.toThrow('the sandbox refused to start');
    const missing = run({}, { bin: join(root, 'no-such-pi') });
    await expect(piTurn(missing.o, deps())).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('times out a turn that never settles', async () => {
    const r = run({ FAKE_PI_HANG: '1' });
    await expect(en(() => piTurn(r.o, deps({ timeoutMs: 800, exitGraceMs: 100 })))).rejects.toThrow(/timed out|did not finish/i);
  });

  it('is the runner the registry uses', async () => {
    const r = run();
    r.abort.abort();
    await expect(piAgent.runner.run(r.o)).rejects.toMatchObject({ aborted: true });
    expect(piAgent.runner.provider).toBe('pi');
    expect(piAgent.efforts).toEqual(PI_LEVELS);
    expect(piAgent.process).toBe(piProcess);
  });
});
