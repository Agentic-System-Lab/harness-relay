import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  codexApprovalRequest,
  codexApprovalResponse,
  codexConfig,
  codexElicitationResponse,
  codexMcpToolApproval,
  codexConfiguredMcpServers,
  codexConfirmLeftOut,
  codexNativeConfig,
  codexRunner,
  isUnknownMethod,
  codexOverrideArgs,
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
    // Its hooks (plugins' too) and its plugins, each with its feature switch.
    expect(codexNativeConfig(['hooks', 'plugins'])).toEqual({ 'features.hooks': false, 'features.plugins': false });
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
    await expect(failure).rejects.toThrow(/^Codex still loaded its hooks and plugins although they are left out of this run/);
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
      /^Could not check that Codex left out the hooks or plugins this run leaves out \(thread not loaded\)/,
    );
  });

  it('reads the configured MCP servers from config/read', () => {
    expect(codexConfiguredMcpServers({ config: { mcp_servers: { headroom: {}, node_repl: {} } } })).toEqual(['headroom', 'node_repl']);
    expect(codexConfiguredMcpServers({ config: {} })).toEqual([]);
    expect(codexConfiguredMcpServers(undefined)).toEqual([]);
  });
});

describe('a Codex run that leaves out hooks and plugins (stand-in codex app-server)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-codex-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Answers like codex-cli 0.167.0's app-server. FAKE_CODEX_IGNORE plays a Codex that ignores the
  // two keys; FAKE_CODEX_SLOW answers hooks/list after two seconds. Each request goes to the log.
  const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const log = (o) => fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(o) + '\\n');
const args = process.argv.slice(2);
log({ args });
const set = []; for (let i = 0; i < args.length; i++) if (args[i] === '-c') set.push(args[++i]);
const off = (key) => !process.env.FAKE_CODEX_IGNORE && set.includes(key + '=false');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  log({ method: m.method });
  const reply = (result) => out({ id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({});
    case 'thread/start': return reply({ thread: { id: 'thr-1' } });
    case 'hooks/list': {
      const r = { data: [{ hooks: off('features.hooks') ? [] : [{ key: 'h', eventName: 'stop', enabled: true }] }] };
      return process.env.FAKE_CODEX_SLOW ? setTimeout(() => reply(r), 2000) : reply(r);
    }
    case 'plugin/installed':
      return reply({ marketplaces: [{ name: 'm', plugins: off('features.plugins') ? [] : [{ id: 'deck@m', installed: true, enabled: true }] }] });
    case 'turn/start':
      reply({ turn: { id: 'turn-1' } });
      return out({ method: 'turn/completed', params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'completed' } } });
    default:
      return out({ id: m.id, error: { code: -32600, message: 'Invalid request: unknown variant ' + m.method } });
  }
});
`;
  const bin = join(dir, 'codex');
  writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
  let n = 0;
  function run(extra: Record<string, string> = {}, signal = new AbortController().signal) {
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
      }),
    );
    const lines = () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args?: string[]; method?: string });
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
    await expect(r.result).rejects.toThrow(/^Codex still loaded its hooks and plugins although they are left out of this run/);
    expect(r.methods()).not.toContain('turn/start');
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
