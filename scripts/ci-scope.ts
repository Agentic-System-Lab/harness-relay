/**
 * Which of CI's slower jobs a pull request needs. The first job of the CI and End-to-end tests
 * workflows (.github/workflows/ci.yml and e2e.yml) runs this, and the jobs it names run only when it
 * says so:
 *
 *   windows   the tests on Windows (ci.yml, job windows)
 *   desktop   the desktop app packaged and checked, on Linux and Windows (ci.yml, job desktop-package)
 *   e2e       the end-to-end tests on Linux, macOS and Windows (e2e.yml, job e2e)
 *
 * Each job lists what it does not depend on (IGNORES), never what it needs: it runs unless every file
 * the change touches is on its list, so a file or folder no list names runs everything. Everything
 * runs for every other event than a pull request: each push to main (what main is, checked whole
 * after each merge, also where these rules miss a file) and a run by hand (workflow_dispatch). And
 * for a pull request whose change cannot be told: a checkout that is not its merge commit, a change
 * of no files, an error, and a change to this file (ALWAYS).
 *
 * The Linux checks of the CI workflow (typecheck, npm test, the build, the desktop app's typecheck,
 * build and bundled server) are not gated: npm test also reads the docs, the landing page, the issue
 * forms, the dev container and the workflows, so every file is theirs, and they take two minutes.
 *
 * What changed: the merge commit GitHub checks out against its first parent (the base branch it
 * merges into: what main would get). Renames count as a deletion and an addition, so a file moved out
 * of a folder still counts for the jobs that depend on that folder.
 *
 * A pattern is a path from the repository's root: `*` matches within one folder, `**` across folders,
 * and a pattern that starts with `!` takes a file back from the patterns before it. The last pattern
 * a file matches decides.
 *
 * Usage:
 *   node scripts/ci-scope.ts            in GitHub Actions: writes windows=, desktop= and e2e= (true or
 *                                       false) to $GITHUB_OUTPUT, and what runs and why to the summary
 *   node scripts/ci-scope.ts [<base>]   elsewhere: what CI would run for this branch's commits since
 *                                       it left <base> (origin/main by default)
 *
 * Only erasable TypeScript here, and only Node's own modules: the workflows run it with plain `node`,
 * before npm ci.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SCOPES = ['windows', 'desktop', 'e2e'] as const;
export type Scope = (typeof SCOPES)[number];

/** The jobs each scope gates, as the workflows name them. */
export const SCOPE_JOBS: Record<Scope, string> = {
  windows: 'Typecheck, test, build (Windows, Node 24)',
  desktop: 'Package the desktop app and check it',
  e2e: 'End-to-end',
};

/** The docs and the repository's other prose. npm test reads some of them, on Linux; nothing else does. */
const PROSE = [
  '*.md',
  'docs/**',
  '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/**',
  'e2e/README*.md',
  'desktop/README*.md',
  'site/DESIGN-GUIDELINES.md',
];

/** What each scope's jobs never read, build, run or ship. */
export const IGNORES: Record<Scope, readonly string[]> = {
  // Text the tests read the same way on every system (.gitattributes checks out LF everywhere), and
  // code that never runs on Windows: the Linux checks cover them.
  windows: [
    ...PROSE,
    'LICENSE',
    // The landing page, but for the installers' names, which the desktop app's updates import.
    'site/**',
    '!site/assets/downloads.js',
    // The download mirror runs on Cloudflare, the dev container on Linux.
    'mirror/**',
    '.devcontainer/**',
    // The other workflows: the tests only read them.
    '.github/workflows/e2e.yml',
    '.github/workflows/pages.yml',
    '.github/workflows/release.yml',
  ],
  // The packaged app is the server and the UI (src/), the app itself (desktop/), the installers'
  // names (site/assets/downloads.js), the LICENSE it ships, the scripts it imports (release.ts,
  // app-icons.ts) and the fake CLIs its checks start (e2e/fake-cli/, e2e/support/).
  desktop: [
    ...PROSE,
    'test/**',
    'site/**',
    '!site/assets/downloads.js',
    'mirror/**',
    '.devcontainer/**',
    'e2e/specs/**',
    'e2e/live/**',
    'e2e/fixtures.ts',
    'e2e/global-setup.ts',
    'playwright.config.ts',
    'playwright.live.config.ts',
    'vitest.config.ts',
    'scripts/demo/**',
    'scripts/login.ts',
    'scripts/preview-site.ts',
    'scripts/sandbox-check.ts',
    '.github/workflows/e2e.yml',
    '.github/workflows/pages.yml',
    '.github/workflows/release.yml',
  ],
  // The end-to-end tests are the server and the UI (src/), the specs and the fake CLIs (e2e/), and
  // the check of Harness Relay's own sandbox the workflow runs first (scripts/sandbox-check.ts).
  e2e: [
    ...PROSE,
    'LICENSE',
    'test/**',
    'desktop/**',
    'site/**',
    'mirror/**',
    '.devcontainer/**',
    // The live tests never run on CI (npm run test:e2e:live).
    'e2e/live/**',
    'playwright.live.config.ts',
    'vitest.config.ts',
    'scripts/**',
    '!scripts/sandbox-check.ts',
    '.github/workflows/ci.yml',
    '.github/workflows/pages.yml',
    '.github/workflows/release.yml',
  ],
};

/** A change to these runs everything: the rules themselves. */
export const ALWAYS: readonly string[] = ['scripts/ci-scope.ts'];

export interface Need {
  run: boolean;
  /** Why: the files that need it, or why everything runs. */
  reason: string;
}

export type Needs = Record<Scope, Need>;

/** A glob as a regular expression over a whole path: `*` within one folder, `**` across folders. */
export function globRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      re += '(?:[^/]+/)*';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      re += '[^/]*';
    } else {
      re += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether a list of patterns leaves a file out: the last pattern it matches decides. */
export function ignoredBy(patterns: readonly string[], file: string): boolean {
  let ignored = false;
  for (const pattern of patterns) {
    const taken = pattern.startsWith('!');
    if (globRegExp(taken ? pattern.slice(1) : pattern).test(file)) ignored = !taken;
  }
  return ignored;
}

/** Every scope runs, for one reason. */
export function everything(reason: string): Needs {
  return Object.fromEntries(SCOPES.map((s) => [s, { run: true, reason }])) as Needs;
}

const listed = (files: readonly string[]) =>
  files.length === 1 ? `\`${files[0]}\`` : `\`${files[0]}\` and ${files.length - 1} more`;

/** What a change of these files needs. */
export function needsOf(files: readonly string[]): Needs {
  if (files.length === 0) return everything('the change touches no files');
  const rules = files.filter((f) => ALWAYS.includes(f));
  if (rules.length) return everything(`${listed(rules)} decides what runs`);
  return Object.fromEntries(
    SCOPES.map((scope) => {
      const needed = files.filter((f) => !ignoredBy(IGNORES[scope], f));
      return [scope, needed.length ? { run: true, reason: listed(needed) } : { run: false, reason: 'no file it depends on changed' }];
    }),
  ) as Needs;
}

export type Git = (args: string[]) => string;

/**
 * The files a pull request's change touches, or why everything runs. The checkout is GitHub's: the
 * pull request's merge commit, with its parents.
 */
export function changedFiles(event: string, git: Git): string[] | string {
  if (event === 'push') return 'a push to main tests everything';
  if (event !== 'pull_request') return `a ${event || 'local'} run tests everything`;
  const [, ...parents] = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/);
  if (parents.length !== 2) return "the checkout is not the pull request's merge commit";
  return git(['diff', '--name-only', '--no-renames', '-z', parents[0], 'HEAD']).split('\0').filter(Boolean);
}

/** The step's outputs, for $GITHUB_OUTPUT. */
export function outputs(needs: Needs): string {
  return SCOPES.map((s) => `${s}=${needs[s].run}\n`).join('');
}

/** What runs and why, as Markdown for the run's summary. */
export function summary(files: readonly string[], needs: Needs): string {
  const rows = SCOPES.map((s) => `| ${SCOPE_JOBS[s]} | ${needs[s].run ? 'runs' : 'skipped'} | ${needs[s].reason} |`);
  const list = files.length
    ? ['', `<details><summary>${files.length} changed file${files.length === 1 ? '' : 's'}</summary>`, '', ...files.map((f) => `- \`${f}\``), '', '</details>']
    : [];
  return ['### What this change needs', '', '| Jobs | | Why |', '| --- | --- | --- |', ...rows, ...list, ''].join('\n');
}

const run: Git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

function main(args: string[]): number {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  let files: string[] = [];
  let needs: Needs;
  try {
    let changed: string[] | string;
    if (inActions) {
      changed = changedFiles(process.env.GITHUB_EVENT_NAME ?? '', run);
    } else {
      const base = args[0] ?? 'origin/main';
      changed = run(['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`]).split('\0').filter(Boolean);
    }
    if (typeof changed === 'string') needs = everything(changed);
    else {
      files = changed;
      needs = needsOf(files);
    }
  } catch (e) {
    // Never skip a job because the change could not be told.
    const message = e instanceof Error ? e.message.split('\n')[0] : String(e);
    if (inActions) console.log(`::warning::Could not tell what changed, so everything runs: ${message}`);
    needs = everything(`what changed could not be told (${message})`);
  }

  console.log(`${files.length} changed file${files.length === 1 ? '' : 's'}`);
  for (const s of SCOPES) console.log(`${s}: ${needs[s].run ? 'runs' : 'skipped'} (${needs[s].reason.replace(/`/g, '')})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs(needs));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(files, needs));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
