import { describe, expect, it, vi } from 'vitest';
import { OPEN_PROVIDERS, PROVIDERS, type ChatMessage, type Conversation, type MessagePart, type Provider } from '../src/shared/types';
import {
  AGENTSVIEW_SESSIONS,
  AgentsViewSync,
  agentSessionIds,
  agentsViewSessionId,
  fallbackProject,
  memberSessionId,
  memberTranscript,
  memberTranscripts,
  recordedMembers,
  recordedSession,
  threadTranscript,
  toolUse,
} from '../src/server/agentsview';

const BASE = 'http://127.0.0.1:9999';

function message(id: string, author: ChatMessage['author'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, author, createdAt: Date.UTC(2026, 10, 8, 12, 0, Number(id.replace(/\D/g, '')) || 0), parts: [{ type: 'text', text }], status: 'done', ...extra };
}

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c0ffee00-0000-4000-8000-000000000001',
    title: 'Plan the release',
    createdAt: 0,
    updatedAt: 0,
    agents: [
      { id: 'a', name: 'Claude', provider: 'claude', role: '' },
      { id: 'b', name: 'Codex', provider: 'codex', role: '' },
      { id: 'g', name: 'Grok', provider: 'grok', role: '' },
    ],
    settings: { mode: 'parallel', rounds: 1, maxHops: 3, permission: 'read-only', cwd: '/work/chats' },
    messages: [
      message('m1', { kind: 'user' }, 'What should we ship?', {
        parts: [
          { type: 'text', text: 'What should we ship?' },
          { type: 'attachment', id: 'f1', name: 'notes.md', mimeType: 'text/markdown', size: 3 },
        ],
      }),
      message('m2', { kind: 'agent', agentId: 'a' }, 'The search page.', { agentName: 'Claude', provider: 'claude' }),
      message('m3', { kind: 'system' }, 'Stopped'),
      message('m4', { kind: 'agent', agentId: 'b' }, '', { provider: 'codex', status: 'error', error: 'rate limited', parts: [] }),
      message('m5', { kind: 'agent', agentId: 'g' }, 'still typing', { status: 'streaming' }),
    ],
    agentState: {
      a: { provider: 'claude', sessionId: '977d79d5-4d98-4e2a-9a1d-20fe70d1417e', seen: [] },
      b: { provider: 'codex', sessionId: '01a1bb71-4292', seen: [] },
      g: { provider: 'grok', sessionId: '01a1bb71-42e0', seen: [] },
      gone: { seen: [] },
    },
    worktrees: {},
    ...over,
  };
}

const records = (jsonl: string) => jsonl.trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);

describe('the thread transcript', () => {
  it("is the conversation as a Claude Code transcript: the user's turns, each agent's reply under its name, then the title", () => {
    const conv = conversation();
    const r = records(threadTranscript(conv));
    expect(r.map((x) => x.type)).toEqual(['user', 'assistant', 'assistant', 'custom-title']);

    expect(r[0]).toMatchObject({
      uuid: 'm1',
      parentUuid: null,
      sessionId: conv.id,
      cwd: '/work/chats',
      timestamp: '2026-11-08T12:00:01.000Z',
      message: { role: 'user', content: 'What should we ship?\n\n[notes.md]' },
    });
    expect(r[1]).toMatchObject({ uuid: 'm2', parentUuid: 'm1', message: { role: 'assistant' } });
    expect(r[1]!.message.content[0].text).toBe('**Claude** · claude\n\nThe search page.');
    // A failed reply says why; system notes and replies still streaming are left out.
    expect(r[2]).toMatchObject({ uuid: 'm4', parentUuid: 'm2' });
    expect(r[2]!.message.content[0].text).toBe('**Codex** · codex\n\n(rate limited)');
    expect(r[3]).toEqual({ type: 'custom-title', customTitle: 'Plan the release', sessionId: conv.id });
  });

  it('is empty while nothing has been said', () => {
    expect(threadTranscript(conversation({ messages: [] }))).toBe('');
    expect(threadTranscript(conversation({ messages: [message('m1', { kind: 'system' }, 'note')] }))).toBe('');
  });
});

describe("the agents' sessions", () => {
  it("are named the way AgentsView names them: Claude Code's by id, the others with a prefix", () => {
    expect(agentsViewSessionId('claude', 'abc')).toBe('abc');
    expect(agentsViewSessionId('codex', 'abc')).toBe('codex:abc');
    expect(agentsViewSessionId('grok', 'abc')).toBe('grok:abc');
    expect(agentSessionIds(conversation())).toEqual(['977d79d5-4d98-4e2a-9a1d-20fe70d1417e', 'codex:01a1bb71-4292', 'grok:01a1bb71-42e0']);
  });

  it("names Antigravity's as AgentsView's Antigravity CLI does, after its conversation's file", () => {
    expect(agentsViewSessionId('antigravity', 'c3471ccd')).toBe('antigravity-cli:c3471ccd');
    const conv = conversation();
    conv.agentState.ag = { provider: 'antigravity', sessionId: 'c3471ccd', seen: [] };
    expect(agentSessionIds(conv)).toContain('antigravity-cli:c3471ccd');
  });

  it("names Copilot's as AgentsView's Copilot does, after its session-state folder", () => {
    expect(agentsViewSessionId('copilot', 'da742fbc')).toBe('copilot:da742fbc');
    const conv = conversation();
    conv.agentState.cp = { provider: 'copilot', sessionId: 'da742fbc', seen: [] };
    expect(agentSessionIds(conv)).toContain('copilot:da742fbc');
  });

  it("names Muse Code's as AgentsView's Muse Code does, after its session's id", () => {
    expect(agentsViewSessionId('muse', '01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7')).toBe('muse:01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7');
    expect(recordedSession('muse')).toBe(false);
    const conv = conversation();
    conv.agentState.mu = { provider: 'muse', sessionId: '01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7', seen: [] };
    expect(agentSessionIds(conv)).toContain('muse:01a1d2b6-32bc-7741-9ad9-901d5dc0d0c7');
  });

  it("leaves out Cursor's and the open agents', which AgentsView cannot read where they are: Harness Relay records those itself", () => {
    const recorded = PROVIDERS.filter(recordedSession);
    expect(recorded).toEqual(['cursor', ...OPEN_PROVIDERS]);
    const conv = conversation();
    for (const p of recorded) {
      expect(agentsViewSessionId(p, 'abc')).toBeUndefined();
      conv.agentState[p] = { provider: p, sessionId: `${p}-1`, seen: [] };
    }
    expect(agentSessionIds(conv)).toEqual(['977d79d5-4d98-4e2a-9a1d-20fe70d1417e', 'codex:01a1bb71-4292', 'grok:01a1bb71-42e0']);
    // Every CLI is one or the other.
    for (const p of PROVIDERS) expect(AGENTSVIEW_SESSIONS[p]).toBeDefined();
  });

  it('has none for a CLI this build does not know (a newer one wrote the data), and throws nothing', () => {
    const later = 'kiro' as Provider;
    expect(agentsViewSessionId(later, 'abc')).toBeUndefined();
    expect(recordedSession(later)).toBe(false);
    const conv = conversation();
    conv.agentState.k = { provider: later, sessionId: 'k-1', seen: [] };
    conv.messages.push(message('m6', { kind: 'agent', agentId: 'k' }, 'Hi.', { agentName: 'Kiro', provider: later }));
    expect(agentSessionIds(conv)).toHaveLength(3);
    expect(recordedMembers(conv)).toEqual([]);
    expect(threadTranscript(conv)).toContain('**Kiro** · kiro');
  });
});

/** A team with a Cursor member, an OpenCode member and Claude Code. */
function recordedTeam(): Conversation {
  return conversation({
    agents: [
      { id: 'cur', name: 'Reviewer', provider: 'cursor', role: '', model: 'claude-opus-5-5' },
      { id: 'oc', name: 'Builder', provider: 'opencode', role: '' },
      { id: 'a', name: 'Claude', provider: 'claude', role: '' },
    ],
    messages: [
      message('m1', { kind: 'user' }, 'Fix the failing test'),
      message('m2', { kind: 'agent', agentId: 'a' }, 'It is the date parser.', { agentName: 'Claude', provider: 'claude' }),
      message('m3', { kind: 'agent', agentId: 'cur' }, '', {
        agentName: 'Reviewer',
        provider: 'cursor',
        meta: { inputTokens: 1200, outputTokens: 300, costUsd: 0.0123456789 },
        parts: [
          { type: 'thinking', text: 'Look at the test first.' },
          { type: 'tool', id: 't1', name: 'Shell', detail: 'npm test', kind: 'execute', status: 'done', output: '1 failed' },
          { type: 'tool', id: 't2', name: 'Read', detail: 'src/date.ts', kind: 'read', status: 'error', error: 'not found' },
          { type: 'approval', id: 'p1', kind: 'command', detail: 'rm -rf dist', status: 'denied', note: 'not now' },
          { type: 'text', text: 'Claude is right: the parser drops the zone.' },
          { type: 'plan', entries: [{ text: 'Fix it', status: 'in_progress' }, { text: 'Test it', status: 'pending' }] },
        ],
      }),
      message('m4', { kind: 'user' }, 'Go ahead'),
      message('m5', { kind: 'agent', agentId: 'oc' }, 'Done.', { agentName: 'Builder', provider: 'opencode', meta: { inputTokens: 50, outputTokens: 5 } }),
      message('m6', { kind: 'agent', agentId: 'cur' }, '', { agentName: 'Reviewer', provider: 'cursor', parts: [], passed: true }),
      message('m7', { kind: 'agent', agentId: 'cur' }, '', { agentName: 'Reviewer', provider: 'cursor', parts: [], status: 'error', error: 'signed out' }),
      message('m8', { kind: 'agent', agentId: 'oc' }, 'still typing', { provider: 'opencode', status: 'streaming' }),
    ],
    agentState: {
      cur: { provider: 'cursor', sessionId: 'cursor-session', seen: [] },
      oc: { provider: 'opencode', sessionId: 'ses_1', seen: [] },
      a: { provider: 'claude', sessionId: '977d79d5-4d98-4e2a-9a1d-20fe70d1417e', seen: [] },
    },
  });
}

describe("a member's recorded session", () => {
  it('is a Claude Code transcript of its replies: what it heard, its thinking, tool calls and their results, approvals, text, plan', () => {
    const conv = recordedTeam();
    const id = memberSessionId(conv.id, 'cur');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const r = records(memberTranscript(conv, 'cur'));
    expect(r.map((x) => x.type)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'assistant', 'cost-state', 'custom-title']);
    for (const x of r.filter((x) => x.type === 'user' || x.type === 'assistant')) {
      expect(x).toMatchObject({ sessionId: id, cwd: '/work/chats', isSidechain: false, userType: 'external' });
    }

    // What was said before its first reply, the other agents' replies under their names.
    expect(r[0]).toMatchObject({ parentUuid: null, timestamp: '2026-11-08T12:00:03.000Z' });
    expect(r[0]!.message.content).toBe('Fix the failing test\n\n**Claude** · claude\n\nIt is the date parser.');
    // Its thinking and tool calls, then their results, then what it said after them.
    expect(r[1]!.message).toMatchObject({ role: 'assistant', model: 'claude-opus-5-5' });
    const [thinking, shell, read] = r[1]!.message.content;
    expect(thinking).toEqual({ type: 'thinking', thinking: 'Look at the test first.' });
    // As Claude Code's tools, which AgentsView shows with their command and file (`toolUse`).
    expect(shell).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'npm test', tool: 'Shell' } });
    expect(read).toMatchObject({ type: 'tool_use', name: 'Read', input: { file_path: 'src/date.ts' } });
    expect(r[2]!.message.content).toEqual([
      { type: 'tool_result', tool_use_id: shell.id, content: '1 failed' },
      { type: 'tool_result', tool_use_id: read.id, content: 'not found', is_error: true },
    ]);
    // The reply's tokens on its last assistant message, for AgentsView to count.
    expect(r[1]!.message.usage).toBeUndefined();
    expect(r[3]!.message.usage).toEqual({ input_tokens: 1200, output_tokens: 300 });
    expect(r[3]!.message.content).toEqual([
      { type: 'text', text: '[Asked to run `rm -rf dist`: declined: "not now"]' },
      { type: 'text', text: 'Claude is right: the parser drops the zone.' },
      { type: 'text', text: 'Plan:\n[~] Fix it\n[ ] Test it' },
    ]);
    // Then the user and the other member, and its later replies: a [PASS], a failure.
    expect(r[4]!.message.content).toBe('Go ahead\n\n**Builder** · opencode\n\nDone.');
    expect(r[5]!.message.content).toEqual([{ type: 'text', text: '[PASS]' }]);
    expect(r[6]!.message.content).toEqual([{ type: 'text', text: '(signed out)' }]);

    // One chain of records with ids of their own, never the thread's message ids.
    const uuids = r.filter((x) => x.uuid).map((x) => x.uuid);
    expect(new Set(uuids).size).toBe(uuids.length);
    for (const u of uuids) expect(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']).not.toContain(u);
    r.slice(1, 7).forEach((x, i) => expect(x.parentUuid).toBe(r[i]!.uuid));

    expect(r[5]!.message.usage).toBeUndefined();
    // The cost the CLI reported, as the session's total (AgentsView keeps it apart from its own figures), and its name.
    expect(r[7]).toEqual({
      type: 'cost-state',
      sessionId: id,
      totalCostUSD: 0.012346,
      hasUnknownModelCost: false,
      modelUsage: { 'claude-opus-5-5': { inputTokens: 1200, outputTokens: 300, costUSD: 0.012346 } },
    });
    expect(r[8]).toEqual({ type: 'custom-title', customTitle: 'Reviewer · Cursor — Plan the release', sessionId: id });

    // The same conversation gives the same session.
    expect(memberTranscript(conv, 'cur')).toBe(memberTranscript(recordedTeam(), 'cur'));
  });

  it("names the CLI as the model when the member has none set, and says when a reply's cost is unknown", () => {
    const r = records(memberTranscript(recordedTeam(), 'oc'));
    expect(r.map((x) => x.type)).toEqual(['user', 'assistant', 'cost-state', 'custom-title']);
    // What it heard is what the thread shows: the Reviewer's text, never its thinking or its tools' output.
    expect(r[0]!.message.content).toBe(
      'Fix the failing test\n\n**Claude** · claude\n\nIt is the date parser.\n\n**Reviewer** · cursor\n\nClaude is right: the parser drops the zone.\n\nGo ahead',
    );
    expect(r[1]!.message).toMatchObject({ model: 'opencode', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 50, output_tokens: 5 } });
    // No cost reported: none claimed (AgentsView would take a 0 as one).
    expect(r.at(-2)).toEqual({ type: 'cost-state', sessionId: memberSessionId(recordedTeam().id, 'oc'), hasUnknownModelCost: true, modelUsage: { opencode: { inputTokens: 50, outputTokens: 5 } } });
    expect(r.at(-1)!.customTitle).toBe('Builder · OpenCode — Plan the release');
  });

  it("holds only the member's replies on a CLI AgentsView cannot read: those on another CLI are what it heard", () => {
    const conv = recordedTeam();
    // The Cursor member answered on Claude Code before (its own session there is AgentsView's own).
    conv.messages.splice(1, 0, message('m1b', { kind: 'agent', agentId: 'cur' }, 'Earlier, on Claude.', { agentName: 'Reviewer', provider: 'claude' }));
    const r = records(memberTranscript(conv, 'cur'));
    expect(r[0]!.message.content).toContain('**Reviewer** · claude\n\nEarlier, on Claude.');
    expect(memberTranscript(conv, 'a')).toBe('');
    expect(memberTranscript(conversation(), 'a')).toBe('');
  });

  it('puts what an agent says or how it ended after the results of the tool calls before it', () => {
    const conv = conversation({
      agents: [{ id: 'p', name: 'Pi', provider: 'pi', role: '' }],
      messages: [
        message('m1', { kind: 'user' }, 'Go'),
        message('m2', { kind: 'agent', agentId: 'p' }, '', {
          provider: 'pi',
          passed: true,
          parts: [
            { type: 'tool', id: 't1', name: 'bash', status: 'done', output: 'ok' },
            { type: 'thinking', text: 'Nothing to add.' },
            { type: 'tool', id: 't2', name: 'read', detail: 'a.md', status: 'running' },
          ],
        }),
        message('m3', { kind: 'agent', agentId: 'p' }, '', {
          provider: 'pi',
          status: 'error',
          error: 'timed out',
          parts: [{ type: 'tool', id: 't3', name: 'bash', detail: 'sleep 99', status: 'error' }],
        }),
      ],
    });
    const r = records(memberTranscript(conv, 'p'));
    expect(r.map((x) => [x.type, x.message?.content.map?.((b: { type: string }) => b.type) ?? x.message?.content])).toEqual([
      ['user', 'Go'],
      ['assistant', ['tool_use']],
      ['user', ['tool_result']],
      ['assistant', ['thinking', 'tool_use']],
      ['user', ['tool_result']],
      ['assistant', ['text']],
      ['assistant', ['tool_use']],
      ['user', ['tool_result']],
      ['assistant', ['text']],
      ['custom-title', undefined],
    ]);
    // A call still running when the turn ended has no output; one that failed without saying why, none either.
    expect(r[4]!.message.content[0]).toEqual({ type: 'tool_result', tool_use_id: r[3]!.message.content[1].id, content: '' });
    expect(r[5]!.message.content).toEqual([{ type: 'text', text: '[PASS]' }]);
    expect(r[7]!.message.content[0]).toMatchObject({ content: '', is_error: true });
    expect(r[8]!.message.content).toEqual([{ type: 'text', text: '(timed out)' }]);
    // No tokens recorded: no usage and no cost record.
    expect(r.some((x) => x.message?.usage || x.type === 'cost-state')).toBe(false);
  });

  it("names the CLI as the model once the member has left the team or moved to another CLI", () => {
    const left = recordedTeam();
    left.agents = left.agents.filter((a) => a.id !== 'cur');
    expect(records(memberTranscript(left, 'cur'))[1]!.message.model).toBe('cursor');
    // The member's own name and CLI come from its replies, as the thread has them.
    expect(records(memberTranscript(left, 'cur')).at(-1)!.customTitle).toBe('Reviewer · Cursor — Plan the release');
    const moved = recordedTeam();
    moved.agents[0] = { ...moved.agents[0]!, provider: 'goose', model: 'gpt-x' };
    expect(records(memberTranscript(moved, 'cur'))[1]!.message.model).toBe('cursor');
  });

  it("shows each kind of call as Claude Code's tool for it, with the CLI's own name kept, and any other as it is", () => {
    const call = (over: Partial<Extract<MessagePart, { type: 'tool' }>>): Extract<MessagePart, { type: 'tool' }> => ({ type: 'tool', id: 't', name: 'tool', status: 'done', ...over });
    expect(toolUse(call({ name: 'developer: shell', kind: 'execute', detail: 'ls -la' }))).toEqual({ name: 'Bash', input: { command: 'ls -la', tool: 'developer: shell' } });
    expect(toolUse(call({ name: 'file_editor view', kind: 'read', detail: '/w/a.ts' }))).toEqual({ name: 'Read', input: { file_path: '/w/a.ts', tool: 'file_editor view' } });
    expect(toolUse(call({ name: 'Edit', kind: 'edit', detail: '/w/a.ts' }))).toEqual({ name: 'Edit', input: { file_path: '/w/a.ts' } });
    expect(toolUse(call({ name: 'Grep', kind: 'search', detail: 'TODO' }))).toEqual({ name: 'Grep', input: { pattern: 'TODO' } });
    // A search of the web is not one of the files.
    expect(toolUse(call({ name: 'web_search', kind: 'search', detail: 'node 24 release' }))).toEqual({ name: 'WebSearch', input: { query: 'node 24 release', tool: 'web_search' } });
    expect(toolUse(call({ name: 'fetch', kind: 'fetch', detail: 'https://example.com' }))).toEqual({ name: 'WebFetch', input: { url: 'https://example.com', tool: 'fetch' } });
    // A call without a detail has none to show.
    expect(toolUse(call({ name: 'Shell', kind: 'execute' }))).toEqual({ name: 'Bash', input: { tool: 'Shell' } });
    // Kinds Claude Code has no tool for, and calls whose CLI did not say: under the CLI's name.
    expect(toolUse(call({ name: 'Delete', kind: 'delete', detail: 'old.txt' }))).toEqual({ name: 'Delete', input: { detail: 'old.txt' } });
    expect(toolUse(call({ name: 'Think', kind: 'think' }))).toEqual({ name: 'Think', input: {} });
    expect(toolUse(call({ name: 'mcp__shout__shout', detail: '{"text":"hi"}' }))).toEqual({ name: 'mcp__shout__shout', input: { detail: '{"text":"hi"}' } });
  });

  it('writes every approval, attachment and plan as text, and leaves out empty text and thinking', () => {
    const conv = conversation({
      title: '',
      agents: [{ id: 'g', name: 'Goose', provider: 'goose', role: '' }],
      messages: [
        message('m1', { kind: 'user' }, 'Go'),
        message('m2', { kind: 'agent', agentId: 'g' }, '', {
          agentName: 'Goose',
          provider: 'goose',
          parts: [
            { type: 'text', text: '   ' },
            { type: 'thinking', text: '\n' },
            { type: 'approval', id: 'p1', kind: 'other', tool: 'github__create_issue', status: 'allowed', always: true },
            { type: 'approval', id: 'p2', kind: 'other', status: 'pending' },
            { type: 'approval', id: 'p3', kind: 'edit', detail: 'a.ts', status: 'expired' },
            { type: 'approval', id: 'p4', kind: 'fetch', detail: 'https://example.com', status: 'allowed' },
            { type: 'attachment', id: 'f1', name: 'chart.png', mimeType: 'image/png', size: 9 },
            { type: 'plan', entries: [] },
            { type: 'plan', entries: [{ text: 'Ship', status: 'completed' }] },
          ],
        }),
      ],
    });
    const r = records(memberTranscript(conv, 'g'));
    expect(r[1]!.message.content).toEqual([
      { type: 'text', text: '[Asked to use github__create_issue: allowed for the rest of the conversation]' },
      { type: 'text', text: '[Asked to use a tool: not answered]' },
      { type: 'text', text: '[Asked to edit `a.ts`: expired]' },
      { type: 'text', text: '[Asked to fetch `https://example.com`: allowed]' },
      { type: 'text', text: '[chart.png]' },
      { type: 'text', text: 'Plan:\n[x] Ship' },
    ]);
    // An untitled conversation: the member's name and CLI alone.
    expect(r.at(-1)!.customTitle).toBe('Goose · Goose');
  });

  it('carries what it heard over a reply that left nothing to show, and has no session for a member with only such replies', () => {
    const conv = conversation({
      agents: [
        { id: 'p', name: 'Pi', provider: 'pi', role: '' },
        { id: 'c', name: 'Cline', provider: 'cline', role: '' },
      ],
      messages: [
        message('m1', { kind: 'user' }, 'First'),
        message('m2', { kind: 'agent', agentId: 'p' }, '', { provider: 'pi', parts: [{ type: 'text', text: ' ' }] }),
        message('m3', { kind: 'agent', agentId: 'c' }, '', { provider: 'cline', parts: [] }),
        message('m4', { kind: 'user' }, 'Second'),
        message('m5', { kind: 'agent', agentId: 'p' }, 'Both heard.', { provider: 'pi' }),
      ],
    });
    const r = records(memberTranscript(conv, 'p'));
    expect(r.map((x) => x.type)).toEqual(['user', 'assistant', 'custom-title']);
    expect(r[0]!.message.content).toBe('First\n\nSecond');
    expect(memberTranscript(conv, 'c')).toBe('');
    expect(recordedMembers(conv)).toEqual(['p', 'c']);
    expect(memberTranscripts(conv).map((t) => t.id)).toEqual([memberSessionId(conv.id, 'p')]);
  });

  it('adds up the costs by model, to the microdollar, also of replies with no tokens', () => {
    const conv = recordedTeam();
    conv.messages = [
      message('m1', { kind: 'user' }, 'Go'),
      message('m2', { kind: 'agent', agentId: 'oc' }, 'One.', { provider: 'opencode', meta: { inputTokens: 10, outputTokens: 1, costUsd: 0.1 } }),
      message('m3', { kind: 'agent', agentId: 'oc' }, 'Two.', { provider: 'opencode', meta: { costUsd: 0.2 } }),
    ];
    conv.agents[1] = { ...conv.agents[1]!, model: 'openai/gpt-x' };
    conv.messages.push(message('m4', { kind: 'agent', agentId: 'oc' }, 'Three.', { provider: 'opencode', meta: { inputTokens: 5, outputTokens: 2, costUsd: 0.0000004 } }));
    const r = records(memberTranscript(conv, 'oc'));
    // No tokens: no usage on that reply, its cost still counted.
    expect(r.filter((x) => x.type === 'assistant').map((x) => x.message.usage)).toEqual([{ input_tokens: 10, output_tokens: 1 }, undefined, { input_tokens: 5, output_tokens: 2 }]);
    expect(r.at(-2)).toMatchObject({ totalCostUSD: 0.3, hasUnknownModelCost: false, modelUsage: { 'openai/gpt-x': { inputTokens: 15, outputTokens: 3, costUSD: 0.3 } } });

    // A reply keeps no model of its own: once the member moved to another CLI, its replies on Cursor are all under the CLI's name, its old one too, and a cost is unknown.
    const moved = recordedTeam();
    const cost = records(memberTranscript(moved, 'cur')).at(-2)!;
    moved.agents[0] = { ...moved.agents[0]!, provider: 'goose' };
    moved.messages.push(message('m9', { kind: 'agent', agentId: 'cur' }, 'Later.', { provider: 'cursor', meta: { inputTokens: 7, outputTokens: 1 } }));
    expect(cost.modelUsage).toEqual({ 'claude-opus-5-5': { inputTokens: 1200, outputTokens: 300, costUSD: 0.012346 } });
    expect(records(memberTranscript(moved, 'cur')).at(-2)).toMatchObject({
      totalCostUSD: 0.012346,
      hasUnknownModelCost: true,
      modelUsage: { cursor: { inputTokens: 1207, outputTokens: 301, costUSD: 0.012346 } },
    });
  });

  it('is sent for each member with such a reply, in the order they first replied, and none for the others', () => {
    const conv = recordedTeam();
    expect(memberTranscripts(conv).map((s) => s.id)).toEqual([memberSessionId(conv.id, 'cur'), memberSessionId(conv.id, 'oc')]);
    expect(memberTranscripts(conversation())).toEqual([]);
    // Another conversation, another session for the same member.
    expect(memberSessionId('other', 'cur')).not.toBe(memberSessionId(conv.id, 'cur'));
  });
});

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: BodyInit | null;
}

/** A fake AgentsView: knows the sessions in `known`; `hold` keeps uploads waiting until released. */
function fakeAgentsView(known: Record<string, { project: string; machine: string }> = {}) {
  const calls: Call[] = [];
  let hold: Promise<void> | undefined;
  let release = () => {};
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = { method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body };
    calls.push(call);
    if (call.method === 'GET') {
      const id = decodeURIComponent(url.pathname.split('/').pop()!);
      const s = known[id];
      return s ? Response.json({ id, ...s }) : Response.json({ error: 'session not found' }, { status: 404 });
    }
    if (url.pathname.endsWith('/upload') && hold) await hold;
    return Response.json({ ok: true });
  }) as typeof fetch;
  return {
    calls,
    fetchImpl,
    holdUploads() {
      hold = new Promise((r) => (release = r));
    },
    release: () => {
      hold = undefined;
      release();
    },
  };
}

describe('sending a conversation to AgentsView', () => {
  it('uploads the thread where its agents are, then links each agent session under it', async () => {
    const av = fakeAgentsView({ 'codex:01a1bb71-4292': { project: 'chats', machine: 'm-1234' } });
    const conv = conversation();
    await new AgentsViewSync(() => BASE, av.fetchImpl).send(BASE, conv);

    const upload = av.calls.find((c) => c.method === 'POST')!;
    expect(upload.url.pathname).toBe('/api/v1/sessions/upload');
    expect(Object.fromEntries(upload.url.searchParams)).toEqual({ project: 'chats', machine: 'm-1234', allow_shorter: 'true' });
    expect(upload.headers.Origin).toBe(BASE);
    const file = (upload.body as FormData).get('file') as File;
    expect(file.name).toBe(`${conv.id}.jsonl`);
    expect(await file.text()).toBe(threadTranscript(conv));

    const links = av.calls.filter((c) => c.method === 'PUT');
    expect(links.map((c) => decodeURIComponent(c.url.pathname))).toEqual([
      '/api/v1/sessions/977d79d5-4d98-4e2a-9a1d-20fe70d1417e/parent',
      '/api/v1/sessions/codex:01a1bb71-4292/parent',
      '/api/v1/sessions/grok:01a1bb71-42e0/parent',
    ]);
    for (const link of links) {
      expect(JSON.parse(String(link.body))).toEqual({ parent_session_id: conv.id });
      expect(link.headers).toMatchObject({ Origin: BASE, 'Content-Type': 'application/json' });
    }
  });

  it("uploads the members' recorded sessions where the thread goes, and links them under it", async () => {
    const av = fakeAgentsView({ '977d79d5-4d98-4e2a-9a1d-20fe70d1417e': { project: 'chats', machine: 'm-1234' } });
    const conv = recordedTeam();
    await new AgentsViewSync(() => BASE, av.fetchImpl).send(BASE, conv);

    const uploads = av.calls.filter((c) => c.method === 'POST');
    const cur = memberSessionId(conv.id, 'cur');
    const oc = memberSessionId(conv.id, 'oc');
    expect(uploads.map((u) => ((u.body as FormData).get('file') as File).name)).toEqual([`${conv.id}.jsonl`, `${cur}.jsonl`, `${oc}.jsonl`]);
    for (const u of uploads) {
      expect(Object.fromEntries(u.url.searchParams)).toEqual({ project: 'chats', machine: 'm-1234', allow_shorter: 'true' });
      expect(u.headers.Origin).toBe(BASE);
    }
    expect(await ((uploads[1]!.body as FormData).get('file') as File).text()).toBe(memberTranscript(conv, 'cur'));

    const links = av.calls.filter((c) => c.method === 'PUT').map((c) => decodeURIComponent(c.url.pathname).split('/')[4]);
    expect(links).toEqual(['977d79d5-4d98-4e2a-9a1d-20fe70d1417e', cur, oc]);
    // Only after the uploads: the thread is there to be the parent.
    expect(av.calls.findIndex((c) => c.method === 'PUT')).toBeGreaterThan(av.calls.findLastIndex((c) => c.method === 'POST'));
  });

  it("keeps sending and linking the others when one member's session fails, then says why", async () => {
    const conv = recordedTeam();
    const cur = memberSessionId(conv.id, 'cur');
    const oc = memberSessionId(conv.id, 'oc');
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const file = method === 'POST' ? ((init.body as FormData).get('file') as File).name : '';
      calls.push(`${method} ${decodeURIComponent(url.pathname)} ${file}`.trim());
      if (method === 'GET') return Response.json({ error: 'session not found' }, { status: 404 });
      if (file === `${cur}.jsonl`) return Response.json({ error: 'database is locked' }, { status: 500 });
      return Response.json({ ok: true });
    }) as typeof fetch;
    await expect(new AgentsViewSync(() => BASE, fetchImpl).send(BASE, conv)).rejects.toThrow('POST /api/v1/sessions/upload: HTTP 500 database is locked');
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([
      `POST /api/v1/sessions/upload ${conv.id}.jsonl`,
      `POST /api/v1/sessions/upload ${cur}.jsonl`,
      `POST /api/v1/sessions/upload ${oc}.jsonl`,
      // The failed one is not linked; the others are.
      'PUT /api/v1/sessions/977d79d5-4d98-4e2a-9a1d-20fe70d1417e/parent',
      `PUT /api/v1/sessions/${oc}/parent`,
    ]);
  });

  it("takes a member's session AgentsView refuses as deleted as the user's choice: not linked, not sent again until it changes, no failure", async () => {
    const conv = recordedTeam();
    const cur = memberSessionId(conv.id, 'cur');
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const file = method === 'POST' ? ((init.body as FormData).get('file') as File).name : '';
      calls.push(`${method} ${decodeURIComponent(new URL(String(input)).pathname).split('/')[4]} ${file}`.trim());
      if (method === 'GET') return Response.json({ error: 'session not found' }, { status: 404 });
      // The user deleted the Reviewer's session in AgentsView (its trash, or for good).
      if (file === `${cur}.jsonl`) return Response.json({ detail: 'session upload rejected: session is excluded or trashed' }, { status: 409 });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const sync = new AgentsViewSync(() => BASE, fetchImpl);
    await sync.send(BASE, conv);
    expect(calls.filter((c) => c.startsWith('PUT') && c.includes(cur))).toEqual([]);
    expect(calls).toContain(`POST upload ${cur}.jsonl`);

    // Unchanged: not tried again, and still not linked.
    calls.length = 0;
    await sync.send(BASE, conv);
    expect(calls.filter((c) => c.includes(cur))).toEqual([]);

    // It replied again: tried once more (and refused again, quietly).
    calls.length = 0;
    conv.messages.push(message('m9', { kind: 'agent', agentId: 'cur' }, 'One more thing.', { agentName: 'Reviewer', provider: 'cursor' }));
    await sync.send(BASE, conv);
    expect(calls.filter((c) => c.includes(cur))).toEqual([`POST upload ${cur}.jsonl`]);
  });

  it('sends nothing more when the thread itself cannot be sent', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      if ((init.method ?? 'GET') === 'GET') return Response.json({ error: 'session not found' }, { status: 404 });
      return Response.json({ error: 'read-only' }, { status: 501 });
    }) as typeof fetch;
    await expect(new AgentsViewSync(() => BASE, fetchImpl).send(BASE, recordedTeam())).rejects.toThrow('HTTP 501');
    expect(calls.filter((c) => !c.startsWith('GET'))).toEqual(['POST /api/v1/sessions/upload']);
  });

  it("sends a member's recorded session again only once it changed, or to another address, or after it failed", async () => {
    const av = fakeAgentsView();
    const sync = new AgentsViewSync(() => BASE, av.fetchImpl);
    const conv = recordedTeam();
    const files = () => av.calls.filter((c) => c.method === 'POST').map((c) => ((c.body as FormData).get('file') as File).name);
    const cur = `${memberSessionId(conv.id, 'cur')}.jsonl`;
    const oc = `${memberSessionId(conv.id, 'oc')}.jsonl`;
    await sync.send(BASE, conv);
    expect(files()).toEqual([`${conv.id}.jsonl`, cur, oc]);

    // The user writes again and only the Builder answers: the Reviewer's session is the same.
    av.calls.length = 0;
    conv.messages.push(message('m9', { kind: 'user' }, 'And the docs?'), message('m10', { kind: 'agent', agentId: 'oc' }, 'Updated.', { provider: 'opencode' }));
    await sync.send(BASE, conv);
    expect(files()).toEqual([`${conv.id}.jsonl`, oc]);
    // Every session is still linked, the unchanged one too.
    expect(av.calls.filter((c) => c.method === 'PUT').map((c) => decodeURIComponent(c.url.pathname).split('/')[4])).toEqual([
      '977d79d5-4d98-4e2a-9a1d-20fe70d1417e',
      memberSessionId(conv.id, 'cur'),
      memberSessionId(conv.id, 'oc'),
    ]);

    // Another AgentsView has none of them yet.
    av.calls.length = 0;
    await sync.send('http://127.0.0.1:8080', conv);
    expect(files()).toEqual([`${conv.id}.jsonl`, cur, oc]);

    // A conversation forgotten (deleted) leaves nothing behind: it would be sent in full.
    av.calls.length = 0;
    sync.forget(conv.id);
    await sync.send(BASE, conv);
    expect(files()).toEqual([`${conv.id}.jsonl`, cur, oc]);
  });

  it("sends a member's recorded session again when the thread moves to another project or machine", async () => {
    const known: Record<string, { project: string; machine: string }> = {};
    const av = fakeAgentsView(known);
    const sync = new AgentsViewSync(() => BASE, av.fetchImpl);
    const conv = recordedTeam();
    const placed = () => av.calls.filter((c) => c.method === 'POST').map((c) => `${((c.body as FormData).get('file') as File).name} ${c.url.searchParams.get('project')}`);
    await sync.send(BASE, conv);
    expect(placed()).toEqual([`${conv.id}.jsonl chats`, `${memberSessionId(conv.id, 'cur')}.jsonl chats`, `${memberSessionId(conv.id, 'oc')}.jsonl chats`]);
    // AgentsView has read Claude Code's session since: the thread goes to its project, and the recorded sessions with it.
    known['977d79d5-4d98-4e2a-9a1d-20fe70d1417e'] = { project: 'repo', machine: 'host-1' };
    av.calls.length = 0;
    await sync.send(BASE, conv);
    expect(placed()).toEqual([`${conv.id}.jsonl repo`, `${memberSessionId(conv.id, 'cur')}.jsonl repo`, `${memberSessionId(conv.id, 'oc')}.jsonl repo`]);
  });

  it('links a recorded session again after its link failed, without sending it again', async () => {
    let refuseLinks = true;
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const id = decodeURIComponent(new URL(String(input)).pathname).split('/')[4];
      if (method === 'GET') return Response.json({ error: 'session not found' }, { status: 404 });
      calls.push(`${method} ${method === 'POST' ? ((init.body as FormData).get('file') as File).name : id}`);
      if (method === 'PUT' && refuseLinks) return Response.json({ error: 'busy' }, { status: 503 });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const sync = new AgentsViewSync(() => BASE, fetchImpl);
    const conv = recordedTeam();
    const cur = memberSessionId(conv.id, 'cur');
    const oc = memberSessionId(conv.id, 'oc');
    await expect(sync.send(BASE, conv)).rejects.toThrow('HTTP 503 busy');
    refuseLinks = false;
    calls.length = 0;
    await sync.send(BASE, conv);
    expect(calls).toEqual([`POST ${conv.id}.jsonl`, 'PUT 977d79d5-4d98-4e2a-9a1d-20fe70d1417e', `PUT ${cur}`, `PUT ${oc}`]);
  });

  it('retries a recorded session that failed at the next update, though it did not change', async () => {
    let refuse = true;
    const uploaded: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') return Response.json({ error: 'session not found' }, { status: 404 });
      if (method === 'POST') {
        const name = ((init.body as FormData).get('file') as File).name;
        uploaded.push(name);
        if (refuse && name !== `${recordedTeam().id}.jsonl`) return Response.json({ error: 'busy' }, { status: 503 });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    const sync = new AgentsViewSync(() => BASE, fetchImpl);
    const conv = recordedTeam();
    await expect(sync.send(BASE, conv)).rejects.toThrow('HTTP 503 busy');
    refuse = false;
    uploaded.length = 0;
    await sync.send(BASE, conv);
    expect(uploaded).toEqual([`${conv.id}.jsonl`, `${memberSessionId(conv.id, 'cur')}.jsonl`, `${memberSessionId(conv.id, 'oc')}.jsonl`]);
  });

  it("places the thread with an Antigravity member's session when AgentsView knows it", async () => {
    const conv = conversation({
      agents: [{ id: 'ag', name: 'Gemini', provider: 'antigravity', role: '' }],
      agentState: { ag: { provider: 'antigravity', sessionId: 'c3471ccd-0000-4000-8000-000000000001', seen: [] } },
    });
    const av = fakeAgentsView({ 'antigravity-cli:c3471ccd-0000-4000-8000-000000000001': { project: 'web', machine: 'm-7' } });
    await new AgentsViewSync(() => BASE, av.fetchImpl).send(BASE, conv);
    expect(Object.fromEntries(av.calls.find((c) => c.method === 'POST')!.url.searchParams)).toMatchObject({ project: 'web', machine: 'm-7' });
    expect(av.calls.filter((c) => c.method === 'PUT').map((c) => decodeURIComponent(c.url.pathname))).toEqual([
      '/api/v1/sessions/antigravity-cli:c3471ccd-0000-4000-8000-000000000001/parent',
    ]);
  });

  it("uses the working directory's name before AgentsView has read any agent session", async () => {
    const av = fakeAgentsView();
    await new AgentsViewSync(() => BASE, av.fetchImpl).send(BASE, conversation());
    const upload = av.calls.find((c) => c.method === 'POST')!;
    expect(upload.url.searchParams.get('project')).toBe('chats');
    expect(upload.url.searchParams.get('machine')).toBe('local');
    expect(fallbackProject('/')).toBe('harness-relay');
  });

  it('sends nothing for a conversation with nothing said yet, or while no address is set', async () => {
    const av = fakeAgentsView();
    await new AgentsViewSync(() => BASE, av.fetchImpl).send(BASE, conversation({ messages: [] }));
    const off = new AgentsViewSync(() => '', av.fetchImpl);
    off.schedule(conversation());
    await off.idle();
    expect(av.calls).toEqual([]);
  });

  it('runs one update at a time per conversation, and sends the changes made meanwhile once', async () => {
    const av = fakeAgentsView();
    const sync = new AgentsViewSync(() => BASE, av.fetchImpl);
    const conv = conversation();
    av.holdUploads();
    sync.schedule(conv);
    await new Promise((r) => setTimeout(r, 10));
    sync.schedule(conv);
    sync.schedule(conv);
    av.release();
    await sync.idle();
    expect(av.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('keeps the last failure for the settings page, only for the address it happened at', async () => {
    let base = BASE;
    let down = true;
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      if (down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      if ((init.method ?? 'GET') === 'GET') return Response.json({ error: 'session not found' }, { status: 404 });
      if (String(input).includes('/upload')) return Response.json({ error: 'file must be .jsonl' }, { status: 400 });
      return Response.json({});
    }) as typeof fetch;
    const sync = new AgentsViewSync(() => base, fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      sync.schedule(conversation());
      await sync.idle();
      expect(sync.error).toBe(`${BASE}: ECONNREFUSED`);
      // Another address: that failure is not about it.
      base = 'http://127.0.0.1:8080';
      expect(sync.error).toBeUndefined();
      base = BASE;
      expect(sync.error).toBe(`${BASE}: ECONNREFUSED`);

      down = false;
      sync.schedule(conversation());
      await sync.idle();
      expect(sync.error).toBe('POST /api/v1/sessions/upload: HTTP 400 file must be .jsonl');
    } finally {
      warn.mockRestore();
    }
  });

  it('never follows a redirect, so the conversation cannot leave this computer', async () => {
    const seen: (RequestRedirect | undefined)[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      seen.push(init.redirect);
      // What fetch does with redirect: 'error' when the server answers 307.
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    }) as typeof fetch;
    const sync = new AgentsViewSync(() => BASE, fetchImpl);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      sync.schedule(conversation());
      await sync.idle();
    } finally {
      warn.mockRestore();
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r === 'error')).toBe(true);
    expect(sync.error).toBe(`${BASE}: unexpected redirect`);
  });

  it('sends the newest state after changes made during an update', async () => {
    const av = fakeAgentsView();
    const sync = new AgentsViewSync(() => BASE, av.fetchImpl);
    const conv = conversation();
    av.holdUploads();
    sync.schedule(conv);
    await new Promise((r) => setTimeout(r, 10));
    conv.messages.push(message('m6', { kind: 'user' }, 'One more thing'));
    sync.schedule(conv);
    av.release();
    await sync.idle();
    const uploads = av.calls.filter((c) => c.method === 'POST');
    expect(uploads).toHaveLength(2);
    expect(await ((uploads[1]!.body as FormData).get('file') as File).text()).toContain('One more thing');
  });

  it('can start again right after an update that had nothing to do', async () => {
    const av = fakeAgentsView();
    let base = BASE;
    const sync = new AgentsViewSync(() => base, av.fetchImpl);
    // Scheduled while on, the address is gone by the time the update starts: it ends without sending.
    sync.schedule(conversation());
    base = '';
    await sync.idle();
    expect(av.calls).toEqual([]);
    // It did not stay registered as running, so the next one is sent rather than left waiting.
    base = BASE;
    sync.schedule(conversation());
    await sync.idle();
    expect(av.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it("links the conversation's other sessions too (the lead agent's, the group sorter's)", async () => {
    const av = fakeAgentsView();
    const sync = new AgentsViewSync(() => BASE, av.fetchImpl);
    const conv = conversation();
    sync.link(conv, 'grok', 'lead-1');
    sync.link(conv, 'claude', 'sorter-1');
    sync.link(conv, 'codex', '01a1bb71-4292'); // a member's session: linked once
    sync.link(conv, 'cursor', 'lead-2'); // not one AgentsView reads, nor one Harness Relay keeps a record of
    sync.link(conv, 'opencode', 'sorter-2');
    sync.link(conv, 'antigravity', 'lead-3');
    sync.link(conv, 'muse', 'lead-4');
    sync.schedule(conv);
    await sync.idle();
    const linked = av.calls.filter((c) => c.method === 'PUT').map((c) => decodeURIComponent(c.url.pathname).split('/')[4]);
    expect(linked).toEqual(['977d79d5-4d98-4e2a-9a1d-20fe70d1417e', 'codex:01a1bb71-4292', 'grok:01a1bb71-42e0', 'grok:lead-1', 'sorter-1', 'antigravity-cli:lead-3', 'muse:lead-4']);
  });

  it('drops what still waits to be sent for a conversation being deleted', async () => {
    const av = fakeAgentsView();
    const sync = new AgentsViewSync(() => BASE, av.fetchImpl);
    const conv = conversation();
    av.holdUploads();
    sync.schedule(conv);
    await new Promise((r) => setTimeout(r, 10));
    sync.schedule(conv); // waits for the first update
    sync.forget(conv.id);
    av.release();
    await sync.idle();
    expect(av.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it("sends no member's session and links nothing once a conversation is deleted during its update, and keeps nothing of it", async () => {
    const av = fakeAgentsView();
    const sync = new AgentsViewSync(() => BASE, av.fetchImpl);
    const conv = recordedTeam();
    av.holdUploads();
    sync.schedule(conv);
    await new Promise((r) => setTimeout(r, 10));
    // The thread's upload is under way.
    expect(av.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    sync.forget(conv.id);
    av.release();
    await sync.idle();
    expect(av.calls.filter((c) => c.method !== 'GET').map((c) => c.method)).toEqual(['POST']);

    // Nothing was kept of it: the same id would be sent in full.
    av.calls.length = 0;
    await sync.send(BASE, conv);
    expect(av.calls.filter((c) => c.method === 'POST')).toHaveLength(3);
  });

  it('places the thread with the first agent session AgentsView answers for', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const path = decodeURIComponent(url.pathname);
      calls.push(`${init.method ?? 'GET'} ${path}${url.search}`);
      if ((init.method ?? 'GET') !== 'GET') return Response.json({});
      if (path.endsWith('977d79d5-4d98-4e2a-9a1d-20fe70d1417e')) return new Response('oops', { status: 500 });
      if (path.endsWith('codex:01a1bb71-4292')) return new Response('not json');
      if (path.endsWith('grok:01a1bb71-42e0')) return Response.json({ project: 'grok_project', machine: 'm-9' });
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    await new AgentsViewSync(() => BASE, fetchImpl).send(BASE, conversation());
    // Asked in order, past the failing and the unreadable answer.
    expect(calls.filter((c) => c.startsWith('GET'))).toEqual([
      'GET /api/v1/sessions/977d79d5-4d98-4e2a-9a1d-20fe70d1417e',
      'GET /api/v1/sessions/codex:01a1bb71-4292',
      'GET /api/v1/sessions/grok:01a1bb71-42e0',
    ]);
    expect(calls.find((c) => c.startsWith('POST'))).toContain('project=grok_project&machine=m-9');
  });
});

describe('the thread transcript, again', () => {
  it('shows a [PASS] reply as such, and leaves out the title record for an untitled conversation', () => {
    const conv = conversation({
      title: '  ',
      messages: [
        message('m1', { kind: 'user' }, 'Anything to add?'),
        message('m2', { kind: 'agent', agentId: 'b' }, '', { parts: [], passed: true }),
      ],
    });
    const r = records(threadTranscript(conv));
    expect(r.map((x) => x.type)).toEqual(['user', 'assistant']);
    expect(r[1]!.message.content[0].text).toBe('**Codex** · codex\n\n[PASS]');
  });
});
