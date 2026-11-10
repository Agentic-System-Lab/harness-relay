// Families of branched conversations: shared by the server (a family moves between sidebar groups
// together) and the client (the sidebar shows each family as a tree).
//
// "Branch conversation" makes a new conversation from another one. A conversation, the ones branched
// from it, the ones branched from those, and so on are one family. A deleted conversation keeps its
// place in it: the conversations below it remember where it came from (`ConversationBranch.via`), so
// they stay under the conversation above it. The top of a family is the conversation none of them was
// branched from; when that one is deleted, its id, so the branches made from it stay together.

/** What the family of a conversation is worked out from. */
export interface FamilyMember {
  id: string;
  createdAt: number;
  /** The conversation it was branched from (which may have been deleted since). */
  fromId?: string;
  /** Once that one is deleted: where it came from, and so on, nearest first (`ConversationBranch.via`). */
  via?: string[];
}

export interface Families {
  /**
   * The parent of each conversation and of each deleted one with conversations below it: the one it
   * was branched from (a member's id or a deleted one's), or undefined for the top of a family.
   */
  parent: Map<string, string | undefined>;
  /** The family of each of them, by the id of its top (a member's, or a deleted conversation's). */
  top: Map<string, string>;
  /** The deleted conversations with conversations below them. */
  deleted: Set<string>;
}

/**
 * The families of `members`. A loop (which a branch cannot make: it always comes from a conversation
 * made before it) is cut where it is found, so every family is still a tree.
 */
export function families(members: readonly FamilyMember[]): Families {
  const byId = new Map(members.map((m) => [m.id, m]));
  // Where each deleted conversation came from, as the conversations below it remember it.
  const deletedUp = new Map<string, string | undefined>();
  for (const m of members) {
    if (m.fromId === undefined) continue;
    const chain = [m.fromId, ...(m.via ?? [])];
    for (let i = 0; i < chain.length && !byId.has(chain[i]!); i++) {
      if (deletedUp.get(chain[i]!) === undefined) deletedUp.set(chain[i]!, chain[i + 1]);
    }
  }
  const up = (id: string) => (byId.has(id) ? byId.get(id)!.fromId : deletedUp.get(id));

  const parent = new Map<string, string | undefined>();
  const top = new Map<string, string>();
  for (const start of [...byId.keys(), ...deletedUp.keys()]) {
    if (top.has(start)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur = start;
    let found: string;
    for (;;) {
      const known = top.get(cur);
      if (known !== undefined) {
        found = known;
        break;
      }
      path.push(cur);
      onPath.add(cur);
      const next = up(cur);
      if (next === undefined || next === cur || onPath.has(next)) {
        parent.set(cur, undefined);
        found = cur;
        break;
      }
      parent.set(cur, next);
      cur = next;
    }
    for (const id of path) top.set(id, found);
  }
  return { parent, top, deleted: new Set(deletedUp.keys()) };
}

/** The ids of the conversations in the same family as `id` (itself included), oldest first. */
export function familyOf(members: readonly FamilyMember[], id: string): string[] {
  const { top } = families(members);
  const key = top.get(id);
  if (key === undefined || !members.some((m) => m.id === id)) return [];
  return byAge(members.filter((m) => top.get(m.id) === key)).map((m) => m.id);
}

/** Oldest first; made at the same moment, by id, so the order is the same everywhere. */
export function byAge<T extends Pick<FamilyMember, 'id' | 'createdAt'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
