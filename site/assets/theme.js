// Harness Relay landing page: the light or dark theme. The page follows the visitor's system
// (`prefers-color-scheme`) until they press the theme button at the end of the header; their choice is then
// kept in this browser (`localStorage`, like the language), and each page's <head> script sets it on <html>
// (`data-theme`) before anything is drawn, so it does not flash. Pressing the button again to get the
// theme the system has goes back to following the system. site.css holds the colours: the dark ones under
// `prefers-color-scheme: dark` unless `data-theme="light"`, and under `data-theme="dark"`, as in the app
// (src/web/theme.ts). Its functions are tested in test/site-theme.test.ts.

/** Where the choice is kept (both pages' <head> scripts read it too). */
export const THEME_KEY = 'harness-relay.theme';

/** The browser's bar colour (`theme-color`) for each theme: the page's background (`--bg` in site.css). */
export const BAR_COLOR = { light: '#ffffff', dark: '#141415' };

/** A saved choice: light or dark; anything else (nothing saved, a broken value) is the system's. */
export function parseTheme(value) {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The theme the page shows for `choice`, when the system is in dark mode or not. */
export function shownTheme(choice, systemDark) {
  return choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
}

/** The choice after a press of the button: the other theme, or the system's again when it is that one. */
export function nextChoice(choice, systemDark) {
  const next = shownTheme(choice, systemDark) === 'dark' ? 'light' : 'dark';
  return next === shownTheme('system', systemDark) ? 'system' : next;
}

/**
 * Shows `choice` on the page: `data-theme` on <html> (none for the system's, so that the styles follow
 * `prefers-color-scheme`), the browser's bar colour (each `theme-color` for its own media with the
 * system's, else the chosen theme's for both) and the button's words, which say what a press does
 * (`data-to-dark` and `data-to-light` hold them in the page's language). Its icon follows site.css.
 */
export function applyTheme(doc, choice, systemDark) {
  if (choice === 'system') doc.documentElement.removeAttribute('data-theme');
  else doc.documentElement.setAttribute('data-theme', choice);
  for (const meta of doc.querySelectorAll('meta[name="theme-color"]')) {
    const forDark = /dark/.test(meta.getAttribute('media') || '');
    meta.setAttribute('content', BAR_COLOR[choice === 'system' ? (forDark ? 'dark' : 'light') : choice]);
  }
  const words = shownTheme(choice, systemDark) === 'dark' ? 'data-to-light' : 'data-to-dark';
  for (const button of doc.querySelectorAll('[data-theme-toggle]')) {
    const label = button.getAttribute(words);
    if (!label) continue;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  }
}

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // Site data is off: reading localStorage itself throws.
  }
}

/**
 * Wires the theme button and keeps the page in step with the system's mode and the other tabs of this
 * browser. The parts of the browser it uses can be passed in (the tests' fakes).
 */
export function wire({
  doc = document,
  storage = browserStorage(),
  media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null,
  win = globalThis,
} = {}) {
  let choice = 'system';
  try {
    choice = parseTheme(storage?.getItem(THEME_KEY));
  } catch {}
  const show = () => applyTheme(doc, choice, Boolean(media?.matches));
  // A change while the page is open: every colour at once. The buttons fade their background, and would
  // show their new text on the old background for a moment; site.css turns transitions off under this
  // class, and reading the layout draws the new colours with it, before it goes.
  const change = () => {
    const root = doc.documentElement;
    root.classList?.add('theme-changing');
    show();
    void doc.body?.offsetHeight;
    root.classList?.remove('theme-changing');
  };
  show();
  media?.addEventListener?.('change', change);
  // Chosen in another tab: this one changes too.
  win?.addEventListener?.('storage', (e) => {
    if (e.key !== THEME_KEY) return;
    choice = parseTheme(e.newValue);
    change();
  });
  for (const button of doc.querySelectorAll('[data-theme-toggle]')) {
    button.addEventListener('click', () => {
      choice = nextChoice(choice, Boolean(media?.matches));
      try {
        if (choice === 'system') storage?.removeItem(THEME_KEY);
        else storage?.setItem(THEME_KEY, choice);
      } catch {
        // The browser refuses site data: the choice lasts until the page is loaded again.
      }
      change();
    });
  }
}

if (typeof document !== 'undefined') wire();
