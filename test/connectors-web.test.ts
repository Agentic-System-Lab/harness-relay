import { collectionName, discoveredCalendar } from '../src/shared/connectorAccounts';
import { describe, expect, it } from 'vitest';
import { MAIL_PRESETS, calendarForm, calendarUpdate, mailForm, mailUpdate, newAccountId, withPreset } from '../src/web/connectors';

describe("the mail and calendar accounts' forms", () => {
  it("fills in a provider's servers, saves what the form says, and keeps the password unless one is typed", () => {
    expect(MAIL_PRESETS.map((p) => p.id)).not.toContain('gmail');
    const fastmail = MAIL_PRESETS.find((p) => p.id === 'fastmail')!;
    const f = { ...withPreset(mailForm(), fastmail), address: 'Me <me@fastmail.com>' };
    expect(f).toMatchObject({
      name: 'Fastmail',
      imapHost: 'imap.fastmail.com',
      imapPort: '993',
      imapSecurity: 'tls',
      smtpHost: 'smtp.fastmail.com',
      smtpPort: '465',
    });
    // The user name is the bare address unless one is given.
    expect(mailUpdate(f)).toEqual({
      name: 'Fastmail',
      address: 'Me <me@fastmail.com>',
      username: 'me@fastmail.com',
      imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
      smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
    });
    expect(mailUpdate({ ...f, password: 'abcd efgh', username: 'other' })).toMatchObject({ password: 'abcd efgh', username: 'other' });
    const saved = {
      id: 'work',
      name: 'Work',
      address: 'a@b.com',
      username: 'a',
      imap: { host: 'i', port: 1, security: 'starttls' as const },
      smtp: { host: 's', port: 2, security: 'tls' as const },
      password: '••••',
    };
    expect(mailForm(saved)).toMatchObject({ name: 'Work', password: '', imapPort: '1', imapSecurity: 'starttls' });
    // A preset keeps a name already typed.
    expect(withPreset({ ...mailForm(), name: 'Mine' }, fastmail).name).toBe('Mine');
  });

  it('fits long discovered names and their account and number into the display limit without splitting Unicode characters', () => {
    const name = '筆記📅'.repeat(20) + '業務';
    const username = 'a'.repeat(80) + '@example.test';
    const item = { name, url: 'https://p42-caldav.icloud.com/calendar/' };
    const base = collectionName(name);
    expect(base.length).toBeLessThanOrEqual(60);
    const accounts = [{ name: base, username: 'other@example.test', url: item.url }];
    const qualified = discoveredCalendar(accounts, item, username);
    expect(qualified).toMatchObject({ added: false });
    expect(qualified.name).toContain(' · a');
    expect(qualified.name.length).toBeLessThanOrEqual(60);
    accounts.push({ name: qualified.name, username, url: item.url + 'elsewhere/' });
    const numbered = discoveredCalendar(accounts, item, username);
    expect(numbered.name).toMatch(/ \(2\)$/);
    expect(numbered.name.length).toBeLessThanOrEqual(60);
    for (const value of [base, qualified.name, numbered.name])
      expect(Array.from(value).some((c) => c.length === 1 && /[\uD800-\uDFFF]/.test(c))).toBe(false);
  });

  it('saves a calendar without an empty address or password', () => {
    expect(calendarUpdate({ ...calendarForm(), name: ' Home ', url: ' https://caldav.icloud.com/ ', username: 'me' })).toEqual({
      name: 'Home',
      url: 'https://caldav.icloud.com/',
      username: 'me',
    });
    expect(calendarUpdate({ name: 'H', url: 'u', username: 'me', address: 'me@x.com', password: 'p' })).toEqual({
      name: 'H',
      url: 'u',
      username: 'me',
      address: 'me@x.com',
      password: 'p',
    });
  });

  it("makes a new account's id from its name, never one taken", () => {
    expect(newAccountId('Work Mail', [])).toBe('work-mail');
    expect(newAccountId('Work Mail', ['work-mail', 'work-mail-2'])).toBe('work-mail-3');
    expect(newAccountId('工作', [])).toBe('account');
  });
});
