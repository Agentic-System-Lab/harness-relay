import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/*
 * Cua's own viewer of a chat's computer (cua-spacesd's page: smoother video than the panel, the clipboard), for a
 * browser on the computer Harness Relay runs on, through a proxy of Harness Relay's on a loopback port of its own,
 * so that what the viewer may do follows who has control of the computer, as the panel does.
 *
 * Cua cannot take a viewer's ticket back (`cua sb view` makes one, good until it expires; nothing revokes it),
 * so the browser never gets one. It gets this proxy's address and a token of the proxy's (in the link's `#`,
 * which the page keeps in its storage), and the proxy holds Cua's tickets: one to watch only (`--view-only`)
 * while the agents have the computer, one with input while the user has control. Every call the page makes goes
 * through the proxy, which checks the token, the page's origin and the call (only those Cua's page makes), and
 * gives Cua the ticket for who has control now. When that changes, the page's streams end, the media addresses
 * Cua gave before are refused (`4401`: the page asks for a new stream, under the other ticket), and nothing the
 * page sends on an older stream goes on: each piece is checked against who has control as it arrives. A script
 * of the proxy's in the page (`FOLLOW_SCRIPT`, same origin, which its policy allows) reloads it then, since
 * Cua's page sets up its input once, as it loads: a page opened to watch takes input only once loaded again.
 * The proxy is closed when the computer stops (and at shutdown); the page's address then answers nothing.
 */

/** What `cua sb view` gave: the viewer's own origin (a loopback port) and its ticket. */
export interface CuaViewerTicket {
  origin: string;
  ticket: string;
  /** When Cua stops taking it (ms since the epoch), if it said. */
  expiresAt?: number;
}

export interface ViewerProxyDeps {
  /** A ticket for Cua's viewer: with input (`true`), or to watch only. */
  mint: (input: boolean) => Promise<CuaViewerTicket>;
  /** Whether the user has control now: then the viewer takes input. */
  input: () => boolean;
  /** Something came from a viewer with input: the computer is in use. */
  used?: () => void;
  now?: () => number;
}

type Mode = 'input' | 'watch';

/** The calls of Cua's page the proxy passes on (`<service>/<method>` of `cua.env.v1`): never another. */
export const VIEWER_CALLS: ReadonlySet<string> = new Set([
  'SystemService/GetCapabilities',
  'StreamService/ListTargets',
  'StreamService/OpenMedia',
  'StreamService/SetPreferences',
  'PresenceService/Join',
  'PresenceService/UpdateCursor',
  'PresenceService/Leave',
  'ComputerService/GetClipboard',
  'ComputerService/SetClipboard',
]);

/** The header Cua's page sends its ticket in (here: the proxy's token, which the proxy swaps for Cua's ticket). */
const AUTH = 'x-cua-env-authorization';
/** A stream's address, as OpenMedia gives it. */
const MEDIA_PATH = /^\/media\?ticket=[A-Za-z0-9._~-]{1,4096}$/;
const CALL_PATH = /^\/cua\.env\.v1\.([A-Za-z]{1,64}\/[A-Za-z]{1,64})$/;
/** Cua's page and its files (no `..`: checked apart). */
const PAGE_FILES = /^\/viewer\/[A-Za-z0-9._/-]{0,200}(\?[A-Za-z0-9._~=&%-]{0,500})?$/;
const FOLLOW_PATH = '/viewer/relay-follow.js';
const STATE_PATH = '/viewer/relay-state';
/** A ticket is minted again when this little of it is left. */
const REFRESH_MS = 2 * 60_000;
/** How many media addresses are kept as allowed (the latest), and how big an answer read whole may be. */
const ALLOWED_MAX = 32;
const READ_MAX = 1 << 20;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The request headers passed on to Cua: never a cookie (cookies are per host, not per port), origin or referrer. */
const PASSED = [
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connect-protocol-version',
  'connect-timeout-ms',
  'content-length',
  'content-type',
  'grpc-timeout',
  'if-modified-since',
  'if-none-match',
  'pragma',
  'range',
  'user-agent',
  'x-grpc-web',
  'x-user-agent',
];
const WS_PASSED = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions', 'user-agent'];
/** Response headers not passed back: hop-by-hop ones, cookies, and the CORS that would let another page read it. */
const DROPPED = new Set([
  'access-control-allow-credentials',
  'access-control-allow-origin',
  'access-control-expose-headers',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * The proxy's script in Cua's page, before the page's own: the clipboard as the page's powers have it (shared
 * with input, off to watch), and a reload once who has control changed, for the page to set itself up again.
 */
export const FOLLOW_SCRIPT = `const start = new URL(import.meta.url).searchParams.get('mode');
const hash = new URLSearchParams(location.hash.slice(1));
hash.set('clipboard', start === 'input' ? 'view' : '0');
history.replaceState(history.state, '', location.pathname + location.search + '#' + hash);
const poll = async () => {
  try {
    const answer = await fetch('./relay-state', { cache: 'no-store' });
    if (!answer.ok) return;
    if ((await answer.json()).mode !== start) return location.reload();
  } catch {
    return;
  }
  setTimeout(poll, 1000);
};
setTimeout(poll, 1000);
`;

/** Cua's page with the proxy's script first in its head (`mode`: the powers it is served with). */
export function withFollow(html: string, mode: Mode): string {
  const tag = `<script type="module" src="./relay-follow.js?mode=${mode}"></script>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (!head) return tag + html;
  const end = head.index + head[0].length;
  return html.slice(0, end) + tag + html.slice(end);
}

/**
 * The media addresses in an answer of OpenMedia (protobuf, in gRPC-web's frames): each `/media?…` string, read
 * by the length its field gives (the bytes after it may be ones a ticket has too), and only a whole address.
 */
export function mediaPaths(body: Buffer): string[] {
  const out: string[] = [];
  for (let i = body.indexOf('/media?'); i >= 0; i = body.indexOf('/media?', i + 1)) {
    // The length is a varint ending right before the string: its last byte has no continuation bit, the bytes
    // before it of the same varint have one (the field's tag before it ends with a byte without).
    const last = i - 1;
    if (last < 0 || body[last]! >= 0x80) continue;
    let first = last;
    while (first > 0 && body[first - 1]! >= 0x80 && last - first < 2) first--;
    let len = 0;
    for (let k = last; k >= first; k--) len = len * 128 + (body[k]! & 0x7f);
    if (!len || i + len > body.length) continue;
    const path = body.subarray(i, i + len).toString('latin1');
    if (MEDIA_PATH.test(path)) out.push(path);
  }
  return out;
}

/** Cua's viewer link (`cua sb view --json`'s `url`), when it is a page on a loopback port with a ticket. */
export function cuaViewerTicket(url: unknown, expiresUnix?: unknown): CuaViewerTicket | undefined {
  if (typeof url !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/viewer\//.test(url)) return undefined;
  const at = new URL(url);
  const ticket = new URLSearchParams(at.hash.slice(1)).get('ticket');
  if (!ticket || !/^[A-Za-z0-9._~-]{1,4096}$/.test(ticket)) return undefined;
  return { origin: at.origin, ticket, ...(typeof expiresUnix === 'number' ? { expiresAt: expiresUnix * 1000 } : {}) };
}

const digest = (s: string) => createHash('sha256').update(s).digest();
/** A host as `net` and `http` take it (`[::1]` without its brackets). */
const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, '');

/** Answers a WebSocket's handshake only to close it at once with `code` (the page asks for a new stream). */
function closeWith(req: IncomingMessage, socket: Duplex, code: number): void {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/=]{16,64}$/.test(key)) return void socket.destroy();
  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  const protocol = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')[0]!
    .trim();
  const head =
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    (/^[A-Za-z0-9.!#$%&'*+^_`|~-]{1,64}$/.test(protocol) ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') +
    '\r\n';
  socket.end(Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from([0x88, 0x02, code >> 8, code & 0xff])]));
}

interface Stream {
  client: Duplex;
  upstream: Socket;
  /** The generation of control it was opened in (`ViewerProxy.gen`). */
  gen: number;
}

/** One computer's viewer proxy, on `127.0.0.1` at a port of its own, until `close()`. */
export class ViewerProxy {
  private readonly server: Server;
  private readonly token = randomBytes(32).toString('base64url');
  private readonly listening: Promise<void>;
  private readonly now: () => number;
  private port = 0;
  private mode: Mode;
  /** Counts the changes of control: a stream, and an OpenMedia answer, belong to the one they began in. */
  private gen = 0;
  /** The media addresses Cua gave since control last changed: the only ones a stream may attach to. */
  private allowed = new Set<string>();
  private readonly streams = new Set<Stream>();
  private readonly tickets = new Map<Mode, CuaViewerTicket>();
  private readonly minting = new Map<Mode, Promise<CuaViewerTicket>>();
  closed = false;

  constructor(private readonly deps: ViewerProxyDeps) {
    this.now = deps.now ?? Date.now;
    this.mode = deps.input() ? 'input' : 'watch';
    this.server = createServer((req, res) => {
      this.http(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
    this.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => socket.destroy());
      this.upgrade(req, socket, head).catch(() => socket.destroy());
    });
    this.server.on('clientError', (_err, socket) => socket.destroy());
    this.listening = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The page's address, with the proxy's token: listening, and Cua's ticket for the powers it has now made. */
  async ready(): Promise<string> {
    await this.listening;
    await this.ticket(this.sync());
    return `${this.origin}/viewer/#ticket=${this.token}`;
  }

  /**
   * The viewer's powers now. When who has control changed since: the streams end, and the media addresses Cua
   * gave before are refused (the page asks for new ones, under the other ticket).
   */
  sync(): Mode {
    const mode: Mode = !this.closed && this.deps.input() ? 'input' : 'watch';
    if (mode !== this.mode) {
      this.mode = mode;
      this.gen++;
      this.allowed = new Set();
      this.endStreams();
    }
    return mode;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.gen++;
    this.allowed = new Set();
    this.endStreams();
    this.server.close();
    this.server.closeAllConnections();
  }

  private endStreams(): void {
    for (const s of this.streams) {
      s.client.destroy();
      s.upstream.destroy();
    }
    this.streams.clear();
  }

  /** Cua's ticket for `mode`: kept until it is about to expire, minted once at a time. */
  private ticket(mode: Mode): Promise<CuaViewerTicket> {
    const kept = this.tickets.get(mode);
    if (kept && (kept.expiresAt ?? Infinity) - this.now() > REFRESH_MS) return Promise.resolve(kept);
    let pending = this.minting.get(mode);
    if (!pending) {
      const made = this.now();
      pending = this.deps
        .mint(mode === 'input')
        // Without an expiry Cua's 30 minutes are counted from now.
        .then((t) => (this.tickets.set(mode, { ...t, expiresAt: t.expiresAt ?? made + 30 * 60_000 }), t))
        .finally(() => this.minting.delete(mode));
      this.minting.set(mode, pending);
    }
    return pending;
  }

  /** A request for this proxy's own address (a page of another host is refused: DNS rebinding). */
  private ours(req: IncomingMessage): boolean {
    return req.headers.host === `127.0.0.1:${this.port}`;
  }

  private tokenOk(value: unknown): boolean {
    return typeof value === 'string' && timingSafeEqual(digest(value), digest(`Bearer ${this.token}`));
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? '/';
    if (this.closed || !this.ours(req)) return void res.writeHead(403).end();
    const mode = this.sync();
    if (req.method === 'GET' && path === STATE_PATH) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return void res.end(JSON.stringify({ mode }));
    }
    if (req.method === 'GET' && /^\/viewer\/relay-follow\.js(\?mode=(input|watch))?$/.test(path)) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(FOLLOW_SCRIPT);
    }
    const call = CALL_PATH.exec(path)?.[1];
    if (call) {
      if (req.method !== 'POST' || !VIEWER_CALLS.has(call)) return void res.writeHead(404).end();
      if (req.headers.origin !== this.origin) return void res.writeHead(403).end();
      if (!this.tokenOk(req.headers[AUTH])) return void res.writeHead(401).end();
      const gen = this.gen;
      const ticket = await this.ticket(mode);
      // Control changed while the ticket was made: the page asks again, under the other one.
      if (gen !== this.gen || this.closed) return void res.writeHead(401).end();
      return this.forward(req, res, ticket, { auth: ticket.ticket, media: call === 'StreamService/OpenMedia' ? gen : undefined });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && PAGE_FILES.test(path) && !path.includes('..')) {
      const page = /^\/viewer\/(index\.html)?(\?|$)/.test(path) && req.method === 'GET';
      return this.forward(req, res, await this.ticket(mode), page ? { page: mode } : {});
    }
    res.writeHead(404).end();
  }

  /** Passes a request on to Cua's viewer, with Cua's ticket for a call; an answer to read whole is read so. */
  private forward(
    req: IncomingMessage,
    res: ServerResponse,
    ticket: CuaViewerTicket,
    o: { auth?: string; media?: number; page?: Mode },
  ): Promise<void> {
    const target = new URL(ticket.origin);
    const headers: OutgoingHttpHeaders = { host: target.host };
    for (const name of PASSED) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    if (o.auth) headers[AUTH] = `Bearer ${o.auth}`;
    // The page is changed (the proxy's script): asked for as it is.
    if (o.page) delete headers['accept-encoding'];
    return new Promise((resolve) => {
      const up = httpRequest({ host: hostOf(target), port: target.port, method: req.method, path: req.url, headers }, (answer) => {
        const out: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(answer.headers)) if (!DROPPED.has(name) && value !== undefined) out[name] = value;
        const html = o.page && /^text\/html\b/i.test(String(answer.headers['content-type'] ?? '')) && !answer.headers['content-encoding'];
        if (o.media === undefined && !html) {
          res.writeHead(answer.statusCode ?? 502, out);
          answer.pipe(res);
          answer.on('end', resolve);
          answer.on('error', () => (res.destroy(), resolve()));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        answer.on('data', (d: Buffer) => {
          size += d.length;
          if (size > READ_MAX) {
            up.destroy();
            res.destroy();
            return resolve();
          }
          chunks.push(d);
        });
        answer.on('error', () => (res.destroy(), resolve()));
        answer.on('end', () => {
          let body = Buffer.concat(chunks);
          // Only an answer of the control it was asked under allows its streams.
          if (o.media !== undefined && o.media === this.gen && !this.closed) for (const path of mediaPaths(body)) this.allow(path);
          if (html) body = Buffer.from(withFollow(body.toString('utf8'), o.page!), 'utf8');
          out['content-length'] = String(body.length);
          res.writeHead(answer.statusCode ?? 502, out);
          res.end(body);
          resolve();
        });
      });
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
        resolve();
      });
      req.pipe(up);
    });
  }

  private allow(path: string): void {
    this.allowed.delete(path);
    this.allowed.add(path);
    for (const old of this.allowed) {
      if (this.allowed.size <= ALLOWED_MAX) break;
      this.allowed.delete(old);
    }
  }

  /** A stream of the page: to an address Cua gave since control last changed, else closed for a new one. */
  private async upgrade(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const path = req.url ?? '';
    if (this.closed || !this.ours(req) || req.headers.origin !== this.origin || !MEDIA_PATH.test(path)) return void client.destroy();
    const mode = this.sync();
    if (!this.allowed.has(path)) return closeWith(req, client, 4401);
    const gen = this.gen;
    const target = new URL((await this.ticket(mode)).origin);
    if (gen !== this.gen || this.closed) return closeWith(req, client, 4401);
    const upstream = connect(Number(target.port), hostOf(target));
    const stream: Stream = { client, upstream, gen };
    this.streams.add(stream);
    const end = () => {
      client.destroy();
      upstream.destroy();
      this.streams.delete(stream);
    };
    client.on('close', end);
    client.on('error', end);
    upstream.on('close', end);
    upstream.on('error', end);
    upstream.once('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${target.host}`,
        `Origin: ${target.origin}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
      ];
      for (const name of WS_PASSED) {
        const value = req.headers[name];
        if (typeof value === 'string') lines.push(`${name}: ${value}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) this.send(stream, head);
      client.on('data', (d: Buffer) => this.send(stream, d));
      upstream.pipe(client);
    });
  }

  /** What the page sends on a stream: only while control is as it was when the stream opened. */
  private send(s: Stream, data: Buffer): void {
    this.sync();
    if (s.gen !== this.gen || this.closed) {
      s.client.destroy();
      s.upstream.destroy();
      this.streams.delete(s);
      return;
    }
    if (this.mode === 'input') this.deps.used?.();
    s.upstream.write(data);
  }
}
