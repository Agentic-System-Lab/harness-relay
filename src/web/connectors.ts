// The mail and calendar accounts' forms (Settings → Tool library), without React: the providers'
// usual servers, a new account's id, and what a form saves.

import type { CalendarAccountUpdate, CalendarAccountView, MailAccountUpdate, MailAccountView, MailSecurity } from '../shared/types';

export interface MailPreset {
  id: string;
  label: string;
  imap: { host: string; port: number; security: MailSecurity };
  smtp: { host: string; port: number; security: MailSecurity };
}

/** Providers whose servers take an app password, and their usual settings. */
export const MAIL_PRESETS: MailPreset[] = [
  {
    id: 'icloud',
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' },
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
  },
];

export const ICLOUD_CALENDAR_URL = 'https://caldav.icloud.com/';

/** Calendar servers that find an account's calendars from their own address. */
export const CALENDAR_PRESETS = [
  { id: 'icloud', label: 'iCloud', url: ICLOUD_CALENDAR_URL },
  { id: 'fastmail', label: 'Fastmail', url: 'https://caldav.fastmail.com/dav/' },
];

/** The form of a mail account (every field a string, as inputs keep them). */
export interface MailForm {
  name: string;
  address: string;
  username: string;
  password: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: MailSecurity;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: MailSecurity;
}

export function mailForm(a?: MailAccountView): MailForm {
  return {
    name: a?.name ?? '',
    address: a?.address ?? '',
    username: a?.username ?? '',
    password: '',
    imapHost: a?.imap.host ?? '',
    imapPort: String(a?.imap.port ?? 993),
    imapSecurity: a?.imap.security ?? 'tls',
    smtpHost: a?.smtp.host ?? '',
    smtpPort: String(a?.smtp.port ?? 465),
    smtpSecurity: a?.smtp.security ?? 'tls',
  };
}

/** A provider's servers in the form (and the address as the user name, when there is none yet). */
export function withPreset(f: MailForm, preset: MailPreset): MailForm {
  return {
    ...f,
    name: f.name || preset.label,
    imapHost: preset.imap.host,
    imapPort: String(preset.imap.port),
    imapSecurity: preset.imap.security,
    smtpHost: preset.smtp.host,
    smtpPort: String(preset.smtp.port),
    smtpSecurity: preset.smtp.security,
  };
}

/** What the form saves: an empty password keeps the one kept. */
export function mailUpdate(f: MailForm): MailAccountUpdate {
  return {
    name: f.name.trim(),
    address: f.address.trim(),
    username: (f.username || f.address.replace(/^.*<|>.*$/g, '')).trim(),
    imap: { host: f.imapHost.trim(), port: Number(f.imapPort), security: f.imapSecurity },
    smtp: { host: f.smtpHost.trim(), port: Number(f.smtpPort), security: f.smtpSecurity },
    ...(f.password ? { password: f.password } : {}),
  };
}

export interface CalendarForm {
  name: string;
  url: string;
  username: string;
  address: string;
  password: string;
}

export function calendarForm(a?: CalendarAccountView): CalendarForm {
  return { name: a?.name ?? '', url: a?.url ?? '', username: a?.username ?? '', address: a?.address ?? '', password: '' };
}

export function calendarUpdate(f: CalendarForm): CalendarAccountUpdate {
  return {
    name: f.name.trim(),
    url: f.url.trim(),
    username: f.username.trim(),
    ...(f.address.trim() ? { address: f.address.trim() } : {}),
    ...(f.password ? { password: f.password } : {}),
  };
}

export { newAccountId } from '../shared/connectorAccounts';
