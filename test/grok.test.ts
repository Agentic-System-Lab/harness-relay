import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonRpcConnection, RpcError } from '../src/server/agents/acp';
import {
  createGrokUpdateHandler,
  describeGrokCancel,
  grokApprovalRequest,
  grokMcpServers,
  grokEndpointModelId,
  grokEnv,
  grokHome,
  grokModelsBlock,
  grokBlockEndpoints,
  grokRunner,
  holdGrokTypedModel,
  withGrokModels,
  writeGrokModels,
  grokProfileBlock,
  grokPrograms,
  guardGrokProgram,
  readGrokProgram,
  restoreGrokProgram,
  guardGrokSettings,
  restoreGrokSettings,
  snapshotGrokSettings,
  grokSandboxProfile,
  grokReadWrite,
  isRelayProfile,
  holdGrokProfile,
  grokProfilesInUse,
  MAX_FOLDER_PROFILES,
  withGrokProfile,
  writeGrokProfile,
  writeGrokSetting,
  grokNativeEnv,
  grokPermissionDecision,
  type GrokToolCall,
} from '../src/server/agents/grok';
import type { AgentEvent } from '../src/server/agents/types';
import { withLang } from '../src/server/i18n';

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
    expect(grokEnv({ env: { PATH: '/bin', GROK_MEMORY: '1' }, nativeOff: ['memory', 'mcp'], permission: 'edit' }, 'linux')).toEqual({
      PATH: '/bin',
      GROK_MEMORY: '0',
      GROK_CLAUDE_MCPS_ENABLED: 'false',
      GROK_CURSOR_MCPS_ENABLED: 'false',
      GROK_SANDBOX: 'harness-relay',
    });
    // Read-only runs in the same profile: Grok's `read-only` one refuses to start on some machines,
    // and a session resumes only under the profile it started with.
    expect(grokEnv({ env: { PATH: '/bin' }, permission: 'read-only' }, 'darwin')).toEqual({ PATH: '/bin', GROK_SANDBOX: 'harness-relay' });
    expect(grokEnv({ env: { PATH: '/bin' }, permission: 'full' }, 'linux')).toEqual({ PATH: '/bin' });
    // Windows: no sandbox to give a deny list to; the built-in profile as before.
    expect(grokEnv({ env: { PATH: '/bin' }, permission: 'edit' }, 'win32')).toEqual({ PATH: '/bin', GROK_SANDBOX: 'workspace' });
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

describe("Grok's sandbox profile", () => {
  it('is its own profile below full access, and the built-in one on Windows', () => {
    expect(grokSandboxProfile('read-only', 'darwin')).toBe('harness-relay');
    expect(grokSandboxProfile('edit', 'linux')).toBe('harness-relay');
    expect(grokSandboxProfile('full', 'linux')).toBeUndefined();
    expect(grokSandboxProfile('edit', 'win32')).toBe('workspace');
    expect(grokHome({ GROK_HOME: '/agents/grok' })).toBe('/agents/grok');
    expect(grokHome({})).toMatch(/\.grok$/);
  });

  it('is written into sandbox.toml beside the user\'s own profiles, and replaced in place', () => {
    const block = grokProfileBlock(['/home/me/.mozilla', '/srv/a "b"/relay.db']);
    expect(block).toContain('[profiles.harness-relay]\nextends = "workspace"\ndeny = ["/home/me/.mozilla", "/srv/a \\"b\\"/relay.db"]');
    // Control characters are escaped as TOML takes them, DEL included (JSON leaves it as it is).
    expect(grokProfileBlock(['/a\tb\n\u0001\u007f'])).toContain('deny = ["/a\\tb\\n\\u0001\\u007F"]');
    const user = '[profiles.mine]\nextends = "strict"\n';
    const once = withGrokProfile(user, block);
    expect(once.startsWith(user)).toBe(true);
    expect(once).toContain(block);
    // Written again with another list: the block is replaced, the user's profile kept, nothing added twice.
    const again = withGrokProfile(once, grokProfileBlock(['/x']));
    expect(again.startsWith(user)).toBe(true);
    expect(again.match(/\[profiles\.harness-relay\]/g)).toHaveLength(1);
    expect(again).toContain('deny = ["/x"]');
    expect(withGrokProfile('', block)).toBe(`${block}\n`);
  });

  it("writes the file in Grok's home only when it changes", () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-home-'));
    try {
      writeGrokProfile(home, ['/x']);
      const file = join(home, 'sandbox.toml');
      expect(readFileSync(file, 'utf8')).toContain('deny = ["/x"]');
      writeFileSync(file, `# mine\n${readFileSync(file, 'utf8')}`);
      writeGrokProfile(home, ['/x']);
      expect(readFileSync(file, 'utf8').startsWith('# mine\n')).toBe(true);
      // A link to the user's own file stays a link; the file it leads to gets the profile.
      const dotfile = join(home, 'dotfiles-sandbox.toml');
      writeFileSync(dotfile, '[profiles.mine]\nextends = "strict"\n');
      rmSync(file);
      symlinkSync(dotfile, file);
      writeGrokProfile(home, ['/y']);
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      expect(readFileSync(dotfile, 'utf8')).toContain('deny = ["/y"]');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Grok on the user's own endpoints", () => {
  const lab = { id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:11434/v1', models: ['gemma4:e4b', 'qwen/qwen3 "x"'] };

  it('defines each endpoint model in config.toml: hidden, its key from a variable, never the sign-in', () => {
    expect(grokEndpointModelId('homelab', 'gemma4:e4b')).toBe('harness-relay/homelab/gemma4:e4b');
    const block = grokModelsBlock([lab]);
    expect(block).toContain(
      [
        '[model."harness-relay/homelab/gemma4:e4b"]',
        'model = "gemma4:e4b"',
        'base_url = "http://10.0.0.5:11434/v1"',
        'name = "gemma4:e4b · Homelab"',
        'env_key = "HARNESS_RELAY_ENDPOINT_API_KEY"',
        'hidden = true',
      ].join('\n'),
    );
    // Quoted as TOML takes it.
    expect(block).toContain('[model."harness-relay/homelab/qwen/qwen3 \\"x\\""]');
    expect(block.split('\n')[0]).toMatch(/^# >>> harness-relay models/);
    expect(grokModelsBlock([])).toBe('');
    expect(grokModelsBlock([{ ...lab, models: [] }])).toBe('');
  });

  it("goes after the user's own settings, is replaced in place, and comes out with the last endpoint", () => {
    const user = '[models]\ndefault = "grok-4.7"\n';
    const block = grokModelsBlock([lab]);
    const once = withGrokModels(user, block);
    expect(once).toBe(`${user}\n${block}\n`);
    // A table the user (or Grok) added after it stays.
    const later = `${once}\n[ui]\nyolo = false\n`;
    const other = grokModelsBlock([{ ...lab, models: ['gemma4:26b'] }]);
    const again = withGrokModels(later, other);
    expect(again).toBe(`${user}\n${other}\n\n[ui]\nyolo = false\n`);
    expect(again.match(/# >>> harness-relay models/g)).toHaveLength(1);
    expect(withGrokModels(again, '')).toBe(`${user}\n[ui]\nyolo = false\n`);
    expect(withGrokModels(once, '')).toBe(user);
    expect(withGrokModels(user, '')).toBe(user);
    expect(withGrokModels('', block)).toBe(`${block}\n`);
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')('is written only once a turn uses it, then kept up to date, with the file’s mode and through a link', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-models-'));
    const file = join(home, 'config.toml');
    try {
      writeGrokModels(home, [lab], false);
      expect(existsSync(file)).toBe(false);
      writeFileSync(file, '[models]\ndefault = "grok-4.7"\n', { mode: 0o644 });
      writeGrokModels(home, [lab], false);
      expect(readFileSync(file, 'utf8')).not.toContain('harness-relay');
      writeGrokModels(home, [lab], true);
      expect(readFileSync(file, 'utf8')).toContain('[model."harness-relay/homelab/gemma4:e4b"]');
      expect(statSync(file).mode & 0o777).toBe(0o644);
      // Without `add`, a block that is there follows the endpoints, and goes with the last one.
      writeGrokModels(home, [{ ...lab, models: ['gemma4:26b'] }], false);
      expect(readFileSync(file, 'utf8')).toContain('harness-relay/homelab/gemma4:26b');
      expect(readFileSync(file, 'utf8')).not.toContain('harness-relay/homelab/gemma4:e4b');
      writeGrokModels(home, [], false);
      expect(readFileSync(file, 'utf8')).toBe('[models]\ndefault = "grok-4.7"\n');
      // A link to the user's own file stays a link; the file it leads to gets the models.
      const dotfile = join(home, 'dotfiles-config.toml');
      writeFileSync(dotfile, '[ui]\n');
      rmSync(file);
      symlinkSync(dotfile, file);
      writeGrokModels(home, [lab], true);
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      expect(readFileSync(dotfile, 'utf8')).toContain('harness-relay/homelab/gemma4:e4b');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is taken as it is by the turns running when a new turn writes it after the endpoints changed', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-models-guard-'));
    const file = join(home, 'config.toml');
    try {
      writeFileSync(file, '[ui]\n');
      const first = guardGrokSettings(home, () => writeGrokModels(home, [lab], true));
      const second = guardGrokSettings(home, () => writeGrokModels(home, [{ ...lab, models: ['gemma4:26b'] }], true));
      expect(second()).toEqual([]);
      expect(first()).toEqual([]);
      expect(readFileSync(file, 'utf8')).toContain('harness-relay/homelab/gemma4:26b');
      // A command's change is still put back and named.
      const third = guardGrokSettings(home, () => writeGrokModels(home, [lab], true));
      writeFileSync(file, `${readFileSync(file, 'utf8')}[mcp_servers.evil]\n`);
      expect(third()).toEqual(['config.toml']);
      expect(readFileSync(file, 'utf8')).not.toContain('evil');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps the table of a model typed for an endpoint while a run that uses it is under way, whoever writes the block', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-typed-'));
    const file = join(home, 'config.toml');
    const has = (model: string) => readFileSync(file, 'utf8').includes(`[model."harness-relay/homelab/${model}"]`);
    try {
      // Two runs on the typed model (two members, say), then another run on Grok's own model, which
      // writes the block from the endpoint's own list.
      const first = holdGrokTypedModel(home, 'homelab', 'qwen3:32b');
      const second = holdGrokTypedModel(home, 'homelab', 'qwen3:32b');
      writeGrokModels(home, grokBlockEndpoints(home, [lab]), true);
      writeGrokModels(home, grokBlockEndpoints(home, [lab]), false);
      expect([has('gemma4:e4b'), has('qwen3:32b')]).toEqual([true, true]);
      // Kept until the last of them ends; then the next write leaves it out.
      first();
      first(); // once is enough
      writeGrokModels(home, grokBlockEndpoints(home, [lab]), false);
      expect(has('qwen3:32b')).toBe(true);
      second();
      writeGrokModels(home, grokBlockEndpoints(home, [lab]), false);
      expect([has('gemma4:e4b'), has('qwen3:32b')]).toEqual([true, false]);
      // Only in that home, and only for an endpoint still set up.
      const other = holdGrokTypedModel(join(home, 'elsewhere'), 'homelab', 'llama4');
      const gone = holdGrokTypedModel(home, 'oldlab', 'x');
      expect(grokBlockEndpoints(home, [lab])).toEqual([lab]);
      other();
      gone();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // POSIX paths, file modes or programs: tried on macOS and Linux.
  it.skipIf(process.platform === 'win32')("runs the turn on that model: chosen by Grok's id for it, with no effort and the endpoint's key", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-grok-run-')));
    // A stand-in for `grok agent stdio` (grok 1.0.77's ACP answers, trimmed): each request and the
    // variables it was started with go to the log.
    const bin = join(dir, 'grok');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const log = (o) => fs.appendFileSync(process.env.FAKE_GROK_LOG, JSON.stringify(o) + '\\n');
log({ key: process.env.HARNESS_RELAY_ENDPOINT_API_KEY ?? null, config: fs.readFileSync(process.env.GROK_HOME + '/config.toml', 'utf8') });
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method) log({ method: m.method, params: m.method === 'session/set_config_option' ? m.params : undefined });
  const reply = (result) => out({ id: m.id, result });
  if (m.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: {} });
  if (m.method === 'session/new') return reply({ sessionId: 's-1', configOptions: [{ id: 'model', currentValue: 'grok-4.7' }, { id: 'reasoning_effort', currentValue: 'xhigh' }] });
  if (m.method === 'session/set_config_option') return reply({ configOptions: [] });
  if (m.method === 'session/prompt') {
    out({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } } } });
    return reply({ stopReason: 'end_turn', _meta: { usage: { inputTokens: 3, outputTokens: 1 } } });
  }
});
`,
      { mode: 0o755 },
    );
    const home = join(dir, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'config.toml'), '[models]\ndefault = "grok-4.7"\n');
    const log = join(dir, 'log.jsonl');
    try {
      const text: string[] = [];
      const result = await grokRunner.run({
        bin,
        env: { ...process.env, GROK_HOME: home, FAKE_GROK_LOG: log, HARNESS_RELAY_ENDPOINT_API_KEY: 'from-the-shell' },
        prompt: 'hello',
        systemPrompt: 'briefing',
        cwd: dir,
        permission: 'full',
        model: 'homelab/gemma4:e4b',
        effort: 'xhigh',
        backends: { apis: {}, endpoints: [{ ...lab, apiKey: 'lab-key' }] },
        signal: new AbortController().signal,
        onEvent: (e) => void (e.type === 'text' && text.push(e.text)),
      });
      expect(result).toMatchObject({ sessionId: 's-1', inputTokens: 3, outputTokens: 1 });
      expect(text.join('')).toBe('pong');
      const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
      expect(lines[0]!.key).toBe('lab-key');
      expect(lines[0]!.config).toContain('[model."harness-relay/homelab/gemma4:e4b"]');
      // The model by Grok's id for it, and no effort: Grok takes none for a model it does not know.
      expect(lines.filter((l) => l.method === 'session/set_config_option').map((l) => l.params)).toEqual([
        { sessionId: 's-1', configId: 'model', value: 'harness-relay/homelab/gemma4:e4b' },
      ]);

      // A model typed for the endpoint (Custom…) that its list leaves out gets a table too, for its run,
      // and every write of the block in that home keeps it until the turn is over (here with full
      // access, where Harness Relay's own write is not inside a settings guard).
      const typedLog = join(dir, 'typed.jsonl');
      const during: string[][] = [];
      await grokRunner.run({
        bin,
        env: { ...process.env, GROK_HOME: home, FAKE_GROK_LOG: typedLog },
        prompt: 'hello',
        systemPrompt: 'briefing',
        cwd: dir,
        permission: 'full',
        model: 'homelab/qwen3:32b',
        backends: { apis: {}, endpoints: [{ ...lab, apiKey: 'lab-key' }] },
        signal: new AbortController().signal,
        // What another run in this home would write while this turn streams its reply.
        onEvent: (e) => void (e.type === 'text' && during.push(grokBlockEndpoints(home, [lab])[0]!.models)),
      });
      expect(during.length).toBeGreaterThan(0);
      for (const models of during) expect(models).toContain('qwen3:32b');
      expect(grokBlockEndpoints(home, [lab])[0]!.models).not.toContain('qwen3:32b');
      const typed = readFileSync(typedLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
      expect(typed[0]!.config).toContain('[model."harness-relay/homelab/qwen3:32b"]');
      expect(typed[0]!.config).toContain('[model."harness-relay/homelab/gemma4:e4b"]');
      expect(typed.filter((l) => l.method === 'session/set_config_option').map((l) => l.params.value)).toEqual(['harness-relay/homelab/qwen3:32b']);

      // A model of an endpoint deleted in Settings fails before Grok starts: its id would go to xAI.
      const goneLog = join(dir, 'gone.jsonl');
      await expect(
        withLang('en', () =>
          grokRunner.run({
            bin,
            env: { ...process.env, GROK_HOME: home, FAKE_GROK_LOG: goneLog },
            prompt: 'hello',
            systemPrompt: 'briefing',
            cwd: dir,
            permission: 'full',
            model: 'oldlab/qwen3:32b',
            backends: { apis: {}, endpoints: [{ ...lab, apiKey: 'lab-key' }], deletedEndpoints: ['oldlab'] },
            signal: new AbortController().signal,
            onEvent: () => undefined,
          }),
        ),
      ).rejects.toThrow(/its custom endpoint "oldlab" was deleted/);
      expect(existsSync(goneLog)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Grok's own folder in its sandbox", () => {
  it('denies its programs, the folder of the one Harness Relay starts too', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-programs-'));
    try {
      for (const name of ['bin', 'downloads', 'sessions']) mkdirSync(join(home, name));
      const elsewhere = mkdtempSync(join(tmpdir(), 'relay-grok-bin-'));
      const bin = join(elsewhere, 'grok');
      writeFileSync(bin, '');
      const paths = grokPrograms(home, [bin], 'darwin');
      expect(paths).toEqual(expect.arrayContaining([join(home, 'bin'), join(home, 'downloads'), elsewhere]));
      expect(paths).not.toContain(join(home, 'sessions'));
      // Not on Linux, where Grok runs its program again inside its sandbox: it is checked around each turn there.
      expect(grokPrograms(home, [bin], 'linux')).toEqual([]);
      rmSync(elsewhere, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('puts back its settings when a turn changed them, keeping the changed ones, and reports changed skills', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-settings-'));
    try {
      writeFileSync(join(home, 'config.toml'), '[mine]\n');
      mkdirSync(join(home, 'skills/review'), { recursive: true });
      writeFileSync(join(home, 'skills/review/SKILL.md'), 'review');
      const untouched = snapshotGrokSettings(home);
      expect(restoreGrokSettings(untouched, home)).toEqual([]);

      const before = snapshotGrokSettings(home);
      writeFileSync(join(home, 'config.toml'), '[mcp_servers.evil]\ncommand = "sh"\n');
      writeFileSync(join(home, 'hooks-paths'), '/tmp/evil.sh\n');
      writeFileSync(join(home, 'skills/review/SKILL.md'), 'run this first');
      expect(restoreGrokSettings(before, home, 42)).toEqual(['config.toml', 'hooks-paths', 'skills']);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('[mine]\n');
      expect(readFileSync(join(home, 'config.toml.changed-42'), 'utf8')).toContain('evil');
      // A file that was not there is removed again, kept aside like the others.
      expect(existsSync(join(home, 'hooks-paths'))).toBe(false);
      expect(readFileSync(join(home, 'hooks-paths.changed-42'), 'utf8')).toBe('/tmp/evil.sh\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('takes a link as a link: one made a file, a file made a link, and what a link leads to', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-links-'));
    const dotfiles = mkdtempSync(join(tmpdir(), 'relay-grok-dotfiles-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'relay-grok-elsewhere-'));
    try {
      writeFileSync(join(dotfiles, 'config.toml'), '[mine]\n');
      symlinkSync(join(dotfiles, 'config.toml'), join(home, 'config.toml'));
      writeFileSync(join(home, 'hooks-paths'), '');
      writeFileSync(join(elsewhere, 'shell-rc'), 'mine\n');
      const before = snapshotGrokSettings(home);
      // The link replaced by a file of its own; a file replaced by a link to a file outside.
      rmSync(join(home, 'config.toml'));
      writeFileSync(join(home, 'config.toml'), '[mcp_servers.evil]\n');
      rmSync(join(home, 'hooks-paths'));
      symlinkSync(join(elsewhere, 'shell-rc'), join(home, 'hooks-paths'));
      // A link where the changed copy would go, to a file outside: not followed.
      symlinkSync(join(elsewhere, 'shell-rc'), join(home, 'config.toml.changed-7'));
      expect(restoreGrokSettings(before, home, 7)).toEqual(['config.toml', 'hooks-paths']);
      expect(lstatSync(join(home, 'config.toml')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('[mine]\n');
      expect(lstatSync(join(home, 'hooks-paths')).isFile()).toBe(true);
      expect(readFileSync(join(home, 'hooks-paths'), 'utf8')).toBe('');
      expect(readFileSync(join(elsewhere, 'shell-rc'), 'utf8')).toBe('mine\n');

      // Only what the link leads to changed: written as it was, the changed one kept beside the link.
      const again = snapshotGrokSettings(home);
      writeFileSync(join(dotfiles, 'config.toml'), '[mcp_servers.evil]\n');
      expect(restoreGrokSettings(again, home, 8)).toEqual(['config.toml']);
      expect(readFileSync(join(dotfiles, 'config.toml'), 'utf8')).toBe('[mine]\n');
      expect(readFileSync(join(home, 'config.toml.changed-8'), 'utf8')).toContain('evil');
    } finally {
      for (const d of [home, dotfiles, elsewhere]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('puts back the others when one was made a folder, and does not read a file grown large', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-folder-'));
    try {
      writeFileSync(join(home, 'config.toml'), '[mine]\n');
      writeFileSync(join(home, 'requirements.toml'), '');
      const before = snapshotGrokSettings(home);
      rmSync(join(home, 'config.toml'));
      mkdirSync(join(home, 'config.toml'));
      writeFileSync(join(home, 'requirements.toml'), 'x'.repeat(1 << 16));
      writeFileSync(join(home, 'trusted_folders.toml'), '[folders."/"]\ntrusted = true\n');
      expect(restoreGrokSettings(before, home, 9)).toEqual(['config.toml', 'requirements.toml', 'trusted_folders.toml']);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('[mine]\n');
      expect(lstatSync(join(home, 'config.toml.changed-9')).isDirectory()).toBe(true);
      expect(readFileSync(join(home, 'requirements.toml'), 'utf8')).toBe('');
      expect(existsSync(join(home, 'trusted_folders.toml'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('takes an empty file for none, as Grok\'s sandbox makes its settings files empty when they are not there', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-empty-'));
    try {
      writeFileSync(join(home, 'config.toml'), '[mine]\n');
      const before = snapshotGrokSettings(home);
      for (const name of ['managed_config.toml', 'requirements.toml', 'trusted_folders.toml', 'hooks-paths']) writeFileSync(join(home, name), '');
      expect(restoreGrokSettings(before, home)).toEqual([]);
      expect(existsSync(join(home, 'hooks-paths'))).toBe(true);
      // Emptying one that held settings is a change.
      writeFileSync(join(home, 'config.toml'), '');
      expect(restoreGrokSettings(before, home, 11)).toEqual(['config.toml']);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('[mine]\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("takes sandbox.toml without Harness Relay's own block, which each run writes again", () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-profile-guard-'));
    try {
      writeGrokProfile(home, ['/a']);
      const before = snapshotGrokSettings(home);
      writeGrokProfile(home, ['/a', '/b']);
      expect(restoreGrokSettings(before, home)).toEqual([]);
      // A line after the block would belong to its table: a change, put back.
      writeFileSync(join(home, 'sandbox.toml'), `${readFileSync(join(home, 'sandbox.toml'), 'utf8')}read_write = ["/"]\n`);
      expect(restoreGrokSettings(before, home, 10)).toEqual(['sandbox.toml']);
      expect(readFileSync(join(home, 'sandbox.toml'), 'utf8')).not.toContain('read_write');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('shares what the settings were among turns at the same time, so a later one neither takes nor keeps a change', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-guard-'));
    try {
      writeFileSync(join(home, 'config.toml'), '[mine]\n');
      const first = guardGrokSettings(home);
      // A command of the first turn changes the settings; a second turn starts meanwhile.
      writeFileSync(join(home, 'config.toml'), '[mcp_servers.evil]\n');
      const second = guardGrokSettings(home);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('[mine]\n');
      expect(first()).toEqual(['config.toml']);
      expect(second()).toEqual([]);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('[mine]\n');
      // Once none is running, the next turn starts from the settings as they are.
      writeFileSync(join(home, 'config.toml'), '[mine, changed by the user]\n');
      const third = guardGrokSettings(home);
      expect(third()).toEqual([]);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('[mine, changed by the user]\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps a later turn's own folder profile after putting back what an earlier turn's command changed, also when its write failed", () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-guard-own-'));
    try {
      const first = guardGrokSettings(home, () => void writeGrokProfile(home, ['/deny'], [], 'harness-relay'));
      // A command of the first turn changes sandbox.toml; a turn of another conversation, with another
      // working directory, starts meanwhile: the change is put back, and its own profile written.
      appendFileSync(join(home, 'sandbox.toml'), '\n# a command changed this\n');
      const other = grokSandboxProfile('edit', 'darwin', ['/other'])!;
      const second = guardGrokSettings(home, () => void writeGrokProfile(home, ['/deny'], ['/other'], other, new Set([other])));
      expect(readFileSync(join(home, 'sandbox.toml'), 'utf8')).toContain(other);
      // The first turn's change is named; the second turn's profile is Harness Relay's, not a change.
      expect(first()).toEqual(['sandbox.toml']);
      expect(readFileSync(join(home, 'sandbox.toml'), 'utf8')).toContain(other);
      expect(second()).toEqual([]);
      // A turn whose write fails part way (its endpoints' models, after its profile): what it wrote is
      // still Harness Relay's, so a turn running beside it is not told of a change it did not make.
      const third = guardGrokSettings(home, () => void writeGrokProfile(home, ['/deny'], [], 'harness-relay'));
      const another = grokSandboxProfile('edit', 'darwin', ['/another'])!;
      expect(() =>
        guardGrokSettings(home, () => {
          writeGrokProfile(home, ['/deny'], ['/another'], another, new Set([another]));
          throw new Error('config.toml could not be written');
        }),
      ).toThrow('config.toml could not be written');
      expect(third()).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is one of the run's own for the other working directories it may write, named after them", () => {
    const one = grokSandboxProfile('edit', 'darwin', ['/docs', '/infra']);
    expect(one).toMatch(/^harness-relay-[0-9a-f]{12}$/);
    // The same folders in another order: the same profile; other folders, another.
    expect(grokSandboxProfile('read-only', 'linux', ['/infra', '/docs'])).toBe(one);
    expect(grokSandboxProfile('edit', 'darwin', ['/docs'])).not.toBe(one);
    expect(grokSandboxProfile('full', 'darwin', ['/docs'])).toBeUndefined();
    expect(grokSandboxProfile('edit', 'win32', ['/docs'])).toBe('workspace');
    expect(isRelayProfile(one)).toBe(true);
    expect(isRelayProfile('harness-relay')).toBe(true);
    expect(isRelayProfile('workspace')).toBe(false);
    expect(isRelayProfile('harness-relay-mine')).toBe(false);
    // Named after the folders, also by their real paths (on Windows `/docs` is on a drive: C:\docs).
    const named = process.platform === 'win32' ? grokSandboxProfile('edit', 'linux', grokReadWrite(['/docs', '/infra'])) : one;
    expect(grokEnv({ env: {}, permission: 'edit', addDirs: ['/docs', '/infra'] }, 'linux').GROK_SANDBOX).toBe(named);
    // Each folder also by its real path.
    const real = realpathSync(tmpdir());
    expect(grokReadWrite([tmpdir()])).toEqual(real === tmpdir() ? [tmpdir()] : [tmpdir(), real]);

    const block = grokProfileBlock(['/x'], ['/docs'], one);
    expect(block).toContain(`[profiles.${one}]\nextends = "workspace"\nread_write = ["/docs"]\ndeny = ["/x"]\n# <<< ${one}`);
    // Beside the main profile and the user's own, each replaced in place.
    const user = '[profiles.mine]\nextends = "strict"\n';
    const both = withGrokProfile(withGrokProfile(user, grokProfileBlock(['/x'])), block, one);
    expect(both.startsWith(user)).toBe(true);
    expect(both).toContain('[profiles.harness-relay]\n');
    expect(both).toContain(`[profiles.${one}]\n`);
    const again = withGrokProfile(withGrokProfile(both, grokProfileBlock(['/y'])), grokProfileBlock(['/y'], ['/docs'], one), one);
    expect(again.match(/\[profiles\.harness-relay/g)).toHaveLength(2);
    expect(again).not.toContain('"/x"');
  });

  it('keeps only the latest profiles of runs\' own folders', () => {
    const names = Array.from({ length: MAX_FOLDER_PROFILES + 3 }, (_, i) => grokSandboxProfile('edit', 'linux', [`/f${i}`])!);
    let file = '[profiles.mine]\nextends = "strict"\n';
    for (const [i, name] of names.entries()) file = withGrokProfile(file, grokProfileBlock(['/x'], [`/f${i}`], name), name);
    const kept = names.filter((name) => file.includes(`[profiles.${name}]`));
    expect(kept).toEqual(names.slice(3));
    expect(file.startsWith('[profiles.mine]')).toBe(true);
    // Written again, one stays where it is.
    expect(withGrokProfile(file, grokProfileBlock(['/x'], ['/f5'], names[5]!), names[5]!)).toBe(file);
    // One that a running turn uses is never dropped: the next earliest goes in its place.
    const extra = grokSandboxProfile('edit', 'linux', ['/one-more'])!;
    const held = withGrokProfile(file, grokProfileBlock(['/x'], ['/one-more'], extra), extra, new Set([names[3]!]));
    expect(held).toContain(`[profiles.${names[3]}]`);
    expect(held).not.toContain(`[profiles.${names[4]}]`);
    expect(held).toContain(`[profiles.${extra}]`);
  });

  it('knows which profiles turns now running use, each until its last turn ends', () => {
    const name = grokSandboxProfile('edit', 'linux', ['/held'])!;
    const first = holdGrokProfile(name);
    const second = holdGrokProfile(name);
    expect(grokProfilesInUse().has(name)).toBe(true);
    first();
    first(); // once only
    expect(grokProfilesInUse().has(name)).toBe(true);
    second();
    expect(grokProfilesInUse().has(name)).toBe(false);
  });

  it("takes another conversation's profile written during a turn as Harness Relay's, not as a command's change", () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-folders-'));
    try {
      const a = grokSandboxProfile('edit', 'linux', ['/a'])!;
      const b = grokSandboxProfile('edit', 'linux', ['/b'])!;
      const first = guardGrokSettings(home, () => writeGrokProfile(home, ['/x'], ['/a'], a));
      const second = guardGrokSettings(home, () => writeGrokProfile(home, ['/x'], ['/b'], b));
      expect(readFileSync(join(home, 'sandbox.toml'), 'utf8')).toContain(`[profiles.${b}]`);
      expect(first()).toEqual([]);
      expect(readFileSync(join(home, 'sandbox.toml'), 'utf8')).toContain(`[profiles.${b}]`);
      // A command that writes into a profile's block is still caught, and put back.
      const file = join(home, 'sandbox.toml');
      writeFileSync(file, readFileSync(file, 'utf8').replace('read_write = ["/b"]', 'read_write = ["/"]'));
      expect(second()).toEqual(['sandbox.toml']);
      expect(readFileSync(file, 'utf8')).toContain('read_write = ["/b"]');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'starts Grok in the profile of the run\'s own folders, written into its home first, and lets it go after the turn',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'relay-grok-run-'));
      try {
        const home = join(dir, 'home');
        const extra = join(dir, 'extra');
        mkdirSync(home);
        mkdirSync(extra);
        // A stand-in Grok: notes the profile it was started in, then ends without a turn.
        const bin = join(dir, 'grok');
        writeFileSync(
          bin,
          `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(dir, 'started.json'))}, JSON.stringify({ sandbox: process.env.GROK_SANDBOX }));\nprocess.exit(1);\n`,
          { mode: 0o755 },
        );
        const run = grokRunner.run({
          bin,
          env: { ...process.env, GROK_HOME: home },
          prompt: 'go',
          systemPrompt: 'You are @Gus',
          cwd: dir,
          addDirs: [extra],
          permission: 'edit',
          protectedPaths: ['/nowhere/protected'],
          signal: new AbortController().signal,
          onEvent: () => {},
        });
        await expect(run).rejects.toThrow();
        const name = grokSandboxProfile('edit', process.platform, grokReadWrite([extra]))!;
        expect(JSON.parse(readFileSync(join(dir, 'started.json'), 'utf8'))).toEqual({ sandbox: name });
        const written = readFileSync(join(home, 'sandbox.toml'), 'utf8');
        expect(written).toContain(`[profiles.${name}]`);
        expect(written).toContain(`read_write = [${grokReadWrite([extra]).map((d) => JSON.stringify(d)).join(', ')}]`);
        expect(grokProfilesInUse().has(name)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('writes no read-only list: its read_only grants reading, it does not stop writing', () => {
    expect(grokProfileBlock(['/x'])).not.toContain('read_only');
  });
});

describe("Harness Relay's own changes to Grok's settings", () => {
  it('are kept by the turns running when it makes them (trusting a folder)', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-trust-'));
    try {
      writeFileSync(join(home, 'trusted_folders.toml'), '[old]\n');
      const end = guardGrokSettings(home);
      writeGrokSetting(home, 'trusted_folders.toml', () => {
        writeFileSync(join(home, 'trusted_folders.toml'), '[old]\n[new]\n');
        return '[old]\n[new]\n';
      });
      expect(end()).toEqual([]);
      expect(readFileSync(join(home, 'trusted_folders.toml'), 'utf8')).toBe('[old]\n[new]\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("start from the settings as the running turns found them, and keep only what Harness Relay wrote", () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-grok-trust-race-'));
    const file = join(home, 'trusted_folders.toml');
    try {
      writeFileSync(file, '[old]\n');
      const end = guardGrokSettings(home);
      // A command of the turn trusts a folder of its own before the user trusts one.
      writeFileSync(file, '[old]\n[agent]\n');
      let found = '';
      writeGrokSetting(home, 'trusted_folders.toml', () => {
        found = readFileSync(file, 'utf8');
        writeFileSync(file, `${found}[user]\n`);
        return `${found}[user]\n`;
      });
      expect(found).toBe('[old]\n');
      // And changes it again right after: put back to what Harness Relay wrote, and named.
      writeFileSync(file, '[old]\n[user]\n[agent]\n');
      expect(end()).toEqual(['trusted_folders.toml']);
      expect(readFileSync(file, 'utf8')).toBe('[old]\n[user]\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// The guard runs on Linux alone (grokEnv); its links are POSIX links, made and read as Linux does.
describe.skipIf(process.platform === 'win32')("Grok's program on Linux", () => {
  function home() {
    const h = realpathSync(mkdtempSync(join(tmpdir(), 'relay-grok-prog-')));
    mkdirSync(join(h, 'bin'));
    mkdirSync(join(h, 'downloads'));
    writeFileSync(join(h, 'downloads/grok-1.0'), 'the real grok', { mode: 0o755 });
    symlinkSync('../downloads/grok-1.0', join(h, 'bin/grok'));
    return h;
  }

  it('is not denied there (Grok starts its sandbox by running it again)', () => {
    const h = home();
    try {
      expect(grokPrograms(h, [join(h, 'bin/grok')], 'linux')).toEqual([]);
      expect(grokPrograms(h, [join(h, 'bin/grok')], 'darwin')).toContain(join(h, 'downloads'));
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('is put back from the kept copy when a turn changed the file or the link', () => {
    const h = home();
    const keep = join(h, 'keep');
    try {
      const trusted = readGrokProgram(h, [join(h, 'bin/grok')], keep);
      expect(restoreGrokProgram(trusted)).toEqual([]);
      writeFileSync(join(h, 'downloads/grok-1.0'), 'evil');
      rmSync(join(h, 'bin/grok'));
      symlinkSync('/tmp/evil', join(h, 'bin/grok'));
      expect(restoreGrokProgram(trusted, 7).sort()).toEqual(['bin/grok', 'grok-1.0']);
      expect(readFileSync(join(h, 'downloads/grok-1.0'), 'utf8')).toBe('the real grok');
      expect(readFileSync(join(h, 'downloads/grok-1.0.changed-7'), 'utf8')).toBe('evil');
      expect(readFileSync(join(h, 'bin/grok'), 'utf8')).toBe('the real grok');
      expect(lstatSync(join(h, 'downloads/grok-1.0')).mode & 0o777).toBe(0o755);
      // As put back, it is what is trusted now.
      expect(restoreGrokProgram(trusted)).toEqual([]);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it('is put back before another turn starts it while turns run, and taken as it is between turns', () => {
    const h = home();
    try {
      const endA = guardGrokProgram(h, [join(h, 'bin/grok')], join(h, 'keep'));
      writeFileSync(join(h, 'downloads/grok-1.0'), 'evil');
      const endB = guardGrokProgram(h, [join(h, 'bin/grok')], join(h, 'keep'));
      expect(readFileSync(join(h, 'downloads/grok-1.0'), 'utf8')).toBe('the real grok');
      expect(endB()).toEqual(['grok-1.0']);
      expect(endA()).toEqual([]);
      // No turn running: an update between turns is the user's.
      writeFileSync(join(h, 'downloads/grok-1.0'), 'grok 1.1');
      const endC = guardGrokProgram(h, [join(h, 'bin/grok')], join(h, 'keep'));
      expect(endC()).toEqual([]);
      expect(readFileSync(join(h, 'downloads/grok-1.0'), 'utf8')).toBe('grok 1.1');
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});
