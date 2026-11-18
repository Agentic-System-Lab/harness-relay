/*
 * Team checks (`ConversationSettings.checks`): Harness Relay checking the team's work itself once the
 * team has answered — the card after the replies, who changed what, when there is none, the result in
 * the next turn's prompt, what waits in the queue while it fails, Check again, Skip and Fix, a result
 * gone stale, the lead review reading it, parallel mode, a run that stopped to ask, and a schedule's run.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Conversation } from '../src/shared/types';
import { RunCheck } from '../src/server/checks';
import { defaultCheckCommandDeps } from '../src/server/checkCommands';
import { calls, conversation, db, fake, finish, orchestrator, project, store, Store, textOf, withLang } from './orchestrator-harness';

const cards = (conv: Conversation) => conv.messages.filter((m) => m.checks);
const lastCard = (conv: Conversation) => cards(conv).at(-1)!;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: project, encoding: 'utf8' });
const promptOf = (name: string, nth = -1) => calls.filter((c) => c.name === name).at(nth)!.prompt;

/** A conversation whose team may not change `.env` (ignored by git), and must commit as `feat: …`. */
function checked(settings: Parameters<typeof conversation>[0] = {}): Conversation {
  writeFileSync(join(project, '.gitignore'), '.env\n');
  writeFileSync(join(project, '.env'), 'A=1\n');
  return conversation({
    mode: 'roundtable',
    permission: 'edit',
    checks: { protectedPaths: ['.env'], commitPattern: '^feat' },
    ...settings,
  });
}

describe('team checks', () => {
  it('checks the team’s work once it has answered, and puts each change down to the turn it happened in', async () => {
    const conv = checked();
    fake.during = (name) => {
      if (name === 'Bob') writeFileSync(join(project, '.env'), 'A=2\n');
      if (name === 'Alice') {
        git('add', 'Alice.txt');
        git('commit', '-q', '-m', 'Add Alice');
      }
    };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);

    const card = lastCard(conv);
    expect(conv.messages.at(-1)).toBe(card);
    expect(card.author.kind).toBe('system');
    const checks = card.checks!;
    expect(checks.status).toBe('failed');
    expect(checks.when).toBe('run');
    expect(checks.replyIds).toEqual(conv.messages.filter((m) => m.author.kind === 'agent').map((m) => m.id));
    expect(checks.outcomes).toEqual([
      { rule: 'paths', status: 'failed', findings: [{ path: '.env', change: 'changed', by: 'Bob' }] },
      { rule: 'commits', status: 'failed', findings: [expect.objectContaining({ subject: 'Add Alice', by: 'Alice' })] },
    ]);
    // Saved, with where the run started from (the server's only).
    const saved = new Store(db).get(conv.id)!;
    expect(saved.messages.at(-1)!.checks).toEqual(checks);
    expect(store.checksBaseline(conv.id, card.id)).toMatchObject({ patterns: ['.env'] });
  });

  it('tells the agents the rules in their briefing, and what failed in their next turn, once', async () => {
    const conv = checked();
    fake.during = (name) => name === 'Bob' && writeFileSync(join(project, '.env'), 'A=2\n');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const briefing = calls.find((c) => c.name === 'Alice')!.systemPrompt!;
    expect(briefing).toContain('Team checks: once the team has answered, Harness Relay checks');
    expect(briefing).toContain('matching these patterns (gitignore-like, in every working directory, ignored files too): .env');
    expect(briefing).toContain("Every commit's subject must match this regular expression: /^feat/");

    fake.during = undefined;
    await orchestrator.send(conv.id, 'again');
    await finish(conv.id);
    const prompt = promptOf('Alice');
    expect(prompt).toContain('<team_checks status="failed">');
    expect(prompt).toContain(".env: changed (in @Bob's turn)");
    expect(prompt).toContain('Fix it so that the whole result passes');
    // Nobody put the file back: that run's own result still fails, and replaces the first. The next
    // turns are shown the latest only, once.
    expect(cards(conv).map((m) => m.checks!.status)).toEqual(['failed', 'failed']);
    await orchestrator.send(conv.id, 'third');
    await finish(conv.id);
    const third = promptOf('Bob');
    expect(third.match(/<team_checks/g)).toHaveLength(1);
    expect(third).toContain(".env: changed (in @Bob's turn)");
  });

  it('posts nothing when the run cannot write, or the list is empty', async () => {
    const quiet = checked({ permission: 'read-only' });
    await orchestrator.send(quiet.id, 'go');
    await finish(quiet.id);
    expect(cards(quiet)).toEqual([]);
    const none = conversation({ mode: 'roundtable', permission: 'edit', checks: {} });
    await orchestrator.send(none.id, 'go');
    await finish(none.id);
    expect(cards(none)).toEqual([]);
  });

  it('passes a run that kept to the rules, with nothing to check where no commit was made', async () => {
    const conv = checked();
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(lastCard(conv).checks).toMatchObject({
      status: 'passed',
      outcomes: [
        { rule: 'paths', status: 'passed' },
        { rule: 'commits', status: 'na', reason: expect.any(String) },
      ],
    });
  });

  it('holds what the user wrote meanwhile while it fails: Send sends it, Skip lets it go', async () => {
    const conv = checked();
    let open!: () => void;
    // Written during the last turn: no turn of this run is left to take it.
    fake.gates.Bob = new Promise((r) => (open = r));
    fake.during = (name) => name === 'Bob' && writeFileSync(join(project, '.env'), 'A=2\n');
    await orchestrator.send(conv.id, 'go');
    await vi.waitFor(() => expect(calls.some((c) => c.name === 'Bob')).toBe(true));
    expect((await orchestrator.send(conv.id, 'and then this')).queued).toBe(true);
    open();
    await finish(conv.id);
    expect(lastCard(conv).checks!.status).toBe('failed');
    // It waits for the user.
    expect(conv.queue?.map(textOf)).toEqual(['and then this']);
    expect(orchestrator.isRunning(conv.id)).toBe(false);

    const skipped = orchestrator.skipChecks(conv.id, lastCard(conv).id);
    expect(skipped.checks!.skippedAt).toBeGreaterThan(0);
    expect(skipped.checks!.status).toBe('failed'); // not a pass
    await finish(conv.id);
    expect(conv.queue ?? []).toEqual([]);
    expect(conv.messages.some((m) => m.author.kind === 'user' && textOf(m) === 'and then this')).toBe(true);
    // Skipped, it is not the team's to fix any more.
    expect(promptOf('Alice')).not.toContain('<team_checks');
  });

  it('checks the latest result again from where its run started, and refuses another one', async () => {
    const conv = checked();
    fake.during = (name) => name === 'Bob' && writeFileSync(join(project, '.env'), 'A=2\n');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const failed = lastCard(conv);
    // The user puts the file back.
    writeFileSync(join(project, '.env'), 'A=1\n');
    const again = await orchestrator.recheckChecks(conv.id, failed.id);
    expect(again).toBe(lastCard(conv));
    expect(again.checks).toMatchObject({ status: 'passed', when: 'recheck', replyIds: failed.checks!.replyIds });
    await expect(orchestrator.recheckChecks(conv.id, failed.id)).rejects.toMatchObject({ status: 409 });
    await expect(orchestrator.recheckChecks(conv.id, 'nope')).rejects.toThrow();
    expect(() => orchestrator.skipChecks(conv.id, again.id)).toThrow();
  });

  it('asks one member to fix it: a message from the user, and a turn of its own that is shown the result', async () => {
    const conv = checked();
    fake.during = (name) => name === 'Bob' && writeFileSync(join(project, '.env'), 'A=2\n');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const card = lastCard(conv);
    fake.during = (name) => name === 'Bob' && writeFileSync(join(project, '.env'), 'A=1\n');
    calls.length = 0;
    await withLang('en', () => orchestrator.fixChecks(conv.id, card.id, 'b'));
    await finish(conv.id);
    expect(calls.map((c) => c.name)).toEqual(['Bob']);
    expect(calls[0]!.prompt).toContain('<team_checks status="failed">');
    const asked = conv.messages.filter((m) => m.author.kind === 'user').at(-1)!;
    expect(textOf(asked)).toBe('@Bob please fix what failed in the latest team checks (the whole result has to pass).');
    expect(card.checks!.fixBy).toBe('Bob');
    // Bob put it back: the run's own result passes.
    expect(lastCard(conv).checks!.status).toBe('passed');
    await expect(orchestrator.fixChecks(conv.id, lastCard(conv).id, 'b')).rejects.toThrow();
  });

  it('marks the latest result stale once a later turn changes the working directory', async () => {
    const conv = checked();
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const first = lastCard(conv);
    expect(first.checks!.stale).toBeUndefined();
    await orchestrator.send(conv.id, 'more');
    await finish(conv.id);
    expect(first.checks!.stale).toBe(true);
    expect(lastCard(conv).checks!.stale).toBeUndefined();
  });

  it('lets the lead review read how the checks went', async () => {
    const conv = checked({ leadReview: true });
    fake.during = (name) => name === 'Bob' && writeFileSync(join(project, '.env'), 'A=2\n');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const review = calls.find((c) => c.name === 'reviewer')!;
    expect(review.prompt).toContain('<team_checks status="failed">');
    expect(review.prompt).toContain('- protected paths: failed (.env changed by @Bob)');
    // The card comes before the review's.
    const at = (m?: ChatMessage) => conv.messages.indexOf(m!);
    expect(at(lastCard(conv))).toBeLessThan(at(conv.messages.find((m) => m.review)));
  });

  it('in parallel mode, finds a protected file in a member’s worktree and checks no commit format', async () => {
    const conv = checked({ mode: 'parallel', checks: { protectedPaths: ['Bob.txt'], commitPattern: '^feat' } });
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(lastCard(conv).checks!.outcomes).toEqual([
      { rule: 'paths', status: 'failed', findings: [{ path: 'Bob.txt', change: 'added', worktree: true, by: 'Bob' }] },
      { rule: 'commits', status: 'na', reason: expect.any(String) },
    ]);
  });

  it('checks what was done when the team stops to ask the user something', async () => {
    const conv = checked();
    fake.asking.add('Alice');
    fake.during = (name) => name === 'Alice' && writeFileSync(join(project, '.env'), 'A=2\n');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(conv.pause).toBeDefined();
    expect(lastCard(conv).checks).toMatchObject({ status: 'failed', when: 'pause' });
  });

  it('makes a failure in a run a schedule started, that nobody watched, the schedule’s failure', async () => {
    const conv = checked();
    conv.schedule = {
      text: 'nightly',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: Date.now(),
      nextRunAt: Date.now() + 3_600_000,
    };
    store.saveSchedule(conv);
    let open!: () => void;
    fake.gate = new Promise((r) => (open = r));
    fake.during = (name) => name === 'Bob' && writeFileSync(join(project, '.env'), 'A=2\n');
    await withLang('en', async () => {
      expect((await orchestrator.sendScheduled(conv.id)).result).toBe('sent');
      // As the scheduler records it once the message went.
      conv.schedule = { ...conv.schedule!, lastResult: 'sent', lastRunAt: Date.now() };
      open();
      await finish(conv.id);
    });
    expect(lastCard(conv).checks!.status).toBe('failed');
    expect(conv.schedule).toMatchObject({ lastResult: 'failed', lastError: 'The team checks did not pass' });
  });

  it('copies a template’s list into a conversation that has none, and never over one it has', async () => {
    const preset = {
      id: 'user-t',
      name: 'T',
      agents: conversation({}).agents,
      settings: { mode: 'roundtable' as const, rounds: 1, maxHops: 5, permission: 'edit' as const, checks: { protectedPaths: ['.env'] } },
    };
    store.savePreset(preset);
    const apply = (conv: Conversation) =>
      (orchestrator as unknown as { applyPlan: (c: Conversation, p: object) => void }).applyPlan(conv, {
        status: 'ready',
        source: 'template',
        presetId: 'user-t',
        agents: preset.agents,
        settings: { mode: 'roundtable', rounds: 1, maxHops: 5 },
      });
    const fresh = conversation({});
    apply(fresh);
    expect(fresh.settings.checks).toEqual({ protectedPaths: ['.env'] });
    const own = conversation({ checks: {} });
    apply(own);
    expect(own.settings.checks).toEqual({});
  });
});

describe('team checks: commands', () => {
  const commandOf = (conv: Conversation, id = 'c') =>
    lastCard(conv).checks!.outcomes.find((o) => o.rule === 'command' && o.commandId === id)!;
  const commanded = (run: string, settings: Parameters<typeof conversation>[0] = {}) =>
    conversation({ mode: 'roundtable', permission: 'full', checks: { commands: [{ id: 'c', run }] }, ...settings });
  /**
   * Stands in for the shell a command runs in, which says it started (`entered`), waits for `gate` (or
   * Stop) and exits 0; as on Linux, so that it runs on every system the tests do (commands are not run
   * on Windows).
   */
  const gated = (gate: Promise<void>, entered?: () => void) =>
    ({
      ...defaultCheckCommandDeps,
      platform: 'linux',
      runShellScript: async (_sh: string, _flags: readonly string[], _script: string, o: { signal?: AbortSignal }) => {
        entered?.();
        if (!o.signal?.aborted) await Promise.race([gate, new Promise((r) => o.signal?.addEventListener('abort', r, { once: true }))]);
        const aborted = Boolean(o.signal?.aborted);
        return {
          code: aborted ? null : 0,
          signal: null,
          stdout: '',
          stdoutBytes: Buffer.alloc(0),
          stdoutTruncated: false,
          stdoutSize: 0,
          stderr: '',
          aborted,
          timedOut: false,
        };
      },
    }) as typeof defaultCheckCommandDeps;

  it.skipIf(process.platform === 'win32')(
    'runs them once the team has finished, and shows the next turn the end of what a failing one printed',
    async () => {
      const conv = commanded('if [ -e Bob.txt ]; then echo "Bob.txt should not be here"; exit 1; fi');
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      expect(lastCard(conv).checks!.status).toBe('failed');
      expect(commandOf(conv)).toMatchObject({ status: 'failed', exitCode: 1, unsandboxed: true, output: 'Bob.txt should not be here' });
      const briefing = calls.find((c) => c.name === 'Alice')!.systemPrompt!;
      expect(briefing).toContain('These commands must succeed');
      await orchestrator.send(conv.id, 'fix it');
      await finish(conv.id);
      const prompt = promptOf('Alice');
      expect(prompt).toContain('- Command `if [ -e Bob.txt ]');
      expect(prompt).toContain('<command_output>\nBob.txt should not be here\n</command_output>');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'passes one that succeeds, and says what it changed in the working directory itself',
    async () => {
      const conv = commanded('echo snapshot > __snapshot.txt');
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      expect(commandOf(conv)).toMatchObject({ status: 'passed', exitCode: 0, wroteFiles: ['__snapshot.txt'] });
    },
  );

  it('below full access, runs them in Harness Relay’s sandbox, with no network', async () => {
    const conv = commanded('npm test', { permission: 'edit' });
    const specs: { permission: string; allowedHosts: string[]; cwd: string }[] = [];
    orchestrator.checkCommandDeps = {
      ...defaultCheckCommandDeps,
      platform: 'linux',
      makeRunDirs: () => ({ tmp: join(project, '.run-tmp'), hostTmp: join(project, '.run-host') }),
      sandboxCommand: (async (_bin: string, _args: string[], env: NodeJS.ProcessEnv, spec: (typeof specs)[number]) => {
        specs.push(spec);
        return { bin: 'host', args: [], env, channel: {}, failure: () => undefined, dispose: async () => undefined, run: {} };
      }) as never,
      runProcess: (async () => ({
        code: 0,
        signal: null,
        stdout: 'ok',
        stdoutBytes: Buffer.alloc(0),
        stdoutTruncated: false,
        stdoutSize: 2,
        stderr: '',
        aborted: false,
        timedOut: false,
      })) as never,
    };
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(commandOf(conv)).toMatchObject({ status: 'passed', output: 'ok' });
    expect(commandOf(conv).unsandboxed).toBeUndefined();
    expect(specs).toEqual([expect.objectContaining({ permission: 'edit', allowedHosts: [], cwd: project })]);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps them from running when the run changed what they read, until the user confirms; in a run nobody watched, that fails',
    async () => {
      const conv = commanded('true');
      fake.during = (name) => name === 'Alice' && writeFileSync(join(project, 'vitest.config.ts'), 'export default {};\n');
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      expect(commandOf(conv)).toMatchObject({ status: 'error', configChanged: ['vitest.config.ts'] });
      expect(commandOf(conv).exitCode).toBeUndefined();
      // Checked again without confirming: still kept from running.
      await orchestrator.recheckChecks(conv.id, lastCard(conv).id);
      await vi.waitFor(() => expect(commandOf(conv).status).toBe('error'));
      expect(commandOf(conv).configChanged).toEqual(['vitest.config.ts']);
      // Confirmed: it runs.
      await orchestrator.recheckChecks(conv.id, lastCard(conv).id, { confirm: true });
      await vi.waitFor(() => expect(commandOf(conv).status).toBe('passed'));
      await finish(conv.id);
    },
  );

  it.skipIf(process.platform === 'win32')('counts package.json only when its scripts or test settings changed', async () => {
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' }, dependencies: {} }));
    const conv = commanded('true');
    fake.during = (name) =>
      name === 'Alice' &&
      writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { a: '1' } }));
    await orchestrator.send(conv.id, 'deps');
    await finish(conv.id);
    expect(commandOf(conv).status).toBe('passed');
    fake.during = (name) => name === 'Alice' && writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    await orchestrator.send(conv.id, 'scripts');
    await finish(conv.id);
    expect(commandOf(conv)).toMatchObject({ status: 'error', configChanged: ['package.json'] });
  });

  it('runs none when the team stopped to ask, nor in parallel mode', async () => {
    const asked = commanded('true');
    fake.asking.add('Alice');
    await orchestrator.send(asked.id, 'go');
    await finish(asked.id);
    expect(commandOf(asked)).toMatchObject({ status: 'na', reason: expect.any(String) });
    fake.asking.clear();
    const parallel = commanded('true', { mode: 'parallel', permission: 'edit' });
    await orchestrator.send(parallel.id, 'go');
    await finish(parallel.id);
    expect(commandOf(parallel)).toMatchObject({ status: 'na' });
  });

  it('Check again runs them in the background: the chat is busy meanwhile, a message waits, and Stop stops them', async () => {
    const conv = commanded('true');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    let open!: () => void;
    orchestrator.checkCommandDeps = gated(new Promise((r) => (open = r)));
    const again = await orchestrator.recheckChecks(conv.id, lastCard(conv).id);
    expect(again.checks!.status).toBe('running');
    expect(orchestrator.isRunning(conv.id)).toBe(true);
    expect((await orchestrator.send(conv.id, 'meanwhile')).queued).toBe(true);
    orchestrator.stop(conv.id);
    await finish(conv.id);
    expect(commandOf(conv)).toMatchObject({ status: 'error', reason: expect.any(String) });
    // Stopped: what waits stays, as after a run's Stop.
    expect(conv.queue?.map(textOf)).toEqual(['meanwhile']);
    open();
  });

  it('tries a command on the working directory as it is, posting nothing', async () => {
    const conv = commanded('true');
    orchestrator.checkCommandDeps = gated(Promise.resolve());
    const outcome = await orchestrator.tryCheckCommand(conv.id, { id: 'x', run: 'npm test' });
    expect(outcome).toMatchObject({ rule: 'command', status: 'passed', commandId: 'x' });
    expect(cards(conv)).toEqual([]);
    expect(orchestrator.isRunning(conv.id)).toBe(false);
  });

  it('Stop while a command runs: it could not run, never failed, and nothing is held for it', async () => {
    const conv = commanded('npm test');
    let started!: () => void;
    const entered = new Promise<void>((r) => (started = r));
    orchestrator.checkCommandDeps = gated(new Promise(() => undefined), started);
    await withLang('en', async () => {
      await orchestrator.send(conv.id, 'go');
      await entered;
      orchestrator.stop(conv.id);
      await finish(conv.id);
    });
    expect(commandOf(conv)).toMatchObject({ status: 'error', reason: 'Stopped.' });
    expect(lastCard(conv).checks!.status).toBe('error');
    expect(lastCard(conv).checks!.outcomes.some((o) => o.status === 'running')).toBe(false);
  });

  it('a message sent while Try it runs goes once it is done', async () => {
    const conv = commanded('true');
    await orchestrator.send(conv.id, 'first');
    await finish(conv.id);
    let open!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => (started = r));
    orchestrator.checkCommandDeps = gated(new Promise((r) => (open = r)), started);
    const trying = orchestrator.tryCheckCommand(conv.id, { id: 'x', run: 'npm test' });
    await entered;
    expect((await orchestrator.send(conv.id, 'meanwhile')).queued).toBe(true);
    open();
    expect((await trying).status).toBe('passed');
    await vi.waitFor(() => expect(conv.messages.some((m) => m.author.kind === 'user' && textOf(m) === 'meanwhile')).toBe(true));
    await finish(conv.id);
    expect(conv.queue ?? []).toEqual([]);
  });

  it('refuses Try it with read-only permission, as the drawer shows it or as saved', async () => {
    const conv = commanded('true', { permission: 'read-only' });
    await expect(orchestrator.tryCheckCommand(conv.id, { id: 'x', run: 'true' })).rejects.toMatchObject({ status: 409 });
    const full = commanded('true');
    await expect(orchestrator.tryCheckCommand(full.id, { id: 'x', run: 'true' }, 'read-only')).rejects.toMatchObject({ status: 409 });
  });

  it('deleting the chat stops a command Check again runs, rather than waiting for it', async () => {
    const conv = commanded('true');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    let started!: () => void;
    const entered = new Promise<void>((r) => (started = r));
    orchestrator.checkCommandDeps = gated(new Promise(() => undefined), started);
    await orchestrator.recheckChecks(conv.id, lastCard(conv).id);
    await entered;
    const deleted = orchestrator.deleteConversation(conv.id);
    await expect(Promise.race([deleted.then(() => 'deleted'), new Promise((r) => setTimeout(() => r('waiting'), 5000))])).resolves.toBe(
      'deleted',
    );
  });

  it('Check again runs no command in parallel mode or with read-only permission, as after a run', async () => {
    for (const settings of [{ mode: 'parallel' as const, permission: 'edit' as const }, { permission: 'read-only' as const }]) {
      const conv = commanded('true', { permission: 'edit' });
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      conv.settings = { ...conv.settings, ...settings };
      let ran = false;
      orchestrator.checkCommandDeps = gated(Promise.resolve(), () => (ran = true));
      const again = await orchestrator.recheckChecks(conv.id, lastCard(conv).id);
      expect(again.checks!.outcomes.find((o) => o.rule === 'command')).toMatchObject({ status: 'na', reason: expect.any(String) });
      expect(ran).toBe(false);
      expect(orchestrator.isRunning(conv.id)).toBe(false);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the commands held back in later runs until the user confirms, and tells agents nothing to fix for it',
    async () => {
      const conv = commanded('true');
      fake.during = (name) => name === 'Alice' && writeFileSync(join(project, 'vitest.config.ts'), 'export default {};\n');
      await orchestrator.send(conv.id, 'change the config');
      await finish(conv.id);
      expect(commandOf(conv).configChanged).toEqual(['vitest.config.ts']);
      // The next run touches only its own files: the settings are still unconfirmed, so it still waits.
      fake.during = undefined;
      await orchestrator.send(conv.id, 'something else');
      await finish(conv.id);
      expect(commandOf(conv)).toMatchObject({ status: 'error', configChanged: ['vitest.config.ts'] });
      // What only waits for the user's confirmation is nothing for the agents to fix.
      expect(promptOf('Alice')).not.toContain('<team_checks');
      await orchestrator.recheckChecks(conv.id, lastCard(conv).id, { confirm: true });
      await vi.waitFor(() => expect(commandOf(conv).status).toBe('passed'));
      await finish(conv.id);
      fake.during = undefined;
      await orchestrator.send(conv.id, 'after confirming');
      await finish(conv.id);
      expect(commandOf(conv).status).toBe('passed');
    },
  );

  it.skipIf(process.platform === 'win32')('holds back a command whose script changed, found from the folder it runs in', async () => {
    const conv = conversation({
      mode: 'roundtable',
      permission: 'full',
      checks: { commands: [{ id: 'c', run: 'sh ./check.sh', cwd: 'app' }] },
    });
    execFileSync('mkdir', ['-p', join(project, 'app')]);
    writeFileSync(join(project, 'app', 'check.sh'), 'exit 0\n');
    fake.during = (name) => name === 'Bob' && writeFileSync(join(project, 'app', 'check.sh'), 'exit 0 # weaker\n');
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    expect(commandOf(conv)).toMatchObject({ status: 'error', configChanged: ['app/check.sh'] });
  });

  it('lists each command once when the paths could not be checked', async () => {
    const conv = conversation({
      mode: 'roundtable',
      permission: 'full',
      checks: { protectedPaths: ['.env'], commands: [{ id: 'c', run: 'true' }] },
    });
    orchestrator.checkCommandDeps = gated(Promise.resolve());
    const broken = vi.spyOn(RunCheck.prototype, 'finish').mockRejectedValueOnce(new Error('git broke'));
    try {
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
    } finally {
      broken.mockRestore();
    }
    const outcomes = lastCard(conv).checks!.outcomes;
    expect(outcomes.filter((o) => o.rule === 'command')).toHaveLength(1);
    expect(outcomes.find((o) => o.rule === 'paths')).toMatchObject({ status: 'error', reason: 'git broke' });
  });
});
