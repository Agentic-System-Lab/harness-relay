/*
 * Long-term memory in the UI: Settings' list (src/web/memory.ts), a reply's card as a segment
 * (src/web/chat.ts), and shared pages leaving the card out (src/web/share.ts).
 */
import { describe, expect, it } from 'vitest';
import { segments, shownSegments } from '../src/web/chat';
import { en } from '../src/web/locales/en';
import {
  authorText,
  cardEntry,
  firstFilter,
  folderName,
  folderOptions,
  memoryCounts,
  memoryManaged,
  replacedBy,
  shownNotes,
  tidyStatus,
} from '../src/web/memory';
import { SHARE_DROP } from '../src/web/share';
import type { MemoryNote } from '../src/shared/types';

const note = (over: Partial<MemoryNote> & { id: string }): MemoryNote => ({
  text: over.id,
  basis: 'inferred',
  state: 'active',
  author: { kind: 'user' },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('long-term memory in Settings', () => {
  const notes = [
    note({ id: 'm_1', text: 'Uses pnpm', cwd: '/work/app' }),
    note({ id: 'm_2', text: 'Short answers', state: 'pending', replaces: ['m_3'] }),
    note({ id: 'm_3', text: 'Long answers', state: 'archived' }),
  ];

  it('counts the notes by state and opens on those waiting, when there are any', () => {
    expect(memoryCounts(notes)).toEqual({ active: 1, pending: 1, archived: 1 });
    expect(firstFilter(memoryCounts(notes))).toBe('pending');
    expect(firstFilter(memoryCounts([notes[0]!]))).toBe('active');
  });

  it('shows the notes of a state whose text, folder or id has every word searched', () => {
    expect(shownNotes(notes, 'active', '').map((n) => n.id)).toEqual(['m_1']);
    expect(shownNotes(notes, 'active', 'PNPM app').map((n) => n.id)).toEqual(['m_1']);
    expect(shownNotes(notes, 'active', 'npm yarn')).toEqual([]);
    expect(shownNotes(notes, 'archived', 'm_3').map((n) => n.id)).toEqual(['m_3']);
  });

  it('shows only its switch while it is off with no notes kept, and everything while it is on or holds notes', () => {
    const settings = { enabled: false, review: false, autoTidy: true };
    expect(memoryManaged({ settings, notes: [] })).toBe(false);
    expect(memoryManaged({ settings: { ...settings, enabled: true }, notes: [] })).toBe(true);
    expect(memoryManaged({ settings, notes: [notes[2]!] })).toBe(true);
  });

  it('names folders and offers each once', () => {
    expect(folderName('/work/app/')).toBe('app');
    expect(folderName('C:\\work\\lib')).toBe('lib');
    expect(folderOptions(notes, ['/work/b', '/work/app'])).toEqual(['/work/app', '/work/b']);
  });

  it('says who wrote a note, and which note replaced one', () => {
    expect(authorText(en, note({ id: 'x', author: { kind: 'agent', name: 'Alice', provider: 'codex' } }))).toBe('@Alice (Codex)');
    expect(authorText(en, note({ id: 'x', author: { kind: 'lead', provider: 'claude' } }))).toBe('the lead agent');
    expect(authorText(en, note({ id: 'x' }))).toBe('you');
    expect(replacedBy(notes, 'm_3')).toBe('m_2');
    expect(replacedBy(notes, 'm_1')).toBeUndefined();
  });
});

describe('what Settings says of tidying', () => {
  const when = (ms: number) => `t${ms}`;
  it('says the lead agent is tidying, how the last tidying went, and what changed since, without a stray separator', () => {
    expect(tidyStatus(en, { tidying: true, changedSinceTidy: 3 }, when)).toBe('The lead agent is tidying the memory…');
    expect(tidyStatus(en, { tidying: false, changedSinceTidy: 0 }, when)).toBe('');
    expect(tidyStatus(en, { tidying: false, changedSinceTidy: 2 }, when)).toBe('2 notes changed since the last tidying');
    expect(tidyStatus(en, { tidying: false, changedSinceTidy: 1, lastTidy: { at: 5, changes: 1, summary: 'Merged two.' } }, when)).toBe(
      'Last tidied t5: 1 change · Merged two. · 1 note changed since the last tidying',
    );
    expect(tidyStatus(en, { tidying: false, changedSinceTidy: 0, lastTidy: { at: 5, changes: 0, error: 'no JSON' } }, when)).toBe(
      'The last tidying failed (t5): no JSON',
    );
  });
});

describe("a reply's memory card", () => {
  it('is a segment of its own, when the reply saved something', () => {
    const part = { type: 'memory' as const, notes: [{ id: 'm_1', text: 'x', op: 'saved' as const, status: 'active' as const }] };
    expect(segments([{ type: 'text', text: 'Done.' }, part])).toEqual([
      { kind: 'text', text: 'Done.', key: 0 },
      { kind: 'memory', part, key: 1 },
    ]);
    expect(segments([{ type: 'memory', notes: [] }])).toEqual([]);
  });

  it('stays shown under a reply that passed', () => {
    const segs = segments([
      { type: 'text', text: '[PASS]' },
      { type: 'memory', notes: [{ id: 'm_1', text: 'x', op: 'saved', status: 'active' }] },
    ]);
    expect(shownSegments(segs, true, false).shown.map((s) => s.kind)).toEqual(['memory']);
  });

  it("offers what fits each note, and no state for one the reply set aside (the saving reply's card follows it)", () => {
    const n = { id: 'm_1', text: 'x', op: 'saved' as const };
    expect(cardEntry({ ...n, status: 'pending' })).toEqual({ status: true, action: 'keep' });
    expect(cardEntry({ ...n, status: 'active' })).toEqual({ status: true, action: 'archive' });
    expect(cardEntry({ ...n, status: 'archived' })).toEqual({ status: true, action: 'restore' });
    expect(cardEntry({ ...n, status: 'deleted' })).toEqual({ status: true, action: 'none' });
    expect(cardEntry({ ...n, op: 'forgotten', status: 'archived' })).toEqual({ status: false, action: 'none' });
    expect(cardEntry({ text: 'x', op: 'saved', status: 'skipped', skipped: 'full' })).toEqual({ status: true, action: 'none' });
  });

  it('stays out of a shared page', () => {
    expect(SHARE_DROP).toContain('.memory-card');
  });
});
