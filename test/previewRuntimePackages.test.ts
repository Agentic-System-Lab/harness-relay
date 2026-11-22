import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { lockedPreviewPackages, fetchPreviewPackage } from '../src/server/previewDockerPackages';

const tarball = Buffer.from([0, 255, 254, 13]);
const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
const pkg = { version: '1.0.0', resolved: 'https://registry.npmjs.org/@scope/demo/-/demo-1.0.0.tgz', integrity };
function project(change = {}, manifest = {}, name = 'node_modules/@scope/demo') {
  return new Map([
    ['package.json', Buffer.from(JSON.stringify(manifest))],
    ['package-lock.json', Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, [name]: { ...pkg, ...change } } }))],
  ]);
}

it('derives canonical public registry tarballs from the install path and version, selecting packages for the container', () => {
  expect(lockedPreviewPackages(project()).arm64).toEqual([{ url: pkg.resolved, integrity }]);
  expect(lockedPreviewPackages(project({ optional: true, cpu: ['x64'] })).arm64).toEqual([]);
  expect(lockedPreviewPackages(project({ cpu: ['!x64'], os: ['linux'] })).arm64).toHaveLength(1);
  expect(lockedPreviewPackages(project({ optional: true, libc: ['musl'] })).arm64).toEqual([]);
});
it.each([
  { resolved: 'https://example.org/x.tgz' },
  { resolved: pkg.resolved + '?token=hello' },
  { resolved: 'file:../archive' },
  { version: '../x' },
  { integrity: 'sha1-xxxx' },
  { link: true },
  { resolved: 'https://registry.npmjs.org/other/-/demo-1.0.0.tgz' },
  { dependencies: { demo: 'file:../demo' } },
])('rejects unsupported locks before making requests, %o', (change) => {
  expect(() => lockedPreviewPackages(project(change)).arm64).toThrow();
});
it.each(['../local', 'file:../other', 'github:a/b', 'https://example.org/pkg.tgz', 'user/repo'])(
  'refuses external or local dependency %s in the project manifest',
  (spec) => {
    expect(() => lockedPreviewPackages(project({}, { dependencies: { demo: spec } })).arm64).toThrow();
  },
);
it('requires a modern lockfile and rejects competing npm configuration', () => {
  expect(() => lockedPreviewPackages(new Map()).x64).toThrow(/lockfile|package-lock/);
  const files = project();
  files.set('npm-shrinkwrap.json', Buffer.from('{}'));
  expect(() => lockedPreviewPackages(files).x64).toThrow();
});
it('checks integrity, refuses redirects and bounds the actual download', async () => {
  const [lock] = lockedPreviewPackages(project()).x64;
  const get = vi.fn(async () => new Response(tarball));
  const signal = new AbortController().signal;
  expect(await fetchPreviewPackage(lock, signal, 20, get)).toEqual(tarball);
  expect(get).toHaveBeenCalledWith(pkg.resolved, expect.objectContaining({ redirect: 'error', credentials: 'omit', signal }));
  await expect(fetchPreviewPackage(lock, signal, 2, get)).rejects.toThrow(/size|大小/);
  await expect(fetchPreviewPackage(lock, signal, 20, async () => new Response('wrong digest'))).rejects.toThrow(/SHA-512/);
});

it('explains an unsupported npm lockfile in the current request language', async () => {
  const { withLang } = await import('../src/server/i18n');
  expect(() => withLang('en', () => lockedPreviewPackages(new Map()).arm64)).toThrow(/requires/);
  expect(() => withLang('zh-TW', () => lockedPreviewPackages(new Map()).arm64)).toThrow(/需要/);
});

it('refuses external sources in nested npm overrides', () => {
  expect(() => lockedPreviewPackages(project({}, { overrides: { parent: { demo: 'file:../local' } } })).arm64).toThrow();
});

/** An npm workspace root: its manifest, its lockfile and its members' manifests, as the snapshot holds them. */
function workspace(lockPackages: Record<string, object>, members: Record<string, object> = { 'apps/web': {} }, manifest: object = {}) {
  return new Map([
    ['package.json', Buffer.from(JSON.stringify({ workspaces: ['apps/*'], ...manifest }))],
    [
      'package-lock.json',
      Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { '': { workspaces: ['apps/*'] }, ...lockPackages } })),
    ],
    ...Object.entries(members).map(([folder, pkg]) => [folder + '/package.json', Buffer.from(JSON.stringify(pkg))] as [string, Buffer]),
  ]);
}

it('accepts an npm workspace: members in place, npm’s links to them and packages installed under a member', () => {
  const files = workspace(
    {
      'apps/web': { version: '1.0.0', dependencies: { '@scope/demo': '^1.0.0' } },
      'node_modules/web': { resolved: 'apps/web', link: true },
      'apps/web/node_modules/@scope/demo': pkg,
    },
    { 'apps/web': { scripts: { build: 'vite build' }, dependencies: { '@scope/demo': '^1.0.0' } } },
  );
  expect(lockedPreviewPackages(files, 'build', 'apps/web').arm64).toEqual([{ url: pkg.resolved, integrity }]);
  // The selected member's own script and npm's server.js default decide, not the root's.
  expect(() => lockedPreviewPackages(files, 'server', 'apps/web')).toThrow(/start/);
  files.set('apps/web/server.js', Buffer.from(''));
  expect(lockedPreviewPackages(files, 'server', 'apps/web').x64).toHaveLength(1);
});

it.each([
  ['a link to a folder that is not a member', { 'apps/web': {}, 'node_modules/web': { resolved: 'libs/web', link: true } }],
  ['a link nested under a member', { 'apps/web': {}, 'apps/web/node_modules/web': { resolved: 'apps/web', link: true } }],
  ['a package under a folder that is not a member', { 'apps/web': {}, 'libs/node_modules/@scope/demo': pkg }],
  ['a member outside the root', { '../web': {} }],
  ['a member that declares workspaces of its own', { 'apps/web': { workspaces: ['inner'] } }],
])('refuses a workspace lock with %s', (_, lockPackages) => {
  expect(() => lockedPreviewPackages(workspace(lockPackages), undefined, 'apps/web')).toThrow();
});

it('refuses members without a workspace root and a selected project the root’s lock does not list', async () => {
  const { withLang } = await import('../src/server/i18n');
  expect(() => lockedPreviewPackages(project({}, {}, 'apps/web'))).toThrow();
  expect(() => withLang('en', () => lockedPreviewPackages(workspace({ 'apps/web': {} }), undefined, 'apps/api'))).toThrow(
    /does not list this project/,
  );
});

it('names a dependency added to package.json without npm install, before npm would look it up offline', async () => {
  const { withLang } = await import('../src/server/i18n');
  const files = project({}, { devDependencies: { '@scope/demo': '1.0.0', concurrently: '^9.1.2' } });
  const synced = JSON.parse(files.get('package-lock.json')!.toString());
  synced.packages[''] = { devDependencies: { '@scope/demo': '1.0.0' } };
  files.set('package-lock.json', Buffer.from(JSON.stringify(synced)));
  expect(() => withLang('en', () => lockedPreviewPackages(files))).toThrow(
    /concurrently is in package\.json but not in package-lock\.json/,
  );
  expect(() => withLang('zh-TW', () => lockedPreviewPackages(files))).toThrow(/concurrently.*npm install/);
  // A member's manifest is compared with the lock's record of that member, the root's with the root's.
  const member = workspace(
    { 'apps/web': { dependencies: { react: '^19.0.0' } } },
    { 'apps/web': { dependencies: { react: '^19.0.0', vite: '^7.0.0' } } },
  );
  expect(() => withLang('en', () => lockedPreviewPackages(member, undefined, 'apps/web'))).toThrow(/vite is in package\.json/);
  const recorded = project({ optional: true }, { optionalDependencies: { '@scope/demo': '1.0.0' } });
  const lock = JSON.parse(recorded.get('package-lock.json')!.toString());
  lock.packages[''] = { dependencies: { '@scope/demo': '1.0.0' }, optionalDependencies: { '@scope/demo': '1.0.0' } };
  recorded.set('package-lock.json', Buffer.from(JSON.stringify(lock)));
  // npm records an optional dependency among the dependencies too.
  expect(lockedPreviewPackages(recorded).x64).toHaveLength(1);
});
