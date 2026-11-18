/**
 * Checks an agent CLI's new version against what Harness Relay's adapter relies on, in layers,
 * cheapest first (docs/developer-guide.md, "Checking a CLI's new version"; #103):
 *
 *   1. versions   the version each CLI was checked with (src/shared/cliVersions.ts), the newest its
 *                 maker published and the one on this computer
 *   2. probe      what Harness Relay asks the CLI without a prompt (status, models, native lists,
 *                 usage, its first handshake) and its --help's flags, recorded and reduced to their
 *                 shape, against the shape saved for the version checked; no model, no tokens
 *   3. run        the recording scenarios, through the adapter's own runner, against the real CLI on
 *                 a scripted model of this computer's own (scripts/cli-check/model.ts): their checks
 *                 (the protected file's contents never reach the model, a refused write leaves no
 *                 file…) and their recordings' shapes
 *   4. changelog  the maker's release notes since the version checked, the lines about permissions,
 *                 sandboxes, hooks, settings, sessions and the like picked out; and the slower checks
 *                 the CLI needs (sandbox-check, mcp-headers-check), with their commands
 *   5.            the live tests for it, named with what they need (npm run test:e2e:live)
 *
 *   npx tsx scripts/cli-check.ts                       every CLI that is behind: layers 1 to 4
 *   npx tsx scripts/cli-check.ts <cli> [--bin <path>]  one CLI, layers 1 to 4, whatever its version
 *   npx tsx scripts/cli-check.ts versions [--json] [--issues [--dry-run]]
 *   npx tsx scripts/cli-check.ts probe <cli> [--bin <path>] [--accept]
 *   npx tsx scripts/cli-check.ts run <cli> [--bin <path>] [--only <scenario>] [--accept]
 *   npx tsx scripts/cli-check.ts changelog <cli> [--from <version>] [--to <version>] [--bin <path>]
 *
 * --bin: the CLI to check (default: its name on the PATH). --accept: save what was recorded as the
 * shapes of the version checked (test/fixtures/cli-check/<cli>/), once what changed was looked at.
 * --keep: keep the scratch folders (their paths are printed). --json: the versions as JSON. --issues:
 * keep the workflow's issues, through gh (the CLI versions workflow, .github/workflows/cli-versions.yml);
 * with --dry-run, only say what it would do with them. An option it does not know is refused.
 *
 * Every CLI runs in a scratch folder of its own (scripts/cli-check/scratch.ts): a home, the XDG
 * folders, Harness Relay's data folder, none of your variables but the PATH and the locale, no
 * auto-update, no browser. It is never signed in and never reaches a model service: layer 3's model
 * is on 127.0.0.1. macOS and Linux only.
 */
import { CHECKED_VERSIONS } from '../src/shared/cliVersions';
import { PROVIDERS, PROVIDER_LABEL, type Provider } from '../src/shared/types';
import { cliEnv, isolate, makeScratch, type Scratch } from './cli-check/scratch';
import {
  ISSUE_LABEL,
  planIssues,
  versionRows,
  versionTable,
  type IssueAction,
  type OpenIssue,
  type VersionRow,
} from './cli-check/versions';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--bin', '--only', '--from', '--to'].includes(argv[i - 1] ?? ''));
const COMMANDS = ['versions', 'probe', 'run', 'changelog'] as const;
type Command = (typeof COMMANDS)[number] | 'all';
const command: Command = (COMMANDS as readonly string[]).includes(positional[0] ?? '') ? (positional.shift() as Command) : 'all';
const cliArg = positional[0];

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    [
      'Usage:',
      '  npx tsx scripts/cli-check.ts [<cli>] [--bin <path>] [--keep]',
      '  npx tsx scripts/cli-check.ts versions [--json] [--issues [--dry-run]]',
      '  npx tsx scripts/cli-check.ts probe <cli> [--bin <path>] [--accept] [--keep]',
      '  npx tsx scripts/cli-check.ts run <cli> [--bin <path>] [--only <scenario>] [--accept] [--keep]',
      '  npx tsx scripts/cli-check.ts changelog <cli> [--from <version>] [--to <version>] [--bin <path>]',
      `<cli>: ${PROVIDERS.join(', ')}`,
    ].join('\n'),
  );
  process.exit(2);
}

// A flag it does not know is refused, never passed over: a mistyped --dry-run must not keep the issues for real.
const FLAGS = ['--bin', '--only', '--from', '--to', '--accept', '--keep', '--json', '--issues', '--dry-run'];
const unknownFlag = argv.find((a) => a.startsWith('--') && !FLAGS.includes(a));
if (unknownFlag) usage(`Unknown option: ${unknownFlag}`);
if (flag('--dry-run') && !flag('--issues')) usage('--dry-run goes with versions --issues.');
const provider = cliArg as Provider | undefined;
if (provider && !(PROVIDERS as readonly string[]).includes(provider)) usage(`Unknown CLI: ${provider}`);
if ((command === 'probe' || command === 'run' || command === 'changelog') && !provider) usage(`${command} needs a CLI.`);
if (process.platform === 'win32' && command !== 'versions' && command !== 'changelog') usage('Layers 2 and 3 run on macOS and Linux only.');

// ---------------------------------------------------------------------------
// Layer 1

/** The CLI to check: `--bin`, else its name on the PATH (`DEFAULT_BIN`, imported once isolated). */
async function binOf(p: Provider): Promise<string> {
  const given = option('--bin');
  if (given && provider === p) return given;
  const { DEFAULT_BIN } = await import('../src/server/settings');
  return DEFAULT_BIN[p];
}

/** What `--version` says on this computer, in a scratch home; undefined when it is not there. */
async function installedVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const { capture, CommandNotFoundError } = await import('../src/server/process');
  const { parseVersion } = await import('../src/server/providers');
  try {
    const r = await capture(bin, ['--version'], env, { timeoutMs: 30_000 });
    return parseVersion(r.stdout || r.stderr) ?? `? (${(r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 80)})`;
  } catch (err) {
    if (err instanceof CommandNotFoundError) return undefined;
    return `error: ${(err as Error).message}`;
  }
}

/** Layer 1; each CLI's version here too, asked in `scratch` (none: not asked, as the workflow does). */
async function layerVersions(only: readonly Provider[], scratch?: Scratch): Promise<VersionRow[]> {
  const rows = await versionRows(only);
  if (scratch) {
    for (const r of rows) {
      const v = await installedVersion(await binOf(r.provider), cliEnv(r.provider, scratch.env));
      if (v) r.installed = v;
    }
  }
  return rows;
}

/** gh, with this process's environment (its token), started directly. */
async function gh(args: string[], stdin?: string): Promise<string> {
  const { runProcess } = await import('../src/server/process');
  const repo = process.env.GITHUB_REPOSITORY ? ['--repo', process.env.GITHUB_REPOSITORY] : [];
  const r = await runProcess({
    bin: 'gh',
    args: [...args, ...repo],
    env: process.env,
    timeoutMs: 60_000,
    ...(stdin !== undefined ? { stdin } : {}),
  });
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** Keeps the workflow's issues; `dryRun`: only says what it would do (it reads the open issues and changes nothing). */
async function keepIssues(rows: readonly VersionRow[], dryRun: boolean): Promise<void> {
  // `gh label create --force` makes the label or updates it: the first run has none yet.
  if (!dryRun) {
    await gh(['label', 'create', ISSUE_LABEL, '--color', '5319E7', '--description', 'A newer version of an agent CLI to check', '--force']);
  }
  const open = JSON.parse(
    await gh(['issue', 'list', '--label', ISSUE_LABEL, '--state', 'open', '--json', 'number,title,body', '--limit', '200']),
  ) as OpenIssue[];
  const actions = planIssues(rows, open);
  if (!dryRun) for (const a of actions) await applyIssue(a);
  const say = (a: IssueAction) => (dryRun ? `Would have: ${describeIssue(a)}` : describeIssue(a));
  console.log(actions.length ? actions.map(say).join('\n') : 'Issues: nothing to change.');
}

async function applyIssue(a: IssueAction): Promise<void> {
  if (a.kind === 'create') await gh(['issue', 'create', '--title', a.title, '--label', ISSUE_LABEL, '--body-file', '-'], a.body);
  else if (a.kind === 'update') {
    await gh(['issue', 'edit', String(a.number), '--title', a.title, '--body-file', '-'], a.body);
    await gh(['issue', 'comment', String(a.number), '--body-file', '-'], a.comment);
  } else await gh(['issue', 'close', String(a.number), '--comment', a.comment]);
}

function describeIssue(a: IssueAction): string {
  if (a.kind === 'create') return `Opened an issue: ${a.title}`;
  if (a.kind === 'update') return `Updated #${a.number}: ${a.title}`;
  return `Closed #${a.number} (${PROVIDER_LABEL[a.provider]})`;
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  if (command === 'versions' && flag('--issues')) {
    // As the workflow runs it: no CLI started, this process's environment (its token) kept for gh.
    const rows = await layerVersions(provider ? [provider] : PROVIDERS);
    console.log(versionTable(rows));
    await keepIssues(rows, flag('--dry-run'));
    return 0;
  }
  // Everything else starts CLIs: the scratch folder becomes this process's environment before the
  // server's modules are imported, and the server speaks English.
  const scratch = makeScratch(flag('--keep'));
  isolate(scratch.env);
  if (flag('--keep')) console.log(`Scratch folders (kept): ${scratch.root} and ${scratch.place}`);
  const { withLang } = await import('../src/server/i18n');
  const { killAll } = await import('../src/server/process');
  try {
    return await withLang('en', async () => {
      if (command === 'versions') {
        const rows = await layerVersions(provider ? [provider] : PROVIDERS, scratch);
        console.log(flag('--json') ? JSON.stringify(rows, null, 2) : versionTable(rows));
        return 0;
      }
      const layers = await import('./cli-check/layers');
      if (command === 'changelog') {
        const to = option('--to');
        const bin = option('--bin');
        return layers.changelog(provider!, {
          from: option('--from') ?? CHECKED_VERSIONS[provider!],
          ...(to ? { to } : {}),
          ...(bin ? { bin } : {}),
        });
      }
      const o = { accept: flag('--accept'), ...(option('--only') ? { only: option('--only')! } : {}) };
      if (command === 'probe') return layers.probe(provider!, await binOf(provider!), o, scratch);
      if (command === 'run') return layers.run(provider!, await binOf(provider!), o, scratch);

      // Every layer, for one CLI or for every CLI that is behind.
      const rows = await layerVersions(provider ? [provider] : PROVIDERS, scratch);
      console.log(versionTable(rows));
      const targets = provider ? [provider] : rows.filter((r) => r.status === 'behind' && r.installed).map((r) => r.provider);
      if (!targets.length) {
        console.log('\nNo CLI here is behind the newest version: nothing to check.');
        return 0;
      }
      let found = 0;
      for (const p of targets)
        found += await layers.all(
          p,
          await binOf(p),
          rows.find((r) => r.provider === p),
          o,
          scratch,
        );
      return found ? 1 : 0;
    });
  } finally {
    await killAll();
    await scratch.dispose();
  }
}

process.exitCode = await main();
