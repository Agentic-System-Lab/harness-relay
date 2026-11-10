/**
 * Where the chat's window keeps what a browser keeps (cookies, localStorage, caches): a folder of its
 * own in the app's user-data folder, `browser/`, which the server keeps agents below full access from
 * reading (RELAY_APP_BROWSER_DIR, src/server/protect.ts). The window's sign-in, a cookie and a key,
 * is there. The rest of the user-data folder holds the server's data folder, which agents in parallel
 * mode work in, so it cannot be kept from them as a whole.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function browserDir(userData: string): string {
  return join(userData, 'browser');
}

/**
 * What a build before `browser/` kept in the user-data folder itself and that holds a sign-in: it is
 * removed (the window signs in again with a new link anyway).
 */
export const LEGACY_SIGN_IN = ['Cookies', 'Cookies-journal', 'Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage'];

/** Makes the browser folder (the sandboxes take only paths that exist) and removes an old sign-in. */
export function prepareBrowserDir(userData: string): string {
  const dir = browserDir(userData);
  mkdirSync(dir, { recursive: true });
  for (const name of LEGACY_SIGN_IN) rmSync(join(userData, name), { recursive: true, force: true });
  return dir;
}
