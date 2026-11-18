import { readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { CheckList } from '../shared/types';
import { compilePattern, isProtected, type CompiledPattern } from '../shared/checks';

/**
 * The team checks' protected paths, for a CLI to refuse writing them before it happens (each adapter in
 * its own way: `docs/sandboxing.md`, "The team's protected paths"). Reads stay allowed; what no CLI
 * refuses is still found once the team has answered (`src/server/checks.ts`).
 */
export interface WriteGuard {
  /** The run's working directories (in parallel mode the member's worktrees), each as its real path. */
  dirs: string[];
  /** The protected paths, tidied (`tidyPattern`): gitignore-like, relative to each working directory. */
  patterns: string[];
}

/** A run's guard: undefined when the list protects nothing. */
export function writeGuard(list: CheckList | undefined, dirs: readonly string[]): WriteGuard | undefined {
  // Tidied (`./a` is `a`), as every translation reads them.
  const patterns = [...new Set((list?.protectedPaths ?? []).flatMap((p) => compilePattern(p)?.source ?? []))];
  if (!patterns.length || !dirs.length) return undefined;
  return { dirs: [...new Set(dirs.map(realPath))], patterns };
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

/** Whether writing `path` (absolute) is writing one of the guard's protected paths, in any of its folders. */
export function isGuarded(g: WriteGuard | undefined, path: string): boolean {
  if (!g) return false;
  const real = realPath(path);
  const patterns = compiled(g);
  return g.dirs.some((dir) => {
    const rel = relativeInside(dir, real);
    return rel !== undefined && isProtected(rel, patterns);
  });
}

/**
 * The guard as absolute globs (`/`-separated, `**` for any number of folders), for a CLI whose rules
 * take them: a pattern with a `/` anchored at each working directory, one without at any depth (also at
 * the top, for a matcher whose `**` needs a folder), and everything under each match.
 */
export function guardGlobs(g: WriteGuard): string[] {
  const out = new Set<string>();
  for (const dir of g.dirs) {
    const base = dir.split('\\').join('/').replace(/\/+$/, '');
    for (const p of compiled(g)) {
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

/** Folders never looked in for what a guard matches today: git's own, and installed dependencies. */
const SKIP = new Set(['.git', 'node_modules']);

/**
 * What the guard matches in its working directories now, as absolute paths (a matching folder, not what
 * is under it), for a CLI whose rules take only literal paths: a path made after this (a new `x.pem`)
 * is not among them. At most `limit` paths, after looking at most `budget` entries.
 */
export function guardedNow(g: WriteGuard, limit = 200, budget = 20_000): string[] {
  const patterns = compiled(g);
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string, root: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit || ++seen > budget) return;
      const path = join(dir, e.name);
      const rel = relativeInside(root, path);
      if (rel === undefined) continue;
      if (isProtected(rel, patterns)) out.push(path);
      else if (e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name)) walk(path, root);
    }
  };
  for (const dir of g.dirs) walk(dir, dir);
  return out;
}

/** The longest glob given to a sandbox: Seatbelt refuses a string over about 1000 bytes and would not start. */
const MAX_SANDBOX_GLOB = 900;

/**
 * The guard as sandbox-runtime's `denyWrite` globs, for macOS only (on Linux it skips them, and Harness
 * Relay's sandbox host refuses to start with one): each working directory's own `[`, `*` and `?` as a
 * set of one, `**` inside a name as `*` (sandbox-runtime would cross folders), the path itself and what
 * is under it, at the top and, for a pattern without a `/`, in any folder below. A pattern with a negated
 * set (`[!x]`), which it cannot read, and a glob too long for Seatbelt are left to `guardedNow()`.
 */
export function sandboxGuardGlobs(g: WriteGuard): string[] {
  const out = new Set<string>();
  for (const dir of g.dirs) {
    const base = dir.replace(/[[*?]/g, (c) => `[${c}]`).replace(/\/+$/, '');
    for (const p of compiled(g)) {
      const trimmed = p.source.replace(/^\/+/, '').replace(/\/+$/, '');
      if (/\[[!^]/.test(trimmed)) continue;
      const body = trimmed
        .split('/')
        .map((n) => (n === '**' ? n : n.replace(/\*{2,}/g, '*')))
        .join('/');
      const anchored = p.source.startsWith('/') || trimmed.includes('/');
      for (const top of anchored ? [`${base}/${body}`] : [`${base}/${body}`, `${base}/**/${body}`]) {
        for (const glob of [top, `${top}/**`]) if (glob.length <= MAX_SANDBOX_GLOB) out.add(glob);
      }
    }
  }
  return [...out];
}
