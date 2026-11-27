import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUDGET_MINUTES,
  ENFORCED,
  NEAR_LIMIT,
  RESULTS_FILE,
  budgetAnnotations,
  budgetSummary,
  fails,
  jobAnnotations,
  jobSummary,
  latestJobs,
  minutesOf,
  nearLimit,
  testsOf,
  verdicts,
  type Job,
  type Report,
} from '../scripts/e2e-budget';

type Result = { duration: number; status?: string };
const spec = (title: string, line: number, tests: { timeout?: number; project?: string; status?: string; results: Result[] }[]) => ({
  title,
  file: 'chat.spec.ts',
  line,
  tests: tests.map((t) => ({
    timeout: t.timeout ?? 60_000,
    projectName: t.project ?? 'chromium',
    status: t.status ?? 'expected',
    results: t.results,
  })),
});
const min = (m: number) => m * 60_000;
/** A report of one test that took `ms`. */
const one = (ms: number, timeout = min(1000)): Report => ({
  suites: [
    { title: 'x.spec.ts', file: 'x.spec.ts', specs: [spec('long', 1, [{ timeout, results: [{ duration: ms, status: 'passed' }] }])] },
  ],
});

/** A report of a file's tests, one level of `test.describe` deep for the second half. */
function report(): Report {
  return {
    suites: [
      {
        title: 'chat.spec.ts',
        file: 'chat.spec.ts',
        specs: [
          // Retried: the last attempt counts, not the one that timed out.
          spec('a flaky test', 10, [
            {
              status: 'flaky',
              results: [
                { duration: 60_000, status: 'timedOut' },
                { duration: 20_000, status: 'passed' },
              ],
            },
          ]),
          spec('a skipped test', 20, [{ status: 'skipped', results: [{ duration: 0, status: 'skipped' }] }]),
          // Another browser (a run by hand): not in the budget, but near its limit as any test (50 of 60 s).
          spec('in WebKit', 30, [{ project: 'webkit', results: [{ duration: 50_000, status: 'passed' }] }]),
        ],
        suites: [
          {
            title: 'a group',
            file: 'chat.spec.ts',
            specs: [
              // 44 of 60 s: past NEAR_LIMIT (70%).
              spec('near its limit', 40, [{ results: [{ duration: 44_000, status: 'passed' }] }]),
              // 50 of 150 s (its own setTimeout): far from it.
              spec('with a longer limit', 50, [{ timeout: 150_000, results: [{ duration: 50_000, status: 'passed' }] }]),
              // Failed: no warning for being near its limit (it is a failure already), but its time counts.
              spec('a failure', 60, [{ status: 'unexpected', results: [{ duration: 59_000, status: 'failed' }] }]),
            ],
          },
        ],
      },
    ],
  };
}

const job = (system: Job['system'], node: string, part: number): Job => ({
  name: `${system}-${node}-${part}`,
  system,
  node,
  part,
  attempt: 1,
});

describe("one job's tests", () => {
  it('takes each test that ran, by its last attempt, with its group in its title', () => {
    expect(testsOf(report()).map((t) => [t.title, t.ms, t.project, t.passed])).toEqual([
      ['a flaky test', 20_000, 'chromium', true],
      ['in WebKit', 50_000, 'webkit', true],
      ['a group › near its limit', 44_000, 'chromium', true],
      ['a group › with a longer limit', 50_000, 'chromium', true],
      ['a group › a failure', 59_000, 'chromium', false],
    ]);
  });

  it("counts Chromium's minutes, and lists the tests that passed near their own limit, nearest first, of any browser", () => {
    const ran = testsOf(report());
    expect(minutesOf(ran)).toBeCloseTo((20 + 44 + 50 + 59) / 60);
    expect(NEAR_LIMIT).toBe(0.7);
    // 83%, then 73%.
    expect(nearLimit(ran).map((t) => t.title)).toEqual(['in WebKit', 'a group › near its limit']);
    const text = jobSummary('Linux', ran);
    expect(text).toContain('5 tests took 2.9 minutes of test time in chromium.');
    expect(text).toContain('| a group › near its limit (`chat.spec.ts:40`) | 44.0 s | 60.0 s | 73% |');
    // The slowest first.
    expect(text.slice(text.indexOf('The slowest:'))).toMatch(
      /a failure.*\n.*in WebKit.*\n.*with a longer limit.*\n.*near its limit.*\n.*a flaky test/,
    );
  });

  it("escapes a test's title for the annotations and the summary's table", () => {
    const odd: Report = {
      suites: [
        { title: 'x', file: 'x.spec.ts', specs: [spec('a | b, c: 100%\nd', 7, [{ results: [{ duration: 50_000, status: 'passed' }] }])] },
      ],
    };
    const ran = testsOf(odd);
    expect(jobAnnotations('macOS', ran)).toEqual([
      '::warning file=e2e/specs/chat.spec.ts,line=7::Near its time limit on macOS: 50.0 s of 60.0 s (a | b, c: 100%25%0Ad)',
    ]);
    expect(jobSummary('macOS', ran)).toContain('| a \\| b, c: 100% d (`chat.spec.ts:7`) | 50.0 s | 60.0 s | 83% |');
  });

  it("keeps a title's own backslash from undoing the escape of a `|`, which would end the cell", () => {
    // `a\|b` and a title ending in `\`: each `\` and `|` escaped, so no `|` is left unescaped in the title.
    for (const [title, escaped] of [
      ['a\\|b', 'a\\\\\\|b'],
      ['ends in \\', 'ends in \\\\'],
      ['\\\\|', '\\\\\\\\\\|'],
    ]) {
      const ran = testsOf({
        suites: [{ title: 'x', file: 'x.spec.ts', specs: [spec(title, 1, [{ results: [{ duration: 1000, status: 'passed' }] }])] }],
      });
      const row = jobSummary('Linux', ran)
        .split('\n')
        .find((l) => l.includes('chat.spec.ts:1'))!;
      expect(row, title).toBe(`| ${escaped} (\`chat.spec.ts:1\`) | 1.0 s |`);
      // Split as GitHub splits a row: on each `|` an odd number of backslashes does not escape.
      const cells = row.slice(1, -1).split(/(?<!(?:^|[^\\])(?:\\\\)*\\)\|/);
      expect(cells, title).toHaveLength(2);
    }
  });
});

describe('the whole suite against its budget', () => {
  it("takes each job's latest attempt from the reports' names, and nothing else", () => {
    expect(
      latestJobs([
        'e2e-report-ubuntu-latest-node24-part1-attempt1',
        'e2e-report-ubuntu-latest-node24-part2-attempt1',
        // Run again: this one counts.
        'e2e-report-ubuntu-latest-node24-part2-attempt2',
        'e2e-report-windows-latest-node24-part1-attempt1',
        'e2e-report-ubuntu-latest-node22-part1-attempt1',
        'e2e-report-some-other-runner-node24-part1-attempt1',
        'cli-check-report',
      ]).map((j) => j.name),
    ).toEqual([
      'e2e-report-ubuntu-latest-node22-part1-attempt1',
      'e2e-report-ubuntu-latest-node24-part1-attempt1',
      'e2e-report-ubuntu-latest-node24-part2-attempt2',
      'e2e-report-windows-latest-node24-part1-attempt1',
    ]);
  });

  it('adds up both halves for each system and Node.js; over the budget fails on Linux alone, a missing half is not counted', () => {
    expect(ENFORCED).toEqual(['Linux']);
    const half = (m: number) => testsOf(one(min(m)));
    const list = verdicts(
      [
        { job: job('Linux', '24', 1), ran: half(BUDGET_MINUTES.Linux / 2) },
        { job: job('Linux', '24', 2), ran: half(BUDGET_MINUTES.Linux / 2 + 1) },
        { job: job('Linux', '22', 1), ran: half(1) },
        { job: job('Linux', '22', 2), ran: half(1) },
        { job: job('Windows', '24', 1), ran: half(BUDGET_MINUTES.Windows) },
        { job: job('Windows', '24', 2), ran: half(1) },
        { job: job('macOS', '24', 1), ran: half(BUDGET_MINUTES.macOS * 2) },
      ],
      2,
    );
    expect(list.map((v) => [v.system, v.node, v.minutes, v.over, v.enforced])).toEqual([
      ['Linux', '24', BUDGET_MINUTES.Linux + 1, true, true],
      ['Linux', '22', 2, false, true],
      ['Windows', '24', BUDGET_MINUTES.Windows + 1, true, false],
      // One half: not counted, never over.
      ['macOS', '24', 0, false, false],
    ]);
    expect(fails(list)).toBe(true);
    expect(budgetAnnotations(list)).toEqual([
      `::error::The end-to-end tests took ${(BUDGET_MINUTES.Linux + 1).toFixed(1)} minutes of test time on Linux with Node.js 24, over their budget of ${BUDGET_MINUTES.Linux} (scripts/e2e-budget.ts)`,
      `::warning::The end-to-end tests took ${(BUDGET_MINUTES.Windows + 1).toFixed(1)} minutes of test time on Windows with Node.js 24, over their budget of ${BUDGET_MINUTES.Windows} (scripts/e2e-budget.ts)`,
      "::warning::The end-to-end tests' time on macOS with Node.js 24 was not counted: a half's results are missing",
    ]);
    const text = budgetSummary(list);
    expect(text).toContain(
      `| Linux | 24 | ${(BUDGET_MINUTES.Linux + 1).toFixed(1)} (${(BUDGET_MINUTES.Linux / 2).toFixed(1)} + ${(BUDGET_MINUTES.Linux / 2 + 1).toFixed(1)}) | ${BUDGET_MINUTES.Linux} | **over it** |`,
    );
    expect(text).toContain('| Linux | 22 | 2.0 (1.0 + 1.0) |');
    expect(text).toContain('over it (reported only: its runners vary too much)');
    expect(text).toContain('| macOS | 24 | — |');
    expect(text).toContain('raise `BUDGET_MINUTES` in scripts/e2e-budget.ts in the same commit, saying why');
    // Within it everywhere: passes.
    expect(fails(list.filter((v) => !v.over))).toBe(false);
  });

  it('fails when no suite could be counted, which would pass whatever the time', () => {
    expect(fails([])).toBe(true);
    expect(budgetAnnotations([])).toEqual([
      `::error::No end-to-end results to check against the budget (${RESULTS_FILE} in each job's report)`,
    ]);
  });

  it('runs as the workflow runs it, on the reports as they are downloaded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-e2e-budget-'));
    try {
      const put = (name: string, r: Report) => {
        mkdirSync(join(dir, name, 'test-results'), { recursive: true });
        writeFileSync(join(dir, name, RESULTS_FILE), JSON.stringify(r));
      };
      put('e2e-report-ubuntu-latest-node24-part1-attempt1', one(min(1)));
      put('e2e-report-ubuntu-latest-node24-part2-attempt1', one(min(1)));
      const run = (...args: string[]) =>
        spawnSync(process.execPath, ['scripts/e2e-budget.ts', ...args], {
          encoding: 'utf8',
          env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
        });
      const within = run('--runs', dir, '--parts', '2');
      expect(within.status, within.stderr).toBe(0);
      expect(within.stdout).toContain('| Linux | 24 | 2.0 (1.0 + 1.0) |');
      // Run again, over the budget: the latest attempt counts.
      put('e2e-report-ubuntu-latest-node24-part2-attempt2', one(min(BUDGET_MINUTES.Linux)));
      const over = run('--runs', dir, '--parts', '2');
      expect(over.status).toBe(1);
      expect(over.stdout).toMatch(/^::error::The end-to-end tests took/m);
      // One job's results: its warnings and slowest, never a failure.
      const single = run(join(dir, 'e2e-report-ubuntu-latest-node24-part1-attempt1', RESULTS_FILE), '--system', 'Linux');
      expect(single.status, single.stderr).toBe(0);
      expect(single.stdout).toContain("End-to-end tests' time (Linux, this half)");
      // Without how many halves there are: refused.
      expect(run('--runs', dir).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the results where Playwright's config writes them on CI, and counts the halves the workflow splits the tests into", () => {
    const config = readFileSync('playwright.config.ts', 'utf8');
    const workflow = readFileSync('.github/workflows/e2e.yml', 'utf8');
    expect(config).toContain(`const E2E_RESULTS = '${RESULTS_FILE.replace(/\\/g, '/')}';`);
    expect(config).toMatch(/\['json', \{ outputFile: E2E_RESULTS \}\]/);
    expect(workflow).toContain(`run: node scripts/e2e-budget.ts ${RESULTS_FILE.replace(/\\/g, '/')}\n`);
    const parts = /^ {8}part: \[([\d, ]+)\]$/m.exec(workflow)![1]!.split(',').length;
    expect(workflow).toContain(`--shard=\${{ matrix.part }}/${parts}`);
    expect(workflow).toContain(`run: node scripts/e2e-budget.ts --runs "$RUNNER_TEMP/e2e-reports" --parts ${parts}\n`);
    // Each report's name, as latestJobs() reads it.
    expect(workflow).toContain(
      'name: e2e-report-${{ matrix.os }}-node${{ matrix.node }}-part${{ matrix.part }}-attempt${{ github.run_attempt }}',
    );
    for (const os of /^ {8}os: \[([^\]]+)\]$/m.exec(workflow)![1]!.split(/,\s*/))
      expect(latestJobs([`e2e-report-${os}-node24-part1-attempt1`]), os).toHaveLength(1);
  });
});
