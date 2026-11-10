/**
 * The environment the desktop app gives the server, and through it the agent CLIs.
 *
 * An app opened from the Finder, the Dock or a desktop launcher does not get the PATH and the other
 * variables the user's shell profile sets, so `claude`, `codex` and `grok` (in ~/.local/bin,
 * /opt/homebrew/bin, an nvm folder…) would not be found. The app asks the user's login shell for its
 * environment instead, the way a terminal would have it. Windows apps get the user's PATH from the
 * system when they start; a restart of the server reads it again (`windowsEnv`).
 */
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { capture } from '../../src/server/process';

/** Marks the start and end of the environment in the shell's output (a profile may print more). */
export const ENV_MARK = '__HARNESS_RELAY_ENV_MARK__';

/** Variables that describe the shell itself, not the user's setup. */
const SHELL_OWN = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);

/** Set for the shell only, so that profiles don't stop to ask (oh-my-zsh's update prompt). */
const FOR_THE_SHELL: Record<string, string> = { DISABLE_AUTO_UPDATE: 'true' };

/** Single-quoted for POSIX shells and fish. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Arguments for the login shell: interactive too (`-i`), since many profiles set PATH in .zshrc or
 * .bashrc only. `env -0` separates the variables with NUL bytes, so values may span lines.
 */
export function shellEnvArgs(): string[] {
  const mark = shellQuote(ENV_MARK);
  return ['-i', '-l', '-c', `printf '%s' ${mark}; /usr/bin/env -0; printf '%s' ${mark}`];
}

/** The variables between the marks, or undefined when the output has none. */
export function parseShellEnv(stdout: string): Record<string, string> | undefined {
  const start = stdout.indexOf(ENV_MARK);
  const end = stdout.lastIndexOf(ENV_MARK);
  if (start < 0 || end <= start) return undefined;
  const env: Record<string, string> = {};
  for (const entry of stdout.slice(start + ENV_MARK.length, end).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env.PATH ? env : undefined;
}

/** The user's login shell. */
export function loginShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (env.SHELL?.trim()) return env.SHELL.trim();
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    /* no passwd entry */
  }
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

/** The login shell's environment, or undefined when it could not be read (then see withCommonPaths). */
export async function loginShellEnv(
  env: NodeJS.ProcessEnv,
  opts: { shell?: string; timeoutMs?: number } = {},
): Promise<Record<string, string> | undefined> {
  try {
    const r = await capture(opts.shell ?? loginShell(env), shellEnvArgs(), { ...env, ...FOR_THE_SHELL }, {
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxCapture: 4 * 1024 * 1024,
      keepStart: true,
    });
    const found = parseShellEnv(r.stdout);
    if (!found) return undefined;
    for (const k of Object.keys(FOR_THE_SHELL)) if (env[k] === undefined) delete found[k];
    return found;
  } catch {
    return undefined; // the shell is missing
  }
}

/** The app's own environment with the login shell's on top. */
export function mergeShellEnv(base: NodeJS.ProcessEnv, shell: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [k, v] of Object.entries(shell)) if (!SHELL_OWN.has(k)) env[k] = v;
  return env;
}

/** Where the agent CLIs and their installers usually put themselves. */
function commonDirs(home: string, platform: NodeJS.Platform): string[] {
  const user = ['.local/bin', '.npm-global/bin', '.bun/bin', '.volta/bin', '.grok/bin'].map((d) => join(home, d));
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', ...user];
  return ['/usr/local/bin', ...user, '/snap/bin'];
}

/** When the shell could not be asked: PATH with the usual install folders that exist added at its end. */
export function withCommonPaths(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): NodeJS.ProcessEnv {
  const sep = platform === 'win32' ? ';' : ':';
  const path = (env.PATH ?? '').split(sep).filter(Boolean);
  for (const dir of commonDirs(home, platform)) if (!path.includes(dir) && exists(dir)) path.push(dir);
  return { ...env, PATH: path.join(sep) };
}

// --- Windows -------------------------------------------------------------------------------

/**
 * Windows gives an app the user's PATH when it starts, but not a change made since (a CLI installed
 * meanwhile). Restart and Start read it again from where Windows keeps it, with PowerShell (as UTF-8:
 * a user name may not be ASCII): the system's and the user's variables, values expanded.
 */
export const WINDOWS_ENV_SCRIPT =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; @{ machine = [Environment]::GetEnvironmentVariables('Machine'); user = [Environment]::GetEnvironmentVariables('User') } | ConvertTo-Json -Compress -Depth 3";

export interface WindowsEnv {
  machine: Record<string, string>;
  user: Record<string, string>;
}

/** PowerShell's answer, or undefined when it is not one. */
export function parseWindowsEnv(stdout: string): WindowsEnv | undefined {
  try {
    const v = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as { machine?: unknown; user?: unknown };
    const vars = (x: unknown) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
        : undefined;
    const machine = vars(v?.machine);
    const user = vars(v?.user);
    return machine && user ? { machine, user } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The app's environment with Windows' current one on top: PATH as Windows makes it for a new program
 * (the system's, then the user's), followed by what the app's own had besides; the user's other
 * variables (an API key set since, say). The system's other variables are left alone: some (USERNAME
 * is SYSTEM there) are only defaults that the user's session replaces.
 */
export function mergeWindowsEnv(base: NodeJS.ProcessEnv, current: WindowsEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // Windows' names ignore case: keep the one the app's environment uses (Path, usually).
  const keyOf = (name: string) => Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
  const pathOf = (vars: Record<string, string | undefined>) => Object.entries(vars).find(([k]) => k.toLowerCase() === 'path')?.[1] ?? '';
  for (const [k, v] of Object.entries(current.user)) if (k.toLowerCase() !== 'path') env[keyOf(k)] = v;
  const seen = new Set<string>();
  const path = [pathOf(current.machine), pathOf(current.user), pathOf(base)]
    .flatMap((p) => p.split(';'))
    .map((p) => p.trim())
    .filter((p) => {
      const key = p.toLowerCase().replace(/[\\/]+$/, '');
      if (!p || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  env[keyOf('Path')] = path.join(';');
  return env;
}

/** Windows' current variables (`WINDOWS_ENV_SCRIPT`), or undefined when PowerShell could not tell. */
export async function windowsEnv(env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<WindowsEnv | undefined> {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  try {
    const r = await capture(`${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ENV_SCRIPT], env, {
      timeoutMs,
      maxCapture: 4 * 1024 * 1024,
      keepStart: true,
    });
    return r.code === 0 ? parseWindowsEnv(r.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** Electron's own variables: an Electron app the agents start (VS Code's `code`) would misbehave. */
function isElectronVar(k: string): boolean {
  return k.startsWith('ELECTRON_');
}

export interface ServerEnvOptions {
  /** The app's environment, with the login shell's merged in. */
  base: NodeJS.ProcessEnv;
  /** Where the app keeps the server's data, unless RELAY_DATA_DIR is set. */
  dataDir: string;
  /** The built web app shipped with the server. */
  webDir: string;
  port: number;
  /** The default working directory, unless RELAY_DEFAULT_CWD is set (the home folder). */
  home: string;
  /** Names the server must answer to besides localhost (this computer's tailnet name). */
  allowedHosts: string[];
  /** The chat window's browser folder (its cookie and key): agents below full access may not read it. */
  browserDir: string;
}

/** Where the app files API keys in the credential store when it keeps its own data folder. */
export const DESKTOP_KEYRING_SERVICE = 'harness-relay-desktop';

/**
 * The server's environment. The app always binds 127.0.0.1 on its own port, whatever PORT and HOST
 * a shell profile exports for other programs; RELAY_DATA_DIR and RELAY_DEFAULT_CWD from the profile
 * are the user's own choice and are kept. Keys follow the data: with the app's own data folder they
 * are filed apart from `npm start`'s (which reads the same credential store), with RELAY_DATA_DIR set
 * (data shared with `npm start`, say) under the usual name.
 */
export function serverEnv(o: ServerEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(o.base)) if (v !== undefined && !isElectronVar(k)) env[k] = v;
  const hosts = [...(o.base.RELAY_ALLOWED_HOSTS ?? '').split(','), ...o.allowedHosts]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const ownData = !o.base.RELAY_DATA_DIR?.trim();
  env.RELAY_DATA_DIR = o.base.RELAY_DATA_DIR?.trim() || o.dataDir;
  if (ownData && !o.base.RELAY_KEYRING_SERVICE?.trim()) env.RELAY_KEYRING_SERVICE = DESKTOP_KEYRING_SERVICE;
  env.RELAY_DEFAULT_CWD = o.base.RELAY_DEFAULT_CWD?.trim() || o.home;
  env.RELAY_WEB_DIR = o.webDir;
  env.RELAY_APP_BROWSER_DIR = o.browserDir;
  env.PORT = String(o.port);
  env.HOST = '127.0.0.1';
  if (hosts.length) env.RELAY_ALLOWED_HOSTS = [...new Set(hosts)].join(',');
  else delete env.RELAY_ALLOWED_HOSTS;
  return env;
}

/** The names in RELAY_ALLOWED_HOSTS. */
export function allowedHostsOf(env: NodeJS.ProcessEnv): string[] {
  return (env.RELAY_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}
