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

export type InteractivePart = Extract<MessagePart, { type: 'interactive' }>;

/** What an interactive command's card offers now. */
export interface InteractiveActions {
  /** Start (or Start again, once a run ended): not for a card that is blocked, dismissed or running. */
  start: boolean;
  /** Don't run: only before it ever started. */
  dismiss: boolean;
  /** The input line and Cancel: while it runs. */
  type: boolean;
  /** Send to the team: once a run ended, and only once. */
  send: boolean;
  /** Its run's output was sent to the team. */
  sent: boolean;
}

export function interactiveActions(part: InteractivePart): InteractiveActions {
  const s = part.session;
  const running = s?.state === 'running';
  return {
    start: !part.blocked && part.status !== 'dismissed' && !running,
    dismiss: part.status === 'proposed',
    type: running,
    send: part.status === 'started' && Boolean(s) && !running && !s!.sent,
    sent: Boolean(s?.sent),
  };
}

/**
 * Where a card offers to start it first: always its own empty folder, even when the agent says it needs
 * the working directory (which the card then says): there, what runs may load code an agent wrote (a
 * package's program, a script), with the user's rights, so it is the user's choice to make.
 */
export function startsInWorkdir(_part: InteractivePart): boolean {
  return false;
}

/** What Start sends: where it runs, and the configuration files the card listed there (the server refuses it when others appeared). */
export function startRequest(part: InteractivePart, workdir: boolean): { workdir: boolean; seen: string[] } {
  return { workdir, seen: workdir ? [...part.configFiles] : [] };
}

/** How a run's state reads on its card: its key in the locale, and its tone for the colour. */
export function sessionTone(s: NonNullable<InteractivePart['session']>): 'busy' | 'ok' | 'warn' | 'bad' {
  switch (s.state) {
    case 'running':
      return 'busy';
    case 'exited':
      return s.exitCode === 0 ? 'ok' : 'bad';
    case 'cancelled':
    case 'stopped':
      return 'warn';
    default:
      return 'bad';
  }
}

/**
 * Whether the line a program waits on asks for something to hide (a password, a passphrase, a token,
 * a PIN): the card's "Hide what I type" is then on until the user changes it.
 */
export function wantsHidden(output: string): boolean {
  const last = output.trimEnd().split('\n').pop() ?? '';
  return /\b(?:pass(?:word|phrase|code)?|token|secret|pin|otp|2fa|one-time)\b|密碼|口令|權杖/i.test(last) && !/https?:\/\//.test(last);
}
