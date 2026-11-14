import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The landing page's Codespaces links and the dialog they open first (site.js): both languages say the
// same, the links still work without JavaScript, and its sample terminal is what start.sh prints.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// The newest release's branch (test/codespaces-release.test.ts).
const CODESPACES = 'https://codespaces.new/Agentic-System-Lab/harness-relay/tree/latest-release?quickstart=1';
const PAGES = { 'site/index.html': 'docs/codespaces.md', 'site/zh-TW/index.html': 'docs/codespaces.zh-TW.md' } as const;

/** The page's Codespaces dialog, as written. */
function dialogOf(html: string): string {
  const m = html.match(/<dialog class="cs-dialog" id="codespaces"[\s\S]*?<\/dialog>/g);
  expect(m).toHaveLength(1);
  return m![0];
}

describe('the Codespaces dialog on the landing page', () => {
  it.each(Object.entries(PAGES))('%s: its links open it, and go to GitHub without JavaScript', (page, doc) => {
    const html = read(page);
    const links = [...html.matchAll(/<a [^>]*data-codespaces(?=[\s>])[^>]*>/g)].map((m) => m[0]);
    // The hero's button and the quick start's link.
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toContain(`href="${CODESPACES}"`);
    const dialog = dialogOf(html);
    // Its own button opens GitHub in a new tab, so its directions stay on screen.
    expect(dialog).toContain(`<a class="btn btn-primary" href="${CODESPACES}" target="_blank" rel="noopener">`);
    expect(dialog).toContain(`href="https://github.com/Agentic-System-Lab/harness-relay/blob/main/${doc}"`);
    expect(dialog).toContain('data-codespaces-close');
    expect(dialog).toContain('aria-labelledby="codespaces-title"');
    expect(html).toContain('<symbol id="i-close"');
  });

  it('says the same in both languages', () => {
    const [en, zh] = Object.keys(PAGES).map((p) => dialogOf(read(p)));
    const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;
    for (const pattern of [/<li>/g, /<code>/g, /<h[23]\b/g, /<a /g]) expect(count(zh!, pattern), String(pattern)).toBe(count(en!, pattern));
    // The facts that are the same words in both: the agents it installs (the seven that are not open source), the folder, the commands.
    for (const fact of ['Claude Code', 'Codex', 'Copilot', 'Grok', 'Cursor', 'Antigravity', 'Muse Code', 'OpenCode', '120 core-hours', '/workspaces/playground', 'bash .devcontainer/start.sh', '8787', 'DO_NOT_TRACK']) {
      expect(en, fact).toContain(fact);
      expect(zh, fact).toContain(fact);
    }
  });

  it("shows the terminal as start.sh and the server print it, the same on both pages", () => {
    // Compared as written, markup and all: only the chip saying how to click is in the page's language.
    const terminalOf = (page: string) => {
      const pre = dialogOf(read(page)).match(/<pre>[\s\S]*?<\/pre>/)![0];
      const chip = pre.indexOf('<span class="chip cs-click">');
      expect(chip).toBeGreaterThan(0);
      return pre.slice(0, chip) + pre.slice(pre.indexOf('</span>', chip) + '</span>'.length);
    };
    const [en, zh] = Object.keys(PAGES).map(terminalOf);
    expect(zh).toBe(en);
    const start = read('.devcontainer/start.sh');
    const server = read('src/server/index.ts');
    expect(en).toContain('Starting Harness Relay. Stop it with Ctrl+C; start it again with: bash .devcontainer/start.sh');
    expect(start).toContain('echo "Starting Harness Relay. Stop it with Ctrl+C; start it again with: bash .devcontainer/start.sh"');
    expect(en).toContain('Sign this browser in (once, within an hour): <span class="cs-link">https://your-codespace-8787.app.github.dev/#code=');
    expect(server).toContain('Sign this browser in (once, within an hour): ${');
    expect(en).toContain('\n  (or type this code on the sign-in page: ');
    expect(start).toContain('"  (or type this code on the sign-in page: ${BASH_REMATCH[2]})"');
  });

  it('keeps its button and guide link at its bottom while the rest scrolls under them', () => {
    const css = read('site/assets/site.css');
    // Found as text, not by a pattern made from the selector.
    const rule = (selector: string) => {
      const start = css.indexOf(`\n${selector} {`);
      expect(start, selector).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf('}', start));
    };
    // The dialog is what scrolls, so a sticky bar in it stays at its bottom edge.
    expect(rule('.cs-dialog')).toContain('overflow: auto;');
    const actions = rule('.cs-actions');
    for (const declaration of ['position: sticky;', 'bottom: 0;', 'background: var(--bg);']) expect(actions).toContain(declaration);
    // Across the dialog's whole width, holding the bottom padding the body leaves out.
    expect(actions).toContain('margin: 4px calc(-1 * var(--cs-pad)) 0;');
    expect(actions).toContain('padding: 16px var(--cs-pad) var(--cs-pad);');
    expect(rule('.cs-body')).toContain('padding: var(--cs-pad) var(--cs-pad) 0;');
    // On one line, also on a phone (measured in Chromium at every width from 280px to 1920px, in both
    // languages): neither the button nor the link is squeezed, and on narrow screens the dialog takes more
    // of the width (past the browser's own limit for a modal dialog) and the two get smaller. It may wrap
    // only where a phone's fonts are wider still: two lines rather than a dialog that scrolls sideways.
    expect(actions).toContain('flex-wrap: wrap;');
    expect(rule('.cs-actions > *')).toContain('flex: none;');
    const narrow = (width: number) => css.match(new RegExp(`@media \\(max-width: ${width}px\\) \\{\\n  \\.cs-[\\s\\S]*?\\n\\}`))![0];
    expect(narrow(440)).toMatch(/\.cs-dialog \{[^}]*--cs-pad: 16px;[^}]*width: calc\(100% - 16px\);[^}]*max-width: none;/);
    expect(narrow(400)).toMatch(/\.cs-actions \.btn svg \{\s*display: none;/);
    expect(narrow(400)).toContain('font-size: 14px;');
    expect(narrow(350)).toContain('font-size: 13px;');
    expect(narrow(320)).toMatch(/\.cs-dialog \{[^}]*--cs-pad: 12px;[^}]*width: calc\(100% - 8px\);/);
    expect(narrow(320)).toContain('font-size: 12px;');
    expect(narrow(295)).toContain('--cs-pad: 10px;');
    // The last thing in the dialog, so nothing is hidden below it.
    const dialog = dialogOf(read('site/index.html'));
    expect(dialog.slice(dialog.indexOf('<div class="cs-actions">')).replace(/<div class="cs-actions">|<a [\s\S]*?<\/a>|<\/(div|dialog)>|\s+/g, '')).toBe('');
  });

  it('is opened by site.js only where the browser has modal dialogs, and a modified click goes to GitHub', () => {
    const js = read('site/assets/site.js');
    expect(js).toContain("document.getElementById('codespaces')");
    expect(js).toContain("typeof codespaces.showModal === 'function'");
    expect(js).toContain("document.querySelectorAll('[data-codespaces]')");
    expect(js).toMatch(/event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
  });
});
