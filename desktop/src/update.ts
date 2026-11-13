/**
 * Updating the desktop app to GitHub's newest release, from its menu. The app asks GitHub now and then
 * for its releases and takes the newest version (`checkLatest`, never a draft): a release candidate
 * too when the app is one (or a build of your own), only a release when it is a release
 * (`takesCandidates`); when it is newer than the running app and has an installer for this system (`updateSystem`:
 * its processor's on Windows and Linux), the menu offers it. Choosing it downloads the installer (its
 * copy for updates, `-update`, from the releases of a repository of their own, so that GitHub counts
 * updates apart from new installs and the release page lists the installers alone: UPDATES_REPO unless
 * the app was built with another, and for a private one with the token it was built with, which goes to
 * GitHub's API alone, `UpdateSource` in updateSource.ts and `copyToDownload`; the installer itself where
 * that copy cannot be had), checks it against the SHA-256 GitHub publishes for the installer
 * (`download`), waits until no conversation has
 * agents at work (`whenIdle`), and puts it in place of the running app, which then quits and the new
 * one starts:
 *
 * - macOS: the app in the .dmg is copied next to the running one and checked (signature, bundle id,
 *   version) before the wait, then the two are swapped (`stageMacApp`, `swapMacApp`). The folder must
 *   be one the app may write in (/Applications for an administrator), and the app not run from the
 *   .dmg itself.
 * - Windows: the installer runs silently once the app has quit (`WINDOWS_INSTALLER_ARGS`) and starts
 *   the new version; it installs for the user, like the first time, so it needs no administrator.
 * - Linux: the new AppImage, downloaded next to the running one (`appImageDownload`), takes its place
 *   (`appImageTarget`).
 *
 * The running app is left as it is until the wait is over, so quitting meanwhile keeps this version;
 * what the update left behind is removed at the next start.
 *
 * Any other copy (one not packaged, run from somewhere it cannot be replaced, an installer GitHub
 * gives no checksum for) gets the release's page instead (`installPlan`). Nothing here imports
 * Electron: main.ts passes in what it needs (net.fetch, the paths).
 */
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, createReadStream, existsSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { compareSemver, parseVersion, semverOf } from '../../scripts/release';
import { INSTALLERS, isInstallerUrl, RELEASES_PAGE, REPO, updateCopyName, updateCopyUrl } from '../../site/assets/downloads.js';
import { capture } from '../../src/server/process';
import type { DesktopUpdate, UpdateProgress } from '../../src/shared/types';
import type { UpdateSource } from './updateSource';

/**
 * GitHub's releases, newest first: release candidates included, which `releases/latest` leaves out
 * (as the website's download buttons do, site/assets/downloads.js).
 */
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=20`;

/**
 * GitHub's newest release, never a release candidate (the Release workflow marks each release the
 * latest, and no release candidate): what an app that is a release asks for, however many release
 * candidates came out since.
 */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** What a question to GitHub's API asks for: JSON, of the REST API's version the app was written for. */
const API_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

/**
 * How often the app asks: one request an hour, of the 60 an hour GitHub allows each address without
 * signing in (shared by everything on that address: many apps behind one office network could use them
 * up, and a check that fails only waits for the next one). A check never sends the token of a private
 * copies' repository: that goes only with an update (`copyToDownload`).
 */
export const CHECK_EVERY_MS = 60 * 60_000;

/** The first check, a while after the app started (not in the way of the server's start). */
export const FIRST_CHECK_MS = 30_000;

/**
 * The least time between two questions to GitHub: a check asked for sooner (Settings' "Check again")
 * gives what is known. Five minutes: however often it is pressed, at most 12 of GitHub's 60 an hour.
 */
export const MIN_CHECK_GAP_MS = 5 * 60_000;

/** How long one question to GitHub may take: a stalled one (the computer slept, a captive portal) would hold back every check after it. */
export const CHECK_TIMEOUT_MS = 30_000;

/**
 * Whether a check asks GitHub now: for a copy that updates itself, with no update nor check under way,
 * and none asked too recently (`mayAskGitHub`). Otherwise the chat is told what is known.
 */
export function checkNow(o: { updates: boolean; updating: boolean; checking: boolean; askedAt?: number; now: number }): boolean {
  return o.updates && !o.updating && !o.checking && mayAskGitHub(o.askedAt, o.now);
}

/** Whether a check may ask GitHub now, the last question having been asked at `askedAt` (none yet: undefined). */
export function mayAskGitHub(askedAt: number | undefined, now: number): boolean {
  return askedAt === undefined || now - askedAt >= MIN_CHECK_GAP_MS || now < askedAt;
}

export type UpdateSystem = keyof typeof INSTALLERS;

/** An update under way, as the app keeps it: downloading (`done`, 0 to 1), being checked and put in place, or waiting for the conversations. */
export type Updating = { kind: 'downloading'; done: number } | { kind: 'installing' } | { kind: 'waiting' };

/**
 * What the chat shows of updates (the server passes it on, src/server/updates.ts), from what the app
 * knows: nothing but `updates: false` for a copy that does not update itself.
 */
export function chatUpdate(o: {
  updates: boolean;
  update?: UpdateRelease;
  updating?: Updating;
  checking: boolean;
  checkedAt?: number;
  checkFailed: boolean;
}): DesktopUpdate {
  if (!o.updates) return { updates: false };
  const u = o.updating;
  const progress: UpdateProgress | undefined = u?.kind === 'downloading' ? { kind: 'downloading', percent: Math.floor(u.done * 100) } : u;
  return {
    updates: true,
    ...(o.update ? { available: { version: o.update.version, page: o.update.page } } : {}),
    ...(progress ? { progress } : {}),
    ...(o.checking ? { checking: true } : {}),
    ...(o.checkedAt !== undefined ? { checkedAt: o.checkedAt } : {}),
    ...(o.checkFailed ? { checkFailed: true } : {}),
  };
}

/**
 * The chat's checks the app owes an answer to, by id: answered by the first state it tells the server
 * once no check is under way (`take`), so a state already on its way when one was asked for never
 * answers it, and one asked during a check is answered when that check ends.
 */
export class CheckAnswers {
  private owed: number[] = [];

  ask(id: number): void {
    this.owed.push(id);
  }

  /** The checks a state answers, no longer owed: none while a check is under way. */
  take(checking: boolean): number[] | undefined {
    if (checking || !this.owed.length) return undefined;
    return this.owed.splice(0);
  }
}

/**
 * `fn`, the calls made while an earlier one still runs ignored: an update asked for twice (two clicks,
 * the menu and the chat) asks once, and never runs two downloads or swaps at once.
 */
export function oneAtATime(fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}

export interface UpdateAsset {
  /**
   * The installer's name, such as Harness-Relay-2026-11-12-mac-arm64.dmg (also when it is fetched from
   * its copy for updates: the AppImage takes this name).
   */
  name: string;
  /**
   * Where it is fetched from: its copy for the app's updates (`-update`, `updateCopyUrl`) on github.com,
   * or on GitHub's API for a private copies' repository (`copyToDownload`); else the installer itself.
   */
  url: string;
  /**
   * The installer itself, fetched when its copy cannot be had: not there (404; a release published before
   * the copies, say), or, asked with the token, not given (401, 403: expired, revoked).
   */
  fallback?: string;
  size?: number;
  /** Lowercase hex, from GitHub's `digest` of the installer (its copy is the same file). */
  sha256?: string;
}

export interface UpdateRelease {
  /** As released (the tag), such as 2026-11-12.1. */
  version: string;
  /** The app version it was built as (scripts/release.ts, `semverOf`). */
  semver: string;
  /** Its page on GitHub (the release notes and every installer). */
  page: string;
  /** A release candidate (`-rc`): offered only to an app that is one, or a build of your own (`takesCandidates`). */
  candidate: boolean;
  assets: Partial<Record<UpdateSystem, UpdateAsset>>;
}

/** A file name that stays in the folder it is put in. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * One release in GitHub's answer, when it is a release of ours (a release candidate too, never a draft),
 * each installer fetched from its copy in the copies' repository of `source`.
 */
export function parseRelease(json: unknown, source: UpdateSource): UpdateRelease | undefined {
  const r = json as {
    tag_name?: unknown;
    draft?: unknown;
    html_url?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }[];
  } | null;
  if (!r || typeof r !== 'object' || r.draft || typeof r.tag_name !== 'string') return undefined;
  const parsed = parseVersion(r.tag_name);
  if (!parsed.ok) return undefined;
  // Each system's installer, fetched from its copy for updates (`updateCopyUrl`: the same file, in the
  // releases of a repository of its own), so that GitHub counts updates apart from new installs; the
  // installer itself where that copy is not there. Copies in the release itself (2026-11-12-rc) are not
  // read: they end as no installer does.
  const assets: UpdateRelease['assets'] = {};
  for (const a of Array.isArray(r.assets) ? r.assets : []) {
    if (typeof a?.name !== 'string' || !PLAIN_NAME.test(a.name) || !isInstallerUrl(a.browser_download_url)) continue;
    for (const [system, end] of Object.entries(INSTALLERS) as [UpdateSystem, string][]) {
      if (!a.name.endsWith(end)) continue;
      const installer = a.browser_download_url as string;
      const copy = updateCopyUrl(r.tag_name, a.name, source.repo);
      const sha256 = typeof a.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest)?.[1]?.toLowerCase() : undefined;
      assets[system] = { name: a.name, ...(copy ? { url: copy, fallback: installer } : { url: installer }), size: typeof a.size === 'number' ? a.size : undefined, sha256 };
    }
  }
  const page = typeof r.html_url === 'string' && r.html_url.startsWith(`${RELEASES_PAGE}/tag/`) ? r.html_url : RELEASES_PAGE;
  return { version: parsed.value.version, semver: semverOf(parsed.value), page, candidate: parsed.value.rc, assets };
}

/**
 * The newest release of ours in GitHub's list, by version, not by when it was published. With
 * `candidates`, a release candidate when it is the newest (2026-11-12-rc after 2026-11-11.1,
 * 2026-11-12.1-rc after 2026-11-12), never one that sorts before the release it is a candidate of
 * (2026-11-12-rc.1 before 2026-11-12); without, releases and their patches only.
 */
export function newestRelease(json: unknown, source: UpdateSource, candidates = true): UpdateRelease | undefined {
  if (!Array.isArray(json)) return undefined;
  let newest: UpdateRelease | undefined;
  for (const r of json) {
    const release = parseRelease(r, source);
    if (!release || (release.candidate && !candidates)) continue;
    if (!newest || compareSemver(release.semver, newest.semver) > 0) newest = release;
  }
  return newest;
}

/**
 * Whether an app of version `current` (semver, app.getVersion()) is offered release candidates: one
 * that is a release candidate (`-rc`), or a build of your own (`-dev`), is offered the newer release
 * candidates and releases; a release, only the releases after it (and their patches).
 */
export function takesCandidates(current: string): boolean {
  return current.split('+')[0]!.includes('-');
}

/** Whether `latest` is newer than the running app, whose version is `current` (semver, app.getVersion()). */
export function isNewer(latest: UpdateRelease | undefined, current: string): latest is UpdateRelease {
  return !!latest && compareSemver(latest.semver, current) > 0;
}

/**
 * Which installer updates this system: the Mac app for Apple Silicon (there is none for Intel Macs);
 * on Windows and Linux, the one for the processor the running app was built for (`process.arch`). An
 * x64 app on Windows on Arm runs emulated and reports x64 itself, so it stays the x64 app.
 */
export function updateSystem(platform: NodeJS.Platform, arch: string): UpdateSystem | undefined {
  if (platform === 'darwin') return arch === 'arm64' ? 'mac' : undefined;
  if (platform === 'win32') return arch === 'x64' ? 'win' : arch === 'arm64' ? 'win-arm64' : undefined;
  if (platform === 'linux') return arch === 'x64' ? 'linux' : arch === 'arm64' ? 'linux-arm64' : undefined;
  return undefined;
}

export type Fetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' | 'error' | 'manual' },
) => Promise<Response>;

/**
 * Asks GitHub for the newest release, release candidates included; undefined when there is none yet.
 * Each installer is fetched from its copy in the copies' repository of `source` (never asked here).
 */
export async function checkLatest(fetch: Fetch, o: { source: UpdateSource; candidates?: boolean; signal?: AbortSignal }): Promise<UpdateRelease | undefined> {
  const { source, candidates = true, signal } = o;
  // A release candidate (or a build of your own) looks through the newest releases, candidates too; a
  // release asks for the newest release alone.
  const res = await fetch(candidates ? RELEASES_API : LATEST_RELEASE_API, { headers: API_HEADERS, signal });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const json: unknown = await res.json();
  if (candidates) return newestRelease(json, source, true);
  const latest = parseRelease(json, source);
  return latest && !latest.candidate ? latest : undefined;
}

/**
 * What a download sends with its first request, to a copy's address on GitHub's API (a private copies'
 * repository, `copyToDownload`): the token, asking for the file itself. None for a public repository,
 * whose copies are downloaded from github.com without signing in.
 */
export function downloadHeaders(source: UpdateSource): Record<string, string> | undefined {
  if (!source.token) return undefined;
  return { ...API_HEADERS, Accept: 'application/octet-stream', Authorization: `Bearer ${source.token}` };
}

/**
 * Where `asset` (of the release tagged `tag`) is downloaded from, with the headers its first request
 * takes. A public copies' repository: as `parseRelease` found it, with none. A private one (a token):
 * the release under that tag there is asked for with the token on GitHub's API, and the copy is
 * downloaded from its address there, by its id (`/releases/assets/<id>`), with `downloadHeaders`,
 * and the installer itself as its `fallback`; when the copy cannot be had (the release or the file is
 * not there, the token expired or was revoked, GitHub cannot be reached), the installer itself, with
 * none, so a token gone bad keeps no one from updating. Never fails.
 */
export async function copyToDownload(
  fetch: Fetch,
  source: UpdateSource,
  tag: string,
  asset: UpdateAsset,
  signal?: AbortSignal,
): Promise<{ asset: UpdateAsset; headers?: Record<string, string> }> {
  if (!source.token) return { asset };
  const installer: UpdateAsset = { ...asset, url: asset.fallback ?? asset.url, fallback: undefined };
  const copy = updateCopyName(asset.name);
  if (!copy || !installer.url) return { asset: installer };
  try {
    const res = await fetch(`https://api.github.com/repos/${source.repo}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: { ...API_HEADERS, Authorization: `Bearer ${source.token}` },
      signal,
      redirect: 'error',
    });
    if (!res.ok) {
      res.body?.cancel().catch(() => undefined);
      return { asset: installer };
    }
    const release = (await res.json()) as { assets?: { id?: unknown; name?: unknown }[] } | null;
    const found = Array.isArray(release?.assets) ? release.assets.find((a) => a?.name === copy) : undefined;
    const id = found?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return { asset: installer };
    return {
      asset: { ...asset, url: `https://api.github.com/repos/${source.repo}/releases/assets/${id}`, fallback: installer.url },
      headers: downloadHeaders(source),
    };
  } catch {
    return { asset: installer };
  }
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
 * How long a download may go without a byte before it is given up on: a connection that dropped would
 * otherwise hold the update (and every check after it) until the app restarts. In parts, also how long
 * one part may: it is then asked for again, from where it stopped.
 */
export const DOWNLOAD_STALL_MS = 60_000;

/**
 * How many connections a download uses at most (`download`, given a fetch for each). On some networks
 * GitHub's CDN sends each connection only so fast (some 200 KB/s from Taiwan, on a network that takes
 * 30 MB/s elsewhere), and several of them together go several times faster.
 */
export const DOWNLOAD_CONNECTIONS = 6;

/**
 * The least a connection takes on: a file smaller than twice this downloads in one request, and a part
 * is split for a connection with nothing left to do only while it has twice this to go.
 */
export const MIN_PART_BYTES = 1024 * 1024;

/** How many times the parts of one download may fail (each asked for again from where it stopped) before it is given up on. */
export const PART_FAILURES = 3;

/**
 * Where a download's address leads, asked (with `headers`) without following it: GitHub answers a release
 * file's address with a redirect to the file on its CDN (signed, for up to an hour), and the parts are
 * fetched from there, so that GitHub counts the download once, not once a part. No `location` for an
 * answer that is no redirect.
 */
export type Locate = (url: string, signal: AbortSignal, headers?: Record<string, string>) => Promise<{ status: number; location?: string }>;

/**
 * Downloads `asset` to `to` (through `to`.part, so a broken download never looks like a whole one) and
 * checks it against its SHA-256: from its `url`, or from its `fallback` when GitHub has nothing there
 * (404) or, asked with `headers`, will not give it (401, 403). Given `connections` (a fetch for each:
 * main.ts gives each a session of its own, as one session's requests to a host share one connection)
 * and `locate`, a file of twice `minPart` or more comes in parts, one a connection (`inParts`); any
 * other, and one from a server that takes no ranges, in one request. `headers` (`copyToDownload`: the
 * token, for a copy in a private repository) go to the asset's own address alone: it is asked where it
 * leads first (`locate`; without one, the fallback is fetched instead), and neither the CDN it sends to
 * nor the fallback gets them. `onProgress` gets the share done, from 0 to 1. Given up on after
 * `stallMs` without a byte (DOWNLOAD_STALL_MS).
 */
export async function download(o: {
  fetch: Fetch;
  asset: UpdateAsset;
  to: string;
  onProgress?: (done: number) => void;
  stallMs?: number;
  connections?: Fetch[];
  locate?: Locate;
  minPart?: number;
  headers?: Record<string, string>;
}): Promise<void> {
  if (!o.asset.sha256) throw new UpdateError('checksum', 'no checksum');
  const part = `${o.to}.part`;
  rmSync(part, { force: true });
  const stallMs = o.stallMs ?? DOWNLOAD_STALL_MS;
  const minPart = o.minPart ?? MIN_PART_BYTES;
  const size = o.asset.size ?? 0;
  const stall = new Stall(stallMs);
  let file: FileHandle | undefined;
  let failed = false;
  let failure: unknown;
  try {
    file = await open(part, 'w');
    const write = writer(file);
    if (o.connections && o.connections.length > 1 && o.locate && size >= 2 * minPart) {
      try {
        await inParts({ connections: o.connections, locate: o.locate, asset: o.asset, headers: o.headers, size, minPart, stall, stallMs, write, onProgress: o.onProgress });
      } catch (err) {
        if (!(err instanceof NoRanges)) throw err;
        // A server (or a proxy) that sends the whole file for a part of it: all of it in one request, from there.
        await file.truncate(0);
        await whole({ fetch: o.fetch, locate: o.locate, url: err.address, headers: err.headers, fallback: o.asset.fallback, size, stall, write, onProgress: o.onProgress });
      }
    } else {
      await whole({ fetch: o.fetch, locate: o.locate, url: o.asset.url, headers: o.headers, fallback: o.asset.fallback, size, stall, write, onProgress: o.onProgress });
    }
  } catch (err) {
    failed = true;
    failure = err;
  } finally {
    stall.stop();
    await file?.close().catch(() => undefined);
  }
  if (failed) {
    rmSync(part, { force: true });
    throw failure instanceof UpdateError ? failure : new UpdateError('download', stall.why(failure));
  }
  const got = await sha256Of(part);
  if (got !== o.asset.sha256) {
    rmSync(part, { force: true });
    throw new UpdateError('checksum', `expected ${o.asset.sha256}, got ${got}`);
  }
  renameSync(part, o.to);
}

/** Writes `length` bytes of `chunk` at `at` in the file being downloaded. */
type Write = (chunk: Uint8Array, length: number, at: number) => Promise<void>;

/** Writes into `file` at the places given, one write at a time. */
function writer(file: FileHandle): Write {
  let last: Promise<unknown> = Promise.resolve();
  return (chunk, length, at) => {
    const done = last.then(() => file.write(chunk, 0, length, at));
    last = done.catch(() => undefined);
    return done.then(() => undefined);
  };
}

/** A download's watch for bytes: `signal` aborts after `ms` without `touch()`, saying so. */
class Stall {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly ms: number;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(ms: number) {
    this.ms = ms;
    this.touch();
  }

  touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.controller.abort(new Error(`no data for ${Math.round(this.ms / 1000)} s`)), this.ms);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** Why a download failed: given up on for no data, else `err`. */
  why(err: unknown): string {
    const cause = this.signal.aborted ? this.signal.reason : err;
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/**
 * Gives `body`'s chunks to `take`, one at a time, until it ends or `take` has had enough (false: the rest
 * is cancelled). Stops with `signal`'s reason once it aborts, also with a body that would go on.
 */
async function readBody(body: ReadableStream<Uint8Array>, signal: AbortSignal, take: (chunk: Uint8Array) => Promise<boolean>): Promise<void> {
  const reader = body.getReader();
  const cancel = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return;
      if (!(await take(value))) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (signal.aborted) cancel();
  }
}

/** The SHA-256 of a file, in lowercase hex. */
async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Whether GitHub has nothing for us at an address (404), or, asked with the token (`authorized`), will
 * not give it (401, 403: expired or revoked; 403, 429: out of requests, which every installed app shares;
 * 5xx: its API failing): the installer itself is then fetched, the same file, from where no token is
 * needed. Without the token, any answer but 404 is GitHub's to fix, as before.
 */
function unavailable(status: number, authorized: boolean): boolean {
  return status === 404 || (authorized && (status === 401 || status === 403 || status === 429 || status >= 500));
}

/**
 * Where an answer to `locate(source)` says the file is: where it redirects to (over HTTPS only), or
 * `source` itself when it answered with the file.
 */
function addressFrom(found: { status: number; location?: string }, source: string): string {
  if (found.location !== undefined) {
    const url = URL.canParse(found.location, source) ? new URL(found.location, source) : undefined;
    if (url?.protocol !== 'https:') throw new UpdateError('download', `redirected to ${found.location}`);
    return url.href;
  }
  if (found.status >= 200 && found.status < 300) return source;
  throw new UpdateError('download', `HTTP ${found.status}`);
}

/**
 * The whole file in one request: from `url`, or from `fallback` when GitHub has nothing there or will
 * not give it (`unavailable`). With `headers` (the token), `url` is asked where it leads first
 * (`locate`), and the file fetched from there without them; a request that still carries them (`url`
 * answered with the file itself) follows no redirect, so they never leave that address. Without
 * `locate`, the fallback is fetched instead: the token is never sent on.
 */
async function whole(o: {
  fetch: Fetch;
  locate?: Locate;
  url: string;
  headers?: Record<string, string>;
  fallback?: string;
  size: number;
  stall: Stall;
  write: Write;
  onProgress?: (done: number) => void;
}): Promise<void> {
  const signal = o.stall.signal;
  // Where the file is asked for, and with what: the headers at the asset's own address alone.
  let target: { url: string; headers?: Record<string, string> } | undefined = { url: o.url };
  if (o.headers) {
    const found = o.locate ? await o.locate(o.url, signal, o.headers) : undefined;
    if (!found || unavailable(found.status, true)) target = undefined;
    else {
      const at = addressFrom(found, o.url);
      target = at === o.url ? { url: at, headers: o.headers } : { url: at };
    }
  }
  let res = target ? await o.fetch(target.url, target.headers ? { headers: target.headers, signal, redirect: 'error' } : { signal }) : undefined;
  // Its copy for updates cannot be had (a release published before the copies, its repository gone, the
  // token expired): the installer itself.
  if ((!res || unavailable(res.status, !!target?.headers)) && o.fallback) {
    res?.body?.cancel().catch(() => undefined);
    res = await o.fetch(o.fallback, { signal });
  }
  if (!res) throw new UpdateError('download', 'no way to ask where the file is without its headers going along');
  if (!res.ok || !res.body) throw new UpdateError('download', `HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || o.size;
  let received = 0;
  await readBody(res.body, signal, async (chunk) => {
    o.stall.touch();
    const at = received;
    received += chunk.length;
    await o.write(chunk, chunk.length, at);
    if (total) o.onProgress?.(Math.min(1, received / total));
    return true;
  });
}

/**
 * A server sent the whole file for a part of it (it takes no ranges): the file is then downloaded in one
 * request, from `address`, with the `headers` a request there takes.
 */
class NoRanges extends Error {
  readonly address: string;
  readonly headers?: Record<string, string>;
  constructor(address: string, headers?: Record<string, string>) {
    super('ranges not taken');
    this.address = address;
    this.headers = headers;
  }
}

/** The CDN refused a part (403): the signed `address` it was asked at has expired. */
class Expired extends Error {
  readonly address: string;
  constructor(address: string) {
    super('HTTP 403');
    this.address = address;
  }
}

/** A part of a download in parts: the bytes from `pos` up to `end` (not included) still to come. */
interface Part {
  pos: number;
  /** Moved back when another connection takes the second half of what is left. */
  end: number;
}

/**
 * Downloads the file in parts, one a connection, from where its address leads (`locate`: GitHub is asked
 * once, the copy's address with `headers` or the fallback's, without them, when the copy cannot be had,
 * and the parts are fetched from its CDN, without them). A connection done with its part takes the second half of what the part with the most left has still to go (while that is at least twice `minPart`), so that a slow connection holds the end up
 * less. A part that fails, or goes `stallMs` without a byte, is asked for again from where it stopped,
 * up to PART_FAILURES times in all; when its signed address has expired (403), at a new one.
 */
async function inParts(o: {
  connections: Fetch[];
  locate: Locate;
  asset: UpdateAsset;
  headers?: Record<string, string>;
  size: number;
  minPart: number;
  stall: Stall;
  stallMs: number;
  write: Write;
  onProgress?: (done: number) => void;
}): Promise<void> {
  const { size, stall } = o;
  let source = o.asset.url;
  let headers = o.headers;
  let found = await o.locate(source, stall.signal, headers);
  // Its copy for updates cannot be had (a release published before the copies, its repository gone, the
  // token expired): the installer itself, without the token.
  if (unavailable(found.status, !!headers) && o.asset.fallback) {
    source = o.asset.fallback;
    headers = undefined;
    found = await o.locate(source, stall.signal);
  }
  let address = addressFrom(found, source);
  /** What a request to `at` takes: the asset's headers at its own address alone (it answered with the file), none at the CDN's. */
  const headersAt = (at: string) => (at === source ? headers : undefined);
  // Stops every connection: given up on for no data, or when a part fails for good.
  const failed = new AbortController();
  const stop = AbortSignal.any([stall.signal, failed.signal]);
  let fatal: { err: unknown } | undefined;
  const fail = (err: unknown) => {
    fatal ??= { err };
    failed.abort(err);
  };

  let relocating: Promise<void> | undefined;
  /**
   * Asks where the file is again, for a new signed address (once at a time). Refused with the token
   * meanwhile (revoked, out of requests): the parts left come from the installer itself, without it, the
   * same file, checked by its SHA-256 at the end.
   */
  const relocate = () => {
    relocating ??= o.locate(source, stop, headers).then(
      async (f) => {
        if (headers && unavailable(f.status, true) && o.asset.fallback) {
          source = o.asset.fallback;
          headers = undefined;
          f = await o.locate(source, stop);
        }
        address = addressFrom(f, source);
        relocating = undefined;
      },
      (err: unknown) => {
        relocating = undefined;
        throw err;
      },
    );
    return relocating;
  };

  const count = Math.min(o.connections.length, Math.floor(size / o.minPart));
  const waiting: Part[] = Array.from({ length: count }, (_, i) => ({ pos: Math.floor((size * i) / count), end: Math.floor((size * (i + 1)) / count) }));
  const active = new Set<Part>();
  let received = 0;
  let failures = 0;

  /** The next part for a connection: one waiting, else the second half of the one with the most left. */
  const next = (): Part | undefined => {
    const part = waiting.shift();
    if (part) return part;
    let widest: Part | undefined;
    for (const p of active) if (!widest || p.end - p.pos > widest.end - widest.pos) widest = p;
    if (!widest || widest.end - widest.pos < 2 * o.minPart) return undefined;
    const half = { pos: widest.pos + Math.floor((widest.end - widest.pos) / 2), end: widest.end };
    widest.end = half.pos;
    return half;
  };

  const fetchPart = async (fetch: Fetch, part: Part): Promise<void> => {
    const from = part.pos;
    const at = address;
    const sent = headersAt(at);
    const watch = new Stall(o.stallMs);
    const signal = AbortSignal.any([stop, watch.signal]);
    try {
      const res = await fetch(at, { headers: { ...sent, Range: `bytes=${from}-${part.end - 1}` }, signal, ...(sent ? { redirect: 'error' as const } : {}) });
      if (res.status !== 206 || !res.body) {
        res.body?.cancel().catch(() => undefined);
        if (res.status === 200) throw new NoRanges(at, sent);
        if (res.status === 403) throw new Expired(at);
        throw new UpdateError('download', `HTTP ${res.status}`);
      }
      const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(res.headers.get('content-range') ?? '');
      if (!range || Number(range[1]) !== from || (range[2] !== '*' && Number(range[2]) !== size)) {
        res.body.cancel().catch(() => undefined);
        throw new UpdateError('download', `sent ${res.headers.get('content-range')} for bytes ${from}-`);
      }
      await readBody(res.body, signal, async (chunk) => {
        watch.touch();
        stall.touch();
        // Up to the part's end, which another connection may have moved back since.
        const length = Math.min(chunk.length, part.end - part.pos);
        if (length > 0) {
          const pos = part.pos;
          part.pos += length;
          received += length;
          try {
            await o.write(chunk, length, pos);
          } catch (err) {
            fail(err);
            throw err;
          }
          o.onProgress?.(Math.min(1, received / size));
        }
        return part.pos < part.end;
      });
      if (part.pos < part.end) throw new UpdateError('download', `connection closed at byte ${part.pos}`);
    } catch (err) {
      throw watch.signal.aborted && !stop.aborted ? watch.signal.reason : err;
    } finally {
      watch.stop();
    }
  };

  const connection = async (fetch: Fetch): Promise<void> => {
    for (let part = next(); part && !stop.aborted; part = next()) {
      active.add(part);
      try {
        await fetchPart(fetch, part);
      } catch (err) {
        if (stop.aborted) return;
        if (err instanceof NoRanges) return fail(err);
        if (err instanceof Expired) {
          // Asked again at a new address, found already when another part found this one expired (and
          // counted as one failure, however many parts find it).
          if (err.address === address) {
            if (!relocating && ++failures > PART_FAILURES) return fail(new UpdateError('download', err.message));
            await relocate();
          }
        } else if (++failures > PART_FAILURES) {
          return fail(err);
        }
        waiting.unshift(part);
      } finally {
        active.delete(part);
      }
    }
  };

  await Promise.all(o.connections.slice(0, count).map((fetch) => connection(fetch).catch(fail)));
  if (fatal) throw fatal.err;
  stall.signal.throwIfAborted();
  if (received !== size) throw new UpdateError('download', `got ${received} of ${size} bytes`);
}

// --- Waiting for the conversations ----------------------------------------------------------

/** How often the app asks the server again while an update waits for its conversations. */
export const IDLE_CHECK_MS = 2000;

/**
 * What the app knows, without asking the server, of how many conversations have agents at work while
 * an update waits: 'ask' the server while it runs; none once it stopped by itself (a crash: nothing
 * runs); unknown (undefined: wait on) while it starts or stops, as in a restart from the menu or on
 * the way to a crash; and unknown for good once the app is quitting (or the system shutting down),
 * so that quitting never switches to the new version.
 */
export function busyWithoutAsking(server: 'stopped' | 'starting' | 'running' | 'stopping', o: { starting: boolean; quitting: boolean }): 0 | 'ask' | undefined {
  if (o.quitting || o.starting) return undefined;
  if (server === 'running') return 'ask';
  return server === 'stopped' ? 0 : undefined;
}

/**
 * Waits until no conversation has agents at work, before the app switches to the new version (which
 * stops the server, and any reply with it). `busy` asks how many have (undefined when the server did
 * not answer: asked again), every `everyMs`, and `onWaiting` hears the number while there are any.
 * Resolves 'idle' once there are none, or 'now' as soon as `now` resolves (the user chose to switch
 * at once).
 */
export async function whenIdle(o: {
  busy: () => Promise<number | undefined>;
  now: Promise<unknown>;
  everyMs?: number;
  onWaiting?: (conversations: number | undefined) => void;
}): Promise<'idle' | 'now'> {
  const now = o.now.then(() => 'now' as const);
  for (;;) {
    const busy = await Promise.race([o.busy(), now]);
    if (busy === 'now') return 'now';
    if (busy === 0) return 'idle';
    o.onWaiting?.(busy);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([new Promise<'again'>((r) => (timer = setTimeout(() => r('again'), o.everyMs ?? IDLE_CHECK_MS))), now]);
    clearTimeout(timer);
    if (waited === 'now') return 'now';
  }
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

/** Where the new AppImage downloads to: hidden next to the running one, so that putting it in place is a rename. */
export function appImageDownload(current: string, assetName: string): string {
  return join(dirname(current), `.${assetName}.download`);
}

/**
 * What an update left next to the running AppImage (`appImageDownload`, and its `.part`): a download
 * the app quit before it was put in place, while it waited for the conversations. Removed at start.
 */
export function removeAppImageLeftovers(current: string): void {
  const dir = dirname(current);
  for (const name of readdirSync(dir)) {
    if (/^\.Harness-Relay-[A-Za-z0-9._-]+\.AppImage\.download(\.part)?$/.test(name)) rmSync(join(dir, name), { force: true });
  }
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

/** A program the app starts as it quits for an update (`spawnDetached`), with its environment. */
export interface StartCommand {
  bin: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

/** Where the relaunch script finds this app's pid and the new version (removed before the new version starts). */
export const RELAUNCH_PID = 'HARNESS_RELAY_RELAUNCH_PID';
export const RELAUNCH_TARGET = 'HARNESS_RELAY_RELAUNCH_TARGET';

/**
 * The command that waits for this app (`pid`) to exit, then starts the new one (`target`) in `env`: on
 * macOS `open` the app (so it starts as if opened from the Finder), on Linux the AppImage with `args`
 * (`--no-sandbox`, say). It cannot start before: the running app holds the single-instance lock until
 * it exits. The script is fixed text, and the pid and the path reach it in its environment, never in
 * its arguments.
 */
export function relaunchCommand(platform: NodeJS.Platform, pid: number, target: string, env: NodeJS.ProcessEnv, args: readonly string[] = []): StartCommand {
  const wait =
    `pid=$${RELAUNCH_PID}; target=$${RELAUNCH_TARGET}; unset ${RELAUNCH_PID} ${RELAUNCH_TARGET}; ` +
    'i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done;';
  const start = platform === 'darwin' ? 'exec /usr/bin/open "$target"' : 'exec "$target" "$@"';
  return {
    bin: '/bin/sh',
    args: ['-c', `${wait} ${start}`, 'sh', ...(platform === 'darwin' ? [] : args)],
    env: { ...env, [RELAUNCH_PID]: String(pid), [RELAUNCH_TARGET]: target },
  };
}

/** The environment for the new AppImage: without the variables the running one's runtime set for itself. */
export function relaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete out[k];
  return out;
}
