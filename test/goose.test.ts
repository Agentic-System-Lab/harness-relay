import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApprovalAnswer, NativePart, Permission } from '../src/shared/types';
import {
  acpApprovalRequest,
  acpCallInfo,
  acpPermissionDecision,
  createAcpUpdateHandler,
  defaultAcpDeps,
  type AcpToolCall,
  type AcpTurnDeps,
} from '../src/server/agents/acpTurn';
import {
  GOOSE_CONFIG_YAML,
  GOOSE_SESSION_CLEARED,
  GOOSE_EFFORTS,
  GOOSE_HINT_FILES,
  GOOSE_PERMISSION_YAML,
  GOOSE_QUIET_HOSTS,
  GOOSE_TODO_NOTE,
  GOOSE_TRACING_PREFIXES,
  cleanGooseEnv,
  findBash,
  gooseAcp,
  gooseAgent,
  gooseBackendHost,
  gooseAfterRefusal,
  gooseAfterSession,
  gooseBriefing,
  gooseCallInfo,
  gooseEndpointFile,
  gooseEndpointKeyVar,
  gooseEndpointProvider,
  gooseError,
  gooseExtensionsEnv,
  gooseFilterUpdate,
  gooseHideTool,
  gooseHintFiles,
  gooseHome,
  gooseMode,
  gooseModels,
  gooseNative,
  gooseLocalMcpPorts,
  gooseMcpServers,
  gooseSandbox,
  gooseUsesHttps,
  goosePlan,
  goosePluginDirs,
  goosePluginParts,
  goosePluginsEnv,
  gooseProvider,
  gooseRunner,
  gooseSessionParams,
  gooseSessionsDb,
  GOOSE_SHELL_WRAPPER,
  gooseShellEnv,
  gooseToolKind,
  gooseToolName,
  gooseToolOf,
  gooseSessionTotals,
  gooseTotalsBefore,
  gooseTurnUsage,
  gooseUsage,
  GOOSE_NOTHING_USED,
  isReadOnlyCommand,
  parseGooseCatalog,
  parseGooseSkills,
  prepareGoose,
  restoreGooseSession,
  sealGooseExtensions,
  resetGooseDir,
  shellMask,
} from '../src/server/agents/goose';
import { emptyStateFolder, sealedFolder, stateFolder, type OpenRunContext } from '../src/server/agents/open';
import { openSqliteFile } from '../src/server/db';
import { GOOSE_USAGE_SCHEMA, gooseCalls } from './goose-usage-db';
import { AgentRunError, type AgentEvent, type ApprovalRequest, type RunBackends, type RunOptions } from '../src/server/agents/types';
import { backendRun } from '../src/server/backends';
import { withLang } from '../src/server/i18n';
import type { RelaySandboxCommand, RelaySandboxSpec } from '../src/server/relaySandbox';
import { OPEN_AGENT_HOME_ENV } from '../src/server/settings';

const FIXTURES = join(__dirname, 'fixtures', 'goose');

interface Line {
  from: 'client' | 'agent' | 'exit';
  msg: Record<string, any>;
}

/** A recorded transcript (test/fixtures/goose/<name>.jsonl): every line both ways, as Goose 1.58.1 sent it. */
function fixture(name: string): Line[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
}

/** The agent's messages of a transcript's first prompt (between the client's `session/prompt` and its answer). */
function promptSegment(lines: Line[]): { messages: Record<string, any>[]; result: Record<string, any> } {
  const at = lines.findIndex((l) => l.from === 'client' && l.msg.method === 'session/prompt');
  const id = lines[at]!.msg.id;
  const messages: Record<string, any>[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.from !== 'agent') continue;
    if (l.msg.id === id && !l.msg.method) return { messages, result: l.msg };
    messages.push(l.msg);
  }
  return { messages, result: {} };
}

let root: string;
let n = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'relay-goose-'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const BACKENDS: RunBackends = {
  apis: { openai: 'sk-test-openai-0000', anthropic: 'sk-ant-test-0000', xai: 'xai-test-0000' },
  endpoints: [
    { id: 'homelab', name: 'Homelab vLLM', baseUrl: 'http://vllm.example:8000/v1', models: ['muse-glimmer-30b-nvfp4'], apiKey: 'endpoint-key-0000' },
    { id: 'local', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', models: [] },
  ],
};

/** A run context as startOpenProcess hands it to `prepare`, in a fresh home and folder. */
function context(over: Partial<RunOptions> = {}, env: NodeJS.ProcessEnv = {}): OpenRunContext {
  const dir = join(root, `ctx-${++n}`);
  const home = join(dir, 'home');
  const cwd = join(dir, 'project');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  const o: RunOptions = {
    bin: 'goose',
    env: { PATH: process.env.PATH, [OPEN_AGENT_HOME_ENV]: home },
    prompt: 'Hi',
    systemPrompt: 'You are @Gus.',
    cwd,
    permission: 'full',
    model: 'openai/gpt-5.4-mini',
    signal: new AbortController().signal,
    onEvent: () => undefined,
    backends: BACKENDS,
    ...over,
  };
  const run = backendRun(o.backends, o.model, 'Goose');
  // The member's own state folder, apart from the shared home (as startOpenProcess gives it).
  const state = join(home, 'private', 'm1');
  const layout = gooseHome(home, state);
  // On Linux unless a test says otherwise: Goose's shell wrapper is not used on Windows.
  return { o, run, home: { root: home, state, ...layout }, env: { ...o.env, ...run.env, ...layout.env, ...env }, sandboxed: o.permission !== 'full', platform: 'linux', tmpDir: join(dir, 'tmp'), state: {} };
}

describe("Goose's home", () => {
  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('points GOOSE_PATH_ROOT and HOME at its home, with keyring, telemetry and session naming off', () => {
    const h = gooseHome('/r');
    expect(h.env).toEqual({ HOME: '/r', GOOSE_PATH_ROOT: '/r', GOOSE_DISABLE_KEYRING: '1', GOOSE_TELEMETRY_OFF: '1', GOOSE_DISABLE_SESSION_NAMING: 'true' });
    expect(h.statePaths).toEqual(['/r/data', '/r/state']);
    // Everything that changes what it does at start: config, its shell, plugins, skills and recipes found through HOME.
    expect(h.configPaths).toEqual(['/r/config', '/r/bin', '/r/.agents', '/r/.config', '/r/.claude', '/r/.goose']);
  });

  it('asks the relay sandbox for what it needs, and nothing more', () => {
    const http = (url: string) => ({ name: 'x', transport: 'http' as const, command: '', args: [], url, env: {}, headers: {} });
    const stdio = { name: 's', transport: 'stdio' as const, command: 'node', args: [], url: '', env: {}, headers: {} };
    const sandbox = (model: string, mcpServers: RunOptions['mcpServers'] = []) => {
      const ctx = context({ model, mcpServers });
      return gooseSandbox(ctx);
    };
    // An HTTPS backend: the certificate-trust daemon (macOS), and its own catalog refused quietly.
    for (const model of ['openai/gpt-5.4-mini', 'anthropic/claude-haiku-5-5', 'xai/grok-4.3']) {
      expect(sandbox(model)).toEqual({ quietlyDeniedHosts: GOOSE_QUIET_HOSTS, allowTlsTrustd: true });
    }
    // A plain-HTTP endpoint needs no trustd, unless an MCP server of the run is on HTTPS.
    expect(sandbox('homelab/muse-glimmer-30b-nvfp4', [stdio])).toEqual({ quietlyDeniedHosts: GOOSE_QUIET_HOSTS });
    expect(sandbox('homelab/muse-glimmer-30b-nvfp4', [http('https://mcp.example.com/mcp')])).toEqual({ quietlyDeniedHosts: GOOSE_QUIET_HOSTS, allowTlsTrustd: true });
    // A local HTTP MCP server: its port, which Goose only connects to (through the proxy), never listens on.
    expect(sandbox('homelab/muse-glimmer-30b-nvfp4', [http('http://127.0.0.1:18765/mcp')])).toEqual({ quietlyDeniedHosts: GOOSE_QUIET_HOSTS, connectPorts: [18765] });
    expect(GOOSE_QUIET_HOSTS).toEqual(['models.dev', 'api.osv.dev', 'us.i.posthog.com']);
    expect(gooseLocalMcpPorts([http('http://localhost:3000'), http('http://[::1]:3001/x'), http('http://localhost:3000/y'), http('http://127.0.0.1/'), http('https://a.localhost:9000'), http('https://mcp.example.com:8443'), http('not a url'), stdio])).toEqual([3000, 3001, 80, 9000]);
    expect(gooseLocalMcpPorts()).toEqual([]);
    expect(gooseUsesHttps({ kind: 'endpoint', endpoint: { id: 'e', name: 'e', baseUrl: 'https://lab.example/v1', models: [] } })).toBe(true);
    expect(gooseUsesHttps({ kind: 'endpoint' })).toBe(false);
    expect(gooseAcp.sandbox).toBe(gooseSandbox);
  });
});

describe("Goose's settings per run", () => {
  it.each([
    ['openai/gpt-5.4-mini', 'openai', 'gpt-5.4-mini'],
    ['anthropic/claude-haiku-5-5', 'anthropic', 'claude-haiku-5-5'],
    ['xai/grok-4.3', 'xai', 'grok-4.3'],
    ['homelab/muse-glimmer-30b-nvfp4', 'relay-homelab', 'muse-glimmer-30b-nvfp4'],
  ])('%s → provider %s, model %s', (model, provider, name) => {
    for (const permission of ['read-only', 'edit', 'full'] as Permission[]) {
      const ctx = context({ model, permission });
      prepareGoose(ctx, { realHome: '/home/user', bash: '/bin/bash' });
      expect(ctx.env).toMatchObject({
        GOOSE_PROVIDER: provider,
        GOOSE_MODEL: name,
        GOOSE_MODE: permission === 'full' ? 'auto' : 'approve',
        GOOSE_SHELL: join(ctx.home.root, 'bin', 'bash'),
        HOME: ctx.home.state,
        GOOSE_PATH_ROOT: ctx.home.state,
        GOOSE_DISABLE_KEYRING: '1',
        CONTEXT_FILE_NAMES: JSON.stringify(GOOSE_HINT_FILES),
        EXTENSIONS: gooseExtensionsEnv(),
        PLUGINS: '{}',
      });
      // Only the key of the run's own backend: an API backend's under its variable, the endpoint's under its own.
      const keys = { OPENAI_API_KEY: 'sk-test-openai-0000', ANTHROPIC_API_KEY: 'sk-ant-test-0000', XAI_API_KEY: 'xai-test-0000' };
      const own = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', xai: 'XAI_API_KEY' }[provider];
      for (const [name, key] of Object.entries(keys)) expect(ctx.env[name]).toBe(name === own ? key : undefined);
      expect(ctx.env[gooseEndpointKeyVar('homelab')]).toBe(provider === 'relay-homelab' ? 'endpoint-key-0000' : undefined);
    }
  });

  it("keeps Goose's own shell on Windows, where the POSIX wrapper cannot run", () => {
    const ctx: OpenRunContext = { ...context({ model: 'homelab/muse-glimmer-30b-nvfp4' }), platform: 'win32' };
    ctx.env.GOOSE_SHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    prepareGoose(ctx, { realHome: 'C:\\Users\\me', bash: 'unused' });
    // Goose picks its own (an inherited GOOSE_SHELL is taken out, as anywhere); none of the wrapper's variables are set.
    expect(ctx.env).not.toHaveProperty('GOOSE_SHELL');
    expect(ctx.env).not.toHaveProperty('HARNESS_RELAY_USER_HOME');
    expect(ctx.env).not.toHaveProperty('HARNESS_RELAY_GOOSE_BASH');
    expect(existsSync(join(ctx.home.root, 'bin', 'bash'))).toBe(false);
    // Everything else as anywhere.
    expect(ctx.env).toMatchObject({ GOOSE_PROVIDER: 'relay-homelab', GOOSE_MODEL: 'muse-glimmer-30b-nvfp4' });
  });

  it('writes its config, an empty permission file, each endpoint as a provider, and its shell; never a key', () => {
    const ctx = context({ model: 'homelab/muse-glimmer-30b-nvfp4' });
    const config = join(ctx.home.state, 'config');
    mkdirSync(join(config, 'custom_providers'), { recursive: true });
    writeFileSync(join(config, 'custom_providers', 'relay-gone.json'), '{}');
    writeFileSync(join(config, 'custom_providers', 'mine.json'), '{}');
    writeFileSync(join(config, 'secrets.yaml'), 'OPENAI_API_KEY: old\n');
    writeFileSync(join(config, 'permission.yaml'), 'user:\n  always_allow: [shell]\n');
    prepareGoose(ctx, { realHome: "/home/o'user", bash: '/opt/bin/bash' });
    expect(readFileSync(join(config, 'config.yaml'), 'utf8')).toBe(GOOSE_CONFIG_YAML);
    expect(readFileSync(join(config, 'permission.yaml'), 'utf8')).toBe(GOOSE_PERMISSION_YAML);
    expect(existsSync(join(config, 'secrets.yaml'))).toBe(false);
    // Only Harness Relay's own provider files, for the endpoints there are now.
    expect(readdirSync(join(config, 'custom_providers')).sort()).toEqual(['relay-homelab.json', 'relay-local.json']);
    const homelab = JSON.parse(readFileSync(join(config, 'custom_providers', 'relay-homelab.json'), 'utf8'));
    expect(homelab).toMatchObject({
      name: 'relay-homelab',
      engine: 'openai',
      display_name: 'Homelab vLLM',
      api_key_env: 'HARNESS_RELAY_ENDPOINT_HOMELAB_API_KEY',
      requires_auth: true,
      base_url: 'http://vllm.example:8000/v1',
      models: [{ name: 'muse-glimmer-30b-nvfp4' }],
      dynamic_models: false,
    });
    const local = JSON.parse(readFileSync(join(config, 'custom_providers', 'relay-local.json'), 'utf8'));
    expect(local).toMatchObject({ api_key_env: '', requires_auth: false, models: [] });
    expect(local.dynamic_models).toBeUndefined();
    for (const f of readdirSync(join(config, 'custom_providers'))) expect(readFileSync(join(config, 'custom_providers', f), 'utf8')).not.toContain('endpoint-key-0000');
    expect(readFileSync(join(ctx.home.root, 'bin', 'bash'), 'utf8')).toBe(GOOSE_SHELL_WRAPPER);
    expect(ctx.env).toMatchObject(gooseShellEnv("/home/o'user", '/opt/bin/bash'));
    expect(ctx.state.realHome).toBe("/home/o'user");
    // Every config and state folder exists (the sandbox denies writes to them by path).
    for (const p of [...ctx.home.configPaths, ...ctx.home.statePaths]) expect(existsSync(p)).toBe(true);
    // Writing again changes nothing (parallel runs share these files).
    prepareGoose(ctx, { realHome: "/home/o'user", bash: '/opt/bin/bash' });
    expect(readFileSync(join(config, 'config.yaml'), 'utf8')).toBe(GOOSE_CONFIG_YAML);
  });

  it('empties its config folders of what an earlier run left there, plugins, skills and recipes among them', () => {
    const ctx = context();
    const s = ctx.home.state;
    const planted = [
      join(s, '.agents', 'plugins', 'x', '.mcp.json'),
      join(s, '.agents', 'skills', 'sk', 'SKILL.md'),
      join(s, '.agents', 'AGENTS.md'),
      join(s, '.claude', 'skills', 'c', 'SKILL.md'),
      join(s, '.config', 'goose', 'settings.json'),
      join(s, '.goose', 'recipes', 'r.yaml'),
      join(s, 'config', '.goosehints'),
      join(s, 'config', 'AGENTS.md'),
      join(s, 'config', 'adversary.md'),
      join(s, 'config', 'recipes', 'r.yaml'),
      join(s, 'config', 'skills', 'k', 'SKILL.md'),
      join(ctx.home.root, 'bin', 'other'),
    ];
    for (const f of planted) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, 'x');
    }
    // A folder a run made unwritable, and a config folder that is a link elsewhere.
    chmodSync(join(s, '.agents', 'skills', 'sk'), 0o500);
    chmodSync(join(s, '.agents', 'skills'), 0o500);
    const elsewhere = join(root, `elsewhere-${++n}`);
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'keep.txt'), 'not Goose\'s');
    rmSync(join(s, '.goose'), { recursive: true, force: true });
    symlinkSync(elsewhere, join(s, '.goose'));
    // Its sessions stay.
    mkdirSync(join(s, 'data', 'sessions'), { recursive: true });
    const sessions = openSqliteFile(join(s, 'data', 'sessions', 'sessions.db'));
    sessions.exec("CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES ('kept');");
    sessions.close();
    prepareGoose(ctx, { realHome: '/h', bash: '/bin/bash' });
    for (const f of planted) expect([f, existsSync(f)]).toEqual([f, false]);
    for (const d of ['.agents', '.claude', '.config']) expect(readdirSync(join(s, d))).toEqual([]);
    expect(lstatSync(join(s, '.goose')).isSymbolicLink()).toBe(false);
    expect(readdirSync(join(s, '.goose'))).toEqual([]);
    expect(readFileSync(join(elsewhere, 'keep.txt'), 'utf8')).toBe("not Goose's");
    expect(readdirSync(join(s, 'config')).sort()).toEqual(['config.yaml', 'custom_providers', 'permission.yaml']);
    expect(readdirSync(join(ctx.home.root, 'bin'))).toEqual(['bash']);
    const kept = openSqliteFile(join(s, 'data', 'sessions', 'sessions.db'));
    expect(kept.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'kept' }]);
    kept.close();
    // A file where a config folder goes is replaced by the folder.
    writeFileSync(join(root, `f-${n}`), '');
    resetGooseDir(join(root, `f-${n}`));
    expect(statSync(join(root, `f-${n}`)).isDirectory()).toBe(true);
  });

  it('fails the run when a file of its config cannot be written, leaving no temp file', () => {
    const ctx = context();
    const config = join(ctx.home.state, 'config');
    mkdirSync(join(config, 'config.yaml', 'in-the-way'), { recursive: true });
    expect(() => prepareGoose(ctx, { realHome: '/h', bash: '/bin/bash' })).toThrow();
    expect(readdirSync(config).filter((f) => f.includes('.relay-'))).toEqual([]);
  });

  it('takes out what the server inherited that would change what Goose does', () => {
    const ctx = context({}, {
      GOOSE_MODE: 'auto',
      GOOSE_RECIPE_PATH: '/x',
      OPENAI_HOST: 'http://evil.example',
      EXTENSIONS: '{}',
      CONTEXT_FILE_NAMES: '[]',
      KEEP_ME: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://collector.example/t',
      OTEL_SERVICE_NAME: 'x',
      LANGFUSE_HOST: 'https://langfuse.example',
      LANGFUSE_SECRET_KEY: 'sk-lf',
    });
    prepareGoose(ctx, { realHome: '/h', bash: '/bin/bash' });
    expect(ctx.env.GOOSE_RECIPE_PATH).toBeUndefined();
    expect(ctx.env.OPENAI_HOST).toBeUndefined();
    // No traces of the turn sent anywhere.
    expect(Object.keys(ctx.env).filter((k) => GOOSE_TRACING_PREFIXES.some((p) => k.startsWith(p)))).toEqual([]);
    expect(ctx.env.GOOSE_MODE).toBe('auto'); // full access: its own value, not the inherited one
    expect(ctx.env.CONTEXT_FILE_NAMES).toBe(JSON.stringify(GOOSE_HINT_FILES));
    expect(ctx.env.KEEP_ME).toBe('1');
    const env: NodeJS.ProcessEnv = { GOOSE_PATH_ROOT: '/r', GOOSE_X: '1', PLUGINS: '{}', PATH: '/bin' };
    cleanGooseEnv(env, { GOOSE_PATH_ROOT: '/r' });
    expect(env).toEqual({ GOOSE_PATH_ROOT: '/r', PATH: '/bin' });
  });

  it('leaves out instruction files and plugins as the run says', () => {
    const ctx = context({ nativeOff: ['instructions'] as NativePart[] });
    const plugins = join(ctx.o.cwd, '.agents', 'plugins');
    mkdirSync(join(plugins, 'alpha'), { recursive: true });
    mkdirSync(join(plugins, 'beta'), { recursive: true });
    writeFileSync(join(plugins, 'not-a-folder'), '');
    // One an earlier run put in its own plugins folder is gone before Goose starts.
    mkdirSync(join(ctx.home.state, '.agents', 'plugins', 'planted'), { recursive: true });
    ctx.o.nativeItems = { plugins: [join(plugins, 'beta')] };
    prepareGoose(ctx, { realHome: '/h', bash: '/bin/bash' });
    expect(ctx.env.CONTEXT_FILE_NAMES).toBe('[]');
    expect(JSON.parse(String(ctx.env.PLUGINS))).toEqual({
      [join(plugins, 'alpha')]: { enabled: true },
      [join(plugins, 'beta')]: { enabled: false },
    });
    mkdirSync(join(ctx.home.root, '.agents', 'plugins', 'mine'), { recursive: true });
    const dirs = goosePluginDirs(ctx.o.cwd, ctx.home.root);
    expect(dirs.map((d) => [d.name, d.scope])).toEqual([['alpha', 'project'], ['beta', 'project'], ['mine', 'user']]);
    expect(JSON.parse(goosePluginsEnv(dirs, { nativeOff: ['plugins'] }))).toEqual(Object.fromEntries(dirs.map((d) => [d.root, { enabled: false }])));
    // In its own home, the project's plugins are its home's.
    expect(goosePluginDirs(ctx.home.root, ctx.home.root).map((d) => d.scope)).toEqual(['user']);
  });

  it('turns on only the extensions a run has (besides developer)', () => {
    expect(JSON.parse(gooseExtensionsEnv())).toEqual({
      analyze: { enabled: true, type: 'platform', name: 'analyze', description: '', bundled: true },
      summon: { enabled: true, type: 'platform', name: 'summon', description: '', bundled: true },
      todo: { enabled: true, type: 'platform', name: 'todo', description: '', bundled: true },
    });
  });

  it('names providers and key variables for endpoints apart from Goose\'s own', () => {
    expect(gooseEndpointProvider('ollama')).toBe('relay-ollama');
    expect(gooseProvider({ kind: 'xai', backend: 'xai' })).toBe('xai');
    expect(gooseEndpointKeyVar('my-lab')).toBe('HARNESS_RELAY_ENDPOINT_MY_LAB_API_KEY');
    expect(gooseEndpointFile({ id: 'e', name: '', baseUrl: 'http://h/v1', models: ['a'] }, 'b')).toMatchObject({ display_name: 'e', models: [{ name: 'a' }, { name: 'b' }] });
    expect(gooseMode('read-only')).toBe('approve');
    expect(gooseMode('edit')).toBe('approve');
    expect(gooseMode('full')).toBe('auto');
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')("gives Goose's commands the user's own HOME back", () => {
    // Fixed text: no path in it; run, it gives the command the user's HOME and leaves none of its variables.
    expect(GOOSE_SHELL_WRAPPER).not.toMatch(/\/Users|\/home/);
    const wrapper = join(root, 'goose-shell.sh');
    writeFileSync(wrapper, GOOSE_SHELL_WRAPPER, { mode: 0o700 });
    const r = spawnSync(wrapper, ['-c', 'printf "%s|%s|%s" "$HOME" "${HARNESS_RELAY_USER_HOME-unset}" "$1"', 'x', "a'b $(touch nope)"], {
      env: { PATH: '/usr/bin:/bin', ...gooseShellEnv("/Users/o'neil", '/bin/bash') },
      encoding: 'utf8',
      cwd: root,
    });
    expect(r.stdout).toBe("/Users/o'neil|unset|a'b $(touch nope)");
    expect(existsSync(join(root, 'nope'))).toBe(false);
    const bin = join(root, 'fake-path');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'bash'), '');
    expect(findBash(`/nowhere:${bin}`)).toBe(join(bin, 'bash'));
    expect(findBash('/nowhere')).toBe('/bin/sh');
    expect(findBash('')).toBe('/bin/sh');
  });

  it('puts the briefing and how the todo notes are shown into its system prompt', () => {
    expect(gooseBriefing({ systemPrompt: ' You are @Gus. ', permission: 'edit' })).toBe(`You are @Gus.\n\n${GOOSE_TODO_NOTE}`);
    expect(gooseBriefing({ systemPrompt: '', permission: 'full' })).toBe(GOOSE_TODO_NOTE);
  });

  it('asks for the whole extension list only when the MCP servers it loads itself are left out', () => {
    const plain = context();
    expect(gooseSessionParams(plain, 'new')).toEqual({ mcpServers: [] });
    expect(gooseSessionParams(plain, 'load')).toEqual({ mcpServers: [], _meta: { replayTail: 1 } });
    const off = context({
      nativeOff: ['mcp'],
      mcpServers: [
        { name: 'probe', transport: 'stdio', command: 'node', args: ['probe.js'], url: '', env: { A: '1' }, headers: {} },
        { name: 'web', transport: 'http', command: '', args: [], url: 'http://127.0.0.1:9/mcp', env: {}, headers: { Authorization: 'x' } },
      ],
    });
    off.state.realHome = '/home/u';
    expect(gooseSessionParams(off, 'new')).toEqual({
      mcpServers: gooseMcpServers(off),
      _meta: {
        enabledExtensions: [
          { type: 'platform', name: 'developer' },
          { type: 'platform', name: 'analyze' },
          { type: 'platform', name: 'summon' },
          { type: 'platform', name: 'todo' },
          { type: 'mcp', server: { name: 'probe', command: 'node', args: ['probe.js'], env: [{ name: 'HOME', value: '/home/u' }, { name: 'A', value: '1' }] }, env_keys: [], scopes: [] },
          { type: 'mcp', server: { type: 'http', name: 'web', url: 'http://127.0.0.1:9/mcp', headers: [{ name: 'Authorization', value: 'x' }] }, env_keys: [], scopes: [] },
        ],
      },
    });
  });

  it("gives the tool library's stdio MCP servers the user's HOME, and in the sandbox their caches in the run's temp folder", () => {
    const servers: RunOptions['mcpServers'] = [
      { name: 'npx-one', transport: 'stdio', command: 'npx', args: ['-y', 'x'], url: '', env: { TOKEN: 't' }, headers: {} },
      { name: 'own-home', transport: 'stdio', command: 'uvx', args: ['y'], url: '', env: { HOME: '/set/by/library' }, headers: {} },
      { name: 'web', transport: 'http', command: '', args: [], url: 'https://mcp.example/mcp', env: {}, headers: {} },
    ];
    const full = context({ mcpServers: servers });
    full.state.realHome = '/home/u';
    expect(gooseMcpServers(full)).toEqual([
      { name: 'npx-one', command: 'npx', args: ['-y', 'x'], env: [{ name: 'HOME', value: '/home/u' }, { name: 'TOKEN', value: 't' }] },
      { name: 'own-home', command: 'uvx', args: ['y'], env: [{ name: 'HOME', value: '/set/by/library' }] },
      { type: 'http', name: 'web', url: 'https://mcp.example/mcp', headers: [] },
    ]);
    const boxed = context({ mcpServers: servers, permission: 'edit' });
    boxed.state.realHome = '/home/u';
    const env = Object.fromEntries((gooseMcpServers(boxed)[0] as { env: { name: string; value: string }[] }).env.map((e) => [e.name, e.value]));
    const caches = join(boxed.tmpDir, 'mcp-cache');
    expect(env).toEqual({ HOME: '/home/u', npm_config_cache: join(caches, 'npm'), XDG_CACHE_HOME: join(caches, 'xdg'), UV_CACHE_DIR: join(caches, 'uv'), PIP_CACHE_DIR: join(caches, 'pip'), TOKEN: 't' });
    // Before prepare (outside a run): the server's own home.
    expect((gooseMcpServers(context({ mcpServers: servers }))[0] as { env: { name: string; value: string }[] }).env[0]).toEqual({ name: 'HOME', value: homedir() });
  });
});

describe('what a Goose tool call is', () => {
  it.each([
    ['cat hello.txt', true],
    ['cat hello.txt | wc -l', true],
    ['ls -la && rg -n foo src', true],
    ['find . -name "*.ts"', true],
    ['timeout 5 grep -r x .', false],
    ['echo hi > out.txt', false],
    ['cat a 2>/dev/null', false],
    ['echo $(rm -rf x)', false],
    ['echo `id`', false],
    ['echo ${HOME}', false],
    ['sleep 9 &', false],
    ['find . -delete', false],
    ['find . -exec rm {} \\;', false],
    ['rg --pre ./run.sh foo', false],
    ['sort -o out.txt in.txt', false],
    ['tree -o out.txt', false],
    ['file -C -m x', false],
    ['sudo cat /etc/shadow', false],
    ['FOO=1 cat x', false],
    ['$TOOL x', false],
    ['if cat a; then rm -rf x; fi', false],
    ['eval cat x', false],
    ['PATH=/tmp/evil:$PATH; ls', false],
    ['git status', false],
    ['git log -p', false],
    ['git diff --ext-diff', false],
    // An allowlist of options per program: anything that writes a file or runs a program asks.
    ['sort --compress-program=gzip big.txt', false],
    ['sort --compress-program gzip big.txt', false],
    ['sort --output=out.txt in.txt', false],
    ['sort -T /elsewhere in.txt', false],
    ['sort -rn -k2 -t, in.txt', true],
    ['sort --key=2 --field-separator , in.txt', true],
    ['find . -fprint0 out', false],
    ['find . -fls out', false],
    ['find . -okdir rm {} ;', false],
    ['find . -fprintf out %p', false],
    ['find . -newermt 2026-01-01 -mtime -5 -perm -644 -type f -print', true],
    ['find -L . \\( -name a -o -name b \\) -prune', true],
    ['find . ( -name a )', false],
    ['find . -frobnicate', false],
    ['rg -z foo', false],
    ['rg --search-zip foo', false],
    ['rg --pre-glob *.gz foo', false],
    ['rg --hostname-bin=./x foo', false],
    ['rg -n -C 3 -tpy --glob=!vendor foo src', true],
    ['rg -e foo -e bar', true],
    ['grep -rn --include=*.ts --exclude-dir=node_modules foo .', false],
    ["grep -rn --include='*.ts' --exclude-dir=node_modules foo .", true],
    ['grep -P -e x file', true],
    ['grep --frobnicate x', false],
    ['tail -f log.txt', false],
    ['tail -n 20 log.txt', true],
    ['head -20 a.txt', true],
    ['tree -o out.txt', false],
    ['tree -R -H . .', false],
    ['tree -L 2 -I node_modules', true],
    ['file -C -m magic', false],
    ['file -b a.png', true],
    ['diff -l a b', false],
    ['diff --paginate a b', false],
    ['diff -u a b', true],
    ['ls -la --color=never src', true],
    ['ls --frobnicate', false],
    ['wc -l --files0-from=list', true],
    ['du -sh .', true],
    ['stat -f %z a', true],
    ['cat -- -rf', true],
    ['jq .a data.json', true],
    ['ls | xargs cat', false],
    // What bash rewrites before the program sees it (the reviewer's probes): each would become `--pre=<program>`.
    ['X=--pre=prog; rg $X pat .', false],
    ['rg $"--pre=prog" pat .', false],
    ["rg $'--pre=prog' pat .", false],
    ['rg {--pre=prog,x} .', false],
    ['rg pat *', false],
    ['rg pat src/?.ts', false],
    ['rg pat [ab].ts', false],
    ['ls | xargs rg pat', false],
    ['xargs -a list cat', false],
    ['cat f; X=1', false],
    ['X=1 cat f', false],
    ['nohup cat f', false],
    ['env cat f', false],
    ['eval cat f', false],
    ["bash -c 'cat *'", false],
    ["sh -c 'rg pat .'", false],
    ['cat ~/notes.txt', false],
    ['cat "$HOME/x"', false],
    ['cat f # x', false],
    ["cat 'unclosed", false],
    ['! cat f', false],
    ['if cat f; then cat g; fi', false],
    ['(cat f)', false],
    // Assignments through a program's options, and arithmetic that runs a variable's value (round-2 probes).
    ["printf -v cat 'a[$(echo hi >&2)]'; (( cat ))", false],
    ["printf -v cat 'a[$(id)]'\n(( cat ))", false],
    ["printf -v 'a[$(echo hi >&2)]' x", false],
    ['printf -v PATH tools; cat x', false],
    ['printf -v PATH .; ls', false],
    ['printf -v HOME evil; jq . f', false],
    ['printf %s x', true],
    ['printf -- -x', true],
    ['ls; (( cat ))', false],
    ['(( cat = 1 ))', false],
    ['[[ -f x ]] && cat x', false],
    ['cat f; ( sort -o out f )', false],
    ['cat () ( rm x ); cat f', false],
    ['read -r cat < f', false],
    ['mapfile cat', false],
    ['declare PATH=.; cat x', false],
    ['typeset -x PATH=. ; cat x', false],
    ['export PATH=.; cat x', false],
    ['local x=1', false],
    ['echo -e x', true],
    ['echo -v x', false],
    ['file -z x', false],
    // The long forms of refused options ask too (round 3).
    ['file --uncompress x', false],
    ['file --uncompress-noreport x', false],
    ['file --compile -m magic', false],
    ['sort --compress-program=sh f', false],
    ['sort --temporary-directory=/x f', false],
    ['sort --random-source=f g', false],
    ['rg --search-zip x', false],
    ['rg --pre=sh x', false],
    ['rg --hostname-bin=sh x', false],
    ['tree --output=out', false],
    ['tree --fromfile list', false],
    ['tail --follow f', false],
    ['tail --retry f', false],
    ['diff --paginate a b', false],
    ['find . -execdir rm {} +', false],
    ['df --output', true],
    ['rg --follow x', true],
    ['file --brief x', true],
    ['find . -name -exec rm \'{}\' \\;', true],
    ['cat f |& rm x', false],
    ['tail --fol=name f', false],
    ['sort --comp=sh f', false],
    ["rg --pr''e=sh x .", false],
    ["rg -n 'a$' src", true],
    ['rg -n "a*b" src', true],
    ["find . -name '*.ts' -print", true],
    ['find . -name \\*.ts', true],
    ['cat a && wc -l b || head c', true],
    ['toString', false],
    ['constructor x', false],
    ['ls | xargs rm', false],
    ['./cat x', false],
    ['bin/ls', false],
    ['cat ./src/a.ts', true],
    ['cat src/cat', true],
    ['rm -rf build', false],
    ['npm test', false],
    ['', false],
    ['   ', false],
  ])('%s → reads only: %s', (line, ok) => {
    expect(isReadOnlyCommand(line)).toBe(ok);
  });

  it('names the tool from its _meta, else from its title', () => {
    expect(gooseToolOf({ _meta: { goose: { toolCall: { toolName: 'probe__magic_number' } } } })).toBe('probe__magic_number');
    expect(gooseToolOf({ title: 'shell · echo hi' })).toBe('shell');
    expect(gooseToolOf({ title: 'load skill · home-agents-skill' })).toBe('load_skill');
    expect(gooseToolOf({ title: 'probe: magic number' })).toBe('probe__magic_number');
    expect(gooseToolOf({ title: '' })).toBeUndefined();
    expect(gooseToolOf(undefined)).toBeUndefined();
    expect(gooseToolName({ _meta: { goose: { toolCall: { toolName: 'httpprobe__http_magic' } } } })).toBe('httpprobe: http_magic');
    expect(gooseToolName({ title: 'write · notes.txt' })).toBe('write');
    expect(gooseToolName({})).toBe('tool');
  });

  it("tells what a call does from its tool, since Goose's kind is always other", () => {
    expect(gooseToolKind({ kind: 'other', title: 'shell · cat a.txt' })).toBe('execute');
    expect(gooseToolKind({ kind: 'other', title: 'write · notes.txt' })).toBe('edit');
    expect(gooseToolKind({ kind: 'other', title: 'edit · notes.txt' })).toBe('edit');
    expect(gooseToolKind({ kind: 'other', title: 'tree · .' })).toBe('read');
    expect(gooseToolKind({ kind: 'other', title: 'analyze · src' })).toBe('read');
    expect(gooseToolKind({ kind: 'other', title: 'read image · a.png', rawInput: { path: 'a.png' } })).toBe('read');
    expect(gooseToolKind({ kind: 'other', title: 'read image · x', rawInput: { path: 'https://example.com/a.png' } })).toBe('fetch');
    expect(gooseToolKind({ _meta: { goose: { toolCall: { toolName: 'probe__magic_number' } } }, kind: 'other' })).toBeUndefined();
    expect(gooseToolKind({})).toBeUndefined();
  });

  /** The permission requests of the recorded runs, with the `tool_call` each one is about. */
  const requests = (name: string) => {
    const calls = new Map<string, AcpToolCall>();
    const out: { call: AcpToolCall; earlier?: AcpToolCall }[] = [];
    for (const l of fixture(name)) {
      if (l.from !== 'agent') continue;
      const u = l.msg.params?.update;
      if (u?.sessionUpdate === 'tool_call') calls.set(u.toolCallId, u);
      if (l.msg.method === 'session/request_permission') out.push({ call: l.msg.params.toolCall, earlier: calls.get(l.msg.params.toolCall.toolCallId) });
    }
    return out;
  };

  it("reads Goose's own permission requests (kind \"other\") as what they are", () => {
    // `echo` only prints: it counts as reading.
    const [shell] = requests('permission-allow-openai');
    expect(gooseCallInfo(shell!.call, shell!.earlier)).toEqual({ tool: 'shell', kind: 'read', command: undefined });
    expect(gooseCallInfo({ ...shell!.call, rawInput: { command: 'npm test' } }, shell!.earlier)).toEqual({ tool: 'shell', kind: 'execute', command: 'npm test' });
    const [write] = requests('permission-reject-openai');
    expect(gooseCallInfo(write!.call, write!.earlier)).toEqual({ tool: 'write', path: 'reject.txt', kind: 'edit' });
    const [mcp] = requests('mcp-stdio-system-prompt-openai');
    expect(gooseCallInfo(mcp!.call, mcp!.earlier)).toEqual({ tool: 'probe__magic_number', kind: 'other' });
    const [skill, delegate, subagent] = requests('approve-skill-subagent-openai');
    expect(gooseCallInfo(skill!.call, skill!.earlier)).toEqual({ tool: 'load_skill', kind: 'read' });
    expect(gooseCallInfo(delegate!.call, delegate!.earlier)).toMatchObject({ tool: 'delegate', kind: 'think' });
    // A subagent's call is only asked about, never announced: its title is all there is.
    expect(subagent!.earlier).toBeUndefined();
    expect(gooseCallInfo(subagent!.call, undefined)).toEqual({ tool: 'shell', kind: 'read', command: undefined });
    expect(gooseCallInfo({ ...subagent!.call, rawInput: { command: 'touch x' } }, undefined)).toEqual({ tool: 'shell', kind: 'execute', command: 'touch x' });
  });

  it.each([
    ['edit', { path: 'a.txt', before: 'x', after: 'y' }, { kind: 'edit', path: 'a.txt' }],
    ['tree', { path: '.' }, { kind: 'read', path: '.' }],
    ['analyze', { path: 'src' }, { kind: 'read', path: 'src' }],
    ['load', { source: 'x' }, { kind: 'read' }],
    ['read_image', { path: 'shot.png' }, { kind: 'read', path: 'shot.png' }],
    ['read_image', { path: 'https://example.com/a.png' }, { kind: 'fetch', url: 'https://example.com/a.png', path: undefined }],
    ['todo__todo_write', { content: '- [ ] a' }, { kind: 'think' }],
    ['delegate', { instructions: 'run the tests' }, { kind: 'think' }],
    // A source (a recipe or agent, the project's own among them) starts the extensions it declares.
    ['delegate', { source: 'project-recipe', instructions: 'x' }, { kind: 'other', path: 'project-recipe', reason: 'delegate to project-recipe' }],
    // Resuming continues a subagent a source may have started: the same.
    ['delegate', { resume: '20261110_3', instructions: 'go on' }, { kind: 'other', path: '20261110_3', reason: 'delegate to 20261110_3' }],
    ['shell', { command: 'cat a.txt' }, { kind: 'read', command: undefined }],
    ['shell', {}, { kind: 'execute' }],
  ])('%s %j', (tool, rawInput, expected) => {
    expect(gooseCallInfo({ kind: 'other', title: tool, rawInput }, { _meta: { goose: { toolCall: { toolName: tool } } } })).toMatchObject({ tool, ...expected });
  });

  it('decides under each permission, and asks the user with the right card', () => {
    const info = (tool: string, rawInput: Record<string, unknown>) => {
      const call: AcpToolCall = { toolCallId: 'c', kind: 'other', title: `${tool} · x`, rawInput };
      return acpCallInfo(call, (c) => gooseCallInfo(c, { _meta: { goose: { toolCall: { toolName: tool } } } }));
    };
    const cases: [string, Record<string, unknown>, Permission, boolean][] = [
      ['shell', { command: 'cat hello.txt' }, 'read-only', true],
      ['shell', { command: 'npm test' }, 'read-only', false],
      ['write', { path: 'a', content: 'x' }, 'read-only', false],
      ['tree', { path: '.' }, 'read-only', true],
      ['load_skill', { name: 's' }, 'read-only', true],
      ['delegate', { instructions: 'x' }, 'read-only', true],
      ['delegate', { source: 'project-recipe' }, 'read-only', false],
      ['delegate', { source: 'project-recipe' }, 'edit', true],
      ['delegate', { resume: '20261110_3' }, 'read-only', false],
      ['probe__magic_number', {}, 'read-only', false],
      ['shell', { command: 'npm test' }, 'edit', true],
      ['shell', { command: 'git push origin main' }, 'edit', false],
      ['write', { path: 'a' }, 'edit', true],
      ['probe__magic_number', {}, 'edit', true],
      ['shell', { command: 'git push' }, 'full', true],
    ];
    for (const [tool, input, permission, allowed] of cases) {
      const decision = withLang('en', () => acpPermissionDecision(permission, info(tool, input), 'Goose'));
      expect([tool, input, permission, decision.allow]).toEqual([tool, input, permission, allowed]);
    }
    expect(acpApprovalRequest(info('shell', { command: 'git push origin main' }), 'edit')).toEqual({ kind: 'command', detail: 'git push origin main', reason: 'shell · x' });
    expect(acpApprovalRequest(info('write', { path: 'ro.txt', content: 'x' }), 'read-only')).toEqual({ kind: 'edit', detail: 'ro.txt', reason: 'write · x', readOnlySandbox: true });
    // An MCP tool's card in read-only: its server runs in the sandbox too, so a write it tries fails.
    expect(acpApprovalRequest(info('probe__magic_number', {}), 'read-only')).toEqual({ kind: 'other', tool: 'probe__magic_number', reason: 'probe__magic_number · x', readOnlySandbox: true });
    expect(acpApprovalRequest(info('delegate', { source: 'project-recipe' }), 'read-only')).toMatchObject({ kind: 'other', tool: 'delegate', detail: 'project-recipe' });
  });
});

describe('Goose updates → events', () => {
  /** Replays a transcript's first prompt through the adapter's hooks, as the generic turn does. */
  const replay = (name: string, ctx = context()) => {
    const events: AgentEvent[] = [];
    const updates = createAcpUpdateHandler((e) => events.push(e), gooseAcp);
    const { messages, result } = promptSegment(fixture(name));
    for (const m of messages) {
      if (m.method !== 'session/update') continue;
      const u = gooseFilterUpdate({ sessionId: m.params.sessionId, update: m.params.update }, ctx);
      if (u) updates.handle(u);
    }
    updates.finish();
    return { events, updates, result, ctx };
  };

  it('a read through its shell, with live output and the result', async () => {
    const { events, result, updates, ctx } = replay('read-openai');
    expect(events).toEqual([
      { type: 'tool_start', id: 'call_60fmPeq3mDITD7IRTdG5cxYR', name: 'shell', detail: 'cat hello.txt', kind: 'execute' },
      { type: 'tool_end', id: 'call_60fmPeq3mDITD7IRTdG5cxYR', ok: true, output: 'hello from the project' },
      ...'`hello.txt` contains: **hello from the project**'.length ? [expect.objectContaining({ type: 'text' })] : [],
      ...events.slice(3),
    ]);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('`hello.txt` contains: **hello from the project**');
    expect(events.at(-1)).toEqual({ type: 'text_end' });
    // The run's id is kept for steering, and cleared when the turn is over.
    expect(ctx.state.activeRunId).toBeUndefined();
    // The answer's tokens are the last model call's and its cost the session's: neither is the turn's,
    // which comes from Goose's sessions database (none here).
    expect(result.result.usage).toMatchObject({ inputTokens: 2933, outputTokens: 16 });
    ctx.state.method = 'new';
    ctx.state.sessionId = '20261110_1';
    expect(await gooseUsage(result.result, updates.lastUsage, ctx)).toEqual({});
  });

  it('a write and an edit (no diff: what changed is in the call)', () => {
    const { events } = replay('edit-openai');
    expect(events.slice(0, 4)).toEqual([
      { type: 'tool_start', id: 'call_xP8BpxVq6E14EY0TK663XDtm', name: 'write', detail: 'notes.txt', kind: 'edit' },
      { type: 'tool_start', id: 'call_br8LRfiuCWi3cTjtOmtiu0SH', name: 'edit', detail: 'notes.txt', kind: 'edit' },
      { type: 'tool_end', id: 'call_xP8BpxVq6E14EY0TK663XDtm', ok: true, output: 'Created notes.txt (1 lines)' },
      { type: 'tool_end', id: 'call_br8LRfiuCWi3cTjtOmtiu0SH', ok: true, output: 'Edited notes.txt (1 lines -> 1 lines)' },
    ]);
  });

  it('a command with its output', () => {
    const { events } = replay('bash-openai');
    expect(events[0]).toEqual({ type: 'tool_start', id: 'call_7A92FC8InwqqqAxvsk3voVfi', name: 'shell', detail: 'echo hello-from-shell && ls', kind: 'execute' });
    expect(events[1]).toEqual({ type: 'tool_end', id: 'call_7A92FC8InwqqqAxvsk3voVfi', ok: true, output: 'hello-from-shell\nhello.txt\nnotes.txt' });
  });

  it('a declined call, with Harness Relay\'s reason instead of Goose\'s', () => {
    const events: AgentEvent[] = [];
    const updates = createAcpUpdateHandler((e) => events.push(e), gooseAcp);
    updates.refused('call_NBc1rgiatXLCAK866nmzj3YO', 'Declined');
    for (const m of promptSegment(fixture('permission-reject-openai')).messages) if (m.method === 'session/update') updates.handle(m.params.update);
    expect(events[1]).toEqual({ type: 'tool_end', id: 'call_NBc1rgiatXLCAK866nmzj3YO', ok: false, error: 'Declined' });
  });

  it('thinking (Anthropic, xAI)', () => {
    const a = replay('thinking-anthropic').events;
    expect(a[0]).toMatchObject({ type: 'thinking' });
    expect(a.some((e) => e.type === 'text' && e.text.includes('0.05'))).toBe(true);
    const x = replay('text-thinking-xai').events;
    expect(x.filter((e) => e.type === 'thinking').length).toBe(2);
  });

  it('the todo notes as the plan, not a row', () => {
    const { events } = replay('todo-openai');
    expect(events.filter((e) => e.type === 'plan')).toEqual([
      { type: 'plan', entries: [{ text: 'List files', status: 'pending' }, { text: 'Count lines in hello.txt', status: 'pending' }, { text: 'Report', status: 'pending' }] },
      {
        type: 'plan',
        entries: [
          { text: 'List files', status: 'pending' },
          { text: 'Count lines in hello.txt', status: 'pending' },
          { text: 'Report', status: 'pending' },
          { text: 'Listed files', status: 'pending' },
          { text: 'Counted lines in hello.txt', status: 'pending' },
        ],
      },
    ]);
    expect(events.filter((e) => e.type === 'tool_start').map((e) => (e as { name: string }).name)).toEqual(['tree', 'shell']);
    expect(goosePlan({ rawInput: { content: '- [x] one\n- [~] two\n- [ ] three\n* four\nnot a step' } })).toEqual([
      { text: 'one', status: 'completed' },
      { text: 'two', status: 'in_progress' },
      { text: 'three', status: 'pending' },
      { text: 'four', status: 'pending' },
    ]);
    expect(goosePlan({ rawInput: { content: 'just notes' } })).toBeUndefined();
    expect(goosePlan({ rawInput: {} })).toBeUndefined();
    expect(gooseHideTool({ title: 'todo: todo write' })).toBe(true);
    expect(gooseHideTool({ title: 'shell · ls' })).toBe(false);
  });

  it('a cancelled call gets no update: its row is closed as not finished', () => {
    const { events, updates, result } = replay('cancel-openai');
    expect(result.result.stopReason).toBe('cancelled');
    updates.closeOpen(false);
    expect(events.at(-1)).toMatchObject({ type: 'tool_end', id: 'call_A8OM0Mvp3b6XhI2TAbAUeesx', ok: false });
  });

  it("keeps the running turn's id for steering", () => {
    const ctx = context();
    gooseFilterUpdate({ sessionId: 's', update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: 'run_1' } } } }, ctx);
    expect(ctx.state.activeRunId).toBe('run_1');
    gooseFilterUpdate({ sessionId: 's', update: { sessionUpdate: 'session_info_update', title: 'x' } }, ctx);
    expect(ctx.state.activeRunId).toBe('run_1');
    gooseFilterUpdate({ sessionId: 's', update: { sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: null } } } }, ctx);
    expect(ctx.state.activeRunId).toBeUndefined();
  });
});

describe("a turn's usage", () => {
  const db = (ctx: OpenRunContext) => gooseSessionsDb(ctx.home.state);
  const usage = (ctx: OpenRunContext) => gooseUsage({ usage: { inputTokens: 1, outputTokens: 1 } }, { used: 1, size: 2, cost: { amount: 9, currency: 'USD' } }, ctx);
  /** A run's context once its session is there (`gooseAfterSession` keeps its method and id). */
  const ran = (ctx: OpenRunContext, sessionId: string, method: 'new' | 'load') => Object.assign(ctx.state, { sessionId, method });

  it('is every model call of a new session, its subagents\' and its compaction\'s, whatever ACP said', async () => {
    const ctx = context();
    gooseCalls(db(ctx), 's1', [
      { input: 1450, output: 5, cost: 0.0013 },
      { input: 1483, output: 11, cost: 0.0013502 },
      { input: 900, output: 40, cost: 0.0001, compaction: true },
    ]);
    // A delegate's session, and one its subagent started.
    gooseCalls(db(ctx), 's1-sub', [{ input: 300, output: 20, cost: 0.0002 }], { parent: 's1' });
    gooseCalls(db(ctx), 's1-sub-sub', [{ input: 100, output: 2, cost: 0.00001 }], { parent: 's1-sub' });
    // Another session of the member is not this one's.
    gooseCalls(db(ctx), 's2', [{ input: 5000, output: 500, cost: 1 }]);
    ran(ctx, 's1', 'new');
    expect(await usage(ctx)).toEqual({ inputTokens: 4233, outputTokens: 78, costUsd: 0.0029602 });
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')("is only what a loaded session added, read before Goose starts, a failed turn's calls included in neither", async () => {
    const first = context({ stateKey: 'conv.u1.a1' });
    gooseCalls(db(first), 's1', [{ input: 1000, output: 10, cost: 0.001 }]);
    ran(first, 's1', 'new');
    expect(await usage(first)).toEqual({ inputTokens: 1000, outputTokens: 10, costUsd: 0.001 });
    // A turn that failed after two calls: no usage is reported for it, and the next turn does not count them.
    gooseCalls(db(first), 's1', [{ input: 1100, output: 30, cost: 0.002 }, { input: 1200, output: 0, cost: 0.002 }]);
    const next = context({ stateKey: 'conv.u1.a1', sessionId: 's1' });
    next.home = first.home;
    prepareGoose(next, { realHome: '/h', bash: '/bin/bash' });
    await gooseTotalsBefore(next);
    expect(next.state.totalsBefore).toEqual({ input: 3300, output: 40, total: 3340, cost: expect.closeTo(0.005, 12) });
    gooseCalls(db(next), 's1', [{ input: 1300, output: 12, cost: 0.0015 }]);
    gooseCalls(db(next), 's1-sub', [{ input: 200, output: 3, cost: 0.0005 }], { parent: 's1' });
    ran(next, 's1', 'load');
    expect(await usage(next)).toEqual({ inputTokens: 1500, outputTokens: 15, costUsd: 0.002 });
    // A new session's prepare reads nothing: it starts from nothing.
    const fresh = context({ stateKey: 'conv.u1.a1' });
    fresh.home = first.home;
    prepareGoose(fresh, { realHome: '/h', bash: '/bin/bash' });
    await gooseTotalsBefore(fresh);
    expect(fresh.state.totalsBefore).toBeUndefined();
  });

  it("counts as Goose does: a running total that lost an update, xAI's reasoning, a model without a price", async () => {
    const ctx = context();
    gooseCalls(db(ctx), 's1', [{ input: 100, output: 5, cost: 0.01 }]);
    // Calls whose running totals were lost: the ledger's sum is larger, and counts.
    gooseCalls(db(ctx), 's1', [{ input: 200, output: 7, cost: 0.02 }], { ledgerOnly: true });
    expect(await gooseSessionTotals(db(ctx), 's1')).toEqual({ input: 300, output: 12, total: 312, cost: expect.closeTo(0.03, 12) });
    // xAI's reasoning is in Goose's total but not its output: the output is the total less the input.
    gooseCalls(db(ctx), 'x1', [{ input: 3704, output: 1, total: 3788, cost: 0.004 }]);
    ran(ctx, 'x1', 'new');
    expect(await usage(ctx)).toEqual({ inputTokens: 3704, outputTokens: 84, costUsd: 0.004 });
    // An endpoint's model has no price: tokens, no cost.
    gooseCalls(db(ctx), 'e1', [{ input: 50, output: 5 }]);
    ran(ctx, 'e1', 'new');
    expect(await usage(ctx)).toEqual({ inputTokens: 50, outputTokens: 5 });
    expect(await gooseSessionTotals(db(ctx), 'missing')).toEqual(GOOSE_NOTHING_USED);
  });

  it('says nothing it cannot tell: no database, one it cannot read, a view for a table, totals that went down', async () => {
    const ctx = context();
    ran(ctx, 's1', 'new');
    expect(await usage(ctx)).toEqual({});
    mkdirSync(dirname(db(ctx)), { recursive: true });
    writeFileSync(db(ctx), 'not a database');
    expect(await gooseSessionTotals(db(ctx), 's1')).toBeUndefined();
    expect(await usage(ctx)).toEqual({});
    // A command of a run put a view where Goose's ledger was.
    const viewed = context();
    gooseCalls(db(viewed), 's1', [{ input: 10, output: 1, cost: 0.1 }]);
    const conn = openSqliteFile(db(viewed));
    conn.exec("DROP TABLE usage_ledger; CREATE VIEW usage_ledger AS SELECT 's1' AS session_id, 1 AS input_tokens, 1 AS output_tokens, 2 AS total_tokens, 0 AS cost");
    conn.close();
    expect(await gooseSessionTotals(db(viewed), 's1')).toBeUndefined();
    // A loaded session whose totals before the turn are not known, or are more than after it.
    const loaded = context();
    gooseCalls(db(loaded), 's1', [{ input: 10, output: 1, cost: 0.1 }]);
    ran(loaded, 's1', 'load');
    expect(await usage(loaded)).toEqual({});
    loaded.state.totalsBefore = { input: 99, output: 9, total: 108, cost: 1 };
    expect(await usage(loaded)).toEqual({});
    // Nothing used (a turn stopped before its first call).
    expect(gooseTurnUsage({ input: 10, output: 1, total: 11, cost: 0.1 }, { input: 10, output: 1, total: 11, cost: 0.1 })).toEqual({});
    // Garbage a command wrote counts as nothing.
    const odd = context();
    gooseCalls(db(odd), 's1', [{ input: 10, output: 1, cost: 0.1 }]);
    const w = openSqliteFile(db(odd));
    w.exec("UPDATE sessions SET accumulated_input_tokens = 'lots', accumulated_cost = -5; UPDATE usage_ledger SET input_tokens = NULL, cost = NULL");
    w.close();
    expect(await gooseSessionTotals(db(odd), 's1')).toEqual({ input: 0, output: 1, total: 11 });
  });

  it("reads a database from before Goose's ledger, numbers past 2^53, and shows no cost on the user's endpoint", async () => {
    // From before Goose kept a ledger (it adds one when it starts): its running totals.
    const old = context();
    mkdirSync(dirname(db(old)), { recursive: true });
    const c = openSqliteFile(db(old));
    c.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, accumulated_input_tokens INTEGER,
      accumulated_output_tokens INTEGER, accumulated_total_tokens INTEGER, accumulated_cost REAL);
      INSERT INTO sessions VALUES ('s1', NULL, 100, 5, 105, 0.5)`);
    c.close();
    expect(await gooseSessionTotals(db(old), 's1')).toEqual({ input: 100, output: 5, total: 105, cost: 0.5 });
    // A number a command wrote past 2^53 is read as a real, not a failure of every later read.
    const big = context();
    gooseCalls(db(big), 's1', [{ input: 10, output: 1, cost: 0.1 }]);
    const w = openSqliteFile(db(big));
    w.exec('UPDATE sessions SET accumulated_input_tokens = 9007199254740993; UPDATE usage_ledger SET total_tokens = 9007199254740993');
    w.close();
    expect((await gooseSessionTotals(db(big), 's1'))!.input).toBeGreaterThanOrEqual(2 ** 53);
    // On the user's own endpoint Goose prices a model by its name as a vendor's: no cost shown.
    const own = context({ model: 'homelab/gpt-oss-120b', backends: { apis: {}, endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:8000/v1', models: ['gpt-oss-120b'] }] } });
    expect(own.run.kind).toBe('endpoint');
    gooseCalls(db(own), 'p1', [{ input: 50, output: 5, cost: 0.2 }]);
    ran(own, 'p1', 'new');
    expect(await usage(own)).toEqual({ inputTokens: 50, outputTokens: 5 });
    // A named pipe beside the database (its shared memory) is not opened: that would wait for a writer.
    if (process.platform !== 'win32') {
      spawnSync('mkfifo', [`${db(big)}-shm`]);
      expect(await gooseSessionTotals(db(big), 's1')).toBeUndefined();
    }
  });
});

describe("Goose's failures, said plainly", () => {
  const o = { model: 'anthropic/claude-haiku-5-5', backends: BACKENDS };
  it.each([
    ['Authentication required: {"reason":"turn_failed"}', 'Goose could not sign in with the Anthropic API key'],
    ['Ran into this error: Request failed: Resource not found (404) at https://api.openai.com/v1/responses: The model `gpt-x` does not exist: {"reason":"turn_failed"}', 'Anthropic has no model "claude-haiku-5-5" (404)'],
    ['Network error: Could not connect to api.anthropic.com — check your network connection and try again.', 'Goose could not reach Anthropic (api.anthropic.com)'],
    ['Ran into this error: Request failed: Bad request (400): {"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}.', 'Goose could not sign in with the Anthropic API key'],
  ])('%s', (message, expected) => {
    const err = withLang('en', () => gooseError(new AgentRunError(message), o)) as AgentRunError;
    expect(err).toBeInstanceOf(AgentRunError);
    expect(err.message).toContain(expected);
  });

  it("tells a backend that does not answer through the sandbox's proxy from a model API's own 400", () => {
    const err = (m: string, model = 'homelab/muse-glimmer-30b-nvfp4') => withLang('en', () => (gooseError(new AgentRunError(m), { model, backends: BACKENDS }) as Error).message);
    // A wrong port: the proxy's own error, with no body.
    expect(err('Ran into this error: Request failed: Bad request (400): .')).toBe('Goose could not reach Homelab vLLM (vllm.example:8000). Check the network, or the endpoint\'s address under Settings → Model backends.');
    expect(err('Ran into this error: Server error: Server error (502 Bad Gateway) at http://vllm.example:8001/v1/chat/completions: .\n\nPlease resend your message to try again.')).toContain('(vllm.example:8001)');
    expect(err('Ran into this error: Request failed: Bad request (400): .', 'openai/gpt-5.4-mini')).toContain('Goose could not reach OpenAI (api.openai.com)');
    expect(withLang('zh-TW', () => (gooseError(new AgentRunError('Ran into this error: Request failed: Bad request (400): .'), { model: 'homelab/m', backends: BACKENDS }) as Error).message)).toBe(
      'Goose 連不上 Homelab vLLM（vllm.example:8000）。請檢查網路，或在「設定 → 模型來源」檢查端點的網址。',
    );
    // A model API's own 400 says why: it stays as it is.
    const real = 'Ran into this error: Request failed: Bad request (400): {"code":"invalid-argument","error":"max_tokens is too large"}.';
    expect(err(real, 'xai/grok-4.3')).toBe(real);
    expect(err('Ran into this error: Server error (502 Bad Gateway): <html>bad gateway</html>')).toContain('<html>');
    // Without a model to name, the backend's label stands for its host.
    expect(withLang('en', () => (gooseError(new AgentRunError('Request failed: Bad request (400): .'), { model: 'gone/m', backends: BACKENDS }) as Error).message)).toContain('(gone)');
    expect(gooseBackendHost({ model: 'xai/grok-4.3' })).toBe('api.x.ai');
    expect(gooseBackendHost({ model: 'local/m', backends: BACKENDS })).toBe('127.0.0.1:1234');
    expect(gooseBackendHost({ model: 'gone/m', backends: BACKENDS })).toBeUndefined();
    expect(gooseBackendHost({ model: 'nope' })).toBeUndefined();
  });

  it('keeps other errors, without the JSON-RPC data', () => {
    const plain = new AgentRunError('Goose returned no session id');
    expect(gooseError(plain, o)).toBe(plain);
    expect((gooseError(new AgentRunError('Something broke: {"reason":"turn_failed"}'), o) as Error).message).toBe('Something broke');
    const stopped = new AgentRunError('Stopped', true);
    expect(gooseError(stopped, o)).toBe(stopped);
    const other = new Error('x');
    expect(gooseError(other, o)).toBe(other);
    // An endpoint by its name; a model that is not `<backend>/<model>` as it is.
    expect(withLang('en', () => (gooseError(new AgentRunError('Authentication required'), { model: 'homelab/m', backends: BACKENDS }) as Error).message)).toContain('Homelab vLLM');
    expect(withLang('en', () => (gooseError(new AgentRunError('Authentication required'), { model: 'nope' }) as Error).message)).toContain('the backend');
  });
});

describe("Goose's catalog and what it loads by itself", () => {
  it('reads its catalog as <backend>/<model> ids of the API backends', () => {
    const answer = fixture('providers-list').find((l) => l.from === 'agent' && l.msg.id === 2)!.msg.result;
    const catalog = parseGooseCatalog(answer);
    expect(catalog.efforts).toEqual(GOOSE_EFFORTS);
    expect(catalog.models.slice(0, 2)).toEqual([
      { id: 'anthropic/claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    ]);
    expect(catalog.models.map((m) => m.id)).toContain('openai/gpt-5.4-mini');
    expect(catalog.models.map((m) => m.id)).toContain('xai/grok-4.3');
    expect(catalog.models.every((m) => /^(openai|anthropic|xai)\//.test(m.id))).toBe(true);
    expect(parseGooseCatalog({ entries: [{ providerId: 'ollama', models: [{ id: 'x' }] }, { providerId: 'xai', models: [{ id: '' }, { id: 'g', name: '' }] }] }).models).toEqual([{ id: 'xai/g' }]);
    expect(parseGooseCatalog(undefined).models).toEqual([]);
  });

  it('reads its skills', () => {
    const answer = fixture('sources-list').find((l) => l.from === 'agent' && l.msg.id === 2)!.msg.result;
    const skills = parseGooseSkills(answer);
    expect(skills.map((s) => [s.name, s.source])).toEqual([
      ['goose-proj-skill', 'project'],
      ['home-agents-skill', 'user'],
      ['home-claude-skill', 'user'],
      ['home-xdg-skill', 'user'],
      ['proj-skill', 'project'],
    ]);
    expect(skills[0]!.path).toBe('/home/user/project/.goose/skills/goose-proj-skill');
    expect(parseGooseSkills({ sources: [{ type: 'skill', name: 'b', path: 'builtin://skills/b' }, { type: 'recipe', name: 'r' }] })).toEqual([{ name: 'b', description: '', source: 'bundled' }]);
    expect(parseGooseSkills(null)).toEqual([]);
  });

  it('finds its instruction files, plugins, their MCP servers and hooks', () => {
    const dir = join(root, `native-${++n}`);
    const repo = join(dir, 'repo');
    const cwd = join(repo, 'pkg');
    const home = join(dir, 'home');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(home, 'config'), { recursive: true });
    mkdirSync(join(cwd, '.agents', 'plugins', 'p1', 'hooks'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), 'a');
    writeFileSync(join(cwd, '.goosehints'), 'b');
    writeFileSync(join(home, 'config', 'AGENTS.md'), 'c');
    writeFileSync(join(cwd, '.agents', 'plugins', 'p1', '.mcp.json'), JSON.stringify({ mcpServers: { one: { command: 'node' }, two: { url: 'https://x' } } }));
    writeFileSync(join(cwd, '.agents', 'plugins', 'p1', 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }], PreToolUse: [{ matcher: 'shell', hooks: [] }] } }));
    expect(gooseHintFiles(cwd, home).map((f) => f.path)).toEqual([join(home, 'config', 'AGENTS.md'), join(repo, 'AGENTS.md'), join(cwd, '.goosehints')]);
    // Without a repository: the working directory only.
    expect(gooseHintFiles(join(dir, 'nowhere'), home).map((f) => f.path)).toEqual([join(home, 'config', 'AGENTS.md')]);
    const parts = goosePluginParts(goosePluginDirs(cwd, home));
    const p1 = join(cwd, '.agents', 'plugins', 'p1');
    expect(parts.plugins).toEqual([{ name: 'p1', source: 'project', id: p1 }]);
    expect(parts.mcpServers).toEqual([
      { name: 'p1:one', transport: 'stdio', source: 'plugin p1' },
      { name: 'p1:two', transport: 'http', source: 'plugin p1' },
    ]);
    expect(parts.hooks).toEqual([
      { event: 'SessionStart', source: 'plugin p1', file: join(p1, 'hooks', 'hooks.json') },
      { event: 'PreToolUse', matcher: 'shell', source: 'plugin p1', file: join(p1, 'hooks', 'hooks.json') },
    ]);
    expect(goosePluginParts([{ name: 'empty', root: join(dir, 'missing'), scope: 'user' }])).toEqual({ plugins: [{ name: 'empty', source: 'user', id: join(dir, 'missing') }], mcpServers: [], hooks: [] });
  });
});

// --- Whole turns against a stand-in for `goose acp` ------------------------------------------

/**
 * A stand-in for `goose acp` that speaks as Goose 1.58.1 did in the recorded runs:
 * - `initialize`: the recorded answer; `session/new`: a session in the mode, provider and model of
 *   its variables (`GOOSE_MODE`, `GOOSE_PROVIDER`, `GOOSE_MODEL`); `session/load`: replays two updates,
 *   then the session as `FAKE_GOOSE_STORED` (JSON) says (a prompt then starts with a `usage_update`
 *   of `FAKE_GOOSE_COST`); fails with Goose's "Session not found" for `FAKE_GOOSE_LOAD_FAIL`;
 * - `session/set_config_option` (a new provider resets the model) and `session/set_mode`; either fails for
 *   the value in `FAKE_GOOSE_REJECT`; `_goose/unstable/session/system-prompt/set`, `…/steer`,
 *   `…/providers/list` and `…/sources/list` (their recorded answers);
 * - `session/prompt` plays `FAKE_GOOSE_REPLAY` (a recorded transcript's first prompt: its updates and
 *   permission requests, waiting for each answer), `hang` (a shell call, until `session/cancel`) or
 *   `auth` (Goose's error turn for a bad key); before it answers, it records the model calls of
 *   `FAKE_GOOSE_CALLS` (JSON `[{input, output, total?, cost?, session?, parent?}]`) in its sessions
 *   database as Goose does (`data/sessions/sessions.db` under `GOOSE_PATH_ROOT`).
 * Every message it gets is logged to `FAKE_GOOSE_LOG`, with the variables it started with.
 */
const FAKE_GOOSE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const env = process.env;
const log = (o) => fs.appendFileSync(env.FAKE_GOOSE_LOG, JSON.stringify(o) + '\\n');
const pick = (k) => env[k];
log({ start: true, argv: process.argv.slice(2), env: Object.fromEntries(Object.keys(env).filter((k) => /^(GOOSE_|HOME$|EXTENSIONS$|PLUGINS$|CONTEXT_FILE_NAMES$|OPENAI_|HARNESS_RELAY_ENDPOINT)/.test(k)).map((k) => [k, pick(k)])) });
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
const lines = (name) => fs.readFileSync(name.startsWith('/') ? name : path.join(env.FAKE_GOOSE_FIXTURES, name + '.jsonl'), 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const answer = (name, id) => lines(name).find((l) => l.from === 'agent' && l.msg.id === id).msg.result;
const reject = (v) => env.FAKE_GOOSE_REJECT && v === env.FAKE_GOOSE_REJECT;
let state = {};
let nextId = 1000;
const waiting = new Map();
let onCancel;
const ask = (method, params) => new Promise((resolve) => { const id = 'req-' + nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const options = () => [
  { id: 'provider', currentValue: state.provider, options: [] },
  { id: 'mode', currentValue: state.mode, options: [] },
  { id: 'model', currentValue: state.model, options: [] },
  { id: 'thinking_effort', currentValue: state.effort, options: (env.FAKE_GOOSE_EFFORTS ? JSON.parse(env.FAKE_GOOSE_EFFORTS) : ['off', 'low', 'medium', 'high', 'max']).map((value) => ({ value, name: value })) },
];
const session = () => ({ modes: { currentModeId: state.mode, availableModes: ['auto', 'approve', 'smart_approve', 'chat'].map((id) => ({ id, name: id })) }, configOptions: options() });

async function prompt(id, p) {
  const s = p.sessionId;
  const scenario = env.FAKE_GOOSE_SCENARIO || 'replay';
  const update = (u) => send({ method: 'session/update', params: { sessionId: s, update: u } });
  if (scenario === 'hang') {
    update({ sessionUpdate: 'session_info_update', _meta: { goose: { activeRunId: 'run_hang' } } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'h1', title: 'shell · sleep 30', rawInput: { command: 'sleep 30' }, _meta: { goose: { toolCall: { toolName: 'shell', extensionName: 'developer' } } } });
    onCancel = () => send({ id, result: { stopReason: 'cancelled', usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } } });
    return;
  }
  if (scenario === 'auth') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Ran into this error: Authentication error: 401 Unauthorized.' } });
    return send({ id, error: { code: -32000, message: 'Authentication required', data: { reason: 'turn_failed' } } });
  }
  // A loaded session's prompt starts with the session's cost so far, as Goose's does.
  if (env.FAKE_GOOSE_COST) update({ sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: Number(env.FAKE_GOOSE_COST), currency: 'USD' } });
  const all = lines(env.FAKE_GOOSE_REPLAY);
  const at = all.findIndex((l) => l.from === 'client' && l.msg.method === 'session/prompt');
  const pid = all[at].msg.id;
  for (const l of all.slice(at + 1)) {
    if (l.from !== 'agent') continue;
    const m = l.msg;
    if (m.id === pid && !m.method) {
      if (env.FAKE_GOOSE_CALLS) record(s, JSON.parse(env.FAKE_GOOSE_CALLS));
      return send({ id, ...(m.error ? { error: m.error } : { result: m.result }) });
    }
    if (m.method === 'session/update') send({ method: m.method, params: { ...m.params, sessionId: s } });
    else if (m.method === 'session/request_permission') log({ answered: await ask(m.method, { ...m.params, sessionId: s }) });
  }
}

function record(s, calls) {
  const file = path.join(env.GOOSE_PATH_ROOT, 'data', 'sessions', 'sessions.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(\`${GOOSE_USAGE_SCHEMA}\`);
  for (const c of calls) {
    const id = c.session || s;
    const total = c.total === undefined ? c.input + c.output : c.total;
    const cost = c.cost === undefined ? null : c.cost;
    db.prepare('INSERT OR IGNORE INTO sessions (id, working_dir, parent_session_id) VALUES (?, ?, ?)').run(id, '/p', c.parent || null);
    db.prepare('UPDATE sessions SET accumulated_total_tokens = COALESCE(accumulated_total_tokens, 0) + ?, accumulated_input_tokens = COALESCE(accumulated_input_tokens, 0) + ?, accumulated_output_tokens = COALESCE(accumulated_output_tokens, 0) + ?, accumulated_cost = CASE WHEN ? IS NULL THEN accumulated_cost ELSE COALESCE(accumulated_cost, 0) + ? END WHERE id = ?').run(total, c.input, c.output, cost, cost, id);
    db.prepare('INSERT INTO usage_ledger (session_id, created_timestamp, input_tokens, output_tokens, total_tokens, cost) VALUES (?, 0, ?, ?, ?, ?)').run(id, c.input, c.output, total, cost);
  }
  db.close();
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  log(m);
  if (m.method === undefined) { const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r('result' in m ? m.result : { error: m.error }); } return; }
  const { id, method, params: p } = m;
  if (method === 'initialize') return send({ id, result: answer('initialize', 1) });
  if (method === 'session/new') {
    state = { provider: env.GOOSE_PROVIDER, model: env.GOOSE_MODEL, mode: env.GOOSE_MODE || 'auto', effort: 'off' };
    return send({ id, result: { sessionId: '20261110_1', ...session() } });
  }
  if (method === 'session/load') {
    if (env.FAKE_GOOSE_LOAD_FAIL) return send({ id, error: { code: -32002, message: 'Resource not found', data: 'Session not found: ' + p.sessionId } });
    send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } } } });
    send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } } } });
    state = JSON.parse(env.FAKE_GOOSE_STORED || '{}');
    return send({ id, result: session() });
  }
  if (method === 'session/set_config_option') {
    if (reject(p.value)) return send({ id, error: { code: -32603, message: 'Internal error', data: 'no such ' + p.configId } });
    if (p.configId === 'provider') { state.provider = p.value; state.model = 'provider-default'; }
    else if (p.configId === 'thinking_effort') state.effort = p.value;
    else state[p.configId] = p.value;
    return send({ id, result: { configOptions: options() } });
  }
  if (method === 'session/set_mode') {
    if (reject(p.modeId)) return send({ id, error: { code: -32602, message: 'Invalid params', data: 'Invalid mode' } });
    state.mode = p.modeId;
    return send({ id, result: null });
  }
  if (method === '_goose/unstable/session/system-prompt/set') return send({ id, result: {} });
  if (method === '_goose/unstable/session/steer') return send({ id, result: { runId: p.expectedRunId, messageId: 'steer_1' } });
  if (method === '_goose/unstable/providers/list') return env.FAKE_GOOSE_LIST_FAIL ? send({ id, error: { code: -32603, message: 'list failed' } }) : send({ id, result: answer('providers-list', 2) });
  if (method === '_goose/unstable/sources/list') return env.FAKE_GOOSE_LIST_FAIL ? send({ id, error: { code: -32603, message: 'list failed' } }) : send({ id, result: answer('sources-list', 2) });
  if (method === 'session/prompt') return prompt(id, p);
  if (method === 'session/cancel') { if (onCancel) onCancel(); return; }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Method not found' } });
});
`;

let fakeBin: string;
beforeAll(() => {
  fakeBin = join(root, 'fake-goose');
  writeFileSync(fakeBin, FAKE_GOOSE);
  chmodSync(fakeBin, 0o755);
});

interface Turn {
  o: RunOptions;
  events: AgentEvent[];
  approvals: ApprovalRequest[];
  log: () => Record<string, any>[];
  abort: AbortController;
}

/** One turn of the Goose runner against the stand-in; `fake` sets its FAKE_GOOSE_* variables. */
function turn(fake: Record<string, string>, over: Partial<RunOptions> = {}, answer?: (req: ApprovalRequest) => ApprovalAnswer): Turn {
  const dir = join(root, `turn-${++n}`);
  mkdirSync(join(dir, 'project'), { recursive: true });
  const logFile = join(dir, 'log.jsonl');
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const abort = new AbortController();
  const o: RunOptions = {
    bin: fakeBin,
    env: { PATH: process.env.PATH, [OPEN_AGENT_HOME_ENV]: join(dir, 'home'), FAKE_GOOSE_LOG: logFile, FAKE_GOOSE_FIXTURES: FIXTURES, ...fake },
    prompt: 'Go',
    systemPrompt: 'You are @Gus.',
    cwd: join(dir, 'project'),
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
  return { o, events, approvals, log, abort };
}

const sent = (r: Turn, method: string) => r.log().filter((m) => m.method === method);

/** Runner deps: the relay sandbox as a pass-through (its own tests are elsewhere), temp folders in the test's. */
const specs: RelaySandboxSpec[] = [];
const deps = (): Partial<AcpTurnDeps> => ({
  platform: 'darwin',
  sandboxAvailable: async () => ({ ok: true }),
  makeRunDirs: () => {
    const dir = mkdtempSync(join(root, 'sandbox-run-'));
    mkdirSync(join(dir, 'tmp'));
    mkdirSync(join(dir, 'host'));
    return { tmp: join(dir, 'tmp'), hostTmp: join(dir, 'host') };
  },
  sandboxCommand: async (bin, args, env, spec) => {
    specs.push(spec);
    return { bin, args, env, channel: () => undefined, failure: () => undefined, run: {} as RelaySandboxCommand['run'], dispose: async () => { for (const d of [spec.dirs?.tmp, spec.dirs?.hostTmp]) if (d) rmSync(d, { recursive: true, force: true }); } };
  },
  runTmpDir: join(root, 'run-tmp'),
});

// Its stand-in CLI is a script, and Windows starts only real programs (`.exe`): tried on macOS and Linux.
describe('a Goose turn', () => {
  it.skipIf(process.platform === 'win32')('starts with its variables, a new session, the briefing, and reports the turn', async () => {
    // The recorded turn's two model calls (its answer has the last one's tokens only: 2933 in, 16 out).
    const calls = [
      { input: 2875, output: 58, total: 2933, cost: 0.0012 },
      { input: 2917, output: 16, total: 2933, cost: 0.0014502 },
    ];
    const r = turn({ FAKE_GOOSE_REPLAY: 'read-openai', FAKE_GOOSE_CALLS: JSON.stringify(calls) }, { effort: 'low' });
    const result = await gooseRunner(deps()).run(r.o);
    expect(result).toEqual({ sessionId: '20261110_1', inputTokens: 5792, outputTokens: 74, costUsd: 0.0026502 });
    const start = r.log().find((m) => m.start)!;
    expect(start.argv).toEqual(['acp']);
    expect(start.env).toMatchObject({ GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'gpt-5.4-mini', GOOSE_MODE: 'auto', GOOSE_DISABLE_KEYRING: '1', CONTEXT_FILE_NAMES: '[".goosehints","AGENTS.md"]' });
    // The briefing through its system prompt (not in the prompt), the effort, nothing already so.
    expect(sent(r, '_goose/unstable/session/system-prompt/set')[0]!.params).toEqual({ sessionId: '20261110_1', mode: 'append', key: 'harness-relay', text: `You are @Gus.\n\n${GOOSE_TODO_NOTE}` });
    expect(sent(r, 'session/set_config_option').map((m) => [m.params.configId, m.params.value])).toEqual([['thinking_effort', 'low']]);
    expect(sent(r, 'session/set_mode')).toEqual([]);
    expect(sent(r, 'session/prompt')[0]!.params.prompt).toEqual([{ type: 'text', text: 'Go' }]);
    expect(r.events[0]).toEqual({ type: 'session', sessionId: '20261110_1' });
    expect(r.events.some((e) => e.type === 'tool_end' && e.ok)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('sets provider, model, effort and mode again after a load, in that order, and drops the replay', async () => {
    const r = turn(
      {
        FAKE_GOOSE_REPLAY: 'text-anthropic',
        FAKE_GOOSE_STORED: JSON.stringify({ provider: 'openai', model: 'gpt-5.4-nano', mode: 'auto', effort: 'off' }),
        // What Goose sends a loaded session's prompt (its total so far): not used.
        FAKE_GOOSE_COST: '0.0007',
        FAKE_GOOSE_CALLS: JSON.stringify([{ input: 1200, output: 9, cost: 0.0000969 }]),
      },
      { sessionId: '20261110_7', model: 'anthropic/claude-haiku-5-5', effort: 'high', permission: 'edit', stateKey: 'conv.load.a1' },
    );
    // The session's earlier turns, in the member's sessions database.
    gooseCalls(gooseSessionsDb(stateFolder(r.o.env[OPEN_AGENT_HOME_ENV]!, 'conv.load.a1')), '20261110_7', [{ input: 5000, output: 50, cost: 0.0007 }]);
    const result = await gooseRunner(deps()).run(r.o);
    const order = r.log().filter((m) => m.method === 'session/set_config_option' || m.method === 'session/set_mode' || m.method?.startsWith('_goose'));
    expect(order.map((m) => [m.method, m.params.configId ?? m.params.modeId ?? m.params.key])).toEqual([
      ['_goose/unstable/session/system-prompt/set', 'harness-relay'],
      ['session/set_config_option', 'provider'],
      ['session/set_config_option', 'model'],
      ['session/set_config_option', 'thinking_effort'],
      ['session/set_mode', 'approve'],
    ]);
    expect(order[1]!.params.value).toBe('anthropic');
    expect(order[2]!.params.value).toBe('claude-haiku-5-5');
    expect(sent(r, 'session/load')[0]!.params).toMatchObject({ sessionId: '20261110_7', _meta: { replayTail: 1 } });
    expect(r.events.some((e) => e.type === 'text' && e.text.includes('old reply'))).toBe(false);
    // Its usage is what the turn added to the session's totals before it.
    expect(result).toMatchObject({ inputTokens: 1200, outputTokens: 9, costUsd: 0.0000969 });
  });

  it.skipIf(process.platform === 'win32')('runs below full access in the relay sandbox, with its home, its backend and its opt-ins', async () => {
    specs.length = 0;
    const r = turn({ FAKE_GOOSE_REPLAY: 'text-openai' }, { permission: 'edit' });
    await gooseRunner(deps()).run(r.o);
    const home = r.o.env[OPEN_AGENT_HOME_ENV]!;
    // Its state, config and HOME are the run's own (no key given here: a folder of the run's own).
    const state = specs.at(-1)!.writable[0]!.replace(/\/data$/, '');
    expect(state.startsWith(join(home, 'private', 'run-'))).toBe(true);
    expect(specs.at(-1)).toMatchObject({
      permission: 'edit',
      cwd: r.o.cwd,
      allowedHosts: ['api.openai.com'],
      readOnly: gooseHome(home, state).configPaths,
      quietlyDeniedHosts: GOOSE_QUIET_HOSTS,
      allowTlsTrustd: true,
    });
    expect(specs.at(-1)!.writable.slice(0, 2)).toEqual(gooseHome(home, state).statePaths);
    expect(specs.at(-1)!.localPorts).toBeUndefined();
    expect(specs.at(-1)!.connectPorts).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('runs with the effort a provider offers, else with its own', async () => {
    const r = turn({ FAKE_GOOSE_REPLAY: 'text-vllm', FAKE_GOOSE_EFFORTS: '["off"]' }, { model: 'homelab/muse-glimmer-30b-nvfp4', effort: 'high' });
    await gooseRunner(deps()).run(r.o);
    expect(sent(r, 'session/set_config_option')).toEqual([]);
    expect(r.log().find((m) => m.start)!.env).toMatchObject({ GOOSE_PROVIDER: 'relay-homelab', HARNESS_RELAY_ENDPOINT_HOMELAB_API_KEY: 'endpoint-key-0000' });
  });

  it.skipIf(process.platform === 'win32').each([
    ['openai', 'Goose does not accept the model "openai/gpt-5.4-mini"'],
    ['gpt-5.4-nano', 'Goose does not accept the model "openai/gpt-5.4-nano"'],
    ['high', 'Goose does not accept the reasoning effort "high"'],
    ['approve', 'Goose does not accept the session mode "approve"'],
  ])('fails plainly when Goose refuses %s', async (value, message) => {
    const stored = JSON.stringify({ provider: 'xai', model: 'grok-4.3', mode: 'auto', effort: 'off' });
    const r = turn({ FAKE_GOOSE_REPLAY: 'text-openai', FAKE_GOOSE_STORED: stored, FAKE_GOOSE_REJECT: value }, { sessionId: 's', model: value === 'gpt-5.4-nano' ? 'openai/gpt-5.4-nano' : 'openai/gpt-5.4-mini', effort: 'high', permission: 'edit' });
    await expect(withLang('en', () => gooseRunner(deps()).run(r.o))).rejects.toThrow(message);
  });

  it.skipIf(process.platform === 'win32')('fails a resume it cannot do, so the orchestrator starts over with the history', async () => {
    const r = turn({ FAKE_GOOSE_LOAD_FAIL: '1' }, { sessionId: '20991231_99' });
    await expect(withLang('en', () => gooseRunner(deps()).run(r.o))).rejects.toThrow(/could not resume the earlier session: Resource not found: Session not found: 20991231_99/);
    expect(sent(r, 'session/prompt')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('asks the user about a publish command in edit, and passes the declined note on through steer', async () => {
    const r = turn({ FAKE_GOOSE_REPLAY: 'permission-reject-steer-openai' }, { permission: 'edit' }, () => ({ allow: false, note: 'name it ok.txt' }));
    // The recorded run asks about two writes: neither is a publish, so in edit both run without asking...
    await gooseRunner(deps()).run(r.o);
    expect(r.approvals).toEqual([]);
    expect(r.log().filter((m) => m.answered).map((m) => m.answered.outcome)).toEqual([
      { outcome: 'selected', optionId: 'allow_once' },
      { outcome: 'selected', optionId: 'allow_once' },
    ]);
    expect(sent(r, '_goose/unstable/session/steer')).toEqual([]);
    // ...in read-only they go to the user; declined, the note reaches the model as a message of the running turn.
    const ro = turn({ FAKE_GOOSE_REPLAY: 'permission-reject-steer-openai' }, { permission: 'read-only' }, () => ({ allow: false, note: 'name it ok.txt' }));
    await gooseRunner(deps()).run(ro.o);
    expect(ro.approvals).toEqual([
      { kind: 'edit', detail: 'reject.txt', reason: 'write · reject.txt', readOnlySandbox: true },
      { kind: 'edit', detail: 'ok.txt', reason: 'write · ok.txt', readOnlySandbox: true },
    ]);
    expect(ro.log().filter((m) => m.answered).map((m) => m.answered)).toEqual([
      { outcome: { outcome: 'selected', optionId: 'reject_once' } },
      { outcome: { outcome: 'selected', optionId: 'reject_once' } },
    ]);
    const steer = sent(ro, '_goose/unstable/session/steer');
    expect(steer).toHaveLength(2);
    expect(steer[0]!.params).toEqual({
      sessionId: '20261110_1',
      expectedRunId: 'run_a7146587-b4d5-4f1f-b5c4-1c9f14743014',
      prompt: [{ type: 'text', text: expect.stringMatching(/^Harness Relay: Not run: the user declined "write · reject\.txt"\. Their message: name it ok\.txt/) }],
    });
    expect(ro.events.find((e) => e.type === 'tool_end' && !e.ok)).toMatchObject({ error: expect.stringContaining('name it ok.txt') });
  });

  it.skipIf(process.platform === 'win32')('refuses without asking when the conversation refuses, and never answers an "always" option', async () => {
    const r = turn({ FAKE_GOOSE_REPLAY: 'permission-reject-openai' }, { permission: 'read-only' });
    await gooseRunner(deps()).run(r.o);
    expect(r.log().filter((m) => m.answered).map((m) => m.answered.outcome.optionId)).toEqual(['reject_once']);
    expect(sent(r, '_goose/unstable/session/steer')[0]!.params.prompt[0].text).toMatch(/read-only/);
    const allowed = turn({ FAKE_GOOSE_REPLAY: 'permission-reject-openai' }, { permission: 'read-only' }, () => ({ allow: true }));
    await gooseRunner(deps()).run(allowed.o);
    expect(allowed.approvals).toEqual([{ kind: 'edit', detail: 'reject.txt', reason: 'write · reject.txt', readOnlySandbox: true }]);
    expect(allowed.log().filter((m) => m.answered).map((m) => m.answered.outcome.optionId)).toEqual(['allow_once']);
    expect(sent(allowed, '_goose/unstable/session/steer')).toEqual([]);
    // A command that only reads runs in read-only without asking.
    const reading = turn({ FAKE_GOOSE_REPLAY: 'permission-allow-openai' }, { permission: 'read-only' }, () => ({ allow: false }));
    await gooseRunner(deps()).run(reading.o);
    expect(reading.approvals).toEqual([]);
    expect(reading.log().filter((m) => m.answered).map((m) => m.answered.outcome.optionId)).toEqual(['allow_once']);
  });

  it.skipIf(process.platform === 'win32')("asks about a subagent's calls under the parent session", async () => {
    // The recorded run, with the subagent's command made one that writes.
    const file = join(root, `subagent-${++n}.jsonl`);
    writeFileSync(file, readFileSync(join(FIXTURES, 'approve-skill-subagent-openai.jsonl'), 'utf8').replaceAll('echo from-subagent', 'touch from-subagent'));
    const r = turn({ FAKE_GOOSE_REPLAY: file }, { permission: 'read-only' }, () => ({ allow: true }));
    await gooseRunner(deps()).run(r.o);
    // load_skill and delegate are reading and thinking; only the subagent's command is the user's.
    expect(r.approvals).toEqual([{ kind: 'command', detail: 'touch from-subagent', reason: 'shell · touch from-subagent', readOnlySandbox: true }]);
    expect(r.log().filter((m) => m.answered).map((m) => m.answered.outcome.optionId)).toEqual(['allow_once', 'allow_once', 'allow_once']);
  });

  it.skipIf(process.platform === 'win32')('leaves out the MCP servers it loads by itself with its whole extension list', async () => {
    const r = turn({ FAKE_GOOSE_REPLAY: 'text-openai' }, { nativeOff: ['mcp', 'plugins', 'instructions'], mcpServers: [{ name: 'probe', transport: 'stdio', command: 'node', args: [], url: '', env: {}, headers: {} }] });
    await gooseRunner(deps()).run(r.o);
    const params = sent(r, 'session/new')[0]!.params;
    expect(params.mcpServers).toEqual([{ name: 'probe', command: 'node', args: [], env: [{ name: 'HOME', value: homedir() }] }]);
    expect(params._meta.enabledExtensions.map((e: any) => e.name ?? e.server.name)).toEqual(['developer', 'analyze', 'summon', 'todo', 'probe']);
    expect(r.log().find((m) => m.start)!.env.CONTEXT_FILE_NAMES).toBe('[]');
  });

  it.skipIf(process.platform === 'win32')('cancels: Goose is told, the open row is closed, the turn says it was stopped', async () => {
    const r = turn({ FAKE_GOOSE_SCENARIO: 'hang' });
    setTimeout(() => r.abort.abort(), 600);
    await expect(gooseRunner(deps()).run(r.o)).rejects.toMatchObject({ aborted: true });
    expect(sent(r, 'session/cancel')).toEqual([{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: '20261110_1' } }]);
    expect(r.events.at(-1)).toMatchObject({ type: 'tool_end', id: 'h1', ok: false });
  });

  it.skipIf(process.platform === 'win32')('says plainly that a key was refused', async () => {
    const r = turn({ FAKE_GOOSE_SCENARIO: 'auth' }, { model: 'xai/grok-4.3' });
    await expect(withLang('en', () => gooseRunner(deps()).run(r.o))).rejects.toThrow('Goose could not sign in with the xAI API key');
  });

  it('refuses without the relay sandbox below full access, as every open agent does', async () => {
    const r = turn({ FAKE_GOOSE_REPLAY: 'text-openai' }, { permission: 'edit' });
    await expect(gooseRunner({ ...deps(), sandboxAvailable: async () => ({ ok: false, reason: 'no sandbox' }) }).run(r.o)).rejects.toThrow(/no sandbox/);
    expect(r.log()).toEqual([]);
  });

  it('passes no refusal on when no turn is running', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const conn = { request: vi.fn() } as unknown as Parameters<typeof gooseAfterRefusal>[0];
    await gooseAfterRefusal(conn, { sessionId: 's', reason: 'r' }, context());
    expect((conn as any).request).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('sets the mode when the session says nothing of it', async () => {
    const conn = { request: vi.fn(async () => ({})) } as unknown as Parameters<typeof gooseAfterSession>[0];
    const ctx = context({ permission: 'read-only' });
    await gooseAfterSession(conn, { sessionId: 's', method: 'new', state: { configOptions: [{ id: 'provider', currentValue: 'openai' }, { id: 'model', currentValue: 'gpt-5.4-mini' }] } }, ctx);
    expect((conn as any).request.mock.calls.map((c: any[]) => c[0])).toEqual(['_goose/unstable/session/system-prompt/set', 'session/set_mode']);
  });
});

describe("a resumed Goose session's own row", () => {
  const platform = (name: string) => ({ type: 'platform', name, description: '', display_name: null, bundled: true });
  const stdio = (name: string, cmd: string) => ({ type: 'stdio', name, description: '', cmd, args: [], envs: {}, env_keys: [], timeout: 300, bundled: null });
  const started = [platform('developer'), platform('analyze'), platform('summon'), platform('todo'), stdio('p1:plug', '/usr/bin/plug'), stdio('lib', '/usr/bin/lib')];
  /** Goose's sessions table as 1.58.1 makes it (the columns that matter here), with one session. */
  const sessionsDb = (state: string, extensions: unknown[], extra: Record<string, string> = {}) => {
    const file = gooseSessionsDb(state);
    mkdirSync(dirname(file), { recursive: true });
    const db = openSqliteFile(file);
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT NOT NULL, extension_data TEXT DEFAULT '{}', goose_mode TEXT NOT NULL DEFAULT 'auto',
      recipe_json TEXT, user_recipe_values_json TEXT, system_prompt_override TEXT, system_prompt_extras_json TEXT, container_id TEXT)`);
    db.prepare('INSERT INTO sessions (id, working_dir, extension_data) VALUES (?, ?, ?)').run('s1', '/p', JSON.stringify({ 'enabled_extensions.v0': { extensions }, 'todo.v0': { notes: 'kept' } }));
    for (const [column, value] of Object.entries(extra)) db.prepare(`UPDATE sessions SET "${column}" = ?`).run(value);
    db.close();
    return file;
  };
  const row = (file: string) => {
    const db = openSqliteFile(file);
    try {
      return db.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
    } finally {
      db.close();
    }
  };
  const names = (r: Record<string, unknown>) => (JSON.parse(String(r.extension_data))['enabled_extensions.v0'].extensions as { name: string }[]).map((e) => e.name);

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('keeps the list a new session started with, and puts it back before a run resumes it, with what Harness Relay never sets cleared', async () => {
    const ctx = context({ stateKey: 'conv.c1.a1' });
    const sealed = sealedFolder(ctx.home.root, 'conv.c1.a1');
    const file = sessionsDb(ctx.home.state, started);
    // Right after session/new, before the prompt: the list as Goose made it.
    const conn = { request: vi.fn(async () => ({})) } as unknown as Parameters<typeof gooseAfterSession>[0];
    await gooseAfterSession(conn, { sessionId: 's1', method: 'new', state: {} }, ctx);
    expect(JSON.parse(readFileSync(join(sealed, 'goose-extensions.json'), 'utf8'))).toEqual({ sessionId: 's1', extensions: started });
    expect(statSync(sealed).mode & 0o777).toBe(0o700);
    // A command of that run (the sandbox lets it write the database) plants a program, a platform
    // extension that runs are not given, a recipe and a system prompt.
    const db = openSqliteFile(file);
    db.prepare('UPDATE sessions SET extension_data = ?, recipe_json = ?, system_prompt_override = ?, system_prompt_extras_json = ?, container_id = ?').run(
      JSON.stringify({ 'enabled_extensions.v0': { extensions: [...started, stdio('planted', '/bin/sh'), platform('computercontroller')] }, 'todo.v0': { notes: 'kept' } }),
      '{"extensions":[]}',
      'planted',
      '{"other":"planted"}',
      'c1',
    );
    db.close();
    // The next run resumes it: Harness Relay's list again, the rest of its data kept.
    prepareGoose({ ...ctx, o: { ...ctx.o, sessionId: 's1' } }, { realHome: '/h', bash: '/bin/bash' });
    const after = row(file);
    expect(names(after)).toEqual(['developer', 'analyze', 'summon', 'todo', 'p1:plug', 'lib']);
    expect(JSON.parse(String(after.extension_data))['todo.v0']).toEqual({ notes: 'kept' });
    for (const column of GOOSE_SESSION_CLEARED) expect(after[column]).toBeNull();
    // A list sealed for another session is not this one's.
    restoreGooseSession(ctx.home.state, sealed, 's2');
    expect(names(row(file))).toEqual(['developer', 'analyze', 'summon', 'todo', 'p1:plug', 'lib']);
    // Emptied with the state folder.
    emptyStateFolder(ctx.home.root, 'conv.c1.a1');
    expect(existsSync(sealed)).toBe(false);
  });

  it("keeps only a session's own platform extensions when nothing was sealed for it, and never resumes one it cannot check", () => {
    const ctx = context({ stateKey: 'conv.c2.a1', sessionId: 's1' });
    const file = sessionsDb(ctx.home.state, [...started, stdio('planted', '/bin/sh'), platform('computercontroller')], { recipe_json: '{}' });
    prepareGoose(ctx, { realHome: '/h', bash: '/bin/bash' });
    // The tool library's servers come back with the load (`mcpServers`); a plugin's only in a new session.
    expect(names(row(file))).toEqual(['developer', 'analyze', 'summon', 'todo']);
    expect(row(file).recipe_json).toBeNull();
    // Nothing to resume: the load says so.
    expect(() => prepareGoose(context({ stateKey: 'conv.c3.a1', sessionId: 's1' }), { realHome: '/h', bash: '/bin/bash' })).not.toThrow();
    // A database it cannot read is not resumed (the orchestrator then starts a fresh session).
    const bad = context({ stateKey: 'conv.c4.a1', sessionId: 's1' });
    mkdirSync(dirname(gooseSessionsDb(bad.home.state)), { recursive: true });
    writeFileSync(gooseSessionsDb(bad.home.state), 'not a database');
    expect(() => withLang('en', () => prepareGoose(bad, { realHome: '/h', bash: '/bin/bash' }))).toThrow(/could not check the extension list Goose keeps for this session/);
    // A run without a key never resumes, so nothing is sealed for it.
    const keyless = context();
    sessionsDb(keyless.home.state, started);
    sealGooseExtensions(keyless.home.state, sealedFolder(keyless.home.root, 'x'), 'missing');
    expect(existsSync(sealedFolder(keyless.home.root, 'x'))).toBe(false);
  });

  it('drops the triggers a command planted to put the row back, and starts the state over when the row cannot be checked', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const planted = JSON.stringify({ 'enabled_extensions.v0': { extensions: [stdio('planted', '/bin/sh')] } });
    const planted_ = (file: string) => {
      const db = openSqliteFile(file);
      try {
        return db.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view')").all();
      } finally {
        db.close();
      }
    };
    // A trigger that writes the planted list back once the row is put right.
    const ctx = context({ stateKey: 'conv.c5.a1', sessionId: 's1' });
    const file = sessionsDb(ctx.home.state, [...started, stdio('planted', '/bin/sh')]);
    const db = openSqliteFile(file);
    db.exec(`CREATE TRIGGER keep AFTER UPDATE ON sessions BEGIN UPDATE sessions SET extension_data = '${planted}', recipe_json = '{}' WHERE id = NEW.id; END;
      CREATE VIEW v AS SELECT * FROM sessions;`);
    db.close();
    prepareGoose(ctx, { realHome: '/h', bash: '/bin/bash' });
    expect(names(row(file))).toEqual(['developer', 'analyze', 'summon', 'todo']);
    expect(row(file).recipe_json).toBeNull();
    expect(planted_(file)).toEqual([]);
    // Before a new session too: a trigger could change its row before it is sealed.
    const fresh = context({ stateKey: 'conv.c6.a1' });
    const other = sessionsDb(fresh.home.state, started);
    const d = openSqliteFile(other);
    d.exec(`CREATE TRIGGER seed AFTER INSERT ON sessions BEGIN UPDATE sessions SET extension_data = '${planted}' WHERE id = NEW.id; END`);
    d.close();
    prepareGoose(fresh, { realHome: '/h', bash: '/bin/bash' });
    expect(planted_(other)).toEqual([]);
    // A generated column keeps the planted list whatever is written: the state starts over, empty, and
    // the session is not resumed (the orchestrator then starts a fresh one).
    const generated = context({ stateKey: 'conv.c7.a1', sessionId: 's1' });
    const g = gooseSessionsDb(generated.home.state);
    mkdirSync(dirname(g), { recursive: true });
    const gd = openSqliteFile(g);
    gd.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT NOT NULL, extension_data TEXT GENERATED ALWAYS AS ('${planted}') VIRTUAL);
      INSERT INTO sessions (id, working_dir) VALUES ('s1', '/p');`);
    gd.close();
    const sealed = sealedFolder(generated.home.root, 'conv.c7.a1');
    mkdirSync(sealed, { recursive: true });
    writeFileSync(join(sealed, 'goose-extensions.json'), JSON.stringify({ sessionId: 's1', extensions: started }));
    expect(() => withLang('en', () => prepareGoose(generated, { realHome: '/h', bash: '/bin/bash' }))).toThrow(/could not check the extension list Goose keeps for this session/);
    expect(existsSync(g)).toBe(false);
    expect(readdirSync(generated.home.state)).toEqual([]);
    expect(existsSync(sealed)).toBe(false);
    warn.mockRestore();
  });
});

// Its stand-in CLI is a script, and Windows starts only real programs (`.exe`): tried on macOS and Linux.
describe("asking Goose outside a run", () => {
  const env = (fake: Record<string, string> = {}) => {
    const dir = join(root, `ask-${++n}`);
    return { PATH: process.env.PATH, [OPEN_AGENT_HOME_ENV]: join(dir, 'home'), FAKE_GOOSE_LOG: join(dir, 'log.jsonl'), FAKE_GOOSE_FIXTURES: FIXTURES, ...fake };
  };

  it.skipIf(process.platform === 'win32')('lists its catalog without a session or a key', async () => {
    const catalog = await gooseModels(fakeBin, env());
    expect(catalog.models.length).toBeGreaterThan(60);
    expect(catalog.models.map((m) => m.id)).toContain('anthropic/claude-haiku-5-5');
    await expect(gooseModels(fakeBin, env({ FAKE_GOOSE_LIST_FAIL: '1' }))).rejects.toThrow('list failed');
    await expect(gooseAgent.models!(join(root, 'no-such-goose'), env())).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('says what it loads by itself for a folder', async () => {
    const e = env();
    const cwd = join(root, `native-cwd-${++n}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'AGENTS.md'), 'x');
    const probe = await gooseAgent.native!(fakeBin, e, cwd);
    expect(probe).toMatchObject({ provider: 'goose', cwd, memoryFromFiles: true, asRun: false, problems: [], plugins: [], hooks: [], mcpServers: [] });
    expect(probe.skills.map((s) => s.name)).toContain('proj-skill');
    expect(probe.memory).toEqual([{ path: join(cwd, 'AGENTS.md'), kind: 'instructions' }]);
    const failed = await gooseNative(fakeBin, env({ FAKE_GOOSE_LIST_FAIL: '1' }), cwd);
    expect(failed.problems).toEqual([{ kind: 'failed', detail: 'list failed' }]);
    expect(failed.skills).toEqual([]);
  });

  it('runs as the generic ACP turn with its own runner', () => {
    expect(gooseAgent.provider).toBe('goose');
    expect(gooseAgent.efforts).toEqual(GOOSE_EFFORTS);
    expect(gooseAcp.implemented).toBe(true);
    expect(gooseAcp.args({} as OpenRunContext)).toEqual(['acp']);
    expect(defaultAcpDeps.timeoutMs).toBeGreaterThan(0);
  });
});
