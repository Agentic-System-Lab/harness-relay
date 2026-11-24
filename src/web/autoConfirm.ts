/*
 * How New chat and New automation start: whether the lead agent's team answers right away or waits for
 * the user's confirmation, as the last new chat in this browser did. No DOM here but the storage.
 */

/**
 * Whether the last new chat used the lead agent's teams without asking ("1") or waited for the user's
 * confirmation ("0"), so the next one starts the same way. Without either (a browser's first new chat,
 * or one whose "wait" was stored as nothing before "0" was), it uses them without asking.
 */
export const AUTO_CONFIRM_KEY = 'relay:autoConfirm';

/** The storage it is kept in (the page's `localStorage`; a test's stand-in). */
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // storage unavailable
  }
};

/** Whether the next new chat (or schedule) uses the lead agent's teams without asking: as the last one did, else yes. */
export function lastAutoConfirm(store: Storage | undefined = storage()): boolean {
  try {
    return store?.getItem(AUTO_CONFIRM_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Remember whether this one did, so the next one starts the same way. */
export function rememberAutoConfirm(on: boolean | undefined, store: Storage | undefined = storage()): void {
  try {
    store?.setItem(AUTO_CONFIRM_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}
