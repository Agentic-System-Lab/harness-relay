import type { MailAccountView, MailServer } from '../../shared/types';
import { t } from '../i18n';
import { ImapClient, ImapLoginError, type Login, type ServerAddress } from './imap';
import { deliver, SmtpLoginError, withSmtp, type Envelope, type SmtpSession } from './smtp';

/*
 * How a mail account signs in to its servers, in one place for the mail tools, Test, the mail trigger
 * and IMAP IDLE: with its password (IMAP LOGIN, SMTP AUTH PLAIN or LOGIN), or, for one reached through
 * an account that signs in with OAuth, with a token for mail from the token broker (SASL XOAUTH2), sent
 * only to its provider's own servers, over TLS or STARTTLS (plain only to a stand-in on this computer).
 * A token the server refuses is renewed once and tried again, as Graph's 401 is; an account that needs
 * a new sign-in says so (`MailSignInError`), before any server is asked.
 */

/** How the mail accounts of accounts that sign in with OAuth are reached (`OAuthService`). */
export interface MailOAuth {
  /** Its provider's own mail servers, the only ones its token goes to, and the user name to sign in with (the account's address). */
  mailVia(oauthAccount: string): { imap: MailServer; smtp: MailServer; username: string };
  /** An access token for mail (`fresh`: a new one, the server refused the one kept). */
  mailToken(oauthAccount: string, fresh?: boolean): Promise<string>;
  /** Why the account cannot be used now (it needs signing in again, or is gone); undefined when it can. */
  problem(oauthAccount: string, use?: 'mail'): string | undefined;
  /** What changes whenever its sign-in does (it came to need a new one, or was signed in again): IDLE connects again then. */
  signInState(oauthAccount: string): string;
}

/** The account the mail account is reached through needs a new sign-in, or is gone: trying again soon will not help. */
export class MailSignInError extends Error {}

/** Where a mail account's servers are, and how it signs in to them. */
export interface MailLogin {
  imap: ServerAddress;
  smtp: ServerAddress;
  /** The user name with the password, or with a token (`fresh`: a new one, the server refused the one before). */
  login(fresh?: boolean): Promise<Login>;
  /** It signs in with a token: a refusal is tried once more with a new one. */
  oauth: boolean;
}

type Account = Omit<MailAccountView, 'password'>;

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i;

/**
 * A mail account's servers and sign-in: its own servers and password, or its OAuth account's provider's
 * servers and a token for mail. A password that cannot be read, or an account that needs a new sign-in,
 * is an error here, before any server is asked.
 */
export function mailLogin(account: Account, password: string, oauth?: MailOAuth): MailLogin {
  if (!account.oauth) {
    if (!password) throw new Error(t().watchNoPassword(account.name));
    const login = { username: account.username, password };
    return { imap: account.imap, smtp: account.smtp, login: async () => login, oauth: false };
  }
  const id = account.oauth;
  if (!oauth) throw new MailSignInError(t().oauthNotHere(account.name));
  const problem = oauth.problem(id, 'mail');
  if (problem) throw new MailSignInError(problem);
  const via = oauth.mailVia(id);
  // The token never goes in the clear but to a stand-in on this computer.
  for (const s of [via.imap, via.smtp]) if (s.security === 'none' && !LOOPBACK.test(s.host)) throw new Error(t().oauthHostRefused(s.host));
  return {
    imap: via.imap,
    smtp: via.smtp,
    oauth: true,
    login: async (fresh = false) => {
      try {
        return { username: via.username, token: await oauth.mailToken(id, fresh) };
      } catch (err) {
        // Its refresh was refused just now: it needs a new sign-in, which it says.
        const now = oauth.problem(id, 'mail');
        throw now ? new MailSignInError(now) : err;
      }
    },
  };
}

/**
 * An IMAP connection, signed in; a token the server refuses is renewed and tried once more. `fresh`: a
 * new token from the start (the server ended the session the one before signed in, as it ran out).
 */
export async function openImap(m: MailLogin, timeoutMs = 30_000, signal?: AbortSignal, fresh = false): Promise<ImapClient> {
  try {
    return await ImapClient.open(m.imap, await m.login(fresh), timeoutMs, signal);
  } catch (err) {
    if (!m.oauth || !(err instanceof ImapLoginError) || signal?.aborted) throw err;
    return ImapClient.open(m.imap, await m.login(true), timeoutMs, signal);
  }
}

/**
 * An SMTP session, signed in; a token the server refuses is renewed and tried once more (a refused
 * sign-in comes before anything is sent, so nothing goes twice).
 */
export async function withSmtpLogin<T>(m: MailLogin, fn: SmtpSession<T>, timeoutMs = 30_000): Promise<T> {
  try {
    return await withSmtp(m.smtp, await m.login(), fn, timeoutMs);
  } catch (err) {
    if (!m.oauth || !(err instanceof SmtpLoginError)) throw err;
    return withSmtp(m.smtp, await m.login(true), fn, timeoutMs);
  }
}

/** Sends one message from the account. Resolves with the server's last answer (its queue id, often). */
export function sendMailAs(m: MailLogin, envelope: Envelope, raw: string, timeoutMs = 30_000): Promise<string> {
  return withSmtpLogin(m, deliver(envelope, raw), timeoutMs);
}
