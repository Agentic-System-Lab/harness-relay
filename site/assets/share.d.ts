// Types of share.js for the tests (test/site-share.test.ts); not published.
/** A gist a viewer address names: its id, and its owner on GitHub when the address names one. */
export interface Gist {
  owner?: string;
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
  notShared: string;
  failed(detail: string): string;
  offline: string;
  home: string;
  homeHref: string;
}
export const RAW_HOST: string;
export const API_HOST: string;
export const SHARE_FILE: string;
export const GENERATOR: string;
export function gistOf(hash: unknown): Gist | undefined;
export function rawUrl(gist: Required<Gist>): string;
export function apiUrl(id: string): string;
export function pageFromApi(info: unknown, id: string): { owner: string; raw: string } | undefined;
export function gistPage(gist: Gist): string;
export function langOf(tag: unknown): ViewerLang;
export function isSharedPage(generator: unknown): boolean;
export const WORDS: Record<ViewerLang, ViewerWords>;
export function linkPlan(href: unknown): { href: string; target?: '_blank'; rel?: string } | undefined;
export type Fetch = (url: string, init?: object) => Promise<{ status: number; text(): Promise<string>; json(): Promise<unknown> }>;
export function readPage(
  gist: Gist,
  get?: Fetch,
): Promise<
  { gist: Gist; html: string; failure?: undefined } | { failure: { kind: 'notFound' } | { kind: 'failed'; detail: string }; gist?: Gist }
>;
export function failureOf(status: number): { kind: 'notFound' } | { kind: 'failed'; detail: string } | undefined;
