/*
 * Secrets and fixed commands in team runs (docs/architecture.md, "Secrets and fixed commands"): a
 * reply's blocks taken out into cards that wait for the user, the answer the team gets (names, never a
 * value), a proposed command saved, pinned, tried and shared, its code changing, and one run of it put
 * in the outbox and sent. The fixed commands' sandbox and process are stand-ins
 * (`orchestrator.fixedCommandDeps`); the folder is a real git repository.
 *
 * The fake CLI, and what each test starts with, are in ./orchestrator-harness.ts.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePart } from '../src/shared/types';
import { HandoffStore } from '../src/server/handoffs';
import type { FixedCommandDeps } from '../src/server/fixedCommands';
import type { SecretStore } from '../src/server/secrets';
import type { SpawnResult } from '../src/server/process';
import { FIXED_COMMAND_TOOL } from '../src/server/orchestrator';
import { UserBrowserError, type UserBrowsers } from '../src/server/browser/handover';
import { Outbox } from '../src/server/outbox';
import { defaultInteractiveDeps } from '../src/server/interactive';
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
  withLang,
} from './orchestrator-harness';
import { slow } from './timeouts';

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
  const tmp = join(root, 'interactive-tmp');
  mkdirSync(tmp, { recursive: true });
  orchestrator.interactiveDeps = { ...defaultInteractiveDeps, env: { PATH: process.env.PATH ?? '' }, tmpDir: () => tmp };
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
  describe('a browser for the user alone, and Save selection', () => {
    /** A stand-in for the browsers for the user alone: what each page has selected, by id. */
    const standIn = () => {
      const selected = new Map<string, string>();
      const opened: { convId: string; url?: string; id: string }[] = [];
      const closed: string[] = [];
      const ends = new Map<string, () => void>();
      let n = 0;
      const browsers: UserBrowsers = {
        openForUser: async (convId, o = {}) => {
          const id = `ub-${++n}`;
          opened.push({ convId, id, ...(o.url ? { url: o.url } : {}) });
          if (o.onEnd) ends.set(id, o.onEnd);
          return id;
        },
        userBrowserOpen: (_convId, id) => opened.some((b) => b.id === id) && !closed.includes(id),
        selectionOf: async (_convId, id) => {
          if (closed.includes(id)) throw new UserBrowserError('gone', 'it closed');
          return selected.get(id) ?? '';
        },
        closeForUser: async (_convId, id) => {
          closed.push(id);
          ends.get(id)?.();
        },
      };
      orchestrator.userBrowsers = browsers;
      return { selected, opened, closed, ends };
    };

    it("opens it at the address an ask named, keeps what the user selected under the ask's name, and answers once none waits", async () => {
      const { selected, opened, closed } = standIn();
      const conv = conversation({ mode: 'relay' });
      fake.reply = (name) =>
        name === 'Alice' && !calls.some((c) => c.name === 'Alice' && c.prompt.includes('gave'))
          ? '<secret name="TOKEN" url="https://dev.example.com/tokens?app=1">From the token generator.</secret>\n<secret name="APP_ID"/>'
          : 'Thanks.';
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      const { msg, part } = partOf(conv.id, 'secrets');
      expect(part.asks[0]).toMatchObject({ name: 'TOKEN', url: 'https://dev.example.com/tokens?app=1' });
      const { handoverId } = await orchestrator.openSecretsBrowser(conv.id, msg.id, part.id, 'TOKEN');
      expect(opened).toEqual([{ convId: conv.id, id: handoverId, url: 'https://dev.example.com/tokens?app=1' }]);
      // One per card: the same one again while it is open.
      expect(await orchestrator.openSecretsBrowser(conv.id, msg.id, part.id, 'APP_ID')).toEqual({ handoverId });
      await expect(orchestrator.openSecretsBrowser(conv.id, msg.id, part.id, 'OTHER')).rejects.toMatchObject({ status: 409 });

      // Nothing selected: refused, nothing kept.
      await expect(orchestrator.saveSecretFromPage(conv.id, msg.id, part.id, handoverId, 'TOKEN')).rejects.toMatchObject({ status: 400 });
      // A selection of more than one line: refused as a typed value would be.
      selected.set(handoverId, 'tok-line-one\ntok-line-two');
      await expect(orchestrator.saveSecretFromPage(conv.id, msg.id, part.id, handoverId, 'TOKEN')).rejects.toMatchObject({ status: 400 });
      selected.set(handoverId, '  tok-from-the-page-42  ');
      await expect(orchestrator.saveSecretFromPage(conv.id, msg.id, part.id, 'ub-other', 'TOKEN')).rejects.toMatchObject({ status: 404 });
      await orchestrator.saveSecretFromPage(conv.id, msg.id, part.id, handoverId, 'TOKEN');
      const folder = orchestrator.handoffFolder(conv);
      expect(settings.handoffs.values(folder)).toEqual({ TOKEN: 'tok-from-the-page-42' });
      expect(partOf(conv.id, 'secrets').part.asks.map((a) => [a.status, a.from])).toEqual([
        ['saved', 'page'],
        ['waiting', undefined],
      ]);
      // An ask still waits: no answer yet, and the browser stays open.
      expect(userTexts(conv.id)).toEqual(['go']);
      expect(closed).toEqual([]);
      await expect(orchestrator.saveSecretFromPage(conv.id, msg.id, part.id, handoverId, 'TOKEN')).rejects.toMatchObject({ status: 409 });

      // The other one, from the page too: the browser closes, and the team gets the names, never a value.
      selected.set(handoverId, 'app-77001');
      await orchestrator.saveSecretFromPage(conv.id, msg.id, part.id, handoverId, 'APP_ID');
      await finish(conv.id);
      expect(closed).toEqual([handoverId]);
      expect(settings.handoffs.values(folder)).toEqual({ TOKEN: 'tok-from-the-page-42', APP_ID: 'app-77001' });
      const answer = userTexts(conv.id).at(-1)!;
      expect(answer).toContain('TOKEN');
      expect(answer).toContain('APP_ID');
      for (const value of ['tok-from-the-page-42', 'app-77001']) {
        expect(answer).not.toContain(value);
        expect(JSON.stringify(store.get(conv.id))).not.toContain(value);
        expect(calls.at(-1)!.prompt + calls.at(-1)!.systemPrompt).not.toContain(value);
      }
      await expect(orchestrator.openSecretsBrowser(conv.id, msg.id, part.id)).rejects.toMatchObject({ status: 409 });
    });

    it('closes the browser when the card is answered on the card, naming what was saved from the page too', () =>
      withLang('en', async () => {
        const { selected, closed } = standIn();
        const conv = conversation({ mode: 'relay' });
        fake.reply = (name) =>
          name === 'Alice' && !calls.some((c) => c.name === 'Alice' && c.prompt.includes('gave'))
            ? '<secret name="A_KEY"/>\n<secret name="B_KEY"/>'
            : 'Thanks.';
        await orchestrator.send(conv.id, 'go');
        await finish(conv.id);
        const { msg, part } = partOf(conv.id, 'secrets');
        const { handoverId } = await orchestrator.openSecretsBrowser(conv.id, msg.id, part.id);
        selected.set(handoverId, 'value-from-page');
        await orchestrator.saveSecretFromPage(conv.id, msg.id, part.id, handoverId, 'A_KEY');
        await orchestrator.answerSecrets(conv.id, msg.id, part.id, { decline: true });
        await finish(conv.id);
        expect(closed).toEqual([handoverId]);
        expect(partOf(conv.id, 'secrets').part.asks.map((a) => a.status)).toEqual(['saved', 'declined']);
        const answer = userTexts(conv.id).at(-1)!;
        expect(answer).toMatch(/I gave A_KEY/);
        expect(answer).toMatch(/I will not give B_KEY/);
      }));

    it('opens another once the browser closed by itself, and says when none can be opened', async () => {
      const { opened, ends } = standIn();
      const conv = conversation({ mode: 'relay' });
      fake.reply = () => '<secret name="TOKEN"/>';
      await orchestrator.send(conv.id, 'go');
      await finish(conv.id);
      const { msg, part } = partOf(conv.id, 'secrets');
      const first = (await orchestrator.openSecretsBrowser(conv.id, msg.id, part.id)).handoverId;
      // Closed by the user in its panel (or its time ran out): gone from the card, and its selection with it.
      ends.get(first)!();
      await expect(orchestrator.saveSecretFromPage(conv.id, msg.id, part.id, first, 'TOKEN')).rejects.toMatchObject({ status: 404 });
      const second = (await orchestrator.openSecretsBrowser(conv.id, msg.id, part.id)).handoverId;
      expect(second).not.toBe(first);
      expect(opened).toHaveLength(2);
      orchestrator.userBrowsers = {
        ...orchestrator.userBrowsers!,
        openForUser: async () => {
          throw new UserBrowserError('busy', 'at most 3 at once');
        },
        userBrowserOpen: () => false,
      };
      await expect(orchestrator.openSecretsBrowser(conv.id, msg.id, part.id)).rejects.toMatchObject({ status: 409 });
      // An address no browser of Harness Relay's opens (its own port): said in the user's words.
      orchestrator.userBrowsers.openForUser = async () => {
        throw new UserBrowserError('refused', 'http://127.0.0.1:8787/ cannot be opened');
      };
      await withLang('en', () =>
        expect(orchestrator.openSecretsBrowser(conv.id, msg.id, part.id)).rejects.toMatchObject({
          status: 409,
          message: expect.stringMatching(/never open this address/),
        }),
      );
      orchestrator.userBrowsers = undefined;
      await expect(orchestrator.openSecretsBrowser(conv.id, msg.id, part.id)).rejects.toMatchObject({ status: 409 });
    });
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

describe.skipIf(process.platform === 'win32')('interactive command cards', () => {
  /** A chat whose reply asks the user to run `run`, its card stored as the orchestrator records one. */
  const cardFor = (run: string) => {
    const conv = conversation({ mode: 'relay' });
    const part: Extract<MessagePart, { type: 'interactive' }> = {
      type: 'interactive',
      id: `card-${Math.random().toString(36).slice(2)}`,
      folder: orchestrator.handoffFolder(conv),
      run,
      configFiles: [],
      status: 'proposed',
    };
    const msg = {
      id: `m-${part.id}`,
      author: { kind: 'agent' as const, agentId: conv.agents[0]!.id },
      createdAt: 1,
      parts: [part],
      status: 'done' as const,
      asked: true,
    };
    conv.messages.push(msg);
    store.saveMessage(conv.id, msg, true);
    return { conv, msg, part };
  };
  /** The interactive commands' own folders still there (each run's, removed once it ended). */
  const runFolders = () => readdirSync(join(root, 'interactive-tmp')).filter((n) => n.startsWith('interactive-'));

  it('runs at most four at once, and one ends with its conversation, freeing its place', async () => {
    const cards = Array.from({ length: 5 }, () => cardFor('sleep 30'));
    try {
      for (const c of cards.slice(0, 4)) await orchestrator.startInteractive(c.conv.id, c.msg.id, c.part.id);
      const fifth = cards[4]!;
      await expect(orchestrator.startInteractive(fifth.conv.id, fifth.msg.id, fifth.part.id)).rejects.toMatchObject({ status: 429 });
      await vi.waitFor(() => expect(runFolders()).toHaveLength(4));
      // Deleting a conversation stops the command its card started: its folder goes, and its place is free.
      await orchestrator.deleteConversation(cards[0]!.conv.id);
      await vi.waitFor(() => expect(runFolders()).toHaveLength(3), { timeout: slow(5000) });
      await orchestrator.startInteractive(fifth.conv.id, fifth.msg.id, fifth.part.id);
      expect(partOf(fifth.conv.id, 'interactive').part.session?.state).toBe('running');
    } finally {
      orchestrator.stopInteractive();
      await vi.waitFor(() => expect(runFolders()).toEqual([]), { timeout: slow(5000) });
    }
  });

  it('does not start a command line kept with characters that do not show', async () => {
    const { conv, msg, part } = cardFor('echo safe\u202e hs.lave');
    await expect(orchestrator.startInteractive(conv.id, msg.id, part.id)).rejects.toMatchObject({ status: 409 });
    expect(runFolders()).toEqual([]);
  });

  const propose = async (
    block = '<interactive reason="To sign in to the registry.">printf \'Password: \'; IFS= read -r p; echo "got $p and $TOKEN_VALUE"</interactive>',
  ) => {
    const conv = conversation({ mode: 'relay' });
    writeFileSync(join(project, '.npmrc'), 'registry=https://registry.example\n');
    fake.reply = (name) =>
      name === 'Alice' && calls.filter((c) => c.name === 'Alice').length === 1 ? `Please sign in.\n\n${block}` : 'Thanks.';
    await orchestrator.send(conv.id, 'go');
    await finish(conv.id);
    return { conv, ...partOf(conv.id, 'interactive') };
  };

  it("takes a reply's <interactive> block into a card that waits, and tells every member how to ask", async () => {
    const { msg, part, conv } = await propose();
    expect(textOf(msg)).toBe('Please sign in.');
    expect(msg.asked).toBe(true);
    expect(part).toMatchObject({ status: 'proposed', reason: 'To sign in to the registry.', folder: orchestrator.handoffFolder(conv) });
    expect(part.configFiles).toContain('.npmrc');
    expect(part.blocked).toBeUndefined();
    expect(calls.map((c) => c.name)).toEqual(['Alice']);
    expect(calls[0]!.systemPrompt).toContain('<interactive reason="why">');
  });

  it("runs it when the user starts it, masks what was typed hidden and the folder's secrets, and sends the output once", async () => {
    const { conv, msg, part } = await propose(
      '<interactive>printf \'Password: \'; IFS= read -r p; echo "got $p"; echo "token tok-123456"</interactive>',
    );
    settings.handoffs.setSecrets(orchestrator.handoffFolder(conv), { TOKEN: 'tok-123456' });
    await expect(orchestrator.sendInteractive(conv.id, msg.id, part.id)).rejects.toMatchObject({ status: 409 });
    const started = await orchestrator.startInteractive(conv.id, msg.id, part.id);
    expect(started).toMatchObject({ state: 'running', inWorkdir: false });
    await expect(orchestrator.startInteractive(conv.id, msg.id, part.id)).rejects.toMatchObject({ status: 409 });
    await vi.waitFor(() => expect(partOf(conv.id, 'interactive').part.session?.output).toContain('Password: '));
    orchestrator.interactiveInput(conv.id, msg.id, part.id, 'hunter2-pass', true);
    await vi.waitFor(() => expect(partOf(conv.id, 'interactive').part.session?.state).toBe('exited'), { timeout: slow(5000) });
    const card = partOf(conv.id, 'interactive').part;
    expect(card.status).toBe('started');
    expect(card.session!.output).toContain('got ••••');
    expect(card.session!.output).toContain('token ••••');
    expect(JSON.stringify(store.get(conv.id))).not.toContain('hunter2-pass');
    // Typing into it once it ended is refused.
    expect(() => orchestrator.interactiveInput(conv.id, msg.id, part.id, 'late', false)).toThrow(expect.objectContaining({ status: 409 }));

    await orchestrator.sendInteractive(conv.id, msg.id, part.id);
    await finish(conv.id);
    const sent = userTexts(conv.id).at(-1)!;
    expect(sent).toContain('got ••••');
    expect(sent).toMatch(/結束碼 0|exit code 0/);
    expect(sent).not.toContain('hunter2-pass');
    expect(sent).not.toContain('tok-123456');
    expect(partOf(conv.id, 'interactive').part.session!.sent).toBe(true);
    await expect(orchestrator.sendInteractive(conv.id, msg.id, part.id)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to start in the working directory when configuration files the card did not list appeared', async () => {
    const { conv, msg, part } = await propose('<interactive workdir="yes">pwd</interactive>');
    expect(part.workdir).toBe(true);
    writeFileSync(join(project, '.env'), 'X=1\n');
    await expect(orchestrator.startInteractive(conv.id, msg.id, part.id, { workdir: true, seen: part.configFiles })).rejects.toMatchObject({
      status: 409,
    });
    const listed = partOf(conv.id, 'interactive').part.configFiles;
    expect(listed).toContain('.env');
    await orchestrator.startInteractive(conv.id, msg.id, part.id, { workdir: true, seen: listed });
    await vi.waitFor(() => expect(partOf(conv.id, 'interactive').part.session?.state).toBe('exited'), { timeout: slow(5000) });
    expect(partOf(conv.id, 'interactive').part.session).toMatchObject({ inWorkdir: true, exitCode: 0 });
    expect(partOf(conv.id, 'interactive').part.session!.output.trim()).toBe(orchestrator.handoffFolder(conv));
  });

  it("does not run, telling the team, and is never started from a card an automation's run proposed", async () => {
    const { conv, msg, part } = await propose('<interactive>npm login</interactive>');
    await orchestrator.dismissInteractive(conv.id, msg.id, part.id);
    await finish(conv.id);
    expect(partOf(conv.id, 'interactive').part.status).toBe('dismissed');
    expect(userTexts(conv.id).at(-1)).toContain('npm login');
    await expect(orchestrator.startInteractive(conv.id, msg.id, part.id)).rejects.toMatchObject({ status: 409 });

    const other = conversation({ mode: 'relay' });
    other.schedule = {
      text: 'check the deploy',
      repeat: { kind: 'interval', hours: 1 },
      timeZone: 'UTC',
      lang: 'en',
      enabled: true,
      approvals: 'deny',
      missed: 'skip',
      newChat: false,
      updatedAt: 0,
      nextRunAt: Date.now() + 3_600_000,
    };
    store.saveSchedule(other);
    fake.reply = () => 'The token expired.\n\n<interactive>gcloud auth login --no-launch-browser</interactive>';
    await orchestrator.sendScheduled(other.id);
    await finish(other.id);
    const card = partOf(other.id, 'interactive');
    expect(card.part.blocked).toBe('automation');
    await expect(orchestrator.startInteractive(other.id, card.msg.id, card.part.id)).rejects.toMatchObject({ status: 409 });
    // Another chat's card is not this chat's.
    await expect(orchestrator.startInteractive(conv.id, card.msg.id, card.part.id)).rejects.toMatchObject({ status: 404 });
  });

  it("stops on Cancel, the card saying so; Cancel once it ended is refused; a branch's copy of a running card says it stopped", async () => {
    const { conv, msg, part } = await propose('<interactive>sleep 30</interactive>');
    await orchestrator.startInteractive(conv.id, msg.id, part.id);
    const branch = await orchestrator.branch(conv.id, msg.id);
    const copy = partOf(branch.id, 'interactive');
    expect(copy.part.session?.state).toBe('stopped');
    expect(() => orchestrator.cancelInteractive(branch.id, copy.msg.id, copy.part.id)).toThrow(expect.objectContaining({ status: 409 }));
    orchestrator.cancelInteractive(conv.id, msg.id, part.id);
    await vi.waitFor(() => expect(partOf(conv.id, 'interactive').part.session?.state).toBe('cancelled'), { timeout: slow(5000) });
    expect(() => orchestrator.cancelInteractive(conv.id, msg.id, part.id)).toThrow(expect.objectContaining({ status: 409 }));
  });
});
