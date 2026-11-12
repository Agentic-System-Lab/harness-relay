import { spawn, spawnSync, type ChildProcess, type SpawnOptions as ChildOptions, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';
import { t } from './i18n';
import { windowsLaunch, type WindowsLaunch } from './winLaunch';

/**
 * A private two-way channel a process gets besides its stdio, as its fd 3 (a socket pair the server
 * holds the other end of), and what the server does with its end once the process is spawned. The
 * relay sandbox's host (`relaySandbox.ts`) takes its rules and asks about hosts over it.
 */
export type ControlChannel = (channel: Duplex, child: ChildProcess) => void;

/**
 * Where a `ControlChannel` can also ride along: on the `env` passed to `runProcess`, under this key,
 * which spreading `env` (`{ ...env, X: '1' }`) keeps and `spawn` leaves out (it only takes string
 * keys). So an adapter that passes the env a sandbox command came with passes its channel too.
 */
export const CONTROL_CHANNEL: unique symbol = Symbol.for('harness-relay.controlChannel');

/** The channel a spawn asks for: `channel`, else the one riding on its env. */
function controlChannelOf(o: Pick<SpawnOptions, 'channel' | 'env'>): ControlChannel | undefined {
  if (o.channel) return o.channel;
  const riding = (o.env as Record<PropertyKey, unknown>)[CONTROL_CHANNEL];
  return typeof riding === 'function' ? (riding as ControlChannel) : undefined;
}

export interface SpawnOptions {
  bin: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. When omitted stdin is /dev/null. */
  stdin?: string | Buffer;
  /** Keep stdin open for a two-way protocol; the caller writes and ends it through `onSpawn`. */
  keepStdinOpen?: boolean;
  /** Called once the child is spawned (before any output is read). */
  onSpawn?: (child: ChildProcess) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called for every stdout line (without the trailing newline). */
  onLine?: (line: string) => void;
  /** Max bytes of stdout kept in the result (the oldest output is dropped first, unless `keepStart`). */
  maxCapture?: number;
  /** Keep the first `maxCapture` bytes of stdout instead of the last. */
  keepStart?: boolean;
  /** A control channel for the process, on its fd 3 (see `ControlChannel`; also taken from `env`). */
  channel?: ControlChannel;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** stdout decoded as UTF-8. */
  stdout: string;
  /** stdout exactly as the process wrote it (for patches and other binary-safe output). */
  stdoutBytes: Buffer;
  /** More than `maxCapture` bytes of stdout were written, so some were dropped. */
  stdoutTruncated: boolean;
  /** How many bytes of stdout were written in total. */
  stdoutSize: number;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
}

const MAX_CAPTURE = 64 * 1024;
/** How long a stopped process group gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 3000;
const live = new Set<ChildProcess>();
/** Stopped process groups still waiting for their SIGKILL (the CLI may be gone, subprocesses not). */
const stopping = new Set<ChildProcess>();

/** Bytes kept from a stream: the latest `max` bytes, or the first ones with `keepStart`. */
class Capture {
  private chunks: Buffer[] = [];
  private size = 0;
  total = 0;
  truncated = false;
  constructor(
    private max = MAX_CAPTURE,
    private keepStart = false,
  ) {}

  add(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.keepStart) {
      const room = this.max - this.size;
      if (chunk.length > room) this.truncated = true;
      if (room > 0) {
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        this.chunks.push(kept);
        this.size += kept.length;
      }
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max) {
      this.truncated = true;
      const first = this.chunks[0]!;
      const excess = this.size - this.max;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Signal the whole process group so tool subprocesses (shells, test runners…) get it too. The group
 * is signalled even after the CLI itself exited: its subprocesses may still be running.
 */
export function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return; // the group is gone
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

export class CommandNotFoundError extends Error {
  constructor(public bin: string) {
    super(t().commandNotFound(bin));
  }
}

/** A relative executable path (`./bin/claude`) means the same file wherever the agent runs. */
export function resolveBin(bin: string): string {
  return bin.includes('/') && !isAbsolute(bin) ? resolve(bin) : bin;
}

/**
 * What to start for a CLI: on Windows, the program its `.cmd` runs when the CLI is one (npm's
 * cmd-shim, Cursor's launcher; `winLaunch.ts`), since a script would need a shell; elsewhere the CLI
 * itself. Throws when it is a script whose program cannot be told.
 */
export function launchOf(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): WindowsLaunch {
  const resolved = resolveBin(bin);
  return platform === 'win32' ? windowsLaunch(resolved, args, env) : { file: resolved, args: [...args] };
}

/** The CLI's environment with what its launch needs besides. */
const withLaunchEnv = (env: NodeJS.ProcessEnv, launch: WindowsLaunch): NodeJS.ProcessEnv => (launch.env ? { ...env, ...launch.env } : env);

/** How runProcess and runShellScript run what they start: everything but the program and its arguments. */
export type RunOptions = Omit<SpawnOptions, 'bin' | 'args'>;

/** Spawn a CLI, stream its stdout line by line, and resolve when it exits. It never runs through a shell. */
export function runProcess(o: SpawnOptions): Promise<SpawnResult> {
  let launch: WindowsLaunch;
  try {
    launch = launchOf(o.bin, o.args, o.env);
  } catch (err) {
    return Promise.reject(err);
  }
  // Not found on Windows: started bare, it would be looked for in the working directory (the agent's project) first.
  if (launch.missing) return Promise.reject(new CommandNotFoundError(o.bin));
  return supervise(o.bin, { ...o, env: withLaunchEnv(o.env, launch) }, (options) => spawn(launch.file, launch.args, options));
}

/**
 * Runs `script` in `shell` (`<shell> <flags> -c <script>`), streamed, stopped and killed as runProcess
 * does. The script is fixed text: never build it from a path, a name or a setting. Whatever it needs
 * goes in `o.env`, read as a quoted `"$NAME"`. This is the only way here to run a shell script, so no
 * other program is ever started through one.
 */
export function runShellScript(shell: string, flags: readonly string[], script: string, o: RunOptions): Promise<SpawnResult> {
  return supervise(shell, o, (options) => spawn(shell, [...flags, '-c', script], options));
}

/** Starts the child with `start`, follows it to its end, and stops it when asked; `name` is what a missing command is reported as. */
function supervise(name: string, o: RunOptions, start: (options: ChildOptions) => ChildProcess): Promise<SpawnResult> {
  return new Promise((done, reject) => {
    if (o.signal?.aborted) {
      done({
        code: null,
        signal: null,
        stdout: '',
        stdoutBytes: Buffer.alloc(0),
        stdoutTruncated: false,
        stdoutSize: 0,
        stderr: '',
        aborted: true,
        timedOut: false,
      });
      return;
    }
    // spawn() reports a missing cwd as ENOENT too, which would read as "command not found".
    if (o.cwd && !existsSync(o.cwd)) {
      reject(new Error(t().dirNotFound(o.cwd)));
      return;
    }
    const channel = controlChannelOf(o);
    const child = start({
      cwd: o.cwd,
      env: o.env,
      detached: true,
      // On Windows a detached child would get a console window of its own.
      windowsHide: true,
      stdio: [o.stdin === undefined && !o.keepStdinOpen ? 'ignore' : 'pipe', 'pipe', 'pipe', ...(channel ? ['pipe' as const] : [])],
    });
    live.add(child);
    if (channel) {
      const end = child.stdio[3] as Duplex | null | undefined;
      if (end) {
        end.on('error', () => {
          /* the process may exit while the server still writes */
        });
        try {
          channel(end, child);
        } catch (err) {
          console.error('[process] control channel failed:', err);
        }
      }
    }
    if (o.keepStdinOpen) {
      child.stdin!.on('error', () => {
        /* the CLI may exit while we are still writing */
      });
    }

    const stdout = new Capture(o.maxCapture, o.keepStart);
    const stderr = new Capture();
    let aborted = false;
    let timedOut = false;
    let stopRequested = false;

    const stop = () => {
      if (stopRequested) return;
      stopRequested = true;
      killTree(child, 'SIGTERM');
      // Not cleared when the CLI exits: subprocesses that ignore SIGTERM may outlive it. Shutdown
      // (`killAll`) kills these groups too, since this timer does not keep the server alive.
      stopping.add(child);
      setTimeout(() => {
        stopping.delete(child);
        killTree(child, 'SIGKILL');
      }, KILL_GRACE_MS).unref();
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, o.timeoutMs)
      : undefined;

    // Raw bytes: decoding and re-joining lines would corrupt non-UTF-8 bytes and `\r`.
    child.stdout!.on('data', (chunk: Buffer) => stdout.add(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.add(chunk));
    if (o.onLine) {
      const onLine = o.onLine;
      createInterface({ input: child.stdout!, crlfDelay: Infinity }).on('line', (line) => {
        try {
          onLine(line);
        } catch (err) {
          console.error('[process] line handler failed:', err);
        }
      });
    }

    if (o.stdin !== undefined && !o.keepStdinOpen) {
      child.stdin!.on('error', () => {
        /* the CLI may exit before reading stdin */
      });
      child.stdin!.end(o.stdin);
    }
    o.onSpawn?.(child);

    const cleanup = () => {
      live.delete(child);
      o.signal?.removeEventListener('abort', onAbort);
      if (timeout) clearTimeout(timeout);
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err.code === 'ENOENT' ? new CommandNotFoundError(name) : err);
    });
    child.on('close', (code, signal) => {
      cleanup();
      const bytes = stdout.bytes();
      done({
        code,
        signal,
        stdout: bytes.toString('utf8'),
        stdoutBytes: bytes,
        stdoutTruncated: stdout.truncated,
        stdoutSize: stdout.total,
        stderr: stderr.bytes().toString('utf8'),
        aborted,
        timedOut,
      });
    });
  });
}

/** Run a short command and capture its output (for status checks). */
export async function capture(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { timeoutMs?: number; stdin?: string | Buffer; cwd?: string; maxCapture?: number; keepStart?: boolean } = {},
): Promise<SpawnResult> {
  return runProcess({ ...opts, bin, args, env, timeoutMs: opts.timeoutMs ?? 15000 });
}

/**
 * Runs a CLI that speaks JSON lines on stdin/stdout, for a short exchange: `open` writes the first
 * message, `onMessage` answers and calls `finish` when it has what it needs (which stops the CLI).
 * Resolves on finish, exit or timeout.
 */
export async function converse(o: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  open: (write: (msg: unknown) => void) => void;
  onMessage: (msg: Record<string, any>, write: (msg: unknown) => void, finish: () => void) => void;
}): Promise<{ stderr: string; timedOut: boolean }> {
  const stop = new AbortController();
  let write: (msg: unknown) => void = () => undefined;
  const res = await runProcess({
    bin: o.bin,
    args: o.args,
    cwd: o.cwd,
    env: o.env,
    keepStdinOpen: true,
    signal: stop.signal,
    timeoutMs: o.timeoutMs,
    maxCapture: 1024,
    onSpawn: (child) => {
      write = (msg) => {
        if (child.stdin?.writable) child.stdin.write(JSON.stringify(msg) + '\n');
      };
      o.open(write);
    },
    onLine: (line) => {
      const text = line.trim();
      if (!text.startsWith('{') || stop.signal.aborted) return;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(text) as Record<string, any>;
      } catch {
        return;
      }
      o.onMessage(msg, write, () => stop.abort());
    },
  });
  return { stderr: res.stderr, timedOut: res.timedOut };
}

/** Spawn a long-lived interactive process (used for login flows). */
export function spawnInteractive(bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const launch = launchOf(bin, args, env);
  const child = spawn(launch.file, launch.args, { env: withLaunchEnv(env, launch), detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  live.add(child);
  child.on('close', () => live.delete(child));
  child.on('error', () => live.delete(child));
  return child;
}

/**
 * Starts a program that must outlive this process, and is not waited for (the desktop app's update
 * starts the installer, or waits for the app to exit before opening the new one). It is left out of
 * `killAll`, and its own process group keeps it from the signals sent to this one. `bin` is a full
 * path. Resolves once it started, or rejects when it could not.
 */
export function spawnDetached(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, { env, detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', fail);
    child.once('spawn', () => {
      child.unref();
      done();
    });
  });
}

/**
 * Stop every process this server started (on shutdown): SIGTERM to each process group, then SIGKILL
 * to the groups after a grace period, including subprocesses whose CLI already exited.
 */
export async function killAll(graceMs = KILL_GRACE_MS): Promise<void> {
  const children = [...live];
  for (const child of children) killTree(child, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (live.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  // Including groups stopped earlier whose CLI exited but whose SIGKILL is still pending.
  for (const child of new Set([...children, ...live, ...stopping])) killTree(child, 'SIGKILL');
  stopping.clear();
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;
/**
 * A short program the server waits for, such as a probe (`lsof`, `ps`, `chflags`, `node --version`):
 * started directly, never through a shell, and killed (SIGKILL, so one that ignores SIGTERM cannot hold
 * the server) after `timeoutMs`. It cannot outlive the call, so it needs no tracking for shutdown; it
 * blocks every conversation while it runs, so keep it to quick ones and use `runProcess` for the rest.
 */
export function runSync(
  bin: string,
  args: readonly string[],
  o: { timeoutMs: number; input?: string; maxBuffer?: number; quiet?: boolean },
): SpawnSyncReturns<string> {
  return spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: o.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: o.maxBuffer ?? 1 << 22,
    ...(o.input !== undefined ? { input: o.input } : {}),
    ...(o.quiet ? { stdio: 'ignore' as const } : {}),
    windowsHide: true,
  });
}

/** Waits `ms` without starting a process (between the rounds of a sweep). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export function tail(s: string, n = 600): string {
  const t = stripAnsi(s).trim();
  return t.length > n ? '…' + t.slice(t.length - n) : t;
}
