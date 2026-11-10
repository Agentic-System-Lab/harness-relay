import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appImageTarget,
  checkLatest,
  download,
  installPlan,
  isNewer,
  macAppOf,
  macStaging,
  newestRelease,
  parseRelease,
  placeAppImage,
  relaunchCommand,
  relaunchEnv,
  RELEASES_API,
  removeMacLeftovers,
  stageMacApp,
  swapMacApp,
  UpdateError,
  updateSystem,
  WINDOWS_INSTALLER_ARGS,
  type Fetch,
  type UpdateAsset,
} from '../desktop/src/update';
import { spawnDetached } from '../src/server/process';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-update-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const posixIt = process.platform === 'win32' ? it.skip : it;
const macIt = process.platform === 'darwin' ? it : it.skip;

const DOWNLOAD = 'https://github.com/Agentic-System-Lab/harness-relay/releases/download';
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** A release as GitHub lists it (GET /repos/…/releases). */
function githubRelease(tag: string, o: { prerelease?: boolean; draft?: boolean; digest?: boolean } = {}) {
  const asset = (end: string) => {
    const name = `Harness-Relay-${tag}${end}`;
    return { name, browser_download_url: `${DOWNLOAD}/${tag}/${name}`, size: 1000, ...(o.digest === false ? {} : { digest: `sha256:${sha(name)}` }) };
  };
  return {
    tag_name: tag,
    draft: o.draft ?? false,
    prerelease: o.prerelease ?? tag.includes('-rc'),
    html_url: `https://github.com/Agentic-System-Lab/harness-relay/releases/tag/${tag}`,
    assets: [asset('-mac-universal.dmg'), asset('-win-x64.exe'), asset('-linux-x86_64.AppImage'), { name: 'notes.txt', browser_download_url: `${DOWNLOAD}/${tag}/notes.txt` }],
  };
}

describe("GitHub's newest release", () => {
  it('is read with each system’s installer and its checksum', () => {
    const r = parseRelease(githubRelease('2026-11-12.1'))!;
    expect(r.version).toBe('2026-11-12.1');
    expect(r.semver).toBe('2026.1112.1');
    expect(r.page).toBe('https://github.com/Agentic-System-Lab/harness-relay/releases/tag/2026-11-12.1');
    expect(r.assets.mac).toEqual({
      name: 'Harness-Relay-2026-11-12.1-mac-universal.dmg',
      url: `${DOWNLOAD}/2026-11-12.1/Harness-Relay-2026-11-12.1-mac-universal.dmg`,
      size: 1000,
      sha256: sha('Harness-Relay-2026-11-12.1-mac-universal.dmg'),
    });
    expect(Object.keys(r.assets).sort()).toEqual(['linux', 'mac', 'win']);
  });

  it('can be a release candidate, as the app was built for one; never a draft or a tag that is not a version of ours', () => {
    const rc = parseRelease(githubRelease('2026-11-12-rc.1'))!;
    expect(rc).toMatchObject({ version: '2026-11-12-rc.1', semver: '2026.1112.0-rc.1' });
    expect(rc.assets.mac?.name).toBe('Harness-Relay-2026-11-12-rc.1-mac-universal.dmg');
    expect(parseRelease(githubRelease('2026-11-12', { prerelease: true }))?.version).toBe('2026-11-12');
    expect(parseRelease(githubRelease('2026-11-12-rc', { draft: true }))).toBeUndefined();
    expect(parseRelease(githubRelease('2026-11-12', { draft: true }))).toBeUndefined();
    expect(parseRelease(githubRelease('v0.1.0'))).toBeUndefined();
    expect(parseRelease(null)).toBeUndefined();
    expect(parseRelease({ message: 'Not Found' })).toBeUndefined();
  });

  it('is the newest version in the list, a release candidate included, whatever order GitHub lists them in', () => {
    const tags = (...list: string[]) => list.map((tag) => githubRelease(tag));
    expect(newestRelease(tags('2026-11-12-rc', '2026-11-11.1', '2026-11-11', '2026-11-11-rc'))?.version).toBe('2026-11-12-rc');
    expect(newestRelease(tags('2026-11-11', '2026-11-12-rc.1', '2026-11-12-rc'))?.version).toBe('2026-11-12-rc.1');
    // The day's release comes after its release candidates, and its patches after it.
    expect(newestRelease(tags('2026-11-12-rc.2', '2026-11-12', '2026-11-12-rc.1'))?.version).toBe('2026-11-12');
    expect(newestRelease(tags('2026-11-12', '2026-11-12.1', '2026-11-12-rc.3'))?.version).toBe('2026-11-12.1');
    // Drafts and tags that are not versions of ours are left out.
    expect(newestRelease([githubRelease('2026-11-13-rc', { draft: true }), githubRelease('v9.0.0'), githubRelease('2026-11-12')])?.version).toBe('2026-11-12');
    expect(newestRelease([])).toBeUndefined();
    expect(newestRelease([githubRelease('2026-11-13', { draft: true })])).toBeUndefined();
    expect(newestRelease({ message: 'Not Found' })).toBeUndefined();
    expect(newestRelease(null)).toBeUndefined();
  });

  it('leaves out installers elsewhere, with a name that leaves its folder, or a checksum that is not SHA-256', () => {
    const r = githubRelease('2026-11-12');
    r.assets[0]!.browser_download_url = 'https://evil.example/Harness-Relay-2026-11-12-mac-universal.dmg';
    r.assets[1]!.name = '../../Harness-Relay-2026-11-12-win-x64.exe';
    (r.assets[2] as { digest?: string }).digest = 'md5:abc';
    const parsed = parseRelease(r)!;
    expect(parsed.assets.mac).toBeUndefined();
    expect(parsed.assets.win).toBeUndefined();
    expect(parsed.assets.linux?.sha256).toBeUndefined();
    // A page elsewhere is replaced by the releases page.
    expect(parseRelease({ ...githubRelease('2026-11-12'), html_url: 'https://evil.example/' })!.page).toBe('https://github.com/Agentic-System-Lab/harness-relay/releases');
  });

  it('is newer than a build of an earlier day, an earlier patch, a release candidate of its day, or a dev build', () => {
    const latest = parseRelease(githubRelease('2026-11-12'));
    expect(isNewer(latest, '2026.1111.3')).toBe(true);
    expect(isNewer(latest, '2026.1112.0-rc.2')).toBe(true);
    expect(isNewer(latest, '2026.1112.0-dev')).toBe(true);
    expect(isNewer(latest, '0.1.0')).toBe(true);
    expect(isNewer(latest, '2026.1112.0')).toBe(false);
    expect(isNewer(latest, '2026.1112.1')).toBe(false);
    expect(isNewer(latest, '2026.1113.0-dev')).toBe(false);
    expect(isNewer(undefined, '0.1.0')).toBe(false);
  });

  it('as a release candidate, is newer than an earlier day or candidate, but not than its day’s release', () => {
    const rc = parseRelease(githubRelease('2026-11-12-rc.1'));
    expect(isNewer(rc, '2026.1111.1')).toBe(true);
    expect(isNewer(rc, '2026.1112.0-rc')).toBe(true);
    expect(isNewer(rc, '2026.1112.0-dev')).toBe(true);
    expect(isNewer(rc, '2026.1112.0-rc.1')).toBe(false);
    expect(isNewer(rc, '2026.1112.0-rc.2')).toBe(false);
    expect(isNewer(rc, '2026.1112.0')).toBe(false);
  });

  it('is asked for at GitHub; none yet is no update, any other failure an error', async () => {
    const asked: string[] = [];
    const answer = (status: number, body: unknown): Fetch =>
      async (url) => {
        asked.push(url);
        return new Response(JSON.stringify(body), { status });
      };
    expect((await checkLatest(answer(200, [githubRelease('2026-11-13-rc'), githubRelease('2026-11-12')])))?.version).toBe('2026-11-13-rc');
    expect(asked).toEqual([RELEASES_API]);
    expect(RELEASES_API).toBe('https://api.github.com/repos/Agentic-System-Lab/harness-relay/releases?per_page=20');
    expect(await checkLatest(answer(200, []))).toBeUndefined();
    expect(await checkLatest(answer(404, { message: 'Not Found' }))).toBeUndefined();
    await expect(checkLatest(answer(403, { message: 'rate limited' }))).rejects.toThrow('403');
  });

  it('has one installer for each system: the universal Mac app, x64 for Windows and Linux', () => {
    expect(updateSystem('darwin', 'arm64')).toBe('mac');
    expect(updateSystem('darwin', 'x64')).toBe('mac');
    expect(updateSystem('win32', 'x64')).toBe('win');
    expect(updateSystem('linux', 'x64')).toBe('linux');
    expect(updateSystem('linux', 'arm64')).toBeUndefined();
    expect(updateSystem('freebsd', 'x64')).toBeUndefined();
  });
});

describe('how this copy of the app updates', () => {
  const asset: UpdateAsset = { name: 'x', url: 'u', sha256: 'a'.repeat(64) };
  const mac = '/Applications/Harness Relay.app/Contents/MacOS/Harness Relay';
  const can = () => true;
  const cannot = () => false;

  it('replaces the Mac app where it is, when it may write there', () => {
    expect(macAppOf(mac)).toBe('/Applications/Harness Relay.app');
    expect(installPlan({ platform: 'darwin', packaged: true, execPath: mac, asset, writable: can })).toEqual({ kind: 'mac', app: '/Applications/Harness Relay.app' });
    expect(installPlan({ platform: 'darwin', packaged: true, execPath: mac, asset, writable: cannot })).toEqual({ kind: 'manual', why: 'read-only' });
    // Run from the disk image, or a translocated copy.
    for (const execPath of ['/Volumes/Harness Relay/Harness Relay.app/Contents/MacOS/Harness Relay', '/private/var/folders/x/T/AppTranslocation/ABC/d/Harness Relay.app/Contents/MacOS/Harness Relay']) {
      expect(installPlan({ platform: 'darwin', packaged: true, execPath, asset, writable: can }), execPath).toEqual({ kind: 'manual', why: 'read-only' });
    }
  });

  it('runs the installer on Windows, and replaces the AppImage on Linux', () => {
    expect(installPlan({ platform: 'win32', packaged: true, execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\harness-relay\\Harness Relay.exe', asset })).toEqual({ kind: 'win' });
    expect(installPlan({ platform: 'linux', packaged: true, execPath: '/tmp/.mount_x/harness-relay', appImage: '/home/me/Apps/Harness.AppImage', asset, writable: can })).toEqual({
      kind: 'linux',
      appImage: '/home/me/Apps/Harness.AppImage',
    });
    expect(installPlan({ platform: 'linux', packaged: true, execPath: '/opt/Harness Relay/harness-relay', asset, writable: can })).toEqual({ kind: 'manual', why: 'not-appimage' });
    expect(installPlan({ platform: 'linux', packaged: true, execPath: '/x', appImage: '/opt/H.AppImage', asset, writable: cannot })).toEqual({ kind: 'manual', why: 'read-only' });
  });

  it('sends anything else to the release page: a build from source, no installer, no checksum', () => {
    expect(installPlan({ platform: 'darwin', packaged: false, execPath: mac, asset, writable: can })).toEqual({ kind: 'manual', why: 'not-packaged' });
    expect(installPlan({ platform: 'darwin', packaged: true, execPath: mac, writable: can })).toEqual({ kind: 'manual', why: 'no-installer' });
    expect(installPlan({ platform: 'win32', packaged: true, execPath: 'x', asset: { ...asset, sha256: undefined } })).toEqual({ kind: 'manual', why: 'no-checksum' });
  });

  it('runs the Windows installer silently, as an update, starting the new version', () => {
    expect(WINDOWS_INSTALLER_ARGS).toEqual(['--updated', '/S', '--force-run']);
  });
});

describe('downloading an update', () => {
  const body = Buffer.from('the new installer '.repeat(1000));
  const asset: UpdateAsset = { name: 'H.dmg', url: `${DOWNLOAD}/v/H.dmg`, size: body.length, sha256: sha(body) };
  const serve = (data: Buffer, status = 200): Fetch => async () => new Response(new Uint8Array(data), { status, headers: { 'content-length': String(data.length) } });

  it('saves the file once its checksum matches, telling how far it got', async () => {
    const to = join(dir, 'ok.dmg');
    const progress: number[] = [];
    await download({ fetch: serve(body), asset, to, onProgress: (d) => progress.push(d) });
    expect(readFileSync(to)).toEqual(body);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true);
    expect(existsSync(`${to}.part`)).toBe(false);
  });

  it('deletes a download that does not match its checksum, and keeps nothing of a failed one', async () => {
    const to = join(dir, 'bad.dmg');
    const err = await download({ fetch: serve(Buffer.from('something else')), asset, to }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpdateError);
    expect((err as UpdateError).failure).toBe('checksum');
    expect(existsSync(to)).toBe(false);
    expect(existsSync(`${to}.part`)).toBe(false);
    const failed = await download({ fetch: serve(body, 503), asset, to }).catch((e: unknown) => e);
    expect((failed as UpdateError).failure).toBe('download');
    const offline = await download({ fetch: async () => Promise.reject(new Error('offline')), asset, to }).catch((e: unknown) => e);
    expect((offline as UpdateError).failure).toBe('download');
    expect(existsSync(to)).toBe(false);
  });
});

describe('putting the new version in place', () => {
  it('names a new AppImage after its version when the running one was named after its own', () => {
    expect(appImageTarget('/home/me/Apps/Harness-Relay-2026-11-10-linux-x86_64.AppImage', 'Harness-Relay-2026-11-12-linux-x86_64.AppImage', '2026-11-10')).toBe(
      '/home/me/Apps/Harness-Relay-2026-11-12-linux-x86_64.AppImage',
    );
    // A name the user gave it (a launcher may use it) stays.
    expect(appImageTarget('/home/me/bin/harness-relay.AppImage', 'Harness-Relay-2026-11-12-linux-x86_64.AppImage', '2026-11-10')).toBe('/home/me/bin/harness-relay.AppImage');
  });

  posixIt('puts the AppImage in place, runnable, and removes the old one when it was renamed', () => {
    const apps = join(dir, 'apps');
    mkdirSync(apps);
    const old = join(apps, 'Harness-Relay-2026-11-10-linux-x86_64.AppImage');
    writeFileSync(old, 'old');
    const downloaded = join(apps, '.new.download');
    writeFileSync(downloaded, 'new');
    const target = appImageTarget(old, 'Harness-Relay-2026-11-12-linux-x86_64.AppImage', '2026-11-10');
    placeAppImage(downloaded, target, old);
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(statSync(target).mode & 0o111).not.toBe(0);
    expect(existsSync(old)).toBe(false);
    // In place, under the same name.
    const same = join(apps, 'mine.AppImage');
    writeFileSync(same, 'old');
    writeFileSync(downloaded, 'newer');
    placeAppImage(downloaded, same, same);
    expect(readFileSync(same, 'utf8')).toBe('newer');
  });

  it('swaps the Mac app with the staged one, keeping the old aside until the next start', () => {
    const apps = join(dir, 'Applications');
    const app = join(apps, 'Harness Relay.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'v'), 'old');
    const { staged, old } = macStaging(app);
    expect(staged).toBe(join(apps, '.Harness Relay.app.update'));
    mkdirSync(join(staged, 'Contents'), { recursive: true });
    writeFileSync(join(staged, 'Contents', 'v'), 'new');
    swapMacApp(app);
    expect(readFileSync(join(app, 'Contents', 'v'), 'utf8')).toBe('new');
    expect(readFileSync(join(old, 'Contents', 'v'), 'utf8')).toBe('old');
    expect(existsSync(staged)).toBe(false);
    removeMacLeftovers(app);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(app)).toBe(true);
  });

  it('leaves the Mac app as it was when there is nothing to swap in', () => {
    const app = join(dir, 'Lonely', 'Harness Relay.app');
    mkdirSync(app, { recursive: true });
    expect(() => swapMacApp(app)).toThrow(UpdateError);
    expect(existsSync(app)).toBe(true);
    expect(existsSync(macStaging(app).old)).toBe(false);
  });

  macIt(
    'copies the app out of a disk image and checks its signature, identity and version (macOS)',
    async () => {
      // A small app, signed ad hoc like the real one, in a disk image.
      const src = join(dir, 'dmg-src');
      const bundle = join(src, 'Harness Relay.app');
      mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
      writeFileSync(join(bundle, 'Contents', 'MacOS', 'Harness Relay'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bundle, 'Contents', 'MacOS', 'Harness Relay'), 0o755);
      const plist = (id: string, version: string) =>
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>Harness Relay</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`;
      writeFileSync(join(bundle, 'Contents', 'Info.plist'), plist('io.github.agentic-system-lab.harness-relay', '2026.1112.0'));
      execFileSync('/usr/bin/codesign', ['--sign', '-', '--force', bundle], { stdio: 'ignore' });
      const dmg = join(dir, 'update.dmg');
      execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-srcfolder', src, '-format', 'UDZO', '-volname', 'Harness Relay', dmg]);

      const app = join(dir, 'Apps', 'Harness Relay.app');
      mkdirSync(app, { recursive: true });
      const staged = await stageMacApp({ dmg, app, bundleId: 'io.github.agentic-system-lab.harness-relay', semver: '2026.1112.0', env: process.env });
      expect(staged).toBe(macStaging(app).staged);
      expect(existsSync(join(staged, 'Contents', 'MacOS', 'Harness Relay'))).toBe(true);

      // Another app, or another version, is not put in place.
      for (const [bundleId, semver] of [
        ['com.example.other', '2026.1112.0'],
        ['io.github.agentic-system-lab.harness-relay', '2026.1113.0'],
      ]) {
        const err = await stageMacApp({ dmg, app, bundleId: bundleId!, semver: semver!, env: process.env }).catch((e: unknown) => e);
        expect((err as UpdateError).failure).toBe('verify');
        expect(existsSync(macStaging(app).staged)).toBe(false);
      }
      // A disk image that is not one.
      writeFileSync(join(dir, 'broken.dmg'), 'not a disk image');
      const broken = await stageMacApp({ dmg: join(dir, 'broken.dmg'), app, bundleId: 'x', semver: 'y', env: process.env }).catch((e: unknown) => e);
      expect((broken as UpdateError).failure).toBe('unpack');
    },
    120_000,
  );
});

describe('starting the new version', () => {
  it('opens the Mac app, or runs the AppImage with its arguments, once this app has exited', () => {
    const [bin, args] = relaunchCommand('darwin', 42, '/Applications/Harness Relay.app');
    expect(bin).toBe('/bin/sh');
    expect(args.slice(-3)).toEqual(['sh', '42', '/Applications/Harness Relay.app']);
    expect(args[1]).toContain('exec /usr/bin/open "$1"');
    const [, linux] = relaunchCommand('linux', 42, '/home/me/H.AppImage', ['--no-sandbox']);
    expect(linux.slice(-4)).toEqual(['sh', '42', '/home/me/H.AppImage', '--no-sandbox']);
    expect(linux[1]).toContain('exec "$@"');
  });

  it("starts the new AppImage without the old one's runtime variables", () => {
    expect(relaunchEnv({ PATH: '/bin', APPIMAGE: '/a', APPDIR: '/tmp/.mount', ARGV0: 'x', OWD: '/home' })).toEqual({ PATH: '/bin' });
  });

  posixIt(
    'waits for the app to exit before starting the new version',
    async () => {
      const marker = join(dir, 'started');
      const app = spawn('/bin/sh', ['-c', 'sleep 0.5'], { stdio: 'ignore' });
      const exited = new Promise((r) => app.on('exit', r));
      const [bin, args] = relaunchCommand('linux', app.pid!, '/bin/sh', ['-c', `date +%s%N > "${marker}"`]);
      await spawnDetached(bin, args, process.env);
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(marker)).toBe(false); // the app still runs
      await exited;
      for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(marker)).toBe(true);
    },
    20_000,
  );
});
