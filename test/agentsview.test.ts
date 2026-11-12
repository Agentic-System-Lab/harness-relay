import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '../src/shared/types';
import { AgentsViewSync, agentSessionIds, agentsViewSessionId, fallbackProject, threadTranscript } from '../src/server/agentsview';

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

  it("leaves out Cursor's, which AgentsView does not read (its ACP sessions are a database of its own)", () => {
    expect(agentsViewSessionId('cursor', 'abc')).toBeUndefined();
    const conv = conversation();
    conv.agentState.c = { provider: 'cursor', sessionId: 'c1a2', seen: [] };
    expect(agentSessionIds(conv)).toEqual(['977d79d5-4d98-4e2a-9a1d-20fe70d1417e', 'codex:01a1bb71-4292', 'grok:01a1bb71-42e0']);
  });

  it("leaves out Antigravity's, which AgentsView does not read either (its conversations are databases of its own)", () => {
    expect(agentsViewSessionId('antigravity', 'abc')).toBeUndefined();
    const conv = conversation();
    conv.agentState.ag = { provider: 'antigravity', sessionId: 'c3471ccd', seen: [] };
    expect(agentSessionIds(conv)).toEqual(['977d79d5-4d98-4e2a-9a1d-20fe70d1417e', 'codex:01a1bb71-4292', 'grok:01a1bb71-42e0']);
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
    sync.link(conv, 'cursor', 'lead-2'); // not one AgentsView reads
    sync.schedule(conv);
    await sync.idle();
    const linked = av.calls.filter((c) => c.method === 'PUT').map((c) => decodeURIComponent(c.url.pathname).split('/')[4]);
    expect(linked).toEqual(['977d79d5-4d98-4e2a-9a1d-20fe70d1417e', 'codex:01a1bb71-4292', 'grok:01a1bb71-42e0', 'grok:lead-1', 'sorter-1']);
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
