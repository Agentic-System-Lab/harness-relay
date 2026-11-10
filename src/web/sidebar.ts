// The sidebar's pure logic: sorting conversations into groups, each family of branched conversations
// as a tree, and what a collapsed group or family shows.

import { byAge, families, familyOf, type FamilyMember } from '../shared/family';
import type { ConversationGroup, ConversationSummary } from '../shared/types';
import type { ConvStatus } from './locales/zh-TW';
import { convStatus } from './util';

/** The drag-and-drop data type that carries a conversation id. */
export const DRAG_TYPE = 'application/x-relay-conversation';

/** The key of the default group ("Other") in the sidebar's state (collapsed groups, drop targets). */
export const OTHER_KEY = 'other';

/** How deep branches are indented; deeper ones are not indented further. */
export const MAX_INDENT = 3;

/** A conversation in the sidebar's tree, under the one it was branched from. */
export interface ConvNode {
  /** The conversation's id, or a deleted one's. */
  id: string;
  /** Absent: a deleted conversation, which keeps its place while there are conversations below it. */
  conv?: ConversationSummary;
  /** The conversation's title; a deleted one's (see `deletedTitles()`; may be empty). */
  title: string;
  /** The conversations branched from it, oldest first. */
  children: ConvNode[];
}

export interface GroupSection {
  /** null: the default group, "Other". */
  group: ConversationGroup | null;
  /** Its conversations, newest first (the order they come in). */
  conversations: ConversationSummary[];
  /** The same conversations, one tree per family: the family with the latest activity first. */
  trees: ConvNode[];
}

const memberOf = (c: ConversationSummary): FamilyMember => ({
  id: c.id,
  createdAt: c.createdAt,
  ...(c.branchFrom
    ? { fromId: c.branchFrom.id, ...(c.branchFrom.via ? { via: c.branchFrom.via.map((v) => v.id) } : {}) }
    : {}),
});

const familiesOf = (conversations: ConversationSummary[]) => families(conversations.map(memberOf));

/**
 * The titles of deleted conversations with conversations below them: the one it had when it was
 * deleted, where a conversation further down remembers it, else its title when the newest of the
 * conversations branched from it was made.
 */
function deletedTitles(conversations: ConversationSummary[]): Map<string, string> {
  const titles = new Map<string, string>();
  // Oldest first: the newest one's title stays.
  for (const c of byAge(conversations)) if (c.branchFrom) titles.set(c.branchFrom.id, c.branchFrom.title);
  for (const c of conversations) for (const v of c.branchFrom?.via ?? []) titles.set(v.id, v.title);
  return titles;
}

/** The key of a section in the sidebar's state. */
export const sectionKey = (s: Pick<GroupSection, 'group'>) => s.group?.id ?? OTHER_KEY;

/**
 * The user's groups in their order, then "Other": each with its conversations, newest first (the
 * order they come in), and the same as trees. A family of branched conversations is in the group of
 * its oldest conversation, with each one under the conversation it was branched from; a deleted one
 * keeps its place, by its title, while there are conversations below it. `moves` are moves the
 * server has not confirmed yet; a conversation whose group is gone is in "Other".
 */
export function groupSections(
  conversations: ConversationSummary[],
  groups: ConversationGroup[],
  moves: Record<string, string | null> = {},
): GroupSection[] {
  const sections: GroupSection[] = [
    ...groups.map((g) => ({ group: g, conversations: [], trees: [] })),
    { group: null, conversations: [], trees: [] },
  ];
  const byId = new Map(groups.map((g, i) => [g.id, sections[i]!]));
  const other = sections[sections.length - 1]!;
  const fam = familiesOf(conversations);
  const titles = deletedTitles(conversations);
  const byFamily = new Map<string, ConversationSummary[]>();
  for (const c of conversations) {
    const key = fam.top.get(c.id)!;
    const list = byFamily.get(key);
    if (list) list.push(c);
    else byFamily.set(key, [c]);
  }
  const placed = new Map<string, GroupSection>();
  const latest = (list: ConversationSummary[]) => Math.max(...list.map((c) => c.updatedAt));
  // Sorting keeps the order they come in for families as recent as each other.
  for (const [key, list] of [...byFamily].sort(([, a], [, b]) => latest(b) - latest(a))) {
    const oldest = byAge(list)[0]!;
    const id = oldest.id in moves ? moves[oldest.id] : oldest.groupId;
    const section = (id ? byId.get(id) : undefined) ?? other;
    const gone = [...fam.deleted].filter((d) => fam.top.get(d) === key);
    section.trees.push(familyTree(key, list, gone, fam.parent, titles));
    placed.set(key, section);
  }
  for (const c of conversations) placed.get(fam.top.get(c.id)!)!.conversations.push(c);
  return sections;
}

/** One family as a tree, from its top `key`: its conversations, and the deleted ones (`gone`) among them. */
function familyTree(
  key: string,
  list: ConversationSummary[],
  gone: string[],
  parent: Map<string, string | undefined>,
  titles: Map<string, string>,
): ConvNode {
  const nodes = new Map<string, ConvNode>();
  for (const c of list) nodes.set(c.id, { id: c.id, conv: c, title: c.title, children: [] });
  for (const id of gone) nodes.set(id, { id, title: titles.get(id) ?? '', children: [] });
  const root = nodes.get(key)!;
  for (const [id, node] of nodes) {
    if (id === key) continue;
    const from = parent.get(id);
    (from !== undefined ? (nodes.get(from) ?? root) : root).children.push(node);
  }
  // A deleted conversation is placed by the oldest conversation below it, made after it.
  const ages = new Map<ConvNode, number>();
  const age = (n: ConvNode): number => {
    if (n.conv) return n.conv.createdAt;
    if (!ages.has(n)) ages.set(n, Math.min(Infinity, ...n.children.map(age)));
    return ages.get(n)!;
  };
  const order = (n: ConvNode) => {
    n.children.sort((a, b) => age(a) - age(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    n.children.forEach(order);
  };
  order(root);
  return root;
}

/** The conversations under a node of the tree, nearest first. */
export function descendants(node: ConvNode): ConversationSummary[] {
  const out: ConversationSummary[] = [];
  const queue = [...node.children];
  for (let n = queue.shift(); n; n = queue.shift()) {
    if (n.conv) out.push(n.conv);
    queue.push(...n.children);
  }
  return out;
}

/** The conversations in the same family as `id` (itself included): they move between groups together. */
export function familyIds(conversations: ConversationSummary[], id: string): string[] {
  return familyOf(conversations.map(memberOf), id);
}

/** How many conversations are in each conversation's family (itself included). */
export function familySizes(conversations: ConversationSummary[]): Map<string, number> {
  const { top } = familiesOf(conversations);
  const count = new Map<string, number>();
  for (const c of conversations) count.set(top.get(c.id)!, (count.get(top.get(c.id)!) ?? 0) + 1);
  return new Map(conversations.map((c) => [c.id, count.get(top.get(c.id)!)!]));
}

/** How many conversations are below `id`: branched from it, from those, and so on (also past deleted ones). */
export function branchCount(conversations: ConversationSummary[], id: string): number {
  const { parent } = familiesOf(conversations);
  const children = new Map<string, string[]>();
  for (const [child, from] of parent) if (from !== undefined) children.set(from, [...(children.get(from) ?? []), child]);
  const members = new Set(conversations.map((c) => c.id));
  const seen = new Set<string>();
  let n = 0;
  for (let queue = [...(children.get(id) ?? [])], next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (members.has(next)) n++;
    queue.push(...(children.get(next) ?? []));
  }
  return n;
}

/** The tree nodes above `id`, nearest first (deleted ones too). */
export function ancestorsOf(conversations: ConversationSummary[], id: string): string[] {
  const { parent } = familiesOf(conversations);
  const out: string[] = [];
  for (let up = parent.get(id); up !== undefined && !out.includes(up); up = parent.get(up)) out.push(up);
  return out;
}

/**
 * Hidden branches with `id` shown: the nodes above it no longer hide it (the same set when none did),
 * so a conversation that is opened is in view.
 */
export function revealIn(folded: Set<string>, conversations: ConversationSummary[], id: string): Set<string> {
  const hiding = ancestorsOf(conversations, id).filter((a) => folded.has(a));
  if (!hiding.length) return folded;
  const next = new Set(folded);
  for (const a of hiding) next.delete(a);
  return next;
}

/** Hidden branches of nodes still in the sidebar: the others are forgotten. */
export function foldedNow(folded: Set<string>, conversations: ConversationSummary[]): Set<string> {
  const { parent } = familiesOf(conversations);
  const parents = new Set([...parent.values()].filter((p): p is string => p !== undefined));
  return new Set([...folded].filter((id) => parents.has(id)));
}

/**
 * `moves` with the family of `id` moving to `groupId`, as the server moves it; `ids` are the
 * conversations that move, for `undoMoves`.
 */
export function moveFamily(
  moves: Record<string, string | null>,
  conversations: ConversationSummary[],
  id: string,
  groupId: string | null,
): { moves: Record<string, string | null>; ids: string[] } {
  const ids = familyIds(conversations, id);
  return { moves: { ...moves, ...Object.fromEntries(ids.map((m) => [m, groupId])) }, ids };
}

/** The move of `ids` failed: what `before` had for them comes back (nothing, where it had nothing). */
export function undoMoves(
  moves: Record<string, string | null>,
  ids: string[],
  before: Record<string, string | null>,
): Record<string, string | null> {
  const next = { ...moves };
  for (const id of ids) {
    if (id in before) next[id] = before[id]!;
    else delete next[id];
  }
  return next;
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

const COLLAPSED_GROUPS = 'relay:collapsedGroups';
const COLLAPSED_BRANCHES = 'relay:collapsedBranches';

function readKeys(key: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeKeys(key: string, keys: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...keys]));
  } catch {
    /* storage unavailable */
  }
}

/** Groups the user collapsed in this browser. */
export const readCollapsedGroups = () => readKeys(COLLAPSED_GROUPS);
export const writeCollapsedGroups = (keys: Set<string>) => writeKeys(COLLAPSED_GROUPS, keys);

/** Conversations whose branches the user hid in this browser (by the tree node's id). */
export const readCollapsedBranches = () => readKeys(COLLAPSED_BRANCHES);
export const writeCollapsedBranches = (keys: Set<string>) => writeKeys(COLLAPSED_BRANCHES, keys);
