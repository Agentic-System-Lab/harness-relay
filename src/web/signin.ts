/**
 * Where the sign-in page tells someone to get a sign-in link (components/SignIn.tsx): the terminal
 * the server was started in, or, for a server the desktop app started, the app's menu. The app's own
 * window signs in again from its menu item that opens it; a browser, from the one that opens the chat
 * in the browser.
 */
export type SignInWhere = 'terminal' | 'desktop-window' | 'desktop-browser';

/** Whether the page is in the desktop app's window: Electron names itself in the user agent. */
export function inDesktopWindow(userAgent: string): boolean {
  return /\bElectron\/\d/.test(userAgent);
}

/** `desktopServer`: GET /api/auth said the desktop app started the server. */
export function signInWhere(o: { desktopServer: boolean; userAgent: string }): SignInWhere {
  if (!o.desktopServer) return 'terminal';
  return inDesktopWindow(o.userAgent) ? 'desktop-window' : 'desktop-browser';
}
