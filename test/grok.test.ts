import { describe, expect, it } from 'vitest';
import { JsonRpcConnection, RpcError } from '../src/server/agents/acp';
import { createGrokUpdateHandler, describeGrokCancel, grokPermissionDecision, type GrokToolCall } from '../src/server/agents/grok';
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
