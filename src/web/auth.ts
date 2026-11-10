/*
 * The key a signed-in browser sends with each request (see src/server/auth.ts). It is kept in
 * localStorage, which only this origin (scheme, host and port) can read: a page an agent serves on
 * another port of this computer cannot read it, while the cookie is sent there too.
 */

const KEY = 'relay:key';

/** The key when localStorage cannot keep it (a private window that refuses it): until a reload. */
let memory: string | null = null;

export function readKey(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function writeKey(key: string): void {
  memory = key;
  try {
    localStorage.setItem(KEY, key);
  } catch {
    /* storage unavailable: kept in memory */
  }
}

export function clearKey(): void {
  memory = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
