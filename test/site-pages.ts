// The website's pages (site/), in the sitemap's order: the home page, the use cases, then the docs, each in
// English and then in Traditional Chinese. The site tests read them from here; test/site-docs.test.ts checks
// that every index.html under site/ is listed, and the sitemap that it lists them all in this order.

/** The site's address, where each page's canonical address starts. */
export const SITE = 'https://agentic-system-lab.github.io/harness-relay/';

/** The docs' pages, in their order (the docs' menu, and each page's previous and next): the overview first. */
export const DOC_SLUGS = [
  '',
  'install/',
  'agents/',
  'first-chat/',
  'teams/',
  'permissions/',
  'conversations/',
  'automations/',
  'tools/',
  'phone/',
  'troubleshooting/',
] as const;

export type Lang = 'en' | 'zh-TW';

export interface SitePage {
  /** The page's file in the repository, such as `site/zh-TW/docs/install/index.html`. */
  file: string;
  /** Its canonical address. */
  url: string;
  lang: Lang;
  /** Its path under the site in its language, the same in both: `''`, `use-cases/`, `docs/install/`… */
  path: string;
}

const PATHS = ['', 'use-cases/', ...DOC_SLUGS.map((slug) => `docs/${slug}`)];

export const SITE_PAGES: SitePage[] = PATHS.flatMap((path) =>
  (['en', 'zh-TW'] as const).map((lang) => {
    const under = lang === 'en' ? path : `zh-TW/${path}`;
    return { file: `site/${under}index.html`, url: `${SITE}${under}`, lang, path };
  }),
);

/** Every page's file. */
export const PAGE_FILES = SITE_PAGES.map((page) => page.file);

/** The docs' pages. */
export const DOC_PAGES = SITE_PAGES.filter((page) => page.path.startsWith('docs/'));
