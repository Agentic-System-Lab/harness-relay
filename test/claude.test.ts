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
  claudeMcpConfig,
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
