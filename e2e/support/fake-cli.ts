/**
 * Installs the fake CLIs (`e2e/fake-cli/fake-cli.cjs`) as `claude`, `codex` and `grok` in a folder of
 * their own, which the servers under test find first on their PATH.
 *
 * On macOS and Linux each is the script itself with a `#!` line for this Node. Harness Relay starts a
 * CLI without a shell, which on Windows runs only real programs (`.exe`), not scripts or `.cmd`
 * shims, so there the fake becomes a Node single executable application: this Node's own `node.exe`
 * with the script injected (`postject`), copied under the three names. That takes a few seconds and
 * about 100 MB, so it is kept in `node_modules/.cache/` and made again only when the script or
 * Node changes. `E2E_FAKE_SEA=1` builds the executables on macOS and Linux too, to check them there.
 *
 * On macOS and Linux the fake folder dialog (`e2e/fake-cli/fake-dialog.cjs`) goes with them as
 * `zenity`, a script too: Linux looks for its dialog on the PATH (macOS and Windows open their own by
 * their full paths, so there is nothing to stand in for there).
 *
 * The fake GitHub CLI (`e2e/fake-cli/fake-gh.cjs`), which the server shares conversations through,
 * goes with them as `gh` on every system: a script on macOS and Linux, and on Windows (or with
 * `E2E_FAKE_SEA=1`) a single executable of its own, as the server starts it without a shell too.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { FAKE_CLI_SCRIPT, FAKE_DIALOG_SCRIPT, FAKE_GH_SCRIPT, ROOT } from './paths';

export const CLIS = ['claude', 'codex', 'grok'] as const;

const sea = process.platform === 'win32' || process.env.E2E_FAKE_SEA === '1';
const exe = process.platform === 'win32' ? '.exe' : '';
/** A build used this recently may still be in use by another run (a script changed meanwhile): it is kept. */
const IN_USE_MS = 60 * 60 * 1000;

/** Builds (or finds) the fake CLIs and returns their folder. */
export async function installFakeClis(): Promise<string> {
  const script = readFileSync(FAKE_CLI_SCRIPT, 'utf8');
  const dialogScript = process.platform === 'win32' ? '' : readFileSync(FAKE_DIALOG_SCRIPT, 'utf8');
  const ghScript = readFileSync(FAKE_GH_SCRIPT, 'utf8');
  const key = createHash('sha256')
    .update(script)
    .update(dialogScript)
    .update(ghScript)
    .update(process.version)
    .update(process.execPath)
    .update(`${process.platform}-${process.arch}-${sea ? 'sea' : 'script'}`)
    .digest('hex')
    .slice(0, 16);
  const cache = join(ROOT, 'node_modules', '.cache', 'harness-relay-e2e');
  const dir = join(cache, `fake-cli-${key}`);
  const bins = CLIS.map((name) => join(dir, name + exe));
  const dialog = dialogScript ? join(dir, 'zenity') : undefined;
  const gh = join(dir, `gh${exe}`);
  if ([...bins, ...(dialog ? [dialog] : []), gh].every((b) => existsSync(b))) {
    // Marked as in use, so that another run, of a changed script, leaves it to this one.
    const now = new Date();
    utimesSync(dir, now, now);
    return dir;
  }

  // Builds of an earlier script or Node are not needed again (the executables are large), unless
  // another run may still be using one: its servers would then find the real CLIs on the PATH.
  for (const old of existsSync(cache) ? readdirSync(cache) : []) {
    if (!old.startsWith('fake-cli-')) continue;
    const path = join(cache, old);
    if (Date.now() - statSync(path).mtimeMs > IN_USE_MS) rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  if (sea) await buildExecutables(script, dir, bins);
  else for (const bin of bins) writeScript(bin, script);
  if (dialog) writeScript(dialog, dialogScript);
  if (sea) await buildExecutables(ghScript, dir, [gh], { name: 'fake-gh', says: /^gh version/ });
  else writeScript(gh, ghScript);
  return dir;
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
 * `script` as a Node single executable at each of `bins`. `name`: what its build files are called in
 * `dir`; `says`: what the first one's `--version` prints when it runs.
 */
async function buildExecutables(
  script: string,
  dir: string,
  bins: string[],
  { name = 'fake-cli', says = /Claude Code/ }: { name?: string; says?: RegExp } = {},
): Promise<void> {
  const main = join(dir, `${name}.cjs`);
  const blob = join(dir, `${name}.blob`);
  const config = join(dir, `${name}.sea-config.json`);
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
  const check = spawnSync(first, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (check.status !== 0 || !says.test(check.stdout)) {
    throw new Error(`The fake ${basename(first)} executable does not run: ${check.status} ${check.stdout} ${check.stderr} ${check.error ?? ''}`);
  }
}

function run(bin: string, args: string[]): void {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout || r.error}`);
}
