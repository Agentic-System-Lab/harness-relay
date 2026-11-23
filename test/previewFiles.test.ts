import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { withholdFile } from '../src/server/db';
import { pageReferences, previewFileResponse, previewPrivatePath, previewSnapshot, resolvePageReference } from '../src/server/previewFiles';

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
    // A folder that copies whole is copied whole, its page given or not.
    expect(first.partial).toBe(false);
    const whole = await previewSnapshot(root, site, 'static', undefined, previewPrivatePath(), 'index.html');
    expect([...whole.keys()].sort()).toEqual([...first.keys()].sort());
    expect(whole.partial).toBe(false);
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
    for (const mode of ['static', 'server', 'build', 'container'] as const) {
      expect([...(await previewSnapshot(root, 'project', mode)).keys()]).toEqual(['index.html']);
    }
    await expect(previewSnapshot(root, 'project/linked-dir/public', 'static')).rejects.toThrow();
  });

  it('gives a container build any language’s files, with the dotfiles that pin versions, but no build output or virtualenv', async () => {
    for (const name of [
      'Dockerfile',
      'compose.yaml',
      'requirements.txt',
      'app/main.py',
      'go.mod',
      'go.sum',
      'Cargo.lock',
      'src/main.rs',
      'Gemfile',
      'Makefile',
      '.dockerignore',
      '.python-version',
      '.env',
      '.git/config',
      'target/debug/app',
      'venv/bin/python',
      '.venv/bin/python',
      'node_modules/x/index.js',
    ])
      put('polyglot/' + name);
    expect([...(await previewSnapshot(root, 'polyglot', 'container')).keys()].sort()).toEqual([
      '.dockerignore',
      '.python-version',
      'Cargo.lock',
      'Dockerfile',
      'Gemfile',
      'Makefile',
      'app/main.py',
      'compose.yaml',
      'go.mod',
      'go.sum',
      'requirements.txt',
      'src/main.rs',
    ]);
    // The npm runtime still gets only what an npm build reads.
    expect([...(await previewSnapshot(root, 'polyglot', 'build')).keys()]).not.toContain('app/main.py');
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

describe("a static page in a folder too large to copy whole (a working directory's top)", () => {
  const big = (name: string) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'many'), { recursive: true });
    for (let i = 0; i < 4097; ++i) writeFileSync(join(dir, 'many', `n${i}.txt`), '');
    return dir;
  };

  it('copies the page and the files it names, followed through stylesheets, scripts and SVGs, and nothing else', async () => {
    const dir = big('top');
    const at = (path: string, body: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    };
    at(
      'deck.html',
      [
        '<link rel="stylesheet" href="assets/deck.css?v=2">',
        '<script type="module" src="./assets/app.mjs"></script>',
        '<img srcset="img/a.png 1x, img/b.png 2x" src=img/a.png>',
        '<a href="docs/">docs</a> <a href="https://example.com/x.png">far</a> <a href="#top">top</a>',
        '<img src="data:image/png;base64,AAAA"> <img src="../outside.png"> <img src="img/missing.png">',
        '<img src="nowhere/x.png"> <img src="linked/x.png"> <img src="img/withheld.png">',
      ].join('\n'),
    );
    at('assets/deck.css', "@import 'theme.css'; body { background: url(../img/bg.svg) }");
    at('assets/theme.css', 'h1 { color: red }');
    at('assets/app.mjs', "import { x } from './util.js'; fetch('img/data-chart.png');");
    at('assets/util.js', 'export const x = 1;');
    at('img/bg.svg', '<svg><image href="pattern.png"/></svg>');
    for (const f of ['img/a.png', 'img/b.png', 'img/pattern.png', 'img/data-chart.png', 'img/withheld.png', 'img/unnamed.png']) at(f, f);
    at('docs/index.html', '<p>docs</p>');
    at('unrelated.html', 'not named');
    writeFileSync(join(root, 'outside.png'), 'outside');
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'x.png'), 'elsewhere');
    symlinkSync(join(root, 'elsewhere'), join(dir, 'linked'), 'junction');
    withholdFile(join(dir, 'img/withheld.png'));

    const snapshot = await previewSnapshot(dir, '', 'static', undefined, previewPrivatePath(), 'deck.html');
    expect([...snapshot.keys()].sort()).toEqual([
      'assets/app.mjs',
      'assets/deck.css',
      'assets/theme.css',
      'assets/util.js',
      'deck.html',
      'docs/index.html',
      'img/a.png',
      'img/b.png',
      'img/bg.svg',
      'img/data-chart.png',
      'img/pattern.png',
    ]);
    expect(snapshot.partial).toBe(true);
    // Without its page, the folder is still too large.
    await expect(previewSnapshot(dir, '', 'static')).rejects.toMatchObject({ status: 413 });
    // A server or build preview still needs the whole folder.
    await expect(previewSnapshot(dir, '', 'build', undefined, previewPrivatePath(), 'deck.html')).rejects.toMatchObject({ status: 413 });
  });

  it('leaves out what the whole copy leaves out: a private folder, a hard link, a source folder, a name in another case', async () => {
    const dir = big('top-private');
    const at = (path: string, body = path) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    };
    at(
      'page.html',
      '<img src="data/shot.png"> <img src="linked.png"> <script src="src/app.js"></script> <img src="IMG/A.PNG"> <img src="img/A.PNG"> <img src="img/a.png">',
    );
    at('data/shot.png');
    at('src/app.js');
    at('img/a.png');
    writeFileSync(join(root, 'hard-target.png'), 'x');
    linkSync(join(root, 'hard-target.png'), join(dir, 'linked.png'));
    // Relay's data folder inside the working directory.
    const isPrivate = previewPrivatePath(undefined, [], join(dir, 'data'));
    const snapshot = await previewSnapshot(dir, '', 'static', undefined, isPrivate, 'page.html');
    expect([...snapshot.keys()].sort()).toEqual(['img/a.png', 'page.html']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'opens the page when a folder in its working directory cannot be read',
    async () => {
      const dir = join(root, 'top-locked');
      mkdirSync(join(dir, 'locked'), { recursive: true });
      writeFileSync(join(dir, 'page.html'), '<h1>hi</h1>');
      chmodSync(join(dir, 'locked'), 0o000);
      try {
        await expect(previewSnapshot(dir, '', 'static')).rejects.toMatchObject({ status: 404 });
        const snapshot = await previewSnapshot(dir, '', 'static', undefined, previewPrivatePath(), 'page.html');
        expect([...snapshot.keys()]).toEqual(['page.html']);
        expect(snapshot.partial).toBe(true);
      } finally {
        chmodSync(join(dir, 'locked'), 0o700);
      }
    },
  );

  it('stops at a page that names more files than it may have looked for', async () => {
    const dir = big('top-many-names');
    writeFileSync(join(dir, 'page.html'), `<script>${Array.from({ length: 4 * 4096 + 1 }, (_, i) => `'x${i}.png'`).join(';')}</script>`);
    await expect(previewSnapshot(dir, '', 'static', undefined, previewPrivatePath(), 'page.html')).rejects.toMatchObject({ status: 413 });
  });

  it('says the page is too large when what it names is, and that it is missing when it is', async () => {
    const dir = big('top-large');
    writeFileSync(join(dir, 'page.html'), '<video src="clip.mp4"></video>');
    writeFileSync(join(dir, 'clip.mp4'), '');
    truncateSync(join(dir, 'clip.mp4'), 17 * 1024 * 1024);
    await expect(previewSnapshot(dir, '', 'static', undefined, previewPrivatePath(), 'page.html')).rejects.toMatchObject({
      status: 413,
      message: expect.stringContaining('這個網頁和它用到的檔案'),
    });
    await expect(previewSnapshot(dir, '', 'static', undefined, previewPrivatePath(), 'gone.html')).rejects.toMatchObject({ status: 404 });
  });

  it('reads the addresses a page names, and where each is in the preview', () => {
    const refs = (text: string) => pageReferences(text).flatMap((ref) => resolvePageReference('page.html', ref) ?? []);
    expect(refs('<a href="a.html">x</a> <img srcset="s.png 1x, t.png 2x"> url( u.css ) <img src=v.png>')).toEqual([
      'a.html',
      's.png',
      't.png',
      'u.css',
      'v.png',
    ]);
    // A name with spaces, one srcset candidate, an entity, a template literal with nothing to fill in.
    expect(refs('<img src="my photo.png"> <img srcset="hero@2x.png 2x"> <img src="a&amp;b.png"> fetch(`img/c.png`)')).toEqual([
      'my photo.png',
      'hero@2x.png',
      'a&b.png',
      'img/c.png',
    ]);
    expect(refs('fetch(`img/${name}.png`)')).toEqual([]);
    expect(pageReferences('<a href="https://x.example/a.png"> <a href="//cdn/x.js"> <a href="#a"> "mailto:a@b" "${x}.png"')).toEqual([]);
    expect(resolvePageReference('deck.html', 'img/a.png?x#y')).toBe('img/a.png');
    expect(resolvePageReference('assets/deck.css', '../img/a.png')).toBe('img/a.png');
    expect(resolvePageReference('assets/deck.css', '/img/a.png')).toBe('img/a.png');
    expect(resolvePageReference('deck.html', 'docs/')).toBe('docs/index.html');
    expect(resolvePageReference('deck.html', 'a%20b.png')).toBe('a b.png');
    // Outside the folder, no file of a preview, or nothing a preview serves.
    expect(resolvePageReference('deck.html', '../a.png')).toBeUndefined();
    expect(resolvePageReference('deck.html', 'notes.txt')).toBeUndefined();
    expect(resolvePageReference('deck.html', 'src/app.js')).toBeUndefined();
    expect(resolvePageReference('deck.html', '.env.png')).toBeUndefined();
    expect(resolvePageReference('deck.html', '%E0%A4%A.png')).toBeUndefined();
    // One part of an address is one name, as the server reads it.
    expect(resolvePageReference('deck.html', 'img%2Fa.png')).toBeUndefined();
    expect(resolvePageReference('deck.html', '..%2Fa.png')).toBeUndefined();
  });

  it('reads any text a page names in linear time', () => {
    // Each of these took minutes or more with a pattern that could match across another's start.
    for (const text of ['url('.repeat(1_000_000), ('"' + 'a'.repeat(2047)).repeat(500), 'src='.repeat(1_000_000)]) {
      const start = performance.now();
      pageReferences(text);
      expect(performance.now() - start).toBeLessThan(3000);
    }
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
