/*
 * Steering, CLI by CLI (`RunOptions.onSteer`, `STEER_PROVIDERS`): what each adapter sends into a running
 * turn, and when it counts a message as taken or refused. Shapes as each CLI's schema, bundle or docs
 * have them (see each adapter's comment); a stand-in claude for the input kept open after a result.
 * The orchestrator's side is in orchestrator-steer.test.ts.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AntigravityPrompts } from '../src/server/agents/antigravity';
import { ClaudeSteering, claudeRunner } from '../src/server/agents/claude';
import { codexSteer } from '../src/server/agents/codex';
import { gooseSteer } from '../src/server/agents/goose';
import { GrokInterjections } from '../src/server/agents/grok';
import { piSteer, type PiResponse } from '../src/server/agents/pi';
import type { OpenRunContext } from '../src/server/agents/open';
import type { JsonRpcConnection } from '../src/server/agents/acp';
import type { AgentEvent, SteerTurn } from '../src/server/agents/types';
import { buildSteerPrompt } from '../src/server/prompt';
import { STEER_PROVIDERS, type Conversation } from '../src/shared/types';
import { writeFakeClaude } from './fake-claude';

describe('which CLIs take a message into a running turn', () => {
  it('are the six whose adapter can, and no other', () => {
    expect([...STEER_PROVIDERS].sort()).toEqual(['antigravity', 'claude', 'codex', 'goose', 'grok', 'pi']);
  });

  it('get the message as a chat block, with what to do with it', () => {
    const conv = { id: 'c', agents: [], messages: [] } as unknown as Conversation;
    const text = buildSteerPrompt(conv, {
      id: 'm',
      author: { kind: 'user' },
      createdAt: 0,
      status: 'done',
      parts: [{ type: 'text', text: 'also the docs' }],
    });
    expect(text).toContain('<chat>\n<message from="user">\nalso the docs\n</message>\n</chat>');
    expect(text).toMatch(/while you were working/);
  });
});

describe('Claude Code: a user message on its stream-json input', () => {
  const written: any[] = [];
  const steering = (ackMs = 1000) => {
    written.length = 0;
    return new ClaudeSteering((m) => (written.push(m), true), ackMs);
  };

  it('is written with priority "next" and a uuid, and taken once Claude Code says it queued it', async () => {
    const s = steering();
    const taken = s.steer('hello');
    expect(written).toEqual([
      { type: 'user', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null, priority: 'next', uuid: expect.any(String) },
    ]);
    const uuid = written[0].uuid as string;
    // Others' lifecycle lines are no answer.
    expect(s.handle({ type: 'command_lifecycle', command_uuid: 'other', state: 'refused' })).toBe(true);
    expect(s.handle({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued' })).toBe(true);
    await expect(taken).resolves.toBe(true);
    // Queued, not started: the input stays open after a result.
    s.handle({ type: 'result', queued_turn_count: 0 });
    expect(s.holdsInput()).toBe(true);
    s.handle({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
    // Started after the result: its turn runs, and has no result yet.
    expect(s.holdsInput()).toBe(true);
    s.handle({ type: 'result', queued_turn_count: 0 });
    expect(s.holdsInput()).toBe(false);
  });

  it('lets the input end once the turn a message started is over, whether its result comes first or not', async () => {
    const s = steering();
    const taken = s.steer('late one');
    const uuid = written[0].uuid as string;
    s.handle({ type: 'result', queued_turn_count: 0 });
    // Written, not answered yet: the input waits for it.
    expect(s.holdsInput()).toBe(true);
    s.handle({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
    await expect(taken).resolves.toBe(true);
    expect(s.holdsInput()).toBe(true);
    s.handle({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' });
    expect(s.holdsInput()).toBe(false);
  });

  it('counts a refused message as not taken, and keeps the input while more turns follow', async () => {
    const s = steering();
    const taken = s.steer('no');
    s.handle({ type: 'command_lifecycle', command_uuid: written[0].uuid, state: 'refused' });
    await expect(taken).resolves.toBe(false);
    expect(s.holdsInput()).toBe(false);
    s.handle({ type: 'result', queued_turn_count: 2 });
    expect(s.holdsInput()).toBe(true);
    expect(s.handle({ type: 'assistant' })).toBe(false);
  });

  it('withdraws a message Claude Code says nothing about, and refuses any once closed', async () => {
    vi.useFakeTimers();
    try {
      const s = steering(500);
      const changed = vi.fn();
      s.onChange = changed;
      const taken = s.steer('anyone?');
      const uuid = written[0].uuid;
      expect(s.holdsInput()).toBe(true);
      vi.advanceTimersByTime(500);
      await expect(taken).resolves.toBe(false);
      expect(written[1]).toEqual({
        type: 'control_request',
        request_id: `cancel-${uuid}`,
        request: { subtype: 'cancel_async_message', message_uuid: uuid },
      });
      expect(changed).toHaveBeenCalled();
      expect(s.holdsInput()).toBe(false);
      // Closed: the next one is refused without being written; one still waiting counts as refused.
      const waiting = s.steer('late');
      s.close();
      await expect(waiting).resolves.toBe(false);
      await expect(s.steer('after')).resolves.toBe(false);
      expect(written).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The stand-in is a script run by its `#!` line, which Windows cannot start.
describe.skipIf(process.platform === 'win32')('Claude Code: a message steered into a run (stand-in claude)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-steer-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const bin = writeFakeClaude(join(dir, 'claude'));
  let n = 0;

  async function steered(mode: string) {
    const log = join(dir, `log-${++n}.jsonl`);
    const events: AgentEvent[] = [];
    let steer: SteerTurn | undefined;
    const given: boolean[] = [];
    const result = claudeRunner.run({
      bin,
      env: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_STEER: mode },
      prompt: 'hello',
      systemPrompt: 'briefing',
      cwd: dir,
      permission: 'full',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      onSteer: (s) => {
        steer = s;
        given.push(Boolean(s));
      },
    });
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'text', text: 'working' }), { timeout: 5000 });
    const taken = await steer!('also the docs');
    await result;
    const lines = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, any>);
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    return { taken, texts, lines, given };
  }

  it('folds it into the running turn', async () => {
    const r = await steered('fold');
    expect(r.taken).toBe(true);
    expect(r.texts).toEqual(['working', 'heard: also the docs']);
    expect(r.lines.find((l) => l.steered)!.steered).toMatchObject({
      type: 'user',
      priority: 'next',
      message: { content: 'also the docs' },
    });
    // Given once the prompt is out, taken back once the input ends (and again as the process ends).
    expect(r.given[0]).toBe(true);
    expect(r.given.slice(1).every((g) => !g)).toBe(true);
  });

  it('keeps the input open for a message that came as the turn ended, until its own turn has answered', async () => {
    const r = await steered('late');
    expect(r.taken).toBe(true);
    // The input did not end at the first result: the message's turn ran and answered.
    expect(r.texts).toEqual(['working', 'heard: also the docs']);
  });

  it('counts a message it refused as not taken, and ends the run as usual', async () => {
    const r = await steered('refuse');
    expect(r.taken).toBe(false);
    expect(r.texts).toEqual(['working']);
  });
});

describe('Codex: turn/steer', () => {
  it('sends the input to the running turn, expecting its id, and is taken when Codex answers with it', async () => {
    const calls: [string, unknown][] = [];
    const conn = { request: async (method: string, params?: unknown) => (calls.push([method, params]), { turnId: 'turn-1' }) };
    await expect(codexSteer(conn, 'thread-1', 'turn-1', 'also the docs')).resolves.toBe(true);
    expect(calls).toEqual([
      [
        'turn/steer',
        { threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'also the docs', text_elements: [] }] },
      ],
    ]);
  });

  it('is refused when the turn is no longer the active one', async () => {
    const conn = {
      request: async () => {
        throw new Error('expected active turn turn-1');
      },
    };
    await expect(codexSteer(conn, 'thread-1', 'turn-1', 'late')).resolves.toBe(false);
  });
});

describe('Grok: x.ai/interject', () => {
  const grok = (answer: (params: any) => Promise<unknown>) => {
    const calls: [string, any][] = [];
    const g = new GrokInterjections({ request: (method, params) => (calls.push([method, params]), answer(params)) }, 'session-1');
    return { g, calls };
  };

  it('sends an interjection of its own id, taken once Grok answers', async () => {
    const { g, calls } = grok(async () => ({}));
    await expect(g.steer('also the docs')).resolves.toBe(true);
    expect(calls).toEqual([
      [
        '_x.ai/interject',
        { sessionId: 'session-1', interjectionId: expect.any(String), content: [{ type: 'text', text: 'also the docs' }] },
      ],
    ]);
  });

  it('is refused by an error, by Grok saying it did not send it, or by the prompt ending first', async () => {
    await expect(grok(async () => Promise.reject(new Error('no'))).g.steer('x')).resolves.toBe(false);
    const slow = grok(() => new Promise(() => undefined));
    const unsent = slow.g.steer('y');
    expect(slow.g.handle('_x.ai/session/unsent_message', { interjectionId: slow.calls[0]![1].interjectionId, reason: 'turn ended' })).toBe(
      true,
    );
    await expect(unsent).resolves.toBe(false);
    const taken = slow.g.steer('z');
    expect(slow.g.handle('x.ai/session/interjection', { interjectionId: slow.calls[1]![1].interjectionId })).toBe(true);
    await expect(taken).resolves.toBe(true);
    const open = slow.g.steer('w');
    slow.g.close();
    await expect(open).resolves.toBe(false);
    await expect(slow.g.steer('after')).resolves.toBe(false);
    expect(slow.g.handle('session/update', {})).toBe(false);
  });
});

describe('Antigravity: another session/prompt', () => {
  /** A prompt that answers when told to, as agy's do. */
  const prompts = () => {
    const sent: { prompt: unknown[]; answer: (r: any) => void; fail: (e: Error) => void }[] = [];
    const send = (prompt: unknown[]) =>
      new Promise<any>((answer, fail) => {
        sent.push({ prompt, answer, fail });
      });
    return { sent, send };
  };

  it('is taken once the earlier prompt answers; the turn ends when the last one does, with all their tokens', async () => {
    const p = prompts();
    const turn = new AntigravityPrompts(p.send, [{ type: 'text', text: 'question' }], 10_000);
    const taken = turn.steer('also the docs');
    expect(p.sent.map((s) => s.prompt)).toEqual([[{ type: 'text', text: 'question' }], [{ type: 'text', text: 'also the docs' }]]);
    // Superseded: its `cancelled` is no stop.
    p.sent[0]!.answer({ stopReason: 'cancelled', usage: { inputTokens: 10, outputTokens: 2 } });
    await expect(taken).resolves.toBe(true);
    const done = turn.done();
    p.sent[1]!.answer({ stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } });
    await expect(done).resolves.toEqual({
      result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
      inputTokens: 15,
      outputTokens: 5,
    });
    await expect(turn.steer('after')).resolves.toBe(false);
  });

  it('is refused when agy answers the second prompt with an error at once, and the turn goes on without it', async () => {
    const p = prompts();
    const turn = new AntigravityPrompts(p.send, [{ type: 'text', text: 'question' }], 10_000);
    const taken = turn.steer('no');
    p.sent[1]!.fail(new Error('a prompt is already running'));
    await expect(taken).resolves.toBe(false);
    const done = turn.done();
    p.sent[0]!.answer({ stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } });
    await expect(done).resolves.toMatchObject({ result: { stopReason: 'end_turn' }, inputTokens: 1, outputTokens: 1 });
  });

  it('counts one not refused within the grace time as taken, and fails the turn when a prompt fails', async () => {
    vi.useFakeTimers();
    try {
      const p = prompts();
      const turn = new AntigravityPrompts(p.send, [{ type: 'text', text: 'question' }], 200);
      const taken = turn.steer('also');
      await vi.advanceTimersByTimeAsync(200);
      await expect(taken).resolves.toBe(true);
      const done = turn.done();
      p.sent[0]!.answer({ stopReason: 'end_turn' });
      p.sent[1]!.fail(new Error('model error'));
      await expect(done).rejects.toThrow('model error');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Goose: _goose/unstable/session/steer', () => {
  const ctx = (activeRunId?: string) => ({ state: { activeRunId } }) as unknown as OpenRunContext;

  it('sends the message to the running run, expecting its id, and is taken when Goose answers with a run id', async () => {
    const calls: [string, unknown][] = [];
    const conn = {
      request: async (m: string, p: unknown) => (calls.push([m, p]), { runId: 'run-1', messageId: 'm1' }),
    } as unknown as JsonRpcConnection;
    await expect(gooseSteer(conn, { sessionId: 's1', text: 'also the docs' }, ctx('run-1'))).resolves.toBe(true);
    expect(calls).toEqual([
      ['_goose/unstable/session/steer', { sessionId: 's1', expectedRunId: 'run-1', prompt: [{ type: 'text', text: 'also the docs' }] }],
    ]);
  });

  it('is refused before the run’s id is known, and when Goose refuses it', async () => {
    const never = { request: vi.fn() } as unknown as JsonRpcConnection;
    await expect(gooseSteer(never, { sessionId: 's1', text: 'x' }, ctx())).resolves.toBe(false);
    expect((never as unknown as { request: ReturnType<typeof vi.fn> }).request).not.toHaveBeenCalled();
    const refusing = {
      request: async () => {
        throw new Error('no active run to steer');
      },
    } as unknown as JsonRpcConnection;
    await expect(gooseSteer(refusing, { sessionId: 's1', text: 'x' }, ctx('run-1'))).resolves.toBe(false);
  });
});

describe('Pi: its steer command', () => {
  const rpc = (answer: Partial<PiResponse>) => {
    const sent: Record<string, unknown>[] = [];
    return {
      sent,
      request: async (cmd: Record<string, unknown>) =>
        (sent.push(cmd), { type: 'response', command: 'steer', success: true, ...answer }) as PiResponse,
    };
  };

  it('queues the message while the run goes on, and is taken when Pi queued it', async () => {
    const r = rpc({ data: { disposition: 'queued' } });
    await expect(piSteer(r, 'also the docs', () => false)).resolves.toBe(true);
    expect(r.sent).toEqual([{ type: 'steer', message: 'also the docs' }]);
  });

  it('is refused when Pi did not queue it, or the run settled first', async () => {
    await expect(piSteer(rpc({ data: { disposition: 'handled' } }), 'x', () => false)).resolves.toBe(false);
    await expect(piSteer(rpc({ success: false, error: 'not running' }), 'x', () => false)).resolves.toBe(false);
    const settled = rpc({ data: { disposition: 'queued' } });
    await expect(piSteer(settled, 'x', () => true)).resolves.toBe(false);
    expect(settled.sent).toEqual([]);
    let over = false;
    const late = {
      request: async () =>
        ((over = true), { type: 'response', command: 'steer', success: true, data: { disposition: 'queued' } }) as PiResponse,
    };
    await expect(piSteer(late, 'x', () => over)).resolves.toBe(false);
  });
});
