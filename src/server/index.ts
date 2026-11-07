import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { openDatabase } from './db';
import { Hub } from './hub';
import { Orchestrator } from './orchestrator';
import { killAll } from './process';
import { ProviderService } from './providers';
import { openSystemKeyring } from './secrets';
import { DB_FILE, SettingsStore } from './settings';
import { Store } from './store';

// A failure in a background task (a run winding down, a stream write) must not take the server — and
// every other conversation — down with it.
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection:', reason));

const db = openDatabase(DB_FILE);
const settings = new SettingsStore(db, openSystemKeyring());
const store = new Store(db);
const hub = new Hub();
const providers = new ProviderService(settings);
const orchestrator = new Orchestrator(store, hub, settings, {
  // What the lead agent may choose from when it designs a team.
  async context() {
    const [statuses, catalog] = await Promise.all([providers.statusAll(), providers.modelsAll()]);
    const available = statuses
      .filter((s) => s.installed && (s.auth.loggedIn !== false || s.usingStoredApiKey))
      .map((s) => s.provider);
    return { available, catalog, presets: store.listPresets() };
  },
});

const extraHosts = (process.env.RELAY_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
const app = createApp({ store, settings, hub, orchestrator, providers, extraHosts });

// --- Static web app (production build) ------------------------------------------

const webDir = resolve(process.cwd(), 'dist/web');
if (existsSync(join(webDir, 'index.html'))) {
  app.use('/*', serveStatic({ root: 'dist/web' }));
  app.get('*', serveStatic({ path: 'dist/web/index.html' }));
} else {
  app.get('/', (c) => c.text('Web UI is not built. Run `npm run dev` (http://localhost:5173) or `npm run build` first.'));
}

// --- Start -------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`Harness Relay API listening on http://${host}:${info.port}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 10_000).unref(); // never hang on the way out
  server.close();
  orchestrator.stopAll();
  providers.shutdown();
  // Let stopped runs write their final state while the database is still open.
  await orchestrator.settled(5000);
  // SIGTERM, then SIGKILL every agent process group that is still around (including subprocesses).
  await killAll();
  store.flushAll();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
