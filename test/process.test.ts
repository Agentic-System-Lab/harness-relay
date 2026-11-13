import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CommandNotFoundError, FrameDecoder, capture, frame, killAll, runProcess, runShellScript, runSync, sleepSync, spawnDetached } from '../src/server/process';

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

/** The fake CLIs are shell scripts, and what these tests stop them with (SIGTERM, process groups) is POSIX's. */
const posixIt = process.platform === 'win32' ? it.skip : it;

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
  posixIt('kills subprocesses that ignore SIGTERM after the CLI itself exited', async () => {
    const { res, pid } = await stopAfterFirstLine(STUBBORN_DETACHED);
    expect(res.aborted).toBe(true);
    expect(alive(pid)).toBe(true); // the CLI is gone, its subprocess still runs…
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 6000, interval: 100 }); // …until SIGKILL
  }, 8000);

  posixIt('ends a stopped run whose subprocess ignores SIGTERM and holds stdout open', async () => {
    // Before, the run waited for stdout to close, which never happened.
    const { res, pid } = await stopAfterFirstLine(STUBBORN);
    expect(res.aborted).toBe(true);
    // The run ends once SIGKILL closed the subprocess's stdout. A killed process closes its files
    // before it becomes a zombie, so on a busy runner it can still be exiting at that moment (seen on
    // CI's Linux runners): it is gone a moment later.
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000, interval: 20 });
  }, 8000);

  it('keeps stdout byte for byte', async () => {
    const bytes = [...Buffer.from('a\r\nb\rc'), 0xa4, 0xa4, 0x0a];
    const res = await capture(process.execPath, ['-e', `process.stdout.write(Buffer.from(${JSON.stringify(bytes)}))`], process.env);
    expect([...res.stdoutBytes]).toEqual(bytes);
  });

  it('reports a missing working directory as such, not as a missing command', async () => {
    const err = await runProcess({ bin: cli('ok', 'true'), args: [], env: process.env, cwd: join(dir, 'gone') }).catch((e) => e);
    expect(err).not.toBeInstanceOf(CommandNotFoundError);
    expect(String(err.message)).toContain(join(dir, 'gone'));
    const missing = await runProcess({ bin: 'no-such-cli-xyz', args: [], env: process.env }).catch((e) => e);
    expect(missing).toBeInstanceOf(CommandNotFoundError);
  });

  it.runIf(process.platform === 'win32')("starts an npm shim's script with Node on Windows, with its arguments as they are, and no shell", async () => {
    // As npm writes a CLI's .cmd (cmd-shim), found on the PATH by its name.
    const npm = join(dir, 'npm');
    mkdirSync(join(npm, 'node_modules', 'fake', 'bin'), { recursive: true });
    writeFileSync(join(npm, 'node_modules', 'fake', 'bin', 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    writeFileSync(
      join(npm, 'fakecli.cmd'),
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\n' +
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake\\bin\\cli.js" %*\r\n',
    );
    const args = ['a b', '"quoted"', 'x&y|z', '%PATH%'];
    const res = await runProcess({ bin: 'fakecli', args, env: { ...process.env, PATH: `${npm};${process.env.PATH ?? ''}` } });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(args);
  });

  posixIt('resolves a relative executable path against the server directory, wherever the CLI runs', async () => {
    const script = cli('fake-cli.sh', 'echo ok');
    const res = await capture(`./${relative(process.cwd(), script)}`, [], process.env, { cwd: tmpdir() });
    expect(res.stdout).toBe('ok\n');
  });
});

describe('runSync', () => {
  it('runs a quick probe directly, with its input, and kills one that outlives its timeout even if it ignores SIGTERM', () => {
    const r = runSync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { timeoutMs: 10_000, input: 'a; $(echo b)' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('a; $(echo b)'); // never through a shell
    const started = Date.now();
    const stuck = runSync(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 500 });
    expect(stuck.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(runSync(join(dir, 'missing'), [], { timeoutMs: 1000 }).error).toBeDefined();
    const waited = Date.now();
    sleepSync(50);
    expect(Date.now() - waited).toBeGreaterThanOrEqual(45);
  });
});

describe('runShellScript', () => {
  posixIt('runs fixed text in the shell, with its flags, and the values it needs from its environment', async () => {
    const value = `a "b" 'c' $(touch nothing) \`x\` ; d`;
    const res = await runShellScript('/bin/sh', ['-e'], 'case $- in *e*) printf "%s|" "$VALUE";; esac', { env: { ...process.env, VALUE: value } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(`${value}|`);
  });

  posixIt('stops a shell that runs too long, and reports a missing shell as a missing command', async () => {
    const started = Date.now();
    const slow = await runShellScript('/bin/sh', [], 'sleep 30', { env: process.env, timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const missing = await runShellScript(join(dir, 'no-such-shell'), [], 'true', { env: process.env }).catch((e) => e);
    expect(missing).toBeInstanceOf(CommandNotFoundError);
  });
});

describe('killAll', () => {
  posixIt('kills every process group on shutdown, including subprocesses that ignore SIGTERM', async () => {
    let pid = 0;
    const run = runProcess({ bin: STUBBORN, args: [], env: process.env, onLine: (l) => (pid = Number(l)) });
    await vi.waitFor(() => expect(pid).toBeGreaterThan(0));
    await killAll(500);
    await run;
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000, interval: 50 });
  });

  posixIt('also kills subprocesses of runs stopped just before shutdown, whose CLI already exited', async () => {
    const { res, pid } = await stopAfterFirstLine(STUBBORN_DETACHED);
    expect(res.aborted).toBe(true);
    expect(alive(pid)).toBe(true);
    await killAll(100); // shutdown comes before the stopped run's own SIGKILL
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 1000, interval: 50 });
  });
});

describe('spawnDetached', () => {
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

describe('JSON-RPC framed as LSP frames it (Copilot\'s headless server)', () => {
  const a = { jsonrpc: '2.0', id: 1, result: { ok: true, note: 'é ✓' } };
  const b = { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Not authenticated' } };

  it('reads back what it frames, a body\'s length counted in bytes (not characters)', () => {
    expect(new FrameDecoder().push(frame(a))).toEqual([a]);
  });

  it('reads frames split anywhere, header and body alike, and frames joined in one chunk', () => {
    const both = Buffer.concat([frame(a), frame(b)]);
    for (let cut = 1; cut < both.length; cut++) {
      const d = new FrameDecoder();
      expect([...d.push(both.subarray(0, cut)), ...d.push(both.subarray(cut))]).toEqual([a, b]);
    }
    const d = new FrameDecoder();
    expect([...both].flatMap((byte) => d.push(Buffer.from([byte])))).toEqual([a, b]);
  });

  it('skips a frame without a length, and drops a body that is not a JSON object', () => {
    const bad = (body: string) => Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    const d = new FrameDecoder();
    expect(d.push(Buffer.concat([Buffer.from('X-Other: 1\r\n\r\n'), bad('null'), bad('[1]'), bad('{oops'), frame(b)]))).toEqual([b]);
  });
});
