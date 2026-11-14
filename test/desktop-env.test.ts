import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allowedHostsOf,
  DESKTOP_KEYRING_SERVICE,
  ENV_MARK,
  loginShell,
  loginShellEnv,
  mergeShellEnv,
  mergeWindowsEnv,
  parseShellEnv,
  parseWindowsEnv,
  serverEnv,
  SHELL_ENV_FLAGS,
  shellEnvScript,
  shellQuote,
  withCommonPaths,
} from '../desktop/src/env';

const dir = mkdtempSync(join(tmpdir(), 'relay-desktop-env-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const posixIt = process.platform === 'win32' ? it.skip : it;

describe('the login shell environment', () => {
  it('reads the variables between the marks, values with new lines included', () => {
    const out = `Last login: today\nwelcome!\n${ENV_MARK}PATH=/a:/b\0MULTI=one\ntwo\0EMPTY=\0WITH_EQ=a=b\0${ENV_MARK}bye`;
    expect(parseShellEnv(out)).toEqual({ PATH: '/a:/b', MULTI: 'one\ntwo', EMPTY: '', WITH_EQ: 'a=b' });
  });

  it('gives up on output without the marks or without a PATH', () => {
    expect(parseShellEnv('nothing here')).toBeUndefined();
    expect(parseShellEnv(`${ENV_MARK}only one mark`)).toBeUndefined();
    expect(parseShellEnv(`${ENV_MARK}HOME=/h\0${ENV_MARK}`)).toBeUndefined();
  });

  it('quotes for the shell, single quotes included', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(SHELL_ENV_FLAGS).toEqual(['-i', '-l']);
    expect(shellEnvScript()).toBe(`printf '%s' '${ENV_MARK}'; /usr/bin/env -0; printf '%s' '${ENV_MARK}'`);
  });

  it("puts the shell's variables over the app's, without the shell's own", () => {
    const merged = mergeShellEnv({ PATH: '/usr/bin', HOME: '/h', KEEP: '1' }, { PATH: '/x:/usr/bin', PWD: '/tmp', SHLVL: '2', _: '/usr/bin/env', NEW: 'y' });
    expect(merged).toEqual({ PATH: '/x:/usr/bin', HOME: '/h', KEEP: '1', NEW: 'y' });
  });

  it('picks $SHELL, then the user database, then a default', () => {
    expect(loginShell({ SHELL: '/usr/local/bin/fish' })).toBe('/usr/local/bin/fish');
    expect(loginShell({})).toMatch(/^\//);
  });

  posixIt('asks a real login shell, and leaves out what it set for the shell only', async () => {
    // A shell whose profile prints things and sets a variable, like a real one would.
    const shell = join(dir, 'fake-shell');
    writeFileSync(shell, `#!/bin/sh\necho "profile noise"\nexport FROM_PROFILE=yes\nexec /bin/sh "$@"\n`);
    chmodSync(shell, 0o755);
    const env = await loginShellEnv({ PATH: '/usr/bin:/bin', HOME: dir }, { shell });
    expect(env?.FROM_PROFILE).toBe('yes');
    // A login shell may rewrite PATH (macOS's /etc/profile runs path_helper).
    expect(env?.PATH).toContain('/usr/bin');
    expect(env?.DISABLE_AUTO_UPDATE).toBeUndefined();
  });

  posixIt('reads the shell even from a path with spaces and quotes', async () => {
    const odd = join(dir, "a dir with 'quotes'");
    mkdirSync(odd);
    symlinkSync('/bin/sh', join(odd, 'sh'));
    const env = await loginShellEnv({ PATH: '/usr/bin:/bin', HOME: dir, MINE: 'kept' }, { shell: join(odd, 'sh') });
    expect(env?.MINE).toBe('kept');
  });

  posixIt('gives up on a shell that hangs (a profile waiting for input), so the app falls back', async () => {
    const shell = join(dir, 'hanging-shell');
    writeFileSync(shell, '#!/bin/sh\nsleep 30\n');
    chmodSync(shell, 0o755);
    const started = Date.now();
    expect(await loginShellEnv({ PATH: '/usr/bin:/bin' }, { shell, timeoutMs: 300 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('is undefined when the shell is missing', async () => {
    expect(await loginShellEnv({ PATH: '/usr/bin:/bin' }, { shell: join(dir, 'no-such-shell') })).toBeUndefined();
  });

  it('falls back to the usual install folders that exist, after PATH', () => {
    const home = '/home/me';
    const exists = (p: string) => ['/opt/homebrew/bin', '/home/me/.local/bin', '/usr/local/bin'].includes(p);
    expect(withCommonPaths({ PATH: '/usr/bin:/usr/local/bin' }, home, 'darwin', exists).PATH).toBe(
      '/usr/bin:/usr/local/bin:/opt/homebrew/bin:/home/me/.local/bin',
    );
    expect(withCommonPaths({}, home, 'linux', exists).PATH).toBe('/usr/local/bin:/home/me/.local/bin');
  });
});

describe("the server's environment", () => {
  const base = {
    PATH: '/bin',
    HOME: '/home/me',
    PORT: '3000',
    HOST: '0.0.0.0',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_ENABLE_LOGGING: '1',
    ANTHROPIC_API_KEY: 'sk-x',
    NODE_OPTIONS: '--max-old-space-size=4096',
  };
  const o = { dataDir: '/data', webDir: '/app/web', port: 8787, home: '/home/me', allowedHosts: [] as string[], browserDir: '/support/browser' };

  it("binds 127.0.0.1 on the app's port, whatever a profile exports for other programs", () => {
    const env = serverEnv({ ...o, base });
    expect(env.PORT).toBe('8787');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.RELAY_WEB_DIR).toBe('/app/web');
    expect(env.RELAY_DATA_DIR).toBe('/data');
    expect(env.RELAY_DEFAULT_CWD).toBe('/home/me');
    expect(env.RELAY_ALLOWED_HOSTS).toBeUndefined();
    // The window's browser folder, which the agents' sandboxes keep them from reading.
    expect(env.RELAY_APP_BROWSER_DIR).toBe('/support/browser');
  });

  it("keeps the user's variables but not Electron's", () => {
    const env = serverEnv({ ...o, base });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-x');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(Object.keys(env).filter((k) => k.startsWith('ELECTRON_'))).toEqual([]);
  });

  it('keeps a data folder and a working directory the user chose', () => {
    const env = serverEnv({ ...o, base: { ...base, RELAY_DATA_DIR: '/mine/data', RELAY_DEFAULT_CWD: '/code' } });
    expect(env.RELAY_DATA_DIR).toBe('/mine/data');
    expect(env.RELAY_DEFAULT_CWD).toBe('/code');
  });

  it("files API keys apart from npm start's when it keeps its own data, and with them when the data is shared", () => {
    expect(DESKTOP_KEYRING_SERVICE).toBe('harness-relay-desktop');
    expect(serverEnv({ ...o, base }).RELAY_KEYRING_SERVICE).toBe('harness-relay-desktop');
    expect(serverEnv({ ...o, base: { ...base, RELAY_DATA_DIR: '/shared/data' } }).RELAY_KEYRING_SERVICE).toBeUndefined();
    expect(serverEnv({ ...o, base: { ...base, RELAY_KEYRING_SERVICE: 'mine' } }).RELAY_KEYRING_SERVICE).toBe('mine');
    // The key the secrets are encrypted with without a credential store follows the data too: a
    // shell's RELAY_SECRETS_KEY_FILE is the one for its RELAY_DATA_DIR's database, not the app's own.
    expect(serverEnv({ ...o, base: { ...base, RELAY_SECRETS_KEY_FILE: '/etc/relay.key' } })).not.toHaveProperty('RELAY_SECRETS_KEY_FILE');
    expect(serverEnv({ ...o, base: { ...base, RELAY_DATA_DIR: '/shared/data', RELAY_SECRETS_KEY_FILE: '/etc/relay.key' } }).RELAY_SECRETS_KEY_FILE).toBe('/etc/relay.key');
  });

  it('adds the tailnet name to the names the user allowed, once', () => {
    const env = serverEnv({ ...o, base: { ...base, RELAY_ALLOWED_HOSTS: ' Other.example , my-mac.tail1.ts.net' }, allowedHosts: ['my-mac.tail1.ts.net'] });
    expect(env.RELAY_ALLOWED_HOSTS).toBe('other.example,my-mac.tail1.ts.net');
    expect(allowedHostsOf(env)).toEqual(['other.example', 'my-mac.tail1.ts.net']);
  });
});

describe("Windows' current environment, read again at a restart", () => {
  const answer = JSON.stringify({
    machine: { Path: 'C:\\Windows\\system32;C:\\Windows', USERNAME: 'SYSTEM', ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    user: { Path: 'C:\\Users\\王\\AppData\\Roaming\\npm;C:\\Users\\王\\.local\\bin', ANTHROPIC_API_KEY: 'sk-new' },
  });

  it("reads PowerShell's answer, with or without a byte order mark", () => {
    expect(parseWindowsEnv(answer)?.user.ANTHROPIC_API_KEY).toBe('sk-new');
    expect(parseWindowsEnv(`\uFEFF${answer}\r\n`)?.machine.Path).toBe('C:\\Windows\\system32;C:\\Windows');
    expect(parseWindowsEnv('')).toBeUndefined();
    expect(parseWindowsEnv('Access is denied.')).toBeUndefined();
    expect(parseWindowsEnv('{"machine":{}}')).toBeUndefined();
  });

  it("makes PATH as Windows does (the system's, then the user's), keeping the app's own extras once", () => {
    const base = { Path: 'C:\\Windows\\system32;C:\\Program Files\\Electron Extra\\;C:\\Windows\\System32\\', USERNAME: 'me', HOMEPATH: '\\Users\\me' };
    const env = mergeWindowsEnv(base, parseWindowsEnv(answer)!);
    expect(env.Path).toBe('C:\\Windows\\system32;C:\\Windows;C:\\Users\\王\\AppData\\Roaming\\npm;C:\\Users\\王\\.local\\bin;C:\\Program Files\\Electron Extra\\');
    // One PATH, under the name the app's environment uses.
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toEqual(['Path']);
    // The user's new variables come in; the system's defaults do not replace the session's own.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-new');
    expect(env.USERNAME).toBe('me');
    expect(env.ComSpec).toBeUndefined();
  });
});
