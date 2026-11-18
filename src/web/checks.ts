import { checksFailed, commitPatternError, tidyPattern } from '../shared/checks';
import type { AgentConfig, ChatMessage, CheckList } from '../shared/types';

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

/**
 * The list the editor's fields make. With both empty: none for a conversation or template that had
 * none (a template's is then copied in), an empty one for one that had a list (it stays without).
 */
export function listFrom(paths: string, commitPattern: string, before: CheckList | undefined): CheckList | undefined {
  const protectedPaths = pathsFromText(paths);
  const pattern = commitPattern.trim();
  if (!protectedPaths.length && !pattern) return before === undefined ? undefined : {};
  return { ...(protectedPaths.length ? { protectedPaths } : {}), ...(pattern ? { commitPattern: pattern } : {}) };
}

/** How many rules a list has (the editor's summary). */
export function ruleCount(list: CheckList | undefined): number {
  return (list?.protectedPaths?.length ?? 0) + (list?.commitPattern ? 1 : 0);
}

/**
 * What a result's card offers: only the conversation's latest result, and nothing while the team
 * replies. Check again, always; Fix and Skip, when it did not pass and was not skipped.
 */
export function cardActions(msg: ChatMessage, latest: boolean, running: boolean): { recheck: boolean; fix: boolean; skip: boolean } {
  const none = { recheck: false, fix: false, skip: false };
  const c = msg.checks;
  if (!c || running || c.status === 'running' || !latest) return none;
  const open = checksFailed(c) && !c.skippedAt;
  return { recheck: true, fix: open, skip: open };
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
