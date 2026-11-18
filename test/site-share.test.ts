import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  API_HOST,
  apiUrl,
  failureOf,
  GENERATOR,
  gistOf,
  gistPage,
  isSharedPage,
  langOf,
  linkPlan,
  pageFromApi,
  rawUrl,
  RAW_HOST,
  readPage,
  SHARE_FILE,
  WORDS,
} from '../site/assets/share.js';
import { parseGistUrl, SHARE_FILE as SERVER_SHARE_FILE } from '../src/server/share';
import { SHARE_VIEWER_URL, shareViewerUrl } from '../src/shared/share';
import { HARNESS_RELAY_URL, shareDocument } from '../src/web/share';
import { SITE, VIEWER_FILE } from './site-pages';

// The viewer of a shared conversation on the website (site/share/, site/assets/share.js): the address the
// server gives a share and the gist the viewer reads from it, the raw file it reads (GitHub's API, which a
// browser may ask only 60 times an hour, only when the raw files cannot say where the gist is), the pages it
// shows (Harness Relay's alone), its links, its words in both languages, and the page itself: its policy,
// and the frame that runs nothing the gist holds. The browser half is tried in e2e/specs/share.spec.ts.

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

  it('names the gist by its id alone when gh printed no owner, which the viewer then asks GitHub for', () => {
    const url = shareViewerUrl(undefined, ID);
    expect(url).toBe(`${SHARE_VIEWER_URL}#${ID}`);
    expect(gistOf(new URL(url).hash)).toEqual({ id: ID });
    expect(gistOf(new URL(parseGistUrl(`https://gist.github.com/${ID}`)!.url).hash)).toEqual({ id: ID });
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
      `#me/${ID}/index.html`,
      `#/${ID}`,
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
  it("is the page's raw file on GitHub, by its owner and id, not GitHub's API", () => {
    expect(RAW_HOST).toBe('https://gist.githubusercontent.com/');
    expect(SHARE_FILE).toBe(SERVER_SHARE_FILE);
    expect(rawUrl({ owner: 'me', id: ID })).toBe(`https://gist.githubusercontent.com/me/${ID}/raw/index.html`);
    expect(rawUrl({ owner: 'me', id: ID })).not.toContain('api.github.com');
    expect(gistPage({ owner: 'me', id: ID })).toBe(`https://gist.github.com/me/${ID}`);
    expect(gistPage({ id: ID })).toBe(`https://gist.github.com/${ID}`);
  });

  it("finds a gist the raw files do not have under its owner (renamed since), or whose owner the link does not name, through GitHub's API", () => {
    expect(API_HOST).toBe('https://api.github.com/');
    expect(apiUrl(ID)).toBe(`https://api.github.com/gists/${ID}`);
    const raw = `https://gist.githubusercontent.com/New-Name/${ID}/raw/0123abcd/index.html`;
    const info = (o: { id?: string; owner?: unknown; raw?: unknown; file?: string } = {}) => ({
      id: o.id ?? ID,
      owner: o.owner === undefined ? { login: 'New-Name' } : o.owner,
      files: { [o.file ?? 'index.html']: { raw_url: o.raw === undefined ? raw : o.raw, content: '<p>cut off at 1 MB</p>' } },
    });
    expect(pageFromApi(info(), ID)).toEqual({ owner: 'New-Name', raw });
    // Its raw address, under that owner in any case, and nothing else.
    expect(pageFromApi(info({ raw: raw.replace('New-Name', 'new-name') }), ID)?.owner).toBe('New-Name');
    for (const bad of [
      info({ id: 'f'.repeat(32) }),
      info({ file: 'other.html' }),
      info({ raw: raw.replace('gist.githubusercontent.com', 'evil.example') }),
      info({ raw: raw.replace('https:', 'http:') }),
      info({ raw: raw.replace('New-Name', 'someone-else') }),
      info({ raw: raw.replace(ID, 'f'.repeat(32)) }),
      info({ raw: 'not a url' }),
      info({ raw: 42 }),
      info({ owner: { login: 'not a name' } }),
      info({ owner: null }),
    ]) {
      expect(pageFromApi(bad, ID), JSON.stringify(bad)).toBeUndefined();
    }
    expect(pageFromApi(null, ID)).toBeUndefined();
    expect(pageFromApi('{}', ID)).toBeUndefined();
  });

  describe('reading a gist', () => {
    const RAW = `https://gist.githubusercontent.com/New-Name/${ID}/raw/0a1b2c/index.html`;
    /** GitHub stood in for: each address's status (and body), or a failure to reach it; what was asked. */
    function github(answers: Record<string, number | 'unreachable'>) {
      const asked: string[] = [];
      const get = async (url: string) => {
        asked.push(url);
        const answer = answers[url] ?? 404;
        if (answer === 'unreachable') throw new TypeError('Failed to fetch');
        const body = url.startsWith(API_HOST)
          ? JSON.stringify({ id: ID, owner: { login: 'New-Name' }, files: { 'index.html': { raw_url: RAW } } })
          : `<p>${url}</p>`;
        return { status: answer, text: async () => body, json: async () => JSON.parse(body) as unknown };
      };
      return { get, asked };
    }
    const raw = (owner: string) => rawUrl({ owner, id: ID });

    it('reads the raw file under its owner, and asks the API nothing', async () => {
      const gh = github({ [raw('me')]: 200 });
      expect(await readPage({ owner: 'me', id: ID }, gh.get)).toEqual({ gist: { owner: 'me', id: ID }, html: `<p>${raw('me')}</p>` });
      expect(gh.asked).toEqual([raw('me')]);
    });

    it('finds it through the API when the raw files have none under that owner, or the link names none', async () => {
      for (const gist of [{ owner: 'old-name', id: ID }, { id: ID }]) {
        const gh = github({ [apiUrl(ID)]: 200, [RAW]: 200 });
        expect(await readPage(gist, gh.get)).toEqual({ gist: { owner: 'New-Name', id: ID }, html: `<p>${RAW}</p>` });
        expect(gh.asked).toEqual([...(gist.owner ? [raw('old-name')] : []), apiUrl(ID), RAW]);
      }
    });

    it('says it is not found when neither has it, whatever the API cannot say', async () => {
      for (const api of [404, 403, 'unreachable'] as const) {
        expect(await readPage({ owner: 'me', id: ID }, github({ [apiUrl(ID)]: api }).get), String(api)).toEqual({
          failure: { kind: 'notFound' },
        });
      }
    });

    it('says what GitHub answered otherwise, and throws when it cannot be reached', async () => {
      const down = github({ [raw('me')]: 503 });
      expect(await readPage({ owner: 'me', id: ID }, down.get)).toEqual({
        failure: { kind: 'failed', detail: 'HTTP 503' },
        gist: { owner: 'me', id: ID },
      });
      expect(down.asked).toEqual([raw('me')]);
      // The id alone, and the API at its limit: only it could have said.
      expect(await readPage({ id: ID }, github({ [apiUrl(ID)]: 403 }).get)).toEqual({ failure: { kind: 'failed', detail: 'HTTP 403' } });
      await expect(readPage({ owner: 'me', id: ID }, github({ [raw('me')]: 'unreachable' }).get)).rejects.toThrow('Failed to fetch');
      await expect(readPage({ id: ID }, github({ [apiUrl(ID)]: 'unreachable' }).get)).rejects.toThrow('Failed to fetch');
    });
  });

  it('shows only a page Harness Relay shared, as every page it shares says', () => {
    expect(isSharedPage(GENERATOR)).toBe(true);
    for (const other of [undefined, null, '', 'harness relay', 'Harness Relay 2', 'Other'])
      expect(isSharedPage(other), String(other)).toBe(false);
    const made = shareDocument({ lang: 'en', title: 'Plan', css: '', body: '<p>hi</p>' });
    expect(made).toContain(`<meta name="generator" content="${GENERATOR}">`);
  });

  it('says a gist that is not there apart from one GitHub could not give', () => {
    expect(failureOf(200)).toBeUndefined();
    expect(failureOf(404)).toEqual({ kind: 'notFound' });
    expect(failureOf(403)).toEqual({ kind: 'failed', detail: 'HTTP 403' });
    expect(failureOf(503)).toEqual({ kind: 'failed', detail: 'HTTP 503' });
  });

  it("points the page's own links at its frame, and opens every other one in a tab that never learns what opened it", () => {
    expect(linkPlan('#quote-1-0')).toEqual({ href: 'about:srcdoc#quote-1-0' });
    expect(linkPlan('#')).toEqual({ href: 'about:srcdoc#' });
    const out = { target: '_blank', rel: 'noopener noreferrer' };
    expect(linkPlan('https://gist.githubusercontent.com/me/x/raw/a.pdf')).toEqual({
      href: 'https://gist.githubusercontent.com/me/x/raw/a.pdf',
      ...out,
    });
    expect(linkPlan('https://example.com/#top')).toEqual({ href: 'https://example.com/#top', ...out });
    expect(linkPlan('')).toEqual({ href: '', ...out });
    expect(linkPlan(null)).toBeUndefined();
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

  it("runs its own script alone and reads only GitHub's raw files and API, with nothing else to load", () => {
    expect(policy).toBeDefined();
    expect(Object.fromEntries(directives)).toEqual({
      'default-src': "'none'",
      'script-src': "'self'",
      'style-src': "'unsafe-inline'",
      'img-src': 'data:',
      'connect-src': `${RAW_HOST.slice(0, -1)} ${API_HOST.slice(0, -1)}`,
      'frame-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'none'",
    });
    // Its one script, a module of the site's: no script written into the page, which the policy would refuse.
    // Any case: HTML's tag names have none, and `<SCRIPT>` would be one more.
    expect([...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])).toEqual(['<script type="module" src="../assets/share.js">']);
    expect(exists('site/assets/share.js')).toBe(true);
    // Its icon the site's own, as a data URL: the policy, which the frame inherits too, allows no other image.
    const icon = /<link rel="icon" href="([^"]+)"/.exec(head)?.[1];
    expect(icon?.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(icon!.slice('data:image/svg+xml,'.length))).toBe(read('site/favicon.svg').trim());
  });

  it('shows the gist in a frame that runs nothing it holds, with an origin of its own', () => {
    const frames = [...html.matchAll(/<iframe\b[^>]*>/gi)].map((m) => m[0]);
    expect(frames).toHaveLength(1);
    const sandbox = /\ssandbox="([^"]*)"/.exec(frames[0]!)?.[1];
    // Its links open in a tab of their own, as a normal page, where the files that went along download:
    // nothing else (no scripts, forms, same origin, or moving this page elsewhere).
    expect(sandbox?.split(/\s+/).sort()).toEqual(['allow-downloads', 'allow-popups', 'allow-popups-to-escape-sandbox']);
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
