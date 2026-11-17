import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';

/*
 * A small IMAP4rev1 client, enough for the mail tools: sign in (LOGIN), list the folders (to find the
 * drafts), search a folder, fetch headers and messages, and append a draft. A connection serves one
 * tool call and is closed after it. TLS from the start (port 993) or STARTTLS; plain only to this
 * computer (a local bridge, the tests' stand-in server).
 */

export type MailSecurity = 'tls' | 'starttls' | 'none';

export interface ServerAddress {
  host: string;
  port: number;
  security: MailSecurity;
}

export interface Login {
  username: string;
  password: string;
}

/** One response: its text (literals left as `{n}`) and the literals in it, in order. */
export interface ImapResponse {
  text: string;
  literals: Buffer[];
}

/** Opens a connection (TLS, or plain upgraded with `upgrade()` after STARTTLS), with a time limit for each step. */
export async function openSocket(addr: ServerAddress, timeoutMs: number): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock =
      addr.security === 'tls'
        ? connectTls({ host: addr.host, port: addr.port, servername: addr.host })
        : connectTcp({ host: addr.host, port: addr.port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`${addr.host}:${addr.port} did not answer in ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    sock.once(addr.security === 'tls' ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not connect to ${addr.host}:${addr.port}: ${err.message}`));
    });
  });
}

/** A plain connection turned into TLS (after STARTTLS), checked against `host`. */
export function upgrade(sock: Socket, host: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = connectTls({ socket: sock, servername: host });
    const timer = setTimeout(() => {
      tls.destroy();
      reject(new Error(`TLS with ${host} did not start in time`));
    }, timeoutMs);
    tls.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(tls);
    });
    tls.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`TLS with ${host} failed: ${err.message}`));
    });
  });
}

/** An IMAP quoted string. */
export function quote(s: string): string {
  if (/[\r\n\0]/.test(s)) throw new Error('A line break cannot be sent to the mail server');
  return `"${s.replace(/[\\"]/g, '\\$&')}"`;
}

/** Reads responses off a socket: lines, with literals (`{n}`) read whole whatever pieces they come in. */
class ResponseReader {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private ended?: Error;
  private sock?: Socket;
  private readonly onData = (chunk: Buffer) => {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.wake();
  };
  private readonly onEnd = () => this.end();
  private readonly onError = (err: Error) => this.end(err);

  constructor(sock: Socket) {
    this.attach(sock);
  }

  /** Stop reading the socket (STARTTLS: TLS reads it from now on). */
  detach(): void {
    if (!this.sock) return;
    this.sock.off('data', this.onData);
    this.sock.off('end', this.onEnd);
    this.sock.off('close', this.onEnd);
    this.sock.off('error', this.onError);
    this.sock = undefined;
  }

  private end(err?: Error): void {
    this.ended ??= err ?? new Error('The mail server closed the connection');
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
    if (this.ended) throw this.ended;
    await new Promise<void>((r) => this.waiters.push(r));
  }

  /** The next whole response. */
  async next(): Promise<ImapResponse> {
    let text = '';
    const literals: Buffer[] = [];
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
      while (this.buf.length < eol + 2 + size) await this.more();
      literals.push(Buffer.from(this.buf.subarray(eol + 2, eol + 2 + size)));
      text += line;
      this.buf = this.buf.subarray(eol + 2 + size);
    }
  }
}

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

  /** Connects, starts TLS when asked, and signs in. */
  static async open(addr: ServerAddress, login: Login, timeoutMs = 30_000): Promise<ImapClient> {
    const c = new ImapClient(timeoutMs);
    c.sock = await openSocket(addr, timeoutMs);
    c.reader = new ResponseReader(c.sock);
    try {
      const greeting = await c.timed(c.reader.next());
      if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new Error(`The mail server refused the connection: ${greeting.text}`);
      if (addr.security === 'starttls') {
        await c.command('STARTTLS');
        // The plain socket's bytes are TLS's own from now on.
        c.reader.detach();
        c.sock = await upgrade(c.sock as Socket, addr.host, timeoutMs);
        c.reader.attach(c.sock);
      }
      await c.command(`LOGIN ${quote(login.username)} ${quote(login.password)}`).catch((err: Error) => {
        throw new Error(`The mail server did not accept the user name and password: ${err.message}`);
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

  private timed<T>(p: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sock.destroy();
        reject(new Error(`The mail server did not answer in ${Math.round(this.timeoutMs / 1000)} seconds`));
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
    for (;;) {
      const r = await this.timed(this.reader.next());
      if (!r.text.startsWith(`${tag} `)) {
        untagged.push(r);
        continue;
      }
      const status = r.text.slice(tag.length + 1);
      if (!/^OK/i.test(status)) throw new Error(status.replace(/^(NO|BAD)\s*/i, '') || status);
      return { untagged, status };
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
}

/** What a FETCH response says: its UID, flags, internal date, and the literal it carries (a header block or a message). */
export function parseFetch(r: ImapResponse): { uid?: number; flags: string[]; date?: string; data?: Buffer } {
  const uid = /\bUID (\d+)/i.exec(r.text)?.[1];
  const flags = /\bFLAGS \(([^)]*)\)/i.exec(r.text)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
  const date = /\bINTERNALDATE "([^"]+)"/i.exec(r.text)?.[1];
  return { ...(uid ? { uid: Number(uid) } : {}), flags, ...(date ? { date } : {}), ...(r.literals.length ? { data: r.literals[r.literals.length - 1] } : {}) };
}

/** A date as IMAP's SEARCH takes it (`5-Jan-2026`). */
export function imapDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
