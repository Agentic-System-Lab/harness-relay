import type { CodeViewFile, CommandProposal, FixedCommandRun, MessagePart, SecretAsk } from '../shared/types';
import { checkProposal, refusedHostsToTell } from '../shared/handoffs';
import { diffLineClass, parseDiff } from './diff';

/*
 * The secrets and fixed command cards' logic (`components/HandoffCards.tsx`), kept apart from React so
 * that it can be tested: what the user typed made into what the server takes, and what a card offers.
 */

export type SecretsPart = Extract<MessagePart, { type: 'secrets' }>;
export type CommandPart = Extract<MessagePart, { type: 'command' }>;

/**
 * One file of the code a proposed fixed command would run (`codeFiles()`), as the card lists it: its name;
 * what it is (a file the agents added, one they changed or removed, one shown as it is now, a file of
 * secrets by its names, a git setting or hook); for a change, its lines added and removed; its lines,
 * each with the diff dialog's class (`d-add`, `d-del`, `d-hunk`, or none); and `cut` when the server
 * showed only its start. A file added whole reads as itself, without the `+` before each line.
 */
export interface CodeFile {
  title: string;
  kind: 'new' | 'changed' | 'removed' | 'now' | 'names' | 'git';
  added?: number;
  deleted?: number;
  lines: { text: string; cls: string }[];
  cut?: boolean;
}

/** A text's lines, without the empty ones it ends with. */
function linesOf(text: string): string[] {
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The files of the code view the server sends (`codeView()`, in its order: the scripts the command line
 * names first), as the card lists them. Each comes apart already (`CodeViewFile`): nothing in a file's
 * own text, a line that reads as a diff's or a header's, starts another file or hides one.
 */
export function codeFiles(view: readonly CodeViewFile[]): CodeFile[] {
  return view.map((f): CodeFile => {
    const title = f.entry.replace(/^named:/, '');
    const cut = f.cut ? { cut: true } : {};
    if (f.kind !== 'diff') return { title, kind: f.kind, lines: linesOf(f.text).map((text) => ({ text, cls: '' })), ...cut };
    const file = parseDiff(f.text).files[0];
    // Never left out: a diff this cannot read shows as the text it is.
    if (!file) return { title, kind: 'changed', lines: linesOf(f.text).map((text) => ({ text, cls: diffLineClass(text, true) })), ...cut };
    const hunk = file.lines.findIndex((l) => l.startsWith('@@'));
    const body = hunk < 0 ? [] : file.lines.slice(hunk);
    const kind = file.status === 'A' ? 'new' : file.status === 'D' ? 'removed' : 'changed';
    return {
      title,
      kind,
      ...(file.added !== null ? { added: file.added } : {}),
      ...(file.deleted !== null ? { deleted: file.deleted } : {}),
      lines:
        kind === 'new'
          ? body.filter((l) => l.startsWith('+')).map((l) => ({ text: l.slice(1), cls: '' }))
          : body.map((l) => ({ text: l, cls: diffLineClass(l, true) })),
      ...cut,
    };
  });
}

/**
 * The folders of the files a command pins that are not its own (`codeView()`'s `elsewhere`), as the card names
 * them: each one's top folder, once, in order ('.' for a file at the top).
 */
export function elsewhereFolders(entries: readonly string[]): string[] {
  return [...new Set(entries.map((e) => (e.includes('/') ? e.slice(0, e.indexOf('/')) : '.')))];
}

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
  /** Its runs publish, post or send something: Try it asks first. */
  publishes: boolean;
}

export function formOf(p: CommandProposal): CommandForm {
  return {
    name: p.name,
    run: p.run,
    hosts: p.hosts.join(', '),
    secrets: p.secrets.join(', '),
    cwd: p.cwd ?? '',
    publishes: Boolean(p.publishes),
  };
}

/** The edit form as a proposal, checked as the server will check it; undefined when it is not valid. */
export function proposalOf(f: CommandForm): CommandProposal | undefined {
  return checkProposal({
    name: f.name,
    run: f.run,
    hosts: wordsOf(f.hosts),
    secrets: wordsOf(f.secrets),
    cwd: f.cwd,
    publishes: f.publishes,
  });
}

/** What a command card offers now. */
export function commandActions(part: CommandPart): { decide: boolean; tryIt: boolean; stop: boolean; approve: boolean; share: boolean } {
  const saved = part.status === 'saved' && Boolean(part.commandId);
  const run = part.run;
  const running = run?.status === 'running';
  return {
    decide: part.status === 'proposed',
    tryIt: saved && !running,
    // Its run, whatever started it (Try it, the outbox, its schedule): this card follows it.
    stop: saved && running,
    approve: saved && run?.status === 'changed',
    share: saved && Boolean(run) && !running && run!.status !== 'changed',
  };
}

/**
 * How a run looks on its card: its tone (for the colour), and whether to show its exit code. One that
 * ended with 0 although the sandbox refused it hosts is a warning: what needed them may not have been done.
 */
export function runTone(run: FixedCommandRun): { tone: 'ok' | 'warn' | 'bad' | 'busy'; code: boolean } {
  switch (run.status) {
    case 'running':
      return { tone: 'busy', code: false };
    case 'passed':
    case 'news':
      return { tone: refusedHostsToTell(run).length ? 'warn' : 'ok', code: true };
    case 'changed':
      return { tone: 'warn', code: false };
    case 'failed':
      return { tone: 'bad', code: true };
    default:
      // Stopped: the user's choice (or the server's), not a failure of its own.
      return { tone: run.stopped ? 'warn' : 'bad', code: false };
  }
}

/** How many lines a running run's output so far has, for its log's summary (its `…` line, where its start was cut, not counted). */
export function outputLines(output: string | undefined): number {
  if (!output) return 0;
  const lines = output.split('\n');
  return lines[0] === '…' ? lines.length - 1 : lines.length;
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
