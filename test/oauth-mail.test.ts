/*
 * Mail over OAuth (`connectors/mailLogin.ts`, and mail in `src/server/oauth/`): Microsoft 365,
 * Outlook.com and Gmail mail accounts reached through an account that signs in with OAuth, against the
 * stand-in OAuth server (`fake-oauth-server.ts`: Microsoft's tokens each for one resource, Google's
 * incremental consent) and stand-in IMAP and SMTP servers that take SASL XOAUTH2
 * (`fake-mail-servers.ts`): XOAUTH2 in both clients and the servers' refusals, as Gmail and Microsoft
 * word them; a Microsoft token for each use from one refresh token (rotation shared, one refresh at a
 * time); a sign-in for mail and its scopes checked (Microsoft's mail token at once, Gmail unticked,
 * Google's include_granted_scopes keeping the calendar's, or a sign-in refused that lost it); no token
 * asked for a use not signed in for; the mail tools, the mail trigger and IDLE with a token, a refused
 * one renewed once, an account that needs a new sign-in an error before any server is asked; the token
 * never in the clear but to this computer; the mail account's fixed servers (409); and the HTTP API.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_KEY_HEADER } from '../src/shared/auth';
import type { ConnectorsView, OAuthProviderId, OAuthSignInView, OAuthUse, OAuthView, OutboxItem } from '../src/shared/types';
import { fakeImap, fakeSmtp, type FakeImap, type FakeMessage, type FakeSmtp } from './fake-mail-servers';
import { fakeOAuth, type FakeOAuth } from './fake-oauth-server';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-oauth-mail-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { AuthStore, CODE_TTL_MS } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { ConnectorStore } = await import('../src/server/connectors/accounts');
const { ImapClient, ImapLoginError, xoauth2 } = await import('../src/server/connectors/imap');
const { MailSignInError, mailLogin } = await import('../src/server/connectors/mailLogin');
const { SmtpLoginError, sendMail } = await import('../src/server/connectors/smtp');
const { testMail } = await import('../src/server/connectors/test');
const { connectorTools } = await import('../src/server/connectors/tools');
const { openDatabase } = await import('../src/server/db');
const { Hub } = await import('../src/server/hub');
const { withLang } = await import('../src/server/i18n');
const { IdleWatcher } = await import('../src/server/idle');
const { googleProvider, microsoftProvider } = await import('../src/server/oauth/providers');
const { OAuthService } = await import('../src/server/oauth/service');
const { callbackParams } = await import('../src/server/oauth/signin');
const { OAuthStore } = await import('../src/server/oauth/store');
const { Orchestrator } = await import('../src/server/orchestrator');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { checkMail, checkTrigger, triggerKey } = await import('../src/server/watch');
type GatewayContext = import('../src/server/gateway').GatewayContext;
type GatewayTool = import('../src/server/gateway').GatewayTool;

/** A fake credential store, as the tests of the other secrets use. */
function fakeKeyring() {
  const values = new Map<string, string>();
  return {
    storage: 'keychain' as const,
    values,
    get: (n: string) => values.get(n) ?? null,
    set: (n: string, v: string) => void values.set(n, v),
    delete: (n: string) => void values.delete(n),
  };
}

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 8, 0);
const OUTLOOK = 'https://outlook.office.com';
const GMAIL = 'https://mail.google.com/';
const CALENDAR = 'https://www.googleapis.com/auth/calendar';
const ctx = {
  convId: 'c',
  agentId: 'a',
  agentName: 'Alice',
  messageId: 'm',
  cwd: '/tmp',
  permission: 'edit',
  unattended: false,
  signal: new AbortController().signal,
} as GatewayContext;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const local = (port: number) => ({ host: '127.0.0.1', port, security: 'none' as const });
const message = (uid: number, from: string, subject: string): FakeMessage => ({
  uid,
  raw: `From: ${from}\r\nTo: ming@contoso.com\r\nSubject: ${subject}\r\nDate: Mon, 05 Jan 2026 09:0${uid}:00 +0000\r\nMessage-ID: <m${uid}@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from ${from}.\r\n`,
});

let fake: FakeOAuth;
let now = T0;
let db: ReturnType<typeof openDatabase>;
let keyring: ReturnType<typeof fakeKeyring>;
let connectors: InstanceType<typeof ConnectorStore>;
let service: InstanceType<typeof OAuthService>;
let messages: FakeMessage[];
/** Microsoft's stand-in mail servers (Exchange Online's token only), and Gmail's (a Google token with Gmail's scope). */
let imap: FakeImap;
let smtp: FakeSmtp;
let gmailImap: FakeImap;
let gmailSmtp: FakeSmtp;
/** While set, Microsoft's mail servers refuse every token (IMAP or SMTP AUTH turned off for the mailbox). */
let refuseAll: boolean;
let over: { yes: boolean };
const closers: (() => Promise<unknown>)[] = [];

/** Exchange Online's IMAP and SMTP take a good token for its own resource, for the account's address. */
const outlookToken = (user: string, token: string) =>
  !refuseAll && user === 'ming@contoso.com' && fake.accessTokens.get(token) === true && fake.resources.get(token) === 'outlook';
/** Gmail's take a good Google token that carries Gmail's scope. */
const gmailToken = (user: string, token: string) =>
  user === 'ming@gmail.com' && fake.accessTokens.get(token) === true && (fake.scopesOf.get(token) ?? []).includes(GMAIL);

function newService(store = new OAuthStore(db, keyring), on = connectors) {
  const ended = over;
  return new OAuthService(store, on, {
    provider: (id, client) =>
      id === 'microsoft'
        ? microsoftProvider(client, { login: fake.url, graph: fake.url, mail: { imap: local(imap.port), smtp: local(smtp.port) } })
        : googleProvider(client, fake.google.urls, { imap: local(gmailImap.port), smtp: local(gmailSmtp.port) }),
    now: () => (ended.yes ? Number.MAX_SAFE_INTEGER : now),
    pollMs: () => 20,
  });
}

beforeEach(async () => {
  fake = await fakeOAuth();
  now = T0;
  refuseAll = false;
  over = { yes: false };
  messages = [message(1, 'Bob <bob@example.com>', 'Invoice 42'), message(2, 'Carol <carol@example.com>', 'Lunch?')];
  imap = await fakeImap(messages, undefined, { bearer: outlookToken, refusal: 'microsoft' });
  smtp = await fakeSmtp(undefined, { bearer: outlookToken, refusal: 'microsoft' });
  gmailImap = await fakeImap(messages, undefined, { bearer: gmailToken });
  gmailSmtp = await fakeSmtp(undefined, { bearer: gmailToken });
  db = openDatabase(':memory:');
  keyring = fakeKeyring();
  connectors = new ConnectorStore(db, keyring);
  const store = new OAuthStore(db, keyring);
  store.saveClient('microsoft', { clientId: fake.clientId });
  service = newService(store);
});
afterEach(async () => {
  over.yes = true;
  for (const close of closers.splice(0).reverse()) await close();
  await Promise.all([fake.close(), imap.close(), smtp.close(), gmailImap.close(), gmailSmtp.close()]);
  vi.restoreAllMocks();
});

/** A sign-in for these uses, all the way, as the browser that started it would do it; and how it started. */
async function signInFull(
  uses: OAuthUse[],
  provider: OAuthProviderId = 'microsoft',
): Promise<{ started: OAuthSignInView; done: OAuthSignInView }> {
  if (provider === 'google') service.saveClient('google', { clientId: fake.google.clientId, secret: fake.google.secret });
  const started = await service.startSignIn({ provider, uses, session: 's1', origin: 'http://127.0.0.1:8787', port: 8787 });
  return { started, done: await service.signIns.callback(callbackParams(fake.allow(started.authorizeUrl!))) };
}
const signIn = async (uses: OAuthUse[] = ['mail'], provider: OAuthProviderId = 'microsoft') => (await signInFull(uses, provider)).done;
/** The token requests of a grant (Microsoft's endpoint, or Google's). */
const grants = (grant: string, path = '/oauth2/v2.0/token') =>
  fake.requests.filter((r) => r.path.endsWith(path) && new URLSearchParams(r.body).get('grant_type') === grant);
const tools = () => Object.fromEntries(connectorTools(connectors, service).map((t) => [t.name, t])) as Record<string, GatewayTool>;
const invalidGrant = { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS50173: The grant was revoked' } };

describe('XOAUTH2 in the IMAP and SMTP clients', () => {
  it('signs in with the user and token in one base64 line, and says why a token was refused, as Gmail and Microsoft word it', () =>
    withLang('en', async () => {
      const good = (user: string, token: string) => user === 'me@example.com' && token === 'good-token';
      const asGmail = await fakeImap([], undefined, { bearer: good });
      const asMicrosoft = await fakeImap([], undefined, { bearer: good, refusal: 'microsoft' });
      const gmailSend = await fakeSmtp(undefined, { bearer: good });
      const microsoftSend = await fakeSmtp(undefined, { bearer: good, refusal: 'microsoft' });
      closers.push(asGmail.close, asMicrosoft.close, gmailSend.close, microsoftSend.close);
      const user = 'me@example.com';

      const c = await ImapClient.open(local(asGmail.port), { username: user, token: 'good-token' }, 2000);
      const at = asGmail.commands.indexOf('R1 AUTHENTICATE XOAUTH2');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(Buffer.from(asGmail.commands[at + 1]!, 'base64').toString()).toBe('user=me@example.com\x01auth=Bearer good-token\x01\x01');
      expect(asGmail.commands.some((x) => / LOGIN /.test(x))).toBe(false);
      expect(c.capabilities.has('IMAP4REV1')).toBe(true);
      await c.logout();

      // Gmail says why in a continuation first, answered with an empty line, then NO; Microsoft says NO at once.
      const refused = ImapClient.open(local(asGmail.port), { username: user, token: 'stale' }, 2000);
      await expect(refused).rejects.toBeInstanceOf(ImapLoginError);
      await expect(refused).rejects.toThrow(
        "The mail server did not accept the sign-in's token: [AUTHENTICATIONFAILED] Invalid credentials (Failure) (status 400)",
      );
      expect(asGmail.commands.at(-1)).toBe('');
      await expect(ImapClient.open(local(asMicrosoft.port), { username: user, token: 'stale' }, 2000)).rejects.toThrow(
        "The mail server did not accept the sign-in's token: AUTHENTICATE failed.",
      );

      const envelope = { from: user, recipients: ['bob@example.com'] };
      expect(await sendMail(local(gmailSend.port), { username: user, token: 'good-token' }, envelope, 'Subject: hi\r\n\r\nHello')).toBe(
        'OK queued as FAKE123',
      );
      expect(gmailSend.lines).toContain(`AUTH XOAUTH2 ${xoauth2(user, 'good-token')}`);
      expect(gmailSend.sent).toHaveLength(1);
      const notSent = sendMail(local(gmailSend.port), { username: user, token: 'stale' }, envelope, 'x');
      await expect(notSent).rejects.toBeInstanceOf(SmtpLoginError);
      await expect(notSent).rejects.toThrow(
        /^The mail server did not accept the sign-in's token: 535 5\.7\.8 Username and Password not accepted\. .* \(status 400\)$/,
      );
      expect(gmailSend.lines.at(-1)).toBe('');
      await expect(sendMail(local(microsoftSend.port), { username: user, token: 'stale' }, envelope, 'x')).rejects.toThrow(
        "The mail server did not accept the sign-in's token: 535 5.7.3 Authentication unsuccessful [FAKE.prod.outlook.com]",
      );
      // A password refused is a refused sign-in too; neither sent anything.
      await expect(sendMail(local(gmailSend.port), { username: user, password: 'nope' }, envelope, 'x')).rejects.toBeInstanceOf(
        SmtpLoginError,
      );
      expect(gmailSend.sent).toHaveLength(1);
      expect(microsoftSend.sent).toHaveLength(0);
      // Nothing that would end the line or the user's part goes to the server.
      for (const [u, tok] of [
        ['me@example.com\r\nA1 LOGOUT', 'x'],
        ['me\x01auth=Bearer other', 'x'],
        ['me@example.com', 'a b'],
      ])
        expect(() => xoauth2(u!, tok!)).toThrow('A line break cannot be sent');
    }));
});

describe('a Microsoft sign-in for mail', () => {
  it("asks the code exchange for Graph's token and mail's at once with the refresh token, and adds the mail account at Microsoft's servers", async () => {
    const { started, done } = await signInFull(['calendar', 'mail']);
    expect(done).toMatchObject({ status: 'done', account: { email: 'ming@contoso.com', uses: ['calendar', 'mail'], status: 'connected' } });
    const id = done.account!.id;
    // The sign-in page asks for both resources' scopes, Graph's first.
    expect(new URL(started.authorizeUrl!).searchParams.get('scope')!.split(' ')).toEqual([
      'openid',
      'email',
      'profile',
      'offline_access',
      `${fake.url}/User.Read`,
      `${fake.url}/Calendars.ReadWrite`,
      `${OUTLOOK}/IMAP.AccessAsUser.All`,
      `${OUTLOOK}/SMTP.Send`,
    ]);
    // The code exchange names Graph's (to ask who signed in); mail's token comes from the refresh token at once.
    const exchange = new URLSearchParams(grants('authorization_code')[0]!.body);
    expect(exchange.get('scope')).toBe(`openid email profile offline_access ${fake.url}/User.Read ${fake.url}/Calendars.ReadWrite`);
    expect(grants('refresh_token').map((r) => new URLSearchParams(r.body).get('scope'))).toEqual([
      `openid email profile offline_access ${OUTLOOK}/IMAP.AccessAsUser.All ${OUTLOOK}/SMTP.Send`,
    ]);
    // The refresh token that refresh rotated is the one kept.
    expect(fake.refreshTokens.get(keyring.values.get(`oauth-${id}`)!)).toBe(true);
    expect(connectors.view().mail).toEqual([
      {
        id,
        name: 'Outlook · ming@contoso.com',
        address: 'ming@contoso.com',
        username: 'ming@contoso.com',
        imap: local(imap.port),
        smtp: local(smtp.port),
        oauth: id,
        password: '',
      },
    ]);
    expect(connectors.view().calendar.map((c) => c.oauth)).toEqual([id]);

    // A token for each use, both from the sign-in: nothing refreshed yet.
    const requests = fake.requests.length;
    const calendarToken = await service.broker.accessToken(id, 'calendar');
    const mailToken = await service.mailToken(id);
    expect(fake.requests).toHaveLength(requests);
    expect([fake.resources.get(calendarToken), fake.resources.get(mailToken)]).toEqual(['graph', 'outlook']);

    // Both about to expire: each refreshed with its own scopes, one after the other, the second sending
    // the refresh token the first rotated.
    now += 59 * MIN;
    const before = grants('refresh_token').length;
    const [calendar, mail] = await Promise.all([service.broker.accessToken(id, 'calendar'), service.mailToken(id)]);
    const [first, second] = grants('refresh_token')
      .slice(before)
      .map((r) => new URLSearchParams(r.body));
    expect(grants('refresh_token')).toHaveLength(before + 2);
    expect(first!.get('scope')).toContain('Calendars.ReadWrite');
    expect(first!.get('scope')).not.toContain('IMAP');
    expect(second!.get('scope')).toContain('IMAP.AccessAsUser.All');
    expect(second!.get('refresh_token')).not.toBe(first!.get('refresh_token'));
    expect([fake.resources.get(calendar), fake.resources.get(mail)]).toEqual(['graph', 'outlook']);
    expect(service.view().accounts[0]!.status).toBe('connected');
    expect(fake.refreshTokens.get(keyring.values.get(`oauth-${id}`)!)).toBe(true);
    // Graph takes its own token, never mail's.
    expect((await service.broker.fetch(id, 'calendar')(`${fake.url}/v1.0/me`)).status).toBe(200);
  });

  it("fails a sign-in whose token for mail is refused or does not carry mail's scopes, and keeps nothing", () =>
    withLang('en', async () => {
      const kept = () => [...keyring.values.keys()].filter((k) => k.startsWith('oauth-microsoft'));
      fake.refreshScope = () => `${OUTLOOK}/SMTP.Send`;
      expect(await signIn(['mail'])).toMatchObject({
        status: 'failed',
        error: 'Microsoft did not give access to mail: sign in again, and allow access to your mail on the sign-in page',
      });
      fake.refreshScope = undefined;
      fake.refreshAnswer = {
        status: 400,
        body: {
          error: 'invalid_grant',
          error_description: 'AADSTS65001: The user or administrator has not consented to use the application.',
        },
      };
      expect((await signIn(['mail'])).error).toBe(
        'Microsoft did not give access to mail: sign in again, and allow access to your mail on the sign-in page (invalid_grant: AADSTS65001: The user or administrator has not consented to use the application.)',
      );
      fake.refreshAnswer = undefined;
      expect(service.view().accounts).toEqual([]);
      expect(connectors.view().mail).toEqual([]);
      expect(kept()).toEqual([]);
    }));

  it('adds mail to an account signed in for the calendar, with a sign-in for mail alone, the calendar’s consent kept', async () => {
    const calendarOnly = (await signIn(['calendar'])).account!;
    expect(calendarOnly.uses).toEqual(['calendar']);
    expect(connectors.view().mail).toEqual([]);
    const both = (await signIn(['mail'])).account!;
    expect(both).toMatchObject({ id: calendarOnly.id, uses: ['calendar', 'mail'] });
    expect(connectors.view().calendar).toHaveLength(1);
    expect(connectors.view().mail).toHaveLength(1);
    // The new refresh token still reaches the calendar (Microsoft keeps what was consented).
    now += 61 * MIN;
    expect((await service.broker.fetch(both.id, 'calendar')(`${fake.url}/v1.0/me`)).status).toBe(200);
    expect(service.view().accounts[0]!.status).toBe('connected');
  });

  it('never asks a token for a use the account was not signed in for, nor marks it as needing a new sign-in for that', () =>
    withLang('en', async () => {
      const id = (await signIn(['mail'])).account!.id;
      const refreshes = grants('refresh_token').length;
      await expect(service.broker.accessToken(id, 'calendar')).rejects.toThrow(
        'ming@contoso.com was not signed in for calendars: click Use for calendars for it in Settings → Tool library first',
      );
      await expect(service.calendars(id)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not signed in for calendars'),
      });
      expect(() => service.addCalendar(id, { name: 'Cal', url: `${fake.url}/v1.0/me/calendar` })).toThrow('not signed in for calendars');
      expect(grants('refresh_token')).toHaveLength(refreshes);
      expect(service.view().accounts[0]!.status).toBe('connected');
      expect(connectors.view().calendar).toEqual([]);
    }));
});

describe('the mail tools through a sign-in', () => {
  it('searches, reads and drafts over IMAP, and sends through the outbox over SMTP, all with XOAUTH2 and the token for mail', () =>
    withLang('en', async () => {
      const id = (await signIn(['mail'])).account!.id;
      const t = tools();
      expect(t.mail_search!.unavailable!()).toBeUndefined();
      expect((await t.mail_search!.run!({ query: 'invoice' }, ctx)).text).toContain('Bob <bob@example.com> · Invoice 42');
      expect((await t.mail_read!.run!({ uid: 2 }, ctx)).text).toContain('Hello from Carol <carol@example.com>.');
      await t.mail_draft!.run!({ to: 'bob@example.com', subject: 'Re: Invoice 42', body: 'Paid.' }, ctx);
      expect(imap.appended[0]!.folder).toBe('Drafts');
      expect(imap.appended[0]!.raw).toContain('From: ming@contoso.com');
      // Each connection signs in with Exchange Online's token, as the account, never with a password.
      expect(imap.xoauth2).toHaveLength(3);
      expect(imap.xoauth2.every((x) => x.ok && x.user === 'ming@contoso.com')).toBe(true);
      expect(imap.commands.some((c) => / LOGIN /.test(c))).toBe(false);

      // Sent only by the outbox's Send, from the account its card showed.
      const args = { to: 'bob@example.com', subject: 'Paid', body: 'Done.' };
      expect(t.mail_send!.describe(args).preview!.fields[0]).toEqual({ label: 'From', value: 'ming@contoso.com' });
      const bound = t.mail_send!.bind!(args);
      expect(bound.accountId).toBe(id);
      expect(smtp.sent).toEqual([]);
      expect(await t.mail_send!.send!(bound, {} as OutboxItem)).toContain('127.0.0.1');
      expect(smtp.sent).toHaveLength(1);
      expect(smtp.sent[0]).toMatchObject({ from: 'ming@contoso.com', to: ['bob@example.com'] });
      expect(smtp.xoauth2).toEqual([{ user: 'ming@contoso.com', token: expect.stringMatching(/^access-/), ok: true }]);

      // The tokens stay in the server's memory: not in what Settings shows, nor in the database.
      expect(JSON.stringify(connectors.view())).not.toMatch(/access-|refresh-/);
      const rows = db.prepare('SELECT value FROM app_settings').all() as { value: string }[];
      expect(rows.map((r) => r.value).join('')).not.toMatch(/access-|refresh-/);
    }));

  it('renews a token the mail server refuses once, says when the server refuses even a new one, and when the account needs a new sign-in', () =>
    withLang('en', async () => {
      const id = (await signIn(['mail'])).account!.id;
      const t = tools();
      // The token revoked early: refused, a new one asked for, and the sign-in tried again.
      fake.accessTokens.set(await service.mailToken(id), false);
      let before = grants('refresh_token').length;
      expect((await t.mail_search!.run!({}, ctx)).text).toContain('uid 1');
      expect(grants('refresh_token')).toHaveLength(before + 1);
      expect(imap.xoauth2.map((x) => x.ok)).toEqual([false, true]);
      // The same for SMTP, at Send: the refusal comes before anything is sent, so it goes once.
      fake.accessTokens.set(await service.mailToken(id), false);
      await t.mail_send!.send!({ to: 'bob@example.com', subject: 'x', body: 'y', accountId: id }, {} as OutboxItem);
      expect(smtp.xoauth2.map((x) => x.ok)).toEqual([false, true]);
      expect(smtp.sent).toHaveLength(1);

      // The server refuses even a new token (IMAP turned off for the mailbox): said, renewed once; still connected.
      refuseAll = true;
      before = grants('refresh_token').length;
      await expect(t.mail_search!.run!({}, ctx)).rejects.toThrow(
        "The mail server did not accept the sign-in's token: AUTHENTICATE failed.",
      );
      expect(grants('refresh_token')).toHaveLength(before + 1);
      expect(service.view().accounts[0]!.status).toBe('connected');
      refuseAll = false;

      // Its refresh refused for good: it needs a new sign-in, said before any mail server is asked.
      now += 61 * MIN;
      fake.refreshAnswer = invalidGrant;
      const logins = imap.xoauth2.length;
      await expect(t.mail_search!.run!({}, ctx)).rejects.toThrow('The sign-in of ming@contoso.com no longer works');
      expect(service.view().accounts[0]).toMatchObject({ status: 'reauth', error: expect.stringContaining('invalid_grant') });
      expect(t.mail_search!.unavailable!()).toMatch(/^The sign-in of ming@contoso.com no longer works/);
      await expect(testMail(connectors.mailById(id)!.account, '', service)).rejects.toBeInstanceOf(MailSignInError);
      await expect(t.mail_send!.send!({ to: 'bob@example.com', subject: 'x', body: 'y', accountId: id }, {} as OutboxItem)).rejects.toThrow(
        'no longer works',
      );
      expect(imap.xoauth2).toHaveLength(logins);
      expect(smtp.sent).toHaveLength(1);
      fake.refreshAnswer = undefined;
    }));

  it('sends a token only to its provider’s servers, never in the clear but to this computer, and needs the OAuth service', () =>
    withLang('en', async () => {
      const account = {
        id: 'work',
        name: 'Work',
        address: 'me@example.com',
        username: 'me@example.com',
        imap: { host: 'imap.example.com', port: 993, security: 'tls' as const },
        smtp: { host: 'smtp.example.com', port: 465, security: 'tls' as const },
        oauth: 'microsoft-me-abc123',
      };
      const via = (imapServer: { host: string; port: number; security: 'tls' | 'starttls' | 'none' }) => ({
        mailVia: () => ({
          imap: imapServer,
          smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' as const },
          username: 'me@example.com',
        }),
        mailToken: async () => 'token',
        problem: () => undefined,
        signInState: () => 'connected 1',
      });
      expect(() => mailLogin(account, '', via({ host: 'imap.example.com', port: 143, security: 'none' }))).toThrow(
        'The sign-in\'s token is not sent to "imap.example.com"',
      );
      // The provider's servers as it says them now, not those saved with the account.
      const m = mailLogin(account, '', via(local(imap.port)));
      expect(m.imap).toEqual(local(imap.port));
      expect(await m.login()).toEqual({ username: 'me@example.com', token: 'token' });
      expect(() => mailLogin(account, '')).toThrow(MailSignInError);
      // A password account without its password says so, before any server is asked.
      expect(() => mailLogin({ ...account, oauth: undefined }, '')).toThrow('The password of the mail account "Work" cannot be read');
    }));

  it('reads and sends Gmail with the Google token the calendar uses too', () =>
    withLang('en', async () => {
      const id = (await signIn(['mail'], 'google')).account!.id;
      expect(connectors.view().mail[0]).toMatchObject({
        id,
        name: 'Gmail · ming@gmail.com',
        username: 'ming@gmail.com',
        imap: local(gmailImap.port),
        smtp: local(gmailSmtp.port),
        oauth: id,
      });
      const t = tools();
      expect((await t.mail_search!.run!({}, ctx)).text).toContain('Lunch?');
      await t.mail_send!.send!({ to: 'bob@example.com', subject: 'Hi', body: 'Hello.', accountId: id }, {} as OutboxItem);
      expect(gmailImap.xoauth2.map((x) => [x.user, x.ok])).toEqual([['ming@gmail.com', true]]);
      expect(gmailSmtp.sent).toHaveLength(1);
      // Google refuses a stale token as Gmail does: renewed once, without asking for scopes (one token covers them).
      fake.accessTokens.set(await service.mailToken(id), false);
      await testMail(connectors.mailById(id)!.account, '', service);
      expect(gmailImap.xoauth2.map((x) => x.ok)).toEqual([true, false, true]);
      const refresh = new URLSearchParams(grants('refresh_token', '/google/token').at(-1)!.body);
      expect(refresh.has('scope')).toBe(false);
    }));
});

describe("Google's incremental consent for mail", () => {
  it("asks for Gmail's scope alone, keeping the calendar's granted before, and fails a sign-in that lost it or was not given Gmail's", () =>
    withLang('en', async () => {
      const calendarOnly = (await signIn(['calendar'], 'google')).account!;
      const { started, done } = await signInFull(['mail'], 'google');
      const q = new URL(started.authorizeUrl!).searchParams;
      expect(q.get('include_granted_scopes')).toBe('true');
      expect(q.get('scope')!.split(' ')).toEqual(['openid', 'email', 'profile', GMAIL]);
      expect(done.account).toMatchObject({ id: calendarOnly.id, uses: ['calendar', 'mail'], status: 'connected' });
      const id = calendarOnly.id;
      // One token for both uses: the sign-in's own, no refresh for mail.
      expect(grants('refresh_token', '/google/token')).toEqual([]);
      const token = await service.mailToken(id);
      expect(token).toBe(await service.broker.accessToken(id, 'calendar'));
      expect(fake.scopesOf.get(token)).toEqual(expect.arrayContaining([GMAIL, CALENDAR]));
      expect(connectors.view().calendar).toHaveLength(1);
      expect(connectors.view().mail).toHaveLength(1);

      // Gmail unticked on Google's page: refused.
      fake.grantScope = () => `openid ${CALENDAR}`;
      expect((await signIn(['mail'], 'google')).error).toBe(
        'Google did not give access to mail: sign in again, and allow access to your mail on the sign-in page',
      );
      fake.grantScope = undefined;
      // The calendar's access taken away at Google meanwhile: a sign-in for mail would leave the calendar
      // without it. Refused, and the account kept as it was.
      const kept = keyring.values.get(`oauth-${id}`);
      fake.google.granted.delete(CALENDAR);
      expect((await signIn(['mail'], 'google')).error).toBe(
        'Google did not give access to the calendar: sign in again, and allow access to your calendar on the sign-in page',
      );
      expect(keyring.values.get(`oauth-${id}`)).toBe(kept);
      expect(service.view().accounts[0]).toMatchObject({ uses: ['calendar', 'mail'], status: 'connected' });
    }));
});

describe('the mail trigger and IMAP IDLE through a sign-in', () => {
  it('checks for new mail with the token, as the scheduler does, and fails a check while the account needs a new sign-in', () =>
    withLang('en', async () => {
      const id = (await signIn(['mail'])).account!.id;
      const trigger = { source: 'mail' as const, account: id, folder: 'INBOX' };
      const first = await checkTrigger(connectors, service)(trigger, undefined, { cwd: root });
      expect(first).toEqual({ state: { uidValidity: 7, lastUid: 2 }, total: 0 });
      messages.push(message(3, 'Dan <dan@example.com>', 'Invoice 43'));
      const prev = { key: triggerKey(trigger), nextCheckAt: 0, ...first.state };
      const found = await checkMail(trigger, prev, connectors, 2000, service);
      expect(found.total).toBe(1);
      expect(JSON.parse(found.event!)).toMatchObject({ account: 'Outlook · ming@contoso.com', mails: [{ subject: 'Invoice 43' }] });
      expect(imap.xoauth2.every((x) => x.ok && x.user === 'ming@contoso.com')).toBe(true);

      now += 61 * MIN;
      fake.refreshAnswer = invalidGrant;
      await expect(checkMail(trigger, prev, connectors, 2000, service)).rejects.toThrow('The sign-in of ming@contoso.com no longer works');
      // Said again, from the account itself, without asking Microsoft.
      const asked = fake.requests.length;
      await expect(checkMail(trigger, prev, connectors, 2000, service)).rejects.toBeInstanceOf(MailSignInError);
      expect(fake.requests).toHaveLength(asked);
      fake.refreshAnswer = undefined;
    }));

  it('waits in IDLE with a token, takes a fresh one when it connects again, backs off while it needs a new sign-in, and connects at once when signed in again', async () => {
    imap.idle = true;
    const id = (await signIn(['mail'])).account!.id;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const watcher = new IdleWatcher({
      connectors,
      oauth: service,
      watching: () => [{ conversationId: 'c1', trigger: { source: 'mail', account: id, folder: 'INBOX' } }],
      check: async () => undefined,
      settleMs: 20,
      backoffMs: [20],
      loginBackoffMs: [60_000],
      renewMs: 60_000,
      timeoutMs: 2000,
    });
    closers.push(() => watcher.stop());
    watcher.sync();
    await vi.waitFor(() => expect(imap.idling).toBe(1));
    expect(imap.xoauth2).toEqual([{ user: 'ming@contoso.com', token: expect.stringMatching(/^access-/), ok: true }]);

    // The token ran out meanwhile, and the connection drops: the new one signs in with a fresh token.
    now += 61 * MIN;
    imap.drop();
    await vi.waitFor(() => expect(imap.xoauth2).toHaveLength(2));
    await vi.waitFor(() => expect(imap.idling).toBe(1));
    expect(imap.xoauth2[1]!.ok).toBe(true);
    expect(imap.xoauth2[1]!.token).not.toBe(imap.xoauth2[0]!.token);

    // Its refresh refused for good: the connection that drops is not opened again for as long as a refused password waits.
    now += 61 * MIN;
    fake.refreshAnswer = invalidGrant;
    imap.drop();
    await vi.waitFor(() => expect(service.view().accounts[0]!.status).toBe('reauth'));
    watcher.sync();
    await sleep(200);
    expect(imap.xoauth2).toHaveLength(2);
    expect(imap.idling).toBe(0);

    // Signed in again: the next sync connects at once.
    fake.refreshAnswer = undefined;
    now += MIN;
    await signIn(['mail']);
    watcher.sync();
    await vi.waitFor(() => expect(imap.idling).toBe(1));
    expect(imap.xoauth2).toHaveLength(3);
    expect(imap.xoauth2[2]!.ok).toBe(true);
  });
});

describe('/api: mail accounts that sign in', () => {
  async function signedInApp() {
    const settings = new SettingsStore(db, keyring);
    service = newService(new OAuthStore(db, keyring), settings.connectors);
    connectors = settings.connectors;
    const store = new Store(db);
    const hub = new Hub();
    const auth = new AuthStore(db);
    const app = createApp({
      auth,
      store,
      settings,
      hub,
      orchestrator: new Orchestrator(store, hub, settings),
      providers: new ProviderService(settings),
      oauth: service,
    });
    const HOST = { host: '127.0.0.1:8787', 'x-relay-lang': 'en' };
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { ...HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ code: auth.createCode(CODE_TTL_MS.device).code }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    const signedIn = { ...HOST, cookie, [AUTH_KEY_HEADER]: ((await res.json()) as { key: string }).key };
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = signedIn) =>
      app.request(path, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    return { call, HOST };
  }
  const error = async (res: Response) => ((await res.json()) as { error: string }).error;

  it('starts a sign-in for its uses, adds and tests the mail account over XOAUTH2, keeps its servers fixed, and removes it with its account', async () => {
    const { call, HOST } = await signedInApp();
    for (const uses of [[], ['mail', 'drive'], 'mail']) {
      const bad = await call('POST', '/api/oauth/signins', { provider: 'microsoft', uses });
      expect(bad.status).toBe(400);
      expect(await error(bad)).toContain('uses');
    }
    const started = (await (
      await call('POST', '/api/oauth/signins', { provider: 'microsoft', uses: ['mail'], origin: 'http://localhost:5173' })
    ).json()) as OAuthSignInView;
    expect(new URL(started.authorizeUrl!).searchParams.get('scope')).toContain(`${OUTLOOK}/IMAP.AccessAsUser.All`);
    expect(new URL(started.authorizeUrl!).searchParams.get('scope')).not.toContain('Calendars.ReadWrite');
    const back = await call('POST', '/api/oauth/callback', callbackParams(fake.allow(started.authorizeUrl!)), HOST);
    expect(await back.json()).toEqual({ status: 'done', provider: 'microsoft', email: 'ming@contoso.com' });
    const id = service.view().accounts[0]!.id;
    const view = (await (await call('GET', '/api/connectors')).json()) as ConnectorsView;
    expect(view.mail).toEqual([
      expect.objectContaining({ id, name: 'Outlook · ming@contoso.com', address: 'ming@contoso.com', oauth: id, password: '' }),
    ]);
    expect(view.calendar).toEqual([]);

    // Test: signs in to its IMAP and SMTP with XOAUTH2, sending nothing.
    expect(await (await call('POST', `/api/connectors/mail/${id}/test`, {})).json()).toEqual({
      ok: true,
      message: 'Connected: the sign-in works.',
    });
    expect(imap.xoauth2.at(-1)).toMatchObject({ user: 'ming@contoso.com', ok: true });
    expect(smtp.xoauth2.at(-1)).toMatchObject({ user: 'ming@contoso.com', ok: true });
    expect(smtp.sent).toEqual([]);

    // Its servers and sign-in are fixed: no password, no other servers.
    const fixed = await call('PUT', `/api/connectors/mail/${id}`, {
      name: 'Mine',
      address: 'ming@contoso.com',
      username: 'ming@contoso.com',
      password: 'p',
      imap: { host: 'imap.example.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.example.com', port: 465, security: 'tls' },
    });
    expect(fixed.status).toBe(409);
    expect(await error(fixed)).toBe(
      "This mail account is reached through an account that signed in, at its provider's own servers, not with a password or other servers: remove it and add it again",
    );
    // Removed alone, and added again from its account, once.
    expect(((await (await call('DELETE', `/api/connectors/mail/${id}`, {})).json()) as ConnectorsView).mail).toEqual([]);
    for (let i = 0; i < 2; i++)
      expect(((await (await call('POST', `/api/oauth/accounts/${id}/mail`, {})).json()) as ConnectorsView).mail).toHaveLength(1);
    expect((await call('POST', '/api/oauth/accounts/nobody/mail', {})).status).toBe(404);

    // An account signed in for the calendar alone has no mail account to add.
    const google = await signIn(['calendar'], 'google');
    const notForMail = await call('POST', `/api/oauth/accounts/${google.account!.id}/mail`, {});
    expect(notForMail.status).toBe(409);
    expect(await error(notForMail)).toContain('ming@gmail.com was not signed in for mail');

    // Never a token in what the page gets.
    expect(JSON.stringify(await (await call('GET', '/api/oauth')).json())).not.toMatch(/access-|refresh-/);
    // Removed with its account.
    const removed = (await (await call('DELETE', `/api/oauth/accounts/${id}`, {})).json()) as OAuthView & { connectors: ConnectorsView };
    expect(removed.connectors.mail).toEqual([]);
    expect(removed.accounts.map((a) => a.provider)).toEqual(['google']);
  });

  it('says in Test that the account needs a new sign-in, without a 5xx', async () => {
    const { call } = await signedInApp();
    const id = (await signIn(['mail'])).account!.id;
    now += 61 * MIN;
    fake.refreshAnswer = invalidGrant;
    const res = await call('POST', `/api/connectors/mail/${id}/test`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining('The sign-in of ming@contoso.com no longer works'),
    });
    expect(((await (await call('GET', '/api/oauth')).json()) as OAuthView).accounts[0]).toMatchObject({ id, status: 'reauth' });
    fake.refreshAnswer = undefined;
  });
});
