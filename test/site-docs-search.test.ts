import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { highlight, indexPage, pageToMarkdown, resultsLabel, searchDocs, sectionHref, settlePages } from '../site/assets/docs.js';
import { DOC_PAGES } from './site-pages';

// Search and "copy page" for the docs (site/assets/docs.js). The pages stay hand-written HTML: search indexes
// that HTML, and copy turns the same HTML into Markdown. The browser wiring is checked by opening the site.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const catalog = DOC_PAGES.map((page) => {
  const indexed = indexPage(read(page.file));
  return { ...page, href: page.url, title: indexed.title, sections: indexed.sections };
});
const inLang = (lang: 'en' | 'zh-TW') => catalog.filter((page) => page.lang === lang);

describe('search over the docs', () => {
  it('indexes each page from its HTML: the title, the lead and every section', () => {
    for (const page of catalog) {
      expect(page.title.length, page.file).toBeGreaterThan(0);
      expect(page.sections.length, page.file).toBeGreaterThan(1);
      expect(page.sections[0].id, page.file).toBe('');
      expect(page.sections.filter((section) => section.id).length, page.file).toBeGreaterThan(0);
    }
    const overview = catalog.find((page) => page.file === 'site/docs/index.html')!;
    expect(overview.title).toBe('Using Harness Relay');
    expect(overview.sections.find((section) => section.id === 'words')?.text).toContain('Working directory');
    const details = overview.sections.find((section) => section.heading === 'Technical details');
    expect(details?.text).toContain('Architecture');
    expect(searchDocs(inLang('en'), 'Architecture')).toEqual([
      expect.objectContaining({ title: 'Using Harness Relay', heading: 'Technical details', id: '' }),
    ]);
  });

  it('matches every word, keeps one section per page, and ranks a heading above an earlier mention', () => {
    expect(searchDocs(inLang('en'), '   ')).toEqual([]);
    expect(searchDocs(inLang('en'), 'zzzz-not-in-the-docs')).toEqual([]);
    expect(searchDocs(inLang('en'), 'working zzzz-not-a-term')).toEqual([]);

    const directory = searchDocs(inLang('en'), 'working directory');
    expect(directory.find((hit) => hit.title === 'Using Harness Relay')?.id).toBe('how-it-works');
    expect(new Set(directory.map((hit) => hit.href)).size).toBe(directory.length);
    expect(directory.length).toBeLessThanOrEqual(8);
    for (const hit of directory) expect(hit.snippet.toLowerCase()).toContain('working');

    const sandboxes = searchDocs(inLang('en'), 'SANDBOX');
    expect(sandboxes.some((hit) => hit.id === 'sandboxes' && hit.heading === 'What the sandboxes do')).toBe(true);

    const files = searchDocs(inLang('zh-TW'), '工作目錄');
    expect(files.find((hit) => hit.heading === '檔案與工作目錄')?.id).toBe('files');
    expect(files[0].snippet).toContain('工作目錄');

    const few = searchDocs(inLang('en'), 'the', 3);
    expect(few).toHaveLength(3);
    expect(new Set(few.map((hit) => hit.href)).size).toBe(3);
  });

  it('ranks a title above a heading, a heading above a subheading, and a phrase above split words', () => {
    const section = (id: string, heading: string, text: string, subheadings: string[] = []) => ({ id, heading, subheadings, text });
    const pages = [
      { href: 'body/', title: 'Body page', sections: [section('a', 'Other', 'alpha in the body')] },
      { href: 'sub/', title: 'Sub page', sections: [section('b', 'Other', 'nothing here', ['alpha'])] },
      { href: 'head/', title: 'Head page', sections: [section('c', 'alpha here', 'alpha here')] },
      { href: 'title/', title: 'alpha', sections: [section('d', 'Other', 'alpha')] },
    ];
    expect(searchDocs(pages, 'alpha').map((hit) => hit.href)).toEqual(['title/', 'head/', 'sub/', 'body/']);

    const phrase = [
      { href: 'split/', title: 'P', sections: [section('', '', 'working then later directory')] },
      { href: 'together/', title: 'P', sections: [section('', '', 'working directory together')] },
    ];
    expect(searchDocs(phrase, 'working directory')[0]?.href).toBe('together/');

    const many = Array.from({ length: 9 }, (_, index) => ({
      href: `${index}/`,
      title: `Page ${index}`,
      sections: [section('s', '', 'needle')],
    }));
    expect(searchDocs(many, 'needle')).toHaveLength(8);
    expect(searchDocs(many, 'needle', 9)).toHaveLength(9);

    const long = `${'word '.repeat(80)}needle ${'word '.repeat(80)}`;
    const [hit] = searchDocs([{ href: 'p/', title: 'T', sections: [section('s', '', long)] }], 'needle');
    expect(hit?.snippet.startsWith('…')).toBe(true);
    expect(hit?.snippet.endsWith('…')).toBe(true);
    expect(hit?.snippet).toContain('needle');
    expect(hit?.snippet.length).toBeLessThan(200);
  });

  it('treats a failed fetch as a failure, and keeps a partial index only for this search', () => {
    const here = { href: 'a/', title: 'A', sections: [] };
    const other = { href: 'b/', title: 'B', sections: [] };
    expect(
      settlePages(
        [
          { ok: false, href: 'a/' },
          { ok: false, href: 'b/' },
        ],
        here,
      ),
    ).toEqual({ pages: [], complete: false });
    expect(
      settlePages(
        [
          { ok: false, href: 'a/' },
          { ok: true, href: 'b/', page: other },
        ],
        here,
      ),
    ).toEqual({ pages: [here, other], complete: false });
    expect(
      settlePages(
        [
          { ok: true, href: 'a/', page: here },
          { ok: false, href: 'b/' },
        ],
        here,
      ),
    ).toEqual({ pages: [here], complete: false });
    expect(
      settlePages(
        [
          { ok: true, href: 'a/', page: here },
          { ok: true, href: 'b/', page: other },
        ],
        here,
      ),
    ).toEqual({ pages: [here, other], complete: true });
    expect(resultsLabel(1, { one: '1 matching page', many: '{n} matching pages' })).toBe('1 matching page');
    expect(resultsLabel(2, { one: '1 matching page', many: '{n} matching pages' })).toBe('2 matching pages');
    expect(resultsLabel(1, { many: '找到 {n} 頁' })).toBe('找到 1 頁');
  });

  it('points a result at the page, or at its section, and escapes the snippet before marking it', () => {
    expect(sectionHref('install/', '')).toBe('install/');
    expect(sectionHref('install/', 'first-time')).toBe('install/#first-time');
    expect(highlight('a <b> c', [[2, 5]])).toBe('a <mark>&lt;b&gt;</mark> c');
    expect(
      highlight('hello', [
        [0, 2],
        [1, 4],
      ]),
    ).toBe('<mark>hell</mark>o');
    expect(highlight('a & b', [])).toBe('a &amp; b');
  });
});

describe('a docs page as Markdown', () => {
  it('keeps the title, the address and each section, and leaves the chrome out', () => {
    for (const page of DOC_PAGES) {
      const html = read(page.file);
      const markdown = pageToMarkdown(html, page.url);
      expect(markdown.startsWith('# '), page.file).toBe(true);
      expect(markdown, page.file).toContain(`\n\n${page.url}\n\n`);
      for (const section of indexPage(html).sections) {
        if (section.heading) expect(markdown, `${page.file} #${section.id}`).toContain(`## ${section.heading}`);
      }
      expect(markdown, page.file).not.toMatch(/<[a-z]/i);
      expect(markdown, page.file).not.toContain('Copy page');
      expect(markdown, page.file).not.toContain('Search the docs');
      expect(markdown, page.file).not.toContain('複製本頁');
      expect(markdown, page.file).not.toContain('搜尋文件');
    }
  });

  it('turns the overview, the permissions table and a heading written with an entity into Markdown', () => {
    const overview = pageToMarkdown(read('site/docs/index.html'), 'https://agentic-system-lab.github.io/harness-relay/docs/');
    expect(overview).toContain('## How a question gets answered');
    expect(overview).toContain('1. **You ask**');
    expect(overview).toContain(
      "![A chat in Harness Relay: the lead agent's Team design card names a team adapted from the template Parallel comparison, says why, and lists the roles of @Claude on Claude Code, @Codex on Codex and @Grok on Grok, waiting to be confirmed.](https://agentic-system-lab.github.io/harness-relay/assets/media/poster-en.webp)",
    );
    expect(overview).toContain('[Install](https://agentic-system-lab.github.io/harness-relay/docs/install/)');
    expect(overview).toContain('**Working directory**');
    expect(overview).toContain('## Technical details');

    const permissions = pageToMarkdown(
      read('site/docs/permissions/index.html'),
      'https://agentic-system-lab.github.io/harness-relay/docs/permissions/',
    );
    expect(permissions).toContain('| Level | What agents do without asking |');
    expect(permissions).toContain('| --- |');
    expect(permissions).toContain('| Read-only |');
    expect(permissions).toContain('> In edit mode, tests, builds');

    const agents = pageToMarkdown(read('site/docs/agents/index.html'), 'https://agentic-system-lab.github.io/harness-relay/docs/agents/');
    expect(agents).toContain('## Settings & sign-in');
    expect(agents).not.toContain('&amp;');
  });

  it('leaves out the previous and next links', () => {
    const html = `<header class="doc-head"><h1>Fixture</h1><p class="lead">Lead text</p></header>
      <div class="doc-body"><p>Body text</p><nav class="doc-pager"><a href="next/">PAGER_NEXT</a></nav></div>`;
    const markdown = pageToMarkdown(html, 'https://example.com/docs/fixture/');
    expect(markdown).toBe('# Fixture\n\nhttps://example.com/docs/fixture/\n\nLead text\n\nBody text\n');
    expect(markdown).not.toContain('PAGER_NEXT');
  });
});
