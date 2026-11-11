import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROVIDERS, PROVIDER_LABEL } from '../src/shared/types';
import { en } from '../src/web/locales/en';
import { zhTW } from '../src/web/locales/zh-TW';
import { REPORT_EMAIL } from '../src/web/report';

// The community files (the issue forms, the code of conduct, the security policy) repeat a few things
// the code decides: the CLIs' names, the modes' and permissions' labels, where reports go.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** A dropdown's options in an issue form: the `- …` lines under its `options:`, up to the next field. */
function options(form: string, id: string): string[] {
  const field = form.split(/\n  - type: /).find((f) => f.includes(`\n    id: ${id}\n`));
  if (!field) throw new Error(`no field ${id}`);
  const list = field.slice(field.indexOf('options:'));
  return [...list.matchAll(/^ {8}- (.+)$/gm)].map((m) => m[1]!.trim());
}

describe('the bug report form', () => {
  const form = read('.github/ISSUE_TEMPLATE/bug_report.yml');

  it('names each CLI as the app does', () => {
    const cli = options(form, 'agents');
    for (const p of PROVIDERS) expect(cli).toContain(PROVIDER_LABEL[p]);
    expect(cli).toHaveLength(PROVIDERS.length + 1);
  });

  it("names each mode and permission as the UI does, in both languages", () => {
    const modes = (['roundtable', 'parallel', 'relay'] as const).map((m) => `${en.modes[m].label} · ${zhTW.modes[m].label}`);
    expect(options(form, 'mode').slice(0, -1)).toEqual(modes);
    const permissions = (['read-only', 'edit', 'full'] as const).map((p) => `${en.permissions[p].label} · ${zhTW.permissions[p].label}`);
    expect(options(form, 'permission').slice(0, -1)).toEqual(permissions);
  });
});

describe('where reports go', () => {
  it('the code of conduct and the security policy give the address the app sends problem reports to', () => {
    for (const doc of ['CODE_OF_CONDUCT.md', 'CODE_OF_CONDUCT.zh-TW.md', 'SECURITY.md', 'SECURITY.zh-TW.md']) {
      const addresses = new Set(read(doc).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g));
      expect([...addresses], doc).toEqual([REPORT_EMAIL]);
    }
  });
});
