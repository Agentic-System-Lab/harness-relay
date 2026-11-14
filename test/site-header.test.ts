import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The landing page's header on a narrow screen: the name, the language switch and the buttons each stay on
// one line (measured in Chromium at every width from 320px to 1300px, in both languages), and where the
// name does not fit beside the rest it goes, the logo staying.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const css = read('site/assets/site.css');
/** A rule's declarations at the top level of site.css, found as text (not by a pattern made from the selector). */
const rule = (selector: string) => {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

describe("the landing page's header", () => {
  it('never breaks 中文, or the switch, onto two lines: the switch is not squeezed by the buttons beside it', () => {
    expect(rule('.lang')).toContain('flex: none;');
    expect(rule('.lang a')).toContain('white-space: nowrap;');
  });

  it("keeps the name on one line, and hides it, not the logo, below the width where it fits beside the rest", () => {
    expect(rule('.brand')).toContain('white-space: nowrap;');
    expect(rule('.brand svg')).toContain('flex: none;');
    // The name, the switch and the buttons need some 481px: at 500px and below, the logo alone.
    expect(css).toMatch(/@media \(max-width: 500px\) \{\n {2}\.brand span \{\n {4}display: none;\n {2}\}/);
    expect(css.match(/\.brand span \{\s*display: none;/g)).toHaveLength(1);
    // Screen readers still hear the name: the header's link has it as its label, in both languages.
    for (const page of ['site/index.html', 'site/zh-TW/index.html']) {
      const header = read(page).match(/<header[\s\S]*?<\/header>/)![0];
      expect(header, page).toMatch(/<a class="brand" href="\.\/" aria-label="Harness Relay[^"]*">/);
    }
  });

  it('scrolls no page sideways on a phone, down to a 280px screen (measured in Chromium at every width from 280px)', () => {
    /** The declarations of `selector` inside the `@media (max-width: <width>px)` block that holds it. */
    const inside = (width: number, selector: string) => {
      const blocks = css.split(`@media (max-width: ${width}px) {`).slice(1).map((b) => b.slice(0, b.indexOf('\n}\n')));
      const block = blocks.find((b) => b.includes(`\n  ${selector} {`));
      expect(block, `${selector} at ${width}px`).toBeDefined();
      const start = block!.indexOf(`\n  ${selector} {`);
      return block!.slice(start, block!.indexOf('}', start));
    };
    // A long command or package name (@earendil-works/pi-coding-agent) breaks where it must, rather than
    // widen the quick start's list or the backends' excerpt.
    expect(inside(480, ':not(pre) > code')).toContain('white-space: normal;');
    expect(inside(480, ':not(pre) > code')).toContain('overflow-wrap: anywhere;');
    // The approval card's buttons ("Always allow “npx tsx” in this chat") wrap.
    expect(inside(480, '.ui-approval .ui-btn')).toContain('white-space: normal;');
    // The headline scales with the screen, so that the phrases it keeps whole fit.
    expect(rule('.phrase')).toContain('white-space: nowrap;');
    expect(inside(380, 'h1')).toContain('font-size: min(2.6rem, 11.4vw);');
    // The header's controls draw closer, and the page's sides narrow.
    expect(inside(360, ':root')).toContain('--gutter: 12px;');
    expect(inside(360, '.header-tools')).toContain('gap: 6px;');
    expect(inside(360, '.lang a')).toContain('padding: 4px 8px;');
    expect(inside(360, '.header-tools .btn.theme-toggle')).toContain('width: 32px;');
    expect(inside(300, '.lang a')).toContain('padding: 4px 6px;');
  });
});
