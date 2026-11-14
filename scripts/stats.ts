/**
 * Harness Relay's numbers, for its maintainers: `npm run stats` (`npm run stats -- --json` for the same
 * as JSON). Read with your own sign-ins, written nowhere:
 *
 * - The releases' downloads on GitHub, by system, in all and release by release (release candidates
 *   left out), new installs apart from updates. An installer on this repository's releases is a new
 *   install (from the website, its download mirror or the releases page); its copy for the app's
 *   updates, on the copies' repository (the workflow's UPDATES_REPO variable, else UPDATES_REPO in
 *   site/assets/downloads.js), is an installed app updating (desktop/src/update.ts). Through `gh`,
 *   signed in as gh is (or GH_TOKEN), which also reads a private copies' repository. GitHub counts
 *   requests, not downloads: the totals are also given as about how many downloads there were, the new
 *   installs halved (two requests GitHub counts for each), the updates as they are (one).
 * - How many codespaces were made from the README's and the website's links (.devcontainer/count.sh),
 *   in all and on each of the last seven days, as days in Taiwan, from the download mirror's D1 database
 *   (mirror/wrangler.toml). Through wrangler, signed in to the Cloudflare account that has it
 *   (`npx wrangler login`).
 *
 * What GitHub's counts mean is in docs/developer-guide.md, "Download counts".
 */

import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { updateSourceFrom } from '../desktop/src/updateSource.ts';
import { INSTALLERS, REPO, UPDATE_INSTALLERS, UPDATES_REPO, type InstallerSystem } from '../site/assets/downloads.js';
import { RELEASE_TIME_ZONE, compareSemver, parseVersion, semverOf, todayIn } from './release.ts';

export type System = InstallerSystem;
export const SYSTEMS = Object.keys(INSTALLERS) as System[];

/** Each system as the report names it. */
export const SYSTEM_LABEL: Record<System, string> = {
  mac: 'macOS',
  win: 'Windows x64',
  'win-arm64': 'Windows Arm64',
  linux: 'Linux x64',
  'linux-arm64': 'Linux Arm64',
};

/** Its column in the table of releases. */
const SYSTEM_COLUMN: Record<System, string> = { mac: 'macOS', win: 'Win x64', 'win-arm64': 'Win Arm64', linux: 'Linux x64', 'linux-arm64': 'Linux Arm64' };

/**
 * Installers' names the releases had before INSTALLERS, and their system: 2026-11-11's Mac installer was
 * a universal one (Intel and Apple Silicon), before the Mac's became Apple Silicon only.
 */
export const PAST_INSTALLERS: Record<string, System> = { '-mac-universal.dmg': 'mac' };

/**
 * How many requests GitHub counts for one download (it counts requests, not downloads; measured,
 * docs/developer-guide.md, "Download counts"). A new install's download from GitHub is two: the
 * installer's address on github.com, then GitHub's CDN that it redirects to; the download mirror has
 * GitHub count its downloads the same way. An installed app's update is one: the app asks for its copy
 * through GitHub's API with its read token (the copies' repository is private), and only the API's
 * address counts, not the CDN's request after it (measured 2026-11-14 on a release candidate's copies).
 */
export const REQUESTS_PER_INSTALL = 2;
export const REQUESTS_PER_UPDATE = 1;

/** The download mirror's D1 database with the codespaces count (database_name in mirror/wrangler.toml). */
export const COUNTS_DATABASE = 'harness-relay-counts';
export const WRANGLER_CONFIG = fileURLToPath(new URL('../mirror/wrangler.toml', import.meta.url));
/** The wrangler it runs, through npm (as `npx wrangler` would), of the major version the mirror is deployed with. */
export const WRANGLER = 'wrangler@4';
/** How many days of codespaces it shows one by one. */
export const DAYS = 7;

/** A GitHub release, as much as the numbers need. */
export interface Release {
  tag: string;
  prerelease: boolean;
  draft: boolean;
  assets: { name: string; downloads: number }[];
}
/** GitHub's download count of each system's file; null where the release had no file for that system. */
export type Counts = Record<System, number | null>;
export type Totals = Record<System, number>;
export interface ReleaseDownloads {
  tag: string;
  /** New installs: its installers' counts. */
  installs: Counts;
  /** Updates: its copies' counts, by apps updating to it (null for each when the copies could not be read). */
  updates: Counts;
}
export interface Downloads {
  repo: string;
  updatesRepo: string;
  /** Why the copies' repository could not be read, if it could not: the updates are then unknown. */
  updatesError?: string;
  /** Newest first. */
  releases: ReleaseDownloads[];
  /** GitHub's counts in all. */
  installs: Totals;
  updates: Totals;
  /** About how many downloads: GitHub's counts in all (estimate()), each system's and all systems', the new installs halved. */
  estimate: { installs: Totals; updates: Totals; all: { installs: number; updates: number } };
  /** Files of these releases that are no installer or copy it knows, with their counts: not in the numbers. */
  other: { tag: string; name: string; downloads: number }[];
}
export interface Codespaces {
  total: number;
  /** The last DAYS days in Taiwan, oldest first, today last. */
  days: { day: string; created: number }[];
}
export interface Stats {
  downloads: Downloads | { error: string };
  codespaces: Codespaces | { error: string };
}

/** Where it reads from: `gh` and `wrangler` run with these arguments, their standard output. */
export interface Sources {
  gh(args: string[]): Promise<string>;
  wrangler(args: string[]): Promise<string>;
}

const none = (): Counts => Object.fromEntries(SYSTEMS.map((s) => [s, null])) as Counts;
const zero = (): Totals => Object.fromEntries(SYSTEMS.map((s) => [s, 0])) as Totals;
const sum = (c: Counts | Totals) => SYSTEMS.reduce((n, s) => n + (c[s] ?? 0), 0);

/** About how many downloads a count of GitHub's is, for `requests` counted for each (REQUESTS_PER_INSTALL, REQUESTS_PER_UPDATE), rounded. */
export function estimate(count: number, requests: number): number {
  return Math.round(count / requests);
}

/**
 * The system an asset of release `tag` is for: an installer of it (`ends` INSTALLERS, and a past name of
 * PAST_INSTALLERS) or its copy for the app's updates (UPDATE_INSTALLERS), by its whole name; undefined for
 * any other file.
 */
export function systemOf(name: string, tag: string, ends: Record<System, string>): System | undefined {
  const prefix = `Harness-Relay-${tag}`;
  if (!name.startsWith(prefix)) return undefined;
  const end = name.slice(prefix.length);
  const now = SYSTEMS.find((s) => end === ends[s]);
  if (now || ends !== INSTALLERS) return now;
  return PAST_INSTALLERS[end];
}

/** A release's tag as a version that sorts (newest last), or undefined for a tag that is not a version. */
function sortKey(tag: string): string | undefined {
  const parsed = parseVersion(tag);
  return parsed.ok ? semverOf(parsed.value) : undefined;
}

/**
 * The releases' downloads (not release candidates, drafts, or tags that are not versions): each release's
 * installers' counts as new installs, its copies' (the release of that tag in the copies' repository) as
 * updates, by system, newest release first; the totals, and the totals halved. `copies` undefined: the
 * copies' repository could not be read (`updatesError`).
 */
export function downloadsOf(releases: readonly Release[], copies: readonly Release[] | undefined, repo = REPO, updatesRepo = UPDATES_REPO, updatesError?: string): Downloads {
  const copiesOf = new Map((copies ?? []).filter((r) => !r.draft).map((r) => [r.tag, r]));
  const out: (ReleaseDownloads & { key: string })[] = [];
  const other: Downloads['other'] = [];
  for (const release of releases) {
    const key = sortKey(release.tag);
    // A release candidate (a pre-release in semver) left out also when GitHub does not mark it so.
    if (release.prerelease || release.draft || !key || key.includes('-')) continue;
    const add = (counts: Counts, assets: Release['assets'], ends: Record<System, string>) => {
      for (const a of assets) {
        const s = systemOf(a.name, release.tag, ends);
        if (s) counts[s] = (counts[s] ?? 0) + a.downloads;
        else other.push({ tag: release.tag, name: a.name, downloads: a.downloads });
      }
    };
    const installs = none();
    const updates = none();
    add(installs, release.assets, INSTALLERS);
    if (copies) {
      // A release made before the copies were has none: its updates are none, not unknown.
      add(updates, copiesOf.get(release.tag)?.assets ?? [], UPDATE_INSTALLERS);
      for (const s of SYSTEMS) if (installs[s] !== null) updates[s] ??= 0;
    }
    out.push({ tag: release.tag, key, installs, updates });
  }
  out.sort((a, b) => compareSemver(b.key, a.key));
  const installs = zero();
  const updates = zero();
  for (const r of out) {
    for (const s of SYSTEMS) {
      installs[s] += r.installs[s] ?? 0;
      updates[s] += r.updates[s] ?? 0;
    }
  }
  const about = (t: Totals, requests: number) => Object.fromEntries(SYSTEMS.map((s) => [s, estimate(t[s], requests)])) as Totals;
  return {
    repo,
    updatesRepo,
    ...(updatesError ? { updatesError } : {}),
    releases: out.map(({ key: _key, ...r }) => r),
    installs,
    updates,
    estimate: {
      installs: about(installs, REQUESTS_PER_INSTALL),
      updates: about(updates, REQUESTS_PER_UPDATE),
      all: { installs: estimate(sum(installs), REQUESTS_PER_INSTALL), updates: estimate(sum(updates), REQUESTS_PER_UPDATE) },
    },
    other,
  };
}

/** The `n` days up to `today` (YYYY-MM-DD), oldest first. */
export function lastDays(today: string, n = DAYS): string[] {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d - (n - 1 - i))).toISOString().slice(0, 10));
}

/** The statements it asks D1: the count in all, and each day's since `since`. */
export function countsQuery(since: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`not a day: ${since}`);
  return `SELECT COALESCE(SUM(created), 0) AS total FROM codespaces; SELECT day, created FROM codespaces WHERE day >= '${since}' ORDER BY day`;
}

/** The JSON a tool printed, past anything before it; undefined when there is none. */
function jsonIn(output: string | undefined): unknown {
  const start = output?.search(/[[{]/) ?? -1;
  if (start < 0) return undefined;
  try {
    return JSON.parse(output!.slice(start));
  } catch {
    return undefined;
  }
}

/** The codespaces count from `wrangler d1 execute --json`'s answer to countsQuery(days[0]), each of `days` with its count (0 for a day without a row). */
export function codespacesOf(output: string, days: readonly string[]): Codespaces {
  const answer = jsonIn(output) as { results?: Record<string, unknown>[]; success?: boolean }[] | undefined;
  if (!Array.isArray(answer) || answer.length !== 2 || answer.some((a) => !a.success || !Array.isArray(a.results))) {
    throw new Error(`wrangler's answer is not the two results asked for: ${output.slice(0, 200)}`);
  }
  const total = Number(answer[0]!.results![0]?.total ?? 0);
  const byDay = new Map(answer[1]!.results!.map((r) => [String(r.day), Number(r.created)]));
  return { total, days: days.map((day) => ({ day, created: byDay.get(day) ?? 0 })) };
}

/**
 * Why wrangler failed, from what it printed: with --json, an object on standard output whose `error.notes`
 * say why (D1's own message) and whose `error.text` names the API address it asked, the account's id in
 * it, left out. Else its last lines.
 */
export function wranglerReason(e: unknown): string {
  const err = e as { stdout?: string; stderr?: string; message?: string };
  const answer = jsonIn(err.stdout) as { error?: { text?: string; notes?: { text?: string }[] } } | undefined;
  const error = answer && !Array.isArray(answer) ? answer.error : undefined;
  if (error) {
    const notes = (error.notes ?? []).map((n) => n.text?.trim()).filter((t): t is string => !!t);
    const text = error.text?.replace(/\/accounts\/[^/\s)]+/g, '/accounts/…').replace(/\/database\/[^/\s)]+/g, '/database/…');
    return (notes.length ? notes : [text ?? 'failed']).join('; ');
  }
  return lastLines(err);
}

/** A failed run's last lines of output, else its message. */
function lastLines(e: unknown): string {
  const err = e as { stderr?: string; stdout?: string; message?: string };
  const text = [err.stderr, err.stdout, err.message].find((t) => t && t.trim()) ?? String(e);
  return text.trim().split('\n').filter((l) => l.trim()).slice(-2).join(' ');
}

/** Why gh could not read `repo`, and what to do. */
function ghFailure(e: unknown, repo: string): string {
  const reason = lastLines(e);
  if (/auth login|HTTP 401|not logged in|authentication/i.test(reason)) return `could not read ${repo} through gh (${reason}). Sign gh in: gh auth login`;
  if (/HTTP 404/.test(reason)) return `${repo} was not found, or gh's account cannot read it (${reason})`;
  return `could not read ${repo} through gh (${reason})`;
}

/** The releases of `repo`, through `gh api` (every page). */
async function releasesOf(sources: Sources, repo: string): Promise<Release[]> {
  const out = await sources.gh([
    'api',
    `repos/${repo}/releases?per_page=100`,
    '--paginate',
    '--jq',
    '.[] | {tag: .tag_name, prerelease, draft, assets: [.assets[] | {name, downloads: .download_count}]}',
  ]);
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Release);
}

/**
 * The copies' repository as the build reads it (`updateSourceFrom()`): the workflow's UPDATES_REPO
 * variable, else the website's UPDATES_REPO; a variable that is no repository of copies is said so.
 * Every release's copies are read there: if it ever moved, the earlier releases' copies are in the one before.
 */
async function updatesRepoOf(sources: Sources): Promise<{ repo: string; error?: string }> {
  let variable = '';
  try {
    variable = (await sources.gh(['variable', 'get', 'UPDATES_REPO', '--repo', REPO])).trim();
  } catch (e) {
    // Not set (gh says it was not found), or not readable by this account: the website's, as the build does without it.
    if (!/not found/i.test(lastLines(e))) return { repo: UPDATES_REPO, error: `could not read the workflow's UPDATES_REPO variable (${lastLines(e)}); read ${UPDATES_REPO}` };
  }
  const source = updateSourceFrom({ RELAY_UPDATES_REPO: variable });
  return source.ok ? { repo: source.value.repo } : { repo: UPDATES_REPO, error: `${source.error}; read ${UPDATES_REPO}` };
}

/** Everything the report shows, read at `now`; a part that cannot be read says why instead. */
export async function collect(sources: Sources, now: Date = new Date()): Promise<Stats> {
  const downloads = (async (): Promise<Stats['downloads']> => {
    const updates = updatesRepoOf(sources).then(async (u) => {
      try {
        return { ...u, copies: await releasesOf(sources, u.repo) };
      } catch (e) {
        return { repo: u.repo, error: ghFailure(e, u.repo), copies: undefined };
      }
    });
    let releases: Release[];
    try {
      releases = await releasesOf(sources, REPO);
    } catch (e) {
      await updates;
      return { error: ghFailure(e, REPO) };
    }
    const u = await updates;
    return downloadsOf(releases, u.copies, REPO, u.repo, u.error);
  })();
  const codespaces = (async (): Promise<Stats['codespaces']> => {
    const days = lastDays(todayIn(RELEASE_TIME_ZONE, now));
    try {
      const out = await sources.wrangler(['d1', 'execute', COUNTS_DATABASE, '--remote', '--config', WRANGLER_CONFIG, '--json', '--command', countsQuery(days[0]!)]);
      return codespacesOf(out, days);
    } catch (e) {
      const reason = wranglerReason(e);
      // No codespace counted yet: the Worker makes the table at the first count.
      if (/no such table: codespaces\b/.test(reason)) return { total: 0, days: days.map((day) => ({ day, created: 0 })) };
      const signIn = /login|authenticat|non-interactive|API token/i.test(reason) ? '. Sign wrangler in to the account with the mirror: npx wrangler login' : '';
      return { error: `could not read the count through wrangler (${reason})${signIn}` };
    }
  })();
  return { downloads: await downloads, codespaces: await codespaces };
}

/** Rows as columns, the first left-aligned and the rest right-aligned, two spaces apart, indented. */
function table(rows: string[][], indent = '  '): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => indent + r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  ').trimEnd()).join('\n');
}

const cell = (n: number | null) => (n === null ? '—' : String(n));

/** The report, as text. */
export function report(stats: Stats): string {
  const lines: string[] = [];
  const d = stats.downloads;
  lines.push('Downloads of the releases (release candidates left out)');
  if ('error' in d) {
    lines.push(`  ✗ ${d.error}`);
  } else {
    const known = !d.updatesError;
    lines.push(`  New installs: the installers on ${d.repo}.`, `  Updates: the app's copies on ${d.updatesRepo}, an installed app updating.`);
    if (d.updatesError) lines.push(`  ✗ Updates unknown: ${d.updatesError}`);
    // Each number from GitHub's counts (all systems' too, not added up from the systems' estimates).
    const totals = (title: string, installs: (n: number) => number, updates: (n: number) => number, mark: string) => {
      const rows = [[title, 'New installs', 'Updates', 'Total']];
      const row = (label: string, i: number, u: number) =>
        rows.push([label, `${mark}${installs(i)}`, known ? `${mark}${updates(u)}` : '?', known ? `${mark}${installs(i) + updates(u)}` : '?']);
      for (const s of SYSTEMS) row(SYSTEM_LABEL[s], d.installs[s], d.updates[s]);
      row('All systems', sum(d.installs), sum(d.updates));
      return table(rows);
    };
    const same = (n: number) => n;
    lines.push('', totals('About how many downloads', (n) => estimate(n, REQUESTS_PER_INSTALL), (n) => estimate(n, REQUESTS_PER_UPDATE), '≈ '), '');
    lines.push(totals("GitHub's counts", same, same, ''), '');
    lines.push("  By release, GitHub's counts (new installs / updates; — where the release had no such file):", '');
    const byRelease = [['Release', ...SYSTEMS.map((s) => SYSTEM_COLUMN[s]), 'All']];
    for (const r of d.releases) {
      byRelease.push([r.tag, ...SYSTEMS.map((s) => `${cell(r.installs[s])} / ${known ? cell(r.updates[s]) : '?'}`), `${sum(r.installs)} / ${known ? sum(r.updates) : '?'}`]);
    }
    if (d.releases.length === 0) byRelease.push(['(no release yet)', ...SYSTEMS.map(() => ''), '']);
    lines.push(table(byRelease));
    if (d.other.length) {
      lines.push('', '  Not counted, files of no system it knows (a new installer name? add it to PAST_INSTALLERS or INSTALLERS):');
      for (const o of d.other) lines.push(`    ${o.tag}  ${o.name}  ${o.downloads}`);
    }
  }
  lines.push('', "Codespaces made from the README's and the website's links");
  const c = stats.codespaces;
  if ('error' in c) {
    lines.push(`  ✗ ${c.error}`);
  } else {
    lines.push(`  In all: ${c.total}`, `  The last ${c.days.length} days (days in Taiwan):`, '');
    lines.push(table(c.days.map((x, i) => [x.day + (i === c.days.length - 1 ? ' (today)' : ''), String(x.created)]), '    '));
  }
  lines.push(
    '',
    'How to read the downloads: GitHub counts requests, not downloads. A new install\'s download from',
    'GitHub is two requests it counts, its address on github.com and then GitHub\'s CDN it redirects to',
    '(the website\'s mirror has GitHub count its downloads the same way); an installed app\'s update,',
    'asked for through GitHub\'s API, is one. So "about how many downloads" is the new installs halved and',
    'the updates as they are. Still an estimate: a download tried again counts again, the maintainers\'',
    'own downloads count too, and a lone request (a HEAD, a redirect not followed) counts as one.',
    'An app that cannot have its copy (one from before 2026-11-12, release candidates included, or one',
    'whose read token stopped working) updates from the installer: that update counts as a new install.',
    'See docs/developer-guide.md, "Download counts".',
  );
  return lines.join('\n') + '\n';
}

const execFileAsync = promisify(execFile);

/** Runs a program directly (no shell): its standard output; a failure keeps what it printed. */
async function run(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

/**
 * The program to start for wrangler with `args`: `npm exec` with the npm that runs this script (npm run
 * sets npm_execpath) under this Node, started directly, which also works on Windows, where npx is a .cmd
 * (npm exec itself runs wrangler as npx does); else `npx`.
 */
export function wranglerCommand(args: string[], npmExecpath = process.env.npm_execpath, node = process.execPath): [string, string[]] {
  if (npmExecpath && /npm-cli\.[cm]?js$/.test(npmExecpath)) return [node, [npmExecpath, 'exec', '--yes', `--package=${WRANGLER}`, '--', 'wrangler', ...args]];
  return ['npx', ['--yes', WRANGLER, ...args]];
}

export const realSources: Sources = {
  gh: (args) => run('gh', args),
  wrangler: (args) => run(...wranglerCommand(args)),
};

/** The report, or `--json` the same as JSON; 1 when a part could not be read, 2 for an option it does not take. */
export async function main(argv: string[], sources: Sources = realSources, now: Date = new Date(), write: (text: string) => void = (t) => process.stdout.write(t)): Promise<number> {
  const unknown = argv.filter((a) => a !== '--json');
  if (unknown.length) {
    console.error(`Usage: npm run stats [-- --json]; "${unknown[0]}" is not an option of it.`);
    return 2;
  }
  const stats = await collect(sources, now);
  write(argv.includes('--json') ? JSON.stringify(stats, null, 2) + '\n' : report(stats));
  const failed = 'error' in stats.downloads || !!stats.downloads.updatesError || 'error' in stats.codespaces;
  return failed ? 1 : 0;
}

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
