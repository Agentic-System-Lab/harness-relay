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

/** The parts of a summary the alerts read. */
export type AlertState = Pick<ConversationSummary, 'running' | 'waiting' | 'confirmTeam' | 'asking' | 'lastStatus' | 'lastReplyId'>;

/**
 * What to alert the user to, from a conversation's state before (undefined: a conversation not seen
 * before, which was then neither running nor needing anything) to now: something it needs that it did
 * not before; else, when its run ended, how its latest reply ended (`done`, `error`; a reply the user
 * stopped is no news). A run ended when it was running before, or when there is a reply it did not
 * have (a run shorter than the time between the two looks).
 */
export function alertFor(before: AlertState | undefined, now: AlertState): AlertKind | undefined {
  const needs = needsOf(now);
  if (needs) return needs === (before && needsOf(before)) ? undefined : needs;
  const replied = before !== undefined && now.lastReplyId !== undefined && now.lastReplyId !== before.lastReplyId;
  if (now.running || !(before?.running || replied)) return undefined;
  return now.lastStatus === 'done' || now.lastStatus === 'error' ? now.lastStatus : undefined;
}

/** The conversations' alerts between two lists of their summaries (`before` keyed by id). */
export function alertsBetween(
  before: ReadonlyMap<string, AlertState>,
  now: readonly ConversationSummary[],
): { conv: ConversationSummary; kind: AlertKind }[] {
  const alerts: { conv: ConversationSummary; kind: AlertKind }[] = [];
  for (const conv of now) {
    const kind = alertFor(before.get(conv.id), conv);
    if (kind) alerts.push({ conv, kind });
  }
  return alerts;
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
