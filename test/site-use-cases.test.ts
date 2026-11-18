import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { USE_CASES } from '../scripts/demo/use-cases/cases';
import { USE_CASE_PAGES, useCaseFiles, useCaseMedia } from '../scripts/demo/use-cases/publish';

// The website's use cases: the use-cases page in each language (site/use-cases/, site/zh-TW/use-cases/), each
// use case's section with its recording, chapters and what was asked, the home pages' list of them, the
// READMEs' links to them, and what search engines read about them. The recordings come from npm run use-cases.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const exists = (path: string) => existsSync(new URL(`../${path}`, import.meta.url));
const SITE = 'https://agentic-system-lab.github.io/harness-relay/';
const LANGS = ['en', 'zh-TW'] as const;
const HOME = { en: 'site/index.html', 'zh-TW': 'site/zh-TW/index.html' } as const;
const README = { en: 'README.md', 'zh-TW': 'README.zh-TW.md' } as const;
const CANONICAL = { en: `${SITE}use-cases/`, 'zh-TW': `${SITE}zh-TW/use-cases/` } as const;

type Node = Record<string, unknown> & { '@type': string; '@id': string };

/** Text as a page has it in its markup (what `html.escape` writes). */
const escaped = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
const unescaped = (s: string) =>
  s.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/**
 * Markup's text: every tag dropped, from its `<` to the `>` that ends it, in one walk (a pattern removed
 * once could leave a tag that its removal put together, as `<scr<b>ipt>` would `<script>`), then the
 * entities read. No `<` of the markup is left: one in the text is the `&lt;` it was written as.
 */
function textOf(html: string): string {
  let text = '';
  let inTag = false;
  for (const c of html) {
    if (inTag) inTag = c !== '>';
    else if (c === '<') inTag = true;
    else text += c;
  }
  return unescaped(text);
}

/** A use case section's heading, as text (its phrase spans dropped). */
const h2Text = (section: string) => textOf(section.match(/<h2 id="[^"]+">([\s\S]*?)<\/h2>/)![1]!);

/** A video file's length in seconds, from its MP4 movie header. */
function mp4Seconds(path: string): number {
  const b = readFileSync(new URL(`../${path}`, import.meta.url));
  const at = b.indexOf('mvhd');
  const v1 = b[at + 4] === 1;
  const scale = b.readUInt32BE(at + (v1 ? 24 : 16));
  const length = v1 ? Number(b.readBigUInt64BE(at + 28)) : b.readUInt32BE(at + 20);
  return length / scale;
}

/** Columns a line takes in a search result, a CJK or fullwidth character as two. */
const columns = (s: string) => [...s].reduce((n, c) => n + (/[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(c) ? 2 : 1), 0);

function page(lang: (typeof LANGS)[number]) {
  const html = read(USE_CASE_PAGES[lang]);
  const head = html.split('</head>')[0]!;
  const scripts = [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(scripts, lang).toHaveLength(1);
  const data = JSON.parse(scripts[0]![1]!) as { '@context': string; '@graph': Node[] };
  const meta = (attr: string, name: string) => head.match(new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"\\s*/>`))?.[1];
  const sections = new Map(
    [...html.matchAll(/<section class="section usecase" id="([^"]+)"[\s\S]*?<\/section>/g)].map((m) => [m[1]!, m[0]] as const),
  );
  return {
    html,
    head,
    data,
    sections,
    title: head.match(/<title>([^<]*)<\/title>/)![1]!,
    description: meta('name', 'description')!,
    canonical: head.match(/<link rel="canonical" href="([^"]+)" \/>/)![1]!,
    alternates: [...head.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)" \/>/g)].map((m) => [m[1], m[2]]),
    url: (relative: string) => new URL(relative, CANONICAL[lang]).href,
  };
}

/** The repository file a published address is served from. */
const published = (url: string) => `site/${new URL(url).pathname.replace(/^\/harness-relay\//, '')}`;

describe('the use-cases pages', () => {
  it("read a heading's text with no tag left, also one that dropping another would put together", () => {
    expect(textOf('Read <span class="phrase">the mail</span>')).toBe('Read the mail');
    expect(textOf('<scr<b>ipt>alert(1)</scr</b>ipt>')).toBe('ipt>alert(1)ipt>');
    expect(textOf('a &lt;b&gt; tag &amp; more')).toBe('a <b> tag & more');
  });

  it('are at their canonical addresses, each naming the other as its language alternate, as the sitemap lists them', () => {
    const sitemap = read('site/sitemap.xml');
    for (const lang of LANGS) {
      const p = page(lang);
      expect(p.canonical).toBe(CANONICAL[lang]);
      expect(p.alternates).toEqual([
        ['en', CANONICAL.en],
        ['zh-TW', CANONICAL['zh-TW']],
        ['x-default', CANONICAL.en],
      ]);
      expect(sitemap).toContain(`<loc>${CANONICAL[lang]}</loc>`);
      expect(p.html.match(/<html lang="([^"]+)">/)![1]).toBe(lang === 'en' ? 'en' : 'zh-Hant-TW');
      // The meta description, as the home pages' is: the name first, and it fits in a search result.
      expect(p.description.startsWith('Harness Relay '), lang).toBe(true);
      expect(columns(p.description), lang).toBeLessThanOrEqual(160);
      expect(columns(p.description), lang).toBeGreaterThanOrEqual(70);
    }
  });

  it('show the five use cases in order, the same sections in both languages', () => {
    for (const lang of LANGS) {
      const { sections, html } = page(lang);
      expect([...sections.keys()], lang).toEqual(USE_CASES.map((u) => u.slug));
      // One h1, and each use case under an h2 of its own, with the jump list pointing at each.
      expect(html.match(/<h1\b/g), lang).toHaveLength(1);
      const jump = html.match(/<nav class="uc-jump"[\s\S]*?<\/nav>/)![0];
      expect(
        [...jump.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]),
        lang,
      ).toEqual(USE_CASES.map((u) => u.slug));
      for (const [slug, s] of sections) {
        expect(s, slug).toContain(`<h2 id="${slug}-title">`);
        // A heading split into phrases (each kept whole on a narrow screen) only between them.
        const inner = s.match(/<h2 id="[^"]+">([\s\S]*?)<\/h2>/)![1]!;
        if (inner.includes('<')) expect(inner, slug).toMatch(/^(<span class="phrase">[^<\s][^<]*[^<\s]<\/span> ?)+$/);
      }
    }
  });

  it('quote what each recording asked, word for word, in the page’s language', () => {
    for (const lang of LANGS) {
      const { sections } = page(lang);
      for (const uc of USE_CASES) {
        const asked = uc.text[lang].question ?? uc.text[lang].message!;
        const quote = sections.get(uc.slug)!.match(/<blockquote>([\s\S]*?)<\/blockquote>/)![1]!;
        expect(unescaped(quote), `${uc.slug} ${lang}`).toBe(asked);
      }
    }
  });

  it('play each use case’s own recording, with its poster, both in the site', () => {
    for (const lang of LANGS) {
      const p = page(lang);
      for (const uc of USE_CASES) {
        const s = p.sections.get(uc.slug)!;
        const video = s.match(/<video[\s\S]*?<\/video>/)![0];
        const media = useCaseMedia(uc.slug, lang);
        expect(video, uc.slug).toContain(`id="${uc.slug}-video"`);
        expect(published(p.url(video.match(/poster="([^"]+)"/)![1]!)), uc.slug).toBe(media.poster);
        expect(published(p.url(video.match(/<source src="([^"]+)"/)![1]!)), uc.slug).toBe(media.video);
        expect(exists(media.video), media.video).toBe(true);
        expect(exists(media.poster), media.poster).toBe(true);
        expect(exists(`${media.poster}.json`), `${media.poster}.json`).toBe(true);
        // Muted and not loaded until it plays, as the demo is.
        for (const attr of ['controls', 'muted', 'loop', 'playsinline', 'preload="none"'])
          expect(video, `${uc.slug} ${attr}`).toContain(attr);
      }
    }
  });

  it('time each chapter rail by its recording: from 0:00, in order, inside the video', () => {
    for (const lang of LANGS) {
      const p = page(lang);
      for (const uc of USE_CASES) {
        const s = p.sections.get(uc.slug)!;
        const times = [...s.matchAll(/<button class="chapter[^"]*" type="button" data-t="(\d+)">\s*<time>(\d+):(\d\d)<\/time>/g)].map(
          (m) => {
            expect(Number(m[2]) * 60 + Number(m[3]), `${uc.slug} ${lang}`).toBe(Number(m[1]));
            return Number(m[1]);
          },
        );
        expect(times.length, `${uc.slug} ${lang}`).toBeGreaterThanOrEqual(5);
        expect(times[0], `${uc.slug} ${lang}`).toBe(0);
        expect(
          [...times].sort((a, b) => a - b),
          `${uc.slug} ${lang}`,
        ).toEqual(times);
        expect(times.at(-1)!, `${uc.slug} ${lang}`).toBeLessThan(mp4Seconds(useCaseMedia(uc.slug, lang).video));
        // Every chapter's sentence filled in.
        for (const say of s.matchAll(/<span class="say">([^<]*)<\/span>/g)) expect(say[1], uc.slug).not.toMatch(/[{}]/);
      }
    }
  });

  it('end on the download button for the visitor’s system, on the releases page until downloads.js knows the installer', () => {
    for (const lang of LANGS) {
      const { html } = page(lang);
      const cta = html.match(/<section class="section start uc-cta"[\s\S]*?<\/section>/)![0];
      expect(cta, lang).toMatch(
        /<a [^>]*href="https:\/\/github\.com\/Agentic-System-Lab\/harness-relay\/releases"[^>]*data-download-primary/,
      );
      for (const word of ['data-mac=', 'data-win=', 'data-win-arm64=', 'data-linux=', 'data-linux-arm64=', 'data-release=', 'data-mobile='])
        expect(cta, `${lang} ${word}`).toContain(word);
      // The requirements, the other systems and Codespaces: the landing page's quick start, in the page's language.
      expect(cta, lang).toContain('href="../#start"');
      expect(html, lang).toContain(`<script type="module" src="${lang === 'en' ? '../' : '../../'}assets/downloads.js"></script>`);
      // The page's last section.
      expect(html.indexOf(cta) + cta.length, lang).toBe(html.indexOf('</section>\n    </main>') + '</section>'.length);
    }
  });

  it('link each use case’s conversation as it was shared, and the files attached to its question as GitHub shows them', () => {
    for (const lang of LANGS) {
      const p = page(lang);
      for (const uc of USE_CASES) {
        const s = p.sections.get(uc.slug)!;
        const links = s.match(/<ul class="usecase-links">([\s\S]*?)<\/ul>/)?.[1];
        expect(links, `${uc.slug} ${lang}`).toBeTruthy();
        // Right under what was asked.
        expect(s, `${uc.slug} ${lang}`).toMatch(/<\/blockquote>\s*<ul class="usecase-links">/);
        const shared = [...links!.matchAll(/href="(https:\/\/gistpreview\.github\.io\/\?[0-9a-f]{20,})"/g)];
        expect(shared, `${uc.slug} ${lang}`).toHaveLength(1);
        // Every attached file it links to is in the repository, shown on GitHub (never a download), and nothing else is in its folder.
        expect(links!, `${uc.slug} ${lang}`).not.toContain(' download');
        const files = [...links!.matchAll(/href="https:\/\/github\.com\/Agentic-System-Lab\/harness-relay\/blob\/main\/([^"]+)"/g)].map(
          (m) => decodeURIComponent(m[1]!),
        );
        const folder = useCaseFiles(uc.slug, lang);
        for (const f of files) {
          expect(f.startsWith(`${folder}/`), f).toBe(true);
          expect(exists(f), f).toBe(true);
        }
        const held = exists(folder) ? readdirSync(new URL(`../${folder}`, import.meta.url)) : [];
        expect(held.sort(), `${uc.slug} ${lang}`).toEqual(files.map((f) => f.split('/').pop()!).sort());
      }
    }
  });

  it('link the user guide in the page’s language', () => {
    for (const lang of LANGS) {
      const guide = lang === 'en' ? 'docs/user-guide.md' : 'docs/user-guide.zh-TW.md';
      const doc = read(guide);
      const anchors = new Set(
        [...doc.matchAll(/^#{2,3} (.+)$/gm)].map((m) =>
          m[1]!
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, '')
            .replace(/\s/g, '-'),
        ),
      );
      const links = [
        ...page(lang).html.matchAll(/href="https:\/\/github\.com\/Agentic-System-Lab\/harness-relay\/blob\/main\/(docs\/[^"#]+)#([^"]+)"/g),
      ];
      expect(links.length, lang).toBeGreaterThanOrEqual(15);
      for (const [, file, anchor] of links) {
        expect(file, lang).toBe(guide);
        expect(anchors.has(anchor!), `${lang} #${anchor}`).toBe(true);
      }
    }
  });
});

describe('the use-cases pages’ structured data', () => {
  it('is the page and one VideoObject per use case, each as the page plays it', () => {
    for (const lang of LANGS) {
      const p = page(lang);
      expect(p.data['@context']).toBe('https://schema.org');
      const web = p.data['@graph'].filter((n) => n['@type'] === 'WebPage');
      expect(web, lang).toHaveLength(1);
      expect(web[0]).toMatchObject({
        '@id': `${p.canonical}#webpage`,
        url: p.canonical,
        name: p.title,
        description: p.description,
        inLanguage: lang,
        // The site and the app are described on the home page, under the same @id.
        isPartOf: { '@id': `${SITE}#website` },
        about: { '@id': `${SITE}#app` },
      });
      expect(read('site/index.html')).toContain(`"@id": "${SITE}#website"`);
      expect(read('site/index.html')).toContain(`"@id": "${SITE}#app"`);
      const videos = p.data['@graph'].filter((n) => n['@type'] === 'VideoObject');
      expect(
        videos.map((v) => v['@id']),
        lang,
      ).toEqual(USE_CASES.map((u) => `${p.canonical}#${u.slug}-video`));
      expect(web[0]!.video, lang).toEqual(videos.map((v) => ({ '@id': v['@id'] })));
      expect(web[0]!.primaryImageOfPage).toBe(videos[0]!.thumbnailUrl);
      for (const uc of USE_CASES) {
        const v = videos.find((n) => n['@id'].endsWith(`#${uc.slug}-video`))!;
        const s = p.sections.get(uc.slug)!;
        const tag = s.match(/<video[\s\S]*?<\/video>/)![0];
        expect(Object.keys(v).sort(), uc.slug).toEqual(
          ['@id', '@type', 'contentUrl', 'description', 'duration', 'inLanguage', 'name', 'thumbnailUrl', 'uploadDate'].sort(),
        );
        expect(v.contentUrl, uc.slug).toBe(p.url(tag.match(/<source src="([^"]+)"/)![1]!));
        expect(v.thumbnailUrl, uc.slug).toBe(p.url(tag.match(/poster="([^"]+)"/)![1]!));
        expect(escaped(String(v.description)), uc.slug).toBe(tag.match(/aria-label="([^"]+)"/)![1]);
        expect(String(v.name), uc.slug).toContain(h2Text(s));
        expect(v.inLanguage).toBe(lang);
        const uploaded = String(v.uploadDate);
        expect(uploaded, uc.slug).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(Date.parse(uploaded), uc.slug).toBeLessThanOrEqual(Date.now());
        const d = String(v.duration).match(/^PT(?:(\d+)M)?(\d+)S$/)!;
        expect(d, uc.slug).not.toBeNull();
        const seconds = Number(d[1] ?? 0) * 60 + Number(d[2]);
        expect(Math.abs(seconds - mp4Seconds(published(String(v.contentUrl)))), `${uc.slug} ${lang}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the use cases on the home pages and in the READMEs', () => {
  it('are listed on each home page, in order, each card linking to its section and showing its poster', () => {
    for (const lang of LANGS) {
      const html = read(HOME[lang]);
      const section = html.match(/<section class="section" id="use-cases"[\s\S]*?<\/section>/)![0];
      const cards = section.split('<li class="case">').slice(1);
      expect(
        cards.map((c) => c.match(/href="use-cases\/#([^"]+)"/)![1]),
        lang,
      ).toEqual(USE_CASES.map((u) => u.slug));
      for (const [i, card] of cards.entries()) {
        const slug = USE_CASES[i]!.slug;
        const img = card.match(/<img src="([^"]+)"/)![1]!;
        expect(published(new URL(img, `${SITE}${lang === 'en' ? '' : 'zh-TW/'}`).href), slug).toBe(useCaseMedia(slug, lang).poster);
        // The card's title is the section's heading.
        const title = unescaped(card.match(/<span class="case-title">([^<]+)<\/span>/)![1]!);
        expect(h2Text(page(lang).sections.get(slug)!), slug).toBe(title);
      }
      expect(section, lang).toContain('<a class="text-link" href="use-cases/">');
      // The header's section links lead to it.
      expect(html.match(/<nav class="site-nav"[\s\S]*?<\/nav>/)![0], lang).toContain('<a href="#use-cases">');
    }
  });

  it('are linked from each README, to its section on the page in the README’s language', () => {
    for (const lang of LANGS) {
      const md = read(README[lang]);
      const heading = lang === 'en' ? '## Use cases' : '## 使用情境';
      expect(md, lang).toContain(`\n${heading}\n`);
      const part = md.slice(md.indexOf(`\n${heading}\n`) + 1).split('\n## ')[0]!;
      expect(part, lang).toContain(`](${CANONICAL[lang]})`);
      const links = [...part.matchAll(/^- \*\*\[([^\]]+)\]\(([^)]+)\)\*\*/gm)];
      expect(
        links.map((m) => m[2]),
        lang,
      ).toEqual(USE_CASES.map((u) => `${CANONICAL[lang]}#${u.slug}`));
      for (const [i, m] of links.entries()) {
        // Each link is named as the section's heading.
        expect(h2Text(page(lang).sections.get(USE_CASES[i]!.slug)!), m[1]).toBe(m[1]);
      }
    }
  });
});
