import { describe, expect, it } from 'vitest';
import { GH_MIN_VERSION, GH_MISSING, GH_SIGNED_OUT } from '../src/shared/types';
import { t, withLang } from '../src/server/i18n';
import { CommandNotFoundError, type SpawnOptions, type SpawnResult } from '../src/server/process';
import {
  SHARE_FILE,
  ShareError,
  deleteGistArgs,
  ghBin,
  gistArgs,
  gistExistsArgs,
  gistDescription,
  ghTooOld,
  gistError,
  parseGhVersion,
  parseGistUrl,
  shareToGist,
  unshareGist,
  validGistId,
} from '../src/server/share';

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
