/**
 * Layer 2 of `scripts/cli-check.ts`: what Harness Relay asks a CLI without a prompt, asked through
 * the server's own code (`ProviderService`: status and sign-in, models, plan usage; `NativeSetupService`:
 * what it loads by itself), with every process it starts recorded, and the CLI's help. No model is
 * reached and nothing is signed in: the answers are the ones a signed-out CLI gives in a home of its
 * own, which is what makes two versions comparable.
 *
 * Imported only once `isolate()` made the scratch environment this process's own.
 */
import type { Provider } from '../../src/shared/types';
import type { CliScratch } from './scratch';
import { flagsOf, memoryRecorder, pathsOf, shapeOf, type Shape, type Spawned } from './shape';

/** The help each CLI is asked for: its own, and the subcommand its adapter starts it with. */
export const HELP_ARGS: Record<Provider, string[][]> = {
  claude: [['--help']],
  codex: [['--help'], ['app-server', '--help']],
  grok: [['--help'], ['agent', '--help']],
  cursor: [['--help'], ['acp', '--help']],
  antigravity: [['--help'], ['acp', '--help']],
  copilot: [['--help']],
  muse: [['--help'], ['acp', '--help']],
  opencode: [['--help'], ['acp', '--help']],
  goose: [['--help'], ['acp', '--help']],
  cline: [['--help']],
  openhands: [['--help'], ['acp', '--help']],
  pi: [['--help']],
};

export interface ProbeResult {
  shape: Shape;
  spawned: Spawned[];
  /** What the server made of the answers, in a few words, for the report. */
  facts: string[];
  version?: string;
}

export async function probeCli(p: Provider, bin: string, cli: CliScratch): Promise<ProbeResult> {
  const { recordSpawns, capture } = await import('../../src/server/process');
  const { openDatabase } = await import('../../src/server/db');
  const { SettingsStore } = await import('../../src/server/settings');
  const { ProviderService } = await import('../../src/server/providers');
  const { NativeSetupService } = await import('../../src/server/native');

  const { recorder, spawned } = memoryRecorder();
  recordSpawns(recorder);
  const results: Record<string, unknown> = {};
  const facts: string[] = [];
  let version: string | undefined;
  try {
    const settings = new SettingsStore(openDatabase(':memory:'));
    settings.update(p, { bin });
    const service = new ProviderService(settings);
    const status = await service.status(p, true);
    version = status.version;
    results.status = status;
    facts.push(`installed: ${status.installed}`, `version: ${status.version ?? '?'}`, `signed in: ${String(status.auth.loggedIn)}`);
    if (!status.installed) return { shape: { kinds: {} }, spawned, facts, ...(version ? { version } : {}) };
    const models = await service.models(p, true);
    results.models = models;
    facts.push(`models: ${models.models.length} (${models.source}${models.error ? `, ${models.error.slice(0, 80)}` : ''})`);
    const usage = await service.usage(p, '', true);
    results.usage = usage;
    facts.push(
      `usage: ${usage.none ?? usage.problem ?? (usage.error ? `error ${usage.error.slice(0, 80)}` : `${usage.limits.length} limits`)}`,
    );
    // More time than the server gives each question: a CLI's first start in a fresh home is slow
    // (OpenCode's), and an answer cut short would change the shape. Asked again, up to twice, when a
    // question failed: OpenCode's questions, started together in a fresh home, sometimes find its
    // database locked.
    const natives = new NativeSetupService(settings, 90_000);
    let native = await natives.get(p, cli.work, true);
    for (let i = 0; i < 2 && native.problems.some((x) => x.kind === 'failed'); i++) native = await natives.get(p, cli.work, true);
    results.native = native;
    const problem = (x: (typeof native.problems)[number]): string =>
      x.kind === 'failed' ? `failed (${x.detail.slice(0, 120)})` : x.kind === 'no-answer' ? `no answer (${x.part})` : x.kind;
    facts.push(`native problems: ${native.problems.map(problem).join(', ') || 'none'}`);
    const help: string[] = [];
    for (const args of HELP_ARGS[p]) {
      const r = await capture(bin, args, process.env, { timeoutMs: 30_000 });
      help.push(r.stdout, r.stderr);
    }
    const shape = shapeOf(spawned);
    shape.flags = flagsOf(help.join('\n'));
    shape.results = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, [...resultPaths(k, v)].sort()]));
    return { shape, spawned, facts, ...(version ? { version } : {}) };
  } finally {
    recordSpawns(undefined);
  }
}

/** A result's shape, with the facts that say whether it worked as paths too: `fact:installed=true`. */
function resultPaths(kind: string, v: unknown): Set<string> {
  const out = pathsOf(stripVolatile(v));
  const o = v as Record<string, any>;
  if (kind === 'status') {
    out.add(`fact:installed=${o.installed}`);
    out.add(`fact:loggedIn=${String(o.auth?.loggedIn)}`);
    out.add(`fact:version=${o.version ? 'read' : 'none'}`);
  } else if (kind === 'models') {
    out.add(`fact:models=${o.models?.length ? 'some' : 'none'}`);
    out.add(`fact:source=${o.source}`);
    out.add(`fact:error=${o.error ? 'yes' : 'no'}`);
  } else if (kind === 'usage') {
    out.add(`fact:none=${o.none ?? '-'}`);
    out.add(`fact:problem=${o.problem ?? '-'}`);
    out.add(`fact:error=${o.error ? 'yes' : 'no'}`);
  } else if (kind === 'native') {
    for (const pr of (o.problems ?? []) as { kind: string }[]) out.add(`fact:problem=${pr.kind}`);
  }
  return out;
}

/** Leaves out what differs from one ask to the next whatever the version: times, paths of the scratch folder. */
function stripVolatile(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (k, x) => (k === 'checkedAt' || k === 'at' ? undefined : x)));
}
