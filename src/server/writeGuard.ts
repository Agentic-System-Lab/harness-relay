import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { CheckList } from '../shared/types';
import { compilePattern, hasTextSet, isProtected, type CompiledPattern } from '../shared/checks';

/**
 * The team checks' protected paths, for a CLI to refuse writing them before it happens (each adapter in
 * its own way: `docs/sandboxing.md`, "The team's protected paths"). Reads stay allowed; what no CLI
 * refuses is still found once the team has answered (`src/server/checks.ts`).
 */
export interface WriteGuard {
  /**
   * The run's working directories (in parallel mode the member's worktrees): each as it was given and as
   * its real path, when they differ (a CLI's rules may match either spelling).
   */
  dirs: string[];
  /** The protected paths, tidied (`tidyPattern`): gitignore-like, relative to each working directory. */
  patterns: string[];
}

/**
 * A run's guard: undefined when the list protects nothing, and on native Windows, where none of the
 * CLIs' rules was tried (and a long list could pass the command line's length there).
 */
export function writeGuard(
  list: CheckList | undefined,
  dirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): WriteGuard | undefined {
  if (platform === 'win32') return undefined;
  // Tidied (`./a` is `a`), as every translation reads them.
  const patterns = [...new Set((list?.protectedPaths ?? []).flatMap((p) => compilePattern(p)?.source ?? []))];
  if (!patterns.length || !dirs.length) return undefined;
  return { dirs: [...new Set(dirs.flatMap((d) => [d, realPath(d)]))], patterns };
}

/** The real path of one that may not exist yet: its deepest existing folder resolved, the rest as given. */
export function realPath(path: string): string {
  const rest: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return path;
      rest.push(basename(at));
      at = up;
    }
  }
}

/** A path relative to `dir`, `/`-separated, or undefined outside it (here so adapters need not load the checks' modules). */
function relativeInside(dir: string, path: string): string | undefined {
  const rel = relative(dir, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

const compiled = (g: WriteGuard): CompiledPattern[] => g.patterns.flatMap((p) => compilePattern(p) ?? []);

/** The patterns a glob may carry: not one with a set read as text (`[user-id]`), which a glob would read as a set. */
const globbable = (g: WriteGuard): CompiledPattern[] => compiled(g).filter((p) => !hasTextSet(p.source));

/** The working directories as real paths, each once. */
const realDirs = (g: WriteGuard): string[] => [...new Set(g.dirs.map(realPath))];

/** Whether writing `path` (absolute) is writing one of the guard's protected paths, in any of its folders. */
export function isGuarded(g: WriteGuard | undefined, path: string): boolean {
  if (!g) return false;
  const real = realPath(path);
  const patterns = compiled(g);
  return realDirs(g).some((dir) => {
    const rel = relativeInside(dir, real);
    return rel !== undefined && isProtected(rel, patterns);
  });
}

/**
 * The guard as absolute globs (`/`-separated, `**` for any number of folders), for a CLI whose rules
 * take them: a pattern with a `/` anchored at each working directory, one without at any depth (also at
 * the top, for a matcher whose `**` needs a folder), and everything under each match. A pattern with a
 * set read as text is left to `guardedNow()` and the checks after the team has answered.
 */
export function guardGlobs(g: WriteGuard): string[] {
  const out = new Set<string>();
  for (const dir of g.dirs) {
    const base = dir.split('\\').join('/').replace(/\/+$/, '');
    for (const p of globbable(g)) {
      const body = p.source.replace(/^\/+/, '').replace(/\/+$/, '');
      const anchored = p.source.startsWith('/') || body.includes('/');
      const tops = anchored ? [`${base}/${body}`] : [`${base}/${body}`, `${base}/**/${body}`];
      for (const t of tops) {
        out.add(t);
        if (!t.endsWith('/**')) out.add(`${t}/**`);
      }
    }
  }
  return [...out];
}

/**
 * Folders never looked in for what a guard matches today: git's own, and installed dependencies and
 * build caches, which can hold more entries than the walk's budget.
 */
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', 'target', '.next', '.gradle']);

/** What `guardedNow()` found for a guard: a turn asks for it more than once (Claude Code's settings and arguments). */
const found = new WeakMap<WriteGuard, string[]>();

/**
 * What the guard matches in its working directories now, as absolute real paths (a matching folder, not
 * what is under it), for a CLI whose rules take only literal paths: a path made after this (a new
 * `x.pem`) is not among them, nor a link that leads nowhere (a sandbox would put a stand-in at its
 * target). Folder by folder, the shallow ones first, never in `SKIP`; at most `limit` paths, after
 * looking at most `budget` entries in each working directory. Worked out once for a guard.
 */
export function guardedNow(g: WriteGuard, limit = 200, budget = 20_000): string[] {
  const known = found.get(g);
  if (known) return known;
  const patterns = compiled(g);
  const out: string[] = [];
  for (const root of realDirs(g)) {
    let seen = 0;
    const queue = [root];
    while (queue.length && out.length < limit && seen < budget) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (out.length >= limit || ++seen > budget) break;
        const path = join(dir, e.name);
        const rel = relativeInside(root, path);
        if (rel === undefined) continue;
        if (isProtected(rel, patterns)) {
          if (exists(path)) out.push(path);
        } else if (e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name)) queue.push(path);
      }
    }
  }
  found.set(g, out);
  return out;
}

/** Whether a path is there, following a link (one that leads nowhere is not). */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The longest regular expression sandbox-runtime may make of a glob: Seatbelt refuses a string over
 * about 1000 bytes (and the sandbox would not start).
 */
const MAX_SANDBOX_REGEX = 900;

/**
 * About how long sandbox-runtime's deny regex for a glob is (`denyGlobRegex`): a globstar and its slash
 * as six characters, a globstar alone as two, a star as five, `?` as four, a character a regex reads as
 * syntax escaped (two), and eight around it. Counted high, never low.
 */
export function sandboxRegexLength(glob: string): number {
  let n = 8;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      n += glob[i + 2] === '/' ? 6 : 2;
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') n += 5;
    else if (c === '?') n += 4;
    else n += /[.+^${}()|[\]\\-]/.test(c) ? 2 : 1;
  }
  return n;
}

/**
 * The guard as sandbox-runtime's `denyWrite` globs, for macOS only (on Linux it skips them, and Harness
 * Relay's sandbox host refuses to start with one): each working directory's own `[`, `*` and `?` as a
 * set of one, `**` inside a name as `*` (sandbox-runtime would cross folders), the path itself and what
 * is under it, at the top and, for a pattern without a `/`, in any folder below. A pattern with a negated
 * set (`[!x]`), which it cannot read, or a set read as text, and a glob whose regex would be too long for
 * Seatbelt, are left to `guardedNow()`.
 */
export function sandboxGuardGlobs(g: WriteGuard): string[] {
  const out = new Set<string>();
  for (const dir of g.dirs) {
    const base = dir.replace(/[[*?]/g, (c) => `[${c}]`).replace(/\/+$/, '');
    for (const p of globbable(g)) {
      const trimmed = p.source.replace(/^\/+/, '').replace(/\/+$/, '');
      if (/\[[!^]/.test(trimmed)) continue;
      const body = trimmed
        .split('/')
        .map((n) => (n === '**' ? n : n.replace(/\*{2,}/g, '*')))
        .join('/');
      const anchored = p.source.startsWith('/') || trimmed.includes('/');
      for (const top of anchored ? [`${base}/${body}`] : [`${base}/${body}`, `${base}/**/${body}`]) {
        for (const glob of [top, `${top}/**`]) if (sandboxRegexLength(glob) <= MAX_SANDBOX_REGEX) out.add(glob);
      }
    }
  }
  return [...out];
}
