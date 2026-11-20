import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { withholdFile } from '../src/server/db';
import { previewFileResponse, previewPrivatePath, previewSnapshot } from '../src/server/previewFiles';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-preview-files-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, body = path): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

it('retains owner execute permission for project scripts only', async () => {
  const folder = mkdtempSync(join(root, 'exec-'));
  writeFileSync(join(folder, 'build.sh'), '#!/bin/sh\nexit 0');
  chmodSync(join(folder, 'build.sh'), 0o700);
  writeFileSync(join(folder, 'data.json'), '{}');
  const snapshot = await previewSnapshot(folder, '', 'build');
  expect([...snapshot.executables]).toEqual(['build.sh']);
});

describe('preview snapshots', () => {
  it('reads the selected folder as it is now, keeping the old snapshot after a change', async () => {
    const site = 'project with 空格/public';
    put(site + '/index.html', 'first');
    put(site + '/assets/main.mjs');
    put(site + '/assets/logo.svg');
    put(site + '/assets/style.css');
    const first = await previewSnapshot(root, site, 'static');
    expect([...first.keys()].sort()).toEqual(['assets/logo.svg', 'assets/main.mjs', 'assets/style.css', 'index.html']);
    put(site + '/index.html', 'second');
    expect(first.get('index.html')?.toString()).toBe('first');
    expect((await previewSnapshot(root, site, 'static')).get('index.html')?.toString()).toBe('second');
  });

  it('withholds dotfiles, likely credentials, dependencies, existing databases, linked and withheld files in all modes', async () => {
    for (const name of [
      'index.html',
      '.env.development',
      '.npmrc',
      '.git/HEAD',
      'node_modules/v/index.js',
      'credentials.json',
      'secrets/private.js',
      'state.sqlite',
      'id_rsa',
      'withheld.js',
      'app.pem',
    ])
      put('project/' + name);
    withholdFile(join(root, 'project/withheld.js'));
    put('outside.html');
    linkSync(join(root, 'outside.html'), join(root, 'project/linked.html'));
    mkdirSync(join(root, 'other', 'public'), { recursive: true });
    symlinkSync(join(root, 'other'), join(root, 'project/linked-dir'), 'junction');
    for (const mode of ['static', 'server', 'build'] as const) {
      expect([...(await previewSnapshot(root, 'project', mode)).keys()]).toEqual(['index.html']);
    }
    await expect(previewSnapshot(root, 'project/linked-dir/public', 'static')).rejects.toThrow();
  });

  it('supplies source and lockfiles only to the runtime', async () => {
    for (const name of [
      'package.json',
      'package-lock.json',
      'src/app.ts',
      'index.html',
      'server.js',
      'vite.config.js',
      'private-data.json',
      'assets/app.js.map',
    ])
      put('app/' + name);
    const source = await previewSnapshot(root, 'app', 'server');
    expect([...source.keys()]).toEqual(expect.arrayContaining(['package.json', 'package-lock.json', 'src/app.ts', 'server.js']));
    const site = await previewSnapshot(root, 'app', 'static');
    expect([...site.keys()]).toEqual(['index.html']);
  });

  it('requires the resolved root chosen for the session, including its ancestors', async () => {
    put('physical/worktree/index.html');
    symlinkSync(join(root, 'physical'), join(root, 'alias'), 'junction');
    await expect(previewSnapshot(join(root, 'alias', 'worktree'), '', 'static')).rejects.toMatchObject({ status: 404 });
  });

  it('skips the desktop browser profile even when the selected working directory contains it', async () => {
    put('profile-example/index.html');
    put('profile-example/browser/settings.js');
    vi.stubEnv('RELAY_APP_BROWSER_DIR', join(root, 'profile-example', 'browser'));
    try {
      expect([...(await previewSnapshot(root, 'profile-example', 'server')).keys()]).toEqual(['index.html']);
      await expect(previewSnapshot(root, 'profile-example/browser', 'server')).rejects.toMatchObject({ status: 404 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps configured homes, previous homes and Relay data out of folder and root selections', async () => {
    const base = join(root, 'privacy');
    for (const dir of [
      'project',
      'project/cli-home',
      'project/accounts',
      'project/old-homes',
      'project/relay-data',
      'project/relay-data/worktrees/chat/member',
    ]) {
      put('privacy/' + dir + '/auth.json', '{}');
    }
    vi.stubEnv('CODEX_HOME', join(base, 'project/cli-home'));
    const privateData = join(base, 'project/relay-data');
    const member = join(privateData, 'worktrees/chat/member');
    const settings = {
      agentHome: '',
      accountsDir: join(base, 'project/accounts'),
      openAgentRoots: () => [join(base, 'project/old-homes')],
      bin: () => 'missing-test-binary',
      env: () => ({ PATH: '' }),
    };
    try {
      const protect = previewPrivatePath(settings, [], privateData);
      expect([...(await previewSnapshot(base, 'project', 'server', undefined, protect)).keys()]).toEqual(['auth.json']);
      for (const dir of ['cli-home', 'accounts', 'old-homes', 'relay-data', 'relay-data/worktrees/chat/member']) {
        await expect(previewSnapshot(join(base, 'project', dir), '', 'server', undefined, protect)).rejects.toMatchObject({ status: 404 });
      }
      const permitMember = previewPrivatePath(settings, [member], privateData);
      expect([...(await previewSnapshot(member, '', 'server', undefined, permitMember)).keys()]).toEqual(['auth.json']);
      await expect(previewSnapshot(privateData, '', 'server', undefined, permitMember)).rejects.toMatchObject({ status: 404 });
      // A registered path replaced by a link cannot designate someone else's folder.
      symlinkSync(member, join(privateData, 'worktrees/chat/alias'), 'junction');
      const alias = previewPrivatePath(settings, [join(privateData, 'worktrees/chat/alias')], privateData);
      await expect(previewSnapshot(member, '', 'server', undefined, alias)).rejects.toMatchObject({ status: 404 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('bounds the scan even when directories and ignored filenames contain no publishable bytes', async () => {
    mkdirSync(join(root, 'deep', ...Array<string>(33).fill('d')), { recursive: true });
    await expect(previewSnapshot(root, 'deep', 'static')).rejects.toMatchObject({ status: 413 });
    const entries = join(root, 'entries');
    mkdirSync(entries);
    for (let i = 0; i < 4097; ++i) writeFileSync(join(entries, '.ignored-' + i), '');
    await expect(previewSnapshot(root, 'entries', 'static')).rejects.toMatchObject({ status: 413 });
  });

  it('refuses unsafe selections, oversized files and cancelled snapshots', async () => {
    put('large/big.js');
    truncateSync(join(root, 'large/big.js'), 17 * 1024 * 1024);
    await expect(previewSnapshot(root, 'large', 'static')).rejects.toThrow();
    for (const path of ['../', '/app', 'c:/app', 'app/../app', 'project/.git', 'project/secrets', 'project:dir', 'project\\linked-dir']) {
      await expect(previewSnapshot(root, path, 'server')).rejects.toThrow();
    }
    await expect(previewSnapshot(root, 'app', 'build', AbortSignal.abort())).rejects.toThrow();
  });
});

describe('public preview files', () => {
  const files = new Map(
    [
      'page.html',
      'assets/a b.js',
      'unknown.constructor',
      'docs/index.html',
      'config.json',
      '.env',
      'backend/server.js',
      'x.js.map',
      'private-key.js',
    ].map((name) => [name, Buffer.from(name)]),
  );
  const get = (path: string, method = 'GET') =>
    previewFileResponse(files, new Request('https://app.example' + path, { method }), 'page.html');

  it('serves exact static assets, entry documents and directory indexes with their own MIME types', async () => {
    expect(await get('/').text()).toBe('page.html');
    expect(await get('/docs/').text()).toBe('docs/index.html');
    const js = get('/assets/a%20b.js?v=2');
    expect(js.headers.get('Content-Type')).toContain('javascript');
    expect(js.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await js.text()).toBe('assets/a b.js');
    const head = get('/', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('rejects methods and paths outside the public asset allowlist, even if the map contains them', () => {
    for (const path of [
      '/missing.html',
      '/unknown.constructor',
      '/config.json',
      '/.env',
      '/backend/server.js',
      '/x.js.map',
      '/private-key.js',
      '/x%2fa.js',
      '/%00.js',
      '/%ff',
    ]) {
      expect(get(path).status, path).toBe(404);
    }
    expect(get('/page.html', 'POST').status).toBe(405);
  });
});
