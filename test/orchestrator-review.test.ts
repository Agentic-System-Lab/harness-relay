/*
 * Lead review: the lead agent reviewing the team's replies once it has answered — when it does and
 * when it does not, what it reads, its card, Stop, a failure, messages sent meanwhile, and branches;
 * and the lead agent turning it on when it designs a team.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '../src/shared/types';
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
  root,
  setOrchestrator,
  settings,
  stateKeys,
  store,
  Store,
} from './orchestrator-harness';

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

    // Alice and Bob answer side by side (in either order), then the lead reviews.
    expect(calls.map((c) => c.name).sort()).toEqual(['Alice', 'Bob', 'reviewer']);
    expect(calls.at(-1)!.name).toBe('reviewer');
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

  it('reads only the latest question on its first review, when it is turned on mid-chat, with what came before as context', async () => {
    const conv = conversation({ mode: 'parallel' });
    await orchestrator.send(conv.id, 'old question');
    await finish(conv.id);
    orchestrator.setLeadReview(conv.id, true);
    await orchestrator.send(conv.id, 'new question');
    await finish(conv.id);
    const [call] = reviewerCalls();
    expect(recentOf(call!.prompt)).not.toContain('old question');
    expect(recentOf(call!.prompt)).toContain('new question');
    expect(call!.prompt).toMatch(/<conversation>\n\[User\]: old question/);
    expect(reviews(conv)[0]!.review!.replyIds).toEqual([replyOf(conv, 'Alice', 1).id, replyOf(conv, 'Bob', 1).id]);
  });

  it('is told what its last review said, so it does not say it again', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    fake.reviewReply = JSON.stringify({
      summary: 'Half done.',
      highlights: [{ kind: 'risk', reply: 2, note: 'Bob deletes a file.' }],
      nextSteps: [{ text: 'Back it up', by: 'user' }],
    });
    await orchestrator.send(conv.id, 'one');
    await finish(conv.id);
    expect(reviewerCalls()[0]!.prompt).not.toContain('<last_review>');
    await orchestrator.send(conv.id, 'two');
    await finish(conv.id);
    expect(reviewerCalls()[1]!.prompt).toContain(
      '<last_review>\nSummary: Half done.\n- risk (@Bob): Bob deletes a file.\n- next step for the user: Back it up\n</last_review>',
    );
  });

  it("gives the lead the members' worktrees in parallel mode, and the other working directories", async () => {
    const other = join(root, `other-${Math.random().toString(36).slice(2)}`);
    mkdirSync(other, { recursive: true });
    const conv = conversation({ mode: 'parallel', permission: 'edit', leadReview: true, extraCwds: [other] });
    await orchestrator.send(conv.id, 'work');
    await finish(conv.id);
    const call = reviewerCalls()[0]!;
    const alice = conv.worktrees.a!.map((w) => w.path);
    const bob = conv.worktrees.b!.map((w) => w.path);
    expect(alice.length).toBeGreaterThan(0);
    expect(call.addDirs?.[0]).toBe(other);
    for (const path of [...alice, ...bob]) expect(call.addDirs!.some((d) => d.startsWith(path))).toBe(true);
    expect(call.prompt).toContain('The team worked in parallel, each member in git worktrees of its own');
    expect(call.prompt).toMatch(new RegExp(`- @Alice: ${alice[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    // Sharing the working directory, the lead is told of no worktrees.
    const shared = conversation({ mode: 'roundtable', permission: 'edit', leadReview: true });
    await orchestrator.send(shared.id, 'work');
    await finish(shared.id);
    expect(reviewerCalls()[1]!.prompt).not.toContain('worktrees of its own');
    expect(reviewerCalls()[1]!.addDirs).toBeUndefined();
  });

  it('leaves the working directory free while it reviews: another conversation may write there', async () => {
    const first = conversation({ mode: 'roundtable', permission: 'edit', leadReview: true });
    const second = conversation({ mode: 'roundtable', permission: 'edit' });
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    await orchestrator.send(first.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    // While the team replied, the folder was the first conversation's; now the second may write in it.
    await expect(orchestrator.send(second.id, 'second')).resolves.toEqual({ queued: false });
    await finish(second.id);
    release();
    await finish(first.id);
    expect(reviews(first)[0]!.review!.status).toBe('ready');
  });

  it('counts as work under way while it reviews, links its session, and is stopped when the conversation is deleted', async () => {
    const links: string[] = [];
    setOrchestrator(
      new Orchestrator(store, new Hub(), settings, { context: async () => ({ available: ['claude'], catalog: [], presets: store.listPresets() }) }, {
        schedule: () => undefined,
        link: (c: Conversation, provider: string, sessionId: string) => links.push(`${c.id} ${provider}:${sessionId}`),
      }),
    );
    const conv = conversation({ mode: 'parallel', leadReview: true });
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    expect(orchestrator.busy()).toBe(1);
    release();
    await finish(conv.id);
    expect(orchestrator.busy()).toBe(0);
    expect(links).toContain(`${conv.id} claude:reviewer-session`);

    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'again');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2));
    await orchestrator.deleteConversation(conv.id);
    expect(orchestrator.isRunning(conv.id)).toBe(false);
    expect(store.get(conv.id)).toBeUndefined();
  });

  it('reviews once after a message that waited for a run of its own, reading both runs', async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    let releaseAlice!: () => void;
    fake.gates.Alice = new Promise((r) => (releaseAlice = r));
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(calls.some((c) => c.name === 'Alice')).toBe(true));
    // For Alice only: Bob's turn in this run does not take it, so it waits for a run of its own.
    await orchestrator.send(conv.id, '@Alice and another thing');
    delete fake.gates.Alice;
    releaseAlice();
    await vi.waitFor(() => expect(calls.filter((c) => c.name === 'Alice')).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(reviewerCalls()).toHaveLength(1);
    const recent = recentOf(reviewerCalls()[0]!.prompt);
    expect(recent).toContain('<message from="user">\nfirst\n</message>');
    expect(recent).toContain('@Alice and another thing');
    expect(reviews(conv)).toHaveLength(1);
  });

  it('reads again from the earlier boundary after a retry dropped its review', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    await orchestrator.send(conv.id, 'one');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'two');
    await finish(conv.id);
    expect(reviews(conv)).toHaveLength(2);
    // Retrying Bob's second reply drops it and the review after it.
    await orchestrator.retry(conv.id, replyOf(conv, 'Bob', 1).id);
    await finish(conv.id);
    expect(reviews(conv)).toHaveLength(2);
    const recent = recentOf(reviewerCalls()[2]!.prompt);
    expect(recent).toContain('<message from="user">\ntwo\n</message>');
    expect(recent).not.toContain('<message from="user">\none\n</message>');
  });

  it('can be turned on and off at any time, also while the team replies, and is decided once the team has answered', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(calls.filter((c) => c.name !== 'reviewer')).toHaveLength(2));
    expect(orchestrator.setLeadReview(conv.id, false).settings.leadReview).toBeUndefined();
    release();
    await finish(conv.id);
    expect(reviewerCalls()).toHaveLength(0);
    expect(new Store(db).get(conv.id)!.settings.leadReview).toBeUndefined();
    expect(() => orchestrator.setLeadReview('nope', true)).toThrow();
  });

  it('copies the setting to the new conversation a schedule opens each time', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    conv.schedule = {
      text: 'scheduled check',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: true,
      updatedAt: 0,
    };
    store.saveSchedule(conv);
    const sent = await orchestrator.sendScheduled(conv.id);
    expect(sent.result).toBe('sent');
    const chat = store.get((sent as { chatId: string }).chatId)!;
    await finish(chat.id);
    expect(chat.settings.leadReview).toBe(true);
    expect(chat.messages.filter((m) => m.review)).toHaveLength(1);
  });
});

describe('lead review, stopped or branched before it was ready', () => {
  it('is stopped by "Skip the review and send now", whose message the team answers; the next review reads from where the stopped one started', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', leadReview: true });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    const stopped = reviews(conv)[0]!;
    expect(stopped.review!.fromId).toBe(conv.messages.find((m) => m.author.kind === 'user')!.id);
    fake.reviewGate = undefined;
    // The tray's button: stop the run (the review) and send what waits, now.
    await orchestrator.send(conv.id, 'second', undefined, true);
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(stopped.status).toBe('aborted');
    const recent = recentOf(reviewerCalls()[1]!.prompt);
    expect(recent).toContain('<message from="user">\nfirst\n</message>');
    expect(recent).toContain('<message from="user">\nsecond\n</message>');
    expect(reviews(conv)[1]!.review!.status).toBe('ready');
  });

  it("keeps, in a branch, where a review that failed started: the branch's next review reads from there", async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', leadReview: true });
    fake.reviewFail = 'model overloaded';
    await orchestrator.send(conv.id, 'one');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'two');
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, replyOf(conv, 'Bob', 1).id);
    const copied = branch.messages.find((m) => m.review)!.review!;
    const one = branch.messages.find((m) => m.author.kind === 'user')!;
    expect(copied.fromId).toBe(one.id);
    fake.reviewFail = undefined;
    await orchestrator.send(branch.id, 'three');
    await finish(branch.id);
    const recent = recentOf(reviewerCalls().at(-1)!.prompt);
    expect(recent).toContain('<message from="user">\none\n</message>');
    expect(recent).toContain('<message from="user">\nthree\n</message>');
  });
});

describe('the lead agent turning lead review on when it designs a team', () => {
  const design = (more: Record<string, unknown> = {}) =>
    JSON.stringify({
      choice: 'custom',
      name: 'Pair',
      mode: 'parallel',
      rounds: 1,
      agents: [
        { name: 'Alice', provider: 'claude', role: 'Build it' },
        { name: 'Bob', provider: 'claude', role: 'Check it' },
      ],
      reason: 'x',
      ...more,
    });
  const leadCalls = () => calls.filter((c) => c.name === 'lead');
  const planOf = (conv: Conversation) => conv.messages.find((m) => m.plan)!.plan!;

  it('is offered while it is off, and turned on at once with the design, which says why; the team is then reviewed once', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true, autoConfirm: true });
    conv.agents = [];
    store.saveMeta(conv);
    fake.leadReply = design({ leadReview: true, leadReviewReason: '  Two members change files.  ' });
    await orchestrator.send(conv.id, 'build and check it');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    await finish(conv.id);
    expect(leadCalls()[0]!.prompt).toContain('Lead review is off in this conversation');
    expect(leadCalls()[0]!.prompt).toContain('"leadReview": true, "leadReviewReason"');
    expect(planOf(conv).leadReview).toEqual({ reason: 'Two members change files.' });
    expect(conv.settings.leadReview).toBe(true);
    expect(new Store(db).get(conv.id)!.settings.leadReview).toBe(true);
    // No review of the design run itself: one, after the team answered.
    expect(calls.map((c) => c.name).sort()).toEqual(['Alice', 'Bob', 'lead', 'reviewer']);
    expect([calls[0]!.name, calls.at(-1)!.name]).toEqual(['lead', 'reviewer']);
    expect(reviews(conv)).toHaveLength(1);
  });

  it('turns it on while the design waits for confirmation, and keeps it when the user declines the team', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true });
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    const first = conv.messages.find((m) => m.plan)!;
    orchestrator.declinePlan(conv.id, first.id);
    // The current team answers in a run that starts in the background.
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(2));
    await finish(conv.id);
    expect(conv.settings.leadReview).toBeUndefined();
    fake.leadReply = design({ leadReview: true });
    await orchestrator.send(conv.id, 'second, harder');
    await finish(conv.id);
    const plan = conv.messages.findLast((m) => m.plan)!;
    expect(plan.plan!.awaitingConfirmation).toBe(true);
    expect(plan.plan!.leadReview).toEqual({});
    expect(conv.settings.leadReview).toBe(true);
    orchestrator.declinePlan(conv.id, plan.id);
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    await finish(conv.id);
    expect(conv.settings.leadReview).toBe(true);
  });

  it('is not offered, nor touched, when it is on already, and the lead cannot turn it off', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true, autoConfirm: true, leadReview: true });
    conv.agents = [];
    store.saveMeta(conv);
    fake.leadReply = design({ leadReview: false });
    await orchestrator.send(conv.id, 'build it');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    await finish(conv.id);
    expect(leadCalls()[0]!.prompt).not.toContain('Lead review is off');
    expect(leadCalls()[0]!.prompt).not.toContain('leadReviewReason');
    expect(planOf(conv).leadReview).toBeUndefined();
    expect(conv.settings.leadReview).toBe(true);

    // Asked to turn it on while it is on: nothing on the card.
    const again = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true, autoConfirm: true, leadReview: true });
    again.agents = [];
    store.saveMeta(again);
    fake.leadReply = design({ leadReview: true, leadReviewReason: 'x' });
    await orchestrator.send(again.id, 'build it');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(again.id);
    expect(planOf(again).leadReview).toBeUndefined();
  });
});
