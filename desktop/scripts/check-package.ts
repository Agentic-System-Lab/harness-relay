/**
 * Checks the packaged app electron-builder left in desktop/release/ (the folder next to the installer:
 * mac-universal/, mac-arm64/, win-unpacked/, linux-unpacked/), as the Release workflow does on each
 * system before it publishes the installers, and as anyone can after `npm run desktop:dist`:
 *
 * - its fuses are set as desktop/electron-builder.yml sets them (no running as Node, its code only
 *   from its archive, checked);
 * - the server and the keyring module are in its resources (a universal Mac app holds the module's
 *   native part for both processors), and so are Harness Relay's own sandbox host, Pi's gate extension
 *   and the sandbox runtime (on Linux, with its seccomp helper executable);
 * - the repository's LICENSE is in its resources and in its archive (beside the package.json whose
 *   `license` names it), the same file;
 * - no file the server runs holds a GitHub token (`github_pat_`): the token an app may be built with to
 *   download its updates (RELAY_UPDATES_TOKEN) goes into the app's own main process alone;
 * - the app passes its own check (`--smoke-test`, desktop/src/main.ts): in Electron as it ships, the
 *   server starts in a utility process, a team of claude, codex and grok answers a question (the fake
 *   CLIs of the end-to-end tests, e2e/fake-cli/, built here and given to it with `--smoke-test-clis`),
 *   it signs a sandboxed window in, and stops.
 *
 * On Linux, the app needs a display: run this under xvfb-run (the Release workflow does), and the
 * app runs with --no-sandbox (a CI machine's chrome-sandbox is not set up as an installed one is).
 *
 * Usage: tsx desktop/scripts/check-package.ts [--dir <folder electron-builder wrote to>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '@electron/asar';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { installFakeClis } from '../../e2e/support/fake-cli';
import { withoutOwnSettings } from '../src/selftest';
import { packagedApps } from './packaged';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(DESKTOP, '..');

/** The file `name` in the asar archive at `archive`, or undefined when it is not there. */
function fromArchive(archive: string, name: string): Buffer | undefined {
  try {
    return extractFile(archive, name);
  } catch {
    return undefined;
  }
}

/** A fuse's state in the binary, as @electron/fuses reads it (its FuseState: the characters '0' and '1'). */
const OFF = 48;
const ON = 49;

/** The fuses electron-builder.yml sets, as the binary must have them. */
export const EXPECTED_FUSES: Partial<Record<FuseV1Options, number>> = {
  [FuseV1Options.RunAsNode]: OFF,
  [FuseV1Options.EnableCookieEncryption]: OFF,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: OFF,
  [FuseV1Options.EnableNodeCliInspectArguments]: OFF,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: ON,
  [FuseV1Options.OnlyLoadAppFromAsar]: ON,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: OFF,
};

/** Runs the app's own check, with the fake CLIs in `clis`; resolves with its report and exit code. */
function selfCheck(exe: string, clis: string, timeoutMs = 180_000): Promise<{ code: number | null; report: string }> {
  const work = mkdtempSync(join(tmpdir(), 'relay-check-package-'));
  const report = join(work, 'report.txt');
  const args = [`--smoke-test=${report}`, `--smoke-test-clis=${clis}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
  // The developer's own Harness Relay settings (a data folder, a team size) are not the check's.
  const env = withoutOwnSettings(process.env);
  return new Promise((done) => {
    const child = spawn(exe, args, { env, stdio: ['ignore', 'ignore', 'inherit'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      let text = '';
      try {
        text = readFileSync(report, 'utf8');
      } catch {
        text = '(no report written)';
      }
      rmSync(work, { recursive: true, force: true });
      done({ code, report: text });
    };
    child.on('exit', finish);
    child.on('error', (err) => {
      clearTimeout(timer);
      rmSync(work, { recursive: true, force: true });
      done({ code: null, report: `could not start it: ${err.message}` });
    });
  });
}

async function main(): Promise<number> {
  const at = process.argv.indexOf('--dir');
  const dir = at >= 0 ? resolve(process.argv[at + 1] ?? '') : join(DESKTOP, 'release');
  const apps = existsSync(dir) ? packagedApps(dir) : [];
  if (!apps.length) {
    console.error(`✗ No packaged app in ${dir}: run electron-builder (npm run desktop:dist) first.`);
    return 1;
  }
  const license = readFileSync(join(ROOT, 'LICENSE'));
  const clis = await installFakeClis();
  let failed = false;
  const check = (ok: unknown, what: string) => {
    console.log(`${ok ? '✓' : '✗'} ${what}`);
    if (!ok) failed = true;
  };
  for (const app of apps) {
    console.log(`\n${app.fuses}`);
    const wire = (await getCurrentFuseWire(app.fuses)) as unknown as Record<number, number>;
    for (const [option, state] of Object.entries(EXPECTED_FUSES)) {
      const name = FuseV1Options[Number(option)];
      check(wire[Number(option)] === state, `fuse ${name}: ${state === ON ? 'on' : 'off'}`);
    }
    const server = join(app.resources, 'server');
    check(existsSync(join(server, 'server.mjs')) && existsSync(join(server, 'web', 'index.html')), 'the server and the web app are in its resources');
    const napi = join(server, 'node_modules', '@napi-rs');
    const keyring = existsSync(napi) ? readdirSync(napi) : [];
    check(keyring.includes('keyring') && keyring.some((n) => n.startsWith('keyring-')), `the keyring module is in its resources (${keyring.join(', ') || 'none'})`);
    if (app.universal) {
      check(keyring.includes('keyring-darwin-arm64') && keyring.includes('keyring-darwin-x64'), 'the keyring module has its native part for Apple Silicon and Intel');
    }
    const runtime = join(server, 'node_modules', '@anthropic-ai', 'sandbox-runtime');
    check(
      existsSync(join(server, 'relaySandboxHost.mjs')) && existsSync(join(server, 'piGate.js')) && existsSync(join(runtime, 'package.json')),
      "the relay sandbox's host, Pi's gate and the sandbox runtime are in its resources",
    );
    if (process.platform === 'linux') {
      const seccomp = join(runtime, 'vendor', 'seccomp', process.arch === 'arm64' ? 'arm64' : 'x64', 'apply-seccomp');
      check(existsSync(seccomp) && (statSync(seccomp).mode & 0o111) !== 0, "the sandbox runtime's seccomp helper is executable");
    }
    const shipped = join(app.resources, 'LICENSE');
    check(existsSync(shipped) && readFileSync(shipped).equals(license), "the repository's LICENSE is in its resources");
    check(fromArchive(join(app.resources, 'app.asar'), 'LICENSE')?.equals(license), "the repository's LICENSE is in its archive, beside its package.json");
    // The token for the app's updates, if it was built with one, is its main process's alone (desktop/scripts/build.ts).
    const bundles = ['server.mjs', 'relaySandboxHost.mjs', 'piGate.js'].map((name) => join(server, name)).filter((path) => existsSync(path));
    check(bundles.length === 3 && bundles.every((path) => !readFileSync(path, 'latin1').includes('github_pat_')), 'no file the server runs holds a GitHub token');
    const { code, report } = await selfCheck(app.exe, clis);
    process.stdout.write(report.replace(/^/gm, '  '));
    check(code === 0, `the app checks itself (--smoke-test): exit code ${code}`);
  }
  console.log(failed ? '\nThe packaged app is not as it must be.' : '\nThe packaged app is as it must be.');
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    },
  );
}
