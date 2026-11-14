/**
 * Harness Relay's numbers, for its maintainers: `npm run stats` (`npm run stats -- --json` for the same
 * as JSON). Read with your own sign-ins, written nowhere:
 *
 * - The releases' downloads on GitHub, by system, in all and release by release (release candidates
 *   left out), new installs apart from updates. An installer on this repository's releases is a new
 *   install (from the website, its download mirror or the releases page); its copy for the app's
 *   updates, on the copies' repository (the workflow's UPDATES_REPO variable, else UPDATES_REPO in
 *   site/assets/downloads.js), is an installed app updating (desktop/src/update.ts). Through `gh`,
 *   signed in as gh is (or GH_TOKEN), which also reads a private copies' repository.
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
import { INSTALLERS, REPO, UPDATE_INSTALLERS, UPDATES_REPO, type InstallerSystem } from '../site/assets/downloads.js';
import { RELEASE_TIME_ZONE, compareSemver, parseVersion, semverOf, todayIn } from './release.ts';

export type System = InstallerSystem;
export const SYSTEMS = Object.keys(INSTALLERS) as System[];

/** Each system as the report names it. */
export const SYSTEM_LABEL: Record<System, string> = {
  mac: 'macOS (Apple Silicon)',
  win: 'Windows x64',
  'win-arm64': 'Windows Arm64',
  linux: 'Linux x64',
  'linux-arm64': 'Linux Arm64',
};

/** Its column in the table of releases. */
const SYSTEM_COLUMN: Record<System, string> = { mac: 'macOS', win: 'Win x64', 'win-arm64': 'Win Arm64', linux: 'Linux x64', 'linux-arm64': 'Linux Arm64' };

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
export type Counts = Record<System, number>;
export interface ReleaseDownloads {
  tag: string;
  /** New installs: its installers' downloads. */
  installs: Counts;
  /** Updates: its copies' downloads, by apps updating to it. */
  updates: Counts;
}
export interface Downloads {
  repo: string;
  updatesRepo: string;
  /** Newest first. */
  releases: ReleaseDownloads[];
  installs: Counts;
  updates: Counts;
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

const zero = (): Counts => Object.fromEntries(SYSTEMS.map((s) => [s, 0])) as Counts;
const sum = (c: Counts) => SYSTEMS.reduce((n, s) => n + c[s], 0);

/**
 * The system an asset of release `tag` is for: an installer of it (`ends` INSTALLERS) or its copy for the
 * app's updates (UPDATE_INSTALLERS), by its whole name; undefined for any other file.
 */
export function systemOf(name: string, tag: string, ends: Record<System, string>): System | undefined {
  return SYSTEMS.find((s) => name === `Harness-Relay-${tag}${ends[s]}`);
}

/** A release's tag as a version that sorts (newest last), or undefined for a tag that is not a version. */
function sortKey(tag: string): string | undefined {
  const parsed = parseVersion(tag);
  return parsed.ok ? semverOf(parsed.value) : undefined;
}

/**
 * The releases' downloads (not release candidates, drafts, or tags that are not versions): each release's
 * installers' downloads as new installs, its copies' (the release of that tag in the copies' repository)
 * as updates, by system, newest release first, and the totals.
 */
export function downloadsOf(releases: readonly Release[], copies: readonly Release[], repo = REPO, updatesRepo = UPDATES_REPO): Downloads {
  const copiesOf = new Map(copies.filter((r) => !r.draft).map((r) => [r.tag, r]));
  const out: (ReleaseDownloads & { key: string })[] = [];
  for (const release of releases) {
    const key = sortKey(release.tag);
    // A release candidate (a pre-release in semver) left out also when GitHub does not mark it so.
    if (release.prerelease || release.draft || !key || key.includes('-')) continue;
    const installs = zero();
    const updates = zero();
    for (const a of release.assets) {
      const s = systemOf(a.name, release.tag, INSTALLERS);
      if (s) installs[s] += a.downloads;
    }
    for (const a of copiesOf.get(release.tag)?.assets ?? []) {
      const s = systemOf(a.name, release.tag, UPDATE_INSTALLERS);
      if (s) updates[s] += a.downloads;
    }
    out.push({ tag: release.tag, key, installs, updates });
  }
  out.sort((a, b) => compareSemver(b.key, a.key));
  const installs = zero();
  const updates = zero();
  for (const r of out) {
    for (const s of SYSTEMS) {
      installs[s] += r.installs[s];
      updates[s] += r.updates[s];
    }
  }
  return { repo, updatesRepo, releases: out.map(({ key: _key, ...r }) => r), installs, updates };
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

/** The codespaces count from `wrangler d1 execute --json`'s answer to countsQuery(days[0]), each of `days` with its count (0 for a day without a row). */
export function codespacesOf(output: string, days: readonly string[]): Codespaces {
  const start = output.search(/[[{]/);
  const answer = JSON.parse(start < 0 ? output : output.slice(start)) as { results?: Record<string, unknown>[]; success?: boolean }[];
  if (!Array.isArray(answer) || answer.length !== 2 || answer.some((a) => !a.success || !Array.isArray(a.results))) {
    throw new Error(`wrangler's answer is not the two results asked for: ${output.slice(0, 200)}`);
  }
  const total = Number(answer[0]!.results![0]?.total ?? 0);
  const byDay = new Map(answer[1]!.results!.map((r) => [String(r.day), Number(r.created)]));
  return { total, days: days.map((day) => ({ day, created: byDay.get(day) ?? 0 })) };
}

/** A failed run's message, with what it printed, for the report. */
function why(e: unknown): string {
  const err = e as { stderr?: string; stdout?: string; message?: string };
  const text = [err.stderr, err.stdout, err.message].find((t) => t && t.trim()) ?? String(e);
  return text.trim().split('\n').filter((l) => l.trim()).slice(-3).join(' ');
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

/** The copies' repository: the workflow's UPDATES_REPO variable when it is set and readable, else the website's. */
async function updatesRepoOf(sources: Sources): Promise<string> {
  try {
    const v = (await sources.gh(['variable', 'get', 'UPDATES_REPO', '--repo', REPO])).trim();
    return /^[\w.-]+\/[\w.-]+$/.test(v) ? v : UPDATES_REPO;
  } catch {
    return UPDATES_REPO;
  }
}

/** Everything the report shows, read at `now`; a part that cannot be read says why instead. */
export async function collect(sources: Sources, now: Date = new Date()): Promise<Stats> {
  const downloads = (async () => {
    try {
      const updatesRepo = await updatesRepoOf(sources);
      const [releases, copies] = await Promise.all([releasesOf(sources, REPO), releasesOf(sources, updatesRepo)]);
      return downloadsOf(releases, copies, REPO, updatesRepo);
    } catch (e) {
      return { error: `could not read the releases through gh (${why(e)}). Sign gh in: gh auth login` };
    }
  })();
  const codespaces = (async () => {
    const days = lastDays(todayIn(RELEASE_TIME_ZONE, now));
    try {
      const out = await sources.wrangler(['d1', 'execute', COUNTS_DATABASE, '--remote', '--config', WRANGLER_CONFIG, '--json', '--command', countsQuery(days[0]!)]);
      return codespacesOf(out, days);
    } catch (e) {
      // No codespace counted yet: the Worker makes the table at the first count.
      if (/no such table: codespaces/.test(why(e))) return { total: 0, days: days.map((day) => ({ day, created: 0 })) };
      return { error: `could not read the count through wrangler (${why(e)}). Sign wrangler in to the account with the mirror: npx wrangler login` };
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

/** The report, as text. */
export function report(stats: Stats): string {
  const lines: string[] = [];
  const d = stats.downloads;
  lines.push('Downloads of the releases, as GitHub counts them (release candidates left out)');
  if ('error' in d) {
    lines.push(`  ✗ ${d.error}`);
  } else {
    lines.push(`  New installs: the installers on ${d.repo}. Updates: the app's copies on ${d.updatesRepo}, an installed app updating.`, '');
    const rows = [['', 'New installs', 'Updates', 'Total']];
    for (const s of SYSTEMS) rows.push([SYSTEM_LABEL[s], String(d.installs[s]), String(d.updates[s]), String(d.installs[s] + d.updates[s])]);
    rows.push(['All systems', String(sum(d.installs)), String(sum(d.updates)), String(sum(d.installs) + sum(d.updates))]);
    lines.push(table(rows), '');
    lines.push('  By release (new installs / updates):', '');
    const byRelease = [['Release', ...SYSTEMS.map((s) => SYSTEM_COLUMN[s]), 'All']];
    for (const r of d.releases) {
      byRelease.push([r.tag, ...SYSTEMS.map((s) => `${r.installs[s]} / ${r.updates[s]}`), `${sum(r.installs)} / ${sum(r.updates)}`]);
    }
    if (d.releases.length === 0) byRelease.push(['(no release yet)', ...SYSTEMS.map(() => ''), '']);
    lines.push(table(byRelease));
  }
  lines.push('', 'Codespaces made from the README\'s and the website\'s links');
  const c = stats.codespaces;
  if ('error' in c) {
    lines.push(`  ✗ ${c.error}`);
  } else {
    lines.push(`  In all: ${c.total}`, `  The last ${c.days.length} days (days in Taiwan):`, '');
    lines.push(table(c.days.map((x, i) => [x.day + (i === c.days.length - 1 ? ' (today)' : ''), String(x.created)]), '    '));
  }
  lines.push(
    '',
    'GitHub counts requests, not people: a browser\'s download from GitHub was seen to count as 2, and a',
    'download tried again counts again. An app from before 2026-11-12 (its release candidates included)',
    'updates from the installer, so its update counts as a new install until it has updated once.',
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
 * sets npm_execpath) under this Node, so that no shell is needed on Windows either (where npx is a
 * .cmd); else `npx`.
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
  return 'error' in stats.downloads || 'error' in stats.codespaces ? 1 : 0;
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
