/*
 * Branching a conversation: what a branch copies and goes on from (fresh sessions, its name, its
 * family), what it waits for, its attached files, and the worktrees of its parallel replies.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation, ConversationSettings } from '../src/shared/types';
import { agentMessages, agents, attachmentPath, branchAfterCut, branchOrigin, branchPause, calls, conversation, copying, db, fake, finish, mediaRoots, orchestrator, project, resolveMedia, store, Store, textOf, worktreeDir } from './orchestrator-harness';

describe('branching a conversation', () => {
  const kinds = (conv: Conversation) => conv.messages.map((m) => m.author.kind);
  const refs = () =>
    execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/harness-relay/'], { cwd: project, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

  it('copies the messages up to the reply into a new conversation, which goes on from there with fresh sessions', async () => {
    store.createGroup({ id: 'g1', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.allowRules = [{ kind: 'command', key: 'npm test' }];
    store.saveMeta(conv);
    store.moveToGroup(conv.id, 'g1');
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'second question');
    await finish(conv.id);
    expect(kinds(conv)).toEqual(['user', 'agent', 'agent', 'user', 'agent', 'agent']);

    const source = conv.messages.slice(0, 3);
    const branch = await orchestrator.branch(conv.id, source[2]!.id);
    expect(branch.title).toBe('分支 · test');
    expect(kinds(branch)).toEqual(['user', 'agent', 'agent']);
    expect(branch.messages.map(textOf)).toEqual(source.map(textOf));
    expect(branch.messages.map((m) => m.createdAt)).toEqual(source.map((m) => m.createdAt));
    // New ids: messages are rows of their own.
    expect(branch.messages.some((m) => conv.messages.some((x) => x.id === m.id))).toBe(false);
    expect(branch.branch).toEqual({ fromId: conv.id, fromTitle: 'test', afterId: branch.messages[2]!.id });
    expect(branch.agents).toEqual(conv.agents);
    expect(branch.settings).toEqual(conv.settings);
    expect(branch.allowRules).toEqual([{ kind: 'command', key: 'npm test' }]);
    expect(branch.agentState).toEqual({});
    // In the same sidebar group, as the user's choice: the lead agent does not sort it.
    expect(store.groupOf(branch.id)).toBe('g1');
    expect(store.isSorted(branch.id)).toBe(true);
    // The original is untouched, and the database agrees with memory.
    expect(conv.messages).toHaveLength(6);
    const reloaded = new Store(db).get(branch.id)!;
    expect(reloaded.messages.map((m) => [m.id, m.author, textOf(m)])).toEqual(branch.messages.map((m) => [m.id, m.author, textOf(m)]));
    expect(reloaded.branch).toEqual(branch.branch);

    // The branch's agents start fresh, with the copied history and nothing after it.
    calls.length = 0;
    await orchestrator.send(branch.id, 'another question');
    await finish(branch.id);
    expect(calls.map((c) => [c.name, c.sessionId])).toEqual([
      ['Alice', undefined],
      ['Bob', undefined],
    ]);
    expect(calls[0]!.prompt).toContain('first question');
    expect(calls[0]!.prompt).toContain('Alice done');
    expect(calls[0]!.prompt).toContain('another question');
    expect(calls[0]!.prompt).not.toContain('second question');
    expect(calls[0]!.systemPrompt).toContain('branched from an earlier one');
    expect(kinds(branch)).toEqual(['user', 'agent', 'agent', 'user', 'agent', 'agent']);
    expect(conv.messages).toHaveLength(6);
    // Named after what the user went on with there, as a new chat is after its first question.
    expect(branch.title).toBe('another question');
    expect(new Store(db).get(branch.id)!.title).toBe('another question');
  });

  it('names a branch after the first message written there only while it has the name it was made with', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    const reply = agentMessages(conv).at(-1)!.id;

    // Named once: the next message keeps the name.
    const one = await orchestrator.branch(conv.id, reply);
    await orchestrator.send(one.id, 'try it with tables\nand more lines');
    await finish(one.id);
    expect(one.title).toBe('try it with tables');
    await orchestrator.send(one.id, 'and then?');
    await finish(one.id);
    expect(one.title).toBe('try it with tables');

    // A name the user gave it stays.
    const two = await orchestrator.branch(conv.id, reply);
    two.title = 'My own name';
    store.saveMeta(two);
    await orchestrator.send(two.id, 'something else');
    await finish(two.id);
    expect(two.title).toBe('My own name');

    // A branch of a branch, and one made while the chat was called by another language's name for it.
    const three = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    expect(three.title).toBe('分支 · try it with tables');
    three.title = 'Branch · try it with tables';
    store.saveMeta(three);
    await orchestrator.send(three.id, 'only the totals');
    await finish(three.id);
    expect(three.title).toBe('only the totals');
  });

  it('makes a branch from a reply a branch had copied a branch of the conversation that reply was written in', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'second question');
    await finish(conv.id);
    // One: all six of conv's messages copied, then three of its own.
    const one = await orchestrator.branch(conv.id, agentMessages(conv)[3]!.id);
    await orchestrator.send(one.id, 'third question');
    await finish(one.id);
    expect(one.title).toBe('third question');

    // Two, from one's own reply: one's branch, which knows the six before were written in conv.
    const two = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    expect(two.title).toBe('分支 · third question');
    expect(two.branch).toEqual({
      fromId: one.id,
      fromTitle: 'third question',
      afterId: two.messages[8]!.id,
      earlier: [{ fromId: conv.id, fromTitle: 'test', afterId: two.messages[5]!.id }],
    });
    expect(new Store(db).get(two.id)!.branch).toEqual(two.branch);

    // conv is renamed: the branches made from now on name it by its title now.
    conv.title = 'Renamed';
    store.saveMeta(conv);

    // From a reply two copied that one wrote: a branch of one.
    const three = await orchestrator.branch(two.id, agentMessages(two)[4]!.id);
    expect(three.branch).toEqual({
      fromId: one.id,
      fromTitle: 'third question',
      afterId: three.messages[7]!.id,
      earlier: [{ fromId: conv.id, fromTitle: 'Renamed', afterId: three.messages[5]!.id }],
    });

    // From a reply conv wrote, copied into one and from there into two: a branch of conv, as if
    // branched there, named after it.
    const four = await orchestrator.branch(two.id, agentMessages(two)[1]!.id);
    expect(four.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: four.messages[2]!.id });
    expect(four.title).toBe('分支 · Renamed');
    expect(four.messages.map(textOf)).toEqual(conv.messages.slice(0, 3).map(textOf));

    // From a branch point, one's and the last of conv's part in two: that reply was written in the
    // conversation it was copied from too.
    const five = await orchestrator.branch(one.id, agentMessages(one)[3]!.id);
    expect(five.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: five.messages[5]!.id });
    const edge = await orchestrator.branch(two.id, agentMessages(two)[3]!.id);
    expect(edge.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: edge.messages[5]!.id });

    // The sidebar lists each under the conversation its reply was written in.
    const from = Object.fromEntries(store.list(() => false).map((c) => [c.id, c.branchFrom?.id]));
    expect(from).toMatchObject({ [one.id]: conv.id, [two.id]: one.id, [three.id]: one.id, [four.id]: conv.id, [five.id]: conv.id, [edge.id]: conv.id });

    // The conversation the reply was written in is deleted: the branch still names it, by the title
    // the sidebar shows for it (its title when the newest branch of it was made).
    conv.title = 'Renamed again';
    store.saveMeta(conv);
    await orchestrator.deleteConversation(conv.id);
    const six = await orchestrator.branch(two.id, agentMessages(two)[1]!.id);
    expect(six.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: six.messages[2]!.id });
    expect(six.title).toBe('分支 · Renamed');
    expect(store.family(six.id).sort()).toEqual([one.id, two.id, three.id, four.id, five.id, edge.id, six.id].sort());
  });

  it("keeps a branch from the part a deleted conversation wrote in its family, also when it is deleted while the branch's files are copied", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    const one = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    await orchestrator.send(one.id, 'second question');
    await finish(one.id);
    const two = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    const three = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);

    // One goes while a branch from what it wrote is copying its files, which only two waits for:
    // the branch still learns where one came from.
    let release!: () => void;
    copying.gate = new Promise((r) => (release = r));
    let four: Conversation;
    try {
      const making = orchestrator.branch(two.id, agentMessages(two)[2]!.id);
      await orchestrator.deleteConversation(one.id);
      release();
      four = await making;
    } finally {
      copying.gate = undefined;
    }
    expect(four.branch).toMatchObject({ fromId: one.id, fromTitle: 'second question', via: [{ id: conv.id, title: 'test' }] });
    expect(four.branch?.earlier).toEqual([{ fromId: conv.id, fromTitle: 'test', afterId: four.messages[2]!.id }]);

    // Once it is deleted: a branch from what it wrote is under its place too, which is under conv.
    const five = await orchestrator.branch(three.id, agentMessages(three)[2]!.id);
    expect(five.branch).toMatchObject({ fromId: one.id, fromTitle: 'second question', via: [{ id: conv.id, title: 'test' }] });

    // Every other conversation that remembered where one came from is deleted: still one family.
    await orchestrator.deleteConversation(two.id);
    await orchestrator.deleteConversation(three.id);
    expect(store.family(four.id).sort()).toEqual([conv.id, four.id, five.id].sort());
  });

  it('makes a branch one of the conversation further up once an edit leaves nothing of the one it was branched from', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'first question');
    await finish(conv.id);
    await orchestrator.send(conv.id, 'second question');
    await finish(conv.id);
    const one = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    one.title = 'One';
    store.saveMeta(one);
    await orchestrator.send(one.id, 'third question');
    await finish(one.id);
    // conv's first three, then one's three.
    const two = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    const mine = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    const blank = await orchestrator.branch(one.id, agentMessages(one).at(-1)!.id);
    expect(two.title).toBe('分支 · One');

    // Retrying a reply one wrote: one's part ends earlier.
    await orchestrator.retry(two.id, agentMessages(two).at(-1)!.id);
    await finish(two.id);
    expect(two.branch).toEqual({
      fromId: one.id,
      fromTitle: 'One',
      afterId: two.messages[4]!.id,
      earlier: [{ fromId: conv.id, fromTitle: 'test', afterId: two.messages[2]!.id }],
    });

    // Retrying a reply conv wrote: nothing of one is left, so it is conv's branch, named after conv
    // by its title now.
    conv.title = 'Renamed';
    store.saveMeta(conv);
    await orchestrator.retry(two.id, agentMessages(two)[1]!.id);
    expect(two.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: two.messages[1]!.id });
    expect(new Store(db).get(two.id)!.branch).toEqual(two.branch);
    await finish(two.id);
    expect(two.title).toBe('分支 · Renamed');
    expect(store.list(() => false).find((c) => c.id === two.id)!.branchFrom?.id).toBe(conv.id);

    // Editing the message one wrote first in a branch the user named: conv's branch, the name stays.
    mine.title = 'Mine';
    store.saveMeta(mine);
    await orchestrator.resend(mine.id, mine.messages[3]!.id, 'third question, edited');
    expect(mine.branch).toEqual({ fromId: conv.id, fromTitle: 'Renamed', afterId: mine.messages[2]!.id });
    await finish(mine.id);
    expect(mine.title).toBe('Mine');

    // Editing the first message: nothing copied is left, of either part.
    await orchestrator.resend(blank.id, blank.messages[0]!.id, 'from scratch');
    expect(blank.branch).toBeUndefined();
    await finish(blank.id);
    expect(blank.title).toBe('from scratch');
  });

  it('works while the team replies, but not from a reply with one before it still being written', async () => {
    const conv = conversation({ mode: 'parallel', permission: 'read-only' });
    let release!: () => void;
    fake.gates = { Alice: new Promise((r) => (release = r)) };
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(agentMessages(conv).map((m) => m.status)).toEqual(['streaming', 'done']));
    const bob = agentMessages(conv)[1]!;
    await expect(orchestrator.branch(conv.id, bob.id)).rejects.toMatchObject({ status: 409 });
    release();
    await finish(conv.id);
    expect(textOf(agentMessages(conv)[0]!)).toBe('Alice done');

    fake.gates = { Bob: new Promise(() => {}) }; // Bob only finishes when stopped
    await orchestrator.send(conv.id, 'again');
    await vi.waitFor(() => expect(agentMessages(conv).at(-2)?.status).toBe('done'));
    const branch = await orchestrator.branch(conv.id, agentMessages(conv).at(-2)!.id);
    expect(kinds(branch)).toEqual(['user', 'agent', 'agent', 'user', 'agent']);
    expect(orchestrator.isRunning(conv.id)).toBe(true);
    orchestrator.stop(conv.id);
    await finish(conv.id);
  });

  it("refuses the user's messages, unknown messages and unknown conversations", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    await expect(orchestrator.branch(conv.id, conv.messages[0]!.id)).rejects.toMatchObject({ status: 400 });
    await expect(orchestrator.branch(conv.id, 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(orchestrator.branch('nope', agentMessages(conv)[0]!.id)).rejects.toMatchObject({ status: 404 });
    expect(store.list(() => false)).toHaveLength(1);
  });

  it('copies the attached files and keeps the diffs of the copied replies, also once the original is deleted', async () => {
    const conv = conversation({ mode: 'roundtable' });
    conv.agents = [agents[0]!];
    fake.during = (_name, cwd) => writeFileSync(join(cwd, 'turn.txt'), 'changed\n');
    await orchestrator.send(conv.id, 'look', [
      { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('marmalade\n').toString('base64') },
      { name: 'gone.txt', mimeType: 'text/plain', data: 'aGk=' },
    ]);
    await finish(conv.id);
    const reply = agentMessages(conv)[0]!;
    expect(reply.changes?.[0]?.files.length).toBeGreaterThan(0);

    // A file already gone is skipped; the others are copied, readable by the owner only.
    const gone = conv.messages.find((m) => m.author.kind === 'user')!.parts.find((p) => p.type === 'attachment' && p.name === 'gone.txt')!;
    rmSync(gone.type === 'attachment' ? attachmentPath(conv.id, gone) : '');
    const branch = await orchestrator.branch(conv.id, reply.id);
    const file = branch.messages.find((m) => m.author.kind === 'user')!.parts.find((p) => p.type === 'attachment')!;
    expect(file.type === 'attachment' && readFileSync(attachmentPath(branch.id, file), 'utf8')).toBe('marmalade\n');
    // (Windows has no permission bits.)
    if (process.platform !== 'win32') expect(file.type === 'attachment' && statSync(attachmentPath(branch.id, file)).mode & 0o777).toBe(0o600);
    expect(gone.type === 'attachment' && existsSync(attachmentPath(branch.id, gone))).toBe(false);
    expect(refs().filter((r) => r.includes(`/${branch.id}/`))).toHaveLength(2);

    const copied = agentMessages(branch)[0]!;
    const diff = await orchestrator.messageDiff(branch.id, copied.id);
    await orchestrator.deleteConversation(conv.id);
    expect(file.type === 'attachment' && readFileSync(attachmentPath(branch.id, file), 'utf8')).toBe('marmalade\n');
    expect(await orchestrator.messageDiff(branch.id, copied.id)).toBe(diff);
    expect(refs().every((r) => r.includes(`/${branch.id}/`))).toBe(true);

    await orchestrator.deleteConversation(branch.id);
    expect(refs()).toEqual([]);
  });

  it('moves the line after the copied messages back when one of them is retried, and drops it once none is left', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    const [question, alice] = branch.messages;

    await orchestrator.retry(branch.id, agentMessages(branch)[1]!.id);
    await finish(branch.id);
    expect(kinds(branch)).toEqual(['user', 'agent', 'agent']);
    expect(branch.branch?.afterId).toBe(alice!.id);
    expect(new Store(db).get(branch.id)!.branch?.afterId).toBe(alice!.id);

    await orchestrator.resend(branch.id, question!.id, 'question, edited');
    await finish(branch.id);
    expect(branch.branch).toBeUndefined();
    expect(new Store(db).get(branch.id)!.branch).toBeUndefined();
    // No longer a branch: named after the edited question, as a new chat is after its first one.
    expect(branch.title).toBe('question, edited');
    expect(new Store(db).get(branch.id)!.title).toBe('question, edited');
  });

  it('keeps a name the user gave a branch once it is no longer one', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    branch.title = 'Mine';
    store.saveMeta(branch);
    await orchestrator.resend(branch.id, branch.messages[0]!.id, 'question, edited');
    await finish(branch.id);
    expect(branch.branch).toBeUndefined();
    expect(branch.title).toBe('Mine');
  });

  it('names a branch after a message that waited in its queue, and moves along with its family', async () => {
    store.createGroup({ id: 'g1', name: 'Docs' });
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    // Bob answers again; written meanwhile, the message waits in the queue, unposted.
    let release!: () => void;
    fake.gates = { Bob: new Promise((r) => (release = r)) };
    await orchestrator.retry(branch.id, agentMessages(branch)[1]!.id);
    await vi.waitFor(() => expect(orchestrator.isRunning(branch.id)).toBe(true));
    await orchestrator.send(branch.id, 'try it differently');
    expect(branch.queue?.map(textOf)).toEqual(['try it differently']);
    expect(branch.title).toBe('分支 · test');
    release();
    await finish(branch.id);
    expect(branch.messages.some((m) => textOf(m) === 'try it differently')).toBe(true);
    expect(branch.title).toBe('try it differently');

    // A family moves as one: from the branch, the original goes too.
    store.moveToGroup(branch.id, 'g1');
    expect(store.groupOf(conv.id)).toBe('g1');
  });

  it("keeps a question the reply asked open in the branch, also once it was answered here", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.asking = new Set(['Alice']);
    await orchestrator.send(conv.id, 'question');
    await finish(conv.id);
    const asked = agentMessages(conv)[0]!;
    expect(conv.pause).toMatchObject({ askers: ['a'], rest: [{ agentId: 'b' }] });

    // Branched where this conversation waits: the branch waits the same way.
    const now = await orchestrator.branch(conv.id, asked.id);
    expect(now.pause).toEqual(conv.pause);
    expect(new Store(db).get(now.id)!.pause).toEqual(conv.pause);

    // Answered here; a branch from the question still waits for its answer.
    await orchestrator.send(conv.id, 'ANSWER: A');
    await finish(conv.id);
    expect(conv.pause).toBeUndefined();
    const later = await orchestrator.branch(conv.id, asked.id);
    expect(later.pause).toEqual({ mode: 'roundtable', askers: ['a'], rest: [{ agentId: 'b' }], participants: ['a', 'b'], round: 1, rounds: 1 });

    // Its answer goes to the agent that asked, then the round goes on, with no new team designed.
    later.settings.autoTeam = true;
    calls.length = 0;
    await orchestrator.send(later.id, 'ANSWER: B');
    await finish(later.id);
    expect(calls.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(calls[0]!.prompt).toContain('You asked the user a question and their reply is among the messages above');
    expect(kinds(later)).toEqual(['user', 'agent', 'user', 'agent', 'agent']);
    expect(later.pause).toBeUndefined();
  });

  it('works out what a branch waits for in each mode, and waits for nothing after a reply that did not ask', () => {
    const reply = (agentId: string, asked: boolean, round = 1) =>
      ({ id: `${agentId}-${round}`, author: { kind: 'agent', agentId }, parts: [], status: 'done', createdAt: 0, meta: { round }, ...(asked ? { asked } : {}) }) as Conversation['messages'][number];
    const question = (text: string) => ({ id: 'q', author: { kind: 'user' }, parts: [{ type: 'text', text }], status: 'done', createdAt: 0 }) as Conversation['messages'][number];
    const conv = (mode: ConversationSettings['mode'], messages: Conversation['messages']) =>
      ({ id: 'c', agents, settings: { mode, rounds: 2, maxHops: 4, permission: 'read-only', cwd: project }, messages }) as unknown as Conversation;

    // Parallel: the round's questions before the reply wait together; the others answered already.
    expect(branchPause(conv('parallel', [question('go'), reply('a', true), reply('b', true)]), 2)).toEqual({
      mode: 'parallel', askers: ['a', 'b'], rest: [], participants: ['a', 'b'], round: 1, rounds: 2,
    });
    // Roundtable: a question for one member only leaves nobody after it in the round.
    expect(branchPause(conv('roundtable', [question('@Bob go'), reply('b', true, 2)]), 1)).toEqual({
      mode: 'roundtable', askers: ['b'], rest: [], participants: ['b'], round: 2, rounds: 2,
    });
    expect(branchPause(conv('relay', [question('go'), reply('a', true)]), 1)).toEqual({
      mode: 'relay', askers: ['a'], rest: [], participants: [], round: 1, rounds: 1, hopsLeft: 4,
    });
    expect(branchPause(conv('relay', [question('go'), reply('a', false)]), 1)).toBeUndefined();
  });

  it("works out where a branch's copied messages come from, and where they end after a cut, from its parts", () => {
    const msgs = (...ids: string[]) => ids.map((id) => ({ id })) as unknown as Conversation['messages'];
    const branch = { fromId: 'A', fromTitle: 'A', afterId: 'm4', earlier: [{ fromId: 'Z', fromTitle: 'Z', afterId: 'm1' }] };
    const b = { id: 'B', title: 'B', branch, messages: msgs('m0', 'm1', 'm2', 'm3', 'm4', 'm5') } as unknown as Conversation;
    const copies = msgs('c0', 'c1', 'c2', 'c3', 'c4', 'c5');
    const titleOf = (id: string) => ({ Z: 'Zed' })[id];
    // From the last message of the earlier part, and from inside the latest: by the titles now.
    expect(branchOrigin(b, 1, copies, titleOf)).toEqual({ fromId: 'Z', fromTitle: 'Zed', afterId: 'c1' });
    expect(branchOrigin(b, 3, copies, titleOf)).toEqual({ ...branch, afterId: 'c3', earlier: [{ fromId: 'Z', fromTitle: 'Zed', afterId: 'c1' }] });
    // From its own reply: its branch, with both parts before it.
    expect(branchOrigin(b, 5, copies)).toEqual({
      fromId: 'B',
      fromTitle: 'B',
      afterId: 'c5',
      earlier: [
        { fromId: 'A', fromTitle: 'A', afterId: 'c4' },
        { fromId: 'Z', fromTitle: 'Z', afterId: 'c1' },
      ],
    });

    // Cut: a part that lost its last message ends with the last one left; one left with nothing goes.
    expect(branchAfterCut({ branch, messages: msgs('m0', 'm1', 'm2') }, new Set(['m3', 'm4', 'm5']))).toEqual({ ...branch, afterId: 'm2' });
    expect(branchAfterCut({ branch, messages: msgs('m0', 'm1') }, new Set(['m2', 'm3', 'm4', 'm5']))).toEqual({ fromId: 'Z', fromTitle: 'Z', afterId: 'm1' });
    expect(branchAfterCut({ branch, messages: msgs('m0') }, new Set(['m1', 'm2', 'm3', 'm4', 'm5']))).toEqual({ fromId: 'Z', fromTitle: 'Z', afterId: 'm0' });
    expect(branchAfterCut({ branch, messages: [] }, new Set(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']))).toBeUndefined();
    // Nothing of it dropped: as it was.
    expect(branchAfterCut({ branch, messages: msgs('m0', 'm1', 'm2', 'm3', 'm4') }, new Set(['m5']))).toEqual(branch);

    // A part whose last message is not here, and was not just dropped, cannot be placed: left out.
    const odd = { ...branch, earlier: [{ fromId: 'Z', fromTitle: 'Z', afterId: 'gone' }] };
    expect(branchAfterCut({ branch: odd, messages: b.messages }, new Set(['m6']))).toEqual({ fromId: 'A', fromTitle: 'A', afterId: 'm4' });
    expect(branchOrigin({ ...b, branch: odd }, 1, copies)).toEqual({ fromId: 'A', fromTitle: 'A', afterId: 'c1' });
  });

  it('waits for a parallel peer whose turn still records the files it changed', async () => {
    const conv = conversation({ mode: 'parallel' });
    let release!: () => void;
    fake.gates = { Alice: new Promise((r) => (release = r)) };
    await orchestrator.send(conv.id, 'question');
    await vi.waitFor(() => expect(agentMessages(conv)[1]?.changes).toBeTruthy(), { timeout: 10_000, interval: 5 });
    release();
    // Alice's reply is done, but her turn has not recorded her changes yet.
    while (agentMessages(conv)[0]!.status !== 'done') await new Promise((r) => setImmediate(r));
    expect(agentMessages(conv)[0]!.changes).toBeUndefined();
    await expect(orchestrator.branch(conv.id, agentMessages(conv)[1]!.id)).rejects.toMatchObject({ status: 409 });
    await finish(conv.id);
    const branch = await orchestrator.branch(conv.id, agentMessages(conv)[1]!.id);
    expect(agentMessages(branch).map((m) => Boolean(m.changes?.[0]?.files.length))).toEqual([true, true]);
  });

  it('finishes copying the attached files before the original is deleted, and before shutdown', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    conv.agents = [agents[0]!];
    const big = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.txt`, mimeType: 'text/plain', data: Buffer.alloc(1_000_000, 65).toString('base64') }));
    await orchestrator.send(conv.id, 'look', big);
    await finish(conv.id);
    const [branch] = await Promise.all([orchestrator.branch(conv.id, agentMessages(conv)[0]!.id), orchestrator.deleteConversation(conv.id)]);
    const files = branch.messages[0]!.parts.filter((p) => p.type === 'attachment');
    expect(files).toHaveLength(10);
    expect(files.filter((p) => p.type === 'attachment' && existsSync(attachmentPath(branch.id, p)))).toHaveLength(10);
    expect(store.get(conv.id)).toBeUndefined();

    let done = false;
    const again = orchestrator.branch(branch.id, agentMessages(branch)[0]!.id).then(() => (done = true));
    orchestrator.stopAll();
    await orchestrator.settled(10_000);
    expect(done).toBe(true);
    await again;
    await expect(orchestrator.branch(branch.id, agentMessages(branch)[0]!.id)).rejects.toMatchObject({ status: 503 });
  });

  it("shows a parallel reply's images from the worktree it was made in, not the branch's own", async () => {
    const conv = conversation({ mode: 'parallel' });
    conv.agents = [agents[0]!];
    await orchestrator.send(conv.id, 'draw');
    await finish(conv.id);
    const reply = agentMessages(conv)[0]!;
    expect(reply.changes?.[0]?.isolated).toBe(true);
    const wt = conv.worktrees.a![0]!;
    writeFileSync(join(worktreeDir(wt.root, conv.settings.cwd, wt.path), 'chart.png'), 'the original chart');
    const lookup = (id: string) => store.get(id);
    const chart = (c: Conversation, m: Conversation['messages'][number]) => {
      const file = resolveMedia('chart.png', mediaRoots(c, m, lookup));
      return file && readFileSync(file, 'utf8');
    };

    const branch = await orchestrator.branch(conv.id, reply.id);
    const copied = agentMessages(branch)[0]!;
    expect(chart(branch, copied)).toBe('the original chart');
    // The branch works in its own worktree; the copied reply still shows the original's chart.
    await orchestrator.send(branch.id, 'draw again');
    await finish(branch.id);
    const own = branch.worktrees.a![0]!;
    writeFileSync(join(worktreeDir(own.root, branch.settings.cwd, own.path), 'chart.png'), "the branch's chart");
    expect(chart(branch, copied)).toBe('the original chart');
    expect(chart(branch, agentMessages(branch)[1]!)).toBe("the branch's chart");

    // Once the original is gone, so is its worktree; the diff stays.
    const diff = await orchestrator.messageDiff(branch.id, copied.id);
    expect(diff).toContain('Alice.txt');
    await orchestrator.deleteConversation(conv.id);
    expect(chart(branch, copied)).toBeUndefined();
    expect(await orchestrator.messageDiff(branch.id, copied.id)).toBe(diff);
  });
});
