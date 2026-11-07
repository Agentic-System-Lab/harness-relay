import { describe, expect, it } from 'vitest';
import type { ConversationSummary } from '../src/shared/types';
import { convStatus } from '../src/web/util';

const conv = (extra: Partial<ConversationSummary>): ConversationSummary => ({
  id: 'c',
  title: 't',
  updatedAt: 100,
  agents: [],
  running: false,
  ...extra,
});

describe('sidebar status', () => {
  it('puts what needs the user first, then replying', () => {
    expect(convStatus(conv({ running: true, waiting: true }), 0)).toBe('waiting');
    expect(convStatus(conv({ confirmTeam: true, lastStatus: 'done' }), 100)).toBe('confirm');
    expect(convStatus(conv({ confirmTeam: true, waiting: true }), 0)).toBe('waiting');
    expect(convStatus(conv({ running: true, lastStatus: 'done' }), 100)).toBe('running');
  });

  it('marks finished replies the user has not seen yet', () => {
    expect(convStatus(conv({ lastStatus: 'done' }), 50)).toBe('unread');
    expect(convStatus(conv({ lastStatus: 'error' }), undefined)).toBe('error');
    expect(convStatus(conv({ lastStatus: 'done' }), 100)).toBeUndefined();
    expect(convStatus(conv({ lastStatus: 'aborted' }), 50)).toBeUndefined();
    expect(convStatus(conv({}), 0)).toBeUndefined();
  });
});
