import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appImageDownload,
  appImageTarget,
  busyWithoutAsking,
  chatUpdate,
  CHECK_EVERY_MS,
  CHECK_TIMEOUT_MS,
  checkLatest,
  checkNow,
  DOWNLOAD_STALL_MS,
  download,
  installPlan,
  isNewer,
  LATEST_RELEASE_API,
  macAppOf,
  macStaging,
  mayAskGitHub,
  takesCandidates,
  MIN_CHECK_GAP_MS,
  newestRelease,
  oneAtATime,
  parseRelease,
  placeAppImage,
  RELAUNCH_PID,
  RELAUNCH_TARGET,
  relaunchCommand,
  relaunchEnv,
  RELEASES_API,
  removeAppImageLeftovers,
  removeMacLeftovers,
  stageMacApp,
  swapMacApp,
  UpdateError,
  updateSystem,
  whenIdle,
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
function githubRelease(tag: string, o: { prerelease?: boolean; draft?: boolean; digest?: boolean; copies?: boolean } = {}) {
  const asset = (end: string) => {
    const name = `Harness-Relay-${tag}${end}`;
    return { name, browser_download_url: `${DOWNLOAD}/${tag}/${name}`, size: 1000, ...(o.digest === false ? {} : { digest: `sha256:${sha(name)}` }) };
  };
  return {
    tag_name: tag,
    draft: o.draft ?? false,
    prerelease: o.prerelease ?? tag.includes('-rc'),
    html_url: `https://github.com/Agentic-System-Lab/harness-relay/releases/tag/${tag}`,
    assets: [
      asset('-mac-arm64.dmg'),
      asset('-win-x64.exe'),
      asset('-win-arm64.exe'),
      asset('-linux-x86_64.AppImage'),
      asset('-linux-arm64.AppImage'),
      // The same installers again for the app's updates (the Release workflow's copies), in releases made since.
      ...(o.copies ? ['-mac-arm64-update.dmg', '-win-x64-update.exe', '-win-arm64-update.exe', '-linux-x86_64-update.AppImage', '-linux-arm64-update.AppImage'].map(asset) : []),
      { name: 'notes.txt', browser_download_url: `${DOWNLOAD}/${tag}/notes.txt` },
    ],
  };
}

describe("GitHub's newest release", () => {
  it('is read with each system’s installer and its checksum', () => {
    const r = parseRelease(githubRelease('2026-11-12.1'))!;
    expect(r.version).toBe('2026-11-12.1');
    expect(r.semver).toBe('2026.1112.1');
    expect(r.page).toBe('https://github.com/Agentic-System-Lab/harness-relay/releases/tag/2026-11-12.1');
    expect(r.assets.mac).toEqual({
      name: 'Harness-Relay-2026-11-12.1-mac-arm64.dmg',
      url: `${DOWNLOAD}/2026-11-12.1/Harness-Relay-2026-11-12.1-mac-arm64.dmg`,
      size: 1000,
      sha256: sha('Harness-Relay-2026-11-12.1-mac-arm64.dmg'),
    });
    expect(Object.keys(r.assets).sort()).toEqual(['linux', 'linux-arm64', 'mac', 'win', 'win-arm64']);
  });

  it("is fetched from each installer's copy for updates, so that GitHub counts updates apart, named as the installer", () => {
    const r = parseRelease(githubRelease('2026-11-12.1', { copies: true }))!;
    expect(r.assets.mac).toEqual({
      name: 'Harness-Relay-2026-11-12.1-mac-arm64.dmg',
      url: `${DOWNLOAD}/2026-11-12.1/Harness-Relay-2026-11-12.1-mac-arm64-update.dmg`,
      size: 1000,
      sha256: sha('Harness-Relay-2026-11-12.1-mac-arm64-update.dmg'),
    });
    expect(r.assets.linux?.name).toBe('Harness-Relay-2026-11-12.1-linux-x86_64.AppImage');
    expect(r.assets.linux?.url).toBe(`${DOWNLOAD}/2026-11-12.1/Harness-Relay-2026-11-12.1-linux-x86_64-update.AppImage`);
    expect(Object.values(r.assets).every((a) => a.url.includes('-update.'))).toBe(true);
    // Whatever order GitHub lists them in.
    const reversed = githubRelease('2026-11-12.1', { copies: true });
    reversed.assets.reverse();
    expect(parseRelease(reversed)!.assets.win?.url).toBe(`${DOWNLOAD}/2026-11-12.1/Harness-Relay-2026-11-12.1-win-x64-update.exe`);
    // A release made before there were copies: the installers themselves.
    expect(parseRelease(githubRelease('2026-11-12.1'))!.assets.win?.url).toBe(`${DOWNLOAD}/2026-11-12.1/Harness-Relay-2026-11-12.1-win-x64.exe`);
  });

  it('can be a release candidate, as the app was built for one; never a draft or a tag that is not a version of ours', () => {
    const rc = parseRelease(githubRelease('2026-11-12-rc.1'))!;
    expect(rc).toMatchObject({ version: '2026-11-12-rc.1', semver: '2026.1112.0-rc.1' });
    expect(rc.assets.mac?.name).toBe('Harness-Relay-2026-11-12-rc.1-mac-arm64.dmg');
    expect(parseRelease(githubRelease('2026-11-12.1-rc.2'))).toMatchObject({ version: '2026-11-12.1-rc.2', semver: '2026.1112.1-rc.2' });
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
    // A release candidate of a patch comes after the release before it, and before the patch.
    expect(newestRelease(tags('2026-11-12.1-rc', '2026-11-12', '2026-11-12-rc.1'))?.version).toBe('2026-11-12.1-rc');
    expect(newestRelease(tags('2026-11-12.1-rc', '2026-11-12.1-rc.1', '2026-11-12'))?.version).toBe('2026-11-12.1-rc.1');
    expect(newestRelease(tags('2026-11-12.1', '2026-11-12.1-rc.1', '2026-11-12'))?.version).toBe('2026-11-12.1');
    // Drafts and tags that are not versions of ours are left out.
    expect(newestRelease([githubRelease('2026-11-13-rc', { draft: true }), githubRelease('v9.0.0'), githubRelease('2026-11-12')])?.version).toBe('2026-11-12');
    expect(newestRelease([])).toBeUndefined();
    expect(newestRelease([githubRelease('2026-11-13', { draft: true })])).toBeUndefined();
    expect(newestRelease({ message: 'Not Found' })).toBeUndefined();
    expect(newestRelease(null)).toBeUndefined();
  });

  it('is a release, never a release candidate, for an app that is a release', () => {
    const tags = (...list: string[]) => list.map((tag) => githubRelease(tag));
    expect(newestRelease(tags('2026-11-13-rc', '2026-11-12.1', '2026-11-12'), false)?.version).toBe('2026-11-12.1');
    expect(newestRelease(tags('2026-11-12.1-rc', '2026-11-12', '2026-11-12-rc.1'), false)?.version).toBe('2026-11-12');
    expect(newestRelease(tags('2026-11-13-rc', '2026-11-13-rc.1'), false)).toBeUndefined();
    expect(parseRelease(githubRelease('2026-11-12-rc'))?.candidate).toBe(true);
    expect(parseRelease(githubRelease('2026-11-12.1'))?.candidate).toBe(false);
  });

  it('may be a release candidate for an app that is one, or a build of your own; a release takes releases only', () => {
    expect(takesCandidates('2026.1112.0-rc')).toBe(true);
    expect(takesCandidates('2026.1112.1-rc.2')).toBe(true);
    expect(takesCandidates('2026.1110.0-dev')).toBe(true);
    expect(takesCandidates('2026.1112.0')).toBe(false);
    expect(takesCandidates('2026.1112.3')).toBe(false);
    // A release candidate is offered the release it is a candidate of, and the next one.
    expect(isNewer(newestRelease([githubRelease('2026-11-12'), githubRelease('2026-11-12-rc.1')], true), '2026.1112.0-rc.1')).toBe(true);
    expect(isNewer(newestRelease([githubRelease('2026-11-13-rc'), githubRelease('2026-11-12')], true), '2026.1112.0-rc.1')).toBe(true);
    // A release is not offered the next day's candidate, only the next release.
    expect(isNewer(newestRelease([githubRelease('2026-11-13-rc'), githubRelease('2026-11-12')], false), '2026.1112.0')).toBe(false);
    expect(isNewer(newestRelease([githubRelease('2026-11-13'), githubRelease('2026-11-13-rc')], false), '2026.1112.0')).toBe(true);
  });

  it('leaves out installers elsewhere, with a name that leaves its folder, or a checksum that is not SHA-256', () => {
    const r = githubRelease('2026-11-12');
    r.assets[0]!.browser_download_url = 'https://evil.example/Harness-Relay-2026-11-12-mac-arm64.dmg';
    r.assets[1]!.name = '../../Harness-Relay-2026-11-12-win-x64.exe';
    (r.assets.find((a) => a.name.endsWith('-linux-x86_64.AppImage')) as { digest?: string }).digest = 'md5:abc';
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
    // One of a patch is newer than the release it follows, not than the patch.
    const patchRc = parseRelease(githubRelease('2026-11-12.1-rc'));
    expect(isNewer(patchRc, '2026.1112.0')).toBe(true);
    expect(isNewer(patchRc, '2026.1112.1')).toBe(false);
  });

  it('is asked for at GitHub; none yet is no update, any other failure an error', async () => {
    const asked: string[] = [];
    const answer = (status: number, body: unknown): Fetch =>
      async (url) => {
        asked.push(url);
        return new Response(JSON.stringify(body), { status });
      };
    expect((await checkLatest(answer(200, [githubRelease('2026-11-13-rc'), githubRelease('2026-11-12')])))?.version).toBe('2026-11-13-rc');
    expect(asked[0]).toBe(RELEASES_API);
    expect(RELEASES_API).toBe('https://api.github.com/repos/Agentic-System-Lab/harness-relay/releases?per_page=20');
    expect(await checkLatest(answer(200, []))).toBeUndefined();
    // A question that stalls is given up on (the app passes AbortSignal.timeout(CHECK_TIMEOUT_MS)), so the next check is not held back.
    const stalled: Fetch = (_url, init) =>
      new Promise((_, fail) => init?.signal?.addEventListener('abort', () => fail(init.signal!.reason), { once: true }));
    await expect(checkLatest(stalled, { signal: AbortSignal.timeout(20) })).rejects.toThrow();
    expect(CHECK_TIMEOUT_MS).toBe(30_000);
    expect(await checkLatest(answer(404, { message: 'Not Found' }))).toBeUndefined();
    // A release asks for GitHub's latest release alone: found however many release candidates came out since.
    asked.length = 0;
    expect((await checkLatest(answer(200, githubRelease('2026-11-12.1')), { candidates: false }))?.version).toBe('2026-11-12.1');
    expect(asked).toEqual([LATEST_RELEASE_API]);
    expect(LATEST_RELEASE_API).toBe('https://api.github.com/repos/Agentic-System-Lab/harness-relay/releases/latest');
    // Never a release candidate, should GitHub ever answer with one; none yet is no update.
    expect(await checkLatest(answer(200, githubRelease('2026-11-13-rc')), { candidates: false })).toBeUndefined();
    expect(await checkLatest(answer(404, { message: 'Not Found' }), { candidates: false })).toBeUndefined();
    await expect(checkLatest(answer(403, { message: 'rate limited' }))).rejects.toThrow('403');
  });

  it("has one installer for each system: the Mac app for Apple Silicon (none for Intel), the running app's processor's for Windows and Linux", () => {
    expect(updateSystem('darwin', 'arm64')).toBe('mac');
    expect(updateSystem('darwin', 'x64')).toBeUndefined();
    expect(updateSystem('win32', 'x64')).toBe('win');
    expect(updateSystem('win32', 'arm64')).toBe('win-arm64');
    expect(updateSystem('linux', 'x64')).toBe('linux');
    expect(updateSystem('linux', 'arm64')).toBe('linux-arm64');
    expect(updateSystem('linux', 'arm')).toBeUndefined();
    expect(updateSystem('win32', 'ia32')).toBeUndefined();
    expect(updateSystem('freebsd', 'x64')).toBeUndefined();
  });

  it("reads each processor's installer from a release, and the Arm ones' checksums", () => {
    const release = parseRelease(githubRelease('2026-11-12'))!;
    expect(Object.keys(release.assets).sort()).toEqual(['linux', 'linux-arm64', 'mac', 'win', 'win-arm64']);
    expect(release.assets['win-arm64']).toMatchObject({ name: 'Harness-Relay-2026-11-12-win-arm64.exe', sha256: sha('Harness-Relay-2026-11-12-win-arm64.exe') });
    expect(release.assets['linux-arm64']?.name).toBe('Harness-Relay-2026-11-12-linux-arm64.AppImage');
    expect(release.assets.win?.name).toBe('Harness-Relay-2026-11-12-win-x64.exe');
  });
});

describe('how often GitHub is asked', () => {
  it('once an hour, of the 60 an hour GitHub allows an address without signing in', () => {
    expect(CHECK_EVERY_MS).toBe(60 * 60_000);
  });

  it('asks only for a copy that updates itself, with no update nor check under way, and none asked too recently', () => {
    const now = 10_000_000;
    const ok = { updates: true, updating: false, checking: false, askedAt: undefined, now };
    expect(checkNow(ok)).toBe(true);
    expect(checkNow({ ...ok, updates: false })).toBe(false);
    expect(checkNow({ ...ok, updating: true })).toBe(false);
    expect(checkNow({ ...ok, checking: true })).toBe(false);
    expect(checkNow({ ...ok, askedAt: now - 1000 })).toBe(false);
    expect(checkNow({ ...ok, askedAt: now - MIN_CHECK_GAP_MS })).toBe(true);
  });

  it('at most every five minutes, also when the chat asks again sooner: at most 12 of the 60 an hour', () => {
    const at = 1_000_000;
    expect(mayAskGitHub(undefined, at)).toBe(true);
    expect(mayAskGitHub(at, at + MIN_CHECK_GAP_MS - 1)).toBe(false);
    expect(mayAskGitHub(at, at + MIN_CHECK_GAP_MS)).toBe(true);
    expect(MIN_CHECK_GAP_MS).toBe(5 * 60_000);
    // A clock set back does not stop it for good.
    expect(mayAskGitHub(at, at - 5000)).toBe(true);
  });
});

describe('what the chat is told of updates', () => {
  const release = { version: '2026-11-12', semver: '2026.1112.0', page: 'https://github.com/x/y/releases/tag/2026-11-12', candidate: false, assets: {} };

  it('is nothing more for a copy that does not update itself', () => {
    expect(chatUpdate({ updates: false, update: release, updating: { kind: 'installing' }, checking: true, checkedAt: 1, checkFailed: true })).toEqual({ updates: false });
  });

  it('is the newer version, the update under way in whole percent, a check, when it last answered and whether the last one failed', () => {
    expect(chatUpdate({ updates: true, checking: false, checkFailed: false })).toEqual({ updates: true });
    expect(chatUpdate({ updates: true, update: release, updating: { kind: 'downloading', done: 0.429 }, checking: true, checkedAt: 5, checkFailed: true })).toEqual({
      updates: true,
      available: { version: '2026-11-12', page: release.page },
      progress: { kind: 'downloading', percent: 42 },
      checking: true,
      checkedAt: 5,
      checkFailed: true,
    });
    expect(chatUpdate({ updates: true, updating: { kind: 'waiting' }, checking: false, checkFailed: false }).progress).toEqual({ kind: 'waiting' });
  });
});

describe('an update asked for more than once', () => {
  it('runs once at a time: asked again meanwhile, it does nothing; asked after, it runs again', async () => {
    let runs = 0;
    let finish: () => void = () => {};
    const update = oneAtATime(async () => {
      runs++;
      await new Promise<void>((done) => (finish = done));
    });
    const first = update();
    await update(); // a second click while the first asks: nothing
    expect(runs).toBe(1);
    finish();
    await first;
    const again = update();
    expect(runs).toBe(2);
    finish();
    await again;
  });

  it('can run again after one that failed', async () => {
    let runs = 0;
    const update = oneAtATime(async () => {
      runs++;
      throw new Error('download');
    });
    await expect(update()).rejects.toThrow('download');
    await expect(update()).rejects.toThrow('download');
    expect(runs).toBe(2);
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

  it('gives up on a download that goes without a byte for a while, keeping nothing, so the next update can start', async () => {
    const to = join(dir, 'stalled.dmg');
    // A connection that dropped: a first part comes, then nothing more (as fetch does, it stops when aborted).
    const stalls: Fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(body.subarray(0, 100)));
            init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
          },
        }),
        { headers: { 'content-length': String(body.length) } },
      );
    const err = (await download({ fetch: stalls, asset, to, stallMs: 50 }).catch((e: unknown) => e)) as UpdateError;
    expect(err).toBeInstanceOf(UpdateError);
    expect(err.failure).toBe('download');
    expect(err.message).toMatch(/no data/);
    expect(existsSync(`${to}.part`)).toBe(false);
    // Also when no answer comes at all.
    const silent: Fetch = (_url, init) => new Promise((_, fail) => init?.signal?.addEventListener('abort', () => fail(init.signal!.reason), { once: true }));
    const none = (await download({ fetch: silent, asset, to, stallMs: 50 }).catch((e: unknown) => e)) as UpdateError;
    expect(none.message).toMatch(/no data/);
    expect(DOWNLOAD_STALL_MS).toBe(60_000);
  });

  it('keeps going as long as bytes keep coming, however long it takes', async () => {
    const to = join(dir, 'slow.dmg');
    const slow: Fetch = async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            for (let at = 0; at < body.length; at += 4000) {
              await new Promise((r) => setTimeout(r, 20));
              controller.enqueue(new Uint8Array(body.subarray(at, at + 4000)));
            }
            controller.close();
          },
        }),
      );
    await download({ fetch: slow, asset, to, stallMs: 60 });
    expect(readFileSync(to)).toEqual(body);
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

describe('waiting for the conversations', () => {
  /** A server that answers with the next number of `answers` (the last one again once they run out). */
  function server(answers: (number | undefined)[]) {
    let asked = 0;
    return {
      get asked() {
        return asked;
      },
      busy: async () => answers[Math.min(asked++, answers.length - 1)],
    };
  }
  const never = new Promise<void>(() => {});

  it('switches at once when no conversation has agents at work', async () => {
    const s = server([0]);
    const waiting: (number | undefined)[] = [];
    expect(await whenIdle({ busy: s.busy, now: never, everyMs: 1, onWaiting: (n) => waiting.push(n) })).toBe('idle');
    expect(s.asked).toBe(1);
    expect(waiting).toEqual([]);
  });

  it('asks again until none has, saying how many have meanwhile, and asks again when the server does not answer', async () => {
    const s = server([2, 1, undefined, 1, 0]);
    const waiting: (number | undefined)[] = [];
    expect(await whenIdle({ busy: s.busy, now: never, everyMs: 1, onWaiting: (n) => waiting.push(n) })).toBe('idle');
    expect(waiting).toEqual([2, 1, undefined, 1]);
    expect(s.asked).toBe(5);
  });

  it('waits between questions', async () => {
    const s = server([1, 0]);
    const started = Date.now();
    expect(await whenIdle({ busy: s.busy, now: never, everyMs: 60 })).toBe('idle');
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('asks the server while it runs; switches once it stopped by itself; never while it starts or stops, nor once the app quits', () => {
    const at = (server: 'stopped' | 'starting' | 'running' | 'stopping', o: { starting?: boolean; quitting?: boolean } = {}) =>
      busyWithoutAsking(server, { starting: o.starting ?? false, quitting: o.quitting ?? false });
    expect(at('running')).toBe('ask');
    expect(at('stopped')).toBe(0); // a crash: nothing runs
    // A restart from the menu, or a server on its way down: wait on.
    expect(at('stopping')).toBeUndefined();
    expect(at('starting')).toBeUndefined();
    expect(at('stopped', { starting: true })).toBeUndefined(); // the app reads the shell's environment before it starts the server
    // Quitting (also as the system shuts down) never switches, whatever the server does.
    for (const server of ['running', 'stopped', 'starting', 'stopping'] as const) expect(at(server, { quitting: true }), server).toBeUndefined();
  });

  it('does not switch while the number is unknown, however long that lasts', async () => {
    let settled = false;
    let asked = 0;
    let switchNow!: () => void;
    const waiting = whenIdle({
      busy: async () => (asked++, undefined),
      now: new Promise<void>((r) => (switchNow = r)),
      everyMs: 1,
    }).then((how) => ((settled = true), how));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(asked).toBeGreaterThan(5);
    switchNow();
    expect(await waiting).toBe('now');
  });

  it('switches at once when the user chooses to, while waiting or while the server is being asked', async () => {
    let switchNow!: () => void;
    const now = new Promise<void>((r) => (switchNow = r));
    const s = server([3]);
    const waiting = whenIdle({ busy: s.busy, now, everyMs: 60_000, onWaiting: () => switchNow() });
    expect(await waiting).toBe('now');

    let go!: () => void;
    const asked = new Promise<void>((r) => (go = r));
    const slow = whenIdle({ busy: () => new Promise<number>(() => {}), now: asked, everyMs: 1 });
    go();
    expect(await slow).toBe('now');
  });
});

describe('what an update leaves next to the AppImage', () => {
  it('downloads the new AppImage hidden next to the running one', () => {
    expect(appImageDownload('/home/me/Apps/Harness-Relay-2026-11-10-linux-arm64.AppImage', 'Harness-Relay-2026-11-12-linux-arm64.AppImage')).toBe(
      '/home/me/Apps/.Harness-Relay-2026-11-12-linux-arm64.AppImage.download',
    );
  });

  it('removes a download never put in place, and its part, but nothing else', () => {
    const apps = join(dir, 'leftovers');
    mkdirSync(apps);
    const running = join(apps, 'Harness-Relay-2026-11-10-linux-x86_64.AppImage');
    const kept = [running, join(apps, 'notes.download'), join(apps, '.other.AppImage.download'), join(apps, 'Harness-Relay-2026-11-12-linux-x86_64.AppImage')];
    const left = [
      appImageDownload(running, 'Harness-Relay-2026-11-12-linux-x86_64.AppImage'),
      `${appImageDownload(running, 'Harness-Relay-2026-11-13-rc-linux-x86_64.AppImage')}.part`,
    ];
    for (const f of [...kept, ...left]) writeFileSync(f, 'x');
    removeAppImageLeftovers(running);
    for (const f of kept) expect(existsSync(f), f).toBe(true);
    for (const f of left) expect(existsSync(f), f).toBe(false);
  });
});

describe('starting the new version', () => {
  it('opens the Mac app, or runs the AppImage with its arguments, with the pid and the path in the environment only', () => {
    const mac = relaunchCommand('darwin', 42, '/Applications/Harness Relay.app', { PATH: '/bin' });
    expect(mac.bin).toBe('/bin/sh');
    expect(mac.args).toEqual(['-c', expect.stringContaining('exec /usr/bin/open "$target"'), 'sh']);
    expect(mac.env).toEqual({ PATH: '/bin', [RELAUNCH_PID]: '42', [RELAUNCH_TARGET]: '/Applications/Harness Relay.app' });
    const linux = relaunchCommand('linux', 42, '/home/me/H.AppImage', { PATH: '/bin' }, ['--no-sandbox']);
    expect(linux.args).toEqual(['-c', expect.stringContaining('exec "$target" "$@"'), 'sh', '--no-sandbox']);
    expect(linux.env).toEqual({ PATH: '/bin', [RELAUNCH_PID]: '42', [RELAUNCH_TARGET]: '/home/me/H.AppImage' });
    // The script is fixed text, whatever the path.
    expect(relaunchCommand('linux', 7, `/home/me/'$(id)'.AppImage`, {}).args).toEqual(['-c', linux.args[1], 'sh']);
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
      const start = relaunchCommand('linux', app.pid!, '/bin/sh', { ...process.env, MARKER: marker }, ['-c', 'date +%s%N > "$MARKER"']);
      await spawnDetached(start.bin, start.args, start.env);
      await new Promise((r) => setTimeout(r, 200));
      expect(existsSync(marker)).toBe(false); // the app still runs
      await exited;
      for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(marker)).toBe(true);
    },
    20_000,
  );

  posixIt(
    'starts a new version whose path has spaces, quotes and $(…) in it as it is, without the variables that pointed to it',
    async () => {
      const out = join(dir, 'relaunched');
      // Were the path read as shell code, it would make this file and fail to start the new version.
      const folder = join(dir, `new "version" 'here' $(touch $OUT.code)`);
      mkdirSync(folder);
      const target = join(folder, 'H.AppImage');
      writeFileSync(target, '#!/bin/sh\n{ env; printf \'arg=%s\\n\' "$@"; } > "$OUT.part" && mv "$OUT.part" "$OUT"\n');
      chmodSync(target, 0o755);
      const gone = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' });
      await new Promise((r) => gone.on('exit', r));
      const start = relaunchCommand('linux', gone.pid!, target, { ...process.env, OUT: out }, ['--no-sandbox', 'two words']);
      await spawnDetached(start.bin, start.args, start.env);
      for (let i = 0; i < 50 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
      const seen = readFileSync(out, 'utf8');
      expect(seen).toContain('arg=--no-sandbox\narg=two words\n');
      expect(seen).not.toContain(RELAUNCH_PID);
      expect(seen).not.toContain(RELAUNCH_TARGET);
      expect(existsSync(`${out}.code`)).toBe(false);
    },
    20_000,
  );
});
