import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addCheckTree,
  applyPatch,
  applyPatchIn,
  applyToWorkingTree,
  changedPaths,
  checkPatch,
  commitWorktree,
  committedBase,
  commitsSince,
  createWorktree,
  diffFiles,
  diffText,
  dropKeptCommits,
  ensureRepo,
  excludePathspecs,
  fileAt,
  forgetCommits,
  keepCommits,
  parseDiffFiles,
  removeWorktree,
  repoDriverGuards,
  repoGitState,
  repoRoot,
  repoStore,
  setLazyFetchGuard,
  setRepoStore,
  setTidyLimits,
  snapshot,
  treePaths,
  unignoredFiles,
  worktreeChanged,
  worktreeCwd,
  worktreeHead,
} from '../src/server/workspace';
import { withLang } from '../src/server/i18n';
import { recordSpawns } from '../src/server/process';
import { slow } from './timeouts';
import { fileURLToPath } from 'node:url';

/** The repository Harness Relay is (its source, for a script run in a process of its own). */
const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

let dir: string;
let repo: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-ws-')));
  repo = join(dir, 'project');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 1;\n');
  // Harness Relay's own repositories, as its data folder's `repos` would hold them: the test's own.
  setRepoStore(join(dir, 'repos'));
});

afterEach(() => {
  setRepoStore();
  rmSync(dir, { recursive: true, force: true });
});

/** A commit's parents in Harness Relay's own repository for `root`, read from the commit itself (a snapshot's is the working repository's HEAD, which that repository does not hold). */
const parentsOf = (root: string, commit: string) =>
  inStore(root, 'cat-file', '-p', commit)
    .split('\n')
    .filter((l) => l.startsWith('parent '))
    .map((l) => l.slice(7));

/** Git on Harness Relay's own repository for `root` (its snapshots, refs and worktrees). */
const inStore = (root: string, ...args: string[]) =>
  execFileSync('git', ['--git-dir', repoStore(root), ...args], { encoding: 'utf8' }).trim();

describe('ensureRepo', () => {
  it('runs git init in a plain directory, once', async () => {
    expect(await ensureRepo(repo)).toEqual({ root: repo, created: true });
    expect(existsSync(join(repo, '.git'))).toBe(true);
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('node_modules/');
    expect(await ensureRepo(join(repo, 'src'))).toEqual({ root: repo, created: false });
  });

  it('refuses to turn the home directory into a repository', async () => {
    await expect(ensureRepo(homedir())).rejects.toThrow(/git repository/);
  });

  it('refuses a repository rooted at the home directory (dotfiles), which every turn would snapshot', async () => {
    const home = join(dir, 'home');
    mkdirSync(join(home, 'code'), { recursive: true });
    git(home, 'init', '-q');
    // The home directory as os.homedir() finds it: HOME, or USERPROFILE on Windows.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    Object.assign(process.env, { HOME: home, USERPROFILE: home });
    try {
      await expect(ensureRepo(join(home, 'code'))).rejects.toThrow(/範圍太大/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('snapshot', () => {
  it("takes HEAD's commit as its parent, and none in a repository without a commit", async () => {
    await ensureRepo(repo);
    const first = await snapshot(repo);
    expect(parentsOf(repo, first.commit)).toEqual([]);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first');
    const head = git(repo, 'rev-parse', 'HEAD');
    const second = await snapshot(repo);
    expect(parentsOf(repo, second.commit)).toEqual([head]);
  });

  it('captures tracked and untracked files without touching HEAD, index or files', async () => {
    await ensureRepo(repo);
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'ignored');
    const statusBefore = git(repo, 'status', '--porcelain');

    const snap = await snapshot(repo);
    const files = inStore(repo, 'ls-tree', '-r', '--name-only', snap.commit).split('\n');
    expect(files.sort()).toEqual(['README.md', 'src/app.ts']);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
    expect(() => git(repo, 'rev-parse', '--verify', '-q', 'HEAD')).toThrow(); // still no commits

    // Same content → same tree; a change → a different tree.
    expect((await snapshot(repo)).tree).toBe(snap.tree);
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    expect((await snapshot(repo)).tree).not.toBe(snap.tree);
  });

  it("leaves out the CLIs' own homes when they lie in the repository, also through a link", async () => {
    await ensureRepo(repo);
    // The CLIs' folder inside the repository (beside the working directory `src`), with a sign-in in it.
    mkdirSync(join(repo, 'agents', 'codex'), { recursive: true });
    writeFileSync(join(repo, 'agents', 'codex', 'auth.json'), '{"token":"secret"}');
    mkdirSync(join(repo, 'agents-notes'));
    writeFileSync(join(repo, 'agents-notes', 'keep.md'), 'not the folder\n');
    const files = async (exclude: string[]) =>
      inStore(repo, 'ls-tree', '-r', '--name-only', (await snapshot(repo, exclude)).commit)
        .split('\n')
        .sort();

    expect(await files([])).toContain('agents/codex/auth.json');
    expect(await files([join(repo, 'agents')])).toEqual(['README.md', 'agents-notes/keep.md', 'src/app.ts']);
    // Named through a link, it is still found inside the repository.
    symlinkSync(join(repo, 'agents'), join(dir, 'agents-link'));
    expect(await files([join(dir, 'agents-link')])).toEqual(['README.md', 'agents-notes/keep.md', 'src/app.ts']);
    // Outside the repository it needs nothing.
    expect(excludePathspecs(repo, [join(dir, 'elsewhere'), dir, ''])).toEqual([]);
    expect(excludePathspecs(repo, [join(repo, 'agents', 'codex')])).toEqual([':(exclude,literal)agents/codex']);
  });
});

describe('worktrees', () => {
  it('isolates an agent, records its changes, and applies them back', async () => {
    await ensureRepo(repo);
    const base = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt', 'builder');
    await createWorktree(repo, wt, 'relay/test/Builder', base);
    expect(worktreeCwd(repo, join(repo, 'src'), wt)).toBe(join(wt, 'src'));

    writeFileSync(join(wt, 'src', 'app.ts'), 'export const x = 2;\n');
    writeFileSync(join(wt, 'NEW.md'), 'new\n');
    const head = await commitWorktree(repo, wt, 'relay/test/Builder', 'turn');
    expect(head).toBeTruthy();
    expect(await commitWorktree(repo, wt, 'relay/test/Builder', 'nothing')).toBeNull();

    expect(await diffFiles(repo, base, head!)).toEqual([
      { path: 'NEW.md', status: 'A', added: 1, deleted: 0 },
      { path: 'src/app.ts', status: 'M', added: 1, deleted: 1 },
    ]);
    // The real working directory is untouched until applied.
    expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const x = 1;\n');

    await applyToWorkingTree(repo, base, head!);
    expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8')).toBe('export const x = 2;\n');
    expect(readFileSync(join(repo, 'NEW.md'), 'utf8')).toBe('new\n');

    await removeWorktree(repo, wt, 'relay/test/Builder');
    expect(existsSync(wt)).toBe(false);
    expect(inStore(repo, 'branch', '--list', 'relay/*')).toBe('');
  });

  it("checks a patch without changing anything, then applies it; and names a diff's paths after a folder", async () => {
    await ensureRepo(repo);
    const base = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt', 'c');
    await createWorktree(repo, wt, 'relay/test/C', base);
    writeFileSync(join(wt, 'NEW.md'), 'new\n');
    const head = (await commitWorktree(repo, wt, 'relay/test/C', 'turn'))!;
    const checked = (await checkPatch(repo, base, head))!;
    expect(checked.files.map((f) => f.path)).toEqual(['NEW.md']);
    expect(existsSync(join(repo, 'NEW.md'))).toBe(false);
    await applyPatch(checked);
    expect(readFileSync(join(repo, 'NEW.md'), 'utf8')).toBe('new\n');
    // Nothing between two commits: nothing to check.
    expect(await checkPatch(repo, head, head)).toBeNull();
    const diff = await diffText(repo, base, head, 'docs');
    expect(diff).toContain('diff --git a/docs/NEW.md b/docs/NEW.md');
    expect(diff).toContain('+++ b/docs/NEW.md');
    expect(await diffText(repo, base, head)).toContain('+++ b/NEW.md');
  });

  it('refuses to apply over conflicting edits and changes nothing', async () => {
    await ensureRepo(repo);
    const base = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt', 'a');
    await createWorktree(repo, wt, 'relay/test/A', base);
    writeFileSync(join(wt, 'README.md'), 'from agent\n');
    writeFileSync(join(wt, 'OTHER.md'), 'other\n');
    const head = (await commitWorktree(repo, wt, 'relay/test/A', 'turn'))!;

    writeFileSync(join(repo, 'README.md'), 'edited by the user\n');
    await expect(applyToWorkingTree(repo, base, head)).rejects.toThrow(/衝突/);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('edited by the user\n');
    expect(existsSync(join(repo, 'OTHER.md'))).toBe(false);
  });
});

describe('changes that are not plain UTF-8 text with LF line endings', () => {
  /** Run one agent turn in a worktree that writes `files`, then apply the result to the repository. */
  async function applyTurn(files: Record<string, Buffer>) {
    const base = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt', 'agent');
    await createWorktree(repo, wt, 'relay/test/agent', base);
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(wt, name), bytes);
    const head = (await commitWorktree(repo, wt, 'relay/test/agent', 'turn'))!;
    await applyToWorkingTree(repo, base, head);
    return { base, head };
  }

  it('applies non-UTF-8, CRLF and lone-CR content byte for byte', async () => {
    await ensureRepo(repo);
    const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5, 0x0a]); // 「中文」 in Big5
    const crlf = Buffer.from('a\r\nb\r\n');
    const cr = Buffer.from('a\rb\n');
    await applyTurn({ 'big5.txt': big5, 'crlf.txt': crlf, 'cr.txt': cr });
    expect(readFileSync(join(repo, 'big5.txt'))).toEqual(big5);
    expect(readFileSync(join(repo, 'crlf.txt'))).toEqual(crlf);
    expect(readFileSync(join(repo, 'cr.txt'))).toEqual(cr);
  });

  it('applies a change to an existing CRLF file instead of reporting a conflict', async () => {
    writeFileSync(join(repo, 'win.txt'), 'one\r\ntwo\r\n');
    await ensureRepo(repo);
    await applyTurn({ 'win.txt': Buffer.from('one\r\nTWO\r\n') });
    expect(readFileSync(join(repo, 'win.txt'), 'utf8')).toBe('one\r\nTWO\r\n');
  });

  it('shows CRLF content unchanged in the diff viewer', async () => {
    await ensureRepo(repo);
    const { base, head } = await applyTurn({ 'crlf.txt': Buffer.from('a\r\nb\r\n') });
    expect(await diffText(repo, base, head)).toContain('+a\r\n+b\r\n');
  });

  it("keeps the bytes as they are when the user's git converts line endings (Git for Windows' default)", async () => {
    // Git for Windows sets core.autocrlf=true in its system config; this sets it above any config file.
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true' });
    try {
      writeFileSync(join(repo, 'win.txt'), 'one\r\ntwo\r\n');
      await ensureRepo(repo);
      const lf = Buffer.from('new\n');
      const crlf = Buffer.from('a\r\nb\r\n');
      const { base, head } = await applyTurn({ 'lf.txt': lf, 'crlf.txt': crlf, 'win.txt': Buffer.from('one\r\nTWO\r\n') });
      expect(readFileSync(join(repo, 'lf.txt'))).toEqual(lf);
      expect(readFileSync(join(repo, 'crlf.txt'))).toEqual(crlf);
      expect(readFileSync(join(repo, 'win.txt'), 'utf8')).toBe('one\r\nTWO\r\n');
      expect(await diffText(repo, base, head)).toContain('+a\r\n+b\r\n');
    } finally {
      for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('diffFiles', () => {
  it(
    'lists every changed file, however long the list',
    async () => {
      await ensureRepo(repo);
      const base = (await snapshot(repo)).commit;
      // Well over 64 KB of `git diff --name-status` output, from long names rather than many files (each
      // one written and committed takes a while on Windows), but short enough for its 260-character paths.
      const dirName = 'a-rather-long-directory-name-for-generated-files';
      const name = (i: number) => `a-generated-file-whose-long-name-makes-the-list-long-with-fewer-files-${i}.txt`;
      mkdirSync(join(repo, dirName));
      for (let i = 0; i < 1000; i++) writeFileSync(join(repo, dirName, name(i)), `${i}\n`);
      const head = (await snapshot(repo)).commit;
      const files = await diffFiles(repo, base, head);
      expect(files).toHaveLength(1000);
      expect(files.every((f) => f.status === 'A' && f.added === 1 && f.deleted === 0)).toBe(true);
      // "A\0<path>\0" each: about 125 KB.
      expect(files.reduce((bytes, f) => bytes + Buffer.byteLength(f.path) + 3, 0)).toBeGreaterThan(64 * 1024);
    },
    slow(30_000),
  );

  it('gives each file its status and line counts from one diff: added, changed, deleted, binary, a name starting with a colon', async () => {
    await ensureRepo(repo);
    // Windows takes no colon in a file name (it names a stream of the file there).
    const colon = process.platform === 'win32' ? '' : ':';
    writeFileSync(join(repo, 'gone.txt'), 'x\n');
    writeFileSync(join(repo, `${colon}odd.txt`), 'a\n');
    const base = (await snapshot(repo)).commit;
    rmSync(join(repo, 'gone.txt'));
    writeFileSync(join(repo, `${colon}odd.txt`), 'a\nb\nc\n');
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repo, `${colon}new.txt`), 'n\n');
    const head = (await snapshot(repo)).commit;
    const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    expect([...(await diffFiles(repo, base, head))].sort(byPath)).toEqual(
      [
        { path: `${colon}new.txt`, status: 'A', added: 1, deleted: 0 },
        { path: `${colon}odd.txt`, status: 'M', added: 2, deleted: 0 },
        { path: 'bin.dat', status: 'A', added: null, deleted: null },
        { path: 'gone.txt', status: 'D', added: 0, deleted: 1 },
      ].sort(byPath),
    );
  });

  it('reads the raw entries before the counts, whatever a path holds', () => {
    const out = [
      ':000000 100644 0000000 1111111 A',
      ':x',
      ':100644 100644 2222222 3333333 M',
      'tab\tand\nline',
      '-\t-\t:x',
      '3\t1\ttab\tand\nline',
      '',
    ].join('\0');
    expect(parseDiffFiles(out)).toEqual([
      { path: ':x', status: 'A', added: null, deleted: null },
      { path: 'tab\tand\nline', status: 'M', added: 3, deleted: 1 },
    ]);
    expect(parseDiffFiles('')).toEqual([]);
  });

  it('keeps file names with quotes, tabs, backslashes and non-ASCII characters as they are', async () => {
    await ensureRepo(repo);
    const base = (await snapshot(repo)).commit;
    // Windows takes no double quote, tab or backslash in a file name.
    const names =
      process.platform === 'win32'
        ? ["it's (1) & co.txt", '中文 檔名.md']
        : ['say "hi".txt', 'tab\there.txt', 'back\\slash.txt', '中文 檔名.md'];
    for (const name of names) writeFileSync(join(repo, name), 'x\n');
    const head = (await snapshot(repo)).commit;
    const files = await diffFiles(repo, base, head);
    expect(files.map((f) => f.path).sort()).toEqual([...names].sort());
    expect(files.every((f) => f.added === 1)).toBe(true);
  });
});

describe("Harness Relay's own repository, and the working repository's .git it never writes", () => {
  /** Git on Harness Relay's own repository for `repo`. */
  const store = (...args: string[]) => git(dir, '--git-dir', repoStore(repo), ...args);
  /** A link to a folder (a junction on Windows, which needs no rights there). */
  const dirLink = (target: string, path: string) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  /** A file git made (Git for Windows hides a worktree's `.git` file, which cannot be opened to be overwritten). */
  const rewrite = (path: string, text: string) => {
    rmSync(path, { force: true });
    writeFileSync(path, text);
  };
  /** Every entry under `folder` as it is (a file's bytes and mode, a link's target), no link followed. */
  const state = (folder: string): string[] => {
    const out: string[] = [];
    const walk = (path: string, rel: string) => {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(path)}`);
      else if (st.isDirectory()) {
        // Its time too: a file made and taken away there (a temporary one) changes it.
        out.push(`${rel}/ ${st.mtimeMs}`);
        for (const name of readdirSync(path).sort()) walk(join(path, name), `${rel}/${name}`);
      } else out.push(`${rel} ${st.mode} ${st.mtimeMs} ${createHash('sha1').update(readFileSync(path)).digest('hex')}`);
    };
    walk(folder, '.');
    return out;
  };
  /** The working repository with a commit (its files' objects in its own .git). */
  const committed = async () => {
    await ensureRepo(repo);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    return git(repo, 'rev-parse', 'HEAD');
  };
  /** Each of Harness Relay's git operations on `repo` once, as a run of parallel mode, a team check and an apply use them. */
  const everything = async () => {
    const first = await snapshot(repo);
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    const second = await snapshot(repo);
    await keepCommits(repo, 'conv-1', [first.commit, second.commit]);
    await forgetCommits(repo, 'conv-1', [first.commit]);
    await diffFiles(repo, first.commit, second.commit);
    await diffText(repo, first.commit, second.commit);
    await fileAt(repo, second.commit, 'README.md');
    await treePaths(repo, second.commit);
    await changedPaths(repo, first.commit, second.commit, ['README.md']);
    const base = await committedBase(repo);
    const wt = join(dir, 'wt');
    await createWorktree(repo, wt, 'relay/test', second.commit);
    writeFileSync(join(wt, 'by-agent.md'), 'by the agent\n');
    expect(await worktreeChanged(repo, wt, 'relay/test', second.commit)).toBe(true);
    const head = (await commitWorktree(repo, wt, 'relay/test', 'Harness Relay'))!;
    expect(await worktreeHead(repo, 'relay/test')).toBe(head);
    expect(await worktreeChanged(repo, wt, 'relay/test', second.commit)).toBe(true);
    const checkTree = join(dir, 'check');
    await addCheckTree(repo, checkTree, second.commit);
    const patch = (await checkPatch(repo, second.commit, head))!;
    await applyPatchIn(checkTree, patch);
    await removeWorktree(repo, checkTree);
    await applyPatch(patch);
    expect(readFileSync(join(repo, 'by-agent.md'), 'utf8')).toBe('by the agent\n');
    await removeWorktree(repo, wt, 'relay/test');
    await dropKeptCommits(repo, 'conv-1');
    return { base };
  };

  it("keeps its snapshots, their objects, refs and worktrees' results in a repository of its own", async () => {
    const userCommit = await committed();
    const snap = await snapshot(repo);
    expect(repoStore(repo).startsWith(join(dir, 'repos') + sep)).toBe(true);
    // Every object of the snapshot is its own (no alternate: git looks at no object of the working repository's).
    expect(existsSync(join(repoStore(repo), 'objects', 'info', 'alternates'))).toBe(false);
    expect(store('cat-file', '-t', snap.commit)).toBe('commit');
    expect(store('show', `${snap.commit}:README.md`)).toBe('hello');
    expect(store('ls-tree', '-r', '--name-only', snap.commit).split('\n').sort()).toEqual(['README.md', 'src/app.ts']);
    expect(() => git(repo, 'cat-file', '-t', snap.commit)).toThrow();
    // Its parent is the working repository's HEAD.
    expect(parentsOf(repo, snap.commit)).toEqual([userCommit]);
    await keepCommits(repo, 'conv-1', [snap.commit]);
    expect(store('for-each-ref', '--format=%(refname)', 'refs/harness-relay/')).toBe(`refs/harness-relay/conv-1/${snap.commit}`);
    expect(git(repo, 'for-each-ref', 'refs/harness-relay/')).toBe('');
    // A worktree is a repository of its own, reading the store's objects, clean at the snapshot; its
    // branch, where its results go, is the store's.
    const wt = join(dir, 'wt');
    await createWorktree(repo, wt, 'relay/test', snap.commit);
    expect(lstatSync(join(wt, '.git')).isDirectory()).toBe(true);
    expect(readFileSync(join(wt, '.git', 'objects', 'info', 'alternates'), 'utf8')).toBe(
      `${join(repoStore(repo), 'objects')}\n${realpathSync(join(repo, '.git', 'objects'))}\n`,
    );
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(snap.commit);
    expect(git(wt, 'symbolic-ref', 'HEAD')).toBe('refs/heads/relay/test');
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(wt, 'log', '--format=%H', '-n', '2')).toBe(`${snap.commit}\n${userCommit}`);
    expect(store('rev-parse', 'relay/test')).toBe(snap.commit);
    expect(git(repo, 'branch', '--list', 'relay/*')).toBe('');
    // A check tree too, detached.
    const check = join(dir, 'check');
    await addCheckTree(repo, check, snap.commit);
    expect(git(check, 'rev-parse', 'HEAD')).toBe(snap.commit);
    expect(() => git(check, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(git(check, 'status', '--porcelain')).toBe('');
    // A commit of the working repository it does not hold is not read there.
    writeFileSync(join(repo, 'README.md'), 'second\n');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'second');
    await expect(diffFiles(repo, userCommit, git(repo, 'rev-parse', 'HEAD'))).rejects.toThrow();
  });

  it(
    "writes nothing in the working repository's .git: snapshots, kept refs, worktrees and their commits, checks and applying",
    async () => {
      await committed();
      // A ref an older Harness Relay kept, copied in (and HEAD, for a fixed command's first Save).
      git(repo, 'update-ref', 'refs/harness-relay/conv-old/x', 'HEAD');
      const before = state(join(repo, '.git'));
      const { base } = await everything();
      expect(base).toBe(git(repo, 'rev-parse', 'HEAD'));
      expect(store('rev-parse', 'refs/harness-relay/conv-old/x')).toBe(git(repo, 'rev-parse', 'HEAD'));
      expect(state(join(repo, '.git'))).toEqual(before);
    },
    slow(30_000),
  );

  it(
    'writes nothing through a link an agent put in the .git, wherever it points',
    async () => {
      await committed();
      const gitDir = join(repo, '.git');
      const outside = ['refs', 'logs', 'objects'].map((name) => {
        const folder = join(dir, `outside-${name}`);
        mkdirSync(folder);
        return folder;
      });
      dirLink(outside[0]!, join(gitDir, 'refs', 'harness-relay'));
      mkdirSync(join(gitDir, 'logs', 'refs'), { recursive: true });
      dirLink(outside[1]!, join(gitDir, 'logs', 'refs', 'harness-relay'));
      dirLink(
        outside[2]!,
        join(
          gitDir,
          'objects',
          ['ff', 'fe', 'fd'].find((n) => !existsSync(join(gitDir, 'objects', n)))!,
        ),
      );
      const victim = join(dir, 'victim.txt');
      writeFileSync(victim, 'kept\n');
      for (const file of ['packed-refs', 'COMMIT_EDITMSG', 'index']) {
        rmSync(join(gitDir, file), { force: true });
        symlinkSync(victim, join(gitDir, file));
      }
      await everything();
      for (const folder of outside) expect(readdirSync(folder), folder).toEqual([]);
      expect(readFileSync(victim, 'utf8')).toBe('kept\n');
    },
    slow(30_000),
  );

  it(
    "records a worktree's files whatever an agent does in its own .git: links, its own commits, another repository named",
    async () => {
      const userCommit = await committed();
      const snap = (await snapshot(repo)).commit;
      const wt = join(dir, 'wt');
      await createWorktree(repo, wt, 'relay/test', snap);
      // The agent commits there, starts a branch, and leaves its git folder full of links.
      writeFileSync(join(wt, 'by-agent.md'), 'by the agent\n');
      git(wt, 'add', '-A');
      git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', "the agent's own");
      git(wt, 'checkout', '-q', '-b', 'elsewhere');
      writeFileSync(join(wt, 'later.md'), 'later\n');
      const own = join(wt, '.git');
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      const victim = join(dir, 'victim.txt');
      writeFileSync(victim, 'kept\n');
      for (const file of ['index', 'HEAD', 'packed-refs', 'COMMIT_EDITMSG']) {
        rmSync(join(own, file), { force: true });
        symlinkSync(victim, join(own, file));
      }
      rmSync(join(own, 'refs'), { recursive: true, force: true });
      dirLink(outside, join(own, 'refs'));
      const head = (await commitWorktree(repo, wt, 'relay/test', 'Harness Relay'))!;
      expect(parentsOf(repo, head)).toEqual([snap]);
      expect(store('ls-tree', '-r', '--name-only', head).split('\n').sort()).toEqual([
        'README.md',
        'by-agent.md',
        'later.md',
        'src/app.ts',
      ]);
      expect(await worktreeHead(repo, 'relay/test')).toBe(head);
      expect(await commitWorktree(repo, wt, 'relay/test', 'Harness Relay')).toBeNull();
      // Its .git replaced by a file naming another repository: nothing is written there either.
      const other = join(dir, 'other');
      mkdirSync(other);
      git(other, 'init', '-q');
      const otherBefore = state(join(other, '.git'));
      rmSync(own, { recursive: true, force: true });
      writeFileSync(own, `gitdir: ${join(other, '.git')}\n`);
      writeFileSync(join(wt, 'third.md'), 'third\n');
      const third = (await commitWorktree(repo, wt, 'relay/test', 'Harness Relay'))!;
      expect(parentsOf(repo, third)).toEqual([head]);
      await removeWorktree(repo, wt, 'relay/test');
      expect(state(join(other, '.git'))).toEqual(otherBefore);
      expect(readdirSync(outside)).toEqual([]);
      expect(readFileSync(victim, 'utf8')).toBe('kept\n');
      expect(existsSync(wt)).toBe(false);
      expect(() => store('rev-parse', '--verify', '-q', 'refs/heads/relay/test')).toThrow();
      expect(userCommit).toBe(git(repo, 'rev-parse', 'HEAD'));
    },
    slow(30_000),
  );

  it('records a worktree an older Harness Relay made (a git worktree of the working repository) on top of its branch there, writing nothing there', async () => {
    await committed();
    const legacy = join(dir, 'legacy');
    git(repo, '-c', 'core.autocrlf=false', 'worktree', 'add', '-q', '-b', 'relay/old', legacy);
    const old = git(repo, 'rev-parse', 'relay/old');
    const before = state(join(repo, '.git'));
    writeFileSync(join(legacy, 'by-agent.md'), 'x\n');
    expect(await worktreeHead(repo, 'relay/old')).toBe(old);
    expect(await worktreeChanged(repo, legacy, 'relay/old', old)).toBe(true);
    const head = (await commitWorktree(repo, legacy, 'relay/old', 'Harness Relay'))!;
    expect(parentsOf(repo, head)).toEqual([old]);
    expect(await worktreeHead(repo, 'relay/old')).toBe(head);
    expect(state(join(repo, '.git'))).toEqual(before);
    await expect(withLang('en', () => worktreeHead(repo, 'relay/none'))).rejects.toThrow(/The worktree's branch relay\/none is not there/);
  });

  it("lets an agent read a teammate's result by its commit, from its own worktree", async () => {
    await committed();
    const snap = (await snapshot(repo)).commit;
    const alice = join(dir, 'alice');
    const bob = join(dir, 'bob');
    await createWorktree(repo, alice, 'relay/c/Alice', snap);
    await createWorktree(repo, bob, 'relay/c/Bob', snap);
    writeFileSync(join(bob, 'bob.md'), 'from Bob\n');
    const head = (await commitWorktree(repo, bob, 'relay/c/Bob', 'Bob'))!;
    expect(git(alice, 'show', `${head}:bob.md`)).toBe('from Bob');
    expect(git(alice, 'diff', '--name-only', snap, head)).toBe('bob.md');
    // Its branch is Bob's alone.
    expect(() => git(alice, 'rev-parse', '--verify', '-q', 'relay/c/Bob')).toThrow();
  });

  it("writes every object itself: one an agent planted in the working repository's objects, or a link there, is never taken", async () => {
    await committed();
    await snapshot(repo);
    const content = 'the agent wrote this\n';
    writeFileSync(join(repo, 'new.txt'), content);
    const hash = execFileSync('git', ['hash-object', '--stdin'], { input: content, encoding: 'utf8' }).trim();
    // A link in its place to a file of the user's, which git would touch (freshen) and take as written.
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'kept\n');
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(victim, past, past);
    mkdirSync(join(repo, '.git', 'objects', hash.slice(0, 2)), { recursive: true });
    symlinkSync(victim, join(repo, '.git', 'objects', hash.slice(0, 2), hash.slice(2)));
    const snap = await snapshot(repo);
    expect(store('show', `${snap.commit}:new.txt`)).toBe(content.trim());
    expect(statSync(victim).mtime.getTime()).toBe(past.getTime());
    expect(readFileSync(victim, 'utf8')).toBe('kept\n');
  });

  it("takes nothing from the working repository's index: a file it claims unchanged is hashed again", async () => {
    await committed();
    git(repo, 'update-index', '--assume-unchanged', 'README.md');
    writeFileSync(join(repo, 'README.md'), 'changed behind the index\n');
    const snap = await snapshot(repo);
    expect(store('show', `${snap.commit}:README.md`)).toBe('changed behind the index');
  });

  it('starts its own index from HEAD: a tracked file an ignore rule matches stays in, and a rule changed rebuilds it', async () => {
    await ensureRepo(repo);
    writeFileSync(join(repo, '.gitignore'), 'build/\n');
    mkdirSync(join(repo, 'build'));
    writeFileSync(join(repo, 'build', 'kept.js'), 'tracked\n');
    writeFileSync(join(repo, 'build', 'out.js'), 'ignored\n');
    git(repo, 'add', '-A');
    git(repo, 'add', '-f', 'build/kept.js');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    const files = async () => store('ls-tree', '-r', '--name-only', (await snapshot(repo)).commit).split('\n');
    expect(await files()).toContain('build/kept.js');
    expect(await files()).not.toContain('build/out.js');
    // A file taken in, then ignored: gone once the rules change.
    writeFileSync(join(repo, 'notes.txt'), 'notes\n');
    expect(await files()).toContain('notes.txt');
    writeFileSync(join(repo, '.gitignore'), 'build/\nnotes.txt\n');
    expect(await files()).not.toContain('notes.txt');
    expect(readdirSync(join(repoStore(repo), 'relay-index')).filter((n) => n.startsWith('work-'))).toHaveLength(1);
  });

  it('copies once what an older Harness Relay kept in the working repository, every object checked, and nothing dropped since', async () => {
    await committed();
    const commit = (message: string) => {
      writeFileSync(join(repo, 'README.md'), `${message}\n`);
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', message);
      return git(repo, 'rev-parse', 'HEAD');
    };
    const [older, newer] = [commit('older'), commit('newer')];
    git(repo, 'update-ref', `refs/harness-relay/conv-old/${older}`, older);
    git(repo, 'update-ref', `refs/harness-relay/conv-old/${newer}`, newer);
    const before = state(join(repo, '.git'));
    // Its diffs and files read, and kept or dropped, from Harness Relay's repository.
    expect((await diffFiles(repo, older, newer)).map((f) => f.path)).toEqual(['README.md']);
    expect(await fileAt(repo, newer, 'README.md')).toBe('newer\n');
    expect(await treePaths(repo, newer)).toEqual(new Set(['README.md', 'src/app.ts']));
    await keepCommits(repo, 'conv-new', [older]);
    expect(state(join(repo, '.git'))).toEqual(before);
    await dropKeptCommits(repo, 'conv-old');
    // At the next start, the refs it dropped are not copied again.
    setRepoStore(join(dir, 'repos'));
    await snapshot(repo);
    expect(store('for-each-ref', '--format=%(refname)', 'refs/harness-relay/conv-old/')).toBe('');
  });

  it("refuses to copy an object an agent put in the working repository under another's name", async () => {
    await committed();
    writeFileSync(join(repo, 'README.md'), 'kept\n');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'kept');
    const kept = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', `refs/harness-relay/conv-old/${kept}`, kept);
    // Its README's object replaced by another object's file (the other README's): git reads it as it is.
    const blob = git(repo, 'rev-parse', `${kept}:README.md`);
    const other = git(repo, 'rev-parse', 'HEAD~1:README.md');
    const loose = (hash: string) => join(repo, '.git', 'objects', hash.slice(0, 2), hash.slice(2));
    rmSync(loose(blob), { force: true });
    writeFileSync(loose(blob), readFileSync(loose(other)));
    // Copied when its repository is first used: by a read here (a snapshot would write the true one itself).
    expect(await fileAt(repo, kept, 'README.md')).toBeUndefined();
    expect(store('for-each-ref', 'refs/harness-relay/')).toBe('');
  });

  it("compares a fixed command's first Save with HEAD, copied in with its objects checked", async () => {
    const head = await committed();
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    const base = await committedBase(repo);
    expect(base).toBe(head);
    const snap = await snapshot(repo);
    expect(await changedPaths(repo, base, snap.commit, ['README.md', 'src/app.ts'])).toEqual(['README.md']);
  });

  it("packs its repository now and then, its snapshots' parents in the working repository marked shallow", async () => {
    await committed();
    const first = await snapshot(repo);
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    const second = await snapshot(repo);
    setTidyLimits(-1, 0);
    try {
      await keepCommits(repo, 'conv-1', [first.commit, second.commit]);
    } finally {
      setTidyLimits();
    }
    expect(readdirSync(join(repoStore(repo), 'objects', 'pack')).some((n) => n.endsWith('.pack'))).toBe(true);
    expect(readFileSync(join(repoStore(repo), 'shallow'), 'utf8')).toContain(first.commit);
    expect(store('fsck', '--no-dangling')).toBe('');
    expect((await diffFiles(repo, first.commit, second.commit)).map((f) => f.path)).toEqual(['README.md']);
    // A snapshot after it starts from its index as before.
    writeFileSync(join(repo, 'NEW.md'), 'new\n');
    expect(store('ls-tree', '-r', '--name-only', (await snapshot(repo)).commit).split('\n')).toContain('NEW.md');
  });

  it('keeps what its own indexes hold from being pruned, once nothing else keeps it', async () => {
    await committed();
    const first = await snapshot(repo);
    const wt = join(dir, 'wt');
    await createWorktree(repo, wt, 'relay/test', first.commit);
    writeFileSync(join(wt, 'by-agent.md'), 'by the agent\n');
    expect(await worktreeChanged(repo, wt, 'relay/test', first.commit)).toBe(true);
    // No ref keeps the snapshot, and gc prunes at once.
    setTidyLimits(-1, 0);
    try {
      await keepCommits(repo, 'conv-1', []);
      await keepCommits(repo, 'conv-2', [first.commit]);
      await dropKeptCommits(repo, 'conv-2');
      await keepCommits(repo, 'conv-3', [(await snapshot(repo)).commit]);
      await dropKeptCommits(repo, 'conv-3');
      await keepCommits(repo, 'conv-4', [first.commit]);
    } finally {
      setTidyLimits();
    }
    expect(store('fsck', '--no-dangling', '--connectivity-only')).toBe('');
    // Both indexes still name only objects that are there.
    writeFileSync(join(repo, 'NEW.md'), 'new\n');
    const again = await snapshot(repo);
    expect(store('show', `${again.commit}:src/app.ts`)).toBe('export const x = 1;');
    const head = (await commitWorktree(repo, wt, 'relay/test', 'turn'))!;
    expect(store('show', `${head}:by-agent.md`)).toBe('by the agent');
    await removeWorktree(repo, wt, 'relay/test');
    expect(store('for-each-ref', 'refs/relay/index/')).not.toContain(basename(wt));
  });

  it('makes its index again from nothing when it cannot use it (a file cut short)', async () => {
    await committed();
    await snapshot(repo);
    const caches = join(repoStore(repo), 'relay-index');
    for (const name of readdirSync(caches)) writeFileSync(join(caches, name), 'DIRC broken');
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    expect(store('show', `${(await snapshot(repo)).commit}:README.md`)).toBe('changed');
  });

  it('follows HEAD: a file force-added and committed since is taken in, one untracked and ignored since is dropped', async () => {
    await committed();
    writeFileSync(join(repo, '.gitignore'), 'dist/\n.env\n');
    writeFileSync(join(repo, '.env'), 'secret\n');
    git(repo, 'add', '-f', '.env');
    git(repo, 'add', '.gitignore');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ignore');
    const files = async () => store('ls-tree', '-r', '--name-only', (await snapshot(repo)).commit).split('\n');
    expect(await files()).toContain('.env');
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'b.js'), 'built\n');
    expect(await files()).not.toContain('dist/b.js');
    git(repo, 'add', '-f', 'dist/b.js');
    git(repo, 'rm', '-q', '--cached', '.env');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'swap');
    const now = await files();
    expect(now).toContain('dist/b.js');
    expect(now).not.toContain('.env');
  });

  it('leaves out what the repository tracks in a folder left out, and a submodule whose folder holds no repository', async () => {
    await ensureRepo(repo);
    mkdirSync(join(repo, 'home'));
    writeFileSync(join(repo, 'home', 'auth.json'), '{"token":"x"}\n');
    const lib = join(repo, 'lib');
    mkdirSync(lib);
    git(lib, 'init', '-q');
    writeFileSync(join(lib, 'a.js'), 'a\n');
    git(lib, 'add', '-A');
    git(lib, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'lib');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    const files = async () => store('ls-tree', '-r', '--name-only', (await snapshot(repo, [join(repo, 'home')])).commit).split('\n');
    expect(await files()).toEqual(expect.arrayContaining(['README.md', 'lib']));
    expect(await files()).not.toContain('home/auth.json');
    // lib's repository gone (an agent removed it, or made a folder look like one): its files are taken in.
    rmSync(join(lib, '.git'), { recursive: true, force: true });
    writeFileSync(join(lib, 'a.js'), 'changed\n');
    const now = await files();
    expect(now).toContain('lib/a.js');
    expect(now).not.toContain('lib');
  });

  it('takes the same tree from snapshots of one folder at once', async () => {
    await committed();
    const trees = await Promise.all([1, 2, 3, 4].map(() => snapshot(repo).then((s) => s.tree)));
    expect(new Set(trees).size).toBe(1);
  });

  it('keeps a file a worktree an older Harness Relay made tracks where an ignore rule matches it, so Apply never deletes it', async () => {
    writeFileSync(join(repo, '.gitignore'), 'dist/\n');
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'bundle.js'), 'bundle\n');
    await ensureRepo(repo);
    git(repo, 'add', '-A');
    git(repo, 'add', '-f', 'dist/bundle.js');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    const legacy = join(dir, 'legacy');
    // As an older Harness Relay made it: its files' bytes as they are (Git for Windows would add CRs).
    git(repo, '-c', 'core.autocrlf=false', 'worktree', 'add', '-q', '-b', 'relay/old', legacy);
    const old = git(repo, 'rev-parse', 'relay/old');
    writeFileSync(join(legacy, 'by-agent.md'), 'x\n');
    const head = (await commitWorktree(repo, legacy, 'relay/old', 'Harness Relay'))!;
    expect(await diffFiles(repo, old, head)).toEqual([{ path: 'by-agent.md', status: 'A', added: 1, deleted: 0 }]);
  });

  it('refuses to start an agent in its worktree through a link it made there, and makes nothing through it', async () => {
    await committed();
    const snap = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt');
    await createWorktree(repo, wt, 'relay/test', snap);
    expect(worktreeCwd(repo, join(repo, 'src'), wt)).toBe(join(wt, 'src'));
    // `src` replaced by a link to a folder elsewhere (a junction on Windows).
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(join(wt, 'src'), { recursive: true, force: true });
    symlinkSync(elsewhere, join(wt, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(() => withLang('en', () => worktreeCwd(repo, join(repo, 'src', 'deep'), wt))).toThrow(
      /is a link, which would take the agent out of its worktree/,
    );
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("copies a linked worktree's own HEAD for a fixed command's first Save, not its main checkout's", async () => {
    const main = await committed();
    const linked = join(dir, 'linked');
    git(repo, '-c', 'core.autocrlf=false', 'worktree', 'add', '-q', '-b', 'feature', linked);
    writeFileSync(join(linked, 'README.md'), 'feature\n');
    git(linked, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'feature');
    const head = git(linked, 'rev-parse', 'HEAD');
    expect(head).not.toBe(main);
    expect(await committedBase(linked)).toBe(head);
  });

  it('takes no tracked file beyond a link in, and never fails a snapshot for one git will not take', async () => {
    writeFileSync(join(repo, '.gitignore'), 'vendor/\n');
    mkdirSync(join(repo, 'vendor'));
    writeFileSync(join(repo, 'vendor', 'lib.js'), 'lib\n');
    await ensureRepo(repo);
    git(repo, 'add', '-A');
    git(repo, 'add', '-f', 'vendor/lib.js');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    // `vendor` made a link to a folder elsewhere.
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'lib.js'), 'outside\n');
    rmSync(join(repo, 'vendor'), { recursive: true, force: true });
    symlinkSync(elsewhere, join(repo, 'vendor'), process.platform === 'win32' ? 'junction' : 'dir');
    const snap = await snapshot(repo);
    expect(store('ls-tree', '-r', '--name-only', snap.commit).split('\n')).not.toContain('vendor/lib.js');
  });

  it('removes a worktree with its refs, also once they were packed', async () => {
    await committed();
    const snap = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt');
    await createWorktree(repo, wt, 'relay/test', snap);
    writeFileSync(join(wt, 'by-agent.md'), 'x\n');
    await commitWorktree(repo, wt, 'relay/test', 'turn');
    store('pack-refs', '--all');
    await removeWorktree(repo, wt, 'relay/test');
    expect(store('for-each-ref', 'refs/heads/relay/', 'refs/relay/index/')).not.toMatch(/relay\/test|index\/(?!work-)/);
  });

  it("runs no command the working repository's config names when it copies what an older version kept there", async () => {
    await committed();
    // A partial clone whose remote is reached through a command, and a kept commit with an object gone.
    const ran = join(dir, 'ran.txt');
    writeFileSync(join(repo, 'README.md'), 'kept\n');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'kept');
    const kept = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', `refs/harness-relay/conv-old/${kept}`, kept);
    git(repo, 'config', 'core.repositoryformatversion', '1');
    git(repo, 'config', 'extensions.partialClone', 'origin');
    git(repo, 'config', 'remote.origin.url', 'ssh://example.invalid/x.git');
    git(repo, 'config', 'remote.origin.promisor', 'true');
    git(repo, 'config', 'core.sshCommand', `sh -c 'echo ssh >> "${ran}"; exit 1' --`);
    git(repo, 'config', 'uploadpack.packObjectsHook', `sh -c 'echo hook >> "${ran}"; exit 1' --`);
    const blob = git(repo, 'rev-parse', `${kept}:README.md`);
    rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    expect(await fileAt(repo, kept, 'README.md')).toBeUndefined();
    expect(existsSync(ran)).toBe(false);
    expect(store('for-each-ref', 'refs/harness-relay/')).toBe('');
  });

  it.skipIf(process.platform === 'win32')(
    'never holds a snapshot back while it copies what an older version kept (a named pipe in its objects)',
    async () => {
      await committed();
      writeFileSync(join(repo, 'README.md'), 'kept\n');
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'kept');
      const kept = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'update-ref', `refs/harness-relay/conv-old/${kept}`, kept);
      const tree = git(repo, 'rev-parse', `${kept}^{tree}`);
      const pipe = join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
      rmSync(pipe, { force: true });
      execFileSync('mkfifo', [pipe]);
      try {
        const started = Date.now();
        await snapshot(repo);
        expect(Date.now() - started).toBeLessThan(slow(10_000));
      } finally {
        try {
          closeSync(openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch {
          // no reader
        }
      }
    },
  );

  it("runs nothing a repository's config names when it reads its objects, also as a git before 2.44 would (no GIT_NO_LAZY_FETCH)", async () => {
    await committed();
    writeFileSync(join(repo, 'README.md'), 'kept\n');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'kept');
    const kept = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', `refs/harness-relay/conv-old/${kept}`, kept);
    // A partial clone whose remote runs a command, over a protocol its own config allows.
    const ran = join(dir, 'ran.txt');
    const remote = join(dir, 'remote.git');
    mkdirSync(remote);
    git(remote, 'init', '-q', '--bare');
    git(repo, 'config', 'core.repositoryformatversion', '1');
    git(repo, 'config', 'extensions.partialClone', 'origin');
    git(repo, 'config', 'remote.origin.url', remote);
    git(repo, 'config', 'remote.origin.promisor', 'true');
    git(repo, 'config', 'remote.origin.uploadpack', `sh -c 'echo ran >> "${ran}"; exit 1' --`);
    git(repo, 'config', 'protocol.file.allow', 'always');
    const blob = git(repo, 'rev-parse', `${kept}:README.md`);
    rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    setLazyFetchGuard(false);
    try {
      expect(await fileAt(repo, kept, 'README.md')).toBeUndefined();
      await committedBase(repo);
      await commitsSince(repo, [], Date.now() - 60_000, 10);
      await snapshot(repo);
    } finally {
      setLazyFetchGuard();
    }
    expect(existsSync(ran)).toBe(false);
  });

  it('drops a conversation deleted right after a start for good, waiting for the copy that would bring it back', async () => {
    await committed();
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', `refs/harness-relay/conv-old/${head}`, head);
    await dropKeptCommits(repo, 'conv-old');
    expect(store('for-each-ref', 'refs/harness-relay/')).toBe('');
    setRepoStore(join(dir, 'repos'));
    await snapshot(repo);
    await dropKeptCommits(repo, 'conv-none');
    expect(store('for-each-ref', 'refs/harness-relay/')).toBe('');
  });

  it('keeps the other tracked files an ignore rule matches when git will not take one of them', async () => {
    writeFileSync(join(repo, '.gitignore'), 'dist/\nsub/b.js\n');
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'a.js'), 'a\n');
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'b.js'), 'b\n');
    await ensureRepo(repo);
    git(repo, 'add', '-A');
    git(repo, 'add', '-f', 'dist/a.js', 'sub/b.js');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    // `sub` made a repository of its own: git takes no path of the outer one in it.
    git(join(repo, 'sub'), 'init', '-q');
    git(join(repo, 'sub'), 'add', '-A');
    git(join(repo, 'sub'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'sub');
    const files = store('ls-tree', '-r', '--name-only', (await snapshot(repo)).commit).split('\n');
    expect(files).toContain('dist/a.js');
    writeFileSync(join(repo, 'NEW.md'), 'new\n');
    git(repo, 'add', 'NEW.md');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'again');
    expect(store('ls-tree', '-r', '--name-only', (await snapshot(repo)).commit).split('\n')).toContain('dist/a.js');
  });

  it.skipIf(process.platform === 'win32')(
    'runs no remote helper an agent put in the folder, through a lazy fetch of a git before 2.44 (team checks, the Files panel)',
    async () => {
      await committed();
      // A partial clone whose remote is a helper the agent wrote, which its own config allows.
      const ran = join(dir, 'ran.txt');
      mkdirSync(join(repo, 'git-remote-'));
      writeFileSync(join(repo, 'git-remote-', 'x'), `#!/bin/sh\necho ran >> "${ran}"\nexit 1\n`, { mode: 0o755 });
      git(repo, 'config', 'core.repositoryformatversion', '1');
      git(repo, 'config', 'extensions.partialClone', 'origin');
      git(repo, 'config', 'remote.origin.url', 'x::y');
      git(repo, 'config', 'remote.origin.vcs', '/x');
      git(repo, 'config', 'remote.origin.promisor', 'true');
      git(repo, 'config', 'protocol./x.allow', 'always');
      git(repo, 'config', 'protocol.allow', 'always');
      // A branch naming an object that is not there, which git would fetch.
      writeFileSync(join(repo, '.git', 'refs', 'heads', 'gone'), `${'1'.repeat(40)}\n`);
      setLazyFetchGuard(false);
      try {
        await commitsSince(repo, [], Date.now() - 60_000, 10).catch(() => undefined);
        await unignoredFiles(repo);
        await snapshot(repo);
      } finally {
        setLazyFetchGuard();
      }
      expect(existsSync(ran)).toBe(false);
    },
  );

  it('copies every commit it can of what an older version kept: one that is not whole keeps no other out', async () => {
    await committed();
    const made: string[] = [];
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(join(repo, 'README.md'), `${name}\n`);
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', name);
      const sha = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'update-ref', `refs/harness-relay/conv-old/${sha}`, sha);
      made.push(sha);
    }
    // The second's README is gone from the working repository.
    const blob = git(repo, 'rev-parse', `${made[1]}:README.md`);
    rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    expect(await fileAt(repo, made[2]!, 'README.md')).toBe('three\n');
    expect(await fileAt(repo, made[0]!, 'README.md')).toBe('one\n');
    expect(store('for-each-ref', '--format=%(refname)', 'refs/harness-relay/').split('\n').sort()).toEqual(
      [made[0], made[2]].map((sha) => `refs/harness-relay/conv-old/${sha}`).sort(),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'deletes a conversation at once while it still copies what an older version kept, and the copy does not bring it back',
    async () => {
      await committed();
      writeFileSync(join(repo, 'README.md'), 'kept\n');
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'kept');
      const kept = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'update-ref', `refs/harness-relay/conv-old/${kept}`, kept);
      // The copy held on a named pipe in the objects.
      const tree = git(repo, 'rev-parse', `${kept}^{tree}`);
      const pipe = join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
      rmSync(pipe, { force: true });
      execFileSync('mkfifo', [pipe]);
      try {
        await snapshot(repo);
        const started = Date.now();
        await dropKeptCommits(repo, 'conv-old');
        expect(Date.now() - started).toBeLessThan(slow(5_000));
      } finally {
        try {
          closeSync(openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch {
          // no reader
        }
      }
      // Once the copy ends (a read of its commit waits for it), nothing of the conversation is back.
      await fileAt(repo, kept, 'README.md');
      expect(store('for-each-ref', 'refs/harness-relay/')).toBe('');
    },
  );

  it.skipIf(process.platform === 'win32')('reads no objects through an alternates file that is a named pipe', async () => {
    await committed();
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', `refs/harness-relay/conv-old/${head}`, head);
    execFileSync('mkfifo', [join(repo, '.git', 'objects', 'info', 'alternates')]);
    const started = Date.now();
    await snapshot(repo);
    expect(await fileAt(repo, head, 'README.md')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(slow(10_000));
  });

  it('takes a turn in a worktree in six git processes', async () => {
    await committed();
    const snap = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt');
    await createWorktree(repo, wt, 'relay/test', snap);
    writeFileSync(join(wt, 'by-agent.md'), 'x\n');
    const started: string[][] = [];
    recordSpawns({
      start: ({ bin, args }) => {
        if (/^git(\.exe)?$/i.test(basename(bin))) started.push([...args]);
        return undefined;
      },
    });
    try {
      expect(await commitWorktree(repo, wt, 'relay/test', 'turn')).toBeTruthy();
    } finally {
      recordSpawns(undefined);
    }
    const command = (args: string[]) => args[args.findIndex((a, n) => a !== '-c' && args[n - 1] !== '-c')];
    expect(started.map(command)).toEqual(['rev-parse', 'ls-files', 'add', 'write-tree', 'hash-object', 'update-ref']);
  });

  it("takes a snapshot in five git processes, the working repository's excludes honoured, from a split index too", async () => {
    await committed();
    await snapshot(repo); // the store made first
    const started: string[][] = [];
    recordSpawns({
      start: ({ bin, args }) => {
        if (/^git(\.exe)?$/i.test(basename(bin))) started.push([...args]);
        return undefined;
      },
    });
    let snap: Awaited<ReturnType<typeof snapshot>>;
    try {
      snap = await snapshot(repo);
      await keepCommits(repo, 'conv-1', [snap.commit]);
    } finally {
      recordSpawns(undefined);
    }
    const command = (args: string[]) => args[args.findIndex((a, n) => a !== '-c' && args[n - 1] !== '-c')];
    expect(started.map(command)).toEqual(['rev-parse', 'ls-files', 'add', 'write-tree', 'hash-object', 'update-ref']);
    // Every command with hooks, fsmonitor, rerere, gc and maintenance off.
    for (const args of started)
      for (const setting of [
        'core.hooksPath=/dev/null',
        'core.fsmonitor=false',
        'rerere.enabled=false',
        'gc.auto=0',
        'maintenance.auto=false',
      ])
        expect(args, setting).toContain(setting);
    // Its info/exclude (Harness Relay's DEFAULT_EXCLUDES there) leaves node_modules out.
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'x.js'), 'x\n');
    expect(store('ls-tree', '-r', '--name-only', (await snapshot(repo)).commit).split('\n')).not.toContain('node_modules/x.js');
    // A split index in the working repository: never read.
    git(repo, 'update-index', '--split-index');
    writeFileSync(join(repo, 'new.md'), 'new\n');
    expect(store('ls-tree', '-r', '--name-only', (await snapshot(repo)).commit).split('\n')).toContain('new.md');
  });

  it.skipIf(process.platform === 'win32')(
    'never blocks the server on a named pipe an agent put in place of the index or info/exclude',
    async () => {
      await committed();
      await snapshot(repo);
      // In a process of its own, whose timer must still fire: a read of a pipe there would block the server's every request.
      for (const file of ['index', join('info', 'exclude')]) {
        const pipe = join(repo, '.git', file);
        rmSync(pipe, { force: true });
        execFileSync('mkfifo', [pipe]);
        const script = join(dir, 'pipe.mts');
        writeFileSync(
          script,
          `import { setRepoStore, snapshot } from ${JSON.stringify(join(ROOT_DIR, 'src', 'server', 'workspace.ts'))};\n` +
            `setRepoStore(${JSON.stringify(join(dir, 'repos'))});\n` +
            `const op = snapshot(${JSON.stringify(repo)}).then(() => 'done', (e) => 'refused: ' + e.message);\n` +
            `const later = new Promise((r) => setTimeout(() => r('still waiting'), 5000));\n` +
            `console.log(await Promise.race([op, later])); process.exit(0);\n`,
        );
        try {
          const r = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: slow(30_000), cwd: ROOT_DIR });
          expect(r.error, `the server waited on the pipe at ${file}`).toBeUndefined();
          expect(r.stdout, file).toContain('done');
        } finally {
          try {
            closeSync(openSync(pipe, constants.O_WRONLY | constants.O_NONBLOCK));
          } catch {
            // no reader
          }
          rmSync(pipe, { force: true });
        }
      }
    },
  );
});

describe('keepCommits', () => {
  it('keeps snapshot commits through git gc until the conversation drops them', async () => {
    await ensureRepo(repo);
    const snap = (await snapshot(repo)).commit;
    await keepCommits(repo, 'conv-1', [snap]);
    inStore(repo, 'gc', '-q', '--prune=now');
    expect(inStore(repo, 'cat-file', '-t', snap)).toBe('commit');

    await dropKeptCommits(repo, 'conv-1');
    expect(inStore(repo, 'for-each-ref', 'refs/harness-relay/')).toBe('');
    inStore(repo, 'reflog', 'expire', '--expire=now', '--all');
    inStore(repo, 'gc', '-q', '--prune=now');
    expect(() => inStore(repo, 'cat-file', '-t', snap)).toThrow();
  });
});

describe("a repository's own config that would run commands", () => {
  it("runs none of them in Harness Relay's git commands: fsmonitor, filters, textconv, also through an include", async () => {
    await ensureRepo(repo);
    const ran = join(dir, 'ran.txt');
    // With `/` (also on Windows, where sh takes it): a config file reads `\` as an escape.
    const at = ran.replaceAll('\\', '/');
    const sh = (what: string) => `sh -c 'echo ${what} >> "${at}"; cat'`;
    git(repo, 'config', 'core.fsmonitor', `sh -c 'echo fsmonitor >> "${at}"'`);
    git(repo, 'config', 'filter.evil.clean', sh('clean'));
    git(repo, 'config', 'filter.evil.smudge', sh('smudge'));
    git(repo, 'config', 'diff.evil.textconv', `sh -c 'echo textconv >> "${at}"; cat "$0"'`);
    git(repo, 'config', 'include.path', 'extra.cfg');
    writeFileSync(join(repo, '.git', 'extra.cfg'), `[filter "inc"]\n\tclean = ${sh('included')}\n`);
    writeFileSync(join(repo, '.gitattributes'), '*.md filter=evil diff=evil\n*.ts filter=inc\n');
    // A name with a space or a dot is still one driver.
    git(repo, 'config', 'filter.a b.c.clean', sh('spaced'));

    const guards = await repoDriverGuards(repo, process.env);
    expect(guards).toEqual(
      expect.arrayContaining([
        '-c',
        'filter.evil.clean=',
        '-c',
        'diff.evil.textconv=',
        '-c',
        'filter.inc.clean=',
        '-c',
        'filter.a b.c.clean=',
      ]),
    );

    const first = await snapshot(repo);
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    const second = await snapshot(repo);
    await diffFiles(repo, first.commit, second.commit);
    await diffText(repo, first.commit, second.commit);
    await unignoredFiles(repo);
    await createWorktree(repo, join(dir, 'wt'), 'relay/test', second.commit);
    expect(existsSync(ran)).toBe(false);
  });

  it('runs no driver a config pads past what its guards read at once, and reads its settings whole for a pin', async () => {
    await ensureRepo(repo);
    const ran = join(dir, 'ran.txt').replaceAll('\\', '/');
    git(repo, 'config', 'filter.evil.clean', `sh -c 'echo clean >> "${ran}"; cat'`);
    writeFileSync(join(repo, '.gitattributes'), '*.md filter=evil\n');
    // More than the 64 KB a process's output is kept to by default, after the driver (written into the
    // file: on Windows a command line that long is refused).
    appendFileSync(join(repo, '.git', 'config'), `[diff "pad"]\n\tnote = ${'x'.repeat(70 * 1024)}\n`);
    expect(await repoDriverGuards(repo, process.env)).toEqual(expect.arrayContaining(['-c', 'filter.evil.clean=']));
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    await snapshot(repo);
    expect(existsSync(ran)).toBe(false);
    git(repo, 'config', 'core.sshCommand', 'sh -c evil');
    const state = await repoGitState(repo);
    expect(state!.settings.get('core.sshcommand')).toEqual(['sh -c evil']);
    // Outside a repository: none; not a failure.
    expect(await repoGitState(dir)).toBeUndefined();
  });

  it("runs no gpg.program a repository's config names when it reads the commits the team made (log.showSignature)", async () => {
    await ensureRepo(repo);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    const before = [git(repo, 'rev-parse', 'HEAD')];
    const ran = join(dir, 'ran.txt');
    const gpg = join(dir, 'gpg.sh');
    writeFileSync(gpg, `#!/bin/sh\necho ran >> "${ran}"\nexit 1\n`, { mode: 0o755 });
    git(repo, 'config', 'log.showSignature', 'true');
    git(repo, 'config', 'gpg.program', gpg);
    // A commit with a signature header, which log verifies when asked to show signatures.
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}');
    const signed = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], {
      input: `tree ${tree}\nparent ${before[0]}\nauthor t <t@t> ${Math.floor(Date.now() / 1000)} +0000\ncommitter t <t@t> ${Math.floor(Date.now() / 1000)} +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nsigned\n`,
      encoding: 'utf8',
    }).trim();
    git(repo, 'update-ref', 'refs/heads/main', signed);
    git(repo, 'checkout', '-q', 'main');
    const made = await commitsSince(repo, before, Date.now() - 60_000, 10);
    expect(made.commits.map((c) => c.subject)).toEqual(['signed']);
    expect(existsSync(ran)).toBe(false);
  });

  it('fetches no missing object, as the remote of a partial clone would be reached through a command the config names', async () => {
    await ensureRepo(repo);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
    const first = await snapshot(repo);
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    const second = await snapshot(repo);
    const ran = join(dir, 'ran.txt');
    git(repo, 'config', 'core.repositoryformatversion', '1');
    git(repo, 'config', 'extensions.partialClone', 'origin');
    git(repo, 'config', 'remote.origin.url', 'ssh://example.invalid/x.git');
    git(repo, 'config', 'remote.origin.promisor', 'true');
    git(repo, 'config', 'core.sshCommand', `sh -c 'echo ssh >> "${ran}"; exit 1' --`);
    // The changed README's object, gone from Harness Relay's repository (it never had a remote).
    const blob = inStore(repo, 'rev-parse', `${second.commit}:README.md`);
    rmSync(join(repoStore(repo), 'objects', blob.slice(0, 2), blob.slice(2)));
    await expect(diffText(repo, first.commit, second.commit)).rejects.toThrow();
    await expect(createWorktree(repo, join(dir, 'wt'), 'relay/test', second.commit)).rejects.toThrow();
    expect(existsSync(ran)).toBe(false);
  });

  it("takes the repository's own files whatever its core.worktree names, and refuses a working directory whose core.worktree is another folder", async () => {
    await ensureRepo(repo);
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    for (const other of [outside, '../..']) {
      git(repo, 'config', 'core.worktree', other);
      // A snapshot names its working tree (GIT_WORK_TREE): never what the config names.
      const snap = await snapshot(repo);
      expect(inStore(repo, 'ls-tree', '-r', '--name-only', snap.commit).split('\n')).not.toContain('secret.txt');
      await expect(repoRoot(repo)).rejects.toThrow(/core\.worktree/);
    }
    // Its own folder (relative to .git) is fine.
    git(repo, 'config', 'core.worktree', '..');
    expect(await repoRoot(repo)).toBe(realpathSync(repo));
  });

  it('runs no driver of a repository at a submodule, which git add runs git status in, and still takes a real submodule', async () => {
    await ensureRepo(repo);
    const ran = join(dir, 'ran.txt');
    const sub = join(repo, 'sub');
    const quiet = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    mkdirSync(sub);
    // Its .git is an ordinary folder of the working tree, which any agent can write.
    quiet(sub, 'init', '-q');
    writeFileSync(join(sub, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(sub, 'x.md'), 'x\n');
    quiet(sub, 'add', '-A');
    quiet(sub, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
    quiet(repo, 'add', 'sub');
    git(sub, 'config', 'filter.evil.clean', `sh -c 'echo clean >> "${ran}"; cat'`);
    expect(await repoDriverGuards(repo, process.env, true)).toEqual(expect.arrayContaining(['-c', 'filter.evil.clean=']));
    await snapshot(repo);
    writeFileSync(join(sub, 'x.md'), 'changed\n');
    await snapshot(repo);
    expect(existsSync(ran)).toBe(false);
    // As a submodule (its git data in .git/modules, its core.worktree pointing back): still taken.
    writeFileSync(join(repo, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
    quiet(repo, 'submodule', 'absorbgitdirs');
    await snapshot(repo);
    expect(existsSync(ran)).toBe(false);
  });

  it("leaves the user's own drivers (git-lfs, say) alone", async () => {
    await ensureRepo(repo);
    const home = join(dir, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.gitconfig'), '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n');
    const guards = await repoDriverGuards(repo, { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
    expect(guards.join(' ')).not.toContain('lfs');
  });
});
