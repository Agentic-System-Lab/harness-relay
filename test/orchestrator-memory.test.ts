/*
 * Long-term memory in team runs: a reply's blocks taken out and recorded, what teammates and later
 * conversations are given (the briefing's pinned notes, notes recalled once per session), the reply's
 * card following the note, memory switched off, and the lead agent tidying after a run.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { MEMORY_LIMITS, type MemoryNote } from '../src/shared/types';
import { agentMessages, calls, conversation, fake, finish, orchestrator, store, textOf } from './orchestrator-harness';

const note = (over: Partial<MemoryNote> & { id: string; text: string }): MemoryNote => ({
  basis: 'user',
  state: 'active',
  author: { kind: 'user' },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('long-term memory in team runs', () => {
  it("takes a reply's blocks out of its text, records them, and tells the next teammate", async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.reply = (name) =>
      name === 'Alice' ? 'Noted.\n\n<remember scope="project" basis="user">The user deploys with scripts/deploy.sh.</remember>' : undefined;
    await orchestrator.send(conv.id, 'Remember: we deploy with scripts/deploy.sh');
    await finish(conv.id);

    const [alice] = agentMessages(store.get(conv.id)!);
    expect(textOf(alice!)).toBe('Noted.');
    const part = alice!.parts.find((p) => p.type === 'memory');
    expect(part).toMatchObject({
      notes: [{ op: 'saved', status: 'active', text: 'The user deploys with scripts/deploy.sh.', cwd: conv.settings.cwd }],
    });
    const [saved] = orchestrator.memory.view().notes;
    expect(saved).toMatchObject({
      text: 'The user deploys with scripts/deploy.sh.',
      cwd: conv.settings.cwd,
      basis: 'user',
      author: { kind: 'agent', name: 'Alice', provider: 'claude' },
      conversationId: conv.id,
      messageId: alice!.id,
    });
    // Bob reads what Alice saved, with its id, so he can correct it.
    const bob = calls.find((c) => c.name === 'Bob')!;
    expect(bob.prompt).toContain(`<memory_saved>\n- saved [${saved!.id}]: The user deploys with scripts/deploy.sh.\n</memory_saved>`);
    // Every member is told what memory is for.
    expect(bob.systemPrompt).toContain('# Long-term memory');
    expect(bob.systemPrompt).toContain(`working directory (${conv.settings.cwd})`);
  });

  it('counts a reply that only saved a note as one that said something', async () => {
    const conv = conversation({ mode: 'relay' });
    fake.reply = () => '<remember>Short answers, please.</remember>';
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const [reply] = agentMessages(store.get(conv.id)!);
    expect(reply!.passed).toBe(false);
    expect(textOf(reply!)).toBe('');
  });

  it('gives a later conversation the pinned notes in its briefing, and matching notes once per session', async () => {
    const first = conversation({ mode: 'relay' });
    store.saveMemoryNote(note({ id: 'm_pin', text: 'Answer in Traditional Chinese.', pinned: 'user' }));
    store.saveMemoryNote(note({ id: 'm_deploy', text: 'Deploys go through scripts/deploy.sh with AWS_PROFILE=prod.' }));
    store.saveMemoryNote(note({ id: 'm_here', text: 'deploy notes from this very chat', conversationId: first.id }));
    store.saveMemoryNote(note({ id: 'm_far', text: 'deploy rules of another project', cwd: '/somewhere/else' }));

    await orchestrator.send(first.id, 'How do we deploy?');
    await finish(first.id);
    const turn1 = calls.find((c) => c.name === 'Alice')!;
    expect(turn1.systemPrompt).toContain('<memory_notes>\n- [m_pin] everywhere · user · the user');
    expect(turn1.prompt).toContain('<recalled_memory>\n- [m_deploy] everywhere');
    expect(turn1.prompt).not.toContain('m_here');
    expect(turn1.prompt).not.toContain('m_far');
    expect(turn1.prompt).not.toContain('m_pin');
    expect(store.get(first.id)!.agentState.a!.seen).toContain('memory:m_deploy');
    expect(store.memoryNote('m_deploy')?.usedAt).toBeGreaterThan(0);

    // The same session is not given it again.
    calls.length = 0;
    await orchestrator.send(first.id, 'And deploy to staging?');
    await finish(first.id);
    const turn2 = calls.find((c) => c.name === 'Alice')!;
    expect(turn2.sessionId).toBe('session-Alice');
    expect(turn2.prompt).not.toContain('<recalled_memory>');
  });

  it("updates a note's card in the reply that saved it when the user changes it", async () => {
    const conv = conversation({ mode: 'relay' });
    fake.reply = () => 'ok\n<remember>Tabs, not spaces.</remember>';
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const [n] = orchestrator.memory.view().notes;
    orchestrator.memory.edit(n!.id, { state: 'archived' });
    const card = () => agentMessages(store.get(conv.id)!)[0]!.parts.find((p) => p.type === 'memory');
    expect(card()).toMatchObject({ notes: [{ id: n!.id, status: 'archived' }] });
    orchestrator.memory.remove(n!.id);
    expect(card()).toMatchObject({ notes: [{ id: n!.id, status: 'deleted' }] });
  });

  it('leaves the blocks and says nothing about memory while it is off', async () => {
    orchestrator.memory.updateSettings({ enabled: false });
    store.saveMemoryNote(note({ id: 'm_pin', text: 'pinned', pinned: 'user' }));
    const conv = conversation({ mode: 'relay' });
    fake.reply = () => 'x\n<remember>kept as text</remember>';
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(textOf(agentMessages(store.get(conv.id)!)[0]!)).toContain('<remember>kept as text</remember>');
    expect(calls.find((c) => c.name === 'Alice')!.systemPrompt).not.toContain('Long-term memory');
    expect(orchestrator.memory.view().notes).toHaveLength(1);
  });

  it(`has the lead agent tidy once ${MEMORY_LIMITS.tidyAfterChanges} notes changed, checking them against their source`, async () => {
    const conv = conversation({ mode: 'relay' });
    const blocks = Array.from({ length: MEMORY_LIMITS.tidyAfterChanges }, (_, i) => `<remember>fact ${i}</remember>`).join('\n');
    fake.reply = () => `Saved them.\n${blocks}`;
    let release!: () => void;
    fake.tidyGate = new Promise((r) => (release = r));
    fake.tidyReply = '';
    await orchestrator.send(conv.id, 'Please remember these facts');
    await finish(conv.id);
    await vi.waitFor(() => expect(orchestrator.memory.tidying).toBe(true));
    const ids = orchestrator.memory.view().notes.map((n) => n.id);
    fake.tidyReply = JSON.stringify({
      changes: [
        { op: 'merge', ids: [ids[0], ids[1]], text: 'facts 0 and 1' },
        { op: 'remove', id: ids[2], reason: 'not worth keeping' },
        { op: 'pin', id: ids[3] },
      ],
      summary: 'Merged two, set one aside.',
    });
    release();
    await vi.waitFor(() => expect(orchestrator.memory.tidying).toBe(false));

    const tidier = calls.find((c) => c.name === 'tidier')!;
    expect(tidier).toMatchObject({ stateKey: 'memory', freshState: true, permission: 'read-only' });
    expect(tidier.prompt).toContain('<notes>');
    expect(tidier.prompt).toContain('<message from="user">\nPlease remember these facts\n</message>');
    expect(tidier.prompt).toContain('<message from="@Alice">\nSaved them.');
    const view = orchestrator.memory.view();
    expect(view.lastTidy).toMatchObject({ changes: 3, summary: 'Merged two, set one aside.' });
    expect(view.changedSinceTidy).toBe(0);
    expect(view.notes.find((n) => n.text === 'facts 0 and 1')).toMatchObject({
      author: { kind: 'lead', provider: 'claude' },
      conversationId: conv.id,
    });
    expect(view.notes.find((n) => n.id === ids[2])).toMatchObject({ state: 'archived', reason: 'not worth keeping' });
    expect(view.notes.find((n) => n.id === ids[3])?.pinned).toBe('lead');
    // The cards in the reply say which were set aside.
    const card = agentMessages(store.get(conv.id)!)[0]!.parts.find((p) => p.type === 'memory');
    expect(
      card &&
        card.type === 'memory' &&
        card.notes
          .filter((n) => n.status === 'archived')
          .map((n) => n.id)
          .sort(),
    ).toEqual([ids[0], ids[1], ids[2]].sort());

    // Not again so soon, however many notes change.
    calls.length = 0;
    await orchestrator.send(conv.id, 'more');
    await finish(conv.id);
    expect(orchestrator.memory.tidying).toBe(false);
    expect(calls.some((c) => c.name === 'tidier')).toBe(false);
  });

  it('keeps the card of a reply that passed but saved a note, and tells the next teammate what it saved', async () => {
    const conv = conversation({ mode: 'roundtable', permission: 'read-only' });
    fake.reply = (name) => (name === 'Alice' ? '[PASS]\n<remember>Nothing to add, but the CI runs on Node 24.</remember>' : undefined);
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const [alice] = agentMessages(store.get(conv.id)!);
    expect(alice!.passed).toBe(true);
    expect(alice!.parts.find((p) => p.type === 'memory')).toMatchObject({ notes: [{ op: 'saved', status: 'active' }] });
    expect(calls.find((c) => c.name === 'Bob')!.prompt).toContain('[PASS]\n\n<memory_saved>\n- saved [');
  });

  it('keeps the notes a failed reply finished writing', async () => {
    const conv = conversation({ mode: 'relay' });
    fake.inTurn = async (_name, o) => {
      o.onEvent({ type: 'text', text: 'Half done.\n<remember>Kept from a reply that failed.</remember>\n' });
      o.onEvent({ type: 'text_end' });
    };
    fake.fail = () => new Error('rate limited');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const [reply] = agentMessages(store.get(conv.id)!);
    expect(reply!.status).toBe('error');
    expect(textOf(reply!)).toBe('Half done.');
    expect(orchestrator.memory.view().notes.map((n) => n.text)).toEqual(['Kept from a reply that failed.']);
  });

  it('offers a recalled note again after a turn that failed', async () => {
    store.saveMemoryNote(note({ id: 'm_deploy', text: 'Deploys go through scripts/deploy.sh.' }));
    const conv = conversation({ mode: 'relay' });
    fake.fail = (name, sessionId) =>
      name === 'Alice' && !sessionId && calls.filter((c) => c.name === 'Alice').length === 1 ? new Error('rate limited') : undefined;
    await orchestrator.send(conv.id, 'How do we deploy?');
    await finish(conv.id);
    expect(store.get(conv.id)!.agentState.a?.seen ?? []).not.toContain('memory:m_deploy');
    await orchestrator.send(conv.id, 'And again: how do we deploy?');
    await finish(conv.id);
    const alice = calls.filter((c) => c.name === 'Alice');
    expect(alice).toHaveLength(2);
    for (const c of alice) expect(c.prompt).toContain('[m_deploy]');
  });

  it('sets aside the notes of a reply that Retry takes away', async () => {
    const conv = conversation({ mode: 'relay' });
    let n = 0;
    fake.reply = () => (++n === 1 ? 'ok\n<remember>A wrong guess.</remember>' : 'ok');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const [first] = agentMessages(store.get(conv.id)!);
    await orchestrator.retry(conv.id, first!.id);
    await finish(conv.id);
    expect(orchestrator.memory.view().notes).toMatchObject([{ text: 'A wrong guess.', state: 'archived' }]);
    expect(agentMessages(store.get(conv.id)!).flatMap((m) => m.parts.filter((p) => p.type === 'memory'))).toEqual([]);
  });

  it('stops a tidying when memory is switched off, and one that started by itself when automatic tidying is, but not for another switch', async () => {
    store.saveMemoryNote(note({ id: 'm_1', text: 'one', author: { kind: 'agent', name: 'Alice', provider: 'claude' } }));
    let release!: () => void;
    fake.tidyGate = new Promise((r) => (release = r));
    // The user's own tidying goes on through other switches, automatic tidying's among them.
    orchestrator.memory.tidyNow();
    orchestrator.memory.updateSettings({ review: true });
    orchestrator.memory.updateSettings({ autoTidy: false });
    expect(orchestrator.memory.tidying).toBe(true);
    orchestrator.memory.updateSettings({ enabled: false });
    await vi.waitFor(() => expect(orchestrator.memory.tidying).toBe(false));
    release();
    expect(orchestrator.memory.view().lastTidy).toBeUndefined();
  });

  it('records why a tidying failed, and refuses Tidy up now while it is off or has nothing to tidy', async () => {
    expect(() => orchestrator.memory.tidyNow()).toThrow();
    store.saveMemoryNote(note({ id: 'm_1', text: 'one', author: { kind: 'agent', name: 'Alice', provider: 'claude' } }));
    fake.tidyReply = 'not json';
    orchestrator.memory.tidyNow();
    expect(() => orchestrator.memory.tidyNow()).toThrow();
    await vi.waitFor(() => expect(orchestrator.memory.tidying).toBe(false));
    expect(orchestrator.memory.view().lastTidy?.error).toBeTruthy();
    orchestrator.memory.updateSettings({ enabled: false });
    expect(() => orchestrator.memory.tidyNow()).toThrow();
  });
});
