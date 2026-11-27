import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffFiles, diffText, ensureRepo, setRepoStore, snapshot } from '../src/server/workspace';
import { isTruncatedNote, truncatedNote } from '../src/shared/diff';
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
    // A character of two UTF-16 units (an emoji) kept whole, and a folder of one letter kept.
    expect(paths('diff --git "a/😀\\"q.txt" "b/😀\\"q.txt"')).toEqual(['😀"q.txt']);
    expect(paths('diff --git "a/x/q\\"uote.txt" "b/x/q\\"uote.txt"')).toEqual(['x/q"uote.txt']);
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
    // An added file's side is its `+++` line (its `---` is /dev/null), without the tab git ends a name with a space in.
    const added = parseDiff('diff --git a/x c/y\nnew file mode 100644\n--- /dev/null\n+++ b/with space.txt\t\n@@ -0,0 +1 @@\n+a');
    expect(added.files.map(summary)).toEqual([{ path: 'with space.txt', status: 'A', added: 1, deleted: 0 }]);
    // A header line cut short in its middle, with nothing after it: shown as it is.
    expect(parseDiff('diff --git a/src/some/fi').files.map((f) => f.path)).toEqual(['a/src/some/fi']);
  });

  it('makes one file of a file whose type changed, which git writes as deleted and added', () => {
    const diff = parseDiff(
      [
        'diff --git a/link b/link',
        'deleted file mode 100644',
        'index 1111111..0000000',
        '--- a/link',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-one',
        '-two',
        'diff --git a/link b/link',
        'new file mode 120000',
        'index 0000000..2222222',
        '--- /dev/null',
        '+++ b/link',
        '@@ -0,0 +1 @@',
        '+target.txt',
        '\\ No newline at end of file',
        'diff --git a/next.txt b/next.txt',
        'new file mode 100644',
      ].join('\n'),
    );
    expect(diff.files.map(summary)).toEqual([
      { path: 'link', status: 'M', added: 1, deleted: 2 },
      { path: 'next.txt', status: 'A', added: 0, deleted: 0 },
    ]);
    // Both parts' lines, the second after its own `diff --git` line.
    expect(diff.files[0]!.lines).toContain('diff --git a/link b/link');
    expect(diff.files[0]!.lines.at(-1)).toBe('\\ No newline at end of file');
  });

  it('keeps the note of a diff cut short apart from the file it cut, which it marks', () => {
    const text = 'diff --git a/big.txt b/big.txt\nindex 1..2 100644\n--- a/big.txt\n+++ b/big.txt\n@@ -1,9 +1,9 @@\n+one\n+tw';
    const diff = parseDiff(`${text}\n\n${truncatedNote(2048)}\n`);
    expect(diff.notes).toEqual(['… diff truncated (2048 KB total)']);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]!.lines.at(-1)).toBe('+tw');
    expect(diff.files[0]!.added).toBe(2);
    expect(diff.files[0]!.truncated).toBe(true);
  });

  it("marks the file a diff was cut in, also when another folder's diff follows it", () => {
    const first = 'diff --git a/one/a.txt b/one/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/one/a.txt\n@@ -0,0 +1 @@\n+a\n';
    const cut = 'diff --git a/one/b.txt b/one/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/one/b.txt\n@@ -0,0 +1,900 @@\n+b\n+b';
    const second = 'diff --git a/two/c.txt b/two/c.txt\nnew file mode 100644\n--- /dev/null\n+++ b/two/c.txt\n@@ -0,0 +1 @@\n+c\n';
    const diff = parseDiff(`${first}${cut}\n\n${truncatedNote(1500)}\n${second}`);
    expect(diff.files.map((f) => [f.path, f.added, Boolean(f.truncated)])).toEqual([
      ['one/a.txt', 1, false],
      ['one/b.txt', 2, true],
      ['two/c.txt', 1, false],
    ]);
    expect(diff.notes).toEqual([truncatedNote(1500)]);
    // The server's words and the client's test of them are the same (`src/shared/diff.ts`).
    expect(isTruncatedNote(truncatedNote(0))).toBe(true);
    expect(isTruncatedNote(`+${truncatedNote(1)}`)).toBe(false);
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
  let saved: string | undefined;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-diff-')));
    // Harness Relay's own repositories (the snapshots), the test's own.
    setRepoStore(join(dir, 'repos'));
    saved = process.env.GIT_CONFIG_GLOBAL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  /** A repository with one turn's changes of each kind; its two commits. */
  async function changes(): Promise<{ repo: string; base: string; head: string; posix: boolean }> {
    const repo = join(dir, 'repo');
    const posix = process.platform !== 'win32';
    // Names git quotes (and Windows does not allow) only where they can be made, in a folder of one letter.
    const odd = posix ? ['quote"d.txt', 'tab\there.txt', 'back\\slash.txt', 'line\nbreak.txt'] : [];
    mkdirSync(join(repo, 'x'), { recursive: true });
    writeFileSync(join(repo, 'kept.md'), '--- a rule\nsame\n');
    writeFileSync(join(repo, 'gone.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'run.sh'), 'echo hi\n');
    writeFileSync(join(repo, 'became-link'), 'a file\n');
    await ensureRepo(repo);
    const base = (await snapshot(repo)).commit;
    writeFileSync(join(repo, 'kept.md'), '+++ a heading\nsame\nmore\n');
    unlinkSync(join(repo, 'gone.txt'));
    writeFileSync(join(repo, 'with space.txt'), 'a\n');
    writeFileSync(join(repo, '中文.md'), '你好\n');
    writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
    for (const name of odd) writeFileSync(join(repo, 'x', name), 'odd\n');
    if (posix) {
      chmodSync(join(repo, 'run.sh'), 0o755);
      unlinkSync(join(repo, 'became-link'));
      symlinkSync('kept.md', join(repo, 'became-link'));
    }
    const head = (await snapshot(repo)).commit;
    return { repo, base, head, posix };
  }

  it("finds the files the changes card lists, as the server's diff names them, also after a folder", async () => {
    const { repo, base, head, posix } = await changes();
    const card = await diffFiles(repo, base, head);
    // Modified, deleted, three added; on macOS and Linux four odd names, a mode and a type changed too.
    expect(card.length).toBe(posix ? 11 : 5);
    expect(parseDiff(await diffText(repo, base, head)).files.map(summary)).toEqual(card);
    const inFolder = parseDiff(await diffText(repo, base, head, 'project'));
    expect(inFolder.files.map(summary)).toEqual(card.map((f) => ({ ...f, path: `project/${f.path}` })));
  });

  // Prefixes of the user's own (`diff.srcPrefix` from git 2.45; an older git ignores it): the server asks for git's.
  it.each([
    ['diff.noprefix', '[diff]\n\tnoprefix = true\n'],
    ['diff.srcPrefix and diff.dstPrefix', '[diff]\n\tsrcPrefix = old/\n\tdstPrefix = new/\n'],
    ['diff.mnemonicPrefix', '[diff]\n\tmnemonicPrefix = true\n'],
  ])("reads the same paths whatever the user's git config says: %s", async (_name, config) => {
    const { repo, base, head } = await changes();
    const card = await diffFiles(repo, base, head);
    writeFileSync(join(dir, 'gitconfig'), config);
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
    expect(parseDiff(await diffText(repo, base, head)).files.map(summary)).toEqual(card);
    expect(parseDiff(await diffText(repo, base, head, 'p')).files.map(summary)).toEqual(card.map((f) => ({ ...f, path: `p/${f.path}` })));
  });
});
