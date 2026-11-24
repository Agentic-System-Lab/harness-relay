import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { isPathDetail } from '../src/web/chat';
import {
  codexApprovalRequest,
  codexApprovalResponse,
  CODEX_FIXED_CONFIG,
  codexConfig,
  codexEndpointEffort,
  codexElicitationResponse,
  codexMcpToolApproval,
  codexConfirmLeftOut,
  codexNativeConfig,
  codexRunner,
  resetCodexProfiles,
  isUnknownMethod,
  codexOverrideArgs,
  codexCheckProfile,
  codexProfile,
  codexProfileId,
  codexThreadRequest,
  codexUserMcp,
  codexUserMcpConfig,
  codexMcpOff,
  codexMcpToolId,
  createCodexUpdateHandler,
  describeCodexItem,
  folderTail,
  sharedFolder,
  codexGuardReads,
  codexGuardRefuses,
} from '../src/server/agents/codex';
import { RpcError } from '../src/server/agents/acp';
import { AgentRunError, TURN_TIMEOUT_MS, type AgentEvent } from '../src/server/agents/types';
import { withLang } from '../src/server/i18n';
import { turnHooks } from '../src/server/hooks';
import { codexHookCall } from '../src/server/agents/codexHooks';

// Shapes trimmed from real `codex app-server` traffic (codex-cli 0.167.0).
const command = (extra: Record<string, unknown>) => ({
  type: 'commandExecution',
  id: 'exec-1',
  command: "/bin/zsh -lc 'npm test'",
  cwd: '/repo',
  status: 'inProgress',
  aggregatedOutput: null,
  exitCode: null,
  ...extra,
});

describe('codex app-server events', () => {
  it('streams text, reasoning, plans and command output', () => {
    const events: AgentEvent[] = [];
    const h = createCodexUpdateHandler((e) => events.push(e));
    h.handle('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Checking the tests.' });
    h.handle('turn/plan/updated', {
      plan: [
        { step: 'Run tests', status: 'inProgress' },
        { step: 'Report', status: 'pending' },
      ],
    });
    h.handle('item/started', { item: command({}) });
    h.handle('item/completed', { item: command({ status: 'completed', exitCode: 0, aggregatedOutput: '> test\nALL-TESTS-PASSED\n' }) });
    h.handle('item/agentMessage/delta', { itemId: 'm1', delta: 'Tests pass.' });
    h.handle('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Tests pass.' } });
    h.handle('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['Checking the tests.'], content: [] } });
    // As codex sends them: the output already counts the reasoning (total = input + output).
    h.handle('thread/tokenUsage/updated', {
      tokenUsage: {
        last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 110 },
        total: { totalTokens: 110 },
      },
    });
    h.handle('thread/tokenUsage/updated', {
      tokenUsage: {
        last: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 52 },
        total: { totalTokens: 162 },
      },
    });
    // The same count again (as Codex sends it with its rate limits): no new call.
    h.handle('thread/tokenUsage/updated', {
      tokenUsage: {
        last: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 52 },
        total: { totalTokens: 162 },
      },
    });

    expect(events).toEqual([
      { type: 'thinking', text: 'Checking the tests.' },
      {
        type: 'plan',
        entries: [
          { text: 'Run tests', status: 'in_progress' },
          { text: 'Report', status: 'pending' },
        ],
      },
      { type: 'tool_start', id: 'exec-1', name: 'Shell', detail: 'npm test' },
      { type: 'tool_end', id: 'exec-1', ok: true, output: '> test\nALL-TESTS-PASSED' },
      { type: 'text', text: 'Tests pass.' },
      { type: 'text_end' },
    ]);
    expect(h.usage).toEqual({ inputTokens: 150, outputTokens: 12 });
  });

  it('reports failed and declined commands', () => {
    const events: AgentEvent[] = [];
    const h = createCodexUpdateHandler((e) => events.push(e));
    h.handle('item/completed', {
      item: command({ id: 'a', status: 'failed', exitCode: 128, aggregatedOutput: 'fatal: not a git repository' }),
    });
    h.handle('item/completed', { item: command({ id: 'b', status: 'declined' }) });
    expect(events.filter((e) => e.type === 'tool_end')).toEqual([
      { type: 'tool_end', id: 'a', ok: false, output: 'fatal: not a git repository', error: 'exit 128' },
      { type: 'tool_end', id: 'b', ok: false, error: '使用者拒絕了這個操作。' },
    ]);
  });

  it('describes tool items', () => {
    // One file: the kind as the name, the path as the detail (a long one keeps its file name).
    const change = (type: string, path = 'a.ts') => ({ type: 'fileChange', changes: [{ path, kind: { type } }] });
    expect(describeCodexItem(change('update'))).toEqual({ name: 'Edit', detail: 'a.ts' });
    expect(describeCodexItem(change('add'))).toEqual({ name: 'Create', detail: 'a.ts' });
    expect(describeCodexItem(change('delete'))).toEqual({ name: 'Delete', detail: 'a.ts' });
    const long = '/repo/' + 'folder-with-a-long-name/'.repeat(8) + 'handler.ts';
    expect(describeCodexItem(change('update', long))!.detail).toMatch(/^…\/.*\/handler\.ts$/);
    // No path: the kind alone.
    expect(describeCodexItem({ type: 'fileChange', changes: [{ kind: { type: 'add' } }] })).toEqual({ name: 'Create', detail: undefined });
    // Several files: each with its kind, relative to the folder they share (named by its last two names).
    const several = (...paths: [string, string][]) =>
      describeCodexItem({ type: 'fileChange', changes: paths.map(([type, path]) => ({ path, kind: { type } })) });
    expect(several(['update', 'a.ts'], ['add', 'b.ts'])).toEqual({ name: 'Edit', detail: 'update a.ts, add b.ts' });
    const root = '/Users/me/Desktop/projects/refstitch/crates/refstitch-core/';
    expect(several(['update', `${root}src/data.py`], ['add', `${root}src/cli.py`], ['delete', `${root}tests/old.py`])).toEqual({
      name: 'Edit',
      detail: 'crates/refstitch-core/: update src/data.py, add src/cli.py, delete tests/old.py',
    });
    expect(several(['update', '/a.ts'], ['update', '/b.ts'])).toEqual({ name: 'Edit', detail: 'update /a.ts, update /b.ts' });
    // A list of files is never laid out as one path (its start would be cut), with a shared folder or
    // without, and when it is cut at its end; one file always is, however long.
    const lists = [
      several(['update', `${root}src/data.py`], ['add', `${root}src/cli.py`]),
      several(['update', '/a.ts'], ['update', '/b.ts']),
      several(...Array.from({ length: 12 }, (_, i): [string, string] => ['update', `${root}src/module-${i}/handler.py`])),
    ];
    for (const list of lists) expect(isPathDetail(list!.detail!), list!.detail).toBe(false);
    expect(lists[2]!.detail!.endsWith('…')).toBe(true);
    expect(isPathDetail(describeCodexItem(change('update', long))!.detail!)).toBe(true);
  });

  it('finds the folder several paths share', () => {
    expect(sharedFolder(['/repo/src/a.ts', '/repo/src/b.ts'])).toBe('/repo/src/');
    expect(sharedFolder(['/repo/src/a.ts', '/repo/test/a.ts'])).toBe('/repo/');
    // A shared start of a file name is not a folder.
    expect(sharedFolder(['/repo/app.ts', '/repo/app.test.ts'])).toBe('/repo/');
    expect(sharedFolder(['/repo/a.ts', '/repo/a.ts.bak'])).toBe('/repo/');
    expect(sharedFolder(['C:\\repo\\a.ts', 'C:\\repo\\b.ts'])).toBe('C:\\repo\\');
    // Nothing shared but the root, one path, or relative paths in no common folder.
    expect(sharedFolder(['/a.ts', '/b.ts'])).toBe('');
    expect(sharedFolder(['/repo/a.ts'])).toBe('');
    expect(sharedFolder(['a.ts', 'b.ts'])).toBe('');
    // The same file twice, a folder and a file in it, and mixed separators.
    expect(sharedFolder(['/repo/a.ts', '/repo/a.ts'])).toBe('/repo/');
    expect(sharedFolder(['/repo/src', '/repo/src/a.ts'])).toBe('/repo/');
    expect(sharedFolder(['C:\\repo\\a.ts', 'C:/repo/b.ts'])).toBe('');
    // A folder named by its last two names.
    expect(folderTail('/Users/me/refstitch/crates/refstitch-core/')).toBe('crates/refstitch-core/');
    expect(folderTail('/repo/')).toBe('repo/');
    expect(folderTail('C:\\repo\\src\\')).toBe('repo\\src\\');
    expect(describeCodexItem({ type: 'webSearch', query: 'vitest' })).toEqual({ name: 'WebSearch', detail: 'vitest' });
    expect(describeCodexItem({ type: 'webSearch', query: ' ', action: { type: 'openPage', url: 'https://vitest.dev' } })).toEqual({
      name: 'WebSearch',
      detail: 'https://vitest.dev',
    });
    expect(describeCodexItem({ type: 'webSearch', query: '', action: { type: 'other' } })).toEqual({
      name: 'WebSearch',
      detail: undefined,
    });
    expect(describeCodexItem({ type: 'agentMessage' })).toBeNull();
  });

  it('shows a new file by its path from the start, and keeps it when the item completes', () => {
    const events: AgentEvent[] = [];
    const h = createCodexUpdateHandler((e) => events.push(e));
    const item = (status: string) => ({
      type: 'fileChange',
      id: 'p1',
      status,
      changes: [{ path: '/repo/src/new.ts', kind: { type: 'add' }, diff: '+x' }],
    });
    h.handle('item/started', { item: item('inProgress') });
    h.handle('item/completed', { item: item('completed') });
    expect(events).toEqual([
      { type: 'tool_start', id: 'p1', name: 'Create', detail: '/repo/src/new.ts' },
      { type: 'tool_end', id: 'p1', ok: true },
    ]);
  });

  it('shows what a web search searched for, which only comes when it is done', () => {
    const events: AgentEvent[] = [];
    const h = createCodexUpdateHandler((e) => events.push(e));
    h.handle('item/started', { item: { type: 'webSearch', id: 'ws-1', query: '', action: null } });
    h.handle('item/completed', {
      item: { type: 'webSearch', id: 'ws-1', query: 'vitest mock timers', action: { type: 'search', query: 'vitest mock timers' } },
    });
    h.handle('item/started', { item: { type: 'webSearch', id: 'ws-2', query: '', action: null } });
    h.handle('item/completed', {
      item: {
        type: 'webSearch',
        id: 'ws-2',
        query: '',
        action: { type: 'findInPage', url: 'https://vitest.dev/api', pattern: 'useFakeTimers' },
      },
    });
    expect(events).toEqual([
      { type: 'tool_start', id: 'ws-1', name: 'WebSearch' },
      { type: 'tool_end', id: 'ws-1', ok: true, detail: 'vitest mock timers' },
      { type: 'tool_start', id: 'ws-2', name: 'WebSearch' },
      { type: 'tool_end', id: 'ws-2', ok: true, detail: '"useFakeTimers" · https://vitest.dev/api' },
    ]);
  });
});

describe("codex subagents and notes about its own run (shapes from Codex 0.167.0's app-server schema)", () => {
  const spawn = (id: string, status: string, sender: string, receivers: string[]) => ({
    type: 'collabAgentToolCall',
    id,
    tool: 'spawnAgent',
    status,
    senderThreadId: sender,
    receiverThreadIds: receivers,
    prompt: 'Find where dates are parsed',
    model: 'gpt-5.5-mini',
    reasoningEffort: 'low',
    agentsStates: {},
  });
  const started = (id: string, parent: string, role: string) => ({
    thread: {
      id,
      parentThreadId: parent,
      source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_role: role } } },
    },
  });

  it("folds each subagent's calls under its spawn call, a subagent's own subagent under it, and ends it with its last words", () => {
    const events: AgentEvent[] = [];
    const h = createCodexUpdateHandler((e) => events.push(e));
    h.main('main');
    h.handle('item/started', { threadId: 'main', item: spawn('call-a', 'inProgress', 'main', []) });
    h.handle('thread/started', started('thr-a', 'main', 'explorer'));
    h.handle('item/completed', { threadId: 'main', item: spawn('call-a', 'completed', 'main', ['thr-a']) });
    h.handle('item/started', { threadId: 'thr-a', item: command({ id: 'exec-a', command: 'rg parseDate' }) });
    h.handle('item/agentMessage/delta', { threadId: 'thr-a', itemId: 'm-a', delta: 'Looking.' });
    // Its own subagent.
    h.handle('item/started', { threadId: 'thr-a', item: spawn('call-b', 'inProgress', 'thr-a', []) });
    h.handle('thread/started', started('thr-b', 'thr-a', 'worker'));
    h.handle('item/started', {
      threadId: 'thr-b',
      item: { type: 'fileChange', id: 'p-b', status: 'inProgress', changes: [{ path: '/repo/a.ts', kind: { type: 'update' } }] },
    });
    h.handle('turn/completed', { threadId: 'thr-b', turn: { id: 't-b', status: 'failed', error: { message: 'usage limit' }, items: [] } });
    h.handle('item/completed', {
      threadId: 'thr-a',
      item: command({ id: 'exec-a', command: 'rg parseDate', status: 'completed', exitCode: 0 }),
    });
    h.handle('item/completed', { threadId: 'thr-a', item: { type: 'agentMessage', id: 'm-a', text: 'Dates are parsed in src/date.ts.' } });
    h.handle('turn/completed', { threadId: 'thr-a', turn: { id: 't-a', status: 'completed', items: [] } });
    // A thread of no subagent of this turn's: not shown.
    h.handle('item/started', { threadId: 'thr-other', item: command({ id: 'exec-x' }) });
    h.handle('thread/started', started('thr-x', 'elsewhere', 'stranger'));
    // Waiting for it: a row of its own, with the states the subagents reported.
    const wait = (status: string, agentsStates = {}) => ({
      type: 'collabAgentToolCall',
      id: 'call-wait',
      tool: 'wait',
      status,
      senderThreadId: 'main',
      receiverThreadIds: ['thr-a'],
      agentsStates,
    });
    h.handle('item/started', { threadId: 'main', item: wait('inProgress') });
    h.handle('item/completed', { threadId: 'main', item: wait('completed', { 'thr-a': { status: 'completed', message: 'Found it.' } }) });
    expect(events).toEqual([
      { type: 'tool_start', id: 'call-a', name: 'spawn_agent', detail: 'Find where dates are parsed', model: 'gpt-5.5-mini' },
      { type: 'tool_start', id: 'call-a', name: 'spawn_agent', agent: 'explorer' },
      { type: 'tool_start', id: 'exec-a', name: 'Shell', detail: 'rg parseDate', parentId: 'call-a' },
      {
        type: 'tool_start',
        id: 'call-b',
        name: 'spawn_agent',
        detail: 'Find where dates are parsed',
        model: 'gpt-5.5-mini',
        parentId: 'call-a',
      },
      { type: 'tool_start', id: 'call-b', name: 'spawn_agent', agent: 'worker' },
      { type: 'tool_start', id: 'p-b', name: 'Edit', detail: '/repo/a.ts', parentId: 'call-b' },
      { type: 'tool_end', id: 'call-b', ok: false, error: 'usage limit' },
      { type: 'tool_end', id: 'exec-a', ok: true },
      { type: 'tool_end', id: 'call-a', ok: true, output: 'Dates are parsed in src/date.ts.' },
      { type: 'tool_start', id: 'call-wait', name: 'wait', detail: 'explorer' },
      { type: 'tool_end', id: 'call-wait', ok: true, output: 'explorer: Found it.' },
    ]);
    // An approval for a subagent's file change names its file.
    expect(h.filePaths('p-b')).toBe('/repo/a.ts');
  });

  it("counts the subagents' tokens with the turn's, once per change of each thread's total", () => {
    const h = createCodexUpdateHandler(() => undefined);
    h.main('main');
    h.handle('item/started', { threadId: 'main', item: spawn('call-a', 'inProgress', 'main', []) });
    h.handle('thread/started', started('thr-a', 'main', 'explorer'));
    const usage = (threadId: string, input: number, output: number, total: number) =>
      h.handle('thread/tokenUsage/updated', {
        threadId,
        turnId: 't',
        tokenUsage: {
          last: { inputTokens: input, outputTokens: output, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: input + output },
          total: { totalTokens: total },
        },
      });
    usage('main', 100, 10, 110);
    usage('thr-a', 40, 4, 44);
    usage('thr-a', 40, 4, 44); // the same count again
    usage('main', 20, 2, 132);
    usage('thr-other', 999, 99, 1098); // no thread of this turn's
    expect(h.usage).toEqual({ inputTokens: 160, outputTokens: 16 });
  });

  it('cuts off a subagent still at work when the turn ends, and notes compaction and a rerouted model', () => {
    const events: AgentEvent[] = [];
    const h = withLang('en', () => {
      const h = createCodexUpdateHandler((e) => events.push(e));
      h.main('main');
      h.handle('item/started', { threadId: 'main', item: spawn('call-a', 'inProgress', 'main', []) });
      h.handle('item/completed', { threadId: 'main', item: { type: 'contextCompaction', id: 'cc-1' } });
      h.handle('model/rerouted', {
        threadId: 'main',
        turnId: 't',
        fromModel: 'gpt-5.5',
        toModel: 'gpt-5.5-safe',
        reason: 'highRiskCyberActivity',
      });
      h.finish();
      return h;
    });
    expect(h.usage).toEqual({});
    expect(events.slice(1)).toEqual([
      { type: 'notice', text: "Codex compacted the conversation's context to make room." },
      { type: 'notice', text: 'Codex switched models from gpt-5.5 to gpt-5.5-safe.' },
      { type: 'tool_end', id: 'call-a', ok: false, error: 'The turn ended before this work finished.' },
    ]);
  });

  it('gives a subagent that no spawn call started a row of its own from its activity', () => {
    const events: AgentEvent[] = [];
    const h = createCodexUpdateHandler((e) => events.push(e));
    h.main('main');
    const act = (kind: string) => ({
      type: 'subAgentActivity',
      id: 'act-1',
      agentThreadId: 'thr-a',
      agentPath: '/root/reviewer',
      kind,
      model: 'gpt-5.5',
    });
    h.handle('item/completed', { threadId: 'main', item: act('started') });
    h.handle('item/started', { threadId: 'thr-a', item: command({ id: 'exec-a' }) });
    h.handle('item/completed', { threadId: 'main', item: act('completed') });
    expect(events).toEqual([
      { type: 'tool_start', id: 'act-1', name: 'subagent', agent: 'reviewer', model: 'gpt-5.5' },
      { type: 'tool_start', id: 'exec-a', name: 'Shell', detail: 'npm test', parentId: 'act-1' },
      { type: 'tool_end', id: 'act-1', ok: true },
    ]);
  });
});

describe('codex approvals', () => {
  it('turns approval requests into what the user sees, and answers in the shape Codex expects', () => {
    const paths = (id: string) => (id === 'patch-1' ? 'src/a.ts' : undefined);
    expect(
      codexApprovalRequest(
        'item/commandExecution/requestApproval',
        { command: "/bin/zsh -lc 'touch ../x'", reason: 'Outside the sandbox' },
        paths,
      ),
    ).toEqual({ kind: 'command', detail: 'touch ../x', command: "/bin/zsh -lc 'touch ../x'", reason: 'Outside the sandbox' });
    expect(codexApprovalRequest('item/fileChange/requestApproval', { itemId: 'patch-1' }, paths)).toMatchObject({
      kind: 'edit',
      detail: 'src/a.ts',
    });
    expect(codexApprovalRequest('item/tool/call', {}, paths)).toBeNull();

    expect(codexApprovalResponse('item/commandExecution/requestApproval', {}, true)).toEqual({ decision: 'accept' });
    expect(codexApprovalResponse('item/fileChange/requestApproval', {}, false)).toEqual({ decision: 'decline' });
    expect(codexApprovalResponse('execCommandApproval', {}, false, 'no')).toEqual({ decision: { denied: { rejection: 'no' } } });
    expect(codexApprovalResponse('item/permissions/requestApproval', { permissions: { network: { enabled: true } } }, true)).toEqual({
      permissions: { network: { enabled: true }, fileSystem: undefined },
      scope: 'turn',
    });
  });

  it("shows Codex's MCP tool-call approvals like any other, and declines other elicitations", () => {
    // As codex-cli 0.167.0 sends it.
    const ask = {
      threadId: 't',
      turnId: 'u',
      serverName: 'relay-test',
      mode: 'form',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: ['session', 'always'],
        tool_name: 'relay_secret_word',
        tool_description: 'Returns the secret word.',
        tool_params: {},
        tool_params_display: [],
      },
      message: 'Allow the relay-test MCP server to run tool "relay_secret_word"?',
      requestedSchema: { type: 'object', properties: {} },
    };
    expect(codexMcpToolApproval(ask)).toEqual({ kind: 'other', tool: 'relay-test:relay_secret_word' });
    expect(codexMcpToolApproval({ ...ask, _meta: { ...ask._meta, tool_params: { repo: 'a/b' } } })).toMatchObject({
      detail: '{"repo":"a/b"}',
    });
    // A form the server itself wants filled in is not an approval.
    expect(codexMcpToolApproval({ serverName: 'x', mode: 'form', message: 'Your name?', requestedSchema: {} })).toBeNull();
    expect(codexElicitationResponse(true)).toEqual({ action: 'accept', content: {}, _meta: null });
    expect(codexElicitationResponse(false)).toEqual({ action: 'decline', content: null, _meta: null });
  });
});

describe('codex thread config', () => {
  it('keeps the edit-mode sandbox off the network whatever the user config says', () => {
    expect(codexConfig('edit', 'high')).toEqual({
      ...CODEX_FIXED_CONFIG,
      model_reasoning_effort: 'high',
      sandbox_workspace_write: { network_access: false },
    });
    expect(codexConfig('read-only')).toEqual({ ...CODEX_FIXED_CONFIG });
    expect(codexConfig('full')).toEqual({ ...CODEX_FIXED_CONFIG });
  });

  it("lets edit mode write the conversation's other working directories too", () => {
    // The legacy sandbox (Windows, nothing to protect): writable roots.
    expect(codexConfig('edit', undefined, [], { off: [] }, ['/docs', '/infra'])).toEqual({
      ...CODEX_FIXED_CONFIG,
      sandbox_workspace_write: { network_access: false, writable_roots: ['/docs', '/infra'] },
    });
    expect(codexConfig('read-only', undefined, [], { off: [] }, ['/docs'])).toEqual({ ...CODEX_FIXED_CONFIG });
    // A permission profile: a write entry each, and a protected path is denied all the same.
    expect(codexProfile('edit', ['/x', '/docs/secret.db'], 'darwin', ['/docs'])).toEqual({
      extends: ':workspace',
      filesystem: { '/docs': 'write', '/x': 'deny', '/docs/secret.db': 'deny' },
    });
    expect(codexProfile('read-only', ['/x'], 'darwin', ['/docs'])).toEqual({ extends: ':read-only', filesystem: { '/x': 'deny' } });
    const run = {
      cwd: '/repo',
      addDirs: ['/docs'],
      permission: 'edit' as const,
      systemPrompt: '',
      requestApproval: async () => ({ allow: true }),
    };
    const profiled = codexThreadRequest({ ...run, protectedPaths: ['/x'] }, undefined, 'linux', 'harness-relay-1').params;
    expect(profiled.config).toMatchObject({ permissions: { 'harness-relay-1': { filesystem: { '/docs': 'write', '/x': 'deny' } } } });
    expect(profiled.config).not.toHaveProperty('sandbox_workspace_write');
    expect(codexThreadRequest(run, undefined, 'win32').params.config).toMatchObject({
      sandbox_workspace_write: { network_access: false, writable_roots: ['/docs'] },
    });
  });

  it("adds library MCP servers in one mcp_servers table, which Codex merges into the user's own", () => {
    expect(
      codexConfig('read-only', undefined, [
        { name: 'gh', transport: 'stdio', command: 'npx', args: ['gh'], url: '', env: { TOKEN: 't' }, headers: {} },
        {
          name: 'docs',
          transport: 'http',
          command: '',
          args: [],
          url: 'https://x.test/mcp',
          env: {},
          headers: { Authorization: 'Bearer b' },
        },
      ]),
    ).toEqual({
      ...CODEX_FIXED_CONFIG,
      mcp_servers: {
        gh: { command: 'npx', args: ['gh'], env: { TOKEN: 't' } },
        docs: { url: 'https://x.test/mcp', http_headers: { Authorization: 'Bearer b' } },
      },
    });
  });

  it("gives Harness Relay's own tools a turn's time per call, as they may wait for the user, not Codex's 5 minutes", () => {
    const relay = { name: 'relay', transport: 'http' as const, command: '', args: [], url: 'http://127.0.0.1:4/mcp', env: {}, headers: {} };
    const gh = { name: 'gh', transport: 'stdio' as const, command: 'gh-mcp', args: [], url: '', env: {}, headers: {} };
    const table = codexConfig('edit', undefined, [relay, gh]).mcp_servers as Record<string, Record<string, unknown>>;
    expect(table.relay!.tool_timeout_sec).toBe(Math.ceil(TURN_TIMEOUT_MS / 1000));
    expect(table.gh).not.toHaveProperty('tool_timeout_sec');
  });

  it("lets the library's servers approve their own tools in full access, where Codex would refuse every MCP call", () => {
    const gh = { name: 'gh', transport: 'stdio' as const, command: 'gh-mcp', args: [], url: '', env: {}, headers: {} };
    expect(codexConfig('full', undefined, [gh])).toEqual({
      ...CODEX_FIXED_CONFIG,
      mcp_servers: { gh: { command: 'gh-mcp', args: [], default_tools_approval_mode: 'approve' } },
    });
    // Below full access Codex asks, and the user answers in the chat.
    expect((codexConfig('edit', undefined, [gh]).mcp_servers as Record<string, object>).gh).not.toHaveProperty(
      'default_tools_approval_mode',
    );
  });

  it('leaves out what Codex loads by itself; each of its configured MCP servers, whatever its name', () => {
    const gh = { name: 'gh', transport: 'stdio' as const, command: 'npx', args: ['gh'], url: '', env: {}, headers: {} };
    expect(
      codexConfig('read-only', undefined, [gh], {
        off: ['skills', 'mcp', 'instructions', 'memory'],
        user: { names: ['headroom', 'gh', 'a.b'], disabledTools: {} },
      }),
    ).toEqual({
      ...CODEX_FIXED_CONFIG,
      'skills.include_instructions': false,
      'features.apps': false,
      project_doc_max_bytes: 0,
      'features.memories': false,
      // gh is the tool library's (it replaces the user's gh). A dotted key could not reach "a.b"; the table can.
      mcp_servers: { headroom: { enabled: false }, 'a.b': { enabled: false }, gh: { command: 'npx', args: ['gh'] } },
    });
    // The user's servers stay on unless MCP servers are left out.
    expect(codexConfig('read-only', undefined, [], { off: ['skills'], user: { names: ['headroom'], disabledTools: {} } })).toEqual({
      ...CODEX_FIXED_CONFIG,
      'skills.include_instructions': false,
    });
    expect(codexNativeConfig([])).toEqual({});
    expect(codexNativeConfig(['instructions'])).toEqual({ project_doc_max_bytes: 0 });
    // Its hooks (plugins' too) and its plugins, each with its feature switch.
    expect(codexNativeConfig(['hooks', 'plugins'])).toEqual({ 'features.hooks': false, 'features.plugins': false });
  });

  it('leaves out single skills by path, hooks by key and plugins by id, as tables Codex merges', () => {
    const items = { skills: ['/s/a/SKILL.md'], hooks: ['/u/.codex/hooks.json:stop:0:0'], plugins: ['pdf@openai'] };
    expect(codexNativeConfig([], items)).toEqual({
      'skills.config': [{ path: '/s/a/SKILL.md', enabled: false }],
      'hooks.state': { '/u/.codex/hooks.json:stop:0:0': { enabled: false } },
      plugins: { 'pdf@openai': { enabled: false } },
    });
    // Hooks and plugins left out whole go by their feature switch alone.
    expect(codexNativeConfig(['hooks', 'plugins'], items)).toEqual({
      'skills.config': [{ path: '/s/a/SKILL.md', enabled: false }],
      'features.hooks': false,
      'features.plugins': false,
    });
    expect(codexOverrideArgs(codexNativeConfig([], items))).toEqual([
      '-c',
      'skills.config=[{ "path" = "/s/a/SKILL.md", "enabled" = false }]',
      '-c',
      'hooks.state={ "/u/.codex/hooks.json:stop:0:0" = { "enabled" = false } }',
      '-c',
      'plugins={ "pdf@openai" = { "enabled" = false } }',
    ]);
  });

  it("turns off single MCP servers and tools of the user's own, keeping the tools they already turned off", () => {
    const user = codexUserMcpConfig({
      config: { mcp_servers: { headroom: { command: 'h' }, node: { command: 'n', disabled_tools: ['old'] }, 'a.b': {} } },
    });
    expect(user).toEqual({ names: ['headroom', 'node', 'a.b'], disabledTools: { node: ['old'] } });
    const items = {
      mcp: ['headroom', 'gone'],
      mcpTools: [
        codexMcpToolId('node', 'js_reset'),
        codexMcpToolId('a.b', 'x/y'),
        codexMcpToolId('headroom', 'run'),
        codexMcpToolId('gone', 'z'),
        'not json',
      ],
    };
    // Only servers in the user's config (an entry for another would be a server without a command),
    // and no tools of a server that is off anyway.
    expect(codexMcpOff([], items, user)).toEqual({ turnOff: ['headroom'], toolsOff: { node: ['old', 'js_reset'], 'a.b': ['x/y'] } });
    expect(codexMcpOff(['mcp'], items, user)).toEqual({ turnOff: ['headroom', 'node', 'a.b'], toolsOff: {} });
    expect(codexConfig('read-only', undefined, [], { off: [], items, user })).toEqual({
      ...CODEX_FIXED_CONFIG,
      mcp_servers: { node: { disabled_tools: ['old', 'js_reset'] }, 'a.b': { disabled_tools: ['x/y'] }, headroom: { enabled: false } },
    });
    expect(codexUserMcpConfig(undefined)).toEqual({ names: [], disabledTools: {} });
    expect(codexUserMcpConfig({ config: {} })).toEqual({ names: [], disabledTools: {} });
  });

  it('writes the same overrides as -c arguments, tables inline with every key quoted', () => {
    expect(
      codexOverrideArgs({
        'features.hooks': false,
        project_doc_max_bytes: 0,
        mcp_servers: { headroom: { enabled: false }, 'a.b': { enabled: false }, 'say "hi"': { args: ['x', 'y'] } },
      }),
    ).toEqual([
      '-c',
      'features.hooks=false',
      '-c',
      'project_doc_max_bytes=0',
      '-c',
      'mcp_servers={ "headroom" = { "enabled" = false }, "a.b" = { "enabled" = false }, "say \\"hi\\"" = { "args" = ["x", "y"] } }',
    ]);
    expect(codexOverrideArgs({})).toEqual([]);
  });

  it("sends an effort the user's own endpoint takes, asking Codex's config only when none was given", async () => {
    const asked: string[] = [];
    const conn = (effort: unknown) => ({
      request: async (method: string) => (asked.push(method), { config: { model_reasoning_effort: effort } }),
    });
    expect(await codexEndpointEffort('low', conn('xhigh'), '/repo')).toBe('low');
    expect(await codexEndpointEffort('xhigh', conn('high'), '/repo')).toBe('medium');
    expect(asked).toEqual([]);
    expect(await codexEndpointEffort(undefined, conn('xhigh'), '/repo')).toBe('medium');
    expect(await codexEndpointEffort(undefined, conn('high'), '/repo')).toBe('high');
    expect(await codexEndpointEffort(undefined, conn(null), '/repo')).toBeUndefined();
    // Codex cannot say: one the endpoint takes, rather than whatever its config holds.
    const old = { request: async () => Promise.reject(new RpcError(-32601, 'config/read is not supported')) };
    expect(await codexEndpointEffort(undefined, old, '/repo')).toBe('medium');
  });

  it('asks Codex for its MCP servers only when they are left out, and fails the run plainly when it cannot say', async () => {
    const asked: [string, unknown][] = [];
    const conn = (answer: () => Promise<unknown>) => ({
      request: (method: string, params?: unknown) => (asked.push([method, params]), answer()),
    });
    const ok = conn(async () => ({ config: { mcp_servers: { headroom: { disabled_tools: ['x'] } } } }));
    const none = { names: [], disabledTools: {} };
    expect(await codexUserMcp(ok, { cwd: '/repo', nativeOff: ['skills', 'memory'], nativeItems: { skills: ['/s/SKILL.md'] } })).toEqual(
      none,
    );
    expect(await codexUserMcp(ok, { cwd: '/repo' })).toEqual(none);
    expect(asked).toEqual([]);
    const headroom = { names: ['headroom'], disabledTools: { headroom: ['x'] } };
    expect(await codexUserMcp(ok, { cwd: '/repo', nativeOff: ['mcp'] })).toEqual(headroom);
    expect(asked).toEqual([['config/read', { cwd: '/repo' }]]);
    // Single servers or tools need the list too.
    expect(await codexUserMcp(ok, { cwd: '/repo', nativeItems: { mcp: ['headroom'] } })).toEqual(headroom);
    expect(await codexUserMcp(ok, { cwd: '/repo', nativeItems: { mcpTools: [codexMcpToolId('headroom', 'y')] } })).toEqual(headroom);

    // An older codex without config/read, say: going on would run the servers the user turned off.
    const old = conn(async () => {
      throw new RpcError(-32601, 'config/read is not supported');
    });
    const failure = withLang('en', () => codexUserMcp(old, { cwd: '/repo', nativeOff: ['mcp'] }));
    await expect(failure).rejects.toBeInstanceOf(AgentRunError);
    await expect(failure).rejects.toThrow(
      /^Codex could not list its MCP servers, so they or their tools could not be left out of this run \(config\/read is not supported\)/,
    );
  });

  it("starts or resumes the thread with the run's settings and the user's MCP servers turned off", () => {
    const run = {
      cwd: '/repo',
      permission: 'edit' as const,
      systemPrompt: 'You are @Alice',
      model: 'gpt-5.5',
      nativeOff: ['mcp' as const],
      requestApproval: async () => ({ allow: true }),
    };
    const user = { names: ['headroom'], disabledTools: {} };
    const start = codexThreadRequest(run, user);
    expect(start).toEqual({
      method: 'thread/start',
      params: {
        cwd: '/repo',
        approvalPolicy: 'on-request',
        // The user answers what is asked, whatever the account's `approvals_reviewer` says.
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        developerInstructions: 'You are @Alice',
        model: 'gpt-5.5',
        config: {
          sandbox_workspace_write: { network_access: false },
          ...CODEX_FIXED_CONFIG,
          'features.apps': false,
          mcp_servers: { headroom: { enabled: false } },
        },
      },
    });
    // With paths to protect, a permission profile instead of the legacy sandbox: the permission's
    // sandbox and a deny entry for each; the profile keeps the network off by itself.
    const guarded = codexThreadRequest(
      { ...run, protectedPaths: ['/home/me/.mozilla', '/srv/relay/data/relay.db'] },
      user,
      'linux',
      'harness-relay-1a2b',
    );
    expect(guarded.params).toMatchObject({ permissions: 'harness-relay-1a2b' });
    expect(guarded.params).not.toHaveProperty('sandbox');
    expect(guarded.params.config).toEqual({
      ...CODEX_FIXED_CONFIG,
      'features.apps': false,
      mcp_servers: { headroom: { enabled: false } },
      permissions: {
        'harness-relay-1a2b': { extends: ':workspace', filesystem: { '/home/me/.mozilla': 'deny', '/srv/relay/data/relay.db': 'deny' } },
      },
    });
    // A new name for each run: a profile of the same name in Codex's other config layers (a trusted
    // project's .codex/config.toml) would be merged into it, and could open a denied path again.
    expect(codexProfileId()).toMatch(/^harness-relay-[0-9a-f]{16}$/);
    expect(codexProfileId()).not.toBe(codexProfileId());
    // Codex must say it applied that profile: one that ignores the field would run in the user's sandbox_mode.
    expect(() =>
      codexCheckProfile(guarded.params, { activePermissionProfile: { id: 'harness-relay-1a2b', extends: ':workspace' } }),
    ).not.toThrow();
    expect(() => withLang('en', () => codexCheckProfile(guarded.params, { thread: { id: 'thr-1' } }))).toThrow(
      /^Codex did not run this thread in the permission profile Harness Relay gave it \(it answered no profile;/,
    );
    expect(() => withLang('en', () => codexCheckProfile(guarded.params, { activePermissionProfile: { id: ':workspace' } }))).toThrow(
      /answered ":workspace"/,
    );
    expect(() => codexCheckProfile(start.params, { thread: { id: 'thr-1' } })).not.toThrow();
    expect(codexProfile('read-only', ['/x'], 'darwin')).toEqual({ extends: ':read-only', filesystem: { '/x': 'deny' } });
    // Full access, Windows (its legacy sandbox cannot deny reads everywhere) and nothing to protect: the legacy sandbox.
    expect(codexProfile('full', ['/x'], 'linux')).toBeUndefined();
    expect(codexProfile('edit', ['/x'], 'win32')).toBeUndefined();
    expect(codexProfile('edit', [], 'linux')).toBeUndefined();
    expect(codexThreadRequest({ ...run, protectedPaths: ['/x'] }, user, 'win32').params).toMatchObject({ sandbox: 'workspace-write' });
    // Resuming gets the same settings, so a switch changed mid-chat reaches the next turn.
    expect(codexThreadRequest({ ...run, sessionId: 'thr-1' }, user)).toEqual({
      method: 'thread/resume',
      params: { threadId: 'thr-1', ...start.params },
    });
    // On the user's own endpoint: its model by its own name, through a provider of its own.
    const lab = {
      id: 'lab/qwen3',
      model: 'qwen3',
      endpoint: { id: 'lab', name: 'Lab', baseUrl: 'http://10.0.0.6:8000/v1', models: ['qwen3'] },
    };
    const onLab = codexThreadRequest({ ...run, model: 'lab/qwen3', sessionId: 'thr-1' }, user, 'linux', 'harness-relay-1a2b', lab);
    expect(onLab.params).toMatchObject({
      threadId: 'thr-1',
      model: 'qwen3',
      modelProvider: 'harness-relay-lab',
      config: {
        model_provider: 'harness-relay-lab',
        model_providers: {
          'harness-relay-lab': { name: 'Harness Relay: Lab', base_url: 'http://10.0.0.6:8000/v1', wire_api: 'responses' },
        },
      },
    });
    expect(onLab.params.config).not.toHaveProperty('model_context_window');
    // Its context window, when Settings knows it: Codex knows none for a model not of its own catalog.
    const limited = { ...lab, endpoint: { ...lab.endpoint, limits: { qwen3: { context: 32768 } } } };
    expect(codexThreadRequest({ ...run, model: 'lab/qwen3' }, user, 'linux', 'harness-relay-1a2b', limited).params.config).toMatchObject({
      model_context_window: 32768,
      model_auto_compact_token_limit: 32768 - 8192,
    });
    const outputSet = { ...lab, endpoint: { ...lab.endpoint, limits: { qwen3: { context: 131072, output: 4096 } } } };
    expect(codexThreadRequest({ ...run, model: 'lab/qwen3' }, user, 'linux', 'harness-relay-1a2b', outputSet).params.config).toMatchObject({
      model_context_window: 131072,
      model_auto_compact_token_limit: 131072 - 4096,
    });
    // Full access, or a conversation that refuses automatically, never asks.
    expect(codexThreadRequest({ ...run, permission: 'full' }).params.approvalPolicy).toBe('never');
    expect(codexThreadRequest({ ...run, requestApproval: undefined }).params.approvalPolicy).toBe('never');
    // Single items go in the thread's config as well.
    expect(codexThreadRequest({ ...run, nativeOff: [], nativeItems: { plugins: ['pdf@openai'] } }).params.config).toEqual({
      sandbox_workspace_write: { network_access: false },
      ...CODEX_FIXED_CONFIG,
      plugins: { 'pdf@openai': { enabled: false } },
    });
    // All its subagents, the built-in ones too: below full access (the orchestrator's `runNativeOff`), or by the account's switch.
    expect(codexThreadRequest({ ...run, nativeOff: ['subagents'] }).params.config).toMatchObject({
      'agents.enabled': false,
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
    });
    expect(codexThreadRequest({ ...run, nativeOff: [] }).params.config).not.toHaveProperty('agents.enabled');
    // Goals off and its question form off in every thread, whatever the account's config says.
    expect(CODEX_FIXED_CONFIG).toEqual({ 'features.goals': false, 'tools.experimental_request_user_input.enabled': false });
  });

  it('checks after the thread starts that Codex took the hooks and plugins switches', async () => {
    const asked: string[] = [];
    const conn = (answers: Record<string, unknown>) => ({
      request: async (method: string) => {
        asked.push(method);
        if (!(method in answers)) throw new RpcError(-32600, `Invalid request: unknown variant \`${method}\``);
        return answers[method];
      },
    });
    const run = { cwd: '/repo', nativeOff: ['hooks' as const, 'plugins' as const] };
    const took = conn({
      'hooks/list': { data: [{ cwd: '/repo', hooks: [] }] },
      'plugin/installed': { marketplaces: [{ name: 'm', plugins: [] }] },
    });
    await expect(codexConfirmLeftOut(took, run, 'thr-1')).resolves.toBeUndefined();
    expect(asked).toEqual(['hooks/list', 'plugin/installed']);

    // Nothing to check when neither is left out.
    asked.length = 0;
    await codexConfirmLeftOut(took, { cwd: '/repo', nativeOff: ['skills'] }, 'thr-1');
    expect(asked).toEqual([]);

    // A Codex that ignored the keys still lists them on: the run must not go on quietly.
    const ignored = conn({
      'hooks/list': {
        data: [
          {
            cwd: '/repo',
            hooks: [
              { key: 'h', eventName: 'stop', enabled: true },
              { key: 'o', eventName: 'stop', enabled: false },
            ],
          },
        ],
      },
      'plugin/installed': { marketplaces: [{ name: 'm', plugins: [{ id: 'deck@m', installed: true, enabled: true }] }] },
    });
    const failure = withLang('en', () => codexConfirmLeftOut(ignored, run, 'thr-1'));
    await expect(failure).rejects.toBeInstanceOf(AgentRunError);
    await expect(failure).rejects.toThrow(/^Codex still loaded hooks and plugins that are left out of this run/);
    // Only off ones, or plugins that are not installed: nothing still on.
    const quiet = conn({
      'hooks/list': { data: [{ hooks: [{ eventName: 'stop', enabled: false }] }] },
      'plugin/installed': { marketplaces: [{ plugins: [{ id: 'x@m', installed: false, enabled: true }] }] },
    });
    await expect(codexConfirmLeftOut(quiet, run, 'thr-1')).resolves.toBeUndefined();
    // A Codex older than these lists goes on: it answers an unknown method as 0.167 does.
    await expect(codexConfirmLeftOut(conn({}), run, 'thr-1')).resolves.toBeUndefined();
    expect(isUnknownMethod(new RpcError(-32600, 'Invalid request: unknown variant `hooks/list`'))).toBe(true);
    expect(isUnknownMethod(new RpcError(-32601, 'method not found'))).toBe(true);
    expect(isUnknownMethod(new RpcError(-32600, 'Invalid request: missing field `threadId`'))).toBe(false);
    // Any other failure could not be checked, and the run does not go on.
    const broken = { request: async () => Promise.reject(new RpcError(-32603, 'thread not loaded')) };
    await expect(withLang('en', () => codexConfirmLeftOut(broken, run, 'thr-1'))).rejects.toThrow(
      /^Could not check that Codex left out the skills, hooks or plugins this run leaves out \(thread not loaded\)/,
    );
  });

  it('checks the single skills, hooks and plugins left out, and only those', async () => {
    const asked: string[] = [];
    const answers: Record<string, unknown> = {
      'skills/list': {
        data: [
          {
            skills: [
              { name: 'a', path: '/s/a/SKILL.md', enabled: false },
              { name: 'b', path: '/s/b/SKILL.md', enabled: true },
            ],
          },
        ],
      },
      'hooks/list': {
        data: [
          {
            hooks: [
              { key: 'h1', eventName: 'stop', enabled: false },
              { key: 'h2', eventName: 'stop', enabled: true },
            ],
          },
        ],
      },
      'plugin/installed': {
        marketplaces: [
          {
            plugins: [
              { id: 'pdf@o', installed: true, enabled: false },
              { id: 'docs@o', installed: true, enabled: true },
            ],
          },
        ],
      },
    };
    const conn = { request: async (method: string) => (asked.push(method), answers[method]) };
    const took = { cwd: '/repo', nativeItems: { skills: ['/s/a/SKILL.md'], hooks: ['h1'], plugins: ['pdf@o'] } };
    await expect(codexConfirmLeftOut(conn, took, 'thr-1')).resolves.toBeUndefined();
    expect(asked).toEqual(['skills/list', 'hooks/list', 'plugin/installed']);
    // One it still loads fails the run, named by its kind.
    const still = { cwd: '/repo', nativeItems: { skills: ['/s/b/SKILL.md'], hooks: ['h2'], plugins: ['docs@o'] } };
    await expect(withLang('en', () => codexConfirmLeftOut(conn, still, 'thr-1'))).rejects.toThrow(
      /^Codex still loaded skills and hooks and plugins that are left out of this run/,
    );
    await expect(
      withLang('zh-TW', () => codexConfirmLeftOut(conn, { cwd: '/repo', nativeItems: { hooks: ['h2'] } }, 'thr-1')),
    ).rejects.toThrow(/^Codex 仍載入了設為不載入的 hook/);
  });
});

describe('Codex team hook payloads', () => {
  it('preserves a shell command and the result Codex gives the hook', () => {
    expect(codexHookCall({ tool_name: 'Bash', tool_input: { command: 'echo hello; exit 2' }, tool_response: 'hello' }, '/repo')).toEqual({
      kind: 'command',
      tool: 'Bash',
      command: 'echo hello; exit 2',
      input: { command: 'echo hello; exit 2' },
      output: 'hello',
    });
  });

  it('resolves the old and new patch paths against the tool working directory', () => {
    const command = '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch';
    const cwd = resolve('repo', 'other');
    expect(codexHookCall({ tool_name: 'apply_patch', cwd, tool_input: { command } }, resolve('repo'))).toEqual({
      kind: 'edit',
      tool: 'apply_patch',
      files: [join(cwd, 'old.txt'), join(cwd, 'new.txt')],
      input: { command },
    });
  });

  it('follows Codex patch header indentation and preserves spaces that are part of the filename', () => {
    const command = [
      '*** Begin Patch',
      '  *** Add File:  new file.txt',
      '+contents',
      '  *** Update File: old name.txt',
      '*** End of File',
      '*** Move to:  moved file.txt',
      '@@',
      ' *** Add File: this is context.txt',
      '-old line',
      '+new line',
      '*** Delete File: delete.txt',
      '*** End Patch',
    ].join('\n');
    const cwd = resolve('repo');
    const call = codexHookCall({ tool_name: 'apply_patch', cwd, tool_input: { command } }, cwd);
    expect(call.files).toEqual([' new file.txt', 'old name.txt', ' moved file.txt', 'delete.txt'].map((name) => join(cwd, name)));
  });

  it('preserves an MCP error for an after hook', () => {
    expect(codexHookCall({ tool_name: 'mcp__a__b', tool_input: { query: 'a' }, tool_response: { isError: true } }, '/repo')).toEqual({
      kind: 'other',
      tool: 'mcp__a__b',
      input: { query: 'a' },
      output: '{"isError":true}',
      failed: true,
    });
  });
});

// The stand-ins are scripts run by their `#!` line, which Windows cannot start.
describe.skipIf(process.platform === 'win32')('a Codex run that leaves out hooks and plugins (stand-in codex app-server)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-codex-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Answers like codex-cli 0.167.0's app-server (config/read: the effort FAKE_CODEX_EFFORT sets, as
  // the user's config would). FAKE_CODEX_IGNORE plays a Codex that ignores the
  // two keys; FAKE_CODEX_SLOW answers hooks/list after two seconds; FAKE_CODEX_NO_PROFILE a Codex
  // that ignores the thread's permission profile; FAKE_CODEX_PROFILE_FAILS one that cannot load it
  // (a turn in it fails, as Codex 0.167 on Linux does). FAKE_CODEX_SAYS (JSON) are its turn's agent
  // messages. FAKE_CODEX_NETWORK_ASK asks a network approval for a running command (id `net-1`) and,
  // 100 ms later, resolves it itself (`serverRequest/resolved`), as Codex 0.167 does when the connection
  // that asked ends; the turn ends 200 ms after that. Each request goes to the log, and each turn's
  // outputSchema; the client's answers too.
  const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const log = (o) => fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(o) + '\\n');
const args = process.argv.slice(2);
log({ args });
const set = []; for (let i = 0; i < args.length; i++) if (args[i] === '-c') set.push(args[++i]);
const off = (key) => !process.env.FAKE_CODEX_IGNORE && set.includes(key + '=false');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let init = {};
let profiled = false;
let hookState = {};
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (!m.method) return log({ answer: m }); // the client's answer to a request of ours
  log({ method: m.method });
  const reply = (result) => out({ id: m.id, result });
  switch (m.method) {
    case 'initialize': init = m.params; return reply({});
    case 'thread/resume':
    case 'thread/start': {
      hookState = m.params.config?.['hooks.state'] || {};
      if (process.env.FAKE_CODEX_TEAM_HOOKS) log({ hookState });
      const profile = m.params.permissions && !process.env.FAKE_CODEX_NO_PROFILE ? { activePermissionProfile: { id: m.params.permissions } } : {};
      profiled = Boolean(m.params.permissions);
      log({ capabilities: init.capabilities ?? null, permissions: m.params.permissions ?? null, sandbox: m.params.sandbox ?? null });
      log({
        model: m.params.model ?? null,
        modelProvider: m.params.modelProvider ?? null,
        configProvider: (m.params.config || {}).model_provider ?? null,
        providers: (m.params.config || {}).model_providers ?? null,
        effort: (m.params.config || {}).model_reasoning_effort ?? null,
        key: process.env.HARNESS_RELAY_ENDPOINT_API_KEY ?? null,
      });
      return reply({ thread: { id: 'thr-1' }, ...profile });
    }
    case 'hooks/list': {
      if (process.env.FAKE_CODEX_TEAM_HOOKS) {
        const cfg = set.find((arg) => arg.startsWith('hooks.PreToolUse='));
        const command = cfg?.match(/"command" = ("(?:[^"\\\\]|\\\\.)*")/)?.[1];
        const hook = { key: 'relay-hook', eventName: 'preToolUse', enabled: true, source: 'sessionFlags',
          handlerType: 'command', async: false, matcher: '^(?:Bash)$', timeoutSec: 150,
          command: command && JSON.parse(command), currentHash: 'relay-hash',
          trustStatus: hookState['relay-hook']?.trusted_hash === 'relay-hash' && !process.env.FAKE_CODEX_IGNORE ? 'trusted' : 'untrusted' };
        // Identical command from an unrelated source must never be trusted by Relay.
        const native = { ...hook, key: 'own-hook', source: 'user', currentHash: 'own-hash',
          trustStatus: 'untrusted', enabled: hookState['own-hook']?.enabled !== false };
        const hooks = command ? [hook, native] : [native];
        return reply({ data: [{ hooks }] });
      }
      const r = { data: [{ hooks: off('features.hooks') ? [] : [{ key: 'h', eventName: 'stop', enabled: true }] }] };
      return process.env.FAKE_CODEX_SLOW ? setTimeout(() => reply(r), 2000) : reply(r);
    }
    case 'config/read':
      return reply({ config: { model_reasoning_effort: process.env.FAKE_CODEX_EFFORT ?? null }, origins: {} });
    case 'plugin/installed':
      return reply({ marketplaces: [{ name: 'm', plugins: off('features.plugins') ? [] : [{ id: 'deck@m', installed: true, enabled: true }] }] });
    case 'turn/start':
      log({ outputSchema: m.params.outputSchema ?? null });
      reply({ turn: { id: 'turn-1' } });
      // Its agent messages, the last one the answer (in the shape outputSchema asks for, when it does).
      for (const [i, text] of JSON.parse(process.env.FAKE_CODEX_SAYS || '[]').entries())
        out({ method: 'item/completed', params: { threadId: 'thr-1', item: { type: 'agentMessage', id: 'msg-' + i, text } } });
      if (process.env.FAKE_CODEX_PROFILE_FAILS && profiled) {
        const error = { message: 'failed to load workspace requirements: invalid input parameter' };
        return setTimeout(() => out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'failed', error } } }), 50);
      }
      // Asked of clients that take the experimental API.
      if (init.capabilities?.experimentalApi) out({ id: 'time-1', method: 'currentTime/read', params: { threadId: 'thr-1' } });
      if (process.env.FAKE_CODEX_NETWORK_ASK) {
        out({ id: 'net-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thr-1', turnId: 'turn-1', itemId: 'exec-1',
          command: 'curl https://example.com', networkApprovalContext: { host: 'example.com', protocol: 'https' } } });
        setTimeout(() => out({ method: 'serverRequest/resolved', params: { threadId: 'thr-1', requestId: 'net-1' } }), 100);
        return setTimeout(() => out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed' } } }), 300);
      }
      if (process.env.FAKE_CODEX_SUBAGENT) {
        // A subagent, as Codex 0.167.0's schema has it: its spawn call, its thread, a command in it, its tokens.
        const spawn = (status, receiverThreadIds) => ({ type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status,
          senderThreadId: 'thr-1', receiverThreadIds, prompt: 'Look for the parser', model: 'gpt-5.5-mini', agentsStates: {} });
        const child = (method, params) => out({ method, params: { threadId: 'thr-sub', turnId: 'turn-sub', ...params } });
        out({ method: 'item/started', params: { threadId: 'thr-1', item: spawn('inProgress', []) } });
        out({ method: 'thread/started', params: { thread: { id: 'thr-sub', parentThreadId: 'thr-1',
          source: { subAgent: { thread_spawn: { parent_thread_id: 'thr-1', depth: 1, agent_nickname: 'Noether', agent_role: 'explorer' } } } } } });
        out({ method: 'item/completed', params: { threadId: 'thr-1', item: spawn('completed', ['thr-sub']) } });
        child('item/started', { item: { type: 'commandExecution', id: 'exec-sub', command: 'rg parse', status: 'inProgress' } });
        child('item/completed', { item: { type: 'commandExecution', id: 'exec-sub', command: 'rg parse', status: 'completed', exitCode: 0, aggregatedOutput: 'src/parse.ts' } });
        child('item/completed', { item: { type: 'agentMessage', id: 'msg-sub', text: 'It is in src/parse.ts.' } });
        child('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 30, outputTokens: 3 }, total: { totalTokens: 33 } } });
        child('turn/completed', { turn: { id: 'turn-sub', status: 'completed', items: [] } });
        out({ method: 'thread/tokenUsage/updated', params: { threadId: 'thr-1', turnId: 'turn-1',
          tokenUsage: { last: { inputTokens: 100, outputTokens: 10 }, total: { totalTokens: 110 } } } });
      }
      return setTimeout(() => out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed' } } }), 100);
    default:
      return out({ id: m.id, error: { code: -32600, message: 'Invalid request: unknown variant ' + m.method } });
  }
});
`;
  const bin = join(dir, 'codex');
  writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
  let n = 0;
  function run(
    extra: Record<string, string> = {},
    signal = new AbortController().signal,
    protectedPaths: string[] = [],
    more: Partial<Parameters<typeof codexRunner.run>[0]> = {},
  ) {
    const log = join(dir, `log-${++n}.jsonl`);
    appendFileSync(log, '');
    const result = withLang('en', () =>
      codexRunner.run({
        bin,
        env: { ...process.env, FAKE_CODEX_LOG: log, ...extra },
        prompt: 'hello',
        systemPrompt: 'briefing',
        cwd: dir,
        permission: 'read-only',
        signal,
        onEvent: () => undefined,
        nativeOff: ['hooks', 'plugins'],
        protectedPaths,
        ...more,
      }),
    );
    const lines = () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as {
              args?: string[];
              method?: string;
              capabilities?: unknown;
              permissions?: string | null;
              sandbox?: string | null;
              hookState?: Record<string, unknown>;
            },
        );
    return { result, lines, methods: () => lines().flatMap((l) => (l.method ? [l.method] : [])) };
  }

  const teamHooks = (program = true) =>
    turnHooks([{ id: 'before', when: 'before', tools: 'command', run: 'exit 1' }], {
      agent: 'Codex',
      provider: 'codex',
      notice: () => undefined,
      place: { cwds: [dir], unsandboxed: true, protectedPaths: [], privateRoots: [] },
      ...(program
        ? {
            program: () => ({
              program: { bin: '/node', args: [join(dir, 'team-hook.mjs'), join(dir, 'socket'), join(dir, 'team-hook.token')] },
              revoke: () => undefined,
            }),
          }
        : {}),
    });

  it('tells the card when Codex resolves an approval itself, and sends no answer to it', async () => {
    let signal: AbortSignal | undefined;
    const r = run({ FAKE_CODEX_NETWORK_ASK: '1' }, undefined, [], {
      requestApproval: (req, withdrawn) => {
        signal = withdrawn;
        expect(req).toMatchObject({ kind: 'command', detail: 'curl https://example.com' });
        // The orchestrator answers once the card is withdrawn, as it closes it.
        return new Promise((resolve) => withdrawn!.addEventListener('abort', () => resolve({ allow: true })));
      },
    });
    await r.result;
    expect(signal!.aborted).toBe(true);
    // Nothing went back for it.
    const answers = r
      .lines()
      .flatMap((l) => ((l as { answer?: { id: string } }).answer ? [(l as { answer: { id: string } }).answer.id] : []));
    expect(answers).not.toContain('net-1');
  });

  it("asks its maker's model for the answer's shape on this turn only, and gives back its last message as it", async () => {
    const schema = { type: 'object', properties: { group: { type: 'integer' } }, required: ['group'], additionalProperties: false };
    const shaped = run({ FAKE_CODEX_SAYS: JSON.stringify(['Looking at the groups…', '{"group":3}']) }, undefined, [], {
      outputSchema: schema,
    });
    await expect(shaped.result).resolves.toMatchObject({ sessionId: 'thr-1', structured: { group: 3 } });
    expect(shaped.lines().find((l) => 'outputSchema' in l)).toEqual({ outputSchema: schema });
    // A last message that is not JSON: no structured answer (the caller reads the text).
    const prose = run({ FAKE_CODEX_SAYS: JSON.stringify(['group three']) }, undefined, [], { outputSchema: schema });
    expect((await prose.result).structured).toBeUndefined();
    // Not asked for: neither sent nor read.
    const plain = run({ FAKE_CODEX_SAYS: JSON.stringify(['{"group":3}']) });
    expect((await plain.result).structured).toBeUndefined();
    expect(plain.lines().find((l) => 'outputSchema' in l)).toEqual({ outputSchema: null });
    // The user's own endpoint may not take it: not sent.
    const backends = { apis: {}, endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:11434/v1', models: ['gemma'] }] };
    const own = run({ FAKE_CODEX_SAYS: JSON.stringify(['{"group":3}']) }, undefined, [], {
      outputSchema: schema,
      backends,
      model: 'homelab/gemma',
    });
    expect((await own.result).structured).toBeUndefined();
    expect(own.lines().find((l) => 'outputSchema' in l)).toEqual({ outputSchema: null });
  });

  it('trusts only the Relay hook on a resumed thread and keeps native hooks left out', async () => {
    const r = run({ FAKE_CODEX_TEAM_HOOKS: '1' }, undefined, [], { permission: 'full', sessionId: 'thr-1', hooks: teamHooks() });
    await expect(r.result).resolves.toMatchObject({ sessionId: 'thr-1' });
    expect(r.lines().find((l) => l.hookState)?.hookState).toEqual({
      'relay-hook': { enabled: true, trusted_hash: 'relay-hash' },
      'own-hook': { enabled: false },
    });
    expect(r.lines()[0]?.args).not.toContain('features.hooks=false');
    expect(r.methods()).toEqual(['initialize', 'hooks/list', 'thread/resume', 'hooks/list', 'plugin/installed', 'turn/start']);
  });

  it('does not start when Codex did not apply trust to a team hook', async () => {
    const r = run({ FAKE_CODEX_TEAM_HOOKS: '1', FAKE_CODEX_IGNORE: '1' }, undefined, [], {
      permission: 'full',
      nativeOff: [],
      hooks: teamHooks(),
    });
    await expect(r.result).rejects.toThrow(/team's hooks/i);
    expect(r.methods()).toEqual(['initialize', 'hooks/list', 'thread/start', 'hooks/list']);
  });

  it('does not launch Codex when the hook program is unavailable', async () => {
    const r = run({}, undefined, [], { permission: 'full', hooks: teamHooks(false) });
    await expect(r.result).rejects.toThrow(/team's hooks/i);
    expect(r.lines()).toEqual([]);
  });

  it('refuses hooked edits unless the permission profile protects the program and token', async () => {
    const r = run({ FAKE_CODEX_TEAM_HOOKS: '1' }, undefined, ['/unrelated'], { permission: 'edit', hooks: teamHooks() });
    await expect(r.result).rejects.toThrow(/cannot protect the team's hook program/i);
    expect(r.lines()).toEqual([]);
  });

  it('never retries a hooked edit in the legacy sandbox when the permission profile fails', async () => {
    try {
      const opts = { permission: 'edit', hooks: teamHooks() } as const;
      const r = run({ FAKE_CODEX_TEAM_HOOKS: '1', FAKE_CODEX_PROFILE_FAILS: '1' }, undefined, [dir], opts);
      await expect(r.result).rejects.toThrow(/cannot protect the team's hook program/i);
      expect(r.methods().filter((method) => method === 'turn/start')).toHaveLength(1);
      expect(r.lines().filter((line) => line.args)).toHaveLength(1);
      const next = run({ FAKE_CODEX_TEAM_HOOKS: '1' }, undefined, [dir], opts);
      await expect(next.result).rejects.toThrow(/cannot protect the team's hook program/i);
      expect(next.lines()).toEqual([]);
    } finally {
      resetCodexProfiles();
    }
  });

  it("shows a subagent's commands under the call that started it, and adds its tokens to the turn's", async () => {
    const events: AgentEvent[] = [];
    const r = run({ FAKE_CODEX_SUBAGENT: '1' }, undefined, [], { onEvent: (e) => events.push(e) });
    await expect(r.result).resolves.toMatchObject({ sessionId: 'thr-1', inputTokens: 130, outputTokens: 13 });
    expect(events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end')).toEqual([
      { type: 'tool_start', id: 'spawn-1', name: 'spawn_agent', detail: 'Look for the parser', model: 'gpt-5.5-mini' },
      { type: 'tool_start', id: 'spawn-1', name: 'spawn_agent', agent: 'explorer' },
      { type: 'tool_start', id: 'exec-sub', name: 'Shell', detail: 'rg parse', parentId: 'spawn-1' },
      { type: 'tool_end', id: 'exec-sub', ok: true, output: 'src/parse.ts' },
      { type: 'tool_end', id: 'spawn-1', ok: true, output: 'It is in src/parse.ts.' },
    ]);
    // The subagent's own words are not the agent's.
    expect(events.some((e) => e.type === 'text' && e.text.includes('src/parse.ts'))).toBe(false);
  });

  it('gives its app-server the switches too, and checks them before the turn starts', async () => {
    const r = run();
    await expect(r.result).resolves.toMatchObject({ sessionId: 'thr-1' });
    const args = r.lines()[0]!.args!;
    expect(args.slice(0, 1)).toEqual(['app-server']);
    expect(args).toEqual(expect.arrayContaining(['-c', 'features.hooks=false', 'features.plugins=false']));
    expect(r.methods()).toEqual(['initialize', 'thread/start', 'hooks/list', 'plugin/installed', 'turn/start']);
  });

  it('fails before the turn when Codex ignored them', async () => {
    const r = run({ FAKE_CODEX_IGNORE: '1' });
    await expect(r.result).rejects.toThrow(/^Codex still loaded hooks and plugins that are left out of this run/);
    expect(r.methods()).not.toContain('turn/start');
  });

  it('runs the thread in its own permission profile when there are paths to protect, and checks Codex took it', async () => {
    const r = run({}, undefined, ['/home/me/.mozilla']);
    await expect(r.result).resolves.toMatchObject({ sessionId: 'thr-1' });
    const started = r.lines().find((l) => 'permissions' in l)!;
    expect(started.capabilities).toEqual({ experimentalApi: true });
    expect(started.permissions).toMatch(/^harness-relay-[0-9a-f]{16}$/);
    expect(started.sandbox).toBeNull();
    // And it answers the experimental API's requests, such as the time.
    const answer = r.lines().find((l) => 'answer' in l) as { answer?: { id: string; result?: { currentTimeAt: number } } } | undefined;
    expect(answer?.answer).toMatchObject({ id: 'time-1', result: { currentTimeAt: expect.any(Number) } });
    expect(Math.abs(answer!.answer!.result!.currentTimeAt - Date.now() / 1000)).toBeLessThan(60);
    // Nothing to protect: the legacy sandbox, without the experimental API.
    const legacy = run();
    await legacy.result;
    expect(legacy.lines().find((l) => 'permissions' in l)).toMatchObject({ capabilities: null, permissions: null, sandbox: 'read-only' });
  });

  it('falls back to its legacy sandbox, for the rest of the run, when Codex cannot load the profile', async () => {
    try {
      const r = run({ FAKE_CODEX_PROFILE_FAILS: '1' }, undefined, ['/home/me/.mozilla']);
      await expect(r.result).resolves.toMatchObject({ sessionId: 'thr-1' });
      const starts = r.lines().filter((l) => 'permissions' in l);
      expect(starts[0]).toMatchObject({ permissions: expect.stringMatching(/^harness-relay-/), sandbox: null });
      expect(starts[1]).toMatchObject({ permissions: null, sandbox: 'read-only' });
      // The next run goes to the legacy sandbox at once.
      const next = run({ FAKE_CODEX_PROFILE_FAILS: '1' }, undefined, ['/home/me/.mozilla']);
      await next.result;
      expect(next.lines().filter((l) => 'permissions' in l)).toEqual([
        expect.objectContaining({ permissions: null, sandbox: 'read-only' }),
      ]);
    } finally {
      resetCodexProfiles();
    }
  });

  it("falls back to the legacy sandbox without the team's protected paths too, when Codex cannot load a profile", async () => {
    // There, so that Linux too names it (only a path that is there).
    writeFileSync(join(dir, '.env'), 'x');
    try {
      const guard = { dirs: [dir], patterns: ['.env'] };
      const r = run({ FAKE_CODEX_PROFILE_FAILS: '1' }, undefined, [], { permission: 'edit', guard });
      await expect(r.result).resolves.toMatchObject({ sessionId: 'thr-1' });
      const starts = r.lines().filter((l) => 'permissions' in l);
      expect(starts[0]).toMatchObject({ permissions: expect.stringMatching(/^harness-relay-/), sandbox: null });
      expect(starts[1]).toMatchObject({ permissions: null, sandbox: 'workspace-write' });
    } finally {
      rmSync(join(dir, '.env'), { force: true });
      resetCodexProfiles();
    }
  });

  it('fails before the turn when Codex did not apply the permission profile', async () => {
    const r = run({ FAKE_CODEX_NO_PROFILE: '1' }, undefined, ['/home/me/.mozilla']);
    await expect(r.result).rejects.toThrow(/^Codex did not run this thread in the permission profile Harness Relay gave it/);
    expect(r.methods()).not.toContain('turn/start');
  });

  it("runs the model of the user's own endpoint there, with its key in a variable and an effort it takes", async () => {
    const endpoint = (apiKey?: string) => ({
      id: 'homelab',
      name: 'Homelab',
      baseUrl: 'http://10.0.0.5:11434/v1',
      models: ['gemma4:e4b'],
      ...(apiKey ? { apiKey } : {}),
    });
    const go = async (o: { effort?: string; configEffort?: string; apiKey?: string; model?: string }) => {
      const log = join(dir, `log-${++n}.jsonl`);
      appendFileSync(log, '');
      await codexRunner.run({
        bin,
        env: {
          ...process.env,
          FAKE_CODEX_LOG: log,
          HARNESS_RELAY_ENDPOINT_API_KEY: 'from-the-shell',
          ...(o.configEffort ? { FAKE_CODEX_EFFORT: o.configEffort } : {}),
        },
        prompt: 'hello',
        systemPrompt: 'briefing',
        cwd: dir,
        permission: 'read-only',
        model: o.model ?? 'homelab/gemma4:e4b',
        ...(o.effort ? { effort: o.effort } : {}),
        backends: { apis: {}, endpoints: [endpoint(o.apiKey)] },
        signal: new AbortController().signal,
        onEvent: () => undefined,
      });
      const lines = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      return {
        started: lines.find((l) => 'modelProvider' in l)!,
        args: lines[0]!.args as string[],
        methods: lines.flatMap((l) => (l.method ? [l.method] : [])),
      };
    };
    const keyed = await go({ apiKey: 'lab-key', effort: 'high' });
    expect(keyed.started).toEqual({
      model: 'gemma4:e4b',
      modelProvider: 'harness-relay-homelab',
      configProvider: 'harness-relay-homelab',
      providers: {
        'harness-relay-homelab': {
          name: 'Harness Relay: Homelab',
          base_url: 'http://10.0.0.5:11434/v1',
          wire_api: 'responses',
          env_key: 'HARNESS_RELAY_ENDPOINT_API_KEY',
        },
      },
      effort: 'high',
      key: 'lab-key',
    });
    // The app-server is started with that provider too: Codex takes a thread's provider only when it is its own.
    expect(keyed.args).toEqual(
      expect.arrayContaining([
        '-c',
        'model_provider="harness-relay-homelab"',
        '-c',
        'model_providers={ "harness-relay-homelab" = { "name" = "Harness Relay: Homelab", "base_url" = "http://10.0.0.5:11434/v1", "wire_api" = "responses", "env_key" = "HARNESS_RELAY_ENDPOINT_API_KEY" } }',
      ]),
    );
    expect(keyed.args.join(' ')).not.toContain('lab-key');
    // An effort the member gave was enough: Codex's config is not asked.
    expect(keyed.methods).not.toContain('config/read');
    // No key: none named, and none inherited from the shell.
    const keyless = await go({ configEffort: 'xhigh' });
    expect(keyless.started).toMatchObject({ providers: { 'harness-relay-homelab': { wire_api: 'responses' } }, key: null });
    expect((keyless.started.providers as Record<string, object>)['harness-relay-homelab']).not.toHaveProperty('env_key');
    // The user's config sets an effort meant for OpenAI's models: one the endpoint takes instead.
    expect(keyless.started.effort).toBe('medium');
    expect(keyless.methods).toContain('config/read');
    // It sets none: none is sent.
    expect((await go({})).started.effort).toBeNull();
    // Codex's own models stay as they are.
    const own = await go({ model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(own.started).toEqual({
      model: 'gpt-6.1-sol',
      modelProvider: null,
      configProvider: null,
      providers: null,
      effort: 'xhigh',
      key: 'from-the-shell',
    });
    expect(own.args.join(' ')).not.toContain('model_provider');
    // A model of an endpoint deleted in Settings fails before Codex starts: its id would go to OpenAI.
    // An id of the user's Codex config with a slash still runs as Codex has it.
    const gone = join(dir, `log-${++n}.jsonl`);
    appendFileSync(gone, '');
    await expect(
      withLang('en', () =>
        codexRunner.run({
          bin,
          env: { ...process.env, FAKE_CODEX_LOG: gone },
          prompt: 'hello',
          systemPrompt: 'briefing',
          cwd: dir,
          permission: 'read-only',
          model: 'oldlab/gemma4:e4b',
          backends: { apis: {}, endpoints: [endpoint()], deletedEndpoints: ['oldlab'] },
          signal: new AbortController().signal,
          onEvent: () => undefined,
        }),
      ),
    ).rejects.toThrow('Codex is to use the model "oldlab/gemma4:e4b", but its custom endpoint "oldlab" was deleted');
    expect(readFileSync(gone, 'utf8')).toBe('');
  });

  it('does not start the turn when stopped during the check', async () => {
    const stop = new AbortController();
    const r = run({ FAKE_CODEX_SLOW: '1' }, stop.signal);
    await vi.waitFor(() => expect(r.methods()).toContain('hooks/list'));
    stop.abort();
    await expect(r.result).rejects.toMatchObject({ message: 'Stopped' });
    expect(r.methods()).not.toContain('turn/start');
  });
});

describe.skipIf(process.platform === 'win32')("Codex and the team checks' protected paths", () => {
  // The team checks' protected paths (a guard's folders are real paths; these are not on disk, and on Windows a path is another shape).
  const guard = { dirs: ['/w/app'], patterns: ['.env', 'config/prod.yml', '*.pem'] };
  it('makes them read-only in its profile in edit mode: each plain pattern where it is anchored, and what matches now', () => {
    expect(codexGuardReads(guard, ['/w/app/sub/k.pem'], 'darwin')).toEqual(['/w/app/.env', '/w/app/config/prod.yml', '/w/app/sub/k.pem']);
    expect(codexGuardReads(guard, ['/w/app/k[1].pem'], 'darwin')).not.toContain('/w/app/k[1].pem');
    expect(codexProfile('edit', ['/x'], 'darwin', [], guard, [])).toEqual({
      extends: ':workspace',
      filesystem: { '/w/app/.env': 'read', '/w/app/config/prod.yml': 'read', '/x': 'deny' },
    });
    // Read-only writes nothing anyway, and full access has no profile.
    expect(codexProfile('read-only', ['/x'], 'darwin', [], guard, [])).toEqual({ extends: ':read-only', filesystem: { '/x': 'deny' } });
    expect(codexProfile('full', ['/x'], 'darwin', [], guard, [])).toBeUndefined();
    expect(codexProfile('edit', [], 'darwin', [], guard, [])).toMatchObject({ filesystem: { '/w/app/.env': 'read' } });
  });
});

describe.skipIf(process.platform === 'win32')("Codex's refusals and Linux entries for the team checks' protected paths", () => {
  const guard = { dirs: ['/w/app'], patterns: ['.env'] };
  it('refuses a file change or a patch that writes, moves to or moves away one of them, and nothing else', () => {
    const fc = 'item/fileChange/requestApproval';
    expect(codexGuardRefuses(fc, {}, [{ path: '/w/app/.env' }], guard, '/w/app')).toBe(true);
    expect(codexGuardRefuses(fc, {}, [{ path: '/w/app/a.ts', kind: { type: 'update', move_path: '/w/app/.env' } }], guard, '/w/app')).toBe(
      true,
    );
    expect(codexGuardRefuses(fc, {}, [{ path: 'sub/.env' }], guard, '/w/app')).toBe(true);
    expect(codexGuardRefuses(fc, {}, [{ path: '/w/app/a.ts' }], guard, '/w/app')).toBe(false);
    expect(codexGuardRefuses('applyPatchApproval', { fileChanges: { '/w/app/.env': {} } }, [], guard, '/w/app')).toBe(true);
    expect(codexGuardRefuses('item/commandExecution/requestApproval', {}, [{ path: '/w/app/.env' }], guard, '/w/app')).toBe(false);
    expect(codexGuardRefuses(fc, {}, [{ path: '/w/app/.env' }], undefined, '/w/app')).toBe(false);
  });

  it('gives Linux only the paths that are there (its sandbox would put a stand-in on one that is not)', () => {
    expect(codexGuardReads(guard, ['/w/app/sub/.env'], 'linux', (p) => p === '/w/app/sub/.env')).toEqual(['/w/app/sub/.env']);
    expect(codexGuardReads(guard, [], 'darwin', () => false)).toEqual(['/w/app/.env']);
  });
});
