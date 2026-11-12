import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { AgentsViewSync } from './agentsview';
import { createApp } from './app';
import { AuthStore, CODE_TTL_MS } from './auth';
import { signInLink } from './signin';
import { lockDataDir, openDatabase } from './db';
import { Hub } from './hub';
import { Orchestrator } from './orchestrator';
import { desktopParent } from './parent';
import { Updates } from './updates';
import { relayVersion } from './about';
import { apiPort, isDevRun } from './ports';
import { killAll } from './process';
import { ProviderService } from './providers';
import { Scheduler } from './scheduler';
import { clearShareTmp } from './share';
import { openSystemKeyring } from './secrets';
import { DATA_DIR, DB_FILE, SettingsStore } from './settings';
import { clearRunTmp, dataDirInTemp, relayTmpDir, voiceDirProblem } from './protect';
import { CONFIG_PROBLEMS } from './config';
import { OPEN_PROVIDERS } from '../shared/types';
import { RUN_TMP_DIR, clearOpenRunLeftovers } from './agents/open';
import { clearRelaySandboxLeftovers, noteListeningPort, relaySandboxHostRoot, relaySandboxRoot } from './relaySandbox';
import { Store } from './store';
import { VoiceService } from './voice';
import { serveWebApp, webAppDir } from './web';
import { NativeSetupService } from './native';
import { plannerContext } from './planner';

// A failure in a background task (a run winding down, a stream write) must not take the server — and
// every other conversation — down with it.
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection:', reason));

// A value of the environment that is not valid (a limit, a timeout, an address): refuse to start rather
// than run with another one than the user meant.
const configProblems = [...CONFIG_PROBLEMS, voiceDirProblem()].filter((p): p is string => Boolean(p));
if (configProblems.length) {
  for (const p of configProblems) console.error(`[server] ${p}`);
  process.exit(1);
}

// One server per data folder: before the database is opened, since opening it already marks
// replies left streaming aborted (the Store), and the start sweeps below kill what runs left.
if (!lockDataDir(DATA_DIR)) {
  console.error(
    `[server] Another Harness Relay server is using the data folder ${DATA_DIR}. Stop it first, or give this one a folder of its own with RELAY_DATA_DIR.`,
  );
  process.exit(1);
}

const db = openDatabase(DB_FILE);
const auth = new AuthStore(db);
const settings = new SettingsStore(db, openSystemKeyring());
const store = new Store(db);
const hub = new Hub();
const providers = new ProviderService(settings);
// What each CLI loads by itself: Settings shows it, and the lead agent reads it when it designs a team.
const native = new NativeSetupService(settings);
const voice = new VoiceService(settings);
// Sends each conversation to AgentsView, when its address is set.
const agentsView = new AgentsViewSync(() => settings.agentsViewUrl);
const orchestrator = new Orchestrator(
  store,
  hub,
  settings,
  {
    // What the lead agent may choose from when it designs a team.
    context(cwd, addDirs) {
      return plannerContext(
        {
          statuses: () => providers.statusAll(),
          catalog: () => providers.modelsAll(),
          presets: () => store.listPresets(),
          library: () => settings.tools.view(),
          native: (p, dir, account, dirs) => native.recent(p, dir, account || undefined, dirs),
        },
        cwd,
        undefined,
        addDirs,
      );
    },
    // What an open agent with no model of its own runs on: what its model picker shows as the default.
    async defaultModel(p) {
      return (await providers.models(p)).defaultModel;
    },
  },
  agentsView,
);

// Sends each conversation's scheduled message when it comes due.
const scheduler = new Scheduler(store, orchestrator);

// The desktop app, when it started this server (desktop/); undefined for `npm start` and `npm run dev`.
const parent = desktopParent();

const extraHosts = (process.env.RELAY_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
// What the desktop app says of its updates, for the chat to show (only the version otherwise).
const updates = new Updates(parent, relayVersion);
const app = createApp({ auth, store, settings, hub, orchestrator, providers, voice, agentsView, native, extraHosts, desktopApp: Boolean(parent), updates });

// --- Static web app (production build) ------------------------------------------

const built = serveWebApp(app, webAppDir());
if (!built) {
  app.get('/', (c) => c.text('Web UI is not built. Run `npm run dev` (http://localhost:5173) or `npm run build` first.'));
}

// --- Start -------------------------------------------------------------------------

// What shares left behind when the server stopped during them (none is being made yet).
await clearShareTmp().catch((err: unknown) => console.error('[server] could not clear the temporary share folders:', err));
// There before any agent runs, so that every sandbox is kept out of it from the first turn (protectedReads).
mkdirSync(relayTmpDir(), { recursive: true, mode: 0o700 });
// What turns the server was stopped during left there (a Claude Code turn's settings may hold an
// endpoint's key); none is running yet.
try {
  clearRunTmp();
} catch (err) {
  console.error('[server] could not clear the turns\' temporary folders:', err);
}
// The temporary folders of relay-sandbox runs the server was stopped during (none is running yet).
// Whether nothing of them still runs: only then may permissions be given back to remove what is locked.
let swept = false;
try {
  swept = clearRelaySandboxLeftovers();
} catch (err) {
  console.error('[server] could not clear the relay sandbox folders:', err);
}
// Where open agents' runs keep their temp folders: there before any run, so that every sandboxed run
// is kept from reading other runs' folders in them from the first turn (`privateRoots`).
// What open agents' runs a stopped server was running left: their temp folders, and the state folders of
// runs without a key.
clearOpenRunLeftovers(OPEN_PROVIDERS.flatMap((p) => settings.openAgentHomes(p)), undefined, { restore: swept });
for (const dir of [relaySandboxRoot(), relaySandboxHostRoot(), RUN_TMP_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });

const port = apiPort();
const host = process.env.HOST ?? '127.0.0.1';
const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  // Kept from the open agents' sandbox like the port the settings name, also when PORT=0 let it pick one.
  noteListeningPort(info.port);
  console.log(`Harness Relay API listening on http://${host}:${info.port}`);
  if (dataDirInTemp()) {
    console.warn(`[server] The data folder ${DATA_DIR} is in a temp folder, which agents' sandboxes may write in: set RELAY_DATA_DIR to a folder elsewhere.`);
  }
  if (parent) {
    // The desktop app asks for a link each time it opens the chat (over its port: none goes to the
    // log, which agents could read), so no code is printed.
    parent.onSignInLink(() => signInLink(auth.createCode(CODE_TTL_MS.desktop).code, { host, port: info.port }));
    parent.send({ type: 'listening', host, port: info.port });
  } else {
    // Only this terminal gets the code (nothing keeps it but its hash): a browser opens the link once.
    // With `npm run dev`, the link is Vite's, also when an older build is there.
    const { code } = auth.createCode(CODE_TTL_MS.startup);
    const dev = !built || isDevRun();
    console.log(`Sign this browser in (once, within an hour): ${signInLink(code, { host, port: info.port, dev })}`);
  }
  // Times missed while the server was not running are handled now, by each schedule's choice.
  scheduler.start();
});
// Without a listener, a port already in use would end the process with a stack trace.
server.on('error', (err: NodeJS.ErrnoException) => {
  const hint = err.code === 'EADDRINUSE' ? ' Another program (or another Harness Relay) is using it; start with another PORT.' : '';
  console.error(`[server] could not listen on http://${host}:${port}: ${err.message}.${hint}`);
  parent?.send({ type: 'error', code: err.code ?? 'ERROR', message: err.message });
  void shutdown(1);
});

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 10_000).unref(); // never hang on the way out
  server.close();
  scheduler.stop();
  orchestrator.stopAll();
  providers.shutdown();
  voice.shutdown();
  // Let stopped runs write their final state while the database is still open.
  await orchestrator.settled(5000);
  // And give AgentsView the last turns (each request times out on its own).
  await Promise.race([agentsView.idle(), new Promise((r) => setTimeout(r, 3000))]);
  // SIGTERM, then SIGKILL every agent process group that is still around (including subprocesses).
  await killAll();
  store.flushAll();
  db.close();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
// The desktop app asks over its port: on Windows it has no signal to send.
parent?.onShutdown(() => void shutdown());
// Before it updates, the app waits until no conversation has agents at work.
parent?.onBusy(() => orchestrator.busy());
