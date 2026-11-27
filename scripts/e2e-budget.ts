/**
 * The end-to-end tests' time, checked on CI (.github/workflows/e2e.yml), so that the suite does not
 * grow slower unnoticed: each test starts a server, a browser and agents of its own, and a few seconds
 * more in a helper every test uses, or a test that does far more than it needs, add up to minutes on
 * every run.
 *
 * - After each job (one half of the tests, `--shard`): `node scripts/e2e-budget.ts <results.json>`
 *   lists the tests that passed but used more than NEAR_LIMIT of their own time limit (`timeout`,
 *   `test.setTimeout()`, `test.slow()`), as warnings, and the slowest. A slower runner would see them
 *   time out (as the Teams sign-in test did on Windows, which had passed at 88% of its limit): make
 *   them faster, or give them the time they need. It never fails the job.
 * - Once every job passed (the workflow's last check): `node scripts/e2e-budget.ts --runs <folder>
 *   --parts <n>` adds up, for each system and Node.js whose halves all ran, the minutes of test time its
 *   tests took in Chromium (each one's last attempt: a retry is a flaky test's cost, not the suite's),
 *   from the jobs' reports downloaded into the folder, and compares them with that system's budget
 *   (BUDGET_MINUTES). Over it, the check fails on the systems in ENFORCED (Linux, whose runners take
 *   about the same time from one run to the next); on macOS and Windows, whose runners vary too much,
 *   it is reported. The whole suite, not each half: the halves are split by test count, so a test added
 *   anywhere moves others from one to the other. A change that makes the suite slower for a good reason
 *   raises the budget in the same commit, saying why: the budget only moves on purpose.
 *
 * The system is RUNNER_OS in GitHub Actions (`--system Linux|macOS|Windows` elsewhere). The summary
 * goes to $GITHUB_STEP_SUMMARY when it is set, the warnings and errors are annotations there.
 *
 * Only erasable TypeScript here, and only Node's own modules: the workflow runs it with plain `node`.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SYSTEMS = ['Linux', 'macOS', 'Windows'] as const;
export type System = (typeof SYSTEMS)[number];

/**
 * Minutes of test time the whole suite may take on each system, in Chromium (both halves). Set from
 * the runs around the pull request that added this check (2026-11-27): Linux 39.3 to 44.8 before it,
 * and 39.3 to 44.5 with it (runs 46016782311, 46023478808, 46028020230), macOS 46.7 to 57.1 and 48.8
 * to 56.0, Windows 81.2 to 126.2; with room for a runner's day (Linux's, the one enforced, about a
 * quarter over the slowest of those runs).
 */
export const BUDGET_MINUTES: Record<System, number> = { Linux: 56, macOS: 70, Windows: 130 };

/** The systems whose budget fails the check; the others' is reported. */
export const ENFORCED: readonly System[] = ['Linux'];

/** The share of its own time limit a test that passed may use before it is listed as near it. */
export const NEAR_LIMIT = 0.7;

/** The browser the budget is for: a run by hand may add others (E2E_BROWSERS), only reported. */
export const BUDGET_PROJECT = 'chromium';

/** The runner each system's jobs run on, as their reports are named (`e2e-report-<runner>-node…`). */
export const RUNNERS: Record<string, System> = { 'ubuntu-latest': 'Linux', 'macos-latest': 'macOS', 'windows-latest': 'Windows' };

/** Where a job's results are in its report (playwright.config.ts writes them on CI). */
export const RESULTS_FILE = join('test-results', 'e2e-results.json');

/** What the check needs of Playwright's JSON report (`JSONReport` in @playwright/test/reporter). */
export interface Report {
  suites: Suite[];
}
interface Suite {
  title: string;
  file: string;
  specs: Spec[];
  suites?: Suite[];
}
interface Spec {
  title: string;
  file: string;
  line: number;
  tests: { timeout: number; projectName: string; status: string; results: { duration: number; status?: string }[] }[];
}

/** One test as it ran: its last attempt. */
export interface Ran {
  title: string;
  file: string;
  line: number;
  project: string;
  /** Milliseconds its last attempt took. */
  ms: number;
  /** Its own time limit, in milliseconds (0: none). */
  timeout: number;
  passed: boolean;
}

/** Every test that ran (not those skipped), with its last attempt's time. */
export function testsOf(report: Report): Ran[] {
  const out: Ran[] = [];
  const walk = (suite: Suite, titles: string[]) => {
    for (const spec of suite.specs) {
      for (const t of spec.tests) {
        const last = t.results.at(-1);
        if (!last || t.status === 'skipped' || last.status === 'skipped') continue;
        out.push({
          title: [...titles, spec.title].join(' › '),
          file: spec.file,
          line: spec.line,
          project: t.projectName,
          ms: last.duration,
          timeout: t.timeout,
          passed: last.status === 'passed',
        });
      }
    }
    for (const s of suite.suites ?? []) walk(s, [...titles, ...(s.title && s.title !== s.file ? [s.title] : [])]);
  };
  for (const s of report.suites) walk(s, []);
  return out;
}

/** The tests that passed but used more than NEAR_LIMIT of their time limit, nearest to it first. */
export function nearLimit(ran: readonly Ran[]): Ran[] {
  return ran.filter((t) => t.passed && t.timeout > 0 && t.ms > NEAR_LIMIT * t.timeout).sort((a, b) => b.ms / b.timeout - a.ms / a.timeout);
}

/** The budget's browser's tests. */
export const budgeted = (ran: readonly Ran[]): Ran[] => ran.filter((t) => t.project === BUDGET_PROJECT);

/** The budget's browser's minutes of test time. */
export function minutesOf(ran: readonly Ran[]): number {
  return budgeted(ran).reduce((sum, t) => sum + t.ms, 0) / 60_000;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const where = (t: Ran) => `${t.file}:${t.line}`;
/**
 * A cell of a Markdown table: no line break, and every `\` and `|` escaped (in one expression, so that a
 * title's own backslash cannot undo the escape of the `|` after it and end the cell).
 */
const cell = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[\\|]/g, '\\$&');
// A workflow command's message escapes %, CR and LF; a property also : and ,.
const data = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s: string) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** One job's summary: its tests near their limit, and the slowest. */
export function jobSummary(system: System, ran: readonly Ran[]): string {
  const near = nearLimit(ran);
  const lines = [
    `### End-to-end tests' time (${system}, this half)`,
    '',
    `${budgeted(ran).length} tests in ${BUDGET_PROJECT} took ${minutesOf(ran).toFixed(1)} minutes of test time.`,
    '',
  ];
  if (near.length) {
    lines.push(
      `**Near their time limit** (passed, but used more than ${Math.round(NEAR_LIMIT * 100)}% of it): a slower runner would see them time out.`,
      '',
    );
    lines.push('| Test | Took | Limit | Share |', '| --- | --- | --- | --- |');
    for (const t of near)
      lines.push(
        `| ${cell(t.title)} (\`${cell(where(t))}\`) | ${seconds(t.ms)} | ${seconds(t.timeout)} | ${Math.round((100 * t.ms) / t.timeout)}% |`,
      );
    lines.push('');
  }
  lines.push('The slowest:', '', '| Test | Took |', '| --- | --- |');
  for (const t of [...ran].sort((a, b) => b.ms - a.ms).slice(0, 10))
    lines.push(`| ${cell(t.title)} (\`${cell(where(t))}\`) | ${seconds(t.ms)} |`);
  return lines.join('\n') + '\n';
}

/** One job's annotations: a warning for each test near its limit. */
export function jobAnnotations(system: System, ran: readonly Ran[]): string[] {
  return nearLimit(ran).map(
    (t) =>
      `::warning file=${prop(`e2e/specs/${t.file}`)},line=${t.line}::${data(`Near its time limit on ${system}: ${seconds(t.ms)} of ${seconds(t.timeout)} (${t.title})`)}`,
  );
}

/** One job's report as the workflow downloaded it: `e2e-report-<runner>-node<N>-part<P>-attempt<A>`. */
export interface Job {
  name: string;
  system: System;
  node: string;
  part: number;
  attempt: number;
}

const REPORT_NAME = /^e2e-report-(.+)-node(\d+)-part(\d+)-attempt(\d+)$/;

/** The jobs' reports among these folder names, the latest attempt of each job (a job run again uploads beside the one before). */
export function latestJobs(names: readonly string[]): Job[] {
  const latest = new Map<string, Job>();
  for (const name of names) {
    const m = REPORT_NAME.exec(name);
    const system = m && RUNNERS[m[1]!];
    if (!m || !system) continue;
    const job: Job = { name, system, node: m[2]!, part: Number(m[3]), attempt: Number(m[4]) };
    const key = `${system} ${job.node} ${job.part}`;
    if ((latest.get(key)?.attempt ?? 0) < job.attempt) latest.set(key, job);
  }
  return [...latest.values()].sort((a, b) => a.system.localeCompare(b.system) || Number(a.node) - Number(b.node) || a.part - b.part);
}

/** The jobs' reports whose name or runner the check does not know: they would not be counted (a renamed runner, say). */
export function unknownReports(names: readonly string[]): string[] {
  return names.filter((n) => n.startsWith('e2e-report-') && !RUNNERS[REPORT_NAME.exec(n)?.[1] ?? '']);
}

/** A system and Node.js's whole suite against the budget. */
export interface Verdict {
  system: System;
  node: string;
  /** Its halves' minutes, in order; undefined when it could not be counted (`missing` says why). */
  halves?: number[];
  missing?: string;
  minutes: number;
  budget: number;
  enforced: boolean;
  over: boolean;
}

/**
 * Each system and Node.js's suite, from its jobs' tests: all `parts` halves, each with tests in the
 * budget's browser, or it is not counted (never 0 minutes within the budget).
 */
export function verdicts(jobs: readonly { job: Job; ran: readonly Ran[] }[], parts: number): Verdict[] {
  const groups = new Map<string, { job: Job; ran: readonly Ran[] }[]>();
  for (const j of jobs) {
    const key = `${j.job.system} ${j.job.node}`;
    groups.set(key, [...(groups.get(key) ?? []), j]);
  }
  return [...groups.values()].map((group) => {
    const { system, node } = group[0]!.job;
    const whole = group.length === parts && new Set(group.map((g) => g.job.part)).size === parts;
    const missing = !whole
      ? "a half's results are missing"
      : group.some((g) => !budgeted(g.ran).length)
        ? `a half ran no test in ${BUDGET_PROJECT}`
        : undefined;
    const halves = missing ? undefined : group.map((g) => minutesOf(g.ran));
    const minutes = halves ? halves.reduce((a, b) => a + b, 0) : 0;
    const budget = BUDGET_MINUTES[system];
    return {
      system,
      node,
      ...(halves ? { halves } : { missing }),
      minutes,
      budget,
      enforced: ENFORCED.includes(system),
      over: Boolean(halves) && minutes > budget,
    };
  });
}

export function budgetSummary(list: readonly Verdict[]): string {
  const lines = [
    "### End-to-end tests' time against their budget",
    '',
    '| System | Node.js | Minutes of test time | Budget | |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const v of list) {
    const status = !v.halves
      ? `not counted: ${v.missing}`
      : !v.over
        ? 'within it'
        : v.enforced
          ? '**over it**'
          : 'over it (reported only: its runners vary too much)';
    const minutes = v.halves ? `${v.minutes.toFixed(1)} (${v.halves.map((h) => h.toFixed(1)).join(' + ')})` : '—';
    lines.push(`| ${v.system} | ${v.node} | ${minutes} | ${v.budget} | ${status} |`);
  }
  if (list.some((v) => v.over && v.enforced))
    lines.push('', 'Make the tests faster, or raise `BUDGET_MINUTES` in scripts/e2e-budget.ts in the same commit, saying why.');
  return lines.join('\n') + '\n';
}

/**
 * An error for each suite over an enforced budget, for one on an enforced system that could not be
 * counted, and for an enforced system with no results at all (the results were not where the check
 * reads them, or its runner was renamed: it would pass whatever the time); a warning for a suite over a
 * reported budget, for one on another system that could not be counted, and for a report the check
 * does not know.
 */
export function budgetAnnotations(list: readonly Verdict[], unknown: readonly string[] = []): string[] {
  const out = list.flatMap((v) =>
    !v.halves
      ? [
          `::${v.enforced ? 'error' : 'warning'}::${data(`The end-to-end tests' time on ${v.system} with Node.js ${v.node} was not counted: ${v.missing}`)}`,
        ]
      : v.over
        ? [
            `::${v.enforced ? 'error' : 'warning'}::${data(
              `The end-to-end tests took ${v.minutes.toFixed(1)} minutes of test time on ${v.system} with Node.js ${v.node}, over their budget of ${v.budget} (scripts/e2e-budget.ts)`,
            )}`,
          ]
        : [],
  );
  for (const system of ENFORCED)
    if (!list.some((v) => v.system === system))
      out.push(
        `::error::${data(`No end-to-end results for ${system} to check against the budget (${RESULTS_FILE} in each job's report)`)}`,
      );
  for (const name of unknown)
    out.push(`::warning::${data(`Not counted, from a runner the check does not know (RUNNERS in scripts/e2e-budget.ts): ${name}`)}`);
  return out;
}

/** Whether the check fails: a suite over an enforced budget, or an enforced system's suite not counted. */
export const fails = (list: readonly Verdict[]): boolean =>
  list.some((v) => v.enforced && (v.over || !v.halves)) || ENFORCED.some((system) => !list.some((v) => v.system === system));

function output(lines: readonly string[], text: string): void {
  for (const line of lines) console.log(line);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

const USAGE = `Usage: node scripts/e2e-budget.ts <Playwright's JSON results> [--system ${SYSTEMS.join('|')}]
       node scripts/e2e-budget.ts --runs <folder of the jobs' reports> --parts <n>`;

function main(args: string[]): number {
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const runs = flag('--runs');
  if (runs !== undefined) {
    const parts = Number(flag('--parts'));
    if (!Number.isInteger(parts) || parts < 1) {
      console.error(USAGE);
      return 2;
    }
    // Never a stack trace: what went wrong, as the check's own error.
    try {
      const names = readdirSync(runs);
      const missing: string[] = [];
      const jobs = latestJobs(names).flatMap((job) => {
        const file = join(runs, job.name, RESULTS_FILE);
        if (!existsSync(file)) {
          missing.push(`::warning::${data(`No results in ${job.name} (${RESULTS_FILE}): its half is not counted`)}`);
          return [];
        }
        return [{ job, ran: testsOf(JSON.parse(readFileSync(file, 'utf8')) as Report) }];
      });
      const list = verdicts(jobs, parts);
      output([...missing, ...budgetAnnotations(list, unknownReports(names))], budgetSummary(list));
      return fails(list) ? 1 : 0;
    } catch (err) {
      console.log(`::error::${data(`Could not check the end-to-end tests' time: ${err instanceof Error ? err.message : String(err)}`)}`);
      return 1;
    }
  }
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--system');
  const system = (flag('--system') ?? process.env.RUNNER_OS) as System | undefined;
  if (!file || !system || !SYSTEMS.includes(system)) {
    console.error(USAGE);
    return 2;
  }
  // Never the job's failure: its tests passed, and the whole suite is checked in the last check.
  let ran: Ran[];
  try {
    ran = testsOf(JSON.parse(readFileSync(file, 'utf8')) as Report);
  } catch (err) {
    console.log(`::warning::${data(`Could not read the tests' results (${file}): ${err instanceof Error ? err.message : String(err)}`)}`);
    return 0;
  }
  output(jobAnnotations(system, ran), jobSummary(system, ran));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
