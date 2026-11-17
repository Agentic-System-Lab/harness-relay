/*
 * IMAP IDLE for the automations that start when a new mail arrives (`src/server/idle.ts`, and
 * `ImapClient.idle()`), against the stand-in IMAP server: one connection for each mail account and
 * folder, waiting there; the server saying mail arrived (`* n EXISTS`) checks every automation on it,
 * once for mail that arrives together and again for mail during the checks; IDLE renewed, its DONE
 * answered or not; a dropped connection opened again, more slowly after each failure in a row, and a
 * refused sign-in as slowly as the checks back off; a server that does not take IDLE left to the
 * checks; an automation turned off, another folder, a saved account or a computer that slept
 * replacing a connection; stopping while it connects.
 */
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorStore } from '../src/server/connectors/accounts';
import { IdleRefusedError, ImapClient, type ImapResponse } from '../src/server/connectors/imap';
import { openDatabase } from '../src/server/db';
import { HttpError } from '../src/server/errors';
import { IdleWatcher, IDLE_SYNC_MS, type IdleDeps } from '../src/server/idle';
import { validateMailAccount } from '../src/server/validate';
import { nextCheckAt } from '../src/server/watch';
import { WATCH_LIMITS, type ScheduleTrigger } from '../src/shared/types';
import { fakeImap, type FakeImap, type FakeMessage } from './fake-mail-servers';

const mail = (uid: number): FakeMessage => ({ uid, raw: `From: a@example.com\r\nSubject: ${uid}\r\n\r\nHi\r\n` });

let server: FakeImap | undefined;
let watcher: IdleWatcher | undefined;
afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

const account = (port: number, password = 'app-pass') =>
  validateMailAccount(
    {
      name: 'Work',
      address: 'me@example.com',
      username: 'me@example.com',
      password,
      imap: { host: '127.0.0.1', port, security: 'none' },
      smtp: { host: '127.0.0.1', port: 1, security: 'none' },
    },
    [],
  );

function accounts(port: number): ConnectorStore {
  const store = new ConnectorStore(openDatabase(':memory:'));
  store.saveMail('work', account(port));
  return store;
}

const inbox: Extract<ScheduleTrigger, { source: 'mail' }> = { source: 'mail', account: 'work', folder: 'INBOX' };
const login = { username: 'me@example.com', password: 'app-pass' };
const logins = () => server!.commands.filter((c) => / LOGIN /.test(c)).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function start(o: Partial<IdleDeps> & Pick<IdleDeps, 'watching'>, connectors = accounts(server!.port)): IdleWatcher {
  watcher = new IdleWatcher({
    connectors,
    check: async () => undefined,
    settleMs: 20,
    backoffMs: [20],
    loginBackoffMs: [60_000],
    renewMs: 60_000,
    timeoutMs: 2000,
    ...o,
  });
  watcher.sync();
  return watcher;
}

describe('IMAP IDLE', () => {
  it('waits in IDLE, passing what the server says, until stopped, then ends it with DONE', async () => {
    const messages = [mail(1)];
    server = await fakeImap(messages);
    server.idle = true;
    const c = await ImapClient.open({ host: '127.0.0.1', port: server.port, security: 'none' }, login);
    expect(c.capabilities.has('IDLE')).toBe(true);
    await c.command('EXAMINE "INBOX"');
    const said: string[] = [];
    let idling = false;
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const waiting = c.idle(
      (r: ImapResponse) => said.push(r.text),
      stopped,
      () => (idling = true),
    );
    await vi.waitFor(() => expect(idling && server!.idling === 1).toBe(true));
    messages.push(mail(2));
    server.notify();
    await vi.waitFor(() => expect(said).toEqual(['* 2 EXISTS']));
    stop();
    await waiting;
    expect(server.commands.at(-1)).toBe('DONE');
    expect(server.idling).toBe(0);
    // The connection goes on as before.
    expect((await c.command('UID SEARCH UID 1:*')).untagged[0]!.text).toBe('* SEARCH 1 2');
    await c.logout();
  });

  it('fails when the server refuses IDLE, says BYE, answers DONE with NO or not at all, or the connection drops', async () => {
    server = await fakeImap([]);
    const addr = { host: '127.0.0.1', port: server.port, security: 'none' as const };
    const never = new Promise<void>(() => undefined);
    const open = async () => {
      const c = await ImapClient.open(addr, login, 500);
      await c.command('EXAMINE "INBOX"');
      return c;
    };
    // Not listed, or listed and refused: IDLE does not work there.
    let c = await open();
    await expect(c.idle(() => undefined, never)).rejects.toBeInstanceOf(IdleRefusedError);
    c.close();
    server.idle = true;
    server.idleAnswer = 'no';
    c = await open();
    await expect(c.idle(() => undefined, never)).rejects.toBeInstanceOf(IdleRefusedError);
    c.close();
    server.idleAnswer = 'ok';
    // BYE while it waits.
    c = await open();
    let waiting = c.idle(() => undefined, never);
    await vi.waitFor(() => expect(server!.idling).toBe(1));
    server.bye();
    await expect(waiting).rejects.toThrow('BYE');
    // DONE answered NO, or never: an error, the second after the time limit.
    for (const answer of ['no', 'none'] as const) {
      server.doneAnswer = answer;
      c = await open();
      let stop!: () => void;
      waiting = c.idle(() => undefined, new Promise<void>((r) => (stop = r)));
      await vi.waitFor(() => expect(server!.idling).toBe(1));
      stop();
      await expect(waiting).rejects.toThrow();
      c.close();
    }
    server.doneAnswer = 'ok';
    // Dropped while it waits.
    c = await open();
    waiting = c.idle(() => undefined, never);
    await vi.waitFor(() => expect(server!.idling).toBe(1));
    server.drop();
    await expect(waiting).rejects.toThrow();
  });
});

describe('the IDLE connections of automations that wait for new mail', () => {
  it('keeps one connection for each account and folder, and checks every automation on it when mail arrives', async () => {
    const messages = [mail(1)];
    server = await fakeImap(messages);
    server.idle = true;
    const checks: string[] = [];
    let release: (() => void) | undefined;
    const w = start({
      watching: () => [
        { conversationId: 'c1', trigger: inbox },
        { conversationId: 'c2', trigger: { ...inbox, from: 'bob' } },
      ],
      check: async (id) => {
        checks.push(id);
        if (checks.length === 3) await new Promise<void>((r) => (release = r));
      },
    });
    await vi.waitFor(() => expect(w.live('c1') && w.live('c2') && server!.idling === 1).toBe(true));
    expect(w.connections).toBe(1);
    // Two in a row: one round of checks, one automation after the other.
    messages.push(mail(2), mail(3));
    server.notify();
    server.notify();
    await vi.waitFor(() => expect(checks).toEqual(['c1', 'c2']));
    await sleep(60);
    expect(checks).toEqual(['c1', 'c2']);
    // During a round, another one after it.
    server.notify();
    await vi.waitFor(() => expect(checks).toHaveLength(3));
    server.notify();
    await sleep(60);
    expect(checks).toHaveLength(3);
    release!();
    await vi.waitFor(() => expect(checks).toHaveLength(6));
  });

  it('does not log a conversation deleted meanwhile', async () => {
    server = await fakeImap([mail(1)]);
    server.idle = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let checked = 0;
    const w = start({
      watching: () => [{ conversationId: 'gone', trigger: inbox }],
      check: async () => {
        checked++;
        throw new HttpError(404, 'no such conversation');
      },
    });
    await vi.waitFor(() => expect(w.live('gone')).toBe(true));
    server.notify();
    await vi.waitFor(() => expect(checked).toBe(1));
    expect(errors).not.toHaveBeenCalled();
  });

  it('renews IDLE, opens a dropped connection again more slowly each time, and logs only the first failure in a row', async () => {
    server = await fakeImap([mail(1)]);
    server.idle = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = start({ watching: () => [{ conversationId: 'c1', trigger: inbox }], backoffMs: [20, 400], renewMs: 80 });
    await vi.waitFor(() => expect(server!.idling).toBe(1));
    // Renewed: DONE, then IDLE again on the same connection.
    await vi.waitFor(() => expect(server!.commands.filter((c) => / IDLE$/.test(c)).length).toBeGreaterThan(1));
    expect(server.commands.filter((c) => c === 'DONE').length).toBeGreaterThan(0);
    // Dropped twice before a round completes: the second wait is the longer one.
    const before = logins();
    server.drop();
    await vi.waitFor(() => expect(logins()).toBe(before + 1));
    server.drop();
    await sleep(150);
    expect(logins()).toBe(before + 1);
    await vi.waitFor(() => expect(logins()).toBe(before + 2), { timeout: 2000 });
    await vi.waitFor(() => expect(w.live('c1')).toBe(true));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves a server that does not list or take IDLE to the checks, never trying again', async () => {
    server = await fakeImap([]);
    const w = start({ watching: () => [{ conversationId: 'c1', trigger: inbox }] });
    await vi.waitFor(() => expect(w.unsupported('c1')).toBe(true));
    expect(w.live('c1')).toBe(false);
    expect(server.commands.some((c) => / IDLE$/.test(c))).toBe(false);
    await w.stop();
    server.idle = true;
    server.idleAnswer = 'no';
    const v = start({ watching: () => [{ conversationId: 'c1', trigger: inbox }] });
    await vi.waitFor(() => expect(v.unsupported('c1')).toBe(true));
    const n = logins();
    await sleep(100);
    expect(logins()).toBe(n);
  });

  it('waits as long as the checks do after a refused sign-in', async () => {
    server = await fakeImap([]);
    server.idle = true;
    const store = new ConnectorStore(openDatabase(':memory:'));
    store.saveMail('work', account(server.port, 'wrong'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    start({ watching: () => [{ conversationId: 'c1', trigger: inbox }], backoffMs: [20], loginBackoffMs: [500] }, store);
    await vi.waitFor(() => expect(logins()).toBe(1));
    await sleep(200);
    expect(logins()).toBe(1);
    await vi.waitFor(() => expect(logins()).toBe(2), { timeout: 2000 });
  });

  it('replaces a connection when its automation goes, its folder or account changes, or the computer slept', async () => {
    server = await fakeImap([]);
    server.idle = true;
    let wanted = [{ conversationId: 'c1', trigger: inbox }];
    let clock = 1_000_000;
    const store = accounts(server.port);
    const w = start({ watching: () => wanted, now: () => clock }, store);
    await vi.waitFor(() => expect(w.live('c1') && server!.idling === 1).toBe(true));
    // Turned off: closed.
    wanted = [];
    w.sync();
    await vi.waitFor(() => expect(server!.idling).toBe(0));
    expect(w.live('c1')).toBe(false);
    // Another folder.
    wanted = [{ conversationId: 'c1', trigger: { ...inbox, folder: 'inbox' } }];
    w.sync();
    await vi.waitFor(() => expect(w.live('c1') && server!.idling === 1).toBe(true));
    // The account saved again (a new password, say): opened again.
    let n = logins();
    store.saveMail('work', account(server.port));
    w.sync();
    await vi.waitFor(() => expect(logins()).toBe(n + 1));
    await vi.waitFor(() => expect(server!.idling).toBe(1));
    // A sync much later than it should be: the computer slept, every connection is opened again.
    n = logins();
    clock += IDLE_SYNC_MS;
    w.sync();
    await sleep(50);
    expect(logins()).toBe(n);
    clock += 10 * IDLE_SYNC_MS;
    w.sync();
    await vi.waitFor(() => expect(logins()).toBe(n + 1));
  });

  it('stops a connection while it is still connecting', async () => {
    // A server that takes the connection and says nothing.
    const silent: Server = createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (silent.address() as { port: number }).port;
      const w = new IdleWatcher({
        connectors: accounts(port),
        watching: () => [{ conversationId: 'c1', trigger: inbox }],
        check: async () => undefined,
        timeoutMs: 30_000,
      });
      w.sync();
      await sleep(50);
      const t0 = Date.now();
      await w.stop();
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      silent.close();
    }
  });

  it('checks more slowly while it listens', () => {
    expect(nextCheckAt(0, 0, true)).toBe(WATCH_LIMITS.idleCheckMinutes * 60_000);
    expect(nextCheckAt(0, 0, false)).toBe(WATCH_LIMITS.checkMinutes * 60_000);
    // Failing checks still back off as before.
    expect(nextCheckAt(0, 1, true)).toBe(WATCH_LIMITS.backoffMinutes[0]! * 60_000);
  });

  it('checks once a connection that dropped listens again: mail that came meanwhile says nothing by itself', async () => {
    const messages = [mail(1)];
    server = await fakeImap(messages);
    server.idle = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const checks: string[] = [];
    const w = start({ watching: () => [{ conversationId: 'c1', trigger: inbox }], check: async (id) => void checks.push(id) });
    await vi.waitFor(() => expect(w.live('c1') && server!.idling === 1).toBe(true));
    // The first connection checks nothing by itself.
    await sleep(60);
    expect(checks).toEqual([]);
    server.drop();
    messages.push(mail(2));
    await vi.waitFor(() => expect(checks).toEqual(['c1']));
  });

  it('waits before waiting in IDLE again when the server ends it at once', async () => {
    server = await fakeImap([]);
    server.idle = true;
    server.idleAnswer = 'end';
    start({ watching: () => [{ conversationId: 'c1', trigger: inbox }], backoffMs: [100], renewMs: 60_000 });
    await sleep(350);
    const idles = server.commands.filter((c) => / IDLE$/.test(c)).length;
    expect(idles).toBeGreaterThan(0);
    expect(idles).toBeLessThan(10);
  });

  it('asks a server that did not take IDLE again after a long while', async () => {
    server = await fakeImap([]);
    const w = start({ watching: () => [{ conversationId: 'c1', trigger: inbox }], unsupportedRetryMs: 150 });
    await vi.waitFor(() => expect(w.unsupported('c1')).toBe(true));
    server.idle = true;
    await vi.waitFor(() => expect(w.live('c1')).toBe(true), { timeout: 2000 });
  });

  it('leaves no abort listener behind once a connection is open', async () => {
    server = await fakeImap([]);
    const { getEventListeners } = await import('node:events');
    const { openSocket } = await import('../src/server/connectors/imap');
    const abort = new AbortController();
    const sock = await openSocket({ host: '127.0.0.1', port: server.port, security: 'none' }, 2000, abort.signal);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    sock.destroy();
  });
});
