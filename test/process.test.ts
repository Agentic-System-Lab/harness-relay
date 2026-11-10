import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CommandNotFoundError, capture, killAll, runProcess, runShellScript, spawnDetached } from '../src/server/process';

const dir = mkdtempSync(join(tmpdir(), 'relay-proc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HAS_PROC = existsSync('/proc/self/stat');

/**
 * Still running. A zombie counts as dead: a killed subprocess whose CLI already exited is reaped by
 * PID 1, and in some containers PID 1 does that only every second or so, while `kill(pid, 0)` still
 * succeeds on the zombie.
 */
const alive = (pid: number) => {
  if (HAS_PROC) {
    try {
      // The state follows the command name, which is in parentheses and may contain spaces.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A fake CLI: an executable script, run directly like the real CLIs (runProcess never goes through
 * a shell, and the tests do not either).
 */
function cli(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A CLI that starts a subprocess which ignores SIGTERM, prints its pid, and waits. */
const STUBBORN = cli('stubborn', `sh -c 'trap "" TERM; echo $$; while :; do sleep 1; done' & wait`);
/** The same, but the subprocess lets go of stdout, so the run ends as soon as the CLI exits. */
const STUBBORN_DETACHED = cli('stubborn-detached', `sh -c 'trap "" TERM; echo $$; exec >/dev/null 2>&1; while :; do sleep 1; done' & wait`);

async function stopAfterFirstLine(bin: string) {
  const abort = new AbortController();
  let pid = 0;
  const res = await runProcess({
    bin,
    args: [],
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
  }, 8000);

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
    const err = await runProcess({ bin: cli('ok', 'true'), args: [], env: process.env, cwd: join(dir, 'gone') }).catch((e) => e);
    expect(err).not.toBeInstanceOf(CommandNotFoundError);
    expect(String(err.message)).toContain(join(dir, 'gone'));
    const missing = await runProcess({ bin: 'no-such-cli-xyz', args: [], env: process.env }).catch((e) => e);
    expect(missing).toBeInstanceOf(CommandNotFoundError);
  });

  it('resolves a relative executable path against the server directory, wherever the CLI runs', async () => {
    const script = cli('fake-cli.sh', 'echo ok');
    const res = await capture(`./${relative(process.cwd(), script)}`, [], process.env, { cwd: tmpdir() });
    expect(res.stdout).toBe('ok\n');
  });
});

describe('runShellScript', () => {
  it('runs fixed text in the shell, with its flags, and the values it needs from its environment', async () => {
    const value = `a "b" 'c' $(touch nothing) \`x\` ; d`;
    const res = await runShellScript('/bin/sh', ['-e'], 'case $- in *e*) printf "%s|" "$VALUE";; esac', { env: { ...process.env, VALUE: value } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(`${value}|`);
  });

  it('stops a shell that runs too long, and reports a missing shell as a missing command', async () => {
    const started = Date.now();
    const slow = await runShellScript('/bin/sh', [], 'sleep 30', { env: process.env, timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const missing = await runShellScript(join(dir, 'no-such-shell'), [], 'true', { env: process.env }).catch((e) => e);
    expect(missing).toBeInstanceOf(CommandNotFoundError);
  });
});

describe('killAll', () => {
  it('kills every process group on shutdown, including subprocesses that ignore SIGTERM', async () => {
    let pid = 0;
    const run = runProcess({ bin: STUBBORN, args: [], env: process.env, onLine: (l) => (pid = Number(l)) });
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

describe('spawnDetached', () => {
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('starts a program that outlives the call and is left out of killAll', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-detached-'));
    try {
      const marker = join(dir, 'done');
      await spawnDetached('/bin/sh', ['-c', 'sleep 0.3; echo ok > "$1"', 'sh', marker], process.env);
      await killAll(50);
      await new Promise((r) => setTimeout(r, 900));
      expect(readFileSync(marker, 'utf8').trim()).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects for a program that does not exist', async () => {
    await expect(spawnDetached(join(tmpdir(), 'no-such-program-here'), [], process.env)).rejects.toThrow();
  });
});
