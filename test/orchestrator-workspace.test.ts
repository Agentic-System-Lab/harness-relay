/*
 * The team's working directory with edit permission: Harness Relay's own folder, worktrees in
 * parallel mode, changes recorded in roundtable mode, nested repositories and kept snapshot refs.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fileRoots } from '../src/server/files';
import { TEAM_WORKTREE, type Conversation } from '../src/shared/types';
import {
  agentMessages,
  agents,
  calls,
  conversation,
  db,
  fake,
  finish,
  Hub,
  orchestrator,
  Orchestrator,
  project,
  setOrchestrator,
  settings,
  store,
  Store,
  textOf,
  withLang,
} from './orchestrator-harness';

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
      expect(m.changes?.[0]?.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual([`A ${m.agentName}.txt`, 'M shared.txt']);
    }

    // Apply Bob's result; Alice's is now out of date.
    await orchestrator.applyAgentWork(conv.id, 'b');
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    expect(readFileSync(join(project, 'Bob.txt'), 'utf8')).toBe('Bob\n');
    expect(
      Object.values(conv.worktrees)
        .flat()
        .every((w) => w.needsReset),
    ).toBe(true);
    await expect(orchestrator.applyAgentWork(conv.id, 'a')).rejects.toThrow(/過期/);

    // The next parallel run starts both agents from the new state of the directory.
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(
      Object.values(conv.worktrees)
        .flat()
        .some((w) => w.needsReset),
    ).toBe(false);
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

  it("says in the reply when it cannot record a turn's changes (a link in the repository's git folder), and writes nothing through it", async () => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    const outside = join(dirname(project), 'outside-refs');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(project, '.git', 'refs', 'harness-relay'), process.platform === 'win32' ? 'junction' : 'dir');
    const conv = conversation({ mode: 'roundtable' });
    await withLang('en', () => orchestrator.send(conv.id, 'go'));
    await finish(conv.id);

    const [alice] = agentMessages(conv);
    expect(alice!.status).toBe('done');
    expect(alice!.changes).toBeUndefined();
    expect(alice!.parts).toContainEqual({
      type: 'notice',
      text: expect.stringMatching(
        /^Harness Relay could not record what this turn changed in .*, so its changes are not shown: git .* is a link in the repository's git folder/,
      ),
    });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('lets read-only conversations read while it writes', async () => {
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    const first = conversation({ mode: 'roundtable' });
    await orchestrator.send(first.id, 'go');
    const reader = conversation({ mode: 'roundtable', permission: 'read-only' });
    await orchestrator.send(reader.id, 'look');
    release();
    await finish(first.id);
    await finish(reader.id);
    expect(reader.worktrees).toEqual({});
  });
});

describe('two conversations writing in the same folder', () => {
  const branches = () =>
    execFileSync('git', ['branch', '--list', 'relay/*', '--format=%(refname:short)'], { cwd: project, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

  /** A conversation of Alice alone, whose turn writes in the folder and waits there until released. */
  async function writing(): Promise<{ conv: Conversation; release: () => void }> {
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    const conv = conversation({ mode: 'roundtable' });
    conv.agents = [agents[0]!];
    const before = calls.length;
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(calls).toHaveLength(before + 1));
    fake.gate = Promise.resolve(); // the other conversation's turns do not wait
    return { conv, release };
  }

  it('gives the second one a worktree of its own, which its members share, and applies its result once the folder is free', async () => {
    const { conv: first, release } = await writing();
    const second = conversation({ mode: 'roundtable' });
    const before = calls.length;
    await expect(withLang('en', () => orchestrator.send(second.id, 'go'))).resolves.toEqual({ queued: false });
    await finish(second.id);

    // One worktree of the repository, named as the folder is, on the team's branch.
    const team = second.worktrees[TEAM_WORKTREE]!;
    expect(team).toEqual([
      {
        root: project,
        path: expect.any(String),
        branch: `relay/${second.id.slice(0, 8)}/${TEAM_WORKTREE}`,
        base: expect.any(String),
        needsReset: false,
      },
    ]);
    expect(basename(team[0]!.path)).toBe(basename(project));
    // Every member works in it, told so.
    const turns = calls.slice(before);
    expect(turns.map((c) => [c.name, c.cwd])).toEqual([
      ['Alice', team[0]!.path],
      ['Bob', team[0]!.path],
    ]);
    expect(turns[0]!.systemPrompt).toContain("so this conversation's team works in its OWN git worktree");
    // The chat says why, after the user's message.
    expect(second.messages.map((m) => m.author.kind)).toEqual(['user', 'system', 'agent', 'agent']);
    expect(textOf(second.messages[1]!)).toBe(
      `Conversation "${first.title}" is changing ${project}, so this conversation's team works in a worktree of its own (a copy of the folder), and both go on at once. The team's changes reach the folder when you apply them ("Apply to working directory"); until then, this conversation's next replies are worked on in that worktree too.`,
    );
    // Its changes are on the team's branch, not in the folder; the first conversation's only its own.
    const bob = agentMessages(second).find((m) => m.agentName === 'Bob')!;
    expect(bob.changes).toMatchObject([{ root: project, isolated: true, branch: team[0]!.branch }]);
    expect(bob.changes![0]!.files.map((f) => f.path).sort()).toEqual(['Bob.txt', 'shared.txt']);
    expect(existsSync(join(project, 'Bob.txt'))).toBe(false);
    expect(orchestrator.folderInUse(second.id)).toBe(true); // the first conversation writes there
    // Browsed beside the working directory.
    expect(fileRoots(second)).toContainEqual({ id: TEAM_WORKTREE, path: team[0]!.path, agentId: TEAM_WORKTREE });

    // Not applied while the first one writes there.
    await expect(withLang('en', () => orchestrator.applyAgentWork(second.id, TEAM_WORKTREE))).rejects.toMatchObject({
      status: 409,
      message: `Conversation "${first.title}" is changing ${project}; apply once it finishes.`,
    });
    release();
    await finish(first.id);
    const [alice] = agentMessages(first);
    expect(alice!.changes![0]!.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'shared.txt']);

    expect(await orchestrator.agentDiff(second.id, TEAM_WORKTREE)).toContain('+++ b/Bob.txt');
    const { files } = await withLang('en', () => orchestrator.applyAgentWork(second.id, TEAM_WORKTREE));
    expect(files.map((f) => f.path).sort()).toEqual(['Bob.txt', 'shared.txt']);
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    expect(textOf(second.messages.at(-1)!)).toMatch(
      /^Applied the team's changes from this conversation's worktree to the working directory \(2 files/,
    );
    expect(team[0]!.needsReset).toBe(true);

    // Its next run writes in the folder again, and its worktree, folder and branch are gone.
    const next = calls.length;
    await orchestrator.send(second.id, 'more');
    await finish(second.id);
    expect(calls.slice(next).map((c) => c.cwd)).toEqual([project, project]);
    expect(second.worktrees[TEAM_WORKTREE]).toBeUndefined();
    expect(existsSync(dirname(team[0]!.path))).toBe(false);
    expect(branches()).not.toContain(team[0]!.branch);
    expect(store.get(second.id)!.worktrees).toEqual({});
  });

  it('goes on in its own worktree while what the team did there is not applied, until the chat is rewound past it', async () => {
    const { conv: first, release } = await writing();
    const second = conversation({ mode: 'roundtable' });
    second.agents = [agents[1]!];
    await orchestrator.send(second.id, 'go');
    await finish(second.id);
    release();
    await finish(first.id);
    const team = second.worktrees[TEAM_WORKTREE]![0]!;

    // The folder is free now, but the team's work is in its worktree: it goes on there, saying nothing more.
    let next = calls.length;
    fake.during = (_name, cwd) => writeFileSync(join(cwd, 'more.txt'), 'more\n');
    await orchestrator.send(second.id, 'more');
    await finish(second.id);
    expect(calls.slice(next).map((c) => c.cwd)).toEqual([team.path]);
    expect(second.messages.filter((m) => m.author.kind === 'system')).toHaveLength(1);
    expect(existsSync(join(team.path, 'more.txt'))).toBe(true);
    expect(existsSync(join(project, 'more.txt'))).toBe(false);
    // Read again after a restart, and gone on with there.
    const restarted = new Store(db);
    expect(restarted.get(second.id)!.worktrees[TEAM_WORKTREE]).toEqual([team]);
    setOrchestrator(new Orchestrator(restarted, new Hub(), settings));
    next = calls.length;
    await orchestrator.send(second.id, 'after a restart');
    await finish(second.id);
    expect(calls.slice(next).map((c) => c.cwd)).toEqual([team.path]);
    const reloaded = restarted.get(second.id)!;

    // Asked again from the first question: what the team did there is dropped, and it writes in the folder.
    fake.during = undefined;
    next = calls.length;
    const question = reloaded.messages.find((m) => m.author.kind === 'user')!;
    await orchestrator.resend(second.id, question.id, 'go again');
    await finish(second.id);
    expect(calls.slice(next).map((c) => c.cwd)).toEqual([project]);
    expect(reloaded.worktrees[TEAM_WORKTREE]).toBeUndefined();
    expect(existsSync(team.path)).toBe(false);
  });

  it('keeps what the team did in its worktree when a later reply is retried: a rewind leaves its files, as in the folder', async () => {
    const { conv: holder, release } = await writing();
    const second = conversation({ mode: 'roundtable' });
    second.agents = [agents[1]!];
    fake.during = (_name, cwd) => writeFileSync(join(cwd, 'first.txt'), 'first\n');
    await orchestrator.send(second.id, 'go');
    await finish(second.id);
    const [first] = agentMessages(second);
    const team = second.worktrees[TEAM_WORKTREE]![0]!;
    // The next reply fails; Retry runs it again in the same worktree, which still holds the first one's work.
    fake.during = (_name, cwd) => writeFileSync(join(cwd, 'second.txt'), 'second\n');
    fake.fail = () => new Error('rate limited');
    await orchestrator.send(second.id, 'more');
    await finish(second.id);
    fake.fail = undefined;
    const failed = agentMessages(second).at(-1)!;
    expect(failed.status).toBe('error');
    await orchestrator.retry(second.id, failed.id);
    await finish(second.id);
    expect(second.worktrees[TEAM_WORKTREE]).toEqual([{ ...team, path: team.path }]);
    expect(team.needsReset).toBe(false);
    expect(calls.at(-1)!.cwd).toBe(team.path);
    expect(existsSync(join(team.path, 'first.txt'))).toBe(true);
    // The first reply's result is still there to apply, with the retried one's.
    expect(second.messages).toContain(first);
    release();
    await finish(holder.id);
    const { files } = await orchestrator.applyAgentWork(second.id, TEAM_WORKTREE);
    expect(files.map((f) => f.path).sort()).toEqual(['Bob.txt', 'first.txt', 'second.txt', 'shared.txt']);
  });

  it("makes a worktree that holds nothing of the team's again from the folder as it is now, while the folder is still taken", async () => {
    const { release } = await writing();
    const second = conversation({ mode: 'roundtable' });
    second.agents = [agents[0]!]; // writes what the first one's Alice wrote already: nothing changes
    await orchestrator.send(second.id, 'go');
    await finish(second.id);
    const before = second.worktrees[TEAM_WORKTREE]![0]!.base;
    // The other conversation writes on meanwhile.
    writeFileSync(join(project, 'later.txt'), 'later\n');
    await orchestrator.send(second.id, 'again');
    await finish(second.id);
    const team = second.worktrees[TEAM_WORKTREE]![0]!;
    expect(team.base).not.toBe(before);
    expect(existsSync(join(team.path, 'later.txt'))).toBe(true);
    // Said again why it works there.
    expect(second.messages.filter((m) => m.author.kind === 'system')).toHaveLength(2);
    release();
  });

  it('leaves the folder to a conversation whose team has nothing in its worktree, once it is free', async () => {
    const { conv: first, release } = await writing();
    const second = conversation({ mode: 'roundtable' });
    second.agents = [agents[0]!]; // writes what the first one's Alice wrote already: nothing changes
    await orchestrator.send(second.id, 'go');
    await finish(second.id);
    expect(agentMessages(second)[0]!.changes).toBeUndefined();
    const team = second.worktrees[TEAM_WORKTREE]![0]!;
    release();
    await finish(first.id);
    const next = calls.length;
    await orchestrator.send(second.id, 'more');
    await finish(second.id);
    expect(calls.slice(next).map((c) => c.cwd)).toEqual([project]);
    expect(existsSync(team.path)).toBe(false);
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
  it("gives a conversation writing a repository nested inside another conversation's a worktree of its own", async () => {
    const inner = join(project, 'lib');
    mkdirSync(inner);
    execFileSync('git', ['init', '-q'], { cwd: inner });
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    const outer = conversation({ mode: 'roundtable' }); // project: a repository of its own is created
    outer.agents = [agents[0]!];
    await orchestrator.send(outer.id, 'go');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    fake.gate = Promise.resolve();
    const nested = conversation({ mode: 'roundtable', cwd: inner });
    nested.agents = [agents[1]!];
    await orchestrator.send(nested.id, 'go');
    await finish(nested.id);
    const team = nested.worktrees[TEAM_WORKTREE]!;
    expect(team.map((w) => w.root)).toEqual([inner]);
    expect(calls[1]!.cwd).toBe(team[0]!.path);
    expect(existsSync(join(inner, 'Bob.txt'))).toBe(false);
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
