/**
 * How a CLI is started on native Windows. Harness Relay starts programs only, never through a shell,
 * and Windows starts only real programs that way (`.exe`, `.com`), not a `.cmd` or `.bat` script. Yet
 * a CLI installed with npm is a `.cmd` on the PATH (npm's cmd-shim), and so is Cursor's: a shell
 * would find those first. So the CLI is looked up as a shell finds it (the PATH in PATHEXT's order),
 * and a script found is read for the program it runs, which is then started directly, with the
 * script's arguments before the CLI's:
 *
 * - npm's cmd-shim (`claude.cmd`, `codex.cmd`, `cline.cmd`, `pi.cmd`…), only when every line of it is
 *   one npm writes (`npmShimTarget`): the program it names (`"%dp0%\node_modules\…\claude.exe" %*`),
 *   or Node with the script it names (`"%_prog%" "%dp0%\node_modules\…\cli.js" %*`, `_prog` Node: the
 *   `node.exe` beside it, else the first one on the PATH, else the Node that runs Harness Relay, but
 *   not in the desktop app, which is no Node).
 * - Cursor's launcher (`cursor-agent.cmd`, `agent.cmd`): as its `cursor-agent.ps1` does, the newest
 *   whole version folder's `node.exe` with its `index.js` (`versions\2026.11.11-b912975\…`), with
 *   `CURSOR_INVOKED_AS` set to the script's name. Its first step, promoting an update Cursor staged, is
 *   left to Cursor's next start from a shell.
 *
 * Any other script is not started, nor a shim whose program is not there: the run fails saying so.
 * A CLI that is not found at all is reported missing (`missing`), not started bare, which would have
 * Windows look for it in the working directory, the agent's project, first.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import { t } from './i18n';

/** What to start: the program, its arguments, and environment it needs besides the CLI's. */
export interface WindowsLaunch {
  file: string;
  args: string[];
  env?: Record<string, string>;
  /** Not found (Windows only): starting it bare would look in the working directory first. */
  missing?: true;
}

/** What `windowsLaunch` reads of the disk. */
export interface LaunchFs {
  isFile(path: string): boolean;
  isDir(path: string): boolean;
  /** The file's text, or undefined when it cannot be read or is too large to be a launcher. */
  read(path: string): string | undefined;
  list(dir: string): string[];
}

/** No launcher script is this large; a larger file is not read. */
const MAX_SCRIPT = 64 * 1024;

const realFs: LaunchFs = {
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  read: (p) => {
    try {
      return statSync(p).size <= MAX_SCRIPT ? readFileSync(p, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  },
  list: (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
};

/** A CLI found as a script that Harness Relay cannot start (it would need a shell, or what it runs is not there). */
export class WindowsScriptError extends Error {}

/**
 * An environment variable whatever its letter case, as Node passes it to a child on Windows: of keys
 * that differ only in case (a copied environment's `Path` beside a `PATH` set over it), the first in
 * sorted order.
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env)
    .filter((k) => k.toUpperCase() === name)
    .sort()[0];
  return key === undefined ? undefined : env[key];
}

/** What Harness Relay starts (a program) or reads (a script); anything else PATHEXT names is passed over. */
const LAUNCHABLE = ['.com', '.exe', '.bat', '.cmd'];

/**
 * Where `bin` is, as a shell finds it: a path as given (or with one of PATHEXT's extensions, when it
 * has none of them), else the first match on the PATH, each folder tried in PATHEXT's order, only
 * programs and `.cmd`/`.bat` scripts. `only` keeps the extensions to those (a program, not a script).
 */
export function findWindowsCommand(bin: string, env: NodeJS.ProcessEnv, fs: LaunchFs = realFs, only?: readonly string[]): string | undefined {
  const pathext = (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => LAUNCHABLE.includes(e));
  const exts = only ? pathext.filter((e) => only.includes(e)) : pathext;
  const candidates = (p: string) => (exts.includes(win32.extname(p).toLowerCase()) ? [p] : exts.map((e) => p + e));
  if (/[\\/]/.test(bin) || win32.isAbsolute(bin)) return candidates(bin).find((p) => fs.isFile(p));
  for (const dir of (envValue(env, 'PATH') ?? '').split(';').filter(Boolean)) {
    const at = candidates(win32.join(dir, bin)).find((p) => fs.isFile(p));
    if (at) return at;
  }
  return undefined;
}

/**
 * The lines of npm's cmd-shim besides the one that runs the CLI, as npm writes them today
 * (`%dp0%`) and wrote them before (`%~dp0`), trimmed, any letter case. A script with any other line
 * is not taken for a shim: whatever else it does (a variable it sets) would be lost. A shim for
 * another interpreter than Node (`SET "_prog=bun"`) has another line, so it is not one either.
 */
const SHIM_LINES = [
  /^@?echo off$/i,
  /^goto start$/i,
  /^:find_dp0$/i,
  /^set dp0=%~dp0$/i,
  /^exit \/b$/i,
  /^:start$/i,
  /^@?setlocal$/i,
  /^call :find_dp0$/i,
  /^@?if exist "%(?:dp0%|~dp0)\\node\.exe" \($/i,
  /^set "_prog=%dp0%\\node\.exe"$/i,
  /^\) else \($/i,
  /^set "_prog=node"$/i,
  /^@?set pathext=%pathext:;\.js;=;%$/i,
  /^\)$/i,
];
/** The line that runs a Node script: `… & "%_prog%"  "%dp0%\…\cli.js" %*`, or older npm's `"%~dp0\node.exe"  "%~dp0\…" %*` and `node  "%~dp0\…" %*`. */
const NODE_LINES = [
  /^endlocal & goto #_undefined_# 2>nul \|\| title %comspec% & "%_prog%"\s+"%dp0%\\([^"%]+)"\s+%\*$/i,
  /^@?"%~dp0\\node\.exe"\s+"%~dp0\\([^"%]+)"\s+%\*$/i,
  /^@?node\s+"%~dp0\\([^"%]+)"\s+%\*$/i,
];
/** The line that runs a program: `"%dp0%\node_modules\…\claude.exe"   %*`. */
const PROGRAM_LINE = /^@?"%(?:dp0%|~dp0)\\([^"%]+\.(?:exe|com))"\s+%\*$/i;

/** What an npm shim runs (a path relative to its folder), or undefined when the script is not one. */
export function npmShimTarget(text: string): { node?: string; program?: string } | undefined {
  let node: string | undefined;
  let program: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || SHIM_LINES.some((re) => re.test(line))) continue;
    const script = NODE_LINES.map((re) => re.exec(line)?.[1]).find(Boolean);
    if (script && (node === undefined || node === script)) {
      node = script;
      continue;
    }
    const exe = PROGRAM_LINE.exec(line)?.[1];
    if (exe && program === undefined) {
      program = exe;
      continue;
    }
    return undefined;
  }
  if (node !== undefined && program !== undefined) return undefined;
  return node !== undefined ? { node } : program !== undefined ? { program } : undefined;
}

/**
 * Cursor's version folders: `YYYY.M.D-<commit>`, or `YYYY.M.D-HH-MM-SS-<commit>` with the build time
 * (the names `cursor-agent.ps1` takes).
 */
const CURSOR_VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/;

/** Cursor's launchers (`cursor-agent.cmd`, `agent.cmd`): they say how they were invoked, and run `cursor-agent.ps1`. */
const isCursorLauncher = (text: string) => /CURSOR_INVOKED_AS=%~nx0/i.test(text) && /\\cursor-agent\.ps1"/i.test(text);

function cursorLauncher(dir: string, fs: LaunchFs): { node: string; index: string } | undefined {
  const at = (folder: string) => {
    const node = win32.join(folder, 'node.exe');
    const index = win32.join(folder, 'index.js');
    return fs.isFile(node) && fs.isFile(index) ? { node, index } : undefined;
  };
  const here = at(dir);
  if (here) return here;
  const versions = win32.join(dir, 'versions');
  const dated = fs
    .list(versions)
    .flatMap((name) => {
      const m = CURSOR_VERSION.exec(name);
      if (!m || !fs.isDir(win32.join(versions, name))) return [];
      // The date as `cursor-agent.ps1` compares it, then the build time (none: before any).
      const date = Number(m[1] + m[2]!.padStart(2, '0') + m[3]!.padStart(2, '0'));
      return [{ name, date, time: m[4] ? Number(m[4] + m[5] + m[6]) + 1 : 0 }];
    })
    .sort((a, b) => b.date - a.date || b.time - a.time);
  // The newest one that is whole (an update cut short leaves one without its files).
  for (const v of dated) {
    const found = at(win32.join(versions, v.name));
    if (found) return found;
  }
  return undefined;
}

/**
 * Node for a shim's script when none is beside it or on the PATH: the one that runs Harness Relay,
 * but not in the desktop app, where that is the app itself (Electron, its run-as-Node switch off).
 */
const defaultFallbackNode = (): string | null => (process.versions.electron ? null : process.execPath);

/**
 * What to start for `bin` with `args` on Windows (see the top of this file). `missing`: it is not
 * there, and starting it bare would have Windows look for it in the working directory first.
 */
export function windowsLaunch(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  fs: LaunchFs = realFs,
  fallbackNode: string | null = defaultFallbackNode(),
): WindowsLaunch {
  const found = findWindowsCommand(bin, env, fs);
  if (!found) return { file: bin, args: [...args], missing: true };
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args: [...args] };
  const dir = win32.dirname(found);
  const text = fs.read(found) ?? '';
  const shim = npmShimTarget(text);
  if (shim?.node) {
    const script = win32.join(dir, shim.node);
    if (!fs.isFile(script)) throw new WindowsScriptError(t().windowsShimBroken(bin, found, script));
    const beside = win32.join(dir, 'node.exe');
    const node = fs.isFile(beside) ? beside : (findWindowsCommand('node', env, fs, ['.exe', '.com']) ?? fallbackNode);
    if (!node) throw new WindowsScriptError(t().windowsNoNode(bin, found));
    return { file: node, args: [script, ...args] };
  }
  if (shim?.program) {
    const program = win32.join(dir, shim.program);
    if (!fs.isFile(program)) throw new WindowsScriptError(t().windowsShimBroken(bin, found, program));
    return { file: program, args: [...args] };
  }
  const cursor = isCursorLauncher(text) ? cursorLauncher(dir, fs) : undefined;
  if (cursor) {
    const cache = envValue(env, 'NODE_COMPILE_CACHE') === undefined && envValue(env, 'LOCALAPPDATA');
    return {
      file: cursor.node,
      args: [cursor.index, ...args],
      env: { CURSOR_INVOKED_AS: win32.basename(found), ...(cache ? { NODE_COMPILE_CACHE: win32.join(cache, 'cursor-compile-cache') } : {}) },
    };
  }
  throw new WindowsScriptError(t().windowsScript(bin, found));
}
