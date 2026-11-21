import { describe, expect, it } from 'vitest';
import { nativeItemsFor, sameNativeItems, type NativeSetup } from '../src/shared/types';
import {
  cliFeaturesState,
  hasSubagentSwitch,
  hasSubagents,
  hasWorkflowSwitch,
  subagentsFullAccessOnly,
  withNativeOn,
  withSubagents,
  canLeaveOutAll,
  canPick,
  canPickIn,
  isPicked,
  nativeLeftOutCount,
  nativeOffTotal,
  nativeTabs,
  sameNativeParts,
  tabPicked,
  unlistedPicks,
  withItem,
  withoutPicks,
  withoutTab,
} from '../src/web/native';

const setup = (extra: Partial<NativeSetup> = {}): NativeSetup => ({
  provider: 'claude',
  cwd: '/p',
  skills: [
    { name: 'a', description: '', leftOut: true },
    { name: 'b', description: '' },
  ],
  mcpServers: [{ name: 'm', leftOut: true }],
  memory: [
    { path: '/p/CLAUDE.md', kind: 'instructions', leftOut: true },
    { path: '/c/memory/MEMORY.md', kind: 'memory' },
  ],
  memoryFromFiles: true,
  nativeOff: ['skills', 'mcp', 'instructions'],
  nativeItems: {},
  asRun: true,
  errors: [],
  checkedAt: 1,
  ...extra,
});

describe('the panel of what a CLI loads by itself', () => {
  it("shows each CLI's tabs before it is asked, then with their counts", () => {
    expect(nativeTabs('claude').map((t) => t.tab)).toEqual([
      'skills',
      'mcp',
      'tools',
      'hooks',
      'agents',
      'plugins',
      'instructions',
      'memory',
    ]);
    // Codex lists no subagents and has no switch for them; only Claude Code lists its built-in tools.
    expect(nativeTabs('codex').map((t) => t.tab)).toEqual(['skills', 'mcp', 'hooks', 'plugins', 'instructions', 'memory']);
    expect(nativeTabs('grok').map((t) => t.tab)).toEqual(['skills', 'mcp', 'hooks', 'agents', 'plugins', 'instructions', 'memory']);
    expect(nativeTabs('claude')[0]).toEqual({ tab: 'skills' });
    // Instructions and memory are counted apart; a list the CLI did not give has no count.
    expect(nativeTabs('claude', setup({ builtinTools: [{ name: 'Bash' }], hooks: [] }))).toEqual([
      { tab: 'skills', count: 2 },
      { tab: 'mcp', count: 1 },
      { tab: 'tools', count: 1 },
      { tab: 'hooks', count: 0 },
      { tab: 'agents', count: undefined },
      { tab: 'plugins', count: undefined },
      { tab: 'instructions', count: 1 },
      { tab: 'memory', count: 1 },
    ]);
  });

  it('knows what each CLI can leave out, all at once or one item at a time', () => {
    expect(canLeaveOutAll('claude', 'tools')).toBe(true);
    expect(canLeaveOutAll('grok', 'instructions')).toBe(false);
    expect(canPick('claude', 'instructions')).toBe(true);
    expect(canPick('claude', 'hooks')).toBe(false);
    expect(canPick('codex', 'hooks')).toBe(true);
    expect(canPickIn('claude', 'mcp')).toBe(true);
    expect(canPickIn('claude', 'memory')).toBe(false);
    expect(canPickIn('codex', 'instructions')).toBe(false);
    expect(['skills', 'mcp', 'hooks', 'agents', 'plugins'].some((tab) => canPickIn('grok', tab as never))).toBe(false);
  });

  it('ticks and clears single items, dropping kinds left with none', () => {
    const one = withItem({}, 'skills', 'commit', true);
    expect(one).toEqual({ skills: ['commit'] });
    expect(withItem(one, 'skills', 'commit', true)).toEqual({ skills: ['commit'] });
    const two = withItem(withItem(one, 'mcp', 'mcp__a', true), 'mcpTools', 'mcp__b__x', true);
    expect(two).toEqual({ skills: ['commit'], mcp: ['mcp__a'], mcpTools: ['mcp__b__x'] });
    expect(withItem(two, 'skills', 'commit', false)).toEqual({ mcp: ['mcp__a'], mcpTools: ['mcp__b__x'] });
    expect(tabPicked(two, 'mcp')).toBe(2);
    expect(tabPicked(two, 'tools')).toBe(0);
    // Clearing a tab clears both its kinds (an MCP server and its tools).
    expect(withoutTab(two, 'mcp')).toEqual({ skills: ['commit'] });
    expect(isPicked(two, 'mcp', 'mcp__a')).toBe(true);
    expect(isPicked(two, 'mcp', undefined)).toBe(false);
    expect(nativeOffTotal(['hooks'], two)).toBe(4);
    // Its subagents have a box of their own: not counted among what the panel leaves out.
    expect(nativeOffTotal(['hooks', 'subagents'], two)).toBe(4);
  });

  it('counts what Harness Relay leaves out across every list, an MCP server with its tools once', () => {
    expect(nativeLeftOutCount(setup())).toBe(3);
    expect(nativeLeftOutCount(setup({ plugins: [{ name: 'deck@market', leftOut: true }], hooks: [{ event: 'stop' }] }))).toBe(4);
    expect(nativeLeftOutCount(setup({ skills: [], mcpServers: [], memory: [] }))).toBe(0);
    const servers = setup({
      skills: [],
      memory: [],
      mcpServers: [
        { name: 'gone', leftOut: true, tools: [{ name: 'x', leftOut: true }] },
        { name: 'kept', tools: [{ name: 'y', leftOut: true }, { name: 'z' }] },
      ],
      builtinTools: [{ name: 'WebSearch', leftOut: true }, { name: 'Bash' }],
    });
    expect(nativeLeftOutCount(servers)).toBe(3);
  });

  it('tells whether what is left out changed since the answer, in any order', () => {
    expect(sameNativeParts(['skills', 'mcp'], ['mcp', 'skills'])).toBe(true);
    expect(sameNativeParts([], [])).toBe(true);
    expect(sameNativeParts(['skills'], ['skills', 'hooks'])).toBe(false);
    expect(sameNativeParts(['skills', 'hooks'], ['skills', 'agents'])).toBe(false);
    expect(sameNativeItems({ skills: ['a', 'b'] }, { skills: ['b', 'a'] })).toBe(true);
    expect(sameNativeItems({}, { skills: [] })).toBe(true);
    expect(sameNativeItems({ skills: ['a'] }, { skills: ['a'], tools: ['Bash'] })).toBe(false);
    expect(sameNativeItems({ skills: ['a'] }, { skills: ['b'] })).toBe(false);
  });

  it('finds the ticked items a fresh answer no longer lists, so they can be cleared', () => {
    const answer = setup({
      skills: [{ name: 'a', description: '', id: 'a' }],
      mcpServers: [
        { name: 'local', id: 'mcp__local', tools: [{ name: 'x', id: 'mcp__local__x' }] },
        { name: 'auth', id: 'mcp__auth' },
      ],
      memory: [{ path: '/p/CLAUDE.md', kind: 'instructions', id: '/p/CLAUDE.md' }],
    });
    const items = {
      skills: ['a', 'gone'],
      mcp: ['mcp__local', 'mcp__old'],
      // A tool of a server whose tools are not known (needs sign-in) may well be there.
      mcpTools: ['mcp__local__x', 'mcp__local__y', 'mcp__auth__z'],
      instructions: ['/other/CLAUDE.md'],
      tools: ['WebSearch'],
    };
    expect(unlistedPicks(answer, items, 'skills')).toEqual([{ kind: 'skills', id: 'gone' }]);
    expect(unlistedPicks(answer, items, 'mcp')).toEqual([
      { kind: 'mcp', id: 'mcp__old' },
      { kind: 'mcpTools', id: 'mcp__local__y' },
    ]);
    expect(unlistedPicks(answer, items, 'instructions')).toEqual([{ kind: 'instructions', id: '/other/CLAUDE.md' }]);
    // A list the CLI did not give: nothing to tell.
    expect(unlistedPicks(answer, items, 'tools')).toEqual([]);
    expect(withoutPicks(items, unlistedPicks(answer, items, 'mcp'))).toEqual({
      skills: ['a', 'gone'],
      mcp: ['mcp__local'],
      mcpTools: ['mcp__local__x', 'mcp__auth__z'],
      instructions: ['/other/CLAUDE.md'],
      tools: ['WebSearch'],
    });
    // Codex's tool ids name their server as JSON.
    const codex = setup({ provider: 'codex', mcpServers: [{ name: 'a.b', id: 'a.b' }] });
    expect(unlistedPicks(codex, { mcpTools: ['["a.b","t"]', '["c","t"]'] }, 'mcp')).toEqual([{ kind: 'mcpTools', id: '["c","t"]' }]);
  });
});

describe('single items left out, as stored', () => {
  it('keeps only kinds the CLI can leave out, strings once each, within limits', () => {
    expect(nativeItemsFor('claude', { skills: ['a', 'a', '', 7, 'b'], hooks: ['h'], bogus: ['x'], tools: [] })).toEqual({
      skills: ['a', 'b'],
    });
    expect(nativeItemsFor('codex', { hooks: ['h'], tools: ['Bash'], instructions: ['/p/AGENTS.md'] })).toEqual({ hooks: ['h'] });
    expect(nativeItemsFor('grok', { skills: ['a'] })).toEqual({});
    expect(nativeItemsFor('claude', null)).toEqual({});
    expect(nativeItemsFor('claude', ['skills'])).toEqual({});
    expect(nativeItemsFor('claude', { skills: ['x'.repeat(4097)] })).toEqual({});
  });
});

describe('the subagents and workflows box', () => {
  it('has a subagent switch where the CLI can turn them off for a run, and a workflow switch for Claude Code', () => {
    expect(['claude', 'codex', 'grok', 'opencode', 'goose', 'cline', 'openhands'].every((p) => hasSubagentSwitch(p as never))).toBe(true);
    expect(['cursor', 'antigravity', 'copilot', 'muse', 'pi'].some((p) => hasSubagentSwitch(p as never))).toBe(false);
    expect(hasWorkflowSwitch('claude')).toBe(true);
    expect(hasWorkflowSwitch('codex')).toBe(false);
    // Pi has no subagents: no box.
    expect(hasSubagents('pi')).toBe(false);
    expect(hasSubagents('cursor')).toBe(true);
    expect(subagentsFullAccessOnly('codex')).toBe(true);
    // Cline's spawn_agent gives its subagent no approval: off below full access too.
    expect(subagentsFullAccessOnly('cline')).toBe(true);
    expect(subagentsFullAccessOnly('claude')).toBe(false);
  });

  it('switches them: subagents as a part left out, workflows and ultracode as parts turned on', () => {
    expect(withSubagents(['mcp'], false)).toEqual(['mcp', 'subagents']);
    expect(withSubagents(['subagents', 'mcp'], true)).toEqual(['mcp']);
    expect(withSubagents(['subagents'], false)).toEqual(['subagents']);
    expect(withNativeOn([], 'workflows', true)).toEqual(['workflows']);
    // Ultracode needs workflows: on, it turns them on; workflows off take it with them.
    expect(withNativeOn([], 'ultracode', true)).toEqual(['workflows', 'ultracode']);
    expect(withNativeOn(['workflows', 'ultracode'], 'workflows', false)).toEqual([]);
    expect(withNativeOn(['workflows', 'ultracode'], 'ultracode', false)).toEqual(['workflows']);
  });

  it('sums up where the switches stand, leaving out what the CLI has no switch for', () => {
    expect(cliFeaturesState('claude', [], [])).toEqual({ subagents: true, workflows: false, ultracode: false });
    expect(cliFeaturesState('claude', ['subagents'], ['workflows', 'ultracode'])).toEqual({
      subagents: false,
      workflows: true,
      ultracode: true,
    });
    expect(cliFeaturesState('codex', ['subagents'], [])).toEqual({ subagents: false });
    expect(cliFeaturesState('cursor', [], [])).toEqual({});
  });
});
