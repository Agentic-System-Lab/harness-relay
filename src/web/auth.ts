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

/**
 * Sends a request with this browser's key: `init` makes the request for a key. One refused as signed
 * out (a 401, which only the sign-in check gives, before a route does anything) after a sign-in
 * replaced the key on its way is sent once more, with the new key: a sign-in link opened in a tab
 * signed in already ends the session it replaces, and a request still on its way with that session's
 * key must not sign the tab out again. `send` is `fetch`, or a stand-in in tests.
 */
export async function sendWithKey(
  url: string,
  init: (key: string | null) => RequestInit,
  send: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
  const key = readKey();
  const res = await send(url, init(key));
  const now = readKey();
  return res.status === 401 && now !== key ? send(url, init(now)) : res;
}
