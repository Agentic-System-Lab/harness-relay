/**
 * Before any test: the UI is built (again when a file it is built from is newer than the build), as
 * `npm run build` makes it and as a development build (`DEV_WEB_DIR`), and the fake CLIs are
 * installed. E2E_BUILD=always builds both every run, E2E_BUILD=never never does (CI builds them in
 * steps of their own, the same way).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installFakeClis } from './support/fake-cli';
import { DEV_WEB_DIR, ROOT, WEB_DIR } from './support/paths';

/** The newest modification time of the files under `path`. */
function newest(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let latest = 0;
  for (const name of readdirSync(path)) latest = Math.max(latest, newest(join(path, name)));
  return latest;
}

/** The two builds: Vite's arguments and environment for each. */
const BUILDS = [
  { dir: WEB_DIR, args: ['--logLevel', 'warn'], env: {} },
  // Its chunks are not minified, so past the startup limit: only errors are worth showing.
  { dir: DEV_WEB_DIR, args: ['--outDir', DEV_WEB_DIR, '--emptyOutDir', '--logLevel', 'error'], env: { NODE_ENV: 'development' } },
];

function uiIsCurrent(dir: string): boolean {
  const index = join(dir, 'index.html');
  if (!existsSync(index)) return false;
  const built = statSync(index).mtimeMs;
  const sources = ['src/web', 'src/shared', 'vite.config.ts', 'package-lock.json'].map((p) => newest(join(ROOT, p)));
  return Math.max(...sources) <= built;
}

export default async function globalSetup(): Promise<void> {
  const mode = process.env.E2E_BUILD ?? 'auto';
  for (const b of BUILDS) {
    if (mode === 'always' || (mode !== 'never' && !uiIsCurrent(b.dir))) {
      console.log(`[e2e] building the UI into ${b.dir}…`);
      // Vite's own script, run by this Node: no shell, so the same on every system.
      const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', ...b.args], {
        cwd: ROOT,
        env: { ...process.env, ...b.env },
        stdio: 'inherit',
      });
      if (r.status !== 0) throw new Error(`Building the UI into ${b.dir} failed (${r.status ?? r.error})`);
    }
    if (!existsSync(join(b.dir, 'index.html'))) throw new Error(`The UI is not built in ${b.dir}: run \`npm run test:e2e\` without E2E_BUILD=never.`);
  }
  const dir = await installFakeClis();
  // Workers read it (they inherit the environment set here).
  process.env.E2E_FAKE_BIN_DIR = dir;
}
