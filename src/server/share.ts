// Sharing a conversation: the page the web app made of it goes up to GitHub as a secret gist, created
// with the user's own GitHub CLI (`gh`), and is read through gistpreview.github.io. The files its
// replies link to can go along, of any kind (text, PDF, slides, images…), in a second secret gist that
// git pushes them into, the page's links pointing at them there.

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileName } from '../shared/media';
import { replaceFileLinks } from '../shared/share';
import {
  GH_MIN_VERSION,
  GH_MISSING,
  GH_SIGNED_OUT,
  SHARE_FILE_LINKS_MAX,
  SHARE_FILE_MAX_BYTES,
  SHARE_FILES_MAX_BYTES,
  SHARE_MAX_BYTES,
  type Conversation,
  type ShareFileInfo,
  type ShareFileRef,
  type ShareLink,
} from '../shared/types';
import { t } from './i18n';
import { downloadProblem, mediaRoots, resolveDownload } from './media';
import { DATA_DIR } from './settings';
import { CommandNotFoundError, runProcess, tail, type SpawnOptions, type SpawnResult } from './process';
import { BREW_DIRS, findOnPath } from './voice';

/**
 * The page's file in its gist. gistpreview.github.io (main.js) shows a gist's `index.html` when it has
 * one, else its first file; no file that goes along may take this name either.
 */
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

/**
 * `code`: GH_MISSING or GH_SIGNED_OUT, for the UI to say what to do. `leftover`: a gist that holds
 * the files but not the page, and could not be deleted either (to be listed, so it can be removed).
 */
export class ShareError extends Error {
  constructor(
    message: string,
    public code?: typeof GH_MISSING | typeof GH_SIGNED_OUT,
    public leftover?: ShareLink,
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
async function gh(
  run: (o: SpawnOptions) => Promise<SpawnResult>,
  args: string[],
  stdin?: string,
  timeoutMs = 60_000,
): Promise<SpawnResult> {
  try {
    return await run({ bin: ghBin(), args, env: { ...process.env }, stdin, timeoutMs });
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

/** A file that goes along with the page, into the files gist: its name there, and what it holds. */
export interface GistUpload {
  name: string;
  data: Buffer;
}

/** How long git may take to push the files (up to SHARE_FILES_MAX_BYTES of them). */
const PUSH_TIMEOUT_MS = 600_000;

/**
 * What `gh api` prints of the gist it created: its id, its page on GitHub and each file's raw URL,
 * and none of the files' content (GitHub sends it all back).
 */
export const CREATED_JQ = '{id: .id, html_url: .html_url, files: [.files[] | {filename: .filename, raw_url: .raw_url}]}';

/** `gh api` creating a secret gist from the JSON body on stdin. */
export function createGistArgs(): string[] {
  return ['api', 'gists', '--method', 'POST', '--input', '-', '--jq', CREATED_JQ];
}

/**
 * The file a files gist is created with, as GitHub makes no gist without one. The commit git pushes
 * into it then holds the shared files alone: this one goes. No shared file takes its name
 * (gistFileNames), so a listing that still shows it alone is one GitHub has not updated yet.
 */
export const FILES_PLACEHOLDER = 'harness-relay.txt';

/** The body that creates the files gist: secret, holding only the placeholder (the files are pushed after). */
export function createGistBody(description: string): string {
  return JSON.stringify({ description, public: false, files: { [FILES_PLACEHOLDER]: { content: 'Files shared with a Harness Relay page.\n' } } });
}

/** `gh api` reading the gist back as CREATED_JQ prints it: each file's raw URL, once git has pushed them. */
export function gistFilesArgs(id: string): string[] {
  if (!validGistId(id)) throw new Error(`not a gist id: ${id}`);
  return ['api', `gists/${id}`, '--jq', CREATED_JQ];
}

/** A token that marks one share's files gist, so it can be found again when gh could not say it made it. */
export function shareToken(): string {
  return `relay-${randomBytes(8).toString('hex')}`;
}

const TOKEN = /^relay-[0-9a-f]{16}$/;

/** The files gist's description: the page's, that it holds the files, and the share's token. */
export function filesGistDescription(description: string, token: string): string {
  return `${description} · files · ${token}`;
}

/** `gh api` listing the user's latest gists whose description holds `token`: "<id> <html_url>" a line. */
export function findGistArgs(token: string): string[] {
  if (!TOKEN.test(token)) throw new Error(`not a share token: ${token}`);
  return ['api', 'gists?per_page=100', '--jq', `.[] | select((.description // "") | contains("${token}")) | "\\(.id) \\(.html_url)"`];
}

/** The gists findGistArgs printed: their ids (hex only) and addresses. */
export function parseFoundGists(stdout: string): { id: string; url: string }[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([id]) => id && validGistId(id))
    .map(([id, url]) => ({ id: id!, url: url ?? '' }));
}

/** Where GitHub serves a gist file as it is (as plain text or a download, never as a page that runs). */
const RAW_HOST = 'https://gist.githubusercontent.com/';

/** A raw URL GitHub gave, made a well-formed URL (a space it left as it is percent-encoded), when it is on RAW_HOST. */
export function rawUrl(url: string): string | undefined {
  try {
    const href = new URL(url).href;
    return href.startsWith(RAW_HOST) ? href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The gist `gh api` created, from what CREATED_JQ printed: its links (`link`, only for a github.com
 * gist, which gistpreview can show), the address GitHub gave for it (`htmlUrl`, whatever the host),
 * and each file's raw URL by name. `id` alone when that is all that can be read of it (so it can
 * still be deleted).
 */
export function parseCreatedGist(stdout: string): { id?: string; link?: ShareLink; htmlUrl?: string; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  let v: { id?: unknown; html_url?: unknown; files?: unknown };
  try {
    v = JSON.parse(stdout) as typeof v;
  } catch {
    return { raw };
  }
  if (!v || typeof v !== 'object') return { raw };
  const id = typeof v.id === 'string' && validGistId(v.id) ? v.id : undefined;
  if (Array.isArray(v.files)) {
    for (const f of v.files as { filename?: unknown; raw_url?: unknown }[]) {
      const url = typeof f?.raw_url === 'string' ? rawUrl(f.raw_url) : undefined;
      if (typeof f?.filename === 'string' && url) raw.set(f.filename, url);
    }
  }
  const htmlUrl = typeof v.html_url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v.html_url) ? v.html_url : undefined;
  const link = htmlUrl ? parseGistUrl(htmlUrl) : undefined;
  return { id, link: link && link.id === id ? link : undefined, htmlUrl, raw };
}

/** A files gist left on GitHub: listed in Settings by its own address on GitHub (none when GitHub gave none), with no page. */
function leftoverLink(id: string, htmlUrl?: string): ShareLink {
  return { id, url: '', gistUrl: htmlUrl ?? '' };
}

/** Creates the page's gist: one index.html, read from stdin. */
async function createPageGist(html: string, description: string, run: (o: SpawnOptions) => Promise<SpawnResult>): Promise<ShareLink> {
  const r = await gh(run, gistArgs(description), html);
  const link = r.code === 0 ? parseGistUrl(r.stdout) : undefined;
  if (link) return link;
  throw r.code === 0 ? new ShareError(t().shareFailed(t().shareNoUrl)) : await ghFailure(run, r);
}

/**
 * Deletes a files gist that should not stay, because of `reason`: the error then says so, and, when
 * it could not be deleted, carries it (`leftover`, without gh's code: what the user must be told first
 * is that the files are still on GitHub).
 */
async function dropFilesGist(
  run: (o: SpawnOptions) => Promise<SpawnResult>,
  gist: { id: string; url?: string },
  reason: ShareError,
): Promise<never> {
  const d = await gh(run, deleteGistArgs(gist.id)).catch(() => undefined);
  if (d?.code === 0) throw new ShareError(t().shareFilesUndone(reason.message), reason.code);
  throw new ShareError(t().shareFilesLeftover(reason.message), undefined, leftoverLink(gist.id, gist.url));
}

/**
 * gh could not say whether it made the files gist (it timed out, or printed nothing to go on): looks
 * for it by the share's token among the user's latest gists, and deletes what it finds.
 */
async function dropLostFilesGist(run: (o: SpawnOptions) => Promise<SpawnResult>, token: string, reason: ShareError): Promise<never> {
  const r = await gh(run, findGistArgs(token)).catch(() => undefined);
  if (r?.code !== 0) throw new ShareError(t().shareFilesUnknown(reason.message, token));
  const found = parseFoundGists(r.stdout);
  if (!found.length) throw reason; // none was made
  let left: { id: string; url: string } | undefined;
  for (const g of found) {
    const d = await gh(run, deleteGistArgs(g.id)).catch(() => undefined);
    if (d?.code !== 0) left ??= g;
  }
  if (left) throw new ShareError(t().shareFilesLeftover(reason.message), undefined, leftoverLink(left.id, left.url || undefined));
  throw new ShareError(t().shareFilesUndone(reason.message), reason.code);
}

// --- Pushing the files into their gist ---------------------------------------------------

/** Where git reaches a gist on github.com (`id` hex only). */
export function gistGitUrl(id: string): string {
  if (!validGistId(id)) throw new Error(`not a gist id: ${id}`);
  return `https://gist.github.com/${id}.git`;
}

/** `s` as one word for sh, which runs a git credential helper that starts with `!` (on Windows too). */
export function shellWord(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * What every git command of a share runs with: signed in by gh alone (`gh auth git-credential`, the
 * helper `gh auth setup-git` sets up, in place of any the user has), and none of the user's hooks or
 * commit signing.
 */
export function gitConfig(gh: string): string[] {
  return [
    '-c',
    'credential.helper=',
    '-c',
    `credential.helper=!${shellWord(gh)} auth git-credential`,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'push.gpgSign=false',
  ];
}

/** What tells git which repository to use, from the server's own environment: never inherited. */
const GIT_REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR'];

/**
 * git's environment: the server's, without a repository to fall back on, the commit by Harness Relay,
 * never asking for a password (no terminal, no askpass program: when gh cannot sign git in, it fails),
 * and HTTPS the only way to reach a remote, whatever a configuration rewrites its address to (no
 * `ssh` with its command, no `file` or `ext` that run one here).
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...env,
    GIT_AUTHOR_NAME: 'Harness Relay',
    GIT_AUTHOR_EMAIL: 'harness-relay@localhost',
    GIT_COMMITTER_NAME: 'Harness Relay',
    GIT_COMMITTER_EMAIL: 'harness-relay@localhost',
    GIT_TERMINAL_PROMPT: '0',
    // Set but empty: git then tries neither core.askPass nor SSH_ASKPASS.
    GIT_ASKPASS: '',
    GIT_ALLOW_PROTOCOL: 'https',
  };
  for (const k of GIT_REPO_ENV) delete out[k];
  return out;
}

/** Runs git for a share: what it printed, trimmed, or a ShareError saying why it failed. */
async function git(
  run: (o: SpawnOptions) => Promise<SpawnResult>,
  args: string[],
  o: { stdin?: string | Buffer; timeoutMs?: number } = {},
): Promise<string> {
  let r: SpawnResult;
  try {
    r = await run({ bin: 'git', args, env: gitEnv(), stdin: o.stdin, timeoutMs: o.timeoutMs ?? 60_000 });
  } catch (err) {
    if (err instanceof CommandNotFoundError) throw new ShareError(t().shareFilesFailed(err.message));
    throw err;
  }
  if (r.code === 0) return r.stdout.trim();
  throw new ShareError(t().shareFilesFailed(r.timedOut ? t().timedOut : tail(r.stderr, 300) || t().shareNoDetail));
}

/** A git object id (SHA-1, or SHA-256). */
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The branch a gist's HEAD names. */
const BRANCH = /^refs\/heads\/[A-Za-z0-9._/-]+$/;

/** What git printed, when it is what it should be (an object id, a branch); otherwise a ShareError. */
function checked(value: string, pattern: RegExp): string {
  if (pattern.test(value)) return value;
  throw new ShareError(t().shareFilesFailed(value || t().shareNoDetail));
}

/**
 * Where the temporary clones of files gists go: in Harness Relay's own data folder, never the system's
 * temporary folder, which a sandboxed agent may write to (Codex's `workspace-write` does): one that
 * changed a clone's configuration while the files go up could have git run a command of its choosing,
 * outside the sandbox.
 */
export function shareTmpRoot(): string {
  return join(DATA_DIR, 'tmp');
}

/** The temporary clone of one share, in `root`. */
const CLONE_PREFIX = 'share-';

/**
 * Removes the temporary clones shares left behind when the server stopped during them (with up to
 * SHARE_FILES_MAX_BYTES of files each): for the server's start, when no share is being made.
 */
export async function clearShareTmp(root: string = shareTmpRoot()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return; // none yet
  }
  await Promise.all(names.filter((n) => n.startsWith(CLONE_PREFIX)).map((n) => rm(join(root, n), { recursive: true, force: true })));
}

/** The names no shared file takes in its gist: the page's, and the files gist's placeholder. */
const RESERVED_NAMES = new Set([SHARE_FILE, FILES_PLACEHOLDER].map((n) => n.toLowerCase()));

/** Each name as gistFileNames makes them: clean, never reserved or GitHub's own, and each once. */
function checkNames(files: GistUpload[]): void {
  const seen = new Set<string>();
  for (const { name } of files) {
    const key = name.toLowerCase();
    if (name !== gistFileName(name) || RESERVED_NAMES.has(key) || GITHUB_NAMES.test(name) || seen.has(key)) {
      throw new Error(`not a name for a file in the gist: ${JSON.stringify(name)}`);
    }
    seen.add(key);
  }
}

/**
 * Pushes the files into the gist (made with only its placeholder) as one commit that holds them
 * alone. A bare clone in a temporary folder of its own under `root` (see shareTmpRoot: out of the
 * agents' reach, so its configuration is the one git made) takes the files' bytes as they were read,
 * through git's plumbing: nothing is written under their names, so any name a gist can have works,
 * and none of the user's filters touch them. gh signs git in to push, over HTTPS only (gitEnv).
 */
export async function pushToGist(
  id: string,
  files: GistUpload[],
  run: (o: SpawnOptions) => Promise<SpawnResult> = runProcess,
  root: string = shareTmpRoot(),
): Promise<void> {
  checkNames(files);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(root, CLONE_PREFIX));
  try {
    const repo = join(dir, 'gist.git');
    const config = gitConfig(ghBin());
    // `--template=`: no hooks or other files from the user's templates.
    await git(run, [...config, 'clone', '--bare', '--quiet', '--template=', gistGitUrl(id), repo], { timeoutMs: 120_000 });
    const at = [...config, '--git-dir', repo];
    const branch = checked(await git(run, [...at, 'symbolic-ref', 'HEAD']), BRANCH);
    let tree = '';
    for (const f of files) {
      const blob = checked(await git(run, [...at, 'hash-object', '-w', '--no-filters', '--stdin'], { stdin: f.data }), OBJECT_ID);
      // `mktree -z` takes each name as it is (gistFileNames leaves no slash, control character or NUL in one).
      tree += `100644 blob ${blob}\t${f.name}\0`;
    }
    const treeId = checked(await git(run, [...at, 'mktree', '-z'], { stdin: tree }), OBJECT_ID);
    const commit = checked(await git(run, [...at, 'commit-tree', treeId, '-p', 'HEAD', '-m', 'Files shared with a Harness Relay page']), OBJECT_ID);
    await git(run, [...at, 'push', '--quiet', '--no-verify', gistGitUrl(id), `${commit}:${branch}`], { timeoutMs: PUSH_TIMEOUT_MS });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** How many times the gist is read back for its files' raw URLs, while GitHub does not list them all yet. */
const READ_BACK_TRIES = 3;

/** Each file's raw URL in the gist git pushed them into (undefined for one GitHub does not list). */
async function pushedUrls(
  run: (o: SpawnOptions) => Promise<SpawnResult>,
  id: string,
  files: GistUpload[],
  wait: (ms: number) => Promise<void>,
): Promise<(string | undefined)[]> {
  for (let tries = 1; ; tries++) {
    const r = await gh(run, gistFilesArgs(id));
    if (r.code !== 0) throw await ghFailure(run, r);
    const raw = parseCreatedGist(r.stdout).raw;
    const urls = files.map((f) => raw.get(f.name));
    if (urls.every(Boolean) || tries >= READ_BACK_TRIES) return urls;
    await wait(tries * 1000);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How shareToGist goes about a share with files (all optional: tests set them). */
export interface ShareOptions {
  /** Marks the files gist (filesGistDescription); a new one when not given. */
  token?: string;
  /** Waits before the gist is read back again. */
  wait?: (ms: number) => Promise<void>;
  /**
   * Told of the files gist as soon as it is made, before anything goes into it, as it would be left
   * (without a page): so it can be recorded, in case the server stops before the share is done.
   */
  onFilesGist?: (gist: ShareLink) => void;
  /** Where the temporary clone goes (pushToGist). */
  tmpRoot?: string;
}

/**
 * Creates the share: `run` spawns `gh` and `git` (fakes in tests). Without files, one secret gist of
 * the page (index.html). With `files`, whose places the page's placeholder links (src/shared/share.ts)
 * name, two secret gists:
 *
 * 1. the files: `gh api` creates the gist with a placeholder, described with `token`, and git pushes
 *    the files into it (a gist made through GitHub's API holds text only), then `gh api` reads back
 *    each file's raw URL;
 * 2. the page, as without files, its links pointing at those raw URLs.
 *
 * They are kept apart because GitHub's API, which gistpreview reads, gives a gist's files only so much
 * content in all (about 900 KB in a real test), in name order: in one gist, a large file named before
 * index.html left the page's content empty, and gistpreview showed a blank page. If the files or the
 * page cannot go up, the files gist is deleted again; if that fails too, the error says so and carries
 * it (`leftover`). When gh cannot say whether it made the files gist, it is looked for by its token.
 */
export async function shareToGist(
  html: string,
  description: string,
  run: (o: SpawnOptions) => Promise<SpawnResult> = runProcess,
  files: GistUpload[] = [],
  o: ShareOptions = {},
): Promise<ShareLink> {
  if (!files.length) return createPageGist(html, description, run);
  checkNames(files); // before anything is made
  const token = o.token ?? shareToken();

  const r = await gh(run, createGistArgs(), createGistBody(filesGistDescription(description, token)));
  const created = r.code === 0 ? parseCreatedGist(r.stdout) : undefined;
  if (!created?.id) {
    // GitHub said no: nothing was made.
    if (r.code !== 0 && !r.timedOut) throw await ghFailure(run, r);
    return dropLostFilesGist(run, token, new ShareError(t().shareFailed(r.timedOut ? t().timedOut : t().shareNoUrl)));
  }
  const gist = { id: created.id, url: created.htmlUrl };
  let urls: (string | undefined)[];
  try {
    o.onFilesGist?.(leftoverLink(gist.id, gist.url));
    if (!created.link) throw new ShareError(t().shareNotGithub);
    await pushToGist(created.id, files, run, o.tmpRoot);
    urls = await pushedUrls(run, created.id, files, o.wait ?? sleep);
  } catch (err) {
    return dropFilesGist(run, gist, err instanceof ShareError ? err : new ShareError((err as Error).message));
  }
  if (urls.some((u) => !u)) return dropFilesGist(run, gist, new ShareError(t().shareNoFileUrl));
  const page = replaceFileLinks(html, (n) => urls[n]);
  const bytes = Buffer.byteLength(page);
  if (bytes > SHARE_MAX_BYTES) return dropFilesGist(run, gist, new ShareError(t().shareTooLarge((bytes / 1_000_000).toFixed(1))));
  try {
    return { ...(await createPageGist(page, description, run)), filesGist: gist.id };
  } catch (err) {
    return dropFilesGist(run, gist, err instanceof ShareError ? err : new ShareError((err as Error).message));
  }
}

// --- The files a shared page links to -------------------------------------------------

/** The longest a file's name in the gist may be, percent-encoded as it is in its raw URL. */
const NAME_MAX = 240;

/** Characters macOS leaves out when it compares names, as git does when it looks for `.git`. */
const IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * A name git keeps for itself, in the spellings git looks for (any case, with characters macOS
 * ignores, or as Windows shortens `.git`, `.gitmodules` and `.gitattributes`): `.git`, and
 * `.gitmodules`, `.gitattributes`… whose content GitHub checks on a push. A commit with one could be
 * refused.
 */
export function gitOwnName(name: string): boolean {
  return /^(\.git|git~\d|gitmod~\d|gi7eba~\d|gitatt~\d|gi7d29~\d)/.test(name.replace(IGNORED, '').toLowerCase());
}

/**
 * `name` without folders (a gist has none), control characters or broken UTF-16, and never one git
 * keeps for itself (it gets a `_` in front), split into its stem and extension.
 */
function cleanName(name: string): [stem: string, ext: string] {
  let n = name
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '_')
    .replace(/[\\/\x00-\x1f\x7f]/g, '_')
    .trim();
  if (!n || /^\.+$/.test(n)) n = 'file';
  if (gitOwnName(n)) n = `_${n}`;
  const dot = n.lastIndexOf('.');
  return dot > 0 && n.length - dot <= 16 ? [n.slice(0, dot), n.slice(dot)] : [n, ''];
}

/** `stem` + `tail` (a suffix and the extension), the stem cut short (with …) so the whole fits in NAME_MAX. */
function fitName(stem: string, tail: string): string {
  if (encodeURIComponent(stem + tail).length <= NAME_MAX) return stem + tail;
  const chars = Array.from(stem);
  while (chars.length > 1 && encodeURIComponent(`${chars.join('')}…${tail}`).length > NAME_MAX) chars.pop();
  return `${chars.join('')}…${tail}`;
}

/** `name` made fit for a gist: no folders (a gist has none), no control characters, not too long. */
export function gistFileName(name: string): string {
  const [stem, ext] = cleanName(name);
  return fitName(stem, ext);
}

/** The names GitHub gives a gist's unnamed files itself (its API asks that no file be named so). */
const GITHUB_NAMES = /^gistfile\d+(\.[^.]*)?$/i;

/**
 * Each file's name in the gist: its own (see gistFileName), made unique ignoring letter case, as
 * `report-2.md` after a `report.md`, and never the page's (`index.html`), the files gist's
 * placeholder's or one of GitHub's own.
 */
export function gistFileNames(names: string[]): string[] {
  const taken = new Set(RESERVED_NAMES);
  return names.map((raw) => {
    const [stem, ext] = cleanName(raw);
    let candidate = fitName(stem, ext);
    // The suffix goes before the extension, the stem cut shorter for it when the name is long.
    for (let i = 2; taken.has(candidate.toLowerCase()) || GITHUB_NAMES.test(candidate); i++) candidate = fitName(stem, `-${i}${ext}`);
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** The file links a request names: at most SHARE_FILE_LINKS_MAX. Undefined when they are not valid. */
export function parseShareFileRefs(v: unknown): ShareFileRef[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > SHARE_FILE_LINKS_MAX) return undefined;
  const refs: ShareFileRef[] = [];
  for (const r of v as { messageId?: unknown; path?: unknown }[]) {
    if (typeof r?.messageId !== 'string' || !r.messageId || r.messageId.length > 200) return undefined;
    if (typeof r.path !== 'string' || !r.path || r.path.length > 4096) return undefined;
    refs.push({ messageId: r.messageId, path: r.path });
  }
  return refs;
}

/**
 * A file the links point to: what the share dialog is told of it, where it is (`real`, when the
 * reply's download link would serve it) and, once readShareFile read it, what it holds.
 */
export interface FoundShareFile {
  info: ShareFileInfo;
  real?: string;
  data?: Buffer;
}

/**
 * The files `refs` (links of the messages up to and including `upTo`, or of all of them) point to,
 * each once (by real path), in the order first linked: only what the reply's download link would
 * serve (inside the chat's working directory, the agent's worktree or the attachments, never `.git`;
 * see resolveDownload), each measured but not read (readShareFile reads one). A link to a message
 * outside that range, or to none, finds nothing; so does every link when `upTo` names no message.
 */
export async function findShareFiles(conv: Conversation, refs: ShareFileRef[], upTo?: string): Promise<FoundShareFile[]> {
  const end = upTo === undefined ? conv.messages.length - 1 : conv.messages.findIndex((m) => m.id === upTo);
  const range = conv.messages.slice(0, end + 1);
  const found = new Map<string, FoundShareFile>();
  for (const [i, ref] of refs.entries()) {
    const msg = range.find((m) => m.id === ref.messageId);
    const roots = msg ? mediaRoots(conv, msg) : [];
    const real = msg ? resolveDownload(ref.path, roots) : undefined;
    const problem = real ? undefined : msg ? downloadProblem(ref.path, roots) : 'missing';
    // The same file, also by another path or from another reply, goes in once.
    const key = real ?? `${problem}\0${ref.path}`;
    const known = found.get(key);
    if (known) {
      known.info.refs.push(i);
      continue;
    }
    const file: FoundShareFile = { info: { name: fileName(ref.path), path: ref.path, refs: [i], ...(problem ? { problem } : {}) } };
    if (real) {
      file.real = real;
      await measureShareFile(file);
    }
    found.set(key, file);
  }
  return [...found.values()];
}

/** How much readAtMost reads at a time (memory for the rest is taken only as the file has it). */
const CHUNK = 1 << 20;

/**
 * How a shared file is opened: never through a link put in its place since its real path was found
 * (only the last part of the path is checked), and without waiting for a writer when it was swapped
 * for a named pipe (where the system knows these flags).
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The first `max` bytes of the file (all of it when it is shorter), however much it holds; only a regular file. */
export async function readAtMost(path: string, max: number): Promise<Buffer> {
  const fh = await open(path, READ_FLAGS);
  try {
    if (!(await fh.stat()).isFile()) throw new Error(`not a file: ${path}`);
    const chunks: Buffer[] = [];
    let got = 0;
    while (got < max) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, max - got));
      const { bytesRead } = await fh.read(buf, 0, buf.length, got);
      if (!bytesRead) break;
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
      got += bytesRead;
    }
    return Buffer.concat(chunks, got);
  } finally {
    await fh.close();
  }
}

/** A file found for a share measured into `file`: its size, or why it cannot go along (too large, or gone). */
export async function measureShareFile(
  file: FoundShareFile,
  sizeOf: (path: string) => Promise<number> = async (path) => (await stat(path)).size,
): Promise<void> {
  if (!file.real) return;
  try {
    const size = await sizeOf(file.real);
    file.info.size = size;
    if (size > SHARE_FILE_MAX_BYTES) file.info.problem = 'too-large';
  } catch {
    file.info.problem = 'missing';
  }
}

/**
 * Reads a file found for a share, that can go along, into `file` (`data`, and its size as read): never
 * more than `max` + 1 bytes, also when it grew after it was measured. One that grew past `max` is too
 * large then, and nothing of it is kept. One that is no longer a regular file there is `missing`.
 */
export async function readShareFile(file: FoundShareFile, max = SHARE_FILE_MAX_BYTES): Promise<void> {
  if (!file.real || file.info.problem) return;
  try {
    const data = await readAtMost(file.real, max + 1);
    file.info.size = data.length;
    if (data.length > max) file.info.problem = 'too-large';
    else file.data = data;
  } catch {
    file.info.problem = 'missing';
  }
}

/**
 * Reads the files found for a share (readShareFile), in order, until one cannot go along: never more
 * than `total` bytes of them in all, and one more, also when they grew after they were measured. One
 * that does not fit in the room left is left unread, its size the room left and one more, so that
 * they come to more than `total` (refused as too many bytes); one too large on its own is `too-large`.
 */
export async function readShareFiles(found: FoundShareFile[], max = SHARE_FILE_MAX_BYTES, total = SHARE_FILES_MAX_BYTES): Promise<void> {
  let left = total;
  for (const f of found) {
    const room = Math.min(max, left);
    await readShareFile(f, room);
    if (f.info.problem === 'too-large' && room < max) {
      delete f.info.problem; // it may fit on its own: it is the total that is too large
      return;
    }
    if (f.info.problem) return;
    left -= f.data!.length;
  }
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
