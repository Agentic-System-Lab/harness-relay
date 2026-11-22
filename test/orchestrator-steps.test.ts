/*
 * Steps cards with the fake CLI: a reply that ends with a <steps> block asks the user as one ending with
 * [ASK_USER] does, its steps are ticked and kept, and the user's answer goes on as an answer to a
 * question (the agent that asked first). The fake CLI is in ./orchestrator-harness.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '../src/shared/types';
import { agentMessages, calls, conversation, db, fake, finish, orchestrator, store, Store, textOf, withLang } from './orchestrator-harness';

const STEPS =
  'Set up the app first.\n\n<steps>\n1. Open the [console](https://example.com/apps).\n2. Ask @Bob for the key.\n3. Copy the app ID.\n</steps>';

/** Alice gives the user steps until the user's answer is in her prompt. */
function aliceGivesSteps(reply = STEPS): void {
  fake.reply = (name, prompt) => (name === 'Alice' && !prompt.includes('gave me') ? reply : undefined);
}

const said = (conv: Conversation) =>
  conv.messages.map((m) => (m.author.kind === 'user' ? 'user' : m.author.kind === 'agent' ? `@${m.agentName}` : 'note'));
const stepsOf = (m: ChatMessage) => m.parts.find((p) => p.type === 'steps');
const told = (name: string) => calls.filter((c) => c.name === name).map((c) => c.prompt.includes('You asked the user a question'));

async function askedSteps(settings: Parameters<typeof conversation>[0] = { mode: 'roundtable', permission: 'read-only' }) {
  const conv = conversation(settings);
  aliceGivesSteps();
  await orchestrator.send(conv.id, 'connect Threads');
  await finish(conv.id);
  return { conv, reply: agentMessages(conv)[0]! };
}

describe('steps cards', () => {
  it('a reply with steps asks the user: the team waits, and the steps are a part of their own', async () => {
    const { conv, reply } = await askedSteps();
    expect(said(conv)).toEqual(['user', '@Alice']); // Bob waits
    expect(reply.asked).toBe(true);
    expect(reply.passed).toBe(false);
    expect(textOf(reply)).toBe('Set up the app first.');
    expect(stepsOf(reply)).toEqual({
      type: 'steps',
      items: [{ text: 'Open the [console](https://example.com/apps).' }, { text: 'Ask @Bob for the key.' }, { text: 'Copy the app ID.' }],
    });
    expect(conv.pause).toMatchObject({ askers: ['a'], rest: [{ agentId: 'b' }] });
    const reloaded = new Store(db).get(conv.id)!;
    expect(stepsOf(reloaded.messages[1]!)).toEqual(stepsOf(reply));
    expect(store.list(() => false).find((c) => c.id === conv.id)!.asking).toBe(true);
    // Search finds the words of a step.
    expect(store.search('app ID').map((r) => r.id)).toEqual([conv.id]);
  });

  it('a reply of steps alone has said something, and an ask marker beside them adds nothing', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    aliceGivesSteps('[ASK_USER]\n<steps>\n1. Sign in\n</steps>');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const reply = agentMessages(conv)[0]!;
    expect(reply).toMatchObject({ asked: true, passed: false });
    expect(reply.parts).toEqual([{ type: 'steps', items: [{ text: 'Sign in' }] }]);
  });

  it('keeps the steps the user ticks, for every browser and after a restart', async () => {
    const { conv, reply } = await askedSteps();
    orchestrator.tickStep(conv.id, reply.id, 0, true);
    orchestrator.tickStep(conv.id, reply.id, 2, true);
    orchestrator.tickStep(conv.id, reply.id, 2, false);
    expect(stepsOf(reply)).toMatchObject({ items: [{ done: true }, {}, {}] });
    expect(stepsOf(new Store(db).get(conv.id)!.messages[1]!)).toMatchObject({ items: [{ done: true }, {}, {}] });
    expect(() => orchestrator.tickStep(conv.id, reply.id, 3, true)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => orchestrator.tickStep(conv.id, 'nope', 0, true)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => orchestrator.tickStep(conv.id, conv.messages[0]!.id, 0, true)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('posts the answer as the user’s message, and the agent that asked answers first, then the round goes on', async () => {
    const { conv, reply } = await askedSteps();
    orchestrator.tickStep(conv.id, reply.id, 0, true);
    const { queued } = await withLang('en', () =>
      orchestrator.answerSteps(conv.id, reply.id, { done: [0, 2], stuckAt: 1, note: 'No key yet.' }),
    );
    expect(queued).toBe(false);
    await finish(conv.id);
    expect(said(conv)).toEqual(['user', '@Alice', 'user', '@Alice', '@Bob']);
    const answer = conv.messages[2]!;
    expect(textOf(answer)).toBe(
      "I'm stuck at step 2 of the 3 steps @Alice gave me (2 done).\n\n" +
        '1. [done] Open the console.\n2. [stuck here] Ask Bob for the key.\n3. [done] Copy the app ID.\n\nNote: No key yet.',
    );
    expect(told('Alice')).toEqual([false, true]);
    expect(told('Bob')).toEqual([false]);
    // Bob reads the steps as the block Alice wrote, and the user's answer.
    expect(calls.at(-1)!.prompt).toContain('<steps>\n1. Open the [console](https://example.com/apps).\n2. Ask @Bob for the key.');
    expect(calls.at(-1)!.prompt).toContain('[stuck here] Ask Bob for the key.');
    expect(stepsOf(reply)).toMatchObject({
      items: [{ done: true }, { text: 'Ask @Bob for the key.' }, { done: true }],
      answer: { stuckAt: 1, note: 'No key yet.' },
    });
    expect((stepsOf(reply) as { items: { done?: boolean }[] }).items[1]!.done).toBeUndefined();
    expect(conv.pause).toBeUndefined();
    // Answered: the card no longer changes.
    expect(() => orchestrator.tickStep(conv.id, reply.id, 1, true)).toThrow(expect.objectContaining({ status: 409 }));
    await expect(orchestrator.answerSteps(conv.id, reply.id, { done: [] })).rejects.toMatchObject({ status: 409 });
  });

  it('answers in the user’s language, all steps done', async () => {
    const { conv, reply } = await askedSteps();
    await withLang('zh-TW', () => orchestrator.answerSteps(conv.id, reply.id, { done: [0, 1, 2] }));
    await finish(conv.id);
    expect(textOf(conv.messages[2]!)).toBe(
      '@Alice 給我的 3 個步驟都完成了。\n\n1. [完成] Open the console.\n2. [完成] Ask Bob for the key.\n3. [完成] Copy the app ID.',
    );
  });

  it('in relay mode, gives the floor back to the one that asked, whoever its steps mention', async () => {
    const { conv, reply } = await askedSteps({ mode: 'relay', permission: 'read-only', maxHops: 5 });
    await orchestrator.answerSteps(conv.id, reply.id, { done: [0, 1, 2] });
    await finish(conv.id);
    expect(said(conv)).toEqual(['user', '@Alice', 'user', '@Alice']);
    expect(told('Alice')).toEqual([false, true]);
  });

  it('is no longer waited for once the user answered otherwise, nor while the team works', async () => {
    const { conv, reply } = await askedSteps();
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'I did it all.');
    expect(() => orchestrator.tickStep(conv.id, reply.id, 0, true)).toThrow(expect.objectContaining({ status: 409 }));
    release();
    await finish(conv.id);
    expect(() => orchestrator.tickStep(conv.id, reply.id, 0, true)).toThrow(expect.objectContaining({ status: 409 }));
    await expect(orchestrator.answerSteps(conv.id, reply.id, { done: [0] })).rejects.toMatchObject({ status: 409 });
    expect(stepsOf(reply)).not.toHaveProperty('answer');
  });

  describe('with other agents waiting too (parallel mode)', () => {
    /** Each agent named gives the user steps on its first turn only; `asks` asks with [ASK_USER] until answered. */
    function firstTurns(steps: string[], asks: string[] = []) {
      const turns = new Map<string, number>();
      fake.asking = new Set(asks);
      fake.reply = (name) => {
        const n = (turns.get(name) ?? 0) + 1;
        turns.set(name, n);
        return steps.includes(name) && n === 1 ? `${name}'s steps:\n<steps>\n1. Sign in\n2. Create a key\n</steps>` : undefined;
      };
    }
    const replyOf = (conv: Conversation, name: string) => agentMessages(conv).find((m) => m.agentName === name)!;

    it('answers the card’s own agent alone; the other question keeps waiting, then goes on with its own answer', async () => {
      const conv = conversation({ mode: 'parallel', permission: 'read-only', rounds: 2 });
      firstTurns(['Alice'], ['Bob']);
      await orchestrator.send(conv.id, 'set it up');
      await finish(conv.id);
      expect(conv.pause).toMatchObject({ askers: ['a', 'b'], round: 1, rounds: 2 });

      await orchestrator.answerSteps(conv.id, replyOf(conv, 'Alice').id, { done: [0, 1] });
      await finish(conv.id);
      // Alice alone went on, told she was answered; Bob was not asked again, and still waits.
      expect(said(conv)).toEqual(['user', '@Alice', '@Bob', 'user', '@Alice']);
      expect(told('Alice')).toEqual([false, true]);
      expect(told('Bob')).toEqual([false]);
      expect(conv.pause).toMatchObject({ askers: ['b'], round: 1, rounds: 2 });
      expect(new Store(db).get(conv.id)!.pause).toMatchObject({ askers: ['b'] });
      expect(store.list(() => false).find((c) => c.id === conv.id)!.asking).toBe(true);

      // Bob's answer: he goes on first, with his own answer, then the next round (where he asks no more).
      fake.asking = new Set();
      await orchestrator.send(conv.id, 'ANSWER: B');
      await finish(conv.id);
      expect(said(conv).slice(5)).toEqual(['user', '@Bob', '@Alice', '@Bob']);
      expect(told('Bob')).toEqual([false, true, false]);
      expect(told('Alice')).toEqual([false, true, false]);
      expect(conv.pause).toBeUndefined();
    });

    it('keeps the other card waiting and tickable; one that asks again after its answer waits beside it', async () => {
      const conv = conversation({ mode: 'parallel', permission: 'read-only' });
      firstTurns(['Alice', 'Bob']);
      await orchestrator.send(conv.id, 'set it up');
      await finish(conv.id);
      const alice = replyOf(conv, 'Alice');
      const bob = replyOf(conv, 'Bob');
      // Alice asks again once answered.
      fake.reply = (name) => (name === 'Alice' ? 'One more:\n<steps>\n1. Copy the ID\n</steps>' : undefined);

      await orchestrator.answerSteps(conv.id, alice.id, { done: [0] });
      await finish(conv.id);
      expect(said(conv)).toEqual(['user', '@Alice', '@Bob', 'user', '@Alice']);
      expect(conv.pause).toMatchObject({ askers: ['b', 'a'] });
      // Bob's card still waits for its own answer.
      orchestrator.tickStep(conv.id, bob.id, 1, true);
      expect(stepsOf(bob)).toMatchObject({ items: [{}, { done: true }] });
      expect(() => orchestrator.tickStep(conv.id, alice.id, 1, true)).toThrow(expect.objectContaining({ status: 409 }));

      fake.reply = undefined;
      await orchestrator.answerSteps(conv.id, bob.id, { done: [0, 1] });
      await finish(conv.id);
      expect(said(conv).slice(5)).toEqual(['user', '@Bob']);
      expect(told('Bob')).toEqual([false, true]);
      expect(conv.pause).toMatchObject({ askers: ['a'] });
      // The last one waiting: its answer goes on as any answer.
      await orchestrator.answerSteps(conv.id, agentMessages(conv).at(-2)!.id, { done: [0] });
      await finish(conv.id);
      expect(said(conv).slice(7)).toEqual(['user', '@Alice']);
      expect(conv.pause).toBeUndefined();
    });

    it('an answer in the message box still answers every agent that waits, and the card is no longer waited for', async () => {
      const conv = conversation({ mode: 'parallel', permission: 'read-only' });
      firstTurns(['Alice'], ['Bob']);
      await orchestrator.send(conv.id, 'set it up');
      await finish(conv.id);
      await orchestrator.send(conv.id, 'ANSWER: B, and I did the steps.');
      await finish(conv.id);
      expect(said(conv)).toEqual(['user', '@Alice', '@Bob', 'user', '@Alice', '@Bob']);
      expect(told('Alice')).toEqual([false, true]);
      expect(told('Bob')).toEqual([false, true]);
      expect(() => orchestrator.tickStep(conv.id, replyOf(conv, 'Alice').id, 0, true)).toThrow(expect.objectContaining({ status: 409 }));
    });
  });

  it('a branch from the steps reply waits for an answer of its own, with the ticks as they were', async () => {
    const { conv, reply } = await askedSteps();
    await orchestrator.answerSteps(conv.id, reply.id, { done: [0] });
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, reply.id);
    expect(branch.pause).toMatchObject({ askers: ['a'] });
    const copy = branch.messages.at(-1)!;
    expect(stepsOf(copy)).toMatchObject({ items: [{ done: true }, {}, {}] });
    expect(stepsOf(copy)).not.toHaveProperty('answer');
    orchestrator.tickStep(branch.id, copy.id, 1, true);
    expect(stepsOf(reply)).toHaveProperty('answer'); // the original is as it was
  });

  it('refuses steps that are not there and a note too long, and puts the card back when the answer cannot be posted', async () => {
    const { conv, reply } = await askedSteps();
    await expect(orchestrator.answerSteps(conv.id, reply.id, { done: [5] })).rejects.toMatchObject({ status: 400 });
    await expect(orchestrator.answerSteps(conv.id, reply.id, { done: [], stuckAt: 3 })).rejects.toMatchObject({ status: 400 });
    await expect(orchestrator.answerSteps(conv.id, reply.id, { done: [], note: 'x'.repeat(2001) })).rejects.toMatchObject({ status: 400 });
    orchestrator.tickStep(conv.id, reply.id, 1, true);
    const send = vi.spyOn(orchestrator, 'send').mockRejectedValueOnce(new Error('disk full'));
    await expect(orchestrator.answerSteps(conv.id, reply.id, { done: [0] })).rejects.toThrow('disk full');
    send.mockRestore();
    expect(stepsOf(reply)).toEqual({
      type: 'steps',
      items: [{ text: expect.any(String) }, { text: expect.any(String), done: true }, { text: expect.any(String) }],
    });
    expect(conv.pause).toBeDefined();
  });
});
