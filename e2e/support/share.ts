/**
 * A shared conversation opened as its reader opens it: on Harness Relay's viewer (`site/share/`, the
 * repository's own files, served at the website's address) reading the page from GitHub's raw files,
 * which here are the gists the fake gh keeps (`e2e/fake-cli/fake-gh.cjs`), served as GitHub serves
 * them: plain text that any page may read (CORS), with GitHub's own sandbox. Nothing reaches the
 * network: GitHub's API least of all (`apiCalls`).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { SHARE_VIEWER_URL } from '../../src/shared/share';
import { ROOT } from './paths';
import type { RelayServer } from './relay';

/** The website's address (the viewer is its share/ page). */
const SITE_URL = new URL('../', SHARE_VIEWER_URL).href;
const SITE_DIR = join(ROOT, 'site');

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

export interface OpenedShare {
  page: Page;
  /** The frame the viewer shows the shared page in. */
  frame: ReturnType<Page['frameLocator']>;
  /** The raw files the viewer asked GitHub for. */
  rawCalls: string[];
  /** What it asked GitHub's API (none: that is the point). */
  apiCalls: string[];
}

/** Opens `link` (a share's link, on the viewer) in a new tab of `context`, the website and GitHub stood in for. */
export async function openShared(context: BrowserContext, relay: RelayServer, link: string): Promise<OpenedShare> {
  const page = await context.newPage();
  const rawCalls: string[] = [];
  const apiCalls: string[] = [];
  await page.route(`${SITE_URL}**`, (route) => {
    const file = siteFile(route.request().url());
    if (!file) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
  await page.route('https://gist.githubusercontent.com/**', (route) => {
    const url = route.request().url();
    rawCalls.push(url);
    // /<owner>/<id>/raw/<file>, the newest version of the gist's file.
    const m = /^\/([^/]+)\/([0-9a-f]+)\/raw\/([^/]+)$/.exec(new URL(url).pathname);
    const file = m ? join(relay.root, 'fake-github', 'gists', m[2]!, decodeURIComponent(m[3]!)) : '';
    const headers = {
      'access-control-allow-origin': '*',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    };
    if (!file || !existsSync(file)) return route.fulfill({ status: 404, headers, contentType: 'text/plain', body: '404: Not Found' });
    return route.fulfill({ status: 200, headers, contentType: 'text/plain; charset=utf-8', body: readFileSync(file) });
  });
  await page.route('https://api.github.com/**', (route) => {
    apiCalls.push(route.request().url());
    return route.abort();
  });
  await page.goto(link);
  return { page, frame: page.frameLocator('#share-frame'), rawCalls, apiCalls };
}
