import { describe, expect, it } from 'vitest';
import { alertDetail, alertFor, alertsBetween, needsOf, snippet, wanted, type AlertState } from '../src/shared/notify';
import type { AgentConfig, ChatMessage, ConversationSummary } from '../src/shared/types';

const idle: AlertState = { running: false, lastStatus: 'done' };
const running: AlertState = { running: true, lastStatus: 'done' };

describe('alertFor', () => {
  it('tells of a run that ended, by how its latest reply ended; not of one the user stopped', () => {
    expect(alertFor(running, { running: false, lastStatus: 'done' })).toBe('done');
    expect(alertFor(running, { running: false, lastStatus: 'error' })).toBe('error');
    expect(alertFor(running, { running: false, lastStatus: 'aborted' })).toBeUndefined();
    expect(alertFor(running, running)).toBeUndefined();
    expect(alertFor(idle, idle)).toBeUndefined();
  });

  it('tells of a run shorter than the time between two looks: a reply it did not have', () => {
    expect(alertFor({ ...idle, lastReplyId: 'm1' }, { ...idle, lastReplyId: 'm2' })).toBe('done');
    expect(alertFor({ running: false }, { ...idle, lastReplyId: 'm1' })).toBe('done');
    expect(alertFor({ ...idle, lastReplyId: 'm1' }, { ...idle, lastReplyId: 'm1' })).toBeUndefined();
    expect(alertFor({ ...idle, lastReplyId: 'm1' }, { running: false, lastStatus: 'aborted', lastReplyId: 'm2' })).toBeUndefined();
    // A conversation not seen before (one branched from another, say) is no news by its replies.
    expect(alertFor(undefined, { ...idle, lastReplyId: 'm1' })).toBeUndefined();
  });

  it('tells once of what the user is needed for, the most urgent first, also in a conversation new to it', () => {
    expect(alertFor(running, { ...running, waiting: true })).toBe('approval');
    expect(alertFor({ ...running, waiting: true }, { ...running, waiting: true })).toBeUndefined();
    expect(alertFor(running, { running: false, asking: true, lastStatus: 'done' })).toBe('answer');
    expect(alertFor(undefined, { running: false, confirmTeam: true })).toBe('confirm');
    // A question asked while the team still runs (the answer is waited for once it stops).
    expect(alertFor(running, { running: true, asking: true })).toBeUndefined();
    // From one need to another.
    expect(alertFor({ ...idle, confirmTeam: true }, { ...running, waiting: true })).toBe('approval');
    // An approval answered and the run going on: nothing; then it ends.
    expect(alertFor({ ...running, waiting: true }, running)).toBeUndefined();
    expect(alertFor({ ...running, waiting: true }, idle)).toBe('done');
  });

  it('finds the alerts between two lists', () => {
    const summary = (id: string, s: AlertState): ConversationSummary => ({ id, title: id, createdAt: 0, updatedAt: 0, agents: [], ...s });
    const before = new Map<string, AlertState>([
      ['a', running],
      ['b', idle],
      ['c', running],
    ]);
    const now = [summary('a', idle), summary('b', idle), summary('c', running), summary('d', { running: false, confirmTeam: true })];
    expect(alertsBetween(before, now).map((x) => [x.conv.id, x.kind])).toEqual([
      ['a', 'done'],
      ['d', 'confirm'],
    ]);
    expect(alertsBetween(before, [...now.slice(0, 1), summary('b', { ...idle, lastReplyId: 'm9' }), ...now.slice(2)]).map((x) => x.conv.id)).toEqual(['a', 'b', 'd']);
  });

  it('sorts kinds into what a browser asks for', () => {
    expect(needsOf({ running: true, waiting: true, confirmTeam: true })).toBe('approval');
    expect(wanted('done', { done: true, needs: false })).toBe(true);
    expect(wanted('error', { done: false, needs: true })).toBe(false);
    expect(wanted('answer', { done: false, needs: true })).toBe(true);
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
