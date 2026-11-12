import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The fake CLIs' modules, bundled into one script for all ten CLIs (`support/fake-cli.ts`). */
export const FAKE_CLI_DIR = join(ROOT, 'e2e', 'fake-cli');
/** The fake CLIs' entry module, in `FAKE_CLI_DIR`. */
export const FAKE_CLI_SCRIPT = join(FAKE_CLI_DIR, 'fake-cli.cjs');
/** The fake folder dialog (`zenity`, which Linux finds on the PATH). */
export const FAKE_DIALOG_SCRIPT = join(FAKE_CLI_DIR, 'fake-dialog.cjs');
/** The fake GitHub CLI (`gh`), which shares conversations as gists. */
export const FAKE_GH_SCRIPT = join(FAKE_CLI_DIR, 'fake-gh.cjs');
/** The built UI the servers under test serve (`npm run build`). */
export const WEB_DIR = join(ROOT, 'dist', 'web');
/**
 * A development build of the UI (`NODE_ENV=development`), for a spec to serve (`RELAY_WEB_DIR`):
 * React's development build runs each effect twice (StrictMode), as under `npm run dev`.
 */
export const DEV_WEB_DIR = join(ROOT, 'dist', 'web-dev');
/** The server's entry point. */
export const SERVER_ENTRY = join(ROOT, 'src', 'server', 'index.ts');
