import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The commands people copy from the landing page and the docs must run in any shell, including
// Windows PowerShell 5.1 (no `&&`) and cmd.exe, which npm uses for scripts on Windows (no `VAR=value cmd`).

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('commands people copy', () => {
  it('npm scripts set no variables the Unix way', () => {
    const { scripts } = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    for (const [name, script] of Object.entries(scripts)) {
      expect(script, `npm run ${name}`).not.toMatch(/(^|&&|;)\s*[A-Za-z_]\w*=/);
    }
  });

  it('the landing page never joins commands with &&', () => {
    for (const page of ['site/index.html', 'site/zh-TW/index.html']) {
      const blocks = [...read(page).matchAll(/<(pre|code)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]);
      expect(blocks.length, page).toBeGreaterThan(0);
      for (const block of blocks) expect(block, page).not.toMatch(/&amp;&amp;|&&/);
    }
  });

  it('the README and user guide never join commands with &&', () => {
    for (const doc of ['README.md', 'README.zh-TW.md', 'docs/user-guide.md', 'docs/user-guide.zh-TW.md']) {
      const code = [...read(doc).matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]);
      for (const snippet of code) expect(snippet, doc).not.toContain('&&');
    }
  });

  it('the README quick start starts from a fresh clone', () => {
    for (const doc of ['README.md', 'README.zh-TW.md']) {
      expect(read(doc), doc).toContain(
        'git clone https://github.com/Agentic-System-Lab/harness-relay\ncd harness-relay\nnpm install\nnpm run dev',
      );
    }
  });
});
