import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_NOTES,
  antigravityProjectFiles,
  antigravityProjectFingerprint,
  commandGroups,
  elapsedSeconds,
  parseProcs,
  strayProcs,
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

  it("edit: asks about agents' config in any letter case (macOS and Windows ignore it), a submodule's git hooks, and the other dangerous files", () => {
    for (const p of ['.Claude/settings.json', '.AGENTS/mcp_config.json', '.Vscode/tasks.json', '.MCP.json', '.Gemini/x', '.git/modules/lib/hooks/pre-commit', '.git/modules/a/b/config', '.GIT/HOOKS/x', '.idea/workspace.xml', '.gitmodules', '.envrc', '.claude./settings.json']) {
      expect(antigravityPermissionDecision('edit', write(`/work/app/${p}`), CWD), p).toEqual({ run: 'ask' });
    }
    expect(antigravityPermissionDecision('edit', write('/work/app/docs/agents.md'), CWD)).toEqual({ run: 'allow' });
    expect(antigravityPermissionDecision('edit', write('/work/app/.git/modules/lib/objects/ab'), CWD)).toEqual({ run: 'allow' });
  });

  it('checks every path a call names, and asks about a read whose path it cannot tell', () => {
    const shield = ['/home/user/Library/Cookies'];
    // A call about two files: one protected, or one outside the working directory, decides for both.
    const two = (a: string, b: string): AntigravityToolCall => ({ name: 'edit_file', kind: 'edit', rawInput: { Path: a }, locations: [{ path: a }, { path: b }] });
    expect(antigravityPermissionDecision('edit', two('/work/app/a.ts', '/home/user/Library/Cookies/c'), CWD, [], shield).run).toBe('refuse');
    expect(antigravityPermissionDecision('edit', two('/work/app/a.ts', '/elsewhere/b.ts'), CWD).run).toBe('ask');
    expect(antigravityPermissionDecision('edit', two('/work/app/a.ts', '/work/app/b.ts'), CWD).run).toBe('allow');
    expect(antigravityPermissionDecision('read-only', { kind: 'read', name: 'read_file', rawInput: { Source: '/home/user/Library/Cookies/x' } }, CWD, [], shield).run).toBe('refuse');
    expect(antigravityPermissionDecision('read-only', { kind: 'read', name: 'read_file', rawInput: { Something: '/x' } }, CWD)).toEqual({ run: 'ask' });
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

  it("keeps only the account's model and service, asks about everything below full access, and uses a Gemini API key when it has one", () => {
    const own = {
      model: 'gemini-4-argon-high',
      gcp: { project: 'p1' },
      toolPermission: 'always-proceed',
      agentMode: 'accept-edits',
      allowNonWorkspaceAccess: true,
      permissions: { allow: ['command(*)'] },
      trustedWorkspaces: ['/work/app'],
      statusLine: { command: 'echo hi' },
      enableTerminalSandbox: true,
      colorScheme: 'dark',
    };
    // What decides what runs without asking, or runs a command, is never kept (agy reads the run's settings only).
    expect(antigravityRunSettings(own, 'edit', false)).toEqual({
      model: 'gemini-4-argon-high',
      gcp: { project: 'p1' },
      toolPermission: 'request-review',
      agentMode: '',
      allowNonWorkspaceAccess: false,
    });
    expect(antigravityRunSettings(own, 'read-only', true)).toMatchObject({ toolPermission: 'request-review', allowNonWorkspaceAccess: false, modelProvider: 'gemini' });
    expect(antigravityRunSettings(undefined, 'full', false)).toEqual({ toolPermission: 'always-proceed', agentMode: '' });
    expect(antigravityRunSettings([1, 2], 'edit', false)).toEqual({ toolPermission: 'request-review', agentMode: '', allowNonWorkspaceAccess: false });
    // An account that runs on its key only is told to use it, also without one (agy then fails, never takes the default account's sign-in).
    expect(antigravityRunSettings(undefined, 'edit', false, true)).toMatchObject({ modelProvider: 'gemini' });
    expect(Object.keys(antigravityRunSettings(own, 'edit', false))).toEqual(expect.not.arrayContaining(['permissions', 'trustedWorkspaces', 'statusLine', 'enableTerminalSandbox']));
  });

  it.skipIf(process.platform === 'win32')("writes them in a folder of the run's own (owner only) in the account's CLI folder, removed after it, the account's own file left as it was", () => {
    const app = join(root, 'acct', '.gemini', 'antigravity-cli');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'settings.json'), JSON.stringify({ toolPermission: 'proceed-in-sandbox' }));
    const run = prepareAntigravityRun(app, 'edit', true);
    expect(run.name.startsWith(ANTIGRAVITY_RUN_PREFIX)).toBe(true);
    expect(statSync(run.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(run.dir, 'settings.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(run.dir, 'settings.json'), 'utf8'))).toEqual({ toolPermission: 'request-review', agentMode: '', allowNonWorkspaceAccess: false, modelProvider: 'gemini' });
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
    // A run of this server still under way is never swept, however old its folder looks.
    utimesSync(run.dir, long, long);
    const next = prepareAntigravityRun(app, 'edit', false);
    expect(existsSync(run.dir)).toBe(true);
    next.done();
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

describe("what a project makes agy run by itself", () => {
  let root: string;
  beforeAll(() => (root = mkdtempSync(join(tmpdir(), 'relay-agy-project-'))));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("finds the MCP servers, hooks and plugins of the project's customization folders, from each working directory up to its repository's root", () => {
    const repo = join(root, 'repo');
    const cwd = join(repo, 'pkg');
    const other = join(root, 'other');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.agents', 'plugins', 'p1'), { recursive: true });
    mkdirSync(join(cwd, '_agent'), { recursive: true });
    mkdirSync(join(other, '.agent'), { recursive: true });
    mkdirSync(join(cwd, '.agents', 'skills', 's'), { recursive: true });
    writeFileSync(join(cwd, '_agent', 'hooks.json'), '{}');
    writeFileSync(join(other, '.agent', 'mcp_config.json'), '{}');
    writeFileSync(join(root, 'mcp_config.json'), '{}'); // above the repository: not read
    writeFileSync(join(cwd, '.agents', 'skills', 's', 'SKILL.md'), '---\nname: s\n---\n'); // instructions only
    expect(antigravityProjectFiles([cwd, other]).sort()).toEqual([join(cwd, '_agent', 'hooks.json'), join(repo, '.agents', 'plugins'), join(other, '.agent', 'mcp_config.json')].sort());
    const before = antigravityProjectFingerprint(antigravityProjectFiles([cwd]));
    expect(antigravityProjectFingerprint(antigravityProjectFiles([cwd]))).toBe(before);
    writeFileSync(join(cwd, '_agent', 'hooks.json'), '{"x":{"PreInvocation":[{"type":"command","command":"curl evil"}]}}');
    expect(antigravityProjectFingerprint(antigravityProjectFiles([cwd]))).not.toBe(before);
  });
});

describe('commands agy leaves running', () => {
  const ps = [
    '1 0 1 30-00:00:00',
    '500 1 500 10:00', // agy (its own group)
    '501 500 500 09:59', // its helper, in its group: ended with it
    '600 500 600 00:05', // a command it started in a session of its own
    '601 600 600 00:04', // what that command started
    '700 1 600 3-00:00:00', // an older process in a group of that number: not this turn's
    '800 1 800 00:01', // unrelated
  ].join('\n');

  it("reads ps, and finds the process groups of agy's commands and what in them started during the turn", () => {
    const procs = parseProcs(ps);
    expect(procs).toHaveLength(7);
    expect(elapsedSeconds('1-02:03:04')).toBe(93784);
    expect(elapsedSeconds('03:04')).toBe(184);
    expect(elapsedSeconds('??')).toBe(Number.POSITIVE_INFINITY);
    expect(commandGroups(procs, 500)).toEqual([600]);
    expect(strayProcs(procs, new Set([600]), 60, 12345).sort()).toEqual([600, 601]);
    expect(strayProcs(procs, new Set([600]), 60, 601)).toEqual([600]); // never this server
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
    expect(start.settings).toEqual({ toolPermission: 'request-review', agentMode: '', allowNonWorkspaceAccess: false, modelProvider: 'gemini' });
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

  it("asks before agy runs a project's own MCP servers, hooks or plugins, and does not start when that is refused", async () => {
    const r = run(undefined, { permission: 'read-only' }, () => ({ allow: false }));
    mkdirSync(join(r.o.cwd, '.agents'), { recursive: true });
    writeFileSync(join(r.o.cwd, '.agents', 'mcp_config.json'), '{"mcpServers":{"x":{"command":"sh","args":["-c","touch pwned"]}}}');
    const err = (await withLang('en', () => antigravityRunner.run(r.o)).catch((e: unknown) => e)) as AgentRunError;
    expect(err.message).toContain(withLang('en', () => t().antigravityProjectSetupRefused(join('.agents', 'mcp_config.json'))));
    expect(r.approvals).toEqual([
      { kind: 'other', tool: expect.stringMatching(/^Antigravity project setup [0-9a-f]{8}$/), detail: join('.agents', 'mcp_config.json'), reason: withLang('en', () => t().antigravityProjectSetup) },
    ]);
    expect(r.log()).toEqual([]); // agy never started
    // Refused automatically when the chat refuses approvals; allowed, the turn runs.
    const auto = run(undefined, { permission: 'edit' });
    mkdirSync(join(auto.o.cwd, '_agent'), { recursive: true });
    writeFileSync(join(auto.o.cwd, '_agent', 'hooks.json'), '{}');
    await expect(antigravityRunner.run(auto.o)).rejects.toThrow(AgentRunError);
    const allowed = run(undefined, { permission: 'edit' }, () => ({ allow: true }));
    mkdirSync(join(allowed.o.cwd, '.agents'), { recursive: true });
    writeFileSync(join(allowed.o.cwd, '.agents', 'hooks.json'), '{}');
    await antigravityRunner.run(allowed.o);
    expect(methods(allowed)).toContain('session/prompt');
    // With full access nothing is asked.
    const full = run(undefined, { permission: 'full' });
    mkdirSync(join(full.o.cwd, '.agents'), { recursive: true });
    writeFileSync(join(full.o.cwd, '.agents', 'hooks.json'), '{}');
    await antigravityRunner.run(full.o);
    expect(full.approvals).toEqual([]);
  });

  it('keeps an account besides the default one on its own key: told to use it, never on the default sign-in', async () => {
    const r = run(undefined);
    r.o.env.HARNESS_RELAY_ANTIGRAVITY_KEY_ONLY = '1';
    delete r.o.env.GEMINI_API_KEY;
    await antigravityRunner.run(r.o);
    const start = r.log()[0]!;
    expect(start.settings).toMatchObject({ modelProvider: 'gemini' });
    expect(start.env.HARNESS_RELAY_ANTIGRAVITY_KEY_ONLY).toBeUndefined(); // not passed on (not in the stand-in's list either)
  });

  it('fails plainly when agy rejects a model, a thinking level or the default mode, or ends the turn by itself', async () => {
    for (const [value, over, message] of [
      ['gemini-x', { model: 'gemini-x' }, (e: string) => t().antigravityRejectedModel('gemini-x', e)],
      ['high', { effort: 'high' }, (e: string) => t().antigravityRejectedEffort('high', e)],
    ] as const) {
      const r = run(undefined, over);
      r.o.env.FAKE_AGY_REJECT = value;
      // The stand-in offers `high` as a level, so the effort is sent and rejected.
      await expect(withLang('en', () => antigravityRunner.run(r.o))).rejects.toThrow(withLang('en', () => message(`unknown value ${value}`)));
    }
    const mode = run(undefined);
    mode.o.env.FAKE_AGY_MODE = 'accept-edits';
    mode.o.env.FAKE_AGY_REJECT = 'default';
    await expect(withLang('en', () => antigravityRunner.run(mode.o))).rejects.toThrow(withLang('en', () => t().antigravityRejectedMode('unknown value default')));
    const cancelled = run(undefined);
    cancelled.o.env.FAKE_AGY_CANCELLED = '1';
    await expect(withLang('en', () => antigravityRunner.run(cancelled.o))).rejects.toThrow(withLang('en', () => t().antigravityCancelled));
    const none = run(undefined);
    none.o.env.FAKE_AGY_NO_SESSION = '1';
    await expect(withLang('en', () => antigravityRunner.run(none.o))).rejects.toThrow(withLang('en', () => t().antigravityNoSession));
  });

  it('puts a session left in another mode back in the default one, and sends a level only when the model offers it', async () => {
    const r = run(undefined, { effort: 'xhigh' });
    r.o.env.FAKE_AGY_MODE = 'accept-edits';
    await antigravityRunner.run(r.o);
    expect(r.log().filter((l) => l.method === 'session/set_config_option').map((l) => [l.params.configId, l.params.value])).toEqual([['mode', 'default']]);
  });

  it('sends the other working directories, the MCP servers and the images, and ignores what another session says', async () => {
    const img = join(root, 'shot.png');
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = run(undefined, {
      addDirs: ['/work/lib'],
      images: [{ path: img, mimeType: 'image/png' }],
      mcpServers: [
        { name: 'docs', transport: 'stdio', command: 'node', args: ['s.js'], url: '', env: { TOKEN: 't' }, headers: {} },
        { name: 'web', transport: 'http', command: '', args: [], url: 'https://x', env: {}, headers: {} },
      ],
    });
    r.o.env.FAKE_AGY_FOREIGN = '1';
    await antigravityRunner.run(r.o);
    const opened = sent(r, 'session/new')!.params;
    expect(opened.additionalDirectories).toEqual(['/work/lib']);
    // HTTP MCP servers only go to an agent that advertises them, which agy does not over ACP.
    expect(opened.mcpServers).toEqual([{ name: 'docs', command: 'node', args: ['s.js'], env: [{ name: 'TOKEN', value: 't' }] }]);
    expect(sent(r, 'session/prompt')!.params.prompt).toEqual([expect.objectContaining({ type: 'text' }), { type: 'image', data: 'iVBORw==', mimeType: 'image/png' }]);
    expect(r.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['hello']);
  });

  it('puts the briefing on top of the prompt when agy does not take it in its system prompt', async () => {
    const r = run(undefined, { systemPrompt: 'Be @Ada.' });
    r.o.env.FAKE_AGY_CAPS = JSON.stringify({ loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } });
    await antigravityRunner.run(r.o);
    expect(sent(r, 'session/new')!.params._meta).toBeUndefined();
    expect(sent(r, 'session/prompt')!.params.prompt[0].text).toBe(antigravityPromptText('Write hello.txt', 'Be @Ada.'));
  });

  it("says what went wrong when agy's logout fails", async () => {
    const r = run(undefined);
    r.o.env.FAKE_AGY_LOGOUT_FAIL = '1';
    await expect(antigravityLogout(bin, r.o.env, 10_000)).rejects.toThrow('keyring locked');
  });

  it("signs out with agy's ACP logout, in the account's home", async () => {
    const r = run(undefined);
    await antigravityLogout(bin, r.o.env, 10_000);
    expect(methods(r)).toEqual(['initialize', 'logout']);
    expect(r.log()[0]!.argv).toEqual(['acp', '--gemini-dir', join(r.home, '.gemini')]);
    expect(r.log()[0]!.env.SSH_CONNECTION).toBeTruthy();
  });
});
