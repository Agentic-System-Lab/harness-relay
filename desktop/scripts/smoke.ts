/**
 * Runs the server the way the desktop app does and checks what the app relies on (CI and the Release
 * workflow run it on the bundled server, `desktop/build/server/server.mjs`, on each system; the tests
 * on `src/server/index.ts`). Plain Node stands in for Electron's utility process (parent-port.mjs):
 *
 * - the server says it listens, on the port it got (PORT=0: any free one), on 127.0.0.1 only;
 * - it serves the built web app;
 * - asked for a sign-in link, it gives one for its own address, and the code in it signs a browser in;
 * - it prints no sign-in code (its output is the app's log, which agents may read);
 * - asked to shut down, it exits with code 0.
 *
 * Usage: tsx desktop/scripts/smoke.ts (after npm --prefix desktop run build)
 */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DesktopToServer, ServerToDesktop } from '../../src/shared/types';

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
  timeoutMs?: number;
}

/** Runs the checks; resolves with what was checked, or rejects with the first failure. */
export async function smoke(o: SmokeOptions): Promise<string[]> {
  const data = mkdtempSync(join(tmpdir(), 'relay-smoke-'));
  const passed: string[] = [];
  let output = '';
  const child: ChildProcess = fork(o.entry, [], {
    execArgv: [...(o.execArgv ?? []), '--import', pathToFileURL(join(DESKTOP, 'scripts/parent-port.mjs')).href],
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', RELAY_DATA_DIR: data, RELAY_KEYRING: 'off', RELAY_WEB_DIR: o.webDir, RELAY_ALLOWED_HOSTS: '', ...o.env },
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
    const listening = await next('listening');
    const base = `http://127.0.0.1:${listening.port}`;
    check(listening.host === '127.0.0.1' && listening.port > 0, `listens on ${base}`);

    const page = await fetch(`${base}/`);
    check(page.ok && (await page.text()).includes('<title>Harness Relay'), 'serves the web app');

    const signedOut = await fetch(`${base}/api/settings`);
    check(signedOut.status === 401, 'refuses the API to a browser that is not signed in');

    send({ type: 'sign-in-link' });
    const { link } = await next('sign-in-link');
    check(link.startsWith(`${base}/#code=`), 'gives a sign-in link for its own address');

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ code: decodeURIComponent(link.slice(`${base}/#code=`.length)) }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    const { key } = (await login.json()) as { key?: string };
    check(login.ok && cookie && key, "signs a browser in with the link's code");
    const settings = await fetch(`${base}/api/settings`, { headers: { Cookie: cookie!, 'x-relay-key': key!, Origin: base } });
    check(settings.ok, 'answers the signed-in browser');

    check(!/Sign this browser in|#code=/.test(output), 'prints no sign-in code');

    send({ type: 'shutdown' });
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000))]);
    check(code === 0, `exits with code 0 when asked to shut down (got ${code})`);
    return passed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(data, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = join(DESKTOP, 'build/server');
  smoke({ entry: join(server, 'server.mjs'), webDir: join(server, 'web') }).then(
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
