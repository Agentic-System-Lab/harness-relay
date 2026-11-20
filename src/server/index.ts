import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { AgentsViewSync } from './agentsview';
import { AlertWatcher } from './alerts';
import { Inbox } from './inbox';
import { createApp } from './app';
import { AuthStore, CODE_TTL_MS } from './auth';
import { signInLink } from './signin';
import { exitAfterRunDatabaseReads, exitOnUncaughtException, lockDataDir, openDatabase, runDatabaseReadsLeft } from './db';
import { Hub } from './hub';
import { Orchestrator } from './orchestrator';
import { findTailscale, Tailscale } from './tailscale';
import { desktopParent } from './parent';
import { Updates } from './updates';
import { relayVersion } from './about';
import { apiPort, DEFAULT_HOST, isDevRun } from './ports';
import { killAll } from './process';
import { ProviderService } from './providers';
import { PushService } from './push';
import { Scheduler } from './scheduler';
import { checkTrigger } from './watch';
import { IdleWatcher } from './idle';
import { ToolGateway, outboxTool } from './gateway';
import { findBrowser } from './browser/find';
import { BrowserService } from './browser/session';
import { browserTools } from './browser/tools';
import { appTools } from './connectors/apps';
import { connectorTools } from './connectors/tools';
import { Outbox } from './outbox';
import { clearShareTmp } from './share';
import { openSecretStore, openSystemKeyring, type SecretStore } from './secrets';
import { DATA_DIR, DB_FILE, SettingsStore } from './settings';
import { agentFolderOptions, clearRunTmp, dataDirInTemp, makeCodespaceGhDir, relayTmpDir, voiceDirProblem } from './protect';
import { CONFIG, CONFIG_PROBLEMS } from './config';
import { OPEN_PROVIDERS, type Lang } from '../shared/types';
import { RUN_TMP_DIR, clearOpenRunLeftovers } from './agents/open';
import { clearCheckTrees } from './checkCommands';
import {
  clearRelaySandboxLeftovers,
  gatewayNode,
  localAddresses,
  noteListeningPort,
  servingPort,
  relayPorts,
  relaySandboxHostRoot,
  relaySandboxRoot,
} from './relaySandbox';
import { Store } from './store';
import { VoiceService } from './voice';
import { CliInstaller } from './cliInstall';
import { SandboxSetup } from './sandboxSetup';
import { GitInstall } from './gitInstall';
import { serveWebApp, webAppDir } from './web';
import { NativeSetupService } from './native';
import { plannerContext } from './planner';

// A failure in a background task (a run winding down, a stream write) must not take the server — and
// every other conversation — down with it.
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection:', reason));
// An uncaught exception ends the process, as Node's own handling does, but without waiting for a
// database read that may never end.
process.on('uncaughtException', (err) => exitOnUncaughtException(err));

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
// The OS credential store, else the database encrypted with the key file: refuse to start without
// that key rather than keep secrets that could not be read back.
let secrets: SecretStore;
try {
  secrets = openSecretStore(db, openSystemKeyring(), { dataDir: DATA_DIR });
} catch (err) {
  console.error(`[server] ${(err as Error).message}`);
  process.exit(1);
}
const settings = new SettingsStore(db, secrets);
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
    context(cwd, addDirs, checkUsage) {
      return plannerContext(
        {
          statuses: () => providers.statusAll(),
          catalog: () => providers.modelsAll(),
          ...(checkUsage
            ? {
                usage: (p, account) => providers.usage(p, account, true),
                backends: () => ({
                  configured: settings.backends.configured(),
                  deletedEndpoints: settings.backends.view().deletedEndpoints ?? [],
                }),
              }
            : {}),
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

// Harness Relay's own tools (browser, mail, calendar), which agents reach through one MCP server of
// Harness Relay's (the gateway), and the outbox of what they asked to send.
const outbox = new Outbox(db);
const gateway = new ToolGateway(DATA_DIR, relayTmpDir(), () => gatewayNode());
const browser = new BrowserService({
  dataDir: DATA_DIR,
  // The browser set in Settings, else RELAY_BROWSER's, else one found on this computer.
  executable: () => findBrowser({ configured: settings.tools.browserPath() ?? CONFIG.browser }),
  // Harness Relay's own ports, and the gateway's HTTP endpoint: never opened by its browser.
  relayPorts: () => [...relayPorts(), ...(gateway.httpPort() ? [gateway.httpPort()!] : [])],
  own: () => localAddresses(),
});
gateway.register([
  outboxTool((id) => outbox.list(id)),
  ...browserTools(browser),
  ...connectorTools(settings.connectors, settings.oauth),
  ...appTools(
    settings.oauth,
    () => settings.tools.obsidianVault(),
    () => agentFolderOptions(settings),
  ),
]);
orchestrator.onDelete = (id) => void browser.close(id, true);
orchestrator.gateway = gateway;
orchestrator.outbox = outbox;
orchestrator.reconcileOutbox();
settings.tools.browserStatus = () => {
  const using = findBrowser({ configured: settings.tools.browserPath() ?? CONFIG.browser });
  return { ...(CONFIG.browser ? { env: CONFIG.browser } : {}), ...(using ? { using } : {}) };
};
// Available while it listens (over HTTP no Node.js is needed); without a Node.js, the CLIs that start its
// program (Claude Code; Cline, OpenHands and Pi in full access) get none, which the reason says.
settings.tools.gatewayStatus = () => {
  if (!gateway.listening()) return { available: false, reason: 'not-started' };
  const why = gateway.unavailable();
  return { available: true, ...(why && why !== 'not-started' ? { reason: why } : {}) };
};

// Sends each conversation's scheduled message when it comes due.
const scheduler = new Scheduler(store, orchestrator, Date.now, checkTrigger(settings.connectors, settings.oauth));
// IMAP IDLE for the automations that wait for new mail: their mail servers say at once when mail arrives,
// and only the trigger on that folder is checked then.
const idle = new IdleWatcher({
  connectors: settings.connectors,
  oauth: settings.oauth,
  watching: () => store.mailWatches(),
  check: (id, key) => scheduler.mailArrived(id, key),
});
scheduler.listening = (id, trigger) => idle.live(id, trigger);

// Push notifications to the browsers that turned them on (a phone, say), when agents finish or need the user.
const push = new PushService(db);
const alerts = new AlertWatcher({
  list: () =>
    store.list(
      (id) => orchestrator.isRunning(id),
      (id) => orchestrator.isWaiting(id),
      (id) => orchestrator.isSorting(id),
    ),
  get: (id) => store.get(id),
  push,
  busy: () => orchestrator.busy() > 0,
});
// The notification inbox (the sidebar's bell): every alert the team gives, kept whether or not a browser is open.
const inbox = new Inbox({
  list: () =>
    store.list(
      (id) => orchestrator.isRunning(id),
      (id) => orchestrator.isWaiting(id),
      (id) => orchestrator.isSorting(id),
    ),
  get: (id) => store.get(id),
  store,
  busy: () => orchestrator.busy() > 0,
});
// A conversation's event (a run starting or ending, a message): the watcher and the inbox read the states again.
hub.subscribeAll(() => {
  alerts.touch();
  inbox.touch();
});

// The desktop app, when it started this server (desktop/); undefined for `npm start` and `npm run dev`.
const parent = desktopParent();
const extraHosts = (process.env.RELAY_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
// What the desktop app says of its updates, for the chat to show (only the version otherwise).
const updates = new Updates(parent, relayVersion);
const clis = new CliInstaller(settings, { changed: (p) => providers.invalidate(p), busy: () => orchestrator.anyRunning() });
// On Windows: the user's PATH put back, as it was before an install this server's last run did not see end.
void clis.recover();
const sandboxSetup = new SandboxSetup({ changed: () => providers.invalidate() });
const gitInstall = new GitInstall(sandboxSetup.linux, {}, clis);
// The language the chat in the desktop app's window shows: the app's menus follow it.
const desktopLang = parent ? (lang: Lang) => parent.send({ type: 'lang', lang }) : undefined;
const app = createApp({
  auth,
  store,
  settings,
  hub,
  orchestrator,
  providers,
  voice,
  clis,
  sandboxSetup,
  gitInstall,
  agentsView,
  native,
  extraHosts,
  desktopApp: Boolean(parent),
  phoneAddress: () => {
    if (!extraHosts.some((name) => name.toLowerCase().endsWith('.ts.net'))) return undefined;
    const bin = findTailscale(process.env);
    if (bin) return new Tailscale(bin, process.env).servedUrl(servingPort());
    return undefined;
  },
  updates,
  desktopLang,
  push,
  alerts,
  scheduler,
});

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
// In a codespace, gh's sign-in folder: there before any turn, so that every sandbox keeps it out.
try {
  makeCodespaceGhDir();
} catch (err) {
  console.error("[server] could not make gh's folder:", err);
}
// What turns the server was stopped during left there (a Claude Code turn's settings may hold an
// endpoint's key); none is running yet.
try {
  clearRunTmp();
} catch (err) {
  console.error("[server] could not clear the turns' temporary folders:", err);
}
// The temporary folders of relay-sandbox runs the server was stopped during (none is running yet).
// Whether nothing of them still runs: only then may permissions be given back to remove what is locked.
let swept = false;
try {
  swept = clearRelaySandboxLeftovers();
} catch (err) {
  console.error('[server] could not clear the relay sandbox folders:', err);
}
// The check trees of a parallel result's checks a stopped server left (none is in use yet).
try {
  clearCheckTrees();
} catch (err) {
  console.error('[server] could not clear the team checks folders:', err);
}
// Where open agents' runs keep their temp folders: there before any run, so that every sandboxed run
// is kept from reading other runs' folders in them from the first turn (`privateRoots`).
// What open agents' runs a stopped server was running left: their temp folders, and the state folders of
// runs without a key.
clearOpenRunLeftovers(
  OPEN_PROVIDERS.flatMap((p) => settings.openAgentHomes(p)),
  undefined,
  { restore: swept },
);
for (const dir of [relaySandboxRoot(), relaySandboxHostRoot(), RUN_TMP_DIR]) mkdirSync(dir, { recursive: true, mode: 0o700 });
// The gateway's socket: agents get Harness Relay's own tools only once it listens.
await gateway.start().catch((err: unknown) => console.error("[server] could not start the gateway for Harness Relay's own tools:", err));

const port = apiPort();
const host = process.env.HOST ?? DEFAULT_HOST;
const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  // Kept from the open agents' sandbox like the port the settings name, also when PORT=0 let it pick one.
  noteListeningPort(info.port);
  console.log(`Harness Relay API listening on http://${host}:${info.port}`);
  if (dataDirInTemp()) {
    console.warn(
      `[server] The data folder ${DATA_DIR} is in a temp folder, which agents' sandboxes may write in: set RELAY_DATA_DIR to a folder elsewhere.`,
    );
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
  idle.start();
  alerts.start();
  inbox.start();
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
  // Never hang on the way out (Node would wait for a stuck database read: `exitAfterRunDatabaseReads`).
  setTimeout(() => {
    if (runDatabaseReadsLeft()) process.kill(process.pid, 'SIGKILL');
    process.exit(1);
  }, 10_000).unref();
  server.close();
  scheduler.stop();
  void idle.stop();
  alerts.stop();
  inbox.stop();
  orchestrator.stopAll();
  void gateway.stop();
  browser.closeAll();
  providers.shutdown();
  voice.shutdown();
  // Installs under way stop; each cleans up after itself (on Windows, the user's PATH put back).
  const installsStopped = Promise.all([clis.shutdown(), sandboxSetup.shutdown(), gitInstall.shutdown()]);
  // Let stopped runs write their final state while the database is still open.
  await Promise.all([orchestrator.settled(5000), Promise.race([installsStopped, new Promise((r) => setTimeout(r, 5000))])]);
  // And give AgentsView the last turns (each request times out on its own).
  await Promise.race([agentsView.idle(), new Promise((r) => setTimeout(r, 3000))]);
  // SIGTERM, then SIGKILL every agent process group that is still around (including subprocesses).
  await killAll();
  store.flushAll();
  db.close();
  await exitAfterRunDatabaseReads(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
// The desktop app asks over its port: on Windows it has no signal to send.
parent?.onShutdown(() => void shutdown());
// Before it updates, the app waits until no conversation has agents at work, and no CLI (nor what the sandboxes need) is being installed.
parent?.onBusy(() => orchestrator.busy() + clis.running() + sandboxSetup.running() + gitInstall.running());
