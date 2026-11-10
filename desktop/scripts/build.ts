/**
 * Builds the desktop app into desktop/build/ (`npm run desktop`, `npm run desktop:dist`), after the
 * web app is built (`npm run build`):
 *
 * - build/app/: what Electron runs (main.cjs, its package.json, the tray icons);
 * - build/server/: the server as one file (server.mjs), the built web app (web/) and the keyring
 *   module, which is native code and stays a separate package (node_modules/@napi-rs/);
 * - build/resources/: the app icon, for electron-builder.
 *
 * RELAY_VERSION (set by the Release workflow) is the release's version, such as 2026-11-10-rc.1: it
 * must follow the rules in scripts/release.ts. The app is then built as that version (its semver in
 * package.json, the version itself in its menu and log). Without it, it is the root package's.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DESKTOP_ICONS, encodePngRgba, rasterizeIcon } from '../src/icons';
import { appManifest } from '../src/manifest';
import { parseVersion, semverOf } from '../../scripts/release';

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

const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string; description?: string; license?: string };
let version = { app: rootPackage.version, shown: rootPackage.version };
const release = process.env.RELAY_VERSION?.trim();
if (release) {
  const parsed = parseVersion(release);
  if (!parsed.ok) {
    console.error(`RELAY_VERSION: ${parsed.error}`);
    process.exit(1);
  }
  version = { app: semverOf(parsed.value), shown: parsed.value.version };
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
  banner: { js: "import { createRequire as __relayRequire } from 'node:module'; const require = __relayRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
cpSync(web, join(OUT, 'server/web'), { recursive: true });

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
  define: { __RELAY_VERSION__: JSON.stringify(version.shown) },
  legalComments: 'none',
  logLevel: 'warning',
});
writeFileSync(join(OUT, 'app/package.json'), `${JSON.stringify(appManifest({ ...rootPackage, version: version.app }), null, 2)}\n`);

for (const icon of DESKTOP_ICONS) {
  const dir = icon.file === 'icon.png' ? join(OUT, 'resources') : join(OUT, 'app/icons');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, icon.file), encodePngRgba(icon.size, rasterizeIcon(icon)));
}

console.log(`Desktop app ${version.shown} (${version.app}) built in ${OUT} (keyring: ${keyring.filter((n) => n !== 'keyring').join(', ')})`);
