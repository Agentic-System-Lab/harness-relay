import { describe, expect, it } from 'vitest';
import type { ToolLibraryView } from '../src/shared/types';
import { defaultOn, hasTool, itemsFor, setTool, toolItems } from '../src/web/tools';

const lib: ToolLibraryView = {
  mcpServers: [{ id: 'gh1', name: 'github', transport: 'stdio', command: 'x', args: [], url: '', env: [], headers: [], providers: ['claude'] }],
  skills: [
    { path: '/s/commit', name: 'commit', description: '', providers: ['claude', 'codex', 'grok'] },
    { path: '/s/broken', name: 'broken', description: '', providers: [], problem: 'SKILL.md not found' },
  ],
  memory: { all: 'Be brief.', claude: '', codex: 'Run tests.', grok: '', cursor: '', antigravity: '', opencode: '', goose: '', cline: '', openhands: '', pi: '' },
  secretStorage: 'keychain',
};

describe('tool picker', () => {
  const items = toolItems(lib);

  it('lists servers, skills and the memory parts that have text', () => {
    expect(items.map((i) => i.key)).toEqual(['mcp:gh1', 'skill:/s/commit', 'skill:/s/broken', 'memory', 'memory:codex']);
    expect(items.find((i) => i.key === 'skill:/s/broken')!.problem).toBe('SKILL.md not found');
  });

  it("shows an agent only its own CLI's memory part", () => {
    expect(itemsFor(items, 'claude').map((i) => i.key)).not.toContain('memory:codex');
    expect(itemsFor(items, 'codex').map((i) => i.key)).toContain('memory:codex');
  });

  it("defaults by the agent's CLI and records only exceptions", () => {
    const github = items[0]!;
    expect(defaultOn(github, 'claude')).toBe(true);
    expect(defaultOn(github, 'codex')).toBe(false);
    const codex = { provider: 'codex' as const, tools: undefined };
    expect(hasTool(codex, github)).toBe(false);
    const on = setTool(codex, github, true);
    expect(on).toEqual({ 'mcp:gh1': true });
    expect(hasTool({ ...codex, tools: on }, github)).toBe(true);
    // Back to the default: no exception left.
    expect(setTool({ ...codex, tools: on }, github, false)).toBeUndefined();
    // Switching the agent to Claude makes the same exception the default.
    expect(setTool({ provider: 'claude', tools: on }, github, true)).toBeUndefined();
  });
});
