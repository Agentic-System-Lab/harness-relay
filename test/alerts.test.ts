import { beforeEach, describe, expect, it } from 'vitest';
import { AlertWatcher, PRESENT_MS, alertPayload, testPayload } from '../src/server/alerts';
import { openDatabase } from '../src/server/db';
import { PushService, type PushRequest, type PushSubscriptionRecord } from '../src/server/push';
import type { AlertPayload, AlertPrefs, Conversation, ConversationSummary } from '../src/shared/types';

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

const conversation = (id: string): Conversation =>
  ({
    id,
    agents: [{ id: 'a1', name: 'Claude' }],
    messages: [{ id: 'm1', author: { kind: 'agent', agentId: 'a1' }, createdAt: 0, parts: [{ type: 'text', text: 'All tests pass.' }], status: 'done' }],
  }) as unknown as Conversation;

/** A push service that records what was sent (as the payloads it carried, not encrypted). */
class RecordingPush extends PushService {
  readonly payloads: { endpoint: string; payload: AlertPayload; urgency?: string }[] = [];
  override async push(sub: PushSubscriptionRecord, payload: AlertPayload, o: { urgency?: 'normal' | 'high' } = {}) {
    this.payloads.push({ endpoint: sub.endpoint, payload, urgency: o.urgency });
    return 'sent' as const;
  }
}

const key = (n: number) => ({ p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, n)]).toString('base64url'), auth: Buffer.alloc(16, n).toString('base64url') });
const prefs: AlertPrefs = { done: true, needs: true, sound: true };

describe('AlertWatcher', () => {
  let list: ConversationSummary[];
  let clock: number;
  let push: RecordingPush;
  let watcher: AlertWatcher;
  const sent = () => push.payloads.map((p) => [p.endpoint.slice(-5), p.payload.kind, p.payload.title]);

  beforeEach(() => {
    const db = openDatabase(':memory:');
    db.exec(`INSERT INTO auth_sessions (id, cookie_hash, key_hash, created_at, last_used_at) VALUES ('phone', '', '', 0, 0), ('laptop', '', '', 0, 0)`);
    push = new RecordingPush(db, undefined, async (_req: PushRequest) => ({ status: 201, text: '' }));
    clock = 1_000_000;
    list = [summary('c1', { running: true }), summary('c2')];
    watcher = new AlertWatcher({ list: () => list, get: conversation, push, now: () => clock });
  });

  it('sends nothing while no browser has subscribed, and takes the states anew once one has', async () => {
    await watcher.check();
    list = [summary('c1'), summary('c2')];
    push.subscribe('phone', { endpoint: 'https://web.push.apple.com/phone', keys: key(1) }, prefs, 'en');
    await watcher.check();
    expect(sent()).toEqual([]);
    list = [summary('c1', { running: true }), summary('c2')];
    await watcher.check();
    list = [summary('c1'), summary('c2')];
    await watcher.check();
    expect(sent()).toEqual([['phone', 'done', 'Chat c1']]);
    expect(push.payloads[0]!.payload).toEqual({
      title: 'Chat c1',
      body: 'Claude finished replying\nAll tests pass.',
      tag: 'relay-c1',
      url: '/#/c/c1',
      silent: false,
      kind: 'done',
    });
  });

  it('tells each browser what it asked for, in its language and with its sound, urgently when it is needed', async () => {
    push.subscribe('phone', { endpoint: 'https://web.push.apple.com/phone', keys: key(1) }, { done: false, needs: true, sound: false }, 'zh-TW');
    push.subscribe('laptop', { endpoint: 'https://fcm.googleapis.com/laptop', keys: key(2) }, { done: true, needs: false, sound: true }, 'en');
    await watcher.check();
    list = [summary('c1'), summary('c2', { confirmTeam: true })];
    await watcher.check();
    expect(sent()).toEqual([
      ['aptop', 'done', 'Chat c1'],
      ['phone', 'confirm', 'Chat c2'],
    ]);
    const phone = push.payloads.find((p) => p.endpoint.endsWith('phone'))!;
    expect(phone.payload).toMatchObject({ body: '首席 agent 設計好團隊了，等你確認', silent: true });
    expect(phone.urgency).toBe('high');
  });

  it('tells of a run that started and ended between two checks', async () => {
    push.subscribe(undefined, { endpoint: 'https://web.push.apple.com/nosin', keys: key(3) }, prefs, 'en');
    list = [summary('c1'), summary('c2', { lastReplyId: 'm1' })];
    await watcher.check();
    list = [summary('c1'), summary('c2', { lastReplyId: 'm2' })];
    await watcher.check();
    expect(sent()).toEqual([['nosin', 'done', 'Chat c2']]);
  });

  it('holds what a browser with a page in front is told by the page, and drops it when the page polls again', async () => {
    push.subscribe('phone', { endpoint: 'https://web.push.apple.com/phone', keys: key(1) }, prefs, 'en');
    await watcher.check();
    watcher.seen('phone', true);
    clock += 1000;
    list = [summary('c1'), summary('c2')];
    await watcher.check();
    expect(sent()).toEqual([]);
    clock += 2000;
    watcher.seen('phone', true);
    clock += PRESENT_MS;
    await watcher.check();
    expect(sent()).toEqual([]);
  });

  it('sends what it held once the page went to the background, or stopped polling', async () => {
    push.subscribe('phone', { endpoint: 'https://web.push.apple.com/phone', keys: key(1) }, prefs, 'en');
    await watcher.check();
    watcher.seen('phone', true);
    list = [summary('c1'), summary('c2')];
    await watcher.check();
    expect(sent()).toEqual([]);
    watcher.seen('phone', false);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent()).toEqual([['phone', 'done', 'Chat c1']]);

    watcher.seen('phone', true);
    list = [summary('c1', { running: true }), summary('c2')];
    await watcher.check();
    list = [summary('c1'), summary('c2')];
    await watcher.check();
    expect(sent()).toHaveLength(1);
    clock += PRESENT_MS;
    await watcher.check();
    expect(sent()).toHaveLength(2);
  });

  it('drops a held need the user already answered elsewhere', async () => {
    push.subscribe('phone', { endpoint: 'https://web.push.apple.com/phone', keys: key(1) }, prefs, 'en');
    await watcher.check();
    watcher.seen('phone', true);
    list = [summary('c1', { running: true, waiting: true }), summary('c2')];
    await watcher.check();
    list = [summary('c1', { running: true }), summary('c2')];
    clock += PRESENT_MS;
    await watcher.check();
    expect(sent()).toEqual([]);
  });

  it('writes notifications in the browser\'s language, with no conversation to read from too', () => {
    expect(alertPayload({ id: 'c9', title: '' }, 'approval', undefined, { lang: 'en', prefs })).toMatchObject({
      title: 'Harness Relay',
      body: 'An agent is waiting for your approval',
    });
    expect(testPayload({ lang: 'zh-TW', prefs: { ...prefs, sound: false } })).toMatchObject({ kind: 'test', silent: true, url: '/#/settings/notifications' });
  });
});
