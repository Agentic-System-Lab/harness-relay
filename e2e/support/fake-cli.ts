/**
 * Installs the fake CLIs (`e2e/fake-cli/`) under each CLI's executable name (`claude`, `codex`,
 * `grok`, `cursor-agent`, `agy`, `opencode`, `goose`, `cline`, `openhands`, `pi`) in a folder of their
 * own, which the servers under test find first on their PATH. A CLI whose fake is not written yet
 * (`implemented: false` in `clis/<provider>.ts`) is installed too, and says so when it runs.
 *
 * The fakes are modules (`fake-cli.cjs`, `lib/`, `agents/`), bundled here into one script
 * (`bundleFakeCli()`): a Node single executable's `require` loads built-in modules only, and a
 * script runs from this cache's folder, where the modules beside it are not.
 *
 * On macOS and Linux each is the script itself with a `#!` line for this Node (OpenHands' in a
 * Python virtual environment of its own, as `uv tool install` lays it out: `installOpenhands()`).
 * Harness Relay starts a CLI without a shell, which on Windows runs only real programs (`.exe`),
 * not scripts or `.cmd` shims, so there the fake becomes a Node single executable application: this
 * Node's own `node.exe` with the script injected (`postject`), linked under every name. That takes a
 * few seconds and about 100 MB, so it is kept in `node_modules/.cache/` and made again only when a
 * module or Node changes. `E2E_FAKE_SEA=1` builds the executables on macOS and Linux too, to check
 * them there.
 *
 * On macOS and Linux the fake folder dialog (`e2e/fake-cli/fake-dialog.cjs`) goes with them as
 * `zenity`, a script too: Linux looks for its dialog on the PATH (macOS and Windows open their own by
 * their full paths, so there is nothing to stand in for there).
 *
 * The fake GitHub CLI (`e2e/fake-cli/fake-gh.cjs`), which the server shares conversations through,
 * goes with them as `gh` on every system: a script on macOS and Linux, and on Windows (or with
 * `E2E_FAKE_SEA=1`) the same executable under one more name, as the server starts it without a shell
 * too. The executable runs the fake GitHub CLI when it runs as `gh`, the fake CLIs otherwise: one
 * build instead of two, each of which takes over ten seconds on Windows.
 *
 * For `e2e/specs/windows.spec.ts`, `installFakeLaunchers()` also builds the fakes as some Windows
 * users' CLIs come: Cursor's own launcher (`cursor-agent.cmd`, which starts a Node and a script of its
 * own), and npm's shims (`.cmd`), for a Node script (Cline, Pi) and for a program (OpenCode).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative } from 'node:path';
import { PROVIDERS, type Provider } from '../../src/shared/types';
import { FACTS } from './clis/all';
import { FAKE_CLI_DIR, FAKE_DIALOG_SCRIPT, FAKE_GH_SCRIPT, ROOT } from './paths';

/** The CLIs whose fake is written; the others' fakes say they are not and exit with code 2. */
export const IMPLEMENTED_FAKES: readonly Provider[] = PROVIDERS.filter((p) => FACTS[p].implemented);

/** The CLIs a test server leaves not installed unless a test says otherwise: those whose fake is not written yet. */
export const NOT_YET_FAKED: readonly Provider[] = PROVIDERS.filter((p) => !FACTS[p].implemented);

const sea = process.platform === 'win32' || process.env.E2E_FAKE_SEA === '1';
const exe = process.platform === 'win32' ? '.exe' : '';
/** A build used this recently may still be in use by another run (a module changed meanwhile): it is kept. */
const IN_USE_MS = 60 * 60 * 1000;
/** What the bundle is made of, changed when how it is made changes (its text is in the cache key too). */
const LAYOUT = 'bundle-2';

/** A CLI's fake's file name in the fake folder (`cursor-agent`, `agy.exe`). */
export const fakeBin = (p: Provider): string => FACTS[p].bin + exe;

/**
 * Where OpenHands' fake goes in script mode, as `uv tool install openhands` lays the real one out: its
 * program in a Python virtual environment, with LiteLLM's model list in that environment's
 * site-packages, which is where the server reads OpenHands' models from (`openhandsSitePackages`:
 * the real path of the program on the PATH, two folders up).
 */
const OPENHANDS_VENV = {
  bin: join('openhands-venv', 'bin', 'openhands'),
  models: join('openhands-venv', 'lib', 'python3.12', 'site-packages', 'litellm', 'model_prices_and_context_window_backup.json'),
};

/** The fakes that are standalone scripts of their own, not modules of the fake CLIs. */
const STANDALONE = new Set([basename(FAKE_DIALOG_SCRIPT), basename(FAKE_GH_SCRIPT)]);

/** The fake CLIs' modules: every `.cjs` under e2e/fake-cli/ but the standalone ones, by their path there without `.cjs` (`lib/rpc`). */
function fakeModules(): [id: string, text: string][] {
  const found: [string, string][] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else if (name.endsWith('.cjs') && !(prefix === '' && STANDALONE.has(name))) found.push([prefix + name.slice(0, -'.cjs'.length), readFileSync(path, 'utf8')]);
    }
  };
  walk(FAKE_CLI_DIR, '');
  return found;
}

/**
 * The module loader of the bundle: each module runs once, in a function of its own as Node runs a
 * CommonJS module, with a `require` that finds the others by their paths relative to it
 * (`../lib/rpc.cjs`) and leaves anything else (Node's built-in modules) to the script's own.
 */
const LOADER = String.raw`const __loaded = {};
function __load(id) {
  if (!__loaded[id]) {
    const module = { exports: {} };
    __loaded[id] = module;
    const dir = id.split('/').slice(0, -1);
    __modules[id].call(module.exports, module, module.exports, (request) => __require(request, dir));
  }
  return __loaded[id].exports;
}
function __require(request, dir) {
  if (!request.startsWith('./') && !request.startsWith('../')) return require(request);
  const parts = dir.slice();
  for (const part of request.replace(/\.cjs$/, '').split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const id = parts.join('/');
  if (!Object.prototype.hasOwnProperty.call(__modules, id)) throw new Error('fake-cli: no module ' + request + ' in the bundle');
  return __load(id);
}`;

/** The fake CLIs as one script: their modules and the loader, starting with the entry (`fake-cli.cjs`). */
export function bundleFakeCli(): string {
  return [
    "'use strict';",
    '// The fake CLIs of e2e/fake-cli/, bundled by e2e/support/fake-cli.ts: edit the modules there, not this.',
    'const __modules = {',
    ...fakeModules().map(([id, text]) => `${JSON.stringify(id)}: function (module, exports, require) {\n${text}\n},`),
    '};',
    LOADER,
    "__load('fake-cli');",
    '',
  ].join('\n');
}

/** Builds (or finds) the fake CLIs and returns their folder. */
export async function installFakeClis(): Promise<string> {
  const script = bundleFakeCli();
  const dialogScript = process.platform === 'win32' ? '' : readFileSync(FAKE_DIALOG_SCRIPT, 'utf8');
  const ghScript = readFileSync(FAKE_GH_SCRIPT, 'utf8');
  const key = createHash('sha256')
    .update(LAYOUT)
    .update(PROVIDERS.map((p) => FACTS[p].bin).join(','))
    .update(script)
    .update(dialogScript)
    .update(ghScript)
    .update(process.version)
    .update(process.execPath)
    .update(`${process.platform}-${process.arch}-${sea ? 'sea' : 'script'}`)
    .digest('hex')
    .slice(0, 16);
  const cache = join(ROOT, 'node_modules', '.cache', 'harness-relay-e2e');
  const folder = join(cache, `fake-cli-${key}`);
  const bins = PROVIDERS.map((p) => join(folder, fakeBin(p)));
  const dialog = dialogScript ? join(folder, 'zenity') : undefined;
  const gh = join(folder, `gh${exe}`);
  const litellm = sea ? [] : [join(folder, OPENHANDS_VENV.models)];
  if ([...bins, ...(dialog ? [dialog] : []), gh, ...litellm].every((b) => existsSync(b))) {
    // Marked as in use, so that another run, of a changed module, leaves it to this one.
    const now = new Date();
    utimesSync(folder, now, now);
    return folder;
  }

  // Builds of an earlier module or Node are not needed again (the executables are large), unless
  // another run may still be using one: its servers would then find the real CLIs on the PATH.
  for (const old of existsSync(cache) ? readdirSync(cache) : []) {
    if (!old.startsWith('fake-cli-')) continue;
    const path = join(cache, old);
    if (Date.now() - statSync(path).mtimeMs > IN_USE_MS) rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(folder, { recursive: true });
  if (sea) {
    // Each fake that is written answers `--version` as its module says (a broken module fails here, not in each test).
    const load = createRequire(import.meta.url);
    const checks = IMPLEMENTED_FAKES.map((p): [string, RegExp] => [join(folder, fakeBin(p)), (load(join(FAKE_CLI_DIR, 'agents', `${p}.cjs`)) as { versionRe: RegExp }).versionRe]);
    await buildExecutables(seaEntry(script, ghScript), folder, [...bins, gh], [...checks, [gh, /^gh version/]]);
  } else {
    for (const p of PROVIDERS) {
      if (p === 'openhands') installOpenhands(folder, script);
      else writeScript(join(folder, fakeBin(p)), script);
    }
    writeScript(gh, ghScript);
  }
  if (dialog) writeScript(dialog, dialogScript);
  return folder;
}

/**
 * The single executable's script: the fake GitHub CLI when it runs as `gh`, else the fake CLIs (which
 * tell the CLIs apart by the same name). Each runs in a function of its own, as it would in a module
 * of its own.
 */
function seaEntry(cliScript: string, ghScript: string): string {
  return [
    "'use strict';",
    "if (require('node:path').basename(process.execPath).replace(/\\.exe$/i, '').toLowerCase() === 'gh') {",
    '(function () {',
    ghScript,
    '})();',
    '} else {',
    '(function () {',
    cliScript,
    '})();',
    '}',
    '',
  ].join('\n');
}

/**
 * OpenHands' fake as a `uv tool install` (`OPENHANDS_VENV`): the script in its virtual environment,
 * its name in `folder` a link to it, and LiteLLM's model list beside it (its module's
 * `litellmModels`). Not for a single executable, which has no `#!` line, and whose hard link has no
 * other real path: there (Windows) the server finds no list, and OpenHands' models are the endpoints'.
 */
function installOpenhands(folder: string, script: string): void {
  const program = join(folder, OPENHANDS_VENV.bin);
  mkdirSync(dirname(program), { recursive: true });
  writeScript(program, script);
  const link = join(folder, fakeBin('openhands'));
  rmSync(link, { force: true });
  symlinkSync(relative(folder, program), link);
  const list = join(folder, OPENHANDS_VENV.models);
  mkdirSync(dirname(list), { recursive: true });
  const { litellmModels } = createRequire(import.meta.url)(join(FAKE_CLI_DIR, 'agents', 'openhands.cjs')) as { litellmModels: Record<string, unknown> };
  writeFileSync(list, JSON.stringify(litellmModels, null, 2));
}

/** `script` as a program of its own at `bin`, run by this Node (macOS and Linux). */
function writeScript(bin: string, script: string): void {
  // An absolute path keeps the scripts off whatever `node` the PATH has; `env` takes over when the
  // path would not fit a `#!` line (spaces, or longer than older kernels read).
  const node = /\s/.test(process.execPath) || process.execPath.length > 120 ? '/usr/bin/env node' : process.execPath;
  writeFileSync(bin, `#!${node}\n${script}`);
  chmodSync(bin, 0o755);
}

/**
 * `script` as a Node single executable at each of `bins`; `checks`: what `--version` prints, run as
 * each of the names given, when it runs.
 */
async function buildExecutables(script: string, dir: string, bins: string[], checks: [bin: string, says: RegExp][]): Promise<void> {
  const main = join(dir, 'fake-cli.cjs');
  const blob = join(dir, 'fake-cli.blob');
  const config = join(dir, 'fake-cli.sea-config.json');
  writeFileSync(main, script);
  writeFileSync(config, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
  run(process.execPath, ['--experimental-sea-config', config]);

  const first = bins[0]!;
  copyFileSync(process.execPath, first);
  chmodSync(first, 0o755);
  // macOS runs no binary whose signature does not match it: take Node's off, sign again ad hoc after.
  if (process.platform === 'darwin') run('codesign', ['--remove-signature', first]);
  const postject = createRequire(import.meta.url)('postject') as {
    inject(file: string, name: string, data: Buffer, o: { sentinelFuse: string; machoSegmentName?: string; overwrite?: boolean }): Promise<void>;
  };
  await postject.inject(first, 'NODE_SEA_BLOB', readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
    overwrite: true,
  });
  if (process.platform === 'darwin') run('codesign', ['--sign', '-', first]);
  // The same program under each name (it tells which CLI it is by the name it runs under).
  for (const bin of bins.slice(1)) {
    try {
      linkSync(first, bin);
    } catch {
      copyFileSync(first, bin);
    }
  }
  for (const [bin, says] of checks) {
    const check = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (check.status !== 0 || !says.test(check.stdout)) {
      throw new Error(`The fake ${basename(bin)} executable does not run: ${check.status} ${check.stdout} ${check.stderr} ${check.error ?? ''}`);
    }
  }
}

/** The launchers of `installFakeLaunchers()`: their folder, and each one's path by the CLI it starts. */
export interface FakeLaunchers {
  dir: string;
  bins: Record<'cursor' | 'cline' | 'pi' | 'opencode', string>;
}

/** Cursor's launcher, as its installer writes it: it says how it was invoked (`%~nx0`), and runs `cursor-agent.ps1`. */
const CURSOR_LAUNCHER =
  '@echo off\r\nset "CURSOR_INVOKED_AS=%~nx0"\r\nset "SCRIPT_DIR=%~dp0"\r\n' +
  '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*\r\n';
/** The version folder of Cursor's (`YYYY.M.D-<commit>`), which holds its Node and its script. */
const CURSOR_VERSION = '2026.11.11-e2e0001';
/** The lines npm's cmd-shim writes before the one that runs the CLI (npm 11). */
const NPM_PREAMBLE = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
/** npm's shim for a program, `rel` from its folder. */
const npmProgramShim = (rel: string) => `${NPM_PREAMBLE}"%dp0%\\${rel}"   %*\r\n`;
/** npm's shim for a Node script, `rel` from its folder: Node beside it, else the PATH's. */
const npmNodeShim = (rel: string) =>
  `${NPM_PREAMBLE}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n` +
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;

/** `from` at `to` too: the same file where it can be (a hard link), else a copy. */
function linkOrCopy(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

/**
 * Writes the launchers into `dir` (the fake CLIs' bundle `script`, a Node at `node` for Cursor's
 * version folder, and the program `program` for OpenCode's shim), each in a folder of its kind, with
 * no `.exe` of a CLI's name beside it (it would be found first):
 * - `cursor\cursor-agent.cmd`, Cursor's launcher, and `cursor\versions\<version>\node.exe` and
 *   `index.js` (the script, which tells it is Cursor from CURSOR_INVOKED_AS);
 * - `npm\cline.cmd` and `npm\pi.cmd`, npm's shims for Node scripts (`node_modules\<cli>\<cli>.cjs`,
 *   run with the PATH's Node);
 * - `npm\opencode.cmd`, npm's shim for a program (`node_modules\opencode-ai\bin\opencode.exe`).
 * Returns each launcher's path.
 */
export function writeFakeLaunchers(dir: string, from: { script: string; node: string; program: string }): FakeLaunchers['bins'] {
  const cursor = join(dir, 'cursor');
  const version = join(cursor, 'versions', CURSOR_VERSION);
  mkdirSync(version, { recursive: true });
  writeFileSync(join(cursor, 'cursor-agent.cmd'), CURSOR_LAUNCHER);
  linkOrCopy(from.node, join(version, 'node.exe'));
  writeFileSync(join(version, 'index.js'), from.script);

  const npm = join(dir, 'npm');
  for (const p of ['cline', 'pi']) {
    mkdirSync(join(npm, 'node_modules', p), { recursive: true });
    writeFileSync(join(npm, 'node_modules', p, `${p}.cjs`), from.script);
    writeFileSync(join(npm, `${p}.cmd`), npmNodeShim(['node_modules', p, `${p}.cjs`].join('\\')));
  }
  const program = ['node_modules', 'opencode-ai', 'bin', 'opencode.exe'];
  mkdirSync(join(npm, ...program.slice(0, -1)), { recursive: true });
  linkOrCopy(from.program, join(npm, ...program));
  writeFileSync(join(npm, 'opencode.cmd'), npmProgramShim(program.join('\\')));
  return { cursor: join(cursor, 'cursor-agent.cmd'), cline: join(npm, 'cline.cmd'), pi: join(npm, 'pi.cmd'), opencode: join(npm, 'opencode.cmd') };
}

/**
 * Builds (or finds) the launchers of `writeFakeLaunchers()` for the fake CLIs in `fakeBinDir` (OpenCode's
 * program is its executable there), kept in `node_modules/.cache/` like the fakes: Cursor's Node is a
 * copy of this one where it cannot be a link (another drive), about 90 MB. Windows only (the
 * launchers are `.cmd` scripts); a worker that finds another building them takes the one done first.
 */
export function installFakeLaunchers(fakeBinDir: string): FakeLaunchers {
  const script = bundleFakeCli();
  const key = createHash('sha256').update(LAYOUT).update('launchers-1').update(script).update(fakeBinDir).update(process.version).update(process.execPath).digest('hex').slice(0, 16);
  const cache = join(ROOT, 'node_modules', '.cache', 'harness-relay-e2e');
  const dir = join(cache, `fake-launchers-${key}`);
  const done = join(dir, 'done');
  if (!existsSync(done)) {
    for (const old of existsSync(cache) ? readdirSync(cache) : []) {
      const path = join(cache, old);
      if (old.startsWith('fake-launchers-') && path !== dir && Date.now() - statSync(path).mtimeMs > IN_USE_MS) rmSync(path, { recursive: true, force: true });
    }
    // Made aside and moved into place whole: another worker may be making it too.
    const making = `${dir}.${process.pid}-${Date.now().toString(36)}`;
    writeFakeLaunchers(making, { script, node: process.execPath, program: join(fakeBinDir, fakeBin('opencode')) });
    writeFileSync(join(making, 'done'), '');
    try {
      renameSync(making, dir);
    } catch {
      rmSync(making, { recursive: true, force: true });
      if (!existsSync(done)) throw new Error(`Could not put the fake launchers in ${dir}`);
    }
  }
  const now = new Date();
  utimesSync(dir, now, now);
  const at = (...parts: string[]) => join(dir, ...parts);
  return { dir, bins: { cursor: at('cursor', 'cursor-agent.cmd'), cline: at('npm', 'cline.cmd'), pi: at('npm', 'pi.cmd'), opencode: at('npm', 'opencode.cmd') } };
}

function run(bin: string, args: string[]): void {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout || r.error}`);
}
