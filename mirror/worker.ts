// Harness Relay's download mirror (docs/developer-guide.md, "Releasing"): a Cloudflare Worker in front
// of an R2 bucket that holds the newest releases' installers, which the Release workflow uploads there
// before it publishes each release. The website's download buttons point here (MIRROR in
// site/assets/downloads.js): GitHub's own downloads are slow in parts of the world.
//
// GET /<tag>/<file>, for an installer of that release (Harness-Relay-<tag><end>, an end of INSTALLERS):
// the file from the bucket, or a redirect to the same file on GitHub when the bucket does not have it
// (an older release, removed from it) or fails. Under its copy's name for the app's updates (an end of
// UPDATE_INSTALLERS), the same file, for an installed app's update: never counted here (the app counts
// the update on GitHub itself, against the copy, once it has the file), and a 404 or 503 instead of a
// redirect, as the app then downloads it from GitHub as it did without a mirror (desktop/src/update.ts). For each download it serves itself (a GET of the whole file or
// of a part from its first byte, not a resumed or later part), it asks GitHub for the installer's first
// byte as a download there does (github.com's redirect, then GitHub's CDN), with the visitor's user
// agent, so that GitHub's download counts count it as before. A HEAD (the website's check) and a part
// further on (the Release workflow's check) are never counted.
//
// POST /codespaces: a codespace made from the dev container says, once, that it was made
// (.devcontainer/count.sh), so that the maintainers know how many people try Harness Relay in GitHub
// Codespaces, which GitHub does not tell a repository's owner. The request holds nothing; the Worker
// adds one to the day's count in a D1 database (COUNTS), with nothing else: no address, no time of day,
// no user agent. (Workers Logs, [observability] in wrangler.toml, keeps every request a few days, these
// as the downloads.) A browser's request, which says its page's Origin, is refused: a web page cannot
// have its visitors count.
//
// Deployed by hand with wrangler (mirror/wrangler.toml); tested in test/mirror.test.ts. No build step
// and no dependency: wrangler bundles it with the site module it shares the installers' names with.

import { INSTALLERS, REPO, UPDATE_INSTALLERS } from '../site/assets/downloads.js';

/** What the Worker uses of R2 (Cloudflare's R2Bucket binding). */
export interface MirrorObject {
  size: number;
  httpEtag: string;
  uploaded: Date;
}
export interface MirrorBody extends MirrorObject {
  body: ReadableStream<Uint8Array>;
}
export interface MirrorBucket {
  head(key: string): Promise<MirrorObject | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<MirrorBody | null>;
}
/** What the Worker uses of D1 (Cloudflare's D1Database binding): statements run together, in one transaction. */
export interface CountStatement {
  bind(...values: string[]): CountStatement;
}
export interface CountDatabase {
  prepare(query: string): CountStatement;
  batch(statements: CountStatement[]): Promise<unknown[]>;
}
export interface Env {
  /** The bucket (wrangler.toml's r2_buckets binding). */
  BUCKET: MirrorBucket;
  /** The codespaces count (wrangler.toml's d1_databases binding). */
  COUNTS: CountDatabase;
}
/** The request's context: what runs on after the answer is sent. */
export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** A tag or file name as the Release workflow makes them: plain characters, never `.` or `..`. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An installer a path names: its tag, the file name asked for, the bucket's key, and whether for an app's update. */
export interface Installer {
  tag: string;
  file: string;
  /** <tag>/<the installer's name>: a copy's name is served from the installer's file. */
  key: string;
  /** Asked for under its copy's name for the app's updates (UPDATE_INSTALLERS). */
  update: boolean;
}

/**
 * The installer a path names: /<tag>/<file>, the file being one of that release's installers
 * (Harness-Relay-<tag> and an end of INSTALLERS), or one's copy for the app's updates (an end of
 * UPDATE_INSTALLERS). Undefined for any other path: the bucket's other keys, if any, are never served.
 */
export function installerOf(pathname: string): Installer | undefined {
  const [, tag, file, ...rest] = pathname.split('/');
  if (rest.length || !tag || !file || !PLAIN.test(tag) || !PLAIN.test(file)) return undefined;
  for (const [system, end] of Object.entries(INSTALLERS) as [keyof typeof INSTALLERS, string][]) {
    const installer = `Harness-Relay-${tag}${end}`;
    if (file === installer) return { tag, file, key: `${tag}/${installer}`, update: false };
    if (file === `Harness-Relay-${tag}${UPDATE_INSTALLERS[system]}`) return { tag, file, key: `${tag}/${installer}`, update: true };
  }
  return undefined;
}

/** The same installer on GitHub (this repository's release; never asked for an update's copy). */
export function githubUrl({ tag, file }: { tag: string; file: string }): string {
  return `https://github.com/${REPO}/releases/download/${tag}/${file}`;
}

/**
 * The one byte range a Range header asks for, within a file of `size` bytes: { offset, length }, or
 * 'whole' for no header or one that is not a single byte range (answered with the whole file, as
 * HTTP allows), or 'unsatisfiable' for a range that starts past the end.
 */
export function rangeOf(header: string | null, size: number): { offset: number; length: number } | 'whole' | 'unsatisfiable' {
  const m = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'whole';
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    const offset = Math.max(0, size - suffix);
    return { offset, length: size - offset };
  }
  const offset = Number(m[1]);
  if (offset >= size) return 'unsatisfiable';
  const last = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (last < offset) return 'whole';
  return { offset, length: last - offset + 1 };
}

/**
 * GitHub counts the download: the installer's first byte asked for there, as a download from GitHub
 * asks (its redirect followed to its CDN), with the visitor's user agent. Its answer is not used, and a
 * failure is not the visitor's.
 */
export async function countOnGitHub(url: string, userAgent: string | null, fetcher: Fetcher): Promise<void> {
  try {
    const headers: Record<string, string> = { Range: 'bytes=0-0' };
    if (userAgent) headers['User-Agent'] = userAgent;
    const res = await fetcher(url, { headers, redirect: 'follow', cache: 'no-store' });
    await res.body?.cancel();
  } catch {
    // GitHub not reached: this download goes uncounted.
  }
}

/** The headers of an installer's answer. */
function fileHeaders(file: string, object: MirrorObject): Headers {
  return new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${file}"`,
    'X-Content-Type-Options': 'nosniff',
    ETag: object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
    // The website asks with a HEAD whether the mirror has an installer.
    'Access-Control-Allow-Origin': '*',
  });
}

/** Whether an If-None-Match header names the file as it is (a browser's copy is current). */
function unchanged(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const weakless = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => tag.trim() === '*' || weakless(tag) === weakless(etag));
}

// Not exported, nor the statements below: the Workers runtime takes each of the module's exports for an
// entry point, and refuses to start with one that is not a function or a handler.
/** Where a codespace says it was made (.devcontainer/count.sh). */
const CODESPACES_PATH = '/codespaces';

/** The day `now` is in Taiwan, as YYYY-MM-DD: the day a release's version is (scripts/release.ts). */
export function dayOf(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The count's table, made by the first count (a database `wrangler deploy` made is empty), and one more for a day. */
const COUNT_TABLE = 'CREATE TABLE IF NOT EXISTS codespaces (day TEXT PRIMARY KEY, created INTEGER NOT NULL)';
const COUNT_ONE = 'INSERT INTO codespaces (day, created) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET created = created + 1';

/**
 * A codespace made: one more for the day. Its request's body and address are not read, nor its headers
 * but Origin: a browser sends it with a POST from a page (a cross-origin one needs no preflight without a
 * body), curl in a codespace does not.
 */
async function countCodespace(request: Request, env: Env, now: Date): Promise<Response> {
  const text = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
  if (request.method !== 'POST') return new Response('Method not allowed\n', { status: 405, headers: { ...text, Allow: 'POST' } });
  if (request.headers.has('Origin')) return new Response('Forbidden\n', { status: 403, headers: text });
  try {
    await env.COUNTS.batch([env.COUNTS.prepare(COUNT_TABLE), env.COUNTS.prepare(COUNT_ONE).bind(dayOf(now))]);
  } catch {
    // D1 out of order: this codespace goes uncounted (count.sh tries again when it is rebuilt).
    return new Response('Unavailable\n', { status: 503, headers: text });
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export async function handle(request: Request, env: Env, ctx: Context, fetcher: Fetcher, now: Date = new Date()): Promise<Response> {
  if (new URL(request.url).pathname === CODESPACES_PATH) return countCodespace(request, env, now);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const installer = installerOf(new URL(request.url).pathname);
  if (!installer) return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const { key } = installer;
  // Not in the bucket, or the bucket out of order (an R2 outage while the Worker runs): GitHub has every
  // installer. An app's update says so instead, and downloads it from GitHub as it would without a mirror.
  const elsewhere = (failed: boolean) =>
    installer.update
      ? new Response(failed ? 'Unavailable\n' : 'Not found\n', { status: failed ? 503 : 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
      : new Response(null, { status: 302, headers: { Location: githubUrl(installer), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });

  let failed = false;
  const object = await env.BUCKET.head(key).catch(() => ((failed = true), null));
  if (!object) return elsewhere(failed);
  const headers = fileHeaders(installer.file, object);
  if (unchanged(request.headers.get('If-None-Match'), object.httpEtag)) return new Response(null, { status: 304, headers });
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(object.size));
    return new Response(null, { status: 200, headers });
  }

  // A resumed download sends If-Range: its part only if the file is the one it began with.
  const ifRange = request.headers.get('If-Range');
  const current = ifRange === null || ifRange.trim() === object.httpEtag || ifRange.trim() === headers.get('Last-Modified');
  const range = current ? rangeOf(request.headers.get('Range'), object.size) : 'whole';
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${object.size}`);
    return new Response(null, { status: 416, headers });
  }
  const part = range === 'whole' ? undefined : range;
  const body = await env.BUCKET.get(key, part ? { range: part } : undefined).catch(() => ((failed = true), null));
  // Removed since the HEAD above (a release pruned from the bucket), or the bucket failing: GitHub has it.
  if (!body) return elsewhere(failed);
  // An app's update is counted by the app, on GitHub, against its copy.
  if (!installer.update && (!part || part.offset === 0)) ctx.waitUntil(countOnGitHub(githubUrl(installer), request.headers.get('User-Agent'), fetcher));
  if (!part) return new Response(body.body, { status: 200, headers });
  headers.set('Content-Range', `bytes ${part.offset}-${part.offset + part.length - 1}/${object.size}`);
  return new Response(body.body, { status: 206, headers });
}

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    return handle(request, env, ctx, (url, init) => fetch(url, init));
  },
};
