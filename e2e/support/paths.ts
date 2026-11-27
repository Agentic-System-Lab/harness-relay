import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** The fake CLIs' modules, bundled into one script for all twelve CLIs (`support/fake-cli.ts`). */
export const FAKE_CLI_DIR = join(ROOT, 'e2e', 'fake-cli');
/** The fake CLIs' entry module, in `FAKE_CLI_DIR`. */
export const FAKE_CLI_SCRIPT = join(FAKE_CLI_DIR, 'fake-cli.cjs');
/** The fake folder dialog (`zenity`, which Linux finds on the PATH). */
export const FAKE_DIALOG_SCRIPT = join(FAKE_CLI_DIR, 'fake-dialog.cjs');
/** The fake GitHub CLI (`gh`), which shares conversations as gists. */
export const FAKE_GH_SCRIPT = join(FAKE_CLI_DIR, 'fake-gh.cjs');
/** The fake npm (`npm`), which Settings installs some of the CLIs with. */
export const FAKE_NPM_SCRIPT = join(FAKE_CLI_DIR, 'fake-npm.cjs');
/** The fake Cua CLI (`cua`), which starts the chats' computers; off the PATH, linked into a server's own Cua folder by the specs that want it. */
export const FAKE_CUA_SCRIPT = join(FAKE_CLI_DIR, 'fake-cua.cjs');
/** The PowerShell stand-in for Microsoft Graph device sign-in and Teams messages. */
export const FAKE_PWSH_SCRIPT = join(FAKE_CLI_DIR, 'fake-pwsh.cjs');
/** The built UI the servers under test serve (`npm run build`). */
export const WEB_DIR = join(ROOT, 'dist', 'web');
/**
 * A development build of the UI (`NODE_ENV=development`), for a spec to serve (`RELAY_WEB_DIR`):
 * React's development build runs each effect twice (StrictMode), as under `npm run dev`.
 */
export const DEV_WEB_DIR = join(ROOT, 'dist', 'web-dev');
/** The server's entry point. */
export const SERVER_ENTRY = join(ROOT, 'src', 'server', 'index.ts');
/**
 * The server bundled for the tests (`support/server-bundle.ts`), two folders below the repository as
 * `src/server` is, so that it finds the repository (`RELAY_ROOT`) where its source does.
 */
export const SERVER_BUNDLE_DIR = join(ROOT, 'dist', 'e2e-server');
/** The bundled server's entry point, which `global-setup.ts` builds and names in E2E_SERVER_BUNDLE. */
export const SERVER_BUNDLE_ENTRY = join(SERVER_BUNDLE_DIR, 'server.mjs');
