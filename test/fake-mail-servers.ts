/*
 * Stand-ins for a mail account's servers, on local ports, for the mail and calendar tools' tests:
 * an IMAP server (sign-in, folders, search, fetch, append, with literals as servers send them), an
 * SMTP server (EHLO, AUTH, the envelope, DATA), and a CalDAV calendar (REPORT and PUT). Plain TCP and
 * HTTP on 127.0.0.1: what Harness Relay allows only for a server on this computer. With `bearer`, the
 * IMAP and SMTP servers take SASL XOAUTH2 too, with the tokens it accepts, and refuse another as
 * Gmail does (its reason in a continuation, then NO or 535) or as Microsoft does (NO or 535 at once);
 * or, for the clients' other paths, ask again after the reason, chat in untagged responses, ask for
 * the SMTP response in an empty 334, or answer AUTH with another reply (a 4xx, a 504).
 */
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';

/** Which tokens a stand-in takes over XOAUTH2 (for which user), and how it refuses another: as Gmail or as Microsoft does. */
export interface FakeBearer {
  bearer?: (user: string, token: string) => boolean;
  refusal?: 'gmail' | 'microsoft';
  /** What Gmail's refusal says first, in base64 (`GMAIL_XOAUTH2_ERROR` when not given). */
  challenge?: string;
  /** IMAP: after the empty line that answers the refusal's reason, it asks again (`+`), never saying NO. */
  askAgain?: boolean;
  /** IMAP: untagged responses before its go-ahead and before its answer to AUTHENTICATE. */
  chatty?: boolean;
}

/** The base64 JSON Gmail sends before it refuses a token (`{"status":"400","schemes":"Bearer","scope":"https://mail.google.com/"}`). */
export const GMAIL_XOAUTH2_ERROR = Buffer.from('{"status":"400","schemes":"Bearer","scope":"https://mail.google.com/"}').toString('base64');

/** The user and token in an XOAUTH2 initial response, or undefined when it is not one. */
export function readXoauth2(b64: string): { user: string; token: string } | undefined {
  const m = /^user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01$/.exec(Buffer.from(b64, 'base64').toString('utf8'));
  return m ? { user: m[1]!, token: m[2]! } : undefined;
}

export interface FakeMessage {
  uid: number;
  raw: string;
  seen?: boolean;
  /** When it arrived, as FETCH's INTERNALDATE says it (`05-Jan-2026 09:00:00 +0000` when not given). */
  internalDate?: string;
}

export interface FakeImap {
  port: number;
  /** Every command line as it came (literals as `{n}`), and each literal's text. */
  commands: string[];
  literals: string[];
  /** The XOAUTH2 sign-ins it was given: their user and token, and whether it took them. */
  xoauth2: { user: string; token: string; ok: boolean }[];
  appended: { folder: string; flags: string; raw: string }[];
  /** INBOX's UIDVALIDITY, which EXAMINE answers (change it to stand for a rebuilt folder). */
  uidValidity: number;
  /**
   * The UIDNEXT EXAMINE answers: the highest UID + 1 when undefined (set it above that for mail that
   * was expunged), none at all when `null` (a server that does not say it).
   */
  uidNext: number | null | undefined;
  /** Whether it says IDLE (RFC 2177) in its capabilities, and takes it. */
  idle: boolean;
  /** How it answers IDLE (`no`: refuses it, although it lists it), and DONE (`no`, or `none`: never). */
  idleAnswer: 'ok' | 'no' | 'end';
  doneAnswer: 'ok' | 'no' | 'none';
  /** Says BYE to every connection waiting in IDLE (a server shutting down; `text`: what it says after BYE), and closes them. */
  bye(text?: string): void;
  /** The connections waiting in IDLE now. */
  readonly idling: number;
  /** Tells every connection waiting in IDLE that the inbox has this many messages (`* n EXISTS`). */
  notify(): void;
  /** Drops every connection (a lost network, a server restarting). */
  drop(): void;
  close(): Promise<void>;
}

/**
 * An IMAP server with one INBOX, a Drafts folder (`\Drafts`), and these messages in INBOX (push more to
 * the array for mail that arrives). EXAMINE answers INBOX's UIDVALIDITY and UIDNEXT; `UID SEARCH` takes
 * a UID range (`n:*`, as RFC 3501 reads it).
 */
export async function fakeImap(
  messages: FakeMessage[],
  login = { user: 'me@example.com', pass: 'app-pass' },
  o: FakeBearer = {},
): Promise<FakeImap> {
  const commands: string[] = [];
  const literals: string[] = [];
  const xoauth2: FakeImap['xoauth2'] = [];
  const appended: FakeImap['appended'] = [];
  const fake: {
    uidValidity: number;
    uidNext: number | null | undefined;
    idle: boolean;
    idleAnswer: 'ok' | 'no' | 'end';
    doneAnswer: 'ok' | 'no' | 'none';
  } = {
    uidValidity: 7,
    uidNext: undefined,
    idle: false,
    idleAnswer: 'ok',
    doneAnswer: 'ok',
  };
  /** The connections waiting in IDLE, with the tag their DONE answers. */
  const idling = new Map<Socket, string>();
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock: Socket) => {
    sockets.add(sock);
    sock.on('close', () => (sockets.delete(sock), idling.delete(sock)));
    sock.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let line = '';
    let need = 0; // bytes of a literal still to read
    let parts: string[] = [];
    /** An AUTHENTICATE XOAUTH2 under way: its tag, and whether its response or (after a refusal's continuation) the empty line comes next. */
    let sasl: { tag: string; step: 'response' | 'refused' } | undefined;
    const send = (s: string) => sock.write(s);
    send('* OK [CAPABILITY IMAP4rev1 AUTH=XOAUTH2] fake IMAP ready\r\n');
    const handle = (full: string, lits: string[]) => {
      commands.push(full);
      literals.push(...lits);
      if (sasl) {
        const { tag } = sasl;
        if (sasl.step === 'refused') {
          if (o.askAgain) return send(`+ ${o.challenge ?? GMAIL_XOAUTH2_ERROR}\r\n`);
          sasl = undefined;
          return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
        }
        const given = readXoauth2(full);
        const ok = Boolean(given && o.bearer?.(given.user, given.token));
        if (given) xoauth2.push({ ...given, ok });
        if (ok) {
          sasl = undefined;
          return send(`${o.chatty ? '* CAPABILITY IMAP4rev1 IDLE\r\n' : ''}${tag} OK AUTHENTICATE completed.\r\n`);
        }
        if (o.refusal === 'microsoft') {
          sasl = undefined;
          return send(`${tag} NO AUTHENTICATE failed.\r\n`);
        }
        sasl.step = 'refused';
        return send(`+ ${o.challenge ?? GMAIL_XOAUTH2_ERROR}\r\n`);
      }
      if (full === 'DONE' && idling.has(sock)) {
        const tag = idling.get(sock)!;
        idling.delete(sock);
        if (fake.doneAnswer === 'none') return;
        return send(fake.doneAnswer === 'no' ? `${tag} NO not now\r\n` : `${tag} OK IDLE terminated\r\n`);
      }
      const m = /^(\S+) (.*)$/.exec(full);
      if (!m) return;
      const [, tag, rest] = m as unknown as [string, string, string];
      const cmd = rest.toUpperCase();
      if (cmd === 'AUTHENTICATE XOAUTH2') {
        if (!o.bearer) return send(`${tag} NO [CANNOT] Unsupported authentication mechanism\r\n`);
        sasl = { tag, step: 'response' };
        return send(`${o.chatty ? '* OK [ALERT] Mind the gap\r\n' : ''}+ \r\n`);
      }
      if (cmd.startsWith('LOGIN')) {
        const q = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.replace(/\\(.)/g, '$1'));
        return send(
          q[0] === login.user && q[1] === login.pass
            ? `${tag} OK signed in\r\n`
            : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`,
        );
      }
      if (cmd.startsWith('CAPABILITY'))
        return send(`* CAPABILITY IMAP4rev1 LITERAL+ SPECIAL-USE${fake.idle ? ' IDLE' : ''}\r\n${tag} OK\r\n`);
      if (cmd === 'IDLE') {
        if (!fake.idle) return send(`${tag} BAD unknown command\r\n`);
        if (fake.idleAnswer === 'no') return send(`${tag} NO IDLE is off for this account\r\n`);
        // Takes it, and ends it at once (a proxy that does not hold it).
        if (fake.idleAnswer === 'end') return send(`+ idling\r\n${tag} OK IDLE done\r\n`);
        idling.set(sock, tag);
        return send('+ idling\r\n');
      }
      if (cmd.startsWith('LIST'))
        return send(
          `* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Drafts) "/" "Drafts"\r\n* LIST (\\HasNoChildren) "/" {7}\r\nArchive\r\n${tag} OK\r\n`,
        );
      if (cmd.startsWith('EXAMINE') || cmd.startsWith('SELECT')) {
        if (!/"INBOX"/i.test(rest)) return send(`${tag} NO no such folder\r\n`);
        const next = fake.uidNext ?? Math.max(0, ...messages.map((x) => x.uid)) + 1;
        const uidNext = fake.uidNext === null ? '' : `* OK [UIDNEXT ${next}] Predicted next UID\r\n`;
        return send(
          `* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY ${fake.uidValidity}] UIDs valid\r\n${uidNext}${tag} OK [READ-ONLY] done\r\n`,
        );
      }
      if (cmd.startsWith('UID SEARCH')) {
        // Text criteria: a quoted string or the literal that came with it.
        const wanted = [...rest.matchAll(/(TEXT|FROM) "([^"]*)"/gi)]
          .map((x) => x[2]!.toLowerCase())
          .concat(lits.map((l) => l.toLowerCase()));
        // A UID range: `*` is the highest UID, and its two ends may come in either order.
        const range = /\bUID (\d+|\*)(?::(\d+|\*))?/i.exec(rest.replace(/^UID SEARCH /i, ''));
        const top = Math.max(0, ...messages.map((x) => x.uid));
        const end = (v: string) => (v === '*' ? top : Number(v));
        const [lo, hi] = range ? [end(range[1]!), end(range[2] ?? range[1]!)].sort((a, b) => a - b) : [0, Infinity];
        const found = messages.filter(
          (msg) =>
            msg.uid >= lo! &&
            msg.uid <= hi! &&
            wanted.every(
              (w) => Buffer.from(msg.raw, 'latin1').toString('utf8').toLowerCase().includes(w) || msg.raw.toLowerCase().includes(w),
            ),
        );
        return send(`* SEARCH ${found.map((x) => x.uid).join(' ')}\r\n${tag} OK\r\n`);
      }
      if (cmd.startsWith('UID FETCH')) {
        const uids = /UID FETCH ([\d,]+)/i.exec(rest)![1]!.split(',').map(Number);
        const headersOnly = /HEADER\.FIELDS/i.test(rest);
        let out = '';
        messages.forEach((msg, i) => {
          if (!uids.includes(msg.uid)) return;
          const raw = Buffer.from(msg.raw, 'latin1');
          const data = headersOnly ? Buffer.from(`${msg.raw.split(/\r?\n\r?\n/)[0]}\r\n\r\n`, 'latin1') : raw;
          out += `* ${i + 1} FETCH (UID ${msg.uid} FLAGS (${msg.seen ? '\\Seen' : ''}) INTERNALDATE "${msg.internalDate ?? '05-Jan-2026 09:00:00 +0000'}" ${headersOnly ? 'BODY[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)]' : 'BODY[]<0>'} {${data.length}}\r\n`;
          sock.write(out);
          sock.write(data);
          sock.write(')\r\n');
          out = '';
        });
        return send(`${tag} OK fetched\r\n`);
      }
      if (cmd.startsWith('APPEND')) {
        const f = /^APPEND "([^"]+)" (\([^)]*\))/i.exec(rest);
        appended.push({ folder: f?.[1] ?? '', flags: f?.[2] ?? '', raw: lits[0] ?? '' });
        return send(`${tag} OK [APPENDUID 1 9] appended\r\n`);
      }
      if (cmd.startsWith('LOGOUT')) {
        send(`* BYE\r\n${tag} OK\r\n`);
        return sock.end();
      }
      send(`${tag} BAD unknown command\r\n`);
    };
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (need > 0) {
          if (buf.length < need) return;
          parts.push(buf.subarray(0, need).toString('utf8'));
          buf = buf.subarray(need);
          need = 0;
          continue;
        }
        const eol = buf.indexOf('\r\n');
        if (eol < 0) return;
        const piece = buf.subarray(0, eol).toString('utf8');
        buf = buf.subarray(eol + 2);
        line += piece;
        const lit = /\{(\d+)(\+?)\}$/.exec(piece);
        if (lit) {
          need = Number(lit[1]);
          if (!lit[2]) send('+ go ahead\r\n');
          continue;
        }
        const full = line;
        const lits = parts;
        line = '';
        parts = [];
        handle(full, lits);
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as { port: number }).port,
    commands,
    literals,
    xoauth2,
    appended,
    get uidValidity() {
      return fake.uidValidity;
    },
    set uidValidity(v: number) {
      fake.uidValidity = v;
    },
    get uidNext() {
      return fake.uidNext;
    },
    get idle() {
      return fake.idle;
    },
    set idle(v: boolean) {
      fake.idle = v;
    },
    get idling() {
      return idling.size;
    },
    get idleAnswer() {
      return fake.idleAnswer;
    },
    set idleAnswer(v: 'ok' | 'no' | 'end') {
      fake.idleAnswer = v;
    },
    get doneAnswer() {
      return fake.doneAnswer;
    },
    set doneAnswer(v: 'ok' | 'no' | 'none') {
      fake.doneAnswer = v;
    },
    bye: (text = 'shutting down') => {
      for (const sock of [...idling.keys()]) {
        sock.write(`* BYE ${text}\r\n`);
        sock.end();
      }
    },
    notify: () => {
      for (const sock of idling.keys()) sock.write(`* ${messages.length} EXISTS\r\n`);
    },
    drop: () => {
      for (const sock of sockets) sock.destroy();
    },
    set uidNext(v: number | null | undefined) {
      fake.uidNext = v;
    },
    close: () => {
      for (const sock of sockets) sock.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

export interface FakeSmtp {
  port: number;
  /** The XOAUTH2 sign-ins it was given: their user and token, and whether it took them. */
  xoauth2: { user: string; token: string; ok: boolean }[];
  /** What each session did: its envelope and the message as DATA carried it (dot-stuffing undone). */
  sent: { from: string; to: string[]; data: string }[];
  lines: string[];
  close(): Promise<void>;
}

export async function fakeSmtp(
  login = { user: 'me@example.com', pass: 'app-pass' },
  o: {
    authLoginOnly?: boolean;
    refuse?: string;
    /** Answers AUTH XOAUTH2 with an empty 334 first (a request for the response), then reads the response on its own line. */
    asksResponse?: boolean;
    /** Answers AUTH XOAUTH2 with this reply instead of checking the token (`454 4.7.0 …`, `504 5.7.4 …`). */
    authAnswer?: string;
    /**
     * Never takes the token, and keeps asking: an empty 334 to every line (`empty`), or a reason first and
     * then an empty 334 to every line (`reason`): how often the client sends it is in `lines`.
     */
    keepsAsking?: 'empty' | 'reason';
  } & FakeBearer = {},
): Promise<FakeSmtp> {
  const sent: FakeSmtp['sent'] = [];
  const lines: string[] = [];
  const xoauth2: FakeSmtp['xoauth2'] = [];
  const server = createServer((sock) => {
    let buf = '';
    let data: string | undefined;
    let from = '';
    let to: string[] = [];
    let loginStep = 0;
    /** A refused XOAUTH2 waits for the client's empty line, then says 535 (as Gmail does). */
    let refusedToken = false;
    /** The response to an AUTH XOAUTH2 answered with an empty 334 comes next, on its own line. */
    let responseNext = false;
    /** `keepsAsking`: every line from now on gets an empty 334. */
    let asking = false;
    const checkToken = (b64: string) => {
      const given = readXoauth2(b64);
      const ok = Boolean(o.bearer && given && o.bearer(given.user, given.token));
      if (given) xoauth2.push({ ...given, ok });
      if (ok) sock.write('235 2.7.0 Accepted\r\n');
      else if (o.refusal === 'microsoft') sock.write('535 5.7.3 Authentication unsuccessful [FAKE.prod.outlook.com]\r\n');
      else {
        refusedToken = true;
        sock.write(`334 ${o.challenge ?? GMAIL_XOAUTH2_ERROR}\r\n`);
      }
    };
    sock.write('220 fake SMTP ready\r\n');
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (data !== undefined) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buf.slice(0, end + 2);
          buf = buf.slice(end + 5);
          sent.push({ from, to, data: data.replace(/^\.\./gm, '.') });
          data = undefined;
          sock.write('250 OK queued as FAKE123\r\n');
          continue;
        }
        const eol = buf.indexOf('\r\n');
        if (eol < 0) return;
        const line = buf.slice(0, eol);
        buf = buf.slice(eol + 2);
        lines.push(line);
        if (asking) {
          sock.write('334 \r\n');
        } else if (refusedToken) {
          refusedToken = false;
          sock.write(
            '535-5.7.8 Username and Password not accepted. For more information, go to\r\n535 5.7.8  https://support.google.com/mail/?p=BadCredentials fake\r\n',
          );
        } else if (responseNext) {
          responseNext = false;
          checkToken(line);
        } else if (/^AUTH XOAUTH2( |$)/i.test(line)) {
          if (!o.bearer) sock.write('504 5.7.4 Unrecognized authentication type\r\n');
          else if (o.authAnswer) sock.write(`${o.authAnswer}\r\n`);
          else if (o.keepsAsking) {
            asking = true;
            sock.write(o.keepsAsking === 'empty' ? '334 \r\n' : `334 ${GMAIL_XOAUTH2_ERROR}\r\n`);
          } else if (o.asksResponse) {
            responseNext = true;
            sock.write('334 \r\n');
          } else checkToken(line.slice('AUTH XOAUTH2 '.length));
        } else if (loginStep === 1) {
          loginStep = Buffer.from(line, 'base64').toString() === login.user ? 2 : -1;
          sock.write('334 UGFzc3dvcmQ6\r\n');
        } else if (loginStep === 2 || loginStep === -1) {
          const ok = loginStep === 2 && Buffer.from(line, 'base64').toString() === login.pass;
          loginStep = 0;
          sock.write(ok ? '235 ok\r\n' : '535 bad credentials\r\n');
        } else if (/^EHLO/i.test(line))
          sock.write(
            `250-fake\r\n250-SIZE 1000000\r\n250 AUTH ${o.authLoginOnly ? 'LOGIN' : 'PLAIN LOGIN'}${o.bearer ? ' XOAUTH2' : ''}\r\n`,
          );
        else if (/^AUTH PLAIN /i.test(line)) {
          const ok = Buffer.from(line.slice(11), 'base64').toString() === `\0${login.user}\0${login.pass}`;
          sock.write(ok ? '235 2.7.0 Authentication successful\r\n' : '535 5.7.8 bad credentials\r\n');
        } else if (/^AUTH LOGIN$/i.test(line)) {
          loginStep = 1;
          sock.write('334 VXNlcm5hbWU6\r\n');
        } else if (/^MAIL FROM:<(.*)>/i.test(line)) {
          from = /^MAIL FROM:<(.*)>/i.exec(line)![1]!;
          to = [];
          sock.write('250 ok\r\n');
        } else if (/^RCPT TO:<(.*)>/i.test(line)) {
          const rcpt = /^RCPT TO:<(.*)>/i.exec(line)![1]!;
          if (o.refuse && rcpt === o.refuse) sock.write('550 no such user\r\n');
          else {
            to.push(rcpt);
            sock.write('250 ok\r\n');
          }
        } else if (/^DATA$/i.test(line)) {
          data = '';
          sock.write('354 go ahead\r\n');
        } else if (/^QUIT$/i.test(line)) {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('500 what?\r\n');
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as { port: number }).port,
    xoauth2,
    sent,
    lines,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface FakeCalDav {
  url: string;
  reports: { depth?: string; body: string }[];
  puts: { path: string; ics: string; ifNoneMatch?: string }[];
  close(): Promise<void>;
}

/** A moment as iCalendar's UTC DATE-TIME, and back. */
const icsUtc = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const fromIcsUtc = (v: string): number | undefined => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : undefined;
};

/**
 * An iCalendar file as a server that expands recurring events answers a REPORT asking it to (RFC 4791
 * `expand`, between `from` and `to`): each time of a recurring event (here a DAILY one, with its COUNT,
 * starting at a time in UTC) a VEVENT of its own, with its RECURRENCE-ID, its times in UTC and no
 * RRULE. Other events are as they are.
 */
export function expandIcs(ics: string, from: number, to: number): string {
  const unfolded = ics.replace(/\r?\n[ \t]/g, '');
  return unfolded.replace(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT\r?\n/g, (whole, inner: string) => {
    const lines = inner.split(/\r?\n/).filter(Boolean);
    const rule = lines.find((l) => l.startsWith('RRULE:'));
    const start = fromIcsUtc(lines.find((l) => l.startsWith('DTSTART:'))?.slice('DTSTART:'.length) ?? '');
    if (!rule || start === undefined || !/FREQ=DAILY/.test(rule)) return whole;
    const count = Number(/COUNT=(\d+)/.exec(rule)?.[1] ?? 366);
    const end = fromIcsUtc(lines.find((l) => l.startsWith('DTEND:'))?.slice('DTEND:'.length) ?? '');
    const rest = lines.filter((l) => !/^(RRULE|DTSTART|DTEND)[:;]/.test(l));
    let out = '';
    for (let i = 0; i < count; i++) {
      const at = start + i * 86_400_000;
      if (at < from - 86_400_000 || at > to) continue;
      out +=
        `BEGIN:VEVENT\r\n${rest.join('\r\n')}\r\nRECURRENCE-ID:${icsUtc(at)}\r\nDTSTART:${icsUtc(at)}\r\n` +
        `${end !== undefined ? `DTEND:${icsUtc(at + end - start)}\r\n` : ''}END:VEVENT\r\n`;
    }
    return out;
  });
}

/**
 * A CalDAV calendar at `/cal/me/` with these iCalendar files, for this user and password, beside a
 * to-do list (`/cal/tasks/`, VTODO only). `icloud`: its discovery answers written as iCloud writes
 * them (DAV: as the default namespace, `xmlns` on each element, the home's absolute address, the
 * components' names in single quotes), as recorded from caldav.icloud.com. `expand`: it expands
 * recurring events when a REPORT asks it to (`expandIcs()`); `refuseExpand`: it answers a REPORT that
 * asks to expand with this status instead (a server that cannot). `bearer`: it takes this OAuth token
 * (`Bearer`) instead of the password.
 */
export async function fakeCalDav(
  files: string[],
  login = { user: 'me@example.com', pass: 'app-pass' },
  o: { icloud?: boolean; expand?: boolean; refuseExpand?: number; bearer?: string } = {},
): Promise<FakeCalDav> {
  const reports: FakeCalDav['reports'] = [];
  const puts: FakeCalDav['puts'] = [];
  const server: HttpServer = createHttp((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => {
      const expected = o.bearer ? `Bearer ${o.bearer}` : `Basic ${Buffer.from(`${login.user}:${login.pass}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'www-authenticate': o.bearer ? 'Bearer realm="cal"' : 'Basic realm="cal"' });
        return res.end();
      }
      if (req.url === '/moved/') {
        res.writeHead(301, { location: 'https://elsewhere.example/cal/' });
        return res.end();
      }
      if (req.method === 'REPORT') {
        reports.push({ depth: req.headers.depth as string | undefined, body });
        const expanding = /<c:expand start="(\w+)" end="(\w+)"\/>/.exec(body);
        if (expanding && o.refuseExpand) {
          res.writeHead(o.refuseExpand);
          return res.end();
        }
        const answered =
          expanding && o.expand ? files.map((f) => expandIcs(f, fromIcsUtc(expanding[1]!)!, fromIcsUtc(expanding[2]!)!)) : files;
        const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        return res.end(
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${answered
            .map(
              (f, i) =>
                `<D:response><D:href>/cal/me/${i}.ics</D:href><D:propstat><D:prop><D:getetag>"${i}"</D:getetag><C:calendar-data>${i % 2 ? `<![CDATA[${f}]]>` : escape(f)}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
            )
            .join('')}</D:multistatus>`,
        );
      }
      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        if (o.icloud) {
          const ms = (body: string) =>
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<multistatus xmlns="DAV:">\n${body}\n</multistatus>`;
          const ok = (href: string, props: string) =>
            `    <response xmlns="DAV:">\n        <href>${href}</href>\n            <propstat>\n                <prop>\n                    ${props}\n                </prop>\n                <status>HTTP/1.1 200 OK</status>\n            </propstat>\n    </response>`;
          const comps = (...names: string[]) =>
            `<supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav">${names.map((n) => `<comp name='${n}' xmlns='urn:ietf:params:xml:ns:caldav'/>`).join('')}</supported-calendar-component-set>`;
          if (req.url === '/')
            return res.end(
              ms(ok('/', '<current-user-principal xmlns="DAV:"><href xmlns="DAV:">/principals/me/</href></current-user-principal>')),
            );
          if (req.url === '/principals/me/')
            return res.end(
              ms(
                ok(
                  '/principals/me/',
                  `<calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">http://${req.headers.host}/cal/</href></calendar-home-set>`,
                ),
              ),
            );
          if (req.url === '/cal/')
            return res.end(
              ms(
                [
                  ok(
                    '/cal/',
                    `<displayname xmlns="DAV:">Me</displayname><resourcetype xmlns="DAV:"><collection/></resourcetype>${comps('VEVENT', 'VTODO')}`,
                  ),
                  ok(
                    '/cal/tasks/',
                    `<displayname xmlns="DAV:">Reminders</displayname><resourcetype xmlns="DAV:"><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>${comps('VTODO')}`,
                  ),
                  ok(
                    '/cal/me/',
                    `<displayname xmlns="DAV:">Family &amp; friends</displayname><resourcetype xmlns="DAV:"><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>${comps('VEVENT', 'VTODO')}`,
                  ),
                ].join('\n'),
              ),
            );
          return res.end(ms(''));
        }
        const ms = (body: string) =>
          `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`;
        if (req.url === '/')
          return res.end(
            ms(
              '<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>',
            ),
          );
        if (req.url === '/principals/me/')
          return res.end(
            ms(
              '<d:response><d:href>/principals/me/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>/cal/</d:href></cal:calendar-home-set></d:prop></d:propstat></d:response>',
            ),
          );
        if (req.url === '/cal/') {
          return res.end(
            ms(
              '<d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>' +
                '<d:response><d:href>/cal/me/</d:href><d:propstat><d:prop><d:displayname>Personal</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype></d:prop></d:propstat><d:propstat><d:prop><cal:supported-calendar-component-set/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>' +
                '<d:response><d:href>/cal/tasks/</d:href><d:propstat><d:prop><d:displayname>Tasks</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set></d:prop></d:propstat></d:response>' +
                '<d:response><d:href>/cal/inbox/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><cal:schedule-inbox/></d:resourcetype></d:prop></d:propstat></d:response>' +
                '<d:response><d:href>https://elsewhere.example/cal/x/</d:href><d:propstat><d:prop><d:resourcetype><cal:calendar/></d:resourcetype></d:prop></d:propstat></d:response>',
            ),
          );
        }
        return res.end(ms(''));
      }
      if (req.method === 'PUT') {
        puts.push({ path: req.url ?? '', ics: body, ifNoneMatch: req.headers['if-none-match'] as string | undefined });
        res.writeHead(201);
        return res.end();
      }
      res.writeHead(405);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/cal/me/`, reports, puts, close: () => new Promise((r) => server.close(() => r())) };
}
