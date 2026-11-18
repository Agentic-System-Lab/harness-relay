import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyTheme, BAR_COLOR, nextChoice, parseTheme, shownTheme, THEME_KEY, wire } from '../site/assets/theme.js';
import { PAGE_FILES, SITE_PAGES } from './site-pages';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const PAGES = PAGE_FILES;
/** The theme button's words on each page, in its language. */
const WORDS = Object.fromEntries(
  SITE_PAGES.map(({ file, lang }) => [
    file,
    lang === 'en' ? ['Switch to dark theme', 'Switch to light theme'] : ['切換成深色主題', '切換成淺色主題'],
  ]),
);
/** How far a page is below the site's top: its path back to `assets/`. */
const up = (page: string) => '../'.repeat(page.split('/').length - 2);

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
    element([
      ['media', '(prefers-color-scheme: light)'],
      ['content', BAR_COLOR.light],
    ]),
    element([
      ['media', '(prefers-color-scheme: dark)'],
      ['content', BAR_COLOR.dark],
    ]),
  ];
  const button = element([
    ['data-to-dark', 'Switch to dark theme'],
    ['data-to-light', 'Switch to light theme'],
  ]);
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
  return {
    doc,
    html,
    button,
    classes,
    drawnWith,
    label: () => button.map.get('aria-label'),
    bars: () => metas.map((m) => m.map.get('content')),
  };
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

  it("keeps each agent's pill text 4.5:1 on its tint, in the light theme and the dark one", () => {
    /** A theme's tokens: the light ones, with the dark list over them for dark. */
    const tokens = (lines: string[]) =>
      new Map(
        lines.flatMap((l) => {
          const m = l.match(/^(--[\w-]+): (#[0-9a-f]{6});$/i);
          return m ? [[m[1], m[2]] as const] : [];
        }),
      );
    const light = tokens(block(':root {'));
    const dark = new Map([...light, ...tokens(block(":root[data-theme='dark'] {"))]);
    const rgb = (colours: Map<string, string>, name: string) => {
      const hex = colours.get(name);
      expect(hex, `${name} as a #rrggbb colour`).toBeDefined();
      return [1, 3, 5].map((i) => parseInt(hex!.slice(i, i + 2), 16));
    };
    const luminance = (c: number[]) => {
      const [r, g, b] = c.map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    // Every pill on the pages is in a message's head, in the card of one of the three agents (the home pages have one
    // of each), or in a use case's list of what ran (`.usecase-facts`, on the page itself), its agent's helper class on
    // its item...
    for (const page of PAGES) {
      const html = read(page);
      const placed = [
        ...html.matchAll(
          /<div class="ui ui-msg t-(claude|codex|grok)">\s*<span class="av" aria-hidden="true">\w<\/span>\s*<div class="ui-head">[^<]*<span class="pill">/g,
        ),
      ];
      const facts = [...html.matchAll(/<ul class="usecase-facts"[^>]*>(.*?)<\/ul>/g)].flatMap((m) => [
        ...m[1].matchAll(/<li class="t-(claude|codex|grok|antigravity|copilot)"><span class="pill">/g),
      ]);
      const home = SITE_PAGES.find((p) => p.file === page)?.path === '';
      if (home) expect(placed.map((m) => m[1]).sort(), page).toEqual(['claude', 'codex', 'grok']);
      else if (page.includes('use-cases')) expect(placed, page).toEqual([]);
      expect(html.match(/class="pill[" ]/g) ?? [], page).toHaveLength(placed.length + facts.length);
    }
    // ...so its tint is over the card's background (`.ui`, the page's), or the page's, with nothing in between.
    expect(block('.ui {')).toContain('background: var(--bg);');
    for (const rule of ['.ui-msg {', '.ui-head {', '.usecase-facts {', '.case {', '.cases {', '.usecase-head {'])
      expect(
        block(rule).filter((l) => l.startsWith('background')),
        rule,
      ).toEqual([]);
    // The pill: the agent's -ink on the agent's colour at this strength.
    const pill = block('.pill {');
    expect(pill).toContain('color: var(--agent-ink, var(--muted));');
    const tint = pill.join('\n').match(/^background: color-mix\(in srgb, var\(--agent, var\(--muted\)\) (\d+)%, transparent\);$/m);
    expect(tint).not.toBeNull();
    const share = Number(tint![1]) / 100;
    for (const agent of ['claude', 'codex', 'grok', 'antigravity', 'copilot']) {
      // Which tokens the agent's helper class gives the pill.
      const helper = block(`.t-${agent} {`);
      const token = (name: string) => {
        const m = helper.map((l) => l.match(new RegExp(`^${name}: var\\((--[\\w-]+)\\);$`))).find(Boolean);
        expect(m, `${name} in .t-${agent}`).toBeTruthy();
        return m![1];
      };
      const [brand, ink] = [token('--agent'), token('--agent-ink')];
      for (const [theme, colours] of [
        ['light', light],
        ['dark', dark],
      ] as const) {
        const under = rgb(colours, '--bg');
        const background = rgb(colours, brand).map((c, i) => c * share + under[i] * (1 - share));
        expect(ratio(rgb(colours, ink), background), `${agent} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
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
      expect(inline, page).toContain(
        "if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);",
      );
      // In a try of its own: a browser that refuses site data throws there, and the page still shows.
      expect(inline, page).toMatch(/try \{\s*var theme = [^}]*\} catch \(e\) \{\}/);
      expect(head, page).toContain(`<script type="module" src="${up(page)}assets/theme.js"></script>`);
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
      const [toDark, toLight] = WORDS[page];
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
