import { describe, expect, it } from 'vitest';
import { followUpId } from '../src/shared/followUp';
import { agentMessages, calls, conversation, fake, finish, orchestrator, store } from './orchestrator-harness';

async function priorExchange() {
  const conv = conversation({ mode: 'roundtable', rounds: 1, permission: 'read-only' });
  fake.reply = (name) => (name === 'Alice' ? '登入逾時測試失敗。Code: LOGIN_TIMEOUT.' : 'The release checklist is ready.');
  await orchestrator.send(conv.id, 'Check the release');
  await finish(conv.id);
  calls.length = 0;
  return conv;
}

describe('directed follow-ups', () => {
  it.each(['roundtable', 'parallel', 'relay'] as const)('takes exactly one turn in %s even when the reply hands off', async (mode) => {
    const conv = await priorExchange();
    const source = agentMessages(conv)[0]!;
    Object.assign(conv.settings, { mode, rounds: 3, autoTeam: true });
    const before = structuredClone(conv.settings);
    fake.reply = () => 'The session expired. @Bob please take a look.';
    await orchestrator.send(conv.id, '剛才那個登入逾時測試，錯誤訊息是什麼？');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice']);
    expect(calls[0]?.prompt).toContain('Code: LOGIN_TIMEOUT');
    const question = conv.messages.findLast((m) => m.author.kind === 'user')!;
    expect(followUpId(question)).toBe(source.id);
    expect(agentMessages(conv).at(-1)?.usageQuestionId).toBe(question.id);
    expect(conv.settings).toEqual(before);
  });

  it('keeps a directly selected reply through a pause, reloadable message parts, retry and edit', async () => {
    const conv = await priorExchange();
    const source = agentMessages(conv)[0]!;
    conv.settings.mode = 'relay';
    fake.reply = () => '@Bob. Which case? [ASK_USER]';
    await orchestrator.send(conv.id, '那為什麼？', undefined, false, undefined, { followUp: source.id });
    await finish(conv.id);
    expect(conv.pause?.followUp).toBe(true);
    expect(conv.pause?.rest).toEqual([]);
    const original = conv.messages.findLast((m) => m.author.kind === 'user')!;
    expect(followUpId(original)).toBe(source.id);
    fake.reply = () => 'The cached case. @Bob';
    await orchestrator.send(conv.id, 'The cached case.');
    await finish(conv.id);
    const last = agentMessages(conv).at(-1)!;
    await orchestrator.retry(conv.id, last.id);
    await finish(conv.id);
    await orchestrator.resend(conv.id, original.id, 'Why exactly?');
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Alice', 'Alice', 'Alice']);
    expect(followUpId(store.get(conv.id)!.messages.findLast((m) => m.author.kind === 'user'))).toBe(source.id);
  });

  it('rejects a stale explicit route during a run and leaves ordinary busy messages in the queue', async () => {
    const conv = await priorExchange();
    const source = agentMessages(conv)[0]!;
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    try {
      await orchestrator.send(conv.id, 'Start another round.');
      await expect(orchestrator.send(conv.id, 'Why?', undefined, false, undefined, { followUp: source.id })).rejects.toMatchObject({
        status: 409,
      });
      expect(conv.queue ?? []).toHaveLength(0);
      expect(await orchestrator.send(conv.id, 'Why LOGIN_TIMEOUT?')).toEqual({ queued: true });
    } finally {
      release();
      await finish(conv.id);
    }
  });

  it('remaps the source in a child and excludes copied history from an independent topic', async () => {
    const conv = await priorExchange();
    const source = agentMessages(conv)[0]!;
    await orchestrator.send(conv.id, 'What caused LOGIN_TIMEOUT?');
    await finish(conv.id);
    const reply = agentMessages(conv).at(-1)!;
    const child = await orchestrator.branch(conv.id, reply.id);
    const copiedSource = agentMessages(child)[0]!;
    expect(copiedSource.id).not.toBe(source.id);
    expect(followUpId(child.messages.findLast((m) => m.author.kind === 'user'))).toBe(copiedSource.id);
    const topic = await orchestrator.branch(conv.id, reply.id, 'topic');
    await expect(
      orchestrator.send(topic.id, 'Why?', undefined, false, undefined, { followUp: agentMessages(topic)[0]!.id }),
    ).rejects.toMatchObject({ status: 409 });
    calls.length = 0;
    await orchestrator.send(topic.id, 'What caused LOGIN_TIMEOUT?');
    await finish(topic.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
  });

  it('honours a team override, explicit mentions, rejects stale pins and still runs configured lead review', async () => {
    const conv = await priorExchange();
    const source = agentMessages(conv)[0]!;
    await expect(orchestrator.send(conv.id, 'Why?', undefined, false, undefined, { followUp: 'missing' })).rejects.toMatchObject({
      status: 409,
    });
    await orchestrator.send(conv.id, 'Why LOGIN_TIMEOUT?', undefined, false, undefined, { followUp: 'team' });
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    calls.length = 0;
    await orchestrator.send(conv.id, '@Bob why LOGIN_TIMEOUT?', undefined, false, undefined, { followUp: source.id });
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Bob']);
    calls.length = 0;
    conv.settings.leadReview = true;
    await orchestrator.send(conv.id, 'Why?', undefined, false, undefined, { followUp: source.id });
    await finish(conv.id);
    expect(agentMessages(conv).at(-1)?.agentName).toBe('Alice');
    expect(conv.messages.at(-1)?.review?.status).toBe('ready');
  });
});
