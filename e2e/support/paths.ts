import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The fake `claude`, `codex` and `grok`, one script for all three. */
export const FAKE_CLI_SCRIPT = join(ROOT, 'e2e', 'fake-cli', 'fake-cli.cjs');
/** The fake folder dialog (`zenity`, which Linux finds on the PATH). */
export const FAKE_DIALOG_SCRIPT = join(ROOT, 'e2e', 'fake-cli', 'fake-dialog.cjs');
/** The fake GitHub CLI (`gh`), which shares conversations as gists. */
export const FAKE_GH_SCRIPT = join(ROOT, 'e2e', 'fake-cli', 'fake-gh.cjs');
/** The built UI the servers under test serve (`npm run build`). */
export const WEB_DIR = join(ROOT, 'dist', 'web');
/**
 * A development build of the UI (`NODE_ENV=development`), for a spec to serve (`RELAY_WEB_DIR`):
 * React's development build runs each effect twice (StrictMode), as under `npm run dev`.
 */
export const DEV_WEB_DIR = join(ROOT, 'dist', 'web-dev');
/** The server's entry point. */
export const SERVER_ENTRY = join(ROOT, 'src', 'server', 'index.ts');
