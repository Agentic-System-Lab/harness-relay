/**
 * A shared conversation opened as its reader opens it: on Harness Relay's viewer (`site/share/`, the
 * repository's own files, served at the website's address) reading the page from GitHub's raw files,
 * which here are gists in a folder of the test's: the fake gh's (`e2e/fake-cli/fake-gh.cjs`, owner
 * `relay-e2e`), or ones a test writes (`writeGist`). They are served as GitHub serves them: plain text,
 * or a download for a file that is not text, that any page may read (CORS), with GitHub's own sandbox,
 * and only under the gist's owner (in any case). Nothing reaches the network: GitHub's API is refused
 * (`apiCalls` lists what was asked) unless the test answers for it (`api`).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { SHARE_VIEWER_URL } from '../../src/shared/share';
import { ROOT } from './paths';
import type { RelayServer } from './relay';

/** The website's address (the viewer is its share/ page). */
export const SITE_URL = new URL('../', SHARE_VIEWER_URL).href;
const SITE_DIR = join(ROOT, 'site');

/** The owner the fake gh makes its gists as. */
export const FAKE_OWNER = 'relay-e2e';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** A file of the website, as GitHub Pages serves it (a folder's index.html for the folder), or null. */
function siteFile(url: string): string | null {
  const path = decodeURIComponent(new URL(url).pathname.slice(new URL(SITE_URL).pathname.length));
  const file = resolve(SITE_DIR, path || '.');
  if (file !== SITE_DIR && !file.startsWith(SITE_DIR + sep)) return null;
  const page = existsSync(file) && statSync(file).isDirectory() ? join(file, 'index.html') : file;
  return existsSync(page) ? page : null;
}

export function serveSite(route: Route) {
  const file = siteFile(route.request().url());
  if (!file) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
  return route.fulfill({ status: 200, path: file, ...(TYPES[extname(file)] ? { contentType: TYPES[extname(file)] } : {}) });
}

/** The folder of the fake gh's gists (a `gists/` folder in it), in the test's own folder. */
export const fakeGithub = (relay: RelayServer) => join(relay.root, 'fake-github');

/** Writes a gist of `files` into `root` (as the fake gh keeps its own), made by `owner`. */
export function writeGist(root: string, id: string, files: Record<string, string | Buffer>, owner = FAKE_OWNER): void {
  const dir = join(root, 'gists', id);
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
  writeFileSync(join(dir, 'gist.json'), JSON.stringify({ id, owner, public: false, files: Object.keys(files) }));
}

/** The owner of a gist in `root`: the fake gh's own when its gist.json names none. */
function ownerOf(root: string, id: string): string {
  try {
    return (JSON.parse(readFileSync(join(root, 'gists', id, 'gist.json'), 'utf8')) as { owner?: string }).owner ?? FAKE_OWNER;
  } catch {
    return FAKE_OWNER;
  }
}

export interface OpenedShare {
  page: Page;
  /** The frame the viewer shows the shared page in. */
  frame: ReturnType<Page['frameLocator']>;
  /** The raw files the viewer asked GitHub for. */
  rawCalls: string[];
  /** What it asked GitHub's API. */
  apiCalls: string[];
}

export interface OpenOptions {
  /** GitHub's API's answer about gist `id` (refused when not given). */
  api?: (id: string) => { status: number; json?: unknown };
  /** GitHub's answer for every raw file, in place of the gists' (`503`, say). */
  rawStatus?: number;
}

type Handler = (route: Route) => Promise<void>;

/** The routes openShared() gave each context last, taken back when it opens another share there. */
const routed = new WeakMap<BrowserContext, [string, Handler][]>();

/**
 * Opens `link` (a share's link, on the viewer) in a new tab of `context`, the website and GitHub stood
 * in for, with the gists in `root` (`fakeGithub(relay)`, or a folder `writeGist` wrote to). For the
 * whole context, so that the tabs its links open read them too.
 */
export async function openShared(context: BrowserContext, root: string, link: string, o: OpenOptions = {}): Promise<OpenedShare> {
  for (const [pattern, handler] of routed.get(context) ?? []) await context.unroute(pattern, handler);
  const routes: [string, Handler][] = [];
  routed.set(context, routes);
  const route = async (pattern: string, handler: Handler) => {
    routes.push([pattern, handler]);
    await context.route(pattern, handler);
  };
  const rawCalls: string[] = [];
  const apiCalls: string[] = [];
  await route(`${SITE_URL}**`, serveSite);
  await route('https://gist.githubusercontent.com/**', (route) => {
    const url = route.request().url();
    rawCalls.push(url);
    const headers = {
      'access-control-allow-origin': '*',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    };
    if (o.rawStatus) return route.fulfill({ status: o.rawStatus, headers, contentType: 'text/plain', body: 'Unavailable' });
    // /<owner>/<id>/raw/<file> (the newest version), or /<owner>/<id>/raw/<sha>/<file> (as GitHub's API names it).
    const m = /^\/([^/]+)\/([0-9a-f]+)\/raw\/(?:[0-9a-f]+\/)?([^/]+)$/.exec(new URL(url).pathname);
    const file = m ? join(root, 'gists', m[2]!, decodeURIComponent(m[3]!)) : '';
    const owned = m && decodeURIComponent(m[1]!).toLowerCase() === ownerOf(root, m[2]!).toLowerCase();
    if (!owned || !existsSync(file)) return route.fulfill({ status: 404, headers, contentType: 'text/plain', body: '404: Not Found' });
    const data = readFileSync(file);
    // GitHub serves text as text, and anything else as a download.
    const contentType = data.includes(0) ? 'application/octet-stream' : 'text/plain; charset=utf-8';
    return route.fulfill({ status: 200, headers, contentType, body: data });
  });
  await route('https://api.github.com/**', (route) => {
    const url = route.request().url();
    apiCalls.push(url);
    const id = /^\/gists\/([^/?]+)$/.exec(new URL(url).pathname)?.[1];
    const answer = id && o.api?.(id);
    if (!answer) return route.abort();
    return route.fulfill({
      status: answer.status,
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json',
      body: JSON.stringify(answer.json ?? { message: 'Not Found' }),
    });
  });
  const page = await context.newPage();
  await page.goto(link);
  return { page, frame: page.frameLocator('#share-frame'), rawCalls, apiCalls };
}
