import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, AgentWorktree, ChatMessage, ConversationSettings, MessagePart } from '../src/shared/types';
import { confirmedUnanswered } from '../src/shared/types';
import { ApiError, api, orCreateCwd } from '../src/web/api';
import {
  activityCounts,
  afterStreamError,
  applyStates,
  BOTTOM_SLACK,
  branchSource,
  BUTTON_HOLD_MS,
  buttonHeld,
  draftStatus,
  enterSends,
  focusBoxAfterAnswer,
  FOLLOW_AGAIN,
  followsAfterScroll,
  isPathDetail,
  reviseRequest,
  revisedTeam,
  revisionOutcome,
  scrollSpot,
  segments,
  teamChanges,
  teamToEdit,
  teamTurns,
  thoughtTail,
  thoughtTitle,
  restoredText,
} from '../src/web/chat';
import type { Team } from '../src/web/components/TeamEditor';
import { clip, clipPath } from '../src/server/agents/types';

describe('a confirmed team that has not answered yet', () => {
  const plan = (id: string, more: Partial<NonNullable<ChatMessage['plan']>> = {}): ChatMessage => ({
    id,
    author: { kind: 'system' },
    createdAt: 1,
    status: 'done',
    parts: [],
    plan: { status: 'ready', lead: { provider: 'claude' }, ...more },
  });
  const user = (id: string): ChatMessage => ({ id, author: { kind: 'user' }, createdAt: 1, status: 'done', parts: [{ type: 'text', text: id }] });
  const agent = (id: string): ChatMessage => ({ id, author: { kind: 'agent', agentId: 'a1' }, agentName: 'Alice', createdAt: 1, status: 'done', parts: [] });

  it('is the latest design, confirmed, used at once or declined (the current team keeps the question), with no reply after it; not one for a schedule or waiting', () => {
    expect(confirmedUnanswered([user('q'), plan('p', { confirmedAt: 2 })])).toBe(true);
    expect(confirmedUnanswered([user('q'), plan('p', { confirmedAt: 2, autoConfirmed: true }), user('more')])).toBe(true);
    expect(confirmedUnanswered([user('q'), plan('p', { confirmedAt: 2 }), agent('r')])).toBe(false);
    expect(confirmedUnanswered([user('q'), plan('p', { confirmedAt: 2, forSchedule: true })])).toBe(false);
    expect(confirmedUnanswered([user('q'), plan('p', { awaitingConfirmation: true })])).toBe(false);
    expect(confirmedUnanswered([user('q'), plan('p', { declinedAt: 2 })])).toBe(true);
    expect(confirmedUnanswered([user('q'), plan('p', { confirmedAt: 2 }), agent('r'), user('q2'), plan('p2', { awaitingConfirmation: true })])).toBe(false);
    expect(confirmedUnanswered([user('q')])).toBe(false);
  });
});

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

describe('following new output in the messages', () => {
  // 2000px of messages in a 600px window: the bottom is at 1400.
  const at = (scrollTop: number, scrollHeight = 2000) => ({ scrollTop, scrollHeight, clientHeight: 600 });
  const was = (scrollTop: number, scrollHeight = 2000) => scrollSpot(at(scrollTop, scrollHeight));

  it('notes how far the list is scrolled and how far that is from the bottom', () => {
    expect(scrollSpot(at(1000))).toEqual({ top: 1000, distance: 400 });
  });

  it('follows once the reader reaches the bottom, give or take a fraction of a pixel', () => {
    expect(followsAfterScroll(false, was(1000), at(1400))).toBe(true);
    expect(followsAfterScroll(false, was(1000), at(1400 - BOTTOM_SLACK))).toBe(true);
    expect(followsAfterScroll(false, was(1000), at(1399.5))).toBe(true);
    // At the bottom without having moved: a short conversation, or the list already there.
    expect(followsAfterScroll(false, was(1400), at(1400))).toBe(true);
  });

  it('stops as soon as the reader scrolls up, however near the bottom', () => {
    expect(followsAfterScroll(true, was(1400), at(1380))).toBe(false);
    expect(followsAfterScroll(true, was(1400), at(1400 - BOTTOM_SLACK - 1))).toBe(false);
    expect(followsAfterScroll(true, was(1400), at(1300))).toBe(false);
  });

  it('keeps following while more comes in below and the list has not moved', () => {
    // It scrolled to 1400 to follow; a reply grew by 200px before the next scroll event or resize.
    expect(followsAfterScroll(true, was(1400), at(1400, 2200))).toBe(true);
    // A reader who stopped following is not pulled down by more coming in either.
    expect(followsAfterScroll(false, was(1000), at(1000, 2200))).toBe(false);
  });

  it('follows again when the reader scrolls down to near the bottom while more comes in', () => {
    // The scroll stopped at the bottom as it was (1400), and a line more came in before its event.
    expect(followsAfterScroll(false, was(1000), at(1400, 2030))).toBe(true);
    expect(followsAfterScroll(false, was(1000), at(1400 - FOLLOW_AGAIN))).toBe(true);
  });

  it('still does not follow while the reader scrolls down short of that', () => {
    expect(followsAfterScroll(false, was(1000), at(1400 - FOLLOW_AGAIN - 1))).toBe(false);
    expect(followsAfterScroll(false, was(1000), at(1300))).toBe(false);
  });

  it('does not take the browser keeping the reader in place for the reader scrolling down', () => {
    // 40px up, and 200px grew above: the browser moved the list down 200px (scroll anchoring), still 40px up.
    expect(followsAfterScroll(false, was(1360), at(1560, 2200))).toBe(false);
    // WebKit rounds each such move by a pixel.
    expect(followsAfterScroll(false, was(1360), at(1561, 2200))).toBe(false);
  });

  it('keeps following when shorter messages leave it at the new bottom', () => {
    // A reply folded away: the browser moved the list up to its new bottom.
    expect(followsAfterScroll(true, was(1400), at(1200, 1800))).toBe(true);
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
  changes: [{ root: '/r', base, head, files: [{ path: 'f', status: 'M', added: 1, deleted: 0 }], isolated: true, branch: `relay/c/${agentId}` }],
  ...extra,
});

const worktree = (agentId: string, base: string, needsReset = false, root = '/r'): AgentWorktree => ({
  root,
  path: `/wt/${agentId}${root === '/r' ? '' : `-${root.slice(1)}`}`,
  branch: `relay/c/${agentId}`,
  base,
  needsReset,
});

describe('the conversation a branch comes from', () => {
  const branch = { fromId: 'c1', fromTitle: 'Old title', afterId: 'm1' };

  it('is named by its title now, by the one it had once it is deleted, and taken to be there until the list loads', () => {
    expect(branchSource(branch, [{ id: 'c1', title: 'Renamed' }])).toEqual({ title: 'Renamed', gone: false });
    expect(branchSource(branch, [{ id: 'c2', title: 'Other' }])).toEqual({ title: 'Old title', gone: true });
    expect(branchSource(branch, undefined)).toEqual({ title: 'Old title', gone: false });
  });
});

describe('which worktree result can be applied', () => {
  it("offers each agent's latest result, including later rounds in the same worktree", () => {
    const messages = [result('a1', 'A', 'S1', 'h1'), result('b1', 'B', 'S1', 'k1'), result('a2', 'A', 'h1', 'h2')];
    const states = applyStates(messages, { A: [worktree('A', 'S1')], B: [worktree('B', 'S1')] });
    expect([...states]).toEqual([
      ['a2', 'available'],
      ['b1', 'available'],
    ]);
  });

  it('marks the latest result stale once a result was applied', () => {
    const states = applyStates([result('a1', 'A', 'S1', 'h1')], { A: [worktree('A', 'S1', true)] });
    expect(states.get('a1')).toBe('stale');
  });

  it('offers nothing from before the worktree was recreated (same branch, new base)', () => {
    // A result was applied, then the next parallel turn recreated the worktrees from snapshot S2;
    // A has made no changes since, so its old card must not offer Apply again.
    const messages = [result('a1', 'A', 'S1', 'h1'), result('b2', 'B', 'S2', 'k2')];
    const states = applyStates(messages, { A: [worktree('A', 'S2')], B: [worktree('B', 'S2')] });
    expect(states.has('a1')).toBe(false);
    expect(states.get('b2')).toBe('available');
  });

  it('ignores streaming replies, shared-directory changes and agents without a worktree', () => {
    const shared = result('s', 'A', 'S1', 'x');
    shared.changes = [{ ...shared.changes![0]!, isolated: false }];
    const messages = [result('a1', 'A', 'S1', 'h1'), shared, result('a2', 'A', 'h1', 'h2', { status: 'streaming' }), result('c1', 'C', 'S1', 'z')];
    const states = applyStates(messages, { A: [worktree('A', 'S1')] });
    expect([...states]).toEqual([['a1', 'available']]);
  });

  it('with several working directories: current only while every repository it changed is, stale once any worktree needs a reset', () => {
    const both = result('a1', 'A', 'S1', 'h1');
    both.changes = [...both.changes!, { ...both.changes![0]!, root: '/q', base: 'Q1', head: 'q1' }];
    const onlyQ = result('a2', 'A', 'S1', 'h1');
    onlyQ.changes = [{ ...onlyQ.changes![0]!, root: '/q', base: 'Q1', head: 'q2' }];
    const wts = (q: string, reset = false) => ({ A: [worktree('A', 'S1'), worktree('A', q, reset, '/q')] });
    expect(applyStates([both], wts('Q1')).get('a1')).toBe('available');
    // The worktree of /q was made again from another snapshot: the result is not in it any more.
    expect(applyStates([both], wts('Q2')).has('a1')).toBe(false);
    // A turn that changed /q only is the latest result.
    expect([...applyStates([both, onlyQ], wts('Q1'))]).toEqual([['a2', 'available']]);
    expect(applyStates([both], wts('Q1', true)).get('a1')).toBe('stale');
  });
});

const settings: ConversationSettings = { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'edit', cwd: '/p', autoTeam: true };
const planning: Team = { agents: [], settings };
const designed: Team = {
  agents: [{ id: 'x', name: 'Builder', provider: 'codex', role: 'builds' }],
  settings: { ...settings, mode: 'parallel', rounds: 2, autoTeam: false },
};

describe('the team the team drawer edits', () => {
  const current = [{ id: 'a', name: 'Alice', provider: 'claude' as const, role: '' }];
  const proposal = [{ id: 'z', name: 'Zed', provider: 'codex' as const, role: 'New.' }];
  const conv = { agents: current, settings: { mode: 'roundtable' as const, rounds: 1, maxHops: 8, permission: 'edit' as const, cwd: '/p', autoTeam: true } };

  it("is the lead agent's design while it waits for confirmation, with how it takes turns", () => {
    const pending = { status: 'ready' as const, lead: { provider: 'claude' as const }, agents: proposal, settings: { mode: 'relay' as const, rounds: 1, maxHops: 4 }, awaitingConfirmation: true };
    expect(teamToEdit(conv, pending)).toEqual({
      team: { agents: proposal, settings: { ...conv.settings, mode: 'relay', maxHops: 4 } },
      proposed: true,
    });
  });

  it('is the current team otherwise', () => {
    expect(teamToEdit(conv)).toEqual({ team: { agents: current, settings: conv.settings }, proposed: false });
  });
});

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

describe("the lead agent's change in the team drawer", () => {
  const settings = { mode: 'roundtable' as const, rounds: 1, maxHops: 8, permission: 'edit' as const, cwd: '/work', approvals: 'deny' as const };
  const alice: AgentConfig = { id: 'a', name: 'Alice', provider: 'claude', role: 'Lead.\n', model: '', effort: '', tools: { memory: false } };
  const bob: AgentConfig = { id: 'b', name: 'Bob', provider: 'codex', role: 'Build.', model: 'gpt-5' };
  const draft = { agents: [alice, bob], settings };
  /** The team as the server sends it back: empty values dropped, roles as the lead copied them. */
  const asServer = (a: AgentConfig): AgentConfig => ({ ...a, role: a.role.trim(), model: a.model || undefined, effort: a.effort || undefined });

  it("sends the members, how they take turns, and the drawer's permission and folder", () => {
    expect(teamTurns(draft)).toEqual({ agents: draft.agents, settings: { mode: 'roundtable', rounds: 1, maxHops: 8 } });
    expect(reviseRequest('add a tester', draft)).toEqual({
      request: 'add a tester',
      agents: draft.agents,
      settings: { mode: 'roundtable', rounds: 1, maxHops: 8, permission: 'edit', cwd: '/work' },
    });
  });

  it('sees no change in a team that works the same (empty model, space around a role)', () => {
    const back = { agents: draft.agents.map(asServer), settings: { mode: 'roundtable' as const, rounds: 1, maxHops: 8 } };
    expect(teamChanges(draft, revisedTeam(draft, back))).toEqual([]);
    // The drawer keeps its own members, so nothing looks edited afterwards.
    expect(revisedTeam(draft, back).agents[0]).toBe(alice);
    expect(revisionOutcome({ sent: draft, now: draft, blocked: false, revision: back })).toEqual({ kind: 'unchanged' });
  });

  it('lists every change: members added, removed, renamed, moved, with another role or model; order; mode and its count', () => {
    const tester: AgentConfig = { id: 't', name: 'Tester', provider: 'grok', role: 'Test.' };
    const after = revisedTeam(draft, {
      agents: [{ ...asServer(bob), name: 'Builder', provider: 'claude', model: 'opus', role: 'Build it all.' }, tester],
      settings: { mode: 'relay', rounds: 1, maxHops: 4 },
    });
    expect(teamChanges(draft, after)).toEqual([
      { kind: 'renamed', from: 'Bob', name: 'Builder' },
      { kind: 'cli', name: 'Builder', provider: 'claude' },
      { kind: 'role', name: 'Builder' },
      { kind: 'model', name: 'Builder' },
      { kind: 'added', name: 'Tester', provider: 'grok' },
      { kind: 'removed', name: 'Alice' },
      { kind: 'mode', mode: 'relay' },
      { kind: 'hops', maxHops: 4 },
    ]);
    const swapped = revisedTeam(draft, { agents: [bob, alice], settings: { mode: 'roundtable', rounds: 3, maxHops: 8 } });
    expect(teamChanges(draft, swapped)).toEqual([{ kind: 'order' }, { kind: 'rounds', rounds: 3 }]);
    // Only what is counted in the mode: hand-offs do not matter in roundtable.
    expect(teamChanges(draft, revisedTeam(draft, { agents: draft.agents, settings: { mode: 'roundtable', rounds: 1, maxHops: 20 } }))).toEqual([]);
  });

  it('holds the button a moment after it switches, so a double-click or a late click on Stop does nothing', () => {
    expect(buttonHeld(undefined, 1_000)).toBe(false);
    expect(buttonHeld(1_000, 1_100)).toBe(true);
    expect(buttonHeld(1_000, 1_000 + BUTTON_HOLD_MS)).toBe(false);
  });

  it('moves the focus to the request box after an answer only when it would be lost', () => {
    expect(focusBoxAfterAnswer({ onPage: true, onButton: false, buttonDisabled: false })).toBe(true);
    expect(focusBoxAfterAnswer({ onPage: false, onButton: true, buttonDisabled: true })).toBe(true);
    // Still on the button, which can be used again; or elsewhere in the drawer.
    expect(focusBoxAfterAnswer({ onPage: false, onButton: true, buttonDisabled: false })).toBe(false);
    expect(focusBoxAfterAnswer({ onPage: false, onButton: false, buttonDisabled: true })).toBe(false);
  });

  it("shows the lead's team only when the drawer still has the team it changed, and can save it", () => {
    const revision = { agents: [alice, bob, { id: 't', name: 'Tester', provider: 'claude' as const, role: '' }], settings: draft.settings };
    const changed = revisionOutcome({ sent: draft, now: draft, blocked: false, revision });
    expect(changed).toMatchObject({ kind: 'changed', changes: [{ kind: 'added', name: 'Tester' }] });
    expect(changed.kind === 'changed' && changed.team.settings).toEqual(settings);
    // The drawer loaded another team meanwhile, or can no longer save its own.
    const reloaded = { ...draft, agents: [bob] };
    expect(revisionOutcome({ sent: draft, now: reloaded, blocked: false, revision })).toEqual({ kind: 'stale' });
    expect(revisionOutcome({ sent: draft, now: draft, blocked: true, revision })).toEqual({ kind: 'stale' });
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

describe("an agent's work between its words", () => {
  const tool = (id: string, status: 'running' | 'done' | 'error' = 'done'): MessagePart => ({ type: 'tool', id, name: 'Bash', status });
  const think = (text: string): MessagePart => ({ type: 'thinking', text });
  const text = (t: string): MessagePart => ({ type: 'text', text: t });

  it('makes one activity row of tool calls and thinking that follow each other', () => {
    const segs = segments([
      text('Looking at the permission logic.'),
      tool('a'),
      think('**Checking callerSecrets**\nIt is read before the hash check.'),
      tool('b'),
      think('Next, the SQL pairs PR.'),
      tool('c', 'error'),
      text('Here is what I found.'),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'activity', 'text']);
    const activity = segs[1];
    if (activity.kind !== 'activity') throw new Error('expected activity');
    expect(activity.items.map((i) => i.kind)).toEqual(['tool', 'thinking', 'tool', 'thinking', 'tool']);
    expect(activity.key).toBe(1);
    expect(activity.last).toBe(false);
    expect(activityCounts(activity.items)).toEqual({ actions: 3, thoughts: 2, failed: 1 });
  });

  it('is not split by blank text or blank thinking, but is by plans and approvals', () => {
    const segs = segments([
      tool('a'),
      text('\n\n'),
      think('  '),
      tool('b'),
      { type: 'plan', entries: [{ text: 'Read the PR', status: 'in_progress' }] },
      tool('c'),
      { type: 'approval', id: 'x', kind: 'command', status: 'pending' } as MessagePart,
      think('Waiting.'),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(['activity', 'todo', 'activity', 'approval', 'activity']);
    expect(segs.map((s) => (s.kind === 'activity' ? s.items.length : 0))).toEqual([2, 0, 1, 0, 1]);
  });

  it('keeps its key while steps stream in, and marks the row that ends the message', () => {
    const first = segments([text('On it.'), tool('a', 'running')]);
    const later = segments([text('On it.'), tool('a'), think('Hmm.'), tool('b', 'running')]);
    expect(first[1]).toMatchObject({ kind: 'activity', key: 1, last: true });
    expect(later[1]).toMatchObject({ kind: 'activity', key: 1, last: true });
    expect(segments([tool('a'), text('Done.')])[0]).toMatchObject({ kind: 'activity', last: false });
  });

  it('names a stretch of thinking by its first line and follows its latest line', () => {
    const t = '\n**Examining the hash check**\n\nThe hash is compared after\n## the secrets load\n';
    expect(thoughtTitle(t)).toBe('Examining the hash check');
    expect(thoughtTail(t)).toBe('the secrets load');
    expect(thoughtTitle('   ')).toBe('');
  });

  it('tells a path apart from the other details a tool row shows', () => {
    const paths = [
      '/Users/me/repo/src/server/orchestrator.ts',
      'src/web/chat.ts',
      '~/notes',
      './build.sh',
      'app/(marketing)/[id]/page.tsx',
      'C:\\repo\\a.ts',
      '\\\\server\\share\\a.ts',
      // The server cut a long path's start: a path even with a space in it.
      '…/scratchpad/SKILL.md',
      '…/My Docs/a.ts',
      '…\\repo\\a.ts',
    ];
    for (const path of paths) expect(isPathDetail(path), path).toBe(true);
    const others = [
      'npm test',
      'git -C /repo status',
      'relay|handoff',
      'https://example.org/docs',
      'vitest mock timers',
      // A regex's escapes are not Windows paths.
      'capture\\(|track\\(',
      'foo\\.ts',
      // A command the server cut at its end: what is left of it is not a path.
      'F=/private/tmp/a/b/c/05-middle.md;…',
      '/private/tmp/' + 'a/'.repeat(70) + '…',
      'F=/private/tmp/a.md',
      'src/**/*.ts',
      // A path with a space in it that the server did not cut.
      '/Users/me/My Docs/a.ts',
    ];
    for (const other of others) expect(isPathDetail(other), other).toBe(false);
  });

  it('takes every long path the server cut for a path, and every other detail it cut for none', () => {
    const long = [
      '/private/tmp/' + 'folder-with-a-long-name/'.repeat(8) + 'grok-survey.mts',
      '/Users/me/Library/Application Support/' + 'some folder/'.repeat(14) + 'Control.log',
      `/repo/${'n'.repeat(200)}.ts`,
      `/${'f'.repeat(200)}/src/a.ts`,
      '/' + 'x'.repeat(200) + '/',
      'C:\\repo\\' + 'folder\\'.repeat(30) + 'a.ts',
    ];
    for (const path of long) {
      expect(path.length).toBeGreaterThan(160);
      expect(isPathDetail(clipPath(path)), path).toBe(true);
      // A command, a query or a pattern over the limit is cut at its end, and is no path.
      expect(isPathDetail(clip(path + ' --verbose')), path).toBe(false);
      expect(isPathDetail(clip(path.replace(/[\\/ ]/g, '_'))), path).toBe(false);
    }
  });
});

describe('text that comes into the message box', () => {
  it('puts a withdrawn message back ahead of what is typed, even when the box has the same words', () => {
    expect(restoredText('', { text: 'ok' })).toBe('ok');
    expect(restoredText('  ', { text: 'ok' })).toBe('ok');
    expect(restoredText('ok, and also this', { text: 'ok' })).toBe('ok\nok, and also this');
  });

  it("does not add a lead review's next step the box has already", () => {
    expect(restoredText('', { text: '@Bob add tests', once: true })).toBe('@Bob add tests');
    expect(restoredText('@Bob add tests', { text: '@Bob add tests', once: true })).toBe('@Bob add tests');
    expect(restoredText('and docs', { text: '@Bob add tests', once: true })).toBe('@Bob add tests\nand docs');
  });
});
