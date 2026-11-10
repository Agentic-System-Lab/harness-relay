import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { codeFromBytes, normalizeCode } from '../shared/auth';
import type { AuthSessionView } from '../shared/types';
import type { Database } from './db';

/*
 * Signed-in browsers. The API takes a request only from one: it shows a cookie (HttpOnly, so no page
 * script reads it; most browsers keep it encrypted on disk) and, for anything but loading files, a key
 * in a header (kept in the UI's own origin, which a page on another port of this computer cannot
 * read, while a cookie goes to every port). Only hashes of both are stored, so a program that reads
 * the database (as an agent's sandbox lets it) cannot sign in with them. A code is short enough to
 * type, so it gets a slow hash of its own (scrypt): a fast one could be undone by trying every code.
 *
 * A browser signs in with a one-time code: from the link the server prints when it starts, from
 * `npm run login`, or from a browser already signed in (Settings → Signed-in browsers), for a phone.
 */

/** The cookie that names a signed-in browser's session: `<id>.<secret>`. */
export const SESSION_COOKIE = 'relay_session';

/** How long a sign-in code works: the one printed at start, and the others (for another device, `npm run login`). */
export const CODE_TTL_MS = {
  startup: 60 * 60_000,
  device: 10 * 60_000,
  /**
   * The links the desktop app opens: the browser uses one at once, and on Windows and Linux the link
   * is on the browser's command line for a moment, where other programs could read it.
   */
  desktop: 60_000,
};

/** How long a browser stays signed in (the longest a browser keeps a cookie); the server holds to it too. */
export const SESSION_MAX_AGE_S = 400 * 24 * 60 * 60;

/** Wrong codes allowed per minute; more are refused until the minute is over. */
const FAILURES_PER_MINUTE = 10;

/** How often a session's last use is written (it is shown, not relied on). */
const TOUCH_EVERY_MS = 60_000;

/** Codes that work at once, the newest kept: a sign-in tries each of them, slowly on purpose. */
const MAX_CODES = 5;

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const hex = (value: string) => sha256(value).toString('hex');
const token = () => randomBytes(32).toString('base64url');

/** Compares a secret with a stored hex hash in constant time. */
function matches(secret: string, storedHex: string, hash: (secret: string) => Buffer = sha256): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  const given = hash(secret);
  return stored.length === given.length && timingSafeEqual(stored, given);
}

/**
 * A code as stored: `<salt>:<scrypt hash>` in hex. 40 bits take a fast hash minutes to hours to undo
 * by trying each code; with scrypt (about 40 ms a try, and its own salt for each code) it takes years.
 */
function codeHash(code: string, salt: Buffer = randomBytes(16)): string {
  return `${salt.toString('hex')}:${scryptSync(code, salt, 32).toString('hex')}`;
}

/** Whether a stored code (`codeHash()`) is this one. */
function isCode(code: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  return Boolean(salt && hash) && matches(code, hash!, (c) => scryptSync(c, Buffer.from(salt!, 'hex'), 32));
}

/** A browser just signed in: its cookie value and the key its UI sends. */
export interface SignedIn {
  id: string;
  cookie: string;
  key: string;
}

interface SessionRow {
  id: string;
  cookie_hash: string;
  key_hash: string;
  label: string | null;
  created_at: number;
  last_used_at: number;
}

export class AuthStore {
  private failures: number[] = [];

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new one-time code, working for `ttlMs`. Only its hash is stored; the oldest codes past `MAX_CODES` stop working. */
  createCode(ttlMs: number): { code: string; expiresAt: number } {
    const code = codeFromBytes(randomBytes(16));
    const expiresAt = this.now() + ttlMs;
    this.prune();
    this.db
      .prepare('DELETE FROM auth_codes WHERE rowid NOT IN (SELECT rowid FROM auth_codes ORDER BY rowid DESC LIMIT ?)')
      .run(MAX_CODES - 1);
    this.db.prepare('INSERT INTO auth_codes (hash, expires_at) VALUES (?, ?)').run(codeHash(normalizeCode(code)!), expiresAt);
    return { code, expiresAt };
  }

  /** Too many wrong codes in the last minute: refuse more for now. */
  tooManyFailures(): boolean {
    const since = this.now() - 60_000;
    this.failures = this.failures.filter((t) => t > since);
    return this.failures.length >= FAILURES_PER_MINUTE;
  }

  /**
   * Signs a browser in with a code, which then no longer works. Undefined for a wrong or expired code.
   * Synchronous, so that `tooManyFailures()` right before it counts every wrong code before it.
   */
  redeem(input: string, label: string): SignedIn | undefined {
    const code = normalizeCode(input);
    this.prune();
    const live = code ? (this.db.prepare('SELECT hash FROM auth_codes').all() as { hash: string }[]) : [];
    const found = code ? live.find((row) => isCode(code, row.hash)) : undefined;
    const used = found ? this.db.prepare('DELETE FROM auth_codes WHERE hash = ?').run(found.hash).changes > 0 : false;
    if (!used) {
      this.failures.push(this.now());
      return undefined;
    }
    const id = randomBytes(12).toString('base64url');
    const secret = token();
    const key = token();
    const now = this.now();
    this.db
      .prepare('INSERT INTO auth_sessions (id, cookie_hash, key_hash, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, hex(secret), hex(key), label.slice(0, 120), now, now);
    return { id, cookie: `${id}.${secret}`, key };
  }

  /**
   * The session a request comes from, when its cookie (and key, unless `key` is null: a file the
   * browser loads by itself, which sends no header) belong to one.
   */
  check(cookie: string | undefined, key: string | null | undefined): string | undefined {
    const dot = cookie?.indexOf('.') ?? -1;
    if (!cookie || dot < 1) return undefined;
    const id = cookie.slice(0, dot);
    const row = this.db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row || !matches(cookie.slice(dot + 1), row.cookie_hash)) return undefined;
    if (this.now() - row.created_at >= SESSION_MAX_AGE_S * 1000) return undefined;
    if (key !== null && !(key && matches(key, row.key_hash))) return undefined;
    const now = this.now();
    if (now - row.last_used_at > TOUCH_EVERY_MS) this.db.prepare('UPDATE auth_sessions SET last_used_at = ? WHERE id = ?').run(now, id);
    return id;
  }

  /** The signed-in browsers, the latest used first; `current` marks the one asking. */
  sessions(current?: string): AuthSessionView[] {
    const rows = this.db.prepare('SELECT * FROM auth_sessions ORDER BY last_used_at DESC').all() as unknown as SessionRow[];
    return rows.map((r) => ({
      id: r.id,
      label: r.label ?? '',
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      current: r.id === current,
    }));
  }

  /** Signs a browser out. False when there was no such session. */
  revoke(id: string): boolean {
    return this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id).changes > 0;
  }

  private prune(): void {
    this.db.prepare('DELETE FROM auth_codes WHERE expires_at <= ?').run(this.now());
    this.db.prepare('DELETE FROM auth_sessions WHERE created_at <= ?').run(this.now() - SESSION_MAX_AGE_S * 1000);
  }
}
