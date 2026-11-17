import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { t } from '../i18n';

/*
 * A small IMAP4rev1 client, enough for the mail tools: sign in (LOGIN with a password, or SASL XOAUTH2
 * with an OAuth account's token), list the folders (to find the drafts), search a folder, fetch headers
 * and messages, and append a draft. A connection serves one tool call and is closed after it. TLS from
 * the start (port 993) or STARTTLS; plain only to this computer (a local bridge, the tests' stand-in
 * server).
 */

export type MailSecurity = 'tls' | 'starttls' | 'none';

export interface ServerAddress {
  host: string;
  port: number;
  security: MailSecurity;
}

/** How a mail server is signed in to: a user name with its password, or with an OAuth access token (SASL XOAUTH2). */
export type Login = { username: string; password: string } | { username: string; token: string };

/**
 * SASL XOAUTH2's initial response (Google's and Microsoft's IMAP and SMTP): the user and the token, in
 * base64. Neither may hold a line break or the ^A that separates them.
 */
export function xoauth2(username: string, token: string): string {
  if (/[\x00-\x1f\x7f]/.test(username) || /[\x00-\x1f\x7f\s]/.test(token))
    throw new Error('A line break cannot be sent to the mail server');
  return Buffer.from(`user=${username}\x01auth=Bearer ${token}\x01\x01`).toString('base64');
}

/**
 * What a server's XOAUTH2 refusal says (base64 JSON, `{"status":"401","schemes":"bearer","scope":…}`),
 * in a few words: its status, or its text when it is not JSON.
 */
export function xoauth2Detail(b64: string): string {
  const text = Buffer.from(b64.trim(), 'base64').toString('utf8');
  try {
    const v = JSON.parse(text) as { status?: unknown };
    if (typeof v.status === 'string' || typeof v.status === 'number') return `status ${String(v.status).slice(0, 20)}`;
  } catch {
    /* not JSON */
  }
  return text
    .replace(/[^\x20-\x7e]+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** One response: its text (literals left as `{n}`) and the literals in it, in order. */
export interface ImapResponse {
  text: string;
  literals: Buffer[];
}

/** Opens a connection (TLS, or plain upgraded with `upgrade()` after STARTTLS), with a time limit for each step. */
export async function openSocket(addr: ServerAddress, timeoutMs: number, signal?: AbortSignal): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock =
      addr.security === 'tls'
        ? connectTls({ host: addr.host, port: addr.port, servername: addr.host })
        : connectTcp({ host: addr.host, port: addr.port });
    // Stopped while it connects (`IdleWatcher`): the socket goes at once.
    if (signal?.aborted) {
      sock.destroy();
      return reject(new Error('stopped'));
    }
    const onAbort = () => {
      sock.destroy();
      clearTimeout(timer);
      reject(new Error('stopped'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const settled = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      settled();
      sock.destroy();
      reject(new Error(t().conn.timedOut(addr.host, addr.port, Math.round(timeoutMs / 1000))));
    }, timeoutMs);
    sock.once(addr.security === 'tls' ? 'secureConnect' : 'connect', () => {
      settled();
      resolve(sock);
    });
    sock.once('error', (err) => {
      settled();
      reject(new Error(t().conn.connectFailed(addr.host, addr.port, err.message)));
    });
  });
}

/** A plain connection turned into TLS (after STARTTLS), checked against `host`. */
export function upgrade(sock: Socket, host: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = connectTls({ socket: sock, servername: host });
    const timer = setTimeout(() => {
      tls.destroy();
      reject(new Error(t().conn.tlsSlow(host)));
    }, timeoutMs);
    tls.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(tls);
    });
    tls.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(t().conn.tlsFailed(host, err.message)));
    });
  });
}

/** The server's answer to STARTTLS came with more after it, before TLS started. */
export const STARTTLS_EXTRA =
  'The mail server sent more than its answer to STARTTLS before TLS started: the connection was closed, as someone on the way may have added it';

/** An IMAP quoted string. */
export function quote(s: string): string {
  if (/[\r\n\0]/.test(s)) throw new Error('A line break cannot be sent to the mail server');
  return `"${s.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * The most a response may hold, literals included: far more than a message the mail tools fetch
 * (400 KB at most), a folder list or a search's numbers, so a server that sends more (or announces a
 * literal larger) is refused instead of filling the server's memory.
 */
export const IMAP_MAX_RESPONSE = 16 * 1024 * 1024;

/** Reads responses off a socket: lines, with literals (`{n}`) read whole whatever pieces they come in. */
class ResponseReader {
  private buf = Buffer.alloc(0);
  /** Chunks come in faster than they are read: joined once, when read, not on each one. */
  private pending: Buffer[] = [];
  private pendingSize = 0;
  private waiters: (() => void)[] = [];
  private ended?: Error;
  private sock?: Socket;
  private readonly onData = (chunk: Buffer) => {
    this.pending.push(chunk);
    this.pendingSize += chunk.length;
    if (this.buf.length + this.pendingSize > IMAP_MAX_RESPONSE + 64 * 1024) {
      this.sock?.destroy();
      return this.end(new Error(t().conn.mailTooMuch));
    }
    this.wake();
  };

  /** What came in since, joined to what is still to read. */
  private take(): void {
    if (!this.pending.length) return;
    this.buf = Buffer.concat([this.buf, ...this.pending]);
    this.pending = [];
    this.pendingSize = 0;
  }
  private readonly onEnd = () => this.end();
  private readonly onError = (err: Error) => this.end(err);

  constructor(sock: Socket) {
    this.attach(sock);
  }

  /**
   * Stop reading the socket (STARTTLS: TLS reads it from now on). What was read but not yet taken is
   * dropped, as it came before TLS, from anyone on the way: returns whether there was any.
   */
  detach(): boolean {
    const leftover = this.buf.length > 0 || this.pendingSize > 0;
    this.buf = Buffer.alloc(0);
    this.pending = [];
    this.pendingSize = 0;
    if (!this.sock) return leftover;
    this.sock.off('data', this.onData);
    this.sock.off('end', this.onEnd);
    this.sock.off('close', this.onEnd);
    this.sock.off('error', this.onError);
    this.sock = undefined;
    return leftover;
  }

  private end(err?: Error): void {
    this.ended ??= err ?? new Error(t().conn.mailClosed);
    this.wake();
  }

  /**
   * Read from `sock` from now on (after STARTTLS, the TLS socket): the plain one's bytes are TLS's
   * own then, and no longer read here.
   */
  attach(sock: Socket): void {
    this.detach();
    this.sock = sock;
    sock.on('data', this.onData);
    sock.on('end', this.onEnd);
    sock.on('close', this.onEnd);
    sock.on('error', this.onError);
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private async more(): Promise<void> {
    if (this.pending.length) return this.take();
    if (this.ended) throw this.ended;
    await new Promise<void>((r) => this.waiters.push(r));
    this.take();
  }

  /** The next whole response. */
  async next(): Promise<ImapResponse> {
    let text = '';
    const literals: Buffer[] = [];
    let held = 0;
    this.take();
    for (;;) {
      const eol = this.buf.indexOf('\r\n');
      if (eol < 0) {
        await this.more();
        continue;
      }
      const line = this.buf.subarray(0, eol).toString('utf8');
      const lit = /\{(\d+)\+?\}$/.exec(line);
      if (!lit) {
        this.buf = this.buf.subarray(eol + 2);
        return { text: text + line, literals };
      }
      const size = Number(lit[1]);
      held += eol + 2 + size;
      if (held > IMAP_MAX_RESPONSE) throw new Error(t().conn.mailAnnouncedTooMuch);
      while (this.buf.length < eol + 2 + size) await this.more();
      literals.push(Buffer.from(this.buf.subarray(eol + 2, eol + 2 + size)));
      text += line;
      this.buf = this.buf.subarray(eol + 2 + size);
    }
  }
}

/** The server refused the user name and password (LOGIN), or the token (XOAUTH2): trying again soon with the same will not help. */
export class ImapLoginError extends Error {}

/** A command answered NO or BAD: `status` is the whole answer after the tag. */
export class ImapStatusError extends Error {
  constructor(
    message: string,
    readonly status: string,
  ) {
    super(message);
  }
}

/** The server refused IDLE although it may list it: waiting for mail that way will not work there. */
export class IdleRefusedError extends Error {}

/** A string to send as a literal (non-ASCII text, a message): `{n}`, then the bytes once the server says to go on. */
export class Literal {
  constructor(readonly bytes: Buffer) {}
}

export class ImapClient {
  private tag = 0;
  private reader!: ResponseReader;
  private sock!: Socket | TLSSocket;
  capabilities = new Set<string>();

  private constructor(private timeoutMs: number) {}

  /** Connects, starts TLS when asked, and signs in. `signal`: stops it, closing the connection, whenever it aborts. */
  static async open(addr: ServerAddress, login: Login, timeoutMs = 30_000, signal?: AbortSignal): Promise<ImapClient> {
    const c = new ImapClient(timeoutMs);
    c.sock = await openSocket(addr, timeoutMs, signal);
    signal?.addEventListener('abort', () => c.sock.destroy(), { once: true });
    c.reader = new ResponseReader(c.sock);
    try {
      const greeting = await c.timed(c.reader.next());
      if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new Error(t().conn.mailRefused(greeting.text));
      if (addr.security === 'starttls') {
        await c.command('STARTTLS');
        // The plain socket's bytes are TLS's own from now on. An answer already there came before
        // TLS, from anyone on the way (one injected to be read as the server's, say): refused.
        if (c.reader.detach()) throw new Error(STARTTLS_EXTRA);
        c.sock = await upgrade(c.sock as Socket, addr.host, timeoutMs);
        c.reader.attach(c.sock);
      }
      // Refused (a tagged NO, but not "try later"): trying again soon will not help. A time-out or a
      // dropped connection is no refusal.
      const refused = (err: Error) => err instanceof ImapStatusError && /^NO\b/i.test(err.status) && !/\[UNAVAILABLE\]/i.test(err.status);
      if ('token' in login)
        await c.authenticate(login.username, login.token).catch((err: Error) => {
          const msg = t().conn.mailTokenRefused(err.message);
          throw refused(err) ? new ImapLoginError(msg) : new Error(msg);
        });
      else
        await c.command(`LOGIN ${quote(login.username)} ${quote(login.password)}`).catch((err: Error) => {
          const msg = t().conn.mailLogin(err.message);
          throw refused(err) ? new ImapLoginError(msg) : new Error(msg);
        });
      const caps = await c.command('CAPABILITY');
      for (const r of caps.untagged) {
        const m = /^\* CAPABILITY (.*)$/i.exec(r.text);
        if (m) for (const cap of m[1]!.split(' ')) c.capabilities.add(cap.toUpperCase());
      }
      return c;
    } catch (err) {
      c.sock.destroy();
      throw err;
    }
  }

  /**
   * Signs in with SASL XOAUTH2 (RFC 3501 AUTHENTICATE): the command, the server's go-ahead (`+`), then
   * the user and token in one base64 line. A server that refuses the token says why in a `+` line of
   * its own first (base64 JSON), answered with an empty line, and then its tagged NO.
   */
  private async authenticate(username: string, token: string): Promise<void> {
    const initial = xoauth2(username, token);
    const tag = `R${++this.tag}`;
    this.sock.write(`${tag} AUTHENTICATE XOAUTH2\r\n`);
    for (;;) {
      const r = await this.timed(this.reader.next());
      if (r.text.startsWith('+')) break;
      if (r.text.startsWith(`${tag} `)) {
        const status = r.text.slice(tag.length + 1);
        throw new ImapStatusError(status.replace(/^(NO|BAD)\s*/i, ''), status);
      }
    }
    this.sock.write(`${initial}\r\n`);
    let detail = '';
    for (let asked = 0; ;) {
      const r = await this.timed(this.reader.next());
      if (r.text.startsWith('+')) {
        // Once: a server that keeps asking is not one that takes the token.
        if (++asked > 1) throw new Error(detail || r.text);
        detail = xoauth2Detail(r.text.slice(1));
        this.sock.write('\r\n');
        continue;
      }
      // Untagged responses before the answer (a CAPABILITY) are read past.
      if (!r.text.startsWith(`${tag} `)) continue;
      const status = r.text.slice(tag.length + 1);
      if (/^OK/i.test(status)) return;
      throw new ImapStatusError([status.replace(/^(NO|BAD)\s*/i, '') || status, detail && `(${detail})`].filter(Boolean).join(' '), status);
    }
  }

  private timed<T>(p: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sock.destroy();
        reject(new Error(t().conn.mailNoAnswer(Math.round(this.timeoutMs / 1000))));
      }, this.timeoutMs);
      p.then(
        (v) => (clearTimeout(timer), resolve(v)),
        (e: Error) => (clearTimeout(timer), reject(e)),
      );
    });
  }

  /**
   * Sends a command (its parts joined by spaces; a `Literal` sent as one) and reads up to its tagged
   * answer: the untagged responses before it. A NO or BAD answer is an error.
   */
  async command(...parts: (string | Literal)[]): Promise<{ untagged: ImapResponse[]; status: string }> {
    const tag = `R${++this.tag}`;
    const untagged: ImapResponse[] = [];
    const pieces: (string | Literal)[] = [`${tag} `];
    parts.forEach((p, i) => pieces.push(...(i ? [' '] : []), p));
    let line = '';
    for (const piece of pieces) {
      if (typeof piece === 'string') {
        line += piece;
        continue;
      }
      this.sock.write(`${line}{${piece.bytes.length}}\r\n`);
      line = '';
      // Wait for the go-ahead ("+ …"); anything else first is untagged, or the command failed.
      for (;;) {
        const r = await this.timed(this.reader.next());
        if (r.text.startsWith('+')) break;
        if (r.text.startsWith(`${tag} `)) throw new Error(r.text.slice(tag.length + 1));
        untagged.push(r);
      }
      this.sock.write(piece.bytes);
    }
    this.sock.write(`${line}\r\n`);
    // What a command's answer may hold in all, its untagged responses included.
    let size = 0;
    for (;;) {
      const r = await this.timed(this.reader.next());
      size += r.text.length + r.literals.reduce((n, l) => n + l.length, 0);
      if (size > IMAP_MAX_RESPONSE) {
        this.sock.destroy();
        throw new Error(t().conn.mailTooMuch);
      }
      if (!r.text.startsWith(`${tag} `)) {
        untagged.push(r);
        continue;
      }
      const status = r.text.slice(tag.length + 1);
      if (!/^OK/i.test(status)) throw new ImapStatusError(status.replace(/^(NO|BAD)\s*/i, '') || status, status);
      return { untagged, status };
    }
  }

  /**
   * Waits in IDLE (RFC 2177) until `stop` resolves, passing each untagged response the server sends
   * meanwhile (`* 12 EXISTS` when mail arrives) to `onResponse`; then ends it (DONE) and reads its
   * tagged answer. No time limit while it waits: the caller stops it before the server would (most
   * end IDLE after about 29 minutes). A connection that drops, or a server that ends it, is an error.
   */
  async idle(onResponse: (r: ImapResponse) => void, stop: Promise<void>, onIdling?: () => void): Promise<void> {
    const tag = `R${++this.tag}`;
    this.sock.write(`${tag} IDLE\r\n`);
    for (;;) {
      const r = await this.timed(this.reader.next());
      if (r.text.startsWith('+')) break;
      if (r.text.startsWith(`${tag} `)) throw new IdleRefusedError(r.text.slice(tag.length + 1));
      onResponse(r);
    }
    onIdling?.();
    const stopped = stop.then(() => undefined);
    let next = this.reader.next();
    for (;;) {
      const r = await Promise.race([next, stopped]);
      if (!r) break;
      // The server ended IDLE itself: fine when it says OK (the caller waits in IDLE again).
      if (r.text.startsWith(`${tag} `)) {
        if (/^OK/i.test(r.text.slice(tag.length + 1))) return;
        throw new Error(t().conn.mailIdleEnded(r.text));
      }
      if (/^\* BYE\b/i.test(r.text)) throw new Error(t().conn.mailIdleEnded(r.text));
      onResponse(r);
      next = this.reader.next();
    }
    this.sock.write('DONE\r\n');
    for (;;) {
      const r = await this.timed(next);
      if (r.text.startsWith(`${tag} `)) {
        const status = r.text.slice(tag.length + 1);
        if (!/^OK/i.test(status)) throw new Error(status);
        return;
      }
      onResponse(r);
      next = this.reader.next();
    }
  }

  /** The folders, with their attributes (`\Drafts`…). */
  async folders(): Promise<{ name: string; attributes: string[] }[]> {
    const { untagged } = await this.command('LIST "" "*"');
    return untagged.flatMap((r) => {
      const m = /^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.*)$/i.exec(r.text);
      if (!m) return [];
      let name = m[2]!.trim();
      if (/^\{\d+\}$/.test(name) && r.literals[0]) name = r.literals[0].toString('utf8');
      else if (name.startsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
      return [{ name, attributes: m[1]!.split(/\s+/).filter(Boolean) }];
    });
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT');
    } catch {
      /* closing anyway */
    }
    this.sock.end();
    this.sock.destroy();
  }

  close(): void {
    this.sock.destroy();
  }

  /** TCP keepalive on the connection: one left open (IDLE) is found dead when the network went. */
  keepAlive(ms: number): void {
    this.sock.setKeepAlive(true, ms);
  }
}

/** What a FETCH response says: its UID, flags, internal date, and the literal it carries (a header block or a message). */
export function parseFetch(r: ImapResponse): { uid?: number; flags: string[]; date?: string; data?: Buffer } {
  const uid = /\bUID (\d+)/i.exec(r.text)?.[1];
  const flags = /\bFLAGS \(([^)]*)\)/i.exec(r.text)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
  const date = /\bINTERNALDATE "([^"]+)"/i.exec(r.text)?.[1];
  return {
    ...(uid ? { uid: Number(uid) } : {}),
    flags,
    ...(date ? { date } : {}),
    ...(r.literals.length ? { data: r.literals[r.literals.length - 1] } : {}),
  };
}

/** A date as IMAP's SEARCH takes it (`5-Jan-2026`). */
export function imapDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
