import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GH_MISSING, GH_SIGNED_OUT } from '../src/shared/types';
import { withLang } from '../src/server/i18n';
import { CommandNotFoundError, runProcess, type SpawnOptions, type SpawnResult } from '../src/server/process';
import {
  clearPublishTmp,
  createRepo,
  fastImportPath,
  fastImportStream,
  githubLogin,
  pushSnapshot,
  repoRemote,
} from '../src/server/publish/git';
import { slow } from './timeouts';

const work = realpathSync(mkdtempSync(join(tmpdir(), 'relay-publish-git-')));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const result = (o: Partial<SpawnResult>): SpawnResult =>
  ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, ...o }) as SpawnResult;

describe('gh: the account and its new repository', () => {
  it('asks gh who is signed in, and makes a private repository with it', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (o: SpawnOptions) => {
      calls.push(o.args);
      return result({ stdout: o.args.includes('user/repos') ? 'me/todo-app\n' : 'me\n' });
    });
    expect(await githubLogin(run)).toBe('me');
    expect(await createRepo('todo-app', run)).toBe('me/todo-app');
    expect(calls).toEqual([
      ['api', '--hostname', 'github.com', 'user', '--jq', '.login'],
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'POST',
        'user/repos',
        '-f',
        'name=todo-app',
        '-F',
        'private=true',
        '-f',
        'description=Published from Harness Relay',
        '--jq',
        '.full_name',
      ],
    ]);
  });

  it('says when gh is missing or signed out, and when the name is taken', async () => {
    const missing = vi.fn(async () => {
      throw new CommandNotFoundError('gh');
    });
    await expect(githubLogin(missing)).rejects.toMatchObject({ code: GH_MISSING });
    const out = vi.fn(async () => result({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }));
    await expect(githubLogin(out)).rejects.toMatchObject({ code: GH_SIGNED_OUT });
    const taken = vi.fn(async () =>
      result({
        code: 1,
        stdout: '{"message":"Repository creation failed.","errors":[{"message":"name already exists on this account"}]}',
        stderr: 'gh: Repository creation failed. (HTTP 422)',
      }),
    );
    await withLang('en', () =>
      expect(createRepo('todo-app', taken)).rejects.toMatchObject({ status: 409, message: /already has a repository named "todo-app"/ }),
    );
    const odd = vi.fn(async () => result({ stdout: 'not a repo name' }));
    await expect(createRepo('todo-app', odd)).rejects.toMatchObject({ status: 502 });
  });
});

describe('the commit of the snapshot', () => {
  it('quotes a path for fast-import, escaping its backslashes and quotes', () => {
    expect(fastImportPath('a b/c.txt')).toBe('"a b/c.txt"');
    expect(fastImportPath('we"ird\\name')).toBe('"we\\"ird\\\\name"');
  });

  it('streams one commit of exactly the files, with their executable bits, after the commit there when there is one', () => {
    const files = new Map([
      ['run.sh', Buffer.from('#!/bin/sh\n')],
      ['a.txt', Buffer.from('hi')],
    ]);
    const text = fastImportStream(files, new Set(['run.sh']), 'msg', true, 1700000000).toString();
    expect(text).toBe(
      'commit refs/heads/main\ncommitter Harness Relay <harness-relay@localhost> 1700000000 +0000\ndata 3\nmsg\n' +
        'from refs/heads/main^0\ndeleteall\n' +
        'M 100644 inline "a.txt"\ndata 2\nhi\n' +
        'M 100755 inline "run.sh"\ndata 10\n#!/bin/sh\n\n' +
        'done\n',
    );
    expect(fastImportStream(new Map(), new Set(), 'm', false, 0).toString()).not.toContain('from ');
  });

  it(
    'pushes it to the repository with real git, then an update on top of it, leaving no temporary repository',
    async () => {
      const base = join(work, 'github');
      const bare = repoRemote('me/todo-app', base);
      mkdirSync(join(base, 'me'), { recursive: true });
      execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare]);
      const tmp = join(work, 'tmp');
      const files = new Map([
        ['index.html', Buffer.from('<h1>v1</h1>')],
        ['src/main.js', Buffer.from('console.log(1)')],
        ['bin/start', Buffer.from('#!/bin/sh\nexec node .\n')],
        ['名字 with space.txt', Buffer.from('ok')],
      ]);
      const first = await pushSnapshot('me/todo-app', files, new Set(['bin/start']), runProcess, tmp, base);
      // Quoted names as git quotes them by default, whatever the user's `core.quotePath`.
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'core.quotePath=true', '--git-dir', bare, ...args], { encoding: 'utf8' }).trim();
      expect(git('rev-parse', 'refs/heads/main')).toBe(first);
      expect(git('ls-tree', '-r', '--name-only', 'main').split('\n').sort()).toEqual(
        ['bin/start', 'index.html', 'src/main.js', '"\\345\\220\\215\\345\\255\\227 with space.txt"'].sort(),
      );
      expect(git('ls-tree', 'main', 'bin/start')).toMatch(/^100755 /);
      expect(git('show', 'main:index.html')).toBe('<h1>v1</h1>');
      expect(git('log', '-1', '--format=%an <%ae> %s', 'main')).toBe('Harness Relay <harness-relay@localhost> Publish from Harness Relay');

      // An update: a commit after the first, without the files that went.
      const second = await pushSnapshot(
        'me/todo-app',
        new Map([['index.html', Buffer.from('<h1>v2</h1>')]]),
        new Set(),
        runProcess,
        tmp,
        base,
      );
      expect(git('rev-parse', 'main^')).toBe(first);
      expect(git('rev-parse', 'main')).toBe(second);
      expect(git('ls-tree', '-r', '--name-only', 'main')).toBe('index.html');
      expect(readdirSync(tmp)).toEqual([]);
    },
    slow(30_000),
  );

  it('says when the push failed, with what git said', async () => {
    const base = join(work, 'nowhere');
    await withLang('en', () =>
      expect(
        pushSnapshot('me/missing', new Map([['a', Buffer.from('a')]]), new Set(), runProcess, join(work, 'tmp2'), base),
      ).rejects.toMatchObject({
        status: 502,
        message: /could not be pushed/,
      }),
    );
  });

  it("names GitHub's address for a repository Relay made, and nothing else", () => {
    expect(repoRemote('me/todo-app', undefined)).toBe('https://github.com/me/todo-app.git');
    for (const bad of ['me/../x', 'me', 'me/Todo', '-me/x', 'me/x/y']) expect(() => repoRemote(bad, undefined)).toThrow();
  });

  it('clears what a publish the server stopped during left, and nothing else', async () => {
    const root = join(work, 'clear');
    mkdirSync(join(root, 'publish-abc'), { recursive: true });
    mkdirSync(join(root, 'share-keep'), { recursive: true });
    writeFileSync(join(root, 'publish-abc', 'x'), '');
    await clearPublishTmp(root);
    expect(readdirSync(root)).toEqual(['share-keep']);
    await clearPublishTmp(join(work, 'absent'));
  });
});
