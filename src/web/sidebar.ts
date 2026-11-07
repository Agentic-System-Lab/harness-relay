// The sidebar's pure logic: sorting conversations into groups, and what a collapsed group shows.

import type { ConversationGroup, ConversationSummary } from '../shared/types';
import type { ConvStatus } from './locales/zh-TW';
import { convStatus } from './util';

/** The drag-and-drop data type that carries a conversation id. */
export const DRAG_TYPE = 'application/x-relay-conversation';

/** The key of the default group ("Other") in the sidebar's state (collapsed groups, drop targets). */
export const OTHER_KEY = 'other';

export interface GroupSection {
  /** null: the default group, "Other". */
  group: ConversationGroup | null;
  conversations: ConversationSummary[];
}

/** The key of a section in the sidebar's state. */
export const sectionKey = (s: Pick<GroupSection, 'group'>) => s.group?.id ?? OTHER_KEY;

/**
 * The user's groups in their order, then "Other": each with its conversations, newest first (the
 * order they come in). `moves` are moves the server has not confirmed yet; a conversation whose
 * group is gone is in "Other".
 */
export function groupSections(
  conversations: ConversationSummary[],
  groups: ConversationGroup[],
  moves: Record<string, string | null> = {},
): GroupSection[] {
  const sections: GroupSection[] = [...groups.map((g) => ({ group: g, conversations: [] })), { group: null, conversations: [] }];
  const byId = new Map(groups.map((g, i) => [g.id, sections[i]!]));
  const other = sections[sections.length - 1]!;
  for (const c of conversations) {
    const id = c.id in moves ? moves[c.id] : c.groupId;
    (id ? (byId.get(id) ?? other) : other).conversations.push(c);
  }
  return sections;
}

/** The group a conversation is in, as far as the sidebar knows (`null`: "Other"). */
export function groupOf(c: Pick<ConversationSummary, 'groupId'>, groups: ConversationGroup[]): string | null {
  return c.groupId && groups.some((g) => g.id === c.groupId) ? c.groupId : null;
}

/** Moves the server now reports are dropped from `moves` (returns the same object when nothing changed). */
export function settleMoves(
  moves: Record<string, string | null>,
  conversations: ConversationSummary[],
): Record<string, string | null> {
  const left = Object.entries(moves).filter(([id, groupId]) => {
    const c = conversations.find((x) => x.id === id);
    return c !== undefined && (c.groupId ?? null) !== groupId;
  });
  return left.length === Object.keys(moves).length ? moves : Object.fromEntries(left);
}

/** Most urgent first. */
const URGENCY: ConvStatus[] = ['waiting', 'confirm', 'answer', 'running', 'error', 'unread'];

/** What a collapsed group shows about its conversations: the most urgent of their states. */
export function groupStatus(conversations: ConversationSummary[], seen: Record<string, number>): ConvStatus | undefined {
  let best: number | undefined;
  for (const c of conversations) {
    const s = convStatus(c, seen[c.id]);
    const i = s ? URGENCY.indexOf(s) : -1;
    if (i >= 0 && (best === undefined || i < best)) best = i;
  }
  return best === undefined ? undefined : URGENCY[best];
}

const COLLAPSED_KEY = 'relay:collapsedGroups';

/** Groups the user collapsed in this browser. */
export function readCollapsedGroups(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroups(keys: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys]));
  } catch {
    /* storage unavailable */
  }
}
