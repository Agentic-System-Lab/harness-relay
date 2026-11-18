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
 *   npx tsx scripts/cli-check.ts                       every CLI here newer than the version it was
 *                                                      checked with: layers 1 to 4, and 5's commands
 *   npx tsx scripts/cli-check.ts <cli> [--bin <path>]  one CLI, layers 1 to 4, whatever its version
 *   npx tsx scripts/cli-check.ts versions [<cli>] [--json] [--issues [--dry-run]]
 *   npx tsx scripts/cli-check.ts probe <cli> [--bin <path>] [--accept]
 *   npx tsx scripts/cli-check.ts run <cli> [--bin <path>] [--only <scenario>] [--accept]
 *   npx tsx scripts/cli-check.ts changelog <cli> [--from <version>] [--to <version>] [--bin <path>]
 *
 * --bin: the CLI to check (default: its name on the PATH). --accept: save what was recorded as the
 * shapes of the version checked (test/fixtures/cli-check/<cli>/), once what changed was looked at.
 * --only: the scenarios whose name holds the text. --from, --to: the release notes' versions.
 * --keep: keep the scratch folders (their paths are printed). --json: the versions as JSON. --issues:
 * keep the workflow's issues, through gh (the CLI versions workflow, .github/workflows/cli-versions.yml);
 * with --dry-run, only say what it would do with them. An option it does not know is refused
 * (`scripts/cli-check/args.ts`).
 *
 * Every CLI runs in scratch folders of its own (scripts/cli-check/scratch.ts): a home, the XDG
 * folders, Harness Relay's data folder, working directories outside the home and the temporary
 * folders, of your variables only the PATH, the locale and the terminal's and user's names, no
 * auto-update, no browser. It is never signed in (a CLI that says it is stops the check) and never
 * reaches a model service: layer 3's model is on 127.0.0.1. Layers 2 and 3 on macOS and Linux only.
 */
import { resolve } from 'node:path';
import { CHECKED_VERSIONS } from '../src/shared/cliVersions';
import { PROVIDERS, type Provider } from '../src/shared/types';
import { USAGE, parseArgs } from './cli-check/args';
import { keepIssues, type Gh } from './cli-check/issues';
import { cliEnv, isolate, makeScratch, type Scratch } from './cli-check/scratch';
import { versionRows, versionStatus, versionTable, type VersionRow } from './cli-check/versions';

const parsed = parseArgs(process.argv.slice(2));
if ('error' in parsed) {
  console.error(`${parsed.error}\n${USAGE}`);
  process.exit(2);
}
const args = parsed;
const provider = args.provider;
// A path given to --bin is taken from where the script was started: the script then works in its
// scratch folder. A bare name is looked up on the PATH, as the CLI's own name is.
const givenBin = args.bin && /[\\/]/.test(args.bin) ? resolve(args.bin) : args.bin;

// ---------------------------------------------------------------------------
// Layer 1

/** The CLI to check: `--bin`, else its name on the PATH (`DEFAULT_BIN`, imported once isolated). */
async function binOf(p: Provider): Promise<string> {
  if (givenBin && provider === p) return givenBin;
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

/** A version `--version` said, as a version: not "? (…)" nor "error: …". */
const said = (v: string | undefined): v is string => !!v && /^\d/.test(v);

/** gh, with this process's environment (its token), started directly. */
const gh: Gh = async (ghArgs, stdin) => {
  const { runProcess } = await import('../src/server/process');
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

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  if (args.command === 'versions' && args.issues) {
    // As the workflow runs it: no CLI started, this process's environment (its token) kept for gh.
    const rows = await layerVersions(provider ? [provider] : PROVIDERS);
    console.log(versionTable(rows));
    for (const line of await keepIssues(rows, args.dryRun, gh)) console.log(line);
    return 0;
  }
  // Everything else starts CLIs: the scratch folder becomes this process's environment before the
  // server's modules are imported, the script works in it, and the server speaks English.
  const scratch = makeScratch(args.keep);
  isolate(scratch.env);
  process.chdir(scratch.place);
  if (args.keep) console.log(`Scratch folders (kept): ${scratch.root} and ${scratch.place}`);
  const { withLang } = await import('../src/server/i18n');
  const { killAll } = await import('../src/server/process');
  // Stopped (Ctrl-C): the CLIs it started, in process groups of their own, and its folders go too.
  const stop = () => {
    void (async () => {
      await killAll();
      await scratch.dispose();
      process.exit(130);
    })();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await withLang('en', async () => {
      if (args.command === 'versions') {
        const rows = await layerVersions(provider ? [provider] : PROVIDERS, scratch);
        console.log(args.json ? JSON.stringify(rows, null, 2) : versionTable(rows));
        return 0;
      }
      const layers = await import('./cli-check/layers');
      if (args.command === 'changelog') {
        return layers.changelog(provider!, {
          from: args.from ?? CHECKED_VERSIONS[provider!],
          ...(args.to ? { to: args.to } : {}),
          ...(givenBin ? { bin: givenBin } : {}),
        });
      }
      const o = { accept: args.accept, ...(args.only ? { only: args.only } : {}) };
      if (args.command === 'probe') return layers.probe(provider!, await binOf(provider!), o, scratch);
      if (args.command === 'run') return layers.run(provider!, await binOf(provider!), o, scratch);

      // Every layer, for one CLI, or for every CLI here whose version is newer than the one checked.
      const rows = await layerVersions(provider ? [provider] : PROVIDERS, scratch);
      console.log(versionTable(rows));
      const newer = (r: VersionRow) => said(r.installed) && versionStatus(r.provider, r.checked, r.installed) === 'behind';
      const targets = provider ? [provider] : rows.filter(newer).map((r) => r.provider);
      if (!targets.length) {
        console.log(
          '\nNo CLI here is newer than the version it was checked with: nothing to check. Install a new one apart and name it: <cli> --bin <path>.',
        );
        return 0;
      }
      let found = 0;
      for (const p of targets) {
        const row = rows.find((r) => r.provider === p);
        if (provider && row && !newer(row)) {
          console.log(
            `\n${p} here is ${row.installed ?? 'not installed'}, not newer than ${row.checked}: its layers show what the version checked does.`,
          );
        }
        found += await layers.all(p, await binOf(p), row, o, scratch);
      }
      return found ? 1 : 0;
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await killAll();
    await scratch.dispose();
  }
}

process.exitCode = await main();
