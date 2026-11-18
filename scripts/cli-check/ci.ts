/**
 * The CLI versions workflow's checks (`.github/workflows/cli-versions.yml`), in three steps:
 *
 *   npx tsx scripts/cli-check/ci.ts matrix                which new versions to check: each CLI that is
 *                                                         behind and whose issue has no report of its
 *                                                         newest yet (on a pull request: every CLI's newest,
 *                                                         reported nowhere)
 *   npx tsx scripts/cli-check/ci.ts check <cli> <version> gets that version and the one checked apart
 *                                                         (`obtain.ts`), records what the one checked says
 *                                                         here (`--record`), checks the new one against it
 *                                                         (`--against`), and writes the report
 *   npx tsx scripts/cli-check/ci.ts report <folder>       posts each report there to its CLI's issue, once
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
import { parseMarker, versionRows, type OpenIssue, type VersionRow } from './versions';

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

/**
 * Which versions to check: on a schedule or by hand, each CLI that is behind and whose open issue
 * (which the step before keeps) holds no report of its newest yet, so that a version is checked once;
 * on a pull request that changes the check, every CLI's newest, to try the check itself.
 */
export function ciMatrix(rows: readonly VersionRow[], issues: readonly IssueWithComments[] | 'pull_request'): MatrixEntry[] {
  if (issues === 'pull_request') return rows.filter((r) => r.latest).map((r) => ({ cli: r.provider, version: r.latest! }));
  return rows
    .filter((r) => r.status === 'behind' && r.latest)
    .filter((r) => {
      const issue = issues.find((i) => parseMarker(i.body)?.provider === r.provider);
      return issue !== undefined && !reported(issue, r.provider, r.latest!);
    })
    .map((r) => ({ cli: r.provider, version: r.latest! }));
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

/** The comment a report is posted as. */
export function reportComment(r: Report): string {
  const label = `${PROVIDER_LABEL[r.cli]} ${r.version}`;
  const how = r.against
    ? `against ${r.checked}, which it ran there too, the same way`
    : `against the shapes this repository keeps for ${r.checked}, recorded on another system${r.againstError ? ` (${r.checked} could not be compared with here: ${r.againstError})` : ''}`;
  const verdict = r.error
    ? `It could not be checked: ${r.error}`
    : r.exit === 0
      ? `Layers 2 and 3 found nothing new. Read the release notes' lines in the report and run the live tests before moving it forward.`
      : r.exit === 1
        ? `It found something to look at: the report says what, layer by layer.`
        : `The check did not finish (exit ${r.exit ?? 'none'}): the report shows how far it got.`;
  let text = r.text.replace(ANSI, '').trimEnd();
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (cut: the whole report is in the workflow run's artifacts)`;
  return [
    `### ${label}, checked on ${r.system}`,
    '',
    `Checked by the CLI versions workflow ${how}. ${verdict}`,
    '',
    ...(text ? ['<details><summary>The report</summary>', '', fenced(text), '', '</details>', ''] : []),
    reportMarker(r.cli, r.version),
  ].join('\n');
}

/** Posts each report in `reports` to its CLI's open issue, once: says what it did, a line each. */
export async function postReports(reports: readonly Report[], gh: Gh): Promise<string[]> {
  const issues = JSON.parse(
    await gh(['issue', 'list', '--label', 'cli-check', '--state', 'open', '--json', 'number,title,body,comments', '--limit', '200']),
  ) as IssueWithComments[];
  const out: string[] = [];
  for (const r of reports) {
    const issue = issues.find((i) => parseMarker(i.body)?.provider === r.cli);
    if (!issue) out.push(`${PROVIDER_LABEL[r.cli]} ${r.version}: no open issue to report to`);
    else if (reported(issue, r.cli, r.version)) out.push(`${PROVIDER_LABEL[r.cli]} ${r.version}: already reported in #${issue.number}`);
    else {
      await gh(['issue', 'comment', String(issue.number), '--body-file', '-'], reportComment(r));
      out.push(`${PROVIDER_LABEL[r.cli]} ${r.version}: reported in #${issue.number}`);
    }
  }
  return out;
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
    const matrix = ciMatrix(rows, issues);
    console.log(matrix.length ? matrix.map((m) => `${m.cli} ${m.version}`).join('\n') : 'Nothing new to check.');
    output('matrix', JSON.stringify(matrix));
    output('count', String(matrix.length));
  } else if (command === 'check' && a && b && (PROVIDERS as readonly string[]).includes(a)) {
    await check(a as Provider, b);
  } else if (command === 'report' && a) {
    for (const line of await postReports(findReports(a), gh)) console.log(line);
  } else {
    console.error('Usage: npx tsx scripts/cli-check/ci.ts matrix | check <cli> <version> | report <folder>');
    process.exit(2);
  }
}

// Run as a script only: the tests import the functions above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
