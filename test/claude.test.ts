import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A data folder of its own: a turn's --settings and --mcp-config files go in its tmp folder.
const dataDir = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  process.env.RELAY_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'relay-claude-data-')));
  return process.env.RELAY_DATA_DIR;
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

import {
  claudeAgentDenyRules,
  claudeAgents,
  claudeAgentsGate,
  claudeAllowedInput,
  claudeAllowedTools,
  claudeOutsideSandbox,
  claudeManagedSettings,
  claudeReopening,
  claudeApprovalRequest,
  claudeArgs,
  claudeEndpointEnv,
  claudeEndpointProcessEnv,
  claudeEndpointUrl,
  claudeMcpConfig,
  claudeModelTokens,
  addModelUsage,
  claudeExcludePattern,
  claudeItemsBesideLibrary,
  claudeMcpName,
  claudeNativeEnv,
  claudeNativeSettings,
  claudeReadRule,
  claudeRunSettings,
  claudeRunner,
  claudeSandboxSettings,
  claudeSandboxWrites,
  claudeSessionFile,
  claudeSessionTally,
  claudeTurnUsage,
  createClaudeParser,
  parseClaudePluginList,
  type ClaudeControlRequest,
} from '../src/server/agents/claude';
import { AgentRunError, clip, clipPath, summarizeInput, type AgentEvent } from '../src/server/agents/types';
import type { NativeItemsOff, NativePart } from '../src/shared/types';
import { withLang } from '../src/server/i18n';

// The glob matcher Claude Code uses for claudeMdExcludes (here through Vitest's own dependencies).
const picomatch = createRequire(import.meta.url)('picomatch') as (patterns: string[], options?: { dot?: boolean }) => (path: string) => boolean;
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

  it("gives Claude the conversation's other working directories, and the attachments, with --add-dir", () => {
    const args = claudeArgs({ ...base, permission: 'edit', addDirs: ['/docs', '/infra'], attachmentsDir: '/data/att' });
    const at = args.indexOf('--add-dir');
    expect(args.slice(at, at + 4)).toEqual(['--add-dir', '/docs', '/infra', '/data/att']);
    // Variadic: the next item is another flag.
    expect(args[at + 4]!.startsWith('--')).toBe(true);
    expect(claudeArgs({ ...base, permission: 'edit' })).not.toContain('--add-dir');
    // Its sandbox lets commands write in them as in the working directory (no sandbox with full access,
    // nor on Windows, where Claude Code has none).
    expect(claudeSandboxWrites('edit', ['/work', '/docs'])).toEqual(process.platform === 'win32' ? undefined : expect.arrayContaining(['/work', '/docs']));
    expect(claudeSandboxWrites('full', ['/work', '/docs'])).toBeUndefined();
  });

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
    // On Windows its commands come through its PowerShell tool: a command too.
    expect(claudeApprovalRequest('PowerShell', { command: 'echo hi > hello.txt', description: 'Write' })).toEqual({ kind: 'command', detail: 'echo hi > hello.txt', reason: 'Write' });
    expect(claudeApprovalRequest('Write', { file_path: '/a.txt' })).toMatchObject({ kind: 'edit', detail: '/a.txt' });
    expect(claudeApprovalRequest('WebFetch', { url: 'https://x.dev' })).toMatchObject({ kind: 'fetch', detail: 'https://x.dev' });
    expect(claudeApprovalRequest('mcp__linear__create', { title: 'Bug' })).toMatchObject({ kind: 'other', tool: 'mcp__linear__create' });
    // An approval card shows a path whole: where it starts tells whether it is inside the project.
    const long = '/private/tmp/' + 'folder-with-a-long-name/'.repeat(8) + 'secrets.env';
    expect(claudeApprovalRequest('Read', { file_path: long })).toMatchObject({ kind: 'other', tool: 'Read', detail: long });
    expect(claudeApprovalRequest('Grep', { pattern: 'TODO', path: long })).toMatchObject({ kind: 'other', detail: long });
    // Only paths are left whole: anything else is still cut at its end.
    const query = 'q '.repeat(120);
    expect(claudeApprovalRequest('WebSearch', { query })).toMatchObject({ kind: 'other', detail: clip(query) });
    expect(summarizeInput({ command: `cat ${long} ${long}` }, { wholePaths: true })).toHaveLength(160);
  });

  it('keeps the file name of a long path in a tool row, and the start of anything else', () => {
    const dir = '/private/tmp/claude-501/' + Array.from({ length: 8 }, (_, i) => `folder-${i}-with-a-long-name`).join('/') + '/scratchpad/review';
    const file = `${dir}/grok-survey.mts`;
    expect(file.length).toBeGreaterThan(160);
    const events: AgentEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));
    parser.handle(JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: file } }] } }));
    const detail = (events[0] as Extract<AgentEvent, { type: 'tool_start' }>).detail!;
    expect(detail).toBe('…' + file.slice(file.indexOf('/', file.length - 159)));
    expect(detail.length).toBeLessThanOrEqual(160);
    expect(detail).toMatch(/^…\/folder-\d-with-a-long-name\/.*\/scratchpad\/review\/grok-survey\.mts$/);

    // Grok's read_file and list_dir, and a folder to search in, the same way.
    expect(summarizeInput({ target_file: file })).toBe(detail);
    expect(summarizeInput({ target_directory: dir + '/' + 'b'.repeat(40) })).toMatch(/\/b{40}$/);
    expect(summarizeInput({ path: file })).toBe(detail);
    // A command, a query or a URL keeps its start.
    const command = `cat ${file}`;
    expect(summarizeInput({ command })).toBe(clip(command));
    expect(summarizeInput({ command })!.startsWith('cat /private/tmp/')).toBe(true);
    // Short paths are left whole; a file name longer than the limit keeps its end.
    expect(clipPath('/repo/a.ts')).toBe('/repo/a.ts');
    // A folder name cut in the middle is left out.
    expect(clipPath(`/${'f'.repeat(200)}/src/a.ts`)).toBe('…/src/a.ts');
    // At the limit a path stays whole; one over it comes back at the limit or less.
    const at = '/' + 'a/'.repeat(79) + 'b';
    expect(at.length).toBe(160);
    expect(clipPath(at)).toBe(at);
    expect(clipPath(at + 'c')).toBe('…/' + 'a/'.repeat(78) + 'bc');
    expect(clipPath(at + 'c').length).toBeLessThanOrEqual(160);
    // A cut inside a folder name moves on to the next separator; one that lands on a separator keeps it.
    expect(clipPath('/abc/defgh/ij', 9)).toBe('…/ij');
    expect(clipPath('/abcdefgh/ijk', 5)).toBe('…/ijk');
    // A folder with a long name and a trailing separator keeps the end of that name.
    expect(clipPath('/' + 'x'.repeat(200) + '/')).toBe('…' + 'x'.repeat(158) + '/');
    expect(clipPath(`/repo/${'n'.repeat(200)}.ts`)).toBe(`…${'n'.repeat(156)}.ts`);
    expect(clipPath('C:\\repo\\' + 'd'.repeat(170) + '\\a.ts', 20)).toBe('…\\a.ts');
  });
});

describe('leaving out what Claude Code loads by itself', () => {
  // Full access has no sandbox settings, so `--settings` holds only what is left out.
  const base = { systemPrompt: 'briefing', ask: true, newSessionId: 'new-id', permission: 'full' as const };

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

  it('turns off all its built-in tools with --tools "", which leaves its MCP tools', () => {
    const args = claudeArgs({ ...base, nativeOff: ['tools'] });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--tools') + 2]).toMatch(/^--/);
    expect(claudeArgs(base)).not.toContain('--tools');
  });

  it('leaves out single skills, files, tools, MCP servers, subagents and plugins with --settings', () => {
    const items = {
      skills: ['commit'],
      instructions: ['/repo/CLAUDE.md'],
      tools: ['WebSearch'],
      mcp: ['mcp__claude_ai_Gmail'],
      mcpTools: ['mcp__local__search'],
      agents: ['Explore'],
      plugins: ['deck@market'],
    };
    expect(claudeNativeSettings([], [], items)).toEqual({
      enabledPlugins: { 'deck@market': false },
      skillOverrides: { commit: 'off' },
      claudeMdExcludes: ['/repo/CLAUDE.md'],
      permissions: { deny: ['WebSearch', 'mcp__claude_ai_Gmail', 'mcp__local__search', 'Agent(Explore)'] },
    });
    const args = claudeArgs({ ...base, nativeItems: items });
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual(claudeNativeSettings([], [], items));
    // A part left out whole needs no single items; plugins then go by every id, and subagents stay
    // denied by name (the switch keeps the built-in ones). Rules for single MCP servers would also
    // reach a tool library server of the same name, so none are added once all are left out.
    expect(claudeNativeSettings(['skills', 'instructions', 'tools', 'mcp', 'plugins'], ['deck@market', 'lsp@market'], items)).toEqual({
      enabledPlugins: { 'deck@market': false, 'lsp@market': false },
      permissions: { deny: ['Agent(Explore)'] },
    });
    expect(claudeNativeSettings([], [], {})).toBeUndefined();
  });

  it("names an MCP server as Claude Code's rules do, and writes a file as a pattern that matches only it", () => {
    expect(claudeMcpName('claude.ai Claude Docs')).toBe('claude_ai_Claude_Docs');
    expect(claudeMcpName('claude.ai wrenai-1.0-revamp-new')).toBe('claude_ai_wrenai-1_0-revamp-new');
    expect(claudeMcpName('my.server')).toBe('my_server');
    expect(claudeMcpName('local')).toBe('local');
    expect(claudeExcludePattern('/a/b c/CLAUDE.md')).toBe('/a/b c/CLAUDE.md');
    expect(claudeExcludePattern('/a/[x]/(y)/c{1,2}/*?.md')).toBe('/a/[[]x]/[(]y[)]/c[{]1,2[}]/[*][?].md');
    expect(claudeExcludePattern('C:\\repo\\CLAUDE.md')).toBe('C:/repo/CLAUDE.md');
    // Matched as Claude Code 2.1.319 matches them: every \\ in a pattern turned into / first, then picomatch.
    const matches = (pattern: string, path: string) => picomatch([pattern.replaceAll('\\', '/')], { dot: true })(path);
    for (const path of ['/x/proj [old]/CLAUDE.md', '/app/[slug]/CLAUDE.md', '/a/(y)/c{1,2}/*?.md', '/a/b]c/CLAUDE.md', '/a/!(z)/+(q)/@(r).md']) {
      expect(matches(claudeExcludePattern(path), path)).toBe(true);
      expect(matches(claudeExcludePattern(path), '/x/proj o/CLAUDE.md')).toBe(false);
    }
    expect(matches(claudeExcludePattern('/app/[slug]/CLAUDE.md'), '/app/s/CLAUDE.md')).toBe(false);
    expect(matches(claudeExcludePattern('/a/*/CLAUDE.md'), '/a/b/CLAUDE.md')).toBe(false);
  });

  it("leaves a tool library server's tools alone when a server of its name is ticked", () => {
    const items = { mcp: ['mcp__local', 'mcp__other'], mcpTools: ['mcp__local__fetch', 'mcp__other__x', 'mcp__localx__y'], skills: ['commit'] };
    expect(claudeItemsBesideLibrary(items, [{ name: 'local' }])).toEqual({ skills: ['commit'], mcp: ['mcp__other'], mcpTools: ['mcp__other__x', 'mcp__localx__y'] });
    expect(claudeItemsBesideLibrary(items, [{ name: 'claude.ai Gmail' }, { name: 'local' }, { name: 'other' }])).toEqual({ skills: ['commit'], mcpTools: ['mcp__localx__y'] });
    expect(claudeItemsBesideLibrary(items, [])).toBe(items);
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

// The stand-ins are scripts run by their `#!` line, which Windows cannot start.
describe.skipIf(process.platform === 'win32')('a Claude Code run that leaves out its own setup (stand-in claude)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-claude-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bin = writeFakeClaude(join(dir, 'claude'));
  let n = 0;
  function run(nativeOff: NativePart[], extra: Record<string, string> = {}, nativeItems: NativeItemsOff = {}) {
    const log = join(dir, `log-${++n}.jsonl`);
    const result = claudeRunner.run({
      bin,
      env: { ...process.env, FAKE_CLAUDE_LOG: log, ...extra },
      prompt: 'hello',
      systemPrompt: 'briefing',
      cwd: dir,
      permission: 'full',
      signal: new AbortController().signal,
      onEvent: () => undefined,
      nativeOff,
      nativeItems,
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
    expect(start.settings).toEqual({
      disableAllHooks: true,
      enabledPlugins: { 'deck@market': false, 'lsp@market': false },
    });
    expect(start.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    // The plugin's subagent went with the plugin; the user's own is denied before the prompt is sent.
    expect(lines.find((l) => 'prompt' in l)).toEqual({ prompt: 'hello', denied: ['Agent(reviewer)'] });
    // The built-in ones were asked of a Claude Code started with no settings sources.
    expect(lines.some((l) => Array.isArray(l.args) && l.args[l.args.indexOf('--setting-sources') + 1] === '')).toBe(true);
  });

  it('leaves out single items through --settings in a private file, and sends the prompt at once', async () => {
    const r = run([], {}, { skills: ['commit'], agents: ['reviewer'], plugins: ['deck@market'], tools: ['WebSearch'], mcpTools: ['mcp__local__fetch'] });
    await expect(r.result).resolves.toMatchObject({ sessionId: 'fake-session' });
    const start = turn(r.lines())!;
    // A file, not the command line, and gone once the run is over.
    const file = start.args[start.args.indexOf('--settings') + 1];
    expect(file).toMatch(/settings\.json$/);
    expect(existsSync(file)).toBe(false);
    // In Harness Relay's own temporary folder, which sandboxed commands can neither change nor read,
    // not in the system's, which they can.
    expect(file.startsWith(join(dataDir, 'tmp') + '/')).toBe(true);
    expect(start.settings).toEqual({
      enabledPlugins: { 'deck@market': false },
      skillOverrides: { commit: 'off' },
      permissions: { deny: ['WebSearch', 'mcp__local__fetch', 'Agent(reviewer)'] },
    });
    // Named up front: no subagents to wait for.
    expect(r.lines().filter((l) => 'deny' in l)).toEqual([]);
    expect(r.lines().find((l) => 'prompt' in l)).toEqual({ prompt: 'hello', denied: [] });
  });

  it("runs on the user's own endpoint: its address, key and model in --settings, never the user's Anthropic key or sign-in", async () => {
    const log = join(dir, `log-${++n}.jsonl`);
    const backends = {
      apis: {},
      endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:11434/v1', models: ['gemma4:e4b'], apiKey: 'lab-key' }],
    };
    const result = await claudeRunner.run({
      bin,
      env: { ...process.env, FAKE_CLAUDE_LOG: log, ANTHROPIC_API_KEY: 'sk-ant-from-settings', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
      prompt: 'hello',
      systemPrompt: 'briefing',
      cwd: dir,
      permission: 'full',
      model: 'homelab/gemma4:e4b',
      effort: 'xhigh',
      backends,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    // Claude Code would price the model as one of its own.
    expect(result).toMatchObject({ sessionId: 'fake-session', costUsd: undefined });
    const start = turn(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>))!;
    expect(start.args[start.args.indexOf('--model') + 1]).toBe('gemma4:e4b');
    // An effort the endpoint may not take is not sent.
    expect(start.args).not.toContain('--effort');
    // In the private settings file (the flag layer, over the user's own settings files).
    expect(start.args[start.args.indexOf('--settings') + 1]).toMatch(/settings\.json$/);
    expect(start.settings.env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://10.0.0.5:11434', ANTHROPIC_AUTH_TOKEN: 'lab-key', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'gemma4:e4b' });
    expect(start.env).toEqual({
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: null,
      ANTHROPIC_BASE_URL: 'http://10.0.0.5:11434',
      ANTHROPIC_AUTH_TOKEN: 'lab-key',
      ANTHROPIC_API_KEY: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
    });
    // Its own models stay with Claude Code.
    const own = join(dir, `log-${++n}.jsonl`);
    await claudeRunner.run({
      bin,
      env: { ...process.env, FAKE_CLAUDE_LOG: own, ANTHROPIC_API_KEY: 'sk-ant-from-settings' },
      prompt: 'hello',
      systemPrompt: 'briefing',
      cwd: dir,
      permission: 'full',
      model: 'opus',
      effort: 'xhigh',
      backends,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    const ownStart = turn(readFileSync(own, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>))!;
    expect(ownStart.args.slice(ownStart.args.indexOf('--model'), ownStart.args.indexOf('--model') + 4)).toEqual(['--model', 'opus', '--effort', 'xhigh']);
    expect(ownStart.args).not.toContain('--settings');
    expect(ownStart.env.ANTHROPIC_API_KEY).toBe('sk-ant-from-settings');
    // A model of an endpoint deleted in Settings fails before Claude Code starts: its id would go to Anthropic.
    const gone = join(dir, `log-${++n}.jsonl`);
    await expect(
      withLang('en', () =>
        claudeRunner.run({
          bin,
          env: { ...process.env, FAKE_CLAUDE_LOG: gone, ANTHROPIC_API_KEY: 'sk-ant-from-settings' },
          prompt: 'hello',
          systemPrompt: 'briefing',
          cwd: dir,
          permission: 'full',
          model: 'oldlab/gemma4:e4b',
          backends: { ...backends, deletedEndpoints: ['oldlab'] },
          signal: new AbortController().signal,
          onEvent: () => undefined,
        }),
      ),
    ).rejects.toThrow('Claude Code is to use the model "oldlab/gemma4:e4b", but its custom endpoint "oldlab" was deleted');
    expect(existsSync(gone)).toBe(false);
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

describe("Claude Code's sandbox below full access", () => {
  const sandbox = {
    // `disabled: false` wins over a user's setting that turns file isolation off.
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, filesystem: { disabled: false } },
    permissions: { ask: ['Bash(dangerouslyDisableSandbox:true)'] },
  };

  it('turns it on in read-only and edit mode, but not with full access or on native Windows', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(claudeSandboxSettings('read-only', platform)).toEqual(sandbox);
      expect(claudeSandboxSettings('edit', platform)).toEqual(sandbox);
      expect(claudeSandboxSettings('full', platform)).toBeUndefined();
    }
    expect(claudeSandboxSettings('edit', 'win32')).toBeUndefined();
  });

  it("sets the user's own endpoint's variables over what the user's settings files set, with any sandbox", () => {
    const run = { id: 'lab/qwen3', model: 'qwen3', endpoint: { id: 'lab', name: 'Lab', baseUrl: 'https://lab.example/v1/', models: ['qwen3'] } };
    const env = claudeEndpointEnv(run);
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'https://lab.example',
      // A credential of its own: without one the user's sign-in would be sent there.
      ANTHROPIC_AUTH_TOKEN: 'no-key',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_USE_BEDROCK: '0',
      CLAUDE_CODE_USE_VERTEX: '0',
      CLAUDE_CODE_USE_FOUNDRY: '0',
      ANTHROPIC_MODEL: 'qwen3',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3',
      ANTHROPIC_SMALL_FAST_MODEL: 'qwen3',
      CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3',
    });
    expect(claudeEndpointEnv({ ...run, endpoint: { ...run.endpoint, apiKey: 'k' } }).ANTHROPIC_AUTH_TOKEN).toBe('k');
    expect(claudeEndpointUrl('http://10.0.0.5:11434/v1')).toBe('http://10.0.0.5:11434');
    expect(claudeEndpointUrl('http://10.0.0.5:11434')).toBe('http://10.0.0.5:11434');
    expect(claudeEndpointUrl('https://gw.example/anthropic/')).toBe('https://gw.example/anthropic');
    // Empty values are taken out of the process environment.
    expect(claudeEndpointProcessEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_USE_BEDROCK: '1' }, env)).toMatchObject({
      PATH: '/bin',
      ANTHROPIC_AUTH_TOKEN: 'no-key',
      CLAUDE_CODE_USE_BEDROCK: '0',
    });
    expect(claudeEndpointProcessEnv({ ANTHROPIC_API_KEY: 'sk' }, env)).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(claudeRunSettings('full', [], [], {}, 'linux', [], env)).toEqual({ env });
    expect(claudeRunSettings('edit', ['hooks'], [], {}, 'linux', [], env)).toEqual({ disableAllHooks: true, ...sandbox, env });
    const args = claudeArgs({ systemPrompt: 'b', ask: false, newSessionId: 'id', permission: 'full', platform: 'linux', endpointEnv: env, settingsFile: '/tmp/s.json' });
    expect(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2)).toEqual(['--settings', '/tmp/s.json']);
  });

  it('adds it to what a turn leaves out, keeping both sets of permission rules', () => {
    expect(claudeRunSettings('edit', ['hooks'], [], {}, 'linux')).toEqual({ disableAllHooks: true, ...sandbox });
    expect(claudeRunSettings('read-only', [], [], { tools: ['WebSearch'] }, 'darwin')).toEqual({
      sandbox: sandbox.sandbox,
      permissions: { deny: ['WebSearch'], ask: ['Bash(dangerouslyDisableSandbox:true)'] },
    });
    expect(claudeRunSettings('full', ['hooks'], [], {}, 'linux')).toEqual({ disableAllHooks: true });
    // What a turn leaves out and the protected paths are both denied.
    expect(claudeRunSettings('edit', [], [], { tools: ['WebSearch'] }, 'linux', ['/home/me/.mozilla'])).toMatchObject({
      permissions: { deny: ['WebSearch', 'Read(//home/me/.mozilla)', 'Read(//home/me/.mozilla/**)'], ask: ['Bash(dangerouslyDisableSandbox:true)'] },
    });
    expect(claudeRunSettings('full', [], [], {}, 'linux', ['/home/me/.mozilla'])).toBeUndefined();
    expect(claudeRunSettings('edit', [], [], {}, 'win32')).toBeUndefined();
    const base = { systemPrompt: 'briefing', ask: true, newSessionId: 'new-id' };
    const args = claudeArgs({ ...base, permission: 'edit', platform: 'linux' });
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual(sandbox);
    expect(claudeArgs({ ...base, permission: 'full', platform: 'linux' })).not.toContain('--settings');
    expect(claudeArgs({ ...base, permission: 'read-only', platform: 'win32' })).not.toContain('--settings');
  });

  it('asks about the hosts its commands reach, and says when allowing runs a command outside it', () => {
    const host = withLang('en', () => claudeApprovalRequest('SandboxNetworkAccess', { host: 'registry.npmjs.org' }, 'Allow network connection to registry.npmjs.org?'));
    expect(host).toEqual({
      kind: 'fetch',
      detail: 'registry.npmjs.org',
      reason: 'A command in the sandbox wants to connect to this host.',
    });
    const blocked = claudeApprovalRequest('Bash', { command: 'touch ~/x', description: 'Touch' }, undefined, true);
    expect(blocked).toEqual({ kind: 'command', detail: 'touch ~/x', reason: 'Touch', outsideSandbox: true });
    expect(claudeApprovalRequest('Bash', { command: 'make' }, undefined, false)).not.toHaveProperty('outsideSandbox');
  });

  it('runs a command the user allowed outside the sandbox only when the sandbox would block it', () => {
    const writes = ['/work/repo', '/tmp'];
    const home = { tool_name: 'Bash', input: { command: 'touch ~/x' }, blocked_path: '/home/me/x' };
    expect(claudeOutsideSandbox(home, writes)).toBe(true);
    expect(claudeAllowedInput(home, true)).toEqual({ command: 'touch ~/x', dangerouslyDisableSandbox: true });
    // In read-only mode Claude Code also asks about a write in the working directory, which the
    // sandbox allows: that one runs in it.
    const inside = { tool_name: 'Bash', input: { command: 'touch ./x' }, blocked_path: '/work/repo/x' };
    expect(claudeOutsideSandbox(inside, writes)).toBe(false);
    expect(claudeOutsideSandbox({ ...inside, blocked_path: '/work/repo' }, writes)).toBe(false);
    expect(claudeOutsideSandbox({ ...inside, blocked_path: '/work/repo-other/x' }, writes)).toBe(true);
    expect(claudeAllowedInput(inside, false)).toEqual({ command: 'touch ./x' });
    // The model asked to leave it; a plain command or another tool stays in it.
    expect(claudeOutsideSandbox({ tool_name: 'Bash', input: { command: 'make', dangerouslyDisableSandbox: true } }, writes)).toBe(true);
    expect(claudeOutsideSandbox({ tool_name: 'Bash', input: { command: 'ls' } }, writes)).toBe(false);
    expect(claudeOutsideSandbox({ tool_name: 'SandboxNetworkAccess', input: { host: 'x.dev' } }, writes)).toBe(false);
    // Without a sandbox nothing runs outside one.
    expect(claudeOutsideSandbox(home, undefined)).toBe(false);
  });

  describe.skipIf(process.platform === 'win32')('in a run (stand-in claude)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-claude-sandbox-')));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const bin = writeFakeClaude(join(dir, 'claude'));
    let n = 0;
    function run(permission: 'read-only' | 'edit' | 'full', extra: Record<string, string> = {}, protectedPaths: string[] = []) {
      const log = join(dir, `log-${++n}.jsonl`);
      const result = claudeRunner.run({
        bin,
        env: { ...process.env, FAKE_CLAUDE_LOG: log, ...extra },
        prompt: 'hello',
        systemPrompt: 'briefing',
        cwd: dir,
        permission,
        signal: new AbortController().signal,
        onEvent: () => undefined,
        protectedPaths,
      });
      const start = () =>
        readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Record<string, any>)
          .find((l) => Array.isArray(l.args) && l.args.includes('--append-system-prompt'));
      return { result, start };
    }

    it('starts Claude Code with its sandbox on below full access', async () => {
      for (const permission of ['read-only', 'edit'] as const) {
        const r = run(permission);
        await expect(r.result).resolves.toMatchObject({ sessionId: 'fake-session' });
        expect(r.start()!.settings).toEqual(sandbox);
      }
      const full = run('full');
      await full.result;
      expect(full.start()!.args).not.toContain('--settings');
    });

    it('keeps it from reading or writing the protected paths, with its sandbox and with Read rules', async () => {
      const r = run('edit', {}, ['/home/me/.mozilla', '/srv/relay/data/relay.db']);
      await r.result;
      expect(r.start()!.settings).toEqual({
        sandbox: {
          ...sandbox.sandbox,
          filesystem: { disabled: false, denyRead: ['/home/me/.mozilla', '/srv/relay/data/relay.db'], denyWrite: ['/home/me/.mozilla', '/srv/relay/data/relay.db'] },
        },
        permissions: {
          deny: ['Read(//home/me/.mozilla)', 'Read(//home/me/.mozilla/**)', 'Read(//srv/relay/data/relay.db)', 'Read(//srv/relay/data/relay.db/**)'],
          ask: sandbox.permissions.ask,
        },
      });
    });

    it('does not start when a protected path would be read as a pattern, or the user\'s settings open one again', async () => {
      const pattern = withLang('en', () => run('edit', {}, ['/home/me [1]/data/relay.db']));
      await expect(pattern.result).rejects.toThrow(/cannot protect \/home\/me \[1\]\/data\/relay\.db/);
      const home = join(dir, 'claude-home');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ sandbox: { filesystem: { allowRead: ['/srv/relay/data'] } } }));
      const reopened = withLang('en', () => run('edit', { CLAUDE_CONFIG_DIR: home }, ['/srv/relay/data/relay.db']));
      await expect(reopened.result).rejects.toThrow(/settings\.json.*\/srv\/relay\/data.*Remove it/s);
      // Full access has no sandbox to keep them from.
      await expect(run('full', { CLAUDE_CONFIG_DIR: home }, ['/srv/relay/data/relay.db']).result).resolves.toBeTruthy();
    });

    it('says how to fix it when the sandbox cannot run, instead of running without it', async () => {
      const r = withLang('en', () => run('edit', { FAKE_CLAUDE_NO_SANDBOX: '1' }));
      await expect(r.result).rejects.toThrow(/could not start its sandbox.*bubblewrap \(bwrap\) is not installed.*install bubblewrap and socat/s);
    });
  });
});

describe("the user's own Claude Code settings", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-claude-reopen-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const settings = (filesystem: unknown) => {
    const file = join(dir, `settings-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify({ sandbox: { filesystem } }));
    return file;
  };
  // With a drive on Windows: there a path without one is on the drive of the folder it is read from,
  // and the settings files (in the temporary folder) may be on another drive than the tests (GitHub's
  // runners check out on D:).
  const guarded = [resolve('/home/me/.mozilla'), resolve('/srv/relay/data/relay.db')];

  it('are caught when an allowed path reaches a protected one: it, a folder holding it, inside it, or a pattern', () => {
    const srv = resolve('/srv/relay');
    const holding = settings({ allowRead: [srv] });
    expect(claudeReopening([holding], guarded)).toEqual([holding, srv]);
    const inside = settings({ allowWrite: ['~/.mozilla/profiles'] });
    expect(claudeReopening([inside], guarded, { home: '/home/me' })).toEqual([inside, '~/.mozilla/profiles']);
    const all = join(resolve('/home/me'), '**');
    const pattern = settings({ allowRead: [all] });
    expect(claudeReopening([pattern], guarded)).toEqual([pattern, all]);
    const relative = settings({ allowRead: ['../data'] });
    expect(claudeReopening([relative], guarded, { cwd: '/srv/relay/app' })).toEqual([relative, '../data']);
    // Claude Code takes a relative entry from the settings file's folder (~/.claude for the user's).
    const config = join(dir, 'me/.claude');
    mkdirSync(config, { recursive: true });
    const fromConfig = join(config, 'settings.json');
    writeFileSync(fromConfig, '\uFEFF' + JSON.stringify({ sandbox: { filesystem: { allowRead: ['../.mozilla'] } } }));
    expect(claudeReopening([fromConfig], [join(dir, 'me/.mozilla')], { cwd: '/srv/elsewhere' })).toEqual([fromConfig, '../.mozilla']);
  });

  it("include an administrator's managed settings", () => {
    expect(claudeManagedSettings('darwin')[0]).toBe('/Library/Application Support/ClaudeCode/managed-settings.json');
    expect(claudeManagedSettings('linux')[0]).toBe('/etc/claude-code/managed-settings.json');
    expect(claudeManagedSettings('win32')).toEqual([]);
  });

  it('pass when they reach nothing protected, or are missing or unreadable', () => {
    expect(claudeReopening([settings({ allowRead: ['/opt/cache'], allowWrite: ['/tmp/build'] })], guarded)).toBeUndefined();
    expect(claudeReopening([join(dir, 'missing.json')], guarded)).toBeUndefined();
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json');
    expect(claudeReopening([broken], guarded)).toBeUndefined();
  });
});

describe("a turn's cost and tokens", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-claude-usage-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const costState = (totalCostUSD: number, modelUsage: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'cost-state', sessionId: 's', totalCostUSD, modelUsage });
  const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
    inputTokens: input,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    outputTokens: output,
  });

  it("finds a session's file by the working directory's name, or in any project folder", () => {
    const home = join(dir, 'home');
    const cwd = join(dir, 'work space');
    mkdirSync(cwd, { recursive: true });
    const named = join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(named, { recursive: true });
    writeFileSync(join(named, 'aaaa-1.jsonl'), '');
    expect(claudeSessionFile({ CLAUDE_CONFIG_DIR: home }, cwd, 'aaaa-1')).toBe(join(named, 'aaaa-1.jsonl'));
    // A long path's folder is cut and hashed by Claude Code: found by the file's name.
    const other = join(home, 'projects', '-cut-and-hashed-1234');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'bbbb-2.jsonl'), '');
    expect(claudeSessionFile({ CLAUDE_CONFIG_DIR: home }, cwd, 'bbbb-2')).toBe(join(other, 'bbbb-2.jsonl'));
    expect(claudeSessionFile({ CLAUDE_CONFIG_DIR: home }, cwd, 'cccc-3')).toBeUndefined();
    expect(claudeSessionFile({ CLAUDE_CONFIG_DIR: home }, cwd, '../aaaa-1')).toBeUndefined();
    expect(claudeSessionFile({ CLAUDE_CONFIG_DIR: join(dir, 'no-home') }, cwd, 'aaaa-1')).toBeUndefined();
  });

  it("reads what a session used so far from its last cost-state record, however large the file", async () => {
    const file = join(dir, 'session.jsonl');
    // A line longer than a block, with characters of several bytes across the blocks' edges.
    const long = JSON.stringify({ type: 'assistant', message: { content: '說明'.repeat(70_000) + ' "cost-state" ' + 'é'.repeat(50_000) } });
    writeFileSync(
      file,
      [
        costState(0.5, { a: usage(1, 2, 3, 4) }),
        JSON.stringify({ type: 'user', message: { content: 'x' } }),
        costState(1.25, { a: usage(10, 1000, 200, 50), b: usage(300, 0, 0, 7) }),
        long,
        JSON.stringify({ type: 'user', message: { content: 'the words "cost-state" in a message' } }),
        JSON.stringify({ type: 'progress', kind: 'cost-state', totalCostUSD: 99 }),
        // Another session's record (a session copied from it), and costs Claude Code would not take.
        JSON.stringify({ type: 'cost-state', sessionId: 'other', totalCostUSD: 7 }),
        JSON.stringify({ type: 'cost-state', sessionId: 's', totalCostUSD: 2e9 }),
        JSON.stringify({ type: 'cost-state', sessionId: 's', totalCostUSD: -1 }),
        '',
      ].join('\n'),
    );
    expect(await claudeSessionTally(file, 's')).toEqual({ costUsd: 1.25, inputTokens: 1510, outputTokens: 57 });
    // Not read further back than it is asked to: not known then.
    expect(await claudeSessionTally(file, 's', 100_000)).toBeUndefined();
    // The last record also when it ends the file without a newline, or is its only line.
    writeFileSync(file, [long, costState(2, { a: usage(1, 0, 0, 1) })].join('\n'));
    expect(await claudeSessionTally(file, 's')).toEqual({ costUsd: 2, inputTokens: 1, outputTokens: 1 });
    writeFileSync(file, costState(2.5));
    expect(await claudeSessionTally(file, 's')).toEqual({ costUsd: 2.5, inputTokens: 0, outputTokens: 0 });
    // None yet (or a Claude Code that keeps none): nothing used, as the run starts from nothing.
    writeFileSync(file, [long, JSON.stringify({ type: 'user', message: { content: 'x' } })].join('\n'));
    expect(await claudeSessionTally(file, 's')).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
    writeFileSync(file, '');
    expect(await claudeSessionTally(file, 's')).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
    // A record that is not one, and a file that cannot be read.
    writeFileSync(file, [costState(3), '{"type":"cost-state","sessionId":"s","totalCostUSD":"4"}', '{"type":"cost-state", broken'].join('\n'));
    expect(await claudeSessionTally(file, 's')).toEqual({ costUsd: 3, inputTokens: 0, outputTokens: 0 });
    expect(await claudeSessionTally(join(dir, 'missing.jsonl'), 's')).toBeUndefined();
  });

  it('reads a large file without lines over a block slowing it down', async () => {
    // 40 MB of 1.3 MB lines and no record: read to its start (no record: nothing used) in good time.
    const file = join(dir, 'large.jsonl');
    const line = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(1_300_000) } });
    writeFileSync(file, Array.from({ length: 30 }, () => line).join('\n'));
    const started = Date.now();
    expect(await claudeSessionTally(file, 's', 64 * 1024 * 1024)).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
    expect(Date.now() - started).toBeLessThan(5_000);
    // By default it stops 16 MB from the end.
    expect(await claudeSessionTally(file, 's')).toBeUndefined();
  });

  it('counts every model of a modelUsage, with the cached input', () => {
    expect(claudeModelTokens({ a: usage(10, 1000, 200, 50), b: { inputTokens: 5, outputTokens: 1, costUSD: 0.1 } })).toEqual({ inputTokens: 1215, outputTokens: 51 });
    expect(claudeModelTokens({ a: { inputTokens: -1, outputTokens: Number.NaN, cacheReadInputTokens: '3' } })).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(claudeModelTokens(undefined)).toBeUndefined();
    expect(claudeModelTokens([])).toBeUndefined();
  });

  it("takes what the session used before the turn off the totals Claude Code reports", () => {
    const r = {
      total_cost_usd: 1.75,
      modelUsage: { a: usage(15, 2200, 230, 70), b: usage(300, 0, 0, 7) },
      usage: { input_tokens: 5, cache_read_input_tokens: 1200, cache_creation_input_tokens: 30, output_tokens: 20 },
    };
    const before = { costUsd: 1.25, inputTokens: 1510, outputTokens: 57 };
    // The subagent's tokens (model b) are in modelUsage, not in the main conversation's usage.
    expect(claudeTurnUsage({ ...r, modelUsage: { a: usage(15, 2200, 230, 70), b: usage(600, 0, 0, 14) } }, before)).toEqual({
      costUsd: 0.5,
      inputTokens: 1535,
      outputTokens: 27,
    });
    // A new session: everything is the turn's.
    expect(claudeTurnUsage(r, { costUsd: 0, inputTokens: 0, outputTokens: 0 })).toEqual({ costUsd: 1.75, inputTokens: 2745, outputTokens: 77 });
    // Not known what the session used before: no cost, the main conversation's tokens.
    expect(claudeTurnUsage(r, undefined)).toEqual({ costUsd: undefined, inputTokens: 1235, outputTokens: 20 });
    // Totals below what it had used (not the session's, then): the same.
    expect(claudeTurnUsage(r, { costUsd: 5, inputTokens: 9999, outputTokens: 999 })).toEqual({ costUsd: undefined, inputTokens: 1235, outputTokens: 20 });
    // No modelUsage: the main conversation's tokens; float noise is rounded off.
    expect(claudeTurnUsage({ total_cost_usd: 0.00508843, usage: r.usage }, { costUsd: 0.00483632, inputTokens: 0, outputTokens: 0 })).toEqual({
      costUsd: 0.00025211,
      inputTokens: 1235,
      outputTokens: 20,
    });
  });

  it("takes the run's own usage when Claude Code gives it (2.1.323), whatever the totals say", () => {
    // As Claude Code 2.1.323 answered a resumed run: the totals are the session's, the since-field the run's.
    const r = {
      total_cost_usd: 0.004575,
      modelUsage: { 'claude-haiku-5-5': { ...usage(4, 25939, 21561, 6), costUSD: 0.00457499 } },
      model_usage_since_last_result: {
        'claude-haiku-5-5': { ...usage(2, 14567, 9201, 3), costUSD: 0.00198757, thinkingTokens: 0, webSearchRequests: 0 },
        'claude-small': { ...usage(300, 0, 0, 7), costUSD: 0.0003 },
      },
      usage: { input_tokens: 2, cache_read_input_tokens: 14567, cache_creation_input_tokens: 9201, output_tokens: 3 },
    };
    const expected = { costUsd: 0.00228757, inputTokens: 24070, outputTokens: 10 };
    expect(claudeTurnUsage(r, { costUsd: 0.002587, inputTokens: 23734, outputTokens: 3 })).toEqual(expected);
    // Also when what came before is not known, or not what Claude Code counted on from.
    expect(claudeTurnUsage(r, undefined)).toEqual(expected);
    expect(claudeTurnUsage(r, { costUsd: 9, inputTokens: 1e6, outputTokens: 1e6 })).toEqual(expected);
    // A run that called no model; a model without a cost.
    expect(claudeTurnUsage({ ...r, model_usage_since_last_result: {} }, undefined)).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
    expect(claudeTurnUsage({ ...r, model_usage_since_last_result: { m: usage(1, 2, 3, 4) } }, undefined)).toEqual({ costUsd: undefined, inputTokens: 6, outputTokens: 4 });
  });

  it("adds up the run's own usage over every result of the run (a call that ended after one is on the next)", () => {
    const events: AgentEvent[] = [];
    const parser = createClaudeParser((e) => events.push(e));
    const result = (since: unknown) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's', total_cost_usd: 1, model_usage_since_last_result: since });
    parser.handle(result({ a: { ...usage(1, 10, 0, 2), costUSD: 0.5 } }));
    parser.handle(result({ a: { ...usage(1, 0, 5, 1), costUSD: 0.25 }, b: { ...usage(3, 0, 0, 4), costUSD: 0.125 } }));
    expect(claudeTurnUsage(parser.result!, undefined)).toEqual({ costUsd: 0.875, inputTokens: 20, outputTokens: 7 });
    // A cost only one of them has: the model's cost is not known (the turn's then neither).
    expect(addModelUsage({ a: { inputTokens: 1, costUSD: 0.5 } }, { a: { inputTokens: 2 } })).toEqual({ a: { inputTokens: 3, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
    expect(addModelUsage(undefined, { a: { inputTokens: 1 } })).toEqual({ a: { inputTokens: 1 } });
    expect(addModelUsage({ a: { inputTokens: 1 } }, 'x')).toEqual({ a: { inputTokens: 1 } });
    expect(addModelUsage(undefined, [])).toBeUndefined();
  });

  // The stand-in is a script run by its `#!` line, which Windows cannot start.
  describe.skipIf(process.platform === 'win32')('each turn of a resumed session, with a stand-in claude', () => {
    let n = 0;
    const setup = () => {
      const bin = writeFakeClaude(join(dir, `claude-${++n}`));
      const home = join(dir, `claude-home-${n}`);
      const cwd = join(dir, `project-${n}`);
      mkdirSync(cwd, { recursive: true });
      const run = (u: Record<string, unknown>, sessionId?: string, more: Partial<Parameters<typeof claudeRunner.run>[0]> = {}, env: Record<string, string> = {}) =>
        claudeRunner.run({
          bin,
          env: { ...process.env, CLAUDE_CONFIG_DIR: home, FAKE_CLAUDE_RUN_USAGE: JSON.stringify(u), ...env },
          prompt: 'hello',
          systemPrompt: 'briefing',
          cwd,
          permission: 'full',
          ...(sessionId ? { sessionId } : {}),
          signal: new AbortController().signal,
          onEvent: () => undefined,
          ...more,
        });
      return { run, home, cwd };
    };

    it('shows its own cost and tokens where Claude Code reports only the totals (from its file), a failed turn left out', async () => {
      const { run } = setup();
      const first = await run({ cost: 0.5, input: 10, cacheRead: 1000, cacheWrite: 200, output: 50 });
      expect(first).toEqual({ sessionId: expect.any(String), costUsd: 0.5, inputTokens: 1210, outputTokens: 50 });
      const second = await run({ cost: 0.25, input: 5, cacheRead: 1200, cacheWrite: 30, output: 20, subagent: { input: 300, output: 7 } }, first.sessionId);
      expect(second).toEqual({ sessionId: first.sessionId, costUsd: 0.25, inputTokens: 1535, outputTokens: 27 });
      // A turn that failed: Claude Code still counted what it used, and the next turn does not show it.
      await expect(run({ cost: 1, input: 1, cacheRead: 5000, cacheWrite: 0, output: 1, fail: true }, first.sessionId)).rejects.toThrow('the model failed');
      const fourth = await run({ cost: 0.125, input: 1, cacheRead: 1300, cacheWrite: 0, output: 3 }, first.sessionId);
      expect(fourth).toEqual({ sessionId: first.sessionId, costUsd: 0.125, inputTokens: 1301, outputTokens: 3 });
    });

    it("shows its own when run again without a flag an older Claude Code rejects, and on the user's own endpoint (no cost)", async () => {
      const { run } = setup();
      const first = await run({ cost: 0.5, input: 10, cacheRead: 1000, cacheWrite: 0, output: 50 });
      const again = await run({ cost: 0.25, input: 5, cacheRead: 1100, cacheWrite: 0, output: 20 }, first.sessionId, {}, { FAKE_CLAUDE_REJECT: '--system-prompt-snapshot' });
      expect(again).toEqual({ sessionId: first.sessionId, costUsd: 0.25, inputTokens: 1105, outputTokens: 20 });
      const backends = { apis: {}, endpoints: [{ id: 'homelab', name: 'Homelab', baseUrl: 'http://10.0.0.5:11434/v1', models: ['gemma4:e4b'] }] };
      const onEndpoint = await run({ cost: 0.75, input: 7, cacheRead: 1200, cacheWrite: 0, output: 9 }, first.sessionId, { backends, model: 'homelab/gemma4:e4b' });
      expect(onEndpoint).toEqual({ sessionId: first.sessionId, costUsd: undefined, inputTokens: 1207, outputTokens: 9 });
    });

    it("takes the run's own usage where Claude Code gives it, also after a record it would not take", async () => {
      const { run, home, cwd } = setup();
      const first = await run({ cost: 0.5, input: 10, cacheRead: 1000, cacheWrite: 200, output: 50, perRun: true });
      expect(first).toEqual({ sessionId: expect.any(String), costUsd: 0.5, inputTokens: 1210, outputTokens: 50 });
      // A record the stand-in counts on from but Harness Relay does not take (another session's).
      const file = join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${first.sessionId}.jsonl`);
      writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ type: 'cost-state', sessionId: 'other', totalCostUSD: 100 }) + '\n');
      const second = await run({ cost: 0.25, input: 5, cacheRead: 1200, cacheWrite: 30, output: 20, subagent: { input: 300, output: 7, cost: 0.05 }, perRun: true }, first.sessionId);
      expect(second).toEqual({ sessionId: first.sessionId, costUsd: 0.25, inputTokens: 1535, outputTokens: 27 });
    });
  });
});
