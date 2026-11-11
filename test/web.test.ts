import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { serveWebApp, webAppDir } from '../src/server/web';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-web-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function built(): string {
  const dir = mkdtempSync(join(root, 'dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Relay</title>');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  return dir;
}

describe('the built web app', () => {
  it('lets a browser keep hashed assets for good', async () => {
    const app = new Hono();
    serveWebApp(app, built());
    const res = await app.request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(await res.text()).toBe('console.log(1)');
  });

  it('has index.html checked every time, also for the client routes', async () => {
    const app = new Hono();
    serveWebApp(app, built());
    for (const path of ['/', '/c/123']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await res.text()).toContain('<title>Relay</title>');
    }
  });

  it('serves the web app manifest as a manifest, checked every time', async () => {
    const app = new Hono();
    const dir = built();
    writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Harness Relay"}');
    serveWebApp(app, dir);
    const res = await app.request('/manifest.webmanifest');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/manifest\+json/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('answers a missing asset with 404, not the page', async () => {
    const app = new Hono();
    serveWebApp(app, built());
    const res = await app.request('/assets/index-old999.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBeNull();
  });

  it('leaves routes registered before it alone', async () => {
    const app = new Hono();
    app.get('/api/ping', (c) => c.json({ ok: true }));
    serveWebApp(app, built());
    const res = await app.request('/api/ping');
    expect(res.headers.get('cache-control')).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it('serves nothing without a build', () => {
    const app = new Hono();
    expect(serveWebApp(app, join(root, 'missing'))).toBe(false);
  });
});

describe('where the built web app is', () => {
  it('is dist/web in the folder the server started from, unless RELAY_WEB_DIR says otherwise', () => {
    // `resolve`: on Windows `/repo` is on the current drive (C:\repo).
    expect(webAppDir({}, '/repo')).toBe(resolve('/repo', 'dist', 'web'));
    expect(webAppDir({ RELAY_WEB_DIR: ' ' }, '/repo')).toBe(resolve('/repo', 'dist', 'web'));
    expect(webAppDir({ RELAY_WEB_DIR: '/app/server/web' }, '/repo')).toBe(resolve('/app', 'server', 'web'));
    expect(webAppDir({ RELAY_WEB_DIR: 'build/web' }, '/repo')).toBe(resolve('/repo', 'build', 'web'));
  });
});
