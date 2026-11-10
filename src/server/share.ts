// Sharing a conversation: the page the web app made of it goes up to GitHub as a secret gist, created
// with the user's own GitHub CLI (`gh`), and is read through gistpreview.github.io. The text files its
// replies link to can go along, in a second secret gist, the page's links pointing at them there.

import { randomBytes } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { fileName } from '../shared/media';
import { replaceFileLinks } from '../shared/share';
import {
  GH_MIN_VERSION,
  GH_MISSING,
  GH_SIGNED_OUT,
  SHARE_FILE_LINKS_MAX,
  SHARE_FILE_MAX_BYTES,
  SHARE_MAX_BYTES,
  type Conversation,
  type ShareFileInfo,
  type ShareFileRef,
  type ShareLink,
} from '../shared/types';
import { t } from './i18n';
import { downloadProblem, mediaRoots, resolveDownload } from './media';
import { CommandNotFoundError, runProcess, type SpawnOptions, type SpawnResult } from './process';
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

/** A file that goes along with the page, into the files gist: its name there, and its text. */
export interface GistUpload {
  name: string;
  content: string;
}

/** How long gh may take to upload the files. */
const UPLOAD_TIMEOUT_MS = 180_000;

/**
 * What `gh api` prints of the gist it created: its id, its page on GitHub and each file's raw URL,
 * and none of the files' content (GitHub sends it all back).
 */
export const CREATED_JQ = '{id: .id, html_url: .html_url, files: [.files[] | {filename: .filename, raw_url: .raw_url}]}';

/** `gh api` creating a secret gist from the JSON body on stdin. */
export function createGistArgs(): string[] {
  return ['api', 'gists', '--method', 'POST', '--input', '-', '--jq', CREATED_JQ];
}

/** The body that creates a secret gist with these files. */
export function createGistBody(description: string, files: GistUpload[]): string {
  return JSON.stringify({ description, public: false, files: Object.fromEntries(files.map((f) => [f.name, { content: f.content }])) });
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

/** Where GitHub serves a gist file as it is (as text, never as a page that runs). */
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

/**
 * Creates the share: `run` spawns `gh` (a fake one in tests). Without files, one secret gist of the
 * page (index.html). With `files`, whose places the page's placeholder links (src/shared/share.ts)
 * name, two secret gists:
 *
 * 1. the files, through `gh api` (only that prints each file's raw URL), described with `token`;
 * 2. the page, as without files, its links pointing at those raw URLs.
 *
 * They are kept apart because GitHub's API, which gistpreview reads, gives a gist's files only so much
 * content in all (about 900 KB in a real test), in name order: in one gist, a large file named before
 * index.html left the page's content empty, and gistpreview showed a blank page. If the page cannot go up, the files gist is deleted again; if that fails too, the error says
 * so and carries it (`leftover`). When gh cannot say whether it made the files gist, it is looked for
 * by its token.
 */
export async function shareToGist(
  html: string,
  description: string,
  run: (o: SpawnOptions) => Promise<SpawnResult> = runProcess,
  files: GistUpload[] = [],
  token: string = shareToken(),
): Promise<ShareLink> {
  if (!files.length) return createPageGist(html, description, run);

  const r = await gh(run, createGistArgs(), createGistBody(filesGistDescription(description, token), files), UPLOAD_TIMEOUT_MS);
  const created = r.code === 0 ? parseCreatedGist(r.stdout) : undefined;
  if (!created?.id) {
    // GitHub said no: nothing was made.
    if (r.code !== 0 && !r.timedOut) throw await ghFailure(run, r);
    return dropLostFilesGist(run, token, new ShareError(t().shareFailed(r.timedOut ? t().timedOut : t().shareNoUrl)));
  }
  const gist = { id: created.id, url: created.htmlUrl };
  if (!created.link) return dropFilesGist(run, gist, new ShareError(t().shareNotGithub));
  const urls = files.map((f) => created.raw.get(f.name));
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

/** Bytes no text file holds (tab, line breaks, form feed and escape aside): a file with one is binary. */
const BINARY = /[\x00-\x08\x0b\x0e-\x1a\x1c-\x1f]/;

/**
 * The file's text, when a gist can hold it: UTF-8 (a byte-order mark is kept) without the control
 * bytes of a binary file. GitHub's API takes a gist file's content as a JSON string, and gh refuses
 * what it detects as binary for the same reason. Undefined for anything else.
 */
export function gistText(data: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return undefined;
  }
  return BINARY.test(text) ? undefined : text;
}

/** The longest a file's name in the gist may be, percent-encoded as it is in its raw URL. */
const NAME_MAX = 240;

/** `name` without folders (a gist has none), control characters or broken UTF-16, split into its stem and extension. */
function cleanName(name: string): [stem: string, ext: string] {
  let n = name
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '_')
    .replace(/[\\/\x00-\x1f\x7f]/g, '_')
    .trim();
  if (!n || /^\.+$/.test(n)) n = 'file';
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
 * `report-2.md` after a `report.md`, and never the page's (`index.html`) or one of GitHub's own.
 */
export function gistFileNames(names: string[]): string[] {
  const taken = new Set([SHARE_FILE]);
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

/** A file the links point to: what the share dialog is told of it, and its text when it can go along. */
export interface FoundShareFile {
  info: ShareFileInfo;
  text?: string;
}

/**
 * The files `refs` (links of the messages up to and including `upTo`, or of all of them) point to,
 * each once (by real path), in the order first linked: only what the reply's download link would
 * serve (inside the chat's working directory, the agent's worktree or the attachments, never `.git`;
 * see resolveDownload), and read only when it is small enough to go along. A link to a message
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
    if (real) await readShareFile(real, file);
    found.set(key, file);
  }
  return [...found.values()];
}

/** The first `max` bytes of the file (all of it when it is shorter), however much it holds. */
export async function readAtMost(path: string, max: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    let got = 0;
    while (got < max) {
      const { bytesRead } = await fh.read(buf, got, max - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}

/**
 * Reads a file found for a share into `file`: its size, and its text when it can go along, or why
 * not. Never more than SHARE_FILE_MAX_BYTES + 1 bytes, also when it grew after `sizeOf` measured it.
 */
export async function readShareFile(
  real: string,
  file: FoundShareFile,
  sizeOf: (path: string) => Promise<number> = async (path) => (await stat(path)).size,
): Promise<void> {
  try {
    const size = await sizeOf(real);
    file.info.size = size;
    if (size > SHARE_FILE_MAX_BYTES) {
      file.info.problem = 'too-large';
      return;
    }
    const data = await readAtMost(real, SHARE_FILE_MAX_BYTES + 1);
    if (data.length > SHARE_FILE_MAX_BYTES) {
      file.info.size = Math.max(size, data.length);
      file.info.problem = 'too-large'; // it grew since
      return;
    }
    file.info.size = data.length;
    const text = gistText(data);
    if (text === undefined) file.info.problem = 'binary';
    // GitHub refuses a gist file that is empty or only spaces.
    else if (!text.trim()) file.info.problem = 'empty';
    else file.text = text;
  } catch {
    file.info.problem = 'missing';
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
