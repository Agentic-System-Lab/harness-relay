/**
 * A unified diff (`git diff`, as the server sends a turn's or an agent's changes) split into its files,
 * for the diff dialog's sections: each file's path, status and lines added and removed, and its own
 * lines. Pure, so it can be tested without a DOM.
 */
import { isTruncatedNote } from '../shared/diff';

/** One file's part of a diff. */
export interface DiffFile {
  /** Its path, as the diff names it (after the folder's name when the diff spans several working directories). */
  path: string;
  /** A = added, M = modified (its mode or type only, too), D = deleted. */
  status: 'A' | 'M' | 'D';
  /** Lines added and removed; null for a binary file. */
  added: number | null;
  deleted: number | null;
  /** Its lines after its `diff --git` line: the header (modes, index, `---`/`+++`) and the hunks. */
  lines: string[];
  /** Where the server cut the diff short: its lines stop there, and its counts are those shown. */
  truncated?: boolean;
}

export interface ParsedDiff {
  /** Lines before the first file (git writes none; kept so that nothing is lost). */
  lead: string[];
  files: DiffFile[];
  /** What the server added to the diff, apart from any file: that it was cut short. */
  notes: string[];
}

const FILE_HEADER = 'diff --git ';

export function parseDiff(text: string): ParsedDiff {
  const lead: string[] = [];
  const files: DiffFile[] = [];
  const notes: string[] = [];
  // Each file's `diff --git` line after its prefix, for a path it does not tell otherwise.
  const headers = new Map<DiffFile, string>();
  // Files whose type changed (a file that became a link): git writes them as one deleted and one added.
  const typeChanged = new Set<DiffFile>();
  let file: DiffFile | null = null;
  // Past the file's first hunk header: from there on, `+` and `-` start added and removed lines, not
  // the `---`/`+++` header (a removed line that starts with `--` reads as `---`).
  let inHunks = false;
  for (const line of text.split('\n')) {
    if (line.startsWith(FILE_HEADER)) {
      const rest = line.slice(FILE_HEADER.length);
      const path = headerPath(rest);
      inHunks = false;
      if (file && path && file.path === path) {
        // The same path again (with renames off, only a change of type does that): one file, both parts.
        typeChanged.add(file);
        file.lines.push(line);
        continue;
      }
      file = { path, status: 'M', added: 0, deleted: 0, lines: [] };
      headers.set(file, rest);
      files.push(file);
      continue;
    }
    if (isTruncatedNote(line)) {
      notes.push(line);
      if (file) file.truncated = true;
      continue;
    }
    if (!file) {
      lead.push(line);
      continue;
    }
    file.lines.push(line);
    if (inHunks) {
      if (line.startsWith('+')) file.added = (file.added ?? 0) + 1;
      else if (line.startsWith('-')) file.deleted = (file.deleted ?? 0) + 1;
    } else if (line.startsWith('@@')) inHunks = true;
    else if (line.startsWith('new file mode')) file.status = 'A';
    else if (line.startsWith('deleted file mode')) file.status = 'D';
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.added = null;
      file.deleted = null;
    } else if (
      !file.path &&
      (line.startsWith('--- a/') || line.startsWith('+++ b/') || line.startsWith('--- "a/') || line.startsWith('+++ "b/'))
    ) {
      // A path the header line could not tell: the one on the side the file is on (git ends a name
      // with a space in a tab there).
      file.path = unquote(line.slice(4).replace(/\t$/, '')).slice(2);
    }
  }
  for (const f of files) {
    // The text's last newline, and the blank lines before the note of a diff cut short, belong to no file.
    while (f.lines.length && f.lines.at(-1) === '') f.lines.pop();
    if (typeChanged.has(f)) f.status = 'M';
    // A header line no path could be read from (cut short in its middle): shown as it is.
    if (!f.path) f.path = headers.get(f) ?? '';
  }
  while (lead.length && lead.at(-1) === '') lead.pop();
  return { lead, files, notes };
}

/**
 * The path in a file's `diff --git a/<path> b/<path>` line. With renames off (as the server asks
 * for) both sides name the same path, after a prefix of two characters (`a/` and `b/`, which the
 * server always asks for); a path with characters git quotes is quoted on both sides. Empty when
 * the line cannot be read so: the `---`/`+++` lines then tell it.
 */
function headerPath(rest: string): string {
  let a: string;
  let b: string;
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest);
    if (end < 0 || rest[end] !== ' ') return '';
    a = unquote(rest.slice(0, end));
    b = unquote(rest.slice(end + 1));
  } else {
    // Two halves of the same length around one space (a path may hold spaces itself).
    const half = (rest.length - 1) / 2;
    if (!Number.isInteger(half) || rest[half] !== ' ') return '';
    a = rest.slice(0, half);
    b = rest.slice(half + 1);
  }
  if (a === b) return a;
  return a[1] === '/' && b[1] === '/' && a.slice(2) === b.slice(2) ? a.slice(2) : '';
}

/** Where the C-style quoted string at the start of `s` ends (just past its closing quote), or -1. */
function quotedEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i + 1;
  }
  return -1;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path as git writes it: as it is, or C-style quoted, with the bytes it escapes as octal (UTF-8). */
function unquote(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      // One character, a surrogate pair (an emoji) as one.
      const char = String.fromCodePoint(body.codePointAt(i)!);
      bytes.push(...encoder.encode(char));
      i += char.length - 1;
      continue;
    }
    const next = body[i + 1] ?? '';
    const octal = /^[0-7]{3}$/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else if (next in ESCAPES) {
      bytes.push(ESCAPES[next]!);
      i += 1;
    } else bytes.push(92);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Lines added and removed in all the files (binary files count none). */
export function diffTotals(files: DiffFile[]): { added: number; deleted: number } {
  return {
    added: files.reduce((n, f) => n + (f.added ?? 0), 0),
    deleted: files.reduce((n, f) => n + (f.deleted ?? 0), 0),
  };
}

/** The class of a diff line's colour: a hunk header, an added or removed line, or the file's header. */
export function diffLineClass(line: string, inHunks: boolean): string {
  if (line.startsWith('@@')) return 'd-hunk';
  if (!inHunks) return 'd-meta';
  if (line.startsWith('+')) return 'd-add';
  if (line.startsWith('-')) return 'd-del';
  if (line.startsWith('\\')) return 'd-meta';
  return '';
}
