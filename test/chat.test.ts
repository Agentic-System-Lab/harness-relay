import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentWorktree, ChatMessage, ConversationSettings } from '../src/shared/types';
import { ApiError, api, orCreateCwd } from '../src/web/api';
import { afterStreamError, applyStates, draftStatus, enterSends } from '../src/web/chat';
import type { Team } from '../src/web/components/TeamEditor';

describe('Enter in a message box', () => {
  const key = (k: string, mods: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) => ({
    key: k,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...mods,
  });

  it('sends with a keyboard and mouse; Shift+Enter starts a new line', () => {
    expect(enterSends(key('Enter'), false)).toBe(true);
    expect(enterSends(key('Enter', { metaKey: true }), false)).toBe(true);
    expect(enterSends(key('Enter', { ctrlKey: true }), false)).toBe(true);
    expect(enterSends(key('Enter', { shiftKey: true }), false)).toBe(false);
    expect(enterSends(key('a'), false)).toBe(false);
  });

  it('starts a new line on a phone or tablet, where the send button sends', () => {
    expect(enterSends(key('Enter'), true)).toBe(false);
    expect(enterSends(key('Enter', { shiftKey: true }), true)).toBe(false);
    // A hardware keyboard on a tablet can still send with ⌘/Ctrl+Enter.
    expect(enterSends(key('Enter', { metaKey: true }), true)).toBe(true);
    expect(enterSends(key('Enter', { ctrlKey: true }), true)).toBe(true);
  });
});

describe('when the event stream drops', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports the HTTP status of a failed request', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Conversation not found' }), { status: 404 }));
    const err = await api.getConversation('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe('Conversation not found');
  });

  it('keeps the error code the server sends', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Not found: /x', code: 'cwd-missing' }), { status: 404 }));
    const err = (await api.getConversation('x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('cwd-missing');
  });

  it('stops only when the conversation is gone', () => {
    expect(afterStreamError(new ApiError('Conversation not found', 404), true)).toBe('stop');
    expect(afterStreamError(new ApiError('Conversation not found', 404), false)).toBe('stop');
  });

  it('keeps retrying while the server restarts', () => {
    // Dev: the Vite proxy answers 502 / 500, and the browser gives up on a stream that got an error status.
    expect(afterStreamError(new ApiError('502 Bad Gateway', 502), true)).toBe('reconnect');
    // Production: the server is not reachable; the browser keeps retrying the stream by itself.
    expect(afterStreamError(new TypeError('Failed to fetch'), false)).toBe('wait');
    expect(afterStreamError(new TypeError('Failed to fetch'), true)).toBe('reconnect');
    // The conversation is still there.
    expect(afterStreamError(undefined, false)).toBe('wait');
    expect(afterStreamError(undefined, true)).toBe('reconnect');
  });
});

const result = (id: string, agentId: string, base: string, head: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author: { kind: 'agent', agentId },
  createdAt: 0,
  status: 'done',
  parts: [],
  changes: { root: '/r', base, head, files: [{ path: 'f', status: 'M', added: 1, deleted: 0 }], isolated: true, branch: `relay/c/${agentId}` },
  ...extra,
});

const worktree = (agentId: string, base: string, needsReset = false): AgentWorktree => ({
  root: '/r',
  path: `/wt/${agentId}`,
  branch: `relay/c/${agentId}`,
  base,
  needsReset,
});

describe('which worktree result can be applied', () => {
  it("offers each agent's latest result, including later rounds in the same worktree", () => {
    const messages = [result('a1', 'A', 'S1', 'h1'), result('b1', 'B', 'S1', 'k1'), result('a2', 'A', 'h1', 'h2')];
    const states = applyStates(messages, { A: worktree('A', 'S1'), B: worktree('B', 'S1') });
    expect([...states]).toEqual([
      ['a2', 'available'],
      ['b1', 'available'],
    ]);
  });

  it('marks the latest result stale once a result was applied', () => {
    const states = applyStates([result('a1', 'A', 'S1', 'h1')], { A: worktree('A', 'S1', true) });
    expect(states.get('a1')).toBe('stale');
  });

  it('offers nothing from before the worktree was recreated (same branch, new base)', () => {
    // A result was applied, then the next parallel turn recreated the worktrees from snapshot S2;
    // A has made no changes since, so its old card must not offer Apply again.
    const messages = [result('a1', 'A', 'S1', 'h1'), result('b2', 'B', 'S2', 'k2')];
    const states = applyStates(messages, { A: worktree('A', 'S2'), B: worktree('B', 'S2') });
    expect(states.has('a1')).toBe(false);
    expect(states.get('b2')).toBe('available');
  });

  it('ignores streaming replies, shared-directory changes and agents without a worktree', () => {
    const shared = result('s', 'A', 'S1', 'x');
    shared.changes = { ...shared.changes!, isolated: false };
    const messages = [result('a1', 'A', 'S1', 'h1'), shared, result('a2', 'A', 'h1', 'h2', { status: 'streaming' }), result('c1', 'C', 'S1', 'z')];
    const states = applyStates(messages, { A: worktree('A', 'S1') });
    expect([...states]).toEqual([['a1', 'available']]);
  });
});

const settings: ConversationSettings = { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'edit', cwd: '/p', autoTeam: true };
const planning: Team = { agents: [], settings };
const designed: Team = {
  agents: [{ id: 'x', name: 'Builder', provider: 'codex', role: 'builds' }],
  settings: { ...settings, mode: 'parallel', rounds: 2, autoTeam: false },
};

describe('the team drawer draft', () => {
  it('follows the team while the user has not edited it', () => {
    expect(draftStatus(planning, planning, designed)).toBe('refresh');
  });

  it('refuses to save an edited draft over a team that changed underneath', () => {
    const edited: Team = { ...planning, settings: { ...settings, permission: 'read-only' } };
    expect(draftStatus(planning, edited, designed)).toBe('conflict');
  });

  it('is not fooled by the same team sent again in another key order', () => {
    const resent: Team = {
      settings: { autoTeam: true, cwd: '/p', permission: 'edit', maxHops: 8, rounds: 1, mode: 'roundtable', approvals: undefined },
      agents: [],
    };
    const edited: Team = { ...planning, settings: { ...settings, rounds: 3 } };
    expect(draftStatus(planning, edited, resent)).toBe('same');
    // Just saved: the team now is the draft.
    expect(draftStatus(planning, edited, { ...edited })).toBe('refresh');
  });
});

describe('creating a missing working directory', () => {
  const missing = new ApiError('Working directory not found: /x', 404, 'cwd-missing');

  it('asks only when the directory is missing, then sends again with createCwd', async () => {
    const calls: boolean[] = [];
    const ask = vi.fn(() => true);
    const result = await orCreateCwd(async (create) => {
      calls.push(create);
      if (!create) throw missing;
      return 'saved';
    }, ask);
    expect(result).toBe('saved');
    expect(calls).toEqual([false, true]);
    expect(ask).toHaveBeenCalledOnce();

    // No error: no question.
    const quiet = vi.fn(() => true);
    expect(await orCreateCwd(async () => 'ok', quiet)).toBe('ok');
    expect(quiet).not.toHaveBeenCalled();
  });

  it('passes on other errors and a refusal without sending again', async () => {
    const notFound = new ApiError('Conversation not found', 404);
    const call = vi.fn(async (_create: boolean): Promise<string> => {
      throw notFound;
    });
    const ask = vi.fn(() => true);
    await expect(orCreateCwd(call, ask)).rejects.toBe(notFound);
    expect(ask).not.toHaveBeenCalled();

    const refused = vi.fn(async (_create: boolean): Promise<string> => {
      throw missing;
    });
    await expect(orCreateCwd(refused, () => false)).rejects.toBe(missing);
    expect(refused).toHaveBeenCalledOnce();
  });
});
