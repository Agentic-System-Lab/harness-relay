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

  it('the landing page installs the built app; npm run dev is only mentioned for development', () => {
    const commands = [
      'git clone https://github.com/Agentic-System-Lab/harness-relay',
      'cd harness-relay',
      'npm install',
      'npm run build',
      'npm start',
    ];
    for (const page of ['site/index.html', 'site/zh-TW/index.html']) {
      const html = read(page);
      for (const id of ['cmd-hero', 'cmd-start']) {
        const block = html.match(new RegExp(`<pre id="${id}">([\\s\\S]*?)</pre>`))?.[1] ?? '';
        const lines = block.replace(/<span class="prompt">\$ <\/span>/g, '').split('\n');
        expect(lines, `${page} #${id}`).toEqual(commands);
      }
      expect(html, page).toContain('<b>http://127.0.0.1:8787</b>');
      expect(html.match(/npm run dev/g), page).toHaveLength(1);
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
          (doc === 'README.md' ? 'Open **http://127.0.0.1:8787**' : '打開 **<http://127.0.0.1:8787>**'),
      );
    }
  });

  it('no bare address runs into the Chinese text after it, which GitHub would link along with it', () => {
    const docs = ['README.zh-TW.md', 'CONTRIBUTING.zh-TW.md', ...['architecture', 'developer-guide', 'user-guide', 'remote-access'].map((d) => `docs/${d}.zh-TW.md`)];
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
