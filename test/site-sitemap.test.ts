import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { slow } from './timeouts';
import { pagesStep, pagesWorkflow } from './workflow-steps';

// What search engines are told about the landing page: the sitemap (named by the robots.txt at the domain's root,
// which the org's homepage repository publishes, submitted in Search Console and imported from there into Bing
// Webmaster Tools) lists each page at its canonical address with the same language alternates as the page's own
// <head>, and the Pages workflow dates each page in it (<lastmod>) by the last commit that changed it; and the
// file that proves the site ours in Search Console, and so in Bing, which checks through it, is served as Google
// wrote it.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const PAGES = ['site/index.html', 'site/zh-TW/index.html', 'site/use-cases/index.html', 'site/zh-TW/use-cases/index.html'];
const sitemap = read('site/sitemap.xml');

/** A page's canonical address and its language alternates, from its <head>. */
const head = (page: string) => {
  const html = read(page).split('</head>')[0];
  const canonical = html.match(/<link rel="canonical" href="([^"]+)" \/>/)?.[1];
  const alternates = [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)" \/>/g)].map((m) => `${m[1]} ${m[2]}`);
  return { canonical, alternates };
};

/** The sitemap's pages: each one's address, date and language alternates. */
const entries = (xml: string) =>
  [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
    loc: m[1].match(/<loc>([^<]+)<\/loc>/)?.[1],
    lastmod: m[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1],
    alternates: [...m[1].matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)" \/>/g)].map((a) => `${a[1]} ${a[2]}`),
  }));

describe("the landing page's sitemap", () => {
  it('lists every page once, at its canonical address, with the same language alternates as the page', () => {
    const pages = entries(sitemap);
    expect(pages).toHaveLength(PAGES.length);
    for (const page of PAGES) {
      const { canonical, alternates } = head(page);
      expect(canonical, page).toMatch(/^https:\/\/agentic-system-lab\.github\.io\/harness-relay\//);
      expect(alternates.length, page).toBeGreaterThan(0);
      const entry = pages.find((e) => e.loc === canonical);
      expect(entry, page).toBeDefined();
      expect(entry!.alternates, page).toEqual(alternates);
    }
  });

  it('is valid sitemap XML with the xhtml namespace for the alternates', () => {
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">');
    expect(sitemap.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('leaves the dates to the Pages workflow: no <lastmod> of its own, one page to a line', () => {
    expect(sitemap).not.toContain('<lastmod>');
    expect(sitemap.split('\n').filter((line) => line.includes('<loc>'))).toEqual(entries(sitemap).map((e) => `    <loc>${e.loc}</loc>`));
  });

  it("keeps Search Console's verification file as Google wrote it (removing it unverifies the site, in Bing too)", () => {
    expect(read('site/google7b263ecdf9adc06e.html')).toBe('google-site-verification: google7b263ecdf9adc06e.html');
  });
});

const workflow = pagesWorkflow();
const SITE = /^ {2}SITE: (\S+)$/m.exec(workflow)?.[1];
const DATE = 'Date the pages in the sitemap';

describe("the Pages workflow's dates", () => {
  it('come from the whole history, checked out without old contents, and go into the site before it is uploaded', () => {
    expect(workflow).toContain('      - uses: actions/checkout@v7\n        with:\n          fetch-depth: 0\n          filter: blob:none\n');
    const at = (text: string) => {
      const i = workflow.indexOf(text);
      expect(i, text).toBeGreaterThan(0);
      return i;
    };
    expect(at(`- name: ${DATE}\n`)).toBeGreaterThan(at('- name: Assemble the site\n'));
    expect(at(`- name: ${DATE}\n`)).toBeLessThan(at('uses: actions/upload-pages-artifact@'));
  });
});

const tmp = mkdtempSync(join(tmpdir(), 'relay-sitemap-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * git, as the tests' own: no hooks, signing or settings of the user's, each commit made (committed) at the time given and
 * written (authored) before, as a pull request's commit merged later is.
 */
const git = (cwd: string, args: string[], date?: string) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(tmp, 'no-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      ...(date ? { GIT_AUTHOR_DATE: '2025-12-31T00:00:00Z', GIT_COMMITTER_DATE: date } : {}),
    },
  });

const EN = 'https://agentic-system-lab.github.io/harness-relay/';
const ZH = 'https://agentic-system-lab.github.io/harness-relay/zh-TW/';
/** The use-cases pages: in the first commit only. */
const EN_UC = `${EN}use-cases/`;
const ZH_UC = `${ZH}use-cases/`;

/**
 * A checkout of the site with three commits: the site (in Taiwan's time), the Chinese page changed, and the
 * stylesheet alone changed (which dates no page); and the site assembled from it (`_site`), as the workflow does.
 */
function checkout(): string {
  const repo = mkdtempSync(join(tmp, 'repo-'));
  git(repo, ['init', '-q']);
  cpSync(new URL('../site', import.meta.url), join(repo, 'site'), { recursive: true });
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'site'], '2026-01-02T03:04:05+08:00');
  appendFileSync(join(repo, 'site/zh-TW/index.html'), '\n');
  git(repo, ['commit', '-q', '-am', 'Chinese page'], '2026-02-03T00:00:00Z');
  appendFileSync(join(repo, 'site/assets/site.css'), '\n');
  git(repo, ['commit', '-q', '-am', 'stylesheet'], '2026-03-04T05:06:07Z');
  cpSync(join(repo, 'site'), join(repo, '_site'), { recursive: true });
  return repo;
}

/** The step, run as the runner runs it, in a checkout: its output, the job's summary and the sitemap it leaves. */
function date(cwd: string) {
  const summary = join(cwd, '..', `${cwd.split(/[\\/]/).at(-1)}-summary.md`);
  writeFileSync(summary, '');
  const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', pagesStep(DATE)], {
    cwd,
    encoding: 'utf8',
    timeout: slow(20_000),
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(tmp, 'no-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      SITE: SITE!,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    summary: readFileSync(summary, 'utf8'),
    sitemap: readFileSync(join(cwd, '_site/sitemap.xml'), 'utf8'),
  };
}

/** The repository's sitemap with these dates after the pages' addresses, as the workflow writes them. */
const dated = (dates: Record<string, string>) =>
  sitemap.replace(/^( *)<loc>([^<]+)<\/loc>\n/gm, (line, indent: string, loc: string) =>
    dates[loc] ? `${line}${indent}<lastmod>${dates[loc]}</lastmod>\n` : line,
  );

// The step's script runs in bash, which the Windows runners do not have as Linux's.
describe.skipIf(process.platform === 'win32')('dating the pages in the sitemap', { timeout: slow(20_000) }, () => {
  it('dates each page by the last commit that changed its HTML, in UTC, right after its address', () => {
    const r = date(checkout());
    expect(r.status, r.out).toBe(0);
    expect(r.sitemap).toBe(
      dated({
        [EN]: '2026-01-01T19:04:05Z',
        [ZH]: '2026-02-03T00:00:00Z',
        [EN_UC]: '2026-01-01T19:04:05Z',
        [ZH_UC]: '2026-01-01T19:04:05Z',
      }),
    );
    expect(r.out).toBe(
      `${EN} 2026-01-01T19:04:05Z\n${ZH} 2026-02-03T00:00:00Z\n${EN_UC} 2026-01-01T19:04:05Z\n${ZH_UC} 2026-01-01T19:04:05Z\n`,
    );
    expect(r.summary).toBe('');
    // Still the sitemap the first test checks, with a date for each page.
    expect(entries(r.sitemap).map((e) => [e.loc, e.alternates])).toEqual(entries(sitemap).map((e) => [e.loc, e.alternates]));
    expect(r.sitemap.indexOf('<lastmod>')).toBeLessThan(r.sitemap.indexOf('<xhtml:link'));
  });

  it('leaves a page no commit has without a date, and only warns', () => {
    const repo = checkout();
    const MISSING = `${EN}missing/`;
    const xml = readFileSync(join(repo, '_site/sitemap.xml'), 'utf8').replace(
      '</urlset>',
      `  <url>\n    <loc>${MISSING}</loc>\n  </url>\n</urlset>`,
    );
    writeFileSync(join(repo, '_site/sitemap.xml'), xml);
    const r = date(repo);
    expect(r.status, r.out).toBe(0);
    const message = `No commit has site/missing/index.html, the page at ${MISSING}: the sitemap lists it without its <lastmod>.`;
    expect(r.out).toContain(`::warning::${message}\n`);
    expect(r.summary).toBe(`${message}\n`);
    expect(entries(r.sitemap).map((e) => [e.loc, e.lastmod])).toEqual([
      [EN, '2026-01-01T19:04:05Z'],
      [ZH, '2026-02-03T00:00:00Z'],
      [EN_UC, '2026-01-01T19:04:05Z'],
      [ZH_UC, '2026-01-01T19:04:05Z'],
      [MISSING, undefined],
    ]);
  });

  it('dates no page in a shallow checkout, which would date them all at its one commit, and only warns', () => {
    const repo = checkout();
    const shallow = join(tmp, `shallow-${repo.split(/[\\/]/).at(-1)}`);
    git(tmp, ['clone', '-q', '--depth', '1', `file://${repo}`, shallow]);
    cpSync(join(shallow, 'site'), join(shallow, '_site'), { recursive: true });
    const r = date(shallow);
    expect(r.status, r.out).toBe(0);
    const message = "The checkout has only part of the history: the sitemap goes out without the pages' <lastmod>.";
    expect(r.out).toBe(`::warning::${message}\n`);
    expect(r.summary).toBe(`${message}\n`);
    expect(r.sitemap).toBe(sitemap);
  });
});
