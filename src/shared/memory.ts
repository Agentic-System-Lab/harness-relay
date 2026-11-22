import { MEMORY_BASES, MEMORY_LIMITS, type MemoryBasis, type MemoryNote } from './types';

/*
 * Long-term memory: notes that last across conversations (docs/architecture.md, "Long-term memory").
 * An agent saves one with a block on lines of its own in its reply,
 *
 *   <remember scope="everywhere|project" basis="user|checked|inferred">one note</remember>
 *
 * corrects one with the same block and the note's id (`<remember id="m_…">`), and sets one aside with
 * `<forget id="m_…"/>` (or `<forget id="m_…">why</forget>`, on one line). The blocks are taken out of
 * the reply's text, the chat shows them as a card instead, and the server keeps each note as a row of
 * its own, so agents writing at once never overwrite each other's notes.
 *
 * Only what is plainly a block is taken: it starts a line (indented at most three spaces), nothing but
 * other blocks follows it on its last line, it is not code (in a fence, or indented as code) and does
 * not run across a fence. Anything else, an example of the syntax among them, stays as text. Pure,
 * shared by the server and the UI.
 */

/** What one block asks. */
export type MemoryOp =
  | { kind: 'remember'; text: string; id?: string; scope?: 'everywhere' | 'project'; basis?: MemoryBasis }
  | { kind: 'forget'; id: string; reason?: string };

/** A fence's opening or closing line: three or more backticks or tildes, indented at most three spaces. */
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
/** A fence line anywhere in a text (one a block must not run across). */
const FENCE_LINE = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})/;
/** A block's opening tag, its attributes in group 2: at a line's start, or right after another block. */
const OPEN = /<(remember|forget)\b([^>\n]*)>/iy;
/** The longest a note's block may be: past it, the block is not one an agent wrote for a note. */
const MAX_BLOCK = 2 * MEMORY_LIMITS.noteChars;

/** A value of the attributes of an opening tag, quoted or not. */
function attr(attrs: string, name: 'id' | 'scope' | 'basis'): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`/]+))`, 'i').exec(attrs);
  const value = m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
  return value || undefined;
}

function scopeOf(value: string | undefined): 'everywhere' | 'project' | undefined {
  const v = value?.toLowerCase();
  if (v === 'project' || v === 'here' || v === 'local' || v === 'folder') return 'project';
  if (v === 'everywhere' || v === 'global' || v === 'all') return 'everywhere';
  return undefined;
}

function basisOf(value: string | undefined): MemoryBasis | undefined {
  const v = value?.toLowerCase();
  if (v === 'verified' || v === 'confirmed') return 'checked';
  if (v === 'guess' || v === 'assumed' || v === 'unconfirmed') return 'inferred';
  return (MEMORY_BASES as readonly string[]).includes(v ?? '') ? (v as MemoryBasis) : undefined;
}

/** Where the current line ends (its `\n`, or the end of `text`). */
const lineEnd = (text: string, pos: number) => {
  const nl = text.indexOf('\n', pos);
  return nl < 0 ? text.length : nl;
};

/** The block whose opening tag is at `pos`, and where it ends; undefined when there is none. */
function blockAt(text: string, pos: number): { op: MemoryOp; end: number } | undefined {
  OPEN.lastIndex = pos;
  const open = OPEN.exec(text);
  if (!open) return undefined;
  const tag = open[1]!.toLowerCase();
  let attrs = open[2] ?? '';
  const afterOpen = OPEN.lastIndex;
  const selfClosed = /\/\s*$/.test(attrs);
  if (selfClosed) attrs = attrs.replace(/\/\s*$/, '');
  if (tag === 'remember') {
    if (selfClosed) return undefined;
    const close = /<\/remember\s*>/gi;
    close.lastIndex = afterOpen;
    const m = close.exec(text);
    if (!m || m.index - afterOpen > MAX_BLOCK) return undefined;
    const body = text.slice(afterOpen, m.index);
    // An unfinished block before another one, or one that runs across code: not a note.
    if (/<remember\b/i.test(body) || FENCE_LINE.test(body)) return undefined;
    const id = attr(attrs, 'id');
    const scope = scopeOf(attr(attrs, 'scope'));
    const basis = basisOf(attr(attrs, 'basis'));
    return {
      op: { kind: 'remember', text: body.trim(), ...(id ? { id } : {}), ...(scope ? { scope } : {}), ...(basis ? { basis } : {}) },
      end: close.lastIndex,
    };
  }
  const id = attr(attrs, 'id') ?? '';
  if (selfClosed) return { op: { kind: 'forget', id }, end: afterOpen };
  // `<forget id="…">why</forget>` on its line, or an opening tag alone (as if it closed itself).
  const close = /<\/forget\s*>/gi;
  close.lastIndex = afterOpen;
  const m = close.exec(text);
  if (m && m.index < lineEnd(text, afterOpen)) {
    const reason = text.slice(afterOpen, m.index).trim();
    return { op: { kind: 'forget', id, ...(reason ? { reason } : {}) }, end: close.lastIndex };
  }
  return { op: { kind: 'forget', id }, end: afterOpen };
}

/**
 * The blocks that start the line at `pos` (after at most three spaces) and end a line, one after
 * another, and where that line's break is; undefined when the line is not blocks alone.
 */
function blocksAt(text: string, pos: number): { ops: MemoryOp[]; end: number } | undefined {
  const indent = /^[ \t]*/.exec(text.slice(pos, pos + 8))![0];
  if (indent.replace(/\t/g, '    ').length > 3) return undefined;
  const ops: MemoryOp[] = [];
  let p = pos + indent.length;
  for (;;) {
    const block = blockAt(text, p);
    if (!block) return undefined;
    ops.push(block.op);
    p = block.end;
    while (p < text.length && (text[p] === ' ' || text[p] === '\t')) p++;
    if (p >= text.length || text[p] === '\n') return { ops, end: p };
  }
}

/** Where the fence opened by `mark` on the line ending at `end` closes: after its closing line, or the end of `text`. */
function fenceEnd(text: string, end: number, mark: string): number {
  let pos = end < text.length ? end + 1 : text.length;
  while (pos < text.length) {
    const e = lineEnd(text, pos);
    const line = text.slice(pos, e);
    const m = FENCE.exec(line);
    if (m && m[1]![0] === mark[0] && m[1]!.length >= mark.length && !line.trim().slice(m[1]!.length).trim()) {
      return e < text.length ? e + 1 : text.length;
    }
    pos = e < text.length ? e + 1 : text.length;
  }
  return text.length;
}

/** A line of indented code: four spaces (or a tab) in, after a blank line or another such line. */
const indentedCode = (line: string) => /^(?: {4}|\t)/.test(line);

/**
 * The memory blocks of a reply, in order (at most `MEMORY_LIMITS.perReply`; the rest are dropped), and
 * its text without them. Only lines of blocks alone are taken, outside code (see the top of this file).
 */
export function splitMemory(text: string): { text: string; ops: MemoryOp[] } {
  if (!/<(?:remember|forget)\b/i.test(text)) return { text, ops: [] };
  const src = text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
  const ops: MemoryOp[] = [];
  let out = '';
  let pos = 0;
  /** In indented code: the line before was code or blank after code. */
  let inCode = false;
  let prevBlank = true;
  while (pos < src.length) {
    const end = lineEnd(src, pos);
    const next = end < src.length ? end + 1 : src.length;
    const line = src.slice(pos, end);
    const fence = FENCE.exec(line);
    if (fence) {
      const after = fenceEnd(src, end, fence[1]!);
      out += src.slice(pos, after);
      pos = after;
      inCode = false;
      prevBlank = false;
      continue;
    }
    const blank = !line.trim();
    if (!blank && indentedCode(line) && (prevBlank || inCode)) inCode = true;
    else if (!blank) inCode = false;
    const run = !inCode && !blank ? blocksAt(src, pos) : undefined;
    if (!run) {
      out += src.slice(pos, next);
      pos = next;
      prevBlank = blank;
      continue;
    }
    ops.push(...run.ops);
    pos = run.end < src.length ? run.end + 1 : src.length;
    // A block on lines of its own was taken out: the blank line after it goes too when one is before it.
    if (!out || out.endsWith('\n\n')) {
      const e = lineEnd(src, pos);
      if (e < src.length && !src.slice(pos, e).trim()) pos = e + 1;
    }
    prevBlank = true;
  }
  if (!ops.length) return { text, ops };
  return { text: out.trimEnd(), ops: ops.slice(0, MEMORY_LIMITS.perReply) };
}

/**
 * A reply's text while it streams: without its finished memory blocks, nor one that has begun at the
 * start of a line (or a tag still being typed there), which the server takes out once the reply ends.
 */
export function withoutMemoryBlocks(text: string): string {
  if (!/<(?:r|f|$)/i.test(text)) return text;
  let rest = splitMemory(text).text;
  let last = -1;
  for (const m of rest.matchAll(/(?:^|\n) {0,3}<(?:remember|forget)\b/gi)) last = m.index;
  if (last >= 0 && !/<\/remember\s*>/i.test(rest.slice(last)) && !FENCE_LINE.test(rest.slice(last))) rest = rest.slice(0, last);
  // `<rem`, `<forg`… being typed at the start of the last line.
  rest = rest.replace(/(?:^|\n) {0,3}<(?:r(?:e(?:m(?:e(?:m(?:b(?:e(?:r)?)?)?)?)?)?)?|f(?:o(?:r(?:g(?:e(?:t)?)?)?)?)?)?$/i, '');
  return rest.trimEnd();
}

// --- Choosing notes for a turn ------------------------------------------------------------------

/** Letters of the scripts written without spaces between words: matched by pairs of characters. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Words too common to tell notes apart. */
const STOP = new Set(
  (
    'the and for with that this from have has had are was were will would can could should you your yours our ours they them ' +
    'their its not but all any when what which who whom how why into onto about than then also just only more most some such ' +
    'very each other been being there here where does did done doing make made like want need please lets let use used using ' +
    'one two out over under after before again once both same own too yes not nor off per via etc was is be do'
  ).split(' '),
);
const CJK_STOP = new Set(
  '我們 你們 他們 可以 一個 這個 那個 什麼 如何 因為 所以 但是 如果 就是 還是 沒有 需要 的話 這樣 那樣 時候 一下 一些 已經 現在 自己 知道 告訴 請問 謝謝 幫我 我要 我想'.split(
    ' ',
  ),
);

/** A word without its plural or common endings, so that "projects" matches "project". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * The terms a text is matched by: its words (lower case, without common endings and words too common
 * to tell notes apart), and in Chinese, Japanese or Korean, each pair of characters in a row.
 */
export function memoryTerms(text: string): string[] {
  const out: string[] = [];
  const word = (w: string) => {
    if (w.length >= 2 && !STOP.has(w)) out.push(stem(w));
  };
  const run = (r: string) => {
    const chars = [...r];
    for (let i = 0; i + 1 < chars.length; i++) {
      const pair = chars[i]! + chars[i + 1]!;
      if (!CJK_STOP.has(pair)) out.push(pair);
    }
  };
  for (const m of text
    .normalize('NFKC')
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}_]+/gu)) {
    let latin = '';
    let cjk = '';
    for (const ch of m[0]) {
      if (CJK.test(ch)) {
        if (latin) word(latin);
        latin = '';
        cjk += ch;
      } else {
        if (cjk) run(cjk);
        cjk = '';
        latin += ch;
      }
    }
    if (latin) word(latin);
    if (cjk) run(cjk);
  }
  return out;
}

/** The lowest score a recalled note needs: a term the notes rarely have, or a few common ones. */
export const RECALL_MIN_SCORE = 1.5;

/**
 * How well each note matches `query` (BM25 over the notes, as if there were at least ten), the best
 * first; notes below `min` are left out.
 */
export function rankNotes<T extends { text: string }>(
  notes: readonly T[],
  query: string,
  min = RECALL_MIN_SCORE,
): { note: T; score: number }[] {
  const q = new Set(memoryTerms(query));
  if (!q.size || !notes.length) return [];
  const docs = notes.map((note) => {
    const terms = memoryTerms(note.text);
    const tf = new Map<string, number>();
    for (const t of terms) if (q.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { note, tf, len: Math.max(1, terms.length) };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(docs.length, 10);
  const avg = docs.reduce((s, d) => s + d.len, 0) / docs.length;
  const k1 = 1.2;
  const b = 0.75;
  return docs
    .map((d) => {
      let score = 0;
      for (const [t, f] of d.tf) {
        const idf = Math.log(1 + (n - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg));
      }
      return { note: d.note, score };
    })
    .filter((r) => r.score >= min)
    .sort((x, y) => y.score - x.score);
}

/** Whether a note holds in a conversation with these working directories. */
export function inScope(note: Pick<MemoryNote, 'cwd'>, cwds: readonly string[]): boolean {
  return !note.cwd || cwds.includes(note.cwd);
}

/** Notes in order until their text reaches `chars` (one too long for what is left is passed over), at most `limit`. */
function within<T extends { text: string }>(notes: readonly T[], chars: number, limit = Infinity): T[] {
  const out: T[] = [];
  let used = 0;
  for (const n of notes) {
    if (out.length >= limit) break;
    if (used + n.text.length > chars) continue;
    out.push(n);
    used += n.text.length;
  }
  return out;
}

/**
 * The layer always loaded: the active pinned notes that hold in these working directories, those
 * the user pinned first, then the newest, within `MEMORY_LIMITS.pinnedChars`.
 */
export function pinnedFor(notes: readonly MemoryNote[], cwds: readonly string[]): MemoryNote[] {
  const pinned = notes
    .filter((n) => n.state === 'active' && n.pinned && inScope(n, cwds))
    .sort((a, b) => Number(b.pinned === 'user') - Number(a.pinned === 'user') || b.updatedAt - a.updatedAt);
  return within(pinned, MEMORY_LIMITS.pinnedChars);
}

/**
 * The notes to recall for `query` (what was said since the agent's last turn): active, not pinned
 * (those are loaded already), in scope, not `skip`ped, the best matches first (a note of these working
 * directories counts a quarter more), at most `MEMORY_LIMITS.recallNotes` and `recallChars`.
 */
export function recallFor(
  notes: readonly MemoryNote[],
  cwds: readonly string[],
  query: string,
  skip: (n: MemoryNote) => boolean,
): MemoryNote[] {
  const candidates = notes.filter((n) => n.state === 'active' && !n.pinned && inScope(n, cwds) && !skip(n));
  const ranked = rankNotes(candidates, query)
    .map((r) => ({ ...r, score: r.note.cwd ? r.score * 1.25 : r.score }))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.note);
  return within(ranked, MEMORY_LIMITS.recallChars, MEMORY_LIMITS.recallNotes);
}
