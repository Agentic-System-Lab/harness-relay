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
 * Also: what is a refused token and what is not (SMTP's 530, 534 and 535 only; a 4xx, a 504, no
 * XOAUTH2 in EHLO, IMAP's NO before the token: not renewed), an empty 334 answered with the response,
 * a server that keeps asking, untagged responses, a reason that is not JSON, the token never before
 * STARTTLS's TLS, a password never tried twice; a sign-in for one use checking the account's others
 * (Microsoft: their tokens with the new refresh token), `login_hint`, the mail account added only at
 * the first sign-in for mail and under a free name; the device code; a restart; the outbox's Send
 * through its route; IDLE's BYE after a healthy round as a renewal, and its backoff while the account
 * needs a new sign-in; and a refresh queued behind another one asking nothing once the account was
 * signed in again or removed.
 */
import { writeFileSync, symlinkSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_KEY_HEADER } from '../src/shared/auth';
import type { ConnectorsView, OAuthProviderId, OAuthSignInView, OAuthUse, OAuthView, OutboxItem } from '../src/shared/types';
import { fakeImap, fakeSmtp, type FakeImap, type FakeMessage, type FakeSmtp } from './fake-mail-servers';
import { fakeOAuth, type FakeOAuth } from './fake-oauth-server';
import { slow } from './timeouts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-oauth-mail-')));
process.env.RELAY_DATA_DIR = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const { AuthStore, CODE_TTL_MS } = await import('../src/server/auth');
const { createApp } = await import('../src/server/app');
const { ConnectorStore } = await import('../src/server/connectors/accounts');
const { ImapClient, ImapLoginError, xoauth2, xoauth2Detail } = await import('../src/server/connectors/imap');
const { MailSignInError, mailLogin, openImap, sendMailAs, withSmtpLogin } = await import('../src/server/connectors/mailLogin');
const { SmtpLoginError, sendMail } = await import('../src/server/connectors/smtp');
const { testMail } = await import('../src/server/connectors/test');
const { appTools } = await import('../src/server/connectors/apps');
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
const { Outbox } = await import('../src/server/outbox');
const { ProviderService } = await import('../src/server/providers');
const { SettingsStore } = await import('../src/server/settings');
const { Store } = await import('../src/server/store');
const { checkMail, checkTrigger, triggerKey } = await import('../src/server/watch');
type GatewayContext = import('../src/server/gateway').GatewayContext;
type GatewayTool = import('../src/server/gateway').GatewayTool;
type MailOAuth = import('../src/server/connectors/mailLogin').MailOAuth;

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
/** A promise the test resolves itself, and the resolving. */
function gate(): { until: Promise<void>; open: () => void } {
  let open!: () => void;
  const until = new Promise<void>((r) => (open = r));
  return { until, open };
}
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
/**
 * Gmail's take a good Google token that carries Gmail's scope. Each scope is compared whole with
 * `===`: CodeQL reads `includes()` with a URL as a substring check on a URL (code scanning alert 27).
 */
const gmailToken = (user: string, token: string) =>
  user === 'ming@gmail.com' && fake.accessTokens.get(token) === true && (fake.scopesOf.get(token) ?? []).some((scope) => scope === GMAIL);

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

      const c = await ImapClient.open(local(asGmail.port), { username: user, token: 'good-token' }, slow(2000));
      const at = asGmail.commands.indexOf('R1 AUTHENTICATE XOAUTH2');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(Buffer.from(asGmail.commands[at + 1]!, 'base64').toString()).toBe('user=me@example.com\x01auth=Bearer good-token\x01\x01');
      expect(asGmail.commands.some((x) => / LOGIN /.test(x))).toBe(false);
      expect(c.capabilities.has('IMAP4REV1')).toBe(true);
      await c.logout();

      // Gmail says why in a continuation first, answered with an empty line, then NO; Microsoft says NO at once.
      const refused = ImapClient.open(local(asGmail.port), { username: user, token: 'stale' }, slow(2000));
      await expect(refused).rejects.toBeInstanceOf(ImapLoginError);
      await expect(refused).rejects.toThrow(
        "The mail server did not accept the sign-in's token: [AUTHENTICATIONFAILED] Invalid credentials (Failure) (status 400)",
      );
      expect(asGmail.commands.at(-1)).toBe('');
      await expect(ImapClient.open(local(asMicrosoft.port), { username: user, token: 'stale' }, slow(2000))).rejects.toThrow(
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

  it('tells a refused token from a server that does not take one or cannot now: only those are renewed, once', () =>
    withLang('en', async () => {
      const good = (user: string, token: string) => user === 'me@example.com' && token === 'good-token';
      const user = 'me@example.com';
      const login = { username: user, token: 'good-token' };
      const envelope = { from: user, recipients: ['bob@example.com'] };
      const servers = async <T extends { close: () => Promise<unknown> }>(open: Promise<T>) => {
        const server = await open;
        closers.push(server.close);
        return server;
      };
      /** A sign-in with a token, and each token it asked for (`fresh` or not). */
      const asked: boolean[] = [];
      const withToken = (imapPort: number, smtpPort: number) => ({
        imap: local(imapPort),
        smtp: local(smtpPort),
        oauth: true,
        login: async (fresh = false) => (asked.push(fresh), login),
      });

      // SMTP: an EHLO without XOAUTH2 is not tried, and says so; nothing goes to the server.
      const plain = await servers(fakeSmtp());
      const notOffered = sendMail(local(plain.port), login, envelope, 'x', slow(2000));
      await expect(notOffered).rejects.toThrow('The mail server 127.0.0.1 does not take a sign-in with a token (XOAUTH2)');
      expect(await notOffered.catch((e: unknown) => e)).not.toBeInstanceOf(SmtpLoginError);
      expect(plain.lines.some((l) => /^AUTH\b/i.test(l))).toBe(false);
      // A 4xx (try later) and another 5xx (504: not offered after all) are no refusal of the token; 530, 534 and 535 are.
      for (const [answer, refused] of [
        ['454 4.7.0 Temporary authentication failure', false],
        ['421 4.7.0 Try again later, closing connection', false],
        ['504 5.7.4 Unrecognized authentication type', false],
        ['530 5.7.0 Authentication required', true],
        ['534 5.7.9 Authentication mechanism is too weak', true],
        ['535 5.7.8 Authentication credentials invalid', true],
      ] as const) {
        const server = await servers(fakeSmtp(undefined, { bearer: good, authAnswer: answer }));
        asked.length = 0;
        const sent = sendMailAs(withToken(1, server.port), envelope, 'x', slow(2000));
        await expect(sent).rejects.toThrow(answer);
        expect((await sent.catch((e: unknown) => e)) instanceof SmtpLoginError).toBe(refused);
        // Renewed once only after a refusal of the token itself.
        expect(asked).toEqual(refused ? [false, true] : [false]);
        expect(server.sent).toEqual([]);
      }
      // A refusal of the new token too: said, after one renewal, and nothing sent.
      const refusing = await servers(fakeSmtp(undefined, { bearer: () => false, refusal: 'microsoft' }));
      asked.length = 0;
      await expect(sendMailAs(withToken(1, refusing.port), envelope, 'x', slow(2000))).rejects.toBeInstanceOf(SmtpLoginError);
      expect(asked).toEqual([false, true]);
      expect(refusing.xoauth2).toHaveLength(2);
      expect(refusing.sent).toEqual([]);
      // An empty 334 asks for the response (a server that does not take it with the command): sent then, on its own line.
      const asks = await servers(fakeSmtp(undefined, { bearer: good, asksResponse: true }));
      expect(await sendMail(local(asks.port), login, envelope, 'Subject: hi\r\n\r\nHello', slow(2000))).toBe('OK queued as FAKE123');
      expect(asks.lines.slice(1, 3)).toEqual([`AUTH XOAUTH2 ${xoauth2(user, 'good-token')}`, xoauth2(user, 'good-token')]);
      expect(asks.sent).toHaveLength(1);
      // A server that keeps asking with an empty 334 gets the token twice at most (with the command, and once
      // more), then an empty line, and is given up on; one that said why first never gets it again after.
      const token = xoauth2(user, 'good-token');
      const sends = (lines: string[]) => lines.filter((l) => l.endsWith(token)).length;
      for (const [keepsAsking, times, after] of [
        ['empty', 2, [token, '']],
        ['reason', 1, ['']],
      ] as const) {
        const asking = await servers(fakeSmtp(undefined, { bearer: good, keepsAsking }));
        await expect(sendMail(local(asking.port), login, envelope, 'Subject: hi\r\n\r\nHello', slow(2000))).rejects.toThrow(
          /^The mail server did not finish the sign-in with the token: /,
        );
        expect(sends(asking.lines)).toBe(times);
        expect(asking.lines.slice(2, 2 + after.length)).toEqual(after);
        expect(asking.lines).toHaveLength(2 + after.length);
        expect(asking.sent).toEqual([]);
      }

      // IMAP: a NO before the token was sent is a server that does not take one: said, and not renewed.
      const noXoauth2 = await servers(fakeImap([]));
      asked.length = 0;
      const notTaken = openImap(withToken(noXoauth2.port, 1), slow(2000));
      await expect(notTaken).rejects.toThrow(
        /^The mail server 127\.0\.0\.1 does not take a sign-in with a token \(XOAUTH2\): NO \[CANNOT\] Unsupported authentication mechanism$/,
      );
      expect(await notTaken.catch((e: unknown) => e)).not.toBeInstanceOf(ImapLoginError);
      expect(asked).toEqual([false]);
      expect(noXoauth2.commands).toEqual(['R1 AUTHENTICATE XOAUTH2']);
      // A server that asks again after the empty line that answered its reason is not one that takes the token: no refusal, not renewed.
      const again = await servers(fakeImap([], undefined, { bearer: () => false, askAgain: true }));
      asked.length = 0;
      const looping = openImap(withToken(again.port, 1), slow(2000));
      await expect(looping).rejects.toThrow("The mail server did not accept the sign-in's token: status 400");
      expect(await looping.catch((e: unknown) => e)).not.toBeInstanceOf(ImapLoginError);
      expect(asked).toEqual([false]);
      expect(again.commands.filter((c) => c === '')).toHaveLength(1);
      // Untagged responses before the go-ahead and before the answer are read past.
      const chatty = await servers(fakeImap([], undefined, { bearer: good, chatty: true }));
      const c = await ImapClient.open(local(chatty.port), login, slow(2000));
      expect(c.capabilities.has('IMAP4REV1')).toBe(true);
      await c.logout();
      // A reason that is not JSON (nor JSON with a status) is said as its text, its control characters as spaces.
      const textual = await servers(
        fakeImap([], undefined, { bearer: () => false, challenge: Buffer.from('Token expired\r\nsign in again').toString('base64') }),
      );
      await expect(ImapClient.open(local(textual.port), { username: user, token: 'stale' }, slow(2000))).rejects.toThrow(
        "The mail server did not accept the sign-in's token: [AUTHENTICATIONFAILED] Invalid credentials (Failure) (Token expired sign in again)",
      );
      expect(xoauth2Detail(Buffer.from('{"schemes":"bearer"}').toString('base64'))).toBe('{"schemes":"bearer"}');
      expect(xoauth2Detail(Buffer.from('{"status":401}').toString('base64'))).toBe('status 401');
    }));

  it('tries a refused password once: only a sign-in with a token is renewed and tried again', () =>
    withLang('en', async () => {
      const passwordImap = await fakeImap([]);
      const passwordSmtp = await fakeSmtp();
      closers.push(passwordImap.close, passwordSmtp.close);
      const m = mailLogin(
        {
          id: 'work',
          name: 'Work',
          address: 'me@example.com',
          username: 'me@example.com',
          imap: local(passwordImap.port),
          smtp: local(passwordSmtp.port),
        },
        'wrong',
      );
      expect(m.oauth).toBe(false);
      await expect(openImap(m, slow(2000))).rejects.toBeInstanceOf(ImapLoginError);
      expect(passwordImap.commands.filter((c) => / LOGIN /.test(c))).toHaveLength(1);
      await expect(withSmtpLogin(m, async () => undefined, slow(2000))).rejects.toBeInstanceOf(SmtpLoginError);
      expect(passwordSmtp.lines.filter((l) => /^AUTH /.test(l))).toHaveLength(1);
    }));

  it('sends a token over STARTTLS only once TLS started: a server that cannot start it gets nothing of it, and it is not renewed', () =>
    withLang('en', async () => {
      const token = 'secret-token';
      const user = 'me@example.com';
      // Stand-ins that answer STARTTLS's go-ahead, then speak no TLS: everything each was sent.
      const got = { imap: '', smtp: '' };
      const listen = async (kind: 'imap' | 'smtp') => {
        const server = createServer((sock) => {
          let started = false;
          sock.on('error', () => undefined);
          sock.write(kind === 'imap' ? '* OK [CAPABILITY IMAP4rev1 STARTTLS AUTH=XOAUTH2] ready\r\n' : '220 fake ready\r\n');
          sock.on('data', (chunk: Buffer) => {
            got[kind] += chunk.toString('latin1');
            if (started) return void sock.end('this is no TLS\r\n');
            const line = chunk.toString('utf8');
            if (kind === 'imap' && /^\S+ STARTTLS\r\n$/.test(line)) {
              started = true;
              sock.write(`${line.split(' ')[0]} OK Begin TLS negotiation now\r\n`);
            } else if (kind === 'smtp' && /^EHLO/.test(line)) sock.write('250-fake\r\n250-STARTTLS\r\n250 AUTH XOAUTH2\r\n');
            else if (kind === 'smtp' && /^STARTTLS/.test(line)) {
              started = true;
              sock.write('220 2.0.0 Ready to start TLS\r\n');
            }
          });
        });
        await new Promise<void>((r) => server.listen(0, 'localhost', () => r()));
        closers.push(() => new Promise((r) => server.close(r)));
        return (server.address() as { port: number }).port;
      };
      const [imapPort, smtpPort] = [await listen('imap'), await listen('smtp')];
      const asked: boolean[] = [];
      const oauth: MailOAuth = {
        mailVia: () => ({
          imap: { host: 'localhost', port: imapPort, security: 'starttls' },
          smtp: { host: 'localhost', port: smtpPort, security: 'starttls' },
          username: user,
        }),
        mailToken: async (_id, fresh) => (asked.push(Boolean(fresh)), token),
        problem: () => undefined,
        signInState: () => 'connected 1',
      };
      const m = mailLogin(
        { id: 'work', name: 'Work', address: user, username: user, imap: local(1), smtp: local(1), oauth: 'microsoft-me-abc123' },
        '',
        oauth,
      );
      await expect(openImap(m, slow(5000))).rejects.toThrow(/TLS with localhost (failed|did not start)/);
      await expect(withSmtpLogin(m, async () => undefined, slow(5000))).rejects.toThrow(/TLS with localhost (failed|did not start)/);
      for (const sent of Object.values(got)) {
        expect(sent).toMatch(/STARTTLS\r\n/);
        expect(sent).not.toMatch(/AUTH/);
        expect(sent).not.toContain(token);
        expect(sent).not.toContain(xoauth2(user, token));
      }
      // A TLS that failed is no refused token: one token asked for each, none renewed.
      expect(asked).toEqual([false, false]);
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
      // Nor one for no use (an MCP server's way): not the sign-in's own token (Graph's User.Read, which serves none of its uses), nor a refresh.
      await expect(service.broker.accessToken(id, undefined)).rejects.toThrow(
        'A token of ming@contoso.com is given only for one of its uses (calendars or mail)',
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

  it("checks at a sign-in for one use that the account's other uses still get their tokens, refusing one that lost its consent and keeping the account as it was", () =>
    withLang('en', async () => {
      const id = (await signIn(['calendar'])).account!.id;
      const kept = keyring.values.get(`oauth-${id}`);
      // The calendar's consent taken away at Microsoft meanwhile: a sign-in for mail alone would leave the
      // calendar without it, and the next calendar refresh would mark the whole account (mail too).
      fake.consented.delete(`${fake.url}/Calendars.ReadWrite`);
      expect(await signIn(['mail'])).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(
          /^Microsoft did not give access to the calendar: sign in again, and allow access to your calendar on the sign-in page \(invalid_grant: AADSTS65001: .*Calendars\.ReadWrite/,
        ),
      });
      expect(service.view().accounts).toEqual([expect.objectContaining({ id, uses: ['calendar'], status: 'connected' })]);
      expect(keyring.values.get(`oauth-${id}`)).toBe(kept);
      expect(connectors.view().mail).toEqual([]);

      // Use for mail, as Settings asks it: the account's uses with the new one, its address as the page's hint.
      const started = await service.startSignIn({
        provider: 'microsoft',
        uses: ['mail'],
        account: id,
        session: 's1',
        origin: 'http://127.0.0.1:8787',
        port: 8787,
      });
      const q = new URL(started.authorizeUrl!).searchParams;
      expect(q.get('login_hint')).toBe('ming@contoso.com');
      expect(q.get('scope')!.split(' ')).toEqual(
        expect.arrayContaining([`${fake.url}/Calendars.ReadWrite`, `${OUTLOOK}/IMAP.AccessAsUser.All`, `${OUTLOOK}/SMTP.Send`]),
      );
      const done = await service.signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)));
      expect(done.account).toMatchObject({ id, uses: ['calendar', 'mail'], status: 'connected' });
      expect(connectors.view().mail).toHaveLength(1);

      // A sign-in for mail alone with the calendar's consent there: the calendar's token asked for at once
      // with the new refresh token (after mail's, which rotated it), and kept.
      const before = grants('refresh_token').length;
      expect((await signIn(['mail'])).status).toBe('done');
      const asked = grants('refresh_token')
        .slice(before)
        .map((r) => new URLSearchParams(r.body));
      expect(asked.map((f) => f.get('scope'))).toEqual([
        `openid email profile offline_access ${OUTLOOK}/IMAP.AccessAsUser.All ${OUTLOOK}/SMTP.Send`,
        `openid email profile offline_access ${fake.url}/User.Read ${fake.url}/Calendars.ReadWrite`,
      ]);
      expect(asked[1]!.get('refresh_token')).not.toBe(asked[0]!.get('refresh_token'));
      const requests = fake.requests.length;
      expect(fake.resources.get(await service.broker.accessToken(id, 'calendar'))).toBe('graph');
      expect(fake.requests).toHaveLength(requests);
      expect(fake.refreshTokens.get(keyring.values.get(`oauth-${id}`)!)).toBe(true);

      // Only an account of the provider asked for, and one that is there.
      service.saveClient('google', { clientId: fake.google.clientId, secret: fake.google.secret });
      await expect(service.startSignIn({ provider: 'google', uses: ['mail'], account: id, port: 8787 })).rejects.toMatchObject({
        status: 400,
        message: 'Invalid value for "account"',
      });
      await expect(service.startSignIn({ provider: 'microsoft', uses: ['mail'], account: 'nobody', port: 8787 })).rejects.toMatchObject({
        status: 404,
      });
    }));

  it('keeps a sign-in started for one account for it alone: another one picked on the page, or the account removed meanwhile, changes nothing', () =>
    withLang('en', async () => {
      const id = (await signIn(['calendar'])).account!.id;
      const useForMail = () =>
        service.startSignIn({
          provider: 'microsoft',
          uses: ['mail'],
          account: id,
          session: 's1',
          origin: 'http://127.0.0.1:8787',
          port: 8787,
        });
      // Use for mail, and another identity picked in Microsoft's account picker.
      const started = await useForMail();
      const me = fake.me;
      fake.me = { id: 'subject-other', displayName: 'Other', mail: 'other@contoso.com' };
      const other = await service.signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)));
      fake.me = me;
      expect(other).toMatchObject({
        status: 'failed',
        error:
          'You signed in as other@contoso.com, not ming@contoso.com: ming@contoso.com was not changed. To add another account, use Sign in with …',
      });
      expect(service.view().accounts).toEqual([expect.objectContaining({ id, email: 'ming@contoso.com', uses: ['calendar'] })]);
      expect(connectors.view().mail).toEqual([]);

      // Removed while its page was still open: not brought back.
      const again = await useForMail();
      await service.removeAccount(id);
      const gone = await service.signIns.callback(callbackParams(fake.allow(again.authorizeUrl!)));
      expect(gone).toMatchObject({
        status: 'failed',
        error: 'The account this sign-in was for was removed meanwhile, so nothing was changed',
      });
      expect(service.view().accounts).toEqual([]);
      expect(connectors.view().mail).toEqual([]);
    }));

  it('does not bring back an account removed while a sign-in for it asked the tokens of its earlier uses', () =>
    withLang('en', async () => {
      const id = (await signIn(['calendar'])).account!.id;
      // Sign in again for the calendar, and meanwhile a sign-in for mail picks the same account: it has both now.
      const started = await service.startSignIn({ provider: 'microsoft', uses: ['calendar'], account: id, session: 's1', port: 8787 });
      expect((await signIn(['mail'])).account).toMatchObject({ id, uses: ['calendar', 'mail'] });
      // The first page finishes; mail's token, asked with the new refresh token, is held; the account is removed then.
      const g = gate();
      fake.hold = { grant: 'refresh_token', until: g.until };
      const asked = grants('refresh_token').length;
      const finishing = service.signIns.callback(callbackParams(fake.allow(started.authorizeUrl!)));
      await vi.waitFor(() => expect(grants('refresh_token').length).toBeGreaterThan(asked));
      await service.removeAccount(id);
      fake.hold = undefined;
      g.open();
      expect(await finishing).toMatchObject({
        status: 'failed',
        error: 'The account this sign-in was for was removed meanwhile, so nothing was changed',
      });
      expect(service.view().accounts).toEqual([]);
      expect([...keyring.values.keys()].filter((k) => k.startsWith('oauth-'))).toEqual([]);
    }));

  it('adds the mail account and the calendar only at the first sign-in for them: one removed since stays removed, and is added by hand under a free name', async () => {
    const id = (await signIn(['mail'])).account!.id;
    expect(connectors.view().mail.map((m) => m.oauth)).toEqual([id]);
    connectors.delete('mail', id);
    // Signed in again for mail, then for the calendar as well (its first): only the calendar is added.
    await signIn(['mail']);
    expect(connectors.view().mail).toEqual([]);
    await signIn(['calendar', 'mail']);
    expect(connectors.view().mail).toEqual([]);
    expect(connectors.view().calendar.map((c) => c.oauth)).toEqual([id]);
    connectors.delete('calendar', connectors.view().calendar[0]!.id);
    await signIn(['calendar', 'mail']);
    expect(connectors.view().calendar).toEqual([]);
    expect(service.view().accounts[0]).toMatchObject({ uses: ['calendar', 'mail'], status: 'connected' });

    // Added by hand (Use for mail): its name taken meanwhile by another mail account, it gets a free one.
    connectors.saveMail('outlook', {
      name: 'Outlook · ming@contoso.com',
      address: 'ming@contoso.com',
      username: 'ming@contoso.com',
      password: 'app-pass',
      imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    });
    const added = service.addMail(id).mail.find((m) => m.oauth === id);
    expect(added).toMatchObject({ id, name: 'Outlook · ming@contoso.com (2)' });
    // Once: added again, it stays as it is.
    expect(service.addMail(id).mail.filter((m) => m.oauth === id)).toHaveLength(1);
  });

  it('signs in for mail on another device, with a code, and gets the token for mail at once', async () => {
    const started = await service.startSignIn({ provider: 'microsoft', uses: ['mail'], session: 's1', port: 8787, device: true });
    expect(started.device).toBeDefined();
    fake.typeCode(started.device!.userCode);
    await vi.waitFor(() => expect(service.signIn(started.id, 's1').status).toBe('done'), { interval: 20 });
    const account = service.view().accounts[0]!;
    expect(account).toMatchObject({ email: 'ming@contoso.com', uses: ['mail'], status: 'connected' });
    expect(connectors.view().mail.map((m) => m.oauth)).toEqual([account.id]);
    // The device code's token is Graph's (who signed in); mail's came at once from the refresh token.
    expect(grants('refresh_token').map((r) => new URLSearchParams(r.body).get('scope'))).toEqual([
      `openid email profile offline_access ${OUTLOOK}/IMAP.AccessAsUser.All ${OUTLOOK}/SMTP.Send`,
    ]);
    const requests = fake.requests.length;
    expect((await tools().mail_search!.run!({}, ctx)).text).toContain('Lunch?');
    expect(fake.requests).toHaveLength(requests);
    expect(imap.xoauth2).toEqual([{ user: 'ming@contoso.com', token: expect.stringMatching(/^access-/), ok: true }]);
  });

  it('lets a refresh queued behind another ask nothing once the account was signed in again or removed meanwhile', () =>
    withLang('en', async () => {
      const id = (await signIn(['calendar', 'mail'])).account!.id;
      // Both tokens about to run out: the calendar's refresh held at Microsoft, mail's queued behind it.
      now += 59 * MIN;
      let held = gate();
      fake.hold = { grant: 'refresh_token', until: held.until };
      let before = grants('refresh_token').length;
      let calendar = service.broker.accessToken(id, 'calendar');
      await vi.waitFor(() => expect(grants('refresh_token')).toHaveLength(before + 1), { interval: 10 });
      let mail = service.mailToken(id);
      // Signed in again meanwhile (its own refresh for mail's token goes through).
      fake.hold = undefined;
      expect((await signIn(['calendar', 'mail'])).account!.id).toBe(id);
      const kept = keyring.values.get(`oauth-${id}`)!;
      const asked = grants('refresh_token').length;
      held.open();
      const [c, m] = await Promise.all([calendar, mail]);
      // The queued refresh never sent the refresh token (it would have rotated the new sign-in's away,
      // unkept); nothing the held one brought back was written; each caller got the new sign-in's token.
      expect(grants('refresh_token')).toHaveLength(asked);
      expect(keyring.values.get(`oauth-${id}`)).toBe(kept);
      expect(fake.refreshTokens.get(kept)).toBe(true);
      expect([fake.resources.get(c), fake.resources.get(m)]).toEqual(['graph', 'outlook']);
      expect([fake.accessTokens.get(c), fake.accessTokens.get(m)]).toEqual([true, true]);
      expect(service.view().accounts[0]!.status).toBe('connected');

      // Removed meanwhile, its refresh token still readable (the credential store refused to delete it):
      // the queued refresh does not send it either.
      now += 59 * MIN;
      held = gate();
      fake.hold = { grant: 'refresh_token', until: held.until };
      before = grants('refresh_token').length;
      calendar = service.broker.accessToken(id, 'calendar');
      await vi.waitFor(() => expect(grants('refresh_token')).toHaveLength(before + 1), { interval: 10 });
      mail = service.mailToken(id);
      vi.spyOn(keyring, 'delete').mockImplementation(() => {
        throw new Error('The keychain is locked');
      });
      await service.removeAccount(id);
      expect(keyring.values.get(`oauth-${id}`)).toBe(kept);
      fake.hold = undefined;
      held.open();
      await expect(calendar).rejects.toThrow('The account that signed in is not there any more');
      await expect(mail).rejects.toThrow('The account that signed in is not there any more');
      // The held one alone was sent; what it brought back (a rotated refresh token) was not written.
      expect(grants('refresh_token')).toHaveLength(before + 1);
      expect(keyring.values.get(`oauth-${id}`)).toBe(kept);
      expect(service.view().accounts).toEqual([]);
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
      // The same at Send (SMTP AUTH turned off for the mailbox): renewed once, said, and nothing sent.
      before = grants('refresh_token').length;
      const smtpLogins = smtp.xoauth2.length;
      await expect(t.mail_send!.send!({ to: 'bob@example.com', subject: 'x', body: 'y', accountId: id }, {} as OutboxItem)).rejects.toThrow(
        "The mail server did not accept the sign-in's token: 535 5.7.3 Authentication unsuccessful",
      );
      expect(smtp.xoauth2.slice(smtpLogins).map((x) => x.ok)).toEqual([false, false]);
      expect(grants('refresh_token')).toHaveLength(before + 1);
      expect(smtp.sent).toHaveLength(1);
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

describe('a mail account that signs in, across a restart', () => {
  it('is read back with its account: the refresh token from the credential store, a new token for mail asked at its first use', () =>
    withLang('en', async () => {
      const id = (await signIn(['mail'])).account!.id;
      const before = grants('refresh_token').length;
      // Started again: the stores read back from the database and the credential store, no access token in memory.
      connectors = new ConnectorStore(db, keyring);
      service = newService(new OAuthStore(db, keyring), connectors);
      expect(connectors.view().mail).toEqual([expect.objectContaining({ id, oauth: id, address: 'ming@contoso.com', password: '' })]);
      expect(service.view().accounts).toEqual([expect.objectContaining({ id, uses: ['mail'], status: 'connected' })]);
      expect((await tools().mail_search!.run!({}, ctx)).text).toContain('Lunch?');
      expect(grants('refresh_token')).toHaveLength(before + 1);
      expect(new URLSearchParams(grants('refresh_token').at(-1)!.body).get('scope')).toContain(`${OUTLOOK}/IMAP.AccessAsUser.All`);
      expect(imap.xoauth2.at(-1)).toMatchObject({ user: 'ming@contoso.com', ok: true });
    }));
});

describe("Google's incremental consent for mail", () => {
  it('never hands the token kept for the calendar to mail before the account was signed in for mail, although it is one token for all', () =>
    withLang('en', async () => {
      const id = (await signIn(['calendar'], 'google')).account!.id;
      const requests = fake.requests.length;
      await expect(service.mailToken(id)).rejects.toThrow(
        'ming@gmail.com was not signed in for mail: click Use for mail for it in Settings → Tool library first',
      );
      expect(fake.requests).toHaveLength(requests);
      expect(await service.broker.accessToken(id, 'calendar')).toMatch(/^access-/);
    }));

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

describe('chat tools for common apps', () => {
  const call = (name: string, args: Record<string, unknown> = {}) =>
    appTools(
      service,
      () => undefined,
      () => ({}),
    ).find((t) => t.name === name)!.run!(args, ctx);
  it('reads Markdown notes from the chosen vault and omits hidden files and links', async () => {
    const vault = realpathSync(mkdtempSync(join(root, 'vault-')));
    mkdirSync(join(vault, '.obsidian'));
    writeFileSync(join(vault, 'Note.md'), 'Meeting </app_data>');
    writeFileSync(join(vault, '.obsidian', 'internal.md'), 'private settings');
    if (process.platform !== 'win32') symlinkSync(join(vault, '.obsidian', 'internal.md'), join(vault, 'alias.md'));
    const tools = appTools(
      service,
      () => vault,
      () => ({}),
    );
    const read = (name: string, a: Record<string, unknown>) => tools.find((x) => x.name === name)!.run!(a, ctx);
    const list = await read('obsidian_list', {});
    expect(list.text).toContain('Note.md');
    expect(list.text).not.toMatch(/\.obsidian|alias.md/);
    expect((await read('obsidian_read', { path: 'Note.md' })).text).toContain('Meeting <\\/app_data>');
    for (const path of ['../other.md', '.obsidian/internal.md', 'alias.md'])
      await expect(read('obsidian_read', { path })).rejects.toThrow();
  });

  it('reads pull requests for the requested GitHub repository with the signed-in CLI', async () => {
    const calls: string[][] = [];
    const tools = appTools(
      service,
      () => undefined,
      () => ({}),
      async (args) => {
        calls.push(args);
        const stdout = JSON.stringify([{ number: 17, title: 'Meeting notes' }]);
        const stdoutBytes = Buffer.from(stdout);
        return {
          code: 0,
          signal: null,
          stdout,
          stdoutBytes,
          stdoutSize: stdoutBytes.length,
          stdoutTruncated: false,
          stderr: '',
          timedOut: false,
          aborted: false,
        };
      },
    );
    const prs = tools.find((tool) => tool.name === 'github_pull_requests')!;
    expect(prs.tier).toBe('read');
    expect((await prs.run!({ repo: 'example/notes' }, ctx)).text).toContain('Meeting notes');
    await expect(prs.run!({ repo: '--help' }, ctx)).rejects.toThrow();
    expect(calls).toEqual([
      ['pr', 'list', '--repo', 'github.com/example/notes', '--state', 'all', '--limit', '30', '--json', 'number,title,url,state'],
    ]);
  });

  it('adds Drive to the same Google account and uses its token for searches and document export', async () => {
    const mail = await signIn(['mail'], 'google');
    await expect(call('drive_search')).rejects.toThrow();
    const drive = await signIn(['drive'], 'google');
    expect(drive.account?.id).toBe(mail.account?.id);
    expect(drive.account?.uses).toEqual(['mail', 'drive']);
    expect((await call('drive_search', { query: "Ming's notes" })).text).toContain('Notebook');
    const search = fake.requests.find((r) => r.path.startsWith('/drive/v3/files?'))!;
    expect(new URL(search.path, fake.url).searchParams.get('q')).toBe("trashed = false and name contains 'Ming\\'s notes'");
    expect(search.bearer).toBeTruthy();
    expect((await call('drive_read_document', { id: 'doc' })).text).toContain('Meeting summary');
    await expect(call('drive_read_document', { id: '..' })).rejects.toThrow();
    await service.removeAccount(drive.account!.id);
    await expect(call('drive_search')).rejects.toThrow();
    await expect(service.startSignIn({ provider: 'microsoft', uses: ['drive'], port: 8787 })).rejects.toThrow();
  });
  it('requests only the Teams Graph scopes and reads teams, channels and messages', async () => {
    const { started, done } = await signInFull(['teams']);
    expect(done.status).toBe('done');
    const scopes = new URL(started.authorizeUrl!).searchParams.get('scope');
    expect(scopes).toContain('ChannelMessage.Read.All');
    expect(scopes).not.toMatch(/Calendar|IMAP/);
    expect((await call('teams_list')).text).toContain('Product');
    expect((await call('teams_list', { team: 'team1' })).text).toContain('General');
    expect((await call('teams_messages', { team: 'team1', channel: 'channel1' })).text).toContain('Friday update');
    await expect(service.startSignIn({ provider: 'google', uses: ['teams'], port: 8787 })).rejects.toThrow();
  });
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
      const found = await checkMail(trigger, prev, connectors, slow(2000), service);
      expect(found.total).toBe(1);
      expect(JSON.parse(found.event!)).toMatchObject({ account: 'Outlook · ming@contoso.com', mails: [{ subject: 'Invoice 43' }] });
      expect(imap.xoauth2.every((x) => x.ok && x.user === 'ming@contoso.com')).toBe(true);

      now += 61 * MIN;
      fake.refreshAnswer = invalidGrant;
      await expect(checkMail(trigger, prev, connectors, slow(2000), service)).rejects.toThrow(
        'The sign-in of ming@contoso.com no longer works',
      );
      // Said again, from the account itself, without asking Microsoft.
      const asked = fake.requests.length;
      await expect(checkMail(trigger, prev, connectors, slow(2000), service)).rejects.toBeInstanceOf(MailSignInError);
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
      timeoutMs: slow(2000),
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

    // Its refresh refused for good: the connection that drops is not opened again for as long as a refused
    // password waits (60 s here), not at the 20 ms a dropped connection waits: the account is not even
    // asked again meanwhile, nor a token.
    now += 61 * MIN;
    fake.refreshAnswer = invalidGrant;
    imap.drop();
    await vi.waitFor(() => expect(service.view().accounts[0]!.status).toBe('reauth'));
    const problem = vi.spyOn(service, 'problem');
    const token = vi.spyOn(service, 'mailToken');
    // Its sign-in's state changed: a new connection, which finds at once that the account needs a new sign-in.
    watcher.sync();
    const asked = problem.mock.calls.length;
    expect(asked).toBeGreaterThan(0);
    await sleep(slow(300));
    expect(problem.mock.calls.length).toBe(asked);
    expect(token).not.toHaveBeenCalled();
    expect(imap.xoauth2).toHaveLength(2);
    expect(imap.idling).toBe(0);
    problem.mockRestore();
    token.mockRestore();

    // Signed in again: the next sync connects at once.
    fake.refreshAnswer = undefined;
    now += MIN;
    await signIn(['mail']);
    watcher.sync();
    await vi.waitFor(() => expect(imap.idling).toBe(1));
    expect(imap.xoauth2).toHaveLength(3);
    expect(imap.xoauth2[2]!.ok).toBe(true);
  });

  it("connects again at once with a fresh token when the server ends a session that listened a while (Exchange Online's AccessTokenExpired), without a warning", async () => {
    imap.idle = true;
    const id = (await signIn(['mail'])).account!.id;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let clock = T0;
    const checked: string[] = [];
    const watcher = new IdleWatcher({
      connectors,
      oauth: service,
      watching: () => [{ conversationId: 'c1', trigger: { source: 'mail', account: id, folder: 'INBOX' } }],
      check: async (c) => void checked.push(c),
      settleMs: 20,
      // A failure would wait a minute: a connection that comes at once is no failure.
      backoffMs: [60_000],
      loginBackoffMs: [60_000],
      renewMs: 60_000,
      timeoutMs: slow(2000),
      now: () => clock,
    });
    closers.push(() => watcher.stop());
    watcher.sync();
    await vi.waitFor(() => expect(imap.idling).toBe(1));
    // It listened a whole round's while (30 s here), then the server ended the session of its token.
    clock += 31_000;
    const before = grants('refresh_token').length;
    imap.bye('Session invalidated - AccessTokenExpired');
    await vi.waitFor(() => expect(imap.xoauth2).toHaveLength(2));
    await vi.waitFor(() => expect(imap.idling).toBe(1));
    // A fresh token (asked although the kept one had not run out by the clock here), taken; no warning;
    // and a check, for mail that came while it was not listening.
    expect(grants('refresh_token')).toHaveLength(before + 1);
    expect(imap.xoauth2[1]).toMatchObject({ ok: true });
    expect(imap.xoauth2[1]!.token).not.toBe(imap.xoauth2[0]!.token);
    expect(warn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(checked).toEqual(['c1']));

    // A BYE soon after it began to listen is a failure: said, and waited for.
    imap.bye('Session invalidated - AccessTokenExpired');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]![0])).toContain('AccessTokenExpired');
    await sleep(slow(200));
    expect(imap.xoauth2).toHaveLength(2);
    expect(imap.idling).toBe(0);
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
    const orchestrator = new Orchestrator(store, hub, settings);
    const app = createApp({
      auth,
      store,
      settings,
      hub,
      orchestrator,
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
    return { call, HOST, orchestrator };
  }
  const error = async (res: Response) => ((await res.json()) as { error: string }).error;

  it('starts a sign-in for its uses, adds and tests the mail account over XOAUTH2, keeps its servers fixed, and removes it with its account', async () => {
    const { call, HOST } = await signedInApp();
    for (const uses of [[], ['mail', 'drive'], 'mail']) {
      const bad = await call('POST', '/api/oauth/signins', { provider: 'microsoft', uses });
      expect(bad.status).toBe(400);
      expect(await error(bad)).toContain('uses');
    }
    for (const account of [42, '', 'x'.repeat(65)]) {
      const bad = await call('POST', '/api/oauth/signins', { provider: 'microsoft', uses: ['mail'], account });
      expect(bad.status).toBe(400);
      expect(await error(bad)).toContain('account');
    }
    expect((await call('POST', '/api/oauth/signins', { provider: 'microsoft', uses: ['mail'], account: 'nobody' })).status).toBe(404);
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

  it('signs an account in again for its uses with its address as the hint, and sends an outbox item through its route over XOAUTH2', async () => {
    const { call, orchestrator } = await signedInApp();
    const id = (await signIn(['calendar'])).account!.id;
    // Use for mail: the account's uses with mail, its address as the sign-in page's hint.
    const started = (await (
      await call('POST', '/api/oauth/signins', { provider: 'microsoft', uses: ['mail'], account: id, origin: 'http://localhost:5173' })
    ).json()) as OAuthSignInView;
    const q = new URL(started.authorizeUrl!).searchParams;
    expect(q.get('login_hint')).toBe('ming@contoso.com');
    expect(q.get('scope')).toContain('Calendars.ReadWrite');
    expect(q.get('scope')).toContain(`${OUTLOOK}/SMTP.Send`);
    await call('POST', '/api/oauth/callback', callbackParams(fake.allow(started.authorizeUrl!)));
    expect(((await (await call('GET', '/api/oauth')).json()) as OAuthView).accounts[0]).toMatchObject({ id, uses: ['calendar', 'mail'] });

    // An agent's mail waits in the outbox; the user's Send, through its route, sends it from the account
    // its card showed, signed in with a token (the one kept refused: renewed once).
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });
    const conv = (await (
      await call('POST', '/api/conversations', {
        agents: [{ name: 'Alice', provider: 'claude', role: '' }],
        settings: { mode: 'roundtable', permission: 'edit', cwd: project },
      })
    ).json()) as { id: string };
    orchestrator.outbox = new Outbox(db);
    orchestrator.gateway = { tool: (name: string) => tools()[name] } as never;
    const args = tools().mail_send!.bind!({ to: 'bob@example.com', subject: 'Paid', body: 'Done.' });
    const { item } = orchestrator.outbox.add(
      { convId: conv.id, messageId: 'm', agentId: 'a', agentName: 'Alice', tool: 'mail_send', title: 'Paid', preview: { fields: [] } },
      args,
    );
    fake.accessTokens.set(await service.mailToken(id), false);
    expect(smtp.sent).toEqual([]);
    const sent = await call('POST', `/api/conversations/${conv.id}/outbox/${item.id}`, { action: 'send' });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ id: item.id, status: 'sent', result: expect.stringContaining('127.0.0.1') });
    expect(smtp.sent).toEqual([expect.objectContaining({ from: 'ming@contoso.com', to: ['bob@example.com'] })]);
    expect(smtp.xoauth2.map((x) => [x.user, x.ok])).toEqual([
      ['ming@contoso.com', false],
      ['ming@contoso.com', true],
    ]);
    // Once: a second Send is refused, and nothing goes twice.
    expect((await call('POST', `/api/conversations/${conv.id}/outbox/${item.id}`, { action: 'send' })).status).toBe(409);
    expect(smtp.sent).toHaveLength(1);
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
