// Types of downloads.js for the tests (test/site-downloads.test.ts); not published.
export type System = 'mac' | 'win' | 'linux' | 'mobile' | 'other';
export interface Installer {
  url: string;
  name: string;
  size?: number;
}
export interface NewestRelease {
  tag: string;
  installers: Partial<Record<'mac' | 'win' | 'linux', Installer>>;
}
export const REPO: string;
export const RELEASES_PAGE: string;
export const INSTALLERS: Record<'mac' | 'win' | 'linux', string>;
export function systemOf(o?: { userAgent?: string; platform?: string; uaPlatform?: string; maxTouchPoints?: number }): System;
export function installersOf(release: unknown): NewestRelease['installers'];
export function isCandidate(tag: unknown, prerelease?: unknown): boolean;
export function newestRelease(releases: unknown): NewestRelease | null;
export function sizeLabel(bytes: number | undefined): string;
export const DOWNLOAD_PREFIX: string;
export const STORAGE_KEY: string;
export function isInstallerUrl(url: unknown): boolean;
export function wire(deps?: {
  doc?: unknown;
  nav?: unknown;
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  fetchJson?: (url: string) => Promise<unknown>;
  now?: () => number;
}): Promise<void>;
