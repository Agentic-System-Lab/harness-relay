import { describe, expect, it } from 'vitest';
import { JsonRpcConnection, RpcError } from '../src/server/agents/acp';
import {
  createGrokUpdateHandler,
  describeGrokCancel,
  grokApprovalRequest,
  grokMcpServers,
  grokEnv,
  grokNativeEnv,
  grokPermissionDecision,
  type GrokToolCall,
} from '../src/server/agents/grok';
import type { AgentEvent } from '../src/server/agents/types';

// Shapes below are trimmed from real `grok agent stdio` traffic (grok 1.0.77).
const SHELL_CALL: GrokToolCall = {
  toolCallId: 'call-1',
  kind: 'execute',
  title: 'Execute `npm test`',
  rawInput: { variant: 'Bash', command: 'npm test' },
  _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute', read_only: false } },
};
const FETCH_CALL: GrokToolCall = {
  toolCallId: 'call-2',
  kind: 'fetch',
  title: 'Fetch: https://example.com',
  rawInput: { variant: 'WebFetch', url: 'https://example.com' },
  _meta: { 'x.ai/tool': { name: 'web_fetch', kind: 'web_fetch', read_only: true } },
};
const WRITE_CALL: GrokToolCall = {
  toolCallId: 'call-3',
  kind: 'edit',
  title: 'Write `/repo/a.txt`',
  rawInput: { file_path: '/repo/a.txt', content: 'hi' },
  _meta: { 'x.ai/tool': { name: 'write', kind: 'write', read_only: false } },
};
const shell = (command: string): GrokToolCall => ({ ...SHELL_CALL, title: `Execute \`${command}\``, rawInput: { command } });

describe('grok permission policy', () => {
  it('read-only: approves web fetch, refuses everything else with a reason for the model', () => {
    expect(grokPermissionDecision('read-only', FETCH_CALL)).toEqual({ allow: true });
    for (const call of [SHELL_CALL, WRITE_CALL]) {
      const d = grokPermissionDecision('read-only', call);
      expect(d.allow).toBe(false);
      if (!d.allow) {
        expect(d.reason).toContain('read-only');
        expect(d.reason).toContain(call.title);
        expect(d.label).toContain('唯讀');
      }
    }
  });

  it('edit: approves edits and commands (the sandbox confines writes) but not publishing', () => {
    for (const call of [SHELL_CALL, WRITE_CALL, FETCH_CALL, shell('rm -rf build'), shell('git commit -m x')]) {
      expect(grokPermissionDecision('edit', call)).toEqual({ allow: true });
    }
    for (const cmd of ['git push origin main', 'npm test && git push', 'npm publish', 'cd pkg; cargo publish', 'twine upload dist/*']) {
      expect(grokPermissionDecision('edit', shell(cmd)).allow).toBe(false);
    }
    expect(grokPermissionDecision('edit', shell('echo git pushed')).allow).toBe(true);
  });

  it('full: approves everything', () => {
    expect(grokPermissionDecision('full', shell('git push'))).toEqual({ allow: true });
  });
});

describe('grok session updates', () => {
  it('streams text and tools, showing our refusal reason on the refused call', () => {
    const events: AgentEvent[] = [];
    const h = createGrokUpdateHandler((e) => events.push(e));
    h.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我先跑測試。' } });
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'run_terminal_command', rawInput: { command: 'npm test' } });
    h.refused('call-1', '唯讀模式不允許，已告知 Grok 改用唯讀工具');
    h.handle({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'The user elected to avoid running the run_terminal_command tool.' } }],
    });
    h.handle({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '測試沒有執行。' } });
    h.handle({ sessionUpdate: 'response_completed' });

    expect(events).toEqual([
      { type: 'text', text: '我先跑測試。' },
      { type: 'text_end' },
      { type: 'tool_start', id: 'call-1', name: 'run_terminal_command', detail: 'npm test' },
      { type: 'tool_end', id: 'call-1', ok: false, error: '唯讀模式不允許，已告知 Grok 改用唯讀工具' },
      { type: 'text', text: '測試沒有執行。' },
      { type: 'text_end' },
    ]);
  });

  it("falls back to grok's own reason, and remembers the last failure", () => {
    const events: AgentEvent[] = [];
    const h = createGrokUpdateHandler((e) => events.push(e));
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'web_fetch', _meta: { 'x.ai/tool': { name: 'web_fetch' } } });
    h.handle({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'User cancelled the execution for tool `web_fetch`' } }],
    });
    expect(events.at(-1)).toEqual({ type: 'tool_end', id: 'c', ok: false, error: 'User cancelled the execution for tool `web_fetch`' });
    expect(h.lastFailure).toEqual({ tool: 'web_fetch', reason: 'User cancelled the execution for tool `web_fetch`' });
    expect(describeGrokCancel(h.lastFailure, 'read-only')).toContain('web_fetch');
    expect(describeGrokCancel(undefined, 'edit')).toContain('cancelled');
  });

  it('shows what a backend web search searched for, which only comes with its result', () => {
    const events: AgentEvent[] = [];
    const h = createGrokUpdateHandler((e) => events.push(e));
    // As grok 1.0.77 sends them: the title is a label for a query it does not know yet.
    const search = (id: string, action: Record<string, unknown>) => {
      h.handle({
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: 'Web search:',
        kind: 'search',
        status: 'in_progress',
        rawInput: { variant: 'WebSearch', backend: true },
        _meta: { backend: true },
      });
      h.handle({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', title: 'Web search:', rawOutput: { id, status: 'completed', action } });
    };
    search('ws-1', { type: 'search', query: 'PTSD treatment guidelines 2024', sources: [{ type: 'url', url: 'https://example.org/a' }] });
    search('ws-2', { type: 'open_page', url: 'https://example.org/docs' });
    search('ws-3', { type: 'find_in_page', url: 'https://example.org/schema.ts', pattern: 'FunnelsFilter' });
    expect(events).toEqual([
      { type: 'tool_start', id: 'ws-1', name: 'Web search' },
      { type: 'tool_end', id: 'ws-1', ok: true, detail: 'PTSD treatment guidelines 2024' },
      { type: 'tool_start', id: 'ws-2', name: 'Web search' },
      { type: 'tool_end', id: 'ws-2', ok: true, detail: 'https://example.org/docs' },
      { type: 'tool_start', id: 'ws-3', name: 'Web search' },
      { type: 'tool_end', id: 'ws-3', ok: true, detail: '"FunnelsFilter" · https://example.org/schema.ts' },
    ]);
  });

  it('shows what a backend X search searched for, from the input its result carries', () => {
    const events: AgentEvent[] = [];
    const h = createGrokUpdateHandler((e) => events.push(e));
    // As grok 1.0.77 sends them: `input` is the X tool's arguments as a JSON string.
    h.handle({
      sessionUpdate: 'tool_call',
      toolCallId: 'xs-1',
      title: 'X search:',
      kind: 'search',
      status: 'in_progress',
      rawInput: { variant: 'XSearch', backend: true },
      _meta: { backend: true },
    });
    h.handle({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'xs-1',
      status: 'completed',
      title: 'X search:',
      rawOutput: { call_id: 'xs_call-1', input: '{"query":"xAI Grok","limit":"3","mode":"Latest"}', name: 'x_keyword_search', id: 'xs-1' },
    });
    expect(events).toEqual([
      { type: 'tool_start', id: 'xs-1', name: 'X search' },
      { type: 'tool_end', id: 'xs-1', ok: true, detail: 'xAI Grok' },
    ]);
  });

  it('keeps the query and the reason of a failed backend search, and shows nothing it cannot read', () => {
    const events: AgentEvent[] = [];
    const h = createGrokUpdateHandler((e) => events.push(e));
    const start = (id: string) =>
      h.handle({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Web search:', rawInput: { variant: 'WebSearch', backend: true }, _meta: { backend: true } });
    start('f');
    h.handle({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'f',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'Web search failed' } }],
      rawOutput: { id: 'f', status: 'failed', action: { type: 'search', query: 'vitest' } },
    });
    start('o');
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'o', status: 'completed', rawOutput: { id: 'o', status: 'completed', action: { type: 'other' } } });
    start('x');
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed', rawOutput: { input: 'not json', name: 'x_keyword_search' } });
    expect(events.filter((e) => e.type === 'tool_end')).toEqual([
      { type: 'tool_end', id: 'f', ok: false, error: 'Web search failed', detail: 'vitest' },
      { type: 'tool_end', id: 'o', ok: true },
      { type: 'tool_end', id: 'x', ok: true },
    ]);
    expect(h.lastFailure).toEqual({ tool: 'Web search', reason: 'Web search failed' });
  });

  it('shows the file read_file reads and the folder list_dir lists', () => {
    const events: AgentEvent[] = [];
    const h = createGrokUpdateHandler((e) => events.push(e));
    // As grok 1.0.77 sends them: the path only under these names in the first tool_call.
    const tool = (name: string, kind: string) => ({ 'x.ai/tool': { version: 1, name, kind, namespace: 'grok_build', read_only: true } });
    h.handle({
      sessionUpdate: 'tool_call',
      toolCallId: 'r',
      title: 'read_file',
      rawInput: { target_file: '/repo/src/server/orchestrator.ts', offset: 180, limit: 120 },
      _meta: tool('read_file', 'read'),
    });
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'l', title: 'list_dir', rawInput: { target_directory: '/repo/test' }, _meta: tool('list_dir', 'list') });
    expect(events).toEqual([
      { type: 'tool_start', id: 'r', name: 'read_file', detail: '/repo/src/server/orchestrator.ts' },
      { type: 'tool_start', id: 'l', name: 'list_dir', detail: '/repo/test' },
    ]);
  });

  it("does not take a detail from another tool's output, nor change its name", () => {
    const events: AgentEvent[] = [];
    const h = createGrokUpdateHandler((e) => events.push(e));
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'g', title: 'grep:', rawInput: { pattern: 'TODO' } });
    h.handle({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'g',
      status: 'completed',
      rawOutput: { pattern: 'other', action: { query: 'x' }, input: '{"query":"y"}' },
    });
    expect(events).toEqual([
      { type: 'tool_start', id: 'g', name: 'grep:', detail: 'TODO' },
      { type: 'tool_end', id: 'g', ok: true },
    ]);
  });
});

describe('grok activity and approvals', () => {
  it('streams thinking and plans, hides to-do tool rows, and keeps tool output', () => {
    const events: AgentEvent[] = [];
    const h = createGrokUpdateHandler((e) => events.push(e));
    h.handle({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me check.' } });
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'td', title: 'todo_write', _meta: { 'x.ai/tool': { name: 'todo_write' } } });
    h.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'td', status: 'completed' });
    h.handle({ sessionUpdate: 'plan', entries: [{ content: 'Run tests', status: 'in_progress', priority: 'high' }, { content: 'Report', status: 'pending' }] });
    h.handle({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'run_terminal_command', rawInput: { command: 'npm test' } });
    h.handle({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ALL-TESTS-PASSED' } }],
    });
    expect(events).toEqual([
      { type: 'thinking', text: 'Let me check.' },
      { type: 'plan', entries: [{ text: 'Run tests', status: 'in_progress' }, { text: 'Report', status: 'pending' }] },
      { type: 'tool_start', id: 'c1', name: 'run_terminal_command', detail: 'npm test' },
      { type: 'tool_end', id: 'c1', ok: true, output: 'ALL-TESTS-PASSED' },
    ]);
  });

  it('describes what grok asks about', () => {
    expect(grokApprovalRequest(shell('git push origin main'))).toMatchObject({ kind: 'command', detail: 'git push origin main' });
    expect(grokApprovalRequest(WRITE_CALL)).toMatchObject({ kind: 'edit', detail: '/repo/a.txt' });
    expect(grokApprovalRequest(FETCH_CALL)).toMatchObject({ kind: 'fetch', detail: 'https://example.com' });
    expect(grokApprovalRequest({ title: 'linear', kind: 'other', _meta: { 'x.ai/tool': { name: 'linear__create' } } })).toMatchObject({
      kind: 'other',
      tool: 'linear__create',
    });
    // Reading a file or listing a folder: the card says which one.
    const read = { title: 'read_file', kind: 'read', rawInput: { target_file: '/repo/a.ts', limit: 80 }, _meta: { 'x.ai/tool': { name: 'read_file' } } };
    expect(grokApprovalRequest(read)).toMatchObject({ kind: 'other', tool: 'read_file', detail: '/repo/a.ts' });
    const list = { title: 'list_dir', kind: 'other', rawInput: { target_directory: '/repo/test' }, _meta: { 'x.ai/tool': { name: 'list_dir' } } };
    expect(grokApprovalRequest(list)).toMatchObject({ kind: 'other', tool: 'list_dir', detail: '/repo/test' });
    // Whole, however long: where it starts tells whether it is inside the project.
    const long = '/private/tmp/' + 'folder-with-a-long-name/'.repeat(8) + 'secrets.env';
    expect(grokApprovalRequest({ ...read, rawInput: { target_file: long } })).toMatchObject({ detail: long });
  });
});

describe('JSON-RPC connection', () => {
  it('matches responses to requests and surfaces errors', async () => {
    const sent: any[] = [];
    const conn = new JsonRpcConnection((line) => sent.push(JSON.parse(line)));
    const ok = conn.request('initialize', { protocolVersion: 1 });
    const bad = conn.request('session/set_config_option', {});
    conn.handleLine(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { protocolVersion: 1 } }));
    conn.handleLine(JSON.stringify({ jsonrpc: '2.0', id: sent[1].id, error: { code: -32602, message: 'Invalid params' } }));
    await expect(ok).resolves.toEqual({ protocolVersion: 1 });
    await expect(bad).rejects.toThrow('Invalid params');
  });

  it('answers requests from the agent (id 0 included) and passes notifications through', async () => {
    const sent: any[] = [];
    const notes: string[] = [];
    const conn = new JsonRpcConnection((line) => sent.push(JSON.parse(line)));
    conn.onNotification = (method) => notes.push(method);
    conn.onRequest = (method) => {
      if (method === 'session/request_permission') return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
      throw new RpcError(-32601, `${method} is not supported`);
    };
    conn.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: {} } }));
    conn.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {} }));
    conn.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'fs/read_text_file', params: {} }));
    await new Promise((r) => setTimeout(r, 0));
    expect(notes).toEqual(['session/update']);
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'fs/read_text_file is not supported' } });
  });

  it('fails pending and later requests once closed', async () => {
    const conn = new JsonRpcConnection(() => {});
    const pending = conn.request('session/prompt', {});
    conn.close(new Error('grok exited'));
    await expect(pending).rejects.toThrow('grok exited');
    await expect(conn.request('initialize')).rejects.toThrow('grok exited');
  });
});

describe('leaving out what Grok loads by itself', () => {
  it('turns off what it loads from Claude Code and Cursor, and its memory, with variables', () => {
    expect(grokNativeEnv(['skills', 'mcp', 'memory'])).toEqual({
      GROK_CLAUDE_SKILLS_ENABLED: 'false',
      GROK_CURSOR_SKILLS_ENABLED: 'false',
      GROK_CLAUDE_MCPS_ENABLED: 'false',
      GROK_CURSOR_MCPS_ENABLED: 'false',
      GROK_MEMORY: '0',
    });
    expect(grokNativeEnv(['instructions'])).toEqual({});
    expect(grokNativeEnv()).toEqual({});
    // The hooks it takes from Claude Code's and Cursor's settings files (not plugins', not its own).
    expect(grokNativeEnv(['hooks'])).toEqual({ GROK_CLAUDE_HOOKS_ENABLED: 'false', GROK_CURSOR_HOOKS_ENABLED: 'false' });
    // Its own subagents and plugins have no switch for one run.
    expect(grokNativeEnv(['agents', 'plugins'])).toEqual({});
  });

  it("keeps the user's variables and the sandbox next to them", () => {
    expect(grokEnv({ env: { PATH: '/bin', GROK_MEMORY: '1' }, nativeOff: ['memory', 'mcp'], permission: 'edit' })).toEqual({
      PATH: '/bin',
      GROK_MEMORY: '0',
      GROK_CLAUDE_MCPS_ENABLED: 'false',
      GROK_CURSOR_MCPS_ENABLED: 'false',
      GROK_SANDBOX: 'workspace',
    });
    expect(grokEnv({ env: { PATH: '/bin' }, permission: 'read-only' })).toEqual({ PATH: '/bin' });
  });
});

describe('grok and the tool library', () => {
  it("passes library MCP servers in ACP's form", () => {
    expect(
      grokMcpServers([
        { name: 'gh', transport: 'stdio', command: 'npx', args: ['gh'], url: '', env: { TOKEN: 't' }, headers: {} },
        { name: 'docs', transport: 'http', command: '', args: [], url: 'https://x.test/mcp', env: {}, headers: { Authorization: 'Bearer b' } },
      ]),
    ).toEqual([
      { name: 'gh', command: 'npx', args: ['gh'], env: [{ name: 'TOKEN', value: 't' }] },
      { type: 'http', name: 'docs', url: 'https://x.test/mcp', headers: [{ name: 'Authorization', value: 'Bearer b' }] },
    ]);
    expect(grokMcpServers([])).toEqual([]);
    // An agent that does not advertise HTTP MCP support gets the stdio servers only.
    expect(
      grokMcpServers(
        [
          { name: 'gh', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {} },
          { name: 'docs', transport: 'http', command: '', args: [], url: 'https://x.test/mcp', env: {}, headers: {} },
        ],
        false,
      ).map((s) => s.name),
    ).toEqual(['gh']);
  });
});
