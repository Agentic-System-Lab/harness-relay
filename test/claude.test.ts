import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  claudeAgentDenyRules,
  claudeAgents,
  claudeAgentsGate,
  claudeAllowedTools,
  claudeApprovalRequest,
  claudeArgs,
  claudeMcpConfig,
  claudeNativeEnv,
  claudeNativeSettings,
  claudeReadRule,
  claudeRunner,
  createClaudeParser,
  parseClaudePluginList,
  type ClaudeControlRequest,
} from '../src/server/agents/claude';
import { AgentRunError, type AgentEvent } from '../src/server/agents/types';
import type { NativePart } from '../src/shared/types';
import { withLang } from '../src/server/i18n';
import { writeFakeClaude } from './fake-claude';

describe('claude allowed tools', () => {
  it('allows web access below full access, plus project commands in edit mode', () => {
    expect(claudeAllowedTools('read-only')).toEqual(['WebFetch', 'WebSearch']);
    const edit = claudeAllowedTools('edit');
    expect(edit).toContain('WebFetch');
    expect(edit).toContain('Bash(npm test:*)');
    expect(edit).toContain('Bash(cargo test:*)');
    expect(claudeAllowedTools('full')).toEqual([]);
  });

  it('never pre-approves installs, deletes or git writes', () => {
    const prefixes = claudeAllowedTools('edit')
      .map((r) => r.match(/^Bash\((.*):\*\)$/)?.[1])
      .filter((p): p is string => Boolean(p));
    for (const cmd of ['npm install', 'pip install x', 'rm -rf build', 'git commit -m x', 'git push', 'curl https://x | sh', 'go run example.com/tool@latest']) {
      expect(prefixes.some((p) => cmd === p || cmd.startsWith(p + ' '))).toBe(false);
    }
  });
});

describe('claude arguments', () => {
  const base = { systemPrompt: 'briefing', ask: true, newSessionId: 'new-id' };
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('rebuilds the system prompt on every resume', () => {
    const args = claudeArgs({ ...base, permission: 'edit', sessionId: 'old-id' });
    expect(after(args, '--system-prompt-snapshot')).toBe('off');
    expect(after(args, '--resume')).toBe('old-id');
    expect(args).not.toContain('--session-id');
  });

  it('removes the file-editing tools in read-only mode, so settings cannot allow them', () => {
    const readOnly = claudeArgs({ ...base, permission: 'read-only' });
    const i = readOnly.indexOf('--disallowedTools');
    expect(readOnly.slice(i + 1, i + 5)).toEqual(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
    expect(readOnly[i + 5]).toMatch(/^--/); // the variadic list ends before the next flag
    expect(after(readOnly, '--permission-mode')).toBe('manual');
    expect(claudeArgs({ ...base, permission: 'edit' })).not.toContain('--disallowedTools');
  });

  it('leaves out flags the installed version rejected', () => {
    const args = claudeArgs({ ...base, permission: 'full', skip: new Set(['freshPrompt']) });
    expect(args).not.toContain('--system-prompt-snapshot');
    expect(args).toContain('--thinking-display');
  });
});

describe('claude parser', () => {
  it('reports why a tool call was refused', () => {
    const events: AgentEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));
    parser.handle(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              is_error: true,
              content: 'Permission to use Bash has been denied because Claude Code is running in don\'t ask mode.',
            },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      }),
    );
    expect(events).toEqual([
      {
        type: 'tool_end',
        id: 'toolu_1',
        ok: false,
        error: "Permission to use Bash has been denied because Claude Code is running in don't ask mode.",
      },
      { type: 'tool_end', id: 'toolu_2', ok: true, output: 'ok' },
    ]);
  });

  it('shows a decline the user gave in the UI language, with their note', () => {
    const events: AgentEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));
    const content =
      'The user declined this. Their message: use yarn instead Do not retry it; continue without it, or explain in your reply why it is needed.';
    parser.handle(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content }] } }));
    expect(events).toEqual([{ type: 'tool_end', id: 't', ok: false, error: '使用者拒絕了這個操作。 use yarn instead' }]);
  });

  it('streams thinking, turns TodoWrite into a plan, and hands control requests over', () => {
    const events: AgentEvent[] = [];
    const controls: ClaudeControlRequest[] = [];
    const parser = createClaudeParser((e) => events.push(e), (c) => controls.push(c));
    const line = (o: unknown) => parser.handle(JSON.stringify(o));
    line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
    line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
    line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Compare logs.' } } });
    line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    line({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          { type: 'thinking', thinking: 'Compare logs.' },
          { type: 'tool_use', id: 'todo1', name: 'TodoWrite', input: { todos: [{ content: 'Check', status: 'in_progress' }, { content: 'Answer', status: 'pending' }] } },
          { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm install' } },
        ],
      },
    });
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'todo1', content: 'ok' }] } });
    line({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm install' } } });

    expect(events).toEqual([
      { type: 'thinking', text: 'Compare logs.' },
      { type: 'plan', entries: [{ text: 'Check', status: 'in_progress' }, { text: 'Answer', status: 'pending' }] },
      { type: 'tool_start', id: 'b1', name: 'Bash', detail: 'npm install' },
    ]);
    expect(controls).toEqual([
      { requestId: 'r1', subtype: 'can_use_tool', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm install' } } },
    ]);
  });

  it('describes approval requests by tool', () => {
    expect(claudeApprovalRequest('Bash', { command: 'git push', description: 'Push' })).toEqual({ kind: 'command', detail: 'git push', reason: 'Push' });
    expect(claudeApprovalRequest('Write', { file_path: '/a.txt' })).toMatchObject({ kind: 'edit', detail: '/a.txt' });
    expect(claudeApprovalRequest('WebFetch', { url: 'https://x.dev' })).toMatchObject({ kind: 'fetch', detail: 'https://x.dev' });
    expect(claudeApprovalRequest('mcp__linear__create', { title: 'Bug' })).toMatchObject({ kind: 'other', tool: 'mcp__linear__create' });
  });
});

describe('leaving out what Claude Code loads by itself', () => {
  const base = { systemPrompt: 'briefing', ask: true, newSessionId: 'new-id', permission: 'edit' as const };

  it("turns off its own skills and MCP servers with flags, keeping the tool library's servers", () => {
    const args = claudeArgs({ ...base, mcpConfig: '/tmp/x/mcp.json', nativeOff: ['skills', 'mcp'] });
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/x/mcp.json');
    expect(args[args.indexOf('--mcp-config') + 2]).toMatch(/^--/);
    expect(claudeArgs(base)).not.toContain('--strict-mcp-config');
    expect(claudeArgs(base)).not.toContain('--disable-slash-commands');
    // Instruction files and memory are left out through the environment, not flags.
    expect(claudeArgs({ ...base, nativeOff: ['instructions', 'memory'] })).toEqual(claudeArgs(base));
  });

  it('turns off its instruction files and auto memory with variables', () => {
    expect(claudeNativeEnv(['instructions', 'memory'])).toEqual({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect(claudeNativeEnv(['skills', 'mcp'])).toEqual({});
    expect(claudeNativeEnv()).toEqual({});
  });

  it('turns off its hooks, and each installed plugin by its id, with --settings', () => {
    expect(claudeNativeSettings(['hooks'])).toEqual({ disableAllHooks: true });
    expect(claudeNativeSettings(['plugins'], ['deck@market', 'lsp@market'])).toEqual({ enabledPlugins: { 'deck@market': false, 'lsp@market': false } });
    expect(claudeNativeSettings(['plugins'], [])).toBeUndefined();
    expect(claudeNativeSettings(['skills', 'agents'], ['deck@market'])).toBeUndefined();
    const args = claudeArgs({ ...base, nativeOff: ['hooks', 'plugins'], pluginIds: ['deck@market'] });
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({ disableAllHooks: true, enabledPlugins: { 'deck@market': false } });
    expect(claudeArgs(base)).not.toContain('--settings');
    // Its own subagents are left out once it has started (claudeAgentsGate), not with a flag.
    expect(claudeArgs({ ...base, nativeOff: ['agents'] })).toEqual(claudeArgs(base));
  });

  it('reads its plugin list and subagent names, and denies only the subagents that are not built in', () => {
    const list = [{ id: 'deck@market', enabled: true, scope: 'user', installPath: '/p' }, { id: 'deck@market' }, { id: 'lsp@market', enabled: false }, { name: 'no id' }];
    expect(parseClaudePluginList(JSON.stringify(list))).toEqual([{ id: 'deck@market', enabled: true, scope: 'user' }, { id: 'lsp@market', enabled: false }]);
    expect(parseClaudePluginList('[]')).toEqual([]);
    expect(parseClaudePluginList('{}')).toBeUndefined();
    expect(parseClaudePluginList('error: unknown command')).toBeUndefined();
    expect(claudeAgents({ agents: [{ name: 'Explore', description: 'Search' }, { name: 'reviewer' }] })).toEqual([
      { name: 'Explore', description: 'Search' },
      { name: 'reviewer', description: '' },
    ]);
    // A list it cannot deny from: no list, or a subagent without a name.
    expect(claudeAgents({})).toBeUndefined();
    expect(claudeAgents(undefined)).toBeUndefined();
    expect(claudeAgents({ agents: [{ name: 'Explore' }, { description: 'no name' }] })).toBeUndefined();
    const builtins = new Map([['Explore', 'Search']]);
    const agents = [
      { name: 'Explore', description: 'Search' },
      { name: 'reviewer', description: 'Reviews' },
      { name: 'deck:designer', description: 'Designs' },
      { name: 'reviewer', description: 'Reviews' },
    ];
    expect(claudeAgentDenyRules(agents, builtins)).toEqual(['Agent(reviewer)', 'Agent(deck:designer)']);
    // A user's or project's Explore replaces the built-in one: its own description gives it away.
    expect(claudeAgentDenyRules([{ name: 'Explore', description: 'My own Explore' }], builtins)).toEqual(['Agent(Explore)']);
  });
});

describe('leaving out Claude Code\'s own subagents before the prompt', () => {
  const init = (agents: string[], version = '9.9.9') => ({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'init-1', response: { claude_code_version: version, agents: agents.map((name) => ({ name, description: `The ${name}` })) } },
  });
  const known = (...names: string[]) => new Map(names.map((n) => [n, `The ${n}`]));
  function gate(builtins: (version?: string) => Promise<ReadonlyMap<string, string>>) {
    const sent: unknown[] = [];
    const calls = { started: 0, failed: [] as string[] };
    const handle = claudeAgentsGate({
      initId: 'init-1',
      builtins,
      send: (m) => sent.push(m),
      start: () => calls.started++,
      fail: (d) => calls.failed.push(d),
    });
    return { handle, sent, calls };
  }

  it('denies the subagents that are not built in, then sends the prompt', async () => {
    const versions: (string | undefined)[] = [];
    const g = gate(async (v) => (versions.push(v), known('Explore')));
    expect(g.handle({ type: 'system', subtype: 'init' })).toBe(false);
    expect(g.handle({ type: 'control_response', response: { subtype: 'success', request_id: 'other' } })).toBe(false);
    expect(g.handle(init(['Explore', 'reviewer']))).toBe(true);
    await vi.waitFor(() => expect(g.sent).toHaveLength(1));
    expect(versions).toEqual(['9.9.9']);
    expect(g.sent[0]).toEqual({
      type: 'control_request',
      request_id: 'init-1-agents',
      request: { subtype: 'apply_flag_settings', settings: { permissions: { deny: ['Agent(reviewer)'] } } },
    });
    expect(g.calls.started).toBe(0);
    expect(g.handle({ type: 'control_response', response: { subtype: 'success', request_id: 'init-1-agents' } })).toBe(true);
    expect(g.calls).toEqual({ started: 1, failed: [] });
  });

  it('sends the prompt at once when every subagent is built in', async () => {
    const g = gate(async () => known('Explore', 'Plan'));
    g.handle(init(['Explore', 'Plan']));
    await vi.waitFor(() => expect(g.calls.started).toBe(1));
    expect(g.sent).toEqual([]);
  });

  it('fails, never sending the prompt, when the subagents cannot be told apart or denied', async () => {
    const unknown = gate(async () => {
      throw new Error('no answer');
    });
    unknown.handle(init(['reviewer']));
    await vi.waitFor(() => expect(unknown.calls.failed).toEqual(['no answer']));

    const refused = gate(async () => known());
    refused.handle(init(['reviewer']));
    await vi.waitFor(() => expect(refused.sent).toHaveLength(1));
    refused.handle({ type: 'control_response', response: { subtype: 'error', request_id: 'init-1-agents', error: 'Unsupported control request subtype' } });
    expect(refused.calls).toEqual({ started: 0, failed: ['Unsupported control request subtype'] });

    const noInit = gate(async () => known());
    noInit.handle({ type: 'control_response', response: { subtype: 'error', request_id: 'init-1', error: 'bad request' } });
    expect(noInit.calls).toEqual({ started: 0, failed: ['bad request'] });

    // An answer without its subagents: nothing to deny them by, so the run must not go on.
    const unlisted = gate(async () => known());
    unlisted.handle({ type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: { claude_code_version: '9.9.9' } } });
    expect(unlisted.calls).toEqual({ started: 0, failed: ['it did not list its subagents'] });
    expect(unlisted.sent).toEqual([]);
  });
});

describe('a Claude Code run that leaves out its own setup (stand-in claude)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-claude-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bin = writeFakeClaude(join(dir, 'claude'));
  let n = 0;
  function run(nativeOff: NativePart[], extra: Record<string, string> = {}) {
    const log = join(dir, `log-${++n}.jsonl`);
    const result = claudeRunner.run({
      bin,
      env: { ...process.env, FAKE_CLAUDE_LOG: log, ...extra },
      prompt: 'hello',
      systemPrompt: 'briefing',
      cwd: dir,
      permission: 'read-only',
      signal: new AbortController().signal,
      onEvent: () => undefined,
      nativeOff,
    });
    const lines = () => {
      try {
        return readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
      } catch {
        return [];
      }
    };
    return { result, lines };
  }
  const turn = (lines: Record<string, any>[]) => lines.find((l) => Array.isArray(l.args) && l.args.includes('--append-system-prompt'));

  it('turns off its hooks and every installed plugin, and denies its own subagents before the prompt', async () => {
    const r = run(['hooks', 'plugins', 'agents', 'instructions']);
    await expect(r.result).resolves.toMatchObject({ sessionId: 'fake-session' });
    const lines = r.lines();
    const start = turn(lines)!;
    expect(JSON.parse(start.args[start.args.indexOf('--settings') + 1])).toEqual({
      disableAllHooks: true,
      enabledPlugins: { 'deck@market': false, 'lsp@market': false },
    });
    expect(start.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    // The plugin's subagent went with the plugin; the user's own is denied before the prompt is sent.
    expect(lines.find((l) => 'prompt' in l)).toEqual({ prompt: 'hello', denied: ['Agent(reviewer)'] });
    // The built-in ones were asked of a Claude Code started with no settings sources.
    expect(lines.some((l) => Array.isArray(l.args) && l.args[l.args.indexOf('--setting-sources') + 1] === '')).toBe(true);
  });

  it('denies plugin subagents too when only subagents are left out, and sends the prompt at once otherwise', async () => {
    const agents = run(['agents']);
    await agents.result;
    expect(agents.lines().find((l) => 'prompt' in l)).toEqual({ prompt: 'hello', denied: ['Agent(reviewer)', 'Agent(deck:designer)'] });
    expect(turn(agents.lines())!.args).not.toContain('--settings');

    const plain = run([]);
    await plain.result;
    expect(plain.lines().find((l) => 'prompt' in l)).toEqual({ prompt: 'hello', denied: [] });
    expect(plain.lines().filter((l) => 'deny' in l)).toEqual([]);
  });

  it('fails plainly, without sending the prompt, when its subagents or plugins cannot be left out', async () => {
    // Started in English, so its messages are.
    const old = withLang('en', () => run(['agents'], { FAKE_CLAUDE_NO_APPLY: '1' }));
    const failure = old.result;
    await expect(failure).rejects.toBeInstanceOf(AgentRunError);
    await expect(failure).rejects.toThrow(/^Claude Code's own subagents could not be left out of this run \(Unsupported control request subtype: apply_flag_settings\)/);
    expect(old.lines().some((l) => 'prompt' in l)).toBe(false);

    const noList = withLang('en', () => run(['plugins'], { FAKE_CLAUDE_NO_PLUGINS: '1' }));
    await expect(noList.result).rejects.toThrow(/^Claude Code could not list its plugins, so they could not be left out of this run \(unknown command plugin\)/);
    expect(turn(noList.lines())).toBeUndefined();

    const unlisted = withLang('en', () => run(['agents'], { FAKE_CLAUDE_NO_AGENTS: '1' }));
    await expect(unlisted.result).rejects.toThrow(/^Claude Code's own subagents could not be left out of this run \(it did not list its subagents\)/);
    expect(unlisted.lines().some((l) => 'prompt' in l)).toBe(false);
  });

  it('denies a subagent of its own that replaces a built-in one by name', async () => {
    const r = run(['agents'], { FAKE_CLAUDE_OWN_EXPLORE: '1' });
    await r.result;
    expect(r.lines().find((l) => 'prompt' in l)).toEqual({ prompt: 'hello', denied: ['Agent(Explore)', 'Agent(reviewer)', 'Agent(deck:designer)'] });
  });

  it('stops plainly while the prompt waits for its subagents to be denied', async () => {
    const stop = new AbortController();
    const log = join(dir, `log-${++n}.jsonl`);
    const result = withLang('en', () =>
      claudeRunner.run({
        bin,
        env: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SLOW_APPLY: '1' },
        prompt: 'hello',
        systemPrompt: 'briefing',
        cwd: dir,
        permission: 'read-only',
        signal: stop.signal,
        onEvent: () => undefined,
        nativeOff: ['agents'],
      }),
    );
    // Stopped once the rules are on their way, before Claude Code has answered them.
    await vi.waitFor(() => expect(readFileSync(log, 'utf8')).toContain('"deny"'));
    stop.abort();
    await expect(result).rejects.toMatchObject({ message: 'Stopped' });
    expect(readFileSync(log, 'utf8')).not.toContain('"prompt"');
  });

  it('runs again without a flag an older Claude Code rejects, leaving its subagents out the second time too', async () => {
    const r = run(['agents'], { FAKE_CLAUDE_REJECT: '--system-prompt-snapshot' });
    await expect(r.result).resolves.toMatchObject({ sessionId: 'fake-session' });
    const lines = r.lines();
    expect(lines.filter((l) => 'rejected' in l)).toHaveLength(1);
    expect(lines.find((l) => 'prompt' in l)).toEqual({ prompt: 'hello', denied: ['Agent(reviewer)', 'Agent(deck:designer)'] });
  });
});

describe('claude and the tool library', () => {
  const base = { systemPrompt: 'briefing', ask: true, newSessionId: 'new-id' };
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('passes the MCP config file and lets Claude read skill folders, never write them', () => {
    const args = claudeArgs({ ...base, permission: 'edit', mcpConfig: '/tmp/x/mcp.json', readDirs: ['/skills/commit'] });
    expect(after(args, '--mcp-config')).toBe('/tmp/x/mcp.json');
    expect(args).toContain('Read(//skills/commit/**)');
    expect(args).not.toContain('/skills/commit');
    // A variadic flag must be followed by another flag, not by a value it would swallow.
    expect(args[args.indexOf('--mcp-config') + 2]).toMatch(/^--/);
    const full = claudeArgs({ ...base, permission: 'full', readDirs: ['/skills/commit'] });
    expect(full.some((a) => a.startsWith('Read('))).toBe(false);
    expect(claudeArgs({ ...base, permission: 'edit' })).not.toContain('--mcp-config');
  });

  it('writes Read rules for absolute paths on every platform', () => {
    expect(claudeReadRule('/Users/me/skills/')).toBe('Read(//Users/me/skills/**)');
    expect(claudeReadRule('C:\\Users\\me\\skills')).toBe('Read(//c/Users/me/skills/**)');
  });

  it('turns library servers into an --mcp-config document', () => {
    expect(
      claudeMcpConfig([
        { name: 'gh', transport: 'stdio', command: 'npx', args: ['-y', 'gh'], url: '', env: { TOKEN: 't' }, headers: {} },
        { name: 'docs', transport: 'http', command: '', args: [], url: 'https://x.test/mcp', env: {}, headers: {} },
      ]),
    ).toEqual({
      mcpServers: {
        gh: { type: 'stdio', command: 'npx', args: ['-y', 'gh'], env: { TOKEN: 't' } },
        docs: { type: 'http', url: 'https://x.test/mcp' },
      },
    });
  });
});
