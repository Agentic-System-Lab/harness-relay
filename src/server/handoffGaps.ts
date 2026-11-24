/*
 * The cards a finished reply leaves the user without (docs/architecture.md, "Secrets and fixed commands"):
 * an agent that writes about a card without writing its block gives the user nothing to answer. Two of
 * those Harness Relay can tell for certain, whatever the agent's words: a script the turn wrote that
 * reads $RELAY_SECRETS_FILE, which only a fixed command is ever given, in a reply that proposes no
 * fixed command and with none that runs it; and a secret a command the reply proposes names, which is
 * neither kept nor asked for on a card. The orchestrator asks the agent once, in the same reply, for the
 * blocks (`handoffRepairPrompt()` in `prompt.ts`); what is still missing then it asks for itself (a
 * secret) or says (a script).
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { constants } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { hiddenCharacters } from '../shared/handoffs';
import type { CommandProposal, MessageChanges } from '../shared/types';
import { changedWithWord, fileAt } from './workspace';

export type HandoffGap =
  /** A script the turn wrote (`path`, from the working directory) that reads $RELAY_SECRETS_FILE, which no fixed command runs. */
  | { kind: 'script'; path: string }
  /** A secret the fixed command `command`, which the reply proposed, names: neither kept nor asked for on a card. */
  | { kind: 'secret'; name: string; command: string };

/** The variable a fixed command's run names its secrets' file in, which its script reads. */
export const SECRETS_FILE_VAR = 'RELAY_SECRETS_FILE';

/** Files that tell about a script rather than run (a README saying how the command reads its secrets). */
const PROSE = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.asciidoc', '.org', '.html', '.htm', '.tex', '.log']);

/**
 * What the check reads of a turn's changed files: at most `files` of them, each up to `bytes` (a larger
 * one is read that far); of a parallel turn's (in its worktree, read through git, a process each) at
 * most `gitFiles`. A path longer than `path` characters is never named.
 */
export const GAP_LIMITS = { files: 500, bytes: 1024 * 1024, gitFiles: 20, path: 300 };

/** A path an agent's file has, fit to quote in Harness Relay's own words: no control or hidden character, not too long. */
const quotable = (path: string) => path.length <= GAP_LIMITS.path && !/[\t\n]/.test(path) && !hiddenCharacters(path);

/** A regular file's start (never through a link, nor a device or a pipe), or undefined. */
function readStart(path: string): string | undefined {
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      if (!fstatSync(fd).isFile()) return undefined;
      const buf = Buffer.alloc(GAP_LIMITS.bytes);
      const n = readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * The scripts a turn added that read $RELAY_SECRETS_FILE, and those it changed where they read it
 * (`changes`: the turn's, as the reply keeps them), as paths from the working directory `folder`
 * (absolute when outside it), `/` between their parts. A turn's files in the working tree are read from
 * disk, a parallel turn's from its commit; only a changed file that reads it asks git whether its
 * changed lines name it (one command for the repository: a script edited elsewhere was checked when
 * that line was written). Prose, binary and deleted files are left out, and so is a path not fit to quote.
 */
export async function secretsScripts(changes: readonly MessageChanges[] | undefined, folder: string): Promise<string[]> {
  const out: string[] = [];
  let read = 0;
  let viaGit = 0;
  for (const c of changes ?? []) {
    const reads: { path: string; status: 'A' | 'M' }[] = [];
    for (const f of c.files) {
      if (f.status === 'D' || f.added === null || PROSE.has(extname(f.path).toLowerCase())) continue;
      if (read >= GAP_LIMITS.files || (c.isolated && viaGit >= GAP_LIMITS.gitFiles)) break;
      read++;
      if (c.isolated) viaGit++;
      const text = c.isolated ? await fileAt(c.root, c.head, f.path) : readStart(join(c.root, f.path));
      if (text?.includes(SECRETS_FILE_VAR)) reads.push({ path: f.path, status: f.status });
    }
    const changed = reads.filter((f) => f.status === 'M').map((f) => f.path);
    const named = changed.length ? new Set(await changedWithWord(c.root, c.base, c.head, SECRETS_FILE_VAR, changed)) : new Set();
    for (const f of reads) {
      if (f.status === 'M' && !named.has(f.path)) continue;
      const abs = join(c.root, f.path);
      const rel = relative(folder, abs);
      const shown = (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs).split(sep).join('/');
      if (quotable(shown)) out.push(shown);
    }
  }
  return out;
}

/** A path's last part, `/` or `\` before it. */
const lastPart = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * The names a command line starts or hands a program: each of its words' last path part, and a dotted
 * word's last part (`cd tools && python3 ./post.py --dry-run` → cd, tools, python3, post.py, --dry-run;
 * `python3 -m pkg.download` → also download).
 */
function runNames(run: string): Set<string> {
  const names = new Set<string>();
  for (const word of run.split(/[\s'"`;|&()<>=]+/)) {
    if (!word) continue;
    const last = lastPart(word);
    names.add(last);
    names.add(last.split('.').pop()!);
  }
  return names;
}

/** Whether a command line runs a script: names its file, or its module (`download.py` as `pkg.download`). */
function runs(names: ReadonlySet<string>, path: string): boolean {
  const file = lastPart(path);
  const ext = extname(file);
  return names.has(file) || (ext !== '' && names.has(file.slice(0, -ext.length)));
}

/**
 * What a reply leaves the user without. `scripts`: what `secretsScripts()` found in its turn; `commands`:
 * every fixed command of the working directory, saved or proposed on a card that waits; `proposed`: the
 * reply's own proposals; `asked`: the secrets kept, or asked for on a card the user has not saved
 * (waiting, or declined: they have their answer). A script counts only in a reply that proposes no
 * command (one that does knows how: a script it does not name is likely its helper), and only when no
 * command's line runs it (by its file's name, or its module's).
 */
export function handoffGaps(o: {
  scripts: readonly string[];
  commands: readonly Pick<CommandProposal, 'run'>[];
  proposed: readonly Pick<CommandProposal, 'name' | 'secrets'>[];
  asked: ReadonlySet<string>;
}): HandoffGap[] {
  const gaps: HandoffGap[] = [];
  if (!o.proposed.length) {
    const names = new Set(o.commands.flatMap((c) => [...runNames(c.run)]));
    for (const path of o.scripts) if (!runs(names, path)) gaps.push({ kind: 'script', path });
  }
  const told = new Set<string>();
  for (const c of o.proposed) {
    for (const name of c.secrets) {
      if (o.asked.has(name) || told.has(name)) continue;
      told.add(name);
      gaps.push({ kind: 'secret', name, command: c.name });
    }
  }
  return gaps;
}
