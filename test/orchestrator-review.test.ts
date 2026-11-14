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

  it('starts a message written while it reviewed once another conversation has finished changing the folder', async () => {
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
    // Its run cannot start: it waits, and says so once.
    await vi.waitFor(() => expect(first.messages.at(-1)!.parts.some((p) => p.type === 'text' && p.text.includes(project))).toBe(true));
    await finish(first.id);
    expect(first.queue).toHaveLength(1);
    // Once the other conversation is done, it starts by itself.
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await vi.waitFor(() => expect(first.queue ?? []).toHaveLength(0), { timeout: 20_000 });
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(2), { timeout: 20_000 });
    await finish(first.id);
    expect(first.messages.filter((m) => m.author.kind === 'user').map((m) => m.parts[0]!.type === 'text' && m.parts[0]!.text)).toEqual(['first', 'next']);
    // The note that it waits (not the one that the folder was made a git repository).
    const waits = (m: ChatMessage) => m.author.kind === 'system' && m.parts.some((p) => p.type === 'text' && p.text.includes(project) && !p.text.includes('git'));
    expect(first.messages.filter(waits)).toHaveLength(1);
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

describe('waiting for the folder', () => {
  /** A conversation in a folder of its own, with one member, Carol, whom the team-wide gate does not hold. */
  const elsewhere = () => {
    const dir = join(root, `elsewhere-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const conv = conversation({ mode: 'roundtable', permission: 'edit', cwd: dir });
    conv.agents = [{ id: 'c1', name: 'Carol', provider: 'claude', role: '' }];
    store.saveMeta(conv);
    fake.gates.Carol = Promise.resolve();
    return conv;
  };
  const waitNote = (conv: Conversation) =>
    conv.messages.filter((m) => m.author.kind === 'system' && m.parts.some((p) => p.type === 'text' && p.text.includes(project) && !p.text.includes('git')));

  /** `first` reviews, `other` takes the folder meanwhile, and a message written during the review waits for it. */
  async function waitingBehindOther() {
    const first = conversation({ mode: 'roundtable', permission: 'edit', leadReview: true });
    const other = conversation({ mode: 'roundtable', permission: 'edit' });
    let releaseReview!: () => void;
    fake.reviewGate = new Promise((r) => (releaseReview = r));
    await orchestrator.send(first.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    let releaseOther!: () => void;
    fake.gate = new Promise((r) => (releaseOther = r));
    await orchestrator.send(other.id, 'other');
    await orchestrator.send(first.id, 'next');
    fake.reviewGate = undefined;
    releaseReview();
    await vi.waitFor(() => expect(waitNote(first)).toHaveLength(1));
    await finish(first.id);
    return { first, other, releaseOther };
  }

  it('does not try again while another conversation still holds the folder, however many other folders are freed', async () => {
    const { first, other, releaseOther } = await waitingBehindOther();
    const prepare = vi.spyOn(orchestrator, 'prepareWorkspace');
    const tries = () => prepare.mock.calls.filter(([c]) => c.id === first.id).length;
    // A conversation in another folder finishes twice: each frees a folder, but not this one.
    const third = elsewhere();
    for (const q of ['one', 'two']) {
      await orchestrator.send(third.id, q);
      await finish(third.id);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(tries()).toBe(0);
    expect(first.queue).toHaveLength(1);
    // Once the folder is free, it starts, once.
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await vi.waitFor(() => expect(first.queue ?? []).toHaveLength(0), { timeout: 20_000 });
    await finish(first.id);
    expect(tries()).toBe(1);
    expect(waitNote(first)).toHaveLength(1);
    prepare.mockRestore();
  });

  it('starts a team the user confirmed once the folder is free', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'edit', autoTeam: true });
    conv.agents = [];
    store.saveMeta(conv);
    fake.leadReply = JSON.stringify({
      choice: 'custom',
      name: 'Solo',
      mode: 'roundtable',
      rounds: 1,
      agents: [{ name: 'Alice', provider: 'claude', role: 'Build it' }],
      reason: 'x',
    });
    await orchestrator.send(conv.id, 'build it');
    await finish(conv.id);
    const other = conversation({ mode: 'roundtable', permission: 'edit' });
    let releaseOther!: () => void;
    fake.gate = new Promise((r) => (releaseOther = r));
    await orchestrator.send(other.id, 'other');
    orchestrator.confirmPlan(conv.id, conv.messages.find((m) => m.plan)!.id);
    await vi.waitFor(() => expect(waitNote(conv)).toHaveLength(1));
    expect(agentMessages(conv)).toHaveLength(0);
    // Kept with the conversation, for a restart.
    expect(store.folderWaits()).toEqual([{ id: conv.id, wait: 'team' }]);
    fake.gate = Promise.resolve();
    releaseOther();
    await vi.waitFor(() => expect(agentMessages(conv).filter((m) => m.status === 'done')).toHaveLength(1), { timeout: 20_000 });
    await finish(conv.id);
  });

  it('stops waiting when its run fails for another reason, and says so once', async () => {
    const { first, other, releaseOther } = await waitingBehindOther();
    const prepare = vi.spyOn(orchestrator, 'prepareWorkspace').mockImplementation(async (c) => {
      if (c.id === first.id) throw new Error('disk full');
      return { isolated: false };
    });
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    const failed = () => first.messages.filter((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('disk full')));
    await vi.waitFor(() => expect(failed()).toHaveLength(1));
    // Another folder freed later does not try it again.
    prepare.mockRestore();
    const third = elsewhere();
    await orchestrator.send(third.id, 'later');
    await finish(third.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(failed()).toHaveLength(1);
    expect(first.queue).toHaveLength(1);
  });

  /**
   * Once the folder is free, the waiting conversation's start is held while it prepares its workspace;
   * `takeAgain` has the other conversation take the folder again meanwhile (`releaseAgain` lets it
   * finish), and `prepared` lets the start go on.
   */
  async function startHeld(first: Conversation, other: Conversation, releaseOther: () => void) {
    let prepared!: () => void;
    const preparing = new Promise<void>((r) => (prepared = r));
    const real = orchestrator.prepareWorkspace.bind(orchestrator);
    const prepare = vi.spyOn(orchestrator, 'prepareWorkspace').mockImplementation(async (c) => {
      if (c.id === first.id && prepare.mock.calls.filter(([x]) => x.id === first.id).length === 1) await preparing;
      return real(c);
    });
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await vi.waitFor(() => expect(prepare.mock.calls.some(([c]) => c.id === first.id)).toBe(true));
    let releaseAgain!: () => void;
    const takeAgain = async () => {
      fake.gate = new Promise((r) => (releaseAgain = r));
      await orchestrator.send(other.id, 'again');
      await vi.waitFor(() => expect(orchestrator.isRunning(other.id)).toBe(true));
    };
    return { prepared, takeAgain, releaseAgain: () => releaseAgain(), prepare };
  }

  /** A conversation waiting for the folder, whose own start, once it is free, is held while it prepares its workspace. */
  async function startHeldWaiting() {
    const { first, other, releaseOther } = await waitingBehindOther();
    const { prepared, prepare } = await startHeld(first, other, releaseOther);
    return { conv: first, go: prepared, restore: () => prepare.mockRestore() };
  }

  it('waits on when a settings change has it as the folder is freed, and starts once the change is over', async () => {
    const { first, other, releaseOther } = await waitingBehindOther();
    let done!: () => void;
    const change = orchestrator.exclusive(first.id, 'busy', () => new Promise<void>((r) => (done = r)));
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(first.queue).toHaveLength(1);
    expect(orchestrator.waitsForFolder(first.id)).toBe(true);
    done();
    await change;
    await vi.waitFor(() => expect(first.queue ?? []).toHaveLength(0), { timeout: 20_000 });
    await finish(first.id);
    expect(waitNote(first)).toHaveLength(1);
    expect(orchestrator.waitsForFolder(first.id)).toBe(false);
  });

  it('says once that it waits, when a folder elsewhere is freed while its own start is set up and the folder is taken again', async () => {
    const { first, other, releaseOther } = await waitingBehindOther();
    const { prepared, takeAgain, releaseAgain, prepare } = await startHeld(first, other, releaseOther);
    // A folder elsewhere is freed while its folder is free and its start is set up; then the other
    // conversation takes the folder first.
    const third = elsewhere();
    await orchestrator.send(third.id, 'elsewhere');
    await finish(third.id);
    await new Promise((r) => setTimeout(r, 50));
    await takeAgain();
    prepared();
    // Its start finds the folder taken again: it waits again, without another note.
    await new Promise((r) => setTimeout(r, 100));
    expect(orchestrator.isRunning(first.id)).toBe(false);
    expect(orchestrator.waitsForFolder(first.id)).toBe(true);
    expect(waitNote(first)).toHaveLength(1);
    fake.gate = Promise.resolve();
    releaseAgain();
    await finish(other.id);
    await vi.waitFor(() => expect(first.queue ?? []).toHaveLength(0), { timeout: 20_000 });
    await finish(first.id);
    expect(waitNote(first)).toHaveLength(1);
    prepare.mockRestore();
  });

  it("queues what the user sends while it waits, to start with the rest; Continue cannot start it before the folder is free", async () => {
    const { first, other, releaseOther } = await waitingBehindOther();
    expect(await orchestrator.send(first.id, 'and this too')).toEqual({ queued: true });
    expect(first.queue!.map(textOf)).toEqual(['next', 'and this too']);
    await expect(orchestrator.send(first.id, '')).rejects.toMatchObject({ status: 409 });
    expect(orchestrator.waitsForFolder(first.id)).toBe(true);
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await vi.waitFor(() => expect(first.queue ?? []).toHaveLength(0), { timeout: 20_000 });
    await finish(first.id);
    // Both in the one run, as written.
    expect(first.messages.filter((m) => m.author.kind === 'user').map(textOf)).toEqual(['first', 'next', 'and this too']);
    expect(waitNote(first)).toHaveLength(1);
  });

  it('stops waiting at Stop, and says so: the folder freed later does not start it, the user does', async () => {
    const emit = vi.spyOn(Hub.prototype, 'emit');
    const statusOf = (id: string) => emit.mock.calls.findLast(([c, e]) => c === id && e.type === 'status')?.[1];
    const { first, other, releaseOther } = await waitingBehindOther();
    // The chat is told it waits, and that it no longer does.
    expect(statusOf(first.id)).toMatchObject({ running: false, waitsForFolder: true });
    const notes = first.messages.filter((m) => m.author.kind === 'system').length;
    orchestrator.stop(first.id);
    expect(orchestrator.waitsForFolder(first.id)).toBe(false);
    expect(statusOf(first.id)).not.toHaveProperty('waitsForFolder');
    expect(first.messages.filter((m) => m.author.kind === 'system')).toHaveLength(notes + 1);
    emit.mockRestore();
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(orchestrator.isRunning(first.id)).toBe(false);
    expect(first.queue).toHaveLength(1);
    await orchestrator.send(first.id, '');
    await finish(first.id);
    expect(first.queue ?? []).toHaveLength(0);
  });

  it('does not wait again when Stop comes while its own start is being set up', async () => {
    const { first, other, releaseOther } = await waitingBehindOther();
    const { prepared, takeAgain, releaseAgain, prepare } = await startHeld(first, other, releaseOther);
    await takeAgain();
    orchestrator.stop(first.id);
    prepared();
    await new Promise((r) => setTimeout(r, 100));
    expect(orchestrator.waitsForFolder(first.id)).toBe(false);
    expect(waitNote(first)).toHaveLength(1);
    fake.gate = Promise.resolve();
    releaseAgain();
    await finish(other.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(orchestrator.isRunning(first.id)).toBe(false);
    expect(first.queue).toHaveLength(1);
    prepare.mockRestore();
  });

  it('does not start when Stop comes while its own start is being set up and the folder is free', async () => {
    const { conv, go, restore } = await startHeldWaiting();
    orchestrator.stop(conv.id);
    go();
    await new Promise((r) => setTimeout(r, 200));
    expect(orchestrator.isRunning(conv.id)).toBe(false);
    expect(agentMessages(conv).filter((m) => textOf(m).includes('next'))).toHaveLength(0);
    expect(conv.queue).toHaveLength(1);
    expect(orchestrator.waitsForFolder(conv.id)).toBe(false);
    expect(store.folderWaits()).toEqual([]);
    // One note that it waited, one that it stopped waiting; then the user starts it.
    expect(waitNote(conv)).toHaveLength(1);
    restore();
    await orchestrator.send(conv.id, '');
    await finish(conv.id);
    expect(conv.queue ?? []).toHaveLength(0);
  });

  it('stops waiting when every message that waited is taken back', async () => {
    const { first, other, releaseOther } = await waitingBehindOther();
    orchestrator.withdraw(first.id, first.queue![0]!.id);
    expect(orchestrator.waitsForFolder(first.id)).toBe(false);
    expect(store.folderWaits()).toEqual([]);
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(orchestrator.isRunning(first.id)).toBe(false);
  });

  it('starts after a restart, as its note said, when the server stopped while it waited', async () => {
    const { first, other, releaseOther } = await waitingBehindOther();
    expect(store.folderWaits()).toEqual([{ id: first.id, wait: 'queue' }]);
    // Shutting down: the other conversation's run ends, and the wait is kept.
    orchestrator.stopAll();
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.folderWaits()).toEqual([{ id: first.id, wait: 'queue' }]);
    const restarted = new Store(db);
    setStore(restarted);
    setOrchestrator(new Orchestrator(restarted, new Hub(), settings, { context: async () => ({ available: ['claude'], catalog: [], presets: restarted.listPresets() }) }));
    orchestrator.resumeFolderWaits();
    const again = restarted.get(first.id)!;
    await vi.waitFor(() => expect(again.queue ?? []).toHaveLength(0), { timeout: 20_000 });
    await finish(again.id);
    expect(again.messages.filter((m) => m.author.kind === 'user').map(textOf)).toEqual(['first', 'next']);
    expect(restarted.folderWaits()).toEqual([]);
    // No other note: it said it would start on its own.
    expect(waitNote(again)).toHaveLength(1);
  });

  it('forgets a conversation deleted while it waits', async () => {
    const { first, other, releaseOther } = await waitingBehindOther();
    await orchestrator.deleteConversation(first.id);
    fake.gate = Promise.resolve();
    releaseOther();
    await finish(other.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(store.get(first.id)).toBeUndefined();
    expect(orchestrator.isRunning(first.id)).toBe(false);
  });
});

describe('Stop while a run is being set up', () => {
  it('keeps the messages waiting when Stop comes as the run after a review is set up, and says it stopped', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', leadReview: true });
    let releaseReview!: () => void;
    fake.reviewGate = new Promise((r) => (releaseReview = r));
    await orchestrator.send(conv.id, 'first');
    await vi.waitFor(() => expect(reviewerCalls()).toHaveLength(1));
    await orchestrator.send(conv.id, 'next');
    // The run for the message, once the review is over, waits in preparing its workspace.
    let prepared!: () => void;
    const preparing = new Promise<void>((r) => (prepared = r));
    const real = orchestrator.prepareWorkspace.bind(orchestrator);
    const prepare = vi.spyOn(orchestrator, 'prepareWorkspace').mockImplementation(async (c) => {
      if (c.id === conv.id) await preparing;
      return real(c);
    });
    fake.reviewGate = undefined;
    releaseReview();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    orchestrator.stop(conv.id);
    prepared();
    await new Promise((r) => setTimeout(r, 200));
    expect(orchestrator.isRunning(conv.id)).toBe(false);
    expect(conv.queue).toHaveLength(1);
    expect(textOf(conv.messages.at(-1)!)).toMatch(/^(Stopped\.|已停止。)$/);
    prepare.mockRestore();
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
