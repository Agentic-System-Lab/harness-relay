import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { duplexPair, type Duplex } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AppPreviews } from '../src/server/appPreviews';
import { previewAddress, previewParent, type PreviewTarget } from '../src/server/previewTarget';
import { readConfig } from '../src/server/config';
import { PUBLISH_CHANGED } from '../src/shared/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-app-preview-')));
writeFileSync(join(root, 'package.json'), '{}');
afterAll(() => rmSync(root, { force: true, recursive: true }));
const target: PreviewTarget = { root, folder: '', entry: 'package.json', mode: 'server' };
const parent = 'http://127.0.0.1:8787';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function address() {
  return previewAddress(new URL(parent), 8787);
}
function view(service: AppPreviews, url: URL, path: string, init: RequestInit = {}) {
  return service.fetch(new Request(new URL(path, url), init), url.host, true);
}

describe('preview lifecycle', () => {
  it('invalidates a replaced session and stops in-flight starts during shutdown', async () => {
    const stop = vi.fn(async () => {});
    const runtime = vi.fn(async () => ({ request: async () => new Response('ok'), stop }));
    const service = new AppPreviews('relay', runtime);
    const signal = new AbortController().signal;
    const first = await service.start('chat', target, address(), parent, signal);
    const second = await service.start('chat', target, address(), parent, signal);
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await view(service, new URL(first.url), '/')).status).toBe(404);
    await service.stop('other', second.id);
    expect(stop).toHaveBeenCalledTimes(1);
    await service.close();
    expect(stop).toHaveBeenCalledTimes(2);
    await expect(service.start('chat', target, address(), parent, signal)).rejects.toMatchObject({ status: 429 });
  });
  it('cancels an unfinished launch, refuses concurrent starts and releases the slot', async () => {
    const begun = deferred<void>();
    const release = deferred<void>();
    const stop = vi.fn(async () => {});
    const runtime = vi.fn(async () => {
      begun.resolve();
      await release.promise;
      return { request: async () => new Response(), stop };
    });
    const service = new AppPreviews('relay', runtime);
    const c = new AbortController();
    const pending = service.start('chat', target, address(), parent, c.signal);
    await begun.promise;
    await expect(service.start('chat', target, address(), parent, c.signal)).rejects.toMatchObject({ status: 409 });
    c.abort();
    release.resolve();
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(stop).toHaveBeenCalledTimes(1);
    await service.close();
  });
  it('revokes immediately but keeps the cleanup handle until Docker confirms removal', async () => {
    const stop = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('engine busy')).mockResolvedValue(undefined);
    const service = new AppPreviews('relay', async () => ({ request: async () => new Response(), stop }));
    const s = await service.start('chat', target, address(), parent, new AbortController().signal);
    await expect(service.stop('chat', s.id)).rejects.toThrow('engine busy');
    const url = new URL(s.url);
    expect((await view(service, url, url.pathname)).status).toBe(404);
    await service.close();
    expect(stop).toHaveBeenCalledTimes(2);
  });
  it('expires idle previews and revokes content when the browser signs out', async () => {
    let now = 0,
      signedIn = true;
    const stop = vi.fn(async () => {});
    const service = new AppPreviews(
      'relay',
      async () => ({ request: async () => new Response(), stop }),
      () => now,
    );
    const url = new URL((await service.start('chat', target, address(), parent, new AbortController().signal, () => signedIn)).url);
    signedIn = false;
    expect((await view(service, url, url.pathname)).status).toBe(404);
    signedIn = true;
    now += 31 * 60_000;
    expect((await view(service, url, url.pathname)).status).toBe(404);
    await service.close();
  });
});

describe('container previews', () => {
  it('answer before the build, give their terminal only to the browser that started them, and count its use as activity', async () => {
    mkdirSync(join(root, 'svc', 'target'), { recursive: true });
    for (const [name, text] of Object.entries({
      'svc/Dockerfile': 'FROM scratch',
      'svc/main.go': 'package main',
      'svc/.env': 'TOKEN=1',
      'svc/target/app': 'bin',
    }))
      writeFileSync(join(root, name), text);
    const terminal = { subscribe: vi.fn(), input: vi.fn(() => true), resize: vi.fn(), run: vi.fn() };
    const stop = vi.fn(async () => {});
    const container = vi.fn((_: { files: ReadonlyMap<string, Buffer>; recipe: string }) => ({
      request: async () => new Response('page'),
      stop,
      terminal,
    }));
    let now = 0;
    const service = new AppPreviews('relay', vi.fn(), () => now, container);
    const target: PreviewTarget = { root, folder: 'svc', entry: 'Dockerfile', mode: 'container' };
    const s = await service.start('chat', target, address(), parent, new AbortController().signal, undefined, undefined, 'browser-1');
    expect(s.terminal).toBe(true);
    const [{ files, recipe }] = container.mock.calls[0]!;
    expect(recipe).toBe('Dockerfile');
    expect([...files.keys()].sort()).toEqual(['Dockerfile', 'main.go']);
    expect(service.terminal('chat', s.id, 'browser-1')).toBe(terminal);
    expect(() => service.terminal('chat', s.id, 'browser-2')).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => service.terminal('chat', s.id, undefined)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => service.terminal('other', s.id, 'browser-1')).toThrow(expect.objectContaining({ status: 404 }));
    // Using the terminal keeps an idle preview alive; its page is served as any other.
    const url = new URL(s.url);
    now += 25 * 60_000;
    service.terminal('chat', s.id, 'browser-1');
    now += 25 * 60_000;
    expect((await view(service, url, url.pathname)).status).toBe(200);
    await service.stop('chat', s.id);
    expect(stop).toHaveBeenCalledOnce();
    expect(() => service.terminal('chat', s.id, 'browser-1')).toThrow(expect.objectContaining({ status: 404 }));
    // An npm or static preview has no terminal.
    const plain = await service.start(
      'chat',
      { root, folder: '', entry: 'package.json', mode: 'server' },
      address(),
      parent,
      new AbortController().signal,
    );
    expect(plain.terminal).toBeUndefined();
    expect(() => service.terminal('chat', plain.id, undefined)).toThrow(expect.objectContaining({ status: 404 }));
    await service.close();
  });
});

describe('a preview still closing', () => {
  it('makes a new start for the same chat wait for it, not refuse', async () => {
    const closing = deferred<void>();
    const stops = [vi.fn(() => closing.promise), vi.fn(async () => {})];
    let made = 0;
    const runtime = vi.fn(async () => ({ request: async () => new Response(), stop: stops[made++]! }));
    const service = new AppPreviews('relay', runtime);
    const first = await service.start('chat', target, address(), parent, new AbortController().signal);
    const stopping = service.stop('chat', first.id);
    const second = service.start('chat', target, address(), parent, new AbortController().signal);
    await Promise.resolve();
    expect(runtime).toHaveBeenCalledTimes(1);
    closing.resolve();
    await stopping;
    expect((await second).id).not.toBe(first.id);
    expect(runtime).toHaveBeenCalledTimes(2);
    await service.close();
  });
});

describe('npm workspaces', () => {
  it('copies the workspace root with its lockfile and runs the selected member', async () => {
    for (const [name, text] of Object.entries({
      'repo/package.json': '{"workspaces":["apps/*"]}',
      'repo/package-lock.json': '{}',
      'repo/apps/web/package.json': '{}',
      'repo/apps/web/main.js': '',
      'repo/apps/api/package.json': '{}',
    })) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    const runtime = vi.fn(async (_: { files: ReadonlyMap<string, Buffer>; workspace?: string }) => ({
      request: async () => new Response(),
      stop: async () => {},
    }));
    const service = new AppPreviews('relay', runtime);
    const member: PreviewTarget = { root, folder: 'repo/apps/web', entry: 'package.json', mode: 'build', npmRoot: 'repo' };
    await service.start('chat', member, address(), parent, new AbortController().signal);
    const [{ files, workspace }] = runtime.mock.calls[0]!;
    expect(workspace).toBe('apps/web');
    expect([...files.keys()].sort()).toEqual([
      'apps/api/package.json',
      'apps/web/main.js',
      'apps/web/package.json',
      'package-lock.json',
      'package.json',
    ]);
    // A standalone project is copied alone and runs without a workspace.
    await service.start(
      'chat',
      { ...member, folder: 'repo/apps/web', npmRoot: undefined },
      address(),
      parent,
      new AbortController().signal,
    );
    expect(runtime.mock.calls[1]![0].workspace).toBeUndefined();
    expect([...runtime.mock.calls[1]![0].files.keys()].sort()).toEqual(['main.js', 'package.json']);
    await service.close();
  });
});

describe('preview request and response boundaries', () => {
  it('forwards only app headers, checks write origins, limits concurrent requests and keeps redirects on the preview', async () => {
    const held = deferred<Response>();
    const request = vi.fn(async (r: Request) => {
      const path = new URL(r.url).pathname;
      if (path === '/wait') return held.promise;
      if (path === '/bad') throw new Error('internal detail');
      if (path === '/away') return Response.redirect('https://outside.example');
      if (path === '/next') return new Response(null, { status: 302, headers: { location: '/local' } });
      return new Response('<!doctype html><p>ok</p>', {
        headers: { 'content-type': 'text/html', 'set-cookie': 'secret=x', 'access-control-allow-origin': '*' },
      });
    });
    const service = new AppPreviews('relay', async () => ({ request, stop: async () => {} }));
    const url = new URL((await service.start('chat', target, address(), parent, new AbortController().signal)).url);
    try {
      expect((await service.fetch(new Request(url), url.hostname + ':1')).status).toBe(404);
      expect((await view(service, url, url.pathname, { method: 'POST' })).status).toBe(403);
      const entry = await view(service, url, url.pathname);
      const cookie = entry.headers.get('set-cookie')!.split(';')[0]!;
      const headers = {
        cookie,
        origin: url.origin,
        authorization: 'private',
        'x-relay-key': 'private',
        'content-type': 'application/json',
      };
      const reload = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' };
      expect((await view(service, url, '/', { headers: { ...reload, cookie } })).status).toBe(200);
      expect((await view(service, url, '/', { headers: reload })).status).toBe(403);
      expect((await view(service, url, '/', { headers: { ...reload, cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
      // The page's own tab (see `tab`): the user's navigation there, with its cookie.
      expect((await view(service, url, '/', { headers: { ...reload, cookie, 'sec-fetch-dest': 'document' } })).status).toBe(200);
      expect((await view(service, url, '/', { headers: { ...reload, 'sec-fetch-dest': 'document' } })).status).toBe(403);
      const form = await view(service, url, '/api/todos', { method: 'POST', headers, body: '{}' });
      expect(form.headers.get('set-cookie')).toBeNull();
      expect(form.headers.get('access-control-allow-origin')).toBeNull();
      expect(await form.text()).toMatch(/^<!doctype html><script>/);
      expect(request.mock.lastCall![0].url).toBe('http://preview.invalid/api/todos');
      expect(Object.fromEntries(request.mock.lastCall![0].headers)).toEqual({ 'content-type': 'application/json' });
      expect(await request.mock.lastCall![0].text()).toBe('{}');
      expect((await view(service, url, '/api', { method: 'POST', headers: { cookie } })).status).toBe(403);
      expect((await view(service, url, '/', { headers: { ...headers, origin: parent } })).status).toBe(403);
      expect((await view(service, url, '/', { method: 'OPTIONS', headers })).status).toBe(405);
      expect((await view(service, url, '/', { method: 'HEAD', headers })).body).toBeNull();
      expect((await view(service, url, '/away', { headers })).status).toBe(403);
      expect((await view(service, url, '/next', { headers })).headers.get('location')).toBe(url.origin + '/local');
      expect((await view(service, url, '/bad', { headers })).status).toBe(502);
      const diagnostic = await view(service, url, '/bad', { headers: { ...headers, accept: 'text/html' } });
      expect(diagnostic.status).toBe(502);
      expect(diagnostic.headers.get('content-type')).toContain('text/html');
      const html = await diagnostic.text();
      expect(html).toContain('relay-preview-error');
      expect(html).not.toContain('internal detail');
      const waiting = Array.from({ length: 12 }, () => view(service, url, '/wait', { headers }));
      expect((await view(service, url, '/wait', { headers })).status).toBe(429);
      held.resolve(new Response(null, { status: 204 }));
      expect((await Promise.all(waiting)).every((r) => r.status === 204)).toBe(true);
    } finally {
      await service.close();
    }
  });
  it('opens the page in a tab of its own: a single-use address for the browser that started it, for a minute', async () => {
    let now = 0;
    const request = async () => new Response('<p>the app</p>', { headers: { 'content-type': 'text/html' } });
    const service = new AppPreviews(
      'relay',
      async () => ({ request, stop: async () => {} }),
      () => now,
    );
    const s = await service.start('chat', target, address(), parent, new AbortController().signal, undefined, undefined, 'browser-1');
    const frame = new URL(s.url);
    expect((await view(service, frame, frame.pathname)).status).toBe(200);
    expect(() => service.tab('chat', s.id, 'browser-2')).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => service.tab('chat', s.id, undefined)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => service.tab('other', s.id, 'browser-1')).toThrow(expect.objectContaining({ status: 404 }));
    const tab = new URL(service.tab('chat', s.id, 'browser-1'));
    expect(tab.origin).toBe(frame.origin);
    expect(tab.pathname).not.toBe(frame.pathname);
    // Opened from Relay's page, as a new tab is: cross-site, once.
    const navigate = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    const opened = await view(service, tab, tab.pathname, { headers: { ...navigate, 'sec-fetch-site': 'cross-site' } });
    expect(opened.status).toBe(200);
    const cookie = opened.headers.get('set-cookie')!.split(';')[0]!;
    expect((await view(service, tab, tab.pathname)).status).toBe(403);
    // The tab's reload and address bar are the user's own: with its cookie, the page; without, nothing.
    expect(await (await view(service, tab, '/', { headers: { ...navigate, 'sec-fetch-site': 'none', cookie } })).text()).toContain(
      'the app',
    );
    expect((await view(service, tab, '/', { headers: { ...navigate, 'sec-fetch-site': 'none' } })).status).toBe(403);
    expect((await view(service, tab, '/', { headers: { ...navigate, 'sec-fetch-site': 'cross-site', cookie } })).status).toBe(403);
    // Good for a minute, and at most eight waiting at once.
    const late = new URL(service.tab('chat', s.id, 'browser-1'));
    now += 61_000;
    expect((await view(service, late, late.pathname)).status).toBe(403);
    for (let i = 0; i < 8; i++) service.tab('chat', s.id, 'browser-1');
    expect(() => service.tab('chat', s.id, 'browser-1')).toThrow(expect.objectContaining({ status: 429 }));
    await service.stop('chat', s.id);
    expect(() => service.tab('chat', s.id, 'browser-1')).toThrow(expect.objectContaining({ status: 404 }));
    await service.close();
  });

  it('lets a browser without loopback cookies use its redeemed local hostname only for same-origin requests', async () => {
    const service = new AppPreviews('relay', async () => ({ request: async () => new Response('ok'), stop: async () => {} }));
    try {
      for (const local of [true, false]) {
        const host = local ? address() : previewAddress(new URL('https://relay.example'), 8787, 'preview.example.net');
        const s = await service.start('chat', target, host, local ? parent : 'https://relay.example', new AbortController().signal);
        expect(host.hostname).not.toContain(s.id);
        const headers = { 'sec-fetch-site': 'same-origin' };
        expect((await view(service, host, '/', { headers })).status).toBe(403);
        await view(service, host, new URL(s.url).pathname);
        expect((await view(service, host, '/', { headers })).status).toBe(local ? 200 : 403);
        expect((await service.fetch(new Request(host, { headers }), host.host, false)).status).toBe(403);
        expect((await view(service, host, '/', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
        expect((await view(service, host, '/', { method: 'POST', headers })).status).toBe(403);
      }
    } finally {
      await service.close();
    }
  });

  it('requires a separate verified HTTPS preview domain for remote clients', () => {
    for (const value of ['*.example.net', 'https://example.net', 'a.localhost', '../preview', 'a..com'])
      expect(readConfig({ RELAY_PREVIEW_DOMAIN: value }).problems).not.toEqual([]);
    expect(readConfig({ RELAY_PREVIEW_DOMAIN: 'Preview.Example.Net' }).config.previewDomain).toBe('preview.example.net');
    expect(() => previewParent('relay.example', 'https://other.example')).toThrow();
    expect(() => previewParent('relay.example', 'null')).toThrow();
    expect(() => previewParent('relay.example', 'https://relay.example/path')).toThrow();
    const p = previewParent('relay.example', 'https://relay.example');
    expect(previewAddress(p, 8787, 'preview.example.net').origin).toMatch(/^https:\/\/p-\w+\.preview\.example\.net$/);
    for (const domain of [undefined, 'relay.example', 'preview.relay.example']) expect(() => previewAddress(p, 8787, domain)).toThrow();
    expect(() => previewAddress(new URL('http://relay.example'), 8787, 'preview.example.net')).toThrow();
  });
});

describe('publishing a running preview', () => {
  it('gives the files it was tried with, once its page answered, to the browser that started it, and refuses them once they changed', async () => {
    const site = join(root, 'site');
    mkdirSync(site, { recursive: true });
    writeFileSync(join(site, 'index.html'), '<h1>v1</h1>');
    const service = new AppPreviews('relay', vi.fn());
    const target: PreviewTarget = { root, folder: 'site', entry: 'index.html', mode: 'static' };
    const s = await service.start('chat', target, address(), parent, new AbortController().signal, undefined, undefined, 'browser-1');
    expect(s.partial).toBeUndefined();
    const source = await service.publishSource('chat', s.id, 'browser-1');
    expect(source).toMatchObject({ conversationId: 'chat', folder: site, mode: 'static', entry: 'index.html' });
    expect([...source.files.keys()]).toEqual(['index.html']);
    await expect(service.publishSource('chat', s.id, 'browser-2')).rejects.toMatchObject({ status: 403 });
    await expect(service.publishSource('other', s.id, 'browser-1')).rejects.toMatchObject({ status: 404 });
    writeFileSync(join(site, 'index.html'), '<h1>v2</h1>');
    await expect(service.publishSource('chat', s.id, 'browser-1')).rejects.toMatchObject({ status: 409, code: PUBLISH_CHANGED });
    await service.stop('chat', s.id);
    await expect(service.publishSource('chat', s.id, 'browser-1')).rejects.toMatchObject({ status: 404 });
  });

  it('opens and publishes a page written at the top of a folder too large to copy whole, with the files it names', async () => {
    // A root of its own: the other tests copy all of `root`.
    const own = realpathSync(mkdtempSync(join(tmpdir(), 'relay-app-preview-top-')));
    const top = join(own, 'chats');
    mkdirSync(join(top, 'many'), { recursive: true });
    for (let i = 0; i < 4097; ++i) writeFileSync(join(top, 'many', `n${i}.txt`), '');
    writeFileSync(join(top, 'slides.html'), '<link rel="stylesheet" href="slides.css"><h1>v1</h1>');
    writeFileSync(join(top, 'slides.css'), 'h1 { color: red }');
    const service = new AppPreviews('relay', vi.fn());
    const target: PreviewTarget = { root: own, folder: 'chats', entry: 'slides.html', mode: 'static' };
    try {
      const s = await service.start('chat', target, address(), parent, new AbortController().signal, undefined, undefined, 'browser-1');
      expect(s.partial).toBe(true); // the panel says only the page's own files came
      const source = await service.publishSource('chat', s.id, 'browser-1');
      expect([...source.files.keys()].sort()).toEqual(['slides.css', 'slides.html']);
      // What the page does not use may change; what it uses may not.
      writeFileSync(join(top, 'many', 'n0.txt'), 'changed');
      await expect(service.publishSource('chat', s.id, 'browser-1')).resolves.toMatchObject({ entry: 'slides.html' });
      writeFileSync(join(top, 'slides.css'), 'h1 { color: blue }');
      await expect(service.publishSource('chat', s.id, 'browser-1')).rejects.toMatchObject({ status: 409, code: PUBLISH_CHANGED });
      await service.stop('chat', s.id);
    } finally {
      rmSync(own, { force: true, recursive: true });
    }
  });

  it("waits for a container's page, and gives a workspace member's folder inside its root", async () => {
    mkdirSync(join(root, 'box'), { recursive: true });
    writeFileSync(join(root, 'box', 'Dockerfile'), 'FROM scratch');
    let listener: ((e: { type: string }) => void) | undefined;
    const terminal = { subscribe: vi.fn((l) => ((listener = l), () => {})), input: vi.fn(), resize: vi.fn(), run: vi.fn() };
    const service = new AppPreviews('relay', vi.fn(), Date.now, () => ({
      request: async () => new Response(),
      stop: async () => {},
      terminal,
    }));
    const s = await service.start(
      'chat',
      { root, folder: 'box', entry: 'Dockerfile', mode: 'container' },
      address(),
      parent,
      new AbortController().signal,
    );
    await expect(service.publishSource('chat', s.id, undefined)).rejects.toMatchObject({ status: 409 });
    listener!({ type: 'phase' });
    await expect(service.publishSource('chat', s.id, undefined)).rejects.toMatchObject({ status: 409 });
    listener!({ type: 'page' });
    expect(await service.publishSource('chat', s.id, undefined)).toMatchObject({
      mode: 'container',
      entry: 'Dockerfile',
      folder: join(root, 'box'),
    });
    await service.close();

    mkdirSync(join(root, 'mono', 'web'), { recursive: true });
    writeFileSync(join(root, 'mono', 'package.json'), '{}');
    const npm = new AppPreviews(
      'relay',
      vi.fn(async () => ({ request: async () => new Response(), stop: async () => {} })),
    );
    const member = await npm.start(
      'chat',
      { root, folder: 'mono/web', entry: 'package.json', mode: 'build', npmRoot: 'mono' },
      address(),
      parent,
      new AbortController().signal,
    );
    expect(await npm.publishSource('chat', member.id, undefined)).toMatchObject({ folder: join(root, 'mono', 'web'), workspace: 'web' });
    await npm.close();
  });
});

describe('WebSockets to the app', () => {
  /** A server that hands its upgrades to the previews, as Relay's does, and a raw client for it. */
  async function relayWith(service: AppPreviews, loopback = true) {
    const server = createHttpServer();
    server.on('upgrade', (request, socket, head) => {
      void service.upgrade(request, socket, head, request.headers.host ?? '', loopback);
    });
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
    );
    const open = (lines: string[]) =>
      new Promise<{ socket: Socket; head: string }>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => socket.write(lines.join('\r\n') + '\r\n\r\n'));
        let text = '';
        const read = (chunk: Buffer) => {
          text += chunk.toString('latin1');
          const end = text.indexOf('\r\n\r\n');
          if (end < 0) return;
          socket.off('data', read);
          resolve({ socket, head: text.slice(0, end) });
        };
        socket.on('data', read);
        socket.on('end', () => resolve({ socket, head: text }));
      });
    return { server, open };
  }

  /** The app at the other end of a tunnel: it keeps the handshake it got, answers it, then echoes. */
  function fakeApp(
    answer = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: accepted\r\nSec-WebSocket-Protocol: streamlit\r\nSet-Cookie: session=app\r\nX-Powered-By: app\r\n\r\n',
  ) {
    const handshakes: string[] = [];
    const ends: Duplex[] = [];
    const tunnel = vi.fn(async () => {
      const [relaySide, appSide] = duplexPair();
      ends.push(relaySide);
      let text = '';
      const read = (chunk: Buffer) => {
        text += chunk.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (end < 0) return;
        appSide.off('data', read);
        handshakes.push(text.slice(0, end));
        appSide.write(answer);
        appSide.pipe(appSide);
      };
      appSide.on('data', read);
      return relaySide;
    });
    return { tunnel, handshakes, ends };
  }

  it('passes a page’s WebSocket to the app with the WebSocket’s headers only, and back with the app’s WebSocket headers only', async () => {
    const app = fakeApp();
    const service = new AppPreviews('relay', async () => ({
      request: async () => new Response('ok'),
      stop: async () => {},
      tunnel: app.tunnel,
    }));
    const url = new URL((await service.start('chat', target, address(), parent, new AbortController().signal)).url);
    const cookie = (await view(service, url, url.pathname)).headers.get('set-cookie')!.split(';')[0]!;
    const { server, open } = await relayWith(service, false);
    try {
      const handshake = (extra: string[]) => [
        'GET /_stcore/stream?x=1 HTTP/1.1',
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: streamlit, token',
        ...extra,
      ];
      const { socket, head } = await open(
        handshake([`Origin: ${url.origin}`, 'Sec-Fetch-Site: same-origin', `Cookie: ${cookie}; other=1`, 'Authorization: secret']),
      );
      expect(head.split('\r\n')).toEqual([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Accept: accepted',
        'Sec-WebSocket-Protocol: streamlit',
      ]);
      // What the app got: Relay's handshake, without the browser's cookie, origin or anything else.
      expect(app.handshakes[0]!.split('\r\n')).toEqual([
        'GET /_stcore/stream?x=1 HTTP/1.1',
        'Host: preview.invalid',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version: 13',
        'sec-websocket-protocol: streamlit, token',
      ]);
      // The frames pass through as they are, both ways.
      const echoed = new Promise<Buffer>((resolve) => socket.once('data', resolve));
      socket.write(Buffer.from([0x81, 0x84, 1, 2, 3, 4, 0x71, 0x6b, 0x6d, 0x63]));
      expect(await echoed).toEqual(Buffer.from([0x81, 0x84, 1, 2, 3, 4, 0x71, 0x6b, 0x6d, 0x63]));
      // Stopping the preview closes its WebSockets.
      const closed = new Promise((resolve) => socket.once('close', resolve));
      await service.stop('chat');
      await closed;
      expect(app.ends[0]!.destroyed).toBe(true);
    } finally {
      server.close();
      await service.close();
    }
  });

  it('refuses a WebSocket another site, another origin or a browser without the cookie opens, and says what the app answered', async () => {
    const app = fakeApp('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    const service = new AppPreviews('relay', async () => ({
      request: async () => new Response('ok'),
      stop: async () => {},
      tunnel: app.tunnel,
    }));
    const url = new URL((await service.start('chat', target, address(), parent, new AbortController().signal)).url);
    const cookie = (await view(service, url, url.pathname)).headers.get('set-cookie')!.split(';')[0]!;
    const { server, open } = await relayWith(service, false);
    const status = async (lines: string[]) => (await open(lines)).head.split('\r\n')[0];
    const base = [
      'GET /ws HTTP/1.1',
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: a2V5',
      'Sec-WebSocket-Version: 13',
    ];
    try {
      expect(await status([...base, `Origin: ${url.origin}`])).toBe('HTTP/1.1 403 Forbidden');
      expect(await status([...base, 'Origin: http://elsewhere.example', `Cookie: ${cookie}`])).toBe('HTTP/1.1 403 Forbidden');
      expect(await status([...base, `Origin: ${url.origin}`, `Cookie: ${cookie}`, 'Sec-Fetch-Site: cross-site'])).toBe(
        'HTTP/1.1 403 Forbidden',
      );
      expect(await status([...base.slice(0, 2), 'Connection: Upgrade', 'Upgrade: h2c', `Origin: ${url.origin}`, `Cookie: ${cookie}`])).toBe(
        'HTTP/1.1 400 Bad Request',
      );
      expect(
        await status([
          ...base.slice(0, 1).map(() => 'GET /ws HTTP/1.1'),
          'Host: p-unknown.localhost:8787',
          ...base.slice(2),
          `Origin: ${url.origin}`,
          `Cookie: ${cookie}`,
        ]),
      ).toBe('HTTP/1.1 404 Not Found');
      expect(app.tunnel).not.toHaveBeenCalled();
      // Let through, the app's own refusal comes back as its status alone.
      expect(await status([...base, `Origin: ${url.origin}`, `Cookie: ${cookie}`])).toBe('HTTP/1.1 403 Forbidden');
      expect(app.tunnel).toHaveBeenCalledOnce();
    } finally {
      server.close();
      await service.close();
    }
  });

  it('lets the browser that redeemed the ticket on this computer in without a cookie (WebKit), and refuses an app that has no WebSockets', async () => {
    const app = fakeApp();
    const service = new AppPreviews('relay', async () => ({
      request: async () => new Response('ok'),
      stop: async () => {},
      tunnel: app.tunnel,
    }));
    const url = new URL((await service.start('chat', target, address(), parent, new AbortController().signal)).url);
    const { server, open } = await relayWith(service, true);
    const base = [
      'GET /ws HTTP/1.1',
      `Host: ${url.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: a2V5',
      'Sec-WebSocket-Version: 13',
      `Origin: ${url.origin}`,
    ];
    try {
      // Before the ticket is spent, nothing gets in without the cookie.
      expect((await open(base)).head.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
      await view(service, url, url.pathname);
      const { socket, head } = await open(base);
      expect(head.split('\r\n')[0]).toBe('HTTP/1.1 101 Switching Protocols');
      socket.destroy();
    } finally {
      server.close();
      await service.close();
    }
    const plain = new AppPreviews('relay', async () => ({ request: async () => new Response('ok'), stop: async () => {} }));
    const other = new URL((await plain.start('chat', target, address(), parent, new AbortController().signal)).url);
    const cookie = (await view(plain, other, other.pathname)).headers.get('set-cookie')!.split(';')[0]!;
    const second = await relayWith(plain, false);
    try {
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: ${other.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Origin: ${other.origin}`,
        `Cookie: ${cookie}`,
      ];
      expect((await second.open(lines)).head.split('\r\n')[0]).toBe('HTTP/1.1 501 Not Implemented');
    } finally {
      second.server.close();
      await plain.close();
    }
  });

  it('names its own WebSocket origin in the page’s content security policy', async () => {
    const service = new AppPreviews('relay', async () => ({
      request: async () => new Response('<p>page</p>', { headers: { 'content-type': 'text/html' } }),
      stop: async () => {},
    }));
    const url = new URL((await service.start('chat', target, address(), parent, new AbortController().signal)).url);
    const entry = await view(service, url, url.pathname);
    expect(entry.headers.get('content-security-policy')).toContain(`connect-src 'self' ws://${url.host};`);
    await service.close();
  });
});
