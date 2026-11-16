import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PROVIDERS, type Provider } from '../src/shared/types';
import { createApp } from '../src/server/app';
import {
  CLI_RECIPES,
  CliInstaller,
  DROP_USER_PATH_SCRIPT,
  INSTALL_NOTE,
  UV_INSTALLERS,
  cleanLog,
  dropLinksInto,
  gitBash,
  installCommand,
  installedProgram,
  installerEnv,
  linkFolders,
  npmLaunch,
  scriptEnv,
  scriptFor,
  uvEnv,
  windowsPowerShell,
  type CliInstallHost,
  type CliRecipe,
} from '../src/server/cliInstall';
import { openDatabase } from '../src/server/db';
import { HttpError } from '../src/server/errors';
import { Hub } from '../src/server/hub';
import { withLang } from '../src/server/i18n';
import { Orchestrator } from '../src/server/orchestrator';
import type { SpawnOptions, SpawnResult } from '../src/server/process';
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

/**
 * A computer without network or real installers: each installer run is recorded and, unless `onRun`
 * answers it, puts the program where the real one would (`installedProgram`) and exits 0.
 */
function fakeHost(
  dir: string,
  o: {
    tools?: string[];
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    onRun?: (s: SpawnOptions) => Promise<SpawnResult> | SpawnResult | undefined;
    version?: CliInstallHost['version'];
  } = {},
) {
  const calls: SpawnOptions[] = [];
  const platform = o.platform ?? 'linux';
  const win = platform === 'win32';
  // Windows finds a file whatever the case of its name (PATHEXT gives `.EXE`).
  const tools = new Set((o.tools ?? (win ? WIN_TOOLS : TOOLS)).map((t) => (win ? t.toLowerCase() : t)));
  const userPath = vi.fn(async (_dir: string) => '');
  const host: Partial<CliInstallHost> = {
    platform,
    env: o.env ?? (win ? WIN_ENV : { PATH: '/fake/bin', CLAUDECODE: '1', npm_lifecycle_event: 'start', KEEP: 'me' }),
    home: win ? 'C:\\Users\\me' : '/fake/home',
    dir,
    // The fake PATH's programs, and what the installs wrote (never this computer's own /usr/bin).
    isFile: (p) => tools.has(win ? p.toLowerCase() : p) || (p.startsWith(root) && isRealFile(p)),
    version: o.version ?? (async () => '1.2.3'),
    dropUserPath: userPath,
    run: async (s) => {
      calls.push(s);
      const answer = await o.onRun?.(s);
      if (answer) return answer;
      const p = basename(s.cwd ?? '') as Provider;
      const tool = basename(s.bin.replace(/\\/g, '/')).replace(/\.exe$/i, '');
      if (tool === 'curl') touch(s.args[s.args.indexOf('-o') + 1]!);
      // uv's own installer puts uv where it is told.
      else if (s.env.UV_UNMANAGED_INSTALL) touch(join(s.env.UV_UNMANAGED_INSTALL, win ? 'uv.exe' : 'uv'));
      else touch(installedProgram(CLI_RECIPES[p], s.cwd!, platform));
      s.onLine?.(`${tool} done`);
      return result(0, `${tool} done`);
    },
  };
  return { host, calls, userPath };
}

function installer(o: Parameters<typeof fakeHost>[1] & { busy?: () => boolean } = {}) {
  const dir = freshDir();
  const settings = new SettingsStore(openDatabase(':memory:'));
  const changed = vi.fn();
  const { host, calls, userPath } = fakeHost(dir, o);
  const clis = new CliInstaller(settings, { changed, busy: o.busy }, host);
  return { clis, settings, changed, calls, dir, userPath };
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
    expect(installCommand(CLI_RECIPES.openhands, 'win32', true)).toBe('irm https://astral.sh/uv/install.ps1 | iex; uv tool install openhands==1.16.0');
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

  it('keeps uv’s tools, their links and any Python it downloads in the folder', () => {
    const d = join(root, 'oh');
    expect(uvEnv({ PATH: '/bin' }, d)).toEqual({
      PATH: '/bin',
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
    expect(none.view('codex').blocked).toBe('npm');
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
    expect(win.view('openhands').command).toBe('irm https://astral.sh/uv/install.ps1 | iex; uv tool install openhands==1.16.0');
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
    expect(calls[0]).toMatchObject({ bin: '/fake/bin/npm', cwd: dir, args: ['install', '--global', '--prefix', dir, '--no-audit', '--no-fund', '--no-update-notifier', '@openai/codex'] });
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
    expect(calls[0]!.env).toMatchObject({ UV_TOOL_DIR: join(dir, 'uv', 'tools'), UV_TOOL_BIN_DIR: join(dir, 'bin') });
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

  it('on Windows, runs a maker’s PowerShell installer with the folder as its home, then takes it out of the user’s PATH', async () => {
    const { clis, calls, userPath } = installer({ platform: 'win32' });
    clis.install('cursor');
    const v = await ended(clis, 'cursor');
    const dir = clis.folder('cursor');
    expect(v.job?.state).toBe('success');
    expect(calls.map((c) => c.bin)).toEqual(['C:\\Windows\\System32\\curl.EXE', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
    const file = join(dir, 'install.ps1');
    expect(calls[0]!.args).toEqual(['-fsSL', '--retry', '3', '-o', file, 'https://cursor.com/install?win32=true']);
    expect(calls[1]!.args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]);
    expect(calls[1]!.env).toMatchObject({ USERPROFILE: join(dir, 'home'), LOCALAPPDATA: join(dir, 'home', 'AppData', 'Local'), KEEP: 'me' });
    expect(existsSync(file)).toBe(false);
    expect(userPath).toHaveBeenCalledWith(dir);
    expect(v.installed?.bin).toBe(join(dir, 'home', 'AppData', 'Local', 'cursor-agent', 'cursor-agent.cmd'));
    // And again when it is removed.
    userPath.mockClear();
    await clis.remove('cursor');
    expect(userPath).toHaveBeenCalledWith(dir);
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

  it('takes out of the user’s PATH only what is inside the folder, by a fixed script', () => {
    // The folder goes in the environment, never in the script's text.
    expect(DROP_USER_PATH_SCRIPT).toContain('$env:HARNESS_RELAY_CLI_DIR');
    expect(DROP_USER_PATH_SCRIPT).not.toMatch(/clis/);
    // The value's kind and its %VARIABLES% kept: read without expanding them, written back as it was.
    expect(DROP_USER_PATH_SCRIPT).toContain("'DoNotExpandEnvironmentNames'");
    expect(DROP_USER_PATH_SCRIPT).toContain('$key.SetValue(\'Path\', ($kept -join \';\'), $kind)');
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
    expect(() => withLang('en', () => none.install('codex'))).toThrow(/takes npm/);
    expect(() => none.install('codex')).toThrow(expect.objectContaining({ status: 400 }));
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
