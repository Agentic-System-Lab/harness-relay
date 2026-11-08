import { describe, expect, it } from 'vitest';
import {
  codexApprovalRequest,
  codexApprovalResponse,
  codexConfig,
  codexElicitationResponse,
  codexMcpToolApproval,
  codexConfiguredMcpServers,
  codexNativeConfig,
  codexThreadRequest,
  codexUserMcpServers,
  createCodexUpdateHandler,
  describeCodexItem,
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
    h.handle('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, outputTokens: 10, reasoningOutputTokens: 5 } } });
    h.handle('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 50, outputTokens: 2, reasoningOutputTokens: 0 } } });

    expect(events).toEqual([
      { type: 'thinking', text: 'Checking the tests.' },
      { type: 'plan', entries: [{ text: 'Run tests', status: 'in_progress' }, { text: 'Report', status: 'pending' }] },
      { type: 'tool_start', id: 'exec-1', name: 'Shell', detail: 'npm test' },
      { type: 'tool_end', id: 'exec-1', ok: true, output: '> test\nALL-TESTS-PASSED' },
      { type: 'text', text: 'Tests pass.' },
      { type: 'text_end' },
    ]);
    expect(h.usage).toEqual({ inputTokens: 150, outputTokens: 17 });
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
    expect(describeCodexItem({ type: 'fileChange', changes: [{ path: 'a.ts', kind: { type: 'update' } }] })).toEqual({ name: 'Edit', detail: 'update a.ts' });
    expect(describeCodexItem({ type: 'webSearch', query: 'vitest' })).toEqual({ name: 'WebSearch', detail: 'vitest' });
    expect(describeCodexItem({ type: 'agentMessage' })).toBeNull();
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
        userMcpServers: ['headroom', 'gh', 'a.b'],
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
    expect(codexConfig('read-only', undefined, [], { off: ['skills'], userMcpServers: ['headroom'] })).toEqual({
      'skills.include_instructions': false,
    });
    expect(codexNativeConfig([])).toEqual({});
    expect(codexNativeConfig(['instructions'])).toEqual({ project_doc_max_bytes: 0 });
  });

  it('asks Codex for its MCP servers only when they are left out, and fails the run plainly when it cannot say', async () => {
    const asked: [string, unknown][] = [];
    const conn = (answer: () => Promise<unknown>) => ({
      request: (method: string, params?: unknown) => (asked.push([method, params]), answer()),
    });
    const ok = conn(async () => ({ config: { mcp_servers: { headroom: {} } } }));
    expect(await codexUserMcpServers(ok, { cwd: '/repo', nativeOff: ['skills', 'memory'] })).toEqual([]);
    expect(await codexUserMcpServers(ok, { cwd: '/repo' })).toEqual([]);
    expect(asked).toEqual([]);
    expect(await codexUserMcpServers(ok, { cwd: '/repo', nativeOff: ['mcp'] })).toEqual(['headroom']);
    expect(asked).toEqual([['config/read', { cwd: '/repo' }]]);

    // An older codex without config/read, say: going on would run the servers the user turned off.
    const old = conn(async () => {
      throw new RpcError(-32601, 'config/read is not supported');
    });
    const failure = withLang('en', () => codexUserMcpServers(old, { cwd: '/repo', nativeOff: ['mcp'] }));
    await expect(failure).rejects.toBeInstanceOf(AgentRunError);
    await expect(failure).rejects.toThrow(/^Codex could not list its MCP servers, so they could not be left out of this run \(config\/read is not supported\)/);
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
    const start = codexThreadRequest(run, ['headroom']);
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
    // Resuming gets the same settings, so a switch changed mid-chat reaches the next turn.
    expect(codexThreadRequest({ ...run, sessionId: 'thr-1' }, ['headroom'])).toEqual({
      method: 'thread/resume',
      params: { threadId: 'thr-1', ...start.params },
    });
    // Full access, or a conversation that refuses automatically, never asks.
    expect(codexThreadRequest({ ...run, permission: 'full' }, []).params.approvalPolicy).toBe('never');
    expect(codexThreadRequest({ ...run, requestApproval: undefined }, []).params.approvalPolicy).toBe('never');
  });

  it('reads the configured MCP servers from config/read', () => {
    expect(codexConfiguredMcpServers({ config: { mcp_servers: { headroom: {}, node_repl: {} } } })).toEqual(['headroom', 'node_repl']);
    expect(codexConfiguredMcpServers({ config: {} })).toEqual([]);
    expect(codexConfiguredMcpServers(undefined)).toEqual([]);
  });
});
