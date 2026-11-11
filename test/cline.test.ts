import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalAnswer, Permission } from '../src/shared/types';
import { NATIVE_ITEM_SUPPORT, NATIVE_OFF_SUPPORT } from '../src/shared/types';
import { RpcError } from '../src/server/agents/acp';
import { ACP_REFUSAL_NOTE, acpCallInfo, acpPermissionDecision, acpTurn, defaultAcpDeps, type AcpToolCall, type AcpTurnDeps } from '../src/server/agents/acpTurn';
import {
  CLINE_BUILTIN_TOOLS,
  CLINE_EFFORTS,
  CLINE_EMPTY_ENV,
  CLINE_NO_KEY,
  CLINE_PROVIDER,
  CLINE_QUIET_HOSTS,
  clineAcp,
  clineAgent,
  clineApiKey,
  clineArgs,
  clineBriefingFile,
  clineCallInfo,
  clineError,
  clineGlobalSettings,
  clineHome,
  clineLeftOut,
  dropClineVars,
  CLINE_HOME_VARS,
  clineMcpSettings,
  clineOutput,
  clinePatchFiles,
  clineProbeEnv,
  clineProviderSettings,
  clineSandbox,
  clineSessionFile,
  clineToolOf,
  clineUpdate,
  parseClineCatalog,
  parseClineConfig,
  readClineUsage,
  usageDelta,
  wrapClineConnection,
} from '../src/server/agents/cline';
import { JsonRpcConnection } from '../src/server/agents/acp';
import { openHomeEnv, type OpenRunContext } from '../src/server/agents/open';
import { AgentRunError, type AgentEvent, type ApprovalRequest, type McpServerSpec, type RunOptions } from '../src/server/agents/types';
import { backendRun, type BackendRun } from '../src/server/backends';
import { NativeSetupService } from '../src/server/native';
import { t, withLang } from '../src/server/i18n';
import type { RelaySandboxCommand, RelaySandboxSpec } from '../src/server/relaySandbox';
import { OPEN_AGENT_HOME_ENV } from '../src/server/settings';
import { writeFakeCline } from './fake-cline';

/*
 * The Cline adapter (src/server/agents/cline.ts), offline: its config, environment and arguments for
 * each backend and permission, its hooks, and whole turns replayed from the messages the real
 * `cline --acp` (3.0.74) sent (test/fixtures/cline/, recorded with isolated homes and scrubbed).
 */


/** The state key of the runs here: their state is in `<home>/private/<key>`. */
const STATE_KEY = 'conv.c1.a1';
const FIX = fileURLToPath(new URL('./fixtures/cline/', import.meta.url));
const fixture = (name: string) => join(FIX, `${name}.jsonl`);
const rows = (name: string) =>
  readFileSync(fixture(name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
/** The `session/new` answer of a recording. */
const newSession = (name: string) => rows(name).find((r) => r.dir === 'agent->client' && r.msg?.id === 2 && r.msg.result?.models)!.msg.result;

let root: string;
let bin: string;
let n = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-cline-'));
  bin = writeFakeCline(join(root, 'fake-cline'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const BACKENDS: RunOptions['backends'] = {
  apis: { openai: 'sk-test-openai-0000', anthropic: 'sk-ant-test-0000', xai: 'xai-test-0000' },
  endpoints: [
    { id: 'homelab', name: 'Homelab', baseUrl: 'http://vllm.example:8000/v1', models: ['muse-glimmer-30b-nvfp4'], apiKey: 'endpoint-key-0000' },
    { id: 'open', name: 'Open', baseUrl: 'http://10.0.0.9:8080/v1', models: ['qwen'] },
  ],
};

interface Run {
  o: RunOptions;
  events: AgentEvent[];
  approvals: ApprovalRequest[];
  abort: AbortController;
  log: () => Record<string, any>[];
  home: string;
}

/** One turn's options against the stand-in; `env` adds FAKE_CLINE_* settings. */
function run(env: Record<string, string> = {}, over: Partial<RunOptions> = {}, answer?: (req: ApprovalRequest) => ApprovalAnswer | Promise<ApprovalAnswer>): Run {
  const dir = join(root, `run-${++n}`);
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
      FAKE_CLINE_LOG: logFile,
      FAKE_CLINE_USAGE: JSON.stringify({ inputTokens: 7505, outputTokens: 5, totalCost: 0.00565125 }),
      [OPEN_AGENT_HOME_ENV]: home,
      CLINE_HOOKS_DIR: '/somewhere/else',
      CLINE_JS_RUNTIME_PATH: '/somewhere/node',
      CLINE_PLUGIN_BOOTSTRAP_PATH: '/somewhere/bootstrap.js',
      CLINE_LANGFUSE_PUBLIC_KEY: 'lf-public',
      ...env,
    },
    prompt: 'Reply with the single word: pong',
    systemPrompt: 'You are @Cleo on a team.',
    cwd: join(dir, 'cwd'),
    stateKey: STATE_KEY,
    permission: 'full',
    model: 'openai/gpt-5.4-mini',
    signal: abort.signal,
    onEvent: (e) => events.push(e),
    backends: BACKENDS,
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
  return { o, events, approvals, abort, log, home };
}

const sent = (r: Run, method: string) => r.log().filter((m) => m.method === method);
const started = (r: Run) => r.log().find((m) => m.start)!;
const answers = (r: Run) => r.log().filter((m) => m.method === undefined && m.result?.outcome);
const texts = (r: Run) => r.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
const toolEnds = (r: Run) => r.events.filter((e) => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>[];
const toolStarts = (r: Run) => r.events.filter((e) => e.type === 'tool_start') as Extract<AgentEvent, { type: 'tool_start' }>[];

/** A relay sandbox that runs the command as it is, recording the spec it was given. */
function fakeSandbox(specs: RelaySandboxSpec[]): Pick<AcpTurnDeps, 'sandboxAvailable' | 'sandboxCommand' | 'makeRunDirs' | 'platform'> {
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
      return { bin: b, args, env, channel: () => undefined, failure: () => undefined, run: {} as RelaySandboxCommand['run'], dispose: async () => { for (const d of [s.dirs?.tmp, s.dirs?.hostTmp]) if (d) rmSync(d, { recursive: true, force: true }); } };
    },
  };
}

const deps = (specs: RelaySandboxSpec[] = []): AcpTurnDeps => ({ ...defaultAcpDeps, runTmpDir: join(root, 'run-tmp'), ...fakeSandbox(specs) });

/** One turn of the adapter against a recording. */
async function turn(name: string, over: Partial<RunOptions> = {}, answer?: Parameters<typeof run>[2], env: Record<string, string> = {}, specs: RelaySandboxSpec[] = []) {
  const r = run({ FAKE_CLINE_FIXTURE: fixture(name), ...env }, over, answer);
  const result = await acpTurn(r.o, clineAcp, deps(specs));
  return { r, result };
}

/** A path as macOS gives it either way (`/private/var/…` is `/var/…`). */
const unprivate = (p: string) => p.replace(/^\/private\//, '/');

/** A backend run for the pure helpers. */
const backend = (model: string): BackendRun => backendRun(BACKENDS, model, 'Cline');

// Its stand-in CLI is a script, and Windows starts only real programs (`.exe`): tried on macOS and Linux.
describe.skipIf(process.platform === 'win32')('its home and the config written for each run', () => {
  it('keeps its state in the home and its settings apart, read-only', () => {
    const home = clineHome('/h');
    expect(home.env).toEqual({
      CLINE_DIR: '/h/config',
      CLINE_DATA_DIR: '/h/data',
      CLINE_GLOBAL_SETTINGS_PATH: '/h/config/global-settings.json',
      CLINE_MCP_SETTINGS_PATH: '/h/config/mcp.json',
      CLINE_PROVIDER_SETTINGS_PATH: '/h/config/providers.json',
      CLINE_SESSION_BACKEND_MODE: 'local',
      CLINE_NO_AUTO_UPDATE: '1',
      E2E_TEST: 'true',
    });
    expect(home.statePaths).toEqual(['/h/data']);
    expect(home.configPaths).toEqual(['/h/config', '/h/data/cache/feature-flags.json']);
    // The status check, the catalog and the native probe start it with these too (never ~/.cline).
    expect(openHomeEnv(clineAcp, { [OPEN_AGENT_HOME_ENV]: join(root, 'h-env') }).CLINE_DIR).toBe(join(root, 'h-env', 'config'));
  });

  it('turns telemetry and updates off, and leaves out the skills tool, tools and plugins the user picked', () => {
    expect(clineGlobalSettings()).toEqual({ telemetryOptOut: true, autoUpdateEnabled: false });
    expect(clineGlobalSettings({ nativeOff: ['skills'], nativeItems: { tools: ['fetch_web_content', 'skills'], plugins: ['/p/a.js'] } })).toEqual({
      telemetryOptOut: true,
      autoUpdateEnabled: false,
      disabledTools: ['skills', 'fetch_web_content'],
      disabledPlugins: ['/p/a.js'],
    });
  });

  it('writes the tool library in its MCP settings file, stdio and HTTP', () => {
    const servers: McpServerSpec[] = [
      { name: 'echo', transport: 'stdio', command: 'node', args: ['echo.js'], url: '', env: { TOKEN: 't' }, headers: {} },
      { name: 'bare', transport: 'stdio', command: 'bare', args: [], url: '', env: {}, headers: {} },
      { name: 'web', transport: 'http', command: '', args: [], url: 'https://mcp.example/mcp', env: {}, headers: { Authorization: 'Bearer x' } },
      { name: 'open', transport: 'http', command: '', args: [], url: 'https://open.example/mcp', env: {}, headers: {} },
    ];
    expect(clineMcpSettings(servers)).toEqual({
      mcpServers: {
        echo: { command: 'node', args: ['echo.js'], env: { TOKEN: 't' } },
        bare: { command: 'bare', args: [] },
        web: { type: 'streamableHttp', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer x' } },
        open: { type: 'streamableHttp', url: 'https://open.example/mcp' },
      },
    });
    expect(clineMcpSettings()).toEqual({ mcpServers: {} });
    // Its stdio servers start in the working directory (Cline itself starts in the run's temp folder).
    expect(clineMcpSettings(servers.slice(1, 3), '/p')).toEqual({
      mcpServers: { bare: { command: 'bare', args: [], cwd: '/p' }, web: { type: 'streamableHttp', url: 'https://mcp.example/mcp', headers: { Authorization: 'Bearer x' } } },
    });
  });

  it('names the provider and model, an endpoint by its base URL, and never a key in a file', () => {
    const now = new Date('2026-11-10T00:00:00Z');
    expect(clineProviderSettings(backend('anthropic/claude-haiku-5-5'), now)).toEqual({
      version: 1,
      lastUsedProvider: 'anthropic',
      modes: {},
      providers: { anthropic: { settings: { provider: 'anthropic', model: 'claude-haiku-5-5' }, updatedAt: '2026-11-10T00:00:00.000Z', tokenSource: 'manual' } },
    });
    const endpoint = clineProviderSettings(backend('homelab/muse-glimmer-30b-nvfp4'), now);
    expect(endpoint.providers).toEqual({
      'openai-compatible': {
        settings: { provider: 'openai-compatible', model: 'muse-glimmer-30b-nvfp4', baseUrl: 'http://vllm.example:8000/v1' },
        updatedAt: '2026-11-10T00:00:00.000Z',
        tokenSource: 'manual',
      },
    });
    expect(JSON.stringify(endpoint)).not.toContain('endpoint-key-0000');
    expect(CLINE_PROVIDER).toEqual({ openai: 'openai-native', anthropic: 'anthropic', xai: 'xai', endpoint: 'openai-compatible' });
  });

  it('hands the run’s key to Cline, and a placeholder for an endpoint without one', () => {
    expect(clineApiKey(backend('openai/gpt-5.4-mini'))).toBe('sk-test-openai-0000');
    expect(clineApiKey(backend('xai/grok-4.3'))).toBe('xai-test-0000');
    expect(clineApiKey(backend('homelab/muse-glimmer-30b-nvfp4'))).toBe('endpoint-key-0000');
    expect(clineApiKey(backend('open/qwen'))).toBe(CLINE_NO_KEY);
    expect(clineApiKey({ ...backend('xai/grok-4.3'), env: {} })).toBe('');
  });

  it('asks every call below full access, always approves with full access, and passes the effort as --thinking', () => {
    expect(clineArgs({ permission: 'full', effort: 'high' })).toEqual(['--acp', '--auto-approve', 'true', '--thinking', 'high']);
    expect(clineArgs({ permission: 'edit' })).toEqual(['--acp']);
    expect(clineArgs({ permission: 'read-only', effort: 'turbo' })).toEqual(['--acp']);
    expect(clineArgs({ permission: 'read-only', effort: 'none' })).toEqual(['--acp', '--thinking', 'none']);
    expect(clineAgent.efforts).toEqual(CLINE_EFFORTS);
  });

  it('writes the briefing as a rules file, only when there is one', () => {
    expect(clineBriefingFile('  ')).toBeUndefined();
    expect(clineBriefingFile('Be @Cleo.')).toBe('# Harness Relay\n\nBe @Cleo.\n');
  });

  it('takes only the quietly refused hosts of its own services from the relay sandbox', () => {
    expect(clineSandbox()).toEqual({ quietlyDeniedHosts: CLINE_QUIET_HOSTS });
    expect(CLINE_QUIET_HOSTS).toEqual(['otel.cline.bot', 'data.cline.bot', 'api.cline.bot']);
  });

  it('can leave out its skills tool, single built-in tools and single plugins', () => {
    expect(NATIVE_OFF_SUPPORT.cline).toEqual(['skills']);
    expect(NATIVE_ITEM_SUPPORT.cline).toEqual(['tools', 'plugins']);
  });

  const cases: [string, Permission][] = [];
  for (const model of ['openai/gpt-5.4-mini', 'anthropic/claude-haiku-5-5', 'xai/grok-4.3', 'homelab/muse-glimmer-30b-nvfp4', 'open/qwen']) {
    for (const permission of ['read-only', 'edit', 'full'] as Permission[]) cases.push([model, permission]);
  }
  it.each(cases)('runs %s in %s with its own CLINE_DIR, settings and key, nothing else', async (model, permission) => {
    const specs: RelaySandboxSpec[] = [];
    const mcp: McpServerSpec[] = [{ name: 'echo', transport: 'stdio', command: 'node', args: ['echo.js'], url: '', env: {}, headers: {} }];
    const { r } = await turn('text-openai', { model, permission, mcpServers: mcp, nativeOff: ['skills'] }, () => ({ allow: true }), {}, specs);
    const { argv, env } = started(r);
    const parsed = backend(model);
    expect(argv).toEqual(permission === 'full' ? ['--acp', '--auto-approve', 'true'] : ['--acp']);
    expect(env.CLINE_PROVIDER).toBe(CLINE_PROVIDER[parsed.kind]);
    expect(env.CLINE_MODEL).toBe(parsed.model);
    expect(env.CLINE_API_KEY).toBe(clineApiKey(parsed));
    // Only CLINE_API_KEY carries a key: the backends' own variables are taken out.
    expect([env.OPENAI_API_KEY, env.ANTHROPIC_API_KEY, env.XAI_API_KEY]).toEqual([undefined, undefined, undefined]);
    expect(env.CLINE_SESSION_BACKEND_MODE).toBe('local');
    expect(env.E2E_TEST).toBe('true');
    expect(env.CLINE_NO_AUTO_UPDATE).toBe('1');
    expect(env.CLINE_DATA_DIR).toBe(join(r.home, 'private', STATE_KEY, 'data'));
    expect(env.CLINE_HOOKS_DIR).toBe(''); // the server's own does not reach it
    // Nor any other of its variables: taken out (CLINE_JS_RUNTIME_PATH, CLINE_PLUGIN_BOOTSTRAP_PATH…).
    expect([env.CLINE_JS_RUNTIME_PATH, env.CLINE_PLUGIN_BOOTSTRAP_PATH, env.CLINE_LANGFUSE_PUBLIC_KEY]).toEqual([undefined, undefined, undefined]);
    // It starts in the run's temp folder, so it reads no `.env` or `bunfig.toml` of the project; the session is the project.
    expect(unprivate(started(r).cwd)).toBe(unprivate(env.TMPDIR));
    expect(sent(r, 'session/new')[0]!.params.cwd).toBe(r.o.cwd);
    // Its CLINE_DIR and settings are the run's own, in its temp folder (gone after the run).
    expect(env.CLINE_DIR).toBe(join(env.TMPDIR, 'cline'));
    expect(env.CLINE_GLOBAL_SETTINGS_PATH).toBe(join(env.CLINE_DIR, 'global-settings.json'));
    expect(env.CLINE_MCP_SETTINGS_PATH).toBe(join(env.CLINE_DIR, 'mcp.json'));
    expect(env.CLINE_PROVIDER_SETTINGS_PATH).toBe(join(env.CLINE_DIR, 'providers.json'));
    expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(join(env.TMPDIR, 'bun-cache'));
    expect(existsSync(env.CLINE_DIR)).toBe(false);
    // The feature-flag cache is fresh and empty.
    const flags = JSON.parse(readFileSync(join(r.home, 'private', STATE_KEY, 'data', 'cache', 'feature-flags.json'), 'utf8'));
    expect(flags).toMatchObject({ version: 2, userId: null, flagsPayload: { featureFlags: {}, featureFlagPayloads: {} } });
    // ACP's mcpServers stay empty: Cline ignores them.
    expect(sent(r, 'session/new')[0]!.params.mcpServers).toEqual([]);
    if (permission === 'full') {
      expect(specs).toEqual([]);
    } else {
      expect(specs).toHaveLength(1);
      expect(specs[0]!.writable).toEqual([join(r.home, 'private', STATE_KEY, 'data'), env.TMPDIR]);
      expect(specs[0]!.readOnly).toEqual([join(r.home, 'config'), join(r.home, 'private', STATE_KEY, 'data', 'cache', 'feature-flags.json'), env.CLINE_DIR]);
      expect(specs[0]!.allowedHosts).toEqual(parsed.hosts);
      expect(specs[0]!.quietlyDeniedHosts).toEqual(CLINE_QUIET_HOSTS);
      expect(specs[0]).not.toHaveProperty('allowPty');
      expect(specs[0]).not.toHaveProperty('localPorts');
    }
  });

  it('writes the briefing, the settings and the MCP servers it reads into the run’s CLINE_DIR', async () => {
    const mcp: McpServerSpec[] = [{ name: 'echo', transport: 'stdio', command: 'node', args: ['echo.js'], url: '', env: {}, headers: {} }];
    let files: Record<string, string> = {};
    const r = run({ FAKE_CLINE_FIXTURE: fixture('text-openai') }, { permission: 'edit', mcpServers: mcp, nativeItems: { tools: ['spawn_agent'] } });
    // Read the files while the run is on: its temp folder goes with it.
    const spec = {
      ...clineAcp,
      prepare: (ctx: OpenRunContext) => {
        clineAcp.prepare!(ctx);
        const dir = String(ctx.env.CLINE_DIR);
        files = {
          rules: readFileSync(join(dir, 'rules', 'harness-relay-briefing.md'), 'utf8'),
          global: readFileSync(join(dir, 'global-settings.json'), 'utf8'),
          mcp: readFileSync(join(dir, 'mcp.json'), 'utf8'),
          providers: readFileSync(join(dir, 'providers.json'), 'utf8'),
        };
      },
    };
    await acpTurn(r.o, spec, deps());
    expect(files.rules).toBe(`# Harness Relay\n\nYou are @Cleo on a team.\n\n${ACP_REFUSAL_NOTE}\n`);
    expect(JSON.parse(files.global!)).toEqual({ telemetryOptOut: true, autoUpdateEnabled: false, disabledTools: ['spawn_agent'] });
    expect(JSON.parse(files.mcp!)).toEqual(clineMcpSettings(mcp, r.o.cwd));
    expect(JSON.parse(files.providers!).lastUsedProvider).toBe('openai-native');
    // The briefing is not put before the prompt.
    expect(sent(r, 'session/prompt')[0]!.params.prompt).toEqual([{ type: 'text', text: 'Reply with the single word: pong' }]);

    // With full access the refusal note is not needed, and an empty briefing writes no rules file.
    let rules: string[] = [];
    const quiet = run({ FAKE_CLINE_FIXTURE: fixture('text-openai') }, { systemPrompt: ' ' });
    const prepareQuiet = (ctx: OpenRunContext) => {
      clineAcp.prepare!(ctx);
      rules = existsSync(join(String(ctx.env.CLINE_DIR), 'rules', 'harness-relay-briefing.md')) ? ['written'] : [];
    };
    await acpTurn(quiet.o, { ...clineAcp, prepare: prepareQuiet }, deps());
    expect(rules).toEqual([]);
  });
});

describe('its own variables', () => {
  it('takes out every CLINE_* variable but its home’s and those set empty', () => {
    const env: NodeJS.ProcessEnv = { CLINE_DIR: '/h', CLINE_DATA_DIR: '/d', CLINE_PLUGIN_BOOTSTRAP_PATH: '/x.js', CLINE_TRACE_RECORD_CONTENT: 'true', CLINE_VCR: '', PATH: '/bin', OTHER: 'kept' };
    dropClineVars(env);
    expect(env).toEqual({ CLINE_DIR: '/h', CLINE_DATA_DIR: '/d', CLINE_VCR: '', PATH: '/bin', OTHER: 'kept' });
    expect(CLINE_HOME_VARS).toEqual(Object.keys(clineHome('/h').env));
    expect(clineAcp.processCwd!({ tmpDir: '/run/tmp' } as OpenRunContext)).toBe('/run/tmp');
  });
});

describe('its tool calls', () => {
  it('names the tool from its title, and reads the files a patch changes', () => {
    expect(clineToolOf({ title: 'run_commands: echo hi', kind: 'execute' })).toBe('run_commands');
    expect(clineToolOf({ title: 'relayecho__relay_echo: {"text":"ping"}' })).toBe('relayecho__relay_echo');
    expect(clineToolOf({ title: 'web_search: {}' })).toBe('web_search');
    expect(clineToolOf({ title: 'Something else entirely', kind: 'read' })).toBe('read');
    expect(clineToolOf({})).toBe('tool');
    expect(clinePatchFiles('*** Begin Patch\n*** Update File: /p/a.txt\n@@\n-x\n+y\n*** Add File: /p/b.txt\n+z\n*** Delete File: /p/c.txt\n*** Update File: /p/d.txt\n*** Move to: /p/e.txt\n*** Update File: /p/a.txt\n*** End Patch')).toEqual([
      '/p/a.txt',
      '/p/b.txt',
      '/p/c.txt',
      '/p/d.txt',
      '/p/e.txt',
    ]);
    expect(clinePatchFiles(undefined)).toEqual([]);
    // What a call without a title says: its kind, else nothing.
    expect(clineCallInfo({ toolCallId: 'c', kind: 'read', rawInput: { files: 'not a list' } })).toEqual({ tool: 'read', title: 'read' });
    expect(clineCallInfo({ toolCallId: 'c', title: 'search_codebase: x', kind: 'search', rawInput: { query: 'one' } })).toMatchObject({ title: 'search_codebase: one' });
  });

  it('says what each of its tools does, for the decision and the approval card', () => {
    const call = (title: string, kind: string, rawInput: Record<string, any>): AcpToolCall => ({ toolCallId: 'c', title, kind, rawInput });
    expect(clineCallInfo(call('run_commands: echo a', 'execute', { commands: ['echo a', 'git push'] }))).toEqual({
      tool: 'run_commands',
      title: 'run_commands: echo a …',
      kind: 'execute',
      command: 'echo a\ngit push',
    });
    expect(clineCallInfo(call('run_commands: ls', 'execute', { command: 'ls' }))).toMatchObject({ command: 'ls', title: 'run_commands: ls' });
    expect(clineCallInfo(call('read_files: {"files":[{"path":"/p/a', 'read', { files: [{ path: '/p/a.txt' }, '/p/b.txt'] }))).toEqual({
      tool: 'read_files',
      title: 'read_files: /p/a.txt, /p/b.txt',
      kind: 'read',
      path: '/p/a.txt',
    });
    expect(clineCallInfo(call('apply_patch: {"input":"*** Begin', 'other', { input: '*** Begin Patch\n*** Update File: /p/a.txt\n*** End Patch' }))).toEqual({
      tool: 'apply_patch',
      title: 'apply_patch: /p/a.txt',
      kind: 'edit',
      path: '/p/a.txt',
    });
    expect(clineCallInfo(call('editor: {"path":"/p/a.txt"}', 'edit', { path: '/p/a.txt', old_text: 'a', new_text: 'b' }))).toMatchObject({ kind: 'edit', path: '/p/a.txt' });
    expect(clineCallInfo(call('fetch_web_content: https://example.com/', 'fetch', { requests: [{ url: 'https://example.com/', prompt: 'title' }] }))).toMatchObject({
      kind: 'fetch',
      url: 'https://example.com/',
    });
    expect(clineCallInfo(call('fetch_web_content', 'fetch', { url: 'https://example.org/' }))).toMatchObject({ url: 'https://example.org/' });
    expect(clineCallInfo(call('search_codebase: created', 'search', { queries: ['created', 'made'] }))).toMatchObject({ kind: 'search', title: 'search_codebase: created | made' });
    expect(clineCallInfo(call('skills: relay-skill ping', 'other', { skill: 'relay-skill', args: 'ping' }))).toMatchObject({ kind: 'read', title: 'skills: relay-skill' });
    expect(clineCallInfo(call('spawn_agent: x', 'think', {}))).toEqual({ tool: 'spawn_agent', title: 'spawn_agent', kind: 'think' });
    expect(clineCallInfo(call('relayecho__relay_echo: {"text":"ping"}', 'other', { text: 'ping' }))).toEqual({ tool: 'relayecho__relay_echo', title: 'relayecho__relay_echo' });
    // A request without a title is described from what the turn saw of the call before.
    expect(clineCallInfo({ toolCallId: 'c' }, call('run_commands: npm publish', 'execute', { commands: ['npm publish'] }))).toMatchObject({ command: 'npm publish' });
  });

  it('runs reading, searching and the web in read-only and asks about the rest; in edit asks only about publishing', () => {
    const decide = (permission: Permission, title: string, kind: string, rawInput: Record<string, any>) =>
      acpPermissionDecision(permission, acpCallInfo({ toolCallId: 'c', title, kind, rawInput }, (c) => clineCallInfo(c)), 'Cline').allow;
    expect(decide('read-only', 'read_files: x', 'read', { files: [{ path: '/p/a' }] })).toBe(true);
    expect(decide('read-only', 'search_codebase: x', 'search', { queries: ['x'] })).toBe(true);
    expect(decide('read-only', 'fetch_web_content: x', 'fetch', { requests: [{ url: 'https://e.x' }] })).toBe(true);
    expect(decide('read-only', 'skills: s', 'other', { skill: 's' })).toBe(true);
    expect(decide('read-only', 'run_commands: ls', 'execute', { commands: ['ls'] })).toBe(false);
    expect(decide('read-only', 'apply_patch: x', 'other', { input: '*** Update File: /p/a' })).toBe(false);
    expect(decide('read-only', 'relayecho__relay_echo: x', 'other', { text: 'x' })).toBe(false);
    expect(decide('edit', 'apply_patch: x', 'other', { input: '*** Update File: /p/a' })).toBe(true);
    expect(decide('edit', 'run_commands: ok', 'execute', { commands: ['npm test'] })).toBe(true);
    expect(decide('edit', 'run_commands: push', 'execute', { commands: ['echo ok', 'git push origin main'] })).toBe(false);
  });

  it('reads the output and failure of each kind of result', () => {
    expect(clineOutput(undefined)).toEqual({ failed: false });
    expect(clineOutput('{"error":"User rejected the tool call"}')).toEqual({ text: 'User rejected the tool call', failed: true });
    expect(clineOutput('plain text')).toEqual({ text: 'plain text', failed: false });
    expect(clineOutput([{ query: 'pwd', result: '/p\n', success: true }])).toEqual({ text: '/p\n', failed: false });
    expect(clineOutput([{ query: 'pwd', result: '/p', success: true }, { query: 'ls', result: 'a', success: true }])).toEqual({ text: 'pwd\n/p\n\nls\na', failed: false });
    expect(clineOutput([{ query: 'x', result: '', error: 'Command exited with code 1', success: false }])).toEqual({ text: 'Command exited with code 1', failed: true });
    expect(clineOutput([{ query: 'x', result: '', success: true }])).toEqual({ failed: false });
    expect(clineOutput({ query: 'edit:/p', result: '', error: 'Editor operation failed', success: false })).toEqual({ text: 'Editor operation failed', failed: true });
    expect(clineOutput({ content: [{ type: 'text', text: 'echo: ping' }] })).toEqual({ text: 'echo: ping', failed: false });
    expect(clineOutput({ content: [{ type: 'image' }], isError: true })).toEqual({ failed: true });
    expect(clineOutput({ action: { type: 'search', query: 'q' }, sources: [{ url: 'https://a' }, {}] })).toEqual({ text: 'https://a', failed: false, detail: 'q' });
    expect(clineOutput({ action: { type: 'search' } })).toEqual({ failed: false });
    expect(clineOutput({ other: 1 })).toEqual({ text: '{"other":1}', failed: false });
    expect(clineOutput(42)).toEqual({ text: '42', failed: false });
  });

  it('turns its tool updates into what the generic turn reads', () => {
    const plain = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } };
    expect(clineUpdate(plain)).toBe(plain);
    expect(clineUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a', title: 'run_commands: ls', kind: 'execute', status: 'pending', rawInput: { commands: ['ls', 'pwd'] } }).rawInput).toEqual({
      commands: ['ls', 'pwd'],
      command: 'ls\npwd',
    });
    expect(clineUpdate({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'read_files: x', kind: 'read', rawInput: { files: [{ path: '/a' }, { path: '/b' }] } }).rawInput.path).toBe('/a, /b');
    const kept = { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'mcp__x: y', kind: 'other', rawInput: { q: 1 } };
    expect(clineUpdate(kept)).toEqual(kept);
    expect(clineUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', rawOutput: [{ query: 'ls', result: 'x', success: false, error: 'boom' }] })).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'a',
      status: 'failed',
      rawOutput: [{ query: 'ls', result: 'x', success: false, error: 'boom' }],
      content: [{ type: 'content', content: { type: 'text', text: 'x\nboom' } }],
    });
    expect(clineUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'w', status: 'completed', rawOutput: { action: { type: 'search', query: 'q' }, sources: [] } }).rawInput).toEqual({ query: 'q' });
    // An update still running keeps its output for later.
    expect(clineUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'in_progress', rawOutput: [{ result: 'x' }] })).not.toHaveProperty('content');
  });
});

describe('its errors and usage', () => {
  const run = backend('openai/gpt-5.4-mini');
  const endpoint = backend('homelab/muse-glimmer-30b-nvfp4');
  const rpc = (message: string, code = -32603) => new RpcError(code, `Internal error: ${message}`, { message });
  it('says what to do about a refused key, a missing model, an endpoint it cannot reach, or anything else', () => {
    withLang('en', () => {
      expect(clineError(rpc('Incorrect API key provided: sk-inval****0000.'), run).message).toBe(t().clineBadKey('openai', 'Incorrect API key provided: sk-inval****0000.'));
      expect(clineError(rpc('Call authenticate before starting a session', -32000), run).message).toMatch(/refused Cline's API key/);
      expect(clineError(rpc('The model `gpt-nonexistent-9` does not exist or you do not have access to it.'), run).message).toBe(
        t().clineBadModel('gpt-5.4-mini', 'openai', 'The model `gpt-nonexistent-9` does not exist or you do not have access to it.'),
      );
      expect(clineError(rpc('Cannot connect to API: Unable to connect. Is the computer able to access the url?'), endpoint).message).toBe(
        t().clineUnreachable('http://vllm.example:8000/v1', 'Cannot connect to API: Unable to connect. Is the computer able to access the url?'),
      );
      expect(clineError(rpc('Cannot connect to API: Unable to connect.'), run).message).toMatch(/cannot reach the model backend "openai"/);
      expect(clineError(new Error('Internal error: something odd'), run).message).toBe(t().clineFailed('something odd'));
      expect(clineError('plain', run).message).toBe(t().clineFailed('plain'));
      // An endpoint without a name is named by its id.
      const nameless = { ...endpoint, endpoint: { ...endpoint.endpoint!, name: '' } };
      expect(clineError(rpc('401 Unauthorized'), nameless).message).toBe(t().clineBadKey('homelab', '401 Unauthorized'));
    });
    expect(clineError(rpc('x'), run)).toBeInstanceOf(AgentRunError);
  });

  it('reads a session’s usage from its record, and the turn’s part of it', () => {
    const dir = mkdtempSync(join(root, 'usage-'));
    const file = clineSessionFile(dir, 's1');
    expect(file).toBe(join(dir, 'sessions', 's1', 's1.json'));
    expect(readClineUsage(file)).toBeUndefined();
    mkdirSync(join(dir, 'sessions', 's1'), { recursive: true });
    writeFileSync(file, JSON.stringify({ metadata: { usage: { inputTokens: 10, outputTokens: 2 }, totalCost: 0.5 } }));
    expect(readClineUsage(file)).toEqual({ inputTokens: 10, outputTokens: 2, totalCost: 0.5 });
    writeFileSync(file, JSON.stringify({ metadata: { usage: { inputTokens: 1 }, aggregateUsage: { inputTokens: 20, outputTokens: 4, totalCost: 0.75 } } }));
    expect(readClineUsage(file)).toEqual({ inputTokens: 20, outputTokens: 4, totalCost: 0.75 });
    writeFileSync(file, JSON.stringify({ metadata: { usage: { inputTokens: '10', outputTokens: Number.NaN } } }));
    expect(readClineUsage(file)).toEqual({ inputTokens: 0, outputTokens: 0, totalCost: 0 });
    writeFileSync(file, JSON.stringify({ metadata: {} }));
    expect(readClineUsage(file)).toBeUndefined();
    writeFileSync(file, 'not json');
    expect(readClineUsage(file)).toBeUndefined();

    expect(usageDelta(undefined, undefined)).toEqual({});
    expect(usageDelta({ inputTokens: 20, outputTokens: 4, totalCost: 0.75 }, undefined)).toEqual({ inputTokens: 20, outputTokens: 4, costUsd: 0.75 });
    expect(usageDelta({ inputTokens: 30, outputTokens: 6, totalCost: 1 }, { inputTokens: 20, outputTokens: 4, totalCost: 0.75 })).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.25 });
    // Counted down (another record) is not this turn's; no price (an endpoint) is no cost.
    expect(usageDelta({ inputTokens: 5, outputTokens: 1, totalCost: 0 }, { inputTokens: 20, outputTokens: 4, totalCost: 0 })).toEqual({});
  });

  it('answers a permission request cancelled at once when the run is stopped', async () => {
    const abort = new AbortController();
    const conn = new JsonRpcConnection(() => undefined);
    let release: (v: unknown) => void = () => undefined;
    conn.onRequest = (method) => (method === 'session/request_permission' ? new Promise((r) => (release = r)) : { other: true });
    const ctx = { o: { signal: abort.signal }, home: { root, state: root }, state: {}, run: backend('openai/gpt-5.4-mini') } as unknown as OpenRunContext;
    wrapClineConnection(conn, 'none', ctx, 0);
    expect(await conn.onRequest!('fs/read_text_file', {})).toEqual({ other: true });
    const pending = conn.onRequest!('session/request_permission', {});
    abort.abort();
    expect(await pending).toEqual({ outcome: { outcome: 'cancelled' } });
    release({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    // Once stopped, a new request is not even asked about.
    expect(await conn.onRequest!('session/request_permission', {})).toEqual({ outcome: { outcome: 'cancelled' } });

    // An answer that comes first is the answer; an error is passed on.
    const live = new AbortController();
    const conn2 = new JsonRpcConnection(() => undefined);
    conn2.onRequest = async (_m, p) => {
      if ((p as { fail?: boolean }).fail) throw new Error('no');
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
    };
    wrapClineConnection(conn2, 'none', { ...ctx, o: { signal: live.signal } } as unknown as OpenRunContext, 0);
    expect(await conn2.onRequest!('session/request_permission', {})).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    await expect(conn2.onRequest!('session/request_permission', { fail: true })).rejects.toThrow('no');
  });
});

describe('its other hooks', () => {
  it('stays in act mode, and reports no usage it did not read', () => {
    expect(clineAcp.mode!('read-only', [{ id: 'plan' }, { id: 'act' }])).toBe('act');
    expect(clineAcp.mode!('edit', [{ id: 'ask' }])).toBeUndefined();
    expect(clineAcp.mode!('full', undefined)).toBeUndefined();
    expect(clineAcp.usage!(undefined, undefined, { state: {} } as OpenRunContext)).toEqual({});
    expect(clineAcp.implemented).toBe(true);
    expect(clineAcp.mcpServers!([], {}, 'load')).toEqual([]);
  });
});

// Its stand-in CLI is a script, and Windows starts only real programs (`.exe`): tried on macOS and Linux.
describe.skipIf(process.platform === 'win32')('a whole turn, replayed from the real CLI', () => {
  it('replies, and reports the turn’s usage from its session record', async () => {
    const { r, result } = await turn('text-openai');
    expect(result).toEqual({ sessionId: '1794314806528_svDqU_cli', inputTokens: 7505, outputTokens: 5, costUsd: 0.00565125 });
    expect(r.events).toEqual([{ type: 'session', sessionId: '1794314806528_svDqU_cli' }, { type: 'text', text: 'pong' }, { type: 'text_end' }]);
    // The model was the session's already (CLINE_MODEL is in its catalog): nothing to set; mode act.
    expect(sent(r, 'session/set_config_option')).toEqual([]);
    expect(sent(r, 'session/set_mode')).toEqual([]);
  });

  it('sets a model its catalog does not have, rather than let it fall back to its default', async () => {
    const { r } = await turn('text-vllm', { model: 'homelab/muse-glimmer-30b-nvfp4' });
    expect(sent(r, 'session/set_config_option').map((m) => m.params)).toEqual([{ sessionId: '1794315476085_ZO3LV_cli', configId: 'model', value: 'muse-glimmer-30b-nvfp4' }]);
    expect(r.events.some((e) => e.type === 'thinking')).toBe(true);
    expect(texts(r)).toBe('pong');
  });

  it('shows a call before Cline asks about it, once, with its output; reading runs in read-only', async () => {
    const { r } = await turn('read-openai', { permission: 'read-only', prompt: 'Read notes.txt' }, () => ({ allow: false }));
    expect(r.approvals).toEqual([]);
    expect(answers(r).map((a) => a.result.outcome)).toEqual([{ outcome: 'selected', optionId: 'allow_once' }]);
    expect(toolStarts(r)).toEqual([{ type: 'tool_start', id: 'call_mTsWjBHgDkgTkvspHP6sMdJM', name: 'read_files', detail: '/home/user/project/notes.txt' }]);
    expect(toolEnds(r)).toEqual([{ type: 'tool_end', id: 'call_mTsWjBHgDkgTkvspHP6sMdJM', ok: true, output: '1 | hello from cline test' }]);
  });

  it('lets apply_patch and the editor run in edit, and shows the files they change', async () => {
    const patch = await turn('edit-apply-patch-openai', { permission: 'edit' }, () => ({ allow: false }));
    expect(patch.r.approvals).toEqual([]);
    expect(toolStarts(patch.r).map((s) => [s.name, s.detail])).toEqual([
      ['read_files', '/home/user/project/notes.txt'],
      ['apply_patch', '/home/user/project/notes.txt'],
      ['read_files', '/home/user/project/notes.txt'],
    ]);
    expect(toolEnds(patch.r)[1]).toMatchObject({ ok: true, output: expect.stringContaining('Successfully applied patch') });

    // Anthropic's editor, with calls asked about together.
    const editor = await turn('edit-editor-anthropic', { permission: 'edit', model: 'anthropic/claude-haiku-5-5' }, () => ({ allow: false }));
    expect(editor.r.approvals).toEqual([]);
    expect(answers(editor.r)).toHaveLength(4);
    expect(toolEnds(editor.r).map((e) => e.ok)).toEqual([true, true, true, true]);
    expect(toolEnds(editor.r)[1]!.output).toContain('```diff\n-1: hello from cline test\n+1: hello from cline edit\n```');
  });

  it('asks the user about a command in read-only, and runs it when allowed', async () => {
    const { r } = await turn('bash-permission-allowed-openai', { permission: 'read-only' }, () => ({ allow: true }));
    expect(r.approvals).toEqual([{ kind: 'command', detail: 'echo relay-$((6*7)) && ls', reason: 'run_commands: echo relay-$((6*7)) && ls', readOnlySandbox: true }]);
    expect(toolEnds(r)).toEqual([{ type: 'tool_end', id: 'call_Vv2WnnUQWQH71EuwdyX2wlQz', ok: true, output: 'relay-42\nnotes.txt' }]);
  });

  it('rejects a declined call, shows the note, and lets the turn go on', async () => {
    const { r } = await withLang('en', () => turn('permission-rejected-openai', { permission: 'read-only' }, () => ({ allow: false, note: 'Not now.' })));
    expect(r.approvals).toHaveLength(1);
    expect(answers(r)[0]!.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
    expect(toolEnds(r)).toEqual([{ type: 'tool_end', id: 'call_EtWK1yLYipMvo7nuQL4sYspY', ok: false, error: 'The user declined this action. Not now.' }]);
    expect(texts(r)).toContain('User rejected the tool call');
  });

  it('refuses a call by itself when the conversation refuses approvals', async () => {
    const { r } = await withLang('en', () => turn('permission-rejected-openai', { permission: 'read-only' }));
    expect(answers(r)[0]!.result.outcome.optionId).toBe('reject_once');
    expect(toolEnds(r)[0]).toMatchObject({ ok: false, error: withLang('en', () => t().openRefusedReadOnly('Cline')) });
  });

  it('marks a command or an edit that failed as failed, with its reason', async () => {
    const confined = await turn('srt-bash-confined-openai');
    expect(toolEnds(confined.r).map((e) => e.ok)).toEqual([true, false, true]);
    expect(toolEnds(confined.r)[1]!.error).toContain('Operation not permitted');
    const xai = await turn('tools-and-tool-failure-xai', { model: 'xai/grok-4.3' });
    const editorFailure = toolEnds(xai.r).find((e) => !e.ok)!;
    expect(editorFailure.error).toMatch(/Editor operation failed: .*already exists, but `old_text` was omitted/);
    expect(toolEnds(xai.r).filter((e) => e.ok)).toHaveLength(5);
  });

  it('shows a provider’s own web search, a fetch and a search, which read-only runs', async () => {
    const web = await turn('native-web-search-openai', { permission: 'read-only' }, () => ({ allow: false }));
    expect(toolStarts(web.r)).toEqual([{ type: 'tool_start', id: expect.stringMatching(/^ws_/), name: 'web_search' }]);
    expect(toolEnds(web.r)[0]).toMatchObject({ ok: true, detail: 'https://example.com/' });
    const fetch = await turn('web-fetch-xai', { permission: 'read-only', model: 'xai/grok-4.3' }, () => ({ allow: false }));
    expect(fetch.r.approvals).toEqual([]);
    expect(toolStarts(fetch.r)[0]).toMatchObject({ name: 'fetch_web_content', detail: 'https://example.com/' });
    const search = await turn('search-anthropic', { permission: 'read-only', model: 'anthropic/claude-haiku-5-5' }, () => ({ allow: false }));
    expect(search.r.approvals).toEqual([]);
    expect(toolStarts(search.r)[0]).toMatchObject({ name: 'search_codebase', detail: 'created' });
  });

  it('streams its thinking with --thinking for the effort', async () => {
    const { r } = await turn('thinking-anthropic', { model: 'anthropic/claude-haiku-5-5', effort: 'low' });
    expect(started(r).argv).toEqual(['--acp', '--auto-approve', 'true', '--thinking', 'low']);
    expect(r.events.filter((e) => e.type === 'thinking').length).toBeGreaterThan(0);
    expect(texts(r)).toBe('$0.05');
  });

  it('uses the tool library’s MCP servers from its settings file', async () => {
    const { r } = await turn('mcp-settings-file-openai', { permission: 'edit' }, () => ({ allow: false }));
    expect(r.approvals).toEqual([]);
    expect(toolStarts(r)[0]).toMatchObject({ name: 'relayecho__relay_echo' });
    expect(toolEnds(r)[0]).toMatchObject({ ok: true, output: 'echo: ping' });
  });

  it('always approves with full access: calls come as tool_call only', async () => {
    const { r } = await turn('auto-approve-openai');
    expect(started(r).argv).toEqual(['--acp', '--auto-approve', 'true']);
    expect(toolEnds(r)).toEqual([{ type: 'tool_end', id: 'call_BPiOripieFXcrWkfheRfFk12', ok: true, output: 'auto-5' }]);
  });

  it('stops when asked, mid-reply', async () => {
    const r = run({ FAKE_CLINE_FIXTURE: fixture('cancel-openai') });
    r.o.onEvent = (e) => {
      r.events.push(e);
      if (e.type === 'text' && !r.abort.signal.aborted) r.abort.abort();
    };
    await expect(withLang('en', () => acpTurn(r.o, clineAcp, deps()))).rejects.toMatchObject({ aborted: true });
    expect(sent(r, 'session/cancel')).toHaveLength(1);
  });

  it('answers a pending permission request cancelled when stopped, so the turn ends at once', async () => {
    let asked = 0;
    const r = run({ FAKE_CLINE_FIXTURE: fixture('cancel-during-permission-openai') }, { permission: 'read-only' }, () => {
      asked++;
      setTimeout(() => r.abort.abort(), 50);
      return new Promise<ApprovalAnswer>(() => undefined); // the user never answers
    });
    const t0 = Date.now();
    await expect(acpTurn(r.o, clineAcp, deps())).rejects.toMatchObject({ aborted: true });
    expect(asked).toBe(1);
    expect(answers(r)[0]!.result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('resumes with session/load and leaves out the history it replays', async () => {
    const r = run({ FAKE_CLINE_FIXTURE: fixture('resume-load-openai') }, { sessionId: '1794315049137_s9pAA_cli', prompt: 'What did I ask?' });
    // The record has the earlier turns' usage: this turn reports its own part.
    const file = clineSessionFile(join(r.home, 'private', STATE_KEY, 'data'), '1794315049137_s9pAA_cli');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ metadata: { aggregateUsage: { inputTokens: 7000, outputTokens: 3, totalCost: 0.005 } } }));
    const result = await acpTurn(r.o, clineAcp, deps());
    expect(sent(r, 'session/load')[0]!.params).toMatchObject({ sessionId: '1794315049137_s9pAA_cli', mcpServers: [] });
    expect(r.events.filter((e) => e.type === 'tool_start')).toEqual([]);
    expect(texts(r)).toMatch(/^You asked me to run `touch rejected.txt`/);
    expect(result).toEqual({ sessionId: '1794315049137_s9pAA_cli', inputTokens: 505, outputTokens: 2, costUsd: 0.00065125 });
  });

  it('fails before saying anything when the session is gone, so a fresh one gets the history', async () => {
    const r = run({ FAKE_CLINE_FIXTURE: fixture('resume-unknown-id-openai') }, { sessionId: '1794315049137_nopeX_cli' });
    await expect(withLang('en', () => acpTurn(r.o, clineAcp, deps()))).rejects.toThrow(/Cline could not resume the earlier session: Resource not found: 1794315049137_nopeX_cli/);
    expect(r.events.filter((e) => e.type !== 'session')).toEqual([]);
  });

  it('says what to do about a bad key, a bad model or an endpoint it cannot reach', async () => {
    const r1 = run({ FAKE_CLINE_FIXTURE: fixture('bad-key-openai') });
    await expect(withLang('en', () => acpTurn(r1.o, clineAcp, deps()))).rejects.toThrow(/^The model backend "openai" refused Cline's API key: Incorrect API key provided/);
    const r2 = run({ FAKE_CLINE_FIXTURE: fixture('bad-model-openai') }, { model: 'openai/gpt-nonexistent-9' });
    await expect(withLang('en', () => acpTurn(r2.o, clineAcp, deps()))).rejects.toThrow(/^The model backend "openai" has no model "gpt-nonexistent-9" for Cline/);
    expect(sent(r2, 'session/set_config_option').map((m) => m.params.value)).toEqual(['gpt-nonexistent-9']);
    const r3 = run({ FAKE_CLINE_FIXTURE: fixture('model-fallback-vllm') }, { model: 'homelab/muse-glimmer-30b-nvfp4' });
    // Recorded with the fallback model: the endpoint answered that it has no such model.
    await expect(withLang('en', () => acpTurn(r3.o, clineAcp, deps()))).rejects.toThrow(/^The model backend "Homelab" has no model "muse-glimmer-30b-nvfp4"/);
    const r4 = run({ FAKE_CLINE_FIXTURE: fixture('network-unreachable-openai') });
    await expect(withLang('en', () => acpTurn(r4.o, clineAcp, deps()))).rejects.toThrow(/^Cline cannot reach the model backend "openai": Cannot connect to API/);
    const r5 = run({ FAKE_CLINE_FIXTURE: fixture('no-api-key-openai') });
    await expect(withLang('en', () => acpTurn(r5.o, clineAcp, deps()))).rejects.toThrow(/Authentication required: Call authenticate before starting a session/);
  });

  it('fails with the end of what it said when it exits in the middle of the prompt', async () => {
    const r = run({ FAKE_CLINE_FIXTURE: fixture('text-openai'), FAKE_CLINE_EXIT_ON: 'session/prompt' });
    await expect(withLang('en', () => acpTurn(r.o, clineAcp, deps()))).rejects.toThrow(/crashed on session\/prompt/);
  });

  it('reports no usage when its record does not change', async () => {
    const { result } = await turn('text-xai', { model: 'xai/grok-4.20-0309-non-reasoning' }, undefined, { FAKE_CLINE_USAGE: '' });
    expect(result).toEqual({ sessionId: expect.any(String) });
  }, 10_000);
});

// Its stand-in CLI is a script, and Windows starts only real programs (`.exe`): tried on macOS and Linux.
describe.skipIf(process.platform === 'win32')('its catalog and what it loads by itself', () => {
  it('reads each provider’s models from session/new, as <backend>/<model>', () => {
    const openai = parseClineCatalog('openai', newSession('initialize-session-new-openai'));
    expect(openai.models).toContainEqual({ id: 'openai/gpt-5.4-mini', label: 'GPT-5.4 mini · gpt-5.4-mini' });
    expect(openai.defaultModel).toBe('openai/gpt-5.4');
    const xai = parseClineCatalog('xai', newSession('catalog-xai'));
    expect(xai.models.map((m) => m.id)).toContain('xai/grok-4.3');
    expect(xai.defaultModel).toBe('xai/grok-4.20-0309-non-reasoning');
    expect(parseClineCatalog('anthropic', newSession('catalog-anthropic')).defaultModel).toBe('anthropic/claude-sonnet-5');
    expect(parseClineCatalog('anthropic', {})).toEqual({ models: [] });
    expect(parseClineCatalog('xai', { models: { currentModelId: 'gone', availableModels: [{ modelId: 'same', name: 'same' }] } })).toEqual({ models: [{ id: 'xai/same' }] });
  });

  it('asks Cline for each API backend’s catalog with a placeholder key, and picks the default of a configured one', async () => {
    const home = join(root, 'catalog-home');
    const log = join(root, 'catalog.jsonl');
    const env = openHomeEnv(clineAcp, {
      PATH: process.env.PATH,
      [OPEN_AGENT_HOME_ENV]: home,
      FAKE_CLINE_LOG: log,
      XAI_API_KEY: 'xai-real',
      FAKE_CLINE_CATALOG: JSON.stringify({ 'openai-native': fixture('initialize-session-new-openai'), xai: fixture('catalog-xai') }),
    });
    const catalog = await clineAgent.models!(bin, env);
    expect(catalog.models.map((m) => m.id)).toEqual(expect.arrayContaining(['openai/gpt-5.4-mini', 'xai/grok-4.3']));
    expect(catalog.defaultModel).toBe('xai/grok-4.20-0309-non-reasoning');
    expect(catalog.error).toMatch(/^anthropic: /);
    const starts = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.start);
    expect(starts.map((s) => s.env.CLINE_API_KEY)).toEqual(['catalog', 'catalog', 'catalog']);
    expect(starts.every((s) => s.env.XAI_API_KEY === undefined && s.env.CLINE_SESSION_BACKEND_MODE === 'local')).toBe(true);
    // Its home's settings: telemetry off, no MCP servers.
    expect(JSON.parse(readFileSync(join(home, 'config', 'global-settings.json'), 'utf8'))).toEqual({ telemetryOptOut: true, autoUpdateEnabled: false });
    expect(JSON.parse(readFileSync(join(home, 'config', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: {} });
  });

  it('says why a provider’s catalog could not be read, and has no default without a key', async () => {
    const home = join(root, 'catalog-home-2');
    const env = openHomeEnv(clineAcp, {
      PATH: process.env.PATH,
      [OPEN_AGENT_HOME_ENV]: home,
      FAKE_CLINE_CATALOG: JSON.stringify({ 'openai-native': fixture('initialize-session-new-openai'), anthropic: fixture('no-api-key-openai'), xai: fixture('catalog-xai') }),
    });
    const catalog = await clineAgent.models!(bin, env);
    expect(catalog.defaultModel).toBeUndefined();
    expect(catalog.error).toBe('anthropic: Authentication required: Call authenticate before starting a session');
    const all = await clineAgent.models!(bin, { ...env, FAKE_CLINE_CATALOG: JSON.stringify({ 'openai-native': fixture('initialize-session-new-openai'), anthropic: fixture('catalog-anthropic'), xai: fixture('catalog-xai') }) });
    expect(all).not.toHaveProperty('error');
    expect(all).not.toHaveProperty('defaultModel');
    const { clineModels } = await import('../src/server/agents/cline');
    const hung = await withLang('en', () => clineModels(bin, { ...env, FAKE_CLINE_HANG: '1' }, 300));
    expect(hung.error).toBe(['openai', 'anthropic', 'xai'].map((b) => `${b}: ${withLang('en', () => t().timedOut)}`).join('; '));
  });

  it('lists the rules, skills, hooks, agents and plugins Cline reports, and its built-in tools', () => {
    const read = (kind: string) => JSON.parse(readFileSync(join(FIX, 'native', `config-${kind}.json`), 'utf8')) as unknown;
    const lists = { rules: read('rules'), skills: read('skills'), hooks: read('hooks'), agents: read('agents'), plugins: read('plugins') };
    const native = parseClineConfig(lists, '/home/user/project');
    expect(native.memory).toEqual([
      { path: '/home/user/project/.clinerules/kiwi.md', kind: 'instructions' },
      { path: '/home/user/project/.cline/rules/mango.md', kind: 'instructions' },
      { path: '/home/user/project/AGENTS.md', kind: 'instructions' },
    ]);
    expect(native.skills).toEqual([
      { name: 'home-skill', description: 'A user-level test skill named home-skill that says LYCHEE.', source: 'user', path: '/home/user/.agents/skills/home-skill/SKILL.md' },
      { name: 'relay-skill', description: 'A test skill called relay-skill that says PAPAYA.', source: 'project', path: '/home/user/project/.agents/skills/relay-skill/SKILL.md' },
    ]);
    expect(native.hooks).toEqual([
      { event: 'PreToolUse', source: 'project', file: '/home/user/project/.cline/hooks/PreToolUse.sh' },
      { event: 'TaskStart', source: 'project', file: '/home/user/project/.clinerules/hooks/TaskStart' },
    ]);
    expect(native.plugins).toEqual([{ name: 'marker', source: 'project', id: '/home/user/project/.cline/plugins/marker.js' }]);
    expect(native.agents).toEqual([]);
    expect(native.mcpServers).toEqual([]);
    expect(native.builtinTools!.map((x) => x.id)).toEqual(CLINE_BUILTIN_TOOLS);
    // A skill or rule turned off in its frontmatter; an agent; lists that are not lists.
    const more = parseClineConfig(
      { skills: [{ name: 'off', frontmatter: { disabled: true } }, null], agents: [{ name: 'a', description: 'd', path: '/elsewhere/a.md' }], rules: 'x', plugins: [{ path: '/p.js' }] },
      '/home/user/project',
    );
    expect(more.skills).toEqual([{ name: 'off', description: '', enabled: false }]);
    expect(more.agents).toEqual([{ name: 'a', description: 'd', source: 'user' }]);
    expect(more.memory).toEqual([]);
    expect(more.plugins).toEqual([{ name: '/p.js', source: 'user', id: '/p.js' }]);
    const bare = parseClineConfig({ skills: [{ id: 'by-id' }, {}], hooks: [{ hookEventName: 'agent_start' }, {}], agents: [{ id: 'ag' }, {}], plugins: [{}] }, '/p');
    expect(bare.skills.map((x) => x.name)).toEqual(['by-id', '']);
    expect(bare.hooks).toEqual([{ event: 'agent_start' }, { event: '' }]);
    expect(bare.agents!.map((x) => x.name)).toEqual(['ag', '']);
    expect(bare.plugins).toEqual([{ name: '' }]);
  });

  it('asks `cline config <kind> --json` for each kind, in its home, and says what it could not list', async () => {
    const home = join(root, 'native-home');
    const env = openHomeEnv(clineAcp, { PATH: process.env.PATH, [OPEN_AGENT_HOME_ENV]: home, FAKE_CLINE_NATIVE_DIR: join(FIX, 'native'), FAKE_CLINE_LOG: join(root, 'native.jsonl'), OPENAI_API_KEY: 'sk-real', CLINE_HUB_PORT: '1' });
    const cwd = mkdtempSync(join(root, 'native-cwd-'));
    const probe = await clineAgent.native!(bin, env, cwd);
    expect(probe).toMatchObject({ provider: 'cline', cwd, memoryFromFiles: false, asRun: false, problems: [] });
    const starts = readFileSync(join(root, 'native.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(starts.map((x) => x.argv.join(' ')).sort()).toEqual(['agents', 'hooks', 'plugins', 'rules', 'skills'].map((k) => `--cwd ${cwd} config ${k} --json`));
    // Each started in the probe's own empty folder, not the project (no `.env` or `bunfig.toml` of it is read).
    expect(starts.every((x) => unprivate(x.cwd) !== unprivate(cwd) && unprivate(x.cwd).startsWith(unprivate(join(home, 'probe-'))))).toBe(true);
    expect(starts.every((x) => x.env.OPENAI_API_KEY === undefined && x.env.CLINE_SESSION_BACKEND_MODE === 'local' && x.env.CLINE_DIR === join(home, 'config'))).toBe(true);
    expect(probe.memory).toHaveLength(3);
    expect(probe.plugins).toHaveLength(1);
    expect(existsSync(join(home, 'config', 'global-settings.json'))).toBe(true);
    const bad = await clineAgent.native!(bin, { ...env, FAKE_CLINE_NATIVE_BAD: 'skills' }, cwd);
    expect(bad.problems).toEqual([{ kind: 'no-answer', part: 'skills' }]);
    expect(bad.skills).toEqual([]);
    const badRules = await clineAgent.native!(bin, { ...env, FAKE_CLINE_NATIVE_BAD: 'rules' }, cwd);
    expect(badRules.problems).toEqual([{ kind: 'failed', detail: 'config: cannot list rules' }]);
    const badAgents = await clineAgent.native!(bin, { ...env, FAKE_CLINE_NATIVE_BAD: 'agents' }, cwd);
    expect(badAgents.problems).toEqual([{ kind: 'no-answer', part: 'agents' }]);
    const { clineNative } = await import('../src/server/agents/cline');
    const hung = await clineNative(bin, { ...env, FAKE_CLINE_HANG: '1' }, cwd, 300);
    expect(hung.problems).toEqual([{ kind: 'timeout' }]);
    const quiet = await clineNative(bin, { ...env, FAKE_CLINE_NATIVE_BAD: 'rules', FAKE_CLINE_NATIVE_QUIET: '1' }, cwd);
    expect(quiet.problems).toEqual([{ kind: 'no-answer', part: 'all' }]);
    // The probe folders are gone.
    expect(readdirNames(home).filter((x) => x.startsWith('probe-'))).toEqual([]);
  });

  it('marks what the runs leave out with the switches they write: all skills, single tools and plugins', () => {
    const lists = {
      skills: [{ name: 's', description: '' }],
      builtinTools: [{ name: 'skills', id: 'skills' }, { name: 'editor', id: 'editor' }, { name: 'read_files', id: 'read_files' }],
      plugins: [{ name: 'p', id: '/p/a.js' }, { name: 'q', id: '/p/b.js' }, { name: 'r' }],
    };
    expect(clineLeftOut(lists)).toEqual({ ...lists, asRun: false });
    const marked = clineLeftOut(lists, ['skills'], { tools: ['editor'], plugins: ['/p/b.js'] });
    expect(marked.asRun).toBe(true);
    expect(marked.skills).toEqual([{ name: 's', description: '', leftOut: true }]);
    expect(marked.builtinTools!.map((x) => [x.id, Boolean(x.leftOut)])).toEqual([['skills', true], ['editor', true], ['read_files', false]]);
    expect(marked.plugins!.map((x) => Boolean(x.leftOut))).toEqual([false, true, false]);
  });

  it('shows skills left out in Settings when the runs leave them out, though `cline config` lists them', async () => {
    const home = join(root, 'native-off-home');
    const env = { PATH: process.env.PATH, [OPEN_AGENT_HOME_ENV]: home, FAKE_CLINE_NATIVE_DIR: join(FIX, 'native') };
    const cwd = mkdtempSync(join(root, 'native-off-cwd-'));
    const service = new NativeSetupService({ bin: () => bin, env: () => env, nativeOff: () => ['skills'], nativeItems: () => ({ plugins: ['/home/user/project/.cline/plugins/marker.js'] }) });
    const probe = await service.get('cline', cwd);
    expect(probe).toMatchObject({ provider: 'cline', asRun: true, nativeOff: ['skills'], nativeItems: { plugins: ['/home/user/project/.cline/plugins/marker.js'] } });
    expect(probe.skills.map((x) => x.leftOut)).toEqual([true, true]);
    expect(probe.builtinTools!.find((x) => x.id === 'skills')!.leftOut).toBe(true);
    expect(probe.plugins).toEqual([{ name: 'marker', source: 'user', id: '/home/user/project/.cline/plugins/marker.js', leftOut: true }]);
    // Nothing left out: as Cline reports it.
    const plain = await new NativeSetupService({ bin: () => bin, env: () => env }).get('cline', cwd);
    expect(plain.asRun).toBe(false);
    expect(plain.skills.every((x) => !x.leftOut)).toBe(true);
  });

  it('asks outside a run without the backends’ keys, and with its own variables empty', () => {
    const env = clineProbeEnv({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', XAI_API_KEY: 'k', CLINE_HUB_PORT: '25463', CLINE_DIR: '/h/config', CLINE_NPM_COMMAND: 'evil', PATH: '/bin' });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CLINE_HUB_PORT).toBe('');
    expect(env.CLINE_DIR).toBe('/h/config');
    expect(env.CLINE_NPM_COMMAND).toBeUndefined();
    expect(CLINE_EMPTY_ENV.every((k) => env[k] === '')).toBe(true);
  });
});

function readdirNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
