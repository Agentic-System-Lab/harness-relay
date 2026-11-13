import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A data folder of its own: each turn's config folder goes in it (`museRunsDir`).
const dataDir = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  process.env.RELAY_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'relay-muse-data-')));
  return process.env.RELAY_DATA_DIR;
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

import {
  MUSE_EFFORTS,
  MUSE_KEPT_SETTINGS,
  MUSE_MOUNT_POINTS,
  MUSE_NOTES,
  MUSE_PROFILE,
  MUSE_RUN_PREFIX,
  MUSE_WINDOWS_BRIEFING_MAX,
  briefingOnCommandLine,
  createMuseUpdateHandler,
  missingMountPoints,
  museApprovalRequest,
  museArgs,
  museBriefing,
  museCommand,
  museCommandResult,
  museConfigBase,
  museDataBase,
  museEnv,
  museGrant,
  museKeyOnly,
  museMode,
  musePaths,
  musePermissionDecision,
  musePermissions,
  museProbeEnv,
  musePromptText,
  museRunSettings,
  museReminderSwitches,
  museRunner,
  museRunsDir,
  museTrust,
  prepareMuseRun,
  putBackAuth,
  rememberMuseSession,
  removeEmptyMountPoints,
  type MuseToolCall,
} from '../src/server/agents/muse';
import { AgentRunError, type AgentEvent, type ApprovalRequest, type RunOptions } from '../src/server/agents/types';
import { t, withLang } from '../src/server/i18n';
import { discoverModels, discoverMuse, MUSE_CATALOG } from '../src/server/models';
import { museHooks, museMcpServers, parseMuseSkills } from '../src/server/native';
import { relayTmpDir, RUN_TMP_PREFIXES } from '../src/server/protect';
import { MUSE_HOME_ENV, MUSE_KEY_ONLY_ENV } from '../src/server/settings';
import { isEndpointCli, type ApprovalAnswer } from '../src/shared/types';
import { writeFakeMuse } from './fake-muse';
import { slow } from './timeouts';

/*
 * The Muse Code adapter (src/server/agents/muse.ts), against messages the real `muse acp` (1.4.18) sent
 * when Harness Relay's adapter drove it on a stand-in Meta API key and model (test/fixtures/muse/,
 * scrubbed: the working directory is /work/app, a folder outside it /work/outside, another working
 * directory /work/extra), replayed through a stand-in (test/fake-muse.ts). Its listings (`muse usage`,
 * `skills list --json`…) are recorded too (test/fixtures/muse/cli/).
 */
const FIX = fileURLToPath(new URL('./fixtures/muse/', import.meta.url));
const CLI = join(FIX, 'cli');
const CWD = '/work/app';

const rows = (name: string) =>
  readFileSync(join(FIX, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);

/** The session updates a recording's agent sent, in order. */
const updatesOf = (name: string) => rows(name).flatMap((r) => (r.dir === 'agent->client' && r.msg?.method === 'session/update' ? [r.msg.params.update] : []));

/** The first call a recording's agent told of. */
const firstCall = (name: string) => updatesOf(name).find((u) => u.sessionUpdate === 'tool_call')!;

const read = (path: string): MuseToolCall => ({ name: 'read_file', kind: 'read', title: `read_file ${path}`, rawInput: { path }, locations: [{ path }] });
const write = (path: string): MuseToolCall => ({ name: 'write_file', kind: 'edit', title: `write_file ${path}`, rawInput: { path, content: 'x' }, locations: [{ path }] });
const bash = (command: string, description = 'Run the requested command'): MuseToolCall => ({ name: 'bash', kind: 'execute', title: `bash ${command}`, rawInput: { command, description } });
const fetch = (url: string): MuseToolCall => ({ name: 'web_fetch', kind: 'fetch', title: `web_fetch ${url}`, rawInput: { url } });

describe("Muse Code's permission policy (its own sandbox runs the commands below full access)", () => {
  const shield = ['/work/browser/Cookies'];

  it('read-only: runs reads (inside the working directory or not) and web fetches and searches, asks about every command, every write and anything else', () => {
    expect(musePermissionDecision('read-only', read('/work/app/a.ts'), CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('read-only', read('/etc/hosts'), CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('read-only', fetch('http://example.com/'), CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('read-only', { name: 'web_search', title: 'web_search x', rawInput: { query: 'x' } }, CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('read-only', bash('cat a.txt'), CWD)).toEqual({ run: 'ask' });
    expect(musePermissionDecision('read-only', bash('echo hi'), CWD)).toEqual({ run: 'ask' });
    expect(musePermissionDecision('read-only', write('/work/app/a.ts'), CWD)).toEqual({ run: 'ask' });
    expect(musePermissionDecision('read-only', { name: 'mcp__docs__search', kind: 'other', title: 'docs search', rawInput: { query: 'x' } }, CWD)).toEqual({ run: 'ask' });
    // A search of files runs where it says where it searches; one that does not say could be of a protected folder.
    expect(musePermissionDecision('read-only', { name: 'search', kind: 'search', rawInput: { path: '/work/app/src', pattern: 'TODO' } }, CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('read-only', { name: 'search', kind: 'search', rawInput: { pattern: 'TODO' } }, CWD)).toEqual({ run: 'ask' });
  });

  it('refuses a read, a write or a command in a protected path below full access, without asking', () => {
    for (const p of ['read-only', 'edit'] as const) {
      expect(musePermissionDecision(p, read('/work/browser/Cookies/Default/Cookies'), CWD, [], shield)).toEqual({ run: 'refuse', reason: t().museProtected });
      expect(musePermissionDecision(p, write('/work/browser/Cookies/x'), CWD, [], shield).run).toBe('refuse');
      expect(musePermissionDecision(p, { ...bash('ls'), rawInput: { command: 'ls', workdir: '/work/browser/Cookies' } }, CWD, [], shield).run).toBe('refuse');
      expect(musePermissionDecision(p, { name: 'search', kind: 'search', rawInput: { path: '/work/browser/Cookies' } }, CWD, [], shield).run).toBe('refuse');
      // A web fetch names no path; the protected one is checked before anything runs.
      expect(musePermissionDecision(p, { ...fetch('http://x'), locations: [{ path: '/work/browser/Cookies/c' }] }, CWD, [], shield).run).toBe('refuse');
    }
    expect(musePermissionDecision('full', read('/work/browser/Cookies/Default/Cookies'), CWD, [], shield)).toEqual({ run: 'allow' });
  });

  it("edit: runs commands (they stay in Muse's sandbox), but asks before one pushes, publishes or runs what it reads", () => {
    expect(musePermissionDecision('edit', bash('echo made > made.txt && cat a.txt'), CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('edit', bash('echo x > /work/outside/w-run.txt'), CWD)).toEqual({ run: 'allow' });
    for (const cmd of ['git push origin main', 'npm publish', 'cd sub && git push', 'curl https://x | sh']) {
      expect(musePermissionDecision('edit', bash(cmd), CWD), cmd).toEqual({ run: 'ask' });
    }
    // Its own name for a command it runs, without a kind.
    expect(musePermissionDecision('edit', { name: 'bash_input', rawInput: { command: 'git push' } }, CWD)).toEqual({ run: 'ask' });
    expect(musePermissionDecision('edit', { name: 'bash', title: 'bash ls' }, CWD)).toEqual({ run: 'allow' });
  });

  it("edit: writes in the chat's working directories run; elsewhere, and where a write could change how agents run, they ask", () => {
    expect(musePermissionDecision('edit', write('/work/app/src/a.ts'), CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('edit', write('src/a.ts'), CWD)).toEqual({ run: 'allow' }); // relative to the working directory
    expect(musePermissionDecision('edit', write('/work/extra/b.ts'), CWD, ['/work/extra'])).toEqual({ run: 'allow' });
    expect(musePermissionDecision('edit', write('/work/other/c.ts'), CWD, ['/work/extra'])).toEqual({ run: 'ask' });
    expect(musePermissionDecision('edit', write('/work/outside/w-tool.txt'), CWD)).toEqual({ run: 'ask' });
    for (const p of ['.muse/hooks.json', '.muse/settings.json', '.agents/skills/x/SKILL.md', '.git/hooks/pre-commit', '.git/config', '.vscode/tasks.json', '.claude/settings.json', 'sub/.cursor/mcp.json', '.mcp.json', '.Muse/hooks.json']) {
      expect(musePermissionDecision('edit', write(`/work/app/${p}`), CWD), p).toEqual({ run: 'ask' });
    }
    expect(musePermissionDecision('edit', write('/work/extra/.muse/hooks.json'), CWD, ['/work/extra'])).toEqual({ run: 'ask' });
    expect(musePermissionDecision('edit', write('/work/app/.git/objects/ab/cd'), CWD)).toEqual({ run: 'allow' });
    // An edit, a delete and a move are writes too; one whose path it cannot tell asks.
    expect(musePermissionDecision('edit', { name: 'edit_file', kind: 'edit', rawInput: { file_path: '/work/app/a.ts' } }, CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('edit', { kind: 'delete', locations: [{ path: '/work/outside/a.ts' }] }, CWD)).toEqual({ run: 'ask' });
    expect(musePermissionDecision('edit', { name: 'write_file', kind: 'edit', rawInput: { content: 'x' } }, CWD)).toEqual({ run: 'ask' });
    // A call about two files: one outside the working directory decides for both.
    expect(musePermissionDecision('edit', { kind: 'move', locations: [{ path: '/work/app/a.ts' }, { path: '/elsewhere/b.ts' }] }, CWD)).toEqual({ run: 'ask' });
    expect(musePermissionDecision('edit', { kind: 'move', locations: [{ path: '/work/app/a.ts' }, { path: '/work/app/b.ts' }] }, CWD)).toEqual({ run: 'allow' });
    // Anything else asks.
    expect(musePermissionDecision('edit', { name: 'mcp__docs__write', kind: 'other' }, CWD)).toEqual({ run: 'ask' });
  });

  it.skipIf(process.platform === 'win32')('edit: takes a link out of the working directory for where it leads', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-muse-link-')));
    try {
      mkdirSync(join(dir, 'app'));
      mkdirSync(join(dir, 'outside'));
      symlinkSync(join(dir, 'outside'), join(dir, 'app', 'out'));
      expect(musePermissionDecision('edit', write(join(dir, 'app', 'out', 'x.ts')), join(dir, 'app'))).toEqual({ run: 'ask' });
      expect(musePermissionDecision('edit', write(join(dir, 'app', 'in.ts')), join(dir, 'app'))).toEqual({ run: 'allow' });
      // A protected folder reached through a link is still refused.
      expect(musePermissionDecision('read-only', read(join(dir, 'app', 'out', 'secret')), join(dir, 'app'), [], [join(dir, 'outside')]).run).toBe('refuse');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('full: approves everything', () => {
    for (const call of [bash('git push'), write('/elsewhere/x'), { kind: 'other', name: 'swarm' }, read('/work/browser/Cookies/x')]) {
      expect(musePermissionDecision('full', call, CWD, [], shield)).toEqual({ run: 'allow' });
    }
  });

  it('reads what a call is about: its command (from its title when its input does not say) and every path it names, once', () => {
    expect(museCommand(bash('ls -la'))).toBe('ls -la');
    expect(museCommand({ title: 'bash ls -la' })).toBe('ls -la');
    expect(museCommand({ title: 'Run the requested command' })).toBe('Run the requested command');
    expect(musePaths({ rawInput: { path: 'a.ts', file_path: '/x/b.ts', workdir: '/x' }, locations: [{ path: '/x/b.ts' }, { path: '/x/c.ts' }, {}] })).toEqual(['a.ts', '/x/b.ts', '/x', '/x/c.ts']);
    expect(musePaths({ rawInput: { path: '' } })).toEqual([]);
  });

  it('describes what it asks about: why a command asks, where a write goes, what a fetch reaches', () => {
    withLang('en', () => {
      expect(museApprovalRequest('edit', bash('git push origin main'), CWD)).toEqual({ kind: 'command', detail: 'git push origin main', reason: t().musePublish });
      expect(museApprovalRequest('read-only', bash('cat a.txt', 'Show the file'), CWD)).toEqual({ kind: 'command', detail: 'cat a.txt', reason: 'Show the file' });
      expect(museApprovalRequest('read-only', { name: 'bash', kind: 'execute', rawInput: { command: 'ls' } }, CWD)).toEqual({ kind: 'command', detail: 'ls', reason: t().museCommandAsked });
      expect(museApprovalRequest('read-only', write('/work/app/a.ts'), CWD)).toEqual({ kind: 'edit', detail: '/work/app/a.ts', reason: 'write_file /work/app/a.ts' });
      expect(museApprovalRequest('edit', write('/work/outside/x.ts'), CWD)).toEqual({ kind: 'edit', detail: '/work/outside/x.ts', reason: t().museOutsideWrite });
      expect(museApprovalRequest('edit', write('/work/extra/x.ts'), CWD, ['/work/extra'])).toEqual({ kind: 'edit', detail: '/work/extra/x.ts', reason: t().museConfigWrite });
      expect(museApprovalRequest('edit', write('.git/hooks/pre-commit'), CWD)).toEqual({ kind: 'edit', detail: '.git/hooks/pre-commit', reason: t().museConfigWrite });
      expect(museApprovalRequest('edit', { name: 'write_file', kind: 'edit' }, CWD)).toEqual({ kind: 'edit', detail: undefined, reason: t().museOutsideWrite });
      expect(museApprovalRequest('read-only', fetch('http://example.com/'), CWD)).toEqual({ kind: 'fetch', detail: 'http://example.com/', reason: 'web_fetch http://example.com/' });
      expect(museApprovalRequest('read-only', { name: 'web_search', title: 'web_search muse', rawInput: { query: 'muse' } }, CWD)).toMatchObject({ kind: 'fetch', detail: 'muse' });
      expect(museApprovalRequest('read-only', { name: 'mcp__docs__search', kind: 'other', title: 'docs search', rawInput: { query: 'Look around' } }, CWD)).toEqual({
        kind: 'other',
        tool: 'mcp__docs__search',
        detail: 'Look around',
        reason: 'docs search',
      });
      // A path is shown whole (where it starts matters), and a call without input shows what Muse said of it.
      const long = `/work/app/${'deep/'.repeat(40)}x.ts`;
      expect(museApprovalRequest('read-only', { kind: 'other', name: 'x', rawInput: { path: long } }, CWD).detail).toBe(long);
      expect(museApprovalRequest('read-only', { kind: 'other', content: [{ type: 'content', content: { type: 'text', text: 'what it does' } }] }, CWD)).toMatchObject({ tool: 'other', detail: 'what it does' });
    });
  });
});

describe('its shell tool on Windows', () => {
  // On Windows Muse's shell tool is `powershell` (seen with muse 1.4.18), not of kind `execute`.
  const ps = (command: string) => ({ toolCallId: 'p1', name: 'powershell', title: `powershell ${command}`, rawInput: { command, description: 'Run it' } });

  it('is a command: asked in read-only, run in edit unless it publishes, its card a command', () => {
    expect(musePermissionDecision('read-only', ps('Get-Content a.txt'), CWD)).toEqual({ run: 'ask' });
    expect(musePermissionDecision('edit', ps('echo made > made.txt; Get-Content a.txt'), CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('edit', ps('git push origin main'), CWD)).toEqual({ run: 'ask' });
    expect(withLang('en', () => museApprovalRequest('read-only', ps('Get-Content a.txt'), CWD))).toMatchObject({ kind: 'command', detail: 'Get-Content a.txt' });
  });

  it('shows as Shell, with its command', () => {
    const events: AgentEvent[] = [];
    const h = createMuseUpdateHandler((e) => events.push(e));
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'p1', name: 'powershell', title: 'powershell Get-Content a.txt', status: 'pending', rawInput: { command: 'Get-Content a.txt' } });
    expect(events).toContainEqual({ type: 'tool_start', id: 'p1', name: 'Shell', detail: 'Get-Content a.txt' });
  });
});

describe("a command's network", () => {
  // Muse asks about a command's network after an update titled `network <command>` (`MuseToolCall.network`).
  const net = (command: string): MuseToolCall => ({ ...bash(command), network: true });

  it('asks the user, in edit too, where the command itself would have run; never with full access', () => {
    expect(musePermissionDecision('edit', bash('curl http://example.com/'), CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('edit', net('curl http://example.com/'), CWD)).toEqual({ run: 'ask' });
    expect(musePermissionDecision('read-only', net('curl http://example.com/'), CWD)).toEqual({ run: 'ask' });
    expect(musePermissionDecision('full', net('curl http://example.com/'), CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('edit', { ...net('Invoke-WebRequest x'), name: 'powershell', kind: undefined }, CWD)).toEqual({ run: 'ask' });
    // Its own web tools run, as they do without it; a protected path is refused before anything.
    expect(musePermissionDecision('edit', { ...fetch('http://example.com/'), network: true }, CWD)).toEqual({ run: 'allow' });
    expect(musePermissionDecision('edit', { ...net('curl x'), rawInput: { command: 'curl x', workdir: '/work/browser/Cookies' } }, CWD, [], ['/work/browser/Cookies']).run).toBe('refuse');
  });

  it("shows the user the command whose network it asks about, with why", () => {
    withLang('en', () => {
      expect(museApprovalRequest('edit', net("curl -s http://example.com/"), CWD)).toEqual({ kind: 'fetch', detail: 'curl -s http://example.com/', reason: t().museNetwork });
      expect(museApprovalRequest('read-only', { name: 'bash', title: 'network curl x', network: true }, CWD)).toEqual({ kind: 'fetch', detail: 'network curl x', reason: t().museNetwork });
    });
  });

  it('is told by the update just before Muse asks, and over once the call goes on', () => {
    const updates = updatesOf('edit-net');
    const id = firstCall('edit-net').toolCallId;
    const at = updates.findIndex((u) => typeof u.title === 'string' && u.title.startsWith('network '));
    expect(at).toBeGreaterThan(0);
    const h = createMuseUpdateHandler(() => undefined);
    for (const u of updates.slice(0, at)) h.handle(u);
    expect(h.call(id).network).toBeUndefined();
    h.handle(updates[at]);
    // Its command and title are still the call's own.
    expect(h.call(id)).toMatchObject({ network: true, title: 'Run the requested command', rawInput: { command: "curl -s -o /dev/null -w '%{http_code}' http://example.com/" } });
    for (const u of updates.slice(at + 1)) h.handle(u);
    expect(h.call(id).network).toBe(false);
    // A later update with a title and a status ends it; one with neither leaves it.
    const k = createMuseUpdateHandler(() => undefined);
    k.handle({ sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'curl x' } });
    k.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'network curl x' });
    k.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'Run it' });
    expect(k.call('c1').network).toBe(true);
    k.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'Run it', status: 'in_progress' });
    expect(k.call('c1').network).toBe(false);
  });
});

describe('Muse Code session updates', () => {
  const play = (name: string, refused: [string, string][] = []) =>
    withLang('en', () => {
      const events: AgentEvent[] = [];
      const h = createMuseUpdateHandler((e) => events.push(e));
      for (const [id, label] of refused) h.refused(id, label);
      for (const u of updatesOf(name)) h.handle(u);
      h.finish();
      return events;
    });
  const tools = (events: AgentEvent[]) =>
    events.flatMap((e) => (e.type === 'tool_start' ? [[e.type, e.name, e.detail]] : e.type === 'tool_end' ? [[e.type, e.ok, e.error, e.output]] : []));

  it('streams its thinking and reply, the text closed before each call and at the end', () => {
    expect(play('plain')).toEqual([{ type: 'thinking', text: 'Thinking about the request.' }, { type: 'text', text: 'pong' }, { type: 'text_end' }]);
    const events = play('edit-run');
    expect(events.slice(0, 4)).toEqual([
      { type: 'thinking', text: 'Thinking about the request.' },
      { type: 'text', text: 'Running it.' },
      { type: 'text_end' },
      { type: 'tool_start', id: '01a1d2b6-411d-7a63-95a3-52757b704df0', name: 'Shell', detail: 'echo made > made.txt && cat a.txt' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'text_end' });
  });

  it("shows each call once, with a command's output from the JSON Muse reports it in", () => {
    expect(tools(play('edit-run'))).toEqual([
      ['tool_start', 'Shell', 'echo made > made.txt && cat a.txt'],
      ['tool_end', true, undefined, 'hello'],
    ]);
    // Exit code 0 although the command's own redirection failed: what it printed is its output.
    expect(tools(play('edit-ask'))).toEqual([
      ['tool_start', 'Shell', 'echo x > /work/outside/w-run.txt; echo rc=$?'],
      ['tool_end', true, undefined, '/bin/sh: /work/outside/w-run.txt: Operation not permitted\nrc=1'],
    ]);
    expect(tools(play('ro-fetch'))).toEqual([
      ['tool_start', 'Fetch', 'http://example.com/'],
      ['tool_end', true, undefined, expect.stringContaining('Example Domain')],
    ]);
    expect(tools(play('edit-write'))).toEqual([
      ['tool_start', 'Edit', 'w-inside.txt'],
      ['tool_end', true, undefined, 'wrote 6 bytes to /work/app/w-inside.txt'],
    ]);
  });

  it("shows a command's non-zero exit as failed, with what it printed, and a stopped one with Muse's reason", () => {
    expect(tools(play('edit-decline'))).toEqual([
      ['tool_start', 'Shell', 'echo x > /work/outside/w-run2.txt'],
      ['tool_end', false, 'exit code 1', '/bin/sh: /work/outside/w-run2.txt: Operation not permitted'],
    ]);
    expect(tools(play('protected-cmd')).at(-1)).toEqual(['tool_end', false, 'exit code 1', 'cat: /work/outside/secret.txt: Operation not permitted']);
    expect(tools(play('abort'))).toEqual([
      ['tool_start', 'Shell', 'sleep 40; echo slept'],
      ['tool_end', false, 'cancelled by tool cancellation', undefined],
    ]);
  });

  it('gives a call that failed its reason, also when the reason comes in a later update than the failure', () => {
    // read-only: the call is reported failed at once, its reason only in the next update.
    const early = updatesOf('ro-write');
    expect(early.find((u) => u.sessionUpdate === 'tool_call')).toMatchObject({ status: 'failed' });
    expect(early.find((u) => u.sessionUpdate === 'tool_call')!.content).toBeUndefined();
    const [start, end] = tools(play('ro-write'));
    expect(start).toEqual(['tool_start', 'Edit', 'ro.txt']);
    expect(end).toEqual(['tool_end', false, expect.stringMatching(/^tool unavailable: unknown tool `write_file`/), undefined]);
    expect(tools(play('edit-outside'))).toEqual([
      ['tool_start', 'Edit', '/work/outside/w-tool.txt'],
      ['tool_end', false, 'tool failed: absolute path is outside the workspace', undefined],
    ]);
    expect(tools(play('protected'))).toEqual([
      ['tool_start', 'Read', '/work/outside/secret.txt'],
      ['tool_end', false, 'tool failed: absolute path is outside the workspace', undefined],
    ]);
  });

  it('shows why a refused call was refused, not the words Muse gives the model', () => {
    const id = firstCall('edit-config').toolCallId;
    expect(tools(play('edit-config', [[id, 'Declined: no hooks']]))).toEqual([
      ['tool_start', 'Edit', '.git/hooks/pre-commit'],
      ['tool_end', false, 'Declined: no hooks', undefined],
    ]);
    const auto = firstCall('ro-auto').toolCallId;
    expect(tools(play('ro-auto', [[auto, 'Refused']])).at(-1)).toEqual(['tool_end', false, 'Refused', undefined]);
  });

  it('remembers what each call is about, for a permission request that names it by id only', () => {
    const h = createMuseUpdateHandler(() => undefined);
    for (const u of updatesOf('edit-run')) h.handle(u);
    expect(h.call('01a1d2b6-411d-7a63-95a3-52757b704df0')).toEqual({
      toolCallId: '01a1d2b6-411d-7a63-95a3-52757b704df0',
      name: 'bash',
      kind: 'execute',
      // The first title names the call; the later ones are its description.
      title: 'bash echo made > made.txt && cat a.txt',
      rawInput: { command: 'echo made > made.txt && cat a.txt', description: 'Run the requested command' },
      content: expect.any(Array),
    });
    expect(h.call('nope')).toEqual({ toolCallId: 'nope' });
  });

  it('shows its plan, a call reported only once it is over, and a call left waiting at the end of the turn', () => {
    const events: AgentEvent[] = [];
    const h = createMuseUpdateHandler((e) => events.push(e));
    h.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Plan:' } });
    h.handle({ sessionUpdate: 'plan', entries: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'in_progress' }, { content: 'Test', status: 'pending' }, { content: 'Ship', status: 'later' }] });
    h.handle({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'r1', name: 'read_file', kind: 'read', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'no such file' } }] });
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' }); // over already: not shown again
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'w1', name: 'write_file', kind: 'edit', status: 'failed', rawInput: { path: 'x' } });
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'b1', name: 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'false' } });
    withLang('en', () => h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'b1', status: 'completed', rawOutput: JSON.stringify({ command: 'false', exit_code: 2, terminal_status: 'completed', output: '' }) }));
    h.handle({ sessionUpdate: 'usage_update', used: 1 });
    h.handle(undefined);
    withLang('en', () => h.finish());
    expect(events).toEqual([
      { type: 'text', text: 'Plan:' },
      {
        type: 'plan',
        entries: [
          { text: 'Read', status: 'completed' },
          { text: 'Write', status: 'in_progress' },
          { text: 'Test', status: 'pending' },
          { text: 'Ship', status: 'pending' },
        ],
      },
      { type: 'text_end' },
      { type: 'thinking', text: 'hmm' },
      { type: 'tool_start', id: 'r1', name: 'Read' },
      { type: 'tool_end', id: 'r1', ok: false, error: 'no such file' },
      { type: 'tool_start', id: 'w1', name: 'Edit', detail: 'x' },
      { type: 'tool_start', id: 'b1', name: 'Shell', detail: 'false' },
      { type: 'tool_end', id: 'b1', ok: false, error: 'exit code 2' },
      // Its reason never came: closed with the turn.
      { type: 'tool_end', id: 'w1', ok: false },
    ]);
  });

  it("reads a command's result from Muse's JSON report of it", () => {
    expect(museCommandResult('{"command":"ls","exit_code":0,"terminal_status":"completed","output":"a\\n"}')).toEqual({ output: 'a\n', exitCode: 0, status: 'completed', reason: undefined });
    expect(museCommandResult({ exit_code: 1, terminal_status: 'failed', terminal_reason: 'The sandbox blocked a write' })).toEqual({
      output: undefined,
      exitCode: 1,
      status: 'failed',
      reason: 'The sandbox blocked a write',
    });
    expect(museCommandResult({ terminal_status: 'cancelled', output: '' })).toMatchObject({ output: '', status: 'cancelled', exitCode: undefined });
    expect(museCommandResult('hello\n')).toBeUndefined(); // the output while it runs, not its report
    expect(museCommandResult('{"chunk_id":"x"}')).toBeUndefined();
    expect(museCommandResult(['x'])).toBeUndefined();
    expect(museCommandResult(undefined)).toBeUndefined();
  });
});

describe("Muse Code's settings for one run", () => {
  it('gives below full access a profile of its own, from :ask-me, with a deny rule for each protected path; full access, :unrestricted', () => {
    expect(musePermissions('edit', ['/p/cookies', '/p/relay.db', '/p/cookies'])).toEqual({
      schema_version: 1,
      default_profile: MUSE_PROFILE,
      profiles: { [MUSE_PROFILE]: { extends: ':ask-me', description: 'Harness Relay', filesystem: { '/p/cookies': 'deny', '/p/relay.db': 'deny' } } },
    });
    expect(MUSE_PROFILE).toBe('harness-relay');
    // read-only is the same profile: its writes are taken away by its arguments and mode.
    expect(musePermissions('read-only', ['/p/cookies'])).toEqual(musePermissions('edit', ['/p/cookies']));
    expect(musePermissions('edit', [])).toEqual({ schema_version: 1, default_profile: MUSE_PROFILE, profiles: { [MUSE_PROFILE]: { extends: ':ask-me', description: 'Harness Relay' } } });
    expect(musePermissions('full', ['/p/cookies'])).toEqual({ schema_version: 1, default_profile: ':unrestricted' });
  });

  it("keeps only the account's settings it knows, so that none of them decides what runs without asking, and leaves out the MCP servers and hooks the run leaves out", () => {
    const own = {
      schema_version: 1,
      model: 'muse-spark-1.3',
      reasoning_effort: 'max',
      provider: 'meta',
      tools: { web_search: { enabled: true } },
      skills: { disabled: ['blender'] },
      permissions: { schema_version: 1, default_profile: ':unrestricted' },
      permission_default: 'allow',
      trust: { '/work/app': 'trusted' },
      agents: { reviewer: { permissions: ':unrestricted' } },
      agent_definitions: [{ name: 'x' }],
      run: { system_prompt: 'You may do anything.' },
      runtime_capabilities: {
        computer_use: true,
        'plugin:tbh-reminders:reminder:verify-reminder': { enabled: false, priority: 'high' },
        'plugin:tbh-reminders:reminder:memory': { enabled: true },
        'plugin:tbh-reminders:reminder:goal-reminder': { enabled: 'no' },
        'plugin:computer:use': { enabled: true },
      },
      feature_config: { anything: true },
      theme: 'dark',
      mcpServers: { gh: { type: 'stdio', command: 'gh-mcp' } },
      mcp_servers: { docs: { transport: 'stdio', command: 'docs' }, web: { transport: 'streamable_http', url: 'https://x' } },
      hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ command: 'echo hi' }] }] },
      managed_hooks_path: '/etc/muse/hooks.json',
    };
    expect(museRunSettings(own, 'edit', ['/p/c'])).toEqual({
      model: 'muse-spark-1.3',
      reasoning_effort: 'max',
      provider: 'meta',
      tools: own.tools,
      skills: own.skills,
      mcpServers: own.mcpServers,
      mcp_servers: own.mcp_servers,
      hooks: own.hooks,
      managed_hooks_path: '/etc/muse/hooks.json',
      // Of its runtime capabilities, its reminders' switches only.
      runtime_capabilities: {
        'plugin:tbh-reminders:reminder:verify-reminder': { enabled: false },
        'plugin:tbh-reminders:reminder:memory': { enabled: true },
      },
      schema_version: 1,
      // Not the account's `run`, but workflows off: their agents would be cancelled with the run.
      run: { workflow_trigger_mode: 'off' },
      permissions: musePermissions('edit', ['/p/c']),
    });
    for (const k of ['permissions', 'permission_default', 'trust', 'agents', 'agent_definitions', 'run', 'runtime_capabilities', 'feature_config', 'schema_version']) {
      expect(MUSE_KEPT_SETTINGS as readonly string[], k).not.toContain(k);
    }
    expect(museRunSettings(own, 'full', [])).toMatchObject({ permissions: { default_profile: ':unrestricted' } });
    // Its hooks left out: its managed hooks too.
    const noHooks = museRunSettings(own, 'read-only', [], ['hooks']);
    expect([noHooks.hooks, noHooks.managed_hooks_path]).toEqual([undefined, undefined]);
    expect(noHooks.mcp_servers).toEqual(own.mcp_servers);
    // Its MCP servers left out: from both places it keeps them in (`muse mcp add` writes `mcpServers`).
    const noMcp = museRunSettings(own, 'edit', [], ['mcp']);
    expect(Object.keys(noMcp)).toEqual(expect.not.arrayContaining(['mcpServers', 'mcp_servers']));
    expect(noMcp.hooks).toEqual(own.hooks);
    // A server by its name, in either place.
    const some = museRunSettings(own, 'edit', [], [], { mcp: ['docs', 'gh'] });
    expect([some.mcpServers, some.mcp_servers]).toEqual([{}, { web: own.mcp_servers.web }]);
    // All of them left out wins over single ones.
    expect(museRunSettings(own, 'edit', [], ['mcp'], { mcp: ['docs'] }).mcp_servers).toBeUndefined();
    // The account's own settings are never changed.
    expect(own.permission_default).toBe('allow');
    expect(Object.keys(own.mcpServers)).toEqual(['gh']);
    // None, or not settings: Muse's defaults, with Harness Relay's permissions.
    expect(museRunSettings(undefined, 'edit', [])).toEqual({ schema_version: 1, run: { workflow_trigger_mode: 'off' }, permissions: musePermissions('edit', []) });
    expect(museRunSettings([1, 2], 'full', [])).toEqual({ schema_version: 1, run: { workflow_trigger_mode: 'off' }, permissions: musePermissions('full', []) });
    expect(museRunSettings({ schema_version: 3 }, 'edit', [])).toEqual({ schema_version: 1, run: { workflow_trigger_mode: 'off' }, permissions: musePermissions('edit', []) });
    // No reminder switch among its runtime capabilities: none are given.
    expect(museRunSettings({ runtime_capabilities: { computer_use: true } }, 'edit', [])).not.toHaveProperty('runtime_capabilities');
    expect(museReminderSwitches(['plugin:a:reminder:b'])).toBeUndefined();
    expect(museReminderSwitches({ 'plugin:a:reminder:b': { enabled: false }, 'plugin:a:reminder:b:c': { enabled: false } })).toEqual({
      'plugin:a:reminder:b': { enabled: false },
    });
  });

  it("finds the account's config and data folders: its home of Harness Relay's own, else the XDG folders, else ~/.config and ~/.local/share", () => {
    const home = join('/data', 'accounts', 'muse-a1');
    expect(museConfigBase({ [MUSE_HOME_ENV]: home, XDG_CONFIG_HOME: '/x' }, '/home/me')).toBe(join(home, 'config'));
    expect(museDataBase({ [MUSE_HOME_ENV]: home, XDG_DATA_HOME: '/x' }, '/home/me')).toBe(join(home, 'data'));
    expect(museConfigBase({ XDG_CONFIG_HOME: '/xdg/config' }, '/home/me')).toBe('/xdg/config');
    expect(museDataBase({ XDG_DATA_HOME: '/xdg/data' }, '/home/me')).toBe('/xdg/data');
    expect(museConfigBase({}, '/home/me')).toBe(join('/home/me', '.config'));
    expect(museDataBase({}, '/home/me')).toBe(join('/home/me', '.local', 'share'));
    expect(museKeyOnly({ [MUSE_KEY_ONLY_ENV]: '1' })).toBe(true);
    expect(museKeyOnly({})).toBe(false);
  });

  it("asks it things with the account's folders as its XDG folders, and runs it with the run's config folder and no approval judge, Harness Relay's variables not passed on", () => {
    const home = join('/data', 'accounts', 'muse-a1');
    const account = { PATH: '/bin', META_API_KEY: 'k', [MUSE_HOME_ENV]: home, [MUSE_KEY_ONLY_ENV]: '1' };
    expect(museProbeEnv(account)).toEqual({ PATH: '/bin', META_API_KEY: 'k', XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data') });
    // The default account keeps the user's own.
    expect(museProbeEnv({ PATH: '/bin', XDG_DATA_HOME: '/mine' })).toEqual({ PATH: '/bin', XDG_DATA_HOME: '/mine' });
    expect(museEnv(account, '/run/muse-1')).toEqual({
      PATH: '/bin',
      META_API_KEY: 'k',
      XDG_CONFIG_HOME: '/run/muse-1',
      XDG_DATA_HOME: join(home, 'data'),
      MUSE_DISABLE_APPROVAL_JUDGE: '1',
    });
    expect(museEnv({ PATH: '/bin', XDG_CONFIG_HOME: '/mine' }, '/run/muse-2')).toEqual({ PATH: '/bin', XDG_CONFIG_HOME: '/run/muse-2', MUSE_DISABLE_APPROVAL_JUDGE: '1' });
  });
});

describe("Muse Code's config folder for one run", () => {
  let root: string;
  let n = 0;
  beforeAll(() => (root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-muse-run-')))));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A user's XDG config folder (the default account's) with Muse's own folder and another CLI's, and a working directory. */
  function account() {
    const dir = join(root, `acct-${++n}`);
    const xdg = join(dir, 'xdg');
    const muse = join(xdg, 'muse');
    const work = join(dir, 'app');
    mkdirSync(muse, { recursive: true });
    mkdirSync(join(xdg, 'gh'));
    mkdirSync(work);
    writeFileSync(join(xdg, 'gh', 'hosts.yml'), 'github.com: {}\n');
    writeFileSync(join(muse, 'settings.json'), JSON.stringify({ model: 'muse-spark-1.2', permissions: { default_profile: ':unrestricted' } }));
    writeFileSync(join(muse, 'auth.json'), '{"schema_version":2,"providers":{"meta":{"storage":"keychain"}}}', { mode: 0o600 });
    writeFileSync(join(muse, 'trust.json'), JSON.stringify({ schema_version: 1, projects: { [work]: { decision: 'trusted' } } }));
    return { dir, xdg, muse, work, root: join(dir, 'runs'), env: { XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv };
  }
  const settingsOf = (run: { dir: string }) => JSON.parse(readFileSync(join(run.dir, 'muse', 'settings.json'), 'utf8'));
  const trustOf = (run: { dir: string }) => (existsSync(join(run.dir, 'muse', 'trust.json')) ? JSON.parse(readFileSync(join(run.dir, 'muse', 'trust.json'), 'utf8')) : null);

  it("keeps the runs' folders in Harness Relay's data folder, outside its temporary folder (which the profile denies)", () => {
    expect(museRunsDir()).toBe(join(dataDir, 'muse-runs'));
    expect(museRunsDir('/d')).toBe(join('/d', 'muse-runs'));
    expect(museRunsDir().startsWith(relayTmpDir())).toBe(false);
    // Nor are they swept with the temporary folder's: Muse's runs sweep their own (below).
    expect(Object.keys(RUN_TMP_PREFIXES)).not.toContain('muse');
  });

  it.skipIf(process.platform === 'win32')("writes the run's settings in a folder of its own (owner only), links the sign-in and the user's other config folders, and leaves the working directories untrusted", () => {
    const a = account();
    const run = prepareMuseRun(a.env, 'edit', ['/p/cookies'], { root: a.root, dirs: [a.work] });
    expect(run.dir.startsWith(join(a.root, MUSE_RUN_PREFIX))).toBe(true);
    expect(statSync(run.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(run.dir, 'muse')).mode & 0o777).toBe(0o700);
    expect(statSync(join(run.dir, 'muse', 'settings.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(run.dir, 'muse', 'trust.json')).mode & 0o777).toBe(0o600);
    expect(settingsOf(run)).toEqual({ model: 'muse-spark-1.2', schema_version: 1, run: { workflow_trigger_mode: 'off' }, permissions: musePermissions('edit', ['/p/cookies']) });
    expect(readlinkSync(join(run.dir, 'muse', 'auth.json'))).toBe(join(a.muse, 'auth.json'));
    expect(readlinkSync(join(run.dir, 'gh'))).toBe(join(a.xdg, 'gh'));
    expect(readdirSync(run.dir).sort()).toEqual(['gh', 'muse']);
    // Never the account's own trust: the working directory it trusts is untrusted in the run.
    expect(readdirSync(join(run.dir, 'muse')).sort()).toEqual(['auth.json', 'settings.json', 'trust.json']);
    expect(trustOf(run)).toEqual({ schema_version: 1, projects: { [a.work]: { decision: 'untrusted' } } });
    // The account's own files are left as they were.
    expect(JSON.parse(readFileSync(join(a.muse, 'settings.json'), 'utf8')).permissions).toEqual({ default_profile: ':unrestricted' });
    run.done();
    expect(existsSync(run.dir)).toBe(false);
    // The links went, not what they led to.
    expect(readFileSync(join(a.xdg, 'gh', 'hosts.yml'), 'utf8')).toBe('github.com: {}\n');
    expect(readFileSync(join(a.muse, 'auth.json'), 'utf8')).toContain('keychain');
    expect(JSON.parse(readFileSync(join(a.muse, 'trust.json'), 'utf8')).projects[a.work].decision).toBe('trusted');
  });

  it("brings the account's own skills and rules (AGENTS.md) into the run, not its approval policy or workflows", () => {
    // In the user's own Muse (muse 1.4.18) these load from its config folder; a run's has only what it writes.
    const a = account();
    mkdirSync(join(a.muse, 'skills', 'mine'), { recursive: true });
    writeFileSync(join(a.muse, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine.\n---\n');
    writeFileSync(join(a.muse, 'AGENTS.md'), 'Be brief.\n');
    writeFileSync(join(a.muse, 'approval-policy.json'), '{"default":"allow"}');
    mkdirSync(join(a.muse, 'workflows'));
    for (const platform of ['linux', 'win32'] as const) {
      const run = prepareMuseRun(a.env, 'edit', [], { root: a.root, dirs: [a.work], platform });
      const cfg = join(run.dir, 'muse');
      // A link to the skills (a junction on Windows) and a copy of the rules; not approval-policy.json or workflows.
      expect(readdirSync(cfg).sort()).toEqual(['AGENTS.md', 'auth.json', 'settings.json', 'skills', 'trust.json']);
      expect(readFileSync(join(cfg, 'skills', 'mine', 'SKILL.md'), 'utf8')).toContain('name: mine');
      expect(readFileSync(join(cfg, 'AGENTS.md'), 'utf8')).toBe('Be brief.\n');
      run.done();
      // The link went, not the skills.
      expect(readFileSync(join(a.muse, 'skills', 'mine', 'SKILL.md'), 'utf8')).toContain('name: mine');
    }
    // None of them: nothing added.
    const b = account();
    const bare = prepareMuseRun(b.env, 'edit', [], { root: b.root, dirs: [b.work] });
    expect(readdirSync(join(bare.dir, 'muse')).sort()).toEqual(['auth.json', 'settings.json', 'trust.json']);
    bare.done();
  });

  it.skipIf(process.platform === 'win32')("links the account's skills folder itself, so that skills added meanwhile are there too", () => {
    const a = account();
    mkdirSync(join(a.muse, 'skills'));
    const run = prepareMuseRun(a.env, 'edit', [], { root: a.root, dirs: [a.work] });
    expect(readlinkSync(join(run.dir, 'muse', 'skills'))).toBe(join(a.muse, 'skills'));
    run.done();
  });

  it('trusts nothing by a file with full access (its flag trusts the workspace), and every working directory is untrusted below it', () => {
    const a = account();
    const full = prepareMuseRun(a.env, 'full', [], { root: a.root, dirs: [a.work], platform: 'win32' });
    expect(trustOf(full)).toBeNull();
    full.done();
    const extra = join(a.dir, 'extra');
    mkdirSync(extra);
    const ro = prepareMuseRun(a.env, 'read-only', [], { root: a.root, dirs: [a.work, extra, a.work], platform: 'win32' });
    expect(trustOf(ro)).toEqual(museTrust([a.work, extra]));
    ro.done();
    // No working directory given: an empty list, still nothing trusted.
    const none = prepareMuseRun(a.env, 'edit', [], { root: a.root, platform: 'win32' });
    expect(trustOf(none)).toEqual({ schema_version: 1, projects: {} });
    none.done();
  });

  it('names each working directory untrusted once, by its real path', () => {
    const a = account();
    expect(museTrust([a.work, join(a.work, '..', 'app')])).toEqual({ schema_version: 1, projects: { [a.work]: { decision: 'untrusted' } } });
    // One that is not there (yet) as it is given.
    expect(museTrust([join(a.dir, 'later')])).toEqual({ schema_version: 1, projects: { [join(a.dir, 'later')]: { decision: 'untrusted' } } });
    expect(museTrust([])).toEqual({ schema_version: 1, projects: {} });
    if (process.platform === 'win32') return;
    symlinkSync(a.work, join(a.dir, 'link'));
    expect(museTrust([join(a.dir, 'link'), a.work])).toEqual({ schema_version: 1, projects: { [a.work]: { decision: 'untrusted' } } });
  });

  it.skipIf(process.platform === 'win32')("links the user's other config folders for an account of Harness Relay's own too, but never on Windows", () => {
    const a = account();
    const home = join(a.dir, 'home');
    mkdirSync(join(home, 'config', 'muse'), { recursive: true });
    const env = { [MUSE_HOME_ENV]: home, XDG_CONFIG_HOME: a.xdg };
    const own = prepareMuseRun(env, 'edit', [], { root: a.root });
    expect(readdirSync(own.dir).sort()).toEqual(['gh', 'muse']);
    expect(readlinkSync(join(own.dir, 'gh'))).toBe(join(a.xdg, 'gh'));
    own.done();
    // A folder given in its place.
    const other = join(a.dir, 'other-config');
    mkdirSync(join(other, 'git'), { recursive: true });
    mkdirSync(join(other, 'muse'));
    const given = prepareMuseRun(env, 'edit', [], { root: a.root, userConfig: other });
    expect(readdirSync(given.dir).sort()).toEqual(['git', 'muse']);
    given.done();
    const windows = prepareMuseRun(env, 'edit', [], { root: a.root, platform: 'win32' });
    expect(readdirSync(windows.dir)).toEqual(['muse']);
    windows.done();
    // None there yet: nothing to link.
    const none = prepareMuseRun(env, 'edit', [], { root: a.root, userConfig: join(a.dir, 'nothing') });
    expect(readdirSync(none.dir)).toEqual(['muse']);
    none.done();
  });

  it.skipIf(process.platform === 'win32')("puts a sign-in Muse refreshed back into the account's, when it replaced the link with a file of its own", () => {
    const a = account();
    const run = prepareMuseRun(a.env, 'edit', [], { root: a.root });
    unlinkSync(join(run.dir, 'muse', 'auth.json'));
    writeFileSync(join(run.dir, 'muse', 'auth.json'), '{"refreshed":true}');
    run.done();
    expect(readFileSync(join(a.muse, 'auth.json'), 'utf8')).toBe('{"refreshed":true}');
    expect(statSync(join(a.muse, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(a.muse, 'auth.json')).isFile()).toBe(true);
    expect(readdirSync(a.muse).sort()).toEqual(['auth.json', 'settings.json', 'trust.json']); // nothing left from the swap
    // A link left as it was puts nothing back.
    writeFileSync(join(a.muse, 'auth.json'), '{"mine":true}');
    const again = prepareMuseRun(a.env, 'edit', [], { root: a.root });
    again.done();
    expect(readFileSync(join(a.muse, 'auth.json'), 'utf8')).toBe('{"mine":true}');
    // The account's changed meanwhile (the user signed in again, another run put its own back): it stays.
    const later = prepareMuseRun(a.env, 'edit', [], { root: a.root });
    unlinkSync(join(later.dir, 'muse', 'auth.json'));
    writeFileSync(join(later.dir, 'muse', 'auth.json'), '{"stale":true}');
    writeFileSync(join(a.muse, 'auth.json'), '{"newer":true}');
    later.done();
    expect(readFileSync(join(a.muse, 'auth.json'), 'utf8')).toBe('{"newer":true}');
  });

  it.skipIf(process.platform === 'win32')("puts it back where the account's file is, keeping a link the user made to it", () => {
    const a = account();
    const dotfiles = join(a.dir, 'dotfiles');
    mkdirSync(dotfiles);
    writeFileSync(join(dotfiles, 'muse-auth.json'), '{"dotfiles":true}', { mode: 0o600 });
    rmSync(join(a.muse, 'auth.json'));
    symlinkSync(join(dotfiles, 'muse-auth.json'), join(a.muse, 'auth.json'));
    const run = prepareMuseRun(a.env, 'edit', [], { root: a.root });
    unlinkSync(join(run.dir, 'muse', 'auth.json'));
    writeFileSync(join(run.dir, 'muse', 'auth.json'), '{"refreshed":true}');
    run.done();
    expect(lstatSync(join(a.muse, 'auth.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dotfiles, 'muse-auth.json'), 'utf8')).toBe('{"refreshed":true}');
    expect(readdirSync(dotfiles)).toEqual(['muse-auth.json']);
  });

  it('puts back only a regular file that differs from the sign-in the run started with, while the account still has that one', () => {
    const dir = join(root, `put-back-${++n}`);
    mkdirSync(dir);
    const auth = join(dir, 'auth.json');
    const runAuth = join(dir, 'run-auth.json');
    const original = Buffer.from('{"v":1}');
    writeFileSync(auth, original);
    // No file of the run's: nothing.
    putBackAuth(auth, runAuth, original);
    expect(readFileSync(auth, 'utf8')).toBe('{"v":1}');
    // The same as it started with: nothing written.
    writeFileSync(runAuth, original);
    putBackAuth(auth, runAuth, original);
    expect(readdirSync(dir).sort()).toEqual(['auth.json', 'run-auth.json']);
    // Changed: written over the account's, atomically.
    writeFileSync(runAuth, '{"v":2}');
    putBackAuth(auth, runAuth, original);
    expect(readFileSync(auth, 'utf8')).toBe('{"v":2}');
    expect(readdirSync(dir).sort()).toEqual(['auth.json', 'run-auth.json']);
    // The account's is no longer the one the run started with: kept.
    writeFileSync(runAuth, '{"v":3}');
    putBackAuth(auth, runAuth, original);
    expect(readFileSync(auth, 'utf8')).toBe('{"v":2}');
    // A folder where the run's file was: nothing.
    rmSync(runAuth);
    mkdirSync(runAuth);
    putBackAuth(auth, runAuth, Buffer.from('{"v":2}'));
    expect(readFileSync(auth, 'utf8')).toBe('{"v":2}');
  });

  it("never throws when it cannot put things back or remove its folder, but says so", () => {
    const a = account();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const run = prepareMuseRun(a.env, 'edit', [], { root: a.root, platform: 'win32' });
      // Muse refreshed its copy, and the account's went meanwhile.
      writeFileSync(join(run.dir, 'muse', 'auth.json'), '{"refreshed":true}');
      rmSync(join(a.muse, 'auth.json'));
      expect(() => run.done()).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not put back'));
      expect(existsSync(join(a.muse, 'auth.json'))).toBe(false);
      expect(existsSync(run.dir)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('copies the sign-in on Windows, links nothing else, and puts back only a copy Muse changed', () => {
    const a = account();
    const run = prepareMuseRun(a.env, 'read-only', [], { root: a.root, dirs: [a.work], platform: 'win32' });
    const copy = join(run.dir, 'muse', 'auth.json');
    expect(lstatSync(copy).isFile()).toBe(true);
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(join(a.muse, 'auth.json'), 'utf8'));
    expect(readdirSync(run.dir)).toEqual(['muse']);
    // Unchanged: another run's sign-in written into the account's meanwhile is kept.
    writeFileSync(join(a.muse, 'auth.json'), '{"other":true}');
    run.done();
    expect(readFileSync(join(a.muse, 'auth.json'), 'utf8')).toBe('{"other":true}');
    expect(existsSync(run.dir)).toBe(false);
    // Changed: put back.
    const next = prepareMuseRun(a.env, 'edit', [], { root: a.root, platform: 'win32' });
    writeFileSync(join(next.dir, 'muse', 'auth.json'), '{"refreshed":true}');
    next.done();
    expect(readFileSync(join(a.muse, 'auth.json'), 'utf8')).toBe('{"refreshed":true}');
  });

  it("gives an account of Harness Relay's own its own sign-in, and one on its API key alone no sign-in at all", () => {
    const home = join(root, `home-${++n}`);
    mkdirSync(join(home, 'config', 'muse'), { recursive: true });
    writeFileSync(join(home, 'config', 'muse', 'auth.json'), '{}');
    const runs = join(root, `runs-${n}`);
    const userConfig = join(root, `no-user-config-${n}`);
    const own = prepareMuseRun({ [MUSE_HOME_ENV]: home }, 'edit', [], { root: runs, userConfig });
    expect(readdirSync(own.dir)).toEqual(['muse']);
    expect(readdirSync(join(own.dir, 'muse')).sort()).toEqual(['auth.json', 'settings.json', 'trust.json']);
    expect(readFileSync(join(own.dir, 'muse', 'auth.json'), 'utf8')).toBe('{}');
    own.done();
    const keyOnly = prepareMuseRun({ [MUSE_HOME_ENV]: home, [MUSE_KEY_ONLY_ENV]: '1' }, 'edit', [], { root: runs, userConfig });
    expect(readdirSync(join(keyOnly.dir, 'muse')).sort()).toEqual(['settings.json', 'trust.json']);
    keyOnly.done();
    // No account folder yet, or settings that are not JSON: Muse's defaults.
    const none = prepareMuseRun({ [MUSE_HOME_ENV]: join(root, 'none') }, 'full', [], { root: runs, userConfig });
    expect(settingsOf(none)).toEqual({ schema_version: 1, run: { workflow_trigger_mode: 'off' }, permissions: musePermissions('full', []) });
    none.done();
    writeFileSync(join(home, 'config', 'muse', 'settings.json'), '{ not json');
    const bad = prepareMuseRun({ [MUSE_HOME_ENV]: home }, 'edit', [], { root: runs, userConfig });
    expect(settingsOf(bad)).toEqual({ schema_version: 1, run: { workflow_trigger_mode: 'off' }, permissions: musePermissions('edit', []) });
    bad.done();
    expect(readdirSync(runs)).toEqual([]);
  });

  it('removes the folders of runs the server was stopped during, once older than a turn may last, never one under way', () => {
    const a = account();
    const long = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    mkdirSync(a.root, { recursive: true });
    const old = join(a.root, `${MUSE_RUN_PREFIX}old`);
    const recent = join(a.root, `${MUSE_RUN_PREFIX}recent`);
    const other = join(a.root, 'not-a-run');
    for (const d of [old, recent, other]) mkdirSync(d);
    writeFileSync(join(old, 'settings.json'), '{}');
    symlinkOr(join(a.xdg, 'gh'), join(old, 'gh'));
    for (const d of [old, other]) utimesSync(d, long, long);
    const run = prepareMuseRun(a.env, 'edit', [], { root: a.root, platform: 'win32' });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(a.xdg, 'gh', 'hosts.yml'))).toBe(true); // a link in it went, not what it led to
    expect(existsSync(recent)).toBe(true); // another server on the same data folder may be running it
    expect(existsSync(other)).toBe(true);
    // A run of this server still under way is never swept, however old its folder looks.
    utimesSync(run.dir, long, long);
    const next = prepareMuseRun(a.env, 'edit', [], { root: a.root, platform: 'win32' });
    expect(existsSync(run.dir)).toBe(true);
    next.done();
    run.done();
    expect(readdirSync(a.root).sort()).toEqual(['not-a-run', `${MUSE_RUN_PREFIX}recent`]);
  });

  it('leaves no folder behind when it cannot be made whole', () => {
    const a = account();
    // A sign-in that cannot be read (a folder where the file should be).
    rmSync(join(a.muse, 'auth.json'));
    mkdirSync(join(a.muse, 'auth.json'));
    for (const platform of ['win32', 'linux'] as const) {
      expect(() => prepareMuseRun(a.env, 'edit', [], { root: a.root, platform }), platform).toThrow();
      expect(readdirSync(a.root)).toEqual([]);
    }
    expect(existsSync(join(a.muse, 'auth.json'))).toBe(true);
    // Its folder for the runs is a file: nothing is made.
    const file = join(a.dir, 'runs-file');
    writeFileSync(file, '');
    expect(() => prepareMuseRun(a.env, 'edit', [], { root: file })).toThrow();
  });

  it('uses its settings for the other things it asks Muse: the run that lists its skills leaves out what runs leave out', () => {
    const a = account();
    writeFileSync(join(a.muse, 'settings.json'), JSON.stringify({ mcp_servers: { docs: {} }, hooks: { Stop: [] } }));
    const run = prepareMuseRun(a.env, 'read-only', [], { root: a.root, nativeOff: ['hooks'], nativeItems: { mcp: ['docs'] }, platform: 'win32' });
    expect(settingsOf(run)).toEqual({ mcp_servers: {}, schema_version: 1, run: { workflow_trigger_mode: 'off' }, permissions: musePermissions('read-only', []) });
    run.done();
  });
});

/** A link, or on Windows (where making one needs a privilege) a folder in its place. */
function symlinkOr(target: string, path: string): void {
  if (process.platform === 'win32') mkdirSync(path);
  else symlinkSync(target, path);
}

describe('the folders its Linux sandbox leaves in a working directory', () => {
  let root: string;
  beforeAll(() => (root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-muse-mounts-')))));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('are .agents, .muse, .hg, .sl and .eden; only those not there before the turn may be removed', () => {
    expect([...MUSE_MOUNT_POINTS]).toEqual(['.agents', '.muse', '.hg', '.sl', '.eden']);
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(join(a, '.muse'), { recursive: true });
    writeFileSync(join(a, '.hg'), 'a file');
    mkdirSync(b);
    expect(missingMountPoints([a, b])).toEqual([
      join(a, '.agents'),
      join(a, '.sl'),
      join(a, '.eden'),
      ...MUSE_MOUNT_POINTS.map((m) => join(b, m)),
    ]);
    expect(missingMountPoints([])).toEqual([]);
  });

  it('removes an empty folder made during the turn; a folder with something in it, a file, and one there before stay', () => {
    const cwd = join(root, 'c');
    mkdirSync(join(cwd, '.muse'), { recursive: true }); // there before the turn: not in the list
    const mounts = missingMountPoints([cwd]);
    // What the turn left: the sandbox's empty folders, a folder an agent wrote in, a file.
    mkdirSync(join(cwd, '.agents'));
    mkdirSync(join(cwd, '.hg'));
    writeFileSync(join(cwd, '.hg', 'store'), 'x');
    writeFileSync(join(cwd, '.sl'), 'a file');
    // `.eden` never made: nothing to remove, and nothing thrown.
    removeEmptyMountPoints(mounts);
    expect(readdirSync(cwd).sort()).toEqual(['.hg', '.muse', '.sl']);
    expect(readFileSync(join(cwd, '.hg', 'store'), 'utf8')).toBe('x');
    expect(lstatSync(join(cwd, '.sl')).isFile()).toBe(true);
    // A folder there before is never removed, even when it is empty and named.
    removeEmptyMountPoints([join(cwd, '.muse')].filter((p) => mounts.includes(p)));
    expect(existsSync(join(cwd, '.muse'))).toBe(true);
    expect(() => removeEmptyMountPoints([join(root, 'nothing', '.agents')])).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')('leaves a link to an empty folder, and the folder it leads to', () => {
    const cwd = join(root, 'd');
    mkdirSync(join(root, 'empty'), { recursive: true });
    mkdirSync(cwd);
    const mounts = missingMountPoints([cwd]);
    symlinkSync(join(root, 'empty'), join(cwd, '.agents'));
    removeEmptyMountPoints(mounts);
    expect(lstatSync(join(cwd, '.agents')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, 'empty'))).toBe(true);
  });

  /** The marker Muse's Linux sandbox leaves in a folder it mounted over, for its process `pid`. */
  const MARKER_TEXT = 'transient mountpoint marker created by tbh-linux-sandbox; a directory holding only these markers is sandbox residue and safe to delete';
  const marker = (dir: string, pid: number | string) => writeFileSync(join(dir, `.tbh-sandbox-mountpoint.${pid}`), MARKER_TEXT);

  it("removes a folder holding only the markers of sandbox processes no longer running (a stopped turn's); one with a live process's marker, or anything else, stays whole", () => {
    const cwd = join(root, 'e');
    mkdirSync(cwd);
    const mounts = missingMountPoints([cwd]);
    for (const m of MUSE_MOUNT_POINTS) mkdirSync(join(cwd, m));
    marker(join(cwd, '.agents'), 101); // only markers of processes gone: removed, markers first
    marker(join(cwd, '.agents'), 102);
    marker(join(cwd, '.muse'), 101); // one of a process still running: stays
    marker(join(cwd, '.muse'), 200);
    marker(join(cwd, '.hg'), 101); // a marker and something else: stays
    writeFileSync(join(cwd, '.hg', 'store'), 'x');
    marker(join(cwd, '.sl'), 'abc'); // not a process's: not a marker
    // `.eden` empty: removed.
    const asked: number[] = [];
    removeEmptyMountPoints(mounts, (pid) => {
      asked.push(pid);
      return pid === 200;
    });
    expect(readdirSync(cwd).sort()).toEqual(['.hg', '.muse', '.sl']);
    // Nothing is taken out of a folder that stays.
    expect(readdirSync(join(cwd, '.muse')).sort()).toEqual(['.tbh-sandbox-mountpoint.101', '.tbh-sandbox-mountpoint.200']);
    expect(readdirSync(join(cwd, '.hg')).sort()).toEqual(['.tbh-sandbox-mountpoint.101', 'store']);
    expect(readdirSync(join(cwd, '.sl'))).toEqual(['.tbh-sandbox-mountpoint.abc']);
    expect(asked).toEqual(expect.arrayContaining([101, 102, 200]));
    // A folder there before the turn is not in the list, markers or not.
    const before = join(root, 'f');
    mkdirSync(join(before, '.agents'), { recursive: true });
    marker(join(before, '.agents'), 101);
    removeEmptyMountPoints(missingMountPoints([before]), () => false);
    expect(readdirSync(join(before, '.agents'))).toEqual(['.tbh-sandbox-mountpoint.101']);
  });

  it("takes a marker of a process that is running for a live one by default, and one of a process that is not for residue", () => {
    const cwd = join(root, 'g');
    mkdirSync(cwd);
    const mounts = missingMountPoints([cwd]);
    mkdirSync(join(cwd, '.agents'));
    mkdirSync(join(cwd, '.muse'));
    marker(join(cwd, '.agents'), process.pid);
    marker(join(cwd, '.muse'), 2_147_483_646); // no such process
    removeEmptyMountPoints(mounts);
    expect(readdirSync(cwd)).toEqual(['.agents']);
  });
});

describe('its arguments, briefing and mode', () => {
  it('passes the model, an effort it takes, and the briefing as its developer prompt', () => {
    const o = { permission: 'edit' as const, model: ' muse-spark-1.3 ', effort: 'xhigh', systemPrompt: 'You are @Ada.' };
    expect(museArgs(o, 'darwin')).toEqual(['acp', '--model', 'muse-spark-1.3', '-c', 'reasoning_effort="xhigh"', '-c', `run.developer_prompt=${JSON.stringify(museBriefing('You are @Ada.'))}`]);
    for (const effort of MUSE_EFFORTS) expect(museArgs({ ...o, effort }, 'linux')).toContain(`reasoning_effort=${JSON.stringify(effort)}`);
    // `none` is refused by its Meta provider; an effort it does not know is left to its default.
    for (const effort of ['none', 'ultra', '', '  ']) expect(museArgs({ ...o, effort }, 'linux').join(' '), effort).not.toContain('reasoning_effort');
    expect(museArgs({ permission: 'edit', systemPrompt: '   ' }, 'linux')).toEqual(['acp']);
    expect(museArgs({ permission: 'edit', model: ' ', systemPrompt: '' }, 'linux')).toEqual(['acp']);
  });

  it('takes the writes away in read-only, and turns its sandbox off and trusts the workspace only with full access', () => {
    expect(museArgs({ permission: 'read-only', systemPrompt: '' }, 'linux')).toEqual(['acp', '--disable-write']);
    expect(museArgs({ permission: 'edit', systemPrompt: '' }, 'linux')).toEqual(['acp']);
    expect(museArgs({ permission: 'full', systemPrompt: '' }, 'linux')).toEqual(['acp', '--disable-sandbox', '--trust-workspace']);
    expect(museMode('read-only')).toBe('promptUnmatched');
    expect(museMode('edit')).toBe('onRequest');
    expect(museMode('full')).toBe('allowAll');
  });

  it('wraps the briefing, telling the model how a refusal reaches it', () => {
    const text = museBriefing('  Be @Ada.  ');
    expect(text.split('\n')[0]).toBe('<harness-relay-briefing>');
    expect(text).toContain('\nBe @Ada.\n');
    expect(text).toContain(MUSE_NOTES);
    expect(text.endsWith('</harness-relay-briefing>')).toBe(true);
    expect(MUSE_NOTES).toMatch(/The user rejected this action/);
    expect(MUSE_NOTES).toMatch(/Do not retry/);
    expect(MUSE_NOTES).toMatch(/Workflows are off/);
  });

  it('makes a lone half of an emoji (a role cut in the middle of one) a replacement character, which Muse takes as JSON text', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const cut = museBriefing('You are @Ada \uD83D');
    expect(cut).toContain('You are @Ada \uFFFD');
    expect(lone.test(cut)).toBe(false);
    expect(museBriefing('\uDE00 first')).toContain('\uFFFD first');
    // A whole emoji stays.
    expect(museBriefing('Ship it \u{1F680}')).toContain('Ship it \u{1F680}');
    const arg = museArgs({ permission: 'edit', systemPrompt: 'Ada \uD83D' }, 'linux').find((a) => a.startsWith('run.developer_prompt='))!;
    const json = arg.slice('run.developer_prompt='.length);
    expect(json).not.toMatch(/\\ud8[0-9a-f]{2}/i); // no escaped lone surrogate either
    expect(JSON.parse(json)).toBe(museBriefing('Ada \uD83D'));
  });

  it('puts a briefing too long for a Windows command line on top of the prompt instead', () => {
    const short = 'Be @Ada.';
    const long = 'x'.repeat(MUSE_WINDOWS_BRIEFING_MAX);
    expect(briefingOnCommandLine(long, 'win32')).toBe(false);
    expect(briefingOnCommandLine(short, 'win32')).toBe(true);
    expect(briefingOnCommandLine(long, 'linux')).toBe(true);
    expect(museArgs({ permission: 'edit', systemPrompt: long }, 'win32')).toEqual(['acp']);
    expect(museArgs({ permission: 'edit', systemPrompt: short }, 'win32')).toContain(`run.developer_prompt=${JSON.stringify(museBriefing(short))}`);
    expect(musePromptText('Hi', long, 'win32')).toBe(`${museBriefing(long)}\n\nHi`);
    expect(musePromptText('Hi', short, 'win32')).toBe('Hi');
    expect(musePromptText('Hi', long, 'darwin')).toBe('Hi');
    expect(musePromptText('Hi', '  ', 'win32')).toBe('Hi');
  });

  it("counts the backslash Windows' quoting puts before each quote and backslash of the briefing's JSON", () => {
    const third = Math.floor(MUSE_WINDOWS_BRIEFING_MAX / 3);
    // Each `"` is `\"` in the JSON text, and Windows' quoting escapes both again.
    const quotes = '"'.repeat(third);
    expect(JSON.stringify(museBriefing(quotes)).length).toBeLessThan(MUSE_WINDOWS_BRIEFING_MAX);
    expect(briefingOnCommandLine(quotes, 'win32')).toBe(false);
    expect(briefingOnCommandLine('\\'.repeat(third), 'win32')).toBe(false);
    // As long a JSON text without them fits.
    expect(briefingOnCommandLine('x'.repeat(2 * third), 'win32')).toBe(true);
    expect(briefingOnCommandLine(quotes, 'darwin')).toBe(true);
    expect(musePromptText('Hi', quotes, 'win32')).toBe(`${museBriefing(quotes)}\n\nHi`);
  });
});

describe("Muse Code's models and what it loads by itself", () => {
  let root: string;
  beforeAll(() => (root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-muse-models-')))));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("lists its models (a fixed list: it lists them only inside a session), with the account's default model and effort", async () => {
    const home = join(root, 'a1');
    const env = { [MUSE_HOME_ENV]: home };
    const none = discoverMuse(env);
    expect(none).toMatchObject({ provider: 'muse', efforts: [...MUSE_EFFORTS], cliDefaultEffort: 'high', source: 'builtin' });
    expect(none.cliDefaultModel).toBeUndefined();
    expect(none.models.map((m) => m.id)).toEqual(['muse-wonder-1.0', 'muse-ember-1.0', 'muse-spark-1.3', 'muse-spark-1.3-contributor', 'muse-spark-1.2', 'muse-spark-1.2-contributor']);
    expect(none.models.find((m) => m.id === 'muse-spark-1.2')?.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    mkdirSync(join(home, 'config', 'muse'), { recursive: true });
    writeFileSync(join(home, 'config', 'muse', 'settings.json'), JSON.stringify({ model: 'muse-spark-1.2', reasoning_effort: 'max' }));
    expect(discoverMuse(env)).toMatchObject({ cliDefaultModel: 'muse-spark-1.2', cliDefaultEffort: 'max', models: none.models });
    // A model it does not list is added; an effort it does not take is its default.
    writeFileSync(join(home, 'config', 'muse', 'settings.json'), JSON.stringify({ model: 'muse-next', reasoning_effort: 'none' }));
    const other = discoverMuse(env);
    expect(other.models.at(-1)).toEqual({ id: 'muse-next' });
    expect(other.cliDefaultEffort).toBe('high');
    // Never by starting it, and never on the user's own endpoints (it needs the Meta API's own catalog).
    const listed = await discoverModels('muse', join(root, 'no-such-muse'), env);
    expect(listed).toMatchObject({ provider: 'muse', cliDefaultModel: 'muse-next' });
    expect(listed.error).toBeUndefined();
    expect(isEndpointCli('muse')).toBe(false);
  });

  it('lists the models of the catalog Muse keeps once signed in, with their efforts and its default, the account\'s own default first', () => {
    const home = join(root, 'a2');
    const env = { [MUSE_HOME_ENV]: home };
    // The catalog a signed-in muse 1.4.18 kept (test/fixtures/muse/cli/model-catalog.json): six visible models and a hidden one.
    mkdirSync(join(home, 'data', 'muse', 'model-catalog'), { recursive: true });
    copyFileSync(join(FIX, 'cli', 'model-catalog.json'), join(home, 'data', MUSE_CATALOG));
    const listed = discoverMuse(env);
    expect(listed).toMatchObject({ source: 'cli', cliDefaultModel: 'muse-spark-1.3-contributor', cliDefaultEffort: 'high' });
    expect(listed.models.map((m) => m.id)).toEqual(['muse-wonder-1.0', 'muse-ember-1.0', 'muse-spark-1.3', 'muse-spark-1.3-contributor', 'muse-spark-1.2', 'muse-spark-1.2-contributor']);
    expect(listed.models.find((m) => m.id === 'muse-spark-1.3')?.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(listed.models.find((m) => m.id === 'muse-spark-1.2')?.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    // The hidden one (an image model) is not listed.
    expect(listed.models.some((m) => m.id === 'muse-image-1.0')).toBe(false);
    // The account's own default model comes before the catalog's.
    mkdirSync(join(home, 'config', 'muse'), { recursive: true });
    writeFileSync(join(home, 'config', 'muse', 'settings.json'), JSON.stringify({ model: 'muse-ember-1.0' }));
    expect(discoverMuse(env).cliDefaultModel).toBe('muse-ember-1.0');
    // A catalog it cannot read, or without a visible model: the fixed list.
    writeFileSync(join(home, 'data', MUSE_CATALOG), '{"rows":[{"model_id":"x","visibility":"hidden"}]}');
    expect(discoverMuse(env).source).toBe('builtin');
    writeFileSync(join(home, 'data', MUSE_CATALOG), 'not json');
    expect(discoverMuse(env).models.map((m) => m.id)[0]).toBe('muse-wonder-1.0');
  });

  it('lists its skills from its own answer, and its MCP servers (names only) and hooks (never their commands) from its settings', () => {
    const skills = parseMuseSkills(JSON.parse(readFileSync(join(CLI, 'skills.json'), 'utf8')));
    expect(skills.map((s) => s.name)).toEqual(['blender', 'browser-app-delivery', 'browser-game']);
    expect(skills[0]).toEqual({ name: 'blender', description: expect.stringMatching(/^Build, edit, animate/), source: 'bundled', path: 'bundled://muse-core/skills/blender/SKILL.md' });
    expect(parseMuseSkills({ skills: [{ name: 'off', activation: 'off' }, { description: 'no name' }, null] })).toEqual([{ name: 'off', description: '', enabled: false }]);
    expect(parseMuseSkills({})).toEqual([]);
    expect(parseMuseSkills(null)).toEqual([]);
    const settings = {
      mcp_servers: { docs: { transport: 'stdio', command: 'docs', env: { TOKEN: 'secret' } }, web: { transport: 'streamable_http', url: 'https://x', enabled: false } },
      hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: 'echo secret-hook' }] }], SessionStart: [{ hooks: [] }], Bad: 'x' },
    };
    expect(museMcpServers(settings)).toEqual([
      { name: 'docs', transport: 'stdio', source: 'user' },
      { name: 'web', transport: 'http', source: 'user', enabled: false, status: 'disabled' },
    ]);
    expect(JSON.stringify(museMcpServers(settings))).not.toContain('secret');
    expect(museHooks(settings)).toEqual([
      { event: 'PreToolUse', matcher: 'bash', source: 'user settings' },
      { event: 'SessionStart', source: 'user settings' },
    ]);
    expect(JSON.stringify(museHooks(settings))).not.toContain('secret-hook');
    expect(museMcpServers({ mcp_servers: [] })).toEqual([]);
    expect(museHooks({})).toEqual([]);
  });

  it('lists the MCP servers `muse mcp add` writes (`mcpServers`, by type) and those of `mcp_servers` (by transport), a name in the first one first', () => {
    const settings = {
      mcpServers: { gh: { type: 'stdio', command: 'gh-mcp', env: { GH_TOKEN: 'secret' } }, linear: { type: 'streamable-http', url: 'https://mcp.linear.app/mcp' }, docs: { type: 'stdio', command: 'docs-new' } },
      mcp_servers: { docs: { transport: 'streamable_http', url: 'https://old' }, local: { command: 'node' }, remote: { url: 'https://y' } },
    };
    expect(museMcpServers(settings)).toEqual([
      { name: 'gh', transport: 'stdio', source: 'user' },
      { name: 'linear', transport: 'http', source: 'user' },
      { name: 'docs', transport: 'stdio', source: 'user' },
      { name: 'local', transport: 'stdio', source: 'user' },
      // No type or transport: an address is a server over HTTP.
      { name: 'remote', transport: 'http', source: 'user' },
    ]);
    expect(JSON.stringify(museMcpServers(settings))).not.toContain('secret');
    expect(museMcpServers({ mcpServers: 'x', mcp_servers: null })).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('a Muse Code turn (with a stand-in muse replaying recorded messages)', { timeout: slow(20_000) }, () => {
  let root: string;
  let bin: string;
  let n = 0;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-muse-')));
    bin = writeFakeMuse(join(root, 'muse'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  interface Run {
    o: RunOptions;
    events: AgentEvent[];
    approvals: ApprovalRequest[];
    abort: AbortController;
    log: () => Record<string, any>[];
    /** The account's home (`MUSE_HOME_ENV`) and its config folder; the user's own XDG config folder (with `gh` in it). */
    home: string;
    config: string;
    userConfig: string;
    outside: string;
    extra: string;
  }

  function run(fixture: string | undefined, over: Partial<RunOptions> = {}, answer?: (req: ApprovalRequest) => ApprovalAnswer): Run {
    const dir = join(root, `run-${++n}`);
    const cwd = join(dir, 'app');
    const outside = join(dir, 'outside');
    const extra = join(dir, 'extra');
    const home = join(dir, 'home');
    const config = join(home, 'config', 'muse');
    const userConfig = join(dir, 'user-config');
    for (const d of [cwd, outside, extra, config, join(home, 'data', 'muse'), join(userConfig, 'gh')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(config, 'auth.json'), '{"schema_version":2,"providers":{"meta":{"storage":"keychain"}}}', { mode: 0o600 });
    const logFile = join(dir, 'log.jsonl');
    const events: AgentEvent[] = [];
    const approvals: ApprovalRequest[] = [];
    const abort = new AbortController();
    const o: RunOptions = {
      bin,
      env: {
        PATH: process.env.PATH,
        HOME: join(dir, 'user'),
        XDG_CONFIG_HOME: userConfig,
        FAKE_MUSE_LOG: logFile,
        FAKE_MUSE_CLI: CLI,
        FAKE_MUSE_CWD: cwd,
        FAKE_MUSE_OUTSIDE: outside,
        FAKE_MUSE_EXTRA: extra,
        ...(fixture ? { FAKE_MUSE_FIXTURE: join(FIX, `${fixture}.jsonl`) } : {}),
        [MUSE_HOME_ENV]: home,
        META_API_KEY: 'meta-test-0000',
      },
      prompt: 'Say hi',
      systemPrompt: 'You are @Ada on a team.',
      cwd,
      permission: 'edit',
      signal: abort.signal,
      onEvent: (e) => events.push(e),
      protectedPaths: [join(outside, 'secret.txt')],
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
    return { o, events, approvals, abort, log, home, config, userConfig, outside, extra };
  }

  const methods = (r: Run) => r.log().flatMap((l) => (typeof l.method === 'string' ? [l.method] : []));
  const sent = (r: Run, method: string) => r.log().find((l) => l.method === method);
  /** The options its permission requests were answered with, in order. */
  const answers = (r: Run) => r.log().flatMap((l) => (l.result?.outcome ? [l.result.outcome.optionId ?? l.result.outcome.outcome] : []));
  const ends = (r: Run) => r.events.filter((e): e is Extract<AgentEvent, { type: 'tool_end' }> => e.type === 'tool_end');
  /** The runs' own config folders left behind. */
  const leftover = () => (existsSync(museRunsDir()) ? readdirSync(museRunsDir()).filter((f) => f.startsWith(MUSE_RUN_PREFIX)) : []);
  /** What a run with `r`'s permission and protected paths is granted, as Muse keeps it for a session. */
  const grantOf = (r: Run) => museGrant(r.o.permission, r.o.permission === 'full' ? [] : (r.o.protectedPaths ?? []));

  it("runs a turn in a config folder of its own, with Harness Relay's profile, the briefing as its developer prompt, and no approval judge", async () => {
    const r = run('plain', { model: 'muse-spark-1.3', effort: 'low' });
    writeFileSync(join(r.config, 'trust.json'), JSON.stringify({ schema_version: 1, projects: { [r.o.cwd]: { decision: 'trusted' } } }));
    writeFileSync(join(r.config, 'settings.json'), JSON.stringify({ reasoning_effort: 'high', theme: 'dark', permissions: { schema_version: 1, default_profile: ':auto-review' }, permission_default: 'allow' }));
    const result = await withLang('en', () => museRunner.run(r.o));
    expect(result).toEqual({ sessionId: '01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7' });
    expect(r.events).toEqual([
      { type: 'session', sessionId: '01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7' },
      { type: 'thinking', text: 'Thinking about the request.' },
      { type: 'text', text: 'pong' },
      { type: 'text_end' },
    ]);
    const start = r.log()[0]!;
    expect(start.argv).toEqual(['acp', '--model', 'muse-spark-1.3', '-c', 'reasoning_effort="low"', '-c', `run.developer_prompt=${JSON.stringify(museBriefing('You are @Ada on a team.'))}`]);
    expect(start.cwd).toBe(r.o.cwd);
    expect(start.env).toEqual({
      XDG_CONFIG_HOME: expect.stringContaining(join(museRunsDir(), MUSE_RUN_PREFIX)),
      XDG_DATA_HOME: join(r.home, 'data'),
      MUSE_DISABLE_APPROVAL_JUDGE: '1',
      HARNESS_RELAY_MUSE_HOME: null,
      HARNESS_RELAY_MUSE_KEY_ONLY: null,
      META_API_KEY: true,
    });
    // Only the settings it knows are kept: not its permissions, not one it does not know.
    expect(start.settings).toEqual({ reasoning_effort: 'high', schema_version: 1, run: { workflow_trigger_mode: 'off' }, permissions: musePermissions('edit', [join(r.outside, 'secret.txt')]) });
    // Its sign-in is the account's; the workspace the account trusts is untrusted in the run.
    expect(start.auth).toEqual({ link: join(r.config, 'auth.json') });
    expect(start.trust).toEqual({ schema_version: 1, projects: { [r.o.cwd]: { decision: 'untrusted' } } });
    // The user's other config folders, for the commands it runs.
    expect(start.entries).toEqual(['gh', 'muse']);
    expect(methods(r)).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/prompt']);
    expect(sent(r, 'session/new')!.params).toEqual({ cwd: r.o.cwd, mcpServers: [] });
    expect(sent(r, 'session/set_config_option')!.params).toEqual({ sessionId: result.sessionId, configId: 'mode', value: 'onRequest' });
    expect(sent(r, 'session/prompt')!.params.prompt).toEqual([{ type: 'text', text: 'Say hi' }]);
    // The run's folder is gone with the run, the account's files as they were.
    expect(leftover()).toEqual([]);
    expect(readFileSync(join(r.config, 'auth.json'), 'utf8')).toContain('keychain');
    expect(JSON.parse(readFileSync(join(r.config, 'settings.json'), 'utf8')).permission_default).toBe('allow');
  });

  it('edit: runs a command Muse asks about without asking the user (it stays in the sandbox), and answers a call asked about twice the same', async () => {
    const r = run('edit-run', { prompt: 'RUN: echo made > made.txt && cat a.txt' }, () => ({ allow: false }));
    await withLang('en', () => museRunner.run(r.o));
    expect(r.approvals).toEqual([]);
    expect(answers(r)).toEqual(['allow_once']);
    expect(ends(r)).toEqual([{ type: 'tool_end', id: '01a1d2b6-411d-7a63-95a3-52757b704df0', ok: true, output: 'hello' }]);
    const twice = run('edit-ask', { prompt: 'RUN: echo x > outside' }, () => ({ allow: false }));
    await museRunner.run(twice.o);
    expect(twice.approvals).toEqual([]);
    expect(answers(twice)).toEqual(['allow_once', 'allow_once']);
  });

  it('asks the user once about a call Muse asks about twice, and gives the second request the same answer', async () => {
    const yes = run('edit-ask', { permission: 'read-only', prompt: 'RUN: echo x > outside' }, () => ({ allow: true }));
    await withLang('en', () => museRunner.run(yes.o));
    expect(yes.approvals).toEqual([{ kind: 'command', detail: `echo x > ${yes.outside}/w-run.txt; echo rc=$?`, reason: 'Run the requested command' }]);
    expect(answers(yes)).toEqual(['allow_once', 'allow_once']);
    const no = run('edit-ask', { permission: 'read-only', prompt: 'RUN: echo x > outside' }, () => ({ allow: false, note: 'Not there' }));
    await withLang('en', () => museRunner.run(no.o));
    expect(no.approvals).toHaveLength(1);
    expect(answers(no)).toEqual(['abort', 'abort']);
    expect(no.log().filter((l) => l.result?.outcome).map((l) => l.result._meta?.followup_message)).toEqual(['Not there', 'Not there']);
  });

  it("edit: asks before a write to an agent's configuration, and shows the user's note when it is declined", async () => {
    const r = run('edit-config', { prompt: 'WRITE: .git/hooks/pre-commit' }, () => ({ allow: false, note: 'no hooks' }));
    await withLang('en', () => museRunner.run(r.o));
    expect(r.approvals).toEqual([{ kind: 'edit', detail: '.git/hooks/pre-commit', reason: withLang('en', () => t().museConfigWrite) }]);
    expect(answers(r)).toEqual(['abort']);
    expect(r.log().find((l) => l.result?.outcome)!.result._meta).toEqual({ followup_message: 'no hooks' });
    expect(ends(r)).toEqual([{ type: 'tool_end', id: '01a1d2b6-6ac5-7023-9904-591856c640c8', ok: false, error: `${withLang('en', () => t().approvalDeclined)} no hooks` }]);
    // The turn carries on: Muse tells the model, which answers.
    expect(r.events.some((e) => e.type === 'text' && e.text.includes('The user rejected this action'))).toBe(true);
    // Allowed, it runs.
    const allowed = run('edit-config', { prompt: 'WRITE: .git/hooks/pre-commit' }, () => ({ allow: true }));
    await museRunner.run(allowed.o);
    expect(answers(allowed)).toEqual(['allow_once']);
  });

  it("edit: writes in the working directories and the other ones run without a question; one outside fails as Muse refuses it", async () => {
    const inside = run('edit-write', { prompt: 'WRITE: w-inside.txt' }, () => ({ allow: false }));
    await museRunner.run(inside.o);
    expect(inside.approvals).toEqual([]);
    expect(ends(inside)).toEqual([expect.objectContaining({ ok: true, output: `wrote 6 bytes to ${inside.o.cwd}/w-inside.txt` })]);
    const extra = run('extra-dir', { prompt: 'WRITE: extra' }, () => ({ allow: false }));
    extra.o.addDirs = [extra.extra];
    await museRunner.run(extra.o);
    expect(sent(extra, 'session/new')!.params.additionalDirectories).toEqual([extra.extra]);
    expect(ends(extra)).toEqual([expect.objectContaining({ ok: true })]);
    const outside = run('edit-outside', { prompt: 'WRITE: outside' }, () => ({ allow: true }));
    await museRunner.run(outside.o);
    expect(outside.approvals).toEqual([]);
    expect(ends(outside)).toEqual([expect.objectContaining({ ok: false, error: 'tool failed: absolute path is outside the workspace' })]);
    // A command the sandbox kept from writing outside fails with its exit code.
    const decline = run('edit-decline', { prompt: 'RUN: echo x > outside' });
    await withLang('en', () => museRunner.run(decline.o));
    expect(answers(decline)).toEqual(['allow_once']);
    expect(ends(decline)).toEqual([expect.objectContaining({ ok: false, error: 'exit code 1' })]);
  });

  it('read-only: takes its write tools away and asks about every command, its file tool writes failing as Muse refuses them', async () => {
    const r = run('ro-write', { permission: 'read-only', prompt: 'WRITE: ro.txt' }, () => ({ allow: true }));
    await withLang('en', () => museRunner.run(r.o));
    const start = r.log()[0]!;
    expect(start.argv).toEqual(['acp', '-c', `run.developer_prompt=${JSON.stringify(museBriefing('You are @Ada on a team.'))}`, '--disable-write']);
    expect(start.settings.permissions).toEqual(musePermissions('read-only', [join(r.outside, 'secret.txt')]));
    expect(sent(r, 'session/set_config_option')!.params.value).toBe('promptUnmatched');
    expect(r.approvals).toEqual([]);
    expect(ends(r)).toEqual([expect.objectContaining({ ok: false, error: expect.stringContaining('tool unavailable: unknown tool `write_file`') })]);

    const cmd = run('ro-cmd', { permission: 'read-only', prompt: 'RUN: cat a.txt' }, () => ({ allow: true }));
    await withLang('en', () => museRunner.run(cmd.o));
    expect(cmd.approvals).toEqual([{ kind: 'command', detail: 'cat a.txt', reason: 'Run the requested command' }]);
    // Never "always allow": Muse would keep the rule for the workspace.
    expect(answers(cmd)).toEqual(['allow_once']);
    expect(ends(cmd)).toEqual([expect.objectContaining({ ok: true, output: 'hello' })]);
  });

  it('read-only: fetches a page Muse asks about without asking the user, once only', async () => {
    const r = run('ro-fetch', { permission: 'read-only', prompt: 'FETCH: http://example.com/' }, () => ({ allow: false }));
    await museRunner.run(r.o);
    expect(r.approvals).toEqual([]);
    expect(answers(r)).toEqual(['allow_once']);
    expect(ends(r)).toEqual([expect.objectContaining({ ok: true, output: expect.stringContaining('Example Domain') })]);
  });

  const CURL = "curl -s -o /dev/null -w '%{http_code}' http://example.com/";

  it("edit: asks the user before a command reaches the network, though the command itself runs without asking, and shows the note it was declined with", async () => {
    const r = run('edit-net', { prompt: 'RUN: curl' }, () => ({ allow: false, note: 'no network' }));
    await withLang('en', () => museRunner.run(r.o));
    expect(r.approvals).toEqual([{ kind: 'fetch', detail: CURL, reason: withLang('en', () => t().museNetwork) }]);
    // Reject once: never "always allow this network destination", nor "for this session".
    expect(answers(r)).toEqual(['abort']);
    expect(r.log().find((l) => l.result?.outcome)!.result._meta).toEqual({ followup_message: 'no network' });
    // Muse's proxy answered 403 for it: the row says the user declined, with what the command printed.
    expect(ends(r)).toEqual([{ type: 'tool_end', id: '01a1d304-b026-7c23-9f96-5f943802c72f', ok: false, error: `${withLang('en', () => t().approvalDeclined)} no network`, output: '403' }]);
    // Allowed, it reaches it once.
    const yes = run('edit-net', { prompt: 'RUN: curl' }, () => ({ allow: true }));
    await museRunner.run(yes.o);
    expect(yes.approvals.map((a) => a.kind)).toEqual(['fetch']);
    expect(answers(yes)).toEqual(['allow_once']);
    // With approvals refused by the chat, refused without asking.
    const auto = run('edit-net', { prompt: 'RUN: curl' });
    await withLang('en', () => museRunner.run(auto.o));
    expect(answers(auto)).toEqual(['abort']);
    expect(ends(auto)).toEqual([expect.objectContaining({ ok: false, error: withLang('en', () => t().museRefused) })]);
  });

  it("read-only: asks about the command, then about its network on its own: the command's answer is not taken for its network's", async () => {
    const r = run('ro-net', { permission: 'read-only', prompt: 'RUN: curl' }, () => ({ allow: true }));
    await withLang('en', () => museRunner.run(r.o));
    expect(r.approvals).toEqual([
      { kind: 'command', detail: CURL, reason: 'Run the requested command' },
      { kind: 'fetch', detail: CURL, reason: withLang('en', () => t().museNetwork) },
    ]);
    expect(answers(r)).toEqual(['allow_once', 'allow_once']);
    expect(ends(r)).toEqual([{ type: 'tool_end', id: '01a1d304-bb94-7380-8b67-fb161a4eefda', ok: false, error: 'exit code 52', output: '000' }]);
    // The command allowed and its network declined: each answer is its own.
    const split = run('ro-net', { permission: 'read-only', prompt: 'RUN: curl' }, (req) => ({ allow: req.kind === 'command' }));
    await museRunner.run(split.o);
    expect(answers(split)).toEqual(['allow_once', 'abort']);
  });

  it('refuses by itself what the permission does not cover when the conversation refuses approvals', async () => {
    const r = run('ro-auto', { permission: 'read-only', prompt: 'RUN: echo x > outside' });
    await withLang('en', () => museRunner.run(r.o));
    expect(answers(r)).toEqual(['abort']);
    expect(r.log().find((l) => l.result?.outcome)!.result._meta).toEqual({ followup_message: 'Not covered by the permission' });
    expect(ends(r)).toEqual([expect.objectContaining({ ok: false, error: withLang('en', () => t().museRefused) })]);
  });

  it("denies the protected paths in the run's profile, which keeps its file tools and its commands from them, and asks nothing", async () => {
    const r = run('protected', { prompt: 'READ: secret' }, () => ({ allow: true }));
    await museRunner.run(r.o);
    expect(r.log()[0]!.settings.permissions.profiles[MUSE_PROFILE].filesystem).toEqual({ [join(r.outside, 'secret.txt')]: 'deny' });
    expect(r.approvals).toEqual([]);
    expect(ends(r)).toEqual([expect.objectContaining({ ok: false, error: 'tool failed: absolute path is outside the workspace' })]);
    const cmd = run('protected-cmd', { prompt: 'RUN: cat secret' }, () => ({ allow: true }));
    await withLang('en', () => museRunner.run(cmd.o));
    expect(cmd.approvals).toEqual([]);
    expect(ends(cmd)).toEqual([expect.objectContaining({ ok: false, error: 'exit code 1', output: `cat: ${cmd.outside}/secret.txt: Operation not permitted` })]);
  });

  it('refuses a protected path Muse asks about without asking the user', async () => {
    const read = run('edit-config', { prompt: 'WRITE: .git/hooks/pre-commit' }, () => ({ allow: true }));
    read.o.protectedPaths = [join(read.o.cwd, '.git')];
    await withLang('en', () => museRunner.run(read.o));
    expect(read.approvals).toEqual([]);
    expect(answers(read)).toEqual(['abort']);
    expect(ends(read)).toEqual([expect.objectContaining({ ok: false, error: withLang('en', () => t().museProtected) })]);
  });

  it('does not start when a protected path has a pattern character in its name, which Muse would read as a pattern', async () => {
    const r = run('plain');
    const odd = join(r.outside, 'Profile *');
    r.o.protectedPaths = [join(r.outside, 'fine'), odd];
    await expect(withLang('en', () => museRunner.run(r.o))).rejects.toThrow(withLang('en', () => t().museProtectedPattern(odd)));
    expect(r.log()).toEqual([]);
    // With full access nothing is denied, so nothing stops it.
    const full = run('plain', { permission: 'full', protectedPaths: [odd] });
    await museRunner.run(full.o);
    expect(full.log()[0]!.settings.permissions).toEqual(musePermissions('full', []));
  });

  it('runs everything with full access: no sandbox, a trusted workspace, the allowAll mode, nothing asked', async () => {
    const r = run('full', { permission: 'full', prompt: 'RUN: echo full' }, () => ({ allow: false }));
    await museRunner.run(r.o);
    const start = r.log()[0]!;
    expect(start.argv).toEqual(['acp', '-c', expect.stringMatching(/^run\.developer_prompt=/), '--disable-sandbox', '--trust-workspace']);
    expect(start.settings.permissions).toEqual({ schema_version: 1, default_profile: ':unrestricted' });
    expect(start.trust).toBeNull(); // trusted by its flag, not by a file the run's folder keeps
    expect(sent(r, 'session/set_config_option')!.params.value).toBe('allowAll');
    expect(r.approvals).toEqual([]);
    expect(ends(r)).toEqual([expect.objectContaining({ ok: true, output: 'rc=0' })]);
  });

  it('resumes a session made with the same permission, with the briefing given again as its developer prompt', async () => {
    const r = run('resume', { sessionId: '01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7', prompt: 'Say hi again', systemPrompt: 'Brief B.' });
    rememberMuseSession('01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7', grantOf(r));
    const result = await museRunner.run(r.o);
    expect(result).toEqual({ sessionId: '01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7' });
    expect(methods(r)).toEqual(['initialize', 'session/resume', 'session/set_config_option', 'session/prompt']);
    expect(sent(r, 'session/resume')!.params).toEqual({ sessionId: '01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7', cwd: r.o.cwd, mcpServers: [] });
    expect(r.log()[0]!.argv).toContain(`run.developer_prompt=${JSON.stringify(museBriefing('Brief B.'))}`);
    expect(r.events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'pong' }]);
  });

  it('fails before the turn says anything when Muse does not know the session', async () => {
    const r = run(undefined, { sessionId: 'nope' });
    rememberMuseSession('nope', grantOf(r));
    await expect(withLang('en', () => museRunner.run(r.o))).rejects.toThrow('session nope not found');
    expect(r.events).toEqual([]);
    expect(methods(r)).toEqual(['initialize', 'session/resume']);
    expect(leftover()).toEqual([]);
  });

  it('resumes only a session this server made with the same permission and denied paths: any other starts afresh, before anything runs', async () => {
    const shield = [join(root, 'shield', 'Cookies'), join(root, 'shield', 'relay.db')];
    const refused = async (r: Run) => {
      const err = (await withLang('en', () => museRunner.run(r.o)).catch((e: unknown) => e)) as AgentRunError;
      expect(err).toBeInstanceOf(AgentRunError);
      expect(err.message).toBe(withLang('en', () => t().museSessionGrant));
      expect(err.aborted).toBe(false);
      // Nothing started, nothing said: the orchestrator retries with a fresh session.
      expect(r.log()).toEqual([]);
      expect(r.events).toEqual([]);
    };
    const id = '01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7';
    // Unknown to this server (made before a restart, or elsewhere).
    await refused(run('resume', { sessionId: 'never-seen', protectedPaths: shield }));
    // Made with full access, resumed with edit: Muse would keep full access.
    rememberMuseSession(id, museGrant('full', []));
    await refused(run('resume', { sessionId: id, protectedPaths: shield }));
    // Made read-only, resumed with edit (and with full access).
    rememberMuseSession(id, museGrant('read-only', shield));
    await refused(run('resume', { sessionId: id, protectedPaths: shield }));
    await refused(run('resume', { sessionId: id, permission: 'full' }));
    // Made with other denied paths: its profile denies those.
    rememberMuseSession(id, museGrant('edit', shield.slice(0, 1)));
    await refused(run('resume', { sessionId: id, protectedPaths: shield }));
    // The same: resumed, the paths in any order.
    rememberMuseSession(id, museGrant('edit', [...shield].reverse()));
    const same = run('resume', { sessionId: id, protectedPaths: shield });
    await museRunner.run(same.o);
    expect(methods(same)).toEqual(['initialize', 'session/resume', 'session/set_config_option', 'session/prompt']);
  });

  it('remembers what a session it made was granted, after a turn that ended well only', async () => {
    const shield = [join(root, 'remember', 'Cookies')];
    // A new session (s-1), its turn over: resumed with the same.
    const made = run(undefined, { protectedPaths: shield });
    expect(await museRunner.run(made.o)).toEqual({ sessionId: 's-1' });
    const again = run(undefined, { sessionId: 's-1', protectedPaths: shield });
    await museRunner.run(again.o);
    expect(methods(again)).toContain('session/resume');
    // A turn that failed records nothing: the session keeps what it had.
    const other = [join(root, 'remember', 'Other')];
    const failed = run(undefined, { protectedPaths: other });
    failed.o.env.FAKE_MUSE_CANCELLED = '1';
    await expect(museRunner.run(failed.o)).rejects.toThrow(AgentRunError);
    await expect(withLang('en', () => museRunner.run(run(undefined, { sessionId: 's-1', protectedPaths: other }).o))).rejects.toThrow(withLang('en', () => t().museSessionGrant));
    const still = run(undefined, { sessionId: 's-1', protectedPaths: shield });
    await museRunner.run(still.o);
    expect(methods(still)).toContain('session/resume');
    // A resumed one is kept with what it was granted, and keys are the permission and the paths each once.
    expect(museGrant('edit', ['/b', '/a', '/a'])).toBe(museGrant('edit', ['/a', '/b']));
    expect(museGrant('edit', [])).not.toBe(museGrant('read-only', []));
    expect(museGrant('edit', ['/a'])).not.toBe(museGrant('edit', ['/a', '/b']));
  });

  it('stops a turn: it cancels the session, and the run ends as stopped', async () => {
    const r = run('abort', { prompt: 'RUN: sleep 40' });
    r.o.onEvent = (e) => {
      r.events.push(e);
      if (e.type === 'tool_start') r.abort.abort();
    };
    const err = (await museRunner.run(r.o).catch((e: unknown) => e)) as AgentRunError;
    expect(err).toBeInstanceOf(AgentRunError);
    expect(err.aborted).toBe(true);
    expect(sent(r, 'session/cancel')!.params).toEqual({ sessionId: '01a1d2b6-f064-7983-b682-016dc919588c' });
    expect(leftover()).toEqual([]);
    // Stopped before it started: nothing runs.
    const early = run('plain');
    early.abort.abort();
    await expect(museRunner.run(early.o)).rejects.toMatchObject({ aborted: true });
    expect(early.log()).toEqual([]);
  });

  it('says to sign in when Muse is not signed in', async () => {
    const r = run('signedout', { prompt: 'hi' });
    delete r.o.env.META_API_KEY;
    await expect(withLang('en', () => museRunner.run(r.o))).rejects.toThrow(withLang('en', () => t().museSignIn('log in to Muse before opening a session')));
    expect(r.log()[0]!.env.META_API_KEY).toBe(false);
  });

  it('fails plainly when Muse rejects the mode, gives no session, or ends the turn by itself', async () => {
    const mode = run(undefined);
    mode.o.env.FAKE_MUSE_REJECT = 'onRequest';
    await expect(withLang('en', () => museRunner.run(mode.o))).rejects.toThrow(withLang('en', () => t().museRejectedMode('unknown value onRequest')));
    const none = run(undefined);
    none.o.env.FAKE_MUSE_NO_SESSION = '1';
    await expect(withLang('en', () => museRunner.run(none.o))).rejects.toThrow(withLang('en', () => t().museNoSession));
    const cancelled = run(undefined);
    cancelled.o.env.FAKE_MUSE_CANCELLED = '1';
    await expect(withLang('en', () => museRunner.run(cancelled.o))).rejects.toThrow(withLang('en', () => t().museCancelled));
    expect(leftover()).toEqual([]);
  });

  it('sends the other working directories, the MCP servers (HTTP ones too: it takes them) and the images, and ignores what another session says', async () => {
    const img = join(root, 'shot.png');
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = run(undefined, {
      images: [{ path: img, mimeType: 'image/png' }],
      mcpServers: [
        { name: 'docs', transport: 'stdio', command: 'node', args: ['s.js'], url: '', env: { TOKEN: 't' }, headers: {} },
        { name: 'web', transport: 'http', command: '', args: [], url: 'https://x', env: {}, headers: { Authorization: 'Bearer y' } },
      ],
    });
    r.o.addDirs = [r.extra];
    r.o.env.FAKE_MUSE_FOREIGN = '1';
    await museRunner.run(r.o);
    const opened = sent(r, 'session/new')!.params;
    expect(opened.additionalDirectories).toEqual([r.extra]);
    expect(opened.mcpServers).toEqual([
      { name: 'docs', command: 'node', args: ['s.js'], env: [{ name: 'TOKEN', value: 't' }] },
      { type: 'http', name: 'web', url: 'https://x', headers: [{ name: 'Authorization', value: 'Bearer y' }] },
    ]);
    expect(sent(r, 'session/prompt')!.params.prompt).toEqual([{ type: 'text', text: 'Say hi' }, { type: 'image', data: 'iVBORw==', mimeType: 'image/png' }]);
    expect(r.events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'hello' }]);
    // Without its say-so, no other working directories and no HTTP MCP servers.
    const plain = run(undefined, { mcpServers: r.o.mcpServers });
    plain.o.addDirs = [plain.extra];
    plain.o.env.FAKE_MUSE_CAPS = JSON.stringify({ loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } });
    await museRunner.run(plain.o);
    expect(sent(plain, 'session/new')!.params).toEqual({ cwd: plain.o.cwd, mcpServers: [{ name: 'docs', command: 'node', args: ['s.js'], env: [{ name: 'TOKEN', value: 't' }] }] });
  });

  it("leaves the MCP servers and hooks a run leaves out of the run's settings", async () => {
    const r = run(undefined, { nativeOff: ['hooks'], nativeItems: { mcp: ['docs'] } });
    writeFileSync(join(r.config, 'settings.json'), JSON.stringify({ mcp_servers: { docs: { command: 'docs' }, web: { url: 'https://x' } }, hooks: { Stop: [] } }));
    await museRunner.run(r.o);
    expect(r.log()[0]!.settings).toEqual({ mcp_servers: { web: { url: 'https://x' } }, schema_version: 1, run: { workflow_trigger_mode: 'off' }, permissions: musePermissions('edit', [join(r.outside, 'secret.txt')]) });
  });

  it("keeps an account besides the default one on its own key: Muse never gets the default account's sign-in", async () => {
    const r = run(undefined);
    r.o.env[MUSE_KEY_ONLY_ENV] = '1';
    await museRunner.run(r.o);
    const start = r.log()[0]!;
    expect(start.auth).toBeNull();
    expect(start.env.HARNESS_RELAY_MUSE_KEY_ONLY).toBeNull(); // not passed on
    expect(start.env.META_API_KEY).toBe(true);
  });

  it("puts a sign-in Muse refreshed during the turn back into the account's", async () => {
    const r = run(undefined);
    r.o.env.FAKE_MUSE_REFRESH = '{"schema_version":2,"refreshed":true}';
    await museRunner.run(r.o);
    expect(readFileSync(join(r.config, 'auth.json'), 'utf8')).toBe('{"schema_version":2,"refreshed":true}');
    expect(lstatSync(join(r.config, 'auth.json')).isFile()).toBe(true);
  });

  it("runs the default account in the user's own config folder, its other folders linked for the commands Muse runs", async () => {
    const r = run(undefined);
    const xdg = join(r.home, 'xdg');
    mkdirSync(join(xdg, 'muse'), { recursive: true });
    mkdirSync(join(xdg, 'git'));
    writeFileSync(join(xdg, 'muse', 'auth.json'), '{}');
    delete r.o.env[MUSE_HOME_ENV];
    r.o.env.XDG_CONFIG_HOME = xdg;
    r.o.env.XDG_DATA_HOME = join(r.home, 'xdg-data');
    await museRunner.run(r.o);
    const start = r.log()[0]!;
    expect(start.entries).toEqual(['git', 'muse']);
    expect(start.auth).toEqual({ link: join(xdg, 'muse', 'auth.json') });
    expect(start.env.XDG_DATA_HOME).toBe(join(r.home, 'xdg-data'));
    expect(existsSync(join(xdg, 'git'))).toBe(true);
  });

  it("does not start when the run's config folder cannot be made", async () => {
    const tmp = museRunsDir();
    const aside = `${tmp}-aside`;
    if (existsSync(tmp)) renameSync(tmp, aside);
    writeFileSync(tmp, 'not a folder');
    try {
      const r = run('plain');
      await expect(withLang('en', () => museRunner.run(r.o))).rejects.toThrow(/Could not prepare Muse Code's settings for this turn/);
      expect(r.log()).toEqual([]);
    } finally {
      rmSync(tmp, { force: true });
      if (existsSync(aside)) renameSync(aside, tmp);
    }
  });

  it.runIf(process.platform === 'linux')('removes the empty folders its sandbox left in the working directories below full access, never one there before', async () => {
    const r = run(undefined);
    r.o.addDirs = [r.extra];
    mkdirSync(join(r.o.cwd, '.muse'));
    // As muse's bubblewrap does: an empty folder of each, in each working directory.
    r.o.env.FAKE_MUSE_MOUNTS = '1';
    await museRunner.run(r.o);
    expect(readdirSync(r.o.cwd)).toEqual(['.muse']);
    expect(readdirSync(r.extra)).toEqual([]);
  });

  it.runIf(process.platform === 'linux')('leaves them to the last of the runs in the same folder to end', async () => {
    // Two turns in one working directory: the first waits for the user's answer while the second ends.
    let answer!: (a: ApprovalAnswer) => void;
    const waiting = new Promise<ApprovalAnswer>((resolve) => (answer = resolve));
    const first = run('edit-ask', { permission: 'read-only', prompt: 'RUN: x' });
    let asked = false;
    first.o.requestApproval = () => {
      asked = true;
      return waiting;
    };
    first.o.env.FAKE_MUSE_MOUNTS = '1';
    const second = run(undefined, { cwd: first.o.cwd });
    second.o.env.FAKE_MUSE_MOUNTS = '1';
    // Started together, both find the folders missing before either sandbox made them.
    const a = museRunner.run(first.o);
    const b = museRunner.run(second.o);
    await b;
    await vi.waitFor(() => expect(asked).toBe(true));
    // The first still has them mounted.
    expect(readdirSync(first.o.cwd).sort()).toEqual([...MUSE_MOUNT_POINTS].sort());
    answer({ allow: true });
    await a;
    expect(readdirSync(first.o.cwd)).toEqual([]);
  });

  it("asks Muse what it loads in a config folder of the probe's own, as a read-only run would", async () => {
    const { NativeSetupService } = await import('../src/server/native');
    const r = run(undefined);
    writeFileSync(join(r.config, 'settings.json'), JSON.stringify({ mcp_servers: { docs: { transport: 'stdio' } }, hooks: { PreToolUse: [{ matcher: 'bash' }] } }));
    writeFileSync(join(r.config, 'trust.json'), '{}');
    const probe = await new NativeSetupService({ env: () => r.o.env, bin: () => bin }).get('muse', r.o.cwd);
    expect(probe.problems).toEqual([]);
    expect(probe.skills.map((s) => s.name)).toEqual(['blender', 'browser-app-delivery', 'browser-game']);
    expect(probe.mcpServers.map((s) => s.name)).toEqual(['docs']);
    expect(probe.hooks).toEqual([expect.objectContaining({ event: 'PreToolUse', matcher: 'bash' })]);
    expect(probe.asRun).toBe(true);
    const start = r.log().find((l) => l.start)!;
    expect(start.argv).toEqual(['skills', 'list', '--json']);
    expect(start.cwd).toBe(r.o.cwd);
    expect(start.env).toMatchObject({ XDG_CONFIG_HOME: expect.stringContaining(join(museRunsDir(), MUSE_RUN_PREFIX)), XDG_DATA_HOME: join(r.home, 'data'), MUSE_DISABLE_APPROVAL_JUDGE: '1', HARNESS_RELAY_MUSE_HOME: null });
    expect(start.settings.permissions).toEqual(musePermissions('read-only', []));
    // Its working directory untrusted (not undecided, which would have it ask a terminal), never the account's trust.
    expect(start.trust).toEqual({ schema_version: 1, projects: { [r.o.cwd]: { decision: 'untrusted' } } });
    expect(leftover()).toEqual([]);
  });
});
