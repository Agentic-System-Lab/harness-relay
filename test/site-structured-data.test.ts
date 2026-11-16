import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INSTALLERS } from '../site/assets/downloads.js';
import { PROVIDER_LABEL } from '../src/shared/types';

// What search and answer engines (Google, Bing, ChatGPT search, Perplexity, the coding agents that read
// llms.txt) are told about the landing page beyond its text: each page's JSON-LD, its meta description, and
// site/llms.txt. They state only what the page and the repository do (the guidelines' "Facts only"), so this
// keeps them in step with the page's own <head> and markup, with each other in both languages, and with the
// files they point at.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const exists = (path: string) => existsSync(new URL(`../${path}`, import.meta.url));
const SITE = 'https://agentic-system-lab.github.io/harness-relay/';
const REPO = 'https://github.com/Agentic-System-Lab/harness-relay';
const RAW = 'https://raw.githubusercontent.com/Agentic-System-Lab/harness-relay/main/';
const PAGES = [
  { file: 'site/index.html', lang: 'en' },
  { file: 'site/zh-TW/index.html', lang: 'zh-TW' },
];

type Node = Record<string, unknown> & { '@type': string; '@id': string };

/** What a page's <head> and body say, read as text. */
function page(file: string) {
  const html = read(file);
  const head = html.split('</head>')[0];
  const meta = (attr: string, name: string) => {
    const m = head.match(new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"\\s*/>`));
    expect(m, `${file} ${name}`).not.toBeNull();
    return m![1];
  };
  const scripts = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(scripts, file).toHaveLength(1);
  const data = JSON.parse(scripts[0][1]) as { '@context': string; '@graph': Node[] };
  const canonical = head.match(/<link rel="canonical" href="([^"]+)" \/>/)![1];
  const video = html.match(/<video[\s\S]*?<\/video>/)![0];
  return {
    html,
    data,
    canonical,
    title: head.match(/<title>([^<]*)<\/title>/)![1],
    description: meta('name', 'description'),
    ogDescription: meta('property', 'og:description'),
    ogImage: meta('property', 'og:image'),
    /** The page's own language, as its hreflang alternates name it. */
    hreflang: [...head.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)" \/>/g)].find((m) => m[2] === canonical)![1],
    /** Addresses in the page, made absolute against its canonical address. */
    url: (relative: string) => new URL(relative, canonical).href,
    poster: video.match(/poster="([^"]+)"/)![1],
    source: video.match(/<source src="([^"]+)"/)![1],
    videoLabel: video.match(/aria-label="([^"]+)"/)![1],
    demoTitle: html.match(/<h2 id="demo-title">([^<]+)<\/h2>/)![1],
  };
}

const node = (data: { '@graph': Node[] }, type: string) => {
  const found = data['@graph'].filter((n) => n['@type'] === type);
  expect(found, type).toHaveLength(1);
  return found[0];
};

/** Every value in the graph, with the key it is under. */
function* entries(value: unknown, key = ''): Generator<[string, unknown]> {
  yield [key, value];
  if (Array.isArray(value)) for (const v of value) yield* entries(v, key);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* entries(v, k);
}

/** The repository file a published address is served from (the Pages workflow copies the videos from docs/media/). */
const published = (url: string) => {
  const path = new URL(url).pathname.replace(/^\/harness-relay\//, '');
  if (path.startsWith('media/')) return `docs/${path}`;
  return `site/${path === '' || path.endsWith('/') ? `${path}index.html` : path}`;
};

/** Columns a line takes in a search result, a CJK or fullwidth character as two. */
const columns = (s: string) => [...s].reduce((n, c) => n + (/[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(c) ? 2 : 1), 0);

/** A video file's length in seconds, from its MP4 movie header. */
function mp4Seconds(path: string): number {
  const b = readFileSync(new URL(`../${path}`, import.meta.url));
  const at = b.indexOf('mvhd');
  expect(at, path).toBeGreaterThan(0);
  const v1 = b[at + 4] === 1;
  const scale = b.readUInt32BE(at + (v1 ? 24 : 16));
  const length = v1 ? Number(b.readBigUInt64BE(at + 28)) : b.readUInt32BE(at + 20);
  return length / scale;
}

describe("the landing page's structured data", () => {
  it('is one JSON-LD graph per page, of the page, the site, its publisher, the app, its source code and the demo', () => {
    for (const { file } of PAGES) {
      const { data } = page(file);
      expect(data['@context'], file).toBe('https://schema.org');
      const types = data['@graph'].map((n) => n['@type']).sort();
      expect(types, file).toEqual(['Organization', 'SoftwareApplication', 'SoftwareSourceCode', 'VideoObject', 'WebPage', 'WebSite']);
      // Every reference ({ "@id": … } alone) is to a node of the same graph.
      const ids = new Set(data['@graph'].map((n) => n['@id']));
      for (const [key, value] of entries(data['@graph'])) {
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).join() === '@id') {
          expect(ids.has((value as { '@id': string })['@id']), `${file} ${key}`).toBe(true);
        }
      }
    }
  });

  it("says of the page what its <head> says: address, title, description, language and picture", () => {
    for (const { file, lang } of PAGES) {
      const p = page(file);
      const web = node(p.data, 'WebPage');
      expect(web.url, file).toBe(p.canonical);
      expect(web['@id'], file).toBe(`${p.canonical}#webpage`);
      expect(web.name, file).toBe(p.title);
      expect(web.description, file).toBe(p.description);
      expect(web.inLanguage, file).toBe(lang);
      expect(p.hreflang, file).toBe(lang);
      expect(web.primaryImageOfPage, file).toBe(p.ogImage);
      const app = node(p.data, 'SoftwareApplication');
      expect(app.description, file).toBe(p.ogDescription);
      expect(app.image, file).toBe(p.ogImage);
      expect(app.screenshot, file).toBe(p.url(p.poster));
    }
  });

  it('describes the demo as the page plays it: the same file, poster, words and language', () => {
    for (const { file, lang } of PAGES) {
      const p = page(file);
      const video = node(p.data, 'VideoObject');
      expect(video['@id'], file).toBe(`${p.canonical}#demo`);
      expect(video.contentUrl, file).toBe(p.url(p.source));
      expect(video.thumbnailUrl, file).toBe(p.url(p.poster));
      expect(video.description, file).toBe(p.videoLabel);
      expect(String(video.name).toLowerCase(), file).toContain(p.demoTitle.toLowerCase());
      expect(video.inLanguage, file).toBe(lang);
      // Written by npm run demo (scripts/demo/publish.ts, retimeVideoData()) when the video is replaced.
      expect(String(video.uploadDate), file).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/);
      const duration = String(video.duration).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(\d+)S$/);
      expect(duration, file).not.toBeNull();
      const seconds = Number(duration![1] ?? 0) * 3600 + Number(duration![2] ?? 0) * 60 + Number(duration![3]);
      expect(Math.abs(seconds - mp4Seconds(published(String(video.contentUrl)))), file).toBeLessThanOrEqual(1);
    }
  });

  it('states the same facts about the site, its publisher, the app and its source in both languages', () => {
    const [en, zh] = PAGES.map(({ file }) => page(file).data);
    for (const type of ['WebSite', 'Organization', 'SoftwareSourceCode']) expect(node(zh, type), type).toEqual(node(en, type));
    // The app's words and pictures are in the page's language; nothing else about it differs.
    const facts = (data: typeof en) => {
      const { description: _d, image: _i, screenshot: _s, ...rest } = node(data, 'SoftwareApplication');
      return rest;
    };
    expect(facts(zh)).toEqual(facts(en));
    expect(node(en, 'WebSite').url).toBe(SITE);
    expect(node(en, 'SoftwareApplication').url).toBe(SITE);
  });

  it('points where the page does: the newest release, the license, the repository and the systems with an installer', () => {
    for (const { file } of PAGES) {
      const p = page(file);
      const app = node(p.data, 'SoftwareApplication');
      const source = node(p.data, 'SoftwareSourceCode');
      // The newest release that is not a release candidate (the Release workflow marks those not latest).
      expect(app.downloadUrl, file).toBe(`${REPO}/releases/latest`);
      const license = p.html.match(/<footer[\s\S]*?<a href="([^"]+\/LICENSE)"/)![1];
      expect(app.license, file).toBe(license);
      expect(source.license, file).toBe(license);
      expect(p.html, file).toContain(`href="${REPO}"`);
      expect(source.codeRepository, file).toBe(REPO);
      expect(app.sameAs, file).toEqual([REPO]);
      const systems = [...new Set(Object.keys(INSTALLERS).map((k) => ({ mac: 'macOS', win: 'Windows', linux: 'Linux' })[k.split('-')[0]]))];
      expect(app.operatingSystem, file).toBe(systems.join(', '));
    }
  });

  it('points only at files the site publishes', () => {
    for (const { file } of PAGES) {
      for (const [key, value] of entries(page(file).data)) {
        if (typeof value !== 'string' || !value.startsWith(SITE) || key === '@id') continue;
        expect(exists(published(value)), `${file} ${key}: ${value}`).toBe(true);
      }
    }
  });

  it('claims nothing the page may not: no version, star or download count, rating or review', () => {
    // The page reads the version and the stars from GitHub as it loads, and has no ratings (DESIGN-GUIDELINES.md, "Facts only").
    const never = ['softwareVersion', 'version', 'aggregateRating', 'review', 'ratingValue', 'interactionStatistic', 'userInteractionCount', 'downloadCount'];
    for (const { file } of PAGES) {
      const keys = [...entries(page(file).data)].map(([key]) => key);
      for (const key of never) expect(keys, `${file} ${key}`).not.toContain(key);
    }
  });
});

describe("the landing page's meta description", () => {
  it('starts with the name, and fits in a search result (160 columns, a Chinese character two)', () => {
    for (const { file } of PAGES) {
      const { description } = page(file);
      expect(description.startsWith('Harness Relay '), file).toBe(true);
      expect(columns(description), file).toBeLessThanOrEqual(160);
      expect(columns(description), file).toBeGreaterThanOrEqual(70);
    }
  });
});

describe('site/llms.txt', () => {
  const text = read('site/llms.txt');
  const lines = text.split('\n');
  const links = [...text.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)(?::\s+(.+))?$/gm)].map((m) => ({ title: m[1], url: m[2], notes: m[3] }));

  it('has the shape llmstxt.org gives it: the name, a summary, then sections of links', () => {
    expect(lines[0]).toBe('# Harness Relay');
    expect(lines[1]).toBe('');
    expect(lines[2]).toMatch(/^> Harness Relay is /);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.match(/^# /gm)).toHaveLength(1);
    const sections = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(sections).toEqual(['Website', 'Docs', 'Download', 'Optional']);
    // After the first section, every line is a heading, a link or empty.
    const body = text.slice(text.indexOf('\n## '));
    for (const line of body.split('\n')) expect(line, line).toMatch(/^(|## .+|- \[[^\]]+\]\([^)]+\)(: .+)?)$/);
    for (const link of links) expect(link.notes, link.url).toBeTruthy();
  });

  it('names every agent Harness Relay runs', () => {
    const summary = text.slice(0, text.indexOf('\n## '));
    for (const label of Object.values(PROVIDER_LABEL)) expect(summary, label).toContain(label);
  });

  it('links to the two pages at their canonical addresses, and to files that are in the repository', () => {
    const canonical = PAGES.map(({ file }) => page(file).canonical);
    const sitemap = read('site/sitemap.xml');
    for (const { url } of links) {
      if (url.startsWith(SITE)) {
        expect(canonical, url).toContain(url);
        expect(sitemap, url).toContain(`<loc>${url}</loc>`);
      } else if (url.startsWith(RAW)) {
        expect(exists(url.slice(RAW.length)), url).toBe(true);
      } else {
        expect([REPO, `${REPO}/releases/latest`], url).toContain(url);
      }
    }
    expect(links.filter((l) => l.url.startsWith(SITE)).map((l) => l.url).sort()).toEqual([...canonical].sort());
  });

  it('is right that each doc it links has a Traditional Chinese copy beside it', () => {
    for (const { url } of links) {
      if (!url.startsWith(RAW) || !url.endsWith('.md') || url.endsWith('.zh-TW.md')) continue;
      const doc = url.slice(RAW.length);
      expect(exists(doc.replace(/\.md$/, '.zh-TW.md')), doc).toBe(true);
    }
  });

  it('names the license LICENSE has, and says it is not an open-source one', () => {
    expect(read('LICENSE')).toContain('under the Sustainable Use License, Version 1.0');
    expect(text).toContain('License: the Sustainable Use License 1.0, a source-available license, not an OSI-approved open-source one.');
  });

  it('is published with the pages: the Pages workflow drops only Markdown, provenance sidecars and type declarations', () => {
    const workflow = read('.github/workflows/pages.yml');
    expect(workflow).toContain('cp -R site/. _site/');
    expect(workflow).toContain("find _site \\( -name '*.md' -o -name '*.webp.json' -o -name '*.d.ts' \\) -delete");
  });
});
