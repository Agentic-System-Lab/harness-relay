import {
  CONNECTOR_LIMITS,
  type CalendarAccountUpdate,
  type CalendarAccountView,
  type ConnectorsView,
  type KeyStorage,
  type MailAccountUpdate,
  type MailAccountView,
} from '../../shared/types';
import type { Database } from '../db';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { SecretStore } from '../secrets';
import { sameProvider } from './caldav';

/*
 * The mail accounts and calendars the mail and calendar tools use (Settings → Tool library), kept
 * under `connectors` in `app_settings` without their passwords, which go to the OS credential store
 * (or the database encrypted, `secrets.ts`), one entry each: `mail-<id>`, `calendar-<id>`. The UI only
 * sees them masked, and no CLI ever gets them: the tools run in the server.
 */

type StoredMail = Omit<MailAccountView, 'password'>;
type StoredCalendar = Omit<CalendarAccountView, 'password'>;

interface Stored {
  mail: StoredMail[];
  calendar: StoredCalendar[];
  /** Without a credential store (tests only): the passwords, by entry name. */
  passwords?: Record<string, string>;
}

const KEY = 'connectors';

export class ConnectorStore {
  /** How many times each mail account was saved (`mailSaves()`). */
  private saves = new Map<string, number>();
  private data: Stored = { mail: [], calendar: [] };
  private passwords = new Map<string, string>();

  constructor(
    private db: Database,
    private keyring?: SecretStore,
  ) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (row) {
      try {
        const v = JSON.parse(row.value) as Partial<Stored>;
        this.data = { mail: Array.isArray(v.mail) ? v.mail : [], calendar: Array.isArray(v.calendar) ? v.calendar : [] };
        if (!keyring && v.passwords) for (const [k, p] of Object.entries(v.passwords)) this.passwords.set(k, p);
      } catch {
        /* none */
      }
    }
  }

  private save(): void {
    const stored: Stored = {
      mail: this.data.mail,
      calendar: this.data.calendar,
      ...(this.keyring ? {} : { passwords: Object.fromEntries(this.passwords) }),
    };
    this.db
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(KEY, JSON.stringify(stored));
  }

  private get storage(): KeyStorage {
    return this.keyring?.storage ?? 'database';
  }

  /** An account's password ('' when none, or the store cannot be read now). */
  private password(name: string): string {
    if (!this.keyring) return this.passwords.get(name) ?? '';
    try {
      return this.keyring.get(name) ?? '';
    } catch {
      return '';
    }
  }

  private setPassword(name: string, value: string | undefined): void {
    if (value === undefined) return;
    if (!this.keyring) {
      if (value) this.passwords.set(name, value);
      else this.passwords.delete(name);
      return;
    }
    try {
      if (value) this.keyring.set(name, value);
      else this.keyring.delete(name);
    } catch (err) {
      throw new HttpError(503, t().connectorPasswordNotSaved((err as Error).message));
    }
  }

  view(): ConnectorsView {
    return {
      mail: this.data.mail.map((m) => ({ ...m, password: maskPassword(this.password(`mail-${m.id}`)) })),
      calendar: this.data.calendar.map((c) => ({ ...c, password: maskPassword(this.password(`calendar-${c.id}`)) })),
      secretStorage: this.storage,
    };
  }

  saveMail(id: string, u: MailAccountUpdate): ConnectorsView {
    const list = this.data.mail;
    const i = list.findIndex((m) => m.id === id);
    if (i < 0 && list.length >= CONNECTOR_LIMITS.accounts) throw new HttpError(400, t().connectorTooMany(CONNECTOR_LIMITS.accounts));
    if (list.some((m) => m.id !== id && m.name.toLowerCase() === u.name.toLowerCase()))
      throw new HttpError(409, t().connectorNameTaken(u.name));
    if (i < 0 && !u.password) throw new HttpError(400, t().connectorPasswordRequired);
    // The kept password goes only to the servers it was given for.
    if (i >= 0 && !u.password && !sameMailServers(list[i]!, u)) throw new HttpError(400, t().connectorPasswordAgain);
    this.setPassword(`mail-${id}`, u.password);
    this.saves.set(id, (this.saves.get(id) ?? 0) + 1);
    const { password: _p, ...rest } = u;
    const account: StoredMail = { id, ...rest };
    if (i < 0) list.push(account);
    else list[i] = account;
    this.save();
    return this.view();
  }

  saveCalendar(id: string, u: CalendarAccountUpdate): ConnectorsView {
    const list = this.data.calendar;
    const i = list.findIndex((c) => c.id === id);
    // A calendar reached through a sign-in never turns into one with a password: it is removed and added again.
    if (i >= 0 && list[i]!.oauth) throw new HttpError(409, t().oauthCalendarFixed);
    if (i < 0 && list.length >= CONNECTOR_LIMITS.accounts) throw new HttpError(400, t().connectorTooMany(CONNECTOR_LIMITS.accounts));
    if (list.some((c) => c.id !== id && c.name.toLowerCase() === u.name.toLowerCase()))
      throw new HttpError(409, t().connectorNameTaken(u.name));
    if (i < 0 && !u.password) throw new HttpError(400, t().connectorPasswordRequired);
    if (i >= 0 && !u.password && !keptPasswordFits(list[i]!.url, u.url)) throw new HttpError(400, t().connectorPasswordAgain);
    this.setPassword(`calendar-${id}`, u.password);
    const { password: _p, ...rest } = u;
    const account: StoredCalendar = { id, ...rest };
    if (i < 0) list.push(account);
    else list[i] = account;
    this.save();
    return this.view();
  }

  /**
   * A calendar reached through an account that signs in with OAuth (`oauth`, its id): its name and its
   * address at the provider, with no password; the account's address as its user name. Added, or
   * renamed when it is there already.
   */
  saveOAuthCalendar(id: string, c: { name: string; url: string; oauth: string; email: string }): ConnectorsView {
    const list = this.data.calendar;
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0 && list[i]!.oauth !== c.oauth) throw new HttpError(409, t().connectorNameTaken(id));
    if (i < 0 && list.length >= CONNECTOR_LIMITS.accounts) throw new HttpError(400, t().connectorTooMany(CONNECTOR_LIMITS.accounts));
    if (list.some((x) => x.id !== id && x.name.toLowerCase() === c.name.toLowerCase()))
      throw new HttpError(409, t().connectorNameTaken(c.name));
    const account: StoredCalendar = { id, name: c.name, url: c.url, username: c.email, address: c.email, oauth: c.oauth };
    if (i < 0) list.push(account);
    else list[i] = account;
    this.save();
    return this.view();
  }

  /** The calendars reached through an account that signs in with OAuth (its id). */
  oauthCalendars(oauth: string): StoredCalendar[] {
    return this.data.calendar.filter((c) => c.oauth === oauth);
  }

  /** The account is gone: so are the calendars reached through it. */
  removeOAuthCalendars(oauth: string): void {
    const before = this.data.calendar.length;
    this.data.calendar = this.data.calendar.filter((c) => c.oauth !== oauth);
    if (this.data.calendar.length !== before) this.save();
  }

  /** Every calendar, without its password. */
  calendarAccounts(): StoredCalendar[] {
    return [...this.data.calendar];
  }

  /** The calendar ids taken (a new one's is not one of them). */
  calendarIds(): string[] {
    return this.data.calendar.map((c) => c.id);
  }

  delete(kind: 'mail' | 'calendar', id: string): ConnectorsView {
    const list = this.data[kind] as { id: string }[];
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) throw new HttpError(404, t().connectorNotFound(id));
    list.splice(i, 1);
    try {
      this.setPassword(`${kind}-${id}`, '');
    } catch {
      /* gone from the list all the same */
    }
    this.save();
    return this.view();
  }

  /** The mail account named (by its name or id; the first one when none is named), with its password. */
  mail(which?: string): { account: StoredMail; password: string } | undefined {
    const a = pick(this.data.mail, which);
    return a && { account: a, password: this.password(`mail-${a.id}`) };
  }

  calendar(which?: string): { account: StoredCalendar; password: string } | undefined {
    const a = pick(this.data.calendar, which);
    return a && { account: a, password: this.password(`calendar-${a.id}`) };
  }

  /** The mail account with this id, without reading its password (nothing is asked of the credential store). */
  mailAccount(id: string): StoredMail | undefined {
    return this.data.mail.find((m) => m.id === id);
  }

  /** How many times the mail account was saved since the server started: its password may have changed. */
  mailSaves(id: string): number {
    return this.saves.get(id) ?? 0;
  }

  /** The mail account with this id (never by name), with its password. */
  mailById(id: string): { account: StoredMail; password: string } | undefined {
    const a = this.data.mail.find((m) => m.id === id);
    return a && { account: a, password: this.password(`mail-${a.id}`) };
  }

  calendarById(id: string): { account: StoredCalendar; password: string } | undefined {
    const a = this.data.calendar.find((c) => c.id === id);
    return a && { account: a, password: this.password(`calendar-${a.id}`) };
  }

  hasMail(): boolean {
    return this.data.mail.length > 0;
  }

  hasCalendar(): boolean {
    return this.data.calendar.length > 0;
  }

  /** The accounts' names, for the tools' descriptions. */
  names(kind: 'mail' | 'calendar'): string[] {
    return this.data[kind].map((a) => a.name);
  }
}

/** The same mail servers as before: the kept password may go on to them (no weaker security either). */
function sameMailServers(before: StoredMail, after: MailAccountUpdate): boolean {
  const same = (a: StoredMail['imap'], b: StoredMail['imap']) =>
    a.host.toLowerCase() === b.host.toLowerCase() && (b.security !== 'none' || a.security === 'none');
  return same(before.imap, after.imap) && same(before.smtp, after.smtp);
}

/** Whether a calendar's kept password may go to `next`: an address of the same provider as the one it was given for. */
export function keptPasswordFits(given: string, next: string): boolean {
  try {
    return sameProvider(given, next);
  } catch {
    return false;
  }
}

/** A password as the UI shows it: that there is one, never any of its characters (unlike an API key's last four). */
function maskPassword(password: string): string {
  return password ? '••••' : '';
}

function pick<T extends { id: string; name: string }>(list: T[], which?: string): T | undefined {
  if (!which?.trim()) return list[0];
  const w = which.trim().toLowerCase();
  // An id first: an account named like another's id never stands in for it.
  return list.find((a) => a.id === which) ?? list.find((a) => a.name.toLowerCase() === w);
}
