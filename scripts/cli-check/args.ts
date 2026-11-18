/**
 * `scripts/cli-check.ts`'s command line, read without side effects so that it can be tested: which
 * command, which CLI, which options. An option it does not know is refused, never passed over, so that
 * a mistyped `--dry-run` can never let `versions --issues` change the issues for real.
 */
import { PROVIDERS, type Provider } from '../../src/shared/types';

export const COMMANDS = ['versions', 'probe', 'run', 'changelog'] as const;
export type Command = (typeof COMMANDS)[number] | 'all';

/** The options that take a value, and those that are switches. */
const VALUED = ['--bin', '--only', '--from', '--to', '--against', '--record'] as const;
const SWITCHES = ['--accept', '--keep', '--json', '--issues', '--dry-run'] as const;

export interface Args {
  command: Command;
  provider?: Provider;
  bin?: string;
  only?: string;
  from?: string;
  to?: string;
  /** A file another version's layers 2 and 3 were recorded into (`--record`), to compare with. */
  against?: string;
  /** Record layers 2 and 3 into this file instead of comparing them. */
  record?: string;
  accept: boolean;
  keep: boolean;
  json: boolean;
  issues: boolean;
  dryRun: boolean;
}

export const USAGE = [
  'Usage:',
  '  npx tsx scripts/cli-check.ts [<cli>] [--bin <path>] [--accept] [--keep]',
  '  npx tsx scripts/cli-check.ts <cli> --bin <path> --record <file>        (layers 2 and 3 into a file)',
  '  npx tsx scripts/cli-check.ts <cli> --bin <path> --against <file>       (compared with that file)',
  '  npx tsx scripts/cli-check.ts versions [<cli>] [--json] [--issues [--dry-run]]',
  '  npx tsx scripts/cli-check.ts probe <cli> [--bin <path>] [--accept] [--keep]',
  '  npx tsx scripts/cli-check.ts run <cli> [--bin <path>] [--only <scenario>] [--accept] [--keep]',
  '  npx tsx scripts/cli-check.ts changelog <cli> [--from <version>] [--to <version>] [--bin <path>]',
  `<cli>: ${PROVIDERS.join(', ')}`,
].join('\n');

/** The command line read, or what is wrong with it. */
export function parseArgs(argv: readonly string[], platform: NodeJS.Platform = process.platform): Args | { error: string } {
  const values: Partial<Record<(typeof VALUED)[number], string>> = {};
  const switches = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((VALUED as readonly string[]).includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value.` };
      values[a as (typeof VALUED)[number]] = v;
      i++;
    } else if ((SWITCHES as readonly string[]).includes(a)) switches.add(a);
    else if (a.startsWith('-')) return { error: `Unknown option: ${a}` };
    else positional.push(a);
  }
  const command: Command = (COMMANDS as readonly string[]).includes(positional[0] ?? '') ? (positional.shift() as Command) : 'all';
  if (positional.length > 1) return { error: `One CLI at a time: ${positional.join(' ')}` };
  const provider = positional[0];
  if (provider !== undefined && !(PROVIDERS as readonly string[]).includes(provider)) return { error: `Unknown CLI: ${provider}` };
  if ((command === 'probe' || command === 'run' || command === 'changelog') && !provider) return { error: `${command} needs a CLI.` };
  if (switches.has('--dry-run') && !(command === 'versions' && switches.has('--issues')))
    return { error: '--dry-run goes with versions --issues.' };
  if (switches.has('--issues') && command !== 'versions') return { error: '--issues goes with versions.' };
  if (values['--bin'] && !provider) return { error: '--bin names the program of one CLI: name the CLI too.' };
  if (values['--record'] && (command !== 'all' || !provider))
    return { error: '--record goes with one CLI: <cli> --bin <path> --record <file>.' };
  if (values['--against'] && (!['all', 'probe', 'run'].includes(command) || !provider)) {
    return { error: '--against goes with one CLI, for layers 2 and 3.' };
  }
  if (values['--against'] && values['--record'])
    return { error: '--against and --record go apart: record one version, then compare another with it.' };
  if ((values['--against'] || values['--record']) && switches.has('--accept')) {
    return { error: '--accept saves the shapes this repository keeps, never with --against or --record.' };
  }
  if (platform === 'win32' && command !== 'versions' && command !== 'changelog')
    return { error: 'Layers 2 and 3 run on macOS and Linux only.' };
  return {
    command,
    ...(provider ? { provider: provider as Provider } : {}),
    ...(values['--bin'] ? { bin: values['--bin'] } : {}),
    ...(values['--only'] ? { only: values['--only'] } : {}),
    ...(values['--from'] ? { from: values['--from'] } : {}),
    ...(values['--to'] ? { to: values['--to'] } : {}),
    ...(values['--against'] ? { against: values['--against'] } : {}),
    ...(values['--record'] ? { record: values['--record'] } : {}),
    accept: switches.has('--accept'),
    keep: switches.has('--keep'),
    json: switches.has('--json'),
    issues: switches.has('--issues'),
    dryRun: switches.has('--dry-run'),
  };
}
