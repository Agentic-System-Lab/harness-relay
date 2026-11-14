import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALWAYS,
  changedFiles,
  everything,
  globRegExp,
  IGNORES,
  ignoredBy,
  needsOf,
  outputs,
  SCOPE_JOBS,
  SCOPES,
  summary,
  type Git,
  type Scope,
} from '../scripts/ci-scope';

const ROOT = resolve(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** The scopes a change of these files runs. */
const runs = (...files: string[]) => SCOPES.filter((s) => needsOf(files)[s].run);

describe('globRegExp', () => {
  it('matches * within one folder and ** across folders', () => {
    expect(globRegExp('*.md').test('README.md')).toBe(true);
    expect(globRegExp('*.md').test('docs/guide.md')).toBe(false);
    expect(globRegExp('docs/**').test('docs/media/demo-en.mp4')).toBe(true);
    expect(globRegExp('docs/**').test('docs')).toBe(false);
    expect(globRegExp('**/x.ts').test('x.ts')).toBe(true);
    expect(globRegExp('**/x.ts').test('a/b/x.ts')).toBe(true);
    expect(globRegExp('e2e/README*.md').test('e2e/README.zh-TW.md')).toBe(true);
  });

  it('takes every other character as it is', () => {
    expect(globRegExp('site/assets/downloads.js').test('site/assets/downloadsXjs')).toBe(false);
    expect(globRegExp('a+b(c)?.md').test('a+b(c)?.md')).toBe(true);
  });
});

describe('ignoredBy', () => {
  it('lets the last pattern a file matches decide, a ! taking it back', () => {
    const patterns = ['site/**', '!site/assets/downloads.js'];
    expect(ignoredBy(patterns, 'site/index.html')).toBe(true);
    expect(ignoredBy(patterns, 'site/assets/downloads.js')).toBe(false);
    expect(ignoredBy([...patterns, 'site/assets/**'], 'site/assets/downloads.js')).toBe(true);
    expect(ignoredBy(patterns, 'src/web/App.tsx')).toBe(false);
  });
});

describe('needsOf', () => {
  it('skips every gated job for the docs, the landing page and the dev container alone', () => {
    expect(runs('README.md', 'README.zh-TW.md', 'docs/developer-guide.md', 'docs/media/demo-en.mp4')).toEqual([]);
    expect(runs('e2e/README.md', 'desktop/README.zh-TW.md', 'site/DESIGN-GUIDELINES.md', '.github/pull_request_template.md')).toEqual([]);
    expect(runs('site/index.html', 'site/zh-TW/index.html', 'site/assets/site.css')).toEqual([]);
    expect(runs('.devcontainer/setup.sh', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/workflows/pages.yml')).toEqual([]);
  });

  it('runs everything for the app itself, its packages and its config', () => {
    for (const file of ['src/server/app.ts', 'src/web/App.tsx', 'src/shared/types.ts', 'src/web/public/sw.js', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', '.gitattributes']) {
      expect(runs(file), file).toEqual(['windows', 'desktop', 'e2e']);
    }
  });

  it('runs everything for a file or folder no list names', () => {
    expect(runs('tools/new-thing.ts')).toEqual(['windows', 'desktop', 'e2e']);
    expect(runs('README.md', 'src/server/notes.md')).toEqual(['windows', 'desktop', 'e2e']);
  });

  it('runs the unit tests on Windows, not the packaged app or the end-to-end tests, for the tests alone', () => {
    expect(runs('test/store.test.ts', 'test/fixtures/pi/available-models.jsonl', 'vitest.config.ts')).toEqual(['windows']);
    expect(runs('mirror/worker.ts')).toEqual([]);
  });

  it('runs the desktop app, not the end-to-end tests, for the desktop app alone', () => {
    expect(runs('desktop/src/main.ts', 'desktop/package-lock.json')).toEqual(['windows', 'desktop']);
    expect(runs('scripts/release.ts')).toEqual(['windows', 'desktop']);
    expect(runs('scripts/app-icons.ts')).toEqual(['windows', 'desktop']);
    // The installers' names the app's updates import, and the LICENSE it ships.
    expect(runs('site/assets/downloads.js')).toEqual(['windows', 'desktop']);
    expect(runs('LICENSE')).toEqual(['desktop']);
  });

  it('runs the end-to-end tests for the specs, and the packaged app too for the fake CLIs its checks start', () => {
    expect(runs('e2e/specs/chat.spec.ts', 'playwright.config.ts', 'e2e/global-setup.ts')).toEqual(['windows', 'e2e']);
    expect(runs('e2e/fake-cli/agents/claude.cjs')).toEqual(['windows', 'desktop', 'e2e']);
    expect(runs('e2e/support/clis/claude.ts')).toEqual(['windows', 'desktop', 'e2e']);
    // The workflow checks the sandbox before the tests.
    expect(runs('scripts/sandbox-check.ts')).toEqual(['windows', 'e2e']);
    // The live tests never run on CI; the typecheck takes them in.
    expect(runs('e2e/live/ollama.spec.ts', 'playwright.live.config.ts')).toEqual(['windows']);
  });

  it("runs each workflow's own jobs for a change to it", () => {
    expect(runs('.github/workflows/ci.yml')).toEqual(['windows', 'desktop']);
    expect(runs('.github/workflows/e2e.yml')).toEqual(['e2e']);
    expect(runs('.github/workflows/release.yml')).toEqual([]);
  });

  it('runs everything for a change to the rules, or of no files', () => {
    expect(ALWAYS).toEqual(['scripts/ci-scope.ts']);
    expect(runs('scripts/ci-scope.ts', 'README.md')).toEqual(['windows', 'desktop', 'e2e']);
    expect(needsOf(['scripts/ci-scope.ts']).e2e.reason).toBe('`scripts/ci-scope.ts` decides what runs');
    expect(needsOf([])).toEqual(everything('the change touches no files'));
  });

  it('says which files need a job, or that none does', () => {
    const needs = needsOf(['README.md', 'test/a.test.ts', 'test/b.test.ts']);
    expect(needs.windows).toEqual({ run: true, reason: '`test/a.test.ts` and 1 more' });
    expect(needs.e2e).toEqual({ run: false, reason: 'no file it depends on changed' });
    expect(needsOf(['desktop/src/main.ts']).desktop.reason).toBe('`desktop/src/main.ts`');
  });
});

/** A git that answers from a table of commands, and throws for any other. */
const fakeGit = (answers: Record<string, string | Error>): Git & { calls: string[] } => {
  const calls: string[] = [];
  const git = (args: string[]) => {
    const key = args.join(' ');
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`unexpected: git ${key}`);
    return answer;
  };
  return Object.assign(git, { calls });
};

describe('changedFiles', () => {
  const BEFORE = 'b'.repeat(40);
  const diff = (base: string) => `diff --name-only --no-renames -z ${base} HEAD`;

  it("compares a pull request's merge commit with the base it merges into, renames as two files", () => {
    const git = fakeGit({ 'rev-list --parents -n 1 HEAD': 'merge base head\n', [diff('base')]: 'src/old.ts\0docs/new.md\0' });
    expect(changedFiles('pull_request', undefined, git)).toEqual(['src/old.ts', 'docs/new.md']);
  });

  it('tells everything to run when a pull request checkout is not a merge commit', () => {
    const git = fakeGit({ 'rev-list --parents -n 1 HEAD': 'head parent\n' });
    expect(changedFiles('pull_request', undefined, git)).toBe("the checkout is not the pull request's merge commit");
  });

  it('compares a push with the commit before it, fetching that one when the checkout has not got it', () => {
    const have = fakeGit({ [`cat-file -e ${BEFORE}^{commit}`]: '', [diff(BEFORE)]: 'README.md\0' });
    expect(changedFiles('push', BEFORE, have)).toEqual(['README.md']);
    expect(have.calls.some((c) => c.startsWith('fetch'))).toBe(false);

    const fetch = fakeGit({ [`cat-file -e ${BEFORE}^{commit}`]: new Error('missing'), [`fetch --quiet --no-tags --depth=1 origin ${BEFORE}`]: '', [diff(BEFORE)]: 'a\0b\0' });
    expect(changedFiles('push', BEFORE, fetch)).toEqual(['a', 'b']);
  });

  it('tells everything to run for a push it cannot compare', () => {
    expect(changedFiles('push', '0'.repeat(40), fakeGit({}))).toBe('the push starts a branch');
    expect(changedFiles('push', undefined, fakeGit({}))).toBe('the push starts a branch');
    expect(changedFiles('push', BEFORE, fakeGit({}))).toBe(`the commit before the push (${BEFORE.slice(0, 12)}) cannot be fetched`);
  });

  it('tells everything to run for a run by hand or any other event', () => {
    expect(changedFiles('workflow_dispatch', undefined, fakeGit({}))).toBe('a workflow_dispatch run tests everything');
    expect(changedFiles('merge_group', undefined, fakeGit({}))).toBe('a merge_group run tests everything');
  });
});

describe('outputs and summary', () => {
  it('writes true or false for each scope', () => {
    expect(outputs(needsOf(['test/a.test.ts']))).toBe('windows=true\ndesktop=false\ne2e=false\n');
  });

  it('lists each job, whether it runs and why, and the changed files', () => {
    const text = summary(['test/a.test.ts'], needsOf(['test/a.test.ts']));
    expect(text).toContain('| Typecheck, test, build (Windows, Node 24) | runs | `test/a.test.ts` |');
    expect(text).toContain('| End-to-end | skipped | no file it depends on changed |');
    expect(text).toContain('<summary>1 changed file</summary>');
    expect(summary([], everything('a workflow_dispatch run tests everything'))).not.toContain('<details>');
  });
});

// The rules against the repository as it is: a pattern that names nothing has gone stale, and a file
// a gated job imports must never be one it ignores.

/** Every file in the repository but what git ignores here (node_modules, builds, data). */
function repoFiles(): string[] {
  const skip = new Set(['.git', 'node_modules', 'dist', 'data', 'playwright-report', 'test-results', '.claude', '.codex', '.grok']);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || (dir !== ROOT && ['build', 'release'].includes(entry.name) && relative(ROOT, dir) === 'desktop')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push(relative(ROOT, path).split(sep).join('/'));
    }
  };
  walk(ROOT);
  return out;
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** The repository's files these import, directly or not, by relative paths (themselves included). */
function importedBy(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const resolveFrom = (from: string, spec: string): string | undefined => {
    const base = resolve(ROOT, dirname(from), spec);
    const tries = [base, ...['.ts', '.tsx', '.js', '.cjs', '.mjs', '.json'].map((x) => base + x), base.replace(/\.js$/, '.ts'), join(base, 'index.ts')];
    const found = tries.find((p) => existsSync(p) && statSync(p).isFile());
    return found && relative(ROOT, found).split(sep).join('/');
  };
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx|js|cjs|mjs)$/.test(file)) continue;
    for (const [, spec] of read(file).matchAll(IMPORT)) {
      const target = resolveFrom(file, spec);
      if (target && !target.startsWith('node_modules/')) queue.push(target);
    }
  }
  return seen;
}

describe('the rules and the repository', () => {
  const files = repoFiles();

  it('names in each list only patterns that match a file', () => {
    for (const scope of SCOPES) {
      for (const pattern of IGNORES[scope]) {
        const re = globRegExp(pattern.replace(/^!/, ''));
        expect(files.some((f) => re.test(f)), `${scope}: ${pattern}`).toBe(true);
      }
    }
  });

  it('never ignores a file the end-to-end tests or the packaged app import', () => {
    const under = (...dirs: string[]) => files.filter((f) => dirs.some((d) => f.startsWith(d)) && /\.(ts|tsx|cjs|js|mjs)$/.test(f));
    const entries: Partial<Record<Scope, string[]>> = {
      e2e: [...under('e2e/specs/', 'e2e/support/', 'e2e/fake-cli/'), 'e2e/global-setup.ts', 'e2e/fixtures.ts', 'playwright.config.ts', 'vite.config.ts', 'scripts/sandbox-check.ts', 'src/server/index.ts', 'src/web/main.tsx'],
      desktop: [...under('desktop/src/', 'desktop/scripts/'), 'vite.config.ts', 'src/server/index.ts', 'src/web/main.tsx'],
    };
    for (const [scope, list] of Object.entries(entries) as [Scope, string[]][]) {
      for (const entry of list) expect(existsSync(join(ROOT, entry)), entry).toBe(true);
      const imported = [...importedBy(list)];
      // The walk reaches far: the server, the UI and the fakes.
      expect(imported.length, scope).toBeGreaterThan(100);
      expect(imported.filter((f) => ignoredBy(IGNORES[scope], f)), scope).toEqual([]);
    }
  });

  it('gates the jobs the scopes name, and requires every job in one check', () => {
    const workflows = { ci: read('.github/workflows/ci.yml'), e2e: read('.github/workflows/e2e.yml') };
    const gated: Record<Scope, keyof typeof workflows> = { windows: 'ci', desktop: 'ci', e2e: 'e2e' };
    for (const scope of SCOPES) {
      const text = workflows[gated[scope]];
      expect(text, scope).toContain(`      ${scope}: \${{ steps.scope.outputs.${scope} }}`);
      expect(text, scope).toContain(`    if: needs.changes.outputs.${scope} != 'false'`);
      expect(text, scope).toContain(`    name: ${SCOPE_JOBS[scope]}`);
    }
    for (const [name, text] of Object.entries(workflows)) {
      expect(text, name).toContain('run: node scripts/ci-scope.ts');
      // Every job of the workflow, so that a job added later is in the check too.
      const jobs = [...text.slice(text.indexOf('\njobs:\n')).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]).filter((j) => j !== 'passed');
      const needs = text.match(/^ {2}passed:\n(?: {4}.*\n)*? {4}needs: \[([^\]]+)\]/m)?.[1].split(/,\s*/);
      expect(needs, name).toEqual(jobs);
      expect(text, name).toMatch(/^ {2}passed:\n(?: {4}.*\n)*? {4}if: always\(\)$/m);
    }
  });
});
