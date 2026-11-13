import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, type Provider } from '../shared/types';
import { CONFIG } from './config';
import { t } from './i18n';
import { ANTIGRAVITY_HOME_ENV, DATA_DIR, MUSE_HOME_ENV } from './settings';

/*
 * What agents below full access must not reach, besides what their sandbox already keeps them from
 * (see docs/architecture.md, "Signing in"):
 * - reading the browsers' own folders, where a signed-in browser keeps its key (and, in some, its
 *   cookie) on disk, nor Harness Relay's database or its own temporary folder;
 * - working, in edit mode, in a folder that holds what decides how the agents run: Harness Relay's
 *   own folder or its data folder (its code, its database), the home folder (shell and tool
 *   settings), a CLI's own folder (its settings, hooks, MCP servers, program) or a CLI's program,
 *   where they could get around their sandbox and the sign-in.
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
  // POSIX paths: there are folders to list on macOS and Linux only, whichever system this runs on.
  const at = (...dirs: string[]) => dirs.map((d) => posix.join(home, d));
  if (platform === 'darwin') {
    const support = (...apps: string[]) => apps.map((a) => posix.join('Library/Application Support', a));
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
    const configDirs = [posix.join(home, '.config'), ...(xdgConfig && posix.isAbsolute(xdgConfig) ? [xdgConfig] : [])];
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
    return [...new Set([...configDirs.flatMap((dir) => config.map((d) => posix.join(dir, d))), ...elsewhere])];
  }
  return [];
}

/**
 * The desktop app's own browser folder (desktop/): its chat window keeps its sign-in there, a cookie
 * and a key like any browser's. The app names it in RELAY_APP_BROWSER_DIR when it starts the server.
 */
export function appBrowserDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = env.RELAY_APP_BROWSER_DIR?.trim();
  return dir && isAbsolute(dir) ? [dir] : [];
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

/**
 * How the folders a turn makes in `relayTmpDir` for its own files begin: a Claude Code turn's
 * `--settings` and `--mcp-config` files (the settings hold an endpoint's key when it runs on one, the
 * MCP config the servers' secret values), and a Cursor turn's config folder.
 */
export const RUN_TMP_PREFIXES = { claude: 'claude-', cursor: 'cursor-' } as const;

/**
 * Removes the folders of turns the server was stopped during (`RUN_TMP_PREFIXES`; a turn removes its
 * own when it ends), so that no key stays there outside the credential store: for the server's start,
 * before any turn runs. A link in one (a Cursor turn's to the account's sessions) goes, not what it
 * leads to. One that cannot be removed does not keep the others: it throws once all were tried, naming
 * each that is left.
 */
export function clearRunTmp(root = relayTmpDir()): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return; // none yet
  }
  const prefixes = Object.values(RUN_TMP_PREFIXES);
  const left: string[] = [];
  for (const name of names) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
    } catch (err) {
      left.push(`${join(root, name)} (${(err as Error).message})`);
    }
  }
  if (left.length) throw new Error(`could not remove ${left.join(', ')}`);
}

/**
 * A path's real path. One that does not exist (yet), such as a working directory still to be
 * created, takes the real path of the nearest folder above it that does, with the rest as given: so
 * a link or another letter case on the way is resolved before the folder is made.
 */
export function realPath(path: string): string {
  return real(path);
}

function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

/**
 * The paths agents below full access may not read, as their sandboxes take them: the browsers'
 * folders (the desktop app's window's too), Harness Relay's database files and its own temporary
 * folder that exist now (a sandbox may refuse to start for a path that does not), each also by its
 * real path when that differs. None on Windows, where Claude Code and Grok have no sandbox to enforce
 * them.
 */
export function protectedReads(
  o: { platform?: NodeJS.Platform; home?: string; dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const platform = o.platform ?? process.platform;
  if (platform === 'win32') return [];
  const relay = [...relayDatabaseFiles(o.dataDir), relayTmpDir(o.dataDir)];
  const paths = [...browserDataDirs(platform, o.home), ...appBrowserDirs(o.env), ...relay].filter((p) => existsSync(p));
  return [...new Set(paths.flatMap((p) => [p, real(p)]))];
}

/** Whether two paths are the same, or one is inside the other (real paths). */
export function overlaps(a: string, b: string): boolean {
  const x = real(resolve(a));
  const y = real(resolve(b));
  return within(x, y) || within(y, x);
}

/** Whether `path` is `dir` or inside it (real paths, letter case as the file system gives it). */
function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Where voice input keeps its models and engine: the folder `RELAY_VOICE_DIR` names, else `voice` in the data folder. */
export function voiceFolder(dataDir = DATA_DIR): string {
  return CONFIG.voiceDir ?? join(dataDir, 'voice');
}

/**
 * Why agents below full access may not work in `cwd`, or undefined when they may: it holds Harness
 * Relay's folder or its data folder (an agent could then change its code or its database), or it is
 * inside Harness Relay's folder, outside its data folder (its code). A folder inside the data folder,
 * as the worktrees of parallel mode are, is fine: the database is not in it. Voice input's folder
 * (`voiceFolder`) is not, wherever it is: neither it, a folder in it nor one that holds it, since
 * Harness Relay runs the engine there outside any sandbox.
 */
export function relayFolderOverlap(
  cwd: string,
  roots: { install?: string; data?: string; voice?: string } = {},
): 'install' | 'data' | 'voice' | undefined {
  const dir = real(resolve(cwd));
  const install = real(roots.install ?? RELAY_ROOT);
  const data = real(roots.data ?? DATA_DIR);
  const voice = roots.voice ?? voiceFolder(roots.data ?? DATA_DIR);
  if (within(data, dir)) return 'data';
  if (overlaps(voice, dir)) return 'voice';
  if (within(install, dir)) return 'install';
  if (within(dir, install) && !within(dir, data)) return 'install';
  return undefined;
}

/**
 * A command as the CLI is started: where it was found (as given, or the first match on the PATH) and
 * its real path, when it exists.
 */
export function commandPaths(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  // On Windows a command is found by its extensions too (`claude.exe`, `codex.cmd`).
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const found = (/[\\/]/.test(bin) ? [bin] : (env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, bin))).flatMap(
    (p) => exts.map((ext) => p + ext),
  );
  const at = found.find((p) => existsSync(p) && statSync(p).isFile());
  return at ? [...new Set([resolve(at), real(at)])] : [];
}

/** Where the folders that decide how the agents run are (`agentFolders`). */
export interface AgentFolderOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** The CLIs' own folder Harness Relay gives them. */
  agentHome?: string;
  /** The folder of the CLIs' homes of the accounts besides each one's default (`SettingsStore.accountsDir`). */
  accountsDir?: string;
  bins?: string[];
}

/**
 * The folders that decide how the agents run, outside any project: each CLI's own folder (its
 * settings, hooks, MCP servers and, for Codex and Grok, its program; for Cursor its config folder and
 * `~/.cursor`, where its hooks and MCP servers stay; for Antigravity its `.gemini` folder; for Muse
 * Code its XDG config and data folders), Claude
 * Code's `~/.claude.json`,
 * the CLIs' own folder Harness Relay gives them (`agentHome`), the folder of the other accounts' homes
 * (`accountsDir`), and the folders their programs are in (`bins`, from `commandPaths`).
 */
export function agentFolders(o: AgentFolderOptions = {}): string[] {
  const home = o.home ?? homedir();
  const env = o.env ?? process.env;
  return [
    env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    join(home, '.claude.json'),
    env.CODEX_HOME || join(home, '.codex'),
    env.GROK_HOME || join(home, '.grok'),
    // Cursor's config folder as it finds it (`cursorConfigDir`); ~/.cursor, where its hooks and MCP
    // servers stay; and where it keeps its sign-in on Linux (`$XDG_CONFIG_HOME/cursor`, else
    // ~/.config/cursor) and Windows (`%APPDATA%\Cursor`).
    ...new Set([
      env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'cursor') : join(home, '.cursor')),
      join(home, '.cursor'),
      env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'cursor') : join(home, '.config', 'cursor'),
      // On Windows, its sign-in is in %APPDATA%\Cursor.
      ...(env.APPDATA ? [join(env.APPDATA, 'Cursor')] : []),
    ]),
    // Antigravity's `.gemini` folder (its settings, hooks, MCP servers, plugins, conversations), the
    // account's (`ANTIGRAVITY_HOME_ENV`) and the user's own.
    ...new Set([join(env[ANTIGRAVITY_HOME_ENV] || home, '.gemini'), join(home, '.gemini')]),
    // Muse Code's config and data folders (its settings, sign-in, hooks, MCP servers, plugins, sessions),
    // the account's (`MUSE_HOME_ENV`) and the user's own (XDG folders, on every system).
    ...new Set([
      ...(env[MUSE_HOME_ENV] ? [join(env[MUSE_HOME_ENV], 'config', 'muse'), join(env[MUSE_HOME_ENV], 'data', 'muse')] : []),
      join(env.XDG_CONFIG_HOME || join(home, '.config'), 'muse'),
      join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'muse'),
    ]),
    ...(o.agentHome ? [o.agentHome] : []),
    ...(o.accountsDir && o.accountsDir !== o.agentHome ? [o.accountsDir] : []),
    ...(o.bins ?? []).map((bin) => dirname(bin)),
  ];
}

/**
 * The folder `cwd` holds, or is inside, that decides how the agents run, or undefined: the home
 * folder when `cwd` is it or holds it (a project inside it is fine), and any of `agentFolders` when
 * `cwd` holds it or is inside it.
 */
export function agentFolderOverlap(cwd: string, o: AgentFolderOptions = {}): string | undefined {
  const dir = real(resolve(cwd));
  const home = o.home ?? homedir();
  if (within(real(home), dir)) return home;
  return agentFolders(o).find((folder) => {
    const f = real(folder);
    return within(f, dir) || within(dir, f);
  });
}

/**
 * `agentFolderOverlap`'s options from Harness Relay's settings: the CLIs' own folder it gives them,
 * the folder of the other accounts' homes, and where each CLI's program is, as it starts them.
 */
export function agentFolderOptions(settings: {
  agentHome: string;
  accountsDir: string;
  bin(p: Provider): string;
  env(p: Provider): NodeJS.ProcessEnv;
}): { agentHome?: string; accountsDir: string; bins: string[] } {
  return {
    ...(settings.agentHome ? { agentHome: settings.agentHome } : {}),
    accountsDir: settings.accountsDir,
    bins: PROVIDERS.flatMap((p) => commandPaths(settings.bin(p), settings.env(p))),
  };
}

/**
 * Refuses edit mode in a working directory that holds Harness Relay itself (`relayFolderOverlap`) or
 * what decides how the agents run (`agentFolderOverlap`): agents change files there without asking.
 * Read-only asks before writing (Codex cannot write at all), and every sandbox keeps the database
 * from being read or written.
 */
export function relayFolderRefusal(
  settings: { permission: string; cwd: string; extraCwds?: readonly string[] },
  o: AgentFolderOptions = {},
): string | undefined {
  if (settings.permission !== 'edit') return undefined;
  for (const cwd of [settings.cwd, ...(settings.extraCwds ?? [])]) {
    const overlap = relayFolderOverlap(cwd);
    if (overlap === 'voice') return t().cwdHoldsVoice(cwd, voiceFolder(), Boolean(CONFIG.voiceDir));
    if (overlap) return t().cwdIsRelay(cwd);
    const folder = agentFolderOverlap(cwd, o);
    if (folder) return t().cwdHoldsAgents(cwd, folder);
  }
  return undefined;
}

/**
 * A protected path whose name has `*`, `?` or `[`, which the sandboxes read as a pattern, so that it
 * may not be protected: none, or the first such.
 */
export function patternPath(paths: readonly string[]): string | undefined {
  return paths.find((p) => /[*?[]/.test(p));
}

/** The temp folders every sandbox lets its commands write in. */
export function tempFolders(): string[] {
  return [...new Set([tmpdir(), '/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp', '/private/var/folders'].map(real))];
}

/** Whether `path` is in a temp folder, where a sandboxed agent could write (never on Windows, which has no such sandbox). */
export function dirInTemp(path: string): boolean {
  const dir = real(path);
  return process.platform !== 'win32' && tempFolders().some((t) => within(dir, t));
}

/** Whether Harness Relay's data folder is in a temp folder, where a sandboxed agent could write its database. */
export function dataDirInTemp(dataDir = DATA_DIR): boolean {
  return dirInTemp(dataDir);
}

/**
 * Why the server may not start with `RELAY_VOICE_DIR` set to `dir`, or undefined: in a temp folder a
 * sandboxed agent could replace the voice engine, which Harness Relay runs outside any sandbox. (The
 * data folder there is only warned about, as the tests keep theirs there; a voice folder is chosen.)
 */
export function voiceDirProblem(dir = CONFIG.voiceDir): string | undefined {
  if (!dir || !dirInTemp(dir)) return undefined;
  return `RELAY_VOICE_DIR=${dir} is in a temp folder, which agents' sandboxes may write in, and the voice engine there runs outside any sandbox: choose a folder elsewhere.`;
}
