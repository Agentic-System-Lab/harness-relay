import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_PAGES, PAGE_FILES, SITE, SITE_PAGES, VIEWER_FILE, type SitePage } from './site-pages';

// The docs (site/docs/ and site/zh-TW/docs/; site/DESIGN-GUIDELINES.md, "The docs"): a page per task for people who
// use Harness Relay, written by hand like the rest of the site. This keeps what the pages share the same on each of
// them (the head, the icons, the header, the docs' menu, the footer), each page in step with the other language's
// (the same sections, in the same order, listed in its contents), and every link going somewhere that is there: the
// site's pages and their sections, the pictures, and the repository's files on GitHub with their headings.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const exists = (path: string) => existsSync(new URL(`../${path}`, import.meta.url));
const REPO = 'https://github.com/Agentic-System-Lab/harness-relay';
const BLOB = `${REPO}/blob/main/`;
/** Columns in a search result: a Chinese character takes two. */
const columns = (s: string) => [...s].reduce((n, c) => n + (/[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(c) ? 2 : 1), 0);
/** HTML as text: tags dropped, the entities the pages use read, white space as one space. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
/** The part of `html` from `start` to the first `end` after it, both included. */
const slice = (html: string, start: string, end: string) => {
  const at = html.indexOf(start);
  expect(at, start).toBeGreaterThanOrEqual(0);
  return html.slice(at, html.indexOf(end, at) + end.length);
};
/** Each link in `html`: its words and where it points, made absolute against the page's address. */
const links = (html: string, base: string) =>
  [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    tag: m[1],
    words: text(m[2]),
    href: new URL(m[1].match(/\shref="([^"]*)"/)![1], base).href,
  }));
const ids = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

const PAGE = (file: string) => SITE_PAGES.find((p) => p.file === file)!;
/** The page at the same place in the other language. */
const counterpart = (page: SitePage) => SITE_PAGES.find((p) => p.path === page.path && p.lang !== page.lang)!;
const inLang = (page: SitePage, lang: SitePage['lang']) => (page.lang === lang ? page : counterpart(page));
/** The site's page at `url` (its hash left out), if it is one. */
const pageAt = (url: string) => SITE_PAGES.find((p) => p.url === url.split('#')[0]);
const overview = (lang: SitePage['lang']) => DOC_PAGES.find((p) => p.lang === lang && p.path === 'docs/')!;

/**
 * A Markdown file's heading anchors as GitHub makes them (github-slugger): the heading's text in lower case, all but
 * letters, marks, digits, `_`, `-` and spaces dropped, each space a `-`, and `-1`, `-2`… after a heading's later times;
 * and the anchors its HTML names itself.
 */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>([...markdown.matchAll(/<a (?:id|name)="([^"]+)"/g)].map((m) => m[1]));
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (!heading) continue;
    const words = heading[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '');
    const slug = words
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const times = seen.get(slug) ?? 0;
    seen.set(slug, times + 1);
    out.add(times ? `${slug}-${times}` : slug);
  }
  return out;
}

/** Each docs page, read once. */
const docs = DOC_PAGES.map((page) => {
  const html = read(page.file);
  const head = html.split('</head>')[0];
  const body = html.slice(html.indexOf('<body>'));
  const meta = (attr: string, name: string) => {
    const m = head.match(new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"\\s*/>`));
    expect(m, `${page.file} ${name}`).not.toBeNull();
    return m![1];
  };
  return {
    ...page,
    html,
    head,
    body,
    meta,
    title: text(head.match(/<title>([^<]*)<\/title>/)![1]),
    menu: slice(body, '<nav class="doc-nav"', '</nav>'),
    toc: slice(body, '<nav class="doc-toc"', '</nav>'),
    article: slice(body, '<div class="doc-body">', '\n      </div>\n    </main>'),
  };
});
const doc = (page: SitePage) => docs.find((d) => d.file === page.file)!;

describe('the docs', () => {
  it('are pages of the site: every index.html under site/ is listed (but the viewer of shared conversations), the docs among them, in both languages', () => {
    const onDisk = (readdirSync(new URL('../site/', import.meta.url), { recursive: true }) as string[])
      .map((f) => f.split(sep).join('/'))
      .filter((f) => f === 'index.html' || f.endsWith('/index.html'))
      .map((f) => `site/${f}`)
      .sort();
    expect(onDisk).toEqual([...PAGE_FILES, VIEWER_FILE].sort());
    expect(DOC_PAGES.filter((p) => p.lang === 'en').length).toBeGreaterThan(1);
    for (const page of DOC_PAGES) expect(exists(counterpart(page).file), page.file).toBe(true);
  });

  it('say what they are in their head: the address, the languages, the title and description, and the same in JSON-LD', () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const page of docs) {
      const [en, zh] = [inLang(page, 'en'), inLang(page, 'zh-TW')];
      expect(page.html.startsWith(`<!doctype html>\n<html lang="${page.lang === 'en' ? 'en' : 'zh-Hant-TW'}">\n`), page.file).toBe(true);
      expect(page.head, page.file).toContain(`<link rel="canonical" href="${page.url}" />`);
      expect(
        [...page.head.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)" \/>/g)].map((m) => `${m[1]} ${m[2]}`),
        page.file,
      ).toEqual([`en ${en.url}`, `zh-TW ${zh.url}`, `x-default ${en.url}`]);
      expect(page.meta('property', 'og:url'), page.file).toBe(page.url);
      expect(text(page.meta('property', 'og:title')), page.file).toBe(page.title);
      expect(page.meta('property', 'og:image'), page.file).toBe(`${SITE}assets/media/og-${page.lang}.png`);
      // The title names the docs; the description starts with them and fits in a search result.
      const name = page.lang === 'en' ? 'Harness Relay docs' : 'Harness Relay 文件';
      if (page.path === 'docs/') expect(page.title.startsWith(`${name}${page.lang === 'en' ? ': ' : '：'}`), page.title).toBe(true);
      else expect(page.title.endsWith(` · ${name}`), page.title).toBe(true);
      const description = text(page.meta('name', 'description'));
      expect(description.startsWith(name), description).toBe(true);
      expect(columns(description), description).toBeLessThanOrEqual(160);
      expect(columns(description), description).toBeGreaterThanOrEqual(50);
      titles.add(page.title);
      descriptions.add(description);
      // JSON-LD: the page, part of the site, about the app (both defined on the home page).
      const scripts = [...page.head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      expect(scripts, page.file).toHaveLength(1);
      expect(JSON.parse(scripts[0][1]), page.file).toEqual({
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        '@id': `${page.url}#webpage`,
        url: page.url,
        name: page.title,
        description,
        inLanguage: page.lang,
        isPartOf: { '@id': `${SITE}#website` },
        about: { '@id': `${SITE}#app` },
      });
    }
    expect(titles.size).toBe(docs.length);
    expect(descriptions.size).toBe(docs.length);
    expect(read('site/index.html')).toContain(`"@id": "${SITE}#website"`);
    expect(read('site/index.html')).toContain(`"@id": "${SITE}#app"`);
  });

  it("load the site's stylesheet and scripts, and send a visitor who chose the other language to its page", () => {
    for (const page of docs) {
      const up = '../'.repeat(page.file.split('/').length - 2);
      expect(page.head, page.file).toContain(`<link rel="stylesheet" href="${up}assets/site.css" />`);
      expect(page.head, page.file).toContain(`<script src="${up}assets/site.js" defer></script>`);
      expect(page.head, page.file).toContain(`<script type="module" src="${up}assets/theme.js"></script>`);
      // downloads.js only where there are download links.
      expect(page.head.includes('assets/downloads.js'), page.file).toBe(page.body.includes('data-downloads'));
      const target = page.head.match(/location\.replace\('([^']+)' \+ location\.hash\)/)?.[1];
      expect(target, page.file).toBeDefined();
      expect(new URL(target!, page.url).href, page.file).toBe(counterpart(page).url);
    }
  });

  it('share their icons, and keep to them', () => {
    const icons = (html: string) => html.match(/<svg width="0" height="0"[\s\S]*?<\/svg>/)![0];
    const first = icons(docs[0].html);
    for (const page of docs) {
      expect(icons(page.html), page.file).toBe(first);
      const defined = new Set([...first.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
      for (const m of page.body.matchAll(/<use href="#([^"]+)"/g)) expect(defined, `${page.file} #${m[1]}`).toContain(m[1]);
    }
  });

  it("have the site's header and footer, which lead to the docs from every page of the site", () => {
    const words = {
      en: ['Demo', 'Use cases', 'Modes', 'Teams', 'Safety', 'Quick start', 'Docs'],
      'zh-TW': ['示範', '使用情境', '對話模式', '團隊', '安全', '快速開始', '文件'],
    };
    for (const page of SITE_PAGES) {
      const html = read(page.file);
      const home = inLang(SITE_PAGES[0], page.lang).url;
      const sections = links(slice(html, '<nav class="site-nav"', '</nav>'), page.url);
      expect(
        sections.map((l) => l.words),
        page.file,
      ).toEqual(words[page.lang]);
      // The home page links its own use cases' section; the other pages, the use-cases page.
      expect(sections.map((l) => (l.href.startsWith(home) ? l.href.slice(home.length) : l.href))).toEqual([
        '#demo',
        page.path === '' ? '#use-cases' : 'use-cases/',
        '#modes',
        '#teams',
        '#safety',
        '#start',
        'docs/',
      ]);
      // The docs' link is the current one on the docs' pages: the page itself on the overview.
      const docsLink = sections.at(-1)!.tag;
      const current = page.path === 'docs/' ? 'page' : page.path.startsWith('docs/') ? 'true' : undefined;
      expect(docsLink.match(/aria-current="([^"]+)"/)?.[1], page.file).toBe(current);
      // The language switch: each language's page at the same place, this one current.
      const lang = links(slice(html, '<nav class="lang"', '</nav>'), page.url);
      expect(
        lang.map((l) => [l.words, l.href, /aria-current="page"/.test(l.tag)]),
        page.file,
      ).toEqual([
        ['EN', inLang(page, 'en').url, page.lang === 'en'],
        ['中文', inLang(page, 'zh-TW').url, page.lang === 'zh-TW'],
      ]);
      // Where the section links are gone (a phone's screen), the home and use-cases pages keep the docs' link beside
      // the language switch, in the GitHub stars' place; the docs have their own menu there.
      const tools = slice(html, '<div class="header-tools">', '<nav class="lang"');
      const beside = links(tools, page.url);
      if (page.path.startsWith('docs/')) expect(beside, page.file).toEqual([]);
      else {
        expect(
          beside.map((l) => [l.tag.trim(), l.words, l.href]),
          page.file,
        ).toEqual([[`class="header-docs" href="${page.path === '' ? '' : '../'}docs/"`, words[page.lang].at(-1), overview(page.lang).url]]);
      }
      // The footer: the mark to the home page, then the docs.
      const footer = links(slice(html, '<footer class="site-footer">', '</footer>'), page.url);
      expect(footer[0].href, page.file).toBe(home);
      expect([footer[1].words, footer[1].href], page.file).toEqual([words[page.lang].at(-1), overview(page.lang).url]);
    }
  });

  it("show the docs' link beside the language switch, in place of the star count, only where the section links are gone", () => {
    const css = read('site/assets/site.css');
    const block = (start: string) => css.slice(css.indexOf(start), css.indexOf('\n}\n', css.indexOf(start)));
    expect(block('\n.header-docs {')).toContain('display: none;');
    const narrow = block('@media (max-width: 980px) {');
    expect(narrow).toContain('.site-nav {\n    display: none;');
    expect(narrow).toContain('.header-docs {\n    display: inline-block;');
    expect(narrow).toContain('.site-header .header-tools:has(.header-docs) .stars {\n    display: none;');
  });

  it("list every page of the docs in their menu, in order, the same on each page, this page's current", () => {
    for (const page of docs) {
      const menu = links(slice(page.menu, '<div class="doc-nav-list"', '</div>'), page.url);
      const pages = menu.filter((l) => pageAt(l.href)?.path.startsWith('docs/'));
      expect(
        pages.map((l) => l.href),
        page.file,
      ).toEqual(DOC_PAGES.filter((p) => p.lang === page.lang).map((p) => p.url));
      expect(
        pages.map((l) => l.words),
        page.file,
      ).toEqual(
        links(slice(doc(overview(page.lang)).menu, '<div class="doc-nav-list"', '</div>'), overview(page.lang).url)
          .slice(0, pages.length)
          .map((l) => l.words),
      );
      expect(
        pages.filter((l) => /aria-current="page"/.test(l.tag)).map((l) => l.href),
        page.file,
      ).toEqual([page.url]);
      // On a narrow screen, the button shows this page's name.
      const own = pages.find((l) => l.href === page.url)!.words;
      expect(text(page.menu.match(/<button class="doc-nav-toggle"[\s\S]*?<b>([\s\S]*?)<\/b>/)![1]), page.file).toBe(own);
      expect(page.menu, page.file).toContain('aria-controls="doc-pages"');
      expect(page.menu, page.file).toContain('<div class="doc-nav-list" id="doc-pages">');
      // Under them, the technical docs on GitHub: the README's list of them.
      expect(menu.at(-1)!.href, page.file).toBe(
        page.lang === 'en' ? `${REPO}#documentation` : `${BLOB}README.zh-TW.md#${encodeURIComponent('文件')}`,
      );
    }
  });

  it('have one h1, then sections each headed by an h2, the same ones in both languages, listed in the contents', () => {
    for (const page of docs) {
      expect(page.html.match(/<h1\b/g), page.file).toHaveLength(1);
      expect(slice(page.body, '<header class="doc-head">', '</header>'), page.file).toMatch(/<h1>[^<]/);
      const sections = [...page.article.matchAll(/<section id="([^"]+)" aria-labelledby="([^"]+)">\s*<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
      expect(sections.length, page.file).toBeGreaterThanOrEqual(2);
      expect(page.article.match(/<section\b/g), page.file).toHaveLength(sections.length);
      for (const [, id, labelledby, h2] of sections)
        expect([labelledby, h2], `${page.file} #${id}`).toEqual([`${id}-title`, `${id}-title`]);
      const contents = [...page.toc.matchAll(/<a href="#([^"]+)">([\s\S]*?)<\/a>/g)].map((m) => [m[1], text(m[2])]);
      expect(contents, page.file).toEqual(sections.map((m) => [m[1], text(m[4])]));
      // Headings in order: none deeper than an h3, and an h3 only inside a section.
      expect(page.article, page.file).not.toMatch(/<h[4-6]\b/);
      expect(page.article.slice(0, page.article.indexOf('<section')), page.file).not.toMatch(/<h3\b/);
    }
    for (const page of docs.filter((p) => p.lang === 'en')) {
      const sectionIds = (d: (typeof docs)[number]) => [...d.article.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
      expect(sectionIds(doc(counterpart(page))), page.path).toEqual(sectionIds(page));
    }
  });

  it('end on the technical docs on GitHub and the pages before and after, never on a dead end', () => {
    for (const page of docs) {
      const more = slice(page.article, '<aside class="doc-more"', '</aside>');
      expect(more, page.file).toContain(`aria-label="${page.lang === 'en' ? 'Technical details' : '技術細節'}"`);
      expect(links(more, page.url).length, page.file).toBeGreaterThan(0);
      for (const link of links(more, page.url))
        expect(link.href.startsWith(BLOB) || link.href.startsWith(`${REPO}#`), link.href).toBe(true);
      // The pager comes last, after the technical docs.
      const pager = page.article.slice(page.article.indexOf('<nav class="doc-pager"'));
      expect(page.article.indexOf('<nav class="doc-pager"'), page.file).toBeGreaterThan(page.article.indexOf('<aside class="doc-more"'));
      const order = DOC_PAGES.filter((p) => p.lang === page.lang);
      const at = order.findIndex((p) => p.url === page.url);
      const label = (p: SitePage) => links(page.menu, page.url).find((l) => l.href === p.url)!.words;
      const want = [
        ...(at > 0 ? [['prev', page.lang === 'en' ? 'Previous' : '上一頁', order[at - 1]] as const] : []),
        ...(at < order.length - 1 ? [['next', page.lang === 'en' ? 'Next' : '下一頁', order[at + 1]] as const] : []),
      ];
      const got = [...pager.matchAll(/<a href="([^"]+)" rel="(prev|next)"><span>([^<]+)<\/span><b>([^<]+)<\/b><\/a>/g)];
      expect(pager.match(/<a\b/g), page.file).toHaveLength(want.length);
      expect(
        got.map((m) => [m[2], m[3], new URL(m[1], page.url).href, text(m[4])]),
        page.file,
      ).toEqual(want.map(([rel, word, p]) => [rel, word, p.url, label(p)]));
    }
  });

  it('link only to what is there: their pages and sections, the pictures, and the files and headings on GitHub', () => {
    for (const page of docs) {
      const here = ids(page.html);
      for (const m of page.body.matchAll(/\s(href|src)="([^"]+)"/g)) {
        const [, kind, value] = m;
        const where = `${page.file}: ${value}`;
        if (value.startsWith('#')) {
          expect(here, where).toContain(decodeURIComponent(value.slice(1)));
          continue;
        }
        const url = new URL(value, page.url);
        const hash = decodeURIComponent(url.hash.slice(1));
        if (url.href.startsWith(SITE)) {
          const path = decodeURIComponent(url.pathname).slice(new URL(SITE).pathname.length);
          if (path === '' || path.endsWith('/')) {
            const target = pageAt(url.href);
            expect(target, where).toBeDefined();
            if (hash) expect(ids(read(target!.file)), where).toContain(hash);
            // A page in the other language only through the language switch.
            if (target!.lang !== page.lang) expect(page.body.slice(0, m.index).lastIndexOf('<nav class="lang"'), where).toBeGreaterThan(-1);
          } else {
            expect(exists(`site/${path}`), where).toBe(true);
          }
          if (kind === 'src' && path.endsWith('.webp'))
            expect(exists(`site/${path}.json`), `${where}: its origin, in a .webp.json beside it`).toBe(true);
        } else if (url.href === REPO) {
          // The GitHub buttons: the repository itself.
        } else if (url.href.startsWith(BLOB) || url.href.split('#')[0] === REPO) {
          const file = url.href.startsWith(BLOB) ? decodeURIComponent(url.pathname).slice(new URL(BLOB).pathname.length) : 'README.md';
          expect(exists(file), where).toBe(true);
          if (hash) expect(anchors(read(file)), where).toContain(hash);
          // Each language's docs: the Chinese page links the Chinese copy where there is one.
          if (file.endsWith('.md')) {
            const zhCopy = file.replace(/(\.zh-TW)?\.md$/, '.zh-TW.md');
            if (page.lang === 'en') expect(file.endsWith('.zh-TW.md'), where).toBe(false);
            else if (exists(zhCopy)) expect(file, where).toBe(zhCopy);
          }
        } else if (url.href.startsWith(`${REPO}/`)) {
          expect([`${REPO}/releases`, `${REPO}/releases/latest`], where).toContain(url.href);
        } else {
          expect(url.protocol, where).toBe('https:');
        }
      }
      // Each picture says what it shows, and its size.
      for (const img of page.body.matchAll(/<img\b([^>]*)>/g)) {
        expect(img[1], page.file).toMatch(/\salt="[^"]{12,}"/);
        expect(img[1], page.file).toMatch(/\swidth="\d+"/);
        expect(img[1], page.file).toMatch(/\sheight="\d+"/);
      }
    }
  });

  it('find the headings GitHub makes anchors of, as GitHub does', () => {
    const guide = anchors(read('docs/user-guide.md'));
    expect(guide).toContain('2-sign-in-to-each-agent--settings--sign-in');
    expect(guide).toContain('agent-sessions-the-clis-own-folder-and-agentsview');
    expect(guide).toContain('api-keys-optional');
    expect(anchors(read('README.zh-TW.md'))).toContain('文件');
    expect(anchors('# A\n## A\n```\n# not a heading\n```\n## A')).toEqual(new Set(['a', 'a-1', 'a-2']));
  });
});

// PAGE is kept for the pages a failure names.
void PAGE;
