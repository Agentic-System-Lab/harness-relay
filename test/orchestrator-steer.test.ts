/*
 * Steering (`ConversationSettings.steer`): a message the user sends while members work goes into their
 * running turns, as the mode allows (roundtable and relay: the member speaking; parallel: the whole
 * round, or none), and else waits in the queue as before; what went in counts as seen by those members.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts (`fake.steer`).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationSettings } from '../src/shared/types';
import { agentMessages, calls, conversation, db, fake, finish, orchestrator, Store, textOf } from './orchestrator-harness';

/** The chat as a list: what the user said (with whose turn it went into), who replied, and notes. */
const said = (conv: Conversation) =>
  conv.messages.map((m) =>
    m.author.kind === 'user'
      ? textOf(m) + (m.steered ? ` → ${m.steered.join(',')}` : '')
      : m.author.kind === 'agent'
        ? `@${m.agentName}`
        : 'note',
  );

/** Make an agent wait in its turn; returns the function that lets it finish. */
const hold = (name: string) => {
  let release!: () => void;
  fake.gates[name] = new Promise((r) => (release = r));
  return () => release();
};

const steering = (settings: Partial<ConversationSettings>) => conversation({ permission: 'read-only', steer: true, ...settings });

/** Wait until these agents' fake CLIs are in their turns. */
const speaking = (...names: string[]) => vi.waitFor(() => expect(calls.map((c) => c.name)).toEqual(names));

/** The message as a turn's prompt gives it. */
const userBlock = (text: string) => `<message from="user">\n${text}\n</message>`;

const replied = (conv: Conversation, n: number) =>
  vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status !== 'streaming')).toHaveLength(n), { timeout: 20_000 });

describe('steering', () => {
  it('is off by default: a message waits in the queue as before', async () => {
    fake.steer = new Set(['Alice', 'Bob']);
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    expect(conv.settings.steer).toBeUndefined();
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await speaking('Alice');
    expect(await orchestrator.send(conv.id, 'also check the tests')).toEqual({ queued: true });
    alice();
    await finish(conv.id);
    expect(calls[0]!.steered).toBeUndefined();
    expect(said(conv)).toEqual(['question', '@Alice', 'also check the tests', '@Bob']);
  });

  it('in roundtable mode goes into the speaking member’s turn, which counts it as seen', async () => {
    fake.steer = new Set(['Alice', 'Bob']);
    const conv = steering({ mode: 'roundtable', rounds: 2 });
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await speaking('Alice');
    expect(await orchestrator.send(conv.id, 'also check the tests')).toEqual({ queued: false });
    // In the chat at once, after the reply it went into, marked with that member.
    expect(said(conv)).toEqual(['question', '@Alice', 'also check the tests → a']);
    expect(conv.queue ?? []).toEqual([]);
    const sent = conv.messages[2]!;
    expect(sent.queued).toBe(true);
    expect(calls[0]!.steered).toHaveLength(1);
    expect(calls[0]!.steered![0]).toContain('<message from="user">\nalso check the tests\n</message>');
    alice();
    await finish(conv.id);

    expect(textOf(agentMessages(conv)[0]!)).toBe('Alice done; heard: also check the tests');
    expect(said(conv)).toEqual(['question', '@Alice', 'also check the tests → a', '@Bob', '@Alice', '@Bob']);
    // Bob gets it before his turn as any message; Alice saw it in hers, so not again.
    expect(calls[1]!.prompt).toContain('also check the tests');
    expect(calls[2]!.name).toBe('Alice');
    expect(calls[2]!.prompt).not.toContain(userBlock('also check the tests'));
    expect(conv.agentState.a!.seen).toContain(sent.id);

    const reloaded = new Store(db).get(conv.id)!;
    expect(reloaded.settings.steer).toBe(true);
    expect(reloaded.messages[2]!.steered).toEqual(['a']);
    expect(reloaded.messages[2]!.queued).toBe(true);
    expect(reloaded.agentState.a!.seen).toContain(sent.id);
  });

  it('keeps the order: messages sent one after another go in one after another', async () => {
    fake.steer = new Set(['Alice']);
    const conv = steering({ mode: 'roundtable' });
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await speaking('Alice');
    const both = await Promise.all([orchestrator.send(conv.id, 'first'), orchestrator.send(conv.id, 'second')]);
    expect(both).toEqual([{ queued: false }, { queued: false }]);
    expect(said(conv)).toEqual(['question', '@Alice', 'first → a', 'second → a']);
    alice();
    await finish(conv.id);
    expect(textOf(agentMessages(conv)[0]!)).toBe('Alice done; heard: first | second');
  });

  it('in relay mode goes into the turn of the member holding the relay; one for another member waits for them', async () => {
    fake.steer = new Set(['Alice', 'Bob']);
    const conv = steering({ mode: 'relay' });
    const alice = hold('Alice');
    fake.reply = (name) => (name === 'Alice' ? 'over to @Bob' : undefined);
    await orchestrator.send(conv.id, 'question');
    await speaking('Alice');
    expect(await orchestrator.send(conv.id, 'keep it short')).toEqual({ queued: false });
    expect(await orchestrator.send(conv.id, '@Bob and you check it')).toEqual({ queued: true });
    alice();
    await finish(conv.id);
    expect(said(conv)).toEqual(['question', '@Alice', 'keep it short → a', '@Bob and you check it', '@Bob']);
    expect(calls[1]!.prompt).toContain('@Bob and you check it');
  });

  it('falls back to the queue when the turn refuses it, and the next turn gets it as before', async () => {
    fake.steer = new Set(['Alice', 'Bob']);
    fake.refuseSteer = new Set(['Alice']);
    const conv = steering({ mode: 'roundtable' });
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await speaking('Alice');
    expect(await orchestrator.send(conv.id, 'also check the tests')).toEqual({ queued: true });
    expect(conv.queue!.map(textOf)).toEqual(['also check the tests']);
    alice();
    await finish(conv.id);
    expect(said(conv)).toEqual(['question', '@Alice', 'also check the tests', '@Bob']);
    expect(conv.messages[2]!.steered).toBeUndefined();
    expect(calls[1]!.prompt).toContain('also check the tests');
  });

  it('does not take a message with files, nor one sent while another waits in the queue', async () => {
    fake.steer = new Set(['Alice', 'Bob']);
    const conv = steering({ mode: 'roundtable' });
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await speaking('Alice');
    const file = { name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('hi').toString('base64') };
    expect(await orchestrator.send(conv.id, 'see the file', [file])).toEqual({ queued: true });
    // It would overtake the one waiting: it waits behind it.
    expect(await orchestrator.send(conv.id, 'and this')).toEqual({ queued: true });
    expect(conv.queue!.map(textOf)).toEqual(['see the file', 'and this']);
    alice();
    await finish(conv.id);
    expect(calls[0]!.steered).toBeUndefined();
    expect(said(conv)).toEqual(['question', '@Alice', 'see the file', 'and this', '@Bob']);
  });

  it('offers it again when the turn it went into fails', async () => {
    fake.steer = new Set(['Alice']);
    const conv = steering({ mode: 'roundtable', rounds: 2 });
    conv.agents = [conv.agents[0]!];
    const alice = hold('Alice');
    let failed = false;
    fake.fail = (name) => {
      if (name !== 'Alice' || failed) return undefined;
      failed = true;
      return new Error('rate limited');
    };
    await orchestrator.send(conv.id, 'question');
    await speaking('Alice');
    expect(await orchestrator.send(conv.id, 'also check the tests')).toEqual({ queued: false });
    alice();
    await finish(conv.id);
    expect(agentMessages(conv)[0]!.status).toBe('error');
    expect(conv.agentState.a!.seen).not.toContain(conv.messages[2]!.id);
    // Its turn failed: not seen, so the next turn (Continue) is given it.
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(calls[1]!.prompt).toContain(userBlock('also check the tests'));
  });

  it('in parallel mode goes into every turn of the round at once', async () => {
    fake.steer = new Set(['Alice', 'Bob']);
    const conv = steering({ mode: 'parallel', rounds: 2 });
    const alice = hold('Alice');
    const bob = hold('Bob');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(await orchestrator.send(conv.id, 'one more thing')).toEqual({ queued: false });
    expect(conv.messages.at(-1)!.steered).toEqual(['a', 'b']);
    alice();
    bob();
    await finish(conv.id);
    const round1 = agentMessages(conv).slice(0, 2);
    expect(round1.map(textOf)).toEqual(['Alice done; heard: one more thing', 'Bob done; heard: one more thing']);
    // Round 2: neither is given it again (only the other's reply that mentions it).
    expect(calls.slice(2).map((c) => c.prompt.includes(userBlock('one more thing')))).toEqual([false, false]);
  });

  it('in parallel mode waits in the queue when it names members of the round: the round sees the same message', async () => {
    fake.steer = new Set(['Alice', 'Bob']);
    const conv = steering({ mode: 'parallel' });
    const alice = hold('Alice');
    const bob = hold('Bob');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(await orchestrator.send(conv.id, '@Alice one more thing')).toEqual({ queued: true });
    alice();
    bob();
    await replied(conv, 3);
    await finish(conv.id);
    expect(calls[0]!.steered).toBeUndefined();
    expect(calls[1]!.steered).toBeUndefined();
    // Then it is Alice's, in a turn of its own, as without steering.
    expect(said(conv)).toEqual(['question', '@Alice', '@Bob', '@Alice one more thing', '@Alice']);
  });

  it('waits in the queue, starting nothing, when the user stops the run while it is being sent into a turn', async () => {
    fake.steer = new Set(['Alice']);
    fake.refuseSteer = new Set(['Alice']);
    let answer!: () => void;
    fake.steerWait = new Promise((r) => (answer = r));
    const conv = steering({ mode: 'roundtable', rounds: 1 });
    hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await speaking('Alice');
    const sent = orchestrator.send(conv.id, 'one more thing');
    await new Promise((r) => setTimeout(r, 20));
    orchestrator.stop(conv.id);
    await finish(conv.id);
    answer();
    expect(await sent).toEqual({ queued: true });
    await new Promise((r) => setTimeout(r, 50));
    // No run of its own: it waits in the tray, as a message sent with steering off would after Stop.
    expect(orchestrator.isRunning(conv.id)).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(['Alice']);
    expect(conv.queue?.map(textOf)).toEqual(['one more thing']);
  });

  it('in parallel mode waits in the queue when one member of the round cannot take it', async () => {
    fake.steer = new Set(['Alice']);
    const conv = steering({ mode: 'parallel' });
    const alice = hold('Alice');
    const bob = hold('Bob');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(await orchestrator.send(conv.id, 'one more thing')).toEqual({ queued: true });
    alice();
    bob();
    await replied(conv, 4);
    await finish(conv.id);
    expect(calls[0]!.steered).toBeUndefined();
    // As before: a run of its own, which the whole team sees.
    expect(said(conv)).toEqual(['question', '@Alice', '@Bob', 'one more thing', '@Alice', '@Bob']);
  });

  it('in parallel mode waits in the queue once a member of the round has finished', async () => {
    fake.steer = new Set(['Alice', 'Bob']);
    const conv = steering({ mode: 'parallel' });
    const bob = hold('Bob');
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(agentMessages(conv).find((m) => m.agentName === 'Alice')?.status).toBe('done'));
    expect(await orchestrator.send(conv.id, 'one more thing')).toEqual({ queued: true });
    bob();
    await replied(conv, 4);
    await finish(conv.id);
    expect(calls[1]!.steered).toBeUndefined();
  });

  it('is switched on and off by itself, also while the team replies', async () => {
    fake.steer = new Set(['Alice', 'Bob']);
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    const alice = hold('Alice');
    await orchestrator.send(conv.id, 'question');
    await speaking('Alice');
    expect(orchestrator.setSteer(conv.id, true).settings.steer).toBe(true);
    expect(await orchestrator.send(conv.id, 'now in')).toEqual({ queued: false });
    orchestrator.setSteer(conv.id, false);
    expect(conv.settings.steer).toBeUndefined();
    expect(await orchestrator.send(conv.id, 'now queued')).toEqual({ queued: true });
    alice();
    await finish(conv.id);
    expect(said(conv)).toEqual(['question', '@Alice', 'now in → a', 'now queued', '@Bob']);
    expect(new Store(db).get(conv.id)!.settings.steer).toBeUndefined();
  });
});
