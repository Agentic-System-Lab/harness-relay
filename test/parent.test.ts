import { fork, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { smoke } from '../desktop/scripts/smoke';
import { desktopParent } from '../src/server/parent';

const dir = mkdtempSync(join(tmpdir(), 'relay-parent-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Electron's process.parentPort, as the server sees it in a utility process. */
function fakePort() {
  const sent: unknown[] = [];
  const listeners: ((e: { data: unknown }) => void)[] = [];
  return {
    sent,
    deliver: (data: unknown) => listeners.forEach((fn) => fn({ data })),
    port: { postMessage: (m: unknown) => sent.push(m), on: (_: 'message', fn: (e: { data: unknown }) => void) => listeners.push(fn) },
  };
}

describe('the desktop app, seen from the server', () => {
  it('is not there when the server was started any other way', () => {
    expect(desktopParent({})).toBeUndefined();
    expect(desktopParent({ parentPort: { nope: true } })).toBeUndefined();
  });

  it('hears that the server listens, and asks it to shut down', () => {
    const fake = fakePort();
    const parent = desktopParent({ parentPort: fake.port })!;
    parent.send({ type: 'listening', host: '127.0.0.1', port: 8787 });
    expect(fake.sent).toEqual([{ type: 'listening', host: '127.0.0.1', port: 8787 }]);
    let shutdowns = 0;
    parent.onShutdown(() => shutdowns++);
    fake.deliver({ type: 'something-else' });
    fake.deliver(undefined);
    expect(shutdowns).toBe(0);
    fake.deliver({ type: 'shutdown' });
    expect(shutdowns).toBe(1);
  });

  it('answers each request for a sign-in link with a new one', () => {
    const fake = fakePort();
    const parent = desktopParent({ parentPort: fake.port })!;
    let n = 0;
    parent.onSignInLink(() => `http://127.0.0.1:8787/#code=CODE${++n}`);
    fake.deliver({ type: 'shutdown' });
    expect(fake.sent).toEqual([]);
    fake.deliver({ type: 'sign-in-link' });
    fake.deliver({ type: 'sign-in-link' });
    expect(fake.sent).toEqual([
      { type: 'sign-in-link', link: 'http://127.0.0.1:8787/#code=CODE1' },
      { type: 'sign-in-link', link: 'http://127.0.0.1:8787/#code=CODE2' },
    ]);
  });

  it('answers each question of how many conversations have agents at work, as it is then', () => {
    const fake = fakePort();
    const parent = desktopParent({ parentPort: fake.port })!;
    let busy = 2;
    parent.onBusy(() => busy);
    fake.deliver({ type: 'sign-in-link' });
    expect(fake.sent).toEqual([]);
    fake.deliver({ type: 'busy' });
    busy = 0;
    fake.deliver({ type: 'busy' });
    expect(fake.sent).toEqual([
      { type: 'busy', conversations: 2 },
      { type: 'busy', conversations: 0 },
    ]);
  });
});

describe('the server, run as the desktop app runs it', () => {
  it('listens, signs a browser in with a link it gives the app, prints no code, and shuts down when asked', async () => {
    // A stand-in for the built UI (npm run build is not run before the tests).
    const web = join(dir, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Harness Relay</title>');
    const passed = await smoke({
      entry: resolve('src/server/index.ts'),
      execArgv: ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href],
      webDir: web,
      timeoutMs: 30_000,
    });
    expect(passed).toEqual([
      'loads the keyring module',
      expect.stringMatching(/^listens on http:\/\/127\.0\.0\.1:\d+$/),
      'serves the web app',
      'refuses the API to a browser that is not signed in',
      'gives a sign-in link for its own address',
      "signs a browser in with the link's code",
      'answers the signed-in browser',
      'prints no sign-in code',
      'says no conversation has agents at work',
      'exits with code 0 when asked to shut down (got 0)',
    ]);
  }, 60_000);
});

describe('a server whose port is taken', () => {
  it('says so and exits with an error, instead of crashing with a stack trace', async () => {
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const port = (taken.address() as { port: number }).port;
    try {
      // HOST as well: a shell may export one, and the server must try the taken address.
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), RELAY_DATA_DIR: join(dir, 'data'), RELAY_KEYRING: 'off', RELAY_WEB_DIR: join(dir, 'no-web') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = new Promise<number | null>((r) => child.on('exit', r));
      try {
        let stderr = '';
        child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
        expect(await exited).toBe(1);
        expect(stderr).toContain(`could not listen on http://127.0.0.1:${port}`);
        expect(stderr).toContain('start with another PORT');
        expect(stderr).not.toContain('Unhandled');
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await exited;
      }
    } finally {
      await new Promise((r) => taken.close(r));
    }
  }, 30_000);

  it('tells the desktop app why (EADDRINUSE), which then explains it, and exits with code 1', async () => {
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const port = (taken.address() as { port: number }).port;
    try {
      const child = fork(resolve('src/server/index.ts'), [], {
        execArgv: ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, '--import', pathToFileURL(resolve('desktop/scripts/parent-port.mjs')).href],
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), RELAY_DATA_DIR: join(dir, 'data-busy'), RELAY_KEYRING: 'off', RELAY_WEB_DIR: join(dir, 'no-web') },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const messages: unknown[] = [];
      child.on('message', (m) => messages.push(m));
      const exited = new Promise<number | null>((r) => child.on('exit', r));
      try {
        expect(await exited).toBe(1);
        expect(messages).toContainEqual(expect.objectContaining({ type: 'error', code: 'EADDRINUSE' }));
        expect(messages.some((m) => (m as { type?: string }).type === 'listening')).toBe(false);
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await exited;
      }
    } finally {
      await new Promise((r) => taken.close(r));
    }
  }, 30_000);
});
