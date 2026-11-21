import { chmodSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffFiles, diffText, ensureRepo, snapshot } from '../src/server/workspace';
import { diffLineClass, diffTotals, parseDiff, type DiffFile } from '../src/web/diff';

/** A file's summary, as the changes card has it (`FileChange`). */
const summary = (f: DiffFile) => ({ path: f.path, status: f.status, added: f.added, deleted: f.deleted });

describe('parseDiff', () => {
  it('splits a diff into its files, each with its status, counts and own lines', () => {
    const text = [
      'diff --git a/README.md b/README.md',
      'new file mode 100644',
      'index 0000000..e08f5c3',
      '--- /dev/null',
      '+++ b/README.md',
      '@@ -0,0 +1,2 @@',
      '+# Todo App',
      '+',
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const x = 1;',
      '+const x = 2;',
      ' const b = 2;',
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      'index 3333333..0000000',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      '',
    ].join('\n');
    const diff = parseDiff(text);
    expect(diff.lead).toEqual([]);
    expect(diff.notes).toEqual([]);
    expect(diff.files.map(summary)).toEqual([
      { path: 'README.md', status: 'A', added: 2, deleted: 0 },
      { path: 'src/app.ts', status: 'M', added: 1, deleted: 1 },
      { path: 'old.txt', status: 'D', added: 0, deleted: 2 },
    ]);
    // A file's lines start after its `diff --git` line, and the text's last newline is no line of its own.
    expect(diff.files[0]!.lines).toEqual([
      'new file mode 100644',
      'index 0000000..e08f5c3',
      '--- /dev/null',
      '+++ b/README.md',
      '@@ -0,0 +1,2 @@',
      '+# Todo App',
      '+',
    ]);
    expect(diff.files[2]!.lines.at(-1)).toBe('-two');
    expect(diffTotals(diff.files)).toEqual({ added: 3, deleted: 3 });
  });

  it('counts a hunk line that starts like the header (`---`, `+++`) as removed or added', () => {
    const diff = parseDiff(
      [
        'diff --git a/notes.md b/notes.md',
        'index 1111111..2222222 100644',
        '--- a/notes.md',
        '+++ b/notes.md',
        '@@ -1,2 +1,2 @@',
        '--- a rule',
        '+++ a heading',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    expect(diff.files.map(summary)).toEqual([{ path: 'notes.md', status: 'M', added: 1, deleted: 1 }]);
  });

  it('tells a binary file (no counts) and a change of mode only (none)', () => {
    const diff = parseDiff(
      [
        'diff --git a/logo.png b/logo.png',
        'new file mode 100644',
        'index 0000000..1234567',
        'Binary files /dev/null and b/logo.png differ',
        'diff --git a/run.sh b/run.sh',
        'old mode 100644',
        'new mode 100755',
      ].join('\n'),
    );
    expect(diff.files.map(summary)).toEqual([
      { path: 'logo.png', status: 'A', added: null, deleted: null },
      { path: 'run.sh', status: 'M', added: 0, deleted: 0 },
    ]);
    expect(diffTotals(diff.files)).toEqual({ added: 0, deleted: 0 });
  });

  it("reads each file's path: with spaces, quoted, after a folder, or without git's prefixes", () => {
    const paths = (header: string) => parseDiff(`${header}\nindex 1..2 100644\n`).files.map((f) => f.path);
    expect(paths('diff --git a/my notes/a b.txt b/my notes/a b.txt')).toEqual(['my notes/a b.txt']);
    // A path that holds " b/" itself.
    expect(paths('diff --git a/x b/y.txt b/x b/y.txt')).toEqual(['x b/y.txt']);
    expect(paths('diff --git a/project/src/a.ts b/project/src/a.ts')).toEqual(['project/src/a.ts']);
    expect(paths('diff --git src/a.ts src/a.ts')).toEqual(['src/a.ts']);
    expect(paths('diff --git a/中文.md b/中文.md')).toEqual(['中文.md']);
    // Quoted: escapes, and bytes as octal (UTF-8).
    expect(paths('diff --git "a/tab\\there \\"q\\"\\\\.txt" "b/tab\\there \\"q\\"\\\\.txt"')).toEqual(['tab\there "q"\\.txt']);
    expect(paths('diff --git "a/\\344\\270\\255\\n.md" "b/\\344\\270\\255\\n.md"')).toEqual(['中\n.md']);
  });

  it("takes a path the header line cannot tell from the file's `---` or `+++` line", () => {
    const diff = parseDiff(
      [
        'diff --git a/one.txt b/two.txt',
        'index 1..2 100644',
        '--- a/one.txt',
        '+++ b/one.txt',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/x.txt c/y.txt',
        'deleted file mode 100644',
        '--- a/gone.txt',
        '+++ /dev/null',
      ].join('\n'),
    );
    expect(diff.files.map((f) => f.path)).toEqual(['one.txt', 'gone.txt']);
  });

  it('keeps the note of a diff cut short apart from the file it cut', () => {
    const text = 'diff --git a/big.txt b/big.txt\nindex 1..2 100644\n--- a/big.txt\n+++ b/big.txt\n@@ -1,9 +1,9 @@\n+one\n+tw';
    const diff = parseDiff(`${text}\n\n… diff truncated (2048 KB total)\n`);
    expect(diff.notes).toEqual(['… diff truncated (2048 KB total)']);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]!.lines.at(-1)).toBe('+tw');
    expect(diff.files[0]!.added).toBe(2);
  });

  it('keeps text that is not a file of a diff as lead lines', () => {
    expect(parseDiff('')).toEqual({ lead: [], files: [], notes: [] });
    expect(parseDiff('something else\n')).toEqual({ lead: ['something else'], files: [], notes: [] });
  });
});

describe('diffLineClass', () => {
  it("colours a file's header, hunk headers, and added and removed lines", () => {
    expect(diffLineClass('index 1..2 100644', false)).toBe('d-meta');
    expect(diffLineClass('--- a/x', false)).toBe('d-meta');
    expect(diffLineClass('+++ b/x', false)).toBe('d-meta');
    expect(diffLineClass('@@ -1 +1 @@', false)).toBe('d-hunk');
    expect(diffLineClass('--- a rule', true)).toBe('d-del');
    expect(diffLineClass('+added', true)).toBe('d-add');
    expect(diffLineClass(' same', true)).toBe('');
    expect(diffLineClass('\\ No newline at end of file', true)).toBe('d-meta');
  });
});

describe('parseDiff on git', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-diff-')));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the files the changes card lists, as the server's diff names them, also after a folder", async () => {
    const posix = process.platform !== 'win32';
    // Names git quotes (and Windows does not allow) only where they can be made.
    const odd = posix ? ['quote"d.txt', 'tab\there.txt', 'back\\slash.txt', 'line\nbreak.txt'] : [];
    writeFileSync(join(dir, 'kept.md'), '--- a rule\nsame\n');
    writeFileSync(join(dir, 'gone.txt'), 'one\ntwo\n');
    writeFileSync(join(dir, 'run.sh'), 'echo hi\n');
    await ensureRepo(dir);
    const base = (await snapshot(dir)).commit;
    writeFileSync(join(dir, 'kept.md'), '+++ a heading\nsame\nmore\n');
    unlinkSync(join(dir, 'gone.txt'));
    writeFileSync(join(dir, 'with space.txt'), 'a\n');
    writeFileSync(join(dir, '中文.md'), '你好\n');
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
    for (const name of odd) writeFileSync(join(dir, name), 'odd\n');
    if (posix) chmodSync(join(dir, 'run.sh'), 0o755);
    const head = (await snapshot(dir)).commit;

    const card = await diffFiles(dir, base, head);
    expect(card.length).toBe(5 + odd.length + (posix ? 1 : 0));
    expect(parseDiff(await diffText(dir, base, head)).files.map(summary)).toEqual(card);
    const inFolder = parseDiff(await diffText(dir, base, head, 'project'));
    expect(inFolder.files.map(summary)).toEqual(card.map((f) => ({ ...f, path: `project/${f.path}` })));
  });
});
