// Types of share.js for the tests (test/site-share.test.ts); not published.
/** A gist a viewer address names: its owner on GitHub and its id. */
export interface Gist {
  owner: string;
  id: string;
}
export type ViewerLang = 'en' | 'zh-TW';
export interface ViewerWords {
  title: string;
  loading: string;
  /** The text before the owner's name, the name, and the text after it. */
  sharedBy(owner: string): [string, string, string];
  viewGist: string;
  invalid: string;
  notFound: string;
  failed(detail: string): string;
  offline: string;
  home: string;
  homeHref: string;
}
export const RAW_HOST: string;
export const SHARE_FILE: string;
export function gistOf(hash: unknown): Gist | undefined;
export function rawUrl(gist: Gist): string;
export function gistPage(gist: Gist): string;
export function langOf(tag: unknown): ViewerLang;
export const WORDS: Record<ViewerLang, ViewerWords>;
export function framedHref(href: string): string;
export function framedHref(href: string | null): string | null;
export function failureOf(status: number): { kind: 'notFound' } | { kind: 'failed'; detail: string } | undefined;
