import { describe, expect, it } from 'vitest';
import type { AgentConfig, ChatMessage, Conversation } from '../src/shared/types';
import { buildBriefing, buildTurnPrompt, canReadFiles, forwardText, isForwardable, isPass, parseMentions, renderMessage } from '../src/server/prompt';
import { ASK_TOKEN, splitAsk } from '../src/shared/ask';

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

describe('forwardText', () => {
  it("tells teammates every file change, as Codex's rows name them", () => {
    const tool = (name: string, detail: string, status: 'done' | 'error' = 'done') => ({ type: 'tool' as const, id: name, name, detail, status });
    const m = agentMessage({
      provider: 'codex',
      parts: [
        tool('Create', '/repo/src/new.ts'),
        tool('Delete', '/repo/src/old.ts', 'error'),
        tool('Edit', '/repo/src/app.ts'),
        tool('Shell', 'npm test'),
        tool('WebSearch', 'vitest'),
      ],
    });
    expect(forwardText(m)).toBe('\n\n<actions>\nCreate /repo/src/new.ts\nDelete /repo/src/old.ts (failed)\nEdit /repo/src/app.ts\nShell npm test\n</actions>');
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

  it("adds the agent's memory and skills from the tool library, and nothing without them", () => {
    const briefing = buildBriefing(conv, team[0]!, { kind: 'shared' }, {
      memory: 'Lead with the answer.',
      skills: [{ name: 'commit', description: 'Write a\n commit.', dir: '/s/commit', file: '/s/commit/SKILL.md' }],
    });
    expect(briefing).toContain('<memory>\nLead with the answer.\n</memory>');
    expect(briefing).toContain('- commit: Write a commit. (/s/commit/SKILL.md)');
    const plain = buildBriefing(conv, team[0]!);
    expect(plain).not.toContain('# Memory');
    expect(plain).not.toContain('# Skills');
  });

  it("says the CLI's own skills still work only while the user has not left them out", () => {
    const tools = { skills: [{ name: 'commit', description: '', dir: '/s/commit', file: '/s/commit/SKILL.md' }] };
    const own = 'Skills your own CLI provides work as usual.';
    expect(buildBriefing(conv, team[0]!, { kind: 'shared' }, tools)).toContain(own);
    expect(buildBriefing(conv, team[0]!, { kind: 'shared' }, tools, ['mcp'])).toContain(own);
    const off = buildBriefing(conv, team[0]!, { kind: 'shared' }, tools, ['skills']);
    expect(off).toContain('- commit (/s/commit/SKILL.md)');
    expect(off).not.toContain(own);
  });

  it('lists no skills to an agent left with no tool that reads a file, and keeps its memory', () => {
    const tools = { memory: 'Lead with the answer.', skills: [{ name: 'commit', description: '', dir: '/s/commit', file: '/s/commit/SKILL.md' }] };
    const claude = { ...team[0]!, provider: 'claude' as const };
    const none = buildBriefing(conv, claude, { kind: 'shared' }, tools, ['tools']);
    expect(none).not.toContain('# Skills');
    expect(none).toContain('<memory>\nLead with the answer.\n</memory>');
    expect(buildBriefing(conv, claude, { kind: 'shared' }, tools, [], { tools: ['Read', 'Bash'] })).not.toContain('# Skills');
    // One of the two is enough to read a file.
    expect(buildBriefing(conv, claude, { kind: 'shared' }, tools, [], { tools: ['Read'] })).toContain('# Skills');
    expect(canReadFiles('claude', [], { tools: ['Bash'] })).toBe(true);
    expect(canReadFiles('codex', ['tools'])).toBe(true);
  });

  it("tells a branch's agents that files may have changed since the messages copied into it", () => {
    expect(buildBriefing(conv, team[0]!)).not.toContain('branched');
    const branch: Conversation = { ...conv, branch: { fromId: 'c0', fromTitle: 'Earlier', afterId: 'm1' } };
    expect(buildBriefing(branch, team[0]!)).toContain('This chat was branched from an earlier one');
  });

  it('tells agents how to show images and videos in the chat', () => {
    const briefing = buildBriefing(conv, team[0]!);
    expect(briefing).toContain('![Sales by month](charts/sales.png)');
    expect(briefing).toContain('Images from websites are shown only as links');
  });

  it('tells agents how to hand the user a file to download', () => {
    const briefing = buildBriefing(conv, team[0]!);
    expect(briefing).toContain('[Q3 report](out/report.pdf)');
    expect(briefing).toContain('[Deck](<out/Q3 deck.pptx>)');
    expect(briefing).toContain('only files inside your working directory can be downloaded');
  });
});

describe('asking the user', () => {
  it('finds the ask marker at the end of a reply, however it is dressed up', () => {
    expect(splitAsk('Which one, A or B?\n\n[ASK_USER]')).toEqual({ text: 'Which one, A or B?', asks: true });
    expect(splitAsk('Which one? [ASK_USER]')).toEqual({ text: 'Which one?', asks: true });
    expect(splitAsk('Which one?\n**[ASK_USER]**.\n')).toEqual({ text: 'Which one?', asks: true });
    expect(splitAsk('Which one?\n`[ask_user]`')).toEqual({ text: 'Which one?', asks: true });
  });

  it('only counts the marker at the end, and only with something to ask', () => {
    expect(splitAsk('I would end with [ASK_USER] if I had a question.')).toEqual({
      text: 'I would end with [ASK_USER] if I had a question.',
      asks: false,
    });
    expect(splitAsk('  [ASK_USER]  ')).toEqual({ text: '', asks: false });
  });

  it('tells agents when to ask, and the one that asked that the user replied', () => {
    expect(buildBriefing(conv, team[0]!)).toContain(`end your reply with ${ASK_TOKEN} on its own line`);
    const answered = buildTurnPrompt(conv, team[0]!, [], false, { mode: 'roundtable', round: 1, rounds: 1, answered: true });
    expect(answered).toContain('You asked the user a question and their reply is among the messages above:');
    const relay = buildTurnPrompt(conv, team[0]!, [], false, { mode: 'relay', round: 1, rounds: 1, answered: true });
    expect(relay).toContain('Mention a teammate to hand off');
    expect(buildTurnPrompt(conv, team[0]!, [], false, { mode: 'roundtable', round: 1, rounds: 1 })).not.toContain('You asked');
  });
});

describe('scheduled messages', () => {
  const scheduled: ChatMessage = {
    id: 's1',
    author: { kind: 'user' },
    createdAt: 0,
    parts: [{ type: 'text', text: 'daily check' }],
    status: 'done',
    scheduled: true,
  };
  const withSchedule = (approvals: 'deny' | 'ask'): Conversation => ({
    ...conv,
    schedule: {
      text: 'daily check',
      repeat: { kind: 'daily', time: '09:00' },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals,
      missed: 'skip',
      newChat: false,
      updatedAt: 0,
    },
  });

  it('are marked as sent by the schedule', () => {
    expect(renderMessage(conv, scheduled)).toBe('<message from="user" via="schedule">\ndaily check\n</message>');
    expect(renderMessage(conv, { ...scheduled, scheduled: undefined })).toBe('<message from="user">\ndaily check\n</message>');
  });

  it('are explained in the briefing of a conversation with a schedule, which says when approvals are refused', () => {
    expect(buildBriefing(conv, team[0]!)).not.toContain('via="schedule"');
    const refusing = buildBriefing(withSchedule('deny'), team[0]!);
    expect(refusing).toContain('A user message marked via="schedule" was sent automatically');
    expect(refusing).toContain(`ask the user (${ASK_TOKEN}) only when no reasonable answer is possible`);
    expect(refusing).toContain('refused automatically');
    expect(buildBriefing(withSchedule('ask'), team[0]!)).not.toContain('refused automatically');
    // Full access asks nothing, so nothing is refused.
    const full = { ...withSchedule('deny'), settings: { ...conv.settings, permission: 'full' as const } };
    expect(buildBriefing(full, team[0]!)).not.toContain('refused automatically');
  });

  it('are explained in a chat a schedule opened, which has no schedule of its own, and refused there only in a run nobody may be watching', () => {
    const opened: Conversation = { ...conv, messages: [scheduled] };
    const unattended = buildBriefing(opened, team[0]!, undefined, undefined, [], {}, true);
    expect(unattended).toContain('A user message marked via="schedule" was sent automatically');
    expect(unattended).toContain('refused automatically');
    // Once the user writes in it, they are here: the run asks.
    const attended = buildBriefing(opened, team[0]!);
    expect(attended).toContain('A user message marked via="schedule" was sent automatically');
    expect(attended).not.toContain('refused automatically');
    const full = { ...opened, settings: { ...conv.settings, permission: 'full' as const } };
    expect(buildBriefing(full, team[0]!, undefined, undefined, [], {}, true)).not.toContain('refused automatically');
  });

  it('are not mentioned in a conversation whose schedule sends them in a new chat each time', () => {
    const elsewhere: Conversation = { ...withSchedule('deny'), schedule: { ...withSchedule('deny').schedule!, newChat: true } };
    expect(buildBriefing(elsewhere, team[0]!)).not.toContain('via="schedule"');
    // Messages it sent here before it opened new chats are still explained.
    const before = buildBriefing({ ...elsewhere, messages: [scheduled] }, team[0]!);
    expect(before).toContain('A user message marked via="schedule" was sent automatically');
    expect(before).not.toContain('refused automatically');
    const info = { mode: 'roundtable' as const, round: 1, rounds: 1, answered: true };
    expect(buildTurnPrompt(elsewhere, team[0]!, [], false, info)).not.toContain('via="schedule"');
  });

  it("tell an agent that asked that the scheduled message among the new ones is not the user's reply", () => {
    const reply: ChatMessage = { ...scheduled, id: 'r1', scheduled: undefined, parts: [{ type: 'text', text: 'A' }] };
    const info = { mode: 'roundtable' as const, round: 1, rounds: 1, answered: true };
    expect(buildTurnPrompt(conv, team[0]!, [scheduled, reply], false, info)).toContain('one marked via="schedule" is not their reply');
    expect(buildTurnPrompt(conv, team[0]!, [reply], false, info)).not.toContain('via="schedule"');
  });
});
