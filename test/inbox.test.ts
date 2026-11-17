import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Database } from '../src/server/db';
import { INBOX_CHECK_MS, Inbox, newConversationNews } from '../src/server/inbox';
import { INBOX_KEPT, Store } from '../src/server/store';
import type { ChatMessage, Conversation, ConversationSummary } from '../src/shared/types';

const conversation = (id: string, title = `Chat ${id}`, messages: ChatMessage[] = []): Conversation => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  agents: [
    { id: 'a1', name: 'Claude', provider: 'claude', role: '' },
    { id: 'a2', name: 'Codex', provider: 'codex', role: '' },
  ],
  settings: { mode: 'roundtable', rounds: 1, maxHops: 6, permission: 'edit', cwd: '/tmp' },
  messages,
  agentState: {},
  worktrees: {},
});

const reply = (id: string, agentId: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author: { kind: 'agent', agentId },
  createdAt: 2,
  parts: [{ type: 'text', text }],
  status: 'done',
  ...extra,
});

const summary = (id: string, s: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id,
  title: `Chat ${id}`,
  createdAt: 0,
  updatedAt: 0,
  agents: [{ name: 'Claude', provider: 'claude' }],
  running: false,
  lastStatus: 'done',
  ...s,
});

describe('notification inbox storage', () => {
  let db: Database;
  let store: Store;
  let n: number;
  const add = (conversationId: string, kind: 'done' | 'error' | 'approval' | 'confirm' | 'answer' = 'done', at = ++n) =>
    store.addNotification({ id: `n${at}`, conversationId, kind, agent: 'Claude', text: 'All tests pass.', createdAt: at });

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new Store(db);
    store.create(conversation('c1', 'First'));
    store.create(conversation('c2', 'Second'));
    n = 0;
  });

  it('keeps notifications unread, the newest first, with their conversation’s title now', () => {
    expect(add('c1')).toEqual({
      id: 'n1',
      conversationId: 'c1',
      title: 'First',
      kind: 'done',
      agent: 'Claude',
      text: 'All tests pass.',
      createdAt: 1,
      read: false,
    });
    add('c2', 'approval');
    expect(store.notifications().map((x) => [x.id, x.kind, x.title])).toEqual([
      ['n2', 'approval', 'Second'],
      ['n1', 'done', 'First'],
    ]);
    // Renamed since: its notifications follow.
    const c1 = store.get('c1')!;
    c1.title = 'Renamed';
    store.saveMeta(c1);
    expect(store.notifications()[1]!.title).toBe('Renamed');
    // Without an agent or a text, neither is listed.
    store.addNotification({ id: 'bare', conversationId: 'c1', kind: 'confirm', createdAt: 10 });
    expect(store.notifications()[0]).toEqual({
      id: 'bare',
      conversationId: 'c1',
      title: 'Renamed',
      kind: 'confirm',
      createdAt: 10,
      read: false,
    });
  });

  it('sums up how many are unread, where (the latest first), and the newest one', () => {
    expect(store.notificationSummary()).toEqual({ unread: 0, unreadIn: [] });
    add('c1');
    add('c2');
    add('c1', 'error');
    expect(store.notificationSummary()).toEqual({ unread: 3, unreadIn: ['c1', 'c2'], newest: 'n3' });
  });

  it("marks read those named, one conversation's, or all; only unread ones count", () => {
    add('c1');
    add('c1');
    add('c2');
    add('c2');
    expect(store.readNotifications({ ids: ['n1', 'missing'] }, 50)).toBe(1);
    expect(store.readNotifications({ ids: ['n1'] }, 51)).toBe(0);
    expect(store.notificationSummary()).toEqual({ unread: 3, unreadIn: ['c2', 'c1'], newest: 'n4' });
    expect(store.readNotifications({ conversationId: 'c2' })).toBe(2);
    expect(store.notificationSummary()).toEqual({ unread: 1, unreadIn: ['c1'], newest: 'n4' });
    expect(store.readNotifications({ all: true })).toBe(1);
    expect(store.notificationSummary()).toEqual({ unread: 0, unreadIn: [], newest: 'n4' });
    expect(store.notifications().every((x) => x.read)).toBe(true);
  });

  it('clears them all', () => {
    add('c1');
    add('c2');
    store.clearNotifications();
    expect(store.notifications()).toEqual([]);
    expect(store.notificationSummary()).toEqual({ unread: 0, unreadIn: [] });
  });

  it('removes them with their conversation, and keeps none for a conversation that is gone', () => {
    add('c1');
    add('c2');
    store.delete('c1');
    expect(store.notifications().map((x) => x.conversationId)).toEqual(['c2']);
    expect(add('c1')).toBeUndefined();
    expect(store.addNotification({ id: 'x', conversationId: 'never', kind: 'done', createdAt: 1 })).toBeUndefined();
    expect(store.notifications()).toHaveLength(1);
  });

  it(`keeps only the newest ${INBOX_KEPT}`, () => {
    for (let i = 0; i < INBOX_KEPT + 5; i++) add(i % 2 ? 'c1' : 'c2');
    const kept = store.notifications();
    expect(kept).toHaveLength(INBOX_KEPT);
    expect(kept[0]!.id).toBe(`n${INBOX_KEPT + 5}`);
    expect(kept.at(-1)!.id).toBe('n6');
  });

  it('survives a restart', () => {
    add('c1');
    store.readNotifications({ ids: ['n1'] });
    add('c2');
    expect(new Store(db).notifications().map((x) => [x.id, x.read])).toEqual([
      ['n2', false],
      ['n1', true],
    ]);
  });
});

describe('Inbox (the recorder)', () => {
  let store: Store;
  let list: ConversationSummary[];
  let busy: boolean;
  let reads: number;
  let ids: number;
  let inbox: Inbox;

  beforeEach(() => {
    store = new Store(openDatabase(':memory:'));
    store.create(conversation('c1', 'First', [reply('m1', 'a1', 'Old reply.')]));
    store.create(conversation('c2', 'Second'));
    list = [summary('c1', { lastReplyId: 'm1' }), summary('c2')];
    busy = true;
    reads = 0;
    ids = 0;
    inbox = new Inbox({
      list: () => {
        reads++;
        return list;
      },
      get: (id) => store.get(id),
      store,
      busy: () => busy,
      now: () => 1000 + ids,
      newId: () => `n${++ids}`,
    });
  });

  it('starts from the first read: nothing before is news', () => {
    list = [summary('c1', { waiting: true, lastReplyId: 'm1' }), summary('c2')];
    expect(inbox.check()).toEqual([]);
    expect(store.notifications()).toEqual([]);
  });

  it("keeps a reply's end with the agent and what it said, and a need with what it asks", () => {
    inbox.check();
    list = [summary('c1', { running: true, lastReplyId: 'm1' }), summary('c2')];
    inbox.check();
    const c1 = store.get('c1')!;
    c1.messages.push(reply('m2', 'a2', '## Done\n\nAll **tests** pass.'));
    list = [summary('c1', { lastReplyId: 'm2' }), summary('c2')];
    expect(inbox.check().map((x) => [x.kind, x.agent, x.text])).toEqual([['done', 'Codex', 'Done All tests pass.']]);

    c1.messages.push({
      ...reply('m3', 'a1', ''),
      status: 'streaming',
      parts: [
        {
          type: 'approval',
          id: 'ap1',
          kind: 'command',
          tool: 'Bash',
          detail: 'npm install left-pad',
          status: 'pending',
        } as ChatMessage['parts'][number],
      ],
    });
    list = [summary('c1', { running: true, waiting: true, lastReplyId: 'm3', lastStatus: 'streaming' }), summary('c2')];
    expect(inbox.check().map((x) => [x.kind, x.agent, x.text])).toEqual([['approval', 'Claude', 'npm install left-pad']]);
    expect(store.notificationSummary()).toEqual({ unread: 2, unreadIn: ['c1'], newest: 'n2' });
  });

  it('keeps a team to confirm and an error, and nothing for a run stopped before any reply', () => {
    inbox.check();
    list = [summary('c1', { confirmTeam: true, lastReplyId: 'm1' }), summary('c2', { running: true })];
    inbox.check();
    list = [summary('c1', { confirmTeam: true, lastReplyId: 'm1' }), summary('c2')];
    inbox.check();
    store.get('c2')!.messages.push(reply('e1', 'a1', '', { status: 'error', error: 'rate limited' }));
    list = [summary('c1', { confirmTeam: true, lastReplyId: 'm1' }), summary('c2', { running: true })];
    inbox.check();
    list = [summary('c1', { confirmTeam: true, lastReplyId: 'm1' }), summary('c2', { lastReplyId: 'e1', lastStatus: 'error' })];
    inbox.check();
    expect(store.notifications().map((x) => [x.conversationId, x.kind, x.agent ?? null, x.text ?? null])).toEqual([
      ['c2', 'error', 'Claude', 'rate limited'],
      ['c1', 'confirm', null, null],
    ]);
  });

  it('reads nothing while no agent is at work and no conversation event came', () => {
    inbox.check();
    busy = false;
    expect(reads).toBe(1);
    inbox.check();
    expect(reads).toBe(1);
    inbox.touch();
    inbox.check();
    expect(reads).toBe(2);
    inbox.check();
    expect(reads).toBe(2);
    busy = true;
    inbox.check();
    expect(reads).toBe(3);
  });

  it("keeps the reply of a conversation made and answered between two reads, not a branch's nor one still running", () => {
    inbox.check();
    store.create(conversation('c3', 'Third', [reply('r1', 'a1', 'Quick answer.')]));
    store.create(conversation('c4', 'Branch', [reply('r2', 'a1', 'Copied.')]));
    store.create(conversation('c5', 'Busy', [reply('r3', 'a1', 'First.')]));
    list = [
      summary('c1', { lastReplyId: 'm1' }),
      summary('c2'),
      summary('c3', { lastReplyId: 'r1' }),
      summary('c4', { lastReplyId: 'r2', branchFrom: { id: 'c1', title: 'First' } }),
      summary('c5', { running: true, lastReplyId: 'r3' }),
    ];
    expect(inbox.check().map((x) => [x.conversationId, x.kind, x.text])).toEqual([['c3', 'done', 'Quick answer.']]);
    // Seen now: the same state again is no news.
    inbox.touch();
    expect(inbox.check()).toEqual([]);
    expect(newConversationNews({ running: false, lastReplyId: 'x', lastStatus: 'error' })).toBe('error');
    expect(newConversationNews({ running: false, lastReplyId: 'x', lastStatus: 'aborted' })).toBeUndefined();
    expect(newConversationNews({ running: false, lastStatus: 'done' })).toBeUndefined();
  });

  describe('in the background', () => {
    afterEach(() => {
      inbox.stop();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('reads at start, then every 1.5 s; a failed read is logged, never thrown, and the next one tries again', () => {
      vi.useFakeTimers();
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failing = new Inbox({
        list: () => {
          reads++;
          throw new Error('database is locked');
        },
        get: () => undefined,
        store,
      });
      inbox = failing;
      expect(() => failing.start()).not.toThrow();
      expect(reads).toBe(1);
      vi.advanceTimersByTime(INBOX_CHECK_MS);
      expect(reads).toBe(2);
      expect(logged).toHaveBeenCalledTimes(2);
      expect(String(logged.mock.calls[0]![1])).toContain('database is locked');
      failing.stop();
      vi.advanceTimersByTime(INBOX_CHECK_MS * 3);
      expect(reads).toBe(2);
    });
  });

  it('keeps nothing for a conversation deleted meanwhile', () => {
    inbox.check();
    store.delete('c2');
    list = [summary('c1', { lastReplyId: 'm1' }), summary('c2', { asking: true })];
    expect(inbox.check()).toEqual([]);
    expect(store.notifications()).toEqual([]);
  });
});
