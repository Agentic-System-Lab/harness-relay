import { describe, expect, it } from 'vitest';
import { AlertTracker, alertDetail, alertFor, needsOf, seenAfter, snippet, wanted, type AlertState, type Seen } from '../src/shared/notify';
import type { AgentConfig, ChatMessage, ConversationSummary } from '../src/shared/types';

const idle = (reply?: string): AlertState => ({ running: false, lastStatus: 'done', ...(reply ? { lastReplyId: reply } : {}) });
const seen = (state: AlertState, runFrom?: Seen['runFrom']): Seen => (runFrom ? { state, runFrom } : { state });
/** A run seen beginning after `from` (the latest reply then). */
const running = (from?: string, reply = from): Seen => seen({ running: true, lastStatus: 'done', ...(reply ? { lastReplyId: reply } : {}) }, from ? { reply: from } : {});

describe('alertFor', () => {
  it('tells of a run that ended with a reply it did not have when it began, by how that reply ended', () => {
    expect(alertFor(running('m1', 'm2'), idle('m2'))).toBe('done');
    expect(alertFor(running('m1', 'm2'), { running: false, lastStatus: 'error', lastReplyId: 'm2' })).toBe('error');
    expect(alertFor(running(undefined, 'm1'), idle('m1'))).toBe('done');
    // Stopped by the user: no news.
    expect(alertFor(running('m1', 'm2'), { running: false, lastStatus: 'aborted', lastReplyId: 'm2' })).toBeUndefined();
    expect(alertFor(running('m1', 'm2'), running('m1', 'm2').state)).toBeUndefined();
  });

  it('tells of nothing for a run that ended without a reply of its own: a team designed, a run stopped before anyone answered', () => {
    expect(alertFor(running('m1'), idle('m1'))).toBeUndefined();
    expect(alertFor(running(), { running: false })).toBeUndefined();
  });

  it('tells of a run that ended when it was already running at the first look (its start not known)', () => {
    expect(alertFor(seen({ running: true, lastReplyId: 'm1' }), idle('m1'))).toBe('done');
  });

  it('tells of a run shorter than the time between two looks: a reply it did not have', () => {
    expect(alertFor(seen(idle('m1')), idle('m2'))).toBe('done');
    expect(alertFor(seen({ running: false }), idle('m1'))).toBe('done');
    expect(alertFor(seen(idle('m1')), idle('m1'))).toBeUndefined();
    expect(alertFor(seen(idle('m1')), { running: false, lastStatus: 'aborted', lastReplyId: 'm2' })).toBeUndefined();
    // A conversation not seen before (one branched from another, say) is no news by its replies.
    expect(alertFor(undefined, idle('m1'))).toBeUndefined();
  });

  it('tells once of what the user is needed for, the most urgent first, also in a conversation new to it', () => {
    expect(alertFor(running('m1'), { running: true, waiting: true })).toBe('approval');
    expect(alertFor(seen({ running: true, waiting: true }), { running: true, waiting: true })).toBeUndefined();
    expect(alertFor(running('m1', 'm2'), { running: false, asking: true, lastStatus: 'done', lastReplyId: 'm2' })).toBe('answer');
    expect(alertFor(undefined, { running: false, confirmTeam: true })).toBe('confirm');
    // A question asked while the team still runs (the answer is waited for once it stops).
    expect(alertFor(running('m1'), { running: true, asking: true })).toBeUndefined();
    // From one need to another.
    expect(alertFor(seen({ running: false, confirmTeam: true }), { running: true, waiting: true })).toBe('approval');
    // An approval answered and the run going on: nothing; then it ends with its reply.
    expect(alertFor(seen({ running: true, waiting: true }, { reply: 'm1' }), { running: true })).toBeUndefined();
    expect(alertFor(seen({ running: true, waiting: true, lastReplyId: 'm2' }, { reply: 'm1' }), idle('m2'))).toBe('done');
  });

  it('remembers the reply a run began after, through the looks while it runs', () => {
    const begun = seenAfter(seen(idle('m1')), { running: true, lastReplyId: 'm2' });
    expect(begun.runFrom).toEqual({ reply: 'm1' });
    expect(seenAfter(begun, { running: true, waiting: true, lastReplyId: 'm2' }).runFrom).toEqual({ reply: 'm1' });
    expect(seenAfter(seen({ running: false }), { running: true }).runFrom).toEqual({});
    // Already running at the first look: after its latest reply, unless that one is still being written.
    expect(seenAfter(undefined, { running: true, lastStatus: 'done', lastReplyId: 'm1' }).runFrom).toEqual({ reply: 'm1' });
    expect(seenAfter(undefined, { running: true, lastStatus: 'streaming', lastReplyId: 'm1' }).runFrom).toBeUndefined();
    expect(seenAfter(begun, idle('m2'))).toEqual({ state: idle('m2') });
  });

  it('sorts kinds into what a browser asks for', () => {
    expect(needsOf({ running: true, waiting: true, confirmTeam: true })).toBe('approval');
    expect(wanted('done', { done: true, needs: false })).toBe(true);
    expect(wanted('error', { done: false, needs: true })).toBe(false);
    expect(wanted('answer', { done: false, needs: true })).toBe(true);
  });
});

describe('AlertTracker', () => {
  const summary = (id: string, s: AlertState): ConversationSummary => ({ id, title: id, createdAt: 0, updatedAt: 0, agents: [], ...s });
  const kinds = (t: AlertTracker, list: ConversationSummary[]) => t.next(list).map((x) => [x.conv.id, x.kind]);

  it('starts with the first list, then tells what changed from one list to the next', () => {
    const t = new AlertTracker();
    expect(kinds(t, [summary('a', { running: true, lastReplyId: 'a1' }), summary('b', idle('b1'))])).toEqual([]);
    expect(kinds(t, [summary('a', idle('a2')), summary('b', idle('b1')), summary('c', { running: false, confirmTeam: true })])).toEqual([
      ['a', 'done'],
      ['c', 'confirm'],
    ]);
    expect(kinds(t, [summary('a', idle('a2')), summary('b', idle('b2')), summary('c', { running: false, confirmTeam: true })])).toEqual([['b', 'done']]);
  });

  it("tells of nothing for a lead agent that designed a team and the run that ended without a reply, then of the team's reply", () => {
    const t = new AlertTracker();
    t.next([summary('a', idle('a1'))]);
    expect(kinds(t, [summary('a', { running: true, lastReplyId: 'a1' })])).toEqual([]);
    // The design run ended; the team's run has not begun yet (its workspace being prepared).
    expect(kinds(t, [summary('a', idle('a1'))])).toEqual([]);
    expect(kinds(t, [summary('a', { running: true, lastReplyId: 'a2' })])).toEqual([]);
    expect(kinds(t, [summary('a', idle('a2'))])).toEqual([['a', 'done']]);
  });

  it('tells of nothing for a run first seen going that ends without a reply of its own, and of one whose reply was being written', () => {
    const t = new AlertTracker();
    t.next([summary('a', { running: true, lastStatus: 'done', lastReplyId: 'a1' }), summary('b', { running: true, lastStatus: 'streaming', lastReplyId: 'b1' })]);
    expect(kinds(t, [summary('a', idle('a1')), summary('b', idle('b1'))])).toEqual([['b', 'done']]);
  });

  it('tells of nothing for a branch just made, also one that waits for the answer to the question it was branched at', () => {
    const t = new AlertTracker();
    t.next([summary('a', idle('a1'))]);
    const branch = summary('b', { running: false, asking: true, lastStatus: 'done', lastReplyId: 'a1', branchFrom: { id: 'a', title: 'a' } });
    expect(kinds(t, [summary('a', idle('a1')), branch])).toEqual([]);
    // From then on it is one like any other.
    expect(kinds(t, [summary('a', idle('a1')), { ...branch, asking: false, running: true }])).toEqual([]);
    expect(kinds(t, [summary('a', idle('a1')), { ...branch, asking: false, lastReplyId: 'b2' }])).toEqual([['b', 'done']]);
  });

  it('starts again after reset()', () => {
    const t = new AlertTracker();
    t.next([summary('a', { running: true })]);
    t.reset();
    expect(kinds(t, [summary('a', idle('a1'))])).toEqual([]);
    expect(kinds(t, [summary('a', idle('a2'))])).toEqual([['a', 'done']]);
  });
});

describe('alertDetail', () => {
  const agents = [{ id: 'a1', name: 'Claude' }, { id: 'a2', name: 'Codex' }] as AgentConfig[];
  const reply = (agentId: string, text: string, more: Partial<ChatMessage> = {}): ChatMessage => ({
    id: `${agentId}-${text.length}`,
    author: { kind: 'agent', agentId },
    createdAt: 0,
    parts: [{ type: 'text', text }],
    status: 'done',
    ...more,
  });

  it('names the agent that replied last and what it said, as one short line', () => {
    const messages = [reply('a1', 'First'), reply('a2', '## Done\n\nI fixed **the login** page.\n\n```ts\ncode()\n```\nSee [the diff](x).')];
    expect(alertDetail({ agents, messages }, 'done')).toEqual({ agent: 'Codex', text: 'Done I fixed the login page. See the diff.' });
    expect(alertDetail({ agents, messages: [reply('a1', 'x', { status: 'error', error: 'Claude Code exited (1)' })] }, 'error')).toEqual({
      agent: 'Claude',
      text: 'Claude Code exited (1)',
    });
  });

  it('gives the question asked, without its marker, and the command an approval waits on', () => {
    const asked = reply('a1', 'Which database should I use? [ASK_USER]', { asked: true });
    expect(alertDetail({ agents, messages: [asked, reply('a2', 'later')] }, 'answer')).toEqual({ agent: 'Claude', text: 'Which database should I use?' });
    const approval: ChatMessage = {
      ...reply('a2', ''),
      agentName: 'Codex (old name)',
      parts: [{ type: 'approval', id: 'p1', kind: 'command', detail: 'npm install', status: 'pending' }],
      status: 'streaming',
    };
    expect(alertDetail({ agents, messages: [approval] }, 'approval')).toEqual({ agent: 'Codex (old name)', text: 'npm install' });
    expect(alertDetail({ agents, messages: [approval] }, 'confirm')).toEqual({});
    expect(alertDetail({ agents, messages: [] }, 'done')).toEqual({});
  });

  it('cuts a long reply short', () => {
    const line = snippet('word '.repeat(100));
    expect(line.length).toBeLessThanOrEqual(140);
    expect(line.endsWith('…')).toBe(true);
  });
});
