// Sharing a conversation: the page the web app made of it goes up to GitHub as a secret gist, created
// with the user's own GitHub CLI (`gh`), and is read through gistpreview.github.io.

import { GH_MIN_VERSION, GH_MISSING, GH_SIGNED_OUT, type ShareLink } from '../shared/types';
import { t } from './i18n';
import { CommandNotFoundError, runProcess, type SpawnOptions, type SpawnResult } from './process';
import { BREW_DIRS, findOnPath } from './voice';

/** The gist's one file. gistpreview shows a gist's index.html, else its first file. */
export const SHARE_FILE = 'index.html';

const GIST_URL = /https:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]+\/)?([0-9a-f]{20,})\b/;

/** `gh gist create` for a page on stdin: a secret gist (the default) with one HTML file. */
export function gistArgs(description: string): string[] {
  return ['gist', 'create', '--filename', SHARE_FILE, '--desc', description, '-'];
}

/** The gist's description: the conversation's title, and where it came from. */
export function gistDescription(title: string): string {
  const name = title.replace(/\s+/g, ' ').trim();
  return name ? `${name} · Harness Relay` : 'Harness Relay';
}

/**
 * The links for the gist `gh gist create` printed. Only github.com gists: gistpreview reads them from
 * api.github.com, so one on a GitHub Enterprise host could not be shown.
 */
export function parseGistUrl(stdout: string): ShareLink | undefined {
  const m = GIST_URL.exec(stdout);
  if (!m) return undefined;
  return { id: m[1]!, url: `https://gistpreview.github.io/?${m[1]}`, gistUrl: m[0] };
}

/** A gist's id as `gh` takes it (hex only: nothing else can reach its command line). */
export function validGistId(id: string): boolean {
  return /^[0-9a-f]{20,}$/.test(id);
}

/** `gh gist delete`, without asking. */
export function deleteGistArgs(id: string): string[] {
  return ['gist', 'delete', id, '--yes'];
}

/** gh says it is not signed in to GitHub. */
export function signedOut(stderr: string): boolean {
  return /gh auth login|not logged in|authentication required|HTTP 401/i.test(stderr);
}

/**
 * gh does not know a flag or command it was given: a gh older than GH_MIN_VERSION (one before 2.66.0
 * answers `gist delete --yes` with "unknown flag: --yes" and its usage).
 */
export function ghTooOld(stderr: string): boolean {
  return /unknown (shorthand )?flag|unknown command/i.test(stderr);
}

/** The version `gh --version` printed ("gh version 2.88.1 (2026-03-12)"). */
export function parseGhVersion(stdout: string): string | undefined {
  return /gh version (\d+\.\d+\.\d+)/.exec(stdout)?.[1];
}

/** What went wrong, in words for the user, when `gh` failed (to create a gist, or with `failed`, to delete one). */
export function gistError(r: Pick<SpawnResult, 'stderr' | 'timedOut'>, failed: (detail: string) => string = t().shareFailed): string {
  if (r.timedOut) return failed(t().timedOut);
  if (signedOut(r.stderr)) return t().shareSignedOut;
  const detail = r.stderr.trim().split('\n').filter(Boolean).pop() ?? '';
  return failed(detail || t().shareNoDetail);
}

/** `code`: GH_MISSING or GH_SIGNED_OUT, for the UI to say what to do. */
export class ShareError extends Error {
  constructor(
    message: string,
    public code?: typeof GH_MISSING | typeof GH_SIGNED_OUT,
  ) {
    super(message);
  }
}

/** The error for a `gh` that failed: not signed in (with its code), or anything else. */
function failure(r: SpawnResult, failed?: (detail: string) => string): ShareError {
  return !r.timedOut && signedOut(r.stderr) ? new ShareError(t().shareSignedOut, GH_SIGNED_OUT) : new ShareError(gistError(r, failed));
}

/**
 * Where gh is: on the PATH, or where Homebrew puts it (a server started outside a terminal may not have
 * those folders on its PATH).
 */
export function ghBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  isFile?: (path: string) => boolean,
): string {
  return findOnPath('gh', env, platform, platform === 'win32' ? [] : BREW_DIRS, isFile) ?? 'gh';
}

/** Runs gh, saying how to install it when it is missing. */
async function gh(run: (o: SpawnOptions) => Promise<SpawnResult>, args: string[], stdin?: string): Promise<SpawnResult> {
  try {
    return await run({ bin: ghBin(), args, env: { ...process.env }, stdin, timeoutMs: 60_000 });
  } catch (err) {
    if (err instanceof CommandNotFoundError) throw new ShareError(t().shareNoGh(GH_MIN_VERSION), GH_MISSING);
    throw err;
  }
}

/** The installed gh's version, if it says. */
async function ghVersion(run: (o: SpawnOptions) => Promise<SpawnResult>): Promise<string | undefined> {
  try {
    const r = await run({ bin: ghBin(), args: ['--version'], env: { ...process.env }, timeoutMs: 10_000 });
    return r.code === 0 ? parseGhVersion(r.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** The error for a gh that failed, saying which gh is needed when this one is too old. */
async function ghFailure(
  run: (o: SpawnOptions) => Promise<SpawnResult>,
  r: SpawnResult,
  failed?: (detail: string) => string,
): Promise<ShareError> {
  if (!r.timedOut && ghTooOld(r.stderr)) return new ShareError(t().ghTooOld(GH_MIN_VERSION, await ghVersion(run)));
  return failure(r, failed);
}

/** Creates the gist: `run` spawns `gh` (a fake one in tests). */
export async function shareToGist(
  html: string,
  description: string,
  run: (o: SpawnOptions) => Promise<SpawnResult> = runProcess,
): Promise<ShareLink> {
  const r = await gh(run, gistArgs(description), html);
  const link = r.code === 0 ? parseGistUrl(r.stdout) : undefined;
  if (link) return link;
  throw r.code === 0 ? new ShareError(t().shareFailed(t().shareNoUrl)) : await ghFailure(run, r);
}

/**
 * Deletes the gist; one already gone (deleted on GitHub) counts as deleted. gh says the same "not found
 * or not owned by you" for a gist of another account (gh signed in to another one since), which is
 * still online: so a gist is only taken for gone when GitHub cannot find it either.
 */
export async function unshareGist(id: string, run: (o: SpawnOptions) => Promise<SpawnResult> = runProcess): Promise<void> {
  const r = await gh(run, deleteGistArgs(id));
  if (r.code === 0) return;
  if (!r.timedOut && /\b404\b|not found/i.test(r.stderr)) {
    const check = await gh(run, gistExistsArgs(id));
    if (check.code === 0) throw new ShareError(t().unshareNotOwner);
    if (/\b404\b|not found/i.test(check.stderr)) return;
    throw failure(check, t().unshareFailed);
  }
  throw await ghFailure(run, r, t().unshareFailed);
}

/** Asks GitHub for the gist (a secret gist can be read by anyone with its id), printing nothing. */
export function gistExistsArgs(id: string): string[] {
  return ['api', `gists/${id}`, '--silent'];
}
