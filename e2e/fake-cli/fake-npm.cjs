'use strict';
/*
 * A stand-in for npm, which Harness Relay installs some of the CLIs with from Settings
 * (`src/server/cliInstall.ts`), for the end-to-end tests. `e2e/support/fake-cli.ts` installs it as
 * `npm` next to the fake CLIs (a script on macOS and Linux; on Windows their single executable,
 * named `npm`), where the server finds it first on its PATH. It never reaches a registry.
 *
 * It answers what cliInstall.ts asks of npm:
 * - `install --global --prefix <folder> [--cache <cache>] … <package>`: installs the package's CLI as
 *   npm's global layout would (and writes in its cache, as npm keeps what it downloads there), the
 *   fake of that CLI standing in for it: on macOS and Linux a link
 *   `<folder>/bin/<command>` to the fake beside this one; on Windows the fake as
 *   `<folder>\node_modules\<package>\bin\<command>.exe` and npm's shim for it, `<folder>\<command>.cmd`.
 *   It prints a line as npm does, then `added 1 package`.
 * - `--version`.
 * Anything else fails ("not faked").
 *
 * The test steers it with files in `fake-npm/`, next to E2E_FAKE_LOG (the test's own folder):
 * - `hold`: the install waits while it is there (at most a minute), so that a test sees it under way
 *   and can cancel it;
 * - `fail`: the install fails as npm does when the registry has no such package (404), exit 1.
 * Each start goes to E2E_FAKE_LOG with its arguments (`cli: 'npm'`), for the tests to read.
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const LOG = process.env.E2E_FAKE_LOG;
const CONTROL = LOG ? path.join(path.dirname(LOG), 'fake-npm') : undefined;
const win = process.platform === 'win32';

if (LOG) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ cli: 'npm', pid: process.pid, at: Date.now(), args }) + '\n');
  } catch {
    /* the log is a convenience */
  }
}

/** The command each package Harness Relay installs with npm puts on the PATH (`CLI_RECIPES`). */
const COMMANDS = {
  '@anthropic-ai/claude-code': 'claude',
  '@openai/codex': 'codex',
  '@github/copilot': 'copilot',
  'opencode-ai': 'opencode',
  cline: 'cline',
  '@earendil-works/pi-coding-agent': 'pi',
};

/** The lines npm's cmd-shim writes before the one that runs the CLI (npm 11). */
const NPM_PREAMBLE = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const isSea = (() => {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
})();

/** Where the fake CLIs are: beside this one. */
const fakeDir = path.dirname(isSea ? process.execPath : __filename);

/** `from` at `to` too: the same file where it can be (a hard link), else a copy. */
function linkOrCopy(from, to) {
  try {
    fs.linkSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function install() {
  const at = args.indexOf('--prefix');
  const prefix = at >= 0 ? args[at + 1] : undefined;
  if (!args.includes('--global') || !prefix) fail(`fake npm: only a global install into a prefix is faked: ${args.join(' ')}`);
  const spec = args.filter((a, i) => !a.startsWith('-') && i > 0 && !['--prefix', '--cache'].includes(args[i - 1])).pop() || '';
  const cacheAt = args.indexOf('--cache');
  if (cacheAt >= 0) {
    fs.mkdirSync(path.join(args[cacheAt + 1], '_cacache'), { recursive: true });
    fs.writeFileSync(path.join(args[cacheAt + 1], '_cacache', 'index'), `${spec}\n`);
  }
  // `cline@3.0.74` → `cline`; `@scope/name@1.0.0` → `@scope/name`.
  const name = spec.replace(/(.)@[^@/]*$/, '$1');
  process.stdout.write(`npm http fetch GET 200 https://registry.npmjs.org/${name} 12ms\n`);
  if (CONTROL) {
    const deadline = Date.now() + 60_000;
    while (fs.existsSync(path.join(CONTROL, 'hold')) && Date.now() < deadline) sleep(100);
    if (fs.existsSync(path.join(CONTROL, 'fail'))) {
      fail(`npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/${name} - Not found\nnpm error 404  '${spec}' is not in this registry.`);
    }
  }
  const command = COMMANDS[name];
  if (!command) fail(`fake npm: no fake CLI for ${spec}`);
  const fake = path.join(fakeDir, command + (win ? '.exe' : ''));
  if (!fs.existsSync(fake)) fail(`fake npm: the fake ${command} is not at ${fake}`);
  if (win) {
    const pkgBin = path.join(prefix, 'node_modules', ...name.split('/'), 'bin');
    fs.mkdirSync(pkgBin, { recursive: true });
    linkOrCopy(fake, path.join(pkgBin, `${command}.exe`));
    const rel = ['node_modules', ...name.split('/'), 'bin', `${command}.exe`].join('\\');
    fs.writeFileSync(path.join(prefix, `${command}.cmd`), `${NPM_PREAMBLE}"%dp0%\\${rel}"   %*\r\n`);
  } else {
    const pkg = path.join(prefix, 'lib', 'node_modules', ...name.split('/'));
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, bin: { [command]: command } }) + '\n');
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.symlinkSync(fake, path.join(prefix, 'bin', command));
  }
  process.stdout.write('\nadded 1 package in 0s\n');
}

if (args[0] === '--version' || args[0] === '-v') process.stdout.write('10.9.9-e2e\n');
else if (args[0] === 'install') install();
else fail(`fake npm: not faked: ${args.join(' ')}`);
