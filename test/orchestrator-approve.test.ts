/*
 * "Approve for me" (`approvals: 'auto'`): the lead agent reviewing each approval request before the
 * user is asked — what it approves goes ahead, what it flags or cannot review waits for the user, the
 * user may answer while it reviews, pushing never reaches it, a request it approved is not reviewed
 * again in the run, and what the review reads.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts. A run a schedule
 * starts is in orchestrator-schedule.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationSettings } from '../src/shared/types';
import { agentMessages, agents, calls, conversation, db, fake, finish, orchestrator, Store, store, textOf } from './orchestrator-harness';

type ApprovalPart = Extract<Conversation['messages'][number]['parts'][number], { type: 'approval' }>;

const solo = (settings: Partial<ConversationSettings> = {}) => {
  const conv = conversation({ mode: 'roundtable', permission: 'edit', approvals: 'auto', ...settings });
  conv.agents = [agents[0]!];
  store.saveMeta(conv);
  return conv;
};
const approvals = (conv: Conversation) => conv.messages.flatMap((m) => m.parts).filter((p): p is ApprovalPart => p.type === 'approval');
const approverCalls = () => calls.filter((c) => c.name === 'approver');
const lastReply = (conv: Conversation) => textOf(agentMessages(conv).at(-1)!);
/** Holds the fake reviewer until released. */
const holdReviewer = () => {
  let release!: () => void;
  fake.approverGate = new Promise((r) => (release = r));
  return () => release();
};

describe('Approve for me', () => {
  it("allows what the lead agent approves without asking, and says so on the card with the lead agent's reason", async () => {
    const conv = solo();
    await orchestrator.send(conv.id, 'please install');
    await finish(conv.id);
    expect(lastReply(conv)).toBe('Alice installed');
    expect(approvals(conv)).toEqual([
      expect.objectContaining({
        status: 'allowed',
        detail: 'npm install left-pad',
        review: { status: 'approved', reason: 'Installing a dependency the task needs.' },
      }),
    ]);
    expect(approvals(conv)[0]!.always).toBeUndefined();
    expect(conv.allowRules ?? []).toEqual([]);

    // The lead agent reviewed it read-only, never asking anything itself, in a session of its own.
    expect(approverCalls()).toHaveLength(1);
    const call = approverCalls()[0]!;
    expect(call).toMatchObject({ permission: 'read-only', cwd: conv.settings.cwd });
    expect(call.asksApproval).toBeUndefined();
    expect(call.stateKey).toBeUndefined();
    // It read the user's words, and the request as data.
    expect(call.prompt).toContain('<user_message>\nplease install\n</user_message>');
    expect(call.prompt).toContain('command: npm install left-pad');
    expect(call.prompt).toContain("the agent's own description: Install a dependency");
    expect(call.prompt).toContain('@Alice, a team member running on Claude Code');

    // Saved with the conversation.
    const saved = new Store(db).get(conv.id)!;
    expect(saved.settings.approvals).toBe('auto');
    expect(approvals(saved)[0]!.review).toEqual({ status: 'approved', reason: 'Installing a dependency the task needs.' });
  });

  it('asks the user about what the lead agent flags, with its reason, and the user decides', async () => {
    const conv = solo();
    fake.approverReply = '{"decision": "ask", "reason": "It downloads code from the network."}';
    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    const part = approvals(conv)[0]!;
    expect(part).toMatchObject({ status: 'pending', review: { status: 'flagged', reason: 'It downloads code from the network.' } });

    orchestrator.answerApproval(conv.id, part.id, { allow: false, note: 'not now' });
    await finish(conv.id);
    expect(lastReply(conv)).toBe('Alice skipped (not now)');
    expect(approvals(conv)[0]).toMatchObject({ status: 'denied', note: 'not now', review: { status: 'flagged' } });
  });

  it('allows what the lead agent flags this once only, even when the answer says always', async () => {
    const conv = solo();
    fake.approverReply = '{"decision": "ask", "reason": "It downloads code from the network."}';
    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    orchestrator.answerApproval(conv.id, approvals(conv)[0]!.id, { allow: true, always: true });
    await finish(conv.id);
    expect(lastReply(conv)).toBe('Alice installed');
    expect(approvals(conv)[0]).toMatchObject({ status: 'allowed', review: { status: 'flagged' } });
    expect(approvals(conv)[0]!.always).toBeUndefined();
    // No rule: the next request like it is reviewed again, not let through.
    expect(conv.allowRules ?? []).toEqual([]);
  });

  it('does not wait for the user while the lead agent reviews, and lets the user answer first', async () => {
    const conv = solo();
    const release = holdReviewer();
    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(approverCalls()).toHaveLength(1));
    await vi.waitFor(() => expect(approvals(conv)[0]?.review).toEqual({ status: 'reviewing' }));
    // Reviewing is not waiting: no alert, no "needs you".
    expect(orchestrator.isWaiting(conv.id)).toBe(false);

    orchestrator.answerApproval(conv.id, approvals(conv)[0]!.id, { allow: true });
    await finish(conv.id);
    // The user answered: the lead agent's run is stopped, and the card is the user's answer.
    expect(approverCalls()[0]!.aborted).toBe(true);
    release();
    expect(lastReply(conv)).toBe('Alice installed');
    expect(approvals(conv)[0]!.status).toBe('allowed');
    expect(approvals(conv)[0]!.review).toBeUndefined();
  });

  it("stops the lead agent's review when the CLI withdraws the request, and the card says the CLI went on", async () => {
    const conv = solo();
    const release = holdReviewer();
    const cli = new AbortController();
    fake.inTurn = async (_name, o) => void (await o.requestApproval!({ kind: 'command', detail: 'npm test' }, cli.signal));
    await orchestrator.send(conv.id, 'run the tests');
    await vi.waitFor(() => expect(approvals(conv)[0]?.review).toEqual({ status: 'reviewing' }));
    cli.abort();
    await finish(conv.id);
    expect(approverCalls()[0]!.aborted).toBe(true);
    release();
    // Neither approved for the user nor expired: withdrawn, with no verdict on it.
    expect(approvals(conv)[0]).toMatchObject({ status: 'withdrawn' });
    expect(approvals(conv)[0]!.review).toBeUndefined();
  });

  it('asks the user when the lead agent cannot review, saying why', async () => {
    const conv = solo();
    fake.approverFail = 'not signed in';
    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    expect(approvals(conv)[0]!.review).toEqual({ status: 'failed', reason: '首席 agent 無法審查：not signed in' });
    orchestrator.answerApproval(conv.id, approvals(conv)[0]!.id, { allow: true });
    await finish(conv.id);
    expect(lastReply(conv)).toBe('Alice installed');
  });

  it('asks the user when the lead agent answers no decision', async () => {
    const conv = solo();
    fake.approverReply = 'Sure, looks fine to me.';
    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    // In the user's language, never the parser's English.
    expect(approvals(conv)[0]!.review).toEqual({ status: 'failed', reason: '首席 agent 的回答裡沒有可以讀懂的決定' });
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(approvals(conv)[0]!.status).toBe('expired');
  });

  it('never has pushing or publishing reviewed: it always waits for the user', async () => {
    const conv = solo();
    let answer: boolean | undefined;
    fake.inTurn = async (_name, o) => {
      answer = (await o.requestApproval!({ kind: 'command', detail: 'git push origin main', reason: 'Push the fix' })).allow;
    };
    await orchestrator.send(conv.id, 'push it');
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    expect(approverCalls()).toEqual([]);
    expect(approvals(conv)[0]).toMatchObject({
      status: 'pending',
      review: { status: 'skipped', reason: '推送與發佈一律由你決定，首席 agent 不會替你核准' },
    });
    orchestrator.answerApproval(conv.id, approvals(conv)[0]!.id, { allow: false });
    await finish(conv.id);
    expect(answer).toBe(false);
  });

  it('never grants more access for the turn, and asks about a tool call that does not say what it would do', async () => {
    const conv = solo();
    const answers: boolean[] = [];
    fake.inTurn = async (_name, o) => {
      answers.push((await o.requestApproval!({ kind: 'other', tool: 'permissions', detail: '{"network":{}}', grant: true })).allow);
      answers.push((await o.requestApproval!({ kind: 'other', tool: 'mcp__tracker__create_issue' })).allow);
    };
    await orchestrator.send(conv.id, 'file it');
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    expect(approvals(conv)[0]!.review).toEqual({
      status: 'skipped',
      reason: '在這一輪剩下的時間取得更多權限，一律由你決定，首席 agent 不會替你核准',
    });
    orchestrator.answerApproval(conv.id, approvals(conv)[0]!.id, { allow: false });
    await vi.waitFor(() => expect(approvals(conv)).toHaveLength(2));
    await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
    // A tool's name alone: asked as without a review.
    expect(approvals(conv)[1]!.review).toBeUndefined();
    orchestrator.answerApproval(conv.id, approvals(conv)[1]!.id, { allow: true });
    await finish(conv.id);
    expect(answers).toEqual([false, true]);
    expect(approverCalls()).toEqual([]);
  });

  it('reviews each tool call, even one alike, since its details may be a summary of its arguments', async () => {
    const conv = solo();
    fake.inTurn = async (_name, o) => {
      for (let i = 0; i < 2; i++) await o.requestApproval!({ kind: 'other', tool: 'mcp__tracker__create_issue', detail: 'title: Fix' });
    };
    await orchestrator.send(conv.id, 'file it');
    await finish(conv.id);
    expect(approverCalls()).toHaveLength(2);
    expect(approverCalls()[0]!.prompt).toContain("The details may be a shortened summary of the call's arguments");
    expect(approvals(conv).map((p) => p.status)).toEqual(['allowed', 'allowed']);
  });

  it('asks the user when the review takes too long', async () => {
    const conv = solo();
    const timers: AbortController[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const c = new AbortController();
      timers.push(c);
      return c.signal;
    });
    try {
      holdReviewer();
      await orchestrator.send(conv.id, 'please install');
      await vi.waitFor(() => expect(approverCalls()).toHaveLength(1));
      for (const c of timers) c.abort();
      await vi.waitFor(() => expect(orchestrator.isWaiting(conv.id)).toBe(true));
      expect(approvals(conv)[0]!.review).toEqual({ status: 'failed', reason: '首席 agent 太久沒有完成審查' });
      expect(approverCalls()[0]!.aborted).toBe(true);
      orchestrator.stop(conv.id);
      await finish(conv.id);
    } finally {
      spy.mockRestore();
    }
  });

  it('ends a review under way when the run is stopped: the request expires, and nobody was waited for', async () => {
    const conv = solo();
    holdReviewer();
    await orchestrator.send(conv.id, 'please install');
    await vi.waitFor(() => expect(approvals(conv)[0]?.review?.status).toBe('reviewing'));
    expect(orchestrator.isWaiting(conv.id)).toBe(false);
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(approverCalls()[0]!.aborted).toBe(true);
    expect(approvals(conv)[0]!.status).toBe('expired');
    expect(approvals(conv)[0]!.review).toBeUndefined();
  });

  it('runs at most three reviews at once; the others wait for one to end', async () => {
    const conv = solo();
    const release = holdReviewer();
    fake.inTurn = async (_name, o) => {
      await Promise.all(
        ['npm test', 'npm run lint', 'npm run build', 'npm run e2e'].map((detail) => o.requestApproval!({ kind: 'command', detail })),
      );
    };
    await orchestrator.send(conv.id, 'check everything');
    await vi.waitFor(() => expect(approverCalls()).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 50));
    expect(approverCalls()).toHaveLength(3);
    expect(approvals(conv).map((p) => p.review?.status)).toEqual(['reviewing', 'reviewing', 'reviewing', 'reviewing']);
    release();
    await finish(conv.id);
    expect(approverCalls()).toHaveLength(4);
    expect(approvals(conv).map((p) => p.status)).toEqual(['allowed', 'allowed', 'allowed', 'allowed']);
  });

  it('tells the lead agent where the agent works: its own worktree, in parallel mode', async () => {
    const conv = solo({ mode: 'parallel' });
    let where = '';
    fake.inTurn = async (_name, o) => {
      where = o.cwd;
      await o.requestApproval!({ kind: 'command', detail: 'npm test' });
    };
    await orchestrator.send(conv.id, 'fix it');
    await finish(conv.id);
    expect(where).not.toBe(conv.settings.cwd);
    expect(approverCalls()[0]!.cwd).toBe(where);
    expect(approverCalls()[0]!.prompt).toContain(`The working directory is ${where}.`);
  });

  it('reviews a request again once a message of the user reached the run, in its light', async () => {
    const reviewedFor = () => approverCalls().map((c) => /@(\w+), a team member/.exec(c.prompt)![1]);
    const team = (settings: Partial<ConversationSettings> = {}) => {
      const conv = conversation({ mode: 'roundtable', permission: 'edit', approvals: 'auto', ...settings });
      store.saveMeta(conv);
      return conv;
    };
    fake.inTurn = async (_name, o) => void (await o.requestApproval!({ kind: 'command', detail: 'npm test' }));

    // Bob's request, the same as Alice's, is allowed without another review…
    const quiet = team();
    await orchestrator.send(quiet.id, 'run the tests');
    await finish(quiet.id);
    expect(reviewedFor()).toEqual(['Alice']);

    // …but not once the user said something meanwhile.
    calls.length = 0;
    const told = team();
    let alice!: () => void;
    fake.gates.Alice = new Promise((r) => (alice = r));
    await orchestrator.send(told.id, 'run the tests');
    await vi.waitFor(() => expect(reviewedFor()).toEqual(['Alice']));
    expect(await orchestrator.send(told.id, 'but never the slow ones')).toEqual({ queued: true });
    alice();
    await finish(told.id);
    expect(reviewedFor().slice(0, 2)).toEqual(['Alice', 'Bob']);
    expect(approverCalls()[1]!.prompt).toContain('<user_message>\nbut never the slow ones\n</user_message>');
  });

  it('allows the same request again in the run without another review, and reviews a new one', async () => {
    const conv = solo();
    const answers: boolean[] = [];
    fake.inTurn = async (_name, o) => {
      for (const detail of ['npm test', 'npm test', 'npm run build'])
        answers.push((await o.requestApproval!({ kind: 'command', detail, reason: 'Check the change' })).allow);
    };
    await orchestrator.send(conv.id, 'fix the bug');
    await finish(conv.id);
    expect(answers).toEqual([true, true, true]);
    expect(approverCalls().map((c) => /command: (.*)/.exec(c.prompt)![1])).toEqual(['npm test', 'npm run build']);
    expect(approvals(conv).map((p) => [p.status, p.review?.status])).toEqual([
      ['allowed', 'approved'],
      ['allowed', 'approved'],
      ['allowed', 'approved'],
    ]);

    // A new run reviews it again.
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(approverCalls()).toHaveLength(4);
  });

  it('lets "always allow" answer first, with no review', async () => {
    const conv = solo();
    conv.allowRules = [{ kind: 'command', key: 'npm install' }];
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'please install');
    await finish(conv.id);
    expect(approverCalls()).toEqual([]);
    expect(approvals(conv)[0]).toMatchObject({ status: 'allowed', auto: true });
    expect(approvals(conv)[0]!.review).toBeUndefined();
  });

  it('asks without a review in a conversation that asks, and refuses in one that refuses', async () => {
    const asks = solo({ approvals: undefined });
    await orchestrator.send(asks.id, 'please install');
    await vi.waitFor(() => expect(orchestrator.isWaiting(asks.id)).toBe(true));
    expect(approvals(asks)[0]!.review).toBeUndefined();
    orchestrator.stop(asks.id);
    await finish(asks.id);

    const refuses = solo({ approvals: 'deny' });
    await orchestrator.send(refuses.id, 'please install');
    await finish(refuses.id);
    expect(lastReply(refuses)).toBe('Alice not asked');
    expect(approverCalls()).toEqual([]);
  });

  it('tells the agents in their briefing that what is beyond Edit is reviewed', async () => {
    const conv = solo();
    await orchestrator.send(conv.id, 'hello');
    await finish(conv.id);
    expect(calls.find((c) => c.name === 'Alice')!.systemPrompt).toContain(
      'Anything beyond that is reviewed by the lead agent before the user is asked',
    );
  });
});
