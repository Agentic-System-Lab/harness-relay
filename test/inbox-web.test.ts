import { describe, expect, it } from 'vitest';
import type { InboxItem, InboxSummary } from '../src/shared/types';
import { BADGE_MAX, EMPTY_INBOX, badgeText, inboxLine, inboxTone, markedRead, readOnView, sameSummary } from '../src/web/inbox';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

const item = (id: string, conversationId: string, read = false, s: Partial<InboxItem> = {}): InboxItem => ({
  id,
  conversationId,
  title: `Chat ${conversationId}`,
  kind: 'done',
  createdAt: 1,
  read,
  ...s,
});

describe('the notification inbox in the page', () => {
  it("counts the bell's unread notifications, up to 99+", () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-1)).toBe('');
    expect(badgeText(Number.NaN)).toBe('');
    expect(badgeText(1)).toBe('1');
    expect(badgeText(BADGE_MAX)).toBe('99');
    expect(badgeText(BADGE_MAX + 1)).toBe('99+');
  });

  it('tells a summary that changed from one that did not', () => {
    const a: InboxSummary = { unread: 2, unreadIn: ['c1', 'c2'], newest: 'n2' };
    expect(sameSummary(a, { ...a, unreadIn: ['c1', 'c2'] })).toBe(true);
    expect(sameSummary(a, { ...a, unread: 3 })).toBe(false);
    expect(sameSummary(a, { ...a, newest: 'n3' })).toBe(false);
    expect(sameSummary(a, { ...a, unreadIn: ['c2', 'c1'] })).toBe(false);
    expect(sameSummary(a, { ...a, unreadIn: ['c1'] })).toBe(false);
    expect(sameSummary(EMPTY_INBOX, { unread: 0, unreadIn: [] })).toBe(true);
  });

  it('reads the notifications of the chat on screen, only while the user can see it', () => {
    const summary: InboxSummary = { unread: 2, unreadIn: ['c1', 'c2'], newest: 'n2' };
    const seen = { visible: true, focused: true };
    expect(readOnView({ page: 'chat', id: 'c1' }, summary, seen)).toBe('c1');
    // Nothing unread there, another page, or the user is not looking.
    expect(readOnView({ page: 'chat', id: 'c3' }, summary, seen)).toBeUndefined();
    expect(readOnView({ page: 'home' }, summary, seen)).toBeUndefined();
    expect(readOnView({ page: 'chat', id: 'c1' }, summary, { visible: false, focused: true })).toBeUndefined();
    expect(readOnView({ page: 'chat', id: 'c1' }, summary, { visible: true, focused: false })).toBeUndefined();
    // Already on its way.
    expect(readOnView({ page: 'chat', id: 'c1' }, summary, seen, 'c1')).toBeUndefined();
    expect(readOnView({ page: 'chat', id: 'c2' }, summary, seen, 'c1')).toBe('c2');
  });

  it('says what happened in the page’s language, with the agent when it is known', () => {
    expect(inboxLine({ kind: 'done', agent: 'Claude' }, en.notifications)).toBe('Claude finished replying');
    expect(inboxLine({ kind: 'approval' }, en.notifications)).toBe('An agent is waiting for your approval');
    expect(inboxLine({ kind: 'answer', agent: 'Codex' }, zhTW.notifications)).toBe('Codex 問了你一個問題');
    expect(inboxLine({ kind: 'confirm' }, zhTW.notifications)).toBe(zhTW.notifications.alert.confirm());
  });

  it('marks what needs the user apart from errors and replies done', () => {
    expect(['approval', 'confirm', 'answer'].map((k) => inboxTone(k as InboxItem['kind']))).toEqual(['needs', 'needs', 'needs']);
    expect(inboxTone('error')).toBe('error');
    expect(inboxTone('done')).toBe('done');
  });

  it('shows notifications read before the server answers', () => {
    const items = [item('n1', 'c1'), item('n2', 'c2'), item('n3', 'c1', true)];
    expect(markedRead(items, { all: true }).map((i) => i.read)).toEqual([true, true, true]);
    expect(markedRead(items, { conversationId: 'c1' }).map((i) => i.read)).toEqual([true, false, true]);
    expect(markedRead(items, { ids: ['n2'] }).map((i) => i.read)).toEqual([false, true, true]);
    // What was read already is the same object.
    expect(markedRead(items, { all: true })[2]).toBe(items[2]);
    expect(markedRead(items, {}).map((i) => i.read)).toEqual([false, false, true]);
  });
});
