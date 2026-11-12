// Types of theme.js for the tests (test/site-theme.test.ts); not published.
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_KEY: string;
export const BAR_COLOR: { light: string; dark: string };
export function parseTheme(value: unknown): ThemeChoice;
export function shownTheme(choice: ThemeChoice, systemDark: boolean): 'light' | 'dark';
export function nextChoice(choice: ThemeChoice, systemDark: boolean): ThemeChoice;
export function applyTheme(doc: unknown, choice: ThemeChoice, systemDark: boolean): void;
export function wire(deps?: {
  doc?: unknown;
  storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void } | null;
  media?: { matches: boolean; addEventListener?(type: 'change', fn: () => void): void } | null;
  win?: { addEventListener?(type: 'storage', fn: (e: { key: string | null; newValue: string | null }) => void): void } | null;
}): void;
