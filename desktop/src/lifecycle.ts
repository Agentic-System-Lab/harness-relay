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
 * only the microphone (voice input, no camera) and writing to the clipboard (the copy buttons).
 */
export function permissionAllowed(permission: string, requestingUrl: string | undefined, serverUrl: string, mediaTypes: readonly string[] = []): boolean {
  if (!requestingUrl || linkAction(requestingUrl, serverUrl) !== 'in-app') return false;
  if (permission === 'media') return mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
  return permission === 'clipboard-sanitized-write';
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
