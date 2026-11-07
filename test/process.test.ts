import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CommandNotFoundError, capture, killAll, runProcess } from '../src/server/process';

const dir = mkdtempSync(join(tmpdir(), 'relay-proc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A CLI that starts a subprocess which ignores SIGTERM, prints its pid, and waits. */
const STUBBORN = `sh -c 'trap "" TERM; echo $$; while :; do sleep 1; done' & wait`;
/** The same, but the subprocess lets go of stdout, so the run ends as soon as the CLI exits. */
const STUBBORN_DETACHED = `sh -c 'trap "" TERM; echo $$; exec >/dev/null 2>&1; while :; do sleep 1; done' & wait`;

async function stopAfterFirstLine(script: string) {
  const abort = new AbortController();
  let pid = 0;
  const res = await runProcess({
    bin: 'sh',
    args: ['-c', script],
    env: process.env,
    signal: abort.signal,
    onLine: (line) => {
      pid = Number(line);
      abort.abort();
    },
  });
  return { res, pid };
}

describe('runProcess', () => {
  it('kills subprocesses that ignore SIGTERM after the CLI itself exited', async () => {
    const { res, pid } = await stopAfterFirstLine(STUBBORN_DETACHED);
    expect(res.aborted).toBe(true);
    expect(alive(pid)).toBe(true); // the CLI is gone, its subprocess still runs…
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 6000, interval: 100 }); // …until SIGKILL
  });

  it('ends a stopped run whose subprocess ignores SIGTERM and holds stdout open', async () => {
    // Before, the run waited for stdout to close, which never happened.
    const { res, pid } = await stopAfterFirstLine(STUBBORN);
    expect(res.aborted).toBe(true);
    expect(alive(pid)).toBe(false);
  }, 8000);

  it('keeps stdout byte for byte', async () => {
    const res = await capture('printf', ['a\\r\\nb\\rc\\244\\244\\n'], process.env);
    expect([...res.stdoutBytes]).toEqual([...Buffer.from('a\r\nb\rc'), 0xa4, 0xa4, 0x0a]);
  });

  it('reports a missing working directory as such, not as a missing command', async () => {
    const err = await runProcess({ bin: 'sh', args: ['-c', 'true'], env: process.env, cwd: join(dir, 'gone') }).catch((e) => e);
    expect(err).not.toBeInstanceOf(CommandNotFoundError);
    expect(String(err.message)).toContain(join(dir, 'gone'));
    const missing = await runProcess({ bin: 'no-such-cli-xyz', args: [], env: process.env }).catch((e) => e);
    expect(missing).toBeInstanceOf(CommandNotFoundError);
  });

  it('resolves a relative executable path against the server directory, wherever the CLI runs', async () => {
    const script = join(dir, 'fake-cli.sh');
    writeFileSync(script, '#!/bin/sh\necho ok\n');
    chmodSync(script, 0o755);
    const res = await capture(`./${relative(process.cwd(), script)}`, [], process.env, { cwd: tmpdir() });
    expect(res.stdout).toBe('ok\n');
  });
});

describe('killAll', () => {
  it('kills every process group on shutdown, including subprocesses that ignore SIGTERM', async () => {
    let pid = 0;
    const run = runProcess({ bin: 'sh', args: ['-c', STUBBORN], env: process.env, onLine: (l) => (pid = Number(l)) });
    await vi.waitFor(() => expect(pid).toBeGreaterThan(0));
    await killAll(500);
    await run;
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000, interval: 50 });
  });

  it('also kills subprocesses of runs stopped just before shutdown, whose CLI already exited', async () => {
    const { res, pid } = await stopAfterFirstLine(STUBBORN_DETACHED);
    expect(res.aborted).toBe(true);
    expect(alive(pid)).toBe(true);
    await killAll(100); // shutdown comes before the stopped run's own SIGKILL
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 1000, interval: 50 });
  });
});
