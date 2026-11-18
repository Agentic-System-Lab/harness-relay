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
import type { VersionRow } from './versions';

export interface LayerOptions {
  accept: boolean;
  only?: string;
}

/** Where the shapes of each CLI's version checked are kept. */
export const SHAPES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'cli-check');

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
): boolean {
  const saved = loadShapes(p, layer);
  let changed = false;
  for (const [name, shape] of Object.entries(shapes)) {
    const before = saved?.shapes[name];
    if (!before) {
      changed = true;
      console.log(`    ${name}: none saved yet (--accept on the version checked, ${CHECKED_VERSIONS[p]}, saves it)`);
      continue;
    }
    const d = diffShapes(before, shape);
    if (!sameShape(d)) changed = true;
    console.log(`    ${name}: ${sameShape(d) ? `same as ${saved!.version}` : `differs from ${saved!.version}:`}`);
    for (const l of describeDiff(d)) console.log(`      ${l}`);
  }
  if (accept) {
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

export async function probe(p: Provider, bin: string, o: LayerOptions, scratch: Scratch): Promise<number> {
  const { probeCli } = await import('./probe');
  console.log(`\n== 2. ${PROVIDER_LABEL[p]}: probes without a model (${bin})`);
  const r = await probeCli(p, bin, scratch.forCli(p));
  for (const f of r.facts) console.log(`  ${f}`);
  if (!r.version) {
    console.log('  not installed, or it did not say its version: nothing more to ask');
    return 1;
  }
  console.log('  shape:');
  return compareShapes(p, 'probe', r.version, { probe: r.shape }, o.accept) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Layer 3

export async function run(p: Provider, bin: string, o: LayerOptions, scratch: Scratch): Promise<number> {
  const { runScenarios } = await import('./scenarios');
  console.log(`\n== 3. ${PROVIDER_LABEL[p]}: the real CLI on a scripted model (${bin})`);
  return runScenarios(p, bin, scratch, scratch.forCli(p), o);
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

/** The live tests' commands for one CLI, with what each needs (e2e/live/live.ts). */
export function liveCommands(p: Provider): string[] {
  const out = [`E2E_LIVE_CLIS=${p} E2E_LIVE_OLLAMA=<your server>/v1 npm run test:e2e:live`];
  if (['claude', 'codex', 'grok', 'cursor', 'antigravity', 'copilot', 'muse'].includes(p)) {
    out.push(`E2E_LIVE_CLIS=${p} E2E_LIVE_CLOUD=1 npm run test:e2e:live   (its own models, which your sign-in pays for)`);
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Layers 2 to 4 for one CLI, then layer 5's commands: how many layers found something. */
export async function all(p: Provider, bin: string, row: VersionRow | undefined, o: LayerOptions, scratch: Scratch): Promise<number> {
  let found = 0;
  found += await probe(p, bin, o, scratch);
  found += await run(p, bin, o, scratch);
  const to = row?.installed && !row.installed.startsWith('?') ? row.installed : row?.latest;
  found += await changelog(p, { from: CHECKED_VERSIONS[p], ...(to ? { to } : {}), bin });
  console.log(`\n== 5. ${PROVIDER_LABEL[p]}: the live tests, on a real model`);
  for (const l of liveCommands(p)) console.log(`  ${l}`);
  console.log(
    found
      ? `\n${PROVIDER_LABEL[p]}: ${found} layer(s) found something to look at (above).`
      : `\n${PROVIDER_LABEL[p]}: layers 2 and 3 found nothing new. Read the release notes' lines above and run the live tests; then move it forward in src/shared/cliVersions.ts.`,
  );
  return found;
}
