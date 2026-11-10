import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

/**
 * Where the built web app is: RELAY_WEB_DIR when it is set (the desktop app keeps the build next
 * to its copy of the server), else `dist/web` in the folder the server was started from.
 */
export function webAppDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const dir = env.RELAY_WEB_DIR?.trim();
  return dir ? resolve(cwd, dir) : resolve(cwd, 'dist/web');
}

/**
 * Serve the built web app in `dir` (other paths get index.html, for the client's routes). Call it
 * after the API routes. Files in assets/ carry a hash of their content in their name, so a browser
 * keeps them for good, across reloads and app updates; index.html names the current ones, so it is
 * checked every time. Returns false when there is no build in `dir`.
 */
export function serveWebApp(app: Hono, dir: string): boolean {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return false;
  // serveStatic sets no Cache-Control, and headers set in its onFound come too late.
  app.use('/*', async (c, next) => {
    await next();
    if (!c.res.ok) return;
    const asset = c.req.path.startsWith('/assets/');
    c.header('Cache-Control', asset ? 'private, max-age=31536000, immutable' : 'no-cache');
  });
  app.use('/*', serveStatic({ root: dir }));
  // A missing asset is an error, not the page (which would then be kept under the asset's name).
  app.get('/assets/*', (c) => c.notFound());
  app.get('*', serveStatic({ path: index }));
  return true;
}
