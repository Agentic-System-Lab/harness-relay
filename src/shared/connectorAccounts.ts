import { CONNECTOR_LIMITS, type CalendarAccountView } from './types';

type CalendarIdentity = Pick<CalendarAccountView, 'name' | 'url' | 'username'>;

// CalDAV collection addresses may arrive with or without their trailing slash. The path remains case-sensitive.
function collectionKey(value: string): string {
  if (!URL.canParse(value)) return value;
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

function clipped(value: string, size: number): string {
  return value
    .slice(0, size)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();
}

export function collectionName(name: string): string {
  return clipped(name.replace(/[\r\n]+/g, ' ').trim(), CONNECTOR_LIMITS.name);
}

/** A discovered collection keeps its name if free. Identically named collections get the account and, if needed, a number. */
export function discoveredCalendar(accounts: readonly CalendarIdentity[], item: Pick<CalendarIdentity, 'url' | 'name'>, username: string) {
  const login = username.trim();
  const key = collectionKey(item.url);
  // Apple Account email addresses are case-insensitive. Other CalDAV login names can be case-sensitive.
  const sameUser = (other: string) => (login.includes('@') ? other.trim().toLowerCase() === login.toLowerCase() : other.trim() === login);
  const existing = accounts.find((c) => sameUser(c.username) && collectionKey(c.url) === key);
  if (existing) return { name: existing.name, added: true };
  const base = collectionName(item.name);
  const names = new Set(accounts.map((c) => c.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return { name: base, added: false };
  for (let n = 1; ; n++) {
    const number = n === 1 ? '' : ' (' + n + ')';
    const limit = CONNECTOR_LIMITS.name - number.length - 3;
    const owner = clipped(login, limit - Math.min(base.length, 20));
    const name = clipped(base, limit - owner.length) + ' · ' + owner + number;
    if (!names.has(name.toLowerCase())) return { name, added: false };
  }
}

/** A new account's id, from its name, not taken by another (`work`, `work-2`…). */
export function newAccountId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'account';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}
