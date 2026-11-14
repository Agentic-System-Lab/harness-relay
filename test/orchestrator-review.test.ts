/*
 * Lead review: the lead agent reviewing the team's replies once it has answered — when it does and
 * when it does not, what it reads, its card, Stop, a failure, messages sent meanwhile, schedules and
 * branches; lead review being the user's alone; and when the user is told that the team finished
 * (push notifications) while the lead reviews.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PushSubscriptionRecord } from '../src/server/push';
import type { AlertPayload, ChatMessage, Conversation } from '../src/shared/types';
import {
  agentMessages,
  agents,
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
  withLang,
} from './orchestrator-harness';
import { slow } from './timeouts';

const reviews = (conv: Conversation) => conv.messages.filter((m) => m.review);
const reviewerCalls = () => calls.filter((c) => c.name === 'reviewer');
/** What a review prompt says was said since the last review. */
const recentOf = (prompt: string) => /<recent>\n([\s\S]*?)\n<\/recent>/.exec(prompt)![1]!;
const replyOf = (conv: Conversation, name: string, nth = 0) => agentMessages(conv).filter((m) => m.agentName === name)[nth]!;
const userTexts = (conv: Conversation) => conv.messages.filter((m) => m.author.kind === 'user').map(textOf);
const stoppedNote = (conv: Conversation) => conv.messages.some((m) => m.author.kind === 'system' && textOf(m) === 'Stopped.');
/** Give the conversation a schedule that sends in it (not in a new chat), its next time an hour away. */
const scheduleIn = (conv: Conversation) => {
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
    // A schedule's message comes due meanwhile: it waits for the review (what the user sends stops it).
    scheduleIn(conv);
    expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'queued' });
    fake.reviewGate = undefined;
    orchestrator.setLeadReview(conv.id, false);
    await vi.waitFor(() => expect(agentMessages(conv)).toHaveLength(4));
    await finish(conv.id);
    // Its card says it stopped; no "Stopped" note, and the message that waited was answered.
    expect(reviews(conv).map((m) => m.status)).toEqual(['aborted']);
    expect(stoppedNote(conv)).toBe(false);
    expect(conv.queue ?? []).toHaveLength(0);
    expect(userTexts(conv)).toEqual(['one', 'scheduled check']);
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

  it('is stopped by a message sent while it reviews, which goes at once; the team answers it and the next review reads both', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    fake.reviewGate = undefined;
    // Not queued: the review stops and the message is sent now, as with "Skip the review and send now".
    expect(await orchestrator.send(conv.id, 'next one')).toEqual({ queued: false });
    expect(conv.queue ?? []).toHaveLength(0);
    expect(reviews(conv)[0]!.status).toBe('aborted');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    const said = conv.messages.flatMap((m: ChatMessage) =>
      m.review ? ['review'] : m.author.kind === 'user' ? ['user'] : m.author.kind === 'agent' ? [m.agentName] : [],
    );
    expect(said).toEqual(['user', 'Alice', 'Bob', 'review', 'user', 'Alice', 'Bob', 'review']);
    // The stopped card says so: no "Stopped" note. The next review reads from where it started.
    expect(stoppedNote(conv)).toBe(false);
    const recent = recentOf(reviewerCalls()[1]!.prompt);
    expect(recent).toContain('<message from="user">\nfirst\n</message>');
    expect(recent).toContain('<message from="user">\nnext one\n</message>');
    expect(reviews(conv)[1]!.review).toMatchObject({ status: 'ready', replyIds: agentMessages(conv).map((m) => m.id) });
  });

  it('is stopped by a message of files alone too, but not by Continue, which waits for it', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    // Nothing to send: the conversation is busy, and the review goes on.
    await expect(orchestrator.send(conv.id, '')).rejects.toMatchObject({ status: 409 });
    expect(reviews(conv)[0]!.review!.status).toBe('reviewing');
    expect(orchestrator.isRunning(conv.id)).toBe(true);
    fake.reviewGate = undefined;
    expect(await orchestrator.send(conv.id, '', [{ name: 'notes.txt', mimeType: 'text/plain', data: 'aGk=' }])).toEqual({ queued: false });
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(reviews(conv).map((m) => m.status)).toEqual(['aborted', 'done']);
    expect(recentOf(reviewerCalls()[1]!.prompt)).toContain('(Attached files: notes.txt)');
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
  it('is stopped by "Skip the review and send now", which sends what waits (a schedule\'s message) to the team; the next review reads from where the stopped one started', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', leadReview: true });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    const stopped = reviews(conv)[0]!;
    expect(stopped.review!.fromId).toBe(conv.messages.find((m) => m.author.kind === 'user')!.id);
    scheduleIn(conv);
    expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'queued' });
    fake.reviewGate = undefined;
    // The tray's button: stop the run (the review) and send what waits, now.
    expect(await orchestrator.send(conv.id, '', undefined, true)).toEqual({ queued: false });
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(stopped.status).toBe('aborted');
    expect(conv.queue ?? []).toHaveLength(0);
    expect(userTexts(conv)).toEqual(['first', 'scheduled check']);
    const recent = recentOf(reviewerCalls()[1]!.prompt);
    expect(recent).toContain('<message from="user">\nfirst\n</message>');
    expect(recent).toContain('<message from="user">\nscheduled check\n</message>');
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

  it('has the lead agent design the team for a message sent while it reviews (Enter or Cmd+Enter), which stops the review first, as for any new question', async () => {
    for (const interrupt of [false, true]) {
      calls.length = 0;
      const conv = autoChat();
      fake.reviewGate = new Promise(() => {});
      await orchestrator.send(conv.id, 'first question');
      await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
      fake.reviewGate = undefined;
      expect(await orchestrator.send(conv.id, 'a brand new question', undefined, interrupt)).toEqual({ queued: false });
      await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
      await finish(conv.id);
      expect(reviews(conv).map((m) => m.status)).toEqual(['aborted', 'done']);
      expect(leadCalls()).toHaveLength(2);
      expect(leadCalls()[1]!.prompt).toContain('<question>\na brand new question\n</question>');
      expect(calls.map((c) => c.name).filter((n) => n === 'lead' || n === 'reviewer')).toEqual(['lead', 'reviewer', 'lead', 'reviewer']);
      // The next review reads from where the stopped one started.
      expect(recentOf(reviewerCalls()[1]!.prompt)).toContain('<message from="user">\nfirst question\n</message>');
    }
  });

  it('lets the members a message sent while it reviews @mentions answer it at once, with no new design', async () => {
    const conv = autoChat();
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    fake.reviewGate = undefined;
    expect(await orchestrator.send(conv.id, '@Alice one more thing')).toEqual({ queued: false });
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(reviews(conv)[0]!.status).toBe('aborted');
    expect(leadCalls()).toHaveLength(1);
    expect(agentMessages(conv).map((m) => m.agentName).sort()).toEqual(['Alice', 'Alice', 'Bob']);
  });

  it('refuses a message sent while it reviews when another conversation took the folder meanwhile, and goes on reviewing', async () => {
    const first = conversation({ mode: 'roundtable', permission: 'edit', leadReview: true });
    const other = conversation({ mode: 'roundtable', permission: 'edit' });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(first.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    fake.reviewGate = undefined;
    // The other conversation takes the folder while the lead agent reviews.
    let releaseOther!: () => void;
    fake.gate = new Promise((r) => (releaseOther = r));
    await orchestrator.send(other.id, 'other');
    // Its run could not start: refused, saying who is changing the folder, and the review goes on.
    await expect(withLang('en', () => orchestrator.send(first.id, 'next'))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('is changing'),
    });
    expect(orchestrator.isRunning(first.id)).toBe(true);
    expect(reviews(first)[0]!.review!.status).toBe('reviewing');
    expect(first.queue ?? []).toHaveLength(0);
    expect(userTexts(first)).toEqual(['first']);
    // Stop ends it; once the folder is free, the message is sent and reviewed from where it started.
    orchestrator.stop(first.id);
    await finish(first.id);
    expect(stoppedNote(first)).toBe(false);
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await orchestrator.send(first.id, 'next');
    await finish(first.id);
    expect(userTexts(first)).toEqual(['first', 'next']);
    expect(reviewerCalls()).toHaveLength(2);
    const recent = recentOf(reviewerCalls()[1]!.prompt);
    expect(recent).toContain('<message from="user">\nfirst\n</message>');
    expect(recent).toContain('<message from="user">\nnext\n</message>');
  });

  it('refuses "Skip the review and send now" too when another conversation took the folder, and goes on reviewing', async () => {
    const first = conversation({ mode: 'roundtable', permission: 'edit', leadReview: true });
    const other = conversation({ mode: 'roundtable', permission: 'edit' });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(first.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    scheduleIn(first);
    expect(await orchestrator.sendScheduled(first.id)).toEqual({ result: 'queued' });
    let releaseOther!: () => void;
    fake.gate = new Promise((r) => (releaseOther = r));
    await orchestrator.send(other.id, 'other');
    // The tray's button: nothing typed, what waits sent now.
    await expect(withLang('en', () => orchestrator.send(first.id, '', undefined, true))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('is changing'),
    });
    expect(reviews(first)[0]!.review!.status).toBe('reviewing');
    expect(first.queue).toHaveLength(1);
    fake.reviewGate = undefined;
    orchestrator.stop(first.id);
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await finish(first.id);
  });

  it('keeps the folder while it stops the review for a message, so another conversation cannot take it meanwhile', async () => {
    const first = conversation({ mode: 'roundtable', permission: 'edit', leadReview: true });
    const other = conversation({ mode: 'roundtable', permission: 'edit' });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(first.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    fake.reviewGate = undefined;
    // Both at once: the message that stops the review holds the folder before it does.
    const mine = orchestrator.send(first.id, 'next');
    const theirs = withLang('en', () => orchestrator.send(other.id, 'other'));
    await expect(theirs).rejects.toMatchObject({ status: 409, message: expect.stringContaining('is changing') });
    await expect(mine).resolves.toEqual({ queued: false });
    await finish(first.id);
    expect(userTexts(first)).toEqual(['first', 'next']);
    expect(reviews(first).map((m) => m.review!.status)).toEqual(['reviewing', 'ready']);
    expect(reviews(first)[0]!.status).toBe('aborted');
    // Once its run is over, the folder is free again.
    await orchestrator.send(other.id, 'other');
    await finish(other.id);
  });

  it('reads, after a restart, from where a review stopped before it started', async () => {
    const conv = conversation({ mode: 'parallel', leadReview: true });
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'one');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    orchestrator.stop(conv.id);
    await finish(conv.id);
    fake.reviewGate = undefined;
    // The server starts again: the stopped card comes back with where it started reading.
    const restarted = new Store(db);
    setStore(restarted);
    setOrchestrator(new Orchestrator(restarted, new Hub(), settings, { context: async () => ({ available: ['claude'], catalog: [], presets: restarted.listPresets() }) }));
    const again = restarted.get(conv.id)!;
    expect(reviews(again)[0]!.status).toBe('aborted');
    expect(reviews(again)[0]!.review!.fromId).toBe(again.messages.find((m) => m.author.kind === 'user')!.id);
    await orchestrator.send(again.id, 'two');
    await finish(again.id);
    const recent = recentOf(reviewerCalls().at(-1)!.prompt);
    expect(recent).toContain('<message from="user">\none\n</message>');
    expect(recent).toContain('<message from="user">\ntwo\n</message>');
    expect(reviews(again).at(-1)!.review!.status).toBe('ready');
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

describe('schedules during a review, and Retry and Edit after a stopped one', () => {
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

  it("leaves a schedule's message that comes due during a review to the current team: queued unmarked, answered after the review with no design, and reviewed", async () => {
    const conv = autoChat();
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    scheduleIn(conv);
    expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'queued' });
    // Not marked as sent while the team replied: the team had answered.
    expect(conv.queue![0]).toMatchObject({ scheduled: true });
    expect(conv.queue![0]!.queued).toBeUndefined();
    fake.reviewGate = undefined;
    release();
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(conv.queue ?? []).toHaveLength(0);
    // The team that answered the last question answers it, once the review is done: no design.
    expect(leadCalls()).toHaveLength(1);
    expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(4);
    expect(reviews(conv).map((m) => m.review!.status)).toEqual(['ready', 'ready']);
    const recent = recentOf(reviewerCalls()[1]!.prompt);
    expect(recent).toContain('<message from="user">\nscheduled check\n</message>');
    expect(recent).not.toContain('<message from="user">\nfirst question\n</message>');
  });

  it("sends a schedule's message that waits for a review with the message the user sends meanwhile, which stops the review", async () => {
    const conv = autoChat();
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first question');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: 20_000 });
    scheduleIn(conv);
    expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'queued' });
    fake.reviewGate = undefined;
    // Sent now, after what waited: a new question, whose team the lead agent designs.
    expect(await orchestrator.send(conv.id, 'a brand new question')).toEqual({ queued: false });
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(conv.id);
    expect(conv.queue ?? []).toHaveLength(0);
    expect(userTexts(conv)).toEqual(['first question', 'scheduled check', 'a brand new question']);
    expect(leadCalls()).toHaveLength(2);
    expect(leadCalls()[1]!.prompt).toContain('a brand new question');
    expect(reviews(conv).map((m) => m.status)).toEqual(['aborted', 'done']);
    const recent = recentOf(reviewerCalls()[1]!.prompt);
    for (const q of ['first question', 'scheduled check', 'a brand new question']) expect(recent).toContain(`<message from="user">\n${q}\n</message>`);
  });

  it("tries a schedule's message again later, rather than queue it into a design that will wait for confirmation", async () => {
    // Auto team, asking before a design is used; the team is there already.
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true });
    fake.leadReply = JSON.stringify({ choice: 'custom', name: 'Pair', mode: 'parallel', rounds: 1, agents: [{ name: 'Alice', provider: 'claude', role: 'Build it' }], reason: 'x' });
    // A new question: the lead agent designs a team for it (held until the test lets it go).
    let releaseLead!: () => void;
    fake.leadGate = new Promise((r) => (releaseLead = r));
    await orchestrator.send(conv.id, 'a brand new question');
    await vi.waitFor(() => expect(leadCalls()).toHaveLength(1), { timeout: 20_000 });
    scheduleIn(conv);
    // Not queued into the design's question: tried again later.
    expect(await orchestrator.sendScheduled(conv.id)).toMatchObject({ result: 'busy' });
    expect(conv.queue ?? []).toHaveLength(0);
    fake.leadGate = undefined;
    releaseLead();
    await finish(conv.id);
    // The design waits for the user, and its question has no schedule's message in it.
    const plan = conv.messages.findLast((m) => m.plan)!;
    expect(plan.plan!.awaitingConfirmation).toBe(true);
    expect(leadCalls()[0]!.prompt).not.toContain('scheduled check');
    expect(userTexts(conv)).toEqual(['a brand new question']);
  });

  it('reviews a Retry and an Edit after a stopped review, reading their replies and those the stopped reviews left', async () => {
    for (const how of ['retry', 'edit'] as const) {
      calls.length = 0;
      const conv = conversation({ mode: 'roundtable', permission: 'read-only', leadReview: true });
      fake.reviewGate = new Promise(() => {});
      await orchestrator.send(conv.id, 'Q1');
      await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
      // The next message stops that review and goes at once; its own review is stopped with Stop.
      await orchestrator.send(conv.id, 'Q2');
      await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
      orchestrator.stop(conv.id);
      await finish(conv.id);
      expect(reviews(conv).map((m) => m.status)).toEqual(['aborted', 'aborted']);
      fake.reviewGate = undefined;
      if (how === 'retry') {
        await orchestrator.retry(conv.id, replyOf(conv, 'Bob', 1).id);
      } else {
        const q2 = conv.messages.find((m) => m.author.kind === 'user' && textOf(m) === 'Q2')!;
        await orchestrator.resend(conv.id, q2.id, 'Q2 again');
      }
      await finish(conv.id);
      // Reviewed: from the first question the stopped reviews left, the retried or edited run's replies included.
      expect(reviewerCalls()).toHaveLength(3);
      expect(userTexts(conv)).toEqual(['Q1', how === 'retry' ? 'Q2' : 'Q2 again']);
      const last = reviews(conv).at(-1)!;
      expect(conv.messages.at(-1)).toBe(last);
      expect(last.review).toMatchObject({ status: 'ready', replyIds: agentMessages(conv).map((m) => m.id) });
      expect(last.review!.replyIds).toContain(replyOf(conv, 'Bob', 1).id);
      const recent = recentOf(reviewerCalls()[2]!.prompt);
      for (const q of userTexts(conv)) expect(recent).toContain(`<message from="user">\n${q}\n</message>`);
      expect(recent).toContain('<reply n="4" from="@Bob (Claude Code)">');
    }
  });

  it("refuses Retry, Edit, Apply and a settings change while the lead agent reviews: they wait for it, or for Stop", async () => {
    const conv = conversation({ mode: 'parallel', permission: 'edit', leadReview: true });
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    await orchestrator.send(conv.id, 'one');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    const reply = replyOf(conv, 'Alice');
    const user = conv.messages.find((m) => m.author.kind === 'user')!;
    await expect(orchestrator.retry(conv.id, reply.id)).rejects.toMatchObject({ status: 409 });
    await expect(orchestrator.resend(conv.id, user.id, 'again')).rejects.toMatchObject({ status: 409 });
    await expect(orchestrator.applyAgentWork(conv.id, reply.author.kind === 'agent' ? reply.author.agentId : '')).rejects.toMatchObject({ status: 409 });
    await expect(orchestrator.exclusive(conv.id, 'busy', async () => 'saved')).rejects.toMatchObject({ status: 409 });
    fake.reviewGate = undefined;
    release();
    await finish(conv.id);
    await expect(orchestrator.exclusive(conv.id, 'busy', async () => 'saved')).resolves.toBe('saved');
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

// The server's push notifications, as `src/server/index.ts` sets them up; the page's own notifications
// follow the same rule (`AlertTracker`) over the same list (`GET /api/conversations`). Loaded after the
// harness, which sets the data folder first.
const { AlertWatcher } = await import('../src/server/alerts');
const { AlertTracker } = await import('../src/shared/notify');
const { PushService } = await import('../src/server/push');

/** A push service that records the notifications it would send, rather than sending them. */
class RecordingPush extends PushService {
  readonly sent: { kind: AlertPayload['kind']; body: string }[] = [];
  override async push(_sub: PushSubscriptionRecord, payload: AlertPayload) {
    this.sent.push({ kind: payload.kind, body: payload.body });
    return 'sent' as const;
  }
}

describe('lead review and notifications', () => {
  /**
   * A phone subscribed to every notification, with no page of Harness Relay in front, and the watcher
   * that tells it, wired as `src/server/index.ts` wires it (an orchestrator of the test's own, so that
   * its hub's events reach the watcher). `check()` is one of the watcher's checks (every 1.5 s on the
   * server), taken when the test says; the first one is where it starts. `settingUp()` has the watcher
   * check too while each run from then on is being set up (its workspace prepared, which awaits git),
   * where one run hands over to the next, and with `fail` has that setup fail then; it returns how many
   * such checks were taken. `page` is what the page's own rule (`AlertTracker`, `src/web/alerts.ts`)
   * tells of, given the list at each check as the page's poll is (with no quiet checks); `touch()` is
   * an event in some conversation, after which the watcher reads the list again.
   */
  async function phone() {
    const hub = new Hub();
    setOrchestrator(new Orchestrator(store, hub, settings, { context: async () => ({ available: ['claude'], catalog: [], presets: store.listPresets() }) }));
    const push = new RecordingPush(db);
    const keys = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
    push.subscribe(undefined, { endpoint: 'https://web.push.apple.com/phone', keys }, { done: true, needs: true, sound: true }, 'en');
    const list = () =>
      store.list(
        (id) => orchestrator.isRunning(id),
        (id) => orchestrator.isWaiting(id),
        (id) => orchestrator.isSorting(id),
      );
    const watcher = new AlertWatcher({ list, get: (id) => store.get(id), push, busy: () => orchestrator.busy() > 0 });
    hub.subscribeAll(() => watcher.touch());
    const tracker = new AlertTracker();
    const page: string[] = [];
    const check = async () => {
      page.push(...tracker.next(list()).map((a) => a.kind));
      await watcher.check();
    };
    await check();
    const settingUp = (fail?: Error) => {
      let checks = 0;
      const prepare = orchestrator.prepareWorkspace.bind(orchestrator);
      vi.spyOn(orchestrator, 'prepareWorkspace').mockImplementation(async (c) => {
        await check();
        checks++;
        if (fail) throw fail;
        return prepare(c);
      });
      return () => checks;
    };
    return { sent: push.sent, page, check, touch: () => watcher.touch(), settingUp };
  }
  /** A gate the fake lead agent's review waits for, and its key. */
  const holdReview = () => {
    let release!: () => void;
    fake.reviewGate = new Promise((r) => (release = r));
    return () => {
      fake.reviewGate = undefined;
      release();
    };
  };
  const bobDone = { kind: 'done', body: 'Bob finished replying\nBob done' };
  // A test that fails midway leaves no run going into the next one.
  afterEach(() => orchestrator.stopAll());

  it("tells that the team finished only once the lead has reviewed its replies, of the team's last reply, not the review", async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    const alerts = await phone();
    fake.reviewReply = JSON.stringify({ summary: 'The review says this.', highlights: [], nextSteps: [] });
    const release = holdReview();
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    // The team's replies are done, and the lead reviews them: the run is not over, so no news yet.
    expect(agentMessages(conv).map((m) => [m.agentName, m.status])).toEqual([
      ['Alice', 'done'],
      ['Bob', 'done'],
    ]);
    await alerts.check();
    expect(alerts.sent).toEqual([]);
    release();
    await finish(conv.id);
    expect(reviews(conv)[0]!.review!.status).toBe('ready');
    await alerts.check();
    await alerts.check();
    // Once, about Bob's reply (the latest), never the review's card.
    expect(alerts.sent).toEqual([bobDone]);
  });

  it('tells that the team finished once a review that failed has ended, as done, not as an error', async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    const alerts = await phone();
    fake.reviewFail = 'model overloaded';
    const release = holdReview();
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    await alerts.check();
    expect(alerts.sent).toEqual([]);
    release();
    await finish(conv.id);
    expect(reviews(conv)[0]!.review).toMatchObject({ status: 'failed', error: 'model overloaded' });
    await alerts.check();
    expect(alerts.sent).toEqual([bobDone]);
  });

  it("tells of the error once the lead has reviewed the replies, when the team's last reply failed", async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    const alerts = await phone();
    fake.fail = (name) => (name === 'Bob' ? new Error('rate limited') : undefined);
    const release = holdReview();
    await orchestrator.send(conv.id, 'go');
    // Alice answered, so the lead reviews.
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    await alerts.check();
    expect(alerts.sent).toEqual([]);
    release();
    await finish(conv.id);
    await alerts.check();
    expect(alerts.sent).toEqual([{ kind: 'error', body: expect.stringMatching(/^Bob ran into an error\n.*rate limited/) }]);
  });

  it('tells that the team finished once a review switched off meanwhile has stopped and the run is over', async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    const alerts = await phone();
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    await alerts.check();
    expect(alerts.sent).toEqual([]);
    orchestrator.setLeadReview(conv.id, false);
    await finish(conv.id);
    expect(reviews(conv)[0]!.status).toBe('aborted');
    await alerts.check();
    expect(alerts.sent).toEqual([bobDone]);
  });

  it("tells that the team finished when Stop stops the review: the team's replies were done, only the review was stopped", async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    const alerts = await phone();
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    await alerts.check();
    expect(alerts.sent).toEqual([]);
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(reviews(conv)[0]!.status).toBe('aborted');
    await alerts.check();
    expect(alerts.sent).toEqual([bobDone]);
  });

  it('tells once, after the next review, when a message sent during a review stops it: not while the run that answers it is set up', async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    const alerts = await phone();
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    await alerts.check();
    const settingUp = alerts.settingUp();
    const release = holdReview();
    expect(await orchestrator.send(conv.id, 'next one')).toEqual({ queued: false });
    // The review stopped and its run ended, then the run that answers the message was set up: the
    // conversation was at work throughout, so the watcher's check meanwhile had no news.
    expect(settingUp()).toBe(1);
    expect(alerts.sent).toEqual([]);
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: slow(20_000) });
    await alerts.check();
    expect(alerts.sent).toEqual([]);
    release();
    await finish(conv.id);
    expect(reviews(conv).map((m) => m.status)).toEqual(['aborted', 'done']);
    await alerts.check();
    expect(alerts.sent).toEqual([bobDone]);
    expect(replyOf(conv, 'Bob', 1).id).toBe(agentMessages(conv).at(-1)!.id);
  });

  it('tells once, after the next review, when "Skip the review and send now" sends what waited: not while that run is set up', async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    const alerts = await phone();
    fake.reviewGate = new Promise(() => {});
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    scheduleIn(conv);
    expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'queued' });
    const settingUp = alerts.settingUp();
    const release = holdReview();
    expect(await orchestrator.send(conv.id, '', undefined, true)).toEqual({ queued: false });
    expect(settingUp()).toBe(1);
    expect(alerts.sent).toEqual([]);
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: slow(20_000) });
    release();
    await finish(conv.id);
    expect(userTexts(conv)).toEqual(['first', 'scheduled check']);
    await alerts.check();
    expect(alerts.sent).toEqual([bobDone]);
  });

  it("tells once, after the review, when a message sent during the team's turn waits for a run of its own: not for the run before it, which is not reviewed, nor while the next is set up", async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    const alerts = await phone();
    let releaseAlice!: () => void;
    fake.gates.Alice = new Promise((r) => (releaseAlice = r));
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(calls.some((c) => c.name === 'Alice')).toBe(true));
    // For Alice only: Bob's turn in this run does not take it, so it waits for a run of its own.
    expect(await orchestrator.send(conv.id, '@Alice and another thing')).toEqual({ queued: true });
    const settingUp = alerts.settingUp();
    const release = holdReview();
    delete fake.gates.Alice;
    releaseAlice();
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: slow(20_000) });
    // The first run ended with no review (a message waited) and the next one was set up at once.
    expect(settingUp()).toBe(1);
    await alerts.check();
    expect(alerts.sent).toEqual([]);
    release();
    await finish(conv.id);
    expect(reviews(conv)).toHaveLength(1);
    await alerts.check();
    // Alice answered the message, last.
    expect(alerts.sent).toEqual([{ kind: 'done', body: 'Alice finished replying\nAlice done' }]);
  });

  it("tells at once that an agent asked the user something, with no review; once they answered, that the team finished after the review", async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    const alerts = await phone();
    fake.asking.add('Alice');
    await orchestrator.send(conv.id, 'which one?');
    await finish(conv.id);
    await alerts.check();
    expect(alerts.sent).toEqual([{ kind: 'answer', body: 'Alice asked you something\nAlice asks: A or B?' }]);
    expect(reviewerCalls()).toHaveLength(0);

    const release = holdReview();
    await orchestrator.send(conv.id, 'ANSWER: A');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    await alerts.check();
    expect(alerts.sent).toHaveLength(1);
    release();
    await finish(conv.id);
    await alerts.check();
    expect(alerts.sent.slice(1)).toEqual([bobDone]);
  });

  it("tells once that an agent asked the user something, also when the run that takes the answer could not be set up", async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    const alerts = await phone();
    fake.asking.add('Alice');
    await orchestrator.send(conv.id, 'which one?');
    await finish(conv.id);
    await alerts.check();
    const asked = { kind: 'answer', body: 'Alice asked you something\nAlice asks: A or B?' };
    expect(alerts.sent).toEqual([asked]);
    // The answer's run is at work when the watcher checks, then cannot start (git failed, say): the
    // question still waits, and the user was told of it.
    const settingUp = alerts.settingUp(new Error('git failed'));
    await expect(orchestrator.send(conv.id, 'ANSWER: A')).rejects.toThrow('git failed');
    expect(settingUp()).toBe(1);
    expect(conv.pause).toBeDefined();
    expect(orchestrator.isRunning(conv.id)).toBe(false);
    alerts.touch();
    await alerts.check();
    expect(alerts.sent).toEqual([asked]);
    expect(alerts.page).toEqual(['answer']);
    // Answered again, the team goes on, and finishes after the review.
    vi.mocked(orchestrator.prepareWorkspace).mockRestore();
    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(reviewerCalls()).toHaveLength(1);
    await alerts.check();
    expect(alerts.sent).toEqual([asked, bobDone]);
    expect(alerts.page).toEqual(['answer', 'done']);
  });

  it('tells at once that an agent waits for an approval, during the team\'s turn; that the team finished after the review', async () => {
    const conv = conversation({ mode: 'roundtable', leadReview: true });
    conv.agents = [agents[0]!];
    store.saveMeta(conv);
    const alerts = await phone();
    const release = holdReview();
    await orchestrator.send(conv.id, 'please install');
    const pending = () => conv.messages.flatMap((m) => m.parts).find((p) => p.type === 'approval' && p.status === 'pending') as { id: string } | undefined;
    await vi.waitFor(() => expect(pending()).toBeDefined());
    await alerts.check();
    expect(alerts.sent).toEqual([{ kind: 'approval', body: 'Alice is waiting for your approval\nnpm install left-pad' }]);
    orchestrator.answerApproval(conv.id, pending()!.id, { allow: true });
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    await alerts.check();
    expect(alerts.sent).toHaveLength(1);
    release();
    await finish(conv.id);
    await alerts.check();
    expect(alerts.sent.slice(1)).toEqual([{ kind: 'done', body: 'Alice finished replying\nAlice installed' }]);
  });

  it("tells at once that the lead agent's team waits for confirmation, with no review; once confirmed, that the team finished after the review", async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only', autoTeam: true, leadReview: true });
    conv.agents = [];
    store.saveMeta(conv);
    fake.leadReply = JSON.stringify({ choice: 'custom', name: 'Solo', mode: 'parallel', rounds: 1, agents: [{ name: 'Alice', provider: 'claude', role: 'Build it' }], reason: 'x' });
    const alerts = await phone();
    await orchestrator.send(conv.id, 'a question');
    await finish(conv.id);
    await alerts.check();
    expect(alerts.sent).toEqual([{ kind: 'confirm', body: "The lead agent's team is ready for you to confirm" }]);
    expect(reviewerCalls()).toHaveLength(0);

    const release = holdReview();
    orchestrator.confirmPlan(conv.id, conv.messages.findLast((m) => m.plan)!.id);
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1), { timeout: slow(20_000) });
    await alerts.check();
    expect(alerts.sent).toHaveLength(1);
    release();
    await finish(conv.id);
    await alerts.check();
    expect(alerts.sent.slice(1)).toEqual([{ kind: 'done', body: 'Alice finished replying\nAlice done' }]);
  });
});
