import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, win32 } from 'node:path';
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
import { capture, runProcess, stripAnsi, tail, type SpawnOptions, type SpawnResult } from './process';
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
 *   user guide's `npm install -g` and the codespace install them): Claude Code, Codex, Copilot,
 *   OpenCode, Cline, Pi;
 * - the maker's own installer script, downloaded with curl and run with bash, with the folder as its
 *   home (HOME and the XDG folders), so that what it writes beside the program (its shell profile
 *   lines, caches) stays there too, and its own variable or flag for where the program goes: Grok,
 *   Cursor, Antigravity, Muse Code, Goose (on macOS and Linux; on Windows they are installed by hand);
 * - uv (`uv tool install`), with its tools, the links to their programs and any Python it downloads
 *   in the folder: OpenHands.
 * The open agents get the versions the user guide says they were checked with; the others their
 * newest, as their makers' installers give them.
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

/** How long an install may take (a slow network, a large download). */
const INSTALL_TIMEOUT_MS = 20 * 60_000;
/** How long the program installed has to answer `--version` (a launcher may fetch its binary first). */
const VERSION_TIMEOUT_MS = 2 * 60_000;
/** How much of an installer's output is kept. */
const MAX_LOG = 32_000;

/** How one CLI is installed. */
export type CliRecipe =
  /** `command`: the program the package links in the prefix's `bin` folder (on Windows, its `.cmd` in the prefix). */
  | { method: 'npm'; package: string; command: string }
  /** `command`: the program `uv tool install` links in its bin folder. */
  | { method: 'uv'; package: string; command: string }
  | {
      method: 'script';
      url: string;
      /** Where the program is once the script ran, in the CLI's folder. */
      bin: readonly string[];
      /** The script's own arguments, given the CLI's folder. */
      args?: (dir: string) => string[];
      /** The script's own variables besides the home's, given the CLI's folder. */
      env?: (dir: string) => Record<string, string>;
    };

/** How each CLI is installed (see the top of this file). */
export const CLI_RECIPES: Record<Provider, CliRecipe> = {
  claude: { method: 'npm', package: '@anthropic-ai/claude-code', command: 'claude' },
  codex: { method: 'npm', package: '@openai/codex', command: 'codex' },
  // The installer puts the program in ~/.grok/downloads and links it from GROK_BIN_DIR.
  grok: { method: 'script', url: 'https://x.ai/cli/install.sh', bin: ['bin', 'grok'], env: (dir) => ({ GROK_BIN_DIR: join(dir, 'bin') }) },
  // No setting of its own: the versions in ~/.local/share/cursor-agent, linked from ~/.local/bin.
  cursor: { method: 'script', url: 'https://cursor.com/install', bin: ['home', '.local', 'bin', 'cursor-agent'] },
  antigravity: { method: 'script', url: 'https://antigravity.google/cli/install.sh', bin: ['bin', 'agy'], args: (dir) => ['--dir', join(dir, 'bin')] },
  copilot: { method: 'npm', package: '@github/copilot', command: 'copilot' },
  // A launcher, which fetches Muse Code's binary beside itself (and keeps it up to date there).
  muse: {
    method: 'script',
    url: 'https://dev.meta.ai/install.sh',
    bin: ['bin', 'muse'],
    env: (dir) => ({ MUSE_INSTALL_DIR: join(dir, 'bin'), MUSE_NO_MODIFY_PATH: '1' }),
  },
  opencode: { method: 'npm', package: 'opencode-ai@1.19.5', command: 'opencode' },
  // Goose's own installer, of the version checked (Homebrew's formula would go outside the folder).
  goose: {
    method: 'script',
    url: 'https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh',
    bin: ['bin', 'goose'],
    env: (dir) => ({ GOOSE_BIN_DIR: join(dir, 'bin'), GOOSE_VERSION: 'v1.58.1', CONFIGURE: 'false' }),
  },
  cline: { method: 'npm', package: 'cline@3.0.74', command: 'cline' },
  openhands: { method: 'uv', package: 'openhands==1.16.0', command: 'openhands' },
  pi: { method: 'npm', package: '@earendil-works/pi-coding-agent@1.5.1', command: 'pi' },
};

/** What an install runs, as one would type it. */
export function installCommand(r: CliRecipe): string {
  if (r.method === 'npm') return `npm install -g ${r.package}`;
  if (r.method === 'uv') return `uv tool install ${r.package}`;
  return `curl -fsSL ${r.url} | bash`;
}

/** The program an install puts in the CLI's folder `dir`, on `platform`. */
export function installedProgram(r: CliRecipe, dir: string, platform: NodeJS.Platform): string {
  const win = platform === 'win32';
  // npm's global layout: `<prefix>/bin/<command>`, and on Windows `<prefix>\<command>.cmd`.
  if (r.method === 'npm') return win ? join(dir, `${r.command}.cmd`) : join(dir, 'bin', r.command);
  if (r.method === 'uv') return join(dir, 'bin', r.command + (win ? '.exe' : ''));
  return join(dir, ...r.bin);
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

/** Where uv's own installer puts it, besides the PATH (a server started outside a terminal may not have them). */
const uvDirs = (home: string, platform: NodeJS.Platform) => (platform === 'win32' ? [] : [join(home, '.local', 'bin'), join(home, '.cargo', 'bin')]);

/** Where a system keeps curl and bash, besides the PATH. */
const SYSTEM_DIRS = ['/usr/bin', '/bin'];

/** Variables of the server's environment no installer is given: Claude Code's nesting markers, and npm's own of the run that started the server (`npm start`). */
const NOT_FOR_INSTALLERS = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|AI_AGENT|npm_lifecycle_.*|npm_package_.*|npm_config_(local_prefix|global_prefix|prefix)|INIT_CWD)$/;

/** Variables that would move a maker's installer out of the folder it is given as its home. */
const HOME_MOVERS = ['ZDOTDIR', 'CURSOR_CONFIG_DIR', 'GROK_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'BASH_ENV', 'ENV'];

/** The environment an installer starts from: the server's, without what is not for it. */
export function installerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!NOT_FOR_INSTALLERS.test(k)) out[k] = v;
  out.NO_COLOR = '1';
  return out;
}

/**
 * A maker's installer script's environment: the folder `dir` as its home (`dir/home`, with the XDG
 * folders in it), nothing that would move it elsewhere, and the recipe's own variables.
 */
export function scriptEnv(base: NodeJS.ProcessEnv, dir: string, recipe: Extract<CliRecipe, { method: 'script' }>): NodeJS.ProcessEnv {
  const home = join(dir, 'home');
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of HOME_MOVERS) delete env[k];
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    ...recipe.env?.(dir),
  };
}

/** `uv tool install`'s environment: its tools, their programs' links and any Python it downloads, all in `dir`. */
export function uvEnv(base: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  return {
    ...base,
    UV_TOOL_DIR: join(dir, 'uv', 'tools'),
    UV_TOOL_BIN_DIR: join(dir, 'bin'),
    UV_PYTHON_INSTALL_DIR: join(dir, 'uv', 'python'),
    UV_PYTHON_BIN_DIR: join(dir, 'uv', 'python-bin'),
  };
}

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
class InstallError extends Error {
  constructor(readonly render: () => string) {
    super(render());
  }
}

class InstallJob {
  readonly abort = new AbortController();
  readonly startedAt = Date.now();
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
  /** The server's environment (`installerEnv` takes what an installer is not given out of it). */
  env: NodeJS.ProcessEnv;
  home: string;
  /** Where the CLIs go, each in a folder of its own (`cliFolder()`). */
  dir: string;
  run: (o: SpawnOptions) => Promise<SpawnResult>;
  isFile: (path: string) => boolean;
  /** The version the program installed for `p` says it is (`--version`); throws when it does not run. */
  version: (p: Provider, bin: string) => Promise<string | undefined>;
}

export class CliInstaller {
  private host: CliInstallHost;
  private jobs = new Map<Provider, InstallJob>();

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
      env: process.env,
      home: homedir(),
      dir: cliFolder(),
      run: runProcess,
      isFile: fileExists,
      version: (p, bin) => this.askVersion(p, bin),
      ...host,
    };
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
    return {
      provider: p,
      method: recipe.method,
      command: installCommand(recipe),
      ...(blocked ? { blocked } : {}),
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
    if (recipe.method === 'npm') return npmLaunch(env, platform, isFile) ? undefined : 'npm';
    if (recipe.method === 'uv') return this.uv() ? undefined : 'uv';
    if (platform === 'win32') return 'system';
    if (!findOnPath('curl', env, platform, SYSTEM_DIRS, isFile)) return 'curl';
    if (!findOnPath('bash', env, platform, SYSTEM_DIRS, isFile)) return 'bash';
    return undefined;
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
    if (this.installed(p)) throw new HttpError(409, t().cliAlreadyInstalled(label));
    const blocked = this.blocked(p);
    if (blocked) throw new HttpError(400, t().cliInstallBlocked(label, blocked));
    const job = new InstallJob();
    this.jobs.set(p, job);
    void this.runJob(p, job);
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
    const note = this.note(p);
    if (!note) throw new HttpError(404, t().cliNotInstalledHere(label));
    if (this.hooks.busy?.()) throw new HttpError(409, t().cliRemoveBusy(label));
    const dir = this.folder(p);
    if (this.settings.customBin(p) === note.bin) this.settings.update(p, { bin: note.previousBin });
    this.jobs.delete(p);
    try {
      // Links in it are removed, never followed.
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (err) {
      throw new Error(t().cliRemoveFailed(dir, (err as Error).message));
    } finally {
      this.hooks.changed?.(p);
    }
    return this.view(p);
  }

  /** Stops every install under way (the server is stopping); the next install removes what they left. */
  shutdown(): void {
    for (const job of this.jobs.values()) if (job.state === 'running') job.abort.abort();
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
      await this.runInstaller(p, recipe, dir, job);
      if (job.abort.signal.aborted) throw new Error('aborted');
      const bin = installedProgram(recipe, dir, this.host.platform);
      if (!this.host.isFile(bin)) throw new InstallError(() => t().cliInstallNoProgram(bin));
      job.append(`\n$ ${bin} --version\n`);
      let version: string | undefined;
      try {
        version = await this.host.version(p, bin);
      } catch (err) {
        const detail = (err as Error).message;
        throw new InstallError(() => t().cliInstallDoesNotRun(detail));
      }
      if (job.abort.signal.aborted) throw new Error('aborted');
      job.append(`${version ?? ''}\n`);
      const note: InstallNote = {
        provider: p,
        method: recipe.method,
        source: recipe.method === 'script' ? recipe.url : recipe.package,
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
      const npm = npmLaunch(this.host.env, this.host.platform, this.host.isFile);
      if (!npm) throw new InstallError(() => t().cliInstallBlocked(label, 'npm'));
      const args = [...npm.args, 'install', '--global', '--prefix', dir, '--no-audit', '--no-fund', '--no-update-notifier', recipe.package];
      await this.step(job, `npm install -g --prefix ${dir} ${recipe.package}`, { bin: npm.bin, args, env: base, cwd: dir });
      return;
    }
    if (recipe.method === 'uv') {
      const uv = this.uv();
      if (!uv) throw new InstallError(() => t().cliInstallBlocked(label, 'uv'));
      await this.step(job, `uv tool install ${recipe.package}`, { bin: uv, args: ['tool', 'install', recipe.package], env: uvEnv(base, dir), cwd: dir });
      return;
    }
    const { env, platform, isFile } = this.host;
    const curl = findOnPath('curl', env, platform, SYSTEM_DIRS, isFile);
    const bash = findOnPath('bash', env, platform, SYSTEM_DIRS, isFile);
    if (!curl || !bash) throw new InstallError(() => t().cliInstallBlocked(label, curl ? 'bash' : 'curl'));
    const script = join(dir, 'install.sh');
    mkdirSync(join(dir, 'home'), { recursive: true });
    // Fetched whole before it runs (a connection cut off halfway would run half a script).
    await this.step(job, `curl -fsSL ${recipe.url}`, { bin: curl, args: ['-fsSL', '--retry', '3', '-o', script, recipe.url], env: base, cwd: dir });
    const args = recipe.args?.(dir) ?? [];
    await this.step(job, ['bash', 'install.sh', ...args].join(' '), { bin: bash, args: [script, ...args], env: scriptEnv(base, dir, recipe), cwd: dir });
    rmSync(script, { force: true });
  }

  /** Runs one command of an install, its output into the job's log; throws when it fails. */
  private async step(job: InstallJob, shown: string, o: Pick<SpawnOptions, 'bin' | 'args' | 'env' | 'cwd'>): Promise<void> {
    job.append(`$ ${shown}\n`);
    const r = await this.host.run({
      ...o,
      signal: job.abort.signal,
      timeoutMs: INSTALL_TIMEOUT_MS,
      onLine: (line) => job.append(`${line}\n`),
      onSpawn: (child) => child.stderr?.on('data', (b: Buffer) => job.append(b.toString('utf8'))),
    });
    if (r.aborted || job.abort.signal.aborted) throw new Error('aborted');
    if (r.timedOut) throw new InstallError(() => t().cliInstallTimedOut(shown));
    if (r.code !== 0) throw new InstallError(() => t().cliInstallFailed(shown, r.code));
  }

  /** `<bin> --version` in the CLI's own environment, as its status asks it. */
  private async askVersion(p: Provider, bin: string): Promise<string | undefined> {
    const env = this.settings.env(p);
    const r = await capture(bin, ['--version'], isOpenProvider(p) ? openHomeEnv(openAgents[p].process, env) : env, { timeoutMs: VERSION_TIMEOUT_MS });
    if (r.code !== 0) throw new Error(tail(stripAnsi(r.stderr || r.stdout), 400) || `exit ${r.code}`);
    return parseVersion(r.stdout || r.stderr);
  }
}
