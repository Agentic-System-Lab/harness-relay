import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyTheme, BAR_COLOR, nextChoice, parseTheme, shownTheme, THEME_KEY, wire } from '../site/assets/theme.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const PAGES = ['site/index.html', 'site/zh-TW/index.html'];
const WORDS = { 'site/index.html': ['Switch to dark theme', 'Switch to light theme'], 'site/zh-TW/index.html': ['切換成深色主題', '切換成淺色主題'] } as const;

/** Just enough of a page for theme.js: <html>'s attributes, the theme-color metas and the theme button. */
function fakePage() {
  const html = new Map<string, string>();
  const element = (attrs: [string, string][]) => {
    const map = new Map(attrs);
    const clicks: (() => void)[] = [];
    return {
      map,
      click: () => clicks.forEach((fn) => fn()),
      getAttribute: (k: string) => map.get(k) ?? null,
      setAttribute: (k: string, v: string) => void map.set(k, v),
      addEventListener: (type: string, fn: () => void) => type === 'click' && clicks.push(fn),
    };
  };
  const metas = [
    element([['media', '(prefers-color-scheme: light)'], ['content', BAR_COLOR.light]]),
    element([['media', '(prefers-color-scheme: dark)'], ['content', BAR_COLOR.dark]]),
  ];
  const button = element([['data-to-dark', 'Switch to dark theme'], ['data-to-light', 'Switch to light theme']]);
  // The classes on <html>, and the ones it had each time the page was drawn (reading the layout).
  const classes = new Set<string>();
  const drawnWith: string[][] = [];
  const doc = {
    documentElement: {
      setAttribute: (k: string, v: string) => void html.set(k, v),
      removeAttribute: (k: string) => void html.delete(k),
      classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
    },
    body: {
      get offsetHeight() {
        drawnWith.push([...classes]);
        return 0;
      },
    },
    querySelectorAll: (selector: string) => {
      if (selector === 'meta[name="theme-color"]') return metas;
      if (selector === '[data-theme-toggle]') return [button];
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  return { doc, html, button, classes, drawnWith, label: () => button.map.get('aria-label'), bars: () => metas.map((m) => m.map.get('content')) };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

/** The system's light or dark mode, which the test can change. */
function systemMode(dark: boolean) {
  const listeners: (() => void)[] = [];
  return {
    matches: dark,
    addEventListener: (_: 'change', fn: () => void) => void listeners.push(fn),
    set(next: boolean) {
      this.matches = next;
      listeners.forEach((fn) => fn());
    },
  };
}

function otherTabs() {
  let listener: ((e: { key: string | null; newValue: string | null }) => void) | undefined;
  return {
    addEventListener: (_: 'storage', fn: typeof listener) => void (listener = fn),
    send: (key: string | null, newValue: string | null) => listener!({ key, newValue }),
  };
}

describe("the landing page's theme", () => {
  it('is the one saved, or the system’s for anything else', () => {
    expect(THEME_KEY).toBe('harness-relay.theme');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    for (const v of [null, undefined, '', 'system', 'auto', 'DARK', ' dark', 5, {}]) expect(parseTheme(v), String(v)).toBe('system');
    expect(shownTheme('system', true)).toBe('dark');
    expect(shownTheme('system', false)).toBe('light');
    expect(shownTheme('light', true)).toBe('light');
    expect(shownTheme('dark', false)).toBe('dark');
  });

  it('turns to the other theme at each press, and back to the system’s when that is the one it has', () => {
    expect(nextChoice('system', false)).toBe('dark');
    expect(nextChoice('dark', false)).toBe('system');
    expect(nextChoice('system', true)).toBe('light');
    expect(nextChoice('light', true)).toBe('system');
    // Chosen against a system that has changed since: still the other theme, kept as a choice.
    expect(nextChoice('light', false)).toBe('dark');
    expect(nextChoice('dark', true)).toBe('light');
  });

  it("marks <html> with the chosen theme and none for the system's; the bar and the button follow", () => {
    const { doc, html, label, bars, button } = fakePage();
    applyTheme(doc, 'dark', false);
    expect(html.get('data-theme')).toBe('dark');
    expect(bars()).toEqual([BAR_COLOR.dark, BAR_COLOR.dark]);
    expect(label()).toBe('Switch to light theme');
    expect(button.map.get('title')).toBe('Switch to light theme');
    applyTheme(doc, 'light', true);
    expect(html.get('data-theme')).toBe('light');
    expect(bars()).toEqual([BAR_COLOR.light, BAR_COLOR.light]);
    expect(label()).toBe('Switch to dark theme');
    applyTheme(doc, 'system', true);
    expect(html.has('data-theme')).toBe(false);
    expect(bars()).toEqual([BAR_COLOR.light, BAR_COLOR.dark]); // each for its own media again
    expect(label()).toBe('Switch to light theme');
    applyTheme(doc, 'system', false);
    expect(label()).toBe('Switch to dark theme');
  });

  it('follows the system until the visitor presses the button, then keeps their choice in this browser', () => {
    const page = fakePage();
    const storage = memoryStorage();
    const media = systemMode(false);
    wire({ doc: page.doc, storage, media, win: otherTabs() });
    expect(page.html.has('data-theme')).toBe(false);
    expect(page.label()).toBe('Switch to dark theme');
    media.set(true); // the system turns dark: the button's words follow (the colours follow in site.css)
    expect(page.label()).toBe('Switch to light theme');

    page.button.click();
    expect(storage.data.get(THEME_KEY)).toBe('light');
    expect(page.html.get('data-theme')).toBe('light');
    expect(page.label()).toBe('Switch to dark theme');
    // Drawn with transitions off, so that every colour changes at once; then they are on again.
    expect(page.drawnWith.at(-1)).toEqual(['theme-changing']);
    expect(page.classes.size).toBe(0);
    media.set(false); // a choice stays when the system changes
    expect(page.html.get('data-theme')).toBe('light');

    page.button.click();
    expect(storage.data.get(THEME_KEY)).toBe('dark');
    expect(page.html.get('data-theme')).toBe('dark');
    page.button.click(); // light again, which the system has now: it follows the system again
    expect(storage.data.has(THEME_KEY)).toBe(false);
    expect(page.html.has('data-theme')).toBe(false);
    media.set(true);
    expect(page.label()).toBe('Switch to light theme');
  });

  it('starts from the saved choice, and changes with the other tabs of this browser', () => {
    const page = fakePage();
    const storage = memoryStorage();
    storage.data.set(THEME_KEY, 'dark');
    const tabs = otherTabs();
    wire({ doc: page.doc, storage, media: systemMode(false), win: tabs });
    expect(page.html.get('data-theme')).toBe('dark');
    expect(page.bars()).toEqual([BAR_COLOR.dark, BAR_COLOR.dark]);

    tabs.send('harness-relay.lang', 'en');
    expect(page.html.get('data-theme')).toBe('dark');
    tabs.send(THEME_KEY, 'light');
    expect(page.html.get('data-theme')).toBe('light');
    tabs.send(THEME_KEY, null); // the other tab went back to the system's
    expect(page.html.has('data-theme')).toBe(false);
  });

  it('still works when the browser refuses site data, until the page is loaded again', () => {
    const page = fakePage();
    const refusing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    wire({ doc: page.doc, storage: refusing, media: systemMode(false), win: null });
    expect(page.html.has('data-theme')).toBe(false);
    page.button.click();
    expect(page.html.get('data-theme')).toBe('dark');
    page.button.click();
    expect(page.html.has('data-theme')).toBe(false);

    const without = fakePage();
    wire({ doc: without.doc, storage: null, media: null, win: null });
    without.button.click();
    expect(without.html.get('data-theme')).toBe('dark');
  });
});

describe("the landing page's theme in its styles and pages", () => {
  const css = read('site/assets/site.css');
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

  it('has the same dark colours for the system’s dark mode and for dark chosen, and nothing else follows the system alone', () => {
    const system = block("@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {");
    const chosen = block(":root[data-theme='dark'] {");
    expect(system.length).toBeGreaterThan(20);
    expect(chosen).toEqual(system);
    expect(chosen).toContain('color-scheme: dark;');
    // Everything that differs in dark mode is a token there: one more media query would miss a choice.
    expect(css.match(/prefers-color-scheme/g)).toHaveLength(1);
    // The button's icon: the moon in the light theme, the sun in the dark one.
    expect(block(':root {')).toEqual(expect.arrayContaining(['--when-light: block;', '--when-dark: none;']));
    expect(chosen).toEqual(expect.arrayContaining(['--when-light: none;', '--when-dark: block;']));
    expect(block('.theme-toggle .i-moon {')).toEqual(['display: var(--when-light);']);
    expect(block('.theme-toggle .i-sun {')).toEqual(['display: var(--when-dark);']);
    expect(css).toContain('.theme-changing *,\n.theme-changing *::before,\n.theme-changing *::after {');
    expect(block('.theme-changing *::after {')).toEqual(['transition: none !important;']);
  });

  it("gives the browser's bar the page's background", () => {
    expect(block(':root {')).toContain(`--bg: ${BAR_COLOR.light};`);
    expect(block(":root[data-theme='dark'] {")).toContain(`--bg: ${BAR_COLOR.dark};`);
    for (const page of PAGES) {
      const html = read(page);
      expect(html, page).toContain(`<meta name="theme-color" content="${BAR_COLOR.light}" media="(prefers-color-scheme: light)" />`);
      expect(html, page).toContain(`<meta name="theme-color" content="${BAR_COLOR.dark}" media="(prefers-color-scheme: dark)" />`);
    }
  });

  it('is set before the page is drawn, from the same key, and only to light or dark', () => {
    for (const page of PAGES) {
      const html = read(page);
      const head = html.slice(0, html.indexOf('</head>'));
      const inline = head.slice(head.indexOf('<script>'), head.indexOf('</script>'));
      expect(inline, page).toContain(`localStorage.getItem('${THEME_KEY}')`);
      expect(inline, page).toContain("if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);");
      // In a try of its own: a browser that refuses site data throws there, and the page still shows.
      expect(inline, page).toMatch(/try \{\s*var theme = [^}]*\} catch \(e\) \{\}/);
      expect(head, page).toContain(`<script type="module" src="${page.includes('zh-TW') ? '../' : ''}assets/theme.js"></script>`);
    }
  });

  it('has its button at the end of the header, after GitHub, in both languages', () => {
    for (const page of PAGES) {
      const html = read(page);
      const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
      const tools = header.slice(header.indexOf('<div class="header-tools">'));
      const button = tools.match(/<button class="btn btn-ghost theme-toggle" type="button" data-theme-toggle ([^>]*)>([\s\S]*?)<\/button>/);
      expect(button, page).not.toBeNull();
      // After the GitHub button, and the last thing in the header.
      expect(tools.indexOf(button![0]), page).toBeGreaterThan(tools.indexOf('href="https://github.com/Agentic-System-Lab/harness-relay"'));
      expect(tools.slice(tools.indexOf(button![0]) + button![0].length).trim(), page).toMatch(/^<\/div>\s*<\/div>\s*$/);
      const [toDark, toLight] = WORDS[page as keyof typeof WORDS];
      expect(button![1], page).toBe(`data-to-dark="${toDark}" data-to-light="${toLight}" aria-label="${toDark}"`);
      expect(button![2], page).toContain('<use href="#i-moon" />');
      expect(button![2], page).toContain('<use href="#i-sun" />');
      expect(html, page).toContain('<symbol id="i-moon"');
      expect(html, page).toContain('<symbol id="i-sun"');
      // Only in the header.
      expect(html.match(/data-theme-toggle/g), page).toHaveLength(1);
    }
  });
});
