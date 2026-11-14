/*
 * Lead review: the lead agent reviewing the team's replies once it has answered — when it does and
 * when it does not, what it reads, its card, Stop, a failure, messages sent meanwhile, schedules and
 * branches; and lead review being the user's alone.
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
  setStore,
  settings,
  stateKeys,
  store,
  Store,
  textOf,
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

  it('never lets the lead ask for an approval, so it can take no directory lock while it reviews', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'edit', leadReview: true });
    await orchestrator.send(conv.id, 'one');
    await finish(conv.id);
    expect(reviewerCalls()).toHaveLength(1);
    expect(reviewerCalls()[0]).toMatchObject({ permission: 'read-only' });
    expect(reviewerCalls()[0]!.asksApproval).toBeUndefined();
  });

  it('stops a review under way when it is switched off; the run ends as usual and what waited starts', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'one');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    await orchestrator.send(conv.id, 'next');
    fake.reviewGate = undefined;
    orchestrator.setLeadReview(conv.id, false);
    await vi.waitFor(() => expect(agentMessages(conv)).toHaveLength(4));
    await finish(conv.id);
    // Its card says it stopped; no "Stopped" note, and the message that waited was answered.
    expect(reviews(conv).map((m) => m.status)).toEqual(['aborted']);
    expect(conv.messages.some((m) => m.author.kind === 'system' && textOf(m) === 'Stopped.')).toBe(false);
    expect(conv.queue ?? []).toHaveLength(0);
    expect(reviewerCalls()).toHaveLength(1);
    // Switched on again with nothing new to read, nothing more runs.
    orchestrator.setLeadReview(conv.id, true);
    expect(orchestrator.isRunning(conv.id)).toBe(false);
  });

  it('refuses the switch for a conversation being deleted', async () => {
    const conv = conversation({ mode: 'parallel' });
    const deleting = orchestrator.deleteConversation(conv.id);
    expect(() => orchestrator.setLeadReview(conv.id, true)).toThrow(expect.objectContaining({ status: 404 }));
    await deleting;
    expect(() => orchestrator.setLeadReview(conv.id, true)).toThrow(expect.objectContaining({ status: 404 }));
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
    // The card says it was stopped: no "Stopped" note after it.
    expect(conv.messages.at(-1)).toBe(card);
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

  it('starts a branch with the setting its conversation has when it is branched, not the one it had then', async () => {
    const conv = conversation({ mode: 'parallel' });
    await orchestrator.send(conv.id, 'one');
    await finish(conv.id);
    // Turned on after the reply the branch is made from: the branch has it on.
    orchestrator.setLeadReview(conv.id, true);
    const on = await orchestrator.branch(conv.id, replyOf(conv, 'Bob').id);
    expect(on.settings.leadReview).toBe(true);
    expect(new Store(db).get(on.id)!.settings.leadReview).toBe(true);
    // And off again: the next branch has it off.
    orchestrator.setLeadReview(conv.id, false);
    const off = await orchestrator.branch(conv.id, replyOf(conv, 'Bob').id);
    expect(off.settings.leadReview).toBeUndefined();
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

  it('copies the setting to the new conversation a schedule opens each time, as its other settings', async () => {
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
    expect(new Store(db).get(chat.id)!.settings.leadReview).toBe(true);
    expect(chat.messages.filter((m) => m.review)).toHaveLength(1);
    // Off in the schedule's conversation: off in the next one it opens.
    orchestrator.setLeadReview(conv.id, false);
    const next = await orchestrator.sendScheduled(conv.id);
    const other = store.get((next as { chatId: string }).chatId)!;
    await finish(other.id);
    expect(other.settings.leadReview).toBeUndefined();
    expect(other.messages.filter((m) => m.review)).toHaveLength(0);
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
    // Continue: the team goes on without a new question, and the branch is made from its replies.
    await orchestrator.send(conv.id, '');
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

describe('after the review', () => {
  const pair = JSON.stringify({
    choice: 'custom',
    name: 'Pair',
    mode: 'parallel',
    rounds: 1,
    agents: [
      { name: 'Alice', provider: 'claude', role: 'Build it' },
      { name: 'Bob', provider: 'claude', role: 'Check it' },
    ],
    reason: 'x',
  });
  const autoChat = () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true, autoConfirm: true, leadReview: true });
    conv.agents = [];
    store.saveMeta(conv);
    fake.leadReply = pair;
    return conv;
  };
  const leadCalls = () => calls.filter((c) => c.name === 'lead');

  it('has the lead agent design the team for a question written while it reviewed, as for any new question', async () => {
    const conv = autoChat();
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    expect(await orchestrator.send(conv.id, 'a brand new question')).toEqual({ queued: true });
    fake.reviewGate = undefined;
    release();
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(leadCalls()).toHaveLength(2);
    expect(leadCalls()[1]!.prompt).toContain('<question>\na brand new question\n</question>');
    expect(calls.map((c) => c.name).filter((n) => n === 'lead' || n === 'reviewer')).toEqual(['lead', 'reviewer', 'lead', 'reviewer']);
  });

  it('lets the members a question written while it reviewed @mentions answer it, with no new design', async () => {
    const conv = autoChat();
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    await orchestrator.send(conv.id, '@Alice one more thing');
    fake.reviewGate = undefined;
    release();
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(leadCalls()).toHaveLength(1);
    expect(agentMessages(conv).map((m) => m.agentName).sort()).toEqual(['Alice', 'Alice', 'Bob']);
  });

  it('designs the team for a question sent with "Skip the review and send now"', async () => {
    const conv = autoChat();
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    await orchestrator.send(conv.id, 'a brand new question');
    fake.reviewGate = undefined;
    await orchestrator.send(conv.id, '', undefined, true);
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(leadCalls()).toHaveLength(2);
  });

  it('says so when another conversation took the folder while it reviewed; a message written meanwhile starts when the user sends it', async () => {
    const first = conversation({ mode: 'roundtable', permission: 'edit', leadReview: true });
    const other = conversation({ mode: 'roundtable', permission: 'edit' });
    let releaseReview!: () => void;
    fake.reviewGate = new Promise((r) => (releaseReview = r));
    await orchestrator.send(first.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    // The other conversation takes the folder while the lead agent reviews.
    let releaseOther!: () => void;
    fake.gate = new Promise((r) => (releaseOther = r));
    await orchestrator.send(other.id, 'other');
    await orchestrator.send(first.id, 'next');
    fake.reviewGate = undefined;
    releaseReview();
    // Its run cannot start: a note says who is changing the folder, and the message keeps waiting.
    const locked = (m: ChatMessage) => m.author.kind === 'system' && m.parts.some((p) => p.type === 'text' && p.text.includes(project) && !p.text.includes('git'));
    await vi.waitFor(() => expect(first.messages.filter(locked)).toHaveLength(1));
    await finish(first.id);
    expect(first.queue).toHaveLength(1);
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    // Nothing starts it by itself: the user does (the queue tray's Send, or Continue).
    await new Promise((r) => setImmediate(r));
    expect(first.queue).toHaveLength(1);
    expect(orchestrator.isRunning(first.id)).toBe(false);
    await orchestrator.send(first.id, '');
    await finish(first.id);
    expect(first.queue ?? []).toHaveLength(0);
    expect(first.messages.filter((m) => m.author.kind === 'user').map((m) => m.parts[0]!.type === 'text' && m.parts[0]!.text)).toEqual(['first', 'next']);
    expect(reviewerCalls()).toHaveLength(2);
    expect(first.messages.filter(locked)).toHaveLength(1);
  });

  it('reads the latest question when turned on again, not everything since an old review', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', leadReview: true });
    await orchestrator.send(conv.id, 'one');
    await finish(conv.id);
    orchestrator.setLeadReview(conv.id, false);
    for (const q of ['two', 'three']) {
      await orchestrator.send(conv.id, q);
      await finish(conv.id);
    }
    orchestrator.setLeadReview(conv.id, true);
    await orchestrator.send(conv.id, 'four');
    await finish(conv.id);
    const recent = recentOf(reviewerCalls()[1]!.prompt);
    expect(recent).toContain('<message from="user">\nfour\n</message>');
    for (const q of ['one', 'two', 'three']) expect(recent).not.toContain(`<message from="user">\n${q}\n</message>`);
  });

  it('reviews a relay too, once the hand-offs are over', async () => {
    const conv = conversation({ mode: 'relay', permission: 'read-only', leadReview: true, maxHops: 3 });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'reviewer']);
    expect(reviews(conv)[0]!.review!.status).toBe('ready');
  });
});

describe('questions written during a review, and reviews stopped', () => {
  const pair = JSON.stringify({
    choice: 'custom',
    name: 'Pair',
    mode: 'parallel',
    rounds: 1,
    agents: [
      { name: 'Alice', provider: 'claude', role: 'Build it' },
      { name: 'Bob', provider: 'claude', role: 'Check it' },
    ],
    reason: 'x',
  });
  const autoChat = () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true, autoConfirm: true, leadReview: true });
    conv.agents = [];
    store.saveMeta(conv);
    fake.leadReply = pair;
    return conv;
  };
  const leadCalls = () => calls.filter((c) => c.name === 'lead');

  it('keeps a question written during a review a new question across a restart', async () => {
    const conv = autoChat();
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    await orchestrator.send(conv.id, 'a brand new question');
    orchestrator.stop(conv.id);
    await finish(conv.id);
    fake.reviewGate = undefined;
    // The server starts again: the queue comes back from the database, its mark with it.
    const restarted = new Store(db);
    setStore(restarted);
    setOrchestrator(new Orchestrator(restarted, new Hub(), settings, { context: async () => ({ available: ['claude'], catalog: [], presets: restarted.listPresets() }) }));
    const again = restarted.get(conv.id)!;
    expect(again.queue!.map((m) => m.duringReview)).toEqual([true]);
    await orchestrator.send(again.id, '');
    await vi.waitFor(() => expect(leadCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(again.id);
    expect(leadCalls()[1]!.prompt).toContain('a brand new question');
    // Posted, the mark is gone.
    expect(again.messages.find((m) => m.author.kind === 'user' && m.parts.some((p) => p.type === 'text' && p.text === 'a brand new question'))!.duringReview).toBeUndefined();
  });

  it("gives a question left by a stopped review to the current team with the schedule's message, with no design (nobody may be there to confirm one)", async () => {
    const conv = autoChat();
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    await orchestrator.send(conv.id, 'a brand new question');
    orchestrator.stop(conv.id);
    await finish(conv.id);
    fake.reviewGate = undefined;
    const team = conv.agents.map((a) => a.name);
    conv.schedule = {
      text: 'scheduled check',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: 0,
    };
    store.saveSchedule(conv);
    calls.length = 0;
    expect((await orchestrator.sendScheduled(conv.id)).result).toBe('sent');
    await finish(conv.id);
    // The current team answered both; the lead agent did not design, and no design waits.
    expect(leadCalls()).toHaveLength(0);
    expect(conv.agents.map((a) => a.name)).toEqual(team);
    expect(conv.queue ?? []).toHaveLength(0);
    expect(calls.filter((c) => team.includes(c.name))[0]!.prompt).toContain('a brand new question');
    expect(conv.messages.some((m) => m.plan?.awaitingConfirmation)).toBe(false);
  });

  it('keeps a question written during a review waiting, with no design, when another chat took the folder meanwhile', async () => {
    const first = conversation({ mode: 'roundtable', permission: 'edit', autoTeam: true, leadReview: true });
    const other = conversation({ mode: 'roundtable', permission: 'edit' });
    fake.leadReply = JSON.stringify({
      choice: 'custom',
      name: 'Solo',
      mode: 'roundtable',
      rounds: 1,
      agents: [{ name: 'Alice', provider: 'claude', role: 'Build it' }],
      reason: 'x',
    });
    let releaseReview!: () => void;
    fake.reviewGate = new Promise((r) => (releaseReview = r));
    // @mentions the team: no design for the first question.
    await orchestrator.send(first.id, '@Alice first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    let releaseOther!: () => void;
    fake.gate = new Promise((r) => (releaseOther = r));
    await orchestrator.send(other.id, 'other');
    await orchestrator.send(first.id, 'a new question');
    fake.reviewGate = undefined;
    releaseReview();
    // Main's note, and the question still waits: no design was made for a team that cannot start.
    const locked = (m: ChatMessage) => m.author.kind === 'system' && m.parts.some((p) => p.type === 'text' && p.text.includes(project) && !p.text.includes('git'));
    await vi.waitFor(() => expect(first.messages.filter(locked)).toHaveLength(1));
    await finish(first.id);
    expect(first.queue!.map((m) => m.duringReview)).toEqual([true]);
    expect(leadCalls()).toHaveLength(0);
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    // Sent once the folder is free: designed for, as a new question.
    await orchestrator.send(first.id, '');
    await vi.waitFor(() => expect(leadCalls()).toHaveLength(1), { timeout: 20_000 });
    await finish(first.id);
    expect(leadCalls()[0]!.prompt).toContain('a new question');
    expect(first.queue ?? []).toHaveLength(0);
  });

  it('drops the mark of a question written during a review when it is withdrawn', async () => {
    const conv = autoChat();
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    await orchestrator.send(conv.id, 'a new question');
    expect(conv.queue![0]!.duringReview).toBe(true);
    const back = orchestrator.withdraw(conv.id, conv.queue![0]!.id);
    expect(back.duringReview).toBeUndefined();
    expect(store.get(conv.id)!.queue ?? []).toHaveLength(0);
    fake.reviewGate = undefined;
    release();
    await finish(conv.id);
    // Nothing waits: no new design, no other run.
    expect(leadCalls()).toHaveLength(1);
    expect(reviewerCalls()).toHaveLength(1);
  });

  it("leaves a scheduled message that arrives during a review to the current team, and designs a team when the user wrote a new question too", async () => {
    const scheduled = (conv: Conversation) => {
      conv.schedule = {
        text: 'scheduled check',
        repeat: { kind: 'interval', hours: 1 },
        timeZone: 'UTC',
        lang: 'en',
        enabled: true,
        approvals: 'deny',
        missed: 'skip',
        newChat: false,
        updatedAt: Date.now(),
        nextRunAt: Date.now() + 3_600_000,
      };
      store.saveSchedule(conv);
    };
    for (const alsoAsks of [false, true]) {
      calls.length = 0;
      const conv = autoChat();
      let release!: () => void;
      fake.reviewGate = new Promise((r) => (release = r));
      await orchestrator.send(conv.id, 'first question');
      await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
      scheduled(conv);
      expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'queued' });
      expect(conv.queue![0]).toMatchObject({ scheduled: true });
      expect(conv.queue![0]!.duringReview).toBeUndefined();
      if (alsoAsks) await orchestrator.send(conv.id, 'a brand new question');
      fake.reviewGate = undefined;
      release();
      await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
      await finish(conv.id);
      expect(conv.queue ?? []).toHaveLength(0);
      // The scheduled message alone: the team that answered the last question answers it.
      expect(leadCalls()).toHaveLength(alsoAsks ? 2 : 1);
      if (alsoAsks) expect(leadCalls()[1]!.prompt).toContain('a brand new question');
      expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(4);
    }
  });

  it("gives a scheduled message and a question written during the review to the current team when a design would wait for confirmation, so the schedule is not held", async () => {
    // Auto team, asking before a design is used; the team is there already.
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true, leadReview: true });
    const team = conv.agents.map((a) => a.name);
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, `@${team[0]} first question`);
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    conv.schedule = {
      text: 'scheduled check',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: Date.now(),
      nextRunAt: Date.now() + 3_600_000,
    };
    store.saveSchedule(conv);
    expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'queued' });
    await orchestrator.send(conv.id, 'a brand new question');
    fake.reviewGate = undefined;
    release();
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    // No design waits for anyone: the current team answered both.
    expect(leadCalls()).toHaveLength(0);
    expect(conv.messages.some((m) => m.plan?.awaitingConfirmation)).toBe(false);
    expect(conv.queue ?? []).toHaveLength(0);
    expect(conv.agents.map((a) => a.name)).toEqual(team);
    // So the schedule's next time is sent, not skipped as "team not confirmed yet".
    expect((await orchestrator.sendScheduled(conv.id)).result).toBe('sent');
    await finish(conv.id);
  });

  it('gives them to the current team too when the user sends them with "Skip the review and send now", Send or Continue', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true, leadReview: true });
    const team = conv.agents.map((a) => a.name);
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, `@${team[0]} first question`);
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    conv.schedule = {
      text: 'scheduled check',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: Date.now(),
      nextRunAt: Date.now() + 3_600_000,
    };
    store.saveSchedule(conv);
    expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'queued' });
    await orchestrator.send(conv.id, 'a brand new question');
    fake.reviewGate = undefined;
    // Skip the review and send now: the review stops, and what waits goes out at once.
    await orchestrator.send(conv.id, '', undefined, true);
    await vi.waitFor(() => expect(conv.queue ?? []).toHaveLength(0), { timeout: 20_000 });
    await finish(conv.id);
    expect(leadCalls()).toHaveLength(0);
    expect(conv.messages.some((m) => m.plan?.awaitingConfirmation)).toBe(false);
    expect(conv.agents.map((a) => a.name)).toEqual(team);
    expect((await orchestrator.sendScheduled(conv.id)).result).toBe('sent');
    await finish(conv.id);
  });

  it('lets the members answer when one of the messages written during the review @mentions them', async () => {
    const conv = autoChat();
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    await orchestrator.send(conv.id, 'something else');
    await orchestrator.send(conv.id, '@Alice and you');
    fake.reviewGate = undefined;
    release();
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(leadCalls()).toHaveLength(1);
  });

  it('reads the latest question, not since a review stopped before other questions', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', leadReview: true });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'one');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    orchestrator.stop(conv.id);
    await finish(conv.id);
    fake.reviewGate = undefined;
    orchestrator.setLeadReview(conv.id, false);
    for (const q of ['two', 'three']) {
      await orchestrator.send(conv.id, q);
      await finish(conv.id);
    }
    orchestrator.setLeadReview(conv.id, true);
    await orchestrator.send(conv.id, 'four');
    await finish(conv.id);
    const recent = recentOf(reviewerCalls().at(-1)!.prompt);
    expect(recent).toContain('<message from="user">\nfour\n</message>');
    for (const q of ['one', 'two', 'three']) expect(recent).not.toContain(`<message from="user">\n${q}\n</message>`);
  });

  it('is stopped by shutting down, and none starts once the server is stopping', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', leadReview: true });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    orchestrator.stopAll();
    await finish(conv.id);
    expect(reviews(conv)[0]!.status).toBe('aborted');
    expect(reviewerCalls()).toHaveLength(1);
  });
});

describe("lead review is the user's to switch", () => {
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
  const answered = (conv: Conversation) => agentMessages(conv).filter((m) => m.status === 'done').length;

  it('is never turned on by a team design, whatever the lead agent replies, and its prompt says nothing of it', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true, autoConfirm: true });
    conv.agents = [];
    store.saveMeta(conv);
    fake.leadReply = design({ leadReview: true, leadReviewReason: 'Two members change files.' });
    await orchestrator.send(conv.id, 'build and check it');
    await vi.waitFor(() => expect(answered(conv)).toBe(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(leadCalls()[0]!.prompt).not.toMatch(/lead review|leadReview/i);
    expect(conv.messages.find((m) => m.plan)!.plan).not.toHaveProperty('leadReview');
    expect(conv.settings.leadReview).toBeUndefined();
    expect(reviewerCalls()).toHaveLength(0);
  });

  it('applies, once the user switches it, to the question being answered and every later one; designs leave it as it is', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true, autoConfirm: true });
    conv.agents = [];
    store.saveMeta(conv);
    fake.leadReply = design({ leadReview: false });
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'first');
    // Turned on while the team answers the first question: that question is reviewed.
    await vi.waitFor(() => expect(calls.filter((c) => c.name === 'Alice' || c.name === 'Bob')).toHaveLength(2), { timeout: 20_000 });
    orchestrator.setLeadReview(conv.id, true);
    fake.gate = Promise.resolve();
    release();
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    await finish(conv.id);
    // The next question gets a design of its own, which leaves it on, and is reviewed too.
    await orchestrator.send(conv.id, 'second');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(leadCalls()).toHaveLength(2);
    expect(conv.settings.leadReview).toBe(true);
    // Turned off, the questions after are not reviewed, whatever the lead agent's designs say.
    orchestrator.setLeadReview(conv.id, false);
    fake.leadReply = design({ leadReview: true });
    await orchestrator.send(conv.id, 'third');
    await vi.waitFor(() => expect(answered(conv)).toBe(6), { timeout: 20_000 });
    await finish(conv.id);
    expect(leadCalls()).toHaveLength(3);
    expect(reviewerCalls()).toHaveLength(2);
    expect(new Store(db).get(conv.id)!.settings.leadReview).toBeUndefined();
  });
});
