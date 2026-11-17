import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO } from '../site/assets/downloads.js';
import { jobsIn, releaseStep, releaseWorkflow, stepsOf } from './workflow-steps';
import { slow } from './timeouts';

// The Release workflow tags the commit it releases as it starts (the version job's step "Tag the
// commit"): GitHub refuses the workflow's token a tag on a commit whose .github/workflows are not
// main's, which a tag made once the installers were built met whenever main's workflow files changed
// meanwhile (2026-11-17-rc).

const tmp = mkdtempSync(join(tmpdir(), 'relay-release-tag-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * A stand-in for `gh`, noting its arguments in `GH_CALLS`, answering as gh does (a failed request: GitHub's
 * JSON on stdout, gh's line on stderr): the tag is on this run's commit when `GH_TAG` is `here`, on another
 * (`OLD_SHA`) when `elsewhere`, missing (404) when `none`, and GitHub fails to say (502) when `unknown`;
 * GitHub makes or moves it when `GH_MAKE` is `ok`, and refuses as it refuses the workflow's token a commit
 * whose workflows are not main's (403) when not. The comparison with main answers `GH_CHANGED`, the
 * workflow files that changed, as gh's `--jq` joins them, or fails when it is `fail`.
 */
const bin = join(tmp, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'gh'),
  `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$*" in
  "api repos/"*"/git/ref/tags/"*)
    case "$GH_TAG" in
      here) echo "$GITHUB_SHA" ;;
      elsewhere) echo "$OLD_SHA" ;;
      none) echo '{"message":"Not Found","status":"404"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
      *) echo 'gh: Server Error (HTTP 502)' >&2; exit 1 ;;
    esac ;;
  "api -X "*)
    [ "$GH_MAKE" = ok ] && { echo "$GITHUB_SHA"; exit 0; }
    echo '{"message":"Resource not accessible by integration","status":"403"}'
    echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1 ;;
  "api repos/"*"/compare/"*)
    [ "$GH_CHANGED" = fail ] && { echo 'gh: Server Error (HTTP 502)' >&2; exit 1; }
    printf '%s\\n' "$GH_CHANGED" ;;
  *) exit 9 ;;
esac
`,
);
chmodSync(join(bin, 'gh'), 0o755);

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OLD = 'fedcba9876543210fedcba9876543210fedcba98';
const TAG = '2026-11-17-rc';

/** The workflow's step, run as the runner runs it, with the stand-in: its status, output and gh's arguments. */
function tag(env: { GH_TAG: 'here' | 'elsewhere' | 'none' | 'unknown'; GH_MAKE?: 'ok' | 'refused'; GH_CHANGED?: string }) {
  const run = mkdtempSync(join(tmp, 'run-'));
  const calls = join(run, 'calls');
  writeFileSync(calls, '');
  const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', releaseStep('Tag the commit')], {
    encoding: 'utf8',
    timeout: slow(20_000),
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GH_CALLS: calls,
      GH_TOKEN: 'ghs_token',
      GITHUB_REPOSITORY: REPO,
      GITHUB_SHA: SHA,
      OLD_SHA: OLD,
      TAG,
      GH_TAG: env.GH_TAG,
      GH_MAKE: env.GH_MAKE ?? 'ok',
      GH_CHANGED: env.GH_CHANGED ?? '',
    },
  });
  return { status: r.status, out: r.stdout, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
}

const ASK = `api repos/${REPO}/git/ref/tags/${TAG} --jq .object.sha`;
const MAKE = `api -X POST repos/${REPO}/git/refs -f ref=refs/tags/${TAG} -f sha=${SHA} --jq .object.sha`;
const MOVE = `api -X PATCH repos/${REPO}/git/refs/tags/${TAG} -f sha=${SHA} -F force=true --jq .object.sha`;
const COMPARE = `api repos/${REPO}/compare/${SHA}...main --jq [.files[]?.filename | select(startswith(".github/workflows/"))] | join(", ")`;

// The step's script runs in bash, which the Windows runners do not have as Linux's.
describe.skipIf(process.platform === 'win32')("the Release workflow's step that tags the commit, run", { timeout: slow(20_000) }, () => {
  it("makes the tag on the run's commit", () => {
    const r = tag({ GH_TAG: 'none' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([ASK, MAKE]);
    expect(r.out).toBe(`Tagged ${SHA} as ${TAG}.\n`);
  });

  it('leaves it as it is when an earlier run of this commit made it', () => {
    const r = tag({ GH_TAG: 'here' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([ASK]);
    expect(r.out).toBe(`${TAG} is on ${SHA} already: an earlier run of this commit tagged it, and published no release.\n`);
  });

  it('moves it from the commit a run that failed left it on', () => {
    const r = tag({ GH_TAG: 'elsewhere' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([ASK, MOVE]);
    expect(r.out).toBe(`Tagged ${SHA} as ${TAG} (moved from ${OLD}, where a run that failed left it).\n`);
  });

  it('makes nothing when GitHub cannot say whether the tag is there', () => {
    const r = tag({ GH_TAG: 'unknown' });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual([ASK]);
    expect(r.out).toBe(`::error::Could not ask GitHub for the tag ${TAG} (gh: Server Error (HTTP 502)): nothing was tagged, built or published.\n`);
  });

  it("names main's changed workflow files when GitHub refuses the tag, and fails at once", () => {
    for (const [GH_TAG, request] of [
      ['none', MAKE],
      ['elsewhere', MOVE],
    ] as const) {
      const r = tag({ GH_TAG, GH_MAKE: 'refused', GH_CHANGED: '.github/workflows/pages.yml' });
      expect(r.status, GH_TAG).toBe(1);
      expect(r.calls, GH_TAG).toEqual([ASK, request, COMPARE]);
      expect(r.out, GH_TAG).toBe(
        `::error::GitHub refused this run's token the tag ${TAG} on ${SHA} (gh: Resource not accessible by integration (HTTP 403)): main's workflow files changed since the run started (.github/workflows/pages.yml), and the token may make a tag only on a commit whose workflows are main's. Nothing was built or published: run the workflow again from main.\n`,
      );
    }
  });

  it("says why otherwise, never with gh's JSON", () => {
    for (const GH_CHANGED of ['', 'fail']) {
      const r = tag({ GH_TAG: 'none', GH_MAKE: 'refused', GH_CHANGED });
      expect(r.status, GH_CHANGED).toBe(1);
      expect(r.out, GH_CHANGED).toBe(`::error::Could not tag ${SHA} as ${TAG} (gh: Resource not accessible by integration (HTTP 403)): nothing was built or published.\n`);
      expect(r.out).not.toContain('{');
    }
  });
});

describe('the job that tags the commit', () => {
  const jobs = jobsIn(releaseWorkflow());
  const version = jobs.get('version')!;

  it('runs as the run starts, beside the tokens job, and everything else waits for it', () => {
    expect([...jobs.keys()].slice(0, 2)).toEqual(['tokens', 'version']);
    expect(version).not.toMatch(/^ {4}needs:/m);
    expect(jobs.get('check')).toMatch(/^ {4}needs: \[tokens, version\]$/m);
    for (const [id, job] of jobs) if (id !== 'tokens' && id !== 'version') expect(job, id).toMatch(/^ {4}needs: \[(?:[a-z]+, )*version[,\]]/m);
  });

  it('checks the version, then tags it with the job\'s own token', () => {
    const steps = stepsOf(version);
    const names = steps.map((s) => /^name: (.+)$/m.exec(s)?.[1]).filter(Boolean);
    expect(names).toEqual(['Check the version', 'Tag the commit']);
    const tagging = steps.find((s) => s.startsWith('name: Tag the commit'))!;
    expect(tagging).toContain('GH_TOKEN: ${{ github.token }}');
    expect(tagging).toContain('TAG: ${{ steps.version.outputs.tag }}');
    expect(version).toContain('tag: ${{ steps.version.outputs.tag }}');
  });
});
