import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { autostartFile, desktopEntry, execArg, execLine, isAutostartOn, setAutostart } from '../desktop/src/autostart';
import { DESKTOP_MESSAGES, pickLang } from '../desktop/src/i18n';
import type { ManualReason, UpdateFailure } from '../desktop/src/update';
import { DESKTOP_ICONS, encodePngRgba, rasterizeIcon } from '../desktop/src/icons';
import {
  chatAddress,
  crashNotice,
  guardContents,
  HIDDEN_ARG,
  launchCommand,
  linkAction,
  needsRestartFor,
  permissionAllowed,
  permissionChecked,
  reopenAction,
  startedAtLogin,
  tailnetName,
} from '../desktop/src/lifecycle';
import { packagedApps } from '../desktop/scripts/packaged';
import { appManifest } from '../desktop/src/manifest';
import { ServerLog } from '../desktop/src/log';
import { DEFAULT_PREFS, loadPrefs, parsePrefs, savePrefs } from '../desktop/src/prefs';
import { browserDir, LEGACY_SIGN_IN, prepareBrowserDir } from '../desktop/src/profile';

const dir = mkdtempSync(join(tmpdir(), 'relay-desktop-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('open at login on Linux', () => {
  it('leaves plain arguments alone and quotes the others', () => {
    expect(execArg('/opt/Harness/harness-relay')).toBe('/opt/Harness/harness-relay');
    expect(execArg('--hidden')).toBe('--hidden');
    expect(execArg('/opt/Harness Relay/harness-relay')).toBe('"/opt/Harness Relay/harness-relay"');
    expect(execArg('a"b$c`d')).toBe('"a\\"b\\$c\\`d"');
    expect(execArg('')).toBe('""');
  });

  it('doubles % (field codes) and escapes backslashes once more for the string value', () => {
    expect(execArg('100%')).toBe('100%%');
    // A literal backslash takes four in the file (Desktop Entry Specification).
    expect(execLine(['a\\b'])).toBe('"a\\\\\\\\b"');
  });

  it('writes an entry that starts the app hidden', () => {
    const entry = desktopEntry({ name: 'Harness Relay', comment: 'Open\nHarness Relay', exec: ['/opt/Harness Relay/harness-relay', '--hidden'] });
    expect(entry).toContain('[Desktop Entry]\nType=Application\nName=Harness Relay\nComment=Open Harness Relay\n');
    expect(entry).toContain('Exec="/opt/Harness Relay/harness-relay" --hidden\n');
    expect(entry).toContain('X-GNOME-Autostart-enabled=true');
  });

  it('puts it in $XDG_CONFIG_HOME/autostart, or ~/.config/autostart', () => {
    expect(autostartFile({}, '/home/me')).toBe(join('/home/me', '.config', 'autostart', 'harness-relay.desktop'));
    expect(autostartFile({ XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe(join('/cfg', 'autostart', 'harness-relay.desktop'));
  });

  it('turns on by writing the entry and off by removing it', () => {
    const file = autostartFile({ XDG_CONFIG_HOME: dir }, '/unused');
    expect(isAutostartOn(file)).toBe(false);
    setAutostart(file, true, 'entry');
    expect(readFileSync(file, 'utf8')).toBe('entry');
    expect(isAutostartOn(file)).toBe(true);
    setAutostart(file, false, 'entry');
    expect(existsSync(file)).toBe(false);
    setAutostart(file, false, 'entry'); // already off
  });
});

describe("the desktop app's settings", () => {
  it('fills in defaults for what is missing or not valid', () => {
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{ broken')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('[1]')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"keepAwake": true, "port": 9000}')).toEqual({ keepAwake: true, port: 9000 });
    expect(parsePrefs('{"keepAwake": "yes", "port": 70000}')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{"port": 80.5}').port).toBe(DEFAULT_PREFS.port);
  });

  it("keeps the chat window's size, when it is a plausible one", () => {
    expect(parsePrefs('{"window": {"width": 1100, "height": 760}}').window).toEqual({ width: 1100, height: 760 });
    for (const bad of ['{"width": 10, "height": 760}', '{"width": 1100}', '{"width": "1100", "height": 760}', '[1100, 760]']) {
      expect(parsePrefs(`{"window": ${bad}}`).window, bad).toBeUndefined();
    }
  });

  it("keeps this computer's tailnet name, when it is a host name", () => {
    expect(parsePrefs('{"tailnetName": "My-Mac.tail1234.ts.net"}').tailnetName).toBe('my-mac.tail1234.ts.net');
    for (const bad of ['"evil.example/path"', '"localhost"', '"a b.ts.net"', '42', '""']) {
      expect(parsePrefs(`{"tailnetName": ${bad}}`).tailnetName, bad).toBeUndefined();
    }
  });

  it('saves and loads them', () => {
    const file = join(dir, 'prefs', 'desktop.json');
    expect(loadPrefs(file)).toEqual(DEFAULT_PREFS);
    savePrefs(file, { keepAwake: true, port: 8799 });
    expect(loadPrefs(file)).toEqual({ keepAwake: true, port: 8799 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    writeFileSync(file, 'garbage');
    expect(loadPrefs(file)).toEqual(DEFAULT_PREFS);
  });
});

describe("the desktop app's language", () => {
  it('follows the system: any Chinese → 繁體中文, otherwise English', () => {
    expect(pickLang(['zh-Hant-TW'])).toBe('zh-TW');
    expect(pickLang(['zh-CN', 'en-US'])).toBe('zh-TW');
    expect(pickLang(['en-GB', 'zh-TW'])).toBe('en');
    expect(pickLang(['fr-FR', 'zh-TW'])).toBe('zh-TW');
    expect(pickLang(['fr-FR'])).toBe('en');
    expect(pickLang([])).toBe('en');
  });

  it('has the same messages in both languages', () => {
    const shape = (m: object) => Object.entries(m).map(([k, v]) => `${k}:${typeof v}:${typeof v === 'function' ? v.length : ''}`).sort();
    expect(shape(DESKTOP_MESSAGES.en)).toEqual(shape(DESKTOP_MESSAGES['zh-TW']));
    // Messages that take one of a few reasons say each of them.
    const reasons: Record<string, readonly string[]> = {
      updateManualDetail: ['not-packaged', 'no-installer', 'no-checksum', 'read-only', 'not-appimage'] satisfies ManualReason[],
      updateFailedDetail: ['download', 'checksum', 'unpack', 'verify', 'replace', 'start'] satisfies UpdateFailure[],
    };
    for (const m of Object.values(DESKTOP_MESSAGES)) {
      for (const [k, v] of Object.entries(m)) {
        const call = v as (...a: unknown[]) => string;
        const texts = typeof v !== 'function' ? [v] : reasons[k] ? reasons[k].map((r) => call(r)) : [call('x', 'y')];
        for (const text of texts) expect(text, k).toBeTruthy();
      }
    }
  });
});

/** Decodes an 8-bit RGBA PNG written by encodePngRgba. */
function decode(png: Buffer): { size: number; rgba: Buffer } {
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  const size = png.readUInt32BE(16);
  expect(png[25]).toBe(6); // RGBA
  let at = 8;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const rows = inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) rows.copy(rgba, y * size * 4, y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1));
  return { size, rgba };
}

describe("the desktop app's icons", () => {
  const pixel = (rgba: Buffer, size: number, x: number, y: number) => [...rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

  it('draws the app icon as a white rounded square with the mark, transparent around it', () => {
    const icon = DESKTOP_ICONS.find((i) => i.style === 'app')!;
    expect(icon.size).toBeGreaterThanOrEqual(512); // electron-builder's minimum for macOS
    const { size, rgba } = decode(encodePngRgba(icon.size, rasterizeIcon(icon)));
    expect(size).toBe(1024);
    expect(pixel(rgba, size, 0, 0)[3]).toBe(0); // corner
    expect(pixel(rgba, size, 110, 110)[3]).toBe(0); // cut off by the rounded corner
    expect(pixel(rgba, size, 200, 200)).toEqual([255, 255, 255, 255]); // inside it
    expect(pixel(rgba, size, 512, 140)).toEqual([255, 255, 255, 255]); // top edge of the square
    // The Claude Code circle, left of the middle, in its colour.
    expect(pixel(rgba, size, 380, 500)).toEqual([0xd9, 0x77, 0x57, 255]);
  });

  it('draws the menu-bar icon black on transparent, for macOS to tint', () => {
    for (const icon of DESKTOP_ICONS.filter((i) => i.style === 'template')) {
      const { size, rgba } = decode(encodePngRgba(icon.size, rasterizeIcon(icon)));
      expect(size).toBe(icon.size);
      for (let i = 0; i < rgba.length; i += 4) expect([rgba[i], rgba[i + 1], rgba[i + 2]]).toEqual([0, 0, 0]);
      const opaque = [...Array(size * size).keys()].filter((p) => rgba[p * 4 + 3] === 255).length;
      expect(opaque).toBeGreaterThan(size * size * 0.2);
      expect(pixel(rgba, size, 0, 0)[3]).toBe(0);
    }
  });

  it('names the high-density tray icons @2x, at twice the size', () => {
    for (const icon of DESKTOP_ICONS.filter((i) => i.file.includes('@2x'))) {
      const base = DESKTOP_ICONS.find((i) => i.file === icon.file.replace('@2x', ''))!;
      expect(icon.size).toBe(base.size * 2);
    }
  });
});

describe("the server's log", () => {
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('starts over, keeping the previous one as .old, when it grows too big while the server runs', async () => {
    const file = join(dir, 'logs', 'server.log');
    const log = new ServerLog(file, 100);
    log.open('--- start ---\n');
    log.write('a'.repeat(60));
    log.write('b'.repeat(60)); // past the limit: a new file
    log.close();
    await settle();
    expect(readFileSync(`${file}.old`, 'utf8')).toBe(`--- start ---\n${'a'.repeat(60)}`);
    expect(readFileSync(file, 'utf8')).toBe('b'.repeat(60));
  });

  it('starts over at a start when the file is too big already, and appends otherwise', async () => {
    const file = join(dir, 'logs2', 'server.log');
    mkdirSync(join(dir, 'logs2'));
    writeFileSync(file, 'x'.repeat(150));
    const log = new ServerLog(file, 100);
    log.open('--- one ---\n');
    log.close();
    log.open('--- two ---\n');
    log.close();
    await settle();
    expect(readFileSync(`${file}.old`, 'utf8')).toBe('x'.repeat(150));
    expect(readFileSync(file, 'utf8')).toBe('--- one ---\n--- two ---\n');
  });

  it('gives up quietly when it cannot be written, instead of failing the app', async () => {
    const blocked = join(dir, 'not-a-folder');
    writeFileSync(blocked, '');
    const log = new ServerLog(join(blocked, 'server.log'));
    expect(() => log.open('header\n')).not.toThrow();
    expect(() => log.write('output\n')).not.toThrow();
    await settle(); // a stream error would surface here as an uncaught exception
    log.close();
  });
});

describe("the chat window's browser folder", () => {
  it('is a folder of its own, made before the server starts, and an old sign-in beside it is removed', () => {
    const userData = join(dir, 'user-data');
    mkdirSync(join(userData, 'Local Storage', 'leveldb'), { recursive: true });
    writeFileSync(join(userData, 'Cookies'), 'old cookie');
    writeFileSync(join(userData, 'desktop.json'), '{}');
    mkdirSync(join(userData, 'data'));
    const browser = prepareBrowserDir(userData);
    expect(browser).toBe(browserDir(userData));
    expect(browser).toBe(join(userData, 'browser'));
    expect(existsSync(browser)).toBe(true);
    for (const name of LEGACY_SIGN_IN) expect(existsSync(join(userData, name)), name).toBe(false);
    // The app's settings and the server's data stay.
    expect(existsSync(join(userData, 'desktop.json'))).toBe(true);
    expect(existsSync(join(userData, 'data'))).toBe(true);
    prepareBrowserDir(userData); // again: nothing to remove
  });
});

describe("the packaged apps electron-builder leaves (desktop/scripts/check-package.ts)", () => {
  it('finds the Mac, Windows and Linux apps, and of a universal Mac app only the result', () => {
    const out = join(dir, 'release');
    const make = (path: string) => mkdirSync(join(out, path), { recursive: true });
    make('mac-universal/Harness Relay.app/Contents');
    make('mac-universal-x64-temp/Harness Relay.app/Contents');
    make('mac-arm64/Harness Relay.app/Contents');
    make('win-unpacked');
    writeFileSync(join(out, 'win-unpacked', 'Harness Relay.exe'), '');
    make('linux-unpacked');
    writeFileSync(join(out, 'linux-unpacked', 'harness-relay'), '');
    make('.icon-icns');
    writeFileSync(join(out, 'Harness-Relay-2026-11-10-mac-universal.dmg'), '');
    const apps = packagedApps(out);
    expect(apps.map((a) => a.fuses).sort()).toEqual(
      [join(out, 'linux-unpacked', 'harness-relay'), join(out, 'mac-universal', 'Harness Relay.app'), join(out, 'win-unpacked', 'Harness Relay.exe')].sort(),
    );
    const mac = apps.find((a) => a.universal)!;
    expect(mac.exe).toBe(join(out, 'mac-universal', 'Harness Relay.app', 'Contents', 'MacOS', 'Harness Relay'));
    expect(mac.resources).toBe(join(out, 'mac-universal', 'Harness Relay.app', 'Contents', 'Resources'));
    expect(apps.find((a) => a.exe.endsWith('.exe'))!.resources).toBe(join(out, 'win-unpacked', 'resources'));
  });
});

describe("the app folder's package.json", () => {
  it('names the app, so its folders are called Harness Relay, and runs main.cjs', () => {
    const m = appManifest({ version: '1.2.3', description: 'd', license: 'SUL-1.0' });
    expect(m).toMatchObject({ name: 'harness-relay', productName: 'Harness Relay', version: '1.2.3', main: 'main.cjs', license: 'SUL-1.0' });
  });
});

describe("the desktop app's decisions", () => {
  it('opens the chat signed in, with a link for its own server only', () => {
    expect(chatAddress('http://127.0.0.1:8787', 'http://127.0.0.1:8787/#code=ABCD2345')).toBe('http://127.0.0.1:8787/#code=ABCD2345');
    expect(chatAddress('http://127.0.0.1:8787', undefined)).toBe('http://127.0.0.1:8787');
    expect(chatAddress('http://127.0.0.1:8787', 'https://evil.example/#code=x')).toBe('http://127.0.0.1:8787');
    expect(chatAddress('http://127.0.0.1:8787', 'http://127.0.0.1:87870/#code=x')).toBe('http://127.0.0.1:8787');
  });

  it('notifies of a server that stopped by itself after it ran, not of one that could not start or was stopped', () => {
    const running = { kind: 'running', url: 'http://127.0.0.1:8787', port: 8787 } as const;
    const crashed = { kind: 'stopped', error: { kind: 'exited', code: 1, log: '' } } as const;
    expect(crashNotice(running, crashed, false)).toBe(true);
    expect(crashNotice(running, crashed, true)).toBe(false); // quitting
    expect(crashNotice({ kind: 'starting' }, crashed, false)).toBe(false); // a dialog explains it
    expect(crashNotice({ kind: 'stopping' }, { kind: 'stopped' }, false)).toBe(false);
    expect(crashNotice(running, { kind: 'stopped', error: { kind: 'port-in-use', port: 8787 } }, false)).toBe(false);
  });

  it("shows the chat's window, or starts the server, when opened again", () => {
    expect(reopenAction('running')).toBe('open');
    expect(reopenAction('stopped')).toBe('start');
    expect(reopenAction('starting')).toBe('none');
    expect(reopenAction('stopping')).toBe('none');
  });

  it("keeps the window's pages on the server, and sends other links to the browser", () => {
    const server = 'http://127.0.0.1:8787';
    expect(linkAction('http://127.0.0.1:8787/#/c/123', server)).toBe('in-app');
    expect(linkAction('http://127.0.0.1:8787/api/conversations/1/download?path=a.pdf', server)).toBe('in-app');
    expect(linkAction('https://gist.github.com/abc', server)).toBe('external');
    expect(linkAction('mailto:someone@example.com', server)).toBe('external');
    expect(linkAction('http://127.0.0.1:9999/', server)).toBe('external'); // another port is another site (AgentsView)
    expect(linkAction('http://localhost:8787/', server)).toBe('external');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', 'chrome://settings']) {
      expect(linkAction(url, server), url).toBe('deny');
    }
  });

  it('lets only the server’s pages use the microphone (no camera), write to the clipboard and go full screen', () => {
    const server = 'http://127.0.0.1:8787';
    expect(permissionAllowed('media', 'http://127.0.0.1:8787/#/', server, ['audio'])).toBe(true);
    expect(permissionAllowed('media', 'http://127.0.0.1:8787/#/', server, ['audio', 'video'])).toBe(false);
    expect(permissionAllowed('media', 'http://127.0.0.1:8787/#/', server, [])).toBe(false);
    expect(permissionAllowed('clipboard-sanitized-write', 'http://127.0.0.1:8787/', server)).toBe(true);
    // A video's own full-screen button (Electron asks the permission handler for it).
    expect(permissionAllowed('fullscreen', 'http://127.0.0.1:8787/#/c/1', server)).toBe(true);
    expect(permissionAllowed('fullscreen', 'https://evil.example/', server)).toBe(false);
    // Notifications when agents finish or need you (Settings → Notifications), from its own pages only.
    expect(permissionAllowed('notifications', 'http://127.0.0.1:8787/#/', server)).toBe(true);
    expect(permissionAllowed('notifications', 'https://evil.example/', server)).toBe(false);
    for (const p of ['geolocation', 'clipboard-read', 'openExternal', 'pointerLock']) {
      expect(permissionAllowed(p, 'http://127.0.0.1:8787/', server), p).toBe(false);
    }
    expect(permissionAllowed('media', 'https://evil.example/', server, ['audio'])).toBe(false);
    expect(permissionAllowed('media', undefined, server, ['audio'])).toBe(false);
  });

  it('answers a permission check for media without a kind as one for the microphone, and none without a server', () => {
    const server = 'http://127.0.0.1:8787';
    expect(permissionChecked('media', 'http://127.0.0.1:8787', server)).toBe(true);
    expect(permissionChecked('media', 'http://127.0.0.1:8787', server, 'audio')).toBe(true);
    expect(permissionChecked('media', 'http://127.0.0.1:8787', server, 'video')).toBe(false);
    expect(permissionChecked('media', 'http://127.0.0.1:8787', undefined)).toBe(false); // the server stopped
    expect(permissionChecked('geolocation', 'http://127.0.0.1:8787', server)).toBe(false);
    // Notifications' permission, as the page reads it (Notification.permission), for its own pages.
    expect(permissionChecked('notifications', 'http://127.0.0.1:8787', server)).toBe(true);
    expect(permissionChecked('notifications', 'https://evil.example', server)).toBe(false);
  });

  describe("guarding a window's pages", () => {
    /** A window's contents: records its handlers, so the test can play Electron's part. */
    function fakeContents() {
      const contents = Object.assign(new EventEmitter(), {
        openHandler: undefined as undefined | ((d: { url: string }) => { action: string; overrideBrowserWindowOptions?: object }),
        setWindowOpenHandler(fn: (d: { url: string }) => { action: 'allow'; overrideBrowserWindowOptions?: object } | { action: 'deny' }) {
          contents.openHandler = fn;
        },
      });
      return contents;
    }
    const navigate = (contents: EventEmitter, event: 'will-navigate' | 'will-redirect', url: string) => {
      let prevented = false;
      contents.emit(event, { preventDefault: () => (prevented = true) }, url);
      return prevented;
    };

    function setup(running = true) {
      const server = running ? 'http://127.0.0.1:8787' : undefined;
      const opened: string[] = [];
      const contents = fakeContents();
      const o = { serverUrl: () => server, openExternal: (url: string) => void opened.push(url), windowOptions: () => ({ title: 'Harness Relay' }) };
      guardContents(contents, o);
      return { contents, opened };
    }

    it("opens the server's own pages in a window of the app, others in the browser, the rest nowhere", () => {
      const { contents, opened } = setup();
      expect(contents.openHandler!({ url: 'http://127.0.0.1:8787/api/conversations/1/download?path=a.pdf' })).toEqual({
        action: 'allow',
        overrideBrowserWindowOptions: { title: 'Harness Relay' },
      });
      expect(contents.openHandler!({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
      expect(contents.openHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
      expect(opened).toEqual(['https://example.com/']);
    });

    it('stops navigations and redirects away from the server, sending web pages to the browser', () => {
      const { contents, opened } = setup();
      expect(navigate(contents, 'will-navigate', 'http://127.0.0.1:8787/#/c/2')).toBe(false);
      expect(navigate(contents, 'will-navigate', 'https://example.com/')).toBe(true);
      expect(navigate(contents, 'will-redirect', 'https://evil.example/')).toBe(true);
      expect(navigate(contents, 'will-navigate', 'javascript:alert(1)')).toBe(true);
      expect(opened).toEqual(['https://example.com/', 'https://evil.example/']);
    });

    it('guards the windows a page opens too', () => {
      const { contents, opened } = setup();
      const child = fakeContents();
      contents.emit('did-create-window', { webContents: child });
      expect(navigate(child, 'will-navigate', 'https://example.com/')).toBe(true);
      expect(child.openHandler!({ url: 'file:///etc/hosts' })).toEqual({ action: 'deny' });
      expect(opened).toEqual(['https://example.com/']);
    });

    it('lets nothing through while the server does not run', () => {
      const { contents, opened } = setup(false);
      expect(navigate(contents, 'will-navigate', 'http://127.0.0.1:8787/')).toBe(true);
      expect(contents.openHandler!({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
      expect(opened).toEqual([]);
    });
  });

  it('knows a start at login', () => {
    expect(startedAtLogin(['/app', HIDDEN_ARG], 'win32', false)).toBe(true);
    expect(startedAtLogin(['/app'], 'linux', false)).toBe(false);
    expect(startedAtLogin(['/app'], 'darwin', true)).toBe(true);
    expect(startedAtLogin(['/app'], 'win32', true)).toBe(false); // only macOS reports it
  });

  it('starts the installed app at login, the AppImage by its own file, and an unpackaged one with its folder', () => {
    const base = { execPath: '/opt/Harness Relay/harness-relay', packaged: true, appPath: '/opt/Harness Relay/resources/app.asar' };
    expect(launchCommand(base)).toEqual(['/opt/Harness Relay/harness-relay']);
    expect(launchCommand({ ...base, execPath: '/tmp/.mount_x/harness-relay', appImage: '/home/me/Harness-Relay.AppImage' })).toEqual(['/home/me/Harness-Relay.AppImage']);
    expect(launchCommand({ execPath: '/repo/desktop/node_modules/electron/dist/electron', packaged: false, appPath: '/repo/desktop/build/app' })).toEqual([
      '/repo/desktop/node_modules/electron/dist/electron',
      '/repo/desktop/build/app',
    ]);
  });

  it("answers to the tailnet name Tailscale reports, else the last one seen (Tailscale not connected yet at login)", () => {
    expect(tailnetName('now.ts.net', 'before.ts.net')).toBe('now.ts.net');
    expect(tailnetName(undefined, 'before.ts.net')).toBe('before.ts.net');
    expect(tailnetName(undefined, undefined)).toBeUndefined();
  });

  it('restarts the server for a tailnet name it does not answer to yet', () => {
    expect(needsRestartFor('My-Mac.tail1.ts.net', ['my-mac.tail1.ts.net'])).toBe(false);
    expect(needsRestartFor('my-mac.tail1.ts.net', [])).toBe(true);
    expect(needsRestartFor('my-mac.tail1.ts.net', undefined)).toBe(false); // no server: it starts with the name
  });
});
