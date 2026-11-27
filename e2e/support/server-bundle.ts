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
 * not replace a file another's servers are starting from.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { ROOT, SERVER_BUNDLE_DIR, SERVER_BUNDLE_ENTRY } from './paths';

const NODE_TARGET = 'node22';

/** Writes `bytes` to `file` unless it holds them already, through a temporary file renamed over it. */
function writeIfChanged(file: string, bytes: Uint8Array): void {
  if (existsSync(file) && Buffer.compare(readFileSync(file), bytes) === 0) return;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}

/** One module of the server's, bundled: its bytes, nothing written. */
async function bundle(entry: string, external: string[]): Promise<Uint8Array> {
  const result = await build({
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
  return result.outputFiles[0]!.contents;
}

/** Bundles the server and what it starts beside it into `SERVER_BUNDLE_DIR`, and returns the server's entry. */
export async function buildServerBundle(): Promise<string> {
  const [server, host] = await Promise.all([
    bundle('src/server/index.ts', ['@napi-rs/keyring']),
    bundle('src/server/relaySandboxHost.ts', ['@anthropic-ai/sandbox-runtime']),
  ]);
  mkdirSync(SERVER_BUNDLE_DIR, { recursive: true });
  writeIfChanged(join(SERVER_BUNDLE_DIR, 'relaySandboxHost.mjs'), host);
  writeIfChanged(join(SERVER_BUNDLE_DIR, 'piGate.js'), readFileSync(join(ROOT, 'src', 'server', 'agents', 'piGate.js')));
  // The server last: a server started from it finds what it starts beside it already there.
  writeIfChanged(SERVER_BUNDLE_ENTRY, server);
  return SERVER_BUNDLE_ENTRY;
}
