/*
 * The cards a finished reply leaves the user without (docs/architecture.md, "Secrets and fixed commands"):
 * an agent that writes about a card without writing its block gives the user nothing to answer. Three of
 * those Harness Relay can tell for certain, whatever the agent's words: a script the turn wrote that
 * reads $RELAY_SECRETS_FILE, which only a fixed command is ever given, in a reply that proposes no
 * fixed command and with none that runs it; a command the reply proposes that runs such a script but
 * names no secret; and a secret a command the reply proposes names, which is neither kept nor asked for
 * on a card. The orchestrator asks the agent once, in the same reply, for the blocks
 * (`handoffRepairPrompt()` in `prompt.ts`); what is still missing then it asks for itself (a secret) or
 * says (a script, a command).
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { hiddenCharacters } from '../shared/handoffs';
import type { CommandProposal, MessageChanges } from '../shared/types';
import { changedWithWord, fileAt } from './workspace';

export type HandoffGap =
  /** A script the turn wrote (`path`, from the working directory) that reads $RELAY_SECRETS_FILE, which no fixed command runs. */
  | { kind: 'script'; path: string }
  /** The fixed command `command`, which the reply proposed, runs such a script (`path`) but names no secret. */
  | { kind: 'unnamed'; command: string; path: string }
  /** A secret the fixed command `command`, which the reply proposed, names: neither kept nor asked for on a card. */
  | { kind: 'secret'; name: string; command: string };

/** The variable a fixed command's run names its secrets' file in, which its script reads. */
export const SECRETS_FILE_VAR = 'RELAY_SECRETS_FILE';

/** Files that tell about a script rather than run (a README saying how the command reads its secrets). */
const PROSE = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.asciidoc', '.org', '.html', '.htm', '.tex', '.log']);

/**
 * What the check reads of a turn's changed files: at most `files` of them, each up to `bytes` (a larger
 * one is read that far), `totalBytes` in all; of a parallel turn's whose worktree is not on disk (read
 * through git, a process each) at most `gitFiles`. A path longer than `path` characters is never named.
 */
export const GAP_LIMITS = { files: 500, bytes: 1024 * 1024, totalBytes: 32 * 1024 * 1024, gitFiles: 20, path: 300 };

/** A path an agent's file has, fit to quote in Harness Relay's own words: no control or hidden character, not too long. */
const quotable = (path: string) => path.length <= GAP_LIMITS.path && !/[\t\n]/.test(path) && !hiddenCharacters(path);

/**
 * A regular file's start (never through a link, nor a device or a pipe), up to `GAP_LIMITS.bytes` and
 * what is left of `budget` (taken from it), or undefined.
 */
async function readStart(path: string, budget: { left: number }): Promise<string | undefined> {
  try {
    if (!(await lstat(path)).isFile()) return undefined;
    const fh = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const st = await fh.stat();
      if (!st.isFile()) return undefined;
      const size = Math.min(st.size, GAP_LIMITS.bytes, budget.left);
      if (size <= 0) return undefined;
      const buf = Buffer.allocUnsafe(size);
      const { bytesRead } = await fh.read(buf, 0, size, 0);
      budget.left -= bytesRead;
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * The scripts a turn added that read $RELAY_SECRETS_FILE, and those it changed where they read it
 * (`changes`: the turn's, as the reply keeps them), as paths from the working directory `folder`
 * (absolute when outside it), `/` between their parts. A turn's files are read from disk: the working
 * tree's, or a parallel turn's in its worktree (`worktreeOf`: where a repository's worktree is, for
 * the changes kept there), else from its commit through git; only a changed file that reads it asks git
 * whether its changed lines name it (one command for the repository: a script edited elsewhere was
 * checked when that line was written). Prose, binary and deleted files are left out, and so is a path
 * not fit to quote.
 */
export async function secretsScripts(
  changes: readonly MessageChanges[] | undefined,
  folder: string,
  worktreeOf: (root: string) => string | undefined = () => undefined,
): Promise<string[]> {
  const out: string[] = [];
  const budget = { left: GAP_LIMITS.totalBytes };
  let read = 0;
  let viaGit = 0;
  for (const c of changes ?? []) {
    const dir = c.isolated ? worktreeOf(c.root) : c.root;
    const reads: { path: string; status: 'A' | 'M' }[] = [];
    for (const f of c.files) {
      if (f.status === 'D' || f.added === null || PROSE.has(extname(f.path).toLowerCase())) continue;
      if (read >= GAP_LIMITS.files || budget.left <= 0 || (!dir && viaGit >= GAP_LIMITS.gitFiles)) break;
      read++;
      if (!dir) viaGit++;
      const text = dir ? await readStart(join(dir, f.path), budget) : await fileAt(c.root, c.head, f.path);
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

/** Package managers whose `run <name>` (yarn's without `run` too) runs a script of that name; make-like tools' targets. */
const RUNNERS = ['npm', 'pnpm', 'bun', 'yarn'];
const MAKERS = ['make', 'just'];

/**
 * What a command line runs: each word's last path part, as a file's name (`cd tools && python3 ./post.py`
 * → post.py, …), and the names it gives in the forms that name a script without its extension: a Python
 * module (`-m pkg.download` → download), a package manager's script (`npm run fetch`, `yarn fetch` →
 * fetch) and a make target (`make sync` → sync). Any other word (`main` in `git checkout main`) names no script.
 */
function runNames(run: string): { files: Set<string>; bare: Set<string> } {
  const words = run.split(/[\s'"`;|&()<>=]+/).filter(Boolean);
  const files = new Set(words.map(lastPart));
  const bare = new Set<string>();
  words.forEach((word, i) => {
    const next = words[i + 1];
    if (!next || next.startsWith('-')) return;
    const tool = lastPart(word);
    if (word === '-m') bare.add(next.split('.').pop()!);
    else if (word === 'run' && RUNNERS.includes(lastPart(words[i - 1] ?? ''))) bare.add(next);
    else if (tool === 'yarn' || MAKERS.includes(tool)) bare.add(next);
  });
  return { files, bare };
}

/** Whether a command line (`runNames()`) runs a script: by its file's name, or its name without its extension. */
function runs(names: { files: Set<string>; bare: Set<string> }, path: string): boolean {
  const file = lastPart(path);
  const ext = extname(file);
  return names.files.has(file) || (ext !== '' && names.bare.has(file.slice(0, -ext.length)));
}

/**
 * What a reply leaves the user without. `scripts`: what `secretsScripts()` found in its turn; `commands`:
 * every fixed command of the working directory, saved or proposed on a card that waits; `proposed`: the
 * reply's own proposals; `asked`: the secrets kept, or asked for on a card the user has not saved
 * (waiting, or declined: they have their answer). A script counts as left without a command only in a
 * reply that proposes none (one that does knows how: a script it does not name is likely its helper),
 * and only when no command runs it; a proposed command that runs one and names no secret counts too.
 */
export function handoffGaps(o: {
  scripts: readonly string[];
  commands: readonly Pick<CommandProposal, 'run'>[];
  proposed: readonly Pick<CommandProposal, 'name' | 'run' | 'secrets'>[];
  asked: ReadonlySet<string>;
}): HandoffGap[] {
  const gaps: HandoffGap[] = [];
  if (!o.proposed.length) {
    const all = o.commands.map((c) => runNames(c.run));
    for (const path of o.scripts) if (!all.some((names) => runs(names, path))) gaps.push({ kind: 'script', path });
  }
  for (const c of o.proposed) {
    if (c.secrets.length) continue;
    const names = runNames(c.run);
    const path = o.scripts.find((s) => runs(names, s));
    if (path) gaps.push({ kind: 'unnamed', command: c.name, path });
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
