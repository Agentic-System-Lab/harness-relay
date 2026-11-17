/*
 * IMAP IDLE for the automations that start when a new mail arrives (`src/server/idle.ts`, and
 * `ImapClient.idle()`), against the stand-in IMAP server: a connection for each automation that is on
 * waits in its folder; the server saying mail arrived (`* n EXISTS`) checks that automation, once for
 * mail that arrives together and again for mail during a check; IDLE is renewed before the server's
 * limit; a dropped connection is opened again; a server without IDLE is left to the checks; an
 * automation turned off, or another folder, closes or replaces its connection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorStore } from '../src/server/connectors/accounts';
import { ImapClient, type ImapResponse } from '../src/server/connectors/imap';
import { openDatabase } from '../src/server/db';
import { IdleWatcher } from '../src/server/idle';
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
});

function accounts(port: number): ConnectorStore {
  const store = new ConnectorStore(openDatabase(':memory:'));
  store.saveMail(
    'work',
    validateMailAccount(
      {
        name: 'Work',
        address: 'me@example.com',
        username: 'me@example.com',
        password: 'app-pass',
        imap: { host: '127.0.0.1', port, security: 'none' },
        smtp: { host: '127.0.0.1', port: 1, security: 'none' },
      },
      [],
    ),
  );
  return store;
}

const inbox: Extract<ScheduleTrigger, { source: 'mail' }> = { source: 'mail', account: 'work', folder: 'INBOX' };

describe('IMAP IDLE', () => {
  it('waits in IDLE, passing what the server says, until stopped, then ends it with DONE', async () => {
    const messages = [mail(1)];
    server = await fakeImap(messages);
    server.idle = true;
    const c = await ImapClient.open(
      { host: '127.0.0.1', port: server.port, security: 'none' },
      { username: 'me@example.com', password: 'app-pass' },
    );
    expect(c.capabilities.has('IDLE')).toBe(true);
    await c.command('EXAMINE "INBOX"');
    const said: string[] = [];
    let stop!: () => void;
    const stopped = new Promise<void>((r) => (stop = r));
    const idling = c.idle((r: ImapResponse) => said.push(r.text), stopped);
    await vi.waitFor(() => expect(server!.idling).toBe(1));
    messages.push(mail(2));
    server.notify();
    await vi.waitFor(() => expect(said).toEqual(['* 2 EXISTS']));
    stop();
    await idling;
    expect(server.commands.at(-1)).toBe('DONE');
    expect(server.idling).toBe(0);
    // The connection goes on as before.
    expect((await c.command('UID SEARCH UID 1:*')).untagged[0]!.text).toBe('* SEARCH 1 2');
    await c.logout();
  });

  it('fails when the server does not take IDLE, or the connection drops while it waits', async () => {
    server = await fakeImap([]);
    const login = { username: 'me@example.com', password: 'app-pass' };
    const c = await ImapClient.open({ host: '127.0.0.1', port: server.port, security: 'none' }, login);
    await expect(c.idle(() => undefined, new Promise(() => undefined))).rejects.toThrow('unknown command');
    c.close();
    server.idle = true;
    const d = await ImapClient.open({ host: '127.0.0.1', port: server.port, security: 'none' }, login);
    const waiting = d.idle(() => undefined, new Promise(() => undefined));
    await vi.waitFor(() => expect(server!.idling).toBe(1));
    server.drop();
    await expect(waiting).rejects.toThrow();
  });
});

describe('the IDLE connections of automations that wait for new mail', () => {
  const start = (o: { watching: () => { conversationId: string; trigger: typeof inbox }[]; check: (id: string) => Promise<void> }) => {
    watcher = new IdleWatcher({
      connectors: accounts(server!.port),
      ...o,
      settleMs: 20,
      backoffMs: [20],
      renewMs: 60_000,
      timeoutMs: 2000,
    });
    watcher.sync();
    return watcher;
  };

  it('checks an automation when its server says mail arrived: once for mail together, again for mail during a check', async () => {
    const messages = [mail(1)];
    server = await fakeImap(messages);
    server.idle = true;
    const checks: string[] = [];
    let release: (() => void) | undefined;
    const w = start({
      watching: () => [{ conversationId: 'c1', trigger: inbox }],
      check: async (id) => {
        checks.push(id);
        if (checks.length === 2) await new Promise<void>((r) => (release = r));
      },
    });
    await vi.waitFor(() => expect(w.live('c1')).toBe(true));
    expect(server.idling).toBe(1);
    // Two in a row: one check.
    messages.push(mail(2), mail(3));
    server.notify();
    server.notify();
    await vi.waitFor(() => expect(checks).toEqual(['c1']));
    await new Promise((r) => setTimeout(r, 60));
    expect(checks).toEqual(['c1']);
    // During a check under way, another one after it.
    server.notify();
    await vi.waitFor(() => expect(checks).toHaveLength(2));
    server.notify();
    await new Promise((r) => setTimeout(r, 60));
    expect(checks).toHaveLength(2);
    release!();
    await vi.waitFor(() => expect(checks).toHaveLength(3));
  });

  it('opens a dropped connection again, and renews IDLE before the server would end it', async () => {
    server = await fakeImap([mail(1)]);
    server.idle = true;
    watcher = new IdleWatcher({
      connectors: accounts(server.port),
      watching: () => [{ conversationId: 'c1', trigger: inbox }],
      check: async () => undefined,
      settleMs: 20,
      backoffMs: [20],
      renewMs: 80,
      timeoutMs: 2000,
    });
    watcher.sync();
    await vi.waitFor(() => expect(server!.idling).toBe(1));
    // Renewed: DONE, then IDLE again on the same connection.
    await vi.waitFor(() => expect(server!.commands.filter((c) => c === 'DONE').length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(server!.commands.filter((c) => / IDLE$/.test(c)).length).toBeGreaterThan(1));
    const logins = () => server!.commands.filter((c) => / LOGIN /.test(c)).length;
    const before = logins();
    server.drop();
    await vi.waitFor(() => expect(logins()).toBeGreaterThan(before));
    await vi.waitFor(() => expect(server!.idling).toBe(1));
    expect(watcher.live('c1')).toBe(true);
  });

  it('leaves a server without IDLE to the checks, and closes or replaces a connection when its automation changes', async () => {
    server = await fakeImap([]);
    let wanted = [{ conversationId: 'c1', trigger: inbox }];
    const w = start({ watching: () => wanted, check: async () => undefined });
    await vi.waitFor(() => expect(w.unsupported('c1')).toBe(true));
    expect(w.live('c1')).toBe(false);
    expect(server.commands.some((c) => / IDLE$/.test(c))).toBe(false);

    // Turned off: closed. Another folder: a new connection there.
    await w.stop();
    server.idle = true;
    const v = start({ watching: () => wanted, check: async () => undefined });
    await vi.waitFor(() => expect(server!.idling).toBe(1));
    wanted = [];
    v.sync();
    await vi.waitFor(() => expect(server!.idling).toBe(0));
    expect(v.live('c1')).toBe(false);
    wanted = [{ conversationId: 'c1', trigger: { ...inbox, folder: 'inbox' } }];
    v.sync();
    await vi.waitFor(() => expect(v.live('c1')).toBe(true));
  });

  it('checks more slowly while it listens', () => {
    expect(nextCheckAt(0, 0, true)).toBe(WATCH_LIMITS.idleCheckMinutes * 60_000);
    expect(nextCheckAt(0, 0, false)).toBe(WATCH_LIMITS.checkMinutes * 60_000);
    // Failing checks still back off as before.
    expect(nextCheckAt(0, 1, true)).toBe(WATCH_LIMITS.backoffMinutes[0]! * 60_000);
  });
});
