import { describe, expect, it } from 'vitest';
import { OPEN_PROVIDERS, PROVIDERS, PROVIDER_LABEL, isOpenProvider, type ToolLibraryView } from '../src/shared/types';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import { defaultOn, emptyLibraryText, hasTool, itemsFor, ownSetupText, setTool, toolItems } from '../src/web/tools';

const lib: ToolLibraryView = {
  mcpServers: [{ id: 'gh1', name: 'github', transport: 'stdio', command: 'x', args: [], url: '', env: [], headers: [], providers: ['claude'] }],
  skills: [
    { path: '/s/commit', name: 'commit', description: '', providers: ['claude', 'codex', 'grok'] },
    { path: '/s/broken', name: 'broken', description: '', providers: [], problem: 'SKILL.md not found' },
  ],
  memory: { all: 'Be brief.', claude: '', codex: 'Run tests.', grok: '', cursor: '', antigravity: '', copilot: '', muse: '', opencode: '', goose: '', cline: '', openhands: '', pi: '' },
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

describe("what a member's Tools say about its CLI's own setup", () => {
  const own = PROVIDERS.filter((x) => !isOpenProvider(x));

  it('says a CLI with a sign-in still loads its own setup, and where Settings lists it', () => {
    expect(own).toHaveLength(7);
    for (const p of own) {
      const cli = PROVIDER_LABEL[p];
      expect(ownSetupText(en, p)).toBe(en.team.toolsOwnSetup.own(cli));
      expect(ownSetupText(en, p)).toContain(`${cli} loads its own setup as usual`);
      expect(ownSetupText(en, p)).toContain(`Settings → ${cli}`);
      expect(ownSetupText(zhTW, p)).toBe(zhTW.team.toolsOwnSetup.own(cli));
      expect(ownSetupText(zhTW, p)).toContain(`${cli} 照常載入它自己的設定`);
      expect(ownSetupText(zhTW, p)).toContain(`「設定 → ${cli}」`);
    }
  });

  it('says an open agent loads none of what the user set up for it, and where Settings lists what it does load', () => {
    for (const p of OPEN_PROVIDERS) {
      const cli = PROVIDER_LABEL[p];
      expect(ownSetupText(en, p)).toBe(en.team.toolsOwnSetup.open(cli));
      expect(ownSetupText(en, p)).toContain('the MCP servers and skills you set up for it yourself do not load');
      expect(ownSetupText(en, p)).toContain(`Settings → ${cli}`);
      expect(ownSetupText(en, p)).not.toContain('as usual');
      expect(ownSetupText(zhTW, p)).toBe(zhTW.team.toolsOwnSetup.open(cli));
      expect(ownSetupText(zhTW, p)).toContain('不會載入你自己為它設定的 MCP 伺服器和 skill');
      expect(ownSetupText(zhTW, p)).toContain(`「設定 → ${cli}」`);
      expect(ownSetupText(zhTW, p)).not.toContain('照常');
    }
  });

  it('says it while the tool library is empty', () => {
    for (const p of PROVIDERS) {
      for (const t of [en, zhTW]) {
        const setup = ownSetupText(t, p);
        expect(emptyLibraryText(t, p)).toBe(t.team.toolsEmpty(setup));
        expect(emptyLibraryText(t, p)).toContain(setup);
      }
    }
    // The CLI's own sentence goes between the others, as each language writes sentences.
    expect(emptyLibraryText(en, 'claude')).toMatch(/^The tool library is empty\. Claude Code loads .*lists them\)\. Add MCP servers/);
    expect(emptyLibraryText(zhTW, 'goose')).toMatch(/^工具庫還是空的。Goose 在 Harness Relay 裡.*「設定 → Goose」。工具庫可以加入/);
  });
});
