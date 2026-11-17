import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/server/db';
import type { GatewayTool } from '../src/server/gateway';
import { Outbox } from '../src/server/outbox';
import { Store } from '../src/server/store';
import { withLang } from '../src/server/i18n';
import type { Conversation } from '../src/shared/types';

/** A database with one conversation (`c1`), whose outbox items need it (foreign key). */
function setup() {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  store.create({
    id: 'c1',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    agents: [],
    settings: { mode: 'roundtable', rounds: 1, maxHops: 1, permission: 'read-only', cwd: '/tmp', approvals: 'ask' },
    messages: [],
    agentState: {},
    worktrees: {},
  } as unknown as Conversation);
  return { db, store };
}

const base = { convId: 'c1', messageId: 'm1', agentId: 'a', agentName: 'Alice', tool: 'mail_send', title: 'Mail to Bob', preview: { fields: [{ label: 'To', value: 'bob@example.com' }] } };

describe('the outbox', () => {
  it('keeps what an agent asked to send, returns the waiting one for an equal call, and counts what waits', () => {
    const { db } = setup();
    const outbox = new Outbox(db, () => 5);
    const first = outbox.add(base, { to: 'bob@example.com', body: 'Hi' });
    expect(first.existing).toBe(false);
    expect(first.item).toMatchObject({ ...base, status: 'pending', createdAt: 5 });
    const again = outbox.add(base, { body: 'Hi', to: 'bob@example.com' });
    expect(again).toEqual({ item: first.item, existing: true });
    expect(outbox.add(base, { to: 'carol@example.com', body: 'Hi' }).existing).toBe(false);
    expect(outbox.waiting('c1')).toBe(2);
    expect(outbox.list('c1').map((i) => i.status)).toEqual(['pending', 'pending']);
    // Read back by a server that starts again.
    expect(new Outbox(db).waiting('c1')).toBe(2);
  });

  it("sends only on the user's Send, once, with the arguments the agent gave, and keeps what happened", () => withLang('en', async () => {
    const { db } = setup();
    const outbox = new Outbox(db, () => 9);
    const sent: Record<string, unknown>[] = [];
    let fail = false;
    const tool = { name: 'mail_send', send: async (args: Record<string, unknown>) => (fail ? Promise.reject(new Error('550 refused')) : (sent.push(args), 'accepted')) } as unknown as GatewayTool;
    const find = (name: string) => (name === 'mail_send' ? tool : undefined);
    const { item } = outbox.add(base, { to: 'bob@example.com' });

    const done = await outbox.answer('c1', item.id, 'send', find);
    expect(done).toMatchObject({ status: 'sent', result: 'accepted', decidedAt: 9 });
    expect(sent).toEqual([{ to: 'bob@example.com' }]);
    expect(outbox.waiting('c1')).toBe(0);
    await expect(outbox.answer('c1', item.id, 'send', find)).rejects.toMatchObject({ status: 409 });
    await expect(outbox.answer('other', item.id, 'send', find)).rejects.toMatchObject({ status: 404 });

    const second = outbox.add(base, { to: 'carol@example.com' }).item;
    fail = true;
    expect(await outbox.answer('c1', second.id, 'send', find)).toMatchObject({ status: 'failed', result: '550 refused' });
    const third = outbox.add(base, { to: 'dan@example.com' }).item;
    expect(await outbox.answer('c1', third.id, 'discard', find)).toMatchObject({ status: 'discarded' });
    const fourth = outbox.add({ ...base, tool: 'gone' }, {}).item;
    expect(await outbox.answer('c1', fourth.id, 'send', find)).toMatchObject({ status: 'failed', result: 'No tool can send this item (gone)' });
    expect(sent).toHaveLength(1);
  }));

  it('refuses a second Send while the first is sending, and marks one a restart cut off as not known, never sent again', () => withLang('en', async () => {
    const { db } = setup();
    const outbox = new Outbox(db);
    let release!: () => void;
    const tool = { send: () => new Promise<string>((r) => (release = () => r('ok'))) } as unknown as GatewayTool;
    const { item } = outbox.add(base, {});
    const first = outbox.answer('c1', item.id, 'send', () => tool);
    await expect(outbox.answer('c1', item.id, 'send', () => tool)).rejects.toMatchObject({ status: 409 });
    expect(outbox.get(item.id)!.status).toBe('sending');
    // A server starting while it was still sending.
    const restarted = new Outbox(db);
    expect(restarted.get(item.id)).toMatchObject({ status: 'failed', result: expect.stringMatching(/stopped while sending/) });
    release();
    await first;
  }));

  it('goes with its conversation', () => {
    const { db, store } = setup();
    const outbox = new Outbox(db);
    outbox.add(base, {});
    store.delete('c1');
    outbox.forget('c1');
    expect(outbox.waiting('c1')).toBe(0);
    expect(outbox.list('c1')).toEqual([]);
  });
});
