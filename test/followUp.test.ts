import { describe, expect, it } from 'vitest';
import { addressedFollowUp, followUpSources, inferFollowUp, type FollowUpSource } from '../src/shared/followUp';
import type { AgentConfig, ChatMessage } from '../src/shared/types';

const qa: AgentConfig = { id: 'qa', name: 'QA', role: '', provider: 'claude' };
const dev: AgentConfig = { id: 'dev', name: 'Dev', role: '', provider: 'codex' };
const sources: FollowUpSource[] = [
  {
    id: 'qa-note',
    agent: qa,
    text: '登入逾時測試失敗。The login timeout test failed with LOGIN_TIMEOUT. testRefreshToken in src/auth.ts reported ENOENT. E1234 is unrelated. The client retried twice.',
  },
  { id: 'dev-note', agent: dev, text: 'Updated build.ts and the release checklist. API docs are ready.' },
];

describe('local follow-up matching', () => {
  it.each([
    ['剛才那個登入逾時測試，錯誤訊息是什麼？', 'qa'],
    ['Why did that login timeout test fail?', 'qa'],
    ['What caused LOGIN_TIMEOUT?', 'qa'],
    ['Why ENOENT?', 'qa'],
    ['Why did testRefreshToken fail?', 'qa'],
    ['Can you explain “the client retried twice”?', 'qa'],
    ['What does build.ts do?', 'dev'],
    ['Why did src/auth.ts fail?', 'qa'],
    ['那為什麼？', undefined],
    ['Why E123?', undefined],
    ['Could everyone explain LOGIN_TIMEOUT?', undefined],
    ['請全隊說明 LOGIN_TIMEOUT？', undefined],
    ['Please add another login timeout test.', undefined],
    ['How do I update the release checklist?', undefined],
    ['How can I retry LOGIN_TIMEOUT in build.ts?', undefined],
    ['Where is login.spec.ts?', undefined],
  ])('%s', (query, owner) => {
    expect(inferFollowUp(query!, sources)?.agent.id).toBe(owner);
  });

  it.each([
    'What was HTTP 503?',
    'What is the new API design?',
    'Can the team explain ECONNRESET?',
    'Can you both explain ECONNRESET?',
    '請兩位說明 ECONNRESET？',
  ])('keeps the team for %s', (query) => {
    const only = [{ ...sources[0]!, text: 'The HTTP 404 test failed with ECONNRESET. The API docs are ready.' }];
    expect(inferFollowUp(query, only)).toBeUndefined();
    expect(inferFollowUp('Which test reported HTTP 404?', only)?.agent.id).toBe('qa');
  });

  it('does not match a prefix of a longer filename or identifier', () => {
    const only = [{ ...sources[0]!, text: 'Use src/build.ts.bak and cache-clear-config.js.' }];
    expect(inferFollowUp('Why does build.ts fail?', only)).toBeUndefined();
    expect(inferFollowUp('What about cache-clear?', only)).toBeUndefined();
    expect(inferFollowUp('Why does build.ts fail?', [{ ...only[0]!, text: 'The issue is in src/build.ts.' }])?.agent.id).toBe('qa');
  });

  it('requires a unique author, even across multiple replies and shared identifiers', () => {
    const duplicate = { ...sources[0]!, id: 'again' };
    expect(inferFollowUp('Why ENOENT?', [...sources, duplicate])?.id).toBe('again');
    expect(inferFollowUp('Why ENOENT?', [...sources, { ...duplicate, agent: dev }])).toBeUndefined();
    expect(addressedFollowUp('@Dev why ENOENT?', ['QA', 'Dev'])).toBe(true);
    expect(addressedFollowUp('Why did `@Dev` report ENOENT?', ['QA', 'Dev'])).toBe(false);
  });

  it('only reads finished replies to the latest local question, including older transcripts without usage ids', () => {
    const user: ChatMessage = { id: 'q', author: { kind: 'user' }, createdAt: 0, status: 'done', parts: [] };
    const reply: ChatMessage = { ...user, id: 'r', author: { kind: 'agent', agentId: qa.id }, parts: [{ type: 'text', text: 'ENOENT' }] };
    const conv = { agents: [qa], messages: [user, reply] };
    expect(followUpSources(conv).map((m) => m.id)).toEqual(['r']);
    expect(followUpSources({ ...conv, messages: [...conv.messages, { ...user, id: 'next' }] })).toEqual([]);
    expect(followUpSources({ ...conv, agents: [dev] })).toEqual([]);
    for (const change of [{ passed: true }, { status: 'aborted' as const }, { status: 'error' as const }]) {
      expect(followUpSources({ ...conv, messages: [user, { ...reply, ...change }] })).toEqual([]);
    }
    expect(followUpSources({ ...conv, branch: { independent: true, afterId: reply.id, fromId: 'old', fromTitle: 'old' } })).toEqual([]);
    expect(followUpSources({ ...conv, queue: [user] })).toEqual([]);
  });
});
