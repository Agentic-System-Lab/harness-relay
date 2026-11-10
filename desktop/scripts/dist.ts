/**
 * `npm run desktop:dist`: makes the installer for this system into desktop/release/ (electron-builder,
 * desktop/electron-builder.yml), and ends by saying what to double-click. On macOS it is signed ad hoc,
 * never with a certificate electron-builder would otherwise pick from the keychain. The Release
 * workflow calls electron-builder itself, for a universal Mac app and the release's file names.
 *
 * `--output <folder>` puts the result elsewhere (to try a build without replacing an app in use).
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(DESKTOP, '..');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const at = process.argv.indexOf('--output');
const output = at >= 0 ? resolve(process.argv[at + 1] ?? '') : join(DESKTOP, 'release');

const files = await builder.build({ projectDir: DESKTOP, publish: 'never', config: { directories: { output } } });
// From the repository's root, where npm run desktop:dist was typed (npm runs this script in desktop/).
const shown = (p: string) => {
  const r = relative(ROOT, p);
  return r && !r.startsWith('..') ? r : p;
};
const installers = files.filter((f) => /\.(dmg|exe|AppImage)$/.test(f));
// The app as electron-builder left it next to the installer: mac-arm64/Harness Relay.app, win-unpacked/…
const apps = readdirSync(output, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^(mac|win|linux)/.test(d.name))
  .flatMap((d) => {
    const dir = join(output, d.name);
    const app = join(dir, 'Harness Relay.app');
    if (existsSync(app)) return [app];
    const exe = join(dir, 'Harness Relay.exe');
    return existsSync(exe) ? [exe] : [];
  });

console.log('');
for (const f of installers) console.log(`Installer: ${shown(f)}  (double-click it to install Harness Relay)`);
for (const a of apps) console.log(`The app:   ${shown(a)}  (double-click it to start Harness Relay without installing it)`);
if (!installers.length) console.log(`Done: see ${shown(output)}.`);
