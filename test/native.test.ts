import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { withLang } from '../src/server/i18n';
import {
  NativeSetupService,
  claudeMemoryFiles,
  listedFile,
  nativeForClient,
  claudeProjectSlug,
  codexMemoryFiles,
  parseClaudeProbe,
  parseCodexProbe,
  parseGrokInspect,
} from '../src/server/native';

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
    const parsed = parseClaudeProbe(init, mcp);
    expect(parsed.skills).toEqual([
      { name: 'hf-cli', description: 'Hugging Face Hub CLI' },
      { name: 'impeccable:impeccable', description: 'Design work' },
    ]);
    expect(parsed.mcpServers).toEqual([
      { name: 'claude.ai Claude Docs', status: 'connected', source: 'claudeai', transport: 'claudeai-proxy', tools: 2 },
      { name: 'local', status: 'failed', source: 'user', transport: 'stdio' },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('secret');
    expect(parseClaudeProbe(undefined, undefined)).toEqual({ skills: [], mcpServers: [] });
  });
});

describe('parseCodexProbe', () => {
  it('lists skills once each and configured MCP servers by name and kind only', () => {
    const skill = { name: 'autoplan', description: 'Long', shortDescription: 'Short', scope: 'user', path: '/s/autoplan/SKILL.md', enabled: true };
    const parsed = parseCodexProbe(
      {
        data: [
          { cwd: '/p', errors: [], skills: [skill, { ...skill }, { name: 'off', description: 'd', scope: 'system', path: '/s/off/SKILL.md', enabled: false }] },
        ],
      },
      {
        config: {
          mcp_servers: {
            headroom: { command: 'headroom', args: ['mcp', 'serve'], env: { TOKEN: 'secret' } },
            docs: { url: 'https://x.test/mcp', http_headers: { Authorization: 'Bearer secret' } },
            'computer-use': { command: 'x', enabled: false },
          },
        },
      },
    );
    expect(parsed.skills).toEqual([
      { name: 'autoplan', description: 'Short', source: 'user', path: '/s/autoplan/SKILL.md' },
      { name: 'off', description: 'd', source: 'system', path: '/s/off/SKILL.md', enabled: false },
    ]);
    expect(parsed.mcpServers).toEqual([
      { name: 'headroom', transport: 'stdio' },
      { name: 'docs', transport: 'http' },
      { name: 'computer-use', transport: 'stdio', status: 'disabled' },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('secret');
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
        mcpServers: [{ name: 'headroom', transport: 'stdio', target: 'headroom mcp serve', source: { type: 'claudeJson', path: '/u/.claude.json' } }],
        projectInstructions: [{ path: '/u/.claude/Claude.md', scope: 'global', fileType: 'agents_md' }],
      }),
    ).toEqual({
      skills: [
        { name: 'commit', description: 'Commit', source: 'user', path: '/u/.grok/skills/commit/SKILL.md' },
        { name: 'brainstorming', description: 'Ideas', source: 'plugin: superpowers', path: '/p/SKILL.md' },
      ],
      mcpServers: [{ name: 'headroom', transport: 'stdio', source: 'claudeJson' }],
      memory: [{ path: '/u/.claude/Claude.md', kind: 'instructions' }],
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

  it('puts problems into words in the language of each request, not when the answer is cached', () => {
    const probe = {
      provider: 'codex' as const,
      cwd: root,
      skills: [],
      mcpServers: [],
      memory: [],
      memoryFromFiles: true,
      problems: [{ kind: 'timeout' as const }, { kind: 'no-answer' as const, part: 'mcp' as const }],
      checkedAt: 1,
    };
    expect(withLang('en', () => nativeForClient(probe).errors)).toEqual(['Codex did not answer in time.', 'Codex did not report its MCP servers.']);
    expect(withLang('zh-TW', () => nativeForClient(probe).errors)).toEqual(['Codex 沒有在時間內回應。', 'Codex 沒有回報它的 MCP 伺服器。']);
    expect(nativeForClient(probe)).not.toHaveProperty('problems');
  });
});
