import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PROVIDERS, type Provider } from '../src/shared/types';
import { createApp } from '../src/server/app';
import {
  CLI_RECIPES,
  CliInstaller,
  INSTALL_CACHE,
  INSTALL_NOTE,
  NODE_VERSION,
  POWERSHELL_RUN_SCRIPT,
  USER_PATH_READ_SCRIPT,
  USER_PATH_RESTORE_SCRIPT,
  USER_PATH_SAVED,
  UV_INSTALLERS,
  cleanLog,
  dropLinksInto,
  folderNpm,
  gitBash,
  installCommand,
  installedProgram,
  installerEnv,
  linkFolders,
  nodeBuildFor,
  npmLaunch,
  pathFirst,
  scriptEnv,
  scriptFor,
  uvEnv,
  windowsPowerShell,
  type CliInstallHost,
  type CliRecipe,
  type NodeBuild,
} from '../src/server/cliInstall';
import { openDatabase } from '../src/server/db';
import { HttpError } from '../src/server/errors';
import { Hub } from '../src/server/hub';
import { withLang } from '../src/server/i18n';
import { Orchestrator } from '../src/server/orchestrator';
import type { RunOptions, SpawnOptions, SpawnResult } from '../src/server/process';
import { ProviderService } from '../src/server/providers';
import { SettingsStore } from '../src/server/settings';
import { Store } from '../src/server/store';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-clis-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/** A folder of its own for each test's installs. */
const freshDir = () => join(root, `clis-${++n}`);

function result(code: number | null, stdout = '', stderr = '', o: Partial<SpawnResult> = {}): SpawnResult {
  const bytes = Buffer.from(stdout);
  return { code, signal: null, stdout, stdoutBytes: bytes, stdoutTruncated: false, stdoutSize: bytes.length, stderr, aborted: false, timedOut: false, ...o };
}

/** An installer that runs until it is stopped (`signal`), as runProcess ends one: `aborted`. */
const untilStopped = (s: SpawnOptions) =>
  new Promise<SpawnResult>((resolve) => {
    const stop = () => resolve(result(null, '', '', { aborted: true }));
    if (s.signal!.aborted) stop();
    else s.signal!.addEventListener('abort', stop);
  });

/** A file at `path`, made with its folders. */
function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}

const isRealFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The programs on the fake PATH (POSIX paths, as `findOnPath` builds them for 'linux'). */
const TOOLS = ['/fake/bin/npm', '/fake/bin/uv', '/fake/bin/curl', '/fake/bin/bash'];
/** A Windows computer's: npm (beside Node), curl and PowerShell in System32, Git for Windows. */
const WIN_TOOLS = [
  'C:\\nodejs\\npm.cmd',
  'C:\\nodejs\\node.exe',
  'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
  'C:\\Windows\\System32\\curl.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe',
];
const WIN_ENV = { Path: 'C:\\nodejs;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32', PATHEXT: '.EXE;.CMD', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', KEEP: 'me' };

/** The user's PATH on a stock Windows, as `USER_PATH_READ_SCRIPT` writes it. */
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const STOCK_USER_PATH = `ExpandString:${b64('%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;')}`;

/** A run of an installer: a program, or (`script`) fixed text for a shell. */
type Run = SpawnOptions & { script?: string };

/**
 * A computer without network or real installers: each installer run is recorded and, unless `onRun`
 * answers it, puts the program where the real one would (`installedProgram`) and exits 0. On Windows
 * its user PATH is `registry.path` (as `USER_PATH_READ_SCRIPT` writes it).
 */
function fakeHost(
  dir: string,
  o: {
    tools?: string[];
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    onRun?: (s: Run) => Promise<SpawnResult | undefined> | SpawnResult | undefined;
    version?: CliInstallHost['version'];
    nodeBuild?: CliInstallHost['nodeBuild'];
    readUserPath?: CliInstallHost['readUserPath'];
    restoreUserPath?: CliInstallHost['restoreUserPath'];
  } = {},
) {
  const calls: Run[] = [];
  const platform = o.platform ?? 'linux';
  const win = platform === 'win32';
  // Windows finds a file whatever the case of its name (PATHEXT gives `.EXE`).
  const tools = new Set((o.tools ?? (win ? WIN_TOOLS : TOOLS)).map((t) => (win ? t.toLowerCase() : t)));
  const registry = { path: STOCK_USER_PATH, reads: 0, restores: [] as string[] };
  const answer = async (s: Run): Promise<SpawnResult> => {
    calls.push(s);
    const answer = await o.onRun?.(s);
    if (answer) return answer;
    const p = basename(s.cwd ?? '') as Provider;
    const tool = basename(s.bin.replace(/\\/g, '/')).replace(/\.exe$/i, '');
    // npm and uv keep what they download in the cache they are given.
    if (s.args.includes('--cache')) touch(join(s.args[s.args.indexOf('--cache') + 1]!, '_cacache', 'index'));
    if (s.env.UV_CACHE_DIR) touch(join(s.env.UV_CACHE_DIR, 'wheels', 'index'));
    if (tool === 'curl') touch(s.args[s.args.indexOf('-o') + 1]!);
    // uv's own installer puts uv where it is told.
    else if (s.env.UV_UNMANAGED_INSTALL) touch(join(s.env.UV_UNMANAGED_INSTALL, win ? 'uv.exe' : 'uv'));
    else touch(installedProgram(CLI_RECIPES[p], s.cwd!, platform));
    s.onLine?.(`${tool} done`);
    return result(0, `${tool} done`);
  };
  const host: Partial<CliInstallHost> = {
    platform,
    arch: 'x64',
    ...(o.nodeBuild ? { nodeBuild: o.nodeBuild } : {}),
    env: o.env ?? (win ? WIN_ENV : { PATH: '/fake/bin', CLAUDECODE: '1', npm_lifecycle_event: 'start', KEEP: 'me' }),
    home: win ? 'C:\\Users\\me' : '/fake/home',
    dir,
    // The fake PATH's programs, and what the installs wrote (never this computer's own /usr/bin).
    isFile: (p) => tools.has(win ? p.toLowerCase() : p) || (p.startsWith(root) && isRealFile(p)),
    version: o.version ?? (async () => '1.2.3'),
    readUserPath:
      o.readUserPath ??
      (async () => {
        registry.reads++;
        return registry.path;
      }),
    restoreUserPath:
      o.restoreUserPath ??
      (async (saved) => {
        registry.restores.push(saved);
        const changed = registry.path !== saved;
        registry.path = saved;
        return changed;
      }),
    run: answer,
    runScript: (shell: string, flags: readonly string[], script: string, run: RunOptions) => answer({ ...run, bin: shell, args: [...flags], script }),
  };
  return { host, calls, registry };
}

function installer(o: Parameters<typeof fakeHost>[1] & { busy?: () => boolean } = {}) {
  const dir = freshDir();
  const settings = new SettingsStore(openDatabase(':memory:'));
  const changed = vi.fn();
  const { host, calls, registry } = fakeHost(dir, o);
  const clis = new CliInstaller(settings, { changed, busy: o.busy }, host);
  return { clis, settings, changed, calls, dir, registry };
}

const script = (p: 'grok' | 'cursor' | 'antigravity' | 'muse' | 'goose') => CLI_RECIPES[p] as Extract<CliRecipe, { method: 'script' }>;

/** Waits until the CLI's install has ended, and returns its view. */
async function ended(clis: CliInstaller, p: Provider) {
  await vi.waitFor(() => expect(clis.view(p).job?.state).not.toBe('running'));
  return clis.view(p);
}

describe('the recipes', () => {
  it('has one for every CLI, each a program in the CLI’s own folder', () => {
    for (const p of PROVIDERS) {
      const r = CLI_RECIPES[p];
      expect(r, p).toBeDefined();
      const dir = join(root, 'x', p);
      expect(installedProgram(r, dir, 'linux').startsWith(dir)).toBe(true);
      expect(installedProgram(r, dir, 'win32').startsWith(dir)).toBe(true);
    }
  });

  it('installs the open agents at the versions the user guide names, and the others at their newest', () => {
    const guide = readFileSync(join(__dirname, '..', 'docs', 'user-guide.md'), 'utf8');
    for (const p of ['opencode', 'cline', 'openhands', 'pi'] as const) {
      const r = CLI_RECIPES[p] as Extract<CliRecipe, { package: string }>;
      expect(guide, p).toContain(r.package);
    }
    expect(script('goose').posix.env!('/d').GOOSE_VERSION).toBe('v1.58.1');
    expect(script('goose').windows.env!('/d').GOOSE_VERSION).toBe('v1.58.1');
    expect(guide).toContain('1.58.1');
    for (const p of ['claude', 'codex', 'copilot'] as const) expect((CLI_RECIPES[p] as Extract<CliRecipe, { package: string }>).package).not.toMatch(/@\d/);
  });

  it('says what each runs, as one would type it', () => {
    expect(installCommand(CLI_RECIPES.codex)).toBe('npm install -g @openai/codex');
    expect(installCommand(CLI_RECIPES.openhands, 'linux')).toBe('uv tool install openhands==1.16.0');
    // Without uv, uv's own installer first.
    expect(installCommand(CLI_RECIPES.openhands, 'darwin', true)).toBe('curl -fsSL https://astral.sh/uv/install.sh | bash; uv tool install openhands==1.16.0');
    // On Windows, the x64 Python, which also Windows on Arm runs (its own lacks wheels for OpenHands' packages).
    expect(installCommand(CLI_RECIPES.openhands, 'win32', true)).toBe('irm https://astral.sh/uv/install.ps1 | iex; uv tool install --python cpython-3.12-windows-x86_64-none openhands==1.16.0');
    expect(installCommand(CLI_RECIPES.openhands, 'win32')).toBe('uv tool install --python cpython-3.12-windows-x86_64-none openhands==1.16.0');
    expect(installCommand(CLI_RECIPES.grok, 'linux')).toBe('curl -fsSL https://x.ai/cli/install.sh | bash');
    // On Windows, the makers' PowerShell installers; Goose's bash script under Git Bash.
    expect(installCommand(CLI_RECIPES.grok, 'win32')).toBe('irm https://x.ai/cli/install.ps1 | iex');
    expect(installCommand(CLI_RECIPES.cursor, 'win32')).toBe('irm https://cursor.com/install?win32=true | iex');
    expect(installCommand(CLI_RECIPES.antigravity, 'win32')).toBe('irm https://antigravity.google/cli/install.ps1 | iex');
    expect(installCommand(CLI_RECIPES.muse, 'win32')).toBe('irm https://dev.meta.ai/install.ps1 | iex');
    expect(installCommand(CLI_RECIPES.goose, 'win32')).toMatch(/^curl -fsSL https:\/\/github\.com\/aaif-goose\/goose\/.*download_cli\.sh \| bash$/);
    expect(scriptFor(script('grok'), 'freebsd')).toBeUndefined();
  });

  it('finds the program where npm, uv and the scripts put it, on each system', () => {
    const d = join(root, 'p');
    expect(installedProgram(CLI_RECIPES.codex, d, 'linux')).toBe(join(d, 'bin', 'codex'));
    expect(installedProgram(CLI_RECIPES.codex, d, 'win32')).toBe(join(d, 'codex.cmd'));
    expect(installedProgram(CLI_RECIPES.openhands, d, 'darwin')).toBe(join(d, 'bin', 'openhands'));
    expect(installedProgram(CLI_RECIPES.openhands, d, 'win32')).toBe(join(d, 'bin', 'openhands.exe'));
    expect(installedProgram(CLI_RECIPES.cursor, d, 'linux')).toBe(join(d, 'home', '.local', 'bin', 'cursor-agent'));
    expect(installedProgram(CLI_RECIPES.muse, d, 'darwin')).toBe(join(d, 'bin', 'muse'));
    // Windows: what each maker's installer makes there (Cursor's and Muse Code's launchers `winLaunch.ts` starts).
    expect(installedProgram(CLI_RECIPES.grok, d, 'win32')).toBe(join(d, 'bin', 'grok.exe'));
    expect(installedProgram(CLI_RECIPES.cursor, d, 'win32')).toBe(join(d, 'home', 'AppData', 'Local', 'cursor-agent', 'cursor-agent.cmd'));
    expect(installedProgram(CLI_RECIPES.antigravity, d, 'win32')).toBe(join(d, 'bin', 'agy.exe'));
    expect(installedProgram(CLI_RECIPES.muse, d, 'win32')).toBe(join(d, 'bin', 'muse.cmd'));
    expect(installedProgram(CLI_RECIPES.goose, d, 'win32')).toBe(join(d, 'bin', 'goose.exe'));
    expect(join(d, ...UV_INSTALLERS.windows.bin)).toBe(join(d, 'uv', 'bin', 'uv.exe'));
  });
});

describe('npmLaunch', () => {
  // Windows' file names are found whatever their case (PATHEXT gives `.CMD`).
  const files = (...paths: string[]) => (p: string) => paths.some((f) => f.toLowerCase() === p.toLowerCase());

  it('starts npm from the PATH on macOS and Linux, and Homebrew’s on macOS', () => {
    expect(npmLaunch({ PATH: '/a:/b' }, 'linux', files('/b/npm'))).toEqual({ bin: '/b/npm', args: [] });
    expect(npmLaunch({ PATH: '/a' }, 'linux', files('/opt/homebrew/bin/npm'))).toBeUndefined();
    expect(npmLaunch({ PATH: '/a' }, 'darwin', files('/opt/homebrew/bin/npm'))).toEqual({ bin: '/opt/homebrew/bin/npm', args: [] });
  });

  it('runs npm’s script with the Node beside npm.cmd on Windows, never the script itself', () => {
    const env = { PATH: 'C:\\node;C:\\other', PATHEXT: '.exe;.cmd' };
    expect(npmLaunch(env, 'win32', files('C:\\node\\npm.cmd', 'C:\\node\\node.exe', 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js'))).toEqual({
      bin: 'C:\\node\\node.exe',
      args: ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js'],
    });
    // npm.cmd without its Node and script beside it: not started.
    expect(npmLaunch(env, 'win32', files('C:\\node\\npm.cmd'))).toBeUndefined();
    // A program is started as it is.
    expect(npmLaunch(env, 'win32', files('C:\\node\\npm.exe'))).toEqual({ bin: 'C:\\node\\npm.exe', args: [] });
    expect(npmLaunch(env, 'win32', files())).toBeUndefined();
  });
});

describe('Node.js’s build, for npm when it is not on the PATH', () => {
  it('is Node.js’s own archive for each system and processor, with only Node and npm taken out of it', () => {
    const mac = nodeBuildFor('darwin', 'arm64', () => false)!;
    expect(mac).toEqual({
      version: NODE_VERSION,
      url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
      file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
      sha256: 'aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735',
      members: [`node-v${NODE_VERSION}-darwin-arm64/bin/node`, `node-v${NODE_VERSION}-darwin-arm64/lib/node_modules/npm`],
    });
    const win = nodeBuildFor('win32', 'arm64', () => false)!;
    expect(win.url).toBe(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-arm64.zip`);
    expect(win.members).toEqual([`node-v${NODE_VERSION}-win-arm64/node.exe`, `node-v${NODE_VERSION}-win-arm64/node_modules/npm`]);
    // Every system the desktop app is made for, and Intel Macs, each with its own checksum.
    const builds = (['darwin', 'linux', 'win32'] as const).flatMap((os) => (['x64', 'arm64'] as const).map((cpu) => nodeBuildFor(os, cpu, () => false)));
    expect(builds.every((b) => b && /^[0-9a-f]{64}$/.test(b.sha256))).toBe(true);
    expect(new Set(builds.map((b) => b!.sha256)).size).toBe(6);
  });

  it('has none for another system or processor, nor for a Linux with musl, whose Node.js builds are not Node.js’s own', () => {
    expect(nodeBuildFor('freebsd', 'x64', () => false)).toBeUndefined();
    expect(nodeBuildFor('linux', 'ia32', () => false)).toBeUndefined();
    expect(nodeBuildFor('linux', 'x64', (p) => p === '/lib/ld-musl-x86_64.so.1')).toBeUndefined();
    expect(nodeBuildFor('linux', 'arm64', (p) => p === '/lib/ld-musl-aarch64.so.1')).toBeUndefined();
    expect(nodeBuildFor('linux', 'x64', () => false)?.file).toBe(`node-v${NODE_VERSION}-linux-x64.tar.gz`);
  });

  it('lays Node and npm out in the CLI’s folder as npm’s global folder has them beside its Node', () => {
    const d = join(root, 'n');
    expect(folderNpm(d, 'linux')).toEqual({ bin: join(d, 'bin', 'node'), args: [join(d, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] });
    expect(folderNpm(d, 'win32')).toEqual({ bin: join(d, 'node.exe'), args: [join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js')] });
    // The CLI's program goes beside that Node (npm's link in `bin`, or on Windows its `.cmd`), where its launch finds it.
    expect(dirname(installedProgram(CLI_RECIPES.codex, d, 'linux'))).toBe(dirname(folderNpm(d, 'linux').bin));
    expect(dirname(installedProgram(CLI_RECIPES.copilot, d, 'win32'))).toBe(dirname(folderNpm(d, 'win32').bin));
  });

  it('is offered for Claude Code, Codex and Copilot only, and its version is the one the user guide names', () => {
    const withNode = PROVIDERS.filter((p) => CLI_RECIPES[p].method === 'npm' && (CLI_RECIPES[p] as Extract<CliRecipe, { method: 'npm' }>).withNode);
    expect(withNode).toEqual(['claude', 'codex', 'copilot']);
    expect(readFileSync(join(__dirname, '..', 'docs', 'user-guide.md'), 'utf8')).toContain(`Node.js ${NODE_VERSION}`);
    expect(readFileSync(join(__dirname, '..', 'docs', 'user-guide.zh-TW.md'), 'utf8')).toContain(`Node.js ${NODE_VERSION}`);
  });
});

describe('the programs a Windows install runs', () => {
  const files = (...paths: string[]) => (p: string) => paths.some((f) => f.toLowerCase() === p.toLowerCase());

  it('finds Git for Windows’ bash beside its git, or where Git for Windows installs, never WSL’s', () => {
    const env = { Path: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32', PATHEXT: '.exe' };
    expect(gitBash(env, files('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'))).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    // git in mingw64\bin; bash only in usr\bin.
    expect(gitBash({ Path: 'D:\\Git\\mingw64\\bin', PATHEXT: '.exe' }, files('D:\\Git\\mingw64\\bin\\git.exe', 'D:\\Git\\usr\\bin\\bash.exe'))).toBe('D:\\Git\\usr\\bin\\bash.exe');
    // Installed for one user, git not on the PATH.
    const local = { Path: 'C:\\Windows\\System32', PATHEXT: '.exe', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
    expect(gitBash(local, files('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'))).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
    // WSL's bash on the PATH is not it; MinGit has git but no bash.
    expect(gitBash(env, files('C:\\Windows\\System32\\bash.exe', 'C:\\Program Files\\Git\\cmd\\git.exe'))).toBeUndefined();
  });

  it('finds Windows PowerShell in System32', () => {
    const exe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    expect(windowsPowerShell({ SystemRoot: 'C:\\Windows' }, files(exe))).toBe(exe);
    expect(windowsPowerShell({ SystemRoot: 'C:\\Windows', Path: 'D:\\ps', PATHEXT: '.exe' }, files('D:\\ps\\powershell.exe'))).toBe('D:\\ps\\powershell.exe');
    expect(windowsPowerShell({ SystemRoot: 'C:\\Windows' }, files())).toBeUndefined();
  });
});

describe('the installers’ environment', () => {
  it('leaves out Claude Code’s nesting markers and npm’s own variables of the run that started the server', () => {
    const env = installerEnv({ CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', npm_lifecycle_event: 'start', npm_package_name: 'harness-relay', npm_config_local_prefix: '/repo', INIT_CWD: '/repo', npm_config_registry: 'https://r', PATH: '/bin' });
    expect(env).toEqual({ npm_config_registry: 'https://r', PATH: '/bin', NO_COLOR: '1' });
  });

  it('gives a maker’s script the CLI’s folder as its home, with nothing that would move it out', () => {
    const d = join(root, 'grok');
    const env = scriptEnv({ HOME: '/home/me', ZDOTDIR: '/home/me/zsh', GROK_HOME: '/home/me/.grok', CURSOR_CONFIG_DIR: '/c', XDG_CONFIG_HOME: '/home/me/.config', PATH: '/bin' }, d, script('grok').posix, 'linux');
    expect(env).toMatchObject({
      HOME: join(d, 'home'),
      XDG_CONFIG_HOME: join(d, 'home', '.config'),
      XDG_DATA_HOME: join(d, 'home', '.local', 'share'),
      XDG_CACHE_HOME: join(d, 'home', '.cache'),
      XDG_STATE_HOME: join(d, 'home', '.local', 'state'),
      GROK_BIN_DIR: join(d, 'bin'),
      // Its program's folder first: it finds it on the PATH, so it links it nowhere else.
      PATH: `${join(d, 'bin')}:/bin`,
    });
    for (const k of ['ZDOTDIR', 'GROK_HOME', 'CURSOR_CONFIG_DIR', 'USERPROFILE']) expect(env[k], k).toBeUndefined();
    const muse = scriptEnv({}, d, script('muse').posix, 'darwin');
    expect(muse).toMatchObject({ MUSE_INSTALL_DIR: join(d, 'bin'), MUSE_NO_MODIFY_PATH: '1', PATH: join(d, 'bin') });
    expect(scriptEnv({ PATH: '/bin' }, d, script('cursor').posix, 'linux').PATH).toBe(`${join(d, 'home', '.local', 'bin')}:/bin`);
  });

  it('gives a script on Windows the folder as USERPROFILE, LOCALAPPDATA and APPDATA too, and its PATH as Windows spells it', () => {
    const d = join(root, 'cursor');
    const env = scriptEnv({ Path: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', XDG_CONFIG_HOME: 'C:\\x' }, d, script('cursor').windows, 'win32');
    const home = join(d, 'home');
    expect(env).toMatchObject({ USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local'), APPDATA: join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: join(home, '.config') });
    expect(env.Path).toBe(`${join(home, 'AppData', 'Local', 'cursor-agent')};C:\\Windows\\System32`);
    expect(env.PATH).toBeUndefined();
  });

  it('keeps uv’s tools, their links, any Python it downloads and its cache in the folder', () => {
    const d = join(root, 'oh');
    expect(uvEnv({ PATH: '/bin' }, d)).toEqual({
      PATH: '/bin',
      UV_CACHE_DIR: join(d, INSTALL_CACHE, 'uv'),
      UV_TOOL_DIR: join(d, 'uv', 'tools'),
      UV_TOOL_BIN_DIR: join(d, 'bin'),
      UV_PYTHON_INSTALL_DIR: join(d, 'uv', 'python'),
      UV_PYTHON_BIN_DIR: join(d, 'uv', 'python-bin'),
    });
  });

  it('shows an installer’s output without colours, cursor moves or redrawn progress bars', () => {
    expect(cleanLog('\u001b[32m✓\u001b[0m done\n#   10%\r##  50%\r### 100%\nnext\r\n')).toBe('✓ done\n### 100%\nnext\n');
  });
});

describe('CliInstaller', () => {
  it('says how each CLI installs here, and what it needs that is missing', () => {
    const { clis } = installer();
    const views = clis.views();
    expect(views.map((v) => v.provider)).toEqual(PROVIDERS);
    expect(views.find((v) => v.provider === 'codex')).toMatchObject({ method: 'npm', command: 'npm install -g @openai/codex', dir: clis.folder('codex') });
    expect(views.every((v) => !v.blocked && !v.installed && !v.job)).toBe(true);

    const none = installer({ tools: [] }).clis;
    // Without npm: Claude Code, Codex and Copilot with Node.js's build, which takes curl; an open agent takes npm.
    expect(none.view('codex').blocked).toBe('curl');
    expect(none.view('opencode').blocked).toBe('npm');
    // Without uv, uv's own installer, which takes curl and bash.
    expect(none.view('openhands').blocked).toBe('curl');
    expect(none.view('grok').blocked).toBe('curl');
    expect(installer({ tools: ['/fake/bin/curl'] }).clis.view('cursor').blocked).toBe('bash');
    const noUv = installer({ tools: ['/fake/bin/curl', '/fake/bin/bash'] }).clis.view('openhands');
    expect(noUv.blocked).toBeUndefined();
    expect(noUv.command).toBe('curl -fsSL https://astral.sh/uv/install.sh | bash; uv tool install openhands==1.16.0');
    // Where uv's own installer puts it counts as having uv.
    expect(installer({ tools: ['/fake/home/.local/bin/uv'] }).clis.view('openhands').command).toBe('uv tool install openhands==1.16.0');
    // Anything but macOS, Linux and Windows: no maker's script runs there.
    expect(installer({ platform: 'freebsd' }).clis.view('grok').blocked).toBe('system');
  });

  it('on Windows, installs every CLI there is a way for, and says what is missing', () => {
    const win = installer({ platform: 'win32' }).clis;
    for (const p of PROVIDERS) expect(win.view(p).blocked, p).toBeUndefined();
    expect(win.view('grok').command).toBe('irm https://x.ai/cli/install.ps1 | iex');
    expect(win.view('openhands').command).toBe('irm https://astral.sh/uv/install.ps1 | iex; uv tool install --python cpython-3.12-windows-x86_64-none openhands==1.16.0');
    // MinGit, or no Git: Goose's bash script has no bash to run in; the PowerShell ones still do.
    const noGitBash = installer({ platform: 'win32', tools: WIN_TOOLS.filter((t) => !/\\Git\\/.test(t)) }).clis;
    expect(noGitBash.view('goose').blocked).toBe('gitBash');
    expect(noGitBash.view('cursor').blocked).toBeUndefined();
    const noCurl = installer({ platform: 'win32', tools: WIN_TOOLS.filter((t) => !t.endsWith('curl.exe')) }).clis;
    expect(noCurl.view('muse').blocked).toBe('curl');
    const noPowerShell = installer({ platform: 'win32', tools: WIN_TOOLS.filter((t) => !t.endsWith('powershell.exe')) }).clis;
    expect(noPowerShell.view('antigravity').blocked).toBe('powershell');
  });

  it('installs with npm into the CLI’s folder, checks that it runs, and points the CLI at it', async () => {
    const { clis, settings, changed, calls } = installer();
    const started = clis.install('codex');
    expect(started.job?.state).toBe('running');
    expect(started.installed).toBeUndefined();
    const v = await ended(clis, 'codex');
    const dir = clis.folder('codex');
    const bin = join(dir, 'bin', 'codex');
    expect(v.job).toMatchObject({ state: 'success' });
    expect(v.job?.log).toContain(`$ npm install -g --prefix ${dir} @openai/codex`);
    expect(v.job?.log).toContain('npm done');
    expect(v.installed).toMatchObject({ bin, version: '1.2.3', inUse: true });
    expect(calls).toHaveLength(1);
    const cache = join(dir, INSTALL_CACHE, 'npm');
    expect(calls[0]).toMatchObject({ bin: '/fake/bin/npm', cwd: dir, args: ['install', '--global', '--prefix', dir, '--cache', cache, '--no-audit', '--no-fund', '--no-update-notifier', '@openai/codex'] });
    // npm's cache was the install's alone: not in the user's ~/.npm, and gone once it is done.
    expect(existsSync(join(dir, INSTALL_CACHE))).toBe(false);
    // Not Claude Code's nesting markers, nor npm's own variables of `npm start`; the rest of the server's.
    expect(calls[0]!.env).toMatchObject({ KEEP: 'me', NO_COLOR: '1' });
    expect(calls[0]!.env.CLAUDECODE).toBeUndefined();
    expect(calls[0]!.env.npm_lifecycle_event).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, INSTALL_NOTE), 'utf8'))).toMatchObject({ provider: 'codex', method: 'npm', source: '@openai/codex', bin, version: '1.2.3' });
    expect(settings.bin('codex')).toBe(bin);
    expect(changed).toHaveBeenCalledWith('codex');
  });

  it('runs a maker’s script whole, downloaded first, with the folder as its home', async () => {
    const { clis, calls } = installer();
    clis.install('antigravity');
    const v = await ended(clis, 'antigravity');
    const dir = clis.folder('antigravity');
    expect(v.job?.state).toBe('success');
    expect(calls.map((c) => basename(c.bin))).toEqual(['curl', 'bash']);
    const script = join(dir, 'install.sh');
    expect(calls[0]!.args).toEqual(['-fsSL', '--retry', '3', '-o', script, 'https://antigravity.google/cli/install.sh']);
    expect(calls[1]!.args).toEqual([script, '--dir', join(dir, 'bin')]);
    expect(calls[1]!.env).toMatchObject({ HOME: join(dir, 'home'), XDG_CONFIG_HOME: join(dir, 'home', '.config') });
    // The script itself does not stay.
    expect(existsSync(script)).toBe(false);
    expect(v.installed?.bin).toBe(join(dir, 'bin', 'agy'));
  });

  it('installs OpenHands with uv, everything in its folder', async () => {
    const { clis, calls } = installer();
    clis.install('openhands');
    const v = await ended(clis, 'openhands');
    const dir = clis.folder('openhands');
    expect(v.job?.state).toBe('success');
    expect(calls[0]).toMatchObject({ bin: '/fake/bin/uv', args: ['tool', 'install', 'openhands==1.16.0'] });
    expect(calls[0]!.env).toMatchObject({ UV_TOOL_DIR: join(dir, 'uv', 'tools'), UV_TOOL_BIN_DIR: join(dir, 'bin'), UV_CACHE_DIR: join(dir, INSTALL_CACHE, 'uv') });
    expect(existsSync(join(dir, INSTALL_CACHE))).toBe(false);
    expect(v.installed?.bin).toBe(join(dir, 'bin', 'openhands'));
  });

  it('removes what a failed install left, says why in the language of whoever looks, and keeps its output', async () => {
    const { clis, settings, changed } = installer({ onRun: (s) => (s.onLine?.('npm error 404 Not Found'), result(1, 'npm error 404 Not Found')) });
    clis.install('cline');
    const v = await ended(clis, 'cline');
    expect(v.job?.state).toBe('failed');
    expect(v.job?.log).toContain('npm error 404 Not Found');
    expect(withLang('en', () => clis.view('cline').job?.error)).toContain('failed (exit 1)');
    expect(withLang('zh-TW', () => clis.view('cline').job?.error)).toContain('失敗（exit 1）');
    expect(v.installed).toBeUndefined();
    expect(existsSync(clis.folder('cline'))).toBe(false);
    expect(settings.customBin('cline')).toBe('');
    expect(changed).toHaveBeenCalledWith('cline');
  });

  it('fails when the installer left no program, or the program does not run', async () => {
    const empty = installer({ onRun: () => result(0) });
    empty.clis.install('pi');
    expect(withLang('en', () => empty.clis.view('pi').job?.error)).toBeUndefined();
    const v = await ended(empty.clis, 'pi');
    expect(v.job?.state).toBe('failed');
    expect(withLang('en', () => empty.clis.view('pi').job?.error)).toMatch(/program .* is not there/);
    expect(existsSync(empty.clis.folder('pi'))).toBe(false);

    const broken = installer({ version: async () => Promise.reject(new Error('GLIBC_2.34 not found')) });
    broken.clis.install('goose');
    const b = await ended(broken.clis, 'goose');
    expect(b.job?.state).toBe('failed');
    expect(b.job?.error).toContain('GLIBC_2.34 not found');
    expect(existsSync(broken.clis.folder('goose'))).toBe(false);
    expect(broken.settings.customBin('goose')).toBe('');
  });

  it('installs uv into the folder first when it is not on the PATH, then OpenHands with it', async () => {
    const { clis, calls } = installer({ tools: ['/fake/bin/curl', '/fake/bin/bash'] });
    clis.install('openhands');
    const v = await ended(clis, 'openhands');
    const dir = clis.folder('openhands');
    const uv = join(dir, 'uv', 'bin', 'uv');
    expect(v.job?.state).toBe('success');
    expect(calls.map((c) => basename(c.bin))).toEqual(['curl', 'bash', 'uv']);
    expect(calls[0]!.args).toContain('https://astral.sh/uv/install.sh');
    // Into the folder, changing no PATH (`UV_UNMANAGED_INSTALL`), with the folder as its home.
    expect(calls[1]!.env).toMatchObject({ UV_UNMANAGED_INSTALL: join(dir, 'uv', 'bin'), HOME: join(dir, 'home') });
    expect(calls[2]).toMatchObject({ bin: uv, args: ['tool', 'install', 'openhands==1.16.0'] });
    expect(v.job?.log).toContain('$ uv tool install openhands==1.16.0');
  });

  it('on Windows, installs uv with its PowerShell installer, then OpenHands on the x64 Python', async () => {
    const { clis, calls } = installer({ platform: 'win32' });
    clis.install('openhands');
    const v = await ended(clis, 'openhands');
    const dir = clis.folder('openhands');
    expect(v.job?.state).toBe('success');
    expect(calls.map((c) => basename(c.bin.replace(/\\/g, '/')).toLowerCase())).toEqual(['curl.exe', 'powershell.exe', 'uv.exe']);
    const args = ['tool', 'install', '--python', 'cpython-3.12-windows-x86_64-none', 'openhands==1.16.0'];
    expect(calls[2]).toMatchObject({ bin: join(dir, 'uv', 'bin', 'uv.exe'), args });
    expect(v.job?.log).toContain(`$ uv ${args.join(' ')}`);
    expect(v.installed?.bin).toBe(join(dir, 'bin', 'openhands.exe'));
  });

  it('on Windows, runs a maker’s PowerShell installer as a script block, with the folder as its home', async () => {
    const { clis, calls } = installer({ platform: 'win32' });
    clis.install('antigravity');
    const v = await ended(clis, 'antigravity');
    const dir = clis.folder('antigravity');
    expect(v.job?.state).toBe('success');
    expect(calls.map((c) => c.bin)).toEqual(['C:\\Windows\\System32\\curl.EXE', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
    const file = join(dir, 'install.ps1');
    expect(calls[0]!.args).toEqual(['-fsSL', '--retry', '3', '-o', file, 'https://antigravity.google/cli/install.ps1']);
    // Fixed text (`POWERSHELL_RUN_SCRIPT`), never `-File`; the script and its arguments in its environment.
    expect(calls[1]!.script).toBe(POWERSHELL_RUN_SCRIPT);
    expect(calls[1]!.args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    expect(calls[1]!.env).toMatchObject({
      HARNESS_RELAY_SCRIPT: file,
      HARNESS_RELAY_SCRIPT_ARGS: `--dir\n${join(dir, 'bin')}`,
      USERPROFILE: join(dir, 'home'),
      LOCALAPPDATA: join(dir, 'home', 'AppData', 'Local'),
      KEEP: 'me',
    });
    expect(v.job?.log).toContain(`$ powershell install.ps1 --dir ${join(dir, 'bin')}`);
    expect(existsSync(file)).toBe(false);
    expect(v.installed?.bin).toBe(join(dir, 'bin', 'agy.exe'));
  });

  it('runs the PowerShell installers as their makers’ irm | iex would, by fixed text', () => {
    // What it runs and with what come from its environment, never from its text.
    expect(POWERSHELL_RUN_SCRIPT).toContain('[ScriptBlock]::Create([IO.File]::ReadAllText($env:HARNESS_RELAY_SCRIPT))');
    // Its arguments passed as they are (`--dir` is not one of PowerShell's own parameters).
    expect(POWERSHELL_RUN_SCRIPT).toContain('Invoke-Command -ScriptBlock $block -ArgumentList $list');
    expect(POWERSHELL_RUN_SCRIPT).toContain('$env:HARNESS_RELAY_SCRIPT_ARGS.Split([char]10)');
    // No double quotes, which Windows' command line would escape.
    for (const text of [POWERSHELL_RUN_SCRIPT, USER_PATH_READ_SCRIPT, USER_PATH_RESTORE_SCRIPT]) expect(text).not.toContain('"');
  });

  it('on Windows, puts the user’s PATH back as it was before the installer, which turned its %USERPROFILE% entries into the folder’s', async () => {
    const { clis, registry, dir } = installer({
      platform: 'win32',
      onRun: (s) => {
        // Cursor's: reads the user PATH expanded with the folder as USERPROFILE, writes it back with its own.
        if (s.script === POWERSHELL_RUN_SCRIPT) registry.path = `String:${b64(`${s.env.USERPROFILE}\\AppData\\Local\\Microsoft\\WindowsApps;${s.env.LOCALAPPDATA}\\cursor-agent`)}`;
        return undefined;
      },
    });
    clis.install('cursor');
    const v = await ended(clis, 'cursor');
    expect(v.job?.state).toBe('success');
    expect(registry.path).toBe(STOCK_USER_PATH);
    expect(v.job?.log).toContain('Put the user PATH back as it was before the installer ran');
    // Kept until it is back, then gone.
    expect(existsSync(join(dir, USER_PATH_SAVED))).toBe(false);
    // Nothing touched when it is removed: nothing of it is left in the PATH.
    registry.restores.length = 0;
    await clis.remove('cursor');
    expect(registry.restores).toEqual([]);
  });

  it('on Windows, puts the user’s PATH back also when the installer fails or is stopped, and runs no installer without it', async () => {
    const failing = installer({
      platform: 'win32',
      onRun: (s) => {
        if (s.script !== POWERSHELL_RUN_SCRIPT) return undefined;
        failing.registry.path = 'none';
        return result(1);
      },
    });
    failing.clis.install('grok');
    expect((await ended(failing.clis, 'grok')).job?.state).toBe('failed');
    expect(failing.registry.path).toBe(STOCK_USER_PATH);

    const stopped = installer({
      platform: 'win32',
      onRun: (s) => {
        if (s.script !== POWERSHELL_RUN_SCRIPT) return undefined;
        stopped.registry.path = 'none';
        return untilStopped(s);
      },
    });
    stopped.clis.install('muse');
    await vi.waitFor(() => expect(stopped.registry.path).toBe('none'));
    stopped.clis.cancel('muse');
    expect((await ended(stopped.clis, 'muse')).job?.state).toBe('cancelled');
    expect(stopped.registry.path).toBe(STOCK_USER_PATH);

    // And Goose's bash script, under Git for Windows' bash.
    const bash = installer({ platform: 'win32' });
    bash.clis.install('goose');
    expect((await ended(bash.clis, 'goose')).job?.state).toBe('success');
    expect(bash.registry.reads).toBe(1);

    const unread = installer({ platform: 'win32', readUserPath: () => Promise.reject(new Error('Access denied')) });
    unread.clis.install('cursor');
    const u = await ended(unread.clis, 'cursor');
    expect(u.job?.state).toBe('failed');
    expect(withLang('en', () => unread.clis.view('cursor').job?.error)).toBe(
      'Could not read your user PATH, which is put back as it was once the installer has run, so the installer was not run: Access denied',
    );
    expect(unread.calls.filter((c) => c.script === POWERSHELL_RUN_SCRIPT)).toEqual([]);
  });

  it('on Windows, tries again to put the user’s PATH back when it could not, before the next installer and at startup', async () => {
    let broken = true;
    let path = STOCK_USER_PATH;
    const { clis, dir } = installer({
      platform: 'win32',
      readUserPath: async () => path,
      restoreUserPath: async (saved) => {
        if (broken) throw new Error('registry locked');
        const changed = path !== saved;
        path = saved;
        return changed;
      },
      onRun: (s) => {
        if (s.script === POWERSHELL_RUN_SCRIPT) path = 'none';
        return undefined;
      },
    });
    clis.install('cursor');
    const v = await ended(clis, 'cursor');
    expect(v.job?.state).toBe('failed');
    expect(withLang('en', () => clis.view('cursor').job?.error)).toContain('Could not put your user PATH back as it was before the installer ran: registry locked');
    expect(readFileSync(join(dir, USER_PATH_SAVED), 'utf8')).toBe(STOCK_USER_PATH);

    // Before the next installer: the PATH kept, not the one the last installer left.
    broken = false;
    clis.install('grok');
    expect((await ended(clis, 'grok')).job?.state).toBe('success');
    expect(path).toBe(STOCK_USER_PATH);
    expect(existsSync(join(dir, USER_PATH_SAVED))).toBe(false);

    // At startup (the server did not live to put it back).
    writeFileSync(join(dir, USER_PATH_SAVED), STOCK_USER_PATH);
    path = 'none';
    await clis.recover();
    expect(path).toBe(STOCK_USER_PATH);
    expect(existsSync(join(dir, USER_PATH_SAVED))).toBe(false);
  });

  it('on Windows, runs one installer that may change the user’s PATH at a time', async () => {
    const order: string[] = [];
    const { clis, registry } = installer({
      platform: 'win32',
      onRun: async (s) => {
        if (s.script !== POWERSHELL_RUN_SCRIPT) return undefined;
        const p = basename(s.cwd!);
        order.push(`${p} starts`);
        registry.path = `String:${b64(p)}`;
        await new Promise((r) => setTimeout(r, 20));
        order.push(`${p} ends`);
        return undefined;
      },
    });
    clis.install('cursor');
    clis.install('grok');
    const [c, g] = [await ended(clis, 'cursor'), await ended(clis, 'grok')];
    expect([c.job?.state, g.job?.state]).toEqual(['success', 'success']);
    // Whichever reached the PATH's turn first (both start at once) ran alone, then the other.
    const first = order[0]!.split(' ')[0]!;
    const second = first === 'cursor' ? 'grok' : 'cursor';
    expect(order).toEqual([`${first} starts`, `${first} ends`, `${second} starts`, `${second} ends`]);
    expect((second === 'grok' ? g : c).job?.log).toContain('Waiting for another install to end');
    // Each read the PATH as the user had it, and put that back.
    expect(registry.restores).toEqual([STOCK_USER_PATH, STOCK_USER_PATH]);
    expect(registry.path).toBe(STOCK_USER_PATH);
  });

  it('reads and puts back the user’s PATH by fixed scripts, with what they work on in their environment', async () => {
    const scripts: { script: string; env: NodeJS.ProcessEnv }[] = [];
    let answer = STOCK_USER_PATH;
    const { host } = fakeHost(freshDir(), { platform: 'win32' });
    delete host.readUserPath;
    delete host.restoreUserPath;
    const runScript = host.runScript!;
    host.runScript = async (shell, flags, script, o) => {
      if (script === POWERSHELL_RUN_SCRIPT) return runScript(shell, flags, script, o);
      scripts.push({ script, env: o.env });
      return result(0, script === USER_PATH_READ_SCRIPT ? `${answer}\r\n` : 'changed');
    };
    const clis = new CliInstaller(new SettingsStore(openDatabase(':memory:')), {}, host);
    clis.install('cursor');
    const v = await ended(clis, 'cursor');
    expect(v.job?.state).toBe('success');
    expect(scripts.map((s) => s.script)).toEqual([USER_PATH_READ_SCRIPT, USER_PATH_RESTORE_SCRIPT]);
    expect(scripts[1]!.env.HARNESS_RELAY_USER_PATH).toBe(STOCK_USER_PATH);
    expect(v.job?.log).toContain('Put the user PATH back');
    // As stored: its %VARIABLES% not expanded, and the value's kind kept.
    expect(USER_PATH_READ_SCRIPT).toContain("'DoNotExpandEnvironmentNames'");
    expect(USER_PATH_RESTORE_SCRIPT).toContain('[Microsoft.Win32.RegistryValueKind]($saved.Substring(0, $at))');
    expect(USER_PATH_RESTORE_SCRIPT).toContain('$env:HARNESS_RELAY_USER_PATH');

    // An answer that is not one: no installer runs.
    answer = 'Path=C:\\x';
    await clis.remove('cursor');
    clis.install('cursor');
    expect((await ended(clis, 'cursor')).job?.state).toBe('failed');
    expect(withLang('en', () => clis.view('cursor').job?.error)).toContain('Unexpected answer: Path=C:\\x');
  });

  it('on Windows, runs Goose’s bash script in Git for Windows’ bash, with its paths written for it', async () => {
    const { clis, calls } = installer({ platform: 'win32' });
    clis.install('goose');
    const v = await ended(clis, 'goose');
    const dir = clis.folder('goose');
    expect(v.job?.state).toBe('success');
    expect(calls[1]!.bin).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    const slashed = (p: string) => p.replace(/\\/g, '/');
    expect(calls[1]!.args).toEqual([slashed(join(dir, 'install.sh'))]);
    expect(calls[1]!.env).toMatchObject({ HOME: slashed(join(dir, 'home')), GOOSE_BIN_DIR: slashed(join(dir, 'bin')), GOOSE_VERSION: 'v1.58.1' });
    expect(v.installed?.bin).toBe(join(dir, 'bin', 'goose.exe'));
  });

  it.skipIf(process.platform === 'win32')('removes the links an installer left outside the folder that lead into it, and nothing else', async () => {
    const outside = join(root, `path-${++n}`);
    mkdirSync(outside, { recursive: true });
    const elsewhere = join(root, `elsewhere-${n}`);
    touch(join(elsewhere, 'tool'));
    symlinkSync(join(elsewhere, 'tool'), join(outside, 'tool'));
    touch(join(outside, 'plain'));
    // An installer that links its program into a folder on the PATH (Grok's, into /usr/local/bin).
    const { clis, settings } = installer({
      env: { PATH: `/fake/bin:${outside}` },
      onRun: (s) => {
        if (basename(s.bin) !== 'bash') return undefined;
        const program = join(s.cwd!, 'bin', 'grok');
        touch(program);
        symlinkSync(program, join(outside, 'grok'));
        symlinkSync(join(s.cwd!, 'bin', 'agent'), join(outside, 'agent'));
        return result(0);
      },
    });
    clis.install('grok');
    const v = await ended(clis, 'grok');
    expect(v.job?.state).toBe('success');
    expect(v.job?.log).toContain(`Removed ${join(outside, 'grok')}, a link into ${clis.folder('grok')}`);
    for (const gone of ['grok', 'agent']) expect(() => lstatSync(join(outside, gone)), gone).toThrow();
    expect(lstatSync(join(outside, 'tool')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, 'plain'))).toBe(true);
    expect(settings.bin('grok')).toBe(join(clis.folder('grok'), 'bin', 'grok'));
  });

  it.skipIf(process.platform === 'win32')('finds the links by what they name, also once that is gone', () => {
    const dir = join(root, `cli-${++n}`);
    const folder = join(root, `bin-${n}`);
    mkdirSync(folder, { recursive: true });
    symlinkSync(join(dir, 'bin', 'gone'), join(folder, 'dangling'));
    symlinkSync('../not-it', join(folder, 'relative-elsewhere'));
    expect(dropLinksInto(dir, [folder, join(root, 'no-such-folder')])).toEqual([join(folder, 'dangling')]);
    expect(lstatSync(join(folder, 'relative-elsewhere')).isSymbolicLink()).toBe(true);
    expect(linkFolders({ PATH: '/a:relative:/b' }, '/home/me')).toEqual(['/a', '/b', '/home/me/.local/bin', '/usr/local/bin', '/opt/homebrew/bin']);
  });

  it.skipIf(process.platform === 'win32')('leaves the links in the CLI’s own folders, also when the user put one on the PATH', async () => {
    // npm's own link to its program, in the folder's bin, which the user put on their PATH (to run it in a terminal).
    const dir = freshDir();
    const { host } = fakeHost(dir, {
      onRun: (s) => {
        const target = join(s.cwd!, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        touch(target);
        mkdirSync(join(s.cwd!, 'bin'), { recursive: true });
        symlinkSync(join('..', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), join(s.cwd!, 'bin', 'codex'));
        return result(0);
      },
    });
    const alias = join(root, `alias-${++n}`);
    host.env = { PATH: `/fake/bin:${join(dir, 'codex', 'bin')}:${alias}` };
    const clis = new CliInstaller(new SettingsStore(openDatabase(':memory:')), {}, host);
    mkdirSync(join(dir, 'codex'), { recursive: true });
    // Also under another name for it (a link to the folder).
    symlinkSync(join(dir, 'codex', 'bin'), alias);
    clis.install('codex');
    const v = await ended(clis, 'codex');
    expect(v.job?.state).toBe('success');
    expect(v.job?.log).not.toContain('Removed');
    expect(lstatSync(join(dir, 'codex', 'bin', 'codex')).isSymbolicLink()).toBe(true);
    expect(dropLinksInto(join(dir, 'codex'), [join(dir, 'codex', 'bin'), alias])).toEqual([]);
  });

  it('gives uv’s installer none of the variables that would send uv outside the folder', async () => {
    const { clis, calls } = installer({ tools: ['/fake/bin/curl', '/fake/bin/bash'], env: { PATH: '/fake/bin', UV_INSTALL_DIR: '/opt/uv', CARGO_DIST_FORCE_INSTALL_DIR: '/opt/cargo' } });
    clis.install('openhands');
    expect((await ended(clis, 'openhands')).job?.state).toBe('success');
    expect(calls[1]!.env.UV_INSTALL_DIR).toBeUndefined();
    expect(calls[1]!.env.CARGO_DIST_FORCE_INSTALL_DIR).toBeUndefined();
    expect(calls[1]!.env.UV_UNMANAGED_INSTALL).toBe(join(clis.folder('openhands'), 'uv', 'bin'));
    expect(scriptEnv({ UV_INSTALL_DIR: '/opt/uv' }, '/d', UV_INSTALLERS.windows, 'win32').UV_INSTALL_DIR).toBeUndefined();
    // Other scripts are given them as the server has them.
    expect(scriptEnv({ UV_INSTALL_DIR: '/opt/uv' }, '/d', script('grok').posix, 'linux').UV_INSTALL_DIR).toBe('/opt/uv');
  });

  /** Node.js's build as a test downloads it: the fake curl writes an empty file, whose checksum this is. */
  const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const fakeBuild = (o: Partial<NodeBuild> = {}): NodeBuild => ({
    version: '26.0.0',
    url: 'https://nodejs.org/dist/v26.0.0/node-v26.0.0-linux-x64.tar.gz',
    file: 'node-v26.0.0-linux-x64.tar.gz',
    sha256: EMPTY_SHA256,
    members: ['node-v26.0.0-linux-x64/bin/node', 'node-v26.0.0-linux-x64/lib/node_modules/npm'],
    ...o,
  });
  /** tar, as it takes Node and npm out of the archive into the folder it is given (`-C`). */
  const fakeTar = (platform: NodeJS.Platform) => (s: Run) => {
    if (!/^tar(\.exe)?$/i.test(basename(s.bin.replace(/\\/g, '/')))) return undefined;
    const npm = folderNpm(s.args[s.args.indexOf('-C') + 1]!, platform);
    for (const f of [npm.bin, ...npm.args]) touch(f);
    return result(0);
  };

  it('without npm, puts Node.js’s build into the folder first, checked, then installs with its npm', async () => {
    const { clis, calls, settings } = installer({ tools: ['/fake/bin/curl', '/fake/bin/tar'], nodeBuild: () => fakeBuild(), onRun: fakeTar('linux') });
    const before = clis.view('codex');
    expect(before).toMatchObject({ method: 'npm', node: '26.0.0' });
    expect(before.blocked).toBeUndefined();
    expect(before.command).toBe('curl -fsSLO https://nodejs.org/dist/v26.0.0/node-v26.0.0-linux-x64.tar.gz; tar -xf node-v26.0.0-linux-x64.tar.gz; npm install -g @openai/codex');
    clis.install('codex');
    const v = await ended(clis, 'codex');
    const dir = clis.folder('codex');
    const archive = join(dir, INSTALL_CACHE, 'node', 'node-v26.0.0-linux-x64.tar.gz');
    expect(v.job?.state).toBe('success');
    expect(calls.map((c) => basename(c.bin))).toEqual(['curl', 'tar', 'node', 'node']);
    // The archive whole, then only Node and npm out of it, its top folder stripped.
    expect(calls[0]!.args).toEqual(['-fsSL', '--retry', '3', '-o', archive, 'https://nodejs.org/dist/v26.0.0/node-v26.0.0-linux-x64.tar.gz']);
    expect(calls[1]).toMatchObject({ bin: '/fake/bin/tar', cwd: dir, args: ['-xf', archive, '-C', dir, '--strip-components', '1', 'node-v26.0.0-linux-x64/bin/node', 'node-v26.0.0-linux-x64/lib/node_modules/npm'] });
    // That Node checked to run; then its npm, on it, with that Node first on the PATH (for the packages' install scripts).
    const npm = folderNpm(dir, 'linux');
    expect(calls[2]).toMatchObject({ bin: npm.bin, args: ['--version'], cwd: dir });
    expect(calls[3]).toMatchObject({ bin: npm.bin, cwd: dir, env: { PATH: `${join(dir, 'bin')}:/fake/bin` } });
    expect(calls[3]!.args).toEqual([...npm.args, 'install', '--global', '--prefix', dir, '--cache', join(dir, INSTALL_CACHE, 'npm'), '--no-audit', '--no-fund', '--no-update-notifier', '@openai/codex']);
    expect(v.job?.log).toContain(`npm is not on the PATH: Node.js 26.0.0, with its npm, goes into ${dir} first`);
    expect(v.job?.log).toContain(`SHA-256 ${EMPTY_SHA256}: as Node.js published it`);
    // Node and npm stay, beside the program (which runs on that Node); the download does not.
    expect(isRealFile(npm.bin) && isRealFile(npm.args[0]!)).toBe(true);
    expect(existsSync(join(dir, INSTALL_CACHE))).toBe(false);
    expect(v.installed?.bin).toBe(join(dir, 'bin', 'codex'));
    expect(settings.bin('codex')).toBe(join(dir, 'bin', 'codex'));
    // With npm on the PATH again, it is that npm, and no Node.js goes in.
    expect(installer({ nodeBuild: () => fakeBuild() }).clis.view('codex').node).toBeUndefined();
  });

  it('uses no Node.js whose download does not match its checksum, and leaves nothing behind', async () => {
    const { clis, calls } = installer({ tools: ['/fake/bin/curl', '/fake/bin/tar'], nodeBuild: () => fakeBuild({ sha256: 'ab'.repeat(32) }), onRun: fakeTar('linux') });
    clis.install('claude');
    const v = await ended(clis, 'claude');
    expect(v.job?.state).toBe('failed');
    expect(calls.map((c) => basename(c.bin))).toEqual(['curl']);
    expect(withLang('en', () => clis.view('claude').job?.error)).toBe(
      `The Node.js downloaded (https://nodejs.org/dist/v26.0.0/node-v26.0.0-linux-x64.tar.gz) does not match the checksum Harness Relay has for it, so it was not used: SHA-256 ${'ab'.repeat(32)} expected, ${EMPTY_SHA256} downloaded.`,
    );
    expect(withLang('zh-TW', () => clis.view('claude').job?.error)).toContain('檢查碼不符');
    expect(existsSync(clis.folder('claude'))).toBe(false);
  });

  it('says so when the Node.js put into the folder does not run there (on Linux, without libatomic), before npm runs on it', async () => {
    const libatomic = (s: Run) => (s.args[0] === '--version' ? (s.onLine?.('node: error while loading shared libraries: libatomic.so.1'), result(127)) : fakeTar('linux')(s));
    const { clis, calls } = installer({ tools: ['/fake/bin/curl', '/fake/bin/tar'], nodeBuild: () => fakeBuild(), onRun: libatomic });
    clis.install('codex');
    const v = await ended(clis, 'codex');
    expect(v.job?.state).toBe('failed');
    expect(calls).toHaveLength(3);
    expect(v.job?.log).toContain('libatomic.so.1');
    expect(withLang('en', () => clis.view('codex').job?.error)).toContain("Node.js's Linux builds need libatomic (the libatomic1 package on Debian and Ubuntu");
    expect(withLang('zh-TW', () => clis.view('codex').job?.error)).toContain('需要 libatomic');
    expect(existsSync(clis.folder('codex'))).toBe(false);
    // Elsewhere, without the word about Linux.
    const mac = installer({ platform: 'darwin', tools: ['/fake/bin/curl', '/fake/bin/tar'], env: { PATH: '/fake/bin' }, nodeBuild: () => fakeBuild(), onRun: (s) => (s.args[0] === '--version' ? result(1) : fakeTar('darwin')(s)) });
    mac.clis.install('claude');
    expect(withLang('en', () => mac.clis.view('claude').job?.error)).toBeUndefined();
    const m = await ended(mac.clis, 'claude');
    expect(withLang('en', () => mac.clis.view('claude').job?.error)).toBe('The Node.js put into the folder does not run on this computer (its output is below): install Node.js with npm, then try again.');
    expect(m.job?.state).toBe('failed');
  });

  it('says what Node.js’s build needs that is missing, and offers none where Node.js has no build', () => {
    const build = () => fakeBuild();
    expect(installer({ tools: ['/fake/bin/curl'], nodeBuild: build }).clis.view('copilot').blocked).toBe('tar');
    expect(installer({ tools: ['/fake/bin/tar'], nodeBuild: build }).clis.view('copilot').blocked).toBe('curl');
    // No build for this computer: npm it is, as for the open agents.
    const none = installer({ tools: ['/fake/bin/curl', '/fake/bin/tar'], nodeBuild: () => undefined }).clis;
    expect(none.view('claude')).toMatchObject({ blocked: 'npm', command: 'npm install -g @anthropic-ai/claude-code' });
    expect(none.view('claude').node).toBeUndefined();
    expect(installer({ tools: ['/fake/bin/curl', '/fake/bin/tar'], nodeBuild: build }).clis.view('pi').blocked).toBe('npm');
    // The default build follows the computer's system and processor.
    const mac = installer({ platform: 'darwin', tools: ['/fake/bin/curl', '/fake/bin/tar'], env: { PATH: '/fake/bin' } }).clis.view('codex');
    expect(mac.node).toBe(NODE_VERSION);
    expect(mac.command).toContain(`node-v${NODE_VERSION}-darwin-x64.tar.gz`);
  });

  it('on Windows, takes Node.js’s zip apart with System32’s tar, never another tar on the PATH', async () => {
    const winTools = [...WIN_TOOLS.filter((t) => !t.startsWith('C:\\nodejs')), 'C:\\Windows\\System32\\tar.exe'];
    const build = () => fakeBuild({ url: 'https://nodejs.org/dist/v26.0.0/node-v26.0.0-win-x64.zip', file: 'node-v26.0.0-win-x64.zip', members: ['node-v26.0.0-win-x64/node.exe', 'node-v26.0.0-win-x64/node_modules/npm'] });
    const { clis, calls } = installer({ platform: 'win32', tools: winTools, nodeBuild: build, onRun: fakeTar('win32') });
    clis.install('copilot');
    const v = await ended(clis, 'copilot');
    const dir = clis.folder('copilot');
    expect(v.job?.state).toBe('success');
    // (curl found as PATHEXT spells it.)
    expect(calls.map((c) => c.bin.toLowerCase())).toEqual(['c:\\windows\\system32\\curl.exe', 'c:\\windows\\system32\\tar.exe', join(dir, 'node.exe').toLowerCase(), join(dir, 'node.exe').toLowerCase()]);
    expect(calls[1]!.args.slice(-2)).toEqual(['node-v26.0.0-win-x64/node.exe', 'node-v26.0.0-win-x64/node_modules/npm']);
    // npm's `.cmd` for the CLI goes beside that node.exe, which its launch then starts it with.
    expect(v.installed?.bin).toBe(join(dir, 'copilot.cmd'));
    // Git for Windows' GNU tar on the PATH reads no zip: not taken.
    const gnuTar = [...WIN_TOOLS.filter((t) => !t.startsWith('C:\\nodejs')), 'C:\\Program Files\\Git\\usr\\bin\\tar.exe'];
    const env = { ...WIN_ENV, Path: 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32' };
    expect(installer({ platform: 'win32', tools: gnuTar, env, nodeBuild: build }).clis.view('codex').blocked).toBe('tar');
  });

  it('starts npm with its own folder first on the PATH, as Homebrew’s may not be on it', async () => {
    const { clis, calls } = installer({ platform: 'darwin', tools: ['/opt/homebrew/bin/npm'], env: { PATH: '/usr/bin:/bin' } });
    clis.install('copilot');
    expect((await ended(clis, 'copilot')).job?.state).toBe('success');
    expect(calls[0]).toMatchObject({ bin: '/opt/homebrew/bin/npm', env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' } });
    expect(pathFirst({ Path: 'C:\\Windows' }, 'C:\\nodejs', 'win32')).toEqual({ Path: 'C:\\nodejs;C:\\Windows' });
    expect(pathFirst({}, '/a', 'linux')).toEqual({ PATH: '/a' });
  });

  it('stops the check that the program runs when the install is cancelled', async () => {
    const { clis } = installer({
      version: (_p, _bin, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    clis.install('pi');
    await vi.waitFor(() => expect(clis.view('pi').job?.log).toContain('--version'));
    clis.cancel('pi');
    const v = await ended(clis, 'pi');
    expect(v.job?.state).toBe('cancelled');
    expect(existsSync(clis.folder('pi'))).toBe(false);
  });

  it('installs nothing into a folder being removed, and removes it once', async () => {
    const { clis } = installer();
    clis.install('codex');
    await ended(clis, 'codex');
    const removal = clis.remove('codex');
    expect(() => withLang('en', () => clis.install('codex'))).toThrow(/Codex is being removed/);
    await expect(clis.remove('codex')).rejects.toMatchObject({ status: 409 });
    await removal;
    clis.install('codex');
    expect((await ended(clis, 'codex')).job?.state).toBe('success');
  });

  it('counts the installs under way, and waits for them to clean up when the server stops', async () => {
    const { clis } = installer({ onRun: untilStopped });
    expect(clis.running()).toBe(0);
    clis.install('cline');
    clis.install('pi');
    expect(clis.running()).toBe(2);
    await clis.shutdown();
    expect(clis.running()).toBe(0);
    expect(existsSync(clis.folder('cline'))).toBe(false);
    expect(existsSync(clis.folder('pi'))).toBe(false);
  });

  it('stops an install when asked, and removes what it left', async () => {
    const { clis } = installer({
      onRun: (s) => {
        touch(join(s.cwd!, 'half-done'));
        return untilStopped(s);
      },
    });
    clis.install('copilot');
    await vi.waitFor(() => expect(existsSync(join(clis.folder('copilot'), 'half-done'))).toBe(true));
    expect(() => clis.install('copilot')).toThrow(HttpError);
    expect(clis.cancel('copilot').job).toBeDefined();
    const v = await ended(clis, 'copilot');
    expect(v.job?.state).toBe('cancelled');
    expect(existsSync(clis.folder('copilot'))).toBe(false);
    expect(() => clis.cancel('copilot')).toThrow(HttpError);
  });

  it('stops every install under way when the server stops', async () => {
    const { clis } = installer({ onRun: untilStopped });
    clis.install('cline');
    clis.install('pi');
    clis.shutdown();
    expect((await ended(clis, 'cline')).job?.state).toBe('cancelled');
    expect((await ended(clis, 'pi')).job?.state).toBe('cancelled');
  });

  it('refuses to install what is installed already, or what cannot be installed here', async () => {
    const { clis } = installer();
    clis.install('codex');
    await ended(clis, 'codex');
    expect(() => clis.install('codex')).toThrow(expect.objectContaining({ status: 409 }));
    const none = installer({ tools: [] }).clis;
    expect(() => withLang('en', () => none.install('pi'))).toThrow(/takes npm/);
    expect(() => none.install('pi')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => withLang('en', () => none.install('codex'))).toThrow(/takes curl/);
  });

  it('starts over in a folder an earlier install left (the server stopped during it, or its program was removed by hand)', async () => {
    const { clis } = installer();
    const dir = clis.folder('grok');
    touch(join(dir, 'home', '.grok', 'downloads', 'grok-linux-x86_64.tmp.1'));
    clis.install('grok');
    expect((await ended(clis, 'grok')).job?.state).toBe('success');
    expect(existsSync(join(dir, 'home', '.grok', 'downloads', 'grok-linux-x86_64.tmp.1'))).toBe(false);
    // Its program gone: not installed, and installed again over what is left.
    rmSync(join(dir, 'bin', 'grok'));
    expect(clis.view('grok').installed).toBeUndefined();
    clis.install('grok');
    expect((await ended(clis, 'grok')).installed).toBeDefined();
  });

  it('takes a note only for its own CLI and a program inside its folder', () => {
    const { clis } = installer();
    const dir = clis.folder('cline');
    mkdirSync(dir, { recursive: true });
    const outside = join(root, 'elsewhere', 'cline');
    touch(outside);
    writeFileSync(join(dir, INSTALL_NOTE), JSON.stringify({ provider: 'cline', bin: outside, at: 1 }));
    expect(clis.view('cline').installed).toBeUndefined();
    touch(join(dir, 'bin', 'cline'));
    writeFileSync(join(dir, INSTALL_NOTE), JSON.stringify({ provider: 'pi', bin: join(dir, 'bin', 'cline'), at: 1 }));
    expect(clis.view('cline').installed).toBeUndefined();
    writeFileSync(join(dir, INSTALL_NOTE), 'not json');
    expect(clis.view('cline').installed).toBeUndefined();
    writeFileSync(join(dir, INSTALL_NOTE), JSON.stringify({ provider: 'cline', bin: join(dir, 'bin', 'cline'), at: 5 }));
    expect(clis.view('cline').installed).toEqual({ bin: join(dir, 'bin', 'cline'), at: 5, inUse: false });
  });

  it('sets the executable path back to what it was before the install', async () => {
    const { clis, settings } = installer();
    settings.update('copilot', { bin: '/old/copilot' });
    clis.install('copilot');
    await ended(clis, 'copilot');
    expect(settings.customBin('copilot')).toBe(join(clis.folder('copilot'), 'bin', 'copilot'));
    expect(JSON.parse(readFileSync(join(clis.folder('copilot'), INSTALL_NOTE), 'utf8')).previousBin).toBe('/old/copilot');
    await clis.remove('copilot');
    expect(settings.customBin('copilot')).toBe('/old/copilot');

    // Installed again over an install whose program was removed by hand: still the path before the first.
    clis.install('copilot');
    await ended(clis, 'copilot');
    rmSync(join(clis.folder('copilot'), 'bin', 'copilot'));
    clis.install('copilot');
    await ended(clis, 'copilot');
    await clis.remove('copilot');
    expect(settings.customBin('copilot')).toBe('/old/copilot');
  });

  it('removes only what it installed, and points the CLI back at its name unless the user set another path', async () => {
    const { clis, settings, changed } = installer();
    await expect(clis.remove('codex')).rejects.toMatchObject({ status: 404 });
    clis.install('codex');
    await ended(clis, 'codex');
    changed.mockClear();
    const v = await clis.remove('codex');
    expect(v.installed).toBeUndefined();
    expect(v.job).toBeUndefined();
    expect(existsSync(clis.folder('codex'))).toBe(false);
    expect(settings.customBin('codex')).toBe('');
    expect(settings.bin('codex')).toBe('codex');
    expect(changed).toHaveBeenCalledWith('codex');

    clis.install('pi');
    await ended(clis, 'pi');
    settings.update('pi', { bin: '/opt/pi/bin/pi' });
    expect(clis.view('pi').installed?.inUse).toBe(false);
    await clis.remove('pi');
    expect(settings.customBin('pi')).toBe('/opt/pi/bin/pi');
  });

  it('removes nothing while agents are at work, or while it installs', async () => {
    let busy = true;
    const { clis } = installer({ busy: () => busy });
    clis.install('cline');
    await ended(clis, 'cline');
    await expect(clis.remove('cline')).rejects.toMatchObject({ status: 409 });
    expect(existsSync(clis.folder('cline'))).toBe(true);
    busy = false;
    await clis.remove('cline');

    const slow = installer({ onRun: untilStopped });
    slow.clis.install('pi');
    await expect(slow.clis.remove('pi')).rejects.toMatchObject({ status: 409 });
    slow.clis.cancel('pi');
    await ended(slow.clis, 'pi');
  });
});

describe('CLI install HTTP API', () => {
  const HOST = { host: '127.0.0.1:8787' };
  const json = (method: string, body: unknown = {}) => ({ method, headers: { ...HOST, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  function app(onRun?: (s: SpawnOptions) => Promise<SpawnResult>) {
    const db = openDatabase(':memory:');
    const settings = new SettingsStore(db);
    const store = new Store(db);
    const hub = new Hub();
    const providers = new ProviderService(settings);
    const orchestrator = new Orchestrator(store, hub, settings);
    const invalidate = vi.spyOn(providers, 'invalidate');
    const { host } = fakeHost(freshDir(), { onRun });
    const clis = new CliInstaller(settings, { changed: (p) => providers.invalidate(p), busy: () => orchestrator.anyRunning() }, host);
    return { a: createApp({ auth: null, store, settings, hub, orchestrator, providers, clis }), clis, settings, invalidate };
  }

  it('lists every CLI, installs one in the background, and removes it', async () => {
    const { a, clis, settings, invalidate } = app();
    const list = await a.request('/api/clis', { headers: HOST });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { provider: string }[]).map((v) => v.provider)).toEqual(PROVIDERS);

    expect((await a.request('/api/clis/codex', json('DELETE'))).status).toBe(404);
    const started = await a.request('/api/clis/codex/install', json('POST'));
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ provider: 'codex', job: { state: 'running' } });
    await ended(clis, 'codex');
    expect(invalidate).toHaveBeenCalledWith('codex');
    expect(settings.bin('codex')).toBe(join(clis.folder('codex'), 'bin', 'codex'));
    expect((await a.request('/api/clis/codex/install', json('POST'))).status).toBe(409);
    // Nothing under way to cancel.
    expect((await a.request('/api/clis/codex/install', json('DELETE'))).status).toBe(409);

    const removed = await a.request('/api/clis/codex', json('DELETE'));
    expect(removed.status).toBe(200);
    expect(await removed.json()).not.toHaveProperty('installed');
    expect(settings.bin('codex')).toBe('codex');
  });

  it('cancels an install under way, and refuses an unknown CLI or a write that is not JSON', async () => {
    const { a, clis } = app(untilStopped);
    expect((await a.request('/api/clis/nope/install', json('POST'))).status).toBe(404);
    expect((await a.request('/api/clis/codex/install', { method: 'POST', headers: HOST })).status).toBe(415);
    clis.install('cline');
    const cancelled = await a.request('/api/clis/cline/install', json('DELETE'));
    expect(cancelled.status).toBe(200);
    expect((await ended(clis, 'cline')).job?.state).toBe('cancelled');
  });
});
