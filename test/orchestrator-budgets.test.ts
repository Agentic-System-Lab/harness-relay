/*
 * The lead agent's answers in the shape its CLI is asked for (structured output, with its reply's
 * text as the fallback), a member's own limits reaching its CLI, and what a failed or stopped turn
 * spent kept with its reply.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { describe, expect, it } from 'vitest';
import type { AgentConfig, AgentLimits, Conversation } from '../src/shared/types';
import { GROUP_SCHEMA } from '../src/server/grouping';
import { PLAN_SCHEMA, REVISION_SCHEMA } from '../src/server/planner';
import { REVIEW_SCHEMA } from '../src/server/reviewer';
import { AgentRunError, agentMessages, agents, conversation, fake, finish, orchestrator, store } from './orchestrator-harness';

/** A conversation of `members`, as `conversation()` makes one. */
function conversationOf(members: AgentConfig[]): Conversation {
  const conv = conversation({ mode: 'roundtable', permission: 'edit' });
  conv.agents = members;
  store.saveMeta(conv);
  return conv;
}

describe("the lead agent's answers in the shape its CLI is asked for", () => {
  it('designs the team from the structured answer, the text being no JSON at all', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    fake.leadReply = 'The general panel fits.';
    fake.structured.lead = {
      choice: 'template',
      templateId: 'builtin-general',
      baseTemplateId: null,
      name: null,
      description: null,
      mode: null,
      rounds: null,
      maxHops: null,
      agents: null,
      reason: 'It fits.',
    };
    await orchestrator.send(conv.id, 'What should we write?');
    await finish(conv.id);
    expect(fake.schemas.lead).toBe(PLAN_SCHEMA);
    expect(conv.messages.find((m) => m.plan)!.plan).toMatchObject({ status: 'ready', source: 'template', presetId: 'builtin-general' });
  });

  it('reads the text when the structured answer is missing', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', autoTeam: true, rounds: 1 });
    fake.leadReply = '```json\n{"choice": "template", "templateId": "builtin-general", "reason": "It fits."}\n```';
    await orchestrator.send(conv.id, 'What should we write?');
    await finish(conv.id);
    expect(conv.messages.find((m) => m.plan)!.plan).toMatchObject({ status: 'ready', source: 'template', presetId: 'builtin-general' });
  });

  it('reviews, changes the team and sorts the conversation from the structured answers', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', leadReview: true, rounds: 1 });
    fake.reviewReply = 'All fine.';
    fake.structured.reviewer = { summary: 'From the shape.', highlights: [], nextSteps: [{ text: 'Ship it', by: 'user', message: null }] };
    await orchestrator.send(conv.id, 'hello team');
    await finish(conv.id);
    expect(fake.schemas.reviewer).toBe(REVIEW_SCHEMA);
    expect(conv.messages.find((m) => m.review)!.review).toMatchObject({
      status: 'ready',
      summary: 'From the shape.',
      nextSteps: [{ text: 'Ship it', by: 'user' }],
    });

    fake.reviseReply = 'Done.';
    fake.structured.reviser = {
      mode: 'relay',
      rounds: 1,
      maxHops: 4,
      agents: agents.map((a) => ({ name: a.name, provider: a.provider, role: null, model: null, effort: null, was: null })),
      reason: 'Relay now.',
    };
    const revised = await orchestrator.reviseTeam(conv.id, {
      request: 'take turns as a relay',
      agents,
      settings: { mode: 'roundtable', rounds: 1, maxHops: 5 },
    });
    expect(fake.schemas.reviser).toBe(REVISION_SCHEMA);
    expect(revised).toMatchObject({ reason: 'Relay now.', settings: { mode: 'relay', rounds: 1, maxHops: 4 } });
    expect(revised.agents.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('sorts a new conversation into the group of the structured answer', async () => {
    store.createGroup({ id: 'g1', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only', rounds: 1 });
    fake.sorterReply = 'Docs, I would say.';
    fake.structured.sorter = { group: 1 };
    await orchestrator.send(conv.id, 'Write the README');
    await finish(conv.id);
    await orchestrator.settled(5000);
    expect(fake.schemas.sorter).toBe(GROUP_SCHEMA);
    expect(store.groupOf(conv.id)).toBe('g1');
  });
});

describe("a member's own limits", () => {
  it("reach its CLI's run, only the one its CLI has", async () => {
    const conv = conversationOf([
      { id: 'a', name: 'Alice', provider: 'claude', role: '', limits: { usd: 2 } },
      // A limit Claude Code does not have.
      { id: 'b', name: 'Bob', provider: 'claude', role: '', limits: { steps: 9 } },
    ]);
    const given: Record<string, AgentLimits | undefined> = {};
    fake.inTurn = async (name, o) => void (given[name] = o.limits);
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(given).toEqual({ Alice: { usd: 2 }, Bob: undefined });
  });
});

describe('what a turn spent when it failed or was stopped', () => {
  it('is kept with the reply, as far as its CLI said', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'edit' });
    fake.fail = (name) =>
      name === 'Alice'
        ? new AgentRunError('rate limited', false, { costUsd: 0.4, inputTokens: 10, outputTokens: 2 })
        : new AgentRunError('Stopped', true, { inputTokens: 5, outputTokens: 1 });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const [alice, bob] = agentMessages(conv);
    expect(alice).toMatchObject({ status: 'error', meta: { costUsd: 0.4, inputTokens: 10, outputTokens: 2 } });
    expect(bob).toMatchObject({ status: 'aborted', meta: { inputTokens: 5, outputTokens: 1 } });
    expect(bob!.meta!.costUsd).toBeUndefined();
  });
});
