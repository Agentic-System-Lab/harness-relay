import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_RELAY_URL } from '../src/web/share';
import { SITE_DOCS, siteDocUrl } from '../src/web/siteDocs';

describe("the app's links to the website's docs", () => {
  it('lead to a section the page has, in each language', () => {
    for (const doc of Object.keys(SITE_DOCS) as (keyof typeof SITE_DOCS)[]) {
      for (const lang of ['en', 'zh-TW'] as const) {
        const url = new URL(siteDocUrl(lang, doc));
        expect(url.href.startsWith(HARNESS_RELAY_URL), url.href).toBe(true);
        const path = url.pathname.slice(new URL(HARNESS_RELAY_URL).pathname.length);
        expect(path.startsWith(lang === 'zh-TW' ? 'zh-TW/docs/' : 'docs/'), url.href).toBe(true);
        const page = readFileSync(join('site', path, 'index.html'), 'utf8');
        expect(page, url.href).toContain(`id="${url.hash.slice(1)}"`);
      }
    }
  });

  it('send Settings → Publish to the cloud to the Render and Neon guides', () => {
    expect(siteDocUrl('en', 'renderSetup')).toBe(`${HARNESS_RELAY_URL}docs/conversations/#render-setup`);
    expect(siteDocUrl('zh-TW', 'neonSetup')).toBe(`${HARNESS_RELAY_URL}zh-TW/docs/conversations/#neon-setup`);
  });
});
