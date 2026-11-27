/*
 * A stand-in of Cua's viewer (cua-spacesd: its page, its gRPC-web calls, OpenMedia's media address, its streams),
 * and a browser's requests and streams to Harness Relay's proxy in front of it, for `test/computer-viewer.test.ts`
 * and `test/computer.test.ts`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export const PAGE =
  '<!doctype html>\n<html lang="en">\n  <head>\n    <title>Cua viewer</title>\n    <script type="module" src="./viewer.js"></script>\n  </head>\n</html>\n';

/** A protobuf length-delimited field. */
export function field(tag: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'latin1');
  const len = bytes.length < 128 ? [bytes.length] : [(bytes.length & 0x7f) | 0x80, bytes.length >> 7];
  return Buffer.concat([Buffer.from([tag, ...len]), bytes]);
}

/** OpenMedia's answer as Cua gives it: a gRPC-web frame of its message (the session, then the stream's address, then a varint whose tag is `0`), then its trailers. */
export function openMediaAnswer(session: string, path: string): Buffer {
  const message = Buffer.concat([field(0x0a, session), field(0x22, path), Buffer.from([0x30, 0x01])]);
  const head = Buffer.alloc(5);
  head.writeUInt32BE(message.length, 1);
  const trailer = Buffer.from('grpc-status:0\r\n');
  const tail = Buffer.alloc(5);
  tail[0] = 0x80;
  tail.writeUInt32BE(trailer.length, 1);
  return Buffer.concat([head, message, tail, trailer]);
}

/** A client's (masked) text frame. */
export function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const out = Buffer.alloc(6 + payload.length);
  out[0] = 0x81;
  out[1] = 0x80 | payload.length;
  mask.copy(out, 2);
  for (let i = 0; i < payload.length; i++) out[6 + i] = payload[i]! ^ mask[i % 4]!;
  return out;
}

/** The stand-in of Cua's viewer: records each request and what each stream received. */
export class FakeCua {
  readonly requests: { method: string; url: string; headers: IncomingHttpHeaders }[] = [];
  readonly upgrades: string[] = [];
  readonly received: { path: string; text: string }[] = [];
  readonly streams = new Set<Socket>();
  /** Held before OpenMedia answers. */
  hold?: Promise<void>;
  private media = 0;
  private constructor(private readonly server: Server) {}

  static async start(): Promise<FakeCua> {
    const server = createServer();
    const cua = new FakeCua(server);
    server.on('request', (req: IncomingMessage, res) => {
      cua.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      req.resume();
      req.on('end', async () => {
        const cors = { 'access-control-allow-origin': '*', 'content-security-policy': "default-src 'self'" };
        if (req.url === '/viewer/') return res.writeHead(200, { ...cors, 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
        if (req.url === '/viewer/viewer.js') return res.writeHead(200, { ...cors, 'content-type': 'text/javascript' }).end('export {};');
        if (req.url === '/cua.env.v1.StreamService/OpenMedia') {
          await cua.hold;
          const kind = /cua-(\w+)-/.exec(String(req.headers['x-cua-env-authorization']))?.[1] ?? 'none';
          // A real stream ticket is longer than 127 bytes: its length takes two bytes.
          const path = `/media?ticket=v1.${kind}${'x'.repeat(150)}.${++cua.media}`;
          return res
            .writeHead(200, { ...cors, 'content-type': 'application/grpc-web+proto' })
            .end(openMediaAnswer(`media-${cua.media}`, path));
        }
        res.writeHead(200, { ...cors, 'content-type': 'application/grpc-web+proto' }).end('ok');
      });
    });
    server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
      cua.upgrades.push(req.url ?? '');
      cua.requests.push({ method: 'UPGRADE', url: req.url ?? '', headers: req.headers });
      const accept = createHash('sha1')
        .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: rcdp.v2\r\n\r\n`,
      );
      cua.streams.add(socket);
      socket.on('close', () => cua.streams.delete(socket));
      socket.on('error', () => undefined);
      let buffer = Buffer.alloc(0);
      socket.on('data', (d: Buffer) => {
        buffer = Buffer.concat([buffer, d]);
        while (buffer.length >= 6) {
          const len = buffer[1]! & 0x7f;
          if (buffer.length < 6 + len) break;
          const mask = buffer.subarray(2, 6);
          const text = Buffer.from(buffer.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]!)).toString();
          cua.received.push({ path: req.url ?? '', text });
          buffer = buffer.subarray(6 + len);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return cua;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close(): void {
    for (const s of this.streams) s.destroy();
    this.server.close();
    this.server.closeAllConnections();
  }
}

export interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A request to the proxy as a browser makes it, every header as given (`host` included). */
export function send(origin: string, method: string, path: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Answer> {
  const at = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: at.hostname, port: at.port, method, path, headers: { host: at.host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A stream the page opens: its socket once switched, the close code it got at once (if any), or the HTTP status. */
export interface Opened {
  socket?: Socket;
  closeCode?: number;
  status?: number;
  /** It ended (closed by the proxy). */
  ended: Promise<void>;
}

export function openStream(origin: string, path: string, headers: Record<string, string> = {}): Promise<Opened> {
  const at = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({
      host: at.hostname,
      port: at.port,
      path,
      headers: {
        host: at.host,
        origin,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        'sec-websocket-protocol': 'rcdp.v2',
        cookie: 'relay=secret',
        ...headers,
      },
    });
    req.on('upgrade', (_res, socket: Socket, head: Buffer) => {
      let data = head;
      const ended = new Promise<void>((done) => socket.on('close', () => done()));
      socket.on('error', () => undefined);
      const settle = () => {
        // A close frame at once (the proxy's): its code.
        if (data.length >= 4 && (data[0]! & 0x0f) === 8) resolve({ closeCode: data.readUInt16BE(2), ended });
      };
      socket.on('data', (d: Buffer) => {
        data = Buffer.concat([data, d]);
        settle();
      });
      settle();
      // Cua's own stream sends nothing at first: open.
      setTimeout(() => resolve({ socket, ended }), 100);
    });
    req.on('response', (res) => resolve({ status: res.statusCode ?? 0, ended: Promise.resolve() }));
    req.on('error', (err) => (/hang up|ECONNRESET/.test(err.message) ? resolve({ status: 0, ended: Promise.resolve() }) : reject(err)));
    req.end();
  });
}
