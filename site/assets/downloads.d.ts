// Types of downloads.js for the tests (test/site-downloads.test.ts); not published.
/** The systems with an installer (the keys of INSTALLERS). */
export type InstallerSystem = 'mac' | 'win' | 'win-arm64' | 'linux' | 'linux-arm64';
export type System = InstallerSystem | 'mobile' | 'other';
export interface Installer {
  url: string;
  name: string;
}
export interface NewestRelease {
  tag: string;
  /** Whether it is a release candidate. */
  prerelease: boolean;
  installers: Partial<Record<InstallerSystem, Installer>>;
}
export const REPO: string;
export const RELEASES_PAGE: string;
export const INSTALLERS: Record<InstallerSystem, string>;
export function systemOf(o?: {
  userAgent?: string;
  platform?: string;
  uaPlatform?: string;
  maxTouchPoints?: number;
  /** Chromium's high-entropy hints (`processorHints`). */
  architecture?: string;
  bitness?: string;
}): System;
export function wordKey(system: string): string;
export function processorHints(nav: unknown): Promise<{ architecture?: string; bitness?: string }>;
export function installersOf(release: unknown): NewestRelease['installers'];
export function isCandidate(tag: unknown, prerelease?: unknown): boolean;
export function newestRelease(releases: unknown): NewestRelease | null;
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
