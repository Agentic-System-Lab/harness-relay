/**
 * Runs the server the way the desktop app does and checks what the app relies on (CI and the Release
 * workflow run it on the bundled server, `desktop/build/server/server.mjs`, on each system; the tests
 * on `src/server/index.ts`). Plain Node stands in for Electron's utility process (parent-port.mjs):
 *
 * - the keyring module (native code, next to the server, not in the bundle) loads;
 * - the bundle has Harness Relay's own sandbox host and Pi's gate extension next to it, and the host
 *   finds the sandbox runtime there (both run apart from the server, so neither is in the bundle);
 * - the server says it listens, on the port it got (PORT=0: any free one), on 127.0.0.1 only;
 * - it serves the built web app;
 * - asked for a sign-in link, it gives one for its own address, and the code in it signs a browser in;
 * - it prints no sign-in code (its output is the app's log, which agents may read);
 * - given stand-ins for the CLIs (`fakeClis`; the command line always builds them, with
 *   e2e/support/fake-cli.ts), a team of claude, codex and grok answers a question in a read-only chat
 *   (selftest.ts, `checkTurn`);
 * - asked how many conversations have agents at work (an update waits for none), it says none;
 * - asked to shut down, it exits with code 0.
 *
 * The packaged app checks the same in Electron itself: desktop/scripts/check-package.ts.
 *
 * Usage: tsx desktop/scripts/smoke.ts (after npm --prefix desktop run build)
 */
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DesktopToServer, ServerToDesktop } from '../../src/shared/types';
import { installFakeClis } from '../../e2e/support/fake-cli';
import { checkServer, checkTurn, printsNoCode, withFakeClis, withoutOwnSettings } from '../src/selftest';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface SmokeOptions {
  /** The server to run. */
  entry: string;
  /** Node options before the fake parent port (`--import tsx` for the sources). */
  execArgv?: string[];
  /** The built web app. */
  webDir: string;
  /** Extra environment (over the defaults below). */
  env?: NodeJS.ProcessEnv;
  /** The folder of the fake CLIs (e2e/support/fake-cli.ts): a team of them answers a question. */
  fakeClis?: string;
  /** How long to wait for each message from the server. */
  timeoutMs?: number;
  /** How long the team's run may take (`checkTurn`'s own default otherwise). */
  turnTimeoutMs?: number;
}

/** Runs the checks; resolves with what was checked, or rejects with the first failure. */
export async function smoke(o: SmokeOptions): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), 'relay-smoke-'));
  const data = join(root, 'data');
  const passed: string[] = [];
  let output = '';
  // The developer's own Harness Relay settings (a team size, a data folder) are not the check's.
  const base = withoutOwnSettings(process.env);
  const fakes = o.fakeClis ? withFakeClis(base, o.fakeClis, root) : undefined;
  const child: ChildProcess = fork(o.entry, [], {
    execArgv: [...(o.execArgv ?? []), '--import', pathToFileURL(join(DESKTOP, 'scripts/parent-port.mjs')).href],
    env: { ...(fakes?.env ?? base), PORT: '0', HOST: '127.0.0.1', RELAY_DATA_DIR: data, RELAY_KEYRING: 'off', RELAY_WEB_DIR: o.webDir, RELAY_ALLOWED_HOSTS: '', ...o.env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout!.on('data', (b: Buffer) => (output += b.toString()));
  child.stderr!.on('data', (b: Buffer) => (output += b.toString()));
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  const next = <T extends ServerToDesktop['type']>(type: T) =>
    new Promise<Extract<ServerToDesktop, { type: T }>>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no "${type}" message from the server in time.\n${output}`)), o.timeoutMs ?? 60_000);
      const listener = (m: ServerToDesktop) => {
        if (m?.type !== type) return;
        clearTimeout(timer);
        child.off('message', listener);
        done(m as Extract<ServerToDesktop, { type: T }>);
      };
      child.on('message', listener);
      void exited.then((code) => fail(new Error(`the server exited (code ${code}) before its "${type}" message.\n${output}`)));
    });
  const send = (m: DesktopToServer) => child.send(m);
  const check = (ok: unknown, what: string) => {
    if (!ok) throw new Error(`${what}\n--- server output ---\n${output}`);
    passed.push(what);
  };

  try {
    // The server's own require (createRequire), from where it is: the module must be next to it.
    const keyring = createRequire(o.entry)('@napi-rs/keyring') as { Entry?: unknown };
    check(typeof keyring.Entry === 'function', 'loads the keyring module');
    if (o.entry.endsWith('.mjs')) {
      // The relay sandbox's host is a Node program of its own (relaySandbox.ts runs it), and Pi loads
      // its gate by path: files beside the bundle, the host requiring the sandbox runtime from there.
      const host = join(dirname(o.entry), 'relaySandboxHost.mjs');
      check(existsSync(host) && existsSync(join(dirname(o.entry), 'piGate.js')), "has the relay sandbox's host and Pi's gate next to it");
      check(resolves(host, '@anthropic-ai/sandbox-runtime'), "the relay sandbox's host finds the sandbox runtime");
    }

    const listening = await next('listening');
    const url = `http://127.0.0.1:${listening.port}`;
    check(listening.host === '127.0.0.1' && listening.port > 0, `listens on ${url}`);

    const auth = await checkServer(
      url,
      async () => {
        send({ type: 'sign-in-link' });
        return (await next('sign-in-link')).link;
      },
      check,
    );
    if (fakes) await checkTurn(url, auth, check, { cwd: fakes.cwd, timeoutMs: o.turnTimeoutMs });

    check(printsNoCode(output), 'prints no sign-in code');

    send({ type: 'busy' });
    check((await next('busy')).conversations === 0, 'says no conversation has agents at work');

    send({ type: 'shutdown' });
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000))]);
    check(code === 0, `exits with code 0 when asked to shut down (got ${code})`);
    return passed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    // Windows may hold a file a moment after its process ended.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

function resolves(from: string, id: string): boolean {
  try {
    return existsSync(createRequire(from).resolve(id));
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = join(DESKTOP, 'build/server');
  installFakeClis()
    .then((fakeClis) => smoke({ entry: join(server, 'server.mjs'), webDir: join(server, 'web'), fakeClis }))
    .then(
      (passed) => {
        for (const p of passed) console.log(`✓ ${p}`);
        console.log('The bundled server works as the desktop app runs it.');
      },
      (err: Error) => {
        console.error(`✗ ${err.message}`);
        process.exit(1);
      },
    );
}
