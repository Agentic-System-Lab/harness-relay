import type { MailAccountView } from '../../shared/types';
import { mailLogin, openImap, withSmtpLogin, type MailOAuth } from './mailLogin';

/*
 * Trying a mail account from Settings: signing in to its IMAP server, and to its SMTP server, without
 * sending anything; with its password, or with its OAuth account's token for mail (XOAUTH2).
 */
export async function testMail(
  account: Omit<MailAccountView, 'password'>,
  password: string,
  oauth?: MailOAuth,
  timeoutMs = 15_000,
): Promise<void> {
  const login = mailLogin(account, password, oauth);
  const imap = await openImap(login, timeoutMs);
  await imap.logout();
  await withSmtpLogin(login, async () => undefined, timeoutMs);
}
