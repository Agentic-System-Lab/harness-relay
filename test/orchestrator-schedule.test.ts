/*
 * Schedules: sending each one's message when it comes due (queued, held back, missed times, busy
 * retries), approvals in the runs they start, a team the lead agent designs for one, and a new chat
 * each time.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationSchedule, ConversationSettings } from '../src/shared/types';
import { agentMessages, agents, BUSY_RETRY_MS, calls, conversation, db, fake, finish, Hub, MISSED_AFTER_MS, orchestrator, Orchestrator, project, Scheduler, scheduleTime, setOrchestrator, setStore, settings, store, Store, textOf } from './orchestrator-harness';

describe('schedules', () => {
  const HOUR = 3_600_000;
  /** Monday 5 January 2026, 08:00 UTC. */
  const T0 = Date.UTC(2026, 0, 5, 8, 0);
  let now = T0;
  const scheduler = () => new Scheduler(store, orchestrator, () => now);
  /** Give the conversation a schedule (English notes, every hour from T0, due at T0 + 1 h). */
  const schedule = (conv: Conversation, s: Partial<ConversationSchedule> = {}) => {
    conv.schedule = {
      text: 'scheduled check',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: T0,
      nextRunAt: T0 + HOUR,
      ...s,
    };
    store.saveSchedule(conv);
  };
  const said = (conv: Conversation) =>
    conv.messages.map((m) => (m.author.kind === 'user' ? textOf(m) : m.author.kind === 'agent' ? `@${m.agentName}` : 'note'));
  const notes = (conv: Conversation) => conv.messages.filter((m) => m.author.kind === 'system').map(textOf);
  const solo = (settings: Partial<ConversationSettings> = {}) => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', ...settings });
    conv.agents = [agents[0]!];
    store.saveMeta(conv);
    return conv;
  };
  const hold = (name: string) => {
    let release!: () => void;
    fake.gates[name] = new Promise((r) => (release = r));
    return () => release();
  };

  it('sends the message when it comes due, marked as scheduled, then waits for the next time', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    now = T0 + HOUR - 1;
    await scheduler().tick();
    expect(conv.messages).toEqual([]); // not yet

    now = T0 + HOUR + 5000;
    await scheduler().tick();
    await finish(conv.id);
    expect(said(conv)).toEqual(['scheduled check', '@Alice', '@Bob']);
    expect(conv.messages[0]!.scheduled).toBe(true);
    expect(calls[0]!.prompt).toContain('<message from="user" via="schedule">');
    expect(conv.schedule).toMatchObject({ lastRunAt: T0 + HOUR, lastResult: 'sent', nextRunAt: T0 + 2 * HOUR, enabled: true });

    // Once is enough: the same look again sends nothing.
    await scheduler().tick();
    await finish(conv.id);
    expect(calls).toHaveLength(2);

    const reloaded = new Store(db).get(conv.id)!;
    expect(reloaded.schedule).toEqual(conv.schedule);
    expect(reloaded.messages[0]!.scheduled).toBe(true);
    expect(store.list(() => false).find((c) => c.id === conv.id)!.schedule).toEqual({
      enabled: true,
      nextRunAt: T0 + 2 * HOUR,
      lastResult: 'sent',
    });
  });

  const approvalParts = (conv: Conversation) =>
    conv.messages.flatMap((m) => m.parts).filter((p) => p.type === 'approval') as Extract<
      Conversation['messages'][number]['parts'][number],
      { type: 'approval' }
    >[];

  it('refuses approvals in the runs it starts, except what the chat always allows, unless the schedule says to ask', async () => {
    const conv = solo();
    schedule(conv, { text: 'please install' });
    now = T0 + HOUR;
    await scheduler().tick();
    await finish(conv.id);
    // The agent is told in English; the card shows it in the schedule's language.
    expect(textOf(agentMessages(conv).at(-1)!)).toMatch(/^Alice skipped \(This run was started by a schedule and nobody may be watching/);
    expect(approvalParts(conv)[0]).toMatchObject({ status: 'denied', note: 'Refused automatically: nobody may be watching a scheduled run' });

    // What the user always allows in this chat goes through.
    conv.allowRules = [{ kind: 'command', key: 'npm install' }];
    store.saveMeta(conv);
    schedule(conv, { text: 'please install', nextRunAt: T0 + 2 * HOUR });
    now = T0 + 2 * HOUR;
    await scheduler().tick();
    await finish(conv.id);
    expect(textOf(agentMessages(conv).at(-1)!)).toBe('Alice installed');
    expect(approvalParts(conv)[1]).toMatchObject({ status: 'allowed', auto: true });
    conv.allowRules = undefined;
    store.saveMeta(conv);

    schedule(conv, { text: 'please install', approvals: 'ask', nextRunAt: T0 + 3 * HOUR });
    now = T0 + 3 * HOUR;
    await scheduler().tick();
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    const pending = conv.messages.flatMap((m) => m.parts).find((p) => p.type === 'approval' && p.status === 'pending')!;
    orchestrator.answerApproval(conv.id, (pending as { id: string }).id, { allow: true });
    await finish(conv.id);
    expect(textOf(agentMessages(conv).at(-1)!)).toBe('Alice installed');

    // A run the user starts asks as usual.
    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    orchestrator.stop(conv.id);
    await finish(conv.id);
  });

  it('waits in the queue while the team replies, and holds a second one back until the first is delivered', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));

    now = T0 + HOUR;
    await scheduler().tick();
    expect(conv.schedule).toMatchObject({ lastResult: 'queued', nextRunAt: T0 + 2 * HOUR });
    expect(conv.queue).toEqual([expect.objectContaining({ scheduled: true, queued: true })]);

    now = T0 + 2 * HOUR;
    await scheduler().tick();
    expect(conv.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the previous scheduled message is still waiting to be delivered' });
    expect(conv.queue).toHaveLength(1);

    alice();
    await finish(conv.id);
    expect(said(conv)).toEqual([
      'question',
      '@Alice',
      'note', // the time it held back
      'scheduled check',
      '@Bob',
    ]);
    expect(notes(conv)[0]).toMatch(/^The scheduled message of .* was not sent: the previous scheduled message is still waiting/);
  });

  it('is held back when the queue is full', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    for (let i = 0; i < 20; i++) await orchestrator.send(conv.id, `@Alice note ${i}`);
    now = T0 + HOUR;
    await scheduler().tick();
    expect(conv.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the queue of waiting messages is full' });
    expect(conv.queue!.some((m) => m.scheduled)).toBe(false);
    orchestrator.stop(conv.id);
    alice();
    await finish(conv.id);
  });

  it('starts a run of its own, still refusing approvals, for a message no turn of the run took', async () => {
    const conv = solo();
    conv.agents = agents;
    store.saveMeta(conv);
    schedule(conv, { text: '@Bob please install' });
    const alice = hold('Alice');
    await orchestrator.send(conv.id, '@Alice question'); // only Alice answers this run
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + HOUR;
    await scheduler().tick();
    alice();
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(said(conv)).toEqual(['@Alice question', '@Alice', '@Bob please install', '@Bob']);
    expect(textOf(agentMessages(conv).at(-1)!)).toMatch(/^Bob skipped \(/);
  });

  it('holds the message back while the team waits for an answer, or has no confirmed team', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    fake.asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'which one?');
    await finish(conv.id);
    expect(conv.pause).toBeDefined();

    now = T0 + HOUR;
    await scheduler().tick();
    expect(said(conv)).toEqual(['which one?', '@Alice', 'note']); // not taken for the answer
    expect(conv.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the team is waiting for your answer' });
    expect(conv.pause).toBeDefined();

    const auto = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true });
    auto.agents = [];
    store.saveMeta(auto);
    schedule(auto);
    await scheduler().tick();
    expect(said(auto)).toEqual(['note']);
    expect(auto.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the team is not confirmed yet' });

    // With a team, auto team or not, the current team takes it: no design nobody could confirm.
    const withTeam = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true });
    schedule(withTeam, { nextRunAt: now });
    calls.length = 0;
    fake.asking = new Set();
    await scheduler().tick();
    await finish(withTeam.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(withTeam.messages.some((m) => m.plan)).toBe(false);
  });

  it('skips a time missed while it was not running, or sends it once late, as the schedule says', async () => {
    const skips = conversation({ mode: 'roundtable', permission: 'read-only' });
    const nine = Date.UTC(2026, 0, 5, 9, 0);
    schedule(skips, { repeat: { kind: 'daily', time: '09:00' }, nextRunAt: nine });
    const sends = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(sends, { repeat: { kind: 'once', at: nine }, nextRunAt: nine, missed: 'run' });

    // Three days later (the server was off), past the grace period.
    now = nine + 3 * 24 * HOUR + 2 * HOUR;
    expect(now - nine).toBeGreaterThan(MISSED_AFTER_MS);
    await scheduler().tick();
    await finish(sends.id);

    expect(said(skips)).toEqual(['note']);
    expect(notes(skips)[0]).toMatch(/was not sent: Harness Relay was not running then/);
    expect(skips.schedule).toMatchObject({ lastResult: 'missed', lastRunAt: nine, nextRunAt: nine + 4 * 24 * HOUR, enabled: true });

    expect(said(sends)).toEqual(['scheduled check', '@Alice', '@Bob']);
    // A one-time schedule is done: it stays, switched off.
    expect(sends.schedule).toMatchObject({ lastResult: 'sent', enabled: false });
    expect(sends.schedule!.nextRunAt).toBeUndefined();
    expect(store.dueSchedules(now + 365 * 24 * HOUR)).toEqual([skips.id]); // the daily one only
  });

  it('sends a time only a little late as usual, and says why one could not start', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'edit', cwd: join(project, 'gone') });
    schedule(conv);
    now = T0 + HOUR + MISSED_AFTER_MS - 1000;
    await scheduler().tick();
    expect(conv.schedule).toMatchObject({ lastResult: 'failed', nextRunAt: T0 + 2 * HOUR });
    expect(conv.schedule!.lastError).toBeTruthy();
    expect(notes(conv).at(-1)).toMatch(/could not be sent/);
  });

  const pendingPart = (conv: Conversation) =>
    conv.messages.flatMap((m) => m.parts).find((p) => p.type === 'approval' && p.status === 'pending') as { id: string } | undefined;
  const told = (name: string) => calls.filter((c) => c.name === name).map((c) => c.prompt.includes('You asked the user a question'));

  /** An agent asks while the scheduled message waits in the queue behind its turn. */
  async function questionWithScheduledWaiting(text: string) {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv, { text });
    fake.asking = new Set(['Alice']);
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'which one?');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + HOUR;
    await scheduler().tick();
    expect(conv.schedule!.lastResult).toBe('queued');
    alice();
    await finish(conv.id);
    expect(conv.pause).toBeDefined();
    expect(conv.queue).toEqual([expect.objectContaining({ scheduled: true })]); // waits for the answer too
    return conv;
  }

  it("is no answer to an agent's question, and its @mentions do not make the team start afresh", async () => {
    const conv = await questionWithScheduledWaiting('@Bob daily report');
    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    // The answer goes first; the scheduled message waits for Bob's turn.
    expect(said(conv)).toEqual(['which one?', '@Alice', 'ANSWER: A', '@Alice', '@Bob daily report', '@Bob']);
    expect(told('Alice')).toEqual([false, true]); // told that the user replied
  });

  it("lets Continue skip the agent that asked, though a scheduled message goes out with it", async () => {
    const conv = await questionWithScheduledWaiting('daily report');
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(said(conv)).toEqual(['which one?', '@Alice', 'daily report', '@Bob']);
    expect(told('Alice')).toEqual([false]);
  });

  it('sends an earlier scheduled message left waiting after Stop at the next time, once', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + HOUR;
    await scheduler().tick();
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(conv.queue).toHaveLength(1); // kept after Stop

    fake.gates = {};
    now = T0 + 2 * HOUR;
    await scheduler().tick();
    await finish(conv.id);
    expect(conv.queue).toEqual([]);
    expect(conv.messages.filter((m) => m.scheduled)).toHaveLength(1);
    expect(said(conv).slice(-3)).toEqual(['scheduled check', '@Alice', '@Bob']);
    expect(conv.schedule).toMatchObject({ lastResult: 'sent', nextRunAt: T0 + 3 * HOUR });
    expect(notes(conv).some((n) => n.includes('still waiting'))).toBe(false);
  });

  it('waits while another conversation writes in the same folder, and gives up after a while', async () => {
    const writer = conversation({ mode: 'roundtable', permission: 'edit' });
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    schedule(conv);
    hold('Alice');
    await orchestrator.send(writer.id, 'go'); // holds the folder
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));

    now = T0 + HOUR;
    await scheduler().tick();
    const s = scheduler();
    await s.tick();
    expect(conv.messages).toEqual([]); // nothing sent, nothing recorded yet: tried again later
    expect(conv.schedule).toMatchObject({ nextRunAt: T0 + HOUR });
    expect(conv.schedule!.lastResult).toBeUndefined();

    now = T0 + HOUR + MISSED_AFTER_MS + 1000;
    await s.tick(); // still busy, and late: tried again, not counted as missed
    expect(conv.schedule!.lastResult).toBeUndefined();

    now = T0 + HOUR + BUSY_RETRY_MS + 1000;
    await s.tick(); // given up
    expect(conv.schedule).toMatchObject({ lastResult: 'skipped', nextRunAt: T0 + 2 * HOUR });
    expect(conv.schedule!.lastError).toMatch(/is changing/);
    expect(notes(conv)).toHaveLength(1);
    expect(notes(conv)[0]).not.toMatch(/\.\.$/); // one full stop
    orchestrator.stop(writer.id);
    await finish(writer.id);
  });

  it('stays queued after an answer to a question the team was not asked as a whole, until the agent it is for speaks', async () => {
    for (const mode of ['roundtable', 'relay'] as const) {
      calls.length = 0;
      const conv = conversation({ mode, permission: 'read-only' });
      schedule(conv, { text: '@Bob daily report', nextRunAt: now + HOUR });
      fake.asking = new Set(['Alice']);
      const alice = hold('Alice');
      await orchestrator.send(conv.id, '@Alice which one?');
      await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
      const due = conv.schedule!.nextRunAt!;
      const was = now;
      now = due;
      await scheduler().tick();
      alice();
      await finish(conv.id);
      expect(conv.pause).toBeDefined();

      await orchestrator.send(conv.id, 'ANSWER: A');
      // The answer run ends with Alice; the scheduled message then gets a run of its own, for Bob.
      await vi.waitFor(() => expect(said(conv).at(-1)).toBe('@Bob'), { timeout: 20_000 });
      await finish(conv.id);
      expect(said(conv)).toEqual(['@Alice which one?', '@Alice', 'ANSWER: A', '@Alice', '@Bob daily report', '@Bob']);
      expect(conv.queue ?? []).toEqual([]);
      now = was;
      fake.gates = {};
    }
  });

  /** An agent asks; meanwhile the schedule's message and then one the user wrote wait in the queue: [S, U]. */
  async function questionWithBothWaiting(question: string, text: string) {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv, { text });
    fake.asking = new Set(['Alice']);
    const alice = hold('Alice');
    await orchestrator.send(conv.id, question);
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + HOUR;
    await scheduler().tick();
    expect(await orchestrator.send(conv.id, 'user note U')).toEqual({ queued: true });
    alice();
    await finish(conv.id);
    expect(conv.pause).toBeDefined();
    expect(conv.queue!.map((m) => (m.scheduled ? 'S' : 'U'))).toEqual(['S', 'U']);
    return conv;
  }

  it("sends the user's own message waiting behind a scheduled one with their answer, in the order written", async () => {
    const conv = await questionWithBothWaiting('which one?', 'daily report');
    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(said(conv)).toEqual(['which one?', '@Alice', 'user note U', 'ANSWER: A', 'daily report', '@Alice', '@Bob']);
    expect(told('Alice')).toEqual([false, true]);
    const answering = calls.filter((c) => c.name === 'Alice')[1]!.prompt;
    expect(answering.indexOf('user note U')).toBeLessThan(answering.indexOf('ANSWER: A'));
    expect(answering).toContain('one marked via="schedule" is not their reply');
  });

  it("counts the user's own waiting message as their reply on Continue, whatever waits ahead of it", async () => {
    const conv = await questionWithBothWaiting('which one?', 'daily report');
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(said(conv).slice(0, 5)).toEqual(['which one?', '@Alice', 'user note U', 'daily report', '@Alice']);
    expect(told('Alice')).toEqual([false, true]); // as without a schedule: the message the user wrote is the reply
  });

  it("gives the agent that asked the user's own waiting message, while a scheduled one for another agent waits for it", async () => {
    const conv = await questionWithBothWaiting('@Alice which one?', '@Bob daily report');
    await orchestrator.send(conv.id, 'ANSWER: A');
    await vi.waitFor(() => expect(said(conv).at(-1)).toBe('@Bob'), { timeout: 20_000 });
    await finish(conv.id);
    expect(said(conv)).toEqual(['@Alice which one?', '@Alice', 'user note U', 'ANSWER: A', '@Alice', '@Bob daily report', '@Bob']);
    expect(calls.filter((c) => c.name === 'Alice')[1]!.prompt).toContain('user note U');
  });

  it('holds a new time back while a question waits and the earlier scheduled message waits with it', async () => {
    const conv = await questionWithScheduledWaiting('daily report');
    now = T0 + 2 * HOUR;
    await scheduler().tick();
    expect(conv.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the team is waiting for your answer' });
    expect(orchestrator.isRunning(conv.id)).toBe(false);
    expect(conv.queue).toHaveLength(1);
  });

  it('retries a time that is already late when the conversation is busy, and sends it once free', async () => {
    const writer = conversation({ mode: 'roundtable', permission: 'edit' });
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    schedule(conv, { missed: 'run' });
    const alice = hold('Alice');
    await orchestrator.send(writer.id, 'go');
    await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));
    now = T0 + HOUR + 3 * MISSED_AFTER_MS; // the server was off; the folder is taken
    const s = scheduler();
    await s.tick();
    expect(conv.schedule!.lastResult).toBeUndefined();
    // Something the user sends meanwhile is not left in a queue nobody runs.
    await expect(orchestrator.send(conv.id, 'hello')).rejects.toThrow(/正在修改|is changing/);
    expect(conv.queue ?? []).toEqual([]);

    alice();
    await finish(writer.id);
    now += 60_000;
    await s.tick();
    await finish(conv.id);
    expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: T0 + HOUR });
  });

  it('refuses without asking in a conversation that refuses automatically', async () => {
    const conv = solo({ approvals: 'deny' });
    schedule(conv, { text: 'please install', approvals: 'ask' });
    now = T0 + HOUR;
    await scheduler().tick();
    await finish(conv.id);
    expect(textOf(agentMessages(conv).at(-1)!)).toBe('Alice not asked');
    expect(approvalParts(conv)).toEqual([]);
  });

  it('asks for approvals again once the user writes into a scheduled run in parallel mode', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', rounds: 2 });
    schedule(conv);
    const alice = hold('Alice');
    const bob = hold('Bob');
    now = T0 + HOUR;
    await scheduler().tick();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(await orchestrator.send(conv.id, 'please install')).toEqual({ queued: true });
    alice();
    bob();
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true)); // round 2 asks
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(approvalParts(conv).every((p) => p.status !== 'denied')).toBe(true);
  });

  it('asks for approvals again once the user writes into a scheduled run', async () => {
    const conv = solo({ rounds: 2 });
    schedule(conv);
    const alice = hold('Alice');
    now = T0 + HOUR;
    await scheduler().tick();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await orchestrator.send(conv.id, 'please install')).toEqual({ queued: true });
    alice();
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true)); // asked, not refused
    orchestrator.answerApproval(conv.id, pendingPart(conv)!.id, { allow: true });
    await finish(conv.id);
    expect(textOf(agentMessages(conv).at(-1)!)).toBe('Alice installed');
  });

  it("asks when a scheduled send also delivers the user's own waiting message", async () => {
    const conv = solo();
    schedule(conv);
    hold('Alice');
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await orchestrator.send(conv.id, 'please install');
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(conv.queue).toHaveLength(1); // the user's, kept after Stop

    fake.gates = {};
    now = T0 + HOUR;
    await scheduler().tick();
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    expect(said(conv).slice(-3)).toEqual(['please install', 'scheduled check', '@Alice']);
    orchestrator.stop(conv.id);
    await finish(conv.id);
  });

  it('records nothing when the server stops while it sends, so the time is still due', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    now = T0 + HOUR;
    const s = scheduler();
    const looking = s.tick();
    s.stop();
    orchestrator.stopAll();
    await looking;
    expect(conv.messages).toEqual([]);
    expect(conv.schedule).toMatchObject({ nextRunAt: T0 + HOUR });
    expect(conv.schedule!.lastResult).toBeUndefined();
    expect(store.dueSchedules(now)).toEqual([conv.id]);
  });

  it('tries again when a settings change holds the conversation', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    let release!: () => void;
    const held = orchestrator.exclusive(conv.id, 'busy', () => new Promise<void>((r) => (release = r)));
    now = T0 + HOUR;
    await scheduler().tick();
    expect(conv.messages).toEqual([]);
    expect(conv.schedule!.lastResult).toBeUndefined();
    release();
    await held;
    await scheduler().tick();
    await finish(conv.id);
    expect(conv.schedule).toMatchObject({ lastResult: 'sent', nextRunAt: T0 + 2 * HOUR });
  });

  it('leaves a schedule replaced while its message was being sent as it is', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    now = T0 + HOUR;
    const looking = scheduler().tick();
    const replaced = { ...conv.schedule!, text: 'new text', nextRunAt: T0 + 5 * HOUR };
    conv.schedule = replaced;
    await looking;
    await finish(conv.id);
    expect(conv.schedule).toBe(replaced);
    expect(said(conv)[0]).toBe('scheduled check'); // what was due went out
  });

  it('sends a repeating schedule once after several missed times, when it says to', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    const nine = Date.UTC(2026, 0, 5, 9, 0);
    schedule(conv, { repeat: { kind: 'daily', time: '09:00' }, nextRunAt: nine, missed: 'run' });
    now = nine + 3 * 24 * HOUR + HOUR;
    await scheduler().tick();
    await finish(conv.id);
    await scheduler().tick();
    expect(conv.messages.filter((m) => m.scheduled)).toHaveLength(1);
    expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: nine, nextRunAt: nine + 4 * 24 * HOUR });
  });

  it('drops a stored schedule it cannot read', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    db.prepare("UPDATE schedules SET repeat = 'not json' WHERE conversation_id = ?").run(conv.id);
    setStore(new Store(db));
    setOrchestrator(new Orchestrator(store, new Hub(), settings));
    now = T0 + HOUR;
    await scheduler().tick();
    expect(store.dueSchedules(now)).toEqual([]);
    expect(store.get(conv.id)!.schedule).toBeUndefined();
  });

  it('sends nothing for a deleted conversation', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    schedule(conv);
    await orchestrator.deleteConversation(conv.id);
    now = T0 + HOUR;
    expect(store.dueSchedules(now)).toEqual([]);
    await expect(orchestrator.sendScheduled(conv.id)).rejects.toThrow();
    await scheduler().tick();
    expect(calls).toEqual([]);
  });

  describe('a team the lead agent designs for a schedule', () => {
    const pair = JSON.stringify({
      choice: 'custom',
      name: 'Report pair',
      description: 'Write it, then check it',
      mode: 'roundtable',
      rounds: 1,
      agents: [
        { name: 'Alice', provider: 'claude', role: 'Write the report.' },
        { name: 'Bob', provider: 'claude', role: 'Check it.' },
      ],
      reason: 'One writes, one checks.',
    });
    /** A conversation made for a schedule (New schedule): auto team, no team yet. */
    const forSchedule = (s: Partial<ConversationSchedule> = {}, settings: Partial<ConversationSettings> = {}) => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, ...settings });
      conv.agents = [];
      store.saveMeta(conv);
      schedule(conv, { text: 'Weekly report', ...s });
      fake.leadReply = pair;
      return conv;
    };
    const planOf = (conv: Conversation) => conv.messages.find((m) => m.plan)!;

    it('designs the team for the message, which nobody posts, and runs nothing once it is confirmed', async () => {
      const conv = forSchedule({ newChat: true });
      await orchestrator.designForSchedule(conv.id);
      await finish(conv.id);
      expect(calls.map((c) => c.name)).toEqual(['lead']);
      expect(calls[0]!.prompt).toContain('The user is setting up a schedule');
      expect(calls[0]!.prompt).toContain('each time in a new conversation');
      expect(calls[0]!.prompt).toContain('The scheduled message:\n<question>\nWeekly report\n</question>');
      expect(conv.messages.map((m) => m.author.kind)).toEqual(['system']); // only the team's card
      expect(planOf(conv).plan).toMatchObject({ status: 'ready', forSchedule: true, awaitingConfirmation: true });

      orchestrator.confirmPlan(conv.id, planOf(conv).id);
      expect(conv.agents.map((a) => a.name)).toEqual(['Alice', 'Bob']);
      expect(orchestrator.isRunning(conv.id)).toBe(false);
      expect(calls.map((c) => c.name)).toEqual(['lead']);
      expect(new Store(db).get(conv.id)!.messages[0]!.plan!.forSchedule).toBe(true);

      // When it comes due, that team gets the message, in a new chat.
      now = T0 + HOUR;
      await scheduler().tick();
      const chat = store.get(conv.schedule!.lastChatId!)!;
      await finish(chat.id);
      expect(said(chat)).toEqual(['note', 'Weekly report', '@Alice', '@Bob']);
      expect(calls.map((c) => c.name)).toEqual(['lead', 'Alice', 'Bob']);
    });

    it('uses the team at once when asked to, still running nothing, and answers what the user wrote while it waited', async () => {
      const auto = forSchedule({}, { autoConfirm: true });
      await orchestrator.designForSchedule(auto.id);
      await finish(auto.id);
      expect(planOf(auto).plan).toMatchObject({ forSchedule: true, autoConfirmed: true });
      expect(auto.agents.map((a) => a.name)).toEqual(['Alice', 'Bob']);
      expect(calls.map((c) => c.name)).toEqual(['lead']);
      expect(calls[0]!.prompt).toContain('each time in this conversation');

      calls.length = 0;
      const asks = forSchedule();
      await orchestrator.designForSchedule(asks.id);
      await finish(asks.id);
      expect(await orchestrator.send(asks.id, 'Use last week as the template')).toEqual({ queued: true });
      orchestrator.confirmPlan(asks.id, planOf(asks).id);
      await vi.waitFor(() => expect(agentMessages(asks).filter((m) => m.status === 'done')).toHaveLength(2), { timeout: 20_000 });
      await finish(asks.id);
      expect(said(asks).slice(1)).toEqual(['Use last week as the template', '@Alice', '@Bob']);
    });

    it('designs for a later question in that chat as usual', async () => {
      const conv = forSchedule();
      await orchestrator.designForSchedule(conv.id);
      await finish(conv.id);
      orchestrator.confirmPlan(conv.id, planOf(conv).id);
      calls.length = 0;
      await orchestrator.send(conv.id, 'Also compare with last month');
      await finish(conv.id);
      expect(calls.map((c) => c.name)).toEqual(['lead']);
      expect(calls[0]!.prompt).toContain('The user asked a new question in this conversation.');
      expect(calls[0]!.prompt).toContain('<question>\nAlso compare with last month\n</question>');
      expect(conv.messages.filter((m) => m.plan).at(-1)!.plan!.forSchedule).toBeUndefined();
    });

    it('tells an open chat when the chat its schedule last opened is deleted', async () => {
      const hub = new Hub();
      setOrchestrator(new Orchestrator(store, hub, settings));
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      schedule(conv, { newChat: true });
      now = T0 + HOUR;
      await scheduler().tick();
      const chatId = conv.schedule!.lastChatId!;
      await finish(chatId);
      const events: { type: string; schedule?: unknown }[] = [];
      hub.subscribe(conv.id, (e) => events.push(e as never));
      await orchestrator.deleteConversation(chatId);
      expect(events).toEqual([expect.objectContaining({ type: 'conversation', schedule: expect.not.objectContaining({ lastChatId: chatId }) })]);
    });

    it('runs nothing either when the user sets the team by hand instead', async () => {
      const conv = forSchedule();
      await orchestrator.designForSchedule(conv.id);
      await finish(conv.id);
      conv.agents = [agents[0]!];
      expect(orchestrator.confirmPendingPlan(conv)).toBe(true);
      expect(orchestrator.startConfirmed(conv)).toBe(false);
      expect(orchestrator.isRunning(conv.id)).toBe(false);
    });

    it('keeps a time that comes due while the team is designed or waits, and sends it once the team is confirmed', async () => {
      const conv = forSchedule({ repeat: { kind: 'once', at: T0 + HOUR } });
      let release!: () => void;
      fake.leadGate = new Promise((r) => (release = r));
      await orchestrator.designForSchedule(conv.id);
      expect(conv.messages.find((m) => m.plan)!.plan).toMatchObject({ status: 'planning', forSchedule: true });
      now = T0 + HOUR;
      const s = scheduler();
      await s.tick(); // the lead agent is still designing
      expect(conv.schedule).toMatchObject({ enabled: true, nextRunAt: T0 + HOUR });
      expect(conv.schedule!.lastResult).toBeUndefined();
      release();
      await finish(conv.id);
      now += 60_000;
      await s.tick(); // the team waits for confirmation
      expect(conv.schedule!.lastResult).toBeUndefined();

      orchestrator.confirmPlan(conv.id, planOf(conv).id);
      now += 60_000;
      await s.tick();
      await finish(conv.id);
      expect(said(conv).slice(-3)).toEqual(['Weekly report', '@Alice', '@Bob']);
      expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: T0 + HOUR, enabled: false }); // the one time went out
    });

    it('gives up on a time after a while when nobody confirms the team, and refuses what it cannot design for', async () => {
      const conv = forSchedule();
      await orchestrator.designForSchedule(conv.id);
      await finish(conv.id);
      now = T0 + HOUR;
      const s = scheduler();
      await s.tick();
      now = T0 + HOUR + BUSY_RETRY_MS + 1000;
      await s.tick();
      expect(conv.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the team is not confirmed yet', nextRunAt: T0 + 2 * HOUR });
      await expect(orchestrator.designForSchedule(conv.id)).rejects.toThrow(/確認/); // a design waits already
      orchestrator.confirmPlan(conv.id, planOf(conv).id);
      await expect(orchestrator.designForSchedule(conv.id)).rejects.toThrow(/已經有團隊/); // and then it has a team

      const none = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true });
      await expect(orchestrator.designForSchedule(none.id)).rejects.toThrow(/沒有排程/);
      const fixed = conversation({ mode: 'roundtable', permission: 'read-only' });
      schedule(fixed);
      await expect(orchestrator.designForSchedule(fixed.id)).rejects.toThrow(/首席 agent/);
    });
  });

  describe('opening a new chat each time', () => {
    /** The conversations the schedule of `conv` opened. */
    const opened = (conv: Conversation) =>
      store
        .list(() => false)
        .filter((c) => c.id !== conv.id)
        .map((c) => store.get(c.id)!);

    it('opens a new chat with the same team, settings, "always allow" answers and group, and sends the message there', async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      conv.allowRules = [{ kind: 'command', key: 'npm install' }];
      store.saveMeta(conv);
      store.createGroup({ id: 'g1', name: 'Ops' });
      store.moveToGroup(conv.id, 'g1');
      schedule(conv, { newChat: true });
      now = T0 + HOUR;
      await scheduler().tick();
      const [chat] = opened(conv);
      expect(chat).toBeDefined();
      await finish(chat!.id);

      expect(conv.messages).toEqual([]); // nothing in the schedule's own chat
      expect(chat!.title).toBe(`test · ${scheduleTime(T0 + HOUR, conv.schedule!)}`);
      expect(chat!.agents).toEqual(conv.agents);
      expect(chat!.agents).not.toBe(conv.agents);
      expect(chat!.settings).toEqual(conv.settings);
      expect(chat!.allowRules).toEqual(conv.allowRules);
      expect(chat!.schedule).toBeUndefined();
      expect(said(chat!)).toEqual(['note', 'scheduled check', '@Alice', '@Bob']);
      expect(notes(chat!)[0]).toBe('The schedule of "test" opened this conversation to send its message here.');
      expect(chat!.messages[1]!.scheduled).toBe(true);
      // In the group of the schedule's chat, as the user put it: the lead agent does not sort it.
      expect(store.groupOf(chat!.id)).toBe('g1');
      expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
      expect(calls[0]!.prompt).toContain('<message from="user" via="schedule">');
      expect(calls[0]!.systemPrompt).toContain('A user message marked via="schedule" was sent automatically');
      expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: T0 + HOUR, lastChatId: chat!.id, nextRunAt: T0 + 2 * HOUR });
      expect(new Store(db).get(conv.id)!.schedule!.lastChatId).toBe(chat!.id);
      expect(new Store(db).get(chat!.id)!.messages.map((m) => m.author.kind)).toEqual(['system', 'user', 'agent', 'agent']);

      // The next time opens another one, where the agents start new sessions.
      now = T0 + 2 * HOUR;
      await scheduler().tick();
      const second = opened(conv).find((c) => c.id !== chat!.id)!;
      await finish(second.id);
      expect(opened(conv)).toHaveLength(2);
      expect(said(second)).toEqual(['note', 'scheduled check', '@Alice', '@Bob']);
      expect(calls.slice(2).map((c) => c.sessionId)).toEqual([undefined, undefined]);
      expect(conv.schedule!.lastChatId).toBe(second.id);
      expect(conv.messages).toEqual([]);
    });

    it('refuses approvals there too, unless the schedule says to ask, and asks once the user writes in it', async () => {
      const conv = solo();
      schedule(conv, { text: 'please install', newChat: true });
      now = T0 + HOUR;
      await scheduler().tick();
      const chat = store.get(conv.schedule!.lastChatId!)!;
      await finish(chat.id);
      expect(textOf(agentMessages(chat).at(-1)!)).toMatch(/^Alice skipped \(This run was started by a schedule and nobody may be watching/);
      expect(approvalParts(chat)[0]).toMatchObject({ status: 'denied', note: 'Refused automatically: nobody may be watching a scheduled run' });
      expect(calls[0]!.systemPrompt).toContain('refused automatically');

      // The user writes in the new chat: they are here, so the run asks.
      await orchestrator.send(chat.id, 'please install');
      await vi.waitFor(() => expect(orchestrator.isWaiting(chat.id)).toBe(true));
      expect(calls.at(-1)!.systemPrompt).toContain('A user message marked via="schedule" was sent automatically');
      expect(calls.at(-1)!.systemPrompt).not.toContain('refused automatically');
      orchestrator.stop(chat.id);
      await finish(chat.id);

      schedule(conv, { text: 'please install', newChat: true, approvals: 'ask', nextRunAt: T0 + 2 * HOUR });
      now = T0 + 2 * HOUR;
      await scheduler().tick();
      const asks = store.get(conv.schedule!.lastChatId!)!;
      expect(asks.id).not.toBe(chat.id);
      await vi.waitFor(() => expect(orchestrator.isWaiting(asks.id)).toBe(true));
      orchestrator.answerApproval(asks.id, pendingPart(asks)!.id, { allow: true });
      await finish(asks.id);
      expect(textOf(agentMessages(asks).at(-1)!)).toBe('Alice installed');
    });

    it("goes ahead whatever this conversation is doing: waiting for the user's answer, or replying", async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      schedule(conv, { newChat: true });
      fake.asking = new Set(['Alice']);
      await orchestrator.send(conv.id, 'which one?');
      await finish(conv.id);
      expect(conv.pause).toBeDefined();
      fake.asking = new Set();

      now = T0 + HOUR;
      await scheduler().tick();
      const chat = store.get(conv.schedule!.lastChatId!)!;
      await finish(chat.id);
      expect(said(chat)).toEqual(['note', 'scheduled check', '@Alice', '@Bob']);
      // This conversation still waits for the answer, with nothing taken for it or queued.
      expect(said(conv)).toEqual(['which one?', '@Alice']);
      expect(conv.pause).toBeDefined();
      expect(conv.queue ?? []).toEqual([]);

      const alice = hold('Alice');
      await orchestrator.send(conv.id, 'ANSWER: A');
      await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(true));
      now = T0 + 2 * HOUR;
      await scheduler().tick();
      expect(conv.schedule).toMatchObject({ lastResult: 'sent', nextRunAt: T0 + 3 * HOUR });
      expect(conv.queue ?? []).toEqual([]);
      alice();
      await finish(conv.id);
      await finish(conv.schedule!.lastChatId!);
    });

    it('waits while this or another conversation writes in the same folder, and leaves no chat behind', async () => {
      const conv = solo({ permission: 'edit' });
      schedule(conv, { newChat: true });
      const alice = hold('Alice');
      await orchestrator.send(conv.id, 'go'); // this conversation writes in the folder
      await vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(['Alice']));

      now = T0 + HOUR;
      const s = scheduler();
      await s.tick();
      expect(opened(conv)).toEqual([]);
      expect(conv.schedule!.lastResult).toBeUndefined(); // tried again at the next look

      alice();
      await finish(conv.id);
      now += 60_000;
      await s.tick();
      const chat = store.get(conv.schedule!.lastChatId!)!;
      await finish(chat.id);
      expect(said(chat)).toEqual(['note', 'scheduled check', '@Alice']);
      expect(conv.schedule).toMatchObject({ lastResult: 'sent', lastRunAt: T0 + HOUR });
      expect(chat.title).toBe(`test · ${scheduleTime(T0 + HOUR, conv.schedule!)}`); // the time it came due, not when it went out
    });

    it('removes a chat whose run could not start after all: the server began to stop meanwhile', async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      schedule(conv, { newChat: true });
      const sending = orchestrator.sendScheduled(conv.id);
      orchestrator.stopAll();
      expect(await sending).toEqual({ result: 'busy', reason: expect.any(String) });
      expect(opened(conv)).toEqual([]);
      expect(calls).toEqual([]);
    });

    it('keeps a chat opened from a conversation in Other there, unsorted, and gives parallel teams worktrees of its own', async () => {
      const conv = conversation({ mode: 'parallel', permission: 'edit' });
      store.createGroup({ id: 'g1', name: 'Ops' }); // there are groups, but the conversation is in Other
      schedule(conv, { newChat: true });
      const sent = await orchestrator.sendScheduled(conv.id);
      const chat = store.get((sent as { chatId: string }).chatId)!;
      await finish(chat.id);
      expect(store.groupOf(chat.id)).toBeNull();
      expect(store.isSorted(chat.id)).toBe(true);
      expect(calls.map((c) => c.name).sort()).toEqual(['Alice', 'Bob']); // no sorter
      expect(Object.keys(chat.worktrees).sort()).toEqual(['a', 'b']);
      expect(Object.values(chat.worktrees).flat().every((w) => w.branch.startsWith(`relay/${chat.id.slice(0, 8)}/`))).toBe(true);
      expect(conv.worktrees).toEqual({});
    });

    it('names the chats after the message while the schedule\'s conversation has no name, and forgets a chat that is deleted', async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      conv.title = 'New chat';
      store.saveMeta(conv);
      schedule(conv, { newChat: true, text: 'Weekly report\nwith the numbers' });
      now = T0 + HOUR;
      await scheduler().tick();
      const chatId = conv.schedule!.lastChatId!;
      await finish(chatId);
      expect(store.get(chatId)!.title).toBe(`Weekly report · ${scheduleTime(T0 + HOUR, conv.schedule!)}`);

      await orchestrator.deleteConversation(chatId);
      expect(conv.schedule!.lastChatId).toBeUndefined();
      expect(conv.schedule!.lastResult).toBe('sent');
      expect(new Store(db).get(conv.id)!.schedule!.lastChatId).toBeUndefined();
    });

    it('opens no chat without a confirmed team, removes one whose run cannot start, and forgets the last chat then', async () => {
      const auto = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true });
      auto.agents = [];
      store.saveMeta(auto);
      schedule(auto, { newChat: true });
      now = T0 + HOUR;
      await scheduler().tick();
      expect(auto.schedule).toMatchObject({ lastResult: 'skipped', lastError: 'the team is not confirmed yet' });

      const gone = conversation({ mode: 'roundtable', permission: 'edit', cwd: join(project, 'gone') });
      schedule(gone, { newChat: true, lastResult: 'sent', lastChatId: 'earlier-chat' });
      await scheduler().tick();
      expect(gone.schedule).toMatchObject({ lastResult: 'failed', nextRunAt: T0 + 2 * HOUR });
      expect(gone.schedule!.lastChatId).toBeUndefined();
      expect(notes(gone).at(-1)).toMatch(/could not be sent/);
      expect(store.list(() => false).map((c) => c.id).sort()).toEqual([auto.id, gone.id].sort());
      expect(calls).toEqual([]);
    });

    it('says which chat "Run now" opened, and leaves what the schedule recorded alone', async () => {
      const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
      schedule(conv, { newChat: true });
      const sent = await orchestrator.sendScheduled(conv.id);
      expect(sent).toEqual({ result: 'sent', chatId: expect.any(String) });
      const chat = store.get((sent as { chatId: string }).chatId)!;
      await finish(chat.id);
      expect(said(chat)).toEqual(['note', 'scheduled check', '@Alice', '@Bob']);
      expect(conv.schedule!.lastChatId).toBeUndefined();
      expect(conv.schedule!.lastResult).toBeUndefined();
    });
  });
});
