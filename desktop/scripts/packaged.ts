/**
 * The packaged apps electron-builder leaves in its output folder, next to the installers (for
 * desktop/scripts/check-package.ts; apart from it so that the tests need none of its dependencies).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface PackagedApp {
  /** What @electron/fuses reads: the .app on macOS, the executable elsewhere. */
  fuses: string;
  /** The program to run. */
  exe: string;
  /** Its resources folder (with server/ in it). */
  resources: string;
  /** A Mac app for both processors. */
  universal: boolean;
}

/** The packaged apps in `dir` (electron-builder's output folder). */
export function packagedApps(dir: string): PackagedApp[] {
  const apps: PackagedApp[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  // A universal Mac app is made from one app per processor: only the result is checked.
  const universal = entries.some((e) => e.isDirectory() && e.name === 'mac-universal');
  for (const entry of entries) {
    if (!entry.isDirectory() || /temp/i.test(entry.name)) continue;
    if (universal && entry.name.startsWith('mac') && entry.name !== 'mac-universal') continue;
    const at = join(dir, entry.name);
    const mac = join(at, 'Harness Relay.app');
    if (entry.name.startsWith('mac') && existsSync(mac)) {
      apps.push({ fuses: mac, exe: join(mac, 'Contents', 'MacOS', 'Harness Relay'), resources: join(mac, 'Contents', 'Resources'), universal: entry.name === 'mac-universal' });
    } else if (entry.name.startsWith('win') && existsSync(join(at, 'Harness Relay.exe'))) {
      apps.push({ fuses: join(at, 'Harness Relay.exe'), exe: join(at, 'Harness Relay.exe'), resources: join(at, 'resources'), universal: false });
    } else if (entry.name.startsWith('linux') && existsSync(join(at, 'harness-relay'))) {
      apps.push({ fuses: join(at, 'harness-relay'), exe: join(at, 'harness-relay'), resources: join(at, 'resources'), universal: false });
    }
  }
  return apps;
}

