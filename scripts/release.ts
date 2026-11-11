/**
 * The rules for a release's version (`npm run release:next`, `npm run release:check`, and the Release
 * workflow, .github/workflows/release.yml).
 *
 * A version is the date the release is made, in RELEASE_TIME_ZONE:
 *
 *   YYYY-MM-DD        a release                    YYYY-MM-DD.N        its Nth patch, made the same day
 *   YYYY-MM-DD-rc     a release candidate of it    YYYY-MM-DD.N-rc     a release candidate of its Nth patch
 *   YYYY-MM-DD-rc.M   the candidate's Mth patch    YYYY-MM-DD.N-rc.M   that candidate's Mth patch
 *
 * Patches count up from .1 without gaps: a release's patches, and each release candidate's own. The
 * git tag is the version itself. A version must be today's date: a fix on a later day is that day's
 * release. A release candidate comes before the release it is a candidate of (and is optional): it
 * is for the day's next release only, the release itself or its next patch.
 *
 * Usage:
 *   tsx scripts/release.ts next                       today's next release and release candidate
 *   tsx scripts/release.ts check <version> [--remote] [--today YYYY-MM-DD]
 *
 * `--remote` reads the tags from origin (`git ls-remote`) instead of the local repository, and
 * `--today` checks against a given day (the workflow's publish step re-checks against the day it
 * started). In GitHub Actions, `check` refuses a run on another branch than main and writes the
 * version's tag, title, semver and whether it is a pre-release to $GITHUB_OUTPUT.
 *
 * Only erasable TypeScript here: the workflow runs it with plain `node`.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The day of a release is the day in Taiwan, where the maintainers are. */
export const RELEASE_TIME_ZONE = 'Asia/Taipei';

export interface ReleaseVersion {
  /** As written, such as 2026-11-10.1-rc.2. It is also the tag. */
  version: string;
  /** YYYY-MM-DD */
  date: string;
  /** The release, or the one a release candidate comes before: 0 for the day's release, N for its Nth patch. */
  patch: number;
  /** A release candidate. */
  rc: boolean;
  /** A release candidate's own patch: 0 for the candidate itself (and for a release), M for its Mth patch. */
  rcPatch: number;
}

export type Parsed = { ok: true; value: ReleaseVersion } | { ok: false; error: string };

export const RULES =
  'YYYY-MM-DD for a release and .1, .2, … after it for the same day’s patches (2026-11-10, 2026-11-10.1), each with -rc after it for a release candidate of it and .1, .2, … after that for the candidate’s patches (2026-11-10-rc, 2026-11-10-rc.1, 2026-11-10.1-rc)';

const VERSION = /^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?(?:(-rc)(?:\.(\d+))?)?$/;

/** Whether YYYY-MM-DD is a day of the calendar. */
function realDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Reads a version, saying as precisely as it can what is wrong with one that breaks the rules. */
export function parseVersion(input: string): Parsed {
  const v = input.trim();
  const fail = (error: string): Parsed => ({ ok: false, error });
  if (!v) return fail(`No version given. Use ${RULES}.`);
  if (/[^\x21-\x7e]/.test(v)) {
    return fail(
      /\s/.test(v)
        ? `"${v}" has spaces in it. Use ${RULES}.`
        : `"${v}" has a character that is not plain ASCII (a full-width digit, or a typographic dash such as – or —?). Type it with the digits 0–9 and "-".`,
    );
  }
  if (/^v\d/i.test(v)) return fail(`Drop the "${v[0]}": the version is the date itself, such as ${v.slice(1)}.`);
  if (/-rc/i.test(v) && !v.includes('-rc')) return fail(`Write "-rc" in lower case: ${v.replace(/-rc/i, '-rc')}.`);
  const m = VERSION.exec(v);
  if (!m) {
    if (/^\d{4}-\d{1,2}-\d{1,2}(?:\.\d+)?(?:-rc(?:\.\d+)?)?$/.test(v)) return fail(`Write the month and the day with two digits each: YYYY-MM-DD, such as 2026-01-05.`);
    if (/-rc\d/.test(v) || /-rc-\d/.test(v)) return fail(`Put a dot between "-rc" and the patch number: YYYY-MM-DD-rc.N.`);
    return fail(`"${v}" does not follow the rules: ${RULES}.`);
  }
  const [, y, mo, d, patch, rc, rcPatch] = m;
  if (!realDate(Number(y), Number(mo), Number(d))) return fail(`${y}-${mo}-${d} is not a day of the calendar.`);
  for (const [n, what] of [
    [patch, 'release'],
    [rcPatch, 'release candidate'],
  ] as const) {
    if (n === undefined) continue;
    if (/^0+$/.test(n)) return fail(`Patches start at .1: the ${what} itself has no number.`);
    if (n.startsWith('0')) return fail(`Write the patch number without leading zeros: .${Number(n)}, not .${n}.`);
  }
  const value = { version: v, date: `${y}-${mo}-${d}`, patch: Number(patch ?? 0), rc: !!rc, rcPatch: Number(rcPatch ?? 0) };
  return { ok: true, value };
}

/** The day `now` is in `timeZone`, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The released versions among git tags (anything else is left out). */
export function releasedVersions(tags: readonly string[]): ReleaseVersion[] {
  return tags.map((t) => (VERSION.test(t) ? parseVersion(t) : undefined)).flatMap((p) => (p?.ok ? [p.value] : []));
}

/** The day's next release: 0 when none is out yet, else the number of its next patch. */
export function nextPatch(tags: readonly string[], date: string): number {
  const made = releasedVersions(tags).filter((v) => v.date === date && !v.rc);
  return made.length === 0 ? 0 : Math.max(...made.map((v) => v.patch)) + 1;
}

/** A day's release (patch 0) or its patch, as written. */
function releaseName(date: string, patch: number): string {
  return patch ? `${date}.${patch}` : date;
}

/**
 * The version a day's next release must have, or its next release candidate: one of that next
 * release (the day's release itself, or its next patch once it is out).
 */
export function nextVersion(tags: readonly string[], date: string, rc: boolean): string {
  const patch = nextPatch(tags, date);
  const release = releaseName(date, patch);
  if (!rc) return release;
  const made = releasedVersions(tags).filter((v) => v.date === date && v.rc && v.patch === patch);
  if (made.length === 0) return `${release}-rc`;
  return `${release}-rc.${Math.max(...made.map((v) => v.rcPatch)) + 1}`;
}

/** The year, then the month and day as one number (1110 for November 10). */
function semverCore(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${y}.${m! * 100 + d!}`;
}

/**
 * The version as semver, which electron-builder and the operating systems need: the year, then the
 * month and day as one number (1110 for November 10), then the patch; a release candidate is a
 * pre-release of the release it comes before (2026-11-10.1-rc.2 is 2026.1110.1-rc.2, after
 * 2026.1110.0 and before 2026.1110.1). Each number stays below 65536, as Windows requires, and later
 * dates and patches sort later.
 */
export function semverOf(v: ReleaseVersion): string {
  const release = `${semverCore(v.date)}.${v.patch}`;
  if (!v.rc) return release;
  return `${release}-rc${v.rcPatch ? `.${v.rcPatch}` : ''}`;
}

/**
 * A build that is not a release (`npm run desktop`, `npm run desktop:dist`): shown as the day it was
 * built with `-dev`, and the commit when known (2026-11-10-dev (30f3d4f)); as semver, a pre-release
 * of that day that sorts before its release candidates (`dev` < `rc`), so that any release of that
 * day or later counts as newer.
 */
export function devVersion(date: string, commit?: string): { shown: string; semver: string } {
  return { shown: `${date}-dev${commit ? ` (${commit})` : ''}`, semver: `${semverCore(date)}.0-dev` };
}

/**
 * Semver precedence (semver.org, section 11), for the versions above: below zero when `a` comes
 * before `b`, above zero after, zero when they are the same. Build metadata (`+…`) is ignored.
 */
export function compareSemver(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', ...pre] = v.split('+')[0]!.split('-');
    return { nums: core.split('.').map(Number), pre: pre.length ? pre.join('-').split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  // A pre-release comes before the version itself.
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d) return Math.sign(d);
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export interface ReleaseCheck {
  /** What was typed in. */
  version: string;
  /** Today, YYYY-MM-DD, in RELEASE_TIME_ZONE. */
  today: string;
  /** The repository's tags. */
  tags: readonly string[];
  /** The branch the release is made from (GITHUB_REF), when known. */
  ref?: string;
  timeZone?: string;
}

export type CheckResult =
  | { ok: true; release: ReleaseVersion; tag: string; title: string; prerelease: boolean; semver: string }
  | { ok: false; errors: string[] };

/** Everything wrong with releasing `version` now; nothing when it may be released. */
export function checkRelease(c: ReleaseCheck): CheckResult {
  const errors: string[] = [];
  const zone = c.timeZone ?? RELEASE_TIME_ZONE;
  const nextOnes = `next release candidate is ${nextVersion(c.tags, c.today, true)}, and its next release ${nextVersion(c.tags, c.today, false)}`;
  const hint = `Today's ${nextOnes}.`;
  if (c.ref !== undefined && c.ref !== 'refs/heads/main') {
    errors.push(`Releases are made from main, and this run is on ${c.ref.replace(/^refs\/heads\//, '')}. Choose main under "Use workflow from".`);
  }
  const parsed = parseVersion(c.version);
  if (!parsed.ok) return { ok: false, errors: [...errors, parsed.error, hint] };
  const v = parsed.value;
  if (v.date !== c.today) {
    errors.push(`${v.date} is not today: today is ${c.today} (${zone}). A version is the day it is released. ${hint}`);
  } else {
    const expected = nextVersion(c.tags, v.date, v.rc);
    const patch = nextPatch(c.tags, v.date);
    const target = releaseName(v.date, v.patch);
    if (releasedVersions(c.tags).some((t) => t.version === v.version)) {
      errors.push(`${v.version} has already been released. The next one is ${expected}.`);
    } else if (v.rc && v.patch < patch) {
      // It would sort before the release it is a candidate of, and so before the newest release.
      errors.push(`${v.version} is a release candidate of ${target}, which is out already: today's ${nextOnes}.`);
    } else if (v.rc && v.patch > patch) {
      errors.push(`${v.version} is a release candidate of ${target}, but today's next release is ${releaseName(v.date, patch)}: its next release candidate is ${expected}.`);
    } else if (v.version !== expected) {
      const first = v.rc ? `${target}-rc` : v.date;
      errors.push(
        expected === first
          ? `${v.version} is a patch, but there is no ${v.rc ? `release candidate of ${target}` : 'release today'} to patch yet: release ${expected} first.`
          : `${v.version} skips a number: patches count up by one, so the next is ${expected}.`,
      );
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, release: v, tag: v.version, title: `Harness Relay ${v.version}`, prerelease: v.rc, semver: semverOf(v) };
}

/**
 * A message as the data of a GitHub Actions command (`::error::…`): `%`, CR and LF escaped, so that
 * what was typed in cannot start a command of its own on a new line.
 */
export function actionsData(message: string): string {
  return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Whether `--today` is a day of the calendar, YYYY-MM-DD. */
export function validDay(day: string | undefined): day is string {
  const m = day === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return !!m && realDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Tag names from `git ls-remote --tags` output (peeled `^{}` lines are the same tags). */
export function tagsFromLsRemote(output: string): string[] {
  const names = output
    .split('\n')
    .map((line) => /\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim())?.[1])
    .filter((t): t is string => !!t);
  return [...new Set(names)];
}

function readTags(remote: boolean): string[] {
  if (remote) return tagsFromLsRemote(execFileSync('git', ['ls-remote', '--tags', 'origin'], { encoding: 'utf8' }));
  return execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).split('\n').map((t) => t.trim()).filter(Boolean);
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const flag = (name: string) => rest.includes(name);
  const option = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const zone = process.env.RELEASE_TIME_ZONE?.trim() || RELEASE_TIME_ZONE;
  const todayOption = option('--today');
  if (flag('--today') && !validDay(todayOption)) {
    console.error(`--today takes a day of the calendar, YYYY-MM-DD; got ${todayOption === undefined ? 'nothing' : `"${todayOption}"`}.`);
    return 2;
  }
  const today = todayOption ?? todayIn(zone);
  const tags = readTags(flag('--remote'));

  if (command === 'next') {
    console.log(`Today (${today}, ${zone}):`);
    console.log(`  release candidate  ${nextVersion(tags, today, true)}`);
    console.log(`  release            ${nextVersion(tags, today, false)}`);
    return 0;
  }
  if (command !== 'check' || rest.length === 0 || rest[0]!.startsWith('--')) {
    console.error('Usage: tsx scripts/release.ts next | check <version> [--remote] [--today YYYY-MM-DD]');
    return 2;
  }
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const result = checkRelease({
    version: rest[0]!,
    today,
    tags,
    ref: inActions ? process.env.GITHUB_REF : undefined,
    timeZone: zone,
  });
  if (!result.ok) {
    for (const e of result.errors) console.error(inActions ? `::error title=Release version::${actionsData(e)}` : `✗ ${e}`);
    return 1;
  }
  const out = {
    tag: result.tag,
    title: result.title,
    prerelease: String(result.prerelease),
    semver: result.semver,
    today,
  };
  console.log(`✓ ${result.tag} may be released (${result.prerelease ? 'a release candidate, published as a pre-release' : 'a release'}; app version ${result.semver}).`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
