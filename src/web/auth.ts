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

/** Done when every sign-in on its way in this tab is (`whileSigningIn`); none, when there is none. */
let signingIn: Promise<void> | undefined;

/**
 * Runs a sign-in (`api.signIn`): until it is done, and any other on its way, a request answered
 * "signed out" waits for them before deciding what that means (`signedOutAnswer`), since each may put
 * a new key in place.
 */
export function whileSigningIn<T>(signIn: Promise<T>): Promise<T> {
  const settled = signIn.then(
    () => undefined,
    () => undefined,
  );
  const all = signingIn ? Promise.all([signingIn, settled]).then(() => undefined) : settled;
  signingIn = all;
  void all.then(() => {
    if (signingIn === all) signingIn = undefined;
  });
  return signIn;
}

/** What an answer "signed out" means for a request (`signedOutAnswer`). */
export type SignedOutAnswer = 'signed-out' | 'resend' | 'stale';

/**
 * What an answer "signed out" (a 401, which only the sign-in check gives, before a route does
 * anything) means for a request sent with the key `sentWith`, once that answer has been read. The
 * sign-ins on their way in this tab are waited for first (one in another tab is not known here).
 * Then, in one step with the key kept now, so that no sign-in can come in between:
 * - the same key: this tab is signed out ('signed-out'). The key is left where it is: it is the other
 *   tabs' too, and this tab's copy of the storage may not have the newer one another tab just kept
 *   (a sign-in link opened in a new tab). Only signing out on purpose removes it (`clearKey`).
 * - another one, which a sign-in put in its place while the request was on its way (a sign-in link
 *   opened in a tab signed in already ends the session it replaces): the request is to be sent
 *   again with it, once ('resend'; `resent` says it has been);
 * - none any more, or another one after a resend: nothing more ('stale': signed out on purpose,
 *   or left to the newest sign-in).
 */
export async function signedOutAnswer(sentWith: string | null, resent = false): Promise<SignedOutAnswer> {
  while (signingIn) await signingIn;
  const now = readKey();
  if (now === sentWith) return 'signed-out';
  return now !== null && !resent ? 'resend' : 'stale';
}

/**
 * Whether a `storage` event is another tab of this browser keeping a new key: it signed the browser
 * in, and the tabs share the key and the cookie.
 */
export function keyArrived(e: { key: string | null; newValue: string | null }): boolean {
  return e.key === KEY && Boolean(e.newValue);
}
