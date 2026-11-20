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
