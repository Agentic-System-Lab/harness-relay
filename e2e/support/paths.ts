import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The fake `claude`, `codex` and `grok`, one script for all three. */
export const FAKE_CLI_SCRIPT = join(ROOT, 'e2e', 'fake-cli', 'fake-cli.cjs');
/** The fake folder dialog (`zenity`, which Linux finds on the PATH). */
export const FAKE_DIALOG_SCRIPT = join(ROOT, 'e2e', 'fake-cli', 'fake-dialog.cjs');
/** The built UI the servers under test serve (`npm run build`). */
export const WEB_DIR = join(ROOT, 'dist', 'web');
/** The server's entry point. */
export const SERVER_ENTRY = join(ROOT, 'src', 'server', 'index.ts');
