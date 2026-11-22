import { blocking, checksFailed, commitPatternError, needsFix, tidyFolder, tidyPattern } from '../shared/checks';
import { CHECK_LIMITS, type AgentConfig, type ChatMessage, type CheckCommand, type CheckHook, type CheckList } from '../shared/types';
import type { Messages } from './i18n';

/*
 * Team checks in the page: the editor's fields (Team settings, the template editor, and Settings → Tool
 * library's default, which New chat and New automation start with) and what the card after the team's
 * replies offers. Kept apart from the components so that it can be tested.
 */

/** The protected paths box's text: a pattern a line. */
export function pathsText(list: CheckList | undefined): string {
  return (list?.protectedPaths ?? []).join('\n');
}

/** The box's lines as patterns: trimmed, empty ones left out, each once (the server tidies them too). */
export function pathsFromText(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const p = line.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The first line of the box that cannot be a pattern, if any. */
export function badPath(text: string): string | undefined {
  return pathsFromText(text).find((p) => !tidyPattern(p));
}

/** Why the commit pattern cannot be read, if it cannot. */
export function badCommitPattern(pattern: string): string | undefined {
  const p = pattern.trim();
  return p ? commitPatternError(p) : undefined;
}

/** What is wrong with a command row, if anything: no command line, a folder that leaves the working directory, a time limit out of range. */
export function commandProblem(c: Pick<CheckCommand, 'run' | 'cwd' | 'timeoutMin'>): 'run' | 'folder' | 'timeout' | undefined {
  if (!c.run.trim()) return 'run';
  if (c.cwd && tidyFolder(c.cwd) === undefined) return 'folder';
  const m = c.timeoutMin;
  if (m !== undefined && (!Number.isInteger(m) || m < 1 || m > CHECK_LIMITS.maxTimeoutMin)) return 'timeout';
  return undefined;
}

/** What is wrong with a hook row, if anything: no command line, a folder that leaves the working directory, a time limit out of range. */
export function hookProblem(h: Pick<CheckHook, 'run' | 'cwd' | 'timeoutSec'>): 'run' | 'folder' | 'timeout' | undefined {
  if (!h.run.trim()) return 'run';
  if (h.cwd && tidyFolder(h.cwd) === undefined) return 'folder';
  const s = h.timeoutSec;
  if (s !== undefined && (!Number.isInteger(s) || s < 1 || s > CHECK_LIMITS.maxHookTimeoutSec)) return 'timeout';
  return undefined;
}

/** Validation shared by team, template and default checks forms. */
export function checkProblems(list: CheckList | undefined, t: Messages['checks']): string[] {
  if (!list) return [];
  const problems: string[] = [];
  const path = badPath(pathsText(list));
  if (path) problems.push(t.badPath(path));
  const pattern = badCommitPattern(list.commitPattern ?? '');
  if (pattern) problems.push(t.badPattern(pattern));
  for (const c of list.commands ?? []) {
    const problem = commandProblem(c);
    if (problem === 'run') problems.push(t.badCommand);
    else if (problem === 'folder') problems.push(t.badFolder(c.cwd ?? ''));
    else if (problem === 'timeout') problems.push(t.badTimeout(CHECK_LIMITS.maxTimeoutMin));
  }
  for (const h of list.hooks ?? []) {
    const problem = hookProblem(h);
    if (problem === 'run') problems.push(t.badCommand);
    else if (problem === 'folder') problems.push(t.badFolder(h.cwd ?? ''));
    else if (problem === 'timeout') problems.push(t.badHookTimeout(CHECK_LIMITS.maxHookTimeoutSec));
  }
  return problems;
}

/** A hook row as the list keeps it: trimmed, the defaults left out. */
function keptHook(h: CheckHook): CheckHook {
  const cwd = h.cwd?.trim();
  return {
    id: h.id,
    when: h.when,
    tools: h.tools,
    run: h.run.trim(),
    ...(cwd ? { cwd } : {}),
    ...(h.timeoutSec !== undefined && h.timeoutSec !== CHECK_LIMITS.hookTimeoutSec ? { timeoutSec: h.timeoutSec } : {}),
  };
}

/** Hook rows ready to save, leaving out empty command lines. */
export function hooksFromRows(rows: readonly CheckHook[]): CheckHook[] {
  return rows.filter((h) => h.run.trim()).map(keptHook);
}

/** A command row as the list keeps it: trimmed, the defaults left out. */
function keptCommand(c: CheckCommand): CheckCommand {
  const cwd = c.cwd?.trim();
  return {
    id: c.id,
    run: c.run.trim(),
    ...(cwd ? { cwd } : {}),
    ...(c.timeoutMin !== undefined && c.timeoutMin !== CHECK_LIMITS.timeoutMin ? { timeoutMin: c.timeoutMin } : {}),
    ...(c.localPorts ? { localPorts: true } : {}),
    ...(c.unixSockets ? { unixSockets: true } : {}),
  };
}

/**
 * The list the editor's fields make (a command or hook row without a command line is left out). With
 * all of them empty: none for a conversation or template that had none (a template's is then copied
 * in), an empty one for one that had a list (it stays without).
 */
export function listFrom(
  paths: string,
  commitPattern: string,
  before: CheckList | undefined,
  commands: readonly CheckCommand[] = [],
  hooks: readonly CheckHook[] = [],
  flags: Pick<CheckList, 'previewApp' | 'autoFix'> = {},
): CheckList | undefined {
  const protectedPaths = pathsFromText(paths);
  const pattern = commitPattern.trim();
  const kept = commands.filter((c) => c.run.trim()).map(keptCommand);
  const keptHooks = hooksFromRows(hooks);
  if (!protectedPaths.length && !pattern && !kept.length && !keptHooks.length && !flags.previewApp && !flags.autoFix)
    return before === undefined ? undefined : {};
  return {
    ...(protectedPaths.length ? { protectedPaths } : {}),
    ...(pattern ? { commitPattern: pattern } : {}),
    ...(kept.length ? { commands: kept } : {}),
    ...(keptHooks.length ? { hooks: keptHooks } : {}),
    ...(flags.previewApp ? { previewApp: true as const } : {}),
    ...(flags.autoFix ? { autoFix: true as const } : {}),
  };
}

/**
 * Settings' default as a new chat or automation starts with it: a copy, marked (`fromDefault`) so that a
 * template the lead agent picks with a list of its own replaces it; none without rules.
 */
export function startingChecks(list: CheckList | undefined): CheckList | undefined {
  return list && ruleCount(list) > 0 ? { ...structuredClone(list), fromDefault: true } : undefined;
}

/** Whether two lists have the same rules: what the server keeps as they are (command ids and the default's mark aside). */
export function sameChecks(a: CheckList | undefined, b: CheckList | undefined): boolean {
  const key = (l: CheckList | undefined) =>
    JSON.stringify([
      l?.protectedPaths ?? [],
      l?.commitPattern ?? '',
      (l?.commands ?? []).map((c) => {
        const k = keptCommand(c);
        return [k.run, k.cwd ?? '', k.timeoutMin ?? 0, Boolean(k.localPorts), Boolean(k.unixSockets)];
      }),
      (l?.hooks ?? []).map((h) => {
        const k = keptHook(h);
        return [k.when, k.tools, k.run, k.cwd ?? '', k.timeoutSec ?? 0];
      }),
      Boolean(l?.previewApp),
      Boolean(l?.autoFix),
    ]);
  return key(a) === key(b);
}

/** How many rules a list has (the editor's summary). */
export function ruleCount(list: CheckList | undefined): number {
  return (
    (list?.protectedPaths?.length ?? 0) +
    (list?.commitPattern ? 1 : 0) +
    (list?.commands?.length ?? 0) +
    (list?.hooks?.length ?? 0) +
    (list?.previewApp ? 1 : 0)
  );
}

/** The files a result's commands were kept from running for (the run changed what they read), if any. */
export function gatedFiles(msg: ChatMessage): string[] {
  return [...new Set((msg.checks?.outcomes ?? []).flatMap((o) => o.configChanged ?? []))];
}

/**
 * What a result's card offers: only the conversation's latest result, and nothing while the team
 * replies. Check again, always; Fix and Skip, when it did not pass and was not skipped.
 */
export function cardActions(
  msg: ChatMessage,
  latest: boolean,
  running: boolean,
): { recheck: boolean; fix: boolean; skip: boolean; confirm: boolean } {
  const none = { recheck: false, fix: false, skip: false, confirm: false };
  const c = msg.checks;
  if (!c || running || c.status === 'running' || !latest) return none;
  const open = checksFailed(c) && !c.skippedAt;
  // Checked before applying: applying it again checks it again, so the card has no Check again of its own.
  if (c.when === 'apply')
    return { recheck: false, fix: open && c.outcomes.some(needsFix), skip: open && c.outcomes.some(blocking), confirm: false };
  // Commands the run's changes kept from running: Check again runs them once the user confirms; they
  // are nothing for a member to fix, nor is a command that was stopped or cannot run here.
  const confirm = gatedFiles(msg).length > 0;
  return { recheck: true, fix: open && c.outcomes.some(needsFix), skip: open && c.outcomes.some(blocking), confirm };
}

/**
 * A result checked before a parallel-mode result was applied, that held it back: the member whose result
 * the user may apply anyway (its id), on the latest result, while nobody replies.
 */
export function applyAnyway(msg: ChatMessage, latest: boolean, running: boolean): string | undefined {
  const c = msg.checks;
  if (!c || c.when !== 'apply' || !c.applyOf || c.applied || running || !latest || c.status === 'running') return undefined;
  return c.outcomes.some(blocking) ? c.applyOf.agentId : undefined;
}

/** The members a fix can be asked of: those a finding names first (in the order found), then the others. */
export function fixCandidates(msg: ChatMessage, agents: readonly AgentConfig[]): AgentConfig[] {
  const named: string[] = [];
  for (const o of msg.checks?.outcomes ?? []) {
    for (const f of o.findings ?? []) if (f.by && !named.includes(f.by)) named.push(f.by);
  }
  const first = named.flatMap((name) => agents.filter((a) => a.name === name));
  return [...first, ...agents.filter((a) => !first.includes(a))];
}

/**
 * What the lead agent's draft changed in a list, a line each, as listed under its note (none: the
 * same rules). A command or hook is told apart by its id (kept when the lead kept it), else by its line.
 */
export function checksChanges(before: CheckList | undefined, after: CheckList | undefined, t: Messages): string[] {
  const c = t.checksDraft.change;
  const out: string[] = [];
  const was = before?.protectedPaths ?? [];
  const now = after?.protectedPaths ?? [];
  for (const p of now) if (!was.includes(p)) out.push(c.pathAdded(p));
  for (const p of was) if (!now.includes(p)) out.push(c.pathRemoved(p));
  const pattern = (l: CheckList | undefined) => l?.commitPattern?.trim() ?? '';
  if (pattern(after) !== pattern(before)) out.push(pattern(after) ? c.patternSet(pattern(after)) : c.patternRemoved);
  const rows = <T extends { id: string; run: string }>(
    a: readonly T[],
    b: readonly T[],
    same: (x: T, y: T) => boolean,
    added: (run: string) => string,
    removed: (run: string) => string,
    changed: (run: string) => string,
  ) => {
    const matched = new Set<T>();
    for (const y of b) {
      const x = a.find((x) => !matched.has(x) && x.id === y.id) ?? a.find((x) => !matched.has(x) && x.run.trim() === y.run.trim());
      if (!x) {
        out.push(added(y.run.trim()));
        continue;
      }
      matched.add(x);
      if (!same(x, y)) out.push(changed(y.run.trim()));
    }
    for (const x of a) if (!matched.has(x)) out.push(removed(x.run.trim()));
  };
  rows(
    (before?.commands ?? []).map(keptCommand),
    (after?.commands ?? []).map(keptCommand),
    (x, y) => sameChecks({ commands: [x] }, { commands: [y] }),
    c.commandAdded,
    c.commandRemoved,
    c.commandChanged,
  );
  rows(
    hooksFromRows(before?.hooks ?? []),
    hooksFromRows(after?.hooks ?? []),
    (x, y) => sameChecks({ hooks: [x] }, { hooks: [y] }),
    c.hookAdded,
    c.hookRemoved,
    c.hookChanged,
  );
  if (Boolean(after?.previewApp) !== Boolean(before?.previewApp)) out.push(after?.previewApp ? c.previewOn : c.previewOff);
  if (Boolean(after?.autoFix) !== Boolean(before?.autoFix)) out.push(after?.autoFix ? c.autoFixOn : c.autoFixOff);
  return out;
}

/** The flags of a list, as the editor keeps them. */
export function flagsOf(list: CheckList | undefined): Pick<CheckList, 'previewApp' | 'autoFix'> {
  return { ...(list?.previewApp ? { previewApp: true as const } : {}), ...(list?.autoFix ? { autoFix: true as const } : {}) };
}
