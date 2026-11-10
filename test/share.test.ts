import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GH_MIN_VERSION, GH_MISSING, GH_SIGNED_OUT } from '../src/shared/types';
import { t, withLang } from '../src/server/i18n';
import { CommandNotFoundError, type SpawnOptions, type SpawnResult } from '../src/server/process';
import {
  CREATED_JQ,
  SHARE_FILE,
  ShareError,
  createGistArgs,
  createGistBody,
  deleteGistArgs,
  filesGistDescription,
  findGistArgs,
  ghBin,
  gistArgs,
  gistExistsArgs,
  gistDescription,
  gistFileName,
  gistFileNames,
  gistText,
  ghTooOld,
  gistError,
  parseCreatedGist,
  parseGhVersion,
  parseGistUrl,
  parseFoundGists,
  parseShareFileRefs,
  rawUrl,
  readAtMost,
  readShareFile,
  shareToGist,
  shareToken,
  unshareGist,
  validGistId,
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
    expect(seen?.bin).toMatch(/(^|[\\/])gh$/);
    expect(seen?.args).toEqual(gistArgs('Chat · Harness Relay'));
    expect(seen?.stdin).toBe('<!doctype html>…');
    expect(link).toEqual({ id: ID, url: `https://gistpreview.github.io/?${ID}`, gistUrl: `https://gist.github.com/me/${ID}` });
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
  const files = [
    { name: 'report.md', content: '# Report\n' },
    { name: 'Q3 & 報告.csv', content: 'a,b\n1,2\n' },
  ];
  const pageLink = { id: ID, url: `https://gistpreview.github.io/?${ID}`, gistUrl: `https://gist.github.com/me/${ID}` };

  /** A fake gh: each call answered in turn by `answers` (by the first arguments), every call recorded. */
  function fakeGh(answers: ((o: SpawnOptions) => SpawnResult | Promise<SpawnResult>)[]) {
    const calls: SpawnOptions[] = [];
    const run = async (o: SpawnOptions) => {
      calls.push(o);
      const answer = answers[calls.length - 1];
      if (!answer) throw new Error(`unexpected gh ${o.args.join(' ')}`);
      return answer(o);
    };
    return { run, calls, args: () => calls.map((c) => c.args) };
  }
  const ok = (stdout = '') => () => result({ stdout });
  const fail = (stderr: string, o: Partial<SpawnResult> = {}) => () => result({ code: 1, stderr, ...o });
  const missing = () => {
    throw new CommandNotFoundError('gh');
  };

  it('puts the files in a secret gist of their own, then the page in another, its links at the files', async () => {
    const gh = fakeGh([ok(created(files.map((f) => f.name))), ok(`https://gist.github.com/me/${ID}\n`)]);
    const link = await shareToGist(page, 'Chat · Harness Relay', gh.run, files, TOKEN);
    expect(link).toEqual({ ...pageLink, filesGist: FILES_ID });
    expect(gh.args()).toEqual([createGistArgs(), gistArgs('Chat · Harness Relay')]);
    expect(createGistArgs()).toEqual(['api', 'gists', '--method', 'POST', '--input', '-', '--jq', CREATED_JQ]);
    // The files, by name, in a gist nobody can find without its address, marked with the share's token.
    expect(JSON.parse(String(gh.calls[0]!.stdin))).toEqual({
      description: `Chat · Harness Relay · files · ${TOKEN}`,
      public: false,
      files: { 'report.md': { content: '# Report\n' }, 'Q3 & 報告.csv': { content: 'a,b\n1,2\n' } },
    });
    expect(String(gh.calls[0]!.stdin)).toBe(createGistBody(filesGistDescription('Chat · Harness Relay', TOKEN), files));
    // The page alone in its gist, as a share without files is made: gistpreview reads nothing else first.
    expect(gh.calls[1]!.stdin).toBe(
      `<!doctype html><a class="file-link" href="${raw('report.md')}">report</a> <a class="file-link" href="${raw('Q3 & 報告.csv')}">data</a> <a class="file-link" href="${raw('report.md')}">again</a>`,
    );
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

  it('makes nothing more when the files could not go up, and says why', async () => {
    const refused = fakeGh([fail('gh: Validation Failed (HTTP 422)\n')]);
    await expect(shareToGist(page, 'd', refused.run, files, TOKEN)).rejects.toThrow(t().shareFailed('gh: Validation Failed (HTTP 422)'));
    expect(refused.args()).toEqual([createGistArgs()]);
    const signedOut = fakeGh([fail('please run:  gh auth login')]);
    await expect(shareToGist(page, 'd', signedOut.run, files, TOKEN)).rejects.toMatchObject({ code: GH_SIGNED_OUT });
    const absent = fakeGh([missing]);
    await expect(shareToGist(page, 'd', absent.run, files, TOKEN)).rejects.toMatchObject({ code: GH_MISSING });
  });

  it('looks for the files gist by its token when gh timed out or printed nothing to go on, and deletes it', async () => {
    for (const first of [() => result({ code: null, timedOut: true }), ok(''), ok('garbage')]) {
      const gh = fakeGh([first, ok(`${FILES_ID} https://gist.github.com/${FILES_ID}\n`), ok()]);
      const err = (await shareToGist(page, 'd', gh.run, files, TOKEN).catch((e: unknown) => e)) as ShareError;
      expect(err).toBeInstanceOf(ShareError);
      expect(err.leftover).toBeUndefined();
      expect(err.message).toMatch(/deleted again|一併刪除/);
      expect(gh.args()).toEqual([createGistArgs(), findGistArgs(TOKEN), deleteGistArgs(FILES_ID)]);
    }
    // None was made: the reason, and nothing to delete.
    const none = fakeGh([() => result({ code: null, timedOut: true }), ok('')]);
    await expect(shareToGist(page, 'd', none.run, files, TOKEN)).rejects.toThrow(t().shareFailed(t().timedOut));
    expect(none.args()).toEqual([createGistArgs(), findGistArgs(TOKEN)]);
  });

  it('lists the lost files gist when it cannot be deleted, and names the token when it cannot be looked for', async () => {
    const stuck = fakeGh([ok(''), ok(`${FILES_ID} https://gist.github.com/${FILES_ID}\n`), fail('HTTP 500')]);
    const err = (await shareToGist(page, 'd', stuck.run, files, TOKEN).catch((e: unknown) => e)) as ShareError;
    expect(err.message).toBe(t().shareFilesLeftover(t().shareFailed(t().shareNoUrl)));
    expect(err.leftover).toEqual({ id: FILES_ID, url: '', gistUrl: `https://gist.github.com/${FILES_ID}` });
    const blind = fakeGh([() => result({ code: null, timedOut: true }), fail('HTTP 502')]);
    const unknown = (await shareToGist(page, 'd', blind.run, files, TOKEN).catch((e: unknown) => e)) as ShareError;
    expect(unknown.message).toBe(t().shareFilesUnknown(t().shareFailed(t().timedOut), TOKEN));
    expect(unknown.message).toContain(TOKEN);
    expect(unknown.leftover).toBeUndefined();
  });

  it('deletes the files gist again when the page could not go up', async () => {
    for (const second of [fail('HTTP 502: Bad Gateway\n'), missing, ok('done, but no address\n')]) {
      const gh = fakeGh([ok(created(files.map((f) => f.name))), second, ok()]);
      const err = (await shareToGist(page, 'd', gh.run, files, TOKEN).catch((e: unknown) => e)) as ShareError;
      expect(err).toBeInstanceOf(ShareError);
      expect(err.leftover).toBeUndefined();
      expect(gh.args()).toEqual([createGistArgs(), gistArgs('d'), deleteGistArgs(FILES_ID)]);
    }
    const gh = fakeGh([ok(created(files.map((f) => f.name))), fail('HTTP 502: Bad Gateway\n'), ok()]);
    await expect(shareToGist(page, 'd', gh.run, files, TOKEN)).rejects.toThrow(t().shareFilesUndone(t().shareFailed('HTTP 502: Bad Gateway')));
  });

  it('says the files are left on GitHub, and which gist, when they could not be deleted either', async () => {
    for (const cleanup of [fail('dial tcp: no route to host\n'), missing]) {
      const gh = fakeGh([ok(created(files.map((f) => f.name))), fail('please run:  gh auth login'), cleanup]);
      const err = (await shareToGist(page, 'd', gh.run, files, TOKEN).catch((e: unknown) => e)) as ShareError;
      expect(err.message).toBe(t().shareFilesLeftover(t().shareSignedOut));
      // No gh code: the dialog shows this message, not only how to sign in.
      expect(err.code).toBeUndefined();
      expect(err.leftover).toEqual({ id: FILES_ID, url: '', gistUrl: `https://gist.github.com/${FILES_ID}` });
      expect(gh.args()).toEqual([createGistArgs(), gistArgs('d'), deleteGistArgs(FILES_ID)]);
    }
    expect(withLang('en', () => t().shareFilesLeftover('x'))).toContain('Settings');
  });

  it('records the address GitHub gave for a files gist left elsewhere than github.com', async () => {
    const enterprise = created(files.map((f) => f.name), { html: `https://github.example.com/gist/${FILES_ID}` });
    const gh = fakeGh([ok(enterprise), fail('HTTP 500')]);
    const err = (await shareToGist(page, 'd', gh.run, files, TOKEN).catch((e: unknown) => e)) as ShareError;
    expect(err.message).toBe(t().shareFilesLeftover(t().shareNotGithub));
    expect(err.leftover).toEqual({ id: FILES_ID, url: '', gistUrl: `https://github.example.com/gist/${FILES_ID}` });
    expect(gh.args()).toEqual([createGistArgs(), deleteGistArgs(FILES_ID)]);
  });

  it('deletes the files gist when GitHub gave no address for a file, or the page would grow too large', async () => {
    for (const [stdout, html, reason] of [
      [created(['report.md']), page, t().shareNoFileUrl], // no raw URL for the second file
      [created(files.map((f) => f.name)), `<a href="${shareFileHref(0)}"></a>${'x'.repeat(SHARE_MAX_BYTES)}`, undefined],
    ] as const) {
      const gh = fakeGh([ok(stdout), ok()]);
      const err = await shareToGist(html, 'd', gh.run, files, TOKEN).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShareError);
      if (reason) expect((err as Error).message).toBe(t().shareFilesUndone(reason));
      expect(gh.args()).toEqual([createGistArgs(), deleteGistArgs(FILES_ID)]);
    }
  });

  it('takes UTF-8 text only, as a gist holds', () => {
    expect(gistText(Buffer.from('# 報告\r\n\tline\f\x1b[0m'))).toBe('# 報告\r\n\tline\f\x1b[0m');
    expect(gistText(Buffer.from('\ufeffwith a BOM'))).toBe('\ufeffwith a BOM'); // kept, as the file has it
    expect(gistText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeUndefined(); // a PNG
    expect(gistText(Buffer.from('%PDF-1.7\n\x00\x01'))).toBeUndefined();
    expect(gistText(Buffer.from([0xa7, 0x41, 0xa6, 0x6e]))).toBeUndefined(); // Big5, not UTF-8
    expect(gistText(Buffer.from(''))).toBe('');
  });

  const dir = mkdtempSync(join(tmpdir(), 'relay-share-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads no more of a file than a share takes, also when it grew after it was measured', async () => {
    const big = join(dir, 'big.log');
    writeFileSync(big, 'x'.repeat(SHARE_FILE_MAX_BYTES + 500));
    expect((await readAtMost(big, 10)).toString()).toBe('x'.repeat(10));
    expect((await readAtMost(big, SHARE_FILE_MAX_BYTES + 1)).length).toBe(SHARE_FILE_MAX_BYTES + 1);
    const small = join(dir, 'small.md');
    writeFileSync(small, 'hi\n');
    expect((await readAtMost(small, 100)).toString()).toBe('hi\n');

    // Measured small, read large: too large, nothing of it kept.
    const grew = { info: { name: 'big.log', path: 'big.log', refs: [0] } } as Parameters<typeof readShareFile>[1];
    await readShareFile(big, grew, async () => 10);
    expect(grew.info).toMatchObject({ problem: 'too-large', size: SHARE_FILE_MAX_BYTES + 1 });
    expect(grew.text).toBeUndefined();
    const fine = { info: { name: 'small.md', path: 'small.md', refs: [0] } } as Parameters<typeof readShareFile>[1];
    await readShareFile(small, fine);
    expect(fine).toEqual({ info: { name: 'small.md', path: 'small.md', refs: [0], size: 3 }, text: 'hi\n' });
    const gone = { info: { name: 'gone.md', path: 'gone.md', refs: [0] } } as Parameters<typeof readShareFile>[1];
    await readShareFile(join(dir, 'gone.md'), gone);
    expect(gone.info.problem).toBe('missing');
  });

  it('names each file in its gist once, never as GitHub names files itself, and never too long', () => {
    expect(gistFileNames(['report.md', 'report.md', 'Report.MD', 'notes'])).toEqual(['report.md', 'report-2.md', 'Report-3.MD', 'notes']);
    expect(gistFileNames(['index.html', 'INDEX.HTML'])).toEqual(['index-2.html', 'INDEX-3.HTML']);
    expect(gistFileNames(['gistfile1.txt', 'gistfile2'])).toEqual(['gistfile1-2.txt', 'gistfile2-2']);
    expect(gistFileNames(['.env', '.env'])).toEqual(['.env', '.env-2']);
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
