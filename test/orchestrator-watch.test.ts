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
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WATCH_LIMITS, type Conversation, type ConversationSchedule, type ScheduleWatch } from '../src/shared/types';
import { forClient } from '../src/server/orchestrator';
import { checkFiles, mailEvent, triggerKey, type WatchCheck, type WatchContext } from '../src/server/watch';
import {
  agentMessages,
  calls,
  conversation,
  db,
  fake,
  finish,
  Hub,
  orchestrator,
  Orchestrator,
  project,
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
  const contexts: { cwd: string }[] = [];
  const scheduler = () =>
    new Scheduler(
      store,
      orchestrator,
      () => now,
      (_t, prev, ctx) => {
        given.push(prev);
        contexts.push(ctx);
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
    // The scheduler's own look checks it, beside the times (no Check now, no watchTick of the test's).
    await scheduler().tick();
    await vi.waitFor(() => expect(conv.schedule!.watch?.checkedAt).toBe(T0));
    // The first check only recorded.
    expect(given).toEqual([undefined]);
    expect(scheduled(conv)).toEqual([]);
    expect(conv.schedule!.watch).toEqual({
      key: triggerKey(trigger),
      uidValidity: 1,
      lastUid: 5,
      checkedAt: T0,
      seenAt: T0,
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
    // Mail that arrives while checks fail is still new later: when mail was last seen stays.
    expect(conv.schedule!.watch!.seenAt).toBe(T0);
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

  it('queues what it found while the team replies, its source kept to the message that delivers it', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    newMail(5, 6);
    await scheduler().watchTick();
    let release!: () => void;
    fake.gates.Alice = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    expect(conv.schedule).toMatchObject({ lastResult: 'queued', watch: { lastUid: 6 } });
    expect(conv.queue).toEqual([expect.objectContaining({ scheduled: true, eventSource: 'mail' })]);
    release();
    await finish(conv.id);
    const delivered = scheduled(conv);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.eventSource).toBe('mail');
    expect(calls.some((c) => c.prompt.includes('<event source="mail">'))).toBe(true);
  });

  it('opens a new chat each time when asked to, with the mail in its message', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv, { newChat: true });
    newMail(5, 6);
    await scheduler().watchTick();
    now = T0 + WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    const chatId = conv.schedule!.lastChatId!;
    expect(chatId).toBeDefined();
    await finish(chatId);
    const chat = store.get(chatId)!;
    const sent = chat.messages.find((m) => m.scheduled)!;
    expect(sent.eventSource).toBe('mail');
    expect(JSON.parse(sent.event!).mails[0].uid).toBe(6);
    expect(agentMessages(chat).length).toBeGreaterThan(0);
  });

  it('says in the chat when what it found could not be sent, and counts it as seen', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    newMail(5, 6);
    await scheduler().watchTick();
    const spy = vi.spyOn(orchestrator, 'sendScheduled').mockResolvedValueOnce({ result: 'failed', reason: 'the folder is gone.' });
    now = T0 + WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    spy.mockRestore();
    expect(conv.schedule).toMatchObject({ lastResult: 'failed', lastError: 'the folder is gone.', watch: { lastUid: 6 } });
    expect(textOf(conv.messages.at(-1)!)).toBe(
      'What the automation waits for happened, but its message could not be sent: the folder is gone',
    );
  });

  it('does not ask the source again while what it holds still waits for a team that cannot take it', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    newMail(5, 6);
    await scheduler().watchTick();
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    now = T0 + WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    expect(conv.schedule!.watch).toMatchObject({ lastUid: 5, held: expect.any(String) });
    expect(given).toHaveLength(2);
    // Still busy: the next check keeps it held without reading the mail again.
    now += WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    expect(given).toHaveLength(2);
    expect(conv.schedule!.watch).toMatchObject({ lastUid: 5, held: expect.any(String), checkedAt: now });
    release();
    await held;
    now += WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    await finish(conv.id);
    expect(given).toHaveLength(3);
    expect(scheduled(conv)).toHaveLength(1);
  });

  it('only records when checked while it is off (Check now), so trying it never starts a run', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    newMail(5, 6, 7);
    await scheduler().watchTick();
    conv.schedule = { ...conv.schedule!, enabled: false };
    store.saveSchedule(conv);
    answer = async (prev) => ({ state: { uidValidity: 1, lastUid: 7 }, total: prev ? 2 : 0, ...(prev ? { event: '{}' } : {}) });
    await scheduler().check(conv.id, true);
    expect(given.at(-1)).toBeUndefined();
    expect(scheduled(conv)).toEqual([]);
    expect(conv.schedule!.watch).toMatchObject({ lastUid: 7, checkedAt: now });
  });

  it('counts what it sent as seen when the automation was saved meanwhile, waiting for the same folder', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    newMail(5, 6);
    await scheduler().watchTick();
    const send = orchestrator.sendScheduled.bind(orchestrator);
    const spy = vi.spyOn(orchestrator, 'sendScheduled').mockImplementationOnce(async (...a) => {
      // Saved again while the message goes: the same trigger, other words in its message.
      conv.schedule = { ...conv.schedule!, text: 'triage it again' };
      return send(...a);
    });
    now = T0 + WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    spy.mockRestore();
    await finish(conv.id);
    expect(conv.schedule).toMatchObject({ text: 'triage it again', lastResult: 'sent', watch: { lastUid: 6 } });
    now += WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    await finish(conv.id);
    expect(scheduled(conv)).toHaveLength(1);
  });

  it("asks the source on the user's own check while mail is held, in the automation's language, and keeps when mail was last seen", async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv, { lang: 'en' });
    newMail(5, 6);
    await scheduler().watchTick();
    expect(conv.schedule!.watch!.seenAt).toBe(T0);
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    now = T0 + WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    expect(given).toHaveLength(2);
    // The shortcut's reason is in the automation's language (English here), and when mail was last seen stays.
    now += WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    expect(given).toHaveLength(2);
    expect(conv.schedule!.watch!.held).toMatch(/^[\x00-\x7F]+$/);
    expect(conv.schedule!.watch!.seenAt).toBe(T0);
    // Check now asks the source all the same.
    await scheduler().check(conv.id, true);
    expect(given).toHaveLength(3);
    release();
    await held;
  });

  it("checks a source with the conversation's working directory, and keeps what each source keeps", async () => {
    reset();
    contexts.length = 0;
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv, { repeat: { kind: 'event', trigger: { source: 'file', pattern: '*.csv' } } });
    answer = async () => ({
      state: {
        files: { 'a.csv': '1:2' },
        filesIn: conv.settings.cwd,
        uidValidity: 3,
        seen: ['x@1'],
        lookedAt: 5,
        lastId: 9,
        extra: 'no',
      } as never,
      total: 0,
    });
    await scheduler().watchTick();
    // The check's own time (the scheduler's clock); nothing writes in the folder.
    expect(contexts).toEqual([{ cwd: conv.settings.cwd, now: T0, recordOnly: false }]);
    expect(conv.schedule!.watch).toEqual({
      key: triggerKey({ source: 'file', pattern: '*.csv' }),
      uidValidity: 3,
      lastId: 9,
      seen: ['x@1'],
      lookedAt: 5,
      files: { 'a.csv': '1:2' },
      filesIn: conv.settings.cwd,
      checkedAt: T0,
      seenAt: T0,
      nextCheckAt: T0 + WATCH_LIMITS.checkMinutes * MIN,
    });
    // What it saw of each file and event stays in the server: browsers get the rest.
    const shown = forClient(store.get(conv.id)!).schedule!.watch!;
    expect(shown).not.toHaveProperty('files');
    expect(shown).not.toHaveProperty('seen');
    expect(shown).toMatchObject({ checkedAt: T0, lastId: 9 });
  });

  it('never starts again for what the team writes in the folder: while a run writes there, and at the first check after it, files are only recorded', async () => {
    reset();
    // The real file source, on the real clock (files are written now, and when the folder was free is compared with their times).
    now = Date.now();
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    const fileTrigger = { source: 'file' as const, pattern: '*.txt' };
    watching(conv, { repeat: { kind: 'event', trigger: fileTrigger } });
    const checker = (t: Parameters<typeof checkFiles>[0], prev: ScheduleWatch | undefined, ctx: WatchContext) =>
      checkFiles(t, prev, ctx.cwd, ctx.now, ctx.recordOnly, ctx.held);
    const s = () => new Scheduler(store, orchestrator, () => now, checker as never);
    const scheduledCount = () => scheduled(store.get(conv.id)!).length;
    await s().watchTick();
    expect(conv.schedule!.watch!.files).toEqual({ 'shared.txt': expect.any(String) });

    // A report from outside: the automation runs, and its run writes Alice.txt, Bob.txt and shared.txt,
    // then (held) one more file after the check that comes while it writes.
    const old = (now - 60_000) / 1000;
    writeFileSync(join(project, 'report.txt'), 'from outside\n');
    utimesSync(join(project, 'report.txt'), old, old);
    let finishWriting!: () => void;
    const writing = new Promise<void>((r) => (finishWriting = r));
    fake.inTurn = async (name, o) => {
      if (name !== 'Alice') return;
      await writing;
      writeFileSync(join(o.cwd, 'late.txt'), 'written at the end of the run\n');
    };
    now = Date.now();
    await s().check(conv.id);
    expect(scheduledCount()).toBe(1);
    expect(JSON.parse(scheduled(store.get(conv.id)!)[0]!.event!).files.map((f: { path: string }) => f.path)).toEqual(['report.txt']);
    expect(conv.schedule!.watch!.teamWrote).toBe(true);
    expect(orchestrator.folderInUse(conv.id)).toBe(true);
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toContain('Alice'));

    // While it writes: recorded, nothing sent.
    now = Date.now();
    await s().check(conv.id);
    expect(scheduledCount()).toBe(1);
    expect(Object.keys(conv.schedule!.watch!.files!).sort()).toEqual(['Alice.txt', 'report.txt', 'shared.txt']);
    expect(conv.schedule!.watch!.teamWrote).toBe(true);

    // The run ends having written late.txt: the first check with the folder free records it, and lets the flag go.
    finishWriting();
    await finish(conv.id);
    expect(orchestrator.folderInUse(conv.id)).toBe(false);
    now = Date.now();
    await s().check(conv.id);
    expect(scheduledCount()).toBe(1);
    expect(Object.keys(conv.schedule!.watch!.files!)).toContain('late.txt');
    expect(conv.schedule!.watch!.teamWrote).toBeUndefined();
    now = Date.now();
    await s().check(conv.id);
    expect(scheduledCount()).toBe(1);

    // Something from outside again starts it, once.
    writeFileSync(join(project, 'next.txt'), 'from outside again\n');
    utimesSync(join(project, 'next.txt'), (now - 60_000) / 1000, (now - 60_000) / 1000);
    fake.inTurn = undefined;
    now = Date.now();
    await s().check(conv.id);
    await finish(conv.id);
    expect(scheduledCount()).toBe(2);
  });

  it('checks more slowly while the mail server says when mail arrives (IMAP IDLE), and lists the automations IDLE listens for', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    const off = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(off, { enabled: false });
    const files = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(files, { repeat: { kind: 'event', trigger: { source: 'file', pattern: '*.csv' } } });
    expect(store.mailWatches()).toEqual([{ conversationId: conv.id, trigger }]);
    const s = scheduler();
    s.listening = (id) => id === conv.id;
    await s.check(conv.id);
    expect(conv.schedule!.watch).toMatchObject({ listening: true, nextCheckAt: T0 + WATCH_LIMITS.idleCheckMinutes * MIN });
    s.listening = () => false;
    now += MIN;
    await s.check(conv.id);
    expect(conv.schedule!.watch!.listening).toBeUndefined();
    expect(conv.schedule!.watch!.nextCheckAt).toBe(now + WATCH_LIMITS.checkMinutes * MIN);
  });

  it('checks once more after the check under way when the mail server says mail arrived meanwhile', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    answer = async () => {
      await gate;
      return { state: { uidValidity: 1, lastUid: 5 }, total: 0 };
    };
    const s = scheduler();
    const first = s.check(conv.id);
    // An ordinary second ask joins the check under way; IDLE's asks one more after it, shared.
    const joined = s.check(conv.id);
    const again1 = s.check(conv.id, false, true);
    const again2 = s.check(conv.id, false, true);
    open();
    await Promise.all([first, joined, again1, again2]);
    expect(given).toHaveLength(2);
  });

  it('checks held mail again in 2 minutes while it listens, and says it listens only while it does', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    newMail(5, 6);
    const s = scheduler();
    s.listening = () => true;
    await s.check(conv.id);
    expect(conv.schedule!.watch).toMatchObject({ listening: true, nextCheckAt: T0 + WATCH_LIMITS.idleCheckMinutes * MIN });
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    now = T0 + WATCH_LIMITS.idleCheckMinutes * MIN;
    await s.check(conv.id);
    expect(conv.schedule!.watch).toMatchObject({
      held: expect.any(String),
      nextCheckAt: now + WATCH_LIMITS.checkMinutes * MIN,
      listening: true,
    });
    // Not listening any more: the held state says so too.
    s.listening = () => false;
    now += WATCH_LIMITS.checkMinutes * MIN;
    await s.check(conv.id);
    expect(conv.schedule!.watch!.listening).toBeUndefined();
    release();
    await held;
  });

  it('still checks once more when the check under way failed (a conversation deleted meanwhile, say)', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    watching(conv);
    newMail(5, 6);
    const s = scheduler();
    await s.check(conv.id);
    const { HttpError } = await import('../src/server/errors');
    const spy = vi.spyOn(orchestrator, 'sendScheduled').mockRejectedValueOnce(new HttpError(404, 'gone'));
    now += WATCH_LIMITS.checkMinutes * MIN;
    const first = s.check(conv.id);
    const again = s.check(conv.id, false, true);
    await expect(first).rejects.toThrow('gone');
    await again;
    spy.mockRestore();
    // The follow-up ran, and a later ask is a new check, not the old failure.
    expect(given).toHaveLength(3);
    await s.check(conv.id, false, true);
    expect(given).toHaveLength(4);
  });

  it('still sends a file held for the team once a run of its starts and ends: what came before the team wrote is not its own', async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    const fileTrigger = { source: 'file' as const, pattern: '*.pdf' };
    watching(conv, { repeat: { kind: 'event', trigger: fileTrigger } });
    const checker = (t: Parameters<typeof checkFiles>[0], prev: ScheduleWatch | undefined, ctx: WatchContext) =>
      checkFiles(t, prev, ctx.cwd, ctx.now, ctx.recordOnly, ctx.held);
    const s = () => new Scheduler(store, orchestrator, () => now, checker as never);
    now = Date.now();
    await s().check(conv.id);
    // An invoice arrives while the team waits for the user: held.
    writeFileSync(join(project, 'invoice.pdf'), 'pdf');
    utimesSync(join(project, 'invoice.pdf'), (now - 60_000) / 1000, (now - 60_000) / 1000);
    const skip = vi.spyOn(orchestrator, 'sendScheduled').mockResolvedValueOnce({ result: 'skipped', reason: 'waits for your answer' });
    now = Date.now();
    await s().check(conv.id);
    skip.mockRestore();
    expect(conv.schedule!.watch!.held).toBe('waits for your answer');
    // The user answers: a run starts and writes in the folder; checks then only record, but keep the invoice unseen.
    const inUse = vi.spyOn(orchestrator, 'folderInUse').mockReturnValue(true);
    writeFileSync(join(project, 'draft.pdf'), 'the team wrote this');
    // Its time says nothing (a copy keeps an old one): it is the team's all the same.
    utimesSync(join(project, 'draft.pdf'), (now - 60_000) / 1000, (now - 60_000) / 1000);
    now = Date.now() + 1000;
    await s().check(conv.id);
    expect(conv.schedule!.watch!.teamWrote).toBe(true);
    inUse.mockReturnValue(false);
    now = Date.now() + 2000;
    await s().check(conv.id);
    inUse.mockRestore();
    expect(conv.schedule!.watch!.teamWrote).toBeUndefined();
    expect(scheduled(conv)).toHaveLength(0);
    // The next check lists the invoice, not what the team wrote.
    now = Date.now() + 60_000;
    await s().check(conv.id);
    await finish(conv.id);
    const sent = scheduled(conv);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.event!).files.map((f: { path: string }) => f.path)).toEqual(['invoice.pdf']);
  });

  it("takes what is written while nothing is recorded (held, a failed check) as the team's, and a read-only run as no writer", async () => {
    reset();
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    watching(conv, { repeat: { kind: 'event', trigger: { source: 'file', pattern: '*.pdf' } } });
    const s = scheduler();
    await s.check(conv.id);
    const inUse = vi.spyOn(orchestrator, 'folderInUse').mockReturnValue(true);
    answer = async () => {
      throw new Error('disk gone');
    };
    now += WATCH_LIMITS.checkMinutes * MIN;
    await s.check(conv.id);
    expect(conv.schedule!.watch).toMatchObject({ error: 'disk gone', teamWrote: true });
    inUse.mockRestore();
    // A read-only conversation's own run never writes in its folder.
    const ro = conversation({ mode: 'roundtable', permission: 'read-only' });
    let release!: () => void;
    fake.gates.Alice = new Promise((r) => (release = r));
    await orchestrator.send(ro.id, 'look');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toContain('Alice'));
    expect(orchestrator.folderInUse(ro.id)).toBe(false);
    release();
    await finish(ro.id);
  });
});
