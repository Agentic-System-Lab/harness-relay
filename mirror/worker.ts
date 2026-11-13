// Harness Relay's download mirror (docs/developer-guide.md, "Releasing"): a Cloudflare Worker in front
// of an R2 bucket that holds the newest releases' installers, which the Release workflow uploads there
// before it publishes each release. The website's download buttons point here (MIRROR in
// site/assets/downloads.js): GitHub's own downloads are slow in parts of the world.
//
// GET /<tag>/<file>, for an installer of that release (Harness-Relay-<tag><end>, an end of INSTALLERS):
// the file from the bucket, or a redirect to the same file on GitHub when the bucket does not have it
// (an older release, removed from it) or fails. For each download it serves itself (a GET of the whole file or
// of a part from its first byte, not a resumed or later part), it asks GitHub for the installer's first
// byte as a download there does (github.com's redirect, then GitHub's CDN), with the visitor's user
// agent, so that GitHub's download counts count it as before. A HEAD (the website's check) and a part
// further on (the Release workflow's check) are never counted.
//
// Deployed by hand with wrangler (mirror/wrangler.toml); tested in test/mirror.test.ts. No build step
// and no dependency: wrangler bundles it with the site module it shares the installers' names with.

import { INSTALLERS, REPO } from '../site/assets/downloads.js';

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
export interface Env {
  /** The bucket (wrangler.toml's r2_buckets binding). */
  BUCKET: MirrorBucket;
}
/** The request's context: what runs on after the answer is sent. */
export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** A tag or file name as the Release workflow makes them: plain characters, never `.` or `..`. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The installer a path names: /<tag>/<file>, the file being one of that release's installers
 * (Harness-Relay-<tag> and an end of INSTALLERS). Undefined for any other path: the bucket's other
 * keys, if any, are never served.
 */
export function installerOf(pathname: string): { tag: string; file: string } | undefined {
  const [, tag, file, ...rest] = pathname.split('/');
  if (rest.length || !tag || !file || !PLAIN.test(tag) || !PLAIN.test(file)) return undefined;
  if (!Object.values(INSTALLERS).some((end) => file === `Harness-Relay-${tag}${end}`)) return undefined;
  return { tag, file };
}

/** The same installer on GitHub. */
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

export async function handle(request: Request, env: Env, ctx: Context, fetcher: Fetcher): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed\n', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const installer = installerOf(new URL(request.url).pathname);
  if (!installer) return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const key = `${installer.tag}/${installer.file}`;
  const toGitHub = () => new Response(null, { status: 302, headers: { Location: githubUrl(installer), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });

  // The bucket out of order (an R2 outage while the Worker runs): GitHub has every installer.
  const object = await env.BUCKET.head(key).catch(() => null);
  if (!object) return toGitHub();
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
  const body = await env.BUCKET.get(key, part ? { range: part } : undefined).catch(() => null);
  // Removed since the HEAD above (a release pruned from the bucket), or the bucket failing: GitHub has it.
  if (!body) return toGitHub();
  if (!part || part.offset === 0) ctx.waitUntil(countOnGitHub(githubUrl(installer), request.headers.get('User-Agent'), fetcher));
  if (!part) return new Response(body.body, { status: 200, headers });
  headers.set('Content-Range', `bytes ${part.offset}-${part.offset + part.length - 1}/${object.size}`);
  return new Response(body.body, { status: 206, headers });
}

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    return handle(request, env, ctx, (url, init) => fetch(url, init));
  },
};
