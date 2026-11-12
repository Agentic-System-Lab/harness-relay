/*
 * A conversation that works in several folders: a repository and worktrees for each, the changes
 * recorded in each, and the lock on each.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../src/shared/types';
import { agentMessages, agents, calls, conversation, db, fake, finish, n, orchestrator, project, root, store, Store, textOf } from './orchestrator-harness';

describe('several working directories', () => {
  /** A second working directory with a file of its own; the first is `project`. */
  function docsFolder(): string {
    const docs = join(root, `docs-${n}`);
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'guide.md'), 'guide\n');
    return docs;
  }

  it('gives every agent all of them, makes each a repository and records the changes in each', async () => {
    const docs = docsFolder();
    const conv = conversation({ mode: 'roundtable', extraCwds: [docs] });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    // Both became git repositories.
    const notes = conv.messages.filter((m) => m.author.kind === 'system').map(textOf);
    expect(notes.filter((t) => t.includes('git init'))).toHaveLength(2);
    expect(existsSync(join(docs, '.git'))).toBe(true);
    const turns = calls.filter((c) => c.name === 'Alice' || c.name === 'Bob');
    expect(turns.map((c) => [c.cwd, c.addDirs])).toEqual([
      [project, [docs]],
      [project, [docs]],
    ]);
    expect(turns[0]!.systemPrompt).toContain(`share these working directories, each with the same access: ${project}, ${docs}.`);

    const [alice] = agentMessages(conv);
    expect(alice!.changes!.map((c) => [c.root, c.isolated, c.files.map((f) => f.path).sort()])).toEqual([
      [project, false, ['Alice.txt', 'shared.txt']],
      [docs, false, ['Alice.txt']],
    ]);
    // One diff, each repository's paths under its folder's name.
    const diff = await orchestrator.messageDiff(conv.id, alice!.id);
    expect(diff).toContain(`+++ b/${basename(project)}/Alice.txt`);
    expect(diff).toContain(`+++ b/${basename(docs)}/Alice.txt`);
    // The second repository keeps the turns' snapshots too, until the conversation goes.
    const refs = () => execFileSync('git', ['-C', docs, 'for-each-ref', `refs/harness-relay/${conv.id}/`], { encoding: 'utf8' });
    expect(refs()).not.toBe('');
    await orchestrator.cleanupWorktrees(conv);
    expect(refs()).toBe('');
  });

  it('makes one repository for a folder and one inside it, whichever comes first', async () => {
    for (const mode of ['roundtable', 'parallel'] as const) {
      const outer = join(root, `outer-${mode}-${n}`);
      const inner = join(outer, 'docs');
      mkdirSync(inner, { recursive: true });
      const conv = conversation({ mode, cwd: inner, extraCwds: [outer] });
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      // Only the outer one was made a repository: git could not snapshot it around an empty inner one.
      expect(existsSync(join(inner, '.git'))).toBe(false);
      const alice = agentMessages(conv).find((m) => m.agentName === 'Alice')!;
      expect(alice.status).toBe('done');
      expect(alice.changes!.map((c) => c.root)).toEqual([outer]);
      expect(alice.changes![0]!.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'docs/Alice.txt', 'docs/shared.txt']);
      if (mode === 'parallel') {
        // One worktree, in which the agent starts in the inner folder and also has the outer one.
        const [wt] = conv.worktrees.a!;
        expect(conv.worktrees.a).toHaveLength(1);
        expect(calls.filter((c) => c.name === 'Alice').at(-1)).toMatchObject({ cwd: join(wt!.path, 'docs'), addDirs: [wt!.path] });
      }
      await orchestrator.cleanupWorktrees(conv);
    }
  });

  it('takes the lock on all of them for an action allowed in a read-only run, and declines it while another conversation writes in one', async () => {
    const docs = docsFolder();
    const pendingIn = (conv: Conversation) =>
      conv.messages.flatMap((m) => m.parts).find((p) => p.type === 'approval' && p.status === 'pending') as { id: string } | undefined;
    const writer = conversation({ mode: 'roundtable', cwd: docs });
    writer.agents = [agents[0]!];
    await orchestrator.send(writer.id, 'please install'); // waits for its approval, holding the lock on docs
    await vi.waitFor(() => expect(pendingIn(writer)).toBeDefined());
    const reader = conversation({ mode: 'roundtable', permission: 'read-only', extraCwds: [docs] });
    reader.agents = [agents[0]!];
    await orchestrator.send(reader.id, 'please install');
    await vi.waitFor(() => expect(pendingIn(reader)).toBeDefined());
    orchestrator.answerApproval(reader.id, pendingIn(reader)!.id, { allow: true });
    await finish(reader.id);
    expect(agentMessages(reader)[0]!.parts.find((p) => p.type === 'approval')).toMatchObject({ status: 'denied' });
    orchestrator.answerApproval(writer.id, pendingIn(writer)!.id, { allow: true });
    await finish(writer.id);
  });

  it("tells a schedule that another conversation writes in one of them, before setting up its run", async () => {
    const docs = docsFolder();
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    const writer = conversation({ mode: 'roundtable', cwd: docs });
    await orchestrator.send(writer.id, 'go');
    const conv = conversation({ mode: 'roundtable', extraCwds: [docs] });
    conv.schedule = {
      text: 'scheduled check',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: 0,
      nextRunAt: 1,
    };
    store.saveSchedule(conv);
    expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'busy', reason: expect.stringContaining(docs) });
    expect(conv.messages).toEqual([]);
    release();
    await finish(writer.id);
  });

  it("records the others' changes when one repository cannot be snapshotted", async () => {
    const docs = docsFolder();
    execFileSync('git', ['init', '-q'], { cwd: docs });
    // A repository inside it without a commit: git cannot snapshot docs around it.
    mkdirSync(join(docs, 'sub'));
    execFileSync('git', ['init', '-q'], { cwd: join(docs, 'sub') });
    const conv = conversation({ mode: 'roundtable', extraCwds: [docs] });
    conv.agents = [agents[0]!];
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const [alice] = agentMessages(conv);
    expect(alice!.status).toBe('done');
    expect(alice!.changes!.map((c) => c.root)).toEqual([project]);
    expect(alice!.changes![0]!.files.map((f) => f.path).sort()).toEqual(['Alice.txt', 'shared.txt']);
    await orchestrator.cleanupWorktrees(conv);
  });

  // chmod cannot keep a program from writing in a folder on Windows.
  it.skipIf(process.platform === 'win32')('marks the worktrees for a reset when a patch fails after another was applied', async () => {
    const docs = docsFolder();
    const conv = conversation({ mode: 'parallel', extraCwds: [docs] });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    // The check passes (nothing in the way), but nothing can be written in docs: its patch fails.
    chmodSync(docs, 0o555);
    try {
      await expect(orchestrator.applyAgentWork(conv.id, 'b')).rejects.toThrow();
    } finally {
      chmodSync(docs, 0o755);
    }
    // The first folder's patch was applied: the worktrees start again from the folders as they are.
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    expect(Object.values(conv.worktrees).flat().every((w) => w.needsReset)).toBe(true);
    await orchestrator.cleanupWorktrees(conv);
  });

  it("neither applies nor shows a worktree of a folder taken off the list, even once that folder is gone", async () => {
    const docs = docsFolder();
    const conv = conversation({ mode: 'parallel', extraCwds: [docs] });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    conv.settings = { ...conv.settings, extraCwds: undefined };
    rmSync(docs, { recursive: true, force: true });
    const diff = await orchestrator.agentDiff(conv.id, 'b');
    expect(diff).toContain('+++ b/Bob.txt');
    expect(diff).not.toContain(basename(docs));
    const files = await orchestrator.applyAgentWork(conv.id, 'b');
    expect(files.map((f) => f.path).sort()).toEqual(['Bob.txt', 'shared.txt']);
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    await orchestrator.cleanupWorktrees(conv);
  });

  it('keeps another conversation from writing in any of them meanwhile', async () => {
    const docs = docsFolder();
    let release!: () => void;
    fake.gate = new Promise((r) => (release = r));
    const first = conversation({ mode: 'roundtable', extraCwds: [docs] });
    const second = conversation({ mode: 'relay', cwd: docs });
    await orchestrator.send(first.id, 'go');
    await expect(orchestrator.send(second.id, 'go')).rejects.toThrow(/正在修改/);
    release();
    await finish(first.id);
    await orchestrator.send(second.id, 'go');
    await finish(second.id);
  });

  it('in parallel mode, gives each agent a worktree of each, and applies all of a result or none of it', async () => {
    const docs = docsFolder();
    const conv = conversation({ mode: 'parallel', extraCwds: [docs] });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    for (const a of agents) {
      const wts = conv.worktrees[a.id]!;
      expect(wts.map((w) => w.root)).toEqual([project, docs]);
      const call = calls.find((c) => c.name === a.name)!;
      expect([call.cwd, call.addDirs]).toEqual([wts[0]!.path, [wts[1]!.path]]);
      expect(readFileSync(join(wts[1]!.path, `${a.name}.txt`), 'utf8')).toBe(`${a.name} was here\n`);
    }
    // The real folders are untouched.
    expect(existsSync(join(docs, 'Bob.txt'))).toBe(false);
    const bob = agentMessages(conv).find((m) => m.agentName === 'Bob')!;
    expect(bob.changes!.map((c) => [c.root, c.isolated])).toEqual([
      [project, true],
      [docs, true],
    ]);
    expect(await orchestrator.agentDiff(conv.id, 'b')).toContain(`+++ b/${basename(docs)}/Bob.txt`);

    // A file in the way in one of them: nothing is applied anywhere.
    writeFileSync(join(docs, 'Bob.txt'), 'in the way\n');
    await expect(orchestrator.applyAgentWork(conv.id, 'b')).rejects.toThrow();
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('original\n');
    rmSync(join(docs, 'Bob.txt'));

    const files = await orchestrator.applyAgentWork(conv.id, 'b');
    expect(files.map((f) => f.path).sort()).toEqual(['Bob.txt', 'Bob.txt', 'shared.txt']);
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('written by Bob\n');
    expect(readFileSync(join(docs, 'Bob.txt'), 'utf8')).toBe('Bob was here\n');
    expect(Object.values(conv.worktrees).flat().every((w) => w.needsReset)).toBe(true);
    await orchestrator.cleanupWorktrees(conv);
    expect(Object.values(conv.worktrees).flat().some((w) => existsSync(w.path))).toBe(false);
  });

  it('removes the worktrees of a folder the conversation no longer works in', async () => {
    const docs = docsFolder();
    const conv = conversation({ mode: 'parallel', extraCwds: [docs] });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const gone = conv.worktrees.a!.find((w) => w.root === docs)!;
    expect(existsSync(gone.path)).toBe(true);

    conv.settings = { ...conv.settings, extraCwds: undefined };
    store.saveMeta(conv);
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    expect(conv.worktrees.a!.map((w) => w.root)).toEqual([project]);
    expect(existsSync(gone.path)).toBe(false);
    expect(new Store(db).get(conv.id)!.worktrees.a!.map((w) => w.root)).toEqual([project]);
    await orchestrator.cleanupWorktrees(conv);
  });
});
