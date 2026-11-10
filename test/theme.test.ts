import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  BAR_COLOR,
  effectiveTheme,
  isDarkTheme,
  parseTheme,
  readTheme,
  saveTheme,
  setThemeChoice,
  startTheme,
  THEME_KEY,
  themeChoice,
  THEMES,
  type ThemeDocument,
} from '../src/web/theme';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';

/** Just enough of a document for applyTheme(): <html>'s attributes and the theme-color metas. */
function fakeDocument() {
  const html = new Map<string, string>();
  const metas = [
    { attrs: new Map([['media', '(prefers-color-scheme: light)'], ['content', '#ffffff']]) },
    { attrs: new Map([['media', '(prefers-color-scheme: dark)'], ['content', '#212121']]) },
  ];
  const doc: ThemeDocument = {
    documentElement: { setAttribute: (k, v) => void html.set(k, v), removeAttribute: (k) => void html.delete(k) },
    querySelectorAll: (selector) => {
      expect(selector).toBe('meta[name="theme-color"]');
      return metas.map((m) => ({ getAttribute: (k: string) => m.attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void m.attrs.set(k, v) }));
    },
  };
  return { doc, html, bars: () => metas.map((m) => m.attrs.get('content')) };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe('the theme', () => {
  it('is the one saved, or the system’s for anything else', () => {
    expect(THEMES).toEqual(['system', 'light', 'dark']);
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    for (const v of [null, undefined, '', 'system', 'auto', 'DARK', ' dark', 5, {}]) expect(parseTheme(v), String(v)).toBe('system');
  });

  it("shows light or dark as chosen, and the system's mode otherwise", () => {
    expect(effectiveTheme('system', true)).toBe('dark');
    expect(effectiveTheme('system', false)).toBe('light');
    expect(effectiveTheme('light', true)).toBe('light');
    expect(effectiveTheme('dark', false)).toBe('dark');
  });

  it("marks <html> with the chosen theme, and none for the system's; the browser's bar follows", () => {
    const { doc, html, bars } = fakeDocument();
    applyTheme(doc, 'dark');
    expect(html.get('data-theme')).toBe('dark');
    expect(bars()).toEqual([BAR_COLOR.dark, BAR_COLOR.dark]);
    applyTheme(doc, 'light');
    expect(html.get('data-theme')).toBe('light');
    expect(bars()).toEqual([BAR_COLOR.light, BAR_COLOR.light]);
    applyTheme(doc, 'system');
    expect(html.has('data-theme')).toBe(false);
    expect(bars()).toEqual([BAR_COLOR.light, BAR_COLOR.dark]); // each for its own media again
  });

  it('is kept in this browser, and the system’s when the browser refuses its storage', () => {
    const storage = memoryStorage();
    expect(readTheme(storage)).toBe('system');
    saveTheme(storage, 'dark');
    expect(storage.data.get(THEME_KEY)).toBe('dark');
    expect(readTheme(storage)).toBe('dark');
    storage.data.set(THEME_KEY, 'purple');
    expect(readTheme(storage)).toBe('system');
    const refusing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readTheme(refusing)).toBe('system');
    expect(() => saveTheme(refusing, 'light')).not.toThrow();
    expect(readTheme(null)).toBe('system');
  });
});

describe('the theme in the page', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts from the saved choice, follows the system's mode, other tabs and the user's choice", () => {
    const { doc, html } = fakeDocument();
    const storage = memoryStorage();
    storage.data.set(THEME_KEY, 'light');
    let system: (() => void) | undefined;
    const query = { matches: true, addEventListener: (_: string, fn: () => void) => (system = fn) };
    let otherTab: ((e: { key: string | null; newValue: string | null }) => void) | undefined;
    vi.stubGlobal('document', doc);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('matchMedia', (q: string) => (expect(q).toBe('(prefers-color-scheme: dark)'), query));
    vi.stubGlobal('addEventListener', (type: string, fn: typeof otherTab) => type === 'storage' && (otherTab = fn));

    startTheme();
    expect(themeChoice()).toBe('light');
    expect(html.get('data-theme')).toBe('light');
    expect(isDarkTheme()).toBe(false); // light chosen on a system in dark mode

    setThemeChoice('system');
    expect(storage.data.get(THEME_KEY)).toBe('system');
    expect(html.has('data-theme')).toBe(false);
    expect(isDarkTheme()).toBe(true);
    query.matches = false;
    system!();
    expect(isDarkTheme()).toBe(false);

    otherTab!({ key: 'something-else', newValue: 'dark' });
    expect(themeChoice()).toBe('system');
    otherTab!({ key: THEME_KEY, newValue: 'dark' });
    expect(themeChoice()).toBe('dark');
    expect(html.get('data-theme')).toBe('dark');
    expect(isDarkTheme()).toBe(true);
  });
});

describe('the theme in the styles, the page and the words', () => {
  const css = readFileSync('src/web/styles.css', 'utf8');
  /** The declarations of the first block that opens with `head`. */
  const block = (head: string) => {
    const start = css.indexOf(head);
    expect(start, head).toBeGreaterThanOrEqual(0);
    const open = css.indexOf('{', start + head.length - 1);
    return css
      .slice(open + 1, css.indexOf('}', open))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  };

  it('has the same dark colours for the system’s dark mode and for dark chosen', () => {
    const system = block("@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {");
    const chosen = block(":root[data-theme='dark'] {");
    expect(system.length).toBeGreaterThan(10);
    expect(chosen).toEqual(system);
    expect(chosen).toContain('color-scheme: dark;');
    // Nothing else in the styles follows the system's mode alone.
    expect(css.match(/prefers-color-scheme/g)).toHaveLength(1);
  });

  it("gives the browser's bar the page's background", () => {
    expect(block(':root {')).toContain(`--bg: ${BAR_COLOR.light};`);
    expect(block(":root[data-theme='dark'] {")).toContain(`--bg: ${BAR_COLOR.dark};`);
    const html = readFileSync('src/web/index.html', 'utf8');
    expect(html).toContain(`<meta name="theme-color" content="${BAR_COLOR.light}" media="(prefers-color-scheme: light)" />`);
    expect(html).toContain(`<meta name="theme-color" content="${BAR_COLOR.dark}" media="(prefers-color-scheme: dark)" />`);
  });

  it('is set before the page is drawn, from the same place, and only to light or dark', () => {
    const html = readFileSync('src/web/index.html', 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain(`localStorage.getItem('${THEME_KEY}')`);
    expect(head).toContain("if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);");
    // Before the app's module, and kept from throwing where the browser refuses its storage.
    expect(html.indexOf(THEME_KEY)).toBeLessThan(html.indexOf('<script type="module"'));
    expect(head).toMatch(/try \{[\s\S]*\} catch \(e\) \{\}/);
  });

  it('is named in both languages, for every choice', () => {
    for (const t of [zhTW, en]) {
      expect(Object.keys(t.settings.themes).sort()).toEqual([...THEMES].sort());
      expect(t.settings.appearance).toBeTruthy();
      expect(t.settings.nav.appearance).toBeTruthy();
    }
  });
});
