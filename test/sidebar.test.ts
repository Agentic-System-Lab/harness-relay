import { describe, expect, it } from 'vitest';
import { families, familyOf } from '../src/shared/family';
import type { ConversationSummary } from '../src/shared/types';
import {
  ancestorsOf,
  branchCount,
  descendants,
  familyIds,
  familySizes,
  foldedNow,
  groupSections,
  groupStatus,
  moveFamily,
  revealIn,
  settleMoves,
  undoMoves,
  type ConvNode,
} from '../src/web/sidebar';
import { convStatus } from '../src/web/util';

const conv = (extra: Partial<ConversationSummary>): ConversationSummary => ({
  id: 'c',
  title: 't',
  createdAt: 100,
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

describe('sidebar families of branched conversations', () => {
  const groups = [{ id: 'g1', name: 'Research' }];
  /** Made at `createdAt`, last active at `updatedAt`, branched from `from`. */
  const at = (id: string, createdAt: number, updatedAt: number, from?: string, extra: Partial<ConversationSummary> = {}) =>
    conv({ id, title: id, createdAt, updatedAt, ...(from ? { branchFrom: { id: from, title: `${from} then` } } : {}), ...extra });
  /** A tree as text: each node's id (a deleted one's as `(id: title)`), its children in brackets. */
  const shape = (n: ConvNode): string =>
    (n.conv ? n.id : `(${n.id}: ${n.title})`) + (n.children.length ? `[${n.children.map(shape).join(' ')}]` : '');
  const trees = (sections: ReturnType<typeof groupSections>) =>
    sections.map((s) => [s.group?.id ?? 'other', s.trees.map(shape)]);

  // Newest first, as the server lists them.
  const list = [
    at('b2', 30, 90, 'root'),
    at('solo', 5, 80),
    at('b1', 20, 70, 'root'),
    at('b1a', 40, 60, 'b1'),
    at('root', 10, 10, undefined, { groupId: 'g1' }),
  ];

  it('puts each conversation under the one it was branched from, oldest first, in the group of the oldest', () => {
    expect(trees(groupSections(list, groups))).toEqual([
      ['g1', ['root[b1[b1a] b2]']],
      ['other', ['solo']],
    ]);
    // The flat list keeps the order they came in; it is what a group counts.
    expect(groupSections(list, groups)[0]!.conversations.map((c) => c.id)).toEqual(['b2', 'b1', 'b1a', 'root']);
  });

  it('orders families by their latest activity, whichever of their conversations it was in', () => {
    const later = list.map((c) => (c.id === 'b2' ? { ...c, updatedAt: 1 } : c.id === 'b1a' ? { ...c, updatedAt: 85 } : c));
    expect(trees(groupSections(later, []))).toEqual([['other', ['root[b1[b1a] b2]', 'solo']]]);
    const quiet = list.map((c) => (['b2', 'b1a', 'b1'].includes(c.id) ? { ...c, updatedAt: 1 } : c));
    expect(trees(groupSections(quiet, []))).toEqual([['other', ['solo', 'root[b1[b1a] b2]']]]);
  });

  it('keeps branches of a deleted conversation together under its title', () => {
    const orphans = [at('x2', 30, 30, 'gone'), at('x1', 20, 20, 'gone'), at('x1a', 25, 25, 'x1'), at('y', 5, 5, 'other-gone')];
    const [other] = groupSections(orphans, []);
    expect(other!.trees.map(shape)).toEqual(['(gone: gone then)[x1[x1a] x2]', '(other-gone: other-gone then)[y]']);
    // The title the deleted one had when its newest branch was made.
    const renamed = [at('x2', 30, 30, 'gone'), { ...at('x1', 20, 20, 'gone'), branchFrom: { id: 'gone', title: 'first name' } }];
    expect(groupSections(renamed, [])[0]!.trees.map(shape)).toEqual(['(gone: gone then)[x1 x2]']);
    // A family of a deleted conversation is in the group of its oldest one.
    const moved = [at('x2', 30, 30, 'gone', { groupId: 'g1' }), at('x1', 20, 20, 'gone')];
    expect(trees(groupSections(moved, groups))).toEqual([
      ['g1', []],
      ['other', ['(gone: gone then)[x1 x2]']],
    ]);
  });

  it('moves a whole family at once while the server has not answered', () => {
    const ids = familyIds(list, 'b1a');
    expect(ids).toEqual(['root', 'b1', 'b2', 'b1a']);
    expect(familyIds(list, 'solo')).toEqual(['solo']);
    const moves = Object.fromEntries(ids.map((id) => [id, null]));
    expect(trees(groupSections(list, groups, moves))).toEqual([
      ['g1', []],
      ['other', ['root[b1[b1a] b2]', 'solo']],
    ]);
  });

  it('counts what was branched from a conversation, and what a hidden family shows', () => {
    const root = groupSections(list, groups)[0]!.trees[0]!;
    expect(descendants(root).map((c) => c.id)).toEqual(['b1', 'b2', 'b1a']);
    expect(branchCount(list, 'root')).toBe(3);
    expect(branchCount(list, 'b1')).toBe(1);
    expect(branchCount(list, 'solo')).toBe(0);
    const busy = list.map((c) => (c.id === 'b1a' ? { ...c, waiting: true } : c));
    expect(groupStatus(descendants(groupSections(busy, groups)[0]!.trees[0]!), {})).toBe('waiting');
  });

  it('keeps a deleted conversation in the middle of a family in its place, by its title', () => {
    // A → B (deleted) → C, D; C → E. Then A deleted too.
    const via = (id: string, title: string) => ({ id, title });
    const middle = [
      at('E', 50, 50, 'C'),
      { ...at('D', 40, 40), branchFrom: { id: 'B', title: 'B then', via: [via('A', 'A then')] } },
      { ...at('C', 30, 30), branchFrom: { id: 'B', title: 'B first', via: [via('A', 'A then')] } },
      at('A', 10, 10, undefined, { groupId: 'g1' }),
    ];
    expect(trees(groupSections(middle, groups))).toEqual([
      ['g1', ['A[(B: B then)[C[E] D]]']],
      ['other', []],
    ]);
    expect(familyIds(middle, 'E')).toEqual(['A', 'C', 'D', 'E']);
    expect(branchCount(middle, 'A')).toBe(3);
    expect(ancestorsOf(middle, 'E')).toEqual(['C', 'B', 'A']);
    const topGone = middle
      .filter((c) => c.id !== 'A')
      .map((c) => (c.branchFrom?.via ? { ...c, branchFrom: { ...c.branchFrom, via: [via('A', 'A at last')] } } : c));
    expect(trees(groupSections(topGone, []))).toEqual([['other', ['(A: A at last)[(B: B then)[C[E] D]]']]]);
    expect(familySizes(topGone)).toEqual(new Map([['E', 3], ['D', 3], ['C', 3]]));
  });

  it('opens what hides the conversation that is opened, and forgets hidden branches no longer there', () => {
    const folded = new Set(['b1', 'root', 'solo', 'gone']);
    expect(ancestorsOf(list, 'b1a')).toEqual(['b1', 'root']);
    expect(revealIn(folded, list, 'b1a')).toEqual(new Set(['solo', 'gone']));
    const open = new Set(['solo']);
    expect(revealIn(open, list, 'b1a')).toBe(open);
    expect(revealIn(folded, list, 'missing')).toBe(folded);
    // Only nodes with conversations below them can hide any.
    expect(foldedNow(folded, list)).toEqual(new Set(['b1', 'root']));
  });

  it('moves the whole family of any of its conversations, and undoes just that', () => {
    const before = { solo: 'g1', b2: 'g9' };
    const { moves, ids } = moveFamily(before, list, 'b2', null);
    expect(ids).toEqual(['root', 'b1', 'b2', 'b1a']);
    expect(moves).toEqual({ solo: 'g1', root: null, b1: null, b2: null, b1a: null });
    // Placed by the oldest, whichever one was moved.
    expect(trees(groupSections(list, groups, moves))).toEqual([
      ['g1', ['solo']],
      ['other', ['root[b1[b1a] b2]']],
    ]);
    expect(undoMoves({ ...moves, other: 'g1' }, ids, before)).toEqual({ solo: 'g1', b2: 'g9', other: 'g1' });
    expect(familySizes(list).get('b1a')).toBe(4);
    expect(familySizes(list).get('solo')).toBe(1);
  });

  it('never loops, even on a loop that branching cannot make', () => {
    const members = [
      { id: 'a', createdAt: 1, fromId: 'c' },
      { id: 'b', createdAt: 2, fromId: 'a' },
      { id: 'c', createdAt: 3, fromId: 'b' },
      { id: 'self', createdAt: 4, fromId: 'self' },
    ];
    const { parent, top } = families(members);
    expect(new Set(['a', 'b', 'c'].map((id) => top.get(id))).size).toBe(1);
    expect(['a', 'b', 'c'].filter((id) => parent.get(id) === undefined)).toHaveLength(1);
    expect(top.get('self')).toBe('self');
    expect(parent.get('self')).toBeUndefined();
    expect(familyOf(members, 'b')).toEqual(['a', 'b', 'c']);
    expect(familyOf(members, 'missing')).toEqual([]);
    const loop = members.map((m) => conv({ id: m.id, createdAt: m.createdAt, branchFrom: { id: m.fromId, title: '' } }));
    expect(groupSections(loop, [])[0]!.trees).toHaveLength(2);
    expect(branchCount(loop, 'a') + branchCount(loop, 'b') + branchCount(loop, 'c')).toBe(3);
  });
});
