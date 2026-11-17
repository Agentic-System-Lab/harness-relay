import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { openSocket, STARTTLS_EXTRA, upgrade, type Login, type ServerAddress } from './imap';

/*
 * A small SMTP client for the outbox's mail: EHLO, STARTTLS (port 587) or TLS from the start (465),
 * AUTH PLAIN (or LOGIN), MAIL FROM, RCPT TO for each recipient (Bcc included, never in the message),
 * DATA with dot-stuffing, QUIT. Only the user's Send runs it (`outbox.ts`).
 */

/** The most the replies waiting to be read may hold. */
export const SMTP_MAX_REPLY = 256 * 1024;

/** Reads SMTP replies: a code and its lines, a multi-line reply (`250-…`) read to its last line. */
class ReplyReader {
  private buf = '';
  private waiters: (() => void)[] = [];
  private ended?: Error;
  private sock?: Socket;
  private readonly onData = (chunk: Buffer) => {
    this.buf += chunk.toString('utf8');
    // A reply is a few lines: a server that sends far more is cut off.
    if (this.buf.length > SMTP_MAX_REPLY) {
      this.sock?.destroy();
      this.ended ??= new Error('The mail server sent more than a reply may hold');
    }
    this.wake();
  };
  private readonly onEnd = () => {
    this.ended ??= new Error('The mail server closed the connection');
    this.wake();
  };

  constructor(sock: Socket) {
    this.attach(sock);
  }

  attach(sock: Socket): void {
    this.detach();
    this.sock = sock;
    sock.on('data', this.onData);
    sock.on('close', this.onEnd);
    sock.on('error', this.onEnd);
  }

  /** Stop reading the socket (STARTTLS); what was read but not taken is dropped: returns whether there was any. */
  detach(): boolean {
    const leftover = this.buf.length > 0;
    this.buf = '';
    if (!this.sock) return leftover;
    this.sock.off('data', this.onData);
    this.sock.off('close', this.onEnd);
    this.sock.off('error', this.onEnd);
    this.sock = undefined;
    return leftover;
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  async next(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    let size = 0;
    for (;;) {
      const eol = this.buf.indexOf('\r\n');
      if (eol < 0) {
        if (this.ended) throw this.ended;
        await new Promise<void>((r) => this.waiters.push(r));
        continue;
      }
      const line = this.buf.slice(0, eol);
      this.buf = this.buf.slice(eol + 2);
      // A reply of many lines that never ends is refused once it is too long.
      size += eol + 2;
      if (size > SMTP_MAX_REPLY) {
        this.sock?.destroy();
        throw new Error('The mail server sent more than a reply may hold');
      }
      lines.push(line.slice(4));
      if (line[3] !== '-') return { code: Number(line.slice(0, 3)), lines };
    }
  }
}

/** Lines beginning with a dot get another (RFC 5321 §4.5.2); the message ends with CRLF.CRLF. */
export function dotStuff(raw: string): string {
  const body = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return `${body.endsWith('\r\n') ? body : `${body}\r\n`}.\r\n`;
}

export interface Envelope {
  from: string;
  recipients: string[];
}

/** A line to the server, and the reply codes it must answer with. */
type Say = (line: string, codes: number[], what: string) => Promise<{ code: number; lines: string[] }>;

/**
 * Connects, says EHLO, starts TLS when asked, signs in (AUTH PLAIN, or LOGIN when only that is
 * offered), then runs `fn`, and says QUIT.
 */
export async function withSmtp<T>(
  addr: ServerAddress,
  login: Login,
  fn: (say: Say, write: (raw: string) => void, expect: (codes: number[], what: string) => Promise<unknown>) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  let sock: Socket | TLSSocket = await openSocket(addr, timeoutMs);
  const reader = new ReplyReader(sock);
  const timed = <V>(p: Promise<V>): Promise<V> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`The mail server did not answer in ${Math.round(timeoutMs / 1000)} seconds`));
      }, timeoutMs);
      p.then(
        (v) => (clearTimeout(timer), resolve(v)),
        (e: Error) => (clearTimeout(timer), reject(e)),
      );
    });
  const expect = async (codes: number[], what: string) => {
    const r = await timed(reader.next());
    if (!codes.includes(r.code)) throw new Error(`${what}: ${r.code} ${r.lines.join(' ')}`.trim());
    return r;
  };
  const say: Say = async (line, codes, what) => {
    sock.write(`${line}\r\n`);
    return expect(codes, what);
  };
  try {
    await expect([220], 'The mail server refused the connection');
    let ehlo = await say('EHLO harness-relay.local', [250], 'EHLO');
    if (addr.security === 'starttls') {
      await say('STARTTLS', [220], 'STARTTLS');
      // More after the answer came before TLS, from anyone on the way: refused (as for IMAP).
      if (reader.detach()) throw new Error(STARTTLS_EXTRA);
      sock = await upgrade(sock as Socket, addr.host, timeoutMs);
      reader.attach(sock);
      ehlo = await say('EHLO harness-relay.local', [250], 'EHLO');
    }
    const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l))?.toUpperCase() ?? '';
    if (auth.includes('PLAIN') || !auth.includes('LOGIN')) {
      const token = Buffer.from(`\0${login.username}\0${login.password}`).toString('base64');
      await say(`AUTH PLAIN ${token}`, [235], 'The mail server did not accept the user name and password');
    } else {
      await say('AUTH LOGIN', [334], 'AUTH LOGIN');
      await say(Buffer.from(login.username).toString('base64'), [334], 'AUTH LOGIN');
      await say(Buffer.from(login.password).toString('base64'), [235], 'The mail server did not accept the user name and password');
    }
    const result = await fn(say, (raw) => sock.write(raw), expect);
    await say('QUIT', [221], 'QUIT').catch(() => undefined);
    return result;
  } finally {
    sock.destroy();
  }
}

/** Sends one message. Resolves with the server's last answer (its queue id, often). */
export async function sendMail(addr: ServerAddress, login: Login, envelope: Envelope, raw: string, timeoutMs = 30_000): Promise<string> {
  return withSmtp(
    addr,
    login,
    async (say, write, expect) => {
      await say(`MAIL FROM:<${envelope.from}>`, [250], 'The mail server refused the sender');
      for (const rcpt of envelope.recipients) await say(`RCPT TO:<${rcpt}>`, [250, 251], `The mail server refused ${rcpt}`);
      await say('DATA', [354], 'DATA');
      write(dotStuff(raw));
      const done = (await expect([250], 'The mail server did not take the message')) as { lines: string[] };
      return done.lines.join(' ').trim() || 'accepted';
    },
    timeoutMs,
  );
}
