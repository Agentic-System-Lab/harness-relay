import type { ConversationGroup, GroupReorganize, GroupSuggestion } from '../shared/types';
import type { Messages } from './i18n';

/*
 * The sidebar's "Organize groups": the lead agent's suggestions (`GroupSuggestion`), each one the user
 * ticks or not, and what applying the ticked ones sends (`POST /api/groups/reorganize`). Kept apart from
 * the dialog so that it can be tested.
 */

/** Each suggestion's key, as the dialog's boxes name them. */
export const createKey = (key: string) => `create:${key}`;
export const renameKey = (id: string) => `rename:${id}`;
export const moveKey = (convId: string) => `move:${convId}`;

/** Every suggestion's key: all of them are ticked to begin with. */
export function suggestionKeys(s: GroupSuggestion): string[] {
  return [...s.create.map((c) => createKey(c.key)), ...s.rename.map((r) => renameKey(r.id)), ...s.move.map((m) => moveKey(m.convId))];
}

/** A move into a new group the user did not tick cannot be made: that group will not be there. */
export function moveBlocked(s: GroupSuggestion, chosen: ReadonlySet<string>, to: string | null): boolean {
  return to !== null && s.create.some((c) => c.key === to) && !chosen.has(createKey(to));
}

/** The ticked suggestions that can be made, as the server takes them. */
export function reorganizeOf(s: GroupSuggestion, chosen: ReadonlySet<string>): GroupReorganize {
  return {
    create: s.create.filter((c) => chosen.has(createKey(c.key))),
    rename: s.rename.filter((r) => chosen.has(renameKey(r.id))).map(({ id, name }) => ({ id, name })),
    move: s.move.filter((m) => chosen.has(moveKey(m.convId)) && !moveBlocked(s, chosen, m.to)).map(({ convId, to }) => ({ convId, to })),
  };
}

/** How many suggestions applying makes. */
export function chosenCount(s: GroupSuggestion, chosen: ReadonlySet<string>): number {
  const r = reorganizeOf(s, chosen);
  return r.create.length + r.rename.length + r.move.length;
}

/**
 * A group a move goes to, by name as it will be: a new one's marked new, a renamed one's new name when
 * that rename is ticked, the default group's "Other".
 */
export function targetName(
  s: GroupSuggestion,
  groups: ConversationGroup[],
  chosen: ReadonlySet<string>,
  to: string | null,
  t: Messages,
): string {
  if (to === null) return t.sidebar.otherGroup;
  const created = s.create.find((c) => c.key === to);
  if (created) return t.groupsDraft.newGroup(created.name);
  const renamed = s.rename.find((r) => r.id === to);
  if (renamed && chosen.has(renameKey(renamed.id))) return renamed.name;
  return groups.find((g) => g.id === to)?.name ?? t.sidebar.otherGroup;
}
