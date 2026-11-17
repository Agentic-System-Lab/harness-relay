import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';

/*
 * The browser's own proxy: Chromium is started with it as its proxy for everything, this computer's
 * addresses included (`--proxy-server`, `--proxy-bypass-list=<-loopback>`), so every connection a page,
 * a frame, a worker or a WebSocket makes comes here. It never asks the system for a name's addresses
 * nor lets Chromium do so: `route` gives the addresses to connect to, looked up and checked by
 * `BrowserService` with the same rules (and the same answers) as its gate, and the connection goes to
 * one of those addresses. So a name whose addresses change between the check and the connection (DNS
 * rebinding) reaches nothing it was not checked for.
 *
 * It listens on loopback only, and serves only the browsers Harness Relay started: each one proves
 * itself with a password of its own (proxy Basic authentication, answered through CDP's
 * `Fetch.authRequired`); a connection without one gets a 407 and nothing else.
 */

/** Where a connection may go: the addresses to try, in order, or why it may not. */
export type ProxyRoute = { addresses: string[] } | { refused: string };

/** The user name every browser gives; its password says which conversation's browser it is. */
export const PROXY_USER = 'relay';

/** Headers that belong to one hop, never passed on. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer', 'upgrade']);

const CHALLENGE = 'Basic realm="Harness Relay browser"';

/** Connects to the first of `addresses` that answers on `port`. */
function connectFirst(addresses: readonly string[], port: number, timeoutMs = 15_000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = (last?: Error) => {
      const address = addresses[i++];
      if (address === undefined) return reject(last ?? new Error('no address'));
      const sock = connect({ host: address, port });
      const timer = setTimeout(() => sock.destroy(new Error('timed out')), timeoutMs);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.removeAllListeners('error');
        resolve(sock);
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        next(err);
      });
    };
    next();
  });
}

/** `host:port` of a CONNECT request (`[::1]:443` for an IPv6 address). */
export function connectTarget(raw: string | undefined): { host: string; port: number } | undefined {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(raw ?? '');
  if (!m) return undefined;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return undefined;
  return { host: (m[1] ?? m[2])!, port };
}

export class BrowserProxy {
  private server?: Server;
  private starting?: Promise<void>;
  private readonly sockets = new Set<Socket>();
  /** The browsers' passwords, by which `route` knows whose connection it is. */
  private readonly passwords = new Set<string>();
  port = 0;

  constructor(
    /** Where a connection of the browser with `password` to `host`:`port` may go (`secure`: a CONNECT tunnel). */
    private route: (password: string, host: string, port: number, secure: boolean) => Promise<ProxyRoute>,
  ) {}

  /** A password for one browser, until `forget()`. */
  issue(): string {
    const password = randomBytes(24).toString('base64url');
    this.passwords.add(password);
    return password;
  }

  forget(password: string): void {
    this.passwords.delete(password);
  }

  start(): Promise<void> {
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => void this.forward(req, res));
      server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => void this.tunnel(req, client, head));
      server.on('upgrade', (req: IncomingMessage, client: Socket, head: Buffer) => void this.upgrade(req, client, head));
      server.on('connection', (sock: Socket) => {
        this.sockets.add(sock);
        sock.on('close', () => this.sockets.delete(sock));
      });
      server.on('clientError', (_err, sock: Socket) => sock.destroy());
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        this.server = server;
        resolve();
      });
    });
    return this.starting;
  }

  stop(): void {
    for (const sock of this.sockets) sock.destroy();
    this.server?.close();
    this.server = undefined;
    this.starting = undefined;
    this.passwords.clear();
  }

  /** The password a request proves itself with, when it is one this proxy issued. */
  private who(req: IncomingMessage): string | undefined {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(req.headers['proxy-authorization'] ?? ''));
    if (!m) return undefined;
    const text = Buffer.from(m[1]!, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0 || text.slice(0, colon) !== PROXY_USER) return undefined;
    const given = Buffer.from(text.slice(colon + 1));
    for (const p of this.passwords) {
      const known = Buffer.from(p);
      if (known.length === given.length && timingSafeEqual(known, given)) return p;
    }
    return undefined;
  }

  /** An http:// request (`GET http://host/path`), passed on to the address it may go to. */
  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = this.who(req);
    if (!who) return void res.writeHead(407, { 'proxy-authenticate': CHALLENGE, 'content-length': '0' }).end();
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      return void res.writeHead(400).end();
    }
    if (url.protocol !== 'http:') return void res.writeHead(400).end();
    const port = Number(url.port || 80);
    const route = await this.route(who, url.hostname.replace(/^\[|\]$/g, ''), port, false).catch((err: Error) => ({ refused: err.message }));
    if ('refused' in route) return void res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(route.refused);
    let sock: Socket;
    try {
      sock = await connectFirst(route.addresses, port);
    } catch (err) {
      return void res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end((err as Error).message);
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v;
    const up = httpRequest({ method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false, createConnection: () => sock }, (answer) => {
      const back: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(answer.headers)) if (v !== undefined && !HOP.has(k)) back[k] = v;
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, back);
      answer.pipe(res);
    });
    up.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    res.on('close', () => up.destroy());
    req.pipe(up);
  }

  /** A CONNECT tunnel (https, wss, and ws through a proxy): to the address it may go to, or a refusal. */
  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on('error', () => undefined);
    const who = this.who(req);
    if (!who) return void client.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${CHALLENGE}\r\nContent-Length: 0\r\n\r\n`);
    const target = connectTarget(req.url);
    if (!target) return void client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    const route = await this.route(who, target.host, target.port, true).catch((err: Error) => ({ refused: err.message }));
    if ('refused' in route) return void client.end(`HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nX-Refused: ${route.refused.replace(/[\r\n]/g, ' ').slice(0, 300)}\r\n\r\n`);
    let up: Socket;
    try {
      up = await connectFirst(route.addresses, target.port);
    } catch {
      return void client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    }
    if (client.destroyed) return void up.destroy();
    this.sockets.add(up);
    up.on('close', () => (this.sockets.delete(up), client.destroy()));
    up.on('error', () => client.destroy());
    client.on('close', () => up.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  }

  /** A ws:// upgrade sent to the proxy as it is (not through CONNECT): passed on the same way. */
  private async upgrade(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on('error', () => undefined);
    const who = this.who(req);
    if (!who) return void client.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: ${CHALLENGE}\r\nContent-Length: 0\r\n\r\n`);
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      return void client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'ws:') return void client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    const port = Number(url.port || 80);
    const route = await this.route(who, url.hostname.replace(/^\[|\]$/g, ''), port, false).catch((err: Error) => ({ refused: err.message }));
    if ('refused' in route) return void client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    let up: Socket;
    try {
      up = await connectFirst(route.addresses, port);
    } catch {
      return void client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    }
    this.sockets.add(up);
    const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!;
      if (!/^proxy-/i.test(name)) lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.on('close', () => (this.sockets.delete(up), client.destroy()));
    up.on('error', () => client.destroy());
    client.on('close', () => up.destroy());
    up.pipe(client);
    client.pipe(up);
  }
}
