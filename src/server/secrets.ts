import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { KeyStorage } from '../shared/types';
import { withholdFile, type Database } from './db';

/**
 * A place to keep secrets (API keys, MCP servers' values): the OS credential store, or, without one,
 * the database encrypted (`openEncryptedStore`). Never the database as they are.
 */
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
    console.warn(`[secrets] system keyring unavailable, keeping API keys encrypted in the database: ${(err as Error).message}`);
    return undefined;
  }
  return {
    storage: process.platform === 'darwin' ? 'keychain' : process.platform === 'win32' ? 'credential-manager' : 'secret-service',
    get: (name) => entry(name).getPassword(),
    set: (name, value) => entry(name).setPassword(value),
    delete: (name) => void entry(name).deleteCredential(),
  };
}

/*
 * Without a credential store, secrets are kept in the database (`secrets`, schema version 28)
 * encrypted with AES-256-GCM, under a key of 32 random bytes in a file of its own: `secrets.key` in
 * the data folder, made owner-only at the first start that needs it, or the file
 * RELAY_SECRETS_KEY_FILE names (one outside the data folder, such as a systemd credential). A copy of
 * the database without the key file (a backup, the file sent somewhere) gives none of them away; a
 * program that can read every file of the user's can read the key too, as it could a credential
 * store's unlocked secrets. Agents below full access can read neither (`relayDatabaseFiles` in
 * protect.ts), and the Files panel and downloads never open the key file (`withholdFile`).
 */

/** The key file's name in the data folder, when RELAY_SECRETS_KEY_FILE names no other. */
export const SECRETS_KEY_NAME = 'secrets.key';

/** The file with the key the secrets kept in the database are encrypted with. */
export function secretsKeyFile(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const named = env.RELAY_SECRETS_KEY_FILE?.trim();
  return named ? resolve(named) : join(dataDir, SECRETS_KEY_NAME);
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** How an encrypted secret begins: the format's version, for a later one to tell them apart. */
const SEALED_PREFIX = 'v1:';

/** The key a key file holds: 32 bytes, in base64 (as `openssl rand -base64 32` writes them) or in hex. */
export function parseSecretsKey(text: string): Buffer | undefined {
  const s = text.trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(s)) return Buffer.from(s, 'base64');
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  return undefined;
}

/**
 * The key in `file`; with `create`, a file that is not there is made with a new key (32 random
 * bytes in base64, owner-only), written whole before it takes the file's name, so that a start cut
 * short never leaves half a key. Throws when the file cannot be read or holds no key.
 */
export function loadSecretsKey(file: string, o: { create: boolean }): Buffer {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || !o.create) {
      throw new Error(`cannot read the secrets key file ${file}: ${(err as Error).message}`);
    }
    const key = randomBytes(KEY_BYTES);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${key.toString('base64')}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    return key;
  }
  const key = parseSecretsKey(text);
  if (!key) throw new Error(`the secrets key file ${file} does not hold a key of 32 bytes in base64 or hex`);
  return key;
}

/**
 * Keeps the key file readable by its owner only (not on Windows, where the folder's access rules
 * apply): Harness Relay's own is made so again, as the database is; one RELAY_SECRETS_KEY_FILE names
 * is the user's, so it is only warned about.
 */
function keepOwnerOnly(file: string, own: boolean): void {
  if (process.platform === 'win32') return;
  const mode = statSync(file).mode & 0o777;
  if (!(mode & 0o077)) return;
  if (own) chmodSync(file, 0o600);
  else console.warn(`[secrets] ${file} can be read by other users (mode ${mode.toString(8)}): make it readable by its owner only (chmod 600)`);
}

/** What binds an encrypted secret to its name, so that one cannot be passed off as another. */
const associated = (name: string) => Buffer.from(`harness-relay secret ${name}`, 'utf8');

/** `value` encrypted with `key` for the secret `name`: `v1:` and base64 of the IV, the ciphertext and the tag. */
export function sealSecret(key: Buffer, name: string, value: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associated(name));
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
}

/** The secret `name` that `sealSecret` encrypted with `key`; throws when it was not, or was changed since. */
export function openSealed(key: Buffer, name: string, sealed: string): string {
  const raw = sealed.startsWith(SEALED_PREFIX) ? Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64') : undefined;
  if (!raw || raw.length < IV_BYTES + TAG_BYTES) throw new Error(`the secret ${name} is not one Harness Relay encrypted`);
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAAD(associated(name));
  decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8');
}

/** The secrets kept encrypted in the database (`secrets`), with `key`, from `keyFile`. */
export function openEncryptedStore(db: Database, key: Buffer, keyFile: string): SecretStore {
  return {
    storage: 'encrypted',
    get(name) {
      const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name) as { value: string } | undefined;
      if (!row) return null;
      try {
        return openSealed(key, name, row.value);
      } catch {
        throw new Error(
          `the secret ${name} cannot be decrypted with the key in ${keyFile}: it was encrypted with another one (the key file was replaced, or the database was copied without it)`,
        );
      }
    },
    set(name, value) {
      db.prepare('INSERT INTO secrets (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(
        name,
        sealSecret(key, name, value),
      );
    },
    delete(name) {
      db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
    },
  };
}

/**
 * Where the secrets go: `keyring` (the OS credential store) when there is one; else the database,
 * encrypted with the key in `secretsKeyFile()`, made at the first start without one, unless
 * RELAY_SECRETS_KEY_FILE names it (that one must be there: a typo would otherwise start a new key).
 * Throws when the key cannot be had, for the server to refuse to start rather than keep secrets it
 * cannot read back. With a credential store, the secrets kept encrypted in the database while there
 * was none are moved into it; those that cannot be are still read from the database until they are
 * set again.
 */
export function openSecretStore(
  db: Database,
  keyring: SecretStore | undefined,
  o: { dataDir: string; env?: NodeJS.ProcessEnv },
): SecretStore {
  const env = o.env ?? process.env;
  const file = secretsKeyFile(o.dataDir, env);
  const own = !env.RELAY_SECRETS_KEY_FILE?.trim();
  withholdFile(file);
  if (!keyring) {
    let key: Buffer;
    try {
      key = loadSecretsKey(file, { create: own });
    } catch (err) {
      const what = (err as Error).message;
      throw new Error(
        own
          ? `${what}. Without a system credential store, Harness Relay keeps its secrets encrypted with this key: put the file back, or remove it to start with a new key (the API keys and MCP values kept with the old one have to be set again).`
          : `${what} (RELAY_SECRETS_KEY_FILE). Make one with: openssl rand -base64 32 > ${file} && chmod 600 ${file}`,
      );
    }
    keepOwnerOnly(file, own);
    return openEncryptedStore(db, key, file);
  }
  const names = (db.prepare('SELECT name FROM secrets ORDER BY name').all() as { name: string }[]).map((r) => r.name);
  if (!names.length) return keyring;
  let encrypted: SecretStore;
  try {
    encrypted = openEncryptedStore(db, loadSecretsKey(file, { create: false }), file);
  } catch (err) {
    console.warn(`[secrets] ${names.length} secret(s) kept encrypted in the database cannot be moved to the credential store: ${(err as Error).message}`);
    return keyring;
  }
  const left = new Set<string>();
  for (const name of names) {
    try {
      const value = encrypted.get(name)!;
      keyring.set(name, value);
      if (keyring.get(name) !== value) throw new Error('the stored secret reads back differently');
      encrypted.delete(name);
    } catch (err) {
      left.add(name);
      console.warn(`[secrets] could not move ${name} from the database to the credential store: ${(err as Error).message}`);
    }
  }
  // Write the emptied pages into the database file now, rather than at some later checkpoint.
  if (left.size < names.length) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  if (!left.size) return keyring;
  return {
    storage: keyring.storage,
    get: (name) => keyring.get(name) ?? (left.has(name) ? encrypted.get(name) : null),
    set(name, value) {
      keyring.set(name, value);
      if (left.delete(name)) encrypted.delete(name);
    },
    delete(name) {
      keyring.delete(name);
      if (left.delete(name)) encrypted.delete(name);
    },
  };
}
