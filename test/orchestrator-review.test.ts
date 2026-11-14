/*
 * Lead review: the lead agent reviewing the team's replies once it has answered — when it does and
 * when it does not, what it reads, its card, Stop, a failure, messages sent meanwhile, and branches.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '../src/shared/types';
import { agentMessages, calls, conversation, db, fake, finish, orchestrator, stateKeys, Store } from './orchestrator-harness';

const reviews = (conv: Conversation) => conv.messages.filter((m) => m.review);
const reviewerCalls = () => calls.filter((c) => c.name === 'reviewer');
/** What a review prompt says was said since the last review. */
const recentOf = (prompt: string) => /<recent>\n([\s\S]*?)\n<\/recent>/.exec(prompt)![1]!;
const replyOf = (conv: Conversation, name: string, nth = 0) => agentMessages(conv).filter((m) => m.agentName === name)[nth]!;

describe('lead review', () => {
  it("has the lead agent review the team's replies once the team has answered, read-only, and shows its review on a card", async () => {
    const conv = conversation({ mode: 'parallel', permission: 'edit', leadReview: true });
    fake.reviewReply = JSON.stringify({
      summary: 'Both answered.',
      highlights: [
        { kind: 'risk', reply: 2, quote: 'Bob done', note: 'Bob changed shared.txt.' },
        // Words Alice never wrote: the note stays, the quote goes.
        { kind: 'verify', reply: 1, quote: 'all tests pass', note: 'Nothing was run.' },
        { kind: 'nonsense', note: 'About both replies.' },
        { kind: 'risk', reply: 1 }, // no note: left out
      ],
      nextSteps: [
        { text: 'Ask Bob for tests', by: 'team', message: '@Bob please add tests' },
        { text: 'Try it yourself', by: 'user' },
        { text: '' },
      ],
    });
    await orchestrator.send(conv.id, 'hello team');
    await finish(conv.id);

    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob', 'reviewer']);
    const call = reviewerCalls()[0]!;
    expect(call.stateKey).toBe(stateKeys.review(conv.id));
    expect(call.permission).toBe('read-only');
    const recent = recentOf(call.prompt);
    expect(recent).toContain('<message from="user">\nhello team\n</message>');
    expect(recent).toContain('<reply n="1" from="@Alice (Claude Code)">\nAlice done');
    expect(recent).toContain('<reply n="2" from="@Bob (Claude Code)">\nBob done');
    // What each turn changed.
    expect(recent).toMatch(/Files this turn changed: .*Bob\.txt \(A\)/);

    const [card] = reviews(conv);
    expect(conv.messages.at(-1)).toBe(card);
    expect(card!.author.kind).toBe('system');
    expect(card!.status).toBe('done');
    expect(card!.meta?.costUsd).toBe(0.03);
    const review = card!.review!;
    expect(review.status).toBe('ready');
    expect(review.lead.provider).toBe('claude');
    expect(review.summary).toBe('Both answered.');
    expect(review.replyIds).toEqual([replyOf(conv, 'Alice').id, replyOf(conv, 'Bob').id]);
    expect(review.highlights).toEqual([
      { kind: 'risk', note: 'Bob changed shared.txt.', messageId: replyOf(conv, 'Bob').id, agentName: 'Bob', quote: 'Bob done' },
      { kind: 'verify', note: 'Nothing was run.', messageId: replyOf(conv, 'Alice').id, agentName: 'Alice' },
      { kind: 'note', note: 'About both replies.' },
    ]);
    expect(review.nextSteps).toEqual([
      { text: 'Ask Bob for tests', by: 'team', message: '@Bob please add tests' },
      { text: 'Try it yourself', by: 'user' },
    ]);

    // Saved with the conversation, and the setting with it.
    const saved = new Store(db).get(conv.id)!;
    expect(saved.settings.leadReview).toBe(true);
    expect(saved.messages.at(-1)!.review).toEqual(review);
  });

  it('does not review when the conversation does not ask for it', async () => {
    const conv = conversation({ mode: 'parallel' });
    await orchestrator.send(conv.id, 'hello');
    await finish(conv.id);
    expect(reviewerCalls()).toHaveLength(0);
    expect(reviews(conv)).toHaveLength(0);
  });

  it("waits while the team waits for the user's answer, then reviews everything since, the question included", async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    fake.asking.add('Alice');
    await orchestrator.send(conv.id, 'which one?');
    await finish(conv.id);
    expect(conv.pause).toBeDefined();
    expect(reviewerCalls()).toHaveLength(0);

    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(reviewerCalls()).toHaveLength(1);
    const recent = recentOf(reviewerCalls()[0]!.prompt);
    expect(recent).toContain('which one?');
    expect(recent).toContain('<reply n="1" from="@Alice (Claude Code)" asked_the_user="yes">\nAlice asks: A or B?');
    expect(recent).toContain('ANSWER: A');
    expect(recent).toContain('<reply n="3" from="@Bob (Claude Code)">');
  });

  it('reads only what was said since its last review, with the conversation before it as context', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'second question');
    await finish(conv.id);
    const [, second] = reviewerCalls();
    expect(recentOf(second!.prompt)).toContain('second question');
    expect(recentOf(second!.prompt)).not.toContain('first question');
    expect(second!.prompt).toMatch(/<conversation>\n\[User\]: first question/);
    expect(reviews(conv)).toHaveLength(2);
  });

  it('says why on its card when it fails, and reads those replies again next time', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    fake.reviewFail = 'model overloaded';
    await orchestrator.send(conv.id, 'one');
    await finish(conv.id);
    expect(reviews(conv)[0]!.review).toMatchObject({ status: 'failed', error: 'model overloaded' });
    expect(reviews(conv)[0]!.status).toBe('done');

    fake.reviewFail = undefined;
    fake.reviewReply = 'Looks fine to me.'; // not JSON
    await orchestrator.send(conv.id, 'two');
    await finish(conv.id);
    expect(recentOf(reviewerCalls()[1]!.prompt)).toContain('one');
    // Why, in the user's language.
    expect(reviews(conv)[1]!.review).toMatchObject({ status: 'failed', error: expect.stringContaining('JSON') });

    fake.reviewReply = '{"summary": "ok", "highlights": [], "nextSteps": []}';
    await orchestrator.send(conv.id, 'three');
    await finish(conv.id);
    const recent = recentOf(reviewerCalls()[2]!.prompt);
    for (const q of ['one', 'two', 'three']) expect(recent).toContain(`<message from="user">\n${q}\n</message>`);
    expect(reviews(conv)[2]!.review!.status).toBe('ready');
  });

  it('is stopped by Stop, which leaves its card stopped and the replies to the next review', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    expect(orchestrator.isRunning(conv.id)).toBe(true);
    expect(reviews(conv)[0]!.review!.status).toBe('reviewing');
    orchestrator.stop(conv.id);
    await finish(conv.id);
    const card = reviews(conv)[0]!;
    expect(card.status).toBe('aborted');
    expect(card.review!.status).toBe('reviewing');
  });

  it('keeps a message sent while it reviews waiting, unmarked, and the team answers it after the review', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    expect(await orchestrator.send(conv.id, 'next one')).toEqual({ queued: true });
    // Not sent while the team was replying: the team had answered.
    expect(conv.queue![0]!.queued).toBeUndefined();
    fake.reviewGate = undefined;
    release();
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    const said = conv.messages.flatMap((m: ChatMessage) =>
      m.review ? ['review'] : m.author.kind === 'user' ? ['user'] : m.author.kind === 'agent' ? [m.agentName] : [],
    );
    expect(said).toEqual(['user', 'Alice', 'Bob', 'review', 'user', 'Alice', 'Bob', 'review']);
  });

  it("does not review a run in which nobody answered (every member passed or failed)", async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    fake.fail = () => new Error('rate limited');
    await orchestrator.send(conv.id, 'hello');
    await finish(conv.id);
    expect(reviewerCalls()).toHaveLength(0);
  });

  it("points a branch's copied review at the copies of the replies it is about", async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    fake.reviewReply = JSON.stringify({ highlights: [{ kind: 'risk', reply: 1, quote: 'Alice done', note: 'Look.' }], nextSteps: [] });
    await orchestrator.send(conv.id, 'one');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'two');
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, replyOf(conv, 'Bob', 1).id);
    const copied = branch.messages.find((m) => m.review)!.review!;
    const alice = branch.messages.find((m) => m.agentName === 'Alice')!;
    expect(alice.id).not.toBe(replyOf(conv, 'Alice').id);
    expect(copied.highlights![0]!.messageId).toBe(alice.id);
    expect(copied.replyIds).toEqual([alice.id, branch.messages.find((m) => m.agentName === 'Bob')!.id]);
  });
});
