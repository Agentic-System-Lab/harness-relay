/**
 * Builds the desktop app into desktop/build/ (`npm run desktop`, `npm run desktop:dist`), after the
 * web app is built (`npm run build`):
 *
 * - build/app/: what Electron runs (main.cjs, its package.json, the tray icons), and the LICENSE whose
 *   terms its package.json names (electron-builder.yml also puts it in the app's resources, to be opened);
 * - build/server/: the server as one file (server.mjs), the built web app (web/) and the keyring
 *   module, which is native code and stays a separate package (node_modules/@napi-rs/); the relay
 *   sandbox's host (relaySandboxHost.mjs, which the server starts with a Node on PATH, since the app's
 *   runtime may not run as Node) and sandbox-runtime with its packages (node_modules/), which reads
 *   files of its own at run time (its Linux seccomp helpers); Pi's gate extension (piGate.js);
 * - build/resources/: the app icon, for electron-builder.
 *
 * RELAY_VERSION (set by the Release workflow) is the release's version, such as 2026-11-10-rc.1: it
 * must follow the rules in scripts/release.ts. The app is then built as that version (its semver in
 * package.json, the version itself in its menu and log). Without it, the app is a build of the day,
 * in Taiwan as releases are, with the commit it was built from: 2026-11-10-dev (30f3d4f), semver
 * 2026.1110.0-dev, which any release of that day or later is newer than (the app offers it as an update).
 *
 * RELAY_UPDATES_REPO (owner/name) is the repository the app downloads its updates (the installers'
 * copies) from, UPDATES_REPO (site/assets/downloads.js) when it is not set; RELAY_UPDATES_TOKEN, a token
 * for GitHub's API the app downloads them with, for a private one (none: from a public one without
 * signing in). The Release workflow sets them from its UPDATES_REPO variable and UPDATES_READ_TOKEN
 * secret. Both go into the app as they are (src/updateSource.ts): anyone with a copy can read the token.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DESKTOP_ICONS, encodePngRgba, rasterizeIcon } from '../src/icons';
import { appManifest } from '../src/manifest';
import { updateSourceFrom } from '../src/updateSource';
import { devVersion, parseVersion, RELEASE_TIME_ZONE, semverOf, todayIn } from '../../scripts/release';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(DESKTOP, '..');
const OUT = join(DESKTOP, 'build');
/** Electron 45 runs Node 24. */
const TARGET = 'node24';

const web = join(ROOT, 'dist', 'web');
if (!existsSync(join(web, 'index.html'))) {
  console.error('The web app is not built: run `npm run build` first (npm run desktop does).');
  process.exit(1);
}

const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { description?: string; license?: string };
/** The commit being built, when this is a git checkout. */
function commit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}
const dev = devVersion(todayIn(process.env.RELEASE_TIME_ZONE?.trim() || RELEASE_TIME_ZONE), commit());
let version = { app: dev.semver, shown: dev.shown };
const release = process.env.RELAY_VERSION?.trim();
if (release) {
  const parsed = parseVersion(release);
  if (!parsed.ok) {
    console.error(`RELAY_VERSION: ${parsed.error}`);
    process.exit(1);
  }
  version = { app: semverOf(parsed.value), shown: parsed.value.version };
}
const updates = updateSourceFrom(process.env);
if (!updates.ok) {
  console.error(updates.error);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });

// The server, as one ES module. `require` is for the keyring module, loaded with createRequire.
await build({
  entryPoints: [join(ROOT, 'src/server/index.ts')],
  outfile: join(OUT, 'server/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: TARGET,
  external: ['@napi-rs/keyring'],
  // The version a problem report names (src/server/about.ts).
  define: { __RELAY_VERSION__: JSON.stringify(version.shown) },
  banner: { js: "import { createRequire as __relayRequire } from 'node:module'; const require = __relayRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
cpSync(web, join(OUT, 'server/web'), { recursive: true });

// The relay sandbox's host, as one ES module beside the server (relaySandbox.ts finds it there), with
// sandbox-runtime left as a package: it reads its own files at run time (vendor/seccomp on Linux).
await build({
  entryPoints: [join(ROOT, 'src/server/relaySandboxHost.ts')],
  outfile: join(OUT, 'server/relaySandboxHost.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: TARGET,
  external: ['@anthropic-ai/sandbox-runtime'],
  legalComments: 'none',
  logLevel: 'warning',
});
// Pi's gate extension, loaded by Pi by its absolute path beside the server (pi.ts, PI_GATE_PATH).
cpSync(join(ROOT, 'src/server/agents/piGate.js'), join(OUT, 'server/piGate.js'));
// sandbox-runtime and what it needs, as npm installed them (its own nested node_modules included).
for (const pkg of ['@anthropic-ai/sandbox-runtime', '@pondwader/socks5-server', 'node-forge', 'zod']) {
  const from = join(ROOT, 'node_modules', pkg);
  if (!existsSync(from)) {
    console.error(`${pkg} is missing from node_modules: run \`npm install\` first.`);
    process.exit(1);
  }
  cpSync(from, join(OUT, 'server/node_modules', pkg), { recursive: true, dereference: true });
}

// The keyring module and the native part for this platform (npm installs only that one).
const napi = join(ROOT, 'node_modules/@napi-rs');
const keyring = readdirSync(napi).filter((name) => name === 'keyring' || name.startsWith('keyring-'));
if (!keyring.includes('keyring') || keyring.length < 2) {
  console.error('@napi-rs/keyring is missing from node_modules: run `npm install` first.');
  process.exit(1);
}
for (const name of keyring) cpSync(join(napi, name), join(OUT, 'server/node_modules/@napi-rs', name), { recursive: true });

// The app: the main process as one CommonJS file (Electron itself is provided at run time).
await build({
  entryPoints: [join(DESKTOP, 'src/main.ts')],
  outfile: join(OUT, 'app/main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: TARGET,
  external: ['electron'],
  // import.meta.url: scripts/release.ts (version rules) checks it to run as a script, never true in the app.
  // Where it downloads its updates from (main.ts), the token included.
  define: { __RELAY_VERSION__: JSON.stringify(version.shown), __RELAY_UPDATE_SOURCE__: JSON.stringify(updates.value), 'import.meta.url': 'undefined' },
  legalComments: 'none',
  logLevel: 'warning',
});
writeFileSync(join(OUT, 'app/package.json'), `${JSON.stringify(appManifest({ ...rootPackage, version: version.app }), null, 2)}\n`);
// The license's terms, which go with every copy, beside the package.json whose `license` names them.
cpSync(join(ROOT, 'LICENSE'), join(OUT, 'app/LICENSE'));

for (const icon of DESKTOP_ICONS) {
  const dir = icon.file === 'icon.png' ? join(OUT, 'resources') : join(OUT, 'app/icons');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, icon.file), encodePngRgba(icon.size, rasterizeIcon(icon)));
}

const from = `updates downloaded from ${updates.value.repo}${updates.value.token ? ', with a token' : ''}`;
console.log(`Desktop app ${version.shown} (${version.app}) built in ${OUT} (keyring: ${keyring.filter((n) => n !== 'keyring').join(', ')}; ${from})`);
