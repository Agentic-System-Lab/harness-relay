import { createRequire } from 'node:module';
import type { KeyStorage } from '../shared/types';

/** A place to keep secrets (API keys) outside the database. */
export interface SecretStore {
  readonly storage: Exclude<KeyStorage, 'database'>;
  /** The secret, or null when none is stored. Throws when the store cannot be read (e.g. locked). */
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): void;
}

/** The shortest secret whose last characters are shown: in a shorter one they would give away too much. */
const SHOW_END_FROM = 20;

/**
 * A secret as the UI may see it: dots and its last four characters, enough to tell keys apart; only
 * dots for a key shorter than 20 characters (an endpoint's short key, say), whose end is a large part of it.
 */
export function maskSecret(key: string): string {
  if (!key) return '';
  return key.length >= SHOW_END_FROM ? `••••${key.slice(-4)}` : '••••';
}

/** Service name the keys are filed under (what Keychain Access / Credential Manager show). */
export const KEYRING_SERVICE = 'harness-relay';

/**
 * The service name to use: RELAY_KEYRING_SERVICE, else `harness-relay`. The desktop app sets
 * `harness-relay-desktop`, since it keeps a database of its own: keys follow their database.
 */
export function keyringService(env: NodeJS.ProcessEnv = process.env): string {
  return env.RELAY_KEYRING_SERVICE?.trim() || KEYRING_SERVICE;
}

/**
 * The operating system's credential store: macOS Keychain, Windows Credential Manager, or the
 * Secret Service on Linux (GNOME Keyring, KWallet…). Undefined when there is none, e.g. a Linux
 * server without a desktop session, or when RELAY_KEYRING=off.
 */
export function openSystemKeyring(service = keyringService()): SecretStore | undefined {
  if (process.env.RELAY_KEYRING === 'off') return undefined;
  let keyring: typeof import('@napi-rs/keyring');
  try {
    keyring = createRequire(import.meta.url)('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
  } catch (err) {
    console.warn(`[secrets] no system keyring module for this platform: ${(err as Error).message}`);
    return undefined;
  }
  // On Linux the library would fall back to the kernel keyring, which forgets everything on reboot.
  const options = process.platform === 'linux' ? { linux: { store: 'secret-service' as const } } : undefined;
  const entry = (name: string) => new keyring.Entry(service, name, options);
  try {
    entry('availability-check').getPassword(); // a read: no prompt, nothing written
  } catch (err) {
    console.warn(`[secrets] system keyring unavailable, keeping API keys in the database: ${(err as Error).message}`);
    return undefined;
  }
  return {
    storage: process.platform === 'darwin' ? 'keychain' : process.platform === 'win32' ? 'credential-manager' : 'secret-service',
    get: (name) => entry(name).getPassword(),
    set: (name, value) => entry(name).setPassword(value),
    delete: (name) => void entry(name).deleteCredential(),
  };
}
