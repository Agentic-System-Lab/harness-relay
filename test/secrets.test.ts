import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Database } from '../src/server/db';
import { fileInRoot, listFolder, previewFile, zipPlan } from '../src/server/files';
import { resolveDownload } from '../src/server/media';
import {
  KEYRING_SERVICE,
  SECRETS_KEY_NAME,
  keyringService,
  loadSecretsKey,
  openSealed,
  openSecretStore,
  openSystemKeyring,
  parseSecretsKey,
  sealSecret,
  secretsKeyFile,
  type SecretStore,
} from '../src/server/secrets';
import { SettingsStore } from '../src/server/settings';

describe('the credential store', () => {
  it('files keys under harness-relay, or the name RELAY_KEYRING_SERVICE gives (the desktop app)', () => {
    expect(KEYRING_SERVICE).toBe('harness-relay');
    expect(keyringService({})).toBe('harness-relay');
    expect(keyringService({ RELAY_KEYRING_SERVICE: ' ' })).toBe('harness-relay');
    expect(keyringService({ RELAY_KEYRING_SERVICE: 'harness-relay-desktop' })).toBe('harness-relay-desktop');
  });

  it('is not used with RELAY_KEYRING=off', () => {
    const before = process.env.RELAY_KEYRING;
    process.env.RELAY_KEYRING = 'off';
    try {
      expect(openSystemKeyring()).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.RELAY_KEYRING;
      else process.env.RELAY_KEYRING = before;
    }
  });
});

describe('secrets encrypted in the database (no credential store)', () => {
  let dir: string;
  let data: string;
  let db: Database;
  const dbFile = () => join(data, 'relay.db');
  const open = (env: NodeJS.ProcessEnv = {}, keyring?: SecretStore) => openSecretStore(db, keyring, { dataDir: data, env });
  const rows = () => db.prepare('SELECT name, value FROM secrets ORDER BY name').all() as { name: string; value: string }[];
  /** Whether `text` is anywhere in the database's files, once what the WAL holds is written into it. */
  const onDisk = (text: string) => {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return [dbFile(), `${dbFile()}-wal`].some((f) => existsSync(f) && readFileSync(f).includes(text));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-secrets-'));
    data = join(dir, 'data');
    db = openDatabase(dbFile());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('makes an owner-only key file at the first start, and keeps each secret encrypted with it', () => {
    const store = open();
    expect(store.storage).toBe('encrypted');
    const keyFile = join(data, SECRETS_KEY_NAME);
    expect(secretsKeyFile(data, {})).toBe(keyFile);
    const keyText = readFileSync(keyFile, 'utf8');
    expect(parseSecretsKey(keyText)).toHaveLength(32);
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o777).toBe(0o600);

    store.set('claude-api-key', 'sk-ant-secret-plaintext-1234');
    expect(store.get('claude-api-key')).toBe('sk-ant-secret-plaintext-1234');
    expect(store.get('grok-api-key')).toBeNull();
    const [row] = rows();
    expect(row!.name).toBe('claude-api-key');
    expect(row!.value).toMatch(/^v1:/);
    expect(onDisk('sk-ant-secret-plaintext')).toBe(false);
    // A new IV each time: the same key saved again is not the same text.
    store.set('claude-api-key', 'sk-ant-secret-plaintext-1234');
    expect(rows()[0]!.value).not.toBe(row!.value);

    // The next start reads it back with the same key, and leaves the key file as it was.
    expect(open().get('claude-api-key')).toBe('sk-ant-secret-plaintext-1234');
    expect(readFileSync(keyFile, 'utf8')).toBe(keyText);

    store.delete('claude-api-key');
    expect(store.get('claude-api-key')).toBeNull();
    expect(rows()).toEqual([]);
  });

  it('gives a secret back only with its key, under its own name, as it was written', () => {
    const key = randomBytes(32);
    const sealed = sealSecret(key, 'grok-api-key', 'xai-1234');
    expect(openSealed(key, 'grok-api-key', sealed)).toBe('xai-1234');
    expect(openSealed(key, 'k', sealSecret(key, 'k', ''))).toBe('');
    expect(openSealed(key, 'k', sealSecret(key, 'k', '金鑰 🔑'))).toBe('金鑰 🔑');
    expect(() => openSealed(randomBytes(32), 'grok-api-key', sealed)).toThrow();
    // Moved to another name (another CLI's key, say): refused.
    expect(() => openSealed(key, 'claude-api-key', sealed)).toThrow();
    const raw = Buffer.from(sealed.slice(3), 'base64');
    raw[20]! ^= 1;
    expect(() => openSealed(key, 'grok-api-key', `v1:${raw.toString('base64')}`)).toThrow();
    expect(() => openSealed(key, 'grok-api-key', 'xai-1234')).toThrow(/not one Harness Relay encrypted/);
    expect(() => openSealed(key, 'grok-api-key', 'v1:AAAA')).toThrow(/not one Harness Relay encrypted/);
  });

  it('cannot read what was kept with another key, and says why', () => {
    open().set('grok-api-key', 'xai-old-key');
    // The database copied elsewhere without its key file, or the file replaced: a new key.
    rmSync(join(data, SECRETS_KEY_NAME));
    const store = open();
    expect(() => store.get('grok-api-key')).toThrow(/cannot be decrypted with the key in .*secrets\.key: it was encrypted with another one/);
    // Set again, it can be read.
    store.set('grok-api-key', 'xai-new-key');
    expect(store.get('grok-api-key')).toBe('xai-new-key');
  });

  it('refuses a key file of its own that holds no key, rather than make a new one over it', () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, SECRETS_KEY_NAME), 'not a key\n');
    expect(() => open()).toThrow(/does not hold a key of 32 bytes.*remove it to start with a new key/);
    expect(readFileSync(join(data, SECRETS_KEY_NAME), 'utf8')).toBe('not a key\n');
  });

  it('takes the key from the file RELAY_SECRETS_KEY_FILE names, which must be there, in base64 or hex', () => {
    const keyFile = join(dir, 'keys', 'relay.key');
    const env = { RELAY_SECRETS_KEY_FILE: keyFile };
    expect(() => open(env)).toThrow(/RELAY_SECRETS_KEY_FILE.*openssl rand -base64 32/);
    expect(existsSync(keyFile)).toBe(false);

    mkdirSync(join(dir, 'keys'));
    const key = randomBytes(32);
    writeFileSync(keyFile, `${key.toString('base64')}\n`, { mode: 0o600 });
    open(env).set('openai', 'sk-openai-1234');
    expect(existsSync(join(data, SECRETS_KEY_NAME))).toBe(false);
    expect(openSealed(key, 'openai', rows()[0]!.value)).toBe('sk-openai-1234');
    writeFileSync(keyFile, key.toString('hex'));
    expect(open(env).get('openai')).toBe('sk-openai-1234');
    writeFileSync(keyFile, key.toString('hex').slice(2));
    expect(() => open(env)).toThrow(/does not hold a key/);
    expect(loadSecretsKey(join(dir, 'missing'), { create: true })).toHaveLength(32);
  });

  it.skipIf(process.platform === 'win32')('keeps its own key file owner-only, and warns about one of the user’s that is not', () => {
    open();
    const own = join(data, SECRETS_KEY_NAME);
    chmodSync(own, 0o644);
    open();
    expect(statSync(own).mode & 0o777).toBe(0o600);

    const theirs = join(dir, 'theirs.key');
    writeFileSync(theirs, randomBytes(32).toString('base64'));
    chmodSync(theirs, 0o640);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    open({ RELAY_SECRETS_KEY_FILE: theirs });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${theirs} can be read by other users (mode 640)`));
    expect(statSync(theirs).mode & 0o777).toBe(0o640);
  });

  it('moves the API keys and MCP values an older version kept as they are into it, leaving none of them in the database file', () => {
    // An older version, with no credential store: everything as it is, in its columns.
    const before = new SettingsStore(db);
    before.update('grok', { apiKey: 'xai-plaintext-grok-key' });
    before.backends.setApiKey('openai', 'sk-plaintext-openai-key');
    before.backends.putEndpoint('homelab', { name: 'Homelab', baseUrl: 'http://lab:8000/v1', models: ['qwen'], apiKey: 'lab-plaintext-key' });
    before.tools.saveServer('github', { transport: 'stdio', command: 'npx', args: [], env: [{ name: 'GITHUB_TOKEN', value: 'ghp_plaintext_token' }] });
    const plain = ['xai-plaintext-grok-key', 'sk-plaintext-openai-key', 'lab-plaintext-key', 'ghp_plaintext_token'];
    expect(plain.every(onDisk)).toBe(true);

    const s = new SettingsStore(db, open());
    expect(s.env('grok').XAI_API_KEY).toBe('xai-plaintext-grok-key');
    expect(s.view().providers.find((p) => p.provider === 'grok')!.apiKeyStorage).toBe('encrypted');
    expect(s.backends.view().apis.find((a) => a.id === 'openai')).toMatchObject({ keyMasked: '••••-key', keyStorage: 'encrypted' });
    expect(s.backends.view().endpoints[0]).toMatchObject({ id: 'homelab', keyStorage: 'encrypted' });
    expect(s.tools.view().secretStorage).toBe('encrypted');
    expect(s.tools.view().mcpServers[0]!.env).toEqual([{ name: 'GITHUB_TOKEN', masked: expect.any(String) }]);
    expect(rows().map((r) => r.name)).toEqual(expect.arrayContaining(['grok-api-key', 'backend-openai-api-key', 'endpoint-homelab-api-key']));
    for (const text of plain) expect(onDisk(text), text).toBe(false);

    // And the next start reads them all back from there.
    const again = new SettingsStore(db, open());
    expect(again.env('grok').XAI_API_KEY).toBe('xai-plaintext-grok-key');
    expect(again.backends.forRun()).toMatchObject({ apis: { openai: 'sk-plaintext-openai-key' }, endpoints: [{ id: 'homelab', apiKey: 'lab-plaintext-key' }] });
    expect(again.tools.view().mcpServers[0]!.env).toEqual(s.tools.view().mcpServers[0]!.env);
  });

  it('moves what it kept into the credential store once there is one, and reads what it could not move from the database until that is set again', () => {
    const encrypted = open();
    encrypted.set('claude-api-key', 'sk-ant-moved');
    encrypted.set('mcp-github', '{"env":{"T":"x"},"headers":{}}');
    encrypted.set('grok-api-key', 'xai-stuck');
    const kept = new Map<string, string>([['claude-api-key', 'sk-ant-older-in-the-keyring']]);
    const keyring: SecretStore = {
      storage: 'secret-service',
      get: (name) => kept.get(name) ?? null,
      set: (name, value) => {
        if (name === 'grok-api-key' && value === 'xai-stuck') throw new Error('locked');
        kept.set(name, value);
      },
      delete: (name) => void kept.delete(name),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = open({}, keyring);
    expect(store.storage).toBe('secret-service');
    // What it kept is newer than what the keyring had from before.
    expect(kept.get('claude-api-key')).toBe('sk-ant-moved');
    expect(kept.get('mcp-github')).toBe('{"env":{"T":"x"},"headers":{}}');
    expect(rows().map((r) => r.name)).toEqual(['grok-api-key']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not move grok-api-key'));
    expect(store.get('grok-api-key')).toBe('xai-stuck');
    store.set('grok-api-key', 'xai-new');
    expect(kept.get('grok-api-key')).toBe('xai-new');
    expect(rows()).toEqual([]);
    // Moved, nothing more to do: the keyring itself.
    expect(open({}, keyring)).toBe(keyring);

    // Without the key file, what is left cannot be moved; it stays, and the keyring is used.
    open().set('cursor-api-key', 'crsr-left');
    rmSync(join(data, SECRETS_KEY_NAME));
    expect(open({}, keyring)).toBe(keyring);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 secret(s) kept encrypted in the database cannot be moved'));
    expect(rows().map((r) => r.name)).toEqual(['cursor-api-key']);
    expect(existsSync(join(data, SECRETS_KEY_NAME))).toBe(false);
  });

  it('keeps the key file from the Files panel, downloads and shares, whatever a reply links to', async () => {
    // A working directory with the data folder in it (npm start's default, from a checkout).
    open();
    writeFileSync(join(data, 'notes.txt'), 'x');
    const notFound = /404|找不到|not found/i;
    expect(listFolder(dir, 'data').entries.map((e) => e.name)).toEqual(['notes.txt']);
    expect(() => previewFile(dir, `data/${SECRETS_KEY_NAME}`)).toThrow(notFound);
    expect(() => fileInRoot(dir, `data/${SECRETS_KEY_NAME}`)).toThrow(notFound);
    expect((await zipPlan(dir, 'data'))!.entries.map((e) => e.name)).not.toContain(expect.stringContaining(SECRETS_KEY_NAME));
    expect(resolveDownload(`data/${SECRETS_KEY_NAME}`, [dir])).toBeUndefined();
    // Nor the database a reply could name the same way.
    expect(resolveDownload('data/relay.db', [dir])).toBeUndefined();
    expect(resolveDownload('data/notes.txt', [dir])).toBeDefined();
  });
});
