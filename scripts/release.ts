/**
 * The rules for a release's version (`npm run release:next`, `npm run release:check`, and the Release
 * workflow, .github/workflows/release.yml), and the list of changes in its notes (`npm run
 * release:notes`, and the same workflow).
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
 *   tsx scripts/release.ts notes <version> [--target <commit>] [--remote]
 *
 * `--remote` reads the tags from origin (`git ls-remote`) instead of the local repository, and
 * `--today` checks against a given day (the workflow's publish step re-checks against the day it
 * started). `check` also says which version the release's notes start from (previousVersion()). In
 * GitHub Actions, it refuses a run on another branch than main and writes the version's tag, title,
 * semver, whether it is a pre-release and the version its notes start from to $GITHUB_OUTPUT.
 *
 * `notes` prints the part of a release's notes that lists its changes (releaseChanges()): every
 * commit that came into main since the version its notes start from, up to `--target` (the commit the
 * release is made on; the version's own tag by default, for a release that is out), whether pushed to
 * main or merged from a pull request, as GitHub's comparison of the two lists them (through `gh api`,
 * in the repository GITHUB_REPOSITORY names, else origin's).
 *
 * Only erasable TypeScript here: the workflow runs it with plain `node`.
 */
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

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

/**
 * The version a release's notes start from (the changes listed are those since it): for a release,
 * the newest release before it, so that they hold everything since that release, its release
 * candidates' changes included; for a release candidate, the newest version before it of either kind,
 * release or release candidate. None when there is no such version.
 */
export function previousVersion(tags: readonly string[], v: ReleaseVersion): string | undefined {
  const own = semverOf(v);
  const before = releasedVersions(tags).filter((t) => (v.rc || !t.rc) && compareSemver(semverOf(t), own) < 0);
  before.sort((a, b) => compareSemver(semverOf(b), semverOf(a)));
  return before[0]?.version;
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
  | {
      ok: true;
      release: ReleaseVersion;
      tag: string;
      title: string;
      prerelease: boolean;
      semver: string;
      /** The version its notes start from (previousVersion()); none when there is no earlier one. */
      previous: string | undefined;
    }
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
  return {
    ok: true,
    release: v,
    tag: v.version,
    title: `Harness Relay ${v.version}`,
    prerelease: v.rc,
    semver: semverOf(v),
    previous: previousVersion(c.tags, v),
  };
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

/** A commit as GitHub's REST API gives it, with the fields the notes use. */
export interface ApiCommit {
  sha: string;
  parents: readonly { sha: string }[];
  /** The GitHub account of the commit's author; null when its address belongs to none. */
  author: { login: string } | null;
  commit: { message: string; author: { name: string; email?: string } | null };
}

/** One line of a release's notes: a pull request merged into main, or a commit pushed to it. */
export interface Change {
  title: string;
  /** The author's GitHub account, when GitHub knows it. */
  login?: string;
  /** The author's name in git, for an author without one. */
  name: string;
  /** The author's address in git, when it is that account's: GitHub finds a bot's commits by it alone. */
  email?: string;
  /** The pull request, or the commit. */
  url: string;
}

/** A pull request: its number, its title, and who opened it. */
export interface Pull {
  number: number;
  title: string;
  author?: string;
}

/** The pull request a commit merged into main (GitHub's record of that pull request's merge commit), if any. */
export type PullOf = (sha: string) => Pull | undefined;

/** GitHub's own merge commit of a pull request: its body holds the pull request's title. */
const MERGED_PULL = /^Merge pull request #(\d+) from \S/;

/**
 * The lines of a release's notes for the commits that came into main, oldest first, one for each
 * commit: its subject, linked to the pull request it merged (squashed, rebased or fast-forwarded:
 * the subject without the " (#N)" GitHub ends a squash's with), by whoever opened that pull request;
 * or else linked to the commit itself, by its author. A merge commit in git's words ("Merge pull
 * request …", "Merge branch …", "Merge main into …") says nothing of its own: one that merged a pull
 * request is listed as that pull request's title; any other has no line, since the commits it
 * brought in have theirs.
 */
export function changesOf(commits: readonly ApiCommit[], repo: string, pullOf: PullOf): Change[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const site = `https://github.com/${repo}`;
  /** Credited to `login` when given (a pull request's author), else to the commit's author. */
  const by = (c: ApiCommit, login?: string) => {
    const own = c.author?.login || undefined;
    const email = c.commit.author?.email?.trim() || undefined;
    return {
      login: login || own,
      name: c.commit.author?.name?.trim() || login || own || c.sha.slice(0, 7),
      email: !login || login === own ? email : undefined,
    };
  };
  return commits.flatMap((c): Change[] => {
    const [first = '', ...body] = c.commit.message.split('\n');
    const subject = first.trim();
    const pull = pullOf(c.sha);
    if (c.parents.length > 1 && /^Merge\s/.test(subject)) {
      const own = MERGED_PULL.exec(subject);
      const merged = pull ?? (own ? { number: Number(own[1]), title: body.map((l) => l.trim()).find(Boolean) ?? subject } : undefined);
      if (!merged) return [];
      // Without GitHub's record of who opened it, the author of the branch it merged.
      const tip = bySha.get(c.parents[c.parents.length - 1]!.sha) ?? c;
      return [{ title: merged.title.trim() || subject, ...by(tip, merged.author), url: `${site}/pull/${merged.number}` }];
    }
    if (pull) {
      const title = subject.endsWith(`(#${pull.number})`) ? subject.slice(0, -`(#${pull.number})`.length).trim() : subject;
      return [{ title: title || pull.title.trim() || subject, ...by(c, pull.author), url: `${site}/pull/${pull.number}` }];
    }
    return [{ title: subject || c.sha.slice(0, 7), ...by(c), url: `${site}/commit/${c.sha}` }];
  });
}

/** GitHub's REST API: the parsed answer for a path such as `repos/<owner>/<name>/commits`. */
export type GitHubApi = (path: string) => unknown;

const PAGE = 100;

/** How many requests to GitHub run at once. */
const AT_ONCE = 8;

/** `fn` for each item, `limit` at a time, the results in the items' order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => R | Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The commits that came into `target` since `since` (`git log since..target`: pushed to main or
 * merged from a pull request, the commits a merge brought in included), oldest first, as GitHub's
 * comparison of the two lists them; without `since`, every commit of `target`'s history. GitHub
 * lists them a page at a time; fewer than it counts is an error, never a shorter list.
 */
export async function commitsSince(api: GitHubApi, repo: string, since: string | undefined, target: string): Promise<ApiCommit[]> {
  const out: ApiCommit[] = [];
  const at = encodeURIComponent(target);
  if (since) {
    for (let page = 1; ; page++) {
      const r = (await api(`repos/${repo}/compare/${encodeURIComponent(since)}...${at}?per_page=${PAGE}&page=${page}`)) as {
        total_commits: number;
        commits: ApiCommit[];
      };
      out.push(...r.commits);
      if (out.length >= r.total_commits) return out;
      if (r.commits.length === 0) throw new Error(`GitHub listed ${out.length} of the ${r.total_commits} commits from ${since} to ${target}.`);
    }
  }
  for (let page = 1; ; page++) {
    const r = (await api(`repos/${repo}/commits?sha=${at}&per_page=${PAGE}&page=${page}`)) as ApiCommit[];
    out.push(...r);
    if (r.length < PAGE) return out.reverse();
  }
}

/** The pull request GitHub records `sha` as the merge commit of, if any (not one it is merely part of). */
export async function pullMergedBy(api: GitHubApi, repo: string, sha: string): Promise<Pull | undefined> {
  const pulls = (await api(`repos/${repo}/commits/${encodeURIComponent(sha)}/pulls?per_page=100`)) as {
    number: number;
    title: string;
    merged_at: string | null;
    merge_commit_sha: string | null;
    user: { login: string } | null;
  }[];
  const p = pulls.find((p) => p.merged_at && p.merge_commit_sha === sha);
  return p && { number: p.number, title: p.title, author: p.user?.login || undefined };
}

/**
 * The authors of these changes who had no commit before `since`, each with their first pull request
 * here (else their first change), in the order they first appear; without `since` the changes start at the repository's first commit, so
 * every author with a GitHub account is new. An author counts as having one when GitHub finds a
 * commit before `since` by their account or by an address of theirs in these changes: it never finds
 * a bot's (`…[bot]`) by its account.
 */
export async function newContributors(api: GitHubApi, repo: string, since: string | undefined, changes: readonly Change[]): Promise<Change[]> {
  const first = new Map<string, Change>();
  const emails = new Map<string, Set<string>>();
  const isPull = (c: Change) => /\/pull\/\d+$/.test(c.url);
  for (const c of changes) {
    if (!c.login) continue;
    const had = first.get(c.login);
    // Their first pull request, as GitHub's notes name it, else their first change.
    if (!had || (!isPull(had) && isPull(c))) first.set(c.login, c);
    if (c.email) emails.set(c.login, (emails.get(c.login) ?? new Set()).add(c.email));
  }
  const order = new Map([...first.keys()].map((login) => [login, changes.findIndex((c) => c.login === login)]));
  const logins = [...first.keys()].sort((a, b) => order.get(a)! - order.get(b)!);
  if (!since) return logins.map((l) => first.get(l)!);
  const before = async (author: string) =>
    ((await api(`repos/${repo}/commits?sha=${encodeURIComponent(since)}&author=${encodeURIComponent(author)}&per_page=1`)) as unknown[]).length > 0;
  const isNew = await mapLimit(logins, AT_ONCE, async (login) => {
    for (const author of [login, ...(emails.get(login) ?? [])]) if (await before(author)) return false;
    return true;
  });
  return logins.filter((_, i) => isNew[i]).map((l) => first.get(l)!);
}

/** An account as GitHub's notes name it: a bot without its `[bot]`. */
function mention(login: string): string {
  return `@${login.replace(/\[bot\]$/, '')}`;
}

/**
 * A commit's subject as one line of Markdown inside a list item: a leading `#`, `>`, `-`, `+`, `*` or
 * `1.` that would make it a heading, a quote or a list escaped, and each `@name` outside code put in
 * code, so that the notes notify nobody a subject merely names (the authors are named by the notes).
 */
export function subjectMarkdown(subject: string): string {
  const escaped = subject.replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2').replace(/^(#{1,6}(?=\s|$)|>|[-+*](?=\s|$))/, '\\$1');
  return escaped
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : codeMentions(part)))
    .join('');
}

/**
 * Each `@name` put in code, so that GitHub links and notifies nobody: wherever GitHub would take it for
 * one (after anything but a letter, a digit or a backtick, `_@name_` and `a/@name` too), but not an
 * address (`dev@example.com`).
 */
function codeMentions(text: string): string {
  return text.replace(/(^|[^A-Za-z0-9`])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[\w.-]+)?)/g, '$1`@$2`');
}

/**
 * Below GitHub's limit for a release's notes (125,000 characters), with room for the install notes
 * before the changes.
 */
export const CHANGES_LIMIT = 100_000;

/**
 * The part of a release's notes that lists its changes, in the form GitHub's own notes take: What's
 * Changed (none without changes), New Contributors (when there are), and the Full Changelog link to
 * the comparison the list is made from. A list longer than `limit` characters ends with how many more
 * changes there are, linked to the history up to the tag (GitHub's comparison page shows 250 commits
 * at most), rather than make notes GitHub would refuse.
 */
export function changesMarkdown(n: {
  repo: string;
  tag: string;
  since: string | undefined;
  changes: readonly Change[];
  newContributors: readonly Change[];
  limit?: number;
}): string {
  const site = `https://github.com/${n.repo}`;
  const tail: string[] = [];
  if (n.newContributors.length) {
    tail.push('## New Contributors', ...n.newContributors.map((c) => `* ${mention(c.login!)} made their first contribution in ${c.url}`), '');
  }
  tail.push(`**Full Changelog**: ${n.since ? `${site}/compare/${n.since}...${n.tag}` : `${site}/commits/${n.tag}`}`);
  const items = n.changes.map((c) => `* ${subjectMarkdown(c.title)} by ${c.login ? mention(c.login) : codeMentions(c.name)} in ${c.url}`);
  if (items.length) {
    const size = (lines: readonly string[]) => lines.reduce((sum, l) => sum + l.length + 1, 0);
    const moreLine = (more: number) => `* … and ${more} more change${more === 1 ? '' : 's'}, in the history up to ${n.tag}: ${site}/commits/${n.tag}`;
    const limit = n.limit ?? CHANGES_LIMIT;
    const whole = `${["## What's Changed", ...items, '', ...tail].join('\n')}\n`;
    if (whole.length <= limit) return whole;
    // Too long: as many as fit with the line that says how many more there are.
    let budget = limit - size(tail) - size(["## What's Changed", '', moreLine(items.length)]);
    let shown = 0;
    while (shown < items.length && budget - (items[shown]!.length + 1) >= 0) budget -= items[shown++]!.length + 1;
    return `${["## What's Changed", ...items.slice(0, shown), moreLine(items.length - shown), '', ...tail].join('\n')}\n`;
  }
  return `${tail.join('\n')}\n`;
}

/** A release's list of changes: every commit into `target` since `since`, read from GitHub. */
export async function releaseChanges(o: {
  api: GitHubApi;
  repo: string;
  tag: string;
  since: string | undefined;
  target: string;
}): Promise<{ markdown: string; changes: Change[] }> {
  const commits = await commitsSince(o.api, o.repo, o.since, o.target);
  const pulls = await mapLimit(commits, AT_ONCE, (c) => pullMergedBy(o.api, o.repo, c.sha));
  const bySha = new Map(commits.map((c, i) => [c.sha, pulls[i]]));
  const changes = changesOf(commits, o.repo, (sha) => bySha.get(sha));
  const markdown = changesMarkdown({ repo: o.repo, tag: o.tag, since: o.since, changes, newContributors: await newContributors(o.api, o.repo, o.since, changes) });
  return { markdown, changes };
}

/** Whether `gh api` failed with Not Found on the list of commits itself: GitHub does not know where it ends. */
export function notFoundTarget(message: string): boolean {
  return /^gh api repos\/[^/\s]+\/[^/\s]+\/(compare\/|commits\?)\S*: .*\(HTTP 404\)/.test(message);
}

/** `owner/name` from a GitHub remote's URL (HTTPS or SSH), if it is one. */
export function repoOfRemote(url: string): string | undefined {
  return /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

const execFileAsync = promisify(execFile);

/** GitHub's REST API through `gh api` (signed in as gh is, or with GH_TOKEN). */
const ghApi: GitHubApi = async (path) => {
  try {
    const { stdout } = await execFileAsync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`gh api ${path}: ${err.stderr?.trim() || err.message}`);
  }
};

function readTags(remote: boolean): string[] {
  if (remote) return tagsFromLsRemote(execFileSync('git', ['ls-remote', '--tags', 'origin'], { encoding: 'utf8' }));
  return execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).split('\n').map((t) => t.trim()).filter(Boolean);
}

async function main(argv: string[]): Promise<number> {
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
  if ((command !== 'check' && command !== 'notes') || rest.length === 0 || rest[0]!.startsWith('--')) {
    console.error('Usage: tsx scripts/release.ts next | check <version> [--remote] [--today YYYY-MM-DD] | notes <version> [--target <commit>] [--remote]');
    return 2;
  }
  if (command === 'notes') {
    const parsed = parseVersion(rest[0]!);
    if (!parsed.ok) {
      console.error(`✗ ${parsed.error}`);
      return 1;
    }
    const target = option('--target');
    if (flag('--target') && (!target || target.startsWith('--'))) {
      console.error('--target takes the commit the release is made on (a SHA, a tag or a branch).');
      return 2;
    }
    const repo = process.env.GITHUB_REPOSITORY?.trim() || repoOfRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }));
    if (!repo) {
      console.error('origin is not a GitHub repository: set GITHUB_REPOSITORY to owner/name.');
      return 2;
    }
    const tag = parsed.value.version;
    const since = previousVersion(tags, parsed.value);
    try {
      const { markdown, changes } = await releaseChanges({ api: ghApi, repo, tag, since, target: target ?? tag });
      process.stdout.write(markdown);
      console.error(`${changes.length} change${changes.length === 1 ? '' : 's'} ${since ? `since ${since}` : 'since the first commit'}, up to ${target ?? tag}.`);
      return 0;
    } catch (e) {
      const message = (e as Error).message;
      console.error(`✗ ${message}`);
      // Not Found from the list of commits: GitHub does not know where the list ends.
      if (notFoundTarget(message)) {
        console.error(
          target
            ? `  GitHub must know ${target}: a commit's SHA, a tag or a branch on GitHub (main, not origin/main).`
            : `  ${tag} has no tag on GitHub yet: give the commit it will be made on with --target <commit>.`,
        );
      }
      return 1;
    }
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
    previous: result.previous ?? '',
  };
  console.log(`✓ ${result.tag} may be released (${result.prerelease ? 'a release candidate, published as a pre-release' : 'a release'}; app version ${result.semver}).`);
  console.log(
    result.previous
      ? `  Its notes list the changes since ${result.previous}${result.prerelease ? '' : ', the release before it'}.`
      : `  There is no ${result.prerelease ? 'version' : 'release'} before it: its notes list every commit up to it.`,
  );
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(''));
  return 0;
}

// No top-level await: the desktop app bundles this file as CommonJS (desktop/src/update.ts). And
// process.exitCode rather than process.exit(), which could cut off output still on its way to a pipe.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    },
  );
}
