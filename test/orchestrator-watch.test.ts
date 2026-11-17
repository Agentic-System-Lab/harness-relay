/*
 * Automations that start when something happens: the scheduler checks what each waits for (a stand-in
 * for the mail source here; `watch.test.ts` checks the real one against a stand-in IMAP server), with
 * a fake clock. The first check records and sends nothing; something new sends the message once, with
 * it in an <event> block marked as mail; a restart does not send it again; a failed check is kept and
 * the next ones come slower; a team that cannot take it leaves it for a later check, which sends it
 * with what came meanwhile.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { describe, expect, it } from 'vitest';
import { WATCH_LIMITS, type Conversation, type ConversationSchedule, type ScheduleWatch } from '../src/shared/types';
import { mailEvent, triggerKey, type WatchCheck } from '../src/server/watch';
import {
  calls,
  conversation,
  db,
  finish,
  Hub,
  orchestrator,
  Orchestrator,
  Scheduler,
  setOrchestrator,
  setStore,
  settings,
  store,
  Store,
  textOf,
} from './orchestrator-harness';

const MIN = 60_000;
/** Monday 5 January 2026, 08:00 UTC. */
const T0 = Date.UTC(2026, 0, 5, 8, 0);
const trigger = { source: 'mail' as const, account: 'work', folder: 'INBOX' };

describe('automations that start when something happens', () => {
  let now = T0;
  /** What the stand-in source answers next, and what each check was given. */
  let answer: (prev: ScheduleWatch | undefined) => Promise<WatchCheck> = async () => ({ state: { uidValidity: 1, lastUid: 5 }, total: 0 });
  const given: (ScheduleWatch | undefined)[] = [];
  const scheduler = () =>
    new Scheduler(
      store,
      orchestrator,
      () => now,
      (_t, prev) => {
        given.push(prev);
        return answer(prev);
      },
    );
  /** New mail after `lastUid`: the next check finds these. */
  const newMail = (lastUid: number, ...uids: number[]) =>
    (answer = async (prev) =>
      prev?.lastUid === undefined
        ? { state: { uidValidity: 1, lastUid }, total: 0 }
        : uids.some((u) => u > prev.lastUid!)
          ? {
              state: { uidValidity: 1, lastUid: Math.max(...uids) },
              total: uids.length,
              event: mailEvent(
                'Work',
                'INBOX',
                uids
                  .filter((u) => u > prev.lastUid!)
                  .map((uid) => ({ uid, from: 'Bob <bob@example.com>', subject: `Mail ${uid}`, date: 'd', excerpt: 'Hi' })),
                uids.length,
              ),
            }
          : { state: prev, total: 0 }) as typeof answer;
  const watching = (conv: Conversation, s: Partial<ConversationSchedule> = {}) => {
    conv.schedule = {
      text: 'triage the new mail',
      repeat: { kind: 'event', trigger },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: T0,
      ...s,
    };
    store.saveSchedule(conv);
  };
  const scheduled = (conv: Conversation) => conv.messages.filter((m) => m.scheduled);
  const reset = () => {
    now = T0;
    given.length = 0;
    answer = async () => ({ state: { uidValidity: 1, lastUid: 5 }, total: 0 });
  };

  it('records what is there at first, then sends the message once for what is new, with it as mail in an <event> block', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    newMail(5, 6, 7);
    expect(store.watchDue(now)).toEqual([conv.id]);
    await scheduler().tick();
    await scheduler().watchTick();
    // The first check only recorded.
    expect(given).toEqual([undefined]);
    expect(scheduled(conv)).toEqual([]);
    expect(conv.schedule!.watch).toEqual({
      key: triggerKey(trigger),
      uidValidity: 1,
      lastUid: 5,
      checkedAt: T0,
      nextCheckAt: T0 + WATCH_LIMITS.checkMinutes * MIN,
    });
    // Not yet due again.
    expect(store.watchDue(now + MIN)).toEqual([]);

    now = T0 + WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    await finish(conv.id);
    const sent = scheduled(conv);
    expect(sent).toHaveLength(1);
    expect(textOf(sent[0]!)).toBe('triage the new mail');
    expect(sent[0]!.eventSource).toBe('mail');
    expect(JSON.parse(sent[0]!.event!).mails.map((m: { uid: number }) => m.uid)).toEqual([6, 7]);
    // The agents get it as data, said to come from mail.
    expect(calls[0]!.prompt).toContain('<event source="mail">');
    expect(calls[0]!.prompt).not.toContain('source="webhook"');
    expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: now, watch: { lastUid: 7 } });
    // Kept with the message, its source too.
    expect(new Store(db).get(conv.id)!.messages.find((m) => m.scheduled)!.eventSource).toBe('mail');

    // Seen: a restart (a new store and scheduler) does not send it again.
    setStore(new Store(db));
    setOrchestrator(new Orchestrator(store, new Hub(), settings));
    const again = store.get(conv.id)!;
    expect(again.schedule!.watch!.lastUid).toBe(7);
    now += WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    await finish(conv.id);
    expect(scheduled(again)).toHaveLength(1);
  });

  it('keeps a failed check in the automation, checks again more slowly, and clears it once a check works', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    await scheduler().watchTick();
    answer = async () => {
      throw new Error('mail server unreachable');
    };
    now = T0 + WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    expect(conv.schedule!.watch).toMatchObject({
      lastUid: 5,
      error: 'mail server unreachable',
      failures: 1,
      nextCheckAt: now + WATCH_LIMITS.backoffMinutes[0]! * MIN,
    });
    now += WATCH_LIMITS.backoffMinutes[0]! * MIN;
    await scheduler().watchTick();
    expect(conv.schedule!.watch).toMatchObject({ failures: 2, nextCheckAt: now + WATCH_LIMITS.backoffMinutes[1]! * MIN });
    // The sidebar shows it.
    expect(store.list(() => false).find((c) => c.id === conv.id)!.schedule).toMatchObject({ trigger, watchError: true });

    newMail(5);
    now += WATCH_LIMITS.backoffMinutes[1]! * MIN;
    await scheduler().watchTick();
    expect(conv.schedule!.watch!.error).toBeUndefined();
    expect(conv.schedule!.watch!.failures).toBeUndefined();
    expect(scheduled(conv)).toEqual([]);
  });

  it('leaves new mail the team cannot take now for a later check, which sends it with what came meanwhile', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    newMail(5, 6);
    await scheduler().watchTick();
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    now = T0 + WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    expect(scheduled(conv)).toEqual([]);
    // Not seen yet: still at 5, and why it waits is shown.
    expect(conv.schedule!.watch).toMatchObject({ lastUid: 5, held: expect.any(String) });
    expect(conv.schedule!.lastResult).toBeUndefined();
    release();
    await held;

    newMail(5, 6, 8);
    now += WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    await finish(conv.id);
    const sent = scheduled(conv);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.event!).mails.map((m: { uid: number }) => m.uid)).toEqual([6, 8]);
    expect(conv.schedule!.watch!.held).toBeUndefined();
    expect(conv.schedule!.watch!.lastUid).toBe(8);
  });

  it('checks an automation that is off only when the user asks (Check now), and one check at a time', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv, { enabled: false });
    expect(store.watchDue(now)).toEqual([]);
    const s = scheduler();
    await s.watchTick();
    expect(given).toEqual([]);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    answer = async () => {
      await gate;
      return { state: { uidValidity: 1, lastUid: 2 }, total: 0 };
    };
    const one = s.check(conv.id, true);
    const two = s.check(conv.id, true);
    open();
    await Promise.all([one, two]);
    expect(given).toHaveLength(1);
    expect(conv.schedule!.watch!.lastUid).toBe(2);
  });

  it('leaves an automation changed while it was checked to its new settings', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    answer = async () => {
      await gate;
      return { state: { uidValidity: 1, lastUid: 9 }, total: 0 };
    };
    const checking = scheduler().watchTick();
    const replaced = { ...conv.schedule!, repeat: { kind: 'event' as const, trigger: { ...trigger, folder: 'Alerts' } } };
    conv.schedule = replaced;
    open();
    await checking;
    expect(conv.schedule).toBe(replaced);
    expect(conv.schedule.watch).toBeUndefined();
  });
});
