/**
 * The server the tests start, bundled once before them (`global-setup.ts`) as the desktop app bundles
 * it (desktop/scripts/build.ts): every test starts a server of its own, and Node loads one module far
 * sooner than tsx compiles and loads the server's few hundred (on Windows 2.9 s a test with tsx, of
 * the time each test takes; locally 475 ms against 215 ms).
 *
 * It is written to `SERVER_BUNDLE_DIR`, two folders below the repository as `src/server` is, so that
 * what the server finds from its own place is the same as when it runs from its source:
 * `RELAY_ROOT` (protect.ts: the repository), and beside it what it starts by path: the relay sandbox's
 * host (`relaySandboxHost.mjs`, relaySandbox.ts) and Pi's gate extension (`piGate.js`, pi.ts). The
 * packages it leaves out (the keyring, sandbox-runtime) are found in the repository's `node_modules`.
 * A file whose bytes did not change is not written again, so that runs from one checkout at once do
 * not replace a file another's servers are starting from; it is only marked as built now.
 *
 * Beside it, the files it was built from (`inputs.json`): a server file changed since (in `--ui` or a
 * watch, which bundle once for many runs) makes the tests start the server from its source again, as
 * before (`serverBundleCurrent()`), rather than an old bundle.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SERVER_BUNDLE_DIR, SERVER_BUNDLE_ENTRY } from './paths';

/** The files the bundle was built from, relative to the repository (its packages' left out). */
const INPUTS = join(SERVER_BUNDLE_DIR, 'inputs.json');

const NODE_TARGET = 'node22';

/**
 * Writes `bytes` to `file` unless it holds them already, through a temporary file renamed over it; one
 * that holds them is marked as written now, being current.
 */
function writeIfChanged(file: string, bytes: Uint8Array): void {
  if (existsSync(file) && Buffer.compare(readFileSync(file), bytes) === 0) {
    const now = new Date();
    utimesSync(file, now, now);
    return;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}

/** One module of the server's, bundled: its bytes and the repository's files it was built from, nothing written. */
async function bundle(entry: string, external: string[]): Promise<{ bytes: Uint8Array; inputs: string[] }> {
  // Loaded here alone: the workers that ask `serverBundleCurrent()` never need esbuild.
  const { build } = await import('esbuild');
  const result = await build({
    absWorkingDir: ROOT,
    metafile: true,
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: NODE_TARGET,
    external,
    // For the packages bundled in that `require()` one of their own (the desktop app's banner).
    banner: { js: "import { createRequire as __relayRequire } from 'node:module'; const require = __relayRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
    write: false,
    outfile: join(SERVER_BUNDLE_DIR, 'out.mjs'),
  });
  return {
    bytes: result.outputFiles[0]!.contents,
    inputs: Object.keys(result.metafile.inputs).filter((f) => !f.split(/[\\/]/).includes('node_modules')),
  };
}

/** Bundles the server and what it starts beside it into `SERVER_BUNDLE_DIR`, and returns the server's entry. */
export async function buildServerBundle(): Promise<string> {
  const [server, host] = await Promise.all([
    bundle('src/server/index.ts', ['@napi-rs/keyring']),
    bundle('src/server/relaySandboxHost.ts', ['@anthropic-ai/sandbox-runtime']),
  ]);
  mkdirSync(SERVER_BUNDLE_DIR, { recursive: true });
  writeIfChanged(join(SERVER_BUNDLE_DIR, 'relaySandboxHost.mjs'), host.bytes);
  const gate = join('src', 'server', 'agents', 'piGate.js');
  writeIfChanged(join(SERVER_BUNDLE_DIR, 'piGate.js'), readFileSync(join(ROOT, gate)));
  const inputs = [...new Set([...server.inputs, ...host.inputs, gate])].sort();
  writeIfChanged(INPUTS, Buffer.from(JSON.stringify(inputs, null, 1) + '\n'));
  // The server last: a server started from it finds what it starts beside it already there, and it is
  // newer than every file it was built from (`serverBundleCurrent()`).
  writeIfChanged(SERVER_BUNDLE_ENTRY, server.bytes);
  return SERVER_BUNDLE_ENTRY;
}

/**
 * Whether the bundle at `entry` is current: built after every file it was built from was last changed.
 * False when one changed since (in `--ui` or a watch), is gone, or the bundle cannot be read.
 */
export function serverBundleCurrent(entry: string): boolean {
  try {
    const built = statSync(entry).mtimeMs;
    const inputs = JSON.parse(readFileSync(join(entry, '..', 'inputs.json'), 'utf8')) as string[];
    return inputs.length > 0 && inputs.every((f) => statSync(join(ROOT, f)).mtimeMs <= built);
  } catch {
    return false;
  }
}

/**
 * The server a test starts (`relay.ts`): the bundle (E2E_SERVER_BUNDLE), which starts far sooner than
 * its source through tsx; its source when nothing bundled it, when one of its files changed since
 * (`stale`: in `--ui` or a watch), when E2E_SERVER_SOURCE=1 asks (its stack traces then name the
 * source's files), and for a test that preloads a hook into it (`NODE_OPTIONS=--import=…`): a hook may
 * change one of the server's own modules (`catalog-mcp.mjs`, `teams-download-loader.mjs`), which a
 * bundle holds a copy of.
 */
export function serverToStart(o: { bundle?: string; source?: string; nodeOptions?: string; current?: (entry: string) => boolean }): {
  bundle?: string;
  stale?: string;
} {
  if (!o.bundle || o.source === '1' || /--import\b/.test(o.nodeOptions ?? '')) return {};
  return (o.current ?? serverBundleCurrent)(o.bundle) ? { bundle: o.bundle } : { stale: o.bundle };
}
