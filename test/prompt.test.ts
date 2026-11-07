import { describe, expect, it } from 'vitest';
import type { AgentConfig, ChatMessage, Conversation } from '../src/shared/types';
import { buildBriefing, isForwardable, isPass, parseMentions, renderMessage } from '../src/server/prompt';

const team: AgentConfig[] = [
  { id: 'b', name: 'Builder', provider: 'claude', role: '' },
  { id: 'r', name: 'Reviewer', provider: 'codex', role: '' },
  { id: 'm', name: '小明', provider: 'grok', role: '' },
  { id: 'bob', name: 'Bob', provider: 'claude', role: '' },
];
const names = (text: string, exclude?: string) => parseMentions(text, team, exclude).map((a) => a.name);

describe('parseMentions', () => {
  it('finds a name followed directly by Chinese text', () => {
    expect(names('@Builder請實作第二步')).toEqual(['Builder']);
    expect(names('@小明請檢查')).toEqual(['小明']);
    expect(names('交給 @Reviewer，謝謝')).toEqual(['Reviewer']);
  });

  it('keeps ASCII words whole and ignores e-mail addresses and code', () => {
    expect(names('@Bobby please')).toEqual([]);
    expect(names('@bob please, then @builder.')).toEqual(['Bob', 'Builder']);
    expect(names('mail bob@Builder.dev')).toEqual([]);
    expect(names('run `@Builder` or\n```\n@Reviewer\n```')).toEqual([]);
  });

  it('ignores every kind of code fence, including one left open', () => {
    expect(names('~~~\n@Builder\n~~~\n@Reviewer')).toEqual(['Reviewer']);
    expect(names('````md\n```\n@Builder\n```\n````\n@Reviewer')).toEqual(['Reviewer']);
    expect(names('@Reviewer look:\n```ts\nconst a = "@Builder";')).toEqual(['Reviewer']);
    expect(names('``code with ` and @Builder`` then @Reviewer')).toEqual(['Reviewer']);
  });

  it('lists each agent once, in order of first mention, without the excluded one', () => {
    expect(names('@Reviewer @Builder @Reviewer')).toEqual(['Reviewer', 'Builder']);
    expect(names('@Reviewer @Builder', 'r')).toEqual(['Builder']);
  });

  it('prefers the longest matching name', () => {
    const agents: AgentConfig[] = [
      { id: '1', name: 'Al', provider: 'claude', role: '' },
      { id: '2', name: 'Alice', provider: 'claude', role: '' },
    ];
    expect(parseMentions('@Alice go', agents).map((a) => a.name)).toEqual(['Alice']);
    expect(parseMentions('@Al go', agents).map((a) => a.name)).toEqual(['Al']);
  });
});

describe('isPass', () => {
  it('accepts [PASS] with trailing punctuation only', () => {
    expect(isPass(' [pass]。')).toBe(true);
    expect(isPass('[PASS] but one more thing')).toBe(false);
  });
});

const conv: Conversation = {
  id: 'c',
  title: 't',
  createdAt: 0,
  updatedAt: 0,
  agents: team,
  settings: { mode: 'parallel', rounds: 2, maxHops: 5, permission: 'edit', cwd: '/work' },
  messages: [],
  agentState: {},
  worktrees: {},
};

const agentMessage = (over: Partial<ChatMessage>): ChatMessage => ({
  id: 'x',
  author: { kind: 'agent', agentId: 'b' },
  provider: 'claude',
  createdAt: 0,
  status: 'done',
  parts: [],
  ...over,
});

const changes = {
  root: '/work',
  base: 'a',
  head: 'b',
  isolated: false,
  files: [{ path: 'src/app.ts', status: 'M' as const, added: 2, deleted: 1 }],
};

describe('renderMessage', () => {
  it('still reports changed files when an agent passed', () => {
    const text = renderMessage(conv, agentMessage({ passed: true, parts: [{ type: 'text', text: '[PASS]' }], changes }));
    expect(text).toContain('[PASS]');
    expect(text).toContain('<changed_files>\nM src/app.ts (+2 -1)\n</changed_files>');
  });

  it('marks failed and stopped replies', () => {
    expect(renderMessage(conv, agentMessage({ status: 'error', changes }))).toMatch(/^<message from="@Builder" via="Claude Code" status="failed">/);
    expect(renderMessage(conv, agentMessage({ status: 'aborted', parts: [{ type: 'text', text: 'half' }] }))).toContain(
      'status="stopped"',
    );
  });
});

describe('isForwardable', () => {
  it('forwards finished messages, and failed or stopped ones that said or changed something', () => {
    expect(isForwardable(agentMessage({}))).toBe(true);
    expect(isForwardable(agentMessage({ status: 'streaming', changes }))).toBe(false);
    expect(isForwardable(agentMessage({ status: 'error' }))).toBe(false);
    expect(isForwardable(agentMessage({ status: 'error', changes }))).toBe(true);
    expect(isForwardable(agentMessage({ status: 'aborted', parts: [{ type: 'text', text: 'half' }] }))).toBe(true);
    expect(isForwardable({ ...agentMessage({}), author: { kind: 'system' } })).toBe(false);
  });
});

describe('buildBriefing', () => {
  it("names the snapshot each teammate's worktree started from", () => {
    const briefing = buildBriefing(conv, team[0]!, {
      kind: 'isolated',
      cwd: '/wt/builder',
      branch: 'relay/c/Builder',
      base: '1111111111111111',
      teammates: [{ name: 'Reviewer', branch: 'relay/c/Reviewer', base: '2222222222222222' }],
    });
    expect(briefing).toContain('snapshot (111111111111)');
    expect(briefing).toContain('@Reviewer → relay/c/Reviewer (started from 222222222222)');
  });

  it('tells agents how to show images and videos in the chat', () => {
    const briefing = buildBriefing(conv, team[0]!);
    expect(briefing).toContain('![Sales by month](charts/sales.png)');
    expect(briefing).toContain('Images from websites are shown only as links');
  });
});
