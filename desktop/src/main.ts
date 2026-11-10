/**
 * The Harness Relay desktop app: runs the server in the background (an Electron utility process),
 * shows the chat in a window of its own, signed in, and keeps an icon in the menu bar (macOS) or the
 * system tray (Windows, Linux). Closing the window leaves the server running, so a phone reaches it
 * through `tailscale serve` (docs/remote-access.md); the menu also opens the chat in the browser.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences,
  Tray,
  utilityProcess,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { autostartFile, desktopEntry, isAutostartOn, setAutostart } from './autostart';
import { allowedHostsOf, loginShell, loginShellEnv, mergeShellEnv, serverEnv, withCommonPaths } from './env';
import { messages, pickLang } from './i18n';
import {
  chatAddress,
  crashNotice,
  HIDDEN_ARG,
  launchCommand,
  linkAction,
  needsRestartFor,
  permissionAllowed,
  reopenAction,
  startedAtLogin,
  tailnetName,
} from './lifecycle';
import { loadPrefs, savePrefs, type DesktopPrefs } from './prefs';
import { portFree, Supervisor, type ServerChild, type ServerState, type StartError } from './supervisor';
import { findTailscale, freeHttpsPort, Tailscale } from './tailscale';

/** The version the app was built as (desktop/scripts/build.ts): a release's date version, or the package's. */
declare const __RELAY_VERSION__: string;

/** The server's log is started over when it grows past this. */
const LOG_LIMIT = 5 * 1024 * 1024;
/** Matches appId in electron-builder.yml (Windows needs it for notifications). */
const APP_ID = 'io.github.agentic-system-lab.harness-relay';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run(): void {
  const t = messages(pickLang(app.getPreferredSystemLanguages()));
  const userData = app.getPath('userData');
  const prefsFile = join(userData, 'desktop.json');
  const logFile = join(app.getPath('logs'), 'server.log');
  // The server, the built web app and the keyring module, next to the app (see scripts/build.ts).
  const serverDir = app.isPackaged ? join(process.resourcesPath, 'server') : join(app.getAppPath(), '..', 'server');
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
  /** The chat's window, while it is open. */
  let win: BrowserWindow | undefined;
  let awake: number | undefined;
  let log: WriteStream | undefined;
  let quitting = false;

  // Three minutes to start: after an update, macOS may ask for the keychain before the server listens.
  const supervisor = new Supervisor({ fork: forkServer, portFree, startTimeoutMs: 180_000 });
  let previous: ServerState = supervisor.state;
  supervisor.on('output', (chunk) => log?.write(chunk));
  supervisor.on('state', (state) => {
    updateTray();
    if (crashNotice(previous, state, quitting) && Notification.isSupported()) {
      new Notification({ title: t.crashed, body: t.crashedDetail }).show();
    }
    previous = state;
  });

  function forkServer(childEnv: NodeJS.ProcessEnv): ServerChild {
    const child = utilityProcess.fork(join(serverDir, 'server.mjs'), [], {
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
   * The login shell's environment (macOS, Linux), so the CLIs are found as in a terminal. Read at
   * launch, and again before a restart or a start from the menu (`fresh`), to pick up a CLI installed
   * since. Windows apps get the user's PATH from the system at launch.
   */
  function loadEnv(fresh = false): Promise<void> {
    if (fresh) envReady = undefined;
    envReady ??= (async () => {
      if (process.platform === 'win32') return;
      const shellEnv = await loginShellEnv(process.env);
      env = shellEnv ? mergeShellEnv(process.env, shellEnv) : withCommonPaths(process.env, homedir());
      // The CLIs run their commands in $SHELL, which an app is not always given.
      env.SHELL ||= loginShell(process.env);
    })();
    return envReady;
  }

  function openLog(): void {
    mkdirSync(join(logFile, '..'), { recursive: true });
    try {
      if (statSync(logFile).size > LOG_LIMIT) renameSync(logFile, `${logFile}.old`);
    } catch {
      /* no log yet */
    }
    log?.end();
    log = createWriteStream(logFile, { flags: 'a' });
    log.write(`\n--- ${new Date().toISOString()} Harness Relay ${__RELAY_VERSION__} ---\n`);
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
        webDir: join(serverDir, 'web'),
        port: prefs.port,
        home: homedir(),
        allowedHosts: name ? [name] : [],
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

  /**
   * Keeps a window's pages on the server: a link to another web page opens in the default browser,
   * one of the server's own (a file, an attachment) in a window of the app, anything else nowhere.
   */
  function guard(contents: WebContents): void {
    const target = (url: string) => {
      const server = serverUrl();
      return server ? linkAction(url, server) : 'deny';
    };
    contents.setWindowOpenHandler(({ url }) => {
      const action = target(url);
      if (action === 'in-app') return { action: 'allow', overrideBrowserWindowOptions: windowOptions() };
      if (action === 'external') void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('did-create-window', (child) => guard(child.webContents));
    const stay = (event: { preventDefault: () => void }, url: string) => {
      const action = target(url);
      if (action === 'in-app') return;
      event.preventDefault();
      if (action === 'external') void shell.openExternal(url);
    };
    contents.on('will-navigate', stay);
    contents.on('will-redirect', stay);
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

  /** Shows the chat's window (made anew after it was closed), signed in with a new one-time code. */
  async function openWindow(): Promise<void> {
    const state = supervisor.state;
    if (state.kind !== 'running') return;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    const size = prefs.window ?? { width: 1280, height: 860 };
    const opened = new BrowserWindow({ ...windowOptions(), ...size, minWidth: 360, minHeight: 400, show: false });
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
    let url = await net.tailscale.servedUrl(prefs.port);
    if (!url) {
      // Never take over what the computer already shares on an HTTPS port.
      const https = freeHttpsPort((await net.tailscale.serveStatus()) ?? '{}', prefs.port);
      if (https === undefined) {
        await dialog.showMessageBox({ type: 'warning', message: t.tailscaleFailed, detail: t.tailscalePortsTaken, buttons: [t.ok] });
        return;
      }
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

  async function setOpenAtLogin(on: boolean): Promise<void> {
    if (process.platform === 'linux') {
      const entry = desktopEntry({ name: 'Harness Relay', comment: t.open, exec: [...appCommand(), HIDDEN_ARG] });
      setAutostart(autostartFile(process.env, homedir()), on, entry);
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

  function updateTray(): void {
    if (!tray) return;
    const state = supervisor.state;
    const running = state.kind === 'running' && !starting;
    const stopped = state.kind === 'stopped' && !starting;
    tray.setToolTip(`Harness Relay ${__RELAY_VERSION__}`);
    const items: MenuItemConstructorOptions[] = [
      { label: statusLabel(state), enabled: false },
      { label: t.open, enabled: running, click: () => void openWindow() },
      { label: t.openInBrowser, enabled: running, click: () => void openBrowser() },
      { type: 'separator' },
      { label: t.shareWithPhone, enabled: running, click: () => void shareWithPhone() },
      ...(phoneUrl && running ? [{ label: t.copyPhoneAddress(phoneUrl), click: () => clipboard.writeText(phoneUrl!) }] : []),
      { type: 'separator' },
      { label: t.openAtLogin, type: 'checkbox', checked: openAtLogin(), click: (item) => void setOpenAtLogin(item.checked) },
      {
        label: t.keepAwake,
        type: 'checkbox',
        checked: prefs.keepAwake,
        click: (item) => {
          prefs = { ...prefs, keepAwake: item.checked };
          savePrefs(prefsFile, prefs);
          setKeepAwake(item.checked);
        },
      },
      { type: 'separator' },
      {
        label: t.openDataFolder,
        click: () => {
          const dir = started?.RELAY_DATA_DIR ?? join(userData, 'data');
          void shell.openPath(existsSync(dir) ? dir : userData);
        },
      },
      { label: t.showLog, click: () => void shell.openPath(logFile) },
      stopped
        ? { label: t.start, click: () => void startServer({ openWindow: true, freshEnv: true }) }
        : { label: t.restart, enabled: running, click: () => void restartServer(true) },
      { type: 'separator' },
      { label: `${t.version} ${__RELAY_VERSION__}`, enabled: false },
      { label: t.quit, click: () => app.quit() },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(items));
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
    ses.setPermissionCheckHandler((_contents, permission, origin, details) => {
      const server = serverUrl();
      const mediaType = (details as { mediaType?: string }).mediaType;
      return !!server && permissionAllowed(permission, origin, server, mediaType ? [mediaType] : ['audio']);
    });
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
      log?.end();
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
    createTray();
    setKeepAwake(prefs.keepAwake);
    const atLogin = startedAtLogin(process.argv, process.platform, process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
    await startServer({ openWindow: !atLogin });
    launched = true;
  });
}
