import { createServer as createHttpServer, request, type Server } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserProxy, PROXY_USER, connectTarget, type ProxyRoute } from '../src/server/browser/proxy';

/*
 * The browser's own proxy (`src/server/browser/proxy.ts`) on its own, with Node's HTTP client in
 * Chromium's place: who may use it, and that it connects only to the addresses its route gives.
 */

describe("the browser's own proxy", () => {
  let site: Server;
  let sitePort = 0;
  const seen: { url?: string; host?: string; auth?: string }[] = [];
  let echo: ReturnType<typeof createServer>;
  let echoPort = 0;
  const routes: [string, number, boolean][] = [];
  let decide: (host: string) => ProxyRoute = () => ({ addresses: ['127.0.0.1'] });
  const proxy = new BrowserProxy(async (_password, host, port, secure) => {
    routes.push([host, port, secure]);
    return decide(host);
  });
  let password = '';

  beforeAll(async () => {
    site = createHttpServer((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] as string | undefined });
      res.setHeader('x-site', 'yes');
      res.end(`hello ${req.url}`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    sitePort = (site.address() as { port: number }).port;
    echo = createServer((sock) => sock.pipe(sock));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    echoPort = (echo.address() as { port: number }).port;
    await proxy.start();
    password = proxy.issue();
  });
  afterAll(async () => {
    proxy.stop();
    await new Promise((r) => site.close(r));
    await new Promise((r) => echo.close(r));
  });

  const basic = (pw: string) => `Basic ${Buffer.from(`${PROXY_USER}:${pw}`).toString('base64')}`;

  /** A GET through the proxy, as a browser sends one. */
  function get(url: string, auth?: string): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: proxy.port, path: url, headers: { host: new URL(url).host, ...(auth ? { 'proxy-authorization': auth } : {}) } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** A CONNECT through the proxy: its answer's first line, and the socket when it was let through. */
  function tunnel(target: string, auth?: string): Promise<{ line: string; sock: Socket }> {
    return new Promise((resolve, reject) => {
      const sock = connect(proxy.port, '127.0.0.1', () => sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`));
      let got = '';
      sock.on('data', function first(chunk: Buffer) {
        got += chunk.toString('latin1');
        const end = got.indexOf('\r\n\r\n');
        if (end < 0) return;
        sock.off('data', first);
        resolve({ line: got.split('\r\n')[0]!, sock });
      });
      sock.on('error', reject);
    });
  }

  it('reads a CONNECT target, also an IPv6 one, and nothing else', () => {
    expect(connectTarget('example.com:443')).toEqual({ host: 'example.com', port: 443 });
    expect(connectTarget('[::1]:8080')).toEqual({ host: '::1', port: 8080 });
    for (const bad of ['example.com', 'example.com:0', 'example.com:70000', 'a:b:1', '', undefined]) expect(connectTarget(bad)).toBeUndefined();
  });

  it("serves only a browser with a password it issued, and asks the others who they are", async () => {
    expect((await get(`http://127.0.0.1:${sitePort}/`)).status).toBe(407);
    expect((await get(`http://127.0.0.1:${sitePort}/`, basic('wrong'))).status).toBe(407);
    expect((await get(`http://127.0.0.1:${sitePort}/`, `Basic ${Buffer.from(`other:${password}`).toString('base64')}`)).status).toBe(407);
    expect((await tunnel(`127.0.0.1:${echoPort}`)).line).toBe('HTTP/1.1 407 Proxy Authentication Required');
    expect(seen).toEqual([]);
    // A password forgotten (its browser closed) is no longer one.
    const old = proxy.issue();
    proxy.forget(old);
    expect((await get(`http://127.0.0.1:${sitePort}/`, basic(old))).status).toBe(407);
  });

  it('passes a request on to the address its route gives, never the name, without its proxy headers', async () => {
    routes.length = 0;
    decide = (host) => (host === 'anything.test' ? { addresses: ['127.0.0.1'] } : { refused: 'no' });
    const r = await get(`http://anything.test:${sitePort}/page?q=1`, basic(password));
    expect(r).toMatchObject({ status: 200, body: 'hello /page?q=1' });
    expect(r.headers['x-site']).toBe('yes');
    expect(routes).toEqual([['anything.test', sitePort, false]]);
    expect(seen.at(-1)).toEqual({ url: '/page?q=1', host: `anything.test:${sitePort}`, auth: undefined });
    // Refused by its route: a 403, and nothing reaches the site.
    const before = seen.length;
    expect((await get(`http://elsewhere.test:${sitePort}/`, basic(password))).status).toBe(403);
    expect(seen).toHaveLength(before);
    // An address that answers nothing: a 502.
    decide = () => ({ addresses: ['127.0.0.1'] });
    expect((await get('http://127.0.0.1:1/', basic(password))).status).toBe(502);
  });

  it('opens a tunnel only where its route lets it, to the address given', async () => {
    routes.length = 0;
    decide = (host) => (host === 'tunnel.test' ? { addresses: ['127.0.0.1'] } : { refused: 'never there' });
    const ok = await tunnel(`tunnel.test:${echoPort}`, basic(password));
    expect(ok.line).toBe('HTTP/1.1 200 Connection Established');
    const back = new Promise<string>((r) => ok.sock.once('data', (d: Buffer) => r(d.toString())));
    ok.sock.write('ping');
    expect(await back).toBe('ping');
    ok.sock.destroy();
    expect(routes).toEqual([['tunnel.test', echoPort, true]]);
    const refused = await tunnel(`blocked.test:${echoPort}`, basic(password));
    expect(refused.line).toBe('HTTP/1.1 403 Forbidden');
    refused.sock.destroy();
  });
});
