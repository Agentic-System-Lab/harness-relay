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
    release();
    expect(lastReply(conv)).toBe('Alice installed');
    // The user answered: the review is stopped and the card is the user's answer.
    expect(approvals(conv)[0]!.status).toBe('allowed');
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
    expect(approvals(conv)[0]!.review?.status).toBe('failed');
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
      review: { status: 'flagged', reason: '推送與發佈一律由你決定，首席 agent 不會替你核准' },
    });
    orchestrator.answerApproval(conv.id, approvals(conv)[0]!.id, { allow: false });
    await finish(conv.id);
    expect(answer).toBe(false);
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
