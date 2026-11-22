/*
 * Secrets and fixed commands in team runs (docs/architecture.md, "Secrets and fixed commands"): a
 * reply's blocks taken out into cards that wait for the user, the answer the team gets (names, never a
 * value), a proposed command saved, pinned, tried and shared, its code changing, and one run of it put
 * in the outbox and sent. The fixed commands' sandbox and process are stand-ins
 * (`orchestrator.fixedCommandDeps`); the folder is a real git repository.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePart } from '../src/shared/types';
import { HandoffStore } from '../src/server/handoffs';
import type { FixedCommandDeps } from '../src/server/fixedCommands';
import type { SecretStore } from '../src/server/secrets';
import type { SpawnResult } from '../src/server/process';
import { FIXED_COMMAND_TOOL } from '../src/server/orchestrator';
import { Outbox } from '../src/server/outbox';
import {
  agentMessages,
  calls,
  conversation,
  db,
  fake,
  finish,
  orchestrator,
  project,
  root,
  settings,
  store,
  textOf,
} from './orchestrator-harness';

const keys = new Map<string, string>();
let ran: { env: NodeJS.ProcessEnv; stdin?: string }[] = [];
let play: (env: NodeJS.ProcessEnv, stdin?: string) => Partial<SpawnResult> = () => ({ code: 0 });

beforeEach(() => {
  keys.clear();
  ran = [];
  play = () => ({ code: 0 });
  const keyring: SecretStore = {
    storage: 'keychain',
    get: (k) => keys.get(k) ?? null,
    set: (k, v) => void keys.set(k, v),
    delete: (k) => void keys.delete(k),
  };
  // The harness's settings have no credential store: this one has a stand-in.
  Object.assign(settings, { handoffs: new HandoffStore(db, keyring) });
  let runs = 0;
  const deps: FixedCommandDeps = {
    platform: 'darwin',
    env: { PATH: process.env.PATH ?? '' },
    sandboxAvailable: async () => ({ ok: true }),
    makeRunDirs: () => {
      const tmp = join(root, `fixed-run-${Date.now()}-${++runs}`, 'tmp');
      mkdirSync(tmp, { recursive: true });
      return { tmp, hostTmp: join(tmp, '..', 'host') };
    },
    sandboxCommand: (async (_bin: string, _args: string[], env: NodeJS.ProcessEnv) => ({
      bin: 'host',
      args: [],
      env,
      channel: {} as never,
      failure: () => undefined,
      dispose: async () => undefined,
      run: { refusedHosts: [] } as never,
    })) as never,
    runProcess: (async (p: { env?: NodeJS.ProcessEnv; stdin?: string }) => {
      ran.push({ env: p.env ?? {}, ...(p.stdin !== undefined ? { stdin: p.stdin } : {}) });
      return {
        code: 0,
        signal: null,
        stdout: '',
        stdoutBytes: Buffer.alloc(0),
        stdoutTruncated: false,
        stdoutSize: 0,
        stderr: '',
        aborted: false,
        timedOut: false,
        ...play(p.env ?? {}, p.stdin),
      };
    }) as never,
  };
  orchestrator.fixedCommandDeps = deps;
  orchestrator.outbox = new Outbox(db);
});

const partOf = <K extends MessagePart['type']>(convId: string, type: K) => {
  const msg = agentMessages(store.get(convId)!).find((m) => m.parts.some((p) => p.type === type))!;
  return { msg, part: msg.parts.find((p): p is Extract<MessagePart, { type: K }> => p.type === type)! };
};

const userTexts = (convId: string) =>
  store
    .get(convId)!
    .messages.filter((m) => m.author.kind === 'user')
    .map(textOf);

describe('secrets cards', () => {
  it("takes a reply's secret blocks into a card that waits, and tells every member how to ask", async () => {
    const conv = conversation({ mode: 'relay' });
    fake.reply = (name) =>
      name === 'Alice'
        ? 'To post I need your token.\n\n<secret name="THREADS_ACCESS_TOKEN" label="Threads token">From the User Token Generator.</secret>'
        : undefined;
    await orchestrator.send(conv.id, 'Set up posting');
    await finish(conv.id);
    const { msg, part } = partOf(conv.id, 'secrets');
    expect(textOf(msg)).toBe('To post I need your token.');
    expect(msg.asked).toBe(true);
    expect(part).toMatchObject({
      folder: orchestrator.handoffFolder(conv),
      asks: [{ name: 'THREADS_ACCESS_TOKEN', label: 'Threads token', reason: 'From the User Token Generator.', status: 'waiting' }],
    });
    // The team waits for the user: Bob did not answer after Alice.
    expect(calls.map((c) => c.name)).toEqual(['Alice']);
    expect(calls[0]!.systemPrompt).toContain('# Secrets and fixed commands');
    expect(calls[0]!.systemPrompt).toContain('$RELAY_SECRETS_FILE');
  });

  it('keeps the values given in the credential store, and answers the team with their names only', async () => {
    const conv = conversation({ mode: 'relay' });
    fake.reply = (name) =>
      name === 'Alice' && !calls.some((c) => c.name === 'Alice' && c.prompt.includes('gave'))
        ? '<secret name="TOKEN">needed</secret>\n<secret name="APP_SECRET">for the exchange</secret>'
        : 'Thanks.';
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const { msg, part } = partOf(conv.id, 'secrets');
    await orchestrator.answerSecrets(conv.id, msg.id, part.id, { values: { TOKEN: ' tok-123456 ', NOT_ASKED: 'x' } });
    await finish(conv.id);
    const folder = orchestrator.handoffFolder(conv);
    expect(settings.handoffs.values(folder)).toEqual({ TOKEN: 'tok-123456' });
    const card = partOf(conv.id, 'secrets').part;
    expect(card.asks.map((a) => a.status)).toEqual(['saved', 'declined']);
    const answer = userTexts(conv.id).at(-1)!;
    expect(answer).toContain('TOKEN');
    expect(answer).toContain('APP_SECRET');
    expect(answer).not.toContain('tok-123456');
    // The value is in no prompt, no briefing and no message; the names are in the next briefing.
    const later = calls.at(-1)!;
    expect(later.prompt + later.systemPrompt).not.toContain('tok-123456');
    expect(later.systemPrompt).toContain('Secrets kept for this working directory (their values are never shown to you): TOKEN.');
    expect(JSON.stringify(store.get(conv.id))).not.toContain('tok-123456');
    await expect(orchestrator.answerSecrets(conv.id, msg.id, part.id, { decline: true })).rejects.toMatchObject({ status: 409 });
  });

  it('declines them all, and refuses an answer with no value', async () => {
    const conv = conversation({ mode: 'relay' });
    fake.reply = () => '<secret name="TOKEN"/>';
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    const { msg, part } = partOf(conv.id, 'secrets');
    await expect(orchestrator.answerSecrets(conv.id, msg.id, part.id, { values: { TOKEN: '  ' } })).rejects.toMatchObject({ status: 400 });
    await orchestrator.answerSecrets(conv.id, msg.id, part.id, { decline: true });
    await finish(conv.id);
    expect(partOf(conv.id, 'secrets').part.asks[0]!.status).toBe('declined');
    expect(settings.handoffs.secretNames(orchestrator.handoffFolder(conv))).toEqual([]);
  });
});

describe('fixed command cards', () => {
  const propose = async () => {
    const conv = conversation({ mode: 'relay' });
    writeFileSync(join(project, 'post.py'), 'print("v1")\n');
    fake.reply = (name) =>
      name === 'Alice' && calls.filter((c) => c.name === 'Alice').length === 1
        ? 'Save this.\n\n<command name="post" hosts="graph.threads.net" secrets="TOKEN">python3 post.py</command>'
        : 'OK.';
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    settings.handoffs.setSecrets(orchestrator.handoffFolder(conv), { TOKEN: 'tok-123456' });
    return { conv, ...partOf(conv.id, 'command') };
  };

  it('saves a proposed command pinned to its code, tries it, and shares the result with secrets masked', async () => {
    const { conv, msg, part } = await propose();
    expect(msg.asked).toBe(true);
    expect(part).toMatchObject({ status: 'proposed', proposal: { name: 'post', run: 'python3 post.py', hosts: ['graph.threads.net'] } });
    const saved = await orchestrator.saveCommand(conv.id, msg.id, part.id, { run: 'python3 post.py --quiet' });
    expect(saved).toMatchObject({ name: 'post', run: 'python3 post.py --quiet', folder: orchestrator.handoffFolder(conv) });
    expect(settings.handoffs.pin(saved.id)!.manifest).toHaveProperty(['post.py']);
    await expect(orchestrator.saveCommand(conv.id, msg.id, part.id)).rejects.toMatchObject({ status: 409 });

    play = (env) => ({ code: 0, stdout: `used ${readFileSync(env.RELAY_SECRETS_FILE!, 'utf8').trim()}` });
    await orchestrator.tryCommand(conv.id, saved.id, { extra: '--dry-run' });
    await vi.waitFor(() => expect(partOf(conv.id, 'command').part.run?.status).toBe('passed'));
    expect(ran.at(-1)!.env.RELAY_CHECK_COMMAND).toBe('python3 post.py --quiet --dry-run');
    expect(partOf(conv.id, 'command').part.run!.output).toBe('used TOKEN=••••');

    await orchestrator.answerCommand(conv.id, msg.id, part.id, true);
    await finish(conv.id);
    const shared = userTexts(conv.id).at(-1)!;
    expect(shared).toContain('used TOKEN=••••');
    expect(shared).not.toContain('tok-123456');
  });

  it('does not run once its code changed, until the user approves the change; its data may change', async () => {
    const { conv, msg, part } = await propose();
    const { id } = await orchestrator.saveCommand(conv.id, msg.id, part.id);
    writeFileSync(join(project, 'queue.csv'), 'id,text\n1,hi\n');
    await orchestrator.tryCommand(conv.id, id);
    await vi.waitFor(() => expect(partOf(conv.id, 'command').part.run?.status).toBe('passed'));
    writeFileSync(join(project, 'post.py'), 'print("leak")\n');
    await orchestrator.tryCommand(conv.id, id);
    await vi.waitFor(() => expect(partOf(conv.id, 'command').part.run?.status).toBe('changed'));
    expect(partOf(conv.id, 'command').part.run!.changed).toEqual(['post.py']);
    expect(ran).toHaveLength(1);
    const diff = await orchestrator.commandDiff(conv.id, id);
    expect(diff.changed).toEqual(['post.py']);
    expect(diff.diff).toContain('+print("leak")');
    await orchestrator.tryCommand(conv.id, id, { approve: true });
    await vi.waitFor(() => expect(partOf(conv.id, 'command').part.run?.status).toBe('passed'));
    expect(ran).toHaveLength(2);
  });

  it('dismisses a proposal, telling the team', async () => {
    const { conv, msg, part } = await propose();
    await orchestrator.dismissCommand(conv.id, msg.id, part.id);
    await finish(conv.id);
    expect(partOf(conv.id, 'command').part.status).toBe('dismissed');
    expect(userTexts(conv.id).at(-1)).toContain('post');
    expect(settings.handoffs.commands(orchestrator.handoffFolder(conv))).toEqual([]);
  });

  it("refuses another chat's command", async () => {
    const { conv, msg, part } = await propose();
    const { id } = await orchestrator.saveCommand(conv.id, msg.id, part.id);
    const other = conversation({ mode: 'relay', cwd: join(project, 'elsewhere') });
    mkdirSync(join(project, 'elsewhere'), { recursive: true });
    await expect(orchestrator.tryCommand(other.id, id)).rejects.toMatchObject({ status: 404 });
  });

  it('puts one run of a saved command in the outbox, which Send runs with its input', async () => {
    const { conv, msg, part } = await propose();
    await orchestrator.saveCommand(conv.id, msg.id, part.id);
    fake.reply = () =>
      'Ready to post.\n\n<command-run name="post">\nHello, Threads!\n</command-run>\n<command-run name="nope">x</command-run>';
    await orchestrator.send(conv.id, 'post it');
    await finish(conv.id);
    const last = agentMessages(store.get(conv.id)!).at(-1)!;
    const item = last.parts.find((p): p is Extract<MessagePart, { type: 'outbox' }> => p.type === 'outbox')!;
    expect(item).toMatchObject({ tool: FIXED_COMMAND_TOOL, status: 'pending', preview: { body: 'Hello, Threads!' } });
    expect(last.parts.some((p) => p.type === 'notice' && p.text.includes('nope'))).toBe(true);
    expect(last.asked).toBeFalsy();
    const sent = await orchestrator.answerOutbox(conv.id, item.id, 'send');
    expect(sent.status).toBe('sent');
    expect(ran.at(-1)!.stdin).toBe('Hello, Threads!');
  });
});

describe('a schedule that runs a fixed command first', () => {
  /** A conversation with a saved command and a schedule that runs it. */
  const scheduled = async () => {
    const conv = conversation({ mode: 'relay' });
    writeFileSync(join(project, 'check.py'), 'print("check")\n');
    const folder = orchestrator.handoffFolder(conv);
    const { takePin } = await import('../src/server/fixedCommands');
    const id = settings.handoffs.commandId(folder, 'check');
    settings.handoffs.saveCommand(
      folder,
      id,
      { name: 'check', run: 'python3 check.py', hosts: [], secrets: [] },
      await takePin(folder, id),
    );
    conv.schedule = {
      text: 'Post what the check found.',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: 0,
      command: id,
    };
    store.saveSchedule(conv);
    return { conv, id };
  };

  it('keeps the command with the schedule', async () => {
    const { conv, id } = await scheduled();
    const { Store } = await import('../src/server/store');
    expect(new Store(db).get(conv.id)!.schedule!.command).toBe(id);
  });

  it('sends nothing when it found nothing (exit code 0): no model runs', async () => {
    const { conv } = await scheduled();
    play = () => ({ code: 0, stdout: 'nothing new' });
    expect(await orchestrator.sendScheduled(conv.id)).toEqual({ result: 'ran' });
    expect(calls).toHaveLength(0);
    expect(store.get(conv.id)!.messages).toHaveLength(0);
    expect(ran).toHaveLength(1);
  });

  it('sends the message with its output when it found something new, or failed', async () => {
    const { conv } = await scheduled();
    play = () => ({ code: 10, stdout: '2 new items' });
    expect((await orchestrator.sendScheduled(conv.id)).result).toBe('sent');
    await finish(conv.id);
    const message = store.get(conv.id)!.messages.find((m) => m.author.kind === 'user')!;
    expect(textOf(message)).toBe('Post what the check found.');
    expect(message.eventSource).toBe('command');
    expect(message.event).toContain('found something new (exit code 10)');
    expect(message.event).toContain('2 new items');
    expect(calls[0]!.prompt).toContain('2 new items');

    play = () => ({ code: 2, stdout: 'Traceback' });
    expect((await orchestrator.sendScheduled(conv.id)).result).toBe('sent');
    await finish(conv.id);
    expect(
      store
        .get(conv.id)!
        .messages.filter((m) => m.author.kind === 'user')
        .at(-1)!.event,
    ).toContain('failed (exit code 2)');
  });

  it('does not run, nor send, once its code changed; and fails for a command that is gone', async () => {
    const { conv, id } = await scheduled();
    writeFileSync(join(project, 'check.py'), 'print("changed")\n');
    const changed = await orchestrator.sendScheduled(conv.id);
    expect(changed.result).toBe('failed');
    expect(ran).toHaveLength(0);
    expect(calls).toHaveLength(0);
    settings.handoffs.deleteCommand(id);
    expect((await orchestrator.sendScheduled(conv.id)).result).toBe('failed');
  });
});
