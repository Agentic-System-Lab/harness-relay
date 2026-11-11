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
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { FAKE_CLI_SCRIPT, FAKE_DIALOG_SCRIPT, ROOT } from './paths';

export const CLIS = ['claude', 'codex', 'grok'] as const;

const sea = process.platform === 'win32' || process.env.E2E_FAKE_SEA === '1';
const exe = process.platform === 'win32' ? '.exe' : '';

/** Builds (or finds) the fake CLIs and returns their folder. */
export async function installFakeClis(): Promise<string> {
  const script = readFileSync(FAKE_CLI_SCRIPT, 'utf8');
  const dialogScript = process.platform === 'win32' ? '' : readFileSync(FAKE_DIALOG_SCRIPT, 'utf8');
  const key = createHash('sha256')
    .update(script)
    .update(dialogScript)
    .update(process.version)
    .update(process.execPath)
    .update(`${process.platform}-${process.arch}-${sea ? 'sea' : 'script'}`)
    .digest('hex')
    .slice(0, 16);
  const cache = join(ROOT, 'node_modules', '.cache', 'harness-relay-e2e');
  const dir = join(cache, `fake-cli-${key}`);
  const bins = CLIS.map((name) => join(dir, name + exe));
  const dialog = dialogScript ? join(dir, 'zenity') : undefined;
  if ([...bins, ...(dialog ? [dialog] : [])].every((b) => existsSync(b))) return dir;

  // Builds of an earlier script or Node are not needed again (the executables are large).
  for (const old of existsSync(cache) ? readdirSync(cache) : []) {
    if (old.startsWith('fake-cli-')) rmSync(join(cache, old), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  if (sea) await buildExecutables(script, dir, bins);
  else for (const bin of bins) writeScript(bin, script);
  if (dialog) writeScript(dialog, dialogScript);
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

async function buildExecutables(script: string, dir: string, bins: string[]): Promise<void> {
  const main = join(dir, 'fake-cli.cjs');
  const blob = join(dir, 'fake-cli.blob');
  const config = join(dir, 'sea-config.json');
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
  if (check.status !== 0 || !/Claude Code/.test(check.stdout)) {
    throw new Error(`The fake claude executable does not run: ${check.status} ${check.stdout} ${check.stderr} ${check.error ?? ''}`);
  }
}

function run(bin: string, args: string[]): void {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout || r.error}`);
}
