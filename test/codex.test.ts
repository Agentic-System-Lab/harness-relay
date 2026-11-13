import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { isPathDetail } from '../src/web/chat';
import {
  codexApprovalRequest,
  codexApprovalResponse,
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
} from '../src/server/agents/codex';
import { RpcError } from '../src/server/agents/acp';
import { AgentRunError, type AgentEvent } from '../src/server/agents/types';
import { withLang } from '../src/server/i18n';

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
    h.handle('turn/plan/updated', { plan: [{ step: 'Run tests', status: 'inProgress' }, { step: 'Report', status: 'pending' }] });
    h.handle('item/started', { item: command({}) });
    h.handle('item/completed', { item: command({ status: 'completed', exitCode: 0, aggregatedOutput: '> test\nALL-TESTS-PASSED\n' }) });
    h.handle('item/agentMessage/delta', { itemId: 'm1', delta: 'Tests pass.' });
    h.handle('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Tests pass.' } });
    h.handle('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['Checking the tests.'], content: [] } });
    // As codex sends them: the output already counts the reasoning (total = input + output).
    h.handle('thread/tokenUsage/updated', {
      tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, reasoningOutputTokens: 5, totalTokens: 110 }, total: { totalTokens: 110 } },
    });
    h.handle('thread/tokenUsage/updated', {
      tokenUsage: { last: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 52 }, total: { totalTokens: 162 } },
    });
    // The same count again (as Codex sends it with its rate limits): no new call.
    h.handle('thread/tokenUsage/updated', {
      tokenUsage: { last: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 52 }, total: { totalTokens: 162 } },
    });

    expect(events).toEqual([
      { type: 'thinking', text: 'Checking the tests.' },
      { type: 'plan', entries: [{ text: 'Run tests', status: 'in_progress' }, { text: 'Report', status: 'pending' }] },
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
    h.handle('item/completed', { item: command({ id: 'a', status: 'failed', exitCode: 128, aggregatedOutput: 'fatal: not a git repository' }) });
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
    expect(describeCodexItem({ type: 'webSearch', query: '', action: { type: 'other' } })).toEqual({ name: 'WebSearch', detail: undefined });
    expect(describeCodexItem({ type: 'agentMessage' })).toBeNull();
  });

  it('shows a new file by its path from the start, and keeps it when the item completes', () => {
    const events: AgentEvent[] = [];
    const h = createCodexUpdateHandler((e) => events.push(e));
    const item = (status: string) => ({ type: 'fileChange', id: 'p1', status, changes: [{ path: '/repo/src/new.ts', kind: { type: 'add' }, diff: '+x' }] });
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
    h.handle('item/completed', { item: { type: 'webSearch', id: 'ws-1', query: 'vitest mock timers', action: { type: 'search', query: 'vitest mock timers' } } });
    h.handle('item/started', { item: { type: 'webSearch', id: 'ws-2', query: '', action: null } });
    h.handle('item/completed', {
      item: { type: 'webSearch', id: 'ws-2', query: '', action: { type: 'findInPage', url: 'https://vitest.dev/api', pattern: 'useFakeTimers' } },
    });
    expect(events).toEqual([
      { type: 'tool_start', id: 'ws-1', name: 'WebSearch' },
      { type: 'tool_end', id: 'ws-1', ok: true, detail: 'vitest mock timers' },
      { type: 'tool_start', id: 'ws-2', name: 'WebSearch' },
      { type: 'tool_end', id: 'ws-2', ok: true, detail: '"useFakeTimers" · https://vitest.dev/api' },
    ]);
  });
});

describe('codex approvals', () => {
  it('turns approval requests into what the user sees, and answers in the shape Codex expects', () => {
    const paths = (id: string) => (id === 'patch-1' ? 'src/a.ts' : undefined);
    expect(
      codexApprovalRequest('item/commandExecution/requestApproval', { command: "/bin/zsh -lc 'touch ../x'", reason: 'Outside the sandbox' }, paths),
    ).toEqual({ kind: 'command', detail: 'touch ../x', command: "/bin/zsh -lc 'touch ../x'", reason: 'Outside the sandbox' });
    expect(codexApprovalRequest('item/fileChange/requestApproval', { itemId: 'patch-1' }, paths)).toMatchObject({ kind: 'edit', detail: 'src/a.ts' });
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
    expect(codexMcpToolApproval({ ...ask, _meta: { ...ask._meta, tool_params: { repo: 'a/b' } } })).toMatchObject({ detail: '{"repo":"a/b"}' });
    // A form the server itself wants filled in is not an approval.
    expect(codexMcpToolApproval({ serverName: 'x', mode: 'form', message: 'Your name?', requestedSchema: {} })).toBeNull();
    expect(codexElicitationResponse(true)).toEqual({ action: 'accept', content: {}, _meta: null });
    expect(codexElicitationResponse(false)).toEqual({ action: 'decline', content: null, _meta: null });
  });
});

describe('codex thread config', () => {
  it('keeps the edit-mode sandbox off the network whatever the user config says', () => {
    expect(codexConfig('edit', 'high')).toEqual({
      model_reasoning_effort: 'high',
      sandbox_workspace_write: { network_access: false },
    });
    expect(codexConfig('read-only')).toEqual({});
    expect(codexConfig('full')).toEqual({});
  });

  it("lets edit mode write the conversation's other working directories too", () => {
    // The legacy sandbox (Windows, nothing to protect): writable roots.
    expect(codexConfig('edit', undefined, [], { off: [] }, ['/docs', '/infra'])).toEqual({
      sandbox_workspace_write: { network_access: false, writable_roots: ['/docs', '/infra'] },
    });
    expect(codexConfig('read-only', undefined, [], { off: [] }, ['/docs'])).toEqual({});
    // A permission profile: a write entry each, and a protected path is denied all the same.
    expect(codexProfile('edit', ['/x', '/docs/secret.db'], 'darwin', ['/docs'])).toEqual({
      extends: ':workspace',
      filesystem: { '/docs': 'write', '/x': 'deny', '/docs/secret.db': 'deny' },
    });
    expect(codexProfile('read-only', ['/x'], 'darwin', ['/docs'])).toEqual({ extends: ':read-only', filesystem: { '/x': 'deny' } });
    const run = { cwd: '/repo', addDirs: ['/docs'], permission: 'edit' as const, systemPrompt: '', requestApproval: async () => ({ allow: true }) };
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
        { name: 'docs', transport: 'http', command: '', args: [], url: 'https://x.test/mcp', env: {}, headers: { Authorization: 'Bearer b' } },
      ]),
    ).toEqual({
      mcp_servers: {
        gh: { command: 'npx', args: ['gh'], env: { TOKEN: 't' } },
        docs: { url: 'https://x.test/mcp', http_headers: { Authorization: 'Bearer b' } },
      },
    });
  });

  it("lets the library's servers approve their own tools in full access, where Codex would refuse every MCP call", () => {
    const gh = { name: 'gh', transport: 'stdio' as const, command: 'gh-mcp', args: [], url: '', env: {}, headers: {} };
    expect(codexConfig('full', undefined, [gh])).toEqual({ mcp_servers: { gh: { command: 'gh-mcp', args: [], default_tools_approval_mode: 'approve' } } });
    // Below full access Codex asks, and the user answers in the chat.
    expect((codexConfig('edit', undefined, [gh]).mcp_servers as Record<string, object>).gh).not.toHaveProperty('default_tools_approval_mode');
  });

  it('leaves out what Codex loads by itself; each of its configured MCP servers, whatever its name', () => {
    const gh = { name: 'gh', transport: 'stdio' as const, command: 'npx', args: ['gh'], url: '', env: {}, headers: {} };
    expect(
      codexConfig('read-only', undefined, [gh], {
        off: ['skills', 'mcp', 'instructions', 'memory'],
        user: { names: ['headroom', 'gh', 'a.b'], disabledTools: {} },
      }),
    ).toEqual({
      'skills.include_instructions': false,
      'features.apps': false,
      project_doc_max_bytes: 0,
      'features.memories': false,
      // gh is the tool library's (it replaces the user's gh). A dotted key could not reach "a.b"; the table can.
      mcp_servers: { headroom: { enabled: false }, 'a.b': { enabled: false }, gh: { command: 'npx', args: ['gh'] } },
    });
    // The user's servers stay on unless MCP servers are left out.
    expect(codexConfig('read-only', undefined, [], { off: ['skills'], user: { names: ['headroom'], disabledTools: {} } })).toEqual({
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
    const user = codexUserMcpConfig({ config: { mcp_servers: { headroom: { command: 'h' }, node: { command: 'n', disabled_tools: ['old'] }, 'a.b': {} } } });
    expect(user).toEqual({ names: ['headroom', 'node', 'a.b'], disabledTools: { node: ['old'] } });
    const items = {
      mcp: ['headroom', 'gone'],
      mcpTools: [codexMcpToolId('node', 'js_reset'), codexMcpToolId('a.b', 'x/y'), codexMcpToolId('headroom', 'run'), codexMcpToolId('gone', 'z'), 'not json'],
    };
    // Only servers in the user's config (an entry for another would be a server without a command),
    // and no tools of a server that is off anyway.
    expect(codexMcpOff([], items, user)).toEqual({ turnOff: ['headroom'], toolsOff: { node: ['old', 'js_reset'], 'a.b': ['x/y'] } });
    expect(codexMcpOff(['mcp'], items, user)).toEqual({ turnOff: ['headroom', 'node', 'a.b'], toolsOff: {} });
    expect(codexConfig('read-only', undefined, [], { off: [], items, user })).toEqual({
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
    const conn = (effort: unknown) => ({ request: async (method: string) => (asked.push(method), { config: { model_reasoning_effort: effort } }) });
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
    expect(await codexUserMcp(ok, { cwd: '/repo', nativeOff: ['skills', 'memory'], nativeItems: { skills: ['/s/SKILL.md'] } })).toEqual(none);
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
    await expect(failure).rejects.toThrow(/^Codex could not list its MCP servers, so they or their tools could not be left out of this run \(config\/read is not supported\)/);
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
        sandbox: 'workspace-write',
        developerInstructions: 'You are @Alice',
        model: 'gpt-5.5',
        config: {
          sandbox_workspace_write: { network_access: false },
          'features.apps': false,
          mcp_servers: { headroom: { enabled: false } },
        },
      },
    });
    // With paths to protect, a permission profile instead of the legacy sandbox: the permission's
    // sandbox and a deny entry for each; the profile keeps the network off by itself.
    const guarded = codexThreadRequest({ ...run, protectedPaths: ['/home/me/.mozilla', '/srv/relay/data/relay.db'] }, user, 'linux', 'harness-relay-1a2b');
    expect(guarded.params).toMatchObject({ permissions: 'harness-relay-1a2b' });
    expect(guarded.params).not.toHaveProperty('sandbox');
    expect(guarded.params.config).toEqual({
      'features.apps': false,
      mcp_servers: { headroom: { enabled: false } },
      permissions: { 'harness-relay-1a2b': { extends: ':workspace', filesystem: { '/home/me/.mozilla': 'deny', '/srv/relay/data/relay.db': 'deny' } } },
    });
    // A new name for each run: a profile of the same name in Codex's other config layers (a trusted
    // project's .codex/config.toml) would be merged into it, and could open a denied path again.
    expect(codexProfileId()).toMatch(/^harness-relay-[0-9a-f]{16}$/);
    expect(codexProfileId()).not.toBe(codexProfileId());
    // Codex must say it applied that profile: one that ignores the field would run in the user's sandbox_mode.
    expect(() => codexCheckProfile(guarded.params, { activePermissionProfile: { id: 'harness-relay-1a2b', extends: ':workspace' } })).not.toThrow();
    expect(() => withLang('en', () => codexCheckProfile(guarded.params, { thread: { id: 'thr-1' } }))).toThrow(
      /^Codex did not run this thread in the permission profile Harness Relay gave it \(it answered no profile;/,
    );
    expect(() => withLang('en', () => codexCheckProfile(guarded.params, { activePermissionProfile: { id: ':workspace' } }))).toThrow(/answered ":workspace"/);
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
    const lab = { id: 'lab/qwen3', model: 'qwen3', endpoint: { id: 'lab', name: 'Lab', baseUrl: 'http://10.0.0.6:8000/v1', models: ['qwen3'] } };
    const onLab = codexThreadRequest({ ...run, model: 'lab/qwen3', sessionId: 'thr-1' }, user, 'linux', 'harness-relay-1a2b', lab);
    expect(onLab.params).toMatchObject({
      threadId: 'thr-1',
      model: 'qwen3',
      modelProvider: 'harness-relay-lab',
      config: {
        model_provider: 'harness-relay-lab',
        model_providers: { 'harness-relay-lab': { name: 'Harness Relay: Lab', base_url: 'http://10.0.0.6:8000/v1', wire_api: 'responses' } },
      },
    });
    // Full access, or a conversation that refuses automatically, never asks.
    expect(codexThreadRequest({ ...run, permission: 'full' }).params.approvalPolicy).toBe('never');
    expect(codexThreadRequest({ ...run, requestApproval: undefined }).params.approvalPolicy).toBe('never');
    // Single items go in the thread's config as well.
    expect(codexThreadRequest({ ...run, nativeOff: [], nativeItems: { plugins: ['pdf@openai'] } }).params.config).toEqual({
      sandbox_workspace_write: { network_access: false },
      plugins: { 'pdf@openai': { enabled: false } },
    });
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
    const took = conn({ 'hooks/list': { data: [{ cwd: '/repo', hooks: [] }] }, 'plugin/installed': { marketplaces: [{ name: 'm', plugins: [] }] } });
    await expect(codexConfirmLeftOut(took, run, 'thr-1')).resolves.toBeUndefined();
    expect(asked).toEqual(['hooks/list', 'plugin/installed']);

    // Nothing to check when neither is left out.
    asked.length = 0;
    await codexConfirmLeftOut(took, { cwd: '/repo', nativeOff: ['skills'] }, 'thr-1');
    expect(asked).toEqual([]);

    // A Codex that ignored the keys still lists them on: the run must not go on quietly.
    const ignored = conn({
      'hooks/list': { data: [{ cwd: '/repo', hooks: [{ key: 'h', eventName: 'stop', enabled: true }, { key: 'o', eventName: 'stop', enabled: false }] }] },
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
      'skills/list': { data: [{ skills: [{ name: 'a', path: '/s/a/SKILL.md', enabled: false }, { name: 'b', path: '/s/b/SKILL.md', enabled: true }] }] },
      'hooks/list': { data: [{ hooks: [{ key: 'h1', eventName: 'stop', enabled: false }, { key: 'h2', eventName: 'stop', enabled: true }] }] },
      'plugin/installed': { marketplaces: [{ plugins: [{ id: 'pdf@o', installed: true, enabled: false }, { id: 'docs@o', installed: true, enabled: true }] }] },
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
    await expect(withLang('zh-TW', () => codexConfirmLeftOut(conn, { cwd: '/repo', nativeItems: { hooks: ['h2'] } }, 'thr-1'))).rejects.toThrow(
      /^Codex 仍載入了設為不載入的 hook/,
    );
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
  // (a turn in it fails, as Codex 0.167 on Linux does). Each request goes to the log.
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
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (!m.method) return log({ answer: m }); // the client's answer to a request of ours
  log({ method: m.method });
  const reply = (result) => out({ id: m.id, result });
  switch (m.method) {
    case 'initialize': init = m.params; return reply({});
    case 'thread/start': {
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
      const r = { data: [{ hooks: off('features.hooks') ? [] : [{ key: 'h', eventName: 'stop', enabled: true }] }] };
      return process.env.FAKE_CODEX_SLOW ? setTimeout(() => reply(r), 2000) : reply(r);
    }
    case 'config/read':
      return reply({ config: { model_reasoning_effort: process.env.FAKE_CODEX_EFFORT ?? null }, origins: {} });
    case 'plugin/installed':
      return reply({ marketplaces: [{ name: 'm', plugins: off('features.plugins') ? [] : [{ id: 'deck@m', installed: true, enabled: true }] }] });
    case 'turn/start':
      reply({ turn: { id: 'turn-1' } });
      if (process.env.FAKE_CODEX_PROFILE_FAILS && profiled) {
        const error = { message: 'failed to load workspace requirements: invalid input parameter' };
        return setTimeout(() => out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'failed', error } } }), 50);
      }
      // Asked of clients that take the experimental API.
      if (init.capabilities?.experimentalApi) out({ id: 'time-1', method: 'currentTime/read', params: { threadId: 'thr-1' } });
      return setTimeout(() => out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed' } } }), 100);
    default:
      return out({ id: m.id, error: { code: -32600, message: 'Invalid request: unknown variant ' + m.method } });
  }
});
`;
  const bin = join(dir, 'codex');
  writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
  let n = 0;
  function run(extra: Record<string, string> = {}, signal = new AbortController().signal, protectedPaths: string[] = []) {
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
      }),
    );
    const lines = () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args?: string[]; method?: string; capabilities?: unknown; permissions?: string | null; sandbox?: string | null });
    return { result, lines, methods: () => lines().flatMap((l) => (l.method ? [l.method] : [])) };
  }

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
      expect(next.lines().filter((l) => 'permissions' in l)).toEqual([expect.objectContaining({ permissions: null, sandbox: 'read-only' })]);
    } finally {
      resetCodexProfiles();
    }
  });

  it('fails before the turn when Codex did not apply the permission profile', async () => {
    const r = run({ FAKE_CODEX_NO_PROFILE: '1' }, undefined, ['/home/me/.mozilla']);
    await expect(r.result).rejects.toThrow(/^Codex did not run this thread in the permission profile Harness Relay gave it/);
    expect(r.methods()).not.toContain('turn/start');
  });

  it("runs the model of the user's own endpoint there, with its key in a variable and an effort it takes", async () => {
    const endpoint = (apiKey?: string) => ({ id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:11434/v1', models: ['gemma4:e4b'], ...(apiKey ? { apiKey } : {}) });
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
      const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
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
      providers: { 'harness-relay-homelab': { name: 'Harness Relay: Homelab', base_url: 'http://10.0.0.5:11434/v1', wire_api: 'responses', env_key: 'HARNESS_RELAY_ENDPOINT_API_KEY' } },
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
    expect(own.started).toEqual({ model: 'gpt-6.1-sol', modelProvider: null, configProvider: null, providers: null, effort: 'xhigh', key: 'from-the-shell' });
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
