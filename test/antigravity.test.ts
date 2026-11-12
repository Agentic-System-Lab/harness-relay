import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_NOTES,
  ANTIGRAVITY_RUN_PREFIX,
  antigravityAppDir,
  antigravityApprovalRequest,
  antigravityArgs,
  antigravityBriefing,
  antigravityCommandOutput,
  antigravityEffortOption,
  antigravityGeminiDir,
  antigravityLogout,
  antigravityPermissionDecision,
  antigravityProbeEnv,
  antigravityPromptText,
  antigravityRunSettings,
  antigravityRunner,
  antigravitySessionMeta,
  createAntigravityUpdateHandler,
  prepareAntigravityRun,
  type AntigravityToolCall,
} from '../src/server/agents/antigravity';
import { AgentRunError, type AgentEvent, type ApprovalRequest, type RunOptions } from '../src/server/agents/types';
import { t, withLang } from '../src/server/i18n';
import { antigravityDefaultModel, parseAntigravityModels } from '../src/server/models';
import { antigravityMcpServers, antigravityMemoryFiles, parseAntigravityProbe } from '../src/server/native';
import { ANTIGRAVITY_HOME_ENV } from '../src/server/settings';
import type { ApprovalAnswer } from '../src/shared/types';
import { writeFakeAntigravity } from './fake-antigravity';

/*
 * The Antigravity adapter (src/server/agents/antigravity.ts), against messages the real `agy acp`
 * (1.5.6) sent when Harness Relay's adapter drove it on a Gemini API key, with a stand-in for the Gemini
 * API (test/fixtures/antigravity/, scrubbed: the working directory is /work/app), replayed through a
 * stand-in (test/fake-antigravity.ts). Its listings (`agy models`, `-p /skills`…) are recorded too
 * (test/fixtures/antigravity/cli/).
 */
const FIX = fileURLToPath(new URL('./fixtures/antigravity/', import.meta.url));
const CLI = join(FIX, 'cli');
const CWD = '/work/app';

const rows = (name: string) =>
  readFileSync(join(FIX, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);

/** The session updates a recording's agent sent, in order. */
const updatesOf = (name: string) => rows(name).flatMap((r) => (r.dir === 'agent->client' && r.msg?.method === 'session/update' ? [r.msg.params.update] : []));

describe('Antigravity permission policy (it has no sandbox Harness Relay uses)', () => {
  const read = (path: string): AntigravityToolCall => ({ name: 'read_file', kind: 'read', title: 'File x', rawInput: { Path: path }, locations: [{ path }] });
  const write = (path: string): AntigravityToolCall => ({ name: 'write_file', kind: 'edit', title: 'File x', rawInput: { Path: path, Content: 'x' }, locations: [{ path }] });
  const command: AntigravityToolCall = { name: 'run_command', kind: 'execute', title: 'ls', rawInput: { CommandLine: 'ls', toolSummary: 'List' } };

  it('read-only: runs reads (inside the working directory or not) and web searches, asks about writes, commands and anything else', () => {
    expect(antigravityPermissionDecision('read-only', read('/work/app/a.ts'), CWD)).toEqual({ run: 'allow' });
    expect(antigravityPermissionDecision('read-only', read('/etc/hosts'), CWD)).toEqual({ run: 'allow' });
    expect(antigravityPermissionDecision('read-only', { name: 'search_web', kind: 'search', title: '"x" on Web', rawInput: { query: 'x' } }, CWD)).toEqual({ run: 'allow' });
    expect(antigravityPermissionDecision('read-only', write('/work/app/a.ts'), CWD)).toEqual({ run: 'ask' });
    expect(antigravityPermissionDecision('read-only', command, CWD)).toEqual({ run: 'ask' });
    expect(antigravityPermissionDecision('read-only', { name: 'invoke_subagent', kind: 'other', title: 'Run invoke_subagent' }, CWD)).toEqual({ run: 'ask' });
    // A search of files runs where it says where it searches; one that does not say could be of a protected folder.
    expect(antigravityPermissionDecision('read-only', { name: 'grep_search', kind: 'search', rawInput: { SearchPath: '/work/app/src', Query: 'TODO' } }, CWD)).toEqual({ run: 'allow' });
    expect(antigravityPermissionDecision('read-only', { name: 'grep_search', kind: 'search', rawInput: { Query: 'TODO' } }, CWD)).toEqual({ run: 'ask' });
    expect(antigravityPermissionDecision('read-only', { name: 'grep_search', kind: 'search', rawInput: { SearchPath: '/home/user/Library/Cookies' } }, CWD, [], ['/home/user/Library/Cookies']).run).toBe('refuse');
  });

  it('refuses a read or write of a protected path below full access, without asking', () => {
    const shield = ['/home/user/Library/Cookies'];
    for (const p of ['read-only', 'edit'] as const) {
      expect(antigravityPermissionDecision(p, read('/home/user/Library/Cookies/Default/Cookies'), CWD, [], shield)).toEqual({ run: 'refuse', reason: t().antigravityProtected });
      expect(antigravityPermissionDecision(p, write('/home/user/Library/Cookies/x'), CWD, [], shield).run).toBe('refuse');
    }
    expect(antigravityPermissionDecision('full', read('/home/user/Library/Cookies/Default/Cookies'), CWD, [], shield)).toEqual({ run: 'allow' });
  });

  it("edit: writes in the chat's working directories run; elsewhere, and where a write could change how agents run, they ask", () => {
    expect(antigravityPermissionDecision('edit', write('/work/app/src/a.ts'), CWD)).toEqual({ run: 'allow' });
    expect(antigravityPermissionDecision('edit', write('/work/lib/b.ts'), CWD, ['/work/lib'])).toEqual({ run: 'allow' });
    expect(antigravityPermissionDecision('edit', write('/work/other/c.ts'), CWD, ['/work/lib'])).toEqual({ run: 'ask' });
    expect(antigravityPermissionDecision('edit', write('~/notes.txt'), CWD)).toEqual({ run: 'ask' });
    for (const p of ['.agents/hooks.json', '.agent/mcp_config.json', '_agents/hooks.json', '.gemini/settings.json', '.git/hooks/pre-commit', '.git/config', '.vscode/tasks.json', '.claude/settings.json', 'sub/.cursor/mcp.json', '.mcp.json']) {
      expect(antigravityPermissionDecision('edit', write(`/work/app/${p}`), CWD), p).toEqual({ run: 'ask' });
    }
    expect(antigravityPermissionDecision('edit', write('/work/app/.git/objects/ab/cd'), CWD)).toEqual({ run: 'allow' });
    expect(antigravityPermissionDecision('edit', command, CWD)).toEqual({ run: 'ask' });
  });

  it.skipIf(process.platform === 'win32')('edit: takes a link out of the working directory for where it leads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-agy-link-'));
    try {
      mkdirSync(join(dir, 'app'));
      mkdirSync(join(dir, 'outside'));
      symlinkSync(join(dir, 'outside'), join(dir, 'app', 'out'));
      expect(antigravityPermissionDecision('edit', write(join(dir, 'app', 'out', 'x.ts')), join(dir, 'app'))).toEqual({ run: 'ask' });
      expect(antigravityPermissionDecision('edit', write(join(dir, 'app', 'in.ts')), join(dir, 'app'))).toEqual({ run: 'allow' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('full: approves everything', () => {
    for (const call of [command, write('/elsewhere/x'), { kind: 'other', name: 'swarm' }]) expect(antigravityPermissionDecision('full', call, CWD)).toEqual({ run: 'allow' });
  });

  it('describes what it asks about: a command runs outside any sandbox once allowed, and a write says why it asks', () => {
    expect(antigravityApprovalRequest('edit', command, CWD)).toEqual({ kind: 'command', detail: 'ls', reason: 'List', outsideSandbox: true });
    expect(antigravityApprovalRequest('edit', write('/elsewhere/x.ts'), CWD)).toEqual({ kind: 'edit', detail: '/elsewhere/x.ts', reason: t().antigravityOutsideWrite });
    expect(antigravityApprovalRequest('edit', write('/work/app/.agents/hooks.json'), CWD)).toEqual({ kind: 'edit', detail: '/work/app/.agents/hooks.json', reason: t().antigravityConfigWrite });
    expect(antigravityApprovalRequest('read-only', write('/work/app/a.ts'), CWD)).toEqual({ kind: 'edit', detail: '/work/app/a.ts', reason: 'File x' });
    expect(antigravityApprovalRequest('read-only', { name: 'invoke_subagent', kind: 'other', title: 'Run invoke_subagent', rawInput: { prompt: 'Look around' } }, CWD)).toEqual({
      kind: 'other',
      tool: 'invoke_subagent',
      detail: 'Look around',
      reason: 'Run invoke_subagent',
    });
  });
});

describe('Antigravity session updates', () => {
  const play = (name: string, refused: [string, string][] = []) => {
    const events: AgentEvent[] = [];
    const h = createAntigravityUpdateHandler((e) => events.push(e));
    for (const [id, label] of refused) h.refused(id, label);
    for (const u of updatesOf(name)) h.handle(u);
    h.finish();
    return events;
  };

  it("streams its thinking and reply, and shows each call once, with a command's output and a non-zero exit code as failed", () => {
    const events = withLang('en', () => play('edit'));
    expect(events.filter((e) => e.type !== 'tool_start' && e.type !== 'tool_end')).toEqual([
      { type: 'thinking', text: '**Looking around**\nI will list the files first.' },
      { type: 'text', text: 'Let me look.' },
      { type: 'text_end' },
      { type: 'text', text: 'Done: wrote hello.txt.' },
      { type: 'text_end' },
    ]);
    const tools = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end');
    expect(tools.map((e) => (e.type === 'tool_start' ? [e.type, e.name, e.detail] : [e.type, e.ok, e.error, e.output]))).toEqual([
      ['tool_start', 'Shell', 'ls'],
      ['tool_end', true, undefined, 'notes.txt'],
      ['tool_start', 'Edit', '/work/app/hello.txt'],
      ['tool_end', true, undefined, undefined],
      ['tool_start', 'Read', '/work/app/notes.txt'],
      ['tool_end', true, undefined, undefined],
      ['tool_start', 'Shell', 'false'],
      ['tool_end', false, 'exit code 1', undefined],
    ]);
  });

  it('shows why a call was refused, and keeps the rows of a stopped call', () => {
    const id = updatesOf('ro-deny').find((u) => u.sessionUpdate === 'tool_call')!.toolCallId;
    const events = play('ro-deny', [[id, 'Declined']]);
    expect(events.find((e) => e.type === 'tool_end')).toEqual({ type: 'tool_end', id, ok: false, error: 'Declined' });
    const stopped = play('abort');
    expect(stopped.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false });
  });

  it('gives a call it reports only once it is over its row too', () => {
    const events: AgentEvent[] = [];
    const h = createAntigravityUpdateHandler((e) => events.push(e));
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'r1', name: 'read_file', kind: 'read', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'no such file' } }] });
    expect(events).toEqual([
      { type: 'tool_start', id: 'r1', name: 'Read' },
      { type: 'tool_end', id: 'r1', ok: false, error: 'no such file' },
    ]);
  });

  it("keeps a command's output without the lines agy puts first", () => {
    expect(antigravityCommandOutput('Created At: 2026\nCompleted At: 2026\nCommand exited with code 0.\n\nCommand output:\nline 1\r\nline 2\r\n')).toBe('line 1\nline 2\n');
    expect(antigravityCommandOutput('Created At: 2026\nCompleted At: 2026\nCommand exited with code 1.\n\nNo output from the command.')).toBe('');
  });
});

describe("Antigravity's settings and home for one run", () => {
  let root: string;
  beforeAll(() => (root = mkdtempSync(join(tmpdir(), 'relay-agy-run-'))));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("keeps the account's own settings, asks about everything below full access, and uses a Gemini API key when it has one", () => {
    const own = { model: 'gemini-4-argon-high', toolPermission: 'always-proceed', agentMode: 'accept-edits', colorScheme: 'dark' };
    expect(antigravityRunSettings(own, 'edit', false)).toEqual({ model: 'gemini-4-argon-high', toolPermission: 'request-review', agentMode: '', colorScheme: 'dark' });
    expect(antigravityRunSettings(own, 'read-only', true)).toMatchObject({ toolPermission: 'request-review', modelProvider: 'gemini' });
    expect(antigravityRunSettings(undefined, 'full', false)).toEqual({ toolPermission: 'always-proceed', agentMode: '' });
    expect(antigravityRunSettings([1, 2], 'edit', false)).toEqual({ toolPermission: 'request-review', agentMode: '' });
  });

  it.skipIf(process.platform === 'win32')("writes them in a folder of the run's own (owner only) in the account's CLI folder, removed after it, the account's own file left as it was", () => {
    const app = join(root, 'acct', '.gemini', 'antigravity-cli');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'settings.json'), JSON.stringify({ toolPermission: 'proceed-in-sandbox' }));
    const run = prepareAntigravityRun(app, 'edit', true);
    expect(run.name.startsWith(ANTIGRAVITY_RUN_PREFIX)).toBe(true);
    expect(statSync(run.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(run.dir, 'settings.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(run.dir, 'settings.json'), 'utf8'))).toEqual({ toolPermission: 'request-review', agentMode: '', modelProvider: 'gemini' });
    expect(JSON.parse(readFileSync(join(app, 'settings.json'), 'utf8'))).toEqual({ toolPermission: 'proceed-in-sandbox' });
    run.done();
    expect(existsSync(run.dir)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('removes the folders of runs the server was stopped during, once older than a turn may last', () => {
    const app = join(root, 'left', '.gemini', 'antigravity-cli');
    const old = join(app, `${ANTIGRAVITY_RUN_PREFIX}000000000000`);
    const recent = join(app, `${ANTIGRAVITY_RUN_PREFIX}111111111111`);
    mkdirSync(old, { recursive: true });
    mkdirSync(recent, { recursive: true });
    const long = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(old, long, long);
    const run = prepareAntigravityRun(app, 'edit', false);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true); // another Harness Relay on the same home may be running it
    run.done();
  });

  it("starts agy acp in the account's home, its own settings folder, and asks about nothing with full access", () => {
    const env = { [ANTIGRAVITY_HOME_ENV]: '/data/accounts/antigravity-a1' };
    expect(antigravityArgs(env, 'edit', 'harness-relay-x')).toEqual(['acp', '--gemini-dir', join('/data/accounts/antigravity-a1', '.gemini'), '--cli_dir_name', 'harness-relay-x']);
    expect(antigravityArgs({}, 'full', 'harness-relay-x')).toEqual(['acp', '--cli_dir_name', 'harness-relay-x', '--dangerously-skip-permissions']);
    expect(antigravityGeminiDir({}, '/home/me')).toBe(join('/home/me', '.gemini'));
    expect(antigravityAppDir(env)).toBe(join('/data/accounts/antigravity-a1', '.gemini', 'antigravity-cli'));
  });

  it("asks it things with the account's home as HOME (USERPROFILE on Windows), and with no browser opened", () => {
    const env = antigravityProbeEnv({ PATH: '/bin', HOME: '/home/me', [ANTIGRAVITY_HOME_ENV]: '/data/a1' }, 'darwin');
    expect(env).toEqual({ PATH: '/bin', HOME: '/data/a1', SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0' });
    expect(antigravityProbeEnv({ USERPROFILE: 'C:\\Users\\me', [ANTIGRAVITY_HOME_ENV]: 'D:\\a1' }, 'win32').USERPROFILE).toBe('D:\\a1');
    expect(antigravityProbeEnv({ HOME: '/home/me' }, 'linux').HOME).toBe('/home/me');
  });
});

describe('the briefing, in its system prompt', () => {
  it('goes into a new session, and into a resumed one only when it changed (each one sent is added)', () => {
    const meta = antigravitySessionMeta('Be @Ada.') as any;
    const text = meta.antigravity.systemPrompt.append as string;
    expect(text).toContain('<harness-relay-briefing>');
    expect(text).toContain('Be @Ada.');
    expect(text).toContain(ANTIGRAVITY_NOTES);
    expect(text).toBe(antigravityBriefing('Be @Ada.'));
    const hash = createHash('sha256').update('Be @Ada.').digest('hex');
    expect(antigravitySessionMeta('Be @Ada.', hash)).toBeUndefined();
    expect(antigravitySessionMeta('Be @Bob.', hash)).toBeDefined();
    expect(antigravitySessionMeta('  ')).toBeUndefined();
  });

  it('goes on top of the prompt when agy does not take it in its system prompt', () => {
    expect(antigravityPromptText('Hi', 'Be @Ada.')).toBe(`${antigravityBriefing('Be @Ada.')}\n\nHi`);
    expect(antigravityPromptText('Hi', '')).toBe('Hi');
  });

  it("tells the model that a refusal ends its turn, and to ask the user Harness Relay's way", () => {
    expect(ANTIGRAVITY_NOTES).toMatch(/ends your turn/);
    expect(ANTIGRAVITY_NOTES).toMatch(/ask_question/);
  });
});

describe("Antigravity's models and what it loads by itself", () => {
  it('reads each model by its base id, with the thinking levels its ids end in', () => {
    const models = parseAntigravityModels(readFileSync(join(CLI, 'models.txt'), 'utf8'));
    expect(models[0]).toEqual({ id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] });
    expect(models.map((m) => m.id)).toEqual(['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-pro']);
    expect(models.at(-1)).toEqual({ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', efforts: ['low', 'high'] });
    expect(parseAntigravityModels(readFileSync(join(CLI, 'models-signed-out.txt'), 'utf8'))).toEqual([]);
    expect(parseAntigravityModels('gemini-x\tGemini X\n')).toEqual([{ id: 'gemini-x', label: 'Gemini X' }]);
  });

  it("takes the account's default model, with its thinking level when its id carries one", () => {
    const models = parseAntigravityModels(readFileSync(join(CLI, 'models.txt'), 'utf8'));
    expect(antigravityDefaultModel('gemini-4-argon-high', models)).toEqual({ model: 'gemini-4-argon', effort: 'high' });
    expect(antigravityDefaultModel('gemini-3.8-flash', models)).toEqual({ model: 'gemini-3.8-flash' });
    expect(antigravityDefaultModel('Gemini 4 Argon (High)', models)).toEqual({});
    expect(antigravityDefaultModel(undefined, models)).toEqual({});
  });

  it('sets only a thinking level the session offers, not an on/off switch', () => {
    expect(antigravityEffortOption([{ id: 'thought_level', category: 'thought_level', options: [{ value: 'low' }, { value: 'high' }] }])?.id).toBe('thought_level');
    expect(antigravityEffortOption([{ id: 'thinking', category: 'thought_level', options: [{ value: 'true' }, { value: 'false' }] }])).toBeUndefined();
  });

  it('lists its skills, hooks (never their commands), custom agents and plugins from its own answers', () => {
    const json = (name: string) => JSON.parse(readFileSync(join(CLI, `${name}.json`), 'utf8'));
    // A repository of its own as the working directory: where a skill comes from is told by the folders
    // up to the repository's root, which must not depend on what this computer has above the test.
    const repo = mkdtempSync(join(tmpdir(), 'relay-agy-repo-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'app'));
    let lists: ReturnType<typeof parseAntigravityProbe>;
    try {
      lists = parseAntigravityProbe(
        { skills: json('skills').command.data, hooks: json('hooks').command.data, agents: json('agents').command.data, plugins: json('plugins') },
        join(repo, 'app'),
        '/home/user/.gemini',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
    expect(lists.skills.find((s) => s.name === 'demo-skill')).toEqual({ name: 'demo-skill', description: 'A demo skill.', source: 'user', path: '/home/user/.gemini/config/skills/demo-skill/SKILL.md' });
    expect(lists.skills.find((s) => s.name === 'agy-customizations')?.source).toBe('built-in');
    expect(lists.hooks).toEqual([{ event: 'PostToolUse', matcher: 'run_command', source: 'lint', file: '/home/user/.gemini/config/hooks.json' }]);
    expect(JSON.stringify(lists.hooks)).not.toContain('echo hi');
    expect(lists.agents).toEqual([{ name: 'reviewer', description: '' }]);
    expect(lists.plugins).toEqual([]);
  });

  it("lists its MCP servers (names only) and instruction files from the files it reads, the project's first", () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-agy-native-'));
    try {
      const repo = join(root, 'repo');
      const cwd = join(repo, 'pkg');
      const gemini = join(root, 'home', '.gemini');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(cwd, '.agents', 'rules'), { recursive: true });
      mkdirSync(join(gemini, 'config'), { recursive: true });
      writeFileSync(join(gemini, 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['x'], env: { TOKEN: 'secret' } }, web: { serverUrl: 'https://x', disabled: true } } }));
      writeFileSync(join(cwd, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { docs: { command: 'project-docs' } } }));
      writeFileSync(join(repo, 'GEMINI.md'), '# repo');
      writeFileSync(join(cwd, 'AGENTS.md'), '# pkg');
      writeFileSync(join(cwd, '.agents', 'rules', 'style.md'), '# style');
      writeFileSync(join(root, 'GEMINI.md'), '# above the repository: not read');
      expect(antigravityMcpServers(cwd, gemini)).toEqual([
        { name: 'docs', transport: 'stdio', source: 'project' },
        { name: 'web', transport: 'http', source: 'user', enabled: false, status: 'disabled' },
      ]);
      expect(JSON.stringify(antigravityMcpServers(cwd, gemini))).not.toContain('secret');
      expect(antigravityMemoryFiles(cwd).map((f) => f.path)).toEqual([join(repo, 'GEMINI.md'), join(cwd, 'AGENTS.md'), join(cwd, '.agents', 'rules', 'style.md')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('an Antigravity turn (with a stand-in agy replaying recorded messages)', () => {
  let root: string;
  let bin: string;
  let n = 0;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-agy-'));
    bin = writeFakeAntigravity(join(root, 'agy'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  interface Run {
    o: RunOptions;
    events: AgentEvent[];
    approvals: ApprovalRequest[];
    abort: AbortController;
    log: () => Record<string, any>[];
    home: string;
  }

  function run(fixture: string | undefined, over: Partial<RunOptions> = {}, answer?: (req: ApprovalRequest) => ApprovalAnswer): Run {
    const dir = join(root, `run-${++n}`);
    const cwd = join(dir, 'app');
    const home = join(dir, 'home');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    const logFile = join(dir, 'log.jsonl');
    const events: AgentEvent[] = [];
    const approvals: ApprovalRequest[] = [];
    const abort = new AbortController();
    const o: RunOptions = {
      bin,
      env: {
        PATH: process.env.PATH,
        FAKE_AGY_LOG: logFile,
        FAKE_AGY_CWD: cwd,
        ...(fixture ? { FAKE_AGY_FIXTURE: join(FIX, `${fixture}.jsonl`) } : {}),
        [ANTIGRAVITY_HOME_ENV]: home,
        GEMINI_API_KEY: 'AIza-test-0000',
      },
      prompt: 'Write hello.txt',
      systemPrompt: 'You are @Ada on a team.',
      cwd,
      permission: 'edit',
      signal: abort.signal,
      onEvent: (e) => events.push(e),
      protectedPaths: ['/home/user/Library/Cookies'],
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
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as Record<string, any>)
        : [];
    return { o, events, approvals, abort, log, home };
  }

  const methods = (r: Run) => r.log().flatMap((l) => (typeof l.method === 'string' ? [l.method] : []));
  const sent = (r: Run, method: string) => r.log().find((l) => l.method === method);

  it("runs a turn in its own settings, sets the model and thinking level, briefs it in its system prompt, and asks about each command", async () => {
    const r = run('edit', { model: 'gemini-3.8-flash', effort: 'high' }, () => ({ allow: true }));
    const result = await withLang('en', () => antigravityRunner.run(r.o));
    expect(result).toEqual({ sessionId: 'c3471ccd-1a6e-4152-ad72-1baf7443ff46', inputTokens: 500, outputTokens: 100 });
    const start = r.log()[0]!;
    expect(start.argv).toEqual(['acp', '--gemini-dir', join(r.home, '.gemini'), '--cli_dir_name', expect.stringMatching(/^harness-relay-[0-9a-f]{12}$/)]);
    expect(start.cwd).toBe(r.o.cwd.startsWith('/var/') ? `/private${r.o.cwd}` : r.o.cwd);
    // Its home is passed as a flag, not as a variable of its own, and no variable of Harness Relay's reaches it.
    expect(start.env).toMatchObject({ HARNESS_RELAY_ANTIGRAVITY_HOME: null, GEMINI_API_KEY: 'AIza-test-0000' });
    expect(start.settings).toEqual({ toolPermission: 'request-review', agentMode: '', modelProvider: 'gemini' });
    // The run's settings folder is gone with the run.
    expect(readdirSync(join(r.home, '.gemini', 'antigravity-cli')).filter((f) => f.startsWith(ANTIGRAVITY_RUN_PREFIX))).toEqual([]);
    expect(methods(r)).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt']);
    const opened = sent(r, 'session/new')!.params;
    expect(opened._meta.antigravity.systemPrompt.append).toContain('You are @Ada on a team.');
    expect(opened.cwd).toBe(r.o.cwd);
    const options = r.log().filter((l) => l.method === 'session/set_config_option').map((l) => [l.params.configId, l.params.value]);
    expect(options).toEqual([
      ['model', 'gemini-3.8-flash'],
      ['thought_level', 'high'],
    ]);
    // Commands asked (they run outside any sandbox), the write in the working directory ran without asking.
    expect(r.approvals).toEqual([
      { kind: 'command', detail: 'ls', reason: 'List the files', outsideSandbox: true },
      { kind: 'command', detail: 'false', reason: 'Fail on purpose', outsideSandbox: true },
    ]);
    const answers = r.log().filter((l) => l.result?.outcome).map((l) => l.result.outcome.optionId);
    expect(answers).toEqual(['allow', 'allow', 'allow']);
    expect(r.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Let me look.', 'Done: wrote hello.txt.']);
  });

  it('resumes a session, briefing it again only when the briefing changed', async () => {
    const first = run('resume', { sessionId: 'c3471ccd-1a6e-4152-ad72-1baf7443ff46', prompt: 'And again', systemPrompt: 'Brief A.' }, () => ({ allow: true }));
    await antigravityRunner.run(first.o);
    expect(sent(first, 'session/resume')!.params).toMatchObject({ sessionId: 'c3471ccd-1a6e-4152-ad72-1baf7443ff46', cwd: first.o.cwd });
    expect(sent(first, 'session/resume')!.params._meta).toBeDefined(); // the session was given another one
    const again = run('resume', { sessionId: 'c3471ccd-1a6e-4152-ad72-1baf7443ff46', prompt: 'And again', systemPrompt: 'Brief A.' }, () => ({ allow: true }));
    await antigravityRunner.run(again.o);
    expect(sent(again, 'session/resume')!.params._meta).toBeUndefined();
    const changed = run('resume', { sessionId: 'c3471ccd-1a6e-4152-ad72-1baf7443ff46', prompt: 'And again', systemPrompt: 'Brief B.' }, () => ({ allow: true }));
    await antigravityRunner.run(changed.o);
    expect(sent(changed, 'session/resume')!.params._meta.antigravity.systemPrompt.append).toContain('Brief B.');
  });

  it('asks about a write in read-only mode; a refusal shows its note, and agy ends the turn there', async () => {
    const r = run('ro-deny', { permission: 'read-only', prompt: 'Write ro.txt' }, () => ({ allow: false, note: 'Not now' }));
    await withLang('en', () => antigravityRunner.run(r.o));
    expect(r.approvals.map((a) => [a.kind, a.detail])).toEqual([['edit', join(r.o.cwd, 'ro.txt')]]);
    expect(r.log().find((l) => l.result?.outcome)?.result.outcome.optionId).toBe('deny');
    const end = r.events.find((e) => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>;
    expect(end).toMatchObject({ ok: false, error: `${withLang('en', () => t().approvalDeclined)} Not now${withLang('en', () => t().antigravityEndsTurn)}` });
    expect(r.events.some((e) => e.type === 'text' && e.text.includes('Should not be reached'))).toBe(false);
  });

  it('refuses by itself what the permission does not cover when the conversation refuses approvals', async () => {
    const r = run('ro-auto', { permission: 'read-only', prompt: 'touch' });
    await withLang('en', () => antigravityRunner.run(r.o));
    expect(r.log().find((l) => l.result?.outcome)?.result.outcome.optionId).toBe('deny');
    expect(r.events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false, error: `${withLang('en', () => t().antigravityRefused)}${withLang('en', () => t().antigravityEndsTurn)}` });
  });

  it('refuses a protected path without asking', async () => {
    const r = run('protected', { prompt: 'read cookies' }, () => ({ allow: true }));
    await withLang('en', () => antigravityRunner.run(r.o));
    expect(r.approvals).toEqual([]);
    expect(r.log().find((l) => l.result?.outcome)?.result.outcome.optionId).toBe('deny');
    expect(r.events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false, error: expect.stringContaining(withLang('en', () => t().antigravityProtected)) });
  });

  it('runs everything with full access, asking nothing', async () => {
    const r = run('full', { permission: 'full', prompt: 'go' }, () => ({ allow: false }));
    await antigravityRunner.run(r.o);
    const start = r.log()[0]!;
    expect(start.argv).toContain('--dangerously-skip-permissions');
    expect(start.settings).toMatchObject({ toolPermission: 'always-proceed' });
    expect(r.approvals).toEqual([]);
  });

  it('says to sign in when agy is not signed in', async () => {
    const r = run('signedout', { prompt: 'hi' });
    delete r.o.env.GEMINI_API_KEY;
    await expect(withLang('en', () => antigravityRunner.run(r.o))).rejects.toThrow(withLang('en', () => t().antigravitySignIn('Authentication required')));
  });

  it('stops a turn: it cancels the session, and the run ends as stopped', async () => {
    const r = run('abort', { permission: 'full', prompt: 'wait' });
    r.o.onEvent = (e) => {
      r.events.push(e);
      if (e.type === 'tool_start') r.abort.abort();
    };
    const err = (await antigravityRunner.run(r.o).catch((e: unknown) => e)) as AgentRunError;
    expect(err).toBeInstanceOf(AgentRunError);
    expect(err.aborted).toBe(true);
    expect(methods(r)).toContain('session/cancel');
  });

  it("does not start when the run's settings folder cannot be made", async () => {
    const r = run('edit');
    const app = join(r.home, '.gemini', 'antigravity-cli');
    rmSync(app, { recursive: true });
    writeFileSync(app, 'not a folder');
    await expect(withLang('en', () => antigravityRunner.run(r.o))).rejects.toThrow(/Could not prepare Antigravity's settings/);
    expect(r.log()).toEqual([]);
  });

  it('asks agy for its models and what it loads in the account\'s home, telling it to use a Gemini API key when there is one', async () => {
    const { discoverModels } = await import('../src/server/models');
    const { NativeSetupService } = await import('../src/server/native');
    const r = run(undefined);
    const env = { ...r.o.env, FAKE_AGY_CLI: CLI };
    const keyed = await discoverModels('antigravity', bin, env);
    expect(keyed.models.map((m) => m.id)).toContain('gemini-4-argon');
    const signedOut = await discoverModels('antigravity', bin, { ...env, GEMINI_API_KEY: '', FAKE_AGY_MODELS: 'models-signed-out.txt' });
    expect(signedOut.models).toEqual([]);
    expect(signedOut.error).toContain('Please sign in');
    const probe = await new NativeSetupService({ env: () => env, bin: () => bin } as never).get('antigravity', r.o.cwd);
    expect(probe.skills.some((x) => x.name === 'demo-skill')).toBe(true);
    expect(probe.problems).toEqual([]);
    const starts = r.log().filter((l) => l.start);
    const settings = JSON.stringify({ modelProvider: 'gemini' });
    expect(starts.filter((l) => l.argv.includes('models')).map((l) => l.argv)).toEqual([['--settings', settings, 'models'], ['models']]);
    expect(starts.filter((l) => l.argv[0] === '-p').map((l) => l.argv.slice(1))).toEqual(
      expect.arrayContaining([['/skills', '--output-format', 'json', '--settings', settings]]),
    );
    expect(starts.every((l) => l.env.HOME === r.home && l.env.SSH_CONNECTION)).toBe(true);
  });

  it("signs out with agy's ACP logout, in the account's home", async () => {
    const r = run(undefined);
    await antigravityLogout(bin, r.o.env, 10_000);
    expect(methods(r)).toEqual(['initialize', 'logout']);
    expect(r.log()[0]!.argv).toEqual(['acp', '--gemini-dir', join(r.home, '.gemini')]);
    expect(r.log()[0]!.env.SSH_CONNECTION).toBeTruthy();
  });
});
