import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INSTALLERS } from '../site/assets/downloads.js';
import { opencodeSandboxUnsupported } from '../src/server/agents/opencode';
import { DEFAULT_HOST } from '../src/server/ports';
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

/** The systems with an installer, as words: "macOS (Apple Silicon), Windows (x64 and Arm64) and Linux (x64 and Arm64)". */
const systemsInWords = () => {
  const names: Record<string, string> = { mac: 'macOS', win: 'Windows', linux: 'Linux' };
  const systems = new Map<string, string[]>();
  for (const [key, ending] of Object.entries(INSTALLERS)) {
    const name = names[key.split('-')[0]];
    const processor = key === 'mac' ? 'Apple Silicon' : ending.includes('arm64') ? 'Arm64' : 'x64';
    systems.set(name, [...(systems.get(name) ?? []), processor]);
  }
  const each = [...systems].map(([name, processors]) => `${name} (${processors.join(' and ')})`);
  return `${each.slice(0, -1).join(', ')} and ${each.at(-1)}`;
};

/** A whole word or name in text, not a part of a longer one ("Pi", not "Pipeline"). */
const word = (s: string) => new RegExp(`(?<![\\w-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);

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
      // And the nodes are tied together: the page is part of the site, about the app, with the demo; the site
      // and the app are the organisation's; the source code is the app's.
      const ref = (type: string) => ({ '@id': node(data, type)['@id'] });
      const web = node(data, 'WebPage');
      expect(web.isPartOf, file).toEqual(ref('WebSite'));
      expect(web.about, file).toEqual(ref('SoftwareApplication'));
      expect(web.video, file).toEqual(ref('VideoObject'));
      expect(node(data, 'WebSite').publisher, file).toEqual(ref('Organization'));
      expect(node(data, 'SoftwareApplication').publisher, file).toEqual(ref('Organization'));
      expect(node(data, 'SoftwareSourceCode').targetProduct, file).toEqual(ref('SoftwareApplication'));
    }
  });

  it('has only the properties checked here: a new one is a new fact to check against the page', () => {
    const properties: Record<string, string[]> = {
      WebPage: ['@id', '@type', 'about', 'description', 'inLanguage', 'isPartOf', 'name', 'primaryImageOfPage', 'url', 'video'],
      WebSite: ['@id', '@type', 'inLanguage', 'name', 'publisher', 'url'],
      Organization: ['@id', '@type', 'name', 'sameAs', 'url'],
      SoftwareApplication: [
        '@id',
        '@type',
        'applicationCategory',
        'description',
        'downloadUrl',
        'image',
        'inLanguage',
        'license',
        'name',
        'operatingSystem',
        'publisher',
        'sameAs',
        'screenshot',
        'url',
      ],
      SoftwareSourceCode: ['@id', '@type', 'codeRepository', 'license', 'name', 'targetProduct'],
      VideoObject: ['@id', '@type', 'contentUrl', 'description', 'duration', 'inLanguage', 'name', 'thumbnailUrl', 'uploadDate'],
    };
    for (const { file } of PAGES) {
      for (const n of page(file).data['@graph'])
        expect(Object.keys(n).sort(), `${file} ${n['@type']}`).toEqual([...properties[n['@type']]].sort());
    }
  });

  it('names its publisher by the GitHub account the page’s repository is under, and the app’s languages as the app has them', () => {
    const { data, html } = page('site/index.html');
    const org = node(data, 'Organization');
    expect(org.url).toBe('https://agentic-system-lab.github.io/');
    expect(org.sameAs).toEqual(['https://github.com/Agentic-System-Lab']);
    expect(html).toContain(`href="${(org.sameAs as string[])[0]}/harness-relay"`);
    expect(REPO.startsWith(`${(org.sameAs as string[])[0]}/`)).toBe(true);
    // As the org's homepage (its url) names itself in its <title>.
    expect(org.name).toBe('Agentic System Lab');
    // The UI's two locales (src/web/locales/), as each page's feature list says ("English and 繁體中文").
    expect(node(data, 'SoftwareApplication').inLanguage).toEqual(PAGES.map((p) => p.lang));
    expect(node(data, 'WebSite').inLanguage).toEqual(PAGES.map((p) => p.lang));
    for (const lang of ['en', 'zh-TW']) expect(exists(`src/web/locales/${lang}.ts`), lang).toBe(true);
    expect(html).toContain('<li><b>English and 繁體中文</b>');
    expect(read('site/zh-TW/index.html')).toContain('<li><b>English 與繁體中文</b>');
  });

  it('says of the page what its <head> says: address, title, description, language and picture', () => {
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
      // Written by npm run demo (scripts/demo/publish.ts, retimeVideoData()) when the video is replaced: a real
      // time in UTC to the second, as toISOString() writes it, and not one still to come.
      const uploaded = String(video.uploadDate);
      expect(uploaded, file).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(new Date(uploaded).toISOString(), file).toBe(uploaded.replace('Z', '.000Z'));
      expect(Date.parse(uploaded), file).toBeLessThanOrEqual(Date.now());
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
      // The license by the name and address the footer's link gives it (the app says what it is, not only where).
      const [, href, name] = p.html.match(/<footer[\s\S]*?<a href="([^"]+\/LICENSE)">([^<]+)<\/a>/)!;
      const license = { '@type': 'CreativeWork', name, url: href };
      expect(app.license, file).toEqual(license);
      expect(source.license, file).toEqual(license);
      expect(read('LICENSE'), file).toContain(`under the ${name}, Version 1.0`);
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

  it('claims nothing the page may not: no version, size, price, star or download count, rating or review', () => {
    // The page reads the version and the stars from GitHub as it loads, shows no installer sizes, has no ratings
    // (DESIGN-GUIDELINES.md, "Facts only") and names no price: it says nothing of one.
    const never = [
      'softwareVersion',
      'version',
      'fileSize',
      'offers',
      'price',
      'isAccessibleForFree',
      'aggregateRating',
      'review',
      'ratingValue',
      'ratingCount',
      'reviewCount',
      'interactionStatistic',
      'userInteractionCount',
      'downloadCount',
    ];
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
    for (const label of Object.values(PROVIDER_LABEL)) expect(summary, label).toMatch(word(label));
  });

  it('states what the code does: the systems with an installer, the Node.js it needs, where it listens', () => {
    expect(text).toContain(`a desktop app for ${systemsInWords()}`);
    const node = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node;
    expect(node).toMatch(/^>=\d+\.\d+$/);
    expect(text).toContain(`Node.js ${node.slice(2)} or later`);
    expect(text).toContain(`The server listens on ${DEFAULT_HOST} `);
  });

  it('says where Harness Relay’s own sandbox does not run, as the code has it, and so do both pages', () => {
    // OpenCode on Linux runs only with full access (its server cannot be watched from outside the sandbox).
    expect(opencodeSandboxUnsupported('linux')).toBeTruthy();
    expect(opencodeSandboxUnsupported('darwin')).toBeUndefined();
    expect(text).toContain('on native Windows they run only with full access, and so does OpenCode on Linux.');
    const [en, zh] = PAGES.map(({ file }) => read(file));
    expect(en).toContain('on native Windows they run only with full access, and so does OpenCode on Linux.');
    expect(en).toContain('(on native\n              Windows, and for OpenCode on Linux, they run only with full access)');
    expect(zh).toContain('在原生 Windows 上只能以完全存取執行，Linux 上的 OpenCode 也是。');
    expect(zh).toContain('（在原生 Windows 上，以及 Linux 上的 OpenCode，只能以完全存取執行）');
  });

  it('links to the pages at their canonical addresses, and to files that are in the repository', () => {
    // The home pages, and the use-cases pages and the docs' overviews (test/site-use-cases.test.ts and
    // test/site-docs.test.ts check theirs).
    const canonical = [
      ...PAGES.map(({ file }) => page(file).canonical),
      ...['site/use-cases/index.html', 'site/zh-TW/use-cases/index.html', 'site/docs/index.html', 'site/zh-TW/docs/index.html'].map(
        (file) => read(file).match(/<link rel="canonical" href="([^"]+)" \/>/)![1],
      ),
    ];
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
    expect(
      links
        .filter((l) => l.url.startsWith(SITE))
        .map((l) => l.url)
        .sort(),
    ).toEqual([...canonical].sort());
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

  it('is published with the pages: the Pages workflow copies site/ and deletes nothing it is', () => {
    const workflow = read('.github/workflows/pages.yml');
    expect(workflow).toMatch(/cp -R site\/\. _site\//);
    // Every file the workflow deletes from the site again is matched by a -name pattern of its find … -delete.
    const deletes = workflow.split('\n').filter((line) => /\bfind _site\b/.test(line) && /-delete\b/.test(line));
    expect(deletes).toHaveLength(1);
    const patterns = [...deletes[0].matchAll(/-name '([^']+)'/g)].map((m) => m[1]);
    expect(patterns.length).toBeGreaterThan(0);
    const glob = (p: string) =>
      new RegExp(
        `^${p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replaceAll('*', '.*')
          .replaceAll('?', '.')}$`,
      );
    for (const pattern of patterns) expect(glob(pattern).test('llms.txt'), pattern).toBe(false);
    // The patterns are read right: the design guidelines, which are deleted, match one.
    expect(patterns.some((p) => glob(p).test('DESIGN-GUIDELINES.md'))).toBe(true);
  });
});
