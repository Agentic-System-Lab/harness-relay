import { CHECK_LIMITS, type ChatMessage, type CheckList, type CheckOutcome, type CheckStatus, type ChecksResult } from './types';

/*
 * Team checks (`ConversationSettings.checks`): the parts the server and the chat share. The patterns of
 * protected paths, how a list's rules are read, and where a conversation's latest result stands.
 */

/** A protected path pattern, read (`compilePattern`). */
export interface CompiledPattern {
  /** As the user wrote it, tidied (`tidyPattern`). */
  source: string;
  /** Matches a `/`-separated path relative to the working directory, and everything under it. */
  regex: RegExp;
  /**
   * The folder to look in (`/`-separated, relative): the pattern's leading names without wildcards, for
   * one anchored at the working directory; empty for one that matches at any depth.
   */
  base: string;
}

const WILD = /[*?[]/;

/**
 * A pattern as it is kept: trimmed, `\` read as `/`, a leading `./` and repeated `/` taken out. Undefined
 * for one that cannot be one: empty, too long, a drive or a path that leaves the working directory (`..`).
 */
export function tidyPattern(input: string): string | undefined {
  let p = input.trim().replace(/\\/g, '/');
  if (!p || p.length > CHECK_LIMITS.pattern) return undefined;
  if (/^[A-Za-z]:/.test(p) || p.startsWith('//')) return undefined;
  p = p.replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  const names = p.split('/').filter(Boolean);
  if (!names.length || names.some((n) => n === '..' || n === '.')) return undefined;
  return p;
}

const escapeText = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function validSet(set: string): boolean {
  try {
    new RegExp(set);
    return true;
  } catch {
    return false;
  }
}

/** Whether a pattern has a `[…]` set a regular expression refuses: it is then read as text, never a set. */
export function hasTextSet(pattern: string): boolean {
  for (const m of pattern.matchAll(/\[([!^]?)([^\]]+)\]/g)) {
    if (!validSet(`[${m[1] ? '^/' : ''}${m[2]!.replace(/[\\\]^]/g, '\\$&')}]`)) return true;
  }
  return false;
}

/** A pattern's regular expression for one name (no `/`): `*`, `?` and `[…]` (`[!…]` excludes). */
function nameRegex(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (c === '*') {
      while (name[i + 1] === '*') i++; // `a**b` is `a*b`
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = name.indexOf(']', i + 2);
      if (end < 0) {
        out += '\\[';
        continue;
      }
      let body = name.slice(i + 1, end);
      const negate = body.startsWith('!') || body.startsWith('^');
      if (negate) body = body.slice(1);
      const set = `[${negate ? '^/' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      // A set a regular expression refuses (`[user-id]`, a backwards range) is the text it is, as
      // sandbox-runtime reads it: a Next.js route's folder, say.
      out += validSet(set) ? set : escapeText(name.slice(i, end + 1));
      i = end;
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return out;
}

/**
 * Read a protected path pattern (gitignore-like): a pattern with a `/` (but a trailing one) is anchored
 * at the working directory, one without matches a name at any depth; `**` is any number of folders; a
 * path that matches also covers everything under it (a folder). Undefined for one `tidyPattern` refuses.
 */
export function compilePattern(input: string): CompiledPattern | undefined {
  const source = tidyPattern(input);
  if (!source) return undefined;
  const trimmed = source.replace(/^\/+/, '').replace(/\/+$/, '');
  const anchored = source.startsWith('/') || trimmed.includes('/');
  const names = trimmed.split('/');
  let re = '';
  names.forEach((name, i) => {
    const last = i === names.length - 1;
    if (name === '**') re += last ? '.*' : '(?:[^/]+/)*';
    else re += nameRegex(name) + (last ? '' : '/');
  });
  const base: string[] = [];
  if (anchored) {
    for (const name of names.slice(0, -1)) {
      if (WILD.test(name)) break;
      base.push(name);
    }
    // A pattern with no wildcard at all is a path: look at it directly.
    if (!names.some((n) => WILD.test(n))) base.splice(0, base.length, ...names);
  }
  const regex = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`);
  return { source, regex, base: base.join('/') };
}

/** Whether a `/`-separated relative path is protected by any of these patterns. */
export function isProtected(path: string, patterns: readonly CompiledPattern[]): boolean {
  return patterns.some((p) => p.regex.test(path));
}

/** Whether a list has any rule to check. */
export function hasChecks(list: CheckList | undefined): list is CheckList {
  return Boolean(list && (list.protectedPaths?.length || list.commitPattern || list.commands?.length));
}

/**
 * A command's folder as it is kept: trimmed, `\` read as `/`; empty for the first working directory.
 * Undefined for one that cannot be one: a relative path that leaves the folder (`..`), or too long.
 */
export function tidyFolder(input: string): string | undefined {
  const f = input.trim();
  if (!f) return '';
  if (f.length > CHECK_LIMITS.folder) return undefined;
  // A full path is checked against the working directories when the command runs.
  if (f.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f)) return f;
  const names = f
    .replace(/\\/g, '/')
    .split('/')
    .filter((n) => n && n !== '.');
  if (names.some((n) => n === '..')) return undefined;
  return names.join('/');
}

/** A commit pattern that JavaScript can read, or the reason it cannot. */
export function commitPatternError(pattern: string): string | undefined {
  try {
    new RegExp(pattern);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

const RANK: Record<CheckStatus, number> = { running: 4, failed: 3, error: 2, passed: 1, na: 0 };

/**
 * Where a result stands as a whole: checking while any rule is; failed when any rule failed; could not
 * be checked when any could not (never a pass); passed when the others passed; nothing to check when
 * none had anything.
 */
export function overallStatus(outcomes: readonly Pick<CheckOutcome, 'status'>[]): CheckStatus {
  let best: CheckStatus = 'na';
  for (const o of outcomes) if (RANK[o.status] > RANK[best]) best = o.status;
  return best;
}

/** A result that is not a pass: it failed, or it could not be checked. */
export function checksFailed(result: Pick<ChecksResult, 'status'>): boolean {
  return result.status === 'failed' || result.status === 'error';
}

/**
 * An outcome that keeps the result from going on by itself: it failed or could not be checked, unless
 * all it says is that a command could not run for no fault of the team's (`notRun`).
 */
export function blocking(o: Pick<CheckOutcome, 'status' | 'notRun'>): boolean {
  return (o.status === 'failed' || o.status === 'error') && !o.notRun;
}

/** An outcome the team is to fix: a blocking one that is not only commands held back by changed settings (the user decides those). */
export function needsFix(o: Pick<CheckOutcome, 'status' | 'notRun' | 'configChanged'>): boolean {
  return blocking(o) && !o.configChanged?.length;
}

/** The conversation's latest team checks result (its message), if any. */
export function latestChecks(messages: readonly ChatMessage[]): ChatMessage | undefined {
  return messages.findLast((m) => m.checks);
}

/**
 * The latest result holds what waits in the queue: it did not pass, something in it blocks (`blocking`:
 * not only commands stopped or not run here), and the user has not gone on without it. The user's own
 * Send still sends.
 */
export function checksHold(messages: readonly ChatMessage[]): ChatMessage | undefined {
  const latest = latestChecks(messages);
  const c = latest?.checks;
  return c && checksFailed(c) && !c.skippedAt && c.outcomes.some(blocking) ? latest : undefined;
}
