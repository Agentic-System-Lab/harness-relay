/**
 * Before any test: the UI is built (again when a file it is built from is newer than the build) and
 * the fake CLIs are installed. E2E_BUILD=always builds the UI every run, E2E_BUILD=never never does
 * (CI builds it in a step of its own).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installFakeClis } from './support/fake-cli';
import { ROOT, WEB_DIR } from './support/paths';

/** The newest modification time of the files under `path`. */
function newest(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let latest = 0;
  for (const name of readdirSync(path)) latest = Math.max(latest, newest(join(path, name)));
  return latest;
}

function uiIsCurrent(): boolean {
  const index = join(WEB_DIR, 'index.html');
  if (!existsSync(index)) return false;
  const built = statSync(index).mtimeMs;
  const sources = ['src/web', 'src/shared', 'vite.config.ts', 'package-lock.json'].map((p) => newest(join(ROOT, p)));
  return Math.max(...sources) <= built;
}

export default async function globalSetup(): Promise<void> {
  const mode = process.env.E2E_BUILD ?? 'auto';
  if (mode === 'always' || (mode !== 'never' && !uiIsCurrent())) {
    console.log('[e2e] building the UI (npm run build)…');
    // Vite's own script, run by this Node: no shell, so the same on every system.
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`npm run build failed (${r.status ?? r.error})`);
  }
  if (!existsSync(join(WEB_DIR, 'index.html'))) throw new Error(`The UI is not built in ${WEB_DIR}: run \`npm run build\`.`);
  const dir = await installFakeClis();
  // Workers read it (they inherit the environment set here).
  process.env.E2E_FAKE_BIN_DIR = dir;
}
