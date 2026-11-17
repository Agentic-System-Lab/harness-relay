import { createHash } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path';
import {
  PROVIDERS,
  PROVIDER_LABEL,
  isOpenProvider,
  type CliInstallBlock,
  type CliInstallJobView,
  type CliInstallMethod,
  type CliInstallView,
  type LoginState,
  type Provider,
} from '../shared/types';
import { openAgents } from './agents/index';
import { openHomeEnv } from './agents/open';
import { HttpError } from './errors';
import { t } from './i18n';
import { runProcess, runShellScript, stripAnsi, tail, type RunOptions, type SpawnOptions, type SpawnResult } from './process';
import { cliFolder } from './protect';
import { parseVersion } from './providers';
import type { SettingsStore } from './settings';
import { BREW_DIRS, findOnPath } from './voice';

/*
 * Installing a CLI from Settings, for anyone who does not have it yet (a GitHub codespace has the
 * seven that are not open source installed already, `.devcontainer/setup.sh`).
 *
 * Each CLI goes into a folder of its own, `clis/<provider>` in the data folder (`cliFolder`), and
 * nothing it installs goes anywhere else, so that removing it deletes that folder and nothing of the
 * user's: not a CLI installed some other way, nor the CLI's sign-in, settings and sessions, which stay
 * in its home. Three ways, by what the CLI's maker offers:
 * - npm, as a global install into that folder (`npm install -g --prefix <folder> <package>`, as the
 *   user guide's `npm install -g` and the codespace install them), with its cache in the folder while
 *   it installs (`INSTALL_CACHE`): Claude Code, Codex, Copilot, OpenCode, Cline, Pi. Without npm on
 *   the PATH (the desktop app needs no Node.js), Node.js's own build goes into the folder first for
 *   Claude Code, Codex and Copilot (`NODE_VERSION`, `nodeBuildFor`, its checksum checked), laid out as npm's global
 *   folder is beside its Node, and stays there: its npm installs the CLI, and Codex's and Copilot's
 *   programs, Node scripts npm links, run on that Node (`posixLaunch` in `process.ts`, and on Windows
 *   `windowsLaunch`, start a Node script with the Node beside it). The open agents' still take an npm
 *   on the PATH: Cline's and Pi's programs are Node scripts too, which Harness Relay's own sandbox
 *   starts as they are, on the PATH's Node;
 * - the maker's own installer script, downloaded with curl and run with the folder as its home (HOME,
 *   the XDG folders, and on Windows USERPROFILE, LOCALAPPDATA and APPDATA), the program's folder put
 *   on its PATH so that it adds nothing to the user's, and its own variable or flag for where the
 *   program goes: Grok, Cursor, Antigravity, Muse Code, Goose. On macOS and Linux each runs its bash
 *   script; on Windows Grok, Cursor, Antigravity and Muse Code their PowerShell one, and Goose its bash
 *   script under Git for Windows' bash, which it supports;
 * - uv (`uv tool install`), with its tools, the links to their programs, any Python it downloads and,
 *   while it installs, its cache in the folder: OpenHands. Without uv on the PATH, uv's own installer
 *   puts one in the folder first (`UV_UNMANAGED_INSTALL`: no PATH change, no updater), removed with
 *   OpenHands.
 * The open agents get the versions the user guide says they were checked with; the others their
 * newest, as their makers' installers give them.
 *
 * Some installers add to the user's PATH anyway: a link in a folder on the PATH that it may write in
 * (Grok's bash script, into /usr/local/bin), or on Windows the user's PATH in the registry (Cursor's,
 * Grok's and Antigravity's PowerShell ones). On macOS and Linux, after every install and when a CLI is
 * removed, the links in the PATH's folders that lead into the CLI's folder are removed. On Windows the
 * user's PATH is read before each script runs and put back as it was once it ended, however it ended
 * (`keepingUserPath`), one such script at a time: a script that reads the user's PATH with the folder
 * as its home and writes it back would also have turned the user's own `%USERPROFILE%` entries into
 * paths inside the folder.
 *
 * An install is a background job (one at a time for each CLI), followed by a check that the program
 * it put there runs (`--version`, as the CLI's status asks it). Then the folder gets a note of what
 * was installed (`INSTALL_NOTE`), and the CLI's executable path in Settings is set to the program, so
 * every start of the CLI runs it. An install that fails or is cancelled leaves no folder. Removing it
 * deletes the folder and sets the executable path back to what it was before the install (usually
 * none: the CLI's name on the PATH), unless the user set another one meanwhile.
 */

/** What an install leaves in the CLI's folder once it is done and its program runs: what was installed. */
export const INSTALL_NOTE = 'harness-relay-install.json';

/**
 * npm's and uv's download caches while a CLI installs, in its folder, deleted when the install ends:
 * in the user's own caches (`~/.npm`, `~/.cache/uv`) they would stay after the CLI is removed, with
 * hundreds of megabytes of it (and with no uv to clean them, when uv was Harness Relay's).
 */
export const INSTALL_CACHE = 'install-cache';

/** How long an install may take (a slow network, a large download). */
const INSTALL_TIMEOUT_MS = 20 * 60_000;
/** How long the program installed has to answer `--version` (a launcher may fetch its binary first). */
const VERSION_TIMEOUT_MS = 2 * 60_000;
/** How much of an installer's output is kept. */
const MAX_LOG = 32_000;

/** Goose's own installer (it moved to this repository; the old address redirects here). */
const GOOSE_SCRIPT = 'https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh';
/** Goose's: the version checked, into the folder's `bin`, without its interactive `goose configure`. */
const gooseEnv = (dir: string) => ({ GOOSE_BIN_DIR: join(dir, 'bin'), GOOSE_VERSION: 'v1.58.1', CONFIGURE: 'false' });

/** A maker's installer script: where it is, what runs it, and where its program ends up. */
export interface ScriptInstaller {
  url: string;
  /** bash (on Windows, Git for Windows' bash), or Windows PowerShell. */
  shell: 'bash' | 'powershell';
  /** Where the program is once the script ran, in the CLI's folder. */
  bin: readonly string[];
  /** The script's own arguments, given the CLI's folder. */
  args?: (dir: string) => string[];
  /** The script's own variables besides the home's, given the CLI's folder. */
  env?: (dir: string) => Record<string, string>;
  /** Variables of the server's environment the script is not given: they would send it outside the folder. */
  clear?: readonly string[];
}

/** How one CLI is installed. */
export type CliRecipe =
  /**
   * `command`: the program the package links in the prefix's `bin` folder (on Windows, its `.cmd` in
   * the prefix); `withNode`: without npm on the PATH, Node.js's own build goes into the folder first
   * (`nodeBuildFor`), and its npm installs the package.
   */
  | { method: 'npm'; package: string; command: string; withNode?: true }
  /**
   * `command`: the program `uv tool install` links in its bin folder; `windowsPython`: the Python it
   * runs on, on Windows (`uvInstallArgs`).
   */
  | { method: 'uv'; package: string; command: string; windowsPython?: string }
  /** Its maker's script on macOS and Linux (`posix`) and on Windows (`windows`). */
  | { method: 'script'; posix: ScriptInstaller; windows: ScriptInstaller };

/** Where uv's own installer puts uv when Harness Relay installs it, in the folder of the CLI that needs it. */
const UV_FOLDER = ['uv', 'bin'];

/** What would send uv's installer elsewhere: both come before `UV_UNMANAGED_INSTALL` in its scripts. */
const UV_INSTALL_DIRS = ['UV_INSTALL_DIR', 'CARGO_DIST_FORCE_INSTALL_DIR'];

/** uv's own installers, when uv is not on the PATH: into `UV_FOLDER`, changing no PATH and installing no updater. */
export const UV_INSTALLERS: Record<'posix' | 'windows', ScriptInstaller> = {
  posix: {
    url: 'https://astral.sh/uv/install.sh',
    shell: 'bash',
    bin: [...UV_FOLDER, 'uv'],
    env: (dir) => ({ UV_UNMANAGED_INSTALL: join(dir, ...UV_FOLDER) }),
    clear: UV_INSTALL_DIRS,
  },
  windows: {
    url: 'https://astral.sh/uv/install.ps1',
    shell: 'powershell',
    bin: [...UV_FOLDER, 'uv.exe'],
    env: (dir) => ({ UV_UNMANAGED_INSTALL: join(dir, ...UV_FOLDER) }),
    clear: UV_INSTALL_DIRS,
  },
};

/** How each CLI is installed (see the top of this file). */
export const CLI_RECIPES: Record<Provider, CliRecipe> = {
  claude: { method: 'npm', package: '@anthropic-ai/claude-code', command: 'claude', withNode: true },
  codex: { method: 'npm', package: '@openai/codex', command: 'codex', withNode: true },
  // Its program in ~/.grok/downloads, linked (on Windows copied) into GROK_BIN_DIR.
  grok: {
    method: 'script',
    posix: { url: 'https://x.ai/cli/install.sh', shell: 'bash', bin: ['bin', 'grok'], env: (dir) => ({ GROK_BIN_DIR: join(dir, 'bin') }) },
    windows: {
      url: 'https://x.ai/cli/install.ps1',
      shell: 'powershell',
      bin: ['bin', 'grok.exe'],
      env: (dir) => ({ GROK_BIN_DIR: join(dir, 'bin') }),
    },
  },
  // No setting of its own: its versions in ~/.local/share/cursor-agent linked from ~/.local/bin; on
  // Windows in %LOCALAPPDATA%\cursor-agent, with its launcher (`winLaunch.ts` starts it).
  cursor: {
    method: 'script',
    posix: { url: 'https://cursor.com/install', shell: 'bash', bin: ['home', '.local', 'bin', 'cursor-agent'] },
    windows: {
      url: 'https://cursor.com/install?win32=true',
      shell: 'powershell',
      bin: ['home', 'AppData', 'Local', 'cursor-agent', 'cursor-agent.cmd'],
    },
  },
  antigravity: {
    method: 'script',
    posix: {
      url: 'https://antigravity.google/cli/install.sh',
      shell: 'bash',
      bin: ['bin', 'agy'],
      args: (dir) => ['--dir', join(dir, 'bin')],
    },
    windows: {
      url: 'https://antigravity.google/cli/install.ps1',
      shell: 'powershell',
      bin: ['bin', 'agy.exe'],
      args: (dir) => ['--dir', join(dir, 'bin')],
    },
  },
  copilot: { method: 'npm', package: '@github/copilot', command: 'copilot', withNode: true },
  // A launcher, which fetches Muse Code's binary beside itself (and keeps it up to date there); on
  // Windows `muse.cmd`, which `winLaunch.ts` reads for the binary it names.
  muse: {
    method: 'script',
    posix: {
      url: 'https://dev.meta.ai/install.sh',
      shell: 'bash',
      bin: ['bin', 'muse'],
      env: (dir) => ({ MUSE_INSTALL_DIR: join(dir, 'bin'), MUSE_NO_MODIFY_PATH: '1' }),
    },
    windows: {
      url: 'https://dev.meta.ai/install.ps1',
      shell: 'powershell',
      bin: ['bin', 'muse.cmd'],
      env: (dir) => ({ MUSE_INSTALL_DIR: join(dir, 'bin'), MUSE_NO_MODIFY_PATH: '1' }),
    },
  },
  opencode: { method: 'npm', package: 'opencode-ai@1.19.5', command: 'opencode' },
  // Goose's own installer, of the version checked (Homebrew's formula would go outside the folder);
  // on Windows the same script, which supports Git for Windows' bash, makes `goose.exe`.
  goose: {
    method: 'script',
    posix: { url: GOOSE_SCRIPT, shell: 'bash', bin: ['bin', 'goose'], env: gooseEnv },
    windows: { url: GOOSE_SCRIPT, shell: 'bash', bin: ['bin', 'goose.exe'], env: gooseEnv },
  },
  cline: { method: 'npm', package: 'cline@3.0.74', command: 'cline' },
  // On Windows on the x64 Python 3.12 (the only one it runs on), also on Arm: some of its packages
  // (tiktoken) have no wheels for Windows on Arm, and building them takes Rust. Windows runs it
  // emulated there; on an x64 computer it is the Python uv would pick anyway.
  openhands: { method: 'uv', package: 'openhands==1.16.0', command: 'openhands', windowsPython: 'cpython-3.12-windows-x86_64-none' },
  pi: { method: 'npm', package: '@earendil-works/pi-coding-agent@1.5.1', command: 'pi' },
};

/** The script of a recipe's maker for `platform`: bash on macOS and Linux, its Windows one there, none elsewhere. */
export function scriptFor(r: Extract<CliRecipe, { method: 'script' }>, platform: NodeJS.Platform): ScriptInstaller | undefined {
  if (platform === 'win32') return r.windows;
  return platform === 'darwin' || platform === 'linux' ? r.posix : undefined;
}

/** uv's own installer for `platform`. */
export function uvInstallerFor(platform: NodeJS.Platform): ScriptInstaller | undefined {
  if (platform === 'win32') return UV_INSTALLERS.windows;
  return platform === 'darwin' || platform === 'linux' ? UV_INSTALLERS.posix : undefined;
}

/** `uv`'s arguments for installing a uv recipe on `platform`. */
export function uvInstallArgs(r: Extract<CliRecipe, { method: 'uv' }>, platform: NodeJS.Platform): string[] {
  return ['tool', 'install', ...(platform === 'win32' && r.windowsPython ? ['--python', r.windowsPython] : []), r.package];
}

/**
 * The Node.js `withNode` recipes install with when npm is not on the PATH: a release of its current
 * long-term support line, from nodejs.org, checked against these SHA-256 checksums (its release's
 * `SHASUMS256.txt`, whose signature by a Node.js releaser was checked). To move to a newer release,
 * change both, from that release's `SHASUMS256.txt` once its signature checks. Its npm (11.20) runs a
 * package's install scripts, warning only that `allowScripts` does not cover them yet: Claude Code's
 * postinstall puts its native binary in place of a stub that only says it is missing, so check that
 * a newer npm still does before moving to it.
 */
export const NODE_VERSION = '26.13.1';
const NODE_SHA256: Readonly<Record<string, string>> = {
  'darwin-arm64.tar.gz': 'aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735',
  'darwin-x64.tar.gz': '82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f',
  'linux-arm64.tar.gz': '80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d',
  'linux-x64.tar.gz': '518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778',
  'win-arm64.zip': '181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97',
  'win-x64.zip': 'e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7',
};

/** Node.js's build for one system: its archive, its checksum, and what of it goes into a CLI's folder. */
export interface NodeBuild {
  version: string;
  url: string;
  /** The archive's file name. */
  file: string;
  sha256: string;
  /** The archive's entries taken out of it (its top folder stripped): Node itself and npm, nothing else. */
  members: string[];
}

/** musl's dynamic loaders (Alpine's): Node.js's own Linux builds are for glibc. */
const MUSL_LOADERS = ['/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1'];

/**
 * Node.js's own build for `platform` on `arch` (`NODE_VERSION`): on macOS and Linux its `.tar.gz`,
 * on Windows its `.zip`; none for another system or processor, nor for a Linux with musl.
 */
export function nodeBuildFor(
  platform: NodeJS.Platform,
  arch: string,
  isFile: (path: string) => boolean = fileExists,
): NodeBuild | undefined {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : platform === 'win32' ? 'win' : undefined;
  if (!os || (arch !== 'x64' && arch !== 'arm64')) return undefined;
  if (os === 'linux' && MUSL_LOADERS.some((p) => isFile(p))) return undefined;
  const kind = `${os}-${arch}${os === 'win' ? '.zip' : '.tar.gz'}`;
  const sha256 = NODE_SHA256[kind];
  if (!sha256) return undefined;
  const top = `node-v${NODE_VERSION}-${os}-${arch}`;
  return {
    version: NODE_VERSION,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${kind}`,
    file: `node-v${NODE_VERSION}-${kind}`,
    sha256,
    // As its archive has them: on Windows `node.exe` and `node_modules\npm` at the top, elsewhere `bin/node` and `lib/node_modules/npm`.
    members: os === 'win' ? [`${top}/node.exe`, `${top}/node_modules/npm`] : [`${top}/bin/node`, `${top}/lib/node_modules/npm`],
  };
}

/**
 * How to start the npm of Node.js's build in a CLI's folder `dir`, laid out as npm's global folder is
 * beside its Node (the CLI's packages go in beside npm, their programs beside Node): Node with npm's
 * script, as `npmLaunch` starts it on Windows.
 */
export function folderNpm(dir: string, platform: NodeJS.Platform): { bin: string; args: string[] } {
  return platform === 'win32'
    ? { bin: join(dir, 'node.exe'), args: [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')] }
    : { bin: join(dir, 'bin', 'node'), args: [join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] };
}

/** A file's SHA-256 checksum, in hex. */
async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** A script as one would run it from its address. */
const scriptCommand = (s: ScriptInstaller) => (s.shell === 'powershell' ? `irm ${s.url} | iex` : `curl -fsSL ${s.url} | bash`);

/**
 * What an install runs on `platform`, as one would type it; `withUv`: uv's own installer first (uv is
 * not on the PATH); `node`: Node.js's build first, for its npm (npm is not on the PATH).
 */
export function installCommand(r: CliRecipe, platform: NodeJS.Platform = process.platform, withUv = false, node?: NodeBuild): string {
  if (r.method === 'npm') return `${node ? `curl -fsSLO ${node.url}; tar -xf ${node.file}; ` : ''}npm install -g ${r.package}`;
  if (r.method === 'uv') {
    const uv = withUv ? uvInstallerFor(platform) : undefined;
    return `${uv ? `${scriptCommand(uv)}; ` : ''}uv ${uvInstallArgs(r, platform).join(' ')}`;
  }
  const script = scriptFor(r, platform);
  return script ? scriptCommand(script) : `curl -fsSL ${r.posix.url} | bash`;
}

/** The program an install puts in the CLI's folder `dir`, on `platform`. */
export function installedProgram(r: CliRecipe, dir: string, platform: NodeJS.Platform): string {
  const win = platform === 'win32';
  // npm's global layout: `<prefix>/bin/<command>`, and on Windows `<prefix>\<command>.cmd`.
  if (r.method === 'npm') return win ? join(dir, `${r.command}.cmd`) : join(dir, 'bin', r.command);
  if (r.method === 'uv') return join(dir, 'bin', r.command + (win ? '.exe' : ''));
  return join(dir, ...(scriptFor(r, platform) ?? r.posix).bin);
}

/**
 * How to start npm: the program found as `npm` on the PATH (and where Homebrew puts it on macOS),
 * which on macOS and Linux is npm's own script. On Windows that is `npm.cmd`, a script Harness Relay
 * does not start through a shell: the Node beside it runs npm's script (`node_modules\npm\bin\npm-cli.js`)
 * instead, as `npm.cmd` would. An `npm.exe` found first is started as it is.
 */
export function npmLaunch(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (path: string) => boolean = fileExists,
): { bin: string; args: string[] } | undefined {
  if (platform !== 'win32') {
    const npm = findOnPath('npm', env, platform, platform === 'darwin' ? BREW_DIRS : [], isFile);
    return npm ? { bin: npm, args: [] } : undefined;
  }
  const npm = findOnPath('npm', env, platform, [], isFile);
  if (!npm) return undefined;
  if (/\.exe$/i.test(npm)) return { bin: npm, args: [] };
  const dir = win32.dirname(npm);
  const node = win32.join(dir, 'node.exe');
  const cli = win32.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return isFile(node) && isFile(cli) ? { bin: node, args: [cli] } : undefined;
}

/**
 * Git for Windows' bash, which a maker's bash script runs in on Windows: beside the `git` on the PATH
 * (`<Git>\cmd\git.exe`, `<Git>\bin\git.exe` or `<Git>\mingw64\bin\git.exe`, with bash in `<Git>\bin`
 * or `<Git>\usr\bin`), else where Git for Windows installs for all users or for one. Never the `bash`
 * on the PATH, which may be WSL's (`System32\bash.exe`), a Linux one. MinGit has none.
 */
export function gitBash(env: NodeJS.ProcessEnv, isFile: (path: string) => boolean = fileExists): string | undefined {
  const roots: string[] = [];
  const git = findOnPath('git', env, 'win32', [], isFile);
  if (git) {
    const dir = win32.dirname(git);
    roots.push(/\\mingw(32|64)\\bin$/i.test(dir) ? win32.dirname(win32.dirname(dir)) : win32.dirname(dir));
  }
  for (const base of [env.ProgramFiles, env.ProgramW6432, env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) roots.push(win32.join(base, 'Git'));
  }
  return [...new Set(roots)]
    .flatMap((root) => [win32.join(root, 'bin', 'bash.exe'), win32.join(root, 'usr', 'bin', 'bash.exe')])
    .find(isFile);
}

/** Windows PowerShell, which every Windows 10 and 11 has in System32. */
export function windowsPowerShell(env: NodeJS.ProcessEnv, isFile: (path: string) => boolean = fileExists): string | undefined {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  const inbox = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return isFile(inbox) ? inbox : findOnPath('powershell', env, 'win32', [], isFile);
}

/**
 * Where uv's own installer puts it on macOS and Linux, besides the PATH (a server started outside a
 * terminal may not have them): POSIX paths, whichever system this runs on, as `findOnPath` takes them.
 */
const uvDirs = (home: string, platform: NodeJS.Platform) =>
  platform === 'win32' ? [] : [posix.join(home, '.local', 'bin'), posix.join(home, '.cargo', 'bin')];

/** Where a system keeps curl and bash, besides the PATH. */
const SYSTEM_DIRS = ['/usr/bin', '/bin'];

/** Variables of the server's environment no installer is given: Claude Code's nesting markers, and npm's own of the run that started the server (`npm start`). */
const NOT_FOR_INSTALLERS =
  /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|AI_AGENT|npm_lifecycle_.*|npm_package_.*|npm_config_(local_prefix|global_prefix|prefix)|INIT_CWD)$/;

/** Variables that would move a maker's installer out of the folder it is given as its home. */
const HOME_MOVERS = ['ZDOTDIR', 'CURSOR_CONFIG_DIR', 'GROK_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'BASH_ENV', 'ENV'];

/** The environment an installer starts from: the server's, without what is not for it. */
export function installerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!NOT_FOR_INSTALLERS.test(k)) out[k] = v;
  out.NO_COLOR = '1';
  return out;
}

/** The variable that holds the PATH in `env` (`Path` on Windows, as it is often spelled there). */
const pathKey = (env: NodeJS.ProcessEnv) => Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';

/** `env` with `folder` first on its PATH. */
export function pathFirst(env: NodeJS.ProcessEnv, folder: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const key = pathKey(env);
  return { ...env, [key]: [folder, env[key]].filter(Boolean).join(platform === 'win32' ? ';' : ':') };
}

/**
 * A maker's installer script's environment: the folder `dir` as its home (`dir/home`, with the XDG
 * folders in it, and on Windows USERPROFILE, LOCALAPPDATA and APPDATA), nothing that would move it
 * elsewhere, the recipe's own variables, and the folder its program goes in first on its PATH, so that
 * it finds its program there and puts no link to it, nor a line for it, anywhere else.
 */
export function scriptEnv(
  base: NodeJS.ProcessEnv,
  dir: string,
  script: ScriptInstaller,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const home = join(dir, 'home');
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of [...HOME_MOVERS, ...(script.clear ?? [])]) delete env[k];
  return {
    ...pathFirst(env, dirname(join(dir, ...script.bin)), platform),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    ...(platform === 'win32'
      ? { USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming') }
      : {}),
    ...script.env?.(dir),
  };
}

/** `uv tool install`'s environment: its tools, their programs' links, any Python it downloads and its cache, all in `dir`. */
export function uvEnv(base: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  return {
    ...base,
    UV_CACHE_DIR: join(dir, INSTALL_CACHE, 'uv'),
    UV_TOOL_DIR: join(dir, 'uv', 'tools'),
    UV_TOOL_BIN_DIR: join(dir, 'bin'),
    UV_PYTHON_INSTALL_DIR: join(dir, 'uv', 'python'),
    UV_PYTHON_BIN_DIR: join(dir, 'uv', 'python-bin'),
  };
}

/*
 * Windows PowerShell scripts, each fixed text run with `-Command` (`runShellScript`): what they work
 * on is in their environment. No double quotes in them, which Windows' command line would escape.
 */

/** The user's PATH as `USER_PATH_READ_SCRIPT` writes it: `none`, or its kind and its value in base64 (UTF-8). */
const SAVED_USER_PATH = /^(none|(String|ExpandString):[A-Za-z0-9+/]*={0,2})$/;

/**
 * Writes the user's PATH (in the registry: `HKCU\Environment`) as it is stored: its `%VARIABLES%` not
 * expanded, and the value's kind; `none` when there is none. A PATH that is not text stops it.
 */
export const USER_PATH_READ_SCRIPT = [
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
  "if ($null -eq $key) { [Console]::Out.Write('none'); exit 0 }",
  "$value = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')",
  "if ($null -eq $value) { $key.Close(); [Console]::Out.Write('none'); exit 0 }",
  "$kind = $key.GetValueKind('Path')",
  '$key.Close()',
  "if ($kind -ne 'String' -and $kind -ne 'ExpandString') { [Console]::Error.Write('The user PATH is a ' + $kind + ' value, not text'); exit 3 }",
  "[Console]::Out.Write($kind.ToString() + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)))",
].join('; ');

/**
 * Puts the user's PATH back as `USER_PATH_READ_SCRIPT` wrote it (`HARNESS_RELAY_USER_PATH`), when it
 * is not that now, then tells Windows the environment changed (deleting a variable that is not there
 * through .NET sends that message), so that programs started after it get it; writes `changed` then.
 */
export const USER_PATH_RESTORE_SCRIPT = [
  '$saved = $env:HARNESS_RELAY_USER_PATH',
  "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$value = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')",
  "$now = 'none'",
  "if ($null -ne $value) { $now = $key.GetValueKind('Path').ToString() + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)) }",
  'if ($now -ceq $saved) { $key.Close(); exit 0 }',
  "if ($saved -eq 'none') { $key.DeleteValue('Path', $false) } else { $at = $saved.IndexOf(':'); $key.SetValue('Path', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($saved.Substring($at + 1))), [Microsoft.Win32.RegistryValueKind]($saved.Substring(0, $at))) }",
  '$key.Close()',
  "[Environment]::SetEnvironmentVariable('HARNESS_RELAY_PATH_CHANGED', $null, 'User')",
  "[Console]::Out.Write('changed')",
].join('; ');

/**
 * Runs a maker's PowerShell installer (`HARNESS_RELAY_SCRIPT`) as its makers' `irm … | iex` would,
 * as a script block made from its text, which no execution policy refuses as it may a script file
 * (Group Policy's wins over `-ExecutionPolicy Bypass`). Its arguments (`HARNESS_RELAY_SCRIPT_ARGS`,
 * one a line) are passed as they are, never read as PowerShell's own parameters, as Grok's makers'
 * `& ([scriptblock]::Create((irm …))) <arguments>` passes them. It ends as `-File` would: 0 unless the
 * script exits with another code or fails.
 */
export const POWERSHELL_RUN_SCRIPT = [
  '$list = @()',
  'if ($env:HARNESS_RELAY_SCRIPT_ARGS) { $list = @($env:HARNESS_RELAY_SCRIPT_ARGS.Split([char]10)) }',
  '$block = [ScriptBlock]::Create([IO.File]::ReadAllText($env:HARNESS_RELAY_SCRIPT))',
  'try { if ($list.Count -gt 0) { Invoke-Command -ScriptBlock $block -ArgumentList $list } else { Invoke-Command -ScriptBlock $block } } catch { [Console]::Error.WriteLine([string]$_); exit 1 }',
  'exit 0',
].join('; ');

/** How Harness Relay starts Windows PowerShell for these scripts. */
const POWERSHELL_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/** Where the user's PATH is kept while a script runs on Windows, in the CLIs' folder, until it is put back. */
export const USER_PATH_SAVED = '.user-path-before-install';

/**
 * An installer's output as the user reads it: without colours and cursor moves, and of a line a
 * progress bar redrew (`\r`), what it showed last.
 */
export function cleanLog(text: string): string {
  return stripAnsi(text)
    .split('\n')
    .map((line) => {
      const shown = line.replace(/\r+$/, '');
      return shown.slice(shown.lastIndexOf('\r') + 1);
    })
    .join('\n');
}

/**
 * The folders an installer may have put a link to its program in on macOS and Linux: those on the
 * PATH, and `~/.local/bin`, `/usr/local/bin` and `/opt/homebrew/bin`.
 */
export function linkFolders(env: NodeJS.ProcessEnv, home: string): string[] {
  const path = (env[pathKey(env)] ?? '').split(':').filter((d) => posix.isAbsolute(d));
  return [...new Set([...path, posix.join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'])];
}

/**
 * Removes the links in `folders` (not in folders inside them) that lead to `dir` or anything in it,
 * by what they name (also when that is gone), and returns them. Nothing else is touched: a file, or a
 * link to anything outside `dir`, stays; a folder that cannot be read is passed over, and so is one
 * that is `dir` or inside it (its `bin` on the user's PATH, say), whose links are the install's own.
 */
export function dropLinksInto(dir: string, folders: readonly string[]): string[] {
  const roots = [dir];
  try {
    roots.push(realpathSync(dir));
  } catch {
    /* removed already */
  }
  const into = (target: string) => roots.some((root) => target === root || inside(target, root));
  const removed: string[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      if (into(resolve(folder)) || into(realpathSync(folder))) continue;
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      const link = join(folder, name);
      try {
        if (!lstatSync(link).isSymbolicLink() || !into(resolve(folder, readlinkSync(link)))) continue;
        unlinkSync(link);
        removed.push(link);
      } catch {
        /* gone meanwhile, or not ours to remove */
      }
    }
  }
  return removed;
}

/** Settles once `signal` is aborted. */
function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((done) => (signal.aborted ? done() : signal.addEventListener('abort', () => done(), { once: true })));
}

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Whether `path` is inside `dir`. */
function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** What `INSTALL_NOTE` records. */
interface InstallNote {
  provider: Provider;
  method: CliInstallMethod;
  /** The package or the script's address. */
  source: string;
  bin: string;
  version?: string;
  at: number;
  /** The CLI's executable path in Settings before the install set it to `bin` (empty: none), which removing it sets back. */
  previousBin: string;
}

/** An error whose message is rendered when it is shown, in the language of whoever looks. */
export class InstallError extends Error {
  /** `code`: the exit code of the command that failed, when one did. */
  constructor(
    readonly render: () => string,
    readonly code?: number | null,
  ) {
    super(render());
  }
}

/** An install under way or ended: its output, how it ended (also the sandboxes' setup, `sandboxSetup.ts`). */
export class InstallJob {
  readonly abort = new AbortController();
  readonly startedAt = Date.now();
  /** Settles once the job has ended and cleaned up after itself. */
  ended: Promise<void> = Promise.resolve();
  state: LoginState = 'running';
  finishedAt?: number;
  private log = '';
  private error?: () => string;

  append(text: string): void {
    this.log += text;
    if (this.log.length > MAX_LOG) this.log = this.log.slice(-MAX_LOG);
  }

  finish(state: Exclude<LoginState, 'running'>, error?: () => string): void {
    this.state = state;
    this.error = error;
    this.finishedAt = Date.now();
  }

  view(): CliInstallJobView {
    return {
      state: this.state,
      startedAt: this.startedAt,
      ...(this.finishedAt !== undefined ? { finishedAt: this.finishedAt } : {}),
      log: cleanLog(this.log),
      ...(this.error ? { error: this.error() } : {}),
    };
  }
}

/** What the installs need from the computer; tests swap in fakes. */
export interface CliInstallHost {
  platform: NodeJS.Platform;
  /** The processor Node.js's build is for (`process.arch`). */
  arch: string;
  /** Node.js's build for this computer, which a `withNode` recipe installs with when npm is not on the PATH (`nodeBuildFor`). */
  nodeBuild: () => NodeBuild | undefined;
  /** The server's environment (`installerEnv` takes what an installer is not given out of it). */
  env: NodeJS.ProcessEnv;
  home: string;
  /** Where the CLIs go, each in a folder of its own (`cliFolder()`). */
  dir: string;
  run: (o: SpawnOptions) => Promise<SpawnResult>;
  /** Runs fixed script text in a shell (`runShellScript`): Windows PowerShell's here. */
  runScript: (shell: string, flags: readonly string[], script: string, o: RunOptions) => Promise<SpawnResult>;
  isFile: (path: string) => boolean;
  /** The version the program installed for `p` says it is (`--version`); throws when it does not run. */
  version: (p: Provider, bin: string, signal: AbortSignal) => Promise<string | undefined>;
  /** On Windows, the user's PATH as it is stored (`USER_PATH_READ_SCRIPT`); throws when it cannot be read. */
  readUserPath: () => Promise<string>;
  /** On Windows, puts the user's PATH back as `readUserPath` gave it (`USER_PATH_RESTORE_SCRIPT`); whether it had changed. */
  restoreUserPath: (saved: string) => Promise<boolean>;
}

/**
 * Runs one command of an install (`script`: fixed text for the shell `o.bin`, given `o.args`), its
 * output into the job's log; throws when it fails (an `InstallError` saying how), or `aborted`.
 */
export async function runStep(
  host: Pick<CliInstallHost, 'run' | 'runScript'>,
  job: InstallJob,
  shown: string,
  o: Pick<SpawnOptions, 'bin' | 'args' | 'env' | 'cwd'>,
  script?: string,
): Promise<SpawnResult> {
  job.append(`$ ${shown}\n`);
  const run: RunOptions = {
    env: o.env,
    cwd: o.cwd,
    signal: job.abort.signal,
    timeoutMs: INSTALL_TIMEOUT_MS,
    onLine: (line) => job.append(`${line}\n`),
    onSpawn: (child) => child.stderr?.on('data', (b: Buffer) => job.append(b.toString('utf8'))),
  };
  const r = await (script === undefined ? host.run({ ...run, bin: o.bin, args: o.args }) : host.runScript(o.bin, o.args, script, run));
  if (r.aborted || job.abort.signal.aborted) throw new Error('aborted');
  if (r.timedOut) throw new InstallError(() => t().cliInstallTimedOut(shown));
  if (r.code !== 0) throw new InstallError(() => t().cliInstallFailed(shown, r.code), r.code);
  return r;
}

/** Windows' System32 folder, as `env` names the system's. */
const system32Of = (env: NodeJS.ProcessEnv) => win32.join(env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows', 'System32');

/** curl: on the PATH, else where the system keeps it (on Windows, System32). */
export function findCurl(host: Pick<CliInstallHost, 'env' | 'platform' | 'isFile'>): string | undefined {
  const { env, platform, isFile } = host;
  return findOnPath('curl', env, platform, platform === 'win32' ? [system32Of(env)] : SYSTEM_DIRS, isFile);
}

/**
 * What puts Node.js's build into a folder here: the build for this computer, curl to download it and
 * tar to take Node and npm out of it (on Windows the bsdtar in System32, which reads a `.zip`; not
 * another `tar` on the PATH, such as Git for Windows' GNU tar, which reads none); else what is missing
 * (`npm` when Node.js has no build for this computer).
 */
export function nodeTools(
  host: Pick<CliInstallHost, 'env' | 'platform' | 'isFile' | 'nodeBuild'>,
): { build: NodeBuild; curl: string; tar: string } | CliInstallBlock {
  const { env, platform, isFile } = host;
  const build = host.nodeBuild();
  if (!build) return 'npm';
  const curl = findCurl(host);
  if (!curl) return 'curl';
  const system32tar = win32.join(system32Of(env), 'tar.exe');
  const tar =
    platform === 'win32' ? (isFile(system32tar) ? system32tar : undefined) : findOnPath('tar', env, platform, SYSTEM_DIRS, isFile);
  return tar ? { build, curl, tar } : 'tar';
}

/**
 * Puts Node.js's build into the folder `dir` (`folderNpm` says where its Node and npm are then): its
 * archive downloaded whole into `dir`'s install cache (the caller deletes it), checked against the
 * checksum Harness Relay has for it, and only Node and npm taken out of it, into the places npm's
 * global folder has them beside its Node, then checked to run (`--version`). `intro`: the log's first
 * line, saying why. Throws an `InstallError` that says what went wrong.
 */
export async function putNode(
  host: Pick<CliInstallHost, 'env' | 'platform' | 'isFile' | 'nodeBuild' | 'run' | 'runScript'>,
  job: InstallJob,
  dir: string,
  base: NodeJS.ProcessEnv,
  label: string,
  intro: (version: string) => string,
): Promise<{ bin: string; args: string[] }> {
  const tools = nodeTools(host);
  if (typeof tools === 'string') throw new InstallError(() => t().cliInstallBlocked(label, tools));
  const { build, curl, tar } = tools;
  const cache = join(dir, INSTALL_CACHE, 'node');
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, build.file);
  job.append(`${intro(build.version)}\n`);
  await runStep(host, job, `curl -fsSL ${build.url}`, {
    bin: curl,
    args: ['-fsSL', '--retry', '3', '-o', archive, build.url],
    env: base,
    cwd: dir,
  });
  const sum = await sha256Of(archive);
  if (sum !== build.sha256) throw new InstallError(() => t().cliNodeChecksum(build.url, build.sha256, sum));
  job.append(`SHA-256 ${sum}: as Node.js published it\n`);
  await runStep(host, job, `tar -xf ${build.file}`, {
    bin: tar,
    args: ['-xf', archive, '-C', dir, '--strip-components', '1', ...build.members],
    env: base,
    cwd: dir,
  });
  const npm = folderNpm(dir, host.platform);
  for (const file of [npm.bin, ...npm.args]) if (!host.isFile(file)) throw new InstallError(() => t().cliInstallNoProgram(file));
  // That it runs here, before anything runs on it: Node.js's Linux builds need libatomic, which a
  // minimal system may lack (a desktop one has it), and that is said as such.
  try {
    await runStep(host, job, `${npm.bin} --version`, { bin: npm.bin, args: ['--version'], env: base, cwd: dir });
  } catch (err) {
    if (job.abort.signal.aborted || !(err instanceof InstallError)) throw err;
    const linux = host.platform === 'linux';
    throw new InstallError(() => t().cliNodeDoesNotRun(linux));
  }
  return npm;
}

export class CliInstaller {
  private host: CliInstallHost;
  private jobs = new Map<Provider, InstallJob>();
  /** The CLIs whose folder is being deleted: not installed again before that is done. */
  private removing = new Set<Provider>();
  /** On Windows, the scripts that may change the user's PATH, one after another (`keepingUserPath`). */
  private userPathTurn: Promise<void> = Promise.resolve();
  private userPathWaiting = 0;

  constructor(
    private settings: SettingsStore,
    private hooks: {
      /** A CLI was installed or removed (or an install of it ended): its status is asked again. */
      changed?: (p: Provider) => void;
      /** Whether agents are at work, which a removal waits for. */
      busy?: () => boolean;
    } = {},
    host: Partial<CliInstallHost> = {},
  ) {
    this.host = {
      platform: process.platform,
      arch: process.arch,
      nodeBuild: () => nodeBuildFor(this.host.platform, this.host.arch, this.host.isFile),
      env: process.env,
      home: homedir(),
      dir: cliFolder(),
      run: runProcess,
      runScript: runShellScript,
      isFile: fileExists,
      version: (p, bin, signal) => this.askVersion(p, bin, signal),
      readUserPath: () => this.askUserPath(),
      restoreUserPath: (saved) => this.writeUserPath(saved),
      ...host,
    };
  }

  /** How many installs are under way (the desktop app's update waits for them, as for agents at work). */
  running(): number {
    return [...this.jobs.values()].filter((j) => j.state === 'running').length;
  }

  /** The folder a CLI is installed in. */
  folder(p: Provider): string {
    return join(this.host.dir, p);
  }

  /** Every CLI, in Settings' order. */
  views(): CliInstallView[] {
    return PROVIDERS.map((p) => this.view(p));
  }

  view(p: Provider): CliInstallView {
    const recipe = CLI_RECIPES[p];
    const job = this.jobs.get(p);
    const blocked = this.blocked(p);
    const installed = job?.state === 'running' ? undefined : this.installed(p);
    const node = blocked ? undefined : this.nodeFirst(recipe);
    return {
      provider: p,
      method: recipe.method,
      command: installCommand(recipe, this.host.platform, recipe.method === 'uv' && !this.uv(), node),
      ...(blocked ? { blocked } : {}),
      ...(node ? { node: node.version } : {}),
      dir: this.folder(p),
      ...(installed
        ? {
            installed: {
              bin: installed.bin,
              ...(installed.version ? { version: installed.version } : {}),
              at: installed.at,
              inUse: this.settings.customBin(p) === installed.bin,
            },
          }
        : {}),
      ...(job ? { job: job.view() } : {}),
    };
  }

  /** Why the CLI cannot be installed here, or undefined. */
  private blocked(p: Provider): CliInstallBlock | undefined {
    const recipe = CLI_RECIPES[p];
    const { env, platform, isFile } = this.host;
    if (recipe.method === 'npm') {
      if (npmLaunch(env, platform, isFile)) return undefined;
      // Without npm, Node.js's build goes first for the recipes that take it: what that needs.
      if (!recipe.withNode) return 'npm';
      const tools = this.nodeTools();
      return typeof tools === 'string' ? tools : undefined;
    }
    // Without uv, uv's own installer goes first: what it needs.
    const script =
      recipe.method === 'uv' ? (this.uv() ? undefined : (uvInstallerFor(platform) ?? 'system')) : (scriptFor(recipe, platform) ?? 'system');
    if (script === undefined || typeof script === 'string') return script;
    const runner = this.scriptRunner(script);
    return typeof runner === 'string' ? runner : undefined;
  }

  /**
   * What downloads and runs a maker's script here: curl (on Windows the one in System32), and bash (on
   * Windows Git for Windows' bash) or Windows PowerShell; else what is missing.
   */
  private scriptRunner(script: ScriptInstaller): { curl: string; shell: string } | CliInstallBlock {
    const { env, platform, isFile } = this.host;
    if (platform === 'win32') {
      const curl = this.curl();
      if (!curl) return 'curl';
      const shell = script.shell === 'powershell' ? windowsPowerShell(env, isFile) : gitBash(env, isFile);
      return shell ? { curl, shell } : script.shell === 'powershell' ? 'powershell' : 'gitBash';
    }
    if (platform !== 'darwin' && platform !== 'linux') return 'system';
    const curl = this.curl();
    if (!curl) return 'curl';
    const bash = findOnPath('bash', env, platform, SYSTEM_DIRS, isFile);
    return bash ? { curl, shell: bash } : 'bash';
  }

  private curl(): string | undefined {
    return findCurl(this.host);
  }

  private nodeTools(): { build: NodeBuild; curl: string; tar: string } | CliInstallBlock {
    return nodeTools(this.host);
  }

  /** Node.js's build, when the recipe's install puts it into the folder first (npm is not on the PATH). */
  private nodeFirst(recipe: CliRecipe): NodeBuild | undefined {
    if (recipe.method !== 'npm' || !recipe.withNode) return undefined;
    const { env, platform, isFile } = this.host;
    if (npmLaunch(env, platform, isFile)) return undefined;
    const tools = this.nodeTools();
    return typeof tools === 'string' ? undefined : tools.build;
  }

  private uv(): string | undefined {
    const { env, platform, isFile, home } = this.host;
    return findOnPath('uv', env, platform, uvDirs(home, platform), isFile);
  }

  /** What Harness Relay installed of the CLI, when its note is there and its program too. */
  private installed(p: Provider): InstallNote | undefined {
    const note = this.note(p);
    return note && this.host.isFile(note.bin) ? note : undefined;
  }

  /** The install's note in the CLI's folder, when it is one Harness Relay wrote for this CLI. */
  private note(p: Provider): InstallNote | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(this.folder(p), INSTALL_NOTE), 'utf8'));
    } catch {
      return undefined;
    }
    const n = raw as Partial<InstallNote> | null;
    if (!n || typeof n !== 'object' || n.provider !== p || typeof n.bin !== 'string' || !inside(n.bin, this.folder(p))) return undefined;
    return {
      provider: p,
      method: CLI_RECIPES[p].method,
      source: typeof n.source === 'string' ? n.source : '',
      bin: n.bin,
      ...(typeof n.version === 'string' && n.version ? { version: n.version } : {}),
      at: typeof n.at === 'number' ? n.at : 0,
      previousBin: typeof n.previousBin === 'string' ? n.previousBin : '',
    };
  }

  /** Starts installing the CLI in the background; its view says how it goes. */
  install(p: Provider): CliInstallView {
    const label = PROVIDER_LABEL[p];
    if (this.jobs.get(p)?.state === 'running') throw new HttpError(409, t().cliInstallRunning(label));
    if (this.removing.has(p)) throw new HttpError(409, t().cliRemoving(label));
    if (this.installed(p)) throw new HttpError(409, t().cliAlreadyInstalled(label));
    const blocked = this.blocked(p);
    if (blocked) throw new HttpError(400, t().cliInstallBlocked(label, blocked));
    const job = new InstallJob();
    this.jobs.set(p, job);
    job.ended = this.runJob(p, job);
    return this.view(p);
  }

  /** Stops the CLI's install under way; what it left is removed. */
  cancel(p: Provider): CliInstallView {
    const job = this.jobs.get(p);
    if (job?.state !== 'running') throw new HttpError(409, t().cliInstallNone(PROVIDER_LABEL[p]));
    job.abort.abort();
    return this.view(p);
  }

  /**
   * Deletes what Harness Relay installed of the CLI (its folder), and sets its executable path back to
   * what it was before the install when it still names the program removed. Not while agents are at
   * work: a turn of the CLI would lose its program under it.
   */
  async remove(p: Provider): Promise<CliInstallView> {
    const label = PROVIDER_LABEL[p];
    if (this.jobs.get(p)?.state === 'running') throw new HttpError(409, t().cliInstallRunning(label));
    if (this.removing.has(p)) throw new HttpError(409, t().cliRemoving(label));
    const note = this.note(p);
    if (!note) throw new HttpError(404, t().cliNotInstalledHere(label));
    if (this.hooks.busy?.()) throw new HttpError(409, t().cliRemoveBusy(label));
    const dir = this.folder(p);
    if (this.settings.customBin(p) === note.bin) this.settings.update(p, { bin: note.previousBin });
    this.jobs.delete(p);
    this.removing.add(p);
    try {
      // Links in it are removed, never followed.
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      // And the links an installer put outside it that lead into it.
      this.dropOutside(dir);
    } catch (err) {
      throw new Error(t().cliRemoveFailed(dir, (err as Error).message));
    } finally {
      this.removing.delete(p);
      this.hooks.changed?.(p);
    }
    return this.view(p);
  }

  /**
   * Stops every install under way (the server is stopping); settles once they have cleaned up after
   * themselves (on Windows, the user's PATH put back). The next install removes what they left.
   */
  shutdown(): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.state === 'running');
    for (const job of running) job.abort.abort();
    return Promise.all(running.map((j) => j.ended)).then(() => undefined);
  }

  /**
   * On Windows, puts the user's PATH back as it was before a script that the server did not live to
   * see end (it was killed, or the computer stopped), as kept in `USER_PATH_SAVED`. Run at startup.
   */
  async recover(): Promise<void> {
    if (this.host.platform !== 'win32') return;
    try {
      await this.userPathQueue(() => this.restoreSaved());
    } catch {
      /* said by restoreSaved; tried again before the next script */
    }
  }

  private async runJob(p: Provider, job: InstallJob): Promise<void> {
    const dir = this.folder(p);
    const recipe = CLI_RECIPES[p];
    // An earlier install of it whose program is gone: the path set before that one is the one to go back to.
    const earlier = this.note(p);
    try {
      // What an install the server was stopped during left, or a program removed by hand left beside its note.
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      mkdirSync(dir, { recursive: true });
      try {
        await this.runInstaller(p, recipe, dir, job);
      } finally {
        // What it put outside the folder that leads into it, whether it finished or not.
        this.dropOutside(dir, job);
        // The downloads it kept to install from (removed with the folder, should this fail).
        await rm(join(dir, INSTALL_CACHE), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
      }
      if (job.abort.signal.aborted) throw new Error('aborted');
      const bin = installedProgram(recipe, dir, this.host.platform);
      if (!this.host.isFile(bin)) throw new InstallError(() => t().cliInstallNoProgram(bin));
      job.append(`\n$ ${bin} --version\n`);
      let version: string | undefined;
      try {
        version = await this.host.version(p, bin, job.abort.signal);
      } catch (err) {
        if (job.abort.signal.aborted) throw err;
        const detail = (err as Error).message;
        throw new InstallError(() => t().cliInstallDoesNotRun(detail));
      }
      if (job.abort.signal.aborted) throw new Error('aborted');
      job.append(`${version ?? ''}\n`);
      const note: InstallNote = {
        provider: p,
        method: recipe.method,
        source: recipe.method === 'script' ? (scriptFor(recipe, this.host.platform) ?? recipe.posix).url : recipe.package,
        bin,
        ...(version ? { version } : {}),
        at: Date.now(),
        previousBin: this.previousBin(p, bin, earlier),
      };
      writeFileSync(join(dir, INSTALL_NOTE), JSON.stringify(note, null, 2) + '\n');
      // Every start of the CLI runs it from now on (the user can set another path, or remove it).
      this.settings.update(p, { bin });
      job.finish('success');
    } catch (err) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch (rmErr) {
        console.warn(`[clis] could not remove ${dir}: ${(rmErr as Error).message}`);
      }
      if (job.abort.signal.aborted) job.finish('cancelled', () => t().cliInstallCancelled);
      else job.finish('failed', err instanceof InstallError ? err.render : () => (err as Error).message);
    } finally {
      this.hooks.changed?.(p);
    }
  }

  /**
   * The CLI's executable path to set back when what is installed now is removed: the one set now,
   * unless it is an earlier install's own program (installed again over it), whose own path before
   * it is then the one.
   */
  private previousBin(p: Provider, bin: string, earlier: InstallNote | undefined): string {
    const now = this.settings.customBin(p);
    if (now === bin || (earlier && now === earlier.bin)) return earlier?.previousBin ?? '';
    return now;
  }

  /** Runs the recipe's installer into `dir`, its output into the job's log. */
  private async runInstaller(p: Provider, recipe: CliRecipe, dir: string, job: InstallJob): Promise<void> {
    const base = installerEnv(this.host.env);
    const label = PROVIDER_LABEL[p];
    if (recipe.method === 'npm') {
      let npm = npmLaunch(this.host.env, this.host.platform, this.host.isFile);
      // The folder of the Node npm runs on: the PATH's (the system's paths), or the one in the CLI's own folder (this computer's).
      let nodeDir = npm && (this.host.platform === 'win32' ? win32 : posix).dirname(npm.bin);
      if (!npm) {
        if (!recipe.withNode) throw new InstallError(() => t().cliInstallBlocked(label, 'npm'));
        npm = await this.installNode(job, dir, base, label);
        nodeDir = dirname(npm.bin);
      }
      // Its cache (and the logs it writes there) in the folder, not the user's `~/.npm`.
      const cache = join(dir, INSTALL_CACHE, 'npm');
      const args = [
        ...npm.args,
        'install',
        '--global',
        '--prefix',
        dir,
        '--cache',
        cache,
        '--no-audit',
        '--no-fund',
        '--no-update-notifier',
        recipe.package,
      ];
      // npm's folder first on the PATH: the Node beside it runs npm's script (`#!/usr/bin/env node`),
      // and the packages' install scripts, also when that folder is not on the PATH (Homebrew's).
      const env = pathFirst(base, nodeDir!, this.host.platform);
      await this.step(job, `npm install -g --prefix ${dir} ${recipe.package}`, { bin: npm.bin, args, env, cwd: dir });
      return;
    }
    const { platform } = this.host;
    if (recipe.method === 'uv') {
      let uv = this.uv();
      if (!uv) {
        // uv's own installer, into this folder (removed with it).
        const installer = uvInstallerFor(platform);
        if (!installer) throw new InstallError(() => t().cliInstallBlocked(label, 'system'));
        await this.runScript(job, dir, installer, base, label);
        uv = join(dir, ...installer.bin);
        if (!this.host.isFile(uv)) throw new InstallError(() => t().cliInstallNoProgram(uv!));
      }
      const args = uvInstallArgs(recipe, platform);
      await this.step(job, `uv ${args.join(' ')}`, { bin: uv, args, env: uvEnv(base, dir), cwd: dir });
      return;
    }
    const script = scriptFor(recipe, platform);
    if (!script) throw new InstallError(() => t().cliInstallBlocked(label, 'system'));
    await this.runScript(job, dir, script, base, label);
  }

  /**
   * Puts Node.js's build into the CLI's folder `dir` for its npm (`putNode`). It stays, removed with
   * the CLI: Codex's and Copilot's programs run on that Node.
   */
  private installNode(job: InstallJob, dir: string, base: NodeJS.ProcessEnv, label: string): Promise<{ bin: string; args: string[] }> {
    return putNode(
      this.host,
      job,
      dir,
      base,
      label,
      (version) => `npm is not on the PATH: Node.js ${version}, with its npm, goes into ${dir} first`,
    );
  }

  /**
   * Downloads a maker's script whole into `dir` (a connection cut off halfway would run half a
   * script), then runs it there with `dir` as its home (`scriptEnv`): bash on macOS and Linux, Git for
   * Windows' bash or Windows PowerShell on Windows, where the user's PATH is put back as it was before
   * it once it ended (`keepingUserPath`). The script itself does not stay.
   */
  private async runScript(job: InstallJob, dir: string, script: ScriptInstaller, base: NodeJS.ProcessEnv, label: string): Promise<void> {
    const runner = this.scriptRunner(script);
    if (typeof runner === 'string') throw new InstallError(() => t().cliInstallBlocked(label, runner));
    const { platform } = this.host;
    const powershell = script.shell === 'powershell';
    const file = join(dir, powershell ? 'install.ps1' : 'install.sh');
    mkdirSync(join(dir, 'home'), { recursive: true });
    await this.step(job, `curl -fsSL ${script.url}`, {
      bin: runner.curl,
      args: ['-fsSL', '--retry', '3', '-o', file, script.url],
      env: base,
      cwd: dir,
    });
    const args = script.args?.(dir) ?? [];
    const env = scriptEnv(base, dir, script, platform);
    const run = async () => {
      if (powershell) {
        // As a script block made from the file's text (`POWERSHELL_RUN_SCRIPT`), the file and its arguments in its environment.
        const scriptVars = { HARNESS_RELAY_SCRIPT: file, HARNESS_RELAY_SCRIPT_ARGS: args.join('\n') };
        await this.step(
          job,
          ['powershell', basename(file), ...args].join(' '),
          { bin: runner.shell, args: POWERSHELL_FLAGS, env: { ...env, ...scriptVars }, cwd: dir },
          POWERSHELL_RUN_SCRIPT,
        );
        return;
      }
      // Git for Windows' bash takes Windows paths written with forward slashes (`C:/…`).
      const forBash = platform === 'win32' ? (v: string) => v.replace(/\\/g, '/') : (v: string) => v;
      const pathVars = [
        'HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
        ...Object.keys(script.env?.(dir) ?? {}),
      ];
      const bashEnv = { ...env, ...Object.fromEntries(pathVars.filter((k) => env[k]).map((k) => [k, forBash(env[k]!)])) };
      await this.step(job, ['bash', basename(file), ...args].join(' '), {
        bin: runner.shell,
        args: [forBash(file), ...args.map(forBash)],
        env: bashEnv,
        cwd: dir,
      });
    };
    await (platform === 'win32' ? this.keepingUserPath(job, run) : run());
    rmSync(file, { force: true });
  }

  /**
   * Runs `fn`, a script that may change the user's PATH on Windows, and puts the PATH back as it was
   * before it once it ended, however it ended: a script given the CLI's folder as its home that reads
   * the user's PATH and writes it back (Cursor's, Grok's) would have turned the user's own
   * `%USERPROFILE%` entries into paths inside the folder, as it adds its own. One such script at a time
   * (`userPathQueue`): another's would read this one's PATH, and put it back after this one's ended.
   * What the PATH was is kept in `USER_PATH_SAVED` until it is back, for `recover`.
   */
  private async keepingUserPath(job: InstallJob, fn: () => Promise<void>): Promise<void> {
    if (this.userPathWaiting > 0) job.append('Waiting for another install to end: one at a time may change the user PATH\n');
    await this.userPathQueue(async () => {
      // One that could not be put back earlier, first: it is what the user's PATH was.
      await this.restoreSaved();
      let saved: string;
      try {
        saved = await this.host.readUserPath();
      } catch (err) {
        const detail = (err as Error).message;
        throw new InstallError(() => t().cliUserPathUnread(detail));
      }
      writeFileSync(join(this.host.dir, USER_PATH_SAVED), saved);
      let failure: unknown;
      try {
        await fn();
      } catch (err) {
        failure = err;
      }
      try {
        await this.restoreSaved(job);
      } catch (err) {
        failure ??= err;
      }
      if (failure !== undefined) throw failure;
    }, job.abort.signal);
  }

  /**
   * Puts the user's PATH back as `USER_PATH_SAVED` keeps it, when it is there, then removes it; says so
   * in the job's log when the PATH had changed. Throws when it cannot (the file stays, for the next try).
   */
  private async restoreSaved(job?: InstallJob): Promise<void> {
    const file = join(this.host.dir, USER_PATH_SAVED);
    let saved: string;
    try {
      saved = readFileSync(file, 'utf8').trim();
    } catch {
      return;
    }
    if (!SAVED_USER_PATH.test(saved)) {
      rmSync(file, { force: true });
      return;
    }
    try {
      if (await this.host.restoreUserPath(saved)) job?.append('Put the user PATH back as it was before the installer ran\n');
    } catch (err) {
      const detail = (err as Error).message;
      console.warn(`[clis] could not put the user PATH back from ${file}: ${detail}`);
      throw new InstallError(() => t().cliUserPathNotBack(detail));
    }
    rmSync(file, { force: true });
  }

  /**
   * Runs `fn` once every earlier one has ended (or, with `signal`, sooner when it is stopped while it
   * waits, without running `fn`): the scripts that may change the user's PATH on Windows.
   */
  private async userPathQueue(fn: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const before = this.userPathTurn;
    let done!: () => void;
    const mine = new Promise<void>((r) => (done = r));
    this.userPathTurn = before.then(() => mine);
    this.userPathWaiting++;
    try {
      await (signal ? Promise.race([before, untilAborted(signal)]) : before);
      if (signal?.aborted) throw new Error('aborted');
      await fn();
    } finally {
      this.userPathWaiting--;
      done();
    }
  }

  /**
   * Removes what an installer put outside the CLI's folder `dir` that leads into it, on macOS and
   * Linux: the links in the PATH's folders (and `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`)
   * to anything inside it, each said in the job's log. (On Windows, a script's changes to the user's
   * PATH are put back once it ended: `keepingUserPath`.)
   */
  private dropOutside(dir: string, job?: InstallJob): void {
    const { platform, env, home } = this.host;
    if (platform === 'win32') return;
    for (const link of dropLinksInto(dir, linkFolders(env, home))) job?.append(`Removed ${link}, a link into ${dir}\n`);
  }

  /** Runs one of the fixed PowerShell scripts above with `vars` in its environment; what it wrote. */
  private async powershellScript(script: string, vars: Record<string, string>): Promise<string> {
    const powershell = windowsPowerShell(this.host.env, this.host.isFile);
    if (!powershell) throw new Error('Windows PowerShell is not there');
    const r = await this.host.runScript(powershell, POWERSHELL_FLAGS, script, {
      env: { ...installerEnv(this.host.env), ...vars },
      timeoutMs: 60_000,
    });
    if (r.code !== 0) throw new Error(tail(r.stderr || r.stdout, 300) || (r.timedOut ? 'timed out' : `exit ${r.code}`));
    return r.stdout;
  }

  private async askUserPath(): Promise<string> {
    const saved = (await this.powershellScript(USER_PATH_READ_SCRIPT, {})).trim();
    if (!SAVED_USER_PATH.test(saved)) throw new Error(`Unexpected answer: ${saved.slice(0, 200)}`);
    return saved;
  }

  private async writeUserPath(saved: string): Promise<boolean> {
    return (await this.powershellScript(USER_PATH_RESTORE_SCRIPT, { HARNESS_RELAY_USER_PATH: saved })).trim() === 'changed';
  }

  private async step(
    job: InstallJob,
    shown: string,
    o: Pick<SpawnOptions, 'bin' | 'args' | 'env' | 'cwd'>,
    script?: string,
  ): Promise<void> {
    await runStep(this.host, job, shown, o, script);
  }

  /** `<bin> --version` in the CLI's own environment, as its status asks it; stopped with the install. */
  private async askVersion(p: Provider, bin: string, signal: AbortSignal): Promise<string | undefined> {
    const env = this.settings.env(p);
    const r = await runProcess({
      bin,
      args: ['--version'],
      env: isOpenProvider(p) ? openHomeEnv(openAgents[p].process, env) : env,
      timeoutMs: VERSION_TIMEOUT_MS,
      signal,
    });
    if (r.aborted) throw new Error('aborted');
    if (r.code !== 0) throw new Error(tail(stripAnsi(r.stderr || r.stdout), 400) || (r.timedOut ? 'timed out' : `exit ${r.code}`));
    return parseVersion(r.stdout || r.stderr);
  }
}
