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
/** A conversation whose run ended with the reply `reply`, and one running after the reply `reply`. */
const done = (id: string, reply: string) => summary(id, { lastReplyId: reply });
const busy = (id: string, reply?: string) => summary(id, { running: true, ...(reply ? { lastReplyId: reply } : {}) });

const conversation = (id: string): Conversation =>
  ({
    id,
    agents: [{ id: 'a1', name: 'Claude' }],
    messages: [{ id: 'm1', author: { kind: 'agent', agentId: 'a1' }, createdAt: 0, parts: [{ type: 'text', text: 'All tests pass.' }], status: 'done' }],
  }) as unknown as Conversation;

/** A push service that records what was sent (as the payloads it carried, not encrypted). */
class RecordingPush extends PushService {
  readonly payloads: { endpoint: string; payload: AlertPayload; urgency?: string }[] = [];
  /** A push service that does not answer for this endpoint (until each of `waiting` is called). */
  hanging?: { endpoint: string; waiting: (() => void)[] };
  override async push(sub: PushSubscriptionRecord, payload: AlertPayload, o: { urgency?: 'normal' | 'high' } = {}) {
    if (this.hanging?.endpoint === sub.endpoint) await new Promise<void>((r) => this.hanging!.waiting.push(r));
    this.payloads.push({ endpoint: sub.endpoint, payload, urgency: o.urgency });
    return 'sent' as const;
  }
}

const key = (n: number) => ({ p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, n)]).toString('base64url'), auth: Buffer.alloc(16, n).toString('base64url') });
const prefs: AlertPrefs = { done: true, needs: true, sound: true };
const PHONE = 'https://web.push.apple.com/phone';

describe('AlertWatcher', () => {
  let list: ConversationSummary[];
  let clock: number;
  let reads: number;
  let push: RecordingPush;
  let watcher: AlertWatcher;
  const sent = () => push.payloads.map((p) => [p.endpoint.slice(-5), p.payload.kind, p.payload.title]);
  /** A run of c1 that ends with a new reply, over two checks. */
  async function c1Replies(reply: string): Promise<void> {
    list = [busy('c1', 'm0'), done('c2', 'x')];
    await watcher.check();
    list = [done('c1', reply), done('c2', 'x')];
    await watcher.check();
  }

  beforeEach(() => {
    const db = openDatabase(':memory:');
    db.exec(`INSERT INTO auth_sessions (id, cookie_hash, key_hash, created_at, last_used_at) VALUES ('phone', '', '', 0, 0), ('laptop', '', '', 0, 0)`);
    push = new RecordingPush(db, undefined, async (_req: PushRequest) => ({ status: 201, text: '' }));
    clock = 1_000_000;
    reads = 0;
    list = [done('c1', 'm0'), done('c2', 'x')];
    watcher = new AlertWatcher({
      list: () => {
        reads++;
        return list;
      },
      get: conversation,
      push,
      now: () => clock,
    });
  });

  it('sends nothing while no browser has subscribed, and takes the states anew once one has', async () => {
    list = [busy('c1', 'm0'), done('c2', 'x')];
    await watcher.check();
    list = [done('c1', 'm1'), done('c2', 'x')];
    push.subscribe('phone', { endpoint: PHONE, keys: key(1) }, prefs, 'en');
    await watcher.check();
    expect(sent()).toEqual([]);
    await c1Replies('m2');
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
    push.subscribe('phone', { endpoint: PHONE, keys: key(1) }, { done: false, needs: true, sound: false }, 'zh-TW');
    push.subscribe('laptop', { endpoint: 'https://fcm.googleapis.com/laptop', keys: key(2) }, { done: true, needs: false, sound: true }, 'en');
    list = [busy('c1', 'm0'), done('c2', 'x')];
    await watcher.check();
    list = [done('c1', 'm1'), summary('c2', { confirmTeam: true, lastReplyId: 'x' })];
    await watcher.check();
    expect(sent()).toEqual([
      ['aptop', 'done', 'Chat c1'],
      ['phone', 'confirm', 'Chat c2'],
    ]);
    const phone = push.payloads.find((p) => p.endpoint.endsWith('phone'))!;
    expect(phone.payload).toMatchObject({ body: '首席 agent 設計好團隊了，等你確認', silent: true });
    expect(phone.urgency).toBe('high');
  });

  it('tells of a run that started and ended between two checks, and of nothing for one that left no reply', async () => {
    push.subscribe(undefined, { endpoint: 'https://web.push.apple.com/nosin', keys: key(3) }, prefs, 'en');
    await watcher.check();
    list = [done('c1', 'm0'), done('c2', 'y')];
    await watcher.check();
    expect(sent()).toEqual([['nosin', 'done', 'Chat c2']]);
    // The lead agent designed a team (no reply of an agent), or the run was stopped before one.
    list = [busy('c1', 'm0'), done('c2', 'y')];
    await watcher.check();
    list = [done('c1', 'm0'), done('c2', 'y')];
    await watcher.check();
    expect(sent()).toHaveLength(1);
  });

  it('holds what a browser with a page in front is told by the page, and drops it when that page polls again', async () => {
    push.subscribe('phone', { endpoint: PHONE, keys: key(1) }, prefs, 'en');
    await watcher.check();
    watcher.seen('phone', 'p1', true);
    clock += 1000;
    await c1Replies('m1');
    expect(sent()).toEqual([]);
    clock += 2000;
    watcher.seen('phone', 'p1', true);
    clock += PRESENT_MS;
    await watcher.check();
    expect(sent()).toEqual([]);
  });

  it("does not drop what was held at the first poll of a page that came after it: that page starts from it", async () => {
    push.subscribe('phone', { endpoint: PHONE, keys: key(1) }, prefs, 'en');
    await watcher.check();
    watcher.seen('phone', 'p1', true);
    clock += 1000;
    await c1Replies('m1');
    clock += 1000;
    watcher.seen('phone', 'p2', true);
    // The first page went away without saying so: what it was told of is sent.
    clock += PRESENT_MS - 1500;
    watcher.seen('phone', 'p2', true);
    clock += 1000;
    await watcher.check();
    expect(sent()).toEqual([]);
    watcher.seen('phone', 'p2', false);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent()).toEqual([['phone', 'done', 'Chat c1']]);
  });

  it('keeps holding while another page of the browser is still in front', async () => {
    push.subscribe('phone', { endpoint: PHONE, keys: key(1) }, prefs, 'en');
    await watcher.check();
    watcher.seen('phone', 'p1', true);
    watcher.seen('phone', 'p2', true);
    clock += 1000;
    await c1Replies('m1');
    watcher.seen('phone', 'p2', false);
    await watcher.check();
    expect(sent()).toEqual([]);
    clock += 1000;
    watcher.seen('phone', 'p1', true);
    watcher.seen('phone', 'p1', false);
    await watcher.check();
    expect(sent()).toEqual([]);
  });

  it('sends what it held once the page went to the background, or stopped polling', async () => {
    push.subscribe('phone', { endpoint: PHONE, keys: key(1) }, prefs, 'en');
    await watcher.check();
    watcher.seen('phone', 'p1', true);
    await c1Replies('m1');
    expect(sent()).toEqual([]);
    watcher.seen('phone', 'p1', false);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent()).toEqual([['phone', 'done', 'Chat c1']]);

    watcher.seen('phone', 'p1', true);
    await c1Replies('m2');
    expect(sent()).toHaveLength(1);
    clock += PRESENT_MS;
    await watcher.check();
    expect(sent()).toHaveLength(2);
  });

  it('drops a held need the user already answered elsewhere', async () => {
    push.subscribe('phone', { endpoint: PHONE, keys: key(1) }, prefs, 'en');
    await watcher.check();
    watcher.seen('phone', 'p1', true);
    list = [summary('c1', { running: true, waiting: true }), done('c2', 'x')];
    await watcher.check();
    list = [busy('c1'), done('c2', 'x')];
    clock += PRESENT_MS;
    await watcher.check();
    expect(sent()).toEqual([]);
  });

  it('reads the conversations only after an event, or while agents are at work', async () => {
    let working = false;
    const quiet = new AlertWatcher({
      list: () => {
        reads++;
        return list;
      },
      get: conversation,
      push,
      busy: () => working,
      now: () => clock,
    });
    push.subscribe('phone', { endpoint: PHONE, keys: key(1) }, prefs, 'en');
    await quiet.check();
    const first = reads;
    await quiet.check();
    await quiet.check();
    expect(reads).toBe(first);
    quiet.touch();
    await quiet.check();
    expect(reads).toBe(first + 1);
    working = true;
    await quiet.check();
    await quiet.check();
    expect(reads).toBe(first + 3);
  });

  it('tells other browsers while one push service does not answer', async () => {
    push.subscribe('phone', { endpoint: PHONE, keys: key(1) }, prefs, 'en');
    push.subscribe('laptop', { endpoint: 'https://fcm.googleapis.com/laptop', keys: key(2) }, prefs, 'en');
    push.hanging = { endpoint: PHONE, waiting: [] };
    await watcher.check();
    list = [busy('c1', 'm0'), done('c2', 'x')];
    await watcher.check();
    list = [done('c1', 'm1'), done('c2', 'x')];
    const first = watcher.check();
    list = [done('c1', 'm1'), done('c2', 'y')];
    const second = watcher.check();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent()).toEqual([
      ['aptop', 'done', 'Chat c1'],
      ['aptop', 'done', 'Chat c2'],
    ]);
    expect(push.hanging.waiting).toHaveLength(2);
    for (const answer of push.hanging.waiting) answer();
    await Promise.all([first, second]);
    expect(sent()).toHaveLength(4);
  });

  it("writes notifications in the browser's language, with no conversation to read from too", () => {
    expect(alertPayload({ id: 'c9', title: '' }, 'approval', undefined, { lang: 'en', prefs })).toMatchObject({
      title: 'Harness Relay',
      body: 'An agent is waiting for your approval',
    });
    expect(testPayload({ lang: 'zh-TW', prefs: { ...prefs, sound: false } })).toMatchObject({ kind: 'test', silent: true, url: '/#/settings/notifications' });
  });
});
