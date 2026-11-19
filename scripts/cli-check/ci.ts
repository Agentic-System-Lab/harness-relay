/**
 * The CLI versions workflow's checks (`.github/workflows/cli-versions.yml`), in three steps:
 *
 *   npx tsx scripts/cli-check/ci.ts matrix                which new versions to check: each CLI that is
 *                                                         behind and not yet checked (a clean check is
 *                                                         remembered), and whose open issue, if it has one,
 *                                                         holds no report of that version yet (on a pull
 *                                                         request: every CLI's newest, reported nowhere)
 *   npx tsx scripts/cli-check/ci.ts seen-run              which previous run holds that memory: the newest
 *                                                         success that was not a pull request, from the
 *                                                         JSON of `gh run list` on stdin
 *   npx tsx scripts/cli-check/ci.ts check <cli> <version> gets that version and the one checked apart
 *                                                         (`obtain.ts`), records what the one checked says
 *                                                         here (`--record`), checks the new one against it
 *                                                         (`--against`), and writes the report
 *   npx tsx scripts/cli-check/ci.ts report <folder>       opens an issue only when a check found a failed
 *                                                         check or something removed, and posts that report
 *                                                         there, once. A clean check opens none
 *
 * Both versions run on the same system in the same way, so what differs between them is the CLI's,
 * not the system's: the shapes this repository keeps were recorded on another (docs/developer-guide.md,
 * "Checking a CLI's new version"). Only `report` writes anything on GitHub; `check`, which runs what it
 * downloads, gets no token, and each CLI runs in scratch folders with none of the job's variables.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKED_VERSIONS } from '../../src/shared/cliVersions';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '../../src/shared/types';
import type { Gh } from './issues';
import { obtain } from './obtain';
import {
  ISSUE_LABEL,
  compareVersions,
  issueBody,
  issueTitle,
  parseMarker,
  versionCore,
  versionRows,
  type OpenIssue,
  type VersionRow,
} from './versions';

export interface MatrixEntry {
  cli: Provider;
  version: string;
}

/** An open issue of the workflow's, with its comments (`gh issue list --json number,title,body,comments`). */
export interface IssueWithComments extends OpenIssue {
  comments: { body: string }[];
}

/** What marks a comment as the report of one version's check. */
export const reportMarker = (p: Provider, version: string) => `<!-- cli-check-report provider=${p} version=${version} -->`;

/** Whether an issue holds the report of this version's check. */
export function reported(issue: IssueWithComments, p: Provider, version: string): boolean {
  return issue.comments.some((c) => c.body.includes(reportMarker(p, version)));
}

/** A version whose check already settled: clean or a problem, so it is not checked again. */
export interface Seen {
  cli: Provider;
  version: string;
}

/**
 * Which versions to check: on a schedule or by hand, each CLI that is behind, except one already
 * settled (`seen`, the previous run) or whose open issue already holds that version's report, so that
 * a version is checked once, whether or not it got an issue. On a pull request that changes the check,
 * every CLI's newest, to try the check itself.
 */
export function ciMatrix(
  rows: readonly VersionRow[],
  issues: readonly IssueWithComments[] | 'pull_request',
  seen: readonly Seen[] = [],
): MatrixEntry[] {
  if (issues === 'pull_request') return rows.filter((r) => r.latest).map((r) => ({ cli: r.provider, version: r.latest! }));
  const settled = new Map<Provider, string>();
  for (const s of seen) settled.set(s.cli, s.version);
  return rows
    .filter((r) => r.status === 'behind' && r.latest)
    .filter((r) => {
      const latest = r.latest!;
      const kept = settled.get(r.provider);
      // The same version, or an older one than a version already settled (a source that still names
      // the one before): nothing to check. Another build of the same numbers is still checked.
      if (kept === latest || (kept !== undefined && newerCore(kept, latest))) return false;
      const issue = issues.find((i) => parseMarker(i.body)?.provider === r.provider);
      if (!issue) return true;
      const told = parseMarker(issue.body)?.latest;
      // The issue tells of a newer version than the source names now: leave it, as planIssues does.
      if (told && newerCore(told, latest)) return false;
      return !reported(issue, r.provider, latest);
    })
    .map((r) => ({ cli: r.provider, version: r.latest! }));
}

/** Whether `a`'s numbers are newer than `b`'s. Another build of the same numbers is not. */
function newerCore(a: string, b: string): boolean {
  return compareVersions(versionCore(a), versionCore(b)) > 0;
}

/**
 * The run whose `cli-check-seen` artifact is the memory. `runs` is newest first, as `gh run list`
 * prints them. A pull request posts nothing and uploads no artifact, so its success is not that run;
 * the first other success is. Anything that is not a run list remembers nothing, and the next day
 * checks again.
 */
export function previousSeenRun(runs: unknown): number | undefined {
  if (!Array.isArray(runs)) return undefined;
  for (const r of runs) {
    if (!r || typeof r !== 'object') continue;
    const event = (r as { event?: unknown }).event;
    const id = (r as { databaseId?: unknown }).databaseId;
    if (event === 'pull_request') continue;
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  }
  return undefined;
}

/** The versions a previous run settled (`CLI_CHECK_SEEN`), or nothing when the file is missing or not one. */
export function readSeen(path: string | undefined): Seen[] {
  if (!path || !existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { seen?: unknown };
    if (!Array.isArray(parsed?.seen)) return [];
    const out: Seen[] = [];
    for (const s of parsed.seen) {
      if (!s || typeof s !== 'object') continue;
      const cli = (s as { cli?: unknown }).cli;
      const version = (s as { version?: unknown }).version;
      if (typeof cli === 'string' && (PROVIDERS as readonly string[]).includes(cli) && typeof version === 'string' && version)
        out.push({ cli: cli as Provider, version });
    }
    return out;
  } catch {
    return [];
  }
}

/** `seen` written for the next run, one entry per CLI, in the providers' order. */
export function seenText(seen: readonly Seen[]): string {
  const byCli = new Map<Provider, string>();
  for (const s of seen) if ((PROVIDERS as readonly string[]).includes(s.cli)) byCli.set(s.cli, s.version);
  const entries = PROVIDERS.filter((p) => byCli.has(p)).map((cli) => ({ cli, version: byCli.get(cli)! }));
  return `${JSON.stringify({ seen: entries }, null, 2)}\n`;
}

/** What `check` writes, and `report` posts. */
export interface Report {
  cli: Provider;
  version: string;
  checked: string;
  /** Whether the version checked could be had and run here, to compare with. */
  against: boolean;
  /** cli-check's exit code: 0 nothing found, 1 something found; undefined when it could not run. */
  exit?: number;
  text: string;
  /** Why the new version could not be checked at all. */
  error?: string;
  /** Why the version checked could not be compared with. */
  againstError?: string;
  system: string;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/** GitHub takes a comment of up to 65,536 characters. */
const MAX_TEXT = 55_000;

/**
 * A code fence longer than any run of backticks in `text`, so that nothing in the report ends it.
 * Inside it, GitHub neither notifies an `@name` (release notes name their authors) nor links `#123`.
 */
export function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** What layers 2 and 3 of a report say, before the release notes (`== 4`). */
export interface ReportTriage {
  /** A failed scenario (`FAIL`, `✗`, `SECURITY:`) or a check that stopped (`STOPPED:`). */
  failures: string[];
  /** Shape lines that describe something gone: a flag, a message, or a key. */
  removed: string[];
  /** How many shape lines describe something new. */
  added: number;
  /** No saved shape to compare with (`none saved`). */
  unsaved: boolean;
  /** `describeDiff` cut its own list (`… and N more`). */
  diffCut: boolean;
  /** Layer 3 printed `N of N scenarios passed` with N above zero. */
  scenariosPassed: boolean;
}

/** Layers 2 and 3, read for the comment: the release notes are not a failure of the check. */
export function triageReport(text: string): ReportTriage {
  const pre = text.replace(ANSI, '').split('\n== 4.')[0] ?? '';
  const failures: string[] = [];
  const removed: string[] = [];
  const added = new Set<string>();
  let unsaved = false;
  let diffCut = false;
  for (const raw of pre.split('\n')) {
    const s = raw.trim();
    if (s.startsWith('FAIL ') || s.startsWith('✗ ') || s.startsWith('STOPPED:') || s.includes('SECURITY:')) failures.push(s);
    else if (s.startsWith('- ')) removed.push(s.slice(2));
    else if (s.startsWith('+ ')) added.add(s.slice(2));
    else if (s.includes('none saved')) unsaved = true;
    else if (s.startsWith('… and ')) diffCut = true;
  }
  const passed = pre.match(/(\d+) of (\d+) scenarios passed/);
  return {
    failures: [...new Set(failures)],
    removed: [...new Set(removed)],
    added: added.size,
    unsaved,
    diffCut,
    scenariosPassed: !!passed && passed[1] === passed[2] && passed[2] !== '0',
  };
}

const NEXT = "Read the release notes' lines in the report and run the live tests before moving it forward.";

function fields(n: number): string {
  return `${n} new field${n === 1 ? '' : 's'}`;
}

/** The lines the comment quotes, in a fence, so an `@name` in one notifies nobody. At most `max` of them. */
function quoted(lines: string[], max = 20): string {
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(`… and ${lines.length - max} more in the report`);
  return fenced(shown.join('\n'));
}

/**
 * What the comment says before the folded report. Exit 0 is layers 2 and 3 with nothing new. Exit 1
 * is a failed check, something removed, no saved shape, or only new fields: the release notes never
 * decide it (`changelog` returns 0).
 */
function verdictFor(r: Report, text: string): { lead: string; extra: string[] } {
  if (r.error) return { lead: `It could not be checked: ${r.error}`, extra: [] };
  if (r.exit === 0) return { lead: `Layers 2 and 3 found nothing new. ${NEXT}`, extra: [] };
  if (r.exit !== 1) return { lead: `The check did not finish (exit ${r.exit ?? 'none'}): the report shows how far it got.`, extra: [] };
  const t = triageReport(text);
  const passed = t.scenariosPassed ? ' Every scenario that ran passed.' : '';
  const cut = t.diffCut ? ' The shape diff in the report was cut.' : '';
  if (t.failures.length) {
    const stopped = t.failures.some((l) => l.startsWith('STOPPED:'));
    return {
      lead: stopped ? 'The check stopped before it finished.' : 'Layers 2 and 3 found a failed check.',
      extra: ['', quoted([...t.failures, ...t.removed.map((l) => `- ${l}`)]), '', 'The report below has the rest.'],
    };
  }
  if (t.removed.length) {
    const more = t.added ? `, and ${fields(t.added)}` : '';
    return {
      lead: `Layers 2 and 3 found something removed${more}.${passed}${cut}`,
      extra: [
        '',
        quoted(t.removed.map((l) => `- ${l}`)),
        '',
        `Look at what was removed, then ${NEXT.charAt(0).toLowerCase()}${NEXT.slice(1)}`,
      ],
    };
  }
  if (t.unsaved) {
    return { lead: `Layers 2 and 3 had no saved shape to compare with, so this version's shape is all new.${passed} ${NEXT}`, extra: [] };
  }
  if (t.added) return { lead: `Layers 2 and 3 found only new fields (${t.added}).${passed}${cut} ${NEXT}`, extra: [] };
  return { lead: 'It found something to look at: the report says what, layer by layer.', extra: [] };
}

/**
 * Whether a report is worth an issue. A failed check, something removed, a check that could not run
 * or did not finish, or an exit 1 the report does not explain: yes. Nothing new, only new fields, or
 * no saved shape: no. The release notes never decide it (`changelog` returns 0).
 */
export function reportIsWorthy(r: Pick<Report, 'error' | 'exit' | 'text'>): boolean {
  if (r.error) return true;
  if (r.exit === 0) return false;
  if (r.exit !== 1) return true;
  const t = triageReport(r.text);
  if (t.failures.length || t.removed.length) return true;
  if (t.unsaved || t.added) return false;
  return true;
}

/** The first fenced block a comment quotes (` ```text ` … the same backticks), when it has one. */
export function fencedText(body: string): string | undefined {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const fence = /^(`+)text$/.exec(lines[i]!)?.[1];
    if (!fence) continue;
    const end = lines.findIndex((line, j) => j > i && line === fence);
    if (end < 0) return undefined;
    return lines.slice(i + 1, end).join('\n');
  }
  return undefined;
}

/**
 * Whether a report comment already posted is worth leaving its issue open. The lines before its first
 * fence decide a comment this workflow wrote; an older comment is read from that fence. A marker with
 * no report stays open: there is nothing to classify it by.
 */
export function commentIsWorthy(body: string): boolean {
  const head = body.split(/\n`+text\n/)[0] ?? body;
  if (/found nothing new|found only new fields|no saved shape/.test(head)) return false;
  if (/could not be checked|did not finish|stopped before it finished/.test(head)) return true;
  const text = fencedText(body);
  if (text === undefined) return true;
  return reportIsWorthy({ exit: 1, text });
}

/** The comment a report is posted as. */
export function reportComment(r: Report): string {
  const label = `${PROVIDER_LABEL[r.cli]} ${r.version}`;
  const how = r.against
    ? `against ${r.checked}, which it ran there too, the same way`
    : `against the shapes this repository keeps for ${r.checked}, recorded on another system${r.againstError ? ` (${r.checked} could not be compared with here: ${r.againstError})` : ''}`;
  let text = r.text.replace(ANSI, '').trimEnd();
  const verdict = verdictFor(r, text);
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (cut: the whole report is in the workflow run's artifacts)`;
  return [
    `### ${label}, checked on ${r.system}`,
    '',
    `Checked by the CLI versions workflow ${how}. ${verdict.lead}`,
    ...verdict.extra,
    '',
    ...(text ? ['<details><summary>The report</summary>', '', fenced(text), '', '</details>', ''] : []),
    reportMarker(r.cli, r.version),
  ].join('\n');
}

/** Fixed: a clean check closes an issue that was opened before the check could say. */
const CLEAN_CLOSE = 'Layers 2 and 3 found nothing that needs a change, so this issue is closed.';

/**
 * What `report` does with each check. A problem opens an issue (or comments on the open one) and posts
 * the report, once. A clean check opens none, and closes an open issue for that CLI without posting the
 * report. An issue whose posted report is not a problem is closed too, so the open list is only problems.
 * `seen` is every version this settled, with `prevSeen` kept where this run did not settle a newer one.
 */
export async function postReports(
  reports: readonly Report[],
  gh: Gh,
  prevSeen: readonly Seen[] = [],
): Promise<{ lines: string[]; seen: Seen[] }> {
  const issues = JSON.parse(
    await gh(['issue', 'list', '--label', ISSUE_LABEL, '--state', 'open', '--json', 'number,title,body,comments', '--limit', '200']),
  ) as IssueWithComments[];
  const lines: string[] = [];
  const seen = new Map<Provider, string>(prevSeen.map((s) => [s.cli, s.version]));
  const fresh = new Set<Provider>();
  const closed = new Set<number>();
  // An older core never replaces a newer one (a source still naming the version before). The same
  // numbers with another build do: that build is the one just settled.
  const settleVersion = (cli: Provider, version: string) => {
    const prev = seen.get(cli);
    if (prev !== undefined && newerCore(prev, version)) return;
    seen.set(cli, version);
  };
  const remember = (cli: Provider, version: string) => {
    settleVersion(cli, version);
    fresh.add(cli);
  };
  for (const r of reports) {
    const label = `${PROVIDER_LABEL[r.cli]} ${r.version}`;
    const issue = issues.find((i) => parseMarker(i.body)?.provider === r.cli);
    if (issue && reported(issue, r.cli, r.version)) {
      lines.push(`${label}: already reported in #${issue.number}`);
      settleVersion(r.cli, r.version);
      continue;
    }
    if (!reportIsWorthy(r)) {
      const told = issue && parseMarker(issue.body)?.latest;
      // The issue tells of a newer version than this report (a source that lagged). Closing it would
      // drop a problem the versions step left open, and an older comment must not do that either:
      // `fresh` keeps the settle below from reading that comment.
      const tellsOfNewer = Boolean(told && newerCore(told, r.version));
      if (issue && !closed.has(issue.number) && !tellsOfNewer) {
        await gh(['issue', 'close', String(issue.number), '--comment', CLEAN_CLOSE]);
        closed.add(issue.number);
        lines.push(`${label}: closed #${issue.number}`);
      } else if (issue && tellsOfNewer) lines.push(`${label}: left #${issue.number}, which tells of ${told}`);
      else if (!issue) lines.push(`${label}: no issue opened`);
      remember(r.cli, r.version);
      continue;
    }
    let number = issue?.number;
    if (!number) {
      const row: VersionRow = { provider: r.cli, checked: r.checked, latest: r.version, status: 'behind' };
      const url = await gh(['issue', 'create', '--title', issueTitle(row), '--label', ISSUE_LABEL, '--body-file', '-'], issueBody(row));
      const created = /\/issues\/(\d+)/.exec(url);
      if (!created) throw new Error(`gh issue create for ${label} did not print an issue number`);
      number = Number(created[1]);
      await gh(['issue', 'comment', String(number), '--body-file', '-'], reportComment(r));
      lines.push(`${label}: opened #${number}`);
    } else {
      await gh(['issue', 'comment', String(number), '--body-file', '-'], reportComment(r));
      lines.push(`${label}: reported in #${number}`);
    }
    remember(r.cli, r.version);
  }
  // Issues opened before a check could say, whose posted report is not a problem, are closed. A comment
  // this call just posted is not in `issues` yet: `fresh` keeps that decision.
  for (const issue of issues) {
    if (closed.has(issue.number)) continue;
    const parsed = parseMarker(issue.body);
    if (!parsed || fresh.has(parsed.provider)) continue;
    const last = issue.comments.filter((c) => c.body.includes('cli-check-report')).at(-1);
    if (!last) continue;
    const version = /<!-- cli-check-report provider=[a-z]+ version=(\S+) -->/.exec(last.body)?.[1];
    // A comment about an older version than the issue tells of is not a verdict on that version.
    const commentOlder = Boolean(version && newerCore(parsed.latest, version));
    if (!commentIsWorthy(last.body) && !commentOlder) {
      await gh(['issue', 'close', String(issue.number), '--comment', CLEAN_CLOSE]);
      lines.push(`${PROVIDER_LABEL[parsed.provider]}${version ? ` ${version}` : ''}: closed #${issue.number}`);
    }
    if (version) settleVersion(parsed.provider, version);
  }
  return { lines, seen: PROVIDERS.filter((p) => seen.has(p)).map((cli) => ({ cli, version: seen.get(cli)! })) };
}

// ---------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A line for the step's output (`$GITHUB_OUTPUT`), or the terminal outside GitHub. */
function output(name: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

/** gh with this process's environment (its token), started directly. */
const gh: Gh = async (ghArgs, stdin) => {
  const { runProcess } = await import('../../src/server/process');
  const repo = process.env.GITHUB_REPOSITORY ? ['--repo', process.env.GITHUB_REPOSITORY] : [];
  const r = await runProcess({
    bin: 'gh',
    args: [...ghArgs, ...repo],
    env: process.env,
    timeoutMs: 60_000,
    ...(stdin !== undefined ? { stdin } : {}),
  });
  if (r.code !== 0) throw new Error(`gh ${ghArgs.slice(0, 2).join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
};

/** Runs scripts/cli-check.ts with these arguments, its output passed on as it comes and kept. */
async function cliCheck(args: string[]): Promise<{ code: number | null; text: string }> {
  const { runProcess } = await import('../../src/server/process');
  let text = '';
  const r = await runProcess({
    bin: 'npx',
    args: ['tsx', join(root, 'scripts', 'cli-check.ts'), ...args],
    cwd: root,
    env: process.env,
    timeoutMs: 60 * 60_000,
    onLine: (line) => {
      console.log(line);
      text += `${line}\n`;
    },
  });
  if (r.stderr.trim()) text += r.stderr;
  return { code: r.code, text };
}

async function check(p: Provider, version: string): Promise<void> {
  const dir = join(process.env.RUNNER_TEMP || tmpdir(), `cli-check-${p}`);
  mkdirSync(dir, { recursive: true });
  const os = process.platform === 'linux' ? 'Linux' : process.platform === 'darwin' ? 'macOS' : process.platform;
  const system = `${os} (${process.arch})${process.env.ImageOS ? `, GitHub's ${process.env.ImageOS} runner` : ''}`;
  const report: Report = { cli: p, version, checked: CHECKED_VERSIONS[p], against: false, text: '', system };
  try {
    const bin = await obtain(p, version, join(dir, 'new'));
    let checkedBin: string | undefined;
    try {
      checkedBin = await obtain(p, CHECKED_VERSIONS[p], join(dir, 'checked'));
    } catch (err) {
      report.againstError = (err as Error).message;
    }
    const recorded = join(dir, 'checked.json');
    if (checkedBin) {
      console.log(`\n######## ${PROVIDER_LABEL[p]} ${CHECKED_VERSIONS[p]}, the version checked, recorded here to compare with`);
      await cliCheck([p, '--bin', checkedBin, '--record', recorded]);
      report.against = existsSync(recorded);
      if (!report.against) report.againstError = 'it could not be recorded here';
    }
    console.log(`\n######## ${PROVIDER_LABEL[p]} ${version}`);
    const r = await cliCheck([p, '--bin', bin, ...(report.against ? ['--against', recorded] : [])]);
    report.text = r.text;
    if (r.code !== null) report.exit = r.code;
  } catch (err) {
    report.error = (err as Error).message;
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${reportComment(report)}\n`);
  output('report', join(dir, 'report.json'));
}

/** Every report.json in a folder and the folders in it (the downloaded artifacts). */
function findReports(dir: string): Report[] {
  const out: Report[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...findReports(path));
    else if (e.name === 'report.json') out.push(JSON.parse(readFileSync(path, 'utf8')) as Report);
  }
  return out;
}

async function main(argv: string[]): Promise<void> {
  const [command, a, b] = argv;
  if (command === 'matrix') {
    const rows = await versionRows(PROVIDERS);
    const pr = process.env.GITHUB_EVENT_NAME === 'pull_request';
    const issues = pr
      ? ('pull_request' as const)
      : (JSON.parse(
          await gh(['issue', 'list', '--label', 'cli-check', '--state', 'open', '--json', 'number,title,body,comments', '--limit', '200']),
        ) as IssueWithComments[]);
    const matrix = ciMatrix(rows, issues, pr ? [] : readSeen(process.env.CLI_CHECK_SEEN));
    console.log(matrix.length ? matrix.map((m) => `${m.cli} ${m.version}`).join('\n') : 'Nothing new to check.');
    output('matrix', JSON.stringify(matrix));
    output('count', String(matrix.length));
  } else if (command === 'seen-run') {
    const raw = readFileSync(0, 'utf8').trim();
    if (!raw) return;
    try {
      const id = previousSeenRun(JSON.parse(raw));
      if (id !== undefined) console.log(String(id));
    } catch {
      // Not a run list: the next day checks again, as a missing artifact does.
    }
  } else if (command === 'check' && a && b && (PROVIDERS as readonly string[]).includes(a)) {
    await check(a as Provider, b);
  } else if (command === 'report' && a) {
    const { lines, seen } = await postReports(findReports(a), gh, readSeen(process.env.CLI_CHECK_SEEN));
    for (const line of lines) console.log(line);
    const out = process.env.CLI_CHECK_SEEN_OUT;
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, seenText(seen));
    }
  } else {
    console.error('Usage: npx tsx scripts/cli-check/ci.ts matrix | seen-run | check <cli> <version> | report <folder>');
    process.exit(2);
  }
}

// Run as a script only: the tests import the functions above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
