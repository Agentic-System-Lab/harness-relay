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

  it('the landing page installs the desktop app, with no commands to start it', () => {
    for (const page of ['site/index.html', 'site/zh-TW/index.html']) {
      const html = read(page);
      // Download buttons for each system (test/site-downloads.test.ts checks where they point).
      for (const system of ['mac', 'win', 'linux']) expect(html, `${page} ${system}`).toContain(`data-download="${system}"`);
      expect(html, page).toContain('data-download-primary');
      // No command blocks: running from source is one line for servers and development, linking to the README.
      // (A <pre> in an approval card is an agent's command, shown, not one for the reader.)
      expect(html, page).not.toContain('class="cmd"');
      expect(html, page).not.toContain('git clone');
      expect(html.match(/npm run dev/g), page).toHaveLength(1);
      expect(html.match(/npm start/g), page).toHaveLength(1);
      expect(html, page).toMatch(/href="https:\/\/github\.com\/Agentic-System-Lab\/harness-relay(#quick-start|\/blob\/main\/README\.zh-TW\.md#快速開始)"/);
    }
  });

  it('the README and user guide never join commands with &&', () => {
    for (const doc of ['README.md', 'README.zh-TW.md', 'docs/user-guide.md', 'docs/user-guide.zh-TW.md']) {
      const code = [...read(doc).matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map((m) => m[0]);
      for (const snippet of code) expect(snippet, doc).not.toContain('&&');
    }
  });

  it('the README quick start starts from a fresh clone and runs the built app', () => {
    for (const doc of ['README.md', 'README.zh-TW.md']) {
      expect(read(doc), doc).toContain(
        'git clone https://github.com/Agentic-System-Lab/harness-relay\ncd harness-relay\nnpm install\nnpm run build\nnpm start\n```\n\n' +
          // The sign-in link the server prints, on the built app's address.
          (doc === 'README.md'
            ? 'Open the sign-in link `npm start` prints in the terminal (`http://127.0.0.1:8787/#code=…`'
            : '打開 `npm start` 在終端機印出的登入連結（`http://127.0.0.1:8787/#code=…`'),
      );
    }
  });

  it('no bare address runs into the Chinese text after it, which GitHub would link along with it', () => {
    const docs = ['README.zh-TW.md', 'CONTRIBUTING.zh-TW.md', 'CODE_OF_CONDUCT.zh-TW.md', 'SECURITY.zh-TW.md', 'e2e/README.zh-TW.md', 'desktop/README.zh-TW.md', ...['architecture', 'developer-guide', 'user-guide', 'remote-access', 'codespaces'].map((d) => `docs/${d}.zh-TW.md`)];
    for (const doc of docs) {
      // Outside code: an address written as <…>, [text](…) or in backticks ends where it should.
      const prose = read(doc).replace(/```[\s\S]*?```|`[^`\n]+`/g, '');
      const bare = [...prose.matchAll(/(?<![<(\["'])https?:\/\/[^\s)>\]"']*[^\x00-\x7F]/g)].map((m) => m[0]);
      expect(bare, doc).toEqual([]);
    }
  });

  it('the user guide starts the built app', () => {
    for (const doc of ['docs/user-guide.md', 'docs/user-guide.zh-TW.md']) {
      expect(read(doc), doc).toContain('npm install\nnpm run build\nnpm start\n```');
    }
  });
});
