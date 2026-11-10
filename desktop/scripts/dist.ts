/**
 * `npm run desktop:dist`: makes the installer for this system into desktop/release/ (electron-builder,
 * desktop/electron-builder.yml), and ends by saying what to double-click. On macOS it is signed ad hoc,
 * never with a certificate electron-builder would otherwise pick from the keychain. The Release
 * workflow calls electron-builder itself, for a universal Mac app and the release's file names.
 *
 * `--output <folder>` puts the result elsewhere (to try a build without replacing an app in use):
 * `npm run desktop:dist -- --output <folder>`.
 *
 * A Harness Relay running from the output folder would have its files replaced under it, so the build
 * refuses to start then. One running from anywhere else is named at the end: opening the new build
 * while it runs brings the running one forward instead (one Harness Relay at a time).
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import builder from 'electron-builder';
import { capture } from '../../src/server/process';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(DESKTOP, '..');
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const at = process.argv.indexOf('--output');
const output = at >= 0 ? resolve(process.argv[at + 1] ?? '') : join(DESKTOP, 'release');

/** The programs of the running Harness Relay apps (macOS, Linux; on Windows a running app keeps its files locked anyway). */
async function runningApps(): Promise<string[]> {
  if (process.platform === 'win32') return [];
  try {
    const r = await capture('ps', ['-axo', 'command='], process.env, { timeoutMs: 10_000, maxCapture: 8 * 1024 * 1024 });
    return r.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /Harness Relay\.app\/Contents\/MacOS\/Harness Relay(\s|$)|\/harness-relay(\s|$)/.test(line) && !/--type=/.test(line));
  } catch {
    return [];
  }
}

const running = await runningApps();
const inOutput = running.filter((line) => line.startsWith(`${output}${sep}`));
if (inOutput.length) {
  console.error(`Harness Relay is running from ${relative(ROOT, output) || output}, whose files the build would replace under it:`);
  for (const line of inOutput) console.error(`  ${line}`);
  console.error('Quit it first (its menu → Quit Harness Relay), or build elsewhere: npm run desktop:dist -- --output <folder>.');
  process.exit(1);
}

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
if (running.length) {
  console.log('');
  console.log('Harness Relay is running. Quit it (its menu → Quit Harness Relay) before you open the new build:');
  console.log('opening it now would bring the running one forward instead.');
}
console.log(`Check the packaged app: npx tsx desktop/scripts/check-package.ts${at >= 0 ? ` --dir ${shown(output)}` : ''}`);
