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
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WATCH_LIMITS, type Conversation, type ConversationSchedule, type ScheduleTrigger, type ScheduleWatch } from '../src/shared/types';
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
      repeat: { kind: 'event', triggers: [trigger] },
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
  /** What the checks keep of the automation's first (here, only) trigger. */
  const w = (conv: Conversation) => conv.schedule!.watches?.[0];
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
    await vi.waitFor(() => expect(w(conv)?.checkedAt).toBe(T0));
    // The first check only recorded.
    expect(given).toEqual([undefined]);
    expect(scheduled(conv)).toEqual([]);
    expect(w(conv)).toEqual({
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
    expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: now, watches: [{ lastUid: 7 }] });
    // Kept with the message, its source too.
    expect(new Store(db).get(conv.id)!.messages.find((m) => m.scheduled)!.eventSource).toBe('mail');

    // Seen: a restart (a new store and scheduler) does not send it again.
    setStore(new Store(db));
    setOrchestrator(new Orchestrator(store, new Hub(), settings));
    const again = store.get(conv.id)!;
    expect(w(again)!.lastUid).toBe(7);
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
    expect(w(conv)).toMatchObject({
      lastUid: 5,
      error: 'mail server unreachable',
      failures: 1,
      nextCheckAt: now + WATCH_LIMITS.backoffMinutes[0]! * MIN,
    });
    now += WATCH_LIMITS.backoffMinutes[0]! * MIN;
    await scheduler().watchTick();
    expect(w(conv)).toMatchObject({ failures: 2, nextCheckAt: now + WATCH_LIMITS.backoffMinutes[1]! * MIN });
    // Mail that arrives while checks fail is still new later: when mail was last seen stays.
    expect(w(conv)!.seenAt).toBe(T0);
    // The sidebar shows it.
    expect(store.list(() => false).find((c) => c.id === conv.id)!.schedule).toMatchObject({ triggers: [trigger], watchError: true });

    newMail(5);
    now += WATCH_LIMITS.backoffMinutes[1]! * MIN;
    await scheduler().watchTick();
    expect(w(conv)!.error).toBeUndefined();
    expect(w(conv)!.failures).toBeUndefined();
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
    expect(w(conv)).toMatchObject({ lastUid: 5, held: expect.any(String) });
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
    expect(w(conv)!.held).toBeUndefined();
    expect(w(conv)!.lastUid).toBe(8);
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
    expect(w(conv)!.lastUid).toBe(2);
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
    const replaced = { ...conv.schedule!, repeat: { kind: 'event' as const, triggers: [{ ...trigger, folder: 'Alerts' }] } };
    conv.schedule = replaced;
    open();
    await checking;
    expect(conv.schedule).toBe(replaced);
    expect(conv.schedule.watches).toBeUndefined();
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
    expect(conv.schedule).toMatchObject({ lastResult: 'queued', watches: [{ lastUid: 6 }] });
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
    expect(conv.schedule).toMatchObject({ lastResult: 'failed', lastError: 'the folder is gone.', watches: [{ lastUid: 6 }] });
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
    expect(w(conv)).toMatchObject({ lastUid: 5, held: expect.any(String) });
    expect(given).toHaveLength(2);
    // Still busy: the next check keeps it held without reading the mail again.
    now += WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    expect(given).toHaveLength(2);
    expect(w(conv)).toMatchObject({ lastUid: 5, held: expect.any(String), checkedAt: now });
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
    expect(w(conv)).toMatchObject({ lastUid: 7, checkedAt: now });
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
    expect(conv.schedule).toMatchObject({ text: 'triage it again', lastResult: 'sent', watches: [{ lastUid: 6 }] });
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
    expect(w(conv)!.seenAt).toBe(T0);
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    now = T0 + WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    expect(given).toHaveLength(2);
    // The shortcut's reason is in the automation's language (English here), and when mail was last seen stays.
    now += WATCH_LIMITS.checkMinutes * MIN;
    await scheduler().watchTick();
    expect(given).toHaveLength(2);
    expect(w(conv)!.held).toMatch(/^[\x00-\x7F]+$/);
    expect(w(conv)!.seenAt).toBe(T0);
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
    watching(conv, { repeat: { kind: 'event', triggers: [{ source: 'file', pattern: '*.csv' }] } });
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
    expect(w(conv)).toEqual({
      key: triggerKey({ source: 'file', pattern: '*.csv' }),
      uidValidity: 3,
      lastId: 9,
      seen: ['x@1'],
      lookedAt: 5,
      files: { 'a.csv': '1:2' },
      filesIn: conv.settings.cwd,
      checkedAt: T0,
      seenAt: T0,
      writes: expect.any(String),
      nextCheckAt: T0 + WATCH_LIMITS.checkMinutes * MIN,
    });
    // What it saw of each file and event stays in the server: browsers get the rest.
    const shown = forClient(store.get(conv.id)!).schedule!.watches![0]!;
    expect(shown).not.toHaveProperty('files');
    expect(shown).not.toHaveProperty('seen');
    expect(shown).not.toHaveProperty('heldFiles');
    expect(shown).toMatchObject({ checkedAt: T0, lastId: 9 });
  });

  it('never starts again for what the team writes in the folder: while a run writes there, and at the first check after it, files are only recorded', async () => {
    reset();
    // The real file source, on the real clock (files are written now, and when the folder was free is compared with their times).
    now = Date.now();
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    const fileTrigger = { source: 'file' as const, pattern: '*.txt' };
    watching(conv, { repeat: { kind: 'event', triggers: [fileTrigger] } });
    const checker = (t: Parameters<typeof checkFiles>[0], prev: ScheduleWatch | undefined, ctx: WatchContext) =>
      checkFiles(t, prev, ctx.cwd, ctx.now, ctx.recordOnly, ctx.held);
    const s = () => new Scheduler(store, orchestrator, () => now, checker as never);
    const scheduledCount = () => scheduled(store.get(conv.id)!).length;
    await s().watchTick();
    expect(w(conv)!.files).toEqual({ 'shared.txt': expect.any(String) });

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
    // The run it started locks the folder: the count the check kept is behind already.
    expect(orchestrator.folderInUse(conv.id)).toBe(true);
    expect(orchestrator.folderWrites(conv.id)).not.toBe(w(conv)!.writes);
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toContain('Alice'));

    // While it writes: recorded, nothing sent.
    now = Date.now();
    await s().check(conv.id);
    expect(scheduledCount()).toBe(1);
    expect(Object.keys(w(conv)!.files!).sort()).toEqual(['Alice.txt', 'report.txt', 'shared.txt']);
    expect(w(conv)!.teamWrote).toBe(true);

    // The run ends having written late.txt: the first check with the folder free records it, and lets the flag go.
    finishWriting();
    await finish(conv.id);
    expect(orchestrator.folderInUse(conv.id)).toBe(false);
    now = Date.now();
    await s().check(conv.id);
    expect(scheduledCount()).toBe(1);
    expect(Object.keys(w(conv)!.files!)).toContain('late.txt');
    expect(w(conv)!.teamWrote).toBeUndefined();
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
    watching(files, { repeat: { kind: 'event', triggers: [{ source: 'file', pattern: '*.csv' }] } });
    expect(store.mailWatches()).toEqual([{ conversationId: conv.id, trigger }]);
    const s = scheduler();
    s.listening = (id) => id === conv.id;
    await s.check(conv.id);
    expect(w(conv)).toMatchObject({ listening: true, nextCheckAt: T0 + WATCH_LIMITS.idleCheckMinutes * MIN });
    s.listening = () => false;
    now += MIN;
    await s.check(conv.id);
    expect(w(conv)!.listening).toBeUndefined();
    expect(w(conv)!.nextCheckAt).toBe(now + WATCH_LIMITS.checkMinutes * MIN);
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
    expect(w(conv)).toMatchObject({ listening: true, nextCheckAt: T0 + WATCH_LIMITS.idleCheckMinutes * MIN });
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    now = T0 + WATCH_LIMITS.idleCheckMinutes * MIN;
    await s.check(conv.id);
    expect(w(conv)).toMatchObject({
      held: expect.any(String),
      nextCheckAt: now + WATCH_LIMITS.checkMinutes * MIN,
      listening: true,
    });
    // Not listening any more: the held state says so too.
    s.listening = () => false;
    now += WATCH_LIMITS.checkMinutes * MIN;
    await s.check(conv.id);
    expect(w(conv)!.listening).toBeUndefined();
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
    watching(conv, { repeat: { kind: 'event', triggers: [fileTrigger] } });
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
    expect(w(conv)!.held).toBe('waits for your answer');
    // The user answers: a run starts and writes in the folder; checks then only record, but keep the invoice unseen.
    const inUse = vi.spyOn(orchestrator, 'folderInUse').mockReturnValue(true);
    writeFileSync(join(project, 'draft.pdf'), 'the team wrote this');
    // Its time says nothing (a copy keeps an old one): it is the team's all the same.
    utimesSync(join(project, 'draft.pdf'), (now - 60_000) / 1000, (now - 60_000) / 1000);
    now = Date.now() + 1000;
    await s().check(conv.id);
    expect(w(conv)!.teamWrote).toBe(true);
    inUse.mockReturnValue(false);
    now = Date.now() + 2000;
    await s().check(conv.id);
    inUse.mockRestore();
    expect(w(conv)!.teamWrote).toBeUndefined();
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
    watching(conv, { repeat: { kind: 'event', triggers: [{ source: 'file', pattern: '*.pdf' }] } });
    const s = scheduler();
    await s.check(conv.id);
    const inUse = vi.spyOn(orchestrator, 'folderInUse').mockReturnValue(true);
    answer = async () => {
      throw new Error('disk gone');
    };
    now += WATCH_LIMITS.checkMinutes * MIN;
    await s.check(conv.id);
    expect(w(conv)).toMatchObject({ error: 'disk gone', teamWrote: true });
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

  describe('several things to wait for', () => {
    const alerts = { ...trigger, folder: 'Alerts' };
    /** Which folders (or patterns) were checked, in order. */
    const checked: string[] = [];
    /** A stand-in source for each trigger, by its key. */
    let sources: Record<string, (prev: ScheduleWatch | undefined) => Promise<WatchCheck>> = {};
    const several = () =>
      new Scheduler(
        store,
        orchestrator,
        () => now,
        (t, prev, ctx) => {
          checked.push(t.source === 'mail' ? t.folder : t.source === 'file' ? t.pattern : t.source);
          contexts.push(ctx);
          return sources[triggerKey(t)]!(prev);
        },
      );
    /** A folder's mail: the first check records `lastUid`, later ones find `uids` above what was seen. */
    const mail =
      (folder: string, lastUid: number, ...uids: number[]) =>
      async (prev: ScheduleWatch | undefined): Promise<WatchCheck> => {
        if (prev?.lastUid === undefined) return { state: { uidValidity: 1, lastUid }, total: 0 };
        const fresh = uids.filter((u) => u > prev.lastUid!);
        if (!fresh.length) return { state: prev, total: 0 };
        const listed = fresh.map((uid) => ({ uid, from: 'Bob <bob@example.com>', subject: `${folder} ${uid}`, date: 'd', excerpt: 'Hi' }));
        return {
          state: { uidValidity: 1, lastUid: Math.max(...uids) },
          total: fresh.length,
          event: mailEvent('Work', folder, listed, fresh.length),
        };
      };
    const failing = (why: string) => async (): Promise<WatchCheck> => {
      throw new Error(why);
    };
    const watchFor = (conv: Conversation, t: ScheduleTrigger) => conv.schedule!.watches?.find((x) => x.key === triggerKey(t));
    const resetSeveral = () => {
      reset();
      checked.length = 0;
      contexts.length = 0;
      sources = {};
    };

    it('checks each apart, with its own state, next check and slower checks after errors, and sends a message for each that finds something', async () => {
      resetSeveral();
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      watching(conv, { repeat: { kind: 'event', triggers: [trigger, alerts] } });
      sources = { [triggerKey(trigger)]: mail('INBOX', 5), [triggerKey(alerts)]: mail('Alerts', 20) };
      expect(store.watchDue(now)).toEqual([conv.id]);
      await several().watchTick();
      // Both recorded at their first check, nothing sent.
      expect(checked).toEqual(['INBOX', 'Alerts']);
      expect(conv.schedule!.watches).toEqual([
        expect.objectContaining({ key: triggerKey(trigger), lastUid: 5, nextCheckAt: T0 + WATCH_LIMITS.checkMinutes * MIN }),
        expect.objectContaining({ key: triggerKey(alerts), lastUid: 20, nextCheckAt: T0 + WATCH_LIMITS.checkMinutes * MIN }),
      ]);
      expect(scheduled(conv)).toEqual([]);

      // New mail in the inbox while the alerts' server is down: the inbox's message goes, the alerts back off.
      sources = { [triggerKey(trigger)]: mail('INBOX', 5, 6), [triggerKey(alerts)]: failing('alerts server down') };
      now = T0 + WATCH_LIMITS.checkMinutes * MIN;
      await several().watchTick();
      await finish(conv.id);
      expect(scheduled(conv)).toHaveLength(1);
      expect(JSON.parse(scheduled(conv)[0]!.event!)).toMatchObject({ folder: 'INBOX', mails: [{ uid: 6 }] });
      expect(watchFor(conv, trigger)).toMatchObject({ lastUid: 6, nextCheckAt: now + WATCH_LIMITS.checkMinutes * MIN });
      expect(watchFor(conv, trigger)!.error).toBeUndefined();
      expect(watchFor(conv, alerts)).toMatchObject({
        lastUid: 20,
        error: 'alerts server down',
        failures: 1,
        nextCheckAt: now + WATCH_LIMITS.backoffMinutes[0]! * MIN,
      });
      // The sidebar says a check failed, and what it waits for, both.
      expect(store.list(() => false).find((c) => c.id === conv.id)!.schedule).toMatchObject({
        triggers: [trigger, alerts],
        watchError: true,
      });

      // Only the inbox's next check has come: the alerts wait for theirs.
      checked.length = 0;
      now += WATCH_LIMITS.checkMinutes * MIN;
      await several().watchTick();
      expect(checked).toEqual(['INBOX']);
      // Due again when the first of them is: the inbox, 2 minutes on.
      expect(store.watchDue(now)).toEqual([]);
      expect(store.watchDue(now + WATCH_LIMITS.checkMinutes * MIN)).toEqual([conv.id]);

      // Both find something in the same check: two messages, each with what its own trigger found (the second queued).
      let release!: () => void;
      fake.gates.Alice = new Promise((r) => (release = r));
      sources = { [triggerKey(trigger)]: mail('INBOX', 5, 6, 7), [triggerKey(alerts)]: mail('Alerts', 20, 21) };
      checked.length = 0;
      now = T0 + 10 * MIN;
      await several().watchTick();
      expect(checked).toEqual(['INBOX', 'Alerts']);
      expect(conv.queue).toEqual([expect.objectContaining({ scheduled: true, eventSource: 'mail' })]);
      expect(conv.schedule!.lastResult).toBe('queued');
      release();
      await finish(conv.id);
      const sent = scheduled(conv);
      expect(sent).toHaveLength(3);
      expect(sent.slice(1).map((m) => JSON.parse(m.event!).folder)).toEqual(['INBOX', 'Alerts']);
      expect(watchFor(conv, alerts)).toMatchObject({ lastUid: 21 });
      expect(watchFor(conv, alerts)!.error).toBeUndefined();

      // A restart reads each back: nothing is sent again.
      setStore(new Store(db));
      setOrchestrator(new Orchestrator(store, new Hub(), settings));
      const again = store.get(conv.id)!;
      expect(again.schedule!.watches!.map((x) => x.lastUid)).toEqual([7, 21]);
      now += 10 * MIN;
      await several().watchTick();
      await finish(conv.id);
      expect(scheduled(again)).toHaveLength(3);
    });

    it('checks only the trigger the mail server spoke of (IMAP IDLE), lists each mail trigger for IDLE, and keeps each listening apart', async () => {
      resetSeveral();
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      const csv = { source: 'file' as const, pattern: '*.csv' };
      watching(conv, { repeat: { kind: 'event', triggers: [trigger, csv, alerts] } });
      sources = {
        [triggerKey(trigger)]: mail('INBOX', 5),
        [triggerKey(alerts)]: mail('Alerts', 20),
        [triggerKey(csv)]: async () => ({ state: { files: {} }, total: 0 }),
      };
      expect(store.mailWatches()).toEqual([
        { conversationId: conv.id, trigger },
        { conversationId: conv.id, trigger: alerts },
      ]);
      const s = several();
      // The inbox's server listens; the Alerts folder's does not.
      s.listening = (_id, t) => t.source === 'mail' && t.folder === 'INBOX';
      await s.check(conv.id);
      expect(checked).toEqual(['INBOX', '*.csv', 'Alerts']);
      expect(watchFor(conv, trigger)).toMatchObject({ listening: true, nextCheckAt: T0 + WATCH_LIMITS.idleCheckMinutes * MIN });
      expect(watchFor(conv, alerts)!.listening).toBeUndefined();
      expect(watchFor(conv, alerts)!.nextCheckAt).toBe(T0 + WATCH_LIMITS.checkMinutes * MIN);

      // Mail arrived in Alerts: only that trigger is checked, also during a check under way (once more after it).
      checked.length = 0;
      now += MIN;
      await s.check(conv.id, false, true, [triggerKey(alerts)]);
      expect(checked).toEqual(['Alerts']);
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      sources[triggerKey(trigger)] = async (prev) => (await gate, { state: prev!, total: 0 });
      checked.length = 0;
      const first = s.check(conv.id, false, true, [triggerKey(trigger)]);
      const asks = [s.check(conv.id, false, true, [triggerKey(alerts)]), s.check(conv.id, false, true, [triggerKey(trigger)])];
      open();
      await Promise.all([first, ...asks]);
      // The one under way, then one more for both folders asked for meanwhile, in the triggers' order.
      expect(checked).toEqual(['INBOX', 'INBOX', 'Alerts']);
      // Check now checks every one, also after a check of one under way.
      checked.length = 0;
      const one = s.check(conv.id, false, true, [triggerKey(alerts)]);
      const all = s.check(conv.id, true);
      await Promise.all([one, all]);
      expect(checked).toEqual(['Alerts', 'INBOX', '*.csv', 'Alerts']);
    });

    it('drops what it kept of a trigger removed meanwhile, starts one added afresh, and never writes a removed one back', async () => {
      resetSeveral();
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      watching(conv, { repeat: { kind: 'event', triggers: [trigger, alerts] } });
      sources = { [triggerKey(trigger)]: mail('INBOX', 5), [triggerKey(alerts)]: mail('Alerts', 20) };
      await several().watchTick();
      expect(conv.schedule!.watches).toHaveLength(2);
      // Alerts removed while the inbox is checked: its state is not written back.
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      sources[triggerKey(trigger)] = async (prev) => (await gate, { state: { ...prev!, lastUid: 9 }, total: 0 });
      checked.length = 0;
      now += WATCH_LIMITS.checkMinutes * MIN;
      const checking = several().watchTick();
      await vi.waitFor(() => expect(checked).toEqual(['INBOX']));
      const kept = watchFor(conv, trigger)!;
      conv.schedule = { ...conv.schedule!, repeat: { kind: 'event', triggers: [trigger] }, watches: [kept] };
      store.saveSchedule(conv);
      open();
      await checking;
      // Saved meanwhile: the inbox's result belongs to the automation as it was, and Alerts is not checked.
      expect(checked).toEqual(['INBOX']);
      expect(conv.schedule.watches).toEqual([kept]);
      // A trigger added: checked at once, from its first check, beside the one kept (the inbox, whose
      // result was dropped, is still due too).
      const csv = { source: 'file' as const, pattern: '*.csv' };
      sources[triggerKey(csv)] = async () => ({ state: { files: { 'a.csv': '1:2' } }, total: 0 });
      sources[triggerKey(trigger)] = mail('INBOX', 5);
      conv.schedule = { ...conv.schedule, repeat: { kind: 'event', triggers: [trigger, csv] } };
      store.saveSchedule(conv);
      checked.length = 0;
      given.length = 0;
      await several().watchTick();
      expect(checked).toEqual(['INBOX', '*.csv']);
      expect(conv.schedule.watches!.map((x) => x.key)).toEqual([triggerKey(trigger), triggerKey(csv)]);
      expect(watchFor(conv, trigger)!.lastUid).toBe(5);
      // What a row keeps of a trigger it no longer waits for is not read back either.
      conv.schedule = { ...conv.schedule, repeat: { kind: 'event', triggers: [csv] } };
      store.saveSchedule(conv);
      expect(new Store(db).get(conv.id)!.schedule!.watches!.map((x) => x.key)).toEqual([triggerKey(csv)]);
    });

    it("still sends a second file trigger's file in the same check after the first one's message started a run that writes there", async () => {
      resetSeveral();
      const conv = conversation({ mode: 'roundtable', permission: 'edit' });
      const csv = { source: 'file' as const, pattern: '*.csv' };
      const pdf = { source: 'file' as const, pattern: '*.pdf' };
      watching(conv, { repeat: { kind: 'event', triggers: [csv, pdf] } });
      const found =
        (path: string) =>
        async (prev: ScheduleWatch | undefined): Promise<WatchCheck> =>
          prev
            ? {
                state: { files: { [path]: '1:2' } },
                total: 1,
                found: { [path]: '1:2' },
                event: JSON.stringify({ source: 'file', files: [{ path }] }),
              }
            : { state: { files: {} }, total: 0 };
      sources = { [triggerKey(csv)]: found('a.csv'), [triggerKey(pdf)]: found('b.pdf') };
      await several().watchTick();
      // The first message's run holds the folder from then on.
      let running = false;
      const send = orchestrator.sendScheduled.bind(orchestrator);
      const spy = vi.spyOn(orchestrator, 'sendScheduled').mockImplementation(async (...a) => {
        const sent = await send(...a);
        running = true;
        return sent;
      });
      const inUse = vi.spyOn(orchestrator, 'folderInUse').mockImplementation(() => running);
      let release!: () => void;
      fake.gates.Alice = new Promise((r) => (release = r));
      contexts.length = 0;
      now += WATCH_LIMITS.checkMinutes * MIN;
      await several().watchTick();
      // The pdf was there before that run: listed, not taken for the team's.
      expect(contexts.map((c) => (c as WatchContext).recordOnly)).toEqual([false, false]);
      // Both kept the folder's write count from before that run: the next check of each sees it change.
      expect(watchFor(conv, pdf)!.writes).toBe(watchFor(conv, csv)!.writes);
      expect(orchestrator.folderWrites(conv.id)).not.toBe(watchFor(conv, csv)!.writes);
      release();
      await finish(conv.id);
      running = false;
      spy.mockRestore();
      inUse.mockRestore();
      expect(scheduled(conv).map((m) => JSON.parse(m.event!).files[0].path)).toEqual(['a.csv', 'b.pdf']);
    });
  });

  it("counts a run that began and ended between two checks as the team's, and a read-only run's allowed action as writing", async () => {
    reset();
    now = Date.now();
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    watching(conv, { repeat: { kind: 'event', triggers: [{ source: 'file', pattern: '*.md' }] } });
    const checker = (t: Parameters<typeof checkFiles>[0], prev: ScheduleWatch | undefined, ctx: WatchContext) =>
      checkFiles(t, prev, ctx.cwd, ctx.now, ctx.recordOnly, ctx.held);
    const s = () => new Scheduler(store, orchestrator, () => now, checker as never);
    await s().check(conv.id);
    // A run the user starts writes notes.md, and ends, between two checks.
    fake.inTurn = async (name, o) => {
      if (name === 'Alice') writeFileSync(join(o.cwd, 'notes.md'), 'by the team');
    };
    await orchestrator.send(conv.id, 'write notes');
    await finish(conv.id);
    fake.inTurn = undefined;
    utimesSync(join(project, 'notes.md'), (now - 120_000) / 1000, (now - 120_000) / 1000);
    now = Date.now() + 60_000;
    await s().check(conv.id);
    expect(scheduled(conv)).toHaveLength(0);
    expect(Object.keys(w(conv)!.files!)).toContain('notes.md');
    now += 120_000;
    await s().check(conv.id);
    expect(scheduled(conv)).toHaveLength(0);

    // Read-only, its own run writes only once an action is allowed, which locks the folder: counted.
    const ro = conversation({ mode: 'roundtable', permission: 'read-only' });
    ro.agents = [ro.agents[0]!];
    const before = orchestrator.folderWrites(ro.id);
    await orchestrator.send(ro.id, 'please install');
    const pending = () =>
      ro.messages.flatMap((m) => m.parts).find((p) => p.type === 'approval' && p.status === 'pending') as { id: string } | undefined;
    await vi.waitFor(() => expect(pending()).toBeDefined());
    expect(orchestrator.folderWrites(ro.id)).toBe(before);
    orchestrator.answerApproval(ro.id, pending()!.id, { allow: true });
    await finish(ro.id);
    expect(orchestrator.folderWrites(ro.id)).not.toBe(before);
  });

  it('holds a file that arrives while another waits for the team with it, and counts only the watched folder and writes since another start', async () => {
    reset();
    now = Date.now();
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    watching(conv, { repeat: { kind: 'event', triggers: [{ source: 'file', pattern: '*.pdf' }] } });
    const checker = (t: Parameters<typeof checkFiles>[0], prev: ScheduleWatch | undefined, ctx: WatchContext) =>
      checkFiles(t, prev, ctx.cwd, ctx.now, ctx.recordOnly, ctx.held);
    const s = () => new Scheduler(store, orchestrator, () => now, checker as never);
    await s().check(conv.id);
    const old = (now - 120_000) / 1000;
    writeFileSync(join(project, 'a.pdf'), 'first');
    utimesSync(join(project, 'a.pdf'), old, old);
    const skip = vi.spyOn(orchestrator, 'sendScheduled').mockResolvedValue({ result: 'skipped', reason: 'waits for your answer' });
    const hold = vi.spyOn(orchestrator, 'scheduledHold').mockReturnValue('waits for your answer');
    now = Date.now();
    await s().check(conv.id);
    // Hours later, while a.pdf still waits: b.pdf arrives, and is held with it.
    writeFileSync(join(project, 'b.pdf'), 'second');
    utimesSync(join(project, 'b.pdf'), old, old);
    now = Date.now() + 60_000;
    await s().check(conv.id);
    expect(Object.keys(w(conv)!.heldFiles!).sort()).toEqual(['a.pdf', 'b.pdf']);
    skip.mockRestore();
    hold.mockRestore();
    // The user answers, and a run writes in the folder: both kept unseen, then sent.
    const inUse = vi.spyOn(orchestrator, 'folderInUse').mockReturnValue(true);
    now = Date.now() + 120_000;
    await s().check(conv.id);
    // Only recorded, but why the files wait is still said: no longer the answer it waited for, but the team's writing.
    expect(w(conv)!.held).toBe('the team writes in the folder, or just did; sent at the check after it is done');
    expect(Object.keys(w(conv)!.heldFiles!).sort()).toEqual(['a.pdf', 'b.pdf']);
    inUse.mockRestore();
    now = Date.now() + 180_000;
    await s().check(conv.id);
    now = Date.now() + 240_000;
    await s().check(conv.id);
    await finish(conv.id);
    const sent = scheduled(conv);
    expect(sent).toHaveLength(1);
    expect(
      JSON.parse(sent[0]!.event!)
        .files.map((f: { path: string }) => f.path)
        .sort(),
    ).toEqual(['a.pdf', 'b.pdf']);
  });

  it('counts writes kept by another start of the server, and only those in the folder the source watches', async () => {
    reset();
    now = Date.now();
    const other = mkdtempSync(join(tmpdir(), 'relay-other-'));
    const conv = conversation({ mode: 'roundtable', permission: 'edit', extraCwds: [other] });
    watching(conv, { repeat: { kind: 'event', triggers: [{ source: 'file', pattern: '*.md' }] } });
    const checker = (t: Parameters<typeof checkFiles>[0], prev: ScheduleWatch | undefined, ctx: WatchContext) =>
      checkFiles(t, prev, ctx.cwd, ctx.now, ctx.recordOnly, ctx.held);
    const s = () => new Scheduler(store, orchestrator, () => now, checker as never);
    const old = (now - 120_000) / 1000;
    const settled = (name: string) => {
      writeFileSync(join(project, name), name);
      utimesSync(join(project, name), old, old);
    };

    // Another chat writing only in one of the conversation's other working directories: not the watched one.
    const before = orchestrator.folderWrites(conv.id);
    const elsewhere = conversation({ mode: 'roundtable', permission: 'edit', cwd: other });
    await orchestrator.send(elsewhere.id, 'write there');
    await finish(elsewhere.id);
    expect(orchestrator.folderWrites(conv.id)).toBe(before);

    // Nothing counted since this start: what was kept by another start is no reason to only record.
    expect(before.endsWith(':0')).toBe(true);
    await s().check(conv.id);
    w(conv)!.writes = 'another-start:4';
    settled('yours.md');
    now += 120_000;
    await s().check(conv.id);
    await finish(conv.id);
    expect(scheduled(conv)).toHaveLength(1);

    // A run since this start, against a count kept by another one: only recorded.
    expect(orchestrator.folderWrites(conv.id).endsWith(':0')).toBe(false);
    w(conv)!.writes = 'another-start:4';
    settled('team.md');
    now += 120_000;
    await s().check(conv.id);
    expect(scheduled(conv)).toHaveLength(1);
    expect(Object.keys(w(conv)!.files!)).toContain('team.md');
  });

  it("takes what a run that begins during a check writes, still settling, for the team's, but keeps what already waited", async () => {
    reset();
    now = Date.now();
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    watching(conv, { repeat: { kind: 'event', triggers: [{ source: 'file', pattern: '*.txt' }] } });
    /** Each look: a run that begins and ends during it writes `fresh` (the folder's write count goes up), then it looks. */
    let fresh: string[] = [];
    let count = 0;
    const checker = (t: Parameters<typeof checkFiles>[0], prev: ScheduleWatch | undefined, ctx: WatchContext) => {
      for (const name of fresh) writeFileSync(join(project, name), name);
      if (fresh.length) count++;
      return checkFiles(t, prev, ctx.cwd, ctx.now, ctx.recordOnly, ctx.held);
    };
    const s = () => new Scheduler(store, orchestrator, () => now, checker as never);
    const writes = vi.spyOn(orchestrator, 'folderWrites').mockImplementation(() => `run:${count}`);
    await s().check(conv.id);
    // The user's upload is still being written at a free check: kept pending.
    writeFileSync(join(project, 'upload.txt'), 'part');
    await s().check(conv.id);
    expect(Object.keys(w(conv)!.heldFiles!)).toEqual(['upload.txt']);
    // At the next one a run begins during the look and writes team.txt: only the upload stays kept.
    fresh = ['team.txt'];
    await s().check(conv.id);
    fresh = [];
    expect(w(conv)!.teamWrote).toBe(true);
    expect(Object.keys(w(conv)!.heldFiles!)).toEqual(['upload.txt']);
    // Once all is settled and free: the upload is sent, team.txt never.
    for (let i = 0; i < 3; i++) {
      now += 120_000;
      await s().check(conv.id);
    }
    await finish(conv.id);
    writes.mockRestore();
    const sent = scheduled(conv);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.event!).files.map((f: { path: string }) => f.path)).toEqual(['upload.txt']);
  });
});
