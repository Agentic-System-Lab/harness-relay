import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A data folder of its own: asking Claude Code what it loads puts a --settings file in its tmp folder.
const dataDir = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  process.env.RELAY_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'relay-native-data-')));
  return process.env.RELAY_DATA_DIR;
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

import { openDatabase } from '../src/server/db';
import { withLang } from '../src/server/i18n';
import { SettingsStore } from '../src/server/settings';
import {
  NativeSetupService,
  probeCompleteness,
  saidNothing,
  claudeMemoryFiles,
  claudeMemoryState,
  listedFile,
  markLeftOut,
  nativeForClient,
  claudeProjectSlug,
  codexMemoryFiles,
  codexMemoryState,
  parseClaudeProbe,
  parseCodexProbe,
  CLAUDE_TOOLS_TURN,
  claudeAnswersUsage,
  parseGrokInspect,
} from '../src/server/native';
import { codexMcpToolId } from '../src/server/agents/codex';
import { writeFakeClaude } from './fake-claude';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-native-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function file(path: string, text = '# notes\n'): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

// Shapes below are trimmed from real answers (Claude Code 2.1.319, codex-cli 0.167.0, grok 1.0.77).

describe('parseClaudeProbe', () => {
  it('lists the commands that are not built in, and MCP servers without their configs', () => {
    const init = {
      commands: [
        { name: 'hf-cli', description: 'Hugging Face Hub CLI', argumentHint: '' },
        { name: 'compact', description: 'Clear history', argumentHint: '', builtin: true },
        { name: 'impeccable:impeccable', description: 'Design work', argumentHint: '', aliases: [] },
      ],
    };
    const mcp = {
      mcpServers: [
        {
          name: 'claude.ai Claude Docs',
          status: 'connected',
          config: { type: 'claudeai-proxy', url: 'https://api.anthropic.com/v1/pages/mcp', id: 'mcpsrv_1' },
          transport: 'claudeai-proxy',
          scope: 'claudeai',
          tools: [{ name: 'create' }, { name: 'read' }],
        },
        { name: 'local', status: 'failed', config: { type: 'stdio', command: 'x', env: { TOKEN: 'secret' } }, scope: 'user' },
      ],
    };
    const parsed = parseClaudeProbe({ init, mcp });
    // Each with the id it is left out by: a skill's name, an MCP server's (and tool's) permission rule.
    expect(parsed.skills).toEqual([
      { name: 'hf-cli', description: 'Hugging Face Hub CLI', id: 'hf-cli' },
      { name: 'impeccable:impeccable', description: 'Design work', id: 'impeccable:impeccable' },
    ]);
    expect(parsed.mcpServers).toEqual([
      {
        name: 'claude.ai Claude Docs',
        id: 'mcp__claude_ai_Claude_Docs',
        status: 'connected',
        source: 'claudeai',
        transport: 'claudeai-proxy',
        tools: [
          { name: 'create', id: 'mcp__claude_ai_Claude_Docs__create' },
          { name: 'read', id: 'mcp__claude_ai_Claude_Docs__read' },
        ],
      },
      { name: 'local', id: 'mcp__local', status: 'failed', source: 'user', transport: 'stdio' },
    ]);
    // No tools turn: no list of built-in tools (and no tab), rather than an empty one.
    expect(parsed).not.toHaveProperty('builtinTools');
    // No subagents in its answer: no list (and no tab), rather than an empty one.
    expect(parsed).not.toHaveProperty('agents');
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(parseClaudeProbe({})).toEqual({ skills: [], mcpServers: [] });
  });

  it('reads hooks without their commands, subagents, and plugins, with what its settings turn off', () => {
    const parsed = parseClaudeProbe(
      {
        init: { agents: [{ name: 'Explore', description: 'Search' }, { name: 'reviewer', description: 'Reviews' }, { name: 'impeccable:documenter', description: 'Docs' }] },
        hooks: {
          hooks: [
            { event: 'PostToolUse', matcher: 'Edit|Write', source: 'pluginHook', pluginName: 'impeccable@impeccable', commandText: 'run --token secret', disabled: true },
            { event: 'SessionStart', matcher: '', source: 'userSettings', sourceLabel: 'User settings', commandText: 'touch x' },
          ],
        },
        settings: { effective: { permissions: { deny: ['Agent(reviewer)', 'Bash(rm:*)'] }, enabledPlugins: { 'impeccable@impeccable': false } } },
      },
      [{ id: 'impeccable@impeccable', enabled: true, scope: 'user' }, { id: 'swift-lsp@official', enabled: false }, { id: 'rust-lsp@official' }],
      new Map([
        ['Explore', 'Search'],
        ['reviewer', 'The built-in reviewer'],
      ]),
    );
    expect(parsed.hooks).toEqual([
      { event: 'PostToolUse', matcher: 'Edit|Write', source: 'plugin: impeccable@impeccable', enabled: false },
      { event: 'SessionStart', source: 'userSettings' },
    ]);
    expect(parsed.agents).toEqual([
      { name: 'Explore', description: 'Search', id: 'Explore', source: 'built-in' },
      { name: 'reviewer', description: 'Reviews', id: 'reviewer', enabled: false },
      { name: 'impeccable:documenter', description: 'Docs', id: 'impeccable:documenter' },
    ]);
    expect(parsed.plugins).toEqual([
      { name: 'impeccable@impeccable', id: 'impeccable@impeccable', source: 'user', enabled: false },
      { name: 'swift-lsp@official', id: 'swift-lsp@official', enabled: false },
      { name: 'rust-lsp@official', id: 'rust-lsp@official' },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(JSON.stringify(parsed)).not.toContain('touch');
  });

  it('reads its built-in and MCP tools from the tools turn, by server, with servers only that turn names', () => {
    const parsed = parseClaudeProbe({
      mcp: { mcpServers: [{ name: 'local', status: 'pending', scope: 'user' }] },
      session: {
        type: 'system',
        subtype: 'init',
        tools: ['Bash', 'WebSearch', 'mcp__local__search', 'mcp__claude_ai_Claude_Docs__batch', 'mcp__claude_ai_Claude_Docs__read', 'mcp__plugin_x_y__go'],
        mcp_servers: [
          { name: 'local', status: 'connected', source: 'other' },
          { name: 'claude.ai Claude Docs', status: 'connected', source: 'claudeai' },
          { name: 'claude.ai Gmail', status: 'needs-auth', source: 'claudeai' },
        ],
      },
    });
    expect(parsed.builtinTools).toEqual([
      { name: 'Bash', id: 'Bash' },
      { name: 'WebSearch', id: 'WebSearch' },
    ]);
    expect(parsed.mcpServers).toEqual([
      // Its later status from the turn; its source from mcp_status.
      { name: 'local', id: 'mcp__local', status: 'connected', source: 'user', tools: [{ name: 'search', id: 'mcp__local__search' }] },
      {
        name: 'claude.ai Claude Docs',
        id: 'mcp__claude_ai_Claude_Docs',
        status: 'connected',
        source: 'claudeai',
        tools: [
          { name: 'batch', id: 'mcp__claude_ai_Claude_Docs__batch' },
          { name: 'read', id: 'mcp__claude_ai_Claude_Docs__read' },
        ],
      },
      // Not connected: its tools are not known.
      { name: 'claude.ai Gmail', id: 'mcp__claude_ai_Gmail', status: 'needs-auth', source: 'claudeai' },
      // A server neither list names, from its tool's name.
      { name: 'plugin_x_y', id: 'mcp__plugin_x_y', tools: [{ name: 'go', id: 'mcp__plugin_x_y__go' }] },
    ]);
  });

  it('sends the tools turn only when /usage is its own command', () => {
    const builtin = { name: 'usage', description: 'Usage', builtin: true };
    expect(claudeAnswersUsage({ commands: [builtin] })).toBe(true);
    // A skill or command named usage would take the prompt to the model.
    expect(claudeAnswersUsage({ commands: [builtin, { name: 'usage', description: 'Mine' }] })).toBe(false);
    expect(claudeAnswersUsage({ commands: [{ name: 'compact', builtin: true }] })).toBe(false);
    expect(claudeAnswersUsage(undefined)).toBe(false);
    expect(CLAUDE_TOOLS_TURN).toBe('/usage');
  });
});

describe('parseCodexProbe', () => {
  it('lists skills once each and configured MCP servers by name and kind only', () => {
    const skill = { name: 'autoplan', description: 'Long', shortDescription: 'Short', scope: 'user', path: '/s/autoplan/SKILL.md', enabled: true };
    const parsed = parseCodexProbe({
      skills: {
        data: [
          { cwd: '/p', errors: [], skills: [skill, { ...skill }, { name: 'off', description: 'd', scope: 'system', path: '/s/off/SKILL.md', enabled: false }] },
        ],
      },
      config: {
        config: {
          mcp_servers: {
            headroom: { command: 'headroom', args: ['mcp', 'serve'], env: { TOKEN: 'secret' } },
            docs: { url: 'https://x.test/mcp', http_headers: { Authorization: 'Bearer secret' } },
            'computer-use': { command: 'x', enabled: false },
          },
        },
      },
    });
    expect(parsed.skills).toEqual([
      { name: 'autoplan', description: 'Short', source: 'user', path: '/s/autoplan/SKILL.md', id: '/s/autoplan/SKILL.md' },
      { name: 'off', description: 'd', source: 'system', path: '/s/off/SKILL.md', id: '/s/off/SKILL.md', enabled: false },
    ]);
    expect(parsed.mcpServers).toEqual([
      { name: 'headroom', id: 'headroom', transport: 'stdio' },
      { name: 'docs', id: 'docs', transport: 'http' },
      { name: 'computer-use', id: 'computer-use', transport: 'stdio', status: 'disabled' },
    ]);
    expect(parsed).not.toHaveProperty('hooks');
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('reads hooks once each, installed plugins, and skills it no longer lists', () => {
    const hook = { key: 'h1', eventName: 'preToolUse', matcher: 'shell', source: 'user', sourcePath: '/u/.codex/hooks.json', enabled: true, command: 'x --token secret' };
    const parsed = parseCodexProbe({
      skills: { data: [{ cwd: '/p', skills: [{ name: 'mine', description: 'Mine', scope: 'user', path: '/s/mine/SKILL.md' }] }] },
      config: { config: { skills: { include_instructions: false } } },
      hooks: {
        data: [
          { cwd: '/p', hooks: [hook, { ...hook }, { key: 'h2', eventName: 'stop', matcher: '', source: 'plugin', pluginId: 'codex@openai', enabled: false }] },
        ],
      },
      plugins: {
        marketplaces: [
          {
            name: 'openai',
            plugins: [
              { id: 'codex@openai', installed: true, enabled: true },
              { id: 'old@openai', installed: true, enabled: false },
              { id: 'shop@openai', installed: false, enabled: false },
            ],
          },
        ],
      },
    });
    expect(parsed.skills).toEqual([{ name: 'mine', description: 'Mine', source: 'user', path: '/s/mine/SKILL.md', id: '/s/mine/SKILL.md', enabled: false }]);
    expect(parsed.hooks).toEqual([
      { event: 'preToolUse', id: 'h1', matcher: 'shell', source: 'user', file: '/u/.codex/hooks.json' },
      { event: 'stop', id: 'h2', source: 'plugin: codex@openai', enabled: false },
    ]);
    expect(parsed.plugins).toEqual([
      { name: 'codex@openai', id: 'codex@openai', source: 'openai' },
      { name: 'old@openai', id: 'old@openai', source: 'openai', enabled: false },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it("lists each MCP server's tools as mcpServerStatus/list gives them, not filtered by the config it echoes", () => {
    const parsed = parseCodexProbe({
      config: { config: { mcp_servers: { node: { command: 'n', disabled_tools: ['old'] }, broken: { command: 'b' }, quiet: { command: 'q' } } } },
      mcpStatus: {
        node: { data: [{ name: 'node', tools: { js: { name: 'js' }, old: { name: 'old' }, 'a/b': { name: 'a/b' } } }] },
        broken: { data: [{ name: 'broken', tools: {}, toolsError: 'MCP startup failed' }] },
      },
    });
    expect(parsed.mcpServers).toEqual([
      {
        name: 'node',
        id: 'node',
        transport: 'stdio',
        // Codex itself leaves out the tools it turned off; one it still lists is still there.
        tools: [
          { name: 'js', id: codexMcpToolId('node', 'js') },
          { name: 'old', id: codexMcpToolId('node', 'old') },
          { name: 'a/b', id: codexMcpToolId('node', 'a/b') },
        ],
      },
      // One that failed to start, or was not asked: its tools are not known.
      { name: 'broken', id: 'broken', transport: 'stdio' },
      { name: 'quiet', id: 'quiet', transport: 'stdio' },
    ]);
  });
});

describe('parseGrokInspect', () => {
  it('reads skills, MCP servers and instruction files from grok inspect', () => {
    expect(
      parseGrokInspect({
        skills: [
          { name: 'commit', description: 'Commit', source: { type: 'user', path: '/u/.grok/skills/commit/SKILL.md' } },
          { name: 'brainstorming', description: 'Ideas', source: { type: 'plugin', plugin_name: 'superpowers', path: '/p/SKILL.md' } },
        ],
        mcpServers: [
          { name: 'headroom', transport: 'stdio', target: 'headroom mcp serve', source: { type: 'claudeJson', path: '/u/.claude.json' }, disabled: true },
        ],
        projectInstructions: [{ path: '/u/.claude/Claude.md', scope: 'global', fileType: 'agents_md' }],
        hooks: [
          { event: '(plugin)', hookType: 'file', target: '/u/.claude/plugins/warp/hooks/hooks.json', source: { type: 'plugin', plugin_name: 'warp' }, matcher: null },
          { event: 'PreToolUse', hookType: 'command', target: 'curl -H "Authorization: secret"', source: { type: 'user' }, matcher: 'Bash' },
        ],
        agents: [
          { name: 'explore', description: 'Explore', source: { type: 'builtin' } },
          { name: 'codex:rescue', description: 'Rescue', source: { type: 'plugin', plugin_name: 'codex', path: '/p/agents/rescue.md' } },
        ],
        plugins: [{ name: 'warp', scope: 'user', path: '/u/.claude/plugins/warp', enabled: true, provides: { hooks: true } }],
      }),
    ).toEqual({
      skills: [
        { name: 'commit', description: 'Commit', source: 'user', path: '/u/.grok/skills/commit/SKILL.md' },
        { name: 'brainstorming', description: 'Ideas', source: 'plugin: superpowers', path: '/p/SKILL.md' },
      ],
      mcpServers: [{ name: 'headroom', transport: 'stdio', source: 'claudeJson', enabled: false }],
      memory: [{ path: '/u/.claude/Claude.md', kind: 'instructions' }],
      hooks: [
        { event: '(plugin)', source: 'plugin: warp', file: '/u/.claude/plugins/warp/hooks/hooks.json' },
        { event: 'PreToolUse', matcher: 'Bash', source: 'user' },
      ],
      agents: [
        { name: 'explore', description: 'Explore', source: 'built-in' },
        { name: 'codex:rescue', description: 'Rescue', source: 'plugin: codex' },
      ],
      plugins: [{ name: 'warp', source: 'user' }],
    });
    expect(parseGrokInspect(undefined)).toEqual({ skills: [], mcpServers: [], memory: [] });
  });
});

describe('memory files', () => {
  const repo = join(root, 'repo');
  const cwd = join(repo, 'packages', 'app');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(cwd, { recursive: true });

  it("finds Claude Code's CLAUDE.md files, rules and auto memory that exist", () => {
    const config = join(root, 'claude-config');
    const files = [
      file(join(config, 'CLAUDE.md')),
      file(join(config, 'rules', 'style.md')),
      file(join(repo, 'CLAUDE.md')),
      file(join(cwd, 'CLAUDE.local.md')),
      file(join(cwd, '.claude', 'CLAUDE.md')),
    ];
    const memory = file(join(config, 'projects', claudeProjectSlug(repo), 'memory', 'MEMORY.md'));
    const found = claudeMemoryFiles(cwd, config);
    expect(found.filter((f) => f.kind === 'instructions').map((f) => f.path)).toEqual(files);
    // Instruction files are left out one by one by their path; auto memory only all at once.
    expect(found.every((f) => (f.kind === 'instructions' ? f.id === f.path : f.id === undefined))).toBe(true);
    expect(found.filter((f) => f.kind === 'memory').map((f) => f.path)).toEqual([memory]);
    expect(claudeProjectSlug('/Users/me/my.app')).toBe('-Users-me-my-app');
  });

  it("finds Codex's AGENTS.md files from its home and the repository root down, an override first", () => {
    const home = join(root, 'codex-home');
    const global = file(join(home, 'AGENTS.md'));
    file(join(repo, 'AGENTS.md'));
    const override = file(join(repo, 'AGENTS.override.md'));
    const inner = file(join(cwd, 'AGENTS.md'));
    file(join(root, 'AGENTS.md')); // above the repository: not read
    const note = file(join(home, 'memories', 'note.md'));
    expect(codexMemoryFiles(cwd, home)).toEqual([
      { path: global, kind: 'instructions' },
      { path: override, kind: 'instructions' },
      { path: inner, kind: 'instructions' },
      { path: note, kind: 'memory' },
    ]);
  });
});

describe('listedFile', () => {
  it('lets only the files the CLI reported be read', () => {
    const probe = {
      memory: [{ path: '/u/.claude/CLAUDE.md', kind: 'instructions' as const }],
      skills: [{ name: 'commit', description: '', path: '/u/skills/commit/SKILL.md' }, { name: 'no-path', description: '' }],
    };
    expect(listedFile(probe, '/u/.claude/CLAUDE.md')).toBe(true);
    expect(listedFile(probe, '/u/skills/commit/SKILL.md')).toBe(true);
    expect(listedFile(probe, '/etc/passwd')).toBe(false);
    expect(listedFile(probe, '/u/.claude/../.claude/CLAUDE.md')).toBe(false);
    expect(listedFile(probe, '')).toBe(false);
  });
});

describe('NativeSetupService', () => {
  it('reports a CLI that cannot be started, and keeps answers for a minute per executable', async () => {
    let bin = join(root, 'no-such-cli');
    const service = new NativeSetupService({ bin: () => bin, env: () => process.env });
    const first = await service.get('grok', root);
    expect(first.problems).toMatchObject([{ kind: 'failed' }]);
    expect(first).toMatchObject({ provider: 'grok', cwd: root, skills: [], mcpServers: [] });
    expect(await service.get('grok', root)).toBe(first);
    expect(await service.get('grok', root, true)).not.toBe(first);
    bin = join(root, 'another-cli');
    expect(await service.get('grok', root)).not.toBe(first);
  });

  it("asks again when the CLI's home moved (the agent home setting)", async () => {
    const settings = new SettingsStore(openDatabase(':memory:'));
    settings.update('grok', { bin: join(root, 'no-such-cli') });
    const service = new NativeSetupService(settings);
    settings.setAgentHome(join(root, 'homes-a'));
    const first = await service.get('grok', root);
    expect(await service.get('grok', root)).toBe(first);
    settings.setAgentHome(join(root, 'homes-b'));
    const moved = await service.get('grok', root);
    expect(moved).not.toBe(first);
    settings.setAgentHome('');
    expect(await service.get('grok', root)).not.toBe(moved);
  });

  it('gives the latest answer however old, asking the CLI only when there is none', async () => {
    const bin = join(root, 'no-such-cli');
    const service = new NativeSetupService({ bin: () => bin, env: () => process.env });
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      const first = await service.latest('codex', root);
      expect(first.provider).toBe('codex');
      // An hour later, `get` asks again, `latest` (opening a reported file) does not.
      now.mockReturnValue(1_000_000 + 3_600_000);
      expect(await service.latest('codex', root)).toBe(first);
      const fresh = await service.get('codex', root);
      expect(fresh).not.toBe(first);
      expect(await service.latest('codex', root)).toBe(fresh);
    } finally {
      now.mockRestore();
    }
  });

  it('tells a probe that got nothing from one that got some of it, or answered its lists empty', () => {
    const empty = { skills: [], mcpServers: [] };
    const some = { skills: [{ name: 'commit' }], mcpServers: [] };
    expect(probeCompleteness({ ...some, problems: [] })).toBe('complete');
    expect(probeCompleteness({ ...empty, problems: [] })).toBe('complete'); // nothing of its own
    expect(probeCompleteness({ ...some, problems: [{ kind: 'failed', detail: 'x', refused: true }] })).toBe('incomplete');
    expect(probeCompleteness({ ...some, problems: [{ kind: 'timeout' }] })).toBe('incomplete');
    expect(probeCompleteness({ ...empty, problems: [{ kind: 'no-answer', part: 'mcp' }] })).toBe('incomplete');
    expect(probeCompleteness({ ...empty, problems: [{ kind: 'failed', detail: 'no hooks/list', refused: true }] })).toBe('incomplete');
    expect(probeCompleteness({ ...empty, problems: [{ kind: 'timeout' }] })).toBe('late');
    expect(probeCompleteness({ ...empty, problems: [{ kind: 'failed', detail: 'not found' }] })).toBe('failed');
    expect(probeCompleteness({ ...empty, problems: [{ kind: 'no-answer', part: 'all' }] })).toBe('failed');
    // Asking it again the way Harness Relay runs it is another matter: what it answered stands.
    expect(probeCompleteness({ ...some, problems: [{ kind: 'as-run', cause: { kind: 'timeout' } }] })).toBe('complete');
    expect(saidNothing({ ...empty, problems: [{ kind: 'no-answer', part: 'mcp' }] })).toBe(false);
    expect(saidNothing({ ...empty, problems: [{ kind: 'timeout' }] })).toBe(true);
  });

  // A stand-in for `grok inspect --json` that counts its runs in its home and names its skill after the count.
  const COUNTING_GROK = `#!/bin/sh
n=$(cat "$GROK_HOME/runs" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$GROK_HOME/runs"
printf '{"cwd": "%s", "skills": [{"name": "run-%s", "description": ""}]}' "$PWD" "$n"
`;
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt("gives the lead the last answer at once and asks again in the background once it is old; each account in its own home, with what it leaves out", async () => {
    const bin = join(root, 'counting-grok');
    writeFileSync(bin, COUNTING_GROK, { mode: 0o755 });
    const settings = new SettingsStore(openDatabase(':memory:'));
    settings.update('grok', { bin });
    settings.setAgentHome(join(root, 'recent-homes'));
    const work = settings.addAccount('grok', 'Work');
    const service = new NativeSetupService(settings);
    const skill = async (p: Promise<{ skills: { name: string }[] }>) => (await p).skills.map((x) => x.name);
    const real = Date.now.bind(Date);
    let shift = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => real() + shift);
    try {
      // None yet: it waits for the CLI.
      expect(await skill(service.recent('grok', root))).toEqual(['run-1']);
      expect(await skill(service.recent('grok', root))).toEqual(['run-1']); // fresh: not asked again
      // Two minutes later: the old answer at once, and a new question in the background.
      shift = 120_000;
      expect(await skill(service.recent('grok', root))).toEqual(['run-1']);
      await vi.waitFor(async () => expect(await skill(service.recent('grok', root))).toEqual(['run-2']));
      // Another account: its own home, its own answers.
      expect(await skill(service.recent('grok', root, work))).toEqual(['run-1']);
      expect(readFileSync(join(settings.accountHome('grok', work)!, 'runs'), 'utf8').trim()).toBe('1');
      expect(readFileSync(join(settings.accountHome('grok')!, 'runs'), 'utf8').trim()).toBe('2');
      // What is left out changed: the old answer no longer fits, so it waits for a new one.
      settings.updateAccount('grok', '', { nativeOff: ['skills'] });
      const changed = await service.recent('grok', root);
      expect(changed.nativeOff).toEqual(['skills']);
      // Each account leaves out its own: the other account's answer is still its own, as it was.
      expect((await service.recent('grok', root, work)).nativeOff).toEqual([]);
      settings.updateAccount('grok', work, { nativeOff: ['hooks'] });
      const own = await service.recent('grok', root, work);
      expect([own.nativeOff, own.skills.map((x) => x.name)]).toEqual([['hooks'], ['run-2']]);
      const runs = () => readFileSync(join(settings.accountHome('grok', work)!, 'runs'), 'utf8').trim();
      const before = runs();
      expect((await service.get('grok', root, false, work)).nativeOff).toEqual(['hooks']);
      expect(runs()).toBe(before); // kept: not asked again
      // The latest answer of each account, for opening a file it reported.
      expect((await service.latest('grok', root, work)).nativeOff).toEqual(['hooks']);
      expect((await service.latest('grok', root)).nativeOff).toEqual(['skills']);
    } finally {
      now.mockRestore();
    }
  });

  it('puts problems into words in the language of each request, not when the answer is cached', () => {
    const probe = {
      provider: 'codex' as const,
      cwd: root,
      skills: [],
      mcpServers: [],
      memory: [],
      memoryFromFiles: true,
      nativeOff: [],
      nativeItems: {},
      asRun: false,
      problems: [
        { kind: 'timeout' as const },
        { kind: 'no-answer' as const, part: 'mcp' as const },
        { kind: 'no-answer' as const, part: 'hooks' as const },
        { kind: 'as-run' as const, cause: { kind: 'failed' as const, detail: 'invalid transport' } },
      ],
      checkedAt: 1,
    };
    expect(withLang('en', () => nativeForClient(probe).errors)).toEqual([
      'Codex did not answer in time.',
      'Codex did not report its MCP servers.',
      'Codex did not report its hooks.',
      'Asking Codex again the way Harness Relay starts it failed, so what is left out is not marked: Codex reported an error: invalid transport',
    ]);
    expect(withLang('zh-TW', () => nativeForClient(probe).errors)).toEqual([
      'Codex 沒有在時間內回應。',
      'Codex 沒有回報它的 MCP 伺服器。',
      'Codex 沒有回報它的 hook。',
      '依 Harness Relay 啟動 Codex 的方式再問一次時失敗，所以沒有標示哪些項目不載入：Codex 回報錯誤：invalid transport',
    ]);
    expect(nativeForClient(probe)).not.toHaveProperty('problems');
  });
});

describe('marking what Harness Relay leaves out', () => {
  it('marks what the CLI loads by itself but not when asked the way Harness Relay starts it', () => {
    const own = {
      skills: [
        { name: 'kept', description: '' },
        { name: 'gone', description: '', path: '/s/gone/SKILL.md' },
        { name: 'off', description: '', enabled: false },
      ],
      mcpServers: [{ name: 'headroom' }, { name: 'old', status: 'disabled' }],
      memory: [{ path: '/AGENTS.md', kind: 'instructions' as const }],
      hooks: [{ event: 'stop', source: 'user' }],
      agents: [{ name: 'reviewer', description: '' }],
      plugins: [{ name: 'deck@market' }],
    };
    const marked = markLeftOut(own, {
      skills: [{ name: 'kept', description: '' }],
      mcpServers: [{ name: 'headroom', status: 'disabled' }],
      memory: [{ path: '/AGENTS.md', kind: 'instructions', enabled: false }],
      hooks: [{ event: 'stop', source: 'user', enabled: false }],
      agents: [{ name: 'reviewer', description: '', enabled: false }],
      // No plugins in the second answer: that list stays unmarked.
    });
    expect(marked.skills).toEqual([
      { name: 'kept', description: '' },
      { name: 'gone', description: '', path: '/s/gone/SKILL.md', leftOut: true },
      // Off by itself already: not something Harness Relay leaves out.
      { name: 'off', description: '', enabled: false },
    ]);
    expect(marked.mcpServers).toEqual([{ name: 'headroom', leftOut: true }, { name: 'old', status: 'disabled' }]);
    expect(marked.memory).toEqual([{ path: '/AGENTS.md', kind: 'instructions', leftOut: true }]);
    expect(marked.hooks).toEqual([{ event: 'stop', source: 'user', leftOut: true }]);
    expect(marked.agents).toEqual([{ name: 'reviewer', description: '', leftOut: true }]);
    expect(marked.plugins).toEqual([{ name: 'deck@market' }]);
    expect(markLeftOut({ skills: [], mcpServers: [], memory: [] }, {})).toEqual({ skills: [], mcpServers: [], memory: [] });
  });

  it('marks an item picked to be left out that the second answer still loads, only in the lists it gave', () => {
    const own = {
      skills: [{ name: 'kept', description: '', id: 'kept' }, { name: 'gone', description: '', id: 'gone' }],
      mcpServers: [
        { name: 'local', id: 'mcp__local', tools: [{ name: 'a', id: 'mcp__local__a' }, { name: 'b', id: 'mcp__local__b' }] },
        { name: 'auth', id: 'mcp__auth', status: 'needs-auth' },
      ],
      memory: [],
      plugins: [{ name: 'deck', id: 'deck' }],
    };
    const items = { skills: ['kept', 'gone'], mcpTools: ['mcp__local__a'], mcp: ['mcp__auth'], plugins: ['deck'] };
    const marked = markLeftOut(
      own,
      {
        skills: [{ name: 'kept', description: '', id: 'kept' }],
        mcpServers: [{ name: 'local', tools: [{ name: 'a' }, { name: 'b' }] }, { name: 'auth', status: 'needs-auth' }],
        memory: [],
        // No plugins the second time: not judged.
      },
      items,
      true,
    );
    expect(marked.skills).toEqual([
      { name: 'kept', description: '', id: 'kept', stillLoaded: true },
      { name: 'gone', description: '', id: 'gone', leftOut: true },
    ]);
    expect(marked.mcpServers[0]!.tools).toEqual([
      { name: 'a', id: 'mcp__local__a', stillLoaded: true },
      { name: 'b', id: 'mcp__local__b' },
    ]);
    // Claude Code takes a server's tools away; with none listed, whether it did cannot be told.
    expect(marked.mcpServers[1]).toEqual(own.mcpServers[1]);
    expect(marked.plugins).toEqual(own.plugins);
    // Codex turns a server off, which its answer shows whatever its tools.
    const codex = markLeftOut({ ...own, plugins: undefined }, { mcpServers: [{ name: 'auth' }] }, { mcp: ['mcp__auth', 'auth'] });
    expect(codex.mcpServers[0]).toMatchObject({ name: 'local', leftOut: true });
    expect(markLeftOut({ skills: [], mcpServers: [{ name: 'auth', id: 'auth' }], memory: [] }, { mcpServers: [{ name: 'auth' }] }, { mcp: ['auth'] }).mcpServers).toEqual([
      { name: 'auth', id: 'auth', stillLoaded: true },
    ]);
  });

  it("knows which files Claude Code and Codex skip with their variables and settings", () => {
    const files = [
      { path: '/u/.claude/CLAUDE.md', kind: 'instructions' as const },
      { path: '/u/.claude/projects/p/memory/MEMORY.md', kind: 'memory' as const },
    ];
    expect(claudeMemoryState(files, {})).toEqual(files);
    expect(claudeMemoryState(files, { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' })).toEqual([{ ...files[0], enabled: false }, files[1]]);
    expect(claudeMemoryState(files, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' })).toEqual([files[0], { ...files[1], enabled: false }]);
    // A file excluded by its path (`claudeMdExcludes`); memory is not reached that way.
    expect(claudeMemoryState(files, {}, ['/u/.claude/CLAUDE.md', '/u/.claude/projects/p/memory/MEMORY.md'])).toEqual([{ ...files[0], enabled: false }, files[1]]);

    const home = join(root, 'codex-state-home');
    const codex = [
      { path: join(home, 'AGENTS.md'), kind: 'instructions' as const },
      { path: join(root, 'repo', 'AGENTS.md'), kind: 'instructions' as const },
      { path: join(home, 'memories', 'note.md'), kind: 'memory' as const },
    ];
    expect(codexMemoryState(codex, home, { config: {} })).toEqual(codex);
    // Its own ~/.codex/AGENTS.md is read whatever project_doc_max_bytes says.
    expect(codexMemoryState(codex, home, { config: { project_doc_max_bytes: 0, features: { memories: false } } })).toEqual([
      codex[0],
      { ...codex[1], enabled: false },
      { ...codex[2], enabled: false },
    ]);
  });
});

describe('asking again the way Harness Relay starts each CLI (stand-in CLIs)', () => {
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, ...extra });

  it('Claude Code: marks the skills, MCP servers, hooks, subagents, plugins and files a run leaves out', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-probe'));
    const config = join(root, 'claude-probe-config');
    const instructions = file(join(config, 'CLAUDE.md'));
    const cwd = join(root, 'claude-probe-cwd');
    mkdirSync(cwd, { recursive: true });
    const service = new NativeSetupService({
      bin: () => bin,
      env: () => env({ CLAUDE_CONFIG_DIR: config }),
      nativeOff: () => ['skills', 'mcp', 'instructions', 'hooks', 'agents', 'plugins'],
    });
    const probe = await service.get('claude', cwd);
    expect(probe.problems).toEqual([]);
    expect(probe).toMatchObject({ asRun: true, nativeOff: ['skills', 'mcp', 'instructions', 'hooks', 'agents', 'plugins'] });
    expect(probe.skills).toEqual([
      { name: 'commit', description: 'commit it', id: 'commit', leftOut: true },
      { name: 'deck:slides', description: 'deck:slides it', id: 'deck:slides', leftOut: true },
    ]);
    expect(probe.mcpServers).toEqual([
      {
        name: 'local',
        id: 'mcp__local',
        status: 'connected',
        source: 'user',
        transport: 'stdio',
        tools: [
          { name: 'search', id: 'mcp__local__search' },
          { name: 'fetch', id: 'mcp__local__fetch' },
        ],
        leftOut: true,
      },
    ]);
    // Its built-in tools, from the tools turn: none of them is left out by these switches.
    expect(probe.builtinTools).toEqual(['Bash', 'Read', 'Edit', 'WebSearch'].map((name) => ({ name, id: name })));
    expect(probe.hooks).toEqual([{ event: 'SessionStart', source: 'userSettings', leftOut: true }]);
    expect(probe.agents).toEqual([
      { name: 'general-purpose', description: 'The general-purpose', id: 'general-purpose', source: 'built-in' },
      { name: 'Explore', description: 'The Explore', id: 'Explore', source: 'built-in' },
      { name: 'reviewer', description: 'The reviewer', id: 'reviewer', leftOut: true },
      { name: 'deck:designer', description: 'The deck:designer', id: 'deck:designer', leftOut: true },
    ]);
    // lsp@market is off by itself, so it is not something Harness Relay leaves out.
    expect(probe.plugins).toEqual([
      { name: 'deck@market', id: 'deck@market', source: 'user', leftOut: true },
      { name: 'lsp@market', id: 'lsp@market', source: 'project', enabled: false },
    ]);
    expect(probe.memory).toEqual([{ path: instructions, kind: 'instructions', id: instructions, leftOut: true }]);
    expect(JSON.stringify(probe)).not.toContain('secret');
  });

  it('Claude Code: marks the single skills, tools, MCP servers and tools, subagents, plugins and files a run leaves out', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-items'));
    const log = join(root, 'claude-items.jsonl');
    const config = join(root, 'claude-items-config');
    const kept = file(join(config, 'CLAUDE.md'));
    const cwd = join(root, 'claude-items-cwd');
    const dropped = file(join(cwd, 'CLAUDE.md'));
    const service = new NativeSetupService({
      bin: () => bin,
      env: () => env({ CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_LOG: log }),
      nativeItems: () => ({
        skills: ['commit'],
        tools: ['WebSearch'],
        mcpTools: ['mcp__local__fetch'],
        agents: ['Explore'],
        plugins: ['deck@market'],
        instructions: [dropped],
      }),
    });
    const probe = await service.get('claude', cwd);
    expect(probe.problems).toEqual([]);
    expect(probe.asRun).toBe(true);
    expect(probe.nativeItems.skills).toEqual(['commit']);
    // The plugin's command and subagent go with it.
    expect(probe.skills.map((x) => [x.name, x.leftOut])).toEqual([
      ['commit', true],
      ['deck:slides', true],
    ]);
    expect(probe.builtinTools?.filter((x) => x.leftOut).map((x) => x.name)).toEqual(['WebSearch']);
    expect(probe.mcpServers[0]).toMatchObject({ name: 'local', tools: [{ name: 'search' }, { name: 'fetch', leftOut: true }] });
    expect(probe.mcpServers[0]!.leftOut).toBeUndefined();
    // A built-in subagent can be left out by name too.
    expect(probe.agents?.filter((a) => a.leftOut).map((a) => a.name)).toEqual(['Explore', 'deck:designer']);
    expect(probe.plugins?.map((p) => [p.name, p.leftOut])).toEqual([
      ['deck@market', true],
      ['lsp@market', undefined],
    ]);
    expect(probe.memory).toEqual([
      { path: kept, kind: 'instructions', id: kept },
      { path: dropped, kind: 'instructions', id: dropped, leftOut: true },
    ]);
    // Asked with the run's settings; the only prompt either Claude Code got was /usage, without a session file.
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args?: string[]; prompt?: string; settings?: object });
    // In a private file, removed once asked.
    const asRun = lines.find((l) => l.args?.includes('--settings'))!;
    expect(existsSync(asRun.args![asRun.args!.indexOf('--settings') + 1]!)).toBe(false);
    const settings = lines.flatMap((l) => (l.args?.includes('--settings') ? [l.settings] : []));
    expect(settings).toContainEqual({
      enabledPlugins: { 'deck@market': false },
      skillOverrides: { commit: 'off' },
      claudeMdExcludes: [dropped],
      permissions: { deny: ['WebSearch', 'mcp__local__fetch', 'Agent(Explore)'] },
    });
    expect(lines.filter((l) => 'prompt' in l).map((l) => l.prompt)).toEqual(['/usage', '/usage']);
    expect(lines.filter((l) => l.args?.includes('-p') && !l.args.includes('--setting-sources')).every((l) => l.args!.includes('--no-session-persistence'))).toBe(true);
  });

  it('Claude Code: marks a whole MCP server whose tools a run takes away, though it still starts', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-server'));
    const service = new NativeSetupService({ bin: () => bin, env: () => env(), nativeItems: () => ({ mcp: ['mcp__local'] }) });
    const probe = await service.get('claude', join(root, 'claude-probe-cwd'));
    expect(probe.problems).toEqual([]);
    expect(probe.mcpServers).toEqual([
      expect.objectContaining({ name: 'local', status: 'connected', leftOut: true, tools: [expect.not.objectContaining({ leftOut: true }), expect.anything()] }),
    ]);
  });

  it('Claude Code: sends /usage again with all its skills left out (it lists no commands then, but answers it by itself)', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-noskills'));
    const log = join(root, 'claude-noskills.jsonl');
    const service = new NativeSetupService({ bin: () => bin, env: () => env({ FAKE_CLAUDE_LOG: log }), nativeOff: () => ['skills'], nativeItems: () => ({ tools: ['WebSearch'] }) });
    const probe = await service.get('claude', join(root, 'claude-probe-cwd'));
    expect(probe.problems).toEqual([]);
    expect(probe.skills.every((x) => x.leftOut)).toBe(true);
    expect(probe.builtinTools?.filter((x) => x.leftOut).map((x) => x.name)).toEqual(['WebSearch']);
    expect(readFileSync(log, 'utf8').match(/"prompt":"\/usage"/g)).toHaveLength(2);
  });

  it('Claude Code: keeps what it answered when asking again runs out of time', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-hang'));
    const service = new NativeSetupService(
      { bin: () => bin, env: () => env({ FAKE_CLAUDE_HANG_AS_RUN: '1' }), nativeItems: () => ({ skills: ['commit'], tools: ['WebSearch'] }) },
      3000,
    );
    const probe = await service.get('claude', join(root, 'claude-probe-cwd'));
    expect(probe.asRun).toBe(true);
    // Its control requests were answered: the skill is marked. Its tools turn was not: not marked, and said so.
    expect(probe.skills.find((x) => x.name === 'commit')?.leftOut).toBe(true);
    expect(probe.builtinTools?.some((x) => x.leftOut)).toBe(false);
    expect(probe.problems).toEqual([{ kind: 'as-run-partial' }, { kind: 'as-run', cause: { kind: 'no-answer', part: 'tools' } }]);
    expect(withLang('en', () => nativeForClient(probe).errors[0])).toBe(
      'Asking Claude Code again the way Harness Relay starts it ran out of time: what it had answered is marked, the rest is not.',
    );
  });

  it('Claude Code: never sends /usage when a skill of that name would take it to the model', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-usage'));
    const log = join(root, 'claude-usage.jsonl');
    const service = new NativeSetupService({ bin: () => bin, env: () => env({ FAKE_CLAUDE_OWN_USAGE: '1', FAKE_CLAUDE_LOG: log }), nativeItems: () => ({ tools: ['Bash'] }) });
    const probe = await service.get('claude', join(root, 'claude-probe-cwd'));
    expect(readFileSync(log, 'utf8')).not.toContain('"prompt"');
    expect(probe.builtinTools).toBeUndefined();
    // Said once: with no list the first time, there is nothing the second answer could leave unmarked.
    expect(probe.problems).toEqual([{ kind: 'no-answer', part: 'tools' }]);
  });

  it('Claude Code: asks without the tools turn when it does not know --no-session-persistence', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-nosession'));
    const service = new NativeSetupService({ bin: () => bin, env: () => env({ FAKE_CLAUDE_NO_SESSION_FLAG: '1' }), nativeOff: () => ['skills'] });
    const probe = await service.get('claude', join(root, 'claude-probe-cwd'));
    expect(probe.asRun).toBe(true);
    expect(probe.skills.every((x) => x.leftOut)).toBe(true);
    expect(probe.builtinTools).toBeUndefined();
    expect(probe.mcpServers.map((x) => x.name)).toEqual(['local']);
    expect(probe.problems).toEqual([{ kind: 'no-answer', part: 'tools' }]);
  });

  it('Claude Code: does not count a subagent that replaces a built-in one as built-in', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-own'));
    const service = new NativeSetupService({ bin: () => bin, env: () => env({ FAKE_CLAUDE_OWN_EXPLORE: '1' }), nativeOff: () => ['agents'] });
    const probe = await service.get('claude', join(root, 'claude-probe-cwd'));
    expect(probe.problems).toEqual([]);
    expect(probe.agents?.find((a) => a.name === 'Explore')).toEqual({ name: 'Explore', description: 'My own Explore', id: 'Explore', leftOut: true });
    expect(probe.agents?.find((a) => a.name === 'general-purpose')).toEqual({
      name: 'general-purpose',
      description: 'The general-purpose',
      id: 'general-purpose',
      source: 'built-in',
    });
  });

  it('Claude Code: is not started again when only its instruction files or memory are left out', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-files'));
    const log = join(root, 'claude-files.jsonl');
    const config = join(root, 'claude-files-config');
    const instructions = file(join(config, 'CLAUDE.md'));
    const service = new NativeSetupService({
      bin: () => bin,
      env: () => env({ CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_LOG: log }),
      nativeOff: () => ['memory'],
      nativeItems: () => ({ instructions: [instructions] }),
    });
    const probe = await service.get('claude', join(root, 'claude-probe-cwd'));
    expect(probe).toMatchObject({ asRun: true, problems: [] });
    expect(probe.memory).toEqual([{ path: instructions, kind: 'instructions', id: instructions, leftOut: true }]);
    const starts = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args?: string[] })
      .filter((l) => l.args && !l.args.includes('--setting-sources'));
    expect(starts).toHaveLength(1);
  });

  it('Claude Code: names the lists its second answer lacked, and leaves them unmarked', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-partial'));
    const service = new NativeSetupService({ bin: () => bin, env: () => env({ FAKE_CLAUDE_NO_HOOKS_AS_RUN: '1' }), nativeOff: () => ['hooks', 'skills'] });
    const probe = await service.get('claude', join(root, 'claude-probe-cwd'));
    expect(probe.asRun).toBe(true);
    expect(probe.problems).toEqual([{ kind: 'as-run', cause: { kind: 'no-answer', part: 'hooks' } }]);
    expect(probe.hooks).toEqual([{ event: 'SessionStart', source: 'userSettings' }]);
    expect(probe.skills.every((s) => s.leftOut)).toBe(true);
  });

  it("Claude Code: says so when it cannot list its plugins, and asks again only when that matters", async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-noplugins'));
    const cwd = join(root, 'claude-probe-cwd');
    const off = new NativeSetupService({ bin: () => bin, env: () => env({ FAKE_CLAUDE_NO_PLUGINS: '1' }), nativeOff: () => ['plugins'] });
    const probe = await off.get('claude', cwd);
    expect(probe.asRun).toBe(false);
    expect(probe.plugins).toBeUndefined();
    expect(probe.problems).toEqual([
      { kind: 'no-answer', part: 'plugins' },
      { kind: 'as-run', cause: { kind: 'failed', detail: 'unknown command plugin' } },
    ]);
    // Plugins not left out: the rest is still checked.
    const on = new NativeSetupService({ bin: () => bin, env: () => env({ FAKE_CLAUDE_NO_PLUGINS: '1' }), nativeOff: () => ['skills'] });
    const other = await on.get('claude', cwd);
    expect(other.asRun).toBe(true);
    expect(other.problems).toEqual([{ kind: 'no-answer', part: 'plugins' }]);
  });

  it('Claude Code: says so when its subagents cannot be left out, and marks nothing', async () => {
    const bin = writeFakeClaude(join(root, 'fake-claude-old'));
    const cwd = join(root, 'claude-probe-cwd');
    const service = new NativeSetupService({ bin: () => bin, env: () => env({ FAKE_CLAUDE_NO_APPLY: '1' }), nativeOff: () => ['agents'] });
    const probe = await service.get('claude', cwd);
    expect(probe.asRun).toBe(false);
    expect(probe.problems).toEqual([{ kind: 'as-run', cause: { kind: 'failed', detail: 'Unsupported control request subtype: apply_flag_settings' } }]);
    expect(probe.agents?.some((a) => a.leftOut)).toBe(false);

    // An answer without its subagents could not be compared either (the built-in ones are known from above).
    const unlisted = new NativeSetupService({ bin: () => bin, env: () => env({ FAKE_CLAUDE_NO_AGENTS: '1' }), nativeOff: () => ['agents'] });
    const none = await unlisted.get('claude', cwd);
    expect(none.asRun).toBe(false);
    expect(none.problems).toEqual([{ kind: 'as-run', cause: { kind: 'no-answer', part: 'agents' } }]);
  });

  it('Codex: asks with the same overrides as a thread, and marks what they leave out', async () => {
    const FAKE_CODEX = `#!/usr/bin/env node
const args = process.argv.slice(2);
const set = []; for (let i = 0; i < args.length; i++) if (args[i] === '-c') set.push(args[++i]);
const has = (s) => set.includes(s);
const mcp = set.find((s) => s.startsWith('mcp_servers=')) || '';
const servers = { headroom: { command: 'headroom', env: { TOKEN: 'secret' } }, 'a.b': { url: 'https://x.test/mcp' } };
for (const name of Object.keys(servers)) if (mcp.includes(JSON.stringify(name) + ' = { "enabled" = false }')) servers[name].enabled = false;
if (mcp.includes('"headroom" = { "disabled_tools" = ["fetch"] }')) servers.headroom.disabled_tools = ['fetch'];
const pluginsOff = has('features.plugins=false');
const setting = (key) => set.find((s) => s.startsWith(key + '=')) || '';
const skillOff = (path) => setting('skills.config').includes(JSON.stringify(path) + ', "enabled" = false');
const hookOff = setting('hooks.state').includes('"h1" = { "enabled" = false }');
const deckOff = setting('plugins').includes('"deck@market" = { "enabled" = false }');
const answers = {
  'skills/list': { data: [{ cwd: process.cwd(), skills: [{ name: 'mine', description: 'Mine', scope: 'user', path: '/s/mine/SKILL.md' }].concat(pluginsOff || deckOff ? [] : [{ name: 'deck', description: 'Deck', scope: 'user', path: '/p/deck/SKILL.md' }]).map((x) => ({ ...x, enabled: !skillOff(x.path) })) }] },
  'config/read': { config: { mcp_servers: servers, ...(has('skills.include_instructions=false') ? { skills: { include_instructions: false } } : {}), ...(has('project_doc_max_bytes=0') ? { project_doc_max_bytes: 0 } : {}) } },
  'hooks/list': { data: [{ cwd: process.cwd(), hooks: has('features.hooks=false') ? [] : [{ key: 'h1', eventName: 'preToolUse', matcher: 'shell', source: 'user', sourcePath: '/u/.codex/hooks.json', enabled: !hookOff }] }] },
  'plugin/installed': { marketplaces: [{ name: 'market', plugins: pluginsOff ? [] : [{ id: 'deck@market', installed: true, enabled: !deckOff }, { id: 'old@market', installed: true, enabled: false }] }] },
};
// A server's tools, without those its config turns off; asking starts it (logged).
const status = (name) => {
  if (process.env.FAKE_CODEX_LOG) require('node:fs').appendFileSync(process.env.FAKE_CODEX_LOG, name + '\\n');
  const off = process.env.FAKE_CODEX_IGNORE_TOOLS ? [] : servers[name].disabled_tools || [];
  return { data: [{ name, tools: Object.fromEntries(['search', 'fetch'].filter((t) => !off.includes(t)).map((t) => [t, { name: t }])) }] };
};
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === 'initialize' ? {} : m.method === 'mcpServerStatus/list' ? status(m.params.serverName) : answers[m.method];
  process.stdout.write(JSON.stringify(result ? { id: m.id, result } : { id: m.id, error: { message: 'unknown method' } }) + '\\n');
});
`;
    const bin = join(root, 'fake-codex');
    writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
    const home = join(root, 'codex-probe-home');
    const own = file(join(home, 'AGENTS.md'));
    const repo = join(root, 'codex-probe-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const project = file(join(repo, 'AGENTS.md'));
    const service = new NativeSetupService({
      bin: () => bin,
      env: () => env({ CODEX_HOME: home }),
      nativeOff: () => ['skills', 'mcp', 'instructions', 'hooks', 'plugins'],
    });
    const probe = await service.get('codex', repo);
    expect(probe.problems).toEqual([]);
    expect(probe.asRun).toBe(true);
    expect(probe.skills.map((s) => [s.name, s.leftOut])).toEqual([
      ['mine', true],
      ['deck', true],
    ]);
    // Each of the user's servers turned off in one table, whatever its name; their tools from the first answer.
    const tools = (server: string) => ['search', 'fetch'].map((name) => ({ name, id: codexMcpToolId(server, name) }));
    expect(probe.mcpServers).toEqual([
      { name: 'headroom', id: 'headroom', transport: 'stdio', tools: tools('headroom'), leftOut: true },
      { name: 'a.b', id: 'a.b', transport: 'http', tools: tools('a.b'), leftOut: true },
    ]);
    expect(probe.hooks).toEqual([{ event: 'preToolUse', id: 'h1', matcher: 'shell', source: 'user', file: '/u/.codex/hooks.json', leftOut: true }]);
    expect(probe.plugins).toEqual([
      { name: 'deck@market', id: 'deck@market', source: 'market', leftOut: true },
      { name: 'old@market', id: 'old@market', source: 'market', enabled: false },
    ]);
    expect(probe.memory).toEqual([
      { path: own, kind: 'instructions' },
      { path: project, kind: 'instructions', leftOut: true },
    ]);
    expect(JSON.stringify(probe)).not.toContain('secret');

    // Single items: a skill by path, a server, a tool of another, a hook and a plugin (with its skill).
    const log = join(root, 'codex-items.log');
    const items = new NativeSetupService({
      bin: () => bin,
      env: () => env({ CODEX_HOME: home, FAKE_CODEX_LOG: log }),
      nativeItems: () => ({
        skills: ['/s/mine/SKILL.md'],
        mcp: ['a.b'],
        mcpTools: [codexMcpToolId('headroom', 'fetch')],
        hooks: ['h1'],
        plugins: ['deck@market'],
      }),
    });
    const picked = await items.get('codex', repo);
    expect(picked.problems).toEqual([]);
    expect(picked.asRun).toBe(true);
    expect(picked.skills.map((s) => [s.name, s.leftOut])).toEqual([
      ['mine', true],
      ['deck', true],
    ]);
    expect(picked.mcpServers).toEqual([
      { name: 'headroom', id: 'headroom', transport: 'stdio', tools: [tools('headroom')[0], { ...tools('headroom')[1], leftOut: true }] },
      { name: 'a.b', id: 'a.b', transport: 'http', tools: tools('a.b'), leftOut: true },
    ]);
    expect(picked.hooks?.[0]?.leftOut).toBe(true);
    expect(picked.plugins?.map((p) => [p.name, p.leftOut])).toEqual([
      ['deck@market', true],
      ['old@market', undefined],
    ]);
    // A server turned off is not started the second time to list its tools.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['headroom', 'a.b', 'headroom']);

    // A Codex that ignored disabled_tools (though its config echoes them) still lists the tool: not marked.
    const ignoring = new NativeSetupService({
      bin: () => bin,
      env: () => env({ CODEX_HOME: home, FAKE_CODEX_IGNORE_TOOLS: '1' }),
      nativeItems: () => ({ mcpTools: [codexMcpToolId('headroom', 'fetch')] }),
    });
    const ignored = await ignoring.get('codex', repo);
    expect(ignored.mcpServers[0]!.tools).toEqual([tools('headroom')[0], { ...tools('headroom')[1], stillLoaded: true }]);
  });

  it("Grok: asks with the run's variables, and marks what Grok then reports turned off", async () => {
    const FAKE_GROK = `#!/usr/bin/env node
const off = (v) => process.env[v] === 'false';
process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  projectRoot: null,
  projectTrusted: true,
  skills: [
    { name: 'own', description: 'Own', source: { type: 'user', path: '/u/.agents/skills/own/SKILL.md' } },
    { name: 'imported', description: 'From Claude Code', source: { type: 'user', path: '/u/.claude/skills/imported/SKILL.md' }, ...(off('GROK_CLAUDE_SKILLS_ENABLED') ? { disabled: true } : {}) },
  ],
  mcpServers: [{ name: 'headroom', transport: 'stdio', target: 'headroom --token secret', source: { type: 'claudeJson' }, ...(off('GROK_CLAUDE_MCPS_ENABLED') ? { disabled: true } : {}) }],
  hooks: [{ event: '(plugin)', hookType: 'file', target: '/u/.claude/plugins/x/hooks/hooks.json', source: { type: 'plugin', plugin_name: 'x' } }],
  agents: [{ name: 'explore', description: 'Explore', source: { type: 'builtin' } }],
  plugins: [{ name: 'x', scope: 'user', enabled: true }],
  projectInstructions: [{ path: '/u/AGENTS.md' }],
}));
`;
    const bin = join(root, 'fake-grok-probe');
    writeFileSync(bin, FAKE_GROK, { mode: 0o755 });
    const service = new NativeSetupService({ bin: () => bin, env: () => env(), nativeOff: () => ['skills', 'mcp', 'hooks'] });
    const probe = await service.get('grok', root);
    expect(probe.problems).toEqual([]);
    expect(probe.asRun).toBe(true);
    expect(probe.skills.map((s) => [s.name, s.leftOut])).toEqual([
      ['own', undefined],
      ['imported', true],
    ]);
    expect(probe.mcpServers).toEqual([{ name: 'headroom', transport: 'stdio', source: 'claudeJson', leftOut: true }]);
    // A plugin's hook is not one the switch reaches, and Grok still reports it on.
    expect(probe.hooks).toEqual([{ event: '(plugin)', source: 'plugin: x', file: '/u/.claude/plugins/x/hooks/hooks.json' }]);
    expect(probe.folderTrusted).toBe(true);
    expect(JSON.stringify(probe)).not.toContain('secret');

    // Nothing left out: asked once, nothing marked.
    const plain = await new NativeSetupService({ bin: () => bin, env: () => env() }).get('grok', root);
    expect(plain).toMatchObject({ asRun: false, nativeOff: [] });
    expect(plain.skills.some((s) => s.leftOut)).toBe(false);
  });
});

describe('NativeSetupService and the parts left out', () => {
  it('asks again when what is left out changes, while the latest answer stays for opening files', async () => {
    const bin = join(root, 'no-such-cli');
    let off: ('skills' | 'mcp')[] = [];
    const service = new NativeSetupService({ bin: () => bin, env: () => process.env, nativeOff: () => off });
    const first = await service.get('grok', root);
    expect(first.nativeOff).toEqual([]);
    expect(await service.get('grok', root)).toBe(first);
    off = ['skills'];
    expect(await service.latest('grok', root)).toBe(first);
    const second = await service.get('grok', root);
    expect(second).not.toBe(first);
    expect(second.nativeOff).toEqual(['skills']);
    expect(await service.get('grok', root)).toBe(second);
  });
});
