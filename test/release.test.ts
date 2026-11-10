import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkRelease,
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
    expect(ok('2026-11-10')).toEqual({ version: '2026-11-10', date: '2026-11-10', rc: false, patch: 0 });
    expect(ok('2026-11-10.1')).toEqual({ version: '2026-11-10.1', date: '2026-11-10', rc: false, patch: 1 });
    expect(ok('2026-11-10.12')).toMatchObject({ patch: 12 });
    expect(ok('2026-11-10-rc')).toEqual({ version: '2026-11-10-rc', date: '2026-11-10', rc: true, patch: 0 });
    expect(ok('2026-11-10-rc.3')).toEqual({ version: '2026-11-10-rc.3', date: '2026-11-10', rc: true, patch: 3 });
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
    expect(error('2026-11-10.1-rc')).toMatch(/"-rc" comes before the patch number/);
    expect(error('2026-11-10-rc1')).toMatch(/dot between "-rc" and the patch number/);
    expect(error('2026-11-10-rc-1')).toMatch(/dot between/);
    expect(error('2026-11-10.0')).toMatch(/Patches start at \.1/);
    expect(error('2026-11-10-rc.0')).toMatch(/Patches start at \.1: the release candidate/);
    expect(error('2026-11-10.01')).toMatch(/without leading zeros: \.1, not \.01/);
    expect(error('2026-1-5')).toMatch(/two digits/);
    expect(error('2026-11-5-rc')).toMatch(/two digits/);
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
    for (const v of ['26-11-10', '2026/11/10', '20261110', '2026-11-10-beta', '2026-11-10-rc.', '2026-11-10.', '2026-11-10.1.2', '2026-11-10-rc.1.1', '2026-11-10rc', 'latest', '2026-11-10-rc.a']) {
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
      release: { version: '2026-11-10-rc', date: '2026-11-10', rc: true, patch: 0 },
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
    expect(errors('2026-11-10-rc.1')).toMatch(/is a patch, but there is no release candidate today to patch yet: release 2026-11-10-rc first/);
    expect(errors('2026-11-10.1')).toMatch(/no release today to patch yet: release 2026-11-10 first/);
  });

  it('keeps releases and release candidates apart', () => {
    const tags = ['2026-11-10-rc', '2026-11-10-rc.1'];
    expect(check('2026-11-10', tags).ok).toBe(true);
    expect(errors('2026-11-10.1', tags)).toMatch(/release 2026-11-10 first/);
    expect(check('2026-11-10.1', [...tags, '2026-11-10']).ok).toBe(true);
    expect(check('2026-11-10-rc.2', [...tags, '2026-11-10', '2026-11-10.1']).ok).toBe(true);
  });

  it("ignores other days' versions and tags that are not versions", () => {
    const tags = ['v0.1.0', '2026-11-09-rc', '2026-11-09-rc.1', '2026-11-09', 'nightly', '2026-11-10-rc.x', '2026-02-30'];
    expect(check('2026-11-10-rc', tags).ok).toBe(true);
    expect(nextVersion(tags, '2026-11-09', true)).toBe('2026-11-09-rc.2');
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
  /** Precedence for the semver our versions map to: X.Y.Z with an optional -rc or -rc.N. */
  const compare = (a: string, b: string) => {
    const split = (s: string) => {
      const [core, pre] = s.split('-');
      return { nums: core!.split('.').map(Number), pre };
    };
    const x = split(a);
    const y = split(b);
    for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
    if (x.pre === y.pre) return 0;
    if (x.pre === undefined) return 1; // a release comes after its pre-releases
    if (y.pre === undefined) return -1;
    return Number(x.pre.split('.')[1] ?? 0) - Number(y.pre.split('.')[1] ?? 0);
  };
  const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

  it('is valid semver, below Windows’ limit of 65535 per number', () => {
    for (const v of ['2026-01-01', '2026-01-01-rc', '2026-01-01-rc.1', '2026-12-31.9', '2099-12-31-rc.40']) {
      const s = semverOf(ok(v));
      expect(s, v).toMatch(SEMVER);
      for (const n of s.split('-')[0]!.split('.')) expect(Number(n)).toBeLessThan(65536);
    }
    expect(semverOf(ok('2026-01-05'))).toBe('2026.105.0');
    expect(semverOf(ok('2026-11-10.2'))).toBe('2026.1110.2');
    expect(semverOf(ok('2026-11-10-rc.2'))).toBe('2026.1110.0-rc.2');
  });

  it('sorts as the releases were made', () => {
    const inOrder = ['2026-01-31', '2026-02-01-rc', '2026-02-01-rc.1', '2026-02-01-rc.10', '2026-02-01', '2026-02-01.1', '2026-02-01.2', '2026-10-09', '2026-11-10-rc', '2027-01-01-rc'];
    const semvers = inOrder.map((v) => semverOf(ok(v) as ReleaseVersion));
    expect([...semvers].sort(compare)).toEqual(semvers);
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
    expect(run(['check', `${today}-rc`]).code).toBe(0);
    const yesterday = todayIn('Asia/Taipei', new Date(Date.now() - 36 * 3600_000));
    const r = run(['check', `${yesterday}-rc`]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${yesterday} is not today`);
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

  it('prints the next versions for today', () => {
    const r = run(['next', '--today', '2026-11-10']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('release candidate  2026-11-10-rc.1');
    expect(r.out).toContain('release            2026-11-10\n');
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
    const r = run(['next'], { RELEASE_TIME_ZONE: 'Pacific/Kiritimati' });
    expect(r.out).toContain(`Today (${todayIn('Pacific/Kiritimati')}, Pacific/Kiritimati)`);
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

  it('builds for macOS, Windows and Linux, and publishes only when all three are built', () => {
    const build = job('build');
    for (const [os, target] of [
      ['macos-latest', '--mac dmg'],
      ['windows-latest', '--win nsis'],
      ['ubuntu-latest', '--linux AppImage'],
    ]) {
      expect(build).toMatch(new RegExp(`os: ${os}\\n(?:\\s+#.*\\n)*\\s+target: ${target}`));
    }
    expect(build).toMatch(/fail-fast: true/);
    // The Mac app is universal, with the keyring module's Intel part added before the app is built.
    expect(build).toMatch(/target: --mac dmg --universal/);
    const intel = build.indexOf('- name: Add the keyring module for Intel Macs');
    expect(intel).toBeGreaterThan(build.indexOf('run: npm ci\n'));
    expect(intel).toBeLessThan(build.indexOf('run: npm --prefix desktop run build'));
    expect(build.slice(intel, intel + 400)).toContain("if: runner.os == 'macOS'");
    const both = build.indexOf('- name: Check that the Mac app has the keyring module for both processors');
    expect(both).toBeGreaterThan(build.indexOf('run: npm --prefix desktop run build'));
    expect(build.slice(both, both + 400)).toContain('keyring-darwin-x64');
    // The bundled server is tried on each system before its installer is made.
    expect(build.indexOf('run: npx tsx desktop/scripts/smoke.ts')).toBeGreaterThan(build.indexOf('run: npm --prefix desktop run build'));
    expect(build.indexOf('run: npx tsx desktop/scripts/smoke.ts')).toBeLessThan(build.indexOf('- name: Make the installer'));
    expect(build).toMatch(/needs: check/);
    expect(job('release')).toMatch(/needs: \[check, build\]/);
    // One installer of each kind goes up, named after the version.
    expect(build).toContain("-c.artifactName='Harness-Relay-${env.RELAY_VERSION}-${os}-${arch}.${ext}'");
    expect(build).toContain('RELAY_VERSION: ${{ needs.check.outputs.tag }}');
    for (const ext of ['dmg', 'exe', 'AppImage']) {
      expect(build).toContain(`desktop/release/Harness-Relay-*.${ext}`);
      expect(job('release')).toContain(`for ext in dmg exe AppImage`);
    }
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
    expect(publish).toContain('--target "$GITHUB_SHA"');
    expect(publish).toContain('gh release create "$TAG"');
  });
});
