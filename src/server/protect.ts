import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './i18n';
import { DATA_DIR } from './settings';

/*
 * What agents below full access must not reach, besides what their sandbox already keeps them from
 * (see docs/architecture.md, "Signing in"):
 * - reading the browsers' own folders, where a signed-in browser keeps its key (and, in some, its
 *   cookie) on disk, nor Harness Relay's database or its own temporary folder;
 * - working in Harness Relay's own folder or its data folder, where they could change its code or its
 *   database, and so get around their sandbox and the sign-in.
 */

/** The folder Harness Relay runs from (its code, node_modules and, by default, its data). */
export const RELAY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Where the browsers people use keep their profiles (cookies, localStorage), under the home folder
 * (on Linux, also under `$XDG_CONFIG_HOME` when it is set elsewhere, as Chrome and Firefox follow it).
 */
export function browserDataDirs(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  xdgConfig = process.env.XDG_CONFIG_HOME,
): string[] {
  const at = (...dirs: string[]) => dirs.map((d) => join(home, d));
  if (platform === 'darwin') {
    const support = (...apps: string[]) => apps.map((a) => join('Library/Application Support', a));
    return at(
      ...support(
        'Google/Chrome',
        'Google/Chrome Beta',
        'Google/Chrome Dev',
        'Google/Chrome Canary',
        'Google/Chrome for Testing',
        'Chromium',
        'Microsoft Edge',
        'Microsoft Edge Beta',
        'Microsoft Edge Dev',
        'Microsoft Edge Canary',
        'BraveSoftware',
        'Arc',
        'Vivaldi',
        'com.operasoftware.Opera',
        'com.operasoftware.OperaGX',
        'Firefox',
        'librewolf',
        'Zen',
        'zen',
        'Orion',
        'Floorp',
        'Waterfox',
        'net.imput.helium',
      ),
      // Safari and WebKit apps.
      'Library/Safari',
      'Library/Containers/com.apple.Safari',
      'Library/SafariTechnologyPreview',
      'Library/Containers/com.apple.SafariTechnologyPreview',
      'Library/Containers/com.duckduckgo.macos.browser',
      'Library/Cookies',
      'Library/WebKit',
      'Library/HTTPStorages',
    );
  }
  if (platform === 'linux') {
    const config = [
      'google-chrome',
      'google-chrome-beta',
      'google-chrome-unstable',
      'chromium',
      'microsoft-edge',
      'microsoft-edge-beta',
      'microsoft-edge-dev',
      'BraveSoftware',
      'vivaldi',
      'vivaldi-snapshot',
      'opera',
      'opera-beta',
      'opera-developer',
      // Firefox's own folders since it follows the XDG base directories (Firefox 147).
      'mozilla',
    ];
    const configDirs = [join(home, '.config'), ...(xdgConfig && isAbsolute(xdgConfig) ? [xdgConfig] : [])];
    const elsewhere = at(
      '.mozilla',
      '.librewolf',
      '.zen',
      '.floorp',
      '.waterfox',
      'snap/firefox',
      'snap/chromium',
      'snap/brave',
      '.var/app/org.mozilla.firefox',
      '.var/app/com.google.Chrome',
      '.var/app/org.chromium.Chromium',
      '.var/app/com.brave.Browser',
      '.var/app/com.microsoft.Edge',
      '.var/app/io.gitlab.librewolf-community',
      '.var/app/app.zen_browser.zen',
      '.var/app/one.ablaze.floorp',
      '.var/app/com.vivaldi.Vivaldi',
      '.var/app/com.opera.Opera',
      '.var/app/io.github.ungoogled_software.ungoogled_chromium',
      // GNOME Web (Epiphany).
      '.local/share/epiphany',
      '.var/app/org.gnome.Epiphany',
    );
    return [...new Set([...configDirs.flatMap((dir) => config.map((d) => join(dir, d))), ...elsewhere])];
  }
  return [];
}

/** Harness Relay's database and the files SQLite keeps beside it. */
export function relayDatabaseFiles(dataDir = DATA_DIR): string[] {
  return ['relay.db', 'relay.db-wal', 'relay.db-shm'].map((f) => join(dataDir, f));
}

/**
 * Harness Relay's own temporary folder, in its data folder (also where shares clone their gists):
 * a Claude Code turn's `--settings` and `--mcp-config` files go here, never in the system's temporary
 * folder, which every sandbox lets commands write in. There a command of another agent could change
 * them before Claude Code reads them (to turn its sandbox off, or to start a command of its own as an
 * MCP server, outside any sandbox), or read the MCP servers' secret values in them; here the sandboxes
 * can do neither (`protectedReads`).
 */
export function relayTmpDir(dataDir = DATA_DIR): string {
  return join(dataDir, 'tmp');
}

/** A path's real path, or itself when it cannot be resolved. */
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The paths agents below full access may not read, as their sandboxes take them: the browsers'
 * folders, Harness Relay's database files and its own temporary folder that exist now (a sandbox may
 * refuse to start for a path that does not), each also by its real path when that differs. None on
 * Windows, where Claude Code and Grok have no sandbox to enforce them.
 */
export function protectedReads(
  o: { platform?: NodeJS.Platform; home?: string; dataDir?: string } = {},
): string[] {
  const platform = o.platform ?? process.platform;
  if (platform === 'win32') return [];
  const relay = [...relayDatabaseFiles(o.dataDir), relayTmpDir(o.dataDir)];
  const paths = [...browserDataDirs(platform, o.home), ...relay].filter((p) => existsSync(p));
  return [...new Set(paths.flatMap((p) => [p, real(p)]))];
}

/** Whether `path` is `dir` or inside it (real paths, letter case as the file system gives it). */
function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Why agents below full access may not work in `cwd`, or undefined when they may: it holds Harness
 * Relay's folder or its data folder (an agent could then change its code or its database), or it is
 * inside Harness Relay's folder, outside its data folder (its code). A folder inside the data folder,
 * as the worktrees of parallel mode are, is fine: the database is not in it.
 */
export function relayFolderOverlap(
  cwd: string,
  roots: { install?: string; data?: string } = {},
): 'install' | 'data' | undefined {
  const dir = real(resolve(cwd));
  const install = real(roots.install ?? RELAY_ROOT);
  const data = real(roots.data ?? DATA_DIR);
  if (within(data, dir)) return 'data';
  if (within(install, dir)) return 'install';
  if (within(dir, install) && !within(dir, data)) return 'install';
  return undefined;
}

/**
 * Refuses edit mode in a working directory that holds Harness Relay itself (`relayFolderOverlap`):
 * agents change files there without asking. Read-only asks before writing (Codex cannot write at all),
 * and every sandbox keeps the database from being read or written.
 */
export function relayFolderRefusal(settings: { permission: string; cwd: string }): string | undefined {
  return settings.permission === 'edit' && relayFolderOverlap(settings.cwd) ? t().cwdIsRelay(settings.cwd) : undefined;
}

/** The temp folders every sandbox lets its commands write in. */
export function tempFolders(): string[] {
  return [...new Set([tmpdir(), '/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp', '/private/var/folders'].map(real))];
}

/** Whether Harness Relay's data folder is in a temp folder, where a sandboxed agent could write its database. */
export function dataDirInTemp(dataDir = DATA_DIR): boolean {
  const dir = real(dataDir);
  return process.platform !== 'win32' && tempFolders().some((t) => within(dir, t));
}
