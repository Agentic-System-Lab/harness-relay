import { describe, expect, it } from 'vitest';
import type { NativeSetup } from '../src/shared/types';
import { nativeLeftOutCount, nativeTabs, sameNativeParts } from '../src/web/native';

const setup = (extra: Partial<NativeSetup> = {}): NativeSetup => ({
  provider: 'claude',
  cwd: '/p',
  skills: [{ name: 'a', description: '', leftOut: true }, { name: 'b', description: '' }],
  mcpServers: [{ name: 'm', leftOut: true }],
  memory: [{ path: '/p/CLAUDE.md', kind: 'instructions', leftOut: true }],
  memoryFromFiles: true,
  nativeOff: ['skills', 'mcp', 'instructions'],
  asRun: true,
  errors: [],
  checkedAt: 1,
  ...extra,
});

describe("the panel of what a CLI loads by itself", () => {
  it('shows a tab for each list the CLI gave, with its count', () => {
    expect(nativeTabs(setup())).toEqual([
      { tab: 'skills', count: 2 },
      { tab: 'mcp', count: 1 },
      { tab: 'memory', count: 1 },
    ]);
    const all = setup({ hooks: [], agents: [{ name: 'Explore', description: '' }], plugins: [{ name: 'deck@market', leftOut: true }] });
    expect(nativeTabs(all).map((t) => t.tab)).toEqual(['skills', 'mcp', 'hooks', 'agents', 'plugins', 'memory']);
  });

  it('counts what Harness Relay leaves out across every list', () => {
    expect(nativeLeftOutCount(setup())).toBe(3);
    expect(nativeLeftOutCount(setup({ plugins: [{ name: 'deck@market', leftOut: true }], hooks: [{ event: 'stop' }] }))).toBe(4);
    expect(nativeLeftOutCount(setup({ skills: [], mcpServers: [], memory: [] }))).toBe(0);
  });

  it('tells whether the switches changed since the answer, in any order', () => {
    expect(sameNativeParts(['skills', 'mcp'], ['mcp', 'skills'])).toBe(true);
    expect(sameNativeParts([], [])).toBe(true);
    expect(sameNativeParts(['skills'], ['skills', 'hooks'])).toBe(false);
    expect(sameNativeParts(['skills', 'hooks'], ['skills', 'agents'])).toBe(false);
  });
});
