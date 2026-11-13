import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

// A data folder of its own: each turn's home goes in its tmp folder.
const dataDir = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  process.env.RELAY_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'relay-copilot-data-')));
  return process.env.RELAY_DATA_DIR;
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

import {
  COPILOT_AGENT_MODE,
  COPILOT_NOTES,
  COPILOT_SECRET_VARS,
  askCopilotModels,
  copilotApprovalRequest,
  copilotArgs,
  copilotCommandOutput,
  copilotConfigPath,
  copilotDevWrites,
  copilotTempDirs,
  copilotStartsSomething,
  copilotEffortRefusal,
  copilotEnv,
  copilotExitCode,
  copilotHome,
  copilotInstructions,
  copilotLogout,
  copilotNotice,
  copilotPermissionDecision,
  copilotPolicyPaths,
  copilotPolicyProblem,
  copilotProjectHooks,
  copilotReadOnlyPaths,
  copilotToolCaches,
  copilotRunConfig,
  copilotRunSettings,
  copilotRunner,
  copilotSignedInAs,
  copilotSignedOut,
  createCopilotUpdateHandler,
  parseCopilotModels,
  prepareCopilotProbeHome,
  prepareCopilotRun,
  readCopilotJson,
  type CopilotToolCall,
} from '../src/server/agents/copilot';
import { AgentRunError, type AgentEvent, type ApprovalRequest, type RunOptions } from '../src/server/agents/types';
import { t, withLang } from '../src/server/i18n';
import { discoverModels } from '../src/server/models';
import { NativeSetupService, copilotAgents, copilotAsRun, copilotHooks, markLeftOut, parseCopilotProbe } from '../src/server/native';
import { relayTmpDir } from '../src/server/protect';
import type { ApprovalAnswer } from '../src/shared/types';
import { writeFakeCopilot } from './fake-copilot';

/*
 * The Copilot adapter (src/server/agents/copilot.ts), against messages the real `copilot --acp`
 * (1.0.109) sent when Harness Relay's adapter drove it: on a stand-in for an OpenAI-compatible model
 * API (its BYOK variables, as a run on the user's own endpoint) and on a GitHub sign-in with real
 * models (`real-*`), scrubbed (the working directory is /work/app, the protected folder /work/secret,
 * another folder /work/outside), replayed through a stand-in (test/fake-copilot.ts). Its listings
 * (`mcp list --json`…) are recorded too (test/fixtures/copilot/cli/).
 */
const FIX = fileURLToPath(new URL('./fixtures/copilot/', import.meta.url));
const CLI = join(FIX, 'cli');
const CWD = '/work/app';

const rows = (name: string) =>
  readFileSync(join(FIX, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);

/** The session updates a recording's agent sent for its last prompt (the turn, after the sandbox check), in order. */
function turnUpdates(name: string): Record<string, any>[] {
  const all = rows(name);
  const prompts = all.flatMap((r, i) => (r.dir === 'client->agent' && r.msg?.method === 'session/prompt' ? [i] : []));
  const from = prompts[prompts.length - 1] ?? 0;
  return all.slice(from).flatMap((r) => (r.dir === 'agent->client' && r.msg?.method === 'session/update' ? [r.msg.params.update] : []));
}

/** The recorded permission requests' tool calls. */
const asked = (name: string): CopilotToolCall[] => rows(name).flatMap((r) => (r.msg?.method === 'session/request_permission' ? [r.msg.params.toolCall] : []));

const call = (kind: string, rawInput: Record<string, unknown>, title = ''): CopilotToolCall => ({ toolCallId: 'c1', kind, title, rawInput });

describe('Copilot permission policy (its commands run in its own sandbox below full access)', () => {
  const add = ['/work/other'];
  const protectedPaths = ['/work/secret'];
  const decide = (permission: 'read-only' | 'edit' | 'full', c: CopilotToolCall) => copilotPermissionDecision(permission, c, CWD, add, protectedPaths);

  it('read-only: runs reads and URLs, asks about commands, writes and anything else', () => {
    expect(decide('read-only', call('read', { path: '/elsewhere/a.txt' }))).toEqual({ run: 'allow' });
    expect(decide('read-only', call('fetch', { url: 'https://example.com' }))).toEqual({ run: 'allow' });
    expect(decide('read-only', call('search', { pattern: 'x' }))).toEqual({ run: 'allow' });
    for (const c of asked('ro-deny')) expect(decide('read-only', c)).toEqual({ run: 'ask' });
    for (const c of asked('ro-auto')) expect(decide('read-only', c)).toEqual({ run: 'ask' });
    expect(decide('read-only', call('other', { server: 'x' }, 'An MCP tool'))).toEqual({ run: 'ask' });
  });

  it('refuses a read or write of a protected path below full access, without asking', () => {
    for (const permission of ['read-only', 'edit'] as const) {
      expect(decide(permission, call('read', { path: '/work/secret/key.txt' }))).toEqual({ run: 'refuse', reason: t().copilotProtected });
      expect(decide(permission, call('edit', { fileName: '/work/secret/x' }))).toEqual({ run: 'refuse', reason: t().copilotProtected });
    }
    expect(decide('full', call('read', { path: '/work/secret/key.txt' }))).toEqual({ run: 'allow' });
  });

  it('edit: runs commands (in its sandbox), but pushing and publishing ask', () => {
    for (const c of asked('plain')) expect(decide('edit', c)).toEqual({ run: 'allow' });
    for (const c of asked('publish')) expect(decide('edit', c)).toEqual({ run: 'ask' });
    expect(decide('edit', call('execute', { command: 'npm publish' }))).toEqual({ run: 'ask' });
    expect(decide('edit', call('execute', { command: 'npm test' }))).toEqual({ run: 'allow' });
  });

  it("edit: writes in the chat's working directories run; outside them, and where a write could change how agents run, they ask", () => {
    expect(decide('edit', asked('edit')[0]!)).toEqual({ run: 'allow' }); // /work/app/inside.txt
    expect(decide('edit', call('edit', { fileName: '/work/other/b.txt' }))).toEqual({ run: 'allow' });
    expect(decide('edit', call('edit', { fileName: '/elsewhere/b.txt' }))).toEqual({ run: 'ask' });
    for (const c of asked('config-write')) expect(decide('edit', c)).toEqual({ run: 'ask' }); // .github/hooks/x.json
    for (const p of ['.github/hooks/a.json', '.GitHub/Copilot/settings.json', '.github/mcp.json', '.github/lsp.json', '.github/extensions/x/extension.mjs', '.claude/settings.json', '.git/hooks/pre-commit', '.vscode/tasks.json']) {
      expect(decide('edit', call('edit', { fileName: join(CWD, p) })), p).toEqual({ run: 'ask' });
    }
    // Other files of .github are not agents' config.
    expect(decide('edit', call('edit', { fileName: join(CWD, '.github', 'workflows', 'ci.yml') }))).toEqual({ run: 'allow' });
    expect(decide('edit', call('edit', {}))).toEqual({ run: 'ask' });
  });

  it("edit: asks about any other tool (an MCP server's, storing a memory)", () => {
    expect(decide('edit', call('other', { x: 1 }, 'github-mcp-server-push_files'))).toEqual({ run: 'ask' });
    expect(decide('edit', call('think', {}, 'Store a memory'))).toEqual({ run: 'ask' });
    expect(decide('edit', call(undefined as unknown as string, {}, 'Unknown'))).toEqual({ run: 'ask' });
  });

  it('full: approves everything', () => {
    for (const c of [...asked('plain'), ...asked('publish'), ...asked('config-write'), call('read', { path: '/work/secret/k' })]) expect(decide('full', c)).toEqual({ run: 'allow' });
  });

  it('knows Copilot\'s own config folders in .github, in any letter case', () => {
    expect(copilotConfigPath(CWD, '.github/hooks/a.json', CWD)).toBe(true);
    expect(copilotConfigPath(CWD, '.GITHUB/HOOKS/a.json', CWD)).toBe(true);
    expect(copilotConfigPath(CWD, 'sub/.github/copilot/settings.local.json', CWD)).toBe(true);
    expect(copilotConfigPath(CWD, '.github/agents/reviewer.agent.md', CWD)).toBe(true);
    expect(copilotConfigPath(CWD, '.github/workflows/ci.yml', CWD)).toBe(false);
    expect(copilotConfigPath(CWD, 'src/hooks/use.ts', CWD)).toBe(false);
  });

  it('describes what it asks about: a command runs in its sandbox once allowed, and a write says why it asks', () => {
    expect(copilotApprovalRequest('edit', asked('publish')[0]!, CWD)).toEqual({ kind: 'command', detail: 'git push origin main' });
    expect(copilotApprovalRequest('edit', call('execute', { command: 'make', description: 'Build it' }, 'make'), CWD)).toEqual({ kind: 'command', detail: 'make', reason: 'Build it' });
    expect(copilotApprovalRequest('read-only', asked('ro-auto')[0]!, CWD)).toEqual({ kind: 'edit', detail: '/work/app/auto.txt', reason: 'Create file' });
    expect(copilotApprovalRequest('edit', asked('config-write')[0]!, CWD)).toEqual({ kind: 'edit', detail: '/work/app/.github/hooks/x.json', reason: t().copilotConfigWrite });
    expect(copilotApprovalRequest('edit', call('edit', { fileName: '/elsewhere/x' }, 'Create file'), CWD)).toEqual({ kind: 'edit', detail: '/elsewhere/x', reason: t().copilotOutsideWrite });
    expect(copilotApprovalRequest('read-only', call('fetch', { url: 'https://example.com' }, 'Fetch'), CWD)).toEqual({ kind: 'fetch', detail: 'https://example.com', reason: 'Fetch' });
    expect(copilotApprovalRequest('read-only', call('other', { query: 'issues' }, 'github-list-issues'), CWD)).toMatchObject({ kind: 'other', tool: 'github-list-issues', detail: 'issues' });
  });
});

describe('Copilot session updates', () => {
  const play = (name: string, refused: [string, string][] = []) => {
    const events: AgentEvent[] = [];
    const h = createCopilotUpdateHandler((e) => events.push(e));
    for (const [id, label] of refused) h.refused(id, label);
    for (const u of turnUpdates(name)) h.handle(u);
    h.finish(true);
    return events;
  };

  it('streams its thinking and reply, and shows each call once, with what a command printed', () => {
    const events = play('plain');
    expect(events.filter((e) => e.type === 'thinking').map((e) => (e as { text: string }).text).join('')).toBe('Looking at the folder first.');
    const starts = events.filter((e) => e.type === 'tool_start');
    expect(starts).toEqual([
      { type: 'tool_start', id: 'call_36', name: 'Read', detail: '/work/app/a.txt', kind: 'read' },
      { type: 'tool_start', id: 'call_37', name: 'Shell', detail: 'touch made.txt && ls', kind: 'execute' },
    ]);
    // What each returned, a command's without Copilot's last line.
    expect(events.filter((e) => e.type === 'tool_end')).toEqual([
      { type: 'tool_end', id: 'call_36', ok: true, output: 'hello' },
      { type: 'tool_end', id: 'call_37', ok: true, output: 'a.txt\nmade.txt' },
    ]);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('All done.');
  });

  it("shows why a call was refused (its own words left out), and leaves out Copilot's notices", () => {
    const events = play('ro-deny', [['call_39', 'Declined (Copilot ends its turn after a refusal)']]);
    expect(events.find((e) => e.type === 'tool_end')).toEqual({ type: 'tool_end', id: 'call_39', ok: false, error: 'Declined (Copilot ends its turn after a refusal)' });
    // "Info: Operation cancelled by user" is Copilot's, not the model's.
    expect(events.some((e) => e.type === 'text')).toBe(false);
  });

  it("shows a protected path's refusal by its sandbox, and a command it kept from writing", () => {
    const ends = play('protected').filter((e) => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>[];
    expect(ends[0]).toMatchObject({ ok: false, error: 'Is a sandbox denied path.' });
    expect(ends[1]).toMatchObject({ ok: true, output: expect.stringContaining('Operation not permitted') });
    const edit = play('edit').filter((e) => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>[];
    expect(edit.map((e) => [e.ok, e.error ?? e.output?.split('\n')[0]])).toEqual([
      [true, 'Created file /work/app/inside.txt with 3 characters'],
      [true, 'touch: /work/outside/cmd-out.txt: Operation not permitted'],
      [false, "Outside the sandbox's writable paths."],
    ]);
    expect(play('detach').find((e) => e.type === 'tool_end')).toMatchObject({ ok: false, error: 'Detached commands cannot run inside the sandbox. Run it without detach so the sandbox can be enforced.' });
  });

  it('shows the calls a real model made in parallel, each with its output', () => {
    const events = play('real-tools');
    const starts = events.filter((e) => e.type === 'tool_start').map((e) => (e as { detail?: string }).detail);
    expect(starts).toEqual(['ls', 'touch real-made.txt']);
    const ends = events.filter((e) => e.type === 'tool_end') as Extract<AgentEvent, { type: 'tool_end' }>[];
    expect(ends.every((e) => e.ok)).toBe(true);
    expect(ends.find((e) => e.output)?.output).toContain('a.txt');
  });

  it("reads a command's exit code, and its output without Copilot's last line", () => {
    expect(copilotCommandOutput('OK\n<shellId: 0 completed with exit code 0>')).toBe('OK');
    expect(copilotCommandOutput('a\r\nb\r\n<shellId: 3 completed with exit code 2>')).toBe('a\nb');
    expect(copilotExitCode({ contents: [{ type: 'shell_exit', shellId: '0', exitCode: 2 }] })).toBe(2);
    expect(copilotExitCode({ content: 'x' })).toBeUndefined();
    const events: AgentEvent[] = [];
    const h = createCopilotUpdateHandler((e) => events.push(e));
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'x', kind: 'execute', title: 'Fail', rawInput: { command: 'false' } });
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed', rawOutput: { content: '<shellId: 1 completed with exit code 1>', contents: [{ type: 'shell_exit', exitCode: 1 }] } });
    expect(events.at(-1)).toEqual({ type: 'tool_end', id: 'x', ok: false, error: t().copilotExitCode(1) });
  });

  it("fails a turn whose model call failed (its error line, and no usage), and shows such a line as text in a turn that did not", () => {
    const failing = createCopilotUpdateHandler(() => undefined);
    failing.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Error: Could not connect to local model provider at http://127.0.0.1:18555/v1.\n  Check that the service is running and the port is correct.' } });
    expect(failing.finish(false)).toBe('Error: Could not connect to local model provider at http://127.0.0.1:18555/v1.\n  Check that the service is running and the port is correct.');
    const events: AgentEvent[] = [];
    const ok = createCopilotUpdateHandler((e) => events.push(e));
    ok.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Error: sessionStart hook from ".github/hooks/h.json" failed' } });
    ok.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    expect(ok.finish(true)).toBeUndefined();
    // Text came in the same block after it: shown where it came, as text.
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Error: sessionStart hook from ".github/hooks/h.json" failed', 'Done.']);
    // Followed by a tool call instead, it is held to the end, and shown then since the turn had usage.
    const later: AgentEvent[] = [];
    const held = createCopilotUpdateHandler((e) => later.push(e));
    held.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Error: sessionStart hook from ".github/hooks/h.json" failed' } });
    held.handle({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', title: 'view', status: 'pending' });
    held.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    expect(held.finish(true)).toBeUndefined();
    expect(later.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Done.', 'Error: sessionStart hook from ".github/hooks/h.json" failed']);
  });

  it("takes only a one-line \"Info:\" block for Copilot's notice; its errors and the model's text stay", () => {
    expect(copilotNotice('Info: Operation cancelled by user')).toBe(true);
    expect(copilotNotice('Info: /work/app/inside.txt')).toBe(true);
    expect(copilotNotice('Error: sessionStart hook from ".github/hooks/h.json" failed')).toBe(false);
    expect(copilotNotice('Info: first\nsecond')).toBe(false);
    const events: AgentEvent[] = [];
    const h = createCopilotUpdateHandler((e) => events.push(e));
    h.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Here is the ' } });
    h.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Info: part of a reply' } });
    expect(events).toEqual([
      { type: 'text', text: 'Here is the ' },
      { type: 'text', text: 'Info: part of a reply' },
    ]);
  });

  it("tells a reply that begins like one of Copilot's lines from Copilot's own: the model's goes on in the same block", () => {
    const run = (chunks: Record<string, any>[], usage: boolean) => {
      const events: AgentEvent[] = [];
      const h = createCopilotUpdateHandler((e) => events.push(e));
      for (const u of chunks) h.handle(u);
      return { failed: h.finish(usage), texts: events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text) };
    };
    const say = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    const tool = { sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'read', title: 'view', status: 'pending' };
    // A non-streaming model's whole first chunk: shown in order, even without usage.
    expect(run([say('Error: ENOENT means the file is missing.'), say(' Create it first.')], false)).toEqual({ failed: undefined, texts: ['Error: ENOENT means the file is missing.', ' Create it first.'] });
    expect(run([say('Info: the build passed.'), say(' Nothing else to do.')], true).texts).toEqual(['Info: the build passed.', ' Nothing else to do.']);
    // Copilot's own: a notice before a tool call is dropped, an error line at the end fails a turn without usage.
    expect(run([say('Info: /work/app/inside.txt'), tool, say('Done.')], true)).toEqual({ failed: undefined, texts: ['Done.'] });
    expect(run([say('Error: Could not connect to local model provider at http://127.0.0.1:9/v1.')], false).failed).toBe('Error: Could not connect to local model provider at http://127.0.0.1:9/v1.');
    expect(run([say('Info: Operation cancelled by user'), say('Error: x')], false)).toEqual({ failed: 'Error: x', texts: [] });
  });
});

describe("Copilot's home and settings for one run", () => {
  const own = {
    model: 'claude-sonnet-5.5',
    effortLevel: 'high',
    allowedUrls: ['example.com'],
    defaultPermissionMode: 'allow-all',
    statusLine: { command: 'echo hi' },
    telemetry: { headersProvider: 'x' },
    sandbox: { enabled: false, allowBypass: true },
    hooks: { sessionStart: [] },
    disabledSkills: ['own-skill'],
    memory: true,
    enabledPlugins: { 'p@m': true },
  };

  it("keeps the account's model and what it loads, nothing that widens what runs, and turns its sandbox on below full access", () => {
    const s = copilotRunSettings(own, { permission: 'edit', addDirs: ['/work/other'], readDirs: ['/skills'], protectedPaths: ['/work/secret'] });
    expect(s).toEqual({
      model: 'claude-sonnet-5.5',
      effortLevel: 'high',
      hooks: { sessionStart: [] },
      disabledSkills: ['own-skill'],
      memory: true,
      enabledPlugins: { 'p@m': true },
      sessionManagementTools: { enabled: false },
      sandbox: {
        enabled: true,
        allowBypass: false,
        addCurrentWorkingDirectory: true,
        allowDevToolAccess: true,
        auth: { git: false, gh: false },
        sandboxMcpServers: false,
        sandboxLspServers: true,
        sandboxExtensions: true,
        userPolicy: {
          filesystem: { readwritePaths: ['/work/other'], readonlyPaths: ['/skills'], deniedPaths: ['/work/secret'] },
          network: { allowOutbound: true, allowLocalNetwork: true },
          seatbelt: { keychainAccess: false },
        },
      },
    });
    expect(copilotRunSettings(own, { permission: 'full' }).sandbox).toEqual({ enabled: false });
    // Whether its sessions sync to GitHub, its updates and its proxy stay as the user set them.
    expect(copilotRunSettings({ remoteExport: false, autoUpdate: false, proxyUrl: 'http://proxy:3128' }, { permission: 'full' })).toMatchObject({ remoteExport: false, autoUpdate: false, proxyUrl: 'http://proxy:3128' });
    // On the user's own endpoint the account's model keys would name one of Copilot's service: left out.
    const onEndpoint = copilotRunSettings({ ...own, modelProviderId: 'github', contextTier: 'x' }, { permission: 'full', onEndpoint: true });
    for (const k of ['model', 'modelProviderId', 'effortLevel', 'contextTier']) expect(onEndpoint).not.toHaveProperty(k);
    expect(onEndpoint).toMatchObject({ memory: true, disabledSkills: ['own-skill'] });
    expect(copilotRunSettings('not json', { permission: 'full' })).toEqual({ sessionManagementTools: { enabled: false }, sandbox: { enabled: false } });
  });

  it('leaves out memory, hooks, plugins and skills as the run says, and disables single skills by name', () => {
    const s = copilotRunSettings(own, { permission: 'edit', nativeOff: ['memory', 'hooks', 'plugins', 'skills'], nativeItems: {} });
    expect(s).toMatchObject({ memory: false, disableAllHooks: true });
    expect(s).not.toHaveProperty('hooks');
    expect(s).not.toHaveProperty('enabledPlugins');
    expect(s).not.toHaveProperty('disabledSkills');
    expect(copilotRunSettings(own, { permission: 'edit', nativeItems: { skills: ['a', 'own-skill'] } }).disabledSkills).toEqual(['own-skill', 'a']);
  });

  it("takes the account's sign-in state without the folders it trusted, and without its plugins' when they are left out", () => {
    const config = { loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }], lastLoggedInUser: { login: 'octocat' }, trustedFolders: ['/work'], installedPlugins: [1], marketplaces: [2] };
    expect(copilotRunConfig(config)).toEqual({ loggedInUsers: config.loggedInUsers, lastLoggedInUser: config.lastLoggedInUser, installedPlugins: [1], marketplaces: [2] });
    expect(copilotRunConfig(config, ['plugins'])).toEqual({ loggedInUsers: config.loggedInUsers, lastLoggedInUser: config.lastLoggedInUser });
    expect(copilotRunConfig(undefined)).toEqual({});
    // Settings an older Copilot kept there, in either spelling, never come along.
    const old = { loggedInUsers: [1], trusted_folders: ['/'], allowed_urls: ['x'], allow_all: true, defaultPermissionMode: 'allow-all', statusLine: {}, sandbox: { enabled: false }, hooks: {}, firstLaunchAt: 'x' };
    expect(copilotRunConfig(old)).toEqual({ loggedInUsers: [1], hooks: {}, firstLaunchAt: 'x' });
    expect(copilotRunConfig(old, ['hooks'])).toEqual({ loggedInUsers: [1], firstLaunchAt: 'x' });
  });

  it('reads its JSON files, the comment lines Copilot writes at their top too, and who is signed in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-copilot-json-'));
    try {
      writeFileSync(join(dir, 'config.json'), '// User settings belong in settings.json.\n// This file is managed automatically.\n{\n  "loggedInUsers": [{ "host": "https://github.com", "login": "octocat" }]\n}\n');
      expect(readCopilotJson(join(dir, 'config.json'))).toEqual({ loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }] });
      expect(copilotSignedInAs(dir)).toBe('octocat');
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ lastLoggedInUser: { login: 'hubot' }, loggedInUsers: [{ login: 'octocat' }] }));
      expect(copilotSignedInAs(dir)).toBe('hubot');
      writeFileSync(join(dir, 'config.json'), '{ "firstLaunchAt": "x" }');
      expect(copilotSignedInAs(dir)).toBeUndefined();
      expect(readCopilotJson(join(dir, 'missing.json'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(copilotHome({ COPILOT_HOME: '/h/c' })).toBe('/h/c');
    expect(copilotHome({}, '/home/u')).toBe(join('/home/u', '.copilot'));
  });

  it("makes a home of the run's own in Harness Relay's temporary folder: its settings, sign-in, briefing, and links to the account's sessions and what it loads", () => {
    const account = mkdtempSync(join(tmpdir(), 'relay-copilot-acct-'));
    try {
      mkdirSync(join(account, 'skills', 's1'), { recursive: true });
      mkdirSync(join(account, 'hooks'));
      writeFileSync(join(account, 'mcp-config.json'), '{"mcpServers":{}}');
      writeFileSync(join(account, 'permissions-config.json'), '{"allow":["shell(rm)"]}');
      writeFileSync(join(account, 'copilot-instructions.md'), 'My own rules.');
      writeFileSync(join(account, 'config.json'), JSON.stringify({ loggedInUsers: [{ login: 'octocat' }], trustedFolders: ['/'] }));
      const run = prepareCopilotRun(account, { permission: 'edit', nativeOff: ['hooks'] }, 'You are @Ada.');
      expect(run.dir.startsWith(relayTmpDir())).toBe(true);
      const names = readdirSync(run.dir).sort();
      // Its sessions and (but on Windows) their index, the account's.
      expect(names).toEqual(['config.json', 'copilot-instructions.md', 'mcp-config.json', 'session-state', ...(process.platform === 'win32' ? [] : ['session-store.db']), 'settings.json', 'skills']);
      if (process.platform !== 'win32') expect(lstatSync(join(run.dir, 'session-store.db')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(run.dir, 'session-state')).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(run.dir, 'session-state'))).toBe(realpathSync(join(account, 'session-state')));
      expect(JSON.parse(readFileSync(join(run.dir, 'config.json'), 'utf8'))).toEqual({ loggedInUsers: [{ login: 'octocat' }] });
      const brief = readFileSync(join(run.dir, 'copilot-instructions.md'), 'utf8');
      expect(brief).toContain('You are @Ada.');
      expect(brief).toContain(COPILOT_NOTES);
      expect(brief.trim().endsWith('My own rules.')).toBe(true);
      if (process.platform !== 'win32') expect(statSync(run.dir).mode & 0o777).toBe(0o700);
      run.done();
      expect(existsSync(run.dir)).toBe(false);
      // The account's files, what the links led to, stay.
      expect(existsSync(join(account, 'skills', 's1'))).toBe(true);
      expect(existsSync(join(account, 'session-state'))).toBe(true);
    } finally {
      rmSync(account, { recursive: true, force: true });
    }
  });

  it('knows when its session would run something by itself as it opens, so that its sandbox is checked first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-copilot-starts-'));
    try {
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'x' }));
      expect(copilotStartsSomething(dir, [])).toBe(false);
      expect(copilotStartsSomething(dir, ['/repo/.github/hooks/h.json'])).toBe(true);
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { sessionStart: [] } }));
      expect(copilotStartsSomething(dir, [])).toBe(true);
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: {} }));
      for (const n of ['hooks', 'installed-plugins', 'extensions']) {
        mkdirSync(join(dir, n));
        expect(copilotStartsSomething(dir, [])).toBe(true);
        rmSync(join(dir, n), { recursive: true });
      }
      writeFileSync(join(dir, 'lsp-config.json'), '{}');
      expect(copilotStartsSomething(dir, [])).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks it its models in a home with the account's sign-in only", () => {
    const account = mkdtempSync(join(tmpdir(), 'relay-copilot-probe-'));
    try {
      writeFileSync(join(account, 'config.json'), JSON.stringify({ loggedInUsers: [{ login: 'octocat' }], trustedFolders: ['/'] }));
      writeFileSync(join(account, 'settings.json'), JSON.stringify({ model: 'gpt-6-luna', allowedUrls: ['x'] }));
      const probe = prepareCopilotProbeHome(account);
      expect(readdirSync(probe.dir).sort()).toEqual(['config.json', 'settings.json']);
      expect(JSON.parse(readFileSync(join(probe.dir, 'settings.json'), 'utf8'))).toEqual({ model: 'gpt-6-luna' });
      // Asked in an empty repository of its own, outside Harness Relay's data folder (which may be in a repository with hooks).
      expect(realpathSync(probe.cwd!).startsWith(realpathSync(tmpdir()))).toBe(true);
      expect(readdirSync(probe.cwd!)).toEqual(['.git']);
      probe.done();
      expect(existsSync(probe.dir)).toBe(false);
      expect(existsSync(probe.cwd!)).toBe(false);
    } finally {
      rmSync(account, { recursive: true, force: true });
    }
  });

  it('starts it over ACP: in its sandbox below full access, allowing all with full access, with what the run leaves out', () => {
    const secrets = `--secret-env-vars=${COPILOT_SECRET_VARS.join(',')}`;
    expect(copilotArgs({ permission: 'edit' })).toEqual(['--acp', '--sandbox', secrets]);
    expect(copilotArgs({ permission: 'full', addDirs: ['/a', '/b'], model: 'gpt-6-luna', effort: 'high' })).toEqual([
      '--acp',
      '--allow-all',
      '--add-dir',
      '/a',
      '--add-dir',
      '/b',
      secrets,
      '--model',
      'gpt-6-luna',
      '--reasoning-effort',
      'high',
    ]);
    expect(copilotArgs({ permission: 'read-only', nativeOff: ['skills', 'mcp'], nativeItems: { mcp: ['github'] } })).toEqual(['--acp', '--sandbox', secrets, '--excluded-tools', 'skill', '--disable-builtin-mcps']);
    expect(copilotArgs({ permission: 'edit', nativeItems: { mcp: ['github', 'db'] } })).toEqual(['--acp', '--sandbox', secrets, '--disable-mcp-server', 'github', '--disable-mcp-server', 'db']);
  });

  it("gives it the run's home, none of the variables that would allow everything, and on an endpoint its BYOK variables", () => {
    const env = copilotEnv({ PATH: '/bin', COPILOT_ALLOW_ALL: 'true', COPILOT_ASSISTED_APPROVAL: '1', COPILOT_SKILLS_DIRS: '/s', COPILOT_HOME: '/acct' }, '/run', ['skills', 'plugins']);
    expect(env).toEqual({ PATH: '/bin', COPILOT_HOME: '/run', COPILOT_PLUGIN_DIR_ONLY: 'true' });
    const endpoint = { id: 'homelab/gemma4', model: 'gemma4', endpoint: { id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.2:11434/v1/', models: ['gemma4'], apiKey: 'k-1' } };
    const home = join('/', 'home', 'u');
    expect(copilotEnv({ COPILOT_PROVIDERS_CONFIG: '/p.json', COPILOT_PROVIDER_HEADERS: 'X: 1', COPILOT_MODEL: 'old' }, '/run', [], endpoint, home)).toEqual({
      COPILOT_HOME: '/run',
      COPILOT_SKILLS_DIRS: join(home, '.agents', 'skills'),
      COPILOT_PROVIDER_BASE_URL: 'http://10.0.0.2:11434/v1',
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_WIRE_API: 'completions',
      COPILOT_MODEL: 'gemma4',
      COPILOT_PROVIDER_API_KEY: 'k-1',
    });
    expect(copilotEnv({ COPILOT_PROVIDER_API_KEY: 'stale' }, '/run', [], { ...endpoint, endpoint: { ...endpoint.endpoint, apiKey: undefined } })).not.toHaveProperty('COPILOT_PROVIDER_API_KEY');
  });

  it("gives the default account's runs the skills in ~/.agents/skills, which Copilot reads only in its usual home", () => {
    // Copilot 1.0.111 lists them (`skill list`, as Settings asks) while its home is ~/.copilot itself, and a
    // run's own home made it skip them; given as a skill folder (comma-separated), a run's turn had them.
    const home = join('/', 'home', 'u');
    const agents = join(home, '.agents', 'skills');
    expect(copilotEnv({}, '/run', [], undefined, home).COPILOT_SKILLS_DIRS).toBe(agents);
    expect(copilotEnv({ COPILOT_HOME: join(home, '.copilot') }, '/run', [], undefined, home).COPILOT_SKILLS_DIRS).toBe(agents);
    // The user's own skill folders stay, first.
    expect(copilotEnv({ COPILOT_SKILLS_DIRS: '/s' }, '/run', [], undefined, home).COPILOT_SKILLS_DIRS).toBe(`/s,${agents}`);
    // Another account, or the CLIs' own folder (Settings → Agent sessions): Copilot does not read them in
    // that home, nor does its run.
    expect(copilotEnv({ COPILOT_HOME: '/acct' }, '/run', [], undefined, home)).not.toHaveProperty('COPILOT_SKILLS_DIRS');
    // Skills left out: no skill folder at all.
    expect(copilotEnv({ COPILOT_SKILLS_DIRS: '/s' }, '/run', ['skills'], undefined, home)).not.toHaveProperty('COPILOT_SKILLS_DIRS');
    // A home whose path has a comma in it would split the list: its runs go without them.
    const comma = join('/', 'home', 'a,b');
    expect(copilotEnv({}, '/run', [], undefined, comma)).not.toHaveProperty('COPILOT_SKILLS_DIRS');
    expect(copilotEnv({ COPILOT_SKILLS_DIRS: '/s' }, '/run', [], undefined, comma).COPILOT_SKILLS_DIRS).toBe('/s');
  });

  it('tells the usual home however COPILOT_HOME spells it: a trailing slash, a link, another letter case', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'relay-copilot-home-')));
    onTestFinished(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, '.copilot'));
    const agents = join(home, '.agents', 'skills');
    expect(copilotEnv({ COPILOT_HOME: `${join(home, '.copilot')}/` }, '/run', [], undefined, home).COPILOT_SKILLS_DIRS).toBe(agents);
    expect(copilotEnv({ COPILOT_HOME: join(home, 'x', '..', '.copilot') }, '/run', [], undefined, home).COPILOT_SKILLS_DIRS).toBe(agents);
    symlinkSync(join(home, '.copilot'), join(home, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(copilotEnv({ COPILOT_HOME: join(home, 'link') }, '/run', [], undefined, home).COPILOT_SKILLS_DIRS).toBe(agents);
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(copilotEnv({ COPILOT_HOME: join(home, '.COPILOT') }, '/run', [], undefined, home).COPILOT_SKILLS_DIRS).toBe(agents);
    }
    // Another folder beside it is not.
    mkdirSync(join(home, 'other'));
    expect(copilotEnv({ COPILOT_HOME: join(home, 'other') }, '/run', [], undefined, home)).not.toHaveProperty('COPILOT_SKILLS_DIRS');
  });
});

describe("what Copilot's sandbox keeps read-only below full access", () => {
  it("knows the shared caches Copilot's dev-tool access would let commands write, where their variables move them", () => {
    const home = join('/', 'h');
    const mac = copilotToolCaches({}, home, 'darwin');
    expect(mac).toContain(join(home, '.cargo', 'registry'));
    expect(mac).toContain(join(home, '.cargo', '.package-cache'));
    expect(mac).toContain(join(home, 'Library', 'Caches', 'go-build'));
    expect(mac).toContain(join(home, 'go', 'pkg', 'mod'));
    expect(mac).toContain(join(home, 'Library', 'Caches', 'Mozilla.sccache'));
    expect(mac).toContain(join(home, '.gradle'));
    expect(mac).toContain(join(home, '.cache', 'gh'));
    const linux = copilotToolCaches({ XDG_CACHE_HOME: join('/', 'c'), CARGO_HOME: join('/', 'cargo'), GOCACHE: join('/', 'gc'), GOPATH: join('/', 'gp'), CCACHE_DIR: join('/', 'cc'), GRADLE_USER_HOME: join('/', 'gr') }, home, 'linux');
    expect(linux).toEqual(
      expect.arrayContaining([join('/', 'cargo', 'git'), join('/', 'gc'), join('/', 'gp', 'pkg', 'mod'), join('/', 'cc'), join('/', 'c', 'ccache'), join('/', 'c', 'sccache'), join('/', 'gr'), join('/', 'c', 'gh')]),
    );
    // Copilot grants the default places too when a variable moves one (tried), so both are listed.
    expect(linux).toEqual(expect.arrayContaining([join(home, '.cargo', 'registry'), join(home, '.cache', 'go-build'), join(home, 'go', 'pkg', 'mod')]));
    // npm's, pip's, uv's, Playwright's and the like, which hold programs a later command runs.
    expect(mac).toEqual(
      expect.arrayContaining([join(home, '.npm'), join(home, 'Library', 'Caches', 'pip'), join(home, '.cache', 'uv'), join(home, 'Library', 'Caches', 'ms-playwright'), join(home, '.bun', 'install', 'cache'), join(home, '.yarn', 'berry')]),
    );
    expect(copilotToolCaches({ npm_config_cache: join('/', 'n'), PLAYWRIGHT_BROWSERS_PATH: join('/', 'pw') }, home, 'linux')).toEqual(expect.arrayContaining([join('/', 'n'), join('/', 'pw')]));
    const win = copilotToolCaches({ LOCALAPPDATA: join('/', 'L') }, home, 'win32');
    expect(win).toEqual(expect.arrayContaining([join('/', 'L', 'Mozilla', 'sccache'), join('/', 'L', 'npm-cache'), join('/', 'L', 'pip')]));
  });

  it("lets git read the user's git config, and keeps what decides how agents run later read-only, as far as it exists", () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-copilot-ro-'));
    try {
      const home = join(root, 'home');
      const app = join(root, 'app');
      const other = join(root, 'other');
      mkdirSync(join(home, '.config', 'git'), { recursive: true });
      writeFileSync(join(home, '.config', 'git', 'ignore'), '*.log\n');
      writeFileSync(join(home, '.config', 'git', 'credentials'), 'https://u:secret@example.com\n');
      writeFileSync(join(home, '.gitconfig'), '[user]\n');
      mkdirSync(join(app, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(app, '.git', 'config'), '');
      mkdirSync(join(app, '.claude'));
      mkdirSync(join(app, '.github', 'hooks'), { recursive: true });
      mkdirSync(join(other, '.vscode'), { recursive: true });
      mkdirSync(join(home, '.cargo', 'registry'), { recursive: true });
      const paths = copilotReadOnlyPaths([app, other], {}, home, 'linux');
      expect(paths).toEqual([
        join(home, '.gitconfig'),
        // git's own files there, never the folder: credential-store's `credentials` stays unreadable.
        join(home, '.config', 'git', 'ignore'),
        join(home, '.cargo', 'registry'),
        join(app, '.git', 'hooks'),
        join(app, '.git', 'config'),
        join(app, '.claude'),
        join(app, '.github', 'hooks'),
        join(other, '.vscode'),
      ]);
      // What does not exist is left out. XDG_CONFIG_HOME moves git's own folder; a moved CARGO_HOME keeps the default too (Copilot grants both).
      expect(copilotReadOnlyPaths([join(root, 'none')], { XDG_CONFIG_HOME: join(root, 'xdg'), CARGO_HOME: join(root, 'cargo') }, home, 'linux')).toEqual([join(home, '.gitconfig'), join(home, '.cargo', 'registry')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Copilot's sandbox policy, checked before each turn below full access", () => {
  const policy = (denied: string[], rw: string[] = [], bypass = 'no') =>
    `Effective sandbox policy for /work/app\n\n\u001b[1mUser-configured paths:\u001b[22m\n  Read-write paths (${rw.length}):\n${rw.map((p) => `    ${p}\n`).join('')}  Denied paths (${denied.length}):\n${denied.map((p) => `    ${p}\n`).join('')}\n\u001b[1mCapabilities:\u001b[22m\n  Allow sandbox bypass: ${bypass}\n`;

  it("passes the policy the run set up, the recordings' too", () => {
    expect(copilotPolicyProblem(policy(['/work/secret'], ['/work/outside']), { protectedPaths: ['/work/secret'], addDirs: ['/work/outside'] })).toBeUndefined();
    const recorded = (name: string) =>
      rows(name)
        .filter((r) => r.msg?.params?.update?.sessionUpdate === 'agent_message_chunk')
        .map((r) => r.msg.params.update.content.text)
        .find((text: string) => text.startsWith('Effective sandbox policy'));
    expect(copilotPolicyProblem(recorded('protected')!, { protectedPaths: ['/work/secret'] })).toBeUndefined();
    expect(copilotPolicyProblem(recorded('add-dir')!, { protectedPaths: ['/work/secret'], addDirs: ['/work/outside'] })).toBeUndefined();
  });

  it('fails when the sandbox is off, a command may leave it, or a path the run gave it is not in it', () => {
    expect(copilotPolicyProblem('Command sandboxing is disabled, so no policy is in force and commands run unrestricted.\n', {})).toBe('Command sandboxing is disabled, so no policy is in force and commands run unrestricted.');
    expect(copilotPolicyProblem(policy([], [], 'yes'), {})).toBe('a command may leave the sandbox (bypass)');
    expect(copilotPolicyProblem(policy([]), { protectedPaths: ['/work/secret'] })).toBe('/work/secret is not among its denied paths');
    expect(copilotPolicyProblem(policy(['/work/secret']), { protectedPaths: ['/work/secret'], addDirs: ['/work/other'] })).toBe('/work/other is not among its read-write paths');
    expect(copilotPolicyProblem('', {})).toBe('no policy');
    // A path only mentioned elsewhere (inside another one listed, or under another kind) does not count.
    expect(copilotPolicyProblem(policy(['/work/secret/inner'], ['/work/secret']), { protectedPaths: ['/work/secret'] })).toBe('/work/secret is not among its denied paths');
    expect(copilotPolicyProblem(policy(['/work/secret'], ['/work/secret/sub']), { protectedPaths: ['/work/secret'], addDirs: ['/work/secret'] })).toBe('/work/secret is not among its read-write paths');
    // A bypass that is only mentioned, not set, does not count either.
    expect(copilotPolicyProblem(`${policy([])}\nAllow sandbox bypass: no is what Harness Relay wants\n`.replace('Allow sandbox bypass: no\n', 'Allow sandbox bypass: yes\n'), {})).toBe('a command may leave the sandbox (bypass)');
    expect(copilotPolicyPaths(policy(['/a', '/b'], ['/c']))).toEqual({ 'read-write': ['/c'], denied: ['/a', '/b'] });
    // What would hand its commands the user's credentials.
    expect(copilotPolicyProblem(policy([]).replace('Allow sandbox bypass: no', 'Allow sandbox bypass: no\n  Allow keychain access: on'), {})).toBe('Allow keychain access: on');
    expect(copilotPolicyProblem(policy([]).replace('Allow sandbox bypass: no', 'Allow sandbox bypass: no\n  Authenticate git (sandbox setting): on'), {})).toBe('Authenticate git (sandbox setting): on');
  });

  it('compares paths on Windows without letter case, and either slash', () => {
    const win = `Effective sandbox policy for C:\\work\\app\n\nUser-configured paths:\n  Read-write paths (1):\n    C:\\Work\\Other\n  Denied paths (1):\n    c:\\work\\secret\\\n\nCapabilities:\n  Allow sandbox bypass: no\n`;
    expect(copilotPolicyProblem(win, { protectedPaths: ['C:/Work/Secret'], addDirs: ['c:\\work\\other'] }, 'win32')).toBeUndefined();
    expect(copilotPolicyProblem(win, { protectedPaths: ['C:/Work/Secret'] }, 'linux')).toBe('C:/Work/Secret is not among its denied paths');
  });

  it("finds what its dev-tool access lets commands write that the run's read-only paths do not cover", () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-copilot-dev-'));
    try {
      const [npm, pip, gradle] = ['npm', 'pip', 'gradle'].map((d) => join(dir, d));
      for (const d of [npm, pip, join(gradle!, 'caches')]) mkdirSync(d!, { recursive: true });
      const text = [
        'Effective sandbox policy for /work/app',
        '',
        'User-configured paths:',
        '  Read-only paths (1):',
        `    ${npm}`,
        '',
        'Dev tools:',
        '  Tools detected in this directory: npm',
        '  Read-only paths (1):',
        `    ${pip}`,
        '  Read-write paths (4):',
        `    ${npm}`,
        `    ${pip}`,
        `    ${join(gradle!, 'caches')}`,
        `    ${join(dir, 'missing')}`,
        '',
        'Capabilities:',
        '  Allow sandbox bypass: no',
      ].join('\n');
      expect(copilotPolicyPaths(text, 'Dev tools')).toEqual({ 'read-only': [pip], 'read-write': [npm, pip, join(gradle!, 'caches'), join(dir, 'missing')] });
      expect(copilotPolicyPaths(text, 'User-configured paths')).toEqual({ 'read-only': [npm] });
      // Covered: the same path, or one inside a read-only folder; a missing one is left out.
      const elsewhere = [join(dir, 'not-here')];
      expect(copilotDevWrites(text, [npm, gradle!], elsewhere)).toEqual([pip]);
      expect(copilotDevWrites(text, [npm, pip, gradle!], elsewhere)).toEqual([]);
      expect(copilotDevWrites(text, [`${gradle}-other`, npm, pip], elsewhere)).toEqual([join(gradle!, 'caches')]);
      // In the temporary folder (pnpm's lock folders), where every CLI's commands may write: left out.
      expect(copilotDevWrites(text, [npm, gradle!], [dir])).toEqual([]);
      expect(copilotTempDirs({ TMPDIR: '/t' }, 'linux')).toEqual(['/t', '/tmp', '/private/tmp', '/var/tmp']);
      expect(copilotTempDirs({ TEMP: 'C:\\T' }, 'win32')).toEqual(['C:\\T']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('what a project makes Copilot run by itself', () => {
  it("finds the hook files of each working directory's .github/hooks, up to its repository's root", () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-copilot-hooks-'));
    try {
      const repo = join(root, 'repo');
      const sub = join(repo, 'pkg', 'deep');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.github', 'hooks'), { recursive: true });
      mkdirSync(join(sub, '.github', 'hooks'), { recursive: true });
      mkdirSync(join(root, '.github', 'hooks'), { recursive: true }); // above the repository: not read
      writeFileSync(join(repo, '.github', 'hooks', 'a.json'), '{}');
      writeFileSync(join(repo, '.github', 'hooks', 'notes.md'), 'not a hook');
      writeFileSync(join(sub, '.github', 'hooks', 'b.JSON'), '{}');
      writeFileSync(join(root, '.github', 'hooks', 'outer.json'), '{}');
      expect(copilotProjectHooks([sub])).toEqual([join(repo, '.github', 'hooks', 'a.json'), join(sub, '.github', 'hooks', 'b.JSON')].sort());
      // Copilot's and Claude Code's project settings, when they define hooks.
      mkdirSync(join(repo, '.github', 'copilot'), { recursive: true });
      mkdirSync(join(sub, '.claude'), { recursive: true });
      writeFileSync(join(repo, '.github', 'copilot', 'settings.json'), JSON.stringify({ hooks: { preToolUse: [{ command: 'x' }] } }));
      writeFileSync(join(repo, '.github', 'copilot', 'settings.local.json'), JSON.stringify({ model: 'x' }));
      writeFileSync(join(sub, '.claude', 'settings.local.json'), '// a comment\n' + JSON.stringify({ hooks: { PreToolUse: [] } }));
      writeFileSync(join(sub, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
      expect(copilotProjectHooks([sub])).toEqual(
        [join(repo, '.github', 'hooks', 'a.json'), join(sub, '.github', 'hooks', 'b.JSON'), join(repo, '.github', 'copilot', 'settings.json'), join(sub, '.claude', 'settings.local.json')].sort(),
      );
      // Another repository with none (one of its own: the temporary folder may be inside a repository).
      mkdirSync(join(root, 'other', '.git'), { recursive: true });
      expect(copilotProjectHooks([join(root, 'other')])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Copilot's models and what it loads by itself", () => {
  it('reads its models once each (it lists Auto twice), its default, and the default model\'s efforts', () => {
    const opened = rows('real-tools').find((r) => r.msg?.result?.models)!.msg.result;
    const parsed = parseCopilotModels(opened);
    expect(parsed.models[0]).toEqual({ id: 'auto', label: 'Auto' });
    expect(parsed.models.filter((m) => m.id === 'auto')).toHaveLength(1);
    expect(parsed.models).toContainEqual({ id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' });
    expect(parsed.current).toBe('claude-sonnet-5.5');
    expect(parsed.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(parsed.effort).toBe('medium');
    expect(parseCopilotModels(undefined)).toEqual({ models: [], efforts: [] });
  });

  it("lists its skills and MCP servers by name, its instruction files (a repository's named from its root) and plugins from its own answers", () => {
    const json = (what: string) => JSON.parse(readFileSync(join(CLI, `${what}.json`), 'utf8'));
    const repo = mkdtempSync(join(tmpdir(), 'relay-copilot-probe-repo-'));
    try {
      mkdirSync(join(repo, '.git'));
      mkdirSync(join(repo, 'sub'));
      const lists = parseCopilotProbe({ mcp: json('mcp'), skills: json('skill'), instructions: json('instruction'), plugins: json('plugin') }, join(repo, 'sub'));
      expect(lists.skills.map((s) => [s.name, s.source, s.id])).toEqual(expect.arrayContaining([['proj-skill', 'project', 'proj-skill'], ['my-skill', 'personal-copilot', 'my-skill']]));
      expect(lists.mcpServers.map((m) => [m.name, m.source, m.transport])).toEqual(expect.arrayContaining([['user-srv', 'user', 'stdio']]));
      expect(lists.memory).toEqual([
        { path: '/home/user/.copilot/copilot-instructions.md', kind: 'instructions' },
        { path: join(repo, 'AGENTS.md'), kind: 'instructions' },
      ]);
      expect(lists.plugins!.map((p) => [p.name, p.enabled])).toEqual([
        ['computer-use', false],
        ['browser-use', false],
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("marks what a run leaves out: a workspace's MCP servers always (a run trusts no folder), the rest as the run says", () => {
    const own = {
      skills: [{ name: 'a', description: '', id: 'a' }, { name: 'p', description: '', source: 'plugin', id: 'p' }],
      mcpServers: [{ name: 'user-srv', source: 'user', id: 'user-srv' }, { name: 'ws', source: 'workspace', id: 'ws' }],
      memory: [],
      hooks: [{ event: 'sessionStart', source: 'user' }, { event: 'preToolUse', source: 'project' }],
      plugins: [{ name: 'x@m' }],
    };
    const none = markLeftOut(own, copilotAsRun(own, []));
    expect(none.mcpServers.map((m) => [m.name, Boolean(m.leftOut)])).toEqual([['user-srv', false], ['ws', true]]);
    expect(none.skills.some((s) => s.leftOut)).toBe(false);
    const items = markLeftOut(own, copilotAsRun(own, [], { skills: ['a'], mcp: ['user-srv'] }), { skills: ['a'], mcp: ['user-srv'] });
    expect(items.skills.map((x) => [x.name, Boolean(x.leftOut), Boolean(x.stillLoaded)])).toEqual([['a', true, false], ['p', false, false]]);
    expect(items.mcpServers.map((m) => [m.name, Boolean(m.leftOut)])).toEqual([['user-srv', true], ['ws', true]]);
    const off = markLeftOut(own, copilotAsRun(own, ['skills', 'mcp', 'hooks', 'plugins']), { skills: ['a'] });
    expect(off.skills.every((s) => s.leftOut)).toBe(true);
    expect(off.mcpServers.every((m) => m.leftOut)).toBe(true);
    // Leaving hooks out leaves out the user's; a project's still run (after the run asks).
    expect(off.hooks!.map((h) => [h.source, Boolean(h.leftOut)])).toEqual([['user', true], ['project', false]]);
    expect(off.plugins!.every((p) => p.leftOut)).toBe(true);
    const plugins = markLeftOut(own, copilotAsRun(own, ['plugins']));
    expect(plugins.skills.map((s) => [s.name, Boolean(s.leftOut)])).toEqual([['a', false], ['p', true]]);
  });

  it("lists its hooks (the user's and the project's, never their commands) and custom agents from the files it reads", () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-copilot-native-'));
    try {
      const home = join(root, 'home');
      const repo = join(root, 'repo');
      mkdirSync(join(home, 'hooks'), { recursive: true });
      mkdirSync(join(home, 'agents'), { recursive: true });
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(join(repo, '.github', 'hooks'), { recursive: true });
      mkdirSync(join(repo, '.github', 'agents'), { recursive: true });
      writeFileSync(join(home, 'hooks', 'mine.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: 'secret-token-cmd', matcher: 'bash' }] } }));
      writeFileSync(join(home, 'settings.json'), '// comment\n' + JSON.stringify({ hooks: { sessionEnd: [{ type: 'command', bash: 'x' }] } }));
      writeFileSync(join(repo, '.github', 'hooks', 'p.json'), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'y' }] } }));
      writeFileSync(join(home, 'agents', 'reviewer.agent.md'), '---\nname: reviewer\ndescription: Reviews code\n---\nReview.');
      writeFileSync(join(repo, '.github', 'agents', 'docs.md'), 'No front matter.');
      const hooks = copilotHooks(repo, home);
      expect(hooks.map((h) => [h.event, h.matcher, h.source])).toEqual([
        ['preToolUse', 'bash', 'user'],
        ['sessionEnd', undefined, 'user'],
        ['sessionStart', undefined, 'project'],
      ]);
      expect(JSON.stringify(hooks)).not.toContain('secret-token-cmd');
      expect(copilotAgents(repo, home)).toEqual([
        { name: 'reviewer', description: 'Reviews code', source: 'user' },
        { name: 'docs', description: '', source: 'project' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("knows Copilot's errors: signed out, and an effort its model refuses", () => {
    expect(copilotSignedOut('Authentication required')).toBe(true);
    expect(copilotSignedOut('Resource not found: Session x not found')).toBe(false);
    expect(copilotEffortRefusal("session construction failed: Model 'claude-haiku-4.5' does not support reasoning effort configuration.")).toBe(true);
    expect(copilotEffortRefusal('This model does not support reasoning_effort configuration.')).toBe(true);
  });

  it("tells the model that a refusal ends its turn, and to ask the user Harness Relay's way", () => {
    expect(COPILOT_NOTES).toMatch(/ends your turn at once/);
    expect(copilotInstructions('Brief.')).toBe(`<harness-relay-briefing>\nStanding instructions from Harness Relay, the app this conversation runs in.\n\nBrief.\n\n${COPILOT_NOTES}\n</harness-relay-briefing>\n`);
  });
});

describe.skipIf(process.platform === 'win32')('a Copilot turn (with a stand-in copilot replaying recorded messages)', () => {
  let root: string;
  let bin: string;
  let n = 0;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'relay-copilot-'));
    bin = writeFakeCopilot(join(root, 'copilot'));
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

  function run(fixture: string | undefined, over: Partial<RunOptions> = {}, answer?: (req: ApprovalRequest) => ApprovalAnswer, env: NodeJS.ProcessEnv = {}): Run {
    const dir = join(root, `run-${++n}`);
    const cwd = join(dir, 'app');
    const home = join(dir, 'home');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }], trustedFolders: [cwd] }));
    const logFile = join(dir, 'log.jsonl');
    const events: AgentEvent[] = [];
    const approvals: ApprovalRequest[] = [];
    const abort = new AbortController();
    const o: RunOptions = {
      bin,
      env: {
        PATH: process.env.PATH,
        FAKE_COPILOT_LOG: logFile,
        FAKE_COPILOT_CWD: cwd,
        FAKE_COPILOT_CLI: CLI,
        ...(fixture ? { FAKE_COPILOT_FIXTURE: join(FIX, `${fixture}.jsonl`) } : {}),
        COPILOT_HOME: home,
        COPILOT_ALLOW_ALL: 'true',
        ...env,
      },
      prompt: 'Write hello.txt',
      systemPrompt: 'You are @Ada on a team.',
      cwd,
      permission: 'edit',
      signal: abort.signal,
      onEvent: (e) => events.push(e),
      protectedPaths: ['/work/secret'],
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
  const starts = (r: Run) => r.log().filter((l) => l.start);
  const text = (r: Run) => r.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');

  it('runs a turn in a home of its own, checks its sandbox, and asks it about nothing edit mode covers', async () => {
    const r = run('plain', {}, () => ({ allow: true }));
    const result = await withLang('en', () => copilotRunner.run(r.o));
    expect(result).toEqual({ sessionId: 'da742fbc-21c4-4b31-8caa-aa52f7163c96', inputTokens: 30, outputTokens: 15 });
    const start = r.log()[0]!;
    expect(start.argv).toEqual(['--acp', '--sandbox', `--secret-env-vars=${COPILOT_SECRET_VARS.join(',')}`]);
    // Its own home: not the account's, without the variable that would allow everything, gone with the run.
    expect(start.env.COPILOT_HOME).not.toBe(r.home);
    expect(start.env.COPILOT_ALLOW_ALL).toBeUndefined();
    expect(existsSync(start.env.COPILOT_HOME)).toBe(false);
    expect(Object.keys(start.files).sort()).toEqual(['config.json', 'copilot-instructions.md', 'session-state', 'session-store.db', 'settings.json']);
    expect(JSON.parse(start.files['config.json'])).toEqual({ loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }] });
    expect(start.files['copilot-instructions.md']).toContain('You are @Ada on a team.');
    expect(JSON.parse(start.files['settings.json']).sandbox).toMatchObject({ enabled: true, allowBypass: false, userPolicy: { filesystem: { deniedPaths: ['/work/secret'] } } });
    // The policy is asked for first; then the prompt.
    const prompts = r.log().filter((l) => l.method === 'session/prompt').map((l) => l.params.prompt[0].text);
    expect(prompts).toEqual(['/sandbox policy', 'Write hello.txt']);
    expect(methods(r).slice(0, 2)).toEqual(['initialize', 'session/new']);
    // The command it asked about ran without asking the user; answered allow-once.
    expect(r.approvals).toEqual([]);
    expect(r.log().filter((l) => l.result?.outcome).map((l) => l.result.outcome.optionId)).toEqual(['allow_once']);
    expect(text(r)).toBe('All done.');
    // The policy's text is not the agent's reply.
    expect(text(r)).not.toContain('Effective sandbox policy');
  });

  it('asks about a command in read-only mode; a refusal shows its note, and Copilot ends the turn there', async () => {
    const r = run('ro-deny', { permission: 'read-only' }, () => ({ allow: false, note: 'Not now' }));
    await withLang('en', () => copilotRunner.run(r.o));
    expect(r.approvals).toEqual([{ kind: 'command', detail: 'touch ro.txt' }]);
    expect(r.log().find((l) => l.result?.outcome)?.result.outcome.optionId).toBe('reject_once');
    expect(r.events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false, error: `${withLang('en', () => t().approvalDeclined)} Not now${withLang('en', () => t().copilotEndsTurn)}` });
  });

  it('refuses by itself what the permission does not cover when the conversation refuses approvals', async () => {
    const r = run('ro-auto', { permission: 'read-only' });
    await withLang('en', () => copilotRunner.run(r.o));
    expect(r.log().find((l) => l.result?.outcome)?.result.outcome.optionId).toBe('reject_once');
    expect(r.events.find((e) => e.type === 'tool_end')).toMatchObject({ ok: false, error: `${withLang('en', () => t().copilotRefused)}${withLang('en', () => t().copilotEndsTurn)}` });
  });

  it('runs everything with full access: no sandbox, allow-all, nothing asked', async () => {
    const r = run('full', { permission: 'full' }, () => ({ allow: false }));
    await copilotRunner.run(r.o);
    expect(r.log()[0]!.argv).toEqual(['--acp', '--allow-all', `--secret-env-vars=${COPILOT_SECRET_VARS.join(',')}`]);
    expect(JSON.parse(r.log()[0]!.files['settings.json']).sandbox).toEqual({ enabled: false });
    expect(r.log().filter((l) => l.method === 'session/prompt')).toHaveLength(1); // no policy to check
    expect(r.approvals).toEqual([]);
  });

  it('resumes a session with session/load, and what it replays is not this turn\'s', async () => {
    const r = run(undefined, { sessionId: 'old-1', prompt: 'And again' });
    const result = await copilotRunner.run(r.o);
    expect(result.sessionId).toBe('old-1');
    expect(r.log().find((l) => l.method === 'session/load')?.params).toMatchObject({ sessionId: 'old-1', cwd: r.o.cwd });
    expect(text(r)).toBe('hello');
  });

  it('fails a resume it cannot do before anything is shown, so the turn starts afresh', async () => {
    const r = run(undefined, { sessionId: 'missing' });
    await expect(copilotRunner.run(r.o)).rejects.toThrow(/not found/);
    expect(r.events).toEqual([]);
  });

  it("does not run below full access when Copilot's sandbox is not as the run set it up", async () => {
    const off = run(undefined, {}, undefined, { FAKE_COPILOT_POLICY: 'off' });
    await expect(withLang('en', () => copilotRunner.run(off.o))).rejects.toThrow(/Copilot's sandbox is not as Harness Relay set it up \(Command sandboxing is disabled/);
    expect(off.log().filter((l) => l.method === 'session/prompt')).toHaveLength(1);
    const dropped = run(undefined, {}, undefined, { FAKE_COPILOT_DROP_DENIED: '1' });
    await expect(copilotRunner.run(dropped.o)).rejects.toThrow(/\/work\/secret is not among its denied paths/);
    // Answered by the model rather than by Copilot itself (usage, a permission request): the turn does not run, and nothing was allowed.
    const reached = run(undefined, {}, () => ({ allow: true }), { FAKE_COPILOT_POLICY_MODEL: '1' });
    await expect(withLang('en', () => copilotRunner.run(reached.o))).rejects.toThrow(/\/sandbox policy reached the model/);
    expect(reached.log().filter((l) => l.result?.outcome).map((l) => l.result.outcome.optionId)).toEqual(['reject_once']);
    expect(reached.log().filter((l) => l.method === 'session/prompt')).toHaveLength(1);
    // Its commands may use the keychain: the same.
    const keychain = run(undefined, {}, undefined, { FAKE_COPILOT_KEYCHAIN: 'on' });
    await expect(copilotRunner.run(keychain.o)).rejects.toThrow(/Allow keychain access: on/);
  });

  it('makes a cache its dev-tool access lets commands write read-only too, starting again with it', async () => {
    // Outside every temporary folder (the system's is /tmp on Linux), where a cache would be.
    const outside = mkdtempSync(join(process.cwd(), 'node_modules', '.relay-copilot-cache-'));
    const cache = join(outside, 'npm');
    mkdirSync(cache, { recursive: true });
    onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
    const r = run(undefined, {}, undefined, { FAKE_COPILOT_DEV_WRITES: [cache, join(outside, 'missing-cache')].join(delimiter) });
    await copilotRunner.run(r.o);
    const [first, second] = starts(r);
    expect(JSON.parse(first!.files['settings.json']).sandbox.userPolicy.filesystem.readonlyPaths).not.toContain(cache);
    // Only one that exists (a missing one its sandbox would not take); nothing was sent before the second start.
    expect(JSON.parse(second!.files['settings.json']).sandbox.userPolicy.filesystem.readonlyPaths).toContain(cache);
    expect(JSON.parse(second!.files['settings.json']).sandbox.userPolicy.filesystem.readonlyPaths).not.toContain(join(outside, 'missing-cache'));
    expect(starts(r)).toHaveLength(2);
    expect(r.log().filter((l) => l.method === 'session/prompt').map((l) => l.params.prompt[0].text)).toEqual(['/sandbox policy', '/sandbox policy', r.o.prompt]);
    expect(text(r)).toBe('hello');
  });

  it("does not run below full access when Copilot does not say its allow-all is off", async () => {
    const r = run(undefined, {}, undefined, { FAKE_COPILOT_NO_ALLOW_ALL: '1' });
    await expect(withLang('en', () => copilotRunner.run(r.o))).rejects.toThrow(/its allow-all option is not reported/);
    expect(r.log().filter((l) => l.method === 'session/prompt')).toHaveLength(0);
    // With full access it is on by its flag: the turn runs.
    await copilotRunner.run({ ...r.o, permission: 'full' });
    expect(text(r)).toBe('hello');
  });

  it('gives the model and the effort as flags, and starts again without an effort its model refuses', async () => {
    const r = run(undefined, { model: 'claude-haiku-4.5', effort: 'high' }, undefined, { FAKE_COPILOT_NO_EFFORT: '1' });
    await copilotRunner.run(r.o);
    const argvs = starts(r).map((s) => s.argv.slice(3));
    expect(argvs).toEqual([['--model', 'claude-haiku-4.5', '--reasoning-effort', 'high'], ['--model', 'claude-haiku-4.5']]);
    expect(text(r)).toBe('hello');
  });

  it("runs on the user's own endpoint with Copilot's BYOK variables: the model in COPILOT_MODEL, an effort every endpoint takes", async () => {
    const backends = { apis: {}, endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://127.0.0.1:11434/v1', models: ['gemma4'], apiKey: 'k-9' }] };
    const r = run(undefined, { model: 'homelab/gemma4', effort: 'xhigh', backends });
    await copilotRunner.run(r.o);
    const start = r.log()[0]!;
    expect(start.argv).toEqual(['--acp', '--sandbox', `--secret-env-vars=${COPILOT_SECRET_VARS.join(',')}`]);
    expect(start.env).toMatchObject({ COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: 'gemma4', COPILOT_PROVIDER_API_KEY: 'k-9' });
    const high = run(undefined, { model: 'homelab/gemma4', effort: 'high', backends });
    await copilotRunner.run(high.o);
    expect(high.log()[0]!.argv.slice(3)).toEqual(['--reasoning-effort', 'high']);
    // An endpoint deleted in Settings: the model would go to Copilot's own service.
    const gone = run(undefined, { model: 'old/gemma4', backends: { ...backends, deletedEndpoints: ['old'] } });
    await expect(copilotRunner.run(gone.o)).rejects.toThrow(AgentRunError);
  });

  it('says to sign in when Copilot is not signed in', async () => {
    const r = run('signedout');
    await expect(withLang('en', () => copilotRunner.run(r.o))).rejects.toThrow(withLang('en', () => t().copilotSignIn('Authentication required')));
  });

  it('stops a turn: it cancels the session, and the run ends as stopped', async () => {
    const r = run('abort', {}, () => ({ allow: true }));
    const p = copilotRunner.run(r.o);
    await vi.waitFor(() => expect(r.events.some((e) => e.type === 'tool_start')).toBe(true));
    r.abort.abort();
    await expect(p).rejects.toMatchObject({ aborted: true });
    await vi.waitFor(() => expect(methods(r)).toContain('session/cancel'));
  });

  it("fails the turn with Copilot's error when its model call failed", async () => {
    const r = run(undefined, {}, undefined, { FAKE_COPILOT_MODEL_DOWN: '1' });
    await expect(copilotRunner.run(r.o)).rejects.toThrow('Error: Could not connect to local model provider at http://127.0.0.1:9/v1.');
    expect(r.events.some((e) => e.type === 'text')).toBe(false);
  });

  it('fails plainly when Copilot ends the turn by itself', async () => {
    const r = run(undefined, {}, undefined, { FAKE_COPILOT_CANCELLED: '1' });
    await expect(withLang('en', () => copilotRunner.run(r.o))).rejects.toThrow(withLang('en', () => t().copilotCancelled));
  });

  it('puts a session left in autopilot back in agent mode and allow-all off below full access', async () => {
    const r = run(undefined, {}, undefined, { FAKE_COPILOT_MODE: 'https://agentclientprotocol.com/protocol/session-modes#autopilot', FAKE_COPILOT_ALLOW_ALL: 'on' });
    await copilotRunner.run(r.o);
    expect(r.log().filter((l) => l.method === 'session/set_config_option').map((l) => [l.params.configId, l.params.value])).toEqual([
      ['mode', COPILOT_AGENT_MODE],
      ['allow_all', 'off'],
    ]);
  });

  it("asks before Copilot runs a project's hooks, and does not start when that is refused", async () => {
    const r = run(undefined, {}, (req) => ({ allow: req.kind !== 'other' }));
    mkdirSync(join(r.o.cwd, '.git'));
    mkdirSync(join(r.o.cwd, '.github', 'hooks'), { recursive: true });
    writeFileSync(join(r.o.cwd, '.github', 'hooks', 'h.json'), '{"version":1,"hooks":{}}');
    await expect(withLang('en', () => copilotRunner.run(r.o))).rejects.toThrow(withLang('en', () => t().copilotProjectHooksRefused(join('.github', 'hooks', 'h.json'))));
    expect(r.approvals).toEqual([{ kind: 'other', tool: expect.stringMatching(/^Copilot project hooks [0-9a-f]{16}$/), detail: join('.github', 'hooks', 'h.json'), reason: withLang('en', () => t().copilotProjectHooks) }]);
    expect(r.log()).toEqual([]); // copilot never started
    // A chat that refuses by itself (or the lead agent, which cannot ask) does not start either.
    await expect(withLang('en', () => copilotRunner.run({ ...r.o, requestApproval: undefined }))).rejects.toThrow(/hooks Copilot would run by itself/);
    expect(r.log()).toEqual([]);
    // What the hooks run beside them (a script in .github/hooks) counts toward "always allow" too.
    const tool = r.approvals[0]!.tool;
    writeFileSync(join(r.o.cwd, '.github', 'hooks', 'run.sh'), 'echo changed\n');
    await expect(copilotRunner.run(r.o)).rejects.toThrow();
    expect(r.approvals[1]!.tool).not.toBe(tool);
    // Allowed, the turn runs: its sandbox checked first, in a home and an empty folder of its own where
    // nothing runs as the session opens, and only then the turn, in the working directory.
    const allowed = { ...r, approvals: [] as ApprovalRequest[] };
    await copilotRunner.run({ ...r.o, requestApproval: async (req) => (allowed.approvals.push(req), { allow: true }) });
    expect(allowed.approvals).toHaveLength(1);
    const [check, turn] = starts(r);
    expect(check!.cwd).toContain('relay-copilot-check-');
    expect(existsSync(check!.cwd)).toBe(false); // removed once checked
    expect(Object.keys(check!.files).sort()).toEqual(['config.json', 'settings.json']);
    expect(JSON.parse(check!.files['settings.json'])).toMatchObject({ disableAllHooks: true, memory: false, sandbox: { enabled: true, allowBypass: false } });
    expect(check!.argv).toEqual(expect.arrayContaining(['--sandbox', '--disable-builtin-mcps']));
    expect(realpathSync(turn!.cwd)).toBe(realpathSync(r.o.cwd));
    const prompts = r.log().filter((l) => l.method === 'session/prompt').map((l) => l.params.prompt[0].text);
    expect(prompts).toEqual(['/sandbox policy', '/sandbox policy', r.o.prompt]);
    // Leaving hooks out does not stop a project's (Copilot runs them whatever disableAllHooks says): still asked.
    let asked = 0;
    await copilotRunner.run({ ...r.o, nativeOff: ['hooks'], requestApproval: async () => (asked++, { allow: true }) });
    expect(asked).toBe(1);
    // With full access, nothing is asked.
    await copilotRunner.run({ ...r.o, permission: 'full', requestApproval: async () => (asked++, { allow: true }) });
    expect(asked).toBe(1);
  });

  it('sends the other working directories (read-write in its sandbox), the MCP servers and the images', async () => {
    const other = join(root, `other-${n}`);
    mkdirSync(other, { recursive: true });
    const img = join(root, 'pic.png');
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = run(undefined, {
      addDirs: [other],
      mcpServers: [{ name: 'notes', transport: 'stdio', command: 'notes-mcp', args: ['--x'], url: '', env: { TOKEN: 't' }, headers: {} }],
      images: [{ path: img, mimeType: 'image/png' }],
    });
    await copilotRunner.run(r.o);
    expect(r.log()[0]!.argv).toEqual(['--acp', '--sandbox', '--add-dir', other, `--secret-env-vars=${COPILOT_SECRET_VARS.join(',')}`]);
    expect(JSON.parse(r.log()[0]!.files['settings.json']).sandbox.userPolicy.filesystem.readwritePaths).toEqual([other]);
    expect(r.log().find((l) => l.method === 'session/new')?.params.mcpServers).toEqual([{ name: 'notes', command: 'notes-mcp', args: ['--x'], env: [{ name: 'TOKEN', value: 't' }] }]);
    const prompt = r.log().filter((l) => l.method === 'session/prompt').at(-1)!.params.prompt;
    expect(prompt.map((b: any) => b.type)).toEqual(['text', 'image']);
  });

  it("refuses to start below full access when a protected path's name is a pattern", async () => {
    const r = run(undefined, { protectedPaths: ['/work/se*cret'] });
    await expect(withLang('en', () => copilotRunner.run(r.o))).rejects.toThrow(withLang('en', () => t().protectedPattern('/work/se*cret')));
  });

  it('asks Copilot for its models in a home and empty folder of its own, never keeping the session', async () => {
    const r = run(undefined);
    const { opened } = await askCopilotModels(bin, r.o.env);
    expect(parseCopilotModels(opened).current).toBe('claude-sonnet-5.5');
    const start = r.log()[0]!;
    expect(start.argv).toEqual(['--acp']);
    expect(start.env.COPILOT_HOME).not.toBe(r.home);
    expect(Object.keys(start.files).sort()).toEqual(['config.json', 'settings.json']);
    expect(start.cwd).not.toContain(r.o.cwd);
    expect(existsSync(start.env.COPILOT_HOME)).toBe(false);
    const models = await discoverModels('copilot', bin, r.o.env, { configured: [], endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://x/v1', models: ['gemma4'], hasKey: false }] as any });
    expect(models.models.map((m) => m.id)).toEqual(['auto', 'claude-sonnet-5.5', 'claude-haiku-4.5', 'homelab/gemma4']);
    expect(models.models.at(-1)).toMatchObject({ endpoint: 'homelab', efforts: ['low', 'medium', 'high'] });
    expect(models).toMatchObject({ cliDefaultModel: 'claude-sonnet-5.5', cliDefaultEffort: 'medium', efforts: ['low', 'medium', 'high'], source: 'cli' });
  });

  it("asks Copilot what it loads by itself in the account's home, and marks what the account's runs leave out", async () => {
    const r = run(undefined);
    const service = new NativeSetupService({ bin: () => bin, env: () => r.o.env, nativeOff: () => ['mcp'], nativeItems: () => ({ skills: ['my-skill'] }) });
    const probe = await service.get('copilot', r.o.cwd);
    expect(probe).toMatchObject({ provider: 'copilot', memoryFromFiles: false, asRun: true, nativeOff: ['mcp'], problems: [] });
    expect(probe.mcpServers.length).toBeGreaterThan(0);
    expect(probe.mcpServers.every((m) => m.leftOut)).toBe(true);
    // A single skill left out is left out of the runs too (their settings' disabledSkills), so it is not still loaded.
    const skill = probe.skills.find((s) => s.name === 'my-skill');
    expect(skill).toMatchObject({ id: 'my-skill', leftOut: true });
    expect(skill?.stillLoaded).toBeUndefined();
    // Each list was asked in the account's home and the working directory, with no variable that would allow everything.
    const asks = starts(r).map((s) => s.argv.join(' ')).sort();
    expect(asks).toEqual(['instruction list --json', 'mcp list --json', 'plugin list --json', 'skill list --json']);
    for (const s of starts(r)) {
      expect(s.env.COPILOT_HOME).toBe(r.home);
      expect(s.env.COPILOT_ALLOW_ALL).toBeUndefined();
    }
  });

  it('signs out with its ACP logout, and says what went wrong when that fails', async () => {
    const r = run(undefined);
    await copilotLogout(bin, r.o.env);
    expect(methods(r)).toEqual(['initialize', 'logout']);
    const bad = run(undefined, {}, undefined, { FAKE_COPILOT_LOGOUT_FAIL: '1' });
    await expect(copilotLogout(bin, bad.o.env)).rejects.toThrow('keychain locked');
  });
});
