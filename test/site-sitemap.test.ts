import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// What Google is told about the landing page: the sitemap (submitted in Search Console, since the robots.txt
// at the domain's root is not ours) lists each page at its canonical address with the same language
// alternates as the page's own <head>, and the file that proves the site ours there is served as Google wrote it.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const PAGES = ['site/index.html', 'site/zh-TW/index.html'];
const sitemap = read('site/sitemap.xml');

/** A page's canonical address and its language alternates, from its <head>. */
const head = (page: string) => {
  const html = read(page).split('</head>')[0];
  const canonical = html.match(/<link rel="canonical" href="([^"]+)" \/>/)?.[1];
  const alternates = [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)" \/>/g)].map((m) => `${m[1]} ${m[2]}`);
  return { canonical, alternates };
};

describe("the landing page's sitemap", () => {
  it('lists every page once, at its canonical address, with the same language alternates as the page', () => {
    const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => ({
      loc: m[1].match(/<loc>([^<]+)<\/loc>/)?.[1],
      alternates: [...m[1].matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)" \/>/g)].map((a) => `${a[1]} ${a[2]}`),
    }));
    expect(entries).toHaveLength(PAGES.length);
    for (const page of PAGES) {
      const { canonical, alternates } = head(page);
      expect(canonical, page).toMatch(/^https:\/\/agentic-system-lab\.github\.io\/harness-relay\//);
      expect(alternates.length, page).toBeGreaterThan(0);
      const entry = entries.find((e) => e.loc === canonical);
      expect(entry, page).toBeDefined();
      expect(entry!.alternates, page).toEqual(alternates);
    }
  });

  it('is valid sitemap XML with the xhtml namespace for the alternates', () => {
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">');
    expect(sitemap.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it("keeps Search Console's verification file as Google wrote it (removing it unverifies the site)", () => {
    expect(read('site/google7b263ecdf9adc06e.html')).toBe('google-site-verification: google7b263ecdf9adc06e.html');
  });
});
