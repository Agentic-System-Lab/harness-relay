/*
 * The team's working directory with edit permission: Harness Relay's own folder, worktrees in
 * parallel mode, changes recorded in roundtable mode, nested repositories and kept snapshot refs.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { agentMessages, agents, conversation, fake, finish, Hub, orchestrator, Orchestrator, project, setOrchestrator, settings, store, withLang } from './orchestrator-harness';

describe("Harness Relay's own folder", () => {
  it('refuses an edit-mode turn there, also for a conversation saved before the check', async () => {
    const { RELAY_ROOT } = await import('../src/server/protect');
    setOrchestrator(new Orchestrator(store, new Hub(), settings));
    const conv = conversation({ mode: 'roundtable', permission: 'edit', cwd: RELAY_ROOT });
    await withLang('en', () => orchestrator.send(conv.id, 'go'));
    await finish(conv.id);
    const replies = agentMessages(store.get(conv.id)!);
    expect(replies.length).toBeGreaterThan(0);
    for (const m of replies) {
      expect(m.status).toBe('error');
      expect(m.error).toMatch(/holds Harness Relay itself/);
    }
  });
});

describe('parallel mode with edit permission', () => {
  it('gives each agent its own worktree so they cannot overwrite each other', async () => {
    const conv = conversation({ mode: 'parallel' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    // The directory became a git repository automatically.
    expect(conv.messages[0]!.author.kind).toBe('system');
    expect(conv.messages[0]!.parts[0]).toMatchObject({ text: expect.stringContaining('git init') });

    // The real directory is untouched; each agent's write landed in its own worktree.
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('original\n');
    for (const a of agents) {
      const wt = conv.worktrees[a.id]![0]!;
      expect(readFileSync(join(wt.path, 'shared.txt'), 'utf8')).toBe(`written by ${a.name}\n`);
    }
    for (const m of agentMessages(conv)) {
      expect(m.status).toBe('done');
      expect(m.changes?.[0]?.isolated).toBe(true);
      expect(m.changes?.[0]?.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual([
        `A ${m.agentName}.txt`,
        'M shared.txt',
      ]);
    }

    // Apply Bob's result; Alice's is now out of date.
    await orchestrator.applyAgentWork(conv.id, 'b');
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    expect(readFileSync(join(project, 'Bob.txt'), 'utf8')).toBe('Bob\n');
    expect(Object.values(conv.worktrees).flat().every((w) => w.needsReset)).toBe(true);
    await expect(orchestrator.applyAgentWork(conv.id, 'a')).rejects.toThrow(/過期/);

    // The next parallel run starts both agents from the new state of the directory.
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(Object.values(conv.worktrees).flat().some((w) => w.needsReset)).toBe(false);
    const aliceWt = conv.worktrees.a![0]!.path;
    expect(readFileSync(join(aliceWt, 'Bob.txt'), 'utf8')).toBe('Bob\n');

    await orchestrator.cleanupWorktrees(conv);
  });
});

describe('roundtable mode with edit permission', () => {
  it('lets agents work in the real directory and records what each one changed', async () => {
    const conv = conversation({ mode: 'roundtable' });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    const [alice, bob] = agentMessages(conv);
    expect(alice!.changes).toMatchObject([{ isolated: false }]);
    expect(alice!.changes![0]!.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'shared.txt']);
    expect(bob!.changes![0]!.files.map((f) => f.path).sort()).toEqual(['Bob.txt', 'shared.txt']);
    expect(conv.worktrees).toEqual({});
  });

  it('does not let two conversations write to the same directory at once', async () => {
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    const first = conversation({ mode: 'roundtable' });
    const second = conversation({ mode: 'relay' });

    await orchestrator.send(first.id, 'go');
    await expect(orchestrator.send(second.id, 'go')).rejects.toThrow(/正在修改/);
    // Read-only conversations are not blocked.
    const reader = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(reader.id, 'look');

    release();
    await finish(first.id);
    await finish(reader.id);
    await orchestrator.send(second.id, 'go');
    await finish(second.id);
  });
});

describe('kept snapshot refs', () => {
  const refs = () =>
    execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/harness-relay/'], { cwd: project, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

  it('are dropped with the messages that linked to them, and with the conversation', async () => {
    const conv = conversation({ mode: 'roundtable' });
    conv.agents = [agents[0]!];
    let turn = 0;
    fake.during = (_name, cwd) => writeFileSync(join(cwd, 'turn.txt'), `turn ${++turn}\n`); // every turn changes a file
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    const kept = refs();
    expect(kept.length).toBe(2); // the turn's before and after snapshots

    await orchestrator.send(conv.id, 'second');
    await finish(conv.id);
    // (Its "before" may be the first turn's "after": same tree, parent and second give the same commit.)
    expect(refs().length).toBeGreaterThan(kept.length);

    // Editing the second question drops its turn (and its refs); the first turn's stay.
    const second = conv.messages.filter((m) => m.author.kind === 'user')[1]!;
    fake.during = undefined; // the edited turn changes nothing
    await orchestrator.resend(conv.id, second.id, 'second, edited');
    await finish(conv.id);
    await vi.waitFor(() => expect(refs().sort()).toEqual([...kept].sort()));

    await orchestrator.deleteConversation(conv.id);
    expect(refs()).toEqual([]);
  });
});

describe('nested repositories', () => {
  it('does not let two conversations write a repository and one nested inside it at once', async () => {
    const inner = join(project, 'lib');
    mkdirSync(inner);
    execFileSync('git', ['init', '-q'], { cwd: inner });
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    const outer = conversation({ mode: 'roundtable' }); // project: a repository of its own is created
    outer.agents = [agents[0]!];
    await orchestrator.send(outer.id, 'go');
    const nested = conversation({ mode: 'roundtable', cwd: inner });
    nested.agents = [agents[1]!];
    await expect(orchestrator.send(nested.id, 'go')).rejects.toThrow(/正在修改/);
    release();
    await finish(outer.id);
  });
});

describe('parallel worktrees', () => {
  it('records a turn whose agent committed its work itself', async () => {
    const conv = conversation({ mode: 'parallel' });
    fake.during = (name, cwd) => {
      if (name !== 'Alice') return;
      execFileSync('git', ['add', '-A'], { cwd });
      execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@x', 'commit', '-q', '-m', 'mine'], { cwd });
    };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const alice = agentMessages(conv).find((m) => m.agentName === 'Alice')!;
    expect(alice.changes?.[0]?.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'shared.txt']);
    await orchestrator.cleanupWorktrees(conv);
  });
});
