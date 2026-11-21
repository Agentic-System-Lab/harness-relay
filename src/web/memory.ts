// Long-term memory as Settings and a reply's card show it: pure, so it can be tested without a DOM.

import { PROVIDER_LABEL, type MemoryNote, type MemoryState, type MemoryView } from '../shared/types';
import type { Messages } from './locales/zh-TW';

/** How many notes are in each state. */
export function memoryCounts(notes: readonly MemoryNote[]): Record<MemoryState, number> {
  const out: Record<MemoryState, number> = { active: 0, pending: 0, archived: 0 };
  for (const n of notes) out[n.state]++;
  return out;
}

/** The list Settings opens on: the notes waiting for the user when there are any, else those in use. */
export function firstFilter(counts: Record<MemoryState, number>): MemoryState {
  return counts.pending ? 'pending' : 'active';
}

/** The notes of one state whose text, folder or id holds every word of `query` (ignoring case), in the order given. */
export function shownNotes(notes: readonly MemoryNote[], state: MemoryState, query: string): MemoryNote[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return notes.filter((n) => {
    if (n.state !== state) return false;
    const hay = `${n.text}\n${n.cwd ?? ''}\n${n.id}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A folder's last name ("/work/app" → "app"), for a short label; the whole path goes in its title. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The folders a note can be made to hold in: those notes hold in and those given (the working directories), each once, sorted. */
export function folderOptions(notes: readonly MemoryNote[], folders: readonly string[]): string[] {
  return [...new Set([...folders, ...notes.flatMap((n) => (n.cwd ? [n.cwd] : []))])].sort((a, b) => a.localeCompare(b));
}

/** Who wrote a note, or last changed it. */
export function authorText(t: Messages, n: Pick<MemoryNote, 'author'>): string {
  const a = n.author;
  if (a.kind === 'user') return t.longTerm.you;
  if (a.kind === 'lead') return t.longTerm.lead;
  return t.longTerm.agent(a.name, PROVIDER_LABEL[a.provider]);
}

/** The note that took this one's place (a correction the user kept, or a merge), if one did. */
export function replacedBy(notes: readonly MemoryNote[], id: string): string | undefined {
  return notes.find((n) => n.state !== 'archived' && n.replaces?.includes(id))?.id;
}

/**
 * What Settings says of tidying: that the lead agent is at it, or how the last tidying went (with its
 * summary), then how many notes changed since; '' when there is nothing to say.
 */
export function tidyStatus(
  t: Messages,
  view: Pick<MemoryView, 'tidying' | 'lastTidy' | 'changedSinceTidy'>,
  when: (ms: number) => string,
): string {
  const m = t.longTerm;
  if (view.tidying) return m.tidying;
  const last = view.lastTidy;
  const parts = last?.error
    ? [m.lastTidyFailed(when(last.at), last.error)]
    : last
      ? [m.lastTidy(when(last.at), last.changes), ...(last.summary ? [last.summary] : [])]
      : [];
  if (view.changedSinceTidy > 0) parts.push(m.changedSince(view.changedSinceTidy));
  return parts.join(' · ');
}
