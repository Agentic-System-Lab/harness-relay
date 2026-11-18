import { checksFailed, commitPatternError, tidyFolder, tidyPattern } from '../shared/checks';
import { CHECK_LIMITS, type AgentConfig, type ChatMessage, type CheckCommand, type CheckList } from '../shared/types';

/*
 * Team checks in the page: the editor's fields (Team settings, the template editor) and what the card
 * after the team's replies offers. Kept apart from the components so that it can be tested.
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
 * The list the editor's fields make (a command row without a command line is left out). With all of
 * them empty: none for a conversation or template that had none (a template's is then copied in), an
 * empty one for one that had a list (it stays without).
 */
export function listFrom(
  paths: string,
  commitPattern: string,
  before: CheckList | undefined,
  commands: readonly CheckCommand[] = [],
): CheckList | undefined {
  const protectedPaths = pathsFromText(paths);
  const pattern = commitPattern.trim();
  const kept = commands.filter((c) => c.run.trim()).map(keptCommand);
  if (!protectedPaths.length && !pattern && !kept.length) return before === undefined ? undefined : {};
  return {
    ...(protectedPaths.length ? { protectedPaths } : {}),
    ...(pattern ? { commitPattern: pattern } : {}),
    ...(kept.length ? { commands: kept } : {}),
  };
}

/** How many rules a list has (the editor's summary). */
export function ruleCount(list: CheckList | undefined): number {
  return (list?.protectedPaths?.length ?? 0) + (list?.commitPattern ? 1 : 0) + (list?.commands?.length ?? 0);
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
  // Commands the run's changes kept from running: Check again runs them once the user confirms.
  const confirm = gatedFiles(msg).length > 0;
  return { recheck: true, fix: open, skip: open, confirm };
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
