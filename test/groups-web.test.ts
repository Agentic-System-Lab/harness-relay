import { describe, expect, it } from 'vitest';
import type { GroupSuggestion } from '../src/shared/types';
import { chosenCount, createKey, moveBlocked, moveKey, renameKey, reorganizeOf, suggestionKeys, targetName } from '../src/web/groups';
import { en } from '../src/web/locales/en';

const groups = [
  { id: 'g1', name: 'Work' },
  { id: 'g2', name: 'Home' },
];
const s: GroupSuggestion = {
  create: [{ key: 'new-1', name: 'Clients' }],
  rename: [{ id: 'g1', from: 'Work', name: 'Engineering' }],
  move: [
    { convId: 'c1', title: 'Invoice', from: null, to: 'new-1' },
    { convId: 'c2', title: 'Build', from: null, to: 'g1' },
    { convId: 'c3', title: 'Groceries', from: 'g1', to: null },
  ],
  reason: '',
};

describe("the lead agent's group suggestions in the sidebar's dialog", () => {
  it('ticks every suggestion to begin with, and sends them all', () => {
    const all = new Set(suggestionKeys(s));
    expect([...all]).toEqual(['create:new-1', 'rename:g1', 'move:c1', 'move:c2', 'move:c3']);
    expect(reorganizeOf(s, all)).toEqual({
      create: [{ key: 'new-1', name: 'Clients' }],
      rename: [{ id: 'g1', name: 'Engineering' }],
      move: [
        { convId: 'c1', to: 'new-1' },
        { convId: 'c2', to: 'g1' },
        { convId: 'c3', to: null },
      ],
    });
    expect(chosenCount(s, all)).toBe(5);
  });

  it('cannot move a conversation into a new group the user did not tick', () => {
    const chosen = new Set([moveKey('c1'), moveKey('c3'), renameKey('g1')]);
    expect(moveBlocked(s, chosen, 'new-1')).toBe(true);
    expect(moveBlocked(s, chosen, 'g1')).toBe(false);
    expect(moveBlocked(s, chosen, null)).toBe(false);
    expect(reorganizeOf(s, chosen)).toEqual({
      create: [],
      rename: [{ id: 'g1', name: 'Engineering' }],
      move: [{ convId: 'c3', to: null }],
    });
    expect(chosenCount(s, chosen)).toBe(2);
    expect(chosenCount(s, new Set([createKey('new-1')]))).toBe(1);
  });

  it('names where a move goes as the groups will be', () => {
    const all = new Set(suggestionKeys(s));
    expect(targetName(s, groups, all, 'new-1', en)).toBe('Clients (new)');
    expect(targetName(s, groups, all, 'g1', en)).toBe('Engineering');
    expect(targetName(s, groups, new Set(), 'g1', en)).toBe('Work');
    expect(targetName(s, groups, all, 'g2', en)).toBe('Home');
    expect(targetName(s, groups, all, null, en)).toBe(en.sidebar.otherGroup);
  });
});
