import type { MailAccountView } from '../../shared/types';
import { ImapClient } from './imap';
import { withSmtp } from './smtp';

/*
 * Trying a mail account from Settings: signing in to its IMAP server, and to its SMTP server, without
 * sending anything.
 */
export async function testMail(account: Omit<MailAccountView, 'password'>, password: string, timeoutMs = 15_000): Promise<void> {
  const login = { username: account.username, password };
  const imap = await ImapClient.open(account.imap, login, timeoutMs);
  await imap.logout();
  await withSmtp(account.smtp, login, async () => undefined, timeoutMs);
}
