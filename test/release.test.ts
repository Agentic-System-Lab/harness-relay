import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkRelease,
  compareSemver,
  devVersion,
  nextVersion,
  parseVersion,
  RELEASE_TIME_ZONE,
  semverOf,
  actionsData,
  tagsFromLsRemote,
  todayIn,
  validDay,
  type ReleaseVersion,
} from '../scripts/release';

const dir = mkdtempSync(join(tmpdir(), 'relay-release-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ok = (v: string) => {
  const p = parseVersion(v);
  if (!p.ok) throw new Error(`${v}: ${p.error}`);
  return p.value;
};
const error = (v: string) => {
  const p = parseVersion(v);
  if (p.ok) throw new Error(`${v} was accepted`);
  return p.error;
};

describe('the version rules', () => {
  it('accepts a release, a release candidate and their patches', () => {
    expect(ok('2026-11-10')).toEqual({ version: '2026-11-10', date: '2026-11-10', patch: 0, rc: false, rcPatch: 0 });
    expect(ok('2026-11-10.1')).toEqual({ version: '2026-11-10.1', date: '2026-11-10', patch: 1, rc: false, rcPatch: 0 });
    expect(ok('2026-11-10.12')).toMatchObject({ patch: 12 });
    expect(ok('2026-11-10-rc')).toEqual({ version: '2026-11-10-rc', date: '2026-11-10', patch: 0, rc: true, rcPatch: 0 });
    expect(ok('2026-11-10-rc.3')).toEqual({ version: '2026-11-10-rc.3', date: '2026-11-10', patch: 0, rc: true, rcPatch: 3 });
  });

  it("accepts a release candidate of a patch, and the candidate's own patches", () => {
    expect(ok('2026-11-10.1-rc')).toEqual({ version: '2026-11-10.1-rc', date: '2026-11-10', patch: 1, rc: true, rcPatch: 0 });
    expect(ok('2026-11-10.1-rc.2')).toEqual({ version: '2026-11-10.1-rc.2', date: '2026-11-10', patch: 1, rc: true, rcPatch: 2 });
    expect(ok('2026-11-10.12-rc.10')).toMatchObject({ patch: 12, rcPatch: 10 });
  });

  it('forgives spaces around it (a paste), not inside it', () => {
    expect(ok('  2026-11-10-rc\n')).toMatchObject({ version: '2026-11-10-rc' });
    expect(error('2026-11-10 -rc')).toMatch(/spaces/);
    expect(error('2026 11 10')).toMatch(/spaces/);
  });

  it('says what is wrong with the usual mistakes', () => {
    expect(error('')).toMatch(/No version given/);
    expect(error('   ')).toMatch(/No version given/);
    expect(error('v2026-11-10')).toMatch(/Drop the "v".*2026-11-10/);
    expect(error('V2026-11-10-rc')).toMatch(/Drop the "V"/);
    expect(error('2026-11-10-RC')).toMatch(/lower case: 2026-11-10-rc/);
    expect(error('2026-11-10-Rc.1')).toMatch(/lower case/);
    expect(error('2026-11-10.1-RC')).toMatch(/lower case: 2026-11-10\.1-rc/);
    expect(error('2026-11-10-rc1')).toMatch(/dot between "-rc" and the patch number/);
    expect(error('2026-11-10-rc-1')).toMatch(/dot between/);
    expect(error('2026-11-10.1-rc1')).toMatch(/dot between/);
    expect(error('2026-11-10.0')).toMatch(/Patches start at \.1/);
    expect(error('2026-11-10.0-rc')).toMatch(/Patches start at \.1: the release itself/);
    expect(error('2026-11-10-rc.0')).toMatch(/Patches start at \.1: the release candidate/);
    expect(error('2026-11-10.1-rc.0')).toMatch(/Patches start at \.1: the release candidate/);
    expect(error('2026-11-10.01')).toMatch(/without leading zeros: \.1, not \.01/);
    expect(error('2026-11-10.01-rc')).toMatch(/without leading zeros: \.1, not \.01/);
    expect(error('2026-11-10.1-rc.02')).toMatch(/without leading zeros: \.2, not \.02/);
    expect(error('2026-1-5')).toMatch(/two digits/);
    expect(error('2026-11-5-rc')).toMatch(/two digits/);
    expect(error('2026-11-5.1-rc.2')).toMatch(/two digits/);
  });

  it('refuses look-alike characters that would make a different tag', () => {
    expect(error('2026–11–10')).toMatch(/not plain ASCII/); // en dashes
    expect(error('2026—11—10')).toMatch(/not plain ASCII/); // em dashes
    expect(error('２０２６-11-10')).toMatch(/not plain ASCII/); // full-width digits
    expect(error('2026-11-10‑rc')).toMatch(/not plain ASCII/); // non-breaking hyphen
  });

  it('refuses days that are not in the calendar', () => {
    expect(error('2026-02-29')).toMatch(/not a day of the calendar/);
    expect(ok('2028-02-29')).toMatchObject({ date: '2028-02-29' }); // a leap year
    expect(error('2026-02-30')).toMatch(/not a day/);
    expect(error('2026-13-01')).toMatch(/not a day/);
    expect(error('2026-00-10')).toMatch(/not a day/);
    expect(error('2026-04-31')).toMatch(/not a day/);
    expect(error('2026-11-00')).toMatch(/not a day/);
  });

  it('refuses anything else', () => {
    for (const v of ['26-11-10', '2026/11/10', '20261110', '2026-11-10-beta', '2026-11-10-rc.', '2026-11-10.', '2026-11-10.1.2', '2026-11-10-rc.1.1', '2026-11-10.1-rc.1.1', '2026-11-10-rc.1-rc', '2026-11-10-rc-rc', '2026-11-10.1-rc.', '2026-11-10rc', 'latest', '2026-11-10-rc.a']) {
      expect(parseVersion(v).ok, v).toBe(false);
    }
  });
});

describe('today', () => {
  it('is the day in Taiwan, which can differ from the day in UTC', () => {
    expect(RELEASE_TIME_ZONE).toBe('Asia/Taipei');
    // 2026-11-10 16:30 UTC is already 00:30 on November 11 in Taipei (UTC+8).
    const now = new Date('2026-11-10T16:30:00Z');
    expect(todayIn('Asia/Taipei', now)).toBe('2026-11-11');
    expect(todayIn('UTC', now)).toBe('2026-11-10');
    expect(todayIn('Asia/Taipei', new Date('2026-11-10T15:59:59Z'))).toBe('2026-11-10');
    expect(todayIn('Asia/Taipei', new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01');
  });
});

describe('checking a release', () => {
  const today = '2026-11-10';
  const check = (version: string, tags: string[] = [], extra: { ref?: string; today?: string } = {}) => checkRelease({ version, today, tags, ...extra });
  const errors = (version: string, tags: string[] = [], extra: { ref?: string; today?: string } = {}) => {
    const r = check(version, tags, extra);
    if (r.ok) throw new Error(`${version} was accepted`);
    return r.errors.join('\n');
  };

  it("accepts today's first release candidate, as a pre-release", () => {
    expect(check('2026-11-10-rc')).toEqual({
      ok: true,
      release: { version: '2026-11-10-rc', date: '2026-11-10', patch: 0, rc: true, rcPatch: 0 },
      tag: '2026-11-10-rc',
      title: 'Harness Relay 2026-11-10-rc',
      prerelease: true,
      semver: '2026.1110.0-rc',
    });
  });

  it("accepts today's release, not as a pre-release", () => {
    expect(check('2026-11-10')).toMatchObject({ ok: true, tag: '2026-11-10', prerelease: false, semver: '2026.1110.0' });
  });

  it('refuses another day than today, and says which versions today takes', () => {
    expect(errors('2026-11-09-rc')).toMatch(/2026-11-09 is not today: today is 2026-11-10 \(Asia\/Taipei\)/);
    expect(errors('2026-11-11-rc')).toMatch(/is not today/);
    expect(errors('2025-11-10')).toMatch(/is not today/);
    expect(errors('2026-11-09-rc', ['2026-11-10-rc'])).toMatch(/next release candidate is 2026-11-10-rc\.1, and its next release 2026-11-10\./);
  });

  it('refuses a version that breaks the rules, with the reason and the versions today takes', () => {
    const e = errors('v2026-11-10-rc');
    expect(e).toMatch(/Drop the "v"/);
    expect(e).toMatch(/next release candidate is 2026-11-10-rc/);
  });

  it('refuses what has been released already', () => {
    expect(errors('2026-11-10-rc', ['2026-11-10-rc'])).toMatch(/2026-11-10-rc has already been released\. The next one is 2026-11-10-rc\.1/);
    expect(errors('2026-11-10-rc.1', ['2026-11-10-rc', '2026-11-10-rc.1'])).toMatch(/already been released.*rc\.2/);
  });

  it('counts patches up by one, from the release they patch', () => {
    const tags = ['2026-11-10-rc', '2026-11-10-rc.1'];
    expect(check('2026-11-10-rc.2', tags).ok).toBe(true);
    expect(errors('2026-11-10-rc.3', tags)).toMatch(/skips a number: .* the next is 2026-11-10-rc\.2/);
    expect(errors('2026-11-10-rc.1')).toMatch(/is a patch, but there is no release candidate of 2026-11-10 to patch yet: release 2026-11-10-rc first/);
    expect(errors('2026-11-10.1')).toMatch(/no release today to patch yet: release 2026-11-10 first/);
  });

  it('keeps releases and release candidates apart', () => {
    const tags = ['2026-11-10-rc', '2026-11-10-rc.1'];
    expect(check('2026-11-10', tags).ok).toBe(true);
    expect(errors('2026-11-10.1', tags)).toMatch(/release 2026-11-10 first/);
    expect(check('2026-11-10.1', [...tags, '2026-11-10']).ok).toBe(true);
    // A release needs no release candidate first.
    expect(check('2026-11-10.2', [...tags, '2026-11-10', '2026-11-10.1']).ok).toBe(true);
  });

  it("takes a release candidate of the day's next release only: once a release is out, one of its next patch", () => {
    const tags = ['2026-11-10-rc', '2026-11-10-rc.1', '2026-11-10', '2026-11-10.1'];
    expect(check('2026-11-10.2-rc', tags)).toMatchObject({ ok: true, tag: '2026-11-10.2-rc', prerelease: true, semver: '2026.1110.2-rc' });
    expect(nextVersion(tags, '2026-11-10', true)).toBe('2026-11-10.2-rc');
    // Its own patches count up as the day's release candidate's do, and the patch it comes before follows.
    const more = [...tags, '2026-11-10.2-rc', '2026-11-10.2-rc.1'];
    expect(check('2026-11-10.2-rc.2', more)).toMatchObject({ ok: true, semver: '2026.1110.2-rc.2' });
    expect(errors('2026-11-10.2-rc.3', more)).toMatch(/skips a number: .* the next is 2026-11-10\.2-rc\.2/);
    expect(errors('2026-11-10.2-rc.1', tags)).toMatch(/is a patch, but there is no release candidate of 2026-11-10\.2 to patch yet: release 2026-11-10\.2-rc first/);
    expect(check('2026-11-10.2', more).ok).toBe(true);
    // A release candidate of a release that is out would sort before it, and before the newest release.
    expect(errors('2026-11-10-rc.2', tags)).toMatch(
      /2026-11-10-rc\.2 is a release candidate of 2026-11-10, which is out already: today's next release candidate is 2026-11-10\.2-rc, and its next release 2026-11-10\.2\./,
    );
    expect(errors('2026-11-10.1-rc', tags)).toMatch(/release candidate of 2026-11-10\.1, which is out already/);
    expect(errors('2026-11-10-rc', ['2026-11-10'])).toMatch(/is out already: today's next release candidate is 2026-11-10\.1-rc/);
    // Nor one of a later patch than the next.
    expect(errors('2026-11-10.3-rc', tags)).toMatch(/release candidate of 2026-11-10\.3, but today's next release is 2026-11-10\.2: its next release candidate is 2026-11-10\.2-rc\./);
    expect(errors('2026-11-10.1-rc', ['2026-11-10-rc'])).toMatch(/today's next release is 2026-11-10: its next release candidate is 2026-11-10-rc\.1\./);
    // Another day's error names today's next ones.
    expect(errors('2026-11-09', tags)).toMatch(/Today's next release candidate is 2026-11-10\.2-rc, and its next release 2026-11-10\.2\./);
  });

  it("ignores other days' versions and tags that are not versions", () => {
    const tags = ['v0.1.0', '2026-11-09-rc', '2026-11-09-rc.1', '2026-11-09', 'nightly', '2026-11-10-rc.x', '2026-02-30'];
    expect(check('2026-11-10-rc', tags).ok).toBe(true);
    expect(nextVersion(tags, '2026-11-09', true)).toBe('2026-11-09.1-rc');
    expect(nextVersion(tags, '2026-11-09', false)).toBe('2026-11-09.1');
    expect(nextVersion(tags.filter((t) => t !== '2026-11-09'), '2026-11-09', true)).toBe('2026-11-09-rc.2');
  });

  it('is made from main only', () => {
    expect(errors('2026-11-10-rc', [], { ref: 'refs/heads/feature/x' })).toMatch(/made from main, and this run is on feature\/x/);
    expect(errors('2026-11-10-rc', [], { ref: 'refs/tags/2026-11-09' })).toMatch(/made from main/);
    expect(check('2026-11-10-rc', [], { ref: 'refs/heads/main' }).ok).toBe(true);
  });

  it('reports every problem at once', () => {
    const r = check('2026-11-09', [], { ref: 'refs/heads/dev' });
    expect(r.ok === false && r.errors).toHaveLength(2);
  });
});

describe('the app version (semver)', () => {
  const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

  it('is valid semver, below Windows’ limit of 65535 per number', () => {
    for (const v of ['2026-01-01', '2026-01-01-rc', '2026-01-01-rc.1', '2026-12-31.9', '2099-12-31-rc.40', '2026-12-31.9-rc', '2099-12-31.40-rc.40']) {
      const s = semverOf(ok(v));
      expect(s, v).toMatch(SEMVER);
      for (const n of s.split('-')[0]!.split('.')) expect(Number(n)).toBeLessThan(65536);
    }
    expect(semverOf(ok('2026-01-05'))).toBe('2026.105.0');
    expect(semverOf(ok('2026-11-10.2'))).toBe('2026.1110.2');
    expect(semverOf(ok('2026-11-10-rc.2'))).toBe('2026.1110.0-rc.2');
    expect(semverOf(ok('2026-11-10.1-rc'))).toBe('2026.1110.1-rc');
    expect(semverOf(ok('2026-11-10.1-rc.2'))).toBe('2026.1110.1-rc.2');
  });

  it('sorts as the releases were made', () => {
    const inOrder = [
      '2026-01-31',
      '2026-02-01-rc',
      '2026-02-01-rc.1',
      '2026-02-01-rc.10',
      '2026-02-01',
      '2026-02-01.1-rc',
      '2026-02-01.1-rc.1',
      '2026-02-01.1',
      '2026-02-01.2',
      '2026-02-01.3-rc',
      '2026-10-09',
      '2026-11-10-rc',
      '2027-01-01-rc',
    ];
    const semvers = inOrder.map((v) => semverOf(ok(v) as ReleaseVersion));
    expect([...semvers].reverse().sort(compareSemver)).toEqual(semvers);
    expect([...semvers].sort(() => 0.5 - Math.random()).sort(compareSemver)).toEqual(semvers);
  });

  it('compares by semver precedence', () => {
    expect(compareSemver('2026.1110.0', '2026.1110.0')).toBe(0);
    expect(compareSemver('2026.1110.0-rc', '2026.1110.0')).toBe(-1);
    expect(compareSemver('2026.1110.0', '2026.1110.0-rc.3')).toBe(1);
    expect(compareSemver('2026.1110.0-rc.2', '2026.1110.0-rc.10')).toBe(-1); // numbers as numbers
    expect(compareSemver('2026.1110.0-rc', '2026.1110.0-rc.1')).toBe(-1); // fewer identifiers first
    expect(compareSemver('2026.1110.0-dev', '2026.1110.0-rc')).toBe(-1);
    expect(compareSemver('2026.1109.3', '2026.1110.0-dev')).toBe(-1);
    expect(compareSemver('0.1.0', '2026.1110.0')).toBe(-1);
    expect(compareSemver('2026.1110.1+build.5', '2026.1110.1')).toBe(0);
  });

  it('marks a build that is not a release as one of the day it was built, before any release of that day', () => {
    expect(devVersion('2026-11-10', '30f3d4f')).toEqual({ shown: '2026-11-10-dev (30f3d4f)', semver: '2026.1110.0-dev' });
    expect(devVersion('2026-11-10')).toEqual({ shown: '2026-11-10-dev', semver: '2026.1110.0-dev' });
    const dev = devVersion('2026-11-10').semver;
    expect(dev).toMatch(SEMVER);
    expect(compareSemver(dev, semverOf(ok('2026-11-10-rc')))).toBe(-1);
    expect(compareSemver(dev, semverOf(ok('2026-11-09.4')))).toBe(1);
    expect(compareSemver(dev, semverOf(ok('2026-11-09.4-rc')))).toBe(1);
  });
});

describe('messages to GitHub Actions', () => {
  it('escape what could start a command of its own', () => {
    expect(actionsData('x\n::notice::injected')).toBe('x%0A::notice::injected');
    expect(actionsData('100%\r\n')).toBe('100%25%0D%0A');
  });

  it('take --today only as a day of the calendar', () => {
    expect(validDay('2026-11-10')).toBe(true);
    for (const day of [undefined, '', '2026-13-45', '2026-02-30', '11/10/2026', '2026-11-10x']) expect(validDay(day), String(day)).toBe(false);
  });
});

describe('tags on the remote', () => {
  it('are read from git ls-remote, once each', () => {
    const out = 'abc\trefs/tags/2026-11-10-rc\ndef\trefs/tags/2026-11-10-rc^{}\n123\trefs/tags/v0.1.0\n';
    expect(tagsFromLsRemote(out)).toEqual(['2026-11-10-rc', 'v0.1.0']);
    expect(tagsFromLsRemote('')).toEqual([]);
  });
});

describe('the release script', () => {
  const script = resolve('scripts/release.ts');
  // tsx from this repository: the script runs in another one, where `--import tsx` would not find it.
  const tsx = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // A repository with an origin, like the workflow's checkout.
  const origin = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  git(dir, 'init', '--bare', '-q', origin);
  git(dir, 'init', '-q', '-b', 'main', repo);
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'start');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');

  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ['--import', tsx, script, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', GITHUB_REF: '', RELEASE_TIME_ZONE: '', ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it("checks a version against today in Taiwan when no day is given", () => {
    const today = todayIn('Asia/Taipei');
    const r = run(['check', `${today}-rc`]);
    // The script finds today by itself: right at midnight in Taiwan, it may be the next day already.
    if (todayIn('Asia/Taipei') !== today) return;
    expect(r.code).toBe(0);
    const yesterday = todayIn('Asia/Taipei', new Date(Date.now() - 36 * 3600_000));
    const late = run(['check', `${yesterday}-rc`]);
    expect(late.code).toBe(1);
    expect(late.err).toContain(`${yesterday} is not today`);
  });

  // The Release workflow runs it with plain `node` (type stripping), not tsx: only erasable TypeScript works there.
  const stripsTypes = Boolean((process.features as { typescript?: unknown }).typescript);
  (stripsTypes ? it : it.skip)('runs with plain node, as the Release workflow runs it', () => {
    const r = spawnSync(process.execPath, [script, 'check', '2026-11-10-rc', '--today', '2026-11-10'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', GITHUB_REF: '', RELEASE_TIME_ZONE: '', NODE_NO_WARNINGS: '1' },
    });
    expect(r.stderr).not.toMatch(/SyntaxError|ERR_/);
    expect(r.stdout).toContain('2026-11-10-rc may be released');
    expect(r.status).toBe(0);
  });

  it('reads the tags of the local repository, or of origin with --remote', () => {
    git(repo, 'tag', '2026-11-10-rc');
    expect(run(['check', '2026-11-10-rc', '--today', '2026-11-10']).err).toContain('already been released');
    // Not on origin yet: a release made from another clone would be missed without --remote.
    expect(run(['check', '2026-11-10-rc', '--today', '2026-11-10', '--remote']).code).toBe(0);
    git(repo, 'push', '-q', 'origin', '2026-11-10-rc');
    expect(run(['check', '2026-11-10-rc', '--today', '2026-11-10', '--remote']).code).toBe(1);
    expect(run(['check', '2026-11-10-rc.1', '--today', '2026-11-10', '--remote']).code).toBe(0);
  });

  it('accepts a release candidate of a patch once the release is out', () => {
    git(repo, 'tag', '2026-11-11');
    const r = run(['check', '2026-11-11.1-rc', '--today', '2026-11-11']);
    expect(r.out).toContain('2026-11-11.1-rc may be released (a release candidate, published as a pre-release; app version 2026.1111.1-rc)');
    expect(r.code).toBe(0);
    git(repo, 'tag', '-d', '2026-11-11');
  });

  it('prints the next versions for today', () => {
    const r = run(['next', '--today', '2026-11-10']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('release candidate  2026-11-10-rc.1');
    expect(r.out).toContain('release            2026-11-10\n');
    // Once the day's release is out, its next patch, and a release candidate of that patch.
    git(repo, 'tag', '2026-11-10');
    const after = run(['next', '--today', '2026-11-10']);
    expect(after.out).toContain('release candidate  2026-11-10.1-rc\n');
    expect(after.out).toContain('release            2026-11-10.1\n');
    git(repo, 'tag', '2026-11-10.1-rc');
    expect(run(['next', '--today', '2026-11-10']).out).toContain('release candidate  2026-11-10.1-rc.1\n');
    git(repo, 'tag', '-d', '2026-11-10', '2026-11-10.1-rc');
  });

  it('in GitHub Actions, writes the outputs, and refuses a branch other than main', () => {
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    const actions = { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output };
    expect(run(['check', '2026-11-12-rc', '--today', '2026-11-12'], { ...actions, GITHUB_REF: 'refs/heads/main' }).code).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(
      'tag=2026-11-12-rc\ntitle=Harness Relay 2026-11-12-rc\nprerelease=true\nsemver=2026.1112.0-rc\ntoday=2026-11-12\n',
    );
    const r = run(['check', '2026-11-12-rc', '--today', '2026-11-12'], { ...actions, GITHUB_REF: 'refs/heads/feature' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('::error title=Release version::Releases are made from main');
    // What was typed in cannot start a command of its own.
    const injected = run(['check', 'x\n::notice::injected', '--today', '2026-11-12'], { ...actions, GITHUB_REF: 'refs/heads/main' });
    expect(injected.err.split('\n').filter((l) => l.startsWith('::notice'))).toEqual([]);
  });

  it('refuses a malformed --today and a missing version', () => {
    expect(run(['check', '2026-11-10-rc', '--today', '11/10/2026']).code).toBe(2);
    expect(run(['check', '2026-11-10-rc', '--today']).code).toBe(2);
    expect(run(['check', '2026-11-10-rc', '--today', '2026-13-45']).code).toBe(2);
    expect(run(['check', '2026-11-10', '--today', '2026-11-10']).code).toBe(0);
    expect(run(['check']).code).toBe(2);
    expect(run(['check', '--remote']).code).toBe(2);
    expect(run(['publish', '2026-11-10']).code).toBe(2);
  });

  it('follows RELEASE_TIME_ZONE', () => {
    const before = todayIn('Pacific/Kiritimati');
    const r = run(['next'], { RELEASE_TIME_ZONE: 'Pacific/Kiritimati' });
    const after = todayIn('Pacific/Kiritimati'); // midnight there may pass while it runs
    expect([`Today (${before}, Pacific/Kiritimati)`, `Today (${after}, Pacific/Kiritimati)`].some((line) => r.out.includes(line))).toBe(true);
  });
});

describe('the release workflow', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const lines = workflow.split('\n');
  /** The shell commands of every step: `run: …` and the indented lines of `run: |`. */
  const runs = (() => {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i]!);
      if (!m) continue;
      if (m[2] !== '|') {
        out.push(m[2]!);
        continue;
      }
      const indent = m[1]!.length;
      for (i++; i < lines.length && (lines[i]!.trim() === '' || lines[i]!.search(/\S/) > indent); i++) out.push(lines[i]!);
      i--;
    }
    return out;
  })();
  /** A top-level key's block. */
  const block = (key: string) => {
    const start = lines.indexOf(`${key}:`);
    expect(start, key).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
    return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trimEnd();
  };
  /** A job's block. */
  const job = (name: string) => {
    const all = block('jobs').split('\n');
    const start = all.indexOf(`  ${name}:`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const end = all.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
    return all.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };

  it('runs only by hand, with a version to fill in', () => {
    const on = block('on');
    expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(on.split('\n').filter((l) => /^ {2}\S/.test(l))).toEqual(['  workflow_dispatch:']);
    expect(on).toMatch(/version:\n\s+description: .*Taiwan/);
    expect(on).toMatch(/required: true/);
  });

  it('never puts what was typed into a command (script injection)', () => {
    for (const line of lines.filter((l) => /inputs\.|github\.event\.inputs/.test(l))) {
      expect(line.trim(), 'the version reaches the scripts through the environment only').toBe('VERSION: ${{ inputs.version }}');
    }
    // Inside commands, only the workflow's own static matrix values are expanded by GitHub.
    for (const cmd of runs) for (const expr of cmd.match(/\$\{\{[^}]*\}\}/g) ?? []) expect(expr).toBe('${{ matrix.target }}');
  });

  it('uses the time zone of the version rules', () => {
    expect(block('env')).toContain(`RELEASE_TIME_ZONE: ${RELEASE_TIME_ZONE}`);
  });

  it('checks the version before anything else, and again just before publishing', () => {
    const check = job('check');
    const steps = check.split('- name: ').map((s) => s.split('\n')[0]);
    expect(steps.indexOf('Check the version')).toBeLessThan(steps.indexOf('Install'));
    expect(check).toContain('run: node scripts/release.ts check "$VERSION" --remote');
    const release = job('release');
    expect(release).toContain('run: node scripts/release.ts check "$VERSION" --remote --today "$TODAY"');
    expect(release.indexOf('Check the version again')).toBeLessThan(release.indexOf('- name: Publish'));
    // The tests run before a release too.
    expect(check).toContain('run: npm test');
    expect(check).toContain('run: npm run typecheck');
  });

  it('builds for macOS, Windows and Linux (x64, and Arm64 on Arm runners), and publishes only when all five are built', () => {
    const build = job('build');
    for (const [os, target] of [
      ['macos-latest', '--mac dmg'],
      ['windows-latest', '--win nsis --x64'],
      ['windows-11-arm', '--win nsis --arm64'],
      ['ubuntu-latest', '--linux AppImage --x64'],
      ['ubuntu-24\\.04-arm', '--linux AppImage --arm64'],
    ]) {
      expect(build).toMatch(new RegExp(`os: ${os}\\n(?:\\s+#.*\\n)*\\s+target: ${target}`));
    }
    expect(build).toMatch(/fail-fast: true/);
    // Macs with Apple Silicon only: no universal app, no Intel half of the keyring module.
    expect(build).toMatch(/target: --mac dmg --arm64/);
    expect(build).not.toMatch(/--universal|keyring-darwin-x64|Intel Macs/);
    // The bundled server is tried on each system before its installer is made.
    expect(build.indexOf('run: npx tsx desktop/scripts/smoke.ts')).toBeGreaterThan(build.indexOf('run: npm --prefix desktop run build'));
    expect(build.indexOf('run: npx tsx desktop/scripts/smoke.ts')).toBeLessThan(build.indexOf('- name: Make the installer'));
    // The packaged app is checked on each system (fuses, keyring module, its own --smoke-test) before it is uploaded.
    const packaged = build.indexOf('run: npx tsx desktop/scripts/check-package.ts');
    expect(packaged).toBeGreaterThan(build.indexOf('- name: Make the installer'));
    expect(packaged).toBeLessThan(build.indexOf('uses: actions/upload-artifact'));
    expect(build).toContain('xvfb-run -a npx tsx desktop/scripts/check-package.ts');
    expect(build).toMatch(/needs: check/);
    expect(job('release')).toMatch(/needs: \[check, build\]/);
    // One installer of each kind goes up, named after the version.
    expect(build).toContain("-c.artifactName='Harness-Relay-${env.RELAY_VERSION}-${os}-${arch}.${ext}'");
    expect(build).toContain('RELAY_VERSION: ${{ needs.check.outputs.tag }}');
    for (const ext of ['dmg', 'exe', 'AppImage']) expect(build).toContain(`desktop/release/Harness-Relay-*.${ext}`);
    // Exactly one installer for each end of name the website and the app's updates look for, and nothing else.
    const release = job('release');
    expect(release).toContain("import { INSTALLERS } from './site/assets/downloads.js'");
    expect(release).toContain('Expected one installer ending in $end');
    expect(release).toContain('found others too');
    // Then each one copied for the app's updates (counted apart from new installs), in a folder of their own.
    expect(release).toContain("import { updateCopyName } from './site/assets/downloads.js'");
    const copied = release.indexOf("- name: Copy the installers for the app's updates");
    expect(copied).toBeGreaterThan(release.indexOf('found others too'));
    expect(release).toContain("if (!copy) throw new Error('Not an installer: ' + name);");
    expect(release).toContain("copyFileSync('installers/' + name, 'updates/' + copy);");
    // The copies are published in their own repository first (no app offered the release before they are
    // there), so that the release itself holds the installers alone.
    const copies = release.indexOf("- name: Publish the copies for the app's updates");
    const published = release.indexOf('- name: Publish\n');
    expect(copies).toBeGreaterThan(copied);
    expect(published).toBeGreaterThan(copies);
    const step = release.slice(copies, published);
    expect(step).toContain("import { UPDATES_REPO } from './site/assets/downloads.js'");
    expect(step).toContain('gh release create "$TAG" updates/* --repo "$repo"');
    // Tried again: the copies uploaded again over the ones there.
    expect(step).toContain('gh release upload "$TAG" updates/* --repo "$repo" --clobber');
    expect(step).toContain('The UPDATES_TOKEN secret is not set');
    expect(release.slice(published)).toContain('gh release create "$TAG" installers/*');
    expect(release.slice(published)).not.toContain('updates/');
  });

  it('hands the token for the copies’ repository to the step that publishes them only', () => {
    expect(workflow.match(/secrets\./g)).toEqual(['secrets.']);
    const release = job('release');
    const copies = release.slice(release.indexOf("- name: Publish the copies for the app's updates"), release.indexOf('- name: Publish\n'));
    expect(copies).toContain('GH_TOKEN: ${{ secrets.UPDATES_TOKEN }}');
  });

  it('may write to the repository only in the job that publishes', () => {
    expect(block('permissions')).toBe('  contents: read');
    expect(workflow.match(/contents: write/g)).toHaveLength(1);
    expect(job('release')).toMatch(/permissions:\n\s+contents: write/);
  });

  it('makes one release at a time, never cancelling one under way', () => {
    expect(block('concurrency')).toBe('  group: release\n  cancel-in-progress: false');
  });

  it('publishes a release candidate as a pre-release, on the commit it built', () => {
    const publish = job('release').slice(job('release').indexOf('- name: Publish'));
    expect(publish).toContain('if [ "$PRERELEASE" = true ]; then');
    expect(publish).toContain('channel=(--prerelease --latest=false)');
    // A release is not offered release candidates: the notes say who is offered which.
    expect(publish).toContain("offered='A Harness Relay that is a release candidate (or a build of your own) offers this one in its menu");
    expect(publish).toContain("offered='A Harness Relay already installed offers this release in its menu");
    // The notes say nothing of the copies, which are not on the release page.
    expect(publish).toContain('$offered See [Desktop app]');
    expect(publish).not.toContain('-update');
    expect(publish).toContain('--target "$GITHUB_SHA"');
    expect(publish).toContain('gh release create "$TAG"');
  });
});
