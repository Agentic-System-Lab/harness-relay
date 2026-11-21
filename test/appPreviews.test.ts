import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AppPreviews } from '../src/server/appPreviews';
import { previewAddress, previewParent, type PreviewTarget } from '../src/server/previewTarget';
import { readConfig } from '../src/server/config';

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
      expect((await view(service, url, '/', { headers: { ...reload, cookie, 'sec-fetch-dest': 'document' } })).status).toBe(403);
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
