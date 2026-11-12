import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '../src/shared/types';

/*
 * A network ask the relay sandbox queued behind a pending one must not be put to the user once the
 * turn has ended (Specula B2/C2): it would leave a card that never expires, and allowing it would take
 * a finished read-only run's directory lock. The orchestrator, the store and RelaySandboxRun are real;
 * the runner plays the sandbox host's side of the channel (two asks, as two connections send them) and
 * ends the turn the way acpTurn does (dispose, then return).
 */
// In /tmp: the data folder's path must leave room for the sandbox's sockets (macOS's own temp folder is too deep).
const root = realpathSync(mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'relay-queued-ask-')));
process.env.RELAY_DATA_DIR = join(root, 'data');

const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { Orchestrator } = await import('../src/server/orchestrator');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { runners } = await import('../src/server/agents');
const { DENY_REASONS, RelaySandboxRun, makeRunDirs } = await import('../src/server/relaySandbox');

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A run on a fake channel: what the host would send, and what it gets back. */
function runOnChannel(requestApproval: ConstructorParameters<typeof RelaySandboxRun>[2]['requestApproval']) {
  const run = new RelaySandboxRun(makeRunDirs(join(root, 'data')), {}, {
    requestApproval,
    localAddresses: [],
    platform: 'linux',
    arch: 'x64',
  });
  const back: Record<string, any>[] = [];
  const channel = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) back.push(JSON.parse(line));
      done();
    },
  });
  run.attach(channel, {} as never);
  const ask = (id: number, host: string) => channel.push(`${JSON.stringify({ t: 'ask', id, host, port: 443 })}\n`);
  return { run, back, ask };
}

// Harness Relay's own sandbox runs on macOS and Linux only (on native Windows the open agents run only with full access).
describe.skipIf(process.platform === 'win32')('a network ask queued when the turn ends', () => {
  it('is refused without asking the user', async () => {
    const asked: string[] = [];
    let answerFirst: (a: { allow: boolean }) => void = () => undefined;
    const { run, back, ask } = runOnChannel(
      (req) =>
        new Promise((resolve) => {
          asked.push(req.detail!);
          answerFirst = resolve;
        }),
    );
    ask(1, 'registry.npmjs.org');
    ask(2, 'github.com');
    await vi.waitFor(() => expect(asked).toEqual(['registry.npmjs.org']));
    // The turn ends while the first card is up; the orchestrator then expires that card.
    await run.dispose();
    answerFirst({ allow: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual(['registry.npmjs.org']); // github.com was never put to the user
    // Its answer is a refusal (the same promise the queued ask is waiting on; the channel is closed by then).
    await expect(run.decide('github.com', 443)).resolves.toEqual({ allow: false, reason: DENY_REASONS.refused('github.com') });
    expect(back.filter((m) => m.t === 'answer' && m.id === 2 && m.allow === true)).toEqual([]);
  });

  it('leaves no pending card and no directory lock after the run (with the orchestrator)', async () => {
    const db = openDatabase(':memory:');
    const store = new Store(db);
    const settings = new SettingsStore(db);
    const orchestrator = new Orchestrator(store, new Hub(), settings, {
      context: async () => ({ available: ['claude'], catalog: [], presets: store.listPresets() }),
    });
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'a.txt'), 'a\n');

    runners.claude = {
      provider: 'claude',
      async run(o) {
        const { run, ask } = runOnChannel(o.requestApproval);
        // Two connections of a sandboxed command to two hosts no rule decides.
        ask(1, 'registry.npmjs.org');
        ask(2, 'github.com');
        await new Promise((r) => setTimeout(r, 100)); // the first card is up; nobody has answered
        // The CLI's turn ends meanwhile: acpTurn's finally disposes the sandbox run, then it returns.
        await run.dispose();
        o.onEvent({ type: 'text', text: 'done without the network' });
        o.onEvent({ type: 'text_end' });
        return { sessionId: 'session-1' };
      },
    };

    const conv: Conversation = {
      id: 'conv-readonly',
      title: 'read-only chat',
      createdAt: 0,
      updatedAt: 0,
      agents: [{ id: 'a', name: 'Alice', provider: 'claude', role: '' }],
      settings: { mode: 'roundtable', rounds: 1, maxHops: 5, permission: 'read-only', cwd: project },
      messages: [],
      agentState: {},
      worktrees: {},
    };
    store.create(conv);
    await orchestrator.send(conv.id, 'look something up');
    await vi.waitFor(() => expect(orchestrator.isRunning(conv.id)).toBe(false), { timeout: 10_000, interval: 20 });
    await new Promise((r) => setTimeout(r, 100));

    const reply = store.get(conv.id)!.messages.find((m) => m.author.kind === 'agent')!;
    const cards = reply.parts.filter((p) => p.type === 'approval') as Extract<(typeof reply.parts)[number], { type: 'approval' }>[];
    expect(reply.status).toBe('done');
    expect(cards.map((c) => c.detail)).toEqual(['registry.npmjs.org']); // github.com never became a card
    expect(cards.some((c) => c.status === 'pending')).toBe(false);
    expect(orchestrator.isWaiting(conv.id)).toBe(false);

    // Another conversation can work in that folder: no lock was left behind.
    const other: Conversation = { ...conv, id: 'conv-edit', title: 'edit chat', settings: { ...conv.settings, permission: 'edit' }, messages: [], agentState: {}, worktrees: {} };
    store.create(other);
    await expect(orchestrator.send(other.id, 'change a.txt')).resolves.not.toThrow();
    await vi.waitFor(() => expect(orchestrator.isRunning(other.id)).toBe(false), { timeout: 10_000, interval: 20 });
  });
});
