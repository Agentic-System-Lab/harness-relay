import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../src/shared/types';
import { groupOf, groupSections, groupStatus, settleMoves } from '../src/web/sidebar';
import { convStatus } from '../src/web/util';

const conv = (extra: Partial<ConversationSummary>): ConversationSummary => ({
  id: 'c',
  title: 't',
  updatedAt: 100,
  agents: [],
  running: false,
  ...extra,
});

describe('sidebar status', () => {
  it('puts what needs the user first, then replying', () => {
    expect(convStatus(conv({ running: true, waiting: true }), 0)).toBe('waiting');
    expect(convStatus(conv({ confirmTeam: true, lastStatus: 'done' }), 100)).toBe('confirm');
    expect(convStatus(conv({ confirmTeam: true, waiting: true }), 0)).toBe('waiting');
    expect(convStatus(conv({ running: true, lastStatus: 'done' }), 100)).toBe('running');
    expect(convStatus(conv({ asking: true, lastStatus: 'done' }), 100)).toBe('answer');
    expect(convStatus(conv({ asking: true, waiting: true }), 0)).toBe('waiting');
  });

  it('marks finished replies the user has not seen yet', () => {
    expect(convStatus(conv({ lastStatus: 'done' }), 50)).toBe('unread');
    expect(convStatus(conv({ lastStatus: 'error' }), undefined)).toBe('error');
    expect(convStatus(conv({ lastStatus: 'done' }), 100)).toBeUndefined();
    expect(convStatus(conv({ lastStatus: 'aborted' }), 50)).toBeUndefined();
    expect(convStatus(conv({}), 0)).toBeUndefined();
  });
});

describe('sidebar groups', () => {
  const groups = [
    { id: 'g1', name: 'Frontend' },
    { id: 'g2', name: 'Docs' },
  ];
  const list = [
    conv({ id: 'a', groupId: 'g2' }),
    conv({ id: 'b' }),
    conv({ id: 'c', groupId: 'gone' }),
    conv({ id: 'd', groupId: 'g2' }),
  ];
  const ids = (sections: ReturnType<typeof groupSections>) =>
    sections.map((s) => [s.group?.id ?? 'other', s.conversations.map((c) => c.id)]);

  it('lists the groups in order, then Other, with conversations of missing groups in Other', () => {
    expect(ids(groupSections(list, groups))).toEqual([
      ['g1', []],
      ['g2', ['a', 'd']],
      ['other', ['b', 'c']],
    ]);
    // Always an Other group, even with no groups at all.
    expect(ids(groupSections([], []))).toEqual([['other', []]]);
    expect(groupOf(list[2]!, groups)).toBeNull();
    expect(groupOf(list[0]!, groups)).toBe('g2');
  });

  it('shows moves the server has not reported yet, and forgets them once it has', () => {
    const moves = { a: 'g1', b: 'g1' };
    expect(ids(groupSections(list, groups, moves))).toEqual([
      ['g1', ['a', 'b']],
      ['g2', ['d']],
      ['other', ['c']],
    ]);
    expect(settleMoves(moves, list)).toEqual(moves);
    const after = list.map((c) => (c.id === 'a' ? { ...c, groupId: 'g1' } : c));
    expect(settleMoves(moves, after)).toEqual({ b: 'g1' });
    // A deleted conversation's move is dropped; nothing settled keeps the same object.
    expect(settleMoves({ x: null }, list)).toEqual({});
    const same = { b: 'g2' };
    expect(settleMoves(same, list)).toBe(same);
  });

  it('shows the most urgent state of a collapsed group', () => {
    expect(groupStatus([conv({ lastStatus: 'done' }), conv({ running: true }), conv({ waiting: true })], {})).toBe('waiting');
    expect(groupStatus([conv({ lastStatus: 'done' }), conv({ lastStatus: 'error' })], { c: 0 })).toBe('error');
    expect(groupStatus([conv({ lastStatus: 'done' })], { c: 100 })).toBeUndefined();
    expect(groupStatus([], {})).toBeUndefined();
  });
});
