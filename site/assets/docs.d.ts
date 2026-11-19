// Types of docs.js for the tests (test/site-docs-search.test.ts); not published.

/** One searchable piece of a docs page: the lead (no id) or a section. */
export interface DocSection {
  id: string;
  heading: string;
  subheadings: string[];
  text: string;
}

export interface IndexedPage {
  title: string;
  sections: DocSection[];
}

/** A page handed to search: its address in the menu, its title, and its sections. */
export interface SearchPage {
  href: string;
  title: string;
  sections: DocSection[];
}

export interface SearchHit {
  href: string;
  id: string;
  title: string;
  heading: string;
  snippet: string;
  ranges: Array<[number, number]>;
}

export function escapeHtml(text: string): string;
export function plainText(html: string): string;
export function indexPage(html: string): IndexedPage;
export function highlight(text: string, ranges: Array<[number, number]>): string;
export function searchDocs(pages: SearchPage[], query: string, limit?: number): SearchHit[];
export function sectionHref(pageHref: string, id: string): string;

/** One menu page after its fetch: `page` is set when `ok` is true. */
export interface SettledPage {
  ok: boolean;
  href: string;
  page?: SearchPage | null;
}

/** `complete` is false when any page failed to arrive, so the index must not be kept. */
export interface SettledIndex {
  pages: SearchPage[];
  complete: boolean;
}

export function settlePages(results: SettledPage[], here?: SearchPage | null): SettledIndex;
export function resultsLabel(count: number, templates: { one?: string; many?: string }): string;
export function pageToMarkdown(html: string, pageUrl: string): string;
