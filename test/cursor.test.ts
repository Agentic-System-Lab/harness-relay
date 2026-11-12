import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A data folder of its own: each turn's private config folder goes in its tmp folder.
const dataDir = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  process.env.RELAY_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'relay-cursor-data-')));
  return process.env.RELAY_DATA_DIR;
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

import {
  createCursorUpdateHandler,
  cursorApprovalRequest,
  cursorArgs,
  cursorCommand,
  cursorConfigDir,
  cursorDenyRules,
  cursorEnv,
  cursorHomePath,
  cursorPath,
  cursorPermissionDecision,
  cursorPromptText,
  cursorQuestionSkip,
  cursorRunConfig,
  cursorRunner,
  cursorServiceError,
  cursorSignInError,
  prepareCursorRun,
} from '../src/server/agents/cursor';
import { AgentRunError, type AgentEvent, type ApprovalRequest } from '../src/server/agents/types';
import { withLang } from '../src/server/i18n';
import { cursorEffortOption, discoverModels, parseCursorModels } from '../src/server/models';
import { relayTmpDir } from '../src/server/protect';

const CWD = '/work/app';

describe('cursor permission policy (no sandbox)', () => {
  it('read-only: runs web fetches and searches and reads, asks about everything else', () => {
    expect(cursorPermissionDecision('read-only', { kind: 'fetch', title: 'Fetch https://example.com' }, CWD).allow).toBe(true);
    expect(cursorPermissionDecision('read-only', { kind: 'search', title: 'Web search: vitest', toolCallId: 'web_search_0' }, CWD).allow).toBe(true);
    expect(cursorPermissionDecision('read-only', { kind: 'read', title: 'Read `/etc/hosts`' }, CWD).allow).toBe(true);
    for (const call of [
      { kind: 'execute', title: '`ls`', rawInput: { command: 'ls' } },
      { kind: 'edit', title: 'Write /work/app/x.txt' },
      { kind: 'edit', title: 'Delete `/work/app/x.txt`' },
      { kind: 'other', title: 'github: create_issue' },
      { kind: 'search', title: 'Grep TODO' },
    ]) {
      expect(cursorPermissionDecision('read-only', call, CWD).allow, call.title).toBe(false);
    }
  });

  it('edit: also deletes inside the working directory, but every write it asks about, command and MCP call asks', () => {
    expect(cursorPermissionDecision('edit', { kind: 'edit', title: 'Delete `/work/app/old.ts`' }, CWD).allow).toBe(true);
    expect(cursorPermissionDecision('edit', { kind: 'delete', rawInput: { path: 'old.ts' } }, CWD).allow).toBe(true);
    expect(cursorPermissionDecision('edit', { kind: 'edit', title: 'Delete `/work/other/x.ts`' }, CWD).allow).toBe(false);
    // Cursor asks about a write inside the workspace only for its protected files, where code could run later.
    for (const title of ['Edit `/work/app/.git/hooks/pre-commit`', 'Write /work/app/.vscode/tasks.json', 'Edit `/work/app/.claude/settings.json`']) {
      expect(cursorPermissionDecision('edit', { kind: 'edit', title }, CWD).allow, title).toBe(false);
    }
    expect(cursorPermissionDecision('edit', { kind: 'edit', rawInput: { path: 'src/b.ts' } }, CWD).allow).toBe(false);
    expect(cursorPermissionDecision('edit', { kind: 'edit', title: 'Write /work/other/x.txt' }, CWD).allow).toBe(false);
    expect(cursorPermissionDecision('edit', { kind: 'execute', rawInput: { command: 'npm test' } }, CWD).allow).toBe(false);
    expect(cursorPermissionDecision('edit', { kind: 'other', title: 'github: create_issue' }, CWD).allow).toBe(false);
    // A subagent's web search and fetch, asked with kind "other".
    expect(cursorPermissionDecision('edit', { kind: 'other', title: 'Allow web search?' }, CWD).allow).toBe(true);
    expect(cursorPermissionDecision('read-only', { kind: 'other', title: 'Allow web fetch?' }, CWD).allow).toBe(true);
    // Not an MCP tool that only looks like one.
    expect(cursorPermissionDecision('edit', { kind: 'other', title: 'Allow web fetch? (my-server)' }, CWD).allow).toBe(false);
    expect(cursorPermissionDecision('edit', { kind: 'execute', title: 'Allow web search?' }, CWD).allow).toBe(false);
  });

  it('edit: takes a link out of the working directory for what it leads to (for a delete)', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-cursor-link-')));
    try {
      mkdirSync(join(root, 'app'));
      mkdirSync(join(root, 'outside'));
      symlinkSync(join(root, 'outside'), join(root, 'app', 'out'));
      const cwd = join(root, 'app');
      expect(cursorPermissionDecision('edit', { kind: 'edit', title: `Delete \`${join(cwd, 'out', 'x.txt')}\`` }, cwd).allow).toBe(false);
      expect(cursorPermissionDecision('edit', { kind: 'edit', title: `Delete \`${join(cwd, 'new', 'x.txt')}\`` }, cwd).allow).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edit: deletes in the conversation's other working directories too, and asks about a write there, saying where it is", () => {
    const docs = ['/work/docs'];
    expect(cursorPermissionDecision('edit', { kind: 'edit', title: 'Delete `/work/docs/old.md`' }, CWD, docs).allow).toBe(true);
    expect(cursorPermissionDecision('edit', { kind: 'edit', title: 'Delete `../docs/old.md`' }, CWD, docs).allow).toBe(true);
    expect(cursorPermissionDecision('edit', { kind: 'edit', title: 'Delete `/work/other/x.md`' }, CWD, docs).allow).toBe(false);
    expect(cursorPermissionDecision('read-only', { kind: 'edit', title: 'Delete `/work/docs/old.md`' }, CWD, docs).allow).toBe(false);
    // A write Cursor asks about there still goes to the user (its protected files cannot be told from the rest).
    expect(cursorPermissionDecision('edit', { kind: 'edit', title: 'Write /work/docs/a.md' }, CWD, docs).allow).toBe(false);
    expect(withLang('en', () => cursorApprovalRequest({ kind: 'edit', title: 'Write /work/docs/a.md' }, CWD, docs)).reason).toBe(
      "This file is in another of the chat's working directories: Cursor works in the first one, and asks before writing in the others.",
    );
    expect(withLang('en', () => cursorApprovalRequest({ kind: 'edit', title: 'Write /work/other/a.md' }, CWD, docs)).reason).toMatch(/^This file is outside the working directory/);
    expect(withLang('en', () => cursorApprovalRequest({ kind: 'edit', title: 'Edit `/work/app/.vscode/tasks.json`' }, CWD, docs)).reason).toMatch(/^Cursor asks before changing files like this one/);
  });

  it('edit: takes a path in the home folder (`~/…`) for one there, not in the working directory', () => {
    // A shell, and Cursor, take `~` for the home folder: a delete there is not the working directory's.
    expect(cursorPermissionDecision('edit', { kind: 'edit', title: 'Delete `~/notes.txt`' }, CWD).allow).toBe(false);
    expect(cursorPermissionDecision('edit', { kind: 'delete', rawInput: { path: '~' } }, CWD).allow).toBe(false);
    // In a working directory inside the home folder, `~/…` there is inside it.
    const project = join(homedir(), 'relay-cursor-project');
    expect(cursorPermissionDecision('edit', { kind: 'edit', title: 'Delete `~/relay-cursor-project/old.ts`' }, project).allow).toBe(true);
    expect(cursorHomePath('~/a/b', '/home/me')).toBe(join('/home/me', 'a/b'));
    expect(cursorHomePath('~\\a', '/home/me')).toBe(join('/home/me', 'a'));
    expect(cursorHomePath('~', '/home/me')).toBe('/home/me');
    // Not a home path: a name that starts with a tilde, and every other path.
    for (const path of ['~notes', 'a/~/b', '/w/~/x', 'src/a.ts']) expect(cursorHomePath(path, '/home/me')).toBe(path);
    // The card says a write there is outside the working directory.
    expect(withLang('en', () => cursorApprovalRequest({ kind: 'edit', title: 'Write ~/.zshrc' }, CWD)).reason).toBe(
      'This file is outside the working directory: Cursor asks before writing outside it.',
    );
  });

  it('full: approves everything', () => {
    expect(cursorPermissionDecision('full', { kind: 'execute', rawInput: { command: 'rm -rf build' } }, CWD).allow).toBe(true);
  });

  it('describes what Cursor asks about, with the command or path its tool call gave', () => {
    // Its permission requests leave the input out; the runner adds the tool call's.
    expect(cursorApprovalRequest({ kind: 'execute', title: '`npm test`', rawInput: { command: 'npm test' } }, '/w')).toEqual({ kind: 'command', detail: 'npm test', outsideSandbox: true });
    expect(cursorCommand({ kind: 'execute', title: "`printf 'hi\\n' > a && cat a`" })).toBe("printf 'hi\\n' > a && cat a");
    // Inside the working directory Cursor asks only about its protected files: the card says why.
    expect(withLang('en', () => cursorApprovalRequest({ kind: 'edit', title: 'Edit `/w/.git/config`' }, '/w'))).toEqual({
      kind: 'edit',
      detail: '/w/.git/config',
      reason: "Cursor asks before changing files like this one: a change here could make code run later, outside any sandbox (a git hook, an editor task), or change an agent's settings.",
    });
    // Outside it, about any write: the card says that instead.
    expect(withLang('en', () => cursorApprovalRequest({ kind: 'edit', title: 'Write /tmp/x.txt' }, '/w'))).toEqual({
      kind: 'edit',
      detail: '/tmp/x.txt',
      reason: 'This file is outside the working directory: Cursor asks before writing outside it.',
    });
    expect(withLang('en', () => cursorApprovalRequest({ kind: 'edit', rawInput: { path: '.vscode/tasks.json' } }, '/w')).reason).toMatch(/^Cursor asks before changing files like this one/);
    expect(withLang('en', () => cursorApprovalRequest({ kind: 'edit', title: 'Edit File' }, '/w')).reason).toMatch(/^Cursor asks before changing files like this one/);
    expect(cursorApprovalRequest({ kind: 'edit', title: 'Delete `/w/old.ts`' }, '/w')).toEqual({ kind: 'edit', detail: '/w/old.ts', reason: 'Delete `/w/old.ts`' });
    expect(cursorPath({ kind: 'edit', title: 'Edit File', content: [{ type: 'diff', path: '/w/a.ts', oldText: 'a', newText: 'b' }] })).toBe('/w/a.ts');
    expect(cursorPath({ kind: 'edit', title: 'Delete `/w/old.ts`' })).toBe('/w/old.ts');
    expect(cursorApprovalRequest({ kind: 'fetch', title: 'Fetch https://example.com/a' }, '/w')).toMatchObject({ kind: 'fetch', detail: 'https://example.com/a' });
    expect(cursorApprovalRequest({ kind: 'other', title: 'github: create_issue', content: [{ type: 'content', content: { type: 'text', text: '{"title":"x"}' } }] }, '/w')).toMatchObject({
      kind: 'other',
      tool: 'github: create_issue',
      detail: '{"title":"x"}',
    });
  });

  it("skips the questions Cursor asks as permission requests (agents ask through Harness Relay)", () => {
    expect(cursorQuestionSkip([{ optionId: 'a', kind: 'allow_once' }, { optionId: '__ask_question_skip__', kind: 'reject_once' }])).toBe('__ask_question_skip__');
    expect(cursorQuestionSkip([{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }])).toBeUndefined();
  });
});

describe('cursor session updates', () => {
  const run = (updates: Record<string, unknown>[], refuse?: [string, string]) => {
    const events: AgentEvent[] = [];
    const h = createCursorUpdateHandler((e) => events.push(e));
    if (refuse) h.refused(...refuse);
    withLang('en', () => {
      for (const u of updates) h.handle(u);
      h.finish();
    });
    return { events, h };
  };

  it('streams text, thinking and plans, and keeps a command\'s output and its exit code', () => {
    const { events } = run([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me check.' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running ' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the tests.' } },
      { sessionUpdate: 'plan', entries: [{ content: 'Test', status: 'in_progress' }, { content: 'Fix', status: 'pending' }] },
      { sessionUpdate: 'tool_call', toolCallId: 'c1\nfc1', title: '`npm test`', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1\nfc1', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1\nfc1', status: 'completed', rawOutput: { exitCode: 0, stdout: '3 passed\n', stderr: '' } },
      { sessionUpdate: 'tool_call', toolCallId: 'c2', title: '`false`', kind: 'execute', status: 'pending', rawInput: { command: 'false' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'completed', rawOutput: { exitCode: 1, stdout: '', stderr: 'nope' } },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
    ]);
    expect(events).toEqual([
      { type: 'thinking', text: 'Let me check.' },
      { type: 'text', text: 'Running ' },
      { type: 'text', text: 'the tests.' },
      { type: 'plan', entries: [{ text: 'Test', status: 'in_progress' }, { text: 'Fix', status: 'pending' }] },
      { type: 'text_end' },
      { type: 'tool_start', id: 'c1\nfc1', name: 'Shell', detail: 'npm test', kind: 'execute' },
      { type: 'tool_end', id: 'c1\nfc1', ok: true, output: '3 passed' },
      { type: 'tool_start', id: 'c2', name: 'Shell', detail: 'false', kind: 'execute' },
      { type: 'tool_end', id: 'c2', ok: false, error: 'exit code 1', output: 'nope' },
    ]);
  });

  it('shows the file an edit is about once Cursor says which, and an MCP tool by its title', () => {
    const { events } = run([
      { sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Edit File', kind: 'edit', status: 'pending', rawInput: {} },
      { sessionUpdate: 'tool_call_update', toolCallId: 'e1', title: 'Edit `/w/a.ts`', rawInput: { path: '/w/a.ts' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed', content: [{ type: 'diff', path: '/w/a.ts', oldText: 'a', newText: 'b' }] },
      { sessionUpdate: 'tool_call', toolCallId: 'm1', title: 'github: create_issue', kind: 'other', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'm1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'bad token' } }] },
    ]);
    expect(events).toEqual([
      { type: 'tool_start', id: 'e1', name: 'Edit', kind: 'edit' },
      { type: 'tool_end', id: 'e1', ok: true, detail: '/w/a.ts' },
      { type: 'tool_start', id: 'm1', name: 'github: create_issue', kind: 'other' },
      { type: 'tool_end', id: 'm1', ok: false, error: 'bad token' },
    ]);
  });

  it("shows why a call was refused (Cursor reports it as completed), and remembers each call's input", () => {
    const { events, h } = run(
      [
        { sessionUpdate: 'tool_call', toolCallId: 'r1', title: '`rm -rf x`', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf x' } },
        { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' },
      ],
      ['r1', 'Refused here'],
    );
    expect(events.at(-1)).toEqual({ type: 'tool_end', id: 'r1', ok: false, error: 'Refused here' });
    expect(h.call('r1')).toMatchObject({ kind: 'execute', rawInput: { command: 'rm -rf x' } });
  });

  it('shows the writes and deletes of read-only mode as not made (Cursor reports a denied one as completed)', () => {
    const events: AgentEvent[] = [];
    const h = createCursorUpdateHandler((e) => events.push(e), true);
    withLang('en', () => {
      h.handle({ sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'Edit `/w/a.ts`', kind: 'edit', status: 'pending', rawInput: { path: '/w/a.ts' } });
      h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'w1', status: 'completed' });
      h.handle({ sessionUpdate: 'tool_call', toolCallId: 'd1', title: 'Delete `/w/old.ts`', kind: 'edit', status: 'pending' });
      h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'd1', status: 'completed' });
    });
    expect(events.filter((e) => e.type === 'tool_end')).toEqual([
      { type: 'tool_end', id: 'w1', ok: false, error: 'Not written: Cursor may not write in read-only mode' },
      { type: 'tool_end', id: 'd1', ok: false, error: 'Not written: Cursor may not write in read-only mode' },
    ]);
  });

  it("keeps an error from Cursor's service out of the reply, to fail the turn with it", () => {
    const { events, h } = run([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nUpgrade your plan to continue' } },
    ]);
    expect(events).toEqual([{ type: 'text', text: 'Partial' }, { type: 'text_end' }]);
    expect(h.serviceError).toBe('Upgrade your plan to continue');
    expect(cursorServiceError('\n\nError: S: WritableIterable is closed')).toBe('S: WritableIterable is closed');
    expect(cursorServiceError('\n\nPlease sign in to continue')).toBe('Please sign in to continue');
    expect(cursorServiceError('\n\nAdd a payment method to continue')).toBe('Add a payment method to continue');
    expect(cursorServiceError('\n\nCheck your settings to continue')).toBe('Check your settings to continue');
    expect(cursorServiceError('\n\nError handling is covered below.')).toBeUndefined(); // "Error " is not "Error: "
    expect(cursorServiceError('Error: but not on a block of its own')).toBeUndefined();
    expect(cursorServiceError('\n\nThe tests pass.')).toBeUndefined();
  });
});

describe("Cursor's settings for one run", () => {
  it('keeps the account\'s own settings, with no allow rules, its deny rules and Harness Relay\'s', () => {
    const own = { model: { modelId: 'gpt-5.5' }, permissions: { allow: ['Shell(*)'], deny: ['Read(.env)'] }, approvalMode: 'unrestricted', network: { useHttp1ForAgent: true } };
    expect(cursorRunConfig(own, 'edit', ['Read(/p)'])).toEqual({
      version: 1,
      model: { modelId: 'gpt-5.5' },
      network: { useHttp1ForAgent: true },
      permissions: { allow: [], deny: ['Read(.env)', 'Read(/p)'] },
      approvalMode: 'allowlist',
    });
    expect(cursorRunConfig(undefined, 'full', [])).toEqual({ version: 1, permissions: { allow: [], deny: [] }, approvalMode: 'unrestricted' });
    expect(cursorRunConfig('not an object', 'read-only', ['Write(**)'])).toMatchObject({ permissions: { allow: [], deny: ['Write(**)'] } });
  });

  it('denies the protected paths to its tools below full access, and any write in read-only mode', () => {
    expect(cursorDenyRules('read-only', ['/u/Library/Chrome', '/relay/data/relay.db'])).toEqual([
      'Write(**)',
      'Read(/u/Library/Chrome)',
      'Read(/u/Library/Chrome/**)',
      'Read(/relay/data/relay.db)',
      'Read(/relay/data/relay.db/**)',
      'Write(/u/Library/Chrome)',
      'Write(/u/Library/Chrome/**)',
      'Write(/relay/data/relay.db)',
      'Write(/relay/data/relay.db/**)',
    ]);
    expect(cursorDenyRules('edit', ['/p/'])).toEqual(['Read(/p)', 'Read(/p/**)', 'Write(/p)', 'Write(/p/**)']);
    expect(cursorDenyRules('full', ['/p'])).toEqual([]);
  });

  it("does not read a project's own .cursor/cli.json, and runs everything with full access", () => {
    expect(cursorArgs('read-only')).toEqual(['--disable-project-configs', 'acp']);
    expect(cursorArgs('edit')).toEqual(['--disable-project-configs', 'acp']);
    expect(cursorArgs('full')).toEqual(['--disable-project-configs', '--force', 'acp']);
    expect(cursorEnv({ PATH: '/bin', CURSOR_CONFIG_DIR: '/mine' }, '/run')).toEqual({ PATH: '/bin', CURSOR_CONFIG_DIR: '/run', NO_OPEN_BROWSER: '1' });
  });

  it("finds Cursor's config folder as Cursor does", () => {
    expect(cursorConfigDir({ CURSOR_CONFIG_DIR: '/c' }, '/home/u')).toBe('/c');
    expect(cursorConfigDir({ XDG_CONFIG_HOME: '/x' }, '/home/u')).toBe(join('/x', 'cursor'));
    expect(cursorConfigDir({}, '/home/u')).toBe(join('/home/u', '.cursor'));
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')("makes a private folder with the run's settings and a link to the account's sessions, and removes only it", () => {
    const account = mkdtempSync(join(tmpdir(), 'relay-cursor-account-'));
    try {
      writeFileSync(join(account, 'cli-config.json'), JSON.stringify({ permissions: { allow: ['Shell(ls)'] } }));
      const run = prepareCursorRun(account, 'read-only', ['Write(**)']);
      expect(run.dir.startsWith(relayTmpDir())).toBe(true);
      expect(statSync(run.dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(run.dir, 'cli-config.json')).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(run.dir, 'cli-config.json'), 'utf8')).permissions).toEqual({ allow: [], deny: ['Write(**)'] });
      expect(lstatSync(join(run.dir, 'acp-sessions')).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(run.dir, 'acp-sessions'))).toBe(realpathSync(join(account, 'acp-sessions')));
      writeFileSync(join(run.dir, 'acp-sessions', 'kept'), 'x');
      run.done();
      expect(existsSync(run.dir)).toBe(false);
      expect(readdirSync(join(account, 'acp-sessions'))).toEqual(['kept']);
      // The account's own settings file is not changed.
      expect(JSON.parse(readFileSync(join(account, 'cli-config.json'), 'utf8'))).toEqual({ permissions: { allow: ['Shell(ls)'] } });
    } finally {
      rmSync(account, { recursive: true, force: true });
    }
  });
});

describe('the briefing, which Cursor has no system prompt for', () => {
  it('goes at the top of the prompt in a new session, and again only when it changed', () => {
    const first = cursorPromptText('Hi', 'You are @Rev.');
    expect(first).toContain('<harness-relay-briefing>');
    expect(first).toContain('You are @Rev.');
    expect(first.endsWith('</harness-relay-briefing>\n\nHi')).toBe(true);
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(cursorPromptText('Next', 'You are @Rev.', hash('You are @Rev.'))).toBe('Next');
    expect(cursorPromptText('Next', 'You are @Lead.', hash('You are @Rev.'))).toContain('You are @Lead.');
    expect(cursorPromptText('Next', '  ')).toBe('Next');
  });
});

describe("Cursor's models", () => {
  it('reads each model with the efforts of its own effort option, not a thinking switch', () => {
    const models = parseCursorModels({
      models: [
        { value: 'default', name: 'Auto', configOptions: [] },
        {
          value: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          configOptions: [
            { id: 'context', category: 'model_config', options: [{ value: '300k' }, { value: '1m' }] },
            { id: 'effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'max' }] },
          ],
        },
        { value: 'gpt-5.5', name: 'GPT 5.5', configOptions: [{ id: 'reasoning', category: 'thought_level', currentValue: 'none', options: [{ value: 'none' }, { value: 'high' }] }] },
        { value: 'claude-opus-5', name: 'Claude Opus 5', configOptions: [{ id: 'thinking', category: 'thought_level', currentValue: 'true', options: [{ value: 'false' }, { value: 'true' }] }] },
        { value: 'grok-4.7', name: 'Grok 4.7  Low Fast​​' },
        { value: 'grok-4.7', name: 'again' },
        { name: 'no id' },
      ],
    });
    expect(models).toEqual([
      { id: 'default', label: 'Auto', efforts: [] },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'max'], defaultEffort: 'medium' },
      { id: 'gpt-5.5', label: 'GPT 5.5', efforts: ['none', 'high'], defaultEffort: 'none' },
      { id: 'claude-opus-5', label: 'Claude Opus 5', efforts: [] },
      { id: 'grok-4.7', label: 'Grok 4.7 Low Fast', efforts: [] },
    ]);
    expect(parseCursorModels(undefined)).toEqual([]);
    expect(cursorEffortOption([{ id: 'thinking', category: 'thought_level', options: [{ value: 'true' }, { value: 'false' }] }])).toBeUndefined();
  });
});

// Its stand-in CLI is a script, and Windows starts only real programs (`.exe`): tried on macOS and Linux.
describe('a Cursor turn (with a stand-in cursor-agent)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-fake-cursor-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Answers like cursor-agent 2026.11.11's ACP server: a resumed session replays its history before
  // `session/load` answers; a shell command is asked about with its input left out; a refused call is
  // reported completed. FAKE_CURSOR_SERVICE_ERROR sends a service error as reply text. Each request,
  // and how the process was started, goes to the log.
  const FAKE_CURSOR = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const log = (o) => fs.appendFileSync(process.env.FAKE_CURSOR_LOG, JSON.stringify(o) + '\\n');
const dir = process.env.CURSOR_CONFIG_DIR;
log({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: dir,
  store: process.env.AGENT_CLI_CREDENTIAL_STORE || null,
  noBrowser: process.env.NO_OPEN_BROWSER || null,
  config: JSON.parse(fs.readFileSync(path.join(dir, 'cli-config.json'), 'utf8')),
  sessions: fs.realpathSync(path.join(dir, 'acp-sessions')),
});
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let next = 0;
const waiting = new Map();
const ask = (method, params) => new Promise((done) => { const id = next++; waiting.set(id, done); out({ jsonrpc: '2.0', id, method, params }); });
const update = (sessionId, u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const MODEL_OPTIONS = { 'claude-opus-5-5': [{ id: 'effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] }] };
let options = [{ id: 'mode', currentValue: 'ask' }, { id: 'model', currentValue: 'default' }];
let hung;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', async (line) => {
  const m = JSON.parse(line);
  if (!m.method) { const done = waiting.get(m.id); waiting.delete(m.id); if (done) done(m.result); return; }
  if (m.id === undefined) {
    log({ notification: m.method });
    if (m.method === 'session/cancel' && hung) hung({ stopReason: 'cancelled' });
    return;
  }
  log({ method: m.method, params: m.params });
  const reply = (result) => out({ jsonrpc: '2.0', id: m.id, result });
  const fail = (message) => out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid params', data: { message } } });
  switch (m.method) {
    case 'initialize':
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, promptCapabilities: { image: true } }, authMethods: [{ id: 'cursor_login' }] });
    case 'authenticate':
      if (process.env.FAKE_CURSOR_SIGNED_OUT) return fail('Failed to open browser for login. Please visit: https://cursor.com/loginDeepControl?challenge=x');
      return reply({});
    case 'cursor/list_available_models':
      return reply({ models: [{ value: 'default', name: 'Auto', configOptions: [] }, { value: 'claude-opus-5-5', name: 'Claude Opus 5.5', configOptions: MODEL_OPTIONS['claude-opus-5-5'] }] });
    case 'session/new': return reply({ sessionId: 'sess-1', configOptions: options });
    case 'session/load': {
      const id = m.params.sessionId;
      if (id === 'gone') return fail('Session "gone" not found');
      update(id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old question' } });
      update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } });
      update(id, { sessionUpdate: 'tool_call', toolCallId: 'replay-0-1', title: '\`ls\`', kind: 'execute', status: 'completed' });
      return reply({ configOptions: options });
    }
    case 'session/set_config_option': {
      const { configId, value } = m.params;
      if (configId === 'model') {
        if (value === 'bogus') return fail('Invalid model value: bogus');
        options = [options[0], { id: 'model', currentValue: value }, ...(MODEL_OPTIONS[value] || [])];
      } else options = options.map((o) => (o.id === configId ? { ...o, currentValue: value } : o));
      return reply({ configOptions: options });
    }
    case 'session/prompt': {
      const sid = m.params.sessionId;
      if (process.env.FAKE_CURSOR_HANG) {
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working…' } });
        return (hung = reply);
      }
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking.' } });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running it.' } });
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 'c1\\nfc1', title: '\`npm test\`', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } });
      const answer = await ask('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 'c1\\nfc1', title: '\`npm test\`', kind: 'execute', status: 'pending', content: [{ type: 'content', content: { type: 'text', text: 'Shell allowlist is empty' } }] },
        options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'allow-always', kind: 'allow_always' }, { optionId: 'reject-once', kind: 'reject_once' }],
      });
      log({ permission: answer });
      const allowed = answer && answer.outcome && answer.outcome.optionId === 'allow-once';
      update(sid, allowed
        ? { sessionUpdate: 'tool_call_update', toolCallId: 'c1\\nfc1', status: 'completed', rawOutput: { exitCode: 0, stdout: 'ok\\n', stderr: '' } }
        : { sessionUpdate: 'tool_call_update', toolCallId: 'c1\\nfc1', status: 'completed' });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: process.env.FAKE_CURSOR_SERVICE_ERROR ? '\\n\\nUpgrade your plan to continue' : 'Done.' } });
      return reply({ stopReason: 'end_turn' });
    }
    default:
      return out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;
  const bin = join(dir, 'cursor-agent');
  writeFileSync(bin, FAKE_CURSOR);
  chmodSync(bin, 0o755);
  const project = join(dir, 'project');
  mkdirSync(project);
  const account = join(dir, 'account');
  mkdirSync(account);
  writeFileSync(join(account, 'cli-config.json'), JSON.stringify({ permissions: { allow: ['Shell(*)'], deny: ['Read(.env)'] }, model: { modelId: 'x' } }));

  const turn = async (o: { log: string; sessionId?: string; permission?: 'read-only' | 'edit' | 'full'; model?: string; effort?: string; env?: NodeJS.ProcessEnv; ask?: boolean; signal?: AbortSignal; onEvent?: (e: AgentEvent) => void }) => {
    const events: AgentEvent[] = [];
    const asked: ApprovalRequest[] = [];
    const logFile = join(dir, o.log);
    let error: unknown;
    let result;
    try {
      result = await withLang('en', () => cursorRunner.run({
        bin,
        env: { ...process.env, CURSOR_CONFIG_DIR: account, FAKE_CURSOR_LOG: logFile, ...o.env },
        prompt: 'Run the tests.',
        systemPrompt: 'You are @Builder.',
        sessionId: o.sessionId,
        cwd: project,
        permission: o.permission ?? 'edit',
        model: o.model,
        effort: o.effort,
        signal: o.signal ?? new AbortController().signal,
        onEvent: (e) => (events.push(e), o.onEvent?.(e)),
        requestApproval: o.ask === false ? undefined : async (req) => (asked.push(req), { allow: true }),
        protectedPaths: ['/protected/browser'],
      }));
    } catch (err) {
      error = err;
    }
    const lines = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    return { events, asked, result, error, lines, methods: lines.filter((l) => l.method).map((l) => l.method as string) };
  };

  it.skipIf(process.platform === 'win32')('starts a session in a private config folder, briefs it, and asks the user about its command', async () => {
    const t = await turn({ log: 'new.log' });
    expect(t.error).toBeUndefined();
    expect(t.result).toEqual({ sessionId: 'sess-1' });
    const [start] = t.lines;
    expect(start.args).toEqual(['--disable-project-configs', 'acp']);
    expect(realpathSync(start.cwd)).toBe(realpathSync(project));
    expect(start.configDir.startsWith(join(dataDir, 'tmp', 'cursor-'))).toBe(true);
    expect(start.noBrowser).toBe('1');
    expect(start.store).toBeNull();
    expect(start.config.permissions).toEqual({ allow: [], deny: ['Read(.env)', 'Read(/protected/browser)', 'Read(/protected/browser/**)', 'Write(/protected/browser)', 'Write(/protected/browser/**)'] });
    expect(start.config.model).toEqual({ modelId: 'x' });
    expect(start.sessions).toBe(realpathSync(join(account, 'acp-sessions')));
    // The folder goes once the turn is over; the account's sessions stay.
    expect(existsSync(start.configDir)).toBe(false);
    expect(existsSync(join(account, 'acp-sessions'))).toBe(true);

    expect(t.methods).toEqual(['initialize', 'authenticate', 'session/new', 'session/set_config_option', 'session/prompt']);
    const init = t.lines.find((l) => l.method === 'initialize');
    expect(init.params.clientCapabilities._meta).toEqual({ parameterizedModelPicker: true });
    // A session left in another mode is put back in agent mode.
    expect(t.lines.find((l) => l.method === 'session/set_config_option').params).toEqual({ sessionId: 'sess-1', configId: 'mode', value: 'agent' });
    const prompt = t.lines.find((l) => l.method === 'session/prompt').params.prompt[0].text as string;
    expect(prompt).toContain('You are @Builder.');
    expect(prompt.endsWith('Run the tests.')).toBe(true);

    expect(t.asked).toEqual([{ kind: 'command', detail: 'npm test', outsideSandbox: true }]);
    expect(t.lines.find((l) => l.permission).permission).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(t.events).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'thinking', text: 'Thinking.' },
      { type: 'text', text: 'Running it.' },
      { type: 'text_end' },
      { type: 'tool_start', id: 'c1\nfc1', name: 'Shell', detail: 'npm test', kind: 'execute' },
      { type: 'tool_end', id: 'c1\nfc1', ok: true, output: 'ok' },
      { type: 'text', text: 'Done.' },
      { type: 'text_end' },
    ]);
  });

  it.skipIf(process.platform === 'win32')('resumes a session without its replayed history or the same briefing again, with the model and effort asked for', async () => {
    const t = await turn({ log: 'resume.log', sessionId: 'sess-1', permission: 'read-only', model: 'claude-opus-5-5', effort: 'high', ask: false });
    expect(t.error).toBeUndefined();
    expect(t.methods).toEqual(['initialize', 'authenticate', 'session/load', 'session/set_config_option', 'session/set_config_option', 'session/set_config_option', 'session/prompt']);
    const set = t.lines.filter((l) => l.method === 'session/set_config_option').map((l) => [l.params.configId, l.params.value]);
    expect(set).toEqual([['mode', 'agent'], ['model', 'claude-opus-5-5'], ['effort', 'high']]);
    expect(t.lines.find((l) => l.method === 'session/prompt').params.prompt[0].text).toBe('Run the tests.');
    expect(t.lines[0].config.permissions.deny).toContain('Write(**)');
    // Refused (the conversation does not ask), with "reject once", never "always".
    expect(t.lines.find((l) => l.permission).permission.outcome).toEqual({ outcome: 'selected', optionId: 'reject-once' });
    expect(t.events.some((e) => e.type === 'text' && e.text === 'old answer')).toBe(false);
    expect(t.events.find((e) => e.type === 'tool_end')).toEqual({ type: 'tool_end', id: 'c1\nfc1', ok: false, error: "Refused: not covered by this conversation's permission" });
  });

  it.skipIf(process.platform === 'win32')('skips an effort the model does not offer, and fails on a model Cursor rejects', async () => {
    const auto = await turn({ log: 'auto.log', effort: 'high' });
    expect(auto.error).toBeUndefined();
    expect(auto.lines.filter((l) => l.method === 'session/set_config_option').map((l) => l.params.configId)).toEqual(['mode']);
    const bogus = await turn({ log: 'bogus.log', model: 'bogus' });
    expect(bogus.error).toBeInstanceOf(AgentRunError);
    expect(String((bogus.error as Error).message)).toContain('bogus');
  });

  it.skipIf(process.platform === 'win32')('runs everything with full access, and does not authenticate over an API key', async () => {
    const t = await turn({ log: 'full.log', permission: 'full', env: { CURSOR_API_KEY: 'key_123' } });
    expect(t.error).toBeUndefined();
    expect(t.lines[0].args).toEqual(['--disable-project-configs', '--force', 'acp']);
    expect(t.lines[0].config).toMatchObject({ permissions: { allow: [], deny: ['Read(.env)'] }, approvalMode: 'unrestricted' });
    expect(t.methods).not.toContain('authenticate');
    expect(t.asked).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')("fails a turn on a service error, and on a session it cannot load (so it is retried fresh)", async () => {
    const service = await turn({ log: 'service.log', env: { FAKE_CURSOR_SERVICE_ERROR: '1' } });
    expect((service.error as Error).message).toBe("Cursor's service reported an error: Upgrade your plan to continue");
    const gone = await turn({ log: 'gone.log', sessionId: 'gone' });
    expect(gone.error).toBeInstanceOf(AgentRunError);
    expect(gone.events).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('says a signed-out Cursor is not signed in, without the sign-in link that would lead nowhere', async () => {
    expect(cursorSignInError('Failed to open browser for login. Please visit: https://cursor.com/loginDeepControl?challenge=x')).toBe('Failed to open browser for login');
    const t = await turn({ log: 'signed-out.log', env: { FAKE_CURSOR_SIGNED_OUT: '1' } });
    expect((t.error as Error).message).toBe('Cursor is not signed in (Failed to open browser for login). Sign in under Cursor in Settings, or set an API key.');
    expect(t.methods).toEqual(['initialize', 'authenticate']);
  });

  it.skipIf(process.platform === 'win32')('stops a turn: cancels the session, and removes the private folder', async () => {
    const stop = new AbortController();
    const t = await turn({ log: 'stop.log', env: { FAKE_CURSOR_HANG: '1' }, signal: stop.signal, onEvent: (e) => e.type === 'text' && stop.abort() });
    expect(t.error).toBeInstanceOf(AgentRunError);
    expect((t.error as AgentRunError).aborted).toBe(true);
    expect(t.lines.some((l) => l.notification === 'session/cancel')).toBe(true);
    expect(existsSync(t.lines[0].configDir)).toBe(false);
  });

  it("fails before it starts when the run's config folder cannot be made", async () => {
    const file = join(dir, 'not-a-folder');
    writeFileSync(file, '');
    const t = await turn({ log: 'no-folder.log', env: { CURSOR_CONFIG_DIR: file } });
    expect((t.error as Error).message).toMatch(/^Could not prepare Cursor's config folder for this turn: /);
    expect(t.lines).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')("asks it for its models over ACP, with no session or prompt, and not authenticate over a key", async () => {
    const log = join(dir, 'models.log');
    const models = await discoverModels('cursor', bin, { ...process.env, CURSOR_CONFIG_DIR: account, FAKE_CURSOR_LOG: log });
    expect(models).toMatchObject({ provider: 'cursor', source: 'cli', efforts: ['low', 'medium', 'high'] });
    expect(models.models).toEqual([
      { id: 'default', label: 'Auto', efforts: [] },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    ]);
    const methods = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.method).map((l) => l.method);
    expect(methods()).toEqual(['initialize', 'authenticate', 'cursor/list_available_models']);
    rmSync(log);
    await discoverModels('cursor', bin, { ...process.env, CURSOR_CONFIG_DIR: account, FAKE_CURSOR_LOG: log, CURSOR_API_KEY: 'key_1' });
    expect(methods()).toEqual(['initialize', 'cursor/list_available_models']);
    const missing = await discoverModels('cursor', join(dir, 'no-such-cursor'), process.env);
    expect(missing).toMatchObject({ provider: 'cursor', models: [], source: 'builtin' });
    expect(missing.error).toBeTruthy();
  });

  it('does not start with a protected path its rules would read as a pattern', async () => {
    await expect(
      cursorRunner.run({
        bin,
        env: { ...process.env, CURSOR_CONFIG_DIR: account },
        prompt: 'x',
        systemPrompt: '',
        cwd: project,
        permission: 'edit',
        signal: new AbortController().signal,
        onEvent: () => undefined,
        protectedPaths: ['/odd/[dir]'],
      }),
    ).rejects.toThrow(/\[dir\]/);
  });
});
