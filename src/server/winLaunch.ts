/**
 * How a CLI is started on native Windows. Harness Relay starts programs only, never through a shell,
 * and Windows starts only real programs that way (`.exe`, `.com`), not a `.cmd` or `.bat` script. Yet
 * a CLI installed with npm is a `.cmd` on the PATH (npm's cmd-shim), and so is Cursor's: a shell
 * would find those first. So the CLI is looked up as a shell finds it (the PATH in PATHEXT's order),
 * and a script found is read for the program it runs, which is then started directly, with the
 * script's arguments before the CLI's:
 *
 * - npm's cmd-shim (`claude.cmd`, `codex.cmd`, `cline.cmd`, `pi.cmd`…): the program it names
 *   (`"%dp0%\node_modules\…\claude.exe" %*`), or Node with the script it names
 *   (`"%_prog%" "%dp0%\node_modules\…\cli.js" %*`: the `node.exe` beside it, else the first one on the
 *   PATH, else the Node that runs Harness Relay).
 * - Cursor's launcher (`cursor-agent.cmd`, `agent.cmd`): as its `cursor-agent.ps1` does, the newest
 *   version folder's `node.exe` with its `index.js` (`versions\2026.11.11-b912975\…`), with
 *   `CURSOR_INVOKED_AS` set to the script's name. Its first step, promoting an update Cursor staged, is
 *   left to Cursor's next start from a shell.
 *
 * Any other script is not started: it would need a shell, so the run fails saying so.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import { t } from './i18n';

/** What to start: the program, its arguments, and environment it needs besides the CLI's. */
export interface WindowsLaunch {
  file: string;
  args: string[];
  env?: Record<string, string>;
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

/** A CLI found as a script that Harness Relay cannot start (it would need a shell). */
export class WindowsScriptError extends Error {
  constructor(
    public bin: string,
    public script: string,
  ) {
    super(t().windowsScript(bin, script));
  }
}

/** An environment variable whatever its letter case (a copied Windows environment keeps `Path`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * Where `bin` is, as a shell finds it: a path as given (or with one of PATHEXT's extensions, when it
 * has none of them), else the first match on the PATH, each folder tried in PATHEXT's order.
 * `only` keeps the extensions to those (a program, not a script).
 */
export function findWindowsCommand(bin: string, env: NodeJS.ProcessEnv, fs: LaunchFs = realFs, only?: readonly string[]): string | undefined {
  const pathext = (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'));
  const exts = only ? pathext.filter((e) => only.includes(e)) : pathext;
  const candidates = (p: string) => (exts.includes(win32.extname(p).toLowerCase()) ? [p] : exts.map((e) => p + e));
  if (/[\\/]/.test(bin) || win32.isAbsolute(bin)) return candidates(bin).find((p) => fs.isFile(p));
  for (const dir of (envValue(env, 'PATH') ?? '').split(';').filter(Boolean)) {
    const at = candidates(win32.join(dir, bin)).find((p) => fs.isFile(p));
    if (at) return at;
  }
  return undefined;
}

/** The folder a cmd-shim path starts from: `%dp0%` (npm today) or `%~dp0` (older npm). */
const DP0 = String.raw`%(?:dp0%|~dp0)\\?`;
/** `"%_prog%"  "%dp0%\…\cli.js" %*`, or older npm's `"%~dp0\node.exe"  "%~dp0\…" %*` / `node  "%~dp0\…" %*`. */
const NODE_SHIM = new RegExp(String.raw`(?:"%_prog%"|"${DP0}node\.exe"|\bnode)\s+"${DP0}([^"%]+)"\s+%\*`, 'i');
/** `"%dp0%\node_modules\…\claude.exe"   %*`, a line of its own. */
const PROGRAM_SHIM = new RegExp(String.raw`^\s*@?"${DP0}([^"%]+\.(?:exe|com))"\s+%\*\s*$`, 'im');

/**
 * Cursor's version folders: `YYYY.M.D-<commit>`, or `YYYY.M.D-HH-MM-SS-<commit>` with the build time
 * (the names `cursor-agent.ps1` takes).
 */
const CURSOR_VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/;

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
  return dated.length ? at(win32.join(versions, dated[0]!.name)) : undefined;
}

/**
 * What to start for `bin` with `args` on Windows (see the top of this file). A command that is not
 * found is left as it is, so that starting it reports it missing.
 */
export function windowsLaunch(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  fs: LaunchFs = realFs,
  fallbackNode: string = process.execPath,
): WindowsLaunch {
  const found = findWindowsCommand(bin, env, fs);
  if (!found) return { file: bin, args: [...args] };
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args: [...args] };
  const dir = win32.dirname(found);
  const text = fs.read(found) ?? '';
  const script = NODE_SHIM.exec(text);
  if (script) {
    const beside = win32.join(dir, 'node.exe');
    const node = fs.isFile(beside) ? beside : (findWindowsCommand('node', env, fs, ['.exe', '.com']) ?? fallbackNode);
    return { file: node, args: [win32.join(dir, script[1]!), ...args] };
  }
  const program = PROGRAM_SHIM.exec(text);
  if (program && fs.isFile(win32.join(dir, program[1]!))) return { file: win32.join(dir, program[1]!), args: [...args] };
  const cursor = cursorLauncher(dir, fs);
  if (cursor) {
    const cache = envValue(env, 'NODE_COMPILE_CACHE') === undefined && envValue(env, 'LOCALAPPDATA');
    return {
      file: cursor.node,
      args: [cursor.index, ...args],
      env: { CURSOR_INVOKED_AS: win32.basename(found), ...(cache ? { NODE_COMPILE_CACHE: win32.join(cache, 'cursor-compile-cache') } : {}) },
    };
  }
  throw new WindowsScriptError(bin, found);
}
