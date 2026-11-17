import { describe, expect, it } from 'vitest';
import { MAIL_PRESETS, calendarForm, calendarUpdate, mailForm, mailUpdate, newAccountId, withPreset } from '../src/web/connectors';

describe("the mail and calendar accounts' forms", () => {
  it("fills in a provider's servers, saves what the form says, and keeps the password unless one is typed", () => {
    const gmail = MAIL_PRESETS.find((p) => p.id === 'gmail')!;
    const f = { ...withPreset(mailForm(), gmail), address: 'Me <me@gmail.com>' };
    expect(f).toMatchObject({ name: 'Gmail', imapHost: 'imap.gmail.com', imapPort: '993', imapSecurity: 'tls', smtpHost: 'smtp.gmail.com', smtpPort: '465' });
    // The user name is the bare address unless one is given.
    expect(mailUpdate(f)).toEqual({
      name: 'Gmail',
      address: 'Me <me@gmail.com>',
      username: 'me@gmail.com',
      imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    });
    expect(mailUpdate({ ...f, password: 'abcd efgh', username: 'other' })).toMatchObject({ password: 'abcd efgh', username: 'other' });
    const saved = { id: 'work', name: 'Work', address: 'a@b.com', username: 'a', imap: { host: 'i', port: 1, security: 'starttls' as const }, smtp: { host: 's', port: 2, security: 'tls' as const }, password: '••••' };
    expect(mailForm(saved)).toMatchObject({ name: 'Work', password: '', imapPort: '1', imapSecurity: 'starttls' });
    // A preset keeps a name already typed.
    expect(withPreset({ ...mailForm(), name: 'Mine' }, gmail).name).toBe('Mine');
  });

  it('saves a calendar without an empty address or password', () => {
    expect(calendarUpdate({ ...calendarForm(), name: ' Home ', url: ' https://caldav.icloud.com/ ', username: 'me' })).toEqual({ name: 'Home', url: 'https://caldav.icloud.com/', username: 'me' });
    expect(calendarUpdate({ name: 'H', url: 'u', username: 'me', address: 'me@x.com', password: 'p' })).toEqual({ name: 'H', url: 'u', username: 'me', address: 'me@x.com', password: 'p' });
  });

  it("makes a new account's id from its name, never one taken", () => {
    expect(newAccountId('Work Mail', [])).toBe('work-mail');
    expect(newAccountId('Work Mail', ['work-mail', 'work-mail-2'])).toBe('work-mail-3');
    expect(newAccountId('工作', [])).toBe('account');
  });
});
