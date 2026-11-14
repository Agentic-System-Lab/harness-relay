import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO } from '../site/assets/downloads.js';
import { releaseStep, releaseWorkflow } from './release-steps';
import { slow } from './timeouts';

// GitHub Codespaces opens the newest release (docs/codespaces.md): every Codespaces link opens the
// branch the Release workflow moves to each release's commit, and its step does that, or only warns.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
/** The branch, as the Release workflow names it. */
const BRANCH = /^ {2}CODESPACES_BRANCH: (\S+)$/m.exec(releaseWorkflow())?.[1];
const LINK = `https://codespaces.new/${REPO}/tree/${BRANCH}?quickstart=1`;
const LINKED = {
  'README.md': 1,
  'README.zh-TW.md': 1,
  'docs/codespaces.md': 1,
  'docs/codespaces.zh-TW.md': 1,
  // The hero's button, the quick start's link and the dialog's button.
  'site/index.html': 3,
  'site/zh-TW/index.html': 3,
} as const;

describe('the Codespaces links', () => {
  it('open the branch the Release workflow moves to each release, and only that', () => {
    expect(BRANCH).toBe('latest-release');
    for (const [path, count] of Object.entries(LINKED)) {
      const text = read(path);
      const links = [...text.matchAll(/https:\/\/codespaces\.new\/[^\s"')]*/g)].map((m) => m[0]);
      expect(links, path).toEqual(Array(count).fill(LINK));
      // And none to `github.com/codespaces/new`, which would open main.
      expect(text, path).not.toContain('github.com/codespaces/new');
    }
  });

  it('say that it is the newest release, in both languages', () => {
    for (const path of ['docs/codespaces.md', 'docs/codespaces.zh-TW.md']) expect(read(path), path).toContain(`\`${BRANCH}\``);
  });
});

const tmp = mkdtempSync(join(tmpdir(), 'relay-codespaces-release-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * A stand-in for `gh`, noting its arguments in `GH_CALLS`: the branch is there when `GH_BRANCH` is
 * `there`, and GitHub moves or makes it when `GH_MOVE` is `ok` (else it refuses, as it can a workflow's
 * token).
 */
const bin = join(tmp, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'gh'),
  `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$*" in
  *"/git/ref/heads/"*) [ "$GH_BRANCH" = there ] && exit 0; echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
  *"--jq .object.sha") [ "$GH_MOVE" = ok ] && { echo "$GITHUB_SHA"; exit 0; }; echo 'gh: refusing to allow a GitHub App to create or update workflow (HTTP 422)' >&2; exit 1 ;;
esac
exit 9
`,
);
chmodSync(join(bin, 'gh'), 0o755);

const SHA = '0123456789abcdef0123456789abcdef01234567';
const TAG = '2026-11-15';

/** The workflow's step, run as the runner runs it, with the stand-in: its output and gh's arguments. */
function point(env: { GH_BRANCH: 'there' | 'missing'; GH_MOVE: 'ok' | 'refused'; PRERELEASE?: string }) {
  const calls = join(mkdtempSync(join(tmp, 'run-')), 'calls');
  writeFileSync(calls, '');
  const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', releaseStep('Point GitHub Codespaces at the release')], {
    encoding: 'utf8',
    timeout: slow(20_000),
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GH_CALLS: calls,
      GH_TOKEN: 'ghs_token',
      GITHUB_REPOSITORY: REPO,
      GITHUB_SHA: SHA,
      CODESPACES_BRANCH: BRANCH!,
      TAG,
      PRERELEASE: env.PRERELEASE ?? 'false',
      GH_BRANCH: env.GH_BRANCH,
      GH_MOVE: env.GH_MOVE,
    },
  });
  return { status: r.status, out: r.stdout, calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
}

const ASK = `api repos/${REPO}/git/ref/heads/latest-release --silent`;
const MOVE = `api -X PATCH repos/${REPO}/git/refs/heads/latest-release -f sha=${SHA} -F force=true --jq .object.sha`;
const MAKE = `api -X POST repos/${REPO}/git/refs -f ref=refs/heads/latest-release -f sha=${SHA} --jq .object.sha`;

// The step's script runs in bash, which the Windows runners do not have as Linux's.
describe.skipIf(process.platform === 'win32')("the Release workflow's Codespaces step, run", { timeout: slow(20_000) }, () => {
  it("moves the branch to the release's commit", () => {
    const r = point({ GH_BRANCH: 'there', GH_MOVE: 'ok' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([ASK, MOVE]);
    expect(r.out).toBe(`GitHub Codespaces opens ${TAG}: latest-release is at ${SHA}.\n`);
  });

  it('makes it there the first time', () => {
    const r = point({ GH_BRANCH: 'missing', GH_MOVE: 'ok' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([ASK, MAKE]);
    expect(r.out).toContain(`latest-release is at ${SHA}.`);
  });

  it('only warns when GitHub refuses it, with what to run by hand', () => {
    for (const [GH_BRANCH, how] of [
      ['there', `gh api -X PATCH repos/${REPO}/git/refs/heads/latest-release -f sha=${SHA} -F force=true`],
      ['missing', `gh api -X POST repos/${REPO}/git/refs -f ref=refs/heads/latest-release -f sha=${SHA}`],
    ] as const) {
      const r = point({ GH_BRANCH, GH_MOVE: 'refused' });
      expect(r.status, GH_BRANCH).toBe(0);
      expect(r.out, GH_BRANCH).toBe(
        `::warning::Could not point latest-release at ${TAG} (gh: refusing to allow a GitHub App to create or update workflow (HTTP 422)): GitHub Codespaces still opens the release before it. By hand: ${how}\n`,
      );
    }
  });

  it('leaves it at the release for a release candidate', () => {
    const r = point({ GH_BRANCH: 'there', GH_MOVE: 'ok', PRERELEASE: 'true' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toBe('A release candidate: GitHub Codespaces keeps opening the newest release.\n');
  });

  it('runs once the release is published, with the token that may write this repository', () => {
    // The release job, the last one, whose token may write this repository's contents.
    const workflow = releaseWorkflow();
    const job = workflow.slice(workflow.indexOf('\n  release:\n') + '\n  release:\n'.length);
    expect(job).not.toMatch(/\n {2}[a-z-]+:\n/);
    expect(job).toContain('\n    permissions:\n      contents: write\n');
    const step = job.indexOf('- name: Point GitHub Codespaces at the release\n');
    expect(step).toBeGreaterThan(job.indexOf('- name: Publish\n'));
    expect(job.indexOf('- name: Publish\n')).toBeGreaterThan(0);
    expect(job.slice(step, job.indexOf('\n      - name:', step + 1))).toContain('GH_TOKEN: ${{ github.token }}');
  });
});
