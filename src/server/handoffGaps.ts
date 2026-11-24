/*
 * The cards a finished reply leaves the user without (docs/architecture.md, "Secrets and fixed commands"):
 * an agent that writes about a card without writing its block gives the user nothing to answer. Two of
 * those Harness Relay can tell for certain, whatever the agent's words: a script the turn wrote that
 * reads $RELAY_SECRETS_FILE, which only a fixed command is ever given, with no fixed command to run it;
 * and a secret a command the reply proposes names, which is neither kept nor asked for on a card. The
 * orchestrator asks the agent once, in the same reply, for the blocks (`handoffRepairPrompt()` in
 * `prompt.ts`); what is still missing then it asks for itself (a secret) or says (a script).
 */
import { extname, isAbsolute, join, relative, sep } from 'node:path';
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

/** At most this many of a turn's files whose changed lines name the variable are read, to see they still do. */
export const GAP_LIMITS = { files: 10 };

/**
 * The scripts a turn wrote, or changed where they read $RELAY_SECRETS_FILE, that read it (`changes`: the
 * turn's, as the reply keeps them), as paths from the working directory `folder` (absolute when outside
 * it), `/` between their parts. One git command for each repository finds the files whose added or
 * removed lines name it (a script edited elsewhere was checked when that line was written); each is then
 * read, as it is after the turn, to see it still does. Prose and binary files are left out.
 */
export async function secretsScripts(changes: readonly MessageChanges[] | undefined, folder: string): Promise<string[]> {
  const out: string[] = [];
  let read = 0;
  for (const c of changes ?? []) {
    if (!c.files.length) continue;
    const named = await changedWithWord(c.root, c.base, c.head, SECRETS_FILE_VAR);
    for (const path of named) {
      if (PROSE.has(extname(path).toLowerCase())) continue;
      if (read++ >= GAP_LIMITS.files) return out;
      const text = await fileAt(c.root, c.head, path);
      if (!text?.includes(SECRETS_FILE_VAR)) continue;
      const abs = join(c.root, path);
      const rel = relative(folder, abs);
      const shown = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
      out.push(shown.split(sep).join('/'));
    }
  }
  return out;
}

/** A path's last part, `/` or `\` before it. */
const lastPart = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/**
 * The names a command line starts or hands a program: each of its words' last path part
 * (`cd tools && python3 ./post.py --dry-run` → cd, tools, python3, post.py, --dry-run).
 */
function runNames(run: string): Set<string> {
  return new Set(
    run
      .split(/[\s'"`;|&()<>=]+/)
      .filter(Boolean)
      .map(lastPart),
  );
}

/**
 * What a reply leaves the user without. `scripts`: what `secretsScripts()` found in its turn; `commands`:
 * every fixed command of the working directory, saved or proposed on a card that waits (this reply's
 * too); `proposed`: this reply's proposals; `asked`: the secrets kept, or asked for on a card the user
 * has not saved (waiting, or declined: they have their answer). A script counts as run when a command's
 * line names its file (by its name: `python3 titanic/download.py` runs `titanic/download.py`).
 */
export function handoffGaps(o: {
  scripts: readonly string[];
  commands: readonly Pick<CommandProposal, 'run'>[];
  proposed: readonly Pick<CommandProposal, 'name' | 'secrets'>[];
  asked: ReadonlySet<string>;
}): HandoffGap[] {
  const gaps: HandoffGap[] = [];
  const run = new Set(o.commands.flatMap((c) => [...runNames(c.run)]));
  for (const path of o.scripts) if (!run.has(lastPart(path))) gaps.push({ kind: 'script', path });
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
