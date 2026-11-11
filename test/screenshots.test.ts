import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GH_MISSING, REPORT_SCREENSHOT_LIMITS } from '../src/shared/types';
import { HttpError } from '../src/server/errors';
import { t } from '../src/server/i18n';
import { CommandNotFoundError, type SpawnOptions, type SpawnResult } from '../src/server/process';
import { SCREENSHOTS_DESCRIPTION, imageKind, parseScreenshots, uploadScreenshots } from '../src/server/screenshots';
import {
  CREATED_JQ,
  FILES_PLACEHOLDER,
  ShareError,
  createGistArgs,
  deleteGistArgs,
  filesGistDescription,
  findGistArgs,
  gistFilesArgs,
} from '../src/server/share';

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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const b64 = (b: Buffer) => b.toString('base64');

describe('a screenshot', () => {
  it('is known by its first bytes as a PNG, JPEG, GIF or WebP image', () => {
    expect(imageKind(PNG)).toBe('png');
    expect(imageKind(JPEG)).toBe('jpg');
    expect(imageKind(GIF)).toBe('gif');
    expect(imageKind(Buffer.from('GIF87a', 'latin1'))).toBe('gif');
    expect(imageKind(WEBP)).toBe('webp');
  });

  it('is nothing else, whatever it is called', () => {
    for (const b of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      Buffer.from('%PDF-1.7\n'),
      Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'),
      PNG.subarray(0, 7),
      Buffer.alloc(0),
    ]) {
      expect(imageKind(b)).toBeUndefined();
    }
  });
});

describe('the screenshots a request sends', () => {
  const refused = (v: unknown) => {
    try {
      parseScreenshots(v);
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      return { status: (err as HttpError).status, message: (err as HttpError).message };
    }
    throw new Error('taken');
  };

  it('are named by their place and kind, never by the name the file had', () => {
    const files = parseScreenshots([{ data: b64(PNG), name: 'secret-project.png' }, { data: b64(JPEG) }, { data: b64(WEBP) }]);
    expect(files.map((f) => f.name)).toEqual(['screenshot-1.png', 'screenshot-2.jpg', 'screenshot-3.webp']);
    expect(files[0]!.data.equals(PNG)).toBe(true);
  });

  it('must be some, and not too many', () => {
    expect(refused(undefined)).toEqual({ status: 400, message: t().reportShotsNone });
    expect(refused([])).toEqual({ status: 400, message: t().reportShotsNone });
    const many = Array.from({ length: REPORT_SCREENSHOT_LIMITS.maxFiles + 1 }, () => ({ data: b64(PNG) }));
    expect(refused(many)).toEqual({ status: 413, message: t().reportShotsTooMany(REPORT_SCREENSHOT_LIMITS.maxFiles) });
  });

  it('must each be an image, in base64 as a browser writes it, saying which one is not', () => {
    expect(refused([{ data: b64(PNG) }, { data: b64(Buffer.from('<svg/>')) }])).toEqual({ status: 400, message: t().reportShotNotImage(2) });
    expect(refused([{ data: 'not base64!' }])).toEqual({ status: 400, message: t().reportShotNotImage(1) });
    expect(refused([{ data: 42 }])).toEqual({ status: 400, message: t().reportShotNotImage(1) });
    expect(refused([null])).toEqual({ status: 400, message: t().reportShotNotImage(1) });
  });

  it('must each be no larger than the limit, refused before it is decoded', () => {
    const mb = REPORT_SCREENSHOT_LIMITS.maxBytes / 1024 / 1024;
    const big = Buffer.concat([PNG, Buffer.alloc(REPORT_SCREENSHOT_LIMITS.maxBytes)]);
    expect(refused([{ data: b64(big) }])).toEqual({ status: 413, message: t().reportShotTooLarge(1, mb) });
    const fits = Buffer.concat([PNG, Buffer.alloc(REPORT_SCREENSHOT_LIMITS.maxBytes - PNG.length)]);
    expect(parseScreenshots([{ data: b64(fits) }])).toHaveLength(1);
  });
});

describe('uploading the screenshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-shots-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const ID = 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
  const TOKEN = 'relay-0123456789abcdef';
  const opts = { token: TOKEN, wait: async () => {}, tmpRoot: join(dir, 'tmp') };
  const files = parseScreenshots([{ data: b64(PNG) }, { data: b64(JPEG) }]);
  const created = (names: string[], html = `https://gist.github.com/someone/${ID}`) =>
    JSON.stringify({
      id: ID,
      html_url: html,
      files: names.map((filename) => ({ filename, raw_url: `https://gist.githubusercontent.com/someone/${ID}/raw/abc/${filename}` })),
    }) + '\n';

  const gitCommand = (args: string[]) => {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '--git-dir') i++;
      else return args[i]!;
    }
    return '';
  };
  const oid = (n: number) => n.toString(16).padStart(40, '0');
  const fakeGit = (o: SpawnOptions) =>
    result({ stdout: { 'symbolic-ref': 'refs/heads/main\n', 'hash-object': `${oid(1)}\n`, mktree: `${oid(2)}\n`, 'commit-tree': `${oid(3)}\n` }[gitCommand(o.args)] ?? '' });

  /** gh's calls answered in turn by `answers`, git's by `git`; gh's calls recorded. */
  function fake(answers: (() => SpawnResult)[], git: (o: SpawnOptions) => SpawnResult = fakeGit) {
    const gh: SpawnOptions[] = [];
    const pushed: Buffer[] = [];
    let n = 0;
    const run = async (o: SpawnOptions) => {
      if (o.bin === 'git') {
        if (gitCommand(o.args) === 'hash-object') pushed.push(o.stdin as Buffer);
        return git(o);
      }
      gh.push(o);
      const answer = answers[n++];
      if (!answer) throw new Error(`unexpected gh ${o.args.join(' ')}`);
      return answer();
    };
    return { run, gh, pushed, args: () => gh.map((c) => c.args) };
  }
  const ok = (stdout = '') => () => result({ stdout });

  it('puts them in one secret gist, pushed with git, and gives its page on GitHub', async () => {
    const f = fake([ok(created([FILES_PLACEHOLDER])), ok(created(files.map((x) => x.name)))]);
    expect(await uploadScreenshots(files, f.run, opts)).toEqual({ id: ID, url: `https://gist.github.com/someone/${ID}` });
    expect(f.args()).toEqual([createGistArgs(), gistFilesArgs(ID)]);
    expect(gistFilesArgs(ID)).toEqual(['api', `gists/${ID}`, '--jq', CREATED_JQ]);
    expect(JSON.parse(String(f.gh[0]!.stdin))).toMatchObject({ description: filesGistDescription(SCREENSHOTS_DESCRIPTION, TOKEN), public: false });
    expect(f.pushed).toEqual(files.map((x) => x.data));
  });

  it('says how to install gh when it is missing, with the code the dialog explains', async () => {
    const run = async () => {
      throw new CommandNotFoundError('gh');
    };
    const err = (await uploadScreenshots(files, run, opts).catch((e: unknown) => e)) as ShareError;
    expect(err).toBeInstanceOf(ShareError);
    expect(err.code).toBe(GH_MISSING);
  });

  it('deletes the gist again when the screenshots could not go up, and says so of the screenshots', async () => {
    const failPush = (o: SpawnOptions) => (gitCommand(o.args) === 'push' ? result({ code: 1, stderr: 'fatal: unable to access\n' }) : fakeGit(o));
    const f = fake([ok(created([FILES_PLACEHOLDER])), ok()], failPush);
    const err = (await uploadScreenshots(files, f.run, opts).catch((e: unknown) => e)) as ShareError;
    expect(err.message).toBe(t().reportShotsUndone(t().shareFilesFailed('fatal: unable to access')));
    expect(f.args()).toEqual([createGistArgs(), deleteGistArgs(ID)]);

    // Nor deleted: the message says where it is, to delete it on GitHub.
    const stuck = fake([ok(created([FILES_PLACEHOLDER])), () => result({ code: 1, stderr: 'HTTP 500' })], failPush);
    const left = (await uploadScreenshots(files, stuck.run, opts).catch((e: unknown) => e)) as ShareError;
    expect(left.message).toBe(t().reportShotsLeftover(t().shareFilesFailed('fatal: unable to access'), `https://gist.github.com/someone/${ID}`));
  });

  it('looks for the gist by its token when gh could not say it made it, and names the token when it cannot', async () => {
    const f = fake([() => result({ code: null, timedOut: true }), () => result({ code: 1, stderr: 'HTTP 502' })]);
    const err = (await uploadScreenshots(files, f.run, opts).catch((e: unknown) => e)) as ShareError;
    expect(f.args()).toEqual([createGistArgs(), findGistArgs(TOKEN)]);
    expect(err.message).toBe(t().reportShotsUnknown(t().shareFailed(t().timedOut), TOKEN));
  });

  it('pushes nothing to a gist elsewhere than github.com, and deletes it again', async () => {
    const f = fake([ok(created([FILES_PLACEHOLDER], `https://github.example.com/gist/${ID}`)), ok()]);
    const err = (await uploadScreenshots(files, f.run, opts).catch((e: unknown) => e)) as ShareError;
    expect(err.message).toBe(t().reportShotsUndone(t().reportShotsNotGithub));
    expect(f.pushed).toEqual([]);
  });
});
