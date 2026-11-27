import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, SERVER_BUNDLE_DIR, SERVER_BUNDLE_ENTRY } from '../e2e/support/paths';
import { buildServerBundle, serverBundleCurrent, serverToStart } from '../e2e/support/server-bundle';
import { slow } from './timeouts';

describe('the server bundled for the end-to-end tests', () => {
  it('is two folders below the repository, as src/server is, so that it finds the repository where its source does', () => {
    // RELAY_ROOT (src/server/protect.ts) is two folders up from the server's own file.
    expect(resolve(dirname(SERVER_BUNDLE_ENTRY), '..', '..')).toBe(resolve(ROOT));
    expect(resolve(ROOT, 'src', 'server', '..', '..')).toBe(resolve(ROOT));
  });

  it('is current only while none of the files it was built from changed since', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-e2e-bundle-'));
    try {
      const entry = join(dir, 'server.mjs');
      writeFileSync(entry, '');
      const input = join(dir, 'input.ts');
      writeFileSync(input, '');
      const at = (file: string, seconds: number) => utimesSync(file, seconds, seconds);
      // Never current without the list of its files.
      expect(serverBundleCurrent(entry)).toBe(false);
      writeFileSync(join(dir, 'inputs.json'), JSON.stringify([relative(ROOT, input)]));
      at(input, 1_000_000);
      at(entry, 2_000_000);
      expect(serverBundleCurrent(entry)).toBe(true);
      // A file changed since it was built (in --ui or a watch).
      at(input, 3_000_000);
      expect(serverBundleCurrent(entry)).toBe(false);
      // A file gone, an empty list, no bundle.
      at(input, 1_000_000);
      writeFileSync(join(dir, 'inputs.json'), JSON.stringify([relative(ROOT, join(dir, 'gone.ts'))]));
      expect(serverBundleCurrent(entry)).toBe(false);
      writeFileSync(join(dir, 'inputs.json'), '[]');
      expect(serverBundleCurrent(entry)).toBe(false);
      expect(serverBundleCurrent(join(dir, 'none.mjs'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'bundles the server with what it starts beside it, lists its files, and is current once built, also when nothing changed',
    async () => {
      const entry = await buildServerBundle();
      expect(entry).toBe(SERVER_BUNDLE_ENTRY);
      for (const name of ['server.mjs', 'relaySandboxHost.mjs', 'piGate.js'])
        expect(existsSync(join(SERVER_BUNDLE_DIR, name)), name).toBe(true);
      const inputs = JSON.parse(readFileSync(join(SERVER_BUNDLE_DIR, 'inputs.json'), 'utf8')) as string[];
      for (const f of ['src/server/index.ts', 'src/server/relaySandboxHost.ts', 'src/server/agents/piGate.js', 'src/shared/types.ts'])
        expect(
          inputs.map((i) => i.split('\\').join('/')),
          f,
        ).toContain(f);
      expect(inputs.some((f) => f.includes('node_modules'))).toBe(false);
      expect(serverBundleCurrent(entry)).toBe(true);
      // Built again with nothing changed: not written again, only marked as built now (else a file
      // changed since its last real write would leave it stale for good).
      const long = new Date(Date.UTC(2020, 0, 1));
      utimesSync(entry, long, long);
      await buildServerBundle();
      expect(statSync(entry).mtimeMs).toBeGreaterThan(long.getTime());
      expect(serverBundleCurrent(entry)).toBe(true);
      // The keyring and sandbox-runtime stay packages, found in the repository's node_modules.
      const server = readFileSync(entry, 'utf8');
      expect(server).toContain('@napi-rs/keyring');
      expect(readFileSync(join(SERVER_BUNDLE_DIR, 'relaySandboxHost.mjs'), 'utf8')).toContain('@anthropic-ai/sandbox-runtime');
    },
    slow(60_000),
  );

  it('is the server a test starts, unless it is stale, the source is asked for, or a hook is preloaded into the server', () => {
    const current = () => true;
    const stale = () => false;
    expect(serverToStart({ bundle: '/b/server.mjs', current })).toEqual({ bundle: '/b/server.mjs' });
    // Nothing bundled (a script of its own): the source.
    expect(serverToStart({ current })).toEqual({});
    // A server file changed since (in --ui or a watch): the source, and the bundle named as stale.
    expect(serverToStart({ bundle: '/b/server.mjs', current: stale })).toEqual({ stale: '/b/server.mjs' });
    // Asked for, for readable stack traces.
    expect(serverToStart({ bundle: '/b/server.mjs', source: '1', current })).toEqual({});
    expect(serverToStart({ bundle: '/b/server.mjs', source: '0', current })).toEqual({ bundle: '/b/server.mjs' });
    // A hook that may change one of the server's modules, which a bundle holds a copy of.
    expect(serverToStart({ bundle: '/b/server.mjs', nodeOptions: '--import=file:///x/catalog-mcp.mjs', current })).toEqual({});
    expect(serverToStart({ bundle: '/b/server.mjs', nodeOptions: '--max-old-space-size=4096', current })).toEqual({
      bundle: '/b/server.mjs',
    });
  });
});
