// Alerts: when a conversation's agents finish their reply or need the user, the browser can show a
// system notification and play a sound, and the server can send a push notification to a phone
// (`src/server/push.ts`). Both decide what happened the same way, here, from the sidebar's summaries.

import { splitAsk } from './ask';
import type { AlertKind, AlertPrefs, ChatMessage, Conversation, ConversationSummary } from './types';

/** The kinds that need the user, in the order the sidebar puts them. */
export const NEEDS_KINDS: readonly AlertKind[] = ['approval', 'confirm', 'answer'];

/** Whether `kind` is one `prefs` asks for. */
export function wanted(kind: AlertKind, prefs: Pick<AlertPrefs, 'done' | 'needs'>): boolean {
  return NEEDS_KINDS.includes(kind) ? prefs.needs : prefs.done;
}

/** What a conversation needs from the user now, the most urgent first (as `convStatus` in the sidebar). */
export function needsOf(c: Pick<ConversationSummary, 'waiting' | 'confirmTeam' | 'asking' | 'running'>): AlertKind | undefined {
  if (c.waiting) return 'approval';
  if (c.confirmTeam) return 'confirm';
  if (c.asking && !c.running) return 'answer';
  return undefined;
}

/** The parts of a summary the alerts read (`branchFrom`: only whether it is a branch). */
export type AlertState = Pick<ConversationSummary, 'running' | 'waiting' | 'confirmTeam' | 'asking' | 'lastStatus' | 'lastReplyId' | 'branchFrom'>;

/**
 * A conversation as the alerts last saw it: its state and, while it runs, its latest agent reply when
 * the run began (`runFrom`; absent when that is not known: its reply was being written at the first look).
 */
export interface Seen {
  state: AlertState;
  runFrom?: { reply?: string };
}

const stateOf = (c: AlertState): AlertState => ({
  running: c.running,
  ...(c.waiting ? { waiting: true } : {}),
  ...(c.confirmTeam ? { confirmTeam: true } : {}),
  ...(c.asking ? { asking: true } : {}),
  ...(c.lastStatus ? { lastStatus: c.lastStatus } : {}),
  ...(c.lastReplyId ? { lastReplyId: c.lastReplyId } : {}),
});

/**
 * What to alert the user to, from how a conversation was last seen (undefined: not seen before, which
 * is no news unless it needs something) to its state now: something it needs that it did not before;
 * else, when a run ended with an agent reply it did not have when it began, how that reply ended
 * (`done`, `error`; a reply the user stopped is no news). So a run that ended without a reply of its
 * own (the lead agent designing a team, a run stopped before anyone answered) tells of nothing, and a
 * run that began and ended between two looks counts by the reply it left.
 */
export function alertFor(before: Seen | undefined, now: AlertState): AlertKind | undefined {
  // A branch just made (the user made it, here or on another device) is no news, also when it waits
  // for the answer to a question its last reply asked.
  if (!before && now.branchFrom) return undefined;
  const needs = needsOf(now);
  if (needs) return needs === (before && needsOf(before.state)) ? undefined : needs;
  if (now.running || !before) return undefined;
  const from = before.state.running ? before.runFrom : { reply: before.state.lastReplyId };
  const replied = !from || (now.lastReplyId !== undefined && now.lastReplyId !== from.reply);
  if (!replied) return undefined;
  return now.lastStatus === 'done' || now.lastStatus === 'error' ? now.lastStatus : undefined;
}

/**
 * How a conversation is remembered after a look: a run seen beginning keeps the reply it began after.
 * One already running at the first look began after its latest reply, unless that reply is still
 * being written (then it is the run's own, and when the run began is not known).
 */
export function seenAfter(before: Seen | undefined, now: AlertState): Seen {
  const state = stateOf(now);
  if (!now.running) return { state };
  if (before?.state.running) return before.runFrom ? { state, runFrom: before.runFrom } : { state };
  if (before) return { state, runFrom: before.state.lastReplyId ? { reply: before.state.lastReplyId } : {} };
  if (now.lastStatus === 'streaming') return { state };
  return { state, runFrom: now.lastReplyId ? { reply: now.lastReplyId } : {} };
}

/**
 * The alerts of the conversations' lists, one list after another (the page's polls, the server's
 * checks). The first list, or the first after `reset()`, is where it starts: nothing before is news.
 */
export class AlertTracker {
  private seen?: Map<string, Seen>;

  /** The alerts between the list before and this one. */
  next(list: readonly ConversationSummary[]): { conv: ConversationSummary; kind: AlertKind }[] {
    const before = this.seen;
    const seen = new Map<string, Seen>();
    const alerts: { conv: ConversationSummary; kind: AlertKind }[] = [];
    for (const conv of list) {
      const was = before?.get(conv.id);
      const kind = before ? alertFor(was, conv) : undefined;
      if (kind) alerts.push({ conv, kind });
      seen.set(conv.id, seenAfter(was, conv));
    }
    this.seen = seen;
    return alerts;
  }

  /** The next list is where it starts again. */
  reset(): void {
    this.seen = undefined;
  }
}

/** The longest snippet of a reply or question an alert shows. */
export const ALERT_SNIPPET_MAX = 140;

/** A reply's text as one short line: no ask marker, Markdown marks and runs of spaces. */
export function snippet(text: string, max = ALERT_SNIPPET_MAX): string {
  const line = splitAsk(text)
    .text.replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Who an alert is about and what they said, as far as the conversation tells. */
export interface AlertDetail {
  /** The agent's name. */
  agent?: string;
  /** What it said (a reply, a question) or asks to do (a command, a file), as one short line. */
  text?: string;
}

const textOf = (m: ChatMessage) =>
  m.parts
    .filter((p): p is Extract<ChatMessage['parts'][number], { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

const agentName = (conv: Pick<Conversation, 'agents'>, m: ChatMessage) =>
  m.agentName ?? (m.author.kind === 'agent' ? conv.agents.find((a) => a.id === (m.author as { agentId: string }).agentId)?.name : undefined);

/**
 * The agent an alert is about and what it said: the latest agent reply (its error, for `error`); the
 * approval waiting (its command, file or address); the question asked. Nothing for a team to confirm
 * (the lead agent designed it).
 */
export function alertDetail(conv: Pick<Conversation, 'agents' | 'messages'>, kind: AlertKind): AlertDetail {
  if (kind === 'confirm') return {};
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]!;
    if (m.author.kind !== 'agent') continue;
    const agent = agentName(conv, m);
    if (kind === 'approval') {
      const pending = m.parts.find((p) => p.type === 'approval' && p.status === 'pending');
      if (!pending || pending.type !== 'approval') continue;
      const what = pending.detail || pending.tool;
      return { ...(agent ? { agent } : {}), ...(what ? { text: snippet(what) } : {}) };
    }
    if (kind === 'answer' && !m.asked) continue;
    const text = snippet(kind === 'error' && m.error ? m.error : textOf(m));
    return { ...(agent ? { agent } : {}), ...(text ? { text } : {}) };
  }
  return {};
}

/** Where a notification about a conversation takes the user: the chat (the client's route, `#/c/<id>`). */
export const alertUrl = (convId: string) => `/#/c/${encodeURIComponent(convId)}`;

/** One notification per conversation: a newer one about it replaces the one before. */
export const alertTag = (convId: string) => `relay-${convId}`;
