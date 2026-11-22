import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, type Stats } from 'node:fs';
import { lstat, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import vm from 'node:vm';
import { compilePattern, hasChecks, isProtected, overallStatus, protectedPatterns, type CompiledPattern } from '../shared/checks';
import {
  CHECK_LIMITS,
  CHECK_RESULT_LIMITS,
  type CheckCommand,
  type CheckHook,
  type CheckFinding,
  type CheckList,
  type CheckOutcome,
  type CheckStatus,
  type ChecksResult,
} from '../shared/types';
import { t } from './i18n';
import { branchTips, commitsSince, type MadeCommit } from './workspace';

/*
 * Team checks (`ConversationSettings.checks`, issue #116): Harness Relay checks the team's work itself,
 * at points of a run it owns (before the first turn, after each turn, once the team has answered), so
 * that one list of rules covers every CLI and every permission, full access too. What it checks it
 * reads after the fact: it reports, and never undoes anything.
 *
 * - Protected paths are compared on disk (`takeManifest`), not through git: ignored files (`.env`,
 *   `*.pem`) are what they are most often about, and a snapshot leaves them out.
 * - Commits are the ones on the repository's branches and HEAD that were on none of them before the run
 *   and were made since it started (`commitsSince`), merges left out.
 *
 * `RunCheck` follows one run; `recheck` checks a result again from what its run started from
 * (`StoredBaseline`, kept by the server only: the files' hashes never go to the browser).
 */

/** A protected file as it was (`takeManifest`): a link's target, a file's size, time and content hash. */
export interface PathEntry {
  kind: 'file' | 'link' | 'other';
  size?: number;
  mtimeMs?: number;
  ino?: number;
  /** SHA-256 of the content (a link's: its target file's), for files up to `MANIFEST_LIMITS.hashBytes`. */
  hash?: string;
  /** A link's target, as it reads. */
  target?: string;
}

/** The protected files of one working directory, by `/`-separated relative path. */
export type Manifest = Record<string, PathEntry>;

export const MANIFEST_LIMITS = {
  /** Most names one working directory's look visits before it gives up (`TooManyFiles`). */
  entries: 200_000,
  hashBytes: 16 * 1024 * 1024,
};

/** How long a commit pattern may take on one subject, and the longest subject it is given. */
const SUBJECT_TIMEOUT_MS = 100;
const SUBJECT_MAX = 1000;
/** Most commits one check reads (newest first). */
const COMMIT_LIMIT = 200;
/** How far before the run's start a commit's time may be and still be the team's (clocks, rounding). */
const COMMIT_SLACK_MS = 2 * 60_000;

/** Folders a look from the top passes over: generated and installed files, as snapshots do (`DEFAULT_EXCLUDES`). */
const HEAVY = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', '.turbo', 'target']);

export class TooManyFiles extends Error {}

/**
 * The protected files under `cwd` now. It looks only where the patterns can match (`base`), never in
 * `.git`, the `exclude` folders (the CLIs' homes) or, from the top, `HEAVY` folders; it follows no link
 * to a folder, so it stays inside `cwd`. A file whose size, time and inode are as in `previous` keeps
 * its hash, unread. Throws `TooManyFiles` past `maxEntries`.
 */
export async function takeManifest(
  cwd: string,
  patterns: readonly CompiledPattern[],
  o: { exclude?: readonly string[]; previous?: Manifest; maxEntries?: number } = {},
): Promise<Manifest> {
  const out: Manifest = {};
  if (!patterns.length) return out;
  const max = o.maxEntries ?? MANIFEST_LIMITS.entries;
  const excluded = (abs: string) => (o.exclude ?? []).some((ex) => abs === ex || abs.startsWith(ex.endsWith(sep) ? ex : ex + sep));
  let seen = 0;
  // Each folder to look in once: none inside another, and the top for a pattern of any depth.
  const bases = [...new Set(patterns.map((p) => p.base))].sort();
  const starts = bases.includes('') ? [''] : bases.filter((b) => !bases.some((o2) => o2 !== b && b.startsWith(`${o2}/`)));

  const record = async (rel: string, abs: string, st: Stats) => {
    if (st.isDirectory()) return;
    if (st.isSymbolicLink()) {
      const entry: PathEntry = { kind: 'link', target: await readlink(abs).catch(() => '') };
      const real = await stat(abs).catch(() => undefined);
      if (real?.isFile()) Object.assign(entry, await fileEntry(abs, real, o.previous?.[rel]));
      out[rel] = entry;
      return;
    }
    out[rel] = st.isFile() ? { kind: 'file', ...(await fileEntry(abs, st, o.previous?.[rel])) } : { kind: 'other' };
  };

  const visit = async (rel: string, abs: string, fromTop: boolean): Promise<void> => {
    if (++seen > max) throw new TooManyFiles(t().checksTooManyFiles(max));
    const st = await lstat(abs).catch(() => undefined);
    if (!st) return;
    if (rel && isProtected(rel, patterns)) await record(rel, abs, st);
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    const name = basename(abs);
    if (rel && (name === '.git' || excluded(abs) || (fromTop && HEAVY.has(name)))) return;
    let names: string[];
    try {
      names = await readdir(abs);
    } catch {
      return; // unreadable: nothing the team could have written there either
    }
    for (const n of names.sort()) await visit(rel ? `${rel}/${n}` : n, join(abs, n), fromTop);
  };

  for (const base of starts) await visit(base, base ? join(cwd, ...base.split('/')) : cwd, base === '');
  return out;
}

async function fileEntry(
  abs: string,
  st: { size: number; mtimeMs: number; ino: number },
  previous: PathEntry | undefined,
): Promise<Omit<PathEntry, 'kind' | 'target'>> {
  const entry = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
  if (previous && previous.size === st.size && previous.mtimeMs === st.mtimeMs && previous.ino === st.ino) {
    return { ...entry, ...(previous.hash ? { hash: previous.hash } : {}) };
  }
  if (st.size > MANIFEST_LIMITS.hashBytes) return entry;
  try {
    return {
      ...entry,
      hash: createHash('sha256')
        .update(await readFile(abs))
        .digest('hex'),
    };
  } catch {
    return entry;
  }
}

/** What changed between two manifests of the same folder, by path, in path order. */
export function diffManifests(before: Manifest, after: Manifest): { path: string; change: NonNullable<CheckFinding['change']> }[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: { path: string; change: NonNullable<CheckFinding['change']> }[] = [];
  for (const path of paths) {
    const a = before[path];
    const b = after[path];
    if (!a) out.push({ path, change: 'added' });
    else if (!b) out.push({ path, change: 'removed' });
    else if (entryChanged(a, b)) out.push({ path, change: 'changed' });
  }
  return out;
}

function entryChanged(a: PathEntry, b: PathEntry): boolean {
  if (a.kind !== b.kind || a.target !== b.target) return true;
  if (a.kind === 'other') return false;
  if (a.hash && b.hash) return a.hash !== b.hash;
  return a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ino !== b.ino;
}

/**
 * Which subjects a commit pattern does not match (their indexes), each matched in a context of its own
 * with a time limit, so that a pattern that backtracks without end cannot hold the server up: then
 * `slow`, and the subjects not reached are not counted.
 */
export function unmatchedSubjects(pattern: string, subjects: readonly string[]): { unmatched: number[]; slow: boolean } {
  const ctx = vm.createContext({ p: pattern, s: '' });
  vm.runInContext('re = new RegExp(p)', ctx);
  const test = new vm.Script('re.test(s)');
  const unmatched: number[] = [];
  for (const [i, subject] of subjects.entries()) {
    ctx.s = subject.slice(0, SUBJECT_MAX);
    try {
      if (!test.runInContext(ctx, { timeout: SUBJECT_TIMEOUT_MS })) unmatched.push(i);
    } catch {
      return { unmatched, slow: true };
    }
  }
  return { unmatched, slow: false };
}

/** Where a run's working directories and repositories stood before it, kept by the server (`Store.saveChecksBaseline`). */
export interface StoredBaseline {
  /** When the run started (milliseconds): commits older than this are not the team's. */
  at: number;
  /** The patterns it was taken with (protected paths): a list changed since is checked as it is now. */
  patterns: string[];
  folders: { cwd: string; manifest?: Manifest; error?: string }[];
  repos: { root: string; tips?: string[]; error?: string }[];
  /** Who changed what, as each turn's look found: `<cwd>\0<path>` and commit shas, to member names. */
  byPath: Record<string, string>;
  byCommit: Record<string, string>;
}

/**
 * A baseline taken in the working directories, for a run in copies of them (the team's own worktrees,
 * made from the working directories as they were when that run began): each folder (`moves`: from a
 * working directory to its copy) and who changed what in it, moved to its copy. A protected file that is
 * in the working directory but not in its copy is left out: git ignores it, so the copy never has it, and
 * it is not the team's to have removed.
 */
export function baselineIn(baseline: StoredBaseline, moves: readonly { from: string; to: string }[]): StoredBaseline {
  const copyOf = new Map(moves.map((m) => [m.from, m.to]));
  const there = (path: string) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  const folders = baseline.folders.map((f) => {
    const copy = copyOf.get(f.cwd);
    if (!copy) return f;
    if (!f.manifest) return { ...f, cwd: copy };
    const kept = Object.entries(f.manifest).filter(([path]) => there(join(copy, path)) || !there(join(f.cwd, path)));
    return { ...f, cwd: copy, manifest: Object.fromEntries(kept) };
  });
  const byPath: Record<string, string> = {};
  for (const [key, by] of Object.entries(baseline.byPath)) {
    const [cwd = '', path = ''] = key.split('\0');
    const copy = copyOf.get(cwd);
    byPath[copy ? pathKey(copy, path) : key] = by;
  }
  return { ...baseline, folders, byPath };
}

/** Where a run's folders are: each working directory with its repository's root (`RunWorkspace.folders`). */
export interface CheckFolders {
  folders: { cwd: string; root: string }[];
  /** Folders never looked in: the CLIs' own homes. */
  exclude: string[];
  /** The mode keeps the team's commits in the working directories (roundtable, relay). */
  commits: boolean;
  /** The folders are the team's own worktrees (`TEAM_WORKTREE`), whose result is applied without its commits. */
  team?: boolean;
}

/** A protected file a member changed in its own worktree (parallel mode): applying its result would bring it. */
export interface WorktreeChange {
  cwd: string;
  path: string;
  change: NonNullable<CheckFinding['change']>;
  by: string;
}

/**
 * Settings' default as a chat has it, still marked (`fromDefault`), with the rules of a template the lead
 * agent picked: the protected paths of both (each once), the commands of both (one per command line and
 * folder), the template's commit format when it has one (else the default's), within the list's limits,
 * the default's rules first, so that a full list keeps all of the user's own. A command both have keeps
 * the template's time limit, and a sandbox opening (`localPorts`, `unixSockets`) only when both open it:
 * a template never opens more for a command the user set. Each command keeps an id of its own. Still the
 * default's (marked) when the template added nothing; otherwise no longer.
 */
export function mergeDefaultChecks(copy: CheckList, template: CheckList): CheckList {
  const own = copy.protectedPaths ?? [];
  const paths = [...new Set([...own, ...(template.protectedPaths ?? [])])].slice(0, CHECK_LIMITS.protectedPaths);
  const key = (c: CheckCommand) => `${c.run}\u0000${c.cwd ?? ''}`;
  const theirs = new Map((template.commands ?? []).map((c) => [key(c), c]));
  const commands: CheckCommand[] = [];
  const ids = new Set<string>();
  const add = (c: CheckCommand) => {
    if (commands.length >= CHECK_LIMITS.commands || commands.some((x) => key(x) === key(c))) return;
    const id = ids.has(c.id) ? randomUUID().slice(0, 8) : c.id;
    ids.add(id);
    commands.push({ ...c, id });
  };
  for (const c of copy.commands ?? []) {
    const t = theirs.get(key(c));
    if (!t) {
      add(c);
      continue;
    }
    const { localPorts: _p, unixSockets: _s, timeoutMin: _m, ...rest } = c;
    add({
      ...rest,
      ...(t.timeoutMin !== undefined ? { timeoutMin: t.timeoutMin } : c.timeoutMin !== undefined ? { timeoutMin: c.timeoutMin } : {}),
      ...(c.localPorts && t.localPorts ? { localPorts: true } : {}),
      ...(c.unixSockets && t.unixSockets ? { unixSockets: true } : {}),
    });
  }
  for (const c of template.commands ?? []) add(c);
  // The hooks of both, the default's first: one for each moment, kind of call, command line and folder,
  // with the template's time limit when both have it.
  const hookKey = (h: CheckHook) => `${h.when}\u0000${h.tools}\u0000${h.run}\u0000${h.cwd ?? ''}`;
  const theirHooks = new Map((template.hooks ?? []).map((h) => [hookKey(h), h]));
  const hooks: CheckHook[] = [];
  const hookIds = new Set<string>();
  const addHook = (h: CheckHook) => {
    if (hooks.length >= CHECK_LIMITS.hooks || hooks.some((x) => hookKey(x) === hookKey(h))) return;
    const id = hookIds.has(h.id) ? randomUUID().slice(0, 8) : h.id;
    hookIds.add(id);
    hooks.push({ ...h, id });
  };
  for (const h of copy.hooks ?? []) {
    const t = theirHooks.get(hookKey(h));
    const { timeoutSec: _s, ...rest } = h;
    addHook(
      t
        ? {
            ...rest,
            ...(t.timeoutSec !== undefined ? { timeoutSec: t.timeoutSec } : h.timeoutSec !== undefined ? { timeoutSec: h.timeoutSec } : {}),
          }
        : h,
    );
  }
  for (const h of template.hooks ?? []) addHook(h);
  const pattern = template.commitPattern || copy.commitPattern;
  const merged: CheckList = {
    ...(paths.length ? { protectedPaths: paths } : {}),
    ...(pattern ? { commitPattern: pattern } : {}),
    ...(commands.length ? { commands } : {}),
    ...(hooks.length ? { hooks } : {}),
    // Either one's: a rule more for the template's team, never one less.
    ...(copy.previewApp || template.previewApp ? { previewApp: true as const } : {}),
    ...(copy.autoFix || template.autoFix ? { autoFix: true as const } : {}),
  };
  // Nothing added: every path and command is the default's own, as it was, and so is the commit format.
  const sameCommand = (c: CheckCommand) =>
    (copy.commands ?? []).some((d) => key(d) === key(c) && JSON.stringify({ ...d, id: '' }) === JSON.stringify({ ...c, id: '' }));
  const sameHook = (h: CheckHook) =>
    (copy.hooks ?? []).some((d) => hookKey(d) === hookKey(h) && JSON.stringify({ ...d, id: '' }) === JSON.stringify({ ...h, id: '' }));
  const same =
    paths.every((p) => own.includes(p)) &&
    pattern === copy.commitPattern &&
    commands.length === (copy.commands ?? []).length &&
    commands.every(sameCommand) &&
    hooks.length === (copy.hooks ?? []).length &&
    hooks.every(sameHook) &&
    Boolean(merged.previewApp) === Boolean(copy.previewApp) &&
    Boolean(merged.autoFix) === Boolean(copy.autoFix);
  return same ? { ...merged, fromDefault: true } : merged;
}

/** The patterns of a list, read; those that cannot be read were refused when it was saved. */
export function listPatterns(list: CheckList | undefined): CompiledPattern[] {
  return protectedPatterns(list).flatMap((p) => compilePattern(p) ?? []);
}

/**
 * The checks of one run: `start` before the first turn, `checkpoint` after each turn (who changed what),
 * `finish` once the team has answered. Each look that fails is reported as such (`error`), never as a pass.
 *
 * It compares with where its run started (`baseline`), or, while the latest result has not passed and
 * the user has not gone on without it, with where that result's run started (`carried`): a member that
 * puts a protected file back then passes, and a commit that broke the format stays found until it is
 * made again. Who changed what during this run it finds after each turn, from where the run started.
 */
export class RunCheck {
  private readonly patterns: CompiledPattern[];
  private last: { manifests: (Manifest | undefined)[]; tips: (string[] | undefined)[] };
  /** The last look at each folder failed already: it is not tried again after each turn. */
  private readonly broken = new Set<number>();
  /** Something the checks cover changed during this run: a protected file, a commit. */
  private moved = false;
  private constructor(
    private readonly list: CheckList,
    private readonly where: CheckFolders,
    readonly baseline: StoredBaseline,
    now: StoredBaseline,
  ) {
    this.patterns = listPatterns(list);
    this.last = { manifests: now.folders.map((f) => f.manifest), tips: now.repos.map((r) => r.tips) };
    now.folders.forEach((f, i) => f.error && this.broken.add(i));
  }

  /** Undefined when the list has nothing to check or the run writes nowhere. */
  static async start(
    list: CheckList | undefined,
    where: CheckFolders,
    now: number,
    carried?: StoredBaseline,
  ): Promise<RunCheck | undefined> {
    if (!hasChecks(list) || !where.folders.length) return undefined;
    const patterns = listPatterns(list);
    const current: StoredBaseline = {
      at: now,
      patterns: patterns.map((p) => p.source),
      folders: await Promise.all(
        cwdsIn(where).map(async (cwd) => {
          if (!patterns.length) return { cwd, manifest: {} };
          try {
            return { cwd, manifest: await takeManifest(cwd, patterns, { exclude: where.exclude }) };
          } catch (err) {
            return { cwd, error: (err as Error).message };
          }
        }),
      ),
      repos: await Promise.all(
        rootsIn(where).map(async (root) => {
          if (!list.commitPattern || !where.commits) return { root, tips: [] };
          try {
            return { root, tips: await branchTips(root) };
          } catch (err) {
            return { root, error: (err as Error).message };
          }
        }),
      ),
      byPath: {},
      byCommit: {},
    };
    // A list changed since cannot be compared with what was found with the old one: this run starts afresh.
    const carry = carried && sameList(carried.patterns, patterns) ? carried : undefined;
    const baseline: StoredBaseline = carry
      ? {
          ...current,
          at: carry.at,
          folders: current.folders.map((f) => carry.folders.find((c) => c.cwd === f.cwd && c.manifest) ?? f),
          repos: current.repos.map((r) => carry.repos.find((c) => c.root === r.root && c.tips) ?? r),
          byPath: { ...carry.byPath },
          byCommit: { ...carry.byCommit },
        }
      : current;
    return new RunCheck(list, where, baseline, current);
  }

  /** After a turn: what changed since the last look is put down to `by` (a member's name); nothing when it is undefined (parallel mode). */
  async checkpoint(by: string | undefined): Promise<void> {
    const cwds = cwdsIn(this.where);
    const manifests = await Promise.all(
      cwds.map(async (cwd, i) => {
        if (this.broken.has(i) || !this.patterns.length) return this.last.manifests[i];
        try {
          return await takeManifest(cwd, this.patterns, { exclude: this.where.exclude, previous: this.last.manifests[i] });
        } catch {
          this.broken.add(i);
          return undefined;
        }
      }),
    );
    manifests.forEach((after, i) => {
      const before = this.last.manifests[i];
      if (!before || !after) return;
      for (const d of diffManifests(before, after)) {
        this.moved = true;
        if (by) this.baseline.byPath[pathKey(cwds[i]!, d.path)] = by;
      }
    });
    const roots = rootsIn(this.where);
    const tips = await Promise.all(
      roots.map(async (root, i) => {
        const before = this.last.tips[i];
        if (!this.list.commitPattern || !this.where.commits || !before) return before;
        try {
          const made = await commitsSince(root, before, this.baseline.at - COMMIT_SLACK_MS, COMMIT_LIMIT);
          if (made.commits.length) this.moved = true;
          if (by) for (const c of made.commits) this.baseline.byCommit[c.sha] ??= by;
          return await branchTips(root);
        } catch {
          return before;
        }
      }),
    );
    this.last = { manifests, tips };
  }

  /**
   * Once the team has answered: each rule's outcome, and whether anything they cover changed during this
   * run (protected files, commits; a member's worktree in parallel mode).
   */
  async finish(worktrees: readonly WorktreeChange[] = []): Promise<{ outcomes: CheckOutcome[]; touched: boolean }> {
    const outcomes = await evaluate(this.list, this.where, this.baseline, worktrees);
    return { outcomes, touched: this.moved || worktrees.length > 0 };
  }
}

/**
 * A result checked again, from where its run started (`baseline`), with the list as it is now: what was
 * reverted since passes, what changed since is found too. Who changed what is as the run found it.
 */
export async function recheck(
  list: CheckList,
  where: CheckFolders,
  baseline: StoredBaseline,
  worktrees: readonly WorktreeChange[] = [],
): Promise<CheckOutcome[]> {
  return evaluate(list, where, baseline, worktrees);
}

async function evaluate(
  list: CheckList,
  where: CheckFolders,
  baseline: StoredBaseline,
  worktrees: readonly WorktreeChange[],
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  const labels = folderNames(cwdsIn(where));
  const many = labels.size > 1;
  const patterns = listPatterns(list);

  if (patterns.length) {
    const findings: CheckFinding[] = [];
    const errors: string[] = [];
    for (const cwd of cwdsIn(where)) {
      const before = baseline.folders.find((f) => f.cwd === cwd);
      const folder = many ? { folder: labels.get(cwd)! } : {};
      // The list may have changed since the run started: what a pattern new to it covers was not looked at then.
      const samePatterns = sameList(baseline.patterns, patterns);
      if (!before?.manifest || !samePatterns) {
        if (before?.error) errors.push(before.error);
        else if (!samePatterns) errors.push(t().checksListChanged);
        else errors.push(t().checksNoBaseline);
        continue;
      }
      try {
        const now = await takeManifest(cwd, patterns, { exclude: where.exclude, previous: before.manifest });
        for (const d of diffManifests(before.manifest, now)) {
          const by = baseline.byPath[pathKey(cwd, d.path)];
          findings.push({ path: d.path, change: d.change, ...folder, ...(by ? { by } : {}) });
        }
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    for (const w of worktrees) {
      if (!isProtected(w.path, patterns)) continue;
      findings.push({
        path: w.path,
        change: w.change,
        worktree: true,
        by: w.by,
        ...(many ? { folder: labels.get(w.cwd) ?? basename(w.cwd) } : {}),
      });
    }
    outcomes.push(
      withFindings({ rule: 'paths', status: findings.length ? 'failed' : errors.length ? 'error' : 'passed' }, findings, errors),
    );
  }

  if (list.commitPattern) {
    if (!where.commits)
      outcomes.push({ rule: 'commits', status: 'na', reason: where.team ? t().checksCommitsTeam : t().checksCommitsParallel });
    else {
      const made: (MadeCommit & { root: string })[] = [];
      const errors: string[] = [];
      let more = false;
      for (const root of rootsIn(where)) {
        const before = baseline.repos.find((r) => r.root === root);
        if (!before?.tips) {
          errors.push(before?.error ?? t().checksNoBaseline);
          continue;
        }
        try {
          const found = await commitsSince(root, before.tips, baseline.at - COMMIT_SLACK_MS, COMMIT_LIMIT);
          made.push(...found.commits.map((c) => ({ ...c, root })));
          more ||= found.more;
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
      const { unmatched, slow } = unmatchedSubjects(
        list.commitPattern,
        made.map((c) => c.subject),
      );
      const rootLabels = folderNames(rootsIn(where));
      const findings: CheckFinding[] = unmatched.map((i) => {
        const c = made[i]!;
        const by = baseline.byCommit[c.sha];
        return {
          commit: c.sha.slice(0, 10),
          subject: c.subject.slice(0, 200),
          ...(rootLabels.size > 1 ? { folder: rootLabels.get(c.root)! } : {}),
          ...(by ? { by } : {}),
        };
      });
      if (slow) errors.push(t().checksPatternSlow);
      if (more) errors.push(t().checksTooManyCommits(COMMIT_LIMIT));
      const status: CheckStatus = findings.length ? 'failed' : errors.length ? 'error' : made.length ? 'passed' : 'na';
      outcomes.push(
        withFindings({ rule: 'commits', status, ...(status === 'na' ? { reason: t().checksNoCommits } : {}) }, findings, errors),
      );
    }
  }
  return outcomes;
}

function withFindings(o: CheckOutcome, findings: CheckFinding[], errors: string[]): CheckOutcome {
  const max = CHECK_RESULT_LIMITS.findings;
  return {
    ...o,
    ...(findings.length ? { findings: findings.slice(0, max) } : {}),
    ...(findings.length > max ? { more: findings.length - max } : {}),
    ...(errors.length && !o.reason ? { reason: [...new Set(errors)].join(' ') } : {}),
  };
}

/** A result for a system message, from its outcomes. */
export function checksResult(
  outcomes: CheckOutcome[],
  o: Pick<ChecksResult, 'when' | 'replyIds' | 'appReplies' | 'checkedAt' | 'durationMs' | 'applyOf' | 'autoFixes'>,
): ChecksResult {
  return { status: overallStatus(outcomes), outcomes, ...o };
}

function cwdsIn(where: CheckFolders): string[] {
  return [...new Set(where.folders.map((f) => f.cwd))];
}

function rootsIn(where: CheckFolders): string[] {
  return [...new Set(where.folders.map((f) => f.root))];
}

function pathKey(cwd: string, path: string): string {
  return `${cwd}\0${path}`;
}

function sameList(a: readonly string[], b: readonly CompiledPattern[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]!.source);
}

/** Folder names for findings, ` (2)`… for a name taken already. */
function folderNames(dirs: string[]): Map<string, string> {
  const labels = new Map<string, string>();
  const taken = new Set<string>();
  for (const dir of dirs) {
    const name = basename(dir) || dir;
    let label = name;
    for (let n = 2; taken.has(label); n++) label = `${name} (${n})`;
    taken.add(label);
    labels.set(dir, label);
  }
  return labels;
}
