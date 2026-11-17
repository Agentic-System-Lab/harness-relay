/*
 * Stand-ins for a mail account's servers, on local ports, for the mail and calendar tools' tests:
 * an IMAP server (sign-in, folders, search, fetch, append, with literals as servers send them), an
 * SMTP server (EHLO, AUTH, the envelope, DATA), and a CalDAV calendar (REPORT and PUT). Plain TCP and
 * HTTP on 127.0.0.1: what Harness Relay allows only for a server on this computer.
 */
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';

export interface FakeMessage {
  uid: number;
  raw: string;
  seen?: boolean;
}

export interface FakeImap {
  port: number;
  /** Every command line as it came (literals as `{n}`), and each literal's text. */
  commands: string[];
  literals: string[];
  appended: { folder: string; flags: string; raw: string }[];
  /** INBOX's UIDVALIDITY, which EXAMINE answers (change it to stand for a rebuilt folder). */
  uidValidity: number;
  close(): Promise<void>;
}

/**
 * An IMAP server with one INBOX, a Drafts folder (`\Drafts`), and these messages in INBOX (push more to
 * the array for mail that arrives). EXAMINE answers INBOX's UIDVALIDITY and UIDNEXT; `UID SEARCH` takes
 * a UID range (`n:*`, as RFC 3501 reads it).
 */
export async function fakeImap(messages: FakeMessage[], login = { user: 'me@example.com', pass: 'app-pass' }): Promise<FakeImap> {
  const commands: string[] = [];
  const literals: string[] = [];
  const appended: FakeImap['appended'] = [];
  const fake = { uidValidity: 7 };
  const server: Server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    let line = '';
    let need = 0; // bytes of a literal still to read
    let parts: string[] = [];
    const send = (s: string) => sock.write(s);
    send('* OK [CAPABILITY IMAP4rev1] fake IMAP ready\r\n');
    const handle = (full: string, lits: string[]) => {
      commands.push(full);
      literals.push(...lits);
      const m = /^(\S+) (.*)$/.exec(full);
      if (!m) return;
      const [, tag, rest] = m as unknown as [string, string, string];
      const cmd = rest.toUpperCase();
      if (cmd.startsWith('LOGIN')) {
        const q = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.replace(/\\(.)/g, '$1'));
        return send(
          q[0] === login.user && q[1] === login.pass
            ? `${tag} OK signed in\r\n`
            : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`,
        );
      }
      if (cmd.startsWith('CAPABILITY')) return send(`* CAPABILITY IMAP4rev1 LITERAL+ SPECIAL-USE\r\n${tag} OK\r\n`);
      if (cmd.startsWith('LIST'))
        return send(
          `* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Drafts) "/" "Drafts"\r\n* LIST (\\HasNoChildren) "/" {7}\r\nArchive\r\n${tag} OK\r\n`,
        );
      if (cmd.startsWith('EXAMINE') || cmd.startsWith('SELECT')) {
        if (!/"INBOX"/i.test(rest)) return send(`${tag} NO no such folder\r\n`);
        const next = Math.max(0, ...messages.map((x) => x.uid)) + 1;
        return send(
          `* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY ${fake.uidValidity}] UIDs valid\r\n* OK [UIDNEXT ${next}] Predicted next UID\r\n${tag} OK [READ-ONLY] done\r\n`,
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
          out += `* ${i + 1} FETCH (UID ${msg.uid} FLAGS (${msg.seen ? '\\Seen' : ''}) INTERNALDATE "05-Jan-2026 09:00:00 +0000" ${headersOnly ? 'BODY[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)]' : 'BODY[]<0>'} {${data.length}}\r\n`;
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
    appended,
    get uidValidity() {
      return fake.uidValidity;
    },
    set uidValidity(v: number) {
      fake.uidValidity = v;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface FakeSmtp {
  port: number;
  /** What each session did: its envelope and the message as DATA carried it (dot-stuffing undone). */
  sent: { from: string; to: string[]; data: string }[];
  lines: string[];
  close(): Promise<void>;
}

export async function fakeSmtp(
  login = { user: 'me@example.com', pass: 'app-pass' },
  o: { authLoginOnly?: boolean; refuse?: string } = {},
): Promise<FakeSmtp> {
  const sent: FakeSmtp['sent'] = [];
  const lines: string[] = [];
  const server = createServer((sock) => {
    let buf = '';
    let data: string | undefined;
    let from = '';
    let to: string[] = [];
    let loginStep = 0;
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
        if (loginStep === 1) {
          loginStep = Buffer.from(line, 'base64').toString() === login.user ? 2 : -1;
          sock.write('334 UGFzc3dvcmQ6\r\n');
        } else if (loginStep === 2 || loginStep === -1) {
          const ok = loginStep === 2 && Buffer.from(line, 'base64').toString() === login.pass;
          loginStep = 0;
          sock.write(ok ? '235 ok\r\n' : '535 bad credentials\r\n');
        } else if (/^EHLO/i.test(line))
          sock.write(`250-fake\r\n250-SIZE 1000000\r\n250 AUTH ${o.authLoginOnly ? 'LOGIN' : 'PLAIN LOGIN'}\r\n`);
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
  return { port: (server.address() as { port: number }).port, sent, lines, close: () => new Promise((r) => server.close(() => r())) };
}

export interface FakeCalDav {
  url: string;
  reports: { depth?: string; body: string }[];
  puts: { path: string; ics: string; ifNoneMatch?: string }[];
  close(): Promise<void>;
}

/**
 * A CalDAV calendar at `/cal/me/` with these iCalendar files, for this user and password, beside a
 * to-do list (`/cal/tasks/`, VTODO only). `icloud`: its discovery answers written as iCloud writes
 * them (DAV: as the default namespace, `xmlns` on each element, the home's absolute address, the
 * components' names in single quotes), as recorded from caldav.icloud.com.
 */
export async function fakeCalDav(
  files: string[],
  login = { user: 'me@example.com', pass: 'app-pass' },
  o: { icloud?: boolean } = {},
): Promise<FakeCalDav> {
  const reports: FakeCalDav['reports'] = [];
  const puts: FakeCalDav['puts'] = [];
  const server: HttpServer = createHttp((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString('utf8')));
    req.on('end', () => {
      const expected = `Basic ${Buffer.from(`${login.user}:${login.pass}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="cal"' });
        return res.end();
      }
      if (req.url === '/moved/') {
        res.writeHead(301, { location: 'https://elsewhere.example/cal/' });
        return res.end();
      }
      if (req.method === 'REPORT') {
        reports.push({ depth: req.headers.depth as string | undefined, body });
        const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        return res.end(
          `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${files
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
