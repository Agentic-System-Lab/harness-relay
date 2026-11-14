import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The landing page's header on a narrow screen: the name, the language switch and the buttons each stay on
// one line (measured in Chromium at every width from 320px to 1300px, in both languages), and where the
// name does not fit beside the rest it goes, the logo staying.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const css = read('site/assets/site.css');
/** A rule's declarations at the top level of site.css. */
const rule = (selector: string) => css.match(new RegExp(`\\n${selector.replace(/[.*]/g, '\\$&')} \\{([^}]*)\\}`))![1]!;

describe("the landing page's header", () => {
  it('never breaks 中文, or the switch, onto two lines: the switch is not squeezed by the buttons beside it', () => {
    expect(rule('.lang')).toContain('flex: none;');
    expect(rule('.lang a')).toContain('white-space: nowrap;');
  });

  it("keeps the name on one line, and hides it, not the logo, below the width where it fits beside the rest", () => {
    expect(rule('.brand')).toContain('white-space: nowrap;');
    expect(rule('.brand svg')).toContain('flex: none;');
    // The name, the switch and the buttons need some 465px: at 480px and below, the logo alone.
    expect(css).toMatch(/@media \(max-width: 480px\) \{\n {2}\.brand span \{\n {4}display: none;\n {2}\}/);
    expect(css.match(/\.brand span \{\s*display: none;/g)).toHaveLength(1);
    // Screen readers still hear the name: the header's link has it as its label, in both languages.
    for (const page of ['site/index.html', 'site/zh-TW/index.html']) {
      const header = read(page).match(/<header[\s\S]*?<\/header>/)![0];
      expect(header, page).toMatch(/<a class="brand" href="\.\/" aria-label="Harness Relay[^"]*">/);
    }
  });
});
