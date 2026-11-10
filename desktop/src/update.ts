/**
 * Updating the desktop app to GitHub's newest release, from its menu. The app asks GitHub now and then
 * for the latest release (`checkLatest`: never a release candidate or a draft); when it is newer than
 * the running app and has an installer for this system, the menu offers it. Choosing it downloads the
 * installer, checks it against the SHA-256 GitHub publishes for it (`download`), and puts it in place
 * of the running app, which then quits and the new one starts:
 *
 * - macOS: the app in the .dmg is copied next to the running one and checked (signature, bundle id,
 *   version), then the two are swapped (`stageMacApp`, `swapMacApp`). The folder must be one the app
 *   may write in (/Applications for an administrator), and the app not run from the .dmg itself.
 * - Windows: the installer runs silently once the app has quit (`WINDOWS_INSTALLER_ARGS`) and starts
 *   the new version; it installs for the user, like the first time, so it needs no administrator.
 * - Linux: the new AppImage takes the place of the running one (`appImageTarget`).
 *
 * Any other copy (one not packaged, run from somewhere it cannot be replaced, an installer GitHub
 * gives no checksum for) gets the release's page instead (`installPlan`). Nothing here imports
 * Electron: main.ts passes in what it needs (net.fetch, the paths).
 */
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, createWriteStream, existsSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { compareSemver, parseVersion, semverOf } from '../../scripts/release';
import { INSTALLERS, isInstallerUrl, RELEASES_PAGE, REPO } from '../../site/assets/downloads.js';
import { capture } from '../../src/server/process';

/** GitHub's latest release: the newest that is neither a pre-release (release candidate) nor a draft. */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** How often the app asks (GitHub allows 60 requests an hour without signing in, per address). */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;

/** The first check, a while after the app started (not in the way of the server's start). */
export const FIRST_CHECK_MS = 30_000;

export type UpdateSystem = keyof typeof INSTALLERS;

export interface UpdateAsset {
  /** The file's name, such as Harness-Relay-2026-11-12-mac-universal.dmg. */
  name: string;
  url: string;
  size?: number;
  /** Lowercase hex, from GitHub's `digest` of the asset. */
  sha256?: string;
}

export interface UpdateRelease {
  /** As released (the tag), such as 2026-11-12.1. */
  version: string;
  /** The app version it was built as (scripts/release.ts, `semverOf`). */
  semver: string;
  /** Its page on GitHub (the release notes and every installer). */
  page: string;
  assets: Partial<Record<UpdateSystem, UpdateAsset>>;
}

/** A file name that stays in the folder it is put in. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** GitHub's answer for the latest release, when it is a release of ours (not a release candidate). */
export function parseLatestRelease(json: unknown): UpdateRelease | undefined {
  const r = json as {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    html_url?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }[];
  } | null;
  if (!r || typeof r !== 'object' || r.draft || r.prerelease || typeof r.tag_name !== 'string') return undefined;
  const parsed = parseVersion(r.tag_name);
  if (!parsed.ok || parsed.value.rc) return undefined;
  const assets: UpdateRelease['assets'] = {};
  for (const a of Array.isArray(r.assets) ? r.assets : []) {
    if (typeof a?.name !== 'string' || !PLAIN_NAME.test(a.name) || !isInstallerUrl(a.browser_download_url)) continue;
    for (const [system, end] of Object.entries(INSTALLERS) as [UpdateSystem, string][]) {
      if (!a.name.endsWith(end)) continue;
      const sha256 = typeof a.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest)?.[1]?.toLowerCase() : undefined;
      assets[system] = { name: a.name, url: a.browser_download_url as string, size: typeof a.size === 'number' ? a.size : undefined, sha256 };
    }
  }
  const page = typeof r.html_url === 'string' && r.html_url.startsWith(`${RELEASES_PAGE}/tag/`) ? r.html_url : RELEASES_PAGE;
  return { version: parsed.value.version, semver: semverOf(parsed.value), page, assets };
}

/** Whether `latest` is newer than the running app, whose version is `current` (semver, app.getVersion()). */
export function isNewer(latest: UpdateRelease | undefined, current: string): latest is UpdateRelease {
  return !!latest && compareSemver(latest.semver, current) > 0;
}

/** Which installer updates this system: one Mac app for both processors; x64 for Windows and Linux. */
export function updateSystem(platform: NodeJS.Platform, arch: string): UpdateSystem | undefined {
  if (platform === 'darwin') return 'mac';
  // Windows on Arm runs the x64 app (emulated), so it reports x64 itself.
  if (platform === 'win32') return arch === 'x64' ? 'win' : undefined;
  if (platform === 'linux') return arch === 'x64' ? 'linux' : undefined;
  return undefined;
}

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** Asks GitHub for the latest release; undefined when there is none yet (or it is not one of ours). */
export async function checkLatest(fetch: Fetch, signal?: AbortSignal): Promise<UpdateRelease | undefined> {
  const res = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal,
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return parseLatestRelease(await res.json());
}

export type ManualReason =
  /** Run from the source (npm run desktop). */
  | 'not-packaged'
  /** The release has no installer for this system. */
  | 'no-installer'
  /** GitHub gave no checksum to check the download against. */
  | 'no-checksum'
  /** Where the app is, it cannot be replaced: the .dmg, a translocated copy, a folder it may not write in. */
  | 'read-only'
  /** On Linux, only an AppImage replaces itself. */
  | 'not-appimage';

export type InstallPlan =
  | { kind: 'mac'; app: string }
  | { kind: 'win' }
  | { kind: 'linux'; appImage: string }
  | { kind: 'manual'; why: ManualReason };

/** The .app an executable is in (…/Harness Relay.app/Contents/MacOS/Harness Relay). */
export function macAppOf(execPath: string): string | undefined {
  return /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1];
}

export function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** How this copy of the app can take `asset` (the release's installer for this system). */
export function installPlan(o: {
  platform: NodeJS.Platform;
  packaged: boolean;
  execPath: string;
  /** $APPIMAGE: the AppImage file the app runs from, on Linux. */
  appImage?: string;
  asset?: UpdateAsset;
  writable?: (dir: string) => boolean;
}): InstallPlan {
  const canWrite = o.writable ?? writable;
  const manual = (why: ManualReason): InstallPlan => ({ kind: 'manual', why });
  if (!o.packaged) return manual('not-packaged');
  if (!o.asset) return manual('no-installer');
  if (!o.asset.sha256) return manual('no-checksum');
  if (o.platform === 'darwin') {
    const app = macAppOf(o.execPath);
    // A disk image is read-only; a translocated copy (opened from Downloads, say) is a random read-only path.
    if (!app || app.startsWith('/Volumes/') || app.includes('/AppTranslocation/') || !canWrite(dirname(app))) return manual('read-only');
    return { kind: 'mac', app };
  }
  if (o.platform === 'win32') return { kind: 'win' };
  if (o.platform === 'linux') {
    if (!o.appImage) return manual('not-appimage');
    if (!canWrite(dirname(o.appImage))) return manual('read-only');
    return { kind: 'linux', appImage: o.appImage };
  }
  return manual('no-installer');
}

export type UpdateFailure = 'download' | 'checksum' | 'unpack' | 'verify' | 'replace' | 'start';

/** An update that went wrong, with what went wrong (main.ts says it in the user's language) and the details. */
export class UpdateError extends Error {
  constructor(
    readonly failure: UpdateFailure,
    detail: string,
  ) {
    super(detail);
  }
}

/**
 * Downloads `asset` to `to` (through `to`.part, so a broken download never looks like a whole one),
 * checking it against its SHA-256 on the way. `onProgress` gets the share done, from 0 to 1.
 */
export async function download(o: { fetch: Fetch; asset: UpdateAsset; to: string; onProgress?: (done: number) => void; signal?: AbortSignal }): Promise<void> {
  if (!o.asset.sha256) throw new UpdateError('checksum', 'no checksum');
  const part = `${o.to}.part`;
  rmSync(part, { force: true });
  let res: Response;
  try {
    res = await o.fetch(o.asset.url, { signal: o.signal });
  } catch (err) {
    throw new UpdateError('download', (err as Error).message);
  }
  if (!res.ok || !res.body) throw new UpdateError('download', `HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || o.asset.size || 0;
  const hash = createHash('sha256');
  let received = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, next) {
      hash.update(chunk);
      received += chunk.length;
      if (total) o.onProgress?.(Math.min(1, received / total));
      next(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), count, createWriteStream(part));
  } catch (err) {
    rmSync(part, { force: true });
    throw new UpdateError('download', (err as Error).message);
  }
  const got = hash.digest('hex');
  if (got !== o.asset.sha256) {
    rmSync(part, { force: true });
    throw new UpdateError('checksum', `expected ${o.asset.sha256}, got ${got}`);
  }
  renameSync(part, o.to);
}

// --- macOS ----------------------------------------------------------------------------------

/** The new app, copied next to the running one (`.<name>.update`), and the old one after the swap (`.<name>.old`). */
export function macStaging(app: string): { staged: string; old: string } {
  return { staged: join(dirname(app), `.${basename(app)}.update`), old: join(dirname(app), `.${basename(app)}.old`) };
}

/**
 * Copies the app out of the downloaded .dmg next to the running one (same volume: the swap is two
 * renames), and checks it: its signature holds, and it is this app (`bundleId`) at the release's
 * version (`semver`). Returns where it is.
 */
export async function stageMacApp(o: { dmg: string; app: string; bundleId: string; semver: string; env: NodeJS.ProcessEnv }): Promise<string> {
  const { staged } = macStaging(o.app);
  rmSync(staged, { recursive: true, force: true });
  const mount = mkdtempSync(join(tmpdir(), 'harness-relay-update-'));
  const attach = await capture('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, o.dmg], o.env, { timeoutMs: 120_000 });
  if (attach.code !== 0) {
    try {
      rmdirSync(mount);
    } catch {
      /* left in the temporary folder */
    }
    throw new UpdateError('unpack', attach.stderr.trim() || `hdiutil attach: exit code ${attach.code}`);
  }
  try {
    const apps = readdirSync(mount).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1) throw new UpdateError('unpack', `expected one app in the disk image, found ${apps.length}`);
    // ditto keeps what codesign checks (extended attributes, links, permissions).
    const copy = await capture('/usr/bin/ditto', [join(mount, apps[0]!), staged], o.env, { timeoutMs: 300_000 });
    if (copy.code !== 0) throw new UpdateError('unpack', copy.stderr.trim() || `ditto: exit code ${copy.code}`);
  } finally {
    await capture('/usr/bin/hdiutil', ['detach', '-force', mount], o.env, { timeoutMs: 60_000 }).catch(() => undefined);
    try {
      rmdirSync(mount); // only once it is empty: never anything of the disk image
    } catch {
      /* left in the temporary folder */
    }
  }
  try {
    const signature = await capture('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], o.env, { timeoutMs: 120_000 });
    if (signature.code !== 0) throw new UpdateError('verify', signature.stderr.trim() || 'codesign --verify failed');
    const plist = join(staged, 'Contents', 'Info.plist');
    const read = async (key: string) => (await capture('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], o.env, { timeoutMs: 10_000 })).stdout.trim();
    const id = await read('CFBundleIdentifier');
    if (id !== o.bundleId) throw new UpdateError('verify', `bundle id ${id}, expected ${o.bundleId}`);
    const version = await read('CFBundleShortVersionString');
    if (version !== o.semver) throw new UpdateError('verify', `version ${version}, expected ${o.semver}`);
  } catch (err) {
    rmSync(staged, { recursive: true, force: true });
    throw err;
  }
  return staged;
}

/**
 * Puts the staged app in place of the running one: the running one moves aside (`.<name>.old`, removed
 * at the next start), the new one takes its name. When the second step fails, the first is undone.
 */
export function swapMacApp(app: string): void {
  const { staged, old } = macStaging(app);
  rmSync(old, { recursive: true, force: true });
  try {
    renameSync(app, old);
  } catch (err) {
    throw new UpdateError('replace', (err as Error).message);
  }
  try {
    renameSync(staged, app);
  } catch (err) {
    renameSync(old, app);
    throw new UpdateError('replace', (err as Error).message);
  }
}

/** What an update leaves next to the app (the old app, or a staged one never used): removed at start. */
export function removeMacLeftovers(app: string): void {
  const { staged, old } = macStaging(app);
  for (const path of [staged, old]) if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

// --- Windows --------------------------------------------------------------------------------

/**
 * The installer's arguments for an update (electron-builder's NSIS installer): silent, as an update,
 * and starting the app when it is done.
 */
export const WINDOWS_INSTALLER_ARGS = ['--updated', '/S', '--force-run'];

// --- Linux ----------------------------------------------------------------------------------

/**
 * Where the new AppImage goes: under its own name when the running one is named after its version
 * (as downloaded: Harness-Relay-2026-11-10-linux-x86_64.AppImage), the old one then removed;
 * otherwise in place of the running one, under the name the user gave it (and a launcher may use).
 */
export function appImageTarget(current: string, assetName: string, currentVersion: string): string {
  return basename(current).includes(currentVersion) ? join(dirname(current), assetName) : current;
}

/** Puts a downloaded AppImage at `target`, runnable, and removes the running one when it was renamed. */
export function placeAppImage(downloaded: string, target: string, current: string): void {
  try {
    chmodSync(downloaded, 0o755);
    // Over the running file too: the running app keeps the file it opened.
    renameSync(downloaded, target);
    if (target !== current) rmSync(current, { force: true });
  } catch (err) {
    rmSync(downloaded, { force: true });
    throw new UpdateError('replace', (err as Error).message);
  }
}

// --- Starting the new version ---------------------------------------------------------------

/**
 * The command that waits for this app (`pid`) to exit, then starts the new one: on macOS `open` the
 * app (so it starts as if opened from the Finder), on Linux the AppImage with `args` (`--no-sandbox`,
 * say). It cannot start before: the running app holds the single-instance lock until it exits.
 */
export function relaunchCommand(platform: NodeJS.Platform, pid: number, target: string, args: readonly string[] = []): [string, string[]] {
  const wait = 'i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done; shift;';
  if (platform === 'darwin') return ['/bin/sh', ['-c', `${wait} exec /usr/bin/open "$1"`, 'sh', String(pid), target]];
  return ['/bin/sh', ['-c', `${wait} exec "$@"`, 'sh', String(pid), target, ...args]];
}

/** The environment for the new AppImage: without the variables the running one's runtime set for itself. */
export function relaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete out[k];
  return out;
}
