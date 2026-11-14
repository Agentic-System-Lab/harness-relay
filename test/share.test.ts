import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { slow } from './timeouts';
import { GH_MIN_VERSION, GH_MISSING, GH_SIGNED_OUT } from '../src/shared/types';
import { t, withLang } from '../src/server/i18n';
import { DATA_DIR } from '../src/server/settings';
import { CommandNotFoundError, runProcess, type SpawnOptions, type SpawnResult } from '../src/server/process';
import {
  CREATED_JQ,
  FILES_PLACEHOLDER,
  SHARE_FILE,
  ShareError,
  clearShareTmp,
  createGistArgs,
  createGistBody,
  deleteGistArgs,
  filesGistDescription,
  findGistArgs,
  ghBin,
  ghEnv,
  GhLogin,
  GH_LOGIN_ARGS,
  gistArgs,
  gistExistsArgs,
  gistDescription,
  gistFileName,
  gistFileNames,
  gistFilesArgs,
  gistGitUrl,
  gitConfig,
  gitEnv,
  gitOwnName,
  ghTooOld,
  gistError,
  measureShareFile,
  parseCreatedGist,
  parseGhVersion,
  parseGistUrl,
  parseFoundGists,
  parseShareFileRefs,
  pushToGist,
  rawUrl,
  readAtMost,
  readShareFile,
  readShareFiles,
  shareToGist,
  shareToken,
  shareTmpRoot,
  shellWord,
  unshareGist,
  validGistId,
  type FoundShareFile,
  type GistUpload,
} from '../src/server/share';
import { shareFileHref } from '../src/shared/share';
import { SHARE_FILE_LINKS_MAX, SHARE_FILE_MAX_BYTES, SHARE_MAX_BYTES } from '../src/shared/types';

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function result(o: Partial<SpawnResult> = {}): SpawnResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stdoutBytes: Buffer.alloc(0),
    stdoutTruncated: false,
    stdoutSize: 0,
    stderr: '',
    aborted: false,
    timedOut: false,
    ...o,
  };
}

describe('the gist a shared conversation goes into', () => {
  it('is a secret gist of one index.html, read from stdin', () => {
    const args = gistArgs('Plan · Harness Relay');
    expect(args).toEqual(['gist', 'create', '--filename', SHARE_FILE, '--desc', 'Plan · Harness Relay', '-']);
    expect(args).not.toContain('--public');
    expect(SHARE_FILE).toBe('index.html'); // what gistpreview shows first
  });

  it('is described by the conversation title, on one line', () => {
    expect(gistDescription('  Refactor\n the  store ')).toBe('Refactor the store · Harness Relay');
    expect(gistDescription('   ')).toBe('Harness Relay');
  });

  it('gives a gistpreview link for a github.com gist', () => {
    expect(parseGistUrl(`https://gist.github.com/someone/${ID}\n`)).toEqual({
      id: ID,
      url: `https://gistpreview.github.io/?${ID}`,
      gistUrl: `https://gist.github.com/someone/${ID}`,
    });
    expect(parseGistUrl(`- Creating gist index.html\n✓ Created secret gist index.html\nhttps://gist.github.com/${ID}`)?.url).toBe(
      `https://gistpreview.github.io/?${ID}`,
    );
  });

  it('gives no link for a gist gistpreview cannot read', () => {
    expect(parseGistUrl(`https://github.example.com/gist/someone/${ID}`)).toBeUndefined();
    expect(parseGistUrl('')).toBeUndefined();
  });
});

describe('shareToGist', () => {
  it('sends the page to gh on stdin and returns the links', async () => {
    let seen: SpawnOptions | undefined;
    const link = await shareToGist('<!doctype html>…', 'Chat · Harness Relay', async (o) => {
      seen = o;
      return result({ stdout: `https://gist.github.com/me/${ID}\n` });
    });
    // `gh.exe` where Windows has it installed.
    expect(seen?.bin).toMatch(/(^|[\\/])gh(\.exe)?$/i);
    expect(seen?.args).toEqual(gistArgs('Chat · Harness Relay'));
    expect(seen?.stdin).toBe('<!doctype html>…');
    expect(link).toEqual({ id: ID, url: `https://gistpreview.github.io/?${ID}`, gistUrl: `https://gist.github.com/me/${ID}` });
  });

  it("leaves out a GitHub codespace's own token, which GitHub refuses a gist, for the sign-in gh keeps", async () => {
    let seen: SpawnOptions | undefined;
    const run = async (o: SpawnOptions) => {
      seen = o;
      return result({ stdout: `https://gist.github.com/me/${ID}\n` });
    };
    vi.stubEnv('GITHUB_TOKEN', 'ghu_codespace');
    vi.stubEnv('GH_TOKEN', 'github_pat_mine');
    try {
      vi.stubEnv('CODESPACES', 'true');
      await shareToGist('x', 'd', run);
      expect(seen?.env?.GITHUB_TOKEN).toBeUndefined();
      // A token of the user's own, which gh takes first, stays.
      expect(seen?.env?.GH_TOKEN).toBe('github_pat_mine');
      // Anywhere else, the shell's GITHUB_TOKEN is how gh may be signed in: it stays.
      vi.stubEnv('CODESPACES', '');
      await shareToGist('x', 'd', run);
      expect(seen?.env?.GITHUB_TOKEN).toBe('ghu_codespace');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(ghEnv({ CODESPACES: 'true', GITHUB_TOKEN: 'ghu_x', PATH: '/bin' })).toEqual({ CODESPACES: 'true', PATH: '/bin' });
    expect(ghEnv({ GITHUB_TOKEN: 'ghp_x' })).toEqual({ GITHUB_TOKEN: 'ghp_x' });
  });

  it('says how to install gh when it is missing, with a code the UI explains', async () => {
    const run = async (): Promise<SpawnResult> => {
      throw new CommandNotFoundError('gh');
    };
    await expect(shareToGist('x', 'd', run)).rejects.toThrow(new ShareError(t().shareNoGh(GH_MIN_VERSION), GH_MISSING));
    await expect(shareToGist('x', 'd', run)).rejects.toMatchObject({ code: GH_MISSING });
  });

  it('says how to sign in when gh is not signed in, with a code the UI explains', async () => {
    const run = async () => result({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' });
    await expect(shareToGist('x', 'd', run)).rejects.toThrow(t().shareSignedOut);
    await expect(shareToGist('x', 'd', run)).rejects.toMatchObject({ code: GH_SIGNED_OUT });
  });

  it("passes on gh's own reason, or that it gave no link", async () => {
    const failed = async () => result({ code: 1, stderr: 'HTTP 422: Validation Failed\ncontents are too large\n' });
    await expect(shareToGist('x', 'd', failed)).rejects.toThrow(t().shareFailed('contents are too large'));
    await expect(shareToGist('x', 'd', failed)).rejects.toMatchObject({ code: undefined });
    const noLink = async () => result({ stdout: 'done\n' });
    await expect(shareToGist('x', 'd', noLink)).rejects.toThrow(t().shareFailed(t().shareNoUrl));
  });

  it('says when gh took too long', () => {
    expect(gistError({ stderr: '', timedOut: true })).toBe(t().shareFailed(t().timedOut));
    expect(gistError({ stderr: '', timedOut: false })).toBe(t().shareFailed(t().shareNoDetail));
  });
});

describe.skipIf(process.platform === 'win32')("signing gh in from the share dialog (a stand-in gh started by its #! line)", { timeout: slow(20_000) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-gh-login-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const said = join(dir, 'said');
  // What gh prints without a terminal: its code and GitHub's device page; then it waits for approval.
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh\necho "$* | token=\${GITHUB_TOKEN:-none} | pid=$$" >> "${said}"\n` +
      'echo "! First copy your one-time code: ABCD-1234"\n' +
      'echo "Open this URL to continue in your web browser: https://github.com/login/device"\n' +
      '[ -n "$GH_WAIT" ] && sleep 30\n' +
      'echo "✓ Logged in as octocat" >&2\n',
    { mode: 0o755 },
  );
  const env = (more: NodeJS.ProcessEnv = {}) => ({ PATH: `${dir}:${process.env.PATH}`, ...more });

  const lastSaid = () => readFileSync(said, 'utf8').trim().split('\n').at(-1)!;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("runs gh's device sign-in for github.com, without a codespace's own token, and shows its code and page", async () => {
    const login = new GhLogin();
    expect(login.view()).toBeNull();
    // The server's own environment, as the route passes it: GhLogin leaves the codespace's token out itself.
    login.start(env({ CODESPACES: 'true', GITHUB_TOKEN: 'ghu_codespace' }));
    await vi.waitFor(() => expect(login.view()?.state).toBe('success'));
    expect(login.view()).toMatchObject({ codes: ['ABCD-1234'], urls: ['https://github.com/login/device'], exitCode: 0 });
    expect(GH_LOGIN_ARGS).toEqual(['auth', 'login', '--web', '--hostname', 'github.com']);
    expect(lastSaid()).toMatch(/^auth login --web --hostname github\.com \| token=none \| pid=\d+$/);
  });

  it("refuses to start while a token gh would sign in with instead is set, saying which", () => {
    const login = new GhLogin();
    expect(() => login.start(env({ GH_TOKEN: 'github_pat_old' }))).toThrow(t().ghLoginTokenSet('GH_TOKEN'));
    expect(() => login.start(env({ GITHUB_TOKEN: 'ghp_old' }))).toThrow(t().ghLoginTokenSet('GITHUB_TOKEN'));
    expect(() => login.start(env({ GITHUB_TOKEN: 'ghp_old' }))).toThrow(expect.objectContaining({ status: 409 }));
    expect(login.view()).toBeNull();
  });

  it('stops a sign-in that waits when asked, and a new one stops the one before, process and all', async () => {
    const login = new GhLogin();
    login.start(env({ GH_WAIT: '1' }));
    await vi.waitFor(() => expect(login.view()?.codes).toEqual(['ABCD-1234']));
    expect(login.view()?.state).toBe('running');
    login.cancel();
    expect(login.view()?.state).toBe('cancelled');

    const first = login.start(env({ GH_WAIT: '1' }));
    await vi.waitFor(() => expect(login.view()?.codes).toEqual(['ABCD-1234']));
    const firstPid = Number(lastSaid().split('pid=')[1]);
    expect(alive(firstPid)).toBe(true);
    const second = login.start(env({ GH_WAIT: '1' }));
    expect(second.id).not.toBe(first.id);
    expect(login.view()?.id).toBe(second.id);
    await vi.waitFor(() => expect(alive(firstPid)).toBe(false));
    login.cancel();
  });
});

describe('unshareGist', () => {
  it('deletes the gist without asking', async () => {
    let seen: SpawnOptions | undefined;
    await unshareGist(ID, async (o) => {
      seen = o;
      return result();
    });
    expect(seen?.args).toEqual(['gist', 'delete', ID, '--yes']);
    expect(deleteGistArgs(ID)).toEqual(seen?.args);
    expect(seen?.stdin).toBeUndefined();
  });

  // What gh 2.88 says for a gist it cannot find, and for one of another account alike.
  const notFound = `unable to delete gist "${ID}": either the gist is not found or it is not owned by you\n`;

  it('counts a gist GitHub cannot find either as deleted', async () => {
    const calls: string[][] = [];
    const run = async (o: SpawnOptions) => {
      calls.push(o.args);
      return calls.length === 1 ? result({ code: 1, stderr: notFound }) : result({ code: 1, stderr: 'gh: Not Found (HTTP 404)\n' });
    };
    await expect(unshareGist(ID, run)).resolves.toBeUndefined();
    expect(calls).toEqual([deleteGistArgs(ID), gistExistsArgs(ID)]);
    expect(gistExistsArgs(ID)).toEqual(['api', `gists/${ID}`, '--silent']);
  });

  it("keeps a gist of another account: it is still online", async () => {
    let n = 0;
    const run = async () => (++n === 1 ? result({ code: 1, stderr: notFound }) : result());
    await expect(unshareGist(ID, run)).rejects.toMatchObject({ message: t().unshareNotOwner });
  });

  it('says why it could not', async () => {
    await expect(unshareGist(ID, async () => result({ code: 1, stderr: 'HTTP 500: oops\n' }))).rejects.toThrow(t().unshareFailed('HTTP 500: oops'));
    await expect(unshareGist(ID, async () => result({ code: 4, stderr: 'please run:  gh auth login' }))).rejects.toMatchObject({
      message: t().shareSignedOut,
      code: GH_SIGNED_OUT,
    });
    const missing = async (): Promise<SpawnResult> => {
      throw new CommandNotFoundError('gh');
    };
    await expect(unshareGist(ID, missing)).rejects.toMatchObject({ message: t().shareNoGh(GH_MIN_VERSION), code: GH_MISSING });
    expect(t().shareNoGh(GH_MIN_VERSION)).toContain('2.66.0');
  });

  // What a gh before 2.66.0 says: it has no --yes for gist delete.
  const oldGh = 'unknown flag: --yes\n\nUsage:  gh gist delete {<id> | <url>} [flags]\n\n';

  it('says which gh it needs, and which one is there, when gh is too old', async () => {
    const calls: string[][] = [];
    const run = async (o: SpawnOptions) => {
      calls.push(o.args);
      return o.args[0] === '--version'
        ? result({ stdout: 'gh version 2.40.1 (2023-12-13)\nhttps://github.com/cli/cli/releases/tag/v2.40.1\n' })
        : result({ code: 1, stderr: oldGh });
    };
    await expect(unshareGist(ID, run)).rejects.toMatchObject({ message: t().ghTooOld(GH_MIN_VERSION, '2.40.1') });
    expect(calls).toEqual([deleteGistArgs(ID), ['--version']]);
    expect(t().ghTooOld(GH_MIN_VERSION, '2.40.1')).toMatch(/2\.40\.1.*2\.66\.0/);
    expect(withLang('en', () => t().ghTooOld(GH_MIN_VERSION, '2.40.1'))).toMatch(/2\.40\.1.*2\.66\.0/);
  });

  it('still says which gh it needs when gh does not say its version', async () => {
    const run = async (o: SpawnOptions) => (o.args[0] === '--version' ? result({ code: 1 }) : result({ code: 1, stderr: oldGh }));
    await expect(unshareGist(ID, run)).rejects.toMatchObject({ message: t().ghTooOld(GH_MIN_VERSION) });
    expect(t().ghTooOld(GH_MIN_VERSION)).toContain('2.66.0');
    expect(ghTooOld(oldGh)).toBe(true);
    expect(ghTooOld('HTTP 500: oops')).toBe(false);
    expect(parseGhVersion('gh version 2.88.1 (2026-03-12)\n')).toBe('2.88.1');
    expect(parseGhVersion('')).toBeUndefined();
  });

  it('looks for gh where Homebrew puts it too, and otherwise lets the PATH find it', () => {
    expect(ghBin({ PATH: '' }, 'win32')).toBe('gh');
    expect(ghBin({ PATH: '/usr/bin:/bin' }, 'darwin', (p) => p === '/opt/homebrew/bin/gh')).toBe('/opt/homebrew/bin/gh');
    expect(ghBin({ PATH: '/usr/bin:/bin' }, 'darwin', (p) => p === '/usr/bin/gh' || p === '/opt/homebrew/bin/gh')).toBe('/usr/bin/gh');
    expect(ghBin({ PATH: '/usr/bin' }, 'linux', () => false)).toBe('gh');
  });

  it('takes only a gist id', () => {
    expect(validGistId(ID)).toBe(true);
    expect(validGistId('--help')).toBe(false);
    expect(validGistId('abc')).toBe(false);
  });
});

describe('the files a shared page takes along', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-share-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  /** Where the temporary clones go in these tests (the server's own data folder otherwise). */
  const tmpRoot = join(dir, 'tmp');
  const FILES_ID = 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
  const TOKEN = 'relay-0123456789abcdef';
  const OWNER = 'someone';
  const raw = (name: string) =>
    `https://gist.githubusercontent.com/${OWNER}/${FILES_ID}/raw/0123456789abcdef0123456789abcdef01234567/${encodeURIComponent(name)}`;
  /** What `gh api … --jq CREATED_JQ` prints for a files gist of these files. */
  const created = (names: string[], o: { id?: string; html?: string; url?: (name: string) => string } = {}) =>
    JSON.stringify({
      id: o.id ?? FILES_ID,
      html_url: o.html ?? `https://gist.github.com/${o.id ?? FILES_ID}`,
      files: names.map((filename) => ({ filename, raw_url: (o.url ?? raw)(filename) })),
    }) + '\n';
  const page = `<!doctype html><a class="file-link" href="${shareFileHref(0)}">report</a> <a class="file-link" href="${shareFileHref(1)}">data</a> <a class="file-link" href="${shareFileHref(0)}">again</a>`;
  const files: GistUpload[] = [
    { name: 'report.pdf', data: Buffer.from('%PDF-1.7\n\x00\x01\xff binary\r\n') },
    { name: 'Q3 & 報告.csv', data: Buffer.from('a,b\n1,2\n') },
  ];
  const pageLink = { id: ID, url: `https://gistpreview.github.io/?${ID}`, gistUrl: `https://gist.github.com/me/${ID}` };

  /** The git command `args` runs (past the `-c` settings and `--git-dir`). */
  function gitCommand(args: string[]): string {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '--git-dir') i++;
      else return args[i]!;
    }
    return '';
  }
  const oid = (n: number) => n.toString(16).padStart(40, '0');
  /** A git that does what it is asked, without a repository: object ids made up, every push taken. */
  const fakeGit = (o: SpawnOptions): SpawnResult => {
    const said: Record<string, string> = { 'symbolic-ref': 'refs/heads/main\n', 'hash-object': `${oid(1)}\n`, mktree: `${oid(2)}\n`, 'commit-tree': `${oid(3)}\n` };
    return result({ stdout: said[gitCommand(o.args)] ?? '' });
  };

  /**
   * A fake gh and git: gh's calls answered in turn by `answers`, git's by `git`; every call recorded.
   * `args()`: gh's calls only, `git()`: the git commands run, in order.
   */
  function fakeGh(answers: ((o: SpawnOptions) => SpawnResult | Promise<SpawnResult>)[], git: (o: SpawnOptions) => SpawnResult | Promise<SpawnResult> = fakeGit) {
    const calls: SpawnOptions[] = [];
    let n = 0;
    const run = async (o: SpawnOptions) => {
      calls.push(o);
      if (o.bin === 'git') return git(o);
      const answer = answers[n++];
      if (!answer) throw new Error(`unexpected gh ${o.args.join(' ')}`);
      return answer(o);
    };
    const ghCalls = () => calls.filter((c) => c.bin !== 'git');
    const gitCalls = () => calls.filter((c) => c.bin === 'git');
    return { run, calls, ghCalls, gitCalls, args: () => ghCalls().map((c) => c.args), git: () => gitCalls().map((c) => gitCommand(c.args)) };
  }
  const ok = (stdout = '') => () => result({ stdout });
  const fail = (stderr: string, o: Partial<SpawnResult> = {}) => () => result({ code: 1, stderr, ...o });
  const missing = () => {
    throw new CommandNotFoundError('gh');
  };
  /** gh's answer when it made the files gist (with its placeholder), and when it reads the gist back. */
  const made = ok(created([FILES_PLACEHOLDER]));
  const listed = (names = files.map((f) => f.name)) => ok(created(names));
  const noWait = async () => {};
  const opts = { token: TOKEN, wait: noWait, tmpRoot };
  /** Every git command one share runs, in order: two files. */
  const PUSHED = ['clone', 'symbolic-ref', 'hash-object', 'hash-object', 'mktree', 'commit-tree', 'push'];

  it('puts the files in a secret gist of their own, pushed with git, then the page in another, its links at the files', async () => {
    const gh = fakeGh([made, listed(), ok(`https://gist.github.com/me/${ID}\n`)]);
    const link = await shareToGist(page, 'Chat · Harness Relay', gh.run, files, opts);
    expect(link).toEqual({ ...pageLink, filesGist: FILES_ID });
    expect(gh.args()).toEqual([createGistArgs(), gistFilesArgs(FILES_ID), gistArgs('Chat · Harness Relay')]);
    expect(createGistArgs()).toEqual(['api', 'gists', '--method', 'POST', '--input', '-', '--jq', CREATED_JQ]);
    expect(gistFilesArgs(FILES_ID)).toEqual(['api', `gists/${FILES_ID}`, '--jq', CREATED_JQ]);
    // A gist nobody can find without its address, marked with the share's token, made with a placeholder only.
    expect(JSON.parse(String(gh.calls[0]!.stdin))).toEqual({
      description: `Chat · Harness Relay · files · ${TOKEN}`,
      public: false,
      files: { [FILES_PLACEHOLDER]: { content: expect.stringMatching(/\S/) } },
    });
    expect(String(gh.calls[0]!.stdin)).toBe(createGistBody(filesGistDescription('Chat · Harness Relay', TOKEN)));
    // The files go up with git, their bytes as they are.
    expect(gh.git()).toEqual(PUSHED);
    expect(gh.gitCalls().filter((c) => gitCommand(c.args) === 'hash-object').map((c) => c.stdin)).toEqual(files.map((f) => f.data));
    // The page alone in its gist, as a share without files is made: gistpreview reads nothing else first.
    expect(gh.ghCalls()[2]!.stdin).toBe(
      `<!doctype html><a class="file-link" href="${raw('report.pdf')}">report</a> <a class="file-link" href="${raw('Q3 & 報告.csv')}">data</a> <a class="file-link" href="${raw('report.pdf')}">again</a>`,
    );
  });

  it('tells of the files gist as soon as it is made, before anything goes into it, as it would be left', async () => {
    const told: { gist: unknown; git: number }[] = [];
    const gh = fakeGh([made, listed(), ok(`https://gist.github.com/me/${ID}\n`)]);
    await shareToGist(page, 'd', gh.run, files, { ...opts, onFilesGist: (gist) => told.push({ gist, git: gh.gitCalls().length }) });
    expect(told).toEqual([{ gist: { id: FILES_ID, url: '', gistUrl: `https://gist.github.com/${FILES_ID}` }, git: 0 }]);
    // Not when no files gist was made, nor for a share without files.
    const none: unknown[] = [];
    await shareToGist(page, 'd', fakeGh([fail('HTTP 422')]).run, files, { ...opts, onFilesGist: (g) => none.push(g) }).catch(() => {});
    await shareToGist(page, 'd', fakeGh([ok(`https://gist.github.com/me/${ID}\n`)]).run, [], { ...opts, onFilesGist: (g) => none.push(g) });
    expect(none).toEqual([]);
  });

  it('clones the gist bare, signed in by gh alone, and pushes one commit of the files, without hooks or prompts', async () => {
    const gh = fakeGh([made, listed(), ok(`https://gist.github.com/me/${ID}\n`)]);
    await shareToGist(page, 'd', gh.run, files, opts);
    const [clone, ...rest] = gh.gitCalls();
    const config = gitConfig(ghBin());
    expect(clone!.args.slice(0, config.length)).toEqual(config);
    expect(clone!.args.slice(config.length, -1)).toEqual(['clone', '--bare', '--quiet', '--template=', gistGitUrl(FILES_ID)]);
    const repo = clone!.args.at(-1)!;
    for (const c of rest) expect(c.args.slice(0, config.length + 2)).toEqual([...config, '--git-dir', repo]);
    const at = config.length + 2;
    expect(rest.map((c) => c.args.slice(at))).toEqual([
      ['symbolic-ref', 'HEAD'],
      ['hash-object', '-w', '--no-filters', '--stdin'],
      ['hash-object', '-w', '--no-filters', '--stdin'],
      ['mktree', '-z'],
      ['commit-tree', oid(2), '-p', 'HEAD', '-m', 'Files shared with a Harness Relay page'],
      // To the gist's own address, not a remote the clone's configuration names.
      ['push', '--quiet', '--no-verify', gistGitUrl(FILES_ID), `${oid(3)}:refs/heads/main`],
    ]);
    // The tree names each file as the gist has it.
    expect(rest[3]!.stdin).toBe(files.map((f) => `100644 blob ${oid(1)}\t${f.name}\0`).join(''));
    // The temporary clone, in a folder of its own where it was told to go, is gone again.
    expect(join(repo, '..', '..')).toBe(tmpRoot);
    expect(existsSync(repo)).toBe(false);
    expect(existsSync(join(repo, '..'))).toBe(false);
    // git never asks for a password, reaches remotes only over HTTPS, and never works on a repository
    // from the server's environment.
    for (const c of gh.gitCalls()) {
      expect(c.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_ALLOW_PROTOCOL: 'https', GIT_AUTHOR_NAME: 'Harness Relay' });
      expect(c.env.GIT_DIR).toBeUndefined();
    }
    expect(gistGitUrl(FILES_ID)).toBe(`https://gist.github.com/${FILES_ID}.git`);
    expect(() => gistGitUrl('--upload-pack=x')).toThrow();
    expect(() => gistFilesArgs('../x')).toThrow();
  });

  it("makes its clones in Harness Relay's own data folder, never the system's temporary folder", () => {
    expect(shareTmpRoot()).toBe(join(DATA_DIR, 'tmp'));
    expect(shareTmpRoot().startsWith(tmpdir())).toBe(false);
  });

  it('signs git in through gh, and in no other way', () => {
    expect(gitConfig('/opt/homebrew/bin/gh')).toEqual([
      '-c',
      'credential.helper=',
      '-c',
      "credential.helper=!'/opt/homebrew/bin/gh' auth git-credential",
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'push.gpgSign=false',
    ]);
    // A path sh would split or expand stays one word.
    expect(shellWord("C:\\Program Files\\GitHub CLI\\gh.exe")).toBe("'C:\\Program Files\\GitHub CLI\\gh.exe'");
    expect(shellWord("/it's/$HOME/gh")).toBe("'/it'\\''s/$HOME/gh'");
    const env = gitEnv({ PATH: '/bin', GIT_DIR: '/x/.git', GIT_WORK_TREE: '/x', GIT_INDEX_FILE: 'i', GIT_OBJECT_DIRECTORY: 'o', GIT_ASKPASS: '/askpass', HTTPS_PROXY: 'http://proxy' });
    expect(env).toMatchObject({ PATH: '/bin', HTTPS_PROXY: 'http://proxy', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' });
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) expect(env[k], k).toBeUndefined();
    // gh signs git in (`gh auth git-credential`), so git runs without a codespace's token as gh does.
    expect(gitEnv({ CODESPACES: 'true', GITHUB_TOKEN: 'ghu_x' }).GITHUB_TOKEN).toBeUndefined();
    expect(gitEnv({ GITHUB_TOKEN: 'ghp_x' }).GITHUB_TOKEN).toBe('ghp_x');
  });

  /** git as the tests run it for real: on the test's repositories, a local folder allowed as a remote. */
  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      env: { ...gitEnv(), GIT_ALLOW_PROTOCOL: 'file' },
      encoding: 'utf8',
    }).trim();
  /** A bare repository standing in for the gist on GitHub, as `gh api` makes it: one commit of the placeholder. */
  function gistStandIn(name: string): string {
    const remote = join(dir, `${name}.git`);
    const work = join(dir, `${name}-work`);
    g(dir, 'init', '--quiet', '-b', 'main', work);
    writeFileSync(join(work, FILES_PLACEHOLDER), 'placeholder\n');
    g(work, 'add', FILES_PLACEHOLDER);
    g(work, 'commit', '--quiet', '-m', 'placeholder');
    g(dir, 'clone', '--bare', '--quiet', work, remote);
    return remote;
  }
  /** Real git, the gist's address pointing at the stand-in (a local folder, which git is then allowed to reach). */
  const standIn =
    (remote: string, after?: (o: SpawnOptions) => void) =>
    async (o: SpawnOptions): Promise<SpawnResult> => {
      const r = await runProcess({
        ...o,
        args: o.args.map((a) => (a === gistGitUrl(FILES_ID) ? remote : a)),
        env: { ...o.env, GIT_ALLOW_PROTOCOL: 'file' },
      });
      after?.(o);
      return r;
    };

  it('pushes each file byte for byte into a real repository, the placeholder gone', async () => {
    const remote = gistStandIn('gist-remote');
    const before = g(remote, 'rev-parse', 'main');

    const upload: GistUpload[] = [
      ...files,
      { name: 'slides "v2" — final.pptx', data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff, 0x0d, 0x0a]) },
      { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: '-rf', data: Buffer.from('not an option\n') },
      { name: 'notes (Windows).txt', data: Buffer.from('line one\r\nline two\r\n') },
    ];
    // Also when the user's git converts line endings, as Git for Windows does by default (this sets
    // core.autocrlf=true above any config file): the blobs are written with --no-filters.
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true' });
    try {
      await pushToGist(FILES_ID, upload, standIn(remote), tmpRoot);
    } finally {
      for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete process.env[k];
      Object.assign(process.env, saved);
    }

    expect(g(remote, 'rev-parse', 'main^')).toBe(before); // on top of the placeholder's commit
    const names = g(remote, 'ls-tree', '-z', '--name-only', 'main').split('\0').filter(Boolean);
    expect(names.sort()).toEqual(upload.map((f) => f.name).sort());
    for (const f of upload) {
      const held = execFileSync('git', ['--git-dir', remote, 'cat-file', 'blob', `main:${f.name}`], { env: gitEnv() });
      expect(Buffer.compare(held, f.data), f.name).toBe(0);
    }
    expect(g(remote, 'log', '-1', '--format=%an <%ae>', 'main')).toBe('Harness Relay <harness-relay@localhost>');
  });

  it("runs nothing a changed configuration of the clone asks for, and reaches GitHub only over HTTPS", async () => {
    const remote = gistStandIn('gist-tampered');
    const before = g(remote, 'rev-parse', 'main');
    const ran = join(dir, 'tampered-ran');
    // Paths in a config file with `/` (also on Windows): it reads `\` as an escape.
    const touch = `touch '${ran.replaceAll('\\', '/')}'`;
    // What an agent that could write to the clone (it cannot: it is in Harness Relay's own folder)
    // might add to its configuration right after it is made: a remote by the gist's own address, or
    // by `origin`, that runs a command; or the gist's address rewritten to ssh with a command of its own.
    const tampered = [
      [`[remote "${gistGitUrl(FILES_ID)}"]\n\turl = ${remote.replaceAll('\\', '/')}\n\treceivepack = ${touch}\n[remote "origin"]\n\treceivepack = ${touch}\n`, /'?file'? not allowed/i],
      [`[url "ssh://evil.invalid/"]\n\tinsteadOf = ${gistGitUrl(FILES_ID)}\n[core]\n\tsshCommand = ${touch}\n`, /'?ssh'? not allowed/i],
    ] as const;
    for (const [added, refused] of tampered) {
      const tamper = (o: SpawnOptions) => {
        if (gitCommand(o.args) !== 'clone') return;
        const config = join(o.args.at(-1)!, 'config');
        writeFileSync(config, readFileSync(config, 'utf8') + added);
      };
      // As the server runs git: only HTTPS for the push (the stand-in is reached once, to clone it).
      const run = async (o: SpawnOptions) => (gitCommand(o.args) === 'clone' ? standIn(remote, tamper)(o) : runProcess(o));
      const err = await pushToGist(FILES_ID, files, run, tmpRoot).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShareError);
      expect((err as Error).message).toMatch(refused);
      expect(existsSync(ran)).toBe(false);
      expect(g(remote, 'rev-parse', 'main')).toBe(before); // nothing went anywhere
    }
  });

  it('clears the temporary clones a stopped server left behind, and nothing else', async () => {
    const root = join(dir, 'leftovers');
    await clearShareTmp(root); // none yet: nothing to do
    mkdirSync(join(root, 'share-abc123', 'objects'), { recursive: true });
    writeFileSync(join(root, 'share-abc123', 'objects', 'pack'), 'x');
    mkdirSync(join(root, 'other'));
    await clearShareTmp(root);
    expect(existsSync(join(root, 'share-abc123'))).toBe(false);
    expect(existsSync(join(root, 'other'))).toBe(true);
  });

  it('makes no gist for names gistFileNames would not make', async () => {
    const gh = fakeGh([]);
    await expect(shareToGist(page, 'd', gh.run, [{ name: 'a/b', data: Buffer.alloc(1) }], opts)).rejects.toThrow(/not a name/);
    expect(gh.calls).toEqual([]);
  });

  it('takes only names gistFileNames makes, before anything runs', async () => {
    for (const bad of [[{ name: 'a/b', data: Buffer.alloc(1) }], [{ name: 'a\0b', data: Buffer.alloc(1) }], [{ name: FILES_PLACEHOLDER, data: Buffer.alloc(1) }],
      [{ name: '.gitmodules', data: Buffer.alloc(1) }], [{ name: 'x.md', data: Buffer.alloc(1) }, { name: 'X.md', data: Buffer.alloc(1) }]]) {
      const gh = fakeGh([]);
      await expect(pushToGist(FILES_ID, bad, gh.run, tmpRoot), JSON.stringify(bad.map((f) => f.name))).rejects.toThrow(/not a name/);
      expect(gh.calls).toEqual([]);
    }
  });

  it('marks each share with a token of its own', () => {
    expect(shareToken()).toMatch(/^relay-[0-9a-f]{16}$/);
    expect(shareToken()).not.toBe(shareToken());
    expect(findGistArgs(TOKEN)).toEqual(['api', 'gists?per_page=100', '--jq', `.[] | select((.description // "") | contains("${TOKEN}")) | "\\(.id) \\(.html_url)"`]);
    expect(() => findGistArgs('x") | .[] | ("')).toThrow();
    expect(parseFoundGists(`${FILES_ID} https://gist.github.com/${FILES_ID}\n--help x\n\n`)).toEqual([{ id: FILES_ID, url: `https://gist.github.com/${FILES_ID}` }]);
  });

  it('prints only the ids and addresses of what gh created, not the files sent back', () => {
    expect(CREATED_JQ).toContain('.raw_url');
    expect(CREATED_JQ).not.toContain('content');
    expect(parseCreatedGist(created(['a.md']))).toEqual({
      id: FILES_ID,
      link: { id: FILES_ID, url: `https://gistpreview.github.io/?${FILES_ID}`, gistUrl: `https://gist.github.com/${FILES_ID}` },
      htmlUrl: `https://gist.github.com/${FILES_ID}`,
      raw: new Map([['a.md', raw('a.md')]]),
    });
    // Only github.com raw addresses: a link on the page goes nowhere else.
    expect(parseCreatedGist(created(['a.md'], { url: () => 'https://evil.example/a.md' })).raw.size).toBe(0);
    expect(parseCreatedGist(JSON.stringify({ id: FILES_ID, html_url: 'https://github.example.com/gist/x' }))).toEqual({
      id: FILES_ID,
      link: undefined,
      htmlUrl: 'https://github.example.com/gist/x',
      raw: new Map(),
    });
    expect(parseCreatedGist('not json')).toEqual({ raw: new Map() });
    expect(parseCreatedGist('null')).toEqual({ raw: new Map() });
    expect(parseCreatedGist(JSON.stringify({ id: '--help' })).id).toBeUndefined();
  });

  it('takes a raw URL GitHub left a space in, made well-formed', () => {
    const spaced = `https://gist.githubusercontent.com/${OWNER}/${FILES_ID}/raw/abc/my notes (v2).md`;
    expect(rawUrl(spaced)).toBe(`https://gist.githubusercontent.com/${OWNER}/${FILES_ID}/raw/abc/my%20notes%20(v2).md`);
    expect(rawUrl('https://gist.githubusercontent.com.evil.example/x')).toBeUndefined();
    expect(rawUrl('http://gist.githubusercontent.com/x')).toBeUndefined();
    expect(rawUrl('not a url')).toBeUndefined();
    const parsed = parseCreatedGist(created(['my notes (v2).md'], { url: () => spaced }));
    expect(parsed.raw.get('my notes (v2).md')).toBe(rawUrl(spaced));
  });

  it('makes nothing more when the files gist could not be made, and says why', async () => {
    const refused = fakeGh([fail('gh: Validation Failed (HTTP 422)\n')]);
    await expect(shareToGist(page, 'd', refused.run, files, opts)).rejects.toThrow(t().shareFailed('gh: Validation Failed (HTTP 422)'));
    expect(refused.args()).toEqual([createGistArgs()]);
    expect(refused.git()).toEqual([]);
    const signedOut = fakeGh([fail('please run:  gh auth login')]);
    await expect(shareToGist(page, 'd', signedOut.run, files, opts)).rejects.toMatchObject({ code: GH_SIGNED_OUT });
    const absent = fakeGh([missing]);
    await expect(shareToGist(page, 'd', absent.run, files, opts)).rejects.toMatchObject({ code: GH_MISSING });
  });

  it('looks for the files gist by its token when gh timed out or printed nothing to go on, and deletes it', async () => {
    for (const first of [() => result({ code: null, timedOut: true }), ok(''), ok('garbage')]) {
      const gh = fakeGh([first, ok(`${FILES_ID} https://gist.github.com/${FILES_ID}\n`), ok()]);
      const err = (await shareToGist(page, 'd', gh.run, files, opts).catch((e: unknown) => e)) as ShareError;
      expect(err).toBeInstanceOf(ShareError);
      expect(err.leftover).toBeUndefined();
      expect(err.message).toMatch(/deleted again|一併刪除/);
      expect(gh.args()).toEqual([createGistArgs(), findGistArgs(TOKEN), deleteGistArgs(FILES_ID)]);
      expect(gh.git()).toEqual([]);
    }
    // None was made: the reason, and nothing to delete.
    const none = fakeGh([() => result({ code: null, timedOut: true }), ok('')]);
    await expect(shareToGist(page, 'd', none.run, files, opts)).rejects.toThrow(t().shareFailed(t().timedOut));
    expect(none.args()).toEqual([createGistArgs(), findGistArgs(TOKEN)]);
  });

  it('lists the lost files gist when it cannot be deleted, and names the token when it cannot be looked for', async () => {
    const stuck = fakeGh([ok(''), ok(`${FILES_ID} https://gist.github.com/${FILES_ID}\n`), fail('HTTP 500')]);
    const err = (await shareToGist(page, 'd', stuck.run, files, opts).catch((e: unknown) => e)) as ShareError;
    expect(err.message).toBe(t().shareFilesLeftover(t().shareFailed(t().shareNoUrl)));
    expect(err.leftover).toEqual({ id: FILES_ID, url: '', gistUrl: `https://gist.github.com/${FILES_ID}` });
    const blind = fakeGh([() => result({ code: null, timedOut: true }), fail('HTTP 502')]);
    const unknown = (await shareToGist(page, 'd', blind.run, files, opts).catch((e: unknown) => e)) as ShareError;
    expect(unknown.message).toBe(t().shareFilesUnknown(t().shareFailed(t().timedOut), TOKEN));
    expect(unknown.message).toContain(TOKEN);
    expect(unknown.leftover).toBeUndefined();
  });

  it('deletes the files gist again when git could not push the files, saying why', async () => {
    const rejected = "remote: error: File big.bin is 120.00 MB; this exceeds GitHub's file size limit of 100.00 MB\nerror: failed to push some refs\n";
    for (const [git, reason] of [
      [(o: SpawnOptions) => (gitCommand(o.args) === 'push' ? result({ code: 1, stderr: rejected }) : fakeGit(o)), t().shareFilesFailed(rejected.trim())],
      [(o: SpawnOptions) => (gitCommand(o.args) === 'push' ? result({ code: null, timedOut: true }) : fakeGit(o)), t().shareFilesFailed(t().timedOut)],
      [(o: SpawnOptions) => (gitCommand(o.args) === 'clone' ? result({ code: 128, stderr: 'fatal: could not read Username: terminal prompts disabled\n' }) : fakeGit(o)),
        t().shareFilesFailed('fatal: could not read Username: terminal prompts disabled')],
      [(o: SpawnOptions) => (gitCommand(o.args) === 'mktree' ? result({ stdout: 'not an id\n' }) : fakeGit(o)), t().shareFilesFailed('not an id')],
      [(o: SpawnOptions) => (gitCommand(o.args) === 'symbolic-ref' ? result({ stdout: 'refs/tags/x;rm\n' }) : fakeGit(o)), t().shareFilesFailed('refs/tags/x;rm')],
      [() => {
        throw new CommandNotFoundError('git');
      }, t().shareFilesFailed(t().commandNotFound('git'))],
    ] as const) {
      const gh = fakeGh([made, ok()], git);
      const err = (await shareToGist(page, 'd', gh.run, files, opts).catch((e: unknown) => e)) as ShareError;
      expect(err).toBeInstanceOf(ShareError);
      expect(err.message).toBe(t().shareFilesUndone(reason));
      expect(err.leftover).toBeUndefined();
      // No page, and the gist with whatever went up is deleted.
      expect(gh.args()).toEqual([createGistArgs(), deleteGistArgs(FILES_ID)]);
      // The temporary clone is gone again.
      const clone = gh.gitCalls()[0]?.args.at(-1);
      if (clone) expect(existsSync(join(clone, '..'))).toBe(false);
    }
    // Nor deleted: listed, to be removed.
    const stuck = fakeGh([made, fail('HTTP 500')], (o) => (gitCommand(o.args) === 'push' ? result({ code: 1, stderr: 'fatal: unable to access\n' }) : fakeGit(o)));
    const err = (await shareToGist(page, 'd', stuck.run, files, opts).catch((e: unknown) => e)) as ShareError;
    expect(err.message).toBe(t().shareFilesLeftover(t().shareFilesFailed('fatal: unable to access')));
    expect(err.leftover).toEqual({ id: FILES_ID, url: '', gistUrl: `https://gist.github.com/${FILES_ID}` });
  });

  it('reads the gist back again a little later while GitHub does not list every file yet', async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => void waits.push(ms);
    const late = fakeGh([made, listed([FILES_PLACEHOLDER]), listed(['report.pdf']), listed(), ok(`https://gist.github.com/me/${ID}\n`)]);
    await expect(shareToGist(page, 'd', late.run, files, { ...opts, wait })).resolves.toEqual({ ...pageLink, filesGist: FILES_ID });
    expect(late.args()).toEqual([createGistArgs(), gistFilesArgs(FILES_ID), gistFilesArgs(FILES_ID), gistFilesArgs(FILES_ID), gistArgs('d')]);
    expect(waits).toEqual([1000, 2000]);
    // Three times at most: then the files gist goes, for want of an address.
    const never = fakeGh([made, listed(['report.pdf']), listed(['report.pdf']), listed(['report.pdf']), ok()]);
    await expect(shareToGist(page, 'd', never.run, files, opts)).rejects.toThrow(t().shareFilesUndone(t().shareNoFileUrl));
    expect(never.args()).toEqual([createGistArgs(), gistFilesArgs(FILES_ID), gistFilesArgs(FILES_ID), gistFilesArgs(FILES_ID), deleteGistArgs(FILES_ID)]);
    // gh could not read it back: the files gist goes too.
    const failed = fakeGh([made, fail('HTTP 502: Bad Gateway\n'), ok()]);
    await expect(shareToGist(page, 'd', failed.run, files, opts)).rejects.toThrow(t().shareFilesUndone(t().shareFailed('HTTP 502: Bad Gateway')));
    expect(failed.args()).toEqual([createGistArgs(), gistFilesArgs(FILES_ID), deleteGistArgs(FILES_ID)]);
  });

  it('deletes the files gist again when the page could not go up', async () => {
    for (const second of [fail('HTTP 502: Bad Gateway\n'), missing, ok('done, but no address\n')]) {
      const gh = fakeGh([made, listed(), second, ok()]);
      const err = (await shareToGist(page, 'd', gh.run, files, opts).catch((e: unknown) => e)) as ShareError;
      expect(err).toBeInstanceOf(ShareError);
      expect(err.leftover).toBeUndefined();
      expect(gh.args()).toEqual([createGistArgs(), gistFilesArgs(FILES_ID), gistArgs('d'), deleteGistArgs(FILES_ID)]);
    }
    const gh = fakeGh([made, listed(), fail('HTTP 502: Bad Gateway\n'), ok()]);
    await expect(shareToGist(page, 'd', gh.run, files, opts)).rejects.toThrow(t().shareFilesUndone(t().shareFailed('HTTP 502: Bad Gateway')));
  });

  it('says the files are left on GitHub, and which gist, when they could not be deleted either', async () => {
    for (const cleanup of [fail('dial tcp: no route to host\n'), missing]) {
      const gh = fakeGh([made, listed(), fail('please run:  gh auth login'), cleanup]);
      const err = (await shareToGist(page, 'd', gh.run, files, opts).catch((e: unknown) => e)) as ShareError;
      expect(err.message).toBe(t().shareFilesLeftover(t().shareSignedOut));
      // No gh code: the dialog shows this message, not only how to sign in.
      expect(err.code).toBeUndefined();
      expect(err.leftover).toEqual({ id: FILES_ID, url: '', gistUrl: `https://gist.github.com/${FILES_ID}` });
      expect(gh.args()).toEqual([createGistArgs(), gistFilesArgs(FILES_ID), gistArgs('d'), deleteGistArgs(FILES_ID)]);
    }
    expect(withLang('en', () => t().shareFilesLeftover('x'))).toContain('Settings');
  });

  it('records the address GitHub gave for a files gist left elsewhere than github.com, and pushes nothing there', async () => {
    const enterprise = created([FILES_PLACEHOLDER], { html: `https://github.example.com/gist/${FILES_ID}` });
    const gh = fakeGh([ok(enterprise), fail('HTTP 500')]);
    const err = (await shareToGist(page, 'd', gh.run, files, opts).catch((e: unknown) => e)) as ShareError;
    expect(err.message).toBe(t().shareFilesLeftover(t().shareNotGithub));
    expect(err.leftover).toEqual({ id: FILES_ID, url: '', gistUrl: `https://github.example.com/gist/${FILES_ID}` });
    expect(gh.args()).toEqual([createGistArgs(), deleteGistArgs(FILES_ID)]);
    expect(gh.git()).toEqual([]);
  });

  it('deletes the files gist when the page would grow too large', async () => {
    const gh = fakeGh([made, listed(), ok()]);
    const html = `<a href="${shareFileHref(0)}"></a>${'x'.repeat(SHARE_MAX_BYTES)}`;
    const err = await shareToGist(html, 'd', gh.run, files, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShareError);
    expect(gh.args()).toEqual([createGistArgs(), gistFilesArgs(FILES_ID), deleteGistArgs(FILES_ID)]);
  });

  it('measures a file without reading it, and reads no more of it than a share takes, also when it grew', async () => {
    const big = join(dir, 'big.log');
    writeFileSync(big, 'x'.repeat(5000));
    expect((await readAtMost(big, 10)).toString()).toBe('x'.repeat(10));
    expect((await readAtMost(big, 5000 + 1)).length).toBe(5000);
    const small = join(dir, 'small.pdf');
    writeFileSync(small, Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff]));
    expect([...(await readAtMost(small, 100))]).toEqual([0x25, 0x50, 0x44, 0x46, 0, 0xff]);
    // Larger than a read takes at a time, read whole.
    const large = join(dir, 'large.bin');
    writeFileSync(large, Buffer.alloc(3 * (1 << 20) + 7, 0xab));
    expect((await readAtMost(large, 4 << 20)).equals(Buffer.alloc(3 * (1 << 20) + 7, 0xab))).toBe(true);
    expect((await readAtMost(large, (1 << 20) + 1)).length).toBe((1 << 20) + 1);

    const found = (real?: string): FoundShareFile => ({ info: { name: 'f', path: 'f', refs: [0] }, ...(real ? { real } : {}) });
    // Measured: its size only; one too large, or gone, cannot go along.
    const measured = found(small);
    await measureShareFile(measured);
    expect(measured).toEqual({ ...found(small), info: { ...found().info, size: 6 } });
    const huge = found(big);
    await measureShareFile(huge, async () => SHARE_FILE_MAX_BYTES + 1);
    expect(huge.info).toMatchObject({ problem: 'too-large', size: SHARE_FILE_MAX_BYTES + 1 });
    const gone = found(join(dir, 'gone.md'));
    await measureShareFile(gone);
    expect(gone.info.problem).toBe('missing');

    // Read: its bytes as they are.
    await readShareFile(measured);
    expect(measured.data).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0xff]));
    expect(measured.info.size).toBe(6);
    // Measured small, read large: too large, nothing of it kept.
    const grew = found(big);
    await measureShareFile(grew, async () => 10);
    await readShareFile(grew, 100);
    expect(grew.info).toMatchObject({ problem: 'too-large', size: 101 });
    expect(grew.data).toBeUndefined();
    // Nothing is read of one that cannot go along, or is not there.
    await readShareFile(huge);
    expect(huge.data).toBeUndefined();
    const vanished = found(join(dir, 'vanished.md'));
    await readShareFile(vanished);
    expect(vanished.info.problem).toBe('missing');
  });

  it('reads a file only where it was found, a regular file: not through a link put in its place, nor a pipe', async () => {
    const target = join(dir, 'target.md');
    writeFileSync(target, 'secret\n');
    const swapped = join(dir, 'swapped.md');
    symlinkSync(target, swapped);
    await expect(readAtMost(swapped, 100)).rejects.toThrow();
    // As on Windows, which has no O_NOFOLLOW: the path's own entry is checked instead.
    await expect(readAtMost(swapped, 100, false)).rejects.toThrow(/not a file/);
    expect(await readAtMost(target, 100, false)).toEqual(Buffer.from('secret\n'));
    const linked: FoundShareFile = { info: { name: 'swapped.md', path: 'swapped.md', refs: [0] }, real: swapped };
    await readShareFile(linked);
    expect(linked).toMatchObject({ info: { problem: 'missing' } });
    expect(linked.data).toBeUndefined();
    if (process.platform !== 'win32') {
      const pipe = join(dir, 'pipe.md');
      execFileSync('mkfifo', [pipe]);
      // Opened without waiting for a writer (the test would hang otherwise), and refused.
      await expect(readAtMost(pipe, 100)).rejects.toThrow(/not a file/);
    }
  });

  it('reads no more of the files than a share takes in all, also when they grew after they were measured', async () => {
    const file = (name: string, bytes: number): FoundShareFile => {
      const real = join(dir, name);
      writeFileSync(real, Buffer.alloc(bytes, 0x61));
      return { info: { name, path: name, refs: [0], size: 1 }, real };
    };
    // Measured at 1 byte each, now 40 each: two fit in 100, the third has 20 bytes of room.
    const grew = [file('g1', 40), file('g2', 40), file('g3', 40), file('g4', 40)];
    await readShareFiles(grew, 50, 100);
    expect(grew.map((f) => f.data?.length)).toEqual([40, 40, undefined, undefined]);
    // The third is left with the room it had and one more: the share comes to more than 100.
    expect(grew[2]!.info).toEqual({ name: 'g3', path: 'g3', refs: [0], size: 21 });
    expect(grew.reduce((n, f) => n + f.info.size!, 0)).toBeGreaterThan(100);
    // One too large on its own is that, and the rest is not read.
    const big = [file('b1', 10), file('b2', 60), file('b3', 10)];
    await readShareFiles(big, 50, 100);
    expect(big.map((f) => [f.data?.length, f.info.problem])).toEqual([[10, undefined], [undefined, 'too-large'], [undefined, undefined]]);
    // Within both limits: every one read.
    const fine = [file('f1', 50), file('f2', 50)];
    await readShareFiles(fine, 50, 100);
    expect(fine.map((f) => f.data?.length)).toEqual([50, 50]);
  });

  it('names each file in its gist once, never as GitHub names files itself, and never too long', () => {
    expect(gistFileNames(['report.md', 'report.md', 'Report.MD', 'notes'])).toEqual(['report.md', 'report-2.md', 'Report-3.MD', 'notes']);
    expect(gistFileNames(['index.html', 'INDEX.HTML'])).toEqual(['index-2.html', 'INDEX-3.HTML']);
    expect(gistFileNames(['gistfile1.txt', 'gistfile2'])).toEqual(['gistfile1-2.txt', 'gistfile2-2']);
    expect(gistFileNames(['.env', '.env'])).toEqual(['.env', '.env-2']);
    // Never a name git keeps for itself: a push with one could be refused.
    expect(gistFileNames(['.gitmodules', '.gitignore', '.GIT', 'git~1'])).toEqual(['_.gitmodules', '_.gitignore', '_.GIT', '_git~1']);
    // Never the files gist's placeholder: a listing that still shows it is one GitHub has not updated.
    expect(gistFileNames([FILES_PLACEHOLDER, FILES_PLACEHOLDER.toUpperCase()])).toEqual(['harness-relay-2.txt', 'HARNESS-RELAY-3.TXT']);
    expect(gistFileName('a/b\\c\u0007.txt')).toBe('a_b_c_.txt');
    expect(gistFileName('  ')).toBe('file');
    expect(gistFileName('..')).toBe('file');
    expect(gistFileName('bad\ud800.txt')).toBe('bad_.txt');
    const long = gistFileName(`${'報'.repeat(200)}.csv`);
    expect(encodeURIComponent(long).length).toBeLessThanOrEqual(240);
    expect(long).toMatch(/^報+…\.csv$/);
    // A long name made unique stays within the limit too: the stem gives way to the suffix.
    const twice = gistFileNames([`${'報'.repeat(200)}.csv`, `${'報'.repeat(200)}.csv`, `${'a'.repeat(240)}.md`, `${'a'.repeat(240)}.md`]);
    for (const name of twice) expect(encodeURIComponent(name).length, name).toBeLessThanOrEqual(240);
    expect(twice[1]).toMatch(/^報+…-2\.csv$/);
    expect(twice[3]).toMatch(/^a+…-2\.md$/);
    expect(new Set(twice.map((n) => n.toLowerCase())).size).toBe(4);
  });

  it("knows the names git keeps for itself, however they are spelled", () => {
    for (const name of ['.git', '.GIT', '.gitmodules', '.GitAttributes', '.gitignore', '.g\u200cit', '\ufeff.git', 'GIT~1', 'git~2', 'GITMOD~1', 'gi7eba~2', 'gitatt~1', 'GI7D29~3']) {
      expect(gitOwnName(name), JSON.stringify(name)).toBe(true);
    }
    for (const name of ['git.md', 'my.gitignore', '_.git', 'report.pdf', '.env']) expect(gitOwnName(name), name).toBe(false);
  });

  it('takes only a list of links, each a reply and a path', () => {
    expect(parseShareFileRefs(undefined)).toEqual([]);
    expect(parseShareFileRefs([{ messageId: 'r1', path: 'out/a.md', extra: 1 }])).toEqual([{ messageId: 'r1', path: 'out/a.md' }]);
    for (const bad of [{}, 'out/a.md', [{ messageId: 'r1' }], [{ messageId: '', path: 'a' }], [{ messageId: 'r1', path: 7 }], [null]]) {
      expect(parseShareFileRefs(bad), JSON.stringify(bad)).toBeUndefined();
    }
    const many = Array.from({ length: SHARE_FILE_LINKS_MAX + 1 }, (_, i) => ({ messageId: 'r', path: `${i}.md` }));
    expect(parseShareFileRefs(many)).toBeUndefined();
    expect(parseShareFileRefs(many.slice(1))).toHaveLength(SHARE_FILE_LINKS_MAX);
  });
});
