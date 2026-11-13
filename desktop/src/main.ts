/**
 * The Harness Relay desktop app: runs the server in the background (an Electron utility process),
 * shows the chat in a window of its own, signed in, and keeps an icon in the menu bar (macOS) or the
 * system tray (Windows, Linux). Closing the window leaves the server running, so a phone reaches it
 * through `tailscale serve` (docs/remote-access.md); the menu also opens the chat in the browser.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  utilityProcess,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { autostartFile, desktopEntry, isAutostartOn, setAutostart } from './autostart';
import { allowedHostsOf, loginShell, loginShellEnv, mergeShellEnv, mergeWindowsEnv, serverEnv, windowsEnv, withCommonPaths } from './env';
import { spawnDetached } from '../../src/server/process';
import { messages, pickLang } from './i18n';
import {
  chatAddress,
  crashNotice,
  HIDDEN_ARG,
  guardContents,
  launchCommand,
  needsRestartFor,
  permissionAllowed,
  permissionChecked,
  reopenAction,
  startedAtLogin,
  tailnetName,
} from './lifecycle';
import { ServerLog } from './log';
import { loadPrefs, savePrefs, type DesktopPrefs } from './prefs';
import { prepareBrowserDir } from './profile';
import { checkServer, checkTurn, printsNoCode, withFakeClis, withoutOwnSettings } from './selftest';
import { portFree, Supervisor, type ServerChild, type ServerState, type StartError } from './supervisor';
import { LiveMenu, menuText, patchMenu, REOPEN_DELAY_MS } from './traymenu';
import {
  appImageDownload,
  appImageTarget,
  busyWithoutAsking,
  chatUpdate,
  CheckAnswers,
  CHECK_EVERY_MS,
  CHECK_TIMEOUT_MS,
  checkNow,
  checkLatest,
  DOWNLOAD_CONNECTIONS,
  downloadUpdate,
  type Fetch,
  FIRST_CHECK_MS,
  installPlan,
  isNewer,
  macAppOf,
  oneAtATime,
  placeAppImage,
  relaunchCommand,
  relaunchEnv,
  removeAppImageLeftovers,
  removeMacLeftovers,
  stageMacApp,
  type StartCommand,
  takesCandidates,
  swapMacApp,
  UpdateError,
  updateSystem,
  whenIdle,
  WINDOWS_INSTALLER_ARGS,
  type Locate,
  type UpdateRelease,
  type Updating,
} from './update';
import { decodeUpdateSource, type BuiltUpdateSource } from './updateSource';
import { findTailscale, sharePlan, Tailscale } from './tailscale';

/** The version the app was built as (desktop/scripts/build.ts): a release's date version, or the package's. */
declare const __RELAY_VERSION__: string;

/**
 * Where the app downloads its updates from, as it was built (desktop/scripts/build.ts, from
 * RELAY_UPDATES_REPO and RELAY_UPDATES_TOKEN: updateSource.ts), the token encoded there so that it never
 * stands in the app as a token's text. The token, if any, goes to GitHub's API alone, and only when the
 * app updates; never into the log or the chat.
 */
declare const __RELAY_UPDATE_SOURCE__: BuiltUpdateSource;
const UPDATE_SOURCE = decodeUpdateSource(__RELAY_UPDATE_SOURCE__);

/** Matches appId in electron-builder.yml (Windows needs it for notifications). */
const APP_ID = 'io.github.agentic-system-lab.harness-relay';

/**
 * `--smoke-test[=<report file>]`: the packaged app checks itself and exits (desktop/scripts/check-package.ts,
 * the Release workflow), with its own temporary data, apart from a Harness Relay that may be running.
 * With `--smoke-test-clis=<folder>`, the fake CLIs there (e2e/support/fake-cli.ts) answer a question too.
 */
const SMOKE_ARG = '--smoke-test';
const SMOKE_CLIS_ARG = '--smoke-test-clis=';
const smokeArg = process.argv.find((a) => a === SMOKE_ARG || a.startsWith(`${SMOKE_ARG}=`));

if (smokeArg !== undefined) {
  const clis = process.argv.find((a) => a.startsWith(SMOKE_CLIS_ARG))?.slice(SMOKE_CLIS_ARG.length);
  smokeTest(smokeArg.includes('=') ? smokeArg.slice(SMOKE_ARG.length + 1) : undefined, clis || undefined);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

/** The server, the built web app and the keyring module, next to the app (see scripts/build.ts). */
function serverDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'server') : join(app.getAppPath(), '..', 'server');
}

/**
 * A fetch for each connection an update downloads on (`download`): each in a session of its own, kept
 * in memory, as Chromium sends one session's requests to a host down one HTTP/2 connection, which goes
 * no faster than one would. Nothing of them is cached.
 */
function updateConnections(): Fetch[] {
  return Array.from({ length: DOWNLOAD_CONNECTIONS }, (_, i) => {
    const s = session.fromPartition(`relay-update-${i}`);
    return (url, init) => s.fetch(url, { ...init, cache: 'no-store' });
  });
}

/**
 * Where a download's address leads (`Locate`), asked without following it: net.fetch follows a
 * redirect and keeps nothing of where it went (its Response's url stays empty).
 */
const locateRedirect: Locate = (url, signal, headers) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const req = net.request({ url, redirect: 'manual', cache: 'no-store' });
    for (const [name, value] of Object.entries(headers ?? {})) req.setHeader(name, value);
    const onAbort = () => {
      req.abort();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const settle = (answer: { status: number; location?: string }) => {
      signal.removeEventListener('abort', onAbort);
      resolve(answer);
      req.abort();
    };
    req.on('redirect', (status, _method, location) => settle({ status, location }));
    req.on('response', (res) => settle({ status: res.statusCode }));
    req.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.end();
  });

/** The server in an Electron utility process, as the supervisor sees it. */
function forkServer(childEnv: NodeJS.ProcessEnv): ServerChild {
  const child = utilityProcess.fork(join(serverDir(), 'server.mjs'), [], {
    env: childEnv,
    cwd: homedir(),
    stdio: 'pipe',
    serviceName: 'Harness Relay server',
  });
  return {
    postMessage: (m) => child.postMessage(m),
    kill: () => void child.kill(),
    onMessage: (fn) => void child.on('message', fn),
    onExit: (fn) => void child.on('exit', fn),
    onOutput(fn) {
      child.stdout?.on('data', (b: Buffer) => fn(b.toString('utf8')));
      child.stderr?.on('data', (b: Buffer) => fn(b.toString('utf8')));
      // A fatal error of the process (out of memory, say): logged; its exit follows. Without a
      // listener, Electron would also show an error dialog of its own.
      child.on('error', (type: string, location: string) => fn(`[app] the server process failed: ${type} (${location})\n`));
    },
  };
}

/**
 * The packaged app's check of itself, in Electron as it ships (its fuses, its archive, the server in
 * a utility process): the keyring module loads, the server starts, serves the web app and signs a
 * browser in with the links it gives the app, a team of the fake CLIs in `clis` (when given) answers
 * a question, a sandboxed window signs in with one, and the server stops when asked. Prints what
 * passed (and writes it to `report`), then exits with 0 or 1.
 */
function smokeTest(report: string | undefined, clis: string | undefined): void {
  const home = mkdtempSync(join(tmpdir(), 'harness-relay-smoke-'));
  app.setPath('userData', home);
  app.setPath('sessionData', join(home, 'browser'));
  const lines: string[] = [];
  let failed = false;
  const check = (ok: unknown, what: string) => {
    lines.push(`${ok ? '✓' : '✗'} ${what}`);
    if (!ok) {
      failed = true;
      throw new Error(what);
    }
  };
  void app.whenReady().then(async () => {
    const supervisor = new Supervisor({ fork: forkServer, portFree, startTimeoutMs: 120_000 });
    let output = '';
    supervisor.on('output', (chunk) => (output += chunk));
    try {
      const keyring = createRequire(join(serverDir(), 'server.mjs'))('@napi-rs/keyring') as { Entry?: unknown };
      check(typeof keyring.Entry === 'function', "loads the keyring module from the server's folder");
      // The developer's own settings (a data folder above all) are not the check's, however it starts.
      const base = withoutOwnSettings(process.env);
      const fakes = clis ? withFakeClis(base, clis, home) : undefined;
      const childEnv = serverEnv({
        base: fakes?.env ?? base,
        dataDir: join(home, 'data'),
        webDir: join(serverDir(), 'web'),
        port: 0,
        home,
        allowedHosts: [],
        browserDir: join(home, 'browser'),
      });
      childEnv.RELAY_KEYRING = 'off'; // never the user's credential store
      const state = await supervisor.start(childEnv, 0);
      check(state.kind === 'running', `starts the server in a utility process (${state.kind})`);
      const url = (state as Extract<ServerState, { kind: 'running' }>).url;
      const auth = await checkServer(url, () => supervisor.signInLink(), check);
      if (fakes) await checkTurn(url, auth, check, { cwd: fakes.cwd });
      else lines.push('- asks no agent a question (no --smoke-test-clis folder)');
      check(printsNoCode(output), 'prints no sign-in code');
      check((await supervisor.busy()) === 0, 'says no conversation has agents at work');

      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await win.loadURL(chatAddress(url, await supervisor.signInLink()));
      let signedIn = false;
      for (let i = 0; i < 150 && !signedIn; i++) {
        signedIn = (await win.webContents.executeJavaScript('!document.querySelector("[data-signin]") && (document.getElementById("root")?.childElementCount ?? 0) > 0')) === true;
        if (!signedIn) await new Promise((r) => setTimeout(r, 100));
      }
      check(signedIn, 'signs a sandboxed window in with a link and shows the chat');
      win.destroy();

      await supervisor.stop();
      check(supervisor.state.kind === 'stopped', 'stops the server when asked');
    } catch (err) {
      if (!failed) lines.push(`✗ ${(err as Error).message}`);
      failed = true;
    }
    // A failed check leaves the server, and the agents of a failed turn, running in `home`.
    if (supervisor.state.kind !== 'stopped') await supervisor.stop().catch(() => undefined);
    if (failed) lines.push('--- server output ---', output.slice(-4000));
    const text = `${lines.join('\n')}\n`;
    process.stdout.write(text);
    if (report) {
      try {
        writeFileSync(report, text);
      } catch {
        /* printed above */
      }
    }
    try {
      // Windows may hold a file a moment after its process ended.
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      /* in the temporary folder */
    }
    app.exit(failed ? 1 : 0);
  });
}

function run(): void {
  const t = messages(pickLang(app.getPreferredSystemLanguages()));
  const userData = app.getPath('userData');
  // The window's cookies and localStorage go in a folder of their own, kept from agents (profile.ts).
  const browser = prepareBrowserDir(userData);
  app.setPath('sessionData', browser);
  const prefsFile = join(userData, 'desktop.json');
  const logFile = join(app.getPath('logs'), 'server.log');
  const iconsDir = join(app.getAppPath(), 'icons');

  let prefs: DesktopPrefs = loadPrefs(prefsFile);
  let env: NodeJS.ProcessEnv = process.env;
  let envReady: Promise<void> | undefined;
  /** The environment the running server got (its data folder, the names it answers to). */
  let started: NodeJS.ProcessEnv | undefined;
  /** A start under way, from reading the shell's environment until the server listens or fails. */
  let starting: Promise<void> | undefined;
  /** Until the first start is over, `activate` (macOS sends one at launch) does nothing. */
  let launched = false;
  let phoneUrl: string | undefined;
  let tray: Tray | undefined;
  /** The tray's menu, and what it shows (traymenu.ts, `menuText`). */
  let trayMenu: Menu | undefined;
  let trayShows = '';
  /** Windows: where the user opened the tray menu, to open it there again. */
  let menuAnchor: Electron.Point | undefined;
  /**
   * An open tray menu shows what changed (an update's progress) by being opened again (macOS,
   * Windows). Linux's menus are set anew as they change, open or not.
   */
  const liveMenu = process.platform === 'linux' ? undefined : new LiveMenu({ reopen: () => reopenTray() });
  /** The chat's window, while it is open. */
  let win: BrowserWindow | undefined;
  let awake: number | undefined;
  let quitting = false;
  /** A newer release than this app, when GitHub has one with an installer for this system. */
  let update: UpdateRelease | undefined;
  /** An update under way: downloading, being checked and put in place, or waiting for the conversations. */
  let updating: Updating | undefined;
  /** GitHub is being asked for its newest release now. */
  let checking = false;
  /** When GitHub was last asked (a check asked for sooner gives what is known), and last answered. */
  let askedAt: number | undefined;
  let checkedAt: number | undefined;
  /** The last question could not reach GitHub (offline, or its hourly limit). */
  let checkFailed = false;
  /** Updating, from asking the user to the switch: asked for again meanwhile (the menu, the chat), it does nothing. */
  const updateOnce = oneAtATime(() => runUpdate());
  /** The chat's checks the app owes an answer to. */
  const checkAnswers = new CheckAnswers();
  /** While an update waits for the conversations: switches at once (the menu's "Switch to the new version now"). */
  let switchNow: (() => void) | undefined;
  /** Where downloaded installers wait (macOS, Windows): emptied at each start. */
  const updatesDir = join(userData, 'updates');

  // Three minutes to start: after an update, macOS may ask for the keychain before the server listens.
  const supervisor = new Supervisor({ fork: forkServer, portFree, startTimeoutMs: 180_000 });
  let previous: ServerState = supervisor.state;
  const log = new ServerLog(logFile);
  supervisor.on('output', (chunk) => log.write(chunk));
  // Asked from the chat (Settings' Version card, the dialog offering a new version).
  supervisor.on('request', (request) => {
    if (request.type === 'update-check') {
      checkAnswers.ask(request.id);
      void checkForUpdate();
    } else void installFromChat();
  });
  supervisor.on('state', (state) => {
    updateTray();
    // A server that just started (or started again) learns what the chat shows of updates.
    if (state.kind === 'running') tellServer();
    if (crashNotice(previous, state, quitting) && Notification.isSupported()) {
      new Notification({ title: t.crashed, body: t.crashedDetail }).show();
    }
    previous = state;
  });

  /**
   * The login shell's environment (macOS, Linux), so the CLIs are found as in a terminal. Read at
   * launch, and again before a restart or a start from the menu (`fresh`), to pick up a CLI installed
   * since. Windows apps get the user's PATH from the system at launch; a fresh start reads Windows'
   * current one.
   */
  function loadEnv(fresh = false): Promise<void> {
    if (fresh) envReady = undefined;
    envReady ??= (async () => {
      if (process.platform === 'win32') {
        const current = fresh ? await windowsEnv(process.env) : undefined;
        env = current ? mergeWindowsEnv(process.env, current) : process.env;
        return;
      }
      const shellEnv = await loginShellEnv(process.env);
      env = shellEnv ? mergeShellEnv(process.env, shellEnv) : withCommonPaths(process.env, homedir());
      // The CLIs run their commands in $SHELL, which an app is not always given.
      env.SHELL ||= loginShell(process.env);
    })();
    return envReady;
  }

  function openLog(): void {
    log.open(`\n--- ${new Date().toISOString()} Harness Relay ${__RELAY_VERSION__} ---\n`);
  }

  /** This computer's tailnet name (also before Tailscale has connected, when it knows it), and whether it runs. */
  async function tailnet(): Promise<{ tailscale?: Tailscale; dnsName?: string; running: boolean }> {
    const bin = findTailscale(env);
    if (!bin) return { running: false };
    const tailscale = new Tailscale(bin, env);
    const status = await tailscale.status();
    return { tailscale, dnsName: status.dnsName, running: status.running };
  }

  /** Starts the server (once at a time), then opens the chat's window if asked; explains a failure. */
  async function startServer(o: { openWindow: boolean; freshEnv?: boolean }): Promise<void> {
    if (starting) return starting;
    const attempt = (async (): Promise<ServerState> => {
      await loadEnv(o.freshEnv);
      const net = await tailnet();
      rememberTailnet(net.dnsName);
      const name = tailnetName(net.dnsName, prefs.tailnetName);
      const childEnv = serverEnv({
        base: env,
        dataDir: join(userData, 'data'),
        webDir: join(serverDir(), 'web'),
        port: prefs.port,
        home: homedir(),
        allowedHosts: name ? [name] : [],
        browserDir: browser,
      });
      openLog();
      const state = await supervisor.start(childEnv, prefs.port);
      if (state.kind !== 'running') return state;
      started = childEnv;
      phoneUrl = net.tailscale && net.running ? await net.tailscale.servedUrl(prefs.port) : undefined;
      return state;
    })();
    // `starting` covers the start itself, not the dialogs after it (whose "Try again" starts anew).
    starting = attempt.then(
      () => undefined,
      () => undefined,
    );
    updateTray();
    let state: ServerState;
    try {
      state = await attempt;
    } catch (err) {
      await dialog.showMessageBox({ type: 'error', message: t.startFailed, detail: String(err), buttons: [t.ok] });
      return;
    } finally {
      starting = undefined;
      updateTray();
    }
    if (state.kind === 'running' && o.openWindow) await openWindow();
    if (state.kind === 'stopped' && state.error) await explainStartFailure(state.error, o);
  }

  /** Keeps this computer's tailnet name, so the server answers to it also when Tailscale connects late. */
  function rememberTailnet(name: string | undefined): void {
    if (!name || name === prefs.tailnetName) return;
    prefs = { ...prefs, tailnetName: name };
    try {
      savePrefs(prefsFile, prefs);
    } catch {
      /* kept for this run */
    }
  }

  async function explainStartFailure(error: StartError, o: { openWindow: boolean }): Promise<void> {
    if (error.kind === 'port-in-use') {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: t.portInUse(error.port),
        detail: t.portInUseDetail,
        buttons: [t.retry, t.quitApp, t.cancel],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) await startServer(o);
      else if (response === 1) app.quit();
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: 'error',
      message: error.kind === 'timeout' ? t.startTimedOut : t.startFailed,
      detail: `${error.kind === 'timeout' ? `${t.startTimedOutDetail}\n\n` : ''}${t.startFailedDetail(error.log.slice(-1500))}`,
      buttons: [t.ok, t.showLog],
      defaultId: 0,
    });
    if (response === 1) void shell.openPath(logFile);
  }

  async function stopServer(): Promise<void> {
    await supervisor.stop();
    started = undefined;
  }

  async function restartServer(confirm: boolean): Promise<void> {
    if (confirm) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: t.restartConfirm,
        detail: t.restartDetail,
        buttons: [t.restartNow, t.cancel],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
    }
    await stopServer();
    await startServer({ openWindow: false, freshEnv: true });
  }

  /** Opens the chat in the default browser, signed in with a new one-time code from the server. */
  async function openBrowser(): Promise<void> {
    const state = supervisor.state;
    if (state.kind !== 'running') return;
    await shell.openExternal(chatAddress(state.url, await supervisor.signInLink()));
  }

  /** The server's address, while it runs (the window's pages must come from it). */
  function serverUrl(): string | undefined {
    const state = supervisor.state;
    return state.kind === 'running' ? state.url : undefined;
  }

  /** Keeps a window's pages on the server (lifecycle.ts, `guardContents`). */
  function guard(contents: WebContents): void {
    guardContents(contents, { serverUrl, openExternal: (url) => void shell.openExternal(url), windowOptions });
  }

  function windowOptions(): Electron.BrowserWindowConstructorOptions {
    return {
      title: 'Harness Relay',
      // The page's own background, so no white flash in dark mode.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#141415' : '#ffffff',
      // On Windows and Linux the menu bar shows with Alt (its Quit is there when a tray icon is hidden).
      autoHideMenuBar: true,
      ...(process.platform === 'darwin' ? {} : { icon: join(iconsDir, 'app.png') }),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
    };
  }

  /**
   * Shows the chat's window (made anew after it was closed), signed in with a new one-time code. A
   * window left open on the sign-in page (its sign-in was revoked, or its link no longer worked) is
   * signed in again the same way.
   */
  async function openWindow(): Promise<void> {
    const state = supervisor.state;
    if (state.kind !== 'running') return;
    if (win && !win.isDestroyed()) {
      const shown = win;
      if (shown.isMinimized()) shown.restore();
      shown.show();
      shown.focus();
      // The sign-in page marks itself (src/web/components/SignIn.tsx).
      const signedOut = await shown.webContents.executeJavaScript('document.querySelector("[data-signin]") !== null').catch(() => false);
      if (signedOut === true && !shown.isDestroyed()) await shown.loadURL(chatAddress(state.url, await supervisor.signInLink()));
      return;
    }
    const size = prefs.window ?? { width: 1280, height: 860 };
    const options = windowOptions();
    const opened = new BrowserWindow({
      ...options,
      ...size,
      minWidth: 360,
      minHeight: 400,
      show: false,
      // The chat tells you when agents finish or need you (it has no push service): its checks keep
      // their pace behind other windows, instead of Chromium's once a minute for a page long hidden.
      webPreferences: { ...options.webPreferences, backgroundThrottling: false },
    });
    win = opened;
    guard(opened.webContents);
    opened.once('ready-to-show', () => opened.show());
    opened.on('close', () => {
      const [width, height] = opened.getSize();
      if (width && height && !opened.isFullScreen() && !opened.isMaximized()) {
        prefs = { ...prefs, window: { width, height } };
        try {
          savePrefs(prefsFile, prefs);
        } catch {
          /* kept for this run */
        }
      }
    });
    opened.on('closed', () => {
      if (win === opened) win = undefined;
      // Back to the menu bar only, once no window of the app is left.
      if (BrowserWindow.getAllWindows().length === 0) app.dock?.hide();
    });
    void app.dock?.show();
    await opened.loadURL(chatAddress(state.url, await supervisor.signInLink()));
  }

  /** Opening the app again: the second instance (Windows, Linux), `activate` (macOS), the Dock icon. */
  async function reopen(): Promise<void> {
    const action = reopenAction(starting ? 'starting' : supervisor.state.kind);
    if (action === 'open') await openWindow();
    else if (action === 'start') await startServer({ openWindow: true, freshEnv: true });
  }

  async function shareWithPhone(): Promise<void> {
    await loadEnv();
    const net = await tailnet();
    if (!net.tailscale) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        message: t.tailscaleMissing,
        detail: t.tailscaleMissingDetail,
        buttons: [t.openDownloadPage, t.ok],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) void shell.openExternal('https://tailscale.com/download');
      return;
    }
    if (!net.running || !net.dnsName) {
      await dialog.showMessageBox({ type: 'info', message: t.tailscaleNotRunning, detail: t.tailscaleNotRunningDetail, buttons: [t.ok] });
      return;
    }
    rememberTailnet(net.dnsName);
    // Never take over what the computer already shares on an HTTPS port (nor when that is unknown).
    const plan = sharePlan(await net.tailscale.serveStatus(), prefs.port);
    if (plan.kind === 'unknown') {
      await dialog.showMessageBox({ type: 'warning', message: t.tailscaleFailed, detail: t.tailscaleStatusUnknown, buttons: [t.ok] });
      return;
    }
    if (plan.kind === 'ports-taken') {
      await dialog.showMessageBox({ type: 'warning', message: t.tailscaleFailed, detail: t.tailscalePortsTaken, buttons: [t.ok] });
      return;
    }
    let url: string;
    if (plan.kind === 'shared') url = plan.url;
    else {
      const https = plan.https;
      const result = await net.tailscale.share(prefs.port, https);
      if (result.kind === 'needs-approval') {
        void shell.openExternal(result.link);
        await dialog.showMessageBox({ type: 'info', message: t.tailscaleApproval, detail: t.tailscaleApprovalDetail, buttons: [t.ok] });
        return;
      }
      if (result.kind === 'access-denied') {
        await dialog.showMessageBox({
          type: 'warning',
          message: t.tailscaleAccessDenied,
          detail: t.tailscaleAccessDeniedDetail(result.output.slice(-800)),
          buttons: [t.ok],
        });
        return;
      }
      if (result.kind === 'failed') {
        await dialog.showMessageBox({ type: 'error', message: t.tailscaleFailed, detail: t.tailscaleFailedDetail(result.output.slice(-800)), buttons: [t.ok] });
        return;
      }
      url = (await net.tailscale.servedUrl(prefs.port)) ?? result.url ?? `https://${net.dnsName}${https === 443 ? '' : `:${https}`}`;
    }
    phoneUrl = url;
    updateTray();
    // The server checks the Host of every request: it has to know this name (RELAY_ALLOWED_HOSTS).
    if (needsRestartFor(net.dnsName, started ? allowedHostsOf(started) : undefined)) {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: t.needsRestart,
        detail: t.needsRestartDetail(url),
        buttons: [t.restartNow, t.later],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) await restartServer(false);
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: t.shared,
      detail: t.sharedDetail(url),
      buttons: [t.copyAddress, t.ok],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) clipboard.writeText(url);
  }

  // --- Updates ------------------------------------------------------------------------------

  /** Whether the app asks GitHub for new releases: a packaged app, unless RELAY_UPDATES=off. */
  function checksUpdates(): boolean {
    return app.isPackaged && (env.RELAY_UPDATES ?? process.env.RELAY_UPDATES)?.trim().toLowerCase() !== 'off';
  }

  /**
   * Asks GitHub for the newest release (a release candidate too); the menu, and the chat, offer it when
   * it is newer. A failure waits for the next time. GitHub is asked at most every five minutes (`mayAskGitHub`):
   * a check asked for sooner from the chat gives what is known.
   */
  async function checkForUpdate(): Promise<void> {
    if (!checkNow({ updates: checksUpdates(), updating: !!updating, checking, askedAt, now: Date.now() })) {
      tellServer();
      return;
    }
    checking = true;
    askedAt = Date.now();
    tellServer();
    try {
      // A release candidate is offered only to an app that is one (or a build of your own): a release, only releases.
      const latest = await checkLatest((url, init) => net.fetch(url, init), {
        source: UPDATE_SOURCE,
        candidates: takesCandidates(app.getVersion()),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      const system = updateSystem(process.platform, process.arch);
      update = isNewer(latest, app.getVersion()) && system && latest.assets[system] ? latest : undefined;
      checkedAt = Date.now();
      checkFailed = false;
    } catch {
      /* offline, or GitHub's limit: the menu stays as it is */
      checkFailed = true;
    } finally {
      checking = false;
    }
    updateTray();
    tellServer();
  }

  /** What the chat shows of updates (Settings' Version card, the dialog offering a new version). */
  function desktopUpdate() {
    return chatUpdate({ updates: checksUpdates(), update, updating, checking, checkedAt, checkFailed });
  }

  /** Tells the server what the chat shows of updates, each time that changes, and which of its checks that answers. */
  function tellServer(): void {
    const answered = checkAnswers.take(checking);
    supervisor.tell({ type: 'update', update: answered ? { ...desktopUpdate(), answered } : desktopUpdate() });
  }

  /** Update, chosen in the chat: asked first, as from the menu, with the chat's window in front for it. */
  async function installFromChat(): Promise<void> {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    await installUpdate();
  }

  function scheduleUpdateChecks(): void {
    setTimeout(() => void checkForUpdate(), FIRST_CHECK_MS).unref?.();
    setInterval(() => void checkForUpdate(), CHECK_EVERY_MS).unref?.();
  }

  /**
   * What an update left behind: downloaded installers, on macOS the old app (`.Harness Relay.app.old`)
   * or a staged one never used, and on Linux a new AppImage never put in place (the app quit while the
   * update waited for the conversations).
   */
  function removeUpdateLeftovers(): void {
    try {
      rmSync(updatesDir, { recursive: true, force: true });
    } catch {
      /* the installer may still be running (Windows): next time */
    }
    const bundle = process.platform === 'darwin' && app.isPackaged ? macAppOf(process.execPath) : undefined;
    if (bundle) {
      try {
        removeMacLeftovers(bundle);
      } catch {
        /* next time */
      }
    }
    const appImage = process.platform === 'linux' && app.isPackaged ? process.env.APPIMAGE : undefined;
    if (appImage) {
      try {
        removeAppImageLeftovers(appImage);
      } catch {
        /* next time */
      }
    }
  }

  function setUpdating(state: Updating | undefined): void {
    updating = state;
    updateTray();
    tellServer();
  }

  /** What the menu says of the update under way. */
  function updatingLabel(u: Updating): string {
    if (u.kind === 'downloading') return t.updateDownloading(Math.floor(u.done * 100));
    return u.kind === 'waiting' ? t.updateWaiting : t.updateInstalling;
  }

  /**
   * How many conversations have agents at work: the server's answer while it runs, none once it
   * stopped by itself, and unknown while it starts or stops, or the app quits (update.ts,
   * `busyWithoutAsking`), or when it does not answer.
   */
  async function busyConversations(): Promise<number | undefined> {
    const known = busyWithoutAsking(supervisor.state.kind, { starting: !!starting, quitting });
    return known === 'ask' ? supervisor.busy() : known;
  }

  /**
   * The new version is ready: waits until no conversation has agents at work (update.ts, `whenIdle`),
   * the menu saying so meanwhile, or until the user chooses to switch at once from the menu. False
   * when the app is quitting meanwhile: then nothing is put in place, and this version stays.
   */
  async function waitForConversations(): Promise<boolean> {
    const now = new Promise<void>((resolve) => (switchNow = resolve));
    try {
      await whenIdle({
        busy: busyConversations,
        now,
        // Once: the menu says the same thing until the wait is over.
        onWaiting: () => updating?.kind !== 'waiting' && setUpdating({ kind: 'waiting' }),
      });
    } finally {
      switchNow = undefined;
    }
    if (quitting) return false;
    setUpdating({ kind: 'installing' });
    return true;
  }

  /** The menu's "Switch to the new version now": asked first, since the conversations replying stop. */
  async function confirmSwitchNow(): Promise<void> {
    if (!switchNow) return;
    const replying = await busyConversations();
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: t.updateSwitchConfirm,
      detail: t.updateSwitchDetail(replying),
      buttons: [t.updateSwitch, t.cancel],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) switchNow?.();
  }

  /** Offers the release's page instead, when this copy cannot update itself (`why`), or the update failed. */
  async function offerReleasePage(release: UpdateRelease, message: string, detail: string): Promise<void> {
    const { response } = await dialog.showMessageBox({ type: 'info', message, detail, buttons: [t.openDownloadPage, t.cancel], defaultId: 0, cancelId: 1 });
    if (response === 0) void shell.openExternal(release.page);
  }

  /**
   * Updates to `update` (update.ts): asks first, downloads and checks the installer, waits until no
   * conversation has agents at work (or the user switches at once), puts the new version in place,
   * then quits and the new one starts. Until the wait is over this version stays as it is, so quitting
   * meanwhile keeps it. Asked for again while it runs (a second click, the menu and the chat), it does
   * nothing (`updateOnce`).
   */
  function installUpdate(): Promise<void> {
    return updateOnce();
  }

  async function runUpdate(): Promise<void> {
    const release = update;
    if (!release || updating) return;
    const system = updateSystem(process.platform, process.arch);
    const asset = system ? release.assets[system] : undefined;
    const plan = installPlan({ platform: process.platform, packaged: app.isPackaged, execPath: process.execPath, appImage: process.env.APPIMAGE, asset });
    if (plan.kind === 'manual' || !asset) {
      await offerReleasePage(release, t.updateManual, t.updateManualDetail(plan.kind === 'manual' ? plan.why : 'no-installer'));
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: 'question',
      message: t.updateConfirm(release.version),
      detail: t.updateConfirmDetail,
      buttons: [t.updateNow, t.releaseNotes, t.cancel],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 1) void shell.openExternal(release.page);
    if (response !== 0) return;

    setUpdating({ kind: 'downloading', done: 0 });
    let shown = -1;
    const onProgress = (done: number) => {
      const percent = Math.floor(done * 100);
      if (percent === shown) return;
      shown = percent;
      setUpdating({ kind: 'downloading', done });
    };
    const fetch: Fetch = (url, init) => net.fetch(url, init);
    // The copy found with the token for a private copies' repository (the installer itself when it cannot be had).
    const fromGitHub = {
      fetch,
      connections: updateConnections(),
      locate: locateRedirect,
      source: UPDATE_SOURCE,
      tag: release.version,
      lookupSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      asset,
      onProgress,
    };
    let installer: string | undefined;
    try {
      if (plan.kind === 'linux') {
        // Downloaded next to the AppImage, so that putting it in place is a rename.
        const target = appImageTarget(plan.appImage, asset.name, __RELAY_VERSION__);
        const downloaded = appImageDownload(plan.appImage, asset.name);
        await downloadUpdate({ ...fromGitHub, to: downloaded });
        setUpdating({ kind: 'installing' });
        if (!(await waitForConversations())) return;
        placeAppImage(downloaded, target, plan.appImage);
        if (process.platform === 'linux' && isAutostartOn(autostartFile(process.env, homedir()))) writeAutostart([target, ...relaunchArgs()]);
        await finishUpdate(relaunchCommand('linux', process.pid, target, relaunchEnv(process.env), relaunchArgs()));
        return;
      }
      mkdirSync(updatesDir, { recursive: true });
      installer = join(updatesDir, asset.name);
      await downloadUpdate({ ...fromGitHub, to: installer });
      setUpdating({ kind: 'installing' });
      if (plan.kind === 'mac') {
        await stageMacApp({ dmg: installer, app: plan.app, bundleId: APP_ID, semver: release.semver, env });
        // Staged and checked: swapped only once the conversations are done (the running app's files
        // stay where they are until then), while the server still runs: a swap that fails leaves
        // everything as it was.
        if (!(await waitForConversations())) return;
        swapMacApp(plan.app);
        await finishUpdate(relaunchCommand('darwin', process.pid, plan.app, process.env));
      } else {
        if (!(await waitForConversations())) return;
        await finishUpdate({ bin: installer, args: WINDOWS_INSTALLER_ARGS, env: process.env });
      }
    } catch (err) {
      setUpdating(undefined);
      const failure = err instanceof UpdateError ? err.failure : 'download';
      // On a Mac, the downloaded .dmg still installs by hand (App Management may keep an app from replacing itself).
      const byHand = plan.kind === 'mac' && failure === 'replace' && installer && existsSync(installer);
      if (byHand) void shell.openPath(installer!);
      await offerReleasePage(
        release,
        t.updateFailed,
        `${t.updateFailedDetail(failure)}${byHand ? `\n\n${t.updateOpenedInstaller}` : ''}\n\n${(err as Error).message}`.trim(),
      );
    }
  }

  /** Stops the server, starts what brings up the new version once this app has exited, and exits. */
  async function finishUpdate({ bin, args, env: childEnv }: StartCommand): Promise<void> {
    quitting = true;
    await stopServer();
    try {
      await spawnDetached(bin, args, childEnv);
    } catch (err) {
      // Nothing started the new version: run on as before (on macOS and Linux it is in place already).
      quitting = false;
      setUpdating(undefined);
      await startServer({ openWindow: false });
      throw new UpdateError('start', (err as Error).message);
    }
    setKeepAwake(false);
    log.close();
    app.exit(0);
  }

  /** The arguments the new version starts with: this one's, but not the one that starts it hidden at login. */
  function relaunchArgs(): string[] {
    return process.argv.slice(1).filter((a) => a === '--no-sandbox');
  }

  // --- Open at login ------------------------------------------------------------------------

  function appCommand(): string[] {
    const command = launchCommand({ execPath: process.execPath, appImage: process.env.APPIMAGE, packaged: app.isPackaged, appPath: app.getAppPath() });
    // An AppImage that only starts without Chromium's sandbox (Ubuntu 24.04) must start so at login too.
    return process.argv.includes('--no-sandbox') ? [...command, '--no-sandbox'] : command;
  }

  function openAtLogin(): boolean {
    if (process.platform === 'linux') return isAutostartOn(autostartFile(process.env, homedir()));
    const [path, ...args] = appCommand();
    const settings =
      process.platform === 'win32' ? app.getLoginItemSettings({ path, args: [...args, HIDDEN_ARG] }) : app.getLoginItemSettings();
    return settings.openAtLogin;
  }

  /** Linux: the autostart entry that starts `command` hidden at login. */
  function writeAutostart(command: string[]): void {
    const entry = desktopEntry({ name: 'Harness Relay', comment: t.open, exec: [...command, HIDDEN_ARG] });
    setAutostart(autostartFile(process.env, homedir()), true, entry);
  }

  /**
   * Linux: an autostart entry that is on is written again at each start, so that it starts the
   * AppImage this app runs from (a new one downloaded by hand has another name).
   */
  function refreshAutostart(): void {
    if (process.platform !== 'linux' || !process.env.APPIMAGE || !isAutostartOn(autostartFile(process.env, homedir()))) return;
    try {
      writeAutostart(appCommand());
    } catch {
      /* left as it is */
    }
  }

  async function setOpenAtLogin(on: boolean): Promise<void> {
    if (process.platform === 'linux') {
      if (on) writeAutostart(appCommand());
      else setAutostart(autostartFile(process.env, homedir()), false, '');
    } else if (process.platform === 'win32') {
      const [path, ...args] = appCommand();
      app.setLoginItemSettings({ openAtLogin: on, path, args: [...args, HIDDEN_ARG] });
    } else {
      app.setLoginItemSettings({ openAtLogin: on });
      if (on && app.getLoginItemSettings().status === 'requires-approval') {
        await dialog.showMessageBox({ type: 'info', message: t.loginItemApproval, detail: t.loginItemApprovalDetail, buttons: [t.ok] });
      }
    }
    updateTray();
  }

  function setKeepAwake(on: boolean): void {
    if (on && awake === undefined) awake = powerSaveBlocker.start('prevent-app-suspension');
    if (!on && awake !== undefined) {
      powerSaveBlocker.stop(awake);
      awake = undefined;
    }
  }

  // --- The menu -----------------------------------------------------------------------------

  function statusLabel(state: ServerState): string {
    if (starting || state.kind === 'starting') return t.starting;
    if (state.kind === 'running') return t.running(state.url);
    if (state.kind === 'stopping') return t.stopping;
    return t.stopped;
  }

  /**
   * The tray menu as it should be now. Always the same items, by id, shown or hidden, so that an open
   * menu can be changed in place (traymenu.ts).
   */
  function trayTemplate(): MenuItemConstructorOptions[] {
    const state = supervisor.state;
    const running = state.kind === 'running' && !starting;
    const stopped = state.kind === 'stopped' && !starting;
    const phone = running ? phoneUrl : undefined;
    return [
      { id: 'status', label: statusLabel(state), enabled: false },
      { id: 'open', label: t.open, enabled: running, click: () => void openWindow() },
      { id: 'browser', label: t.openInBrowser, enabled: running, click: () => void openBrowser() },
      { type: 'separator' },
      { id: 'share', label: t.shareWithPhone, enabled: running, click: () => void shareWithPhone() },
      { id: 'phone', label: t.copyPhoneAddress(phone ?? ''), visible: !!phone, click: () => phoneUrl && clipboard.writeText(phoneUrl) },
      { type: 'separator' },
      { id: 'login', label: t.openAtLogin, type: 'checkbox', checked: openAtLogin(), click: (item) => void setOpenAtLogin(item.checked) },
      {
        id: 'awake',
        label: t.keepAwake,
        type: 'checkbox',
        checked: prefs.keepAwake,
        click: (item) => {
          prefs = { ...prefs, keepAwake: item.checked };
          savePrefs(prefsFile, prefs);
          setKeepAwake(item.checked);
          updateTray();
        },
      },
      { type: 'separator' },
      {
        id: 'data',
        label: t.openDataFolder,
        click: () => {
          const dir = started?.RELAY_DATA_DIR ?? join(userData, 'data');
          void shell.openPath(existsSync(dir) ? dir : userData);
        },
      },
      { id: 'log', label: t.showLog, click: () => void shell.openPath(logFile) },
      { id: 'start', label: t.start, visible: stopped, click: () => void startServer({ openWindow: true, freshEnv: true }) },
      { id: 'restart', label: t.restart, visible: !stopped, enabled: running, click: () => void restartServer(true) },
      { type: 'separator' },
      { id: 'version', label: `${t.version} ${__RELAY_VERSION__}`, enabled: false },
      { id: 'update-status', label: updating ? updatingLabel(updating) : '', enabled: false, visible: !!updating },
      { id: 'update-offer', label: update ? t.updateTo(update.version) : '', visible: !updating && !!update, click: () => void installUpdate() },
      { id: 'update-switch', label: t.updateSwitchNow, visible: updating?.kind === 'waiting', click: () => void confirmSwitchNow() },
      { id: 'quit', label: t.quit, click: () => app.quit() },
    ];
  }

  function updateTray(): void {
    if (!tray) return;
    tray.setToolTip(`Harness Relay ${__RELAY_VERSION__}${updating ? `\n${updatingLabel(updating)}` : ''}`);
    const template = trayTemplate();
    const text = menuText(template);
    // An open menu keeps showing what it showed (macOS, Windows): changed in place, and opened again to show it.
    if (trayMenu && liveMenu?.isOpen && patchMenu((id) => trayMenu!.getMenuItemById(id), template)) {
      trayShows = text;
      liveMenu.changed(text);
      return;
    }
    const menu = Menu.buildFromTemplate(template);
    if (liveMenu) {
      const live = liveMenu;
      menu.on('menu-will-show', () => {
        if (menu !== trayMenu) return;
        // Opened again by LiveMenu on Windows: where the user opened it, not where the pointer is now.
        if (live.opened(trayShows) && process.platform === 'win32') menuAnchor = screen.getCursorScreenPoint();
      });
      menu.on('menu-will-close', () => {
        if (menu === trayMenu) live.closed();
      });
    }
    trayMenu = menu;
    trayShows = text;
    tray.setContextMenu(menu);
  }

  /**
   * Closes the open tray menu and opens it again, as it is now (LiveMenu): a moment later, once the
   * closing menu's loop has ended (traymenu.ts, `REOPEN_DELAY_MS`).
   */
  function reopenTray(): void {
    if (!tray || !trayMenu) return;
    tray.closeContextMenu();
    setTimeout(() => {
      if (!tray || !trayMenu || quitting) return;
      if (process.platform === 'win32' && menuAnchor) tray.popUpContextMenu(trayMenu, menuAnchor);
      else tray.popUpContextMenu();
    }, REOPEN_DELAY_MS);
  }

  function createTray(): void {
    const mac = process.platform === 'darwin';
    const image = nativeImage.createFromPath(join(iconsDir, mac ? 'trayTemplate.png' : 'tray.png'));
    if (mac) image.setTemplateImage(true);
    tray = new Tray(image);
    // On Windows a click opens the chat; the menu is on the right button.
    if (process.platform === 'win32') {
      tray.on('click', () => void (supervisor.state.kind === 'running' && !starting ? openWindow() : tray?.popUpContextMenu()));
    }
    updateTray();
  }

  /**
   * The chat window's menu bar: the app's own items, editing (the shortcuts for copy and paste work in
   * a window on macOS only through it), zoom, and the window. In the user's language.
   */
  function appMenu(): Menu {
    const mac = process.platform === 'darwin';
    const app_: MenuItemConstructorOptions = mac
      ? {
          label: 'Harness Relay',
          submenu: [
            { label: t.mAbout, role: 'about' },
            { type: 'separator' },
            { label: t.openInBrowser, click: () => void openBrowser() },
            { type: 'separator' },
            { label: t.mHide, role: 'hide' },
            { label: t.mHideOthers, role: 'hideOthers' },
            { label: t.mShowAll, role: 'unhide' },
            { type: 'separator' },
            { label: t.quit, accelerator: 'Command+Q', click: () => app.quit() },
          ],
        }
      : {
          label: 'Harness Relay',
          submenu: [
            { label: t.openInBrowser, click: () => void openBrowser() },
            { type: 'separator' },
            { label: t.quit, accelerator: 'Ctrl+Q', click: () => app.quit() },
          ],
        };
    return Menu.buildFromTemplate([
      app_,
      {
        label: t.mEdit,
        submenu: [
          { label: t.mUndo, role: 'undo' },
          { label: t.mRedo, role: 'redo' },
          { type: 'separator' },
          { label: t.mCut, role: 'cut' },
          { label: t.mCopy, role: 'copy' },
          { label: t.mPaste, role: 'paste' },
          { label: t.mSelectAll, role: 'selectAll' },
        ],
      },
      {
        label: t.mView,
        submenu: [
          { label: t.mReload, role: 'reload' },
          { type: 'separator' },
          { label: t.mActualSize, role: 'resetZoom' },
          { label: t.mZoomIn, role: 'zoomIn' },
          { label: t.mZoomOut, role: 'zoomOut' },
          { type: 'separator' },
          { label: t.mFullScreen, role: 'togglefullscreen' },
        ],
      },
      {
        label: t.mWindow,
        submenu: [
          { label: t.mMinimize, role: 'minimize' },
          { label: t.mClose, role: 'close' },
        ],
      },
    ]);
  }

  /** What the window's pages may use: the microphone and the clipboard, for the server's own pages. */
  function permissions(): void {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      const server = serverUrl();
      const url = details.requestingUrl ?? contents.getURL();
      const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
      if (!server || !permissionAllowed(permission, url, server, mediaTypes)) return callback(false);
      // macOS asks the user once whether Harness Relay may use the microphone (Info.plist says why).
      if (permission === 'media' && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
        void systemPreferences.askForMediaAccess('microphone').then(callback, () => callback(false));
        return;
      }
      callback(true);
    });
    ses.setPermissionCheckHandler((_contents, permission, origin, details) =>
      permissionChecked(permission, origin, serverUrl(), (details as { mediaType?: string }).mediaType),
    );
  }

  // --- Life cycle ---------------------------------------------------------------------------

  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  app.setAboutPanelOptions({ applicationName: 'Harness Relay', applicationVersion: __RELAY_VERSION__, version: '' });
  // Closing the chat's window leaves the app (and the server, for the phone) running in the tray.
  app.on('window-all-closed', () => {});

  app.on('second-instance', () => void reopen());
  // On macOS, opening the app again activates the running one (no second instance starts).
  app.on('activate', () => {
    if (launched) void reopen();
  });

  // Stop the server (and with it every agent) before the app goes away. app.exit() does not come back here.
  app.on('before-quit', (event) => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void stopServer().finally(() => {
      setKeepAwake(false);
      log.close();
      app.exit(0);
    });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());

  void app.whenReady().then(async () => {
    app.dock?.hide();
    Menu.setApplicationMenu(appMenu());
    permissions();
    // macOS and Linux: the system shuts down or restarts. Delay it, and quit (stopping the agents).
    // (Windows ends every process of the session itself, agents included.)
    powerMonitor.on('shutdown', (...args: unknown[]) => {
      (args[0] as { preventDefault?: () => void } | undefined)?.preventDefault?.();
      app.quit();
    });
    removeUpdateLeftovers();
    refreshAutostart();
    createTray();
    setKeepAwake(prefs.keepAwake);
    const atLogin = startedAtLogin(process.argv, process.platform, process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
    // Before the start, whose dialogs (a port in use, say) wait for the user.
    scheduleUpdateChecks();
    await startServer({ openWindow: !atLogin });
    launched = true;
  });
}
