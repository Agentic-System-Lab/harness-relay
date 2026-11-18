/**
 * Layers 2 to 5 of `scripts/cli-check.ts`, each with its report, and all of them in order for one CLI.
 * The layers that start the CLI get the scratch folder `scripts/cli-check.ts` made this process's
 * environment before it imported anything of the server's.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKED_VERSIONS } from '../../src/shared/cliVersions';
import { PROVIDER_LABEL, type Provider } from '../../src/shared/types';
import type { Scratch } from './scratch';
import { describeDiff, diffShapes, sameShape, type Shape } from './shape';
import { versionStatus, type VersionRow } from './versions';

export interface LayerOptions {
  accept: boolean;
  only?: string;
  /**
   * What the version checked said on this system (`--against <file>`, recorded by `--record`): layers 2
   * and 3 compare with it instead of with the shapes saved, which were recorded on another system and
   * would show its differences too. Nothing is saved then.
   */
  against?: Recorded;
  /** Record what layers 2 and 3 say into this file (`--record <file>`) instead of comparing it. */
  record?: string;
}

/** What a version said in layers 2 and 3 on one system (`--record`), to compare another with (`--against`). */
export interface Recorded {
  provider: Provider;
  version: string;
  probe?: Shape;
  run: Record<string, Shape>;
  /** How many scenarios failed (and whether the probe found nothing) when it was recorded. */
  failures: number;
}

export function readRecorded(file: string, p: Provider): Recorded {
  const r = JSON.parse(readFileSync(file, 'utf8')) as Recorded;
  if (r.provider !== p) throw new Error(`${file} was recorded for ${r.provider}, not ${p}`);
  return r;
}

/** Where the shapes of each CLI's version checked are kept. */
export const SHAPES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'cli-check');

/**
 * The CLIs with no shapes saved, and why: their first check of a new version reports every shape as
 * "none saved yet", and saves them with --accept once it passed.
 */
export const NO_SHAPES: Partial<Record<Provider, string>> = {
  antigravity: 'its version checked, 1.5.6, can no longer be downloaded (its manifest names only the newest)',
};

/** The shapes saved for a version: the probe's (`probe.json`), or each scenario's (`run.json`). */
export interface SavedShapes {
  provider: Provider;
  /** The version the shapes were recorded with. */
  version: string;
  shapes: Record<string, Shape>;
}

export function shapeFile(p: Provider, layer: 'probe' | 'run'): string {
  return join(SHAPES_DIR, p, `${layer}.json`);
}

export function loadShapes(p: Provider, layer: 'probe' | 'run'): SavedShapes | undefined {
  const f = shapeFile(p, layer);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as SavedShapes) : undefined;
}

/**
 * Compares what was recorded with the shapes saved for the version checked, one line per change, and
 * saves it with `accept` (a scenario not run this time keeps its saved shape). True when one differs.
 */
export function compareShapes(
  p: Provider,
  layer: 'probe' | 'run',
  version: string | undefined,
  shapes: Record<string, Shape>,
  accept: boolean,
  against?: { version: string; shapes: Record<string, Shape> },
): boolean {
  const saved: SavedShapes | undefined = against
    ? { provider: p, version: `${against.version}, run here just now`, shapes: against.shapes }
    : loadShapes(p, layer);
  let changed = false;
  for (const [name, shape] of Object.entries(shapes)) {
    const before = saved?.shapes[name];
    if (!before) {
      changed = true;
      const why = against
        ? `the version checked, ${against.version}, gave none here`
        : NO_SHAPES[p]
          ? `none saved for ${PROVIDER_LABEL[p]}: ${NO_SHAPES[p]}; --accept saves this version's once it passed`
          : `none saved yet (--accept on the version checked, ${CHECKED_VERSIONS[p]}, saves it)`;
      console.log(`    ${name}: ${why}`);
      continue;
    }
    const d = diffShapes(before, shape);
    if (!sameShape(d)) changed = true;
    console.log(`    ${name}: ${sameShape(d) ? `same as ${saved!.version}` : `differs from ${saved!.version}:`}`);
    for (const l of describeDiff(d)) console.log(`      ${l}`);
  }
  if (accept && !against) {
    const f = shapeFile(p, layer);
    mkdirSync(dirname(f), { recursive: true });
    const out: SavedShapes = { provider: p, version: version ?? '?', shapes: { ...(saved?.shapes ?? {}), ...shapes } };
    writeFileSync(f, JSON.stringify(out, null, 2) + '\n');
    console.log(`    saved: ${f}`);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Layer 2

/**
 * Thrown when a CLI says it is signed in in the scratch home, which holds no sign-in: it found one
 * somewhere else (a keychain), and a turn would run on that account. Nothing more is run for it.
 */
export class SignedInError extends Error {}

const signedInMessage = (p: Provider) =>
  `${PROVIDER_LABEL[p]} says it is signed in, in a scratch home that holds no sign-in: it found one elsewhere (the system's keychain?). Stopped, so that nothing runs on that account.`;

/** Stops (`SignedInError`) when the CLI says any of its accounts is signed in in the scratch home. */
export async function assertSignedOut(p: Provider, bin: string): Promise<void> {
  const { openDatabase } = await import('../../src/server/db');
  const { SettingsStore } = await import('../../src/server/settings');
  const { ProviderService } = await import('../../src/server/providers');
  const settings = new SettingsStore(openDatabase(':memory:'));
  settings.update(p, { bin });
  const status = await new ProviderService(settings).status(p, true);
  if (status.accounts.some((a) => a.auth.loggedIn === true)) throw new SignedInError(signedInMessage(p));
}

/**
 * Layer 2: 1 when it found something (a shape that differs, a CLI that is not there). With `recorded`,
 * the version checked's answers to compare with; with `keep`, nothing is compared: its shape is kept there.
 */
export async function probe(
  p: Provider,
  bin: string,
  o: LayerOptions,
  scratch: Scratch,
  recorded?: Recorded,
  keep?: Partial<Recorded>,
): Promise<number> {
  const { probeCli } = await import('./probe');
  console.log(`\n== 2. ${PROVIDER_LABEL[p]}: probes without a model (${bin})`);
  const r = await probeCli(p, bin, await scratch.forCli(p));
  for (const f of r.facts) console.log(`  ${f}`);
  if (r.signedIn) throw new SignedInError(signedInMessage(p));
  if (!r.version) {
    console.log('  not installed, or it did not say its version: nothing more to ask');
    return 1;
  }
  if (keep) {
    Object.assign(keep, { version: r.version, probe: r.shape });
    return 0;
  }
  console.log('  shape:');
  const against = recorded?.probe ? { version: recorded.version, shapes: { probe: recorded.probe } } : undefined;
  return compareShapes(p, 'probe', r.version, { probe: r.shape }, o.accept, against) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Layer 3

/** Layer 3: 1 when a scenario failed or a shape differs. `recorded` and `keep` as for `probe`. */
export async function run(
  p: Provider,
  bin: string,
  o: LayerOptions,
  scratch: Scratch,
  recorded?: Recorded,
  keep?: Partial<Recorded>,
): Promise<number> {
  const { runScenarios } = await import('./scenarios');
  console.log(`\n== 3. ${PROVIDER_LABEL[p]}: the real CLI on a scripted model (${bin})`);
  await assertSignedOut(p, bin);
  const r = await runScenarios(p, bin, scratch, await scratch.forCli(p), o);
  if (!r) return 0;
  if (keep) {
    keep.run = r.shapes;
    return r.failures ? 1 : 0;
  }
  console.log('  shapes:');
  // Shapes are saved only from a run that passed: a failed one would be what later versions are held to.
  const against = recorded ? { version: recorded.version, shapes: recorded.run } : undefined;
  const changed = compareShapes(p, 'run', r.version, r.shapes, o.accept && !r.failures, against);
  if (o.accept && r.failures) console.log('    not saved: a scenario failed');
  return r.failures || changed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Layer 4

export async function changelog(p: Provider, o: { from: string; to?: string; bin?: string }): Promise<number> {
  const { releaseNotes, slowerChecks } = await import('./changelog');
  console.log(`\n== 4. ${PROVIDER_LABEL[p]}: what its release notes say since ${o.from}, and the slower checks`);
  for (const l of await releaseNotes(p, o.from, o.to, o.bin)) console.log(`  ${l}`);
  for (const l of await slowerChecks(p, o.bin)) console.log(`  ${l}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Layer 5

/** The CLIs the live tests run on an endpoint, and on their own models: `ENDPOINT_CLIS` with `OPEN`, and `CLOUD_CLIS`, in e2e/live/live.ts. */
export const LIVE_ENDPOINT_CLIS: readonly Provider[] = [
  'claude',
  'codex',
  'grok',
  'copilot',
  'opencode',
  'goose',
  'cline',
  'openhands',
  'pi',
];
export const LIVE_CLOUD_CLIS: readonly Provider[] = ['claude', 'codex', 'grok', 'cursor', 'antigravity', 'copilot', 'muse'];

/** The live tests' commands for one CLI, with what each needs: only those that have tests for it. */
export function liveCommands(p: Provider): string[] {
  const out: string[] = [];
  if (LIVE_ENDPOINT_CLIS.includes(p)) out.push(`E2E_LIVE_CLIS=${p} E2E_LIVE_OLLAMA=<your server>/v1 npm run test:e2e:live`);
  if (LIVE_CLOUD_CLIS.includes(p)) {
    out.push(`E2E_LIVE_CLIS=${p} E2E_LIVE_CLOUD=1 npm run test:e2e:live   (its own models, which your sign-in pays for)`);
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Layers 2 and 3 for one CLI, recorded into `o.record` to compare another version with (`--against`):
 * the scenarios' results printed, nothing compared. How many layers failed.
 */
export async function record(p: Provider, bin: string, o: LayerOptions, scratch: Scratch): Promise<number> {
  const keep: Partial<Recorded> = { run: {} };
  const plain = { accept: false, ...(o.only ? { only: o.only } : {}) };
  let failures = 0;
  try {
    failures += await probe(p, bin, plain, scratch, undefined, keep);
    failures += await run(p, bin, plain, scratch, undefined, keep);
  } catch (err) {
    if (!(err instanceof SignedInError)) throw err;
    console.log(`\n  STOPPED: ${err.message}`);
    return 1;
  }
  const out: Recorded = {
    provider: p,
    version: keep.version ?? '?',
    ...(keep.probe ? { probe: keep.probe } : {}),
    run: keep.run ?? {},
    failures,
  };
  mkdirSync(dirname(o.record!), { recursive: true });
  writeFileSync(o.record!, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nRecorded ${PROVIDER_LABEL[p]} ${out.version} into ${o.record}${failures ? ` (${failures} layer(s) did not pass)` : ''}.`);
  return failures;
}

/** Layers 2 to 4 for one CLI, then layer 5's commands: how many layers found something. */
export async function all(p: Provider, bin: string, row: VersionRow | undefined, o: LayerOptions, scratch: Scratch): Promise<number> {
  let found = 0;
  if (o.record) return record(p, bin, o, scratch);
  try {
    found += await probe(p, bin, o, scratch, o.against);
    found += await run(p, bin, o, scratch, o.against);
  } catch (err) {
    if (!(err instanceof SignedInError)) throw err;
    console.log(`\n  STOPPED: ${err.message}`);
    return found + 1;
  }
  const to = row?.installed && !row.installed.startsWith('?') ? row.installed : row?.latest;
  found += await changelog(p, { from: CHECKED_VERSIONS[p], ...(to ? { to } : {}), bin });
  console.log(`\n== 5. ${PROVIDER_LABEL[p]}: the live tests, on a real model`);
  for (const l of liveCommands(p)) console.log(`  ${l}`);
  console.log(`\n${verdict(p, found, to, o.against?.version)}`);
  return found;
}

/**
 * The report's last line: what layers 2 to 4 found, and what comes next. A version that is not newer
 * than the one checked (its layers show what the version checked does) has nothing to move forward to.
 */
export function verdict(p: Provider, found: number, to: string | undefined, against?: string): string {
  if (found) return `${PROVIDER_LABEL[p]}: ${found} layer(s) found something to look at (above).`;
  const checked = CHECKED_VERSIONS[p];
  const nothing = `${PROVIDER_LABEL[p]} ${to ?? '?'}: layers 2 and 3 found nothing new against ${against ? `${against}, run on this system` : checked}.`;
  if (to && versionStatus(p, checked, to) !== 'behind')
    return `${nothing} It is not newer than the version checked, ${checked}: nothing to move forward.`;
  return `${nothing} Read the release notes' lines above and run the live tests; then move it forward to ${to ?? 'this version'} in src/shared/cliVersions.ts.`;
}
