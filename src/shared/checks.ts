import {
  CHECK_LIMITS,
  type ChatMessage,
  type CheckHook,
  type CheckList,
  type CheckOutcome,
  type CheckStatus,
  type ChecksResult,
} from './types';

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

/**
 * Whether a pattern has a `[` the checks read as text, which a glob would read otherwise: one whose `]`
 * is not in the same name (a glob's set may cross a `/`), a set a regular expression refuses
 * (`[user-id]`), and a set that starts with `]` (`[]x]`, which sandbox-runtime reads as text). Name by
 * name, as `nameRegex()` reads them.
 */
export function hasTextSet(pattern: string): boolean {
  for (const name of pattern.split('/')) {
    for (let i = 0; i < name.length; i++) {
      if (name[i] !== '[') continue;
      const end = name.indexOf(']', i + 2);
      if (end < 0) return true;
      let body = name.slice(i + 1, end);
      const negate = body.startsWith('!') || body.startsWith('^');
      if (negate) body = body.slice(1);
      if (!body || body.startsWith(']')) return true;
      if (!validSet(`[${negate ? '^/' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`)) return true;
      i = end;
    }
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

/** Programs that run the script named after them (their options skipped). */
const HOOK_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'node',
  'nodejs',
  'tsx',
  'bun',
  'deno',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
]);
/** Programs that run the command named after them. */
const HOOK_WRAPPERS = new Set(['env', 'exec', 'command', 'time', 'nice', 'nohup']);

/**
 * A hook's command line as a shell reads its words, as far as needed here: quotes and backslashes taken
 * off; `null` where one command ends and another starts (`;`, `&&`, `|`, a line break, a bracket);
 * `undefined` for a word only the shell knows (it holds a variable, a substitution or a wildcard), or
 * the file of a redirection.
 */
function hookWords(run: string): (string | null | undefined)[] {
  const out: (string | null | undefined)[] = [];
  let word = '';
  let open = false;
  let dynamic = false;
  let quote: '"' | "'" | undefined;
  let redirect = false;
  const end = () => {
    if (open) out.push(dynamic || redirect ? undefined : word);
    if (open) redirect = false;
    word = '';
    open = false;
    dynamic = false;
  };
  for (let i = 0; i < run.length; i++) {
    const c = run[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '$' || c === '`') dynamic = true;
      else if (c === '\\' && i + 1 < run.length) word += run[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      open = true;
    } else if (c === '\\' && i + 1 < run.length) {
      word += run[++i];
      open = true;
    } else if (/\s/.test(c)) {
      end();
      if (c === '\n') out.push(null);
    } else if (';|&(){}'.includes(c)) {
      end();
      out.push(null);
    } else if (c === '<' || c === '>') {
      end();
      redirect = true;
    } else {
      if ('$`*?[~'.includes(c)) dynamic = true;
      word += c;
      open = true;
    }
  }
  end();
  return out;
}

/**
 * The scripts the hooks' command lines run from the working directory, as protected path patterns
 * anchored there: a member that could change a hook's own script could switch the hook off. Only what a
 * command line runs: the program of each command when it is named by a path (`./scripts/allow.sh`,
 * `tools/check`), and the script an interpreter is given (`sh ci/check.sh`, `node tools/check.js`,
 * `python3 lint.py`), from the hook's folder or the one a `cd` before it names. Never its other
 * arguments (a folder to lint, a pattern), a subcommand (`bun test`), a full path (not told from here),
 * one that leaves the folder, or a word only the shell knows. What
 * else a hook reads (a script run through `npm run` or `make`, what a script loads) is the user's to
 * list under protected paths.
 */
export function hookFilePatterns(hooks: readonly Pick<CheckHook, 'run' | 'cwd'>[] | undefined): string[] {
  const out: string[] = [];
  const name = (word: string) => word.slice(word.lastIndexOf('/') + 1);
  for (const h of hooks ?? []) {
    const base = (h.cwd ?? '').replace(/\\/g, '/');
    if (base.startsWith('/') || /^[A-Za-z]:\//.test(base)) continue;
    // The folder the commands run in: the hook's, until a `cd`; unknown after one that cannot be followed.
    let dir: string[] | undefined = base.split('/').filter((n) => n && n !== '.');
    /** `word` from the folder the commands are in, as names; undefined when it leaves the working directory or cannot be told. */
    const from = (word: string): string[] | undefined => {
      if (!dir || word.startsWith('/') || /^[A-Za-z]:/.test(word) || word.includes('\\')) return undefined;
      const names = [...dir];
      for (const n of word.split('/')) {
        if (!n || n === '.') continue;
        if (n !== '..') names.push(n);
        else if (names.length) names.pop();
        else return undefined;
      }
      return names;
    };
    const add = (word: string) => {
      // A file, never a folder: a word that ends in `/` names what the program works on.
      if (word.endsWith('/')) return;
      const names = from(word);
      const tidy = names?.length ? tidyPattern(`/${names.join('/')}`) : undefined;
      if (tidy && !out.includes(tidy)) out.push(tidy);
    };
    // Where in a command a word is: its program (`command`), a `cd`'s folder, the script an interpreter runs (`script`), or neither.
    let at: 'command' | 'cd' | 'script' | 'rest' = 'command';
    let shell = false;
    for (const word of hookWords(h.run)) {
      if (word === null) {
        // `cd` with no folder goes home: where the next commands run is not known.
        if (at === 'cd') dir = undefined;
        at = 'command';
      } else if (at === 'cd') {
        dir = word === undefined ? undefined : from(word);
        at = 'rest';
      } else if (word === undefined) at = 'rest';
      else if (at === 'command') {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue; // a variable set for the command
        if (HOOK_WRAPPERS.has(name(word))) continue;
        if (word === 'cd') at = 'cd';
        else if (HOOK_INTERPRETERS.has(name(word))) {
          at = 'script';
          shell = /^(?:sh|bash|zsh|dash|ksh)$/.test(name(word));
        } else {
          if (word.includes('/')) add(word);
          at = 'rest';
        }
      } else if (at === 'script') {
        if (word.startsWith('-')) {
          // An option after which no script follows: the program itself as text (`sh -c '…'`, `node -e '…'`), a
          // module (`python -m`), or a test runner's files (`node --test`).
          if (shell ? /^-[a-zA-Z]*c$/.test(word) : /^-[cemp]$/.test(word) || /^--(?:eval|print|test)$/.test(word)) at = 'rest';
          continue;
        }
        if (word === 'run') continue; // `deno run`, `bun run`
        // Only a word that reads as a file: a script's ending, or a path. A subcommand (`bun test`, `deno
        // lint`) or an option's value (`--tsconfig tsconfig.json`) is not the script.
        if (/\.(?:sh|bash|zsh|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|pl|php)$/.test(word) || word.includes('/')) add(word);
        at = 'rest';
      }
    }
  }
  return out;
}

/**
 * Every protected path pattern of a list: its own, and the scripts its hooks' command lines run
 * (`hookFilePatterns()`), each once. What the checks compare, what a CLI is to refuse writing, and what
 * the members are told.
 */
export function protectedPatterns(list: CheckList | undefined): string[] {
  return [...new Set([...(list?.protectedPaths ?? []), ...hookFilePatterns(list?.hooks)])];
}

/** Whether a list has any rule to check once the team has answered (its hooks run during the turns instead; the files they name are checked). */
export function hasChecks(list: CheckList | undefined): list is CheckList {
  return Boolean(list?.previewApp) || hasApplyChecks(list);
}

/**
 * Whether a list has a rule checked again before a result is applied (in a check tree with the result in
 * it): all but the app preview, which the run's own result checked where the member made the app.
 */
export function hasApplyChecks(list: CheckList | undefined): list is CheckList {
  return Boolean(list && (protectedPatterns(list).length || list.commitPattern || list.commands?.length));
}

/** Whether a list has anything at all: a rule to check, or a hook. */
export function hasRules(list: CheckList | undefined): list is CheckList {
  return Boolean(
    list && (list.protectedPaths?.length || list.commitPattern || list.commands?.length || list.hooks?.length || list.previewApp),
  );
}

/** Whether a hook runs around a call of this kind (`other`: neither a command nor a file change). */
export function hookApplies(hook: Pick<CheckHook, 'tools'>, kind: 'command' | 'edit' | 'other'): boolean {
  return hook.tools === 'any' || hook.tools === kind;
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

/** The conversation's latest own team checks result (its message), if any. */
export function latestChecks(messages: readonly ChatMessage[]): ChatMessage | undefined {
  return messages.findLast((m) => m.checks && !m.checks.historical);
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
