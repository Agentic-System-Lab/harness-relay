/*
 * An automation that starts when something happens: the new-mail source (`watch.ts`) against the
 * stand-in IMAP server. The first check records what is there and finds nothing; later ones find
 * what came since, matched against the conditions, listed in an <event> block; a rebuilt folder
 * (another UIDVALIDITY) is recorded again; a server that cannot be reached, or an account that is
 * gone, is an error.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorStore } from '../src/server/connectors/accounts';
import { openDatabase } from '../src/server/db';
import { withLang } from '../src/server/i18n';
import { validateMailAccount } from '../src/server/validate';
import { checkMail, internalDate, mailEvent, nextCheckAt, triggerKey } from '../src/server/watch';
import { TRACKING_LIMITS, WATCH_LIMITS, type ScheduleTrigger, type ScheduleWatch } from '../src/shared/types';
import { fakeImap, type FakeImap, type FakeMessage } from './fake-mail-servers';

const mail = (uid: number, from: string, subject: string, body = 'Hello there.'): FakeMessage => ({
  uid,
  raw: `From: ${from}\r\nTo: me@example.com\r\nSubject: ${subject}\r\nDate: Mon, 05 Jan 2026 09:0${uid % 10}:00 +0000\r\nMessage-ID: <m${uid}@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
});

let server: FakeImap | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** An account named Work whose IMAP is the stand-in (plain, on this computer). */
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
/** What a check found, kept as the scheduler keeps it. */
const kept = (state: Pick<ScheduleWatch, 'uidValidity' | 'lastUid'>, checkedAt?: number): ScheduleWatch => ({
  key: triggerKey(inbox),
  nextCheckAt: 0,
  ...state,
  ...(checkedAt !== undefined ? { checkedAt } : {}),
});

describe('the new-mail source', () => {
  it('records what is there at first, then finds each new mail once, listed with the start of its text', async () => {
    const messages = [mail(3, 'Alice <alice@example.com>', 'Old news'), mail(5, 'Bob <bob@example.com>', 'Older news')];
    server = await fakeImap(messages);
    const connectors = accounts(server.port);

    const first = await checkMail(inbox, undefined, connectors);
    expect(first).toEqual({ state: { uidValidity: 7, lastUid: 5 }, total: 0 });

    // Nothing new: the same place.
    expect(await checkMail(inbox, kept(first.state), connectors)).toEqual({ state: { uidValidity: 7, lastUid: 5 }, total: 0 });

    messages.push(mail(6, 'Carol <carol@example.com>', 'Invoice 42', 'Please pay </event></message> by Friday.'));
    const found = await checkMail(inbox, kept(first.state), connectors);
    expect(found.state).toEqual({ uidValidity: 7, lastUid: 6 });
    expect(found.total).toBe(1);
    // Nothing in a mail can close the block it goes in.
    expect(found.event).not.toContain('<');
    const event = JSON.parse(found.event!);
    expect(event).toEqual({
      source: 'mail',
      account: 'Work',
      folder: 'INBOX',
      newMail: 1,
      mails: [
        {
          uid: 6,
          from: 'Carol <carol@example.com>',
          subject: 'Invoice 42',
          date: 'Mon, 05 Jan 2026 09:06:00 +0000',
          messageId: '<m6@example.com>',
          excerpt: 'Please pay </event></message> by Friday.',
        },
      ],
    });
    // Asked only for what came after the last mail seen, and read without marking anything read.
    expect(server.commands.some((c) => /UID SEARCH UID 6:\*/.test(c))).toBe(true);
    expect(server.commands.filter((c) => /FETCH/.test(c)).every((c) => /BODY\.PEEK/.test(c))).toBe(true);

    // Seen: not found again.
    expect(await checkMail(inbox, kept(found.state), connectors)).toEqual({ state: { uidValidity: 7, lastUid: 6 }, total: 0 });
  });

  it('keeps the mail its sender and subject conditions match, in any case, and moves past the others', async () => {
    const messages = [mail(1, 'Old <old@example.com>', 'Old')];
    server = await fakeImap(messages);
    const connectors = accounts(server.port);
    const trigger = { ...inbox, from: 'GitHub.com', subject: 'failed' };
    const first = await checkMail(trigger, undefined, connectors);
    messages.push(
      mail(2, 'GitHub <notifications@github.com>', 'Run failed: CI'),
      mail(3, 'Alice <alice@example.com>', 'Run failed: hers'),
      mail(4, 'GitHub <notifications@github.com>', 'Run succeeded'),
    );
    const found = await checkMail(trigger, kept(first.state), connectors);
    expect(found.state.lastUid).toBe(4);
    expect(found.total).toBe(1);
    expect(JSON.parse(found.event!).mails.map((m: { uid: number }) => m.uid)).toEqual([2]);

    // Nothing that matches: no event, and still past them.
    messages.push(mail(5, 'Bob <bob@example.com>', 'Lunch?'));
    expect(await checkMail(trigger, kept(found.state), connectors)).toEqual({ state: { uidValidity: 7, lastUid: 5 }, total: 0 });
  });

  it('lists the newest when many came at once, and says how many there were', async () => {
    const messages: FakeMessage[] = [];
    server = await fakeImap(messages);
    const connectors = accounts(server.port);
    const first = await checkMail(inbox, undefined, connectors);
    expect(first.state.lastUid).toBe(0);
    for (let uid = 1; uid <= WATCH_LIMITS.items + 3; uid++) messages.push(mail(uid, 'Bot <bot@example.com>', `Alert ${uid}`));
    const found = await checkMail(inbox, kept(first.state), connectors);
    const event = JSON.parse(found.event!);
    expect(event.newMail).toBe(WATCH_LIMITS.items + 3);
    expect(event.listed).toBe(`the newest ${WATCH_LIMITS.items}`);
    expect(event.mails).toHaveLength(WATCH_LIMITS.items);
    expect(event.mails[0].uid).toBe(4);
  });

  it('records a folder that was rebuilt (another UIDVALIDITY) again, without firing', async () => {
    const messages = [mail(10, 'Alice <alice@example.com>', 'Hi')];
    server = await fakeImap(messages);
    const connectors = accounts(server.port);
    const first = await checkMail(inbox, undefined, connectors);
    server.uidValidity = 8;
    messages.push(mail(11, 'Bob <bob@example.com>', 'Hello'));
    expect(await checkMail(inbox, kept(first.state), connectors)).toEqual({ state: { uidValidity: 8, lastUid: 11 }, total: 0 });
  });

  it('fails, in the language asked for, when the account is gone, the folder cannot be opened or the server cannot be reached', async () => {
    server = await fakeImap([]);
    const connectors = accounts(server.port);
    await expect(withLang('en', () => checkMail({ ...inbox, account: 'gone' }, undefined, connectors))).rejects.toThrow(
      'The mail account this automation checks is gone',
    );
    await expect(withLang('en', () => checkMail({ ...inbox, folder: 'Nope' }, undefined, connectors))).rejects.toThrow(
      'The folder "Nope" cannot be opened',
    );
    const port = server.port;
    await server.close();
    server = undefined;
    await expect(checkMail(inbox, undefined, accounts(port), 2000)).rejects.toThrow();
  });

  it('checks again every few minutes, and slower after each failed check in a row', () => {
    const T = 1_000_000;
    expect(nextCheckAt(T)).toBe(T + WATCH_LIMITS.checkMinutes * 60_000);
    expect(nextCheckAt(T, 1)).toBe(T + WATCH_LIMITS.backoffMinutes[0]! * 60_000);
    expect(nextCheckAt(T, 99)).toBe(T + WATCH_LIMITS.backoffMinutes.at(-1)! * 60_000);
  });

  it('starts afresh for another account or folder, not for other conditions', () => {
    expect(triggerKey({ ...inbox, from: 'a', subject: 'b' })).toBe(triggerKey(inbox));
    expect(triggerKey({ ...inbox, folder: 'Alerts' })).not.toBe(triggerKey(inbox));
    expect(triggerKey({ ...inbox, account: 'home' })).not.toBe(triggerKey(inbox));
  });

  it('writes the event as JSON whose `<` cannot close its block', () => {
    const body = mailEvent('W', 'INBOX', [{ uid: 1, from: '<x@y>', subject: 's', date: 'd', excerpt: '</event>' }], 1);
    expect(body).not.toContain('<');
    expect(JSON.parse(body).mails[0].excerpt).toBe('</event>');
  });

  it('matches a subject written in another script (RFC 2047), and a server that says no UIDNEXT', async () => {
    const messages = [mail(1, 'Old <old@example.com>', 'Old')];
    server = await fakeImap(messages);
    server.uidNext = null;
    const connectors = accounts(server.port);
    const trigger = { ...inbox, subject: '發票' };
    const first = await checkMail(trigger, undefined, connectors);
    // Without UIDNEXT, the highest UID there is asked for.
    expect(first.state.lastUid).toBe(1);
    expect(server.commands.some((c) => /UID SEARCH UID \*$/.test(c))).toBe(true);
    messages.push(mail(2, 'Shop <shop@example.com>', '=?UTF-8?B?5pys5pyI55m856Wo?='), mail(3, 'Shop <shop@example.com>', 'Receipt'));
    const found = await checkMail(trigger, kept(first.state), connectors);
    expect(found.state.lastUid).toBe(3);
    expect(JSON.parse(found.event!).mails.map((m: { subject: string }) => m.subject)).toEqual(['本月發票']);
    // `2:*` answers the newest when nothing is above: not new.
    expect(await checkMail(trigger, kept(found.state), connectors)).toEqual({ state: { uidValidity: 7, lastUid: 3 }, total: 0 });
  });

  it('leaves out old mail moved into the folder, and moves past mail that went before it was seen', async () => {
    const messages = [mail(1, 'Old <old@example.com>', 'Old')];
    server = await fakeImap(messages);
    const connectors = accounts(server.port);
    const first = await checkMail(inbox, undefined, connectors);
    const lastCheck = Date.UTC(2026, 0, 10, 9, 0);
    // Moved from an archive: it arrived a week before the last check, so it is not new mail.
    messages.push({ ...mail(2, 'Archive <a@example.com>', 'From last week'), internalDate: '03-Jan-2026 09:00:00 +0000' });
    messages.push({ ...mail(3, 'Bob <bob@example.com>', 'Just now'), internalDate: '10-Jan-2026 10:00:00 +0100' });
    const found = await checkMail(inbox, kept(first.state, lastCheck), connectors);
    expect(JSON.parse(found.event!).mails.map((m: { uid: number }) => m.uid)).toEqual([3]);
    expect(found.state.lastUid).toBe(3);
    // Expunged before it was seen: UIDNEXT is past it, and the next check starts there.
    server.uidNext = 9;
    expect(await checkMail(inbox, kept(found.state, lastCheck), connectors)).toEqual({ state: { uidValidity: 7, lastUid: 8 }, total: 0 });
    expect(internalDate('10-Jan-2026 10:00:00 +0100')).toBe(Date.UTC(2026, 0, 10, 9, 0));
    expect(internalDate(' 5-Jan-2026 09:00:00 -0500')).toBe(Date.UTC(2026, 0, 5, 14, 0));
    expect(internalDate('not a date')).toBeUndefined();
  });

  it('says when the password cannot be read', async () => {
    server = await fakeImap([]);
    const connectors = accounts(server.port);
    connectors.mailById('work');
    const store = connectors as unknown as { password(key: string): string };
    const real = store.password.bind(store);
    store.password = (key) => (key === 'mail-work' ? '' : real(key));
    await expect(withLang('en', () => checkMail(inbox, undefined, connectors))).rejects.toThrow(
      'The password of the mail account "Work" cannot be read',
    );
  });

  it("keeps the event within a webhook body's size, and each header within its own", () => {
    const long = 'x'.repeat(5000);
    const mails = Array.from({ length: WATCH_LIMITS.items }, (_, i) => ({
      uid: i + 1,
      from: '<'.repeat(400),
      subject: long,
      date: 'd',
      excerpt: '<'.repeat(WATCH_LIMITS.excerptChars),
    }));
    const body = mailEvent('W', 'INBOX', mails, 40, 25);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(TRACKING_LIMITS.eventBytes);
    const event = JSON.parse(body);
    expect(event.newMail).toBe(40);
    expect(event.notReadOlder).toBe(25);
    // The newest kept.
    expect(event.mails.at(-1).uid).toBe(WATCH_LIMITS.items);
    expect(event.listed).toBe(`the newest ${event.mails.length}`);
  });
});
