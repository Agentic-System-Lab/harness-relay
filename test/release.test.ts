import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  candidateCommitWarning,
  candidatesOf,
  changesMarkdown,
  changesOf,
  checkRelease,
  commitsSince,
  compareSemver,
  mapLimit,
  notFoundTarget,
  devVersion,
  hasRelease,
  newContributors,
  nextVersion,
  parseVersion,
  previousVersion,
  pullMergedBy,
  releaseChanges,
  RELEASE_TIME_ZONE,
  repoOfRemote,
  semverOf,
  subjectMarkdown,
  actionsData,
  tagCommitsFromLsRemote,
  tagsFromLsRemote,
  todayIn,
  validDay,
  type ApiCommit,
  type Change,
  type GitHubApi,
  type Pull,
  type PullOf,
  type ReleaseVersion,
} from '../scripts/release';
import { slow } from './timeouts';

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
    for (const v of [
      '26-11-10',
      '2026/11/10',
      '20261110',
      '2026-11-10-beta',
      '2026-11-10-rc.',
      '2026-11-10.',
      '2026-11-10.1.2',
      '2026-11-10-rc.1.1',
      '2026-11-10.1-rc.1.1',
      '2026-11-10-rc.1-rc',
      '2026-11-10-rc-rc',
      '2026-11-10.1-rc.',
      '2026-11-10rc',
      'latest',
      '2026-11-10-rc.a',
    ]) {
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
  type Extra = { ref?: string; today?: string; ownTag?: boolean; unreleased?: string[] };
  const check = (version: string, tags: string[] = [], extra: Extra = {}) => checkRelease({ version, today, tags, ...extra });
  const errors = (version: string, tags: string[] = [], extra: Extra = {}) => {
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
      previous: undefined,
      candidate: undefined,
    });
  });

  it("accepts today's release once a release candidate of it is out, not as a pre-release", () => {
    expect(check('2026-11-10', ['2026-11-10-rc'])).toMatchObject({
      ok: true,
      tag: '2026-11-10',
      prerelease: false,
      semver: '2026.1110.0',
      candidate: '2026-11-10-rc',
    });
  });

  it('refuses a release without a release candidate of it out, and says which to release first', () => {
    expect(errors('2026-11-10')).toBe(
      '2026-11-10 has no release candidate yet: release 2026-11-10-rc first, then 2026-11-10. A release is made only once its newest release candidate is out: the end-to-end tests run for a release candidate only, before it is published.',
    );
    // A patch needs one of its own: the day's release's candidates are not its.
    expect(errors('2026-11-10.1', ['2026-11-10-rc', '2026-11-10'])).toMatch(
      /^2026-11-10\.1 has no release candidate yet: release 2026-11-10\.1-rc first, then 2026-11-10\.1\./,
    );
    expect(check('2026-11-10.1', ['2026-11-10-rc', '2026-11-10', '2026-11-10.1-rc'])).toMatchObject({
      ok: true,
      candidate: '2026-11-10.1-rc',
    });
    // Nor does another day's.
    expect(errors('2026-11-10', ['2026-11-09-rc', '2026-11-09'])).toMatch(
      /^2026-11-10 has no release candidate yet: release 2026-11-10-rc first/,
    );
    // Asked only of the day's next release: a version that breaks the rules gets their own errors alone.
    expect(errors('2026-11-10.2', ['2026-11-10-rc', '2026-11-10'])).not.toMatch(/release candidate yet/);
    expect(errors('2026-11-09', [])).not.toMatch(/release candidate yet/);
    expect(errors('2026-11-10', ['2026-11-10-rc', '2026-11-10'])).toMatch(/^2026-11-10 has already been released\./);
  });

  it('takes its newest release candidate only, once GitHub has a release of it', () => {
    const tags = ['2026-11-10-rc', '2026-11-10-rc.1', '2026-11-10-rc.2'];
    expect(check('2026-11-10', tags)).toMatchObject({ ok: true, candidate: '2026-11-10-rc.2' });
    // A run of rc.2 that failed after it tagged the commit (its end-to-end tests, say): an older one that
    // is out does not stand in for it, as what main is now is rc.2's.
    expect(errors('2026-11-10', tags, { unreleased: ['2026-11-10-rc.2'] })).toBe(
      "2026-11-10's newest release candidate, 2026-11-10-rc.2, has its tag on GitHub without a release (a run that failed or was stopped, its end-to-end tests perhaps). Release 2026-11-10-rc.2 again or 2026-11-10-rc.3, then 2026-11-10. A release is made only once its newest release candidate is out: the end-to-end tests run for a release candidate only, before it is published.",
    );
    expect(errors('2026-11-10', ['2026-11-10-rc'], { unreleased: ['2026-11-10-rc'] })).toMatch(
      /^2026-11-10's newest release candidate, 2026-11-10-rc, has its tag on GitHub without a release .* Release 2026-11-10-rc again or 2026-11-10-rc\.1, then 2026-11-10\./,
    );
    // An older one without a release (a run that failed before the newest passed) changes nothing.
    expect(check('2026-11-10', tags, { unreleased: ['2026-11-10-rc.1'] })).toMatchObject({ ok: true, candidate: '2026-11-10-rc.2' });
    // Nor does a tag that is not one of its candidates.
    expect(check('2026-11-10', ['2026-11-10-rc'], { unreleased: ['2026-11-09-rc'] })).toMatchObject({
      ok: true,
      candidate: '2026-11-10-rc',
    });
    // With the version's own tag the workflow made (--own-tag), the same.
    expect(check('2026-11-10', ['2026-11-10-rc', '2026-11-10'], { ownTag: true })).toMatchObject({ ok: true, candidate: '2026-11-10-rc' });
    expect(errors('2026-11-10', ['2026-11-10'], { ownTag: true })).toMatch(
      /^2026-11-10 has no release candidate yet: release 2026-11-10-rc first/,
    );
  });

  it("lists a release's candidates among the tags, newest first", () => {
    const tags = ['2026-11-10-rc.1', '2026-11-10', '2026-11-10-rc', '2026-11-10.1-rc', '2026-11-09-rc', 'nightly', '2026-11-10-rc.2'];
    expect(candidatesOf(tags, ok('2026-11-10')).map((v) => v.version)).toEqual(['2026-11-10-rc.2', '2026-11-10-rc.1', '2026-11-10-rc']);
    expect(candidatesOf(tags, ok('2026-11-10.1')).map((v) => v.version)).toEqual(['2026-11-10.1-rc']);
    expect(candidatesOf(tags, ok('2026-11-10.2'))).toEqual([]);
  });

  it("warns when a release is made on another commit than its release candidate's tag", () => {
    const at = 'a'.repeat(40);
    const sha = 'b'.repeat(40);
    expect(candidateCommitWarning({ tag: '2026-11-10', candidate: '2026-11-10-rc.1', at, sha, next: '2026-11-10-rc.2' })).toBe(
      "2026-11-10 is made on bbbbbbb, and its release candidate 2026-11-10-rc.1 on aaaaaaa: the end-to-end tests ran on the candidate's commit, not on what came into main since. To have them run on this one, release 2026-11-10-rc.2 first.",
    );
    expect(
      candidateCommitWarning({ tag: '2026-11-10', candidate: '2026-11-10-rc.1', at: sha, sha, next: '2026-11-10-rc.2' }),
    ).toBeUndefined();
    expect(
      candidateCommitWarning({ tag: '2026-11-10', candidate: '2026-11-10-rc.1', at: undefined, sha, next: '2026-11-10-rc.2' }),
    ).toBeUndefined();
  });

  it('refuses another day than today, and says which versions today takes', () => {
    expect(errors('2026-11-09-rc')).toMatch(/2026-11-09 is not today: today is 2026-11-10 \(Asia\/Taipei\)/);
    expect(errors('2026-11-11-rc')).toMatch(/is not today/);
    expect(errors('2025-11-10')).toMatch(/is not today/);
    expect(errors('2026-11-09-rc', ['2026-11-10-rc'])).toMatch(
      /next release candidate is 2026-11-10-rc\.1, and its next release 2026-11-10\./,
    );
  });

  it('refuses a version that breaks the rules, with the reason and the versions today takes', () => {
    const e = errors('v2026-11-10-rc');
    expect(e).toMatch(/Drop the "v"/);
    expect(e).toMatch(/next release candidate is 2026-11-10-rc/);
  });

  it('refuses what has been released already', () => {
    expect(errors('2026-11-10-rc', ['2026-11-10-rc'])).toMatch(
      /2026-11-10-rc has already been released\. The next one is 2026-11-10-rc\.1/,
    );
    expect(errors('2026-11-10-rc.1', ['2026-11-10-rc', '2026-11-10-rc.1'])).toMatch(/already been released.*rc\.2/);
  });

  it('counts patches up by one, from the release they patch', () => {
    const tags = ['2026-11-10-rc', '2026-11-10-rc.1'];
    expect(check('2026-11-10-rc.2', tags).ok).toBe(true);
    expect(errors('2026-11-10-rc.3', tags)).toMatch(/skips a number: .* the next is 2026-11-10-rc\.2/);
    expect(errors('2026-11-10-rc.1')).toMatch(
      /is a patch, but there is no release candidate of 2026-11-10 to patch yet: release 2026-11-10-rc first/,
    );
    expect(errors('2026-11-10.1')).toMatch(/no release today to patch yet: release 2026-11-10 first/);
  });

  it('keeps releases and release candidates apart', () => {
    const tags = ['2026-11-10-rc', '2026-11-10-rc.1'];
    expect(check('2026-11-10', tags).ok).toBe(true);
    expect(errors('2026-11-10.1', tags)).toMatch(/release 2026-11-10 first/);
    expect(check('2026-11-10.1', [...tags, '2026-11-10', '2026-11-10.1-rc']).ok).toBe(true);
    // Each release needs a release candidate of its own first.
    expect(errors('2026-11-10.1', [...tags, '2026-11-10'])).toMatch(/no release candidate yet: release 2026-11-10\.1-rc first/);
    expect(check('2026-11-10.2', [...tags, '2026-11-10', '2026-11-10.1', '2026-11-10.2-rc']).ok).toBe(true);
  });

  it("takes a release candidate of the day's next release only: once a release is out, one of its next patch", () => {
    const tags = ['2026-11-10-rc', '2026-11-10-rc.1', '2026-11-10', '2026-11-10.1'];
    expect(check('2026-11-10.2-rc', tags)).toMatchObject({ ok: true, tag: '2026-11-10.2-rc', prerelease: true, semver: '2026.1110.2-rc' });
    expect(nextVersion(tags, '2026-11-10', true)).toBe('2026-11-10.2-rc');
    // Its own patches count up as the day's release candidate's do, and the patch it comes before follows.
    const more = [...tags, '2026-11-10.2-rc', '2026-11-10.2-rc.1'];
    expect(check('2026-11-10.2-rc.2', more)).toMatchObject({ ok: true, semver: '2026.1110.2-rc.2' });
    expect(errors('2026-11-10.2-rc.3', more)).toMatch(/skips a number: .* the next is 2026-11-10\.2-rc\.2/);
    expect(errors('2026-11-10.2-rc.1', tags)).toMatch(
      /is a patch, but there is no release candidate of 2026-11-10\.2 to patch yet: release 2026-11-10\.2-rc first/,
    );
    expect(check('2026-11-10.2', more).ok).toBe(true);
    // A release candidate of a release that is out would sort before it, and before the newest release.
    expect(errors('2026-11-10-rc.2', tags)).toMatch(
      /2026-11-10-rc\.2 is a release candidate of 2026-11-10, which is out already: today's next release candidate is 2026-11-10\.2-rc, and its next release 2026-11-10\.2\./,
    );
    expect(errors('2026-11-10.1-rc', tags)).toMatch(/release candidate of 2026-11-10\.1, which is out already/);
    expect(errors('2026-11-10-rc', ['2026-11-10'])).toMatch(/is out already: today's next release candidate is 2026-11-10\.1-rc/);
    // Nor one of a later patch than the next.
    expect(errors('2026-11-10.3-rc', tags)).toMatch(
      /release candidate of 2026-11-10\.3, but today's next release is 2026-11-10\.2: its next release candidate is 2026-11-10\.2-rc\./,
    );
    expect(errors('2026-11-10.1-rc', ['2026-11-10-rc'])).toMatch(
      /today's next release is 2026-11-10: its next release candidate is 2026-11-10-rc\.1\./,
    );
    // Another day's error names today's next ones.
    expect(errors('2026-11-09', tags)).toMatch(/Today's next release candidate is 2026-11-10\.2-rc, and its next release 2026-11-10\.2\./);
  });

  it("ignores other days' versions and tags that are not versions", () => {
    const tags = ['v0.1.0', '2026-11-09-rc', '2026-11-09-rc.1', '2026-11-09', 'nightly', '2026-11-10-rc.x', '2026-02-30'];
    expect(check('2026-11-10-rc', tags).ok).toBe(true);
    expect(nextVersion(tags, '2026-11-09', true)).toBe('2026-11-09.1-rc');
    expect(nextVersion(tags, '2026-11-09', false)).toBe('2026-11-09.1');
    expect(
      nextVersion(
        tags.filter((t) => t !== '2026-11-09'),
        '2026-11-09',
        true,
      ),
    ).toBe('2026-11-09-rc.2');
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

  it("takes the version's tag without a release as the Release workflow's own, and no other tag", () => {
    // The tag a run made at its start (that run's, or one's that failed after it): the version is not out.
    expect(check('2026-11-10-rc', ['2026-11-10-rc'], { ownTag: true })).toMatchObject({
      ok: true,
      tag: '2026-11-10-rc',
      previous: undefined,
    });
    expect(check('2026-11-10-rc.1', ['2026-11-10-rc', '2026-11-10-rc.1'], { ownTag: true })).toMatchObject({
      ok: true,
      previous: '2026-11-10-rc',
    });
    // The versions before it still count, and its notes still start at the one before it.
    expect(check('2026-11-10', ['2026-11-09', '2026-11-10-rc', '2026-11-10'], { ownTag: true })).toMatchObject({
      ok: true,
      previous: '2026-11-09',
      candidate: '2026-11-10-rc',
    });
    expect(errors('2026-11-10-rc.2', ['2026-11-10-rc', '2026-11-10-rc.2'], { ownTag: true })).toMatch(
      /skips a number: .* the next is 2026-11-10-rc\.1/,
    );
    expect(errors('2026-11-10-rc', ['2026-11-10', '2026-11-10-rc'], { ownTag: true })).toMatch(/is out already/);
    // Without it, the tag is a release that is out.
    expect(errors('2026-11-10-rc', ['2026-11-10-rc'], { ownTag: false })).toMatch(/has already been released/);
    // A version that breaks the rules takes no tag away.
    expect(errors('v2026-11-10-rc', ['2026-11-10-rc'], { ownTag: true })).toMatch(/next release candidate is 2026-11-10-rc\.1/);
  });

  it('asks GitHub whether a tag has a release, and takes only its Not Found as none', async () => {
    const asked: string[] = [];
    const answer =
      (fail?: string): GitHubApi =>
      (path) => {
        asked.push(path);
        if (fail) throw new Error(`gh api ${path}: ${fail}`);
        return { tag_name: '2026-11-10-rc' };
      };
    expect(await hasRelease(answer(), 'o/r', '2026-11-10-rc')).toBe(true);
    expect(asked).toEqual(['repos/o/r/releases/tags/2026-11-10-rc']);
    expect(await hasRelease(answer('gh: Not Found (HTTP 404)'), 'o/r', '2026-11-10-rc')).toBe(false);
    // A failure of GitHub's is never taken as no release: the tag of a release that is out would be moved.
    await expect(hasRelease(answer('gh: Server Error (HTTP 502)'), 'o/r', '2026-11-10-rc')).rejects.toThrow('HTTP 502');
    await expect(hasRelease(answer('gh: Bad credentials (HTTP 401)'), 'o/r', '2026-11-10-rc')).rejects.toThrow('HTTP 401');
  });
});

describe("where a release's notes start", () => {
  // This repository's own releases, in the order they were made.
  const made = ['2026-11-11-rc', '2026-11-11', '2026-11-11.1-rc', '2026-11-11.1', '2026-11-12-rc', '2026-11-12-rc.1', '2026-11-12'];
  const since = (version: string, tags: readonly string[]) => previousVersion(tags, ok(version));

  it('starts a release at the release before it, past its release candidates', () => {
    expect(since('2026-11-12', made.slice(0, 6))).toBe('2026-11-11.1');
    expect(since('2026-11-11.1', made.slice(0, 3))).toBe('2026-11-11');
    expect(since('2026-11-12.1', made)).toBe('2026-11-12');
    expect(since('2026-11-12.1', [...made, '2026-11-12.1-rc', '2026-11-12.1-rc.1'])).toBe('2026-11-12');
    // Days apart, with release candidates in between that never became a release.
    expect(since('2026-11-14', [...made, '2026-11-13-rc', '2026-11-13-rc.1'])).toBe('2026-11-12');
  });

  it('starts a release candidate at the version before it, release or release candidate', () => {
    expect(since('2026-11-12-rc', made.slice(0, 4))).toBe('2026-11-11.1');
    expect(since('2026-11-12-rc.1', made.slice(0, 5))).toBe('2026-11-12-rc');
    expect(since('2026-11-11.1-rc', made.slice(0, 2))).toBe('2026-11-11');
    expect(since('2026-11-12.1-rc', made)).toBe('2026-11-12');
    expect(since('2026-11-12.1-rc.1', [...made, '2026-11-12.1-rc'])).toBe('2026-11-12.1-rc');
    expect(since('2026-11-14-rc', [...made, '2026-11-13-rc', '2026-11-13-rc.1'])).toBe('2026-11-13-rc.1');
  });

  it('goes by version, not by the order the tags are listed in, and ignores tags that are not versions', () => {
    const shuffled = [
      'v1.0',
      '2026-11-11.1',
      'latest',
      '2026-11-12-rc.1',
      '2026-11-11',
      '2026-11-12-rc',
      '2026-11-11.1-rc',
      '2026-11-11-rc',
    ];
    expect(since('2026-11-12', shuffled)).toBe('2026-11-11.1');
    expect(since('2026-11-12-rc.2', shuffled)).toBe('2026-11-12-rc.1');
    // Patches by number, not as text: .10 comes after .9.
    expect(since('2026-11-12.11', ['2026-11-12.9', '2026-11-12.10', '2026-11-12.10-rc'])).toBe('2026-11-12.10');
    // Never a version after it.
    expect(since('2026-11-12-rc', ['2026-11-11', '2026-11-12', '2026-11-13-rc'])).toBe('2026-11-11');
  });

  it('has none for the first release or release candidate', () => {
    expect(since('2026-11-11-rc', [])).toBeUndefined();
    expect(since('2026-11-11', ['v1.0'])).toBeUndefined();
    // A release with only release candidates before it has no release to start at.
    expect(since('2026-11-11', ['2026-11-11-rc', '2026-11-11-rc.1'])).toBeUndefined();
  });

  it('comes with an accepted version', () => {
    expect(checkRelease({ version: '2026-11-12', today: '2026-11-12', tags: made.slice(0, 6) })).toMatchObject({
      ok: true,
      previous: '2026-11-11.1',
    });
    expect(checkRelease({ version: '2026-11-12-rc.1', today: '2026-11-12', tags: made.slice(0, 5) })).toMatchObject({
      ok: true,
      previous: '2026-11-12-rc',
    });
    expect(checkRelease({ version: '2026-11-11-rc', today: '2026-11-11', tags: [] })).toMatchObject({ ok: true, previous: undefined });
  });
});

describe('the app version (semver)', () => {
  const SEMVER =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

  it('is valid semver, below Windows’ limit of 65535 per number', () => {
    for (const v of [
      '2026-01-01',
      '2026-01-01-rc',
      '2026-01-01-rc.1',
      '2026-12-31.9',
      '2099-12-31-rc.40',
      '2026-12-31.9-rc',
      '2099-12-31.40-rc.40',
    ]) {
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
    for (const day of [undefined, '', '2026-13-45', '2026-02-30', '11/10/2026', '2026-11-10x'])
      expect(validDay(day), String(day)).toBe(false);
  });
});

describe('tags on the remote', () => {
  it("are read with each one's commit: an annotated tag's peeled line, not the tag object", () => {
    const out = [
      `${'1'.repeat(40)}\trefs/tags/2026-11-10-rc`,
      `${'2'.repeat(40)}\trefs/tags/2026-11-10`,
      `${'3'.repeat(40)}\trefs/tags/2026-11-10^{}`,
      `${'4'.repeat(40)}\trefs/tags/2026-11-11^{}`,
      `${'5'.repeat(40)}\trefs/tags/2026-11-11`,
      '',
    ].join('\n');
    expect([...tagCommitsFromLsRemote(out)]).toEqual([
      ['2026-11-10-rc', '1'.repeat(40)],
      ['2026-11-10', '3'.repeat(40)],
      ['2026-11-11', '4'.repeat(40)],
    ]);
    expect(tagsFromLsRemote(out)).toEqual(['2026-11-10-rc', '2026-11-10', '2026-11-11']);
  });

  it('are read from git ls-remote, once each', () => {
    const out = 'abc\trefs/tags/2026-11-10-rc\ndef\trefs/tags/2026-11-10-rc^{}\n123\trefs/tags/v0.1.0\n';
    expect(tagsFromLsRemote(out)).toEqual(['2026-11-10-rc', 'v0.1.0']);
    expect(tagsFromLsRemote('')).toEqual([]);
  });
});

describe("a release's list of changes", () => {
  const repo = 'owner/name';
  const site = 'https://github.com/owner/name';
  const sha = (n: number) => n.toString(16).padStart(40, '0');
  /** A commit as GitHub's API gives it. */
  const commit = (
    n: number,
    message: string,
    o: { parents?: number[]; login?: string | null; name?: string; email?: string } = {},
  ): ApiCommit => ({
    sha: sha(n),
    parents: (o.parents ?? [n - 1]).map((p) => ({ sha: sha(p) })),
    author: o.login === null ? null : { login: o.login ?? 'dev' },
    commit: { message, author: { name: o.name ?? 'Dev', ...(o.email ? { email: o.email } : {}) } },
  });
  const noPulls: PullOf = () => undefined;
  const lines = (changes: Change[]) => changes.map((c) => `${c.title} | ${c.login ?? c.name} | ${c.url.replace(site, '')}`);

  it('lists every commit that came into main, oldest first: a pull request it merged by its number, any other commit by itself', () => {
    const pulls: Record<string, Pull> = {
      [sha(2)]: { number: 25, title: 'Faster tests', author: 'opener' },
      [sha(4)]: { number: 2, title: 'Fix the review findings' },
    };
    const changes = changesOf(
      [
        commit(1, 'Let visitors pick a theme\n'),
        // Squash-merged: GitHub ends the subject with the number.
        commit(2, 'Run the tests faster (#25)\n\n* one\n* two\n'),
        commit(3, 'Say the agents work together\r\n\r\nWhy.\r\n'),
        // Rebased or fast-forwarded: no number in the subject, but GitHub records the pull request's merge commit.
        commit(4, 'Fix the issue #1 review findings\n'),
        // A number in the subject that is not a pull request this commit merged stays in the subject.
        commit(5, 'Back out "Run the tests faster (#25)"\n'),
      ],
      repo,
      (s) => pulls[s],
    );
    expect(lines(changes)).toEqual([
      `Let visitors pick a theme | dev | /commit/${sha(1)}`,
      // By whoever opened the pull request.
      'Run the tests faster | opener | /pull/25',
      `Say the agents work together | dev | /commit/${sha(3)}`,
      'Fix the issue #1 review findings | dev | /pull/2',
      `Back out "Run the tests faster (#25)" | dev | /commit/${sha(5)}`,
    ]);
    // The commit's address goes with its author only: not with a pull request someone else opened.
    const [own, opened] = changesOf(
      [commit(1, 'Mine (#3)\n', { email: 'dev@example.com' }), commit(2, 'Theirs (#4)\n', { email: 'dev@example.com' })],
      repo,
      (s) => (s === sha(1) ? { number: 3, title: 'Mine', author: 'dev' } : { number: 4, title: 'Theirs', author: 'other' }),
    );
    expect([own!.login, own!.email]).toEqual(['dev', 'dev@example.com']);
    expect([opened!.login, opened!.email]).toEqual(['other', undefined]);
  });

  it('lists a pull request merged with a merge commit by its title and its author, and leaves out merges of branches', () => {
    const changes = changesOf(
      [
        commit(10, 'Work on the branch\n', { parents: [1], login: 'contributor' }),
        commit(11, 'Merge main into the-branch\n', { parents: [10, 2], login: 'contributor' }),
        commit(12, 'Merge pull request #7 from contributor/the-branch\n\nKeep the chat where the reader left it\n', {
          parents: [3, 11],
          login: 'maintainer',
        }),
        commit(13, "Merge branch 'main' into worktree-schedules\n", { parents: [12, 4] }),
        // A merge in words of its own says what it brought in.
        commit(14, 'Run Harness Relay as a desktop app\n', { parents: [13, 5] }),
        // A merge GitHub records as a pull request's merge commit, whatever its words.
        commit(15, 'Merge main into feature\n', { parents: [14, 6] }),
      ],
      repo,
      (s) =>
        s === sha(15)
          ? { number: 9, title: 'Several accounts for each CLI ', author: 'opener' }
          : s === sha(12)
            ? { number: 7, title: 'Keep the chat where the reader left it', author: 'contributor' }
            : undefined,
    );
    expect(lines(changes)).toEqual([
      `Work on the branch | contributor | /commit/${sha(10)}`,
      // By whoever opened it, though the maintainer merged it and updated its branch last.
      'Keep the chat where the reader left it | contributor | /pull/7',
      `Run Harness Relay as a desktop app | dev | /commit/${sha(14)}`,
      'Several accounts for each CLI | opener | /pull/9',
    ]);
    // Without GitHub's record of who opened it, the author of the branch it merged.
    const merged = [
      commit(30, 'Work\n', { login: 'contributor' }),
      commit(31, 'Merge pull request #12 from contributor/work\n\nWork\n', { parents: [29, 30], login: 'maintainer' }),
    ];
    expect(lines(changesOf(merged, repo, (s) => (s === sha(31) ? { number: 12, title: 'Work' } : undefined)))[1]).toBe(
      'Work | contributor | /pull/12',
    );
    // GitHub's own words for a pull request merged with a merge commit, if GitHub's record of it is missing.
    expect(lines(changesOf([commit(20, 'Merge pull request #8 from a/b\n', { parents: [1, 2] })], repo, noPulls))).toEqual([
      'Merge pull request #8 from a/b | dev | /pull/8',
    ]);
  });

  it('names an author without a GitHub account by their name in git', () => {
    const changes = changesOf(
      [commit(1, 'Fix it\n', { login: null, name: ' Someone ' }), commit(2, '\n', { login: null, name: '' })],
      repo,
      noPulls,
    );
    expect(changes.map((c) => [c.login, c.name, c.title])).toEqual([
      [undefined, 'Someone', 'Fix it'],
      [undefined, sha(2).slice(0, 7), sha(2).slice(0, 7)],
    ]);
  });

  it("reads every page of GitHub's comparison, and refuses fewer commits than GitHub counts", async () => {
    const all = Array.from({ length: 230 }, (_, i) => commit(i + 1, `Change ${i + 1}\n`));
    const asked: string[] = [];
    const api: GitHubApi = (path) => {
      asked.push(path);
      const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
      return { total_commits: all.length, commits: all.slice((page - 1) * 100, page * 100) };
    };
    expect((await commitsSince(api, repo, '2026-11-12', 'abc')).map((c) => c.sha)).toEqual(all.map((c) => c.sha));
    expect(asked).toEqual([1, 2, 3].map((p) => `repos/owner/name/compare/2026-11-12...abc?per_page=100&page=${p}`));
    const short: GitHubApi = (path) => ({ total_commits: 150, commits: path.endsWith('&page=1') ? all.slice(0, 100) : [] });
    await expect(commitsSince(short, repo, '2026-11-12', 'abc')).rejects.toThrow(
      'GitHub listed 100 of the 150 commits from 2026-11-12 to abc.',
    );
    // Nothing since: the same commit.
    expect(await commitsSince(() => ({ total_commits: 0, commits: [] }), repo, '2026-11-13-rc', '2026-11-13')).toEqual([]);
  });

  it('without a version before it, lists the whole history, oldest first', async () => {
    const newest = Array.from({ length: 130 }, (_, i) => commit(130 - i, `Change ${130 - i}\n`));
    const asked: string[] = [];
    const api: GitHubApi = (path) => {
      asked.push(path);
      const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
      return newest.slice((page - 1) * 100, page * 100);
    };
    expect((await commitsSince(api, repo, undefined, '2026-11-11-rc')).map((c) => c.commit.message)).toEqual(
      newest.map((c) => c.commit.message).reverse(),
    );
    expect(asked).toEqual([
      'repos/owner/name/commits?sha=2026-11-11-rc&per_page=100&page=1',
      'repos/owner/name/commits?sha=2026-11-11-rc&per_page=100&page=2',
    ]);
  });

  it('takes the pull request GitHub records a commit as the merge commit of, not one the commit is only part of, with who opened it', async () => {
    const answers: Record<string, unknown> = {
      [`repos/owner/name/commits/${sha(1)}/pulls?per_page=100`]: [
        // Open, with this commit in its branch.
        { number: 30, title: 'Later work', merged_at: null, merge_commit_sha: sha(9) },
        // Merged, with this commit in its branch, by another merge commit.
        { number: 29, title: 'Other work', merged_at: '2026-11-12T00:00:00Z', merge_commit_sha: sha(8) },
        { number: 28, title: 'This work', merged_at: '2026-11-12T00:00:00Z', merge_commit_sha: sha(1), user: { login: 'opener' } },
      ],
      [`repos/owner/name/commits/${sha(4)}/pulls?per_page=100`]: [
        { number: 27, title: 'Ghost', merged_at: '2026-11-12T00:00:00Z', merge_commit_sha: sha(4), user: null },
      ],
      [`repos/owner/name/commits/${sha(2)}/pulls?per_page=100`]: [{ number: 31, title: 'Open', merged_at: null, merge_commit_sha: sha(2) }],
      [`repos/owner/name/commits/${sha(3)}/pulls?per_page=100`]: [],
    };
    const api: GitHubApi = (path) => answers[path];
    expect(await pullMergedBy(api, repo, sha(1))).toEqual({ number: 28, title: 'This work', author: 'opener' });
    expect(await pullMergedBy(api, repo, sha(2))).toBeUndefined();
    expect(await pullMergedBy(api, repo, sha(3))).toBeUndefined();
    // An account that is gone.
    expect(await pullMergedBy(api, repo, sha(4))).toEqual({ number: 27, title: 'Ghost', author: undefined });
  });

  it('names the authors with no commit before the version before it, each once, with their first change', async () => {
    const changes = changesOf(
      [
        commit(1, 'One\n', { login: 'old', email: 'old@example.com' }),
        commit(2, 'Two\n', { login: 'new', email: 'new@example.com' }),
        commit(3, 'Three\n', { login: 'new', email: 'new@other.example' }),
        // GitHub finds no commit by a bot's account, only by its address.
        commit(4, 'Bump a dependency\n', { login: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' }),
        commit(5, 'Five\n', { login: null }),
      ],
      repo,
      noPulls,
    );
    const before = new Set(['old', '49699333+dependabot[bot]@users.noreply.github.com']);
    const asked: string[] = [];
    const api: GitHubApi = (path) => {
      asked.push(path);
      const author = decodeURIComponent(/&author=([^&]+)&/.exec(path)![1]!);
      return before.has(author) ? [{ sha: sha(0) }] : [];
    };
    expect((await newContributors(api, repo, '2026-11-12', changes)).map((c) => [c.login, c.title])).toEqual([['new', 'Two']]);
    const q = (author: string) => `repos/owner/name/commits?sha=2026-11-12&author=${encodeURIComponent(author)}&per_page=1`;
    // Each account, then each of its addresses here, until one has a commit before.
    expect(asked.sort()).toEqual(
      [
        q('old'),
        q('new'),
        q('new@example.com'),
        q('new@other.example'),
        q('dependabot[bot]'),
        q('49699333+dependabot[bot]@users.noreply.github.com'),
      ].sort(),
    );
    // From the first commit on, every author with a GitHub account is new.
    expect((await newContributors(() => [{ sha: sha(0) }], repo, undefined, changes)).map((c) => c.login)).toEqual([
      'old',
      'new',
      'dependabot[bot]',
    ]);
    // Named with their first pull request, as GitHub's notes do, though a commit of its branch comes first;
    // in the order they first appear.
    const branch = changesOf(
      [
        commit(10, 'Work on the branch\n', { login: 'contributor' }),
        commit(11, 'Fix it\n', { login: 'other' }),
        commit(12, 'Merge pull request #7 from contributor/branch\n\nThe work\n', { parents: [11, 10], login: 'maintainer' }),
      ],
      repo,
      (s) => (s === sha(12) ? { number: 7, title: 'The work', author: 'contributor' } : undefined),
    );
    expect((await newContributors(() => [], repo, '2026-11-12', branch)).map((c) => [c.login, c.url.replace(site, '')])).toEqual([
      ['contributor', '/pull/7'],
      ['other', `/commit/${sha(11)}`],
    ]);
  });

  it('asks GitHub a few things at once, never more than eight', async () => {
    let now = 0;
    let most = 0;
    const done = await mapLimit(
      Array.from({ length: 30 }, (_, i) => i),
      8,
      async (i) => {
        most = Math.max(most, ++now);
        await new Promise((r) => setTimeout(r, 1 + (i % 3)));
        now--;
        return i * 2;
      },
    );
    expect(done).toEqual(Array.from({ length: 30 }, (_, i) => i * 2));
    expect(most).toBe(8);
    expect(await mapLimit([], 8, (i: number) => i)).toEqual([]);
  });

  it("writes the list as GitHub's notes do", () => {
    const changes: Change[] = [
      { title: 'Pick a theme', login: 'dev', name: 'Dev', url: `${site}/commit/${sha(1)}` },
      { title: 'Faster tests', login: 'dev', name: 'Dev', url: `${site}/pull/25` },
      { title: 'A fix', name: 'Someone', url: `${site}/commit/${sha(2)}` },
    ];
    expect(changesMarkdown({ repo, tag: '2026-11-12.1', since: '2026-11-12', changes, newContributors: [changes[1]!] })).toBe(
      [
        "## What's Changed",
        `* Pick a theme by @dev in ${site}/commit/${sha(1)}`,
        `* Faster tests by @dev in ${site}/pull/25`,
        `* A fix by Someone in ${site}/commit/${sha(2)}`,
        '',
        '## New Contributors',
        `* @dev made their first contribution in ${site}/pull/25`,
        '',
        `**Full Changelog**: ${site}/compare/2026-11-12...2026-11-12.1`,
        '',
      ].join('\n'),
    );
    // Nothing since the version before: the link alone, as GitHub writes it; none before: the history up to it.
    expect(changesMarkdown({ repo, tag: '2026-11-13-rc.1', since: '2026-11-13-rc', changes: [], newContributors: [] })).toBe(
      `**Full Changelog**: ${site}/compare/2026-11-13-rc...2026-11-13-rc.1\n`,
    );
    expect(changesMarkdown({ repo, tag: '2026-11-11-rc', since: undefined, changes: [], newContributors: [] })).toBe(
      `**Full Changelog**: ${site}/commits/2026-11-11-rc\n`,
    );
    // A bot as GitHub's notes name it.
    const bot: Change = { title: 'Bump a dependency', login: 'dependabot[bot]', name: 'dependabot[bot]', url: `${site}/pull/40` };
    expect(changesMarkdown({ repo, tag: 't', since: 's', changes: [bot], newContributors: [bot] })).toContain(
      `* Bump a dependency by @dependabot in ${site}/pull/40\n\n## New Contributors\n* @dependabot made their first contribution in ${site}/pull/40\n`,
    );
  });

  it('keeps a subject one line of text: no heading, quote or list of its own, and nobody notified it merely names', () => {
    expect(subjectMarkdown('# Not a heading')).toBe('\\# Not a heading');
    expect(subjectMarkdown('### Not a heading')).toBe('\\### Not a heading');
    expect(subjectMarkdown('#123 is fixed')).toBe('#123 is fixed');
    expect(subjectMarkdown('> not a quote')).toBe('\\> not a quote');
    expect(subjectMarkdown('- not a list')).toBe('\\- not a list');
    expect(subjectMarkdown('* not a list')).toBe('\\* not a list');
    expect(subjectMarkdown('+ not a list')).toBe('\\+ not a list');
    expect(subjectMarkdown('1. not a list')).toBe('1\\. not a list');
    expect(subjectMarkdown('2) not a list')).toBe('2\\) not a list');
    expect(subjectMarkdown('2026-11-12 was a release')).toBe('2026-11-12 was a release');
    expect(subjectMarkdown('-rc releases')).toBe('-rc releases');
    // An @name outside code goes in code, so that the notes notify no one it names; addresses, packages in code, and the rest stay.
    expect(subjectMarkdown('Thank @alice and @bob-2 for the fix')).toBe('Thank `@alice` and `@bob-2` for the fix');
    expect(subjectMarkdown('Name the members its message @mentions')).toBe('Name the members its message `@mentions`');
    expect(subjectMarkdown('Ask @org/team')).toBe('Ask `@org/team`');
    expect(subjectMarkdown('Mail dev@example.com')).toBe('Mail dev@example.com');
    expect(subjectMarkdown('Bump `@types/node` and @types/react')).toBe('Bump `@types/node` and `@types/react`');
    expect(subjectMarkdown('@lead goes first')).toBe('`@lead` goes first');
    expect(subjectMarkdown('Keep paths out of shell commands')).toBe('Keep paths out of shell commands');
    // Wherever GitHub would take one for a mention: after an underscore or a slash too.
    expect(subjectMarkdown('Hi _@octocat_')).toBe('Hi _`@octocat`_');
    expect(subjectMarkdown('a/@octocat')).toBe('a/`@octocat`');
    expect(subjectMarkdown('first_last@example.com')).toBe('first_last@example.com');
    // With what is attached to it: GitHub would link `@latest` once the rest is in code.
    expect(subjectMarkdown('Install @openai/codex@latest')).toBe('Install `@openai/codex@latest`');
    expect(subjectMarkdown('Pin @types/node@22.')).toBe('Pin `@types/node@22`.');
    expect(subjectMarkdown('@a@octocat')).toBe('`@a@octocat`');
    expect(subjectMarkdown('Thanks @alice.')).toBe('Thanks `@alice`.');
    // Links and addresses stay as they are: GitHub links no mention in them.
    expect(subjectMarkdown('See https://www.npmjs.com/package/@types/node')).toBe('See https://www.npmjs.com/package/@types/node');
    expect(subjectMarkdown('Mail dev_@example.com')).toBe('Mail dev_@example.com');
    // An author's name in git, too.
    const named: Change = { title: 'Fix it', name: '@someone', url: `${site}/commit/${sha(1)}` };
    expect(changesMarkdown({ repo, tag: 't', since: 's', changes: [named], newContributors: [] })).toContain(
      `* Fix it by \`@someone\` in ${site}/commit/${sha(1)}`,
    );
  });

  it('ends a list too long for GitHub with how many more changes there are', () => {
    const changes: Change[] = Array.from({ length: 50 }, (_, i) => ({
      title: `Change number ${i + 1}`,
      login: 'dev',
      name: 'Dev',
      url: `${site}/commit/${sha(i + 1)}`,
    }));
    const full = changesMarkdown({ repo, tag: 't', since: 's', changes, newContributors: [] });
    expect(full).not.toContain('more change');
    const cut = changesMarkdown({ repo, tag: 't', since: 's', changes, newContributors: [changes[0]!], limit: 2000 });
    expect(cut.length).toBeLessThanOrEqual(2000);
    const shown = cut.split('\n').filter((l) => l.startsWith('* Change number'));
    expect(shown.length).toBeGreaterThan(5);
    expect(shown).toEqual(changes.slice(0, shown.length).map((c) => `* ${c.title} by @dev in ${c.url}`));
    // GitHub's comparison page shows 250 commits at most: the history up to the tag holds them all.
    expect(cut).toContain(
      `\n* … and ${50 - shown.length} more changes, in the history up to t: ${site}/commits/t\n\n## New Contributors\n`,
    );
    expect(cut.endsWith(`**Full Changelog**: ${site}/compare/s...t\n`)).toBe(true);
    // As long as it fits, every change.
    expect(changesMarkdown({ repo, tag: 't', since: 's', changes, newContributors: [], limit: full.length })).toBe(full);
    expect(
      changesMarkdown({ repo, tag: 't', since: 's', changes, newContributors: [], limit: full.length - 1 }).length,
    ).toBeLessThanOrEqual(full.length - 1);
  });

  it("lists this repository's 2026-11-12.1 with the commits pushed to main between its pull requests", async () => {
    // GitHub's answers for it, recorded (only the fields the notes read).
    const f = JSON.parse(readFileSync('test/fixtures/release/2026-11-12.1.json', 'utf8')) as {
      repo: string;
      since: string;
      target: string;
      compare: unknown;
      pulls: Record<string, unknown>;
      before: Record<string, unknown>;
    };
    const api: GitHubApi = (path) => {
      if (path.startsWith(`repos/${f.repo}/compare/${f.since}...${f.target}?`))
        return path.endsWith('page=1') ? f.compare : { total_commits: 5, commits: [] };
      const pulls = /\/commits\/([0-9a-f]{40})\/pulls\?/.exec(path);
      if (pulls) return f.pulls[pulls[1]!];
      const before = /\/commits\?sha=[^&]+&author=([^&]+)&/.exec(path);
      if (before) return f.before[decodeURIComponent(before[1]!)];
      throw new Error(`Not recorded: ${path}`);
    };
    const { markdown } = await releaseChanges({ api, repo: f.repo, tag: f.target, since: f.since, target: f.target });
    const s = 'https://github.com/Agentic-System-Lab/harness-relay';
    expect(markdown).toBe(
      [
        "## What's Changed",
        `* Let visitors pick a light or dark theme on the landing page, remembered in their browser by @cyyeh in ${s}/commit/4f85614ae21b2b407b7f40cb46d0ff51a59c665e`,
        `* Run the end-to-end tests and the Windows release builds faster by @cyyeh in ${s}/pull/25`,
        `* List a release's changes since the release before it, and a release candidate's since the version before it by @cyyeh in ${s}/pull/27`,
        `* Add Antigravity as a fifth coding agent, run over ACP with every command asked below full access by @cyyeh in ${s}/pull/26`,
        `* Say the agents work together on the landing page, not chat, and keep its GitHub button close in English by @cyyeh in ${s}/commit/48897c446bd533597e5ff2eb05d5c1c4ecb0dfcb`,
        '',
        `**Full Changelog**: ${s}/compare/2026-11-12...2026-11-12.1`,
        '',
      ].join('\n'),
    );
  });

  it('tells when GitHub does not know where the list ends, from other failures', () => {
    expect(notFoundTarget('gh api repos/o/n/compare/2026-11-13...2026-11-14?per_page=100&page=1: gh: Not Found (HTTP 404)')).toBe(true);
    expect(notFoundTarget('gh api repos/o/n/commits?sha=abc&per_page=100&page=1: gh: Not Found (HTTP 404)')).toBe(true);
    expect(notFoundTarget('gh api repos/o/n/compare/2026-11-11.1...2026-11-12?per_page=100&page=1: gh: Bad credentials (HTTP 401)')).toBe(
      false,
    );
    expect(notFoundTarget('gh api repos/o/n/commits/abc/pulls?per_page=100: gh: Not Found (HTTP 404)')).toBe(false);
    expect(notFoundTarget('GitHub listed 100 of the 150 commits from a to b.')).toBe(false);
  });

  it('bundles into the desktop app, which is CommonJS: no top-level await', async () => {
    // desktop/src/update.ts imports this file, and desktop/scripts/build.ts bundles the app this way.
    const { build } = await import('esbuild');
    const r = await build({
      entryPoints: ['scripts/release.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      logLevel: 'silent',
      define: { 'import.meta.url': 'undefined' },
    });
    expect(r.errors).toEqual([]);
  });

  it("reads owner/name from a GitHub remote's URL", () => {
    expect(repoOfRemote('https://github.com/Agentic-System-Lab/harness-relay.git\n')).toBe('Agentic-System-Lab/harness-relay');
    expect(repoOfRemote('https://github.com/Agentic-System-Lab/harness-relay')).toBe('Agentic-System-Lab/harness-relay');
    expect(repoOfRemote('git@github.com:owner/name.git')).toBe('owner/name');
    expect(repoOfRemote('ssh://git@github.com/owner/my.repo.git')).toBe('owner/my.repo');
    expect(repoOfRemote('/tmp/origin.git')).toBeUndefined();
    expect(repoOfRemote('https://gitlab.com/owner/name.git')).toBeUndefined();
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
      env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', GITHUB_REF: '', GITHUB_SHA: '', RELEASE_TIME_ZONE: '', ...env },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it('checks a version against today in Taiwan when no day is given', () => {
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

  // The stand-in gh is a shell script started by its #! line, which Windows does not do.
  it.skipIf(process.platform === 'win32')(
    "with --own-tag, takes the version's tag without a release on GitHub as the workflow's own",
    () => {
      // gh as the script calls it: GitHub's release of the tag there (out), not there (404), or no answer (502).
      const bin = join(dir, 'gh-bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, 'gh'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$GH_RELEASE" in
  out) echo '{"tag_name":"2026-11-13-rc"}' ;;
  none) echo '{"message":"Not Found","status":"404"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
  *) echo 'gh: Server Error (HTTP 502)' >&2; exit 1 ;;
esac
`,
      );
      chmodSync(join(bin, 'gh'), 0o755);
      const calls = join(dir, 'gh-calls');
      const gh = (GH_RELEASE: 'out' | 'none' | 'unknown') => {
        writeFileSync(calls, '');
        return { PATH: `${bin}${delimiter}${process.env.PATH}`, GH_CALLS: calls, GH_RELEASE, GITHUB_REPOSITORY: 'o/r' };
      };
      const asked = () => readFileSync(calls, 'utf8');
      const check = (version: string, ...flags: string[]) => ['check', version, '--today', '2026-11-13', '--remote', ...flags];
      git(repo, 'tag', '2026-11-13-rc');
      git(repo, 'push', '-q', 'origin', '2026-11-13-rc');
      const own = run(check('2026-11-13-rc', '--own-tag'), gh('none'));
      expect(own.code).toBe(0);
      expect(own.out).toContain('2026-11-13-rc may be released');
      expect(own.out).toContain("Its tag is on GitHub without a release: the Release workflow made it at a run's start.");
      expect(asked()).toBe('api repos/o/r/releases/tags/2026-11-13-rc\n');
      // With a release, it is out.
      const out = run(check('2026-11-13-rc', '--own-tag'), gh('out'));
      expect(out.code).toBe(1);
      expect(out.err).toContain('2026-11-13-rc has already been released');
      expect(out.out).not.toContain('Its tag is on GitHub');
      // Without an answer, nothing is taken as the workflow's own.
      const unknown = run(check('2026-11-13-rc', '--own-tag'), gh('unknown'));
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain(
        '✗ Could not ask GitHub whether 2026-11-13-rc has a release: gh api repos/o/r/releases/tags/2026-11-13-rc: gh: Server Error (HTTP 502)',
      );
      // GitHub is asked only about the version's own tag, and only with --own-tag.
      expect(run(check('2026-11-13-rc.1', '--own-tag'), gh('unknown')).code).toBe(0);
      expect(asked()).toBe('');
      expect(run(check('2026-11-13-rc'), gh('none')).code).toBe(1);
      expect(asked()).toBe('');
      git(repo, 'push', '-q', 'origin', ':refs/tags/2026-11-13-rc');
      git(repo, 'tag', '-d', '2026-11-13-rc');
    },
  );

  // gh as the script calls it, for a release's candidates: a release of each tag GH_RELEASED names, Not
  // Found for any other, or no answer (GH_DOWN). A shell script started by its #! line, which Windows
  // does not do.
  const candidateGh = (() => {
    const bin = join(dir, 'gh-candidates');
    const calls = join(dir, 'gh-candidate-calls');
    if (process.platform !== 'win32') {
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, 'gh'),
        `#!/bin/sh
printf '%s\\n' "$2" >> "$GH_CALLS"
if [ -n "$GH_DOWN" ]; then echo 'gh: Server Error (HTTP 502)' >&2; exit 1; fi
case " $GH_RELEASED " in
  *" \${2##*/} "*) echo '{}' ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`,
      );
      chmodSync(join(bin, 'gh'), 0o755);
    }
    const env = (released: string, extra: Record<string, string> = {}) => {
      writeFileSync(calls, '');
      return {
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        GH_CALLS: calls,
        GH_RELEASED: released,
        GITHUB_REPOSITORY: 'o/r',
        GH_DOWN: '',
        ...extra,
      };
    };
    const asked = () =>
      readFileSync(calls, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((p) => p.replace('repos/o/r/releases/tags/', ''));
    return { env, asked };
  })();
  const onDay = (version: string, ...flags: string[]) => ['check', version, '--today', '2026-11-14', ...flags];
  /** 2026-11-14-rc and 2026-11-14-rc.1 tagged here and on origin, for `fn`. */
  const withCandidates = (fn: () => void) => {
    git(repo, 'tag', '2026-11-14-rc');
    git(repo, 'tag', '2026-11-14-rc.1');
    git(repo, 'push', '-q', 'origin', '2026-11-14-rc', '2026-11-14-rc.1');
    try {
      fn();
    } finally {
      git(repo, 'push', '-q', 'origin', ':refs/tags/2026-11-14-rc', ':refs/tags/2026-11-14-rc.1');
      git(repo, 'tag', '-d', '2026-11-14-rc', '2026-11-14-rc.1');
    }
  };

  it.skipIf(process.platform === 'win32')(
    "with --remote, takes a release's newest candidate only once GitHub has a release of it",
    () => {
      const { env: gh, asked } = candidateGh;
      // No candidate's tag at all: refused without asking GitHub.
      const none = run(onDay('2026-11-14', '--remote'), gh(''));
      expect(none.code).toBe(1);
      expect(none.err).toContain('✗ 2026-11-14 has no release candidate yet: release 2026-11-14-rc first, then 2026-11-14.');
      expect(asked()).toEqual([]);
      withCandidates(() => {
        // The newest is not out: refused, an older one that is out notwithstanding, and only the newest asked about.
        const unreleased = run(onDay('2026-11-14', '--remote'), gh('2026-11-14-rc'));
        expect(unreleased.code).toBe(1);
        expect(unreleased.err).toContain(
          "✗ 2026-11-14's newest release candidate, 2026-11-14-rc.1, has its tag on GitHub without a release (a run that failed or was stopped, its end-to-end tests perhaps). Release 2026-11-14-rc.1 again or 2026-11-14-rc.2, then 2026-11-14.",
        );
        expect(asked()).toEqual(['2026-11-14-rc.1']);
        // The newest is out.
        const out = run(onDay('2026-11-14', '--remote'), gh('2026-11-14-rc.1'));
        expect(out.code).toBe(0);
        expect(out.out).toContain('It comes after its release candidate 2026-11-14-rc.1, which is out.');
        expect(asked()).toEqual(['2026-11-14-rc.1']);
        // Without an answer, it is taken neither as out nor as not out.
        const down = run(onDay('2026-11-14', '--remote'), gh('', { GH_DOWN: '1' }));
        expect(down.code).toBe(1);
        expect(down.err).toContain(
          '✗ Could not ask GitHub whether 2026-11-14-rc.1 has a release: gh api repos/o/r/releases/tags/2026-11-14-rc.1: gh: Server Error (HTTP 502)',
        );
        // Without --remote, the tags here count, and GitHub is not asked; nor for a release candidate, nor
        // for another day's version, which GitHub failing must not hide.
        const local = run(onDay('2026-11-14'), gh('', { GH_DOWN: '1' }));
        expect(local.code).toBe(0);
        expect(local.out).toContain(
          'It comes after its release candidate 2026-11-14-rc.1 (its tag here: --remote asks GitHub whether it is out).',
        );
        expect(run(onDay('2026-11-14-rc.2', '--remote'), gh('', { GH_DOWN: '1' })).code).toBe(0);
        const late = run(['check', '2026-11-14', '--today', '2026-11-15', '--remote', '--own-tag'], gh('', { GH_DOWN: '1' }));
        expect(late.code).toBe(1);
        expect(late.err).toContain('2026-11-14 is not today');
        expect(asked()).toEqual([]);
      });
    },
    slow(20_000),
  );

  it.skipIf(process.platform === 'win32')(
    "in GitHub Actions, warns when a release is made on another commit than its newest candidate's tag",
    () => {
      const { env: gh, asked } = candidateGh;
      withCandidates(() => {
        const output = join(dir, 'candidate-output');
        const head = git(repo, 'rev-parse', 'HEAD').trim();
        const other = 'f'.repeat(40);
        const actions = (sha: string) =>
          gh('2026-11-14-rc.1', { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha });
        writeFileSync(output, '');
        const moved = run(onDay('2026-11-14', '--remote'), actions(other));
        expect(moved.code).toBe(0);
        expect(moved.out).toContain(
          `::warning title=Release candidate::2026-11-14 is made on fffffff, and its release candidate 2026-11-14-rc.1 on ${head.slice(0, 7)}: the end-to-end tests ran on the candidate's commit, not on what came into main since. To have them run on this one, release 2026-11-14-rc.2 first.`,
        );
        expect(run(onDay('2026-11-14', '--remote'), actions(head)).out).not.toContain('::warning');
        // With the version's own tag the workflow made, the release candidate to release first is still the day's next.
        git(repo, 'tag', '2026-11-14');
        git(repo, 'push', '-q', 'origin', '2026-11-14');
        try {
          const own = run(onDay('2026-11-14', '--remote', '--own-tag'), actions(other));
          expect(own.code).toBe(0);
          expect(own.out).toContain("Its tag is on GitHub without a release: the Release workflow made it at a run's start.");
          expect(own.out).toContain('To have them run on this one, release 2026-11-14-rc.2 first.');
          expect(asked()).toEqual(['2026-11-14', '2026-11-14-rc.1']);
        } finally {
          git(repo, 'push', '-q', 'origin', ':refs/tags/2026-11-14');
          git(repo, 'tag', '-d', '2026-11-14');
        }
      });
    },
    slow(20_000),
  );

  it('accepts a release candidate of a patch once the release is out', () => {
    git(repo, 'tag', '2026-11-11');
    const r = run(['check', '2026-11-11.1-rc', '--today', '2026-11-11']);
    expect(r.out).toContain(
      '2026-11-11.1-rc may be released (a release candidate, published as a pre-release; app version 2026.1111.1-rc)',
    );
    expect(r.out).toContain('Its notes list the changes since 2026-11-11.\n');
    expect(r.code).toBe(0);
    git(repo, 'tag', '-d', '2026-11-11');
  });

  it('prints the next versions for today', () => {
    const r = run(['next', '--today', '2026-11-10']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('release candidate  2026-11-10-rc.1');
    expect(r.out).toContain('release            2026-11-10\n');
    // Its release candidate's tag is here (2026-11-10-rc, from the tests before).
    expect(r.out).toContain('  2026-11-10 needs its newest release candidate, 2026-11-10-rc, out first (published, not only tagged).\n');
    // Once the day's release is out, its next patch, and a release candidate of that patch, which it needs first.
    git(repo, 'tag', '2026-11-10');
    const after = run(['next', '--today', '2026-11-10']);
    expect(after.out).toContain('release candidate  2026-11-10.1-rc\n');
    expect(after.out).toContain('release            2026-11-10.1\n');
    expect(after.out).toContain('  2026-11-10.1 needs a release candidate of it out first: 2026-11-10.1-rc.\n');
    git(repo, 'tag', '2026-11-10.1-rc');
    const candidate = run(['next', '--today', '2026-11-10']).out;
    expect(candidate).toContain('release candidate  2026-11-10.1-rc.1\n');
    expect(candidate).toContain(
      '  2026-11-10.1 needs its newest release candidate, 2026-11-10.1-rc, out first (published, not only tagged).\n',
    );
    git(repo, 'tag', '-d', '2026-11-10', '2026-11-10.1-rc');
  });

  it('in GitHub Actions, writes the outputs, and refuses a branch other than main', () => {
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    const actions = { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: output };
    expect(run(['check', '2026-11-12-rc', '--today', '2026-11-12'], { ...actions, GITHUB_REF: 'refs/heads/main' }).code).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(
      'tag=2026-11-12-rc\ntitle=Harness Relay 2026-11-12-rc\nprerelease=true\nsemver=2026.1112.0-rc\ntoday=2026-11-12\nprevious=2026-11-10-rc\n',
    );
    // A release starts its notes at the release before it, past the release candidates since.
    git(repo, 'tag', '2026-11-11');
    git(repo, 'tag', '2026-11-12-rc');
    writeFileSync(output, '');
    const release = run(['check', '2026-11-12', '--today', '2026-11-12'], { ...actions, GITHUB_REF: 'refs/heads/main' });
    expect(release.code).toBe(0);
    expect(release.out).toContain('Its notes list the changes since 2026-11-11, the release before it.');
    expect(release.out).toContain('It comes after its release candidate 2026-11-12-rc');
    expect(readFileSync(output, 'utf8')).toContain('\nprevious=2026-11-11\n');
    git(repo, 'tag', '-d', '2026-11-11', '2026-11-12-rc');
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
    const first = run(['check', '2026-11-10', '--today', '2026-11-10']);
    expect(first.code).toBe(0);
    // Only a release candidate is out (2026-11-10-rc, from the test before): no release to start the notes at.
    expect(first.out).toContain('There is no release before it: its notes list every commit up to it.');
    expect(run(['check']).code).toBe(2);
    expect(run(['check', '--remote']).code).toBe(2);
    expect(run(['publish', '2026-11-10']).code).toBe(2);
  });

  it('refuses notes for a version that breaks the rules, a --target without a commit, and an origin that is not on GitHub', () => {
    // None of these reaches GitHub.
    const offline = { GITHUB_REPOSITORY: '', GH_TOKEN: '' };
    expect(run(['notes'], offline).code).toBe(2);
    expect(run(['notes', '--remote'], offline).code).toBe(2);
    const bad = run(['notes', 'v2026-11-10'], offline);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('Drop the "v"');
    expect(run(['notes', '2026-11-10', '--target'], offline).code).toBe(2);
    expect(run(['notes', '2026-11-10', '--target', '--remote'], offline).code).toBe(2);
    // This repository's origin is a folder.
    const local = run(['notes', '2026-11-10'], offline);
    expect(local.code).toBe(2);
    expect(local.err).toContain('origin is not a GitHub repository: set GITHUB_REPOSITORY to owner/name.');
  });

  it('follows RELEASE_TIME_ZONE', () => {
    const before = todayIn('Pacific/Kiritimati');
    const r = run(['next'], { RELEASE_TIME_ZONE: 'Pacific/Kiritimati' });
    const after = todayIn('Pacific/Kiritimati'); // midnight there may pass while it runs
    expect([`Today (${before}, Pacific/Kiritimati)`, `Today (${after}, Pacific/Kiritimati)`].some((line) => r.out.includes(line))).toBe(
      true,
    );
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
    return lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join('\n')
      .trimEnd();
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
    // In a job of its own that needs none, which the code's check needs: a wrong version fails in seconds.
    const version = job('version');
    expect(version).not.toMatch(/^ {4}needs:/m);
    expect(version).toContain('run: node scripts/release.ts check "$VERSION" --remote --own-tag');
    const check = job('check');
    expect(check).toMatch(/^ {4}needs: \[tokens, version\]$/m);
    expect(check).not.toContain('release.ts check');
    const release = job('release');
    expect(release).toContain('node scripts/release.ts check "$VERSION" --remote --own-tag --today "$TODAY"');
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
    expect(build).toMatch(/needs: \[version, check\]/);
    expect(job('release')).toMatch(/needs: \[version, check, build, e2e\]/);
    // One installer of each kind goes up, named after the version.
    expect(build).toContain("-c.artifactName='Harness-Relay-${env.RELAY_VERSION}-${os}-${arch}.${ext}'");
    expect(build).toContain('RELAY_VERSION: ${{ needs.version.outputs.tag }}');
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
    // In the repository the app downloads them from: the one the build named, read as the build reads it.
    expect(step).toContain('RELAY_UPDATES_REPO: ${{ vars.UPDATES_REPO }}');
    expect(step).toContain("import { updateSourceFrom } from './desktop/src/updateSource.ts';");
    expect(step).toContain('updateSourceFrom({ RELAY_UPDATES_REPO: process.env.RELAY_UPDATES_REPO })');
    expect(step).toContain('gh release create "$TAG" updates/* --repo "$repo"');
    // Tried again: the copies uploaded again over the ones there.
    expect(step).toContain('gh release upload "$TAG" updates/* --repo "$repo" --clobber');
    expect(step).toContain('The UPDATES_TOKEN secret is not set');
    expect(release.slice(published)).toContain('gh release create "$TAG" installers/*');
    expect(release.slice(published)).not.toContain('updates/');
  });

  it('hands the write token to the copies’ step and the tokens job only, and the read token to the app’s build, the tokens job and the checks only', () => {
    expect(workflow.match(/secrets\.[A-Z_]+/g)?.filter((s) => !s.startsWith('secrets.MIRROR_'))).toEqual([
      // That it is set at all, in the shell alone, in the tokens job.
      'secrets.UPDATES_TOKEN',
      // The comparison of the two, in the shell alone, in the tokens job.
      'secrets.UPDATES_TOKEN',
      'secrets.UPDATES_READ_TOKEN',
      // Whose they are, asked of GitHub in the shell alone, in the tokens job too.
      'secrets.UPDATES_TOKEN',
      'secrets.UPDATES_READ_TOKEN',
      // The update source checked, with the repository's own code, before anything is installed.
      'secrets.UPDATES_READ_TOKEN',
      // The app's build, and the checks of the packaged app, which find it there.
      'secrets.UPDATES_READ_TOKEN',
      'secrets.UPDATES_READ_TOKEN',
      'secrets.UPDATES_READ_TOKEN',
      // The check of the builds' fingerprints.
      'secrets.UPDATES_READ_TOKEN',
      // The copies' publishing.
      'secrets.UPDATES_TOKEN',
      // The check that an app can download them.
      'secrets.UPDATES_READ_TOKEN',
    ]);
    const release = job('release');
    const step = (name: string) => {
      const from = release.indexOf(`- name: ${name}`);
      expect(from, name).toBeGreaterThan(0);
      const next = release.indexOf('- name: ', from + 1);
      return release.slice(from, next < 0 ? undefined : next);
    };
    const copies = step("Publish the copies for the app's updates");
    expect(copies).toContain('GH_TOKEN: ${{ secrets.UPDATES_TOKEN }}');
    expect(copies).not.toContain('UPDATES_READ_TOKEN');
    // The write token's two checks in a job of their own: nothing checked out or installed there, since a
    // runner keeps the secrets a job names for the whole job; and no job that runs npm's packages names it.
    const tokensJob = job('tokens');
    expect(tokensJob).toContain('- name: Expect the write token');
    expect(tokensJob).toContain('- name: Refuse a read token that is the write token');
    expect(tokensJob).toContain("- name: Warn when the read token's account also owns the write token");
    expect(tokensJob.match(/WRITE_TOKEN: \$\{\{ secrets\.UPDATES_TOKEN \}\}/g)).toHaveLength(3);
    // Each token goes to curl on its standard input, never among its arguments.
    expect(tokensJob).toContain('printf \'Authorization: Bearer %s\\n\' "$1" | curl -fsS --max-time 30 -H @- ');
    expect(tokensJob).not.toMatch(/-H "Authorization/);
    expect(tokensJob.match(/READ_TOKEN: \$\{\{ secrets\.UPDATES_READ_TOKEN \}\}/g)).toHaveLength(2);
    expect(tokensJob).not.toMatch(/\buses:|\bnode\b|\bgh\b|\bnpm\b/);
    expect(job('check')).toMatch(/^\s+needs: \[tokens, version\]$/m);
    for (const name of ['version', 'check', 'build']) expect(job(name), name).not.toContain('secrets.UPDATES_TOKEN');
    const checkJob = job('check');
    const source = checkJob.slice(checkJob.indexOf('- name: Check the update source'), checkJob.indexOf('- name: Install'));
    expect(source).toContain('RELAY_UPDATES_TOKEN: ${{ secrets.UPDATES_READ_TOKEN }}');
    expect(source).toContain('GH_TOKEN: ${{ github.token }}');
    expect(source).toContain('repositoryReadable(fetch, { source: source.value, token: process.env.GH_TOKEN })');
    expect(source).not.toContain('secrets.UPDATES_TOKEN');
    expect(checkJob.indexOf('- name: Check the update source')).toBeLessThan(checkJob.indexOf('- name: Install'));
    expect(release).not.toContain('Refuse a read token');
    for (const name of [
      "Check that the installers were built with this run's update source",
      'Check that the app can download the copies',
    ]) {
      const check = step(name);
      expect(check, name).toContain('RELAY_UPDATES_REPO: ${{ vars.UPDATES_REPO }}');
      expect(check, name).toContain('RELAY_UPDATES_TOKEN: ${{ secrets.UPDATES_READ_TOKEN }}');
      expect(check, name).not.toContain('secrets.UPDATES_TOKEN');
    }
    // The app's build, given where it downloads its updates from (the same variable the copies follow) and the token it downloads them with.
    const build = job('build');
    const built = build.slice(
      build.indexOf('- name: Build the desktop app'),
      build.indexOf('- name: Run the bundled server as the desktop app does'),
    );
    expect(built).toContain('RELAY_UPDATES_REPO: ${{ vars.UPDATES_REPO }}');
    expect(built).toContain('RELAY_UPDATES_TOKEN: ${{ secrets.UPDATES_READ_TOKEN }}');
    expect(built).toContain('run: npm --prefix desktop run build');
    expect(workflow.match(/vars\.UPDATES_REPO/g)).toHaveLength(7);
    for (const name of ['Check the packaged app', 'Check the packaged app (Linux, on a virtual display)']) {
      const checked = build.slice(build.indexOf(`- name: ${name}\n`), build.indexOf('- name: ', build.indexOf(`- name: ${name}\n`) + 1));
      expect(checked, name).toContain('RELAY_UPDATES_TOKEN: ${{ secrets.UPDATES_READ_TOKEN }}');
      expect(checked, name).toContain('RELAY_UPDATES_REPO: ${{ vars.UPDATES_REPO }}');
    }
    // A build run again in a later attempt replaces what it uploaded.
    expect(build.match(/overwrite: true/g)).toHaveLength(2);
  });

  it('uploads a release’s installers to the download mirror before publishing it, checks it serves them, and prunes it after', () => {
    const release = job('release');
    const step = (name: string) => {
      const from = release.indexOf(`- name: ${name}\n`);
      expect(from, name).toBeGreaterThan(0);
      const next = release.indexOf('- name: ', from + 1);
      return release.slice(from, next < 0 ? undefined : next);
    };
    const at = (name: string) => release.indexOf(`- name: ${name}\n`);
    // After the copies are checked (nothing is uploaded for a run that stops there), before the release.
    expect(at('Upload the installers to the download mirror')).toBeGreaterThan(at('Check that the app can download the copies'));
    expect(at('Check that the download mirror serves the installers')).toBeGreaterThan(at('Upload the installers to the download mirror'));
    expect(at('Publish')).toBeGreaterThan(at('Check that the download mirror serves the installers'));
    expect(at('Remove older releases from the download mirror')).toBeGreaterThan(at('Publish'));
    const upload = step('Upload the installers to the download mirror');
    // The mirror the website uses, and none for a release candidate, which the website never offers.
    expect(upload).toContain("import { MIRROR, isMirror } from './site/assets/downloads.js';");
    expect(upload).toContain('if [ -z "$mirror" ]; then');
    expect(upload).toContain('if [ "$PRERELEASE" = true ]; then');
    expect(upload).toContain('needs the MIRROR_ACCESS_KEY_ID and MIRROR_SECRET_ACCESS_KEY secrets and the MIRROR_ENDPOINT variable');
    expect(upload).toContain('aws s3 cp "$file" "s3://$MIRROR_BUCKET/$TAG/$(basename "$file")" --endpoint-url "$MIRROR_ENDPOINT"');
    expect(upload).toContain('echo "url=$mirror" >> "$GITHUB_OUTPUT"');
    // Its last byte asked for, a redirect to GitHub not followed: neither is counted as a download there.
    const check = step('Check that the download mirror serves the installers');
    expect(check).toContain("if: steps.mirror.outputs.url != ''");
    expect(check).toContain('curl -sS --max-time 30 -r -1 -o /dev/null -D - "$MIRROR/$TAG/$name"');
    expect(check).not.toMatch(/curl[^\n]* -L/);
    expect(check).toContain('expected="bytes $((size - 1))-$((size - 1))/$size"');
    const prune = step('Remove older releases from the download mirror');
    expect(prune).toContain("if: steps.mirror.outputs.url != ''");
    expect(prune).toContain('sort -V | head -n -2');
    expect(prune).not.toMatch(/exit 1/);
    // The mirror's secrets go to its two steps that use the bucket, in the job that installs no npm package.
    expect(workflow.match(/secrets\.MIRROR_[A-Z_]+/g)).toEqual([
      'secrets.MIRROR_ACCESS_KEY_ID',
      'secrets.MIRROR_SECRET_ACCESS_KEY',
      'secrets.MIRROR_ACCESS_KEY_ID',
      'secrets.MIRROR_SECRET_ACCESS_KEY',
    ]);
    for (const s of [upload, prune]) {
      expect(s).toContain('AWS_ACCESS_KEY_ID: ${{ secrets.MIRROR_ACCESS_KEY_ID }}');
      expect(s).toContain('AWS_SECRET_ACCESS_KEY: ${{ secrets.MIRROR_SECRET_ACCESS_KEY }}');
      expect(s).toContain('MIRROR_ENDPOINT: ${{ vars.MIRROR_ENDPOINT }}');
    }
    expect(check).not.toContain('secrets.');
    expect(release).not.toMatch(/\bnpm (ci|install)\b/);
  });

  it('may write to the repository only in the job that tags the commit and the one that publishes', () => {
    expect(block('permissions')).toBe('  contents: read');
    expect(workflow.match(/contents: write/g)).toHaveLength(2);
    expect(job('version')).toMatch(/permissions:\n\s+contents: write\n {4}outputs:/);
    // The tag's job installs nothing and names no secret: only GitHub's own actions and the repository's code run there.
    expect(job('version')).not.toMatch(/\bnpm\b|\bnpx\b|secrets\./);
    expect(job('version').match(/uses: \S+/g)).toEqual(['uses: actions/checkout@v7', 'uses: actions/setup-node@v7']);
    expect(job('version')).not.toContain('cache:');
    expect(job('release')).toMatch(/permissions:\n\s+contents: write/);
    // It reads the pull requests the notes' commits merged, and may change none.
    expect(job('release')).toMatch(/permissions:\n\s+contents: write\n(?:\s+#.*\n)?\s+pull-requests: read\n/);
    expect(workflow).not.toContain('pull-requests: write');
  });

  it('runs the end-to-end tests for a release candidate only, beside the builds, and publishes one only once they pass', () => {
    const e2e = job('e2e');
    expect(e2e).toContain('    uses: ./.github/workflows/e2e.yml');
    expect(e2e).toMatch(/^ {4}needs: \[version, check\]$/m);
    expect(e2e).toMatch(/^ {4}if: needs\.version\.outputs\.prerelease == 'true'$/m);
    // The tests run npm's packages: no secret goes to them, nor any permission beyond the workflow's.
    expect(e2e).not.toMatch(/secrets|permissions/);
    const release = job('release');
    const condition = /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(`${release}\n`)?.[1];
    expect(condition).toBeDefined();
    // The condition as GitHub evaluates it, for every outcome that matters.
    const expression = condition!.replace(/\s+/g, ' ').trim();
    expect(expression).toMatch(/^[!a-z0-9_.()=&|' ]+$/);
    const publishes = new Function('needs', 'cancelled', `return ${expression};`) as (
      needs: Record<string, { result: string; outputs?: Record<string, string> }>,
      cancelled: () => boolean,
    ) => boolean;
    const outcome = (prerelease: string, e2eResult: string, o: { build?: string; cancelled?: boolean } = {}) =>
      publishes(
        {
          version: { result: 'success', outputs: { prerelease } },
          check: { result: 'success' },
          build: { result: o.build ?? 'success' },
          e2e: { result: e2eResult },
        },
        () => o.cancelled ?? false,
      );
    expect(outcome('true', 'success')).toBe(true);
    expect(outcome('true', 'failure')).toBe(false);
    expect(outcome('true', 'cancelled')).toBe(false);
    expect(outcome('true', 'skipped')).toBe(false);
    expect(outcome('false', 'skipped')).toBe(true);
    expect(outcome('false', 'failure')).toBe(false);
    expect(outcome('', 'skipped')).toBe(false);
    expect(outcome('false', 'skipped', { build: 'failure' })).toBe(false);
    expect(outcome('true', 'success', { build: 'skipped' })).toBe(false);
    expect(outcome('true', 'success', { cancelled: true })).toBe(false);
  });

  it('makes one release at a time, never cancelling one under way', () => {
    expect(block('concurrency')).toBe('  group: release\n  cancel-in-progress: false');
  });

  it('publishes a release candidate as a pre-release, on the tag the run made on the commit it built', () => {
    const publish = job('release').slice(job('release').indexOf('- name: Publish'));
    expect(publish).toContain('if [ "$PRERELEASE" = true ]; then');
    expect(publish).toContain('channel=(--prerelease --latest=false)');
    // A release is not offered release candidates: the notes say who is offered which.
    expect(publish).toContain("offered='A Harness Relay that is a release candidate (or a build of your own) offers this one in its menu");
    expect(publish).toContain("offered='A Harness Relay already installed offers this release in its menu");
    // The notes say nothing of the copies, which are not on the release page.
    expect(publish).toContain('$offered See [Desktop app]');
    expect(publish).not.toContain('-update');
    // On the tag made as the run started, never one made here, which GitHub may refuse the job's token.
    expect(publish).toContain('gh release create "$TAG" installers/* --verify-tag ');
    expect(publish).not.toContain('--target');
    // Checked before anything is published: the tag is still on the commit that was checked and built.
    const again = job('release').slice(
      job('release').indexOf('- name: Check the version again'),
      job('release').indexOf('- name: List the changes'),
    );
    expect(again).toContain('at=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$VERSION" --jq .object.sha 2>/dev/null) || at=\'\'');
    expect(again).toContain('if [ "$at" != "$GITHUB_SHA" ]; then');
    expect(again).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('lists every commit into main since the version before in the notes, not only pull requests, before publishing anything', () => {
    const release = job('release');
    const step = (name: string) => release.indexOf(`- name: ${name}\n`);
    const changes = release.slice(step('List the changes since the version before'), release.indexOf('uses: actions/download-artifact'));
    // After the last check, by the same tags (--remote), up to the commit that was checked and built.
    expect(step('List the changes since the version before')).toBeGreaterThan(step('Check the version again'));
    expect(changes).toContain('run: node scripts/release.ts notes "$VERSION" --target "$GITHUB_SHA" --remote > "$RUNNER_TEMP/changes.md"');
    expect(changes).toContain('VERSION: ${{ needs.version.outputs.tag }}');
    // Read with this job's own token, never the copies' one.
    expect(changes).toContain('GH_TOKEN: ${{ github.token }}');
    // Before the copies for the app's updates and the release are published.
    expect(step('List the changes since the version before')).toBeLessThan(step("Publish the copies for the app's updates"));
    const publish = release.slice(step('Publish'));
    expect(publish).toContain(`printf '%s\\n\\n' "$notes" > "$RUNNER_TEMP/notes.md"`);
    expect(publish).toContain('cat "$RUNNER_TEMP/changes.md" >> "$RUNNER_TEMP/notes.md"');
    expect(publish).toContain('--notes-file "$RUNNER_TEMP/notes.md" "${channel[@]}"');
    // GitHub's own notes list pull requests only, and would leave out what was pushed to main.
    expect(workflow).not.toContain('--generate-notes');
    expect(workflow).not.toContain('--notes-start-tag');
  });
});
