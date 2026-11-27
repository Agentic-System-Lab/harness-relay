import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPatch,
  applyToWorkingTree,
  checkPatch,
  commitWorktree,
  createWorktree,
  diffFiles,
  diffText,
  dropKeptCommits,
  forgetCommits,
  ensureRepo,
  excludePathspecs,
  gitDirLink,
  keepCommits,
  needsDriverGuards,
  parseDiffFiles,
  removeWorktree,
  repoDriverGuards,
  repoGitState,
  snapshot,
  unignoredFiles,
  worktreeCwd,
} from '../src/server/workspace';
import { recordSpawns } from '../src/server/process';
import { slow } from './timeouts';

let dir: string;
let repo: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'relay-ws-')));
  repo = join(dir, 'project');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 1;\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
    expect(git(repo, 'rev-list', '--parents', '-n', '1', first.commit)).toBe(first.commit);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first');
    const head = git(repo, 'rev-parse', 'HEAD');
    const second = await snapshot(repo);
    expect(git(repo, 'rev-list', '--parents', '-n', '1', second.commit)).toBe(`${second.commit} ${head}`);
  });

  it('captures tracked and untracked files without touching HEAD, index or files', async () => {
    await ensureRepo(repo);
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'ignored');
    const statusBefore = git(repo, 'status', '--porcelain');

    const snap = await snapshot(repo);
    const files = git(repo, 'ls-tree', '-r', '--name-only', snap.commit).split('\n');
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
      git(repo, 'ls-tree', '-r', '--name-only', (await snapshot(repo, exclude)).commit)
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
    const head = await commitWorktree(wt, 'turn');
    expect(head).toBeTruthy();
    expect(await commitWorktree(wt, 'nothing')).toBeNull();

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
    expect(git(repo, 'branch', '--list', 'relay/*')).toBe('');
  });

  it("checks a patch without changing anything, then applies it; and names a diff's paths after a folder", async () => {
    await ensureRepo(repo);
    const base = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt', 'c');
    await createWorktree(repo, wt, 'relay/test/C', base);
    writeFileSync(join(wt, 'NEW.md'), 'new\n');
    const head = (await commitWorktree(wt, 'turn'))!;
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
    const head = (await commitWorktree(wt, 'turn'))!;

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
    const head = (await commitWorktree(wt, 'turn'))!;
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

describe('the git processes a turn costs', () => {
  /**
   * The git processes `run` starts, by their command: the first argument that is not a `-c` setting.
   * (On a Mac whose git is Apple's, each git command also asks `xcode-select` first: not counted.)
   */
  async function gitCommands(run: () => Promise<unknown>): Promise<string[]> {
    const started: string[] = [];
    recordSpawns({
      start: ({ bin, args }) => {
        if (!/^git(\.exe)?$/i.test(basename(bin))) return undefined;
        const i = args.findIndex((a, n) => a !== '-c' && args[n - 1] !== '-c');
        started.push(args[i] ?? '');
        return undefined;
      },
    });
    try {
      await run();
    } finally {
      recordSpawns(undefined);
    }
    return started;
  }

  // A turn takes a snapshot before and after it and keeps both commits (the orchestrator's
  // `changesIn`): on Windows each git process costs about half a second, seconds on a busy computer,
  // so a command more here makes every turn slower. Raise these only for a reason worth it.
  it('takes a snapshot in seven git processes, the guards read for `git add` and `git write-tree` alone, and keeps its commits in one', async () => {
    await ensureRepo(repo);
    expect(await gitCommands(() => snapshot(repo))).toEqual([
      'rev-parse',
      'config',
      'ls-files',
      'add',
      'config',
      'write-tree',
      'commit-tree',
    ]);
    const snap = (await snapshot(repo)).commit;
    expect(await gitCommands(() => keepCommits(repo, 'conv-1', [snap]))).toEqual(['update-ref']);
  });

  it('reads the guards for every command but plumbing over objects and refs', () => {
    for (const args of [
      ['commit-tree', 'abc', '-p', 'def', '-m', 'x'],
      ['mktree'],
      ['update-ref', '--stdin'],
      ['for-each-ref', '--format=delete %(refname)', 'refs/harness-relay/c/'],
      ['show-ref', '--head', '--heads'],
      ['ls-tree', '-r', '-z', '--name-only', '--full-tree', 'abc'],
      ['rev-parse', '--git-path', 'index', '--verify', '-q', 'HEAD'],
      ['rev-parse', 'abc^{tree}'],
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      ['rev-parse', '--git-common-dir'],
    ])
      expect(needsDriverGuards(args), args.join(' ')).toBe(false);
    for (const args of [
      [],
      ['add', '-A'],
      ['diff', 'a', 'b'],
      ['show', 'abc:README.md'],
      ['hash-object', '-w', 'README.md'],
      ['ls-files', '-z'],
      ['status', '--porcelain'],
      ['apply', '-'],
      ['worktree', 'add', 'x'],
      ['commit', '-m', 'x'],
      ['init', '-q'],
      ['config', '--list'],
      // It hashes a racily clean index entry again, through its path's clean filter.
      ['write-tree'],
      // `:<path>` reads the index, `<rev>:<path>` a tree's file.
      ['rev-parse', ':README.md'],
      ['rev-parse', '--verify', 'HEAD:README.md'],
      // `core.worktree` names it: what the guards check is the repository's own folder.
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--git-path', 'index', '--show-toplevel'],
      ['rev-parse', '--absolute-git-dir', '--show-toplevel'],
    ])
      expect(needsDriverGuards(args), args.join(' ')).toBe(true);
  });

  it('still refuses a core.worktree elsewhere before git add, and runs no driver in the plumbing that skips the guards', async () => {
    await ensureRepo(repo);
    const first = await snapshot(repo);
    const ran = join(dir, 'ran.txt').replaceAll('\\', '/');
    const sh = (what: string) => `sh -c 'echo ${what} >> "${ran}"; cat'`;
    git(repo, 'config', 'filter.evil.clean', sh('clean'));
    git(repo, 'config', 'filter.evil.smudge', sh('smudge'));
    git(repo, 'config', 'merge.evil.driver', sh('merge'));
    writeFileSync(join(repo, '.gitattributes'), '* filter=evil merge=evil\n');
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    const second = await snapshot(repo);
    await keepCommits(repo, 'conv-1', [first.commit, second.commit]);
    await dropKeptCommits(repo, 'conv-1');
    expect(existsSync(join(dir, 'ran.txt'))).toBe(false);
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    git(repo, 'config', 'core.worktree', outside);
    await expect(snapshot(repo)).rejects.toThrow(/core\.worktree/);
  });
});

describe("a link in the repository's git folder, which Harness Relay's git would write through", () => {
  /** A link to a folder (a junction on Windows, which needs no rights there). */
  const dirLink = (target: string, path: string) => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  const gitDir = () => join(repo, '.git');
  const refused = /is a link in the repository's git folder, which Harness Relay's git would write through/;
  const listed = (folder: string) => (existsSync(folder) ? readdirSync(folder, { recursive: true }) : []);

  it("refuses to keep a commit's ref, or let one go, through a linked folder of refs or logs, or a linked log, and writes nothing there", async () => {
    await ensureRepo(repo);
    const snap = (await snapshot(repo)).commit;
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    dirLink(outside, join(gitDir(), 'refs', 'harness-relay'));
    await expect(keepCommits(repo, 'conv-1', [snap])).rejects.toThrow(refused);
    expect(listed(outside)).toEqual([]);
    // A file there that reads as a kept ref is not deleted through it either.
    mkdirSync(join(outside, 'conv-1'));
    writeFileSync(join(outside, 'conv-1', snap), `${snap}\n`);
    await expect(dropKeptCommits(repo, 'conv-1')).rejects.toThrow(refused);
    await expect(forgetCommits(repo, 'conv-1', [snap])).rejects.toThrow(refused);
    expect(readFileSync(join(outside, 'conv-1', snap), 'utf8')).toBe(`${snap}\n`);
    rmSync(join(gitDir(), 'refs', 'harness-relay'), { recursive: false, force: true });

    // Its logs' folder linked: a log would be written there.
    const logs = join(dir, 'logs-outside');
    mkdirSync(logs);
    mkdirSync(join(gitDir(), 'logs', 'refs'), { recursive: true });
    dirLink(logs, join(gitDir(), 'logs', 'refs', 'harness-relay'));
    await expect(keepCommits(repo, 'conv-1', [snap])).rejects.toThrow(refused);
    expect(listed(logs)).toEqual([]);
    rmSync(join(gitDir(), 'logs', 'refs', 'harness-relay'), { force: true });

    // A log itself linked: git appends to a log there is, whatever core.logAllRefUpdates says.
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'keep\n');
    mkdirSync(join(gitDir(), 'logs', 'refs', 'harness-relay', 'conv-1'), { recursive: true });
    symlinkSync(victim, join(gitDir(), 'logs', 'refs', 'harness-relay', 'conv-1', snap));
    await expect(keepCommits(repo, 'conv-1', [snap])).rejects.toThrow(refused);
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
    rmSync(join(gitDir(), 'logs', 'refs', 'harness-relay', 'conv-1', snap), { force: true });

    // Without a link, kept as before.
    await keepCommits(repo, 'conv-1', [snap]);
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/harness-relay/')).toBe(`refs/harness-relay/conv-1/${snap}`);
  });

  it("refuses a snapshot through a linked folder of objects, and a worktree's commit that would overwrite a linked COMMIT_EDITMSG", async () => {
    await ensureRepo(repo);
    const snap = (await snapshot(repo)).commit;
    const wt = join(dir, 'wt');
    await createWorktree(repo, wt, 'relay/test', snap);
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    const objects = join(gitDir(), 'objects');
    const free = ['ff', 'fe', 'fd', 'fc'].find((n) => !existsSync(join(objects, n)))!;
    dirLink(outside, join(objects, free));
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    await expect(snapshot(repo)).rejects.toThrow(refused);
    expect(listed(outside)).toEqual([]);
    rmSync(join(objects, free), { force: true });

    // A worktree's own git folder: git commit writes the message to its COMMIT_EDITMSG.
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'keep\n');
    const admin = readdirSync(join(gitDir(), 'worktrees')).map((n) => join(gitDir(), 'worktrees', n))[0]!;
    symlinkSync(victim, join(admin, 'COMMIT_EDITMSG'));
    writeFileSync(join(wt, 'README.md'), 'in the worktree\n');
    await expect(commitWorktree(wt, 'Harness Relay')).rejects.toThrow(refused);
    expect(readFileSync(victim, 'utf8')).toBe('keep\n');
    rmSync(join(admin, 'COMMIT_EDITMSG'), { force: true });
    expect(await commitWorktree(wt, 'Harness Relay')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses a .git that is itself a link, and leaves alone what git only reads or replaces: hooks, a linked ref', async () => {
    await ensureRepo(repo);
    const snap = (await snapshot(repo)).commit;
    // What git only reads (hooks, which Harness Relay turns off) and a ref git replaces by a rename.
    const hooks = join(dir, 'hooks');
    mkdirSync(hooks);
    rmSync(join(gitDir(), 'hooks'), { recursive: true, force: true });
    dirLink(hooks, join(gitDir(), 'hooks'));
    const ref = join(dir, 'ref.txt');
    writeFileSync(ref, `${snap}\n`);
    symlinkSync(ref, join(gitDir(), 'refs', 'heads', 'linked'));
    expect(gitDirLink(gitDir())).toBeUndefined();
    await snapshot(repo);
    // A ref's link to nothing, or to a folder, is refused.
    rmSync(join(gitDir(), 'refs', 'heads', 'linked'), { force: true });
    symlinkSync(join(dir, 'nothing'), join(gitDir(), 'refs', 'heads', 'linked'));
    expect(gitDirLink(gitDir())).toBe('refs/heads/linked');
    rmSync(join(gitDir(), 'refs', 'heads', 'linked'), { force: true });
    expect(gitDirLink(gitDir())).toBeUndefined();

    // The whole .git a link: everything would be written where it points.
    const moved = join(dir, 'moved.git');
    renameSync(gitDir(), moved);
    dirLink(moved, gitDir());
    await expect(snapshot(repo)).rejects.toThrow(refused);
    expect(gitDirLink(gitDir())).toBe('.');
  });
});

describe('keepCommits', () => {
  it('keeps snapshot commits through git gc until the conversation drops them', async () => {
    await ensureRepo(repo);
    const snap = (await snapshot(repo)).commit;
    await keepCommits(repo, 'conv-1', [snap]);
    git(repo, 'gc', '-q', '--prune=now');
    expect(git(repo, 'cat-file', '-t', snap)).toBe('commit');

    await dropKeptCommits(repo, 'conv-1');
    expect(git(repo, 'for-each-ref', 'refs/harness-relay/')).toBe('');
    git(repo, 'reflog', 'expire', '--expire=now', '--all');
    git(repo, 'gc', '-q', '--prune=now');
    expect(() => git(repo, 'cat-file', '-t', snap)).toThrow();
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

  it('fetches no missing object, as the remote of a partial clone would be reached through a command the config names', async () => {
    await ensureRepo(repo);
    const first = await snapshot(repo);
    writeFileSync(join(repo, 'README.md'), 'changed\n');
    const second = await snapshot(repo);
    const ran = join(dir, 'ran.txt');
    git(repo, 'config', 'core.repositoryformatversion', '1');
    git(repo, 'config', 'extensions.partialClone', 'origin');
    git(repo, 'config', 'remote.origin.url', 'ssh://example.invalid/x.git');
    git(repo, 'config', 'remote.origin.promisor', 'true');
    git(repo, 'config', 'core.sshCommand', `sh -c 'echo ssh >> "${ran}"; exit 1' --`);
    const blob = git(repo, 'rev-parse', `${first.commit}:README.md`);
    rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    await expect(diffText(repo, first.commit, second.commit)).rejects.toThrow();
    await expect(createWorktree(repo, join(dir, 'wt'), 'relay/test', first.commit)).rejects.toThrow();
    expect(existsSync(ran)).toBe(false);
  });

  it('refuses a core.worktree that names another folder, which a snapshot would take in', async () => {
    await ensureRepo(repo);
    const outside = join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    for (const other of [outside, '../..']) {
      git(repo, 'config', 'core.worktree', other);
      await expect(snapshot(repo)).rejects.toThrow(/core\.worktree/);
    }
    // Its own folder (relative to .git) is fine.
    git(repo, 'config', 'core.worktree', '..');
    const snap = await snapshot(repo);
    expect(git(repo, 'ls-tree', '-r', '--name-only', snap.commit).split('\n')).not.toContain('secret.txt');
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
