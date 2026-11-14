import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The landing page's Codespaces links and the dialog they open first (site.js): both languages say the
// same, the links still work without JavaScript, and its sample terminal is what start.sh prints.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const CODESPACES = 'https://codespaces.new/Agentic-System-Lab/harness-relay?quickstart=1';
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
    // The facts that are the same words in both: the agents it installs, the folder, the commands.
    for (const fact of ['Claude Code', 'Codex', 'Copilot', 'OpenCode', 'Pi', '120 core-hours', '/workspaces/playground', 'env -u GITHUB_TOKEN gh auth login', 'bash .devcontainer/start.sh', '8787']) {
      expect(en, fact).toContain(fact);
      expect(zh, fact).toContain(fact);
    }
  });

  it("shows the terminal as start.sh and the server print it, the same on both pages", () => {
    const terminals = Object.keys(PAGES).map((p) => dialogOf(read(p)).match(/<pre>[\s\S]*?<\/pre>/)![0].replace(/<span class="chip cs-click">.*?<\/span>/, ''));
    expect(terminals[1]).toBe(terminals[0]);
    const text = terminals[0]!.replace(/<[^>]+>/g, '');
    const start = read('.devcontainer/start.sh');
    const server = read('src/server/index.ts');
    expect(text).toContain('Starting Harness Relay. Stop it with Ctrl+C; start it again with: bash .devcontainer/start.sh');
    expect(start).toContain('echo "Starting Harness Relay. Stop it with Ctrl+C; start it again with: bash .devcontainer/start.sh"');
    expect(text).toContain('Sign this browser in (once, within an hour): https://your-codespace-8787.app.github.dev/#code=');
    expect(server).toContain('Sign this browser in (once, within an hour): ${');
    expect(text).toContain('  (or type this code on the sign-in page: ');
    expect(start).toContain('"  (or type this code on the sign-in page: ${BASH_REMATCH[2]})"');
  });

  it('is opened by site.js only where the browser has modal dialogs, and a modified click goes to GitHub', () => {
    const js = read('site/assets/site.js');
    expect(js).toContain("document.getElementById('codespaces')");
    expect(js).toContain("typeof codespaces.showModal === 'function'");
    expect(js).toContain("document.querySelectorAll('[data-codespaces]')");
    expect(js).toMatch(/event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
  });
});
