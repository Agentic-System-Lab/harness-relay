/**
 * The desktop app's decisions that don't need Electron, kept apart from main.ts so they can be
 * tested: what opening the app again does, when a stopped server is worth a notification, which
 * address the browser opens, and how the app is started at login.
 */
import type { ServerState } from './supervisor';

/** Passed when the app is started at login (Windows, Linux): it then does not open the browser. */
export const HIDDEN_ARG = '--hidden';

/** Whether this start is one at login (macOS says so itself; elsewhere the login item passes HIDDEN_ARG). */
export function startedAtLogin(argv: readonly string[], platform: NodeJS.Platform, wasOpenedAtLogin: boolean): boolean {
  return argv.includes(HIDDEN_ARG) || (platform === 'darwin' && wasOpenedAtLogin);
}

/** The program and arguments that start the app (unpackaged, Electron needs the app's folder). */
export function launchCommand(o: { execPath: string; appImage?: string; packaged: boolean; appPath: string }): string[] {
  // An AppImage runs from a temporary mount: its own file is in $APPIMAGE.
  const exe = o.appImage || o.execPath;
  return o.packaged ? [exe] : [exe, o.appPath];
}

/**
 * What opening the app again does (the second instance on Windows and Linux, `activate` on macOS,
 * a click on the Dock icon): show the chat's window, start a stopped server (then show it), or
 * nothing while the server starts or stops.
 */
export function reopenAction(state: ServerState['kind']): 'open' | 'start' | 'none' {
  if (state === 'running') return 'open';
  if (state === 'stopped') return 'start';
  return 'none';
}

/**
 * Where a link or a navigation in the chat's window goes: pages of the server stay in the app (its
 * file downloads and attachments too, which need its sign-in), web pages and mail go to the default
 * browser, anything else (`file:`, `javascript:`…) nowhere.
 */
export function linkAction(url: string, serverUrl: string): 'in-app' | 'external' | 'deny' {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return 'deny';
  }
  if (target.origin === new URL(serverUrl).origin) return 'in-app';
  return ['http:', 'https:', 'mailto:'].includes(target.protocol) ? 'external' : 'deny';
}

/**
 * Whether the chat's window may use something the page asks for: only the server's own pages, and
 * only the microphone (voice input, no camera), writing to the clipboard (the copy buttons), full
 * screen (a video's own button) and notifications (Settings → Notifications: agents finished or need you).
 */
export function permissionAllowed(permission: string, requestingUrl: string | undefined, serverUrl: string, mediaTypes: readonly string[] = []): boolean {
  if (!requestingUrl || linkAction(requestingUrl, serverUrl) !== 'in-app') return false;
  if (permission === 'media') return mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
  return permission === 'clipboard-sanitized-write' || permission === 'fullscreen' || permission === 'notifications';
}

/**
 * Electron's permission check (asked without a request, such as before listing the microphones): a
 * check for media that names no kind counts as one for the microphone, the only kind ever allowed.
 */
export function permissionChecked(permission: string, origin: string | undefined, serverUrl: string | undefined, mediaType?: string): boolean {
  return !!serverUrl && permissionAllowed(permission, origin, serverUrl, mediaType ? [mediaType] : ['audio']);
}

/** What a window's page may open: the parts of Electron's WebContents that `guardContents` uses. */
export interface GuardedContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'allow'; overrideBrowserWindowOptions?: object } | { action: 'deny' }): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Keeps a window's pages on the server (`serverUrl()`, undefined while it does not run): a link to
 * another web page or a mail address opens in the default browser, one of the server's own (a file,
 * an attachment) in a window of the app, guarded the same way, and anything else nowhere. Covers new
 * windows, navigations and redirects.
 */
export function guardContents(
  contents: GuardedContents,
  o: { serverUrl: () => string | undefined; openExternal: (url: string) => void; windowOptions: () => object },
): void {
  const target = (url: string) => {
    const server = o.serverUrl();
    return server ? linkAction(url, server) : 'deny';
  };
  contents.setWindowOpenHandler(({ url }) => {
    const action = target(url);
    if (action === 'in-app') return { action: 'allow', overrideBrowserWindowOptions: o.windowOptions() };
    if (action === 'external') o.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', (child: { webContents: GuardedContents }) => guardContents(child.webContents, o));
  const stay = (event: { preventDefault: () => void }, url: string) => {
    const action = target(url);
    if (action === 'in-app') return;
    event.preventDefault();
    if (action === 'external') o.openExternal(url);
  };
  contents.on('will-navigate', stay);
  contents.on('will-redirect', stay);
}

/**
 * Whether a change of the server's state deserves a notification: it stopped by itself after it
 * ran. A server that could not start gets a dialog instead, and a stop the user asked for nothing.
 */
export function crashNotice(before: ServerState, after: ServerState, quitting: boolean): boolean {
  return !quitting && before.kind === 'running' && after.kind === 'stopped' && after.error?.kind === 'exited';
}

/**
 * The address to open the chat at: the sign-in link the server gave, when it is one for this
 * server (the app opens nothing else), else the server's address.
 */
export function chatAddress(serverUrl: string, link: string | undefined): string {
  return link && link.startsWith(`${serverUrl}/#`) ? link : serverUrl;
}

/**
 * The tailnet name the server should answer to: the one Tailscale reports now (also before it has
 * connected, when it already knows it), else the last one seen.
 */
export function tailnetName(reported: string | undefined, remembered: string | undefined): string | undefined {
  return reported || remembered || undefined;
}

/** Whether the running server must restart to answer to `dnsName` (RELAY_ALLOWED_HOSTS is read at start). */
export function needsRestartFor(dnsName: string, allowedHosts: readonly string[] | undefined): boolean {
  return allowedHosts !== undefined && !allowedHosts.includes(dnsName.toLowerCase());
}
