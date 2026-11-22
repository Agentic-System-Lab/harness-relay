import type { CommandProposal, FixedCommandRun, MessagePart, SecretAsk } from '../shared/types';
import { checkProposal } from '../shared/handoffs';

/*
 * The secrets and fixed command cards' logic (`components/HandoffCards.tsx`), kept apart from React so
 * that it can be tested: what the user typed made into what the server takes, and what a card offers.
 */

export type SecretsPart = Extract<MessagePart, { type: 'secrets' }>;
export type CommandPart = Extract<MessagePart, { type: 'command' }>;

/** A list the user typed: words separated by commas or spaces, each once. */
export function wordsOf(text: string): string[] {
  return [...new Set(text.split(/[\s,，、]+/).filter(Boolean))];
}

/** The asks of a secrets card still waiting for the user. */
export function waitingAsks(part: SecretsPart): SecretAsk[] {
  return part.asks.filter((a) => a.status === 'waiting');
}

/** The values a secrets card sends: those filled in, trimmed, by name. */
export function filledValues(asks: readonly SecretAsk[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of asks) {
    const v = values[a.name]?.trim();
    if (v) out[a.name] = v;
  }
  return out;
}

/** The fields of a command card's edit form, from its proposal. */
export interface CommandForm {
  name: string;
  run: string;
  hosts: string;
  secrets: string;
  cwd: string;
}

export function formOf(p: CommandProposal): CommandForm {
  return { name: p.name, run: p.run, hosts: p.hosts.join(', '), secrets: p.secrets.join(', '), cwd: p.cwd ?? '' };
}

/** The edit form as a proposal, checked as the server will check it; undefined when it is not valid. */
export function proposalOf(f: CommandForm): CommandProposal | undefined {
  return checkProposal({ name: f.name, run: f.run, hosts: wordsOf(f.hosts), secrets: wordsOf(f.secrets), cwd: f.cwd });
}

/** What a command card offers now. */
export function commandActions(part: CommandPart): { decide: boolean; tryIt: boolean; approve: boolean; share: boolean } {
  const saved = part.status === 'saved' && Boolean(part.commandId);
  const run = part.run;
  const running = run?.status === 'running';
  return {
    decide: part.status === 'proposed',
    tryIt: saved && !running,
    approve: saved && run?.status === 'changed',
    share: saved && Boolean(run) && !running && run!.status !== 'changed',
  };
}

/** How a run looks on its card: its tone (for the colour), and whether to show its exit code. */
export function runTone(run: FixedCommandRun): { tone: 'ok' | 'warn' | 'bad' | 'busy'; code: boolean } {
  switch (run.status) {
    case 'running':
      return { tone: 'busy', code: false };
    case 'passed':
    case 'news':
      return { tone: 'ok', code: true };
    case 'changed':
      return { tone: 'warn', code: false };
    case 'failed':
      return { tone: 'bad', code: true };
    default:
      return { tone: 'bad', code: false };
  }
}
