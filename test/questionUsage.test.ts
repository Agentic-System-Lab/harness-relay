import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/shared/types';
import { questionUsage, reportedSubtotal, usageRows } from '../src/web/questionUsage';

const user = (id: string): ChatMessage => ({ id, author: { kind: 'user' }, status: 'done', parts: [], createdAt: 0 });
const reply = (id: string, question?: string): ChatMessage => ({
  ...user(id),
  author: { kind: 'agent', agentId: 'a' },
  usageQuestionId: question,
  agentName: 'Sam',
  meta: { round: 2, inputTokens: 0 },
});
const plan: ChatMessage = {
  ...user('plan'),
  author: { kind: 'system' },
  plan: { status: 'ready', lead: { provider: 'claude' } },
  meta: { costUsd: 0.125 },
};

describe('question usage', () => {
  it('keeps a clarification with its original question and a queued follow-up run with its own', () => {
    const a = reply('a', 'q'),
      b = reply('b', 'q'),
      c = reply('c', 'queued');
    const groups = questionUsage([
      user('q'),
      a,
      user('clarify'),
      b,
      { ...user('queued'), queued: true },
      c,
      { ...c, id: 'still-running', status: 'streaming' },
    ]);
    expect([...groups]).toEqual([
      ['q', [a, b]],
      ['queued', [c]],
    ]);
  });

  it('retains the combined figures of older plans and isolates schedule setup', () => {
    const setup = { ...plan, id: 'setup', plan: { ...plan.plan!, forSchedule: true } };
    const groups = questionUsage([user('q'), plan, reply('a'), setup]);
    const rows = usageRows(groups.get('q')!);
    expect(rows).toEqual([
      { kind: 'combined', costUsd: 0.125 },
      { kind: 'member', name: 'Sam', round: 2, inputTokens: 0 },
    ]);
    expect(reportedSubtotal(rows, 'costUsd')).toBe(0.125);
    expect(reportedSubtotal(rows, 'inputTokens')).toBe(0);
    expect(reportedSubtotal(rows, 'outputTokens')).toBeUndefined();
    expect(groups.get('setup')).toEqual([setup]);
  });

  it('uses only the split planning stages for a new plan and retains unreported checks', () => {
    const stages = [
      { kind: 'planning', inputTokens: 12 },
      { kind: 'modelCheck', provider: 'claude' },
    ] as const;
    const rows = usageRows([{ ...plan, meta: { inputTokens: 12 }, plan: { ...plan.plan!, usage: [...stages] } }]);
    expect(rows).toEqual(stages);
    expect(reportedSubtotal(rows, 'inputTokens')).toBe(12);
  });
});
