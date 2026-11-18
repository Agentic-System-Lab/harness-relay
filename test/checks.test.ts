import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checksFailed,
  checksHold,
  commitPatternError,
  compilePattern,
  hasTextSet,
  hasChecks,
  isProtected,
  latestChecks,
  overallStatus,
  tidyPattern,
} from '../src/shared/checks';
import { CHECK_LIMITS, CONVENTIONAL_COMMIT_PATTERN, type ChatMessage } from '../src/shared/types';
import {
  RunCheck,
  TooManyFiles,
  diffManifests,
  listPatterns,
  mergeDefaultChecks,
  recheck,
  takeManifest,
  unmatchedSubjects,
  type CheckFolders,
} from '../src/server/checks';
import { branchTips, commitsSince } from '../src/server/workspace';

const matches = (pattern: string, path: string) => compilePattern(pattern)!.regex.test(path);

describe('protected path patterns', () => {
  it('tidies a pattern and refuses one that leaves the working directory', () => {
    expect(tidyPattern('  ./config//prod.yml ')).toBe('config/prod.yml');
    expect(tidyPattern('secrets\\keys\\')).toBe('secrets/keys/');
    for (const bad of ['', '  ', '../x', 'a/../b', 'C:\\x', '//server/share', './', 'a/./b', 'x'.repeat(301)]) {
      expect(tidyPattern(bad), bad).toBeUndefined();
    }
  });

  it('matches a name without a slash at any depth, and everything under what it matches', () => {
    expect(matches('.env', '.env')).toBe(true);
    expect(matches('.env', 'apps/web/.env')).toBe(true);
    expect(matches('.env', '.env.local')).toBe(false);
    expect(matches('*.pem', 'certs/server.pem')).toBe(true);
    expect(matches('*.pem', 'server.pem.bak')).toBe(false);
    expect(matches('secrets', 'secrets/a/b.txt')).toBe(true);
    expect(matches('secrets', 'app/secrets/x')).toBe(true);
  });

  it('anchors a pattern with a slash at the working directory', () => {
    expect(matches('config/prod.yml', 'config/prod.yml')).toBe(true);
    expect(matches('config/prod.yml', 'apps/config/prod.yml')).toBe(false);
    expect(matches('/README.md', 'README.md')).toBe(true);
    expect(matches('/README.md', 'docs/README.md')).toBe(false);
    expect(matches('.github/workflows/', '.github/workflows/ci.yml')).toBe(true);
    expect(matches('db/migrations/*.sql', 'db/migrations/001.sql')).toBe(true);
    expect(matches('db/migrations/*.sql', 'db/migrations/old/001.sql')).toBe(false);
  });

  it('reads ** as any number of folders, ? as one character and [...] as a set', () => {
    expect(matches('src/**/secret.ts', 'src/secret.ts')).toBe(true);
    expect(matches('src/**/secret.ts', 'src/a/b/secret.ts')).toBe(true);
    expect(matches('**/*.key', 'a/b/c.key')).toBe(true);
    expect(matches('infra/**', 'infra/x/y')).toBe(true);
    expect(matches('v?.txt', 'v1.txt')).toBe(true);
    expect(matches('v?.txt', 'v10.txt')).toBe(false);
    expect(matches('[ab].txt', 'b.txt')).toBe(true);
    expect(matches('[!ab].txt', 'c.txt')).toBe(true);
    expect(matches('[!ab].txt', 'a.txt')).toBe(false);
    // Characters a regular expression would read are literal.
    expect(matches('a+b(1).txt', 'a+b(1).txt')).toBe(true);
    expect(matches('a+b(1).txt', 'aab1.txt')).toBe(false);
  });

  it('knows where to look: the folders before the first wildcard, the path itself, or the top', () => {
    expect(compilePattern('secrets/**')!.base).toBe('secrets');
    expect(compilePattern('config/prod.yml')!.base).toBe('config/prod.yml');
    expect(compilePattern('a/b/*/c')!.base).toBe('a/b');
    expect(compilePattern('*.pem')!.base).toBe('');
    expect(compilePattern('**/x')!.base).toBe('');
  });

  it('reads a set a regular expression refuses as the text it is (a Next.js route), never throwing', () => {
    expect(matches('app/api/[user-id]/route.ts', 'app/api/[user-id]/route.ts')).toBe(true);
    expect(matches('app/api/[user-id]/route.ts', 'app/api/u/route.ts')).toBe(false);
    expect(matches('pages/[post-id].tsx', 'pages/[post-id].tsx')).toBe(true);
    expect(hasTextSet('pages/[post-id].tsx')).toBe(true);
    expect(hasTextSet('*.[ch]')).toBe(false);
    expect(hasTextSet('[!a].txt')).toBe(false);
    // As the checks read them, name by name: a `[` whose `]` is in another name, a set starting with `]`.
    expect(hasTextSet('a[b/c]d')).toBe(true);
    expect(hasTextSet('[]x].pem')).toBe(true);
    expect(matches('*.[ch]', 'a.c')).toBe(true);
  });

  it('tells whether a path is protected by any pattern', () => {
    const patterns = listPatterns({ protectedPaths: ['.env', 'secrets/', '../bad'] });
    expect(patterns).toHaveLength(2);
    expect(isProtected('a/.env', patterns)).toBe(true);
    expect(isProtected('secrets/k', patterns)).toBe(true);
    expect(isProtected('src/app.ts', patterns)).toBe(false);
  });
});

describe('check list and results', () => {
  it('has checks only with a rule in it', () => {
    expect(hasChecks(undefined)).toBe(false);
    expect(hasChecks({})).toBe(false);
    expect(hasChecks({ protectedPaths: [] })).toBe(false);
    expect(hasChecks({ protectedPaths: ['.env'] })).toBe(true);
    expect(hasChecks({ commitPattern: '^feat' })).toBe(true);
  });

  it('tells why a commit pattern cannot be read', () => {
    expect(commitPatternError(CONVENTIONAL_COMMIT_PATTERN)).toBeUndefined();
    expect(commitPatternError('(')).toBeTruthy();
  });

  it('puts the rules together: a failure first, then one that could not be checked, never a pass for it', () => {
    expect(overallStatus([])).toBe('na');
    expect(overallStatus([{ status: 'na' }, { status: 'passed' }])).toBe('passed');
    expect(overallStatus([{ status: 'passed' }, { status: 'error' }])).toBe('error');
    expect(overallStatus([{ status: 'error' }, { status: 'failed' }])).toBe('failed');
    expect(overallStatus([{ status: 'failed' }, { status: 'running' }])).toBe('running');
    expect(checksFailed({ status: 'error' })).toBe(true);
    expect(checksFailed({ status: 'na' })).toBe(false);
  });

  it('holds what waits while the latest result did not pass and was not skipped', () => {
    const msg = (id: string, checks?: ChatMessage['checks']): ChatMessage => ({
      id,
      author: { kind: 'system' },
      createdAt: 0,
      parts: [],
      status: 'done',
      ...(checks ? { checks } : {}),
    });
    const failed = {
      status: 'failed' as const,
      when: 'run' as const,
      outcomes: [{ rule: 'paths' as const, status: 'failed' as const }],
      checkedAt: 1,
    };
    const passed = { ...failed, status: 'passed' as const };
    expect(checksHold([msg('a')])).toBeUndefined();
    expect(checksHold([msg('a', failed), msg('b')])?.id).toBe('a');
    expect(checksHold([msg('a', failed), msg('b', passed)])).toBeUndefined();
    expect(checksHold([msg('a', { ...failed, skippedAt: 5 })])).toBeUndefined();
    expect(checksHold([msg('a', { ...failed, status: 'error' })])?.id).toBe('a');
    // A result left only with commands that were stopped or cannot run here holds nothing.
    const stopped = {
      ...failed,
      status: 'error' as const,
      outcomes: [{ rule: 'command' as const, status: 'error' as const, notRun: 'stopped' as const }],
    };
    expect(checksHold([msg('a', stopped)])).toBeUndefined();
    const both = { ...stopped, outcomes: [...stopped.outcomes, { rule: 'paths' as const, status: 'failed' as const }] };
    expect(checksHold([msg('a', both)])?.id).toBe('a');
    expect(latestChecks([msg('a', failed), msg('b', passed), msg('c')])?.id).toBe('b');
  });
});

describe('subjects and the commit pattern', () => {
  it('finds the subjects it does not match', () => {
    const { unmatched, slow } = unmatchedSubjects(CONVENTIONAL_COMMIT_PATTERN, ['feat: add x', 'Add y', 'fix(api)!: z', 'chore:']);
    expect(unmatched).toEqual([1, 3]);
    expect(slow).toBe(false);
  });

  it('stops a pattern that backtracks without end, and says so', () => {
    const started = Date.now();
    const { slow } = unmatchedSubjects('^(a+)+$', ['a'.repeat(40) + '!']);
    expect(slow).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

let dir: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd: string, file: string, subject: string) => {
  writeFileSync(join(cwd, file), `${subject}\n`);
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', subject);
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-checks-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('takeManifest', () => {
  it('finds protected files on disk, ignored ones too, but not in .git or installed folders', async () => {
    mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    writeFileSync(join(dir, '.env'), 'A=1\n');
    writeFileSync(join(dir, 'apps', 'web', '.env'), 'B=2\n');
    writeFileSync(join(dir, 'node_modules', 'pkg', '.env'), 'C=3\n');
    writeFileSync(join(dir, '.git', '.env'), 'D=4\n');
    const m = await takeManifest(dir, listPatterns({ protectedPaths: ['.env'] }));
    expect(Object.keys(m).sort()).toEqual(['.env', 'apps/web/.env']);
    expect(m['.env']).toMatchObject({ kind: 'file', size: 4 });
    expect(m['.env']!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('looks only in the folder an anchored pattern names, and leaves out the CLIs’ homes', async () => {
    mkdirSync(join(dir, 'secrets', 'deep'), { recursive: true });
    mkdirSync(join(dir, 'home', 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'secrets', 'deep', 'k'), 'k');
    writeFileSync(join(dir, 'home', 'secrets', 'k'), 'k');
    expect(Object.keys(await takeManifest(dir, listPatterns({ protectedPaths: ['secrets/**'] })))).toEqual(['secrets/deep/k']);
    expect(Object.keys(await takeManifest(dir, listPatterns({ protectedPaths: ['secrets'] }), { exclude: [join(dir, 'home')] }))).toEqual([
      'secrets/deep/k',
    ]);
  });

  it('gives up past its limit, rather than reading a whole disk', async () => {
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}`), '');
    await expect(takeManifest(dir, listPatterns({ protectedPaths: ['*.pem'] }), { maxEntries: 10 })).rejects.toThrow(TooManyFiles);
  });

  it('sees a change of content even when size and time are kept, and keeps a hash it need not read again', async () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'A=1\n');
    const patterns = listPatterns({ protectedPaths: ['.env'] });
    const before = await takeManifest(dir, patterns);
    const again = await takeManifest(dir, patterns, { previous: before });
    expect(diffManifests(before, again)).toEqual([]);
    const { mtimeMs } = before['.env']!;
    writeFileSync(file, 'A=2\n');
    utimesSync(file, mtimeMs! / 1000, mtimeMs! / 1000);
    const after = await takeManifest(dir, patterns);
    expect(diffManifests(before, after)).toEqual([{ path: '.env', change: 'changed' }]);
  });

  it.skipIf(process.platform === 'win32')('follows a link to its file, and sees a file written through another link', async () => {
    mkdirSync(join(dir, 'real'));
    writeFileSync(join(dir, 'real', 'key.pem'), 'one');
    symlinkSync(join(dir, 'real'), join(dir, 'alias'));
    symlinkSync(join(dir, 'real', 'key.pem'), join(dir, 'current.pem'));
    const patterns = listPatterns({ protectedPaths: ['*.pem'] });
    const before = await takeManifest(dir, patterns);
    // The folder link is not followed: the file is found once, where it is.
    expect(Object.keys(before).sort()).toEqual(['current.pem', 'real/key.pem']);
    writeFileSync(join(dir, 'alias', 'key.pem'), 'two');
    const after = await takeManifest(dir, patterns);
    expect(diffManifests(before, after)).toEqual([
      { path: 'current.pem', change: 'changed' },
      { path: 'real/key.pem', change: 'changed' },
    ]);
  });

  it('tells added, changed and removed files apart', () => {
    const f = (hash: string) => ({ kind: 'file' as const, size: 1, mtimeMs: 1, ino: 1, hash });
    expect(diffManifests({ a: f('1'), b: f('1') }, { b: f('2'), c: f('1') })).toEqual([
      { path: 'a', change: 'removed' },
      { path: 'b', change: 'changed' },
      { path: 'c', change: 'added' },
    ]);
  });
});

describe('commits the team made', () => {
  it('lists the commits on any branch since the tips, newest first, merges and Harness Relay’s branches left out', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'a', 'feat: one');
    const before = await branchTips(dir);
    const since = Date.now() - 60_000;
    commit(dir, 'b', 'Add two');
    git(dir, 'checkout', '-q', '-b', 'side');
    commit(dir, 'c', 'fix: three');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'branch', 'relay/x/y', 'side');
    git(dir, 'checkout', '-q', '-b', 'relay/a/b');
    commit(dir, 'd', '@A (Harness Relay)');
    git(dir, 'checkout', '-q', 'main');
    const { commits, more } = await commitsSince(dir, before, since, 10);
    expect(commits.map((c) => c.subject).sort()).toEqual(['Add two', 'fix: three']);
    expect(more).toBe(false);
    expect((await commitsSince(dir, before, since, 1)).more).toBe(true);
  });

  it('leaves out commits older than the run that a branch switch brings', async () => {
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'a', 'one');
    git(dir, 'checkout', '-q', '-b', 'old');
    commit(dir, 'b', 'old work');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'branch', '-D', '-q', 'old');
    const before = await branchTips(dir);
    // The old branch comes back (fetched, say): its commit is older than the run.
    expect((await commitsSince(dir, before, Date.now() + 60_000, 10)).commits).toEqual([]);
  });

  it('has no tips in a repository without a commit', async () => {
    git(dir, 'init', '-q');
    expect(await branchTips(dir)).toEqual([]);
    expect((await commitsSince(dir, [], 0, 10)).commits).toEqual([]);
  });
});

describe('RunCheck', () => {
  const where = (commits = true): CheckFolders => ({ folders: [{ cwd: dir, root: dir }], exclude: [], commits });

  beforeEach(() => {
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    writeFileSync(join(dir, '.env'), 'A=1\n');
    commit(dir, 'README.md', 'chore: start');
  });

  it('puts each change down to the turn it happened in, and reports what the run changed', async () => {
    const check = (await RunCheck.start(
      { protectedPaths: ['.env'], commitPattern: CONVENTIONAL_COMMIT_PATTERN },
      where(),
      Date.now() - 1000,
    ))!;
    writeFileSync(join(dir, '.env'), 'A=2\n');
    await check.checkpoint('Builder');
    commit(dir, 'x', 'Add x');
    commit(dir, 'y', 'feat: y');
    await check.checkpoint('Reviewer');
    const { outcomes, touched } = await check.finish();
    expect(touched).toBe(true);
    expect(outcomes).toEqual([
      { rule: 'paths', status: 'failed', findings: [{ path: '.env', change: 'changed', by: 'Builder' }] },
      { rule: 'commits', status: 'failed', findings: [expect.objectContaining({ subject: 'Add x', by: 'Reviewer' })] },
    ]);
  });

  it('passes what was put back, with nothing to check where nothing was made', async () => {
    const check = (await RunCheck.start({ protectedPaths: ['.env'], commitPattern: '^feat' }, where(), Date.now() - 1000))!;
    writeFileSync(join(dir, '.env'), 'A=2\n');
    await check.checkpoint('Builder');
    writeFileSync(join(dir, '.env'), 'A=1\n');
    await check.checkpoint('Reviewer');
    const { outcomes, touched } = await check.finish();
    // It changed during the run, and is as it was.
    expect(touched).toBe(true);
    expect(outcomes.map((o) => o.status)).toEqual(['passed', 'na']);
    const quiet = (await RunCheck.start({ protectedPaths: ['.env'] }, where(), Date.now()))!;
    await quiet.checkpoint('Builder');
    expect((await quiet.finish()).touched).toBe(false);
  });

  it('checks no commit format in parallel mode, and finds a protected file in a member’s worktree', async () => {
    const check = (await RunCheck.start({ protectedPaths: ['.env', 'secrets/'], commitPattern: '^feat' }, where(false), Date.now()))!;
    const { outcomes } = await check.finish([
      { cwd: dir, path: 'secrets/k', change: 'added', by: 'Coder' },
      { cwd: dir, path: 'src/app.ts', change: 'changed', by: 'Coder' },
    ]);
    expect(outcomes[0]).toEqual({
      rule: 'paths',
      status: 'failed',
      findings: [{ path: 'secrets/k', change: 'added', worktree: true, by: 'Coder' }],
    });
    expect(outcomes[1]).toMatchObject({ rule: 'commits', status: 'na' });
  });

  it('cannot check a folder it could not look at, which is never a pass', async () => {
    const check = (await RunCheck.start(
      { protectedPaths: ['.env'] },
      { folders: [{ cwd: join(dir, 'gone'), root: dir }], exclude: [], commits: true },
      Date.now(),
    ))!;
    // A folder that is not there has no protected files: it is looked at, and found empty.
    expect((await check.finish()).outcomes[0]!.status).toBe('passed');
    const tooMany = (await RunCheck.start({ protectedPaths: ['*.pem'] }, where(), Date.now()))!;
    tooMany.baseline.folders[0] = { cwd: dir, error: 'too many files' };
    expect((await tooMany.finish()).outcomes[0]).toMatchObject({ status: 'error', reason: 'too many files' });
  });

  it('checks a result again from where its run started, as things are now', async () => {
    const list = { protectedPaths: ['.env'] };
    const check = (await RunCheck.start(list, where(), Date.now()))!;
    writeFileSync(join(dir, '.env'), 'A=2\n');
    await check.checkpoint('Builder');
    expect((await check.finish()).outcomes[0]!.status).toBe('failed');
    const stored = JSON.parse(JSON.stringify(check.baseline));
    writeFileSync(join(dir, '.env'), 'A=1\n');
    expect((await recheck(list, where(), stored))[0]!.status).toBe('passed');
    expect((await recheck({ protectedPaths: ['.env', '*.pem'] }, where(), stored))[0]).toMatchObject({ status: 'error' });
  });

  it('starts nothing without a rule or a folder to write in', async () => {
    expect(await RunCheck.start({}, where(), 0)).toBeUndefined();
    expect(await RunCheck.start({ protectedPaths: ['.env'] }, { folders: [], exclude: [], commits: true }, 0)).toBeUndefined();
  });
});

describe("a template's rules with Settings' default", () => {
  const copy = {
    protectedPaths: ['.env', '*.pem'],
    commitPattern: '^feat',
    commands: [
      { id: 'test', run: 'npm test' },
      { id: 'lint', run: 'npm run lint', cwd: 'web' },
    ],
    fromDefault: true as const,
  };

  it('takes in both lists: the default’s first, paths and commands each once, the template’s commit format, no mark', () => {
    const merged = mergeDefaultChecks(copy, {
      protectedPaths: ['secrets/', '.env'],
      commitPattern: '^fix',
      commands: [
        { id: 'test', run: 'npm test', timeoutMin: 20 },
        { id: 'lint', run: 'npm run lint' },
      ],
    });
    expect(merged.protectedPaths).toEqual(['.env', '*.pem', 'secrets/']);
    expect(merged.commitPattern).toBe('^fix');
    // `npm test` once, with the template's time limit; `npm run lint` twice (other folders), each with an id of its own.
    expect(merged.commands!.map((c) => [c.run, c.cwd ?? '', c.timeoutMin ?? 0])).toEqual([
      ['npm test', '', 20],
      ['npm run lint', 'web', 0],
      ['npm run lint', '', 0],
    ]);
    expect(new Set(merged.commands!.map((c) => c.id)).size).toBe(3);
    expect(merged.fromDefault).toBeUndefined();
  });

  it('opens the sandbox for a command both have only where both open it', () => {
    const merged = mergeDefaultChecks(
      { commands: [{ id: 'a', run: 'npm test', unixSockets: true }], fromDefault: true },
      { commands: [{ id: 'b', run: 'npm test', localPorts: true, unixSockets: true }] },
    );
    expect(merged.commands).toEqual([{ id: 'a', run: 'npm test', unixSockets: true }]);
  });

  it('keeps the default’s commit format when the template has none, and the mark when the template adds nothing', () => {
    const merged = mergeDefaultChecks(copy, { protectedPaths: ['*.pem'], commands: [{ id: 'x', run: 'npm test' }] });
    expect(merged.commitPattern).toBe('^feat');
    expect(merged.fromDefault).toBe(true);
    expect(mergeDefaultChecks(copy, { protectedPaths: ['secrets/'] }).fromDefault).toBeUndefined();
  });

  it('stays within the list’s limits, all of the default’s rules kept first; at the limit nothing is the default’s alone', () => {
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const merged = mergeDefaultChecks(
      { protectedPaths: many(40, 'd'), commands: many(8, 'd').map((run) => ({ id: run, run })), fromDefault: true },
      { protectedPaths: many(20, 't'), commands: many(5, 't').map((run) => ({ id: run, run })) },
    );
    expect(merged.protectedPaths).toHaveLength(CHECK_LIMITS.protectedPaths);
    expect(merged.protectedPaths!.slice(0, 40)).toEqual(many(40, 'd'));
    expect(merged.commands).toHaveLength(CHECK_LIMITS.commands);
    expect(merged.commands!.slice(0, 8).map((c) => c.run)).toEqual(many(8, 'd'));
    // A full default that a template adds to: the template's rule does not fit, so nothing was added.
    const full = { protectedPaths: many(CHECK_LIMITS.protectedPaths, 'd'), fromDefault: true as const };
    expect(mergeDefaultChecks(full, { protectedPaths: ['t'] })).toEqual(full);
  });
});
