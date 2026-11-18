import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { failureOf, framedHref, gistOf, gistPage, langOf, rawUrl, RAW_HOST, SHARE_FILE, WORDS } from '../site/assets/share.js';
import { parseGistUrl, SHARE_FILE as SERVER_SHARE_FILE } from '../src/server/share';
import { SHARE_VIEWER_URL, shareViewerUrl } from '../src/shared/share';
import { HARNESS_RELAY_URL } from '../src/web/share';
import { SITE, VIEWER_FILE } from './site-pages';

// The viewer of a shared conversation on the website (site/share/, site/assets/share.js): the address the
// server gives a share and the gist the viewer reads from it, the raw file it reads (never GitHub's API,
// which a browser may ask only 60 times an hour), its words in both languages, and the page itself: its
// policy, and the frame that runs nothing the gist holds. The browser half is tried in e2e/specs/share.spec.ts.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const exists = (path: string) => existsSync(new URL(`../${path}`, import.meta.url));
const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe("the viewer's address", () => {
  it('is the share/ page of the website the app links to', () => {
    expect(SHARE_VIEWER_URL).toBe(`${SITE}share/`);
    expect(SHARE_VIEWER_URL).toBe(`${HARNESS_RELAY_URL}share/`);
    expect(VIEWER_FILE).toBe('site/share/index.html');
    expect(exists(VIEWER_FILE)).toBe(true);
  });

  it('names the gist after its #, which the viewer reads back as the server wrote it', () => {
    const url = shareViewerUrl('some-one', ID);
    expect(url).toBe(`${SHARE_VIEWER_URL}#some-one/${ID}`);
    expect(gistOf(new URL(url).hash)).toEqual({ owner: 'some-one', id: ID });
    // From what gh prints, through the server's own parsing.
    const link = parseGistUrl(`✓ Created secret gist index.html\nhttps://gist.github.com/Some-One42/${ID}\n`)!;
    expect(gistOf(new URL(link.url).hash)).toEqual({ owner: 'Some-One42', id: ID });
  });

  it('takes a gist with or without the #, and a / after it', () => {
    expect(gistOf(`me/${ID}`)).toEqual({ owner: 'me', id: ID });
    expect(gistOf(`#me/${ID}/`)).toEqual({ owner: 'me', id: ID });
    expect(gistOf(`#m%65/${ID}`)).toEqual({ owner: 'me', id: ID });
  });

  it('names no gist for anything else', () => {
    for (const hash of [
      '',
      '#',
      `#${ID}`, // no owner: gistpreview's form
      `#me/${ID}/index.html`,
      `#me/me/${ID}`,
      `#me/${ID.toUpperCase()}`,
      '#me/a1b2c3', // too short for a share's gist
      `#me_you/${ID}`,
      `#-me/${ID}`,
      `#${'a'.repeat(40)}/${ID}`,
      `#me%2Fyou/${ID}`,
      `#%E0%A4%A/${ID}`, // not a percent-encoding: decodeURIComponent throws
      `#../${ID}`,
    ]) {
      expect(gistOf(hash), hash).toBeUndefined();
    }
    expect(gistOf(undefined)).toBeUndefined();
    expect(gistOf(42)).toBeUndefined();
  });
});

describe('what the viewer reads', () => {
  it("is the page's raw file on GitHub, by its owner and id, never GitHub's API", () => {
    expect(RAW_HOST).toBe('https://gist.githubusercontent.com/');
    expect(SHARE_FILE).toBe(SERVER_SHARE_FILE);
    expect(rawUrl({ owner: 'me', id: ID })).toBe(`https://gist.githubusercontent.com/me/${ID}/raw/index.html`);
    expect(rawUrl({ owner: 'me', id: ID })).not.toContain('api.github.com');
    expect(gistPage({ owner: 'me', id: ID })).toBe(`https://gist.github.com/me/${ID}`);
  });

  it('says a gist that is not there apart from one GitHub could not give', () => {
    expect(failureOf(200)).toBeUndefined();
    expect(failureOf(404)).toEqual({ kind: 'notFound' });
    expect(failureOf(403)).toEqual({ kind: 'failed', detail: 'HTTP 403' });
    expect(failureOf(503)).toEqual({ kind: 'failed', detail: 'HTTP 503' });
  });

  it("points the page's own links at its frame, and leaves every other link as it is", () => {
    expect(framedHref('#quote-1-0')).toBe('about:srcdoc#quote-1-0');
    expect(framedHref('#')).toBe('about:srcdoc#');
    expect(framedHref('https://gist.githubusercontent.com/me/x/raw/a.pdf')).toBe('https://gist.githubusercontent.com/me/x/raw/a.pdf');
    expect(framedHref('https://example.com/#top')).toBe('https://example.com/#top');
    expect(framedHref(null)).toBeNull();
  });
});

describe("the viewer's words", () => {
  it('follow the language: Traditional Chinese for any Chinese, else English', () => {
    for (const tag of ['zh-TW', 'zh', 'zh-Hant-TW', 'ZH-cn', ' zh-TW ']) expect(langOf(tag), tag).toBe('zh-TW');
    for (const tag of ['en', 'en-US', 'ja', 'zhx', '', undefined, null]) expect(langOf(tag), String(tag)).toBe('en');
  });

  it('are the same in both languages, each naming the owner, and leading home in its own', () => {
    expect(Object.keys(WORDS)).toEqual(['en', 'zh-TW']);
    expect(Object.keys(WORDS['zh-TW'])).toEqual(Object.keys(WORDS.en));
    for (const lang of ['en', 'zh-TW'] as const) {
      const w = WORDS[lang];
      const by = w.sharedBy('relay-e2e');
      expect(by).toHaveLength(3);
      expect(by[1]).toBe('@relay-e2e');
      expect(w.failed('HTTP 503')).toContain('HTTP 503');
      for (const value of Object.values(w)) if (typeof value === 'string') expect(value.trim(), lang).not.toBe('');
      const home = new URL(w.homeHref, SHARE_VIEWER_URL).href;
      expect(home).toBe(lang === 'en' ? SITE : `${SITE}zh-TW/`);
      expect(exists(`site/${home.slice(SITE.length)}index.html`), home).toBe(true);
    }
    expect(WORDS.en.title).toBe('Shared conversation · Harness Relay');
  });
});

describe('the viewer page', () => {
  const html = read(VIEWER_FILE);
  const head = html.slice(0, html.indexOf('</head>'));
  const meta = (name: string) => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(head)?.[1];
  const policy = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(head)?.[1];
  const directives = new Map(
    (policy ?? '').split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values.join(' ')] as const;
    }),
  );

  it("runs its own script alone and reads only GitHub's raw files, with nothing else of its own to load", () => {
    expect(policy).toBeDefined();
    expect(Object.fromEntries(directives)).toEqual({
      'default-src': "'none'",
      'script-src': "'self'",
      'style-src': "'unsafe-inline'",
      'img-src': "'self' data:",
      'connect-src': RAW_HOST.slice(0, -1),
      'frame-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'none'",
    });
    // Its one script, a module of the site's: no script written into the page, which the policy would refuse.
    expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script type="module" src="../assets/share.js">']);
    expect(exists('site/assets/share.js')).toBe(true);
  });

  it('shows the gist in a frame that runs nothing it holds, with an origin of its own', () => {
    const frames = [...html.matchAll(/<iframe\b[^>]*>/g)].map((m) => m[0]);
    expect(frames).toHaveLength(1);
    const sandbox = /\ssandbox="([^"]*)"/.exec(frames[0]!)?.[1];
    // Its links open in a tab of their own, as a normal page: nothing else (no scripts, forms,
    // same origin, or moving this page elsewhere).
    expect(sandbox?.split(/\s+/).sort()).toEqual(['allow-popups', 'allow-popups-to-escape-sandbox']);
    expect(frames[0]).toContain('id="share-frame"');
    expect(frames[0]).toContain('referrerpolicy="no-referrer"');
  });

  it('is in no search engine, sends no referrer, and is not one of the pages the sitemap lists', () => {
    expect(meta('robots')).toBe('noindex, nofollow');
    expect(meta('referrer')).toBe('no-referrer');
    expect(read('site/sitemap.xml')).not.toContain(`${SITE}share/`);
    expect(head).not.toContain('rel="canonical"');
  });

  it('has every element the script fills', () => {
    const script = read('site/assets/share.js');
    const ids = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) expect(html, id).toContain(`id="${id}"`);
  });
});
