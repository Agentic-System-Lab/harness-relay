/**
 * The page's colours: the system's light or dark mode, or the one the user chose in Settings →
 * Appearance, remembered in this browser (`localStorage`, like the language). styles.css has the light
 * colours, and the dark ones under `prefers-color-scheme: dark` unless `<html data-theme="light">`,
 * and under `data-theme="dark"`. index.html sets `data-theme` from the saved choice before the page is
 * drawn, so it does not flash; this module keeps it, the browser's bar colour (`theme-color`) and what
 * follows the theme (Mermaid diagrams) in step, also with the system's mode and other tabs. A shared
 * page has no `data-theme`, so it follows its reader's system. The DOM-free parts are tested in
 * test/theme.test.ts.
 */
import { useSyncExternalStore } from 'react';

export const THEMES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEMES)[number];

/** Where the choice is kept (index.html reads it too). */
export const THEME_KEY = 'relay:theme';

/** The browser's bar colour (`theme-color`) for each theme: the page's background (`--bg` in styles.css). */
export const BAR_COLOR = { light: '#ffffff', dark: '#212121' } as const;

/** A saved choice: anything else (nothing saved, an old or broken value) is the system's. */
export function parseTheme(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The theme the page shows for `choice`, when the system is in dark mode or not. */
export function effectiveTheme(choice: ThemeChoice, systemDark: boolean): 'light' | 'dark' {
  return choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
}

/** The parts of a document `applyTheme` changes (a fake one in the tests). */
export interface ThemeDocument {
  documentElement: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };
  querySelectorAll(selector: string): Iterable<{ getAttribute(name: string): string | null; setAttribute(name: string, value: string): void }>;
}

/**
 * Shows `choice` on the page: `data-theme` on <html> (none for the system's, so that the CSS follows
 * `prefers-color-scheme`), and the browser's bar colour: each `theme-color` for its own media with the
 * system's, else the chosen theme's for both.
 */
export function applyTheme(doc: ThemeDocument, choice: ThemeChoice): void {
  if (choice === 'system') doc.documentElement.removeAttribute('data-theme');
  else doc.documentElement.setAttribute('data-theme', choice);
  for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
    const forDark = /dark/.test(meta.getAttribute('media') ?? '');
    meta.setAttribute('content', BAR_COLOR[choice === 'system' ? (forDark ? 'dark' : 'light') : choice]);
  }
}

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The saved choice; the system's when there is none or the storage cannot be read. */
export function readTheme(storage: ThemeStorage | null | undefined): ThemeChoice {
  try {
    return parseTheme(storage?.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Saves the choice; where the browser refuses, it lasts until the page is loaded again. */
export function saveTheme(storage: ThemeStorage | null | undefined, choice: ThemeChoice): void {
  try {
    storage?.setItem(THEME_KEY, choice);
  } catch {
    /* storage unavailable */
  }
}

// ---------- In the browser ----------

let choice: ThemeChoice = 'system';
let systemDark = false;
const listeners = new Set<() => void>();

function browserStorage(): ThemeStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * Takes the saved choice and follows the system's mode and other tabs of this browser. Called once,
 * by main.tsx, before the app is drawn.
 */
export function startTheme(): void {
  choice = readTheme(browserStorage());
  const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
  systemDark = query?.matches ?? false;
  query?.addEventListener('change', () => {
    systemDark = query.matches;
    notify();
  });
  // Chosen in another tab: this one changes too.
  addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== THEME_KEY) return;
    choice = parseTheme(e.newValue);
    applyTheme(document, choice);
    notify();
  });
  applyTheme(document, choice);
}

/** The user's choice, now. */
export function themeChoice(): ThemeChoice {
  return choice;
}

/** Whether the page is dark now (the choice, or the system's mode). */
export function isDarkTheme(): boolean {
  return effectiveTheme(choice, systemDark) === 'dark';
}

export function setThemeChoice(next: ThemeChoice): void {
  choice = next;
  saveTheme(browserStorage(), next);
  applyTheme(document, next);
  notify();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The user's choice, kept up to date (Settings → Appearance). Rendered to a string, it is the one now too. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, themeChoice, themeChoice);
}

/** Whether the page is dark, kept up to date (a Mermaid diagram is drawn again when it changes). */
export function useDarkTheme(): boolean {
  return useSyncExternalStore(subscribe, isDarkTheme, isDarkTheme);
}
